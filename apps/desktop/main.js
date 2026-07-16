const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, nativeTheme, shell, utilityProcess } = require("electron");
const electronLog = require("electron-log/main");
const { autoUpdater } = require("electron-updater");
const { createDesktopUpdater } = require("./app-updater");
const { configureApplicationPaths } = require("./desktop-paths");
const { toNavigationUrl } = require("./navigation-url");
const {
  createPackagedServiceSpecs,
  startPackagedServices,
  stopPackagedServices,
} = require("./packaged-services");
const { allocateServicePorts } = require("./service-ports");

configureApplicationPaths({ app });

let packagedServicePorts = null;

function frontendBaseUrl() {
  if (process.env.SQUADFLOW_DESKTOP_URL) return process.env.SQUADFLOW_DESKTOP_URL;
  if (packagedServicePorts) return `http://127.0.0.1:${packagedServicePorts.renderer}`;
  return "http://localhost:3000";
}

function backendHealthUrl() {
  if (process.env.SQUADFLOW_BACKEND_HEALTH_URL) return process.env.SQUADFLOW_BACKEND_HEALTH_URL;
  if (packagedServicePorts) return `http://127.0.0.1:${packagedServicePorts.backend}/health`;
  return "http://127.0.0.1:8001/health";
}

function frontendReadyUrl() {
  return process.env.SQUADFLOW_FRONTEND_READY_URL || frontendBaseUrl();
}
const configuredBrowserHomeUrl = process.env.SQUADFLOW_BROWSER_HOME_URL || "";
const defaultBrowserHomeUrl = pathToFileURL(path.join(__dirname, "assets", "browser-home.html")).href;
const browserHomeUrl = configuredBrowserHomeUrl || defaultBrowserHomeUrl;
const readinessIntervalMs = 1000;
const readinessTimeoutMs = 1200;
const minimumLoadingMs = 2500;
let serviceStartAttempted = false;
const packagedServiceProcesses = [];
let mainWindow = null;
const desktopBrowsers = new Map();
const CONSOLE_LOG_RING_BUFFER_SIZE = 200;
let currentBrowserLease = null;
const defaultWindowSize = { width: 1440, height: 1000 };
const minimumWindowSize = { width: 1024, height: 720 };
const maximumWindowSize = { width: 3200, height: 2200 };
const serviceLogMaxBytes = 5 * 1024 * 1024;
const desktopLogger = electronLog.create({ logId: "squadflow-desktop" });

function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function normalizeWindowSize(value) {
  const width = Math.round(Number(value?.width));
  const height = Math.round(Number(value?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.min(maximumWindowSize.width, Math.max(minimumWindowSize.width, width)),
    height: Math.min(maximumWindowSize.height, Math.max(minimumWindowSize.height, height)),
  };
}

function readWindowSize() {
  try {
    const raw = fs.readFileSync(windowStatePath(), "utf8");
    return normalizeWindowSize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveWindowSize(win) {
  if (win.isDestroyed()) return;
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  const size = normalizeWindowSize(bounds);
  if (!size) return;
  try {
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(size), "utf8");
  } catch {
    // Window size persistence is best-effort.
  }
}

function attachWindowSizePersistence(win) {
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowSize(win);
    }, 250);
  };
  win.on("resize", scheduleSave);
  win.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowSize(win);
  });
}

function desktopThemeBackground(theme) {
  if (theme === "light") return "#ffffff";
  if (theme === "dark-emerald") return "#102c3d";
  return "#1d1d1f";
}

function desktopThemeSource(theme) {
  return theme === "light" ? "light" : "dark";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestReady(urlString) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: "GET", timeout: readinessTimeoutMs },
      (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 500));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

function desktopLogPath() {
  return path.join(app.getPath("logs"), "desktop.log");
}

desktopLogger.transports.console.level = false;
desktopLogger.transports.file.maxSize = serviceLogMaxBytes;
desktopLogger.transports.file.resolvePathFn = desktopLogPath;
desktopLogger.initialize({ preload: false, spyRendererConsole: false });
desktopLogger.errorHandler.startCatching();

const desktopUpdater = createDesktopUpdater({
  app,
  updater: autoUpdater,
  logger: desktopLogger,
  getWindow: () => mainWindow,
});

ipcMain.handle("desktop-update:get-state", () => desktopUpdater.getState());
ipcMain.handle("desktop-update:check", () => desktopUpdater.checkForUpdates());
ipcMain.handle("desktop-update:install", () => desktopUpdater.install());

async function startLocalServices() {
  if (serviceStartAttempted) return { started: false, repoRoot: null, reason: "already_attempted" };
  serviceStartAttempted = true;

  if (!app.isPackaged) {
    return { started: false, repoRoot: null, reason: "development_services_missing" };
  }

  try {
    const [backend, renderer, nextInternal] = await allocateServicePorts();
    packagedServicePorts = { backend, renderer, nextInternal };
    const userDataPath = app.getPath("userData");
    fs.writeFileSync(
      path.join(userDataPath, "service-ports.json"),
      JSON.stringify(packagedServicePorts),
    );
    const specs = createPackagedServiceSpecs({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath,
      ports: packagedServicePorts,
    });
    packagedServiceProcesses.push(...startPackagedServices({
      utilityProcess,
      specs,
      logger: desktopLogger,
    }));
    return { started: true, repoRoot: null, reason: "" };
  } catch (error) {
    desktopLogger.error("Packaged services failed to start", error);
    return { started: false, repoRoot: null, reason: "packaged_services_failed" };
  }
}

function launchUrl() {
  const url = new URL(frontendBaseUrl());
  if (!url.searchParams.has("view")) url.searchParams.set("view", "new-flow");
  return url.toString();
}

function assetDataUrl(fileName) {
  try {
    const assetPath = path.join(__dirname, "assets", fileName);
    const data = fs.readFileSync(assetPath).toString("base64");
    return `data:image/png;base64,${data}`;
  } catch {
    return "";
  }
}

function loadingPageUrl() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SquadFlow</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111d;
      --line: rgba(148, 163, 184, 0.24);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        radial-gradient(circle at 30% 18%, rgba(125, 211, 252, 0.16), transparent 34%),
        radial-gradient(circle at 73% 66%, rgba(52, 211, 153, 0.15), transparent 32%),
        linear-gradient(135deg, rgba(9, 24, 39, 0.92), rgba(19, 45, 56, 0.98)),
        var(--bg);
    }
    body::before {
      content: "";
      position: fixed;
      inset: -20%;
      background:
        linear-gradient(115deg, transparent 24%, rgba(27, 231, 194, 0.24) 45%, rgba(56, 189, 248, 0.16) 58%, transparent 76%);
      filter: blur(24px);
      opacity: 0.72;
      animation: aurora 7s ease-in-out infinite alternate;
    }
    main {
      position: relative;
      display: grid;
      justify-items: center;
    }
    .icon-shell {
      width: 142px;
      height: 142px;
      padding: 0;
      border-radius: 36px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--line);
      box-shadow: 0 34px 110px rgba(0, 0, 0, 0.42), 0 0 56px rgba(52, 211, 153, 0.14);
      backdrop-filter: blur(18px);
      animation: breathe 2.7s ease-in-out infinite;
      overflow: hidden;
      position: relative;
    }
    .icon-shell::after {
      content: "";
      position: absolute;
      inset: -30%;
      background: linear-gradient(115deg, transparent 32%, rgba(255,255,255,0.24) 48%, transparent 64%);
      transform: translateX(-80%) rotate(8deg);
      animation: iconSweep 2.3s ease-in-out infinite;
      pointer-events: none;
    }
    .app-icon {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    @keyframes aurora {
      0% { transform: translate3d(-3%, 2%, 0) rotate(-4deg); opacity: 0.52; }
      100% { transform: translate3d(4%, -2%, 0) rotate(3deg); opacity: 0.82; }
    }
    @keyframes breathe {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-3px) scale(1.015); }
    }
    @keyframes iconSweep {
      0%, 30% { transform: translateX(-90%) rotate(8deg); opacity: 0; }
      48% { opacity: 0.7; }
      78%, 100% { transform: translateX(90%) rotate(8deg); opacity: 0; }
    }
  </style>
</head>
<body>
  <main>
    <div class="icon-shell" aria-hidden="true">
      <img class="app-icon" src="${assetDataUrl("icon-loading.png")}" alt="">
    </div>
  </main>
  <script>
    window.__setLaunchStatus = function() {};
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function updateLoadingStatus(win, status) {
  if (win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `window.__setLaunchStatus && window.__setLaunchStatus(${JSON.stringify(status)})`,
  ).catch(() => {});
}

async function waitForServicesAndLoad(win) {
  const loadingStartedAt = Date.now();
  let attempt = 0;
  // Packaged services always own their runtime-allocated ports, so start them
  // before probing readiness; probing first could hit a foreign process.
  let launchState = app.isPackaged ? await startLocalServices() : null;
  while (!win.isDestroyed()) {
    attempt += 1;
    const [backendReady, frontendReady] = await Promise.all([
      requestReady(backendHealthUrl()),
      requestReady(frontendReadyUrl()),
    ]);
    if ((!backendReady || !frontendReady) && !launchState) {
      launchState = await startLocalServices();
    }
    updateLoadingStatus(win, {
      attempt,
      backendReady,
      frontendReady,
      message: backendReady && frontendReady
        ? "准备完成，正在进入新建 Flow。"
        : launchState?.started
          ? "正在准备本地工作台，请稍候。"
          : launchState?.reason === "development_services_missing"
            ? "开发服务未运行，请从仓库根目录执行 npm run dev。"
            : launchState?.reason === "packaged_services_failed"
              ? "应用服务文件不完整，请重新安装。"
            : "正在准备本地工作台，请稍候。",
      hint: launchState?.reason === "repo_not_found"
        ? "请从项目目录重新打开 SquadFlow。"
        : undefined,
    });
    if (backendReady && frontendReady) {
      const remainingLoadingMs = Math.max(0, minimumLoadingMs - (Date.now() - loadingStartedAt));
      await sleep(remainingLoadingMs + 220);
      if (!win.isDestroyed()) await win.loadURL(launchUrl());
      return;
    }
    await sleep(readinessIntervalMs);
  }
}

function canGoBack(webContents) {
  return Boolean(webContents.navigationHistory?.canGoBack?.() ?? webContents.canGoBack?.());
}

function canGoForward(webContents) {
  return Boolean(webContents.navigationHistory?.canGoForward?.() ?? webContents.canGoForward?.());
}

function goBack(webContents) {
  if (webContents.navigationHistory?.canGoBack?.()) {
    webContents.navigationHistory.goBack();
  } else if (webContents.canGoBack?.()) {
    webContents.goBack();
  }
}

function goForward(webContents) {
  if (webContents.navigationHistory?.canGoForward?.()) {
    webContents.navigationHistory.goForward();
  } else if (webContents.canGoForward?.()) {
    webContents.goForward();
  }
}

function browserState(ctx) {
  const webContents = ctx.view.webContents;
  const loadedUrl = webContents.getURL() || browserHomeUrl;
  const url = !configuredBrowserHomeUrl && loadedUrl === defaultBrowserHomeUrl ? "about:blank" : loadedUrl;
  return {
    url,
    title: webContents.getTitle() || (url === "about:blank" ? "浏览器" : url),
    canGoBack: canGoBack(webContents),
    canGoForward: canGoForward(webContents),
    isLoading: webContents.isLoading(),
    pickerActive: ctx.pickerActive,
    agentLease: currentBrowserLease,
  };
}

function appendConsoleLog(ctx, level, message) {
  const levelNames = ["verbose", "info", "warning", "error"];
  ctx.consoleLogs.push({
    level: levelNames[level] ?? "info",
    message: String(message ?? "").slice(0, 2000),
    at: new Date().toISOString(),
  });
  if (ctx.consoleLogs.length > CONSOLE_LOG_RING_BUFFER_SIZE) {
    ctx.consoleLogs.splice(0, ctx.consoleLogs.length - CONSOLE_LOG_RING_BUFFER_SIZE);
  }
}

function emitBrowserState(ctx) {
  if (ctx.win.isDestroyed()) return;
  ctx.win.webContents.send("desktop-browser:state", browserState(ctx));
}

function requesterWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function findDesktopBrowserByWebContents(webContents) {
  for (const ctx of desktopBrowsers.values()) {
    if (ctx.view.webContents === webContents) return ctx;
  }
  return null;
}

function clampBounds(input) {
  if (!input || typeof input !== "object") return null;
  const bounds = input;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
}

function setViewVisible(view, visible) {
  if (typeof view.setVisible === "function") {
    view.setVisible(visible);
  } else if (!visible) {
    setViewBounds(view, { x: 0, y: 0, width: 0, height: 0 });
  }
}

function setViewBounds(view, bounds) {
  if (typeof view.setBounds === "function") {
    view.setBounds(bounds);
  }
}

function prepareAgentViewCapture(ctx) {
  const currentBounds = typeof ctx.view.getBounds === "function" ? ctx.view.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  if (ctx.visible && currentBounds.width > 0 && currentBounds.height > 0) {
    return { stayHidden: false, restore: () => {} };
  }
  const winBounds = ctx.win.getContentBounds();
  const captureBounds = {
    x: currentBounds.x,
    y: currentBounds.y,
    width: currentBounds.width > 0 ? currentBounds.width : winBounds.width,
    height: currentBounds.height > 0 ? currentBounds.height : winBounds.height,
  };
  setViewVisible(ctx.view, false);
  setViewBounds(ctx.view, captureBounds);
  return {
    stayHidden: true,
    restore: () => {
      setViewBounds(ctx.view, currentBounds);
      setViewVisible(ctx.view, ctx.visible);
    },
  };
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function confirmedMarkerFromElement(element) {
  if (!element) return null;
  return {
    markerNumber: Math.max(1, Math.round(Number(element.markerNumber) || 1)),
    selector: String(element.selector || "").slice(0, 500),
    rect: {
      x: Number(element.rect?.x) || 0,
      y: Number(element.rect?.y) || 0,
      width: Number(element.rect?.width) || 0,
      height: Number(element.rect?.height) || 0,
    },
  };
}

function sanitizeConfirmedMarkers(markers) {
  if (!Array.isArray(markers)) return [];
  return markers
    .map((entry) => confirmedMarkerFromElement(entry))
    .filter(Boolean)
    .sort((left, right) => left.markerNumber - right.markerNumber)
    .slice(-6);
}

function upsertConfirmedMarker(markers, marker) {
  if (!marker || !marker.selector) return markers;
  return [
    ...markers.filter((entry) => entry.markerNumber !== marker.markerNumber),
    marker,
  ].sort((left, right) => left.markerNumber - right.markerNumber).slice(-6);
}

function elementPickerScript(markerNumber = 1, confirmedMarkers = []) {
  const initialConfirmedMarkers = jsonForScript(Array.isArray(confirmedMarkers) ? confirmedMarkers : []);
  return `(() => {
    const cleanupKey = "__squadflowElementPickerCleanup";
    const clearHoverKey = "__squadflowElementPickerClearHover";
    const confirmedMarkersKey = "__squadflowElementPickerConfirmedMarkers";
    const initialConfirmedMarkers = ${initialConfirmedMarkers};
    if (window[cleanupKey]) window[cleanupKey]();

    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const textFor = (element) => (element.innerText || element.textContent || "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 120);
    const selectorFor = (element) => {
      if (element.id) return "#" + cssEscape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let part = current.localName;
        if (!part) break;
        const className = typeof current.className === "string"
          ? current.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
          : [];
        if (className.length) part += "." + className.map(cssEscape).join(".");
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    };
    const confirmedMarkers = window[confirmedMarkersKey] || (() => {
      const root = document.createElement("div");
      root.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483645",
        "pointer-events:none",
      ].join(";");
      document.documentElement.append(root);
      return { root, entries: [] };
    })();
    window[confirmedMarkersKey] = confirmedMarkers;
    if (Array.isArray(initialConfirmedMarkers)) {
      confirmedMarkers.entries = initialConfirmedMarkers
        .map((entry) => ({
          markerNumber: Math.max(1, Math.round(Number(entry.markerNumber) || 1)),
          selector: String(entry.selector || ""),
          rect: entry.rect,
        }))
        .filter((entry) => entry.selector)
        .sort((left, right) => left.markerNumber - right.markerNumber);
    }
    const rectForMarker = (entry) => {
      try {
        const element = document.querySelector(entry.selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
        }
      } catch {}
      return entry.rect;
    };
    const renderConfirmedMarkers = () => {
      confirmedMarkers.root.replaceChildren();
      for (const entry of confirmedMarkers.entries) {
        const rect = rectForMarker(entry);
        if (!rect) continue;
        const frame = document.createElement("div");
        frame.style.cssText = [
          "position:fixed",
          "left:" + Math.round(rect.left ?? rect.x) + "px",
          "top:" + Math.round(rect.top ?? rect.y) + "px",
          "width:" + Math.max(0, Math.round(rect.width)) + "px",
          "height:" + Math.max(0, Math.round(rect.height)) + "px",
          "border:2px solid #38bdf8",
          "background:rgba(56,189,248,0.12)",
          "border-radius:6px",
          "box-shadow:0 10px 30px rgba(14,165,233,0.22)",
        ].join(";");
        const pin = document.createElement("div");
        pin.textContent = String(entry.markerNumber);
        pin.style.cssText = [
          "position:absolute",
          "left:-11px",
          "top:-11px",
          "width:24px",
          "height:24px",
          "border-radius:999px",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "background:#3b82f6",
          "border:2px solid #dbeafe",
          "box-shadow:0 6px 18px rgba(37,99,235,0.42)",
          "color:white",
          "font:700 12px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        ].join(";");
        frame.append(pin);
        confirmedMarkers.root.append(frame);
      }
    };
    const addConfirmedMarker = (payload) => {
      confirmedMarkers.entries = [
        ...confirmedMarkers.entries.filter((entry) => entry.markerNumber !== payload.markerNumber),
        {
          markerNumber: payload.markerNumber,
          selector: payload.selector,
          rect: payload.rect,
        },
      ].sort((left, right) => left.markerNumber - right.markerNumber);
      renderConfirmedMarkers();
    };
    renderConfirmedMarkers();

    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "pointer-events:none",
      "border:2px solid #38bdf8",
      "background:rgba(56,189,248,0.16)",
      "box-shadow:0 0 0 99999px rgba(2,6,23,0.18),0 14px 40px rgba(8,47,73,0.32)",
      "border-radius:6px",
      "display:none",
    ].join(";");
    const badge = document.createElement("div");
    badge.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "pointer-events:none",
      "max-width:360px",
      "padding:8px 10px",
      "border-radius:10px",
      "background:rgba(10,25,38,0.92)",
      "border:1px solid rgba(125,211,252,0.46)",
      "box-shadow:0 16px 52px rgba(0,0,0,0.38)",
      "color:#f8fafc",
      "font:12px ui-monospace,SFMono-Regular,Menlo,monospace",
      "display:none",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
    ].join(";");
    const marker = document.createElement("div");
    marker.textContent = "${String(markerNumber).replace(/"/g, "")}";
    marker.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "pointer-events:none",
      "width:24px",
      "height:24px",
      "border-radius:999px",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "background:#3b82f6",
      "border:2px solid #dbeafe",
      "box-shadow:0 6px 18px rgba(37,99,235,0.42)",
      "color:white",
      "font:700 12px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    ].join(";");
    document.documentElement.append(overlay, badge, marker);

    let currentElement = null;
    let commentEditor = null;
    let pendingPayload = null;
    const ignored = new Set([overlay, badge]);
    const clearHover = () => {
      overlay.style.display = "none";
      badge.style.display = "none";
      marker.style.display = "none";
      currentElement = null;
    };
    window[clearHoverKey] = clearHover;
    const updateOverlay = (element) => {
      if (
        !element
        || ignored.has(element)
        || (commentEditor && commentEditor.contains(element))
        || element === document.documentElement
        || element === document.body
      ) {
        clearHover();
        return;
      }
      currentElement = element;
      const rect = element.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = Math.max(0, rect.width) + "px";
      overlay.style.height = Math.max(0, rect.height) + "px";
      marker.style.display = "flex";
      marker.style.left = Math.max(8, rect.left - 9) + "px";
      marker.style.top = Math.max(8, rect.top - 9) + "px";
      badge.textContent = "<" + element.localName + "> " + (element.getAttribute("aria-label") || element.getAttribute("title") || textFor(element) || selectorFor(element));
      badge.style.display = "block";
      badge.style.left = Math.min(window.innerWidth - 24, Math.max(8, rect.left)) + "px";
      badge.style.top = Math.max(8, rect.top - 42) + "px";
    };

    const onMouseMove = (event) => {
      if (pendingPayload) return;
      updateOverlay(document.elementFromPoint(event.clientX, event.clientY));
    };
    const onScroll = () => {
      if (currentElement) updateOverlay(currentElement);
      renderConfirmedMarkers();
    };
    const onResize = () => renderConfirmedMarkers();
    const onMouseLeave = () => {
      if (!pendingPayload) clearHover();
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (!pendingPayload) return;
      event.preventDefault();
      event.stopPropagation();
      pendingPayload = null;
      if (commentEditor) commentEditor.remove();
      commentEditor = null;
      clearHover();
    };
    const positionCommentEditor = (rect) => {
      if (!commentEditor) return;
      const width = Math.min(300, Math.max(240, window.innerWidth - 24));
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      const preferredTop = rect.top + rect.height + 8;
      const top = preferredTop + 48 < window.innerHeight
        ? preferredTop
        : Math.max(8, rect.top - 56);
      commentEditor.style.left = left + "px";
      commentEditor.style.top = top + "px";
      commentEditor.style.width = width + "px";
    };
    const showCommentEditor = (payload, rect) => {
      if (commentEditor) commentEditor.remove();
      pendingPayload = payload;
      commentEditor = document.createElement("form");
      commentEditor.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "height:44px",
        "display:flex",
        "align-items:center",
        "gap:8px",
        "padding:6px 7px 6px 12px",
        "border-radius:999px",
        "background:rgba(38,38,38,0.96)",
        "border:1px solid rgba(255,255,255,0.10)",
        "box-shadow:0 18px 46px rgba(0,0,0,0.36)",
        "backdrop-filter:blur(16px)",
      ].join(";");
      commentEditor.innerHTML = [
        "<span style=\\"display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;color:#9ca3af;font:14px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\\">⌘</span>",
        "<input aria-label=\\"添加评论\\" placeholder=\\"添加评论...\\" style=\\"min-width:0;flex:1;border:0;outline:0;background:transparent;color:#f8fafc;font:14px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif\\" />",
        "<button aria-label=\\"确认评论\\" type=\\"submit\\" disabled style=\\"width:32px;height:32px;border:0;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:#737373;color:#171717;font:700 20px ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;opacity:.62\\">↑</button>",
      ].join("");
      document.documentElement.append(commentEditor);
      const input = commentEditor.querySelector("input");
      const button = commentEditor.querySelector("button");
      const updateButton = () => {
        const active = Boolean(input.value.trim());
        button.disabled = !active;
        button.style.opacity = active ? "1" : ".62";
        button.style.background = active ? "#f8fafc" : "#737373";
        button.style.color = active ? "#111827" : "#171717";
      };
      input.addEventListener("input", updateButton);
      commentEditor.addEventListener("click", (event) => event.stopPropagation(), true);
      commentEditor.addEventListener("mousemove", (event) => event.stopPropagation(), true);
      commentEditor.addEventListener("submit", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const comment = input.value.trim();
        if (!comment || !pendingPayload) return;
        pendingPayload.comment = comment;
        commentEditor.style.display = "none";
        addConfirmedMarker(pendingPayload);
        clearHover();
        Promise.resolve(window.__squadflowBrowserPicker?.select?.(pendingPayload)).finally(() => {
          pendingPayload = null;
          if (commentEditor) commentEditor.remove();
          commentEditor = null;
          clearHover();
        });
      });
      positionCommentEditor(rect);
      input.focus({ preventScroll: true });
    };
    const onClick = (event) => {
      if (commentEditor && commentEditor.contains(event.target)) return;
      if (!currentElement) updateOverlay(document.elementFromPoint(event.clientX, event.clientY));
      if (!currentElement) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = currentElement.getBoundingClientRect();
      const payload = {
        tagName: currentElement.localName,
        text: textFor(currentElement),
        selector: selectorFor(currentElement),
        role: currentElement.getAttribute("role") || "",
        ariaLabel: currentElement.getAttribute("aria-label") || "",
        title: currentElement.getAttribute("title") || "",
        url: location.href,
        pageTitle: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        attributes: {
          id: currentElement.id || "",
          className: typeof currentElement.className === "string" ? currentElement.className : "",
          href: currentElement.getAttribute("href") || "",
          name: currentElement.getAttribute("name") || "",
          type: currentElement.getAttribute("type") || "",
        },
      };
      payload.markerNumber = ${Number.isFinite(Number(markerNumber)) ? Math.max(1, Math.round(Number(markerNumber))) : 1};
      showCommentEditor(payload, rect);
      return;
    };

    window[cleanupKey] = (options = {}) => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mouseleave", onMouseLeave, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize, true);
      window.removeEventListener("blur", onMouseLeave, true);
      overlay.remove();
      badge.remove();
      marker.remove();
      if (commentEditor) commentEditor.remove();
      if (options.removeConfirmed) {
        confirmedMarkers.entries = [];
        confirmedMarkers.root.remove();
        window[confirmedMarkersKey] = null;
      } else if (options.hideConfirmed) {
        confirmedMarkers.root.remove();
        window[confirmedMarkersKey] = null;
      }
      window[clearHoverKey] = null;
      window[cleanupKey] = null;
    };
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mouseleave", onMouseLeave, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize, true);
    window.addEventListener("blur", onMouseLeave, true);
  })();`;
}

function stopBrowserPicker(ctx, options = {}) {
  ctx.pickerActive = false;
  const removeConfirmed = Boolean(options.removeConfirmed);
  const hideConfirmed = options.hideConfirmed !== false;
  if (removeConfirmed) ctx.confirmedMarkers = [];
  ctx.view.webContents.executeJavaScript(
    `window.__squadflowElementPickerCleanup && window.__squadflowElementPickerCleanup({ removeConfirmed: ${removeConfirmed ? "true" : "false"}, hideConfirmed: ${hideConfirmed ? "true" : "false"} })`,
    true,
  ).catch(() => {});
  emitBrowserState(ctx);
}

async function resetBrowserContext(ctx) {
  stopBrowserPicker(ctx, { removeConfirmed: true });
  await ctx.view.webContents.loadURL(browserHomeUrl).catch(() => {});
  if (typeof ctx.view.webContents.navigationHistory?.clear === "function") {
    ctx.view.webContents.navigationHistory.clear();
  } else if (typeof ctx.view.webContents.clearHistory === "function") {
    ctx.view.webContents.clearHistory();
  }
  emitBrowserState(ctx);
  return browserState(ctx);
}

function sanitizeSelectedElement(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload;
  const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : {};
  const attributes = raw.attributes && typeof raw.attributes === "object" ? raw.attributes : {};
  return {
    tagName: String(raw.tagName || "").slice(0, 40),
    text: String(raw.text || "").slice(0, 240),
    selector: String(raw.selector || "").slice(0, 500),
    role: String(raw.role || "").slice(0, 80),
    ariaLabel: String(raw.ariaLabel || "").slice(0, 160),
    title: String(raw.title || "").slice(0, 160),
    url: String(raw.url || "").slice(0, 1000),
    pageTitle: String(raw.pageTitle || "").slice(0, 240),
    markerNumber: Math.max(1, Math.round(Number(raw.markerNumber) || 1)),
    comment: String(raw.comment || "").slice(0, 500),
    screenshotDataUrl: "",
    viewport: {
      width: Number(raw.viewport?.width) || 0,
      height: Number(raw.viewport?.height) || 0,
    },
    rect: {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
    },
    attributes: {
      id: String(attributes.id || "").slice(0, 160),
      className: String(attributes.className || "").slice(0, 300),
      href: String(attributes.href || "").slice(0, 1000),
      name: String(attributes.name || "").slice(0, 160),
      type: String(attributes.type || "").slice(0, 80),
    },
  };
}

function getDesktopBrowserContext(win) {
  if (!win || win.isDestroyed()) return null;
  const existing = desktopBrowsers.get(win.id);
  if (existing) return existing;

  let ctx;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "browser-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:squadflow-browser",
    },
  });
  ctx = {
    win,
    view,
    visible: false,
    pickerActive: false,
    confirmedMarkers: [],
    consoleLogs: [],
  };
  desktopBrowsers.set(win.id, ctx);
  win.contentView.addChildView(view);
  setViewBounds(view, { x: 0, y: 0, width: 0, height: 0 });
  setViewVisible(view, false);

  view.webContents.setWindowOpenHandler(({ url }) => {
    view.webContents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });

  const emit = () => emitBrowserState(ctx);
  view.webContents.on("did-start-loading", emit);
  view.webContents.on("did-stop-loading", emit);
  view.webContents.on("did-navigate", emit);
  view.webContents.on("did-navigate-in-page", emit);
  view.webContents.on("did-fail-load", emit);
  view.webContents.on("page-title-updated", emit);
  view.webContents.on("console-message", (event, level, message, lineNumber, sourceId) => {
    const resolvedLevel = event && typeof event.level !== "undefined" ? event.level : level;
    const resolvedMessage = event && typeof event.message !== "undefined" ? event.message : message;
    appendConsoleLog(ctx, resolvedLevel, resolvedMessage);
  });
  view.webContents.loadURL(browserHomeUrl).catch(() => {});

  win.on("closed", () => {
    desktopBrowsers.delete(win.id);
  });

  return ctx;
}

function waitForLoadSettled(webContents, timeoutMs = 20000) {
  if (!webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      webContents.removeListener("did-stop-loading", finish);
      webContents.removeListener("did-fail-load", finish);
      resolve();
    };
    webContents.once("did-stop-loading", finish);
    webContents.once("did-fail-load", finish);
    setTimeout(finish, timeoutMs);
  });
}

function buildAgentScript(fn, ...args) {
  const argsJson = args.map((arg) => JSON.stringify(arg === undefined ? null : arg)).join(",");
  return `(${fn.toString()})(${argsJson})`;
}

function agentSnapshotCollector() {
  const MAX_OUTPUT_LENGTH = 30000;
  const isVisible = (element) => {
    if (!element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    return tag;
  };
  const textFor = (element) => (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const selector = "a[href], button, input, select, textarea, [role], [contenteditable='true'], [tabindex]";
  const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisible);
  const map = new Map();
  const lines = [];
  candidates.forEach((element, index) => {
    const ref = "e" + (index + 1);
    map.set(ref, element);
    const role = roleFor(element);
    const name = element.getAttribute("aria-label") || element.getAttribute("placeholder") || textFor(element) || element.getAttribute("title") || "";
    const value = "value" in element && typeof element.value === "string" ? element.value : "";
    const disabled = element.disabled ? " disabled" : "";
    let line = "[" + ref + "] " + role + " \"" + name.replace(/"/g, "'") + "\"";
    if (value) line += " value=\"" + value.slice(0, 80).replace(/"/g, "'") + "\"";
    line += disabled;
    lines.push(line);
  });
  window.__squadflowAgentRefs = map;
  let outline = "URL: " + location.href + "\nTitle: " + document.title + "\n\n" + lines.join("\n");
  let truncated = false;
  if (outline.length > MAX_OUTPUT_LENGTH) {
    outline = outline.slice(0, MAX_OUTPUT_LENGTH) + "\n...[truncated, snapshot exceeds size limit]";
    truncated = true;
  }
  return { outline, url: location.href, title: document.title, elementCount: candidates.length, truncated };
}

function agentRefExpired() {
  return {
    ok: false,
    reason: "ref_expired",
    message: "The ref no longer points to a connected element.",
    recovery: "Call browser_snapshot and use refs from the new snapshot.",
  };
}

function agentClickElement(ref, refExpiredResult) {
  const map = window.__squadflowAgentRefs;
  const element = map ? map.get(ref) : null;
  if (!element || !element.isConnected) {
    return refExpiredResult;
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return { ok: true };
}

function agentFillElement(ref, value, refExpiredResult) {
  const map = window.__squadflowAgentRefs;
  const element = map ? map.get(ref) : null;
  if (!element || !element.isConnected) {
    return refExpiredResult;
  }
  if (element.localName === "select") {
    element.value = value;
  } else if ("value" in element) {
    const nativeSetter = element.localName === "textarea"
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) nativeSetter.call(element, value);
    else element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return { ok: false, reason: "not_fillable" };
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

function agentWaitFor(text, selector, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const selectorHit = selector ? Boolean(document.querySelector(selector)) : false;
      const textHit = text ? Boolean(document.body && document.body.innerText.includes(text)) : false;
      if (selectorHit || textHit) {
        resolve({ matched: true, timedOut: false });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ matched: false, timedOut: true });
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

function safeSerializeAgentResult(value) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  } catch {
    return String(value);
  }
}

async function dispatchDesktopBridgeCommand(command, params = {}) {
  if (command === "lease_changed") {
    currentBrowserLease = params && params.lease ? params.lease : null;
    for (const ctx of desktopBrowsers.values()) emitBrowserState(ctx);
    return { ok: true };
  }

  const ctx = getDesktopBrowserContext(mainWindow);
  if (!ctx) throw new Error("desktop browser view is not available");

  switch (command) {
    case "navigate": {
      await ctx.view.webContents.loadURL(toNavigationUrl(params.url)).catch(() => {});
      await waitForLoadSettled(ctx.view.webContents);
      return browserState(ctx);
    }
    case "reload": {
      ctx.view.webContents.reload();
      await waitForLoadSettled(ctx.view.webContents);
      return browserState(ctx);
    }
    case "snapshot": {
      return ctx.view.webContents.executeJavaScript(buildAgentScript(agentSnapshotCollector), true);
    }
    case "click": {
      let result;
      const urlBefore = ctx.view.webContents.getURL();
      try {
        result = await ctx.view.webContents.executeJavaScript(
          buildAgentScript(agentClickElement, params.ref, agentRefExpired()),
          true,
        );
      } catch (error) {
        if (ctx.view.webContents.getURL() !== urlBefore || ctx.view.webContents.isLoading()) {
          result = { ok: true, navigated: true };
        } else {
          result = {
            ok: false,
            reason: "execute_failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      await sleep(150);
      const navigationDetected = ctx.view.webContents.getURL() !== urlBefore || ctx.view.webContents.isLoading();
      return { ...result, ...(result.ok !== false && navigationDetected ? { navigated: true } : {}), ...browserState(ctx) };
    }
    case "fill": {
      return ctx.view.webContents.executeJavaScript(
        buildAgentScript(agentFillElement, params.ref, params.value, agentRefExpired()),
        true,
      );
    }
    case "wait_for": {
      return ctx.view.webContents.executeJavaScript(
        buildAgentScript(agentWaitFor, params.text ?? null, params.selector ?? null, params.timeoutMs ?? 5000),
        true,
      );
    }
    case "screenshot": {
      const capture = prepareAgentViewCapture(ctx);
      try {
        if (!capture.stayHidden) {
          await ctx.view.webContents.executeJavaScript(
            "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            true,
          ).catch(() => {});
        }
        const image = await ctx.view.webContents.capturePage(undefined, capture.stayHidden ? { stayHidden: true } : undefined);
        const size = image.getSize();
        return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
      } finally {
        capture.restore();
      }
    }
    case "console_logs": {
      const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
      const entries = ctx.consoleLogs.slice(-limit);
      return { logs: entries.map((entry) => `[${entry.level}] ${entry.message}`).join("\n") };
    }
    case "eval": {
      const result = await ctx.view.webContents.executeJavaScript(params.js, true);
      return { result: safeSerializeAgentResult(result) };
    }
    default:
      throw new Error(`unknown desktop bridge command: ${command}`);
  }
}

function desktopBridgeWsUrl() {
  return process.env.SQUADFLOW_DESKTOP_BRIDGE_WS_URL
    || backendHealthUrl().replace(/^http/, "ws").replace(/\/health$/, "/desktop/ws");
}

const desktopBridgeClient = (() => {
  const RECONNECT_DELAY_MS = 3000;
  const REQUEST_TIMEOUT_MS = 15000;
  let socket = null;
  let reconnectTimer = null;
  const pending = new Map();

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  async function handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.type === "response" && typeof parsed.id === "string") {
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      clearTimeout(entry.timeout);
      if (parsed.ok) entry.resolve(parsed.result);
      else entry.reject(new Error(parsed.error || "desktop bridge request failed"));
      return;
    }
    if (parsed.type === "request" && typeof parsed.id === "string" && typeof parsed.command === "string") {
      try {
        const result = await dispatchDesktopBridgeCommand(parsed.command, parsed.params || {});
        socket?.send(JSON.stringify({ type: "response", id: parsed.id, ok: true, result }));
      } catch (error) {
        socket?.send(JSON.stringify({
          type: "response",
          id: parsed.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  function connect() {
    try {
      socket = new WebSocket(desktopBridgeWsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ type: "register", capabilities: { browser: true } }));
    });
    socket.addEventListener("message", (event) => {
      void handleMessage(String(event.data));
    });
    socket.addEventListener("close", () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("desktop bridge connection closed"));
      }
      pending.clear();
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  function requestBackend(command, params = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("desktop bridge is not connected to the backend"));
    }
    const id = `electron-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`desktop bridge request timed out: ${command}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ type: "request", id, command, params }));
    });
  }

  return {
    start: connect,
    requestBackend,
  };
})();

ipcMain.handle("desktop-browser:set-visible", (event, visible) => {
  const win = requesterWindow(event);
  const ctx = getDesktopBrowserContext(win);
  if (!ctx) return null;
  ctx.visible = Boolean(visible);
  setViewVisible(ctx.view, ctx.visible);
  emitBrowserState(ctx);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:set-layout", (event, payload) => {
  const win = requesterWindow(event);
  const ctx = getDesktopBrowserContext(win);
  if (!ctx) return null;
  const shouldShow = Boolean(payload?.visible);
  const nextBounds = clampBounds(payload?.bounds);
  ctx.visible = shouldShow;
  if (!shouldShow || !nextBounds || nextBounds.width <= 0 || nextBounds.height <= 0) {
    setViewVisible(ctx.view, false);
    setViewBounds(ctx.view, { x: 0, y: 0, width: 0, height: 0 });
    emitBrowserState(ctx);
    return browserState(ctx);
  }
  setViewBounds(ctx.view, nextBounds);
  setViewVisible(ctx.view, true);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:set-bounds", (event, bounds) => {
  const win = requesterWindow(event);
  const ctx = getDesktopBrowserContext(win);
  const nextBounds = clampBounds(bounds);
  if (!ctx || !nextBounds) return null;
  setViewBounds(ctx.view, nextBounds);
  setViewVisible(ctx.view, ctx.visible && nextBounds.width > 0 && nextBounds.height > 0);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:navigate", async (event, input) => {
  const win = requesterWindow(event);
  const ctx = getDesktopBrowserContext(win);
  if (!ctx) return null;
  const navigationUrl = toNavigationUrl(input);
  await ctx.view.webContents.loadURL(navigationUrl === "about:blank" ? browserHomeUrl : navigationUrl);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:go-back", (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  goBack(ctx.view.webContents);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:go-forward", (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  goForward(ctx.view.webContents);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:reload", (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  ctx.view.webContents.reload();
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:capture-screenshot", async (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  const image = await ctx.view.webContents.capturePage();
  clipboard.writeImage(image);
  return {
    dataUrl: image.toDataURL(),
    size: image.getSize(),
  };
});

ipcMain.handle("desktop-browser:start-picker", async (event, markerNumber) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  ctx.pickerActive = true;
  await ctx.view.webContents.executeJavaScript(elementPickerScript(markerNumber, ctx.confirmedMarkers), true);
  emitBrowserState(ctx);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:stop-picker", (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  stopBrowserPicker(ctx);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:reset", async (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  return resetBrowserContext(ctx);
});

ipcMain.handle("desktop-browser:set-confirmed-markers", async (event, markers) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  ctx.confirmedMarkers = sanitizeConfirmedMarkers(markers);
  const nextMarkerNumber = ctx.confirmedMarkers.length
    ? Math.max(...ctx.confirmedMarkers.map((entry) => entry.markerNumber)) + 1
    : 1;
  if (ctx.pickerActive) {
    await ctx.view.webContents.executeJavaScript(elementPickerScript(nextMarkerNumber, ctx.confirmedMarkers), true)
      .catch(() => {});
  } else if (ctx.confirmedMarkers.length === 0) {
    await ctx.view.webContents.executeJavaScript(
      "window.__squadflowElementPickerCleanup && window.__squadflowElementPickerCleanup({ removeConfirmed: true })",
      true,
    ).catch(() => {});
  }
  emitBrowserState(ctx);
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:clear-picker-hover", async (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  if (!ctx) return null;
  await ctx.view.webContents.executeJavaScript(
    "window.__squadflowElementPickerClearHover && window.__squadflowElementPickerClearHover()",
    true,
  ).catch(() => {});
  return browserState(ctx);
});

ipcMain.handle("desktop-browser:get-state", (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  return ctx ? browserState(ctx) : null;
});

ipcMain.handle("desktop-browser:reclaim-lease", async (event) => {
  const ctx = getDesktopBrowserContext(requesterWindow(event));
  try {
    const response = await desktopBridgeClient.requestBackend("reclaim_lease", {});
    currentBrowserLease = response && response.lease ? response.lease : null;
  } catch {
    currentBrowserLease = null;
  }
  if (ctx) emitBrowserState(ctx);
  return ctx ? browserState(ctx) : null;
});

ipcMain.handle("desktop-browser:element-selected", async (event, payload) => {
  const ctx = findDesktopBrowserByWebContents(event.sender);
  const selectedElement = sanitizeSelectedElement(payload);
  if (!ctx || !selectedElement || ctx.win.isDestroyed()) return null;
  ctx.confirmedMarkers = upsertConfirmedMarker(
    ctx.confirmedMarkers,
    confirmedMarkerFromElement(selectedElement),
  );
  try {
    await ctx.view.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    ).catch(() => {});
    const screenshot = await ctx.view.webContents.capturePage();
    const resized = screenshot.getSize().width > 1280
      ? screenshot.resize({ width: 1280 })
      : screenshot;
    selectedElement.screenshotDataUrl = resized.toDataURL();
  } catch {
    selectedElement.screenshotDataUrl = "";
  }
  ctx.win.webContents.send("desktop-browser:selected-element", selectedElement);
  emitBrowserState(ctx);
  return selectedElement;
});

ipcMain.handle("desktop-shell:set-theme", (event, theme) => {
  const win = requesterWindow(event);
  if (!win || win.isDestroyed()) return null;
  const themeName = String(theme || "");
  const backgroundColor = desktopThemeBackground(themeName);
  nativeTheme.themeSource = desktopThemeSource(themeName);
  win.setBackgroundColor(backgroundColor);
  return { backgroundColor, themeSource: nativeTheme.themeSource };
});

ipcMain.handle("desktop-shell:toggle-window-zoom", (event) => {
  const win = requesterWindow(event);
  if (!win || win.isDestroyed()) return null;
  if (win.isMaximized()) {
    win.unmaximize();
    return { maximized: false };
  }
  win.maximize();
  return { maximized: true };
});

ipcMain.handle("desktop-shell:show-item-in-folder", async (event, targetPath, isDirectory) => {
  const win = requesterWindow(event);
  if (!win || win.isDestroyed() || typeof targetPath !== "string" || !path.isAbsolute(targetPath)) return false;
  if (isDirectory) return (await shell.openPath(targetPath)) === "";
  shell.showItemInFolder(targetPath);
  return true;
});

function createWindow() {
  nativeTheme.themeSource = desktopThemeSource("dark-emerald");
  const savedWindowSize = readWindowSize();
  const win = new BrowserWindow({
    width: savedWindowSize?.width ?? defaultWindowSize.width,
    height: savedWindowSize?.height ?? defaultWindowSize.height,
    minWidth: minimumWindowSize.width,
    minHeight: minimumWindowSize.height,
    title: "SquadFlow",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: desktopThemeBackground("dark-emerald"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  attachWindowSizePersistence(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(loadingPageUrl()).then(() => {
    void waitForServicesAndLoad(win);
  });

  if (process.env.SQUADFLOW_DESKTOP_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    if (app.isPackaged) app.setName("SquadFlow");
    createWindow();
    desktopUpdater.initialize();
    desktopBridgeClient.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    stopPackagedServices(packagedServiceProcesses);
  });
}

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { createHash } = require("node:crypto");
const { CancellationToken, CancellationError } = require("builder-util-runtime");

const UPDATE_STATE_CHANNEL = "desktop-update:state";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === "string") return releaseNotes.trim() || null;
  if (Array.isArray(releaseNotes)) {
    const merged = releaseNotes
      .map((entry) => (typeof entry === "string" ? entry : entry?.note || ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return merged || null;
  }
  return null;
}

function sha512Matches(filePath, expected) {
  if (!expected) return true;
  const digest = createHash("sha512").update(fs.readFileSync(filePath)).digest();
  return expected === digest.toString("base64") || expected === digest.toString("hex");
}

function requestDownload(url, headers, cancellationToken, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      reject(new Error("Too many redirects while downloading update"));
      return;
    }
    const parsed = new URL(url);
    const requestHeaders = { ...headers };
    const request = (parsed.protocol === "http:" ? http : https).request(parsed, { headers: requestHeaders }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed);
        const nextHeaders = nextUrl.origin === parsed.origin ? requestHeaders : Object.fromEntries(
          Object.entries(requestHeaders).filter(([name]) => !/^(authorization|cookie|private-token)$/i.test(name)),
        );
        requestDownload(nextUrl.toString(), nextHeaders, cancellationToken, redirectCount + 1).then(resolve, reject);
        return;
      }
      resolve({ response, url: parsed.toString() });
    });
    const cancel = () => request.destroy(new CancellationError());
    cancellationToken.onCancel(cancel);
    request.once("error", (error) => {
      cancellationToken.removeListener("cancel", cancel);
      reject(error);
    });
    request.end();
  });
}

async function downloadFileWithResume({ url, headers = {}, filePath, expectedSha512, expectedSize, cancellationToken, onProgress }) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  while (true) {
    const existingSize = await fs.promises.stat(filePath).then((stat) => stat.size).catch(() => 0);
    if (existingSize === 0) {
      const handle = await fs.promises.open(filePath, "a");
      await handle.close();
    }
    if (expectedSize && existingSize === expectedSize && sha512Matches(filePath, expectedSha512)) return filePath;
    if (existingSize > 0 && expectedSize) onProgress?.((existingSize / expectedSize) * 100);
    const rangeHeaders = existingSize > 0 ? { ...headers, Range: `bytes=${existingSize}-` } : headers;
    const { response } = await requestDownload(url, rangeHeaders, cancellationToken);
    const status = response.statusCode || 0;

    if (status >= 400) {
      response.resume();
      throw new Error(`Update download failed with HTTP ${status}`);
    }

    const contentRange = String(response.headers["content-range"] || "");
    const totalFromRange = Number(contentRange.match(/\/(\d+)$/)?.[1] || 0);
    const contentLength = Number(response.headers["content-length"] || 0);
    const supportsRange = status === 206 && existingSize > 0;
    if (existingSize > 0 && status === 200) {
      response.resume();
      await fs.promises.truncate(filePath, 0);
      continue;
    }
    if (existingSize > 0 && status !== 206) {
      response.resume();
      throw new Error("Update server does not support resuming downloads");
    }

    const totalSize = totalFromRange || (supportsRange ? existingSize + contentLength : contentLength) || expectedSize || 0;
    const output = fs.createWriteStream(filePath, { flags: supportsRange ? "a" : "w" });
    let received = supportsRange ? existingSize : 0;

    await new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        response.destroy();
        output.end(() => {
          if (!settled) {
            settled = true;
            reject(new CancellationError());
          }
        });
      };
      cancellationToken.onCancel(cancel);
      const onError = (error) => {
        cancellationToken.removeListener("cancel", cancel);
        output.end(() => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      };
      response.on("data", (chunk) => {
        received += chunk.length;
        onProgress?.(totalSize > 0 ? (received / totalSize) * 100 : 0);
      });
      response.on("error", onError);
      response.on("aborted", () => onError(new Error("Update download connection was interrupted")));
      output.on("error", onError);
      output.on("finish", () => {
        cancellationToken.removeListener("cancel", cancel);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      response.pipe(output);
    });

    const finalSize = (await fs.promises.stat(filePath)).size;
    if ((expectedSize && finalSize < expectedSize) || (totalSize && finalSize < totalSize)) {
      throw new Error("Update download ended before the complete file was received");
    }
    if (!sha512Matches(filePath, expectedSha512)) {
      await fs.promises.truncate(filePath, 0);
      throw new Error("Update download checksum mismatch");
    }
    onProgress?.(100);
    return filePath;
  }
}

function findMacZipFileInfo(updater) {
  const updateInfoAndProvider = updater.updateInfoAndProvider;
  if (!updateInfoAndProvider) throw new Error("Please check for updates before downloading");
  const files = updateInfoAndProvider.provider.resolveFiles(updateInfoAndProvider.info);
  const zipFiles = files.filter((file) => /\.zip$/i.test(file.url.pathname));
  return zipFiles.find((file) => /arm64/i.test(file.url.pathname) || /arm64/i.test(file.info?.url || "")) || zipFiles[0];
}

async function prepareResumableMacDownload(updater) {
  const fileInfo = findMacZipFileInfo(updater);
  if (!fileInfo) throw new Error("ZIP update asset was not found");
  const helper = await updater.getOrCreateDownloadHelper();
  const fileName = `update-${updater.updateInfoAndProvider.info.version}.zip`;
  const filePath = path.join(helper.cacheDirForPendingUpdate, fileName);
  const provider = updater.updateInfoAndProvider.provider;
  const headers = typeof updater.computeRequestHeaders === "function"
    ? updater.computeRequestHeaders(provider)
    : {};
  return {
    fileInfo,
    fileName,
    filePath,
    headers,
    helper,
    updateInfo: updater.updateInfoAndProvider.info,
  };
}

async function completeResumableMacDownload(updater, download) {
  await download.helper.setDownloadedFile(
    download.filePath,
    null,
    download.updateInfo,
    download.fileInfo,
    download.fileName,
    true,
  );
  await updater.updateDownloaded(download.fileInfo, {
    ...download.updateInfo,
    downloadedFile: download.filePath,
  });
}

function createDesktopUpdater({
  app,
  updater,
  logger,
  getWindow,
  resourcesPath = process.resourcesPath,
  preferencesPath = null,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
  resumableDownload = downloadFileWithResume,
  prepareResumableDownload = prepareResumableMacDownload,
  completeResumableDownload = completeResumableMacDownload,
  schedule = setTimeout,
  startupDelayMs = 30_000,
  periodicCheckMs = 6 * 60 * 60 * 1_000,
  now = () => new Date().toISOString(),
}) {
  const configPath = path.join(resourcesPath, "app-update.yml");
  let initialized = false;
  let automaticScheduleGeneration = 0;
  let checkPromise = null;
  let downloadPromise = null;
  let downloadCancellationToken = null;
  let downloadAction = null;
  let partialDownload = null;
  let state = {
    enabled: false,
    automaticUpdates: true,
    status: "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  };

  function snapshot() {
    return { ...state };
  }

  function publish(patch) {
    state = { ...state, ...patch };
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(UPDATE_STATE_CHANNEL, snapshot());
    }
  }

  function fail(error) {
    if (error instanceof CancellationError || downloadAction === "pause" || downloadAction === "cancel") return;
    const message = errorMessage(error);
    logger.error("Desktop update failed", message);
    publish({ status: "error", progress: null, error: message });
  }

  function startDownload() {
    if (!state.enabled || !state.availableVersion || downloadPromise) return false;
    downloadAction = null;
    downloadCancellationToken = new CancellationToken();
    publish({ status: "downloading", progress: state.progress ?? 0, error: null });
    const resumable = typeof updater.updateDownloaded === "function"
      && typeof updater.getOrCreateDownloadHelper === "function"
      && typeof resumableDownload === "function";
    downloadPromise = (resumable
      ? prepareResumableDownload(updater).then((download) => {
        partialDownload = download;
        return resumableDownload({
          url: download.fileInfo.url.toString(),
          headers: download.headers,
          filePath: download.filePath,
          expectedSha512: download.fileInfo.info.sha512,
          expectedSize: download.fileInfo.info.size,
          cancellationToken: downloadCancellationToken,
          onProgress: (percent) => publish({ status: "downloading", progress: Math.round(percent), error: null }),
        }).then(() => completeResumableDownload(updater, download));
      })
      : updater.downloadUpdate(downloadCancellationToken))
      .catch((error) => {
        if (!(error instanceof CancellationError) && downloadAction !== "pause" && downloadAction !== "cancel") {
          fail(error);
        }
        return null;
      })
      .finally(() => {
        downloadPromise = null;
        downloadCancellationToken = null;
        if (downloadAction === "cancel" && partialDownload) {
          void fs.promises.rm(path.dirname(partialDownload.filePath), { recursive: true, force: true }).catch(() => {});
        }
        partialDownload = null;
        downloadAction = null;
      });
    return true;
  }

  function pauseDownload() {
    if (state.status !== "downloading" || !downloadCancellationToken) return false;
    downloadAction = "pause";
    downloadCancellationToken.cancel();
    publish({ status: "paused", error: null });
    return true;
  }

  function cancelDownload() {
    if (state.status !== "downloading" || !downloadCancellationToken) return false;
    downloadAction = "cancel";
    downloadCancellationToken.cancel();
    publish({ status: "available", progress: null, error: null });
    return true;
  }

  function loadPreferences() {
    if (!preferencesPath || !existsSync(preferencesPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(preferencesPath, "utf8"));
      if (typeof parsed?.automaticUpdates === "boolean") {
        state.automaticUpdates = parsed.automaticUpdates;
      }
    } catch (error) {
      logger.warn("Desktop update preferences could not be read", errorMessage(error));
    }
  }

  function savePreferences() {
    if (!preferencesPath) return;
    try {
      mkdirSync(path.dirname(preferencesPath), { recursive: true });
      writeFileSync(preferencesPath, JSON.stringify({
        automaticUpdates: state.automaticUpdates,
      }));
    } catch (error) {
      logger.warn("Desktop update preferences could not be saved", errorMessage(error));
    }
  }

  async function checkForUpdates() {
    if (!state.enabled) return snapshot();
    if (checkPromise) return checkPromise;
    checkPromise = (async () => {
      try {
        await updater.checkForUpdates();
      } catch (error) {
        fail(error);
      } finally {
        publish({ lastCheckedAt: now() });
        checkPromise = null;
      }
      return snapshot();
    })();
    return checkPromise;
  }

  function scheduleAutomaticCheck(delayMs) {
    const generation = ++automaticScheduleGeneration;
    schedule(async () => {
      if (generation !== automaticScheduleGeneration || !state.enabled || !state.automaticUpdates) return;
      await checkForUpdates();
      if (generation === automaticScheduleGeneration && state.enabled && state.automaticUpdates) {
        scheduleAutomaticCheck(periodicCheckMs);
      }
    }, delayMs);
  }

  function setAutomaticUpdates(enabled) {
    const automaticUpdates = Boolean(enabled);
    if (state.automaticUpdates === automaticUpdates) return snapshot();
    state.automaticUpdates = automaticUpdates;
    savePreferences();
    publish({ automaticUpdates });
    automaticScheduleGeneration += 1;
    if (state.enabled && automaticUpdates) scheduleAutomaticCheck(0);
    return snapshot();
  }

  function initialize() {
    if (initialized) return snapshot();
    initialized = true;

    loadPreferences();
    const enabled = Boolean(app.isPackaged && existsSync(configPath));
    publish({ enabled });
    if (!enabled) {
      logger.info("Desktop updates are disabled because no packaged update configuration is available.");
      return snapshot();
    }

    updater.logger = logger;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // GitHub's private asset endpoint can resolve the ZIP asset when the
    // differential blockmap is requested, leaving macOS updates at 0% while
    // the updater waits on the wrong response. Prefer the reliable full ZIP
    // download so progress and failure events always reach the UI.
    updater.disableDifferentialDownload = true;

    updater.on("checking-for-update", () => {
      publish({ status: "checking", progress: null, error: null });
    });
    updater.on("update-not-available", () => {
      publish({ status: "idle", availableVersion: null, notes: null, progress: null, error: null });
    });
    updater.on("update-available", (info) => {
      publish({
        status: "available",
        availableVersion: info?.version || null,
        notes: normalizeReleaseNotes(info?.releaseNotes),
        progress: null,
        error: null,
      });
      if (state.automaticUpdates) startDownload();
    });
    updater.on("download-progress", (info) => {
      const percent = Math.max(0, Math.min(100, Math.round(Number(info?.percent) || 0)));
      publish({ status: "downloading", progress: percent, error: null });
    });
    updater.on("update-downloaded", (info) => {
      publish({
        status: "ready",
        availableVersion: info?.version || state.availableVersion,
        notes: normalizeReleaseNotes(info?.releaseNotes) || state.notes,
        progress: 100,
        error: null,
      });
    });
    updater.on("update-cancelled", () => {
      if (downloadAction === "pause") {
        publish({ status: "paused", error: null });
      } else if (downloadAction === "cancel") {
        publish({ status: "available", progress: null, error: null });
      }
    });
    updater.on("error", fail);

    if (state.automaticUpdates) scheduleAutomaticCheck(startupDelayMs);
    return snapshot();
  }

  function install() {
    if (!state.enabled || state.status !== "ready") return false;
    updater.quitAndInstall();
    return true;
  }

  function download() {
    if (!state.enabled || !state.availableVersion) return false;
    return startDownload();
  }

  function resume() {
    if (state.status !== "paused" && state.status !== "error") return false;
    return startDownload();
  }

  return {
    initialize,
    getState: snapshot,
    checkForUpdates,
    download,
    pause: pauseDownload,
    resume,
    cancel: cancelDownload,
    setAutomaticUpdates,
    install,
  };
}

module.exports = {
  UPDATE_STATE_CHANNEL,
  createDesktopUpdater,
  downloadFileWithResume,
};

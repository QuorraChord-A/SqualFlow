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

function fileUrlText(file) {
  const value = file?.url;
  if (typeof value === "string") return value;
  if (value?.href) return value.href;
  if (value?.pathname) return value.pathname;
  if (value?.toString) return value.toString();
  return String(file?.info?.url || file?.info?.path || "");
}

function defaultRequestFactory(parsed, options, callback) {
  return (parsed.protocol === "http:" ? http : https).request(parsed, options, callback);
}

function requestDownload(url, headers, cancellationToken, requestFactory = defaultRequestFactory, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      reject(new Error("Too many redirects while downloading update"));
      return;
    }
    const parsed = new URL(url);
    const hasUserAgent = Object.keys(headers).some((name) => name.toLowerCase() === "user-agent");
    const requestHeaders = hasUserAgent
      ? { ...headers }
      : { "user-agent": "SquadFlow-Updater", ...headers };
    const request = requestFactory(parsed, { headers: requestHeaders }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed);
        const nextHeaders = nextUrl.origin === parsed.origin ? requestHeaders : Object.fromEntries(
          Object.entries(requestHeaders).filter(([name]) => !/^(authorization|cookie|private-token)$/i.test(name)),
        );
        requestDownload(nextUrl.toString(), nextHeaders, cancellationToken, requestFactory, redirectCount + 1).then(resolve, reject);
        return;
      }
      resolve({ response, url: parsed.toString() });
    });
    const cancel = () => {
      if (typeof request.destroy === "function") request.destroy(new CancellationError());
      else request.abort?.();
    };
    cancellationToken.onCancel(cancel);
    request.once("error", (error) => {
      cancellationToken.removeListener("cancel", cancel);
      reject(error);
    });
    request.end();
  });
}

async function downloadFileWithResume({
  url,
  headers = {},
  filePath,
  expectedSha512,
  expectedSize,
  cancellationToken,
  onProgress,
  requestFactory = defaultRequestFactory,
}) {
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
    const { response } = await requestDownload(url, rangeHeaders, cancellationToken, requestFactory);
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
  const { provider, info } = updateInfoAndProvider;
  let files = [];
  try {
    files = provider.resolveFiles(info) || [];
  } catch {
    files = [];
  }
  const zipFiles = files.filter((file) => /\.zip(?:\?|$)/i.test(fileUrlText(file)));
  const resolved = zipFiles.find((file) => /arm64/i.test(fileUrlText(file)) || /arm64/i.test(file.info?.url || "")) || zipFiles[0];
  if (resolved) return resolved;

  const rawFiles = Array.isArray(info.files) ? info.files : (info.path ? [{
    url: info.path,
    sha512: info.sha512,
    sha2: info.sha2,
    size: info.size,
  }] : []);
  const rawZip = rawFiles.find((file) => /\.zip(?:\?|$)/i.test(String(file?.url || "")) && /arm64/i.test(String(file?.url || "")))
    || rawFiles.find((file) => /\.zip(?:\?|$)/i.test(String(file?.url || "")));
  if (!rawZip) return null;

  const assetName = path.posix.basename(String(rawZip.url)).replace(/ /g, "-");
  const releaseAsset = Array.isArray(info.assets)
    ? info.assets.find((asset) => asset?.name === assetName)
    : null;
  if (releaseAsset?.url) {
    return {
      url: new URL(releaseAsset.url),
      info: rawZip,
    };
  }

  let assetPath = String(rawZip.url).replace(/ /g, "-");
  if (typeof provider.getBaseDownloadPath === "function" && info.tag) {
    assetPath = provider.getBaseDownloadPath(info.tag, assetPath);
  }
  const baseUrl = provider.baseUrl || provider.configuration?.url;
  return {
    url: baseUrl ? new URL(assetPath, baseUrl) : new URL(assetPath),
    info: rawZip,
  };
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

async function hasCachedDifferentialUpdate(updater) {
  const helper = updater.downloadedUpdateHelper
    || (typeof updater.getOrCreateDownloadHelper === "function"
      ? await updater.getOrCreateDownloadHelper()
      : null);
  const cacheDir = helper?.cacheDir;
  return Boolean(cacheDir && fs.existsSync(path.join(cacheDir, "update.zip")));
}

async function configurePrivateGitHubBlockMaps(updater) {
  const provider = updater.updateInfoAndProvider?.provider;
  if (
    !provider
    || provider.__squadflowBlockMapProviderConfigured
    || provider.options?.private !== true
    || provider.options?.owner == null
    || provider.options?.repo == null
    || typeof provider.getBlockMapFiles !== "function"
    || typeof provider.httpRequest !== "function"
  ) return;

  const originalGetBlockMapFiles = provider.getBlockMapFiles.bind(provider);
  const releaseAssetsCache = new Map();
  provider.getBlockMapFiles = async (baseUrl, oldVersion, newVersion, oldBlockMapBaseUrl) => {
    const info = updater.updateInfoAndProvider?.info;
    const assets = Array.isArray(info?.assets) ? info.assets : [];
    const newZipAsset = assets.find((asset) => asset?.url === baseUrl.href)
      || assets.find((asset) => asset?.name === path.posix.basename(baseUrl.pathname));
    const newBlockMapAsset = newZipAsset
      ? assets.find((asset) => asset?.name === `${newZipAsset.name}.blockmap`)
      : null;
    if (!newBlockMapAsset?.url) {
      return originalGetBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapBaseUrl);
    }

    let oldAssets = releaseAssetsCache.get(oldVersion);
    if (!oldAssets) {
      const apiBase = provider.baseApiUrl || new URL("https://api.github.com/");
      const releaseUrl = new URL(
        `/repos/${provider.options.owner}/${provider.options.repo}/releases/tags/v${oldVersion}`,
        apiBase,
      );
      const releaseHeaders = typeof provider.configureHeaders === "function"
        ? provider.configureHeaders("application/vnd.github.v3+json")
        : { ...provider.fileExtraDownloadHeaders, accept: "application/vnd.github.v3+json" };
      const rawRelease = await provider.httpRequest(
        releaseUrl,
        releaseHeaders,
        new CancellationToken(),
      );
      const release = JSON.parse(rawRelease);
      oldAssets = Array.isArray(release?.assets) ? release.assets : [];
      releaseAssetsCache.set(oldVersion, oldAssets);
    }

    const oldZipName = newZipAsset.name.replace(newVersion, oldVersion);
    const oldBlockMapAsset = oldAssets.find((asset) => asset?.name === `${oldZipName}.blockmap`);
    if (!oldBlockMapAsset?.url) {
      return originalGetBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapBaseUrl);
    }

    return [new URL(oldBlockMapAsset.url), new URL(newBlockMapAsset.url)];
  };
  provider.__squadflowBlockMapProviderConfigured = true;
}

function createNativeDownloadPauseGate(updater) {
  const executor = updater.httpExecutor;
  if (!executor || typeof executor.createRequest !== "function") return null;

  const originalCreateRequest = executor.createRequest;
  const activeResponses = new Set();
  let paused = false;

  executor.createRequest = function createPausableRequest(options, callback) {
    return originalCreateRequest.call(executor, options, (response) => {
      activeResponses.add(response);
      const removeResponse = () => activeResponses.delete(response);
      response.once?.("end", removeResponse);
      response.once?.("close", removeResponse);
      response.once?.("error", removeResponse);
      callback(response);
      if (paused && typeof response.pause === "function") response.pause();
    });
  };

  return {
    pause() {
      paused = true;
      for (const response of activeResponses) response.pause?.();
    },
    resume() {
      paused = false;
      for (const response of activeResponses) response.resume?.();
    },
    restore() {
      paused = false;
      for (const response of activeResponses) response.resume?.();
      activeResponses.clear();
      executor.createRequest = originalCreateRequest;
    },
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
  if (download.helper.cacheDir) {
    try {
      await fs.promises.copyFile(
        download.filePath,
        path.join(download.helper.cacheDir, "update.zip"),
      );
    } catch (error) {
      updater.logger?.warn?.(`Unable to cache update.zip for differential downloads: ${errorMessage(error)}`);
    }
  }
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
  requestFactory = defaultRequestFactory,
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
  let nativePauseGate = null;
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
    downloadPromise = configurePrivateGitHubBlockMaps(updater)
      .then(async () => {
        const useNativeDifferential = updater.disableDifferentialDownload === false
          && await hasCachedDifferentialUpdate(updater)
          && typeof updater.downloadUpdate === "function";
        const resumable = !useNativeDifferential && typeof updater.updateDownloaded === "function"
          && typeof updater.getOrCreateDownloadHelper === "function"
          && typeof resumableDownload === "function";
        if (useNativeDifferential) {
          nativePauseGate = createNativeDownloadPauseGate(updater);
          return updater.downloadUpdate(downloadCancellationToken);
        }
        if (!resumable) return updater.downloadUpdate(downloadCancellationToken);
        return prepareResumableDownload(updater).then((download) => {
          partialDownload = download;
          return resumableDownload({
            url: fileUrlText(download.fileInfo),
            headers: download.headers,
            filePath: download.filePath,
            expectedSha512: download.fileInfo.info.sha512,
            expectedSize: download.fileInfo.info.size,
            cancellationToken: downloadCancellationToken,
            onProgress: (percent) => publish({ status: "downloading", progress: Math.round(percent), error: null }),
            requestFactory,
          }).then(() => completeResumableDownload(updater, download));
        });
      })
      .catch((error) => {
        if (!(error instanceof CancellationError) && downloadAction !== "pause" && downloadAction !== "cancel") {
          fail(error);
        }
        return null;
      })
      .finally(() => {
        nativePauseGate?.restore();
        nativePauseGate = null;
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
    if (nativePauseGate) {
      nativePauseGate.pause();
      publish({ status: "paused", error: null });
      return true;
    }
    downloadCancellationToken.cancel();
    publish({ status: "paused", error: null });
    return true;
  }

  function cancelDownload() {
    if (state.status !== "downloading" || !downloadCancellationToken) return false;
    downloadAction = "cancel";
    nativePauseGate?.resume();
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
    updater.disableDifferentialDownload = false;

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
    if (state.status === "paused" && nativePauseGate && downloadPromise) {
      downloadAction = null;
      nativePauseGate.resume();
      publish({ status: "downloading", error: null });
      return true;
    }
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
  configurePrivateGitHubBlockMaps,
};

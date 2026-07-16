const fs = require("node:fs");
const path = require("node:path");

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

function createDesktopUpdater({
  app,
  updater,
  logger,
  getWindow,
  resourcesPath = process.resourcesPath,
  existsSync = fs.existsSync,
  schedule = setTimeout,
  startupDelayMs = 30_000,
}) {
  const configPath = path.join(resourcesPath, "app-update.yml");
  let initialized = false;
  let state = {
    enabled: false,
    status: "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    notes: null,
    progress: null,
    error: null,
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
    const message = errorMessage(error);
    logger.error("Desktop update failed", message);
    publish({ status: "error", progress: null, error: message });
  }

  async function checkForUpdates() {
    if (!state.enabled) return snapshot();
    try {
      await updater.checkForUpdates();
    } catch (error) {
      fail(error);
    }
    return snapshot();
  }

  function initialize() {
    if (initialized) return snapshot();
    initialized = true;

    const enabled = Boolean(app.isPackaged && existsSync(configPath));
    publish({ enabled });
    if (!enabled) {
      logger.info("Desktop updates are disabled because no packaged update configuration is available.");
      return snapshot();
    }

    updater.logger = logger;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    updater.on("checking-for-update", () => {
      publish({ status: "checking", progress: null, error: null });
    });
    updater.on("update-not-available", () => {
      publish({ status: "idle", availableVersion: null, notes: null, progress: null, error: null });
    });
    updater.on("update-available", (info) => {
      publish({
        status: "downloading",
        availableVersion: info?.version || null,
        notes: normalizeReleaseNotes(info?.releaseNotes),
        progress: 0,
        error: null,
      });
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
      publish({ status: "idle", availableVersion: null, notes: null, progress: null, error: null });
    });
    updater.on("error", fail);

    schedule(() => {
      void checkForUpdates();
    }, startupDelayMs);
    return snapshot();
  }

  function install() {
    if (!state.enabled || state.status !== "ready") return false;
    updater.quitAndInstall();
    return true;
  }

  return {
    initialize,
    getState: snapshot,
    checkForUpdates,
    install,
  };
}

module.exports = {
  UPDATE_STATE_CHANNEL,
  createDesktopUpdater,
};

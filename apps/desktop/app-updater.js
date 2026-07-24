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
  preferencesPath = null,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
  schedule = setTimeout,
  startupDelayMs = 30_000,
  periodicCheckMs = 6 * 60 * 60 * 1_000,
  now = () => new Date().toISOString(),
}) {
  const configPath = path.join(resourcesPath, "app-update.yml");
  let initialized = false;
  let automaticScheduleGeneration = 0;
  let checkPromise = null;
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
    const message = errorMessage(error);
    logger.error("Desktop update failed", message);
    publish({ status: "error", progress: null, error: message });
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
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
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

    if (state.automaticUpdates) scheduleAutomaticCheck(startupDelayMs);
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
    setAutomaticUpdates,
    install,
  };
}

module.exports = {
  UPDATE_STATE_CHANNEL,
  createDesktopUpdater,
};

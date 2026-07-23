const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopUpdater } = require("../app-updater");
const releaseConfig = require("../electron-builder.release.cjs");
const privateTestConfig = require("../electron-builder.private-test.cjs");

function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => null;
  updater.quitAndInstall = () => {};
  return updater;
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("publishes release updates through the public SquadFlow GitHub repository", () => {
  assert.deepEqual(releaseConfig.publish, [{
    provider: "github",
    owner: "QuorraChord-A",
    repo: "SqualFlow",
  }]);
  assert.ok(releaseConfig.mac.binaries.includes(`Contents/Resources/codex-runtime/darwin-${process.arch}/codex`));
});

test("keeps private self-signed update testing separate from the notarized release", () => {
  assert.deepEqual(privateTestConfig.publish, [{
    provider: "github",
    owner: "QuorraChord-A",
    repo: "SqualFlow",
    private: true,
  }]);
  assert.equal(privateTestConfig.mac.notarize, false);
  assert.equal(releaseConfig.mac.notarize, true);
});

test("keeps desktop updates disabled without packaged update configuration", () => {
  const updater = createUpdater();
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/missing",
    existsSync: () => false,
  });

  assert.deepEqual(controller.initialize(), {
    enabled: false,
    automaticUpdates: true,
    status: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  });
  assert.equal(updater.listenerCount("update-downloaded"), 0);
  assert.equal(controller.install(), false);
});

test("publishes download progress and installs only after the update is ready", () => {
  const updater = createUpdater();
  let scheduledCheck = null;
  let installCalls = 0;
  const sentStates = [];
  updater.quitAndInstall = () => {
    installCalls += 1;
  };
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (_channel, state) => sentStates.push(state),
      },
    }),
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: (callback) => {
      scheduledCheck = callback;
      return 1;
    },
  });

  controller.initialize();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(typeof scheduledCheck, "function");
  assert.equal(controller.install(), false);

  updater.emit("update-available", { version: "0.2.0", releaseNotes: "修复若干问题" });
  updater.emit("download-progress", { percent: 43.6 });
  assert.equal(controller.getState().status, "downloading");
  assert.equal(controller.getState().progress, 44);
  assert.equal(controller.getState().notes, "修复若干问题");

  updater.emit("update-downloaded", { version: "0.2.0" });
  assert.deepEqual(controller.getState(), {
    enabled: true,
    automaticUpdates: true,
    status: "ready",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    notes: "修复若干问题",
    progress: 100,
    error: null,
    lastCheckedAt: null,
  });
  assert.equal(sentStates.at(-1).status, "ready");
  assert.equal(controller.install(), true);
  assert.equal(installCalls, 1);
});

test("persists the automatic-update preference while keeping manual checks available", async () => {
  const updater = createUpdater();
  let checkCalls = 0;
  let savedPreferences = null;
  updater.checkForUpdates = async () => {
    checkCalls += 1;
  };
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    preferencesPath: "/preferences/update.json",
    existsSync: (targetPath) => targetPath === "/resources/app-update.yml",
    readFileSync: () => {
      throw new Error("preferences should not be read");
    },
    writeFileSync: (_targetPath, value) => {
      savedPreferences = value;
    },
    mkdirSync: () => {},
    schedule: () => 1,
    now: () => "2026-07-22T20:00:00.000Z",
  });

  controller.initialize();
  const disabledState = controller.setAutomaticUpdates(false);
  assert.equal(disabledState.automaticUpdates, false);
  assert.deepEqual(JSON.parse(savedPreferences), { automaticUpdates: false });

  await controller.checkForUpdates();
  assert.equal(checkCalls, 1);
  assert.equal(controller.getState().lastCheckedAt, "2026-07-22T20:00:00.000Z");
});

test("loads a disabled preference without scheduling a background check", () => {
  const updater = createUpdater();
  let scheduleCalls = 0;
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    preferencesPath: "/preferences/update.json",
    existsSync: (targetPath) => (
      targetPath === "/resources/app-update.yml" || targetPath === "/preferences/update.json"
    ),
    readFileSync: () => JSON.stringify({ automaticUpdates: false }),
    schedule: () => {
      scheduleCalls += 1;
      return 1;
    },
  });

  assert.equal(controller.initialize().automaticUpdates, false);
  assert.equal(scheduleCalls, 0);
});

test("checks again on the configured background interval", async () => {
  const updater = createUpdater();
  const scheduled = [];
  let checkCalls = 0;
  updater.checkForUpdates = async () => {
    checkCalls += 1;
  };
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    startupDelayMs: 30_000,
    periodicCheckMs: 60_000,
  });

  controller.initialize();
  assert.equal(scheduled[0].delay, 30_000);
  await scheduled[0].callback();
  assert.equal(checkCalls, 1);
  assert.equal(scheduled[1].delay, 60_000);
});

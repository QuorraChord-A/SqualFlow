const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createDesktopUpdater } = require("../app-updater");

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
    status: "idle",
    currentVersion: "0.1.0",
    availableVersion: null,
    notes: null,
    progress: null,
    error: null,
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
    status: "ready",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    notes: "修复若干问题",
    progress: 100,
    error: null,
  });
  assert.equal(sentStates.at(-1).status, "ready");
  assert.equal(controller.install(), true);
  assert.equal(installCalls, 1);
});

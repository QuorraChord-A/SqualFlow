const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { PassThrough } = require("node:stream");
const { mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createDesktopUpdater, downloadFileWithResume, configurePrivateGitHubBlockMaps } = require("../app-updater");
const { MacUpdater } = require("electron-updater/out/MacUpdater");
const releaseConfig = require("../electron-builder.release.cjs");
const privateTestConfig = require("../electron-builder.private-test.cjs");

function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => null;
  updater.downloadUpdate = async () => [];
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

test("keeps self-signed public update testing separate from the notarized release", () => {
  assert.deepEqual(privateTestConfig.publish, [{
    provider: "github",
    owner: "QuorraChord-A",
    repo: "SqualFlow",
  }]);
  assert.equal(privateTestConfig.mac.notarize, false);
  assert.equal(releaseConfig.mac.notarize, true);
  assert.equal(privateTestConfig.mac.entitlements, "build/entitlements.mac.private-test.plist");
  assert.equal(
    privateTestConfig.mac.entitlementsInherit,
    "build/entitlements.mac.private-test.inherit.plist",
  );
  assert.equal(releaseConfig.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(releaseConfig.mac.entitlementsInherit, "build/entitlements.mac.inherit.plist");

  const privateEntitlements = readFileSync(
    path.join(__dirname, "..", privateTestConfig.mac.entitlements),
    "utf8",
  );
  const releaseEntitlements = readFileSync(
    path.join(__dirname, "..", releaseConfig.mac.entitlements),
    "utf8",
  );
  assert.match(privateEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.doesNotMatch(releaseEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
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
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableDifferentialDownload, false);
  assert.equal(typeof scheduledCheck, "function");
  assert.equal(controller.install(), false);

  updater.emit("update-available", { version: "0.2.0", releaseNotes: "修复若干问题" });
  assert.equal(controller.getState().status, "downloading");
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

test("supports pausing, resuming, and cancelling a download", async () => {
  const updater = createUpdater();
  let token = null;
  updater.downloadUpdate = async (nextToken) => {
    token = nextToken;
    await new Promise((resolve) => nextToken.once("cancel", resolve));
    throw new (require("builder-util-runtime").CancellationError)();
  };
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
  });

  controller.initialize();
  updater.emit("update-available", { version: "0.2.0" });
  assert.equal(controller.getState().status, "downloading");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(token);
  assert.equal(controller.pause(), true);
  assert.equal(controller.getState().status, "paused");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.resume(), true);
  assert.equal(controller.cancel(), true);
  assert.equal(controller.getState().status, "available");
});

test("resumes a partial ZIP download with an HTTP range request", async () => {
  const payload = Buffer.alloc(256 * 1024, 7);
  const sha512 = createHash("sha512").update(payload).digest("base64");
  const ranges = [];
  const userAgents = [];
  let interrupted = false;
  const server = createServer((request, response) => {
    const range = request.headers.range || null;
    ranges.push(range);
    userAgents.push(request.headers["user-agent"] || null);
    const start = range ? Number(range.match(/bytes=(\d+)-/)?.[1] || 0) : 0;
    response.statusCode = range ? 206 : 200;
    response.setHeader("Content-Length", payload.length - start);
    if (range) response.setHeader("Content-Range", `bytes ${start}-${payload.length - 1}/${payload.length}`);
    response.write(payload.subarray(start, interrupted ? Math.min(start + 32 * 1024, payload.length) : payload.length));
    if (!interrupted) {
      response.end();
    } else {
      interrupted = false;
      setTimeout(() => response.destroy(), 10);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/update.zip`;
  const tempRoot = await mkdtemp(join(tmpdir(), "squadflow-update-"));
  const filePath = join(tempRoot, "update.zip");
  try {
    interrupted = true;
    await assert.rejects(downloadFileWithResume({
      url,
      filePath,
      expectedSize: payload.length,
      expectedSha512: sha512,
      cancellationToken: new (require("builder-util-runtime").CancellationToken)(),
    }));
    assert.ok((await stat(filePath)).size > 0);

    await downloadFileWithResume({
      url,
      filePath,
      expectedSize: payload.length,
      expectedSha512: sha512,
      cancellationToken: new (require("builder-util-runtime").CancellationToken)(),
    });
    assert.equal(ranges.length, 2);
    assert.match(ranges[1], /^bytes=\d+\-/);
    assert.deepEqual(userAgents, ["SquadFlow-Updater", "SquadFlow-Updater"]);
    assert.deepEqual(await readFile(filePath), payload);
  } finally {
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("uses the resumable downloader for packaged macOS updates", async () => {
  const updater = createUpdater();
  let resumableCalls = 0;
  const requestFactory = () => {};
  let receivedRequestFactory = null;
  updater.updateDownloaded = async () => {};
  updater.getOrCreateDownloadHelper = async () => ({});
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
    requestFactory,
    prepareResumableDownload: async () => ({
      fileInfo: { url: "http://127.0.0.1/update.zip", info: {} },
      fileName: "update-0.2.0.zip",
      filePath: "/tmp/update-0.2.0.zip",
      headers: {},
      helper: {},
      updateInfo: { version: "0.2.0" },
    }),
    resumableDownload: async ({ onProgress, requestFactory: nextRequestFactory }) => {
      resumableCalls += 1;
      receivedRequestFactory = nextRequestFactory;
      onProgress(42);
    },
    completeResumableDownload: async () => updater.emit("update-downloaded", { version: "0.2.0" }),
  });

  controller.initialize();
  updater.emit("update-available", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumableCalls, 1);
  assert.equal(receivedRequestFactory, requestFactory);
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().progress, 100);
});

test("keeps the absolute URL when the provider returns a URL object", async () => {
  const updater = createUpdater();
  updater.updateDownloaded = async () => {};
  updater.getOrCreateDownloadHelper = async () => ({ cacheDirForPendingUpdate: "/tmp" });
  updater.updateInfoAndProvider = {
    info: { version: "0.2.0" },
    provider: {
      resolveFiles: () => [{
        url: new URL("https://updates.example.test/SquadFlow-0.2.0-arm64-mac.zip"),
        info: { url: "SquadFlow-0.2.0-arm64-mac.zip", sha512: "", size: 1 },
      }],
    },
  };
  let preparedUrl = null;
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
    resumableDownload: async ({ url }) => {
      preparedUrl = url;
      throw new (require("builder-util-runtime").CancellationError)();
    },
  });

  controller.initialize();
  updater.emit("update-available", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparedUrl, "https://updates.example.test/SquadFlow-0.2.0-arm64-mac.zip");
});

test("falls back to update info files when a provider returns no resolved files", async () => {
  const updater = createUpdater();
  updater.updateDownloaded = async () => {};
  updater.getOrCreateDownloadHelper = async () => ({ cacheDirForPendingUpdate: "/tmp" });
  updater.updateInfoAndProvider = {
    info: {
      version: "0.2.0",
      tag: "v0.2.0",
      files: [{ url: "SquadFlow-0.2.0-arm64-mac.zip", sha512: "", size: 1 }],
    },
    provider: {
      baseUrl: new URL("https://github.com/"),
      getBaseDownloadPath: (tag, file) => `QuorraChord-A/SqualFlow/releases/download/${tag}/${file}`,
      resolveFiles: () => [],
    },
  };
  let preparedUrl = null;
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
    resumableDownload: async ({ url }) => {
      preparedUrl = url;
      throw new (require("builder-util-runtime").CancellationError)();
    },
  });

  controller.initialize();
  updater.emit("update-available", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparedUrl, "https://github.com/QuorraChord-A/SqualFlow/releases/download/v0.2.0/SquadFlow-0.2.0-arm64-mac.zip");
});

test("uses the private GitHub release asset URL when provider resolution fails", async () => {
  const updater = createUpdater();
  updater.updateDownloaded = async () => {};
  updater.getOrCreateDownloadHelper = async () => ({ cacheDirForPendingUpdate: "/tmp" });
  updater.updateInfoAndProvider = {
    info: {
      version: "0.2.0",
      files: [{ url: "SquadFlow-0.2.0-arm64-mac.zip", sha512: "", size: 1 }],
      assets: [{
        name: "SquadFlow-0.2.0-arm64-mac.zip",
        url: "https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/123",
      }],
    },
    provider: {
      baseUrl: new URL("https://api.github.com/"),
      resolveFiles: () => {
        throw new Error("private provider asset list was incomplete");
      },
    },
  };
  let preparedUrl = null;
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
    resumableDownload: async ({ url }) => {
      preparedUrl = url;
      throw new (require("builder-util-runtime").CancellationError)();
    },
  });

  controller.initialize();
  updater.emit("update-available", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparedUrl, "https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/123");
});

test("resolves private GitHub blockmaps from the matching release assets", async () => {
  const newZipUrl = "https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/201";
  const newBlockMapUrl = "https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/202";
  const oldBlockMapUrl = "https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/101";
  let releaseRequestHeaders = null;
  const provider = {
    options: { private: true, owner: "QuorraChord-A", repo: "SqualFlow" },
    baseApiUrl: new URL("https://api.github.com/"),
    fileExtraDownloadHeaders: { accept: "application/octet-stream", authorization: "token test" },
    getBlockMapFiles: () => {
      throw new Error("the inherited API-asset path must not be used");
    },
    httpRequest: async (_url, headers) => {
      releaseRequestHeaders = headers;
      return JSON.stringify({ assets: [
        { name: "SquadFlow-0.1.9-arm64-mac.zip.blockmap", url: oldBlockMapUrl },
      ] });
    },
  };
  const updater = {
    updateInfoAndProvider: {
      info: {
        assets: [
          { name: "SquadFlow-0.1.10-arm64-mac.zip", url: newZipUrl },
          { name: "SquadFlow-0.1.10-arm64-mac.zip.blockmap", url: newBlockMapUrl },
        ],
      },
      provider,
    },
  };

  await configurePrivateGitHubBlockMaps(updater);
  assert.deepEqual(
    await provider.getBlockMapFiles(new URL(newZipUrl), "0.1.9", "0.1.10"),
    [new URL(oldBlockMapUrl), new URL(newBlockMapUrl)],
  );
  assert.equal(releaseRequestHeaders.accept, "application/vnd.github.v3+json");
  assert.equal(releaseRequestHeaders.authorization, "token test");
});

test("uses native differential downloading when an update.zip cache exists", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "squadflow-differential-"));
  await writeFile(join(tempRoot, "update.zip"), "cached");
  const updater = createUpdater();
  let nativeDownloadCalls = 0;
  let helperCalls = 0;
  updater.getOrCreateDownloadHelper = async () => {
    helperCalls += 1;
    const helper = { cacheDir: tempRoot };
    updater.downloadedUpdateHelper = helper;
    return helper;
  };
  updater.downloadUpdate = async () => {
    nativeDownloadCalls += 1;
    updater.emit("update-downloaded", { version: "0.3.0" });
  };
  try {
    const controller = createDesktopUpdater({
      app: { isPackaged: true, getVersion: () => "0.2.0" },
      updater,
      logger: createLogger(),
      getWindow: () => null,
      resourcesPath: "/resources",
      existsSync: () => true,
      schedule: () => 1,
    });

    controller.initialize();
    updater.emit("update-available", { version: "0.3.0" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(helperCalls, 1);
    assert.equal(nativeDownloadCalls, 1);
    assert.equal(controller.getState().status, "ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("pauses and resumes one native differential request without restarting it", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "squadflow-differential-pause-"));
  await writeFile(join(tempRoot, "update.zip"), "cached");
  const updater = createUpdater();
  let nativeDownloadCalls = 0;
  let nativeToken = null;
  let response = null;
  let received = "";
  updater.getOrCreateDownloadHelper = async () => {
    const helper = { cacheDir: tempRoot };
    updater.downloadedUpdateHelper = helper;
    return helper;
  };
  updater.httpExecutor = {
    createRequest(_options, callback) {
      response = new PassThrough();
      setImmediate(() => callback(response));
      return new EventEmitter();
    },
  };
  updater.downloadUpdate = (token) => {
    nativeDownloadCalls += 1;
    nativeToken = token;
    return new Promise((resolve) => {
      updater.httpExecutor.createRequest({}, (incoming) => {
        incoming.on("data", (chunk) => {
          received += chunk.toString();
        });
        incoming.on("end", () => {
          updater.emit("update-downloaded", { version: "0.3.0" });
          resolve([]);
        });
      });
    });
  };
  try {
    const controller = createDesktopUpdater({
      app: { isPackaged: true, getVersion: () => "0.2.0" },
      updater,
      logger: createLogger(),
      getWindow: () => null,
      resourcesPath: "/resources",
      existsSync: () => true,
      schedule: () => 1,
    });

    controller.initialize();
    updater.emit("update-available", { version: "0.3.0" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nativeDownloadCalls, 1);
    response.write("before");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, "before");
    assert.equal(controller.pause(), true);
    assert.equal(controller.getState().status, "paused");
    assert.equal(nativeToken.cancelled, false);
    response.write("-after");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, "before");
    assert.equal(controller.resume(), true);
    assert.equal(controller.getState().status, "downloading");
    assert.equal(nativeDownloadCalls, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received, "before-after");
    response.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().status, "ready");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("falls back to a full download when a differential blockmap is invalid", async () => {
  const errors = [];
  const fallbackRequired = await MacUpdater.prototype.differentialDownloadInstaller.call({
    _testOnlyOptions: null,
    app: { version: "0.2.0" },
    downloadedUpdateHelper: { cacheDir: "/cache", cacheDirForPendingUpdate: "/pending" },
    previousBlockmapBaseUrlOverride: null,
    _logger: {
      info() {},
      warn() {},
      error(message) {
        errors.push(String(message));
      },
    },
    httpExecutor: {
      downloadToBuffer: async () => Buffer.from("not a gzip blockmap"),
    },
    listenerCount: () => 0,
  }, {
    url: new URL("https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/3"),
    info: { size: 1, sha512: "" },
  }, {
    updateInfoAndProvider: {
      info: { version: "0.3.0" },
      provider: {
        getBlockMapFiles: async () => [
          new URL("https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/1"),
          new URL("https://api.github.com/repos/QuorraChord-A/SqualFlow/releases/assets/2"),
        ],
      },
    },
    requestHeaders: {},
    cancellationToken: new (require("builder-util-runtime").CancellationToken)(),
  }, "/pending/update.zip", null, "update.zip");

  assert.equal(fallbackRequired, true);
  assert.match(errors[0], /fallback to full download/);
});

test("keeps a discovered update available when automatic downloads are disabled", async () => {
  const updater = createUpdater();
  let downloadCalls = 0;
  updater.downloadUpdate = async () => {
    downloadCalls += 1;
    return [];
  };
  const controller = createDesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    updater,
    logger: createLogger(),
    getWindow: () => null,
    resourcesPath: "/resources",
    existsSync: () => true,
    schedule: () => 1,
  });

  controller.initialize();
  controller.setAutomaticUpdates(false);
  updater.emit("update-available", { version: "0.2.0" });
  assert.equal(controller.getState().status, "available");
  assert.equal(downloadCalls, 0);
  assert.equal(controller.download(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloadCalls, 1);
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

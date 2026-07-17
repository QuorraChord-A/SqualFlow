const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  PACKAGED_APP_NAME,
  DEVELOPMENT_APP_NAME,
  DEVELOPMENT_OUTPUT_ROOT,
  configureApplicationPaths,
} = require("../desktop-paths");

test("isolates development Electron data from the installed application", () => {
  const calls = [];
  const app = {
    isPackaged: false,
    setName(name) { calls.push(["name", name]); },
    getPath(name) {
      assert.equal(name, "appData");
      return "/Users/test/Library/Application Support";
    },
    setPath(name, value) { calls.push([name, value]); },
    setAppLogsPath(value) { calls.push(["logs", value]); },
  };
  const created = [];

  const result = configureApplicationPaths({
    app,
    env: {},
    fsModule: { mkdirSync(value, options) { created.push([value, options]); } },
  });

  const expectedUserData = path.join("/Users/test/Library/Application Support", DEVELOPMENT_APP_NAME);
  assert.deepEqual(result, {
    userDataPath: expectedUserData,
    outputRoot: DEVELOPMENT_OUTPUT_ROOT,
    logsPath: path.join(DEVELOPMENT_OUTPUT_ROOT, "logs"),
    migratedFrom: [],
  });
  assert.deepEqual(calls, [
    ["name", DEVELOPMENT_APP_NAME],
    ["userData", expectedUserData],
    ["logs", path.join(DEVELOPMENT_OUTPUT_ROOT, "logs")],
  ]);
  assert.deepEqual(created, [[path.join(DEVELOPMENT_OUTPUT_ROOT, "logs"), { recursive: true }]]);
});

test("pins packaged data to SquadFlow and migrates the legacy directory", () => {
  const appDataPath = "/Users/test/Library/Application Support";
  const legacyPath = path.join(appDataPath, "squadflow-desktop");
  const expectedUserData = path.join(appDataPath, PACKAGED_APP_NAME);
  const calls = [];
  const renames = [];
  const created = [];
  const app = {
    isPackaged: true,
    setName(name) { calls.push(["name", name]); },
    getPath(name) {
      assert.equal(name, "appData");
      return appDataPath;
    },
    setPath(name, value) { calls.push([name, value]); },
    setAppLogsPath(value) { calls.push(["logs", value]); },
  };
  const result = configureApplicationPaths({
    app,
    fsModule: {
      existsSync(value) { return value === legacyPath; },
      renameSync(from, to) { renames.push([from, to]); },
      mkdirSync(value, options) { created.push([value, options]); },
    },
  });

  assert.deepEqual(result, {
    userDataPath: expectedUserData,
    outputRoot: expectedUserData,
    logsPath: path.join(expectedUserData, "logs"),
    migratedFrom: [legacyPath],
  });
  assert.deepEqual(renames, [[legacyPath, expectedUserData]]);
  assert.deepEqual(created, [[path.join(expectedUserData, "logs"), { recursive: true }]]);
  assert.deepEqual(calls, [
    ["name", PACKAGED_APP_NAME],
    ["userData", expectedUserData],
    ["logs", path.join(expectedUserData, "logs")],
  ]);
});

test("copies only missing legacy data when the packaged target already exists", () => {
  const appDataPath = "/Users/test/Library/Application Support";
  const expectedUserData = path.join(appDataPath, PACKAGED_APP_NAME);
  const legacyPaths = [
    path.join(appDataPath, "squadflow-desktop"),
    path.join(appDataPath, "@squalflow/desktop"),
  ];
  const app = {
    isPackaged: true,
    setName() {},
    getPath() { return appDataPath; },
    setPath() {},
    setAppLogsPath() {},
  };
  const renames = [];
  const copies = [];

  const result = configureApplicationPaths({
    app,
    fsModule: {
      existsSync() { return true; },
      renameSync(from, to) { renames.push([from, to]); },
      cpSync(from, to, options) { copies.push([from, to, options]); },
      mkdirSync() {},
    },
  });

  assert.deepEqual(result.migratedFrom, legacyPaths);
  assert.deepEqual(renames, []);
  assert.deepEqual(copies, legacyPaths.map((legacyPath) => [
    legacyPath,
    expectedUserData,
    { recursive: true, force: false, errorOnExist: false },
  ]));
});

test("respects an explicit packaged user-data-dir without migrating defaults", () => {
  const explicitUserData = "/tmp/squadflow-smoke-user-data";
  const paths = [];
  const app = {
    isPackaged: true,
    commandLine: { hasSwitch(name) { return name === "user-data-dir"; } },
    setName() {},
    getPath(name) {
      assert.equal(name, "userData");
      return explicitUserData;
    },
    setPath(name, value) { paths.push([name, value]); },
    setAppLogsPath() {},
  };

  const result = configureApplicationPaths({
    app,
    fsModule: {
      existsSync() { throw new Error("must not inspect default paths"); },
      renameSync() { throw new Error("must not migrate default paths"); },
      cpSync() { throw new Error("must not migrate default paths"); },
      mkdirSync() {},
    },
  });

  assert.equal(result.userDataPath, explicitUserData);
  assert.equal(result.outputRoot, explicitUserData);
  assert.deepEqual(result.migratedFrom, []);
  assert.deepEqual(paths, [["userData", explicitUserData]]);
});

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  createPackagedServiceSpecs,
  startPackagedServices,
  stopPackagedServices,
} = require("../packaged-services");

test("builds self-contained service paths and writable application data paths", () => {
  const specs = createPackagedServiceSpecs({
    appPath: "/Applications/SquadFlow.app/Contents/Resources/app.asar",
    resourcesPath: "/Applications/SquadFlow.app/Contents/Resources",
    userDataPath: "/Users/test/Library/Application Support/SquadFlow",
    ports: { backend: 38200, renderer: 38201, nextInternal: 38202 },
    platform: "darwin",
    arch: "arm64",
    baseEnv: { PATH: "/usr/bin" },
  });

  assert.equal(specs[0].modulePath, "/Applications/SquadFlow.app/Contents/Resources/app.asar/local-service/main.js");
  assert.equal(specs[1].modulePath, "/Applications/SquadFlow.app/Contents/Resources/renderer/renderer-service.cjs");
  assert.equal(specs[0].env.SQUADFLOW_OUTPUT_ROOT, "/Users/test/Library/Application Support/SquadFlow");
  assert.equal(specs[0].env.SQUADFLOW_TS_DB, "/Users/test/Library/Application Support/SquadFlow/data/squadflow.db");
  assert.equal(specs[0].env.SQUADFLOW_RUNTIME_SCRATCH_ROOT, "/Users/test/Library/Application Support/SquadFlow/runtime/scratch");
  assert.equal(
    specs[0].env.SQUADFLOW_BUNDLED_CODEX_COMMAND,
    "/Applications/SquadFlow.app/Contents/Resources/codex-runtime/darwin-arm64/codex",
  );
  assert.equal(specs[0].env.SQUADFLOW_TS_PORT, "38200");
  assert.equal(specs[1].env.NODE_ENV, "production");
  assert.equal(specs[1].env.PORT, "38202");
  assert.equal(specs[1].env.SQUADFLOW_RENDERER_PUBLIC_PORT, "38201");
  assert.equal(specs[1].env.SQUADFLOW_NEXT_INTERNAL_PORT, "38202");
  assert.equal(specs[1].env.SQUADFLOW_BACKEND_URL, "http://127.0.0.1:38200");
  assert.equal(specs[1].env.SQUADFLOW_BACKEND_WS_URL, "ws://127.0.0.1:38200");
});

test("starts both utility services and stops only the owned processes", () => {
  const calls = [];
  const children = [];
  const utilityProcess = {
    fork(modulePath, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killCalls = 0;
      child.kill = () => {
        child.killCalls += 1;
        return true;
      };
      calls.push({ modulePath, args, options });
      children.push(child);
      return child;
    },
  };
  const specs = [
    { name: "local-service", modulePath: "/app/local-service.js", cwd: "/data", env: {}, serviceName: "Local Service" },
    { name: "renderer", modulePath: "/app/renderer.js", cwd: "/data", env: {}, serviceName: "Renderer" },
  ];
  const logger = { info() {}, error() {} };

  const started = startPackagedServices({ utilityProcess, specs, logger, existsSync: () => true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.stdio, "pipe");
  assert.equal(started.length, 2);

  stopPackagedServices(started);
  assert.equal(started.length, 0);
  assert.deepEqual(children.map((child) => child.killCalls), [1, 1]);
});

test("refuses to start an incomplete packaged runtime", () => {
  assert.throws(
    () => startPackagedServices({
      utilityProcess: { fork() { throw new Error("must not start"); } },
      specs: [{ name: "local-service", modulePath: "/missing/local-service.js" }],
      logger: { info() {}, error() {} },
      existsSync: () => false,
    }),
    /Packaged local-service entry is missing/,
  );
});

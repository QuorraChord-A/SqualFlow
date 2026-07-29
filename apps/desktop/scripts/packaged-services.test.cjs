const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  createPackagedServiceSpecs,
  resolveLoginShellEnv,
  startPackagedServices,
  stopPackagedServices,
} = require("../packaged-services");

test("loads arbitrary CLI locations from the user's login shell environment", async () => {
  const baseEnv = {
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
    DESKTOP_ONLY: "preserved",
  };
  const resolved = await resolveLoginShellEnv({
    baseEnv,
    platform: "darwin",
    execFileImpl(shell, args, options, callback) {
      assert.equal(shell, "/bin/zsh");
      assert.deepEqual(args, ["-ilc", "printf '\\0'; /usr/bin/env -0"]);
      assert.equal(options.env, baseEnv);
      callback(
        null,
        "shell startup output\n\0PATH=/Users/test/.runtime/bin:/usr/bin:/bin\0ARBITRARY_MCP_HOME=/Users/test/.runtime\0",
      );
    },
  });

  assert.equal(resolved.PATH, "/Users/test/.runtime/bin:/usr/bin:/bin");
  assert.equal(resolved.ARBITRARY_MCP_HOME, "/Users/test/.runtime");
  assert.equal(resolved.DESKTOP_ONLY, "preserved");
});

test("falls back to the desktop environment when login shell discovery fails", async () => {
  const baseEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
  const resolved = await resolveLoginShellEnv({
    baseEnv,
    platform: "darwin",
    execFileImpl(_shell, _args, _options, callback) {
      callback(new Error("shell failed"), "");
    },
  });

  assert.deepEqual(resolved, baseEnv);
  assert.notEqual(resolved, baseEnv);
});

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
    specs[0].env.SQUADFLOW_BUNDLED_CLAUDE_COMMAND,
    "/Applications/SquadFlow.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
  );
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

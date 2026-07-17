const fs = require("node:fs");
const path = require("node:path");

function platformDirectory(platform, arch) {
  return `${platform === "darwin" ? "darwin" : platform}-${arch}`;
}

function claudeExecutablePath(resourcesPath, platform, arch) {
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${platformDirectory(platform, arch)}`,
    platform === "win32" ? "claude.exe" : "claude",
  );
}

function createPackagedServiceSpecs({
  appPath,
  resourcesPath,
  userDataPath,
  ports,
  platform = process.platform,
  arch = process.arch,
  baseEnv = process.env,
}) {
  const { backend: backendPort, renderer: rendererPort, nextInternal: nextInternalPort } = ports;
  const outputPath = userDataPath;
  const dataPath = path.join(userDataPath, "data");
  const rendererPath = path.join(resourcesPath, "renderer");
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const sharedEnv = {
    ...baseEnv,
    NODE_ENV: "production",
  };

  return [
    {
      name: "local-service",
      modulePath: path.join(appPath, "local-service", "main.js"),
      cwd: userDataPath,
      serviceName: "SquadFlow Local Service",
      env: {
        ...sharedEnv,
        SQUADFLOW_TS_HOST: "127.0.0.1",
        SQUADFLOW_TS_PORT: String(backendPort),
        SQUADFLOW_OUTPUT_ROOT: outputPath,
        SQUADFLOW_TS_DB: path.join(dataPath, "squadflow.db"),
        SQUADFLOW_TS_CHECKPOINT_DB: path.join(dataPath, "squadflow_checkpoints.db"),
        SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT: path.join(dataPath, "agent-runtime"),
        SQUADFLOW_RUNTIME_SCRATCH_ROOT: path.join(outputPath, "runtime", "scratch"),
        SQUADFLOW_WORKSPACE_ROOT: userDataPath,
        SQUADFLOW_DEFAULT_PROJECT_ROOT: path.join(userDataPath, "workspace"),
        SQUADFLOW_CLAUDE_SETTINGS: path.join(userDataPath, "settings", "claude.json"),
        SQUADFLOW_BUNDLED_CLAUDE_COMMAND: claudeExecutablePath(resourcesPath, platform, arch),
        SQUADFLOW_BUNDLED_CODEX_COMMAND: path.join(
          resourcesPath,
          "codex-runtime",
          platformDirectory(platform, arch),
          platform === "win32" ? "codex.exe" : "codex",
        ),
        SQUADFLOW_CODEX_HOME: path.join(userDataPath, "codex-runtime", "0.120.0"),
      },
    },
    {
      name: "renderer",
      modulePath: path.join(rendererPath, "renderer-service.cjs"),
      cwd: rendererPath,
      serviceName: "SquadFlow Renderer",
      env: {
        ...sharedEnv,
        HOSTNAME: "127.0.0.1",
        PORT: String(nextInternalPort),
        SQUADFLOW_RENDERER_PUBLIC_PORT: String(rendererPort),
        SQUADFLOW_NEXT_INTERNAL_PORT: String(nextInternalPort),
        SQUADFLOW_BACKEND_IMPL: "ts",
        SQUADFLOW_BACKEND_URL: backendUrl,
        SQUADFLOW_BACKEND_WS_URL: `ws://127.0.0.1:${backendPort}`,
      },
    },
  ];
}

function forwardOutput(stream, logger, level, name) {
  stream?.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    if (message) logger[level](`[${name}] ${message}`);
  });
}

function startPackagedServices({ utilityProcess, specs, logger, existsSync = fs.existsSync }) {
  const missing = specs.find((spec) => !existsSync(spec.modulePath));
  if (missing) throw new Error(`Packaged ${missing.name} entry is missing: ${missing.modulePath}`);

  return specs.map((spec) => {
    const child = utilityProcess.fork(spec.modulePath, [], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "pipe",
      serviceName: spec.serviceName,
    });
    forwardOutput(child.stdout, logger, "info", spec.name);
    forwardOutput(child.stderr, logger, "error", spec.name);
    child.on("exit", (code) => logger.info(`Packaged ${spec.name} service exited`, { code }));
    child.on("error", (error) => logger.error(`Packaged ${spec.name} service failed`, error));
    return child;
  });
}

function stopPackagedServices(children) {
  for (const child of children.splice(0)) child.kill();
}

module.exports = {
  createPackagedServiceSpecs,
  startPackagedServices,
  stopPackagedServices,
};

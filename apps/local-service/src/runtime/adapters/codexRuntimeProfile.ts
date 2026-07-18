import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";

export type CodexMcpApprovalProtocol = "decision" | "elicitation-action";

export type CodexRuntimeProfileId = "bundled-legacy-flat-mcp" | "external-modern";

export type CodexRuntimeProfile = {
  id: CodexRuntimeProfileId;
  command: string;
  appServerArgsMode: "listen-stdio" | "stdio-flag";
  codexHome?: string;
  mcpApprovalProtocol: CodexMcpApprovalProtocol;
};

export const bundledLegacyCodexVersion = "0.120.0";

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function externalCodexCandidates(env: NodeJS.ProcessEnv): string[] {
  const pathCandidates = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
  const applicationCandidates = process.platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        "/Applications/Codex.app/Contents/Resources/codex",
        path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
      ]
    : [];
  return [...pathCandidates, ...applicationCandidates];
}

export function resolveExternalCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  candidates: string[] = externalCodexCandidates(env),
): string {
  const explicit = env.SQUADFLOW_EXTERNAL_CODEX_COMMAND?.trim() || env.SQUADFLOW_CODEX_COMMAND?.trim();
  if (explicit) return explicit;
  const resolved = candidates.find(isExecutable);
  if (resolved) return resolved;
  throw new Error(
    "Codex CLI executable not found. Install Codex or ChatGPT for desktop, or set SQUADFLOW_EXTERNAL_CODEX_COMMAND to an absolute executable path.",
  );
}

export function resolveCodexRuntimeProfile(
  env: NodeJS.ProcessEnv = process.env,
  options: { preferExternal?: boolean; externalCandidates?: string[] } = {},
): CodexRuntimeProfile {
  const mode = env.SQUADFLOW_CODEX_RUNTIME_MODE?.trim();
  if (options.preferExternal || mode === "external-modern" || mode === "external") {
    return {
      id: "external-modern",
      command: resolveExternalCodexCommand(env, options.externalCandidates),
      appServerArgsMode: "stdio-flag",
      mcpApprovalProtocol: "elicitation-action",
    };
  }

  return {
    id: "bundled-legacy-flat-mcp",
    command: bundledCodexCommand(env),
    appServerArgsMode: "listen-stdio",
    codexHome: bundledCodexHome(env),
    mcpApprovalProtocol: "elicitation-action",
  };
}

export function codexAppServerBaseArgs(profile: CodexRuntimeProfile): string[] {
  const args = profile.appServerArgsMode === "listen-stdio"
    ? ["app-server", "--listen", "stdio://"]
    : ["app-server", "--stdio"];
  return [...args, "--disable", "image_generation"];
}

export function withCodexRuntimeProfileEnv(
  env: NodeJS.ProcessEnv,
  profile: CodexRuntimeProfile,
): NodeJS.ProcessEnv {
  if (!profile.codexHome) return env;
  fs.mkdirSync(profile.codexHome, { recursive: true });
  return {
    ...env,
    CODEX_HOME: profile.codexHome,
  };
}

export function codexPoolTempDir(kind: "official" | "custom") {
  return path.join(config.runtimeScratchRoot, "codex-pool", kind);
}

function bundledCodexCommand(env: NodeJS.ProcessEnv): string {
  const explicit = env.SQUADFLOW_BUNDLED_CODEX_COMMAND?.trim() || env.SQUADFLOW_CODEX_COMMAND?.trim();
  if (explicit) return explicit;

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) return path.join(resourcesPath, "codex-runtime", platformDirectory(), "codex");

  return path.join(config.workspaceRoot, "apps", "desktop", "resources", "codex-runtime", platformDirectory(), "codex");
}

function bundledCodexHome(env: NodeJS.ProcessEnv): string {
  const explicit = env.SQUADFLOW_CODEX_HOME?.trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), "Library", "Application Support", "SquadFlow", "codex-runtime", bundledLegacyCodexVersion);
}

function platformDirectory(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  return `${platform}-${process.arch}`;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledLegacyCodexVersion } from "../runtime/adapters/codexRuntimeProfile.js";

export type NativeRuntimeSessionRef = {
  runtimeSdk: string | null;
  sessionId: string;
};

type NativeSessionCleanupOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function childDirectories(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function removeMatchingFiles(root: string, matches: (fileName: string) => boolean): string[] {
  const removed: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile() && matches(entry.name)) {
        fs.rmSync(target, { force: true });
        removed.push(target);
      }
    }
  }
  return removed;
}

function codexHomes(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const homes = [
    env.CODEX_HOME?.trim(),
    env.SQUADFLOW_CODEX_HOME?.trim(),
    path.join(homeDir, ".codex"),
    path.join(homeDir, "Library", "Application Support", "SquadFlow", "codex-runtime", bundledLegacyCodexVersion),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(homes.map((value) => path.resolve(value)))];
}

export function clearNativeRuntimeSessionFiles(
  sessions: NativeRuntimeSessionRef[],
  options: NativeSessionCleanupOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const claudeIds = new Set(sessions
    .filter((session) => session.runtimeSdk !== "codex")
    .map((session) => session.sessionId));
  const codexIds = new Set(sessions
    .filter((session) => session.runtimeSdk !== "claudecode")
    .map((session) => session.sessionId));
  const removed: string[] = [];

  if (claudeIds.size > 0) {
    const claudeRoot = path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude"), "projects");
    for (const projectRoot of childDirectories(claudeRoot)) {
      removed.push(...removeMatchingFiles(projectRoot, (fileName) => (
        fileName.endsWith(".jsonl") && claudeIds.has(fileName.slice(0, -".jsonl".length))
      )));
    }
  }

  if (codexIds.size > 0) {
    for (const codexHome of codexHomes(env, homeDir)) {
      for (const sessionsRoot of [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) {
        removed.push(...removeMatchingFiles(sessionsRoot, (fileName) => (
          fileName.endsWith(".jsonl")
          && [...codexIds].some((sessionId) => fileName.endsWith(`-${sessionId}.jsonl`))
        )));
      }
    }
  }

  return removed;
}

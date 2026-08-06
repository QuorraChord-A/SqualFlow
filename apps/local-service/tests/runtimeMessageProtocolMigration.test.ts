import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { clearNativeRuntimeSessionFiles } from "../src/protocol/runtimeMessageProtocolMigration.js";

describe("runtime message protocol v2 data migration", () => {
  it("clears pre-v2 Flow data once and preserves data created afterward", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-protocol-v2-migration-"));
    const databasePath = path.join(root, "squadflow.db");

    try {
      const legacy = createStore(databasePath);
      legacy.migrate();
      const project = legacy.createProject({ id: "project-1", name: "Project", localPath: root });
      legacy.createFlow({ id: "legacy-flow", name: "Legacy", projectId: project.id });
      legacy.createAgentSession({
        flowId: "legacy-flow",
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId: "legacy-sdk-session",
        displayName: "Leader",
      });
      legacy.sqlite.prepare("DELETE FROM app_metadata WHERE key = ?").run("runtime_message_protocol_version");
      legacy.sqlite.close();

      const migrated = createStore(databasePath);
      const cleanup = [] as Array<Array<{ runtimeSdk: string | null; sessionId: string }>>;
      migrated.migrate({ beforeRuntimeMessageProtocolReset: (sessions) => cleanup.push(sessions) });
      expect(cleanup).toEqual([[{ runtimeSdk: null, sessionId: "legacy-sdk-session" }]]);
      expect(migrated.getFlow("legacy-flow")).toBeUndefined();
      migrated.createFlow({ id: "v2-flow", name: "V2", projectId: project.id });
      migrated.sqlite.close();

      const reopened = createStore(databasePath);
      reopened.migrate();
      expect(reopened.getFlow("v2-flow")).toEqual(expect.objectContaining({ id: "v2-flow" }));
      reopened.sqlite.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes only referenced Claude and Codex native session files", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-native-session-cleanup-"));
    const claudeProject = path.join(homeDir, "claude", "projects", "project-a");
    const externalCodex = path.join(homeDir, "external-codex", "sessions", "2026", "07", "14");
    const bundledCodexHome = path.join(homeDir, "bundled-codex");
    const bundledCodex = path.join(bundledCodexHome, "archived_sessions");
    fs.mkdirSync(claudeProject, { recursive: true });
    fs.mkdirSync(externalCodex, { recursive: true });
    fs.mkdirSync(bundledCodex, { recursive: true });
    const claudeSession = path.join(claudeProject, "claude-session.jsonl");
    const codexSession = path.join(externalCodex, "rollout-codex-session.jsonl");
    const unknownSession = path.join(bundledCodex, "rollout-unknown-session.jsonl");
    const unrelated = path.join(claudeProject, "unrelated.jsonl");
    for (const filePath of [claudeSession, codexSession, unknownSession, unrelated]) {
      fs.writeFileSync(filePath, "history\n");
    }

    try {
      const removed = clearNativeRuntimeSessionFiles([
        { runtimeSdk: "claudecode", sessionId: "claude-session" },
        { runtimeSdk: "codex", sessionId: "codex-session" },
        { runtimeSdk: null, sessionId: "unknown-session" },
      ], {
        homeDir,
        env: {
          CLAUDE_CONFIG_DIR: path.join(homeDir, "claude"),
          CODEX_HOME: path.join(homeDir, "external-codex"),
          SQUADFLOW_CODEX_HOME: bundledCodexHome,
        },
      });

      expect(new Set(removed)).toEqual(new Set([claudeSession, codexSession, unknownSession]));
      expect(fs.existsSync(claudeSession)).toBe(false);
      expect(fs.existsSync(codexSession)).toBe(false);
      expect(fs.existsSync(unknownSession)).toBe(false);
      expect(fs.readFileSync(unrelated, "utf8")).toBe("history\n");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

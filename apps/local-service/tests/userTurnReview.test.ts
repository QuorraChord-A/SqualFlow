import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import {
  beginControlledEditReview,
  clearUserTurnReview,
  consumeControlledEditToolResults,
  finalizeUserTurnReview,
  latestUserTurnReview,
} from "../src/domain/userTurnReview.js";

const flowId = "flow-review-test";
let databaseDir: string;
let databasePath: string;
let store: ReturnType<typeof createStore>;

function toolResult(toolUseId: string, isError = false) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }],
    },
  };
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-review-"));
}

beforeEach(() => {
  databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-review-db-"));
  databasePath = path.join(databaseDir, "squadflow.db");
  store = createStore(databasePath);
  store.migrate();
});

afterEach(() => {
  clearUserTurnReview(flowId, store);
  store.sqlite.close();
  fs.rmSync(databaseDir, { recursive: true, force: true });
});

describe("userTurnReview", () => {
  it("aggregates Write then Edit into one final per-file review", () => {
    const root = tempProject();
    const target = path.join(root, "probe.txt");

    beginControlledEditReview({
      flowId,
      userTurnId: "utn-1",
      rootPath: root,
      toolName: "Write",
      capability: "write",
      toolInput: { path: "probe.txt" },
      toolUseId: "tool-write",
    });
    fs.writeFileSync(target, "alpha\nbeta\n", "utf8");
    consumeControlledEditToolResults(toolResult("tool-write"));

    beginControlledEditReview({
      flowId,
      userTurnId: "utn-1",
      rootPath: root,
      toolName: "Edit",
      capability: "edit",
      toolInput: { path: "probe.txt" },
      toolUseId: "tool-edit",
    });
    fs.writeFileSync(target, "alpha\ngamma\n", "utf8");
    consumeControlledEditToolResults(toolResult("tool-edit"));

    const review = finalizeUserTurnReview(store, flowId, "utn-1", "2026-06-14T01:00:00.000Z");

    expect(review?.totals).toMatchObject({ files: 1, additions: 2, deletions: 0, added: 1 });
    expect(review?.files[0]).toMatchObject({
      path: "probe.txt",
      status: "added",
      additions: 2,
      deletions: 0,
    });
    expect(latestUserTurnReview(store, flowId)?.user_turn_id).toBe("utn-1");
  });

  it("ignores non-controlled tools and paths outside the root", () => {
    const root = tempProject();

    beginControlledEditReview({
      flowId,
      userTurnId: "utn-2",
      rootPath: root,
      toolName: "Bash",
      capability: "shell",
      toolInput: { path: "probe.txt" },
      toolUseId: "tool-bash",
    });
    beginControlledEditReview({
      flowId,
      userTurnId: "utn-2",
      rootPath: root,
      toolName: "Write",
      capability: "write",
      toolInput: { path: "../outside.txt" },
      toolUseId: "tool-outside",
    });
    consumeControlledEditToolResults(toolResult("tool-bash"));
    consumeControlledEditToolResults(toolResult("tool-outside"));

    expect(finalizeUserTurnReview(store, flowId, "utn-2", null)).toBeNull();
    expect(latestUserTurnReview(store, flowId)).toBeNull();
  });

  it("clears the latest review when the latest completed turn has no controlled edits", () => {
    const root = tempProject();
    const target = path.join(root, "probe.txt");
    beginControlledEditReview({
      flowId,
      userTurnId: "utn-3",
      rootPath: root,
      toolName: "Write",
      capability: "write",
      toolInput: { path: "probe.txt" },
      toolUseId: "tool-write",
    });
    fs.writeFileSync(target, "alpha\n", "utf8");
    consumeControlledEditToolResults(toolResult("tool-write"));
    expect(finalizeUserTurnReview(store, flowId, "utn-3", null)).not.toBeNull();

    expect(finalizeUserTurnReview(store, flowId, "utn-4", null)).toBeNull();
    expect(latestUserTurnReview(store, flowId)).toBeNull();
  });

  it("restores the latest review after reopening the database", () => {
    const root = tempProject();
    const target = path.join(root, "probe.txt");
    beginControlledEditReview({
      flowId,
      userTurnId: "utn-restart",
      rootPath: root,
      toolName: "Write",
      capability: "write",
      toolInput: { path: "probe.txt" },
      toolUseId: "tool-restart",
    });
    fs.writeFileSync(target, "persisted\n", "utf8");
    consumeControlledEditToolResults(toolResult("tool-restart"));
    finalizeUserTurnReview(store, flowId, "utn-restart", "2026-07-21T12:00:00.000Z");

    store.sqlite.close();
    store = createStore(databasePath);
    store.migrate();

    expect(latestUserTurnReview(store, flowId)).toMatchObject({
      flow_id: flowId,
      user_turn_id: "utn-restart",
      completed_at: "2026-07-21T12:00:00.000Z",
      totals: { files: 1, additions: 1, deletions: 0 },
    });
  });
});

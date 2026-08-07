import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import {
  cleanupPreparedWorkRunReview,
  getWorkRunReview,
  listWorkRunReviews,
  prepareWorkRunReview,
} from "../src/domain/workRunReview.js";
import { capturePersistentChangeBaseline } from "../src/runtime/changeBaseline.js";
import { finalizeWorkRun } from "../src/domain/workRun.js";
import { EventBus } from "../src/ws/eventBus.js";
import { ChatJournal } from "../src/ws/chatJournal.js";

let databaseDir: string;
let databasePath: string;
let scratchRoot: string;
let store: ReturnType<typeof createStore>;
let projectRoots: string[];
const originalScratchRoot = config.runtimeScratchRoot;

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-review-project-"));
  projectRoots.push(root);
  return root;
}

function persistPrepared(prepared: ReturnType<typeof prepareWorkRunReview>) {
  const turn = store.getWorkRun(prepared.review.work_run_id);
  if (!turn) throw new Error("Expected an executing WorkRun for Review persistence");
  store.finalizeWorkRunWithReview({
    workRunId: turn.id,
    expectedRevision: turn.revision,
    terminalStatus: "completed",
    timestamp: prepared.review.completed_at ?? new Date().toISOString(),
    reviewStatus: prepared.review.status,
    reviewJson: JSON.stringify(prepared.review),
  });
  cleanupPreparedWorkRunReview(store, prepared);
}

function createReviewWorkRun(flowId: string, root: string) {
  const project = store.createProject({ name: flowId, localPath: root });
  const flow = store.createFlow({ id: flowId, name: flowId, description: "", projectId: project.id });
  const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: `msg-${flowId}` })!;
  store.startWorkRunWork({
    flowId: flow.id,
    workRunId: turn.id,
    workSource: "direct_message",
    targetProjectId: project.id,
    inputSnapshotJson: "{}",
  });
  store.startWorkRunExecution(turn.id);
  return store.getWorkRun(turn.id)!;
}

function recordTouchedFiles(
  turn: ReturnType<typeof createReviewWorkRun>,
  agentSessionId: string,
  paths: string[],
) {
  store.recordWorkRunFileAttribution({
    flowId: turn.flowId,
    workRunId: turn.id,
    agentSessionId,
    files: paths.map((relativePath) => ({ path: relativePath, source: "write" as const })),
  });
}

beforeEach(() => {
  databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-review-db-"));
  databasePath = path.join(databaseDir, "squadflow.db");
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-review-scratch-"));
  config.runtimeScratchRoot = scratchRoot;
  projectRoots = [];
  store = createStore(databasePath);
  store.migrate();
});

afterEach(() => {
  store.sqlite.close();
  config.runtimeScratchRoot = originalScratchRoot;
  fs.rmSync(databaseDir, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  for (const root of projectRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("workRunReview", () => {
  it("builds the authoritative review from baseline to terminal workspace", () => {
    const root = tempProject();
    const turn = createReviewWorkRun("flow-review", root);
    fs.writeFileSync(path.join(root, "probe.txt"), "alpha\nbeta\n", "utf8");
    capturePersistentChangeBaseline({
      store,
      flowId: "flow-review",
      sourceAgentSessionId: "ags-review",
      workRunId: turn.id,
      rootPath: root,
    });

    fs.writeFileSync(path.join(root, "probe.txt"), "alpha\ngamma\n", "utf8");
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    recordTouchedFiles(turn, "ags-review", ["probe.txt", "binary.bin"]);
    const prepared = prepareWorkRunReview(
      store,
      "flow-review",
      turn.id,
      "2026-08-06T00:00:00.000Z",
    );

    expect(prepared.review.status).toBe("ready");
    expect(prepared.review.totals).toMatchObject({ files: 2, additions: 1, deletions: 1, modified: 1, added: 1 });
    expect(prepared.review.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "probe.txt",
        status: "modified",
        detail_status: "ready",
        additions: 1,
        deletions: 1,
      }),
      expect.objectContaining({
        path: "binary.bin",
        status: "added",
        detail_status: "binary",
        additions: null,
        deletions: null,
      }),
    ]));
    persistPrepared(prepared);
    expect(store.getChangeBaselineForWorkRun(turn.id)).toBeUndefined();
  });

  it("persists an explicit empty review when the workspace did not change", () => {
    const root = tempProject();
    const turn = createReviewWorkRun("flow-empty", root);
    fs.writeFileSync(path.join(root, "unchanged.txt"), "same\n", "utf8");
    capturePersistentChangeBaseline({
      store,
      flowId: "flow-empty",
      sourceAgentSessionId: "ags-empty",
      workRunId: turn.id,
      rootPath: root,
    });

    const prepared = prepareWorkRunReview(store, "flow-empty", turn.id, null);
    expect(prepared.review).toMatchObject({ status: "empty", totals: { files: 0 }, files: [] });
    persistPrepared(prepared);
    expect(getWorkRunReview(store, turn.id)?.status).toBe("empty");
  });

  it("keeps concurrent Flow reviews isolated by WorkRun-owned files", () => {
    const root = tempProject();
    const project = store.createProject({ name: "shared-project", localPath: root });
    const createTurn = (flowId: string, agentSessionId: string) => {
      const flow = store.createFlow({ id: flowId, name: flowId, description: "", projectId: project.id });
      const created = store.createWorkRun({ flowId, triggerMessageId: `msg-${flowId}` })!;
      store.startWorkRunWork({
        flowId,
        workRunId: created.id,
        workSource: "direct_message",
        targetProjectId: project.id,
        inputSnapshotJson: "{}",
      });
      store.startWorkRunExecution(created.id);
      capturePersistentChangeBaseline({
        store,
        flowId,
        sourceAgentSessionId: agentSessionId,
        workRunId: created.id,
        rootPath: root,
      });
      return store.getWorkRun(created.id)!;
    };
    const flowA = createTurn("flow-concurrent-a", "ags-concurrent-a");
    const flowB = createTurn("flow-concurrent-b", "ags-concurrent-b");

    fs.writeFileSync(path.join(root, "a.md"), "A only\n", "utf8");
    fs.writeFileSync(path.join(root, "b.md"), "B only\n", "utf8");
    fs.writeFileSync(path.join(root, "shared.md"), "A and B both touched this file\n", "utf8");
    recordTouchedFiles(flowA, "ags-concurrent-a", ["a.md", "shared.md"]);
    recordTouchedFiles(flowB, "ags-concurrent-b", ["b.md", "shared.md"]);

    const reviewA = prepareWorkRunReview(store, flowA.flowId, flowA.id, null).review;
    const reviewB = prepareWorkRunReview(store, flowB.flowId, flowB.id, null).review;

    expect(reviewA.files.map((file) => file.path)).toEqual(["a.md", "shared.md"]);
    expect(reviewB.files.map((file) => file.path)).toEqual(["b.md", "shared.md"]);
    expect(reviewA.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "b.md" })]));
    expect(reviewB.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "a.md" })]));
    expect(reviewA.reason).toContain("1 个不属于本 WorkRun");
    expect(reviewB.reason).toContain("1 个不属于本 WorkRun");
  });

  it("does not count initial Git dirty or untracked files unless they change again", () => {
    const root = tempProject();
    execFileSync("git", ["-C", root, "init"]);
    execFileSync("git", ["-C", root, "config", "user.email", "review@example.test"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Review Test"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "committed\n", "utf8");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-m", "baseline"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty before WorkRun\n", "utf8");
    fs.writeFileSync(path.join(root, "already-untracked.txt"), "present before WorkRun\n", "utf8");

    const turn = createReviewWorkRun("flow-git", root);
    capturePersistentChangeBaseline({
      store,
      flowId: "flow-git",
      sourceAgentSessionId: "ags-git",
      workRunId: turn.id,
      rootPath: root,
    });
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed during WorkRun\n", "utf8");
    fs.writeFileSync(path.join(root, "new-during-workrun.txt"), "new\n", "utf8");
    recordTouchedFiles(turn, "ags-git", ["tracked.txt", "new-during-workrun.txt"]);

    const review = prepareWorkRunReview(store, "flow-git", turn.id, null).review;
    expect(review.files.map((file) => file.path)).toEqual([
      "new-during-workrun.txt",
      "tracked.txt",
    ]);
    expect(review.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "already-untracked.txt" }),
    ]));
  });

  it("keeps one durable review per WorkRun and restores history after restart", () => {
    const root = tempProject();
    const project = store.createProject({ name: "history", localPath: root });
    const flow = store.createFlow({ id: "flow-history", name: "history", description: "", projectId: project.id });
    const workRunIds: string[] = [];
    for (const suffix of ["one", "two"]) {
      const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: `msg-${suffix}` })!;
      store.startWorkRunWork({
        flowId: flow.id,
        workRunId: turn.id,
        workSource: "direct_message",
        targetProjectId: project.id,
        inputSnapshotJson: "{}",
      });
      store.startWorkRunExecution(turn.id);
      workRunIds.push(turn.id);
      capturePersistentChangeBaseline({
        store,
        flowId: "flow-history",
        sourceAgentSessionId: `ags-${suffix}`,
        workRunId: turn.id,
        rootPath: root,
      });
      fs.writeFileSync(path.join(root, `${suffix}.txt`), `${suffix}\n`, "utf8");
      recordTouchedFiles(store.getWorkRun(turn.id)!, `ags-${suffix}`, [`${suffix}.txt`]);
      persistPrepared(prepareWorkRunReview(
        store,
        "flow-history",
        turn.id,
        `2026-08-06T00:00:0${suffix === "one" ? "1" : "2"}.000Z`,
      ));
    }

    store.sqlite.close();
    store = createStore(databasePath);
    store.migrate();

    expect(listWorkRunReviews(store, "flow-history").map((review) => review.work_run_id)).toEqual([
      ...workRunIds,
    ]);
  });

  it("records baseline capture failures as failed reviews instead of empty", () => {
    store.createChangeBaseline({
      flowId: "flow-failed",
      sourceAgentSessionId: "ags-failed",
      workRunId: "wrun-failed",
      rootPath: "/missing",
      snapshotPath: path.join(scratchRoot, "missing"),
      manifestJson: "{}",
      status: "failed",
      errorMessage: "disk unavailable",
    });

    const prepared = prepareWorkRunReview(store, "flow-failed", "wrun-failed", null);
    expect(prepared.review).toMatchObject({ status: "failed", reason: "disk unavailable" });
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "persists Review and %s WorkRun terminal state together",
    async (terminalStatus) => {
      const root = tempProject();
      const project = store.createProject({ name: terminalStatus, localPath: root });
      const flow = store.createFlow({
        name: terminalStatus,
        description: "",
        projectId: project.id,
      });
      const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: `msg-${terminalStatus}` })!;
      store.startWorkRunWork({
        flowId: flow.id,
        workRunId: turn.id,
        workSource: "direct_message",
        targetProjectId: project.id,
        inputSnapshotJson: "{}",
      });
      store.startWorkRunExecution(turn.id);
      capturePersistentChangeBaseline({
        store,
        flowId: flow.id,
        sourceAgentSessionId: `ags-${terminalStatus}`,
        workRunId: turn.id,
        rootPath: root,
      });
      fs.writeFileSync(path.join(root, `${terminalStatus}.txt`), `${terminalStatus}\n`, "utf8");
      recordTouchedFiles(store.getWorkRun(turn.id)!, `ags-${terminalStatus}`, [`${terminalStatus}.txt`]);

      await finalizeWorkRun({
        store,
        eventBus: new EventBus(),
        workRunId: turn.id,
        terminalStatus,
      });

      expect(store.getWorkRun(turn.id)?.status).toBe(terminalStatus);
      expect(getWorkRunReview(store, turn.id)).toMatchObject({
        status: "ready",
        work_run_id: turn.id,
      });
    },
  );

  it("publishes an atomically anchored terminal Timeline message when no assistant reply exists", async () => {
    const root = tempProject();
    const turn = createReviewWorkRun("flow-terminal-anchor", root);
    capturePersistentChangeBaseline({
      store,
      flowId: turn.flowId,
      sourceAgentSessionId: "ags-terminal",
      workRunId: turn.id,
      rootPath: root,
    });
    fs.writeFileSync(path.join(root, "terminal.txt"), "done\n", "utf8");
    recordTouchedFiles(turn, "ags-terminal", ["terminal.txt"]);
    const eventBus = new EventBus();
    const chatJournal = new ChatJournal(store);
    const received: unknown[] = [];
    eventBus.subscribe(turn.flowId, "test-client", (message) => received.push(message));

    await finalizeWorkRun({
      store,
      eventBus,
      chatJournal,
      workRunId: turn.id,
      terminalStatus: "completed",
    });

    const review = getWorkRunReview(store, turn.id)!;
    expect(review.anchor_message_id).toBe(`msg-work-run-terminal-${turn.id}`);
    expect(received[0]).toEqual(expect.objectContaining({
      type: "session:transcript_event",
      flow_id: turn.flowId,
      session_id: `leader:${turn.flowId}`,
      data: expect.objectContaining({
        timeline_items: [expect.objectContaining({
          id: review.anchor_message_id,
          message_kind: "work-run-terminal",
          work_run_id: turn.id,
        })],
        event: expect.objectContaining({ type: "message-added" }),
      }),
    }));
    expect(received[1]).toEqual(expect.objectContaining({ type: "work_run:event" }));
  });
});

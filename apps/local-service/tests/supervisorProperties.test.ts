import { afterEach, describe, expect, it } from "vitest";
import { createStore, type CanonicalTimelineItem, type Store } from "../src/db/store.js";
import {
  AGENT_RUN_STATUSES,
  TASK_STATUSES,
  TOOL_CALL_STATUSES,
  canTransitionAgentRun,
  canTransitionTask,
  canTransitionToolCall,
} from "../src/domain/supervisor.js";
import { buildFlowSnapshot } from "../src/domain/flowSnapshot.js";
import { ChatJournal } from "../src/ws/chatJournal.js";

const stores: Store[] = [];

function fixture() {
  const store = createStore(":memory:");
  stores.push(store);
  store.migrate();
  const project = store.createProject({ name: "性质测试", localPath: "/tmp" });
  const flow = store.createFlow({ projectId: project.id, name: "Supervisor 性质" })!;
  const leader = store.getLeaderAgentSession(flow.id)!;
  return { store, flow, leader };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

describe("Supervisor invariants as properties", () => {
  it("keeps every terminal state terminal for all domain status pairs", () => {
    for (const from of AGENT_RUN_STATUSES) {
      for (const to of AGENT_RUN_STATUSES) {
        if (["completed", "failed", "cancelled", "interrupted"].includes(from)) {
          expect(canTransitionAgentRun(from, to)).toBe(to === from);
        }
      }
    }
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (["completed", "failed", "cancelled"].includes(from)) {
          expect(canTransitionTask(from, to)).toBe(to === from);
        }
      }
    }
    for (const from of TOOL_CALL_STATUSES) {
      for (const to of TOOL_CALL_STATUSES) {
        if (["completed", "failed", "cancelled"].includes(from)) {
          expect(canTransitionToolCall(from, to)).toBe(to === from);
        }
      }
    }
  });

  it("keeps duplicate submissions idempotent and Run terminals independent from Task state", () => {
    const terminalRuns = ["completed", "failed", "cancelled", "interrupted"] as const;
    for (const [index, terminal] of terminalRuns.entries()) {
      const { store, flow, leader } = fixture();
      const submission = store.acceptSubmission({
        flowId: flow.id,
        clientMessageId: `message-${index}`,
        submissionType: "normal",
        payloadHash: "same",
        payload: { content: "同一消息" },
      });
      const duplicate = store.acceptSubmission({
        flowId: flow.id,
        clientMessageId: `message-${index}`,
        submissionType: "normal",
        payloadHash: "same",
        payload: { content: "同一消息" },
      });
      expect(duplicate.outcome).toBe("duplicate");
      expect(duplicate.submission.clientMessageId).toBe(submission.submission.clientMessageId);

      const run = store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id, status: "running" })!;
      const task = store.createTask({
        flowId: flow.id,
        title: "显式业务状态",
        description: "Run 结果不能推导 Task",
        createdByAgentRunId: run.id,
      })!;
      store.updateAgentRunStatus(run.id, terminal);
      expect(store.getTask(task.id)?.status).toBe("pending");
    }
  });

  it("makes snapshot plus committed increments equal the latest Canonical Timeline database state", () => {
    const { store, flow, leader } = fixture();
    const run = store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id, status: "running" })!;
    const journal = new ChatJournal(store, "property-stream");
    const projection = new Map<string, CanonicalTimelineItem>();
    const apply = (result: { timelineItems: CanonicalTimelineItem[]; removedMessageIds?: string[] }) => {
      for (const id of result.removedMessageIds ?? []) projection.delete(id);
      for (const item of result.timelineItems) projection.set(item.itemId, item);
    };

    apply(journal.recordUserMessage(flow.id, leader.id, "请解释配置加载", "message-user", undefined, leader.id, undefined, run.id));
    for (const event of [
      { type: "start", messageId: "message-assistant", startedAt: "2026-01-01T00:00:00.000Z" },
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", delta: "先读取配置。" },
      { type: "reasoning-end", id: "reason-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "配置从项目目录加载。" },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000 },
    ]) apply(journal.record(flow.id, leader.id, event, leader.id, run.id));

    const projected = [...projection.values()].sort((left, right) => left.position - right.position);
    expect(projected).toEqual(store.listTimelineItems(flow.id, leader.id));
    const snapshot = buildFlowSnapshot(store, flow.id) as Record<string, unknown>;
    expect(snapshot.latest_leader_agent_run_id).toBe(run.id);
  });
});

import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginWorkRun, createWorkingWorkRun } from "./helpers/workRunTestHelpers.js";
import { createApp } from "../src/server/app.js";
import { ChatJournal } from "../src/ws/chatJournal.js";

const wsBuffers = new WeakMap<any, unknown[]>();
const wsWaiters = new WeakMap<any, Array<(message: unknown) => void>>();
function ensureWsBuffer(ws: any): void {
  if (wsBuffers.has(ws)) return;
  wsBuffers.set(ws, []);
  wsWaiters.set(ws, []);
  ws.on("message", (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as unknown;
    const waiter = (wsWaiters.get(ws) ?? []).shift();
    if (waiter) return waiter(message);
    wsBuffers.get(ws)?.push(message);
  });
}
function nextWsMessage(ws: any): Promise<any> {
  ensureWsBuffer(ws);
  const buffered = wsBuffers.get(ws)?.shift();
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve) => wsWaiters.get(ws)?.push(resolve));
}

// Reproduces the window where Claude history has not yet persisted the text
// following StructuredOutput. The completed snapshot must wait for complete
// SDK history instead of replacing it with the in-memory journal.
function recordCompleteTurn(journal: ChatJournal, flowId: string, sessionId: string, flowExpertId: string) {
  const messageId = "msg-assistant-live-1";
  journal.recordUserMessage(flowId, sessionId, "调查这个项目", "msg-user-live-1", "2026-06-24T11:17:55.000Z", flowExpertId);
  journal.record(flowId, sessionId, { type: "start", messageId, startedAt: "2026-06-24T11:17:56.000Z" }, flowExpertId);
  journal.record(flowId, sessionId, { type: "tool-input-start", messageId, toolCallId: "call-structured", toolName: "StructuredOutput" }, flowExpertId);
  journal.record(flowId, sessionId, { type: "tool-input-available", messageId, toolCallId: "call-structured", toolName: "StructuredOutput", input: { status: "success" } }, flowExpertId);
  journal.record(flowId, sessionId, { type: "tool-output-available", messageId, toolCallId: "call-structured", output: { content: "Structured output provided successfully", is_error: false } }, flowExpertId);
  journal.record(flowId, sessionId, { type: "text-start", messageId, id: "blk-final" }, flowExpertId);
  journal.record(flowId, sessionId, { type: "text-delta", messageId, id: "blk-final", delta: "调查完成。以下是核心发现摘要。" }, flowExpertId);
  journal.record(flowId, sessionId, { type: "text-end", messageId, id: "blk-final" }, flowExpertId);
  journal.record(flowId, sessionId, { type: "finish", messageId, durationMs: 1000, finishedAt: "2026-06-24T11:18:22.000Z" }, flowExpertId);
}

describe("expert snapshot uses the canonical transcript", () => {
  it("returns committed final text without consulting SDK history", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({ id: "flow-stale-disk", workspaceId: "ws-default", name: "S", description: "", projectId: null });
    const workRun = beginWorkRun(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-research" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-expert-stale");
    const task = store.createTask({ flowId: flow.id, workRunId: workRun.id, title: "Research", description: "R", expertId: "exp-research", dependsOnTaskIds: [] })!;
    store.createAgentSession({
      id: "ags-stale", flowId: flow.id, workRunId: workRun.id, taskId: task.id, expertId: "exp-research",
      flowExpertId: flowExpert.id, sessionId: "sdk-expert-stale", displayName: "Research", status: "completed",
    });

    const chatJournal = new ChatJournal(store);
    recordCompleteTurn(chatJournal, flow.id, "sdk-expert-stale", flowExpert.id);
    const app = createApp({
      logger: false,
      store,
      chatJournal,
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "session:get", flow_id: flow.id, flow_expert_id: flowExpert.id, session_id: "", log_id: "log-stale" } }));
      const response = await nextWsMessage(ws);
      expect(response).toEqual(expect.objectContaining({
        type: "session:transcript_snapshot",
        flow_id: flow.id,
        data: expect.objectContaining({
          timeline_items: expect.arrayContaining([
            expect.objectContaining({
              id: "msg-user-live-1",
              type: "message",
              payload: expect.objectContaining({ content: "调查这个项目" }),
            }),
            expect.objectContaining({
              id: "msg-assistant-live-1",
              type: "message",
              payload: expect.objectContaining({ content: "调查完成。以下是核心发现摘要。" }),
            }),
          ]),
        }),
      }));
      ws.terminate();
    } finally {
      await app.close();
    }
  });
});

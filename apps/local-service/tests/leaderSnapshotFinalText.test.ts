import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { createApp } from "../src/server/app.js";
import { leaderTranscriptChannelId } from "../src/domain/transcriptChannels.js";
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

function recordLeaderCompleteTurn(journal: ChatJournal, flowId: string, sessionId: string, transcriptId: string) {
  const messageId = "msg-leader-live-1";
  journal.recordUserMessage(flowId, sessionId, "当前项目都有什么", "msg-user-live-1", "2026-06-25T14:05:00.000Z", transcriptId);
  journal.record(flowId, sessionId, { type: "start", messageId, startedAt: "2026-06-25T14:05:01.000Z" }, transcriptId);
  journal.record(flowId, sessionId, {
    type: "tool-input-start",
    messageId,
    toolCallId: "call-get-context",
    toolName: "mcp__leader__get_context",
  }, transcriptId);
  journal.record(flowId, sessionId, {
    type: "tool-input-available",
    messageId,
    toolCallId: "call-get-context",
    toolName: "mcp__leader__get_context",
    input: { flow_id: flowId },
  }, transcriptId);
  journal.record(flowId, sessionId, {
    type: "tool-output-available",
    messageId,
    toolCallId: "call-get-context",
    output: { content: "{\"status\":\"ok\"}" },
  }, transcriptId);
  journal.record(flowId, sessionId, { type: "text-start", messageId, id: "blk-final" }, transcriptId);
  journal.record(flowId, sessionId, {
    type: "text-delta",
    messageId,
    id: "blk-final",
    delta: "研究任务已完成，以下是项目概况。",
  }, transcriptId);
  journal.record(flowId, sessionId, { type: "text-end", messageId, id: "blk-final" }, transcriptId);
  journal.record(flowId, sessionId, {
    type: "finish",
    messageId,
    durationMs: 8000,
    finishedAt: "2026-06-25T14:05:09.000Z",
  }, transcriptId);
}

describe("leader snapshot uses the canonical transcript", () => {
  it("returns the committed final message without consulting SDK history", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-leader-stale-disk",
      workspaceId: "ws-default",
      name: "Leader stale snapshot",
      description: "",
      projectId: null,
    });
    store.createAgentSession({
      id: "ags-leader-stale",
      flowId: flow.id,
      workRunId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-stale",
      displayName: "Leader",
      status: "completed",
    });

    const chatJournal = new ChatJournal(store);
    recordLeaderCompleteTurn(chatJournal, flow.id, "sdk-leader-stale", leaderTranscriptChannelId(flow.id));
    const app = createApp({
      logger: false,
      store,
      chatJournal,
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({
        data: {
          type: "session:get",
          flow_id: flow.id,
          agent_session_id: "ags-leader-stale",
          session_id: "sdk-leader-stale",
          log_id: "log-leader-stale",
        },
      }));
      const response = await nextWsMessage(ws);
      expect(response).toEqual(expect.objectContaining({
        type: "session:transcript_snapshot",
        flow_id: flow.id,
        data: expect.objectContaining({
          timeline_items: expect.arrayContaining([
            expect.objectContaining({
              id: "msg-user-live-1",
              type: "message",
              payload: expect.objectContaining({ content: "当前项目都有什么" }),
            }),
            expect.objectContaining({
              id: "msg-leader-live-1",
              type: "message",
              payload: expect.objectContaining({ content: "研究任务已完成，以下是项目概况。" }),
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

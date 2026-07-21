import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import { beginUserTurn } from "./helpers/userTurnTestHelpers.js";
import { createApp } from "../src/server/app.js";
import {
  handleWsClientMessage,
  recoverPendingDecisionCardLeaderInputs,
} from "../src/server/wsGateway.js";
import { EventBus } from "../src/ws/eventBus.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { WsPusher } from "../src/ws/pusher.js";
import type { ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { ClientWsMessageSchema, ServerWsMessageSchema } from "../src/protocol/wsMessages.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";

type WsConnection = Parameters<typeof handleWsClientMessage>[1];
const testLeaderRuntimeBinding = {
  leaderRuntimeConfigId: "default-agent-sdk",
  leaderRuntimeModelId: "mimo-v25",
};
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

beforeAll(() => {
  config.agentRuntimeConfigRoot = path.join(import.meta.dirname, "fixtures", "agent-runtime");
});

afterAll(() => {
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
});

const wsBuffers = new WeakMap<any, unknown[]>();
const wsWaiters = new WeakMap<any, Array<(message: unknown) => void>>();

function ensureWsBuffer(ws: any): void {
  if (wsBuffers.has(ws)) return;
  wsBuffers.set(ws, []);
  wsWaiters.set(ws, []);
  ws.on("message", (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as unknown;
    const waiters = wsWaiters.get(ws) ?? [];
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    wsBuffers.get(ws)?.push(message);
  });
}

function nextWsMessage(ws: any): Promise<unknown> {
  ensureWsBuffer(ws);
  const buffered = wsBuffers.get(ws);
  const message = buffered?.shift();
  if (message) return Promise.resolve(message);

  return Promise.race([
    new Promise((resolve) => {
      wsWaiters.get(ws)?.push(resolve);
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for websocket message")), 500);
    }),
  ]);
}

function createQuery(messages: unknown[]): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close() {},
  };
}

describe("EventBus", () => {
  it("accepts only structured runtime transport status messages", () => {
    expect(ServerWsMessageSchema.parse({
      type: "runtime:transport",
      flow_id: "flow-1",
      agent_session_id: "agent-1",
      data: {
        state: "reconnecting",
        message: "Codex WebSocket 正在重连（2/5）",
        attempt: 2,
        max_attempts: 5,
        runtime_role: "leader",
        user_turn_id: "turn-1",
      },
    })).toMatchObject({ type: "runtime:transport" });
    expect(() => ServerWsMessageSchema.parse({
      type: "runtime:transport",
      flow_id: "flow-1",
      agent_session_id: "agent-1",
      data: {
        state: "reconnecting",
        message: "secret",
        runtime_role: "leader",
        raw_stderr: "must not cross the protocol boundary",
      },
    })).toThrow();
  });

  it("publishes messages to subscribed flow clients only", async () => {
    const bus = new EventBus();
    const flowOneReceived: unknown[] = [];
    const flowTwoReceived: unknown[] = [];

    bus.subscribe("flow-1", "client-1", (message) => flowOneReceived.push(message));
    bus.subscribe("flow-2", "client-2", (message) => flowTwoReceived.push(message));

    await bus.publish("flow-1", {
      type: "flow:status",
      flow_id: "flow-1",
      data: { status: "active" },
    });

    expect(flowOneReceived).toHaveLength(1);
    expect(flowTwoReceived).toHaveLength(0);
  });

  it("stops delivering messages after unsubscribe", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.subscribe("flow-1", "client-1", (message) => received.push(message));
    bus.unsubscribe("flow-1", "client-1");

    await bus.publish("flow-1", {
      type: "flow:status",
      flow_id: "flow-1",
      data: { status: "active" },
    });

    expect(received).toHaveLength(0);
  });

  it("isolates failing subscribers from other clients and publishers", async () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.subscribe("flow-1", "bad-client", () => {
      throw new Error("socket closed");
    });
    bus.subscribe("flow-1", "good-client", (message) => received.push(message));

    await expect(
      bus.publish("flow-1", {
        type: "flow:status",
        flow_id: "flow-1",
        data: { status: "active" },
      }),
    ).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it("rejects messages whose envelope flow_id does not match the publish target", async () => {
    const bus = new EventBus();

    await expect(
      bus.publish("flow-1", {
        type: "flow:status",
        flow_id: "flow-2",
        data: { status: "active" },
      }),
    ).rejects.toThrow("Event flow_id mismatch");
  });
});

describe("ChatJournal", () => {
  it("assembles text, reasoning, and tool chunks into the current assistant UIMessage", () => {
    const journal = new ChatJournal();

    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-1", startedAt: "2026-06-24T10:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "text-start", id: "text-1" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-1", delta: "Hello" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-1", delta: " world" });
    journal.record("flow-1", "session-1", { type: "text-end", id: "text-1" });
    journal.record("flow-1", "session-1", { type: "reasoning-start", id: "reason-1" });
    journal.record("flow-1", "session-1", { type: "reasoning-delta", id: "reason-1", delta: "Thinking" });
    journal.record("flow-1", "session-1", { type: "reasoning-end", id: "reason-1" });
    journal.record("flow-1", "session-1", { type: "tool-input-start", toolCallId: "tool-1", toolName: "read_file" });
    journal.record("flow-1", "session-1", { type: "tool-input-delta", toolCallId: "tool-1", inputTextDelta: "{\"path\"" });
    journal.record("flow-1", "session-1", { type: "tool-input-delta", toolCallId: "tool-1", inputTextDelta: ":\"a.ts\"}" });
    journal.record("flow-1", "session-1", {
      type: "tool-input-available",
      toolCallId: "tool-1",
      toolName: "read_file",
      input: { path: "a.ts" },
    });
    journal.record("flow-1", "session-1", {
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "ok", is_error: false },
    });

    expect(journal.getCurrentMessage("flow-1", "session-1")).toEqual({
      id: "msg-1",
      role: "assistant",
      content: "Hello world",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { turnTiming: { startedAt: "2026-06-24T10:00:00.000Z", finishedAt: null, durationMs: null } },
      parts: [
        { type: "text", id: "text-1", text: "Hello world" },
        { type: "reasoning", id: "reason-1", text: "Thinking", state: "done" },
        {
          type: "tool-read_file",
          toolCallId: "tool-1",
          toolName: "read_file",
          state: "output-available",
          inputText: "{\"path\":\"a.ts\"}",
          input: { path: "a.ts" },
          output: { content: "ok", is_error: false },
        },
      ],
    });
  });

  it("finishes the current message without creating events for unknown chunks", () => {
    const journal = new ChatJournal();

    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-1", startedAt: "2026-06-24T10:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "unknown-event" });
    journal.record("flow-1", "session-1", { type: "finish", durationMs: null, finishedAt: "2026-06-18T08:36:34.898Z" });

    expect(journal.getCurrentMessage("flow-1", "session-1")).toBeNull();
  });

  it("keeps completed user and assistant messages in session history", () => {
    const journal = new ChatJournal();

    journal.recordUserMessage("flow-1", "session-1", "写个 helloworld", "msg-user-1");
    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-assistant-1", startedAt: "2026-06-24T10:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "text-start" });
    journal.record("flow-1", "session-1", { type: "text-delta", delta: "我会先整理方案。" });
    journal.record("flow-1", "session-1", { type: "text-end" });
    journal.record("flow-1", "session-1", { type: "finish", durationMs: null, finishedAt: "2026-06-18T08:36:34.898Z" });

    expect(journal.getHistory("flow-1", "session-1")).toEqual([
      {
        id: "msg-user-1",
        role: "user",
        parts: [{ type: "text", text: "写个 helloworld" }],
        content: "写个 helloworld",
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "我会先整理方案。" }],
        content: "我会先整理方案。",
        createdAt: "2026-06-24T10:00:00.000Z",
        metadata: {
          turnTiming: {
            startedAt: "2026-06-24T10:00:00.000Z",
            finishedAt: "2026-06-18T08:36:34.898Z",
            durationMs: null,
          },
        },
      },
    ]);
  });

  it("segments live assistant history after a running guide is read", () => {
    const journal = new ChatJournal();

    journal.recordUserMessage("flow-1", "session-1", "初始需求", "msg-user-1");
    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-assistant-1", startedAt: "2026-06-29T08:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "text-start", id: "text-before" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-before", delta: "引导前内容。" });
    journal.record("flow-1", "session-1", { type: "text-end", id: "text-before" });
    journal.recordUserMessage(
      "flow-1",
      "session-1",
      "改成18次吧",
      "msg-guide-1",
      "2026-06-29T08:00:05.000Z",
      "session-1",
      { localMessageKind: "running-guide" },
    );
    journal.record("flow-1", "session-1", { type: "text-start", id: "text-after" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-after", delta: "引导后内容。" });
    journal.record("flow-1", "session-1", { type: "text-end", id: "text-after" });
    journal.record("flow-1", "session-1", { type: "finish", durationMs: 10_000, finishedAt: "2026-06-29T08:00:10.000Z" });

    expect(journal.getHistory("flow-1", "session-1").map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:初始需求",
      "assistant:引导前内容。",
      "user:改成18次吧",
      "assistant:引导后内容。",
    ]);
  });

  it("does not split a running tool when a guide arrives before tool output", () => {
    const journal = new ChatJournal();

    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-assistant-1", startedAt: "2026-06-29T08:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read" });
    journal.record("flow-1", "session-1", {
      type: "tool-input-available",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "README.md" },
    });
    journal.recordUserMessage(
      "flow-1",
      "session-1",
      "12次就行",
      "msg-guide-1",
      "2026-06-29T08:00:02.000Z",
      "session-1",
      { localMessageKind: "running-guide" },
    );
    journal.record("flow-1", "session-1", {
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "ok", is_error: false },
    });
    journal.record("flow-1", "session-1", { type: "text-start", id: "text-after" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-after", delta: "引导后总结。" });
    journal.record("flow-1", "session-1", { type: "finish", durationMs: 10_000, finishedAt: "2026-06-29T08:00:10.000Z" });

    const history = journal.getHistory("flow-1", "session-1");
    expect(history.map((message) => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(history[0]).toEqual(expect.objectContaining({
      role: "assistant",
      parts: [expect.objectContaining({
        type: "tool-Read",
        toolCallId: "tool-1",
        state: "output-available",
      })],
    }));
    expect(history[2]).toEqual(expect.objectContaining({
      role: "assistant",
      content: "引导后总结。",
    }));
  });

  it("returns the canonical assistant segment id after a guide boundary", () => {
    const journal = new ChatJournal();

    journal.record("flow-1", "session-1", { type: "start", messageId: "msg-assistant-1", startedAt: "2026-06-29T08:00:00.000Z" });
    journal.record("flow-1", "session-1", { type: "text-start", id: "text-before" });
    journal.record("flow-1", "session-1", { type: "text-delta", id: "text-before", delta: "引导前内容。" });
    journal.record("flow-1", "session-1", { type: "text-end", id: "text-before" });
    journal.recordUserMessage(
      "flow-1",
      "session-1",
      "停止",
      "msg-guide-1",
      "2026-06-29T08:00:05.000Z",
      "session-1",
      { localMessageKind: "running-guide" },
    );

    const reasoning = journal.record("flow-1", "session-1", { type: "reasoning-start", messageId: "msg-assistant-1", id: "reason-after-guide" });
    journal.record("flow-1", "session-1", { type: "reasoning-delta", messageId: "msg-assistant-1", id: "reason-after-guide", delta: "收到停止。" });
    journal.record("flow-1", "session-1", { type: "reasoning-end", messageId: "msg-assistant-1", id: "reason-after-guide" });
    const tool = journal.record("flow-1", "session-1", {
      type: "tool-input-start",
      messageId: "msg-assistant-1",
      toolCallId: "tool-1",
      toolName: "mcp__leader__get_context",
    });
    journal.record("flow-1", "session-1", {
      type: "tool-input-available",
      messageId: "msg-assistant-1",
      toolCallId: "tool-1",
      toolName: "mcp__leader__get_context",
      input: { flow_id: "flow-1" },
    });
    journal.record("flow-1", "session-1", {
      type: "tool-output-available",
      messageId: "msg-assistant-1",
      toolCallId: "tool-1",
      output: { content: "ok", is_error: false },
    });
    const finalText = journal.record("flow-1", "session-1", { type: "text-start", messageId: "msg-assistant-1", id: "text-final" });

    expect(reasoning.messageId).toBe("msg-assistant-1:guide-1");
    expect(tool.messageId).toBe("msg-assistant-1:guide-1");
    expect(finalText.messageId).toBe("msg-assistant-1:guide-1");
  });
});

describe("WsPusher", () => {
  it("records the journal event before publishing the websocket envelope", async () => {
    const bus = new EventBus();
    const journal = new ChatJournal();
    const received: unknown[] = [];
    const journalDuringPublish: unknown[] = [];

    bus.subscribe("flow-1", "client-1", (message) => {
      received.push(message);
      journalDuringPublish.push(journal.getCurrentMessage("flow-1", "session-1"));
    });

    const pusher = new WsPusher("flow-1", () => "session-1", "agent-session-1", bus, journal);
    await pusher.consume({ type: "start", messageId: "msg-1", log_id: "log-1", startedAt: "2026-06-24T10:00:00.000Z" });

    expect(received).toEqual([
      {
        type: "session:transcript_event",
        flow_id: "flow-1",
        session_id: "session-1",
        agent_session_id: "agent-session-1",
        flow_expert_id: "agent-session-1",
        log_id: "log-1",
        data: { stream_epoch: journal.getStreamEpoch(), cursor: 1, event: { type: "turn-started", messageId: "msg-1", startedAt: "2026-06-24T10:00:00.000Z" } },
      },
    ]);
    expect(journalDuringPublish).toEqual([
      expect.objectContaining({ id: "msg-1", role: "assistant" }),
    ]);
    expect(journal.getCurrentMessage("flow-1", "session-1")?.id).toBe("msg-1");
  });

  it("publishes the committed finish event before secondary completion bookkeeping", async () => {
    const bus = new EventBus();
    const journal = new ChatJournal();
    const completionOrder: string[] = [];

    bus.subscribe("flow-1", "client-1", () => {
      completionOrder.push("publish");
    });

    const pusher = new WsPusher("flow-1", () => "session-1", "agent-session-1", bus, journal, () => {
      completionOrder.push("complete");
    });
    await pusher.consume({
      type: "start",
      messageId: "msg-1",
      startedAt: "2026-06-18T08:36:30.000Z",
    });
    completionOrder.length = 0;
    await pusher.consume({
      type: "finish",
      durationMs: null,
      finishedAt: "2026-06-18T08:36:34.898Z",
    });

    expect(completionOrder).toEqual(["publish", "complete"]);
  });

  it("ignores late runtime events after the canonical turn is terminal", async () => {
    const bus = new EventBus();
    const journal = new ChatJournal();
    const received: unknown[] = [];
    bus.subscribe("flow-1", "client-1", (message) => received.push(message));
    const pusher = new WsPusher("flow-1", () => "session-1", "agent-session-1", bus, journal);

    await pusher.consume({ type: "start", messageId: "msg-1" });
    await pusher.consume({ type: "finish", durationMs: null, finishedAt: "2026-06-18T08:36:34.898Z" });
    const cursorAfterFinish = journal.getCursor("flow-1", "agent-session-1");
    received.length = 0;
    await pusher.consume({ type: "text-delta", messageId: "msg-1", id: "late", delta: "late" });

    expect(received).toEqual([]);
    expect(journal.getCursor("flow-1", "agent-session-1")).toBe(cursorAfterFinish);
  });

  it("publishes canonical assistant segment ids after guide boundaries", async () => {
    const bus = new EventBus();
    const journal = new ChatJournal();
    const received: Array<{ data?: { event?: { messageId?: string } } }> = [];

    bus.subscribe("flow-1", "client-1", (message) => {
      received.push(message as { data?: { event?: { messageId?: string } } });
    });

    const pusher = new WsPusher("flow-1", () => "session-1", "agent-session-1", bus, journal);
    await pusher.consume({ type: "start", messageId: "msg-assistant-1", startedAt: "2026-06-29T08:00:00.000Z" });
    await pusher.consume({ type: "text-start", messageId: "msg-assistant-1", id: "text-before" });
    await pusher.consume({ type: "text-delta", messageId: "msg-assistant-1", id: "text-before", delta: "引导前。" });
    await pusher.consume({ type: "text-end", messageId: "msg-assistant-1", id: "text-before" });
    journal.recordUserMessage(
      "flow-1",
      "session-1",
      "停止",
      "msg-guide-1",
      "2026-06-29T08:00:05.000Z",
      "agent-session-1",
      { localMessageKind: "running-guide" },
    );
    await pusher.consume({ type: "reasoning-start", messageId: "msg-assistant-1", id: "reason-after-guide" });
    await pusher.consume({
      type: "tool-input-start",
      messageId: "msg-assistant-1",
      toolCallId: "tool-1",
      toolName: "mcp__leader__get_context",
    });

    expect(received.at(-2)?.data?.event?.messageId).toBe("msg-assistant-1:guide-1");
    expect(received.at(-1)?.data?.event?.messageId).toBe("msg-assistant-1:guide-1");
  });
});

describe("WS schemas", () => {
  it("accepts message-level Spec requests and run spec client messages", () => {
    expect(ClientWsMessageSchema.parse({
      type: "flow:message",
      flow_id: "flow-1",
      content: "先给我一份方案",
      spec_requested: true,
      log_id: "L1",
    })).toMatchObject({ type: "flow:message", spec_requested: true });

    expect(ClientWsMessageSchema.parse({
      type: "flow:run_spec",
      flow_id: "flow-1",
      spec_approval_id: "sca-1",
      log_id: "L2",
    })).toMatchObject({ type: "flow:run_spec", spec_approval_id: "sca-1" });
  });

  it("accepts only bounded client Flow switch diagnostics", () => {
    expect(ClientWsMessageSchema.parse({
      type: "client:diagnostic",
      flow_id: "flow-1",
      event: "flow_switch_failed",
      duration_ms: 1250,
      error_code: "SESSION_HISTORY_UNAVAILABLE",
      leader_agent_session_id: "agent-1",
    })).toMatchObject({ type: "client:diagnostic", event: "flow_switch_failed" });

    expect(() => ClientWsMessageSchema.parse({
      type: "client:diagnostic",
      flow_id: "flow-1",
      event: "arbitrary_event",
      prompt: "must not be accepted",
    })).toThrow();
  });

  it("rejects removed V1 websocket messages", () => {
    expect(() => ClientWsMessageSchema.parse({ type: "flow:commit_plan", flow_id: "flow-1" })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: "spec:run", flow_id: "flow-1", spec_revision_id: "spec-1" })).toThrow();
  });

  it("accepts spec and permission card server events", () => {
    expect(ServerWsMessageSchema.parse({
      type: "flow:spec_card",
      flow_id: "flow-1",
      data: {
        spec_approval_id: "sca-1",
        spec_revision_id: "spec-1",
        status: "pending",
        file_name: "Hello_World_abcd.md",
        overview: "Create page.",
        actions: ["run"],
      },
    })).toMatchObject({ type: "flow:spec_card" });

    expect(ServerWsMessageSchema.parse({
      type: "flow:decision_card",
      flow_id: "flow-1",
      data: {
        card_id: "dc-perm-1",
        card_type: "permission_confirmation",
        status: "pending",
        questions: [],
      },
    })).toMatchObject({ type: "flow:decision_card" });
  });

  it("accepts multi-select clarification answers", () => {
    expect(ClientWsMessageSchema.parse({
      type: "flow:decision",
      flow_id: "flow-1",
      card_id: "dc-1",
      answers: { 范围: ["前端", "后端"] },
    })).toMatchObject({ answers: { 范围: ["前端", "后端"] } });
  });
});

describe("Fastify app and websocket gateway", () => {
  it("returns health status", async () => {
    const app = createApp({ logger: false });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });

  it("handles invalid websocket messages without closing the gateway", async () => {
    const app = createApp({ logger: false });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");

      ws.send("not json");
      expect(await nextWsMessage(ws)).toEqual({
        type: "system:error",
        data: { code: "invalid_message", message: "Invalid websocket message" },
      });

      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: "flow-1", log_id: "log-1" } }));
      expect(await nextWsMessage(ws)).toEqual({
        type: "flow:state",
        flow_id: "flow-1",
        log_id: "log-1",
        data: {
          status: "ready",
          active_user_turn_id: null,
          user_turns: [],
          tasks: [],
          spec_revisions: [],
          agent_sessions: [],
          decision_cards: [],
          queued_messages: [],
          artifacts: [],
          recent_events: [],
        },
      });

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("sends persisted flow snapshot when subscribing to a flow", async () => {
    const store = createStore(":memory:");
    store.migrate();
    const project = store.createProject({ name: "Snapshot Project", localPath: "/tmp/snapshot-project" });
    const flow = store.createFlow({
      name: "Snapshot Flow",
      description: "snapshot contract",
      projectId: project.id,
      ...testLeaderRuntimeBinding,
    });
    const app = createApp({ logger: false, store } as any);

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id, log_id: "log-snapshot" } }));

      expect(await nextWsMessage(ws)).toEqual({
        type: "flow:state",
        flow_id: flow.id,
        log_id: "log-snapshot",
        data: expect.objectContaining({
          id: flow.id,
          name: "Snapshot Flow",
          name_generation_status: "generated",
          status: "ready",
          active_user_turn_id: null,
          project_id: project.id,
          leader_runtime_config_id: "default-agent-sdk",
          leader_runtime_model_id: "mimo-v25",
          user_turns: [],
          tasks: [],
          spec_revisions: [],
          agent_sessions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        }),
      });

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("includes flat UserTurn task details in persisted flow snapshots", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-state-user-turn",
      workspaceId: "ws-default",
      name: "Execution Snapshot Flow",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: JSON.stringify({ prompt: "build" }),
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build feature",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const app = createApp({ logger: false, store });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id, log_id: "log-state-user-turn" } }));

      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "flow:state",
        flow_id: flow.id,
        data: expect.objectContaining({
          active_user_turn_id: userTurn.id,
          user_turns: [expect.objectContaining({ id: userTurn.id, status: "active" })],
          tasks: [expect.objectContaining({
            id: task.id,
            user_turn_id: userTurn.id,
            title: "Build",
            status: "pending",
          })],
        }),
      }));

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("does not restore an interrupted Expert journal as an active turn", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-interrupted-history",
      workspaceId: "ws-default",
      name: "Interrupted History",
      description: "",
      projectId: null,
    });
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const session = store.createAgentSession({
      id: "ags-coder-interrupted",
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      sessionId: "sdk-coder-interrupted",
      displayName: "Coder",
      status: "interrupted",
    });
    const chatJournal = new ChatJournal();
    chatJournal.record(flow.id, session.sessionId!, {
      type: "start",
      messageId: "msg-assistant-interrupted",
      startedAt: "2026-07-11T13:19:20.000Z",
    }, flowExpert.id);
    chatJournal.record(flow.id, session.sessionId!, {
      type: "tool-input-start",
      messageId: "msg-assistant-interrupted",
      toolCallId: "tool-write",
      toolName: "Write",
    }, flowExpert.id);
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
          flow_expert_id: flowExpert.id,
        },
      }));

      const response = await nextWsMessage(ws) as { type: string; data: Record<string, unknown> };
      expect(response.type).toBe("session:transcript_snapshot");
      expect(response.data).not.toHaveProperty("active_turn");
      expect(response.data.messages).toEqual([
        expect.objectContaining({ id: "msg-assistant-interrupted", role: "assistant" }),
      ]);
      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("returns session snapshot with completed history and the current streaming message", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-snapshot",
      workspaceId: "ws-default",
      name: "Snapshot Flow",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      id: "ags-leader-snapshot",
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-snapshot",
      displayName: "Leader",
    });
    const chatJournal = new ChatJournal();
    chatJournal.recordUserMessage(
      flow.id,
      leader.sessionId!,
      "写个 helloworld",
      "msg-user-snapshot",
      "2026-06-24T09:59:59.000Z",
      leader.id,
    );
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "start",
      messageId: "msg-assistant-current",
      startedAt: "2026-06-24T10:00:00.000Z",
    }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, { type: "text-start", id: "text-current" }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, { type: "text-delta", id: "text-current", delta: "正在继续执行" }, leader.id);

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
          agent_session_id: leader.id,
          session_id: "",
          log_id: "log-snapshot",
        },
      }));

      expect(await nextWsMessage(ws)).toEqual({
        type: "session:transcript_snapshot",
        flow_id: flow.id,
        session_id: "sdk-leader-snapshot",
        agent_session_id: leader.id,
        data: {
          stream_epoch: chatJournal.getStreamEpoch(),
          cursor: 4,
          active_turn: {
            message_id: "msg-assistant-current",
            root_message_id: "msg-assistant-current",
            segment_index: 0,
            started_at: "2026-06-24T10:00:00.000Z",
          },
          messages: [
            {
              id: "msg-user-snapshot",
              role: "user",
              parts: [{ type: "text", text: "写个 helloworld" }],
              content: "写个 helloworld",
              createdAt: "2026-06-24T09:59:59.000Z",
            },
            {
              id: "msg-assistant-current",
              role: "assistant",
              parts: [{ type: "text", id: "text-current", text: "正在继续执行" }],
              content: "正在继续执行",
              createdAt: "2026-06-24T10:00:00.000Z",
              metadata: {
                turnTiming: {
                  startedAt: "2026-06-24T10:00:00.000Z",
                  finishedAt: null,
                  durationMs: null,
                },
              },
            },
          ],
        },
        pending_cards: [],
        decision_cards: [],
      });

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("does not read SDK history while the current stream is active", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-snapshot-overlap",
      workspaceId: "ws-default",
      name: "Snapshot Overlap Flow",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      id: "ags-leader-snapshot-overlap",
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-snapshot-overlap",
      displayName: "Leader",
    });
    const chatJournal = new ChatJournal();
    chatJournal.recordUserMessage(
      flow.id,
      leader.sessionId!,
      "写个 helloworld",
      "msg-user-overlap",
      undefined,
      leader.id,
    );
    chatJournal.record(flow.id, leader.sessionId!, { type: "start", messageId: "msg-assistant-current" }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "tool-input-start",
      toolCallId: "tool-card-1",
      toolName: "mcp__leader__decision_card",
    }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "tool-input-available",
      toolCallId: "tool-card-1",
      toolName: "mcp__leader__decision_card",
      input: { card_type: "SpecApprovalCard", questions: [] },
    }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "tool-output-available",
      toolCallId: "tool-card-1",
      output: { content: "{\"card_id\":\"dc-overlap\"}", is_error: false },
    }, leader.id);

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
          agent_session_id: leader.id,
          session_id: "",
        },
      }));

      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "session:transcript_snapshot",
        data: expect.objectContaining({
          messages: [
            expect.objectContaining({ id: "msg-user-overlap", role: "user" }),
            expect.objectContaining({ id: "msg-assistant-current", role: "assistant" }),
          ],
          active_turn: expect.objectContaining({ message_id: "msg-assistant-current" }),
        }),
      }));

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("does not merge AgentSession supplemental event bodies into session:get history", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-supplemental",
      workspaceId: "ws-default",
      name: "Supplemental",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      id: "ags-leader-supplemental",
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-supplemental",
      displayName: "Leader",
    });
    store.appendEventLog({
      flowId: flow.id,
      agentSessionId: leader.id,
      eventType: "agent_session.leader_message",
      payload: {
        content: "Leader message",
        summary: "",
        delivery_status: "accepted",
      },
    });
    store.appendEventLog({
      flowId: flow.id,
      agentSessionId: leader.id,
      eventType: "agent_session.completion",
      payload: {
        kind: "expert_result",
        flow_id: flow.id,
        user_turn_id: "utn-1",
        task_id: "task-1",
        agent_session_id: "ags-1",
        expert_id: "exp-backend",
        status: "completed",
        summary: "Built",
        error: null,
        artifact_refs: [],
        completed_at: "2026-06-15T10:00:00.000Z",
      },
    });
    const app = createApp({
      logger: false,
      store,
      chatJournal: new ChatJournal(),
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      for (let i = 0; i < 2; i++) {
        ws.send(JSON.stringify({
          data: {
            type: "session:get",
            flow_id: flow.id,
            agent_session_id: leader.id,
            session_id: "",
            log_id: `log-supplemental-${i}`,
          },
        }));
        const response = await nextWsMessage(ws) as {
          type: string;
          data: { messages: { role: string; content: string }[] };
        };
        expect(response.type).toBe("session:transcript_snapshot");
        expect(response.data.messages).toEqual([]);
      }

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("does not render failed completion summaries from event_log", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-supplemental-failed",
      workspaceId: "ws-default",
      name: "Supplemental Failed",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      id: "ags-leader-supplemental-failed",
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-supplemental-failed",
      displayName: "Leader",
    });
    store.appendEventLog({
      flowId: flow.id,
      agentSessionId: leader.id,
      eventType: "agent_session.completion",
      payload: {
        kind: "expert_result",
        flow_id: flow.id,
        user_turn_id: "utn-1",
        task_id: "task-1",
        agent_session_id: "ags-1",
        expert_id: "exp-backend",
        status: "failed",
        summary: "Build crashed",
        error: "out of memory",
        artifact_refs: [],
        completed_at: "2026-06-15T10:00:00.000Z",
      },
    });
    const app = createApp({
      logger: false,
      store,
      chatJournal: new ChatJournal(),
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({
        data: {
          type: "session:get",
          flow_id: flow.id,
          agent_session_id: leader.id,
          session_id: "",
          log_id: "log-supplemental-failed",
        },
      }));
      const response = await nextWsMessage(ws) as {
        type: string;
        data: { messages: { role: string; content: string }[] };
      };
      expect(response.type).toBe("session:transcript_snapshot");
      expect(response.data.messages).toEqual([]);

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("passes client_message_id into the direct UserTurn input snapshot via flow:message", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-direct-message",
      workspaceId: "ws-default",
      name: "Direct Message",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const chatJournal = new ChatJournal();
    const sent: unknown[] = [];
    const capturedTurns: Array<{ userMessage?: string; currentTurnInput?: unknown }> = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          capturedTurns.push({ userMessage: turn.userMessage, currentTurnInput: turn.currentTurnInput });
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:message",
        flow_id: flow.id,
        content: "写个 helloworld",
        client_message_id: "client-msg-42",
        log_id: "log-direct-message",
      },
    }), connection);

    expect(sent).toContainEqual(expect.objectContaining({
      type: "flow:status",
      flow_id: flow.id,
      log_id: "log-direct-message",
    }));
    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]!.userMessage).toBe("写个 helloworld");
    expect(capturedTurns[0]!.currentTurnInput).toEqual(expect.objectContaining({
      trigger_kind: "user_message",
      message_id: "client-msg-42",
      content: "写个 helloworld",
      created_at: expect.any(String),
    }));

    const history = chatJournal.getHistory(flow.id, store.getFlow(flow.id)!.leaderSessionId ?? "");
    expect(history).toEqual([
      expect.objectContaining({ id: "client-msg-42", role: "user", content: "写个 helloworld" }),
    ]);
    const userTurn = store.listUserTurns(flow.id)[0]!;
    expect(store.listEventLog(flow.id).find((event) => event.eventType === "flow.user_message")).toEqual(
      expect.objectContaining({ userTurnId: userTurn.id }),
    );
  });

  it("persists, reorders, and dispatches the backend queue exactly once", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-durable-queue",
      workspaceId: "ws-default",
      name: "Durable Queue",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const chatJournal = new ChatJournal(store);
    const sent: any[] = [];
    const runtimeInputs: Array<{ userMessage?: string; currentTurnInput?: unknown }> = [];
    const connection: WsConnection = {
      clientId: "queue-test",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          runtimeInputs.push({ userMessage: turn.userMessage, currentTurnInput: turn.currentTurnInput });
        },
      },
      send: async (message) => { sent.push(message); },
    };

    for (const [queueId, content] of [["msg-queue-1", "第一条"], ["msg-queue-2", "第二条"]] as const) {
      await handleWsClientMessage(JSON.stringify({ data: {
        type: "flow:queue_add",
        flow_id: flow.id,
        queue_id: queueId,
        content,
        log_id: `add-${queueId}`,
      } }), connection);
    }
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:queue_reorder",
      flow_id: flow.id,
      queue_ids: ["msg-queue-2", "msg-queue-1"],
      log_id: "reorder-queue",
    } }), connection);

    expect(store.listQueuedMessages(flow.id).map((item) => item.id)).toEqual(["msg-queue-2", "msg-queue-1"]);

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:queue_dispatch",
      flow_id: flow.id,
      queue_id: "msg-queue-2",
      log_id: "dispatch-queue",
    } }), connection);

    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]).toEqual(expect.objectContaining({
      userMessage: "第二条",
      currentTurnInput: expect.objectContaining({ message_id: "msg-queue-2" }),
    }));
    expect(store.listQueuedMessages(flow.id).map((item) => item.id)).toEqual(["msg-queue-1"]);
    expect(store.getSubmission(flow.id, "msg-queue-2")).toEqual(expect.objectContaining({
      receiptState: "materialized",
      messageId: "msg-queue-2",
      payload: {},
    }));
    const leader = store.listAgentSessions(flow.id).find((session) => session.expertId === "exp-leader")!;
    expect(chatJournal.getTranscriptMessages(flow.id, leader.id).filter((item) => item.id === "msg-queue-2")).toHaveLength(1);

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:queue_dispatch",
      flow_id: flow.id,
      queue_id: "msg-queue-2",
      log_id: "retry-dispatch-queue",
    } }), connection);
    expect(runtimeInputs).toHaveLength(1);

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:queue_add",
      flow_id: flow.id,
      queue_id: "msg-queue-1",
      content: "篡改后的第一条",
      log_id: "conflicting-queue-retry",
    } }), connection);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "system:error",
      data: expect.objectContaining({ code: "MESSAGE_ID_CONFLICT" }),
    }));
  });

  it("restores queued attachment previews without storing duplicate base64 client payloads", async () => {
    const store = createStore(":memory:");
    store.migrate();
    const flow = store.createFlow({
      id: "flow-queue-attachment",
      workspaceId: "ws-default",
      name: "Queue Attachment",
      description: "",
      projectId: null,
    });
    const sent: any[] = [];
    const connection: WsConnection = {
      clientId: "queue-attachment-test",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(store),
      leaderRuntime: { runLeaderTurn: async () => {} },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:queue_add",
      flow_id: flow.id,
      queue_id: "msg-image-1",
      content: "看图",
      attachments: [{ id: "img-1", kind: "image", media_type: "image/png", data: "QUJD" }],
      client_payload: {
        id: "msg-image-1",
        content: "看图",
        imageAttachments: [{ id: "img-1", kind: "image", mediaType: "image/png", addedAt: 1 }],
      },
      log_id: "queue-image",
    } }), connection);

    expect(sent.at(-1)).toEqual(expect.objectContaining({
      type: "flow:queue_state",
      data: {
        messages: [expect.objectContaining({
          imageAttachments: [expect.objectContaining({ dataUrl: "data:image/png;base64,QUJD" })],
        })],
      },
    }));
    const storedPayload = JSON.stringify(store.getQueuedMessage(flow.id, "msg-image-1")?.payload);
    expect(storedPayload.match(/QUJD/gu)).toHaveLength(1);
  });

  it("rejects a reused direct message id with different content without running twice", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-direct-idempotency",
      workspaceId: "ws-default",
      name: "Direct Idempotency",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const sent: any[] = [];
    let runCount = 0;
    const connection: WsConnection = {
      clientId: "direct-idempotency-test",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(store),
      leaderRuntime: { runLeaderTurn: async () => { runCount += 1; } },
      send: async (message) => { sent.push(message); },
    };

    const send = (content: string, logId: string) => handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:message",
      flow_id: flow.id,
      content,
      client_message_id: "msg-stable-1",
      log_id: logId,
    } }), connection);
    await send("原始内容", "first");
    await send("原始内容", "same-retry");
    await send("不同内容", "conflicting-retry");

    expect(runCount).toBe(1);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "system:error",
      log_id: "conflicting-retry",
      data: expect.objectContaining({ code: "MESSAGE_ID_CONFLICT" }),
    }));
  });

  it("keeps the original Leader runtime session when retrying a failed flow", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-retry-failed-leader",
      workspaceId: "ws-default",
      name: "Retry Failed Leader",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const failedLeader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-session-that-never-started",
      displayName: "Leader",
      status: "failed",
    });
    store.updateFlow(flow.id, { leaderSessionId: failedLeader.sessionId });
    const capturedTurns: Array<{ leaderSessionId?: string; resumeSessionId?: string }> = [];
    const connection: WsConnection = {
      clientId: "client-retry",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(),
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          capturedTurns.push({
            leaderSessionId: turn.leaderSessionId,
            resumeSessionId: turn.resumeSessionId,
          });
        },
      },
      send: async () => {},
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:message",
        flow_id: flow.id,
        content: "重新开始",
        client_message_id: "client-msg-retry",
      },
    }), connection);

    const restartedLeader = store.getAgentSession(failedLeader.id)!;
    expect(restartedLeader.sessionId).toBe("sdk-session-that-never-started");
    expect(restartedLeader.status).toBe("failed");
    expect(store.getFlow(flow.id)?.leaderSessionId).toBe(restartedLeader.sessionId);
    expect(capturedTurns).toEqual([{
      leaderSessionId: restartedLeader.sessionId,
      resumeSessionId: "sdk-session-that-never-started",
    }]);
  });

  it("uses only the live journal while a restarted Leader session is running", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-running-restarted-leader",
      workspaceId: "ws-default",
      name: "Running Restarted Leader",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-current",
      displayName: "Leader",
      status: "streaming",
      runtimeSdk: "claudecode",
    })!;
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    store.appendEventLog({
      flowId: flow.id,
      agentSessionId: leader.id,
      eventType: "agent_session.turn_completed",
      payload: {
        agent_session_id: leader.id,
        sdk_session_id: "sdk-old",
      },
    });

    const chatJournal = new ChatJournal();
    chatJournal.recordUserMessage(
      flow.id,
      leader.sessionId!,
      "正在运行的问题",
      "msg-user-current",
      undefined,
      leader.id,
    );
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "start",
      messageId: "msg-assistant-current",
      startedAt: "2026-07-17T17:00:00.000Z",
    }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "text-start",
      messageId: "msg-assistant-current",
      id: "text-current",
    }, leader.id);
    chatJournal.record(flow.id, leader.sessionId!, {
      type: "text-delta",
      messageId: "msg-assistant-current",
      id: "text-current",
      delta: "正在输出",
    }, leader.id);

    const sent: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-running-restarted-leader",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: { runLeaderTurn: async () => undefined },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "session:get",
      flow_id: flow.id,
      agent_session_id: leader.id,
    } }), connection);

    const response = sent.at(-1) as {
      type: string;
      data: { messages: Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }> };
    };
    expect(response.type).toBe("session:transcript_snapshot");
    expect(response.data.messages).toEqual([
      expect.objectContaining({ id: "msg-user-current", role: "user" }),
      expect.objectContaining({
        id: "msg-assistant-current",
        role: "assistant",
        parts: [expect.objectContaining({ type: "text", text: "正在输出" })],
      }),
    ]);
  });

  it("rejects flow messages when the flow leader model is not configured", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-missing-leader-model",
      workspaceId: "ws-default",
      name: "Missing Leader Model",
      description: "",
      projectId: null,
      leaderRuntimeConfigId: "default-agent-sdk",
      leaderRuntimeModelId: "missing-model",
    });
    const sent: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(),
      leaderRuntime: {
        runLeaderTurn: async () => {
          throw new Error("should not run without a configured leader model");
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:message",
        flow_id: flow.id,
        content: "写个 helloworld",
        client_message_id: "client-msg-missing-model",
        log_id: "log-missing-model",
      },
    }), connection);

    expect(sent).toEqual([
      expect.objectContaining({
        type: "system:error",
        flow_id: flow.id,
        log_id: "log-missing-model",
        data: {
          code: "LEADER_MODEL_NOT_CONFIGURED",
          message: "Leader model is not configured",
        },
      }),
    ]);
  });

  it("passes image attachments to Leader without persisting image bytes in event log", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-image-message",
      workspaceId: "ws-default",
      name: "Image Message",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const chatJournal = new ChatJournal();
    const capturedTurns: unknown[] = [];
    const sent: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          capturedTurns.push(turn);
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:message",
        flow_id: flow.id,
        content: "看图",
        client_message_id: "client-msg-image",
        attachments: [{
          id: "img-1",
          kind: "image",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
          name: "pasted.png",
          text_offset: 1,
        }],
      },
    }), connection);

    expect(capturedTurns).toEqual([
      expect.objectContaining({
        userMessage: "看图",
        attachments: [expect.objectContaining({
          id: "img-1",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
          text_offset: 1,
        })],
      }),
    ]);
    const leaderSessionId = store.getFlow(flow.id)!.leaderSessionId ?? "";
    expect(chatJournal.getHistory(flow.id, leaderSessionId)).toEqual([
      expect.objectContaining({
        id: "client-msg-image",
        metadata: expect.objectContaining({
          imageAttachments: [expect.objectContaining({
            id: "img-1",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          })],
        }),
      }),
    ]);
    const eventLogPayload = store.listEventLog(flow.id).map((event) => event.payloadJson).join("\n");
    expect(eventLogPayload).not.toContain("iVBORw0KGgo=");
    expect(eventLogPayload).not.toContain("看图");
  });

  it("passes metadata-only browser comments to Leader and the live transcript", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-browser-metadata-only",
      workspaceId: "ws-default",
      name: "Browser metadata only",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const chatJournal = new ChatJournal();
    const capturedTurns: Array<Record<string, unknown>> = [];
    const connection: WsConnection = {
      clientId: "client-browser-metadata-only",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => { capturedTurns.push(turn as unknown as Record<string, unknown>); },
      },
      send: async () => {},
    };

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:message",
      flow_id: flow.id,
      content: "",
      client_message_id: "client-msg-browser-metadata-only",
      attachments: [{
        id: "browser-1",
        kind: "browser_comment",
        marker_number: 2,
        comment: "截图失败也要保留",
        label: '按钮 ]: \"高级\" · 项',
        selector: 'button[data-state="]:ready"] · span',
        page_url: "https://example.test/settings",
      }],
    } }), connection);

    expect(capturedTurns).toEqual([expect.objectContaining({
      userMessage: "",
      attachments: [expect.objectContaining({
        kind: "browser_comment",
        marker_number: 2,
      })],
      currentTurnInput: expect.objectContaining({ content: "" }),
    })]);
    const leaderSessionId = store.getFlow(flow.id)!.leaderSessionId ?? "";
    expect(chatJournal.getHistory(flow.id, leaderSessionId)).toEqual([
      expect.objectContaining({
        content: "",
        metadata: expect.objectContaining({
          browserElementAttachments: [expect.objectContaining({
            markerNumber: 2,
            selector: 'button[data-state="]:ready"] · span',
            screenshotDataUrl: "",
          })],
        }),
      }),
    ]);
    expect((capturedTurns[0]?.attachments as Array<Record<string, unknown>>)[0]).not.toHaveProperty("data");
  });

  it("resumes Leader on the open user turn when Leader is idle during expert work", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-active-turn-message",
      workspaceId: "ws-default",
      name: "Active Turn Message",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-active-leader",
      displayName: "Leader",
      status: "completed",
    });
    store.updateFlow(flow.id, { leaderSessionId: "sdk-active-leader" });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    fs.mkdirSync(userTurn.workRootPath!, { recursive: true });
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Verify",
      description: "Verify",
      expertId: "exp-verify",
      dependsOnTaskIds: [],
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-verify" });
    store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-verify",
      flowExpertId: flowExpert.id,
      sessionId: "sdk-verify",
      displayName: "Verify",
      status: "streaming",
    });
    const sent: unknown[] = [];
    const capturedTurns: unknown[] = [];
    const chatJournal = new ChatJournal();
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          capturedTurns.push(turn);
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:message",
        flow_id: flow.id,
        content: "请通知 Verify 先看 diff",
        client_message_id: "client-msg-resume-leader",
        log_id: "log-active-turn-message",
      },
    }), connection);

    expect(sent).toContainEqual(expect.objectContaining({
      type: "flow:status",
      flow_id: flow.id,
      log_id: "log-active-turn-message",
    }));
    expect(capturedTurns).toEqual([
      expect.objectContaining({
        flowId: flow.id,
        kind: "user",
        userMessage: "请通知 Verify 先看 diff",
        userTurnId: userTurn.id,
        leaderAgentSessionId: leader.id,
        leaderSessionId: "sdk-active-leader",
        resumeSessionId: "sdk-active-leader",
        currentTurnInput: expect.objectContaining({
          trigger_kind: "user_message",
          user_turn_id: userTurn.id,
          message_id: "client-msg-resume-leader",
          content: "请通知 Verify 先看 diff",
        }),
      }),
    ]);
    expect(store.listUserTurns(flow.id)).toHaveLength(1);
    expect(store.getOpenUserTurn(flow.id)?.id).toBe(userTurn.id);
    expect(chatJournal.getHistory(flow.id, "sdk-active-leader")).toEqual([
      expect.objectContaining({
        id: "client-msg-resume-leader",
        role: "user",
        content: "请通知 Verify 先看 diff",
      }),
    ]);
  });

  it("does not complete an open UserTurn while sending a subscribed flow state", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-stale-user-turn",
      workspaceId: "ws-default",
      name: "Stale User Turn",
      description: "",
      projectId: null,
    });
    store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-completed-leader",
      displayName: "Leader",
      status: "completed",
    });
    const staleTurn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-user-stale",
      startedAt: "2026-06-29T07:00:00.000Z",
    });
    const sent: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(),
      leaderRuntime: {
        runLeaderTurn: async () => undefined,
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:subscribe",
        flow_id: flow.id,
        log_id: "log-stale-user-turn",
      },
    }), connection);

    expect(store.getUserTurn(staleTurn!.id)?.status).toBe("active");
    expect(sent).toEqual([
      expect.objectContaining({
        type: "flow:state",
        flow_id: flow.id,
        log_id: "log-stale-user-turn",
        data: expect.objectContaining({
          user_turns: [
            expect.objectContaining({ status: "active" }),
          ],
        }),
      }),
    ]);
  });

  it("acks a running Leader guide message and records it in the transcript journal", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-guide-message",
      workspaceId: "ws-default",
      name: "Guide Message",
      description: "",
      projectId: null,
      ...testLeaderRuntimeBinding,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-guide",
      displayName: "Leader",
    });
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-original" })!;
    const chatJournal = new ChatJournal();
    const sent: unknown[] = [];
    const guided: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async () => undefined,
        guideLeaderTurn: async (input) => {
          guided.push(input);
          input.beforeDeliver?.();
          return { accepted: true, messageId: input.messageId ?? "msg-guide-generated" };
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:guide",
        flow_id: flow.id,
        content: "补充当前 turn",
        client_message_id: "client-guide-1",
        log_id: "log-guide",
      },
    }), connection);

    expect(guided).toEqual([expect.objectContaining({
      flowId: flow.id,
      leaderAgentSessionId: leader.id,
      content: "补充当前 turn",
      messageId: "client-guide-1",
    })]);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "flow:guide_ack",
      flow_id: flow.id,
      log_id: "log-guide",
      data: expect.objectContaining({
        accepted: true,
        message_id: "client-guide-1",
        client_message_id: "client-guide-1",
      }),
    }));
    expect(chatJournal.getHistory(flow.id, leader.sessionId ?? leader.id)).toEqual([
      expect.objectContaining({
        id: "client-guide-1",
        role: "user",
        content: "补充当前 turn",
        metadata: expect.objectContaining({ localMessageKind: "running-guide" }),
      }),
    ]);
    expect(store.listUserTurns(flow.id).map((turn) => turn.id)).toEqual([userTurn.id]);
    expect(store.listEventLog(flow.id).find((event) => event.eventType === "flow.guide_message")).toEqual(
      expect.objectContaining({ userTurnId: userTurn.id }),
    );
  });

  it("passes decision answers into current turn input via flow:decision", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-decision-input",
      workspaceId: "ws-default",
      name: "Decision Input",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-decision-input",
      displayName: "Leader",
    });
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-decision-input",
      sessionId: leader.sessionId ?? leader.id,
      cardType: "clarification",
      questions: [{ question: "用什么写？", options: [{ label: "HTML", description: "HTML" }] }],
    });
    const chatJournal = new ChatJournal();
    const sent: unknown[] = [];
    const capturedTurns: Array<{ currentTurnInput?: unknown }> = [];
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal,
      leaderRuntime: {
        runLeaderTurn: async (turn) => {
          capturedTurns.push({ currentTurnInput: turn.currentTurnInput });
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "flow:decision",
        flow_id: flow.id,
        card_id: "dc-decision-input",
        answers: { impl: "HTML" },
        log_id: "log-decision-input",
      },
    }), connection);

    expect(sent).toContainEqual(expect.objectContaining({
      type: "flow:decision_card_resolved",
      flow_id: flow.id,
    }));
    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]!.currentTurnInput).toEqual(expect.objectContaining({
      trigger_kind: "decision_resolved",
      card_id: "dc-decision-input",
      message_id: expect.stringMatching(/^msg-decision-/),
      content: "impl: HTML",
      answers: { impl: "HTML" },
      created_at: expect.any(String),
    }));

    const eventLog = store.listEventLog(flow.id);
    const decisionEvent = eventLog.find((event) => event.eventType === "decision_card.resolved");
    expect(decisionEvent).toBeDefined();
    const payload = JSON.parse(decisionEvent!.payloadJson) as Record<string, unknown>;
    expect(payload.card_id).toBe("dc-decision-input");
    expect(payload.message_id).toMatch(/^msg-decision-/);
    expect(payload.answers).toBeUndefined();
    expect(payload.created_at).toBe((capturedTurns[0]!.currentTurnInput as { created_at: string }).created_at);
  });

  it("creates one UserTurn for an ordinary flow message", async () => {
    const store = createStore(":memory:");
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "stream_event", event: { delta: { type: "text_delta", text: "我会先澄清需求。" } } },
        { type: "result", subtype: "success", session_id: "sdk-leader-runtime", is_error: false },
      ]) }),
    } as any);
    const flow = store.createFlow({
      id: "flow-chat-only",
      name: "Chat",
      description: "",
      projectId: store.createProject({ name: "Chat Project", localPath: process.cwd() }).id,
      ...testLeaderRuntimeBinding,
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id } }));
      await nextWsMessage(ws);

      ws.send(JSON.stringify({ data: { type: "flow:message", flow_id: flow.id, content: "写个 helloworld", log_id: "log-message" } }));

      const userMessage = await nextWsMessage(ws);
      expect(userMessage).toEqual(expect.objectContaining({
        type: "session:transcript_event",
        data: expect.objectContaining({
          event: expect.objectContaining({ type: "message-added", message: expect.objectContaining({ content: "写个 helloworld" }) }),
        }),
      }));

      const status = await nextWsMessage(ws);
      expect(status).toEqual(expect.objectContaining({
        type: "flow:message_ack",
        flow_id: flow.id,
        log_id: "log-message",
        data: expect.objectContaining({ accepted: true }),
      }));

      const flowStatus = await nextWsMessage(ws);
      expect(flowStatus).toEqual(expect.objectContaining({
        type: "flow:status",
        flow_id: flow.id,
        log_id: "log-message",
        data: expect.objectContaining({
          status: "active",
          active_user_turn_id: expect.stringMatching(/^utn-/),
          leader_agent_session_id: expect.stringMatching(/^ags-/),
        }),
      }));
      expect(store.listUserTurns(flow.id)).toHaveLength(1);
      expect(store.listAgentSessions(flow.id)).toEqual([
        expect.objectContaining({
          expertId: "exp-leader",
          userTurnId: null,
          taskId: null,
        }),
      ]);

      const maybeUserTurn = await nextWsMessage(ws);
      expect(maybeUserTurn).toEqual(expect.objectContaining({
        type: "user_turn:event",
        flow_id: flow.id,
        log_id: "log-message",
        data: expect.objectContaining({
          status: "active",
          trigger_message_id: expect.stringMatching(/^msg-user-/),
        }),
      }));

      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "session:event",
        data: expect.objectContaining({ status: "streaming", user_turn_id: null }),
      }));
      expect((await nextWsMessage(ws) as { type: string; data: { event: { type: string } } }).data.event.type).toBe("turn-started");
      expect((await nextWsMessage(ws) as { type: string; data: { event: { type: string } } }).data.event.type).toBe("text-start");
      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "session:transcript_event",
        flow_id: flow.id,
        data: expect.objectContaining({
          event: expect.objectContaining({ type: "text-delta", delta: "我会先澄清需求。" }),
        }),
      }));

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects flow:message when the project directory is missing", async () => {
    const store = createStore(":memory:");
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => {
        throw new Error("leader runtime should not start");
      } }),
    } as any);
    const project = store.createProject({
      name: "Missing Project",
      localPath: `/tmp/squadflow-missing-project-${Date.now()}`,
    });
    const flow = store.createFlow({
      id: "flow-missing-project-dir",
      name: "Missing directory",
      description: "",
      projectId: project.id,
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id } }));
      await nextWsMessage(ws);

      ws.send(JSON.stringify({ data: { type: "flow:message", flow_id: flow.id, content: "hello", log_id: "log-missing-dir" } }));

      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "system:error",
        flow_id: flow.id,
        log_id: "log-missing-dir",
        data: expect.objectContaining({
          code: "PROJECT_DIRECTORY_MISSING",
          message: expect.stringContaining(project.localPath),
        }),
      }));
      expect(store.listAgentSessions(flow.id)).toEqual([]);
      expect(store.listUserTurns(flow.id)).toEqual([]);

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("starts approved Spec work on its existing UserTurn", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-run-spec",
      workspaceId: "ws-default",
      name: "Run",
      description: "",
      projectId: null,
    });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-run-spec" })!;
    const specPlan = store.createSpecPlan({
      flowId: flow.id,
      mode: "write",
      name: "Hello World",
      overview: "Create a Hello World page.",
      content: "# Hello World",
      userTurnId: userTurn.id,
    })!;
    store.pauseUserTurnForUserAction(userTurn.id);
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-leader-spec-run", is_error: false },
      ]) }),
    } as any);

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id } }));
      await nextWsMessage(ws);

      ws.send(JSON.stringify({
        data: {
          type: "flow:run_spec",
          flow_id: flow.id,
          spec_approval_id: specPlan.approval.id,
          log_id: "log-spec-run",
        },
      }));

      const startedMessage = await nextWsMessage(ws);
      expect(startedMessage).toEqual(expect.objectContaining({
        type: "user_turn:event",
        flow_id: flow.id,
        log_id: "log-spec-run",
        data: expect.objectContaining({
          user_turn_id: userTurn.id,
          work_source: "spec",
          spec_revision_id: specPlan.spec.id,
          status: "active",
        }),
      }));
      const message = await nextWsMessage(ws);
      expect(message).toEqual({
        type: "flow:spec_card_resolved",
        flow_id: flow.id,
        log_id: "log-spec-run",
        data: {
          spec_approval_id: specPlan.approval.id,
          spec_revision_id: specPlan.spec.id,
          user_turn_id: userTurn.id,
          status: "approved",
        },
      });
      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "flow:status",
        data: expect.objectContaining({ status: "active", active_user_turn_id: userTurn.id }),
      }));
      const startedTurn = store.getUserTurn(userTurn.id)!;
      const inputSnapshot = JSON.parse(startedTurn.inputSnapshotJson!) as Record<string, unknown>;
      expect(inputSnapshot.type).toBe("spec");
      expect(inputSnapshot.diff_baseline).toEqual(expect.objectContaining({
        kind: expect.stringMatching(/git|hash/),
        root_path: expect.any(String),
      }));
      expect(startedTurn.workRootPath).toBe((inputSnapshot.diff_baseline as { root_path: string }).root_path);
      expect(store.getSpecRevision(specPlan.spec.id)?.status).toBe("executed");
      expect(store.getSpecApproval(specPlan.approval.id)?.status).toBe("approved");

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects the removed Flow agent mode websocket message", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-mode",
      workspaceId: "ws-default",
      name: "Mode",
      description: "",
      projectId: null,
    });
    const app = createApp({ logger: false, store });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id } }));
      await nextWsMessage(ws);

      ws.send(JSON.stringify({
        data: {
          type: "flow:set_agent_mode",
          flow_id: flow.id,
          agent_mode: "spec",
          log_id: "log-mode",
        },
      }));

      expect(await nextWsMessage(ws)).toEqual({
        type: "system:error",
        flow_id: flow.id,
        log_id: "log-mode",
        data: expect.objectContaining({ code: "invalid_message" }),
      });
      expect(store.getFlow(flow.id)?.legacySpecFlow).toBe(0);

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("resolves a UserTurn decision card and resumes Leader", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-decision",
      workspaceId: "ws-default",
      name: "Decision Flow",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader-decision",
      displayName: "Leader",
    });
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-decision",
      sessionId: "sdk-leader-decision",
      cardType: "generic",
      questions: [{ question: "用什么写？", options: [{ label: "HTML", description: "HTML" }] }],
    });
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-leader-decision", is_error: false },
      ]) }),
    } as any);

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({
        data: {
          type: "flow:decision",
          flow_id: flow.id,
          card_id: "dc-decision",
          answers: { impl: "HTML" },
          log_id: "log-decision",
        },
      }));

      expect(await nextWsMessage(ws)).toEqual({
        type: "flow:decision_card_resolved",
        flow_id: flow.id,
        log_id: "log-decision",
        data: expect.objectContaining({
          card_id: "dc-decision",
          user_turn_id: userTurn.id,
          answers: { impl: "HTML" },
          status: "resolved",
          leader_agent_session_id: leader.id,
        }),
      });
      expect(store.listDecisionCards(flow.id)[0]?.status).toBe("resolved");

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("cancels an active UserTurn and its unfinished tasks", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-cancel",
      workspaceId: "ws-default",
      name: "Cancel Flow",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const app = createApp({ logger: false, store });

    try {
      await app.ready();
      const ws = await app.injectWS("/api/ws");
      ws.send(JSON.stringify({ data: { type: "flow:subscribe", flow_id: flow.id } }));
      await nextWsMessage(ws);
      ws.send(JSON.stringify({
        data: {
          type: "user_turn:cancel",
          flow_id: flow.id,
          user_turn_id: userTurn.id,
          log_id: "log-cancel",
        },
      }));

      expect(await nextWsMessage(ws)).toEqual(expect.objectContaining({
        type: "task:event",
        flow_id: flow.id,
        data: expect.objectContaining({ task_id: task.id, status: "cancelled" }),
      }));
      expect(await nextWsMessage(ws)).toEqual({
        type: "user_turn:event",
        flow_id: flow.id,
        log_id: "log-cancel",
        data: expect.objectContaining({
          user_turn_id: userTurn.id,
          status: "cancelled",
          flow_status: "idle",
        }),
      });
      expect(store.getUserTurn(userTurn.id)?.status).toBe("cancelled");
      expect(store.getTask(task.id)?.status).toBe("cancelled");

      ws.terminate();
    } finally {
      await app.close();
    }
  });

  it("cancels the open UserTurn and interrupts its running sessions", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-cancel-turn",
      workspaceId: "ws-default",
      name: "Cancel Turn",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-leader",
      displayName: "Leader",
      status: "streaming",
    });
    store.updateFlow(flow.id, { leaderSessionId: "sdk-leader" });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Verify",
      description: "Verify",
      expertId: "exp-verify",
      dependsOnTaskIds: [],
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-verify" });
    store.updateFlowExpertStatus(flowExpert.id, "streaming");
    const expertSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-verify",
      flowExpertId: flowExpert.id,
      sessionId: "sdk-verify",
      displayName: "Verify",
      status: "streaming",
    });
    const plan = store.createOrchestrationPlanRevision({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Cancel plan",
      objective: "Verify cancellation",
      workKind: "change",
      riskLevel: "low",
      status: "approved",
      lint: [],
      diff: {},
      nodes: [{
        nodeId: "code",
        expertId: "exp-coder",
        title: "Build",
        description: "Build",
        dependsOn: [],
        acceptanceCriteria: ["Done"],
        riskTags: [],
        sideEffects: [],
        resourceKeys: [],
      }],
    })!;
    const planRun = store.materializePlanRun(plan.revision.id)!;
    const sent: unknown[] = [];
    const cancelledLeaderFlows: string[] = [];
    const cancelledExpertTurns: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "test-client", (message) => sent.push(message));
    const connection: WsConnection = {
      clientId: "client-1",
      subscriptions: new Set(),
      eventBus,
      store,
      chatJournal: new ChatJournal(),
      leaderRuntime: {
        runLeaderTurn: async () => undefined,
        cancelFlow: (flowId) => {
          cancelledLeaderFlows.push(flowId);
          return true;
        },
      },
      expertRuntime: {
        cancelUserTurn: (input) => {
          cancelledExpertTurns.push(input);
          return 1;
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({
      data: {
        type: "user_turn:cancel",
        flow_id: flow.id,
        user_turn_id: userTurn.id,
        log_id: "log-cancel-turn",
      },
    }), connection);

    expect(cancelledLeaderFlows).toEqual([flow.id]);
    expect(cancelledExpertTurns).toEqual([
      expect.objectContaining({ flowId: flow.id, userTurnId: userTurn.id }),
    ]);
    expect(store.getUserTurn(userTurn.id)?.status).toBe("cancelled");
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.getAgentSession(leader.id)?.status).toBe("interrupted");
    expect(store.getAgentSession(expertSession.id)?.status).toBe("interrupted");
    expect(store.getFlowExpert(flowExpert.id)?.status).toBe("idle");
    expect(store.getPlanRun(planRun.id)?.status).toBe("cancelled");
    expect(sent).toContainEqual(expect.objectContaining({
      type: "plan_run:event",
      flow_id: flow.id,
      data: expect.objectContaining({
        plan_run_id: planRun.id,
        plan_revision_id: plan.revision.id,
        status: "cancelled",
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: "user_turn:event",
      flow_id: flow.id,
      log_id: "log-cancel-turn",
      data: expect.objectContaining({
        user_turn_id: userTurn.id,
        status: "cancelled",
      }),
    }));
  });
});

describe("Task 5 decision-card delivery", () => {
  it("cancels a card once and delivers one Leader cancellation input", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-decision-cancel",
      workspaceId: "ws-default",
      name: "Decision Cancel",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "leader-sdk",
      displayName: "Leader",
    });
    store.updateFlow(flow.id, { leaderSessionId: "leader-sdk" });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-cancel-card" })!;
    store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      sessionId: "leader-sdk",
      cardId: "dc-1",
      cardType: "clarification",
      questions: [{ question: "选哪个？", header: "选择", multiSelect: false, options: [] }],
    });
    store.pauseUserTurnForUserAction(userTurn.id);
    const sent: unknown[] = [];
    const capturedTurns: unknown[] = [];
    const connection: WsConnection = {
      clientId: "client-decision-cancel",
      subscriptions: new Set(),
      eventBus: new EventBus(),
      store,
      chatJournal: new ChatJournal(),
      leaderRuntime: {
        runLeaderTurn: async (turn) => { capturedTurns.push(turn); },
      },
      send: async (message) => { sent.push(message); },
    };

    const request = JSON.stringify({ data: {
      type: "flow:decision_cancel",
      flow_id: flow.id,
      card_id: "dc-1",
      client_action_id: "cancel-1",
    } });
    await handleWsClientMessage(request, connection);
    await Promise.resolve();

    expect(store.getDecisionCard("dc-1")?.status).toBe("cancelled");
    expect(sent).toContainEqual(expect.objectContaining({
      type: "flow:decision_card_resolved",
      flow_id: flow.id,
      data: expect.objectContaining({ card_id: "dc-1", status: "cancelled" }),
    }));
    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]).toEqual(expect.objectContaining({
      kind: "decision_cancelled",
      decisionCardId: "dc-1",
      leaderAgentSessionId: leader.id,
    }));

    await handleWsClientMessage(request, connection);
    await Promise.resolve();
    expect(capturedTurns).toHaveLength(1);
  });

  it("recovers a durable card-result input after a restart window", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-decision-recover",
      workspaceId: "ws-default",
      name: "Decision Recover",
      description: "",
      projectId: null,
    });
    const leader = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "leader-sdk",
      displayName: "Leader",
    });
    store.updateFlow(flow.id, { leaderSessionId: "leader-sdk" });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-recover-card" })!;
    store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      sessionId: "leader-sdk",
      cardId: "dc-recover",
      cardType: "clarification",
      questions: [],
    });
    store.pauseUserTurnForUserAction(userTurn.id);
    const resolution = store.resolveDecisionCard({
      cardId: "dc-recover",
      flowId: flow.id,
      answers: { 选择: "A" },
      actionId: "submit-recover",
      messageId: "msg-decision-recover",
      leaderInputContent: "选择: A",
    });
    expect(resolution?.newlyResolved).toBe(true);
    expect(store.listPendingDecisionCardLeaderInputs(flow.id)).toHaveLength(1);

    const capturedTurns: unknown[] = [];
    await recoverPendingDecisionCardLeaderInputs({
      store,
      leaderRuntime: { runLeaderTurn: async (turn) => { capturedTurns.push(turn); } },
    });

    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]).toEqual(expect.objectContaining({
      flowId: flow.id,
      kind: "decision",
      decisionCardId: "dc-recover",
      decisionMessageId: "msg-decision-recover",
      leaderAgentSessionId: leader.id,
      leaderSessionId: "leader-sdk",
    }));
    expect(store.listPendingDecisionCardLeaderInputs(flow.id)).toHaveLength(0);
  });
});

describe("Task 3 Flow Expert protocol", () => {

  it("accepts flow:decision_cancel in the websocket schema", () => {
    expect(() => ClientWsMessageSchema.parse({
      type: "flow:decision_cancel",
      flow_id: "flow-1",
      card_id: "dc-1",
      client_action_id: "cancel-1",
    })).not.toThrow();
  });

  it("allows metadata-only browser comments but still requires image payloads", () => {
    expect(() => ClientWsMessageSchema.parse({
      type: "flow:message",
      flow_id: "flow-1",
      content: "",
      attachments: [{
        id: "browser-1",
        kind: "browser_comment",
        marker_number: 1,
        comment: "截图失败",
        selector: "#submit",
      }],
    })).not.toThrow();
    expect(() => ClientWsMessageSchema.parse({
      type: "flow:message",
      flow_id: "flow-1",
      content: "看图",
      attachments: [{ id: "image-1", kind: "image" }],
    })).toThrow(/image attachments require media_type and data/u);
  });

  it("routes explicit permission denial separately from card cancellation and rejects ambiguous answers", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-permission-decisions",
      workspaceId: "ws-default",
      projectId: null,
      name: "Permission decisions",
      description: "",
    });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-permission-decisions" })!;
    for (const cardId of ["dc-deny", "dc-cancel", "dc-ambiguous", "dc-mixed", "dc-wrong-header", "dc-array"]) {
      store.createDecisionCard({
        flowId: flow.id,
        userTurnId: userTurn.id,
        cardId,
        sessionId: `tool-${cardId}`,
        cardType: "permission_confirmation",
        questions: [{
          header: "permission",
          question: "允许吗？",
          multiSelect: false,
          options: [],
        }],
      });
    }
    const resolutions: Array<{ cardId: string; outcome: string }> = [];
    const sent: unknown[] = [];
    const connection: WsConnection = {
      clientId: "permission-decisions-client",
      subscriptions: new Set(),
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      leaderRuntime: { runLeaderTurn: async () => undefined },
      expertRuntime: {
        cancelUserTurn: () => 0,
        resolvePermissionCard: async (input) => {
          resolutions.push({ cardId: input.cardId, outcome: input.outcome });
          return true;
        },
      },
      send: async (message) => { sent.push(message); },
    };

    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision",
      flow_id: flow.id,
      card_id: "dc-deny",
      answers: { permission: "拒绝当前命令" },
    } }), connection);
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision_cancel",
      flow_id: flow.id,
      card_id: "dc-cancel",
    } }), connection);
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision",
      flow_id: flow.id,
      card_id: "dc-ambiguous",
      answers: { permission: "稍后再说" },
      log_id: "log-ambiguous",
    } }), connection);
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision",
      flow_id: flow.id,
      card_id: "dc-mixed",
      answers: { permission: ["允许本次操作", "稍后再说"] },
      log_id: "log-mixed",
    } }), connection);
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision",
      flow_id: flow.id,
      card_id: "dc-wrong-header",
      answers: { wrong_header: "允许本次操作" },
      log_id: "log-wrong-header",
    } }), connection);
    await handleWsClientMessage(JSON.stringify({ data: {
      type: "flow:decision",
      flow_id: flow.id,
      card_id: "dc-array",
      answers: { permission: ["拒绝当前命令"] },
      log_id: "log-array",
    } }), connection);

    expect(resolutions).toEqual([
      { cardId: "dc-deny", outcome: "user_denied" },
      { cardId: "dc-cancel", outcome: "card_cancelled" },
    ]);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "system:error",
      flow_id: flow.id,
      log_id: "log-ambiguous",
      data: expect.objectContaining({ code: "invalid_permission_decision" }),
    }));
    for (const logId of ["log-mixed", "log-wrong-header", "log-array"]) {
      expect(sent).toContainEqual(expect.objectContaining({
        type: "system:error",
        flow_id: flow.id,
        log_id: logId,
        data: expect.objectContaining({ code: "invalid_permission_decision" }),
      }));
    }
  });
});

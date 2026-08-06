import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { WsPusher } from "../src/ws/pusher.js";
import { EventBus } from "../src/ws/eventBus.js";

const tempDirs: string[] = [];

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-canonical-transcript-"));
  tempDirs.push(dir);
  return path.join(dir, "squadflow.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("canonical transcript persistence", () => {
  it("closes stale Leader runtime state on restart without creating a visible interruption message", () => {
    const store = createStore(":memory:");
    store.migrate();
    const flow = store.createFlow({ id: "flow-restart", workspaceId: "ws-default", name: "Restart", description: "", projectId: null });
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-user-restart" })!;
    const leader = store.createAgentSession({
      flowId: flow.id,
      workRunId: turn.id,
      expertId: "exp-leader",
      sessionId: "sdk-session-restart",
      status: "streaming",
    })!;
    const journal = new ChatJournal(store);
    journal.recordUserMessage(flow.id, leader.sessionId!, "重启前消息", "msg-user-restart", undefined, leader.id, undefined, leader.id);
    journal.record(flow.id, leader.sessionId!, { type: "start", messageId: "msg-assistant-restart" }, leader.id, leader.id);
    journal.record(flow.id, leader.sessionId!, { type: "text-delta", id: "text-restart", delta: "最后已提交内容" }, leader.id, leader.id);

    expect(store.sealActiveTranscriptMessages()).toBe(1);
    expect(store.interruptStaleLeaderSessions()).toEqual({
      interruptedLeaderSessions: 1,
      finalizedWorkRuns: 0,
    });

    expect(store.getAgentSession(leader.id)?.status).toBe("interrupted");
    expect(store.getWorkRun(turn.id)?.status).toBe("ready");
    expect(store.getFlow(flow.id)?.status).toBe("idle");
    expect(journal.getTranscriptMessages(flow.id, leader.id).map((message) => message.content)).toEqual([
      "重启前消息",
      "最后已提交内容",
    ]);
    store.sqlite.close();
  });

  it("survives a backend restart without reading provider history", () => {
    const databasePath = tempDatabase();
    const firstStore = createStore(databasePath);
    firstStore.migrate();
    const firstJournal = new ChatJournal(firstStore);

    firstJournal.recordUserMessage(
      "flow-1",
      "sdk-session-1",
      "同样的文本",
      "msg-user-1",
      "2026-07-18T10:00:00.000Z",
      "ags-leader-1",
      undefined,
      "ags-leader-1",
    );
    firstJournal.recordUserMessage(
      "flow-1",
      "sdk-session-1",
      "同样的文本",
      "msg-user-2",
      "2026-07-18T10:00:01.000Z",
      "ags-leader-1",
      undefined,
      "ags-leader-1",
    );
    firstJournal.record(
      "flow-1",
      "sdk-session-1",
      { type: "start", messageId: "msg-assistant-1", startedAt: "2026-07-18T10:00:02.000Z" },
      "ags-leader-1",
      "ags-leader-1",
    );
    firstJournal.record(
      "flow-1",
      "sdk-session-1",
      { type: "text-delta", id: "text-1", delta: "只提交到一半" },
      "ags-leader-1",
      "ags-leader-1",
    );
    firstStore.sqlite.close();

    const restartedStore = createStore(databasePath);
    restartedStore.migrate();
    const restartedJournal = new ChatJournal(restartedStore);
    const messages = restartedJournal.getTranscriptMessages("flow-1", "ags-leader-1");

    expect(messages.map((message) => message.id)).toEqual([
      "msg-user-1",
      "msg-user-2",
      "msg-assistant-1",
    ]);
    expect(messages[2]).toEqual(expect.objectContaining({
      role: "assistant",
      parts: [expect.objectContaining({ id: "text-1", text: "只提交到一半" })],
    }));
    expect(restartedJournal.getCurrentMessage("flow-1", "sdk-session-1")).toBeNull();
    restartedStore.sqlite.close();
  });

  it("stores Guide boundaries in canonical order", () => {
    const store = createStore(":memory:");
    store.migrate();
    const journal = new ChatJournal(store);
    const record = (event: Record<string, unknown>) => journal.record(
      "flow-1",
      "sdk-session-1",
      event,
      "ags-leader-1",
      "ags-leader-1",
    );

    journal.recordUserMessage("flow-1", "sdk-session-1", "初始需求", "msg-user-1", undefined, "ags-leader-1", undefined, "ags-leader-1");
    record({ type: "start", messageId: "msg-assistant-1", startedAt: "2026-07-18T10:00:00.000Z" });
    record({ type: "text-delta", id: "before", delta: "引导前。" });
    journal.recordUserMessage(
      "flow-1",
      "sdk-session-1",
      "改成十八次",
      "msg-guide-1",
      "2026-07-18T10:00:01.000Z",
      "ags-leader-1",
      { localMessageKind: "running-guide", guideStatusLabel: "已引导对话" },
      "ags-leader-1",
    );
    record({ type: "text-end", id: "before" });
    record({ type: "text-delta", id: "after", delta: "引导后。" });
    record({ type: "finish", finishedAt: "2026-07-18T10:00:02.000Z", durationMs: 2_000 });

    expect(journal.getTranscriptMessages("flow-1", "ags-leader-1").map((message) => `${message.id}:${message.content}`)).toEqual([
      "msg-user-1:初始需求",
      "msg-assistant-1:引导前。",
      "msg-guide-1:改成十八次",
      "msg-assistant-1:guide-1:引导后。",
    ]);
    store.sqlite.close();
  });

  it("replaces an empty assistant placeholder when Guide arrives before output", () => {
    const store = createStore(":memory:");
    store.migrate();
    const journal = new ChatJournal(store);
    const record = (event: Record<string, unknown>) => journal.record(
      "flow-1",
      "sdk-session-1",
      event,
      "ags-leader-1",
      "ags-leader-1",
    );

    journal.recordUserMessage("flow-1", "sdk-session-1", "初始需求", "msg-user-1", undefined, "ags-leader-1", undefined, "ags-leader-1");
    record({ type: "start", messageId: "msg-assistant-1", startedAt: "2026-07-18T10:00:00.000Z" });
    const guideCommit = journal.recordUserMessage(
      "flow-1",
      "sdk-session-1",
      "立刻改方向",
      "msg-guide-1",
      "2026-07-18T10:00:01.000Z",
      "ags-leader-1",
      { localMessageKind: "running-guide", guideStatusLabel: "已引导对话" },
      "ags-leader-1",
    );
    expect(guideCommit.removedMessageIds).toEqual(["msg-assistant-1"]);
    expect(guideCommit.activeTurn).toEqual(expect.objectContaining({
      messageId: "msg-assistant-1:guide-1",
      rootMessageId: "msg-assistant-1",
      segmentIndex: 1,
    }));
    record({ type: "text-delta", id: "after", delta: "按新方向回答。" });
    record({ type: "finish", finishedAt: "2026-07-18T10:00:02.000Z", durationMs: 2_000 });

    expect(journal.getTranscriptMessages("flow-1", "ags-leader-1").map((message) => `${message.id}:${message.content}`)).toEqual([
      "msg-user-1:初始需求",
      "msg-guide-1:立刻改方向",
      "msg-assistant-1:guide-1:按新方向回答。",
    ]);
    store.sqlite.close();
  });

  it("announces the canonical continuation when a running tool reaches the Guide boundary", () => {
    const store = createStore(":memory:");
    store.migrate();
    const journal = new ChatJournal(store);
    const record = (event: Record<string, unknown>) => journal.record(
      "flow-1",
      "sdk-session-1",
      event,
      "ags-leader-1",
      "ags-leader-1",
    );

    record({ type: "start", messageId: "msg-assistant-1", startedAt: "2026-07-18T10:00:00.000Z" });
    record({ type: "tool-input-start", toolCallId: "tool-1", toolName: "Read" });
    journal.recordUserMessage(
      "flow-1",
      "sdk-session-1",
      "工具结束后换方向",
      "msg-guide-1",
      "2026-07-18T10:00:01.000Z",
      "ags-leader-1",
      { localMessageKind: "running-guide", guideStatusLabel: "已引导对话" },
      "ags-leader-1",
    );
    const boundaryCommit = record({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "ok", is_error: false },
    });

    expect(boundaryCommit.messageId).toBe("msg-assistant-1");
    expect(boundaryCommit.activeTurn).toEqual(expect.objectContaining({
      messageId: "msg-assistant-1:guide-1",
      rootMessageId: "msg-assistant-1",
      segmentIndex: 1,
    }));
    expect(journal.getTranscriptMessages("flow-1", "ags-leader-1").map((message) => message.id)).toEqual([
      "msg-assistant-1",
      "msg-guide-1",
      "msg-assistant-1:guide-1",
    ]);
    store.sqlite.close();
  });

  it("persists only messages changed by the current stream event", () => {
    const committedMessageIds: string[][] = [];
    let cursor = 0;
    const persistence = {
      commitTranscriptMutation(input: { messages: Array<{ message: { id?: unknown } }> }) {
        committedMessageIds.push(input.messages.map((item) => String(item.message.id)));
        return ++cursor;
      },
      getTranscriptCursor() {
        return cursor;
      },
      listTranscriptEntries() {
        return [];
      },
      renameTranscriptSession() {},
    };
    const journal = new ChatJournal(persistence as never);

    journal.recordUserMessage("flow-1", "sdk-session-1", "data:image/png;base64,large", "msg-user-1");
    journal.record("flow-1", "sdk-session-1", { type: "start", messageId: "msg-assistant-1" });
    journal.record("flow-1", "sdk-session-1", { type: "text-delta", id: "text-1", delta: "a" });
    journal.record("flow-1", "sdk-session-1", { type: "text-delta", id: "text-1", delta: "b" });

    expect(committedMessageIds).toEqual([
      ["msg-user-1"],
      ["msg-assistant-1"],
      ["msg-assistant-1"],
      ["msg-assistant-1"],
    ]);
  });

  it("keeps MCP icons in the live Flow but strips them from transcript storage", () => {
    const store = createStore(":memory:");
    store.migrate();
    const journal = new ChatJournal(store);
    const mcp = {
      server: "context7",
      tool: "query-docs",
      serverIcons: [{
        src: "https://context7.com/context7-icon-green.png",
        mimeType: "image/png",
      }],
    };

    journal.record("flow-icons", "sdk-icons", { type: "start", messageId: "msg-icons" });
    journal.record("flow-icons", "sdk-icons", {
      type: "tool-input-available",
      toolCallId: "tool-context7",
      toolName: "mcp__context7__query-docs",
      mcp,
      input: { query: "React" },
    });

    expect(journal.getCurrentMessage("flow-icons", "sdk-icons")?.parts).toEqual([
      expect.objectContaining({ mcp }),
    ]);
    expect(store.listTranscriptEntries("flow-icons", "sdk-icons")[0]?.message).toEqual(expect.objectContaining({
      parts: [expect.objectContaining({
        mcp: { server: "context7", tool: "query-docs" },
      })],
    }));
    store.sqlite.close();
  });

  it("does not publish a websocket event when the transcript commit fails", async () => {
    const persistence = {
      commitTranscriptMutation() {
        throw new Error("disk full");
      },
      getTranscriptCursor() {
        return 0;
      },
      listTranscriptEntries() {
        return [];
      },
      renameTranscriptSession() {},
    };
    const journal = new ChatJournal(persistence as never);
    const eventBus = new EventBus();
    const received: unknown[] = [];
    eventBus.subscribe("flow-1", "test", (message) => received.push(message));
    const pusher = new WsPusher(
      "flow-1",
      () => "sdk-session-1",
      "ags-leader-1",
      eventBus,
      journal,
      undefined,
      "ags-leader-1",
    );

    await expect(pusher.consume({ type: "start", messageId: "msg-assistant-1", seq: 1 }))
      .rejects.toThrow("disk full");
    expect(received).toEqual([]);
  });
});

describe("canonical backend queue", () => {
  it("persists accepted items and their order", () => {
    const databasePath = tempDatabase();
    const firstStore = createStore(databasePath);
    firstStore.migrate();
    firstStore.addQueuedMessage({ id: "msg-user-1", flowId: "flow-1", payloadHash: "hash-1", payload: { content: "第一条" } });
    firstStore.addQueuedMessage({ id: "msg-user-2", flowId: "flow-1", payloadHash: "hash-2", payload: { content: "第二条" } });
    expect(firstStore.reorderQueuedMessages("flow-1", ["msg-user-2", "msg-user-1"])).toBe(true);
    firstStore.sqlite.close();

    const restartedStore = createStore(databasePath);
    restartedStore.migrate();
    expect(restartedStore.listQueuedMessages("flow-1").map((item) => [item.id, item.payload.content])).toEqual([
      ["msg-user-2", "第二条"],
      ["msg-user-1", "第一条"],
    ]);
    restartedStore.sqlite.close();
  });
});

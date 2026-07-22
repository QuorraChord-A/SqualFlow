import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";
import { finishInterruptedTurn } from "../src/ws/pusher.js";

describe("finishInterruptedTurn", () => {
  it("persists and publishes the canonical interrupted turn timing", async () => {
    const store = createStore(":memory:");
    store.migrate();
    const journal = new ChatJournal(store);
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe("flow-1", "test-client", (event) => events.push(event));

    journal.record("flow-1", "sdk-session-1", {
      type: "start",
      messageId: "msg-assistant-1",
      seq: 0,
      startedAt: "2026-07-21T08:00:00.000Z",
    }, "flow-expert-1", "agent-session-1");
    journal.record("flow-1", "sdk-session-1", {
      type: "text-start",
      messageId: "msg-assistant-1",
      seq: 1,
      id: "text-1",
    }, "flow-expert-1", "agent-session-1");
    journal.record("flow-1", "sdk-session-1", {
      type: "text-delta",
      messageId: "msg-assistant-1",
      seq: 2,
      id: "text-1",
      delta: "正在处理",
    }, "flow-expert-1", "agent-session-1");

    await expect(finishInterruptedTurn({
      flowId: "flow-1",
      sessionId: "sdk-session-1",
      transcriptId: "flow-expert-1",
      agentSessionId: "agent-session-1",
      flowExpertId: "flow-expert-1",
      eventBus,
      chatJournal: journal,
      finishedAt: "2026-07-21T08:00:02.500Z",
    })).resolves.toEqual({
      messageId: "msg-assistant-1",
      startedAt: "2026-07-21T08:00:00.000Z",
      finishedAt: "2026-07-21T08:00:02.500Z",
      durationMs: 2500,
    });

    expect(store.listTranscriptEntries("flow-1", "flow-expert-1")[0]?.message).toEqual(expect.objectContaining({
      id: "msg-assistant-1",
      metadata: {
        turnTiming: {
          startedAt: "2026-07-21T08:00:00.000Z",
          finishedAt: "2026-07-21T08:00:02.500Z",
          durationMs: 2500,
        },
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "session:transcript_event",
      data: expect.objectContaining({
        event: {
          type: "turn-finished",
          messageId: "msg-assistant-1",
          finishedAt: "2026-07-21T08:00:02.500Z",
          durationMs: 2500,
        },
      }),
    }));
  });
});

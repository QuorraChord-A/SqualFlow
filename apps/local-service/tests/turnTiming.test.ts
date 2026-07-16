import { describe, expect, it } from "vitest";
import { mergeTurnTimings, persistedTurnTimings } from "../src/ws/turnTiming.js";
import type { ChatUIMessage } from "../src/ws/chatJournal.js";

describe("turn timing", () => {
  it("extracts persisted timings for the requested SDK session", () => {
    const events = [
      {
        eventType: "agent_session.turn_completed",
        payloadJson: JSON.stringify({
          message_id: "msg-1",
          agent_session_id: "ags-1",
          sdk_session_id: "sdk-1",
          started_at: "2026-06-18T08:36:30.000Z",
          finished_at: "2026-06-18T08:36:34.192Z",
          duration_ms: 4192,
        }),
        sequence: 1,
      },
      {
        eventType: "agent_session.turn_completed",
        payloadJson: JSON.stringify({
          message_id: "msg-2",
          agent_session_id: "ags-1",
          sdk_session_id: "sdk-other",
          started_at: "2026-06-18T08:37:00.000Z",
          finished_at: "2026-06-18T08:37:01.000Z",
          duration_ms: 1000,
        }),
        sequence: 2,
      },
    ];

    const timings = persistedTurnTimings(events, "sdk-1");
    expect(timings).toEqual([
      {
        sdkSessionId: "sdk-1",
        messageId: "msg-1",
        startedAt: "2026-06-18T08:36:30.000Z",
        finishedAt: "2026-06-18T08:36:34.192Z",
        durationMs: 4192,
      },
    ]);
  });

  it("merges persisted timings to the newest matching assistant turns", () => {
    const messages: ChatUIMessage[] = [
      { id: "msg-user", role: "user", parts: [{ type: "text", text: "hi" }], content: "hi" },
      { id: "msg-1", role: "assistant", parts: [{ type: "text", text: "first" }], content: "first" },
      { id: "msg-2", role: "assistant", parts: [{ type: "text", text: "second" }], content: "second" },
      { id: "msg-3", role: "assistant", parts: [{ type: "text", text: "third" }], content: "third" },
    ];

    const timings = [
      {
        sdkSessionId: "sdk-1",
        messageId: "persisted-2",
        startedAt: "2026-06-18T08:36:30.000Z",
        finishedAt: "2026-06-18T08:36:34.000Z",
        durationMs: 4000,
      },
      {
        sdkSessionId: "sdk-1",
        messageId: "persisted-3",
        startedAt: "2026-06-18T08:37:00.000Z",
        finishedAt: "2026-06-18T08:37:02.000Z",
        durationMs: 2000,
      },
    ];

    const merged = mergeTurnTimings(messages, timings);
    expect(merged[1]!.metadata?.turnTiming).toBeUndefined();
    expect(merged[2]).toMatchObject({
      role: "assistant",
      id: "msg-2",
      metadata: {
        turnTiming: {
          startedAt: "2026-06-18T08:36:30.000Z",
          finishedAt: "2026-06-18T08:36:34.000Z",
          durationMs: 4000,
        },
      },
    });
    expect(merged[3]).toMatchObject({
      role: "assistant",
      id: "msg-3",
      metadata: {
        turnTiming: {
          startedAt: "2026-06-18T08:37:00.000Z",
          finishedAt: "2026-06-18T08:37:02.000Z",
          durationMs: 2000,
        },
      },
    });
  });

  it("does not reorder messages when merging", () => {
    const messages: ChatUIMessage[] = [
      { id: "msg-1", role: "assistant", parts: [{ type: "text", text: "first" }], content: "first" },
      { id: "msg-2", role: "assistant", parts: [{ type: "text", text: "second" }], content: "second" },
    ];

    const timings = [
      {
        sdkSessionId: "sdk-1",
        messageId: "persisted-2",
        startedAt: "2026-06-18T08:36:34.000Z",
        finishedAt: "2026-06-18T08:36:34.000Z",
        durationMs: 0,
      },
    ];

    const merged = mergeTurnTimings(messages, timings);
    expect(merged.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
  });
});

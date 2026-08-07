import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { runClaudeAgent, type ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";
import { WsPusher } from "../src/ws/pusher.js";

function createQuery(messages: unknown[], onClose?: () => void): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close() {
      onClose?.();
    },
  };
}

describe("runClaudeAgent", () => {
  it("streams Claude SDK messages into websocket chunks and records sdk session id", async () => {
    const startedAt = "2026-06-23T10:00:00.000Z";
    const eventBus = new EventBus();
    const journal = new ChatJournal();
    const published: unknown[] = [];
    eventBus.subscribe("flow-1", "client-1", (message) => {
      published.push(message);
    });
    const pusher = new WsPusher("flow-1", () => "sdk-initial", "ags-1", eventBus, journal);
    const queryCalls: Array<{ prompt: string; options?: Options }> = [];
    const sdkSessionIds: string[] = [];

    const result = await runClaudeAgent({
      prompt: "写个 helloworld",
      options: { cwd: "/repo" },
      messageId: "msg-1",
      startedAt,
      pusher,
      query: (input) => {
        queryCalls.push(input);
        return createQuery([
          { type: "stream_event", event: { delta: { type: "text_delta", text: "收到" } } },
          { type: "result", subtype: "success", session_id: "sdk-real-session", is_error: false, duration_ms: 4321 },
        ]);
      },
      onSdkSessionId: (sessionId) => sdkSessionIds.push(sessionId),
    });

    expect(queryCalls).toEqual([{ prompt: "写个 helloworld", options: { cwd: "/repo" } }]);
    expect(result).toMatchObject({
      sdkSessionId: "sdk-real-session",
      resultStatus: "success",
      resultIsError: false,
      durationMs: 4321,
    });

    expect(journal.getHistory("flow-1", "sdk-initial")).toEqual([
      expect.objectContaining({
        id: "msg-1",
        role: "assistant",
        parts: [expect.objectContaining({ type: "text", text: "收到" })],
        content: "收到",
        createdAt: startedAt,
        metadata: expect.objectContaining({
          messageKind: "assistant",
          presentationTurnId: "msg-1",
          agentRunId: "ags-1",
          turnTiming: {
            startedAt,
            finishedAt: expect.any(String),
            durationMs: 4321,
          },
        }),
      }),
    ]);
    expect(published.map((message) => (message as { data: { event: { type: string } } }).data.event.type)).toEqual([
      "turn-started",
      "text-start",
      "text-delta",
      "text-end",
      "turn-finished",
    ]);
    expect(published[0]).toMatchObject({ data: { event: { type: "turn-started", startedAt } } });
  });

  it("returns the final assistant text from a successful SDK result message", async () => {
    const eventBus = new EventBus();
    const journal = new ChatJournal();
    const pusher = new WsPusher("flow-1", () => "sdk-initial", "ags-1", eventBus, journal);

    const result = await runClaudeAgent({
      prompt: "verify",
      options: {},
      messageId: "msg-structured",
      pusher,
      query: () => createQuery([
        { type: "stream_event", event: { delta: { type: "text_delta", text: "verified" } } },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session",
          is_error: false,
          duration_ms: 4321,
        },
      ]),
    });

    expect(result).toMatchObject({
      sdkSessionId: "sdk-session",
      resultStatus: "success",
      resultIsError: false,
      durationMs: 4321,
    });
    expect(result.finalAssistantText).toBe("verified");
  });

  it("closes an unfinished SDK query when streaming throws and still closes the UI message", async () => {
    const eventBus = new EventBus();
    const journal = new ChatJournal();
    const pusher = new WsPusher("flow-1", () => "sdk-initial", "ags-1", eventBus, journal);
    let closed = false;
    const query: ClaudeQueryLike = {
      async *[Symbol.asyncIterator]() {
        yield { type: "stream_event", event: { delta: { type: "text_delta", text: "partial" } } };
        throw new Error("sdk failed");
      },
      close() {
        closed = true;
      },
    };

    await expect(runClaudeAgent({
      prompt: "task",
      options: {},
      messageId: "msg-1",
      pusher,
      query: () => query,
    })).rejects.toThrow("sdk failed");

    expect(closed).toBe(true);
    expect(journal.getHistory("flow-1", "sdk-initial")[0]).toMatchObject({
      id: "msg-1",
      role: "assistant",
      content: "partial",
    });
  });
});

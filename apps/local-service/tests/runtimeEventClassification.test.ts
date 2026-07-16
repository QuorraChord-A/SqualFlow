import { describe, expect, it } from "vitest";
import { createClaudeAgentRuntimeAdapter } from "../src/runtime/adapters/claudeAgentAdapter.js";
import { createCodexAgentRuntimeAdapter } from "../src/runtime/adapters/codexAgentAdapter.js";
import type { ClaudeQueryLike } from "../src/runtime/adapters/claudeAgentAdapter.js";

function createQuery(messages: unknown[]): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    close() {},
  };
}

async function collect(input: AsyncIterable<unknown>) {
  const values: unknown[] = [];
  for await (const value of input) values.push(value);
  return values;
}

describe("runtime adapters normalize raw SDK messages into RuntimeEvent streams", () => {
  it("Claude adapter: runQuery yields turn completion, compact, failure, and other events", async () => {
    const result = { type: "result", subtype: "success", is_error: false, session_id: "s1" };
    const compact = {
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { postTokens: 500 },
    };
    const failed = {
      type: "system",
      subtype: "status",
      compact_result: "failed",
      compact_error: "boom",
    };
    const unrelated = { type: "assistant" };
    const adapter = createClaudeAgentRuntimeAdapter({
      query: () => createQuery([result, compact, failed, unrelated]),
    });

    const events = await collect(adapter.runQuery({ prompt: "hello" }));

    expect(events[0]).toEqual({ type: "turn_completed", result: { status: "success", isError: false, sessionId: "s1" }, raw: result });
    expect(events[1]).toEqual(expect.objectContaining({ type: "compact_boundary", raw: compact }));
    expect(events[2]).toEqual({ type: "compact_failed", error: "boom", raw: failed });
    expect(events[3]).toEqual({ type: "other", raw: unrelated });
    expect("classifyEvent" in adapter).toBe(false);
  });

  it("Codex adapter: runQuery yields normalized turn, compact, and other events", async () => {
    const codexEvents = [
      { method: "item/agentMessage/delta", params: {} },
      {
        method: "thread/compacted",
        params: { threadId: "thread-1", postTokens: 42 },
      },
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      },
    ];
    const adapter = createCodexAgentRuntimeAdapter({
      clientFactory: () => ({
        start: async () => {},
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "thread-1" } };
          if (method === "turn/start") return { turn: { id: "turn-1" } };
          throw new Error(`unexpected request: ${method}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => {},
        notifications: async function* () {
          for (const event of codexEvents) yield event;
        },
      }),
    });

    const events = await collect(adapter.runQuery({
      prompt: adapter.createSingleTextInput("hello"),
      options: {
        cwd: "/tmp/project",
        sandboxMode: "workspace-write",
        systemPrompt: "test",
        model: "model-1",
        config: {},
      },
    }));

    expect(events[0]).toEqual({ type: "other", raw: codexEvents[0] });
    expect(events[1]).toEqual(expect.objectContaining({ type: "compact_boundary", raw: codexEvents[1] }));
    expect(events[2]).toEqual({ type: "turn_completed", result: { status: "success", isError: false, sessionId: "thread-1" }, raw: codexEvents[2] });
    expect("classifyEvent" in adapter).toBe(false);
  });

  it("both adapters declare capabilities", () => {
    expect(createClaudeAgentRuntimeAdapter().capabilities).toEqual({
      steer: true,
      compact: true,
      historyRead: true,
      imageInput: true,
      tokenUsage: true,
      toolApproval: true,
    });
    expect(createCodexAgentRuntimeAdapter().capabilities).toEqual({
      steer: true,
      compact: true,
      historyRead: true,
      imageInput: true,
      tokenUsage: true,
      toolApproval: true,
    });
  });
});

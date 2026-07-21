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

  it("Claude adapter: absorbs the aborted_streaming echo of a now-interrupted turn", async () => {
    const echo = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "s1",
      terminal_reason: "aborted_streaming",
    };
    const real = { type: "result", subtype: "success", is_error: false, session_id: "s1", terminal_reason: "completed" };
    const adapter = createClaudeAgentRuntimeAdapter({
      query: () => createQuery([echo, real]),
    });

    const events = await collect(adapter.runQuery({ prompt: "hello" }));

    expect(events[0]).toEqual({
      type: "turn_absorbed",
      reason: "aborted_streaming",
      result: { status: "error_during_execution", isError: true, sessionId: "s1" },
      raw: echo,
    });
    expect(events[1]).toEqual(expect.objectContaining({ type: "turn_completed" }));
  });

  it("Claude adapter: falls back to the subtype heuristic only while a now injection is in flight", async () => {
    // No terminal_reason on either result (older SDK shape).
    const echoWithoutReason = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" };
    const real = { type: "result", subtype: "success", is_error: false, session_id: "s1" };
    async function* prompt() {
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "guide" }] },
        parent_tool_use_id: null,
        priority: "now",
        timestamp: new Date().toISOString(),
      };
    }
    const adapter = createClaudeAgentRuntimeAdapter({
      query: (input) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _message of input.prompt as AsyncIterable<unknown>) break;
          yield echoWithoutReason;
          yield real;
        },
        close() {},
      }),
    });

    const events = await collect(adapter.runQuery({ prompt: prompt() }));

    expect(events[0]).toEqual(expect.objectContaining({ type: "turn_absorbed", reason: "now_injection_echo" }));
    expect(events[1]).toEqual(expect.objectContaining({ type: "turn_completed" }));
  });

  it("Claude adapter: does NOT absorb a genuine execution error when no injection is in flight", async () => {
    const genuineError = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" };
    const adapter = createClaudeAgentRuntimeAdapter({
      query: () => createQuery([genuineError]),
    });

    const events = await collect(adapter.runQuery({ prompt: "hello" }));

    expect(events[0]).toEqual(expect.objectContaining({
      type: "turn_completed",
      result: { status: "error_during_execution", isError: true, sessionId: "s1" },
    }));
  });

  it("Claude adapter: a genuine error after an absorbed echo is not swallowed", async () => {
    // now injection → echo absorbed → the follow-up turn then genuinely fails.
    const echo = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "s1",
      terminal_reason: "aborted_streaming",
    };
    const genuineError = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" };
    async function* prompt() {
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "guide" }] },
        parent_tool_use_id: null,
        priority: "now",
        timestamp: new Date().toISOString(),
      };
    }
    const adapter = createClaudeAgentRuntimeAdapter({
      query: (input) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _message of input.prompt as AsyncIterable<unknown>) break;
          yield echo;
          yield genuineError;
        },
        close() {},
      }),
    });

    const events = await collect(adapter.runQuery({ prompt: prompt() }));

    expect(events[0]).toEqual(expect.objectContaining({ type: "turn_absorbed" }));
    expect(events[1]).toEqual(expect.objectContaining({ type: "turn_completed" }));
  });

  it("Codex adapter: absorbs a turn/completed while a steer-fallback input is still pending", async () => {
    let steerAttempts = 0;
    const clientFactory = () => ({
      start: async () => {},
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: `turn-${steerAttempts + 1}` } };
        if (method === "turn/steer") {
          steerAttempts += 1;
          throw new Error("turn already completed");
        }
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
        };
      },
    });
    async function* prompt() {
      yield { type: "text", text: "first" };
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield { type: "text", text: "guide" };
    }
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });

    const events = await collect(adapter.runQuery({
      prompt: prompt(),
      options: {
        cwd: "/tmp/project",
        sandboxMode: "workspace-write",
        systemPrompt: "test",
        model: "model-1",
        config: {},
      },
    }));

    const boundaries = events.filter((event) => {
      const record = event as { type?: string };
      return record.type === "turn_completed" || record.type === "turn_absorbed";
    }) as Array<{ type: string; reason?: string }>;
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toEqual(expect.objectContaining({ type: "turn_absorbed", reason: "injection_pending" }));
    expect(boundaries[1]).toEqual(expect.objectContaining({ type: "turn_completed" }));
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

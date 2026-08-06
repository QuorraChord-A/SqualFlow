import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const claudeQueryMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeQueryMock.query,
}));

import { testClaudeRuntimeConnection } from "../src/runtime/adapters/claudeConnectionTest.js";

const runtimeConfig = {
  id: "cfg-1",
  fileName: "cfg-1.json",
  name: "agentrouter",
  sdk: "claudecode" as const,
  authMode: "apiKey" as const,
  baseUrl: "https://agentrouter.org",
  apiKey: "test-key",
  models: [{ id: "model-1", name: "claude-opus-5", contextWindowK: 1_000 }],
};

const successfulResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0,
  usage: {},
} as unknown as SDKMessage;

function streamThatYieldsThenWaitsForAbort(signal: AbortSignal, result?: SDKMessage) {
  return {
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        next() {
          if (result && !yielded) {
            yielded = true;
            return Promise.resolve({ done: false as const, value: result });
          }
          return new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new Error("Claude Code process aborted by user"));
            if (signal.aborted) {
              abort();
              return;
            }
            signal.addEventListener("abort", abort, { once: true });
          });
        },
        return() {
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Claude runtime connection test", () => {
  it("stops after a terminal result instead of waiting for process shutdown", async () => {
    vi.useFakeTimers();
    claudeQueryMock.query.mockImplementation((request) => {
      expect(request.options.env).toEqual(expect.objectContaining({
        ANTHROPIC_AUTH_TOKEN: "test-key",
        ANTHROPIC_BASE_URL: "https://agentrouter.org",
      }));
      expect(request.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      return streamThatYieldsThenWaitsForAbort(request.options.abortController.signal, successfulResult);
    });

    const resultPromise = testClaudeRuntimeConnection(runtimeConfig, { model: "claude-opus-5" });
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await resultPromise;

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sdk: "claudecode",
      model: "claude-opus-5",
      message: "连接成功",
    }));
  });

  it("labels only its own abort deadline as a timeout", async () => {
    vi.useFakeTimers();
    claudeQueryMock.query.mockImplementation((request) =>
      streamThatYieldsThenWaitsForAbort(request.options.abortController.signal));

    const resultPromise = testClaudeRuntimeConnection(runtimeConfig, { model: "claude-opus-5" });
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await resultPromise;

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: "TIMEOUT",
      message: "连接测试超时（30 秒），请检查 Base URL、模型和网络。",
    }));
  });

  it("does not classify an unrelated SDK abort as a timeout", async () => {
    claudeQueryMock.query.mockImplementation(() => {
      throw new Error("Operation aborted");
    });

    const result = await testClaudeRuntimeConnection(runtimeConfig, { model: "claude-opus-5" });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: "GENERATION_TEST_FAILED",
      message: "Operation aborted",
    }));
  });
});

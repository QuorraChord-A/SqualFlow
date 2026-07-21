import { describe, expect, it } from "vitest";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncMessageQueue } from "../src/runtime/adapters/asyncMessageQueue.js";

/**
 * Canary for the 1.10 adjudication contract: a `priority:"now"` injection must abort
 * the in-flight turn with a result carrying `terminal_reason:"aborted_streaming"`.
 * `terminal_reason` is an optional SDK field — if an SDK upgrade stops setting it,
 * this canary fails loudly instead of the adapters silently falling back.
 *
 * Requires real provider credentials via env (never committed, never printed):
 *   SQUADFLOW_CANARY_ANTHROPIC_BASE_URL / SQUADFLOW_CANARY_ANTHROPIC_API_KEY /
 *   SQUADFLOW_CANARY_ANTHROPIC_MODEL
 * Skipped when they are absent.
 */
const baseUrl = process.env.SQUADFLOW_CANARY_ANTHROPIC_BASE_URL;
const apiKey = process.env.SQUADFLOW_CANARY_ANTHROPIC_API_KEY;
const model = process.env.SQUADFLOW_CANARY_ANTHROPIC_MODEL;
const enabled = Boolean(baseUrl && apiKey && model);

function userMessage(text: string, priority: "now" | "later"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    priority,
    timestamp: new Date().toISOString(),
  };
}

describe.skipIf(!enabled)("Claude SDK now-interrupt canary", () => {
  it("emits terminal_reason aborted_streaming for the interrupted turn", async () => {
    const input = new AsyncMessageQueue<SDKUserMessage>();
    const stream = query({
      prompt: input,
      options: {
        model,
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 4,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].startsWith("ANTHROPIC_"),
            ),
          ),
          ANTHROPIC_BASE_URL: baseUrl!,
          ANTHROPIC_API_KEY: apiKey!,
        },
      },
    });

    const results: Array<{ subtype?: unknown; terminal_reason?: unknown }> = [];
    let injected = false;
    try {
      input.push(userMessage("请从 1 数到 40，每行一个数字，不要输出其他内容。", "later"));
      for await (const message of stream) {
        const record = message as { type?: string; subtype?: unknown; terminal_reason?: unknown };
        if (!injected && record.type === "stream_event") {
          injected = true;
          setTimeout(() => {
            try {
              input.push(userMessage("改口令：停止数数，只回复一个词:BANANA。", "now"));
            } catch {
              // Input already closed — the assertion below will fail the test.
            }
          }, 300);
        }
        if (record.type === "result") {
          results.push({ subtype: record.subtype, terminal_reason: record.terminal_reason });
          if (results.length >= 2) break;
        }
      }
    } finally {
      input.close();
      (stream as { close?: () => void }).close?.();
    }

    expect(injected).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0]?.terminal_reason).toBe("aborted_streaming");
    expect(results[1]?.terminal_reason).toBe("completed");
  }, 300_000);
});

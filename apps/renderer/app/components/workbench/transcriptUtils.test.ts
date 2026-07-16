import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  cloneUiMessage,
  extractMessageAgentSessionId,
  extractToolDecisionCardIds,
  lastPartIndex,
  mergeHistoryMessages,
  parseDecisionCardId,
} from "./transcriptUtils";

function message(id: string, parts: UIMessage["parts"] = []): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

function textMessage(id: string, role: UIMessage["role"], text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    content: text,
  } as UIMessage;
}

describe("transcriptUtils", () => {
  it("keeps local messages before unanchored incoming history", () => {
    const local = [message("local-1"), message("local-2")];
    const history = [message("history-1")];

    expect(mergeHistoryMessages(local, history).map((item) => item.id)).toEqual([
      "local-1",
      "local-2",
      "history-1",
    ]);
  });

  it("uses unanchored server history as canonical when it includes persisted user messages", () => {
    const local = [textMessage("local-assistant", "assistant", "Leader reply")];
    const history = [
      textMessage("history-user", "user", "你好"),
      textMessage("history-assistant", "assistant", "Leader reply"),
    ];

    expect(mergeHistoryMessages(local, history).map((item) => item.id)).toEqual([
      "history-user",
      "history-assistant",
    ]);
  });

  it("keeps live assistant output after unanchored persisted user history", () => {
    const local = [textMessage("local-assistant", "assistant", "Leader is streaming")];
    const history = [textMessage("history-user", "user", "你好")];

    expect(mergeHistoryMessages(local, history).map((item) => item.id)).toEqual([
      "history-user",
      "local-assistant",
    ]);
  });

  it("uses shared message ids as merge anchors", () => {
    const local = [message("local-1"), message("shared"), message("local-2")];
    const history = [message("history-1"), message("shared")];

    expect(mergeHistoryMessages(local, history).map((item) => item.id)).toEqual([
      "history-1",
      "local-1",
      "shared",
      "local-2",
    ]);
  });

  it("preserves a local user timestamp when incoming history omits it", () => {
    const createdAt = new Date("2026-06-19T15:10:00.000Z");
    const local = [{ ...textMessage("msg-user-1", "user", "你好"), createdAt } as UIMessage];
    const history = [textMessage("msg-user-1", "user", "你好")];

    const merged = mergeHistoryMessages(local, history);

    expect((merged[0] as UIMessage & { createdAt?: unknown }).createdAt).toBe(createdAt);
  });

  it("preserves a local user timestamp when history uses a different id", () => {
    const createdAt = new Date("2026-06-19T15:10:00.000Z");
    const local = [{ ...textMessage("local-user", "user", "你好"), createdAt } as UIMessage];
    const history = [textMessage("history-user", "user", "你好")];

    const merged = mergeHistoryMessages(local, history);

    expect((merged[0] as UIMessage & { createdAt?: unknown }).createdAt).toBe(createdAt);
  });

  it("keeps finished Expert history order even when assistant timing started before user createdAt", () => {
    const local = [{
      ...textMessage("msg-assistant-live", "assistant", "完成输出"),
      metadata: {
        turnTiming: {
          startedAt: "2026-06-23T09:21:47.904Z",
          finishedAt: "2026-06-23T09:22:12.000Z",
          durationMs: 24096,
        },
      },
    } as UIMessage];
    const history = [
      {
        ...textMessage("msg-user-sdk", "user", "请完成页面"),
        createdAt: "2026-06-23T09:21:48.817Z",
      } as UIMessage,
      {
        ...textMessage("history-assistant", "assistant", "完成输出"),
        metadata: {
          turnTiming: {
            startedAt: "2026-06-23T09:21:47.904Z",
            finishedAt: "2026-06-23T09:22:12.000Z",
            durationMs: 24096,
          },
        },
      } as UIMessage,
    ];

    const merged = mergeHistoryMessages(local, history);

    expect(merged.map((message) => message.id)).toEqual([
      "msg-user-sdk",
      "history-assistant",
    ]);
  });

  it("deduplicates live and historical decision results by card id", () => {
    const local = [textMessage(
      "live-decision",
      "user",
      "clarification_card_id: dc-1\n用户已回答澄清卡片。",
    )];
    const history = [textMessage(
      "history-decision",
      "user",
      "clarification_card_id: dc-1\n用户已回答澄清卡片。\n\n1. 验证哪个页面？\n回答：audit-template.html",
    )];

    const merged = mergeHistoryMessages(local, history);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("history-decision");
  });

  it("extracts current and legacy agent session ids", () => {
    expect(extractMessageAgentSessionId({ agent_session_id: "agent-1" })).toBe("agent-1");
    expect(extractMessageAgentSessionId({ flow_expert_id: "legacy-1" })).toBe("legacy-1");
    expect(extractMessageAgentSessionId({})).toBeUndefined();
  });

  it("parses decision card ids from supported output shapes", () => {
    expect(parseDecisionCardId({ card_id: "direct" })).toBe("direct");
    expect(parseDecisionCardId(JSON.stringify({ card_id: "json-string" }))).toBe("json-string");
    expect(parseDecisionCardId({ result: { card_id: "wrapped-result" } })).toBe("wrapped-result");
    expect(parseDecisionCardId({ result: JSON.stringify({ card_id: "wrapped-result-string" }) })).toBe(
      "wrapped-result-string",
    );
    expect(parseDecisionCardId({ content: JSON.stringify({ card_id: "wrapped-content" }) })).toBe(
      "wrapped-content",
    );
    expect(parseDecisionCardId("not-json")).toBe("");
  });

  it("finds the last part index by type", () => {
    const parts = [
      { type: "text", text: "first" },
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "last" },
    ] as UIMessage["parts"];

    expect(lastPartIndex(parts, "text")).toBe(2);
    expect(lastPartIndex(parts, "reasoning")).toBe(1);
    expect(lastPartIndex(parts, "tool-result")).toBe(-1);
  });

  it("clones UI message part object references", () => {
    const original = message("msg-1", [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "because" },
    ] as UIMessage["parts"]);

    const cloned = cloneUiMessage(original);

    expect(cloned).not.toBe(original);
    expect(cloned.parts).not.toBe(original.parts);
    expect(cloned.parts).toEqual(original.parts);
    expect(cloned.parts[0]).not.toBe(original.parts[0]);
    expect(cloned.parts[1]).not.toBe(original.parts[1]);
  });

  it("extracts decision card ids only from matching MCP tool parts", () => {
    const messages = [
      message("msg-1", [
        { type: "tool-mcp__planner__ask_user", output: { card_id: "card-1" } },
        { type: "tool-mcp__planner__not_ask_user", output: { card_id: "ignored-1" } },
        { type: "tool-other__planner__ask_user", output: { card_id: "ignored-2" } },
        {
          type: "tool-mcp__reviewer__ask_user",
          output: { result: JSON.stringify({ card_id: "card-2" }) },
        },
        { type: "text", text: "done" },
      ] as UIMessage["parts"]),
    ];

    expect(extractToolDecisionCardIds(messages)).toEqual(new Set(["card-1", "card-2"]));
  });
});

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  cloneUiMessage,
  extractMessageAgentSessionId,
  extractToolDecisionCardIds,
  lastPartIndex,
  parseDecisionCardId,
} from "./transcriptUtils";

function message(id: string, parts: UIMessage["parts"] = []): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

describe("transcriptUtils", () => {
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

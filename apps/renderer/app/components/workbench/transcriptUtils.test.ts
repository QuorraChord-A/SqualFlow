import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  cloneUiMessage,
  extractMessageAgentRunId,
  extractToolDecisionRequestIds,
  lastPartIndex,
  parseDecisionRequestId,
} from "./transcriptUtils";

function message(id: string, parts: UIMessage["parts"] = []): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

describe("transcriptUtils", () => {
  it("extracts only explicit AgentRun ids", () => {
    expect(extractMessageAgentRunId({ agent_run_id: "agent-1" })).toBe("agent-1");
    expect(extractMessageAgentRunId({ agent_session_id: "session-1" })).toBeUndefined();
    expect(extractMessageAgentRunId({})).toBeUndefined();
  });

  it("parses DecisionRequest ids from supported output shapes", () => {
    expect(parseDecisionRequestId({ decision_request_id: "direct" })).toBe("direct");
    expect(parseDecisionRequestId(JSON.stringify({ decision_request_id: "json-string" }))).toBe("json-string");
    expect(parseDecisionRequestId({ result: { decision_request_id: "wrapped-result" } })).toBe("wrapped-result");
    expect(parseDecisionRequestId({ result: JSON.stringify({ decision_request_id: "wrapped-result-string" }) })).toBe(
      "wrapped-result-string",
    );
    expect(parseDecisionRequestId({ content: JSON.stringify({ decision_request_id: "wrapped-content" }) })).toBe(
      "wrapped-content",
    );
    expect(parseDecisionRequestId("not-json")).toBe("");
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

  it("extracts DecisionRequest ids only from matching MCP tool parts", () => {
    const messages = [
      message("msg-1", [
        { type: "tool-mcp__planner__ask_user", output: { decision_request_id: "request-1" } },
        { type: "tool-mcp__planner__not_ask_user", output: { decision_request_id: "ignored-1" } },
        { type: "tool-other__planner__ask_user", output: { decision_request_id: "ignored-2" } },
        {
          type: "tool-mcp__reviewer__ask_user",
          output: { result: JSON.stringify({ decision_request_id: "request-2" }) },
        },
        { type: "text", text: "done" },
      ] as UIMessage["parts"]),
    ];

    expect(extractToolDecisionRequestIds(messages)).toEqual(new Set(["request-1", "request-2"]));
  });
});

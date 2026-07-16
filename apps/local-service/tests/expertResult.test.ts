import { describe, expect, it } from "vitest";
import { assembleExpertResult } from "../src/harness/expertResult.js";

describe("assembleExpertResult", () => {
  it("uses the final assistant text as the summary on a completed turn", () => {
    const result = assembleExpertResult({
      finalAssistantText: "验证通过，所有用例已覆盖。",
      turnOutcome: "completed",
      filesChanged: ["a.ts", "b.ts"],
      metrics: { duration_ms: 1234 },
    });

    expect(result).toEqual({
      turn_outcome: "completed",
      summary: "验证通过，所有用例已覆盖。",
      files_changed: ["a.ts", "b.ts"],
      metrics: { duration_ms: 1234 },
      error: null,
    });
  });

  it("falls back to a transcript review summary when a completed turn has no final text", () => {
    const result = assembleExpertResult({ finalAssistantText: null, turnOutcome: "completed" });

    expect(result).toEqual({
      turn_outcome: "completed",
      summary: "Expert turn completed without a final message; review the session transcript before judging completion.",
      files_changed: [],
      metrics: {},
      error: null,
    });
  });

  it("prefers the final assistant text over the error message when both are present", () => {
    const result = assembleExpertResult({
      finalAssistantText: "已经修复了大部分问题，但工具调用超时。",
      turnOutcome: "errored",
      errorMessage: "tool call timed out",
    });

    expect(result.summary).toBe("已经修复了大部分问题，但工具调用超时。");
    expect(result.error).toBe("tool call timed out");
    expect(result.turn_outcome).toBe("errored");
  });

  it("falls back to the error message as the summary when there is no final text", () => {
    const result = assembleExpertResult({
      finalAssistantText: null,
      turnOutcome: "errored",
      errorMessage: "SDK query rejected",
    });

    expect(result.summary).toBe("SDK query rejected");
    expect(result.error).toBe("SDK query rejected");
  });

  it("falls back to a generic summary when neither final text nor an error message exist", () => {
    const result = assembleExpertResult({ finalAssistantText: "", turnOutcome: "interrupted" });

    expect(result.summary).toBe("Expert turn ended without a final message");
    expect(result.error).toBeNull();
    expect(result.turn_outcome).toBe("interrupted");
  });
});

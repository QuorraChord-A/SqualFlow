import { describe, expect, it } from "vitest";
import {
  codexReasoningEffortsForModel,
  defaultCodexReasoningEffortForModel,
  parseCodexReasoningEffort,
} from "../src/runtime/codexReasoningEffort.js";

describe("Codex reasoning effort metadata", () => {
  it("exposes the official GPT-5.6 effort levels", () => {
    expect(codexReasoningEffortsForModel("gpt-5.6-terra")).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
    expect(codexReasoningEffortsForModel("gpt-5.6-sol")).toHaveLength(6);
    expect(codexReasoningEffortsForModel("gpt-5.6-luna")).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("uses each model's default and rejects unsupported levels", () => {
    expect(defaultCodexReasoningEffortForModel("gpt-5.6-sol")).toBe("low");
    expect(defaultCodexReasoningEffortForModel("gpt-5.6-terra")).toBe("medium");
    expect(parseCodexReasoningEffort("gpt-5.6-luna", "ultra")).toBeNull();
    expect(parseCodexReasoningEffort("gpt-5.6-terra", "ultra")).toBe("ultra");
  });
});

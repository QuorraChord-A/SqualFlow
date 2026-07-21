import { describe, expect, it } from "vitest";
import {
  defaultRuntimeReasoningEffortForSdk,
  parseRuntimeReasoningEffort,
  runtimeReasoningEffortsForSdk,
} from "../src/runtime/codexReasoningEffort.js";

describe("SDK reasoning effort values", () => {
  it("uses fixed SDK-level values", () => {
    expect(runtimeReasoningEffortsForSdk("claudecode")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(runtimeReasoningEffortsForSdk("codex")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("uses SDK defaults and rejects unsupported levels", () => {
    expect(defaultRuntimeReasoningEffortForSdk("claudecode")).toBe("high");
    expect(defaultRuntimeReasoningEffortForSdk("codex")).toBe("medium");
    expect(parseRuntimeReasoningEffort("claudecode", "ultra")).toBeNull();
    expect(parseRuntimeReasoningEffort("codex", "ultra")).toBe("ultra");
  });
});

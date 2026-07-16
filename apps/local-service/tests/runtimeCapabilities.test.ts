import { describe, expect, it } from "vitest";
import { normalizeRuntimeCapabilities } from "../src/runtime/capabilities.js";
import { claudeCapabilityForTool, claudeToolsForCapabilities } from "../src/runtime/adapters/claudeCapabilities.js";

describe("runtime capabilities", () => {
  it("normalizes short system capability names and legacy Claude tool names", () => {
    expect(normalizeRuntimeCapabilities([
      "read",
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "WebSearch",
      "unknown",
    ])).toEqual(["read", "search", "write", "edit", "shell", "web_search"]);
  });

  it("maps system capabilities to Claude provider tools explicitly", () => {
    expect(claudeToolsForCapabilities(["read", "search", "shell"])).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(claudeCapabilityForTool("Bash")).toBe("shell");
    expect(claudeCapabilityForTool("Write")).toBe("write");
    expect(claudeCapabilityForTool("Unknown")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { leaderRuntimeTestExports } from "../src/runtime/leaderRuntime.js";
import type { RuntimeToolPermissionRequest } from "../src/runtime/adapters/runtimeAdapter.js";

const { withRuntimeEnvironmentNote, checkLeaderToolPath } = leaderRuntimeTestExports;

const PROJECT_ROOT = "/Users/tester/workspace/demo-app";
const SCRATCH_DIR = "/Users/tester/.squadflow/scratch/flow-1/leader";
const ROOTS = [PROJECT_ROOT, SCRATCH_DIR];

function request(inputPath: string | null): RuntimeToolPermissionRequest {
  return {
    capability: "read",
    providerToolName: "Read",
    input: { path: inputPath },
    providerInput: inputPath ? { file_path: inputPath } : {},
    context: { toolUseId: null },
  };
}

describe("checkLeaderToolPath", () => {
  it("allows paths inside the project root", () => {
    expect(checkLeaderToolPath(request(`${PROJECT_ROOT}/src/index.ts`), ROOTS)).toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request(PROJECT_ROOT), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("allows paths inside the leader scratch dir", () => {
    expect(checkLeaderToolPath(request(`${SCRATCH_DIR}/screenshot.png`), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("allows relative paths and tools without a path input", () => {
    expect(checkLeaderToolPath(request("src/index.ts"), ROOTS)).toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request(null), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("denies hallucinated absolute paths with a corrective message", () => {
    for (const bad of ["/home/user/project/src", "/", "/tmp", "/workspace", "/Users/user/project"]) {
      const result = checkLeaderToolPath(request(bad), ROOTS);
      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.message).toContain(bad);
        expect(result.message).toContain(PROJECT_ROOT);
      }
    }
  });

  it("denies prefix-sibling directories outside the root", () => {
    const result = checkLeaderToolPath(request(`${PROJECT_ROOT}-copy/file.ts`), ROOTS);
    expect(result.behavior).toBe("deny");
  });
});

describe("withRuntimeEnvironmentNote", () => {
  it("appends the project root to the system prompt", () => {
    const combined = withRuntimeEnvironmentNote("BASE PROMPT", PROJECT_ROOT);
    expect(combined.startsWith("BASE PROMPT")).toBe(true);
    expect(combined).toContain("## 运行环境");
    expect(combined).toContain(`当前项目根目录（绝对路径）：${PROJECT_ROOT}`);
  });
});

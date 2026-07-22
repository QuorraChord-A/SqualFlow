import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { leaderRuntimeTestExports } from "../src/runtime/leaderRuntime.js";
import type { RuntimeToolPermissionRequest } from "../src/runtime/adapters/runtimeAdapter.js";

const { withRuntimeEnvironmentNote, checkLeaderToolPath } = leaderRuntimeTestExports;

const PROJECT_ROOT = "/Users/tester/workspace/demo-app";
const SCRATCH_DIR = "/Users/tester/.squadflow/scratch/flow-1/leader";
const ROOTS = [PROJECT_ROOT, SCRATCH_DIR];

function request(
  inputPath: string | null,
  capability: RuntimeToolPermissionRequest["capability"] = "read",
): RuntimeToolPermissionRequest {
  return {
    capability,
    providerToolName: capability === "write" ? "Write" : "Read",
    input: { path: inputPath },
    providerInput: inputPath ? { file_path: inputPath } : {},
    context: { toolUseId: null },
  };
}

describe("checkLeaderToolPath", () => {
  it("allows reads inside the project root", () => {
    expect(checkLeaderToolPath(request(`${PROJECT_ROOT}/src/index.ts`), ROOTS)).toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request(PROJECT_ROOT), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("allows reads inside the leader scratch dir", () => {
    expect(checkLeaderToolPath(request(`${SCRATCH_DIR}/screenshot.png`), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("allows relative paths and tools without a path input", () => {
    expect(checkLeaderToolPath(request("src/index.ts"), ROOTS)).toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request(null), ROOTS)).toEqual({ behavior: "allow" });
  });

  it("allows read and search paths outside the project", () => {
    for (const externalPath of ["/home/user/project/src", "/", "/tmp", "/workspace", "/Users/user/project"]) {
      expect(checkLeaderToolPath(request(externalPath, "read"), ROOTS)).toEqual({ behavior: "allow" });
      expect(checkLeaderToolPath(request(externalPath, "search"), ROOTS)).toEqual({ behavior: "allow" });
    }
  });

  it("allows writes only inside configured writable roots", () => {
    expect(checkLeaderToolPath(request(`${PROJECT_ROOT}/src/index.ts`, "write"), [PROJECT_ROOT, "/tmp"]))
      .toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request("/tmp/leader-note.txt", "write"), [PROJECT_ROOT, "/tmp"]))
      .toEqual({ behavior: "allow" });
    expect(checkLeaderToolPath(request(`${fs.realpathSync.native("/tmp")}/leader-note.txt`, "write"), [PROJECT_ROOT, "/tmp"]))
      .toEqual({ behavior: "allow" });

    const result = checkLeaderToolPath(request(`${PROJECT_ROOT}-copy/file.ts`, "write"), [PROJECT_ROOT, "/tmp"]);
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

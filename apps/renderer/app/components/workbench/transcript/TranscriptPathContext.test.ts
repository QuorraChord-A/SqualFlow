import { describe, expect, it } from "vitest";
import { displayPathForWorkspace } from "./TranscriptPathContext";

describe("displayPathForWorkspace", () => {
  it("shows a POSIX path relative to the workspace without changing its copy value", () => {
    expect(displayPathForWorkspace("/repo/src/domain/file.ts", "/repo/")).toEqual({
      copyPath: "/repo/src/domain/file.ts",
      displayPath: "src/domain/file.ts",
      parentPath: "src / domain",
      compactParentPath: "src/domain/",
      workspaceFilePath: "src/domain/file.ts",
    });
  });

  it("does not trim a similarly prefixed directory outside the workspace", () => {
    expect(displayPathForWorkspace("/repo2/src/file.ts", "/repo")).toMatchObject({
      displayPath: "/repo2/src/file.ts",
      workspaceFilePath: null,
    });
  });

  it("keeps an already relative path relative", () => {
    expect(displayPathForWorkspace("src/file.ts", "/repo").displayPath).toBe("src/file.ts");
  });

  it("matches Windows drive paths case-insensitively", () => {
    expect(displayPathForWorkspace("c:\\Repo\\src\\file.ts", "C:\\repo")).toMatchObject({
      copyPath: "c:\\Repo\\src\\file.ts",
      displayPath: "src/file.ts",
      parentPath: "src",
      compactParentPath: "src/",
      workspaceFilePath: "src/file.ts",
    });
  });
});

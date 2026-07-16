import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureUserTurnBaseline,
  captureUserTurnBaselineAsync,
  summarizeUserTurnDiff,
  summarizeUserTurnDiffAsync,
} from "../src/runtime/userTurnDiff.js";

const dirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-diff-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("UserTurn diff capture", () => {
  it("captures changed files from a hash baseline", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "hello.txt"), "hello");
    const baseline = captureUserTurnBaseline(root);
    fs.writeFileSync(path.join(root, "hello.txt"), "hello world");
    fs.writeFileSync(path.join(root, "new.txt"), "new");

    const summary = summarizeUserTurnDiff(root, baseline);

    expect(summary.changedFiles.map((file) => file.path).sort()).toEqual(["hello.txt", "new.txt"]);
    expect(summary.text).toContain("hello.txt");
    expect(summary.text).toContain("new.txt");
  });

  it("ignores heavyweight generated folders", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "old");
    const baseline = captureUserTurnBaseline(root);
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "new");

    expect(summarizeUserTurnDiff(root, baseline).changedFiles).toEqual([]);
  });

  it("uses a git status fast path for Expert turn diffs", async () => {
    const root = tempDir();
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "one.txt"), "one\n");
    fs.writeFileSync(path.join(root, "two.txt"), "two\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { stdio: "ignore" });

    const baseline = await captureUserTurnBaselineAsync(root);
    fs.writeFileSync(path.join(root, "one.txt"), "one changed\n");
    fs.writeFileSync(path.join(root, "two.txt"), "two changed\n");
    fs.writeFileSync(path.join(root, "three.txt"), "three\n");

    const summary = await summarizeUserTurnDiffAsync(root, baseline);

    expect(baseline).toEqual(expect.objectContaining({ kind: "git", strategy: "status" }));
    expect(summary.changedFiles).toEqual([
      { path: "one.txt", status: "modified" },
      { path: "three.txt", status: "added" },
      { path: "two.txt", status: "modified" },
    ]);
  });

  it("reports files modified during the turn even when they were dirty at git baseline", async () => {
    const root = tempDir();
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "changed.txt"), "initial\n");
    fs.writeFileSync(path.join(root, "untouched.txt"), "initial\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "changed.txt"), "dirty before baseline\n");
    fs.writeFileSync(path.join(root, "untouched.txt"), "dirty before baseline\n");

    const baseline = await captureUserTurnBaselineAsync(root);
    fs.writeFileSync(path.join(root, "changed.txt"), "dirty after baseline\n");

    const summary = await summarizeUserTurnDiffAsync(root, baseline);

    expect(baseline).toEqual(expect.objectContaining({ kind: "git", strategy: "status" }));
    expect(summary.changedFiles).toEqual([{ path: "changed.txt", status: "modified" }]);
  });

  it("keeps non-git async fallback behavior aligned with the hash baseline", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "hello.txt"), "hello");
    const baseline = await captureUserTurnBaselineAsync(root);
    fs.writeFileSync(path.join(root, "hello.txt"), "hello world");
    fs.writeFileSync(path.join(root, "new.txt"), "new");

    const summary = await summarizeUserTurnDiffAsync(root, baseline);

    expect(summary.changedFiles.map((file) => file.path).sort()).toEqual(["hello.txt", "new.txt"]);
    expect(summary.filesChangedSkipped).toBeUndefined();
  });

  it("returns an empty skipped summary for oversized non-git directories", async () => {
    const root = tempDir();
    for (let index = 0; index < 20_001; index += 1) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), "");
    }

    const baseline = await captureUserTurnBaselineAsync(root);
    fs.writeFileSync(path.join(root, "changed.txt"), "changed");
    const summary = await summarizeUserTurnDiffAsync(root, baseline);

    expect(baseline).toEqual(expect.objectContaining({ kind: "hash", skipped: true }));
    expect(summary).toEqual({ changedFiles: [], text: "", filesChangedSkipped: true });
  });
});

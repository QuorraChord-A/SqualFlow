import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLatestCompactTranscriptMetadata } from "../src/runtime/claudeTranscript.js";

const dirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-claude-transcript-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Claude transcript helpers", () => {
  it("reads the latest compact token metadata from raw JSONL", async () => {
    const root = tempDir();
    process.env.CLAUDE_CONFIG_DIR = root;
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const projectDir = path.join(root, "projects", "-tmp-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 12_891, postTokens: 810 } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-06-28T10:00:00.000Z", compactMetadata: { preTokens: 1_454, postTokens: 1_339 } }),
    ].join("\n"));

    await expect(getLatestCompactTranscriptMetadata(sessionId)).resolves.toEqual({
      preTokens: 1_454,
      postTokens: 1_339,
      timestamp: "2026-06-28T10:00:00.000Z",
    });
  });
});

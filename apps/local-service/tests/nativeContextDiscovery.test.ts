import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverNativeContext,
  migrateLegacyClaudeSessions,
  prepareClaudeNativeContext,
} from "../src/runtime/nativeContextDiscovery.js";

const temporaryRoots: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-native-context-"));
  temporaryRoots.push(root);
  return root;
}

function writeSkill(directory: string, name: string, description: string) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
    "utf8",
  );
}

afterEach(() => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("native context discovery", () => {
  it("lists nearer Claude project capabilities before global capabilities", () => {
    const root = temporaryRoot();
    const configDir = path.join(root, "claude-home");
    const projectRoot = path.join(root, "project");
    const nestedCwd = path.join(projectRoot, "packages", "app");
    process.env.CLAUDE_CONFIG_DIR = configDir;

    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    writeSkill(path.join(configDir, "skills", "global-skill"), "global-skill", "Global");
    writeSkill(path.join(projectRoot, ".claude", "skills", "project-skill"), "project-skill", "Project");
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { "global-mcp": { command: "global" } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-mcp": { command: "project" } } }),
      "utf8",
    );

    const snapshot = discoverNativeContext({
      sdk: "claudecode",
      cwd: nestedCwd,
      includeProject: true,
    });

    expect(snapshot.skills.map(({ name, scope }) => [name, scope])).toEqual([
      ["project-skill", "project"],
      ["global-skill", "global"],
    ]);
    expect(snapshot.mcpServers.map(({ name, scope }) => [name, scope])).toEqual([
      ["project-mcp", "project"],
      ["global-mcp", "global"],
    ]);
  });

  it("projects Claude Skills, MCP and project instructions without importing settings", () => {
    const root = temporaryRoot();
    const configDir = path.join(root, "claude-home");
    const projectRoot = path.join(root, "project");
    const scratchDir = path.join(root, "scratch");
    process.env.CLAUDE_CONFIG_DIR = configDir;

    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    writeSkill(path.join(configDir, "skills", "shared"), "shared", "Global version");
    writeSkill(path.join(projectRoot, ".claude", "skills", "shared"), "shared", "Project version");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://must-not-load.example" } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { global: { command: "global" } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { project: { command: "project" } } }),
      "utf8",
    );
    fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "Use the project convention.", "utf8");

    const prepared = prepareClaudeNativeContext({
      cwd: projectRoot,
      scratchDir,
      systemPrompt: "SquadFlow role prompt.",
    });

    expect(JSON.parse(fs.readFileSync(
      path.join(prepared.pluginDir, ".claude-plugin", "plugin.json"),
      "utf8",
    ))).toMatchObject({ name: "squadflow-native-context" });
    expect(fs.realpathSync(path.join(prepared.pluginDir, "skills", "shared"))).toBe(
      fs.realpathSync(path.join(projectRoot, ".claude", "skills", "shared")),
    );
    expect(prepared.sessionConfigDir).toBe(configDir);
    expect(Object.keys(prepared.mcpServers ?? {})).toEqual(["global", "project"]);
    expect(prepared.mcpServers?.global).toMatchObject({ command: "global", alwaysLoad: true });
    expect(prepared.mcpServers?.project).toMatchObject({ command: "project", alwaysLoad: true });
    expect(prepared.systemPrompt).toContain("SquadFlow role prompt.");
    expect(prepared.systemPrompt).toContain("<project_instructions>");
    expect(prepared.systemPrompt).toContain("Use the project convention.");
    expect(prepared.systemPrompt).not.toContain("<native_mcp_servers>");
    expect(prepared.systemPrompt).not.toContain("@<server-name>");
  });

  it("lists only global capabilities for a new Flow", () => {
    const root = temporaryRoot();
    const configDir = path.join(root, "claude-home");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    writeSkill(path.join(configDir, "skills", "global-skill"), "global-skill", "Global");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { "global-mcp": { command: "global" } } }),
      "utf8",
    );

    const snapshot = discoverNativeContext({
      sdk: "claudecode",
      includeProject: false,
    });

    expect(snapshot.scope).toBe("global");
    expect(snapshot.skills.map((item) => item.scope)).toEqual(["global"]);
    expect(snapshot.mcpServers.map((item) => item.scope)).toEqual(["global"]);
  });

  it("does not scan above a non-git Flow project root", () => {
    const root = temporaryRoot();
    const configDir = path.join(root, "claude-home");
    const projectRoot = path.join(root, "plain-project");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    writeSkill(path.join(root, ".claude", "skills", "outside"), "outside", "Outside project");
    fs.mkdirSync(projectRoot, { recursive: true });

    const snapshot = discoverNativeContext({
      sdk: "claudecode",
      cwd: projectRoot,
      includeProject: true,
    });

    expect(snapshot.skills).toEqual([]);
  });

  it("copies legacy isolated Claude transcripts into the shared session root without overwriting", () => {
    const root = temporaryRoot();
    const scratchRoot = path.join(root, "runtime", "scratch");
    const targetConfigDir = path.join(root, "claude-home");
    const legacyProjectDir = path.join(
      scratchRoot,
      "flow-old",
      "leader",
      "claude-native-context",
      "projects",
      "-repo",
    );
    const targetProjectDir = path.join(targetConfigDir, "projects", "-repo");
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.mkdirSync(targetProjectDir, { recursive: true });
    fs.writeFileSync(path.join(legacyProjectDir, "new-session.jsonl"), "legacy-new", "utf8");
    fs.writeFileSync(path.join(legacyProjectDir, "existing-session.jsonl"), "legacy-old", "utf8");
    fs.writeFileSync(path.join(targetProjectDir, "existing-session.jsonl"), "shared-new", "utf8");

    const result = migrateLegacyClaudeSessions({ runtimeScratchRoot: scratchRoot, targetConfigDir });

    expect(result).toEqual({ filesCopied: 1, legacyRootsFound: 1 });
    expect(fs.readFileSync(path.join(targetProjectDir, "new-session.jsonl"), "utf8")).toBe("legacy-new");
    expect(fs.readFileSync(path.join(targetProjectDir, "existing-session.jsonl"), "utf8")).toBe("shared-new");
  });
});

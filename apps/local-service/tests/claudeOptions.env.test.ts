import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeBaseOptions,
  buildClaudeExpertOptions,
  buildClaudeLeaderOptions,
} from "../src/runtime/adapters/claudeOptions.js";
import type { RuntimeConfig } from "../src/config/agentRuntimeConfig.js";

const POLLUTED = {
  ANTHROPIC_API_KEY: "leaked-api-key",
  ANTHROPIC_AUTH_TOKEN: "leaked-auth-token",
  ANTHROPIC_BASE_URL: "https://leaked.example.com",
  ANTHROPIC_MODEL: "leaked-model",
} as const;

function apiKeyConfig(): RuntimeConfig {
  return {
    id: "cfg-1",
    fileName: "cfg-1.json",
    name: "cfg",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "https://configured.example.com",
    apiKey: "configured-key",
    models: [{ id: "m1", name: "model-one", contextWindowK: 200 }],
  };
}

function baseOptionsInput(overrides?: { runtimeConfig?: RuntimeConfig; settingsPath?: string }) {
  return {
    systemPrompt: "prompt",
    cwd: "/tmp",
    allowedTools: [],
    tools: [],
    settingsPath: overrides?.settingsPath ?? path.join(os.tmpdir(), "does-not-exist-claude-settings.json"),
    runtimeConfig: overrides?.runtimeConfig,
  };
}

describe("claude options env isolation", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(POLLUTED)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(POLLUTED)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("apiKey mode: config wins and inherited auth vars are stripped", () => {
    const options = buildClaudeBaseOptions(baseOptionsInput({ runtimeConfig: apiKeyConfig() }));
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options.env?.ANTHROPIC_API_KEY).toBe("configured-key");
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://configured.example.com");
    expect(options.env?.ANTHROPIC_MODEL).toBe("model-one");
  });

  it("inherited mode: no leaked auth or routing vars reach the subprocess", () => {
    const options = buildClaudeBaseOptions(baseOptionsInput({
      runtimeConfig: { ...apiKeyConfig(), authMode: "inherited", apiKey: "", baseUrl: "" },
    }));
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env?.ANTHROPIC_MODEL).toBe("model-one");
  });

  it("explicit settings-file env is preserved over the stripped base", () => {
    const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-")), "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "settings-token" } }));
    try {
      const options = buildClaudeBaseOptions(baseOptionsInput({ settingsPath }));
      expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe("settings-token");
    } finally {
      fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });
    }
  });

  it("unrelated environment variables still pass through", () => {
    process.env.CLAUDE_OPTIONS_TEST_MARKER = "keep-me";
    try {
      const options = buildClaudeBaseOptions(baseOptionsInput({ runtimeConfig: apiKeyConfig() }));
      expect(options.env?.CLAUDE_OPTIONS_TEST_MARKER).toBe("keep-me");
    } finally {
      delete process.env.CLAUDE_OPTIONS_TEST_MARKER;
    }
  });

  it("keeps raw Claude filesystem settings isolated while enabling SDK skills", () => {
    const options = buildClaudeBaseOptions(baseOptionsInput());
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBe("all");
    expect(options.strictMcpConfig).toBe(true);
  });

  it("loads and pre-authorizes every user-native MCP server", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-mcp-options-"));
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-mcp-scratch-"));
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "remote-reference": { type: "http", url: "https://mcp.example.test/mcp" },
          "local-research": { command: "arbitrary-mcp-command", args: ["serve"] },
        },
      }),
      "utf8",
    );
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    try {
      const leader = buildClaudeLeaderOptions({
        role: "leader",
        systemPrompt: "leader",
        cwd: "/tmp",
        scratchDir,
        capabilities: ["read"],
        mcpTools: ["mcp__squadflow-leader__get_context"],
      });
      const expert = buildClaudeExpertOptions({
        role: "research",
        systemPrompt: "expert",
        cwd: "/tmp",
        scratchDir,
        capabilities: ["read"],
        mcpTools: [],
      });

      expect(leader.allowedTools).toEqual(expect.arrayContaining([
        "mcp__remote-reference__*",
        "mcp__local-research__*",
      ]));
      expect(expert.allowedTools).toEqual(expect.arrayContaining([
        "mcp__remote-reference__*",
        "mcp__local-research__*",
      ]));
      expect(leader.env?.ENABLE_TOOL_SEARCH).toBe("false");
      expect(expert.env?.ENABLE_TOOL_SEARCH).toBe("false");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("disables extended thinking only for ephemeral Flow Namer requests", () => {
    const options = buildClaudeBaseOptions(baseOptionsInput({
      runtimeConfig: {
        ...apiKeyConfig(),
        reasoningEffort: "high",
      } as RuntimeConfig & { reasoningEffort: string },
      settingsPath: path.join(os.tmpdir(), "does-not-exist-claude-settings.json"),
    }));
    expect(options.thinking).toBeUndefined();
    expect(options.effort).toBe("high");

    const namerOptions = buildClaudeBaseOptions({
      ...baseOptionsInput({
        runtimeConfig: {
          ...apiKeyConfig(),
          reasoningEffort: "high",
        } as RuntimeConfig & { reasoningEffort: string },
      }),
      ephemeral: true,
    });
    expect(namerOptions.persistSession).toBe(false);
    expect(namerOptions.thinking).toEqual({ type: "disabled" });
    expect(namerOptions.effort).toBeUndefined();
  });
});

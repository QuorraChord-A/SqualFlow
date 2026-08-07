import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/harness/baseHarness.js";
import { buildExpertOptions } from "../src/harness/expertHarness.js";
import { buildLeaderOptions } from "../src/harness/leaderHarness.js";
import type { RuntimeConfig } from "../src/config/agentRuntimeConfig.js";
import { FlowMailbox, getMailbox, removeMailbox } from "../src/harness/mailbox.js";
import { OutputQueue } from "../src/harness/outputQueue.js";
import { createLeaderMcpServer, createLeaderToolHandlers } from "../src/mcp/leaderServer.js";

function withTempSettings(settings: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-settings-"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
  return settingsPath;
}

function withTimeout<T>(promise: Promise<T>, ms = 20): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for mail")), ms);
    }),
  ]);
}

const settingsPath = withTempSettings();
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const isolatedClaudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-claude-config-"));

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = isolatedClaudeConfigDir;
});

afterAll(() => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  fs.rmSync(isolatedClaudeConfigDir, { recursive: true, force: true });
});

function runtimeConfig(patch: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    id: "default-agent-sdk",
    fileName: "default-agent-sdk.json",
    name: "Default",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "https://example.test/anthropic",
    apiKey: "sk-test",
    models: [{ id: "model-1", name: "claude-test-model", contextWindowK: 200 }],
    ...patch,
  };
}

describe("harness base options", () => {
  it("adds updatedInput to allowed permission callback results for the SDK bridge", async () => {
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
      canUseTool: async () => ({ behavior: "allow" }),
    });

    const input = { path: "README.md" };
    await expect(options.canUseTool?.("Read", input, { signal: new AbortController().signal })).resolves.toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("inlines settings file contents while forcing the SDK sandbox off", () => {
    const settingsPath = withTempSettings({
      model: "claude-sonnet-4-6",
      env: { FOO: "bar" },
      permissions: { allow: ["Read(*)"] },
      sandbox: {
        enabled: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["blocked.example.com"],
        },
      },
    });
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
    });

    expect(options.settings).toMatchObject({
      model: "claude-sonnet-4-6",
      permissions: { allow: ["Read(*)"] },
      sandbox: {
        enabled: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["blocked.example.com"],
        },
      },
    });
    expect(typeof options.settings).toBe("object");
    if (typeof options.settings !== "object" || options.settings === null) {
      throw new Error("expected inline settings object");
    }
    expect(options.settings.env).toBeUndefined();
    expect(options.env).toMatchObject({ FOO: "bar" });
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBe("all");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.includePartialMessages).toBe(true);
  });

  it("does not combine a settings file path with top-level sandbox options", () => {
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
    });

    expect(typeof options.settings).toBe("object");
    expect(options.sandbox).toBeUndefined();
    if (typeof options.settings !== "object" || options.settings === null) {
      throw new Error("expected inline settings object");
    }
    expect(options.settings.sandbox?.enabled).toBe(false);
  });

  it("uses an explicit unpacked Claude executable in packaged runtimes", () => {
    const executable = "/Applications/SquadFlow.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: [],
      tools: [],
      settingsPath,
      pathToClaudeCodeExecutable: executable,
    });

    expect(options.pathToClaudeCodeExecutable).toBe(executable);
  });

  it("uses safe empty settings when the optional legacy settings file is missing", () => {
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath: path.join(os.tmpdir(), "missing-squadflow-claude-settings.json"),
    });

    expect(options.settings).toMatchObject({
      sandbox: {
        enabled: false,
      },
    });
  });

  it("overrides Claude provider env and model from runtime config", () => {
    const settingsPath = withTempSettings({
      env: {
        ANTHROPIC_API_KEY: "sk-old",
        ANTHROPIC_BASE_URL: "https://old.example",
      },
      model: "old-model",
      language: "zh-CN",
    });

    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
      runtimeConfig: runtimeConfig(),
    });

    expect(options.model).toBe("claude-test-model");
    expect(options.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "sk-test",
      ANTHROPIC_BASE_URL: "https://example.test/anthropic",
      ANTHROPIC_MODEL: "claude-test-model",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    });
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.settings).toMatchObject({ model: "claude-test-model", language: "zh-CN" });
  });

  it("selects Claude Code 1M context through the model suffix and runtime env", () => {
    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
      runtimeConfig: runtimeConfig({
        models: [{ id: "model-1", name: "claude-test-model", contextWindowK: 1_000 }],
      }),
    });

    expect(options.model).toBe("claude-test-model[1m]");
    expect(options.settings).toMatchObject({ model: "claude-test-model[1m]" });
    expect(options.env).toMatchObject({
      ANTHROPIC_MODEL: "claude-test-model[1m]",
    });
    expect(options.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
  });

  it("prefers the explicit modelName over the runtime config model list", () => {
    const settingsPath = withTempSettings({
      model: "old-model",
    });

    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
      runtimeConfig: runtimeConfig(),
      modelName: "explicit-model",
    });

    expect(options.model).toBe("explicit-model");
    expect(options.env).toMatchObject({ ANTHROPIC_MODEL: "explicit-model" });
    expect(options.settings).toMatchObject({ model: "explicit-model" });
  });

  it("does not leak settings provider credentials through unsupported inherited auth mode", () => {
    const settingsPath = withTempSettings({
      env: {
        ANTHROPIC_API_KEY: "sk-old",
        ANTHROPIC_BASE_URL: "https://old.example",
      },
      model: "old-model",
    });

    const options = buildBaseOptions({
      systemPrompt: "sys",
      cwd: "/repo",
      allowedTools: ["Read"],
      tools: ["Read"],
      settingsPath,
      runtimeConfig: runtimeConfig({ authMode: "inherited", apiKey: "sk-new", baseUrl: "https://new.example" }),
    });

    expect(options.env).toMatchObject({ ANTHROPIC_MODEL: "claude-test-model" });
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.model).toBe("claude-test-model");
  });
});

describe("expert harness options", () => {
  it("gates Write/Edit/Bash through permission callback for writable experts", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "expert-native-context-"));
    const options = buildExpertOptions({
      role: "frontend",
      systemPrompt: "sys",
      cwd: "/repo",
      scratchDir,
      capabilities: ["read", "write", "edit", "shell"],
      mcpTools: ["mcp__leader__finish_task"],
    });

    expect(options.cwd).toBe("/repo");
    expect(options.tools).toEqual(["Read", "Write", "Edit", "Bash"]);
    expect(options.allowedTools).toEqual(["Read", "mcp__leader__finish_task"]);
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.disallowedTools).toEqual([]);
    expect(options.permissionMode).toBe("default");
    expect(options.settings).toMatchObject({
      sandbox: { enabled: false },
    });
    expect(options.env).toMatchObject({
      CLAUDE_CODE_TMPDIR: scratchDir,
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir,
      CLAUDE_CONFIG_DIR: isolatedClaudeConfigDir,
    });
    expect(options.settingSources).toEqual([]);
    expect(options.plugins).toEqual([{
      type: "local",
      path: path.join(scratchDir, "claude-native-context-plugin"),
    }]);
  });

  it("uses stable project cwd for read-only experts and only disallows unauthorized gated tools", () => {
    const options = buildExpertOptions({
      role: "verify",
      systemPrompt: "sys",
      cwd: "/repo",
      scratchDir: "/tmp/scratch",
      capabilities: ["read", "shell"],
      mcpTools: [],
    });

    expect(options.cwd).toBe("/repo");
    expect(options.additionalDirectories).toEqual([]);
    expect(options.tools).toEqual(["Read", "Bash"]);
    expect(options.allowedTools).toEqual(["Read"]);
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.disallowedTools).toEqual(["Write", "Edit"]);
    expect(options.disallowedTools).not.toContain("Bash");
  });

  it("passes resume without inventing a sessionId", () => {
    const options = buildExpertOptions({
      role: "frontend",
      systemPrompt: "sys",
      cwd: "/repo",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      resume: "old-session",
    });

    expect(options.resume).toBe("old-session");
    expect(options.sessionId).toBeUndefined();
  });
});

describe("leader harness options", () => {
  it("can attach an in-process MCP SDK server instance for TS runtime", () => {
    const mcpServer = createLeaderMcpServer(createLeaderToolHandlers({
      getContext: () => ({ flow_id: "flow-1", status: "ready" }),
      listPendingUserActions: () => [],
      createPlan: () => ({
        plan_revision: { plan_revision_id: "plan-1", status: "draft", revision_number: 1 },
        plan_approval: { plan_approval_id: "sca-1", status: "pending", actions: ["run"] },
      }),
      askUser: (input) => ({ id: input.cardId, status: "pending", workRunId: "utn-1" }),
      createTask: () => ({
        work_run_id: "utn-1",
        task: { task_id: "task-1", work_run_id: "utn-1", subject: "Task", description: "", active_form: "", status: "pending" },
      }),
      saveExecutionPlan: (input) => ({ id: "art-1", type: "execution_plan", title: input.title, content: input.plan }),
      updateTask: (input) => ({ task_id: input.taskId, status: input.status ?? "pending" }),
      listTasks: () => [],
      getTask: (input) => ({ task_id: input.taskId, status: "pending" }),
      dispatchAgent: async (input) => ({
        ok: true,
        agent_run: { agent_run_id: "ags-1", expert_id: input.expertId, task_id: input.taskId },
        task: { task_id: input.taskId, status: "in_progress" },
      }),
      sendMessage: () => ({ ok: true, accepted: true }),
    }));

    const options = buildLeaderOptions({
      role: "leader",
      systemPrompt: "sys",
      cwd: "/repo",
      capabilities: ["read", "search"],
      mcpTools: ["mcp__leader__create_tasks"],
      mcpServerConfigs: { "squadflow-leader": { type: "sdk", name: "squadflow-leader", instance: mcpServer } },
    });

    expect(options.mcpServers).toEqual({
      "squadflow-leader": { type: "sdk", name: "squadflow-leader", instance: mcpServer },
    });
  });

  it("omits sessionId when resuming and preserves SSE MCP server config", () => {
    const options = buildLeaderOptions({
      role: "leader",
      systemPrompt: "sys",
      cwd: "/repo",
      capabilities: ["read", "write", "edit", "search", "shell"],
      mcpTools: ["mcp__leader__create_tasks"],
      mcpServerConfigs: { "squadflow-leader": { type: "sse", url: "http://127.0.0.1:8000/mcp/leader/sse" } },
      resume: "old-session",
      sessionId: "new-session",
    });

    expect(options.resume).toBe("old-session");
    expect(options.sessionId).toBeUndefined();
    expect(options.disallowedTools).toEqual([]);
    expect(options.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(options.additionalDirectories).toEqual([path.parse("/repo").root]);
    // 内置工具不再预授权：必须每次经过 canUseTool 路径守卫
    expect(options.allowedTools).toEqual(["mcp__leader__create_tasks"]);
    expect(options.mcpServers).toEqual({
      "squadflow-leader": { type: "sse", url: "http://127.0.0.1:8000/mcp/leader/sse" },
    });
  });
});

describe("FlowMailbox", () => {
  it("waits before a matching mail is sent", async () => {
    const mailbox = new FlowMailbox("flow-1", "run-1");
    const waiting = mailbox.wait("leader");

    mailbox.send({
      flowId: "flow-1",
      runId: "run-1",
      sender: "expert",
      to: "leader",
      type: "result",
      content: { status: "done" },
    });

    await expect(waiting).resolves.toMatchObject({
      sender: "expert",
      to: "leader",
      content: { status: "done" },
    });
  });

  it("resolves an existing waiter before subscribers can pull the same recipient", async () => {
    const mailbox = new FlowMailbox("flow-1", "run-1");
    const waiting = mailbox.wait("leader");

    mailbox.subscribe("leader", () => {
      mailbox.pull("leader");
    });
    mailbox.send({
      flowId: "flow-1",
      runId: "run-1",
      sender: "expert",
      to: "leader",
      type: "result",
      content: "done",
    });

    await expect(withTimeout(waiting)).resolves.toMatchObject({
      sender: "expert",
      to: "leader",
      content: "done",
    });
  });

  it("resolves an existing waiter before subscribers can clear the mailbox", async () => {
    const mailbox = new FlowMailbox("flow-1", "run-1");
    const waiting = mailbox.wait("leader");

    mailbox.subscribe("leader", () => {
      mailbox.clear();
    });
    mailbox.send({
      flowId: "flow-1",
      runId: "run-1",
      sender: "expert",
      to: "leader",
      type: "result",
      content: "done",
    });

    await expect(withTimeout(waiting)).resolves.toMatchObject({
      sender: "expert",
      to: "leader",
      content: "done",
    });
  });

  it("pull removes messages and clear drops queued messages", () => {
    const mailbox = new FlowMailbox("flow-1", "run-1");

    mailbox.send({
      flowId: "flow-1",
      runId: "run-1",
      sender: "expert",
      to: "leader",
      type: "result",
      content: "one",
    });
    mailbox.send({
      flowId: "flow-1",
      runId: "run-1",
      sender: "expert",
      to: "system",
      type: "result",
      content: "two",
    });

    expect(mailbox.has("leader")).toBe(true);
    expect(mailbox.pull("leader")).toHaveLength(1);
    expect(mailbox.has("leader")).toBe(false);
    expect(mailbox.has("system")).toBe(true);

    mailbox.clear();
    expect(mailbox.has("system")).toBe(false);
  });

  it("registry keys mailboxes by flow and run and remove clears the instance", () => {
    const first = getMailbox("flow-1", "run-1");
    const second = getMailbox("flow-1", "run-1");
    const otherRun = getMailbox("flow-1", "run-2");

    expect(second).toBe(first);
    expect(otherRun).not.toBe(first);

    removeMailbox("flow-1", "run-1");
    expect(getMailbox("flow-1", "run-1")).not.toBe(first);

    removeMailbox("flow-1", "run-1");
    removeMailbox("flow-1", "run-2");
  });
});

describe("OutputQueue", () => {
  it("feeds each consumer independently and in order", async () => {
    const queue = new OutputQueue<number>();
    const slow: number[] = [];
    const fast: number[] = [];

    queue.addConsumer(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, event === 1 ? 5 : 0));
      slow.push(event);
    });
    queue.addConsumer((event) => {
      fast.push(event);
    });

    await queue.put(1);
    await queue.put(2);
    await queue.close();

    expect(slow).toEqual([1, 2]);
    expect(fast).toEqual([1, 2]);
  });

  it("does not let one consumer error block other consumers", async () => {
    const queue = new OutputQueue<string>();
    const received: string[] = [];

    queue.addConsumer((event) => {
      if (event === "bad") {
        throw new Error("consumer failed");
      }
    });
    queue.addConsumer((event) => {
      received.push(event);
    });

    await queue.put("bad");
    await queue.put("good");
    await queue.close();

    expect(received).toEqual(["bad", "good"]);
  });

  it("rejects puts after close", async () => {
    const queue = new OutputQueue<string>();

    await queue.close();

    await expect(queue.put("late")).rejects.toThrow("closed");
  });

  it("returns the same close promise until consumers finish draining", async () => {
    const queue = new OutputQueue<string>();
    const received: string[] = [];

    queue.addConsumer(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      received.push(event);
    });

    await queue.put("slow");
    const firstClose = queue.close();
    const secondClose = queue.close();
    await secondClose;

    expect(received).toEqual(["slow"]);
    await firstClose;
  });
});

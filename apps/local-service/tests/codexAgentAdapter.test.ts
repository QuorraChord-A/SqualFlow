import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { parseMessageSegments } from "../src/protocol/platformEvent.js";
import { createCodexAgentRuntimeAdapter, type CodexClientFactory } from "../src/runtime/adapters/codexAgentAdapter.js";
import { normalizeCodexBaseUrl } from "../src/runtime/adapters/codexOptions.js";
import type { RuntimeConfig } from "../src/config/agentRuntimeConfig.js";
import type { CodexAppServerClientOptions } from "../src/runtime/adapters/codexAppServerClient.js";
import type { RuntimeEvent } from "../src/runtime/runtimeEvents.js";

const protocolConfigRoots: string[] = [];
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-platform-event-"));
  protocolConfigRoots.push(root);
  config.agentRuntimeConfigRoot = root;
});

afterEach(() => {
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
  for (const root of protocolConfigRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): RuntimeConfig {
  return {
    id: "codex-test",
    fileName: "codex-test.json",
    name: "Codex Test",
    sdk: "codex",
    authMode: "apiKey",
    baseUrl: "https://provider.example/v1/responses",
    apiKey: "sk-test",
    models: [{ id: "model-1", name: "qwen3.7-plus" }],
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function writeCodexRollout(root: string, sessionId: string, entries: unknown[]) {
  const rolloutPath = path.join(root, `${sessionId}.jsonl`);
  const database = new Database(path.join(root, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(sessionId, rolloutPath);
  database.close();
  fs.writeFileSync(rolloutPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("Codex runtime adapter", () => {
  it("reads MCP status for the active Codex thread without making it part of the turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-mcp-status" } };
        if (method === "mcpServerStatus/list") {
          return {
            data: [{
              name: "context7",
              serverInfo: { icons: [{ src: "https://context7.com/context7-icon-green.png" }] },
              tools: {},
              resources: [],
              resourceTemplates: [],
              authStatus: "connected",
            }],
            nextCursor: null,
          };
        }
        if (method === "turn/start") return { turn: { id: "turn-mcp-status" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        yield {
          method: "turn/completed",
          params: { threadId: "thread-mcp-status", turn: { id: "turn-mcp-status", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });
    const query = adapter.runQuery({
      prompt: adapter.createSingleTextInput("hello"),
      options,
    });
    const status = query.getMcpServerStatus!();
    const consume = (async () => {
      for await (const event of query) {
        if (event.type === "turn_completed") return;
      }
    })();

    await expect(status).resolves.toMatchObject({
      data: [expect.objectContaining({ name: "context7" })],
    });
    await consume;
    expect(requests).toContainEqual({
      method: "mcpServerStatus/list",
      params: {
        threadId: "thread-mcp-status",
        cursor: null,
        limit: 100,
        detail: "toolsAndAuthOnly",
      },
    });
  });

  it("does not refresh MCP status when Codex starts an MCP tool", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const observedStatuses: unknown[] = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-mcp-icon" } };
        if (method === "turn/start") return { turn: { id: "turn-mcp-icon" } };
        if (method === "mcpServerStatus/list") {
          return {
            data: [{
              name: "context7",
              serverInfo: { icons: [{ src: "https://context7.com/context7-icon-green.png" }] },
              tools: {},
              resources: [],
              resourceTemplates: [],
              authStatus: "connected",
            }],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        yield {
          method: "item/started",
          params: {
            threadId: "thread-mcp-icon",
            turnId: "turn-mcp-icon",
            item: { id: "mcp-call-1", type: "mcpToolCall", server: "context7", tool: "resolve-library-id" },
          },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-mcp-icon", turn: { id: "turn-mcp-icon", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });
    const query = adapter.runQuery({
      prompt: adapter.createSingleTextInput("hello"),
      options,
    });
    query.setMcpServerStatusObserver?.((status) => observedStatuses.push(status));

    for await (const event of query) {
      if (event.type === "turn_completed") break;
    }

    expect(requests.filter((request) => request.method === "mcpServerStatus/list")).toHaveLength(0);
    expect(observedStatuses).toEqual([]);
  });

  it("sets no reasoning effort on the ephemeral Flow Namer turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-namer" } };
        if (method === "turn/start") return { turn: { id: "turn-namer" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        yield {
          method: "turn/completed",
          params: { threadId: "thread-namer", turn: { id: "turn-namer", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "namer",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      ephemeral: true,
      runtimeConfig: runtimeConfig(),
    });

    for await (const event of adapter.runQuery({
      prompt: adapter.createSingleTextInput("生成名称"),
      options,
    })) {
      if (event.type === "turn_completed") break;
    }

    const threadStart = requests.find((request) => request.method === "thread/start")?.params as Record<string, unknown>;
    const turnStart = requests.find((request) => request.method === "turn/start")?.params as Record<string, unknown>;
    expect(threadStart.ephemeral).toBe(true);
    expect(threadStart.developerInstructions).toEqual(expect.stringContaining("namer"));
    expect(threadStart).not.toHaveProperty("baseInstructions");
    expect(turnStart.effort).toBe("none");
  });

  it("runs an Expert turn through app-server and captures the final assistant text", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const events = [
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "completed",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "item-1", text: "completed" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 0 },
            last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 0 },
            modelContextWindow: 1000,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", durationMs: 12 },
        },
      },
    ];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        for (const event of events) yield event;
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read", "write", "edit", "shell", "search"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });
    const output = adapter.createOutputAdapter("msg-1");
    const query = adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options });

    for await (const event of query) {
      output.adapt(event);
      if (event.type === "turn_completed") break;
    }

    expect(output.sdkSessionId).toBe("thread-1");
    expect(output.resultStatus).toBe("success");
    expect(output.resultIsError).toBe(false);
    expect(output.finalAssistantText).toBe("completed");
    expect(requests[0]).toEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({ approvalPolicy: "on-request" }),
    }));
    expect(adapter.contextUsageSnapshot(events[2])).toEqual(expect.objectContaining({
      totalTokens: 100,
      maxTokens: 1000,
      cacheInputTokens: 80,
      cacheReadInputTokens: 40,
      cacheHitRate: 50,
    }));
  });

  it("reports the formal thread and foreign thread notifications without recording payload content", async () => {
    const diagnostics = vi.fn();
    let clientOptions: CodexAppServerClientOptions | null = null;
    const adapter = createCodexAgentRuntimeAdapter({
      clientFactory: (options) => {
        clientOptions = options;
        return {
          start: async () => {},
          request: async (method) => {
            if (method === "thread/start") return { thread: { id: "thread-expected" } };
            if (method === "turn/start") return { turn: { id: "turn-1" } };
            throw new Error(`unexpected request: ${method}`);
          },
          notify: () => {},
          respond: () => {},
          close: () => {},
          notifications: async function* () {
            yield {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thread-foreign",
                turnId: "turn-foreign",
                tokenUsage: { last: { totalTokens: 10 } },
                content: "sensitive payload must not be copied into diagnostics",
              },
            };
            yield {
              method: "turn/completed",
              params: { threadId: "thread-expected", turn: { id: "turn-1", status: "completed" } },
            };
          },
        };
      },
    });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      diagnostics,
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("continue"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(diagnostics).toHaveBeenCalledWith({
      type: "thread_established",
      operation: "start",
      requestedSessionId: null,
      sessionId: "thread-expected",
    });
    expect(diagnostics).toHaveBeenCalledWith({
      type: "foreign_thread_notification",
      method: "thread/tokenUsage/updated",
      expectedSessionId: "thread-expected",
      observedSessionId: "thread-foreign",
      turnId: "turn-1",
    });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_transport_stage",
      stage: "client_ready",
      transport: "stdio",
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_transport_stage",
      stage: "turn_ack",
      transport: "stdio",
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_transport_stage",
      stage: "first_notification",
      method: "turn/completed",
      transport: "stdio",
    }));
    clientOptions?.onStderrLine?.("authorization: secret-value");
    clientOptions?.onStderrLine?.("target=codex_api::endpoint::responses_websocket connecting");
    clientOptions?.onStderrLine?.('{"target":"codex_api::endpoint::responses_websocket","fields":{"message":"success","headers":"cookie=private-cookie"}}');
    clientOptions?.onStderrLine?.("responses_websocket reconnecting... 2/5");
    clientOptions?.onStderrLine?.("responses_websocket request timed out; retry 3/5");
    clientOptions?.onStderrLine?.('{"target":"codex_models_manager::cache","fields":{"message":"models cache: cache is stale","cache_path":"/Users/private/.codex/models_cache.json","fetched_at":"2026-08-03 08:00:00 UTC","cache_ttl_secs":300},"span":{"refresh_strategy":"online_if_uncached","name":"list_models"}}');
    clientOptions?.onStderrLine?.('\u001b[2mcodex_models_manager::cache: models cache: cache entry applied cache_path=/Users/plain-private/.codex/models_cache.json etag=Some("private-etag")\u001b[0m');
    clientOptions?.onStderrLine?.("codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit");
    clientOptions?.onStderrLine?.("falling back to HTTP transport");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_transport_observed",
      transport: "responses_websocket",
      message: expect.stringContaining("responses_websocket"),
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_transport_observed",
      transport: "responses_http",
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_connection_status",
      state: "reconnecting",
      attempt: 2,
      maxAttempts: 5,
      message: "Codex WebSocket 正在重连（2/5）",
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_connection_status",
      state: "timeout",
      attempt: 3,
      maxAttempts: 5,
      message: "Codex WebSocket 连接超时，正在重试（3/5）",
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_connection_status",
      state: "fallback_https",
      message: "Codex WebSocket 不可用，已切换到 HTTPS",
    }));
    expect(diagnostics).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_connection_status",
      message: expect.stringContaining("模型"),
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      type: "provider_stderr",
      message: expect.stringContaining('"message":"models cache: cache is stale"'),
    }));
    const cacheDiagnostic = diagnostics.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "provider_stderr" && event.message.includes("models cache: cache is stale"));
    expect(cacheDiagnostic?.type).toBe("provider_stderr");
    expect(JSON.parse((cacheDiagnostic as { message: string }).message)).toMatchObject({
      fields: {
        message: "models cache: cache is stale",
        fetched_at: "2026-08-03 08:00:00 UTC",
        cache_ttl_secs: 300,
      },
      span: {
        name: "list_models",
        refresh_strategy: "online_if_uncached",
      },
    });
    const timeoutStatuses = diagnostics.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "provider_connection_status" && event.state === "timeout");
    expect(timeoutStatuses).toHaveLength(1);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private-cookie");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("/Users/private");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("/Users/plain-private");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private-etag");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("\\u001b");
    expect(JSON.stringify(diagnostics.mock.calls)).toContain("cache_path=<redacted>");
    expect(JSON.stringify(diagnostics.mock.calls)).toContain("etag=<redacted>");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("sensitive payload");
  });

  it("reports structured retry status and clears it on the first provider output", async () => {
    const diagnostics = vi.fn();
    const adapter = createCodexAgentRuntimeAdapter({
      clientFactory: () => ({
        start: async () => {},
        request: async (requestMethod) => {
          if (requestMethod === "thread/start") return { thread: { id: "thread-retry" } };
          if (requestMethod === "turn/start") return { turn: { id: "turn-retry" } };
          throw new Error(`unexpected request: ${requestMethod}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => {},
        notifications: async function* () {
          yield {
            method: "error",
            params: {
              threadId: "thread-retry",
              turnId: "turn-retry",
              willRetry: true,
              error: { message: "Reconnecting... 1/5", additionalDetails: null },
            },
          };
          yield {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-retry", turnId: "turn-retry", itemId: "item-1", delta: "ok" },
          };
          yield {
            method: "turn/completed",
            params: { threadId: "thread-retry", turn: { id: "turn-retry", status: "completed" } },
          };
        },
      }),
    });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      diagnostics,
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("hello"), options })) {
      if (event.type === "turn_completed") break;
    }

    const statuses = diagnostics.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "provider_connection_status");
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "reconnecting", attempt: 1, maxAttempts: 5 }),
      expect.objectContaining({ state: "clear" }),
    ]));
    const reconnectIndex = statuses.findIndex((event) => event.state === "reconnecting");
    expect(reconnectIndex).toBeGreaterThanOrEqual(0);
    expect(statuses.findIndex((event, index) => index > reconnectIndex && event.state === "clear"))
      .toBeGreaterThan(reconnectIndex);
  });

  it("normalizes Responses endpoint URLs to provider base URLs", () => {
    expect(normalizeCodexBaseUrl("https://example.test/v1/responses")).toBe("https://example.test/v1");
    expect(normalizeCodexBaseUrl("https://example.test/v1/")).toBe("https://example.test/v1");
    expect(normalizeCodexBaseUrl("")).toBe("https://api.openai.com/v1");
  });

  it("uses the latest turn usage for current context instead of cumulative thread usage", () => {
    const adapter = createCodexAgentRuntimeAdapter();
    const snapshot = adapter.contextUsageSnapshot({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { totalTokens: 634_054, inputTokens: 631_659, cachedInputTokens: 526_848 },
          last: { totalTokens: 35_447, inputTokens: 35_348, cachedInputTokens: 35_072 },
          modelContextWindow: 353_400,
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      totalTokens: 35_447,
      maxTokens: 353_400,
      percentage: expect.closeTo(10.03, 2),
      cacheInputTokens: 35_348,
      cacheReadInputTokens: 35_072,
    }));
  });

  it("preserves total usage while treating the bundled cache sentinel as unknown", () => {
    const adapter = createCodexAgentRuntimeAdapter();
    const snapshot = adapter.contextUsageSnapshot({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: -1 },
          last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: -1 },
          modelContextWindow: 1_000,
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      totalTokens: 100,
      maxTokens: 1_000,
      cacheInputTokens: 80,
      cacheReadInputTokens: null,
      cacheHitRate: null,
    }));
  });

  it("preserves the configured context window beside Codex's smaller usable window", async () => {
    const adapter = createCodexAgentRuntimeAdapter({
      clientFactory: () => ({
        start: async () => {},
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "thread-context" } };
          if (method === "turn/start") return { turn: { id: "turn-context" } };
          throw new Error(`unexpected request: ${method}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => {},
        notifications: async function* () {
          yield {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-context",
              turnId: "turn-context",
              tokenUsage: {
                last: { totalTokens: 14_000, inputTokens: 13_000, cachedInputTokens: 12_000 },
                modelContextWindow: 950_000,
              },
            },
          };
          yield {
            method: "turn/completed",
            params: { threadId: "thread-context", turn: { id: "turn-context", status: "completed" } },
          };
        },
      }),
    });
    const configuredRuntime = runtimeConfig();
    configuredRuntime.models = [{ id: "model-1", name: "mimo-v2.5", contextWindowK: 1_000 }];
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: configuredRuntime,
    });
    const query = adapter.runQuery({ prompt: adapter.createSingleTextInput("continue"), options });

    for await (const event of query) {
      if (event.type === "turn_completed") break;
    }

    expect(adapter.contextUsageSnapshot(await query.getContextUsage?.())).toEqual(expect.objectContaining({
      maxTokens: 950_000,
      rawMaxTokens: 1_000_000,
    }));
  });

  it.each([
    { inputTokens: 0, cachedInputTokens: 0 },
    { inputTokens: -10, cachedInputTokens: 5 },
  ])("does not calculate a cache rate for non-positive input usage: %o", ({ inputTokens, cachedInputTokens }) => {
    const adapter = createCodexAgentRuntimeAdapter();
    const snapshot = adapter.contextUsageSnapshot({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { totalTokens: 10, inputTokens, cachedInputTokens },
          modelContextWindow: 1_000,
        },
      },
    });

    expect(snapshot.cacheHitRate).toBeNull();
  });

  it("marks the post-compaction usage snapshot for automatic Codex compaction", async () => {
    const events = [
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "contextCompaction", id: "compact-1" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: { totalTokens: 320_000, inputTokens: 319_000, cachedInputTokens: 300_000 },
            last: { totalTokens: 24_892, inputTokens: 24_800, cachedInputTokens: 24_000 },
            modelContextWindow: 353_400,
          },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      },
    ];
    const adapter = createCodexAgentRuntimeAdapter({
      clientFactory: () => ({
        start: async () => {},
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "thread-1" } };
          if (method === "turn/start") return { turn: { id: "turn-1" } };
          throw new Error(`unexpected request: ${method}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => {},
        notifications: async function* () {
          for (const event of events) yield event;
        },
      }),
    });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });
    const query = adapter.runQuery({ prompt: adapter.createSingleTextInput("continue"), options });

    for await (const event of query) {
      if (event.type === "turn_completed") break;
    }

    const snapshot = adapter.contextUsageSnapshot(await query.getContextUsage?.());
    expect(snapshot).toEqual(expect.objectContaining({
      totalTokens: 24_892,
      percentage: expect.closeTo(7.04, 2),
      compacted: true,
    }));
  });

  it("preserves browser comment metadata when sending image attachments", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });

    for await (const event of adapter.runQuery({
      prompt: async function* () {
        yield adapter.createLeaderGuideMessage("flow-guide", "Check this element", [{
          kind: "browser_comment",
          media_type: "image/png",
          data: "abc",
          marker_number: 3,
          comment: "这里不对",
          label: "Submit button",
          page_url: "https://example.test/page",
          selector: "button.submit",
        }, {
          kind: "browser_comment",
          marker_number: 4,
          comment: "截图失败也要保留",
          label: "无截图按钮",
          page_url: "https://example.test/page",
          selector: 'button[data-state="]:ready"] · span',
        }]);
      }(),
      options,
    })) {
      if (event.type === "turn_completed") break;
    }

    const turnStart = requests.find((request) => request.method === "turn/start")?.params as { input?: Array<Record<string, unknown>> };
    expect(parseMessageSegments(String(turnStart.input?.[0]?.text ?? ""), "flow-guide")).toEqual([
      expect.objectContaining({ kind: "event", type: "guide", body: "Check this element" }),
      expect.objectContaining({
        kind: "event",
        type: "browser_comment",
        attrs: {
          n: "3",
          url: "https://example.test/page",
          label: "Submit button",
          selector: "button.submit",
        },
        body: "这里不对",
      }),
      expect.objectContaining({
        kind: "event",
        type: "browser_comment",
        attrs: {
          n: "4",
          url: "https://example.test/page",
          label: "无截图按钮",
          selector: 'button[data-state="]:ready"] · span',
        },
        body: "截图失败也要保留",
      }),
    ]);
    expect(turnStart.input?.[1]).toEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("<squadflow type=\"attachment\""),
    }));
    expect(parseMessageSegments(String(turnStart.input?.[1]?.text ?? "").trim(), "flow-guide")).toEqual([
      expect.objectContaining({ kind: "event", type: "attachment", body: expect.stringContaining("Comment 3") }),
    ]);
    expect(turnStart.input?.[2]).toEqual(expect.objectContaining({
      type: "image",
      url: "data:image/png;base64,abc",
    }));
    expect(turnStart.input).toHaveLength(3);
  });

  it("steers an active turn instead of starting a second turn for running guide input", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        if (method === "turn/steer") return { turnId: "turn-1" };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        await sleep(20);
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    async function* prompt() {
      yield { type: "text", text: "first" };
      await sleep(0);
      yield { type: "text", text: "guide" };
    }
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });

    for await (const event of adapter.runQuery({ prompt: prompt(), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(requests.find((request) => request.method === "turn/steer")?.params).toEqual(expect.objectContaining({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "guide", text_elements: [] }],
    }));
  });

  it("routes command approval requests through system permission callbacks", async () => {
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const permissionRequests: unknown[] = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: (id, result) => { responses.push({ id, result }); },
      close: () => {},
      notifications: async function* () {
        yield {
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            command: "rm -rf build",
            cwd: "/tmp/project",
          },
        };
        yield {
          id: "approval-2",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-2",
            command: "npm test",
            cwd: "/tmp/project",
          },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read", "shell"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      canUseTool: (request) => {
        permissionRequests.push(request);
        return { behavior: "allow", updatedInput: request.providerInput };
      },
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        capability: "shell",
        providerToolName: "commandExecution",
        input: { command: "rm -rf build", path: "/tmp/project" },
        context: { toolUseId: "cmd-1" },
      }),
      expect.objectContaining({
        capability: "shell",
        providerToolName: "commandExecution",
        input: { command: "npm test", path: "/tmp/project" },
        context: { toolUseId: "cmd-2" },
      }),
    ]);
    expect(responses).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-2", result: { decision: "accept" } },
    ]);
  });

  it("fails command approval closed when the command cannot be recovered", async () => {
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const permissionRequests: unknown[] = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: (id, result) => { responses.push({ id, result }); },
      close: () => {},
      notifications: async function* () {
        yield {
          id: "approval-missing",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-missing" },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/repo",
      scratchDir: "/tmp/scratch",
      capabilities: ["read", "shell"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      canUseTool: (request) => {
        permissionRequests.push(request);
        return { behavior: "allow" };
      },
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(permissionRequests).toEqual([]);
    expect(responses).toEqual([{ id: "approval-missing", result: { decision: "decline" } }]);
  });

  it("fails command approval closed when Codex requests additional permissions", async () => {
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const permissionRequests: unknown[] = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: (id, result) => { responses.push({ id, result }); },
      close: () => {},
      notifications: async function* () {
        yield {
          id: "approval-escalated",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-escalated",
            command: "./outside-write.sh",
            cwd: "/repo",
            additionalPermissions: {
              network: null,
              fileSystem: { write: ["/tmp"] },
            },
          },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/repo",
      scratchDir: "/managed/scratch",
      capabilities: ["read", "shell"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      canUseTool: (request) => {
        permissionRequests.push(request);
        return { behavior: "allow" };
      },
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(permissionRequests).toEqual([]);
    expect(responses).toEqual([{ id: "approval-escalated", result: { decision: "decline" } }]);
  });

  it("recovers command approval text from commandActions and still checks every request", async () => {
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const commands: Array<string | null | undefined> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: (id, result) => { responses.push({ id, result }); },
      close: () => {},
      notifications: async function* () {
        for (const id of ["approval-1", "approval-2"]) {
          yield {
            id,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: id,
              commandActions: [{ type: "unknown", command: "npm test 2>&1" }],
            },
          };
        }
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/repo",
      scratchDir: "/tmp/scratch",
      capabilities: ["read", "shell"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
      canUseTool: (request) => {
        commands.push(request.input.command);
        return { behavior: "allow" };
      },
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(commands).toEqual(["npm test 2>&1", "npm test 2>&1"]);
    expect(responses).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
      { id: "approval-2", result: { decision: "accept" } },
    ]);
  });

  it("answers official-login MCP elicitation approval requests with action responses", async () => {
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const permissionRequests: unknown[] = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: (id, result) => { responses.push({ id, result }); },
      close: () => {},
      notifications: async function* () {
        yield {
          id: "mcp-approval-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "squadflow-browser",
            mode: "form",
            message: "Allow the squadflow-browser MCP server to run tool \"browser_navigate\"?",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_params: { url: "https://example.test" },
            },
            requestedSchema: { type: "object", properties: {} },
          },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "frontend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: ["mcp__squadflow-browser__browser_navigate"],
      runtimeConfig: {
        ...runtimeConfig(),
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
      },
      canUseTool: (request) => {
        permissionRequests.push(request);
        return { behavior: "allow" };
      },
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        capability: null,
        providerToolName: "mcp__squadflow-browser__browser_navigate",
        input: { url: "https://example.test" },
      }),
    ]);
    expect(responses).toEqual([{ id: "mcp-approval-1", result: { action: "accept", content: {} } }]);
  });

  it("passes the resolved Codex runtime command and legacy stdio args to the app-server client", async () => {
    const clientOptions: CodexAppServerClientOptions[] = [];
    const clientFactory: CodexClientFactory = (options) => {
      clientOptions.push(options);
      return {
        start: async () => {},
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "thread-1" } };
          if (method === "turn/start") return { turn: { id: "turn-1" } };
          throw new Error(`unexpected request: ${method}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => {},
        notifications: async function* () {
          yield {
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          };
        },
      };
    };
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });

    for await (const event of adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options })) {
      if (event.type === "turn_completed") break;
    }

    expect(clientOptions[0].command).toBe(options.appServerCommand);
    expect(clientOptions[0].args?.slice(0, 5)).toEqual(["app-server", "--listen", "stdio://", "--disable", "image_generation"]);
    expect(clientOptions[0].env?.CODEX_HOME).toBe(options.runtimeProfile.codexHome);
  });

  it("loads complete custom-provider history from the native rollout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-history-"));
    const previousCodexHome = process.env.SQUADFLOW_CODEX_HOME;
    process.env.SQUADFLOW_CODEX_HOME = root;
    writeCodexRollout(root, "thread-1", [
      { timestamp: "2026-07-15T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: "2026-07-15T00:00:00.010Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hidden runtime prompt" }] },
      },
      { timestamp: "2026-07-15T00:00:00.020Z", type: "turn_context", payload: { turn_id: "turn-1" } },
      {
        timestamp: "2026-07-15T00:00:00.030Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      },
      {
        timestamp: "2026-07-15T00:00:00.100Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "thinking" }] },
      },
      {
        timestamp: "2026-07-15T00:00:00.200Z",
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "pwd" }) },
      },
      {
        timestamp: "2026-07-15T00:00:00.300Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "project-root" },
      },
      {
        timestamp: "2026-07-15T00:00:00.400Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "world" }] },
      },
      { timestamp: "2026-07-15T00:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ]);
    const clientFactory = vi.fn(() => { throw new Error("app-server should not start"); }) as unknown as CodexClientFactory;
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory, runtimeConfig: runtimeConfig() });

    try {
      const history = await adapter.loadSessionHistory("thread-1", "flow-history");
      expect(clientFactory).not.toHaveBeenCalled();
      expect(history).toEqual([
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({
          role: "assistant",
          content: "world",
          parts: [
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
            expect.objectContaining({
              type: "tool-exec_command",
              toolCallId: "call-1",
              capability: "shell",
              state: "output-available",
              input: { cmd: "pwd" },
              output: { content: "project-root", is_error: false },
            }),
            expect.objectContaining({ type: "text", text: "world" }),
          ],
          metadata: { turnTiming: {
            startedAt: "2026-07-15T00:00:00.000Z",
            finishedAt: "2026-07-15T00:00:01.000Z",
            durationMs: 1000,
          } },
        }),
      ]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.SQUADFLOW_CODEX_HOME;
      else process.env.SQUADFLOW_CODEX_HOME = previousCodexHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads official history from the native rollout and skips encrypted reasoning", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-history-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    writeCodexRollout(root, "thread-external", [
      { timestamp: "2026-07-15T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-07-15T00:00:00.010Z", type: "turn_context", payload: { turn_id: "turn-1" } },
      {
        timestamp: "2026-07-15T00:00:00.020Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
      },
      {
        timestamp: "2026-07-15T00:00:00.100Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [], encrypted_content: "encrypted" },
      },
      {
        timestamp: "2026-07-15T00:00:00.200Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", call_id: "internal-1", input: "tool router" },
      },
      {
        timestamp: "2026-07-15T00:00:00.300Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp-1",
          invocation: { server: "squadflow-leader", tool: "get_context", arguments: { flow_id: "flow-external" } },
          result: { Ok: { content: [{ type: "text", text: "context" }] } },
        },
      },
      {
        timestamp: "2026-07-15T00:00:00.400Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好！" }] },
      },
      { timestamp: "2026-07-15T00:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ]);
    const inheritedConfig: RuntimeConfig = {
      ...runtimeConfig(),
      authMode: "inherited",
      baseUrl: "",
      apiKey: "",
    };
    const clientFactory = vi.fn(() => { throw new Error("app-server should not start"); }) as unknown as CodexClientFactory;
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory, runtimeConfig: inheritedConfig });

    try {
      const history = await adapter.loadSessionHistory("thread-external", "flow-external");
      expect(clientFactory).not.toHaveBeenCalled();
      expect(history.map((message) => message.content)).toEqual(["你好", "你好！"]);
      expect(history[1]?.parts).toEqual([
        expect.objectContaining({
          type: "tool-mcp__squadflow-leader__get_context",
          toolCallId: "mcp-1",
          state: "output-available",
          output: { content: "context", is_error: false },
        }),
        expect.objectContaining({ type: "text", text: "你好！" }),
      ]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs context compaction through thread/compact/start and waits for the compact turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/resume") return { thread: { id: "thread-1" } };
        if (method === "thread/compact/start") return {};
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        yield {
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "compact-1", item: { type: "contextCompaction", id: "compact-item" } },
        };
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "compact-1", status: "completed" } },
        };
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      resume: "thread-1",
      runtimeConfig: runtimeConfig(),
    });
    const runtimeEvents: RuntimeEvent[] = [];

    for await (const event of adapter.runQuery({ prompt: adapter.compactContextInput(), options })) {
      runtimeEvents.push(event);
      if (event.type === "turn_completed") break;
    }

    expect(requests.map((request) => request.method)).toEqual(["thread/resume", "thread/compact/start"]);
    const threadResume = requests[0]?.params as Record<string, unknown>;
    expect(threadResume.developerInstructions).toEqual(expect.stringContaining("leader"));
    expect(threadResume).not.toHaveProperty("baseInstructions");
    const lastEvent = runtimeEvents.at(-1);
    expect(lastEvent?.type).toBe("turn_completed");
    expect(lastEvent?.type === "turn_completed" ? lastEvent.result : null).toEqual(expect.objectContaining({
      status: "success",
      isError: false,
      sessionId: "thread-1",
    }));
  });

  it("loads compact metadata from Codex rollout token counts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
    const rolloutPath = path.join(root, "rollout.jsonl");
    const database = new Database(path.join(root, "state_5.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-1", rolloutPath);
    database.close();
    fs.writeFileSync(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-07-02T23:59:59.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 119_000 },
            last_token_usage: { total_tokens: 29_000 },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        type: "compacted",
        payload: null,
      }),
      JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 120_000 },
            last_token_usage: { total_tokens: 1_200 },
          },
        },
      }),
      "",
    ].join("\n"));
    const clientFactory = vi.fn(() => { throw new Error("app-server should not start"); }) as unknown as CodexClientFactory;
    const previousCodexHome = process.env.SQUADFLOW_CODEX_HOME;
    process.env.SQUADFLOW_CODEX_HOME = root;
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });

    try {
      await expect(adapter.latestCompactTranscriptMetadata("thread-1")).resolves.toEqual({
        postTokens: 1200,
        timestamp: "2026-07-03T00:00:00.000Z",
      });
      expect(clientFactory).not.toHaveBeenCalled();
    } finally {
      if (previousCodexHome === undefined) delete process.env.SQUADFLOW_CODEX_HOME;
      else process.env.SQUADFLOW_CODEX_HOME = previousCodexHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues a steer input that arrives after the turn already completed as the next turn's input", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let turnCounter = 0;
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") {
          turnCounter += 1;
          return { turn: { id: `turn-${turnCounter}` } };
        }
        if (method === "turn/steer") throw new Error("turn already completed");
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        await sleep(20);
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
        await sleep(20);
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
        };
      },
    });
    async function* prompt() {
      yield { type: "text", text: "first" };
      await sleep(0);
      yield { type: "text", text: "guide" };
    }
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });

    const raws: unknown[] = [];
    for await (const raw of adapter.runQuery({ prompt: prompt(), options })) {
      raws.push(raw);
    }

    expect(requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
    const turnStarts = requests.filter((request) => request.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1].params).toEqual(expect.objectContaining({
      input: [{ type: "text", text: "guide", text_elements: [] }],
    }));
  });

  it("executes a compact input that arrives while a turn is running after the turn completes", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        if (method === "thread/compact/start") return {};
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => {},
      notifications: async function* () {
        await sleep(20);
        yield {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        };
        await sleep(20);
        yield {
          method: "thread/compacted",
          params: { threadId: "thread-1" },
        };
      },
    });
    async function* prompt() {
      yield { type: "text", text: "first" };
      await sleep(0);
      yield { type: "compact" };
    }
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: "leader",
      cwd: "/tmp/project",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });

    for await (const raw of adapter.runQuery({ prompt: prompt(), options })) {
      void raw;
    }

    expect(requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/compact/start",
    ]);
  });

  it("closes the client after a timeout when turn/interrupt hangs", async () => {
    vi.useFakeTimers();
    try {
      let clientClosed = false;
      const clientFactory: CodexClientFactory = () => ({
        start: async () => {},
        request: async (method) => {
          if (method === "thread/start") return { thread: { id: "thread-1" } };
          if (method === "turn/start") return { turn: { id: "turn-1" } };
          if (method === "turn/interrupt") return new Promise(() => {});
          throw new Error(`unexpected request: ${method}`);
        },
        notify: () => {},
        respond: () => {},
        close: () => { clientClosed = true; },
        notifications: async function* () {
          await new Promise(() => {});
        },
      });
      const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
      const options = adapter.buildExpertOptions({
        role: "backend",
        systemPrompt: "expert",
        cwd: "/tmp/project",
        scratchDir: "/tmp/scratch",
        capabilities: ["read", "write", "edit", "shell", "search"],
        mcpTools: [],
        runtimeConfig: runtimeConfig(),
      });
      const query = adapter.runQuery({ prompt: adapter.createSingleTextInput("do work"), options });
      const iterator = query[Symbol.asyncIterator]();
      void iterator.next();

      await vi.advanceTimersByTimeAsync(0);
      query.close?.();
      expect(clientClosed).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      expect(clientClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not interrupt a turn whose completion event has already been yielded", async () => {
    const requests: string[] = [];
    let clientClosed = false;
    const clientFactory: CodexClientFactory = () => ({
      start: async () => {},
      request: async (method) => {
        requests.push(method);
        if (method === "thread/start") return { thread: { id: "thread-complete" } };
        if (method === "turn/start") return { turn: { id: "turn-complete" } };
        if (method === "turn/interrupt") throw new Error("turn/interrupt should not be sent");
        throw new Error(`unexpected request: ${method}`);
      },
      notify: () => {},
      respond: () => {},
      close: () => { clientClosed = true; },
      notifications: async function* () {
        yield {
          method: "turn/completed",
          params: { threadId: "thread-complete", turn: { id: "turn-complete", status: "completed" } },
        };
        await new Promise(() => {});
      },
    });
    const adapter = createCodexAgentRuntimeAdapter({ clientFactory });
    const options = adapter.buildExpertOptions({
      role: "backend",
      systemPrompt: "expert",
      cwd: "/tmp/project",
      scratchDir: "/tmp/scratch",
      capabilities: ["read"],
      mcpTools: [],
      runtimeConfig: runtimeConfig(),
    });
    const query = adapter.runQuery({ prompt: adapter.createSingleTextInput("done"), options });
    const iterator = query[Symbol.asyncIterator]();

    const completed = await iterator.next();
    expect(completed.value).toMatchObject({ type: "turn_completed" });
    await query.close?.();

    expect(requests).toEqual(["thread/start", "turn/start"]);
    expect(clientClosed).toBe(true);
  });

  it("prepares Leader MCP as an HTTP bridge inside the Codex adapter", async () => {
    const adapter = createCodexAgentRuntimeAdapter();
    const serverFactory = () => ({ close: async () => {} }) as any;
    const registerCalls: Array<{ namePrefix?: string; options?: Record<string, unknown> }> = [];
    const binding = await adapter.prepareLeaderMcpServer({
      server: { close: async () => {} } as any,
      serverFactory,
      bindingKey: "leader:agent-session-1",
      bridgeRegistry: {
        register: async (_server: unknown, namePrefix?: string, options?: Record<string, unknown>) => {
          registerCalls.push({ namePrefix, options });
          return {
            id: "leader-test",
            url: "http://127.0.0.1:8001/api/mcp/leader/leader-test",
            bearerToken: "secret-token",
            bearerTokenEnvVar: "SQUADFLOW_LEADER_MCP_TOKEN_TEST",
            close: async () => {},
          };
        },
      } as any,
    });

    expect(registerCalls).toEqual([{
      namePrefix: "leader",
      options: { stableKey: "leader:agent-session-1", createServer: serverFactory },
    }]);
    expect(binding.mcpServerConfig).toEqual({
      type: "http",
      name: "squadflow-leader",
      url: "http://127.0.0.1:8001/api/mcp/leader/leader-test",
      bearerToken: "secret-token",
      bearerTokenEnvVar: "SQUADFLOW_LEADER_MCP_TOKEN_TEST",
    });
  });

  it("prepares Expert MCP (browser) as an HTTP bridge with the browser name prefix inside the Codex adapter", async () => {
    const adapter = createCodexAgentRuntimeAdapter();
    const serverFactory = () => ({ close: async () => {} }) as any;
    const registerCalls: Array<{ namePrefix?: string; options?: Record<string, unknown> }> = [];
    const binding = await adapter.prepareExpertMcpServer({
      serverName: "squadflow-browser",
      server: { close: async () => {} } as any,
      serverFactory,
      bindingKey: "expert-browser:flow-expert-1",
      bridgeRegistry: {
        register: async (_server: unknown, namePrefix?: string, options?: Record<string, unknown>) => {
          registerCalls.push({ namePrefix, options });
          return {
            id: "browser-test",
            url: "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
            bearerToken: "secret-browser-token",
            bearerTokenEnvVar: "SQUADFLOW_MCP_BRIDGE_TOKEN_TEST",
            close: async () => {},
          };
        },
      } as any,
    });

    expect(registerCalls).toEqual([{
      namePrefix: "squadflow-browser",
      options: { stableKey: "expert-browser:flow-expert-1", createServer: serverFactory },
    }]);
    expect(binding.mcpServerConfig).toEqual({
      type: "http",
      name: "squadflow-browser",
      url: "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
      bearerToken: "secret-browser-token",
      bearerTokenEnvVar: "SQUADFLOW_MCP_BRIDGE_TOKEN_TEST",
    });
  });
});

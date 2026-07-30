import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_DECLINED_OUTPUT,
  createCodexToUiChunkAdapter,
} from "../src/adapter/codexToUiChunks.js";

describe("Codex to UI chunk adapter", () => {
  it("captures the thread id before the turn completes", () => {
    const adapter = createCodexToUiChunkAdapter("msg-1");

    adapter.adapt({
      method: "item/started",
      params: {
        threadId: "thread-early-codex",
        item: { type: "agentMessage", id: "item-1", text: "" },
      },
    });

    expect(adapter.sdkSessionId).toBe("thread-early-codex");
  });

  it("keeps input usage but reports cache usage as unknown for the bundled sentinel", () => {
    const adapter = createCodexToUiChunkAdapter("msg-cache-unknown");

    adapter.adapt({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 80, cachedInputTokens: -1 },
        },
      },
    });

    expect(adapter.resultCacheUsage).toEqual({
      inputTokens: 80,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    });

    adapter.adapt({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 100, cachedInputTokens: 75 },
        },
      },
    });

    expect(adapter.resultCacheUsage).toEqual({
      inputTokens: 100,
      cacheReadInputTokens: 75,
      cacheCreationInputTokens: 0,
      cacheHitRate: 75,
    });
  });

  it("replaces a known cache result with unknown when the latest event omits telemetry", () => {
    const adapter = createCodexToUiChunkAdapter("msg-cache-latest-unknown");

    adapter.adapt({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 80 } } },
    });
    adapter.adapt({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { last: { inputTokens: 120, cachedInputTokens: -1 } } },
    });

    expect(adapter.resultCacheUsage).toEqual({
      inputTokens: 120,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    });
  });

  it("emits a commandExecution tool call only once across item/started and item/completed", () => {
    const adapter = createCodexToUiChunkAdapter("msg-1");

    const startedChunks = adapter.adapt({
      method: "item/started",
      params: {
        threadId: "thread-1",
        item: { type: "commandExecution", id: "cmd-1", command: "npm test", cwd: "/tmp/project" },
      },
    });
    const completedChunks = adapter.adapt({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "npm test",
          cwd: "/tmp/project",
          aggregatedOutput: "ok",
          status: "completed",
        },
      },
    });

    expect(startedChunks.filter((chunk) => chunk.type === "tool-input-start")).toHaveLength(1);
    expect(completedChunks.filter((chunk) => chunk.type === "tool-input-start")).toHaveLength(0);
    expect(completedChunks.filter((chunk) => chunk.type === "tool-output-available")).toHaveLength(1);
  });

  it("preserves an explicit command decline without treating ordinary failures as denials", () => {
    const declinedAdapter = createCodexToUiChunkAdapter("msg-declined");
    const declinedChunks = declinedAdapter.adapt({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-declined",
          command: "rm -rf tmp",
          cwd: "/tmp/project",
          aggregatedOutput: "",
          status: "declined",
        },
      },
    });

    expect(declinedChunks).toContainEqual(expect.objectContaining({
      type: "tool-output-available",
      toolCallId: "cmd-declined",
      output: { content: CODEX_COMMAND_DECLINED_OUTPUT, is_error: true },
    }));

    const failedAdapter = createCodexToUiChunkAdapter("msg-failed");
    const failedChunks = failedAdapter.adapt({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd-failed",
          command: "npm test",
          cwd: "/tmp/project",
          aggregatedOutput: "npm test failed",
          status: "failed",
        },
      },
    });

    expect(failedChunks).toContainEqual(expect.objectContaining({
      type: "tool-output-available",
      toolCallId: "cmd-failed",
      output: { content: "npm test failed", is_error: true },
    }));
  });

  it("emits an MCP tool call only once across item/started and item/completed", () => {
    const adapter = createCodexToUiChunkAdapter("msg-1");
    const item = {
      type: "mcpToolCall",
      id: "mcp-plan-1",
      server: "squadflow-leader",
      tool: "submit_orchestration_plan",
      arguments: { title: "登录限制" },
    };

    const startedChunks = adapter.adapt({ method: "item/started", params: { item } });
    const completedChunks = adapter.adapt({
      method: "item/completed",
      params: { item: { ...item, result: { content: [{ type: "text", text: "ok" }] } } },
    });

    expect(startedChunks.filter((chunk) => chunk.type === "tool-input-start")).toHaveLength(1);
    expect(completedChunks.filter((chunk) => chunk.type === "tool-input-start")).toHaveLength(0);
    expect(completedChunks.filter((chunk) => chunk.type === "tool-input-available")).toHaveLength(1);
    expect(completedChunks.filter((chunk) => chunk.type === "tool-output-available")).toHaveLength(1);
  });

  it("keeps external MCP identity, icons, and structured result content", () => {
    const adapter = createCodexToUiChunkAdapter("msg-external-mcp");
    const item = {
      type: "mcpToolCall",
      id: "mcp-search-1",
      server: "tavily-mcp",
      tool: "tavily_search",
      title: "Tavily Search",
      icons: [{ src: "https://example.com/tavily.png", mimeType: "image/png", sizes: ["18x18"] }],
      arguments: { query: "MCP" },
    };

    const chunks = adapter.adapt({
      method: "item/completed",
      params: {
        item: {
          ...item,
          result: {
            content: [{ type: "text", text: "Detailed Results" }],
            structuredContent: { results: [{ title: "MCP" }] },
            isError: false,
          },
        },
      },
    });

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool-input-available",
        toolName: "mcp__tavily-mcp__tavily_search",
        mcp: {
          server: "tavily-mcp",
          tool: "tavily_search",
          title: "Tavily Search",
          icons: [{ src: "https://example.com/tavily.png", mimeType: "image/png", sizes: ["18x18"] }],
        },
      }),
      expect.objectContaining({
        type: "tool-output-available",
        output: {
          content: "Detailed Results",
          is_error: false,
          mcp: {
            content: [{ type: "text", text: "Detailed Results" }],
            structuredContent: { results: [{ title: "MCP" }] },
            isError: false,
          },
        },
      }),
    ]));
  });

  it("uses the active Flow MCP status icons when a tool event has no icon metadata", () => {
    const mcpServerIcons = new Map();
    const adapter = createCodexToUiChunkAdapter("msg-status-icon", { mcpServerIcons });
    adapter.captureMcpServerStatus({
      data: [{
        name: "context7",
        serverInfo: {
          icons: [{ src: "https://context7.com/context7-icon-green.png", mimeType: "image/png" }],
        },
      }],
    });

    const chunks = adapter.adapt({
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          id: "mcp-context7-1",
          server: "context7",
          tool: "query-docs",
          arguments: { query: "MCP" },
          result: { content: [{ type: "text", text: "ok" }] },
        },
      },
    });

    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-input-available",
      mcp: {
        server: "context7",
        tool: "query-docs",
        serverIcons: [{ src: "https://context7.com/context7-icon-green.png", mimeType: "image/png" }],
      },
    }));
  });

  it("uses only the last agentMessage item's full text as finalAssistantText across multi-segment turns", () => {
    const adapter = createCodexToUiChunkAdapter("msg-1");

    adapter.adapt({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "item-1", delta: "让我看看代码库…" },
    });
    adapter.adapt({
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "agentMessage", id: "item-1", text: "让我看看代码库…" } },
    });
    adapter.adapt({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", itemId: "item-2", delta: "已完成修复。" },
    });
    adapter.adapt({
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "agentMessage", id: "item-2", text: "已完成修复。" } },
    });
    adapter.adapt({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });

    expect(adapter.finalAssistantText).toBe("已完成修复。");
    expect(adapter.resultStatus).toBe("success");
    expect(adapter.resultIsError).toBe(false);
  });

  it("preserves the provider error wording from a failed turn", () => {
    const adapter = createCodexToUiChunkAdapter("msg-error");
    const providerError = "Unsupported model mimo-v2.5-pro[1m].";

    const chunks = adapter.adapt({
      method: "turn/completed",
      params: {
        threadId: "thread-error",
        turn: {
          id: "turn-error",
          status: "failed",
          error: { message: providerError },
        },
      },
    });

    expect(chunks).toEqual([]);
    expect(adapter.resultError).toBe(providerError);
    expect(adapter.resultStatus).toBe("failed");
    expect(adapter.resultIsError).toBe(true);
  });
});

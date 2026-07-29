import { describe, expect, it } from "vitest";
import {
  adaptClaudeMessageToUiChunks,
  createClaudeToUiChunkAdapter,
} from "../src/adapter/claudeToUiChunks.js";

describe("adaptClaudeMessageToUiChunks", () => {
  it("converts SDK text delta shape", () => {
    const chunks = adaptClaudeMessageToUiChunks(
      { type: "stream_event", event: { delta: { type: "text_delta", text: "hi" } } },
      "msg-1",
    );

    expect(chunks.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta"]);
    expect(chunks[1]).toMatchObject({ delta: "hi", id: "blk-msg-1-1" });
  });

  it("captures the SDK session id from the init event before a turn result", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");

    adapter.adapt({ type: "system", subtype: "init", session_id: "sdk-early-claude" });

    expect(adapter.sdkSessionId).toBe("sdk-early-claude");
  });

  it("uses the current Flow MCP server icon for Claude tool chunks", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-mcp-icons", {
      mcpServerIcons: new Map(),
    });

    adapter.captureMcpServerStatus([{
      name: "context7",
      serverInfo: {
        icons: [{
          src: "https://context7.com/context7-icon-green.png",
          mimeType: "image/png",
        }],
      },
    }]);

    const chunks = adapter.adapt({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-context7",
          name: "mcp__context7__query-docs",
          input: { query: "React" },
        }],
      },
    });

    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: "tool-input-available",
      toolName: "mcp__context7__query-docs",
      mcp: {
        server: "context7",
        tool: "query-docs",
        serverIcons: [{
          src: "https://context7.com/context7-icon-green.png",
          mimeType: "image/png",
        }],
      },
    }));
  });

  it("converts assistant message content blocks without duplicating streamed text", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    const streamed = adapter.adapt({ type: "stream_event", event: { delta: { type: "text_delta", text: "hi" } } });
    const final = adapter.adapt({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    });

    expect(streamed.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta"]);
    expect(final.map((chunk) => chunk.type)).toEqual([
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
    ]);
  });

  it("streams a tool call while Claude is still generating its input", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");

    const started = adapter.adapt({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-plan",
          name: "mcp__squadflow-leader__submit_orchestration_plan",
          input: {},
        },
      },
    });
    const delta = adapter.adapt({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"title\":\"登录限制" },
      },
    });
    const completed = adapter.adapt({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-plan",
          name: "mcp__squadflow-leader__submit_orchestration_plan",
          input: { title: "登录限制" },
        }],
      },
    });

    expect(started).toEqual([
      expect.objectContaining({
        type: "tool-input-start",
        toolCallId: "tool-plan",
        toolName: "mcp__squadflow-leader__submit_orchestration_plan",
      }),
    ]);
    expect(delta).toEqual([
      expect.objectContaining({ type: "tool-input-delta", toolCallId: "tool-plan", inputTextDelta: "{\"title\":\"登录限制" }),
    ]);
    expect(completed.map((chunk) => chunk.type)).toEqual(["tool-input-available"]);
  });

  it("emits assistant text after a streamed tool call completes", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");

    adapter.adapt({ type: "stream_event", event: { delta: { type: "text_delta", text: "checking" } } });
    adapter.adapt({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    });
    adapter.adapt({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false }],
      },
    });

    const afterTool = adapter.adapt({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    });

    expect(afterTool.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(afterTool[1]).toMatchObject({ delta: "done" });
  });

  it("closes streamed text when its canonical assistant message arrives without a following tool", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");

    adapter.adapt({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "Now I have a comprehensive understanding." } },
    });
    const canonical = adapter.adapt({
      type: "assistant",
      message: { content: [{ type: "text", text: "Now I have a comprehensive understanding." }] },
    });

    expect(canonical.map((chunk) => chunk.type)).toEqual(["text-end"]);
  });

  it("does not suppress text after a streamed thinking-only assistant message", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");

    adapter.adapt({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "checking" } } });
    const thinkingConfirmation = adapter.adapt({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "checking" }],
      },
    });

    const textMessage = adapter.adapt({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "final answer" }],
      },
    });

    expect(thinkingConfirmation.map((chunk) => chunk.type)).toEqual(["reasoning-end"]);
    expect(textMessage.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(textMessage[1]).toMatchObject({ delta: "final answer" });
  });

  it("converts tool result metadata from synthetic user messages", () => {
    const chunks = adaptClaudeMessageToUiChunks(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false }],
        },
      },
      "msg-1",
    );

    expect(chunks).toEqual([
      {
        type: "tool-output-available",
        messageId: "msg-1",
        seq: 0,
        toolCallId: "tool-1",
        output: { content: "file contents", is_error: false },
      },
    ]);
  });

  it("does not represent true errors as UIMessage chunks", () => {
    const chunks = adaptClaudeMessageToUiChunks(
      { type: "assistant", error: "rate_limit", message: { content: [] } },
      "msg-1",
    );

    expect(chunks).toEqual([]);
  });

  it("preserves user-visible text from synthetic SDK error messages", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    const chunks = adapter.adapt({
      type: "assistant",
      error: "authentication_failed",
      message: {
        content: [{
          type: "text",
          text: "Failed to authenticate. API Error: 403 AccessDenied: Free quota exhausted.",
        }],
      },
    });

    expect(chunks.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(chunks[1]).toMatchObject({
      delta: "Failed to authenticate. API Error: 403 AccessDenied: Free quota exhausted.",
    });
    expect(adapter.finalAssistantText).toBe(
      "Failed to authenticate. API Error: 403 AccessDenied: Free quota exhausted.",
    );
  });

  it("keeps the provider wording when the SDK marks the assistant message as an API error", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-api-error");
    const providerError = "API Error: 400 Unsupported model mimo-v2.5-pro[1m].";

    const chunks = adapter.adapt({
      type: "assistant",
      isApiErrorMessage: true,
      error: "unknown",
      message: { content: [{ type: "text", text: providerError }] },
    });

    expect(chunks.map((chunk) => chunk.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(adapter.resultError).toBe(providerError);
    expect(adapter.resultIsError).toBe(true);
  });

  it("ignores unknown non-error events conservatively", () => {
    const chunks = adaptClaudeMessageToUiChunks(
      { type: "system", subtype: "permission_denied", tool_name: "Write", tool_use_id: "tool-1" },
      "msg-1",
    );

    expect(chunks).toEqual([]);
  });

  it("records result metadata internally without emitting chunks", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    const resultChunks = adapter.adapt({
      type: "result",
      subtype: "success",
      session_id: "sdk-session",
      is_error: false,
    });

    expect(resultChunks).toEqual([]);
    expect(adapter.sdkSessionId).toBe("sdk-session");
    expect(adapter.resultStatus).toBe("success");
    expect(adapter.resultIsError).toBe(false);
  });

  it("does not treat a string false result flag as an SDK error", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    adapter.adapt({
      type: "result",
      subtype: "success",
      session_id: "sdk-session",
      is_error: "false",
    });

    expect(adapter.resultStatus).toBe("success");
    expect(adapter.resultIsError).toBe(false);
  });

  it("carries SDK duration_ms into the finish chunk", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    adapter.adapt({
      type: "result",
      subtype: "success",
      duration_ms: 4321,
      is_error: false,
      session_id: "sdk-1",
    });

    expect(adapter.finish()).toEqual([
      { type: "finish", messageId: "msg-1", seq: 0, durationMs: 4321, finishedAt: expect.any(String) },
    ]);
  });

  it("finish only emits block closures and finish", () => {
    const adapter = createClaudeToUiChunkAdapter("msg-1");
    adapter.adapt({ type: "stream_event", event: { delta: { type: "text_delta", text: "hi" } } });

    expect(adapter.finish().map((chunk) => chunk.type)).toEqual(["text-end", "finish"]);
  });
});

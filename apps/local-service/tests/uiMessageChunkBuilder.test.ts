import { describe, expect, it } from "vitest";
import { UiMessageChunkBuilder } from "../src/protocol/uiMessageChunkBuilder.js";
import { UiMessageChunkSchema } from "../src/protocol/uiMessageChunks.js";

describe("UiMessageChunkBuilder", () => {
  it("wraps text deltas with start/end lifecycle and stable ids", () => {
    const builder = new UiMessageChunkBuilder("msg-1");
    const chunks = [
      builder.start(),
      ...builder.textDelta("Hello"),
      ...builder.textDelta(" World"),
      ...builder.finish(4321, "2026-06-18T08:36:34.898Z"),
    ];

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks.map((chunk) => UiMessageChunkSchema.parse(chunk).type)).toEqual(chunks.map((chunk) => chunk.type));
    expect(chunks[0]).toMatchObject({
      messageId: "msg-1",
      seq: 0,
    });
    expect(chunks[1]).toMatchObject({ messageId: "msg-1", seq: 1, id: "blk-msg-1-1" });
    expect(chunks[2]).toMatchObject({ messageId: "msg-1", seq: 2, id: "blk-msg-1-1", delta: "Hello" });
    expect(chunks[5]).toMatchObject({
      type: "finish",
      messageId: "msg-1",
      seq: 5,
      durationMs: 4321,
      finishedAt: "2026-06-18T08:36:34.898Z",
    });
  });

  it("closes reasoning before text", () => {
    const builder = new UiMessageChunkBuilder("msg-1");
    const chunks = [
      builder.start(),
      ...builder.reasoningDelta("Think"),
      ...builder.textDelta("Answer"),
      ...builder.finish(null, "2026-06-18T08:36:34.898Z"),
    ];

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("emits tool input and output chunks", () => {
    const builder = new UiMessageChunkBuilder("msg-1");
    const chunks = [
      builder.start(),
      ...builder.toolCall("Bash", "tool-1", { command: "python hello.py" }),
      builder.toolResult("tool-1", "Hello World", false),
      ...builder.finish(null, "2026-06-18T08:36:34.898Z"),
    ];

    expect(chunks.map((chunk) => chunk.type)).toContain("tool-input-start");
    expect(chunks.map((chunk) => chunk.type)).toContain("tool-input-delta");
    expect(chunks.map((chunk) => chunk.type)).toContain("tool-input-available");
    expect(chunks.map((chunk) => chunk.type)).toContain("tool-output-available");
    expect(chunks.find((chunk) => chunk.type === "tool-input-delta")).toMatchObject({
      toolCallId: "tool-1",
      inputTextDelta: "{\"command\":\"python hello.py\"}",
    });
    expect(chunks.find((chunk) => chunk.type === "tool-output-available")).toMatchObject({
      toolCallId: "tool-1",
      output: { content: "Hello World", is_error: false },
    });
  });

  it("preserves MCP metadata and the normalized result envelope", () => {
    const builder = new UiMessageChunkBuilder("msg-mcp");
    const chunks = [
      ...builder.toolCall("mcp__demo__lookup", "tool-1", { query: "MCP" }, {
        providerToolName: "mcpToolCall",
        mcp: {
          server: "demo",
          tool: "lookup",
          title: "Demo Lookup",
          icons: [{ src: "https://example.com/icon.png", mimeType: "image/png" }],
        },
      }),
      builder.toolResult("tool-1", "found", false, {
        content: [{ type: "text", text: "found" }],
        structuredContent: { count: 1 },
      }),
    ];

    expect(UiMessageChunkSchema.parse(chunks[0])).toMatchObject({
      type: "tool-input-start",
      mcp: { server: "demo", tool: "lookup", title: "Demo Lookup" },
    });
    expect(UiMessageChunkSchema.parse(chunks.at(-1))).toMatchObject({
      type: "tool-output-available",
      output: {
        content: "found",
        is_error: false,
        mcp: {
          content: [{ type: "text", text: "found" }],
          structuredContent: { count: 1 },
        },
      },
    });
  });

  it("rejects unsupported data, error, and done chunk extensions", () => {
    expect(() => UiMessageChunkSchema.parse({ type: "data-claude-result", data: {} })).toThrow();
    expect(() => UiMessageChunkSchema.parse({ type: "error", code: "rate_limit", message: "limited" })).toThrow();
    expect(() => UiMessageChunkSchema.parse({ type: "done" })).toThrow();
  });
});

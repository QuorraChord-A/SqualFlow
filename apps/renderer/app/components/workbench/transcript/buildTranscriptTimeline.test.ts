import { describe, expect, it } from "vitest";

import {
  buildTranscriptTimeline,
  computeFinishedTiming,
  deriveActivity,
  deriveActivityFromMessage,
  readHistoryTurnTiming,
} from "./buildTranscriptTimeline";
import type { UIMessage } from "ai";
import type { TimelineInputMessage, TimelineInputPart } from "./types";

function makeToolPart(
  toolCallId: string,
  toolName: string,
  state: "input-streaming" | "input-available" | "output-available",
  input?: Record<string, unknown>,
  output?: unknown,
): TimelineInputPart {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    toolName,
    state,
    input: input ?? null,
    output: output ?? null,
  };
}

describe("buildTranscriptTimeline", () => {
  it("projects a completed assistant message into blocks", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "I should use tools", state: "done" },
        { type: "text", text: "Let me help." },
        makeToolPart("read-1", "Read", "output-available", { file_path: "/repo/package.json" }, { content: "{}" }),
        makeToolPart("edit-1", "Edit", "output-available", { file_path: "/repo/LoginForm.tsx" }, { content: "ok" }),
        { type: "text", text: "Done." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks).toEqual([
      expect.objectContaining({ type: "reasoning", defaultCollapsed: true, streaming: false }),
      expect.objectContaining({ type: "text", streaming: false }),
      expect.objectContaining({
        type: "tool-group",
        finalized: true,
        defaultCollapsed: true,
        tools: [
          expect.objectContaining({ toolCallId: "read-1" }),
          expect.objectContaining({ toolCallId: "edit-1" }),
        ],
      }),
      expect.objectContaining({ type: "text", streaming: false }),
    ]);
  });

  it("creates a card-result block for a marked decision user message", () => {
    const message: TimelineInputMessage = {
      id: "msg-decision-1",
      role: "user",
      parts: [{ type: "text", text: "clarification_card_id: dc-1\n用户已回答澄清卡片。\n\n1. 选择\n回答：重新优化 Hello World" }],
      metadata: { decisionCardId: "dc-1", decisionStatus: "resolved" },
    };
    expect(buildTranscriptTimeline({ message, activity: "finished" })).toContainEqual(
      expect.objectContaining({ type: "decision-card-result", cardId: "dc-1", status: "resolved", collapseState: "shallow" }),
    );
  });

  it("appends exactly one thinking block when activity is waiting", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "waiting" });

    expect(blocks).toEqual([expect.objectContaining({ type: "thinking" })]);
  });

  it("keeps a thinking tail for waiting and tool-running activities", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [],
    };

    for (const activity of ["waiting", "tool-running"] as const) {
      const blocks = buildTranscriptTimeline({ message, activity });
      expect(blocks).toEqual([expect.objectContaining({ type: "thinking" })]);
    }
  });

  it("does not append thinking for text, reasoning, or finished activities", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [],
    };

    for (const activity of ["reasoning", "text", "finished"] as const) {
      const blocks = buildTranscriptTimeline({ message, activity });
      expect(blocks).toEqual([]);
    }
  });

  it("keeps reasoning expanded until a non-reasoning block appears", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "step one", state: "done" },
        { type: "reasoning", text: "step two", state: "done" },
      ],
    };

    const before = buildTranscriptTimeline({ message, activity: "reasoning" });
    expect(before).toEqual([
      expect.objectContaining({ type: "reasoning", defaultCollapsed: false, streaming: false }),
      expect.objectContaining({ type: "reasoning", defaultCollapsed: false, streaming: true }),
    ]);

    const withText: TimelineInputMessage = {
      ...message,
      parts: [...message.parts, { type: "text", text: "Result." }],
    };
    const after = buildTranscriptTimeline({ message: withText, activity: "text" });
    expect(after).toEqual([
      expect.objectContaining({ type: "reasoning", defaultCollapsed: true, streaming: false }),
      expect.objectContaining({ type: "reasoning", defaultCollapsed: true, streaming: false }),
      expect.objectContaining({ type: "text", streaming: true }),
    ]);
  });

  it("only the last text block streams while activity is text", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
        { type: "text", text: "Third." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "text" });

    expect(blocks).toEqual([
      expect.objectContaining({ type: "text", text: "First.", streaming: false }),
      expect.objectContaining({ type: "text", text: "Second.", streaming: false }),
      expect.objectContaining({ type: "text", text: "Third.", streaming: true }),
    ]);
  });

  it("sets prior text and reasoning to non-streaming when a tool is running", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Plan", state: "done" },
        { type: "text", text: "Let me read." },
        makeToolPart("read-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "tool-running" });

    expect(blocks).toEqual([
      expect.objectContaining({ type: "reasoning", streaming: false }),
      expect.objectContaining({ type: "text", streaming: false }),
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        defaultCollapsed: true,
        activeState: "running",
      }),
    ]);
  });

  it("keeps a completed tool batch in the active slot while the turn is still waiting", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("read-1", "Read", "output-available", { file_path: "/repo/README.md" }),
        { type: "text", text: "" },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "waiting" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        defaultCollapsed: true,
        activeState: "pinned",
        currentToolCallId: "read-1",
        tools: [expect.objectContaining({ toolCallId: "read-1", state: "completed" })],
      }),
    ]);
  });

  it("switches a completed tool batch back to thinking when reasoning starts", () => {
    const message: TimelineInputMessage = {
      id: "msg-reasoning-1",
      role: "assistant",
      parts: [
        makeToolPart("read-1", "Read", "output-available", { file_path: "/repo/README.md" }),
        { type: "reasoning", text: "thinking", state: "streaming" },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "reasoning" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        activeState: "thinking",
        currentToolCallId: "read-1",
      }),
      expect.objectContaining({ type: "reasoning", text: "thinking", streaming: true }),
    ]);
  });

  it("updates an existing tool in place when a result arrives", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("read-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
        makeToolPart("read-1", "Read", "output-available", { file_path: "/repo/a.txt" }, { content: "hello" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "tool-running" });

    const group = blocks.find((block) => block.type === "tool-group") as { tools: Array<{ state: string; output: unknown }> };
    expect(group.tools).toHaveLength(1);
    expect(group.tools[0]!.state).toBe("completed");
    expect(group.tools[0]!.output).toEqual("hello");
  });

  it("keeps consecutive tools in the same group", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }),
        makeToolPart("tool-2", "Read", "output-available", { file_path: "/repo/b.txt" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: true,
        tools: [
          expect.objectContaining({ toolCallId: "tool-1" }),
          expect.objectContaining({ toolCallId: "tool-2" }),
        ],
      }),
    ]);
  });

  it("keeps the previous tool batch in the active slot while text is streaming", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }),
        { type: "text", text: "After tool." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "text" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        defaultCollapsed: true,
        activeState: "pinned",
        currentToolCallId: "tool-1",
      }),
      expect.objectContaining({ type: "text", streaming: true }),
    ]);
  });

  it("preserves tool position between reasoning blocks", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "先看上下文", state: "done" },
        makeToolPart("tool-1", "mcp__squadflow-leader__get_context", "output-available", { flow_id: "flow-1" }, { content: "{}" }),
        { type: "reasoning", text: "准备回复用户", state: "done" },
        { type: "text", text: "已获取最新状态。" },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "reasoning",
      "tool-group",
      "reasoning",
      "text",
    ]);
  });

  it("does not duplicate tools when input and output events share toolCallId", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
        makeToolPart("tool-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }, { content: "x" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    const group = blocks.find((block) => block.type === "tool-group") as { tools: unknown[] };
    expect(group.tools).toHaveLength(1);
  });

  it("marks unresolved tools as interrupted when the turn finishes", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    const group = blocks.find((block) => block.type === "tool-group") as { tools: Array<{ state: string }> };
    expect(group.tools[0]!.state).toBe("interrupted");
  });

  it("keeps a running tool batch in a single active slot before text or finish", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "input-available", { file_path: "/repo/a.txt" }),
        makeToolPart("tool-2", "Read", "input-available", { file_path: "/repo/b.txt" }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "tool-running" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        defaultCollapsed: true,
        activeState: "running",
      }),
    ]);
  });

  it("delays materializing pre-text tools until the next post-text tool starts", () => {
    const beforeNextTool: TimelineInputMessage = {
      id: "msg-delay-1",
      role: "assistant",
      parts: [
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }),
        makeToolPart("tool-2", "Read", "output-available", { file_path: "/repo/b.txt" }),
        { type: "text", text: "text-1" },
      ],
    };

    expect(buildTranscriptTimeline({ message: beforeNextTool, activity: "text" })).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        activeState: "pinned",
        currentToolCallId: "tool-2",
        tools: [
          expect.objectContaining({ toolCallId: "tool-1" }),
          expect.objectContaining({ toolCallId: "tool-2" }),
        ],
      }),
      expect.objectContaining({ type: "text", text: "text-1", streaming: true }),
    ]);

    const afterNextTool: TimelineInputMessage = {
      ...beforeNextTool,
      parts: [
        ...beforeNextTool.parts,
        makeToolPart("tool-y", "Bash", "input-available", { command: "pwd" }),
      ],
    };

    expect(buildTranscriptTimeline({ message: afterNextTool, activity: "tool-running" })).toEqual([
      expect.objectContaining({
        type: "tool-group",
        finalized: true,
        tools: [
          expect.objectContaining({ toolCallId: "tool-1" }),
          expect.objectContaining({ toolCallId: "tool-2" }),
        ],
      }),
      expect.objectContaining({ type: "text", text: "text-1", streaming: false }),
      expect.objectContaining({
        type: "tool-group",
        finalized: false,
        activeState: "running",
        currentToolCallId: "tool-y",
        tools: [expect.objectContaining({ toolCallId: "tool-y", state: "running" })],
      }),
    ]);
  });

  it("keeps stable block ids across live and finished projections of the same message", () => {
    const message: TimelineInputMessage = {
      id: "msg-stable-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Before." },
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }),
        { type: "text", text: "After." },
      ],
    };

    const live = buildTranscriptTimeline({ message, activity: "tool-running" });
    const finished = buildTranscriptTimeline({ message, activity: "finished" });

    expect(live.find((block) => block.type === "text" && block.text === "Before.")?.id)
      .toBe("msg-stable-1:text:0");
    expect(finished.find((block) => block.type === "text" && block.text === "Before.")?.id)
      .toBe("msg-stable-1:text:0");
    expect(live.find((block) => block.type === "tool-group")?.id)
      .toBe("msg-stable-1:tool-group:tool-1");
    expect(finished.find((block) => block.type === "tool-group")?.id)
      .toBe("msg-stable-1:tool-group:tool-1");
  });

  it("preserves part order including text before tools", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Before." },
        makeToolPart("tool-1", "Read", "output-available", { file_path: "/repo/a.txt" }),
        { type: "text", text: "After." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual(["text", "tool-group", "text"]);
  });

  it("keeps a completed ask_user tool group deep-collapsed", () => {
    const message: TimelineInputMessage = {
      id: "msg-ask-collapsed",
      role: "assistant",
      parts: [makeToolPart(
        "ask-1",
        "mcp__squadflow-leader__ask_user",
        "output-available",
        { questions: [{ question: "选哪个？" }] },
        { decision_card_id: "dc-1" },
      )],
    };

    expect(buildTranscriptTimeline({ message, activity: "finished" })).toContainEqual(
      expect.objectContaining({ type: "tool-group", defaultCollapsed: true }),
    );
  });

  it("places decision-card immediately after its originating ask_user tool", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I need to ask." },
        makeToolPart("ask-1", "mcp__squadflow-leader__ask_user", "output-available", {}, {
          content: JSON.stringify({ result: { card_id: "card-1" } }),
        }),
        { type: "text", text: "Please answer." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "decision-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "decision-card");
    expect(card).toMatchObject({ cardId: "card-1", toolCallId: "ask-1" });
  });

  it("keeps different ask_user ids distinct even when their inputs are equal", () => {
    const input = {
      flow_id: "flow-1",
      questions: [{
        header: "类型",
        question: "你想写什么类型的 Hello World?",
        options: [{ label: "前端页面", description: "HTML" }],
      }],
    };
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("ask-transient", "mcp__leader__ask_user", "input-available", input),
        makeToolPart("ask-canonical", "mcp__squadflow-leader__ask_user", "output-available", input, {
          content: JSON.stringify({ result: { card_id: "card-1" } }),
        }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "tool-running" });
    const toolGroup = blocks.find((block) => block.type === "tool-group");

    expect(toolGroup).toMatchObject({
      type: "tool-group",
      tools: [
        expect.objectContaining({ toolCallId: "ask-transient", state: "running" }),
        expect.objectContaining({
          toolCallId: "ask-canonical",
          toolName: "mcp__squadflow-leader__ask_user",
          state: "completed",
        }),
      ],
    });
    expect(blocks.filter((block) => block.type === "decision-card")).toEqual([
      expect.objectContaining({ cardId: "card-1", toolCallId: "ask-canonical" }),
    ]);
  });

  it("keeps distinct ask_user inputs as separate tool calls", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("ask-1", "mcp__leader__ask_user", "input-available", {
          flow_id: "flow-1",
          questions: [{ question: "选择前端还是后端？" }],
        }),
        makeToolPart("ask-2", "mcp__leader__ask_user", "input-available", {
          flow_id: "flow-1",
          questions: [{ question: "选择数据库？" }],
        }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "tool-running" });
    const toolGroup = blocks.find((block) => block.type === "tool-group");

    expect(toolGroup).toMatchObject({
      type: "tool-group",
      tools: [
        expect.objectContaining({ toolCallId: "ask-1" }),
        expect.objectContaining({ toolCallId: "ask-2" }),
      ],
    });
  });

  it("places spec-card immediately after its originating create_plan tool", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I will create a plan." },
        makeToolPart("plan-1", "mcp__squadflow-leader__create_plan", "output-available", {}, {
          content: JSON.stringify({
            spec_approval: { spec_approval_id: "spec-1" },
            spec_revision: { spec_revision_id: "rev-1", file_name: "plan.md", overview: "overview" },
          }),
        }),
        { type: "text", text: "Review the spec." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "spec-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "spec-card");
    expect(card).toMatchObject({ specApprovalId: "spec-1", toolCallId: "plan-1" });
  });

  it("extracts decision-card and spec-card placeholders when tool parts contain card ids", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("ask-1", "mcp__squadflow-leader__ask_user", "output-available", {}, {
          content: JSON.stringify({ result: { card_id: "card-1" } }),
        }),
        makeToolPart("plan-1", "mcp__squadflow-leader__create_plan", "output-available", {}, {
          content: JSON.stringify({
            spec_approval: { spec_approval_id: "spec-1" },
            spec_revision: { spec_revision_id: "rev-1", file_name: "plan.md", overview: "overview" },
          }),
        }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "tool-group",
        tools: [
          expect.objectContaining({ toolCallId: "ask-1", toolName: "mcp__squadflow-leader__ask_user" }),
          expect.objectContaining({ toolCallId: "plan-1", toolName: "mcp__squadflow-leader__create_plan" }),
        ],
      }),
      expect.objectContaining({ type: "decision-card", cardId: "card-1", toolCallId: "ask-1" }),
      expect.objectContaining({ type: "spec-card", specApprovalId: "spec-1", toolCallId: "plan-1" }),
    ]);
  });

  it("extracts decision-card from ask_user result with decision_card_id", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I need to ask." },
        makeToolPart("ask-1", "mcp__squadflow-leader__ask_user", "output-available", {}, {
          content: JSON.stringify({ decision_card_id: "card-2", status: "pending" }),
        }),
        { type: "text", text: "Please answer." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "decision-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "decision-card");
    expect(card).toMatchObject({ cardId: "card-2", toolCallId: "ask-1" });
  });

  it("extracts spec-card from create_plan result with spec_approval_id", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I will create a plan." },
        makeToolPart("plan-1", "mcp__squadflow-leader__create_plan", "output-available", {}, {
          content: JSON.stringify({ spec_approval_id: "spec-2", title: "Plan B" }),
        }),
        { type: "text", text: "Review the spec." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "spec-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "spec-card");
    expect(card).toMatchObject({ specApprovalId: "spec-2", toolCallId: "plan-1" });
  });

  it("keeps ask_user and create_plan tools in the tool-group summary", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        makeToolPart("ask-1", "mcp__squadflow-leader__ask_user", "output-available", {}, {
          content: JSON.stringify({ result: { card_id: "card-1" } }),
        }),
        makeToolPart("plan-1", "mcp__squadflow-leader__create_plan", "output-available", {}, {
          content: JSON.stringify({ spec_approval_id: "spec-1" }),
        }),
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });
    const group = blocks.find((block) => block.type === "tool-group") as { tools: Array<{ toolCallId: string }> } | undefined;
    expect(group?.tools.map((tool) => tool.toolCallId)).toEqual(["ask-1", "plan-1"]);
  });

  it("extracts decision-card from real ask_user server result shape", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I need to ask." },
        makeToolPart("ask-1", "mcp__squadflow-leader__ask_user", "output-available", {}, {
          content: JSON.stringify({ ok: true, card_id: "dc-1", status: "pending" }),
        }),
        { type: "text", text: "Please answer." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "decision-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "decision-card");
    expect(card).toMatchObject({ cardId: "dc-1", toolCallId: "ask-1" });
  });

  it("extracts spec-card from real create_plan server result shape", () => {
    const message: TimelineInputMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I will create a plan." },
        makeToolPart("plan-1", "mcp__squadflow-leader__create_plan", "output-available", {}, {
          content: JSON.stringify({
            ok: true,
            spec_revision: {
              spec_revision_id: "sr-1",
              file_name: "plan.md",
              overview: "overview",
            },
            spec_approval: { spec_approval_id: "sca-1", status: "pending" },
          }),
        }),
        { type: "text", text: "Review the spec." },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "spec-card",
      "text",
    ]);
    const card = blocks.find((block) => block.type === "spec-card");
    expect(card).toMatchObject({ specApprovalId: "sca-1", toolCallId: "plan-1" });
  });

  it("keeps an orchestration plan card at its MCP tool position when structuredContent is null", () => {
    const planRevisionId = "prev-38461eec7e7b";
    const message: TimelineInputMessage = {
      id: "msg-plan",
      role: "assistant",
      parts: [
        { type: "text", text: "准备提交编排计划。" },
        makeToolPart(
          "submit-plan-1",
          "mcp__squadflow-leader__submit_orchestration_plan",
          "output-available",
          { flow_id: "flow-1", title: "后台升级" },
          {
            content: "",
            is_error: false,
            mcp: {
              structuredContent: null,
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  revision: { plan_revision_id: planRevisionId },
                }),
              }],
              isError: false,
            },
          },
        ),
        { type: "text", text: "计划已提交，等待审批。" },
      ],
    };

    const blocks = buildTranscriptTimeline({ message, activity: "finished" });

    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "tool-group",
      "plan-card",
      "text",
    ]);
    expect(blocks[2]).toMatchObject({
      id: "tool-card:submit-plan-1:orchestration-plan",
      type: "plan-card",
      planRevisionId,
      toolCallId: "submit-plan-1",
    });
  });

  it("keeps the normalized MCP envelope for generic result rendering", () => {
    const output = {
      content: "Detailed Results",
      is_error: false,
      mcp: {
        content: [{ type: "text", text: "Detailed Results" }],
        structuredContent: { sourceCount: 1 },
        isError: false,
      },
    };
    const message: TimelineInputMessage = {
      id: "msg-mcp-result",
      role: "assistant",
      parts: [{
        type: "tool-mcp__tavily__tavily_search",
        toolCallId: "mcp-1",
        toolName: "mcp__tavily__tavily_search",
        mcp: { server: "tavily", tool: "tavily_search" },
        state: "output-available",
        input: { query: "MCP" },
        output,
      }],
    };

    const toolGroup = buildTranscriptTimeline({ message, activity: "finished" })
      .find((block) => block.type === "tool-group");
    expect(toolGroup?.type).toBe("tool-group");
    if (toolGroup?.type === "tool-group") {
      expect(toolGroup.tools[0]?.output).toEqual(output);
    }
  });
});

describe("deriveActivity", () => {
  it("maps start to waiting", () => {
    expect(deriveActivity("start", false)).toBe("waiting");
  });

  it("maps reasoning-start and reasoning-delta to reasoning", () => {
    expect(deriveActivity("reasoning-start", false)).toBe("reasoning");
    expect(deriveActivity("reasoning-delta", false)).toBe("reasoning");
  });

  it("maps text-start and text-delta to text", () => {
    expect(deriveActivity("text-start", false)).toBe("waiting");
    expect(deriveActivity("text-delta", false)).toBe("text");
  });

  it("maps tool-input-start and tool-input-available to tool-running", () => {
    expect(deriveActivity("tool-input-start", false)).toBe("tool-running");
    expect(deriveActivity("tool-input-available", false)).toBe("tool-running");
  });

  it("maps tool-output-available to waiting when no tool is running", () => {
    expect(deriveActivity("tool-output-available", false)).toBe("waiting");
  });

  it("maps tool-output-available to tool-running when another tool is still running", () => {
    expect(deriveActivity("tool-output-available", true)).toBe("tool-running");
  });

  it("maps finish to finished", () => {
    expect(deriveActivity("finish", false)).toBe("finished");
  });

  it("returns null for events that do not advance the activity", () => {
    expect(deriveActivity("text-end", false)).toBeNull();
    expect(deriveActivity("reasoning-end", false)).toBeNull();
    expect(deriveActivity("tool-input-delta", false)).toBeNull();
  });
});

describe("deriveActivityFromMessage", () => {
  function assistant(parts: unknown[]): UIMessage {
    return { id: "m1", role: "assistant", parts: parts as UIMessage["parts"], content: "" } as UIMessage;
  }

  it("returns waiting for an empty assistant message", () => {
    expect(deriveActivityFromMessage(assistant([]))).toBe("waiting");
  });

  it("returns tool-running when a tool is still streaming input", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "tool-mcp__leader__get_context", toolCallId: "t1", toolName: "x", state: "input-streaming", inputText: "" },
        ]),
      ),
    ).toBe("tool-running");
  });

  it("returns tool-running when a tool has input but no output yet", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "tool-mcp__leader__get_context", toolCallId: "t1", toolName: "x", state: "input-available", input: {} },
        ]),
      ),
    ).toBe("tool-running");
  });

  it("returns reasoning when the last content part is reasoning", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "tool-mcp__leader__get_context", toolCallId: "t1", toolName: "x", state: "output-available", output: {} },
          { type: "reasoning", text: "继续思考", state: "streaming" },
        ]),
      ),
    ).toBe("reasoning");
  });

  it("returns text when the last content part is text", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "reasoning", text: "先想一下", state: "done" },
          { type: "text", text: "hello" },
        ]),
      ),
    ).toBe("text");
  });

  it("returns waiting when all tools are completed with nothing after", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "text", text: "before" },
          { type: "tool-mcp__leader__get_context", toolCallId: "t1", toolName: "x", state: "output-available", output: {} },
        ]),
      ),
    ).toBe("waiting");
  });

  it("skips trailing empty text/reasoning parts", () => {
    expect(
      deriveActivityFromMessage(
        assistant([
          { type: "tool-mcp__leader__get_context", toolCallId: "t1", toolName: "x", state: "output-available", output: {} },
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ]),
      ),
    ).toBe("waiting");
  });
});

describe("computeFinishedTiming", () => {
  it("uses event durationMs instead of local time when provided", () => {
    const timing = computeFinishedTiming({
      startedAt: "2026-06-19T10:00:00.000Z",
      eventDurationMs: 3000,
      eventFinishedAt: "2026-06-19T10:00:10.000Z",
    });
    expect(timing.durationMs).toBe(3000);
    expect(timing.finishedAt).toBe("2026-06-19T10:00:10.000Z");
    expect(timing.startedAt).toBe("2026-06-19T10:00:00.000Z");
  });

  it("falls back to local elapsed time when durationMs is null", () => {
    const timing = computeFinishedTiming({
      startedAt: "2026-06-19T10:00:00.000Z",
      eventDurationMs: null,
      eventFinishedAt: "2026-06-19T10:00:05.000Z",
    });
    expect(timing.durationMs).toBe(5000);
    expect(timing.finishedAt).toBe("2026-06-19T10:00:05.000Z");
  });

  it("uses local now for finishedAt when eventFinishedAt is missing", () => {
    const now = new Date("2026-06-19T10:00:04.000Z");
    const timing = computeFinishedTiming({
      startedAt: "2026-06-19T10:00:00.000Z",
      eventDurationMs: null,
      eventFinishedAt: null,
      now: () => now,
    });
    expect(timing.finishedAt).toBe(now.toISOString());
    expect(timing.durationMs).toBe(4000);
  });

  it("returns null durationMs when startedAt is missing and durationMs is null", () => {
    const timing = computeFinishedTiming({
      startedAt: null,
      eventDurationMs: null,
      eventFinishedAt: "2026-06-19T10:00:04.000Z",
    });
    expect(timing.durationMs).toBeNull();
  });
});

describe("readHistoryTurnTiming", () => {
  it("prioritizes metadata.turnTiming.durationMs from a history message", () => {
    const message = {
      metadata: {
        turnTiming: {
          startedAt: "2026-06-19T10:00:00.000Z",
          finishedAt: "2026-06-19T10:00:03.000Z",
          durationMs: 3000,
        },
      },
    } as never;
    expect(readHistoryTurnTiming(message)?.durationMs).toBe(3000);
    expect(readHistoryTurnTiming(message)?.startedAt).toBe("2026-06-19T10:00:00.000Z");
  });

  it("returns null when metadata is missing", () => {
    expect(readHistoryTurnTiming({} as never)).toBeNull();
  });

  it("normalizes a non-numeric durationMs to null", () => {
    const message = {
      metadata: { turnTiming: { startedAt: "s", finishedAt: "f", durationMs: "oops" as unknown as number } },
    } as never;
    expect(readHistoryTurnTiming(message)?.durationMs).toBeNull();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolGroup from "./ToolGroup";
import type { TranscriptBlock } from "./types";
import { resetCollapseStoreForTests } from "./useCollapse";
import { TranscriptPathProvider } from "./TranscriptPathContext";

afterEach(() => {
  vi.restoreAllMocks();
  resetCollapseStoreForTests();
});

describe("ToolGroup", () => {
  it("shows plan generation while an orchestration tool is streaming", () => {
    const group: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-plan",
      type: "tool-group",
      finalized: false,
      defaultCollapsed: true,
      activeState: "running",
      currentToolCallId: "call-plan",
      tools: [{
        toolCallId: "call-plan",
        toolName: "mcp__squadflow-leader__submit_orchestration_plan",
        state: "running",
        input: null,
        output: null,
      }],
    };

    render(<ToolGroup group={group} />);

    expect(screen.getByText("正在生成编排计划…")).toBeVisible();
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
  });

  it("renders a single active Read without an inline detail", () => {
    const group: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-active-read",
      type: "tool-group",
      finalized: false,
      defaultCollapsed: true,
      activeState: "running",
      currentToolCallId: "read-1",
      tools: [{
        toolCallId: "read-1",
        toolName: "Read",
        state: "running",
        input: { file_path: "/repo/a.ts" },
        output: null,
      }],
    };

    render(<ToolGroup group={group} />);
    expect(screen.getAllByText("a.ts")).toHaveLength(1);
    expect(screen.getByText("读取中")).toBeVisible();
    expect(screen.queryByRole("region", { name: /内容预览/u })).not.toBeInTheDocument();
  });

  it("expands a shallow-collapsed MCP group even when the runtime reused a toolCallId", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const group: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-1",
      type: "tool-group",
      finalized: true,
      defaultCollapsed: true,
      tools: [
        { toolCallId: "call-shared", toolName: "mcp__leader__get_context", state: "completed", input: {}, output: {} },
        { toolCallId: "call-shared", toolName: "mcp__leader__list_tasks", state: "completed", input: {}, output: {} },
        { toolCallId: "call-shared", toolName: "mcp__leader__send_message", state: "completed", input: {}, output: {} },
      ],
    };

    render(<ToolGroup group={group} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });

  it("preserves the user's expanded state when the same block id rerenders", () => {
    const initialGroup: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-1",
      type: "tool-group",
      finalized: true,
      defaultCollapsed: true,
      tools: [
        { toolCallId: "call-1", toolName: "Bash", state: "completed", input: { command: "pwd" }, output: null },
      ],
    };

    const { rerender } = render(<ToolGroup group={initialGroup} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByText("pwd").length).toBeGreaterThan(0);

    rerender(<ToolGroup group={{
      ...initialGroup,
      finalized: true,
      defaultCollapsed: true,
      tools: [
        { toolCallId: "call-1", toolName: "Bash", state: "completed", input: { command: "pwd" }, output: "ok" },
      ],
    }} />);

    expect(screen.getAllByText("pwd").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { expanded: true })).toBeVisible();
  });

  it("renders finalized Read-only groups as individual collapsed rows without an outer fold", () => {
    const group: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-reads",
      type: "tool-group",
      finalized: true,
      defaultCollapsed: true,
      tools: [
        { toolCallId: "read-1", toolName: "Read", state: "completed", input: { file_path: "/repo/a.ts" }, output: { content: "a" } },
        { toolCallId: "read-2", toolName: "Read", state: "completed", input: { file_path: "/repo/b.ts" }, output: { content: "b" } },
      ],
    };

    render(
      <TranscriptPathProvider rootPath="/repo" onOpenWorkspaceFile={vi.fn()}>
        <ToolGroup group={group} />
      </TranscriptPathProvider>,
    );

    expect(screen.queryByRole("button", { name: "读取了 2 个文件" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /在右侧打开文件/u })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /a\.ts/u })).toBeVisible();
    expect(screen.getByRole("button", { name: /b\.ts/u })).toBeVisible();
  });

  it("keeps the outer fold for finalized mixed tool groups", () => {
    const group: Extract<TranscriptBlock, { type: "tool-group" }> = {
      id: "group-mixed",
      type: "tool-group",
      finalized: true,
      defaultCollapsed: true,
      tools: [
        { toolCallId: "read-1", toolName: "Read", state: "completed", input: { file_path: "/repo/a.ts" }, output: { content: "a" } },
        { toolCallId: "bash-1", toolName: "Bash", state: "completed", input: { command: "pwd" }, output: "ok" },
      ],
    };

    render(<ToolGroup group={group} />);

    expect(screen.getByRole("button", { name: /读取了 1 个文件和执行了 1 条命令/u })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /a\.ts/u })).not.toBeInTheDocument();
  });
});

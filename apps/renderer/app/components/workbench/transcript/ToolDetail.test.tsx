import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ToolDetail from "./ToolDetail";
import type { ToolPresentation } from "./types";

describe("ToolDetail", () => {
  it("renders Write/Edit fragments with one local line-number column", () => {
    const presentation: ToolPresentation = {
      kind: "edit",
      icon: "edit",
      status: "completed",
      statusLabel: "已完成",
      title: "编辑 notes.md",
      operationLabel: "编辑",
      diff: { additions: 1, deletions: 1 },
      detailRows: [],
      rawInput: {
        old_string: "旧内容",
        new_string: "新内容",
      },
      rawOutput: null,
    };

    const { container } = render(<ToolDetail presentation={presentation} />);

    expect(container.querySelector('[data-line-numbers="single"]')).toBeInTheDocument();
    for (const row of container.querySelectorAll("[data-diff-kind]")) {
      expect(row.querySelectorAll("[data-diff-line-number]")).toHaveLength(1);
    }
  });

  it("renders generic MCP text and structured result content", () => {
    const presentation: ToolPresentation = {
      kind: "mcp",
      icon: "unknown",
      status: "completed",
      statusLabel: "已完成",
      title: "Tavily Search",
      operationLabel: "MCP · tavily-mcp",
      detailRows: [{ label: "工具名", value: "mcp__tavily-mcp__tavily_search" }],
      rawInput: { query: "MCP" },
      rawOutput: {
        content: "Detailed Results",
        is_error: false,
        mcp: {
          content: [{ type: "text", text: "Detailed Results" }],
          structuredContent: { results: [{ title: "MCP" }] },
        },
      },
      mcp: {
        server: "tavily-mcp",
        tool: "tavily_search",
        title: "Tavily Search",
        icons: [],
        serverIcons: [],
      },
    };

    render(<ToolDetail presentation={presentation} />);

    expect(screen.getByTestId("mcp-result")).toBeInTheDocument();
    expect(screen.getByText("Detailed Results")).toBeInTheDocument();
    expect(screen.getByText("结构化结果")).toBeInTheDocument();
    expect(screen.getByText(/"title": "MCP"/u)).toBeInTheDocument();
  });

  it("renders Shell command output in a keyboard-scrollable result region", () => {
    const presentation: ToolPresentation = {
      kind: "bash",
      icon: "terminal",
      status: "completed",
      statusLabel: "已执行",
      title: "npm test",
      operationLabel: "执行",
      command: "npm test",
      detailRows: [],
      rawInput: { command: "npm test" },
      rawOutput: { content: "line 1\nline 2", is_error: false },
    };

    render(<ToolDetail presentation={presentation} />);

    const result = screen.getByRole("region", { name: "命令输出" });
    expect(result).toHaveAttribute("tabindex", "0");
    expect(result).toHaveTextContent("$ npm test");
    expect(result).toHaveTextContent("line 1 line 2");
  });
});

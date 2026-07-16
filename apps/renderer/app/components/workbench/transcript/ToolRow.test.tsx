import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolRow from "./ToolRow";
import type { TimelineTool } from "./types";
import { resetCollapseStoreForTests } from "./useCollapse";
import { TranscriptPathProvider } from "./TranscriptPathContext";

afterEach(() => {
  vi.restoreAllMocks();
  resetCollapseStoreForTests();
});

describe("ToolRow", () => {
  it("updates a compact Read row when the same tool finishes", () => {
    const initialTool: TimelineTool = {
      toolCallId: "call-1",
      toolName: "Read",
      state: "running",
      input: { file_path: "LoginForm.tsx" },
      output: null,
    };

    const { rerender } = render(<ToolRow id="call-1:0" tool={initialTool} />);
    expect(screen.getByText("读取中")).toBeVisible();
    expect(screen.getByText("LoginForm.tsx")).toBeVisible();

    rerender(<ToolRow id="call-1:0" tool={{
      ...initialTool,
      state: "completed",
      output: { content: "export default function LoginForm() {}" },
    }} />);

    expect(screen.getByText("已读取")).toBeVisible();
    expect(screen.getByText("1 行")).toBeVisible();
    expect(screen.queryByRole("region", { name: /内容预览/u })).not.toBeInTheDocument();
  });

  it("renders the approved Read row and opens the workspace-relative file", () => {
    const onOpenWorkspaceFile = vi.fn();
    const path = "apps/local-service/src/domain/runtimeCapabilities.ts";
    const tool: TimelineTool = {
      toolCallId: "call-read-approved",
      toolName: "Read",
      state: "completed",
      input: { file_path: path, offset: 1, limit: 64 },
      output: { content: "line one\nline two" },
    };

    render(
      <TranscriptPathProvider rootPath="/repo" onOpenWorkspaceFile={onOpenWorkspaceFile}>
        <ToolRow id="call-read-approved:0" tool={{ ...tool, input: { ...tool.input, file_path: `/repo/${path}` } }} />
      </TranscriptPathProvider>,
    );

    const summary = screen.getByRole("button", { name: /在右侧打开文件/u });
    expect(within(summary).queryByText("读取", { exact: true })).not.toBeInTheDocument();
    expect(within(summary).getByText("runtimeCapabilities.ts")).toBeVisible();
    expect(within(summary).getByText("apps/local-service/src/domain/")).toBeVisible();
    expect(within(summary).getByText("2 行")).toBeVisible();
    expect(within(summary).getByTestId("read-file-icon")).toBeVisible();

    fireEvent.click(summary);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(path);
    expect(screen.queryByRole("region", { name: /内容预览/u })).not.toBeInTheDocument();
  });

  it("uses the colored language logo for a recognized source file", () => {
    const tool: TimelineTool = {
      toolCallId: "call-read-python",
      toolName: "Read",
      state: "completed",
      input: { file_path: "/repo/backend/main.py" },
      output: { content: "print('hello')" },
    };

    render(
      <TranscriptPathProvider rootPath="/repo" onOpenWorkspaceFile={vi.fn()}>
        <ToolRow id="call-read-python:0" tool={tool} />
      </TranscriptPathProvider>,
    );

    const icon = screen.getByTestId("read-file-icon");
    expect(icon.querySelectorAll("linearGradient").length).toBeGreaterThanOrEqual(2);
    expect(icon.querySelectorAll("stop").length).toBeGreaterThanOrEqual(4);
  });

  it("does not offer to open a file outside the workspace", () => {
    const path = "/repo/src/domain/runtimeCapabilities.ts";
    const tool: TimelineTool = {
      toolCallId: "call-read-relative",
      toolName: "Read",
      state: "completed",
      input: { file_path: path },
      output: { content: "export const value = true;" },
    };

    render(
      <TranscriptPathProvider rootPath="/another-repo" onOpenWorkspaceFile={vi.fn()}>
        <ToolRow id="call-read-relative:0" tool={tool} />
      </TranscriptPathProvider>,
    );

    expect(screen.queryByRole("button", { name: /在右侧打开文件/u })).not.toBeInTheDocument();
    expect(screen.getByText("/repo/src/domain/")).toBeVisible();
  });

  it("shows the full line count without rendering code in chat", () => {
    const content = Array.from({ length: 978 }, (_, index) => `line ${index + 1}`).join("\n");
    const tool: TimelineTool = {
      toolCallId: "call-read-complete-preview",
      toolName: "Read",
      state: "completed",
      input: { file_path: "/repo/meeting-room-finder/index.html" },
      output: { content },
    };

    render(
      <TranscriptPathProvider rootPath="/repo" onOpenWorkspaceFile={vi.fn()}>
        <ToolRow id="call-read-complete-preview:0" tool={tool} />
      </TranscriptPathProvider>,
    );

    expect(screen.getByText("978 行")).toBeVisible();
    expect(screen.queryByTestId("readonly-code-view")).not.toBeInTheDocument();
  });

  it("keeps a failed Read aligned and copies its reason from the failure popover", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const tool: TimelineTool = {
      toolCallId: "call-read-failed",
      toolName: "Read",
      state: "completed",
      input: { file_path: "/repo/missing.ts" },
      output: { is_error: true, content: "File not found" },
    };

    render(
      <TranscriptPathProvider rootPath="/repo" onOpenWorkspaceFile={vi.fn()}>
        <ToolRow id="call-read-failed:0" tool={tool} />
      </TranscriptPathProvider>,
    );

    expect(screen.getByText("已读取")).toBeVisible();
    expect(screen.getByText("missing.ts")).toBeVisible();
    expect(screen.getByText("执行失败")).toBeVisible();
    expect(screen.getByTestId("read-file-icon").querySelector("svg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制失败原因" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("File not found"));
    expect(screen.queryByRole("region", { name: /内容预览/u })).not.toBeInTheDocument();
  });

  it("starts collapsed by default", () => {
    const tool: TimelineTool = {
      toolCallId: "call-2",
      toolName: "Edit",
      state: "completed",
      input: { file_path: "LoginForm.tsx", old_string: "a", new_string: "b" },
      output: { ok: true },
    };

    render(<ToolRow id="call-2:0" tool={tool} />);

    expect(screen.getByRole("button", { expanded: false })).toBeVisible();
  });
});

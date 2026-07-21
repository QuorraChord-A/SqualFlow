import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SquadFlow } from "../types";
import FlowItem from "./FlowItem";

const flow: SquadFlow = {
  id: "flow-1",
  name: "等待确认的 Flow",
  description: "修复登录页",
  type: "full",
  status: "active",
  current_stage: "clarify",
  project_id: "project-1",
  created_at: "2026-06-12T00:00:00.000Z",
  updated_at: "2026-06-12T01:00:00.000Z",
  is_pinned: true,
  has_pending_decision: true,
};

describe("FlowItem", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.squadflowDesktopShell;
  });

  it("reveals a server-updated Flow name from left to right", () => {
    vi.useFakeTimers();
    const { rerender } = render(<FlowItem flow={flow} selected={false} onClick={vi.fn()} />);

    rerender(<FlowItem flow={{ ...flow, name: "登录页已完成" }} selected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId("flow-name")).toHaveTextContent("登");

    act(() => vi.advanceTimersByTime(72));
    expect(screen.getByTestId("flow-name")).toHaveTextContent("登录");

    act(() => vi.advanceTimersByTime(72 * 4));
    expect(screen.getByTestId("flow-name")).toHaveTextContent("登录页已完成");
  });

  it("replaces the blue status dot with a pending spinner when user action is required", () => {
    render(<FlowItem flow={flow} selected={false} onClick={vi.fn()} />);

    expect(screen.getByTestId("flow-pending-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-status-dot")).not.toBeInTheDocument();
    expect(screen.getByText("等待操作")).toBeInTheDocument();
  });

  it("shows a gray static status dot for idle flows", () => {
    render(
      <FlowItem
        flow={{ ...flow, status: "idle", has_pending_decision: false }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId("flow-status-dot")).toBeInTheDocument();
    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-muted-foreground/45");
    expect(screen.queryByTestId("flow-pending-spinner")).not.toBeInTheDocument();
  });

  it("does not show a green spinner just because the flow status is active", () => {
    render(
      <FlowItem
        flow={{ ...flow, has_pending_decision: false }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("flow-active-spinner")).not.toBeInTheDocument();
    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-muted-foreground/45");
  });

  it("shows a green spinner while a leader or expert session is streaming output", () => {
    render(
      <FlowItem
        flow={{ ...flow, has_pending_decision: false, is_streaming: true }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId("flow-streaming-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-pending-spinner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("flow-status-dot")).not.toBeInTheDocument();
  });

  it("shows a blue static status dot for unread idle flows", () => {
    render(
      <FlowItem
        flow={{
          ...flow,
          status: "idle",
          has_pending_decision: false,
          has_unread_messages: true,
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-blue-500");
  });

  it("shows a blue static status dot for unread active flows after output completes", () => {
    render(
      <FlowItem
        flow={{
          ...flow,
          status: "active",
          has_pending_decision: false,
          has_unread_messages: true,
        }}
        selected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-blue-500");
  });

  it("hides the status indicator when the hover pin action appears", () => {
    render(
      <FlowItem
        flow={{ ...flow, status: "idle", has_pending_decision: false }}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(screen.getByTestId("flow-status-indicator")).toHaveClass("group-hover:opacity-0");
  });

  it("offers the pin action at the status position", () => {
    const onTogglePinned = vi.fn();
    render(
      <FlowItem
        flow={flow}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={onTogglePinned}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));

    expect(onTogglePinned).toHaveBeenCalledWith(flow);
  });

  it("shows flow details beside the item on hover", async () => {
    render(<FlowItem flow={flow} projectName="ccdev" selected={false} onClick={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "打开流程：等待确认的 Flow" }));

    await waitFor(() => {
      expect(screen.getByText("clarify")).toBeInTheDocument();
      expect(screen.getByText("ccdev")).toBeInTheDocument();
    });
  });

  it("keeps the hover action compact and offers Finder plus Flow ID actions", async () => {
    const user = userEvent.setup();
    const showItemInFolder = vi.fn().mockResolvedValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    window.squadflowDesktopShell = { showItemInFolder };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(
      <FlowItem
        flow={flow}
        projectPath="/tmp/project"
        selected
        onClick={vi.fn()}
        onEditFlow={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "等待确认的 Flow 操作" });
    expect(trigger).toHaveClass("group-hover:w-7", "group-hover:min-w-7");

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "复制 Flow ID" }));
    expect(writeText).toHaveBeenCalledWith("flow-1");

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "在 Finder 中打开" }));
    expect(showItemInFolder).toHaveBeenCalledWith("/tmp/project", true);
  });
});

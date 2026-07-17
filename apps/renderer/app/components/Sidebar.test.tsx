import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

vi.mock("./AppSettingsMenu", () => ({
  default: () => <button type="button" aria-label="设置" />,
}));

vi.mock("./AppUpdateButton", () => ({
  default: () => <button type="button" aria-label="更新应用">更新</button>,
}));

vi.mock("./PanelResizeHandle", () => ({
  default: () => <div data-testid="resize-handle" />,
}));

vi.mock("./ProjectTaskList", () => ({
  default: () => <div data-testid="project-task-list" />,
}));

const baseProps = {
  width: 260,
  isOpen: true,
  onToggle: vi.fn(),
  onResizeStart: vi.fn(),
  onNewTask: vi.fn(),
  onRefresh: vi.fn(),
  onSelectTask: vi.fn(),
};

describe("Sidebar", () => {
  it("keeps the drawer toggle fixed outside the sidebar header", () => {
    const onToggle = vi.fn();
    render(<Sidebar {...baseProps} onToggle={onToggle} />);

    const collapseButton = screen.getByRole("button", { name: "隐藏左侧面板" });
    const settingsButton = screen.getByRole("button", { name: "设置" });

    expect(collapseButton).toHaveAttribute("data-testid", "left-panel-drawer-toggle");
    expect(collapseButton.closest("aside")).toBeNull();
    expect(settingsButton.closest("aside")).toBe(screen.getByTestId("left-sidebar"));
    fireEvent.click(collapseButton);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps flow navigation controls in the top row", () => {
    const onNavigatePreviousFlow = vi.fn();
    const onNavigateNextFlow = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        onNavigatePreviousFlow={onNavigatePreviousFlow}
        onNavigateNextFlow={onNavigateNextFlow}
        canNavigatePreviousFlow
        canNavigateNextFlow
      />
    );

    const collapseButton = screen.getByRole("button", { name: "隐藏左侧面板" });
    const previousButton = screen.getByRole("button", { name: "切换到前一个流程" });
    const nextButton = screen.getByRole("button", { name: "切换到后一个流程" });
    const topRow = collapseButton.parentElement;

    expect(topRow).toHaveClass("top-2");
    expect(previousButton.parentElement).toBe(topRow);
    expect(nextButton.parentElement).toBe(topRow);
    fireEvent.click(previousButton);
    fireEvent.click(nextButton);
    expect(onNavigatePreviousFlow).toHaveBeenCalledOnce();
    expect(onNavigateNextFlow).toHaveBeenCalledOnce();
  });

  it("does not render a top drag overlay over workspace buttons", () => {
    const { container } = render(<Sidebar {...baseProps} />);

    expect(container.querySelector(".sf-window-drag-region")).toBeNull();
  });

  it("renders disabled flow navigation as inactive icons without shortcut labels", () => {
    const onNavigatePreviousFlow = vi.fn();
    const onNavigateNextFlow = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        onNavigatePreviousFlow={onNavigatePreviousFlow}
        onNavigateNextFlow={onNavigateNextFlow}
      />
    );

    const previousButton = screen.getByRole("button", { name: "切换到前一个流程" });
    const nextButton = screen.getByRole("button", { name: "切换到后一个流程" });

    expect(previousButton).toHaveAttribute("aria-disabled", "true");
    expect(nextButton).toHaveAttribute("aria-disabled", "true");
    expect(previousButton.className).toContain("disabled:cursor-default");
    expect(nextButton.className).toContain("disabled:cursor-default");
    fireEvent.click(previousButton);
    fireEvent.click(nextButton);
    expect(onNavigatePreviousFlow).not.toHaveBeenCalled();
    expect(onNavigateNextFlow).not.toHaveBeenCalled();
    expect(screen.queryByText("⌘")).not.toBeInTheDocument();
  });

  it("keeps the brand and settings controls in a bottom overlay", () => {
    render(<Sidebar {...baseProps} />);

    const brand = screen.getByText("SquadFlow");
    const updateButton = screen.getByRole("button", { name: "更新应用" });
    const settingsButton = screen.getByRole("button", { name: "设置" });
    const bottomOverlay = brand.closest(".absolute");
    const bottomActions = screen.getByTestId("sidebar-bottom-actions");

    expect(bottomOverlay).toHaveClass("bottom-0");
    expect(settingsButton.closest(".absolute")).toBe(bottomOverlay);
    expect(screen.getByTestId("sidebar-brand").querySelector("svg")).toBeNull();
    expect(bottomActions.children[0]).toBe(updateButton);
    expect(bottomActions.children[1]).toBe(settingsButton);
    expect(screen.getByTestId("project-task-list").closest(".overflow-hidden")).toBeInTheDocument();
  });

  it("keeps the collapsed sidebar mounted outside layout flow", () => {
    const { rerender } = render(<Sidebar {...baseProps} />);
    const sidebar = screen.getByTestId("left-sidebar");

    expect(sidebar).toHaveAttribute("data-state", "open");
    expect(sidebar).toHaveStyle({ width: "260px" });
    expect(sidebar.className).toContain("transition-[width,border-color]");

    rerender(<Sidebar {...baseProps} isOpen={false} />);

    expect(sidebar).toHaveAttribute("data-state", "closed");
    expect(sidebar).toHaveAttribute("data-preview-open", "false");
    expect(sidebar).toHaveStyle({ width: "260px" });
    expect(sidebar.className).toContain("absolute");
    expect(sidebar.className).toContain("-translate-x-full");
    expect(screen.queryByRole("button", { name: "隐藏左侧面板" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示左侧面板" })).toHaveAttribute("data-testid", "left-panel-drawer-toggle");
  });

  it("renders the collapsed sidebar as an overlay preview without reopening the layout", () => {
    render(
      <Sidebar
        {...baseProps}
        isOpen={false}
        isPreviewOpen
        previewWidth={208}
      />
    );

    const sidebar = screen.getByTestId("left-sidebar");

    expect(sidebar).toHaveAttribute("data-state", "closed");
    expect(sidebar).toHaveAttribute("data-preview-open", "true");
    expect(sidebar).toHaveStyle({ width: "208px" });
    expect(sidebar.className).toContain("absolute");
    expect(screen.getByTestId("project-task-list")).toBeInTheDocument();
    expect(screen.queryByTestId("resize-handle")).not.toBeInTheDocument();
  });

  it("uses an overlay drawer plus layout spacer while entering", () => {
    render(<Sidebar {...baseProps} drawerAnimation="enter" />);

    const sidebar = screen.getByTestId("left-sidebar");
    const spacer = screen.getByTestId("left-sidebar-layout-spacer");

    expect(spacer).toHaveStyle({ width: "260px", "--left-sidebar-width": "260px" });
    expect(spacer.className).not.toContain("animate-left-sidebar-space-enter");
    expect(sidebar).toHaveAttribute("data-drawer-animation", "enter");
    expect(sidebar.className).toContain("absolute");
    expect(sidebar.className).toContain("animate-left-sidebar-enter");
  });

  it("keeps the exiting drawer out of layout flow while animating closed", () => {
    render(
      <Sidebar
        {...baseProps}
        isOpen={false}
        drawerAnimation="exit"
        previewWidth={260}
      />
    );

    const sidebar = screen.getByTestId("left-sidebar");

    expect(screen.queryByTestId("left-sidebar-layout-spacer")).not.toBeInTheDocument();
    expect(sidebar).toHaveAttribute("data-drawer-animation", "exit");
    expect(sidebar.className).toContain("absolute");
    expect(sidebar.className).toContain("animate-left-sidebar-exit");
    expect(sidebar).toHaveStyle({ width: "260px" });
  });
});

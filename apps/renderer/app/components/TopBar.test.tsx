import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "./TopBar";

describe("TopBar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render the left-panel drawer control", () => {
    const { rerender } = render(
      <TopBar
        activeTitle="任务"
        isLeftPanelOpen={false}
      />,
    );

    expect(screen.getByText("任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示左侧面板" })).not.toBeInTheDocument();

    rerender(
      <TopBar
        activeTitle="任务"
        isLeftPanelOpen
      />,
    );

    expect(screen.queryByRole("button", { name: "隐藏左侧面板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示左侧面板" })).not.toBeInTheDocument();
  });

  it("toggles the desktop window zoom on double click", () => {
    const toggleWindowZoom = vi.fn().mockResolvedValue({ maximized: true });
    vi.stubGlobal("squadflowDesktopShell", { toggleWindowZoom });

    const { container } = render(<TopBar activeTitle="任务" />);
    fireEvent.doubleClick(container.querySelector(".sf-window-drag-region")!);

    expect(toggleWindowZoom).toHaveBeenCalledOnce();
  });

  it("keeps the collapsed header itself out of the desktop drag region", () => {
    const { container } = render(<TopBar activeTitle="任务" isLeftPanelOpen={false} />);
    const header = container.querySelector("header")!;

    expect(header).not.toHaveClass("sf-window-drag-region");
    expect(header.querySelector(".sf-window-drag-region")).toBeInTheDocument();
  });
});

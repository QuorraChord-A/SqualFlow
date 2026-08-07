import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopBrowserPanel from "./DesktopBrowserPanel";
import type { DesktopBrowserBridge, DesktopBrowserState } from "../../lib/desktopBrowser";

function baseState(overrides: Partial<DesktopBrowserState> = {}): DesktopBrowserState {
  return {
    url: "http://localhost:3000/",
    title: "SquadFlow",
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    pickerActive: false,
    agentLease: null,
    ...overrides,
  };
}

function stubBridge(state: DesktopBrowserState, overrides: Partial<DesktopBrowserBridge> = {}): DesktopBrowserBridge {
  return {
    isAvailable: true,
    setVisible: vi.fn().mockResolvedValue(state),
    setBounds: vi.fn().mockResolvedValue(state),
    navigate: vi.fn().mockResolvedValue(state),
    goBack: vi.fn().mockResolvedValue(state),
    goForward: vi.fn().mockResolvedValue(state),
    reload: vi.fn().mockResolvedValue(state),
    startElementPicker: vi.fn().mockResolvedValue(state),
    stopElementPicker: vi.fn().mockResolvedValue(state),
    clearElementPickerHover: vi.fn().mockResolvedValue(state),
    getState: vi.fn().mockResolvedValue(state),
    onState: vi.fn().mockReturnValue(() => {}),
    onElementSelected: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe("DesktopBrowserPanel agent lease banner", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows no banner when the browser is not leased to an agent", async () => {
    const state = baseState();
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(state));

    await act(async () => {
      render(<DesktopBrowserPanel />);
    });

    expect(screen.queryByTestId("desktop-browser-lease-banner")).not.toBeInTheDocument();
  });

  it("shows the holder name and lets the user reclaim control", async () => {
    const leasedState = baseState({
      agentLease: { flowId: "flow-a", agentRunId: "session-a", holderName: "Verify", since: "2026-07-03T00:00:00.000Z" },
    });
    const reclaimedState = baseState({ agentLease: null });
    const reclaimLease = vi.fn().mockResolvedValue(reclaimedState);
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(leasedState, { reclaimLease }));

    await act(async () => {
      render(<DesktopBrowserPanel flowId="flow-a" />);
    });

    expect(screen.getByTestId("desktop-browser-lease-banner")).toHaveTextContent("Verify 正在操作浏览器");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "夺回控制" }));
    });

    expect(reclaimLease).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("desktop-browser-lease-banner")).not.toBeInTheDocument();
  });

  it("hides another flow's browser lease banner", async () => {
    const state = baseState({
      agentLease: { flowId: "flow-a", agentRunId: "session-a", holderName: "Coder", since: "2026-07-03T00:00:00.000Z" },
    });
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(state));

    await act(async () => {
      render(<DesktopBrowserPanel flowId="flow-b" />);
    });

    expect(screen.queryByTestId("desktop-browser-lease-banner")).not.toBeInTheDocument();
  });

  it("does not resync the native browser layout for chat scroll events", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(baseState()));

    await act(async () => {
      render(<DesktopBrowserPanel flowId="flow-a" />);
    });

    expect(addEventListener).not.toHaveBeenCalledWith("scroll", expect.any(Function), true);
  });

  it("shows the browser start prompt instead of an empty black surface", async () => {
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(baseState({ url: "about:blank", title: "浏览器" })));

    await act(async () => {
      render(<DesktopBrowserPanel flowId="flow-a" />);
    });

    expect(screen.getByText("开始浏览")).toBeInTheDocument();
    expect(screen.getByText("输入 URL 以打开页面")).toBeInTheDocument();
  });

  it("hides the native view for a blocking overlay and restores it without navigating", async () => {
    const state = baseState();
    const setLayout = vi.fn().mockResolvedValue(state);
    const navigate = vi.fn().mockResolvedValue(state);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 810,
      bottom: 620,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    vi.stubGlobal("squadflowDesktopBrowser", stubBridge(state, { setLayout, navigate }));

    const flushAnimationFrame = async () => {
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((callback) => callback(performance.now())));
    };

    const { rerender } = render(<DesktopBrowserPanel flowId="flow-a" visible={false} />);
    await act(async () => {});
    await flushAnimationFrame();
    expect(setLayout).toHaveBeenCalledWith({ visible: false });

    rerender(<DesktopBrowserPanel flowId="flow-a" visible />);
    await act(async () => {});
    await flushAnimationFrame();
    expect(setLayout).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
    expect(navigate).not.toHaveBeenCalled();
  });
});

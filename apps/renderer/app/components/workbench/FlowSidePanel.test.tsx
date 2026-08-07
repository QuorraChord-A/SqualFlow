import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowWorkbench } from "../../hooks/useFlowWorkbench";
import FlowSidePanel from "./FlowSidePanel";
import { createInitialRightPanelState, type RightPanelState } from "./workbenchState";

vi.mock("./SessionTranscriptPanel", () => ({
  default: ({ flowExpertId }: { flowExpertId?: string | null }) => (
    <div data-testid="mock-session-transcript">{flowExpertId}</div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const workbench: FlowWorkbench = {
  team: [
    {
      id: "leader-1",
      display_name: "Leader",
      role: "Leader",
      status: "running",
      current_task_title: null,
      last_active_at: "2026-06-14T01:00:00.000Z",
      agent_session_id: "leader-1",
      flow_expert_id: null,
      expert_id: "exp-leader",
      is_leader: true,
    },
    {
      id: "worker-1",
      display_name: "Frontend",
      role: "前端开发",
      status: "idle",
      current_task_title: "Build hello",
      last_active_at: "2026-06-14T01:01:00.000Z",
      agent_session_id: "worker-1",
      flow_expert_id: "fexp-frontend",
      expert_id: "exp-frontend",
      is_leader: false,
    },
  ],
  artifacts: {
    specs: [{
      id: "spec-1",
      spec_revision_id: "spec-1",
      status: "approved",
      title: "Hello Spec",
      file_name: "Hello_World_abcd.md",
      overview: "Create page.",
      content: "# Hello",
      created_at: "2026-06-14T01:00:00.000Z",
    }],
    files: [{
      path: "app/page.tsx",
      additions: 10,
      deletions: 2,
      source_artifact_id: "art-files",
    }],
    reports: [{
      id: "art-verify",
      type: "verify_report",
      title: "Verify",
      content: "All checks passed.",
      created_at: "2026-06-14T01:02:00.000Z",
    }],
  },
  tasks: [{
      id: "task-1",
      work_run_id: "utn-1",
      subject: "Build hello",
      status: "in_progress",
      owner_flow_expert_id: "fexp-frontend",
      owner_expert_id: "exp-frontend",
      owner_name: "Frontend",
      owner_role: "前端开发",
      active_form: "Writing page",
      progress: null,
      blocked_by: [],
  }],
  files: {
    root_path: "/tmp/project",
    tree_available: true,
  },
  reviews: [],
};

function renderPanel(
  state: RightPanelState = createInitialRightPanelState(),
  onStateChange: (state: RightPanelState) => void = vi.fn(),
  workbenchData: FlowWorkbench = workbench,
) {
  return render(
    <FlowSidePanel
      flowId="flow-1"
      workbench={workbenchData}
      state={state}
      onStateChange={onStateChange}
    />,
  );
}

describe("FlowSidePanel", () => {
  it("keeps the closed drawer out of layout flow while the fixed handle remains available", () => {
    const onToggle = vi.fn();
    render(
      <FlowSidePanel
        width={432}
        isOpen={false}
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
        onToggle={onToggle}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveAttribute("data-state", "closed");
    expect(panel).toHaveStyle({ width: "432px" });
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("translate-x-full");
    expect(panel.className).toContain("transition-[transform,opacity,border-color]");
    expect(screen.queryByRole("tablist", { name: "右侧工作台" })).not.toBeInTheDocument();
    const handle = screen.getByTestId("right-panel-drawer-toggle");
    expect(handle).toHaveAccessibleName("显示右侧面板");
    fireEvent.click(handle);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("uses a layout spacer plus overlay drawer while entering", () => {
    render(
      <FlowSidePanel
        width={432}
        isOpen
        drawerAnimation="enter"
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
      />,
    );

    const spacer = screen.getByTestId("right-panel-layout-spacer");
    const panel = screen.getByTestId("flow-side-panel");

    expect(spacer).toHaveStyle({ width: "432px" });
    expect(panel).toHaveAttribute("data-drawer-animation", "enter");
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("sf-right-panel-drawer-enter");
  });

  it("releases layout space while the exiting overlay drawer animates closed", () => {
    render(
      <FlowSidePanel
        width={432}
        isOpen={false}
        drawerAnimation="exit"
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");

    expect(screen.queryByTestId("right-panel-layout-spacer")).not.toBeInTheDocument();
    expect(panel).toHaveAttribute("data-drawer-animation", "exit");
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("sf-right-panel-drawer-exit");
    expect(panel).toHaveStyle({ width: "432px" });
  });

  it("renders overview and files as fixed tabs with the add workbench menu", () => {
    renderPanel();

    expect(screen.getByTestId("flow-side-panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概要" })).toHaveAttribute("aria-selected", "true");
    const filesTab = screen.getByRole("tab", { name: "文件" });
    expect(filesTab).toHaveAttribute("aria-selected", "false");
    expect(filesTab.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("tab", { name: "审核" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加工作台功能" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "专家" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "产物" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "阶段" })).not.toBeInTheDocument();
  });

  it("renders review data in a dynamic tab", () => {
    renderPanel(
      {
        ...createInitialRightPanelState(),
        tab: "dynamic",
        activeDynamicTabId: "review",
        dynamicTabs: [{ type: "review", title: "审核", work_run_id: "utn-1" }],
      },
      vi.fn(),
      {
        ...workbench,
        reviews: [{
          flow_id: "flow-1",
          work_run_id: "utn-1",
          anchor_message_id: "msg-review-utn-1",
          status: "ready",
          completed_at: "2026-06-14T01:03:00.000Z",
          totals: { files: 1, additions: 1, deletions: 1, modified: 1, added: 0, deleted: 0 },
          files: [{
            path: "apps/local-service/src/runtime/leaderRuntime.ts",
            status: "modified",
            detail_status: "ready",
            additions: 1,
            deletions: 1,
            lines: [
              { kind: "removed", old_line: 10, new_line: null, text: "old" },
              { kind: "added", old_line: null, new_line: 10, text: "new" },
            ],
          }],
        }, {
          flow_id: "flow-1",
          work_run_id: "utn-2",
          anchor_message_id: "msg-review-utn-2",
          status: "ready",
          completed_at: "2026-06-14T02:03:00.000Z",
          totals: { files: 1, additions: 1, deletions: 0, modified: 0, added: 1, deleted: 0 },
          files: [{
            path: "apps/renderer/app/latest.tsx",
            status: "added",
            detail_status: "ready",
            additions: 1,
            deletions: 0,
            lines: [{ kind: "added", old_line: null, new_line: 1, text: "latest" }],
          }],
        }],
      },
    );

    expect(screen.getByRole("tab", { name: "审核" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("WorkRun Review");
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("leaderRuntime.ts");
    expect(screen.getByTestId("review-diff-panel")).not.toHaveTextContent("latest.tsx");
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("+1");
    expect(screen.getByTestId("review-diff-panel")).toHaveTextContent("-1");
  });

  it("keeps the maximize and restore control visible across tab switches and long dynamic tabs", () => {
    const onToggleMaximize = vi.fn();
    const filesState: RightPanelState = {
      ...createInitialRightPanelState(),
      tab: "files",
      activeWorkspaceFilePath: null,
      dynamicTabs: [
        { type: "expert_chat", flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend implementation session with a long title" },
        { type: "spec_preview", spec_revision_id: "spec-1", title: "A very long specification filename.md" },
        { type: "artifact_preview", artifact_id: "art-verify", title: "Verification report with a long title" },
      ],
    };
    const { rerender } = render(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized
        flowId="flow-1"
        workbench={workbench}
        state={filesState}
        onStateChange={vi.fn()}
        onToggleMaximize={onToggleMaximize}
      />,
    );

    expect(screen.getByTestId("right-panel-maximize-toggle")).toHaveAccessibleName("恢复右侧面板");
    expect(screen.getByTestId("right-panel-maximize-toggle").closest("header")).not.toBeNull();
    fireEvent.click(screen.getByTestId("right-panel-maximize-toggle"));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);

    rerender(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized
        flowId="flow-1"
        workbench={workbench}
        state={{ ...filesState, tab: "dynamic", activeDynamicTabId: "expert_chat:fexp-frontend" }}
        onStateChange={vi.fn()}
        onToggleMaximize={onToggleMaximize}
      />,
    );
    expect(screen.getByTestId("right-panel-maximize-toggle")).toHaveAccessibleName("恢复右侧面板");

    rerender(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized={false}
        flowId="flow-1"
        workbench={workbench}
        state={{ ...filesState, tab: "overview" }}
        onStateChange={vi.fn()}
        onToggleMaximize={onToggleMaximize}
      />,
    );
    expect(screen.getByTestId("right-panel-maximize-toggle")).toHaveAccessibleName("展开右侧面板");
  });

  it("disables width animation while the right panel is being dragged", () => {
    render(
      <FlowSidePanel
        width={620}
        isOpen
        isResizing
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveAttribute("data-resizing", "true");
    expect(panel.className).toContain("transition-none");
    expect(panel.className).not.toContain("duration-300");
  });

  it("disables width animation during external layout recalculation", () => {
    render(
      <FlowSidePanel
        width={620}
        isOpen
        disableWidthAnimation
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveAttribute("data-width-animation-disabled", "true");
    expect(panel.className).toContain("transition-none");
    expect(panel.className).not.toContain("duration-300");
  });

  it("renders overview sections in the approved order", () => {
    renderPanel();

    const overview = screen.getByTestId("right-workbench-overview");
    const sectionTitles = within(overview)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label")?.includes("折叠") || button.getAttribute("aria-label")?.includes("展开"))
      .map((button) => button.textContent);

    expect(sectionTitles[0]).toContain("团队信息");
    expect(sectionTitles[1]).toContain("产物");
    expect(sectionTitles[2]).toContain("任务进度");
  });

  it("shows WorkBuddy-style team rows with Leader first", () => {
    renderPanel();

    const rows = within(screen.getByTestId("team-section")).getAllByTestId("team-member-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Leader");
    expect(rows[0]).toHaveTextContent("运行中");
    expect(rows[1]).toHaveTextContent("Frontend");
    expect(rows[1]).toHaveTextContent("空闲中");
  });

  it("shows spec, changed files, task progress, and responsible expert", () => {
    renderPanel();

    expect(screen.getByText("Spec 1")).toBeInTheDocument();
    expect(screen.getByText("Hello Spec")).toBeInTheDocument();
    expect(screen.getByText("变更文件 1")).toBeInTheDocument();
    expect(screen.getByText("app/page.tsx")).toBeInTheDocument();
    expect(screen.getByText("+10 -2")).toBeInTheDocument();
    expect(screen.getByText("报告 1")).toBeInTheDocument();
    expect(screen.getByText("Verify")).toBeInTheDocument();
    expect(screen.getByText("任务 1 · 执行中")).toBeInTheDocument();
    expect(screen.getByText("Build hello")).toBeInTheDocument();
    expect(screen.getByText("Frontend · 前端开发")).toBeInTheDocument();
    expect(screen.getByText("当前步骤：Writing page")).toBeInTheDocument();
  });

  it("shows completed Task progress instead of treating an empty active form as waiting", () => {
    renderPanel(createInitialRightPanelState(), vi.fn(), {
      ...workbench,
      tasks: [{
        ...workbench.tasks[0],
        status: "completed",
        active_form: "",
        progress: "已完成管理系统只读初步评估；未修改文件。",
      }],
    });

    expect(screen.getByText("任务 1 · 已完成")).toBeInTheDocument();
    expect(screen.getByText("当前步骤：已完成管理系统只读初步评估；未修改文件。")).toBeInTheDocument();
    expect(screen.queryByText("当前步骤：等待执行")).not.toBeInTheDocument();
  });

  it("folds overview sections in the current page session", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    fireEvent.click(screen.getByRole("button", { name: "折叠团队信息" }));
    expect(states.at(-1)?.collapsedSections.team).toBe(true);
  });

  it("shows the interactive file workspace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: "", entries: [], truncated: false }),
    }));
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "files",
    });

    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("筛选文件…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新文件树" })).toBeInTheDocument();
    expect(screen.getByTitle("/tmp/project")).toHaveTextContent("project");
    await waitFor(() => expect(screen.getByText("工作区为空")).toBeInTheDocument());
  });

  it("does not show the fixed file workspace in the add menu", () => {
    renderPanel(createInitialRightPanelState());

    fireEvent.click(screen.getByRole("button", { name: "添加工作台功能" }));

    expect(screen.queryByRole("menuitem", { name: "文件" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "浏览器" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "审核" })).toBeInTheDocument();
  });

  it("opens an audit workbench tab from the add menu", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    fireEvent.click(screen.getByRole("button", { name: "添加工作台功能" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "审核" }));

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("dynamic");
    expect(lastState?.activeDynamicTabId).toBe("review");
    expect(lastState?.dynamicTabs).toContainEqual({ type: "review", title: "审核" });
  });

  it("opens a browser workbench tab from the add menu while Files is open", () => {
    const states: RightPanelState[] = [];
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "files",
    }, (state) => states.push(state));

    fireEvent.click(screen.getByRole("button", { name: "添加工作台功能" }));
    expect(screen.queryByRole("menuitem", { name: "文件" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "浏览器" }));

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("dynamic");
    expect(lastState?.activeDynamicTabId).toBe("browser");
    expect(lastState?.dynamicTabs).toContainEqual({ type: "browser", title: "浏览器" });
  });

  it("renders the desktop browser panel for the browser tab", () => {
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "dynamic",
      activeDynamicTabId: "browser",
      dynamicTabs: [{ type: "browser", title: "浏览器" }],
    });

    expect(screen.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("desktop-browser-panel")).toBeInTheDocument();
    expect(screen.getByText("桌面浏览器")).toBeInTheDocument();
  });

  it("resets desktop browser state when closing the browser tab", () => {
    const reset = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      reset,
      stopElementPicker: vi.fn().mockResolvedValue(null),
    });
    const states: RightPanelState[] = [];
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "overview",
      activeDynamicTabId: null,
      dynamicTabs: [{ type: "browser", title: "浏览器" }],
    }, (state) => states.push(state));

    fireEvent.click(screen.getByRole("button", { name: "关闭 浏览器" }));

    expect(reset).toHaveBeenCalledOnce();
    expect(states.at(-1)?.dynamicTabs).toEqual([]);
  });

  it("keeps the add menu available when only non-file dynamic tabs are open", () => {
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "dynamic",
      activeDynamicTabId: "expert_chat:fexp-frontend",
      dynamicTabs: [{ type: "expert_chat", flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend" }],
    });

    expect(screen.getByRole("button", { name: "添加工作台功能" })).toBeInTheDocument();
  });

  it("keeps the fixed drawer handle outside the sliding header and file controls inside the Files tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: "", entries: [], truncated: false }),
    }));
    renderPanel({
      ...createInitialRightPanelState(),
      tab: "files",
    });

    const toggle = screen.getByTestId("file-tree-visibility-toggle");
    expect(toggle).toHaveAccessibleName("隐藏文件列表");
    expect(screen.getAllByRole("button", { name: "隐藏文件列表" })).toHaveLength(1);
    expect(toggle.closest("header")).toBeNull();
    expect(screen.getByTestId("right-panel-maximize-toggle").closest("header")).not.toBeNull();
    expect(screen.getByTestId("right-panel-drawer-toggle").closest("header")).toBeNull();
    expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "true");

    fireEvent.click(toggle);
    expect(screen.getByTestId("file-tree-visibility-toggle")).toHaveAccessibleName("显示文件列表");
    expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "false");

    fireEvent.click(screen.getByTestId("file-tree-visibility-toggle"));
    expect(screen.getByTestId("file-tree-visibility-toggle")).toHaveAccessibleName("隐藏文件列表");
    expect(screen.getByTestId("workspace-files-shell")).toHaveAttribute("data-tree-visible", "true");
  });

  it("marks a maximized Files tab as the full file workspace", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path: "", entries: [], truncated: false }),
    }));
    render(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized
        flowId="flow-1"
        workbench={workbench}
        state={{
          ...createInitialRightPanelState(),
          tab: "files",
        }}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveAttribute("data-file-workspace-maximized", "true");
    expect(panel.className.split(" ")).toContain("absolute");
    expect(panel.className.split(" ")).not.toContain("relative");
    expect(screen.getByTestId("right-panel-maximize-toggle")).toHaveAccessibleName("恢复右侧面板");
  });

  it("uses the same opaque maximized container for non-file tabs", () => {
    render(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized
        flowId="flow-1"
        workbench={workbench}
        state={createInitialRightPanelState()}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveAttribute("data-workbench-maximized", "true");
    expect(panel).toHaveAttribute("data-file-workspace-maximized", "false");
    expect(panel.className.split(" ")).toContain("absolute");
    expect(panel.className.split(" ")).toContain("bg-background");
    expect(panel.className).not.toContain("bg-background/95");
  });

  it("keeps a maximized file workspace attached to the visible left panel edge", () => {
    render(
      <FlowSidePanel
        width={620}
        isOpen
        isMaximized
        maximizedLeftOffset={208}
        flowId="flow-1"
        workbench={workbench}
        state={{
          ...createInitialRightPanelState(),
          tab: "files",
        }}
        onStateChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("flow-side-panel");
    expect(panel).toHaveStyle({ left: "208px" });
    expect(panel.className).toContain("right-0");
  });

  it("clicking Leader does not call onStateChange", () => {
    const onStateChange = vi.fn();
    renderPanel(createInitialRightPanelState(), onStateChange);

    const rows = within(screen.getByTestId("team-section")).getAllByTestId("team-member-row");
    fireEvent.click(rows[0]);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("clicking a non-Leader Expert opens an expert_chat dynamic tab", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    const rows = within(screen.getByTestId("team-section")).getAllByTestId("team-member-row");
    fireEvent.click(rows[1]);

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("dynamic");
    expect(lastState?.activeDynamicTabId).toBe("expert_chat:fexp-frontend");
    expect(lastState?.dynamicTabs).toEqual([
      expect.objectContaining({ type: "expert_chat", flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend" }),
    ]);
  });

  it("clicking a Spec opens a spec_preview dynamic tab", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    fireEvent.click(screen.getByText("Hello Spec"));

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("dynamic");
    expect(lastState?.activeDynamicTabId).toBe("spec_preview:spec-1");
  });

  it("clicking a report opens an artifact_preview dynamic tab", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    fireEvent.click(screen.getByText("Verify"));

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("dynamic");
    expect(lastState?.activeDynamicTabId).toBe("artifact_preview:art-verify");
  });

  it("clicking a changed file updates the fixed files tab", () => {
    const states: RightPanelState[] = [];
    renderPanel(createInitialRightPanelState(), (state) => states.push(state));

    fireEvent.click(screen.getByText("app/page.tsx"));

    const lastState = states.at(-1);
    expect(lastState?.tab).toBe("files");
    expect(lastState?.activeDynamicTabId).toBeNull();
    expect(lastState?.activeWorkspaceFilePath).toBe("app/page.tsx");
    expect(lastState?.dynamicTabs.some((tab) => tab.type === "workspace_file_preview")).toBe(false);
  });

  it("renders the fixed file tab with the current file name and no close button", () => {
    const state: RightPanelState = {
      ...createInitialRightPanelState(),
      tab: "files",
      activeWorkspaceFilePath: "src/app.tsx",
    };
    renderPanel(state);

    expect(screen.getByRole("tab", { name: "概要" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "app.tsx" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "关闭 app.tsx" })).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-files-shell")).toBeInTheDocument();
  });

  it("renders the second file tab as a closeable dynamic tab", () => {
    const state: RightPanelState = {
      ...createInitialRightPanelState(),
      tab: "dynamic",
      activeDynamicTabId: "workspace_file_preview:src/second.ts",
      activeWorkspaceFilePath: "src/first.ts",
      dynamicTabs: [
        { type: "workspace_file_preview", path: "src/second.ts", title: "second.ts", tabId: "src/second.ts" },
      ],
    };
    renderPanel(state);

    expect(screen.queryByRole("button", { name: "关闭 first.ts" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 second.ts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "second.ts" })).toHaveAttribute("aria-selected", "true");
  });

  it("activates an existing dynamic tab instead of duplicating it", () => {
    const states: RightPanelState[] = [];
    const initialState = {
      ...createInitialRightPanelState(),
      tab: "overview" as const,
      activeDynamicTabId: "expert_chat:fexp-frontend",
      dynamicTabs: [{ type: "expert_chat" as const, flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend" }],
    };
    renderPanel(initialState, (state) => states.push(state));

    const rows = within(screen.getByTestId("team-section")).getAllByTestId("team-member-row");
    fireEvent.click(rows[1]);

    const lastState = states.at(-1);
    expect(lastState?.dynamicTabs).toHaveLength(1);
    expect(lastState?.activeDynamicTabId).toBe("expert_chat:fexp-frontend");
    expect(lastState?.tab).toBe("dynamic");
  });

  it("clicking a dynamic tab close button removes only that tab", () => {
    const states: RightPanelState[] = [];
    const initialState = {
      ...createInitialRightPanelState(),
      tab: "dynamic" as const,
      activeDynamicTabId: "expert_chat:fexp-frontend",
      dynamicTabs: [
        { type: "expert_chat" as const, flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend" },
        { type: "spec_preview" as const, spec_revision_id: "spec-1", title: "Hello.md" },
      ],
    };
    renderPanel(initialState, (state) => states.push(state));

    fireEvent.click(screen.getByRole("button", { name: "关闭 Hello.md" }));

    const lastState = states.at(-1);
    expect(lastState?.dynamicTabs).toHaveLength(1);
    expect(lastState?.dynamicTabs[0]).toEqual(expect.objectContaining({ type: "expert_chat" }));
  });

  it("preserves the active dynamic tab when workbench team data updates", () => {
    const initialState = {
      ...createInitialRightPanelState(),
      tab: "dynamic" as const,
      activeDynamicTabId: "expert_chat:fexp-frontend",
      dynamicTabs: [{ type: "expert_chat" as const, flow_expert_id: "fexp-frontend", agent_session_id: "worker-1", title: "Frontend" }],
    };
    const { rerender } = renderPanel(initialState, vi.fn());

    const updatedWorkbench = {
      ...workbench,
      team: workbench.team.map((member) =>
        member.id === "worker-1" ? { ...member, status: "running" as const, current_task_title: "Updated" } : member
      ),
    };
    rerender(
      <FlowSidePanel
        flowId="flow-1"
        workbench={updatedWorkbench}
        state={initialState}
        onStateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Frontend" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("right-workbench-overview")).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-session-transcript")).toHaveTextContent("fexp-frontend");
  });
});

"use client";

import { useCallback, useState, type PointerEvent, type ReactNode } from "react";
import { Expand, FileDiff, Globe2, Minimize2, PanelRightClose, PanelRightOpen, Plus, X } from "lucide-react";
import type { FlowWorkbench, WorkbenchTeamMember } from "../../hooks/useFlowWorkbench";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import PanelResizeHandle from "../PanelResizeHandle";
import { DEFAULT_RIGHT_PANEL_WIDTH } from "../panelSizing";
import SessionDetailPanel from "./SessionDetailPanel";
import WorkspaceFilesPanel from "./WorkspaceFilesPanel";
import DesktopBrowserPanel from "./DesktopBrowserPanel";
import ReviewDiffPanel from "./ReviewDiffPanel";
import {
  closeDynamicWorkbenchTab,
  dynamicWorkbenchTabId,
  openBrowserWorkbenchTab,
  openDynamicWorkbenchTab,
  openReviewWorkbenchTab,
  openWorkspaceFileWorkbenchTab,
  type DynamicWorkbenchTab,
  type RightPanelCollapsedSections,
  type RightPanelState,
} from "./workbenchState";
import { getDesktopBrowserBridge } from "../../lib/desktopBrowser";
import { useBrowserSelectionStore } from "../../stores/useBrowserSelectionStore";
import { MessageResponse } from "@/components/ai-elements-official/message";
import OrchestrationPlanPanel from "../orchestration/OrchestrationPlanPanel";
import { wsClient } from "../../lib/ws";

interface FlowSidePanelProps {
  width?: number;
  isOpen?: boolean;
  isResizing?: boolean;
  disableWidthAnimation?: boolean;
  drawerAnimation?: "enter" | "exit" | null;
  onResizeStart?: (event: PointerEvent<HTMLDivElement>) => void;
  flowId: string | null;
  workbench: FlowWorkbench;
  state: RightPanelState;
  onStateChange: (state: RightPanelState) => void;
  isMaximized?: boolean;
  maximizedLeftOffset?: number;
  onToggleMaximize?: () => void;
  onToggle?: () => void;
  browserBlocked?: boolean;
  workspaceRootPath?: string | null;
}

function workspaceFileTitle(path: string | null) {
  if (!path) return "文件";
  return path.split("/").at(-1) || path;
}

type WorkbenchAddAction = {
  id: "browser" | "review";
  label: string;
  icon: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
};

type FlowSidePanelHeaderProps = {
  state: RightPanelState;
  onStateChange: (state: RightPanelState) => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  onOpenBrowser?: () => void;
  onOpenReview?: () => void;
};

export function FlowSidePanelHeader({
  state,
  onStateChange,
  isMaximized = false,
  onToggleMaximize = () => {},
  onOpenBrowser = () => {},
  onOpenReview = () => {},
}: FlowSidePanelHeaderProps) {
  const setTab = (tab: "overview" | "files") => {
    onStateChange({
      ...state,
      tab,
      activeDynamicTabId: null,
    });
  };
  const hasBrowserTab = state.dynamicTabs.some((tab) => tab.type === "browser");
  const hasReviewTab = state.dynamicTabs.some((tab) => tab.type === "review");
  const fixedTabs: { id: "overview" | "files"; label: string; icon?: ReactNode }[] = [
    { id: "overview", label: "概要" },
    { id: "files", label: workspaceFileTitle(state.activeWorkspaceFilePath) },
  ];
  const addActions: WorkbenchAddAction[] = [
    ...(!hasBrowserTab
      ? [{
          id: "browser" as const,
          label: "浏览器",
          icon: <Globe2 className="size-4" />,
          onSelect: onOpenBrowser,
        }]
      : []),
    ...(!hasReviewTab
      ? [{
          id: "review" as const,
          label: "审核",
          icon: <FileDiff className="size-4" />,
          onSelect: onOpenReview,
        }]
      : []),
  ];

  return (
    <header className="flex h-14 min-w-0 shrink-0 items-stretch border-b border-border bg-background/95">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          role="tablist"
          aria-label="右侧工作台"
          className="flex h-full min-w-0 items-end gap-1 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {fixedTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={state.tab === tab.id}
              onClick={() => setTab(tab.id)}
              className={`h-full shrink-0 cursor-pointer border-b-2 px-2 pt-0.5 text-sm font-semibold transition-colors ${
                state.tab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.icon ? <span className="mr-1.5 inline-flex align-[-2px]">{tab.icon}</span> : null}
              {tab.label}
            </button>
          ))}
          {state.dynamicTabs.map((tab) => {
            const id = dynamicWorkbenchTabId(tab);
            return (
              <div
                key={id}
                className={`inline-flex h-full max-w-56 shrink-0 items-center gap-1 border-b-2 px-2 text-sm ${
                  state.tab === "dynamic" && state.activeDynamicTabId === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.tab === "dynamic" && state.activeDynamicTabId === id}
                  onClick={() => onStateChange({ ...state, tab: "dynamic", activeDynamicTabId: id })}
                  className="min-w-0 flex-1 truncate"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (tab.type === "browser") {
                      useBrowserSelectionStore.getState().clearElements();
                      const bridge = getDesktopBrowserBridge();
                      void (bridge?.reset?.() ?? bridge?.stopElementPicker());
                    }
                    onStateChange(closeDynamicWorkbenchTab(state, id));
                  }}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
          {addActions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                aria-label="添加工作台功能"
                className="mb-2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" className="w-40">
                {addActions.map((action) => (
                  <DropdownMenuItem
                    key={action.id}
                    onClick={action.onSelect}
                    disabled={action.disabled}
                    className="gap-2"
                  >
                    {action.icon}
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1 border-l border-border/70 bg-background/95 px-2 pr-14">
        <Tooltip>
          <TooltipTrigger
            data-testid="right-panel-maximize-toggle"
            type="button"
            aria-label={isMaximized ? "恢复右侧面板" : "展开右侧面板"}
            onClick={onToggleMaximize}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {isMaximized ? <Minimize2 className="size-4" /> : <Expand className="size-4" />}
          </TooltipTrigger>
          <TooltipContent>{isMaximized ? "恢复面板" : "展开面板"}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function DrawerHandle({ isOpen, onToggle = () => {} }: { isOpen: boolean; onToggle?: () => void }) {
  return (
    <div className="absolute right-2 top-2 z-50">
      <Tooltip>
        <TooltipTrigger
          data-testid="right-panel-drawer-toggle"
          type="button"
          aria-label={isOpen ? "隐藏右侧面板" : "显示右侧面板"}
          onClick={onToggle}
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        >
          {isOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
        </TooltipTrigger>
        <TooltipContent>{isOpen ? "隐藏面板" : "显示面板"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

const sectionMeta: { id: keyof RightPanelCollapsedSections; title: string; testId: string }[] = [
  { id: "team", title: "团队信息", testId: "team-section" },
  { id: "artifacts", title: "产物", testId: "artifacts-section" },
  { id: "tasks", title: "任务进度", testId: "task-progress-section" },
];

function taskStatusLabel(status: string | undefined) {
  if (status === "pending") return "待执行";
  if (status === "in_progress") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return status || "待执行";
}

function agentInitial(member: WorkbenchTeamMember) {
  return member.display_name.trim().slice(0, 1).toUpperCase() || "?";
}

function diffStat(file: FlowWorkbench["artifacts"]["files"][number]) {
  if (typeof file.additions === "number" && typeof file.deletions === "number") {
    return `+${file.additions} -${file.deletions}`;
  }
  if (typeof file.additions === "number") return `+${file.additions}`;
  if (typeof file.deletions === "number") return `-${file.deletions}`;
  return "";
}

function panelWidthStyle(width: number, isMaximized: boolean, isOpen: boolean, maximizedLeftOffset: number) {
  if (isMaximized) return { left: maximizedLeftOffset };
  return { width: isOpen ? width : 0 };
}

function overlayPanelWidthStyle(width: number, isMaximized: boolean, maximizedLeftOffset: number) {
  if (isMaximized) return { left: maximizedLeftOffset };
  return { width };
}

function Section({
  id,
  title,
  testId,
  collapsed,
  onToggle,
  children,
}: {
  id: keyof RightPanelCollapsedSections;
  title: string;
  testId: string;
  collapsed: boolean;
  onToggle: (id: keyof RightPanelCollapsedSections) => void;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="border-b border-border/70 py-3 last:border-b-0">
      <button
        type="button"
        aria-label={`${collapsed ? "展开" : "折叠"}${title}`}
        onClick={() => onToggle(id)}
        className="flex w-full cursor-pointer items-center justify-between text-left text-sm font-semibold text-foreground"
      >
        <span>{title}</span>
        <span className="text-muted-foreground">{collapsed ? "›" : "⌄"}</span>
      </button>
      {!collapsed ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

function TeamSection({ team, onOpenExpert }: {
  team: FlowWorkbench["team"];
  onOpenExpert: (member: WorkbenchTeamMember) => void;
}) {
  if (team.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无团队成员</div>;
  }

  return (
    <div className="space-y-2">
      {team.map((member) => (
        <button
          key={member.id}
          type="button"
          disabled={member.is_leader || !member.flow_expert_id}
          onClick={() => onOpenExpert(member)}
          data-testid="team-member-row"
          className="flex w-full items-center justify-between rounded-md border border-border/60 bg-background/70 px-3 py-2 text-left disabled:cursor-default"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
              {agentInitial(member)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{member.display_name}</div>
              <div className="truncate text-xs text-muted-foreground">{member.role}</div>
            </div>
          </div>
          <div className={member.status === "running" ? "text-xs font-semibold text-primary" : "text-xs text-muted-foreground"}>
            {member.status === "running" ? "运行中" : "空闲中"}
          </div>
        </button>
      ))}
    </div>
  );
}

function ArtifactSection({
  artifacts,
  onOpenSpec,
  onOpenArtifact,
  onOpenWorkspaceFile,
}: {
  artifacts: FlowWorkbench["artifacts"];
  onOpenSpec: (spec: FlowWorkbench["artifacts"]["specs"][number]) => void;
  onOpenArtifact: (report: FlowWorkbench["artifacts"]["reports"][number]) => void;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  if (artifacts.specs.length === 0 && artifacts.files.length === 0 && artifacts.reports.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无产物</div>;
  }

  return (
    <div className="space-y-4">
      {artifacts.specs.length > 0 ? (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Spec {artifacts.specs.length}</div>
          <div className="space-y-2">
            {artifacts.specs.map((spec) => (
              <button
                key={spec.id}
                type="button"
                onClick={() => onOpenSpec(spec)}
                className="w-full rounded-md bg-background/70 px-3 py-2 text-left text-sm text-foreground"
              >
                {spec.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {artifacts.files.length > 0 ? (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">变更文件 {artifacts.files.length}</div>
          <div className="space-y-2">
            {artifacts.files.map((file) => (
              <button
                key={`${file.source_artifact_id ?? "file"}:${file.path}`}
                type="button"
                onClick={() => onOpenWorkspaceFile(file.path)}
                className="flex w-full items-center justify-between rounded-md bg-background/70 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">{file.path}</span>
                {diffStat(file) ? <span className="shrink-0 text-primary">{diffStat(file)}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {artifacts.reports.length > 0 ? (
        <div>
          <div className="mb-2 text-xs text-muted-foreground">报告 {artifacts.reports.length}</div>
          <div className="space-y-2">
            {artifacts.reports.map((report) => (
              <button
                key={report.id}
                type="button"
                onClick={() => onOpenArtifact(report)}
                className="w-full rounded-md bg-background/70 px-3 py-2 text-left text-sm text-foreground"
              >
                {report.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskProgressSection({ tasks }: { tasks: FlowWorkbench["tasks"] }) {
  if (tasks.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无任务</div>;
  }

  return (
    <div className="space-y-4 border-l border-dashed border-border/80 pl-4">
      {tasks.map((task, index) => (
        <div key={task.id} className="relative space-y-1">
          <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-primary" />
          <div className="text-sm font-medium text-foreground">
            任务 {index + 1} · {taskStatusLabel(task.status)}
          </div>
          <div className="text-sm text-foreground">{task.subject}</div>
          <div className="text-xs font-semibold text-primary">
            {[task.owner_role, task.owner_name].filter(Boolean).join(" ") || "未分配"}
          </div>
          <div className="text-xs text-muted-foreground">当前步骤：{task.active_form || "等待执行"}</div>
        </div>
      ))}
    </div>
  );
}

function OverviewTab({
  state,
  workbench,
  onToggleSection,
  onOpenExpert,
  onOpenSpec,
  onOpenArtifact,
  onOpenWorkspaceFile,
}: {
  state: RightPanelState;
  workbench: FlowWorkbench;
  onToggleSection: (id: keyof RightPanelCollapsedSections) => void;
  onOpenExpert: (member: WorkbenchTeamMember) => void;
  onOpenSpec: (spec: FlowWorkbench["artifacts"]["specs"][number]) => void;
  onOpenArtifact: (report: FlowWorkbench["artifacts"]["reports"][number]) => void;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  return (
    <div data-testid="right-workbench-overview" className="px-4">
      {sectionMeta.map((section) => (
        <Section
          key={section.id}
          id={section.id}
          title={section.title}
          testId={section.testId}
          collapsed={state.collapsedSections[section.id]}
          onToggle={onToggleSection}
        >
          {section.id === "team" ? (
            <TeamSection team={workbench.team} onOpenExpert={onOpenExpert} />
          ) : section.id === "artifacts" ? (
            <ArtifactSection
              artifacts={workbench.artifacts}
              onOpenSpec={onOpenSpec}
              onOpenArtifact={onOpenArtifact}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ) : (
            <TaskProgressSection tasks={workbench.tasks} />
          )}
        </Section>
      ))}
    </div>
  );
}

function DynamicTabContent({
  flowId,
  tab,
  workbench,
  browserVisible,
  workspaceRootPath,
  onOpenWorkspaceFile,
}: {
  flowId: string | null;
  tab: DynamicWorkbenchTab | null;
  workbench: FlowWorkbench;
  browserVisible: boolean;
  workspaceRootPath?: string | null;
  onOpenWorkspaceFile: (path: string) => void;
}) {
  if (!tab) return null;
  if (tab.type === "expert_chat") {
    return (
      <SessionDetailPanel
        flowId={flowId}
        flowExpertId={tab.flow_expert_id}
        workspaceRootPath={workspaceRootPath ?? workbench.files.root_path}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    );
  }
  if (tab.type === "spec_preview") {
    const spec = workbench.artifacts.specs.find((item) =>
      item.spec_revision_id === tab.spec_revision_id || item.id === tab.spec_revision_id
    );
    return (
      <div className="min-w-0 p-4">
        <div className="mb-4 truncate text-sm text-muted-foreground">{spec?.file_name ?? tab.title}</div>
        <MessageResponse>{spec?.content ?? ""}</MessageResponse>
      </div>
    );
  }
  if (tab.type === "artifact_preview") {
    const artifact = workbench.artifacts.reports.find((item) => item.id === tab.artifact_id);
    return (
      <div className="min-w-0 p-4">
        <div className="mb-4 truncate text-sm text-muted-foreground">{artifact?.title ?? tab.title}</div>
        <MessageResponse>{artifact?.content ?? ""}</MessageResponse>
      </div>
    );
  }
  if (tab.type === "orchestration_plan") {
    const currentPlan = workbench.orchestration_plan;
    const tabPlanId = tab.plan_id ?? tab.plan?.plan_id;
    const plan = currentPlan && currentPlan.plan_id === tabPlanId
      ? currentPlan
      : tab.plan ?? currentPlan;
    if (!plan) return null;
    return <OrchestrationPlanPanel flowId={flowId ?? plan.flow_id} initialPlan={plan} onApprove={(target) => {
      if (!target.approval) return;
      wsClient.send({ type: "flow:plan_approve", flow_id: target.flow_id, plan_approval_id: target.approval.plan_approval_id, client_action_id: `plan-approve-${Date.now()}` });
    }} />;
  }
  if (tab.type === "browser") {
    return <DesktopBrowserPanel flowId={flowId} visible={browserVisible} />;
  }
  if (tab.type === "review") {
    return <ReviewDiffPanel review={workbench.review} />;
  }
  return null;
}

export default function FlowSidePanel({
  width = DEFAULT_RIGHT_PANEL_WIDTH,
  isOpen = true,
  isResizing = false,
  disableWidthAnimation = false,
  drawerAnimation = null,
  onResizeStart = () => {},
  flowId,
  workbench,
  state,
  onStateChange,
  isMaximized = false,
  maximizedLeftOffset = 0,
  onToggleMaximize = () => {},
  onToggle,
  browserBlocked = false,
  workspaceRootPath,
}: FlowSidePanelProps) {
  const [fileTreeState, setFileTreeState] = useState<{ flowId: string | null; visible: boolean }>({
    flowId,
    visible: true,
  });
  const fileTreeVisible = fileTreeState.flowId === flowId ? fileTreeState.visible : true;
  const handleFileTreeVisibleChange = useCallback((visible: boolean) => {
    setFileTreeState({ flowId, visible });
  }, [flowId]);

  const toggleSection = (section: keyof RightPanelCollapsedSections) => {
    onStateChange({
      ...state,
      collapsedSections: {
        ...state.collapsedSections,
        [section]: !state.collapsedSections[section],
      },
    });
  };

  const openExpert = (member: WorkbenchTeamMember) => {
    if (member.is_leader || !member.flow_expert_id) return;
    onStateChange(openDynamicWorkbenchTab(state, {
      type: "expert_chat",
      flow_expert_id: member.flow_expert_id,
      agent_session_id: member.agent_session_id,
      title: member.display_name,
    }));
  };

  const openSpec = (spec: FlowWorkbench["artifacts"]["specs"][number]) => {
    onStateChange(openDynamicWorkbenchTab(state, {
      type: "spec_preview",
      spec_revision_id: spec.spec_revision_id,
      title: spec.file_name,
    }));
  };

  const openArtifact = (report: FlowWorkbench["artifacts"]["reports"][number]) => {
    onStateChange(openDynamicWorkbenchTab(state, {
      type: "artifact_preview",
      artifact_id: report.id,
      title: report.title,
    }));
  };

  const openWorkspaceFile = (filePath: string) => {
    onStateChange(openWorkspaceFileWorkbenchTab(state, filePath));
  };

  const openBrowser = () => {
    onStateChange(openBrowserWorkbenchTab(state));
  };

  const openReview = () => {
    onStateChange(openReviewWorkbenchTab(state));
  };

  const openWorkspaceFileInBrowser = (url: string) => {
    onStateChange(openBrowserWorkbenchTab(state));
    const bridge = getDesktopBrowserBridge();
    if (bridge) void bridge.navigate(url);
  };

  const handleWorkspaceEntryDeleted = (entryPath: string) => {
    const containsPath = (candidate: string | null | undefined) => Boolean(
      candidate && (candidate === entryPath || candidate.startsWith(`${entryPath}/`)),
    );
    const dynamicTabs = state.dynamicTabs.filter((tab) => tab.type !== "workspace_file_preview" || !containsPath(tab.path));
    const activeDynamicStillExists = dynamicTabs.some((tab) => dynamicWorkbenchTabId(tab) === state.activeDynamicTabId);
    onStateChange({
      ...state,
      dynamicTabs,
      activeWorkspaceFilePath: containsPath(state.activeWorkspaceFilePath) ? null : state.activeWorkspaceFilePath,
      activeDynamicTabId: activeDynamicStillExists ? state.activeDynamicTabId : null,
      tab: state.tab === "dynamic" && !activeDynamicStillExists ? "files" : state.tab,
    });
  };

  const activeDynamicTab = state.dynamicTabs.find((item) => dynamicWorkbenchTabId(item) === state.activeDynamicTabId) ?? null;
  const activeWorkspaceFile = state.tab === "files"
    ? state.activeWorkspaceFilePath
    : activeDynamicTab?.type === "workspace_file_preview"
      ? activeDynamicTab.path
      : null;
  const isFileWorkspace = state.tab === "files" || activeDynamicTab?.type === "workspace_file_preview";
  const isReviewWorkspace = activeDynamicTab?.type === "review";
  const isBrowserWorkspace = activeDynamicTab?.type === "browser";
  const isAnimatingDrawer = drawerAnimation !== null;
  const isOverlayDrawer = !isMaximized && (!isOpen || isAnimatingDrawer);
  const shouldRenderLayoutSpacer = !isMaximized && isOpen && drawerAnimation === "enter";
  const drawerAnimationClass = drawerAnimation === "enter"
    ? "sf-right-panel-drawer-enter"
    : drawerAnimation === "exit"
      ? "sf-right-panel-drawer-exit"
      : "";
  const isVisible = isOpen || isAnimatingDrawer;
  const panelStyle = isOverlayDrawer
    ? overlayPanelWidthStyle(width, isMaximized, maximizedLeftOffset)
    : panelWidthStyle(width, isMaximized, isOpen, maximizedLeftOffset);

  return <>
    <DrawerHandle isOpen={isOpen} onToggle={onToggle} />
    {shouldRenderLayoutSpacer ? (
      <div
        data-testid="right-panel-layout-spacer"
        aria-hidden="true"
        className="relative shrink-0 overflow-hidden border-l border-transparent"
        style={{ width }}
      />
    ) : null}
    <aside
      data-testid="flow-side-panel"
      data-state={isOpen ? "open" : "closed"}
      data-drawer-animation={drawerAnimation ?? "none"}
      data-resizing={isResizing ? "true" : "false"}
      data-width-animation-disabled={disableWidthAnimation ? "true" : "false"}
      data-workbench-maximized={isMaximized ? "true" : "false"}
      data-file-workspace-maximized={isMaximized && isFileWorkspace ? "true" : "false"}
      aria-hidden={!isVisible}
      inert={!isVisible}
      className={`${
        isMaximized
          ? "absolute bg-background"
          : isOverlayDrawer
            ? `absolute inset-y-0 right-0 z-40 bg-background/95 ${drawerAnimationClass}`
            : "relative shrink-0 bg-background/95"
      } overflow-hidden border-l ${
        isOverlayDrawer
          ? "transition-[transform,opacity,border-color] duration-[400ms] ease-out"
          : isResizing || disableWidthAnimation
            ? "transition-none"
            : "transition-[width,border-color] duration-300 ease-in-out"
      } ${
        isMaximized
          ? "inset-y-0 right-0 z-40 w-auto border-border"
          : isVisible
            ? "border-border"
            : "pointer-events-none translate-x-full border-transparent opacity-0"
      }`}
      style={panelStyle}
    >
      <div
        className={`flex h-full min-w-0 flex-col transition-[opacity,transform] duration-[400ms] ease-out ${
          isVisible ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-3 opacity-0"
        }`}
        style={isMaximized ? undefined : { width: isResizing ? "100%" : width }}
      >
        {!isMaximized && isOpen && !isAnimatingDrawer ? <PanelResizeHandle side="right" onPointerDown={onResizeStart} /> : null}

        <FlowSidePanelHeader
          state={state}
          onStateChange={onStateChange}
          isMaximized={isMaximized}
          onToggleMaximize={onToggleMaximize}
          onOpenBrowser={openBrowser}
          onOpenReview={openReview}
        />

        <div className={isFileWorkspace || isBrowserWorkspace || isReviewWorkspace ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>
          {state.tab === "overview" ? (
          <OverviewTab
            state={state}
            workbench={workbench}
            onToggleSection={toggleSection}
            onOpenExpert={openExpert}
            onOpenSpec={openSpec}
            onOpenArtifact={openArtifact}
            onOpenWorkspaceFile={openWorkspaceFile}
          />
        ) : isFileWorkspace ? (
          <WorkspaceFilesPanel
            flowId={flowId}
            rootPath={workbench.files.root_path}
            treeAvailable={workbench.files.tree_available}
            activeFile={activeWorkspaceFile}
            onOpenFile={openWorkspaceFile}
            onOpenInBrowser={openWorkspaceFileInBrowser}
            onEntryDeleted={handleWorkspaceEntryDeleted}
            treeVisible={fileTreeVisible}
            onTreeVisibleChange={handleFileTreeVisibleChange}
          />
        ) : (
          <DynamicTabContent
            flowId={flowId}
            tab={activeDynamicTab}
            workbench={workbench}
            browserVisible={isVisible && activeDynamicTab?.type === "browser" && !browserBlocked}
            workspaceRootPath={workspaceRootPath}
            onOpenWorkspaceFile={openWorkspaceFile}
          />
          )}
        </div>
      </div>
    </aside>
  </>;
}

import type { OrchestrationPlanView } from "../../types/orchestration";

export type RightPanelTab = "overview" | "files" | "dynamic";

export type DynamicWorkbenchTab =
  | { type: "expert_chat"; agent_session_id: string; agent_run_id?: string | null; title: string }
  | { type: "plan_preview"; plan_revision_id: string; title: string }
  | { type: "artifact_preview"; artifact_id: string; title: string }
  | { type: "orchestration_plan"; orchestration_plan_id: string; orchestration_revision_id: string; title: string; plan?: OrchestrationPlanView }
  | { type: "workspace_file_preview"; path: string | null; title: string; tabId?: string }
  | { type: "change_set"; title: string; change_set_id?: string }
  | { type: "browser"; title: string };

export function dynamicWorkbenchTabId(tab: DynamicWorkbenchTab) {
  if (tab.type === "expert_chat") return `expert_chat:${tab.agent_session_id}`;
  if (tab.type === "plan_preview") return `plan_preview:${tab.plan_revision_id}`;
  if (tab.type === "artifact_preview") return `artifact_preview:${tab.artifact_id}`;
  if (tab.type === "orchestration_plan") return `orchestration_plan:${tab.orchestration_revision_id}`;
  if (tab.type === "change_set") return `change_set:${tab.change_set_id ?? "latest"}`;
  if (tab.type === "browser") return "browser";
  return `workspace_file_preview:${tab.tabId ?? tab.path ?? "open-file"}`;
}

export interface RightPanelCollapsedSections {
  team: boolean;
  artifacts: boolean;
  tasks: boolean;
}

export interface RightPanelState {
  tab: RightPanelTab;
  dynamicTabs: DynamicWorkbenchTab[];
  activeDynamicTabId: string | null;
  activeWorkspaceFilePath: string | null;
  collapsedSections: RightPanelCollapsedSections;
  isMaximized: boolean;
}

export interface PersistedRightPanelState {
  isOpen: boolean;
  autoFollowAgentDispatch: boolean;
  state: RightPanelState;
}

export function createInitialRightPanelState(): RightPanelState {
  return {
    tab: "overview",
    dynamicTabs: [],
    activeDynamicTabId: null,
    activeWorkspaceFilePath: null,
    collapsedSections: { team: false, artifacts: false, tasks: false },
    isMaximized: false,
  };
}

export function rightPanelStorageKey(flowId: string) {
  return `squadflow-right-panel-state:${flowId}`;
}

function isDynamicWorkbenchTab(value: unknown): value is DynamicWorkbenchTab {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "expert_chat") {
    return typeof candidate.agent_session_id === "string" && typeof candidate.title === "string";
  }
  if (candidate.type === "plan_preview") {
    return typeof candidate.plan_revision_id === "string" && typeof candidate.title === "string";
  }
  if (candidate.type === "artifact_preview") {
    return typeof candidate.artifact_id === "string" && typeof candidate.title === "string";
  }
  if (candidate.type === "orchestration_plan") {
    return typeof candidate.orchestration_revision_id === "string" && typeof candidate.title === "string";
  }
  if (candidate.type === "workspace_file_preview") {
    return (typeof candidate.path === "string" || candidate.path === null) && typeof candidate.title === "string";
  }
  if (candidate.type === "change_set") {
    return typeof candidate.title === "string"
      && (candidate.change_set_id === undefined || typeof candidate.change_set_id === "string");
  }
  if (candidate.type === "browser") {
    return typeof candidate.title === "string";
  }
  return false;
}

export function serializeRightPanelState(value: PersistedRightPanelState) {
  return JSON.stringify(value);
}

export function parseRightPanelState(raw: string | null): PersistedRightPanelState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedRightPanelState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed.state;
    if (!candidate || typeof candidate !== "object") return null;

    const rawTab = (candidate as unknown as { tab?: unknown }).tab;
    const tab: RightPanelTab = rawTab === "dynamic" || rawTab === "files"
      ? rawTab
      : "overview";
    const parsedDynamicTabsBeforePlanDedupe = Array.isArray(candidate.dynamicTabs)
      ? candidate.dynamicTabs.filter(isDynamicWorkbenchTab)
        .map((item) => isWorkspaceFileWorkbenchTab(item) ? normalizeWorkspaceFileTab(item) : item)
      : [];
    const activePlanTab = parsedDynamicTabsBeforePlanDedupe.find(
      (item) => item.type === "orchestration_plan" && dynamicWorkbenchTabId(item) === candidate.activeDynamicTabId,
    );
    const latestPlanTab = parsedDynamicTabsBeforePlanDedupe.filter((item) => item.type === "orchestration_plan").at(-1);
    const retainedPlanTab = activePlanTab ?? latestPlanTab;
    const parsedDynamicTabs = [
      ...parsedDynamicTabsBeforePlanDedupe.filter((item) => item.type !== "orchestration_plan"),
      ...(retainedPlanTab ? [retainedPlanTab] : []),
    ];
    const legacyWorkspaceFileTabs = parsedDynamicTabs.filter(isWorkspaceFileWorkbenchTab);
    const primaryWorkspaceFileTab = legacyWorkspaceFileTabs.find(
      (item): item is WorkspaceFileWorkbenchTab => isWorkspaceFileWorkbenchTab(item) && isPrimaryWorkspaceFileTab(item),
    );
    const dynamicTabs = parsedDynamicTabs.filter((item) => !isWorkspaceFileWorkbenchTab(item) || !isPrimaryWorkspaceFileTab(item));
    const allowedIds = new Set(dynamicTabs.map((tabItem) => dynamicWorkbenchTabId(tabItem)));
    const activeLegacyWorkspaceFileTab = legacyWorkspaceFileTabs.find(
      (item) => dynamicWorkbenchTabId(item) === candidate.activeDynamicTabId,
    );
    const activeWorkspaceFilePath =
      typeof candidate.activeWorkspaceFilePath === "string"
        ? candidate.activeWorkspaceFilePath
        : activeLegacyWorkspaceFileTab?.path ?? primaryWorkspaceFileTab?.path ?? null;
    const activeDynamicTabId = tab === "dynamic"
      ? typeof candidate.activeDynamicTabId === "string" && allowedIds.has(candidate.activeDynamicTabId)
        ? candidate.activeDynamicTabId
        : null
      : null;
    const nextTab = activeLegacyWorkspaceFileTab && isPrimaryWorkspaceFileTab(activeLegacyWorkspaceFileTab)
      ? "files"
      : tab === "dynamic" && activeDynamicTabId === null
        ? "overview"
        : tab;

    return {
      isOpen: Boolean(parsed.isOpen),
      autoFollowAgentDispatch:
        typeof parsed.autoFollowAgentDispatch === "boolean"
          ? parsed.autoFollowAgentDispatch
          : Boolean(parsed.isOpen),
      state: {
        tab: nextTab,
        dynamicTabs,
        activeDynamicTabId,
        activeWorkspaceFilePath,
        collapsedSections: {
          team: Boolean(candidate.collapsedSections?.team),
          artifacts: Boolean(candidate.collapsedSections?.artifacts),
          tasks: Boolean(candidate.collapsedSections?.tasks),
        },
        isMaximized: false,
      },
    };
  } catch {
    return null;
  }
}

export function openDynamicWorkbenchTab(state: RightPanelState, tab: DynamicWorkbenchTab): RightPanelState {
  const id = dynamicWorkbenchTabId(tab);
  const exists = state.dynamicTabs.some((item) => dynamicWorkbenchTabId(item) === id);
  return {
    ...state,
    tab: "dynamic",
    activeDynamicTabId: id,
    dynamicTabs: exists
      ? state.dynamicTabs.map((item) => dynamicWorkbenchTabId(item) === id ? { ...item, ...tab } : item)
      : [...state.dynamicTabs, tab],
  };
}

type WorkspaceFileWorkbenchTab = Extract<DynamicWorkbenchTab, { type: "workspace_file_preview" }>;

function isWorkspaceFileWorkbenchTab(tab: DynamicWorkbenchTab): tab is WorkspaceFileWorkbenchTab {
  return tab.type === "workspace_file_preview";
}

function workspaceFileTitle(path: string | null) {
  if (!path) return "文件";
  return path.split("/").at(-1) || path;
}

function isPrimaryWorkspaceFileTab(tab: WorkspaceFileWorkbenchTab) {
  return (tab.tabId ?? (tab.path ? tab.path : "open-file")) === "open-file";
}

function normalizeWorkspaceFileTab(tab: Partial<WorkspaceFileWorkbenchTab> = {}): WorkspaceFileWorkbenchTab {
  const path = typeof tab.path === "string" ? tab.path : null;
  const rawTabId = tab.tabId ?? (path ? path : "open-file");
  const tabId = rawTabId === "files" ? "open-file" : rawTabId;
  return {
    type: "workspace_file_preview",
    path,
    title: workspaceFileTitle(path),
    tabId,
  };
}

export function openWorkspaceFilesWorkbenchTab(state: RightPanelState): RightPanelState {
  return { ...state, tab: "files", activeDynamicTabId: null };
}

export function openBrowserWorkbenchTab(state: RightPanelState): RightPanelState {
  return openDynamicWorkbenchTab(state, { type: "browser", title: "浏览器" });
}

export function openChangeSetWorkbenchTab(state: RightPanelState, changeSetId?: string): RightPanelState {
  return openDynamicWorkbenchTab(state, {
    type: "change_set",
    title: "变更",
    ...(changeSetId ? { change_set_id: changeSetId } : {}),
  });
}

export function openOrchestrationPlanWorkbenchTab(state: RightPanelState, plan: OrchestrationPlanView): RightPanelState {
  const tab: DynamicWorkbenchTab = {
    type: "orchestration_plan",
    orchestration_plan_id: plan.orchestration_plan_id,
    orchestration_revision_id: plan.revision.orchestration_revision_id,
    title: plan.revision.title,
    plan,
  };
  return {
    ...state,
    tab: "dynamic",
    activeDynamicTabId: dynamicWorkbenchTabId(tab),
    dynamicTabs: [...state.dynamicTabs.filter((item) => item.type !== "orchestration_plan"), tab],
  };
}

export function syncOrchestrationPlanWorkbenchTab(state: RightPanelState, plan: OrchestrationPlanView): RightPanelState {
  const existing = state.dynamicTabs.find((item) =>
    item.type === "orchestration_plan" && item.orchestration_plan_id === plan.orchestration_plan_id
  );
  if (!existing || existing.type !== "orchestration_plan") return state;
  if (
    existing.orchestration_revision_id === plan.revision.orchestration_revision_id
    && existing.title === plan.revision.title
    && existing.plan === plan
  ) return state;

  const nextTab: DynamicWorkbenchTab = {
    type: "orchestration_plan",
    orchestration_plan_id: plan.orchestration_plan_id,
    orchestration_revision_id: plan.revision.orchestration_revision_id,
    title: plan.revision.title,
    plan,
  };
  const existingId = dynamicWorkbenchTabId(existing);
  return {
    ...state,
    activeDynamicTabId: state.activeDynamicTabId === existingId
      ? dynamicWorkbenchTabId(nextTab)
      : state.activeDynamicTabId,
    dynamicTabs: state.dynamicTabs.map((item) => item === existing ? nextTab : item),
  };
}

export function openWorkspaceFileWorkbenchTab(state: RightPanelState, path: string): RightPanelState {
  const existingByPath = state.dynamicTabs.find(
    (item): item is WorkspaceFileWorkbenchTab => isWorkspaceFileWorkbenchTab(item) && item.path === path,
  );
  if (existingByPath) {
    return { ...state, tab: "dynamic", activeDynamicTabId: dynamicWorkbenchTabId(existingByPath) };
  }

  const activeTab = state.dynamicTabs.find((item) => dynamicWorkbenchTabId(item) === state.activeDynamicTabId);
  const workspaceFileTabs = state.dynamicTabs.filter(isWorkspaceFileWorkbenchTab);
  const secondaryWorkspaceFileTabs = workspaceFileTabs.filter((item) => !isPrimaryWorkspaceFileTab(item));

  if (state.tab === "files") {
    if (!state.activeWorkspaceFilePath) {
      return {
        ...state,
        tab: "files",
        activeDynamicTabId: null,
        activeWorkspaceFilePath: path,
      };
    }
    if (secondaryWorkspaceFileTabs.length === 0) {
      return openDynamicWorkbenchTab(state, normalizeWorkspaceFileTab({ path, tabId: path }));
    }
    return {
      ...state,
      activeWorkspaceFilePath: path,
    };
  }

  if (activeTab?.type === "workspace_file_preview") {
    const updatedTab = normalizeWorkspaceFileTab({ ...activeTab, path, tabId: path });
    const activeId = dynamicWorkbenchTabId(activeTab);
    return {
      ...state,
      tab: "dynamic",
      activeDynamicTabId: dynamicWorkbenchTabId(updatedTab),
      dynamicTabs: state.dynamicTabs.map((item) =>
        dynamicWorkbenchTabId(item) === activeId ? updatedTab : item
      ),
    };
  }

  if (!state.activeWorkspaceFilePath) {
    return {
      ...state,
      tab: "files",
      activeDynamicTabId: null,
      activeWorkspaceFilePath: path,
    };
  }

  if (secondaryWorkspaceFileTabs.length === 0) {
    return openDynamicWorkbenchTab(state, normalizeWorkspaceFileTab({ path, tabId: path }));
  }

  const tabToReplace = secondaryWorkspaceFileTabs.at(-1)!;
  const replacedId = dynamicWorkbenchTabId(tabToReplace);
  const tab = normalizeWorkspaceFileTab({ path, tabId: path });
  return {
    ...state,
    tab: "dynamic",
    activeDynamicTabId: dynamicWorkbenchTabId(tab),
    dynamicTabs: state.dynamicTabs.map((item) => dynamicWorkbenchTabId(item) === replacedId ? tab : item),
  };
}

export function closeDynamicWorkbenchTab(state: RightPanelState, tabId: string): RightPanelState {
  const dynamicTabs = state.dynamicTabs.filter((tab) => dynamicWorkbenchTabId(tab) !== tabId);
  if (state.activeDynamicTabId !== tabId) return { ...state, dynamicTabs };
  const nextActive = dynamicTabs.at(-1);
  return {
    ...state,
    dynamicTabs,
    activeDynamicTabId: nextActive ? dynamicWorkbenchTabId(nextActive) : null,
    tab: nextActive ? "dynamic" : state.tab === "dynamic" ? "overview" : state.tab,
  };
}

export function hasWorkbenchContent(input: {
  tasks: unknown[];
  planRevisions: unknown[];
  artifacts: unknown[];
}) {
  return input.tasks.length > 0 || input.planRevisions.length > 0 || input.artifacts.length > 0;
}

export function expertChatTabFromDispatchEvent(
  message: unknown,
): Extract<DynamicWorkbenchTab, { type: "expert_chat" }> | null {
  if (!message || typeof message !== "object") return null;
  const envelope = message as Record<string, unknown>;
  if (envelope.type !== "agent_session:event") return null;
  const data = envelope.data;
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  if (payload.event && payload.event !== "created" && payload.event !== "updated") return null;

  const agentSessionId = typeof payload.agent_session_id === "string" ? payload.agent_session_id : "";
  const agentRunId = typeof payload.active_agent_run_id === "string"
    ? payload.active_agent_run_id
    : typeof payload.latest_agent_run_id === "string" ? payload.latest_agent_run_id : null;
  const role = typeof payload.role === "string" ? payload.role : "";
  if (!agentSessionId || role === "leader") return null;

  return {
    type: "expert_chat",
    agent_session_id: agentSessionId,
    agent_run_id: agentRunId,
    title:
      typeof payload.display_name === "string" && payload.display_name.trim()
        ? payload.display_name
        : "Expert",
  };
}

export function deriveLeaderAgentRunId(
  dashboardLeaderAgentRunId: string | null,
): string | null {
  return dashboardLeaderAgentRunId;
}

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFlowStore } from "../stores/useFlowStore";
import { useProjectStore } from "../stores/useProjectStore";
import type { Project, SquadFlow } from "../types";
import Layout from "./Layout";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const navigationState = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("./TopBar", () => ({
  default: ({ activeTitle }: { activeTitle: string }) => <div data-testid="top-bar">{activeTitle}</div>,
}));

vi.mock("./Sidebar", () => ({
  default: ({ onNewTask }: { onNewTask: () => void }) => (
    <button type="button" onClick={onNewTask}>新建流程</button>
  ),
}));

vi.mock("./NewTaskView", () => ({
  default: () => <div data-testid="new-task-view">新建任务内容</div>,
}));

vi.mock("./workbench/LeaderChatPanel", () => ({
  default: () => <div data-testid="leader-chat-panel">等待风险确认</div>,
}));

vi.mock("./workbench/FlowSidePanel", () => ({
  default: () => <div data-testid="flow-side-panel" />,
}));

vi.mock("./NewFlowModal", () => ({ default: () => null }));
vi.mock("./DeleteFlowModal", () => ({ default: () => null }));
vi.mock("./ClearAllFlowsModal", () => ({ default: () => null }));
vi.mock("./AbortFlowModal", () => ({ default: () => null }));
vi.mock("./AppSettingsDialog", () => ({ default: () => null }));

vi.mock("../hooks/useDashboardData", () => ({
  useDashboardData: (flowId: string | null) => ({
    flowStatus: "waiting_user",
    flowStateLoadedFlowId: flowId,
    leaderAgentRunId: "leader-1",
    leaderTranscriptReadyFlowId: flowId,
    leaderTranscriptReadyAgentRunId: "leader-1",
    decisionRequests: flowId ? [{ decision_request_id: "permission-1", status: "pending", questions: [] }] : [],
    planCards: {},
    orchestrationPlans: [],
    riskMode: "auto_edit",
    orchestrationMode: "approval_required",
    agentRuns: [],
  }),
}));

vi.mock("../hooks/useFlowWorkbench", () => ({
  useFlowWorkbench: () => ({
    workbench: {
      reviews: [],
      files: { root_path: null, tree_available: false },
    },
  }),
}));

vi.mock("../hooks/useAgentSessions", () => ({
  useAgentRuns: () => ({ agentRuns: [] }),
}));

vi.mock("../stores/useThemeStore", () => ({
  initTheme: vi.fn(),
  useThemeStore: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../stores/useAppPreferencesStore", () => ({ initAppPreferences: vi.fn() }));
vi.mock("../stores/useBrowserSelectionStore", () => ({
  installDesktopBrowserSelectionListener: vi.fn(),
  useBrowserSelectionStore: (selector: (state: { setActiveFlowId: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setActiveFlowId: vi.fn() }),
}));
vi.mock("../stores/useComposerImageStore", () => ({
  useComposerImageStore: (selector: (state: { setActiveFlowId: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setActiveFlowId: vi.fn() }),
}));
vi.mock("../stores/useOrchestrationFeedbackStore", () => ({
  useOrchestrationFeedbackStore: (selector: (state: { setActiveFlowId: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setActiveFlowId: vi.fn() }),
}));

vi.mock("../lib/ws", () => ({
  wsClient: {
    connect: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    sendClientDiagnostic: vi.fn(),
  },
}));

const flow: SquadFlow = {
  id: "flow-waiting",
  name: "等待确认的 Flow",
  description: "",
  type: "full",
  status: "active",
  project_id: "project-1",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

const project: Project = {
  id: "project-1",
  name: "测试项目",
  local_path: "/tmp/test-project",
  description: "",
  is_default: false,
};

describe("Layout new Flow navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    navigationState.search = "";
    router.replace.mockClear();
    useFlowStore.setState({
      flows: [flow],
      selectedFlowId: flow.id,
      selectedFlow: null,
      hydrateSelectedFlowId: vi.fn(),
      clearSelectedFlow: () => useFlowStore.setState({ selectedFlowId: null, selectedFlow: null }),
      refreshFlows: vi.fn().mockResolvedValue(undefined),
    });
    useProjectStore.setState({
      projects: [project],
      init: vi.fn().mockResolvedValue(undefined),
      refreshProjects: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("unmounts a waiting Flow and any switching overlay before showing the new Flow composer", async () => {
    const user = userEvent.setup();
    render(<Layout />);

    expect(screen.getByTestId("workbench-shell")).toBeVisible();
    expect(screen.getByTestId("leader-chat-panel")).toHaveTextContent("等待风险确认");

    await user.click(screen.getByRole("button", { name: "新建流程" }));

    await waitFor(() => {
      expect(screen.getByTestId("new-task-view")).toBeVisible();
      expect(screen.queryByTestId("workbench-shell")).not.toBeInTheDocument();
      expect(screen.queryByTestId("flow-switch-loading-overlay")).not.toBeInTheDocument();
      expect(screen.queryByTestId("flow-side-panel")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("top-bar")).toHaveTextContent("新建流程");
    expect(useFlowStore.getState().selectedFlowId).toBeNull();
  });

  it("does not let a pending deep link reopen an old Flow after the user starts a new Flow", async () => {
    const user = userEvent.setup();
    navigationState.search = "flow=flow-delayed";
    let resolveFlow!: (response: { ok: boolean; json: () => Promise<SquadFlow> }) => void;
    const pendingFlow = new Promise<{ ok: boolean; json: () => Promise<SquadFlow> }>((resolve) => {
      resolveFlow = resolve;
    });
    const fetchMock = vi.fn(() => pendingFlow);
    vi.stubGlobal("fetch", fetchMock);

    render(<Layout />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/flows/flow-delayed"));
    await user.click(screen.getByRole("button", { name: "新建流程" }));
    expect(screen.getByTestId("new-task-view")).toBeVisible();

    resolveFlow({
      ok: true,
      json: async () => ({
        ...flow,
        id: "flow-delayed",
        name: "延迟深链接 Flow",
      }),
    });
    await pendingFlow;
    await Promise.resolve();

    expect(screen.getByTestId("new-task-view")).toBeVisible();
    expect(useFlowStore.getState().selectedFlowId).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/", { scroll: false });
  });
});

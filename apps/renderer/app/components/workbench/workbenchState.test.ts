import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../hooks/useFlowExperts";
import {
  closeDynamicWorkbenchTab,
  createInitialRightPanelState,
  deriveLeaderAgentSessionId,
  expertChatTabFromDispatchEvent,
  hasWorkbenchContent,
  openBrowserWorkbenchTab,
  openDynamicWorkbenchTab,
  openOrchestrationPlanWorkbenchTab,
  openReviewWorkbenchTab,
  openWorkspaceFileWorkbenchTab,
  openWorkspaceFilesWorkbenchTab,
  parseRightPanelState,
  rightPanelStorageKey,
  serializeRightPanelState,
  syncOrchestrationPlanWorkbenchTab,
} from "./workbenchState";
import { orchestrationPlanFixture } from "../orchestration/orchestrationTestFixture";

function agentSession(id: string, expertId: string): AgentSession {
  return {
    id,
    flow_id: "flow-1",
    task_id: null,
    expert_id: expertId,
    session_id: null,
    display_name: expertId,
    work_run_id: "utn-1",
    status: "idle",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("workbenchState", () => {
  it("starts the right workbench on the overview tab with no dynamic tabs", () => {
    expect(createInitialRightPanelState()).toEqual({
      tab: "overview",
      dynamicTabs: [],
      activeDynamicTabId: null,
      activeWorkspaceFilePath: null,
      collapsedSections: { team: false, artifacts: false, tasks: false },
      isMaximized: false,
    });
  });

  it("prefers dashboard leader id when it belongs to current run sessions and is exp-leader", () => {
    const sessions = [agentSession("worker-1", "exp-worker"), agentSession("leader-1", "exp-leader")];
    expect(deriveLeaderAgentSessionId("leader-1", sessions)).toBe("leader-1");
  });

  it("keeps the dashboard leader id while agent sessions are still loading", () => {
    expect(deriveLeaderAgentSessionId("leader-1", [])).toBe("leader-1");
  });

  it("falls back to the exp-leader session when dashboard leader id is absent", () => {
    const sessions = [agentSession("worker-1", "exp-worker"), agentSession("leader-1", "exp-leader")];
    expect(deriveLeaderAgentSessionId(null, sessions)).toBe("leader-1");
  });

  it("does not use worker session as center Leader chat when dashboard id points to a worker", () => {
    const sessions = [agentSession("worker-1", "exp-worker"), agentSession("leader-1", "exp-leader")];
    expect(deriveLeaderAgentSessionId("worker-1", sessions)).toBe("leader-1");
  });

  it("detects when workbench content exists", () => {
    expect(hasWorkbenchContent({ tasks: [], specRevisions: [], artifacts: [] })).toBe(false);
    expect(hasWorkbenchContent({ tasks: [{}], specRevisions: [], artifacts: [] })).toBe(true);
    expect(hasWorkbenchContent({ tasks: [], specRevisions: [{}], artifacts: [] })).toBe(true);
    expect(hasWorkbenchContent({ tasks: [], specRevisions: [], artifacts: [{}] })).toBe(true);
  });

  it("creates an expert chat tab from a Flow Expert event", () => {
    expect(expertChatTabFromDispatchEvent({
      type: "flow_expert:event",
      flow_id: "flow-1",
      data: {
        event: "updated",
        flow_expert_id: "fexp-frontend",
        agent_session_id: "ags-1",
        expert_id: "exp-frontend",
        display_name: "Frontend",
      },
    })).toEqual({
      type: "expert_chat",
      flow_expert_id: "fexp-frontend",
      agent_session_id: "ags-1",
      title: "Frontend",
    });
  });

  it("ignores leader and events without stable Flow Expert identity", () => {
    expect(expertChatTabFromDispatchEvent({
      type: "flow_expert:event",
      data: {
        event: "created",
        flow_expert_id: "fexp-leader",
        expert_id: "exp-leader",
      },
    })).toBeNull();
    expect(expertChatTabFromDispatchEvent({
      type: "session:event",
      data: {
        agent_session_id: "ags-1",
        expert_id: "exp-frontend",
        status: "completed",
      },
    })).toBeNull();
  });

  it("keys expert_chat tabs by flow_expert_id", () => {
    const next = openDynamicWorkbenchTab(createInitialRightPanelState(), {
      type: "expert_chat",
      flow_expert_id: "fexp-frontend",
      agent_session_id: "ags-runtime-1",
      title: "Frontend",
    });
    expect(next.activeDynamicTabId).toBe("expert_chat:fexp-frontend");
  });

  it("creates one tab for multiple dispatch events for the same Flow Expert", () => {
    let state = createInitialRightPanelState();
    const first = expertChatTabFromDispatchEvent({
      type: "flow_expert:event",
      flow_id: "flow-1",
      data: {
        event: "updated",
        flow_expert_id: "fexp-frontend",
        agent_session_id: "ags-1",
        expert_id: "exp-frontend",
        display_name: "Frontend",
      },
    })!;
    const second = expertChatTabFromDispatchEvent({
      type: "flow_expert:event",
      flow_id: "flow-1",
      data: {
        event: "updated",
        flow_expert_id: "fexp-frontend",
        agent_session_id: "ags-2",
        expert_id: "exp-frontend",
        display_name: "Frontend",
      },
    })!;
    state = openDynamicWorkbenchTab(state, first);
    state = openDynamicWorkbenchTab(state, second);
    expect(state.dynamicTabs).toHaveLength(1);
    expect(state.activeDynamicTabId).toBe("expert_chat:fexp-frontend");
  });

  it("closes dynamic tabs without removing the fixed overview tab", () => {
    let state = openDynamicWorkbenchTab(createInitialRightPanelState(), {
      type: "spec_preview",
      spec_revision_id: "spec-1",
      title: "Hello.md",
    });
    state = closeDynamicWorkbenchTab(state, "spec_preview:spec-1");
    expect(state.dynamicTabs).toEqual([]);
    expect(state.tab).toBe("overview");
  });

  it("opens the fixed workspace files tab", () => {
    const state = openWorkspaceFilesWorkbenchTab(createInitialRightPanelState());

    expect(state.tab).toBe("files");
    expect(state.activeDynamicTabId).toBeNull();
    expect(state.activeWorkspaceFilePath).toBeNull();
    expect(state.dynamicTabs).toEqual([]);
  });

  it("sets the current file inside the fixed files tab", () => {
    let state = openWorkspaceFilesWorkbenchTab(createInitialRightPanelState());
    state = openWorkspaceFileWorkbenchTab(state, ".gitignore");

    expect(state.tab).toBe("files");
    expect(state.activeDynamicTabId).toBeNull();
    expect(state.activeWorkspaceFilePath).toBe(".gitignore");
    expect(state.dynamicTabs).toEqual([]);
  });

  it("opens a second file tab after the fixed file tab already has a file", () => {
    let state = openWorkspaceFilesWorkbenchTab(createInitialRightPanelState());
    state = openWorkspaceFileWorkbenchTab(state, ".gitignore");
    state = openWorkspaceFileWorkbenchTab(state, "AGENTS.md");

    expect(state.tab).toBe("dynamic");
    expect(state.activeDynamicTabId).toBe("workspace_file_preview:AGENTS.md");
    expect(state.activeWorkspaceFilePath).toBe(".gitignore");
    expect(state.dynamicTabs.filter((tab) => tab.type === "workspace_file_preview")).toEqual([
      { type: "workspace_file_preview", path: "AGENTS.md", title: "AGENTS.md", tabId: "AGENTS.md" },
    ]);
  });

  it("updates the active second file tab when selecting a new file", () => {
    let state = openWorkspaceFilesWorkbenchTab(createInitialRightPanelState());
    state = openWorkspaceFileWorkbenchTab(state, ".gitignore");
    state = { ...state, tab: "overview", activeDynamicTabId: null };
    state = openWorkspaceFileWorkbenchTab(state, "AGENTS.md");
    state = openWorkspaceFileWorkbenchTab(state, "README.md");

    expect(state.tab).toBe("dynamic");
    expect(state.activeDynamicTabId).toBe("workspace_file_preview:README.md");
    expect(state.activeWorkspaceFilePath).toBe(".gitignore");
    expect(state.dynamicTabs.filter((tab) => tab.type === "workspace_file_preview")).toEqual([
      { type: "workspace_file_preview", path: "README.md", title: "README.md", tabId: "README.md" },
    ]);
  });

  it("updates the fixed file tab when it is active and a second file tab exists", () => {
    let state = openWorkspaceFileWorkbenchTab(createInitialRightPanelState(), "src/one.ts");
    state = { ...state, tab: "overview", activeDynamicTabId: null };
    state = openWorkspaceFileWorkbenchTab(state, "src/two.ts");
    state = { ...state, tab: "files", activeDynamicTabId: null };
    state = openWorkspaceFileWorkbenchTab(state, "src/four.ts");

    expect(state.tab).toBe("files");
    expect(state.activeWorkspaceFilePath).toBe("src/four.ts");
    expect(state.dynamicTabs.filter((tab) => tab.type === "workspace_file_preview")).toEqual([
      { type: "workspace_file_preview", path: "src/two.ts", title: "two.ts", tabId: "src/two.ts" },
    ]);
  });

  it("activates an existing file tab instead of replacing another tab", () => {
    let state = openWorkspaceFilesWorkbenchTab(createInitialRightPanelState());
    state = openWorkspaceFileWorkbenchTab(state, "src/one.ts");
    state = openWorkspaceFileWorkbenchTab(state, "src/two.ts");
    state = openWorkspaceFileWorkbenchTab(state, "src/three.ts");
    state = { ...state, tab: "files", activeDynamicTabId: null };
    state = openWorkspaceFileWorkbenchTab(state, "src/four.ts");
    state = openWorkspaceFileWorkbenchTab(state, "src/three.ts");

    expect(state.tab).toBe("dynamic");
    expect(state.activeDynamicTabId).toBe("workspace_file_preview:src/three.ts");
    expect(state.activeWorkspaceFilePath).toBe("src/four.ts");
    expect(state.dynamicTabs.filter((tab) => tab.type === "workspace_file_preview")).toEqual([
      { type: "workspace_file_preview", path: "src/three.ts", title: "three.ts", tabId: "src/three.ts" },
    ]);
  });

  it("opens one browser dynamic tab and reuses it", () => {
    let state = openBrowserWorkbenchTab(createInitialRightPanelState());
    state = openBrowserWorkbenchTab(state);

    expect(state.tab).toBe("dynamic");
    expect(state.activeDynamicTabId).toBe("browser");
    expect(state.dynamicTabs).toEqual([{ type: "browser", title: "浏览器" }]);
  });

  it("opens one review dynamic tab and reuses it", () => {
    let state = openReviewWorkbenchTab(createInitialRightPanelState(), "wrun-history");
    expect(state.dynamicTabs).toEqual([{ type: "review", title: "审核", work_run_id: "wrun-history" }]);
    state = openReviewWorkbenchTab(state);

    expect(state.tab).toBe("dynamic");
    expect(state.activeDynamicTabId).toBe("review");
    expect(state.dynamicTabs).toEqual([{ type: "review", title: "审核" }]);
  });

  it("migrates the legacy fixed review tab to a dynamic review tab", () => {
    const restored = parseRightPanelState(JSON.stringify({
      isOpen: true,
      state: {
        ...createInitialRightPanelState(),
        tab: "review",
      },
    }));

    expect(restored?.state.tab).toBe("dynamic");
    expect(restored?.state.activeDynamicTabId).toBe("review");
    expect(restored?.state.dynamicTabs).toEqual([{ type: "review", title: "审核" }]);
  });

  it("reuses one plan tab when another orchestration plan is opened", () => {
    const first = orchestrationPlanFixture;
    const second = {
      ...orchestrationPlanFixture,
      plan_id: "plan-2",
      revision: {
        ...orchestrationPlanFixture.revision,
        plan_revision_id: "revision-plan-2",
        title: "第二份计划",
      },
    };
    let state = openOrchestrationPlanWorkbenchTab(createInitialRightPanelState(), first);
    state = openOrchestrationPlanWorkbenchTab(state, second);

    expect(state.dynamicTabs.filter((tab) => tab.type === "orchestration_plan")).toEqual([
      expect.objectContaining({ plan_id: "plan-2", plan_revision_id: "revision-plan-2", title: "第二份计划" }),
    ]);
    expect(state.activeDynamicTabId).toBe("orchestration_plan:revision-plan-2");
  });

  it("moves an open plan tab to a newly submitted revision of the same plan", () => {
    const revisionTwo = {
      ...orchestrationPlanFixture,
      revision: {
        ...orchestrationPlanFixture.revision,
        plan_revision_id: "revision-2",
        revision_number: 2,
        title: "成员邀请编排计划 v2",
      },
    };
    const state = openOrchestrationPlanWorkbenchTab(createInitialRightPanelState(), orchestrationPlanFixture);
    const next = syncOrchestrationPlanWorkbenchTab(state, revisionTwo);

    expect(next.activeDynamicTabId).toBe("orchestration_plan:revision-2");
    expect(next.dynamicTabs).toEqual([
      expect.objectContaining({ plan_revision_id: "revision-2", title: "成员邀请编排计划 v2" }),
    ]);
  });

  it("restores legacy persisted state with only the active plan tab", () => {
    const restored = parseRightPanelState(JSON.stringify({
      isOpen: true,
      autoFollowAgentDispatch: true,
      state: {
        tab: "dynamic",
        activeDynamicTabId: "orchestration_plan:revision-2",
        activeWorkspaceFilePath: null,
        collapsedSections: { team: false, artifacts: false, tasks: false },
        isMaximized: false,
        dynamicTabs: [
          {
            type: "orchestration_plan",
            plan_revision_id: "revision-1",
            title: "计划 v1",
          },
          {
            type: "orchestration_plan",
            plan_revision_id: "revision-2",
            title: "计划 v2",
          },
        ],
      },
    }));

    expect(restored?.state.activeDynamicTabId).toBe("orchestration_plan:revision-2");
    expect(restored?.state.dynamicTabs).toEqual([
      expect.objectContaining({ plan_revision_id: "revision-2", title: "计划 v2" }),
    ]);
  });

  it("serializes and restores Flow Expert tabs", () => {
    const raw = serializeRightPanelState({
      isOpen: true,
      autoFollowAgentDispatch: false,
      state: {
        tab: "dynamic",
        dynamicTabs: [
          { type: "expert_chat", flow_expert_id: "fexp-research", agent_session_id: "ags-1", title: "Research" },
          { type: "spec_preview", spec_revision_id: "spec-1", title: "Hello.md" },
        ],
        activeDynamicTabId: "expert_chat:fexp-research",
        activeWorkspaceFilePath: null,
        collapsedSections: { team: true, artifacts: false, tasks: true },
        isMaximized: false,
      },
    });
    expect(parseRightPanelState(raw)?.state.dynamicTabs).toEqual([
      { type: "expert_chat", flow_expert_id: "fexp-research", agent_session_id: "ags-1", title: "Research" },
      { type: "spec_preview", spec_revision_id: "spec-1", title: "Hello.md" },
    ]);
  });

  it("migrates legacy primary workspace file tab to the fixed files tab and keeps the second file tab", () => {
    const parsed = parseRightPanelState(JSON.stringify({
      isOpen: true,
      autoFollowAgentDispatch: true,
      state: {
        tab: "dynamic",
        activeDynamicTabId: "workspace_file_preview:open-file",
        dynamicTabs: [
          { type: "workspace_file_preview", path: "src/Design.css", title: "Design.css", tabId: "open-file" },
          { type: "workspace_file_preview", path: "README.md", title: "README.md", tabId: "README.md" },
          { type: "browser", title: "浏览器" },
        ],
        collapsedSections: {},
        isMaximized: false,
      },
    }));

    expect(parsed?.state.tab).toBe("files");
    expect(parsed?.state.activeWorkspaceFilePath).toBe("src/Design.css");
    expect(parsed?.state.activeDynamicTabId).toBeNull();
    expect(parsed?.state.dynamicTabs).toEqual([
      { type: "workspace_file_preview", path: "README.md", title: "README.md", tabId: "README.md" },
      { type: "browser", title: "浏览器" },
    ]);
  });

  it("drops legacy expert tabs that lack flow_expert_id", () => {
    const parsed = parseRightPanelState(JSON.stringify({
      isOpen: true,
      autoFollowAgentDispatch: true,
      state: {
        tab: "dynamic",
        activeDynamicTabId: "expert_chat:ags-old",
        dynamicTabs: [{ type: "expert_chat", agent_session_id: "ags-old", title: "Frontend 2482" }],
        collapsedSections: {},
        isMaximized: false,
      },
    }));
    expect(parsed?.state.dynamicTabs).toEqual([]);
    expect(parsed?.state.tab).toBe("overview");
  });

  it("restores legacy closed sessions as manually collapsed", () => {
    const restored = parseRightPanelState(JSON.stringify({
      isOpen: false,
      state: createInitialRightPanelState(),
    }));
    expect(restored?.autoFollowAgentDispatch).toBe(false);
  });

  it("builds a stable right panel storage key per flow", () => {
    expect(rightPanelStorageKey("flow-1")).toBe("squadflow-right-panel-state:flow-1");
  });
});

import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { wsClient } from "../lib/ws";
import { useDashboardData } from "./useDashboardData";

vi.mock("../lib/ws", () => {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  return {
    wsClient: {
      sendFlowSubscribe: vi.fn(),
      sendFlowUnsubscribe: vi.fn(),
      onEvent: vi.fn((type: string, handler: (message: unknown) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(handler);
        return () => handlers.get(type)?.delete(handler);
      }),
      __emit(type: string, message: unknown) {
        for (const handler of handlers.get(type) ?? []) handler(message);
      },
    },
  };
});

describe("useDashboardData WorkRun model", () => {
  it("registers Flow listeners before requesting the initial snapshot", () => {
    const client = wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void };
    vi.mocked(wsClient.sendFlowSubscribe).mockImplementationOnce((flowId) => {
      client.__emit("flow:state", {
        type: "flow:state",
        flow_id: flowId,
        data: {
          status: "active",
          orchestration_plan_history: [{ revision: { plan_revision_id: "prev-1" } }],
          work_runs: [],
          tasks: [],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });

    const { result } = renderHook(() => useDashboardData("flow-1"));

    expect(result.current.isFlowStateLoaded).toBe(true);
    expect(result.current.orchestrationPlans).toHaveLength(1);
  });

  it("hydrates WorkRuns and flat tasks without phases", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-1",
        data: {
          status: "active",
          current_work_run_id: "utn-1",
          leader_session_id: "leader-sdk",
          latest_leader_agent_session_id: "ags-leader",
          active_leader_agent_session_id: "ags-leader",
          work_runs: [{
            id: "utn-1",
            work_run_id: "utn-1",
            trigger_message_id: "msg-1",
            status: "executing",
            started_at: "2026-01-01T00:00:00.000Z",
            active_started_at: "2026-01-01T00:00:00.000Z",
            active_duration_ms: 0,
            completed_at: null,
          }],
          tasks: [{
            id: "task-1",
            work_run_id: "utn-1",
            title: "Build",
            description: "Build",
            status: "pending",
            expert_id: "exp-frontend",
            depends_on_task_ids: [],
          }],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });

    expect(result.current.activeWorkRunId).toBe("utn-1");
    expect(result.current.isFlowStateLoaded).toBe(true);
    expect(result.current.flowStateLoadedFlowId).toBe("flow-1");
    expect(result.current.workRuns).toHaveLength(1);
    expect(result.current.tasks[0]?.title).toBe("Build");
    expect(result.current).not.toHaveProperty("phases");
    expect(result.current).not.toHaveProperty("runs");
  });

  it("tracks independent Flow modes, legacy Spec marker, and spec cards from flow:state", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-1",
        data: {
          status: "ready",
          risk_mode: "full_access",
          plan_approval: "off",
          legacy_spec_flow: true,
          pending_spec_approval: {
            spec_approval_id: "sca-1",
            spec_revision_id: "spec-1",
            status: "pending",
            file_name: "Hello_World_abcd.md",
            overview: "Create page.",
            actions: ["run"],
          },
          work_runs: [],
          tasks: [],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });

    expect(result.current.riskMode).toBe("full_access");
    expect(result.current.planApproval).toBe("off");
    expect(result.current.legacySpecFlow).toBe(true);
    expect(result.current.specCards["sca-1"]).toEqual(expect.objectContaining({
      spec_approval_id: "sca-1",
      status: "pending",
    }));
  });

  it("does not expose Flow agent mode state", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));
    expect(result.current).not.toHaveProperty("agentMode");
    expect(result.current).not.toHaveProperty("agentModeLocked");
  });

  it("upserts multiple Tasks in one WorkRun without losing prior task fields", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));
    const emit = (data: Record<string, unknown>) => act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("task:event", {
        type: "task:event",
        flow_id: "flow-1",
        data,
      });
    });

    emit({ task: { task_id: "task-1", work_run_id: "utn-1", subject: "Build", description: "Build", status: "pending" } });
    emit({ task: { task_id: "task-2", work_run_id: "utn-1", subject: "Verify", description: "Verify", status: "pending" } });
    emit({ task_id: "task-1", work_run_id: "utn-1", status: "failed", error_message: "failed" });

    expect(result.current.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "task-1", work_run_id: "utn-1", title: "Build", status: "failed" }),
      expect.objectContaining({ id: "task-2", work_run_id: "utn-1", title: "Verify", status: "pending" }),
    ]));
  });

  it("clears the previous Flow WorkRun and Tasks when switching Flows", () => {
    const { result, rerender } = renderHook(({ flowId }) => useDashboardData(flowId), {
      initialProps: { flowId: "flow-1" as string | null },
    });
    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-1",
        data: {
          status: "active",
          risk_mode: "full_access",
          plan_approval: "off",
          current_work_run_id: "utn-1",
          work_runs: [{ id: "utn-1", trigger_message_id: "msg-1", status: "executing" }],
          tasks: [{ id: "task-1", work_run_id: "utn-1", title: "Build", status: "pending" }],
        },
      });
    });
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.riskMode).toBe("full_access");
    expect(result.current.planApproval).toBe("off");

    rerender({ flowId: "flow-2" });

    expect(result.current.activeWorkRunId).toBeNull();
    expect(result.current.tasks).toEqual([]);
    expect(result.current.workRuns).toEqual([]);
    expect(result.current.riskMode).toBe("auto_edit");
    expect(result.current.planApproval).toBe("on");

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-2",
        data: {
          status: "ready",
          risk_mode: "auto_edit",
          plan_approval: "on",
          work_runs: [],
          tasks: [],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });
    expect(result.current.riskMode).toBe("auto_edit");
    expect(result.current.planApproval).toBe("on");
  });

  it("never exposes the previous Flow leader session during a switch", () => {
    const rendered: Array<{ flowId: string | null; leaderAgentSessionId: string | null }> = [];
    function Probe({ flowId }: { flowId: string | null }) {
      const dashboard = useDashboardData(flowId);
      rendered.push({ flowId, leaderAgentSessionId: dashboard.leaderAgentSessionId });
      return null;
    }

    const { rerender } = render(<Probe flowId="flow-1" />);
    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-1",
        data: {
          status: "ready",
          latest_leader_agent_session_id: "ags-flow-1",
          work_runs: [],
          tasks: [],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });

    rerender(<Probe flowId="flow-2" />);

    expect(rendered.filter((item) => item.flowId === "flow-2")).not.toContainEqual({
      flowId: "flow-2",
      leaderAgentSessionId: "ags-flow-1",
    });
  });

  it("tracks leader transcript readiness from the leader snapshot", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));

    expect(result.current.isFlowStateLoaded).toBe(false);
    expect(result.current.flowStateLoadedFlowId).toBeNull();
    expect(result.current.leaderTranscriptReadyFlowId).toBeNull();
    expect(result.current.leaderTranscriptReadyAgentSessionId).toBeNull();

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:state", {
        type: "flow:state",
        flow_id: "flow-1",
        data: {
          status: "ready",
          leader_session_id: "leader-sdk",
          latest_leader_agent_session_id: "ags-leader",
          active_leader_agent_session_id: null,
          work_runs: [],
          tasks: [],
          agent_sessions: [],
          spec_revisions: [],
          decision_cards: [],
          artifacts: [],
          recent_events: [],
        },
      });
    });

    expect(result.current.isFlowStateLoaded).toBe(true);
    expect(result.current.flowStateLoadedFlowId).toBe("flow-1");
    expect(result.current.leaderAgentSessionId).toBe("ags-leader");
    expect(result.current.leaderTranscriptReadyFlowId).toBeNull();
    expect(result.current.leaderTranscriptReadyAgentSessionId).toBeNull();

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("session:transcript_snapshot", {
        type: "session:transcript_snapshot",
        flow_id: "flow-1",
        agent_session_id: "ags-expert",
        flow_expert_id: "fexp-1",
        data: { cursor: 1, messages: [] },
      });
    });

    expect(result.current.leaderTranscriptReadyAgentSessionId).toBeNull();
    expect(result.current.leaderTranscriptReadyFlowId).toBeNull();

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("session:transcript_snapshot", {
        type: "session:transcript_snapshot",
        flow_id: "flow-1",
        agent_session_id: "ags-leader",
        data: { cursor: 1, messages: [] },
      });
    });

    expect(result.current.leaderTranscriptReadyFlowId).toBe("flow-1");
    expect(result.current.leaderTranscriptReadyAgentSessionId).toBe("ags-leader");
  });

  it("resolves a spec card to cancelled", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:spec_card", {
        type: "flow:spec_card",
        flow_id: "flow-1",
        data: {
          spec_approval_id: "sca-1",
          spec_revision_id: "spec-1",
          status: "pending",
          file_name: "Hello_World_abcd.md",
          overview: "Create page.",
          actions: ["run"],
        },
      });
    });

    act(() => {
      (wsClient as typeof wsClient & { __emit: (type: string, message: unknown) => void }).__emit("flow:spec_card_resolved", {
        type: "flow:spec_card_resolved",
        flow_id: "flow-1",
        data: { spec_approval_id: "sca-1", status: "cancelled" },
      });
    });

    expect(result.current.specCards["sca-1"]?.status).toBe("cancelled");
  });

  it("updates a running orchestration plan to cancelled", () => {
    const { result } = renderHook(() => useDashboardData("flow-1"));
    const emit = (type: string, message: unknown) => act(() => {
      (wsClient as typeof wsClient & { __emit: (eventType: string, event: unknown) => void }).__emit(type, message);
    });

    emit("plan:event", {
      type: "plan:event",
      flow_id: "flow-1",
      data: {
        plan_id: "plan-1",
        flow_id: "flow-1",
        work_run_id: "turn-1",
        revision: { plan_revision_id: "revision-1" },
        run: { plan_run_id: "run-1", status: "running" },
        nodes: [],
        feedback: [],
      },
    });
    emit("plan_run:event", {
      type: "plan_run:event",
      flow_id: "flow-1",
      data: { plan_run_id: "run-1", plan_revision_id: "revision-1", status: "cancelled" },
    });

    expect(result.current.orchestrationPlans[0]?.run).toEqual({ plan_run_id: "run-1", status: "cancelled" });
  });
});

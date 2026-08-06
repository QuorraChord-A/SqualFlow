import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SquadFlow } from "../types";

const wsMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(msg: unknown) => void>>();
  return {
    handlers,
    wsClient: {
      send: vi.fn(),
      sendFlowSubscribe: vi.fn(),
      sendFlowUnsubscribe: vi.fn(),
      onEvent: vi.fn((type: string, handler: (msg: unknown) => void) => {
        const current = handlers.get(type) ?? [];
        handlers.set(type, [...current, handler]);
        return () => {};
      }),
    },
  };
});

vi.mock("../lib/ws", () => ({
  wsClient: wsMock.wsClient,
}));

import { readStoredSelectedFlowId, useFlowStore, writeStoredSelectedFlowId } from "./useFlowStore";

const flow: SquadFlow = {
  id: "flow-1",
  name: "Flow",
  description: "",
  type: "full",
  status: "active",
  current_stage: "clarify",
  project_id: "project-1",
  created_at: "2026-06-12T00:00:00.000Z",
  updated_at: "2026-06-12T00:00:00.000Z",
  is_pinned: false,
  has_pending_decision: false,
};

function emit(type: string, msg: unknown) {
  for (const handler of wsMock.handlers.get(type) ?? []) {
    handler(msg);
  }
}

describe("useFlowStore streaming state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ has_unread_messages: false }),
    })));
    wsMock.wsClient.send.mockClear();
    wsMock.wsClient.sendFlowSubscribe.mockClear();
    wsMock.wsClient.sendFlowUnsubscribe.mockClear();
    window.localStorage.clear();
    useFlowStore.setState({
      flows: [flow],
      selectedFlowId: null,
      selectedFlow: null,
      pendingApproval: false,
    });
  });

  afterEach(() => {
    emit("work_run:event", {
      type: "work_run:event",
      flow_id: "flow-1",
      data: { flow_status: "idle", status: "completed" },
    });
    vi.runOnlyPendingTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("marks a flow as streaming while any session is producing output", () => {
    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      data: { cursor: 1, event: { type: "turn-started", messageId: "msg-1" } },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(true);
  });

  it("keeps streaming during a long output pause", () => {
    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "agent-session-1",
      data: { cursor: 1, event: { type: "text-delta", messageId: "msg-1", id: "text-1", delta: "hello" } },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(true);

    vi.advanceTimersByTime(3_000);

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(true);
  });

  it("clears streaming after a long missing-finish timeout", () => {
    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "agent-session-1",
      data: { cursor: 1, event: { type: "text-delta", messageId: "msg-1", id: "text-1", delta: "hello" } },
    });

    vi.advanceTimersByTime(61_000);

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
  });

  it("keeps a background subscription while a flow is streaming", () => {
    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "agent-session-1",
      data: { cursor: 1, event: { type: "turn-started", messageId: "msg-1" } },
    });

    expect(wsMock.wsClient.sendFlowSubscribe).toHaveBeenCalledWith("flow-1");

    useFlowStore.getState().handleSelectFlow({ ...flow, id: "flow-2" });
    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "agent-session-1",
      data: { cursor: 2, event: { type: "turn-finished", messageId: "msg-1", durationMs: 1000, finishedAt: "2026-06-24T10:00:01.000Z" } },
    });

    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(true);
    expect(wsMock.wsClient.sendFlowUnsubscribe).toHaveBeenCalledWith("flow-1");
  });

  it("clears streaming when the session finishes", () => {
    useFlowStore.setState({ flows: [{ ...flow, is_streaming: true }] });

    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      data: { cursor: 1, event: { type: "turn-finished", messageId: "msg-1", durationMs: 1000, finishedAt: "2026-06-24T10:00:01.000Z" } },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
  });

  it("clears streaming when the session is interrupted", () => {
    useFlowStore.setState({ flows: [{ ...flow, is_streaming: true }] });

    emit("session:event", {
      type: "session:event",
      flow_id: "flow-1",
      data: { agent_session_id: "agent-session-1", status: "interrupted" },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
  });

  it("marks a background flow unread when session output completes", () => {
    useFlowStore.setState({ flows: [flow], selectedFlowId: null });

    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      data: { cursor: 1, event: { type: "turn-finished", messageId: "msg-1", durationMs: 1000, finishedAt: "2026-06-24T10:00:01.000Z" } },
    });

    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(true);
  });

  it("does not mark the current flow unread when session output completes", () => {
    useFlowStore.setState({ flows: [flow], selectedFlowId: "flow-1" });

    emit("session:transcript_event", {
      type: "session:transcript_event",
      flow_id: "flow-1",
      data: { cursor: 1, event: { type: "turn-finished", messageId: "msg-1", durationMs: 1000, finishedAt: "2026-06-24T10:00:01.000Z" } },
    });

    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(false);
    expect(fetch).toHaveBeenCalledWith("/api/flows/flow-1/read", { method: "POST" });
  });

  it("marks a flow as streaming while context compaction is running", () => {
    emit("context_compaction:event", {
      type: "context_compaction:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "leader-session-1",
        status: "running",
      },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(true);
    expect(wsMock.wsClient.sendFlowSubscribe).toHaveBeenCalledWith("flow-1");
  });

  it("marks a background flow unread when context compaction completes", () => {
    useFlowStore.setState({ flows: [flow], selectedFlowId: null });

    emit("context_compaction:event", {
      type: "context_compaction:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "leader-session-1",
        status: "running",
      },
    });
    emit("context_compaction:event", {
      type: "context_compaction:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "leader-session-1",
        status: "completed",
      },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(true);
    expect(wsMock.wsClient.sendFlowUnsubscribe).toHaveBeenCalledWith("flow-1");
  });

  it("does not mark the current flow unread when context compaction completes", () => {
    useFlowStore.setState({ flows: [flow], selectedFlowId: "flow-1" });

    emit("context_compaction:event", {
      type: "context_compaction:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "leader-session-1",
        status: "running",
      },
    });
    emit("context_compaction:event", {
      type: "context_compaction:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "leader-session-1",
        status: "completed",
      },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(false);
    expect(fetch).toHaveBeenCalledWith("/api/flows/flow-1/read", { method: "POST" });
  });

  it("marks a flow read when the user selects it", () => {
    useFlowStore.setState({
      flows: [{ ...flow, has_unread_messages: true }],
      selectedFlowId: "old-flow",
      selectedFlow: { ...flow, id: "old-flow", stages: [], messages: [], tasks: [], agent_outputs: [] },
    });

    useFlowStore.getState().handleSelectFlow(flow);

    expect(useFlowStore.getState().selectedFlowId).toBe("flow-1");
    expect(useFlowStore.getState().selectedFlow).toBeNull();
    expect(useFlowStore.getState().flows[0].has_unread_messages).toBe(false);
    expect(readStoredSelectedFlowId()).toBe("flow-1");
    expect(fetch).toHaveBeenCalledWith("/api/flows/flow-1/read", { method: "POST" });
    expect(fetch).not.toHaveBeenCalledWith("/api/flows/flow-1");
  });

  it("persists and clears the selected flow id in local storage", () => {
    writeStoredSelectedFlowId("flow-1");
    expect(readStoredSelectedFlowId()).toBe("flow-1");

    writeStoredSelectedFlowId(null);
    expect(readStoredSelectedFlowId()).toBeNull();
  });

  it("hydrates the selected flow id from local storage after mount", () => {
    writeStoredSelectedFlowId("flow-1");

    useFlowStore.getState().hydrateSelectedFlowId();

    expect(useFlowStore.getState().selectedFlowId).toBe("flow-1");
  });

  it("keeps the selected flow leader model binding when flow state omits runtime fields", () => {
    useFlowStore.setState({
      flows: [{
        ...flow,
        leader_runtime_config_id: "runtime-config-1",
        leader_runtime_model_id: "model-x2",
      }],
      selectedFlowId: "flow-1",
      selectedFlow: null,
    });

    emit("flow:state", {
      type: "flow:state",
      flow_id: "flow-1",
      data: {
        name: "Flow",
        description: "",
        type: "full",
        status: "active",
        current_stage: "clarify",
        project_id: "project-1",
        created_at: "2026-06-12T00:00:00.000Z",
        updated_at: "2026-06-12T00:00:00.000Z",
        is_pinned: false,
        has_pending_decision: false,
      },
    });

    expect(useFlowStore.getState().selectedFlow).toMatchObject({
      id: "flow-1",
      leader_runtime_config_id: "runtime-config-1",
      leader_runtime_model_id: "model-x2",
    });
  });

  it("synchronizes the sidebar summary from the authoritative flow state snapshot", () => {
    useFlowStore.setState({
      flows: [{ ...flow, status: "active", current_stage: "develop" }],
      selectedFlowId: "flow-1",
      selectedFlow: null,
    });

    emit("flow:state", {
      type: "flow:state",
      flow_id: "flow-1",
      data: {
        name: "Updated Flow",
        type: "full",
        status: "idle",
        current_stage: null,
        project_id: "project-1",
        created_at: "2026-06-12T00:00:00.000Z",
        updated_at: "2026-06-12T00:01:00.000Z",
        is_pinned: false,
        has_pending_decision: false,
        has_active_execution: false,
      },
    });

    expect(useFlowStore.getState().flows[0]).toMatchObject({
      id: "flow-1",
      name: "Updated Flow",
      status: "idle",
      current_stage: null,
      has_active_execution: false,
    });
    expect(useFlowStore.getState().selectedFlow).toMatchObject({
      id: "flow-1",
      status: "idle",
      current_stage: null,
    });
  });

  it("clears streaming when the flow starts waiting for a decision card", () => {
    useFlowStore.setState({ flows: [{ ...flow, is_streaming: true }] });

    emit("flow:decision_card", {
      type: "flow:decision_card",
      flow_id: "flow-1",
      data: { card_id: "card-1" },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(false);
    expect(useFlowStore.getState().flows[0].has_pending_decision).toBe(true);
  });

  it("does not clear streaming when an individual Task fails", () => {
    useFlowStore.setState({ flows: [{ ...flow, is_streaming: true }] });

    emit("task:event", {
      type: "task:event",
      flow_id: "flow-1",
      data: { task_id: "task-1", work_run_id: "utn-1", status: "failed" },
    });

    expect(useFlowStore.getState().flows[0].is_streaming).toBe(true);
  });

  it("does not derive Flow runtime state from WorkRun events", () => {
    useFlowStore.setState({ flows: [{ ...flow, status: "idle", is_streaming: true }] });

    emit("work_run:event", {
      type: "work_run:event",
      flow_id: "flow-1",
      data: { status: "interrupted" },
    });

    expect(useFlowStore.getState().flows[0]).toMatchObject({
      status: "idle",
      is_streaming: true,
    });
  });
});

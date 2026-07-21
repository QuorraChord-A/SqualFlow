'use client';

import { create } from 'zustand';
import type { SquadFlow, FlowDetail, FlowType } from '../types';
import { API_BASE } from '../lib/api';
import { mapLegacyStage } from '../utils/stage';
import { wsClient } from '../lib/ws';

export const SELECTED_FLOW_STORAGE_KEY = "squadflow-selected-flow-id";

export function readStoredSelectedFlowId() {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(SELECTED_FLOW_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredSelectedFlowId(flowId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (flowId) {
      localStorage.setItem(SELECTED_FLOW_STORAGE_KEY, flowId);
    } else {
      localStorage.removeItem(SELECTED_FLOW_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures and keep the in-memory selection.
  }
}

function logFlowRequestFailure(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[flow-store] ${scope}: ${message}`);
}

interface FlowState {
  flows: SquadFlow[];
  selectedFlowId: string | null;
  selectedFlow: FlowDetail | null;
  pendingApproval: boolean;

  hydrateSelectedFlowId: () => void;
  clearSelectedFlow: () => void;
  handleSelectFlow: (flow: SquadFlow) => void;
  refreshFlowDetail: (flowId: string, stage?: string) => Promise<void>;
  handleAbort: (flowId: string) => Promise<void>;
  handleCreateFlow: (data: {
    name: string;
    type: FlowType;
    mode: 'create' | 'edit';
    leader_runtime_config_id?: string | null;
    leader_runtime_model_id?: string | null;
    leader_runtime_reasoning_effort?: string | null;
    risk_mode?: 'auto_edit' | 'full_access';
    plan_approval?: 'on' | 'off';
  }, projectId: string) => Promise<SquadFlow | null>;
  handleSaveEdit: (data: { name: string; type: FlowType; mode: 'create' | 'edit' }, editingFlowId?: string) => Promise<void>;
  handleConfirmDelete: (flowId: string) => Promise<void>;
  confirmClearAllFlows: () => Promise<void>;
  refreshFlows: (projectId?: string) => Promise<void>;
  updateFlowProject: (flowId: string, projectId: string | null) => Promise<SquadFlow | null>;
  setFlowPinned: (flowId: string, isPinned: boolean) => Promise<void>;
}

type FlowDetailResponse = Partial<FlowDetail> & Pick<SquadFlow, "id" | "name" | "type" | "status">;

export const useFlowStore = create<FlowState>((set, get) => ({
  flows: [],
  selectedFlowId: null,
  selectedFlow: null,
  pendingApproval: false,

  hydrateSelectedFlowId: () => {
    const storedFlowId = readStoredSelectedFlowId();
    if (!storedFlowId || storedFlowId === get().selectedFlowId) return;
    set({ selectedFlowId: storedFlowId });
  },

  clearSelectedFlow: () => {
    set({ selectedFlowId: null, selectedFlow: null });
    writeStoredSelectedFlowId(null);
  },

  handleSelectFlow: (flow: SquadFlow) => {
    set({ selectedFlowId: flow.id, selectedFlow: null });
    writeStoredSelectedFlowId(flow.id);
    markFlowReadLocally(flow.id);
    void markFlowReadRemote(flow.id);
    // Flow detail comes from flow:state WS event — no REST fetch needed
  },

  refreshFlowDetail: async (flowId: string, stage?: string) => {
    try {
      const stageParam = stage ? `?stage=${encodeURIComponent(stage)}` : '';
      const res = await fetch(`${API_BASE}/api/flows/${flowId}${stageParam}`);
      if (res.ok) {
        const data = await res.json() as FlowDetailResponse;
        set({
          selectedFlow: mapFlowDetailResponse(data),
        });
      }
    } catch (error) {
      logFlowRequestFailure("failed to refresh flow detail", error);
    }
  },


  handleAbort: async (flowId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/flows/${flowId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        get().refreshFlows();
        get().refreshFlowDetail(flowId);
      }
    } catch (error) {
      logFlowRequestFailure("failed to abort flow", error);
    }
  },

  handleCreateFlow: async (data: {
    name: string;
    type: FlowType;
    mode: 'create' | 'edit';
    leader_runtime_config_id?: string | null;
    leader_runtime_model_id?: string | null;
    leader_runtime_reasoning_effort?: string | null;
    risk_mode?: 'auto_edit' | 'full_access';
    plan_approval?: 'on' | 'off';
  }, projectId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          flow_type: data.type,
          project_id: projectId,
          leader_runtime_config_id: data.leader_runtime_config_id,
          leader_runtime_model_id: data.leader_runtime_model_id,
          leader_runtime_reasoning_effort: data.leader_runtime_reasoning_effort,
          risk_mode: data.risk_mode,
          plan_approval: data.plan_approval,
        }),
      });
      if (!res.ok) return null;
      const newFlow = await res.json() as SquadFlow;
      await get().refreshFlows();
      get().handleSelectFlow(newFlow);
      return newFlow;
    } catch (error) {
      logFlowRequestFailure("failed to create flow", error);
      return null;
    }
  },

  handleSaveEdit: async (data: { name: string; type: FlowType; mode: 'create' | 'edit' }, editingFlowId?: string) => {
    if (!editingFlowId) return;
    try {
      const res = await fetch(`${API_BASE}/api/flows/${editingFlowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name }),
      });
      if (res.ok) {
        get().refreshFlows();
        if (get().selectedFlowId === editingFlowId) get().refreshFlowDetail(editingFlowId);
      }
    } catch (error) {
      logFlowRequestFailure("failed to save flow", error);
    }
  },

  handleConfirmDelete: async (flowId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/flows/${flowId}`, { method: 'DELETE' });
      if (res.ok) {
        if (get().selectedFlowId === flowId) {
          set({ selectedFlowId: null, selectedFlow: null });
          writeStoredSelectedFlowId(null);
        }
        get().refreshFlows();
      }
    } catch (error) {
      logFlowRequestFailure("failed to delete flow", error);
    }
  },

  confirmClearAllFlows: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/flows`, { method: 'DELETE' });
      if (res.ok) {
        set({ selectedFlowId: null, selectedFlow: null });
        writeStoredSelectedFlowId(null);
        get().refreshFlows();
      }
    } catch (error) {
      logFlowRequestFailure("failed to clear flows", error);
    }
  },

  refreshFlows: async (projectId?: string) => {
    try {
      const projectParam = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
      const res = await fetch(`${API_BASE}/api/flows${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        set({
          flows: data.map((flow: SquadFlow) => ({
            ...flow,
            is_streaming: streamingSessionKeysByFlow.has(flow.id),
          })),
        });
      }
    } catch (error) {
      logFlowRequestFailure("failed to refresh flows", error);
    }
  },

  updateFlowProject: async (flowId: string, projectId: string | null) => {
    try {
      const res = await fetch(`${API_BASE}/api/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!res.ok) return null;
      const updated = await res.json();
      set((state) => ({
        flows: state.flows.map((flow) =>
          flow.id === flowId ? { ...flow, project_id: updated.project_id ?? null } : flow
        ),
        selectedFlow: state.selectedFlow?.id === flowId
          ? { ...state.selectedFlow, project_id: updated.project_id ?? null }
          : state.selectedFlow,
      }));
      return updated;
    } catch {
      return null;
    }
  },

  setFlowPinned: async (flowId: string, isPinned: boolean) => {
    const res = await fetch(`${API_BASE}/api/flows/${flowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_pinned: isPinned }),
    });
    if (!res.ok) return;
    const updated = await res.json();
    set((state) => ({
      flows: state.flows.map((flow) =>
        flow.id === flowId
          ? { ...flow, is_pinned: updated.is_pinned, updated_at: updated.updated_at }
          : flow
      ),
      selectedFlow: state.selectedFlow?.id === flowId
        ? { ...state.selectedFlow, is_pinned: updated.is_pinned, updated_at: updated.updated_at }
        : state.selectedFlow,
    }));
  },
}));

function mapFlowDetailResponse(data: FlowDetailResponse): FlowDetail {
  return {
    id: data.id,
    name: data.name,
    name_generation_status: data.name_generation_status ?? 'generated',
    type: data.type,
    status: data.status,
    current_stage: mapLegacyStage(data.current_stage),
    project_id: data.project_id ?? null,
    leader_runtime_sdk: data.leader_runtime_sdk ?? null,
    leader_runtime_config_id: data.leader_runtime_config_id ?? null,
    leader_runtime_model_id: data.leader_runtime_model_id ?? null,
    leader_runtime_reasoning_effort: data.leader_runtime_reasoning_effort ?? null,
    legacy_spec_flow: Boolean(data.legacy_spec_flow),
    risk_mode: data.risk_mode === 'full_access' ? 'full_access' : 'auto_edit',
    plan_approval: data.plan_approval === 'off' ? 'off' : 'on',
    created_at: data.created_at || '',
    updated_at: data.updated_at || data.created_at || '',
    is_pinned: data.is_pinned,
    has_pending_decision: data.has_pending_decision,
    stages: data.stages || [],
    messages: data.messages || [],
    tasks: [],
    agent_outputs: [],
    leader_session_id: data.leader_session_id || null,
    context_usage: data.context_usage || null,
    context_bus: data.context_bus || {},
  };
}

const STREAMING_IDLE_TIMEOUT_MS = 60_000;
const streamingSessionKeysByFlow = new Map<string, Set<string>>();
const streamingTimersBySession = new Map<string, ReturnType<typeof setTimeout>>();
const backgroundStreamingSubscriptions = new Set<string>();

function streamingSessionKey(msg: { session_id?: string; agent_session_id?: string; flow_expert_id?: string }) {
  return msg.agent_session_id || msg.flow_expert_id || msg.session_id || "__unknown_session__";
}

function streamingTimerKey(flowId: string, sessionKey: string) {
  return `${flowId}:${sessionKey}`;
}

function setFlowStreaming(flowId: string, isStreaming: boolean) {
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) =>
      flow.id === flowId ? { ...flow, is_streaming: isStreaming } : flow
    ),
    selectedFlow: state.selectedFlow?.id === flowId
      ? { ...state.selectedFlow, is_streaming: isStreaming }
      : state.selectedFlow,
  }));
}

function markFlowReadLocally(flowId: string) {
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) =>
      flow.id === flowId ? { ...flow, has_unread_messages: false } : flow
    ),
    selectedFlow: state.selectedFlow?.id === flowId
      ? { ...state.selectedFlow, has_unread_messages: false }
      : state.selectedFlow,
  }));
}

async function markFlowReadRemote(flowId: string) {
  try {
    await fetch(`${API_BASE}/api/flows/${flowId}/read`, { method: "POST" });
  } catch (error) {
    logFlowRequestFailure("failed to mark flow read", error);
  }
}

function handleOutputCompleted(flowId: string) {
  const { selectedFlowId } = useFlowStore.getState();
  if (selectedFlowId === flowId) {
    markFlowReadLocally(flowId);
    void markFlowReadRemote(flowId);
    return;
  }

  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) =>
      flow.id === flowId ? { ...flow, has_unread_messages: true } : flow
    ),
    selectedFlow: state.selectedFlow?.id === flowId
      ? { ...state.selectedFlow, has_unread_messages: false }
      : state.selectedFlow,
  }));
}

function clearStreamingTimer(flowId: string, sessionKey: string) {
  const timerKey = streamingTimerKey(flowId, sessionKey);
  const timer = streamingTimersBySession.get(timerKey);
  if (timer) clearTimeout(timer);
  streamingTimersBySession.delete(timerKey);
}

function clearStreamingSession(flowId: string, sessionKey: string) {
  clearStreamingTimer(flowId, sessionKey);
  const current = streamingSessionKeysByFlow.get(flowId);
  if (!current) {
    setFlowStreaming(flowId, false);
    return;
  }
  current.delete(sessionKey);
  if (current.size === 0) {
    streamingSessionKeysByFlow.delete(flowId);
    releaseBackgroundStreamingSubscription(flowId);
    setFlowStreaming(flowId, false);
    return;
  }
  streamingSessionKeysByFlow.set(flowId, current);
  setFlowStreaming(flowId, true);
}

function clearFlowStreaming(flowId: string) {
  const current = streamingSessionKeysByFlow.get(flowId);
  if (current) {
    for (const sessionKey of current) {
      clearStreamingTimer(flowId, sessionKey);
    }
  }
  streamingSessionKeysByFlow.delete(flowId);
  releaseBackgroundStreamingSubscription(flowId);
  setFlowStreaming(flowId, false);
}

function markStreamingSession(flowId: string, sessionKey: string) {
  ensureBackgroundStreamingSubscription(flowId);
  const current = streamingSessionKeysByFlow.get(flowId) ?? new Set<string>();
  current.add(sessionKey);
  streamingSessionKeysByFlow.set(flowId, current);
  setFlowStreaming(flowId, true);

  clearStreamingTimer(flowId, sessionKey);
  const timerKey = streamingTimerKey(flowId, sessionKey);
  const timer = setTimeout(() => {
    clearStreamingSession(flowId, sessionKey);
  }, STREAMING_IDLE_TIMEOUT_MS);
  streamingTimersBySession.set(timerKey, timer);
}

function markPersistentStreamingSession(flowId: string, sessionKey: string) {
  ensureBackgroundStreamingSubscription(flowId);
  const current = streamingSessionKeysByFlow.get(flowId) ?? new Set<string>();
  current.add(sessionKey);
  streamingSessionKeysByFlow.set(flowId, current);
  clearStreamingTimer(flowId, sessionKey);
  setFlowStreaming(flowId, true);
}

function ensureBackgroundStreamingSubscription(flowId: string) {
  if (backgroundStreamingSubscriptions.has(flowId)) return;
  backgroundStreamingSubscriptions.add(flowId);
  wsClient.sendFlowSubscribe(flowId);
}

function releaseBackgroundStreamingSubscription(flowId: string) {
  if (!backgroundStreamingSubscriptions.delete(flowId)) return;
  wsClient.sendFlowUnsubscribe(flowId);
}

function updateFlowStreamingFromSessionEvent(msg: {
  flow_id: string;
  session_id?: string;
  agent_session_id?: string;
  flow_expert_id?: string;
  data?: { event?: { type?: string } };
}) {
  const eventType = msg.data?.event?.type;
  if (!eventType) return;

  const key = streamingSessionKey(msg);
  if (eventType === "turn-finished") {
    clearStreamingSession(msg.flow_id, key);
    handleOutputCompleted(msg.flow_id);
    return;
  }

  markStreamingSession(msg.flow_id, key);
}

function contextCompactionSessionKey(data: unknown) {
  const value = data && typeof data === "object" ? data as {
    agent_session_id?: string;
    flow_expert_id?: string | null;
    sdk_session_id?: string | null;
  } : {};
  return `context-compaction:${value.agent_session_id || value.flow_expert_id || value.sdk_session_id || "__unknown_session__"}`;
}

// Listen for flow:state WS event to populate selectedFlow without REST
wsClient.onEvent("flow:state", (msg) => {
  const { flows, selectedFlowId, selectedFlow } = useFlowStore.getState();
  if (msg.flow_id !== selectedFlowId) return;
  const data = msg.data;
  const flowSummary = flows.find((flow) => flow.id === msg.flow_id);
  const currentSelectedFlow = selectedFlow?.id === msg.flow_id ? selectedFlow : null;
  const leaderRuntimeConfigId = data.leader_runtime_config_id
    ?? currentSelectedFlow?.leader_runtime_config_id
    ?? flowSummary?.leader_runtime_config_id
    ?? null;
  const leaderRuntimeModelId = data.leader_runtime_model_id
    ?? currentSelectedFlow?.leader_runtime_model_id
    ?? flowSummary?.leader_runtime_model_id
    ?? null;
  const leaderRuntimeSdk = data.leader_runtime_sdk
    ?? currentSelectedFlow?.leader_runtime_sdk
    ?? flowSummary?.leader_runtime_sdk
    ?? null;
  const leaderRuntimeReasoningEffort = data.leader_runtime_reasoning_effort
    ?? currentSelectedFlow?.leader_runtime_reasoning_effort
    ?? flowSummary?.leader_runtime_reasoning_effort
    ?? null;
  useFlowStore.setState({
    selectedFlow: {
      id: msg.flow_id,
      name: data.name || '',
      name_generation_status: data.name_generation_status ?? 'generated',
      type: data.type || 'full',
      status: data.status,
      current_stage: mapLegacyStage(data.current_stage || null),
      project_id: data.project_id ?? null,
      // Project is the top-level local directory.
      created_at: data.created_at || '',
      updated_at: data.updated_at || '',
      is_pinned: data.is_pinned,
      has_pending_decision: data.has_pending_decision,
      is_streaming: streamingSessionKeysByFlow.has(msg.flow_id),
      stages: [],
      messages: [],
      tasks: [],
      agent_outputs: [],
      leader_session_id: data.leader_session_id || null,
      leader_runtime_sdk: leaderRuntimeSdk,
      leader_runtime_config_id: leaderRuntimeConfigId,
      leader_runtime_model_id: leaderRuntimeModelId,
      leader_runtime_reasoning_effort: leaderRuntimeReasoningEffort,
      context_usage: data.context_usage || null,
      context_bus: data.context_bus || {},
    },
  });
});

function updateFlowRuntimeStatus(flowId: string, status: string, currentStage?: string | null) {
  const mappedStage = mapLegacyStage(currentStage || null);
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) =>
      flow.id === flowId
        ? { ...flow, status: status as SquadFlow["status"], current_stage: mappedStage }
        : flow
    ),
    selectedFlow: state.selectedFlow?.id === flowId
      ? { ...state.selectedFlow, status: status as SquadFlow["status"], current_stage: mappedStage }
      : state.selectedFlow,
  }));
}

wsClient.onEvent("flow:status", (msg) => {
  updateFlowRuntimeStatus(msg.flow_id, msg.data?.status || "ready");
});

wsClient.onEvent("flow:name_updated", (msg) => {
  const status = msg.data.name_generation_status as SquadFlow["name_generation_status"];
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) => flow.id === msg.flow_id
      ? { ...flow, name: msg.data.name as string, name_generation_status: status }
      : flow),
    selectedFlow: state.selectedFlow?.id === msg.flow_id
      ? { ...state.selectedFlow, name: msg.data.name as string, name_generation_status: status } as FlowDetail
      : state.selectedFlow,
  }));
});

wsClient.onEvent("user_turn:event", (msg) => {
  if (["completed", "failed", "cancelled"].includes(msg.data?.status)) {
    clearFlowStreaming(msg.flow_id);
  }
  updateFlowRuntimeStatus(msg.flow_id, msg.data?.flow_status || "active");
});

wsClient.onEvent("session:event", (msg) => {
  const status = msg.data?.status;
  const sessionKey = msg.data?.agent_session_id || "__unknown_session__";
  if (status === "streaming") {
    markStreamingSession(msg.flow_id, sessionKey);
    return;
  }
  if (status === "interrupted") {
    clearStreamingSession(msg.flow_id, sessionKey);
    return;
  }
  if (status === "completed" || status === "failed") {
    clearStreamingSession(msg.flow_id, sessionKey);
    handleOutputCompleted(msg.flow_id);
  }
});

wsClient.onEvent("session:transcript_event", (msg) => {
  updateFlowStreamingFromSessionEvent(msg);
});

wsClient.onEvent("context_compaction:event", (msg) => {
  const status = msg.data?.status;
  const sessionKey = contextCompactionSessionKey(msg.data);
  if (status === "running") {
    markPersistentStreamingSession(msg.flow_id, sessionKey);
    return;
  }
  clearStreamingSession(msg.flow_id, sessionKey);
  if (status === "completed") handleOutputCompleted(msg.flow_id);
});

wsClient.onEvent("flow:decision_card", (msg) => {
  clearFlowStreaming(msg.flow_id);
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) =>
      flow.id === msg.flow_id ? { ...flow, has_pending_decision: true } : flow
    ),
  }));
});

wsClient.onEvent("flow:decision_card_resolved", async (msg) => {
  try {
    const res = await fetch(`${API_BASE}/api/flows/${msg.flow_id}`);
    if (!res.ok) return;
    const updated = await res.json();
    useFlowStore.setState((state) => ({
      flows: state.flows.map((flow) =>
        flow.id === msg.flow_id
          ? { ...flow, has_pending_decision: updated.has_pending_decision }
          : flow
      ),
    }));
  } catch {
    // The next flow refresh will reconcile the indicator.
  }
});

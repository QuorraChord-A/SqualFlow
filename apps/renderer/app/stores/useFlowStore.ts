"use client";

import { create } from "zustand";
import type {
  BehaviorMode,
  FlowDetail,
  FlowType,
  OrchestrationMode,
  RiskMode,
  SquadFlow,
} from "../types";
import { API_BASE } from "../lib/api";
import { wsClient } from "../lib/ws";

export const SELECTED_FLOW_STORAGE_KEY = "squadflow-selected-flow-id";

export function readStoredSelectedFlowId() {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(SELECTED_FLOW_STORAGE_KEY); } catch { return null; }
}

export function writeStoredSelectedFlowId(flowId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (flowId) localStorage.setItem(SELECTED_FLOW_STORAGE_KEY, flowId);
    else localStorage.removeItem(SELECTED_FLOW_STORAGE_KEY);
  } catch { /* in-memory selection remains authoritative */ }
}

async function parseFlow(response: Response): Promise<SquadFlow | null> {
  if (!response.ok) return null;
  return response.json() as Promise<SquadFlow>;
}

function asFlowDetail(flow: SquadFlow): FlowDetail {
  return { ...flow };
}

const backgroundSubscriptions = new Set<string>();
function syncBackgroundSubscriptions(flows: SquadFlow[]) {
  const next = new Set(flows.map((flow) => flow.id));
  for (const flowId of backgroundSubscriptions) {
    if (!next.has(flowId)) {
      wsClient.sendFlowUnsubscribe(flowId);
      backgroundSubscriptions.delete(flowId);
    }
  }
  for (const flowId of next) {
    if (backgroundSubscriptions.has(flowId)) continue;
    backgroundSubscriptions.add(flowId);
    wsClient.sendFlowSubscribe(flowId);
  }
}

interface FlowState {
  flows: SquadFlow[];
  selectedFlowId: string | null;
  selectedFlow: FlowDetail | null;
  hydrateSelectedFlowId: () => void;
  clearSelectedFlow: () => void;
  handleSelectFlow: (flow: SquadFlow) => void;
  refreshFlowDetail: (flowId: string) => Promise<void>;
  handleAbort: (flowId: string) => Promise<void>;
  handleCreateFlow: (data: {
    name: string;
    type: FlowType;
    mode: "create" | "edit";
    leader_runtime_config_id?: string | null;
    leader_runtime_model_id?: string | null;
    leader_runtime_reasoning_effort?: string | null;
    behavior_mode?: BehaviorMode;
    risk_mode?: RiskMode;
    orchestration_mode?: OrchestrationMode;
  }, projectId: string) => Promise<SquadFlow | null>;
  handleSaveEdit: (data: { name: string; type: FlowType; mode: "create" | "edit" }, editingFlowId?: string) => Promise<void>;
  handleConfirmDelete: (flowId: string) => Promise<void>;
  confirmClearAllFlows: () => Promise<void>;
  refreshFlows: (projectId?: string) => Promise<void>;
  updateFlowProject: (flowId: string, projectId: string | null) => Promise<SquadFlow | null>;
  setFlowPinned: (flowId: string, isPinned: boolean) => Promise<void>;
}

function replaceFlow(state: FlowState, updated: SquadFlow) {
  return {
    flows: state.flows.some((flow) => flow.id === updated.id)
      ? state.flows.map((flow) => flow.id === updated.id ? { ...flow, ...updated } : flow)
      : [...state.flows, updated],
    selectedFlow: state.selectedFlowId === updated.id
      ? { ...state.selectedFlow, ...updated } as FlowDetail
      : state.selectedFlow,
  };
}

export const useFlowStore = create<FlowState>((set, get) => ({
  flows: [],
  selectedFlowId: null,
  selectedFlow: null,

  hydrateSelectedFlowId: () => {
    const stored = readStoredSelectedFlowId();
    if (stored && stored !== get().selectedFlowId) set({ selectedFlowId: stored });
  },

  clearSelectedFlow: () => {
    set({ selectedFlowId: null, selectedFlow: null });
    writeStoredSelectedFlowId(null);
  },

  handleSelectFlow: (flow) => {
    set({ selectedFlowId: flow.id, selectedFlow: asFlowDetail({ ...flow, has_unread_output: false, indicator: flow.has_pending_user_action ? "pending" : flow.has_active_agent_run ? "active" : "idle" }) });
    writeStoredSelectedFlowId(flow.id);
    set((state) => ({ flows: state.flows.map((item) => item.id === flow.id ? { ...item, has_unread_output: false, indicator: item.has_pending_user_action ? "pending" : item.has_active_agent_run ? "active" : "idle" } : item) }));
    void fetch(`${API_BASE}/api/flows/${encodeURIComponent(flow.id)}/read`, { method: "POST" });
  },

  refreshFlowDetail: async (flowId) => {
    try {
      const flow = await parseFlow(await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`));
      if (flow) set((state) => replaceFlow(state, flow));
    } catch { /* WebSocket snapshot will reconcile */ }
  },

  handleAbort: async (flowId) => {
    wsClient.send({
      type: "flow:interrupt",
      flow_id: flowId,
      client_action_id: `flow-interrupt-${Date.now()}`,
    });
  },

  handleCreateFlow: async (data, projectId) => {
    try {
      const flow = await parseFlow(await fetch(`${API_BASE}/api/flows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          project_id: projectId,
          leader_runtime_config_id: data.leader_runtime_config_id,
          leader_runtime_model_id: data.leader_runtime_model_id,
          leader_runtime_reasoning_effort: data.leader_runtime_reasoning_effort,
          behavior_mode: data.behavior_mode ?? "execute",
          risk_mode: data.risk_mode ?? "auto_edit",
          orchestration_mode: data.orchestration_mode ?? "approval_required",
        }),
      }));
      if (!flow) return null;
      await get().refreshFlows();
      get().handleSelectFlow(flow);
      return flow;
    } catch { return null; }
  },

  handleSaveEdit: async (data, flowId) => {
    if (!flowId) return;
    const flow = await parseFlow(await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.name }),
    }));
    if (flow) set((state) => replaceFlow(state, flow));
  },

  handleConfirmDelete: async (flowId) => {
    const response = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, { method: "DELETE" });
    if (!response.ok) return;
    if (get().selectedFlowId === flowId) get().clearSelectedFlow();
    await get().refreshFlows();
  },

  confirmClearAllFlows: async () => {
    const response = await fetch(`${API_BASE}/api/flows`, { method: "DELETE" });
    if (!response.ok) return;
    get().clearSelectedFlow();
    await get().refreshFlows();
  },

  refreshFlows: async (projectId) => {
    try {
      const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
      const response = await fetch(`${API_BASE}/api/flows${suffix}`);
      if (!response.ok) return;
      const flows = await response.json() as SquadFlow[];
      syncBackgroundSubscriptions(flows);
      set((state) => ({
        flows,
        selectedFlow: state.selectedFlowId && flows.some((flow) => flow.id === state.selectedFlowId)
          ? asFlowDetail(flows.find((flow) => flow.id === state.selectedFlowId)!)
          : state.selectedFlow,
      }));
    } catch { /* keep last durable snapshot */ }
  },

  updateFlowProject: async (flowId, projectId) => {
    if (!projectId) return null;
    const flow = await parseFlow(await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    }));
    if (flow) set((state) => replaceFlow(state, flow));
    return flow;
  },

  setFlowPinned: async (flowId, isPinned) => {
    const flow = await parseFlow(await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_pinned: isPinned }),
    }));
    if (flow) set((state) => replaceFlow(state, flow));
  },
}));

function applyFlowSnapshot(flowId: string, data: Record<string, unknown>) {
  useFlowStore.setState((state) => {
    const existing = state.flows.find((flow) => flow.id === flowId);
    const next = {
      ...existing,
      ...data,
      id: flowId,
      name: typeof data.name === "string" ? data.name : existing?.name ?? "新任务",
      type: "full" as const,
      status: (data.status === "active" ? "active" : data.status === "ready" ? "ready" : "idle") as SquadFlow["status"],
      created_at: typeof data.created_at === "string" ? data.created_at : existing?.created_at ?? "",
      updated_at: typeof data.updated_at === "string" ? data.updated_at : existing?.updated_at ?? "",
    } satisfies SquadFlow;
    return replaceFlow(state, next);
  });
}

wsClient.onEvent("flow:state", (message) => applyFlowSnapshot(message.flow_id, message.data ?? {}));
wsClient.onEvent("flow:name_updated", (message) => {
  useFlowStore.setState((state) => ({
    flows: state.flows.map((flow) => flow.id === message.flow_id ? { ...flow, ...message.data } : flow),
    selectedFlow: state.selectedFlow?.id === message.flow_id ? { ...state.selectedFlow, ...message.data } : state.selectedFlow,
  }));
});

for (const eventName of [
  "agent_run:event",
  "decision_request:event",
  "plan_approval:event",
  "orchestration_approval:event",
  "change_set:event",
] as const) {
  wsClient.onEvent(eventName, (_message) => { void useFlowStore.getState().refreshFlows(); });
}

wsClient.onEvent("session:transcript_event", (message) => {
  const terminal = Array.isArray(message.data?.timeline_items)
    && message.data.timeline_items.some((item: { message_kind?: string }) => item.message_kind === "agent-run-terminal");
  if (terminal) void useFlowStore.getState().refreshFlows();
});

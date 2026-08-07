"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api";
import { wsClient } from "../lib/ws";

export type AgentRunStatus = "queued" | "running" | "waiting_tool_approval" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AgentRun {
  agent_run_id: string;
  flow_id: string;
  agent_session_id: string;
  task_id: string | null;
  trigger_kind: string;
  trigger_message_id: string | null;
  status: AgentRunStatus | string;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AgentSession {
  agent_session_id: string;
  flow_id: string;
  agent_definition_id: string;
  role: "leader" | "expert" | string;
  display_name: string;
  provider_session_id: string | null;
  runtime_sdk: string | null;
  runtime_config_id: string | null;
  runtime_model_id: string | null;
  runtime_reasoning_effort: string | null;
  active_agent_run_id: string | null;
  latest_agent_run_id: string | null;
  status: "active" | "idle" | string;
  created_at: string;
  updated_at: string;
}

function merge<T extends object>(items: T[], incoming: T, key: keyof T) {
  const index = items.findIndex((item) => item[key] === incoming[key]);
  if (index < 0) return [...items, incoming];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...incoming } : item);
}

function useFlowCollection<T extends object>(input: {
  flowId: string | null;
  path: string;
  event: string;
  idKey: keyof T;
}) {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    setItems([]);
    if (!input.flowId) return;
    const flowId = input.flowId;
    let stale = false;
    const load = () => fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}/${input.path}`)
      .then((response) => response.ok ? response.json() as Promise<T[]> : [])
      .then((rows) => { if (!stale) setItems(rows); })
      .catch(() => undefined);
    void load();
    const unsubscribe = wsClient.onEvent(input.event, (message) => {
      if (stale || message.flow_id !== flowId || !message.data) return;
      setItems((current) => merge(current, message.data as T, input.idKey));
    });
    return () => { stale = true; unsubscribe(); };
  }, [input.event, input.flowId, input.idKey, input.path]);
  return items;
}

export function useAgentRuns(flowId: string | null) {
  const agentRuns = useFlowCollection<AgentRun>({ flowId, path: "agent-runs", event: "agent_run:event", idKey: "agent_run_id" });
  return { agentRuns };
}

export function useAgentSessions(flowId: string | null) {
  const agentSessions = useFlowCollection<AgentSession>({ flowId, path: "agent-sessions", event: "agent_session:event", idKey: "agent_session_id" });
  return { agentSessions };
}

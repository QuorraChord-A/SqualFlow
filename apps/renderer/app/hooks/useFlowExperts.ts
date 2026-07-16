"use client";

import { useEffect, useMemo, useState } from "react";
import { wsClient } from "../lib/ws";

export interface AgentSession {
  id: string;
  flow_id: string;
  user_turn_id: string | null;
  task_id: string | null;
  expert_id: string;
  session_id: string | null;
  display_name: string;
  status: "idle" | "streaming" | "completed" | "failed" | string;
  resume_from_agent_session_id?: string;
  created_at?: string;
  updated_at?: string;
}

interface ExpertState {
  flowId: string | null;
  agentSessions: AgentSession[];
}

function mergeAgentSessions(existing: AgentSession[], incoming: AgentSession[]) {
  const byId = new Map(existing.map((session) => [session.id, session]));
  for (const session of incoming) {
    byId.set(session.id, { ...byId.get(session.id), ...session });
  }
  return Array.from(byId.values());
}

function normalizeAgentSessionPayload(msg: {
  flow_id?: string;
  data?: Record<string, unknown>;
}): AgentSession | null {
  const payload = msg.data || {};
  const id = String(payload.id || payload.agent_session_id || "");
  const flowId = String(payload.flow_id || msg.flow_id || "");
  const expertId = String(payload.expert_id || "");
  if (!id || !flowId || !expertId) return null;

  return {
    id,
    flow_id: flowId,
    user_turn_id: typeof payload.user_turn_id === "string" ? payload.user_turn_id : null,
    task_id: typeof payload.task_id === "string" ? payload.task_id : null,
    expert_id: expertId,
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    display_name: String(payload.display_name || expertId),
    status: String(payload.status || "idle"),
    resume_from_agent_session_id: typeof payload.resume_from_agent_session_id === "string"
      ? payload.resume_from_agent_session_id
      : "",
    created_at: typeof payload.created_at === "string" ? payload.created_at : undefined,
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : undefined,
  };
}

export function useAgentSessions(flowId: string | null) {
  const [expertState, setExpertState] = useState<ExpertState>({
    flowId: null,
    agentSessions: [],
  });

  const agentSessions = useMemo(() => {
    if (!flowId) return [];
    if (expertState.flowId !== flowId) return [];
    return expertState.agentSessions;
  }, [expertState, flowId]);

  useEffect(() => {
    if (!flowId) {
      setExpertState({ flowId, agentSessions: [] });
      return;
    }

    let stale = false;
    setExpertState({ flowId, agentSessions: [] });

    void fetch(`/api/flows/${flowId}/agent-sessions`)
      .then(async (response) => response.ok ? response.json() as Promise<AgentSession[]> : [])
      .then((sessions) => {
        if (stale) return;
        setExpertState((prev) =>
          prev.flowId === flowId
            ? {
                flowId,
                agentSessions: mergeAgentSessions(prev.agentSessions, sessions),
              }
            : prev
        );
      })
      .catch(() => undefined);

    const unsubscribe = wsClient.onEvent("session:event", (msg) => {
      if (stale || msg.flow_id !== flowId) return;
      const session = normalizeAgentSessionPayload(msg);
      if (!session) return;
      setExpertState((prev) => {
        if (prev.flowId !== flowId) return prev;
        const existing = prev.agentSessions.find((item) => item.id === session.id);
        if (existing) {
          return {
            ...prev,
            agentSessions: prev.agentSessions.map((item) =>
              item.id === session.id
                ? {
                    ...item,
                    user_turn_id: session.user_turn_id,
                    task_id: session.task_id,
                    expert_id: session.expert_id,
                    status: session.status,
                  }
                : item
            ),
          };
        }
        return {
          flowId,
          agentSessions: mergeAgentSessions(prev.agentSessions, [session]),
        };
      });
    });

    return () => {
      stale = true;
      unsubscribe();
    };
  }, [flowId]);

  return { agentSessions };
}

export interface FlowExpert {
  id: string;
  flow_expert_id: string;
  flow_id: string;
  expert_id: string;
  display_name: string;
  status: "idle" | "queued" | "streaming" | "completed" | "failed" | string;
  agent_session_id: string | null;
  session_id: string | null;
  current_task_id: string | null;
  current_task_title: string | null;
  created_at?: string;
  updated_at?: string;
}

function normalizeFlowExpertPayload(msg: {
  flow_id?: string;
  data?: Record<string, unknown>;
}): FlowExpert | null {
  const payload = msg.data ?? {};
  const flowExpertId = String(payload.flow_expert_id || payload.id || "");
  const flowId = String(payload.flow_id || msg.flow_id || "");
  const expertId = String(payload.expert_id || "");
  if (!flowExpertId || !flowId || !expertId) return null;
  return {
    id: flowExpertId,
    flow_expert_id: flowExpertId,
    flow_id: flowId,
    expert_id: expertId,
    display_name: String(payload.display_name || expertId),
    status: String(payload.status || "idle"),
    agent_session_id: typeof payload.agent_session_id === "string" ? payload.agent_session_id : null,
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    current_task_id: typeof payload.current_task_id === "string" ? payload.current_task_id : null,
    current_task_title: typeof payload.current_task_title === "string" ? payload.current_task_title : null,
    created_at: typeof payload.created_at === "string" ? payload.created_at : undefined,
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : undefined,
  };
}

function mergeFlowExperts(existing: FlowExpert[], incoming: FlowExpert[]) {
  const byId = new Map(existing.map((expert) => [expert.flow_expert_id, expert]));
  for (const expert of incoming) {
    byId.set(expert.flow_expert_id, { ...byId.get(expert.flow_expert_id), ...expert });
  }
  return [...byId.values()];
}

export function useFlowExperts(flowId: string | null) {
  const [flowExperts, setFlowExperts] = useState<FlowExpert[]>([]);

  useEffect(() => {
    if (!flowId) {
      setFlowExperts([]);
      return;
    }
    let stale = false;
    setFlowExperts([]);
    void fetch(`/api/flows/${flowId}/flow-experts`)
      .then((response) => response.ok ? response.json() as Promise<FlowExpert[]> : [])
      .then((experts) => {
        if (!stale) setFlowExperts(mergeFlowExperts([], experts));
      })
      .catch(() => {
        if (!stale) setFlowExperts([]);
      });
    const unsubscribe = wsClient.onEvent("flow_expert:event", (message) => {
      if (stale || message.flow_id !== flowId) return;
      const expert = normalizeFlowExpertPayload(message);
      if (expert) setFlowExperts((current) => mergeFlowExperts(current, [expert]));
    });
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [flowId]);

  return { flowExperts };
}

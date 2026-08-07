"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api";
import { wsClient } from "../lib/ws";
import type { AgentRun } from "./useAgentSessions";
import type { BehaviorMode, OrchestrationMode, RiskMode } from "../types";
import type { OrchestrationPlanView } from "../types/orchestration";

export interface QuestionOption { label: string; description: string }
export interface Question { question: string; header?: string; multiSelect: boolean; options: QuestionOption[] }
export type DecisionAnswer = string | string[];
export type DecisionAnswers = Record<string, DecisionAnswer>;

export interface DecisionRequestCardData {
  decision_request_id: string;
  request_type: "clarification" | "tool_permission";
  questions: Question[];
  status: "pending" | "approved" | "rejected" | "cancelled";
  answers?: DecisionAnswers;
  source_agent_run_id?: string | null;
  tool_name?: string;
  tool_arguments?: Record<string, unknown>;
}

export interface PlanCardState {
  plan_approval_id: string;
  plan_revision_id: string;
  revision_number: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  title: string;
  overview: string;
  content: string;
  feedback?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface DashboardData {
  isFlowStateLoaded: boolean;
  flowStateLoadedFlowId: string | null;
  flowStatus: string;
  behaviorMode: BehaviorMode;
  riskMode: RiskMode;
  orchestrationMode: OrchestrationMode;
  leaderAgentSessionId: string | null;
  leaderAgentRunId: string | null;
  activeLeaderAgentRunId: string | null;
  leaderTranscriptReadyFlowId: string | null;
  leaderTranscriptReadyAgentRunId: string | null;
  decisionRequests: DecisionRequestCardData[];
  planCards: Record<string, PlanCardState>;
  orchestrationPlans: OrchestrationPlanView[];
  agentRuns: AgentRun[];
}

type Snapshot = Record<string, any>;

function normalizeAgentRun(value: Record<string, unknown>): AgentRun | null {
  const id = typeof value.agent_run_id === "string" ? value.agent_run_id : "";
  const flowId = typeof value.flow_id === "string" ? value.flow_id : "";
  const sessionId = typeof value.agent_session_id === "string" ? value.agent_session_id : "";
  if (!id || !flowId || !sessionId) return null;
  return {
    agent_run_id: id,
    flow_id: flowId,
    agent_session_id: sessionId,
    task_id: typeof value.task_id === "string" ? value.task_id : null,
    trigger_kind: typeof value.trigger_kind === "string" ? value.trigger_kind : "user_message",
    trigger_message_id: typeof value.trigger_message_id === "string" ? value.trigger_message_id : null,
    status: typeof value.status === "string" ? value.status : "queued",
    error_message: typeof value.error_message === "string" ? value.error_message : null,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    started_at: typeof value.started_at === "string" ? value.started_at : null,
    finished_at: typeof value.finished_at === "string" ? value.finished_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

function decisionRequests(snapshot: Snapshot): DecisionRequestCardData[] {
  return (Array.isArray(snapshot.decision_requests) ? snapshot.decision_requests : [])
    .map((request: any) => ({
      decision_request_id: String(request.decision_request_id),
      request_type: request.request_type === "tool_permission" ? "tool_permission" as const : "clarification" as const,
      questions: Array.isArray(request.payload?.questions) ? request.payload.questions : [],
      status: request.status === "pending" ? "pending" as const
        : request.status === "rejected" ? "rejected" as const
          : request.status === "cancelled" ? "cancelled" as const
            : "approved" as const,
      answers: request.response?.answers,
      source_agent_run_id: typeof request.agent_run_id === "string" ? request.agent_run_id : null,
      tool_name: typeof request.payload?.provider_tool_name === "string" ? request.payload.provider_tool_name : undefined,
      tool_arguments: request.payload?.provider_input && typeof request.payload.provider_input === "object" ? request.payload.provider_input : undefined,
    }));
}

function planCards(snapshot: Snapshot): Record<string, PlanCardState> {
  const revisions = new Map((snapshot.plan?.revisions ?? []).map((revision: any) => [revision.plan_revision_id, revision]));
  return Object.fromEntries((snapshot.plan?.approvals ?? []).flatMap((approval: any) => {
    const revision = revisions.get(approval.plan_revision_id) as any;
    if (!revision) return [];
    const card: PlanCardState = {
      plan_approval_id: approval.plan_approval_id,
      plan_revision_id: approval.plan_revision_id,
      revision_number: revision.revision_number,
      status: approval.status,
      title: revision.title,
      overview: revision.overview,
      content: revision.content,
      feedback: approval.feedback ?? null,
      created_at: approval.created_at,
      resolved_at: approval.resolved_at ?? null,
    };
    return [[card.plan_approval_id, card]];
  }));
}

const empty: DashboardData = {
  isFlowStateLoaded: false,
  flowStateLoadedFlowId: null,
  flowStatus: "",
  behaviorMode: "execute",
  riskMode: "auto_edit",
  orchestrationMode: "approval_required",
  leaderAgentSessionId: null,
  leaderAgentRunId: null,
  activeLeaderAgentRunId: null,
  leaderTranscriptReadyFlowId: null,
  leaderTranscriptReadyAgentRunId: null,
  decisionRequests: [],
  planCards: {},
  orchestrationPlans: [],
  agentRuns: [],
};

function fromSnapshot(snapshot: Snapshot, flowId: string, current: DashboardData): DashboardData {
  return {
    ...current,
    isFlowStateLoaded: true,
    flowStateLoadedFlowId: flowId,
    flowStatus: typeof snapshot.status === "string" ? snapshot.status : "idle",
    behaviorMode: snapshot.behavior_mode === "plan" ? "plan" : "execute",
    riskMode: snapshot.risk_mode === "full_access" ? "full_access" : "auto_edit",
    orchestrationMode: snapshot.orchestration_mode === "automatic" ? "automatic" : "approval_required",
    leaderAgentSessionId: typeof snapshot.leader_agent_session_id === "string" ? snapshot.leader_agent_session_id : null,
    leaderAgentRunId: typeof snapshot.latest_leader_agent_run_id === "string" ? snapshot.latest_leader_agent_run_id : null,
    activeLeaderAgentRunId: typeof snapshot.active_leader_agent_run_id === "string" ? snapshot.active_leader_agent_run_id : null,
    decisionRequests: decisionRequests(snapshot),
    planCards: planCards(snapshot),
    orchestrationPlans: Array.isArray(snapshot.orchestration_history) ? snapshot.orchestration_history : [],
    agentRuns: (Array.isArray(snapshot.agent_runs) ? snapshot.agent_runs : []).map(normalizeAgentRun).filter(Boolean) as AgentRun[],
  };
}

export function useDashboardData(flowId: string | null): DashboardData {
  const [data, setData] = useState<DashboardData>(empty);

  useEffect(() => {
    setData(empty);
    if (!flowId) return;
    let stale = false;
    let loading: Promise<void> | null = null;
    const apply = (snapshot: Snapshot) => {
      if (!stale) setData((current) => fromSnapshot(snapshot, flowId, current));
    };
    const load = () => {
      if (loading) return loading;
      loading = fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`)
        .then(async (response) => { if (response.ok) apply(await response.json()); })
        .catch(() => undefined)
        .finally(() => { loading = null; });
      return loading;
    };

    const reload = (message: { flow_id?: string }) => { if (message.flow_id === flowId) void load(); };
    const unsubs = [
      wsClient.onEvent("flow:state", (message) => { if (message.flow_id === flowId) apply(message.data ?? {}); }),
      ...[
        "agent_session:event", "agent_run:event", "tool_call:event", "decision_request:event",
        "plan:event", "plan_approval:event", "orchestration:event", "orchestration_approval:event",
        "task:event", "change_set:event", "artifact:event",
      ].map((event) => wsClient.onEvent(event, reload)),
      wsClient.onEvent("session:transcript_snapshot", (message) => {
        if (message.flow_id !== flowId) return;
        setData((current) => ({
          ...current,
          leaderTranscriptReadyFlowId: flowId,
          leaderTranscriptReadyAgentRunId: message.agent_run_id ?? null,
        }));
      }),
    ];
    wsClient.sendFlowSubscribe(flowId);
    void load();
    return () => {
      stale = true;
      unsubs.forEach((unsubscribe) => unsubscribe());
      wsClient.sendFlowUnsubscribe(flowId);
    };
  }, [flowId]);

  return data.flowStateLoadedFlowId === flowId ? data : empty;
}

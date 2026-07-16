"use client";

import { useEffect, useState } from "react";
import { wsClient } from "../lib/ws";
import type { AgentSession } from "./useFlowExperts";
import type { OrchestrationPlanView } from "../types/orchestration";

export interface TaskData {
  id: string;
  flow_id?: string;
  user_turn_id: string;
  title: string;
  description: string;
  expert_id: string | null;
  status: string;
  agent_session_id?: string | null;
  depends_on_task_ids: string[];
  acceptance_criteria?: string[];
  result_artifact_ids?: string[];
  result_json?: string | null;
  error_message?: string | null;
}

export interface QuestionOption { label: string; description: string; }
export interface Question { question: string; header: string; multiSelect: boolean; options: QuestionOption[]; }
export type DecisionAnswer = string | string[];
export type DecisionAnswers = Record<string, DecisionAnswer>;

export interface DecisionCardData {
  card_id: string;
  card_type?: string;
  user_turn_id?: string | null;
  questions: Question[];
  status: "pending" | "resolved" | "cancelled";
  answers?: DecisionAnswers;
}

export interface ArtifactData {
  id: string;
  flow_id: string;
  user_turn_id?: string | null;
  task_id?: string | null;
  artifact_type: string;
  title: string;
  content?: string;
  source_agent_session_id?: string;
  created_at?: string;
}

export interface SpecRevisionData {
  id: string;
  revision_number: number;
  status: "draft" | "approved" | "executed" | "superseded" | string;
  title: string;
  content: string;
  source_agent_session_id?: string;
  created_at?: string;
  approved_at?: string | null;
  executed_at?: string | null;
}

export interface EventLogData {
  id: string;
  sequence: number;
  event_type: string;
  user_turn_id?: string | null;
  task_id?: string | null;
  agent_session_id?: string | null;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface UserTurnData {
  id: string;
  triggerMessageId: string;
  status: "active" | "waiting_user" | "completed" | "failed" | "cancelled" | string;
  startedAt: string | null;
  activeStartedAt: string | null;
  activeDurationMs: number;
  completedAt: string | null;
  workSource: "spec" | "direct_message" | null;
  specRevisionId: string | null;
  targetProjectId: string | null;
  workRootPath: string | null;
}

type SpecCardState = {
  spec_approval_id: string;
  spec_revision_id: string;
  status: "pending" | "approved" | "cancelled";
  file_name: string;
  overview: string;
  actions: string[];
};
export type { SpecCardState };

export interface DashboardData {
  isFlowStateLoaded: boolean;
  flowStateLoadedFlowId: string | null;
  activeUserTurnId: string | null;
  tasks: TaskData[];
  flowStatus: string;
  riskMode: "auto_edit" | "full_access";
  planApproval: "on" | "off";
  legacySpecFlow: boolean;
  leaderSessionId: string | null;
  leaderSessionFlowId: string | null;
  leaderAgentSessionId: string | null;
  leaderTranscriptReadyFlowId: string | null;
  leaderTranscriptReadyAgentSessionId: string | null;
  decisionCards: DecisionCardData[];
  specCards: Record<string, SpecCardState>;
  artifacts: ArtifactData[];
  specRevisions: SpecRevisionData[];
  userTurns: UserTurnData[];
  recentEvents: EventLogData[];
  experts: AgentSession[];
  orchestrationPlans: OrchestrationPlanView[];
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
  return [...byId.values()];
}

function normalizeUserTurn(value: unknown): UserTurnData | null {
  if (!value || typeof value !== "object") return null;
  const turn = value as Record<string, unknown>;
  const id = typeof turn.user_turn_id === "string" ? turn.user_turn_id : typeof turn.id === "string" ? turn.id : "";
  const triggerMessageId = typeof turn.trigger_message_id === "string" ? turn.trigger_message_id : "";
  if (!id || !triggerMessageId) return null;
  return {
    id,
    triggerMessageId,
    status: typeof turn.status === "string" ? turn.status : "active",
    startedAt: typeof turn.started_at === "string" ? turn.started_at : null,
    activeStartedAt: typeof turn.active_started_at === "string" ? turn.active_started_at : null,
    activeDurationMs: typeof turn.active_duration_ms === "number" ? turn.active_duration_ms : 0,
    completedAt: typeof turn.completed_at === "string" ? turn.completed_at : null,
    workSource: turn.work_source === "spec" || turn.work_source === "direct_message" ? turn.work_source : null,
    specRevisionId: typeof turn.spec_revision_id === "string" ? turn.spec_revision_id : null,
    targetProjectId: typeof turn.target_project_id === "string" ? turn.target_project_id : null,
    workRootPath: typeof turn.work_root_path === "string" && turn.work_root_path.trim().length > 0
      ? turn.work_root_path
      : null,
  };
}

function normalizeTask(value: Record<string, unknown>): TaskData | null {
  const id = typeof value.task_id === "string" ? value.task_id : typeof value.id === "string" ? value.id : "";
  const userTurnId = typeof value.user_turn_id === "string" ? value.user_turn_id : "";
  if (!id || !userTurnId) return null;
  return {
    id,
    flow_id: typeof value.flow_id === "string" ? value.flow_id : undefined,
    user_turn_id: userTurnId,
    title: typeof value.title === "string" ? value.title : typeof value.subject === "string" ? value.subject : id,
    description: typeof value.description === "string" ? value.description : "",
    expert_id: typeof value.expert_id === "string" ? value.expert_id : null,
    status: typeof value.status === "string" ? value.status : "pending",
    agent_session_id: typeof value.agent_session_id === "string" ? value.agent_session_id : null,
    depends_on_task_ids: Array.isArray(value.depends_on_task_ids) ? value.depends_on_task_ids.filter((id): id is string => typeof id === "string") : [],
    acceptance_criteria: Array.isArray(value.acceptance_criteria) ? value.acceptance_criteria.filter((item): item is string => typeof item === "string") : [],
    result_artifact_ids: Array.isArray(value.result_artifact_ids) ? value.result_artifact_ids.filter((id): id is string => typeof id === "string") : [],
    result_json: typeof value.result_json === "string" ? value.result_json : null,
    error_message: typeof value.error_message === "string" ? value.error_message : null,
  };
}

export function useDashboardData(flowId: string | null): DashboardData {
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [activeUserTurnId, setActiveUserTurnId] = useState<string | null>(null);
  const [flowStatus, setFlowStatus] = useState("");
  const [isFlowStateLoaded, setIsFlowStateLoaded] = useState(false);
  const [flowStateLoadedFlowId, setFlowStateLoadedFlowId] = useState<string | null>(null);
  const [leaderSessionId, setLeaderSessionId] = useState<string | null>(null);
  const [leaderSessionFlowId, setLeaderSessionFlowId] = useState<string | null>(null);
  const [leaderAgentSessionId, setLeaderAgentSessionId] = useState<string | null>(null);
  const [leaderTranscriptReadyFlowId, setLeaderTranscriptReadyFlowId] = useState<string | null>(null);
  const [leaderTranscriptReadyAgentSessionId, setLeaderTranscriptReadyAgentSessionId] = useState<string | null>(null);
  const [decisionCards, setDecisionCards] = useState<DecisionCardData[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [specRevisions, setSpecRevisions] = useState<SpecRevisionData[]>([]);
  const [userTurns, setUserTurns] = useState<UserTurnData[]>([]);
  const [recentEvents, setRecentEvents] = useState<EventLogData[]>([]);
  const [experts, setExperts] = useState<AgentSession[]>([]);
  const [riskMode, setRiskMode] = useState<"auto_edit" | "full_access">("auto_edit");
  const [planApproval, setPlanApproval] = useState<"on" | "off">("on");
  const [legacySpecFlow, setLegacySpecFlow] = useState(false);
  const [specCards, setSpecCards] = useState<Record<string, SpecCardState>>({});
  const [orchestrationPlans, setOrchestrationPlans] = useState<OrchestrationPlanView[]>([]);

  useEffect(() => {
    const reset = () => {
      setTasks([]); setActiveUserTurnId(null); setFlowStatus(""); setIsFlowStateLoaded(false); setFlowStateLoadedFlowId(null);
      setLeaderSessionId(null); setLeaderSessionFlowId(null); setLeaderAgentSessionId(null);
      setLeaderTranscriptReadyFlowId(null); setLeaderTranscriptReadyAgentSessionId(null);
      setDecisionCards([]); setArtifacts([]); setSpecRevisions([]); setUserTurns([]); setRecentEvents([]); setExperts([]);
      setRiskMode("auto_edit"); setPlanApproval("on"); setLegacySpecFlow(false); setSpecCards({}); setOrchestrationPlans([]);
    };
    reset();
    if (!flowId) return;
    let stale = false;
    const unsubs = [
      wsClient.onEvent("flow:state", (msg) => {
        if (stale || msg.flow_id !== flowId) return;
        const data = msg.data || {};
        setTasks((data.tasks || []).map((task: Record<string, unknown>) => normalizeTask(task)).filter((task: TaskData | null): task is TaskData => task !== null));
        setActiveUserTurnId(data.active_user_turn_id || null);
        setFlowStatus(data.status || ""); setIsFlowStateLoaded(true); setFlowStateLoadedFlowId(msg.flow_id);
        setRiskMode(data.risk_mode === "full_access" ? "full_access" : "auto_edit");
        setPlanApproval(data.plan_approval === "off" ? "off" : "on");
        setLegacySpecFlow(Boolean(data.legacy_spec_flow));
        setLeaderSessionId(data.leader_session_id || null); setLeaderSessionFlowId(data.leader_session_id ? msg.flow_id : null);
        setLeaderAgentSessionId(data.leader_agent_session_id || null);
        setDecisionCards(data.decision_cards || []); setArtifacts(data.artifacts || []); setSpecRevisions(data.spec_revisions || []);
        setUserTurns((data.user_turns || []).map(normalizeUserTurn).filter((turn: UserTurnData | null): turn is UserTurnData => turn !== null));
        setRecentEvents(data.recent_events || []); setExperts(data.agent_sessions || []);
        setOrchestrationPlans(Array.isArray(data.orchestration_plan_history) ? data.orchestration_plan_history : data.current_orchestration_plan ? [data.current_orchestration_plan] : []);
        if (data.pending_spec_approval) setSpecCards((current) => ({ ...current, [data.pending_spec_approval.spec_approval_id]: data.pending_spec_approval }));
      }),
      wsClient.onEvent("flow:status", (msg) => {
        if (msg.flow_id !== flowId) return;
        setFlowStatus(msg.data?.status || "");
        if ("active_user_turn_id" in (msg.data || {})) setActiveUserTurnId(msg.data.active_user_turn_id || null);
        if (msg.data?.leader_session_id) { setLeaderSessionId(msg.data.leader_session_id); setLeaderSessionFlowId(msg.flow_id); }
        if (msg.data?.leader_agent_session_id) setLeaderAgentSessionId(msg.data.leader_agent_session_id);
      }),
      wsClient.onEvent("task:event", (msg) => {
        if (msg.flow_id !== flowId) return;
        const incoming = msg.data?.task || msg.data || {};
        const taskId = typeof incoming.task_id === "string"
          ? incoming.task_id
          : typeof incoming.id === "string"
            ? incoming.id
            : "";
        if (!taskId) return;
        setTasks((prev) => {
          const existing = prev.find((task) => task.id === taskId);
          const task = normalizeTask({ ...existing, ...msg.data, ...incoming });
          return task ? mergeById(prev, [task]) : prev;
        });
        setOrchestrationPlans((current) => current.map((plan) => ({
          ...plan,
          nodes: plan.nodes.map((node) => {
            const linkedTask = node.task;
            if (!linkedTask || linkedTask.task_id !== taskId) return node;
            return { ...node, task: { ...linkedTask, status: typeof incoming.status === "string" ? incoming.status : linkedTask.status, agent_session_id: typeof incoming.agent_session_id === "string" ? incoming.agent_session_id : linkedTask.agent_session_id, error_message: typeof incoming.error_message === "string" ? incoming.error_message : linkedTask.error_message } };
          }),
        })));
      }),
      wsClient.onEvent("user_turn:event", (msg) => {
        if (msg.flow_id !== flowId) return;
        const turn = normalizeUserTurn(msg.data);
        if (!turn) return;
        setUserTurns((prev) => mergeById(prev, [turn]));
        if (["completed", "failed", "cancelled"].includes(turn.status)) { setActiveUserTurnId((current) => current === turn.id ? null : current); setFlowStatus("idle"); }
      }),
      wsClient.onEvent("session:event", (msg) => {
        if (msg.flow_id !== flowId || !msg.data?.agent_session_id) return;
        setExperts((prev) => prev.map((session) => session.id === msg.data.agent_session_id ? { ...session, status: msg.data.status || session.status } : session));
      }),
      wsClient.onEvent("flow:decision_card", (msg) => { if (msg.flow_id === flowId) setDecisionCards((prev) => mergeById(prev.map((card) => ({ ...card, id: card.card_id })), [{ ...msg.data, id: msg.data.card_id }]).map(({ id: _id, ...card }) => card)); }),
      wsClient.onEvent("flow:decision_card_resolved", (msg) => { if (msg.flow_id === flowId) setDecisionCards((prev) => prev.map((card) => card.card_id === msg.data.card_id ? { ...card, status: msg.data.status, answers: msg.data.answers } : card)); }),
      wsClient.onEvent("artifact:event", (msg) => { if (msg.flow_id === flowId && msg.data?.id) setArtifacts((prev) => mergeById(prev, [msg.data])); }),
      wsClient.onEvent("flow:spec_card", (msg) => { if (msg.flow_id === flowId) setSpecCards((current) => ({ ...current, [msg.data.spec_approval_id]: msg.data })); }),
      wsClient.onEvent("flow:spec_card_resolved", (msg) => { if (msg.flow_id === flowId) setSpecCards((current) => current[msg.data.spec_approval_id] ? { ...current, [msg.data.spec_approval_id]: { ...current[msg.data.spec_approval_id], status: msg.data.status } } : current); }),
      wsClient.onEvent("plan:event", (msg) => {
        if (msg.flow_id !== flowId || !msg.data?.revision?.plan_revision_id) return;
        setOrchestrationPlans((current) => mergeById(current.map((plan) => ({ ...plan, id: plan.revision.plan_revision_id })), [{ ...msg.data, id: msg.data.revision.plan_revision_id }]).map(({ id: _id, ...plan }) => plan as OrchestrationPlanView));
      }),
      wsClient.onEvent("plan_approval:event", (msg) => {
        if (msg.flow_id !== flowId) return;
        const revisionId = msg.data?.planRevisionId ?? msg.data?.plan_revision_id;
        setOrchestrationPlans((current) => current.map((plan) => plan.revision.plan_revision_id === revisionId ? { ...plan, approval: plan.approval ? { ...plan.approval, status: msg.data.status } : plan.approval } : plan));
      }),
      wsClient.onEvent("plan_run:event", (msg) => {
        if (msg.flow_id !== flowId) return;
        setOrchestrationPlans((current) => current.map((plan) => plan.revision.plan_revision_id === msg.data?.plan_revision_id ? { ...plan, run: { plan_run_id: msg.data.plan_run_id, status: msg.data.status } } : plan));
      }),
      wsClient.onEvent("session:transcript_snapshot", (msg) => {
        if (msg.flow_id !== flowId) return;
        setDecisionCards(msg.decision_cards || msg.pending_cards || []);
        if (!msg.flow_expert_id) { setLeaderTranscriptReadyFlowId(msg.flow_id); setLeaderTranscriptReadyAgentSessionId(msg.agent_session_id || null); }
      }),
    ];
    wsClient.sendFlowSubscribe(flowId);
    return () => { stale = true; unsubs.forEach((unsubscribe) => unsubscribe()); wsClient.sendFlowUnsubscribe(flowId); };
  }, [flowId]);

  const isCurrentFlowState = flowStateLoadedFlowId === flowId;
  return {
    isFlowStateLoaded,
    flowStateLoadedFlowId: isCurrentFlowState ? flowStateLoadedFlowId : null,
    activeUserTurnId,
    tasks,
    flowStatus,
    riskMode: isCurrentFlowState ? riskMode : "auto_edit",
    planApproval: isCurrentFlowState ? planApproval : "on",
    legacySpecFlow,
    leaderSessionId: isCurrentFlowState ? leaderSessionId : null,
    leaderSessionFlowId: isCurrentFlowState ? leaderSessionFlowId : null,
    leaderAgentSessionId: isCurrentFlowState ? leaderAgentSessionId : null,
    leaderTranscriptReadyFlowId: isCurrentFlowState ? leaderTranscriptReadyFlowId : null,
    leaderTranscriptReadyAgentSessionId: isCurrentFlowState ? leaderTranscriptReadyAgentSessionId : null,
    decisionCards,
    specCards,
    artifacts,
    specRevisions,
    userTurns,
    recentEvents,
    experts,
    orchestrationPlans,
  };
}

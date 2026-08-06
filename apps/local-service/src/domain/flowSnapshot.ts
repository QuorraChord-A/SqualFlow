import type { Store } from "../db/store.js";
import {
  isExpertRuntimeEnabled,
  readAgentRuntimeConfigSnapshotSync,
  runtimeRoleForExpertRole,
} from "../config/agentRuntimeConfig.js";
import { workRunDto } from "./workRun.js";
import { currentPlanView, planHistoryView } from "./orchestrationView.js";
import { leaderTranscriptChannelId } from "./transcriptChannels.js";

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseWorkRunInput(turn: ReturnType<Store["listWorkRuns"]>[number]) {
  const snapshot = parseJsonObject(turn.inputSnapshotJson);
  if (turn.workSource === "spec") {
    return {
      type: "spec",
      file_name: typeof snapshot.file_name === "string" ? snapshot.file_name : "",
      overview: typeof snapshot.overview === "string" ? snapshot.overview : "",
      content: typeof snapshot.content === "string" ? snapshot.content : "",
    };
  }
  return {
    type: "direct_message",
    message_id: typeof snapshot.message_id === "string" ? snapshot.message_id : "",
    content: typeof snapshot.content === "string" ? snapshot.content : "",
    created_at: typeof snapshot.created_at === "string" ? snapshot.created_at : "",
  };
}

export function buildFlowSnapshot(store: Store, flowId: string) {
  const flow = store.getFlow(flowId);
  if (!flow) return { error: `flow not found: ${flowId}` };

  const agentSessions = store.listAgentSessions(flowId);
  const leaderSessions = agentSessions
    .filter((session) => session.expertId === "exp-leader" && session.taskId === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const activeLeaderSession = leaderSessions.find((session) => session.status === "queued" || session.status === "streaming") ?? null;
  const latestLeaderSession = leaderSessions.at(-1) ?? null;
  const workRuns = store.listWorkRuns(flowId);
  const currentWorkRun = workRuns.find((turn) => ["ready", "executing", "waiting_user", "interrupted"].includes(turn.status)) ?? null;
  const hasActiveExecution = agentSessions.some((session) => session.status === "queued" || session.status === "streaming");
  const projectedFlowStatus = hasActiveExecution ? "active" : "idle";

  const latestSpecRow = store.listSpecRevisions(flowId).reduce<
    ReturnType<Store["listSpecRevisions"]>[number] | null
  >(
    (latest, spec) => !latest || spec.revisionNumber > latest.revisionNumber ? spec : latest,
    null,
  );
  const pendingSpecApproval = store.listSpecApprovals(flowId).find((approval) => approval.status === "pending") ?? null;
  const runtimeConfigSnapshot = readAgentRuntimeConfigSnapshotSync();
  return {
    id: flow.id,
    name: flow.name,
    name_generation_status: flow.nameGenerationStatus,
    status: projectedFlowStatus,
    has_active_execution: hasActiveExecution,
    legacy_spec_flow: flow.legacySpecFlow === 1,
    risk_mode: store.getRiskMode(flow.id),
    plan_approval: store.getPlanApprovalMode(flow.id),
    latest_spec: latestSpecRow ? {
      spec_revision_id: latestSpecRow.id,
      revision_number: latestSpecRow.revisionNumber,
      status: latestSpecRow.status,
      file_name: latestSpecRow.fileName,
      overview: latestSpecRow.overview,
      approval: pendingSpecApproval?.specRevisionId === latestSpecRow.id
        ? {
            spec_approval_id: pendingSpecApproval.id,
            work_run_id: pendingSpecApproval.workRunId,
            status: pendingSpecApproval.status,
          }
        : null,
    } : null,
    pending_spec_approval: pendingSpecApproval ? {
      spec_approval_id: pendingSpecApproval.id,
      spec_revision_id: pendingSpecApproval.specRevisionId,
      work_run_id: pendingSpecApproval.workRunId,
      status: pendingSpecApproval.status,
      file_name: pendingSpecApproval.fileName,
      overview: pendingSpecApproval.overview,
      actions: ["run"],
    } : null,
    project_id: flow.projectId,
    leader_session_id: flow.leaderSessionId,
    leader_runtime_sdk: flow.leaderRuntimeSdk,
    leader_runtime_config_id: flow.leaderRuntimeConfigId,
    leader_runtime_model_id: flow.leaderRuntimeModelId,
    leader_runtime_reasoning_effort: flow.leaderRuntimeReasoningEffort,
    active_leader_agent_session_id: activeLeaderSession?.id ?? null,
    latest_leader_agent_session_id: latestLeaderSession?.id ?? null,
    leader_transcript_channel: {
      channel_id: leaderTranscriptChannelId(flowId),
      provider_session_id: flow.leaderSessionId,
    },
    // Template catalog (runtime enablement). Prefer `team` for Leader planning by person name.
    experts: store.listExperts().map((expert) => {
      const runtimeRole = expert.role === "leader" ? "leader" : runtimeRoleForExpertRole(expert.role);
      const enabled = isExpertRuntimeEnabled(runtimeConfigSnapshot.roles, expert.role);
      return {
        expert_id: expert.id,
        role: expert.role,
        name: expert.name,
        role_title: expert.name,
        runtime_role: runtimeRole,
        enabled,
        disabled_reason: enabled ? null : "runtime_role_disabled",
      };
    }),
    // Only experts already used in this Flow (on-demand). Catalog + enabled flags live in `experts`.
    team: store.listFlowExperts(flowId).map((flowExpert) => {
      const expert = store.getExpert(flowExpert.expertId);
      const runtimeRole = expert
        ? (expert.role === "leader" ? "leader" : runtimeRoleForExpertRole(expert.role))
        : "coder";
      const enabled = expert
        ? isExpertRuntimeEnabled(runtimeConfigSnapshot.roles, expert.role)
        : false;
      return {
        person_name: flowExpert.displayName,
        role_title: expert?.name ?? flowExpert.expertId,
        capability: expert?.role ?? "",
        expert_id: flowExpert.expertId,
        enabled,
        disabled_reason: enabled ? null : "runtime_role_disabled",
        runtime_role: runtimeRole,
      };
    }),
    current_work_run_id: currentWorkRun?.id ?? null,
    work_runs: workRuns.map((turn) => ({ ...workRunDto(turn), input: parseWorkRunInput(turn) })),
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
    tasks: store.listTasks(flowId).map((task) => ({
      id: task.id,
      flow_id: task.flowId,
      work_run_id: task.workRunId,
      title: task.title,
      description: task.description,
      expert_id: task.expertId,
      status: task.status,
      revision: task.revision,
      active_form: task.activeForm,
      progress: task.progress,
      agent_session_id: task.agentSessionId,
      depends_on_task_ids: store.listTaskDependencies(task.id),
      acceptance_criteria: parseJsonArray(task.acceptanceCriteriaJson),
      result_artifact_ids: parseJsonArray(task.resultArtifactIdsJson),
      result_json: task.resultJson,
      error_message: task.errorMessage,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
    })),
    current_orchestration_plan: currentPlanView(store, flowId),
    orchestration_plan_history: planHistoryView(store, flowId),
    spec_revisions: store.listSpecRevisions(flowId).map((spec) => ({
      id: spec.id,
      revision_number: spec.revisionNumber,
      status: spec.status,
      title: spec.title,
      content: spec.content,
      source_agent_session_id: spec.sourceAgentSessionId,
      created_at: spec.createdAt,
      approved_at: spec.approvedAt,
      executed_at: spec.executedAt,
    })),
    decision_cards: store.listDecisionCards(flowId).map((card) => ({
      id: card.id,
      card_id: card.id,
      flow_id: card.flowId,
      work_run_id: card.workRunId,
      session_id: card.sessionId,
      card_type: card.cardType,
      questions: parseJsonArray(card.questions),
      answers: parseJsonObject(card.answers),
      status: card.status,
      created_at: card.createdAt,
      resolved_at: card.resolvedAt,
    })),
    agent_sessions: agentSessions.map((session) => ({
      id: session.id,
      agent_session_id: session.id,
      flow_id: session.flowId,
      work_run_id: session.workRunId,
      task_id: session.taskId,
      expert_id: session.expertId,
      session_id: session.sessionId,
      runtime_sdk: session.runtimeSdk,
      runtime_config_id: session.runtimeConfigId,
      runtime_model_id: session.runtimeModelId,
      runtime_reasoning_effort: session.runtimeReasoningEffort,
      display_name: session.displayName,
      status: session.status,
      resume_from_agent_session_id: session.resumeFromAgentSessionId,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    })),
    artifacts: store.listArtifacts(flowId).map((artifact) => ({
      id: artifact.id,
      flow_id: artifact.flowId,
      work_run_id: artifact.workRunId,
      task_id: artifact.taskId,
      artifact_type: artifact.type,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      source_agent_session_id: artifact.sourceAgentSessionId,
      created_at: artifact.createdAt,
      updated_at: artifact.updatedAt,
    })),
    recent_events: store.listEventLog(flowId).slice(-50).map((event) => {
      const payload = parseJsonObject(event.payloadJson);
      if (event.eventType === "agent_session.completion" && typeof payload.summary === "string" && payload.summary.length > 200) {
        payload.summary = `${payload.summary.slice(0, 200)}…详情见对应 expert_result 事件`;
      }
      return {
        id: event.id,
        sequence: event.sequence,
        event_type: event.eventType,
        work_run_id: event.workRunId,
        task_id: event.taskId,
        agent_session_id: event.agentSessionId,
        payload,
        created_at: event.createdAt,
      };
    }),
  };
}

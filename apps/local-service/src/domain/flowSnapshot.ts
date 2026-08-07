import type { Store } from "../db/store.js";
import {
  isExpertRuntimeEnabled,
  readAgentRuntimeConfigSnapshotSync,
  runtimeRoleForExpertRole,
} from "../config/agentRuntimeConfig.js";
import { deriveFlowIndicator, isActiveAgentRunStatus } from "./supervisor.js";
import { currentOrchestrationView, orchestrationHistoryView } from "./orchestrationView.js";
import { leaderTranscriptChannelId } from "./transcriptChannels.js";

function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function buildFlowSnapshot(store: Store, flowId: string) {
  const flow = store.getFlow(flowId);
  if (!flow) return { error: `flow not found: ${flowId}` };

  const sessions = store.listAgentSessions(flowId);
  const runs = store.listAgentRuns(flowId);
  const leaderSession = sessions.find((session) => session.role === "leader") ?? null;
  const activeRuns = runs.filter((run) => isActiveAgentRunStatus(run.status));
  const leaderRuns = leaderSession ? runs.filter((run) => run.agentSessionId === leaderSession.id) : [];
  const activeLeaderRun = leaderRuns.find((run) => isActiveAgentRunStatus(run.status)) ?? null;
  const pendingUserActions = store.listPendingUserActions(flowId);
  const unread = store.hasUnreadOutput(flowId);
  const runtimeConfigSnapshot = readAgentRuntimeConfigSnapshotSync();
  const planDocument = store.getPlanDocument(flowId);

  return {
    id: flow.id,
    name: flow.name,
    name_generation_status: flow.nameGenerationStatus,
    status: activeRuns.length > 0 ? "active" : "idle",
    indicator: deriveFlowIndicator({
      hasPendingUserAction: pendingUserActions.length > 0,
      hasActiveAgentRun: activeRuns.length > 0,
      hasUnreadOutput: unread,
    }),
    has_active_agent_run: activeRuns.length > 0,
    has_unread_output: unread,
    project_id: flow.projectId,
    behavior_mode: flow.behaviorMode,
    risk_mode: flow.riskMode,
    orchestration_mode: flow.orchestrationMode,
    is_pinned: flow.isPinned === 1,
    leader_agent_session_id: leaderSession?.id ?? null,
    active_leader_agent_run_id: activeLeaderRun?.id ?? null,
    latest_leader_agent_run_id: leaderRuns.at(-1)?.id ?? null,
    leader_transcript_channel: {
      channel_id: leaderTranscriptChannelId(flowId),
      provider_session_id: leaderSession?.providerSessionId ?? null,
    },
    agent_definitions: store.listAgentDefinitions().map((definition) => {
      const runtimeRole = definition.role === "leader" ? "leader" : runtimeRoleForExpertRole(definition.role);
      const enabled = isExpertRuntimeEnabled(runtimeConfigSnapshot.roles, definition.role);
      return {
        agent_definition_id: definition.id,
        role: definition.role,
        name: definition.name,
        runtime_role: runtimeRole,
        enabled,
        disabled_reason: enabled ? null : "runtime_role_disabled",
      };
    }),
    agent_sessions: sessions.map((session) => ({
      agent_session_id: session.id,
      flow_id: session.flowId,
      agent_definition_id: session.agentDefinitionId,
      role: session.role,
      display_name: session.displayName,
      provider_session_id: session.providerSessionId,
      runtime_sdk: session.runtimeSdk,
      runtime_config_id: session.runtimeConfigId,
      runtime_model_id: session.runtimeModelId,
      runtime_reasoning_effort: session.runtimeReasoningEffort,
      active_agent_run_id: activeRuns.find((run) => run.agentSessionId === session.id)?.id ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    })),
    agent_runs: runs.map((run) => ({
      agent_run_id: run.id,
      flow_id: run.flowId,
      agent_session_id: run.agentSessionId,
      task_id: run.taskId,
      trigger_kind: run.triggerKind,
      trigger_message_id: run.triggerMessageId,
      status: run.status,
      error_message: run.errorMessage,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      updated_at: run.updatedAt,
    })),
    tool_calls: store.listToolCalls(flowId).map((call) => ({
      tool_call_id: call.id,
      agent_run_id: call.agentRunId,
      task_id: call.taskId,
      name: call.name,
      function_call_type: call.functionCallType,
      status: call.status,
      arguments: parseObject(call.argumentsJson),
      result: call.resultJson ? parseObject(call.resultJson) : null,
      error_message: call.errorMessage,
      decision_request_id: call.decisionRequestId,
      created_at: call.createdAt,
      updated_at: call.updatedAt,
      completed_at: call.completedAt,
    })),
    tasks: store.listTasks(flowId).map((task) => ({
      task_id: task.id,
      flow_id: task.flowId,
      orchestration_revision_id: task.orchestrationRevisionId,
      orchestration_node_id: task.orchestrationNodeId,
      title: task.title,
      description: task.description,
      recommended_agent_definition_id: task.recommendedAgentDefinitionId,
      agent_session_id: task.agentSessionId,
      status: task.status,
      revision: task.revision,
      active_form: task.activeForm,
      progress: task.progress,
      metadata: parseObject(task.metadataJson),
      acceptance_criteria: parseArray(task.acceptanceCriteriaJson),
      result_artifact_ids: parseArray(task.resultArtifactIdsJson),
      result: task.resultJson ? parseObject(task.resultJson) : null,
      error_message: task.errorMessage,
      depends_on_task_ids: store.listTaskDependencies(task.id),
      created_by_agent_run_id: task.createdByAgentRunId,
      created_at: task.createdAt,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
      updated_at: task.updatedAt,
    })),
    plan: planDocument ? {
      document: {
        plan_document_id: planDocument.id,
        flow_id: planDocument.flowId,
        title: planDocument.title,
        created_at: planDocument.createdAt,
        updated_at: planDocument.updatedAt,
      },
      revisions: store.listPlanRevisions(flowId).map((revision) => ({
        plan_revision_id: revision.id,
        plan_document_id: revision.planDocumentId,
        flow_id: revision.flowId,
        revision_number: revision.revisionNumber,
        title: revision.title,
        overview: revision.overview,
        content: revision.content,
        source_agent_run_id: revision.sourceAgentRunId,
        created_at: revision.createdAt,
      })),
      approvals: store.listPlanApprovals(flowId).map((approval) => ({
        plan_approval_id: approval.id,
        flow_id: approval.flowId,
        plan_revision_id: approval.planRevisionId,
        status: approval.status,
        resolution_action_id: approval.resolutionActionId,
        feedback: approval.feedback,
        created_at: approval.createdAt,
        resolved_at: approval.resolvedAt,
      })),
    } : null,
    current_orchestration: currentOrchestrationView(store, flowId),
    orchestration_history: orchestrationHistoryView(store, flowId),
    decision_requests: store.listDecisionRequests(flowId).map((request) => ({
      decision_request_id: request.id,
      agent_run_id: request.agentRunId,
      tool_call_id: request.toolCallId,
      request_type: request.requestType,
      payload: parseObject(request.payloadJson),
      response: request.responseJson ? parseObject(request.responseJson) : null,
      status: request.status,
      created_at: request.createdAt,
      resolved_at: request.resolvedAt,
    })),
    pending_user_actions: pendingUserActions,
    change_sets: store.listChangeSets(flowId).map((changeSet) => ({
      change_set_id: changeSet.id,
      flow_id: changeSet.flowId,
      title: changeSet.title,
      status: changeSet.status,
      root_path: changeSet.rootPath,
      baseline_kind: changeSet.baselineKind,
      baseline_ref: changeSet.baselineRef,
      partial_reason: changeSet.partialReason,
      review: changeSet.reviewJson ? parseObject(changeSet.reviewJson) : null,
      created_at: changeSet.createdAt,
      finalized_at: changeSet.finalizedAt,
      abandoned_at: changeSet.abandonedAt,
      updated_at: changeSet.updatedAt,
      files: store.listChangeSetFiles(String(changeSet.id)).map((file) => ({
        path: file.path,
        status: file.status,
        patch: file.patch,
        additions: file.additions,
        deletions: file.deletions,
        attribution_kind: file.attributionKind,
      })),
    })),
    artifacts: store.listArtifacts(flowId).map((artifact) => ({
      artifact_id: artifact.id,
      flow_id: artifact.flowId,
      task_id: artifact.taskId,
      change_set_id: artifact.changeSetId,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      source_agent_run_id: artifact.sourceAgentRunId,
      created_at: artifact.createdAt,
      updated_at: artifact.updatedAt,
    })),
    context_usage: store.listAgentContextUsageSnapshots(flowId),
    recent_events: store.listEventLog(flowId).slice(-50).map((event) => ({
      id: event.id,
      sequence: event.sequence,
      event_type: event.eventType,
      task_id: event.taskId,
      agent_run_id: event.agentRunId,
      payload: parseObject(event.payloadJson),
      created_at: event.createdAt,
    })),
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
  };
}

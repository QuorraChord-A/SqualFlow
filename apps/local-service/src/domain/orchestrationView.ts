import type { Store } from "../db/store.js";

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

export function orchestrationRevisionView(store: Store, revisionId: string) {
  const revision = store.getOrchestrationRevision(revisionId) as {
    id: string;
    orchestrationPlanId: string;
    flowId: string;
    revisionNumber: number;
    parentRevisionId: string | null;
    status: string;
    approvalModeSnapshot: string;
    title: string;
    objective: string;
    sourceAgentRunId: string;
    createdAt: string;
    activatedAt: string | null;
  } | undefined;
  if (!revision) return null;
  const approval = store.getOrchestrationApprovalForRevision(revisionId) as {
    id: string;
    status: string;
    resolutionActionId: string | null;
    feedback: string | null;
    createdAt: string;
    resolvedAt: string | null;
  } | undefined;
  const tasks = store.listTasks(revision.flowId).filter((task) => task.orchestrationRevisionId === revisionId);
  return {
    flow_id: revision.flowId,
    orchestration_plan_id: revision.orchestrationPlanId,
    revision: {
      orchestration_revision_id: revision.id,
      revision_number: revision.revisionNumber,
      parent_revision_id: revision.parentRevisionId,
      status: revision.status,
      approval_mode_snapshot: revision.approvalModeSnapshot,
      title: revision.title,
      objective: revision.objective,
      source_agent_run_id: revision.sourceAgentRunId,
      created_at: revision.createdAt,
      activated_at: revision.activatedAt,
    },
    approval: approval ? {
      orchestration_approval_id: approval.id,
      status: approval.status,
      resolution_action_id: approval.resolutionActionId,
      feedback: approval.feedback,
      created_at: approval.createdAt,
      resolved_at: approval.resolvedAt,
    } : null,
    nodes: (store.listOrchestrationNodes(revisionId) as Array<{
      id: string;
      stableKey: string;
      recommendedAgentDefinitionId: string;
      title: string;
      description: string;
      acceptanceCriteriaJson: string;
      metadataJson: string;
    }>).map((node) => ({
      orchestration_node_id: node.id,
      stable_key: node.stableKey,
      recommended_agent_definition_id: node.recommendedAgentDefinitionId,
      title: node.title,
      description: node.description,
      acceptance_criteria: parseArray(node.acceptanceCriteriaJson),
      metadata: parseObject(node.metadataJson),
      depends_on_node_ids: store.listOrchestrationNodeDependencies(revisionId, node.id),
      task: (() => {
        const task = tasks.find((candidate) => candidate.orchestrationNodeId === node.id);
        return task ? {
          task_id: task.id,
          status: task.status,
          agent_session_id: task.agentSessionId,
          error_message: task.errorMessage,
        } : null;
      })(),
    })),
    feedback: store.listOrchestrationFeedback(revisionId).map((item) => ({
      orchestration_feedback_id: item.id,
      orchestration_node_id: item.orchestrationNodeId,
      source_message_id: item.sourceMessageId,
      marker_number: item.markerNumber,
      comment: item.comment,
      status: item.status,
      resolution_note: item.resolutionNote,
      created_at: item.createdAt,
      resolved_at: item.resolvedAt,
    })),
  };
}

export function currentOrchestrationView(store: Store, flowId: string) {
  const plan = store.getOrchestrationPlanForFlow(flowId) as { id: string } | undefined;
  if (!plan) return null;
  const revision = (store.listOrchestrationRevisions(plan.id) as Array<{ id: string; revisionNumber: number }>).at(-1);
  return revision ? orchestrationRevisionView(store, revision.id) : null;
}

export function orchestrationHistoryView(store: Store, flowId: string) {
  const plan = store.getOrchestrationPlanForFlow(flowId) as { id: string } | undefined;
  if (!plan) return [];
  return (store.listOrchestrationRevisions(plan.id) as Array<{ id: string }>)
    .map((revision) => orchestrationRevisionView(store, revision.id)).filter(Boolean);
}

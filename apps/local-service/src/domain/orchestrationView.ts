import type { Store } from "../db/store.js";

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function planRevisionView(store: Store, revisionId: string) {
  const revision = store.getPlanRevision(revisionId);
  if (!revision) return null;
  const plan = store.getOrchestrationPlan(revision.planId);
  if (!plan) return null;
  const nodes = store.listPlanNodes(revision.id);
  const nodeTask = new Map<string, ReturnType<Store["getTask"]>>();
  const run = store.getPlanRunForRevision(revision.id);
  if (run) {
    for (const mapping of store.listPlanNodeTasks(run.id)) nodeTask.set(mapping.planNodeId, store.getTask(mapping.taskId));
  }
  return {
    plan_id: plan.id,
    flow_id: plan.flowId,
    user_turn_id: plan.userTurnId,
    spec_revision_id: plan.specRevisionId,
    revision: {
      plan_revision_id: revision.id,
      revision_number: revision.revisionNumber,
      parent_revision_id: revision.parentRevisionId,
      source_feedback_message_id: revision.sourceFeedbackMessageId,
      status: revision.status,
      title: revision.title,
      objective: revision.objective,
      work_kind: revision.workKind,
      risk_level: revision.riskLevel,
      lint: parseArray(revision.lintJson),
      diff: parseObject(revision.diffJson),
      created_at: revision.createdAt,
      approved_at: revision.approvedAt,
    },
    approval: (() => {
      const approval = store.getPlanApprovalForRevision(revision.id);
      return approval ? {
        plan_approval_id: approval.id,
        status: approval.status,
        created_at: approval.createdAt,
        resolved_at: approval.resolvedAt,
      } : null;
    })(),
    run: run ? { plan_run_id: run.id, status: run.status, started_at: run.startedAt, completed_at: run.completedAt } : null,
    nodes: nodes.map((node) => {
      const task = nodeTask.get(node.id);
      return {
        plan_node_id: node.id,
        stable_key: node.stableKey,
        expert_id: node.expertId,
        title: node.title,
        description: node.description,
        depends_on_node_ids: store.listPlanNodeDependencies(revision.id, node.id),
        acceptance_criteria: parseArray(node.acceptanceCriteriaJson),
        risk_tags: parseArray(node.riskTagsJson),
        side_effects: parseArray(node.sideEffectsJson),
        resource_keys: parseArray(node.resourceKeysJson),
        task: task ? {
          task_id: task.id,
          status: task.status,
          revision: task.revision,
          progress: task.progress,
          agent_session_id: task.agentSessionId,
          error_message: task.errorMessage,
        } : null,
      };
    }),
    feedback: store.listPlanFeedback(revision.id).map((item) => ({
      plan_feedback_id: item.id,
      plan_node_id: item.planNodeId,
      source_message_id: item.sourceMessageId,
      marker_number: item.markerNumber,
      comment: item.comment,
      status: item.status,
      resolution_note: item.resolutionNote,
      created_at: item.createdAt,
    })),
  };
}

export function currentPlanView(store: Store, flowId: string) {
  const plans = store.listOrchestrationPlans(flowId);
  const plan = plans.at(-1);
  if (!plan) return null;
  const revision = store.listPlanRevisions(plan.id).at(-1);
  return revision ? planRevisionView(store, revision.id) : null;
}

export function planHistoryView(store: Store, flowId: string) {
  return store.listOrchestrationPlans(flowId).flatMap((plan) =>
    store.listPlanRevisions(plan.id).map((revision) => planRevisionView(store, revision.id)).filter(Boolean)
  );
}

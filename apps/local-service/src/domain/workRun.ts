import type { Store } from "../db/store.js";
import type { EventBus } from "../ws/eventBus.js";
import { finalizeWorkRunReview } from "./workRunReview.js";
import { saveWorkRunDiffArtifacts } from "../runtime/workRunLifecycle.js";

export type WorkRunRow = ReturnType<Store["listWorkRuns"]>[number];

export function workRunDto(turn: WorkRunRow) {
  return {
    id: turn.id,
    work_run_id: turn.id,
    flow_id: turn.flowId,
    trigger_message_id: turn.triggerMessageId,
    status: turn.status,
    revision: turn.revision,
    started_at: turn.startedAt,
    execution_started_at: turn.executionStartedAt,
    active_started_at: turn.activeStartedAt,
    active_duration_ms: turn.activeDurationMs,
    waiting_started_at: turn.waitingStartedAt,
    completed_at: turn.completedAt,
    work_source: turn.workSource,
    spec_revision_id: turn.specRevisionId,
    target_project_id: turn.targetProjectId,
    work_root_path: turn.workRootPath,
    input_snapshot_json: turn.inputSnapshotJson,
    created_at: turn.createdAt,
    updated_at: turn.updatedAt,
  };
}

export async function publishWorkRunEvent(
  eventBus: EventBus,
  turn: WorkRunRow,
  logId?: string,
) {
  await eventBus.publish(turn.flowId, {
    type: "work_run:event",
    flow_id: turn.flowId,
    ...(logId ? { log_id: logId } : {}),
    data: workRunDto(turn),
  });
}

export function isWorkRunSettled(store: Store, workRunId: string): boolean {
  const turn = store.getWorkRun(workRunId);
  if (!turn || turn.status !== "executing") return false;
  const hasOpenTask = store.listWorkRunTasks(workRunId)
    .some((task) => !["completed", "failed", "cancelled"].includes(task.status));
  if (hasOpenTask) return false;

  const hasPendingDecision = store.listDecisionCards(turn.flowId)
    .some((card) => card.workRunId === workRunId && card.status === "pending");
  if (hasPendingDecision) return false;

  const hasPendingSpecApproval = store.listSpecApprovals(turn.flowId)
    .some((approval) => approval.workRunId === workRunId && approval.status === "pending");
  if (hasPendingSpecApproval) return false;

  const hasActivePlanRun = store.listPlanRuns(turn.flowId)
    .some((run) => run.workRunId === workRunId && ["running", "blocked", "paused_for_feedback"].includes(run.status));
  if (hasActivePlanRun) return false;

  return !store.listAgentSessions(turn.flowId).some((session) =>
    session.workRunId === workRunId && (session.status === "queued" || session.status === "streaming")
  );
}

export function isWorkRunAwaitingPlanFeedback(store: Store, workRunId: string): boolean {
  const turn = store.getWorkRun(workRunId);
  if (!turn || turn.status !== "executing") return false;

  const hasPausedRun = store.listPlanRuns(turn.flowId)
    .some((run) => run.workRunId === workRunId && run.status === "paused_for_feedback");
  if (!hasPausedRun) return false;

  const hasActiveTask = store.listWorkRunTasks(workRunId)
    .some((task) => task.status === "in_progress");
  if (hasActiveTask) return false;

  return !store.listAgentSessions(turn.flowId).some((session) =>
    session.workRunId === workRunId && (session.status === "queued" || session.status === "streaming")
  );
}

export function pauseWorkRunIfAwaitingPlanFeedback(store: Store, workRunId: string) {
  if (!isWorkRunAwaitingPlanFeedback(store, workRunId)) return undefined;
  return store.waitWorkRunForUserAction(workRunId);
}

export async function completeWorkRunIfSettled(input: {
  store: Store;
  eventBus: EventBus;
  workRunId: string;
  logId?: string;
}) {
  if (!isWorkRunSettled(input.store, input.workRunId)) return undefined;
  saveWorkRunDiffArtifacts(input.store, input.workRunId);
  const completed = input.store.completeWorkRun(input.workRunId);
  if (completed) {
    finalizeWorkRunReview(input.store, completed.flowId, completed.id, completed.completedAt);
    await publishWorkRunEvent(input.eventBus, completed, input.logId);
  }
  return completed;
}

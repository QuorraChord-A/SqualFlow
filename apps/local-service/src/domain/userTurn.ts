import type { Store } from "../db/store.js";
import type { EventBus } from "../ws/eventBus.js";
import { finalizeUserTurnReview } from "./userTurnReview.js";
import { saveUserTurnDiffArtifacts } from "../runtime/userTurnLifecycle.js";

export type UserTurnRow = ReturnType<Store["listUserTurns"]>[number];

export function userTurnDto(turn: UserTurnRow) {
  return {
    id: turn.id,
    user_turn_id: turn.id,
    flow_id: turn.flowId,
    trigger_message_id: turn.triggerMessageId,
    status: turn.status,
    started_at: turn.startedAt,
    active_started_at: turn.activeStartedAt,
    active_duration_ms: turn.activeDurationMs,
    waiting_started_at: turn.waitingStartedAt,
    completed_at: turn.completedAt,
    work_source: turn.workSource,
    spec_revision_id: turn.specRevisionId,
    target_project_id: turn.targetProjectId,
    work_root_path: turn.workRootPath,
    input_snapshot_json: turn.inputSnapshotJson,
    flow_status: ["completed", "failed", "cancelled"].includes(turn.status) ? "idle" : "active",
    created_at: turn.createdAt,
    updated_at: turn.updatedAt,
  };
}

export async function publishUserTurnEvent(
  eventBus: EventBus,
  turn: UserTurnRow,
  logId?: string,
) {
  await eventBus.publish(turn.flowId, {
    type: "user_turn:event",
    flow_id: turn.flowId,
    ...(logId ? { log_id: logId } : {}),
    data: userTurnDto(turn),
  });
}

export function isUserTurnSettled(store: Store, userTurnId: string): boolean {
  const turn = store.getUserTurn(userTurnId);
  if (!turn || turn.status !== "active") return false;
  const hasOpenTask = store.listUserTurnTasks(userTurnId)
    .some((task) => !["completed", "failed", "cancelled"].includes(task.status));
  if (hasOpenTask) return false;

  const hasPendingDecision = store.listDecisionCards(turn.flowId)
    .some((card) => card.userTurnId === userTurnId && card.status === "pending");
  if (hasPendingDecision) return false;

  const hasPendingSpecApproval = store.listSpecApprovals(turn.flowId)
    .some((approval) => approval.userTurnId === userTurnId && approval.status === "pending");
  if (hasPendingSpecApproval) return false;

  const hasActivePlanRun = store.listPlanRuns(turn.flowId)
    .some((run) => run.userTurnId === userTurnId && ["running", "blocked", "paused_for_feedback"].includes(run.status));
  if (hasActivePlanRun) return false;

  return !store.listAgentSessions(turn.flowId).some((session) =>
    session.userTurnId === userTurnId && (session.status === "queued" || session.status === "streaming")
  );
}

export function isUserTurnAwaitingPlanFeedback(store: Store, userTurnId: string): boolean {
  const turn = store.getUserTurn(userTurnId);
  if (!turn || turn.status !== "active") return false;

  const hasPausedRun = store.listPlanRuns(turn.flowId)
    .some((run) => run.userTurnId === userTurnId && run.status === "paused_for_feedback");
  if (!hasPausedRun) return false;

  const hasActiveTask = store.listUserTurnTasks(userTurnId)
    .some((task) => ["queued_for_expert", "recovery_pending", "in_progress"].includes(task.status));
  if (hasActiveTask) return false;

  return !store.listAgentSessions(turn.flowId).some((session) =>
    session.userTurnId === userTurnId && (session.status === "queued" || session.status === "streaming")
  );
}

export function pauseUserTurnIfAwaitingPlanFeedback(store: Store, userTurnId: string) {
  if (!isUserTurnAwaitingPlanFeedback(store, userTurnId)) return undefined;
  return store.pauseUserTurnForUserAction(userTurnId);
}

export async function completeUserTurnIfSettled(input: {
  store: Store;
  eventBus: EventBus;
  userTurnId: string;
  logId?: string;
}) {
  if (!isUserTurnSettled(input.store, input.userTurnId)) return undefined;
  saveUserTurnDiffArtifacts(input.store, input.userTurnId);
  const completed = input.store.completeUserTurn(input.userTurnId);
  if (completed) {
    finalizeUserTurnReview(input.store, completed.flowId, completed.id, completed.completedAt);
    await publishUserTurnEvent(input.eventBus, completed, input.logId);
  }
  return completed;
}

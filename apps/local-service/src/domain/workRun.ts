import type { CanonicalTimelineItem, Store } from "../db/store.js";
import type { ChatJournal } from "../ws/chatJournal.js";
import type { EventBus } from "../ws/eventBus.js";
import { cleanupPreparedWorkRunReview, prepareWorkRunReview } from "./workRunReview.js";

export type WorkRunRow = ReturnType<Store["listWorkRuns"]>[number];

function timelineItemDto(item: CanonicalTimelineItem) {
  return {
    id: item.itemId,
    position: item.position,
    type: item.itemType,
    lifecycle: item.lifecycle,
    message_id: item.messageId,
    session_id: item.sessionId,
    agent_session_id: item.agentSessionId,
    work_run_id: item.workRunId,
    presentation_turn_id: item.presentationTurnId,
    message_kind: item.messageKind,
    payload: item.payload,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

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
  chatJournal?: ChatJournal;
  workRunId: string;
  terminalMessageId?: string | null;
  logId?: string;
}) {
  if (!isWorkRunSettled(input.store, input.workRunId)) return undefined;
  return finalizeWorkRun({ ...input, terminalStatus: "completed" });
}

export async function finalizeWorkRun(input: {
  store: Store;
  eventBus: EventBus;
  chatJournal?: ChatJournal;
  workRunId: string;
  terminalStatus: "completed" | "failed" | "cancelled";
  terminalMessageId?: string | null;
  logId?: string;
}) {
  const existing = input.store.getWorkRun(input.workRunId);
  if (!existing) return undefined;
  if (["completed", "failed", "cancelled"].includes(existing.status)) return existing;
  const completedAt = new Date().toISOString();
  const prepared = prepareWorkRunReview(
    input.store,
    existing.flowId,
    existing.id,
    completedAt,
  );
  const finalized = input.store.finalizeWorkRunWithReview({
    workRunId: existing.id,
    expectedRevision: existing.revision,
    terminalStatus: input.terminalStatus,
    timestamp: completedAt,
    reviewStatus: prepared.review.status,
    reviewJson: JSON.stringify(prepared.review),
    anchorMessageId: input.terminalMessageId,
  });
  if (!finalized) return undefined;
  cleanupPreparedWorkRunReview(input.store, prepared);
  const review = input.store.getWorkRunReview(existing.id);
  if (input.chatJournal && review?.anchorMessageId) {
    const channelId = `leader:${existing.flowId}`;
    const terminalItem = input.chatJournal.getTimelineItems(existing.flowId, channelId)
      .find((item) => item.itemId === review.anchorMessageId && item.messageKind === "work-run-terminal");
    if (terminalItem) {
      await input.eventBus.publish(existing.flowId, {
        type: "session:transcript_event",
        flow_id: existing.flowId,
        session_id: channelId,
        data: {
          stream_epoch: input.chatJournal.getStreamEpoch(),
          cursor: input.chatJournal.getCursor(existing.flowId, channelId),
          timeline_items: [timelineItemDto(terminalItem)],
          event: { type: "message-added", message: terminalItem.payload },
        },
      });
    }
  }
  await publishWorkRunEvent(input.eventBus, finalized, input.logId);
  return finalized;
}

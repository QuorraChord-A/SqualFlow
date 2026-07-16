import type { Store } from "../db/store.js";
import { isUserTurnAwaitingPlanFeedback } from "../domain/userTurn.js";
import { summarizeUserTurnDiff, type UserTurnBaseline } from "./userTurnDiff.js";

export function saveUserTurnDiffArtifacts(store: Store, userTurnId: string) {
  const turn = store.getUserTurn(userTurnId);
  if (!turn?.workRootPath || !turn.inputSnapshotJson) return;
  const existingTypes = new Set(store.listArtifacts(turn.flowId)
    .filter((artifact) => artifact.userTurnId === userTurnId)
    .map((artifact) => artifact.type));
  if (existingTypes.has("changed_files") && existingTypes.has("diff_summary")) return;

  let baseline: UserTurnBaseline | undefined;
  try {
    baseline = (JSON.parse(turn.inputSnapshotJson) as { diff_baseline?: UserTurnBaseline }).diff_baseline;
  } catch {
    return;
  }
  if (!baseline) return;
  const diff = summarizeUserTurnDiff(turn.workRootPath, baseline);
  if (!existingTypes.has("changed_files")) store.createArtifact({
    flowId: turn.flowId,
    userTurnId: turn.id,
    type: "changed_files",
    title: "Changed files",
    content: JSON.stringify(diff.changedFiles),
  });
  if (!existingTypes.has("diff_summary")) store.createArtifact({
    flowId: turn.flowId,
    userTurnId: turn.id,
    type: "diff_summary",
    title: "Diff summary",
    content: diff.text,
  });
}

export function listUserTurnsNeedingRecovery(store: Store) {
  return store.listFlows().flatMap((flow) => {
    const turn = store.getOpenUserTurn(flow.id);
    if (!turn || turn.status !== "active") return [];
    if (isUserTurnAwaitingPlanFeedback(store, turn.id)) return [];
    const waiting = store.listDecisionCards(flow.id).some((card) => card.userTurnId === turn.id && card.status === "pending")
      || store.listSpecApprovals(flow.id).some((approval) => approval.userTurnId === turn.id && approval.status === "pending");
    const running = store.listAgentSessions(flow.id).some((session) =>
      session.userTurnId === turn.id && (session.status === "queued" || session.status === "streaming")
    );
    const expertRecovery = store.listUserTurnTasks(turn.id).some((task) => {
      if (!task.flowExpertId || !task.agentSessionId || !task.expertId) return false;
      const session = store.getAgentSession(task.agentSessionId);
      const flowExpert = store.getFlowExpert(task.flowExpertId);
      if (
        !session
        || !flowExpert
        || session.flowId !== task.flowId
        || session.userTurnId !== task.userTurnId
        || session.taskId !== task.id
        || session.flowExpertId !== flowExpert.id
        || session.expertId !== task.expertId
        || flowExpert.flowId !== task.flowId
        || flowExpert.expertId !== task.expertId
      ) return false;
      return (task.status === "queued_for_expert" && session.status === "queued")
        || (task.status === "in_progress" && session.status === "streaming")
        || (task.status === "recovery_pending" && session.status === "interrupted");
    });
    return waiting || running || expertRecovery ? [] : [turn];
  });
}

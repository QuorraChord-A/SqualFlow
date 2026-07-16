import type { Store } from "../../src/db/store.js";

export function createWorkingUserTurn(
  store: Store,
  flowId: string,
  input: { source?: "spec" | "direct_message"; specRevisionId?: string | null; inputSnapshotJson?: string } = {},
) {
  let flow = store.getFlow(flowId);
  if (!flow) throw new Error(`Flow not found: ${flowId}`);
  if (!flow.projectId) {
    const project = store.createProject({ name: `Project ${flowId}`, localPath: `/tmp/${flowId}` });
    flow = store.updateFlow(flowId, { projectId: project.id })!;
  }
  const turn = store.createUserTurn({ flowId, triggerMessageId: `msg-${flowId}-${Date.now()}` });
  if (!turn) throw new Error(`An open UserTurn already exists for Flow ${flowId}`);
  const started = store.startUserTurnWork({
    flowId,
    userTurnId: turn.id,
    workSource: input.source ?? "direct_message",
    specRevisionId: input.specRevisionId ?? null,
    targetProjectId: flow.projectId!,
    inputSnapshotJson: input.inputSnapshotJson ?? "{}",
  });
  if (!started) throw new Error(`Unable to start UserTurn work: ${turn.id}`);
  return started;
}

export function beginUserTurn(store: Store, input: Record<string, unknown> & { flowId: string }) {
  return createWorkingUserTurn(store, input.flowId, {
    source: input.source === "spec" ? "spec" : "direct_message",
    specRevisionId: typeof input.specRevisionId === "string" ? input.specRevisionId : null,
    inputSnapshotJson: typeof input.inputSnapshotJson === "string" ? input.inputSnapshotJson : "{}",
  });
}

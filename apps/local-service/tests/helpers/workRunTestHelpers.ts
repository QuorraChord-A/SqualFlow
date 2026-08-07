import type { Store } from "../../src/db/store.js";

export function createWorkingWorkRun(
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
  const turn = store.createWorkRun({ flowId, triggerMessageId: `msg-${flowId}-${Date.now()}` });
  if (!turn) throw new Error(`An open WorkRun already exists for Flow ${flowId}`);
  const started = store.startWorkRunWork({
    flowId,
    workRunId: turn.id,
    workSource: input.source ?? "direct_message",
    specRevisionId: input.specRevisionId ?? null,
    targetProjectId: flow.projectId!,
    inputSnapshotJson: input.inputSnapshotJson ?? "{}",
  });
  if (!started) throw new Error(`Unable to start WorkRun work: ${turn.id}`);
  const executing = store.startWorkRunExecution(turn.id);
  if (!executing) throw new Error(`Unable to begin WorkRun execution: ${turn.id}`);
  return executing;
}

export function beginWorkRun(store: Store, input: Record<string, unknown> & { flowId: string }) {
  return createWorkingWorkRun(store, input.flowId, {
    source: input.source === "spec" ? "spec" : "direct_message",
    specRevisionId: typeof input.specRevisionId === "string" ? input.specRevisionId : null,
    inputSnapshotJson: typeof input.inputSnapshotJson === "string" ? input.inputSnapshotJson : "{}",
  });
}

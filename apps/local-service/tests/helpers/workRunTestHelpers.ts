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
  // This legacy fixture represents a WorkRun whose collaboration phase has
  // already begun. Production enters this state atomically with the first
  // Task-backed Expert dispatch; tests that need a prepared-only WorkRun call
  // createWorkRun/startWorkRunWork directly.
  const executionStartedAt = new Date().toISOString();
  store.sqlite.prepare(`
    UPDATE work_runs
    SET status = 'executing', revision = revision + 1,
        execution_started_at = ?, active_started_at = ?, updated_at = ?
    WHERE id = ?
  `).run(executionStartedAt, executionStartedAt, executionStartedAt, turn.id);
  return store.getWorkRun(turn.id)!;
}

export function beginWorkRun(store: Store, input: Record<string, unknown> & { flowId: string }) {
  return createWorkingWorkRun(store, input.flowId, {
    source: input.source === "spec" ? "spec" : "direct_message",
    specRevisionId: typeof input.specRevisionId === "string" ? input.specRevisionId : null,
    inputSnapshotJson: typeof input.inputSnapshotJson === "string" ? input.inputSnapshotJson : "{}",
  });
}

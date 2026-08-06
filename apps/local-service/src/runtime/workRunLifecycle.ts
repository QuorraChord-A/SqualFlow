import type { Store } from "../db/store.js";
import { summarizeWorkRunDiff, type WorkRunBaseline } from "./workRunDiff.js";

export function saveWorkRunDiffArtifacts(store: Store, workRunId: string) {
  const turn = store.getWorkRun(workRunId);
  if (!turn?.workRootPath || !turn.inputSnapshotJson) return;
  const existingTypes = new Set(store.listArtifacts(turn.flowId)
    .filter((artifact) => artifact.workRunId === workRunId)
    .map((artifact) => artifact.type));
  if (existingTypes.has("changed_files") && existingTypes.has("diff_summary")) return;

  let baseline: WorkRunBaseline | undefined;
  try {
    baseline = (JSON.parse(turn.inputSnapshotJson) as { diff_baseline?: WorkRunBaseline }).diff_baseline;
  } catch {
    return;
  }
  if (!baseline) return;
  const diff = summarizeWorkRunDiff(turn.workRootPath, baseline);
  if (!existingTypes.has("changed_files")) store.createArtifact({
    flowId: turn.flowId,
    workRunId: turn.id,
    type: "changed_files",
    title: "Changed files",
    content: JSON.stringify(diff.changedFiles),
  });
  if (!existingTypes.has("diff_summary")) store.createArtifact({
    flowId: turn.flowId,
    workRunId: turn.id,
    type: "diff_summary",
    title: "Diff summary",
    content: diff.text,
  });
}

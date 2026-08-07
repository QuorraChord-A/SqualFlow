import type { Store } from "../db/store.js";
import {
  changesFromBaseline,
  cleanupChangeBaseline,
  type StoredChangeBaseline,
} from "../runtime/changeBaseline.js";

const MAX_LCS_CELLS = 200_000;

export type WorkRunReviewStatus = "ready" | "empty" | "skipped" | "failed";

export type WorkRunReviewLine = {
  kind: "context" | "added" | "removed";
  old_line: number | null;
  new_line: number | null;
  text: string;
};

export type WorkRunReviewFile = {
  path: string;
  status: "modified" | "added" | "deleted";
  detail_status: "ready" | "binary" | "large" | "unavailable";
  additions: number | null;
  deletions: number | null;
  lines: WorkRunReviewLine[];
};

type WorkRunReviewContent = {
  flow_id: string;
  work_run_id: string;
  status: WorkRunReviewStatus;
  reason?: string;
  completed_at: string | null;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    modified: number;
    added: number;
    deleted: number;
  };
  files: WorkRunReviewFile[];
};

export type WorkRunReview = WorkRunReviewContent & {
  anchor_message_id: string;
};

export type PreparedWorkRunReviewContent = WorkRunReviewContent;

export type PreparedWorkRunReview = {
  review: PreparedWorkRunReviewContent;
  baseline: StoredChangeBaseline | null;
};

function emptyTotals() {
  return { files: 0, additions: 0, deletions: 0, modified: 0, added: 0, deleted: 0 };
}

function unavailableReview(
  flowId: string,
  workRunId: string,
  completedAt: string | null,
  status: "skipped" | "failed",
  reason: string,
): PreparedWorkRunReviewContent {
  return {
    flow_id: flowId,
    work_run_id: workRunId,
    status,
    reason,
    completed_at: completedAt,
    totals: emptyTotals(),
    files: [],
  };
}

/**
 * Computes the authoritative Review for files owned by a WorkRun. The baseline
 * still supplies exact before/after contents, while the execution-owned touched
 * file manifest prevents another concurrent Flow in the same project from
 * leaking into this Review.
 */
export function prepareWorkRunReview(
  store: Store,
  flowId: string,
  workRunId: string,
  completedAt: string | null,
): PreparedWorkRunReview {
  const existing = getWorkRunReview(store, workRunId);
  if (existing) return { review: existing, baseline: store.getChangeBaselineForWorkRun(workRunId) ?? null };

  const baseline = store.getChangeBaselineForWorkRun(workRunId) ?? null;
  if (!baseline) {
    return {
      review: unavailableReview(
        flowId,
        workRunId,
        completedAt,
        "failed",
        "未找到 WorkRun baseline，无法生成完整 Diff。",
      ),
      baseline: null,
    };
  }

  let result: ReturnType<typeof changesFromBaseline>;
  try {
    result = changesFromBaseline(baseline);
  } catch (error) {
    return {
      review: unavailableReview(
        flowId,
        workRunId,
        completedAt,
        "failed",
        error instanceof Error ? error.message : String(error),
      ),
      baseline,
    };
  }
  if (result.status !== "ready") {
    return {
      review: unavailableReview(
        flowId,
        workRunId,
        completedAt,
        result.status,
        result.reason ?? "WorkRun baseline 不可用，无法生成完整 Diff。",
      ),
      baseline,
    };
  }

  const attribution = store.getWorkRunFileAttribution(workRunId);
  const ownedPaths = new Set(attribution?.files.map((file) => file.path) ?? []);
  const ownedChanges = result.changes.filter((change) => ownedPaths.has(change.path));
  const unownedChanges = result.changes.filter((change) => !ownedPaths.has(change.path));
  if (ownedChanges.length === 0 && unownedChanges.length > 0) {
    const attributionReason = attribution?.reason ? `${attribution.reason}；` : "";
    return {
      review: unavailableReview(
        flowId,
        workRunId,
        completedAt,
        "skipped",
        `${attributionReason}检测到 ${unownedChanges.length} 个无法归属到本 WorkRun 的工作区变化，已从 Diff 排除。`,
      ),
      baseline,
    };
  }

  const files = ownedChanges.map((change): WorkRunReviewFile => {
    if (change.detailStatus !== "ready") {
      return {
        path: change.path,
        status: change.status,
        detail_status: change.detailStatus,
        additions: null,
        deletions: null,
        lines: [],
      };
    }
    const lines = diffLines(change.beforeText ?? "", change.afterText ?? "");
    return {
      path: change.path,
      status: change.status,
      detail_status: "ready",
      additions: lines.filter((line) => line.kind === "added").length,
      deletions: lines.filter((line) => line.kind === "removed").length,
      lines,
    };
  });

  const review: PreparedWorkRunReviewContent = {
    flow_id: flowId,
    work_run_id: workRunId,
    status: files.length > 0 ? "ready" : "empty",
    completed_at: completedAt,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      modified: files.filter((file) => file.status === "modified").length,
      added: files.filter((file) => file.status === "added").length,
      deleted: files.filter((file) => file.status === "deleted").length,
    },
    files,
  };
  const warningParts = [
    attribution?.reason ?? "",
    unownedChanges.length > 0
      ? `另有 ${unownedChanges.length} 个不属于本 WorkRun 的工作区变化已排除。`
      : "",
  ].filter(Boolean);
  if (warningParts.length > 0) review.reason = warningParts.join("；");
  return { review, baseline };
}

export function cleanupPreparedWorkRunReview(store: Store, prepared: PreparedWorkRunReview) {
  if (prepared.baseline) cleanupChangeBaseline(store, prepared.baseline);
}

export function getWorkRunReview(store: Store, workRunId: string): WorkRunReview | null {
  const stored = store.getWorkRunReview(workRunId);
  if (!stored) return null;
  try {
    const review = JSON.parse(stored.reviewJson) as WorkRunReview;
    return review.work_run_id === workRunId && typeof review.anchor_message_id === "string" ? review : null;
  } catch {
    return null;
  }
}

export function listWorkRunReviews(store: Store, flowId: string): WorkRunReview[] {
  return store.listWorkRunReviews(flowId).flatMap((stored) => {
    try {
      const review = JSON.parse(stored.reviewJson) as WorkRunReview;
      return review.flow_id === flowId
        && review.work_run_id === stored.workRunId
        && typeof review.anchor_message_id === "string"
        ? [review]
        : [];
    } catch {
      return [];
    }
  });
}

function splitLines(value: string) {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): WorkRunReviewLine[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const leading = oldLines.slice(0, prefix).map((text, index) => contextLine(text, index + 1, index + 1));
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = oldMiddle.length * newMiddle.length > MAX_LCS_CELLS
    ? fallbackDiff(oldMiddle, newMiddle, prefix + 1, prefix + 1)
    : lcsDiff(oldMiddle, newMiddle, prefix + 1, prefix + 1);
  const trailing = oldLines.slice(oldLines.length - suffix).map((text, index) =>
    contextLine(text, oldLines.length - suffix + index + 1, newLines.length - suffix + index + 1)
  );
  return [...leading, ...middle, ...trailing];
}

function contextLine(text: string, oldLine: number, newLine: number): WorkRunReviewLine {
  return { kind: "context", old_line: oldLine, new_line: newLine, text };
}

function fallbackDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): WorkRunReviewLine[] {
  return [
    ...oldLines.map((text, index) => ({ kind: "removed" as const, old_line: oldStart + index, new_line: null, text })),
    ...newLines.map((text, index) => ({ kind: "added" as const, old_line: null, new_line: newStart + index, text })),
  ];
}

function lcsDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): WorkRunReviewLine[] {
  const columns = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * columns);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }

  const lines: WorkRunReviewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push(contextLine(oldLines[i] ?? "", oldStart + i, newStart + j));
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
      lines.push({ kind: "removed", old_line: oldStart + i, new_line: null, text: oldLines[i] ?? "" });
      i += 1;
    } else {
      lines.push({ kind: "added", old_line: null, new_line: newStart + j, text: newLines[j] ?? "" });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    lines.push({ kind: "removed", old_line: oldStart + i, new_line: null, text: oldLines[i] ?? "" });
    i += 1;
  }
  while (j < newLines.length) {
    lines.push({ kind: "added", old_line: null, new_line: newStart + j, text: newLines[j] ?? "" });
    j += 1;
  }
  return lines;
}

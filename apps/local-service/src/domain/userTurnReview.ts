import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { Store } from "../db/store.js";
import type { RuntimeCapability } from "./runtimeCapabilities.js";

const MAX_REVIEW_FILE_BYTES = 1_000_000;
const MAX_LCS_CELLS = 200_000;
const controlledEditCapabilities = new Set<RuntimeCapability>(["write", "edit"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type UserTurnReviewLine = {
  kind: "context" | "added" | "removed";
  old_line: number | null;
  new_line: number | null;
  text: string;
};

export type UserTurnReviewFile = {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  lines: UserTurnReviewLine[];
};

export type UserTurnReview = {
  flow_id: string;
  user_turn_id: string;
  completed_at: string | null;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    modified: number;
    added: number;
    deleted: number;
  };
  files: UserTurnReviewFile[];
};

type PendingControlledEdit = {
  flowId: string;
  userTurnId: string;
  toolUseId: string;
  capability: RuntimeCapability;
  absolutePath: string;
  relativePath: string;
  before: string | null;
};

type DraftFile = {
  relativePath: string;
  before: string | null;
  after: string | null;
};

type DraftReview = {
  flowId: string;
  userTurnId: string;
  files: Map<string, DraftFile>;
};

const pendingEdits = new Map<string, PendingControlledEdit>();
const draftReviews = new Map<string, DraftReview>();

function toolPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function realpathOrResolved(resolvedPath: string): string {
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    const missingTail: string[] = [];
    let cursor = resolvedPath;
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolvedPath;
      missingTail.unshift(path.basename(cursor));
      cursor = parent;
      try {
        return path.join(fs.realpathSync.native(cursor), ...missingTail);
      } catch {
        // Keep walking toward an existing ancestor.
      }
    }
  }
}

function resolveInsideRoot(rootPath: string, inputPath: string) {
  const absolutePath = realpathOrResolved(path.resolve(rootPath, inputPath));
  const absoluteRoot = realpathOrResolved(path.resolve(rootPath));
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath: relativePath.split(path.sep).join("/") };
}

function readTextSnapshot(filePath: string): { content: string | null; skipped: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, skipped: false };
    return { content: null, skipped: true };
  }
  if (!stat.isFile() || stat.size > MAX_REVIEW_FILE_BYTES) return { content: null, skipped: true };
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return { content: null, skipped: true };
  try {
    return { content: utf8Decoder.decode(buffer), skipped: false };
  } catch {
    return { content: null, skipped: true };
  }
}

export function beginControlledEditReview(input: {
  flowId: string;
  userTurnId: string | null | undefined;
  rootPath: string;
  toolName: string;
  capability?: RuntimeCapability | null;
  toolInput: Record<string, unknown>;
  toolUseId: string | null | undefined;
}) {
  const capability = input.capability ?? null;
  if (!input.userTurnId || !input.toolUseId || !capability || !controlledEditCapabilities.has(capability)) return;
  const inputPath = toolPath(input.toolInput);
  if (!inputPath) return;
  const resolved = resolveInsideRoot(input.rootPath, inputPath);
  if (!resolved) return;
  const before = readTextSnapshot(resolved.absolutePath);
  if (before.skipped) return;

  pendingEdits.set(input.toolUseId, {
    flowId: input.flowId,
    userTurnId: input.userTurnId,
    toolUseId: input.toolUseId,
    capability,
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    before: before.content,
  });
}

export function consumeControlledEditToolResults(eventOrRaw: unknown) {
  const raw = eventOrRaw && typeof eventOrRaw === "object" && "raw" in eventOrRaw
    ? (eventOrRaw as { raw: unknown }).raw
    : eventOrRaw;
  for (const result of toolResultBlocks(raw)) {
    const pending = pendingEdits.get(result.toolUseId);
    if (!pending) continue;
    pendingEdits.delete(result.toolUseId);
    if (result.isError) continue;

    const after = readTextSnapshot(pending.absolutePath);
    if (after.skipped) continue;
    const draft = draftReviews.get(pending.userTurnId) ?? {
      flowId: pending.flowId,
      userTurnId: pending.userTurnId,
      files: new Map<string, DraftFile>(),
    };
    const file = draft.files.get(pending.absolutePath) ?? {
      relativePath: pending.relativePath,
      before: pending.before,
      after: pending.before,
    };
    file.after = after.content;
    draft.files.set(pending.absolutePath, file);
    draftReviews.set(pending.userTurnId, draft);
  }
}

export function finalizeUserTurnReview(
  store: Store,
  flowId: string,
  userTurnId: string,
  completedAt: string | null,
) {
  for (const [toolUseId, pending] of pendingEdits) {
    if (pending.userTurnId === userTurnId) pendingEdits.delete(toolUseId);
  }

  const draft = draftReviews.get(userTurnId);
  draftReviews.delete(userTurnId);
  if (!draft) {
    store.deleteLatestUserTurnReview(flowId);
    return null;
  }

  const files = [...draft.files.values()]
    .flatMap((file): UserTurnReviewFile[] => {
      if (file.before === file.after) return [];
      if (file.before === null && file.after === null) return [];
      const status = file.before === null
        ? "added"
        : file.after === null
          ? "deleted"
          : "modified";
      const lines = diffLines(file.before ?? "", file.after ?? "");
      const additions = lines.filter((line) => line.kind === "added").length;
      const deletions = lines.filter((line) => line.kind === "removed").length;
      return [{
        path: file.relativePath,
        status,
        additions,
        deletions,
        lines,
      }];
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  if (files.length === 0) {
    store.deleteLatestUserTurnReview(flowId);
    return null;
  }

  const review: UserTurnReview = {
    flow_id: flowId,
    user_turn_id: userTurnId,
    completed_at: completedAt,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      modified: files.filter((file) => file.status === "modified").length,
      added: files.filter((file) => file.status === "added").length,
      deleted: files.filter((file) => file.status === "deleted").length,
    },
    files,
  };
  store.replaceLatestUserTurnReview({
    flowId,
    userTurnId,
    reviewJson: JSON.stringify(review),
  });
  return review;
}

export function latestUserTurnReview(store: Store, flowId: string): UserTurnReview | null {
  const stored = store.getLatestUserTurnReview(flowId);
  if (!stored) return null;
  try {
    const review = JSON.parse(stored.reviewJson) as UserTurnReview;
    return review.flow_id === flowId && review.user_turn_id === stored.userTurnId ? review : null;
  } catch {
    return null;
  }
}

export function clearUserTurnReview(flowId: string, store?: Store) {
  store?.deleteLatestUserTurnReview(flowId);
  for (const [userTurnId, draft] of draftReviews) {
    if (draft.flowId === flowId) draftReviews.delete(userTurnId);
  }
  for (const [toolUseId, pending] of pendingEdits) {
    if (pending.flowId === flowId) pendingEdits.delete(toolUseId);
  }
}

function toolResultBlocks(raw: unknown): Array<{ toolUseId: string; isError: boolean }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const message = record.message;
  const content = message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>).content
    : record.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") return [];
    return [{ toolUseId: item.tool_use_id, isError: item.is_error === true }];
  });
}

function splitLines(value: string) {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(before: string, after: string): UserTurnReviewLine[] {
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

function contextLine(text: string, oldLine: number, newLine: number): UserTurnReviewLine {
  return { kind: "context", old_line: oldLine, new_line: newLine, text };
}

function fallbackDiff(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): UserTurnReviewLine[] {
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
): UserTurnReviewLine[] {
  const columns = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * columns);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }

  const lines: UserTurnReviewLine[] = [];
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

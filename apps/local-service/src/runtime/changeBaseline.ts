import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Store } from "../db/store.js";

const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const MAX_FILES = 20_000;
const MAX_REVIEW_BYTES = 1_000_000;

type SnapshotDetail = "text" | "binary" | "large" | "unavailable";

type BaselineFile = {
  exists: boolean;
  signature: string;
  snapshot?: string;
  detail: SnapshotDetail;
};

export type ChangeBaselineManifest = {
  version: 1;
  kind: "git" | "snapshot";
  root_path: string;
  base_commit?: string;
  files: Record<string, BaselineFile>;
  skipped?: boolean;
};

export type BaselineChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeExists: boolean;
  afterExists: boolean;
  beforeText: string | null;
  afterText: string | null;
  detailStatus: "ready" | "binary" | "large" | "unavailable";
};

export type StoredChangeBaseline = NonNullable<ReturnType<Store["getChangeBaselineByAgentSession"]>>;

function hashBuffer(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotName(relativePath: string) {
  return `${crypto.createHash("sha256").update(relativePath).digest("hex")}.snapshot`;
}

function textBuffer(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function fileState(absolutePath: string, snapshotPath?: string, relativePath?: string): BaselineFile & { text: string | null } {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return { exists: false, signature: "missing", detail: "unavailable", text: null };
    const buffer = fs.readFileSync(absolutePath);
    const signature = hashBuffer(buffer);
    if (buffer.byteLength > MAX_REVIEW_BYTES) {
      return { exists: true, signature, detail: "large", text: null };
    }
    const text = textBuffer(buffer);
    if (text === null) return { exists: true, signature, detail: "binary", text: null };
    const snapshot = snapshotPath && relativePath ? snapshotName(relativePath) : undefined;
    if (snapshot && snapshotPath) fs.writeFileSync(path.join(snapshotPath, snapshot), buffer);
    return { exists: true, signature, ...(snapshot ? { snapshot } : {}), detail: "text", text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, signature: "missing", detail: "text", text: null };
    }
    return { exists: false, signature: "unavailable", detail: "unavailable", text: null };
  }
}

function walkFiles(rootPath: string, dir = rootPath, files: string[] = []): string[] | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!walkFiles(rootPath, absolute, files)) return null;
    } else if (entry.isFile()) {
      files.push(path.relative(rootPath, absolute).split(path.sep).join("/"));
      if (files.length > MAX_FILES) return null;
    }
  }
  return files;
}

function gitOutput(rootPath: string, args: string[]) {
  return execFileSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function parseNulPaths(value: string) {
  return value.split("\0").filter(Boolean);
}

function gitStatusPaths(rootPath: string) {
  const output = execFileSync("git", ["-C", rootPath, "status", "--porcelain", "-z", "--untracked-files=all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const relative = entry.slice(3);
    if (relative) paths.push(relative);
    if (status.includes("R") || status.includes("C")) {
      const originalRelative = entries[index + 1];
      if (originalRelative) paths.push(originalRelative);
      index += 1;
    }
  }
  return paths;
}

function captureManifest(rootPath: string, snapshotPath: string): ChangeBaselineManifest {
  fs.mkdirSync(snapshotPath, { recursive: true });
  let baseCommit: string | null = null;
  try {
    baseCommit = gitOutput(rootPath, ["rev-parse", "HEAD"]);
  } catch {
    baseCommit = null;
  }
  if (baseCommit) {
    const files: Record<string, BaselineFile> = {};
    for (const relative of gitStatusPaths(rootPath)) {
      const state = fileState(path.join(rootPath, relative), snapshotPath, relative);
      files[relative] = {
        exists: state.exists,
        signature: state.signature,
        ...(state.snapshot ? { snapshot: state.snapshot } : {}),
        detail: state.detail,
      };
    }
    return { version: 1, kind: "git", root_path: rootPath, base_commit: baseCommit, files };
  }

  const relativeFiles = walkFiles(rootPath);
  if (!relativeFiles) {
    return { version: 1, kind: "snapshot", root_path: rootPath, files: {}, skipped: true };
  }
  const files: Record<string, BaselineFile> = {};
  for (const relative of relativeFiles.sort()) {
    const state = fileState(path.join(rootPath, relative), snapshotPath, relative);
    files[relative] = {
      exists: state.exists,
      signature: state.signature,
      ...(state.snapshot ? { snapshot: state.snapshot } : {}),
      detail: state.detail,
    };
  }
  return { version: 1, kind: "snapshot", root_path: rootPath, files };
}

export function capturePersistentChangeBaseline(input: {
  store: Store;
  flowId: string;
  sourceAgentSessionId: string;
  workRunId?: string | null;
  rootPath: string;
}) {
  const existing = input.store.getChangeBaselineByAgentSession(input.sourceAgentSessionId);
  if (existing) return existing;
  if (input.workRunId) {
    const workRunBaseline = input.store.getChangeBaselineForWorkRun(input.workRunId);
    if (workRunBaseline) return workRunBaseline;
  }
  const snapshotPath = path.join(config.runtimeScratchRoot, input.flowId, "change-baselines", input.sourceAgentSessionId);
  try {
    const manifest = captureManifest(input.rootPath, snapshotPath);
    return input.store.createChangeBaseline({
      flowId: input.flowId,
      sourceAgentSessionId: input.sourceAgentSessionId,
      workRunId: input.workRunId,
      rootPath: input.rootPath,
      snapshotPath,
      manifestJson: JSON.stringify(manifest),
      status: manifest.skipped ? "skipped" : "ready",
      ...(manifest.skipped ? { errorMessage: `项目文件超过 ${MAX_FILES} 个，未生成完整 Diff。` } : {}),
    });
  } catch (error) {
    return input.store.createChangeBaseline({
      flowId: input.flowId,
      sourceAgentSessionId: input.sourceAgentSessionId,
      workRunId: input.workRunId,
      rootPath: input.rootPath,
      snapshotPath,
      manifestJson: JSON.stringify({ version: 1, kind: "snapshot", root_path: input.rootPath, files: {} }),
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function snapshotText(row: StoredChangeBaseline, entry: BaselineFile): string | null {
  if (!entry.snapshot) return null;
  try {
    return fs.readFileSync(path.join(row.snapshotPath, entry.snapshot), "utf8");
  } catch {
    return null;
  }
}

function gitBaseState(row: StoredChangeBaseline, manifest: ChangeBaselineManifest, relative: string) {
  const dirty = manifest.files[relative];
  if (dirty) return { ...dirty, text: snapshotText(row, dirty) };
  try {
    const buffer = execFileSync("git", ["-C", row.rootPath, "show", `${manifest.base_commit}:${relative}`], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const detail: SnapshotDetail = buffer.byteLength > MAX_REVIEW_BYTES
      ? "large"
      : textBuffer(buffer) === null
        ? "binary"
        : "text";
    return { exists: true, signature: hashBuffer(buffer), detail, text: detail === "text" ? textBuffer(buffer) : null };
  } catch {
    return { exists: false, signature: "missing", detail: "text" as const, text: null };
  }
}

function detailStatus(before: { detail: SnapshotDetail }, after: { detail: SnapshotDetail }): BaselineChange["detailStatus"] {
  if (before.detail === "unavailable" || after.detail === "unavailable") return "unavailable";
  if (before.detail === "large" || after.detail === "large") return "large";
  if (before.detail === "binary" || after.detail === "binary") return "binary";
  return "ready";
}

export function changesFromBaseline(row: StoredChangeBaseline): {
  status: "ready" | "skipped" | "failed";
  reason?: string;
  changes: BaselineChange[];
} {
  if (row.status !== "ready") return { status: row.status, ...(row.errorMessage ? { reason: row.errorMessage } : {}), changes: [] };
  let manifest: ChangeBaselineManifest;
  try {
    manifest = JSON.parse(row.manifestJson) as ChangeBaselineManifest;
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error), changes: [] };
  }
  if (manifest.skipped) return { status: "skipped", reason: row.errorMessage ?? "baseline skipped", changes: [] };

  const candidates = new Set<string>(Object.keys(manifest.files));
  if (manifest.kind === "git" && manifest.base_commit) {
    try {
      for (const relative of parseNulPaths(execFileSync("git", ["-C", row.rootPath, "diff", "--name-only", "-z", manifest.base_commit, "--"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }))) candidates.add(relative);
      for (const relative of parseNulPaths(execFileSync("git", ["-C", row.rootPath, "ls-files", "--others", "--exclude-standard", "-z"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }))) candidates.add(relative);
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error), changes: [] };
    }
  } else {
    const current = walkFiles(row.rootPath);
    if (!current) return { status: "skipped", reason: `项目文件超过 ${MAX_FILES} 个，未生成完整 Diff。`, changes: [] };
    for (const relative of current) candidates.add(relative);
  }

  const changes: BaselineChange[] = [];
  for (const relative of [...candidates].sort()) {
    const before = manifest.kind === "git"
      ? gitBaseState(row, manifest, relative)
      : (() => {
          const entry = manifest.files[relative] ?? { exists: false, signature: "missing", detail: "text" as const };
          return { ...entry, text: snapshotText(row, entry) };
        })();
    const after = fileState(path.join(row.rootPath, relative));
    if (before.signature === after.signature && before.exists === after.exists) continue;
    const status = !before.exists ? "added" : !after.exists ? "deleted" : "modified";
    changes.push({
      path: relative,
      status,
      beforeExists: before.exists,
      afterExists: after.exists,
      beforeText: before.text,
      afterText: after.text,
      detailStatus: detailStatus(before, after),
    });
  }
  return { status: "ready", changes };
}

export function cleanupChangeBaseline(store: Store, row: StoredChangeBaseline) {
  try {
    fs.rmSync(row.snapshotPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; orphan recovery will retry later.
  }
  store.deleteChangeBaseline(row.id);
}

export function cleanupOrphanChangeBaselines(store: Store) {
  let removed = 0;
  const baselines = store.listChangeBaselines();
  for (const baseline of baselines) {
    const session = store.getAgentSession(baseline.sourceAgentSessionId);
    const turn = baseline.workRunId ? store.getWorkRun(baseline.workRunId) : undefined;
    const terminalTurn = turn && ["completed", "failed", "cancelled"].includes(turn.status);
    const abandonedCandidate = !baseline.workRunId
      && (!session || !["queued", "streaming"].includes(session.status));
    const missingBoundWorkRun = Boolean(baseline.workRunId && !turn);
    if (!store.getFlow(baseline.flowId) || !session || missingBoundWorkRun || terminalTurn || abandonedCandidate) {
      cleanupChangeBaseline(store, baseline);
      removed += 1;
    }
  }
  const registeredPaths = new Set(store.listChangeBaselines().map((baseline) => path.resolve(baseline.snapshotPath)));
  let orphanDirectoriesRemoved = 0;
  try {
    for (const flowEntry of fs.readdirSync(config.runtimeScratchRoot, { withFileTypes: true })) {
      if (!flowEntry.isDirectory()) continue;
      const baselineRoot = path.join(config.runtimeScratchRoot, flowEntry.name, "change-baselines");
      if (!fs.existsSync(baselineRoot)) continue;
      for (const snapshotEntry of fs.readdirSync(baselineRoot, { withFileTypes: true })) {
        if (!snapshotEntry.isDirectory()) continue;
        const snapshotPath = path.resolve(baselineRoot, snapshotEntry.name);
        if (registeredPaths.has(snapshotPath)) continue;
        fs.rmSync(snapshotPath, { recursive: true, force: true });
        orphanDirectoriesRemoved += 1;
      }
    }
  } catch {
    // Recovery is best-effort; persisted rows remain authoritative.
  }
  return { removed, orphanDirectoriesRemoved };
}

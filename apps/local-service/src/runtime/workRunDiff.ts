import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { promisify } from "node:util";

export type WorkRunBaseline =
  | { kind: "git"; root_path: string; base_commit: string; files: Record<string, string>; dirty_files?: Record<string, string>; strategy?: "hash" | "status"; skipped?: boolean }
  | { kind: "hash"; root_path: string; files: Record<string, string>; skipped?: boolean };

export type WorkRunDiffSummary = {
  changedFiles: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  text: string;
  filesChangedSkipped?: boolean;
};

const ignoredDirs = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const MAX_HASHED_FILES = 20_000;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const YIELD_EVERY_FILES = 200;
const MISSING_FILE_SIGNATURE = "missing";
const execFileAsync = promisify(execFile);

function gitCommit(rootPath: string): string | null {
  try {
    return execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function gitCommitAsync(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseGitStatus(output: string): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = output.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) files[filePath] = status;
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return files;
}

async function gitStatus(rootPath: string): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync("git", ["-C", rootPath, "status", "--porcelain", "-z", "--untracked-files=all"], {
    encoding: "utf8",
  });
  return parseGitStatus(stdout);
}

function hashFile(filePath: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function fileSignature(filePath: string, stat: fs.Stats) {
  if (stat.size > LARGE_FILE_BYTES) return `stat:${stat.size}:${stat.mtimeMs}`;
  return crypto.createHash("sha256").update(await fs.promises.readFile(filePath)).digest("hex");
}

async function relativeFileSignature(rootPath: string, relative: string) {
  const absolute = path.join(rootPath, relative);
  try {
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile()) return `stat:${stat.size}:${stat.mtimeMs}`;
    return fileSignature(absolute, stat);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
      return MISSING_FILE_SIGNATURE;
    }
    throw error;
  }
}

async function captureGitDirtyFileSignatures(rootPath: string, status: Record<string, string>) {
  const files: Record<string, string> = {};
  const entries = Object.keys(status).sort();
  for (let index = 0; index < entries.length; index += 1) {
    const relative = entries[index]!;
    files[relative] = await relativeFileSignature(rootPath, relative);
    if ((index + 1) % YIELD_EVERY_FILES === 0) await yieldImmediate();
  }
  return files;
}

function walkFiles(rootPath: string, dir = rootPath): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(rootPath, absolute));
    if (entry.isFile()) files.push(path.relative(rootPath, absolute));
  }
  return files.sort();
}

function captureFileHashes(rootPath: string) {
  const files: Record<string, string> = {};
  for (const relative of walkFiles(rootPath)) {
    files[relative] = hashFile(path.join(rootPath, relative));
  }
  return files;
}

async function walkFilesAsync(rootPath: string, dir = rootPath, files: string[] = []): Promise<string[] | null> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const walked = await walkFilesAsync(rootPath, absolute, files);
      if (!walked) return null;
    }
    if (entry.isFile()) {
      files.push(path.relative(rootPath, absolute));
      if (files.length > MAX_HASHED_FILES) return null;
      if (files.length % YIELD_EVERY_FILES === 0) await yieldImmediate();
    }
  }
  return files;
}

async function captureFileHashesAsync(rootPath: string): Promise<{ files: Record<string, string>; skipped?: boolean }> {
  const relativeFiles = await walkFilesAsync(rootPath);
  if (!relativeFiles) return { files: {}, skipped: true };
  relativeFiles.sort();
  const files: Record<string, string> = {};
  for (let index = 0; index < relativeFiles.length; index += 1) {
    const relative = relativeFiles[index]!;
    const absolute = path.join(rootPath, relative);
    files[relative] = await fileSignature(absolute, await fs.promises.stat(absolute));
    if ((index + 1) % YIELD_EVERY_FILES === 0) await yieldImmediate();
  }
  return { files };
}

export function captureWorkRunBaseline(rootPath: string): WorkRunBaseline {
  fs.mkdirSync(rootPath, { recursive: true });
  const files = captureFileHashes(rootPath);
  const baseCommit = gitCommit(rootPath);
  return baseCommit
    ? { kind: "git", root_path: rootPath, base_commit: baseCommit, files }
    : { kind: "hash", root_path: rootPath, files };
}

export async function captureWorkRunBaselineAsync(rootPath: string): Promise<WorkRunBaseline> {
  await fs.promises.mkdir(rootPath, { recursive: true });
  const baseCommit = await gitCommitAsync(rootPath);
  if (baseCommit) {
    const files = await gitStatus(rootPath);
    return {
      kind: "git",
      root_path: rootPath,
      base_commit: baseCommit,
      files,
      dirty_files: await captureGitDirtyFileSignatures(rootPath, files),
      strategy: "status",
    };
  }
  const { files, skipped } = await captureFileHashesAsync(rootPath);
  return { kind: "hash", root_path: rootPath, files, ...(skipped ? { skipped } : {}) };
}

export function summarizeWorkRunDiff(rootPath: string, baseline: WorkRunBaseline): WorkRunDiffSummary {
  if (baseline.skipped) {
    return { changedFiles: [], text: "", filesChangedSkipped: true };
  }
  fs.mkdirSync(rootPath, { recursive: true });
  const current = captureFileHashes(rootPath);
  const changedFiles: WorkRunDiffSummary["changedFiles"] = [];

  for (const [relative, hash] of Object.entries(current)) {
    if (!baseline.files[relative]) changedFiles.push({ path: relative, status: "added" });
    else if (baseline.files[relative] !== hash) changedFiles.push({ path: relative, status: "modified" });
  }
  for (const relative of Object.keys(baseline.files)) {
    if (!current[relative]) changedFiles.push({ path: relative, status: "deleted" });
  }

  changedFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    changedFiles,
    text: changedFiles.map((file) => `${file.status}\t${file.path}`).join("\n"),
  };
}

function statusFromGitStatus(status: string): "added" | "modified" | "deleted" {
  if (status === "??" || status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

function statusFromDirtyTransition(beforeStatus: string, currentStatus: string | undefined, currentSignature: string): "added" | "modified" | "deleted" {
  if (currentSignature === MISSING_FILE_SIGNATURE) return "deleted";
  if (!currentStatus) return "modified";
  if (currentStatus === "??" && beforeStatus === "??") return "modified";
  return statusFromGitStatus(currentStatus);
}

export async function summarizeWorkRunDiffAsync(rootPath: string, baseline: WorkRunBaseline): Promise<WorkRunDiffSummary> {
  if (baseline.skipped) {
    return { changedFiles: [], text: "", filesChangedSkipped: true };
  }
  await fs.promises.mkdir(rootPath, { recursive: true });
  if (baseline.kind === "git" && baseline.strategy === "status") {
    const current = await gitStatus(rootPath);
    const changedFiles: WorkRunDiffSummary["changedFiles"] = [];
    const paths = new Set([...Object.keys(current), ...Object.keys(baseline.files)]);
    for (const relative of paths) {
      const beforeStatus = baseline.files[relative];
      const currentStatus = current[relative];
      if (!beforeStatus) {
        if (currentStatus) changedFiles.push({ path: relative, status: statusFromGitStatus(currentStatus) });
        continue;
      }
      const beforeSignature = baseline.dirty_files?.[relative];
      if (!beforeSignature) continue;
      const currentSignature = await relativeFileSignature(rootPath, relative);
      if (currentSignature !== beforeSignature) {
        changedFiles.push({ path: relative, status: statusFromDirtyTransition(beforeStatus, currentStatus, currentSignature) });
      }
    }
    changedFiles.sort((left, right) => left.path.localeCompare(right.path));
    return {
      changedFiles,
      text: changedFiles.map((file) => `${file.status}\t${file.path}`).join("\n"),
    };
  }

  const current = await captureFileHashesAsync(rootPath);
  if (current.skipped) return { changedFiles: [], text: "", filesChangedSkipped: true };
  const changedFiles: WorkRunDiffSummary["changedFiles"] = [];

  for (const [relative, hash] of Object.entries(current.files)) {
    if (!baseline.files[relative]) changedFiles.push({ path: relative, status: "added" });
    else if (baseline.files[relative] !== hash) changedFiles.push({ path: relative, status: "modified" });
  }
  for (const relative of Object.keys(baseline.files)) {
    if (!current.files[relative]) changedFiles.push({ path: relative, status: "deleted" });
  }

  changedFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    changedFiles,
    text: changedFiles.map((file) => `${file.status}\t${file.path}`).join("\n"),
  };
}

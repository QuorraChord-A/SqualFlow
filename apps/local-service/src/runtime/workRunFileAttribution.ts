import path from "node:path";
import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import type { RuntimeEvent } from "./runtimeEvents.js";
import {
  captureWorkRunBaselineAsync,
  summarizeWorkRunDiffAsync,
  type WorkRunBaseline,
} from "./workRunDiff.js";

export type WorkRunTouchedFileSource = "write" | "edit" | "file_change" | "shell";

export type WorkRunTouchedFileObservation = {
  path: string;
  source: WorkRunTouchedFileSource;
};

export type WorkRunFileAttributionSummary = {
  files: WorkRunTouchedFileObservation[];
  partialReason?: string;
};

type ShellWindow = {
  id: string;
  rootPath: string;
  ownerKey: string;
  baseline: WorkRunBaseline | null;
  foreignExactPaths: Set<string>;
  overlapsForeignShell: boolean;
  captureError: string | null;
};

type ExactWindow = {
  id: string;
  rootPath: string;
  ownerKey: string;
  paths: Set<string>;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeRelativePath(rootPath: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const root = path.resolve(rootPath);
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function exactPathsFromInput(rootPath: string, input: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const key of ["path", "file_path", "filePath"]) {
    const value = stringValue(input[key]);
    if (value) candidates.push(value);
  }
  if (Array.isArray(input.changes)) {
    for (const rawChange of input.changes) {
      const change = recordValue(rawChange);
      if (!change) continue;
      for (const key of ["path", "file_path", "filePath", "from", "to", "old_path", "new_path"]) {
        const value = stringValue(change[key]);
        if (value) candidates.push(value);
      }
    }
  }
  return [...new Set(candidates.flatMap((candidate) => {
    const normalized = normalizeRelativePath(rootPath, candidate);
    return normalized ? [normalized] : [];
  }))].sort();
}

function toolSource(chunk: Extract<UiMessageChunk, { type: "tool-input-available" }>): WorkRunTouchedFileSource | null {
  const provider = chunk.providerToolName?.toLowerCase() ?? "";
  const tool = chunk.toolName.toLowerCase();
  if (chunk.capability === "shell" || provider === "bash" || provider === "commandexecution") return "shell";
  if (provider === "filechange" || tool === "codex_file_change") return "file_change";
  if (chunk.capability === "write" || provider === "write") return "write";
  if (chunk.capability === "edit" || provider === "edit") return "edit";
  return null;
}

function codexCompletedToolId(event: RuntimeEvent): string | null {
  const raw = recordValue(event.raw);
  if (stringValue(raw?.method) !== "item/completed") return null;
  const params = recordValue(raw?.params);
  const item = recordValue(params?.item);
  const type = stringValue(item?.type);
  if (type !== "commandExecution" && type !== "fileChange") return null;
  return stringValue(item?.id) || null;
}

/**
 * Coordinates only attribution windows. It never serializes Flow execution.
 * Exact-path tools can safely overlap. Two Shell windows owned by different
 * Flows are deliberately treated as ambiguous rather than guessed.
 */
export class WorkspaceMutationCoordinator {
  private readonly shellWindows = new Map<string, ShellWindow>();
  private readonly exactWindows = new Map<string, ExactWindow>();

  async beginShell(input: {
    id: string;
    rootPath: string;
    ownerKey: string;
  }): Promise<void> {
    if (this.shellWindows.has(input.id)) return;
    const rootPath = path.resolve(input.rootPath);
    const window: ShellWindow = {
      id: input.id,
      rootPath,
      ownerKey: input.ownerKey,
      baseline: null,
      foreignExactPaths: new Set<string>(),
      overlapsForeignShell: false,
      captureError: null,
    };
    for (const current of this.shellWindows.values()) {
      if (current.rootPath !== rootPath || current.ownerKey === input.ownerKey) continue;
      current.overlapsForeignShell = true;
      window.overlapsForeignShell = true;
    }
    for (const current of this.exactWindows.values()) {
      if (current.rootPath !== rootPath || current.ownerKey === input.ownerKey) continue;
      for (const relativePath of current.paths) window.foreignExactPaths.add(relativePath);
    }
    this.shellWindows.set(input.id, window);
    try {
      window.baseline = await captureWorkRunBaselineAsync(rootPath);
    } catch (error) {
      window.captureError = error instanceof Error ? error.message : String(error);
    }
  }

  beginExact(input: {
    id: string;
    rootPath: string;
    ownerKey: string;
    paths: string[];
  }): void {
    if (this.exactWindows.has(input.id)) return;
    const rootPath = path.resolve(input.rootPath);
    const paths = new Set(input.paths);
    this.exactWindows.set(input.id, { id: input.id, rootPath, ownerKey: input.ownerKey, paths });
    for (const window of this.shellWindows.values()) {
      if (window.rootPath !== rootPath || window.ownerKey === input.ownerKey) continue;
      for (const relativePath of paths) window.foreignExactPaths.add(relativePath);
    }
  }

  endExact(id: string): void {
    this.exactWindows.delete(id);
  }

  async endShell(id: string): Promise<{ paths: string[]; partialReason?: string }> {
    const window = this.shellWindows.get(id);
    if (!window) return { paths: [] };
    try {
      if (window.overlapsForeignShell) {
        return {
          paths: [],
          partialReason: "检测到不同 Flow 的 Shell 文件操作时间重叠，相关变化未归属到任何 WorkRun。",
        };
      }
      if (!window.baseline) {
        return {
          paths: [],
          partialReason: `Shell 文件变化基线捕获失败${window.captureError ? `：${window.captureError}` : ""}`,
        };
      }
      const summary = await summarizeWorkRunDiffAsync(window.rootPath, window.baseline);
      if (summary.filesChangedSkipped) {
        return { paths: [], partialReason: "Shell 文件变化超过快照检测限制，相关变化未归属。" };
      }
      return {
        paths: summary.changedFiles
          .map((file) => file.path.split(path.sep).join("/"))
          .filter((relativePath) => !window.foreignExactPaths.has(relativePath))
          .sort(),
      };
    } catch (error) {
      return {
        paths: [],
        partialReason: `Shell 文件变化检测失败：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      this.shellWindows.delete(id);
    }
  }
}

type ActiveTool = {
  coordinatorId: string;
  source: WorkRunTouchedFileSource;
  rawTerminalOnly: boolean;
};

export class WorkRunToolAttributor {
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly observations = new Map<string, Set<WorkRunTouchedFileSource>>();
  private readonly partialReasons = new Set<string>();

  constructor(
    private readonly coordinator: WorkspaceMutationCoordinator,
    private readonly input: {
      rootPath: string;
      ownerKey: string;
      agentSessionId: string;
    },
  ) {}

  async observe(event: RuntimeEvent, chunks: UiMessageChunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (chunk.type !== "tool-input-available" || this.activeTools.has(chunk.toolCallId)) continue;
      const source = toolSource(chunk);
      if (!source) continue;
      const coordinatorId = `${this.input.agentSessionId}:${chunk.toolCallId}`;
      this.activeTools.set(chunk.toolCallId, {
        coordinatorId,
        source,
        rawTerminalOnly: source === "shell" && chunk.providerToolName === "commandExecution",
      });
      if (source === "shell") {
        await this.coordinator.beginShell({
          id: coordinatorId,
          rootPath: this.input.rootPath,
          ownerKey: this.input.ownerKey,
        });
        continue;
      }
      const paths = exactPathsFromInput(this.input.rootPath, chunk.input);
      this.coordinator.beginExact({
        id: coordinatorId,
        rootPath: this.input.rootPath,
        ownerKey: this.input.ownerKey,
        paths,
      });
      for (const relativePath of paths) this.addObservation(relativePath, source);
    }

    const rawCompletedId = codexCompletedToolId(event);
    if (rawCompletedId) await this.completeTool(rawCompletedId);

    for (const chunk of chunks) {
      if (chunk.type !== "tool-output-available") continue;
      const active = this.activeTools.get(chunk.toolCallId);
      // Codex command output deltas use the same UI chunk as a terminal result.
      // The raw item/completed notification above is its only stable terminator.
      if (active?.rawTerminalOnly) continue;
      await this.completeTool(chunk.toolCallId);
    }
  }

  async finish(): Promise<WorkRunFileAttributionSummary> {
    for (const toolCallId of [...this.activeTools.keys()]) await this.completeTool(toolCallId);
    return {
      files: [...this.observations.entries()]
        .map(([relativePath, sources]) => ({
          path: relativePath,
          source: [...sources].sort()[0]!,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      ...([...this.partialReasons].length > 0
        ? { partialReason: [...this.partialReasons].join("；") }
        : {}),
    };
  }

  private async completeTool(toolCallId: string) {
    const active = this.activeTools.get(toolCallId);
    if (!active) return;
    this.activeTools.delete(toolCallId);
    if (active.source !== "shell") {
      this.coordinator.endExact(active.coordinatorId);
      return;
    }
    const completed = await this.coordinator.endShell(active.coordinatorId);
    for (const relativePath of completed.paths) this.addObservation(relativePath, "shell");
    if (completed.partialReason) this.partialReasons.add(completed.partialReason);
  }

  private addObservation(relativePath: string, source: WorkRunTouchedFileSource) {
    const sources = this.observations.get(relativePath) ?? new Set<WorkRunTouchedFileSource>();
    sources.add(source);
    this.observations.set(relativePath, sources);
  }
}

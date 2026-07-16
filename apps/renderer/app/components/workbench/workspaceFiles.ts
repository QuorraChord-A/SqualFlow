import { API_BASE } from "../../lib/api";

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  has_children: boolean;
  size: number | null;
  modified_at: string;
};

export type WorkspaceDirectoryResponse = {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
};

export async function fetchWorkspaceDirectory(
  flowId: string,
  directoryPath: string,
  signal?: AbortSignal,
): Promise<WorkspaceDirectoryResponse> {
  const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
  const response = await fetch(`${API_BASE}/api/flows/${flowId}/files${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? "Unable to load workspace files");
  }
  return response.json() as Promise<WorkspaceDirectoryResponse>;
}

export function absoluteWorkspacePath(rootPath: string, relativePath: string) {
  const separator = rootPath.includes("\\") && !rootPath.includes("/") ? "\\" : "/";
  const root = rootPath.replace(/[\\/]+$/u, "");
  return `${root}${separator}${relativePath.replaceAll("/", separator)}`;
}

export function workspaceFileUrl(absolutePath: string) {
  const normalized = absolutePath.replaceAll("\\", "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  const encoded = normalized.split("/").map((part, index) =>
    index === 0 && /^[A-Za-z]:$/u.test(part) ? part : encodeURIComponent(part)
  ).join("/");
  return `${prefix}${encoded}`;
}

export async function collectWorkspaceFilePaths(flowId: string, entry: WorkspaceFileEntry): Promise<string[]> {
  if (entry.type === "file") return [entry.path];
  const directory = await fetchWorkspaceDirectory(flowId, entry.path);
  const nested = await Promise.all(directory.entries.map((child) => collectWorkspaceFilePaths(flowId, child)));
  return nested.flat();
}

export async function deleteWorkspaceEntry(flowId: string, entryPath: string) {
  const response = await fetch(`${API_BASE}/api/flows/${flowId}/files?path=${encodeURIComponent(entryPath)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? "Unable to delete workspace entry");
  }
}

export function workspaceFilesStorageKey(flowId: string) {
  return `squadflow-workspace-files:${flowId}`;
}

export const WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY = "squadflow-workspace-file-tree-width";

export function parseWorkspaceFileTreeWidth(raw: string | null) {
  if (raw === null || raw.trim() === "") return 320;
  const width = Number(raw);
  return Number.isFinite(width) ? Math.min(Math.max(width, 192), 720) : 320;
}

export type PersistedWorkspaceFilesState = {
  openFiles: string[];
  activeFile: string | null;
  expandedDirectories: string[];
  treeVisible: boolean;
  treeWidth: number;
};

export function parseWorkspaceFilesState(raw: string | null): PersistedWorkspaceFilesState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceFilesState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const openFiles = Array.isArray(parsed.openFiles)
      ? parsed.openFiles.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const activeFile = typeof parsed.activeFile === "string" && openFiles.includes(parsed.activeFile)
      ? parsed.activeFile
      : openFiles.at(-1) ?? null;
    const expandedDirectories = Array.isArray(parsed.expandedDirectories)
      ? parsed.expandedDirectories.filter((item): item is string => typeof item === "string")
      : [];
    return {
      openFiles,
      activeFile,
      expandedDirectories,
      treeVisible: parsed.treeVisible !== false,
      treeWidth: parseWorkspaceFileTreeWidth(String(parsed.treeWidth ?? "")),
    };
  } catch {
    return null;
  }
}

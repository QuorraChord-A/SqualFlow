"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import WorkspaceFilePreview from "./WorkspaceFilePreview";
import { shouldCollapsePanelDrag } from "../panelSizing";
import {
  absoluteWorkspacePath,
  collectWorkspaceFilePaths,
  deleteWorkspaceEntry,
  fetchWorkspaceDirectory,
  parseWorkspaceFileTreeWidth,
  parseWorkspaceFilesState,
  WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY,
  workspaceFilesStorageKey,
  workspaceFileUrl,
  type WorkspaceFileEntry,
} from "./workspaceFiles";

type DirectoryLoadState = {
  entries: WorkspaceFileEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
};

type TreeRow =
  | { kind: "entry"; entry: WorkspaceFileEntry; depth: number; searchResult: boolean }
  | { kind: "status"; id: string; depth: number; text: string; error: boolean };

type WorkspaceFilesPanelProps = {
  flowId: string | null;
  rootPath: string | null;
  treeAvailable: boolean;
  activeFile?: string | null;
  onOpenFile?: (filePath: string) => void;
  treeVisible?: boolean;
  onTreeVisibleChange?: (visible: boolean) => void;
  onOpenInBrowser?: (url: string) => void;
  onEntryDeleted?: (entryPath: string) => void;
};

type FileContextMenuState = { entry: WorkspaceFileEntry; x: number; y: number };

const EMPTY_DIRECTORY_STATE: DirectoryLoadState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
  truncated: false,
};

function basename(filePath: string) {
  return filePath.split("/").at(-1) ?? filePath;
}

function breadcrumbParts(rootPath: string | null, filePath: string | null) {
  if (!rootPath) return [];
  const rootName = rootPath.split("/").filter(Boolean).at(-1) ?? rootPath;
  return [rootName, ...(filePath ? filePath.split("/").filter(Boolean) : [])];
}

function fileIcon(filePath: string): ReactNode {
  const extension = basename(filePath).split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "json") return <FileJson2 className="size-4 shrink-0 text-amber-500" />;
  if (["md", "mdx", "txt", "log"].includes(extension)) {
    return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  }
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "css", "html", "sh"].includes(extension)) {
    return <Code2 className="size-4 shrink-0 text-sky-500" />;
  }
  return <File className="size-4 shrink-0 text-muted-foreground" />;
}

const MIN_TREE_WIDTH = 192;
const MIN_FILE_PREVIEW_WIDTH = MIN_TREE_WIDTH;
const MAX_TREE_WIDTH_RATIO = 0.6;

function treeMinWidth(containerWidth = 0) {
  if (containerWidth <= 0) return MIN_TREE_WIDTH;
  return Math.min(MIN_TREE_WIDTH, Math.max(0, containerWidth - MIN_FILE_PREVIEW_WIDTH));
}

function treeMaxWidth(containerWidth = 0) {
  if (containerWidth <= 0) return 480;
  const min = treeMinWidth(containerWidth);
  const previewSafeMax = Math.max(0, containerWidth - MIN_FILE_PREVIEW_WIDTH);
  const ratioMax = Math.floor(containerWidth * MAX_TREE_WIDTH_RATIO);
  return Math.max(min, Math.min(ratioMax, previewSafeMax));
}

function clampTreeWidth(width: number, containerWidth = 0) {
  const min = treeMinWidth(containerWidth);
  const max = treeMaxWidth(containerWidth);
  return Math.min(Math.max(Math.round(width), min), max);
}

function buildRows(
  directories: Record<string, DirectoryLoadState>,
  expandedDirectories: Set<string>,
  searchTerm: string,
): TreeRow[] {
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  if (normalizedSearch) {
    const entriesByPath = new Map<string, WorkspaceFileEntry>();
    for (const directory of Object.values(directories)) {
      for (const entry of directory.entries) entriesByPath.set(entry.path, entry);
    }
    return Array.from(entriesByPath.values())
      .filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedSearch))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
        return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
      })
      .map((entry) => ({ kind: "entry", entry, depth: 0, searchResult: true }));
  }

  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const appendDirectory = (directoryPath: string, depth: number) => {
    if (visited.has(directoryPath)) return;
    visited.add(directoryPath);
    const directory = directories[directoryPath];
    if (!directory) return;
    for (const entry of directory.entries) {
      rows.push({ kind: "entry", entry, depth, searchResult: false });
      if (entry.type !== "directory" || !expandedDirectories.has(entry.path)) continue;
      const childState = directories[entry.path];
      if (!childState || childState.loading) {
        rows.push({ kind: "status", id: `${entry.path}:loading`, depth: depth + 1, text: "正在加载…", error: false });
      } else if (childState.error) {
        rows.push({ kind: "status", id: `${entry.path}:error`, depth: depth + 1, text: childState.error, error: true });
      } else if (childState.loaded && childState.entries.length === 0) {
        rows.push({ kind: "status", id: `${entry.path}:empty`, depth: depth + 1, text: "空目录", error: false });
      } else {
        appendDirectory(entry.path, depth + 1);
        if (childState.truncated) {
          rows.push({ kind: "status", id: `${entry.path}:truncated`, depth: depth + 1, text: "仅显示前 1000 项", error: false });
        }
      }
    }
  };

  appendDirectory("", 0);
  return rows;
}

export default function WorkspaceFilesPanel({
  flowId,
  rootPath,
  treeAvailable,
  activeFile: controlledActiveFile,
  onOpenFile,
  treeVisible: controlledTreeVisible,
  onTreeVisibleChange,
  onOpenInBrowser,
  onEntryDeleted,
}: WorkspaceFilesPanelProps) {
  const [directories, setDirectories] = useState<Record<string, DirectoryLoadState>>({});
  const directoriesRef = useRef(directories);
  const pendingPathsRef = useRef(new Set<string>());
  const splitRef = useRef<HTMLDivElement>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [internalActiveFile, setInternalActiveFile] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [internalTreeVisible, setInternalTreeVisible] = useState(true);
  const treeVisible = controlledTreeVisible ?? internalTreeVisible;
  const activeFile = controlledActiveFile ?? internalActiveFile;
  const [treeWidth, setTreeWidth] = useState(() => parseWorkspaceFileTreeWidth(
    typeof window === "undefined" ? null : localStorage.getItem(WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY),
  ));
  const [isTreeResizing, setIsTreeResizing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceFileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const updateTreeVisible = useCallback((visible: boolean) => {
    setInternalTreeVisible(visible);
    onTreeVisibleChange?.(visible);
  }, [onTreeVisibleChange]);

  const updateDirectories = useCallback((updater: (current: Record<string, DirectoryLoadState>) => Record<string, DirectoryLoadState>) => {
    setDirectories((current) => {
      const next = updater(current);
      directoriesRef.current = next;
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (directoryPath: string, force = false) => {
    if (!flowId || !treeAvailable || pendingPathsRef.current.has(directoryPath)) return;
    const current = directoriesRef.current[directoryPath];
    if (!force && current?.loaded) return;

    pendingPathsRef.current.add(directoryPath);
    updateDirectories((state) => ({
      ...state,
      [directoryPath]: {
        ...(state[directoryPath] ?? EMPTY_DIRECTORY_STATE),
        loading: true,
        error: null,
      },
    }));

    try {
      const result = await fetchWorkspaceDirectory(flowId, directoryPath);
      updateDirectories((state) => ({
        ...state,
        [directoryPath]: {
          entries: result.entries,
          loaded: true,
          loading: false,
          error: null,
          truncated: result.truncated,
        },
      }));
    } catch (error) {
      updateDirectories((state) => ({
        ...state,
        [directoryPath]: {
          entries: state[directoryPath]?.entries ?? [],
          loaded: false,
          loading: false,
          error: error instanceof Error ? error.message : "无法加载目录",
          truncated: false,
        },
      }));
    } finally {
      pendingPathsRef.current.delete(directoryPath);
    }
  }, [flowId, treeAvailable, updateDirectories]);

  useEffect(() => {
    const persisted = flowId ? parseWorkspaceFilesState(localStorage.getItem(workspaceFilesStorageKey(flowId))) : null;
    directoriesRef.current = {};
    pendingPathsRef.current.clear();
    setDirectories({});
    setExpandedDirectories(new Set(persisted?.expandedDirectories ?? []));
    setInternalActiveFile(null);
    updateTreeVisible(persisted?.treeVisible ?? true);
    setSearchTerm("");
    setHydrated(true);

    if (flowId && treeAvailable) void loadDirectory("");
  }, [flowId, loadDirectory, treeAvailable, updateTreeVisible]);

  useEffect(() => {
    for (const directoryPath of expandedDirectories) {
      const state = directories[directoryPath];
      if (!state?.loaded && !state?.loading) void loadDirectory(directoryPath);
    }
  }, [directories, expandedDirectories, loadDirectory]);

  useEffect(() => {
    if (!flowId || !hydrated) return;
    localStorage.setItem(workspaceFilesStorageKey(flowId), JSON.stringify({
      expandedDirectories: Array.from(expandedDirectories),
      treeVisible,
    }));
  }, [expandedDirectories, flowId, hydrated, treeVisible]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_FILE_TREE_WIDTH_STORAGE_KEY, String(treeWidth));
  }, [treeWidth]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!treeVisible) return;
    const split = splitRef.current;
    if (!split) return;

    const normalizeTreeWidth = () => {
      const containerWidth = split.getBoundingClientRect().width;
      if (containerWidth <= 0) return;
      setTreeWidth((current) => clampTreeWidth(current, containerWidth));
    };

    normalizeTreeWidth();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(normalizeTreeWidth);
    observer.observe(split);
    return () => observer.disconnect();
  }, [treeVisible]);

  const rows = useMemo(
    () => buildRows(directories, expandedDirectories, searchTerm),
    [directories, expandedDirectories, searchTerm],
  );

  const toggleDirectory = (directoryPath: string) => {
    const willExpand = !expandedDirectories.has(directoryPath);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(directoryPath)) next.delete(directoryPath);
      else next.add(directoryPath);
      return next;
    });
    if (willExpand) void loadDirectory(directoryPath);
  };

  const openFile = (filePath: string) => {
    if (onOpenFile) {
      onOpenFile(filePath);
      return;
    }
    setInternalActiveFile(filePath);
  };

  const refreshTree = async () => {
    setRefreshing(true);
    try {
      const paths = ["", ...Array.from(expandedDirectories)];
      await Promise.all(paths.map((directoryPath) => loadDirectory(directoryPath, true)));
    } finally {
      setRefreshing(false);
    }
  };

  const openEntryContextMenu = (event: MouseEvent<HTMLButtonElement>, entry: WorkspaceFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 224;
    const menuHeight = 240;
    setContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  };

  const copyText = async (text: string, success: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  };

  const copyAllAbsolutePaths = async (entry: WorkspaceFileEntry) => {
    if (!flowId || !rootPath) return;
    const relativePaths = await collectWorkspaceFilePaths(flowId, entry);
    await copyText(relativePaths.map((item) => absoluteWorkspacePath(rootPath, item)).join("\n"), "已复制绝对路径");
  };

  const confirmDelete = async () => {
    if (!flowId || !pendingDelete) return;
    setDeleting(true);
    try {
      await deleteWorkspaceEntry(flowId, pendingDelete.path);
      onEntryDeleted?.(pendingDelete.path);
      setExpandedDirectories((current) => new Set(Array.from(current).filter((item) => item !== pendingDelete.path && !item.startsWith(`${pendingDelete.path}/`))));
      await refreshTree();
      toast.success(`已删除${pendingDelete.type === "directory" ? "文件夹" : "文件"}`);
      setPendingDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const startTreeResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    setIsTreeResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let pendingTreeWidth = rect.right - event.clientX;
    let resizingTree = true;
    let animationFrame: number | null = null;

    const cleanupTreeResize = () => {
      if (!resizingTree) return;
      resizingTree = false;
      setIsTreeResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (resizeHandle.hasPointerCapture?.(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("blur", handleWindowBlur);
    };

    const collapseTreeIfPastThreshold = () => {
      if (!shouldCollapsePanelDrag(pendingTreeWidth, treeMinWidth(rect.width))) return false;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      updateTreeVisible(false);
      cleanupTreeResize();
      return true;
    };

    const applyPendingTreeWidth = () => {
      if (!resizingTree) return;
      animationFrame = null;
      setTreeWidth(clampTreeWidth(pendingTreeWidth, rect.width));
    };

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      if (!resizingTree) return;
      pendingTreeWidth = rect.right - moveEvent.clientX;
      if (collapseTreeIfPastThreshold()) return;
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(applyPendingTreeWidth);
    };
    const handleUp = (upEvent?: globalThis.PointerEvent) => {
      if (!resizingTree) return;
      if (upEvent) pendingTreeWidth = rect.right - upEvent.clientX;
      if (!collapseTreeIfPastThreshold()) {
        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        applyPendingTreeWidth();
        cleanupTreeResize();
      }
    };
    const handleWindowBlur = () => handleUp();
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    window.addEventListener("blur", handleWindowBlur);
  };

  const resizeTreeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const containerWidth = splitRef.current?.getBoundingClientRect().width ?? 0;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setTreeWidth((current) => clampTreeWidth(current + 20, containerWidth));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setTreeWidth((current) => clampTreeWidth(current - 20, containerWidth));
    }
  };

  const rootState = directories[""];

  const treePane = (
    <section data-testid="workspace-file-tree" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="border-b border-border p-3">
        <label className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="筛选文件…"
            aria-label="搜索工作区文件"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div role="tree" aria-label="工作区文件树" className="min-h-0 flex-1 overflow-auto py-2">
        {!treeAvailable ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <FolderTree className="size-6" />
            当前任务未绑定可读取的工作区
          </div>
        ) : rootState?.loading && !rootState.loaded ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在加载文件树
          </div>
        ) : rootState?.error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-destructive">
            <AlertTriangle className="size-5" />
            <span>{rootState.error}</span>
            <button
              type="button"
              onClick={() => void loadDirectory("", true)}
              className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-muted"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {searchTerm ? "没有匹配的已加载文件" : "工作区为空"}
          </div>
        ) : (
          <div className="min-w-max px-1">
            {rows.map((row) => {
              if (row.kind === "status") {
                return (
                  <div
                    key={row.id}
                    className={row.error ? "py-1 text-xs text-destructive" : "py-1 text-xs text-muted-foreground"}
                    style={{ paddingLeft: 12 + row.depth * 18 }}
                  >
                    {row.text}
                  </div>
                );
              }

              const { entry, depth, searchResult } = row;
              const expanded = entry.type === "directory" && expandedDirectories.has(entry.path);
              const selected = entry.type === "file" && activeFile === entry.path;
              const label = entry.type === "directory"
                ? `${expanded ? "折叠" : "展开"}目录 ${entry.path}`
                : `打开文件 ${entry.path}`;
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="treeitem"
                  aria-label={label}
                  aria-expanded={entry.type === "directory" ? expanded : undefined}
                  aria-selected={selected}
                  onClick={() => entry.type === "directory" ? toggleDirectory(entry.path) : openFile(entry.path)}
                  onContextMenu={(event) => openEntryContextMenu(event, entry)}
                  className={`flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-3 text-left text-sm transition-colors hover:bg-muted ${
                    selected ? "bg-muted font-medium text-foreground" : "text-foreground"
                  }`}
                  style={{ paddingLeft: 8 + depth * 18 }}
                >
                  {entry.type === "directory" ? (
                    <>
                      {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                      {expanded ? <FolderOpen className="size-4 shrink-0 text-amber-500" /> : <Folder className="size-4 shrink-0 text-amber-500" />}
                    </>
                  ) : (
                    <>
                      <span className="size-4 shrink-0" />
                      {fileIcon(entry.path)}
                    </>
                  )}
                  <span className="min-w-0 truncate">{searchResult ? entry.path : entry.name}</span>
                </button>
              );
            })}
            {rootState?.truncated ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">根目录仅显示前 1000 项</div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );

  const previewPane = (
    <section
      data-testid="workspace-file-preview-pane"
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      style={{ minWidth: treeVisible ? MIN_FILE_PREVIEW_WIDTH : 0 }}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeFile ? (
          <WorkspaceFilePreview
            flowId={flowId}
            filePath={activeFile}
            showPath={false}
            onOpenInBrowser={rootPath && onOpenInBrowser
              ? () => onOpenInBrowser(workspaceFileUrl(absoluteWorkspacePath(rootPath, activeFile)))
              : undefined}
          />
        ) : (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <FolderTree className="size-8" />
            <div>
              <div className="text-sm font-medium text-foreground">打开文件</div>
              <div className="mt-1 text-xs">从工作区目录树中选择文件</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );

  const filesToolbar = (
    <div data-testid="workspace-files-toolbar" className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3">
      <nav aria-label="当前文件路径" className="flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground" title={rootPath && activeFile ? `${rootPath}/${activeFile}` : rootPath ?? undefined}>
        {breadcrumbParts(rootPath, activeFile).length > 0 ? breadcrumbParts(rootPath, activeFile).map((part, index, parts) => (
          <span key={`${part}:${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            <span className={`truncate ${index === parts.length - 1 ? "font-medium text-foreground" : ""}`}>{part}</span>
          </span>
        )) : "未绑定目标目录"}
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            data-testid="file-tree-visibility-toggle"
            type="button"
            aria-label={treeVisible ? "隐藏文件列表" : "显示文件列表"}
            onClick={() => updateTreeVisible(!treeVisible)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FolderTree className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{treeVisible ? "隐藏文件列表" : "显示文件列表"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            type="button"
            aria-label="刷新文件树"
            onClick={() => void refreshTree()}
            disabled={refreshing || !treeAvailable}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </TooltipTrigger>
          <TooltipContent>刷新文件树</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <>
    <div
      data-testid="workspace-files-shell"
      data-tree-visible={treeVisible ? "true" : "false"}
      data-tree-resizing={isTreeResizing ? "true" : "false"}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {filesToolbar}
      <div
        ref={splitRef}
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        {previewPane}
        <div
          role="separator"
          aria-label="调整文件树宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_TREE_WIDTH}
          aria-valuemax={Math.max(treeWidth, treeMaxWidth())}
          aria-valuenow={treeWidth}
          tabIndex={treeVisible ? 0 : -1}
          onPointerDown={treeVisible ? startTreeResize : undefined}
          onKeyDown={treeVisible ? resizeTreeWithKeyboard : undefined}
          aria-hidden={!treeVisible}
          className={`group relative shrink-0 cursor-col-resize bg-border/60 outline-none focus:bg-primary/50 ${
            isTreeResizing ? "transition-none" : "transition-[width,opacity] duration-300 ease-in-out"
          }`}
          style={{ width: treeVisible ? 5 : 0, opacity: treeVisible ? 1 : 0 }}
        >
          <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
        </div>
        <div
          data-testid="workspace-file-tree-drawer"
          data-state={treeVisible ? "open" : "closed"}
          aria-hidden={!treeVisible}
          className={`shrink-0 overflow-hidden ${isTreeResizing ? "transition-none" : "transition-[width] duration-300 ease-in-out"}`}
          style={{
            width: treeVisible ? treeWidth : 0,
            minWidth: treeVisible ? MIN_TREE_WIDTH : 0,
            maxWidth: treeVisible ? `min(${MAX_TREE_WIDTH_RATIO * 100}%, calc(100% - ${MIN_FILE_PREVIEW_WIDTH}px))` : 0,
          }}
        >
          <div className={`h-full transition-[opacity,transform] duration-200 ease-out ${treeVisible ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0"}`}>
            {treePane}
          </div>
        </div>
      </div>
    </div>
    {contextMenu && rootPath ? createPortal(
      <div
        role="menu"
        aria-label="文件操作菜单"
        className="fixed z-[100] w-56 overflow-hidden rounded-lg border border-border/80 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {[
          ["复制全部绝对路径", () => copyAllAbsolutePaths(contextMenu.entry)],
          ["复制相对路径", () => copyText(contextMenu.entry.path, "已复制相对路径")],
          ["复制文件名", () => copyText(contextMenu.entry.name, "已复制文件名")],
        ].map(([label, action]) => (
          <button key={label as string} type="button" role="menuitem" className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { setContextMenu(null); void (action as () => Promise<void>)(); }}>
            {label as string}
          </button>
        ))}
        <div className="my-1 h-px bg-border/70" />
        <button
          type="button"
          role="menuitem"
          disabled={contextMenu.entry.type !== "file" || !onOpenInBrowser}
          className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setContextMenu(null);
            onOpenInBrowser?.(workspaceFileUrl(absoluteWorkspacePath(rootPath, contextMenu.entry.path)));
          }}
        >
          在内置浏览器打开
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!window.squadflowDesktopShell?.showItemInFolder}
          className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setContextMenu(null);
            void window.squadflowDesktopShell?.showItemInFolder?.(
              absoluteWorkspacePath(rootPath, contextMenu.entry.path),
              contextMenu.entry.type === "directory",
            );
          }}
        >
          在 Finder 中显示
        </button>
        <div className="my-1 h-px bg-border/70" />
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
          onClick={() => {
            setPendingDelete(contextMenu.entry);
            setContextMenu(null);
          }}
        >
          <Trash2 className="size-4" />
          删除{contextMenu.entry.type === "directory" ? "文件夹" : "文件"}
        </button>
      </div>,
      document.body,
    ) : null}
    <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除{pendingDelete?.type === "directory" ? "文件夹" : "文件"}</AlertDialogTitle>
          <AlertDialogDescription>
            确认删除“{pendingDelete?.name}”？此操作不可撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

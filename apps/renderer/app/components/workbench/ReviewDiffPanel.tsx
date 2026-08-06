"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderTree, Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WorkRunReview, WorkRunReviewFile } from "../../hooks/useFlowWorkbench";
import UnifiedDiff from "./UnifiedDiff";

type ReviewDiffPanelProps = {
  review: WorkRunReview | null;
};

function statClassName(kind: "additions" | "deletions") {
  return kind === "additions"
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-red-700 dark:text-red-400";
}

function statusLabel(status: WorkRunReviewFile["status"]) {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function statusClassName(status: WorkRunReviewFile["status"]) {
  if (status === "added") return "text-emerald-700 dark:text-emerald-400";
  if (status === "deleted") return "text-red-700 dark:text-red-400";
  return "text-sky-700 dark:text-sky-300";
}

function fileName(path: string) {
  return path.split("/").at(-1) || path;
}

function groupName(path: string) {
  return path.includes("/") ? path.split("/", 1)[0] || "." : ".";
}

function ReviewFileCard({ file }: { file: WorkRunReviewFile }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-card/35" data-testid="review-file-card">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 border-b border-border/70 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <FileText className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.path}</span>
        <span className={statClassName("additions")}>+{file.additions}</span>
        <span className={statClassName("deletions")}>-{file.deletions}</span>
      </button>
      {expanded ? (
        <div className="max-h-[560px] overflow-auto bg-background/45 font-mono">
          <UnifiedDiff lines={file.lines} lineNumbers="single" />
        </div>
      ) : null}
    </section>
  );
}

function ReviewFileList({ files }: { files: WorkRunReviewFile[] }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const grouped = useMemo(() => {
    const filtered = normalizedQuery
      ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
      : files;
    const groups = new Map<string, WorkRunReviewFile[]>();
    for (const file of filtered) {
      const name = groupName(file.path);
      groups.set(name, [...(groups.get(name) ?? []), file]);
    }
    return [...groups.entries()];
  }, [files, normalizedQuery]);

  return (
    <aside data-testid="review-file-list" className="flex min-h-0 w-[292px] shrink-0 flex-col border-l border-border/70 bg-background/55">
      <div className="border-b border-border/70 p-3">
        <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground">
          <Search className="size-4" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选文件..."
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {grouped.map(([group, groupFiles]) => (
          <div key={group} className="mb-3">
            <div className="mb-1 flex items-center gap-1 px-2 text-xs font-semibold text-muted-foreground">
              <ChevronDown className="size-3.5" />
              <span className="truncate">{group}</span>
            </div>
            <div className="space-y-1">
              {groupFiles.map((file) => (
                <div
                  key={file.path}
                  className="grid grid-cols-[22px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60"
                >
                  <span className={`font-semibold ${statusClassName(file.status)}`}>{statusLabel(file.status)}</span>
                  <span className="truncate text-muted-foreground" title={file.path}>{fileName(file.path)}</span>
                  <span className={statClassName("additions")}>+{file.additions}</span>
                  <span className={statClassName("deletions")}>-{file.deletions}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {grouped.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配文件</div>
        ) : null}
      </div>
    </aside>
  );
}

export default function ReviewDiffPanel({ review }: ReviewDiffPanelProps) {
  const [fileListVisible, setFileListVisible] = useState(true);

  if (!review) {
    return (
      <div data-testid="review-diff-empty" className="flex h-full items-center justify-center px-8 text-sm text-muted-foreground">
        暂无本轮审核内容
      </div>
    );
  }

  return (
    <div
      data-testid="review-diff-panel"
      data-file-list-visible={fileListVisible ? "true" : "false"}
      className="flex h-full min-h-0 bg-background"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/70 px-4">
          <h2 className="text-sm font-semibold">本轮对话</h2>
          <span className={statClassName("additions")}>+{review.totals.additions}</span>
          <span className={statClassName("deletions")}>-{review.totals.deletions}</span>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1">修改 {review.totals.modified}</span>
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1">新增 {review.totals.added}</span>
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1">删除 {review.totals.deleted}</span>
            <Tooltip>
              <TooltipTrigger
                data-testid="review-file-list-visibility-toggle"
                type="button"
                aria-label={fileListVisible ? "隐藏文件列表" : "显示文件列表"}
                onClick={() => setFileListVisible((visible) => !visible)}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FolderTree className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{fileListVisible ? "隐藏文件列表" : "显示文件列表"}</TooltipContent>
            </Tooltip>
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {review.files.map((file) => (
            <ReviewFileCard key={file.path} file={file} />
          ))}
        </div>
      </div>
      {fileListVisible ? <ReviewFileList files={review.files} /> : null}
    </div>
  );
}

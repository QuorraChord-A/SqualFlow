"use client";

import { useMemo, useState } from "react";
import { FileDiff, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ChangeSetFile, ChangeSetView } from "../../hooks/useFlowWorkbench";

export interface ChangeSetDiffPanelProps {
  changeSet: ChangeSetView | null;
}

function statusLabel(status: ChangeSetFile["status"]) {
  if (status === "added") return "新增";
  if (status === "deleted") return "删除";
  return "修改";
}

function FilePatch({ file }: { file: ChangeSetFile }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-card/35" data-testid="change-set-file-card">
      <header className="flex items-center gap-3 border-b border-border/70 px-3 py-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-semibold">{statusLabel(file.status)}</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={file.path}>{file.path}</span>
        <span className="text-emerald-600 dark:text-emerald-400">+{file.additions ?? "—"}</span>
        <span className="text-red-600 dark:text-red-400">-{file.deletions ?? "—"}</span>
      </header>
      <pre className="max-h-[520px] overflow-auto whitespace-pre p-3 font-mono text-[12px] leading-5">
        {file.patch || "该文件没有可显示的文本 Diff。"}
      </pre>
    </section>
  );
}

export default function ChangeSetDiffPanel({ changeSet }: ChangeSetDiffPanelProps) {
  const [fileListVisible, setFileListVisible] = useState(true);
  const totals = useMemo(() => (changeSet?.files ?? []).reduce(
    (result, file) => ({
      additions: result.additions + (file.additions ?? 0),
      deletions: result.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  ), [changeSet]);

  if (!changeSet) {
    return <div data-testid="change-set-diff-empty" className="flex h-full items-center justify-center px-8 text-sm text-muted-foreground">尚未产生文件变更</div>;
  }

  return (
    <div data-testid="change-set-diff-panel" className="flex h-full min-h-0 bg-background">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-xs">
          <FileDiff className="size-4" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{changeSet.title}</h2>
          <span className="text-emerald-600 dark:text-emerald-400">+{totals.additions}</span>
          <span className="text-red-600 dark:text-red-400">-{totals.deletions}</span>
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1">{changeSet.status}</span>
          <button type="button" aria-label={fileListVisible ? "隐藏变更文件列表" : "显示变更文件列表"} onClick={() => setFileListVisible((value) => !value)} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted">
            {fileListVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </button>
        </header>
        {changeSet.partial_reason ? <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">{changeSet.partial_reason}</div> : null}
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {changeSet.files.length > 0 ? changeSet.files.map((file) => <FilePatch key={file.path} file={file} />) : <div className="py-12 text-center text-sm text-muted-foreground">此 ChangeSet 没有文件变化</div>}
        </div>
      </main>
      {fileListVisible ? (
        <aside className="flex min-h-0 w-[280px] shrink-0 flex-col border-l border-border/70 bg-background/55">
          <div className="border-b border-border/70 px-3 py-2 text-xs font-semibold">变更文件</div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {changeSet.files.map((file) => <div key={file.path} className="truncate rounded px-2 py-1.5 text-xs" title={file.path}>{file.path}</div>)}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

"use client";

import type { ArtifactData } from "../../hooks/useDashboardData";

export default function ArtifactListPanel({ artifacts }: { artifacts: ArtifactData[] }) {
  if (artifacts.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">暂无产物</div>;
  }

  return (
    <div className="p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">产物</div>
      {artifacts.map((artifact) => (
        <article key={artifact.id} className="border-b border-border py-2">
          <div className="text-xs text-muted-foreground">{artifact.artifact_type}</div>
          <div className="truncate text-sm font-semibold text-foreground">{artifact.title}</div>
          <div className="mt-1 line-clamp-3 text-xs text-muted-foreground">{artifact.content ?? ""}</div>
        </article>
      ))}
    </div>
  );
}

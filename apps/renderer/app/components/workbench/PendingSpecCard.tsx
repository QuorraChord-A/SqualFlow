"use client";

import { wsClient } from "../../lib/ws";

export interface PendingSpecCardProps {
  flowId: string;
  card: {
    spec_approval_id: string;
    spec_revision_id: string;
    file_name: string;
    overview: string;
    status: "pending" | "approved" | "cancelled";
  };
  onOpenSpec?: (specRevisionId: string, title: string) => void;
}

export default function PendingSpecCard({ flowId, card, onOpenSpec }: PendingSpecCardProps) {
  const isPending = card.status === "pending";
  return (
    <div
      data-testid={`spec-card-${card.spec_approval_id}`}
      className="rounded-md border border-border bg-background/70 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Spec {card.file_name}</div>
          <div className="mt-2 text-sm text-muted-foreground">{card.overview}</div>
          <button
            type="button"
            onClick={() => onOpenSpec?.(card.spec_revision_id, card.file_name)}
            className="mt-3 inline-flex cursor-pointer items-center rounded-md px-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            查看详情
          </button>
        </div>
        <div className="flex shrink-0 items-center">
          {isPending ? (
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
              onClick={() => wsClient.sendRunSpec(flowId, card.spec_approval_id)}
            >
              批准并执行
            </button>
          ) : (
            <span className="text-sm text-muted-foreground">
              {card.status === "approved" ? "已运行" : "已取消"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

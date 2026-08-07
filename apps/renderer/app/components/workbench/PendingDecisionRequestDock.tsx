"use client";

import { CircleStop } from "lucide-react";
import DecisionRequestCard from "../DecisionRequestCard";
import type { DecisionRequestCardData } from "../../hooks/useDashboardData";
import { cn } from "@/lib/utils";

export interface PendingDecisionRequestDockProps {
  flowId: string | null;
  cards: DecisionRequestCardData[];
  onStopCurrentTurn?: () => void;
  className?: string;
}

export default function PendingDecisionRequestDock({ flowId, cards, onStopCurrentTurn, className }: PendingDecisionRequestDockProps) {
  const pendingCards = cards.filter((card) => card.status === "pending");

  if (flowId === null || pendingCards.length === 0) {
    return null;
  }

  return (
    <div data-testid="pending-decision-dock" className={cn("space-y-3", className)}>
      {pendingCards.map((card) => (
        <DecisionRequestCard key={card.decision_request_id} card={card} flowId={flowId} />
      ))}
      {onStopCurrentTurn ? (
        <div className="flex items-center justify-end gap-3 px-2">
          <span className="text-xs text-muted-foreground">仅停止当前 Leader 运行</span>
          <button
            type="button"
            aria-label="停止当前 Leader"
            onClick={onStopCurrentTurn}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-700/35 bg-background px-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-700/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700/40 dark:border-red-400/40 dark:text-red-400 dark:hover:bg-red-400/10 dark:focus-visible:ring-red-400/40"
          >
            <CircleStop className="size-3.5" />
            停止 Leader
          </button>
        </div>
      ) : null}
    </div>
  );
}

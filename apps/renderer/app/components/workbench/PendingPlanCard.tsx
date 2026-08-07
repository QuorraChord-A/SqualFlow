"use client";

import { wsClient } from "../../lib/ws";
import type { PlanCardState } from "../../hooks/useDashboardData";
import { useState } from "react";

export interface PendingPlanCardProps {
  flowId: string;
  card: PlanCardState;
  onOpenPlan?: (planRevisionId: string, title: string) => void;
}

export default function PendingPlanCard({ flowId, card, onOpenPlan }: PendingPlanCardProps) {
  const isPending = card.status === "pending";
  const [feedback, setFeedback] = useState("");
  return (
    <div
      data-testid={`plan-card-${card.plan_approval_id}`}
      className="rounded-md border border-border bg-background/70 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">计划 · {card.title}</div>
          <div className="mt-2 text-sm text-muted-foreground">{card.overview}</div>
          <button
            type="button"
            onClick={() => onOpenPlan?.(card.plan_revision_id, card.title)}
            className="mt-3 inline-flex cursor-pointer items-center rounded-md px-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            查看详情
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isPending ? (
            <>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium"
                onClick={() => wsClient.send({ type: "plan:resolve", flow_id: flowId, plan_approval_id: card.plan_approval_id, resolution: "rejected", feedback: feedback.trim() || "请修改计划", client_action_id: `plan-revise-${Date.now()}` })}
              >
                要求修改
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                onClick={() => wsClient.send({ type: "plan:resolve", flow_id: flowId, plan_approval_id: card.plan_approval_id, resolution: "approved", client_action_id: `plan-approve-${Date.now()}` })}
              >
                批准计划
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {card.status === "approved" ? "已批准" : card.status === "rejected" ? "已要求修改" : "已取消"}
            </span>
          )}
        </div>
      </div>
      {isPending ? (
        <textarea
          aria-label="计划修改意见"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="可选：说明希望如何修改计划"
          className="mt-3 min-h-16 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      ) : null}
    </div>
  );
}

"use client";

import { GitBranch, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OrchestrationPlanView } from "../../types/orchestration";
import OrchestrationPlanGraph from "./OrchestrationPlanGraph";

function statusLabel(plan: OrchestrationPlanView) {
  if (plan.approval?.status === "pending") return "等待审批";
  if (plan.approval?.status === "approved") return "已批准";
  if (plan.approval?.status === "rejected") return "已拒绝";
  if (plan.approval?.status === "cancelled") return "已取消";
  if (plan.revision.approval_mode_snapshot === "automatic") return "自动执行";
  return plan.revision.status;
}

export default function OrchestrationPlanCard({
  plan,
  onOpenPlan,
  onApprove,
}: {
  plan: OrchestrationPlanView;
  onOpenPlan: (plan: OrchestrationPlanView) => void;
  onApprove: (plan: OrchestrationPlanView) => void;
}) {
  return (
    <article data-testid={`orchestration-plan-card-${plan.revision.orchestration_revision_id}`} className="mt-4 overflow-hidden rounded-xl border border-ui-border-strong bg-card/75 shadow-[var(--ui-shadow-elevated)]">
      <header className="flex items-center justify-between border-b border-ui-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{plan.revision.title}</span>
          <span className="text-[11px] text-muted-foreground">v{plan.revision.revision_number}</span>
        </div>
        <Badge variant="outline">{statusLabel(plan)}</Badge>
      </header>
      <div className="h-[190px] bg-ui-sunken/35">
        <OrchestrationPlanGraph compact orchestrationNodes={plan.nodes} />
      </div>
      <footer className="flex items-center gap-2 border-t border-ui-border-subtle px-3 py-3">
        {plan.approval ? (
          <Button type="button" size="sm" disabled={plan.approval.status !== "pending"} onClick={() => onApprove(plan)}>
            <Play />{plan.approval.status === "pending" ? "批准编排" : statusLabel(plan)}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => onOpenPlan(plan)}>
          查看完整编排
        </Button>
      </footer>
    </article>
  );
}

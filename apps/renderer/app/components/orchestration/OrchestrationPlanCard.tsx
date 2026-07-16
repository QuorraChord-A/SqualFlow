"use client";

import { GitBranch, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OrchestrationPlanView } from "../../types/orchestration";
import OrchestrationPlanGraph from "./OrchestrationPlanGraph";

function statusLabel(plan: OrchestrationPlanView) {
  if (plan.approval?.status === "feedback_pending") return "反馈处理中";
  if (plan.run?.status === "completed") return "已完成";
  if (plan.run?.status === "cancelled") return "已取消";
  if (plan.run?.status === "failed") return "执行失败";
  if (plan.run?.status === "running") return "执行中";
  if (plan.run?.status === "blocked") return "已阻塞";
  if (plan.run?.status === "paused_for_feedback") return "反馈暂停";
  if (plan.approval?.status === "pending") return "等待审批";
  if (["approved", "auto_approved"].includes(plan.approval?.status ?? "")) return "已批准";
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
  const canApprove = plan.approval?.status === "pending";
  return (
    <article data-testid={`orchestration-plan-card-${plan.revision.plan_revision_id}`} className="mt-4 overflow-hidden rounded-xl border border-ui-border-strong bg-card/75 shadow-[var(--ui-shadow-elevated)]">
      <header className="flex items-center justify-between border-b border-ui-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{plan.revision.title}</span>
          <span className="text-[11px] text-muted-foreground">v{plan.revision.revision_number}</span>
        </div>
        <Badge variant="outline">{statusLabel(plan)}</Badge>
      </header>
      <div className="h-[190px] bg-ui-sunken/35">
        <OrchestrationPlanGraph compact planNodes={plan.nodes} />
      </div>
      <footer className="flex items-center gap-2 border-t border-ui-border-subtle px-3 py-3">
        <Button type="button" size="sm" disabled={!canApprove} onClick={() => onApprove(plan)}>
          <Play />{canApprove ? "批准并执行" : statusLabel(plan)}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onOpenPlan(plan)}>
          查看完整计划
        </Button>
      </footer>
    </article>
  );
}

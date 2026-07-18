"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { CheckCircle2, Pencil, Play } from "lucide-react";
import { API_BASE } from "../../lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { OrchestrationPlanView, PlanNodeView } from "../../types/orchestration";
import { usePlanFeedbackStore } from "../../stores/usePlanFeedbackStore";
import OrchestrationPlanGraph from "./OrchestrationPlanGraph";

function expertLabel(expertId: string) {
  if (expertId === "exp-research") return "Research";
  if (expertId === "exp-coder") return "Coder";
  if (expertId === "exp-verify") return "Verify";
  if (expertId === "exp-codereview") return "CodeReview";
  return expertId;
}

function AnnotationEditor({
  open,
  onOpenChange,
  label,
  quote,
  initialValue,
  onSave,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  quote?: string;
  initialValue: string;
  onSave: (comment: string) => void;
  trigger: ReactElement;
}) {
  const [comment, setComment] = useState(initialValue);
  useEffect(() => { if (open) setComment(initialValue); }, [initialValue, open]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side="bottom" align="end" className="w-[380px] gap-3 p-3">
        <div><div className="text-sm font-semibold">添加计划评论</div><div className="mt-1 truncate text-xs text-muted-foreground">{label}</div></div>
        {quote ? <blockquote className="max-h-28 overflow-y-auto rounded-lg border border-border bg-muted/45 px-3 py-2 text-xs leading-5 text-foreground/80">“{quote}”</blockquote> : null}
        <Textarea autoFocus rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="说明希望 Leader 如何调整…" />
        <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button size="sm" disabled={!comment.trim()} onClick={() => { onSave(comment.trim()); onOpenChange(false); }}>确认到输入框</Button></div>
      </PopoverContent>
    </Popover>
  );
}

export default function OrchestrationPlanPanel({
  flowId,
  initialPlan,
  onApprove,
}: {
  flowId: string;
  initialPlan: OrchestrationPlanView;
  onApprove: (plan: OrchestrationPlanView) => void;
}) {
  const [history, setHistory] = useState<OrchestrationPlanView[]>([initialPlan]);
  const [selectedRevisionId, setSelectedRevisionId] = useState(initialPlan.revision.plan_revision_id);
  const [selectedNodeId, setSelectedNodeId] = useState(initialPlan.nodes[0]?.plan_node_id ?? "");
  const [annotationTarget, setAnnotationTarget] = useState<string | "plan" | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<{ nodeId: string; text: string } | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const activePlanIdRef = useRef(initialPlan.plan_id);
  const latestRevisionNumberRef = useRef(initialPlan.revision.revision_number);
  const drafts = usePlanFeedbackStore((state) => state.drafts);
  const upsertDraft = usePlanFeedbackStore((state) => state.upsertDraft);
  useEffect(() => {
    if (activePlanIdRef.current !== initialPlan.plan_id) {
      activePlanIdRef.current = initialPlan.plan_id;
      latestRevisionNumberRef.current = initialPlan.revision.revision_number;
      setHistory([initialPlan]);
      setSelectedRevisionId(initialPlan.revision.plan_revision_id);
      setSelectedNodeId(initialPlan.nodes[0]?.plan_node_id ?? "");
      setAnnotationTarget(null);
      setSelectedQuote(null);
      return;
    }
    setHistory((current) => {
      const exists = current.some((item) => item.revision.plan_revision_id === initialPlan.revision.plan_revision_id);
      return exists
        ? current.map((item) => item.revision.plan_revision_id === initialPlan.revision.plan_revision_id ? initialPlan : item)
        : [...current, initialPlan];
    });
    if (initialPlan.revision.revision_number > latestRevisionNumberRef.current) {
      latestRevisionNumberRef.current = initialPlan.revision.revision_number;
      setSelectedRevisionId(initialPlan.revision.plan_revision_id);
      setSelectedNodeId(initialPlan.nodes[0]?.plan_node_id ?? "");
      setAnnotationTarget(null);
      setSelectedQuote(null);
    }
  }, [initialPlan]);
  useEffect(() => {
    let stale = false;
    void fetch(`${API_BASE}/api/flows/${flowId}/orchestration-plans`)
      .then((response) => response.ok ? response.json() : [])
      .then((data) => {
        if (stale || !Array.isArray(data)) return;
        const revisions = (data as OrchestrationPlanView[])
          .filter((item) => item.plan_id === initialPlan.plan_id)
          .sort((left, right) => left.revision.revision_number - right.revision.revision_number);
        if (revisions.length > 0) setHistory(revisions);
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [flowId, initialPlan.plan_id]);
  const plan = history.find((item) => item.revision.plan_revision_id === selectedRevisionId) ?? initialPlan;
  const isCurrentRevision = plan.revision.plan_revision_id === initialPlan.revision.plan_revision_id;
  const draftFor = (nodeId: string | null) => drafts.find((draft) => draft.planRevisionId === plan.revision.plan_revision_id && draft.planNodeId === nodeId);
  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    window.requestAnimationFrame(() => cardRefs.current[nodeId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const dependencies = useMemo(() => new Map(plan.nodes.map((node) => [node.plan_node_id, node.title])), [plan.nodes]);
  const saveFeedback = (node: PlanNodeView | null, comment: string, quote?: string) => upsertDraft({
    flowId,
    planRevisionId: plan.revision.plan_revision_id,
    planNodeId: node?.plan_node_id ?? null,
    targetLabel: node ? `任务「${node.title}」` : `编排计划「${plan.revision.title}」`,
    comment: quote ? `引用：\n“${quote}”\n\n评论：\n${comment}` : comment,
  });
  const openSelectedTextFeedback = (node: PlanNodeView, event: MouseEvent<HTMLElement>) => {
    if (!isCurrentRevision || (event.target as HTMLElement).closest("button,textarea,input")) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection?.anchorNode || !selection.focusNode || !text) return;
    if (!event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
    setSelectedNodeId(node.plan_node_id);
    setSelectedQuote({ nodeId: node.plan_node_id, text });
    setAnnotationTarget(node.plan_node_id);
  };
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="orchestration-plan-panel">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">{plan.revision.title}</h1><div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span>v{plan.revision.revision_number}</span><Badge variant="outline">{plan.approval?.status ?? plan.revision.status}</Badge></div></div>
        <div className="flex shrink-0 items-center gap-2">
          {isCurrentRevision ? <AnnotationEditor open={annotationTarget === "plan"} onOpenChange={(open) => setAnnotationTarget(open ? "plan" : null)} label={plan.revision.title} initialValue={draftFor(null)?.comment ?? ""} onSave={(comment) => saveFeedback(null, comment)} trigger={<Button type="button" size="icon-sm" variant="outline" aria-label="评论整个计划"><Pencil /></Button>} /> : <Badge variant="secondary">历史版本只读</Badge>}
          <Button size="sm" disabled={plan.approval?.status !== "pending"} onClick={() => onApprove(plan)}>{plan.run?.status === "completed" ? <CheckCircle2 /> : <Play />}{plan.approval?.status === "pending" ? "批准并执行" : plan.approval?.status === "feedback_pending" ? "反馈处理中" : "已处理"}</Button>
        </div>
      </header>
      {history.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2 text-xs"><span className="text-muted-foreground">历史版本</span>{history.map((item) => <button key={item.revision.plan_revision_id} type="button" onClick={() => setSelectedRevisionId(item.revision.plan_revision_id)} className={`rounded-md px-2 py-1 ${item.revision.plan_revision_id === plan.revision.plan_revision_id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}>v{item.revision.revision_number}</button>)}</div>
      ) : null}
      <div className="h-[300px] shrink-0 border-b border-border bg-ui-sunken/35"><OrchestrationPlanGraph planNodes={plan.nodes} selectedNodeId={selectedNodeId} onSelectNode={selectNode} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {(plan.revision.diff.added?.length || plan.revision.diff.removed?.length || plan.revision.diff.modified?.length) ? <div className="mb-4 rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">相对上一版：新增 {plan.revision.diff.added?.length ?? 0} · 删除 {plan.revision.diff.removed?.length ?? 0} · 修改 {plan.revision.diff.modified?.length ?? 0}</div> : null}
        <div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">全部 Expert 与任务详情</h2><p className="mt-1 text-xs text-muted-foreground">选中文字添加引用评论，或点击铅笔评论整个任务。</p></div><Badge variant="secondary">{plan.nodes.length} 个任务</Badge></div>
        <div className="grid gap-3">
          {plan.nodes.map((node, index) => {
            const draft = draftFor(node.plan_node_id);
            const selected = selectedNodeId === node.plan_node_id;
            return (
              <article key={node.plan_node_id} ref={(element) => { cardRefs.current[node.plan_node_id] = element; }} onClick={() => setSelectedNodeId(node.plan_node_id)} onMouseUp={(event) => openSelectedTextFeedback(node, event)} className={`relative rounded-xl border bg-card/75 p-4 transition-colors ${draft ? "border-primary ring-2 ring-primary/15" : selected ? "border-foreground/35" : "border-border hover:border-foreground/25"}`}>
                {draft ? <span className="absolute -right-2 -top-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow">{draft.markerNumber}</span> : null}
                <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs font-bold">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Badge variant="outline">{expertLabel(node.expert_id)}</Badge><span className="text-[11px] text-muted-foreground">{node.task?.status ?? "计划中"}</span></div><h3 className="mt-2 text-sm font-semibold">{node.title}</h3></div>
                  {isCurrentRevision ? <AnnotationEditor open={annotationTarget === node.plan_node_id} onOpenChange={(open) => { setAnnotationTarget(open ? node.plan_node_id : null); if (!open) setSelectedQuote(null); }} label={node.title} quote={selectedQuote?.nodeId === node.plan_node_id ? selectedQuote.text : undefined} initialValue={selectedQuote?.nodeId === node.plan_node_id ? "" : draft?.comment ?? ""} onSave={(comment) => saveFeedback(node, comment, selectedQuote?.nodeId === node.plan_node_id ? selectedQuote.text : undefined)} trigger={<Button type="button" size="icon-sm" variant="ghost" aria-label={`评论此任务：${node.title}`} title="评论此任务" onClick={() => setSelectedQuote(null)}><Pencil /></Button>} /> : null}
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground/85">{node.description}</p>
                <div className="mt-3 grid gap-3 border-t border-border/70 pt-3 text-xs sm:grid-cols-2"><div><div className="font-semibold text-muted-foreground">依赖</div><div className="mt-1">{node.depends_on_node_ids.length ? node.depends_on_node_ids.map((id) => dependencies.get(id) ?? id).join("、") : "无，可立即执行"}</div></div><div><div className="font-semibold text-muted-foreground">验收标准</div><div className="mt-1">{node.acceptance_criteria.join("；")}</div></div></div>
                {(node.risk_tags.length > 0 || node.side_effects.length > 0) ? <div className="mt-3 text-xs text-muted-foreground">风险：{[...node.risk_tags, ...node.side_effects].join("、")}</div> : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

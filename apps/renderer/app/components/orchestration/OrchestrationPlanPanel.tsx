"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { Pencil, Play } from "lucide-react";
import { API_BASE } from "../../lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { OrchestrationPlanView, OrchestrationNodeView } from "../../types/orchestration";
import { useOrchestrationFeedbackStore } from "../../stores/useOrchestrationFeedbackStore";
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
  const [selectedRevisionId, setSelectedRevisionId] = useState(initialPlan.revision.orchestration_revision_id);
  const [selectedNodeId, setSelectedNodeId] = useState(initialPlan.nodes[0]?.orchestration_node_id ?? "");
  const [annotationTarget, setAnnotationTarget] = useState<string | "plan" | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<{ nodeId: string; text: string } | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const activePlanIdRef = useRef(initialPlan.orchestration_plan_id);
  const latestRevisionNumberRef = useRef(initialPlan.revision.revision_number);
  const drafts = useOrchestrationFeedbackStore((state) => state.drafts);
  const upsertDraft = useOrchestrationFeedbackStore((state) => state.upsertDraft);
  useEffect(() => {
    if (activePlanIdRef.current !== initialPlan.orchestration_plan_id) {
      activePlanIdRef.current = initialPlan.orchestration_plan_id;
      latestRevisionNumberRef.current = initialPlan.revision.revision_number;
      setHistory([initialPlan]);
      setSelectedRevisionId(initialPlan.revision.orchestration_revision_id);
      setSelectedNodeId(initialPlan.nodes[0]?.orchestration_node_id ?? "");
      setAnnotationTarget(null);
      setSelectedQuote(null);
      return;
    }
    setHistory((current) => {
      const exists = current.some((item) => item.revision.orchestration_revision_id === initialPlan.revision.orchestration_revision_id);
      return exists
        ? current.map((item) => item.revision.orchestration_revision_id === initialPlan.revision.orchestration_revision_id ? initialPlan : item)
        : [...current, initialPlan];
    });
    if (initialPlan.revision.revision_number > latestRevisionNumberRef.current) {
      latestRevisionNumberRef.current = initialPlan.revision.revision_number;
      setSelectedRevisionId(initialPlan.revision.orchestration_revision_id);
      setSelectedNodeId(initialPlan.nodes[0]?.orchestration_node_id ?? "");
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
          .filter((item) => item.orchestration_plan_id === initialPlan.orchestration_plan_id)
          .sort((left, right) => left.revision.revision_number - right.revision.revision_number);
        if (revisions.length > 0) setHistory(revisions);
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [flowId, initialPlan.orchestration_plan_id]);
  const plan = history.find((item) => item.revision.orchestration_revision_id === selectedRevisionId) ?? initialPlan;
  const isCurrentRevision = plan.revision.orchestration_revision_id === initialPlan.revision.orchestration_revision_id;
  const draftFor = (nodeId: string | null) => drafts.find((draft) => draft.orchestrationRevisionId === plan.revision.orchestration_revision_id && draft.orchestrationNodeId === nodeId);
  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    window.requestAnimationFrame(() => cardRefs.current[nodeId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const dependencies = useMemo(() => new Map(plan.nodes.map((node) => [node.orchestration_node_id, node.title])), [plan.nodes]);
  const saveFeedback = (node: OrchestrationNodeView | null, comment: string, quote?: string) => upsertDraft({
    flowId,
    orchestrationRevisionId: plan.revision.orchestration_revision_id,
    orchestrationNodeId: node?.orchestration_node_id ?? null,
    targetLabel: node ? `任务「${node.title}」` : `编排计划「${plan.revision.title}」`,
    comment: quote ? `引用：\n“${quote}”\n\n评论：\n${comment}` : comment,
  });
  const openSelectedTextFeedback = (node: OrchestrationNodeView, event: MouseEvent<HTMLElement>) => {
    if (!isCurrentRevision || (event.target as HTMLElement).closest("button,textarea,input")) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!selection?.anchorNode || !selection.focusNode || !text) return;
    if (!event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
    setSelectedNodeId(node.orchestration_node_id);
    setSelectedQuote({ nodeId: node.orchestration_node_id, text });
    setAnnotationTarget(node.orchestration_node_id);
  };
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="orchestration-plan-panel">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">{plan.revision.title}</h1><div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span>v{plan.revision.revision_number}</span><Badge variant="outline">{plan.approval?.status ?? plan.revision.status}</Badge></div></div>
        <div className="flex shrink-0 items-center gap-2">
          {isCurrentRevision ? <AnnotationEditor open={annotationTarget === "plan"} onOpenChange={(open) => setAnnotationTarget(open ? "plan" : null)} label={plan.revision.title} initialValue={draftFor(null)?.comment ?? ""} onSave={(comment) => saveFeedback(null, comment)} trigger={<Button type="button" size="icon-sm" variant="outline" aria-label="评论整个计划"><Pencil /></Button>} /> : <Badge variant="secondary">历史版本只读</Badge>}
          {plan.approval ? <Button size="sm" disabled={plan.approval.status !== "pending"} onClick={() => onApprove(plan)}><Play />{plan.approval.status === "pending" ? "批准编排" : "已处理"}</Button> : null}
        </div>
      </header>
      {history.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2 text-xs"><span className="text-muted-foreground">历史版本</span>{history.map((item) => <button key={item.revision.orchestration_revision_id} type="button" onClick={() => setSelectedRevisionId(item.revision.orchestration_revision_id)} className={`rounded-md px-2 py-1 ${item.revision.orchestration_revision_id === plan.revision.orchestration_revision_id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}>v{item.revision.revision_number}</button>)}</div>
      ) : null}
      <div className="h-[300px] shrink-0 border-b border-border bg-ui-sunken/35"><OrchestrationPlanGraph orchestrationNodes={plan.nodes} selectedNodeId={selectedNodeId} onSelectNode={selectNode} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">全部 Expert 与任务详情</h2><p className="mt-1 text-xs text-muted-foreground">选中文字添加引用评论，或点击铅笔评论整个任务。</p></div><Badge variant="secondary">{plan.nodes.length} 个任务</Badge></div>
        <div className="grid gap-3">
          {plan.nodes.map((node, index) => {
            const draft = draftFor(node.orchestration_node_id);
            const selected = selectedNodeId === node.orchestration_node_id;
            return (
              <article key={node.orchestration_node_id} ref={(element) => { cardRefs.current[node.orchestration_node_id] = element; }} onClick={() => setSelectedNodeId(node.orchestration_node_id)} onMouseUp={(event) => openSelectedTextFeedback(node, event)} className={`relative rounded-xl border bg-card/75 p-4 transition-colors ${draft ? "border-primary ring-2 ring-primary/15" : selected ? "border-foreground/35" : "border-border hover:border-foreground/25"}`}>
                {draft ? <span className="absolute -right-2 -top-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow">{draft.markerNumber}</span> : null}
                <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs font-bold">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Badge variant="outline">{expertLabel(node.recommended_agent_definition_id)}</Badge><span className="text-[11px] text-muted-foreground">{node.task?.status ?? "计划中"}</span></div><h3 className="mt-2 text-sm font-semibold">{node.title}</h3></div>
                  {isCurrentRevision ? <AnnotationEditor open={annotationTarget === node.orchestration_node_id} onOpenChange={(open) => { setAnnotationTarget(open ? node.orchestration_node_id : null); if (!open) setSelectedQuote(null); }} label={node.title} quote={selectedQuote?.nodeId === node.orchestration_node_id ? selectedQuote.text : undefined} initialValue={selectedQuote?.nodeId === node.orchestration_node_id ? "" : draft?.comment ?? ""} onSave={(comment) => saveFeedback(node, comment, selectedQuote?.nodeId === node.orchestration_node_id ? selectedQuote.text : undefined)} trigger={<Button type="button" size="icon-sm" variant="ghost" aria-label={`评论此任务：${node.title}`} title="评论此任务" onClick={() => setSelectedQuote(null)}><Pencil /></Button>} /> : null}
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground/85">{node.description}</p>
                <div className="mt-3 grid gap-3 border-t border-border/70 pt-3 text-xs sm:grid-cols-2"><div><div className="font-semibold text-muted-foreground">依赖</div><div className="mt-1">{node.depends_on_node_ids.length ? node.depends_on_node_ids.map((id) => dependencies.get(id) ?? id).join("、") : "无，可立即执行"}</div></div><div><div className="font-semibold text-muted-foreground">验收标准</div><div className="mt-1">{node.acceptance_criteria.join("；")}</div></div></div>
                {Object.keys(node.metadata).length > 0 ? <div className="mt-3 text-xs text-muted-foreground">元数据：{JSON.stringify(node.metadata)}</div> : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

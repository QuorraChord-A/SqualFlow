"use client";

import { useEffect, useState } from "react";
import { MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useOrchestrationFeedbackStore } from "../../stores/useOrchestrationFeedbackStore";

export default function OrchestrationFeedbackAttachments() {
  const drafts = useOrchestrationFeedbackStore((state) => state.drafts);
  const removeDraft = useOrchestrationFeedbackStore((state) => state.removeDraft);
  const upsertDraft = useOrchestrationFeedbackStore((state) => state.upsertDraft);
  const clearDrafts = useOrchestrationFeedbackStore((state) => state.clearDrafts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = drafts.find((draft) => draft.id === editingId) ?? null;
  const [comment, setComment] = useState("");
  useEffect(() => setComment(editing?.comment ?? ""), [editing]);
  if (drafts.length === 0) return null;
  return (
    <div data-testid="plan-feedback-attachments" className="mb-2 flex max-w-full flex-col items-start gap-2">
      <div className="flex max-w-full flex-wrap gap-2">
        {drafts.map((draft) => (
          <Popover key={draft.id} open={editingId === draft.id} onOpenChange={(open) => setEditingId(open ? draft.id : null)}>
            <PopoverTrigger render={(
              <button type="button" className="group relative w-[180px] rounded-xl border border-ui-border-strong bg-ui-sunken px-3 py-2 text-left shadow-sm">
                <span className="absolute left-2 top-2 inline-flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">{draft.markerNumber}</span>
                <span className="block truncate pl-7 text-xs font-semibold text-foreground">{draft.targetLabel}</span>
                <span className="mt-1 block truncate text-[11px] text-muted-foreground">{draft.comment}</span>
                <span
                  role="button"
                  aria-label={`移除计划评论 ${draft.markerNumber}`}
                  onClick={(event) => { event.stopPropagation(); removeDraft(draft.id); }}
                  className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-foreground"
                ><X className="size-3.5" /></span>
              </button>
            )} />
            <PopoverContent side="top" align="start" className="w-[360px] p-3">
              <div className="text-sm font-semibold">修改评论</div>
              <div className="text-xs text-muted-foreground">{draft.targetLabel}</div>
              <Textarea rows={4} value={comment} onChange={(event) => setComment(event.target.value)} />
              <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setEditingId(null)}>取消</Button><Button size="sm" disabled={!comment.trim()} onClick={() => { upsertDraft({ flowId: draft.flowId, orchestrationRevisionId: draft.orchestrationRevisionId, orchestrationNodeId: draft.orchestrationNodeId, targetLabel: draft.targetLabel, comment: comment.trim() }); setEditingId(null); }}>保存</Button></div>
            </PopoverContent>
          </Popover>
        ))}
      </div>
      <div className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ui-border-strong bg-ui-control px-2.5 text-xs font-medium">
        <MessageSquareText className="size-3.5 text-muted-foreground" />
        <span>{drafts.length} 条计划评论</span>
        <button type="button" aria-label="清空计划评论" onClick={clearDrafts} className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}

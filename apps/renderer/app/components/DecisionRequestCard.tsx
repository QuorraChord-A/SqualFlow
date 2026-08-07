"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { wsClient } from "../lib/ws";
import type { DecisionAnswer, DecisionAnswers, DecisionRequestCardData } from "../hooks/useDashboardData";

function answerKey(question: DecisionRequestCardData["questions"][number], index: number) {
  return question.header?.trim() || question.question || `问题${index + 1}`;
}

export default function DecisionRequestCard({ card, flowId }: { card: DecisionRequestCardData; flowId: string }) {
  const [answers, setAnswers] = useState<DecisionAnswers>(card.answers ?? {});
  const [custom, setCustom] = useState<Record<string, string>>({});
  useEffect(() => { if (card.answers) setAnswers(card.answers); }, [card.answers]);

  if (card.status !== "pending") {
    return (
      <div data-testid="decision-request-resolved" className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {card.status === "cancelled" ? "请求已取消" : card.status === "rejected" ? "工具调用已拒绝" : "回复已提交"}
      </div>
    );
  }

  if (card.request_type === "tool_permission") {
    return (
      <section data-testid="tool-permission-request" className="overflow-hidden rounded-[22px] border border-orange-500/35 bg-card shadow-[var(--ui-shadow-elevated)]">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 text-sm font-semibold">
          <ShieldAlert className="size-4 text-orange-600" />请确认 Agent 工具调用
        </div>
        <div className="px-4 py-3 text-sm leading-6">
          <div className="font-medium">{card.tool_name || "风险操作"}</div>
          {card.tool_arguments ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-2 text-xs">{JSON.stringify(card.tool_arguments, null, 2)}</pre> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/70 px-4 py-3">
          <button type="button" className="h-8 rounded-lg border border-border px-3 text-sm" onClick={() => wsClient.send({ type: "decision_request:reject", flow_id: flowId, decision_request_id: card.decision_request_id, client_action_id: `deny-${Date.now()}` })}>拒绝</button>
          <button type="button" className="h-8 rounded-lg bg-status-pending px-4 text-sm font-semibold text-background" onClick={() => wsClient.send({ type: "decision_request:resolve", flow_id: flowId, decision_request_id: card.decision_request_id, answers: {}, client_action_id: `approve-${Date.now()}` })}>允许本次</button>
        </div>
      </section>
    );
  }

  const updateAnswer = (key: string, value: DecisionAnswer) => setAnswers((current) => ({ ...current, [key]: value }));
  const complete = card.questions.every((question, index) => {
    const key = answerKey(question, index);
    const value = custom[key]?.trim() || answers[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  return (
    <section data-testid="decision-request-pending" className="max-h-[min(520px,calc(100vh-150px))] overflow-y-auto rounded-[22px] border border-border bg-card shadow-[var(--ui-shadow-elevated)]">
      <header className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3 text-sm font-semibold">Leader 需要你的补充</header>
      <div className="space-y-6 px-4 py-4">
        {card.questions.map((question, index) => {
          const key = answerKey(question, index);
          const selected = answers[key];
          return (
            <fieldset key={key} className="space-y-2">
              <legend className="text-sm font-semibold">{index + 1}. {question.question}</legend>
              {question.options.map((option) => {
                const pressed = Array.isArray(selected) ? selected.includes(option.label) : selected === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => {
                      if (!question.multiSelect) updateAnswer(key, option.label);
                      else {
                        const values = Array.isArray(selected) ? selected : [];
                        updateAnswer(key, pressed ? values.filter((item) => item !== option.label) : [...values, option.label]);
                      }
                      setCustom((current) => ({ ...current, [key]: "" }));
                    }}
                    className={`block w-full rounded-xl border px-3 py-2 text-left text-sm ${pressed ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"}`}
                  >
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  </button>
                );
              })}
              <input className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" placeholder="其他 / 自定义" value={custom[key] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [key]: event.target.value }))} />
            </fieldset>
          );
        })}
      </div>
      <footer className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-card px-4 py-3">
        <button type="button" className="h-8 rounded-lg border border-border px-3 text-sm" onClick={() => wsClient.send({ type: "decision_request:cancel", flow_id: flowId, decision_request_id: card.decision_request_id, client_action_id: `cancel-${Date.now()}` })}>取消</button>
        <button
          type="button"
          disabled={!complete}
          className="h-8 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"
          onClick={() => {
            const resolved = { ...answers };
            for (const [key, value] of Object.entries(custom)) if (value.trim()) resolved[key] = value.trim();
            wsClient.send({ type: "decision_request:resolve", flow_id: flowId, decision_request_id: card.decision_request_id, answers: resolved, client_action_id: `resolve-${Date.now()}` });
          }}
        >提交</button>
      </footer>
    </section>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { ShieldAlert } from "lucide-react";
import { wsClient } from "../lib/ws";
import type { QuestionOption, DecisionCardData, DecisionAnswers } from "../hooks/useDashboardData";
import { cn } from "@/lib/utils";

interface DecisionCardProps {
  card: DecisionCardData;
  flowId: string;
}

export default function DecisionCard({ card, flowId }: DecisionCardProps) {
  const [selectedAnswers, setSelectedAnswers] = useState<DecisionAnswers>(
    card.answers || {}
  );
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(card.status === "resolved");
  const [questionIndex, setQuestionIndex] = useState(0);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const questionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const isPermissionConfirmation = card.card_type === "permission_confirmation";

  // Sync local state when card prop is externally resolved or cancelled
  useEffect(() => {
    if (card.status === "resolved") {
      setSubmitted(true);
      if (card.answers) setSelectedAnswers(card.answers);
    }
    if (card.status === "cancelled") {
      setSubmitted(false);
    }
  }, [card.status, card.answers]);

  useEffect(() => {
    setQuestionIndex((current) => Math.min(current, Math.max(card.questions.length - 1, 0)));
  }, [card.questions.length]);

  const handleOptionSelect = (
    question: DecisionCardData["questions"][number],
    label: string,
  ) => {
    setSelectedAnswers((previous) => {
      if (!question.multiSelect) {
        return { ...previous, [question.header]: label };
      }
      const selected = Array.isArray(previous[question.header])
        ? previous[question.header] as string[]
        : [];
      const next = selected.includes(label)
        ? selected.filter((item) => item !== label)
        : [...selected, label];
      const answers = { ...previous };
      if (next.length === 0) delete answers[question.header];
      else answers[question.header] = next;
      return answers;
    });
    setCustomInputs((previous) => ({ ...previous, [question.header]: "" }));
  };

  const handleCustomInput = (header: string, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [header]: value }));
  };

  const scrollToQuestion = (nextIndex: number) => {
    const boundedIndex = Math.min(Math.max(nextIndex, 0), card.questions.length - 1);
    setQuestionIndex(boundedIndex);
    questionRefs.current[boundedIndex]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const handleScroll = () => {
    const container = scrollAreaRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    questionRefs.current.forEach((questionEl, index) => {
      if (!questionEl) return;
      const distance = Math.abs(questionEl.getBoundingClientRect().top - containerTop);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    setQuestionIndex(closestIndex);
  };

  const handleSubmit = () => {
    const answers = { ...selectedAnswers };
    for (const q of card.questions) {
      const customValue = customInputs[q.header]?.trim();
      if (customValue) {
        answers[q.header] = customValue;
      }
    }
    wsClient.send({
      type: "flow:decision",
      flow_id: flowId,
      card_id: card.card_id,
      answers,
      client_action_id: `submit-${card.card_id}-${Date.now()}`,
    });
    setSelectedAnswers(answers);
    setSubmitted(true);
  };

  const handleCancel = () => {
    wsClient.send({
      type: "flow:decision_cancel",
      flow_id: flowId,
      card_id: card.card_id,
      client_action_id: `cancel-${card.card_id}-${Date.now()}`,
    });
  };

  const handlePermissionDecision = (answer: "允许本次操作" | "拒绝当前命令") => {
    const header = card.questions[0]?.header || "permission";
    const answers = { [header]: answer };
    wsClient.send({
      type: "flow:decision",
      flow_id: flowId,
      card_id: card.card_id,
      answers,
      client_action_id: `${answer === "允许本次操作" ? "allow" : "deny"}-${card.card_id}-${Date.now()}`,
    });
    setSelectedAnswers(answers);
    setSubmitted(true);
  };

  const allRequiredAnswered = card.questions.every(
    (q) => {
      const answer = selectedAnswers[q.header];
      const hasAnswer = Array.isArray(answer) ? answer.length > 0 : Boolean(answer);
      return hasAnswer || customInputs[q.header]?.trim();
    }
  );
  const progressText = `${Math.min(questionIndex + 1, card.questions.length)} / ${card.questions.length}`;
  const permissionWasExplicitlyDenied = isPermissionConfirmation && Object.values(card.answers ?? {})
    .flatMap((answer) => Array.isArray(answer) ? answer : [answer])
    .some((answer) => answer === "拒绝当前命令" || answer === "拒绝");

  if (card.status === "cancelled") {
    return (
      <div data-testid="decision-card-cancelled" className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {permissionWasExplicitlyDenied ? "已拒绝当前命令" : "已取消"}
      </div>
    );
  }

  if (submitted) {
    return (
      <div
        data-testid="decision-card-resolved"
        className="overflow-hidden rounded-t-xl border border-border bg-card"
      >
        <div className="flex h-11 items-center gap-2 px-4 text-sm font-bold">
          <span className="text-primary">✓</span>
          <span>已提交决策</span>
        </div>
        <div className="grid gap-1.5 px-3 pb-3">
        {card.questions.map((q) => {
          const answer = selectedAnswers[q.header];
          const display = Array.isArray(answer) ? answer.join("、") : (answer || "未选择");
          return (
            <div
              key={q.header}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2"
            >
              <span className="min-w-0 text-sm leading-relaxed">
                <strong>{q.header}</strong>
                <br />
                {display}
              </span>
            </div>
          );
        })}
        </div>
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {card.card_type === "permission_confirmation" ? "已返回 Agent" : "已发送给 Leader"}
        </div>
      </div>
    );
  }

  if (isPermissionConfirmation && card.questions[0]) {
    const question = card.questions[0];
    const denialDescription = question.options.find((option) => option.label === "拒绝当前命令")?.description;
    return (
      <section
        data-testid="decision-card-pending"
        className="flex max-h-[min(430px,calc(100vh-160px))] min-w-0 flex-col overflow-hidden rounded-[22px] border border-orange-500/35 bg-card shadow-[var(--ui-shadow-elevated)]"
      >
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2 text-sm font-bold">
          <ShieldAlert className="size-4 shrink-0 text-orange-700 dark:text-orange-400" />
          <span>请确认 Agent 风险操作</span>
          <span className="text-xs font-medium text-muted-foreground">仅本次</span>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="whitespace-pre-wrap break-words text-[15px] font-semibold leading-6 [overflow-wrap:anywhere]">
            {question.question}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            拒绝只阻止当前命令，不会结束本轮；
            {denialDescription ?? "当前工作继续，完全相同的命令不再询问。"}
          </p>
        </div>
        <div className="mt-auto flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/70 px-4 py-2">
          <span className="text-xs text-muted-foreground">如需结束全部工作，请使用下方“停止本轮”</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => handlePermissionDecision("拒绝当前命令")}
              className="h-8 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            >
              拒绝当前命令
            </button>
            <button
              type="button"
              onClick={() => handlePermissionDecision("允许本次操作")}
              className="h-8 rounded-lg bg-orange-700 px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-orange-800 dark:bg-orange-500 dark:hover:bg-orange-400"
            >
              允许本次操作
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="decision-card-pending"
      className="flex max-h-[min(430px,calc(100vh-160px))] flex-col overflow-hidden rounded-[22px] border border-border/90 bg-card shadow-[var(--ui-shadow-elevated)]"
    >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="flex items-center gap-2 text-sm font-bold">
          <span className="text-primary">▣</span>
          <span>{isPermissionConfirmation ? "请确认 Agent 风险操作" : "请回答以下问题"}</span>
          {isPermissionConfirmation ? <span className="text-xs font-medium text-muted-foreground">仅本次</span> : null}
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <button
            type="button"
            onClick={() => scrollToQuestion(questionIndex - 1)}
            disabled={questionIndex === 0}
            className="flex size-6 items-center justify-center rounded-md border border-border bg-background disabled:opacity-40"
            aria-label="上一题"
          >
            ⌃
          </button>
          <span>{progressText}</span>
          <button
            type="button"
            onClick={() => scrollToQuestion(questionIndex + 1)}
            disabled={questionIndex >= card.questions.length - 1}
            className="flex size-6 items-center justify-center rounded-md border border-border bg-background disabled:opacity-40"
            aria-label="下一题"
          >
            ⌄
          </button>
        </div>
      </div>

      <div
        ref={scrollAreaRef}
        data-testid="decision-card-scroll-area"
        onScroll={handleScroll}
        className="min-h-0 overflow-y-auto scroll-smooth px-4 py-3 [scrollbar-gutter:stable]"
      >
        <div className="grid gap-7">
          {card.questions.map((question, qIndex) => (
            <div
              key={question.header}
              ref={(node) => {
                questionRefs.current[qIndex] = node;
              }}
              className="scroll-mt-2"
            >
              <div className="px-1 pb-2 text-[16px] font-bold leading-snug">
                {qIndex + 1}. {question.question}
              </div>

              <div className="grid gap-1.5">
                {question.options.map((opt: QuestionOption, optionIndex) => {
                  const answer = selectedAnswers[question.header];
                  const isSelected = question.multiSelect
                    ? Array.isArray(answer) && answer.includes(opt.label)
                    : answer === opt.label && !customInputs[question.header]?.trim();
                  const letter = String.fromCharCode(65 + optionIndex);
                  const isRecommended = optionIndex === 0;
                  return (
                    <button
                      type="button"
                      key={opt.label}
                      onClick={() => handleOptionSelect(question, opt.label)}
                      disabled={submitted}
                      className={cn(
                        "grid min-h-10 w-full grid-cols-[30px_18px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-transparent border-l-[3px] px-3 py-1.5 text-left text-sm transition-colors",
                        isSelected
                          ? "border-primary/35 border-l-primary bg-primary/10 text-primary"
                          : "bg-background/55 hover:bg-muted/50"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-6 items-center justify-center rounded-md border border-border bg-background text-xs font-bold text-muted-foreground",
                          isSelected && "border-primary/40 text-primary"
                        )}
                      >
                        {letter}
                      </span>
                      <span
                        className={cn(
                          "relative size-4 rounded border border-border",
                          isSelected && "border-primary bg-primary after:absolute after:left-[4px] after:top-[4px] after:size-1.5 after:rounded-full after:bg-primary-foreground after:content-['']"
                        )}
                      />
                      <span className="min-w-0 leading-snug">
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && <span className="block text-xs text-muted-foreground">{opt.description}</span>}
                      </span>
                      <span className="flex justify-end">
                        {isRecommended && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                            推荐
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}

                <input
                  type="text"
                  placeholder="其他 / 自定义"
                  value={customInputs[question.header] || ""}
                  onChange={(e) => handleCustomInput(question.header, e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  disabled={submitted}
                  className={cn(
                    "min-h-10 rounded-xl border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-primary",
                    customInputs[question.header]?.trim()
                      ? "border-primary bg-primary/5"
                      : "border-border bg-muted/30 hover:border-muted-foreground/50"
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-auto flex min-h-12 shrink-0 items-center justify-between gap-3 border-t border-border/70 px-4 py-2">
        <div className="text-xs leading-snug text-muted-foreground">
          {allRequiredAnswered ? "已完成必答项，可以提交" : "请选择或填写每个问题后提交"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="h-8 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-muted-foreground hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allRequiredAnswered || submitted}
            className="h-8 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            提交回答
          </button>
        </div>
      </div>
    </section>
  );
}

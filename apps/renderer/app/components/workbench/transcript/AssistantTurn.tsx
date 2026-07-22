import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDown, CopyIcon, MessageSquareIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements-official/message";
import type { DecisionCardData, SpecCardState } from "../../../hooks/useDashboardData";
import PendingSpecCard from "../PendingSpecCard";
import OrchestrationPlanCard from "../../orchestration/OrchestrationPlanCard";
import type { OrchestrationPlanView } from "../../../types/orchestration";
import type { TranscriptBlock } from "./types";
import type { TranscriptActivity } from "./types";
import type { TurnTiming } from "./buildTranscriptTimeline";
import ReasoningBlock from "./ReasoningBlock";
import ThinkingIndicator from "./ThinkingIndicator";
import ToolGroup from "./ToolGroup";
import styles from "./transcript.module.css";
import { useTranscriptScroll } from "./TranscriptScrollContext";
import { useCollapse } from "./useCollapse";
import { ImagePreviewOverlay, ImageThumbnailContent } from "./ImagePreview";

type AssistantTurnProps = {
  blocks: TranscriptBlock[];
  turnId?: string;
  flowId: string;
  decisionCardsById: Map<string, DecisionCardData>;
  specCardsById: Map<string, SpecCardState>;
  plansByRevisionId: Map<string, OrchestrationPlanView>;
  onSpecOpen: (specRevisionId: string, title: string) => void;
  onPlanOpen: (plan: OrchestrationPlanView) => void;
  onPlanApprove: (plan: OrchestrationPlanView) => void;
  activity?: TranscriptActivity;
  turnTiming?: TurnTiming | null;
  showReasoning?: boolean;
  beforeFooter?: ReactNode;
  thinkingLabel?: string;
};

function mergeAdjacentToolGroups(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const merged: TranscriptBlock[] = [];

  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous?.type === "tool-group" && block.type === "tool-group") {
      const activeSource = !block.finalized ? block : !previous.finalized ? previous : null;
      const mergedTools = [...previous.tools, ...block.tools];
      const runningTool = [...mergedTools].reverse().find((tool) => tool.state === "running") ?? null;
      merged[merged.length - 1] = {
        id: activeSource?.id ?? previous.id,
        type: "tool-group",
        tools: mergedTools,
        finalized: previous.finalized && block.finalized,
        defaultCollapsed: activeSource
          ? activeSource.defaultCollapsed
          : previous.defaultCollapsed && block.defaultCollapsed,
        activeState: activeSource
          ? (runningTool ? "running" : activeSource.activeState ?? "thinking")
          : undefined,
        currentToolCallId: activeSource
          ? (runningTool?.toolCallId ?? activeSource.currentToolCallId ?? null)
          : undefined,
      };
      continue;
    }
    merged.push(block);
  }

  return merged;
}

function projectLiveTurnBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  return blocks.filter((block) => {
    if (block.type === "thinking") return false;
    // Streaming reasoning belongs to the single live activity slot. Rendering
    // its expanding body alongside that slot makes every delta resize the
    // transcript and repeatedly wakes stick-to-bottom. The full trace remains
    // in `blocks` and becomes available as soon as the turn finishes.
    if (block.type === "reasoning") return false;
    return true;
  });
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the duration in milliseconds to display. Finished turns prefer the
 * persisted `durationMs` and fall back to `finishedAt - startedAt`. Running
 * turns use live elapsed time since `startedAt`.
 */
function resolveDisplayDurationMs(
  activity: TranscriptActivity | undefined,
  turnTiming: TurnTiming | null | undefined,
  now: number,
): number | null {
  if (turnTiming?.label === "waiting" && turnTiming.activeDurationMs != null && Number.isFinite(turnTiming.activeDurationMs)) {
    return turnTiming.activeDurationMs;
  }
  const isFinished = activity === "finished" || (!activity && turnTiming?.finishedAt != null);
  if (isFinished) {
    if (turnTiming?.durationMs != null && Number.isFinite(turnTiming.durationMs)) {
      return turnTiming.durationMs;
    }
    const start = toMs(turnTiming?.startedAt ?? null);
    const end = toMs(turnTiming?.finishedAt ?? null);
    return start !== null && end !== null ? Math.max(0, end - start) : null;
  }
  const base = turnTiming?.activeDurationMs != null && Number.isFinite(turnTiming.activeDurationMs)
    ? turnTiming.activeDurationMs
    : 0;
  if (turnTiming?.label === "waiting") return base;
  const start = toMs(turnTiming?.startedAt ?? null);
  return start !== null ? base + Math.max(0, now - start) : base;
}

function formatElapsedLabel(
  durationMs: number | null,
  isFinished: boolean,
  label?: TurnTiming["label"],
): string {
  const secondsTotal = durationMs !== null ? Math.max(1, Math.floor(durationMs / 1000)) : 1;
  const minutes = Math.floor(secondsTotal / 60);
  const seconds = secondsTotal % 60;
  const prefix = label === "waiting"
    ? "等待你确认 · 已工作"
    : isFinished || label === "finished"
      ? "已工作"
      : "工作中";
  if (minutes > 0) {
    return `${prefix} ${minutes} 分 ${seconds} 秒`;
  }
  return `${prefix} ${seconds} 秒`;
}

function formatTurnTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isPinnedTurnBlock(block: TranscriptBlock): boolean {
  return block.type === "guide-message"
    || block.type === "decision-card-result"
    || block.type === "spec-card"
    || block.type === "plan-card";
}

/**
 * A turn-level "finished" signal (from the merged user-turn status) can lag
 * behind the message that is still actually streaming inside that same turn.
 * Treat the turn as still live whenever any rendered block is itself
 * mid-flight, regardless of what the turn-level signal claims.
 */
function hasLiveBlock(blocks: TranscriptBlock[]): boolean {
  return blocks.some((block) => (
    block.type === "thinking"
    || (block.type === "tool-group" && !block.finalized)
    || (block.type === "text" && block.streaming)
    || (block.type === "reasoning" && block.streaming)
  ));
}

function hasToolWork(blocks: TranscriptBlock[]): boolean {
  return blocks.some((block) => (
    (block.type === "tool-group" && block.tools.length > 0)
    || block.type === "decision-card"
    || block.type === "spec-card"
    || block.type === "plan-card"
  ));
}

/**
 * A finished turn's deep-collapse keeps user-authored interjections and
 * approval cards visible alongside the final answer; every
 * process block (reasoning, tool-groups, intermediate text) folds away
 * together into the work header, regardless of whether it came before or
 * after an interjection — a guide message does not start a new collapse
 * segment (confirmed 2026-07-01).
 */
function computeTurnCollapsePlan(
  blocks: TranscriptBlock[],
  activity: TranscriptActivity | undefined,
): { canCollapse: boolean; pinnedIds: Set<string> } {
  if (activity !== "finished") return { canCollapse: false, pinnedIds: new Set() };

  const lastTextIdx = blocks.findLastIndex((block) => block.type === "text" && block.text.trim().length > 0);
  if (lastTextIdx < 0) return { canCollapse: false, pinnedIds: new Set() };

  const pinnedIds = new Set<string>();
  blocks.forEach((block, index) => {
    if (isPinnedTurnBlock(block) || index === lastTextIdx) pinnedIds.add(block.id);
  });

  return { canCollapse: pinnedIds.size < blocks.length, pinnedIds };
}

function WorkHeader({
  activity,
  turnTiming,
  collapsible = false,
  expanded = true,
  onToggle,
}: {
  activity?: TranscriptActivity;
  turnTiming?: TurnTiming | null;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const [, forceTick] = useState(0);
  const { toggle } = useTranscriptScroll();

  // Refresh the running clock once per second while the turn is in flight.
  useEffect(() => {
    if (!activity || activity === "finished") return;
    const timer = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [activity]);

  if (!turnTiming) return null;

  const isFinished = activity === "finished" || (!activity && turnTiming?.finishedAt != null);
  const durationMs = resolveDisplayDurationMs(activity, turnTiming, Date.now());
  const label = formatElapsedLabel(durationMs, isFinished, turnTiming.label);
  const isAnimated = !isFinished && turnTiming.label !== "waiting";

  return (
    <div className={`${styles.workHead} ${isAnimated ? styles.animatedDivider : ""}`}>
      {collapsible ? (
        <button
          type="button"
            className={`${styles.workHeadButton} ${!expanded ? styles.collapsed : ""}`}
            onClick={(event) => onToggle && toggle(event, onToggle)}
            aria-expanded={expanded}
          >
          <span
            className={isAnimated ? styles.animatedStatusText : undefined}
            data-text={isAnimated ? label : undefined}
          >
            {label}
          </span>
          <ChevronDown className={styles.chevron} size={16} />
        </button>
      ) : (
        <span
          className={isAnimated ? styles.animatedStatusText : undefined}
          data-text={isAnimated ? label : undefined}
        >
          {label}
        </span>
      )}
    </div>
  );
}

function DecisionCardResult({
  block,
  card,
}: {
  block: Extract<TranscriptBlock, { type: "decision-card-result" }>;
  card?: DecisionCardData;
}) {
  const [expanded, setExpanded] = useState(block.collapseState === "expanded");
  const { toggle } = useTranscriptScroll();

  useEffect(() => {
    setExpanded(block.collapseState === "expanded");
  }, [block.collapseState]);

  const rows = Object.entries(card?.answers ?? {}).map(([header, answer]) => ({
    header,
    question: card?.questions.find((question) => question.header === header)?.question ?? header,
    value: Array.isArray(answer) ? answer.join("、") : answer,
  }));
  const isExplicitPermissionDenial = card?.card_type === "permission_confirmation"
    && rows.some((row) => row.value === "拒绝当前命令" || row.value === "拒绝");
  const summary = block.status === "cancelled"
    ? isExplicitPermissionDenial ? "已拒绝当前命令" : "已取消"
    : rows.length > 0
      ? `已选择：${rows.map((row) => row.value).join("、")}`
      : "已提交澄清结果";

  return (
    <div data-testid="decision-card-result" className={styles.cardResult}>
      <button
        type="button"
        data-testid="decision-card-result-summary"
        className={styles.cardResultSummary}
        aria-expanded={expanded}
        onClick={(event) => toggle(event, () => setExpanded((value) => !value))}
      >
        <span>{summary}</span>
        <ChevronDown className={`${styles.chevron} ${expanded ? "" : styles.collapsed}`} size={16} />
      </button>
      {expanded ? (
        <div data-testid="decision-card-result-details" className={styles.cardResultDetails}>
          {block.status === "cancelled" ? (
            <p>{isExplicitPermissionDenial ? "用户已拒绝当前风险命令，本轮可继续执行其他工作。" : "用户取消了本次澄清卡片。"}</p>
          ) : rows.length > 0 ? (
            rows.map((row) => (
              <div key={row.header} className={styles.cardResultRow}>
                <span className={styles.cardResultQuestion}>{row.question}</span>
                <span>{row.value}</span>
              </div>
            ))
          ) : (
            <p>用户已提交本次澄清卡片。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GuideMessageView({ block }: { block: Extract<TranscriptBlock, { type: "guide-message" }> }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [commentListOpen, setCommentListOpen] = useState(false);
  const previewImage = block.imageAttachments?.find((image) => image.id === previewId) ?? null;
  const previewBrowser = block.browserAttachments?.find((element) => element.id === previewId) ?? null;
  const browserAttachments = block.browserAttachments ?? [];
  const commentRows = browserAttachments.length > 0
    ? browserAttachments.map((element, index) => ({
      id: element.id,
      markerNumber: element.markerNumber || index + 1,
      label: element.ariaLabel || element.title || element.text || element.selector || `网页注释 ${index + 1}`,
      comment: element.comment?.trim() || `标记${index + 1}`,
      screenshotDataUrl: element.screenshotDataUrl,
    }))
    : (block.comments ?? []).map((comment) => ({
      id: `parsed-${comment.markerNumber}`,
      markerNumber: comment.markerNumber,
      label: comment.label,
      comment: comment.comment || `标记${comment.markerNumber}`,
      screenshotDataUrl: undefined,
    }));
  const preview = previewImage
    ? {
      src: previewImage.dataUrl,
      alt: previewImage.name || "图片附件",
    }
    : previewBrowser
      ? {
        src: previewBrowser.screenshotDataUrl,
        alt: `网页注释 ${previewBrowser.markerNumber}`,
      }
      : null;

  return (
    <div data-testid="chat-message-guide" className={styles.userRow}>
      <div className={styles.userMessageGroup}>
        {block.imageAttachments?.length || block.browserAttachments?.length ? (
          <div className={styles.browserCommentThumbs}>
            {block.imageAttachments?.slice(0, 4).map((image, index) => (
              <button
                key={image.id}
                type="button"
                onClick={() => setPreviewId(image.id)}
                className={styles.userImageThumb}
                aria-label={`预览图片 ${image.name || index + 1}`}
                title={image.name || `图片 ${index + 1}`}
              >
                <ImageThumbnailContent src={image.dataUrl} alt="" />
              </button>
            ))}
            {block.browserAttachments?.slice(0, 3).map((element) => (
              <button
                key={element.id}
                type="button"
                onClick={() => setPreviewId(element.id)}
                className={styles.browserCommentThumb}
                aria-label={`预览网页注释 ${element.markerNumber}`}
                title={element.ariaLabel || element.title || element.text || element.selector}
              >
                <ImageThumbnailContent src={element.screenshotDataUrl} alt="" fallback="截图" />
              </button>
            ))}
          </div>
        ) : null}
        {block.commentCount ? (
          <div
            className={styles.browserCommentBadgeWrap}
            onMouseEnter={() => setCommentListOpen(true)}
            onMouseLeave={() => setCommentListOpen(false)}
          >
            <div className={styles.browserCommentBadge}>
              <MessageSquareIcon className="size-3.5" />
              {block.commentCount} 条注释
            </div>
            {commentListOpen && commentRows.length > 0 ? (
              <div className={styles.browserCommentList}>
                {commentRows.map((row) => (
                  <div key={row.id} className={styles.browserCommentListItem}>
                    <button
                      type="button"
                      className={styles.browserCommentListThumb}
                      onClick={() => setPreviewId(row.id)}
                      aria-label={`预览网页注释 ${row.markerNumber}`}
                    >
                      {row.screenshotDataUrl ? <img src={row.screenshotDataUrl} alt="" /> : <span>{row.markerNumber}</span>}
                    </button>
                    <div className={styles.browserCommentListText}>
                      <div className={styles.browserCommentListLabel}>{row.label}</div>
                      <div className={styles.browserCommentListComment}>{row.comment}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={styles.userBubble}>{block.text}</div>
        {block.statusLabel ? (
          <div className={styles.userGuideStatus}>{block.statusLabel}</div>
        ) : null}
      </div>
      {preview ? (
        <ImagePreviewOverlay
          src={preview.src}
          alt={preview.alt}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </div>
  );
}

function renderTranscriptBlock(
  block: TranscriptBlock,
  {
    flowId,
    decisionCardsById,
    specCardsById,
    plansByRevisionId,
    onSpecOpen,
    onPlanOpen,
    onPlanApprove,
    showReasoning,
    thinkingLabel,
  }: {
    flowId: string;
    decisionCardsById: Map<string, DecisionCardData>;
    specCardsById: Map<string, SpecCardState>;
    plansByRevisionId: Map<string, OrchestrationPlanView>;
    onSpecOpen: (specRevisionId: string, title: string) => void;
    onPlanOpen: (plan: OrchestrationPlanView) => void;
    onPlanApprove: (plan: OrchestrationPlanView) => void;
    showReasoning: boolean;
    thinkingLabel?: string;
  },
) {
  switch (block.type) {
    case "text":
      return (
        <div key={block.id} className={styles.assistantText}>
          <MessageResponse isAnimating={block.streaming}>{block.text}</MessageResponse>
        </div>
      );
    case "guide-message":
      return <GuideMessageView key={block.id} block={block} />;
    case "reasoning":
      return showReasoning ? <ReasoningBlock key={block.id} block={block} /> : null;
    case "thinking":
      return <ThinkingIndicator key={block.id} label={thinkingLabel} />;
    case "tool-group":
      return <ToolGroup key={block.id} group={block} />;
    case "decision-card-result":
      return (
        <DecisionCardResult
          key={block.id}
          block={block}
          card={decisionCardsById.get(block.cardId)}
        />
      );
    case "decision-card":
      return null;
    case "spec-card": {
      const card = specCardsById.get(block.specApprovalId);
      if (!card) return null;
      return (
        <PendingSpecCard
          key={block.id}
          flowId={flowId}
          card={card}
          onOpenSpec={onSpecOpen}
        />
      );
    }
    case "plan-card": {
      const plan = plansByRevisionId.get(block.planRevisionId);
      return plan ? <OrchestrationPlanCard key={block.id} plan={plan} onOpenPlan={onPlanOpen} onApprove={onPlanApprove} /> : null;
    }
    default:
      return null;
  }
}

export default function AssistantTurn({
  blocks,
  turnId,
  flowId,
  decisionCardsById,
  specCardsById,
  plansByRevisionId,
  onSpecOpen,
  onPlanOpen,
  onPlanApprove,
  activity,
  turnTiming,
  showReasoning = true,
  beforeFooter,
  thinkingLabel,
}: AssistantTurnProps) {
  const finishedSignal = activity === "finished" || (!activity && turnTiming?.finishedAt != null);
  const waitingForUser = turnTiming?.label === "waiting" && !hasLiveBlock(blocks);
  const isLiveTurn = !waitingForUser && activity !== "finished" && (activity !== undefined || hasLiveBlock(blocks));
  const visibleBlocks = isLiveTurn
    ? projectLiveTurnBlocks(blocks)
    : showReasoning
      ? blocks
      : mergeAdjacentToolGroups(blocks.filter((block) => block.type !== "reasoning"));
  const hasToolWorkStarted = hasToolWork(visibleBlocks);
  const shouldShowLiveThinking = isLiveTurn && (
    activity === "reasoning" || blocks.some((block) => (
      block.type === "thinking" || (block.type === "reasoning" && block.streaming)
    ))
  );
  const hasVisibleActiveToolSlot = visibleBlocks.some(
    (block) => block.type === "tool-group" && !block.finalized,
  );
  // The turn-level activity/timing (merged across possibly several messages)
  // can claim "finished" while a block from the still-streaming message is
  // rendered right below it; fall back to "waiting" in that case so the
  // header/footer never contradict the content they wrap.
  const stillLive = finishedSignal && hasLiveBlock(visibleBlocks);
  const effectiveActivity: TranscriptActivity | undefined = waitingForUser ? "finished" : stillLive ? "waiting" : activity;
  const isFinished = (finishedSignal || waitingForUser) && !stillLive;
  const collapsePlan = computeTurnCollapsePlan(visibleBlocks, effectiveActivity);
  const canCollapse = hasToolWorkStarted && collapsePlan.canCollapse;
  const pinnedIds = collapsePlan.pinnedIds;
  // Work timing represents actual tool execution. Plain assistant text and
  // reasoning do not reveal the timer or its divider.
  const showWorkHeader = hasToolWorkStarted;
  // Scope the collapse-state slot to the finished/live phase separately: a
  // turn's id is stable across its whole lifetime, but the "default
  // collapsed" value while running (always false, nothing to hide yet) must
  // not pre-empt the turn's own first-time-finished default (collapsed) once
  // the reducer has already recorded a value for that id.
  const collapseId = `${turnId ?? visibleBlocks[0]?.id ?? "turn"}:${isFinished ? "done" : "live"}`;
  const { expanded, toggle: toggleDeepCollapse } = useCollapse(collapseId, canCollapse);
  const deepCollapsed = canCollapse && !expanded;
  const blocksToRender = deepCollapsed
    ? visibleBlocks
      .filter((block) => pinnedIds.has(block.id))
    : visibleBlocks;
  const footerTimestamp = formatTurnTimestamp(turnTiming?.finishedAt ?? turnTiming?.startedAt ?? null);
  const copyText = visibleBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [copyText]);

  return (
    <article className={styles.assistant}>
      {showWorkHeader ? (
        <WorkHeader
          activity={effectiveActivity}
          turnTiming={turnTiming}
          collapsible={canCollapse}
          expanded={!deepCollapsed}
          onToggle={canCollapse ? toggleDeepCollapse : undefined}
        />
      ) : null}
      {blocksToRender.map((block) => renderTranscriptBlock(block, {
        flowId,
        decisionCardsById,
        specCardsById,
        plansByRevisionId,
        onSpecOpen,
        onPlanOpen,
        onPlanApprove,
        showReasoning,
        thinkingLabel,
      }))}
      {shouldShowLiveThinking && !hasVisibleActiveToolSlot && <ThinkingIndicator label={thinkingLabel} />}
      {beforeFooter}
      {isFinished && (footerTimestamp || copyText) ? (
        <div className={styles.assistantMeta}>
          {footerTimestamp ? <span className={styles.assistantMetaTime}>{footerTimestamp}</span> : null}
          <button
            type="button"
            className={styles.assistantMetaAction}
            onClick={handleCopy}
            aria-label={copied ? "已复制消息" : "复制消息"}
            title={copied ? "已复制" : "复制"}
            disabled={!copyText}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </button>
        </div>
      ) : null}
    </article>
  );
}

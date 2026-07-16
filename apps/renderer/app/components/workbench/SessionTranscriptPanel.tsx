"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ConversationEmptyState } from "@/components/ai-elements-official/conversation";
import { CheckIcon, CopyIcon, FileText, MessageSquareIcon } from "lucide-react";
import { wsClient } from "../../lib/ws";
import type { HistorySessionBoundary, WsInMessage } from "../../lib/ws";
import {
  extractMessageAgentSessionId,
  extractMessageFlowExpertId,
} from "./transcriptUtils";
import TranscriptTimelineRenderer from "./transcript/TranscriptTimelineRenderer";
import {
  buildTranscriptTimeline,
  readHistoryTurnTiming,
} from "./transcript/buildTranscriptTimeline";
import type { TimelineInputMessage, TranscriptActivity, TranscriptBlock } from "./transcript/types";
import type { TurnTiming } from "./transcript/buildTranscriptTimeline";
import type { DecisionCardData, SpecCardState } from "../../hooks/useDashboardData";
import type { OrchestrationPlanView } from "../../types/orchestration";
import type { UserTurnReview } from "../../hooks/useFlowWorkbench";
import { useAppPreferencesStore } from "../../stores/useAppPreferencesStore";
import type { BrowserElementAttachment } from "../../stores/useBrowserSelectionStore";
import type { MessageImageAttachment } from "../../types/messageAttachments";
import styles from "./transcript/transcript.module.css";
import { TranscriptScrollProvider, useTranscriptScroll } from "./transcript/TranscriptScrollContext";
import {
  emptyTranscriptState,
  transcriptReducer,
  type TranscriptEvent,
} from "./transcript/transcriptState";
import { ImagePreviewOverlay, ImageThumbnailContent } from "./transcript/ImagePreview";

export interface SessionTranscriptPanelProps {
  flowId: string | null;
  agentSessionId: string | null;
  flowExpertId?: string | null;
  readonly: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  decisionCards?: DecisionCardData[];
  decisionCardStatuses?: Record<string, "pending" | "resolved" | "cancelled">;
  decisionCardAnswers?: Record<string, Record<string, string | string[]>>;
  specCards?: Record<string, SpecCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  optimisticMessages?: UIMessage[];
  followRequestKey?: number;
  isAwaitingResponse?: boolean;
  allowInferredAgentSessionId?: boolean;
  className?: string;
  bottomOverlayHeight?: number;
  onOpenSpec?: (specRevisionId: string, title: string) => void;
  onOpenPlan?: (plan: OrchestrationPlanView) => void;
  onApprovePlan?: (plan: OrchestrationPlanView) => void;
  showReasoning?: boolean;
  userTurns?: UserTurnDisplay[];
  review?: UserTurnReview | null;
  onOpenReview?: () => void;
  onOpenWorkspaceFile?: (path: string) => void;
  statusDividerLabel?: string | null;
  statusDividerAnimated?: boolean;
  statusDividerAt?: string | null;
  workspaceRootPath?: string | null;
}

export type UserTurnDisplay = {
  id: string;
  triggerMessageId: string;
  status: "active" | "waiting_user" | "completed" | "failed" | "cancelled" | string;
  startedAt: string | null;
  activeStartedAt: string | null;
  activeDurationMs: number;
  completedAt: string | null;
  workRootPath?: string | null;
};

export function shouldBatchTranscriptEvent(event: TranscriptEvent) {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || event.type.startsWith("tool-");
}

type UserTurnReviewFile = UserTurnReview["files"][number];
type UserTurnReviewLine = UserTurnReviewFile["lines"][number];
const REVIEW_DIFF_PREVIEW_UNLOCK_MS = 1_000;
const REVIEW_DIFF_PREVIEW_LOCK_MS = 750;

function DiffPreviewLine({ line }: { line: UserTurnReviewLine }) {
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
  const rowClassName = line.kind === "added"
    ? "bg-emerald-500/10 text-foreground dark:bg-emerald-500/14"
    : line.kind === "removed"
      ? "bg-red-500/10 text-foreground dark:bg-red-500/14"
      : "text-muted-foreground";
  const markerClassName = line.kind === "added"
    ? "text-emerald-600 dark:text-emerald-400"
    : line.kind === "removed"
      ? "text-red-600 dark:text-red-400"
      : "text-muted-foreground";

  return (
    <div className={`grid min-w-[680px] grid-cols-[52px_52px_28px_minmax(420px,1fr)] text-[12px] leading-6 ${rowClassName}`}>
      <span className="select-none border-r border-border/45 px-2 text-right text-muted-foreground/80">{line.old_line ?? ""}</span>
      <span className="select-none border-r border-border/45 px-2 text-right text-muted-foreground/80">{line.new_line ?? ""}</span>
      <span className={`select-none px-2 font-semibold ${markerClassName}`}>{marker}</span>
      <code className="whitespace-pre px-2 font-mono text-current">{line.text || " "}</code>
    </div>
  );
}

function FileDiffPreview({ file }: { file: UserTurnReviewFile }) {
  return (
    <div
      data-testid="review-file-diff-preview"
      className="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center gap-3 border-b border-border/70 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium" title={file.path}>{file.path}</span>
        <span className="shrink-0 text-emerald-400">+{file.additions}</span>
        <span className="shrink-0 text-red-400">-{file.deletions}</span>
      </div>
      <div data-testid="review-file-diff-preview-body" className="max-h-72 overflow-auto bg-background/90 font-mono">
        {file.lines.length > 0 ? (
          file.lines.map((line, index) => (
            <DiffPreviewLine key={`${file.path}:${index}:${line.kind}`} line={line} />
          ))
        ) : (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">暂无可预览 diff</div>
        )}
      </div>
    </div>
  );
}

function UserTurnReviewSummaryCard({
  review,
  onOpenReview,
}: {
  review: UserTurnReview;
  onOpenReview?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const hoveredPreviewPathRef = useRef<string | null>(null);
  const previewUnlockedRef = useRef(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleFiles = expanded ? review.files : review.files.slice(0, 3);
  const remaining = Math.max(0, review.files.length - visibleFiles.length);

  const clearUnlockTimer = useCallback(() => {
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
  }, []);

  const clearLockTimer = useCallback(() => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }, []);

  const handlePreviewEnter = useCallback((path: string) => {
    hoveredPreviewPathRef.current = path;
    clearLockTimer();

    if (previewUnlockedRef.current) {
      setPreviewPath(path);
      return;
    }

    clearUnlockTimer();
    unlockTimerRef.current = setTimeout(() => {
      if (hoveredPreviewPathRef.current !== path) return;
      previewUnlockedRef.current = true;
      setPreviewPath(path);
    }, REVIEW_DIFF_PREVIEW_UNLOCK_MS);
  }, [clearLockTimer, clearUnlockTimer]);

  const handlePreviewLeave = useCallback((path: string) => {
    if (hoveredPreviewPathRef.current === path) {
      hoveredPreviewPathRef.current = null;
    }
    setPreviewPath((current) => (current === path ? null : current));
    clearUnlockTimer();
    clearLockTimer();
    lockTimerRef.current = setTimeout(() => {
      if (hoveredPreviewPathRef.current !== null) return;
      previewUnlockedRef.current = false;
    }, REVIEW_DIFF_PREVIEW_LOCK_MS);
  }, [clearLockTimer, clearUnlockTimer]);

  useEffect(() => () => {
    clearUnlockTimer();
    clearLockTimer();
  }, [clearLockTimer, clearUnlockTimer]);

  return (
    <div data-testid="user-turn-review-summary" className="my-4 w-full max-w-[820px] rounded-lg border border-border bg-card/70 shadow-sm">
      <div className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">已编辑 {review.totals.files} 个文件</div>
          <div className="mt-0.5 flex gap-2 text-xs">
            <span className="text-emerald-400">+{review.totals.additions}</span>
            <span className="text-red-400">-{review.totals.deletions}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenReview}
          className="shrink-0 cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          查看全部
        </button>
      </div>
      <div className="divide-y divide-border/70">
        {visibleFiles.map((file) => (
          <div
            key={file.path}
            data-testid="review-file-row"
            tabIndex={0}
            onMouseEnter={() => handlePreviewEnter(file.path)}
            onMouseLeave={() => handlePreviewLeave(file.path)}
            onFocus={() => handlePreviewEnter(file.path)}
            onBlur={() => handlePreviewLeave(file.path)}
            className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2 text-xs outline-none transition-colors hover:bg-muted/45 focus-visible:bg-muted/45"
          >
            <span className="truncate text-muted-foreground" title={file.path}>{file.path}</span>
            <span className="text-emerald-400">+{file.additions}</span>
            <span className="text-red-400">-{file.deletions}</span>
            {previewPath === file.path ? <FileDiffPreview file={file} /> : null}
          </div>
        ))}
      </div>
      {remaining > 0 || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full cursor-pointer px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
        >
          {expanded ? "收起文件" : `再显示 ${remaining} 个文件`}
        </button>
      ) : null}
    </div>
  );
}

function ScrollToBottomButton({ bottomOffset = 16 }: { bottomOffset?: number }) {
  const { isAtBottom } = useStickToBottomContext();
  const { follow } = useTranscriptScroll();
  return (
    !isAtBottom && (
      <button
        onClick={() => follow()}
        className="absolute left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-lg transition-colors hover:bg-muted"
        style={{ bottom: bottomOffset }}
      >
        ↓ 回到底部
      </button>
    )
  );
}

function HistoryLoadingOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center z-20 bg-background/80">
      <div className="flex items-center gap-2 text-muted-foreground">
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <span className="text-sm">加载消息...</span>
      </div>
    </div>
  );
}

function hasRenderableContent(message: UIMessage, showReasoning: boolean) {
  return message.parts.some((part) => {
    if (part.type === "text") return Boolean(part.text);
    if (part.type === "reasoning") return showReasoning && Boolean((part as { text?: string }).text);
    return part.type.startsWith("tool-");
  });
}

function messageTimestampValue(message: UIMessage): unknown {
  const timestamped = message as UIMessage & {
    createdAt?: unknown;
    created_at?: unknown;
    metadata?: {
      createdAt?: unknown;
      created_at?: unknown;
      turnTiming?: { startedAt?: unknown; finishedAt?: unknown };
    };
  };
  const explicit = timestamped.createdAt
    ?? timestamped.created_at
    ?? timestamped.metadata?.createdAt
    ?? timestamped.metadata?.created_at
    ?? timestamped.metadata?.turnTiming?.startedAt;
  if (explicit) return explicit;

  const idTimestamp = /^msg-(?:user|assistant)-(\d{13})(?:-|$)/.exec(message.id)?.[1];
  return idTimestamp ? Number(idTimestamp) : undefined;
}

function userTurnTiming(turn: UserTurnDisplay): TurnTiming {
  if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
    return {
      startedAt: turn.startedAt,
      finishedAt: turn.completedAt,
      durationMs: turn.activeDurationMs,
      activeDurationMs: turn.activeDurationMs,
      label: "finished",
    };
  }
  if (turn.status === "waiting_user") {
    return {
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      activeDurationMs: turn.activeDurationMs,
      label: "waiting",
    };
  }
  return {
    startedAt: turn.activeStartedAt ?? turn.startedAt,
    finishedAt: null,
    durationMs: null,
    activeDurationMs: turn.activeDurationMs,
    label: "working",
  };
}

function timestampMs(value: unknown): number | null {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value)
      : new Date(String(value));
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function findUserTurnStartIndex(
  messages: UIMessage[],
  turn: UserTurnDisplay,
  usedIndexes: Set<number>,
): number {
  const exactIndex = messages.findIndex((message, index) =>
    !usedIndexes.has(index) && message.id === turn.triggerMessageId
  );
  if (exactIndex >= 0) return exactIndex;

  const turnStartedAt = timestampMs(turn.startedAt);
  if (turnStartedAt !== null) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || message.role !== "user" || usedIndexes.has(index)) continue;
      const messageTimestamp = timestampMs(messageTimestampValue(message));
      if (messageTimestamp === null) continue;
      const delta = Math.abs(messageTimestamp - turnStartedAt);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestDelta <= 60_000) return bestIndex;
  }

  return messages.findIndex((message, index) =>
    !usedIndexes.has(index) && message.role === "user"
  );
}

/**
 * Pick a turn's anchor assistant message (the one whose id becomes the React
 * key for the whole rendered group) by earliest timestamp rather than array
 * position, so the anchor stays the same even if a merge ever produces a
 * turn's messages slightly out of chronological order.
 */
function pickAnchorAssistant(assistants: UIMessage[]): UIMessage | undefined {
  if (assistants.length <= 1) return assistants[0];
  let anchor = assistants[0]!;
  let anchorTimestamp = timestampMs(messageTimestampValue(anchor));
  for (const candidate of assistants.slice(1)) {
    const candidateTimestamp = timestampMs(messageTimestampValue(candidate));
    if (candidateTimestamp !== null && (anchorTimestamp === null || candidateTimestamp < anchorTimestamp)) {
      anchor = candidate;
      anchorTimestamp = candidateTimestamp;
    }
  }
  return anchor;
}

export function formatMessageTimestamp(value: unknown, now = new Date()): string | null {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value)
      : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (messageDay.getTime() === today.getTime()) return time;

  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  if (messageDay >= weekStart && messageDay < weekEnd) {
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${weekdays[date.getDay()]} ${time}`;
  }

  const monthAndDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === now.getFullYear()) return `${monthAndDay} ${time}`;

  return `${date.getFullYear()}年${monthAndDay} ${time}`;
}

function userGuideStatusLabel(message: UIMessage): string | null {
  const metadata = (message as { metadata?: { guideStatusLabel?: unknown } }).metadata;
  return typeof metadata?.guideStatusLabel === "string" ? metadata.guideStatusLabel : null;
}

function isRunningGuideMessage(message: UIMessage): boolean {
  return message.role === "user"
    && (message as { metadata?: { localMessageKind?: unknown } }).metadata?.localMessageKind === "running-guide";
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function isDecisionCardResultMessage(message: UIMessage): boolean {
  return message.role === "user" && /^clarification_card_id:\s*\S+/mu.test(messageText(message));
}

function timelineInputMessage(message: UIMessage): TimelineInputMessage {
  return message as unknown as TimelineInputMessage;
}

function guideMessageBlock(message: UIMessage, options: { showStatusLabel?: boolean } = {}): TranscriptBlock | null {
  if (isDecisionCardResultMessage(message)) return null;
  const rawText = messageText(message);
  const text = rawText;
  if (!text) return null;
  const browserAttachments = browserAttachmentsFromMessage(message);
  const imageAttachments = imageAttachmentsFromMessage(message)
    .filter((image) => !(browserAttachments.length > 0 && image.kind === "browser_comment"));
  const commentCount = browserAttachments.length;
  return {
    id: `${message.id}:guide-message`,
    type: "guide-message",
    text,
    statusLabel: options.showStatusLabel === false ? null : userGuideStatusLabel(message),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(browserAttachments.length > 0 ? { browserAttachments } : {}),
    ...(commentCount > 0 ? { commentCount } : {}),
  };
}

function browserAttachmentsFromMessage(message: UIMessage): BrowserElementAttachment[] {
  const metadata = (message as { metadata?: { browserElementAttachments?: unknown } }).metadata;
  return Array.isArray(metadata?.browserElementAttachments)
    ? metadata.browserElementAttachments as BrowserElementAttachment[]
    : [];
}

function imageAttachmentsFromMessage(message: UIMessage): MessageImageAttachment[] {
  const metadata = (message as { metadata?: { imageAttachments?: unknown } }).metadata;
  return Array.isArray(metadata?.imageAttachments)
    ? metadata.imageAttachments as MessageImageAttachment[]
    : [];
}

function browserAttachmentLabel(element: BrowserElementAttachment) {
  return element.ariaLabel || element.title || element.text || element.selector || element.tagName;
}

function imageAttachmentLabel(image: MessageImageAttachment, index: number) {
  return image.comment || image.label || image.name || `图片 ${index + 1}`;
}

function UserMessage({
  text,
  createdAt,
  browserAttachments = [],
  imageAttachments = [],
  statusLabel = null,
}: {
  text: string;
  createdAt?: unknown;
  browserAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  statusLabel?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [commentListOpen, setCommentListOpen] = useState(false);
  const timestamp = useMemo(() => formatMessageTimestamp(createdAt), [createdAt]);
  const displayImageAttachments = useMemo(
    () => imageAttachments.filter((image) => image.dataUrl && !(browserAttachments.length > 0 && image.kind === "browser_comment")),
    [browserAttachments.length, imageAttachments],
  );
  const previewImage = displayImageAttachments.find((item) => item.id === previewId) ?? null;
  const previewBrowser = browserAttachments.find((item) => item.id === previewId) ?? null;
  const preview = previewImage
    ? {
      src: previewImage.dataUrl,
      alt: imageAttachmentLabel(previewImage, displayImageAttachments.indexOf(previewImage)),
    }
    : previewBrowser
      ? {
        src: previewBrowser.screenshotDataUrl,
        alt: `网页注释 ${previewBrowser.markerNumber}`,
      }
      : null;
  const commentCount = browserAttachments.length;
  const commentRows = useMemo(() => {
    if (browserAttachments.length > 0) {
      return browserAttachments.map((element, index) => ({
        id: element.id,
        markerNumber: index + 1,
        label: browserAttachmentLabel(element),
        comment: element.comment || `标记${index + 1}`,
        screenshotDataUrl: element.screenshotDataUrl,
      }));
    }
    return [];
  }, [browserAttachments]);

  const handleCopy = useCallback(async () => {
    const copyText = text;
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <div data-testid="chat-message-user" className={styles.userRow}>
      <div className={styles.userMessageGroup}>
        {displayImageAttachments.length > 0 || browserAttachments.length > 0 ? (
          <div className={styles.browserCommentThumbs}>
            {displayImageAttachments.slice(0, 4).map((image, index) => (
              <button
                key={image.id}
                type="button"
                onClick={() => setPreviewId(image.id)}
                className={styles.userImageThumb}
                aria-label={`预览图片 ${imageAttachmentLabel(image, index)}`}
                title={imageAttachmentLabel(image, index)}
              >
                <ImageThumbnailContent src={image.dataUrl} alt="" />
              </button>
            ))}
            {browserAttachments.slice(0, 3).map((element) => (
              <button
                key={element.id}
                type="button"
                onClick={() => setPreviewId(element.id)}
                className={styles.browserCommentThumb}
                aria-label={`预览网页注释 ${browserAttachmentLabel(element)}`}
                title={`${browserAttachmentLabel(element)}\n${element.selector}`}
              >
                <ImageThumbnailContent src={element.screenshotDataUrl} alt="" fallback="截图" />
              </button>
            ))}
          </div>
        ) : null}
        {commentCount > 0 ? (
          <div
            className={styles.browserCommentBadgeWrap}
            onMouseEnter={() => setCommentListOpen(true)}
            onMouseLeave={() => setCommentListOpen(false)}
          >
            <div className={styles.browserCommentBadge}>
              <MessageSquareIcon className="size-3.5" />
              {commentCount} 条注释
            </div>
            {commentListOpen && commentRows.length > 0 ? (
              <div className={styles.browserCommentList}>
                {commentRows.map((row) => (
                  <div key={row.id} className={styles.browserCommentListItem}>
                    <button
                      type="button"
                      className={styles.browserCommentListThumb}
                      onClick={() => {
                        if (browserAttachments.length > 0) setPreviewId(row.id);
                      }}
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
        {text ? <div className={styles.userBubble}>{text}</div> : null}
        {statusLabel ? (
          <div className={styles.userGuideStatus}>{statusLabel}</div>
        ) : null}
        <div className={styles.userMeta}>
          {timestamp && <span className={styles.userMetaTime}>{timestamp}</span>}
          <button
            type="button"
            className={styles.userMetaAction}
            onClick={handleCopy}
            aria-label={copied ? "已复制消息" : "复制消息"}
            title={copied ? "已复制" : "复制"}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </button>
        </div>
      </div>
      {preview ? (
        <ImagePreviewOverlay
          src={preview.src}
          alt={preview.alt}
          emptyLabel="暂无截图"
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </div>
  );
}

function useCardMaps(
  decisionCards: DecisionCardData[] | undefined,
  decisionCardStatuses: Record<string, "pending" | "resolved" | "cancelled"> | undefined,
  decisionCardAnswers: Record<string, Record<string, string | string[]>> | undefined,
  specCards: Record<string, SpecCardState> | undefined,
  orchestrationPlans: OrchestrationPlanView[] | undefined,
) {
  return useMemo(() => {
    const decisionCardsById = new Map<string, DecisionCardData>();
    if (decisionCards) {
      for (const card of decisionCards) {
        const status = decisionCardStatuses?.[card.card_id] || card.status;
        const answers = decisionCardAnswers?.[card.card_id] ?? card.answers;
        decisionCardsById.set(card.card_id, { ...card, status, answers });
      }
    }

    const specCardsById = new Map<string, SpecCardState>();
    if (specCards) {
      for (const [id, card] of Object.entries(specCards)) {
        if (card) specCardsById.set(id, card);
      }
    }

    const plansByRevisionId = new Map((orchestrationPlans ?? []).map((plan) => [plan.revision.plan_revision_id, plan]));
    const latestPlanByUserTurnId = new Map<string, OrchestrationPlanView>();
    for (const plan of orchestrationPlans ?? []) {
      const current = latestPlanByUserTurnId.get(plan.user_turn_id);
      if (!current || current.revision.revision_number < plan.revision.revision_number) {
        latestPlanByUserTurnId.set(plan.user_turn_id, plan);
      }
    }
    return { decisionCardsById, specCardsById, plansByRevisionId, latestPlanByUserTurnId };
  }, [decisionCards, decisionCardStatuses, decisionCardAnswers, orchestrationPlans, specCards]);
}

export function ensureDurablePlanCard(blocks: TranscriptBlock[], plan?: OrchestrationPlanView) {
  if (!plan || blocks.some((block) => block.type === "plan-card" && block.planRevisionId === plan.revision.plan_revision_id)) return blocks;
  return [...blocks, {
    id: `durable-plan-card:${plan.revision.plan_revision_id}`,
    type: "plan-card" as const,
    planRevisionId: plan.revision.plan_revision_id,
    toolCallId: "durable-plan-state",
  }];
}

export function ensureDurableSpecCards(blocks: TranscriptBlock[], cards: Iterable<SpecCardState>) {
  const existingIds = new Set(
    blocks.flatMap((block) => block.type === "spec-card" ? [block.specApprovalId] : []),
  );
  const missing = [...cards].flatMap((card) => {
    if (existingIds.has(card.spec_approval_id)) return [];
    existingIds.add(card.spec_approval_id);
    return [{
      id: `durable-spec-card:${card.spec_approval_id}`,
      type: "spec-card" as const,
      specApprovalId: card.spec_approval_id,
      toolCallId: "durable-spec-state",
    }];
  });
  return missing.length > 0 ? [...blocks, ...missing] : blocks;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function submittedPlanRevisionId(output: unknown): string | null {
  const revision = recordValue(recordValue(output)?.revision);
  const revisionId = revision?.plan_revision_id ?? revision?.id;
  return typeof revisionId === "string" && revisionId ? revisionId : null;
}

function submissionToolMatchesPlan(
  tool: Extract<TranscriptBlock, { type: "tool-group" }>["tools"][number],
  plan: OrchestrationPlanView,
) {
  if (!tool.toolName.endsWith("__submit_orchestration_plan")) return false;
  const revisionId = submittedPlanRevisionId(tool.output);
  if (revisionId) return revisionId === plan.revision.plan_revision_id;

  const input = tool.input;
  const inputFlowId = typeof input?.flow_id === "string" ? input.flow_id : null;
  const inputTitle = typeof input?.title === "string" ? input.title : null;
  return inputFlowId === plan.flow_id && inputTitle === plan.revision.title;
}

/**
 * Reconcile a persisted orchestration plan with an SDK transcript that still
 * contains the earlier live `submit_orchestration_plan` input state. The
 * persisted revision id is authoritative; flow + title is only used when the
 * stale SDK part has not retained its output yet.
 */
export function reconcileDurablePlanCard(
  blocks: TranscriptBlock[],
  plans: OrchestrationPlanView[],
  preferredPlan?: OrchestrationPlanView,
) {
  const tools = blocks
    .filter((block): block is Extract<TranscriptBlock, { type: "tool-group" }> => block.type === "tool-group")
    .flatMap((block) => block.tools)
    .filter((tool) => tool.toolName.endsWith("__submit_orchestration_plan"));

  const matchedPlan = preferredPlan ?? plans.find((plan) => tools.some((tool) => submissionToolMatchesPlan(tool, plan)));
  if (!matchedPlan) return blocks;

  const reconciled = blocks.map((block) => {
    if (block.type !== "tool-group") return block;
    let changed = false;
    const reconciledTools = block.tools.map((tool) => {
      if (tool.state !== "running" || !submissionToolMatchesPlan(tool, matchedPlan)) return tool;
      changed = true;
      return { ...tool, state: "completed" as const };
    });
    if (!changed) return block;
    const hasRunningTool = reconciledTools.some((tool) => tool.state === "running");
    return {
      ...block,
      tools: reconciledTools,
      finalized: hasRunningTool ? block.finalized : true,
      activeState: hasRunningTool ? block.activeState : undefined,
      currentToolCallId: hasRunningTool ? block.currentToolCallId : null,
    };
  });

  return ensureDurablePlanCard(reconciled, matchedPlan);
}

export function interleaveHistoryBoundaries(
  messages: UIMessage[],
  boundaries: HistorySessionBoundary[],
) {
  const byBeforeMessage = new Map<string, HistorySessionBoundary[]>();
  const trailing: HistorySessionBoundary[] = [];
  for (const boundary of boundaries) {
    if (boundary.before_message_id) {
      const list = byBeforeMessage.get(boundary.before_message_id) ?? [];
      list.push(boundary);
      byBeforeMessage.set(boundary.before_message_id, list);
    } else {
      trailing.push(boundary);
    }
  }
  const result: Array<UIMessage | HistorySessionBoundary> = [];
  for (const message of messages) {
    result.push(...(byBeforeMessage.get(message.id) ?? []));
    result.push(message);
  }
  result.push(...trailing);
  return result;
}

type TranscriptStatusDivider = {
  kind: "status_divider";
  id: string;
  label: string;
  animated: boolean;
};

export function interleaveStatusDivider(
  items: Array<UIMessage | HistorySessionBoundary>,
  label: string | null | undefined,
  animated: boolean,
  dividerAt: string | null | undefined,
) {
  if (!label) return items;
  const divider: TranscriptStatusDivider = {
    kind: "status_divider",
    id: `status-divider:${dividerAt ?? label}`,
    label,
    animated,
  };
  const dividerTimestamp = timestampMs(dividerAt);
  if (dividerTimestamp === null) return [...items, divider];
  const nextMessageIndex = items.findIndex((item) => {
    if (isHistoryBoundary(item)) return false;
    const messageTimestamp = timestampMs(messageTimestampValue(item));
    return messageTimestamp !== null && messageTimestamp > dividerTimestamp;
  });
  if (nextMessageIndex < 0) return [...items, divider];
  return [...items.slice(0, nextMessageIndex), divider, ...items.slice(nextMessageIndex)];
}

function isHistoryBoundary(value: UIMessage | HistorySessionBoundary): value is HistorySessionBoundary {
  return "kind" in value && value.kind === "history_session_boundary";
}

function isStatusDivider(value: UIMessage | HistorySessionBoundary | TranscriptStatusDivider): value is TranscriptStatusDivider {
  return "kind" in value && value.kind === "status_divider";
}

function SessionTranscriptContent({
  messages,
  historyBoundaries,
  isLoadingHistory,
  emptyTitle,
  emptyDescription,
  decisionCards,
  decisionCardStatuses,
  decisionCardAnswers,
  specCards,
  orchestrationPlans,
  isAwaitingResponse,
  followRequestKey,
  flowId,
  onOpenSpec,
  onOpenPlan,
  onApprovePlan,
  activity,
  activityMessageId,
  activeTurnTiming,
  userTurns,
  review,
  onOpenReview,
  onOpenWorkspaceFile,
  expandedDecisionResultIds,
  showReasoning,
  bottomOverlayHeight,
  statusDividerLabel,
  statusDividerAnimated,
  statusDividerAt,
  workspaceRootPath,
}: {
  messages: UIMessage[];
  historyBoundaries: HistorySessionBoundary[];
  isLoadingHistory: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  decisionCards?: DecisionCardData[];
  decisionCardStatuses?: Record<string, "pending" | "resolved" | "cancelled">;
  decisionCardAnswers?: Record<string, Record<string, string | string[]>>;
  specCards?: Record<string, SpecCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  isAwaitingResponse: boolean;
  followRequestKey?: number;
  flowId: string | null;
  onOpenSpec?: (specRevisionId: string, title: string) => void;
  onOpenPlan?: (plan: OrchestrationPlanView) => void;
  onApprovePlan?: (plan: OrchestrationPlanView) => void;
  activity?: TranscriptActivity | null;
  activityMessageId?: string | null;
  activeTurnTiming?: TurnTiming | null;
  userTurns?: UserTurnDisplay[];
  review?: UserTurnReview | null;
  onOpenReview?: () => void;
  onOpenWorkspaceFile?: (path: string) => void;
  expandedDecisionResultIds: Set<string>;
  showReasoning: boolean;
  bottomOverlayHeight?: number;
  statusDividerLabel?: string | null;
  statusDividerAnimated?: boolean;
  statusDividerAt?: string | null;
  workspaceRootPath?: string | null;
}) {
  const wasLoadingRef = useRef(false);
  const lastFollowRequestKeyRef = useRef(followRequestKey);
  const { follow, registerThread } = useTranscriptScroll();
  const { decisionCardsById, specCardsById, plansByRevisionId, latestPlanByUserTurnId } = useCardMaps(
    decisionCards,
    decisionCardStatuses,
    decisionCardAnswers,
    specCards,
    orchestrationPlans,
  );

  const visibleMessages = messages.filter((message) => {
    if (activity !== null && message.id === activityMessageId) return true;
    return hasRenderableContent(message, showReasoning);
  });

  const timelineItems = interleaveStatusDivider(
    interleaveHistoryBoundaries(visibleMessages, historyBoundaries),
    statusDividerLabel,
    Boolean(statusDividerAnimated),
    statusDividerAt,
  );
  const { userTurnRenderTargets, userTurnGroupedMessageIds } = useMemo(() => {
    const targets = new Map<string, { activity: TranscriptActivity; timing: TurnTiming; messageIds: string[]; turn?: UserTurnDisplay }>();
    const grouped = new Set<string>();
    if (!userTurns || userTurns.length === 0) {
      // Continue to inferred grouping below. Active snapshots can arrive before
      // user turn state after switching flows.
    } else {
      const usedStartIndexes = new Set<number>();
      const turnStartIndexes: Array<{ turn: UserTurnDisplay; startIndex: number }> = [];
      for (const turn of userTurns) {
        const startIndex = findUserTurnStartIndex(visibleMessages, turn, usedStartIndexes);
        if (startIndex < 0) continue;
        usedStartIndexes.add(startIndex);
        turnStartIndexes.push({ turn, startIndex });
      }
      turnStartIndexes.sort((left, right) => left.startIndex - right.startIndex);

      for (let index = 0; index < turnStartIndexes.length; index += 1) {
        const item = turnStartIndexes[index];
        if (!item) continue;
        const { turn, startIndex } = item;
        const endIndex = turnStartIndexes[index + 1]?.startIndex ?? visibleMessages.length;
        const turnMessages = visibleMessages
          .slice(startIndex + 1, endIndex)
          .filter((message) => message.role === "assistant" || message.role === "user");
        const assistants = turnMessages.filter((message) => message.role === "assistant");
        for (const message of turnMessages) grouped.add(message.id);
        const assistant = pickAnchorAssistant(assistants);
        if (!assistant) continue;
        targets.set(assistant.id, {
          activity: turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled"
            ? "finished"
            : "waiting",
          timing: userTurnTiming(turn),
          messageIds: turnMessages.map((message) => message.id),
          turn,
        });
      }
    }

    // The backend-driven grouping above is authoritative when it accounts for
    // every assistant message; only fall back to the inferred heuristic below
    // for turns it hasn't covered yet (e.g. userTurns arriving late after a
    // flow switch). Skipping it entirely once fully covered avoids the two
    // algorithms ever picking different anchor ids for the same turn.
    const allAssistantsCovered = visibleMessages.every(
      (message) => message.role !== "assistant" || grouped.has(message.id),
    );

    for (let startIndex = 0; !allAssistantsCovered && startIndex < visibleMessages.length; startIndex += 1) {
      const startMessage = visibleMessages[startIndex];
      if (!startMessage || startMessage.role !== "user" || isRunningGuideMessage(startMessage)) continue;
      const nextUserIndex = visibleMessages.findIndex(
        (message, index) => index > startIndex && message.role === "user" && !isRunningGuideMessage(message),
      );
      const endIndex = nextUserIndex < 0 ? visibleMessages.length : nextUserIndex;
      const turnMessages = visibleMessages
        .slice(startIndex + 1, endIndex)
        .filter((message) => message.role === "assistant" || isRunningGuideMessage(message));
      const activeInTurn = Boolean(activityMessageId && turnMessages.some((message) => message.id === activityMessageId));
      const assistants = turnMessages.filter((message) => message.role === "assistant");
      const assistant = pickAnchorAssistant(assistants);
      if (!assistant || targets.has(assistant.id)) continue;
      const hasGuides = turnMessages.some(isRunningGuideMessage);
      const completedTiming = [...assistants]
        .reverse()
        .map((message) => readHistoryTurnTiming(message))
        .find((timing): timing is TurnTiming => timing !== null);
      if (!activeInTurn && (!hasGuides || !completedTiming)) continue;
      const targetTiming = activeInTurn ? activeTurnTiming ?? completedTiming : completedTiming;
      if (!targetTiming) continue;
      for (const message of turnMessages) grouped.add(message.id);
      targets.set(assistant.id, {
        activity: activeInTurn ? activity ?? "waiting" : "finished",
        timing: targetTiming,
        messageIds: turnMessages.map((message) => message.id),
      });
    }

    return { userTurnRenderTargets: targets, userTurnGroupedMessageIds: grouped };
  }, [activity, activityMessageId, activeTurnTiming, userTurns, visibleMessages]);
  const durableSpecTargetMessageId = [...visibleMessages].reverse().find(
    (message) => message.role === "assistant"
      && (!userTurnGroupedMessageIds.has(message.id) || userTurnRenderTargets.has(message.id)),
  )?.id;
  const durableSpecCards = [...specCardsById.values()].filter((card) =>
    !visibleMessages.some((message) => message.role === "assistant"
      && buildTranscriptTimeline({ message: timelineInputMessage(message), activity: "finished" })
        .some((block) => block.type === "spec-card" && block.specApprovalId === card.spec_approval_id))
  );
  const activeAssistantMessage = visibleMessages.find(
    (message) => message.role === "assistant" && message.id === activityMessageId,
  );
  const lastVisibleMessage = visibleMessages.at(-1);
  const durablePlanFallback = visibleMessages.length === 0
    ? [...latestPlanByUserTurnId.values()].reduce<OrchestrationPlanView | undefined>(
      (latest, plan) => !latest || latest.revision.created_at < plan.revision.created_at ? plan : latest,
      undefined,
    )
    : undefined;
  const durablePlanTurn = durablePlanFallback
    ? userTurns?.find((turn) => turn.id === durablePlanFallback.user_turn_id)
    : undefined;
  const showThinkingIndicator =
    isAwaitingResponse && !durablePlanFallback && !activeAssistantMessage && lastVisibleMessage?.role !== "assistant";

  useEffect(() => {
    if (wasLoadingRef.current && !isLoadingHistory) {
      follow();
    }
    wasLoadingRef.current = isLoadingHistory;
  }, [follow, isLoadingHistory]);

  useEffect(() => {
    if (followRequestKey === undefined || followRequestKey === lastFollowRequestKeyRef.current) return;
    lastFollowRequestKeyRef.current = followRequestKey;
    follow();
  }, [follow, followRequestKey]);

  return (
    <>
      <StickToBottom.Content
        className="min-h-full"
        scrollClassName={styles.transcriptScroll}
        data-testid="transcript-thread"
      >
          <div
            ref={registerThread}
            className={styles.thread}
            style={bottomOverlayHeight ? { "--transcript-bottom-overlay": `${bottomOverlayHeight}px` } as CSSProperties : undefined}
          >
            {visibleMessages.length === 0 && !durablePlanFallback && !isLoadingHistory && !isAwaitingResponse && (
              <ConversationEmptyState
                title={emptyTitle}
                description={emptyDescription}
                icon={<MessageSquareIcon className="size-8" />}
              />
            )}

            {durablePlanFallback ? (
              <TranscriptTimelineRenderer
                key={`durable-plan-fallback:${durablePlanFallback.revision.plan_revision_id}`}
                turnId={`durable-plan-fallback:${durablePlanFallback.user_turn_id}`}
                blocks={ensureDurablePlanCard([], durablePlanFallback)}
                flowId={flowId ?? ""}
                decisionCardsById={decisionCardsById}
                specCardsById={specCardsById}
                plansByRevisionId={plansByRevisionId}
                onSpecOpen={onOpenSpec ?? (() => {})}
                onPlanOpen={onOpenPlan ?? (() => {})}
                onPlanApprove={onApprovePlan ?? (() => {})}
                activity="finished"
                turnTiming={durablePlanTurn ? userTurnTiming(durablePlanTurn) : null}
                showReasoning={showReasoning}
                workspaceRootPath={durablePlanTurn?.workRootPath?.trim() || workspaceRootPath}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                data-testid="chat-message-assistant"
              />
            ) : null}

          {timelineItems.map((item) => {
            if (isStatusDivider(item)) {
              return (
                <div key={item.id} data-testid="transcript-status-divider" className={styles.compactionDivider}>
                  <span
                    className={`${item.animated ? styles.animatedStatusText : ""} ${styles.compactionDividerText}`}
                    data-text={item.label}
                  >
                    {item.label}
                  </span>
                </div>
              );
            }
            if (isHistoryBoundary(item)) {
              return (
                <div key={item.id} data-testid="history-session-boundary" className={styles.historyBoundary}>
                  {item.status === "loaded"
                    ? `历史会话：${item.display_name}`
                    : `历史会话不可用：${item.display_name}`}
                </div>
              );
            }
            const msg = item;
            const isActive = msg.id === activityMessageId;
            const userTurnTarget = userTurnRenderTargets.get(msg.id);
            const groupedByUserTurn = userTurnGroupedMessageIds.has(msg.id);
            if (groupedByUserTurn && !userTurnTarget) return null;

            if (isRunningGuideMessage(msg)) {
              return (
                <UserMessage
                  key={msg.id}
                  text={messageText(msg)}
                  createdAt={messageTimestampValue(msg)}
                  browserAttachments={browserAttachmentsFromMessage(msg)}
                  imageAttachments={imageAttachmentsFromMessage(msg)}
                  statusLabel={userGuideStatusLabel(msg) ?? "已引导对话"}
                />
              );
            }

            if (msg.role === "user") {
              const blocks = buildTranscriptTimeline({ message: timelineInputMessage(msg), activity: "finished" });
              const hasDecisionResult = blocks.some((block) => block.type === "decision-card-result");
              if (hasDecisionResult) {
                const projectedBlocks = blocks.map((block) =>
                  block.type === "decision-card-result" && expandedDecisionResultIds.has(block.cardId)
                    ? { ...block, collapseState: "expanded" as const }
                    : block
                );
                return (
                  <TranscriptTimelineRenderer
                    key={msg.id}
                    turnId={msg.id}
                    blocks={projectedBlocks}
                    flowId={flowId ?? ""}
                    decisionCardsById={decisionCardsById}
                  specCardsById={specCardsById}
                  plansByRevisionId={plansByRevisionId}
                  onSpecOpen={onOpenSpec ?? (() => {})}
                  onPlanOpen={onOpenPlan ?? (() => {})}
                  onPlanApprove={onApprovePlan ?? (() => {})}
                    activity="finished"
                    showReasoning={showReasoning}
                    workspaceRootPath={workspaceRootPath}
                    onOpenWorkspaceFile={onOpenWorkspaceFile}
                    data-testid="chat-message-decision-result"
                  />
                );
              }

              return (
                <UserMessage
                  key={msg.id}
                  text={messageText(msg)}
                  createdAt={messageTimestampValue(msg)}
                  browserAttachments={browserAttachmentsFromMessage(msg)}
                  imageAttachments={imageAttachmentsFromMessage(msg)}
                />
              );
            }

            const projectionActivity: TranscriptActivity = isActive ? activity ?? "finished" : "finished";
            const rendererActivity = userTurnTarget
              ? userTurnTarget.activity
              : isActive
                ? activity ?? undefined
                : groupedByUserTurn
                  ? undefined
                  : "finished";
            const rendererTurnTiming = userTurnTarget
              ? userTurnTarget.timing
              : isActive
                ? activeTurnTiming
                : groupedByUserTurn
                  ? null
                  : readHistoryTurnTiming(msg);
            const targetMessages = userTurnTarget
              ? userTurnTarget.messageIds
                .map((messageId) => visibleMessages.find((message) => message.id === messageId))
                .filter((message): message is UIMessage => Boolean(message))
              : [msg];
            const blocks = targetMessages.flatMap((message) => {
              const guideBlock = ((userTurnTarget && message.role === "user") || isRunningGuideMessage(message))
                ? guideMessageBlock(message)
                : null;
              if (guideBlock) return [guideBlock];
              return buildTranscriptTimeline({
                message: timelineInputMessage(message),
                activity: message.id === activityMessageId ? activity ?? "finished" : projectionActivity,
              });
            });
            const planReconciledBlocks = reconcileDurablePlanCard(
              blocks,
              orchestrationPlans ?? [],
              userTurnTarget?.turn ? latestPlanByUserTurnId.get(userTurnTarget.turn.id) : undefined,
            );
            const renderedBlocks = msg.id === durableSpecTargetMessageId
              ? ensureDurableSpecCards(planReconciledBlocks, durableSpecCards)
              : planReconciledBlocks;
            const activeInGroup = targetMessages.some((message) => message.id === activityMessageId);
            const reviewForTurn = userTurnTarget?.turn
              && userTurnTarget.turn.status === "completed"
              && review?.user_turn_id === userTurnTarget.turn.id
              ? review
              : null;

            return (
              <TranscriptTimelineRenderer
                key={msg.id}
                turnId={msg.id}
                blocks={renderedBlocks}
                flowId={flowId ?? ""}
                decisionCardsById={decisionCardsById}
                specCardsById={specCardsById}
                plansByRevisionId={plansByRevisionId}
                onSpecOpen={onOpenSpec ?? (() => {})}
                onPlanOpen={onOpenPlan ?? (() => {})}
                onPlanApprove={onApprovePlan ?? (() => {})}
                activity={rendererTurnTiming ? rendererActivity : undefined}
                turnTiming={rendererTurnTiming}
                showReasoning={showReasoning}
                workspaceRootPath={userTurnTarget?.turn?.workRootPath?.trim() || workspaceRootPath}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                beforeFooter={reviewForTurn ? <UserTurnReviewSummaryCard review={reviewForTurn} onOpenReview={onOpenReview} /> : undefined}
                data-testid="chat-message-assistant"
                data-transcript-activity={activeInGroup ? activity ?? undefined : undefined}
              />
            );
          })}

            {showThinkingIndicator && (
              <div data-testid="chat-message-assistant" data-transcript-activity="waiting">
                <div className={styles.assistant}>
                  <div className={styles.thinkingRow}>
                    <span className={styles.rowSpinner} role="status" />
                    正在思考
                  </div>
                </div>
              </div>
            )}
          </div>
      </StickToBottom.Content>

      {isLoadingHistory && <HistoryLoadingOverlay />}
      <ScrollToBottomButton bottomOffset={(bottomOverlayHeight ?? 0) + 16} />
    </>
  );
}

export default function SessionTranscriptPanel({
  flowId,
  agentSessionId,
  flowExpertId = null,
  readonly,
  emptyTitle = "暂无消息",
  emptyDescription,
  decisionCards,
  decisionCardStatuses,
  decisionCardAnswers,
  specCards,
  orchestrationPlans,
  optimisticMessages = [],
  followRequestKey,
  isAwaitingResponse = false,
  allowInferredAgentSessionId = false,
  className,
  bottomOverlayHeight,
  onOpenSpec,
  onOpenPlan,
  onApprovePlan,
  showReasoning: showReasoningOverride,
  userTurns,
  review,
  onOpenReview,
  onOpenWorkspaceFile,
  statusDividerLabel,
  statusDividerAnimated,
  statusDividerAt,
  workspaceRootPath,
}: SessionTranscriptPanelProps) {
  void readonly;
  const storeShowReasoning = useAppPreferencesStore((state) => state.showReasoning);
  const showReasoning = showReasoningOverride ?? storeShowReasoning;
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, emptyTranscriptState);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const prevFlowIdRef = useRef<string | null>(null);
  const prevFlowExpertIdRef = useRef<string | null>(null);
  const prevAgentSessionIdRef = useRef<string | null>(null);
  const lastRealAgentSessionIdRef = useRef<string | null>(null);
  const fetchedSessionRef = useRef<string | null>(null);
  const eventFrameRef = useRef<number | null>(null);
  const finishResyncTimersRef = useRef<number[]>([]);
  const pendingEventsRef = useRef<Array<{ cursor: number; event: TranscriptEvent }>>([]);
  const activeFlowIdRef = useRef<string | null>(flowId);
  const activeFlowExpertIdRef = useRef<string | null>(flowExpertId);
  const activeAgentSessionIdRef = useRef<string | null>(agentSessionId);
  const inferredAgentSessionIdRef = useRef<string | null>(null);

  activeFlowIdRef.current = flowId;
  activeFlowExpertIdRef.current = flowExpertId;
  activeAgentSessionIdRef.current = agentSessionId ?? (allowInferredAgentSessionId ? inferredAgentSessionIdRef.current : null);

  const flushPendingEvents = useCallback(() => {
    if (eventFrameRef.current !== null) {
      window.cancelAnimationFrame(eventFrameRef.current);
      eventFrameRef.current = null;
    }
    const events = pendingEventsRef.current;
    pendingEventsRef.current = [];
    if (events.length > 0) {
      dispatchTranscript({ type: "apply-events", events });
    }
  }, []);

  const scheduleTranscriptEvent = useCallback((item: { cursor: number; event: TranscriptEvent }) => {
    if (!shouldBatchTranscriptEvent(item.event)) {
      flushPendingEvents();
      dispatchTranscript({ type: "apply-events", events: [item] });
      return;
    }
    pendingEventsRef.current.push(item);
    if (eventFrameRef.current !== null) return;
    eventFrameRef.current = window.requestAnimationFrame(() => {
      eventFrameRef.current = null;
      const events = pendingEventsRef.current;
      pendingEventsRef.current = [];
      if (events.length > 0) dispatchTranscript({ type: "apply-events", events });
    });
  }, [flushPendingEvents]);

  const cancelPendingEventFlush = useCallback(() => {
    if (eventFrameRef.current !== null) {
      window.cancelAnimationFrame(eventFrameRef.current);
      eventFrameRef.current = null;
    }
    pendingEventsRef.current = [];
  }, []);

  const clearFinishResyncTimers = useCallback(() => {
    for (const timer of finishResyncTimersRef.current) window.clearTimeout(timer);
    finishResyncTimersRef.current = [];
  }, []);

  const scheduleFinishedSnapshotResync = useCallback((
    targetFlowId: string,
    targetAgentSessionId: string | null,
    targetFlowExpertId: string | null,
  ) => {
    clearFinishResyncTimers();
    finishResyncTimersRef.current = [750, 2_500].map((delayMs) =>
      window.setTimeout(() => {
        if (activeFlowIdRef.current !== targetFlowId) return;
        if (activeFlowExpertIdRef.current !== targetFlowExpertId) return;
        if ((activeAgentSessionIdRef.current ?? null) !== (targetAgentSessionId ?? null)) return;
        wsClient.sendSessionGet(targetFlowId, "", targetAgentSessionId ?? undefined, targetFlowExpertId ?? undefined);
      }, delayMs)
    );
  }, [clearFinishResyncTimers]);

  useEffect(() => {
    const prevFlowId = prevFlowIdRef.current;
    const prevFlowExpertId = prevFlowExpertIdRef.current;
    const prevSessionId = prevAgentSessionIdRef.current;

    if (flowId !== prevFlowId || flowExpertId !== prevFlowExpertId) {
      prevFlowIdRef.current = flowId;
      prevFlowExpertIdRef.current = flowExpertId;
      prevAgentSessionIdRef.current = agentSessionId;
      // Only overwrite the "last real" tracker with a genuine session id.
      // agentSessionId is transiently null right after switching flows
      // (useDashboardData resets it before a fresh flow:state repopulates
      // it); blindly overwriting here erases the previous real value, so
      // the mismatch check below (guarding whether a resync is needed once
      // the real id arrives) silently no-ops instead of detecting a change.
      if (agentSessionId !== null) {
        lastRealAgentSessionIdRef.current = agentSessionId;
      }
      inferredAgentSessionIdRef.current = agentSessionId;
      fetchedSessionRef.current = null;
      cancelPendingEventFlush();
      clearFinishResyncTimers();
      dispatchTranscript({ type: "reset" });
    } else if (agentSessionId !== prevSessionId) {
      prevAgentSessionIdRef.current = agentSessionId;
      if (agentSessionId !== null) {
        inferredAgentSessionIdRef.current = agentSessionId;
      }
      const lastRealAgentSessionId = lastRealAgentSessionIdRef.current;
      if (agentSessionId !== null && lastRealAgentSessionId !== null && lastRealAgentSessionId !== agentSessionId) {
        fetchedSessionRef.current = null;
        cancelPendingEventFlush();
        dispatchTranscript({ type: "reset" });
      }
      if (agentSessionId !== null) {
        lastRealAgentSessionIdRef.current = agentSessionId;
      }
    }

    if (!flowId || (!agentSessionId && !flowExpertId)) {
      fetchedSessionRef.current = null;
      setIsLoadingHistory(false);
      return;
    }

    const fetchKey = flowExpertId
      ? `${flowId}:fexp:${flowExpertId}`
      : `${flowId}:ags:${agentSessionId}`;
    if (fetchKey === fetchedSessionRef.current) return;
    fetchedSessionRef.current = fetchKey;

    setIsLoadingHistory(true);
    if (flowExpertId) {
      wsClient.sendSessionGet(flowId, "", agentSessionId ?? undefined, flowExpertId);
    } else {
      wsClient.sendSessionGet(flowId, "", agentSessionId ?? undefined);
    }
  }, [flowId, flowExpertId, agentSessionId, cancelPendingEventFlush, clearFinishResyncTimers]);

  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    dispatchTranscript({ type: "append-optimistic", messages: optimisticMessages });
  }, [optimisticMessages]);

  useEffect(() => {
    if (!flowId) return;

    const unsubscribe = wsClient.onMessage((msg: WsInMessage) => {
      const activeFlowId = activeFlowIdRef.current;
      const activeFlowExpertId = activeFlowExpertIdRef.current;
      const activeAgentSessionId = activeAgentSessionIdRef.current;
      if (msg.flow_id !== activeFlowId) return;

      if (msg.type === "flow:decision_card_resolved" && !activeFlowExpertId) {
        const cardId = typeof msg.data?.card_id === "string" ? msg.data.card_id : "";
        if (cardId) {
          const isCancelled = msg.data?.status === "cancelled";
          const messageId = typeof msg.data?.message_id === "string"
            ? msg.data.message_id
            : `live-decision-${cardId}`;
          dispatchTranscript({
            type: "decision-card-resolved",
            cardId,
            messageId,
            status: isCancelled ? "cancelled" : "resolved",
            createdAt: new Date(),
          });
        }
        return;
      }

      if (activeFlowExpertId) {
        if (extractMessageFlowExpertId(msg) !== activeFlowExpertId) return;
      } else {
        const msgAgentSessionId = extractMessageAgentSessionId(msg);
        if (msgAgentSessionId !== activeAgentSessionId) {
          if (allowInferredAgentSessionId && activeAgentSessionId === null && msgAgentSessionId) {
            inferredAgentSessionIdRef.current = msgAgentSessionId;
            activeAgentSessionIdRef.current = msgAgentSessionId;
          } else {
            return;
          }
        }
      }

      if (msg.type === "session:event" && String(msg.data?.status ?? "") === "interrupted") {
        flushPendingEvents();
        dispatchTranscript({ type: "finish-active", finishedAt: new Date().toISOString() });
        wsClient.sendSessionGet(activeFlowId, "", activeAgentSessionId ?? undefined, activeFlowExpertId ?? undefined);
        scheduleFinishedSnapshotResync(activeFlowId, activeAgentSessionId, activeFlowExpertId);
        return;
      }

      if (msg.type === "flow_expert:event" && activeFlowExpertId) {
        const expertStatus = String(msg.data?.status ?? "");
        if (["completed", "failed"].includes(expertStatus)) {
          wsClient.sendSessionGet(activeFlowId, "", activeAgentSessionId ?? undefined, activeFlowExpertId);
        }
        return;
      }

      if (msg.type === "session:transcript_snapshot") {
        setIsLoadingHistory(false);
        flushPendingEvents();
        dispatchTranscript({
          type: "load-snapshot",
          cursor: msg.data.cursor,
          messages: msg.data.messages,
          historyBoundaries: msg.data.history_boundaries ?? [],
          activeTurn: msg.data.active_turn,
        });
        return;
      }

      if (msg.type === "session:transcript_event") {
        setIsLoadingHistory(false);
        const event = msg.data.event as TranscriptEvent;
        scheduleTranscriptEvent({ cursor: msg.data.cursor, event });
        if (event.type === "turn-finished") {
          wsClient.sendSessionGet(activeFlowId, "", activeAgentSessionId ?? undefined, activeFlowExpertId ?? undefined);
          scheduleFinishedSnapshotResync(activeFlowId, activeAgentSessionId, activeFlowExpertId);
        }
      }
    });

    return unsubscribe;
  }, [flowId, flowExpertId, agentSessionId, allowInferredAgentSessionId, flushPendingEvents, scheduleFinishedSnapshotResync, scheduleTranscriptEvent]);

  useEffect(() => {
    if (!transcript.needsResync || !flowId) return;
    dispatchTranscript({ type: "resync-requested" });
    wsClient.sendSessionGet(flowId, "", agentSessionId ?? undefined, flowExpertId ?? undefined);
  }, [agentSessionId, flowExpertId, flowId, transcript.needsResync]);

  useEffect(() => {
    return () => {
      cancelPendingEventFlush();
      clearFinishResyncTimers();
    };
  }, [cancelPendingEventFlush, clearFinishResyncTimers]);

  return (
    <StickToBottom
      className={`relative h-full overflow-y-hidden ${className || ""}`}
      resize="instant"
      initial="instant"
    >
      <TranscriptScrollProvider>
        <SessionTranscriptContent
        messages={transcript.messages}
        historyBoundaries={transcript.historyBoundaries}
        isLoadingHistory={isLoadingHistory}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        decisionCards={decisionCards}
        decisionCardStatuses={decisionCardStatuses}
        decisionCardAnswers={decisionCardAnswers}
        specCards={specCards}
        orchestrationPlans={orchestrationPlans}
        followRequestKey={followRequestKey}
        isAwaitingResponse={isAwaitingResponse}
        flowId={flowId}
        onOpenSpec={onOpenSpec}
        onOpenPlan={onOpenPlan}
        onApprovePlan={onApprovePlan}
        activity={transcript.activeTurn?.activity ?? null}
        activityMessageId={transcript.activeTurn?.renderMessageId ?? null}
        activeTurnTiming={transcript.activeTurn?.timing ?? null}
        userTurns={userTurns}
        review={review}
        onOpenReview={onOpenReview}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        expandedDecisionResultIds={transcript.expandedDecisionResultIds}
        showReasoning={showReasoning}
        bottomOverlayHeight={bottomOverlayHeight}
        statusDividerLabel={statusDividerLabel}
        statusDividerAnimated={statusDividerAnimated}
        statusDividerAt={statusDividerAt}
        workspaceRootPath={workspaceRootPath}
      />
      </TranscriptScrollProvider>
    </StickToBottom>
  );
}

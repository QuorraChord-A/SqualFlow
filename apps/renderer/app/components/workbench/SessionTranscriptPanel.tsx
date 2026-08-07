"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ConversationEmptyState } from "@/components/ai-elements-official/conversation";
import { PromptInlineContent } from "@/components/ai-elements-official/prompt-inline-entity";
import { CheckIcon, CopyIcon, MessageSquareIcon } from "lucide-react";
import { wsClient } from "../../lib/ws";
import type { TranscriptTimelineItem, WsInMessage } from "../../lib/ws";
import {
  extractMessageAgentRunId,
  extractMessageAgentSessionId,
} from "./transcriptUtils";
import TranscriptTimelineRenderer from "./transcript/TranscriptTimelineRenderer";
import ThinkingIndicator from "./transcript/ThinkingIndicator";
import {
  buildTranscriptTimeline,
  readHistoryTurnTiming,
} from "./transcript/buildTranscriptTimeline";
import type { TimelineInputMessage, TranscriptActivity, TranscriptBlock } from "./transcript/types";
import type { TurnTiming } from "./transcript/buildTranscriptTimeline";
import type { DecisionRequestCardData, PlanCardState } from "../../hooks/useDashboardData";
import type { OrchestrationPlanView } from "../../types/orchestration";
import { useAppPreferencesStore } from "../../stores/useAppPreferencesStore";
import type { BrowserElementAttachment } from "../../stores/useBrowserSelectionStore";
import type { MessageImageAttachment } from "../../types/messageAttachments";
import styles from "./transcript/transcript.module.css";
import { TranscriptScrollProvider, useTranscriptScroll } from "./transcript/TranscriptScrollContext";
import {
  emptyTranscriptState,
  transcriptReducer,
  projectTranscriptPresentationItems,
  type TranscriptCommittedEvent,
  type TranscriptEvent,
  type TranscriptPresentationItem,
} from "./transcript/transcriptState";
import { ImagePreviewOverlay, ImageThumbnailContent } from "./transcript/ImagePreview";
import { isMcpToolNamed, parseMcpOutput } from "./transcript/mcpToolPresenters";

export interface SessionTranscriptPanelProps {
  flowId: string | null;
  agentRunId: string | null;
  agentSessionId?: string | null;
  readonly: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  decisionRequests?: DecisionRequestCardData[];
  planCards?: Record<string, PlanCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  optimisticMessages?: UIMessage[];
  followRequestKey?: number;
  isAwaitingResponse?: boolean;
  allowInferredAgentRunId?: boolean;
  stableTranscriptChannel?: boolean;
  className?: string;
  bottomOverlayHeight?: number;
  onOpenPlan?: (planRevisionId: string, title: string) => void;
  onOpenOrchestration?: (plan: OrchestrationPlanView) => void;
  onApproveOrchestration?: (plan: OrchestrationPlanView) => void;
  showReasoning?: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
  workspaceRootPath?: string | null;
}

export function shouldBatchTranscriptEvent(event: TranscriptEvent) {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || event.type.startsWith("tool-");
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
  return explicit;
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
    && (message as { metadata?: { messageKind?: unknown } }).metadata?.messageKind === "running-guide";
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function isDecisionRequestResultMessage(message: UIMessage): boolean {
  const metadata = (message as { metadata?: { decisionRequestId?: unknown; decisionRequestStatus?: unknown } }).metadata;
  return message.role === "user"
    && typeof metadata?.decisionRequestId === "string"
    && (metadata.decisionRequestStatus === "resolved" || metadata.decisionRequestStatus === "cancelled");
}

function timelineInputMessage(message: UIMessage): TimelineInputMessage {
  return message as unknown as TimelineInputMessage;
}

function guideMessageBlock(message: UIMessage, options: { showStatusLabel?: boolean } = {}): TranscriptBlock | null {
  if (isDecisionRequestResultMessage(message)) return null;
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
  anchorId,
  text,
  createdAt,
  browserAttachments = [],
  imageAttachments = [],
  statusLabel = null,
}: {
  anchorId: string;
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
    <div data-testid="chat-message-user" data-transcript-anchor-id={anchorId} className={styles.userRow}>
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
        {text ? (
          <div className={styles.userBubble}>
            <PromptInlineContent value={text} />
          </div>
        ) : null}
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
  decisionRequests: DecisionRequestCardData[] | undefined,
  planCards: Record<string, PlanCardState> | undefined,
  orchestrationPlans: OrchestrationPlanView[] | undefined,
) {
  return useMemo(() => {
    const decisionRequestsById = new Map<string, DecisionRequestCardData>();
    if (decisionRequests) {
      for (const card of decisionRequests) {
        decisionRequestsById.set(card.decision_request_id, card);
      }
    }

    const planCardsById = new Map<string, PlanCardState>();
    if (planCards) {
      for (const [id, card] of Object.entries(planCards)) {
        if (card) planCardsById.set(id, card);
      }
    }

    const plansByRevisionId = new Map((orchestrationPlans ?? []).map((plan) => [plan.revision.orchestration_revision_id, plan]));
    return { decisionRequestsById, planCardsById, plansByRevisionId };
  }, [decisionRequests, orchestrationPlans, planCards]);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function submittedOrchestrationRevisionId(output: unknown): string | null {
  const revision = recordValue(recordValue(parseMcpOutput(output))?.revision);
  const revisionId = revision?.orchestration_revision_id ?? revision?.id;
  return typeof revisionId === "string" && revisionId ? revisionId : null;
}

function submissionToolMatchesPlan(
  tool: Extract<TranscriptBlock, { type: "tool-group" }>["tools"][number],
  plan: OrchestrationPlanView,
) {
  if (!isMcpToolNamed(tool.toolName, "submit_orchestration_plan", tool.mcp?.tool)) return false;
  const revisionId = submittedOrchestrationRevisionId(tool.output);
  return revisionId === plan.revision.orchestration_revision_id;
}

export function hasMatchingPlanToolAnchor(messages: UIMessage[], plan: OrchestrationPlanView) {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    const parts = timelineInputMessage(message).parts;
    return parts.some((part) => {
      if (part.type === "text" || part.type === "reasoning") return false;
      return submissionToolMatchesPlan({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        capability: part.capability,
        providerToolName: part.providerToolName,
        mcp: part.mcp,
        state: "completed",
        input: part.input ?? null,
        output: part.output,
      }, plan);
    });
  });
}

/**
 * Reconcile persisted orchestration state with its canonical transcript tool
 * part. The transcript owns display position; persisted state only completes
 * the tool lifecycle and hydrates a card directly after the matching tool
 * group. A plan without a matching tool anchor is never appended elsewhere.
 */
export function reconcileDurablePlanCard(
  blocks: TranscriptBlock[],
  plans: OrchestrationPlanView[],
) {
  const toolAnchors = blocks.flatMap((block) => block.type === "tool-group"
    ? block.tools
      .filter((tool) => isMcpToolNamed(tool.toolName, "submit_orchestration_plan", tool.mcp?.tool))
      .map((tool) => ({ blockId: block.id, tool }))
    : []);
  const match = plans
    .map((plan) => ({
      plan,
      anchor: [...toolAnchors].reverse().find(({ tool }) => submissionToolMatchesPlan(tool, plan)),
    }))
    .find((candidate) => candidate.anchor);
  if (!match?.anchor) return blocks;

  const matchedPlan = match.plan;
  const matchedAnchor = match.anchor;
  const hasCard = blocks.some((block) => (
    block.type === "orchestration-card"
    && block.orchestrationRevisionId === matchedPlan.revision.orchestration_revision_id
  ));

  return blocks.flatMap((block) => {
    if (block.type !== "tool-group") return block;
    let changed = false;
    const reconciledTools = block.tools.map((tool) => {
      if (tool.state !== "running" || !submissionToolMatchesPlan(tool, matchedPlan)) return tool;
      changed = true;
      return { ...tool, state: "completed" as const };
    });
    const hasRunningTool = changed && reconciledTools.some((tool) => tool.state === "running");
    const reconciledBlock = changed ? {
      ...block,
      tools: reconciledTools,
      finalized: hasRunningTool ? block.finalized : true,
      activeState: hasRunningTool ? block.activeState : undefined,
      currentToolCallId: hasRunningTool ? block.currentToolCallId : null,
    } : block;
    if (block.id !== matchedAnchor.blockId || hasCard) return reconciledBlock;
    return [reconciledBlock, {
      id: `tool-card:${matchedAnchor.tool.toolCallId}:orchestration-plan`,
      type: "orchestration-card" as const,
      orchestrationRevisionId: matchedPlan.revision.orchestration_revision_id,
      toolCallId: matchedAnchor.tool.toolCallId,
    }];
  });
}

function timelinePayload(item: TranscriptTimelineItem): Record<string, unknown> {
  return item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown>
    : {};
}

function compactionLabel(item: TranscriptTimelineItem) {
  const payload = timelinePayload(item);
  return payload.status === "running"
    ? "正在压缩上下文"
    : payload.status === "failed" ? "上下文压缩失败" : "已压缩上下文";
}

function SessionTranscriptContent({
  presentationItems,
  isLoadingHistory,
  emptyTitle,
  emptyDescription,
  decisionRequests,
  planCards,
  orchestrationPlans,
  isAwaitingResponse,
  followRequestKey,
  flowId,
  onOpenPlan,
  onOpenOrchestration,
  onApproveOrchestration,
  activity,
  activityMessageId,
  activeTurnTiming,
  onOpenWorkspaceFile,
  expandedDecisionResultIds,
  showReasoning,
  bottomOverlayHeight,
  workspaceRootPath,
  thinkingLabel,
}: {
  presentationItems: TranscriptPresentationItem[];
  isLoadingHistory: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  decisionRequests?: DecisionRequestCardData[];
  planCards?: Record<string, PlanCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  isAwaitingResponse: boolean;
  followRequestKey?: number;
  flowId: string | null;
  onOpenPlan?: (planRevisionId: string, title: string) => void;
  onOpenOrchestration?: (plan: OrchestrationPlanView) => void;
  onApproveOrchestration?: (plan: OrchestrationPlanView) => void;
  activity?: TranscriptActivity | null;
  activityMessageId?: string | null;
  activeTurnTiming?: TurnTiming | null;
  onOpenWorkspaceFile?: (path: string) => void;
  expandedDecisionResultIds: Set<string>;
  showReasoning: boolean;
  bottomOverlayHeight?: number;
  workspaceRootPath?: string | null;
  thinkingLabel?: string | null;
}) {
  const lastFollowRequestKeyRef = useRef(followRequestKey);
  const followedOrchestrationRevisionIdsRef = useRef(new Set<string>());
  const { follow, followIfAtBottom, registerThread } = useTranscriptScroll();
  const { decisionRequestsById, planCardsById, plansByRevisionId } = useCardMaps(
    decisionRequests,
    planCards,
    orchestrationPlans,
  );

  const visiblePresentationItems = presentationItems.flatMap((item): TranscriptPresentationItem[] => {
    if (item.type === "session-boundary" || item.type === "context-compaction") return [item];
    if (item.type === "user-message") {
      return hasRenderableContent(item.message, showReasoning) ? [item] : [];
    }
    const messages = item.messages.filter((message) =>
      message.id === activityMessageId
      || hasRenderableContent(message, showReasoning)
    );
    return messages.length > 0 ? [{ ...item, messages }] : [];
  });
  const visibleMessages = visiblePresentationItems.flatMap((item) =>
    item.type === "user-message" ? [item.message] : item.type === "assistant-turn" ? item.messages : []
  );
  const renderableOrchestrationRevisionIds = (orchestrationPlans ?? [])
    .filter((plan) => hasMatchingPlanToolAnchor(visibleMessages, plan))
    .map((plan) => plan.revision.orchestration_revision_id);
  const renderableOrchestrationRevisionKey = renderableOrchestrationRevisionIds.join(":");

  const activeAssistantMessage = visibleMessages.find(
    (message) => message.role === "assistant" && message.id === activityMessageId,
  );
  const lastVisibleMessage = visibleMessages.at(-1);
  const missingOrchestrationAnchors = (orchestrationPlans ?? []).filter((plan) => !hasMatchingPlanToolAnchor(visibleMessages, plan));
  const anchoredPlanIds = new Set(visibleMessages.flatMap((message) => message.role === "assistant"
    ? buildTranscriptTimeline({ message: timelineInputMessage(message), activity: "finished" })
      .flatMap((block) => block.type === "plan-card" ? [block.planApprovalId] : [])
    : []));
  const missingPlanAnchors = [...planCardsById.values()].filter((card) => !anchoredPlanIds.has(card.plan_approval_id));
  const showThinkingIndicator =
    isAwaitingResponse && !activeAssistantMessage && lastVisibleMessage?.role !== "assistant";

  useEffect(() => {
    if (followRequestKey === undefined || followRequestKey === lastFollowRequestKeyRef.current) return;
    lastFollowRequestKeyRef.current = followRequestKey;
    follow();
  }, [follow, followRequestKey]);

  useLayoutEffect(() => {
    const newlyRenderableRevisionIds = renderableOrchestrationRevisionKey.split(":").filter(Boolean).filter(
      (revisionId) => !followedOrchestrationRevisionIdsRef.current.has(revisionId),
    );
    if (newlyRenderableRevisionIds.length === 0) return;
    for (const revisionId of newlyRenderableRevisionIds) {
      followedOrchestrationRevisionIdsRef.current.add(revisionId);
    }
    followIfAtBottom();
  }, [followIfAtBottom, renderableOrchestrationRevisionKey]);

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
            {visiblePresentationItems.length === 0 && !isLoadingHistory && !isAwaitingResponse && (
              <ConversationEmptyState
                title={emptyTitle}
                description={emptyDescription}
                icon={<MessageSquareIcon className="size-8" />}
              />
            )}

            {missingOrchestrationAnchors.map((plan) => (
              <button key={`missing-orchestration:${plan.revision.orchestration_revision_id}`} type="button" className={styles.historyBoundary} onClick={() => onOpenOrchestration?.(plan)}>
                编排计划缺少 Transcript 锚点，请在右侧查看
              </button>
            ))}
            {missingPlanAnchors.map((card) => (
              <button key={`missing-plan:${card.plan_approval_id}`} type="button" className={styles.historyBoundary} onClick={() => onOpenPlan?.(card.plan_revision_id, card.title)}>
                计划审批缺少 Transcript 锚点，请在右侧查看
              </button>
            ))}

          {visiblePresentationItems.map((item) => {
            if (item.type === "context-compaction") {
              const payload = timelinePayload(item.item);
              return (
                <div key={item.id} data-testid="transcript-status-divider" className={styles.compactionDivider}>
                  <span
                    className={`${payload.status === "running" ? styles.animatedStatusText : ""} ${styles.compactionDividerText}`}
                    data-text={compactionLabel(item.item)}
                  >
                    {compactionLabel(item.item)}
                  </span>
                </div>
              );
            }
            if (item.type === "session-boundary") {
              const payload = timelinePayload(item.item);
              return (
                <div key={item.id} data-testid="history-session-boundary" className={styles.historyBoundary}>
                  {payload.status === "missing"
                    ? `历史会话不可用：${String(payload.display_name ?? "Expert")}`
                    : `历史会话：${String(payload.display_name ?? "Expert")}`}
                </div>
              );
            }
            if (item.type === "user-message") {
              const msg = item.message;
              if (isRunningGuideMessage(msg)) {
                return (
                  <UserMessage
                    key={item.id}
                    anchorId={msg.id}
                    text={messageText(msg)}
                    createdAt={messageTimestampValue(msg)}
                    browserAttachments={browserAttachmentsFromMessage(msg)}
                    imageAttachments={imageAttachmentsFromMessage(msg)}
                    statusLabel={userGuideStatusLabel(msg) ?? "已引导对话"}
                  />
                );
              }
              const blocks = buildTranscriptTimeline({ message: timelineInputMessage(msg), activity: "finished" });
              const hasDecisionResult = blocks.some((block) => block.type === "decision-request-result");
              if (hasDecisionResult) {
                const projectedBlocks = blocks.map((block) =>
                  block.type === "decision-request-result" && expandedDecisionResultIds.has(block.requestId)
                    ? { ...block, collapseState: "expanded" as const }
                    : block
                );
                return (
                  <TranscriptTimelineRenderer
                    key={item.id}
                    turnId={msg.id}
                    blocks={projectedBlocks}
                    flowId={flowId ?? ""}
                    decisionRequestsById={decisionRequestsById}
                    planCardsById={planCardsById}
                    plansByRevisionId={plansByRevisionId}
                    onPlanOpen={onOpenPlan ?? (() => {})}
                    onOrchestrationOpen={onOpenOrchestration ?? (() => {})}
                    onOrchestrationApprove={onApproveOrchestration ?? (() => {})}
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
                  key={item.id}
                  anchorId={msg.id}
                  text={messageText(msg)}
                  createdAt={messageTimestampValue(msg)}
                  browserAttachments={browserAttachmentsFromMessage(msg)}
                  imageAttachments={imageAttachmentsFromMessage(msg)}
                />
              );
            }
            const targetMessages = item.messages;
            const activeInGroup = targetMessages.some((message) => message.id === activityMessageId);
            const completedTiming = [...targetMessages]
              .reverse()
              .filter((message) => message.role === "assistant")
              .map((message) => readHistoryTurnTiming(message))
              .find((timing): timing is TurnTiming => timing !== null) ?? null;
            const rendererTurnTiming = activeInGroup ? activeTurnTiming ?? completedTiming : completedTiming;
            const blocks = targetMessages.flatMap((message) => {
              const guideBlock = isRunningGuideMessage(message) ? guideMessageBlock(message) : null;
              if (guideBlock) return [guideBlock];
              return buildTranscriptTimeline({
                message: timelineInputMessage(message),
                activity: message.id === activityMessageId ? activity ?? "finished" : "finished",
              });
            });
            const renderedBlocks = reconcileDurablePlanCard(blocks, orchestrationPlans ?? []);
            return (
              <TranscriptTimelineRenderer
                key={item.id}
                turnId={item.presentationTurnId}
                blocks={renderedBlocks}
                flowId={flowId ?? ""}
                decisionRequestsById={decisionRequestsById}
                planCardsById={planCardsById}
                plansByRevisionId={plansByRevisionId}
                onPlanOpen={onOpenPlan ?? (() => {})}
                onOrchestrationOpen={onOpenOrchestration ?? (() => {})}
                onOrchestrationApprove={onApproveOrchestration ?? (() => {})}
                activity={activeInGroup ? activity ?? "waiting" : "finished"}
                turnTiming={rendererTurnTiming}
                showReasoning={showReasoning}
                workspaceRootPath={workspaceRootPath}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                data-testid="chat-message-assistant"
                data-transcript-activity={activeInGroup ? activity ?? undefined : undefined}
                thinkingLabel={activeInGroup ? thinkingLabel ?? undefined : undefined}
              />
            );
          })}

            {showThinkingIndicator && (
              <div data-testid="chat-message-assistant" data-transcript-activity="waiting">
                <div className={styles.assistant}>
                  <ThinkingIndicator label={thinkingLabel ?? undefined} />
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

const EMPTY_OPTIMISTIC_MESSAGES: UIMessage[] = [];

export default function SessionTranscriptPanel({
  flowId,
  agentRunId,
  agentSessionId = null,
  readonly,
  emptyTitle = "暂无消息",
  emptyDescription,
  decisionRequests,
  planCards,
  orchestrationPlans,
  optimisticMessages = EMPTY_OPTIMISTIC_MESSAGES,
  followRequestKey,
  isAwaitingResponse = false,
  allowInferredAgentRunId = false,
  stableTranscriptChannel = false,
  className,
  bottomOverlayHeight,
  onOpenPlan,
  onOpenOrchestration,
  onApproveOrchestration,
  showReasoning: showReasoningOverride,
  onOpenWorkspaceFile,
  workspaceRootPath,
}: SessionTranscriptPanelProps) {
  void readonly;
  const storeShowReasoning = useAppPreferencesStore((state) => state.showReasoning);
  const showReasoning = showReasoningOverride ?? storeShowReasoning;
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, emptyTranscriptState);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
  const [runtimeTransportLabel, setRuntimeTransportLabel] = useState<string | null>(null);
  const prevFlowIdRef = useRef<string | null>(null);
  const prevAgentSessionIdRef = useRef<string | null>(null);
  const prevAgentRunIdRef = useRef<string | null>(null);
  const lastRealAgentRunIdRef = useRef<string | null>(null);
  const fetchedSessionRef = useRef<string | null>(null);
  const pendingHistoryRequestRef = useRef<string | null>(null);
  const eventFrameRef = useRef<number | null>(null);
  const pendingEventsRef = useRef<TranscriptCommittedEvent[]>([]);
  const resyncInFlightRef = useRef<string | null>(null);
  const planRecoveryAttemptsRef = useRef(new Set<string>());
  const activeFlowIdRef = useRef<string | null>(flowId);
  const activeAgentSessionIdRef = useRef<string | null>(agentSessionId);
  const activeAgentRunIdRef = useRef<string | null>(agentRunId);
  const inferredAgentRunIdRef = useRef<string | null>(null);

  activeFlowIdRef.current = flowId;
  activeAgentSessionIdRef.current = agentSessionId;
  activeAgentRunIdRef.current = agentRunId ?? (allowInferredAgentRunId ? inferredAgentRunIdRef.current : null);

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

  const scheduleTranscriptEvent = useCallback((item: TranscriptCommittedEvent) => {
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

  const requestTranscriptResync = useCallback(() => {
    if (!flowId) return;
    const requestKey = `${flowId}:${agentSessionId ?? "leader"}:${agentRunId ?? "latest"}`;
    if (resyncInFlightRef.current === requestKey) return;
    resyncInFlightRef.current = requestKey;
    wsClient.sendSessionGet(flowId, "", agentRunId ?? undefined, agentSessionId ?? undefined);
  }, [agentRunId, agentSessionId, flowId]);

  useEffect(() => {
    const prevFlowId = prevFlowIdRef.current;
    const prevAgentSessionId = prevAgentSessionIdRef.current;
    const prevSessionId = prevAgentRunIdRef.current;

    if (flowId !== prevFlowId || agentSessionId !== prevAgentSessionId) {
      prevFlowIdRef.current = flowId;
      prevAgentSessionIdRef.current = agentSessionId;
      prevAgentRunIdRef.current = agentRunId;
      // Only overwrite the "last real" tracker with a genuine session id.
      // agentRunId is transiently null right after switching flows
      // (useDashboardData resets it before a fresh flow:state repopulates
      // it); blindly overwriting here erases the previous real value, so
      // the mismatch check below (guarding whether a resync is needed once
      // the real id arrives) silently no-ops instead of detecting a change.
      if (agentRunId !== null) {
        lastRealAgentRunIdRef.current = agentRunId;
      }
      inferredAgentRunIdRef.current = agentRunId;
      fetchedSessionRef.current = null;
      pendingHistoryRequestRef.current = null;
      resyncInFlightRef.current = null;
      planRecoveryAttemptsRef.current.clear();
      cancelPendingEventFlush();
      setRuntimeTransportLabel(null);
      dispatchTranscript({ type: "reset" });
    } else if (agentRunId !== prevSessionId) {
      prevAgentRunIdRef.current = agentRunId;
      if (agentRunId !== null) {
        inferredAgentRunIdRef.current = agentRunId;
      }
      const lastRealAgentRunId = lastRealAgentRunIdRef.current;
      if (
        !stableTranscriptChannel
        && agentRunId !== null
        && lastRealAgentRunId !== null
        && lastRealAgentRunId !== agentRunId
      ) {
        fetchedSessionRef.current = null;
        cancelPendingEventFlush();
        setRuntimeTransportLabel(null);
        dispatchTranscript({ type: "reset" });
      }
      if (agentRunId !== null) {
        lastRealAgentRunIdRef.current = agentRunId;
      }
    }

    if (!flowId || (!agentRunId && !agentSessionId)) {
      fetchedSessionRef.current = null;
      pendingHistoryRequestRef.current = null;
      setIsLoadingHistory(false);
      return;
    }

    const fetchKey = agentSessionId
      ? `${flowId}:fexp:${agentSessionId}`
      : stableTranscriptChannel
        ? `${flowId}:leader-channel`
        : `${flowId}:ags:${agentRunId}`;
    if (fetchKey === fetchedSessionRef.current) return;
    fetchedSessionRef.current = fetchKey;
    pendingHistoryRequestRef.current = fetchKey;

    setIsLoadingHistory(true);
    if (agentSessionId) {
      wsClient.sendSessionGet(flowId, "", agentRunId ?? undefined, agentSessionId);
    } else {
      wsClient.sendSessionGet(flowId, "", agentRunId ?? undefined);
    }
  }, [flowId, agentSessionId, agentRunId, stableTranscriptChannel, cancelPendingEventFlush]);

  useEffect(() => {
    dispatchTranscript({ type: "sync-optimistic", messages: optimisticMessages });
  }, [optimisticMessages]);

  useEffect(() => {
    if (!flowId) return;

    const unsubscribe = wsClient.onMessage((msg: WsInMessage) => {
      const activeFlowId = activeFlowIdRef.current;
      const activeAgentSessionId = activeAgentSessionIdRef.current;
      const activeAgentRunId = activeAgentRunIdRef.current;
      if (msg.flow_id !== activeFlowId) return;

      if (msg.type === "runtime:transport") {
        if (activeAgentSessionId) {
          if (msg.agent_session_id !== activeAgentSessionId) return;
        } else {
          if (msg.agent_session_id) return;
          if (activeAgentRunId && msg.agent_run_id !== activeAgentRunId) return;
        }
        setRuntimeTransportLabel(msg.data.state === "clear" ? null : msg.data.message ?? "Codex 网络连接正在恢复");
        return;
      }

      if (msg.type === "context_compaction:event" && !activeAgentSessionId) {
        const timelineItem = msg.data?.timeline_item as TranscriptTimelineItem | undefined;
        if (timelineItem?.type === "context_compaction") {
          dispatchTranscript({ type: "upsert-timeline-item", item: timelineItem });
        }
        return;
      }

      if (activeAgentSessionId) {
        if (extractMessageAgentSessionId(msg) !== activeAgentSessionId) return;
      } else {
        const msgAgentRunId = extractMessageAgentRunId(msg);
        const messageUsesStableLeaderChannel = stableTranscriptChannel
          && "session_id" in msg
          && msg.session_id === `leader:${activeFlowId}`;
        if (!messageUsesStableLeaderChannel && msgAgentRunId !== activeAgentRunId) {
          if (allowInferredAgentRunId && activeAgentRunId === null && msgAgentRunId) {
            inferredAgentRunIdRef.current = msgAgentRunId;
            activeAgentRunIdRef.current = msgAgentRunId;
          } else {
            return;
          }
        }
      }

      if (msg.type === "agent_run:event" && String(msg.data?.status ?? "") === "interrupted") {
        setRuntimeTransportLabel(null);
        flushPendingEvents();
        dispatchTranscript({ type: "finish-active", finishedAt: new Date().toISOString() });
        return;
      }

      if (msg.type === "agent_session:event" && activeAgentSessionId) {
        const expertStatus = String(msg.data?.status ?? "");
        if (["completed", "failed"].includes(expertStatus)) {
          setRuntimeTransportLabel(null);
        }
        return;
      }

      if (msg.type === "session:transcript_snapshot") {
        resyncInFlightRef.current = null;
        setIsLoadingHistory(false);
        if (pendingHistoryRequestRef.current) {
          pendingHistoryRequestRef.current = null;
          setHistoryLoadVersion((version) => version + 1);
        }
        flushPendingEvents();
        dispatchTranscript({
          type: "load-snapshot",
          streamEpoch: msg.data.stream_epoch,
          cursor: msg.data.cursor,
          timelineItems: msg.data.timeline_items,
          activeTurn: msg.data.active_turn,
        });
        return;
      }

      if (msg.type === "session:transcript_event") {
        setIsLoadingHistory(false);
        if (pendingHistoryRequestRef.current) {
          pendingHistoryRequestRef.current = null;
          setHistoryLoadVersion((version) => version + 1);
        }
        const event = msg.data.event as TranscriptEvent;
        scheduleTranscriptEvent({
          streamEpoch: msg.data.stream_epoch,
          cursor: msg.data.cursor,
          timelineItems: msg.data.timeline_items,
          event,
          ...(msg.data.removed_message_ids?.length ? { removedMessageIds: msg.data.removed_message_ids } : {}),
          ...(msg.data.active_turn ? { activeTurn: msg.data.active_turn } : {}),
        });
      }
    });

    return unsubscribe;
  }, [flowId, agentSessionId, agentRunId, allowInferredAgentRunId, stableTranscriptChannel, flushPendingEvents, scheduleTranscriptEvent]);

  useEffect(() => {
    if (!transcript.needsResync || !flowId) return;
    dispatchTranscript({ type: "resync-requested" });
    requestTranscriptResync();
  }, [flowId, requestTranscriptResync, transcript.needsResync]);

  const pendingPlanForRecovery = useMemo(() => [...(orchestrationPlans ?? [])]
    .reverse()
    .find((plan) => plan.approval?.status === "pending" || plan.revision.status === "pending_approval") ?? null,
  [orchestrationPlans]);
  const pendingPlanHasAnchor = useMemo(() => pendingPlanForRecovery
    ? hasMatchingPlanToolAnchor(transcript.messages, pendingPlanForRecovery)
    : false,
  [pendingPlanForRecovery, transcript.messages]);

  useEffect(() => {
    if (
      !flowId
      || agentSessionId
      || isAwaitingResponse
      || isLoadingHistory
      || transcript.streamEpoch === null
      || transcript.cursor === null
      || transcript.messages.length === 0
      || !pendingPlanForRecovery
      || pendingPlanHasAnchor
    ) return;
    const recoveryKey = `${flowId}:${pendingPlanForRecovery.revision.orchestration_revision_id}:${transcript.streamEpoch}`;
    if (planRecoveryAttemptsRef.current.has(recoveryKey)) return;
    planRecoveryAttemptsRef.current.add(recoveryKey);
    requestTranscriptResync();
  }, [
    agentSessionId,
    flowId,
    isAwaitingResponse,
    isLoadingHistory,
    pendingPlanForRecovery,
    pendingPlanHasAnchor,
    requestTranscriptResync,
    transcript.cursor,
    transcript.messages.length,
    transcript.streamEpoch,
  ]);

  useEffect(() => {
    return () => {
      cancelPendingEventFlush();
    };
  }, [cancelPendingEventFlush]);

  const presentationItems = useMemo(
    () => projectTranscriptPresentationItems(transcript.timelineItems),
    [transcript.timelineItems],
  );

  return (
    <StickToBottom
      className={`relative h-full overflow-y-hidden ${className || ""}`}
      resize="instant"
      initial="instant"
    >
      <TranscriptScrollProvider
        flowId={flowId}
        isLoadingHistory={isLoadingHistory}
        historyLoadVersion={historyLoadVersion}
      >
        <SessionTranscriptContent
        presentationItems={presentationItems}
        isLoadingHistory={isLoadingHistory}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        decisionRequests={decisionRequests}
        planCards={planCards}
        orchestrationPlans={orchestrationPlans}
        followRequestKey={followRequestKey}
        isAwaitingResponse={isAwaitingResponse}
        flowId={flowId}
        onOpenPlan={onOpenPlan}
        onOpenOrchestration={onOpenOrchestration}
        onApproveOrchestration={onApproveOrchestration}
        activity={transcript.activeTurn?.activity ?? null}
        activityMessageId={transcript.activeTurn?.renderMessageId ?? null}
        activeTurnTiming={transcript.activeTurn?.timing ?? null}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        expandedDecisionResultIds={transcript.expandedDecisionResultIds}
        showReasoning={showReasoning}
        bottomOverlayHeight={bottomOverlayHeight}
        workspaceRootPath={workspaceRootPath}
        thinkingLabel={runtimeTransportLabel}
      />
      </TranscriptScrollProvider>
    </StickToBottom>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UIMessage } from "ai";
import { PromptInput } from "@/components/ai-elements-official/prompt-input";
import {
  API_BASE,
  compactFlowContext,
  fetchFlowContextState,
  type AgentContextCompactionDto,
  type AgentContextUsageDto,
} from "../../lib/api";
import { wsClient } from "../../lib/ws";
import type { WsInMessage } from "../../lib/ws";
import type { DecisionCardData } from "../../hooks/useDashboardData";
import type { SpecCardState } from "../../hooks/useDashboardData";
import type { UserTurnReview } from "../../hooks/useFlowWorkbench";
import { getDesktopBrowserBridge } from "../../lib/desktopBrowser";
import ComposerModeMenu, { type PlanApproval, type RiskMode } from "../ComposerModeMenu";
import PendingDecisionDock from "./PendingDecisionDock";
import SessionTranscriptPanel from "./SessionTranscriptPanel";
import type { UserTurnDisplay } from "./SessionTranscriptPanel";
import LeaderModelSelector from "../LeaderModelSelector";
import BrowserElementAttachments from "../BrowserElementAttachments";
import MessageImageAttachments from "../MessageImageAttachments";
import PlanFeedbackAttachments from "../orchestration/PlanFeedbackAttachments";
import RunningMessageQueue from "./RunningMessageQueue";
import {
  EMPTY_RUNNING_QUEUE,
  useRunningMessageQueueStore,
  type RunningQueuedMessage,
} from "../../stores/useRunningMessageQueueStore";
import {
  browserElementsToOutgoingAttachments,
  useBrowserSelectionStore,
  type BrowserElementAttachment,
} from "../../stores/useBrowserSelectionStore";
import { useComposerImageStore } from "../../stores/useComposerImageStore";
import {
  imageAttachmentFromFile,
  outgoingImageAttachment,
  type MessageImageAttachment,
  type OutgoingMessageImageAttachment,
} from "../../types/messageAttachments";
import { usePlanFeedbackStore } from "../../stores/usePlanFeedbackStore";
import type { OrchestrationPlanView, PlanFeedbackDraft } from "../../types/orchestration";

export interface LeaderChatPanelProps {
  flowId: string | null;
  leaderAgentSessionId: string | null;
  initialOptimisticMessages?: UIMessage[];
  flowStatus?: string;
  decisionCardStatuses: Record<string, "pending" | "resolved" | "cancelled">;
  decisionCardAnswers: Record<string, Record<string, string | string[]>>;
  decisionCards: DecisionCardData[];
  specCards: Record<string, SpecCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  riskMode?: RiskMode;
  planApproval?: PlanApproval;
  userTurns?: UserTurnDisplay[];
  onOpenSpecPreview?: (specRevisionId: string, title: string) => void;
  onOpenPlan?: (plan: OrchestrationPlanView) => void;
  review?: UserTurnReview | null;
  onOpenReview?: () => void;
  onOpenWorkspaceFile?: (path: string) => void;
  composerOnly?: boolean;
  composerVariant?: "default" | "compactFloating";
  composerValue?: string;
  onComposerValueChange?: (value: string) => void;
  workspaceRootPath?: string | null;
  onOpenModelSettings?: () => void;
}

type UserTurnWire = {
  id?: string;
  user_turn_id?: string;
  trigger_message_id?: string;
  status?: string;
  started_at?: string | null;
  active_started_at?: string | null;
  active_duration_ms?: number | null;
  completed_at?: string | null;
  work_root_path?: string | null;
};

type PendingGuideMessage = {
  clientMessageId: string;
  displayText: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  planFeedback?: PlanFeedbackDraft[];
};

type LeaderMessageOptions = {
  specRequested?: boolean;
  displayText?: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  outgoingAttachments?: OutgoingMessageImageAttachment[];
  planFeedback?: PlanFeedbackDraft[];
  reuseActiveUserTurn?: boolean;
};

function outgoingAttachmentsForMessage(options: Pick<
  LeaderMessageOptions,
  "browserElementAttachments" | "imageAttachments" | "outgoingAttachments"
>): OutgoingMessageImageAttachment[] {
  if (options.outgoingAttachments !== undefined) return options.outgoingAttachments;
  return [
    ...(options.imageAttachments ?? []).flatMap((attachment) => {
      const outgoing = outgoingImageAttachment(attachment);
      return outgoing ? [outgoing] : [];
    }),
    ...browserElementsToOutgoingAttachments(options.browserElementAttachments ?? []),
  ];
}

function runningGuideUiMessage(
  clientMessageId: string,
  displayText: string,
  options: Pick<PendingGuideMessage, "browserElementAttachments" | "imageAttachments">,
): UIMessage {
  return {
    id: clientMessageId,
    role: "user",
    parts: [{ type: "text", text: displayText }],
    content: displayText,
    createdAt: new Date().toISOString(),
    metadata: {
      localMessageKind: "running-guide",
      guideStatusLabel: "已引导对话",
      ...(options.browserElementAttachments?.length
        ? { browserElementAttachments: options.browserElementAttachments }
        : {}),
      ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
    },
  } as UIMessage;
}

function normalizeBrowserUrl(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function restoreBrowserAnnotationsForEditing(elements: BrowserElementAttachment[]) {
  const bridge = getDesktopBrowserBridge();
  if (!bridge || elements.length === 0) return;
  const renumberedElements = elements.map((element, index) => ({ ...element, markerNumber: index + 1 }));
  const state = bridge.getState ? await bridge.getState().catch(() => null) : null;
  const currentUrl = state?.url ? normalizeBrowserUrl(state.url) : null;
  const visibleElements = currentUrl
    ? renumberedElements.filter((element) => normalizeBrowserUrl(element.url) === currentUrl)
    : renumberedElements;
  if (bridge.setConfirmedMarkers) {
    await bridge.setConfirmedMarkers(visibleElements.map((element) => ({
      markerNumber: element.markerNumber,
      selector: element.selector,
      rect: element.rect,
    }))).catch(() => null);
  }
  await bridge.startElementPicker(renumberedElements.length + 1).catch(() => null);
}

function normalizeUserTurn(value: unknown): UserTurnDisplay | null {
  if (!value || typeof value !== "object") return null;
  const turn = value as UserTurnWire;
  const id = turn.user_turn_id ?? turn.id;
  if (!id || !turn.trigger_message_id) return null;
  return {
    id,
    triggerMessageId: turn.trigger_message_id,
    status: turn.status ?? "active",
    startedAt: turn.started_at ?? null,
    activeStartedAt: turn.active_started_at ?? null,
    activeDurationMs: typeof turn.active_duration_ms === "number" ? turn.active_duration_ms : 0,
    completedAt: turn.completed_at ?? null,
    workRootPath: turn.work_root_path?.trim() || undefined,
  };
}

function mergeUserTurn(prev: UserTurnDisplay[], incoming: UserTurnDisplay): UserTurnDisplay[] {
  const existing = prev.find((turn) =>
    turn.id === incoming.id || turn.triggerMessageId === incoming.triggerMessageId
  );
  const next = prev.filter((turn) =>
    turn.id !== incoming.id && turn.triggerMessageId !== incoming.triggerMessageId
  );
  next.push({
    ...incoming,
    workRootPath: incoming.workRootPath ?? existing?.workRootPath ?? null,
  });
  return next.sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
}

function clampPercentage(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function formatTokenCount(tokens: number | null | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "未知";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
  return String(tokens);
}

function formatCategoryPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(1)}%`;
}

function formatCacheHitRate(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(1)}%`;
}

function contextUsageLabel(usage: AgentContextUsageDto | null): string {
  if (!usage) return "上下文使用量暂不可用";
  const percent = displayPercentage(usage);
  if (percent !== null && usage.max_tokens !== null) {
    return `上下文已用 ${percent}%，${formatTokenCount(usage.total_tokens)} / ${formatTokenCount(usage.max_tokens)} token`;
  }
  return `上下文已用 ${formatTokenCount(usage.total_tokens)} token`;
}

function displayPercentage(usage: AgentContextUsageDto | null): number | null {
  if (!usage) return null;
  const percent = clampPercentage(usage.percentage);
  if (percent === null) return null;
  if (percent > 0 && percent < 1) return 1;
  if (percent === 0 && typeof usage.total_tokens === "number" && usage.total_tokens > 0) return 1;
  return Math.round(percent);
}

function contextCategoryLabel(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[_-]+/gu, " ");
  if (normalized.includes("system") && normalized.includes("tool")) return "系统工具";
  if (normalized.includes("message")) return "消息";
  if (normalized.includes("system") && normalized.includes("prompt")) return "系统提示词";
  if (normalized.includes("skill")) return "技能";
  if (normalized.includes("memory")) return "记忆";
  if (normalized.includes("tool")) return "工具";
  if (normalized.includes("other")) return "其他";
  return name || "其他";
}

function contextUsageCategoryRows(usage: AgentContextUsageDto | null) {
  if (!usage?.categories?.length) return [];
  const totalTokens = usage.categories.reduce((sum, category) => sum + Math.max(0, category.tokens || 0), 0);
  if (totalTokens <= 0) return [];
  return usage.categories
    .filter((category) => category.tokens > 0)
    .map((category, index) => ({
      label: contextCategoryLabel(category.name),
      percent: (category.tokens / totalTokens) * 100,
      color: category.color || `color-mix(in srgb, var(--foreground) ${Math.max(28, 72 - index * 10)}%, var(--ui-surface-raised))`,
    }));
}

function isLeaderCompaction(
  value: AgentContextCompactionDto | null | undefined,
  leaderAgentSessionId: string | null,
) {
  if (!value) return false;
  if (leaderAgentSessionId && value.agent_session_id === leaderAgentSessionId) return true;
  return value.role === "leader" || value.expert_id === "exp-leader";
}

function ContextUsageIndicator({
  usage,
  canCompact,
  isCompacting,
  onCompact,
}: {
  usage: AgentContextUsageDto | null;
  canCompact: boolean;
  isCompacting: boolean;
  onCompact: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null);
  const percent = clampPercentage(usage?.percentage);
  const displayPercentLabel = displayPercentage(usage);
  const displayPercent = displayPercentLabel ?? 0;
  const ringColor = percent === null
    ? "color-mix(in srgb, var(--muted-foreground) 70%, transparent)"
    : "color-mix(in srgb, var(--foreground) 58%, var(--ui-surface-raised))";
  const detail = usage?.max_tokens !== null && usage?.max_tokens !== undefined
    ? `${formatTokenCount(usage.total_tokens)}/${formatTokenCount(usage.max_tokens)}`
    : usage
      ? formatTokenCount(usage.total_tokens)
      : "运行后会显示上下文使用量";
  const categoryRows = contextUsageCategoryRows(usage);
  const cacheHitRate = formatCacheHitRate(usage?.cache_hit_rate);
  const hasCacheTelemetry = usage?.cache_input_tokens !== null && usage?.cache_input_tokens !== undefined;
  const configuredContextWindow = usage?.raw_max_tokens !== null
    && usage?.raw_max_tokens !== undefined
    && usage?.max_tokens !== null
    && usage?.max_tokens !== undefined
    && usage.raw_max_tokens !== usage.max_tokens
    ? usage.raw_max_tokens
    : null;
  const openPopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (!usage) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopoverPosition({
      left: rect.right - 296,
      top: rect.top - 8,
    });
  }, [usage]);
  const closePopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setPopoverPosition(null), 80);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <div
      ref={anchorRef}
      className="group relative flex size-8 shrink-0 items-center justify-center"
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
      onFocus={openPopover}
      onBlur={closePopover}
    >
      <span
        role="img"
        aria-label={contextUsageLabel(usage)}
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors group-hover:bg-ui-control-hover"
      >
        <span
          className="relative block size-[18px] rounded-full"
          style={{
            background: `conic-gradient(${ringColor} ${displayPercent * 3.6}deg, color-mix(in srgb, var(--muted-foreground) 26%, transparent) 0deg)`,
          }}
        >
          <span className="absolute inset-[4px] rounded-full bg-[color-mix(in_srgb,var(--ui-surface-raised)_88%,var(--background))]" />
        </span>
      </span>
      {usage && popoverPosition && typeof document !== "undefined" ? createPortal(
        <div
          className="fixed z-[10000] w-[296px] max-w-[calc(100vw-32px)] text-left text-xs"
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
            transform: "translateY(-100%)",
          }}
          onMouseEnter={openPopover}
          onMouseLeave={closePopover}
        >
          <div className="rounded-xl border border-ui-border-strong bg-[var(--ui-surface-raised)] p-3.5 shadow-[var(--ui-shadow-elevated)]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] font-semibold leading-none text-foreground">上下文用量</span>
              <span className="font-mono text-[13px] font-semibold leading-none text-muted-foreground">
                {detail} {displayPercentLabel !== null ? `(${displayPercentLabel}%)` : ""}
              </span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-[color-mix(in_srgb,var(--muted-foreground)_14%,transparent)]">
              <div
                className="relative h-2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_45%,var(--ui-surface-raised))]"
                style={{ width: `${Math.max(1, Math.min(100, displayPercent))}%` }}
              >
                <span className="absolute right-0 top-1/2 size-2.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_50%,var(--ui-surface-raised))] shadow-[0_0_0_2px_color-mix(in_srgb,var(--ui-surface-raised)_95%,transparent)]" />
              </div>
            </div>

            {configuredContextWindow !== null ? (
              <div className="mt-2 text-[12px] text-muted-foreground">
                配置上限 {formatTokenCount(configuredContextWindow)}，Codex 预留 5% 后当前可用 {formatTokenCount(usage.max_tokens)}
              </div>
            ) : null}

            {categoryRows.length > 0 ? (
              <div className="mt-4 space-y-2.5">
                {categoryRows.map((row) => (
                  <div key={row.label} className="flex items-center gap-2.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: row.color }}
                    />
                    <span className="min-w-0 flex-1 text-[13px] font-medium text-muted-foreground">{row.label}</span>
                    <span className="font-mono text-[13px] font-semibold text-foreground">{formatCategoryPercent(row.percent)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {hasCacheTelemetry ? (
              <div className="mt-4 border-t border-ui-border pt-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-muted-foreground">平均缓存命中率</span>
                  <span className="font-mono text-[13px] font-semibold text-foreground">
                    {cacheHitRate ?? "数据未知"}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="mt-3">
              <button
                type="button"
                aria-label="压缩当前会话"
                disabled={!canCompact || isCompacting}
                onClick={(event) => {
                  event.preventDefault();
                  onCompact();
                }}
                className="flex h-6 w-full items-center justify-center rounded bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] px-3 text-[12px] font-semibold text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_14%,transparent)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {isCompacting ? "正在压缩当前会话" : "压缩当前会话"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default function LeaderChatPanel({
  flowId,
  leaderAgentSessionId,
  initialOptimisticMessages = [],
  flowStatus,
  decisionCardStatuses,
  decisionCardAnswers,
  decisionCards,
  specCards,
  orchestrationPlans = [],
  riskMode: initialRiskMode = "auto_edit",
  planApproval: initialPlanApproval = "on",
  userTurns: dashboardUserTurns = [],
  onOpenSpecPreview,
  onOpenPlan = () => {},
  review,
  onOpenReview,
  onOpenWorkspaceFile,
  composerOnly = false,
  composerVariant = "default",
  composerValue,
  onComposerValueChange,
  workspaceRootPath,
  onOpenModelSettings,
}: LeaderChatPanelProps) {
  const [status, setStatus] = useState<"idle" | "submitted" | "streaming" | "ready">("idle");
  // The project directory is fixed when the task is created.
  const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>([]);
  const [userTurns, setUserTurns] = useState<UserTurnDisplay[]>([]);
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [specRequested, setSpecRequested] = useState(false);
  const [riskMode, setRiskMode] = useState<RiskMode>(initialRiskMode);
  const [planApproval, setPlanApproval] = useState<PlanApproval>(initialPlanApproval);
  const [settingsUpdating, setSettingsUpdating] = useState(false);
  const [contextUsage, setContextUsage] = useState<AgentContextUsageDto | null>(null);
  const [contextCompaction, setContextCompaction] = useState<AgentContextCompactionDto | null>(null);
  const [isCompactingContext, setIsCompactingContext] = useState(false);
  const [guidedMessages, setGuidedMessages] = useState<UIMessage[]>([]);
  const [localComposerValue, setLocalComposerValue] = useState("");
  const [flowStateConfirmed, setFlowStateConfirmed] = useState(false);
  const [leaderModelConfigured, setLeaderModelConfigured] = useState(false);
  const [runtimeSelectionUpdating, setRuntimeSelectionUpdating] = useState(false);
  const browserElementAttachments = useBrowserSelectionStore((state) => state.elements);
  const clearBrowserElementAttachments = useBrowserSelectionStore((state) => state.clearElements);
  const setBrowserElementAttachments = useBrowserSelectionStore((state) => state.setElements);
  const imageAttachments = useComposerImageStore((state) => state.images);
  const addImageAttachments = useComposerImageStore((state) => state.addImages);
  const clearImageAttachments = useComposerImageStore((state) => state.clearImages);
  const planFeedback = usePlanFeedbackStore((state) => state.drafts);
  const clearPlanFeedback = usePlanFeedbackStore((state) => state.clearDrafts);
  const setPlanFeedback = usePlanFeedbackStore((state) => state.setDrafts);
  const restoredQueueNeedsFlowStateRef = useRef(false);
  const restoredQueueObservedWaitingRef = useRef(false);
  const pendingGuidesRef = useRef(new Map<string, PendingGuideMessage>());
  const settingsMutationRef = useRef({ flowId, requestId: 0, pending: false });
  if (settingsMutationRef.current.flowId !== flowId) {
    settingsMutationRef.current = {
      flowId,
      requestId: settingsMutationRef.current.requestId + 1,
      pending: false,
    };
  }
  const queuedMessages = useRunningMessageQueueStore((state) =>
    flowId ? state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE : EMPTY_RUNNING_QUEUE
  );
  const hydrateFlowQueue = useRunningMessageQueueStore((state) => state.hydrateFlowQueue);
  const hydrateKnownRunningFlow = useRunningMessageQueueStore((state) => state.hydrateKnownRunningFlow);
  const knownRunningFlow = useRunningMessageQueueStore((state) =>
    flowId ? Boolean(state.knownRunningByFlow[flowId]) : false
  );
  const setKnownRunningFlow = useRunningMessageQueueStore((state) => state.setKnownRunningFlow);
  const updateFlowQueue = useRunningMessageQueueStore((state) => state.updateFlowQueue);

  const updateQueuedMessages = useCallback((updater: (messages: RunningQueuedMessage[]) => RunningQueuedMessage[]) => {
    if (!flowId) return;
    updateFlowQueue(flowId, updater);
  }, [flowId, updateFlowQueue]);

  useEffect(() => {
    setOptimisticMessages([]);
    setGuidedMessages([]);
    setLocalComposerValue("");
    setUserTurns([]);
    setStatus("idle");
    setIsCompactingContext(false);
    setContextUsage(null);
    setContextCompaction(null);
    setFlowStateConfirmed(false);
    setSettingsUpdating(false);
    setRuntimeSelectionUpdating(false);
    setSpecRequested(false);
    const restoredMessages = flowId ? hydrateFlowQueue(flowId) : EMPTY_RUNNING_QUEUE;
    const restoredKnownRunning = flowId ? hydrateKnownRunningFlow(flowId) : false;
    restoredQueueNeedsFlowStateRef.current = restoredMessages.length > 0 || restoredKnownRunning;
    restoredQueueObservedWaitingRef.current = false;
    pendingGuidesRef.current.clear();
  }, [flowId, hydrateFlowQueue, hydrateKnownRunningFlow]);

  useEffect(() => {
    if (dashboardUserTurns.length > 0) {
      setFlowStateConfirmed(true);
    }
  }, [dashboardUserTurns.length]);

  useEffect(() => {
    setRiskMode(initialRiskMode);
  }, [flowId, initialRiskMode]);

  useEffect(() => {
    setPlanApproval(initialPlanApproval);
  }, [flowId, initialPlanApproval]);

  useEffect(() => {
    if (!flowId) return;

    const unsubscribe = wsClient.onMessage((msg: WsInMessage) => {
      if (msg.type === "system:error") {
        if (msg.flow_id && msg.flow_id !== flowId) return;
        if (msg.log_id) {
          const pendingGuide = pendingGuidesRef.current.get(msg.log_id);
          if (pendingGuide) {
            pendingGuidesRef.current.delete(msg.log_id);
            setGuidedMessages((messages) => messages.filter((message) => message.id !== pendingGuide.clientMessageId));
          }
        }
        setStatus((currentStatus) =>
          currentStatus === "submitted" || currentStatus === "streaming" ? "ready" : currentStatus,
        );
        return;
      }

      if (msg.type === "flow:guide_ack") {
        if (msg.flow_id !== flowId) return;
        const logId = msg.log_id;
        if (!logId) return;
        const pendingGuide = pendingGuidesRef.current.get(logId);
        if (!pendingGuide) return;
        pendingGuidesRef.current.delete(logId);
        setFollowRequestKey((value) => value + 1);
        return;
      }

      if (msg.type === "flow:state") {
        if (msg.flow_id !== flowId) return;
        setFlowStateConfirmed(true);
        const rawTurns: unknown[] = Array.isArray(msg.data?.user_turns) ? msg.data.user_turns : [];
        const turns = rawTurns.length > 0
          ? rawTurns.map((turn) => normalizeUserTurn(turn)).filter((turn): turn is UserTurnDisplay => turn !== null)
          : [];
        setUserTurns(turns);
        setKnownRunningFlow(flowId, turns.some((turn) => turn.status === "active"));
        return;
      }

      if (msg.type === "user_turn:event") {
        if (msg.flow_id !== flowId) return;
        setFlowStateConfirmed(true);
        const turn = normalizeUserTurn(msg.data);
        if (turn) {
          setKnownRunningFlow(flowId, turn.status === "active");
          setUserTurns((prev) => mergeUserTurn(prev, turn));
        }
        return;
      }

      if (msg.type === "context_usage:event") {
        if (msg.flow_id !== flowId) return;
        const usage = msg.data as AgentContextUsageDto | null;
        if (usage && (usage.role === "leader" || usage.expert_id === "exp-leader")) {
          setContextUsage(usage);
        }
        return;
      }

      if (msg.type === "context_compaction:event") {
        if (msg.flow_id !== flowId) return;
        const compaction = msg.data as AgentContextCompactionDto | null;
        if (!isLeaderCompaction(compaction, leaderAgentSessionId)) return;
        if (compaction?.status === "running") {
          setContextCompaction(compaction);
          setIsCompactingContext(true);
          setFollowRequestKey((value) => value + 1);
        } else if (compaction?.status === "completed") {
          setContextCompaction(compaction);
          setIsCompactingContext(false);
          setFollowRequestKey((value) => value + 1);
        } else {
          setContextCompaction(null);
          setIsCompactingContext(false);
        }
        return;
      }

      const msgAgentSessionId =
        "agent_session_id" in msg ? msg.agent_session_id : "flow_expert_id" in msg ? msg.flow_expert_id : undefined;
      if (msgAgentSessionId !== leaderAgentSessionId) return;

      if (msg.type === "session:transcript_event") {
        const event = msg.data?.event as { type?: string } | undefined;
        const eventType = event?.type;
        if (eventType === "turn-started") {
          setStatus("streaming");
        } else if (eventType === "turn-finished") {
          setStatus("ready");
        }
      } else if (msg.type === "session:transcript_snapshot") {
        setStatus((currentStatus) =>
          currentStatus === "submitted" || currentStatus === "streaming" ? currentStatus : "ready",
        );
      }
    });

    return unsubscribe;
  }, [flowId, leaderAgentSessionId, setKnownRunningFlow]);

  const transcriptOptimisticMessages = useMemo(
    () => [...initialOptimisticMessages, ...optimisticMessages, ...guidedMessages],
    [guidedMessages, initialOptimisticMessages, optimisticMessages],
  );
  const mergedUserTurns = useMemo(
    () => userTurns.reduce((merged, turn) => mergeUserTurn(merged, turn), dashboardUserTurns),
    [dashboardUserTurns, userTurns],
  );
  const isAuthoritativelyIdle = flowStateConfirmed && flowStatus === "idle" && !knownRunningFlow;
  const isStreaming = status === "streaming" && !isAuthoritativelyIdle;
  const activeUserTurn = isAuthoritativelyIdle
    ? null
    : mergedUserTurns.find((turn) => turn.status === "active" || turn.status === "waiting_user") ?? null;
  const canStopCurrentTurn = activeUserTurn?.status === "active";
  const isWaiting = activeUserTurn?.status === "active" || status === "submitted" || isStreaming;
  const isFlowStatePendingForKnownRunningFlow = Boolean(flowId && knownRunningFlow && !flowStateConfirmed);
  const shouldQueueNewMessage =
    isWaiting
    || queuedMessages.length > 0
    || isFlowStatePendingForKnownRunningFlow
    || (restoredQueueNeedsFlowStateRef.current && !flowStateConfirmed);
  const pendingDecisionCards = decisionCards.filter((card) => decisionCardStatuses[card.card_id] === "pending" || card.status === "pending");
  const hasPendingDecisionCards = pendingDecisionCards.length > 0;
  const compactionDividerLabel = contextCompaction?.status === "running"
    ? "正在压缩当前会话"
    : contextCompaction?.status === "completed"
      ? "已压缩当前会话"
      : null;

  useEffect(() => {
    if (!flowId || !isWaiting) return;
    setKnownRunningFlow(flowId, true);
  }, [flowId, isWaiting, setKnownRunningFlow]);

  useEffect(() => {
    if (!flowId || !flowStateConfirmed || flowStatus !== "idle") return;
    setKnownRunningFlow(flowId, false);
    setStatus("ready");
  }, [flowId, flowStateConfirmed, flowStatus, setKnownRunningFlow]);

  useEffect(() => {
    let cancelled = false;

    async function refreshContextUsage() {
      if (!flowId || !leaderAgentSessionId) {
        setContextUsage(null);
        setContextCompaction(null);
        return;
      }
      try {
        const flow = await fetchFlowContextState(flowId);
        if (!cancelled) {
          const leaderCompaction = flow.context_compactions?.find((item) =>
            (item.status === "running" || item.status === "completed") && isLeaderCompaction(item, leaderAgentSessionId)
          ) ?? null;
          setContextUsage(flow.context_usage?.leader ?? null);
          setContextCompaction(leaderCompaction);
          setIsCompactingContext(leaderCompaction?.status === "running");
        }
      } catch {
        if (!cancelled) {
          setContextUsage(null);
          setContextCompaction(null);
        }
      }
    }

    void refreshContextUsage();
    return () => {
      cancelled = true;
    };
  }, [flowId, leaderAgentSessionId]);

  const handleRiskModeChange = useCallback(async (next: RiskMode) => {
    if (!flowId || next === riskMode || settingsMutationRef.current.pending) return;
    const previous = riskMode;
    const requestId = settingsMutationRef.current.requestId + 1;
    settingsMutationRef.current = { flowId, requestId, pending: true };
    setRiskMode(next);
    setSettingsUpdating(true);
    try {
      const response = await fetch(`${API_BASE}/api/flows/${flowId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ risk_mode: next }),
      });
      if (!response.ok && settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        setRiskMode(previous);
      }
    } catch {
      if (settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        setRiskMode(previous);
      }
    } finally {
      if (settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        settingsMutationRef.current.pending = false;
        setSettingsUpdating(false);
      }
    }
  }, [flowId, riskMode]);

  const handlePlanApprovalChange = useCallback(async (next: PlanApproval) => {
    if (!flowId || next === planApproval || settingsMutationRef.current.pending) return;
    const previous = planApproval;
    const requestId = settingsMutationRef.current.requestId + 1;
    settingsMutationRef.current = { flowId, requestId, pending: true };
    setPlanApproval(next);
    setSettingsUpdating(true);
    try {
      const response = await fetch(`${API_BASE}/api/flows/${flowId}/orchestration-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_approval: next }),
      });
      if (!response.ok && settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        setPlanApproval(previous);
      }
    } catch {
      if (settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        setPlanApproval(previous);
      }
    } finally {
      if (settingsMutationRef.current.flowId === flowId && settingsMutationRef.current.requestId === requestId) {
        settingsMutationRef.current.pending = false;
        setSettingsUpdating(false);
      }
    }
  }, [flowId, planApproval]);

  const handleCompactContext = useCallback(async () => {
    if (!flowId || isWaiting || isCompactingContext) return;
    const agentSessionId = contextUsage?.agent_session_id ?? leaderAgentSessionId;
    if (agentSessionId) {
      const now = new Date().toISOString();
      setContextCompaction({
        flow_id: flowId,
        agent_session_id: agentSessionId,
        sdk_session_id: contextUsage?.sdk_session_id ?? null,
        role: "leader",
        expert_id: "exp-leader",
        flow_expert_id: null,
        display_name: "Leader",
        status: "running",
        started_at: now,
        updated_at: now,
        error_message: null,
      });
      setFollowRequestKey((value) => value + 1);
    }
    setIsCompactingContext(true);
    try {
      setContextUsage(await compactFlowContext(flowId));
      setContextCompaction((current) => {
        if (current?.status === "completed") return current;
        if (!agentSessionId) return current;
        const now = new Date().toISOString();
        return {
          flow_id: flowId,
          agent_session_id: agentSessionId,
          sdk_session_id: contextUsage?.sdk_session_id ?? current?.sdk_session_id ?? null,
          role: "leader",
          expert_id: "exp-leader",
          flow_expert_id: null,
          display_name: "Leader",
          status: "completed",
          started_at: current?.started_at ?? now,
          updated_at: now,
          error_message: null,
        };
      });
      setFollowRequestKey((value) => value + 1);
    } catch {
      setContextCompaction(null);
    } finally {
      setIsCompactingContext(false);
    }
  }, [contextUsage, flowId, isCompactingContext, isWaiting, leaderAgentSessionId]);

  const sendMessage = useCallback(
    async (
      text: string,
      options: LeaderMessageOptions = {},
    ): Promise<boolean> => {
      const hasPlatformContent = Boolean(options.planFeedback?.length || options.browserElementAttachments?.length);
      if (!flowId || (!text && !hasPlatformContent) || !leaderModelConfigured) return false;
      const outgoingAttachments = outgoingAttachmentsForMessage(options);
      const displayText = options.displayText
        || (options.planFeedback?.length
          ? `计划评论（${options.planFeedback.length} 条）`
          : options.browserElementAttachments?.length
          ? `网页圈选评论（${options.browserElementAttachments.length} 条）`
          : text);

      const logId = wsClient.genLogId();
      const clientMessageId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date();
      const userMessage = {
        id: clientMessageId,
        role: "user",
        parts: [{ type: "text", text: displayText }],
        content: displayText,
        createdAt,
        metadata: options.browserElementAttachments?.length
        || options.imageAttachments?.length
        || options.planFeedback?.length
          ? {
            ...(options.browserElementAttachments?.length ? { browserElementAttachments: options.browserElementAttachments } : {}),
            ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
            ...(options.planFeedback?.length ? { planFeedback: options.planFeedback } : {}),
          }
          : undefined,
      } as UIMessage;
      setOptimisticMessages((prev) => [...prev, userMessage]);
      if (activeUserTurn && (options.reuseActiveUserTurn || activeUserTurn.status === "waiting_user")) {
        setUserTurns((prev) => mergeUserTurn(prev, {
          ...activeUserTurn,
          status: "active",
          activeStartedAt: createdAt.toISOString(),
        }));
      } else {
        setUserTurns((prev) => mergeUserTurn(prev, {
          id: `optimistic-${clientMessageId}`,
          triggerMessageId: clientMessageId,
          status: "active",
          startedAt: createdAt.toISOString(),
          activeStartedAt: createdAt.toISOString(),
          activeDurationMs: 0,
          completedAt: null,
        }));
      }
      setStatus("submitted");
      setKnownRunningFlow(flowId, true);
      setFollowRequestKey((value) => value + 1);

      wsClient.send({
        type: "flow:message",
        flow_id: flowId,
        content: text,
        ...(options.specRequested ? { spec_requested: true } : {}),
        ...(outgoingAttachments.length ? { attachments: outgoingAttachments } : {}),
        ...(options.planFeedback?.length ? { plan_feedback: options.planFeedback.map((feedback) => ({ id: feedback.id, plan_revision_id: feedback.planRevisionId, plan_node_id: feedback.planNodeId, marker_number: feedback.markerNumber, comment: feedback.comment })) } : {}),
        client_message_id: clientMessageId,
        log_id: logId,
      });
      return true;
    },
    [activeUserTurn, flowId, leaderModelConfigured, setKnownRunningFlow],
  );

  useEffect(() => {
    if (restoredQueueNeedsFlowStateRef.current && isWaiting) {
      restoredQueueObservedWaitingRef.current = true;
    }
  }, [isWaiting]);

  useEffect(() => {
    if (isWaiting || !leaderModelConfigured) return;
    if (!flowStateConfirmed && queuedMessages.length > 0) return;
    if (
      restoredQueueNeedsFlowStateRef.current
      && (!flowStateConfirmed || !restoredQueueObservedWaitingRef.current)
    ) return;
    const next = queuedMessages[0];
    if (!next) return;
    updateQueuedMessages((messages) => messages.filter((message) => message.id !== next.id));
    void (async () => {
      const sent = await sendMessage(next.content, {
        displayText: next.displayContent ?? next.content,
        browserElementAttachments: next.browserElementAttachments,
        imageAttachments: next.imageAttachments,
        planFeedback: next.planFeedback,
        outgoingAttachments: next.outgoingAttachments,
        specRequested: next.specRequested,
      });
      if (sent && next.browserElementAttachments?.length) {
        const bridge = getDesktopBrowserBridge();
        void bridge?.stopElementPicker();
      }
    })();
  }, [flowStateConfirmed, isWaiting, leaderModelConfigured, queuedMessages, sendMessage, updateQueuedMessages]);

  const enqueueMessage = useCallback((content: string, options: LeaderMessageOptions = {}) => {
    if (isWaiting) {
      restoredQueueNeedsFlowStateRef.current = false;
      restoredQueueObservedWaitingRef.current = false;
    }
    updateQueuedMessages((messages) => [
      ...messages,
      {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content,
        ...(options.displayText && options.displayText !== content ? { displayContent: options.displayText } : {}),
        ...(options.browserElementAttachments?.length ? { browserElementAttachments: options.browserElementAttachments } : {}),
        ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
        ...(options.planFeedback?.length ? { planFeedback: options.planFeedback } : {}),
        ...(options.outgoingAttachments?.length ? { outgoingAttachments: options.outgoingAttachments } : {}),
        ...(options.specRequested ? { specRequested: true } : {}),
      },
    ]);
  }, [isWaiting, updateQueuedMessages]);

  const handleComposerSend = useCallback((text: string, options: LeaderMessageOptions = {}): Promise<boolean> | boolean => {
    if (runtimeSelectionUpdating) return false;
    if (shouldQueueNewMessage) {
      enqueueMessage(text, options);
      return true;
    }
    return sendMessage(text, options);
  }, [enqueueMessage, runtimeSelectionUpdating, sendMessage, shouldQueueNewMessage]);

  const handleComposerSendWithAttachments = useCallback(async (text: string): Promise<boolean> => {
    const content = text;
    const outgoingAttachments = outgoingAttachmentsForMessage({
      browserElementAttachments,
      imageAttachments,
    });
    const sent = await Promise.resolve(handleComposerSend(content, {
      displayText: text,
      browserElementAttachments,
      imageAttachments,
      planFeedback,
      outgoingAttachments,
      specRequested,
    }));
    if (sent !== false) setSpecRequested(false);
    if (sent !== false && (browserElementAttachments.length > 0 || imageAttachments.length > 0 || planFeedback.length > 0)) {
      if (browserElementAttachments.length > 0) {
        clearBrowserElementAttachments();
        const bridge = getDesktopBrowserBridge();
        void bridge?.stopElementPicker();
      }
      if (imageAttachments.length > 0) clearImageAttachments();
      if (planFeedback.length > 0) clearPlanFeedback();
    }
    return sent !== false;
  }, [
    browserElementAttachments,
    clearBrowserElementAttachments,
    clearImageAttachments,
    clearPlanFeedback,
    handleComposerSend,
    imageAttachments,
    planFeedback,
    specRequested,
  ]);

  const effectiveComposerValue = composerValue ?? localComposerValue;
  const handleComposerValueChange = useCallback((value: string) => {
    onComposerValueChange?.(value);
    if (composerValue === undefined) setLocalComposerValue(value);
  }, [composerValue, onComposerValueChange]);

  const handlePasteImages = useCallback(async (files: File[], textOffset: number) => {
    const attachments = (await Promise.all(files.map((file) => imageAttachmentFromFile(file, textOffset))))
      .filter((attachment): attachment is MessageImageAttachment => attachment !== null);
    if (attachments.length > 0) addImageAttachments(attachments);
  }, [addImageAttachments]);

  const handleReorderQueuedMessage = useCallback((fromIndex: number, toIndex: number) => {
    updateQueuedMessages((messages) => {
      if (fromIndex < 0 || fromIndex >= messages.length || toIndex < 0 || toIndex >= messages.length) return messages;
      const next = [...messages];
      const [item] = next.splice(fromIndex, 1);
      if (!item) return messages;
      next.splice(toIndex, 0, item);
      return next;
    });
  }, [updateQueuedMessages]);

  const handleEditQueuedMessage = useCallback((message: RunningQueuedMessage) => {
    updateQueuedMessages((messages) => messages.filter((item) => item.id !== message.id));
    handleComposerValueChange(message.displayContent ?? message.content);
    if (message.browserElementAttachments?.length) {
      setBrowserElementAttachments(message.browserElementAttachments);
      void restoreBrowserAnnotationsForEditing(message.browserElementAttachments);
    }
    if (message.imageAttachments?.length) addImageAttachments(message.imageAttachments);
    if (message.planFeedback?.length) setPlanFeedback(message.planFeedback);
    setSpecRequested(Boolean(message.specRequested));
  }, [addImageAttachments, handleComposerValueChange, setBrowserElementAttachments, setPlanFeedback, updateQueuedMessages]);

  const handleDeleteQueuedMessage = useCallback((messageId: string) => {
    updateQueuedMessages((messages) => messages.filter((message) => message.id !== messageId));
  }, [updateQueuedMessages]);

  const handleStopCurrentTurn = useCallback(() => {
    if (!flowId || !activeUserTurn) return;
    wsClient.sendUserTurnCancel(flowId, activeUserTurn.id);
    setStatus("ready");
    setKnownRunningFlow(flowId, false);
    updateQueuedMessages(() => []);
    pendingGuidesRef.current.clear();
    handleComposerValueChange("");
    if (activeUserTurn) {
      setUserTurns((turns) => mergeUserTurn(turns, {
        ...activeUserTurn,
        status: "cancelled",
        activeStartedAt: null,
        completedAt: new Date().toISOString(),
      }));
    }
  }, [activeUserTurn, flowId, handleComposerValueChange, setKnownRunningFlow, updateQueuedMessages]);

  const handleGuideQueuedMessage = useCallback((message: RunningQueuedMessage) => {
    if (!flowId || !leaderModelConfigured) return;
    if (isStreaming && message.specRequested) return;
    if (!isStreaming) {
      updateQueuedMessages((messages) => messages.filter((item) => item.id !== message.id));
      void sendMessage(message.content, {
        displayText: message.displayContent ?? message.content,
        browserElementAttachments: message.browserElementAttachments,
        imageAttachments: message.imageAttachments,
        planFeedback: message.planFeedback,
        outgoingAttachments: message.outgoingAttachments,
        specRequested: message.specRequested,
        reuseActiveUserTurn: true,
      }).then((sent) => {
        if (sent && message.browserElementAttachments?.length) {
          const bridge = getDesktopBrowserBridge();
          void bridge?.stopElementPicker();
        }
      });
      return;
    }
    const logId = wsClient.genLogId();
    const clientMessageId = `msg-user-guided-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outgoingAttachments = outgoingAttachmentsForMessage(message);
    const parsedDisplayText = message.displayContent ?? message.content;
    const displayText = parsedDisplayText
      || (message.planFeedback?.length
        ? `计划评论（${message.planFeedback.length} 条）`
        : message.browserElementAttachments?.length
        ? `网页圈选评论（${message.browserElementAttachments.length} 条）`
        : message.content);
    updateQueuedMessages((messages) => messages.filter((item) => item.id !== message.id));
    setKnownRunningFlow(flowId, true);
    pendingGuidesRef.current.set(logId, {
      clientMessageId,
      displayText,
      browserElementAttachments: message.browserElementAttachments,
      imageAttachments: message.imageAttachments,
      planFeedback: message.planFeedback,
    });
    const guideMessage = runningGuideUiMessage(clientMessageId, displayText, {
      browserElementAttachments: message.browserElementAttachments,
      imageAttachments: message.imageAttachments,
    });
    setGuidedMessages((messages) =>
      messages.some((item) => item.id === clientMessageId) ? messages : [...messages, guideMessage]
    );
    try {
      if (message.planFeedback?.length) {
        wsClient.sendFlowGuide(flowId, message.content, clientMessageId, logId, outgoingAttachments, message.planFeedback);
      } else if (outgoingAttachments.length) {
        wsClient.sendFlowGuide(flowId, message.content, clientMessageId, logId, outgoingAttachments);
      } else {
        wsClient.sendFlowGuide(flowId, message.content, clientMessageId, logId);
      }
      if (message.browserElementAttachments?.length) {
        const bridge = getDesktopBrowserBridge();
        void bridge?.stopElementPicker();
      }
    } catch {
      pendingGuidesRef.current.delete(logId);
      setGuidedMessages((messages) => messages.filter((item) => item.id !== clientMessageId));
    }
  }, [flowId, isStreaming, leaderModelConfigured, sendMessage, setKnownRunningFlow, updateQueuedMessages]);

  const composerDisabled = !flowId || !leaderModelConfigured || runtimeSelectionUpdating || hasPendingDecisionCards;
  const placeholder = hasPendingDecisionCards
    ? "请先完成澄清卡片..."
    : !leaderModelConfigured
      ? "请先选择模型"
      : shouldQueueNewMessage
      ? "继续输入以排队后续修改"
      : flowStatus === "idle"
        ? "输入消息开始新的讨论..."
        : "输入消息...";
  const approvePlan = useCallback((plan: OrchestrationPlanView) => {
    if (!plan.approval || plan.approval.status !== "pending") return;
    wsClient.send({ type: "flow:plan_approve", flow_id: plan.flow_id, plan_approval_id: plan.approval.plan_approval_id, client_action_id: `plan-approve-${Date.now()}` });
  }, []);
  const isCompactComposer = composerVariant === "compactFloating";
  const modelSelector = (
    <LeaderModelSelector
      flowId={flowId}
      onConfiguredChange={setLeaderModelConfigured}
      onUpdatingChange={setRuntimeSelectionUpdating}
      onOpenModelSettings={onOpenModelSettings}
      reasoningEffortDisabled={isWaiting}
      className={isCompactComposer
        ? "max-w-[280px]"
        : "max-w-[330px]"}
    />
  );
  const actionControls = (
    <div className="flex shrink-0 items-center gap-1.5">
      <ContextUsageIndicator
        usage={contextUsage}
        canCompact={Boolean(flowId && !isWaiting && contextUsage && contextCompaction?.status !== "running")}
        isCompacting={isCompactingContext}
        onCompact={handleCompactContext}
      />
      {modelSelector}
    </div>
  );
  const specControl = (
    <ComposerModeMenu
      specRequested={specRequested}
      riskMode={riskMode}
      planApproval={planApproval}
      disabled={!flowId || settingsUpdating}
      onSpecChange={setSpecRequested}
      onRiskModeChange={handleRiskModeChange}
      onPlanApprovalChange={handlePlanApprovalChange}
    />
  );
  const composer = (
    <div
      data-testid="leader-chat-composer"
      className={isCompactComposer ? "pointer-events-auto mx-auto w-full max-w-full" : "pointer-events-none absolute inset-x-0 bottom-4 z-20"}
    >
      <div className={isCompactComposer ? "mx-auto w-full" : "pointer-events-auto mx-auto w-full max-w-full space-y-3"}>
        {hasPendingDecisionCards ? (
          <PendingDecisionDock
            flowId={flowId}
            cards={pendingDecisionCards}
            onStopCurrentTurn={activeUserTurn ? handleStopCurrentTurn : undefined}
            className={isCompactComposer
              ? "mx-auto w-full rounded-[20px] shadow-[var(--ui-shadow-elevated)]"
              : "mx-auto w-[min(880px,calc(100%-128px))] max-w-full max-[760px]:w-[calc(100%-40px)]"}
          />
        ) : (
          <>
            {queuedMessages.length > 0 ? (
              <div className={isCompactComposer
                ? "mx-auto w-full overflow-visible"
                : "mx-auto w-[min(880px,calc(100%-128px))] max-w-full overflow-visible max-[760px]:w-[calc(100%-40px)]"}
              >
                <RunningMessageQueue
                  messages={queuedMessages}
                  onReorder={handleReorderQueuedMessage}
                  onEdit={handleEditQueuedMessage}
                  onDelete={handleDeleteQueuedMessage}
                  onGuide={handleGuideQueuedMessage}
                  actionLabel={isStreaming ? "引导" : "发送给 Leader"}
                />
              </div>
            ) : null}
            <div className={isCompactComposer
              ? "mx-auto w-full overflow-visible"
              : "mx-auto w-[min(880px,calc(100%-128px))] max-w-full overflow-visible max-[760px]:w-[calc(100%-40px)]"}
            >
              <PromptInput
                onSend={handleComposerSendWithAttachments}
                disabled={composerDisabled}
                allowEmptySend={planFeedback.length > 0 || browserElementAttachments.length > 0}
                placeholder={placeholder}
                value={effectiveComposerValue}
                onValueChange={handleComposerValueChange}
                onPasteImages={handlePasteImages}
                attachmentSlot={(
                  <>
                    <MessageImageAttachments />
                    <BrowserElementAttachments />
                    <PlanFeedbackAttachments />
                  </>
                )}
                toolbarSlot={specControl}
                actionSlot={actionControls}
                stopActive={Boolean(flowId && canStopCurrentTurn)}
                onStop={handleStopCurrentTurn}
                className={!isCompactComposer ? "shadow-[var(--ui-shadow-elevated)]" : undefined}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (composerOnly) return composer;

  return (
    <div data-testid="leader-chat-panel" className="relative flex h-full flex-col">
      <div data-testid="leader-chat-transcript-shell" className="relative min-h-0 flex-1">
        <SessionTranscriptPanel
          flowId={flowId}
          agentSessionId={leaderAgentSessionId}
          readonly={false}
          decisionCards={decisionCards}
          decisionCardStatuses={decisionCardStatuses}
          decisionCardAnswers={decisionCardAnswers}
          specCards={specCards}
          orchestrationPlans={orchestrationPlans}
          optimisticMessages={transcriptOptimisticMessages}
          followRequestKey={followRequestKey}
          isAwaitingResponse={isWaiting}
          userTurns={mergedUserTurns}
          review={review}
          onOpenReview={onOpenReview}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          allowInferredAgentSessionId
          onOpenSpec={onOpenSpecPreview}
          onOpenPlan={onOpenPlan}
          onApprovePlan={approvePlan}
          className="relative h-full overflow-y-hidden"
          bottomOverlayHeight={queuedMessages.length > 0 ? 296 : 132}
          emptyTitle="开始对话"
          emptyDescription="发送消息开始与 AI 助手对话"
          statusDividerLabel={compactionDividerLabel}
          statusDividerAnimated={contextCompaction?.status === "running"}
          statusDividerAt={contextCompaction?.started_at ?? null}
          workspaceRootPath={workspaceRootPath}
        />
      </div>

      {composer}
    </div>
  );
}

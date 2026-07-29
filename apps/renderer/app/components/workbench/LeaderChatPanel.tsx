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
import { useNativeContextSlashMenu } from "../../hooks/useNativeContextSlashMenu";

export interface LeaderChatPanelProps {
  flowId: string | null;
  leaderAgentSessionId: string | null;
  initialOptimisticMessages?: UIMessage[];
  initialPlanModeReturnRiskMode?: RiskMode | null;
  onInitialPlanModeResolved?: () => void;
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
  input_snapshot_json?: string | null;
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

const acceptedPlanApprovalStatuses = new Set(["approved", "auto_approved"]);
const pendingPlanRevisionStatuses = new Set(["generating", "pending", "pending_approval", "feedback_pending"]);

function hasPendingPlanWorkflow(
  specCards: Record<string, SpecCardState>,
  plans: OrchestrationPlanView[],
) {
  if (Object.values(specCards).some((card) => card.status === "pending")) return true;
  return plans.some((plan) => {
    const approvalStatus = plan.approval?.status;
    return approvalStatus === "pending"
      || approvalStatus === "feedback_pending"
      || pendingPlanRevisionStatuses.has(plan.revision.status);
  });
}

function planApprovalEventField(data: unknown, camelName: string, snakeName: string) {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  return record[camelName] ?? record[snakeName];
}

function planApprovalBelongsToSession(
  data: unknown,
  startedAt: number | null,
  userTurnId: string | null,
) {
  const eventUserTurnId = planApprovalEventField(data, "userTurnId", "user_turn_id");
  if (userTurnId && typeof eventUserTurnId === "string") return eventUserTurnId === userTurnId;
  const createdAt = planApprovalEventField(data, "createdAt", "created_at");
  if (startedAt !== null && typeof createdAt === "string") {
    const timestamp = Date.parse(createdAt);
    if (Number.isFinite(timestamp)) return timestamp >= startedAt - 2_000;
  }
  // A plan approval event without either identity is still useful for a newly
  // entered plan mode, but it cannot match a session already tied to a turn.
  return !userTurnId;
}

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

function queuedClientPayload(message: RunningQueuedMessage): Record<string, unknown> {
  return {
    ...message,
    ...(message.imageAttachments?.length ? {
      imageAttachments: message.imageAttachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
    } : {}),
    ...(message.browserElementAttachments?.length ? {
      browserElementAttachments: message.browserElementAttachments.map(({ screenshotDataUrl: _screenshotDataUrl, ...attachment }) => attachment),
    } : {}),
  };
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
  let specRequested = false;
  try {
    const snapshot = JSON.parse(turn.input_snapshot_json ?? "{}") as { spec_requested?: unknown };
    specRequested = snapshot.spec_requested === true;
  } catch {
    // Invalid legacy snapshots must not prevent the turn from rendering.
  }
  return {
    id,
    triggerMessageId: turn.trigger_message_id,
    status: turn.status ?? "active",
    startedAt: turn.started_at ?? null,
    activeStartedAt: turn.active_started_at ?? null,
    activeDurationMs: typeof turn.active_duration_ms === "number" ? turn.active_duration_ms : 0,
    completedAt: turn.completed_at ?? null,
    workRootPath: turn.work_root_path?.trim() || undefined,
    specRequested,
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
  initialPlanModeReturnRiskMode = null,
  onInitialPlanModeResolved,
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
  const [planModeLocked, setPlanModeLocked] = useState(false);
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
  const [nativeContextRefreshKey, setNativeContextRefreshKey] = useState(0);
  const [sessionRecoveryError, setSessionRecoveryError] = useState<{ message: string; category?: string } | null>(null);
  const [leaderRuntimeError, setLeaderRuntimeError] = useState<string | null>(null);
  const browserElementAttachments = useBrowserSelectionStore((state) => state.elements);
  const clearBrowserElementAttachments = useBrowserSelectionStore((state) => state.clearElements);
  const setBrowserElementAttachments = useBrowserSelectionStore((state) => state.setElements);
  const imageAttachments = useComposerImageStore((state) => state.images);
  const addImageAttachments = useComposerImageStore((state) => state.addImages);
  const clearImageAttachments = useComposerImageStore((state) => state.clearImages);
  const planFeedback = usePlanFeedbackStore((state) => state.drafts);
  const clearPlanFeedback = usePlanFeedbackStore((state) => state.clearDrafts);
  const setPlanFeedback = usePlanFeedbackStore((state) => state.setDrafts);
  const dispatchingQueueIdRef = useRef<string | null>(null);
  const pendingMessagesRef = useRef(new Map<string, string>());
  const pendingGuidesRef = useRef(new Map<string, PendingGuideMessage>());
  const planModeReturnRiskModeRef = useRef<RiskMode>(initialRiskMode);
  const planModeReturnRiskModeSetRef = useRef(false);
  const planModeStartedAtRef = useRef<number | null>(null);
  const planModeUserTurnIdRef = useRef<string | null>(null);
  const planModeResolvedRevisionIdRef = useRef<string | null>(null);
  const planModeResolvedRef = useRef(false);
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
  const knownRunningFlow = useRunningMessageQueueStore((state) =>
    flowId ? Boolean(state.knownRunningByFlow[flowId]) : false
  );
  const setKnownRunningFlow = useRunningMessageQueueStore((state) => state.setKnownRunningFlow);
  const updateFlowQueue = useRunningMessageQueueStore((state) => state.updateFlowQueue);
  const setFlowQueue = useRunningMessageQueueStore((state) => state.setFlowQueue);

  const updateQueuedMessages = useCallback((updater: (messages: RunningQueuedMessage[]) => RunningQueuedMessage[]) => {
    if (!flowId) return;
    updateFlowQueue(flowId, updater);
  }, [flowId, updateFlowQueue]);

  const mergedUserTurns = useMemo(
    () => userTurns.reduce((merged, turn) => mergeUserTurn(merged, turn), dashboardUserTurns),
    [dashboardUserTurns, userTurns],
  );

  const enterPlanMode = useCallback((userTurnId?: string | null) => {
    if (!planModeLocked) {
      planModeResolvedRevisionIdRef.current = null;
      planModeResolvedRef.current = false;
    }
    if (!planModeReturnRiskModeSetRef.current) {
      planModeReturnRiskModeRef.current = riskMode;
      planModeReturnRiskModeSetRef.current = true;
    }
    if (planModeStartedAtRef.current === null) planModeStartedAtRef.current = Date.now();
    if (userTurnId) planModeUserTurnIdRef.current = userTurnId;
    setSpecRequested(true);
    setPlanModeLocked(true);
  }, [planModeLocked, riskMode]);

  const exitPlanMode = useCallback((resolvedRevisionId?: string | null) => {
    const restoreRiskMode = planModeReturnRiskModeRef.current;
    setSpecRequested(false);
    setPlanModeLocked(false);
    setRiskMode(restoreRiskMode);
    planModeReturnRiskModeSetRef.current = false;
    planModeStartedAtRef.current = null;
    planModeUserTurnIdRef.current = null;
    planModeResolvedRevisionIdRef.current = resolvedRevisionId ?? null;
    planModeResolvedRef.current = true;
    onInitialPlanModeResolved?.();
  }, [onInitialPlanModeResolved]);

  const handleSpecChange = useCallback((requested: boolean) => {
    if (requested) {
      if (!planModeLocked) {
        planModeResolvedRevisionIdRef.current = null;
        planModeResolvedRef.current = false;
      }
      if (!planModeReturnRiskModeSetRef.current) {
        planModeReturnRiskModeRef.current = riskMode;
        planModeReturnRiskModeSetRef.current = true;
      }
      setSpecRequested(true);
      return;
    }
    // Before the first plan message is accepted the user may change their mind.
    // Once it is sent, approval (or an explicit stop) owns the transition back.
    if (!planModeLocked) {
      setSpecRequested(false);
      planModeReturnRiskModeSetRef.current = false;
      planModeStartedAtRef.current = null;
      planModeUserTurnIdRef.current = null;
    }
  }, [planModeLocked, riskMode]);

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
    setPlanModeLocked(false);
    planModeReturnRiskModeRef.current = initialRiskMode;
    planModeReturnRiskModeSetRef.current = false;
    planModeStartedAtRef.current = null;
    planModeUserTurnIdRef.current = null;
    planModeResolvedRevisionIdRef.current = null;
    planModeResolvedRef.current = false;
    dispatchingQueueIdRef.current = null;
    pendingMessagesRef.current.clear();
    pendingGuidesRef.current.clear();
  }, [flowId, initialRiskMode]);

  useEffect(() => {
    if (dashboardUserTurns.length > 0) {
      setFlowStateConfirmed(true);
    }
  }, [dashboardUserTurns.length]);

  useEffect(() => {
    setRiskMode(initialRiskMode);
    if (!planModeLocked) {
      planModeReturnRiskModeRef.current = initialRiskMode;
      planModeReturnRiskModeSetRef.current = false;
    }
  }, [flowId, initialRiskMode, planModeLocked]);

  useEffect(() => {
    setPlanApproval(initialPlanApproval);
  }, [flowId, initialPlanApproval]);

  useEffect(() => {
    if (!flowId || initialPlanModeReturnRiskMode === null || planModeResolvedRef.current) return;
    planModeReturnRiskModeRef.current = initialPlanModeReturnRiskMode;
    planModeReturnRiskModeSetRef.current = true;
    if (planModeStartedAtRef.current === null) planModeStartedAtRef.current = Date.now();
    setSpecRequested(true);
    setPlanModeLocked(true);
  }, [flowId, initialPlanModeReturnRiskMode]);

  useEffect(() => {
    if (!flowId) return;

    const pendingSpec = Object.values(specCards).find((card) => card.status === "pending");
    const pendingPlan = orchestrationPlans.find((plan) => {
      const approvalStatus = plan.approval?.status;
      return approvalStatus === "pending"
        || approvalStatus === "feedback_pending"
        || pendingPlanRevisionStatuses.has(plan.revision.status);
    });
    const pendingWorkflow = hasPendingPlanWorkflow(specCards, orchestrationPlans);
    const openSpecTurn = mergedUserTurns.find((turn) =>
      (turn.status === "active" || turn.status === "waiting_user") && turn.specRequested
    );

    const pendingPlanWasJustResolved = Boolean(
      pendingPlan
      && planModeResolvedRevisionIdRef.current === pendingPlan.revision.plan_revision_id,
    );

    if (
      !planModeResolvedRef.current
      && (initialPlanModeReturnRiskMode !== null || openSpecTurn || pendingWorkflow)
      && !pendingPlanWasJustResolved
    ) {
      if (!planModeReturnRiskModeSetRef.current) {
        planModeReturnRiskModeRef.current = initialRiskMode;
        planModeReturnRiskModeSetRef.current = true;
      }
      if (planModeStartedAtRef.current === null) {
        const createdAt = pendingPlan?.revision.created_at || pendingPlan?.approval?.created_at;
        const parsedCreatedAt = createdAt ? Date.parse(createdAt) : NaN;
        planModeStartedAtRef.current = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
      }
      if (pendingSpec?.user_turn_id) planModeUserTurnIdRef.current = pendingSpec.user_turn_id;
      if (pendingPlan?.user_turn_id) planModeUserTurnIdRef.current = pendingPlan.user_turn_id;
      if (openSpecTurn?.id) planModeUserTurnIdRef.current = openSpecTurn.id;
      setSpecRequested(true);
      setPlanModeLocked(true);
      return;
    }

    if (!planModeLocked) return;
    const acceptedPlan = orchestrationPlans.find((plan) => {
      const status = plan.approval?.status;
      return typeof status === "string"
        && acceptedPlanApprovalStatuses.has(status)
        && planApprovalBelongsToSession(
          {
            userTurnId: plan.user_turn_id,
            createdAt: plan.approval?.created_at ?? plan.revision.created_at,
          },
          planModeStartedAtRef.current,
          planModeUserTurnIdRef.current,
        );
    });
    if (acceptedPlan) exitPlanMode(acceptedPlan.revision.plan_revision_id);
  }, [
    exitPlanMode,
    flowId,
    initialPlanModeReturnRiskMode,
    initialRiskMode,
    mergedUserTurns,
    orchestrationPlans,
    planModeLocked,
    specCards,
  ]);

  useEffect(() => {
    if (!flowId) return;

    const unsubscribe = wsClient.onMessage((msg: WsInMessage) => {
      if (msg.type === "system:error") {
        if (msg.flow_id && msg.flow_id !== flowId) return;
        if (msg.data?.code === "LEADER_SESSION_RECOVERY_REQUIRED") {
          setSessionRecoveryError({
            message: msg.data.message,
            category: typeof msg.data.category === "string" ? msg.data.category : undefined,
          });
          setStatus("ready");
          setKnownRunningFlow(flowId, false);
        } else if (msg.data?.code === "leader_error" && typeof msg.data?.message === "string" && msg.data.message.trim()) {
          setSessionRecoveryError(null);
          setLeaderRuntimeError(msg.data.message);
          setKnownRunningFlow(flowId, false);
        }
        dispatchingQueueIdRef.current = null;
        if (msg.log_id) {
          const pendingMessageId = pendingMessagesRef.current.get(msg.log_id);
          if (pendingMessageId) {
            pendingMessagesRef.current.delete(msg.log_id);
            setOptimisticMessages((messages) => messages.filter((message) => message.id !== pendingMessageId));
            setUserTurns([]);
            setKnownRunningFlow(flowId, dashboardUserTurns.some((turn) => turn.status === "active"));
          }
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
        setGuidedMessages((messages) => messages.filter((message) => message.id !== pendingGuide.clientMessageId));
        setFollowRequestKey((value) => value + 1);
        return;
      }

      if (msg.type === "flow:message_ack") {
        if (msg.flow_id !== flowId) return;
        if (msg.log_id) pendingMessagesRef.current.delete(msg.log_id);
        const clientMessageId = msg.data.client_message_id;
        if (clientMessageId) {
          setOptimisticMessages((messages) => messages.filter((message) => message.id !== clientMessageId));
        }
        return;
      }

      if (msg.type === "flow:queue_state") {
        if (msg.flow_id !== flowId) return;
        const messages = Array.isArray(msg.data?.messages)
          ? msg.data.messages as RunningQueuedMessage[]
          : [];
        setFlowQueue(flowId, messages);
        if (!dispatchingQueueIdRef.current || !messages.some((item) => item.id === dispatchingQueueIdRef.current)) {
          dispatchingQueueIdRef.current = null;
        }
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
        const serverQueue = Array.isArray(msg.data?.queued_messages)
          ? msg.data.queued_messages as RunningQueuedMessage[]
          : [];
        setFlowQueue(flowId, serverQueue);
        if (!dispatchingQueueIdRef.current || !serverQueue.some((item) => item.id === dispatchingQueueIdRef.current)) {
          dispatchingQueueIdRef.current = null;
        }
        setKnownRunningFlow(flowId, turns.some((turn) => turn.status === "active"));
        return;
      }

      if (msg.type === "user_turn:event") {
        if (msg.flow_id !== flowId) return;
        setFlowStateConfirmed(true);
        const turn = normalizeUserTurn(msg.data);
        if (turn) {
          if (
            planModeLocked
            && planModeUserTurnIdRef.current === null
            && planModeStartedAtRef.current !== null
            && turn.startedAt
            && Date.parse(turn.startedAt) >= planModeStartedAtRef.current - 2_000
          ) {
            planModeUserTurnIdRef.current = turn.id;
          }
          setKnownRunningFlow(flowId, turn.status === "active");
          setUserTurns((prev) => mergeUserTurn(prev, turn));
        }
        return;
      }

      if (msg.type === "plan_approval:event") {
        if (msg.flow_id !== flowId) return;
        const approvalStatus = planApprovalEventField(msg.data, "status", "status");
        if (
          planModeLocked
          && typeof approvalStatus === "string"
          && acceptedPlanApprovalStatuses.has(approvalStatus)
          && planApprovalBelongsToSession(
            msg.data,
            planModeStartedAtRef.current,
            planModeUserTurnIdRef.current,
          )
        ) {
          const revisionId = planApprovalEventField(msg.data, "planRevisionId", "plan_revision_id");
          exitPlanMode(typeof revisionId === "string" ? revisionId : null);
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
          setSessionRecoveryError(null);
          setLeaderRuntimeError(null);
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
  }, [dashboardUserTurns, exitPlanMode, flowId, leaderAgentSessionId, planModeLocked, setFlowQueue, setKnownRunningFlow]);

  useEffect(() => {
    setSessionRecoveryError(null);
    setLeaderRuntimeError(null);
  }, [flowId]);

  const transcriptOptimisticMessages = useMemo(
    () => [...initialOptimisticMessages, ...optimisticMessages, ...guidedMessages],
    [guidedMessages, initialOptimisticMessages, optimisticMessages],
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
    || isFlowStatePendingForKnownRunningFlow;
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
    if (!flowId || planModeLocked || next === riskMode || settingsMutationRef.current.pending) return;
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
  }, [flowId, planModeLocked, riskMode]);

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

      // Lock the mode before the WS send so an immediate plan event cannot
      // race the local transition back to the previous risk mode.
      if (options.specRequested) enterPlanMode(activeUserTurn?.id);

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

      pendingMessagesRef.current.set(logId, clientMessageId);
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
    [activeUserTurn, enterPlanMode, flowId, leaderModelConfigured, setKnownRunningFlow],
  );

  const enqueueMessage = useCallback((content: string, options: LeaderMessageOptions = {}) => {
    if (!flowId) return;
    const queueId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outgoingAttachments = outgoingAttachmentsForMessage(options);
    const queuedMessage: RunningQueuedMessage = {
      id: queueId,
      content,
      ...(options.displayText && options.displayText !== content ? { displayContent: options.displayText } : {}),
      ...(options.browserElementAttachments?.length ? { browserElementAttachments: options.browserElementAttachments } : {}),
      ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
      ...(options.planFeedback?.length ? { planFeedback: options.planFeedback } : {}),
      ...(options.specRequested ? { specRequested: true } : {}),
    };
    updateQueuedMessages((messages) => [...messages, queuedMessage]);
    wsClient.send({
      type: "flow:queue_add",
      flow_id: flowId,
      queue_id: queueId,
      content,
      ...(queuedMessage.displayContent ? { display_content: queuedMessage.displayContent } : {}),
      ...(queuedMessage.specRequested ? { spec_requested: true } : {}),
      ...(outgoingAttachments.length ? { attachments: outgoingAttachments } : {}),
      ...(options.planFeedback?.length ? {
        plan_feedback: options.planFeedback.map((feedback) => ({
          id: feedback.id,
          plan_revision_id: feedback.planRevisionId,
          plan_node_id: feedback.planNodeId,
          marker_number: feedback.markerNumber,
          comment: feedback.comment,
        })),
      } : {}),
      client_payload: queuedClientPayload(queuedMessage),
    });
  }, [flowId, updateQueuedMessages]);

  const handleComposerSend = useCallback((text: string, options: LeaderMessageOptions = {}): Promise<boolean> | boolean => {
    if (runtimeSelectionUpdating) return false;
    if (options.specRequested) enterPlanMode(activeUserTurn?.id);
    if (shouldQueueNewMessage) {
      enqueueMessage(text, options);
      return true;
    }
    return sendMessage(text, options);
  }, [activeUserTurn, enqueueMessage, enterPlanMode, runtimeSelectionUpdating, sendMessage, shouldQueueNewMessage]);

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
    if (!flowId || fromIndex < 0 || fromIndex >= queuedMessages.length || toIndex < 0 || toIndex >= queuedMessages.length) return;
    const next = [...queuedMessages];
    const [item] = next.splice(fromIndex, 1);
    if (!item) return;
    next.splice(toIndex, 0, item);
    updateQueuedMessages(() => next);
    wsClient.send({
      type: "flow:queue_reorder",
      flow_id: flowId,
      queue_ids: next.map((message) => message.id),
    });
  }, [flowId, queuedMessages, updateQueuedMessages]);

  const handleEditQueuedMessage = useCallback((message: RunningQueuedMessage) => {
    if (flowId) {
      wsClient.send({ type: "flow:queue_delete", flow_id: flowId, queue_id: message.id });
    }
    updateQueuedMessages((messages) => messages.filter((item) => item.id !== message.id));
    handleComposerValueChange(message.displayContent ?? message.content);
    if (message.browserElementAttachments?.length) {
      setBrowserElementAttachments(message.browserElementAttachments);
      void restoreBrowserAnnotationsForEditing(message.browserElementAttachments);
    }
    if (message.imageAttachments?.length) addImageAttachments(message.imageAttachments);
    if (message.planFeedback?.length) setPlanFeedback(message.planFeedback);
    if (message.specRequested) enterPlanMode();
    else if (!planModeLocked) setSpecRequested(false);
  }, [addImageAttachments, enterPlanMode, flowId, handleComposerValueChange, planModeLocked, setBrowserElementAttachments, setPlanFeedback, updateQueuedMessages]);

  const handleDeleteQueuedMessage = useCallback((messageId: string) => {
    if (flowId) {
      wsClient.send({ type: "flow:queue_delete", flow_id: flowId, queue_id: messageId });
    }
    updateQueuedMessages((messages) => messages.filter((message) => message.id !== messageId));
  }, [flowId, updateQueuedMessages]);

  const handleStopCurrentTurn = useCallback(() => {
    if (!flowId || !activeUserTurn) return;
    wsClient.sendUserTurnCancel(flowId, activeUserTurn.id);
    setStatus("ready");
    setKnownRunningFlow(flowId, false);
    exitPlanMode();
    wsClient.send({ type: "flow:queue_clear", flow_id: flowId });
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
  }, [activeUserTurn, exitPlanMode, flowId, handleComposerValueChange, setKnownRunningFlow, updateQueuedMessages]);

  const handleGuideQueuedMessage = useCallback((message: RunningQueuedMessage) => {
    if (!flowId || !leaderModelConfigured) return;
    if (isStreaming && message.specRequested) return;
    if (!isStreaming) {
      if (dispatchingQueueIdRef.current === message.id) return;
      dispatchingQueueIdRef.current = message.id;
      wsClient.send({ type: "flow:queue_dispatch", flow_id: flowId, queue_id: message.id });
      return;
    }
    const logId = wsClient.genLogId();
    const clientMessageId = `msg-user-guided-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const parsedDisplayText = message.displayContent ?? message.content;
    const displayText = parsedDisplayText
      || (message.planFeedback?.length
        ? `计划评论（${message.planFeedback.length} 条）`
        : message.browserElementAttachments?.length
        ? `网页圈选评论（${message.browserElementAttachments.length} 条）`
        : message.content);
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
      wsClient.send({
        type: "flow:queue_guide",
        flow_id: flowId,
        queue_id: message.id,
        client_message_id: clientMessageId,
        log_id: logId,
      });
      if (message.browserElementAttachments?.length) {
        const bridge = getDesktopBrowserBridge();
        void bridge?.stopElementPicker();
      }
    } catch {
      pendingGuidesRef.current.delete(logId);
      setGuidedMessages((messages) => messages.filter((item) => item.id !== clientMessageId));
    }
  }, [flowId, isStreaming, leaderModelConfigured, setKnownRunningFlow]);

  const composerDisabled = !flowId || !leaderModelConfigured || runtimeSelectionUpdating || hasPendingDecisionCards;
  const nativeContextSlashMenu = useNativeContextSlashMenu({
    flowId,
    refreshKey: nativeContextRefreshKey,
  });
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
  const handleRuntimeSelectionChange = useCallback(() => {
    setNativeContextRefreshKey((current) => current + 1);
  }, []);
  const isCompactComposer = composerVariant === "compactFloating";
  const modelSelector = (
    <LeaderModelSelector
      flowId={flowId}
      onConfiguredChange={setLeaderModelConfigured}
      onUpdatingChange={setRuntimeSelectionUpdating}
      onSelectionChange={handleRuntimeSelectionChange}
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
      planModeLocked={planModeLocked}
      disabled={!flowId || settingsUpdating}
      onSpecChange={handleSpecChange}
      onRiskModeChange={handleRiskModeChange}
      onPlanApprovalChange={handlePlanApprovalChange}
      onAddImages={(files) => handlePasteImages(files, effectiveComposerValue.length)}
    />
  );
  const composer = (
    <div
      data-testid="leader-chat-composer"
      data-layout={hasPendingDecisionCards && !isCompactComposer ? "docked" : "overlay"}
      className={isCompactComposer
        ? "pointer-events-auto mx-auto w-full max-w-full"
        : hasPendingDecisionCards
          ? "pointer-events-none relative z-20 shrink-0 pb-4"
          : "pointer-events-none absolute inset-x-0 bottom-4 z-20"}
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
                slashMenu={nativeContextSlashMenu}
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
      {sessionRecoveryError ? (
        <div
          data-testid="leader-session-recovery-error"
          role="alert"
          className="mx-auto mt-3 w-[min(880px,calc(100%-128px))] rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 max-[760px]:w-[calc(100%-40px)]"
        >
          <div className="font-medium">原 Leader 会话无法继续</div>
          <div className="mt-1 text-amber-100/80">{sessionRecoveryError.message}</div>
          <div className="mt-1 text-xs text-amber-100/60">系统不会创建新会话；确认 provider 可用后重新发送即可继续恢复。</div>
        </div>
      ) : null}
      {leaderRuntimeError && !sessionRecoveryError ? (
        <div
          data-testid="leader-runtime-error"
          role="alert"
          className="mx-auto mt-3 w-[min(880px,calc(100%-128px))] rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-foreground max-[760px]:w-[calc(100%-40px)]"
        >
          <div className="font-medium">请求失败</div>
          <div className="mt-1 text-muted-foreground">{leaderRuntimeError}</div>
        </div>
      ) : null}
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
          bottomOverlayHeight={hasPendingDecisionCards ? 0 : queuedMessages.length > 0 ? 296 : 132}
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

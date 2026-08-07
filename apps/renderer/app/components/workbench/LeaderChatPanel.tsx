"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { PromptInput } from "@/components/ai-elements-official/prompt-input";
import {
  API_BASE,
  compactFlowContext,
  fetchFlowContextState,
  type AgentContextCompactionDto,
  type AgentContextUsageDto,
} from "../../lib/api";
import { wsClient, type WsInMessage } from "../../lib/ws";
import type { DecisionRequestCardData, PlanCardState } from "../../hooks/useDashboardData";
import ComposerModeMenu, { type BehaviorMode, type OrchestrationMode, type RiskMode } from "../ComposerModeMenu";
import PendingDecisionRequestDock from "./PendingDecisionRequestDock";
import SessionTranscriptPanel from "./SessionTranscriptPanel";
import LeaderModelSelector from "../LeaderModelSelector";
import BrowserElementAttachments from "../BrowserElementAttachments";
import MessageImageAttachments from "../MessageImageAttachments";
import OrchestrationFeedbackAttachments from "../orchestration/OrchestrationFeedbackAttachments";
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
import { useOrchestrationFeedbackStore } from "../../stores/useOrchestrationFeedbackStore";
import type { OrchestrationFeedbackDraft, OrchestrationPlanView } from "../../types/orchestration";
import { useNativeContextSlashMenu } from "../../hooks/useNativeContextSlashMenu";
import { getDesktopBrowserBridge } from "../../lib/desktopBrowser";

export interface LeaderChatPanelProps {
  flowId: string | null;
  leaderAgentRunId: string | null;
  activeLeaderAgentRunId?: string | null;
  initialOptimisticMessages?: UIMessage[];
  flowStatus?: string;
  behaviorMode?: BehaviorMode;
  riskMode?: RiskMode;
  orchestrationMode?: OrchestrationMode;
  decisionRequests: DecisionRequestCardData[];
  planCards: Record<string, PlanCardState>;
  orchestrationPlans?: OrchestrationPlanView[];
  onOpenPlanPreview?: (planRevisionId: string, title: string) => void;
  onOpenPlan?: (plan: OrchestrationPlanView) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  composerOnly?: boolean;
  composerVariant?: "default" | "compactFloating";
  composerValue?: string;
  onComposerValueChange?: (value: string) => void;
  workspaceRootPath?: string | null;
  onOpenModelSettings?: () => void;
}

type MessageContent = {
  displayText?: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  orchestrationFeedback?: OrchestrationFeedbackDraft[];
};

function outgoingAttachments(content: MessageContent): OutgoingMessageImageAttachment[] {
  return [
    ...(content.imageAttachments ?? []).flatMap((attachment) => {
      const outgoing = outgoingImageAttachment(attachment);
      return outgoing ? [outgoing] : [];
    }),
    ...browserElementsToOutgoingAttachments(content.browserElementAttachments ?? []),
  ];
}

function queuePayload(message: RunningQueuedMessage) {
  return {
    content: message.content,
    ...(message.displayContent ? { displayContent: message.displayContent } : {}),
    ...(message.browserElementAttachments?.length ? {
      browserElementAttachments: message.browserElementAttachments.map(({ screenshotDataUrl: _screenshot, ...item }) => item),
    } : {}),
    ...(message.imageAttachments?.length ? {
      imageAttachments: message.imageAttachments.map(({ dataUrl: _data, ...item }) => item),
    } : {}),
    ...(message.orchestrationFeedback?.length ? { orchestrationFeedback: message.orchestrationFeedback } : {}),
  };
}

function orchestrationFeedbackPayload(items: OrchestrationFeedbackDraft[]) {
  return items.map((item) => ({
    id: item.id,
    orchestration_revision_id: item.orchestrationRevisionId,
    orchestration_node_id: item.orchestrationNodeId,
    marker_number: item.markerNumber,
    comment: item.comment,
  }));
}

function displayText(text: string, content: MessageContent) {
  if (content.displayText) return content.displayText;
  if (content.orchestrationFeedback?.length) return `编排评论（${content.orchestrationFeedback.length} 条）`;
  if (content.browserElementAttachments?.length) return `网页圈选评论（${content.browserElementAttachments.length} 条）`;
  if (content.imageAttachments?.length && !text) return `图片附件（${content.imageAttachments.length} 个）`;
  return text;
}

function optimisticUserMessage(id: string, text: string, content: MessageContent): UIMessage {
  const visibleText = displayText(text, content);
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: visibleText }],
    content: visibleText,
    createdAt: new Date().toISOString(),
    metadata: {
      ...(content.browserElementAttachments?.length ? { browserElementAttachments: content.browserElementAttachments } : {}),
      ...(content.imageAttachments?.length ? { imageAttachments: content.imageAttachments } : {}),
      ...(content.orchestrationFeedback?.length ? { orchestrationFeedback: content.orchestrationFeedback } : {}),
    },
  } as UIMessage;
}

function ContextUsageIndicator({
  usage,
  compacting,
  disabled,
  onCompact,
}: {
  usage: AgentContextUsageDto | null;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const percentage = typeof usage?.percentage === "number" ? Math.max(0, Math.min(100, Math.round(usage.percentage))) : 0;
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={usage ? `上下文已使用 ${percentage}%` : "上下文使用量暂不可用"}
        onClick={() => setOpen((value) => !value)}
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-ui-control-hover"
      >
        <span className="relative block size-[18px] rounded-full" style={{ background: `conic-gradient(currentColor ${percentage * 3.6}deg, color-mix(in srgb, currentColor 20%, transparent) 0deg)` }}>
          <span className="absolute inset-[4px] rounded-full bg-background" />
        </span>
      </button>
      {open ? (
        <div className="absolute bottom-10 right-0 z-50 w-64 rounded-xl border border-border bg-popover p-3 text-xs shadow-xl">
          <div className="font-semibold">上下文用量 {usage ? `${percentage}%` : "未知"}</div>
          <div className="mt-1 text-muted-foreground">{usage?.total_tokens?.toLocaleString() ?? "—"} / {usage?.max_tokens?.toLocaleString() ?? "—"} token</div>
          <button type="button" disabled={disabled || compacting || !usage} onClick={onCompact} className="mt-3 h-8 w-full rounded-lg bg-muted px-3 font-semibold disabled:opacity-45">
            {compacting ? "正在压缩…" : "压缩当前会话"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

async function restoreBrowserAnnotations(elements: BrowserElementAttachment[]) {
  const bridge = getDesktopBrowserBridge();
  if (!bridge || elements.length === 0) return;
  const restored = elements.map((element, index) => ({ ...element, markerNumber: index + 1 }));
  await bridge.setConfirmedMarkers?.(restored.map((element) => ({ markerNumber: element.markerNumber, selector: element.selector, rect: element.rect }))).catch(() => undefined);
  await bridge.startElementPicker(restored.length + 1).catch(() => undefined);
}

const EMPTY_MESSAGES: UIMessage[] = [];

export default function LeaderChatPanel({
  flowId,
  leaderAgentRunId,
  activeLeaderAgentRunId = null,
  initialOptimisticMessages = EMPTY_MESSAGES,
  flowStatus,
  behaviorMode: serverBehaviorMode = "execute",
  riskMode: serverRiskMode = "auto_edit",
  orchestrationMode: serverOrchestrationMode = "approval_required",
  decisionRequests,
  planCards,
  orchestrationPlans = [],
  onOpenPlanPreview,
  onOpenPlan = () => {},
  onOpenWorkspaceFile,
  composerOnly = false,
  composerVariant = "default",
  composerValue,
  onComposerValueChange,
  workspaceRootPath,
  onOpenModelSettings,
}: LeaderChatPanelProps) {
  const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>([]);
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [localComposerValue, setLocalComposerValue] = useState("");
  const [leaderModelConfigured, setLeaderModelConfigured] = useState(false);
  const [runtimeSelectionUpdating, setRuntimeSelectionUpdating] = useState(false);
  const [modeUpdating, setModeUpdating] = useState(false);
  const [behaviorMode, setBehaviorMode] = useState<BehaviorMode>(serverBehaviorMode);
  const [riskMode, setRiskMode] = useState<RiskMode>(serverRiskMode);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>(serverOrchestrationMode);
  const [contextUsage, setContextUsage] = useState<AgentContextUsageDto | null>(null);
  const [contextCompaction, setContextCompaction] = useState<AgentContextCompactionDto | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [editingQueueMessage, setEditingQueueMessage] = useState<RunningQueuedMessage | null>(null);
  const [nativeContextRefreshKey, setNativeContextRefreshKey] = useState(0);
  const pendingMessagesRef = useRef(new Map<string, string>());
  const modeRequestRef = useRef(0);

  const browserElements = useBrowserSelectionStore((state) => state.elements);
  const clearBrowserElements = useBrowserSelectionStore((state) => state.clearElements);
  const setBrowserElements = useBrowserSelectionStore((state) => state.setElements);
  const images = useComposerImageStore((state) => state.images);
  const addImages = useComposerImageStore((state) => state.addImages);
  const clearImages = useComposerImageStore((state) => state.clearImages);
  const orchestrationFeedback = useOrchestrationFeedbackStore((state) => state.drafts);
  const clearOrchestrationFeedback = useOrchestrationFeedbackStore((state) => state.clearDrafts);
  const setOrchestrationFeedback = useOrchestrationFeedbackStore((state) => state.setDrafts);
  const queuedMessages = useRunningMessageQueueStore((state) => flowId ? state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE : EMPTY_RUNNING_QUEUE);
  const updateFlowQueue = useRunningMessageQueueStore((state) => state.updateFlowQueue);
  const setFlowQueue = useRunningMessageQueueStore((state) => state.setFlowQueue);

  useEffect(() => {
    setBehaviorMode(serverBehaviorMode);
    setRiskMode(serverRiskMode);
    setOrchestrationMode(serverOrchestrationMode);
  }, [serverBehaviorMode, serverOrchestrationMode, serverRiskMode]);

  useEffect(() => {
    setOptimisticMessages([]);
    setLocalComposerValue("");
    setRuntimeError(null);
    setEditingQueueMessage(null);
    pendingMessagesRef.current.clear();
  }, [flowId]);

  useEffect(() => {
    if (!flowId) return;
    const unsubscribe = wsClient.onMessage((message: WsInMessage) => {
      if (message.flow_id && message.flow_id !== flowId) return;
      if (message.type === "flow:message_ack" || message.type === "flow:guide_ack") {
        if (message.log_id) {
          const pendingId = pendingMessagesRef.current.get(message.log_id);
          if (pendingId) {
            pendingMessagesRef.current.delete(message.log_id);
            setOptimisticMessages((items) => items.filter((item) => item.id !== pendingId));
          }
        }
        setFollowRequestKey((value) => value + 1);
        return;
      }
      if (message.type === "flow:queue_state") {
        setFlowQueue(flowId, Array.isArray(message.data.messages) ? message.data.messages as RunningQueuedMessage[] : []);
        return;
      }
      if (message.type === "flow:state") {
        setFlowQueue(flowId, Array.isArray(message.data?.queued_messages) ? message.data.queued_messages as RunningQueuedMessage[] : []);
        return;
      }
      if (message.type === "context_usage:event") {
        const usage = message.data as AgentContextUsageDto;
        if (usage.role === "leader") setContextUsage(usage);
        return;
      }
      if (message.type === "context_compaction:event") {
        const compaction = message.data as AgentContextCompactionDto;
        if (compaction.role !== "leader") return;
        setContextCompaction(compaction);
        setCompacting(compaction.status === "running");
        return;
      }
      if (message.type === "session:transcript_event") {
        setRuntimeError(null);
        setFollowRequestKey((value) => value + 1);
        return;
      }
      if (message.type === "system:error" && typeof message.data?.message === "string") {
        setRuntimeError(message.data.message);
        if (message.log_id) {
          const pendingId = pendingMessagesRef.current.get(message.log_id);
          if (pendingId) setOptimisticMessages((items) => items.filter((item) => item.id !== pendingId));
          pendingMessagesRef.current.delete(message.log_id);
        }
      }
    });
    return unsubscribe;
  }, [flowId, setFlowQueue]);

  useEffect(() => {
    let stale = false;
    if (!flowId || !leaderAgentRunId) {
      setContextUsage(null);
      setContextCompaction(null);
      return;
    }
    void fetchFlowContextState(flowId).then((state) => {
      if (stale) return;
      setContextUsage(state.context_usage?.leader ?? null);
      const current = state.context_compactions?.find((item) => item.role === "leader" && item.status === "running") ?? null;
      setContextCompaction(current);
      setCompacting(Boolean(current));
    }).catch(() => undefined);
    return () => { stale = true; };
  }, [flowId, leaderAgentRunId]);

  const updateModes = useCallback(async (next: { behaviorMode?: BehaviorMode; riskMode?: RiskMode; orchestrationMode?: OrchestrationMode }) => {
    if (!flowId) return;
    const requestId = ++modeRequestRef.current;
    const previous = { behaviorMode, riskMode, orchestrationMode };
    const target = {
      behaviorMode: next.behaviorMode ?? behaviorMode,
      riskMode: next.riskMode ?? riskMode,
      orchestrationMode: next.orchestrationMode ?? orchestrationMode,
    };
    setBehaviorMode(target.behaviorMode);
    setRiskMode(target.riskMode);
    setOrchestrationMode(target.orchestrationMode);
    setModeUpdating(true);
    try {
      const response = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behavior_mode: target.behaviorMode, risk_mode: target.riskMode, orchestration_mode: target.orchestrationMode }),
      });
      if (!response.ok) throw new Error("模式更新失败");
    } catch {
      if (modeRequestRef.current === requestId) {
        setBehaviorMode(previous.behaviorMode);
        setRiskMode(previous.riskMode);
        setOrchestrationMode(previous.orchestrationMode);
      }
    } finally {
      if (modeRequestRef.current === requestId) setModeUpdating(false);
    }
  }, [behaviorMode, flowId, orchestrationMode, riskMode]);

  const updateQueue = useCallback((updater: (items: RunningQueuedMessage[]) => RunningQueuedMessage[]) => {
    if (flowId) updateFlowQueue(flowId, updater);
  }, [flowId, updateFlowQueue]);

  const effectiveComposerValue = composerValue ?? localComposerValue;
  const setComposerValue = useCallback((value: string) => {
    onComposerValueChange?.(value);
    if (composerValue === undefined) setLocalComposerValue(value);
  }, [composerValue, onComposerValueChange]);

  const clearAttachments = useCallback(() => {
    if (browserElements.length) {
      clearBrowserElements();
      void getDesktopBrowserBridge()?.stopElementPicker();
    }
    if (images.length) clearImages();
    if (orchestrationFeedback.length) clearOrchestrationFeedback();
  }, [browserElements.length, clearBrowserElements, clearImages, clearOrchestrationFeedback, images.length, orchestrationFeedback.length]);

  const buildCurrentContent = useCallback((): MessageContent => ({
    browserElementAttachments: browserElements,
    imageAttachments: images,
    orchestrationFeedback,
  }), [browserElements, images, orchestrationFeedback]);

  const persistQueueItem = useCallback((text: string, content: MessageContent, existing?: RunningQueuedMessage | null) => {
    if (!flowId) return false;
    const attachments = outgoingAttachments(content);
    const visibleText = displayText(text, content);
    const message: RunningQueuedMessage = {
      id: existing?.id ?? `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: text,
      revision: existing?.revision ?? 1,
      ...(visibleText !== text ? { displayContent: visibleText } : {}),
      ...(content.browserElementAttachments?.length ? { browserElementAttachments: content.browserElementAttachments } : {}),
      ...(content.imageAttachments?.length ? { imageAttachments: content.imageAttachments } : {}),
      ...(content.orchestrationFeedback?.length ? { orchestrationFeedback: content.orchestrationFeedback } : {}),
    };
    updateQueue((items) => existing
      ? items.map((item) => item.id === existing.id ? { ...message, revision: (existing.revision ?? 1) + 1 } : item)
      : [...items, message]);
    wsClient.send({
      type: existing ? "flow:queue_edit" : "flow:queue_add",
      flow_id: flowId,
      queue_id: message.id,
      content: text,
      ...(message.displayContent ? { display_content: message.displayContent } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(content.orchestrationFeedback?.length ? { orchestration_feedback: orchestrationFeedbackPayload(content.orchestrationFeedback) } : {}),
      client_payload: queuePayload(message),
      ...(existing ? { expected_revision: existing.revision ?? 1 } : {}),
    });
    setEditingQueueMessage(null);
    return true;
  }, [flowId, updateQueue]);

  const sendMessage = useCallback((text: string, content: MessageContent) => {
    if (!flowId) return false;
    const attachments = outgoingAttachments(content);
    const clientMessageId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logId = wsClient.genLogId();
    setOptimisticMessages((items) => [...items, optimisticUserMessage(clientMessageId, text, content)]);
    pendingMessagesRef.current.set(logId, clientMessageId);
    wsClient.send({
      type: "flow:message",
      flow_id: flowId,
      content: text,
      ...(attachments.length ? { attachments } : {}),
      ...(content.orchestrationFeedback?.length ? { orchestration_feedback: orchestrationFeedbackPayload(content.orchestrationFeedback) } : {}),
      client_message_id: clientMessageId,
      log_id: logId,
    });
    setFollowRequestKey((value) => value + 1);
    return true;
  }, [flowId]);

  const handleComposerSend = useCallback(async (text: string) => {
    const content = buildCurrentContent();
    const hasContent = Boolean(text.trim() || content.browserElementAttachments?.length || content.imageAttachments?.length || content.orchestrationFeedback?.length);
    if (!hasContent || !leaderModelConfigured || runtimeSelectionUpdating) return false;
    const sent = editingQueueMessage
      ? persistQueueItem(text, content, editingQueueMessage)
      : activeLeaderAgentRunId
        ? persistQueueItem(text, content)
        : sendMessage(text, content);
    if (sent) clearAttachments();
    return sent;
  }, [activeLeaderAgentRunId, buildCurrentContent, clearAttachments, editingQueueMessage, leaderModelConfigured, persistQueueItem, runtimeSelectionUpdating, sendMessage]);

  const handlePasteImages = useCallback(async (files: File[], offset: number) => {
    const attachments = (await Promise.all(files.map((file) => imageAttachmentFromFile(file, offset))))
      .filter((item): item is MessageImageAttachment => item !== null);
    if (attachments.length) addImages(attachments);
  }, [addImages]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    if (!flowId || fromIndex === toIndex) return;
    const next = [...queuedMessages];
    const [item] = next.splice(fromIndex, 1);
    if (!item) return;
    next.splice(toIndex, 0, item);
    updateQueue(() => next);
    wsClient.send({ type: "flow:queue_reorder", flow_id: flowId, queue_ids: next.map((message) => message.id) });
  }, [flowId, queuedMessages, updateQueue]);

  const editQueueMessage = useCallback((message: RunningQueuedMessage) => {
    setEditingQueueMessage(message);
    setComposerValue(message.displayContent ?? message.content);
    if (message.browserElementAttachments?.length) {
      setBrowserElements(message.browserElementAttachments);
      void restoreBrowserAnnotations(message.browserElementAttachments);
    }
    if (message.imageAttachments?.length) addImages(message.imageAttachments);
    if (message.orchestrationFeedback?.length) setOrchestrationFeedback(message.orchestrationFeedback);
  }, [addImages, setBrowserElements, setComposerValue, setOrchestrationFeedback]);

  const deleteQueueMessage = useCallback((id: string) => {
    if (!flowId) return;
    updateQueue((items) => items.filter((item) => item.id !== id));
    wsClient.send({ type: "flow:queue_delete", flow_id: flowId, queue_id: id });
    if (editingQueueMessage?.id === id) setEditingQueueMessage(null);
  }, [editingQueueMessage?.id, flowId, updateQueue]);

  const guideQueueMessage = useCallback((message: RunningQueuedMessage) => {
    if (!flowId || !leaderModelConfigured) return;
    wsClient.send({
      type: activeLeaderAgentRunId ? "flow:queue_guide" : "flow:queue_dispatch",
      flow_id: flowId,
      queue_id: message.id,
      ...(activeLeaderAgentRunId ? { client_message_id: `guide-${Date.now()}` } : {}),
    });
  }, [activeLeaderAgentRunId, flowId, leaderModelConfigured]);

  const stopLeader = useCallback(() => {
    if (flowId && activeLeaderAgentRunId) wsClient.sendAgentRunCancel(flowId, activeLeaderAgentRunId, `leader-cancel-${Date.now()}`);
  }, [activeLeaderAgentRunId, flowId]);

  const handleCompact = useCallback(async () => {
    if (!flowId || activeLeaderAgentRunId || compacting) return;
    setCompacting(true);
    try {
      setContextUsage(await compactFlowContext(flowId));
    } finally {
      setCompacting(false);
    }
  }, [activeLeaderAgentRunId, compacting, flowId]);

  const pendingDecisionRequests = useMemo(() => decisionRequests.filter((request) => request.status === "pending"), [decisionRequests]);
  const transcriptOptimisticMessages = useMemo(() => [...initialOptimisticMessages, ...optimisticMessages], [initialOptimisticMessages, optimisticMessages]);
  const isCompact = composerVariant === "compactFloating";
  const isWaiting = Boolean(activeLeaderAgentRunId);
  const nativeContextSlashMenu = useNativeContextSlashMenu({ flowId, refreshKey: nativeContextRefreshKey });
  const composerDisabled = !flowId || !leaderModelConfigured || runtimeSelectionUpdating || pendingDecisionRequests.length > 0;
  const placeholder = editingQueueMessage
    ? "编辑这条排队消息…"
    : pendingDecisionRequests.length
      ? "请先处理待用户动作…"
      : !leaderModelConfigured
        ? "请先选择模型"
        : isWaiting
          ? "继续输入，消息会进入队列"
          : flowStatus === "idle" ? "输入消息开始新的讨论…" : "输入消息…";

  const composer = (
    <div data-testid="leader-chat-composer" className={isCompact ? "pointer-events-auto mx-auto w-full" : "pointer-events-none absolute inset-x-0 bottom-4 z-20"}>
      <div className={isCompact ? "mx-auto w-full" : "pointer-events-auto mx-auto w-[min(880px,calc(100%-128px))] max-w-full space-y-3 max-[760px]:w-[calc(100%-40px)]"}>
        {pendingDecisionRequests.length ? (
          <PendingDecisionRequestDock flowId={flowId} cards={pendingDecisionRequests} onStopCurrentTurn={activeLeaderAgentRunId ? stopLeader : undefined} />
        ) : (
          <>
            {queuedMessages.length ? (
              <RunningMessageQueue messages={queuedMessages} onReorder={reorderQueue} onEdit={editQueueMessage} onDelete={deleteQueueMessage} onGuide={guideQueueMessage} actionLabel={isWaiting ? "引导" : "发送给 Leader"} />
            ) : null}
            <PromptInput
              onSend={handleComposerSend}
              disabled={composerDisabled}
              allowEmptySend={Boolean(browserElements.length || images.length || orchestrationFeedback.length)}
              placeholder={placeholder}
              value={effectiveComposerValue}
              onValueChange={setComposerValue}
              onPasteImages={(files) => handlePasteImages(files, effectiveComposerValue.length)}
              slashMenu={nativeContextSlashMenu}
              attachmentSlot={<><MessageImageAttachments /><BrowserElementAttachments /><OrchestrationFeedbackAttachments /></>}
              toolbarSlot={(
                <ComposerModeMenu
                  behaviorMode={behaviorMode}
                  riskMode={riskMode}
                  orchestrationMode={orchestrationMode}
                  disabled={!flowId || modeUpdating}
                  onModeChange={(mode) => void updateModes(mode)}
                  onOrchestrationModeChange={(mode) => void updateModes({ orchestrationMode: mode })}
                  onAddImages={(files) => handlePasteImages(files, effectiveComposerValue.length)}
                />
              )}
              actionSlot={(
                <div className="flex items-center gap-1.5">
                  <ContextUsageIndicator usage={contextUsage} compacting={compacting || contextCompaction?.status === "running"} disabled={isWaiting} onCompact={handleCompact} />
                  <LeaderModelSelector
                    flowId={flowId}
                    onConfiguredChange={setLeaderModelConfigured}
                    onUpdatingChange={setRuntimeSelectionUpdating}
                    onSelectionChange={() => setNativeContextRefreshKey((value) => value + 1)}
                    onOpenModelSettings={onOpenModelSettings}
                    reasoningEffortDisabled={isWaiting}
                    className={isCompact ? "max-w-[280px]" : "max-w-[330px]"}
                  />
                </div>
              )}
              stopActive={Boolean(activeLeaderAgentRunId)}
              onStop={stopLeader}
              className={!isCompact ? "shadow-[var(--ui-shadow-elevated)]" : undefined}
            />
          </>
        )}
      </div>
    </div>
  );

  if (composerOnly) return composer;

  return (
    <div data-testid="leader-chat-panel" className="relative flex h-full flex-col">
      {runtimeError ? <div role="alert" className="mx-auto mt-3 w-[min(880px,calc(100%-128px))] rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">{runtimeError}</div> : null}
      <div data-testid="leader-chat-transcript-shell" className="relative min-h-0 flex-1">
        <SessionTranscriptPanel
          flowId={flowId}
          agentRunId={leaderAgentRunId}
          readonly={false}
          decisionRequests={decisionRequests}
          planCards={planCards}
          orchestrationPlans={orchestrationPlans}
          optimisticMessages={transcriptOptimisticMessages}
          followRequestKey={followRequestKey}
          isAwaitingResponse={isWaiting}
          allowInferredAgentRunId
          stableTranscriptChannel
          onOpenPlan={onOpenPlanPreview}
          onOpenOrchestration={onOpenPlan}
          onApproveOrchestration={(plan) => {
            if (!plan.approval || plan.approval.status !== "pending") return;
            wsClient.send({ type: "orchestration:resolve", flow_id: plan.flow_id, orchestration_approval_id: plan.approval.orchestration_approval_id, resolution: "approved", client_action_id: `orchestration-approve-${Date.now()}` });
          }}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          className="relative h-full overflow-y-hidden"
          bottomOverlayHeight={pendingDecisionRequests.length ? 0 : queuedMessages.length ? 296 : 132}
          emptyTitle="开始对话"
          emptyDescription="发送消息开始与 AI 助手对话"
          workspaceRootPath={workspaceRootPath}
        />
      </div>
      {composer}
    </div>
  );
}

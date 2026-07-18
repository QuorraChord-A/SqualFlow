import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  legacySessionRuntimeSdk,
  readDefaultFlowRuntimeConfigForSdk,
  readFlowLeaderRuntimeConfig,
  readRoleRuntimeConfig,
  readRuntimeConfig,
} from "../config/agentRuntimeConfig.js";
import {
  ClientWsMessageSchema,
  hasMessageImageData,
  ServerWsMessageSchema,
  type ClientWsMessage,
  type MessageImageAttachment,
  type ServerWsMessage,
} from "../protocol/wsMessages.js";
import type { Store } from "../db/store.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import { planRevisionView } from "../domain/orchestrationView.js";
import { publishUserTurnEvent } from "../domain/userTurn.js";
import { LeaderInputRejectedError, type LeaderRuntime } from "../runtime/leaderRuntime.js";
import { DECISION_CANCELLED_BODY } from "../runtime/leaderPrompt.js";
import type { ExpertRuntime } from "../runtime/expertRuntime.js";
import type { OrchestrationScheduler } from "../runtime/orchestrationScheduler.js";
import { captureUserTurnBaseline } from "../runtime/userTurnDiff.js";
import { createAgentRuntimeAdapter } from "../runtime/adapters/factory.js";
import type { ChatJournal, ChatUIMessage } from "../ws/chatJournal.js";
import type { EventBus } from "../ws/eventBus.js";
import { mergeTurnTimings, persistedTurnTimings } from "../ws/turnTiming.js";
import { runtimeSdkForPersistedAgentSession } from "./sessionRuntimeResolver.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";

export type SessionHistoryLoader = (sessionId: string) => Promise<ChatUIMessage[]>;

type SendServerMessage = (message: ServerWsMessage) => Promise<void> | void;

type WsConnection = {
  clientId: string;
  subscriptions: Set<string>;
  eventBus: EventBus;
  store: Store;
  chatJournal: ChatJournal;
  sessionHistoryLoader?: SessionHistoryLoader;
  leaderRuntime: LeaderRuntime;
  expertRuntime?: Pick<ExpertRuntime, "cancelUserTurn" | "resolvePermissionCard">;
  orchestrationScheduler: OrchestrationScheduler;
  send: SendServerMessage;
  logger?: OperationalLogger;
  runId?: string;
};

export type WsGatewayDeps = {
  eventBus: EventBus;
  chatJournal: ChatJournal;
  store: Store;
  leaderRuntime: LeaderRuntime;
  expertRuntime?: Pick<ExpertRuntime, "cancelUserTurn" | "resolvePermissionCard">;
  orchestrationScheduler: OrchestrationScheduler;
  sessionHistoryLoader?: SessionHistoryLoader;
  logger?: OperationalLogger;
  runId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type RuntimeAgentSession = NonNullable<ReturnType<Store["getAgentSession"]>>;

async function loadSessionHistory(
  connection: WsConnection,
  flowId: string,
  sessionId: string,
  agentSession?: RuntimeAgentSession | null,
  expertId?: string | null,
  runtimeConfigId?: string | null,
): Promise<ChatUIMessage[]> {
  if (connection.sessionHistoryLoader) return connection.sessionHistoryLoader(sessionId);
  const sdk = await runtimeSdkForPersistedAgentSession({
    store: connection.store,
    flowId,
    agentSession,
    expertId,
    sdkSessionId: sessionId,
  });
  const persistedRuntimeConfigId = runtimeConfigId ?? agentSession?.runtimeConfigId;
  const runtimeConfig = persistedRuntimeConfigId
    ? await readRuntimeConfig(persistedRuntimeConfigId)
    : null;
  const adapter = createAgentRuntimeAdapter({
    sdk,
    ...(runtimeConfig?.sdk === sdk ? { runtimeConfig } : {}),
  });
  if (!adapter.capabilities.historyRead) {
    throw new Error(`Session history is not supported by runtime SDK: ${sdk}`);
  }
  return adapter.loadSessionHistory(sessionId, flowId);
}

function runningJournalSnapshot(
  connection: WsConnection,
  flowId: string,
  sessionId: string,
  agentSession?: RuntimeAgentSession | null,
): { history: ChatUIMessage[] } | null {
  const localHistory = connection.chatJournal.getHistory(flowId, sessionId);
  const current = connection.chatJournal.getCurrentMessage(flowId, sessionId);
  const openUserTurn = connection.store.getOpenUserTurn(flowId);
  if (agentSession && ["completed", "failed"].includes(agentSession.status)) return null;
  const leaderTurnStarting = agentSession?.expertId === "exp-leader"
    && openUserTurn?.status === "active"
    && (agentSession.status === "idle" || agentSession.status === "queued");
  if (!current && agentSession?.status !== "streaming" && !leaderTurnStarting) return null;
  return {
    history: current
      ? mergeHistoryWithActiveTurn(
          localHistory,
          localHistory,
          current,
          openUserTurn?.triggerMessageId,
        )
      : localHistory,
  };
}

function rawToString(rawMessage: unknown): string {
  if (typeof rawMessage === "string") return rawMessage;
  if (Buffer.isBuffer(rawMessage)) return rawMessage.toString();
  if (rawMessage instanceof ArrayBuffer) return Buffer.from(rawMessage).toString();
  if (Array.isArray(rawMessage)) return Buffer.concat(rawMessage).toString();
  return String(rawMessage);
}

function unwrapPayload(raw: unknown): unknown {
  if (isRecord(raw) && isRecord(raw.data)) {
    return raw.data;
  }
  return raw;
}

function errorMessage(
  code: string,
  message: string,
  flowId?: string,
  logId?: string,
): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "system:error",
    ...(flowId ? { flow_id: flowId } : {}),
    ...(logId ? { log_id: logId } : {}),
    data: { code, message },
  });
}

async function publishPlanRunEvent(
  connection: WsConnection,
  run: NonNullable<ReturnType<Store["getPlanRun"]>>,
  logId?: string,
) {
  await connection.eventBus.publish(run.flowId, {
    type: "plan_run:event",
    flow_id: run.flowId,
    ...(logId ? { log_id: logId } : {}),
    data: {
      plan_run_id: run.id,
      plan_revision_id: run.planRevisionId,
      user_turn_id: run.userTurnId,
      status: run.status,
    },
  });
}

function flowStateData(flowId: string, store: Store) {
  const snapshot = buildFlowSnapshot(store, flowId);
  return "error" in snapshot
    ? {
        status: "ready",
        active_user_turn_id: null,
        user_turns: [],
        tasks: [],
        spec_revisions: [],
        agent_sessions: [],
        decision_cards: [],
        artifacts: [],
        recent_events: [],
      }
    : snapshot;
}

function flowStateMessage(flowId: string, store: Store, logId?: string): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "flow:state",
    flow_id: flowId,
    ...(logId ? { log_id: logId } : {}),
    data: flowStateData(flowId, store),
  });
}

function parseDecisionCards(flowId: string, store: Store) {
  return store.listDecisionCards(flowId).map((card) => {
    let questions: unknown[] = [];
    let answers: Record<string, string> | undefined;
    try {
      questions = JSON.parse(card.questions) as unknown[];
    } catch {
      questions = [];
    }
    if (card.answers) {
      try {
        answers = JSON.parse(card.answers) as Record<string, string>;
      } catch {
        answers = undefined;
      }
    }
    return {
      card_id: card.id,
      card_type: card.cardType,
      user_turn_id: card.userTurnId,
      questions,
      answers,
      status: card.status,
    };
  });
}

function textFromMessage(message: ChatUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function normalizeMessageText(message: ChatUIMessage): string {
  return textFromMessage(message).trim().replace(/\s+/g, " ");
}

function imageAttachmentMetadata(attachments: MessageImageAttachment[] | undefined): Record<string, unknown> | undefined {
  if (!attachments?.length) return undefined;
  const addedAt = Date.now();
  const browserElementAttachments = attachments.flatMap((attachment, index) => {
    if (attachment.kind !== "browser_comment") return [];
    const markerNumber = attachment.marker_number ?? index + 1;
    const label = attachment.label ?? `Comment ${markerNumber}`;
    return [{
      id: attachment.id,
      addedAt,
      tagName: "",
      text: label,
      selector: attachment.selector ?? "",
      role: "",
      ariaLabel: label,
      title: "",
      url: attachment.page_url ?? "",
      pageTitle: "",
      markerNumber,
      comment: attachment.comment ?? "",
      screenshotDataUrl: hasMessageImageData(attachment)
        ? `data:${attachment.media_type};base64,${attachment.data}`
        : "",
      viewport: { width: attachment.width ?? 0, height: attachment.height ?? 0 },
      rect: { x: 0, y: 0, width: 0, height: 0 },
      attributes: { id: "", className: "", href: "", name: "", type: "" },
    }];
  });
  const imageAttachments = attachments.flatMap((attachment) => {
    if (!hasMessageImageData(attachment)) return [];
    return [{
      id: attachment.id,
      kind: attachment.kind,
      mediaType: attachment.media_type,
      dataUrl: `data:${attachment.media_type};base64,${attachment.data}`,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(typeof attachment.width === "number" ? { width: attachment.width } : {}),
      ...(typeof attachment.height === "number" ? { height: attachment.height } : {}),
      ...(typeof attachment.marker_number === "number" ? { markerNumber: attachment.marker_number } : {}),
      ...(attachment.comment ? { comment: attachment.comment } : {}),
      ...(attachment.label ? { label: attachment.label } : {}),
      ...(attachment.page_url ? { pageUrl: attachment.page_url } : {}),
      ...(attachment.selector ? { selector: attachment.selector } : {}),
      ...(typeof attachment.text_offset === "number" ? { textOffset: attachment.text_offset } : {}),
      addedAt,
    }];
  });
  return {
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(browserElementAttachments.length > 0 ? { browserElementAttachments } : {}),
  };
}

function planFeedbackMetadata(feedback: Array<{ id: string; plan_revision_id: string; plan_node_id?: string | null; marker_number: number; comment: string }> | undefined) {
  return feedback?.length ? { planFeedback: feedback } : undefined;
}

function isSameUserTurn(left: ChatUIMessage, right: ChatUIMessage): boolean {
  if (left.role !== "user" || right.role !== "user") return false;
  const leftText = normalizeMessageText(left);
  const rightText = normalizeMessageText(right);
  if (leftText && rightText && (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText))) {
    return true;
  }

  const leftMetadata = isRecord(left.metadata) ? left.metadata : {};
  const rightMetadata = isRecord(right.metadata) ? right.metadata : {};
  const leftPlanFeedback = Array.isArray(leftMetadata.planFeedback) && leftMetadata.planFeedback.length > 0;
  const rightPlanFeedback = Array.isArray(rightMetadata.planFeedback) && rightMetadata.planFeedback.length > 0;
  if ((leftPlanFeedback && rightText === "计划评论") || (rightPlanFeedback && leftText === "计划评论")) {
    return true;
  }

  const browserCommentKey = (value: unknown) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!isRecord(item)) return [];
      return [JSON.stringify({
        markerNumber: item.markerNumber,
        comment: item.comment,
        label: item.label ?? item.ariaLabel,
        pageUrl: item.pageUrl ?? item.url,
        selector: item.selector,
      })];
    }).sort();
  };
  const leftBrowserComments = browserCommentKey(leftMetadata.browserElementAttachments);
  const rightBrowserComments = browserCommentKey(rightMetadata.browserElementAttachments);
  return leftBrowserComments.length > 0
    && leftBrowserComments.length === rightBrowserComments.length
    && leftBrowserComments.every((value, index) => value === rightBrowserComments[index]);
}

function toolCallIds(message: ChatUIMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of message.parts) {
    if (part.type.startsWith("tool-")) {
      const toolCallId = (part as { toolCallId?: string }).toolCallId;
      if (toolCallId) ids.add(toolCallId);
    }
  }
  return ids;
}

function isSameAssistantTurn(left: ChatUIMessage, right: ChatUIMessage): boolean {
  if (left.role !== "assistant" || right.role !== "assistant") return false;

  const leftTools = toolCallIds(left);
  const rightTools = toolCallIds(right);
  for (const toolCallId of leftTools) {
    if (rightTools.has(toolCallId)) return true;
  }

  const leftText = textFromMessage(left).trim();
  const rightText = textFromMessage(right).trim();
  return Boolean(leftText && rightText && (leftText.includes(rightText) || rightText.includes(leftText)));
}

function mergeHistoryWithCurrent(history: ChatUIMessage[], current: ChatUIMessage): ChatUIMessage[] {
  const completedHistory = history.filter((item) => item.id !== current.id);
  const last = completedHistory.at(-1);
  if (last && isSameAssistantTurn(last, current)) {
    return [...completedHistory.slice(0, -1), current];
  }
  return [...completedHistory, current];
}

function isCompletedHistoryComplete(history: ChatUIMessage[], localHistory: ChatUIMessage[]): boolean {
  const historyAssistantText = history
    .filter((message) => message.role === "assistant")
    .map(normalizeMessageText)
    .join("");

  return localHistory.every((localMessage) => {
    if (localMessage.role === "user") {
      return history.some((historyMessage) => isSameUserTurn(historyMessage, localMessage));
    }
    const localText = normalizeMessageText(localMessage);
    return !localText || historyAssistantText.includes(localText);
  });
}

function mergeHistoryWithActiveTurn(
  history: ChatUIMessage[],
  localHistory: ChatUIMessage[],
  current: ChatUIMessage,
  triggerMessageId?: string | null,
): ChatUIMessage[] {
  const exactStartIndex = triggerMessageId
    ? localHistory.findIndex((message) => message.id === triggerMessageId)
    : -1;
  const startIndex = exactStartIndex >= 0
    ? exactStartIndex
    : localHistory.findLastIndex((message) => message.role === "user");
  if (startIndex < 0) return mergeHistoryWithCurrent(history, current);

  const activeTail = localHistory.slice(startIndex);
  const activeUserMessage = activeTail[0];
  const persistedStartIndex = activeUserMessage?.role === "user"
    ? history.findLastIndex((message) => isSameUserTurn(message, activeUserMessage))
    : -1;
  const completedHistory = persistedStartIndex >= 0
    ? history.slice(0, persistedStartIndex)
    : history;
  return mergeHistoryWithCurrent([...completedHistory, ...activeTail], current);
}

type HistoryBoundary = {
  id: string;
  kind: "history_session_boundary";
  flow_expert_id: string;
  agent_session_id: string;
  display_name: string;
  started_at: string;
  status: "loaded" | "missing";
  before_message_id?: string;
};

type HistorySegment = {
  flowExpertId: string;
  agentSessionId: string;
  displayName: string;
  startedAt: string;
  status: "loaded" | "missing";
  messages: ChatUIMessage[];
};

function leaderSdkSessionIds(
  events: ReturnType<Store["listEventLog"]>,
  agentSessionId: string,
  currentSessionId: string,
): string[] {
  const sessionIds = new Set<string>();
  for (const event of events) {
    if (event.agentSessionId !== agentSessionId) continue;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(event.payloadJson) as unknown;
      payload = isRecord(parsed) ? parsed : null;
    } catch {
      payload = null;
    }
    const sessionId = event.eventType === "agent_session.turn_completed"
      ? optionalString(payload?.sdk_session_id)
      : undefined;
    if (sessionId) sessionIds.add(sessionId);
  }
  sessionIds.add(currentSessionId);
  return [...sessionIds];
}

function namespaceHistoricalMessages(messages: ChatUIMessage[], sessionId: string): ChatUIMessage[] {
  return messages.map((message) => ({
    ...message,
    id: `history-${sessionId}-${message.id}`,
  }));
}

function flattenFlowExpertHistorySegments(segments: HistorySegment[]) {
  const unique = new Map<string, ChatUIMessage>();
  const boundaries: HistoryBoundary[] = [];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]!;
    let firstMessageId: string | undefined;
    for (const historyMessage of segment.messages) {
      if (!unique.has(historyMessage.id)) {
        unique.set(historyMessage.id, historyMessage);
      }
      firstMessageId ??= historyMessage.id;
    }
    if (segmentIndex > 0) {
      boundaries.push({
        id: `history-boundary-${segment.agentSessionId}`,
        kind: "history_session_boundary",
        flow_expert_id: segment.flowExpertId,
        agent_session_id: segment.agentSessionId,
        display_name: segment.displayName,
        started_at: segment.startedAt,
        status: segment.status,
        ...(firstMessageId ? { before_message_id: firstMessageId } : {}),
      });
    }
  }

  const history = [...unique.values()];
  return { history, historyBoundaries: boundaries };
}

function sessionHistoryUnavailable(
  message: ClientWsMessage & { type: "session:get" },
  error: unknown,
): ServerWsMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return errorMessage(
    "SESSION_HISTORY_UNAVAILABLE",
    `Session history could not be loaded: ${detail}`,
    message.flow_id,
    message.log_id,
  );
}

function sessionHistoryIncomplete(
  message: ClientWsMessage & { type: "session:get" },
): ServerWsMessage {
  return errorMessage(
    "SESSION_HISTORY_INCOMPLETE",
    "Session history has not persisted the completed transcript yet",
    message.flow_id,
    message.log_id,
  );
}

async function sessionHistoryMessage(message: ClientWsMessage & { type: "session:get" }, connection: WsConnection): Promise<ServerWsMessage> {
  let flowExpert = message.flow_expert_id
    ? connection.store.getFlowExpert(message.flow_expert_id)
    : null;
  if (message.flow_expert_id && (!flowExpert || flowExpert.flowId !== message.flow_id)) {
    return errorMessage("invalid_flow_expert", "Flow Expert not found in this Flow", message.flow_id);
  }
  if (flowExpert) {
    connection.store.projectLegacyFlowExperts(message.flow_id);
    flowExpert = connection.store.getFlowExpert(flowExpert.id) ?? flowExpert;
  }

  const sessions = connection.store.listAgentSessions(message.flow_id);
  let agentSession = flowExpert
    ? sessions.find((session) =>
        session.flowExpertId === flowExpert.id && session.sessionId === flowExpert.sdkSessionId
      ) ?? sessions.filter((session) => session.flowExpertId === flowExpert.id).at(-1) ?? null
    : sessions.find((session) => {
        if (message.agent_session_id && session.id === message.agent_session_id) return true;
        if (message.session_id && session.sessionId === message.session_id) return true;
        return false;
      }) ?? sessions.find((session) => session.expertId === "exp-leader" && session.taskId === null);

  let sessionId = message.session_id
    || flowExpert?.sdkSessionId
    || agentSession?.sessionId
    || agentSession?.id
    || "";
  let history: ChatUIMessage[] = [];
  let historyBoundaries: HistoryBoundary[] = [];

  if (flowExpert) {
    const matchingSessions = sessions
      .filter((session) => session.flowExpertId === flowExpert!.id && session.sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const sessionsBySdkSessionId = new Map<string, typeof matchingSessions[number]>();
    for (const session of matchingSessions) {
      if (session.sessionId && !sessionsBySdkSessionId.has(session.sessionId)) {
        sessionsBySdkSessionId.set(session.sessionId, session);
      }
    }
    const uniqueSessions = [...sessionsBySdkSessionId.values()];
    const segments: HistorySegment[] = [];
    if (uniqueSessions.length === 0 && flowExpert.sdkSessionId) {
      const running = runningJournalSnapshot(connection, message.flow_id, flowExpert.sdkSessionId);
      if (running) {
        history = running.history;
      } else {
        const localHistory = connection.chatJournal.getHistory(message.flow_id, flowExpert.sdkSessionId);
        try {
          const loaded = await loadSessionHistory(
            connection,
            message.flow_id,
            flowExpert.sdkSessionId,
            null,
            flowExpert.expertId,
            flowExpert.runtimeConfigId,
          );
          const timings = persistedTurnTimings(connection.store.listEventLog(message.flow_id), flowExpert.sdkSessionId);
          const completedHistory = mergeTurnTimings(loaded, timings);
          if (!isCompletedHistoryComplete(completedHistory, localHistory)) {
            return sessionHistoryIncomplete(message);
          }
          history = completedHistory;
        } catch (error) {
          return sessionHistoryUnavailable(message, error);
        }
      }
    }
    for (const legacy of uniqueSessions) {
      const running = runningJournalSnapshot(connection, message.flow_id, legacy.sessionId!, legacy);
      try {
        let sessionHistory: ChatUIMessage[];
        if (running) {
          sessionHistory = running.history;
        } else {
          const localHistory = connection.chatJournal.getHistory(message.flow_id, legacy.sessionId!);
          const loaded = await loadSessionHistory(
            connection,
            message.flow_id,
            legacy.sessionId!,
            legacy,
            flowExpert.expertId,
            legacy.runtimeConfigId ?? flowExpert.runtimeConfigId,
          );
          const timings = persistedTurnTimings(connection.store.listEventLog(message.flow_id), legacy.sessionId!);
          sessionHistory = mergeTurnTimings(loaded, timings);
          if (!isCompletedHistoryComplete(sessionHistory, localHistory)) {
            return sessionHistoryIncomplete(message);
          }
        }
        segments.push({
          flowExpertId: flowExpert.id,
          agentSessionId: legacy.id,
          displayName: legacy.displayName,
          startedAt: legacy.createdAt,
          status: "loaded",
          messages: sessionHistory,
        });
      } catch (error) {
        return sessionHistoryUnavailable(message, error);
      }
    }
    const flattened = flattenFlowExpertHistorySegments(segments);
    if (segments.length > 0) history = flattened.history;
    historyBoundaries = flattened.historyBoundaries;
    agentSession = uniqueSessions.at(-1) ?? agentSession;
    sessionId = flowExpert.sdkSessionId ?? uniqueSessions.at(-1)?.sessionId ?? sessionId;
  } else if (sessionId) {
    const running = runningJournalSnapshot(connection, message.flow_id, sessionId, agentSession);
    if (running) {
      history = running.history;
    } else {
      const eventLog = connection.store.listEventLog(message.flow_id);
      const sessionIds = agentSession?.expertId === "exp-leader" && agentSession.taskId === null
        ? leaderSdkSessionIds(eventLog, agentSession.id, sessionId)
        : [sessionId];
      const historySegments: ChatUIMessage[][] = [];
      for (const historySessionId of sessionIds) {
        const localHistory = connection.chatJournal.getHistory(message.flow_id, historySessionId);
        let sessionHistory: ChatUIMessage[];
        try {
          sessionHistory = await loadSessionHistory(
            connection,
            message.flow_id,
            historySessionId,
            agentSession,
          );
        } catch (error) {
          return sessionHistoryUnavailable(message, error);
        }
        if (agentSession) {
          const timings = persistedTurnTimings(eventLog, historySessionId);
          sessionHistory = mergeTurnTimings(sessionHistory, timings);
        }
        if (!isCompletedHistoryComplete(sessionHistory, localHistory)) {
          return sessionHistoryIncomplete(message);
        }
        historySegments.push(
          historySessionId === sessionId
            ? sessionHistory
            : namespaceHistoricalMessages(sessionHistory, historySessionId),
        );
      }
      history = historySegments.flat();
    }
  }

  const journalCurrent = sessionId ? connection.chatJournal.getCurrentMessage(message.flow_id, sessionId) : null;
  const current = agentSession && ["completed", "failed", "interrupted"].includes(agentSession.status)
    ? null
    : journalCurrent;
  const decisionCards = parseDecisionCards(message.flow_id, connection.store);
  const pendingCards = decisionCards.filter((card) => card.status === "pending");

  return ServerWsMessageSchema.parse({
    type: "session:transcript_snapshot",
    flow_id: message.flow_id,
    session_id: sessionId,
    ...(flowExpert ? { flow_expert_id: flowExpert.id } : {}),
    ...(agentSession ? { agent_session_id: agentSession.id } : {}),
    data: {
      cursor: connection.chatJournal.getCursor(message.flow_id, flowExpert?.id ?? agentSession?.id ?? sessionId),
      messages: history,
      ...(historyBoundaries.length > 0 ? { history_boundaries: historyBoundaries } : {}),
      ...(current ? {
        active_turn: {
          message_id: current.id,
          started_at: current.metadata?.turnTiming?.startedAt ?? current.createdAt!,
        },
      } : {}),
    },
    pending_cards: pendingCards,
    decision_cards: decisionCards,
  });
}

function ensureLeaderSession(
  flowId: string,
  connection: WsConnection,
  options: { restartFailed?: boolean } = {},
) {
  const existing = connection.store
    .listAgentSessions(flowId)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  if (existing) {
    if (!options.restartFailed || existing.status !== "failed") return existing;

    const sessionId = randomUUID();
    const updatedSession = connection.store.updateAgentSessionSession(existing.id, sessionId);
    const restarted = connection.store.updateAgentSessionStatus(existing.id, "idle");
    if (!updatedSession || !restarted) {
      throw new Error(`Unable to restart failed Leader session for Flow ${flowId}`);
    }
    connection.store.updateFlow(flowId, { leaderSessionId: sessionId });
    return restarted;
  }

  const created = connection.store.createAgentSession({
    flowId,
    userTurnId: null,
    taskId: null,
    expertId: "exp-leader",
    sessionId: randomUUID(),
    displayName: "Leader",
  });
  if (!created) throw new Error(`Unable to create Leader session for Flow ${flowId}`);
  connection.store.updateFlow(flowId, { leaderSessionId: created.sessionId });
  return created;
}

function publishLeaderError(
  message: { flow_id: string; log_id?: string },
  connection: WsConnection,
  error: unknown,
) {
  return connection.eventBus.publish(
    message.flow_id,
    errorMessage(
      "leader_error",
      error instanceof Error ? error.message : String(error),
      message.flow_id,
      message.log_id,
    ),
  );
}

function missingProjectDirectoryError(flowId: string, store: Store): string | null {
  const flow = store.getFlow(flowId);
  if (!flow?.projectId) return null;
  const project = store.getProject(flow.projectId);
  if (!project?.localPath) return "Flow project is missing a local directory";
  try {
    if (fs.statSync(project.localPath).isDirectory()) return null;
  } catch {
    // Fall through to a clear user-facing error below.
  }
  return `Project directory does not exist: ${project.localPath}`;
}

async function missingLeaderModelError(flow: NonNullable<ReturnType<Store["getFlow"]>>): Promise<string | null> {
  const hasFlowRuntimeSelection = Boolean(flow.leaderRuntimeSdk || flow.leaderRuntimeConfigId || flow.leaderRuntimeModelId);
  const runtimeConfig = await readFlowLeaderRuntimeConfig({
    configId: flow.leaderRuntimeConfigId,
    modelId: flow.leaderRuntimeModelId,
    sdk: flow.leaderRuntimeSdk,
  });
  if (runtimeConfig) return null;
  if (hasFlowRuntimeSelection) return "Leader model is not configured";
  if (flow.leaderSessionId) {
    return await readDefaultFlowRuntimeConfigForSdk(legacySessionRuntimeSdk)
      ? null
      : "Leader model is not configured";
  }
  try {
    const roleRuntimeConfig = await readRoleRuntimeConfig("leader");
    return roleRuntimeConfig.config.models.some((model) => model.name.trim()) ? null : "Leader model is not configured";
  } catch {
    return "Leader model is not configured";
  }
}

async function handleFlowMessage(message: ClientWsMessage & { type: "flow:message" }, connection: WsConnection): Promise<void> {
  const flow = connection.store.getFlow(message.flow_id);
  if (!flow) {
    await connection.send(errorMessage("not_found", "Flow not found", message.flow_id, message.log_id));
    return;
  }

  const projectDirectoryError = missingProjectDirectoryError(message.flow_id, connection.store);
  if (projectDirectoryError) {
    await connection.send(errorMessage("PROJECT_DIRECTORY_MISSING", projectDirectoryError, message.flow_id, message.log_id));
    return;
  }
  const leaderModelError = await missingLeaderModelError(flow);
  if (leaderModelError) {
    await connection.send(errorMessage("LEADER_MODEL_NOT_CONFIGURED", leaderModelError, message.flow_id, message.log_id));
    return;
  }

  const hasPendingUserAction = connection.store.listDecisionCards(message.flow_id).some((card) => card.status === "pending")
    || connection.store.listSpecApprovals(message.flow_id).some((approval) => approval.status === "pending");
  if (hasPendingUserAction) {
    await connection.send(errorMessage(
      "PENDING_USER_ACTION",
      "Complete the pending card before sending another message.",
      message.flow_id,
      message.log_id,
    ));
    return;
  }

  if (connection.store.listDecisionCards(message.flow_id).some((card) => card.status === "pending")) {
    const error = new LeaderInputRejectedError();
    await connection.send(errorMessage(error.code, error.message, message.flow_id, message.log_id));
    return;
  }

  const openUserTurn = connection.store.getOpenUserTurn(message.flow_id);
  const leaderRunning = connection.store
    .listAgentSessions(message.flow_id)
    .some((session) => session.expertId === "exp-leader" && session.taskId === null && session.status === "streaming");
  if (openUserTurn && leaderRunning) {
    await connection.send(errorMessage(
      "ACTIVE_USER_TURN",
      "Leader is still working on the current turn. Queue the message locally or guide the running turn.",
      message.flow_id,
      message.log_id,
    ));
    return;
  }

  const failedLeaderSession = connection.store
    .listAgentSessions(message.flow_id)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null && session.status === "failed");
  const leader = ensureLeaderSession(message.flow_id, connection, { restartFailed: true });
  const messageId = message.client_message_id ?? `msg-user-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const pendingPlanApproval = connection.store.listPlanApprovals(message.flow_id).find((approval) => approval.status === "pending");
  const effectiveFeedback = message.plan_feedback?.length
    ? message.plan_feedback
    : pendingPlanApproval
      ? [{ id: `pf-local-${messageId}`, plan_revision_id: pendingPlanApproval.planRevisionId, plan_node_id: null, marker_number: 1, comment: message.content }]
      : [];
  const feedbackRevisionId = effectiveFeedback[0]?.plan_revision_id;
  if (feedbackRevisionId) {
    if (effectiveFeedback.some((feedback) => feedback.plan_revision_id !== feedbackRevisionId)) {
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "计划反馈必须指向当前等待审批的版本。", message.flow_id, message.log_id));
      return;
    }
    const revision = connection.store.getPlanRevision(feedbackRevisionId);
    const feedbackPlan = revision ? connection.store.getOrchestrationPlan(revision.planId) : undefined;
    if (!revision || !feedbackPlan || feedbackPlan.flowId !== message.flow_id) {
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "找不到评论引用的计划版本。", message.flow_id, message.log_id));
      return;
    }
    const planNodeIds = new Set(connection.store.listPlanNodes(feedbackRevisionId).map((node) => node.id));
    if (effectiveFeedback.some((feedback) => feedback.plan_node_id && !planNodeIds.has(feedback.plan_node_id))) {
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "计划反馈包含无效任务节点。", message.flow_id, message.log_id));
      return;
    }
    if (pendingPlanApproval?.planRevisionId === feedbackRevisionId) {
      const updated = connection.store.setPlanApprovalFeedbackPending({
        approvalId: pendingPlanApproval.id,
        sourceMessageId: messageId,
        feedback: effectiveFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      });
      if (!updated) {
        await connection.send(errorMessage("PLAN_APPROVAL_CONFLICT", "计划审批状态已变化，请刷新后重试。", message.flow_id, message.log_id));
        return;
      }
      await connection.eventBus.publish(message.flow_id, { type: "plan_approval:event", flow_id: message.flow_id, data: updated });
    } else {
      const recorded = connection.store.recordPlanFeedback({
        flowId: message.flow_id, userTurnId: feedbackPlan.userTurnId, planRevisionId: feedbackRevisionId, sourceMessageId: messageId,
        feedback: effectiveFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      });
      if (!recorded) {
        await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "只能评论当前运行中的计划版本。", message.flow_id, message.log_id));
        return;
      }
      const pausedRun = connection.store.getPlanRunForRevision(feedbackRevisionId);
      if (pausedRun?.status === "paused_for_feedback") await publishPlanRunEvent(connection, pausedRun, message.log_id);
    }
  }
  const userTurn = openUserTurn
    ? openUserTurn.status === "waiting_user"
      ? connection.store.resumeUserTurn(openUserTurn.id)
      : openUserTurn
    : connection.store.createUserTurn({
        flowId: message.flow_id,
        triggerMessageId: messageId,
        startedAt: createdAt,
        specRequested: message.spec_requested === true,
      });
  const transcriptMessage = connection.chatJournal.recordUserMessage(
    message.flow_id,
    leader.sessionId ?? leader.id,
    message.content,
    messageId,
    createdAt,
    leader.id,
    { ...imageAttachmentMetadata(message.attachments), ...planFeedbackMetadata(effectiveFeedback) },
  );
  await connection.eventBus.publish(message.flow_id, {
    type: "session:transcript_event",
    flow_id: message.flow_id,
    session_id: leader.sessionId ?? leader.id,
    agent_session_id: leader.id,
    flow_expert_id: leader.id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: { cursor: transcriptMessage.cursor, event: { type: "message-added", message: transcriptMessage.message } },
  });
  connection.store.appendEventLog({
    flowId: message.flow_id,
    userTurnId: userTurn?.id,
    agentSessionId: leader.id,
    eventType: "flow.user_message",
    payload: {
      message_id: messageId,
      user_turn_id: userTurn?.id ?? null,
      created_at: createdAt,
      client_message_id: message.client_message_id ?? null,
    },
  });

  await connection.send(ServerWsMessageSchema.parse({
    type: "flow:status",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      status: connection.store.getFlow(message.flow_id)?.status ?? flow.status,
      active_user_turn_id: connection.store.getOpenUserTurn(message.flow_id)?.id ?? null,
      leader_session_id: leader.sessionId,
      leader_agent_session_id: leader.id,
    },
  }));
  if (userTurn) {
    await publishUserTurnEvent(connection.eventBus, userTurn, message.log_id);
  }

  void connection.leaderRuntime.runLeaderTurn({
    flowId: message.flow_id,
    kind: "user",
    userMessage: message.content,
    attachments: message.attachments,
    planFeedback: effectiveFeedback,
    logId: message.log_id,
    userTurnId: userTurn?.id,
    leaderAgentSessionId: leader.id,
    leaderSessionId: leader.sessionId ?? leader.id,
    resumeSessionId: failedLeaderSession ? undefined : flow.leaderSessionId ?? undefined,
    currentTurnInput: {
      trigger_kind: "user_message",
      user_turn_id: userTurn?.id,
      message_id: messageId,
      content: message.content,
      spec_requested: message.spec_requested === true,
      created_at: createdAt,
    },
    specRequested: message.spec_requested === true,
  }).catch((error: unknown) => {
    if (error instanceof LeaderInputRejectedError) {
      return connection.send(errorMessage(error.code, error.message, message.flow_id, message.log_id));
    }
    return publishLeaderError(message, connection, error);
  });
}

async function handlePlanApprove(message: ClientWsMessage & { type: "flow:plan_approve" }, connection: WsConnection) {
  const approval = connection.store.getPlanApproval(message.plan_approval_id);
  if (!approval || approval.flowId !== message.flow_id) {
    await connection.send(errorMessage("INVALID_PLAN_APPROVAL", "找不到等待审批的编排计划。", message.flow_id, message.log_id));
    return;
  }
  const resolved = connection.store.resolvePlanApproval({ approvalId: approval.id, clientActionId: message.client_action_id });
  if (!resolved) {
    await connection.send(errorMessage("PLAN_APPROVAL_CONFLICT", "计划不是可批准状态，请刷新后重试。", message.flow_id, message.log_id));
    return;
  }
  await connection.eventBus.publish(message.flow_id, { type: "plan_approval:event", flow_id: message.flow_id, data: resolved });
  const revision = connection.store.getPlanRevision(resolved.planRevisionId);
  if (revision) await connection.eventBus.publish(message.flow_id, { type: "plan:event", flow_id: message.flow_id, data: planRevisionView(connection.store, revision.id) ?? { revision } });
  const turn = connection.store.getUserTurn(resolved.userTurnId);
  if (turn) await publishUserTurnEvent(connection.eventBus, turn, message.log_id);
  await connection.orchestrationScheduler.startRevision(resolved.planRevisionId);
}

async function handleFlowGuide(message: ClientWsMessage & { type: "flow:guide" }, connection: WsConnection): Promise<void> {
  const flow = connection.store.getFlow(message.flow_id);
  if (!flow) {
    await connection.send(errorMessage("not_found", "Flow not found", message.flow_id, message.log_id));
    return;
  }

  const leader = connection.store
    .listAgentSessions(message.flow_id)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  if (!leader) {
    await connection.send(errorMessage("LEADER_NOT_RUNNING", "Leader is not currently running", message.flow_id, message.log_id));
    return;
  }
  const leaderModelError = await missingLeaderModelError(flow);
  if (leaderModelError) {
    await connection.send(errorMessage("LEADER_MODEL_NOT_CONFIGURED", leaderModelError, message.flow_id, message.log_id));
    return;
  }

  const messageId = message.client_message_id ?? `msg-user-guided-${randomUUID()}`;
  try {
    const guideFeedback = message.plan_feedback ?? [];
    const feedbackRevisionId = guideFeedback[0]?.plan_revision_id;
    if (feedbackRevisionId) {
      if (guideFeedback.some((feedback) => feedback.plan_revision_id !== feedbackRevisionId)) throw new Error("计划反馈必须指向同一个计划版本");
      const revision = connection.store.getPlanRevision(feedbackRevisionId);
      const plan = revision ? connection.store.getOrchestrationPlan(revision.planId) : undefined;
      const turn = connection.store.getOpenUserTurn(message.flow_id);
      if (!plan || !turn || plan.flowId !== message.flow_id || plan.userTurnId !== turn.id) throw new Error("只能评论当前运行中的计划版本");
      const nodeIds = new Set(connection.store.listPlanNodes(feedbackRevisionId).map((node) => node.id));
      if (guideFeedback.some((feedback) => feedback.plan_node_id && !nodeIds.has(feedback.plan_node_id))) throw new Error("计划反馈包含无效任务节点");
      const recorded = connection.store.recordPlanFeedback({
        flowId: message.flow_id, userTurnId: turn.id, planRevisionId: feedbackRevisionId, sourceMessageId: messageId,
        feedback: guideFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      });
      if (!recorded) throw new Error("只能评论当前运行中的计划版本");
      const pausedRun = connection.store.getPlanRunForRevision(feedbackRevisionId);
      if (pausedRun?.status === "paused_for_feedback") await publishPlanRunEvent(connection, pausedRun, message.log_id);
    }
    const result = await connection.leaderRuntime.guideLeaderTurn({
      flowId: message.flow_id,
      content: message.content,
      planFeedback: guideFeedback,
      leaderAgentSessionId: leader.id,
      messageId,
      attachments: message.attachments,
    });
    const createdAt = new Date().toISOString();
    const transcriptMessage = connection.chatJournal.recordUserMessage(
      message.flow_id,
      leader.sessionId ?? leader.id,
      message.content,
      result.messageId,
      createdAt,
      leader.id,
      {
        localMessageKind: "running-guide",
        ...imageAttachmentMetadata(message.attachments),
        ...planFeedbackMetadata(guideFeedback),
      },
    );
    await connection.eventBus.publish(message.flow_id, {
      type: "session:transcript_event",
      flow_id: message.flow_id,
      session_id: leader.sessionId ?? leader.id,
      agent_session_id: leader.id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: { cursor: transcriptMessage.cursor, event: { type: "message-added", message: transcriptMessage.message } },
    });
    connection.store.appendEventLog({
      flowId: message.flow_id,
      userTurnId: connection.store.getOpenUserTurn(message.flow_id)?.id,
      agentSessionId: leader.id,
      eventType: "flow.guide_message",
      payload: {
        message_id: result.messageId,
        created_at: createdAt,
        client_message_id: message.client_message_id ?? null,
      },
    });
    await connection.send(ServerWsMessageSchema.parse({
      type: "flow:guide_ack",
      flow_id: message.flow_id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        accepted: true,
        message_id: result.messageId,
        client_message_id: message.client_message_id ?? null,
        leader_agent_session_id: leader.id,
      },
    }));
  } catch (error) {
    await connection.send(errorMessage(
      "LEADER_GUIDE_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
      message.flow_id,
      message.log_id,
    ));
  }
}

async function handleRunSpec(message: ClientWsMessage & { type: "flow:run_spec" }, connection: WsConnection): Promise<void> {
  const flow = connection.store.getFlow(message.flow_id);
  const approval = connection.store.getSpecApproval(message.spec_approval_id);
  if (!flow || !approval || approval.flowId !== message.flow_id || approval.status !== "pending") {
    await connection.send(errorMessage("INVALID_SPEC_APPROVAL", "Pending SpecApproval not found", message.flow_id, message.log_id));
    return;
  }
  const userTurn = approval.userTurnId ? connection.store.getUserTurn(approval.userTurnId) : undefined;
  if (!userTurn || userTurn.flowId !== message.flow_id || userTurn.status !== "waiting_user") {
    await connection.send(errorMessage("USER_TURN_NOT_ACTIVE", "SpecApproval is not attached to a waiting UserTurn", message.flow_id, message.log_id));
    return;
  }
  const spec = connection.store.getSpecRevision(approval.specRevisionId);
  if (!spec || spec.flowId !== message.flow_id || spec.status !== "draft") {
    await connection.send(errorMessage("INVALID_SPEC_REVISION", "Draft SpecRevision not found", message.flow_id, message.log_id));
    return;
  }

  const project = flow.projectId ? connection.store.getProject(flow.projectId) : undefined;
  if (!project?.localPath) {
    await connection.send(errorMessage("PROJECT_ROOT_NOT_FOUND", "Flow project root is not configured", message.flow_id, message.log_id));
    return;
  }
  const diffBaseline = captureUserTurnBaseline(project.localPath);
  const startedTurn = connection.store.runApprovedSpecForUserTurn({
    flowId: message.flow_id,
    specApprovalId: approval.id,
    specRevisionId: spec.id,
    targetProjectId: flow.projectId,
    inputSnapshotJson: JSON.stringify({
      type: "spec",
      spec_revision_id: spec.id,
      revision_number: spec.revisionNumber,
      file_name: spec.fileName,
      overview: spec.overview,
      content: spec.content,
      diff_baseline: diffBaseline,
    }),
  });
  if (!startedTurn) {
    await connection.send(errorMessage("USER_TURN_NOT_ACTIVE", "Spec could not start for the current UserTurn", message.flow_id, message.log_id));
    return;
  }
  await publishUserTurnEvent(connection.eventBus, startedTurn, message.log_id);

  await connection.eventBus.publish(message.flow_id, ServerWsMessageSchema.parse({
    type: "flow:spec_card_resolved",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      spec_approval_id: approval.id,
      spec_revision_id: spec.id,
      ...(approval.userTurnId ? { user_turn_id: approval.userTurnId } : {}),
      status: "approved",
    },
  }));
  await connection.eventBus.publish(message.flow_id, ServerWsMessageSchema.parse({
    type: "flow:status",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: { status: "active", active_user_turn_id: startedTurn.id },
  }));

  const existingLeaderSessionId = flow.leaderSessionId ?? "";
  const leader = ensureLeaderSession(message.flow_id, connection);
  void connection.leaderRuntime.runLeaderTurn({
    flowId: message.flow_id,
    userTurnId: startedTurn.id,
    kind: "spec_run",
    leaderAgentSessionId: leader.id,
    leaderSessionId: leader.sessionId ?? leader.id,
    resumeSessionId: existingLeaderSessionId || undefined,
    logId: message.log_id,
  }).catch((error: unknown) => publishLeaderError(message, connection, error));
}

function formatDecisionAgentInput(input: {
  answers?: Record<string, string | string[]>;
  cancelled: boolean;
}) {
  if (input.cancelled) return DECISION_CANCELLED_BODY;
  const rows = Object.entries(input.answers ?? {}).map(([question, answer]) => {
    const value = Array.isArray(answer) ? answer.join("、") : answer;
    return `${question}: ${value}`;
  });
  return rows.join("\n") || "用户已回答本次澄清卡片。";
}

export async function deliverDecisionCardLeaderInput(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn">;
  leaderInputId: string;
}) {
  const leaderInput = input.store.claimDecisionCardLeaderInput(input.leaderInputId);
  if (!leaderInput) return;
  const card = input.store.getDecisionCard(leaderInput.cardId);
  const flow = input.store.getFlow(leaderInput.flowId);
  const leader = input.store.listAgentSessions(leaderInput.flowId)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  if (!card || !flow || !leader) {
    input.store.markDecisionCardLeaderInputFailed(leaderInput.id, "missing card, flow, or leader session");
    return;
  }
  let decisionAnswers: Record<string, string | string[]> | undefined;
  if (leaderInput.kind === "resolved" && card.answers) {
    try {
      decisionAnswers = JSON.parse(card.answers) as Record<string, string | string[]>;
    } catch {
      decisionAnswers = undefined;
    }
  }
  try {
    await input.leaderRuntime.runLeaderTurn({
      flowId: leaderInput.flowId,
      userTurnId: card.userTurnId ?? undefined,
      kind: leaderInput.kind === "cancelled" ? "decision_cancelled" : "decision",
      decisionCardId: card.id,
      decisionMessageId: leaderInput.messageId,
      decisionUserMessage: leaderInput.content,
      ...(decisionAnswers ? { decisionAnswers } : {}),
      currentTurnInput: {
        trigger_kind: leaderInput.kind === "cancelled" ? "decision_cancelled" : "decision_resolved",
        user_turn_id: card.userTurnId ?? undefined,
        card_id: card.id,
        message_id: leaderInput.messageId,
        content: leaderInput.content,
        ...(decisionAnswers ? { answers: decisionAnswers } : {}),
        created_at: leaderInput.createdAt,
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? card.sessionId ?? leader.id,
      resumeSessionId: flow.leaderSessionId || undefined,
    });
    input.store.markDecisionCardLeaderInputSent(leaderInput.id);
  } catch (error) {
    input.store.markDecisionCardLeaderInputFailed(
      leaderInput.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function recoverPendingDecisionCardLeaderInputs(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn">;
  onError?: (error: unknown, inputId: string) => void;
}) {
  input.store.resetOrphanedDecisionCardLeaderInputs();
  const pendingInputs = input.store.listPendingDecisionCardLeaderInputs();
  let recovered = 0;
  let failed = 0;
  for (const pending of pendingInputs) {
    try {
      await deliverDecisionCardLeaderInput({
        store: input.store,
        leaderRuntime: input.leaderRuntime,
        leaderInputId: pending.id,
      });
      recovered += 1;
    } catch (error) {
      failed += 1;
      input.onError?.(error, pending.id);
    }
  }
  return { attempted: pendingInputs.length, recovered, failed };
}

async function handleDecision(message: ClientWsMessage & { type: "flow:decision" }, connection: WsConnection): Promise<void> {
  const card = connection.store.getDecisionCard(message.card_id);
  if (!card || card.flowId !== message.flow_id) {
    await connection.send(errorMessage("invalid_decision_card", "DecisionCard not found", message.flow_id, message.log_id));
    return;
  }
  if (card.cardType === "permission_confirmation") {
    const permissionRuntime = connection.expertRuntime;
    if (!permissionRuntime) {
      await connection.send(errorMessage("permission_runtime_unavailable", "Expert 权限确认通道不可用", message.flow_id, message.log_id));
      return;
    }
    const answerEntries = Object.entries(message.answers);
    const permissionAnswer = answerEntries.length === 1 && answerEntries[0]?.[0] === "permission"
      ? answerEntries[0][1]
      : null;
    const approved = typeof permissionAnswer === "string"
      && ["允许本次操作", "allow", "approved"].includes(permissionAnswer);
    const denied = typeof permissionAnswer === "string"
      && ["拒绝当前命令", "拒绝", "deny", "denied"].includes(permissionAnswer);
    if (!approved && !denied) {
      await connection.send(errorMessage(
        "invalid_permission_decision",
        "Permission decision must explicitly allow or deny the current command",
        message.flow_id,
        message.log_id,
      ));
      return;
    }
    const resolved = await permissionRuntime.resolvePermissionCard({
      flowId: message.flow_id,
      cardId: card.id,
      outcome: approved ? "approved" : "user_denied",
      ...(message.client_action_id ? { actionId: message.client_action_id } : {}),
    });
    if (!resolved) {
      await connection.send(errorMessage("invalid_permission_card", "Permission card not found or already resolved", message.flow_id, message.log_id));
    }
    return;
  }
  const decisionMessageId = `msg-decision-${randomUUID()}`;
  const actionId = message.client_action_id ?? card.resolutionActionId ?? decisionMessageId;
  const resolution = connection.store.resolveDecisionCard({
    cardId: card.id,
    flowId: message.flow_id,
    answers: message.answers,
    actionId,
    messageId: decisionMessageId,
    leaderInputContent: formatDecisionAgentInput({
      answers: message.answers,
      cancelled: false,
    }),
  });
  if (!resolution) {
    await connection.send(errorMessage("invalid_decision_card", "DecisionCard not found or already resolved", message.flow_id, message.log_id));
    return;
  }

  const resolved = resolution.card;
  const leader = ensureLeaderSession(message.flow_id, connection);
  const resolvedAnswers = resolved.answers
    ? JSON.parse(resolved.answers) as Record<string, string | string[]>
    : {};
  if (resolution.newlyResolved) {
    const turn = resolved.userTurnId
      ? connection.store.resumeUserTurn(resolved.userTurnId)
      : connection.store.getOpenUserTurn(message.flow_id);
    if (turn) await publishUserTurnEvent(connection.eventBus, turn, message.log_id);
    connection.store.appendEventLog({
      flowId: message.flow_id,
      userTurnId: resolved.userTurnId,
      agentSessionId: leader.id,
      eventType: "decision_card.resolved",
      payload: {
        card_id: resolved.id,
        message_id: resolution.leaderInput.messageId,
        action_id: actionId,
        status: resolved.status,
        created_at: resolution.leaderInput.createdAt,
      },
    });
  }

  await connection.send(ServerWsMessageSchema.parse({
    type: "flow:decision_card_resolved",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      card_id: resolved.id,
      card_type: resolved.cardType,
      user_turn_id: resolved.userTurnId,
      answers: resolvedAnswers,
      status: resolved.status,
      message_id: resolution.leaderInput.messageId,
      leader_agent_session_id: leader.id,
    },
  }));

  if (resolution.leaderInput.status !== "sent") {
    void deliverDecisionCardLeaderInput({
      store: connection.store,
      leaderRuntime: connection.leaderRuntime,
      leaderInputId: resolution.leaderInput.id,
    }).catch((error: unknown) => publishLeaderError(message, connection, error));
  }
}

async function handleDecisionCancel(
  message: ClientWsMessage & { type: "flow:decision_cancel" },
  connection: WsConnection,
): Promise<void> {
  const card = connection.store.getDecisionCard(message.card_id);
  if (!card || card.flowId !== message.flow_id) {
    await connection.send(errorMessage("invalid_decision_card", "DecisionCard not found", message.flow_id, message.log_id));
    return;
  }
  if (card.cardType === "permission_confirmation") {
    const permissionRuntime = connection.expertRuntime;
    if (!permissionRuntime) {
      await connection.send(errorMessage("permission_runtime_unavailable", "Expert 权限确认通道不可用", message.flow_id, message.log_id));
      return;
    }
    const resolved = await permissionRuntime.resolvePermissionCard({
      flowId: message.flow_id,
      cardId: card.id,
      outcome: "card_cancelled",
      ...(message.client_action_id ? { actionId: message.client_action_id } : {}),
    });
    if (!resolved) {
      await connection.send(errorMessage("invalid_permission_card", "Permission card not found or already resolved", message.flow_id, message.log_id));
    }
    return;
  }
  const messageId = `msg-decision-${randomUUID()}`;
  const actionId = message.client_action_id ?? card.resolutionActionId ?? messageId;
  const resolution = connection.store.cancelDecisionCard({
    cardId: card.id,
    flowId: message.flow_id,
    actionId,
    messageId,
    leaderInputContent: formatDecisionAgentInput({ cancelled: true }),
  });
  if (!resolution) {
    await connection.send(errorMessage("invalid_decision_card", "DecisionCard not found or already resolved", message.flow_id, message.log_id));
    return;
  }

  const cancelled = resolution.card;
  ensureLeaderSession(message.flow_id, connection);
  if (resolution.newlyResolved) {
    const turn = cancelled.userTurnId
      ? connection.store.resumeUserTurn(cancelled.userTurnId)
      : connection.store.getOpenUserTurn(message.flow_id);
    if (turn) await publishUserTurnEvent(connection.eventBus, turn, message.log_id);
    connection.store.appendEventLog({
      flowId: message.flow_id,
      userTurnId: cancelled.userTurnId,
      eventType: "decision_card.cancelled",
      payload: {
        card_id: cancelled.id,
        message_id: resolution.leaderInput.messageId,
        action_id: actionId,
        status: cancelled.status,
        created_at: resolution.leaderInput.createdAt,
      },
    });
  }
  await connection.send(ServerWsMessageSchema.parse({
    type: "flow:decision_card_resolved",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      card_id: cancelled.id,
      card_type: cancelled.cardType,
      user_turn_id: cancelled.userTurnId,
      answers: null,
      status: cancelled.status,
      message_id: resolution.leaderInput.messageId,
    },
  }));
  if (resolution.leaderInput.status !== "sent") {
    void deliverDecisionCardLeaderInput({
      store: connection.store,
      leaderRuntime: connection.leaderRuntime,
      leaderInputId: resolution.leaderInput.id,
    }).catch((error: unknown) => publishLeaderError(message, connection, error));
  }
}

async function publishInterruptedSessions(
  connection: WsConnection,
  flowId: string,
  logId: string | undefined,
  userTurnId: string,
) {
  const sessions = connection.store.listAgentSessions(flowId)
    .filter((session) => session.status === "queued" || session.status === "streaming")
    .filter((session) => session.userTurnId === userTurnId
      || (session.expertId === "exp-leader" && session.taskId === null));

  for (const session of sessions) {
    const updated = connection.store.updateAgentSessionStatus(session.id, "interrupted");
    if (!updated) continue;
    await connection.eventBus.publish(flowId, ServerWsMessageSchema.parse({
      type: "session:event",
      flow_id: flowId,
      ...(logId ? { log_id: logId } : {}),
      data: {
        agent_session_id: updated.id,
        user_turn_id: updated.userTurnId,
        task_id: updated.taskId,
        expert_id: updated.expertId,
        flow_expert_id: updated.flowExpertId,
        status: updated.status,
      },
    }));
    if (!updated.flowExpertId) continue;
    const flowExpert = connection.store.updateFlowExpertStatus(updated.flowExpertId, "idle");
    if (!flowExpert) continue;
    await connection.eventBus.publish(flowId, ServerWsMessageSchema.parse({
      type: "flow_expert:event",
      flow_id: flowId,
      ...(logId ? { log_id: logId } : {}),
      data: {
        event: "updated",
        flow_expert_id: flowExpert.id,
        agent_session_id: updated.id,
        expert_id: flowExpert.expertId,
        display_name: flowExpert.displayName,
        status: flowExpert.status,
      },
    }));
  }
}

async function cancelUserTurnState(
  connection: WsConnection,
  turn: NonNullable<ReturnType<Store["getUserTurn"]>>,
  logId?: string,
) {
  const pendingPlanApprovals = connection.store.listPlanApprovals(turn.flowId)
    .filter((approval) => approval.userTurnId === turn.id && ["pending", "feedback_pending"].includes(approval.status));
  const activePlanRuns = connection.store.listPlanRuns(turn.flowId)
    .filter((run) => run.userTurnId === turn.id && ["running", "blocked", "paused_for_feedback"].includes(run.status));
  connection.leaderRuntime.cancelFlow(turn.flowId, turn.id);
  connection.expertRuntime?.cancelUserTurn({ flowId: turn.flowId, userTurnId: turn.id });
  for (const task of connection.store.listUserTurnTasks(turn.id)) {
    const cancelledTask = connection.store.cancelTask(task.id);
    if (!cancelledTask) continue;
    await connection.eventBus.publish(turn.flowId, ServerWsMessageSchema.parse({
      type: "task:event",
      flow_id: turn.flowId,
      ...(logId ? { log_id: logId } : {}),
      data: {
        task_id: cancelledTask.id,
        user_turn_id: cancelledTask.userTurnId,
        expert_id: cancelledTask.expertId,
        flow_expert_id: cancelledTask.flowExpertId,
        agent_session_id: cancelledTask.agentSessionId,
        status: cancelledTask.status,
      },
    }));
  }
  await publishInterruptedSessions(connection, turn.flowId, logId, turn.id);
  connection.store.cancelUserTurnPendingActions(turn.id);
  for (const approval of pendingPlanApprovals) {
    const updated = connection.store.getPlanApproval(approval.id);
    if (!updated) continue;
    await connection.eventBus.publish(turn.flowId, {
      type: "plan_approval:event",
      flow_id: turn.flowId,
      ...(logId ? { log_id: logId } : {}),
      data: updated,
    });
  }
  for (const run of activePlanRuns) {
    const updated = connection.store.getPlanRun(run.id);
    if (!updated) continue;
    await connection.eventBus.publish(turn.flowId, {
      type: "plan_run:event",
      flow_id: turn.flowId,
      ...(logId ? { log_id: logId } : {}),
      data: {
        plan_run_id: updated.id,
        plan_revision_id: updated.planRevisionId,
        user_turn_id: updated.userTurnId,
        status: updated.status,
      },
    });
  }
  const cancelled = connection.store.failUserTurn(turn.id, "cancelled");
  if (!cancelled) return turn;
  connection.store.appendEventLog({
    flowId: turn.flowId,
    userTurnId: turn.id,
    eventType: "user_turn.cancelled",
  });
  await publishUserTurnEvent(connection.eventBus, cancelled, logId);
  return cancelled;
}

async function handleUserTurnCancel(
  connection: WsConnection,
  message: ClientWsMessage & { type: "user_turn:cancel" },
) {
  const turn = connection.store.getUserTurn(message.user_turn_id);
  if (!turn || turn.flowId !== message.flow_id) {
    await connection.send(errorMessage("USER_TURN_NOT_ACTIVE", "UserTurn not found in this Flow", message.flow_id, message.log_id));
    return;
  }
  if (["completed", "failed", "cancelled"].includes(turn.status)) {
    await publishUserTurnEvent(connection.eventBus, turn, message.log_id);
    return;
  }
  if (connection.store.getOpenUserTurn(message.flow_id)?.id !== turn.id) {
    await connection.send(errorMessage("USER_TURN_NOT_ACTIVE", "UserTurn is not the current open turn", message.flow_id, message.log_id));
    return;
  }
  await cancelUserTurnState(connection, turn, message.log_id);
}

function parseClientMessage(rawMessage: unknown):
  | { ok: true; message: ClientWsMessage }
  | { ok: false; flowId?: string; logId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawToString(rawMessage));
  } catch {
    return { ok: false };
  }

  const payload = unwrapPayload(parsed);
  const flowId = isRecord(payload) ? optionalString(payload.flow_id) : undefined;
  const logId = isRecord(payload) ? optionalString(payload.log_id) : undefined;
  const result = ClientWsMessageSchema.safeParse(payload);

  if (!result.success) {
    return { ok: false, flowId, logId };
  }

  return { ok: true, message: result.data };
}

export async function handleWsClientMessage(rawMessage: unknown, connection: WsConnection): Promise<void> {
  const parsed = parseClientMessage(rawMessage);

  if (!parsed.ok) {
    await connection.send(errorMessage("invalid_message", "Invalid websocket message", parsed.flowId, parsed.logId));
    return;
  }

  const message = parsed.message;
  switch (message.type) {
    case "flow:subscribe": {
      const startedAt = Date.now();
      connection.logger?.info({
        event: "flow_subscription_requested",
        runId: connection.runId,
        clientId: connection.clientId,
        flowId: message.flow_id,
        logId: message.log_id ?? null,
      }, "Flow subscription requested");
      connection.subscriptions.add(message.flow_id);
      connection.eventBus.subscribe(message.flow_id, connection.clientId, connection.send);
      await connection.send(flowStateMessage(message.flow_id, connection.store, message.log_id));
      connection.logger?.info({
        event: "flow_snapshot_sent",
        runId: connection.runId,
        clientId: connection.clientId,
        flowId: message.flow_id,
        logId: message.log_id ?? null,
        durationMs: Date.now() - startedAt,
      }, "Flow snapshot sent");
      return;
    }
    case "flow:unsubscribe":
      connection.subscriptions.delete(message.flow_id);
      connection.eventBus.unsubscribe(message.flow_id, connection.clientId);
      return;
    case "session:get": {
      const startedAt = Date.now();
      connection.logger?.info({
        event: "session_history_requested",
        runId: connection.runId,
        clientId: connection.clientId,
        flowId: message.flow_id,
        flowExpertId: message.flow_expert_id ?? null,
        agentSessionId: message.agent_session_id ?? null,
        requestedSdkSessionId: message.session_id || null,
        logId: message.log_id ?? null,
      }, "Session history requested");
      const response = await sessionHistoryMessage(message, connection);
      if (response.type === "system:error") {
        connection.logger?.warn({
          event: "session_history_failed",
          runId: connection.runId,
          clientId: connection.clientId,
          flowId: message.flow_id,
          flowExpertId: message.flow_expert_id ?? null,
          agentSessionId: message.agent_session_id ?? null,
          requestedSdkSessionId: message.session_id || null,
          logId: message.log_id ?? null,
          errorCode: response.data.code,
          durationMs: Date.now() - startedAt,
        }, "Session history failed");
      } else if (response.type === "session:transcript_snapshot") {
        connection.logger?.info({
          event: "session_history_loaded",
          runId: connection.runId,
          clientId: connection.clientId,
          flowId: message.flow_id,
          flowExpertId: response.flow_expert_id ?? null,
          agentSessionId: response.agent_session_id ?? null,
          sdkSessionId: response.session_id ?? null,
          logId: message.log_id ?? null,
          messageCount: response.data.messages.length,
          durationMs: Date.now() - startedAt,
        }, "Session history loaded");
      }
      await connection.send(response);
      return;
    }
    case "client:diagnostic": {
      const fields = {
        event: message.event,
        runId: connection.runId,
        clientId: connection.clientId,
        flowId: message.flow_id,
        durationMs: message.duration_ms ?? null,
        errorCode: message.error_code ?? null,
        leaderAgentSessionId: message.leader_agent_session_id ?? null,
        logId: message.log_id ?? null,
      };
      if (message.event === "flow_switch_failed") connection.logger?.warn(fields, "Frontend Flow switch failed");
      else connection.logger?.info(fields, "Frontend Flow switch diagnostic");
      return;
    }
    case "flow:message":
      await handleFlowMessage(message, connection);
      return;
    case "flow:guide":
      await handleFlowGuide(message, connection);
      return;
    case "flow:decision":
      await handleDecision(message, connection);
      return;
    case "flow:decision_cancel":
      await handleDecisionCancel(message, connection);
      return;
    case "flow:run_spec":
      await handleRunSpec(message, connection);
      return;
    case "flow:plan_approve":
      await handlePlanApprove(message, connection);
      return;
    case "user_turn:cancel":
      await handleUserTurnCancel(connection, message);
      return;
  }
}

export function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps): void {
  app.get("/api/ws", { websocket: true }, (socket) => {
    const clientId = randomUUID();
    const subscriptions = new Set<string>();
    const send: SendServerMessage = (message) => {
      socket.send(JSON.stringify(ServerWsMessageSchema.parse(message)));
    };

    socket.on("message", (rawMessage: unknown) => {
      void handleWsClientMessage(rawMessage, {
        clientId,
        subscriptions,
        eventBus: deps.eventBus,
        store: deps.store,
        chatJournal: deps.chatJournal,
        sessionHistoryLoader: deps.sessionHistoryLoader,
        leaderRuntime: deps.leaderRuntime,
        expertRuntime: deps.expertRuntime,
        orchestrationScheduler: deps.orchestrationScheduler,
        logger: deps.logger,
        runId: deps.runId,
        send,
      }).catch(() => {
        send(errorMessage("internal_error", "Websocket message handling failed"));
      });
    });

    socket.on("close", () => {
      for (const flowId of subscriptions) {
        deps.eventBus.unsubscribe(flowId, clientId);
      }
      subscriptions.clear();
    });
  });
}

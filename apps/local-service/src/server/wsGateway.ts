import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  legacySessionRuntimeSdk,
  readDefaultFlowRuntimeConfigForSdk,
  readFlowLeaderRuntimeConfig,
  readRoleRuntimeConfig,
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
import { LeaderSessionRecoveryError } from "../runtime/adapters/runtimeErrors.js";
import { DECISION_CANCELLED_BODY } from "../runtime/leaderPrompt.js";
import type { ExpertRuntime } from "../runtime/expertRuntime.js";
import type { OrchestrationScheduler } from "../runtime/orchestrationScheduler.js";
import { captureUserTurnBaseline } from "../runtime/userTurnDiff.js";
import type { ChatJournal, ChatUIMessage } from "../ws/chatJournal.js";
import type { EventBus } from "../ws/eventBus.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";
import { logWsWire } from "../observability/wsWireLog.js";

type SendServerMessage = (message: ServerWsMessage) => Promise<void> | void;

export type WsConnection = {
  clientId: string;
  subscriptions: Set<string>;
  eventBus: EventBus;
  store: Store;
  chatJournal: ChatJournal;
  leaderRuntime: LeaderRuntime;
  expertRuntime?: Pick<ExpertRuntime, "cancelUserTurn" | "resolvePermissionCard">;
  orchestrationScheduler: OrchestrationScheduler;
  send: SendServerMessage;
  logger?: OperationalLogger;
  runId?: string;
  requestQueueDrain?: (flowId: string) => void;
};

export type WsGatewayDeps = {
  eventBus: EventBus;
  chatJournal: ChatJournal;
  store: Store;
  leaderRuntime: LeaderRuntime;
  expertRuntime?: Pick<ExpertRuntime, "cancelUserTurn" | "resolvePermissionCard">;
  orchestrationScheduler: OrchestrationScheduler;
  logger?: OperationalLogger;
  runId?: string;
  requestQueueDrain?: (flowId: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function submissionPayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableJsonValue(payload))).digest("hex");
}

function flowMessageSubmissionPayload(message: ClientWsMessage & { type: "flow:message" }): Record<string, unknown> {
  return {
    content: message.content,
    spec_requested: message.spec_requested === true,
    attachments: message.attachments ?? [],
    plan_feedback: message.plan_feedback ?? [],
  };
}

function guideSubmissionPayload(message: ClientWsMessage & { type: "flow:guide" }): Record<string, unknown> {
  return {
    content: message.content,
    attachments: message.attachments ?? [],
    plan_feedback: message.plan_feedback ?? [],
  };
}

type RuntimeAgentSession = NonNullable<ReturnType<Store["getAgentSession"]>>;

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
  details?: Record<string, unknown>,
): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "system:error",
    ...(flowId ? { flow_id: flowId } : {}),
    ...(logId ? { log_id: logId } : {}),
    data: { code, message, ...(details ?? {}) },
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
  const state = "error" in snapshot
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
  return {
    ...state,
    queued_messages: queueStateData(flowId, store),
  };
}

function flowStateMessage(flowId: string, store: Store, logId?: string): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "flow:state",
    flow_id: flowId,
    ...(logId ? { log_id: logId } : {}),
    data: flowStateData(flowId, store),
  });
}

function queueClientPayload(itemPayload: Record<string, unknown>): Record<string, unknown> {
  const clientPayload = isRecord(itemPayload.client_payload) ? itemPayload.client_payload : {};
  const attachments = Array.isArray(itemPayload.attachments)
    ? itemPayload.attachments.filter(isRecord)
    : [];
  const attachmentsById = new Map(attachments.flatMap((attachment) =>
    typeof attachment.id === "string" ? [[attachment.id, attachment] as const] : []
  ));
  const restoreDataUrl = (value: unknown, field: "dataUrl" | "screenshotDataUrl") => {
    if (!Array.isArray(value)) return undefined;
    return value.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== "string") return candidate;
      if (typeof candidate[field] === "string") return candidate;
      const attachment = attachmentsById.get(candidate.id);
      if (typeof attachment?.media_type !== "string" || typeof attachment.data !== "string") return candidate;
      return { ...candidate, [field]: `data:${attachment.media_type};base64,${attachment.data}` };
    });
  };
  const imageAttachments = restoreDataUrl(clientPayload.imageAttachments, "dataUrl");
  const browserElementAttachments = restoreDataUrl(clientPayload.browserElementAttachments, "screenshotDataUrl");
  return {
    ...clientPayload,
    ...(imageAttachments ? { imageAttachments } : {}),
    ...(browserElementAttachments ? { browserElementAttachments } : {}),
  };
}

function queueStateData(flowId: string, store: Store) {
  return store.listQueuedMessages(flowId).map((item) => {
    const clientPayload = queueClientPayload(item.payload);
    return {
      ...clientPayload,
      id: item.id,
      content: typeof item.payload.content === "string" ? item.payload.content : "",
      ...(typeof item.payload.display_content === "string"
        ? { displayContent: item.payload.display_content }
        : {}),
      ...(item.payload.spec_requested === true ? { specRequested: true } : {}),
      status: item.status,
      revision: item.revision,
    };
  });
}

function queueStateMessage(flowId: string, store: Store, logId?: string): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "flow:queue_state",
    flow_id: flowId,
    ...(logId ? { log_id: logId } : {}),
    data: { messages: queueStateData(flowId, store) },
  });
}

async function publishQueueState(connection: WsConnection, flowId: string, logId?: string) {
  const message = queueStateMessage(flowId, connection.store, logId);
  if (connection.subscriptions.has(flowId)) {
    await connection.eventBus.publish(flowId, message);
  } else {
    await connection.send(message);
  }
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

function transcriptCommitMetadata(result: {
  removedMessageIds?: string[];
  activeTurn?: { messageId: string; rootMessageId: string; segmentIndex: number; startedAt: string };
}) {
  return {
    ...(result.removedMessageIds?.length ? { removed_message_ids: result.removedMessageIds } : {}),
    ...(result.activeTurn ? {
      active_turn: {
        message_id: result.activeTurn.messageId,
        root_message_id: result.activeTurn.rootMessageId,
        segment_index: result.activeTurn.segmentIndex,
        started_at: result.activeTurn.startedAt,
      },
    } : {}),
  };
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

  const sessionId = message.session_id
    || flowExpert?.sdkSessionId
    || agentSession?.sessionId
    || agentSession?.id
    || "";
  const channelId = flowExpert?.id ?? agentSession?.id ?? message.agent_session_id ?? sessionId;
  const entries = channelId
    ? connection.chatJournal.getTranscriptEntries(message.flow_id, channelId)
    : [];
  const history = entries.map((entry) => entry.message as unknown as ChatUIMessage);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const historyBoundaries: HistoryBoundary[] = [];
  if (flowExpert) {
    let previousAgentSessionId: string | null = null;
    for (const entry of entries) {
      if (!entry.agentSessionId || entry.agentSessionId === previousAgentSessionId) continue;
      if (previousAgentSessionId !== null) {
        const boundarySession = sessionsById.get(entry.agentSessionId);
        historyBoundaries.push({
          id: `history-boundary-${entry.agentSessionId}`,
          kind: "history_session_boundary",
          flow_expert_id: flowExpert.id,
          agent_session_id: entry.agentSessionId,
          display_name: boundarySession?.displayName ?? flowExpert.displayName,
          started_at: boundarySession?.createdAt ?? entry.createdAt,
          status: "loaded",
          before_message_id: entry.messageId,
        });
      }
      previousAgentSessionId = entry.agentSessionId;
    }
  }

  const journalActiveTurn = sessionId ? connection.chatJournal.getActiveTurn(message.flow_id, sessionId) : null;
  const activeTurn = agentSession && ["completed", "failed", "interrupted"].includes(agentSession.status)
    ? null
    : journalActiveTurn;
  const decisionCards = parseDecisionCards(message.flow_id, connection.store);
  const pendingCards = decisionCards.filter((card) => card.status === "pending");

  return ServerWsMessageSchema.parse({
    type: "session:transcript_snapshot",
    flow_id: message.flow_id,
    session_id: sessionId,
    ...(flowExpert ? { flow_expert_id: flowExpert.id } : {}),
    ...(agentSession ? { agent_session_id: agentSession.id } : {}),
    data: {
      stream_epoch: connection.chatJournal.getStreamEpoch(),
      cursor: connection.chatJournal.getCursor(message.flow_id, flowExpert?.id ?? agentSession?.id ?? sessionId),
      messages: history,
      ...(historyBoundaries.length > 0 ? { history_boundaries: historyBoundaries } : {}),
      ...(activeTurn ? {
        active_turn: {
          message_id: activeTurn.message.id,
          root_message_id: activeTurn.rootMessageId,
          segment_index: activeTurn.segmentIndex,
          started_at: activeTurn.message.metadata?.turnTiming?.startedAt ?? activeTurn.message.createdAt!,
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
) {
  const existing = connection.store
    .listAgentSessions(flowId)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  if (existing) return existing;

  const created = connection.store.createAgentSession({
    flowId,
    userTurnId: null,
    taskId: null,
    expertId: "exp-leader",
    sessionId: null,
    displayName: "Leader",
  });
  if (!created) throw new Error(`Unable to create Leader session for Flow ${flowId}`);
  // Use the local AgentSession ID as a transcript channel until the provider
  // returns a real SDK session ID. It is never sent as a provider resume ID.
  connection.store.updateFlow(flowId, { leaderSessionId: created.id });
  return created;
}

function leaderProviderResumeSessionId(
  flow: NonNullable<ReturnType<Store["getFlow"]>>,
  leader: RuntimeAgentSession,
): string | undefined {
  // A newly-created local AgentSession uses its own ID as the transcript
  // channel until the provider returns an SDK session ID. Never send that
  // local ID to a provider's resume endpoint.
  if (!leader.sessionId || flow.leaderSessionId === leader.id) return undefined;
  return flow.leaderSessionId ?? undefined;
}

function publishLeaderError(
  message: { flow_id: string; log_id?: string },
  connection: WsConnection,
  error: unknown,
) {
  if (error instanceof LeaderSessionRecoveryError) {
    return connection.eventBus.publish(
      message.flow_id,
      errorMessage(
        error.code,
        error.message,
        message.flow_id,
        message.log_id,
        {
          category: error.category,
          provider: error.provider,
          session_id: error.sessionId,
          provider_code: error.providerCode,
        },
      ),
    );
  }
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

async function handleFlowMessage(
  message: ClientWsMessage & { type: "flow:message" },
  connection: WsConnection,
  onMaterialized?: (messageId: string) => void,
): Promise<boolean> {
  const flow = connection.store.getFlow(message.flow_id);
  if (!flow) {
    await connection.send(errorMessage("not_found", "Flow not found", message.flow_id, message.log_id));
    return false;
  }

  const projectDirectoryError = missingProjectDirectoryError(message.flow_id, connection.store);
  if (projectDirectoryError) {
    await connection.send(errorMessage("PROJECT_DIRECTORY_MISSING", projectDirectoryError, message.flow_id, message.log_id));
    return false;
  }
  const leaderModelError = await missingLeaderModelError(flow);
  if (leaderModelError) {
    await connection.send(errorMessage("LEADER_MODEL_NOT_CONFIGURED", leaderModelError, message.flow_id, message.log_id));
    return false;
  }

  const messageId = message.client_message_id ?? `msg-user-${randomUUID()}`;
  const submissionPayload = flowMessageSubmissionPayload(message);
  const payloadHash = submissionPayloadHash(submissionPayload);
  const existingLeader = connection.store
    .listAgentSessions(message.flow_id)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  const existingSubmission = connection.store.getSubmission(message.flow_id, messageId);
  if (existingSubmission && (
    existingSubmission.submissionType !== "normal"
    || existingSubmission.payloadHash !== payloadHash
  )) {
    await connection.send(errorMessage(
      "MESSAGE_ID_CONFLICT",
      "The same client message id was already used with different content.",
      message.flow_id,
      message.log_id,
    ));
    return false;
  }
  if (existingSubmission?.receiptState === "materialized") {
    onMaterialized?.(existingSubmission.messageId ?? messageId);
    await connection.send(ServerWsMessageSchema.parse({
      type: "flow:message_ack",
      flow_id: message.flow_id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        accepted: true,
        message_id: existingSubmission.messageId ?? messageId,
        client_message_id: message.client_message_id ?? messageId,
        leader_agent_session_id: existingLeader?.id,
      },
    }));
    return true;
  }
  if (existingSubmission && ["dispatching", "uncertain", "rejected", "cancelled"].includes(existingSubmission.receiptState)) {
    await connection.send(errorMessage(
      existingSubmission.receiptState === "dispatching" ? "MESSAGE_ALREADY_DISPATCHING" : "MESSAGE_NOT_RETRYABLE",
      existingSubmission.receiptState === "dispatching"
        ? "This message is already being dispatched."
        : "This message was already resolved and cannot be submitted again with the same id.",
      message.flow_id,
      message.log_id,
    ));
    return false;
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
    return false;
  }

  if (connection.store.listDecisionCards(message.flow_id).some((card) => card.status === "pending")) {
    const error = new LeaderInputRejectedError();
    await connection.send(errorMessage(error.code, error.message, message.flow_id, message.log_id));
    return false;
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
    return false;
  }

  const leader = ensureLeaderSession(message.flow_id, connection);
  const acceptance = existingSubmission
    ? { outcome: "duplicate" as const, submission: existingSubmission }
    : connection.store.acceptSubmission({
        flowId: message.flow_id,
        clientMessageId: messageId,
        submissionType: "normal",
        payloadHash,
        payload: submissionPayload,
      });
  if (acceptance.outcome === "conflict") {
    await connection.send(errorMessage("MESSAGE_ID_CONFLICT", "Message id conflicts with an existing submission.", message.flow_id, message.log_id));
    return false;
  }
  if (!connection.store.claimSubmission(message.flow_id, messageId)) {
    const current = connection.store.getSubmission(message.flow_id, messageId);
    if (current?.receiptState === "materialized") {
      onMaterialized?.(current.messageId ?? messageId);
      await connection.send(ServerWsMessageSchema.parse({
        type: "flow:message_ack",
        flow_id: message.flow_id,
        ...(message.log_id ? { log_id: message.log_id } : {}),
        data: {
          accepted: true,
          message_id: current.messageId ?? messageId,
          client_message_id: message.client_message_id ?? messageId,
          leader_agent_session_id: leader.id,
        },
      }));
      return true;
    }
    await connection.send(errorMessage("MESSAGE_ALREADY_DISPATCHING", "This message is already being dispatched.", message.flow_id, message.log_id));
    return false;
  }
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
      connection.store.releaseSubmission(message.flow_id, messageId);
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "计划反馈必须指向当前等待审批的版本。", message.flow_id, message.log_id));
      return false;
    }
    const revision = connection.store.getPlanRevision(feedbackRevisionId);
    const feedbackPlan = revision ? connection.store.getOrchestrationPlan(revision.planId) : undefined;
    if (!revision || !feedbackPlan || feedbackPlan.flowId !== message.flow_id) {
      connection.store.releaseSubmission(message.flow_id, messageId);
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "找不到评论引用的计划版本。", message.flow_id, message.log_id));
      return false;
    }
    const planNodeIds = new Set(connection.store.listPlanNodes(feedbackRevisionId).map((node) => node.id));
    if (effectiveFeedback.some((feedback) => feedback.plan_node_id && !planNodeIds.has(feedback.plan_node_id))) {
      connection.store.releaseSubmission(message.flow_id, messageId);
      await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "计划反馈包含无效任务节点。", message.flow_id, message.log_id));
      return false;
    }
    if (pendingPlanApproval?.planRevisionId === feedbackRevisionId) {
      const updated = connection.store.setPlanApprovalFeedbackPending({
        approvalId: pendingPlanApproval.id,
        sourceMessageId: messageId,
        feedback: effectiveFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      });
      if (!updated) {
        connection.store.releaseSubmission(message.flow_id, messageId);
        await connection.send(errorMessage("PLAN_APPROVAL_CONFLICT", "计划审批状态已变化，请刷新后重试。", message.flow_id, message.log_id));
        return false;
      }
      await connection.eventBus.publish(message.flow_id, { type: "plan_approval:event", flow_id: message.flow_id, data: updated });
    } else {
      const recorded = connection.store.recordPlanFeedback({
        flowId: message.flow_id, userTurnId: feedbackPlan.userTurnId, planRevisionId: feedbackRevisionId, sourceMessageId: messageId,
        feedback: effectiveFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      });
      if (!recorded) {
        connection.store.releaseSubmission(message.flow_id, messageId);
        await connection.send(errorMessage("INVALID_PLAN_FEEDBACK", "只能评论当前运行中的计划版本。", message.flow_id, message.log_id));
        return false;
      }
      const pausedRun = connection.store.getPlanRunForRevision(feedbackRevisionId);
      if (pausedRun?.status === "paused_for_feedback") await publishPlanRunEvent(connection, pausedRun);
    }
  }
  let userTurn: ReturnType<Store["createUserTurn"]> | undefined;
  let transcriptMessage: ReturnType<ChatJournal["recordUserMessage"]>;
  try {
    connection.store.sqlite.transaction(() => {
      userTurn = openUserTurn
        ? openUserTurn.status === "waiting_user"
          ? connection.store.resumeUserTurn(openUserTurn.id)
          : openUserTurn
        : connection.store.createUserTurn({
            flowId: message.flow_id,
            triggerMessageId: messageId,
            startedAt: createdAt,
            specRequested: message.spec_requested === true,
          });
      onMaterialized?.(messageId);
      connection.store.markSubmissionMaterialized(message.flow_id, messageId, messageId);
      transcriptMessage = connection.chatJournal.recordUserMessage(
        message.flow_id,
        leader.sessionId ?? leader.id,
        message.content,
        messageId,
        createdAt,
        leader.id,
        { ...imageAttachmentMetadata(message.attachments), ...planFeedbackMetadata(effectiveFeedback) },
      );
    })();
  } catch (error) {
    connection.chatJournal.clear(message.flow_id, leader.sessionId ?? leader.id);
    connection.store.releaseSubmission(message.flow_id, messageId);
    throw error;
  }
  await connection.eventBus.publish(message.flow_id, {
    type: "session:transcript_event",
    flow_id: message.flow_id,
    session_id: leader.sessionId ?? leader.id,
    agent_session_id: leader.id,
    flow_expert_id: leader.id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      stream_epoch: connection.chatJournal.getStreamEpoch(),
      cursor: transcriptMessage!.cursor,
      event: { type: "message-added", message: transcriptMessage!.message },
      ...transcriptCommitMetadata(transcriptMessage!),
    },
  });
  await connection.send(ServerWsMessageSchema.parse({
    type: "flow:message_ack",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: {
      accepted: true,
      message_id: messageId,
      client_message_id: message.client_message_id ?? null,
      leader_agent_session_id: leader.id,
    },
  }));
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
    // Once the provider has returned a real session ID, every subsequent turn
    // must resume it. A local AgentSession without a provider ID has no session
    // to resume yet, so only that first call is allowed to start one.
    resumeSessionId: leaderProviderResumeSessionId(flow, leader),
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
  return true;
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
  const run = await connection.orchestrationScheduler.startRevision(resolved.planRevisionId);
  // L2: 派发权归 Leader — 物化后唤醒 Leader 按依赖逐节点派发，服务端不再自动派发。
  const leader = connection.store
    .listAgentSessions(message.flow_id)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  const flow = connection.store.getFlow(message.flow_id);
  if (!run || !leader || !flow) return;
  void connection.leaderRuntime.runLeaderTurn({
    flowId: message.flow_id,
    kind: "plan_approved",
    userTurnId: resolved.userTurnId,
    planApprovedTasks: planApprovedTaskList(connection.store, run.id),
    leaderAgentSessionId: leader.id,
    leaderSessionId: leader.sessionId ?? leader.id,
    resumeSessionId: leaderProviderResumeSessionId(flow, leader),
  }).catch((error: unknown) => publishLeaderError(message, connection, error));
}

function planApprovedTaskList(store: Store, planRunId: string) {
  return store.listPlanNodeTasks(planRunId).flatMap((mapping) => {
    const task = store.getTask(mapping.taskId);
    if (!task || task.status === "completed") return [];
    return [{
      taskId: task.id,
      title: task.title,
      expertId: task.expertId ?? "",
      dependsOnTaskIds: store.listTaskDependencies(task.id),
    }];
  });
}

async function handleFlowGuide(
  message: ClientWsMessage & { type: "flow:guide" },
  connection: WsConnection,
  onMaterialized?: (messageId: string) => void,
): Promise<boolean> {
  const flow = connection.store.getFlow(message.flow_id);
  if (!flow) {
    await connection.send(errorMessage("not_found", "Flow not found", message.flow_id, message.log_id));
    return false;
  }

  const leader = connection.store
    .listAgentSessions(message.flow_id)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  if (!leader) {
    await connection.send(errorMessage("LEADER_NOT_RUNNING", "Leader is not currently running", message.flow_id, message.log_id));
    return false;
  }
  const leaderModelError = await missingLeaderModelError(flow);
  if (leaderModelError) {
    await connection.send(errorMessage("LEADER_MODEL_NOT_CONFIGURED", leaderModelError, message.flow_id, message.log_id));
    return false;
  }

  const messageId = message.client_message_id ?? `msg-user-guided-${randomUUID()}`;
  const submissionPayload = guideSubmissionPayload(message);
  const payloadHash = submissionPayloadHash(submissionPayload);
  const existingSubmission = connection.store.getSubmission(message.flow_id, messageId);
  if (existingSubmission && (
    existingSubmission.submissionType !== "guide"
    || existingSubmission.payloadHash !== payloadHash
  )) {
    await connection.send(errorMessage(
      "MESSAGE_ID_CONFLICT",
      "The same Guide id was already used with different content.",
      message.flow_id,
      message.log_id,
    ));
    return false;
  }
  if (existingSubmission?.receiptState === "materialized") {
    onMaterialized?.(existingSubmission.messageId ?? messageId);
    await connection.send(ServerWsMessageSchema.parse({
      type: "flow:guide_ack",
      flow_id: message.flow_id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        accepted: true,
        message_id: existingSubmission.messageId ?? messageId,
        client_message_id: message.client_message_id ?? messageId,
        leader_agent_session_id: leader.id,
      },
    }));
    return true;
  }
  if (existingSubmission && ["dispatching", "uncertain", "rejected", "cancelled"].includes(existingSubmission.receiptState)) {
    await connection.send(errorMessage(
      existingSubmission.receiptState === "dispatching" ? "GUIDE_ALREADY_DISPATCHING" : "GUIDE_NOT_RETRYABLE",
      existingSubmission.receiptState === "dispatching"
        ? "This Guide is already being delivered."
        : "This Guide cannot be delivered again with the same id.",
      message.flow_id,
      message.log_id,
    ));
    return false;
  }
  const acceptance = existingSubmission
    ? { outcome: "duplicate" as const, submission: existingSubmission }
    : connection.store.acceptSubmission({
        flowId: message.flow_id,
        clientMessageId: messageId,
        submissionType: "guide",
        payloadHash,
        payload: submissionPayload,
      });
  if (acceptance.outcome === "conflict" || !connection.store.claimSubmission(message.flow_id, messageId)) {
    await connection.send(errorMessage("GUIDE_ALREADY_DISPATCHING", "This Guide is already being delivered.", message.flow_id, message.log_id));
    return false;
  }
  try {
    const guideFeedback = message.plan_feedback ?? [];
    const feedbackRevisionId = guideFeedback[0]?.plan_revision_id;
    let feedbackInput: Parameters<Store["recordPlanFeedback"]>[0] | undefined;
    if (feedbackRevisionId) {
      if (guideFeedback.some((feedback) => feedback.plan_revision_id !== feedbackRevisionId)) throw new Error("计划反馈必须指向同一个计划版本");
      const revision = connection.store.getPlanRevision(feedbackRevisionId);
      const plan = revision ? connection.store.getOrchestrationPlan(revision.planId) : undefined;
      const turn = connection.store.getOpenUserTurn(message.flow_id);
      if (!plan || !turn || plan.flowId !== message.flow_id || plan.userTurnId !== turn.id) throw new Error("只能评论当前运行中的计划版本");
      const nodeIds = new Set(connection.store.listPlanNodes(feedbackRevisionId).map((node) => node.id));
      if (guideFeedback.some((feedback) => feedback.plan_node_id && !nodeIds.has(feedback.plan_node_id))) throw new Error("计划反馈包含无效任务节点");
      feedbackInput = {
        flowId: message.flow_id, userTurnId: turn.id, planRevisionId: feedbackRevisionId, sourceMessageId: messageId,
        feedback: guideFeedback.map((feedback) => ({ planNodeId: feedback.plan_node_id, markerNumber: feedback.marker_number, comment: feedback.comment })),
      };
    }
    const createdAt = new Date().toISOString();
    let transcriptMessage: ReturnType<ChatJournal["recordUserMessage"]> | undefined;
    await connection.leaderRuntime.guideLeaderTurn({
      flowId: message.flow_id,
      content: message.content,
      planFeedback: guideFeedback,
      leaderAgentSessionId: leader.id,
      messageId,
      attachments: message.attachments,
      beforeDeliver: () => {
        connection.store.sqlite.transaction(() => {
          if (feedbackInput && !connection.store.recordPlanFeedback(feedbackInput)) {
            throw new Error("只能评论当前运行中的计划版本");
          }
          onMaterialized?.(messageId);
          connection.store.markSubmissionMaterialized(message.flow_id, messageId, messageId);
          transcriptMessage = connection.chatJournal.recordUserMessage(
            message.flow_id,
            leader.sessionId ?? leader.id,
            message.content,
            messageId,
            createdAt,
            leader.id,
            {
              localMessageKind: "running-guide",
              guideStatusLabel: "已引导对话",
              ...imageAttachmentMetadata(message.attachments),
              ...planFeedbackMetadata(guideFeedback),
            },
          );
        })();
      },
    });
    if (!transcriptMessage) throw new Error("Leader runtime did not commit Guide delivery");
    if (feedbackRevisionId) {
      const pausedRun = connection.store.getPlanRunForRevision(feedbackRevisionId);
      if (pausedRun?.status === "paused_for_feedback") await publishPlanRunEvent(connection, pausedRun, message.log_id);
    }
    await connection.eventBus.publish(message.flow_id, {
      type: "session:transcript_event",
      flow_id: message.flow_id,
      session_id: leader.sessionId ?? leader.id,
      agent_session_id: leader.id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        stream_epoch: connection.chatJournal.getStreamEpoch(),
        cursor: transcriptMessage.cursor,
        event: { type: "message-added", message: transcriptMessage.message },
        ...transcriptCommitMetadata(transcriptMessage),
      },
    });
    connection.store.appendEventLog({
      flowId: message.flow_id,
      userTurnId: connection.store.getOpenUserTurn(message.flow_id)?.id,
      agentSessionId: leader.id,
      eventType: "flow.guide_message",
      payload: {
        message_id: messageId,
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
        message_id: messageId,
        client_message_id: message.client_message_id ?? null,
        leader_agent_session_id: leader.id,
      },
    }));
    return true;
  } catch (error) {
    connection.store.markSubmissionRejected(message.flow_id, messageId, "LEADER_GUIDE_UNAVAILABLE");
    await connection.send(errorMessage(
      "LEADER_GUIDE_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
      message.flow_id,
      message.log_id,
    ));
    return false;
  }
}

async function handleQueueAdd(
  message: ClientWsMessage & { type: "flow:queue_add" },
  connection: WsConnection,
) {
  if (!connection.store.getFlow(message.flow_id)) {
    await connection.send(errorMessage("not_found", "Flow not found", message.flow_id, message.log_id));
    return;
  }
  const payload = {
    content: message.content,
    ...(message.display_content !== undefined ? { display_content: message.display_content } : {}),
    ...(message.spec_requested ? { spec_requested: true } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.plan_feedback?.length ? { plan_feedback: message.plan_feedback } : {}),
    ...(message.client_payload ? { client_payload: message.client_payload } : {}),
  };
  const result = connection.store.addQueuedMessage({
    id: message.queue_id,
    flowId: message.flow_id,
    payloadHash: submissionPayloadHash({
      content: message.content,
      spec_requested: message.spec_requested === true,
      attachments: message.attachments ?? [],
      plan_feedback: message.plan_feedback ?? [],
    }),
    payload,
  });
  if (result.acceptance.outcome === "conflict") {
    await connection.send(errorMessage(
      "MESSAGE_ID_CONFLICT",
      "The same queued message id was already used with different content.",
      message.flow_id,
      message.log_id,
    ));
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  await publishQueueState(connection, message.flow_id, message.log_id);
  connection.requestQueueDrain?.(message.flow_id);
}

async function handleQueueDelete(
  message: ClientWsMessage & { type: "flow:queue_delete" },
  connection: WsConnection,
) {
  connection.store.deleteQueuedMessage(message.flow_id, message.queue_id);
  await publishQueueState(connection, message.flow_id, message.log_id);
}

async function handleQueueReorder(
  message: ClientWsMessage & { type: "flow:queue_reorder" },
  connection: WsConnection,
) {
  if (!connection.store.reorderQueuedMessages(message.flow_id, message.queue_ids)) {
    await connection.send(errorMessage(
      "QUEUE_REVISION_CONFLICT",
      "The queued message list changed. Refresh and try again.",
      message.flow_id,
      message.log_id,
    ));
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  await publishQueueState(connection, message.flow_id, message.log_id);
}

function queuedFlowMessage(
  flowId: string,
  queueId: string,
  payload: Record<string, unknown>,
  logId?: string,
): ClientWsMessage & { type: "flow:message" } {
  const parsed = ClientWsMessageSchema.parse({
    type: "flow:message",
    flow_id: flowId,
    content: typeof payload.content === "string" ? payload.content : "",
    ...(payload.spec_requested === true ? { spec_requested: true } : {}),
    ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments } : {}),
    ...(Array.isArray(payload.plan_feedback) ? { plan_feedback: payload.plan_feedback } : {}),
    client_message_id: queueId,
    ...(logId ? { log_id: logId } : {}),
  });
  if (parsed.type !== "flow:message") throw new Error("Invalid queued flow message");
  return parsed;
}

function queuedGuideMessage(
  flowId: string,
  clientMessageId: string,
  payload: Record<string, unknown>,
  logId?: string,
): ClientWsMessage & { type: "flow:guide" } {
  const parsed = ClientWsMessageSchema.parse({
    type: "flow:guide",
    flow_id: flowId,
    content: typeof payload.content === "string" ? payload.content : "",
    ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments } : {}),
    ...(Array.isArray(payload.plan_feedback) ? { plan_feedback: payload.plan_feedback } : {}),
    client_message_id: clientMessageId,
    ...(logId ? { log_id: logId } : {}),
  });
  if (parsed.type !== "flow:guide") throw new Error("Invalid queued Guide message");
  return parsed;
}

async function handleQueueDispatch(
  message: ClientWsMessage & { type: "flow:queue_dispatch" },
  connection: WsConnection,
) {
  const queue = connection.store.listQueuedMessages(message.flow_id);
  const item = queue.find((candidate) => candidate.id === message.queue_id);
  if (!item) {
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  if (queue[0]?.id !== item.id) {
    await connection.send(errorMessage(
      "QUEUE_ORDER_CONFLICT",
      "Only the first queued message can be dispatched.",
      message.flow_id,
      message.log_id,
    ));
    return;
  }
  const claimed = connection.store.claimQueuedMessage(message.flow_id, item.id);
  if (!claimed) {
    await connection.send(errorMessage(
      "QUEUE_REVISION_CONFLICT",
      "The queued message changed before it could be dispatched.",
      message.flow_id,
      message.log_id,
    ));
    return;
  }
  await publishQueueState(connection, message.flow_id);
  const accepted = await handleFlowMessage(
    queuedFlowMessage(message.flow_id, claimed.id, claimed.payload, message.log_id),
    connection,
    (messageId) => {
      connection.store.completeQueuedMessage(message.flow_id, claimed.id, messageId);
    },
  );
  if (!accepted) {
    connection.store.releaseSubmission(message.flow_id, claimed.id);
    connection.store.releaseQueuedMessage(message.flow_id, claimed.id);
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  await publishQueueState(connection, message.flow_id, message.log_id);
}

export async function drainNextQueuedMessage(flowId: string, connection: WsConnection): Promise<boolean> {
  if (connection.store.getOpenUserTurn(flowId)) return false;
  const next = connection.store.listQueuedMessages(flowId)[0];
  if (!next || next.status !== "accepted") return false;
  await handleQueueDispatch({
    type: "flow:queue_dispatch",
    flow_id: flowId,
    queue_id: next.id,
  }, connection);
  return connection.store.getQueuedMessage(flowId, next.id) === undefined;
}

async function handleQueueGuide(
  message: ClientWsMessage & { type: "flow:queue_guide" },
  connection: WsConnection,
) {
  const item = connection.store.getQueuedMessage(message.flow_id, message.queue_id);
  if (!item) {
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  const claimed = connection.store.claimQueuedMessageForGuide(message.flow_id, message.queue_id);
  if (!claimed) {
    await connection.send(errorMessage(
      "QUEUE_REVISION_CONFLICT",
      "The queued message changed before it could be guided.",
      message.flow_id,
      message.log_id,
    ));
    return;
  }
  await publishQueueState(connection, message.flow_id);
  const accepted = await handleFlowGuide(
    queuedGuideMessage(message.flow_id, message.client_message_id, claimed.payload, message.log_id),
    connection,
    () => {
      connection.store.completeGuidedQueuedMessage(message.flow_id, claimed.id);
    },
  );
  if (!accepted) {
    connection.store.releaseQueuedMessage(message.flow_id, claimed.id);
    await publishQueueState(connection, message.flow_id, message.log_id);
    return;
  }
  await publishQueueState(connection, message.flow_id, message.log_id);
}

async function handleQueueClear(
  message: ClientWsMessage & { type: "flow:queue_clear" },
  connection: WsConnection,
) {
  connection.store.clearQueuedMessages(message.flow_id);
  await publishQueueState(connection, message.flow_id, message.log_id);
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

  const leader = ensureLeaderSession(message.flow_id, connection);
  void connection.leaderRuntime.runLeaderTurn({
    flowId: message.flow_id,
    userTurnId: startedTurn.id,
    kind: "spec_run",
    leaderAgentSessionId: leader.id,
    leaderSessionId: leader.sessionId ?? leader.id,
    resumeSessionId: leaderProviderResumeSessionId(flow, leader),
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
      resumeSessionId: leaderProviderResumeSessionId(flow, leader),
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
    const transcriptMessage = connection.chatJournal.recordUserMessage(
      message.flow_id,
      leader.sessionId ?? leader.id,
      `clarification_card_id: ${resolved.id}\n用户已回答澄清卡片。`,
      resolution.leaderInput.messageId,
      resolution.leaderInput.createdAt,
      leader.id,
      { decisionCardId: resolved.id, decisionStatus: "resolved" },
    );
    await connection.eventBus.publish(message.flow_id, {
      type: "session:transcript_event",
      flow_id: message.flow_id,
      session_id: leader.sessionId ?? leader.id,
      agent_session_id: leader.id,
      flow_expert_id: leader.id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        stream_epoch: connection.chatJournal.getStreamEpoch(),
        cursor: transcriptMessage.cursor,
        event: { type: "message-added", message: transcriptMessage.message },
        ...transcriptCommitMetadata(transcriptMessage),
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
  const leader = ensureLeaderSession(message.flow_id, connection);
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
    const transcriptMessage = connection.chatJournal.recordUserMessage(
      message.flow_id,
      leader.sessionId ?? leader.id,
      `clarification_card_id: ${cancelled.id}\n用户取消了本次澄清卡片。`,
      resolution.leaderInput.messageId,
      resolution.leaderInput.createdAt,
      leader.id,
      { decisionCardId: cancelled.id, decisionStatus: "cancelled" },
    );
    await connection.eventBus.publish(message.flow_id, {
      type: "session:transcript_event",
      flow_id: message.flow_id,
      session_id: leader.sessionId ?? leader.id,
      agent_session_id: leader.id,
      flow_expert_id: leader.id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: {
        stream_epoch: connection.chatJournal.getStreamEpoch(),
        cursor: transcriptMessage.cursor,
        event: { type: "message-added", message: transcriptMessage.message },
        ...transcriptCommitMetadata(transcriptMessage),
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
  connection.store.clearQueuedMessages(message.flow_id);
  await publishQueueState(connection, message.flow_id, message.log_id);
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
    logWsWire({
      direction: "in",
      channel: "api_ws",
      clientId: connection.clientId,
      flowId: parsed.flowId,
      type: "invalid_message",
      payload: { raw: typeof rawMessage === "string" ? rawMessage.slice(0, 2000) : String(rawMessage).slice(0, 2000) },
    });
    await connection.send(errorMessage("invalid_message", "Invalid websocket message", parsed.flowId, parsed.logId));
    return;
  }

  const message = parsed.message;
  logWsWire({
    direction: "in",
    channel: "api_ws",
    clientId: connection.clientId,
    flowId: "flow_id" in message ? message.flow_id : null,
    type: message.type,
    payload: message,
  });
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
    case "flow:queue_add":
      await handleQueueAdd(message, connection);
      return;
    case "flow:queue_delete":
      await handleQueueDelete(message, connection);
      return;
    case "flow:queue_reorder":
      await handleQueueReorder(message, connection);
      return;
    case "flow:queue_dispatch":
      await handleQueueDispatch(message, connection);
      return;
    case "flow:queue_guide":
      await handleQueueGuide(message, connection);
      return;
    case "flow:queue_clear":
      await handleQueueClear(message, connection);
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
      const parsed = ServerWsMessageSchema.parse(message);
      logWsWire({
        direction: "out",
        channel: "api_ws",
        clientId,
        flowId: "flow_id" in parsed ? parsed.flow_id : null,
        type: parsed.type,
        payload: parsed,
      });
      socket.send(JSON.stringify(parsed));
    };
    let incomingMessages = Promise.resolve();

    socket.on("message", (rawMessage: unknown) => {
      incomingMessages = incomingMessages
        .then(() => handleWsClientMessage(rawMessage, {
          clientId,
          subscriptions,
          eventBus: deps.eventBus,
          store: deps.store,
          chatJournal: deps.chatJournal,
          leaderRuntime: deps.leaderRuntime,
          expertRuntime: deps.expertRuntime,
          orchestrationScheduler: deps.orchestrationScheduler,
          logger: deps.logger,
          runId: deps.runId,
          requestQueueDrain: deps.requestQueueDrain,
          send,
        }))
        .catch(() => {
          try {
            send(errorMessage("internal_error", "Websocket message handling failed"));
          } catch {
            // The socket may have closed while the command was being handled.
          }
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

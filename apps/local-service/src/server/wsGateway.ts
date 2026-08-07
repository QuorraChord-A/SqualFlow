import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  ClientWsMessageSchema,
  hasMessageImageData,
  ServerWsMessageSchema,
  type ClientWsMessage,
  type MessageImageAttachment,
  type ServerWsMessage,
} from "../protocol/wsMessages.js";
import type { CanonicalTimelineItem, Store } from "../db/store.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import { leaderTranscriptChannelId } from "../domain/transcriptChannels.js";
import { LeaderInputRejectedError, type LeaderRuntime } from "../runtime/leaderRuntime.js";
import type { LeaderTurnInput } from "../runtime/leaderPrompt.js";
import type { ExpertRuntime } from "../runtime/expertRuntime.js";
import type { ChatJournal } from "../ws/chatJournal.js";
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
  expertRuntime?: Pick<ExpertRuntime, "cancelAgent" | "resolvePermissionCard">;
  send: SendServerMessage;
  logger?: OperationalLogger;
  processRunId?: string;
  requestQueueDrain?: (flowId: string) => void;
};

export type WsGatewayDeps = Omit<WsConnection, "clientId" | "subscriptions" | "send">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawToString(raw: unknown) {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString();
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString();
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return String(raw);
}

function unwrapPayload(raw: unknown) {
  return isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function payloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(stableJson(payload))).digest("hex");
}

function errorMessage(code: string, message: string, flowId?: string, logId?: string): ServerWsMessage {
  return ServerWsMessageSchema.parse({
    type: "system:error",
    ...(flowId ? { flow_id: flowId } : {}),
    ...(logId ? { log_id: logId } : {}),
    data: { code, message },
  });
}

function queuePayload(message: {
  content: string;
  display_content?: string;
  attachments?: MessageImageAttachment[];
  orchestration_feedback?: Array<Record<string, unknown>>;
  client_payload?: Record<string, unknown>;
}) {
  const reservedModeKeys = new Set([
    "behavior_mode", "behaviorMode", "risk_mode", "riskMode",
    "orchestration_mode", "orchestrationMode", "plan_requested", "planRequested",
  ]);
  const clientPayload = Object.fromEntries(
    Object.entries(message.client_payload ?? {}).filter(([key]) => !reservedModeKeys.has(key)),
  );
  return {
    content: message.content,
    ...(message.display_content ? { display_content: message.display_content } : {}),
    attachments: message.attachments ?? [],
    orchestration_feedback: message.orchestration_feedback ?? [],
    client_payload: clientPayload,
  };
}

function queueStateData(flowId: string, store: Store) {
  return store.listQueuedMessages(flowId).map((item) => ({
    ...item.payload.client_payload as Record<string, unknown>,
    id: item.id,
    content: typeof item.payload.content === "string" ? item.payload.content : "",
    ...(typeof item.payload.display_content === "string" ? { displayContent: item.payload.display_content } : {}),
    status: item.status,
    revision: item.revision,
  }));
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
  const event = queueStateMessage(flowId, connection.store, logId);
  if (connection.subscriptions.has(flowId)) await connection.eventBus.publish(flowId, event);
  else await connection.send(event);
}

function flowStateMessage(flowId: string, store: Store, logId?: string): ServerWsMessage {
  const snapshot = buildFlowSnapshot(store, flowId);
  return ServerWsMessageSchema.parse({
    type: "flow:state",
    flow_id: flowId,
    ...(logId ? { log_id: logId } : {}),
    data: { ...snapshot, queued_messages: queueStateData(flowId, store) },
  });
}

function timelineItemDto(item: CanonicalTimelineItem) {
  return {
    id: item.itemId,
    position: item.position,
    type: item.itemType,
    lifecycle: item.lifecycle,
    message_id: item.messageId,
    session_id: item.sessionId,
    agent_run_id: item.agentRunId,
    presentation_turn_id: item.presentationTurnId,
    message_kind: item.messageKind,
    payload: item.payload,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function sessionHistoryMessage(
  message: ClientWsMessage & { type: "session:get" },
  connection: WsConnection,
): ServerWsMessage {
  const requestedSession = message.agent_session_id
    ? connection.store.getAgentSession(message.agent_session_id)
    : undefined;
  if (message.agent_session_id && (!requestedSession || requestedSession.flowId !== message.flow_id)) {
    return errorMessage("AGENT_SESSION_NOT_FOUND", "AgentSession 不存在或不属于当前 Flow", message.flow_id, message.log_id);
  }
  const requestedRun = message.agent_run_id ? connection.store.getAgentRun(message.agent_run_id) : undefined;
  if (message.agent_run_id && (!requestedRun || requestedRun.flowId !== message.flow_id)) {
    return errorMessage("AGENT_RUN_NOT_FOUND", "AgentRun 不存在或不属于当前 Flow", message.flow_id, message.log_id);
  }
  const session = requestedSession
    ?? (requestedRun ? connection.store.getAgentSession(requestedRun.agentSessionId) : undefined)
    ?? connection.store.getLeaderAgentSession(message.flow_id);
  const run = requestedRun ?? (session ? connection.store.listAgentSessionRuns(session.id).at(-1) : undefined);
  const channelId = session?.role === "leader" ? leaderTranscriptChannelId(message.flow_id) : session?.id ?? "";
  const activeTurn = session ? connection.chatJournal.getActiveTurn(message.flow_id, session.id) : null;
  return ServerWsMessageSchema.parse({
    type: "session:transcript_snapshot",
    flow_id: message.flow_id,
    session_id: session?.id ?? message.session_id ?? "",
    ...(session ? { agent_session_id: session.id } : {}),
    ...(run ? { agent_run_id: run.id } : {}),
    data: {
      stream_epoch: connection.chatJournal.getStreamEpoch(),
      cursor: connection.chatJournal.getCursor(message.flow_id, channelId),
      timeline_items: connection.chatJournal.getTimelineItems(message.flow_id, channelId).map(timelineItemDto),
      ...(activeTurn && run && ["queued", "running", "waiting_tool_approval"].includes(run.status) ? {
        active_turn: {
          message_id: activeTurn.message.id,
          presentation_turn_id: activeTurn.presentationTurnId,
          segment_index: activeTurn.segmentIndex,
          started_at: activeTurn.message.metadata?.turnTiming?.startedAt ?? activeTurn.message.createdAt ?? new Date().toISOString(),
        },
      } : {}),
    },
    pending_user_actions: connection.store.listPendingUserActions(message.flow_id),
  });
}

function missingProjectDirectory(flowId: string, store: Store) {
  const flow = store.getFlow(flowId);
  const project = flow?.projectId ? store.getProject(flow.projectId) : undefined;
  if (!project?.localPath) return "Flow 未绑定可用的项目目录";
  try { return fs.statSync(project.localPath).isDirectory() ? null : `项目目录不存在：${project.localPath}`; }
  catch { return `项目目录不存在：${project.localPath}`; }
}

function createLeaderRun(
  connection: WsConnection,
  flowId: string,
  triggerKind: string,
  triggerMessageId: string | null,
  modelInput: Record<string, unknown>,
) {
  const leader = connection.store.getLeaderAgentSession(flowId);
  if (!leader) return undefined;
  return connection.store.createAgentRun({
    flowId,
    agentSessionId: leader.id,
    triggerKind,
    triggerMessageId,
    modelInput,
  });
}

function recordFeedback(
  connection: WsConnection,
  flowId: string,
  messageId: string,
  feedback: Array<{ orchestration_revision_id: string; orchestration_node_id?: string | null; marker_number: number; comment: string }> | undefined,
) {
  const grouped = new Map<string, typeof feedback>();
  for (const item of feedback ?? []) grouped.set(item.orchestration_revision_id, [...(grouped.get(item.orchestration_revision_id) ?? []), item]);
  for (const [revisionId, items] of grouped) connection.store.recordOrchestrationFeedback({
    flowId,
    orchestrationRevisionId: revisionId,
    sourceMessageId: messageId,
    feedback: (items ?? []).map((item) => ({
      orchestrationNodeId: item.orchestration_node_id,
      markerNumber: item.marker_number,
      comment: item.comment,
    })),
  });
}

async function startLeaderMessage(
  connection: WsConnection,
  message: {
    flow_id: string;
    content: string;
    attachments?: MessageImageAttachment[];
    orchestration_feedback?: Array<{ id: string; orchestration_revision_id: string; orchestration_node_id?: string | null; marker_number: number; comment: string }>;
    client_message_id?: string;
    log_id?: string;
  },
) {
  const flow = connection.store.getFlow(message.flow_id);
  if (!flow) throw new Error("FLOW_NOT_FOUND");
  const directoryError = missingProjectDirectory(message.flow_id, connection.store);
  if (directoryError) throw new Error(`PROJECT_DIRECTORY_MISSING:${directoryError}`);
  const leader = connection.store.getLeaderAgentSession(message.flow_id);
  if (!leader) throw new Error("LEADER_SESSION_NOT_FOUND");
  if (connection.store.getActiveAgentRun(leader.id)) throw new LeaderInputRejectedError();
  const messageId = message.client_message_id ?? `msg-user-${randomUUID()}`;
  const payload = {
    content: message.content,
    attachments: message.attachments ?? [],
    orchestration_feedback: message.orchestration_feedback ?? [],
  };
  const accepted = connection.store.acceptSubmission({
    flowId: message.flow_id,
    clientMessageId: messageId,
    submissionType: "normal",
    payloadHash: payloadHash(payload),
    payload,
  });
  if (accepted.outcome === "conflict") throw new Error("MESSAGE_ID_CONFLICT");
  if (accepted.submission.receiptState === "materialized") return {
    messageId: accepted.submission.messageId ?? messageId,
    runId: connection.store.listAgentSessionRuns(leader.id).at(-1)?.id,
  };
  if (!connection.store.claimSubmission(message.flow_id, messageId)) throw new Error("MESSAGE_ALREADY_DISPATCHING");
  const run = createLeaderRun(connection, message.flow_id, "user_message", messageId, payload);
  if (!run) {
    connection.store.releaseSubmission(message.flow_id, messageId);
    throw new LeaderInputRejectedError();
  }
  recordFeedback(connection, message.flow_id, messageId, message.orchestration_feedback);
  connection.store.markSubmissionMaterialized(message.flow_id, messageId, messageId);
  void connection.leaderRuntime.runLeaderTurn({
    flowId: message.flow_id,
    kind: "user",
    userMessage: message.content,
    attachments: message.attachments,
    orchestrationFeedback: message.orchestration_feedback,
    leaderAgentRunId: run.id,
    leaderSessionId: leader.id,
    resumeSessionId: leader.providerSessionId ?? undefined,
    messageId,
    logId: message.log_id,
  }).catch(async (error) => {
    const current = connection.store.getAgentRun(run.id);
    if (current && ["queued", "running", "waiting_tool_approval"].includes(current.status)) {
      connection.store.updateAgentRunStatus(run.id, "failed", error instanceof Error ? error.message : String(error));
    }
    await connection.eventBus.publish(message.flow_id, errorMessage(
      "LEADER_RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
      message.flow_id,
      message.log_id,
    ));
  });
  return { messageId, runId: run.id };
}

async function handleFlowMessage(message: ClientWsMessage & { type: "flow:message" }, connection: WsConnection) {
  try {
    const started = await startLeaderMessage(connection, message);
    await connection.send(ServerWsMessageSchema.parse({
      type: "flow:message_ack",
      flow_id: message.flow_id,
      ...(message.log_id ? { log_id: message.log_id } : {}),
      data: { accepted: true, message_id: started.messageId, client_message_id: message.client_message_id ?? started.messageId, leader_agent_run_id: started.runId },
    }));
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const [code, details] = raw.split(":", 2);
    await connection.send(errorMessage(code, details || (error instanceof Error ? error.message : raw), message.flow_id, message.log_id));
  }
}

async function handleGuide(message: ClientWsMessage & { type: "flow:guide" }, connection: WsConnection) {
  const leader = connection.store.getLeaderAgentSession(message.flow_id);
  const active = leader ? connection.store.getActiveAgentRun(leader.id) : undefined;
  if (!leader || !active || active.status !== "running") {
    await connection.send(errorMessage("LEADER_RUN_NOT_RUNNING", "当前没有可引导的 Leader AgentRun", message.flow_id, message.log_id));
    return;
  }
  const messageId = message.client_message_id ?? `msg-guide-${randomUUID()}`;
  const payload = { content: message.content, attachments: message.attachments ?? [], orchestration_feedback: message.orchestration_feedback ?? [] };
  const accepted = connection.store.acceptSubmission({
    flowId: message.flow_id,
    clientMessageId: messageId,
    submissionType: "guide",
    payloadHash: payloadHash(payload),
    payload,
  });
  if (accepted.outcome === "conflict") {
    await connection.send(errorMessage("MESSAGE_ID_CONFLICT", "消息 ID 已用于不同内容", message.flow_id, message.log_id));
    return;
  }
  if (accepted.submission.receiptState !== "materialized") {
    if (!connection.store.claimSubmission(message.flow_id, messageId)) {
      await connection.send(errorMessage("MESSAGE_ALREADY_DISPATCHING", "引导消息正在投递", message.flow_id, message.log_id));
      return;
    }
    recordFeedback(connection, message.flow_id, messageId, message.orchestration_feedback);
    try {
      await connection.leaderRuntime.guideLeaderTurn({
        flowId: message.flow_id,
        content: message.content,
        attachments: message.attachments,
        orchestrationFeedback: message.orchestration_feedback,
        leaderAgentRunId: active.id,
        messageId,
      });
      connection.store.markSubmissionMaterialized(message.flow_id, messageId, messageId);
    } catch (error) {
      connection.store.releaseSubmission(message.flow_id, messageId);
      await connection.send(errorMessage("GUIDE_REJECTED", error instanceof Error ? error.message : String(error), message.flow_id, message.log_id));
      return;
    }
  }
  await connection.send(ServerWsMessageSchema.parse({
    type: "flow:guide_ack",
    flow_id: message.flow_id,
    ...(message.log_id ? { log_id: message.log_id } : {}),
    data: { accepted: true, message_id: accepted.submission.messageId ?? messageId, leader_agent_run_id: active.id },
  }));
}

async function runClaimedTrigger(connection: WsConnection, trigger: ReturnType<Store["claimLeaderRunTrigger"]>) {
  if (!trigger) return false;
  const leader = connection.store.getLeaderAgentSession(trigger.flowId);
  if (!leader || connection.store.getActiveAgentRun(leader.id)) {
    connection.store.releaseLeaderRunTrigger(trigger.id);
    return false;
  }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(trigger.payloadJson) as Record<string, unknown>; } catch { payload = {}; }
  const run = createLeaderRun(connection, trigger.flowId, trigger.kind, trigger.sourceId, payload);
  if (!run) {
    connection.store.releaseLeaderRunTrigger(trigger.id, "Unable to create Leader AgentRun");
    return false;
  }
  connection.store.completeLeaderRunTrigger(trigger.id);
  const kind: NonNullable<LeaderTurnInput["kind"]> = trigger.kind === "decision_resolved" ? "decision"
    : trigger.kind === "decision_cancelled" ? "decision_cancelled"
      : trigger.kind === "plan_resolved" ? "plan_resolved"
        : trigger.kind === "orchestration_resolved" ? "orchestration_resolved"
          : trigger.kind === "expert_result" ? "expert_result"
            : trigger.kind === "expert_message" ? "expert_message"
              : "user";
  const expertResult = isRecord(payload.expert_result)
    ? payload.expert_result as LeaderTurnInput["expertResult"]
    : undefined;
  const expertMessage = isRecord(payload.expert_message)
    ? payload.expert_message as LeaderTurnInput["expertMessage"]
    : undefined;
  void connection.leaderRuntime.runLeaderTurn({
    flowId: trigger.flowId,
    kind,
    userMessage: typeof payload.content === "string" ? payload.content : undefined,
    decisionAnswers: isRecord(payload.answers) ? payload.answers as Record<string, string | string[]> : undefined,
    decisionUserMessage: typeof payload.content === "string" ? payload.content : undefined,
    decisionRequestId: trigger.kind.startsWith("decision_") ? trigger.sourceId : undefined,
    expertResult,
    expertMessage,
    leaderAgentRunId: run.id,
    leaderSessionId: leader.id,
    resumeSessionId: leader.providerSessionId ?? undefined,
  }).catch(async (error) => {
    const current = connection.store.getAgentRun(run.id);
    if (current && ["queued", "running", "waiting_tool_approval"].includes(current.status)) {
      connection.store.updateAgentRunStatus(run.id, "failed", error instanceof Error ? error.message : String(error));
    }
    await connection.eventBus.publish(trigger.flowId, errorMessage("LEADER_RUNTIME_ERROR", error instanceof Error ? error.message : String(error), trigger.flowId));
  });
  return true;
}

export async function drainNextQueuedMessage(flowId: string, connection: WsConnection, queueId?: string) {
  const leader = connection.store.getLeaderAgentSession(flowId);
  if (!leader || connection.store.getActiveAgentRun(leader.id)) return false;
  const trigger = connection.store.claimLeaderRunTrigger(flowId);
  if (trigger) return runClaimedTrigger(connection, trigger);
  const claimed = connection.store.claimQueuedMessage(flowId, queueId);
  if (!claimed) return false;
  const content = typeof claimed.payload.content === "string" ? claimed.payload.content : "";
  const attachments = Array.isArray(claimed.payload.attachments)
    ? claimed.payload.attachments.filter(isRecord) as MessageImageAttachment[]
    : undefined;
  const orchestrationFeedback = Array.isArray(claimed.payload.orchestration_feedback)
    ? claimed.payload.orchestration_feedback.filter(isRecord) as Array<any>
    : undefined;
  try {
    const started = await startLeaderMessage(connection, {
      flow_id: flowId,
      content,
      attachments,
      orchestration_feedback: orchestrationFeedback,
      client_message_id: claimed.id,
    });
    connection.store.completeQueuedMessage(flowId, claimed.id, started.messageId);
    await publishQueueState(connection, flowId);
    return true;
  } catch (error) {
    connection.store.releaseQueuedMessage(flowId, claimed.id);
    await publishQueueState(connection, flowId);
    return false;
  }
}

async function handleQueue(message: Extract<ClientWsMessage, { type: `flow:queue_${string}` }>, connection: WsConnection) {
  if (message.type === "flow:queue_add") {
    const payload = queuePayload(message);
    const result = connection.store.addQueuedMessage({ id: message.queue_id, flowId: message.flow_id, payloadHash: payloadHash(payload), payload });
    if (result.acceptance.outcome === "conflict") {
      await connection.send(errorMessage("QUEUE_ID_CONFLICT", "队列 ID 已用于不同内容", message.flow_id, message.log_id));
      return;
    }
    await publishQueueState(connection, message.flow_id, message.log_id);
    connection.requestQueueDrain?.(message.flow_id);
    return;
  }
  if (message.type === "flow:queue_edit") {
    const payload = queuePayload(message);
    if (!connection.store.updateQueuedMessage({
      flowId: message.flow_id,
      queueId: message.queue_id,
      expectedRevision: message.expected_revision,
      payloadHash: payloadHash(payload),
      payload,
    })) {
      await connection.send(errorMessage("QUEUE_REVISION_CONFLICT", "队列消息已变化，请刷新后重试", message.flow_id, message.log_id));
      return;
    }
  } else if (message.type === "flow:queue_delete") {
    if (!connection.store.deleteQueuedMessage(message.flow_id, message.queue_id)) {
      await connection.send(errorMessage("QUEUE_ITEM_NOT_EDITABLE", "队列消息不存在或正在投递", message.flow_id, message.log_id));
      return;
    }
  } else if (message.type === "flow:queue_reorder") {
    if (!connection.store.reorderQueuedMessages(message.flow_id, message.queue_ids)) {
      await connection.send(errorMessage("QUEUE_REORDER_CONFLICT", "队列已变化，请刷新后重试", message.flow_id, message.log_id));
      return;
    }
  } else if (message.type === "flow:queue_clear") {
    connection.store.clearQueuedMessages(message.flow_id);
  } else if (message.type === "flow:queue_dispatch") {
    if (!connection.store.getQueuedMessage(message.flow_id, message.queue_id)) {
      await connection.send(errorMessage("QUEUE_ITEM_NOT_FOUND", "队列消息不存在", message.flow_id, message.log_id));
      return;
    }
    await drainNextQueuedMessage(message.flow_id, connection, message.queue_id);
  } else if (message.type === "flow:queue_guide") {
    const claimed = connection.store.claimQueuedMessageForGuide(message.flow_id, message.queue_id);
    if (!claimed) {
      await connection.send(errorMessage("QUEUE_ITEM_NOT_FOUND", "队列消息不存在或正在投递", message.flow_id, message.log_id));
      return;
    }
    const content = typeof claimed.payload.content === "string" ? claimed.payload.content : "";
    const leader = connection.store.getLeaderAgentSession(message.flow_id);
    const active = leader ? connection.store.getActiveAgentRun(leader.id) : undefined;
    if (!active || active.status !== "running") {
      connection.store.releaseQueuedMessage(message.flow_id, message.queue_id);
      await connection.send(errorMessage("LEADER_RUN_NOT_RUNNING", "当前没有可引导的 Leader AgentRun", message.flow_id, message.log_id));
      return;
    }
    try {
      await connection.leaderRuntime.guideLeaderTurn({
        flowId: message.flow_id,
        content,
        leaderAgentRunId: active.id,
        messageId: message.client_message_id,
      });
      connection.store.completeGuidedQueuedMessage(message.flow_id, message.queue_id);
    } catch {
      connection.store.releaseQueuedMessage(message.flow_id, message.queue_id);
    }
  }
  await publishQueueState(connection, message.flow_id, message.log_id);
}

async function enqueueResolvedTrigger(connection: WsConnection, input: {
  flowId: string;
  kind: "decision_resolved" | "decision_cancelled" | "plan_resolved" | "orchestration_resolved";
  sourceId: string;
  payload: Record<string, unknown>;
}) {
  connection.store.enqueueLeaderRunTrigger(input);
  connection.requestQueueDrain?.(input.flowId);
  await drainNextQueuedMessage(input.flowId, connection);
}

async function handleResolution(message: Extract<ClientWsMessage, { type: "decision_request:resolve" | "decision_request:reject" | "decision_request:cancel" | "plan:resolve" | "orchestration:resolve" }>, connection: WsConnection) {
  if (message.type === "decision_request:resolve" || message.type === "decision_request:reject" || message.type === "decision_request:cancel") {
    const request = connection.store.getDecisionRequest(message.decision_request_id) as {
      flowId?: string; requestType?: string; agentRunId?: string; status?: string;
    } | undefined;
    if (!request || request.flowId !== message.flow_id) {
      await connection.send(errorMessage("DECISION_REQUEST_NOT_FOUND", "用户动作不存在或不属于当前 Flow", message.flow_id, message.log_id));
      return;
    }
    if (request.requestType === "tool_permission") {
      if (!connection.expertRuntime) return;
      await connection.expertRuntime.resolvePermissionCard({
        flowId: message.flow_id,
        cardId: message.decision_request_id,
        outcome: message.type === "decision_request:resolve" ? "approved" : message.type === "decision_request:reject" ? "user_denied" : "card_cancelled",
        actionId: message.client_action_id,
      });
    } else {
      const status = message.type === "decision_request:resolve" ? "approved" : message.type === "decision_request:reject" ? "rejected" : "cancelled";
      const resolved = connection.store.resolveDecisionRequest({
        requestId: message.decision_request_id,
        status,
        clientActionId: message.client_action_id ?? `decision-${randomUUID()}`,
        response: message.type === "decision_request:resolve" ? { answers: message.answers } : {},
      });
      if (!resolved) {
        await connection.send(errorMessage("DECISION_REQUEST_STALE", "用户动作已处理或状态不允许", message.flow_id, message.log_id));
        return;
      }
      await enqueueResolvedTrigger(connection, {
        flowId: message.flow_id,
        kind: message.type === "decision_request:resolve" ? "decision_resolved" : "decision_cancelled",
        sourceId: message.decision_request_id,
        payload: message.type === "decision_request:resolve" ? { answers: message.answers } : {},
      });
    }
    await connection.eventBus.publish(message.flow_id, {
      type: "decision_request:event", flow_id: message.flow_id, data: connection.store.getDecisionRequest(message.decision_request_id),
    });
    return;
  }
  if (message.type === "plan:resolve") {
    const approval = connection.store.getPlanApproval(message.plan_approval_id) as { flowId?: string } | undefined;
    if (!approval || approval.flowId !== message.flow_id) {
      await connection.send(errorMessage("PLAN_APPROVAL_NOT_FOUND", "计划审批不存在或不属于当前 Flow", message.flow_id, message.log_id));
      return;
    }
    const resolved = connection.store.resolvePlanApproval({
      approvalId: message.plan_approval_id,
      status: message.resolution,
      clientActionId: message.client_action_id,
      feedback: message.feedback,
    });
    if (!resolved) {
      await connection.send(errorMessage("PLAN_APPROVAL_STALE", "计划审批已处理或状态不允许", message.flow_id, message.log_id));
      return;
    }
    await connection.eventBus.publish(message.flow_id, { type: "plan_approval:event", flow_id: message.flow_id, data: resolved.approval });
    if (!resolved.idempotent) await enqueueResolvedTrigger(connection, {
      flowId: message.flow_id,
      kind: "plan_resolved",
      sourceId: message.plan_approval_id,
      payload: { content: `计划审批结果：${message.resolution}${message.feedback ? `。反馈：${message.feedback}` : ""}` },
    });
    return;
  }
  const approval = connection.store.getOrchestrationApproval(message.orchestration_approval_id) as { flowId?: string } | undefined;
  if (!approval || approval.flowId !== message.flow_id) {
    await connection.send(errorMessage("ORCHESTRATION_APPROVAL_NOT_FOUND", "编排审批不存在或不属于当前 Flow", message.flow_id, message.log_id));
    return;
  }
  const resolved = connection.store.resolveOrchestrationApproval({
    approvalId: message.orchestration_approval_id,
    status: message.resolution,
    clientActionId: message.client_action_id,
    feedback: message.feedback,
  });
  if (!resolved) {
    await connection.send(errorMessage("ORCHESTRATION_APPROVAL_STALE", "编排审批已处理或状态不允许", message.flow_id, message.log_id));
    return;
  }
  await connection.eventBus.publish(message.flow_id, {
    type: "orchestration_approval:event", flow_id: message.flow_id, data: resolved.approval,
  });
  await Promise.all(resolved.tasks.map((task) => connection.eventBus.publish(message.flow_id, {
    type: "task:event", flow_id: message.flow_id, data: task,
  })));
  if (!resolved.idempotent) await enqueueResolvedTrigger(connection, {
    flowId: message.flow_id,
    kind: "orchestration_resolved",
    sourceId: message.orchestration_approval_id,
    payload: { content: `编排审批结果：${message.resolution}${message.feedback ? `。反馈：${message.feedback}` : ""}` },
  });
}

async function handleInterrupt(message: Extract<ClientWsMessage, { type: "flow:interrupt" | "agent_run:cancel" }>, connection: WsConnection) {
  if (message.type === "agent_run:cancel") {
    const run = connection.store.getAgentRun(message.agent_run_id);
    const session = run ? connection.store.getAgentSession(run.agentSessionId) : undefined;
    if (!run || !session || run.flowId !== message.flow_id || session.role !== "leader") {
      await connection.send(errorMessage("LEADER_RUN_NOT_FOUND", "只能从输入框停止当前 Leader AgentRun", message.flow_id, message.log_id));
      return;
    }
    connection.leaderRuntime.cancelFlow(message.flow_id);
    const current = connection.store.getAgentRun(run.id);
    if (current && ["queued", "running", "waiting_tool_approval"].includes(current.status)) connection.store.updateAgentRunStatus(run.id, "cancelled");
    await connection.eventBus.publish(message.flow_id, { type: "agent_run:event", flow_id: message.flow_id, data: connection.store.getAgentRun(run.id) });
    return;
  }
  connection.leaderRuntime.cancelFlow(message.flow_id);
  for (const session of connection.store.listAgentSessions(message.flow_id).filter((candidate) => candidate.role === "expert")) {
    const active = connection.store.getActiveAgentRun(session.id);
    if (active) await connection.expertRuntime?.cancelAgent({ flowId: message.flow_id, agentSessionId: session.id, agentRunId: active.id });
  }
  const interrupted = connection.store.interruptFlow(message.flow_id);
  await Promise.all(interrupted.map((run) => connection.eventBus.publish(message.flow_id, {
    type: "agent_run:event", flow_id: message.flow_id, data: run,
  })));
}

export async function handleWsClientMessage(rawMessage: unknown, connection: WsConnection) {
  let parsedRaw: unknown;
  try { parsedRaw = JSON.parse(rawToString(rawMessage)); }
  catch {
    await connection.send(errorMessage("INVALID_JSON", "WebSocket 消息不是有效 JSON"));
    return;
  }
  const parsed = ClientWsMessageSchema.safeParse(unwrapPayload(parsedRaw));
  if (!parsed.success) {
    await connection.send(errorMessage("INVALID_MESSAGE", parsed.error.message));
    return;
  }
  const message = parsed.data;
  logWsWire({ direction: "in", channel: "api_ws", clientId: connection.clientId, flowId: message.flow_id, type: message.type, payload: message });
  if (message.type === "flow:subscribe") {
    connection.subscriptions.add(message.flow_id);
    connection.eventBus.subscribe(message.flow_id, connection.clientId, connection.send);
    await connection.send(flowStateMessage(message.flow_id, connection.store, message.log_id));
    return;
  }
  if (message.type === "flow:unsubscribe") {
    connection.subscriptions.delete(message.flow_id);
    connection.eventBus.unsubscribe(message.flow_id, connection.clientId);
    return;
  }
  if (message.type === "session:get") {
    await connection.send(sessionHistoryMessage(message, connection));
    return;
  }
  if (message.type === "client:diagnostic") return;
  if (message.type === "flow:message") return handleFlowMessage(message, connection);
  if (message.type === "flow:guide") return handleGuide(message, connection);
  if (message.type.startsWith("flow:queue_")) return handleQueue(message as Extract<ClientWsMessage, { type: `flow:queue_${string}` }>, connection);
  if (["decision_request:resolve", "decision_request:reject", "decision_request:cancel", "plan:resolve", "orchestration:resolve"].includes(message.type)) {
    return handleResolution(message as Extract<ClientWsMessage, { type: "decision_request:resolve" | "decision_request:reject" | "decision_request:cancel" | "plan:resolve" | "orchestration:resolve" }>, connection);
  }
  if (message.type === "flow:interrupt" || message.type === "agent_run:cancel") return handleInterrupt(message, connection);
}

export function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps) {
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
    let incoming = Promise.resolve();
    socket.on("message", (rawMessage: unknown) => {
      incoming = incoming.then(() => handleWsClientMessage(rawMessage, {
        ...deps,
        clientId,
        subscriptions,
        send,
      })).catch(() => { try { void send(errorMessage("INTERNAL_ERROR", "WebSocket 消息处理失败")); } catch { /* closed */ } });
    });
    socket.on("close", () => {
      deps.eventBus.unsubscribeClient(clientId);
      subscriptions.clear();
    });
  });
}

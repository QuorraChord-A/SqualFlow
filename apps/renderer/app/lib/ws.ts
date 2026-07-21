/**
 * SquadFlow WebSocket client — singleton, auto-reconnects.
 *
 * Protocol (namespace:action):
 *   Client → Server: flow, spec, UserTurn, and session commands.
 *   Server → Client: flow, UserTurn, task, session, decision-card, and artifact events.
 */

import { API_BASE } from './api';
import type { UIMessage } from 'ai';
import type { OutgoingMessageImageAttachment } from '../types/messageAttachments';
import type { PlanFeedbackDraft } from '../types/orchestration';

// ── Incoming message types ──

export type HistorySessionBoundary = {
  id: string;
  kind: "history_session_boundary";
  flow_expert_id: string;
  agent_session_id: string;
  display_name: string;
  started_at: string;
  status: "loaded" | "missing";
  before_message_id?: string;
};

export type TranscriptActiveTurn = {
  message_id: string;
  root_message_id?: string;
  segment_index?: number;
  started_at: string;
};

export type WsInMessage =
  | { type: "flow:state"; flow_id: string; data: any }
  | { type: "flow:message_ack"; flow_id: string; log_id?: string; data: { accepted: boolean; message_id: string; client_message_id?: string | null; leader_agent_session_id?: string } }
  | { type: "flow:guide_ack"; flow_id: string; log_id?: string; data: { accepted: boolean; message_id: string; client_message_id?: string | null; leader_agent_session_id?: string } }
  | { type: "flow:queue_state"; flow_id: string; log_id?: string; data: { messages: Array<Record<string, unknown>> } }
  | { type: "session:transcript_event"; flow_id: string; session_id: string; agent_session_id?: string; flow_expert_id?: string; data: { stream_epoch: string; cursor: number; event: any; removed_message_ids?: string[]; active_turn?: TranscriptActiveTurn } }
  | { type: "session:transcript_snapshot"; flow_id: string; session_id?: string; agent_session_id?: string; flow_expert_id?: string; data: { stream_epoch: string; cursor: number; messages: UIMessage[]; history_boundaries?: HistorySessionBoundary[]; active_turn?: TranscriptActiveTurn }; pending_cards?: any[]; decision_cards?: any[] }
  | { type: "flow:status"; flow_id: string; data: any }
  | { type: "flow:name_updated"; flow_id: string; data: { name: string; name_generation_status: "pending" | "generated" | "fallback" | "manual" } }
  | { type: "task:event"; flow_id: string; data: any }
  | { type: "user_turn:event"; flow_id: string; data: any }
  | { type: "session:event"; flow_id: string; data: any }
  | { type: "flow_expert:event"; flow_id: string; data: any }
  | { type: "context_usage:event"; flow_id: string; data: any }
  | { type: "context_compaction:event"; flow_id: string; data: any }
  | {
      type: "runtime:transport";
      flow_id: string;
      agent_session_id: string;
      flow_expert_id?: string;
      data: {
        state: "reconnecting" | "timeout" | "fallback_https" | "clear";
        message?: string;
        attempt?: number;
        max_attempts?: number;
        runtime_role: "leader" | "expert";
        user_turn_id?: string;
        task_id?: string;
      };
    }
  | { type: "flow:decision_card"; flow_id: string; data: any }
  | { type: "flow:decision_card_resolved"; flow_id: string; data: any }
  | { type: "flow:spec_card"; flow_id: string; data: any }
  | { type: "flow:spec_card_resolved"; flow_id: string; data: any }
  | { type: "artifact:event"; flow_id: string; data: any }
  | { type: "plan:event"; flow_id: string; data: any }
  | { type: "plan_approval:event"; flow_id: string; data: any }
  | { type: "plan_run:event"; flow_id: string; data: any }
  | { type: "system:error"; flow_id?: string; log_id?: string; data: { code: string; message: string } & Record<string, unknown> }

export type WsMessageHandler = (msg: WsInMessage) => void;
export type WsEventHandler = (msg: any) => void;

const MESSAGE_OUTBOX_STORAGE_KEY = "squadflow.messageOutbox.v1";
const MESSAGE_OUTBOX_DB_NAME = "squadflow-message-outbox";
const MESSAGE_OUTBOX_DB_VERSION = 1;
const MESSAGE_OUTBOX_STORE = "messages";
let indexedOutboxSequence = 0;
let indexedOutboxChain: Promise<void> = Promise.resolve();
type IndexedOutboxRecord = { logId: string; sequence: number; data: Record<string, any> };
const OUTBOX_MESSAGE_TYPES = new Set([
  "flow:message",
  "flow:guide",
  "flow:queue_add",
  "flow:queue_delete",
  "flow:queue_reorder",
  "flow:queue_dispatch",
  "flow:queue_guide",
  "flow:queue_clear",
]);

function readOutbox(): Record<string, any>[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MESSAGE_OUTBOX_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
  } catch {
    return [];
  }
}

function writeOutbox(messages: Record<string, any>[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(MESSAGE_OUTBOX_STORAGE_KEY);
      return true;
    }
    window.localStorage.setItem(MESSAGE_OUTBOX_STORAGE_KEY, JSON.stringify(messages));
    return true;
  } catch (error) {
    console.error("[ws] failed to persist message outbox", error);
    return false;
  }
}

function openIndexedOutbox(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(MESSAGE_OUTBOX_DB_NAME, MESSAGE_OUTBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MESSAGE_OUTBOX_STORE)) {
        request.result.createObjectStore(MESSAGE_OUTBOX_STORE, { keyPath: "logId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function runIndexedOutboxTransaction(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => void,
): Promise<boolean> {
  return openIndexedOutbox().then((database) => {
    if (!database) return false;
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(MESSAGE_OUTBOX_STORE, mode);
      transaction.oncomplete = () => {
        database.close();
        resolve(true);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("IndexedDB outbox transaction failed"));
      };
      transaction.onabort = transaction.onerror;
      operation(transaction.objectStore(MESSAGE_OUTBOX_STORE));
    });
  });
}

function enqueueIndexedOutboxOperation(operation: () => Promise<boolean>): Promise<boolean> {
  const result = indexedOutboxChain
    .then(operation)
    .catch((error) => {
      console.error("[ws] failed to update IndexedDB message outbox", error);
      return false;
    });
  indexedOutboxChain = result.then(() => undefined);
  return result;
}

function persistIndexedOutboxMessage(data: Record<string, any>): Promise<boolean> {
  const logId = typeof data.log_id === "string" ? data.log_id : "";
  if (!logId) return Promise.resolve(false);
  const sequence = Date.now() * 10_000 + (++indexedOutboxSequence % 10_000);
  return enqueueIndexedOutboxOperation(() => runIndexedOutboxTransaction("readwrite", (store) => {
    store.put({ logId, sequence, data });
  }));
}

function deleteIndexedOutboxMessage(logId: string) {
  enqueueIndexedOutboxOperation(() => runIndexedOutboxTransaction("readwrite", (store) => {
    store.delete(logId);
  }));
}

async function readIndexedOutbox(): Promise<IndexedOutboxRecord[]> {
  await indexedOutboxChain;
  const database = await openIndexedOutbox();
  if (!database) return [];
  return new Promise((resolve) => {
    const transaction = database.transaction(MESSAGE_OUTBOX_STORE, "readonly");
    const request = transaction.objectStore(MESSAGE_OUTBOX_STORE).getAll();
    request.onsuccess = () => {
      const records = (request.result as Array<{ logId?: unknown; sequence?: unknown; data?: unknown }>)
        .filter((record): record is IndexedOutboxRecord =>
          typeof record.logId === "string"
          && typeof record.sequence === "number"
          && Boolean(record.data && typeof record.data === "object" && !Array.isArray(record.data)))
        .sort((left, right) => left.sequence - right.sequence);
      resolve(records);
    };
    request.onerror = () => resolve([]);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  });
}

export class SquadFlowWs {
  private ws: WebSocket | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private eventHandlers: Map<string, Set<WsEventHandler>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private _connected = false;
  private _logSeq = 0;
  private pendingMessages: Record<string, any>[] = [];
  private outboxFlush: Promise<void> | null = null;
  private subscribedFlowIds: Set<string> = new Set();
  private subscriptionRefs: Map<string, number> = new Map();

  /** Generate unique logId for tracing */
  genLogId(): string {
    return `L${++this._logSeq}-${Date.now().toString(36).slice(-4)}`;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const protocol =
      typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? 'wss:'
        : 'ws:';
    const host = API_BASE ? new URL(API_BASE).host : window.location.host;
    const url = `${protocol}//${host}/api/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._connected = true;
      console.log('[ws] connected to', url);

      for (const flowId of this.subscribedFlowIds) {
        this.ws!.send(JSON.stringify({
          data: {
            type: "flow:subscribe",
            flow_id: flowId,
            log_id: this.genLogId(),
          },
        }));
      }

      const socket = this.ws!;
      const flush = this.flushPersistedMessages(socket);
      this.outboxFlush = flush;
      void flush.finally(() => {
        if (this.outboxFlush !== flush) return;
        this.outboxFlush = null;
        if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        while (this.pendingMessages.length > 0) this.sendRaw(this.pendingMessages.shift()!, socket);
      });
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        const logId = msg.log_id || '';
        if (logId) {
          const remaining = readOutbox().filter((item) => item.log_id !== logId);
          writeOutbox(remaining);
          deleteIndexedOutboxMessage(logId);
        }
        if (logId) {
          console.log(`[ws][${logId}] ← recv`, msg.type, msg.session_id?.slice(0, 8),
            msg.data?.event?.type || msg.data?.length || '');
        } else {
          console.log('[ws] ← pull', msg.type, msg.flow_id?.slice(0, 12), msg.data);
        }

        // Existing: dispatch to general handlers (delta/snapshot/history)
        this.handlers.forEach((h) => {
          try {
            h(msg as WsInMessage);
          } catch (error) {
            console.error('[ws] onMessage handler failed', error, msg);
          }
        });

        // Dispatch to event-specific handlers
        const eventType = msg.type as string;
        if (this.eventHandlers.has(eventType)) {
          this.eventHandlers.get(eventType)!.forEach((handler) => {
            try {
              handler(msg);
            } catch (error) {
              console.error(`[ws] onEvent(${eventType}) handler failed`, error, msg);
            }
          });
        }
      } catch (error) {
        console.error('[ws] failed to process message', error, evt.data);
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      if (this.intentionalDisconnect) {
        this.intentionalDisconnect = false;
        return;
      }
      console.log('[ws] disconnected, reconnecting in 3s...');
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(data: Record<string, any>) {
    // Auto-inject log_id for all outgoing messages if not provided
    if (!data.log_id) {
      data.log_id = this.genLogId();
    }
    const shouldPersistUntilReceipt = OUTBOX_MESSAGE_TYPES.has(String(data.type ?? ""));
    let persistedUntilReceipt = false;
    let indexedPersistence = Promise.resolve(false);
    if (shouldPersistUntilReceipt) {
      const outbox = readOutbox().filter((item) => item.log_id !== data.log_id);
      persistedUntilReceipt = writeOutbox([...outbox, data]);
      indexedPersistence = persistIndexedOutboxMessage(data);
    }

    if (this.ws?.readyState !== WebSocket.OPEN || this.outboxFlush) {
      // Queue message if not intentionally disconnected
      if (!this.intentionalDisconnect && (this.outboxFlush !== null || !shouldPersistUntilReceipt || !persistedUntilReceipt)) {
        this.pendingMessages.push(data);
      }
      console.warn('[ws] not connected, message queued');
      return;
    }
    if (shouldPersistUntilReceipt && !persistedUntilReceipt) {
      void indexedPersistence.then(() => {
        if (this.ws?.readyState === WebSocket.OPEN && !this.outboxFlush) {
          this.sendRaw(data);
        } else if (!this.intentionalDisconnect) {
          this.pendingMessages.push(data);
        }
      });
      return;
    }
    this.sendRaw(data);
  }

  private sendRaw(data: Record<string, any>, expectedSocket?: WebSocket) {
    const socket = expectedSocket ?? this.ws;
    if (!socket || this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    const logId = data.log_id;
    console.log(`[ws][${logId}] → send`, data.type, data.flow_id?.slice(0, 12),
      data.content?.slice(0, 50) || '');
    socket.send(JSON.stringify({ data }));
  }

  private async flushPersistedMessages(socket: WebSocket) {
    const indexedRecords = await readIndexedOutbox();
    if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    const localOutbox = readOutbox();
    const indexedLogIds = new Set(indexedRecords.map((record) => record.logId));
    const replay = [
      ...indexedRecords.map((record) => record.data),
      ...localOutbox.filter((data) => !indexedLogIds.has(data.log_id)),
      ...this.pendingMessages.splice(0),
    ];
    const sentLogIds = new Set<string>();
    for (const data of replay) {
      const logId = typeof data.log_id === "string" ? data.log_id : "";
      if (logId && sentLogIds.has(logId)) continue;
      if (logId) sentLogIds.add(logId);
      this.sendRaw(data, socket);
    }
  }

  private sendSubscriptionMessage(type: "flow:subscribe" | "flow:unsubscribe", flowId: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    const data = {
      type,
      flow_id: flowId,
      log_id: this.genLogId(),
    };
    const logId = data.log_id;
    console.log(`[ws][${logId}] → send`, data.type, data.flow_id.slice(0, 12), '');
    this.ws.send(JSON.stringify({ data }));
  }

  sendFlowSubscribe(flowId: string) {
    const refCount = this.subscriptionRefs.get(flowId) ?? 0;
    this.subscriptionRefs.set(flowId, refCount + 1);
    if (refCount === 0) {
      this.subscribedFlowIds.add(flowId);
    }
    this.sendSubscriptionMessage("flow:subscribe", flowId);
  }

  sendFlowUnsubscribe(flowId: string) {
    const refCount = this.subscriptionRefs.get(flowId) ?? 0;
    if (refCount > 1) {
      this.subscriptionRefs.set(flowId, refCount - 1);
      return;
    }
    this.subscriptionRefs.delete(flowId);

    this.subscribedFlowIds.delete(flowId);
    this.sendSubscriptionMessage("flow:unsubscribe", flowId);
  }

  sendSessionGet(
    flowId: string,
    _stage: string,
    agentSessionId?: string,
    flowExpertId?: string,
  ) {
    this.send({
      type: "session:get",
      flow_id: flowId,
      ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
      ...(flowExpertId ? { flow_expert_id: flowExpertId } : {}),
      session_id: "",
    });
  }

  sendClientDiagnostic(input: {
    flowId: string;
    event: "flow_switch_started" | "flow_switch_ready" | "flow_switch_failed";
    durationMs?: number;
    errorCode?: string;
    leaderAgentSessionId?: string;
  }) {
    this.send({
      type: "client:diagnostic",
      flow_id: input.flowId,
      event: input.event,
      ...(input.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(input.durationMs)) } : {}),
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      ...(input.leaderAgentSessionId ? { leader_agent_session_id: input.leaderAgentSessionId } : {}),
    });
  }

  sendUserTurnCancel(flowId: string, userTurnId: string) {
    this.send({
      type: "user_turn:cancel",
      flow_id: flowId,
      user_turn_id: userTurnId,
    });
  }

  sendRunSpec(flowId: string, specApprovalId: string) {
    this.send({ type: "flow:run_spec", flow_id: flowId, spec_approval_id: specApprovalId });
  }

  sendFlowGuide(
    flowId: string,
    content: string,
    clientMessageId: string,
    logId?: string,
    attachments?: OutgoingMessageImageAttachment[],
    planFeedback?: PlanFeedbackDraft[],
  ) {
    this.send({
      type: "flow:guide",
      flow_id: flowId,
      content,
      ...(attachments?.length ? { attachments } : {}),
      ...(planFeedback?.length ? { plan_feedback: planFeedback.map((feedback) => ({ id: feedback.id, plan_revision_id: feedback.planRevisionId, plan_node_id: feedback.planNodeId, marker_number: feedback.markerNumber, comment: feedback.comment })) } : {}),
      client_message_id: clientMessageId,
      ...(logId ? { log_id: logId } : {}),
    });
  }

  onMessage(handler: WsMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onEvent(type: string, handler: WsEventHandler): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }
    this.eventHandlers.get(type)!.add(handler);
    return () => {
      this.eventHandlers.get(type)?.delete(handler);
    };
  }

  disconnect() {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}

export const wsClient = new SquadFlowWs();

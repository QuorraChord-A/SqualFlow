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
  started_at: string;
};

export type WsInMessage =
  | { type: "flow:state"; flow_id: string; data: any }
  | { type: "flow:guide_ack"; flow_id: string; log_id?: string; data: { accepted: boolean; message_id: string; client_message_id?: string | null; leader_agent_session_id?: string } }
  | { type: "session:transcript_event"; flow_id: string; session_id: string; agent_session_id?: string; flow_expert_id?: string; data: { cursor: number; event: any } }
  | { type: "session:transcript_snapshot"; flow_id: string; session_id?: string; agent_session_id?: string; flow_expert_id?: string; data: { cursor: number; messages: UIMessage[]; history_boundaries?: HistorySessionBoundary[]; active_turn?: TranscriptActiveTurn }; pending_cards?: any[]; decision_cards?: any[] }
  | { type: "flow:status"; flow_id: string; data: any }
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

export class SquadFlowWs {
  private ws: WebSocket | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private eventHandlers: Map<string, Set<WsEventHandler>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private _connected = false;
  private _logSeq = 0;
  private pendingMessages: Record<string, any>[] = [];
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

      while (this.pendingMessages.length > 0) {
        const data = this.pendingMessages.shift()!;
        this.ws!.send(JSON.stringify({ data }));
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        const logId = msg.log_id || '';
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

    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Queue message if not intentionally disconnected
      if (!this.intentionalDisconnect) {
        this.pendingMessages.push(data);
      }
      console.warn('[ws] not connected, message queued');
      return;
    }
    const logId = data.log_id;
    console.log(`[ws][${logId}] → send`, data.type, data.flow_id?.slice(0, 12),
      data.content?.slice(0, 50) || '');
    this.ws.send(JSON.stringify({ data }));
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

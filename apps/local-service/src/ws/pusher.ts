import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { transcriptEventFromChunk, type SessionTranscriptEvent } from "../protocol/sessionTranscript.js";
import type { ChatJournal } from "./chatJournal.js";
import type { EventBus } from "./eventBus.js";

type PushedChunk = UiMessageChunk & { log_id?: string };

export type InterruptedTurnTiming = {
  messageId: string;
  startedAt: string | null;
  finishedAt: string;
  durationMs: number | null;
};

export async function finishInterruptedTurn(input: {
  flowId: string;
  sessionId: string;
  transcriptId: string;
  agentSessionId: string;
  flowExpertId: string;
  eventBus: EventBus;
  chatJournal: ChatJournal;
  logId?: string;
  finishedAt?: string;
}): Promise<InterruptedTurnTiming | null> {
  const active = input.chatJournal.getActiveTurn(input.flowId, input.sessionId);
  if (!active) return null;

  const startedAt = active.message.metadata?.turnTiming?.startedAt
    ?? active.message.createdAt
    ?? null;
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const finishedAtMs = Date.parse(finishedAt);
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : null;
  const chunk: UiMessageChunk = {
    type: "finish",
    messageId: active.message.id,
    seq: 0,
    durationMs,
    finishedAt,
  };
  const result = input.chatJournal.record(
    input.flowId,
    input.sessionId,
    chunk,
    input.transcriptId,
    input.agentSessionId,
  );
  if (result.ignored) return null;

  await input.eventBus.publish(input.flowId, {
    type: "session:transcript_event",
    flow_id: input.flowId,
    session_id: input.sessionId,
    agent_session_id: input.agentSessionId,
    flow_expert_id: input.flowExpertId,
    ...(input.logId ? { log_id: input.logId } : {}),
    data: {
      stream_epoch: input.chatJournal.getStreamEpoch(),
      cursor: result.cursor,
      event: withCanonicalMessageId(transcriptEventFromChunk(chunk), result.messageId),
      ...(result.removedMessageIds?.length ? { removed_message_ids: result.removedMessageIds } : {}),
    },
  });

  return {
    messageId: result.messageId ?? active.message.id,
    startedAt,
    finishedAt,
    durationMs,
  };
}

export class WsPusher {
  private readonly flowExpertId: string;
  private readonly transcriptId: string;

  constructor(
    private readonly flowId: string,
    private readonly getSessionId: () => string,
    private readonly agentSessionId: string,
    private readonly eventBus: EventBus,
    private readonly chatJournal: ChatJournal,
    private readonly onOutputCompleted?: (flowId: string) => Promise<void> | void,
    flowExpertId?: string,
    transcriptId?: string,
  ) {
    this.flowExpertId = flowExpertId ?? agentSessionId;
    this.transcriptId = transcriptId ?? this.flowExpertId;
  }

  async consume(event: PushedChunk): Promise<void> {
    const { log_id: logId, ...chunk } = event;
    const sessionId = this.getSessionId();

    const result = this.chatJournal.record(
      this.flowId,
      sessionId,
      chunk,
      this.transcriptId,
      this.agentSessionId,
    );
    if (result.ignored) return;
    const transcriptEvent = withCanonicalMessageId(transcriptEventFromChunk(chunk), result.messageId);

    await this.eventBus.publish(this.flowId, {
      type: "session:transcript_event",
      flow_id: this.flowId,
      session_id: sessionId,
      agent_session_id: this.agentSessionId,
      flow_expert_id: this.flowExpertId,
      ...(logId ? { log_id: logId } : {}),
      data: {
        stream_epoch: this.chatJournal.getStreamEpoch(),
        cursor: result.cursor,
        event: transcriptEvent,
        ...(result.removedMessageIds?.length ? { removed_message_ids: result.removedMessageIds } : {}),
        ...(result.activeTurn ? {
          active_turn: {
            message_id: result.activeTurn.messageId,
            root_message_id: result.activeTurn.rootMessageId,
            segment_index: result.activeTurn.segmentIndex,
            started_at: result.activeTurn.startedAt,
          },
        } : {}),
      },
    });
    if (chunk.type === "finish") {
      await this.onOutputCompleted?.(this.flowId);
    }
  }

  async publishUserMessage(
    content: string,
    messageId: string,
    createdAt?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = this.getSessionId();
    const commit = this.chatJournal.recordUserMessage(
      this.flowId,
      sessionId,
      content,
      messageId,
      createdAt,
      this.transcriptId,
      metadata,
      this.agentSessionId,
    );
    await this.publishMessageAdded(sessionId, commit);
  }

  async publishRunningGuide(content: string, messageId: string, createdAt?: string): Promise<void> {
    await this.publishUserMessage(content, messageId, createdAt, {
      localMessageKind: "running-guide",
      guideStatusLabel: "已引导对话",
    });
  }

  private async publishMessageAdded(
    sessionId: string,
    commit: ReturnType<ChatJournal["recordUserMessage"]>,
  ): Promise<void> {
    await this.eventBus.publish(this.flowId, {
      type: "session:transcript_event",
      flow_id: this.flowId,
      session_id: sessionId,
      agent_session_id: this.agentSessionId,
      flow_expert_id: this.flowExpertId,
      data: {
        stream_epoch: this.chatJournal.getStreamEpoch(),
        cursor: commit.cursor,
        event: { type: "message-added", message: commit.message },
        ...(commit.removedMessageIds?.length ? { removed_message_ids: commit.removedMessageIds } : {}),
        ...(commit.activeTurn ? {
          active_turn: {
            message_id: commit.activeTurn.messageId,
            root_message_id: commit.activeTurn.rootMessageId,
            segment_index: commit.activeTurn.segmentIndex,
            started_at: commit.activeTurn.startedAt,
          },
        } : {}),
      },
    });
  }
}

function withCanonicalMessageId(event: SessionTranscriptEvent, messageId: string | undefined): SessionTranscriptEvent {
  if (!messageId || !("messageId" in event)) return event;
  if (event.messageId === messageId) return event;
  return { ...event, messageId } as SessionTranscriptEvent;
}

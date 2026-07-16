import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { transcriptEventFromChunk, type SessionTranscriptEvent } from "../protocol/sessionTranscript.js";
import type { ChatJournal, ChatUIMessage } from "./chatJournal.js";
import type { EventBus } from "./eventBus.js";

type PushedChunk = UiMessageChunk & { log_id?: string };

export class WsPusher {
  private readonly flowExpertId: string;

  constructor(
    private readonly flowId: string,
    private readonly getSessionId: () => string,
    private readonly agentSessionId: string,
    private readonly eventBus: EventBus,
    private readonly chatJournal: ChatJournal,
    private readonly onOutputCompleted?: (flowId: string) => Promise<void> | void,
    flowExpertId?: string,
  ) {
    this.flowExpertId = flowExpertId ?? agentSessionId;
  }

  async consume(event: PushedChunk): Promise<void> {
    const { log_id: logId, ...chunk } = event;
    const sessionId = this.getSessionId();

    if (chunk.type === "finish") {
      await this.onOutputCompleted?.(this.flowId);
    }

    const result = this.chatJournal.record(this.flowId, sessionId, chunk, this.flowExpertId);
    const transcriptEvent = withCanonicalMessageId(transcriptEventFromChunk(chunk), result.messageId);

    await this.eventBus.publish(this.flowId, {
      type: "session:transcript_event",
      flow_id: this.flowId,
      session_id: sessionId,
      agent_session_id: this.agentSessionId,
      flow_expert_id: this.flowExpertId,
      ...(logId ? { log_id: logId } : {}),
      data: { cursor: result.cursor, event: transcriptEvent },
    });
  }

  async publishUserMessage(content: string, messageId: string, createdAt?: string): Promise<void> {
    const sessionId = this.getSessionId();
    const { cursor, message } = this.chatJournal.recordUserMessage(
      this.flowId,
      sessionId,
      content,
      messageId,
      createdAt,
      this.flowExpertId,
    );
    await this.publishMessageAdded(sessionId, cursor, message);
  }

  private async publishMessageAdded(sessionId: string, cursor: number, message: ChatUIMessage): Promise<void> {
    await this.eventBus.publish(this.flowId, {
      type: "session:transcript_event",
      flow_id: this.flowId,
      session_id: sessionId,
      agent_session_id: this.agentSessionId,
      flow_expert_id: this.flowExpertId,
      data: { cursor, event: { type: "message-added", message } },
    });
  }
}

function withCanonicalMessageId(event: SessionTranscriptEvent, messageId: string | undefined): SessionTranscriptEvent {
  if (!messageId || !("messageId" in event)) return event;
  if (event.messageId === messageId) return event;
  return { ...event, messageId } as SessionTranscriptEvent;
}

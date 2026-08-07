import type { ChatUIMessage } from "./chatJournal.js";

export type TurnTiming = {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

export type PersistedTurnTiming = TurnTiming & {
  sdkSessionId: string;
  messageId: string;
};

export function persistedTurnTimings(
  events: Array<{ eventType: string; payloadJson: string; sequence: number }>,
  sdkSessionId: string,
): PersistedTurnTiming[] {
  return events
    .filter((event) => event.eventType === "agent_run.turn_completed")
    .map((event) => {
      const payload = safeParseJson(event.payloadJson);
      const sdkSessionIdValue = payload?.provider_session_id;
      if (sdkSessionIdValue !== sdkSessionId) return null;
      const duration = payload?.duration_ms;
      return {
        sdkSessionId,
        messageId: typeof payload?.message_id === "string" ? payload.message_id : "",
        startedAt: typeof payload?.started_at === "string" ? payload.started_at : null,
        finishedAt: typeof payload?.finished_at === "string" ? payload.finished_at : null,
        durationMs: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
      };
    })
    .filter((timing): timing is PersistedTurnTiming => timing !== null && timing.messageId !== "");
}

export function mergeTurnTimings(messages: ChatUIMessage[], timings: PersistedTurnTiming[]): ChatUIMessage[] {
  const assistantIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndexes.push(index);
    }
  }

  const timingIndex = timings.length - 1;
  const messageIndex = assistantIndexes.length - 1;
  const count = Math.min(timings.length, assistantIndexes.length);

  if (count === 0) return messages;

  const next = [...messages];
  for (let offset = 0; offset < count; offset += 1) {
    const timing = timings[timingIndex - offset];
    const targetIndex = assistantIndexes[messageIndex - offset];
    if (!timing || targetIndex === undefined) break;
    const message = next[targetIndex];
    if (!message || message.role !== "assistant") continue;
    next[targetIndex] = {
      ...message,
      metadata: {
        ...message.metadata,
        turnTiming: {
          startedAt: timing.startedAt,
          finishedAt: timing.finishedAt,
          durationMs: timing.durationMs,
        },
      },
    };
  }

  return next;
}

function safeParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

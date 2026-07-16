import type { UiMessageChunk } from "./uiMessageChunks.js";

export type SessionTranscriptEvent =
  | { type: "message-added"; message: unknown }
  | { type: "turn-started"; messageId: string; startedAt?: string }
  | Exclude<UiMessageChunk, { type: "start" | "finish" }>
  | { type: "turn-finished"; messageId: string; durationMs: number | null; finishedAt: string };

export function transcriptEventFromChunk(chunk: UiMessageChunk): SessionTranscriptEvent {
  if (chunk.type === "start") {
    return { type: "turn-started", messageId: chunk.messageId, ...(chunk.startedAt ? { startedAt: chunk.startedAt } : {}) };
  }
  if (chunk.type === "finish") {
    return {
      type: "turn-finished",
      messageId: chunk.messageId,
      durationMs: chunk.durationMs,
      finishedAt: chunk.finishedAt,
    };
  }
  return chunk;
}

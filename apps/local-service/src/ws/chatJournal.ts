import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { isRuntimeCapability, type RuntimeCapability } from "../domain/runtimeCapabilities.js";

type TextPart = { type: "text"; id?: string; text: string };
type ReasoningPart = { type: "reasoning"; id?: string; text: string; state: "done" };
type ToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  capability?: RuntimeCapability;
  providerToolName?: string;
  state: "input-streaming" | "input-available" | "output-available";
  inputText: string;
  input: Record<string, unknown> | null;
  output: { content: string; is_error: boolean } | null;
};

type AssistantMessagePart = TextPart | ReasoningPart | ToolPart;

export type TurnTiming = {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

export type AssistantUIMessage = {
  id: string;
  role: "assistant";
  parts: AssistantMessagePart[];
  content: string;
  createdAt?: string;
  metadata?: { turnTiming?: TurnTiming };
};

type UserUIMessage = {
  id: string;
  role: "user";
  parts: TextPart[];
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type ChatUIMessage = AssistantUIMessage | UserUIMessage;

type JournalEvent = UiMessageChunk | Record<string, unknown>;

export type JournalRecordResult = {
  cursor: number;
  messageId?: string;
};

function keyFor(flowId: string, sessionId: string): string {
  return `${flowId}:${sessionId}`;
}

function stringValue(event: Record<string, unknown>, key: string): string {
  const value = event[key];
  return typeof value === "string" ? value : "";
}

function runtimeCapabilityValue(event: Record<string, unknown>): RuntimeCapability | undefined {
  const value = event.capability;
  return typeof value === "string" && isRuntimeCapability(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolOutput(value: unknown): value is { content: string; is_error: boolean } {
  return isRecord(value) && typeof value.content === "string" && typeof value.is_error === "boolean";
}

function isToolPart(part: AssistantMessagePart): part is ToolPart {
  return part.type.startsWith("tool-");
}

export class ChatJournal {
  private readonly current = new Map<string, AssistantUIMessage | null>();
  private readonly history = new Map<string, ChatUIMessage[]>();
  private readonly textIndex = new Map<string, number>();
  private readonly reasoningIndex = new Map<string, number>();
  private readonly cursors = new Map<string, number>();
  private readonly rootMessageIds = new Map<string, string>();
  private readonly segmentIndex = new Map<string, number>();
  private readonly pendingGuideMessages = new Map<string, UserUIMessage[]>();

  recordUserMessage(
    flowId: string,
    sessionId: string,
    content: string,
    messageId: string,
    createdAt?: string,
    transcriptId = sessionId,
    metadata?: Record<string, unknown>,
  ): { cursor: number; message: ChatUIMessage } {
    const key = keyFor(flowId, sessionId);
    const message: UserUIMessage = {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: content }],
      content,
      ...(createdAt ? { createdAt } : {}),
      ...(metadata ? { metadata } : {}),
    };
    if (metadata?.localMessageKind === "running-guide") {
      this.recordPendingGuideBoundary(flowId, sessionId, message);
      return { cursor: this.nextCursor(flowId, transcriptId), message };
    }
    this.appendHistory(flowId, sessionId, message);
    return { cursor: this.nextCursor(flowId, transcriptId), message };
  }

  record(flowId: string, sessionId: string, event: JournalEvent, transcriptId = sessionId): JournalRecordResult {
    const eventRecord = event as Record<string, unknown>;
    const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "";
    const key = keyFor(flowId, sessionId);

    if (eventType === "start") {
      const startedAt = stringValue(eventRecord, "startedAt") || new Date().toISOString();
      const messageId = stringValue(eventRecord, "messageId") || "msg-unknown";
      this.current.set(key, {
        id: messageId,
        role: "assistant",
        parts: [],
        content: "",
        createdAt: startedAt,
        metadata: { turnTiming: { startedAt, finishedAt: null, durationMs: null } },
      });
      this.rootMessageIds.set(key, messageId);
      this.segmentIndex.set(key, 0);
      this.textIndex.set(key, -1);
      this.reasoningIndex.set(key, -1);
      return { cursor: this.nextCursor(flowId, transcriptId), messageId };
    }

    const message = this.current.get(key);
    if (!message) return { cursor: this.nextCursor(flowId, transcriptId) };

    this.flushPendingGuideBoundaryBeforeEvent(flowId, sessionId, eventType);
    const activeMessage = this.current.get(key);
    if (!activeMessage) return { cursor: this.nextCursor(flowId, transcriptId) };
    let canonicalMessageId = activeMessage.id;

    switch (eventType) {
      case "text-start":
        activeMessage.parts.push({
          type: "text",
          ...(stringValue(eventRecord, "id") ? { id: stringValue(eventRecord, "id") } : {}),
          text: "",
        });
        this.textIndex.set(key, activeMessage.parts.length - 1);
        break;
      case "text-delta":
        this.currentTextPart(key, activeMessage, stringValue(eventRecord, "id")).text += stringValue(eventRecord, "delta");
        break;
      case "text-end":
        this.textIndex.set(key, -1);
        break;
      case "reasoning-start":
        activeMessage.parts.push({
          type: "reasoning",
          ...(stringValue(eventRecord, "id") ? { id: stringValue(eventRecord, "id") } : {}),
          text: "",
          state: "done",
        });
        this.reasoningIndex.set(key, activeMessage.parts.length - 1);
        break;
      case "reasoning-delta":
        this.currentReasoningPart(key, activeMessage, stringValue(eventRecord, "id")).text += stringValue(eventRecord, "delta");
        break;
      case "reasoning-end":
        this.reasoningIndex.set(key, -1);
        break;
      case "tool-input-start":
        this.currentToolPart(activeMessage, stringValue(eventRecord, "toolCallId"), stringValue(eventRecord, "toolName"), {
          capability: runtimeCapabilityValue(eventRecord),
          providerToolName: stringValue(eventRecord, "providerToolName"),
        }).state =
          "input-streaming";
        break;
      case "tool-input-delta":
        this.currentToolPart(activeMessage, stringValue(eventRecord, "toolCallId"), "").inputText += stringValue(
          eventRecord,
          "inputTextDelta",
        );
        break;
      case "tool-input-available": {
        const toolPart = this.currentToolPart(
          activeMessage,
          stringValue(eventRecord, "toolCallId"),
          stringValue(eventRecord, "toolName"),
          {
            capability: runtimeCapabilityValue(eventRecord),
            providerToolName: stringValue(eventRecord, "providerToolName"),
          },
        );
        toolPart.state = "input-available";
        toolPart.input = isRecord(eventRecord["input"]) ? eventRecord["input"] : null;
        break;
      }
      case "tool-output-available": {
        const toolPart = this.currentToolPart(activeMessage, stringValue(eventRecord, "toolCallId"), "");
        toolPart.state = "output-available";
        toolPart.output = isToolOutput(eventRecord["output"]) ? eventRecord["output"] : null;
        break;
      }
      case "finish":
        this.flushPendingGuideBoundaryBeforeFinish(flowId, sessionId);
        const finishingMessage = this.current.get(key);
        if (!finishingMessage) break;
        this.updateMessageContent(finishingMessage);
        if (finishingMessage.metadata?.turnTiming?.startedAt ?? finishingMessage.createdAt) {
          finishingMessage.metadata = {
            ...finishingMessage.metadata,
            turnTiming: {
              startedAt: finishingMessage.metadata?.turnTiming?.startedAt ?? finishingMessage.createdAt ?? null,
              finishedAt: stringValue(eventRecord, "finishedAt") || null,
              durationMs: typeof eventRecord.durationMs === "number" ? eventRecord.durationMs : null,
            },
          };
        }
        this.appendHistory(flowId, sessionId, finishingMessage);
        canonicalMessageId = finishingMessage.id;
        this.current.set(key, null);
        break;
    }
    this.flushPendingGuideBoundaryAfterEvent(flowId, sessionId, eventType);
    return { cursor: this.nextCursor(flowId, transcriptId), messageId: canonicalMessageId };
  }

  getCursor(flowId: string, transcriptId: string): number {
    return this.cursors.get(keyFor(flowId, transcriptId)) ?? 0;
  }

  getCurrentMessage(flowId: string, sessionId: string): AssistantUIMessage | null {
    return this.current.get(keyFor(flowId, sessionId)) ?? null;
  }

  getHistory(flowId: string, sessionId: string): ChatUIMessage[] {
    return [...(this.history.get(keyFor(flowId, sessionId)) ?? [])];
  }

  clear(flowId: string, sessionId: string): void {
    const key = keyFor(flowId, sessionId);
    this.current.delete(key);
    this.history.delete(key);
    this.textIndex.delete(key);
    this.reasoningIndex.delete(key);
    this.rootMessageIds.delete(key);
    this.segmentIndex.delete(key);
    this.pendingGuideMessages.delete(key);
  }

  renameSession(flowId: string, fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;

    const fromKey = keyFor(flowId, fromSessionId);
    const toKey = keyFor(flowId, toSessionId);
    const fromHistory = this.history.get(fromKey) ?? [];
    if (fromHistory.length > 0) {
      const toHistory = this.history.get(toKey) ?? [];
      this.history.set(toKey, [...toHistory, ...fromHistory]);
      this.history.delete(fromKey);
    }

    if (this.current.has(fromKey)) {
      this.current.set(toKey, this.current.get(fromKey) ?? null);
      this.current.delete(fromKey);
    }

    for (const indexMap of [this.textIndex, this.reasoningIndex]) {
      if (indexMap.has(fromKey)) {
        indexMap.set(toKey, indexMap.get(fromKey) ?? -1);
        indexMap.delete(fromKey);
      }
    }
    if (this.rootMessageIds.has(fromKey)) {
      this.rootMessageIds.set(toKey, this.rootMessageIds.get(fromKey) ?? "");
      this.rootMessageIds.delete(fromKey);
    }
    if (this.segmentIndex.has(fromKey)) {
      this.segmentIndex.set(toKey, this.segmentIndex.get(fromKey) ?? 0);
      this.segmentIndex.delete(fromKey);
    }
    if (this.pendingGuideMessages.has(fromKey)) {
      this.pendingGuideMessages.set(toKey, this.pendingGuideMessages.get(fromKey) ?? []);
      this.pendingGuideMessages.delete(fromKey);
    }
  }

  private nextCursor(flowId: string, transcriptId: string): number {
    const key = keyFor(flowId, transcriptId);
    const cursor = (this.cursors.get(key) ?? 0) + 1;
    this.cursors.set(key, cursor);
    return cursor;
  }

  private appendHistory(flowId: string, sessionId: string, message: ChatUIMessage): void {
    const key = keyFor(flowId, sessionId);
    const messages = this.history.get(key) ?? [];
    const existingIndex = messages.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) {
      const next = [...messages];
      next[existingIndex] = message;
      this.history.set(key, next);
      return;
    }
    this.history.set(key, [...messages, message]);
  }

  private recordPendingGuideBoundary(flowId: string, sessionId: string, message: UserUIMessage): void {
    const key = keyFor(flowId, sessionId);
    const current = this.current.get(key);
    if (!current) {
      this.appendHistory(flowId, sessionId, message);
      return;
    }
    const pending = this.pendingGuideMessages.get(key) ?? [];
    this.pendingGuideMessages.set(key, [...pending, message]);
    if (!this.hasMeaningfulParts(current)) {
      this.flushPendingGuides(flowId, sessionId);
      return;
    }
    if (this.canCloseAssistantSegment(current)) {
      this.closeCurrentSegmentBeforePendingGuides(flowId, sessionId);
    }
  }

  private flushPendingGuideBoundaryBeforeEvent(flowId: string, sessionId: string, eventType: string): void {
    const key = keyFor(flowId, sessionId);
    if (!this.hasPendingGuides(key)) return;
    const current = this.current.get(key);
    if (!current) {
      this.flushPendingGuides(flowId, sessionId);
      return;
    }
    if (!this.hasMeaningfulParts(current)) {
      this.flushPendingGuides(flowId, sessionId);
      return;
    }
    if (this.isAssistantContentStart(eventType) && this.canCloseAssistantSegment(current)) {
      this.closeCurrentSegmentBeforePendingGuides(flowId, sessionId);
    }
  }

  private flushPendingGuideBoundaryAfterEvent(flowId: string, sessionId: string, eventType: string): void {
    const key = keyFor(flowId, sessionId);
    if (!this.hasPendingGuides(key) || !this.isSafeBoundaryEvent(eventType)) return;
    const current = this.current.get(key);
    if (current && this.canCloseAssistantSegment(current)) {
      this.closeCurrentSegmentBeforePendingGuides(flowId, sessionId);
    }
  }

  private flushPendingGuideBoundaryBeforeFinish(flowId: string, sessionId: string): void {
    const key = keyFor(flowId, sessionId);
    if (!this.hasPendingGuides(key)) return;
    const current = this.current.get(key);
    if (current && this.hasMeaningfulParts(current)) {
      this.closeCurrentSegmentBeforePendingGuides(flowId, sessionId, false);
      return;
    }
    this.flushPendingGuides(flowId, sessionId);
  }

  private closeCurrentSegmentBeforePendingGuides(flowId: string, sessionId: string, createNextSegment = true): void {
    const key = keyFor(flowId, sessionId);
    const current = this.current.get(key);
    if (current && this.hasMeaningfulParts(current)) {
      this.updateMessageContent(current);
      this.appendHistory(flowId, sessionId, current);
    }
    this.flushPendingGuides(flowId, sessionId);
    if (createNextSegment && current) {
      this.current.set(key, this.createNextAssistantSegment(key, current));
      this.textIndex.set(key, -1);
      this.reasoningIndex.set(key, -1);
    } else {
      this.current.set(key, null);
    }
  }

  private flushPendingGuides(flowId: string, sessionId: string): void {
    const key = keyFor(flowId, sessionId);
    const pending = this.pendingGuideMessages.get(key) ?? [];
    if (pending.length === 0) return;
    for (const message of pending) {
      this.appendHistory(flowId, sessionId, message);
    }
    this.pendingGuideMessages.delete(key);
  }

  private createNextAssistantSegment(key: string, previous: AssistantUIMessage): AssistantUIMessage {
    const rootMessageId = this.rootMessageIds.get(key) || previous.id;
    const nextSegmentIndex = (this.segmentIndex.get(key) ?? 0) + 1;
    this.segmentIndex.set(key, nextSegmentIndex);
    const startedAt = previous.metadata?.turnTiming?.startedAt ?? previous.createdAt ?? null;
    return {
      id: `${rootMessageId}:guide-${nextSegmentIndex}`,
      role: "assistant",
      parts: [],
      content: "",
      ...(startedAt ? { createdAt: startedAt } : {}),
      metadata: { turnTiming: { startedAt, finishedAt: null, durationMs: null } },
    };
  }

  private hasPendingGuides(key: string): boolean {
    return (this.pendingGuideMessages.get(key)?.length ?? 0) > 0;
  }

  private updateMessageContent(message: AssistantUIMessage): void {
    message.content = message.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  private hasMeaningfulParts(message: AssistantUIMessage): boolean {
    return message.parts.some((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text.length > 0;
      return true;
    });
  }

  private canCloseAssistantSegment(message: AssistantUIMessage): boolean {
    return message.parts.every((part) => !isToolPart(part) || part.state === "output-available");
  }

  private isAssistantContentStart(eventType: string): boolean {
    return eventType === "text-start"
      || eventType === "text-delta"
      || eventType === "reasoning-start"
      || eventType === "reasoning-delta"
      || eventType === "tool-input-start"
      || eventType === "tool-input-delta"
      || eventType === "tool-input-available";
  }

  private isSafeBoundaryEvent(eventType: string): boolean {
    return eventType === "text-end"
      || eventType === "reasoning-end"
      || eventType === "tool-output-available";
  }

  private currentTextPart(key: string, message: AssistantUIMessage, blockId: string): TextPart {
    const idx = this.textIndex.get(key) ?? -1;
    const part = message.parts[idx];
    if (idx >= 0 && part?.type === "text" && (!blockId || part.id === blockId)) return part;

    const existing = blockId
      ? message.parts.find((item): item is TextPart => item.type === "text" && item.id === blockId)
      : undefined;
    if (existing) {
      this.textIndex.set(key, message.parts.indexOf(existing));
      return existing;
    }

    const newPart: TextPart = { type: "text", ...(blockId ? { id: blockId } : {}), text: "" };
    message.parts.push(newPart);
    this.textIndex.set(key, message.parts.length - 1);
    return newPart;
  }

  private currentReasoningPart(key: string, message: AssistantUIMessage, blockId: string): ReasoningPart {
    const idx = this.reasoningIndex.get(key) ?? -1;
    const part = message.parts[idx];
    if (idx >= 0 && part?.type === "reasoning" && (!blockId || part.id === blockId)) return part;

    const existing = blockId
      ? message.parts.find((item): item is ReasoningPart => item.type === "reasoning" && item.id === blockId)
      : undefined;
    if (existing) {
      this.reasoningIndex.set(key, message.parts.indexOf(existing));
      return existing;
    }

    const newPart: ReasoningPart = {
      type: "reasoning",
      ...(blockId ? { id: blockId } : {}),
      text: "",
      state: "done",
    };
    message.parts.push(newPart);
    this.reasoningIndex.set(key, message.parts.length - 1);
    return newPart;
  }

  private currentToolPart(
    message: AssistantUIMessage,
    toolCallId: string,
    toolName: string,
    metadata: { capability?: RuntimeCapability; providerToolName?: string } = {},
  ): ToolPart {
    const existing = message.parts.find((part): part is ToolPart => isToolPart(part) && part.toolCallId === toolCallId);
    if (existing) {
      if (toolName && existing.toolName !== toolName) {
        existing.toolName = toolName;
        existing.type = `tool-${toolName}`;
      }
      if (metadata.capability) existing.capability = metadata.capability;
      if (metadata.providerToolName) existing.providerToolName = metadata.providerToolName;
      return existing;
    }

    const name = toolName || "unknown";
    const newPart: ToolPart = {
      type: `tool-${name}`,
      toolCallId,
      toolName: name,
      ...(metadata.capability ? { capability: metadata.capability } : {}),
      ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
      state: "input-available",
      inputText: "",
      input: null,
      output: null,
    };
    message.parts.push(newPart);
    return newPart;
  }
}

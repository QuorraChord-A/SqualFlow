import { randomUUID } from "node:crypto";
import type { UiMcpIcon, UiMcpResult, UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { isRuntimeCapability, type RuntimeCapability } from "../domain/runtimeCapabilities.js";
import type { CanonicalTranscriptEntry, Store } from "../db/store.js";

type TextPart = { type: "text"; id?: string; text: string };
type ReasoningPart = { type: "reasoning"; id?: string; text: string; state: "done" };
type ToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  capability?: RuntimeCapability;
  providerToolName?: string;
  mcp?: {
    server: string;
    tool: string;
    title?: string;
    icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
    serverIcons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  };
  state: "input-streaming" | "input-available" | "output-available";
  inputText: string;
  input: Record<string, unknown> | null;
  output: { content: string; is_error: boolean; mcp?: UiMcpResult } | null;
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
  ignored?: boolean;
  removedMessageIds?: string[];
  activeTurn?: {
    messageId: string;
    rootMessageId: string;
    segmentIndex: number;
    startedAt: string;
  };
};

type TranscriptPersistence = Pick<
  Store,
  | "commitTranscriptMutation"
  | "getTranscriptCursor"
  | "listTranscriptEntries"
  | "renameTranscriptSession"
>;

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

function isToolOutput(value: unknown): value is { content: string; is_error: boolean; mcp?: UiMcpResult } {
  return isRecord(value) && typeof value.content === "string" && typeof value.is_error === "boolean";
}

function isToolPart(part: AssistantMessagePart): part is ToolPart {
  return part.type.startsWith("tool-");
}

function stripTransientMcpIcons(message: ChatUIMessage): ChatUIMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolPart(part) || !part.mcp) return part;
      const { icons: _icons, serverIcons: _serverIcons, ...mcp } = part.mcp;
      return { ...part, mcp };
    }),
  };
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
  private readonly dirtyMessageIds = new Map<string, Set<string>>();
  private readonly removedMessageIds = new Map<string, Set<string>>();
  private readonly transcriptSessions = new Map<string, Set<string>>();
  private readonly agentSessionIds = new Map<string, string>();

  constructor(
    private readonly persistence?: TranscriptPersistence,
    private readonly streamEpoch = randomUUID(),
  ) {}

  getStreamEpoch(): string {
    return this.streamEpoch;
  }

  recordUserMessage(
    flowId: string,
    sessionId: string,
    content: string,
    messageId: string,
    createdAt?: string,
    transcriptId = sessionId,
    metadata?: Record<string, unknown>,
    agentSessionId = transcriptId,
  ): { cursor: number; message: ChatUIMessage } & Pick<JournalRecordResult, "removedMessageIds" | "activeTurn"> {
    const key = keyFor(flowId, sessionId);
    this.registerSession(flowId, sessionId, transcriptId, agentSessionId);
    const message: UserUIMessage = {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: content }],
      content,
      ...(createdAt ? { createdAt } : {}),
      ...(metadata ? { metadata } : {}),
    };
    if (metadata?.localMessageKind === "running-guide") {
      const activeMessageIdBefore = this.current.get(key)?.id;
      const removedMessageIds = this.recordPendingGuideBoundary(flowId, sessionId, message);
      const cursor = this.commitMutation(flowId, sessionId, transcriptId, agentSessionId);
      const activeTurn = this.activeTurnAfterTransition(flowId, sessionId, activeMessageIdBefore);
      return {
        cursor,
        message,
        ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
        ...(activeTurn ? { activeTurn } : {}),
      };
    }
    this.appendHistory(flowId, sessionId, message);
    return { cursor: this.commitMutation(flowId, sessionId, transcriptId, agentSessionId), message };
  }

  record(
    flowId: string,
    sessionId: string,
    event: JournalEvent,
    transcriptId = sessionId,
    agentSessionId = transcriptId,
  ): JournalRecordResult {
    const eventRecord = event as Record<string, unknown>;
    const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "";
    const key = keyFor(flowId, sessionId);
    this.registerSession(flowId, sessionId, transcriptId, agentSessionId);

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
      this.markMessageDirty(flowId, sessionId, messageId);
      return { cursor: this.commitMutation(flowId, sessionId, transcriptId, agentSessionId), messageId };
    }

    const message = this.current.get(key);
    if (!message) return { cursor: this.getCursor(flowId, transcriptId), ignored: true };
    const activeMessageIdBefore = message.id;

    this.flushPendingGuideBoundaryBeforeEvent(flowId, sessionId, eventType);
    const activeMessage = this.current.get(key);
    if (!activeMessage) return { cursor: this.getCursor(flowId, transcriptId), ignored: true };
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
          mcp: mcpMetadataValue(eventRecord.mcp),
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
            mcp: mcpMetadataValue(eventRecord.mcp),
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
    const currentAfterEvent = this.current.get(key);
    if (currentAfterEvent) this.updateMessageContent(currentAfterEvent);
    this.markMessageDirty(flowId, sessionId, canonicalMessageId);
    const cursor = this.commitMutation(flowId, sessionId, transcriptId, agentSessionId);
    const activeTurn = this.activeTurnAfterTransition(flowId, sessionId, activeMessageIdBefore);
    return {
      cursor,
      messageId: canonicalMessageId,
      ...(activeTurn ? { activeTurn } : {}),
    };
  }

  getCursor(flowId: string, transcriptId: string): number {
    if (this.persistence) return this.persistence.getTranscriptCursor(flowId, transcriptId);
    return this.cursors.get(keyFor(flowId, transcriptId)) ?? 0;
  }

  getTranscriptEntries(flowId: string, transcriptId: string): CanonicalTranscriptEntry[] {
    if (this.persistence) return this.persistence.listTranscriptEntries(flowId, transcriptId);
    const transcriptKey = keyFor(flowId, transcriptId);
    const sessionIds = this.transcriptSessions.get(transcriptKey) ?? new Set([transcriptId]);
    let position = 0;
    const entries: CanonicalTranscriptEntry[] = [];
    const seen = new Set<string>();
    for (const sessionId of sessionIds) {
      const sessionKey = keyFor(flowId, sessionId);
      const messages = this.messagesForPersistence(flowId, sessionId);
      for (const item of messages) {
        if (seen.has(item.message.id)) continue;
        seen.add(item.message.id);
        const timestamp = typeof item.message.createdAt === "string" ? item.message.createdAt : "";
        entries.push({
          flowId,
          channelId: transcriptId,
          messageId: item.message.id,
          position: ++position,
          sessionId,
          agentSessionId: this.agentSessionIds.get(sessionKey) ?? transcriptId,
          lifecycle: item.lifecycle,
          message: item.message as unknown as Record<string, unknown>,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
    return entries;
  }

  getTranscriptMessages(flowId: string, transcriptId: string): ChatUIMessage[] {
    return this.getTranscriptEntries(flowId, transcriptId)
      .map((entry) => entry.message as ChatUIMessage);
  }

  getCurrentMessage(flowId: string, sessionId: string): AssistantUIMessage | null {
    return this.current.get(keyFor(flowId, sessionId)) ?? null;
  }

  getActiveTurn(flowId: string, sessionId: string): {
    message: AssistantUIMessage;
    rootMessageId: string;
    segmentIndex: number;
  } | null {
    const key = keyFor(flowId, sessionId);
    const message = this.current.get(key);
    if (!message) return null;
    return {
      message,
      rootMessageId: this.rootMessageIds.get(key) ?? message.id,
      segmentIndex: this.segmentIndex.get(key) ?? 0,
    };
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
    this.dirtyMessageIds.delete(key);
    this.removedMessageIds.delete(key);
  }

  renameSession(flowId: string, fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
    this.persistence?.renameTranscriptSession(flowId, fromSessionId, toSessionId);

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
    if (this.dirtyMessageIds.has(fromKey)) {
      this.dirtyMessageIds.set(toKey, new Set([
        ...(this.dirtyMessageIds.get(toKey) ?? []),
        ...(this.dirtyMessageIds.get(fromKey) ?? []),
      ]));
      this.dirtyMessageIds.delete(fromKey);
    }
    if (this.removedMessageIds.has(fromKey)) {
      this.removedMessageIds.set(toKey, new Set([
        ...(this.removedMessageIds.get(toKey) ?? []),
        ...(this.removedMessageIds.get(fromKey) ?? []),
      ]));
      this.removedMessageIds.delete(fromKey);
    }
    if (this.agentSessionIds.has(fromKey)) {
      this.agentSessionIds.set(toKey, this.agentSessionIds.get(fromKey) ?? "");
      this.agentSessionIds.delete(fromKey);
    }
    for (const sessions of this.transcriptSessions.values()) {
      if (!sessions.delete(fromSessionId)) continue;
      sessions.add(toSessionId);
    }
  }

  private nextCursor(flowId: string, transcriptId: string): number {
    const key = keyFor(flowId, transcriptId);
    const cursor = (this.cursors.get(key) ?? 0) + 1;
    this.cursors.set(key, cursor);
    return cursor;
  }

  private registerSession(
    flowId: string,
    sessionId: string,
    transcriptId: string,
    agentSessionId: string,
  ): void {
    const transcriptKey = keyFor(flowId, transcriptId);
    const sessions = this.transcriptSessions.get(transcriptKey) ?? new Set<string>();
    sessions.add(sessionId);
    this.transcriptSessions.set(transcriptKey, sessions);
    this.agentSessionIds.set(keyFor(flowId, sessionId), agentSessionId);
  }

  private messagesForPersistence(
    flowId: string,
    sessionId: string,
    onlyMessageIds?: ReadonlySet<string>,
  ): Array<{ message: ChatUIMessage; lifecycle: "active" | "complete" }> {
    const key = keyFor(flowId, sessionId);
    const ordered = new Map<string, { message: ChatUIMessage; lifecycle: "active" | "complete" }>();
    for (const message of this.history.get(key) ?? []) {
      ordered.set(message.id, { message, lifecycle: "complete" });
    }
    const current = this.current.get(key);
    if (current) ordered.set(current.id, { message: current, lifecycle: "active" });
    for (const message of this.pendingGuideMessages.get(key) ?? []) {
      ordered.set(message.id, { message, lifecycle: "complete" });
    }
    if (!onlyMessageIds) return [...ordered.values()];
    return [...ordered.values()].filter((item) => onlyMessageIds.has(item.message.id));
  }

  private commitMutation(
    flowId: string,
    sessionId: string,
    transcriptId: string,
    agentSessionId: string,
  ): number {
    const sessionKey = keyFor(flowId, sessionId);
    if (!this.persistence) {
      this.dirtyMessageIds.delete(sessionKey);
      this.removedMessageIds.delete(sessionKey);
      return this.nextCursor(flowId, transcriptId);
    }
    try {
      const dirtyMessageIds = this.dirtyMessageIds.get(sessionKey) ?? new Set<string>();
      const cursor = this.persistence.commitTranscriptMutation({
        flowId,
        channelId: transcriptId,
        sessionId,
        agentSessionId,
        messages: this.messagesForPersistence(flowId, sessionId, dirtyMessageIds).map((item) => ({
          // MCP server icons are runtime metadata. Keep them on the live
          // message for the current Flow, but never persist them because the
          // next Flow may discover a different server/icon set.
          message: stripTransientMcpIcons(item.message) as unknown as Record<string, unknown>,
          lifecycle: item.lifecycle,
        })),
        removedMessageIds: [...(this.removedMessageIds.get(sessionKey) ?? [])],
      });
      this.dirtyMessageIds.delete(sessionKey);
      this.removedMessageIds.delete(sessionKey);
      return cursor;
    } catch (error) {
      this.clearMemorySession(flowId, sessionId);
      throw error;
    }
  }

  private clearMemorySession(flowId: string, sessionId: string): void {
    const key = keyFor(flowId, sessionId);
    this.current.delete(key);
    this.history.delete(key);
    this.textIndex.delete(key);
    this.reasoningIndex.delete(key);
    this.rootMessageIds.delete(key);
    this.segmentIndex.delete(key);
    this.pendingGuideMessages.delete(key);
    this.dirtyMessageIds.delete(key);
    this.removedMessageIds.delete(key);
    this.agentSessionIds.delete(key);
  }

  private markMessageRemoved(flowId: string, sessionId: string, messageId: string): void {
    const key = keyFor(flowId, sessionId);
    const removed = this.removedMessageIds.get(key) ?? new Set<string>();
    removed.add(messageId);
    this.removedMessageIds.set(key, removed);
  }

  private markMessageDirty(flowId: string, sessionId: string, messageId: string): void {
    if (!messageId) return;
    const key = keyFor(flowId, sessionId);
    const dirty = this.dirtyMessageIds.get(key) ?? new Set<string>();
    dirty.add(messageId);
    this.dirtyMessageIds.set(key, dirty);
  }

  private appendHistory(flowId: string, sessionId: string, message: ChatUIMessage): void {
    const key = keyFor(flowId, sessionId);
    const messages = this.history.get(key) ?? [];
    const existingIndex = messages.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) {
      const next = [...messages];
      next[existingIndex] = message;
      this.history.set(key, next);
      this.markMessageDirty(flowId, sessionId, message.id);
      return;
    }
    this.history.set(key, [...messages, message]);
    this.markMessageDirty(flowId, sessionId, message.id);
  }

  private recordPendingGuideBoundary(flowId: string, sessionId: string, message: UserUIMessage): string[] {
    const key = keyFor(flowId, sessionId);
    const current = this.current.get(key);
    if (!current) {
      this.appendHistory(flowId, sessionId, message);
      return [];
    }
    const pending = this.pendingGuideMessages.get(key) ?? [];
    this.pendingGuideMessages.set(key, [...pending, message]);
    this.markMessageDirty(flowId, sessionId, message.id);
    if (!this.hasMeaningfulParts(current)) {
      this.markMessageRemoved(flowId, sessionId, current.id);
      this.flushPendingGuides(flowId, sessionId);
      const nextAssistant = this.createNextAssistantSegment(key, current);
      this.current.set(key, nextAssistant);
      this.markMessageDirty(flowId, sessionId, nextAssistant.id);
      this.textIndex.set(key, -1);
      this.reasoningIndex.set(key, -1);
      return [current.id];
    }
    if (this.canCloseAssistantSegment(current)) {
      this.closeCurrentSegmentBeforePendingGuides(flowId, sessionId);
    }
    return [];
  }

  private activeTurnAfterTransition(
    flowId: string,
    sessionId: string,
    previousMessageId: string | undefined,
  ): JournalRecordResult["activeTurn"] {
    const active = this.getActiveTurn(flowId, sessionId);
    if (!active || active.message.id === previousMessageId) return undefined;
    return {
      messageId: active.message.id,
      rootMessageId: active.rootMessageId,
      segmentIndex: active.segmentIndex,
      startedAt: active.message.metadata?.turnTiming?.startedAt ?? active.message.createdAt ?? new Date().toISOString(),
    };
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
      const nextAssistant = this.createNextAssistantSegment(key, current);
      this.current.set(key, nextAssistant);
      this.markMessageDirty(flowId, sessionId, nextAssistant.id);
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
    metadata: {
      capability?: RuntimeCapability;
      providerToolName?: string;
      mcp?: ToolPart["mcp"];
    } = {},
  ): ToolPart {
    const existing = message.parts.find((part): part is ToolPart => isToolPart(part) && part.toolCallId === toolCallId);
    if (existing) {
      if (toolName && existing.toolName !== toolName) {
        existing.toolName = toolName;
        existing.type = `tool-${toolName}`;
      }
      if (metadata.capability) existing.capability = metadata.capability;
      if (metadata.providerToolName) existing.providerToolName = metadata.providerToolName;
      if (metadata.mcp) existing.mcp = metadata.mcp;
      return existing;
    }

    const name = toolName || "unknown";
    const newPart: ToolPart = {
      type: `tool-${name}`,
      toolCallId,
      toolName: name,
      ...(metadata.capability ? { capability: metadata.capability } : {}),
      ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
      ...(metadata.mcp ? { mcp: metadata.mcp } : {}),
      state: "input-available",
      inputText: "",
      input: null,
      output: null,
    };
    message.parts.push(newPart);
    return newPart;
  }
}

function mcpMetadataValue(value: unknown): ToolPart["mcp"] | undefined {
  if (!isRecord(value) || typeof value.server !== "string" || typeof value.tool !== "string") return undefined;
  const iconList = (input: unknown) => Array.isArray(input)
    ? input.flatMap((icon) => {
      if (!isRecord(icon) || typeof icon.src !== "string" || !icon.src) return [];
      const theme = icon.theme === "light" || icon.theme === "dark" ? icon.theme : undefined;
      return [{
        src: icon.src,
        ...(typeof icon.mimeType === "string" ? { mimeType: icon.mimeType } : {}),
        ...(Array.isArray(icon.sizes) ? { sizes: icon.sizes.filter((size): size is string => typeof size === "string") } : {}),
        ...(theme ? { theme } : {}),
      }] as UiMcpIcon[];
    })
    : undefined;
  return {
    server: value.server,
    tool: value.tool,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(iconList(value.icons) ? { icons: iconList(value.icons) } : {}),
    ...(iconList(value.serverIcons) ? { serverIcons: iconList(value.serverIcons) } : {}),
  };
}

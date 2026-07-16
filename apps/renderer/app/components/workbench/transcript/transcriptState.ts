import type { UIMessage } from "ai";
import type { HistorySessionBoundary } from "../../../lib/ws";
import type { TranscriptActiveTurn } from "../../../lib/ws";
import {
  computeFinishedTiming,
  deriveActivityFromMessage,
  readHistoryTurnTiming,
} from "./buildTranscriptTimeline";
import type { RuntimeCapability, TranscriptActivity } from "./types";
import type { TurnTiming } from "./buildTranscriptTimeline";

export type TranscriptStatus = "idle" | "submitted" | "streaming" | "ready";

export type TranscriptEvent =
  | { type: "message-added"; message: UIMessage }
  | { type: "turn-started"; messageId: string; startedAt?: string }
  | { type: "text-start"; messageId: string; id: string }
  | { type: "text-delta"; messageId: string; id: string; delta: string }
  | { type: "text-end"; messageId: string; id: string }
  | { type: "reasoning-start"; messageId: string; id: string }
  | { type: "reasoning-delta"; messageId: string; id: string; delta: string }
  | { type: "reasoning-end"; messageId: string; id: string }
  | { type: "tool-input-start"; messageId: string; toolCallId: string; toolName: string; capability?: RuntimeCapability; providerToolName?: string }
  | { type: "tool-input-delta"; messageId: string; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-available"; messageId: string; toolCallId: string; toolName: string; capability?: RuntimeCapability; providerToolName?: string; input: Record<string, unknown> }
  | { type: "tool-output-available"; messageId: string; toolCallId: string; output: unknown }
  | { type: "turn-finished"; messageId: string; durationMs: number | null; finishedAt: string };

type ActiveTurn = {
  messageId: string;
  renderMessageId: string;
  segmentIndex: number;
  activity: TranscriptActivity;
  timing: TurnTiming;
  pendingGuideMessageIds: string[];
};

export type TranscriptState = {
  messages: UIMessage[];
  historyBoundaries: HistorySessionBoundary[];
  cursor: number | null;
  pendingEvents: Map<number, TranscriptEvent>;
  status: TranscriptStatus;
  activeTurn: ActiveTurn | null;
  expandedDecisionResultIds: Set<string>;
  needsResync: boolean;
};

export type TranscriptAction =
  | { type: "reset" }
  | { type: "append-optimistic"; messages: UIMessage[] }
  | {
      type: "load-snapshot";
      cursor: number;
      messages: UIMessage[];
      historyBoundaries: HistorySessionBoundary[];
      activeTurn?: TranscriptActiveTurn;
    }
  | { type: "apply-events"; events: Array<{ cursor: number; event: TranscriptEvent }> }
  | {
      type: "decision-card-resolved";
      cardId: string;
      messageId: string;
      status: "resolved" | "cancelled";
      createdAt: Date;
    }
  | { type: "finish-active"; finishedAt: string }
  | { type: "resync-requested" };

export const emptyTranscriptState: TranscriptState = {
  messages: [],
  historyBoundaries: [],
  cursor: null,
  pendingEvents: new Map(),
  status: "idle",
  activeTurn: null,
  expandedDecisionResultIds: new Set(),
  needsResync: false,
};

type AnyPart = UIMessage["parts"][number] & Record<string, unknown>;
type MutableMessage = UIMessage & {
  content?: string;
  createdAt?: unknown;
  metadata?: Record<string, unknown> & { turnTiming?: TurnTiming | null };
};

function cloneUiMessage(message: UIMessage): UIMessage {
  return {
    ...message,
    ...(message.metadata ? { metadata: { ...(message.metadata as Record<string, unknown>) } } : {}),
    parts: message.parts.map((part) => ({ ...(part as Record<string, unknown>) })) as UIMessage["parts"],
  } as UIMessage;
}

function textContent(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => ((part as AnyPart).text as string | undefined) ?? "")
    .join("");
}

function setTextContent(message: MutableMessage, text: string) {
  let wroteText = false;
  message.parts = message.parts.map((part) => {
    if (part.type !== "text") return part;
    if (wroteText) return { ...(part as Record<string, unknown>), text: "" } as UIMessage["parts"][number];
    wroteText = true;
    return { ...(part as Record<string, unknown>), text } as UIMessage["parts"][number];
  });
  if (!wroteText) {
    message.parts = [{ type: "text", text } as UIMessage["parts"][number], ...message.parts];
  }
  message.content = text;
}

function userMessageSignature(message: UIMessage): string {
  if (message.role !== "user") return "";
  const text = textContent(message)
    .trim()
    .replace(/\s+/g, " ");
  const decisionCardId = /^clarification_card_id:\s*(\S+)/mu.exec(text)?.[1];
  return decisionCardId ? `decision-card:${decisionCardId}` : `text:${text}`;
}

function browserElementAttachments(message: UIMessage): unknown {
  return (message as { metadata?: { browserElementAttachments?: unknown } }).metadata?.browserElementAttachments;
}

function imageAttachments(message: UIMessage): unknown {
  return (message as { metadata?: { imageAttachments?: unknown } }).metadata?.imageAttachments;
}

function cloneServerMessageWithLocalMetadata(serverMessage: UIMessage, localMessage: UIMessage): UIMessage {
  const localAttachments = browserElementAttachments(localMessage);
  const localImageAttachments = imageAttachments(localMessage);
  const shouldKeepLocalGuideText = isRunningGuideMessage(serverMessage)
    && isRunningGuideMessage(localMessage)
    && textContent(localMessage).trim().length > 0;
  if (
    !shouldKeepLocalGuideText
    && (!Array.isArray(localAttachments) || localAttachments.length === 0)
    && (!Array.isArray(localImageAttachments) || localImageAttachments.length === 0)
  ) {
    return cloneUiMessage(serverMessage);
  }
  const next = cloneUiMessage(serverMessage) as MutableMessage;
  next.metadata = {
    ...(next.metadata ?? {}),
    ...(shouldKeepLocalGuideText
      ? {
        localMessageKind: "running-guide",
        guideStatusLabel: (localMessage as { metadata?: { guideStatusLabel?: unknown } }).metadata?.guideStatusLabel ?? "已引导对话",
      }
      : {}),
    ...(Array.isArray(localAttachments) && localAttachments.length > 0 ? { browserElementAttachments: localAttachments } : {}),
    ...(Array.isArray(localImageAttachments) && localImageAttachments.length > 0 ? { imageAttachments: localImageAttachments } : {}),
  };
  if (shouldKeepLocalGuideText) setTextContent(next, textContent(localMessage));
  return next;
}

function cloneMessagesWithOptimistic(state: TranscriptState, messages: UIMessage[]): UIMessage[] {
  const snapshot = messages.map(cloneUiMessage);
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const snapshotUserSignatures = new Set(
    snapshot.filter((message) => message.role === "user").map(userMessageSignature).filter(Boolean),
  );
  const optimistic = state.messages.filter((message) =>
    message.role === "user"
    && !snapshotIds.has(message.id)
    && !snapshotUserSignatures.has(userMessageSignature(message)),
  );
  return optimistic.length > 0 ? [...optimistic.map(cloneUiMessage), ...snapshot] : snapshot;
}

function findPartIndex(parts: UIMessage["parts"], predicate: (part: AnyPart) => boolean): number {
  return parts.findIndex((part) => predicate(part as AnyPart));
}

function activeTurnFromSnapshot(
  messages: UIMessage[],
  activeTurn: TranscriptActiveTurn | undefined,
): ActiveTurn | null {
  if (!activeTurn) return null;
  const message = messages.find((item) => item.id === activeTurn.message_id && item.role === "assistant");
  if (!message) return null;
  const timing = readHistoryTurnTiming(message);
  return {
    messageId: message.id,
    renderMessageId: message.id,
    segmentIndex: 0,
    activity: deriveActivityFromMessage(message),
    timing: {
      startedAt: activeTurn.started_at,
      finishedAt: null,
      durationMs: timing?.durationMs ?? null,
    },
    pendingGuideMessageIds: [],
  };
}

function createAssistantMessage(messageId: string, startedAt: string): UIMessage {
  return {
    id: messageId,
    role: "assistant",
    parts: [],
    content: "",
    createdAt: startedAt,
    metadata: { turnTiming: { startedAt, finishedAt: null, durationMs: null } },
  } as UIMessage;
}

function withTiming(message: UIMessage, timing: TurnTiming) {
  const mutable = message as MutableMessage;
  mutable.createdAt = mutable.createdAt ?? timing.startedAt ?? undefined;
  mutable.metadata = {
    ...(mutable.metadata ?? {}),
    turnTiming: timing,
  };
}

function activeMessage(state: TranscriptState, messageId: string): { messages: UIMessage[]; message: UIMessage } | null {
  if (!state.activeTurn) return null;
  if (state.activeTurn.messageId !== messageId && state.activeTurn.renderMessageId !== messageId) return null;
  const index = state.messages.findIndex((message) => message.id === state.activeTurn?.renderMessageId);
  if (index < 0) return null;
  const messages = [...state.messages];
  messages[index] = cloneUiMessage(messages[index]);
  return { messages, message: messages[index] };
}

function upsertTextPart(message: UIMessage, blockId: string): AnyPart {
  const index = findPartIndex(message.parts, (part) => part.type === "text" && part.id === blockId);
  if (index >= 0) return message.parts[index] as AnyPart;
  const part = { type: "text", id: blockId, text: "" } as AnyPart;
  message.parts.push(part as UIMessage["parts"][number]);
  return part;
}

function upsertReasoningPart(message: UIMessage, blockId: string): AnyPart {
  const index = findPartIndex(message.parts, (part) => part.type === "reasoning" && part.id === blockId);
  if (index >= 0) return message.parts[index] as AnyPart;
  const part = { type: "reasoning", id: blockId, text: "", state: "streaming" } as AnyPart;
  message.parts.push(part as UIMessage["parts"][number]);
  return part;
}

function upsertToolPart(
  message: UIMessage,
  toolCallId: string,
  toolName: string,
  metadata: { capability?: RuntimeCapability; providerToolName?: string } = {},
): AnyPart {
  const index = findPartIndex(message.parts, (part) => part.type.startsWith("tool-") && part.toolCallId === toolCallId);
  if (index >= 0) {
    const existing = message.parts[index] as AnyPart;
    if (metadata.capability) existing.capability = metadata.capability;
    if (metadata.providerToolName) existing.providerToolName = metadata.providerToolName;
    return existing;
  }
  const part = {
    type: `tool-${toolName}`,
    toolCallId,
    toolName,
    ...(metadata.capability ? { capability: metadata.capability } : {}),
    ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
    state: "input-streaming",
    inputText: "",
    input: undefined,
    output: undefined,
  } as AnyPart;
  message.parts.push(part as UIMessage["parts"][number]);
  return part;
}

function hasRunningTool(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const item = part as AnyPart;
    return item.type.startsWith("tool-") && item.state !== "output-available";
  });
}

function appendServerMessage(messages: UIMessage[], message: UIMessage): UIMessage[] {
  const existingIndex = messages.findIndex((item) => item.id === message.id);
  if (existingIndex >= 0) {
    const next = [...messages];
    next[existingIndex] = cloneServerMessageWithLocalMetadata(message, messages[existingIndex]);
    return next;
  }
  if (isRunningGuideMessage(message)) {
    return [...messages, cloneUiMessage(message)];
  }
  const signature = userMessageSignature(message);
  if (signature) {
    const optimisticIndex = messages.findIndex((item) => item.role === "user" && userMessageSignature(item) === signature);
    if (optimisticIndex >= 0) {
      const next = [...messages];
      next[optimisticIndex] = cloneServerMessageWithLocalMetadata(message, messages[optimisticIndex]);
      return next;
    }
  }
  return [...messages, cloneUiMessage(message)];
}

function isRunningGuideMessage(message: UIMessage): boolean {
  return message.role === "user"
    && (message as { metadata?: { localMessageKind?: unknown } }).metadata?.localMessageKind === "running-guide";
}

function withoutGuideStatus(message: UIMessage): UIMessage {
  if (!isRunningGuideMessage(message)) return message;
  const next = cloneUiMessage(message) as UIMessage & { metadata?: Record<string, unknown> };
  if (!next.metadata) return next;
  delete next.metadata.guideStatusLabel;
  return next;
}

function isGuideApplyingAssistantEvent(event: TranscriptEvent): boolean {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || event.type === "tool-input-start"
    || event.type === "tool-input-delta"
    || event.type === "tool-input-available";
}

function startsAssistantSegmentAfterGuide(event: TranscriptEvent): boolean {
  return event.type === "text-start"
    || event.type === "text-delta"
    || event.type === "reasoning-start"
    || event.type === "reasoning-delta"
    || event.type === "tool-input-start"
    || event.type === "tool-input-delta"
    || event.type === "tool-input-available";
}

function transcriptEventMessageId(event: TranscriptEvent): string | null {
  return "messageId" in event ? event.messageId : null;
}

function segmentIndexFromMessageId(rootMessageId: string, messageId: string): number | null {
  const prefix = `${rootMessageId}:guide-`;
  if (!messageId.startsWith(prefix)) return null;
  const value = Number(messageId.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function useCanonicalAssistantSegment(state: TranscriptState, event: TranscriptEvent): TranscriptState | null {
  const messageId = transcriptEventMessageId(event);
  if (!messageId || !state.activeTurn) return null;
  if (messageId === state.activeTurn.renderMessageId) return state;
  const segmentIndex = segmentIndexFromMessageId(state.activeTurn.messageId, messageId);
  if (segmentIndex === null) return null;

  const messages = [...state.messages];
  const existingIndex = messages.findIndex((message) => message.id === messageId);
  if (existingIndex >= 0) {
    messages[existingIndex] = cloneUiMessage(messages[existingIndex]);
  } else {
    messages.push(createAssistantMessage(messageId, state.activeTurn.timing.startedAt ?? new Date().toISOString()));
  }
  return {
    ...state,
    messages,
    activeTurn: {
      ...state.activeTurn,
      renderMessageId: messageId,
      segmentIndex,
      activity: "waiting",
    },
  };
}

function shouldStartNextAssistantSegment(state: TranscriptState, event: TranscriptEvent): boolean {
  const messageId = transcriptEventMessageId(event);
  if (!messageId || !state.activeTurn || state.activeTurn.messageId !== messageId) return false;
  if (state.activeTurn.pendingGuideMessageIds.length === 0) return false;
  if (!startsAssistantSegmentAfterGuide(event)) return false;
  const renderIndex = state.messages.findIndex((message) => message.id === state.activeTurn?.renderMessageId);
  const pendingGuideIndex = state.activeTurn.pendingGuideMessageIds.reduce((latest, messageId) => {
    const index = state.messages.findIndex((message) => message.id === messageId);
    return index > latest ? index : latest;
  }, -1);
  return renderIndex >= 0 && pendingGuideIndex > renderIndex;
}

function nextAssistantSegment(state: TranscriptState, event: TranscriptEvent): { messages: UIMessage[]; activeTurn: ActiveTurn; message: UIMessage } | null {
  if (!shouldStartNextAssistantSegment(state, event) || !state.activeTurn) return null;
  const segmentIndex = state.activeTurn.segmentIndex + 1;
  const renderMessageId = `${state.activeTurn.messageId}:guide-${segmentIndex}`;
  const existingIndex = state.messages.findIndex((message) => message.id === renderMessageId);
  const messages = [...state.messages];
  let message: UIMessage;
  if (existingIndex >= 0) {
    message = cloneUiMessage(messages[existingIndex]);
    messages[existingIndex] = message;
  } else {
    message = createAssistantMessage(renderMessageId, state.activeTurn.timing.startedAt ?? new Date().toISOString());
    messages.push(message);
  }
  return {
    messages,
    message,
    activeTurn: {
      ...state.activeTurn,
      renderMessageId,
      segmentIndex,
      activity: "waiting",
      pendingGuideMessageIds: state.activeTurn.pendingGuideMessageIds,
    },
  };
}

function markGuideApplied(messages: UIMessage[], guideMessageIds: string[]): UIMessage[] {
  if (guideMessageIds.length === 0) return messages;
  const guideIds = new Set(guideMessageIds);
  let changed = false;
  const next = messages.map((message) => {
    if (!guideIds.has(message.id)) return message;
    const guide = cloneUiMessage(message) as UIMessage & { metadata?: Record<string, unknown> };
    guide.metadata = {
      ...(guide.metadata ?? {}),
      guideStatusLabel: "已引导对话",
    };
    changed = true;
    return guide;
  });
  if (!changed) return messages;
  return next;
}

function appendOptimisticMessage(messages: UIMessage[], message: UIMessage): UIMessage[] {
  if (messages.some((item) => item.id === message.id)) return messages;
  const signature = userMessageSignature(message);
  if (signature && messages.some((item) => item.role === "user" && userMessageSignature(item) === signature)) {
    return messages;
  }
  return [...messages, cloneUiMessage(message)];
}

function applyEvent(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  if (event.type === "message-added") {
    const message = withoutGuideStatus(event.message);
    const activeTurn = state.activeTurn && isRunningGuideMessage(message)
      ? { ...state.activeTurn, pendingGuideMessageIds: [...state.activeTurn.pendingGuideMessageIds, message.id] }
      : state.activeTurn;
    return { ...state, messages: appendServerMessage(state.messages, message), activeTurn };
  }

  if (event.type === "turn-started") {
    if (state.activeTurn && state.activeTurn.messageId !== event.messageId) {
      return { ...state, needsResync: true };
    }
    const startedAt = event.startedAt && !Number.isNaN(Date.parse(event.startedAt))
      ? event.startedAt
      : new Date().toISOString();
    const existingIndex = state.messages.findIndex((message) => message.id === event.messageId);
    const messages = [...state.messages];
    if (existingIndex < 0) {
      messages.push(createAssistantMessage(event.messageId, startedAt));
    } else if (messages[existingIndex]?.role === "assistant") {
      messages[existingIndex] = cloneUiMessage(messages[existingIndex]);
      withTiming(messages[existingIndex], { startedAt, finishedAt: null, durationMs: null });
    } else {
      return { ...state, needsResync: true };
    }
    return {
      ...state,
      messages,
      status: "streaming",
      activeTurn: {
        messageId: event.messageId,
        renderMessageId: event.messageId,
        segmentIndex: 0,
        activity: "waiting",
        timing: { startedAt, finishedAt: null, durationMs: null },
        pendingGuideMessageIds: [],
      },
    };
  }

  let workingState = useCanonicalAssistantSegment(state, event) ?? state;
  const segment = workingState === state ? nextAssistantSegment(state, event) : null;
  if (segment) {
    workingState = { ...workingState, messages: segment.messages, activeTurn: segment.activeTurn };
  }
  const active = activeMessage(workingState, event.messageId);
  if (!active || !workingState.activeTurn) return { ...workingState, needsResync: true };
  let { messages, message } = active;
  const pendingGuideMessageIds = workingState.activeTurn.pendingGuideMessageIds;
  const guideApplied = pendingGuideMessageIds.length > 0 && isGuideApplyingAssistantEvent(event);
  if (guideApplied) {
    messages = markGuideApplied(messages, pendingGuideMessageIds);
  }
  let activity: TranscriptActivity = workingState.activeTurn.activity;
  let activeTurn: ActiveTurn | null = workingState.activeTurn;
  let status: TranscriptStatus = "streaming";

  switch (event.type) {
    case "text-start":
      upsertTextPart(message, event.id);
      activity = hasRunningTool(message) ? "tool-running" : "waiting";
      break;
    case "text-delta": {
      const part = upsertTextPart(message, event.id);
      part.text = `${typeof part.text === "string" ? part.text : ""}${event.delta}`;
      (message as MutableMessage).content = textContent(message);
      activity = "text";
      break;
    }
    case "text-end":
      activity = hasRunningTool(message) ? "tool-running" : "waiting";
      break;
    case "reasoning-start":
      upsertReasoningPart(message, event.id);
      activity = "reasoning";
      break;
    case "reasoning-delta": {
      const part = upsertReasoningPart(message, event.id);
      part.text = `${typeof part.text === "string" ? part.text : ""}${event.delta}`;
      activity = "reasoning";
      break;
    }
    case "reasoning-end": {
      const index = findPartIndex(message.parts, (part) => part.type === "reasoning" && part.id === event.id);
      if (index >= 0) (message.parts[index] as AnyPart).state = "done";
      activity = hasRunningTool(message) ? "tool-running" : "waiting";
      break;
    }
    case "tool-input-start": {
      const part = upsertToolPart(message, event.toolCallId, event.toolName, {
        capability: event.capability,
        providerToolName: event.providerToolName,
      });
      if (part.state === "output-available") {
        activity = hasRunningTool(message) ? "tool-running" : "waiting";
        break;
      }
      part.toolName = event.toolName;
      if (event.capability) part.capability = event.capability;
      if (event.providerToolName) part.providerToolName = event.providerToolName;
      part.type = `tool-${event.toolName}`;
      part.state = "input-streaming";
      activity = "tool-running";
      break;
    }
    case "tool-input-delta": {
      const part = upsertToolPart(message, event.toolCallId, "unknown");
      if (part.state === "output-available") {
        activity = hasRunningTool(message) ? "tool-running" : "waiting";
        break;
      }
      part.inputText = `${typeof part.inputText === "string" ? part.inputText : ""}${event.inputTextDelta}`;
      activity = "tool-running";
      break;
    }
    case "tool-input-available": {
      const existingIndex = findPartIndex(message.parts, (part) => part.type.startsWith("tool-") && part.toolCallId === event.toolCallId);
      const existingToolName = existingIndex >= 0 ? (message.parts[existingIndex] as AnyPart).toolName : undefined;
      const toolName = event.toolName || (typeof existingToolName === "string" ? existingToolName : "unknown");
      const part = upsertToolPart(message, event.toolCallId, toolName, {
        capability: event.capability,
        providerToolName: event.providerToolName,
      });
      if (part.state === "output-available") {
        activity = hasRunningTool(message) ? "tool-running" : "waiting";
        break;
      }
      part.toolName = toolName;
      if (event.capability) part.capability = event.capability;
      if (event.providerToolName) part.providerToolName = event.providerToolName;
      part.type = `tool-${toolName}`;
      part.input = event.input;
      part.inputText = undefined;
      part.state = "input-available";
      activity = "tool-running";
      break;
    }
    case "tool-output-available": {
      const part = upsertToolPart(message, event.toolCallId, "unknown");
      part.output = event.output;
      part.state = "output-available";
      activity = hasRunningTool(message) ? "tool-running" : "waiting";
      break;
    }
    case "turn-finished": {
      const timing = computeFinishedTiming({
        startedAt: workingState.activeTurn.timing.startedAt,
        eventDurationMs: event.durationMs,
        eventFinishedAt: event.finishedAt,
      });
      (message as MutableMessage).content = textContent(message);
      withTiming(message, timing);
      activeTurn = null;
      status = "ready";
      break;
    }
  }

  return {
    ...workingState,
    messages,
    status,
    activeTurn: activeTurn ? {
      ...activeTurn,
      activity,
      timing: activeTurn.timing,
      pendingGuideMessageIds: guideApplied ? [] : pendingGuideMessageIds,
    } : null,
  };
}

function replayPending(state: TranscriptState): TranscriptState {
  if (state.cursor === null) return state;
  let cursor = state.cursor;
  let next = state;
  const pendingEvents = new Map(state.pendingEvents);
  while (pendingEvents.has(cursor + 1)) {
    const event = pendingEvents.get(cursor + 1)!;
    pendingEvents.delete(cursor + 1);
    next = applyEvent(next, event);
    cursor += 1;
  }
  return { ...next, cursor, pendingEvents };
}

function applyEvents(state: TranscriptState, events: Array<{ cursor: number; event: TranscriptEvent }>): TranscriptState {
  const pendingEvents = new Map(state.pendingEvents);
  for (const item of events) {
    if (state.cursor !== null && item.cursor <= state.cursor) continue;
    pendingEvents.set(item.cursor, item.event);
  }
  return replayPending({ ...state, pendingEvents });
}

function loadSnapshot(
  state: TranscriptState,
  cursor: number,
  messages: UIMessage[],
  historyBoundaries: HistorySessionBoundary[],
  activeTurnSnapshot: TranscriptActiveTurn | undefined,
): TranscriptState {
  if (state.cursor !== null && cursor < state.cursor) return state;
  const sessionMessages = cloneMessagesWithOptimistic(state, messages);
  const pendingEvents = new Map(
    [...state.pendingEvents].filter(([eventCursor]) => eventCursor > cursor),
  );
  const activeTurn = activeTurnFromSnapshot(sessionMessages, activeTurnSnapshot);
  return replayPending({
    ...state,
    messages: sessionMessages,
    historyBoundaries,
    cursor,
    pendingEvents,
    status: activeTurn ? "streaming" : "ready",
    activeTurn,
    needsResync: false,
  });
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "reset":
      return emptyTranscriptState;
    case "append-optimistic": {
      let messages = state.messages;
      for (const message of action.messages) {
        messages = appendOptimisticMessage(messages, message);
      }
      return messages === state.messages ? state : { ...state, messages };
    }
    case "load-snapshot":
      return loadSnapshot(state, action.cursor, action.messages, action.historyBoundaries, action.activeTurn);
    case "apply-events":
      return applyEvents(state, action.events);
    case "finish-active":
      return state.activeTurn
        ? applyEvent(state, {
          type: "turn-finished",
          messageId: state.activeTurn.messageId,
          durationMs: null,
          finishedAt: action.finishedAt,
        })
        : state;
    case "decision-card-resolved": {
      if (state.messages.some((message) => message.id === action.messageId)) return state;
      const text = action.status === "cancelled"
        ? `clarification_card_id: ${action.cardId}\n用户取消了本次澄清卡片。`
        : `clarification_card_id: ${action.cardId}\n用户已回答澄清卡片。`;
      return {
        ...state,
        messages: [...state.messages, {
          id: action.messageId,
          role: "user",
          parts: [{ type: "text", text }],
          content: text,
          createdAt: action.createdAt,
        } as UIMessage],
        expandedDecisionResultIds: new Set([...state.expandedDecisionResultIds, action.cardId]),
      };
    }
    case "resync-requested":
      return { ...state, needsResync: false };
  }
}

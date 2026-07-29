import type { UIMessage } from "ai";
import type { HistorySessionBoundary } from "../../../lib/ws";
import type { TranscriptActiveTurn } from "../../../lib/ws";
import {
  computeFinishedTiming,
  deriveActivityFromMessage,
  readHistoryTurnTiming,
} from "./buildTranscriptTimeline";
import type { RuntimeCapability, TimelineTool, TranscriptActivity } from "./types";
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
  | { type: "tool-input-start"; messageId: string; toolCallId: string; toolName: string; capability?: RuntimeCapability; providerToolName?: string; mcp?: TimelineTool["mcp"] }
  | { type: "tool-input-delta"; messageId: string; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-available"; messageId: string; toolCallId: string; toolName: string; capability?: RuntimeCapability; providerToolName?: string; mcp?: TimelineTool["mcp"]; input: Record<string, unknown> }
  | { type: "tool-output-available"; messageId: string; toolCallId: string; output: unknown }
  | { type: "turn-finished"; messageId: string; durationMs: number | null; finishedAt: string };

export type TranscriptCommittedEvent = {
  streamEpoch: string;
  cursor: number;
  event: TranscriptEvent;
  removedMessageIds?: string[];
  activeTurn?: TranscriptActiveTurn;
};

type PendingTranscriptEvent = Omit<TranscriptCommittedEvent, "streamEpoch" | "cursor">;

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
  streamEpoch: string | null;
  cursor: number | null;
  pendingEvents: Map<number, PendingTranscriptEvent>;
  status: TranscriptStatus;
  activeTurn: ActiveTurn | null;
  optimisticMessageIds: Set<string>;
  expandedDecisionResultIds: Set<string>;
  needsResync: boolean;
};

export type TranscriptAction =
  | { type: "reset" }
  | { type: "sync-optimistic"; messages: UIMessage[] }
  | {
      type: "load-snapshot";
      streamEpoch: string;
      cursor: number;
      messages: UIMessage[];
      historyBoundaries: HistorySessionBoundary[];
      activeTurn?: TranscriptActiveTurn;
    }
  | { type: "apply-events"; events: TranscriptCommittedEvent[] }
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
  streamEpoch: null,
  cursor: null,
  pendingEvents: new Map(),
  status: "idle",
  activeTurn: null,
  optimisticMessageIds: new Set(),
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

function cloneMessagesWithOptimistic(state: TranscriptState, messages: UIMessage[]): UIMessage[] {
  const snapshot = messages.map(cloneUiMessage);
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const optimistic = state.messages.filter((message) =>
    state.optimisticMessageIds.has(message.id)
    && !snapshotIds.has(message.id)
  );
  return optimistic.length === 0
    ? snapshot
    : [...snapshot, ...optimistic.map(cloneUiMessage)];
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
    messageId: activeTurn.root_message_id ?? message.id,
    renderMessageId: message.id,
    segmentIndex: activeTurn.segment_index ?? 0,
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
  metadata: { capability?: RuntimeCapability; providerToolName?: string; mcp?: TimelineTool["mcp"] } = {},
): AnyPart {
  const index = findPartIndex(message.parts, (part) => part.type.startsWith("tool-") && part.toolCallId === toolCallId);
  if (index >= 0) {
    const existing = message.parts[index] as AnyPart;
    if (metadata.capability) existing.capability = metadata.capability;
    if (metadata.providerToolName) existing.providerToolName = metadata.providerToolName;
    if (metadata.mcp) existing.mcp = metadata.mcp;
    return existing;
  }
  const part = {
    type: `tool-${toolName}`,
    toolCallId,
    toolName,
    ...(metadata.capability ? { capability: metadata.capability } : {}),
    ...(metadata.providerToolName ? { providerToolName: metadata.providerToolName } : {}),
    ...(metadata.mcp ? { mcp: metadata.mcp } : {}),
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
    next[existingIndex] = cloneUiMessage(message);
    return next;
  }
  return [...messages, cloneUiMessage(message)];
}

function isRunningGuideMessage(message: UIMessage): boolean {
  return message.role === "user"
    && (message as { metadata?: { localMessageKind?: unknown } }).metadata?.localMessageKind === "running-guide";
}

function isGuideApplyingAssistantEvent(event: TranscriptEvent): boolean {
  return event.type === "text-delta"
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
  return [...messages, cloneUiMessage(message)];
}

function applyEvent(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  if (event.type === "message-added") {
    const message = event.message;
    const activeTurn = state.activeTurn && isRunningGuideMessage(message)
      ? { ...state.activeTurn, pendingGuideMessageIds: [...state.activeTurn.pendingGuideMessageIds, message.id] }
      : state.activeTurn;
    const decisionCardId = message.role === "user"
      ? (message as { metadata?: { decisionCardId?: unknown } }).metadata?.decisionCardId
      : undefined;
    return {
      ...state,
      messages: appendServerMessage(state.messages, message),
      optimisticMessageIds: state.optimisticMessageIds.has(message.id)
        ? new Set([...state.optimisticMessageIds].filter((messageId) => messageId !== message.id))
        : state.optimisticMessageIds,
      activeTurn,
      expandedDecisionResultIds: typeof decisionCardId === "string"
        ? new Set([...state.expandedDecisionResultIds, decisionCardId])
        : state.expandedDecisionResultIds,
    };
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
        mcp: event.mcp,
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
        mcp: event.mcp,
      });
      if (part.state === "output-available") {
        activity = hasRunningTool(message) ? "tool-running" : "waiting";
        break;
      }
      part.toolName = toolName;
      if (event.capability) part.capability = event.capability;
      if (event.providerToolName) part.providerToolName = event.providerToolName;
      if (event.mcp) part.mcp = event.mcp;
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

function reconcileCommittedEvent(state: TranscriptState, mutation: PendingTranscriptEvent): TranscriptState {
  let next = mutation.removedMessageIds?.length
    ? { ...state, messages: state.messages.filter((message) => !mutation.removedMessageIds!.includes(message.id)) }
    : state;
  next = applyEvent(next, mutation.event);
  if (!mutation.activeTurn) return next;

  const renderMessageId = mutation.activeTurn.message_id;
  let messages = next.messages;
  let message = messages.find((item) => item.id === renderMessageId && item.role === "assistant");
  if (!message) {
    message = createAssistantMessage(renderMessageId, mutation.activeTurn.started_at);
    messages = [...messages, message];
  }
  const sameActiveMessage = next.activeTurn?.renderMessageId === renderMessageId;
  return {
    ...next,
    messages,
    status: "streaming",
    activeTurn: {
      messageId: mutation.activeTurn.root_message_id ?? renderMessageId,
      renderMessageId,
      segmentIndex: mutation.activeTurn.segment_index ?? 0,
      activity: sameActiveMessage
        ? next.activeTurn!.activity
        : deriveActivityFromMessage(message),
      timing: sameActiveMessage
        ? next.activeTurn!.timing
        : {
            startedAt: mutation.activeTurn.started_at,
            finishedAt: null,
            durationMs: null,
          },
      pendingGuideMessageIds: sameActiveMessage
        ? next.activeTurn!.pendingGuideMessageIds
        : [],
    },
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
    next = reconcileCommittedEvent(next, event);
    cursor += 1;
  }
  return { ...next, cursor, pendingEvents };
}

function applyEvents(state: TranscriptState, events: TranscriptCommittedEvent[]): TranscriptState {
  const streamEpoch = state.streamEpoch ?? events[0]?.streamEpoch ?? null;
  const pendingEvents = new Map(state.pendingEvents);
  for (const item of events) {
    if (item.streamEpoch !== streamEpoch) continue;
    if (state.cursor !== null && item.cursor <= state.cursor) continue;
    pendingEvents.set(item.cursor, {
      event: item.event,
      ...(item.removedMessageIds?.length ? { removedMessageIds: item.removedMessageIds } : {}),
      ...(item.activeTurn ? { activeTurn: item.activeTurn } : {}),
    });
  }
  return replayPending({ ...state, streamEpoch, pendingEvents });
}

function loadSnapshot(
  state: TranscriptState,
  streamEpoch: string,
  cursor: number,
  messages: UIMessage[],
  historyBoundaries: HistorySessionBoundary[],
  activeTurnSnapshot: TranscriptActiveTurn | undefined,
): TranscriptState {
  const sameEpoch = state.streamEpoch === null || state.streamEpoch === streamEpoch;
  if (sameEpoch && state.cursor !== null && cursor < state.cursor) return state;
  const sessionMessages = cloneMessagesWithOptimistic(state, messages);
  const pendingEvents = sameEpoch
    ? new Map([...state.pendingEvents].filter(([eventCursor]) => eventCursor > cursor))
    : new Map<number, PendingTranscriptEvent>();
  const activeTurn = activeTurnFromSnapshot(sessionMessages, activeTurnSnapshot);
  const snapshotIds = new Set(messages.map((message) => message.id));
  return replayPending({
    ...state,
    messages: sessionMessages,
    historyBoundaries,
    streamEpoch,
    cursor,
    pendingEvents,
    status: activeTurn ? "streaming" : "ready",
    activeTurn,
    optimisticMessageIds: new Set(
      [...state.optimisticMessageIds].filter((messageId) => !snapshotIds.has(messageId)),
    ),
    needsResync: false,
  });
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "reset":
      return emptyTranscriptState;
    case "sync-optimistic": {
      if (action.messages.length === 0 && state.optimisticMessageIds.size === 0) return state;
      let messages = state.messages.filter((message) => !state.optimisticMessageIds.has(message.id));
      const canonicalIds = new Set(messages.map((message) => message.id));
      const optimisticMessageIds = new Set<string>();
      for (const message of action.messages) {
        if (canonicalIds.has(message.id)) continue;
        messages = appendOptimisticMessage(messages, message);
        optimisticMessageIds.add(message.id);
      }
      return { ...state, messages, optimisticMessageIds };
    }
    case "load-snapshot":
      return loadSnapshot(state, action.streamEpoch, action.cursor, action.messages, action.historyBoundaries, action.activeTurn);
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

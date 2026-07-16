"use client";

import { create } from "zustand";
import type { BrowserElementAttachment } from "./useBrowserSelectionStore";
import type { MessageImageAttachment, OutgoingMessageImageAttachment } from "../types/messageAttachments";
import type { PlanFeedbackDraft } from "../types/orchestration";

export type RunningQueuedMessage = {
  id: string;
  content: string;
  specRequested?: boolean;
  displayContent?: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  outgoingAttachments?: OutgoingMessageImageAttachment[];
  planFeedback?: PlanFeedbackDraft[];
};

export const RUNNING_QUEUE_STORAGE_PREFIX = "squadflow.runningMessageQueue.v1";
const RUNNING_FLOW_STORAGE_PREFIX = "squadflow.runningFlowState.v1";
export const EMPTY_RUNNING_QUEUE: RunningQueuedMessage[] = [];

function runningQueueStorageKey(flowId: string) {
  return `${RUNNING_QUEUE_STORAGE_PREFIX}:${flowId}`;
}

function runningFlowStorageKey(flowId: string) {
  return `${RUNNING_FLOW_STORAGE_PREFIX}:${flowId}`;
}

function readQueuedMessages(flowId: string): RunningQueuedMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(runningQueueStorageKey(flowId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.content !== "string") return [];
      const displayContent = typeof record.displayContent === "string" ? record.displayContent : undefined;
      const specRequested = record.specRequested === true;
      const browserElementAttachments = Array.isArray(record.browserElementAttachments)
        ? record.browserElementAttachments as BrowserElementAttachment[]
        : undefined;
      const imageAttachments = Array.isArray(record.imageAttachments)
        ? record.imageAttachments as MessageImageAttachment[]
        : undefined;
      const planFeedback = Array.isArray(record.planFeedback) ? record.planFeedback as PlanFeedbackDraft[] : undefined;
      return [{
        id: record.id,
        content: record.content,
        ...(specRequested ? { specRequested } : {}),
        ...(displayContent ? { displayContent } : {}),
        ...(browserElementAttachments?.length ? { browserElementAttachments } : {}),
        ...(imageAttachments?.length ? { imageAttachments } : {}),
        ...(planFeedback?.length ? { planFeedback } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function writeQueuedMessages(flowId: string, messages: RunningQueuedMessage[]) {
  if (typeof window === "undefined") return;
  const key = runningQueueStorageKey(flowId);
  if (messages.length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  const persistedMessages = messages.map((message) => ({
    id: message.id,
    content: message.content,
    ...(message.specRequested ? { specRequested: true } : {}),
    ...(message.displayContent ? { displayContent: message.displayContent } : {}),
    ...(message.browserElementAttachments?.length ? { browserElementAttachments: message.browserElementAttachments } : {}),
    ...(message.imageAttachments?.length ? { imageAttachments: message.imageAttachments } : {}),
    ...(message.planFeedback?.length ? { planFeedback: message.planFeedback } : {}),
  }));
  window.localStorage.setItem(key, JSON.stringify(persistedMessages));
}

function readKnownRunningFlow(flowId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(runningFlowStorageKey(flowId)) === "1";
}

function writeKnownRunningFlow(flowId: string, isRunning: boolean) {
  if (typeof window === "undefined") return;
  const key = runningFlowStorageKey(flowId);
  if (!isRunning) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, "1");
}

type RunningMessageQueueState = {
  queuesByFlow: Record<string, RunningQueuedMessage[] | undefined>;
  hydratedFlows: Record<string, boolean | undefined>;
  knownRunningByFlow: Record<string, boolean | undefined>;
  hydratedKnownRunningFlows: Record<string, boolean | undefined>;
  hydrateFlowQueue: (flowId: string) => RunningQueuedMessage[];
  hydrateKnownRunningFlow: (flowId: string) => boolean;
  updateFlowQueue: (
    flowId: string,
    updater: (messages: RunningQueuedMessage[]) => RunningQueuedMessage[],
  ) => void;
  setKnownRunningFlow: (flowId: string, isRunning: boolean) => void;
};

export const useRunningMessageQueueStore = create<RunningMessageQueueState>((set, get) => ({
  queuesByFlow: {},
  hydratedFlows: {},
  knownRunningByFlow: {},
  hydratedKnownRunningFlows: {},
  hydrateFlowQueue: (flowId: string) => {
    const state = get();
    if (state.hydratedFlows[flowId]) {
      return state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE;
    }
    const messages = readQueuedMessages(flowId);
    set((current) => ({
      queuesByFlow: { ...current.queuesByFlow, [flowId]: messages },
      hydratedFlows: { ...current.hydratedFlows, [flowId]: true },
    }));
    return messages;
  },
  hydrateKnownRunningFlow: (flowId: string) => {
    const state = get();
    if (state.hydratedKnownRunningFlows[flowId]) {
      return Boolean(state.knownRunningByFlow[flowId]);
    }
    const isRunning = readKnownRunningFlow(flowId);
    set((current) => ({
      knownRunningByFlow: { ...current.knownRunningByFlow, [flowId]: isRunning },
      hydratedKnownRunningFlows: { ...current.hydratedKnownRunningFlows, [flowId]: true },
    }));
    return isRunning;
  },
  updateFlowQueue: (flowId, updater) => {
    const state = get();
    const currentMessages = state.hydratedFlows[flowId]
      ? state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE
      : readQueuedMessages(flowId);
    const nextMessages = updater(currentMessages);
    writeQueuedMessages(flowId, nextMessages);
    set((current) => ({
      queuesByFlow: { ...current.queuesByFlow, [flowId]: nextMessages },
      hydratedFlows: { ...current.hydratedFlows, [flowId]: true },
    }));
  },
  setKnownRunningFlow: (flowId, isRunning) => {
    writeKnownRunningFlow(flowId, isRunning);
    set((current) => ({
      knownRunningByFlow: { ...current.knownRunningByFlow, [flowId]: isRunning },
      hydratedKnownRunningFlows: { ...current.hydratedKnownRunningFlows, [flowId]: true },
    }));
  },
}));

export function resetRunningMessageQueueStoreForTests() {
  useRunningMessageQueueStore.setState({
    queuesByFlow: {},
    hydratedFlows: {},
    knownRunningByFlow: {},
    hydratedKnownRunningFlows: {},
  });
}

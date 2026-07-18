"use client";

import { create } from "zustand";
import type { BrowserElementAttachment } from "./useBrowserSelectionStore";
import type { MessageImageAttachment } from "../types/messageAttachments";
import type { PlanFeedbackDraft } from "../types/orchestration";

export type RunningQueuedMessage = {
  id: string;
  content: string;
  status?: "accepted" | "dispatching";
  revision?: number;
  specRequested?: boolean;
  displayContent?: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  planFeedback?: PlanFeedbackDraft[];
};

export const EMPTY_RUNNING_QUEUE: RunningQueuedMessage[] = [];

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
  setFlowQueue: (flowId: string, messages: RunningQueuedMessage[]) => void;
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
    const messages = state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE;
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
    const isRunning = Boolean(state.knownRunningByFlow[flowId]);
    set((current) => ({
      knownRunningByFlow: { ...current.knownRunningByFlow, [flowId]: isRunning },
      hydratedKnownRunningFlows: { ...current.hydratedKnownRunningFlows, [flowId]: true },
    }));
    return isRunning;
  },
  updateFlowQueue: (flowId, updater) => {
    const state = get();
    const currentMessages = state.queuesByFlow[flowId] ?? EMPTY_RUNNING_QUEUE;
    const nextMessages = updater(currentMessages);
    set((current) => ({
      queuesByFlow: { ...current.queuesByFlow, [flowId]: nextMessages },
      hydratedFlows: { ...current.hydratedFlows, [flowId]: true },
    }));
  },
  setFlowQueue: (flowId, messages) => {
    set((current) => ({
      queuesByFlow: { ...current.queuesByFlow, [flowId]: messages },
      hydratedFlows: { ...current.hydratedFlows, [flowId]: true },
    }));
  },
  setKnownRunningFlow: (flowId, isRunning) => {
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

"use client";

import { create } from "zustand";
import type { BrowserElementAttachment } from "./useBrowserSelectionStore";
import type { MessageImageAttachment } from "../types/messageAttachments";
import type { OrchestrationFeedbackDraft } from "../types/orchestration";

export type RunningQueuedMessage = {
  id: string;
  content: string;
  status?: "accepted" | "dispatching";
  revision?: number;
  displayContent?: string;
  browserElementAttachments?: BrowserElementAttachment[];
  imageAttachments?: MessageImageAttachment[];
  orchestrationFeedback?: OrchestrationFeedbackDraft[];
};

export const EMPTY_RUNNING_QUEUE: RunningQueuedMessage[] = [];

type RunningMessageQueueState = {
  queuesByFlow: Record<string, RunningQueuedMessage[] | undefined>;
  hydratedFlows: Record<string, boolean | undefined>;
  hydrateFlowQueue: (flowId: string) => RunningQueuedMessage[];
  updateFlowQueue: (
    flowId: string,
    updater: (messages: RunningQueuedMessage[]) => RunningQueuedMessage[],
  ) => void;
  setFlowQueue: (flowId: string, messages: RunningQueuedMessage[]) => void;
};

export const useRunningMessageQueueStore = create<RunningMessageQueueState>((set, get) => ({
  queuesByFlow: {},
  hydratedFlows: {},
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
}));

export function resetRunningMessageQueueStoreForTests() {
  useRunningMessageQueueStore.setState({
    queuesByFlow: {},
    hydratedFlows: {},
  });
}

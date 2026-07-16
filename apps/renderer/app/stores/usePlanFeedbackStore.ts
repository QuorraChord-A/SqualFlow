"use client";

import { create } from "zustand";
import type { PlanFeedbackDraft } from "../types/orchestration";

type PlanFeedbackState = {
  activeFlowId: string | null;
  drafts: PlanFeedbackDraft[];
  draftsByFlow: Record<string, PlanFeedbackDraft[]>;
  setActiveFlowId: (flowId: string | null) => void;
  upsertDraft: (draft: Omit<PlanFeedbackDraft, "id" | "markerNumber">) => void;
  removeDraft: (id: string) => void;
  clearDrafts: () => void;
  setDrafts: (drafts: PlanFeedbackDraft[]) => void;
};

function renumber(drafts: PlanFeedbackDraft[]) {
  return drafts.map((draft, index) => ({ ...draft, markerNumber: index + 1 }));
}

export const usePlanFeedbackStore = create<PlanFeedbackState>((set) => ({
  activeFlowId: null,
  drafts: [],
  draftsByFlow: {},
  setActiveFlowId: (flowId) => set((state) => {
    const draftsByFlow = state.activeFlowId
      ? { ...state.draftsByFlow, [state.activeFlowId]: state.drafts }
      : state.draftsByFlow;
    return { activeFlowId: flowId, draftsByFlow, drafts: flowId ? draftsByFlow[flowId] ?? [] : [] };
  }),
  upsertDraft: (next) => set((state) => {
    const existing = state.drafts.find((draft) => draft.planRevisionId === next.planRevisionId && draft.planNodeId === next.planNodeId);
    const drafts = renumber(existing
      ? state.drafts.map((draft) => draft.id === existing.id ? { ...draft, ...next } : draft)
      : [...state.drafts, { ...next, id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, markerNumber: state.drafts.length + 1 }]);
    return { drafts, draftsByFlow: state.activeFlowId ? { ...state.draftsByFlow, [state.activeFlowId]: drafts } : state.draftsByFlow };
  }),
  removeDraft: (id) => set((state) => {
    const drafts = renumber(state.drafts.filter((draft) => draft.id !== id));
    return { drafts, draftsByFlow: state.activeFlowId ? { ...state.draftsByFlow, [state.activeFlowId]: drafts } : state.draftsByFlow };
  }),
  clearDrafts: () => set((state) => ({ drafts: [], draftsByFlow: state.activeFlowId ? { ...state.draftsByFlow, [state.activeFlowId]: [] } : state.draftsByFlow })),
  setDrafts: (drafts) => set((state) => ({ drafts: renumber(drafts), draftsByFlow: state.activeFlowId ? { ...state.draftsByFlow, [state.activeFlowId]: renumber(drafts) } : state.draftsByFlow })),
}));

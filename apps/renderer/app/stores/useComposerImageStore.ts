"use client";

import { create } from "zustand";
import type { MessageImageAttachment } from "../types/messageAttachments";

type ComposerImageState = {
  activeFlowId: string | null;
  images: MessageImageAttachment[];
  imagesByFlow: Record<string, MessageImageAttachment[]>;
  setActiveFlowId: (flowId: string | null) => void;
  addImages: (images: MessageImageAttachment[]) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
};

const MAX_COMPOSER_IMAGES = 6;

export const useComposerImageStore = create<ComposerImageState>((set) => ({
  activeFlowId: null,
  images: [],
  imagesByFlow: {},
  setActiveFlowId: (flowId) => set((state) => {
    const imagesByFlow = state.activeFlowId
      ? { ...state.imagesByFlow, [state.activeFlowId]: state.images }
      : state.imagesByFlow;
    return {
      activeFlowId: flowId,
      imagesByFlow,
      images: flowId ? imagesByFlow[flowId] ?? [] : [],
    };
  }),
  addImages: (images) => set((state) => {
    if (images.length === 0) return state;
    const nextImages = [...state.images, ...images].slice(-MAX_COMPOSER_IMAGES);
    return {
      images: nextImages,
      imagesByFlow: state.activeFlowId
        ? { ...state.imagesByFlow, [state.activeFlowId]: nextImages }
        : state.imagesByFlow,
    };
  }),
  removeImage: (id) => set((state) => {
    const images = state.images.filter((image) => image.id !== id);
    return {
      images,
      imagesByFlow: state.activeFlowId
        ? { ...state.imagesByFlow, [state.activeFlowId]: images }
        : state.imagesByFlow,
    };
  }),
  clearImages: () => set((state) => {
    if (!state.activeFlowId) return { images: [] };
    return {
      images: [],
      imagesByFlow: { ...state.imagesByFlow, [state.activeFlowId]: [] },
    };
  }),
}));

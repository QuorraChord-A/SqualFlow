"use client";

import { create } from "zustand";
import { getDesktopBrowserBridge, type DesktopBrowserSelectedElement } from "../lib/desktopBrowser";
import { splitDataUrl, type OutgoingMessageImageAttachment } from "../types/messageAttachments";

export type BrowserElementAttachment = DesktopBrowserSelectedElement & {
  id: string;
  addedAt: number;
  comment: string;
};

type BrowserSelectionState = {
  activeFlowId: string | null;
  elements: BrowserElementAttachment[];
  elementsByFlow: Record<string, BrowserElementAttachment[]>;
  urlByFlow: Record<string, string>;
  setActiveFlowId: (flowId: string | null) => void;
  setElements: (elements: BrowserElementAttachment[]) => void;
  addElement: (element: DesktopBrowserSelectedElement) => void;
  removeElement: (id: string) => void;
  clearElements: () => void;
};

let unsubscribeDesktopBrowserSelection: (() => void) | null = null;

function elementLabel(element: DesktopBrowserSelectedElement) {
  return element.ariaLabel || element.title || element.text || element.selector || element.tagName;
}

function renumberElements(elements: BrowserElementAttachment[]) {
  return elements.map((element, index) => ({ ...element, markerNumber: index + 1 }));
}

function normalizePageUrl(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function markersForCurrentBrowserPage(elements: BrowserElementAttachment[]) {
  const bridge = getDesktopBrowserBridge();
  if (!bridge?.getState) return elements;
  const state = await bridge.getState().catch(() => null);
  if (!state?.url) return elements;
  const currentUrl = normalizePageUrl(state.url);
  return elements.filter((element) => normalizePageUrl(element.url) === currentUrl);
}

function syncDesktopConfirmedMarkers(elements: BrowserElementAttachment[]) {
  const bridge = getDesktopBrowserBridge();
  const setConfirmedMarkers = bridge?.setConfirmedMarkers;
  if (!setConfirmedMarkers) return;
  void markersForCurrentBrowserPage(elements).then((visibleElements) => setConfirmedMarkers(visibleElements.map((element) => ({
    markerNumber: element.markerNumber,
    selector: element.selector,
    rect: element.rect,
  }))));
}

export const useBrowserSelectionStore = create<BrowserSelectionState>((set, get) => ({
  activeFlowId: null,
  elements: [],
  elementsByFlow: {},
  urlByFlow: {},
  setActiveFlowId: (flowId) => {
    const previousFlowId = get().activeFlowId;
    const bridge = getDesktopBrowserBridge();
    const isRealSwitch = flowId !== previousFlowId;

    // The desktop browser is a single shared native view (not one per flow),
    // so switching flows must explicitly park/restore its URL per flow;
    // otherwise the previous flow's page keeps showing under the new flow.
    if (bridge && previousFlowId && isRealSwitch) {
      void bridge.getState().then((browserState) => {
        if (browserState?.url && browserState.url !== "about:blank") {
          set((current) => ({ urlByFlow: { ...current.urlByFlow, [previousFlowId]: browserState.url } }));
        }
      }).catch(() => {});
    }

    set((state) => {
      const elementsByFlow = state.activeFlowId
        ? { ...state.elementsByFlow, [state.activeFlowId]: state.elements }
        : state.elementsByFlow;
      const elements = flowId ? elementsByFlow[flowId] ?? [] : [];
      syncDesktopConfirmedMarkers(elements);
      return {
        activeFlowId: flowId,
        elementsByFlow,
        elements,
      };
    });

    if (bridge && flowId && isRealSwitch) {
      const targetUrl = get().urlByFlow[flowId];
      if (targetUrl) {
        void bridge.navigate(targetUrl).catch(() => {});
      } else {
        void bridge.reset?.().catch(() => {});
      }
    }
  },
  setElements: (nextElements) => set((state) => {
    const elements = renumberElements(nextElements.slice(-6));
    syncDesktopConfirmedMarkers(elements);
    return {
      elements,
      elementsByFlow: state.activeFlowId
        ? { ...state.elementsByFlow, [state.activeFlowId]: elements }
        : state.elementsByFlow,
    };
  }),
  addElement: (element) => set((state) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = [...state.elements, { ...element, id, addedAt: Date.now(), comment: element.comment?.trim() ?? "" }].slice(-6);
    const elements = renumberElements(next);
    syncDesktopConfirmedMarkers(elements);
    return {
      elements,
      elementsByFlow: state.activeFlowId
        ? { ...state.elementsByFlow, [state.activeFlowId]: elements }
        : state.elementsByFlow,
    };
  }),
  removeElement: (id) => set((state) => {
    const elements = renumberElements(state.elements.filter((item) => item.id !== id));
    syncDesktopConfirmedMarkers(elements);
    return {
      elements,
      elementsByFlow: state.activeFlowId
        ? { ...state.elementsByFlow, [state.activeFlowId]: elements }
        : state.elementsByFlow,
    };
  }),
  clearElements: () => set((state) => {
    syncDesktopConfirmedMarkers([]);
    if (!state.activeFlowId) return { elements: [] };
    return {
      elements: [],
      elementsByFlow: { ...state.elementsByFlow, [state.activeFlowId]: [] },
    };
  }),
}));

export function installDesktopBrowserSelectionListener() {
  if (unsubscribeDesktopBrowserSelection) return unsubscribeDesktopBrowserSelection;
  const bridge = getDesktopBrowserBridge();
  if (!bridge) return null;
  unsubscribeDesktopBrowserSelection = bridge.onElementSelected((element) => {
    useBrowserSelectionStore.getState().addElement(element);
  });
  return unsubscribeDesktopBrowserSelection;
}

export function browserElementsToOutgoingAttachments(elements: BrowserElementAttachment[]): OutgoingMessageImageAttachment[] {
  return elements.map((element, index) => {
    const screenshot = element.screenshotDataUrl ? splitDataUrl(element.screenshotDataUrl) : null;
    return {
      id: element.id,
      kind: "browser_comment",
      ...(screenshot ? { media_type: screenshot.mediaType, data: screenshot.data } : {}),
      marker_number: index + 1,
      comment: element.comment,
      label: elementLabel(element).slice(0, 160),
      page_url: element.url,
      selector: element.selector,
    };
  });
}

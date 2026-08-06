import type React from "react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useStickToBottomContext } from "use-stick-to-bottom";

type TranscriptScrollContextValue = {
  toggle: <T extends HTMLElement>(event: React.MouseEvent<T>, change: () => void) => void;
  follow: () => void;
  followIfAtBottom: () => boolean;
  registerThread: (element: HTMLDivElement | null) => void;
};

const TranscriptScrollContext = createContext<TranscriptScrollContextValue>({
  toggle: (_event, change) => change(),
  follow: () => {},
  followIfAtBottom: () => false,
  registerThread: () => {},
});

export type TranscriptScrollMemory = {
  anchorId: string | null;
  anchorOffset: number;
  scrollTop: number;
  followBottom: boolean;
};

const TRANSCRIPT_ANCHOR_SELECTOR = "[data-transcript-anchor-id]";
const BOTTOM_THRESHOLD_PX = 32;

function transcriptAnchors(scrollElement: HTMLElement) {
  return Array.from(scrollElement.querySelectorAll<HTMLElement>(TRANSCRIPT_ANCHOR_SELECTOR));
}

export function captureTranscriptScrollMemory(scrollElement: HTMLElement): TranscriptScrollMemory {
  const viewport = scrollElement.getBoundingClientRect();
  const anchor = transcriptAnchors(scrollElement).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top + 0.5 && rect.top < viewport.bottom - 0.5;
  });
  const anchorRect = anchor?.getBoundingClientRect();
  return {
    anchorId: anchor?.dataset.transcriptAnchorId ?? null,
    anchorOffset: anchorRect ? anchorRect.top - viewport.top : 0,
    scrollTop: scrollElement.scrollTop,
    followBottom: scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= BOTTOM_THRESHOLD_PX,
  };
}

export function restoreTranscriptScrollMemory(scrollElement: HTMLElement, memory: TranscriptScrollMemory): boolean {
  if (!memory.anchorId) {
    scrollElement.scrollTop = memory.scrollTop;
    return false;
  }
  const anchor = transcriptAnchors(scrollElement).find(
    (element) => element.dataset.transcriptAnchorId === memory.anchorId,
  );
  if (!anchor) {
    scrollElement.scrollTop = memory.scrollTop;
    return false;
  }
  const viewport = scrollElement.getBoundingClientRect();
  const currentOffset = anchor.getBoundingClientRect().top - viewport.top;
  scrollElement.scrollTop += currentOffset - memory.anchorOffset;
  return true;
}

export function TranscriptScrollProvider({
  children,
  flowId = null,
  isLoadingHistory = false,
  historyLoadVersion = 0,
}: {
  children: React.ReactNode;
  flowId?: string | null;
  isLoadingHistory?: boolean;
  historyLoadVersion?: number;
}) {
  const { scrollRef, scrollToBottom, stopScroll = () => {}, isAtBottom = false } = useStickToBottomContext();
  const [thread, setThread] = useState<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const flowScrollMemoryRef = useRef(new Map<string, TranscriptScrollMemory>());
  const previousFlowIdRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<{ flowId: string; historyLoadVersion: number } | null>(null);
  const restoringFlowRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);

  const restoreAnchor = useCallback(() => {
    const anchor = anchorRef.current;
    const scrollElement = scrollRef?.current;
    if (!anchor || !scrollElement || !anchor.element.isConnected) return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 0.5) return;
    scrollElement.scrollTop += delta;
    programmaticScrollTopRef.current = scrollElement.scrollTop;
  }, [scrollRef]);

  useEffect(() => {
    const scrollElement = scrollRef?.current;
    if (!scrollElement || !thread) return;
    const clearAnchorOnUserScroll = () => {
      const programmaticScrollTop = programmaticScrollTopRef.current;
      if (programmaticScrollTop !== null && Math.abs(scrollElement.scrollTop - programmaticScrollTop) < 0.5) {
        return;
      }
      programmaticScrollTopRef.current = null;
      anchorRef.current = null;
    };
    const mutations = new MutationObserver(restoreAnchor);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restoreAnchor);
    scrollElement.addEventListener("scroll", clearAnchorOnUserScroll, { passive: true });
    mutations.observe(thread, { childList: true, subtree: true, characterData: true });
    resize?.observe(thread);
    return () => {
      scrollElement.removeEventListener("scroll", clearAnchorOnUserScroll);
      mutations.disconnect();
      resize?.disconnect();
    };
  }, [restoreAnchor, scrollRef, thread]);

  useEffect(() => {
    const scrollElement = scrollRef?.current;
    if (!scrollElement || !thread || !flowId) return;
    const remember = () => {
      if (restoringFlowRef.current || isLoadingHistory) return;
      flowScrollMemoryRef.current.set(flowId, captureTranscriptScrollMemory(scrollElement));
    };
    scrollElement.addEventListener("scroll", remember, { passive: true });
    return () => scrollElement.removeEventListener("scroll", remember);
  }, [flowId, isLoadingHistory, scrollRef, thread]);

  useLayoutEffect(() => {
    if (previousFlowIdRef.current === flowId) return;
    previousFlowIdRef.current = flowId;
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    if (!flowId) {
      pendingRestoreRef.current = null;
      restoringFlowRef.current = false;
      return;
    }
    restoringFlowRef.current = true;
    pendingRestoreRef.current = { flowId, historyLoadVersion };
  }, [flowId, historyLoadVersion]);

  useLayoutEffect(() => {
    const pendingRestore = pendingRestoreRef.current;
    if (
      !flowId
      || !pendingRestore
      || pendingRestore.flowId !== flowId
      || historyLoadVersion <= pendingRestore.historyLoadVersion
    ) return;
    pendingRestoreRef.current = null;
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      const scrollElement = scrollRef?.current;
      const memory = flowScrollMemoryRef.current.get(flowId);
      if (!scrollElement || !memory || memory.followBottom) {
        scrollToBottom({ animation: "instant" });
      } else {
        stopScroll();
        restoreTranscriptScrollMemory(scrollElement, memory);
      }
      window.requestAnimationFrame(() => {
        restoringFlowRef.current = false;
      });
    });
    return () => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [flowId, historyLoadVersion, scrollRef, scrollToBottom, stopScroll]);

  const toggle = useCallback(<T extends HTMLElement>(event: React.MouseEvent<T>, change: () => void) => {
    const element = event.currentTarget;
    anchorRef.current = { element, top: element.getBoundingClientRect().top };
    stopScroll();
    flushSync(change);
    restoreAnchor();
  }, [restoreAnchor, stopScroll]);

  const follow = useCallback(() => {
    anchorRef.current = null;
    programmaticScrollTopRef.current = null;
    if (flowId) {
      flowScrollMemoryRef.current.set(flowId, {
        anchorId: null,
        anchorOffset: 0,
        scrollTop: scrollRef?.current?.scrollTop ?? 0,
        followBottom: true,
      });
    }
    scrollToBottom({ animation: "instant" });
  }, [flowId, scrollRef, scrollToBottom]);

  const followIfAtBottom = useCallback(() => {
    const remembered = flowId ? flowScrollMemoryRef.current.get(flowId) : undefined;
    if (!(remembered?.followBottom ?? isAtBottom)) return false;
    follow();
    return true;
  }, [flowId, follow, isAtBottom]);

  return (
    <TranscriptScrollContext.Provider value={{ toggle, follow, followIfAtBottom, registerThread: setThread }}>
      {children}
    </TranscriptScrollContext.Provider>
  );
}

export function useTranscriptScroll() {
  return useContext(TranscriptScrollContext);
}

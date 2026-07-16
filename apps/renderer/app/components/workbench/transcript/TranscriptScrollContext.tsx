import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useStickToBottomContext } from "use-stick-to-bottom";

type TranscriptScrollContextValue = {
  toggle: <T extends HTMLElement>(event: React.MouseEvent<T>, change: () => void) => void;
  follow: () => void;
  registerThread: (element: HTMLDivElement | null) => void;
};

const TranscriptScrollContext = createContext<TranscriptScrollContextValue>({
  toggle: (_event, change) => change(),
  follow: () => {},
  registerThread: () => {},
});

export function TranscriptScrollProvider({ children }: { children: React.ReactNode }) {
  const { scrollRef, scrollToBottom, stopScroll = () => {} } = useStickToBottomContext();
  const [thread, setThread] = useState<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const programmaticScrollTopRef = useRef<number | null>(null);

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
    scrollToBottom({ animation: "instant" });
  }, [scrollToBottom]);

  return (
    <TranscriptScrollContext.Provider value={{ toggle, follow, registerThread: setThread }}>
      {children}
    </TranscriptScrollContext.Provider>
  );
}

export function useTranscriptScroll() {
  return useContext(TranscriptScrollContext);
}

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { TranscriptScrollProvider, useTranscriptScroll } from "./TranscriptScrollContext";

const scrollToBottom = vi.fn();
const stopScroll = vi.fn();
const scrollRef = { current: null as HTMLDivElement | null };

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({
    scrollRef,
    scrollToBottom,
    stopScroll,
  }),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 160,
    height: 24,
    top,
    right: 160,
    bottom: top + 24,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function ToggleProbe() {
  const { registerThread, toggle } = useTranscriptScroll();
  const [expanded, setExpanded] = useState(false);
  const topRef = useRef(140);
  topRef.current = expanded ? 240 : 140;

  return (
    <div
      ref={(element) => {
        scrollRef.current = element;
      }}
    >
      <div ref={registerThread}>
        <button
          type="button"
          ref={(element) => {
            if (!element) return;
            (element as HTMLElement).getBoundingClientRect = () => rect(topRef.current);
          }}
          onClick={(event) => toggle(event, () => setExpanded((value) => !value))}
        >
          切换
        </button>
        {expanded ? <div>详情</div> : null}
      </div>
    </div>
  );
}

describe("TranscriptScrollContext", () => {
  beforeEach(() => {
    scrollRef.current = null;
    scrollToBottom.mockReset();
    stopScroll.mockReset();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverMock,
    });
  });

  it("keeps the trigger anchored when expanding and collapsing a block", () => {
    render(
      <TranscriptScrollProvider>
        <ToggleProbe />
      </TranscriptScrollProvider>,
    );

    const scrollElement = scrollRef.current;
    expect(scrollElement).not.toBeNull();
    scrollElement!.scrollTop = 320;

    const button = screen.getByRole("button", { name: "切换" });
    fireEvent.click(button);
    expect(stopScroll).toHaveBeenCalledTimes(1);
    expect(scrollElement!.scrollTop).toBe(420);

    fireEvent.click(button);
    expect(stopScroll).toHaveBeenCalledTimes(2);
    expect(scrollElement!.scrollTop).toBe(320);
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  captureTranscriptScrollMemory,
  restoreTranscriptScrollMemory,
  TranscriptScrollProvider,
  useTranscriptScroll,
} from "./TranscriptScrollContext";

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

function FlowScrollProbe({
  flowId,
  isLoadingHistory,
  anchorTop,
}: {
  flowId: string;
  isLoadingHistory: boolean;
  anchorTop: number;
}) {
  return (
    <TranscriptScrollProvider flowId={flowId} isLoadingHistory={isLoadingHistory}>
      <FlowScrollThread flowId={flowId} anchorTop={anchorTop} />
    </TranscriptScrollProvider>
  );
}

function FlowScrollThread({ flowId, anchorTop }: { flowId: string; anchorTop: number }) {
  const { registerThread } = useTranscriptScroll();
  return (
    <div
      data-testid="flow-scroll-element"
      ref={(element) => {
        scrollRef.current = element;
        if (!element) return;
        Object.defineProperties(element, {
          clientHeight: { configurable: true, value: 400 },
          scrollHeight: { configurable: true, value: 1_400 },
        });
        element.getBoundingClientRect = () => ({ ...rect(100), height: 400, bottom: 500 });
      }}
    >
      <div ref={registerThread}>
        <div
          data-transcript-anchor-id={`${flowId}-anchor`}
          ref={(element) => {
            if (element) element.getBoundingClientRect = () => ({ ...rect(anchorTop), height: 120, bottom: anchorTop + 120 });
          }}
        />
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

  it("restores the same message and viewport offset after another flow changes the scroll position", () => {
    const scrollElement = document.createElement("div");
    const firstMessage = document.createElement("div");
    const secondMessage = document.createElement("div");
    firstMessage.dataset.transcriptAnchorId = "msg-flow-1-anchor";
    secondMessage.dataset.transcriptAnchorId = "msg-flow-1-next";
    scrollElement.append(firstMessage, secondMessage);
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_400 },
    });
    scrollElement.getBoundingClientRect = () => ({ ...rect(100), height: 400, bottom: 500 });
    firstMessage.getBoundingClientRect = () => ({ ...rect(70), height: 120, bottom: 190 });
    secondMessage.getBoundingClientRect = () => ({ ...rect(220), height: 120, bottom: 340 });
    scrollElement.scrollTop = 360;

    const memory = captureTranscriptScrollMemory(scrollElement);
    expect(memory).toEqual({
      anchorId: "msg-flow-1-anchor",
      anchorOffset: -30,
      scrollTop: 360,
      followBottom: false,
    });

    scrollElement.scrollTop = 80;
    firstMessage.getBoundingClientRect = () => ({ ...rect(250), height: 120, bottom: 370 });
    expect(restoreTranscriptScrollMemory(scrollElement, memory)).toBe(true);
    expect(scrollElement.scrollTop).toBe(260);
  });

  it("remembers when the transcript was following the bottom", () => {
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    scrollElement.getBoundingClientRect = () => ({ ...rect(100), height: 400, bottom: 500 });
    scrollElement.scrollTop = 580;

    expect(captureTranscriptScrollMemory(scrollElement).followBottom).toBe(true);
  });

  it("keeps separate reading positions while switching between flows", async () => {
    const { rerender } = render(
      <FlowScrollProbe flowId="flow-1" isLoadingHistory anchorTop={70} />,
    );
    rerender(<FlowScrollProbe flowId="flow-1" isLoadingHistory={false} anchorTop={70} />);
    await waitFor(() => expect(scrollToBottom).toHaveBeenCalled());

    const scrollElement = screen.getByTestId("flow-scroll-element");
    scrollElement.scrollTop = 360;
    fireEvent.scroll(scrollElement);

    rerender(<FlowScrollProbe flowId="flow-2" isLoadingHistory anchorTop={140} />);
    rerender(<FlowScrollProbe flowId="flow-2" isLoadingHistory={false} anchorTop={140} />);
    await waitFor(() => expect(scrollToBottom).toHaveBeenCalledTimes(2));
    scrollElement.scrollTop = 700;
    fireEvent.scroll(scrollElement);

    rerender(<FlowScrollProbe flowId="flow-1" isLoadingHistory anchorTop={250} />);
    scrollElement.scrollTop = 80;
    rerender(<FlowScrollProbe flowId="flow-1" isLoadingHistory={false} anchorTop={250} />);

    await waitFor(() => expect(scrollElement.scrollTop).toBe(260));
  });
});

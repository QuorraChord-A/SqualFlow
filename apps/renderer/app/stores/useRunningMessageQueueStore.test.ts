import { beforeEach, describe, expect, it } from "vitest";
import {
  resetRunningMessageQueueStoreForTests,
  useRunningMessageQueueStore,
  type RunningQueuedMessage,
} from "./useRunningMessageQueueStore";
import type { BrowserElementAttachment } from "./useBrowserSelectionStore";
import type { MessageImageAttachment } from "../types/messageAttachments";

function browserAttachment(id: string): BrowserElementAttachment {
  return {
    id,
    addedAt: Date.now(),
    comment: "注释",
    tagName: "button",
    text: "按钮",
    selector: `button#${id}`,
    role: "button",
    ariaLabel: "按钮",
    title: "",
    url: "http://localhost:3000/",
    pageTitle: "SquadFlow",
    markerNumber: 1,
    screenshotDataUrl: "data:image/png;base64,abc",
    viewport: { width: 1200, height: 800 },
    rect: { x: 0, y: 0, width: 10, height: 10 },
    attributes: { id, className: "", href: "", name: "", type: "button" },
  };
}

function imageAttachment(id: string): MessageImageAttachment {
  return {
    id,
    kind: "image",
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,abc",
    name: "screenshot.png",
    addedAt: Date.now(),
  };
}

describe("useRunningMessageQueueStore projection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRunningMessageQueueStoreForTests();
  });

  it(
    "projects backend queue state without treating localStorage as the queue authority",
    () => {
      const message: RunningQueuedMessage = {
        id: "queued-with-attachments",
        content: "带附件的排队消息",
        browserElementAttachments: [browserAttachment("marker-1")],
        imageAttachments: [imageAttachment("image-1")],
      };

      useRunningMessageQueueStore.getState().setFlowQueue("flow-1", [message]);

      const inMemory = useRunningMessageQueueStore.getState().queuesByFlow["flow-1"] ?? [];
      expect(inMemory[0]?.browserElementAttachments).toHaveLength(1);
      expect(inMemory[0]?.imageAttachments).toHaveLength(1);

      expect(window.localStorage.getItem("squadflow.runningMessageQueue.v1:flow-1")).toBeNull();

      resetRunningMessageQueueStoreForTests();
      const rehydrated = useRunningMessageQueueStore.getState().hydrateFlowQueue("flow-1");
      expect(rehydrated).toEqual([]);
    },
  );
});

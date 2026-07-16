import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserElementsToOutgoingAttachments,
  useBrowserSelectionStore,
  type BrowserElementAttachment,
} from "./useBrowserSelectionStore";
import type { DesktopBrowserSelectedElement } from "../lib/desktopBrowser";

function selectedElement(label: string, markerNumber = 1): DesktopBrowserSelectedElement {
  return {
    tagName: "button",
    text: label,
    selector: `button[data-label="${label}"]`,
    role: "button",
    ariaLabel: label,
    title: "",
    url: "http://localhost:3000/",
    pageTitle: "SquadFlow",
    markerNumber,
    comment: label,
    screenshotDataUrl: "data:image/png;base64,abc",
    viewport: { width: 1200, height: 800 },
    rect: { x: 12, y: 24, width: 100, height: 32 },
    attributes: { id: "", className: "", href: "", name: "", type: "button" },
  };
}

describe("useBrowserSelectionStore", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useBrowserSelectionStore.setState({
      activeFlowId: null,
      elements: [],
      elementsByFlow: {},
    });
  });

  it("restores browser annotations when switching back to a flow", () => {
    const store = useBrowserSelectionStore.getState();
    store.setActiveFlowId("flow-a");
    useBrowserSelectionStore.getState().addElement(selectedElement("注释 A"));

    useBrowserSelectionStore.getState().setActiveFlowId("flow-b");
    expect(useBrowserSelectionStore.getState().elements).toEqual([]);
    useBrowserSelectionStore.getState().addElement(selectedElement("注释 B"));

    useBrowserSelectionStore.getState().setActiveFlowId("flow-a");
    expect(useBrowserSelectionStore.getState().elements).toMatchObject([
      { comment: "注释 A", markerNumber: 1 },
    ]);

    useBrowserSelectionStore.getState().setActiveFlowId("flow-b");
    expect(useBrowserSelectionStore.getState().elements).toMatchObject([
      { comment: "注释 B", markerNumber: 1 },
    ]);
  });

  it("renumbers browser annotations after removing one item", () => {
    useBrowserSelectionStore.getState().setActiveFlowId("flow-a");
    useBrowserSelectionStore.getState().addElement(selectedElement("一", 1));
    useBrowserSelectionStore.getState().addElement(selectedElement("二", 2));
    useBrowserSelectionStore.getState().addElement(selectedElement("三", 3));

    const second = useBrowserSelectionStore.getState().elements[1] as BrowserElementAttachment;
    useBrowserSelectionStore.getState().removeElement(second.id);

    expect(useBrowserSelectionStore.getState().elements.map((element) => ({
      comment: element.comment,
      markerNumber: element.markerNumber,
    }))).toEqual([
      { comment: "一", markerNumber: 1 },
      { comment: "三", markerNumber: 2 },
    ]);
  });

  it("syncs confirmed browser markers when annotations change", async () => {
    const setConfirmedMarkers = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      setConfirmedMarkers,
    });

    useBrowserSelectionStore.getState().setActiveFlowId("flow-a");
    useBrowserSelectionStore.getState().addElement(selectedElement("一", 1));
    useBrowserSelectionStore.getState().addElement(selectedElement("二", 2));
    const first = useBrowserSelectionStore.getState().elements[0] as BrowserElementAttachment;

    useBrowserSelectionStore.getState().removeElement(first.id);

    await Promise.resolve();
    expect(setConfirmedMarkers).toHaveBeenLastCalledWith([
      {
        markerNumber: 1,
        selector: 'button[data-label="二"]',
        rect: { x: 12, y: 24, width: 100, height: 32 },
      },
    ]);

    useBrowserSelectionStore.getState().clearElements();
    await Promise.resolve();
    expect(setConfirmedMarkers).toHaveBeenLastCalledWith([]);
  });

  it("only syncs confirmed browser markers for the current browser URL", async () => {
    const setConfirmedMarkers = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      getState: vi.fn().mockResolvedValue({
        url: "http://localhost:3000/current",
        title: "Current",
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        pickerActive: true,
      }),
      setConfirmedMarkers,
    });

    useBrowserSelectionStore.getState().setActiveFlowId("flow-a");
    useBrowserSelectionStore.getState().setElements([
      { ...selectedElement("旧页面", 1), url: "http://localhost:3000/old" } as BrowserElementAttachment,
      { ...selectedElement("当前页面", 2), url: "http://localhost:3000/current" } as BrowserElementAttachment,
    ]);

    await vi.waitFor(() => {
      expect(setConfirmedMarkers).toHaveBeenLastCalledWith([
        {
          markerNumber: 2,
          selector: 'button[data-label="当前页面"]',
          rect: { x: 12, y: 24, width: 100, height: 32 },
        },
      ]);
    });
  });

  it("keeps browser comment metadata when screenshot capture failed", () => {
    const element = {
      ...selectedElement("无截图注释"),
      id: "browser-no-screenshot",
      addedAt: 1,
      screenshotDataUrl: undefined,
      selector: 'button[data-state="]:ready"] · span',
    } as BrowserElementAttachment;

    expect(browserElementsToOutgoingAttachments([element])).toEqual([{
      id: "browser-no-screenshot",
      kind: "browser_comment",
      marker_number: 1,
      comment: "无截图注释",
      label: "无截图注释",
      page_url: "http://localhost:3000/",
      selector: 'button[data-state="]:ready"] · span',
    }]);
  });
});

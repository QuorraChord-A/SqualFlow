import { describe, expect, it } from "vitest";
import {
  clampLeftPanelWidth,
  clampRightPanelWidth,
  collapseLeftPanelWidths,
  getMaxLeftPanelWidth,
  getMinimumChatWidth,
  MIN_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  normalizePanelWidths,
  resizeLeftPanelWithRightCompensation,
  shouldCollapsePanelDrag,
} from "./panelSizing";

describe("panel sizing", () => {
  it("caps the left panel at thirty percent while preserving chat space", () => {
    expect(getMaxLeftPanelWidth(1440)).toBe(432);
    expect(clampLeftPanelWidth(600, 1440, 620)).toBe(388);
    expect(clampLeftPanelWidth(600, 1100, 480)).toBe(200);
  });

  it("derives the right panel maximum from the left panel and middle floor", () => {
    expect(clampRightPanelWidth(1200, 1440, 432)).toBe(576);
    expect(clampRightPanelWidth(1200, 1440, 288)).toBe(720);
    expect(clampRightPanelWidth(1200, 1440, 0)).toBe(1008);
    expect(clampRightPanelWidth(300, 1440, 260)).toBe(320);
  });

  it("protects the middle chat column with a viewport ratio floor", () => {
    expect(getMinimumChatWidth(1100)).toBe(420);
    expect(getMinimumChatWidth(1440)).toBe(432);
    expect(getMinimumChatWidth(2048)).toBe(614);
  });

  it("lets left-panel expansion shrink the middle before the right panel", () => {
    expect(resizeLeftPanelWithRightCompensation(364, 1440, 260, 620, true)).toEqual({
      left: 364,
      right: 620,
    });
  });

  it("shrinks the right panel only after the middle reaches its floor", () => {
    expect(resizeLeftPanelWithRightCompensation(432, 1440, 260, 620, true)).toEqual({
      left: 432,
      right: 576,
    });
  });

  it("rebalances the middle and right panels to three-seven when the left panel collapses", () => {
    expect(collapseLeftPanelWidths(1440)).toEqual({
      left: 0,
      right: 1008,
    });
  });

  it("shrinks persisted widths proportionally on narrow viewports", () => {
    expect(normalizePanelWidths(1100, 520, 620)).toEqual({
      left: 330,
      right: 350,
    });
    expect(normalizePanelWidths(900, 520, 620)).toEqual({
      left: 270,
      right: 210,
    });
  });

  it("treats dragging past seventy percent of a panel minimum as collapse intent", () => {
    expect(shouldCollapsePanelDrag(MIN_LEFT_PANEL_WIDTH * 0.3, MIN_LEFT_PANEL_WIDTH)).toBe(true);
    expect(shouldCollapsePanelDrag(MIN_LEFT_PANEL_WIDTH * 0.3 + 1, MIN_LEFT_PANEL_WIDTH)).toBe(false);
    expect(shouldCollapsePanelDrag(MIN_RIGHT_PANEL_WIDTH * 0.3, MIN_RIGHT_PANEL_WIDTH)).toBe(true);
    expect(shouldCollapsePanelDrag(MIN_RIGHT_PANEL_WIDTH * 0.3 + 1, MIN_RIGHT_PANEL_WIDTH)).toBe(false);
  });
});

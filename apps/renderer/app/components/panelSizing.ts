export const MIN_CHAT_WIDTH = 420;
export const MIN_CHAT_WIDTH_RATIO = 0.3;
export const MIN_LEFT_PANEL_WIDTH = 208;
export const MAX_LEFT_PANEL_WIDTH_RATIO = 0.3;
export const MIN_RIGHT_PANEL_WIDTH = 320;
export const DEFAULT_RIGHT_PANEL_WIDTH = 720;
export const PANEL_DRAG_COLLAPSE_RATIO = 0.3;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function getMinimumChatWidth(viewportWidth: number) {
  return Math.max(MIN_CHAT_WIDTH, Math.floor(viewportWidth * MIN_CHAT_WIDTH_RATIO));
}

export function getMaxLeftPanelWidth(viewportWidth: number) {
  return Math.floor(viewportWidth * MAX_LEFT_PANEL_WIDTH_RATIO);
}

export function clampLeftPanelWidth(desired: number, viewportWidth: number, rightWidth: number) {
  const dynamicMax = Math.min(getMaxLeftPanelWidth(viewportWidth), viewportWidth - rightWidth - getMinimumChatWidth(viewportWidth));
  const effectiveMin = Math.min(MIN_LEFT_PANEL_WIDTH, Math.max(0, dynamicMax));
  return clamp(desired, effectiveMin, dynamicMax);
}

export function clampRightPanelWidth(desired: number, viewportWidth: number, leftWidth: number) {
  const dynamicMax = viewportWidth - leftWidth - getMinimumChatWidth(viewportWidth);
  const effectiveMin = Math.min(MIN_RIGHT_PANEL_WIDTH, Math.max(0, dynamicMax));
  return clamp(desired, effectiveMin, dynamicMax);
}

export function resizeLeftPanelWithRightCompensation(
  desiredLeft: number,
  viewportWidth: number,
  currentLeft: number,
  currentRight: number,
  isRightOpen: boolean,
) {
  const minimumChatWidth = getMinimumChatWidth(viewportWidth);
  const leftMax = getMaxLeftPanelWidth(viewportWidth);
  const leftMin = Math.min(MIN_LEFT_PANEL_WIDTH, Math.max(0, leftMax));
  const requestedLeft = clamp(desiredLeft, leftMin, leftMax);
  let right = currentRight;

  if (!isRightOpen || requestedLeft <= currentLeft) {
    return { left: requestedLeft, right };
  }

  const currentMiddle = viewportWidth - currentLeft - currentRight;
  const middleAvailable = Math.max(0, currentMiddle - minimumChatWidth);
  const rightMin = Math.min(MIN_RIGHT_PANEL_WIDTH, currentRight);
  const rightAvailable = Math.max(0, currentRight - rightMin);
  const appliedDelta = Math.min(requestedLeft - currentLeft, middleAvailable + rightAvailable);
  const rightDelta = Math.max(0, appliedDelta - middleAvailable);
  const left = currentLeft + appliedDelta;
  right = currentRight - rightDelta;

  return { left, right };
}

export function collapseLeftPanelWidths(viewportWidth: number) {
  return {
    left: 0,
    right: viewportWidth - getMinimumChatWidth(viewportWidth),
  };
}

export function normalizePanelWidths(viewportWidth: number, leftWidth: number, rightWidth: number) {
  const initialLeft = clamp(leftWidth, MIN_LEFT_PANEL_WIDTH, getMaxLeftPanelWidth(viewportWidth));
  const right = clampRightPanelWidth(rightWidth, viewportWidth, initialLeft);
  const left = clampLeftPanelWidth(initialLeft, viewportWidth, right);
  return { left, right };
}

export function shouldCollapsePanelDrag(desiredWidth: number, minWidth: number) {
  return desiredWidth <= minWidth * PANEL_DRAG_COLLAPSE_RATIO;
}

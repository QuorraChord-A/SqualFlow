import "@testing-library/jest-dom/vitest";

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

// jsdom focuses contenteditable elements without creating the collapsed DOM
// selection that browsers create. user-event needs that range before it can
// emit realistic beforeinput/input events for rich-text editors.
document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.getAttribute("contenteditable") !== "true") return;
  const selection = document.getSelection();
  if (!selection || (selection.rangeCount > 0 && target.contains(selection.focusNode))) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
});

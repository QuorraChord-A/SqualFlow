import { describe, expect, it } from "vitest";
import { collapseReducer, collapseValue, emptyCollapseState } from "./collapseState";

describe("collapseValue", () => {
  it("falls back to the block's defaultCollapsed when no entry is recorded yet", () => {
    expect(collapseValue(emptyCollapseState, "block-1", true)).toBe("collapsed");
    expect(collapseValue(emptyCollapseState, "block-1", false)).toBe("expanded");
  });

  it("returns the recorded value instead of the current defaultCollapsed once initialized", () => {
    const state = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", false)).toBe("collapsed");
  });
});

describe("collapseReducer", () => {
  it("freezes the default collapse value the first time a block is seen", () => {
    const state = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", true)).toBe("collapsed");
  });

  it("does not let a later default recomputation override an already-recorded block", () => {
    // Simulates a reasoning block whose own `defaultCollapsed` value changes
    // across recomputations (e.g. once something follows it in the block
    // list) after the user has already seen or chosen a state for it.
    let state = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: false });
    state = collapseReducer(state, { type: "init", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", true)).toBe("expanded");
  });

  it("returns the same state reference when init is a no-op", () => {
    const initialized = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: true });
    const reInitialized = collapseReducer(initialized, { type: "init", blockId: "block-1", defaultCollapsed: false });
    expect(reInitialized).toBe(initialized);
  });

  it("toggles a block from its recorded value", () => {
    let state = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: true });
    state = collapseReducer(state, { type: "toggle", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", true)).toBe("expanded");

    state = collapseReducer(state, { type: "toggle", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", true)).toBe("collapsed");
  });

  it("toggles a block that was never explicitly initialized, using defaultCollapsed as the starting point", () => {
    const state = collapseReducer(emptyCollapseState, { type: "toggle", blockId: "block-1", defaultCollapsed: true });
    expect(collapseValue(state, "block-1", true)).toBe("expanded");
  });

  it("keeps different blockIds independent", () => {
    let state = collapseReducer(emptyCollapseState, { type: "init", blockId: "block-1", defaultCollapsed: true });
    state = collapseReducer(state, { type: "init", blockId: "block-2", defaultCollapsed: false });
    state = collapseReducer(state, { type: "toggle", blockId: "block-1", defaultCollapsed: true });

    expect(collapseValue(state, "block-1", true)).toBe("expanded");
    expect(collapseValue(state, "block-2", false)).toBe("expanded");
  });
});

"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { collapseReducer, collapseValue, emptyCollapseState, type CollapseState } from "./collapseState";

type CollapseStoreState = {
  state: CollapseState;
  init: (blockId: string, defaultCollapsed: boolean) => void;
  toggle: (blockId: string, defaultCollapsed: boolean) => void;
};

const useCollapseStore = create<CollapseStoreState>((set, get) => ({
  state: emptyCollapseState,
  init: (blockId, defaultCollapsed) => {
    const next = collapseReducer(get().state, { type: "init", blockId, defaultCollapsed });
    if (next !== get().state) set({ state: next });
  },
  toggle: (blockId, defaultCollapsed) => {
    set((current) => ({ state: collapseReducer(current.state, { type: "toggle", blockId, defaultCollapsed }) }));
  },
}));

/**
 * Single shared collapse/expand mechanism for every foldable block (turn
 * header, reasoning, tool-group, tool-row). Backed by the pure reducer in
 * `collapseState.ts`, so a block's own `defaultCollapsed` recomputing on
 * later renders never overrides a state the user already chose for that
 * `blockId` — replacing three previously-separate, inconsistent
 * implementations (AssistantTurn's unprotected effect, ToolGroup's
 * `userToggledRef`, ToolRow's plain `useState`).
 */
export function useCollapse(blockId: string, defaultCollapsed: boolean): { expanded: boolean; toggle: () => void } {
  const value = useCollapseStore((store) => collapseValue(store.state, blockId, defaultCollapsed));
  const init = useCollapseStore((store) => store.init);
  const toggleAction = useCollapseStore((store) => store.toggle);

  useEffect(() => {
    init(blockId, defaultCollapsed);
  }, [blockId, defaultCollapsed, init]);

  return {
    expanded: value === "expanded",
    toggle: () => toggleAction(blockId, defaultCollapsed),
  };
}

export function resetCollapseStoreForTests() {
  useCollapseStore.setState({ state: emptyCollapseState });
}

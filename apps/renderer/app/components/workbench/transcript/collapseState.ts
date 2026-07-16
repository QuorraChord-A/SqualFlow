export type CollapseValue = "expanded" | "collapsed";

export type CollapseState = Map<string, CollapseValue>;

export type CollapseAction =
  | { type: "init"; blockId: string; defaultCollapsed: boolean }
  | { type: "toggle"; blockId: string; defaultCollapsed: boolean };

export const emptyCollapseState: CollapseState = new Map();

/**
 * Read a block's current collapse value. Falls back to the block's own
 * `defaultCollapsed` when no explicit entry has been recorded yet (e.g. the
 * very first render, before the "init" action below has been dispatched).
 */
export function collapseValue(
  state: CollapseState,
  blockId: string,
  defaultCollapsed: boolean,
): CollapseValue {
  return state.get(blockId) ?? (defaultCollapsed ? "collapsed" : "expanded");
}

/**
 * Freezes a block's default collapse value the first time it is seen, and
 * flips it on toggle. "init" is a no-op once a blockId is recorded, so a
 * block's own `defaultCollapsed` recomputing on later renders (e.g. a
 * reasoning block whose default depends on what follows it) never overrides
 * a value the user has already seen or chosen.
 */
export function collapseReducer(state: CollapseState, action: CollapseAction): CollapseState {
  switch (action.type) {
    case "init": {
      if (state.has(action.blockId)) return state;
      const next = new Map(state);
      next.set(action.blockId, action.defaultCollapsed ? "collapsed" : "expanded");
      return next;
    }
    case "toggle": {
      const current = collapseValue(state, action.blockId, action.defaultCollapsed);
      const next = new Map(state);
      next.set(action.blockId, current === "collapsed" ? "expanded" : "collapsed");
      return next;
    }
  }
}

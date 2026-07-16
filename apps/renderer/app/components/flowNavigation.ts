export type FlowNavigationState = {
  entries: string[];
  index: number;
};

export function recordFlowNavigationVisit(
  current: FlowNavigationState,
  flowId: string,
  selectedFlowId: string | null,
): FlowNavigationState {
  const currentFlowId = current.index >= 0 ? current.entries[current.index] : null;
  if (currentFlowId === flowId) return current;

  const entriesBeforeCurrent = current.index >= 0
    ? current.entries.slice(0, current.index + 1)
    : selectedFlowId && selectedFlowId !== flowId
      ? [selectedFlowId]
      : [];
  const entries = [...entriesBeforeCurrent.filter((entry) => entry !== flowId), flowId];
  return { entries, index: entries.length - 1 };
}

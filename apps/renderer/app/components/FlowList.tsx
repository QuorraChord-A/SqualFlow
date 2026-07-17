'use client';

import { Plus } from 'lucide-react';
import FlowItem from './FlowItem';
import { useFlowStore } from '../stores/useFlowStore';
import type { SquadFlow } from '../types';

interface FlowListProps {
  onNewFlow: () => void;
  onRefresh: () => void;
  onAbortFlow?: (flow: SquadFlow) => void;
  onEditFlow?: (flow: SquadFlow) => void;
  onDeleteFlow?: (flow: SquadFlow) => void;
  onClearAll?: () => void;
}

export function sortFlows(flows: SquadFlow[]) {
  return [...flows].sort((a, b) => {
    if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) return a.is_pinned ? -1 : 1;
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}

export default function FlowList({
  onNewFlow,
  onRefresh,
  onAbortFlow,
  onEditFlow,
  onDeleteFlow,
  onClearAll,
}: FlowListProps) {
  const { flows, selectedFlowId, handleSelectFlow, setFlowPinned } = useFlowStore();
  const sortedFlows = sortFlows(flows);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Flows</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            className="p-1 rounded hover:bg-card text-muted-foreground hover:text-muted-foreground transition-colors"
            title="刷新"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onNewFlow}
            className="p-1 rounded hover:bg-primary/10 text-primary hover:text-primary/80 transition-colors"
            title="新建流程"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {flows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground text-sm">No flows yet</p>
            <button
              onClick={onNewFlow}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              Create your first flow
            </button>
          </div>
        ) : (
          sortedFlows.map((flow) => (
            <FlowItem
              key={flow.id}
              flow={flow}
              selected={selectedFlowId === flow.id}
              onClick={() => handleSelectFlow(flow)}
              onAbortFlow={onAbortFlow}
              onEditFlow={onEditFlow}
              onDeleteFlow={onDeleteFlow}
              onTogglePinned={(target) => void setFlowPinned(target.id, !target.is_pinned)}
            />
          ))
        )}

        {onClearAll && (
          <button
            onClick={onClearAll}
            className="mt-2 w-full py-2 text-xs text-destructive hover:text-destructive/80 hover:bg-destructive/5 rounded-lg transition-colors border border-transparent hover:border-destructive/20"
          >
            清除所有 Flow
          </button>
        )}
      </div>
    </div>
  );
}

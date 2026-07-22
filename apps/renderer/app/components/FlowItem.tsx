'use client';

import { useState } from 'react';
import { Copy, Folder, FolderOpen, MoreHorizontal, Pencil, Pin, PinOff, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import type { SquadFlow } from '../types';
import { useFlowNameReveal } from '../hooks/useFlowNameReveal';

interface FlowItemProps {
  flow: SquadFlow;
  projectName?: string | null;
  projectPath?: string | null;
  selected: boolean;
  onClick: () => void;
  onEditFlow?: (flow: SquadFlow) => void;
  onAbortFlow?: (flow: SquadFlow) => void;
  onDeleteFlow?: (flow: SquadFlow) => void;
  onTogglePinned?: (flow: SquadFlow) => void;
  displayTimestamp?: string;
}

export function formatRelativeTime(value: string, currentTime = Date.now()) {
  const elapsed = Math.max(0, currentTime - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

const FLOW_STATUS_LABELS: Record<SquadFlow['status'], string> = {
  ready: '未开始',
  active: '进行中',
  idle: '空闲',
};

export default function FlowItem({
  flow,
  projectName,
  projectPath,
  selected,
  onClick,
  onEditFlow,
  onAbortFlow,
  onDeleteFlow,
  onTogglePinned,
  displayTimestamp = flow.updated_at,
}: FlowItemProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const displayName = useFlowNameReveal(flow.name);
  const isStreaming = Boolean(flow.is_streaming);
  const isRunning = flow.status === 'active';
  const hasUnreadOutput = Boolean(flow.has_unread_messages);
  const canOpenInFinder = Boolean(
    projectPath
    && typeof window !== 'undefined'
    && window.squadflowDesktopShell?.showItemInFolder,
  );

  const handleMenuAction = (action: 'pin' | 'edit' | 'abort' | 'delete') => {
    switch (action) {
      case 'pin':
        onTogglePinned?.(flow);
        break;
      case 'edit':
        onEditFlow?.(flow);
        break;
      case 'abort':
        onAbortFlow?.(flow);
        break;
      case 'delete':
        onDeleteFlow?.(flow);
        break;
    }
  };

  const copyFlowId = async () => {
    await navigator.clipboard.writeText(flow.id);
    toast.success('已复制 Flow ID');
  };

  const openProjectInFinder = () => {
    if (!projectPath) return;
    void window.squadflowDesktopShell?.showItemInFolder?.(projectPath, true);
  };

  return (
    <HoverCard
      open={!menuOpen && detailsOpen}
      onOpenChange={(open) => setDetailsOpen(menuOpen ? false : open)}
    >
      <HoverCardTrigger
        delay={350}
        closeDelay={120}
        render={(
          <div
            role="button"
            tabIndex={0}
            aria-label={`打开流程：${flow.name}`}
            onClick={onClick}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }}
            className={`group relative mb-0.5 flex h-10 cursor-pointer items-center gap-2 rounded-md px-3 transition-colors ${
              selected
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          />
        )}
      >
        <div className="relative flex size-4 shrink-0 items-center justify-center">
          <span
            data-testid="flow-status-indicator"
            className="flex size-4 items-center justify-center transition-opacity group-hover:opacity-0"
          >
            {flow.has_pending_decision ? (
              <span
                data-testid="flow-pending-spinner"
                className="size-2.5 animate-spin rounded-full border-2 border-status-pending/35 border-t-status-pending"
              />
            ) : isStreaming ? (
              <span
                data-testid="flow-streaming-spinner"
                className="size-2.5 animate-spin rounded-full border-2 border-emerald-400/35 border-t-emerald-400"
              />
            ) : (
              <span
                data-testid="flow-status-dot"
                className={`size-2 rounded-full ${hasUnreadOutput ? 'bg-blue-500' : 'bg-muted-foreground/45'}`}
              />
            )}
          </span>
          {onTogglePinned && (
            <button
              type="button"
              aria-label={flow.is_pinned ? '取消置顶' : '置顶流程'}
              title={flow.is_pinned ? '取消置顶' : '置顶流程'}
              onClick={(event) => {
                event.stopPropagation();
                handleMenuAction('pin');
              }}
              className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity hover:bg-background/70 group-hover:opacity-100 focus-visible:opacity-100"
            >
              {flow.is_pinned ? (
                <PinOff className="size-3.5 text-muted-foreground" />
              ) : (
                <Pin className="size-3.5 rotate-[-20deg] text-muted-foreground" />
              )}
            </button>
          )}
        </div>

        <span data-testid="flow-name" aria-hidden="true" className="min-w-0 flex-1 truncate text-sm">{displayName}</span>

        {flow.legacy_spec_flow && (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] font-medium text-muted-foreground" title="历史 Spec 流程，只读兼容">
            历史 Spec
          </span>
        )}

        {flow.has_pending_decision && (
          <span className="shrink-0 text-[10px] font-medium text-status-pending">
            等待操作
          </span>
        )}

        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) setDetailsOpen(false);
          }}
        >
          <DropdownMenuTrigger
            aria-label={`${flow.name} 操作`}
            onClick={(event) => event.stopPropagation()}
            className="flex h-7 min-w-10 shrink-0 items-center justify-end rounded px-1 text-[11px] text-muted-foreground transition-[width,min-width,background-color,color] hover:text-foreground group-hover:w-7 group-hover:min-w-7 group-hover:justify-center group-hover:bg-background/70 group-hover:px-0 data-popup-open:w-7 data-popup-open:min-w-7 data-popup-open:justify-center data-popup-open:bg-background/70 data-popup-open:px-0"
          >
            {menuOpen ? (
              <MoreHorizontal data-testid="flow-item-menu-open-icon" className="size-4" />
            ) : (
              <>
                <span data-testid="flow-item-timestamp" className="group-hover:hidden">{formatRelativeTime(displayTimestamp)}</span>
                <MoreHorizontal className="hidden size-4 group-hover:block" />
              </>
            )}
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" side="bottom" className="w-40">
            {onTogglePinned && (
              <DropdownMenuItem
                onClick={(event) => { event.stopPropagation(); handleMenuAction('pin'); }}
              >
                {flow.is_pinned ? (
                  <PinOff className="mr-2 size-3.5 text-muted-foreground" />
                ) : (
                  <Pin className="mr-2 size-3.5 text-muted-foreground" />
                )}
                {flow.is_pinned ? '取消置顶' : '置顶流程'}
              </DropdownMenuItem>
            )}
            {onEditFlow && (
              <DropdownMenuItem
                disabled={flow.name_generation_status === 'pending'}
                onClick={(e) => { e.stopPropagation(); handleMenuAction('edit'); }}
              >
                <Pencil className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                修改流程
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canOpenInFinder}
              onClick={(event) => { event.stopPropagation(); openProjectInFinder(); }}
            >
              <FolderOpen className="mr-2 size-3.5 text-muted-foreground" />
              在 Finder 中打开
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(event) => { event.stopPropagation(); void copyFlowId(); }}
            >
              <Copy className="mr-2 size-3.5 text-muted-foreground" />
              复制 Flow ID
            </DropdownMenuItem>
            {onAbortFlow && isRunning && (
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); handleMenuAction('abort'); }}
                className="text-status-pending"
              >
                <XCircle className="w-3.5 h-3.5 mr-2" />
                终止流程
              </DropdownMenuItem>
            )}
            {(onTogglePinned || onEditFlow || (onAbortFlow && isRunning)) && onDeleteFlow && (
              <DropdownMenuSeparator />
            )}
            {onDeleteFlow && (
              <DropdownMenuItem
                variant="destructive"
                onClick={(e) => { e.stopPropagation(); handleMenuAction('delete'); }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                删除流程
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </HoverCardTrigger>

      <HoverCardContent side="right" align="start" sideOffset={8} className="w-60 p-3">
        <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
        <div className="mt-2.5 space-y-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span>阶段</span>
            <span className="truncate text-foreground">{flow.current_stage ?? '未开始'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>状态</span>
            <span className="truncate text-foreground">
              {flow.has_pending_decision ? '等待操作' : FLOW_STATUS_LABELS[flow.status]}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Folder className="size-3.5 shrink-0" />
            <span className="truncate">{projectName ?? '未绑定项目'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Flow ID</span>
            <span className="truncate text-foreground" title={flow.id}>{flow.id}</span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

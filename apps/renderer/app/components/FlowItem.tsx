'use client';

import { Folder, MoreHorizontal, Pencil, Pin, PinOff, Trash2, XCircle } from 'lucide-react';
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

interface FlowItemProps {
  flow: SquadFlow;
  projectName?: string | null;
  selected: boolean;
  onClick: () => void;
  onEditFlow?: (flow: SquadFlow) => void;
  onAbortFlow?: (flow: SquadFlow) => void;
  onDeleteFlow?: (flow: SquadFlow) => void;
  onTogglePinned?: (flow: SquadFlow) => void;
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

export default function FlowItem({
  flow,
  projectName,
  selected,
  onClick,
  onEditFlow,
  onAbortFlow,
  onDeleteFlow,
  onTogglePinned,
}: FlowItemProps) {
  const isStreaming = Boolean(flow.is_streaming);
  const isRunning = flow.status === 'active';
  const hasUnreadOutput = Boolean(flow.has_unread_messages);

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

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={350}
        closeDelay={120}
        render={(
          <div
            role="button"
            tabIndex={0}
            aria-label={`打开任务：${flow.name}`}
            onClick={onClick}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }}
            className={`group relative mb-0.5 flex h-10 cursor-pointer items-center gap-2 rounded-md px-2.5 transition-colors ${
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
              aria-label={flow.is_pinned ? '取消置顶' : '置顶任务'}
              title={flow.is_pinned ? '取消置顶' : '置顶任务'}
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

        <span className="min-w-0 flex-1 truncate text-sm">{flow.name}</span>

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

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${flow.name} 操作`}
            onClick={(event) => event.stopPropagation()}
            className="flex h-7 min-w-10 shrink-0 items-center justify-end rounded px-1 text-[11px] text-muted-foreground hover:bg-background/70 hover:text-foreground"
          >
            <span className="group-hover:hidden">{formatRelativeTime(flow.updated_at)}</span>
            <MoreHorizontal className="hidden size-4 group-hover:block" />
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
                {flow.is_pinned ? '取消置顶' : '置顶任务'}
              </DropdownMenuItem>
            )}
            {onEditFlow && (
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); handleMenuAction('edit'); }}
              >
                <Pencil className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                修改任务
              </DropdownMenuItem>
            )}
            {onAbortFlow && isRunning && (
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); handleMenuAction('abort'); }}
                className="text-status-pending"
              >
                <XCircle className="w-3.5 h-3.5 mr-2" />
                终止任务
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
                删除任务
              </DropdownMenuItem>
            )}
            {!onTogglePinned && !onEditFlow && !onAbortFlow && !onDeleteFlow && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No actions</div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </HoverCardTrigger>

      <HoverCardContent side="right" align="start" sideOffset={8} className="w-60 p-3">
        <p className="truncate text-sm font-semibold text-foreground">{flow.name}</p>
        {flow.description && (
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{flow.description}</p>
        )}
        <div className="mt-2.5 space-y-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span>阶段</span>
            <span className="truncate text-foreground">{flow.current_stage ?? '未开始'}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>状态</span>
            <span className="truncate text-foreground">
              {flow.has_pending_decision ? '等待操作' : flow.status}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Folder className="size-3.5 shrink-0" />
            <span className="truncate">{projectName ?? '未绑定项目'}</span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

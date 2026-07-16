'use client';

import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import AppSettingsMenu from './AppSettingsMenu';
import AppUpdateButton from './AppUpdateButton';
import PanelResizeHandle from './PanelResizeHandle';
import ProjectTaskList from './ProjectTaskList';
import type { SquadFlow } from '../types';

interface SidebarProps {
  width: number;
  isOpen: boolean;
  isPreviewOpen?: boolean;
  previewWidth?: number;
  drawerAnimation?: 'enter' | 'exit' | null;
  onToggle: () => void;
  onNavigatePreviousFlow?: () => void;
  onNavigateNextFlow?: () => void;
  canNavigatePreviousFlow?: boolean;
  canNavigateNextFlow?: boolean;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNewTask: () => void;
  onRefresh: () => void;
  onSelectTask: (flow: SquadFlow) => void;
  onAbortFlow?: (flow: SquadFlow) => void;
  onEditFlow?: (flow: SquadFlow) => void;
  onDeleteFlow?: (flow: SquadFlow) => void;
  onOpenSettings?: () => void;
}

export default function Sidebar({
  width,
  isOpen,
  isPreviewOpen = false,
  previewWidth,
  drawerAnimation = null,
  onToggle,
  onNavigatePreviousFlow,
  onNavigateNextFlow,
  canNavigatePreviousFlow = false,
  canNavigateNextFlow = false,
  onResizeStart,
  onNewTask,
  onRefresh,
  onSelectTask,
  onAbortFlow,
  onEditFlow,
  onDeleteFlow,
  onOpenSettings,
}: SidebarProps) {
  const isAnimatingDrawer = drawerAnimation !== null;
  const visible = isOpen || isPreviewOpen || isAnimatingDrawer;
  const isOverlay = !isOpen || isAnimatingDrawer;
  const effectiveWidth = !isOpen ? previewWidth ?? width : width;
  const shouldRenderLayoutSpacer = drawerAnimation === 'enter';
  const animationClass = drawerAnimation === 'enter'
    ? 'animate-left-sidebar-enter'
    : drawerAnimation === 'exit'
      ? 'animate-left-sidebar-exit'
      : '';
  const sidebarWidthStyle = {
    width: isOverlay ? effectiveWidth : visible ? effectiveWidth : 0,
    '--left-sidebar-width': `${effectiveWidth}px`,
  } as React.CSSProperties;

  return (
    <>
      <div className="sf-left-window-controls absolute left-2 top-2 z-50 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            data-testid="left-panel-drawer-toggle"
            type="button"
            aria-label={isOpen ? '隐藏左侧面板' : '显示左侧面板'}
            onClick={onToggle}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
          >
            {isOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </TooltipTrigger>
          <TooltipContent>{isOpen ? '隐藏面板' : '显示面板'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            data-testid="previous-flow-button"
            type="button"
            aria-label="切换到前一个任务"
            aria-disabled={!canNavigatePreviousFlow}
            onClick={() => {
              if (canNavigatePreviousFlow) onNavigatePreviousFlow?.();
            }}
            disabled={!canNavigatePreviousFlow}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <ArrowLeft className="size-4" />
          </TooltipTrigger>
          <TooltipContent>前一个任务</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            data-testid="next-flow-button"
            type="button"
            aria-label="切换到后一个任务"
            aria-disabled={!canNavigateNextFlow}
            onClick={() => {
              if (canNavigateNextFlow) onNavigateNextFlow?.();
            }}
            disabled={!canNavigateNextFlow}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <ArrowRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent>后一个任务</TooltipContent>
        </Tooltip>
      </div>
      {shouldRenderLayoutSpacer ? (
        <div
          data-testid="left-sidebar-layout-spacer"
          aria-hidden="true"
          className="relative shrink-0 overflow-hidden border-r border-transparent"
          style={{ width: effectiveWidth, '--left-sidebar-width': `${effectiveWidth}px` } as React.CSSProperties}
        />
      ) : null}
      <aside
        data-testid="left-sidebar"
        data-state={isOpen ? 'open' : 'closed'}
        data-preview-open={isPreviewOpen ? 'true' : 'false'}
        data-drawer-animation={drawerAnimation ?? 'none'}
        aria-hidden={!visible}
        inert={!visible}
        className={`${isOverlay ? 'absolute inset-y-0 left-0 z-40' : 'relative shrink-0'} ${animationClass} overflow-hidden border-r bg-sidebar text-sidebar-foreground ${
          isOverlay || isAnimatingDrawer ? 'transition-[transform,opacity,border-color] duration-200 ease-out' : 'transition-[width,border-color] duration-300 ease-in-out'
        } ${
          visible ? 'translate-x-0 border-sidebar-border opacity-100' : 'pointer-events-none -translate-x-full border-transparent opacity-0'
        } ${
          isPreviewOpen ? 'shadow-2xl' : ''
        }`}
        style={sidebarWidthStyle}
      >
        <div
          className={`flex h-full flex-col transition-[opacity,transform] duration-200 ease-out ${
            visible ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-3 opacity-0'
          }`}
          style={{ width: effectiveWidth }}
        >
          {isOpen ? <PanelResizeHandle side="left" onPointerDown={onResizeStart} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <ProjectTaskList
              onNewTask={onNewTask}
              onRefresh={onRefresh}
              onSelectTask={onSelectTask}
              onAbortFlow={onAbortFlow}
              onEditFlow={onEditFlow}
              onDeleteFlow={onDeleteFlow}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-sidebar via-sidebar/95 to-transparent px-3 pb-3 pt-10">
            <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-lg border border-sidebar-border/80 bg-sidebar/95 px-3 py-2 shadow-lg backdrop-blur">
              <div data-testid="sidebar-brand" className="flex min-w-0 items-center">
                <span className="truncate text-sm font-bold text-sidebar-foreground">SquadFlow</span>
              </div>
              <div data-testid="sidebar-bottom-actions" className="flex shrink-0 items-center gap-2">
                <AppUpdateButton />
                <AppSettingsMenu onOpenSettings={onOpenSettings} />
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

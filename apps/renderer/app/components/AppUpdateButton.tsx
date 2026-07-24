'use client';

import { useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useFlowStore } from '../stores/useFlowStore';
import { getDesktopUpdateBridge, type DesktopUpdateState } from '../lib/desktopUpdate';

const INITIAL_STATE: DesktopUpdateState = {
  enabled: false,
  automaticUpdates: true,
  status: 'idle',
  currentVersion: '',
  availableVersion: null,
  notes: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
};

export default function AppUpdateButton() {
  const [state, setState] = useState<DesktopUpdateState>(INITIAL_STATE);
  const [hasBridge, setHasBridge] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const flows = useFlowStore((s) => s.flows);
  const runningFlowCount = flows.filter((flow) => flow.status === 'active' || flow.is_streaming).length;

  useEffect(() => {
    const bridge = getDesktopUpdateBridge();
    if (!bridge) return undefined;
    setHasBridge(true);

    let active = true;
    const unsubscribe = bridge.onState((nextState) => {
      if (active) setState(nextState);
    });
    void bridge.getState().then((nextState) => {
      if (active) setState(nextState);
    }).catch(() => {});

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (!hasBridge) return null;

  const install = () => {
    const bridge = getDesktopUpdateBridge();
    if (!bridge) return;
    setInstalling(true);
    void bridge.install().then((accepted) => {
      if (!accepted) setInstalling(false);
    }).catch(() => setInstalling(false));
  };

  const retry = () => {
    const bridge = getDesktopUpdateBridge();
    if (!bridge) return;
    setRetrying(true);
    void bridge.check()
      .then((nextState) => setState(nextState))
      .catch(() => {})
      .finally(() => setRetrying(false));
  };

  if (state.status === 'ready') {
    const versionLabel = state.availableVersion ? ` 到 ${state.availableVersion}` : '';
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={(
              <button
                type="button"
                aria-label={`重启并更新 SquadFlow${versionLabel}`}
                disabled={installing}
                onClick={() => {
                  setConfirmOpen(true);
                }}
                className="flex h-9 min-w-14 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-sidebar-accent px-2.5 text-xs font-semibold text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-70"
              />
            )}
          >
            <RefreshCw className={`size-3.5 ${installing ? 'animate-spin' : ''}`} />
            <span>重启</span>
          </TooltipTrigger>
          <TooltipContent side="top">重启并更新</TooltipContent>
        </Tooltip>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重启并更新</AlertDialogTitle>
              <AlertDialogDescription>
                {runningFlowCount > 0 ? (
                  <>
                    当前有 <span className="font-medium text-foreground">{runningFlowCount}</span> 个正在运行的 Flow，
                    重启会中断它们。确定现在重启并安装更新吗？
                  </>
                ) : (
                  <>SquadFlow 将关闭、安装更新并重新打开。确定现在重启吗？</>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant={runningFlowCount > 0 ? "destructive" : "default"} onClick={install}>
                {runningFlowCount > 0 ? "中断并重启" : "重启并更新"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              aria-label="下载失败，重试"
              disabled={retrying}
              onClick={retry}
              className="flex h-9 min-w-14 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-70"
            />
          )}
        >
          <RotateCcw className={`size-3.5 ${retrying ? 'animate-spin' : ''}`} />
          <span>重试</span>
        </TooltipTrigger>
        <TooltipContent side="top">下载失败，点击重试</TooltipContent>
      </Tooltip>
    );
  }

  if (state.status !== 'downloading') return null;

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Popover>
          <PopoverTrigger
            aria-label={`正在下载 SquadFlow 更新${state.progress === null ? '' : `，${state.progress}%`}`}
            className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/60 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 bg-sidebar-primary/20 transition-[height]"
              style={{ height: `${state.progress ?? 0}%` }}
            />
            <Download className="relative z-10 size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-72 p-4">
            <div className="space-y-3 text-sm">
              <div className="font-medium text-foreground">应用更新</div>
              <div className="text-xs text-muted-foreground">
                当前版本 {state.currentVersion || '未知'}
              </div>
              <div className="text-xs text-muted-foreground" role="status">
                正在下载 {state.availableVersion ?? '新版本'}{state.progress === null ? '' : `，${state.progress}%`}
              </div>
              {state.progress !== null && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-sidebar-primary transition-[width]"
                    style={{ width: `${state.progress}%` }}
                  />
                </div>
              )}
              {state.notes && (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-card/60 p-2 text-xs text-muted-foreground">
                  {state.notes}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </TooltipTrigger>
      <TooltipContent side="top">
        正在下载更新{state.progress === null ? '' : ` · ${state.progress}%`}
      </TooltipContent>
    </Tooltip>
  );
}

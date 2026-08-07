'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Pause, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
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
import { getDesktopUpdateBridge, type DesktopUpdateBridge, type DesktopUpdateState } from '../lib/desktopUpdate';

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

type ConfirmationMode = 'download' | 'install' | null;

function refreshBridgeState(bridge: DesktopUpdateBridge, setState: (state: DesktopUpdateState) => void) {
  void bridge.getState().then(setState).catch(() => {});
}

export default function AppUpdateButton() {
  const [state, setState] = useState<DesktopUpdateState>(INITIAL_STATE);
  const [hasBridge, setHasBridge] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmationMode, setConfirmationMode] = useState<ConfirmationMode>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const flows = useFlowStore((s) => s.flows);
  const runningFlowCount = flows.filter((flow) => flow.has_active_agent_run === true).length;
  const autoInstallVersion = useRef<string | null>(null);

  useEffect(() => {
    const bridge = getDesktopUpdateBridge();
    if (!bridge) return undefined;
    setHasBridge(true);

    let active = true;
    const unsubscribe = bridge.onState((nextState) => {
      if (active) setState(nextState);
    });
    refreshBridgeState(bridge, (nextState) => {
      if (active) setState(nextState);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || state.automaticUpdates || !state.availableVersion) return;
    if (autoInstallVersion.current === state.availableVersion) return;
    autoInstallVersion.current = state.availableVersion;
    if (runningFlowCount > 0) {
      setConfirmationMode('install');
      setConfirmOpen(true);
      return;
    }
    const bridge = getDesktopUpdateBridge();
    if (bridge) {
      setInstalling(true);
      void bridge.install().then((accepted) => {
        if (!accepted) setInstalling(false);
      }).catch(() => setInstalling(false));
    }
  }, [runningFlowCount, state.availableVersion, state.automaticUpdates, state.status]);

  if (!hasBridge) return null;

  const bridge = getDesktopUpdateBridge();
  if (!bridge) return null;

  const openConfirmation = (mode: ConfirmationMode) => {
    setConfirmationMode(mode);
    setConfirmOpen(true);
  };

  const install = () => {
    setInstalling(true);
    void bridge.install().then((accepted) => {
      if (!accepted) setInstalling(false);
    }).catch(() => setInstalling(false));
  };

  const startDownload = () => {
    setPopoverOpen(false);
    void bridge.download().then(() => refreshBridgeState(bridge, setState)).catch(() => {});
  };

  const pauseDownload = () => {
    void bridge.pause().then(() => refreshBridgeState(bridge, setState)).catch(() => {});
  };

  const resumeDownload = () => {
    void bridge.resume().then(() => refreshBridgeState(bridge, setState)).catch(() => {});
  };

  const cancelDownload = () => {
    setPopoverOpen(false);
    void bridge.cancel().then(() => refreshBridgeState(bridge, setState)).catch(() => {});
  };

  const downloadAction = state.automaticUpdates ? (
    <AlertDialogAction onClick={startDownload}>开始下载</AlertDialogAction>
  ) : (
    <AlertDialogAction onClick={startDownload}>开始下载</AlertDialogAction>
  );

  const installDescription = runningFlowCount > 0
    ? `当前有 ${runningFlowCount} 个正在执行的 Flow，重启会中断它们。`
    : 'SquadFlow 将安装更新并重新打开。';

  const confirmDialog = (
    <AlertDialog open={confirmOpen} onOpenChange={(open) => {
      setConfirmOpen(open);
      if (!open) setConfirmationMode(null);
    }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmationMode === 'download' ? '下载更新' : '重启并更新'}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmationMode === 'download'
              ? `将下载 SquadFlow ${state.availableVersion ?? '新版本'}。下载完成后会自动重启。`
              : installDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          {confirmationMode === 'download' ? downloadAction : (
            <AlertDialogAction variant={runningFlowCount > 0 ? 'destructive' : 'default'} onClick={install}>
              {runningFlowCount > 0 ? '中断并重启' : '重启'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (state.status === 'available') {
    const trigger = (
      <button
        type="button"
        aria-label={`下载 SquadFlow 更新${state.availableVersion ? ` 到 ${state.availableVersion}` : ''}`}
        onClick={() => state.automaticUpdates ? startDownload() : openConfirmation('download')}
        className="flex h-9 min-w-14 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-sidebar-accent px-2.5 text-xs font-semibold text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <Download className="size-3.5" />
        <span>下载</span>
      </button>
    );
    return <><Tooltip><TooltipTrigger render={trigger} /><TooltipContent side="top">有新版本，点击下载</TooltipContent></Tooltip>{confirmDialog}</>;
  }

  if (state.status === 'ready') {
    return <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              aria-label={`重启并更新 SquadFlow${state.availableVersion ? ` 到 ${state.availableVersion}` : ''}`}
              disabled={installing}
              onClick={() => openConfirmation('install')}
              className="flex h-9 min-w-14 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-sidebar-accent px-2.5 text-xs font-semibold text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-wait disabled:opacity-70"
            />
          )}
        >
          <RefreshCw className={`size-3.5 ${installing ? 'animate-spin' : ''}`} />
          <span>重启</span>
        </TooltipTrigger>
        <TooltipContent side="top">重启并更新</TooltipContent>
      </Tooltip>
      {confirmDialog}
    </>;
  }

  if (state.status === 'error') {
    return <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            aria-label="下载失败，重新下载"
            onClick={resumeDownload}
            className="flex h-9 min-w-14 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          />
        )}
      >
        <RotateCcw className="size-3.5" />
        <span>重试</span>
      </TooltipTrigger>
      <TooltipContent side="top">下载失败，点击重新下载</TooltipContent>
    </Tooltip>;
  }

  if (state.status !== 'downloading' && state.status !== 'paused') return null;

  const paused = state.status === 'paused';
  const tooltipText = paused
    ? `已暂停${state.progress === null ? '' : ` · ${state.progress}%`} · 点击继续`
    : `正在下载更新${state.progress === null ? '' : ` · ${state.progress}%`} · 点击管理`;
  return <>
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger
            aria-label={paused
              ? `已暂停 SquadFlow 更新${state.progress === null ? '' : `，${state.progress}%`}`
              : `正在下载 SquadFlow 更新${state.progress === null ? '' : `，${state.progress}%`}`}
            className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/60 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-sidebar-primary/20 transition-[height]" style={{ height: `${state.progress ?? 0}%` }} />
            {paused ? <Play className="relative z-10 size-3.5" /> : <Download className="relative z-10 size-3.5" />}
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-72 p-4">
            <div className="space-y-3 text-sm">
              <div className="font-medium text-foreground">应用更新</div>
              <div className="text-xs text-muted-foreground">当前版本 {state.currentVersion || '未知'}</div>
              <div className="text-xs text-muted-foreground" role="status">
                {paused ? '已暂停' : '正在下载'} {state.availableVersion ?? '新版本'}{state.progress === null ? '' : ` · ${state.progress}%`}
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-sidebar-primary transition-[width]" style={{ width: `${state.progress ?? 0}%` }} /></div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={cancelDownload} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><X className="size-3" />中止</button>
                <button type="button" onClick={paused ? resumeDownload : pauseDownload} className="inline-flex items-center gap-1 rounded-md bg-sidebar-accent px-2 py-1 text-xs text-sidebar-accent-foreground hover:bg-sidebar-accent/80">{paused ? <Play className="size-3" /> : <Pause className="size-3" />}{paused ? '继续' : '暂停'}</button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  </>;
}

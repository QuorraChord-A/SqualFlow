'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  status: 'idle',
  currentVersion: '',
  availableVersion: null,
  notes: null,
  progress: null,
  error: null,
};

function statusLine(state: DesktopUpdateState): string {
  if (!state.enabled) return '当前构建未启用自动更新。';
  switch (state.status) {
    case 'checking':
      return '正在检查更新...';
    case 'downloading':
      return `正在下载 ${state.availableVersion ?? '新版本'}${state.progress === null ? '' : `，${state.progress}%`}`;
    case 'ready':
      return `已下载 ${state.availableVersion ?? '新版本'}，等待重启安装。`;
    case 'error':
      return `更新失败：${state.error ?? '未知错误'}`;
    default:
      return '已是最新版本。';
  }
}

export default function AppUpdateButton() {
  const [state, setState] = useState<DesktopUpdateState>(INITIAL_STATE);
  const [hasBridge, setHasBridge] = useState(false);
  const [installing, setInstalling] = useState(false);
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

  if (state.status === 'ready') {
    const versionLabel = state.availableVersion ? ` 到 ${state.availableVersion}` : '';
    return (
      <>
        <button
          type="button"
          aria-label={`重启并更新 SquadFlow${versionLabel}`}
          title={`重启并安装 SquadFlow${versionLabel}`}
          disabled={installing}
          onClick={() => {
            if (runningFlowCount > 0) {
              setConfirmOpen(true);
            } else {
              install();
            }
          }}
          className="flex h-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400 px-3 text-xs font-extrabold text-emerald-950 shadow-lg shadow-emerald-500/20 transition-colors hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar disabled:cursor-wait disabled:opacity-70"
        >
          {installing ? '重启中' : '更新'}
        </button>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重启并更新</AlertDialogTitle>
              <AlertDialogDescription>
                当前有 <span className="font-medium text-foreground">{runningFlowCount}</span> 个正在运行的 Flow，重启会中断它们。确定现在重启并安装更新吗？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={install}>
                中断并重启
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  const downloading = state.status === 'downloading';
  return (
    <Popover>
      <PopoverTrigger
        aria-label={downloading
          ? `正在下载 SquadFlow 更新${state.progress === null ? '' : `，${state.progress}%`}`
          : '应用更新'}
        title="应用更新"
        className={downloading
          ? 'flex h-9 min-w-14 shrink-0 items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 px-2.5 text-xs font-bold tabular-nums text-emerald-400 transition-colors hover:bg-emerald-400/25'
          : 'flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card/60 text-muted-foreground transition-colors hover:bg-card hover:text-foreground'}
      >
        {downloading
          ? (state.progress === null ? '下载中' : `${state.progress}%`)
          : <RefreshCw className={`size-4${state.status === 'checking' ? ' animate-spin' : ''}`} />}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-4">
        <div className="space-y-3 text-sm">
          <div className="font-medium text-foreground">应用更新</div>
          <div className="text-xs text-muted-foreground">
            当前版本 {state.currentVersion || '未知'}
          </div>
          <div className="text-xs text-muted-foreground" role="status">
            {statusLine(state)}
          </div>
          {downloading && state.progress !== null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-400 transition-[width]"
                style={{ width: `${state.progress}%` }}
              />
            </div>
          )}
          {state.notes && (
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-card/60 p-2 text-xs text-muted-foreground">
              {state.notes}
            </div>
          )}
          {state.enabled && !downloading && state.status !== 'checking' && (
            <button
              type="button"
              onClick={() => {
                void getDesktopUpdateBridge()?.check().catch(() => {});
              }}
              className="w-full rounded-lg border border-border/70 bg-card/60 px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-card"
            >
              检查更新
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

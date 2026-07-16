"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CirclePlus, Globe2, LoaderCircle, RotateCw, ScanLine } from "lucide-react";
import {
  getDesktopBrowserBridge,
  type DesktopBrowserBridge,
  type DesktopBrowserState,
} from "../../lib/desktopBrowser";
import { useBrowserSelectionStore } from "../../stores/useBrowserSelectionStore";

const fallbackState: DesktopBrowserState = {
  url: "about:blank",
  title: "浏览器",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  pickerActive: false,
  agentLease: null,
};

function applyBrowserLayout(
  bridge: DesktopBrowserBridge,
  payload: { visible: boolean; bounds?: { x: number; y: number; width: number; height: number } },
) {
  if (bridge.setLayout) return bridge.setLayout(payload);
  if (!payload.visible || !payload.bounds) return bridge.setVisible(false);
  return bridge.setBounds(payload.bounds).then(() => bridge.setVisible(true));
}

function BrowserIconButton({
  label,
  disabled,
  active = false,
  wide = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  wide?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        wide ? "w-auto gap-1.5 px-2.5" : "size-8"
      } ${
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-ui-control-hover hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export default function DesktopBrowserPanel({ flowId = null, visible = true }: { flowId?: string | null; visible?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<DesktopBrowserBridge | null>(null);
  const [browserState, setBrowserState] = useState<DesktopBrowserState>(fallbackState);
  const [address, setAddress] = useState(fallbackState.url);
  const [addressFocused, setAddressFocused] = useState(false);
  const [previewOverlayOpen, setPreviewOverlayOpen] = useState(false);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  const selectedElementCount = useBrowserSelectionStore((state) => state.elements.length);

  useEffect(() => {
    setBridge(getDesktopBrowserBridge());
  }, []);

  useEffect(() => {
    if (addressFocused) return;
    setAddress(browserState.url);
  }, [addressFocused, browserState.url]);

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    bridge.getState().then((state) => {
      if (!cancelled && state) setBrowserState(state);
    }).catch(() => {});
    const unsubscribe = bridge.onState(setBrowserState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    const handlePreviewEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      setPreviewOverlayOpen(Boolean(detail?.open));
    };
    window.addEventListener("squadflow:browser-preview", handlePreviewEvent);
    return () => window.removeEventListener("squadflow:browser-preview", handlePreviewEvent);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    let animationFrame = 0;
    let trackingFrame = 0;
    let lastLayoutKey = "";
    const applyLayout = () => {
      if (!visible || previewOverlayOpen || !hostRef.current) {
        if (lastLayoutKey !== "hidden") {
          lastLayoutKey = "hidden";
          applyBrowserLayout(bridge, { visible: false }).catch(() => {});
        }
        return;
      }
      const rect = hostRef.current.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (bounds.width <= 1 || bounds.height <= 1) {
        if (lastLayoutKey !== "hidden") {
          lastLayoutKey = "hidden";
          applyBrowserLayout(bridge, { visible: false }).catch(() => {});
        }
        return;
      }
      const layoutKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (layoutKey === lastLayoutKey) return;
      lastLayoutKey = layoutKey;
      applyBrowserLayout(bridge, { visible: true, bounds }).catch(() => {});
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(applyLayout);
    };
    const trackDuringPanelAnimation = () => {
      const startedAt = performance.now();
      window.cancelAnimationFrame(trackingFrame);
      const tick = () => {
        applyLayout();
        // Matches the drawer's 400ms CSS transition/animation (see
        // sf-right-panel-drawer-enter/-exit in globals.css and
        // FlowSidePanel's panel/content transitions) plus slack for the
        // native view's async setBounds IPC round-trips to settle after the
        // CSS animation's last frame, so the embedded browser view doesn't
        // visibly lag behind the surrounding chrome while closing/opening.
        if (performance.now() - startedAt < 650) {
          trackingFrame = window.requestAnimationFrame(tick);
        }
      };
      trackingFrame = window.requestAnimationFrame(tick);
    };

    scheduleUpdate();
    trackDuringPanelAnimation();
    const hostElement = hostRef.current;
    const resizeObserver = new ResizeObserver(() => {
      scheduleUpdate();
      trackDuringPanelAnimation();
    });
    if (hostElement) resizeObserver.observe(hostElement);
    window.addEventListener("resize", scheduleUpdate);
    hostElement?.addEventListener("transitionstart", trackDuringPanelAnimation);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(trackingFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      hostElement?.removeEventListener("transitionstart", trackDuringPanelAnimation);
      applyBrowserLayout(bridge, { visible: false }).catch(() => {});
    };
  }, [bridge, previewOverlayOpen, visible]);

  const updateFromCommand = useCallback(async (command: () => Promise<DesktopBrowserState | null>) => {
    const state = await command().catch(() => null);
    if (state) setBrowserState(state);
  }, []);

  useEffect(() => {
    if (!bridge || !browserState.pickerActive) return;
    void updateFromCommand(() => bridge.startElementPicker(selectedElementCount + 1));
  }, [bridge, browserState.pickerActive, selectedElementCount, updateFromCommand]);

  const handleNavigate = (event: FormEvent) => {
    event.preventDefault();
    if (!bridge) return;
    void updateFromCommand(() => bridge.navigate(address));
  };

  const captureBrowserScreenshot = useCallback(async () => {
    if (!bridge?.captureScreenshot) return;
    const result = await bridge.captureScreenshot().catch(() => null);
    if (!result) return;
    setScreenshotCopied(true);
    window.setTimeout(() => setScreenshotCopied(false), 1400);
  }, [bridge]);

  const handleReclaimLease = useCallback(async () => {
    if (!bridge?.reclaimLease) return;
    const state = await bridge.reclaimLease().catch(() => null);
    if (state) setBrowserState(state);
  }, [bridge]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" data-testid="desktop-browser-panel">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-3">
        <BrowserIconButton
          label="后退"
          disabled={!bridge || !browserState.canGoBack}
          onClick={() => bridge && void updateFromCommand(bridge.goBack)}
        >
          <ArrowLeft className="size-4" />
        </BrowserIconButton>
        <BrowserIconButton
          label="前进"
          disabled={!bridge || !browserState.canGoForward}
          onClick={() => bridge && void updateFromCommand(bridge.goForward)}
        >
          <ArrowRight className="size-4" />
        </BrowserIconButton>
        <BrowserIconButton
          label="刷新"
          disabled={!bridge}
          onClick={() => bridge && void updateFromCommand(bridge.reload)}
        >
          {browserState.isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
        </BrowserIconButton>

        <form onSubmit={handleNavigate} className="min-w-0 flex-1">
          <label className="relative block">
            <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
              disabled={!bridge}
              aria-label="浏览器地址"
              placeholder={bridge ? "输入网址或搜索内容" : "桌面端浏览器可用"}
              className="h-8 w-full rounded-md border border-ui-border-subtle bg-ui-control pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60 disabled:cursor-not-allowed disabled:opacity-65"
            />
          </label>
        </form>

        <BrowserIconButton
          label={screenshotCopied ? "浏览器截图已复制" : "截图当前浏览器"}
          disabled={!bridge?.captureScreenshot || browserState.url === "about:blank"}
          active={screenshotCopied}
          onClick={captureBrowserScreenshot}
        >
          <ScanLine className="size-4" />
        </BrowserIconButton>

        <BrowserIconButton
          label={browserState.pickerActive ? "取消标注" : "进入标注模式"}
          active={browserState.pickerActive}
          wide={browserState.pickerActive}
          disabled={!bridge || browserState.url === "about:blank"}
          onClick={() => bridge && void updateFromCommand(
            browserState.pickerActive
              ? bridge.stopElementPicker
              : () => bridge.startElementPicker(selectedElementCount + 1),
          )}
        >
          <CirclePlus className="size-5" />
          {browserState.pickerActive ? <span className="text-xs font-semibold">取消标注</span> : null}
        </BrowserIconButton>
      </div>

      {browserState.agentLease?.flowId === flowId ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
          data-testid="desktop-browser-lease-banner"
        >
          <span>{browserState.agentLease.holderName} 正在操作浏览器</span>
          <button
            type="button"
            onClick={() => void handleReclaimLease()}
            className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 font-semibold text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
          >
            夺回控制
          </button>
        </div>
      ) : null}

      <div
        ref={hostRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-ui-sunken"
        data-testid="desktop-browser-host"
        onMouseLeave={() => {
          if (bridge && browserState.pickerActive) void bridge.clearElementPickerHover();
        }}
      >
        {!bridge ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
            <Globe2 className="size-12 opacity-45" />
            <div className="text-sm font-semibold text-foreground">桌面浏览器</div>
            <div className="max-w-[320px] text-sm leading-6">
              这个功能在 Electron 桌面端启用；普通网页开发环境只显示占位。
            </div>
          </div>
        ) : browserState.url === "about:blank" ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center text-muted-foreground">
            <Globe2 className="mb-7 size-12 stroke-[1.8] opacity-75" />
            <h2 className="text-[28px] font-semibold tracking-normal text-foreground">开始浏览</h2>
            <p className="mt-4 text-[19px] leading-7 text-muted-foreground">输入 URL 以打开页面</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

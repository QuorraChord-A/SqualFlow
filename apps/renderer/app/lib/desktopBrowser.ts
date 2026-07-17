"use client";

export type DesktopBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopBrowserAgentLease = {
  flowId: string;
  agentSessionId: string;
  holderName: string;
  since: string;
};

export type DesktopBrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  pickerActive: boolean;
  agentLease?: DesktopBrowserAgentLease | null;
};

export type DesktopBrowserSelectedElement = {
  tagName: string;
  text: string;
  selector: string;
  role: string;
  ariaLabel: string;
  title: string;
  url: string;
  pageTitle: string;
  markerNumber: number;
  comment?: string;
  screenshotDataUrl?: string;
  viewport: {
    width: number;
    height: number;
  };
  rect: DesktopBrowserBounds;
  attributes: {
    id: string;
    className: string;
    href: string;
    name: string;
    type: string;
  };
};

export type DesktopBrowserBridge = {
  isAvailable: true;
  setLayout?: (payload: { visible: boolean; bounds?: DesktopBrowserBounds }) => Promise<DesktopBrowserState | null>;
  setVisible: (visible: boolean) => Promise<DesktopBrowserState | null>;
  setBounds: (bounds: DesktopBrowserBounds) => Promise<DesktopBrowserState | null>;
  navigate: (url: string) => Promise<DesktopBrowserState | null>;
  goBack: () => Promise<DesktopBrowserState | null>;
  goForward: () => Promise<DesktopBrowserState | null>;
  reload: () => Promise<DesktopBrowserState | null>;
  captureScreenshot?: () => Promise<{ dataUrl: string; size: { width: number; height: number } } | null>;
  startElementPicker: (markerNumber?: number) => Promise<DesktopBrowserState | null>;
  stopElementPicker: () => Promise<DesktopBrowserState | null>;
  reset?: () => Promise<DesktopBrowserState | null>;
  setConfirmedMarkers?: (markers: Array<Pick<DesktopBrowserSelectedElement, "markerNumber" | "selector" | "rect">>) => Promise<DesktopBrowserState | null>;
  clearElementPickerHover: () => Promise<DesktopBrowserState | null>;
  getState: () => Promise<DesktopBrowserState | null>;
  reclaimLease?: () => Promise<DesktopBrowserState | null>;
  onState: (listener: (state: DesktopBrowserState) => void) => () => void;
  onElementSelected: (listener: (element: DesktopBrowserSelectedElement) => void) => () => void;
};

declare global {
  interface Window {
    squadflowDesktopBrowser?: DesktopBrowserBridge;
    squadflowDesktopShell?: {
      setTheme?: (theme: string, resolvedTheme?: string) => Promise<{ backgroundColor: string; themeSource?: string } | null>;
      toggleWindowZoom?: () => Promise<{ maximized: boolean } | null>;
      showItemInFolder?: (targetPath: string, isDirectory: boolean) => Promise<unknown>;
    };
  }
}

export function getDesktopBrowserBridge(): DesktopBrowserBridge | null {
  if (typeof window === "undefined") return null;
  return window.squadflowDesktopBrowser ?? null;
}

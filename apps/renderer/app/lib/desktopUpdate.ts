export type DesktopUpdateStatus = "idle" | "checking" | "available" | "downloading" | "paused" | "ready" | "error";

export interface DesktopUpdateState {
  enabled: boolean;
  automaticUpdates: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  notes: string | null;
  progress: number | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface DesktopUpdateBridge {
  getState: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
  setAutomaticUpdates: (enabled: boolean) => Promise<DesktopUpdateState>;
  install: () => Promise<boolean>;
  onState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

declare global {
  interface Window {
    squadflowDesktopUpdate?: DesktopUpdateBridge;
  }
}

export function getDesktopUpdateBridge(): DesktopUpdateBridge | null {
  if (typeof window === "undefined") return null;
  return window.squadflowDesktopUpdate ?? null;
}

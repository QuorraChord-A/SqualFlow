import { create } from "zustand";

const STORAGE_KEY = "squadflow-show-reasoning";
const DEFAULT_SHOW_REASONING = true;

interface AppPreferencesState {
  showReasoning: boolean;
  setShowReasoning: (showReasoning: boolean) => void;
}

function applyShowReasoning(showReasoning: boolean) {
  localStorage.setItem(STORAGE_KEY, String(showReasoning));
}

export const useAppPreferencesStore = create<AppPreferencesState>((set) => ({
  showReasoning: DEFAULT_SHOW_REASONING,
  setShowReasoning: (showReasoning: boolean) => {
    applyShowReasoning(showReasoning);
    set({ showReasoning });
  },
}));

export function initAppPreferences() {
  const stored = localStorage.getItem(STORAGE_KEY);
  const showReasoning = stored === null ? DEFAULT_SHOW_REASONING : stored !== "false";
  applyShowReasoning(showReasoning);
  useAppPreferencesStore.setState({ showReasoning });
}

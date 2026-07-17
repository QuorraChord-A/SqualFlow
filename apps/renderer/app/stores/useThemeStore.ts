import { create } from 'zustand';

export type ResolvedThemeName = 'dark' | 'light';
export type ThemeName = 'system' | ResolvedThemeName;

const AVAILABLE_THEMES: ThemeName[] = ['system', 'dark', 'light'];
const STORAGE_KEY = 'squadflow-theme';
const DEFAULT_THEME: ThemeName = 'system';
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

interface ThemeState {
  theme: ThemeName;
  resolvedTheme: ResolvedThemeName;
  setTheme: (theme: ThemeName) => void;
  availableThemes: ThemeName[];
}

let systemThemeMedia: MediaQueryList | null = null;
let systemThemeListenerAttached = false;

function getSystemTheme(): ResolvedThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return (systemThemeMedia ?? window.matchMedia(SYSTEM_THEME_QUERY)).matches ? 'dark' : 'light';
}

export function resolveTheme(theme: ThemeName): ResolvedThemeName {
  return theme === 'system' ? getSystemTheme() : theme;
}

function applyTheme(theme: ThemeName, persist = true): ResolvedThemeName {
  const resolvedTheme = resolveTheme(theme);

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
    document.documentElement.classList.toggle('dark', resolvedTheme !== 'light');
  }

  if (persist && typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Keep the in-memory preference when browser storage is unavailable.
    }
  }

  return resolvedTheme;
}

function ensureSystemThemeListener() {
  if (
    systemThemeListenerAttached
    || typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
  ) return;

  systemThemeMedia = window.matchMedia(SYSTEM_THEME_QUERY);
  const handleChange = () => {
    if (useThemeStore.getState().theme !== 'system') return;
    const resolvedTheme = applyTheme('system', false);
    useThemeStore.setState({ resolvedTheme });
  };

  if (typeof systemThemeMedia.addEventListener === 'function') {
    systemThemeMedia.addEventListener('change', handleChange);
  } else {
    systemThemeMedia.addListener(handleChange);
  }
  systemThemeListenerAttached = true;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: DEFAULT_THEME,
  resolvedTheme: 'dark',
  availableThemes: AVAILABLE_THEMES,
  setTheme: (theme) => {
    ensureSystemThemeListener();
    const resolvedTheme = applyTheme(theme);
    set({ theme, resolvedTheme });
  },
}));

export function initTheme() {
  ensureSystemThemeListener();

  let stored: ThemeName | null = null;
  if (typeof window !== 'undefined') {
    try {
      stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    } catch {
      stored = null;
    }
  }

  const theme = stored && AVAILABLE_THEMES.includes(stored) ? stored : DEFAULT_THEME;
  const resolvedTheme = applyTheme(theme);
  useThemeStore.setState({ theme, resolvedTheme });
}

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTheme, useThemeStore } from './useThemeStore';

let systemPrefersDark = false;
const systemListeners = new Set<() => void>();

const mediaQuery = {
  get matches() {
    return systemPrefersDark;
  },
  media: '(prefers-color-scheme: dark)',
  onchange: null,
  addEventListener: (_type: string, listener: () => void) => systemListeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => systemListeners.delete(listener),
  addListener: (listener: () => void) => systemListeners.add(listener),
  removeListener: (listener: () => void) => systemListeners.delete(listener),
  dispatchEvent: () => true,
} as unknown as MediaQueryList;

function emitSystemThemeChange(prefersDark: boolean) {
  systemPrefersDark = prefersDark;
  for (const listener of systemListeners) listener();
}

describe('useThemeStore', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => mediaQuery),
    });
  });

  beforeEach(() => {
    localStorage.clear();
    systemPrefersDark = false;
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;
    useThemeStore.setState({ theme: 'system', resolvedTheme: 'dark' });
  });

  it('exposes themes in the product-defined order', () => {
    expect(useThemeStore.getState().availableThemes).toEqual([
      'system',
      'dark',
      'light',
    ]);
  });

  it('defaults to the system preference and resolves light mode', () => {
    initTheme();

    expect(useThemeStore.getState()).toEqual(expect.objectContaining({
      theme: 'system',
      resolvedTheme: 'light',
    }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePreference).toBe('system');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('updates automatically when the OS theme changes', () => {
    initTheme();
    emitSystemThemeChange(true);

    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('keeps an explicit theme when the OS theme changes', () => {
    useThemeStore.getState().setTheme('dark');
    emitSystemThemeChange(false);

    expect(useThemeStore.getState()).toEqual(expect.objectContaining({
      theme: 'dark',
      resolvedTheme: 'dark',
    }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('squadflow-theme')).toBe('dark');
  });

  it('returns from an explicit light theme to the current system theme', () => {
    systemPrefersDark = true;
    useThemeStore.getState().setTheme('light');

    useThemeStore.getState().setTheme('system');

    expect(useThemeStore.getState()).toEqual(expect.objectContaining({
      theme: 'system',
      resolvedTheme: 'dark',
    }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('system');
    expect(localStorage.getItem('squadflow-theme')).toBe('system');
  });

  it('falls back to the system theme when the removed aurora preference is stored', () => {
    localStorage.setItem('squadflow-theme', 'dark-emerald');

    initTheme();

    expect(useThemeStore.getState()).toEqual(expect.objectContaining({
      theme: 'system',
      resolvedTheme: 'light',
    }));
    expect(localStorage.getItem('squadflow-theme')).toBe('system');
  });
});

'use client';

import { useThemeStore, type ThemeName } from '../stores/useThemeStore';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEME_LABELS: Record<ThemeName, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
  'dark-emerald': '极光',
};

export default function ThemeSwitcher() {
  const { theme, setTheme, availableThemes } = useThemeStore();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a4 4 0 014-4h16" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3a4 4 0 00-4 4v12a4 4 0 014 4h8" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 3a4 4 0 01-4 4" />
        </svg>
        <span>{THEME_LABELS[theme]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-40">
        {availableThemes.map((themeName) => (
          <DropdownMenuItem
            key={themeName}
            onClick={() => setTheme(themeName)}
            className={themeName === theme ? 'bg-accent text-foreground' : ''}
          >
            {THEME_LABELS[themeName]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

'use client';

import { Check, Eye, Monitor, Moon, Palette, Settings, SlidersHorizontal, Sun, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import { useThemeStore, type ThemeName } from '../stores/useThemeStore';
import { useAppPreferencesStore } from '../stores/useAppPreferencesStore';
import { useModalStore } from '../stores/useModalStore';
import {
  DropdownMenuCheckboxItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const THEME_LABELS: Record<ThemeName, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色',
};

const THEME_ICONS: Record<ThemeName, ComponentType<{ className?: string }>> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

interface AppSettingsMenuProps {
  onOpenSettings?: () => void;
}

export default function AppSettingsMenu({ onOpenSettings }: AppSettingsMenuProps) {
  const { theme, setTheme, availableThemes } = useThemeStore();
  const { showReasoning, setShowReasoning } = useAppPreferencesStore();
  const openClearAllModal = useModalStore((state) => state.openClearAllModal);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={(
            <DropdownMenuTrigger
              aria-label="设置"
              className="flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card/60 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            />
          )}
        >
          <Settings className="size-4" />
        </TooltipTrigger>
        <TooltipContent side="top">设置</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="bottom" className="w-56 p-2">
        <div className="flex items-center gap-2 px-2 py-2 text-sm font-medium text-foreground">
          <Settings className="size-4 text-muted-foreground" />
          设置
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onOpenSettings}
          className="px-2 py-2"
          disabled={!onOpenSettings}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" />
          <span>打开设置</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showReasoning}
          onCheckedChange={(checked) => setShowReasoning(checked === true)}
          className="px-2 py-2"
        >
          <Eye className="size-4 text-muted-foreground" />
          <span>展示思考过程</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="px-2 py-2">
            <Palette className="size-4 text-muted-foreground" />
            主题
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44 p-1">
            {availableThemes.map((themeName) => {
              const Icon = THEME_ICONS[themeName];
              return (
                <DropdownMenuItem key={themeName} onClick={() => setTheme(themeName)} className="px-2 py-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <span>{THEME_LABELS[themeName]}</span>
                  {theme === themeName && <Check className="ml-auto size-4" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={openClearAllModal}
          className="px-2 py-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <Trash2 className="size-4 text-destructive" />
          <span>清除所有 Flow</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

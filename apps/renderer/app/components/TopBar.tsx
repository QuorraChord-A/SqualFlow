'use client';

interface TopBarProps {
  activeTitle?: string;
  activeSubtitle?: string;
  isLeftPanelOpen?: boolean;
}

export default function TopBar({
  activeTitle = 'SquadFlow',
  activeSubtitle,
  isLeftPanelOpen = true,
}: TopBarProps) {
  const handleDoubleClick = () => {
    void window.squadflowDesktopShell?.toggleWindowZoom?.();
  };

  return (
    <header
      className={`flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 py-0 pr-5 backdrop-blur ${isLeftPanelOpen ? 'pl-5' : 'sf-topbar-left-collapsed pl-16'}`}
    >
      <div
        onDoubleClick={handleDoubleClick}
        className="sf-window-drag-region flex min-w-0 flex-1 self-stretch items-center"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{activeTitle}</span>
          {activeSubtitle && <span className="truncate text-xs text-muted-foreground">{activeSubtitle}</span>}
        </div>
      </div>
    </header>
  );
}

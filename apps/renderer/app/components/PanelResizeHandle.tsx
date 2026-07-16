"use client";

interface PanelResizeHandleProps {
  side: "left" | "right";
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export default function PanelResizeHandle({ side, onPointerDown }: PanelResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-label={side === "left" ? "调整左侧面板宽度" : "调整右侧面板宽度"}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={`group absolute inset-y-0 z-30 w-4 cursor-col-resize touch-none ${
        side === "left" ? "-right-2" : "-left-2"
      }`}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  );
}

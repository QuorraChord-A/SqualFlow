"use client";

import { useState, type DragEvent } from "react";
import { CornerUpRight, GripVertical, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunningQueuedMessage } from "../../stores/useRunningMessageQueueStore";

type RunningMessageQueueProps = {
  messages: RunningQueuedMessage[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onEdit: (message: RunningQueuedMessage) => void;
  onDelete: (messageId: string) => void;
  onGuide: (message: RunningQueuedMessage) => void;
  actionLabel?: string;
};

function queuePreviewImages(message: RunningQueuedMessage): Array<{ id: string; dataUrl: string }> {
  const pastedImages = message.imageAttachments
    ?.filter((image) => image.dataUrl)
    .map((image) => ({ id: image.id, dataUrl: image.dataUrl })) ?? [];
  const browserImages = message.browserElementAttachments
    ?.filter((element) => element.screenshotDataUrl)
    .map((element) => ({ id: element.id, dataUrl: element.screenshotDataUrl! })) ?? [];
  return [...pastedImages, ...browserImages];
}

export default function RunningMessageQueue({
  messages,
  onReorder,
  onEdit,
  onDelete,
  onGuide,
  actionLabel = "引导",
}: RunningMessageQueueProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  if (messages.length === 0) return null;

  const handleDrop = (event: DragEvent<HTMLDivElement>, toIndex: number) => {
    event.preventDefault();
    if (draggedIndex === null || draggedIndex === toIndex) {
      setDraggedIndex(null);
      return;
    }
    onReorder(draggedIndex, toIndex);
    setDraggedIndex(null);
  };

  return (
    <div data-testid="running-message-queue" className="relative mx-auto w-[calc(100%-44px)] overflow-hidden rounded-xl border border-ui-border bg-[color-mix(in_srgb,var(--ui-surface-raised)_72%,var(--background))] px-2.5 pb-2 pt-3 shadow-[var(--ui-shadow-inset)] max-[760px]:w-[calc(100%-20px)]">
      <div className="absolute -top-[42px] left-[-18px] rounded-xl border border-ui-border-strong bg-[var(--ui-surface-raised)] px-3 py-1.5 text-sm font-semibold text-foreground shadow-[var(--ui-shadow-elevated)]">
        拖拽排序
      </div>
      <div className="max-h-[218px] space-y-0.5 overflow-y-auto overscroll-contain pr-1">
        {messages.map((message, index) => {
          const isDispatching = message.status === "dispatching";
          const visibleContent = message.displayContent ?? message.content;
          const displayContent = visibleContent || (message.planFeedback?.length ? `对编排计划添加了 ${message.planFeedback.length} 条评论` : "附件消息");
          const previewImages = queuePreviewImages(message);
          const waitsForNextTurn = actionLabel === "引导" && message.specRequested === true;
          const actionAriaLabel = isDispatching
            ? `消息 ${index + 1} 正在发送`
            : waitsForNextTurn
            ? `Spec 消息 ${index + 1} 需等待当前任务结束`
            : actionLabel === "引导"
            ? `引导消息 ${index + 1}`
            : `${actionLabel} 消息 ${index + 1}`;
          return (
            <div
              key={message.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, index)}
              className={cn(
                "group grid min-h-[42px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors",
                draggedIndex === index ? "bg-ui-control-hover opacity-70" : "hover:bg-ui-control-hover/70",
              )}
            >
              <button
                type="button"
                draggable={!isDispatching}
                disabled={isDispatching}
                onDragStart={() => {
                  if (!isDispatching) setDraggedIndex(index);
                }}
                onDragEnd={() => setDraggedIndex(null)}
                aria-label={`拖动消息 ${index + 1}`}
                className="flex size-7 cursor-grab items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-background/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <GripVertical className="size-[16px]" />
              </button>

              <div className="flex min-w-0 items-center text-sm leading-5 text-foreground">
                <span className="mr-3 inline-block w-4 shrink-0 text-center font-medium text-muted-foreground">{index + 1}</span>
                {previewImages.length > 0 ? (
                  <div className="mr-2 flex shrink-0 items-center gap-1">
                    {previewImages.slice(0, 3).map((image) => (
                      <span
                        key={image.id}
                        className="block h-[26px] w-9 overflow-hidden rounded-md border border-ui-border-strong bg-ui-sunken"
                      >
                        <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
                      </span>
                    ))}
                    {previewImages.length > 3 ? (
                      <span className="inline-flex h-[26px] min-w-9 items-center justify-center rounded-md border border-ui-border-strong bg-ui-control px-1 text-[11px] font-semibold text-muted-foreground">
                        +{previewImages.length - 3}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <span className="block min-w-0 flex-1 truncate" title={displayContent}>{displayContent}</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={actionAriaLabel}
                  disabled={waitsForNextTurn || isDispatching}
                  onClick={() => onGuide(message)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ui-control-hover px-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CornerUpRight className="size-[17px]" />
                  {isDispatching ? "发送中" : waitsForNextTurn ? "等待" : actionLabel}
                </button>
                <button
                  type="button"
                  aria-label={`编辑消息 ${index + 1}`}
                  disabled={isDispatching}
                  onClick={() => onEdit(message)}
                  className="flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Pencil className="size-[18px]" />
                </button>
                <button
                  type="button"
                  aria-label={`删除消息 ${index + 1}`}
                  disabled={isDispatching}
                  onClick={() => onDelete(message.id)}
                  className="flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="size-[18px]" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

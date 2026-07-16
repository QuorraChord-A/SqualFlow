"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, MessageSquare, X } from "lucide-react";
import { useBrowserSelectionStore, type BrowserElementAttachment } from "../stores/useBrowserSelectionStore";

function attachmentLabel(element: BrowserElementAttachment) {
  return element.ariaLabel || element.title || element.text || element.selector || element.tagName;
}

function attachmentComment(element: BrowserElementAttachment, index: number) {
  return element.comment?.trim() || `评论${index + 1}`;
}

export default function BrowserElementAttachments() {
  const elements = useBrowserSelectionStore((state) => state.elements);
  const removeElement = useBrowserSelectionStore((state) => state.removeElement);
  const clearElements = useBrowserSelectionStore((state) => state.clearElements);
  const [isOpen, setIsOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preview = useMemo(
    () => elements.find((element) => element.id === previewId) ?? null,
    [elements, previewId],
  );
  const openPopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setIsOpen(true);
  }, []);
  const closePopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
      closeTimerRef.current = null;
    }, 140);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    setCopyState("idle");
  }, [previewId]);

  useEffect(() => {
    if (!preview) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [preview]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    window.dispatchEvent(new CustomEvent("squadflow:browser-preview", { detail: { open: Boolean(preview) } }));
    return () => {
      window.dispatchEvent(new CustomEvent("squadflow:browser-preview", { detail: { open: false } }));
    };
  }, [preview]);

  const copyPreviewImage = useCallback(async () => {
    if (!preview?.screenshotDataUrl) return;
    try {
      const response = await fetch(preview.screenshotDataUrl);
      const blob = await response.blob();
      if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type || "image/png"]: blob }),
        ]);
      } else {
        await navigator.clipboard.writeText(preview.screenshotDataUrl);
      }
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      try {
        await navigator.clipboard.writeText(preview.screenshotDataUrl);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 1400);
      } catch {
        setCopyState("failed");
      }
    }
  }, [preview]);

  if (elements.length === 0) return null;

  return (
    <div
      data-testid="browser-element-attachments"
      className="relative mb-2 flex w-fit max-w-full flex-col items-start gap-2"
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
    >
      <div className="flex max-w-full flex-wrap gap-2">
        {elements.map((element, index) => (
          <div
            key={element.id}
            className="group relative h-[72px] w-[86px] overflow-hidden rounded-xl border border-ui-border-strong bg-ui-sunken shadow-sm"
          >
            <button
              type="button"
              onClick={() => setPreviewId(element.id)}
              className="block h-full w-full"
              aria-label={`放大网页注释 ${index + 1}`}
              title={`${attachmentLabel(element)}\n${attachmentComment(element, index)}`}
            >
              {element.screenshotDataUrl ? (
                <img src={element.screenshotDataUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted-foreground">
                  {index + 1}
                </span>
              )}
            </button>
            <span className="absolute left-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground shadow">
              {index + 1}
            </span>
            <button
              type="button"
              aria-label={`移除网页注释 ${index + 1}`}
              onClick={() => removeElement(element.id)}
              className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition-colors hover:bg-background hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
            {attachmentComment(element, index) ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-background/90 to-transparent px-2 pb-1.5 pt-5 text-left text-[10px] font-medium text-foreground">
                {attachmentComment(element, index)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ui-border-strong bg-ui-control px-2.5 text-xs font-medium text-foreground shadow-sm">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span>{elements.length} 条注释</span>
        <button
          type="button"
          aria-label="清空网页注释"
          onClick={clearElements}
          className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-ui-control-hover hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {isOpen ? (
        <div className="absolute bottom-full left-0 z-40 w-[min(390px,calc(100vw-48px))] pb-2">
          <div className="overflow-hidden rounded-xl border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_94%,var(--background))] p-1.5 shadow-[var(--ui-shadow-dialog)] backdrop-blur-xl">
            <div className="max-h-[280px] overflow-y-auto">
              {elements.map((element, index) => (
                <div
                  key={element.id}
                  className="group grid grid-cols-[44px_minmax(0,1fr)_24px] items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-ui-control-hover/70"
                >
                  <button
                    type="button"
                    onClick={() => setPreviewId(element.id)}
                    className="relative h-8 w-10 overflow-hidden rounded-md border border-ui-border-subtle bg-ui-sunken"
                    aria-label={`放大网页注释 ${index + 1}`}
                    title={`${attachmentLabel(element)}\n${element.selector}`}
                  >
                    {element.screenshotDataUrl ? (
                      <img src={element.screenshotDataUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                        {index + 1}
                      </div>
                    )}
                  </button>
                  <div className="min-w-0">
                    <div className="mb-1 flex min-w-0 items-center gap-1.5">
                      <span className="inline-flex h-5 max-w-[120px] items-center truncate rounded-full border border-ui-border-subtle bg-ui-control px-2 text-[11px] text-muted-foreground">
                        {element.tagName || "element"}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">#{index + 1}</span>
                    </div>
                    <div className="truncate text-sm font-medium text-foreground">
                      {attachmentComment(element, index)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`移除网页注释 ${index + 1}`}
                    onClick={() => removeElement(element.id)}
                    className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-colors hover:bg-ui-control hover:text-foreground group-hover:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {preview && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-8" role="dialog" aria-modal="true">
          <div className="absolute right-6 top-6 flex items-center gap-2">
            <button
              type="button"
              aria-label="复制网页注释截图"
              onClick={copyPreviewImage}
              disabled={!preview.screenshotDataUrl}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-ui-control px-4 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-ui-control-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copyState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制图片"}
            </button>
            <button
              type="button"
              aria-label="关闭网页注释预览"
              onClick={() => setPreviewId(null)}
              className="inline-flex size-10 items-center justify-center rounded-full bg-ui-control text-foreground shadow-lg transition-colors hover:bg-ui-control-hover"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="max-h-full max-w-full overflow-hidden rounded-xl border border-ui-border-strong bg-ui-sunken shadow-[var(--ui-shadow-dialog)]">
            {preview.screenshotDataUrl ? (
              <img
                src={preview.screenshotDataUrl}
                alt={`网页注释 ${preview.markerNumber}`}
                className="block max-h-[calc(100vh-96px)] max-w-[calc(100vw-96px)] object-contain"
              />
            ) : (
              <div className="flex h-[420px] w-[720px] items-center justify-center text-muted-foreground">
                暂无截图
              </div>
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

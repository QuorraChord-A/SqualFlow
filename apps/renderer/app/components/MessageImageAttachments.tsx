"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import type { MessageImageAttachment } from "../types/messageAttachments";
import { useComposerImageStore } from "../stores/useComposerImageStore";

function imageLabel(image: MessageImageAttachment, index: number) {
  return image.name || `图片 ${index + 1}`;
}

export default function MessageImageAttachments() {
  const images = useComposerImageStore((state) => state.images);
  const removeImage = useComposerImageStore((state) => state.removeImage);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const preview = useMemo(() => images.find((image) => image.id === previewId) ?? null, [images, previewId]);

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
    if (!preview?.dataUrl) return;
    try {
      const response = await fetch(preview.dataUrl);
      const blob = await response.blob();
      if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type || preview.mediaType]: blob }),
        ]);
      } else {
        await navigator.clipboard.writeText(preview.dataUrl);
      }
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      try {
        await navigator.clipboard.writeText(preview.dataUrl);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 1400);
      } catch {
        setCopyState("failed");
      }
    }
  }, [preview]);

  if (images.length === 0) return null;

  return (
    <div data-testid="message-image-attachments" className="mb-2 flex max-w-full flex-wrap gap-2">
      {images.map((image, index) => (
        <div
          key={image.id}
          className="group relative h-[78px] w-[104px] overflow-hidden rounded-xl border border-ui-border-strong bg-ui-sunken shadow-sm"
        >
          <button
            type="button"
            onClick={() => setPreviewId(image.id)}
            className="block h-full w-full"
            aria-label={`放大图片 ${index + 1}`}
            title={imageLabel(image, index)}
          >
            <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
          </button>
          <button
            type="button"
            aria-label={`移除图片 ${index + 1}`}
            onClick={() => removeImage(image.id)}
            className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow transition-colors hover:bg-background hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {preview && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/95 p-8" role="dialog" aria-modal="true">
          <div className="absolute right-6 top-6 flex items-center gap-2">
            <button
              type="button"
              aria-label="复制图片"
              onClick={copyPreviewImage}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-ui-control px-4 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-ui-control-hover"
            >
              {copyState === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制图片"}
            </button>
            <button
              type="button"
              aria-label="关闭图片预览"
              onClick={() => setPreviewId(null)}
              className="inline-flex size-10 items-center justify-center rounded-full bg-ui-control text-foreground shadow-lg transition-colors hover:bg-ui-control-hover"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="max-h-full max-w-full overflow-hidden rounded-xl border border-ui-border-strong bg-ui-sunken shadow-[var(--ui-shadow-dialog)]">
            <img
              src={preview.dataUrl}
              alt={preview.name || "图片附件"}
              className="block max-h-[calc(100vh-96px)] max-w-[calc(100vw-96px)] object-contain"
            />
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

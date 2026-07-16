"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import styles from "./transcript.module.css";

type ImagePreviewOverlayProps = {
  src?: string | null;
  alt: string;
  emptyLabel?: string;
  onClose: () => void;
};

type ContextMenuState = {
  x: number;
  y: number;
};

async function copyImage(src: string) {
  const response = await fetch(src);
  const blob = await response.blob();
  if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "image/png"]: blob }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(src);
}

export function ImageThumbnailContent({
  src,
  alt = "",
  fallback = "图片",
}: {
  src?: string | null;
  alt?: string;
  fallback?: string;
}) {
  if (!src) return <span>{fallback}</span>;
  return (
    <>
      <span className={styles.imageThumbBackdrop} aria-hidden="true" />
      <img className={styles.imageThumbForeground} src={src} alt={alt} />
    </>
  );
}

export function ImagePreviewOverlay({ src, alt, emptyLabel = "暂无图片", onClose }: ImagePreviewOverlayProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    setCopyState("idle");
    setMenu(null);
  }, [src]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("squadflow:browser-preview", { detail: { open: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent("squadflow:browser-preview", { detail: { open: false } }));
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!src) return;
    try {
      await copyImage(src);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      try {
        await navigator.clipboard.writeText(src);
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 1400);
      } catch {
        setCopyState("failed");
      }
    }
  }, [src]);

  const handleContextMenu = useCallback((event: MouseEvent) => {
    if (!src) return;
    event.preventDefault();
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 150)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48)),
    });
  }, [src]);

  return (
    <div
      className={styles.browserCommentPreview}
      role="dialog"
      aria-modal="true"
      onClick={() => setMenu(null)}
    >
      <div className={styles.browserCommentPreviewActions}>
        <button
          type="button"
          className={styles.browserCommentPreviewCopy}
          onClick={handleCopy}
          disabled={!src}
          aria-label="复制图片"
        >
          {copyState === "copied" ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制图片"}
        </button>
        <button
          type="button"
          className={styles.browserCommentPreviewClose}
          onClick={onClose}
          aria-label="关闭图片预览"
        >
          ×
        </button>
      </div>
      <div className={styles.browserCommentPreviewImage} onContextMenu={handleContextMenu}>
        {src ? (
          <img src={src} alt={alt} />
        ) : (
          <div>{emptyLabel}</div>
        )}
      </div>
      {menu ? (
        <div
          className={styles.browserCommentPreviewMenu}
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={handleCopy}>
            <CopyIcon className="size-4" />
            {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制图片"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

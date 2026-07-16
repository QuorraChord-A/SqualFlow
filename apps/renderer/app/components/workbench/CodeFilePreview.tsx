"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Globe2 } from "lucide-react";
import { cn } from "@/lib/utils";
import ReadonlyCodeView from "./ReadonlyCodeView";

type CodeFilePreviewProps = {
  className?: string;
  content: string;
  filePath: string;
  language: string;
  onOpenInBrowser?: () => void;
};

export default function CodeFilePreview({
  className,
  content,
  filePath,
  language,
  onOpenInBrowser,
}: CodeFilePreviewProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyCode = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
  };

  return (
    <section
      className={cn(
        "sf-code-file-preview relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--ui-code-surface)]",
        className
      )}
      data-testid="code-file-preview"
    >
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        <button
          aria-label={`复制 ${filePath}`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-ui-border-subtle bg-[color-mix(in_srgb,var(--ui-code-surface)_86%,transparent)] text-muted-foreground shadow-[var(--ui-shadow-inset)] backdrop-blur transition-colors hover:bg-ui-control-hover hover:text-foreground"
          onClick={copyCode}
          type="button"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        {onOpenInBrowser ? (
          <button
            aria-label={`在内置浏览器打开 ${filePath}`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-ui-border-subtle bg-[color-mix(in_srgb,var(--ui-code-surface)_86%,transparent)] text-muted-foreground shadow-[var(--ui-shadow-inset)] backdrop-blur transition-colors hover:bg-ui-control-hover hover:text-foreground"
            onClick={onOpenInBrowser}
            title="在内置浏览器打开"
            type="button"
          >
            <Globe2 className="size-3.5" />
          </button>
        ) : null}
      </div>
      <ReadonlyCodeView className="min-h-0 flex-1" content={content} language={language} />
    </section>
  );
}

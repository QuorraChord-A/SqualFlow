"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileQuestion, LoaderCircle } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements-official/message";
import { API_BASE } from "../../lib/api";
import CodeFilePreview from "./CodeFilePreview";
import { fileExtension, isMarkdownFile, languageFromFilePath } from "./codeLanguage";

type PreviewState = {
  content: string;
  error: string | null;
  loading: boolean;
  unsupported: string | null;
};

type LoadedPreviewState = Omit<PreviewState, "loading">;

const BINARY_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "bmp",
  "class",
  "db",
  "dll",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "png",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "sqlite3",
  "tar",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

export default function WorkspaceFilePreview({
  flowId,
  filePath,
  showPath = true,
  onOpenInBrowser,
}: {
  flowId: string | null;
  filePath: string;
  showPath?: boolean;
  onOpenInBrowser?: () => void;
}) {
  const [state, setState] = useState<PreviewState>({
    content: "",
    error: null,
    loading: true,
    unsupported: null,
  });
  const previewCacheRef = useRef(new Map<string, LoadedPreviewState>());

  useEffect(() => {
    if (!flowId) {
      setState({ content: "", error: "Flow is not available", loading: false, unsupported: null });
      return;
    }

    if (BINARY_EXTENSIONS.has(fileExtension(filePath))) {
      const unsupportedState = {
        content: "",
        error: null,
        unsupported: "当前仅支持预览文本文件",
      };
      setState({ ...unsupportedState, loading: false });
      return;
    }

    const cacheKey = `${flowId}:${filePath}`;
    const cached = previewCacheRef.current.get(cacheKey);
    if (cached) {
      setState({ ...cached, loading: false });
      return;
    }

    const controller = new AbortController();
    setState({ content: "", error: null, loading: true, unsupported: null });
    void fetch(`${API_BASE}/api/flows/${flowId}/file-preview?path=${encodeURIComponent(filePath)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { detail?: string };
          throw new Error(body.detail ?? "File preview failed");
        }
        return response.json() as Promise<{ path: string; content: string }>;
      })
      .then((result) => {
        const loadedState = { content: result.content, error: null, unsupported: null };
        previewCacheRef.current.set(cacheKey, loadedState);
        setState({ ...loadedState, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          content: "",
          error: error instanceof Error ? error.message : "File preview failed",
          loading: false,
          unsupported: null,
        });
      });

    return () => controller.abort();
  }, [filePath, flowId]);

  if (state.loading) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        正在加载文件
      </div>
    );
  }

  if (state.unsupported) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <FileQuestion className="size-6" />
        <span>{state.unsupported}</span>
        <span className="text-xs">{filePath}</span>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-destructive">
        <AlertTriangle className="size-5" />
        <span>{state.error}</span>
      </div>
    );
  }

  const language = languageFromFilePath(filePath);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {showPath ? <div className="shrink-0 truncate px-4 pb-3 pt-4 text-sm text-muted-foreground">{filePath}</div> : null}
      {isMarkdownFile(filePath) ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <MessageResponse className="sf-markdown-document">{state.content}</MessageResponse>
        </div>
      ) : language ? (
        <CodeFilePreview
          className="min-h-0 flex-1"
          content={state.content}
          filePath={filePath}
          language={language}
          onOpenInBrowser={onOpenInBrowser}
        />
      ) : (
        <pre className="sf-plain-text-preview min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-[var(--ui-code-surface)] p-4 font-mono text-sm leading-6 text-foreground">
          {state.content}
        </pre>
      )}
    </div>
  );
}

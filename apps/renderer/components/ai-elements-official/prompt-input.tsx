"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface PromptInputProps {
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  sendDisabled?: boolean;
  allowEmptySend?: boolean;
  placeholder?: string;
  className?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  attachmentSlot?: ReactNode;
  toolbarSlot?: ReactNode;
  actionSlot?: ReactNode;
  onPasteImages?: (files: File[], textOffset: number) => void | Promise<void>;
  stopActive?: boolean;
  onStop?: () => void;
}

function resizePromptTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
}

export function PromptInput({
  onSend,
  disabled = false,
  sendDisabled = false,
  allowEmptySend = false,
  placeholder = "输入消息...",
  className,
  value: controlledValue,
  onValueChange,
  attachmentSlot,
  toolbarSlot,
  actionSlot,
  onPasteImages,
  stopActive = false,
  onStop,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const ignoreNextEnterRef = useRef(false);
  const value = controlledValue ?? internalValue;
  const setValue = (nextValue: string) => {
    onValueChange?.(nextValue);
    if (controlledValue === undefined) setInternalValue(nextValue);
  };

  useEffect(() => {
    resizePromptTextarea(textareaRef.current);
  }, [value]);

  const handleSend = async () => {
    if ((value.trim() || allowEmptySend) && !disabled && !sendDisabled) {
      const shouldClear = await onSend(value.trim());
      if (shouldClear !== false) {
        setValue("");
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent<HTMLTextAreaElement>["nativeEvent"] & {
      keyCode?: number;
    };
    if (isComposingRef.current || nativeEvent.isComposing || e.key === "Process" || nativeEvent.keyCode === 229) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (ignoreNextEnterRef.current) {
        ignoreNextEnterRef.current = false;
        e.preventDefault();
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? [])
      .filter((file) => /^image\/(?:png|jpeg|webp|gif)$/u.test(file.type));
    if (files.length === 0) return;
    event.preventDefault();
    void onPasteImages?.(files, event.currentTarget.selectionStart ?? value.length);
  };

  return (
    <div className={cn("rounded-xl border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_46%,transparent)] px-3.5 pb-1.5 pt-2 shadow-[var(--ui-shadow-inset)] backdrop-blur-xl", className)}>
      {attachmentSlot}
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          ignoreNextEnterRef.current = true;
          window.setTimeout(() => {
            ignoreNextEnterRef.current = false;
          }, 0);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="min-h-[52px] min-w-0 resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-sm leading-6 text-foreground shadow-none outline-none placeholder:text-muted-foreground/55 focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent"
        rows={2}
      />
      <div className="mt-0.5 flex items-center gap-2.5">
        {toolbarSlot}
        <div className="min-w-[24px] flex-1" />
        {actionSlot}
        <Button
          data-prompt-send
          onClick={() => {
            if (stopActive) {
              onStop?.();
              return;
            }
            void handleSend();
          }}
          disabled={stopActive ? disabled : (!value.trim() && !allowEmptySend) || disabled || sendDisabled}
          aria-label={stopActive ? "停止本轮" : "发送消息"}
          title={stopActive ? "停止本轮" : "发送消息"}
          size="icon"
          className={cn(
            "size-8 shrink-0 rounded-xl transition-all hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-35",
            stopActive
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "bg-foreground text-background",
          )}
        >
          {stopActive ? <Square className="size-[15px] fill-current" /> : <ArrowUp className="size-[17px]" />}
        </Button>
      </div>
    </div>
  );
}

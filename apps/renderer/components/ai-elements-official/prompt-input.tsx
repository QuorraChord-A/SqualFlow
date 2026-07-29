"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp, PlugZap, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  inlineEntityFromMenuItem,
  type PromptSlashMenuData,
  type PromptSlashMenuItem,
} from "./prompt-inline-entity";
import {
  PromptRichEditor,
  type ActiveSlash,
  type PromptRichEditorHandle,
} from "./prompt-rich-editor";

export type {
  PromptSlashMenuData,
  PromptSlashMenuItem,
} from "./prompt-inline-entity";

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
  slashMenu?: PromptSlashMenuData;
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
  slashMenu,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState("");
  const [activeSlash, setActiveSlash] = useState<ActiveSlash | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PromptRichEditorHandle>(null);
  const isComposingRef = useRef(false);
  const ignoreNextEnterRef = useRef(false);
  const consumedSlashPositionsRef = useRef(new Set<number>());
  const lastSlashValueRef = useRef(controlledValue ?? "");
  const value = controlledValue ?? internalValue;
  const reconcileConsumedSlashes = (nextValue: string) => {
    const previousValue = lastSlashValueRef.current;
    if (previousValue === nextValue) return;
    let prefixLength = 0;
    while (
      prefixLength < previousValue.length
      && prefixLength < nextValue.length
      && previousValue[prefixLength] === nextValue[prefixLength]
    ) {
      prefixLength += 1;
    }
    let suffixLength = 0;
    while (
      suffixLength < previousValue.length - prefixLength
      && suffixLength < nextValue.length - prefixLength
      && previousValue[previousValue.length - 1 - suffixLength]
        === nextValue[nextValue.length - 1 - suffixLength]
    ) {
      suffixLength += 1;
    }
    const previousSuffixStart = previousValue.length - suffixLength;
    const positionDelta = nextValue.length - previousValue.length;
    const reconciled = new Set<number>();
    for (const position of consumedSlashPositionsRef.current) {
      const nextPosition = position < prefixLength
        ? position
        : position >= previousSuffixStart
          ? position + positionDelta
          : null;
      if (nextPosition !== null && nextValue[nextPosition] === "/") reconciled.add(nextPosition);
    }
    consumedSlashPositionsRef.current = reconciled;
    lastSlashValueRef.current = nextValue;
  };
  const setValue = (nextValue: string) => {
    reconcileConsumedSlashes(nextValue);
    onValueChange?.(nextValue);
    if (controlledValue === undefined) setInternalValue(nextValue);
  };

  useEffect(() => {
    reconcileConsumedSlashes(value);
  }, [value]);

  const filteredSections = useMemo(() => {
    const query = activeSlash?.query.trim().toLocaleLowerCase() ?? "";
    const filter = (items: PromptSlashMenuItem[]) => items.filter((item) => {
      if (!query) return true;
      return item.name.toLocaleLowerCase().includes(query)
        || item.description?.toLocaleLowerCase().includes(query);
    });
    return {
      skills: filter(slashMenu?.skills ?? []),
      mcpServers: filter(slashMenu?.mcpServers ?? []),
    };
  }, [activeSlash?.query, slashMenu]);
  const filteredItems = useMemo(
    () => [...filteredSections.skills, ...filteredSections.mcpServers],
    [filteredSections],
  );
  const slashMenuOpen = Boolean(activeSlash && slashMenu);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [activeSlash?.query, slashMenu]);

  const handleEditorChange = (nextValue: string, candidate: ActiveSlash | null) => {
    reconcileConsumedSlashes(nextValue);
    onValueChange?.(nextValue);
    if (controlledValue === undefined) setInternalValue(nextValue);
    setActiveSlash(
      candidate && !consumedSlashPositionsRef.current.has(candidate.start)
        ? candidate
        : null,
    );
  };

  const dismissActiveSlash = () => {
    if (activeSlash) consumedSlashPositionsRef.current.add(activeSlash.start);
    setActiveSlash(null);
  };

  const selectSlashItem = (item: PromptSlashMenuItem) => {
    if (!activeSlash) return;
    consumedSlashPositionsRef.current.add(activeSlash.start);
    editorRef.current?.replaceSlash(activeSlash, inlineEntityFromMenuItem(item));
    setActiveSlash(null);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  };

  const handleSend = async () => {
    if ((value.trim() || allowEmptySend) && !disabled && !sendDisabled) {
      const shouldClear = await onSend(value.trim());
      if (shouldClear !== false) {
        setValue("");
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent<HTMLDivElement>["nativeEvent"] & {
      keyCode?: number;
    };
    if (isComposingRef.current || nativeEvent.isComposing || e.key === "Process" || nativeEvent.keyCode === 229) {
      return;
    }
    if (slashMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissActiveSlash();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (filteredItems.length > 0) {
          setHighlightedIndex((current) => {
            const delta = e.key === "ArrowDown" ? 1 : -1;
            return (current + delta + filteredItems.length) % filteredItems.length;
          });
        }
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && filteredItems.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        selectSlashItem(filteredItems[Math.min(highlightedIndex, filteredItems.length - 1)]);
        return;
      }
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      editorRef.current?.insertLineBreak();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (ignoreNextEnterRef.current) {
        ignoreNextEnterRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void handleSend();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files ?? [])
      .filter((file) => /^image\/(?:png|jpeg|webp|gif)$/u.test(file.type));
    if (files.length === 0) return;
    event.preventDefault();
    void onPasteImages?.(files, editorRef.current?.getCaretOffset() ?? value.length);
  };

  return (
    <div
      ref={composerRef}
      data-prompt-input
      className={cn("rounded-xl border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_46%,transparent)] px-3.5 pb-1.5 pt-2 shadow-[var(--ui-shadow-inset)] backdrop-blur-xl", className)}
    >
      {attachmentSlot}
      <div className="relative min-h-[52px] min-w-0">
        <PromptRichEditor
          ref={editorRef}
          value={value}
          onChange={handleEditorChange}
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
          onPaste={handlePaste}
          onKeyDownCapture={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          slashMenu={slashMenu}
        />
      </div>
      <Popover
        open={slashMenuOpen}
        onOpenChange={(open) => {
          if (!open) dismissActiveSlash();
        }}
      >
        <PopoverContent
          anchor={() => composerRef.current}
          side="top"
          align="start"
          sideOffset={10}
          initialFocus={false}
          finalFocus={() => composerRef.current?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          data-testid="prompt-slash-menu"
          className="max-h-[min(460px,var(--available-height))] w-[var(--anchor-width)] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-[20px] border border-ui-border-strong bg-[color-mix(in_srgb,var(--ui-surface-raised)_96%,var(--background))] p-0 shadow-[var(--ui-shadow-dialog)] ring-0 backdrop-blur-2xl"
        >
          <div className="min-h-0 overflow-y-auto p-2">
            <SlashSection
              title="技能"
              icon={Sparkles}
              items={filteredSections.skills}
              startIndex={0}
              highlightedIndex={highlightedIndex}
              loading={slashMenu?.loading}
              onHighlight={setHighlightedIndex}
              onSelect={selectSlashItem}
            />
            <div className="mx-1 my-2 h-px bg-ui-border-subtle" />
            <SlashSection
              title="MCP"
              icon={PlugZap}
              items={filteredSections.mcpServers}
              startIndex={filteredSections.skills.length}
              highlightedIndex={highlightedIndex}
              loading={slashMenu?.loading}
              onHighlight={setHighlightedIndex}
              onSelect={selectSlashItem}
            />
            {slashMenu?.error ? (
              <div role="alert" className="px-3 py-2 text-xs text-destructive">{slashMenu.error}</div>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
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
            "shrink-0 transition-all disabled:cursor-not-allowed disabled:opacity-35",
            stopActive
              ? "size-9 rounded-full border border-foreground/10 bg-[color-mix(in_srgb,var(--foreground)_7%,var(--background))] text-foreground/80 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)] hover:-translate-y-px hover:border-foreground/20 hover:bg-[color-mix(in_srgb,var(--foreground)_12%,var(--background))] hover:text-foreground active:translate-y-0 active:scale-[0.94] dark:border-foreground dark:bg-foreground dark:text-background dark:shadow-none dark:hover:border-foreground dark:hover:bg-foreground/90 dark:hover:text-background"
              : "size-8 rounded-xl bg-foreground text-background hover:scale-[1.03]",
          )}
        >
          {stopActive ? (
            <span aria-hidden="true" className="size-3 rounded-[2.5px] bg-current" />
          ) : (
            <ArrowUp className="size-[17px]" />
          )}
        </Button>
      </div>
    </div>
  );
}

function SlashSection({
  title,
  icon: Icon,
  items,
  startIndex,
  highlightedIndex,
  loading,
  onHighlight,
  onSelect,
}: {
  title: string;
  icon: typeof Sparkles;
  items: PromptSlashMenuItem[];
  startIndex: number;
  highlightedIndex: number;
  loading?: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: PromptSlashMenuItem) => void;
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-1 text-[12px] font-semibold text-muted-foreground">
        <Icon className="size-3.5" />
        <span>{title}</span>
        <span className="ml-auto font-normal tabular-nums">{items.length}</span>
      </div>
      {items.map((item, index) => {
        const highlighted = startIndex + index === highlightedIndex;
        const ItemIcon = item.kind === "mcp" ? PlugZap : Sparkles;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={highlighted}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHighlight(startIndex + index)}
            onClick={() => onSelect(item)}
            className={cn(
              "flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
              highlighted && "bg-ui-control-hover",
            )}
          >
            <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 shrink-0 truncate text-[13px] font-medium text-foreground">{item.name}</span>
            {item.description ? (
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{item.description}</span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
              {item.scope === "project" ? "个人" : "全局"}
            </span>
          </button>
        );
      })}
      {!loading && items.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">没有可用项</div>
      ) : null}
      {loading && items.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">正在读取…</div>
      ) : null}
    </section>
  );
}

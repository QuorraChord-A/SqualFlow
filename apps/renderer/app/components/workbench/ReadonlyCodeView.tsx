"use client";

import { useEffect, useMemo, useRef } from "react";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cn } from "@/lib/utils";
import { codeLanguageExtension } from "./codeLanguage";

type ReadonlyCodeViewProps = {
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
  content: string;
  language?: string;
  maxHeight?: number | string;
  startLine?: number;
};

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--ui-code-token-keyword)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: "var(--ui-code-token-name)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--ui-code-token-function)" },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "var(--ui-code-token-constant)" },
  { tag: [tags.definition(tags.name), tags.separator], color: "var(--ui-code-token-definition)" },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: "var(--ui-code-token-type)" },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link], color: "var(--ui-code-token-operator)" },
  { tag: [tags.meta, tags.comment], color: "var(--ui-code-token-comment)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "600", color: "var(--ui-code-token-heading)" },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "var(--ui-code-token-atom)" },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: "var(--ui-code-token-string)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

const codeMirrorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
    fontSize: "13px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.62",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "12px 48px 18px 0",
  },
  ".cm-line": {
    padding: "0 14px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--ui-border-subtle)",
    color: "color-mix(in srgb, var(--foreground) 38%, transparent)",
    marginRight: "10px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 10px 0 0",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--ui-surface-control) 35%, transparent)",
    color: "color-mix(in srgb, var(--foreground) 62%, transparent)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--ring) 30%, transparent)",
  },
  ".cm-focused": {
    outline: "none",
  },
});

const compactCodeMirrorTheme = EditorView.theme({
  "&": {
    fontSize: "12px",
    height: "auto",
  },
  ".cm-scroller": {
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "10px 0",
  },
  ".cm-line": {
    padding: "0 12px",
  },
});

function maxHeightTheme(maxHeight: number | string) {
  const value = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;
  return EditorView.theme({
    "&": { maxHeight: value },
    ".cm-scroller": { maxHeight: value },
  });
}

export default function ReadonlyCodeView({
  ariaLabel,
  className,
  compact = false,
  content,
  language,
  maxHeight,
  startLine = 1,
}: ReadonlyCodeViewProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const firstLine = Number.isFinite(startLine) ? Math.max(1, Math.trunc(startLine)) : 1;

  const extensions = useMemo(() => [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    ...(language ? codeLanguageExtension(language) : []),
    lineNumbers({ formatNumber: (lineNumber) => String(firstLine + lineNumber - 1) }),
    highlightSpecialChars(),
    highlightActiveLineGutter(),
    codeMirrorTheme,
    ...(compact ? [compactCodeMirrorTheme] : []),
    ...(maxHeight === undefined ? [] : [maxHeightTheme(maxHeight)]),
    ...(ariaLabel ? [EditorView.contentAttributes.of({ "aria-label": ariaLabel })] : []),
    syntaxHighlighting(codeHighlightStyle),
  ], [ariaLabel, compact, firstLine, language, maxHeight]);

  useEffect(() => {
    if (!editorRef.current) return;

    const view = new EditorView({
      doc: content,
      extensions,
      parent: editorRef.current,
    });

    return () => view.destroy();
  }, [content, extensions]);

  return (
    <div
      className={cn("min-h-0 min-w-0", className)}
      data-compact={compact ? "true" : undefined}
      data-testid="readonly-code-view"
      ref={editorRef}
      style={{ maxHeight }}
    />
  );
}

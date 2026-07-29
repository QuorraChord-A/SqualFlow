"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { mergeRegister } from "@lexical/utils";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  INSERT_LINE_BREAK_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalNode,
  type NodeKey,
  TextNode,
} from "lexical";
import {
  $createInlineEntityNode,
  $isInlineEntityNode,
  InlineEntityNode,
  promptInlineSegments,
  type InlineEntityDescriptor,
  type PromptSlashMenuData,
} from "./prompt-inline-entity";

export type ActiveSlash = {
  start: number;
  caret: number;
  query: string;
  nodeKey: NodeKey;
  nodeStart: number;
  nodeCaret: number;
};

export type PromptRichEditorHandle = {
  focus: () => void;
  getCaretOffset: () => number;
  insertLineBreak: () => void;
  replaceSlash: (slash: ActiveSlash, descriptor: InlineEntityDescriptor) => void;
};

type PromptRichEditorProps = {
  disabled: boolean;
  onChange: (value: string, slash: ActiveSlash | null) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLDivElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLDivElement>) => void;
  onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder: string;
  slashMenu?: PromptSlashMenuData;
  value: string;
};

function $appendText(parent: ReturnType<typeof $createParagraphNode>, text: string) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) parent.append($createLineBreakNode());
    if (line) parent.append($createTextNode(line));
  });
}

function $replaceEditorValue(value: string, slashMenu?: PromptSlashMenuData) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const segment of promptInlineSegments(value, slashMenu)) {
    if (segment.kind === "text") {
      $appendText(paragraph, segment.text);
    } else {
      paragraph.append($createInlineEntityNode(segment.entity));
    }
  }
  root.append(paragraph);
  paragraph.selectEnd();
}

function $offsetInsideNode(
  node: LexicalNode,
  targetKey: NodeKey,
  targetOffset: number,
  targetType: "text" | "element",
): number | null {
  if (node.getKey() === targetKey) {
    if (targetType === "text") return targetOffset;
    if (!$isElementNode(node)) return 0;
    return node.getChildren()
      .slice(0, targetOffset)
      .reduce((total, child) => total + child.getTextContentSize(), 0);
  }
  if (!$isElementNode(node)) return null;
  let offset = 0;
  for (const child of node.getChildren()) {
    const childOffset = $offsetInsideNode(child, targetKey, targetOffset, targetType);
    if (childOffset !== null) return offset + childOffset;
    offset += child.getTextContentSize();
  }
  return null;
}

function $caretOffset() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return $getRoot().getTextContentSize();
  return $offsetInsideNode(
    $getRoot(),
    selection.anchor.key,
    selection.anchor.offset,
    selection.anchor.type,
  ) ?? $getRoot().getTextContentSize();
}

function activeSlashInEditor(): ActiveSlash | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  let node = anchor.getNode();
  let nodeCaret = anchor.offset;
  if (anchor.type === "element" && $isElementNode(node)) {
    let previous = node.getChildAtIndex(anchor.offset - 1);
    while ($isElementNode(previous)) previous = previous.getLastChild();
    if (!$isTextNode(previous)) return null;
    node = previous;
    nodeCaret = previous.getTextContentSize();
  }
  if (!$isTextNode(node)) return null;
  const beforeCaret = node.getTextContent().slice(0, nodeCaret);
  const nodeStart = Math.max(
    beforeCaret.lastIndexOf(" "),
    beforeCaret.lastIndexOf("\n"),
    beforeCaret.lastIndexOf("\t"),
  ) + 1;
  if (node.getTextContent()[nodeStart] !== "/") return null;
  const query = node.getTextContent().slice(nodeStart + 1, nodeCaret);
  if (/\s/u.test(query)) return null;
  const caret = $caretOffset();
  return {
    start: caret - (nodeCaret - nodeStart),
    caret,
    query,
    nodeKey: node.getKey(),
    nodeStart,
    nodeCaret,
  };
}

function firstEntityMatch(text: string, slashMenu?: PromptSlashMenuData) {
  let offset = 0;
  for (const segment of promptInlineSegments(text, slashMenu)) {
    if (segment.kind === "entity") {
      return {
        start: offset,
        end: offset + segment.sourceText.length,
        entity: segment.entity,
      };
    }
    offset += segment.text.length;
  }
  return null;
}

function EditorStatePlugin({
  disabled,
  onChange,
  slashMenu,
  value,
}: Pick<PromptRichEditorProps, "disabled" | "onChange" | "slashMenu" | "value">) {
  const [editor] = useLexicalComposerContext();
  const slashMenuRef = useRef(slashMenu);
  slashMenuRef.current = slashMenu;

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    editor.update(() => {
      const currentValue = $getRoot().getTextContent();
      if (currentValue === value) return;
      $replaceEditorValue(value, slashMenuRef.current);
    });
  }, [editor, value]);

  useEffect(() => editor.registerNodeTransform(TextNode, (node) => {
    if (editor.isComposing()) return;
    const match = firstEntityMatch(node.getTextContent(), slashMenu);
    if (!match) return;
    const selection = $getSelection();
    if (
      $isRangeSelection(selection)
      && selection.isCollapsed()
      && selection.anchor.key === node.getKey()
      && selection.anchor.offset === match.end
      && match.end === node.getTextContentSize()
    ) {
      return;
    }
    let target = node;
    if (match.start === 0 && match.end < node.getTextContentSize()) {
      [target] = node.splitText(match.end);
    } else if (match.start > 0 && match.end === node.getTextContentSize()) {
      [, target] = node.splitText(match.start);
    } else if (match.start > 0 && match.end < node.getTextContentSize()) {
      [, target] = node.splitText(match.start, match.end);
    }
    target.replace($createInlineEntityNode(match.entity));
  }), [editor, slashMenu]);

  useEffect(() => editor.registerUpdateListener(({
    dirtyElements,
    dirtyLeaves,
    editorState,
  }) => {
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
    editorState.read(() => {
      const nextValue = $getRoot().getTextContent();
      onChange(nextValue, activeSlashInEditor());
    });
  }), [editor, onChange]);

  return null;
}

function AtomicEntityPlugin() {
  const [editor] = useLexicalComposerContext();

  function $adjacentEntity(direction: "backward" | "forward") {
    const selection = $getSelection();
    if ($isNodeSelection(selection)) {
      return selection.getNodes().find($isInlineEntityNode) ?? null;
    }
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

    const anchor = selection.anchor;
    const node = anchor.getNode();
    if ($isInlineEntityNode(node)) return node;

    let candidate: LexicalNode | null = null;
    if (anchor.type === "text") {
      const atBoundary = direction === "backward"
        ? anchor.offset === 0
        : anchor.offset === node.getTextContentSize();
      if (!atBoundary) return null;
      candidate = direction === "backward"
        ? node.getPreviousSibling()
        : node.getNextSibling();
    } else if ($isElementNode(node)) {
      candidate = node.getChildAtIndex(
        direction === "backward" ? anchor.offset - 1 : anchor.offset,
      );
    }

    while ($isTextNode(candidate) && candidate.getTextContentSize() === 0) {
      candidate = direction === "backward"
        ? candidate.getPreviousSibling()
        : candidate.getNextSibling();
    }
    return $isInlineEntityNode(candidate) ? candidate : null;
  }

  function $removeAdjacentEntity(direction: "backward" | "forward") {
    const entity = $adjacentEntity(direction);
    if (!entity) return false;
    entity.remove();
    return true;
  }

  useEffect(() => mergeRegister(
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        if (!$removeAdjacentEntity("backward")) return false;
        event?.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        if (!$removeAdjacentEntity("forward")) return false;
        event?.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  ), [editor]);

  useEffect(() => editor.registerRootListener((rootElement, previousRootElement) => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const direction = event.key === "Backspace"
        ? "backward"
        : event.key === "Delete"
          ? "forward"
          : null;
      if (!direction || event.isComposing || event.defaultPrevented) return;

      const hasEntity = editor.getEditorState().read(() => $adjacentEntity(direction) !== null);
      if (!hasEntity) return;

      event.preventDefault();
      event.stopPropagation();
      editor.update(() => {
        $removeAdjacentEntity(direction);
      }, { discrete: true });
    };

    previousRootElement?.removeEventListener("keydown", onKeyDown, true);
    rootElement?.addEventListener("keydown", onKeyDown, true);
  }), [editor]);

  return null;
}

const PromptRichEditor = forwardRef<PromptRichEditorHandle, PromptRichEditorProps>(
  function PromptRichEditor({
    disabled,
    onChange,
    onCompositionEnd,
    onCompositionStart,
    onKeyDownCapture,
    onPaste,
    placeholder,
    slashMenu,
    value,
  }, ref) {
    const initialValueRef = useRef(value);
    const initialSlashMenuRef = useRef(slashMenu);
    const initialConfig = useMemo(() => ({
      namespace: "SquadFlowPromptInput",
      nodes: [InlineEntityNode],
      editable: true,
      onError(error: Error) {
        throw error;
      },
      editorState: () => $replaceEditorValue(
        initialValueRef.current,
        initialSlashMenuRef.current,
      ),
      theme: {
        paragraph: "m-0",
      },
    }), []);

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <EditorHandlePlugin ref={ref} />
        <EditorStatePlugin
          disabled={disabled}
          onChange={onChange}
          slashMenu={slashMenu}
          value={value}
        />
        <AtomicEntityPlugin />
        <PlainTextPlugin
          contentEditable={(
            <ContentEditable
              aria-label={placeholder}
              aria-multiline="true"
              data-placeholder={placeholder}
              data-testid="prompt-rich-editor"
              onCompositionEnd={onCompositionEnd}
              onCompositionStart={onCompositionStart}
              onKeyDownCapture={onKeyDownCapture}
              onPaste={onPaste}
              className="min-h-[52px] max-h-[220px] min-w-0 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground outline-none"
            />
          )}
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={(
            <div className="pointer-events-none absolute left-0 top-0 text-sm leading-6 text-muted-foreground/55">
              {placeholder}
            </div>
          )}
        />
        <HistoryPlugin />
      </LexicalComposer>
    );
  },
);

const EditorHandlePlugin = forwardRef<PromptRichEditorHandle>(function EditorHandlePlugin(_props, ref) {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(ref, () => ({
    focus() {
      editor.focus();
    },
    getCaretOffset() {
      return editor.getEditorState().read($caretOffset);
    },
    insertLineBreak() {
      editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
    },
    replaceSlash(slash, descriptor) {
      editor.update(() => {
        const node = $getNodeByKey(slash.nodeKey);
        if (!$isTextNode(node)) return;
        const selection = $createRangeSelection();
        selection.setTextNodeRange(
          node,
          slash.nodeStart,
          node,
          Math.min(slash.nodeCaret, node.getTextContentSize()),
        );
        $setSelection(selection);
        selection.insertNodes([
          $createInlineEntityNode(descriptor),
          $createTextNode(" "),
        ]);
      });
    },
  }), [editor]);

  return null;
});

export { PromptRichEditor };

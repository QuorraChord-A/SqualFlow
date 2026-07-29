"use client";

import type { ComponentType, SVGProps } from "react";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { Package, Sparkles } from "lucide-react";
import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { cn } from "@/lib/utils";

export type PromptSlashMenuItem = {
  id: string;
  name: string;
  description?: string;
  scope: "project" | "global";
  kind: "skill" | "mcp";
  reference?: string;
};

export type PromptSlashMenuData = {
  skills: PromptSlashMenuItem[];
  mcpServers: PromptSlashMenuItem[];
  loading?: boolean;
  error?: string | null;
};

export type InlineEntityDescriptor = {
  entityId: string;
  text: string;
  label: string;
  iconKey: string;
  toneKey: string;
  sourceKind: string;
};

type InlineEntityPresentation = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const iconRegistry: Record<string, InlineEntityPresentation["icon"]> = {
  cube: Package,
  sparkle: Sparkles,
};

const toneRegistry: Record<string, string> = {
  blue: "text-sky-400 dark:text-sky-300",
};

function titleCaseLabel(value: string) {
  return value
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((part) => (
      /^(?:api|cli|mcp|pdf|sdk)$/iu.test(part)
        ? part.toLocaleUpperCase()
        : `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`
    ))
    .join(" ");
}

export function inlineEntityFromMenuItem(
  item: PromptSlashMenuItem,
): InlineEntityDescriptor {
  const itemLabel = titleCaseLabel(item.name);
  return {
    entityId: item.id,
    text: serializePromptInlineEntity(item.kind, item.name, item.reference),
    label: item.kind === "mcp"
      ? /\bMCP$/u.test(itemLabel) ? itemLabel : `${itemLabel} MCP`
      : itemLabel,
    iconKey: "cube",
    toneKey: "blue",
    sourceKind: item.kind,
  };
}

export type PromptInlineSegment =
  | { kind: "text"; text: string }
  | {
    kind: "entity";
    entity: InlineEntityDescriptor;
    sourceText: string;
    item?: PromptSlashMenuItem;
  };

const canonicalEntityPattern = /\[([@$])([A-Za-z0-9][A-Za-z0-9._:-]*)\]\(([^)\s]+)\)/gu;

export function serializePromptInlineEntity(
  kind: PromptSlashMenuItem["kind"],
  name: string,
  reference?: string,
) {
  const prefix = kind === "skill" ? "$" : "@";
  if (kind === "skill" && reference) {
    return `[${prefix}${name}](${encodeURI(reference)})`;
  }
  return `[${prefix}${name}](/.squadflow/${kind}/${encodeURIComponent(name)})`;
}

function inlineEntityFromCanonical(
  kind: PromptSlashMenuItem["kind"],
  name: string,
  sourceText: string,
): InlineEntityDescriptor {
  const itemLabel = titleCaseLabel(name);
  return {
    entityId: `${kind}-${name}`,
    text: sourceText,
    label: kind === "mcp"
      ? /\bMCP$/u.test(itemLabel) ? itemLabel : `${itemLabel} MCP`
      : itemLabel,
    iconKey: "cube",
    toneKey: "blue",
    sourceKind: kind,
  };
}

function isEntityBoundary(character: string | undefined) {
  return character === undefined || /[\s.,!?;:，。！？；：、()[\]{}"'“”‘’]/u.test(character);
}

export function promptInlineSegments(
  value: string,
  slashMenu?: PromptSlashMenuData,
): PromptInlineSegment[] {
  const canonicalSegments: PromptInlineSegment[] = [];
  let canonicalCursor = 0;
  for (const match of value.matchAll(canonicalEntityPattern)) {
    const start = match.index;
    const sourceText = match[0];
    const prefix = match[1];
    const name = match[2];
    let target: string;
    try {
      target = decodeURI(match[3]);
    } catch {
      continue;
    }
    const virtualSkillTarget = `/.squadflow/skill/${name}`;
    const virtualMcpTarget = `/.squadflow/mcp/${name}`;
    const kind = prefix === "$" ? "skill" : "mcp";
    const validTarget = kind === "skill"
      ? target === virtualSkillTarget || target.endsWith(`/${name}/SKILL.md`)
      : target === virtualMcpTarget;
    if (!validTarget) {
      continue;
    }
    if (start > canonicalCursor) {
      canonicalSegments.push({ kind: "text", text: value.slice(canonicalCursor, start) });
    }
    canonicalSegments.push({
      kind: "entity",
      entity: inlineEntityFromCanonical(kind, name, sourceText),
      sourceText,
    });
    canonicalCursor = start + sourceText.length;
  }
  if (canonicalCursor < value.length) {
    canonicalSegments.push({ kind: "text", text: value.slice(canonicalCursor) });
  }
  if (canonicalSegments.length === 0) {
    canonicalSegments.push({ kind: "text", text: value });
  }

  const candidates = [
    ...(slashMenu?.mcpServers ?? []).flatMap((item) => [
      { text: `/${item.name} MCP`, item, priority: 0 },
      { text: `@${item.name}`, item, priority: 1 },
    ]),
    ...(slashMenu?.skills ?? []).flatMap((item) => [
      { text: `/${item.name}`, item, priority: 2 },
      { text: `$${item.name}`, item, priority: 2 },
    ]),
  ].sort((left, right) => right.text.length - left.text.length || left.priority - right.priority);
  if (candidates.length === 0) return canonicalSegments;

  return canonicalSegments.flatMap((segment): PromptInlineSegment[] => {
    if (segment.kind === "entity" || !segment.text) return [segment];

    const lowerValue = segment.text.toLocaleLowerCase();
    const recognized: PromptInlineSegment[] = [];
    let cursor = 0;
    let textStart = 0;
    while (cursor < segment.text.length) {
      const match = candidates.find((candidate) => {
        const candidateText = candidate.text.toLocaleLowerCase();
        return lowerValue.startsWith(candidateText, cursor)
          && isEntityBoundary(segment.text[cursor + candidate.text.length]);
      });
      if (!match) {
        cursor += 1;
        continue;
      }
      if (cursor > textStart) {
        recognized.push({ kind: "text", text: segment.text.slice(textStart, cursor) });
      }
      const sourceText = segment.text.slice(cursor, cursor + match.text.length);
      recognized.push({
        kind: "entity",
        entity: inlineEntityFromMenuItem(match.item),
        sourceText,
        item: match.item,
      });
      cursor += match.text.length;
      textStart = cursor;
    }
    if (textStart < segment.text.length) {
      recognized.push({ kind: "text", text: segment.text.slice(textStart) });
    }
    return recognized.length > 0 ? recognized : [segment];
  });
}

function InlineEntityView({
  descriptor,
  selected,
}: {
  descriptor: InlineEntityDescriptor;
  selected: boolean;
}) {
  const Icon = iconRegistry[descriptor.iconKey] ?? Package;
  const toneClassName = toneRegistry[descriptor.toneKey] ?? toneRegistry.blue;
  return (
    <span
      data-inline-entity
      data-entity-id={descriptor.entityId}
      data-source-kind={descriptor.sourceKind}
      data-testid={`prompt-inline-token-${descriptor.entityId}`}
      className={cn(
        "inline-flex select-none items-baseline gap-[3px] whitespace-nowrap rounded-[3px] font-medium leading-[inherit]",
        toneClassName,
        selected && "bg-sky-400/15 outline outline-1 outline-sky-400/35",
      )}
      contentEditable={false}
    >
      <Icon aria-hidden="true" className="relative top-[0.08em] size-[0.86em] shrink-0 stroke-[2]" />
      <span>{descriptor.label}</span>
    </span>
  );
}

export function PromptInlineContent({ value }: { value: string }) {
  return (
    <span data-prompt-inline-content>
      {promptInlineSegments(value).map((segment, index) => (
        segment.kind === "text"
          ? <span key={`text-${index}`}>{segment.text}</span>
          : (
            <InlineEntityView
              key={`entity-${segment.entity.entityId}-${index}`}
              descriptor={segment.entity}
              selected={false}
            />
          )
      ))}
    </span>
  );
}

export type SerializedInlineEntityNode = Spread<
  { descriptor: InlineEntityDescriptor },
  SerializedLexicalNode
>;

export class InlineEntityNode extends DecoratorNode<React.JSX.Element> {
  __descriptor: InlineEntityDescriptor;

  static getType(): string {
    return "prompt-inline-entity";
  }

  static clone(node: InlineEntityNode): InlineEntityNode {
    return new InlineEntityNode(node.__descriptor, node.__key);
  }

  static importJSON(serializedNode: SerializedInlineEntityNode): InlineEntityNode {
    return new InlineEntityNode(serializedNode.descriptor);
  }

  constructor(descriptor: InlineEntityDescriptor, key?: NodeKey) {
    super(key);
    this.__descriptor = { ...descriptor };
  }

  exportJSON(): SerializedInlineEntityNode {
    return {
      ...super.exportJSON(),
      descriptor: this.__descriptor,
      type: InlineEntityNode.getType(),
      version: 1,
    };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const element = document.createElement("span");
    element.className = "inline-block align-baseline";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  isIsolated(): true {
    return true;
  }

  isKeyboardSelectable(): true {
    return true;
  }

  getTextContent(): string {
    return this.__descriptor.text;
  }

  getDescriptor(): InlineEntityDescriptor {
    return { ...this.getLatest().__descriptor };
  }

  decorate(): React.JSX.Element {
    return (
      <InlineEntityDecorator
        descriptor={this.__descriptor}
        nodeKey={this.__key}
      />
    );
  }
}

function InlineEntityDecorator({
  descriptor,
  nodeKey,
}: {
  descriptor: InlineEntityDescriptor;
  nodeKey: NodeKey;
}) {
  const [selected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  return (
    <span
      contentEditable={false}
      onMouseDown={(event) => {
        event.preventDefault();
        if (event.shiftKey) {
          setSelected(!selected);
          return;
        }
        clearSelection();
        setSelected(true);
      }}
    >
      <InlineEntityView descriptor={descriptor} selected={selected} />
    </span>
  );
}

export function $createInlineEntityNode(descriptor: InlineEntityDescriptor): InlineEntityNode {
  return $applyNodeReplacement(new InlineEntityNode(descriptor));
}

export function $isInlineEntityNode(
  node: LexicalNode | null | undefined,
): node is InlineEntityNode {
  return node instanceof InlineEntityNode;
}

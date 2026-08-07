import type { ChatUIMessage } from "./chatJournal.js";
import type { TurnTiming } from "./turnTiming.js";
import type { RuntimeCapability } from "../domain/runtimeCapabilities.js";
import { claudeCapabilityForTool } from "../runtime/adapters/claudeCapabilities.js";
import { parseMessageSegments, type MessageSegment } from "../protocol/platformEvent.js";

type UnknownRecord = Record<string, unknown>;
type TextPart = { type: "text"; text: string };
type ReasoningPart = { type: "reasoning"; text: string; state: "done" };
type ToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  capability?: RuntimeCapability;
  providerToolName?: string;
  state: "input-available" | "output-available";
  inputText: string;
  input: Record<string, unknown> | null;
  output: { content: string; is_error: boolean } | null;
};
type AssistantPart = TextPart | ReasoningPart | ToolPart;
export type ImageAttachmentMetadata = {
  id: string;
  kind: "image" | "browser_comment";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataUrl: string;
  markerNumber?: number;
  comment?: string;
  label?: string;
  pageUrl?: string;
  selector?: string;
  addedAt: number;
};

export type BrowserCommentProjection = {
  markerNumber: number;
  label: string;
  selector: string;
  comment: string;
  pageUrl: string;
};

type AttachmentProjection = {
  kind: "image" | "browser_comment";
  markerNumber?: number;
};

export type PlatformMessageProjection = {
  text: string;
  metadata: Record<string, unknown>;
  browserComments: BrowserCommentProjection[];
  attachments: AttachmentProjection[];
};

export function rawSdkTranscriptToUiMessages(rawTranscript: string, flowId: string): ChatUIMessage[] {
  const entries = rawTranscript
    .split(/\r?\n/u)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as unknown];
      } catch {
        return [];
      }
    })
    .filter(isVisibleRawTranscriptEntry);
  return sdkSessionMessagesToUiMessages(entries, flowId);
}

export function sdkSessionMessagesToUiMessages(rawMessages: unknown[], flowId: string): ChatUIMessage[] {
  const messages: ChatUIMessage[] = [];
  let pendingAssistantBlocks: UnknownRecord[] = [];
  let pendingAssistantStartTs: string | null = null;
  let pendingAssistantFinishTs: string | null = null;
  let msgCounter = 0;

  const flushAssistant = () => {
    if (pendingAssistantBlocks.length === 0) return;
    const parts = blocksToParts(pendingAssistantBlocks);
    const content = textContent(parts);
    if (content.trim() === "No response requested.") {
      pendingAssistantBlocks = [];
      pendingAssistantStartTs = null;
      pendingAssistantFinishTs = null;
      return;
    }
    const timing: TurnTiming = {
      startedAt: pendingAssistantStartTs,
      finishedAt: pendingAssistantFinishTs,
      durationMs: derivedDurationMs(pendingAssistantStartTs, pendingAssistantFinishTs),
    };
    messages.push({
      id: `msg-${msgCounter}`,
      role: "assistant",
      parts,
      content,
      metadata: { turnTiming: timing },
    });
    msgCounter += 1;
    pendingAssistantBlocks = [];
    pendingAssistantStartTs = null;
    pendingAssistantFinishTs = null;
  };

  for (const raw of rawMessages) {
    const sessionMessage = asRecord(raw);
    const msg = asRecord(sessionMessage?.message);
    if (!msg) continue;

    const role = stringValue(msg.role, "assistant");
    const blocks = contentBlocks(msg.content);
    const messageTimestamp = stringValue(sessionMessage?.timestamp);

    if (role === "user") {
      const toolResultBlocks = blocks.filter((block) => stringValue(block.type) === "tool_result");
      if (toolResultBlocks.length > 0 && pendingAssistantBlocks.length > 0) {
        pendingAssistantBlocks.push(...toolResultBlocks);
        continue;
      }
      const rawText = textBlocksContent(blocks);
      const projection = platformMessageToUiProjection(rawText, flowId);
      const text = projection.text;
      const parts = text ? [{ type: "text" as const, text }] : [];
      const imageAttachments = imageAttachmentsFromBlocks(
        blocks,
        `msg-${msgCounter}`,
        messageTimestamp,
        projection.attachments,
        projection.browserComments,
      );
      const browserElementAttachments = browserElementAttachmentsFromProjection(
        projection.browserComments,
        imageAttachments,
        `msg-${msgCounter}`,
        messageTimestamp,
      );
      const metadata = {
        ...projection.metadata,
        ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
        ...(browserElementAttachments.length > 0 ? { browserElementAttachments } : {}),
      };
      if (rawText || imageAttachments.length > 0) flushAssistant();
      if (parts.length === 0 && imageAttachments.length === 0 && browserElementAttachments.length === 0) continue;
      messages.push({
        id: `msg-${msgCounter}`,
        role: "user",
        parts,
        content: textContent(parts),
        ...(messageTimestamp ? { createdAt: messageTimestamp } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      msgCounter += 1;
      continue;
    }

    if (role === "assistant") {
      if (pendingAssistantStartTs === null) {
        pendingAssistantStartTs = messageTimestamp || null;
      }
      pendingAssistantFinishTs = messageTimestamp || pendingAssistantFinishTs;
      pendingAssistantBlocks.push(...blocks);
      continue;
    }

    flushAssistant();
  }

  flushAssistant();
  return messages;
}

function derivedDurationMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(finish)) return null;
  const duration = finish - start;
  return duration >= 0 ? duration : null;
}

function blocksToParts(blocks: UnknownRecord[]): AssistantPart[] {
  const parts: AssistantPart[] = [];

  for (const block of blocks) {
    const blockType = stringValue(block.type);
    if (blockType === "thinking") {
      parts.push({ type: "reasoning", text: stringValue(block.thinking), state: "done" });
      continue;
    }
    if (blockType === "text") {
      parts.push({ type: "text", text: stringValue(block.text) });
      continue;
    }
    if (blockType === "tool_use") {
      const toolName = stringValue(block.name, "unknown");
      const capability = claudeCapabilityForTool(toolName);
      parts.push({
        type: `tool-${toolName}`,
        toolCallId: stringValue(block.id, "tool-unknown"),
        toolName,
        ...(capability ? { capability, providerToolName: toolName } : {}),
        state: "input-available",
        inputText: "",
        input: asRecord(block.input),
        output: null,
      });
      continue;
    }
    if (blockType === "tool_result") {
      const output = {
        content: contentToString(block.content),
        is_error: Boolean(block.is_error),
      };
      const toolUseId = stringValue(block.tool_use_id);
      const toolPart = findToolPart(parts, toolUseId);
      if (toolPart) {
        toolPart.output = output;
        toolPart.state = "output-available";
      }
    }
  }

  return parts;
}

function textBlocksContent(blocks: UnknownRecord[]): string {
  return blocks
    .filter((block) => stringValue(block.type) === "text")
    .map((block) => stringValue(block.text))
    .join("");
}

function eventSegments(segments: MessageSegment[], type: string) {
  return segments.filter((segment) => segment.kind === "event" && segment.type === type);
}

function browserCommentsFromSegments(segments: MessageSegment[]): BrowserCommentProjection[] {
  return eventSegments(segments, "browser_comment").flatMap((segment) => {
    if (segment.kind !== "event") return [];
    const markerNumber = Number(segment.attrs.n);
    if (!Number.isInteger(markerNumber) || markerNumber <= 0) return [];
    return [{
      markerNumber,
      label: segment.attrs.label ?? `Comment ${markerNumber}`,
      selector: segment.attrs.selector ?? "",
      comment: segment.body,
      pageUrl: segment.attrs.url ?? "",
    }];
  });
}

function attachmentProjections(segments: MessageSegment[]): AttachmentProjection[] {
  return eventSegments(segments, "attachment").flatMap((segment) => {
    if (segment.kind !== "event") return [];
    const markerNumber = Number(/Comment\s+(\d+)/u.exec(segment.body)?.[1]);
    return [{
      kind: Number.isInteger(markerNumber) && markerNumber > 0 ? "browser_comment" as const : "image" as const,
      ...(Number.isInteger(markerNumber) && markerNumber > 0 ? { markerNumber } : {}),
    }];
  });
}

export function platformMessageToUiProjection(text: string, flowId: string): PlatformMessageProjection {
  const segments = parseMessageSegments(text, flowId);
  const userText = segments
    .filter((segment) => segment.kind === "user_text")
    .map((segment) => segment.raw)
    .join("\n\n");
  const guide = eventSegments(segments, "guide").at(0);
  const leaderMessage = eventSegments(segments, "leader_message").at(0);
  const orchestrationFeedback = eventSegments(segments, "orchestration_feedback").at(0);
  const visibleText = userText
    || (guide?.kind === "event" ? guide.body : "")
    || (leaderMessage?.kind === "event" ? leaderMessage.body : "")
    || (orchestrationFeedback ? "计划评论" : "");
  return {
    text: visibleText,
    metadata: guide
      ? { messageKind: "running-guide", guideStatusLabel: "已引导对话" }
      : {},
    browserComments: browserCommentsFromSegments(segments),
    attachments: attachmentProjections(segments),
  };
}

function imageAttachmentsFromBlocks(
  blocks: UnknownRecord[],
  messageId: string,
  messageTimestamp: string,
  projections: AttachmentProjection[],
  browserComments: BrowserCommentProjection[],
): ImageAttachmentMetadata[] {
  const addedAt = Number.isNaN(Date.parse(messageTimestamp)) ? Date.now() : Date.parse(messageTimestamp);
  const attachments: ImageAttachmentMetadata[] = [];
  for (const block of blocks) {
    if (stringValue(block.type) !== "image") continue;
    const source = asRecord(block.source);
    if (!source || stringValue(source.type) !== "base64") continue;
    const mediaType = stringValue(source.media_type);
    if (!isSupportedImageMediaType(mediaType)) continue;
    const data = stringValue(source.data);
    if (!data) continue;
    const projection = projections[attachments.length];
    const browserComment = projection?.kind === "browser_comment"
      ? browserComments.find((comment) => comment.markerNumber === projection.markerNumber)
      : undefined;
    attachments.push({
      id: `${messageId}-image-${attachments.length + 1}`,
      kind: projection?.kind ?? "image",
      mediaType,
      dataUrl: `data:${mediaType};base64,${data}`,
      ...(browserComment ? {
        markerNumber: browserComment.markerNumber,
        comment: browserComment.comment,
        label: browserComment.label,
        pageUrl: browserComment.pageUrl,
        selector: browserComment.selector,
      } : {}),
      addedAt,
    });
  }
  return attachments;
}

export function browserElementAttachmentsFromProjection(
  comments: BrowserCommentProjection[],
  images: ImageAttachmentMetadata[],
  messageId: string,
  messageTimestamp: string,
) {
  const addedAt = Number.isNaN(Date.parse(messageTimestamp)) ? Date.now() : Date.parse(messageTimestamp);
  return comments.map((comment, index) => {
    const image = images.find((attachment) =>
      attachment.kind === "browser_comment" && attachment.markerNumber === comment.markerNumber
    );
    return {
      id: `${messageId}-browser-${comment.markerNumber || index + 1}`,
      addedAt,
      tagName: "",
      text: comment.label,
      selector: comment.selector,
      role: "",
      ariaLabel: comment.label,
      title: "",
      url: comment.pageUrl,
      pageTitle: "",
      markerNumber: comment.markerNumber,
      comment: comment.comment,
      screenshotDataUrl: image?.dataUrl ?? "",
      viewport: { width: 0, height: 0 },
      rect: { x: 0, y: 0, width: 0, height: 0 },
      attributes: { id: "", className: "", href: "", name: "", type: "" },
    };
  });
}

function isSupportedImageMediaType(value: string): value is ImageAttachmentMetadata["mediaType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function findToolPart(parts: AssistantPart[], toolUseId: string): ToolPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isToolPart(part) && (!toolUseId || part.toolCallId === toolUseId)) {
      return part;
    }
  }
  return undefined;
}

function textContent(parts: Array<AssistantPart | TextPart>): string {
  return parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isToolPart(part: AssistantPart): part is ToolPart {
  return part.type.startsWith("tool-");
}

function contentBlocks(content: unknown): UnknownRecord[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record ? [record] : [];
  });
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item);
        if (!record) return "";
        if (stringValue(record.type) === "text") return stringValue(record.text);
        return JSON.stringify(record);
      })
      .join("");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanField(record: UnknownRecord, key: string): boolean {
  return record[key] === true;
}

function isVisibleRawTranscriptEntry(value: unknown): boolean {
  const entry = asRecord(value);
  if (!entry) return false;
  const type = stringValue(entry.type);
  if (type !== "user" && type !== "assistant") return false;
  if (booleanField(entry, "isMeta") || booleanField(entry, "isSidechain") || booleanField(entry, "isCompactSummary")) {
    return false;
  }
  if (typeof entry.teamName === "string" && entry.teamName) return false;
  const message = asRecord(entry.message);
  if (!message) return false;
  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (content === "<command-name>/compact</command-name>") return false;
  if (content === "No response requested.") return false;
  if (content === "<local-command-stdout>Compacted conversation.</local-command-stdout>") return false;
  return true;
}

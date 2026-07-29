import type { UiMcpContentBlock, UiMcpResult, UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { UiMessageChunkBuilder } from "../protocol/uiMessageChunkBuilder.js";
import { claudeCapabilityForTool } from "../runtime/adapters/claudeCapabilities.js";

type UnknownRecord = Record<string, unknown>;

export type ClaudeResultCacheUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheHitRate: number | null;
};

export function adaptClaudeMessageToUiChunks(
  raw: unknown,
  messageId: string,
  metadata?: { startedAt?: string } | unknown,
): UiMessageChunk[] {
  return createClaudeToUiChunkAdapter(messageId, metadata).adapt(raw);
}

export function createClaudeToUiChunkAdapter(messageId: string, metadata?: { startedAt?: string } | unknown) {
  const startedAt = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as { startedAt?: unknown }).startedAt
    : undefined;
  return new ClaudeToUiChunkAdapter(messageId, typeof startedAt === "string" ? startedAt : undefined);
}

export class ClaudeToUiChunkAdapter {
  private readonly builder: UiMessageChunkBuilder;
  private streamedTextSinceAssistant = false;
  private streamedReasoningSinceAssistant = false;
  private finished = false;
  private _sdkSessionId: string | null = null;
  private _resultStatus: string | null = null;
  private _resultIsError: boolean | null = null;
  private _resultError: string | null = null;
  private _apiErrorMessageSeen = false;
  private _finalAssistantText: string | null = null;
  private pendingStreamedText = "";
  private readonly streamedToolCallIds = new Set<string>();
  private readonly streamedToolCallsByIndex = new Map<number, { id: string; name: string }>();
  private readonly toolNamesByCallId = new Map<string, string>();
  private _durationMs: number | null = null;
  private _resultCacheUsage: ClaudeResultCacheUsage | null = null;

  constructor(messageId: string, startedAt?: string) {
    this.builder = new UiMessageChunkBuilder(messageId, startedAt);
  }

  get sdkSessionId(): string | null {
    return this._sdkSessionId;
  }

  get resultStatus(): string | null {
    return this._resultStatus;
  }

  get resultIsError(): boolean | null {
    return this._resultIsError;
  }

  get resultError(): string | null {
    return this._resultError;
  }

  get finalAssistantText(): string | null {
    return this._finalAssistantText;
  }

  get durationMs(): number | null {
    return this._durationMs;
  }

  get resultCacheUsage(): ClaudeResultCacheUsage | null {
    return this._resultCacheUsage;
  }

  start(): UiMessageChunk {
    return this.builder.start();
  }

  adapt(raw: unknown): UiMessageChunk[] {
    const msg = asRecord(raw);
    if (!msg) return [];
    this.captureSdkSessionId(msg);

    const type = stringValue(msg.type);
    if (type === "stream_event") return this.adaptStreamEvent(msg);
    if (type === "assistant") return this.adaptAssistantMessage(msg);
    if (type === "user") return this.adaptUserMessage(msg);
    if (type === "result") return this.adaptResultMessage(msg);

    return [];
  }

  finish(): UiMessageChunk[] {
    if (this.finished) return [];
    this.finished = true;
    return this.builder.finish(this._durationMs);
  }

  private adaptStreamEvent(msg: UnknownRecord): UiMessageChunk[] {
    const event = asRecord(msg.event);
    const delta = asRecord(event?.delta);
    const deltaType = stringValue(delta?.type);
    const eventType = stringValue(event?.type);
    const blockIndex = numberValue(event?.index, -1);

    if (eventType === "content_block_start") {
      const block = asRecord(event?.content_block);
      if (stringValue(block?.type) !== "tool_use") return [];
      const id = stringValue(block?.id, `tool-${blockIndex}`);
      const name = stringValue(block?.name, "unknown");
      this.streamedToolCallIds.add(id);
      this.streamedToolCallsByIndex.set(blockIndex, { id, name });
      this.toolNamesByCallId.set(id, name);
      return this.builder.toolCallStart(name, id, {
        capability: claudeCapabilityForTool(name),
        providerToolName: name,
        ...(mcpMetadataForToolName(name) ? { mcp: mcpMetadataForToolName(name)! } : {}),
      });
    }

    if (deltaType === "input_json_delta") {
      const tool = this.streamedToolCallsByIndex.get(blockIndex);
      if (!tool) return [];
      return [this.builder.toolInputDelta(tool.id, stringValue(delta?.partial_json))];
    }

    if (deltaType === "thinking_delta") {
      this.streamedReasoningSinceAssistant = true;
      return this.builder.reasoningDelta(stringValue(delta?.thinking));
    }
    if (deltaType === "text_delta") {
      this.streamedTextSinceAssistant = true;
      const text = stringValue(delta?.text);
      this.pendingStreamedText += text;
      this._finalAssistantText = this.pendingStreamedText;
      return this.builder.textDelta(text);
    }

    return [];
  }

  private adaptAssistantMessage(msg: UnknownRecord): UiMessageChunk[] {
    const syntheticApiError = isSyntheticApiErrorMessage(msg) || msg.error != null;
    const chunks: UiMessageChunk[] = [];
    let messageText = "";
    for (const block of contentBlocks(msg)) {
      const blockRecord = asRecord(block);
      if (!blockRecord) continue;

      const blockType = stringValue(blockRecord.type);
      if (blockType === "text") {
        messageText += stringValue(blockRecord.text);
        if (!this.streamedTextSinceAssistant) chunks.push(...this.builder.textDelta(stringValue(blockRecord.text)));
      } else if (blockType === "thinking") {
        if (!this.streamedReasoningSinceAssistant) {
          chunks.push(...this.builder.reasoningDelta(stringValue(blockRecord.thinking)));
        }
      } else if (blockType === "tool_use") {
        const toolName = stringValue(blockRecord.name, "unknown");
        const toolCallId = stringValue(blockRecord.id, "tool-unknown");
        this.toolNamesByCallId.set(toolCallId, toolName);
        const metadata = { capability: claudeCapabilityForTool(toolName), providerToolName: toolName };
        const mcp = mcpMetadataForToolName(toolName);
        if (mcp) Object.assign(metadata, { mcp });
        if (this.streamedToolCallIds.has(toolCallId)) {
          chunks.push(this.builder.toolInputAvailable(toolName, toolCallId, recordValue(blockRecord.input), metadata));
        } else {
          chunks.push(...this.builder.toolCall(toolName, toolCallId, recordValue(blockRecord.input), metadata));
        }
      } else if (blockType === "tool_result") {
        const toolUseId = stringValue(blockRecord.tool_use_id, "tool-unknown");
        const toolName = this.toolNamesByCallId.get(toolUseId) ?? "";
        const mcp = mcpMetadataForToolName(toolName);
        chunks.push(this.builder.toolResult(
          toolUseId,
          contentToString(blockRecord.content),
          Boolean(blockRecord.is_error),
          mcp ? mcpResultFromContent(blockRecord.content, Boolean(blockRecord.is_error)) : undefined,
        ));
      }
    }
    if (messageText) this._finalAssistantText = messageText;
    if (syntheticApiError) {
      this._apiErrorMessageSeen = true;
      this._resultStatus = "api_error";
      this._resultIsError = true;
      this._resultError = messageText || stringValue(msg.error) || "Claude Code API request failed";
    }
    this.pendingStreamedText = "";
    this.streamedTextSinceAssistant = false;
    this.streamedReasoningSinceAssistant = false;
    // A canonical assistant message closes any partial content block. The next
    // SDK message can take seconds to arrive while the turn is still active.
    return [...chunks, ...this.builder.endAssistantMessage()];
  }

  private adaptUserMessage(msg: UnknownRecord): UiMessageChunk[] {
    const chunks: UiMessageChunk[] = [];
    let sawToolResult = false;
    for (const block of contentBlocks(msg)) {
      const blockRecord = asRecord(block);
      if (!blockRecord || stringValue(blockRecord.type) !== "tool_result") continue;
      sawToolResult = true;
      const toolUseId = stringValue(blockRecord.tool_use_id, "tool-unknown");
      const toolName = this.toolNamesByCallId.get(toolUseId) ?? "";
      const mcp = mcpMetadataForToolName(toolName);
      chunks.push(this.builder.toolResult(
        toolUseId,
        contentToString(blockRecord.content),
        Boolean(blockRecord.is_error),
        mcp ? mcpResultFromContent(blockRecord.content, Boolean(blockRecord.is_error)) : undefined,
      ));
    }
    if (sawToolResult) {
      this.streamedTextSinceAssistant = false;
      this.streamedReasoningSinceAssistant = false;
    }
    return chunks;
  }

  private adaptResultMessage(msg: UnknownRecord): UiMessageChunk[] {
    this.captureSdkSessionId(msg);
    const resultStatus = stringValue(msg.subtype) || null;
    const resultIsError = booleanValue(msg.is_error);
    this._resultStatus = this._apiErrorMessageSeen && !resultIsError ? "api_error" : resultStatus;
    this._resultIsError = resultIsError || this._apiErrorMessageSeen;
    if (this._resultIsError) this._resultError = resultErrorText(msg) ?? this._resultError;
    this._resultCacheUsage = cacheUsageFromResult(msg);
    if (typeof msg.duration_ms === "number" && Number.isFinite(msg.duration_ms)) {
      this._durationMs = msg.duration_ms;
    }
    return [];
  }

  private captureSdkSessionId(msg: UnknownRecord) {
    const event = asRecord(msg.event);
    const session = asRecord(msg.session);
    const sessionId = stringValue(msg.session_id)
      || stringValue(msg.sessionId)
      || stringValue(event?.session_id)
      || stringValue(event?.sessionId)
      || stringValue(session?.id);
    if (sessionId) this._sdkSessionId = sessionId;
  }
}

function resultErrorText(msg: UnknownRecord): string | null {
  const result = stringValue(msg.result).trim();
  if (result) return result;
  if (!Array.isArray(msg.errors)) return null;
  const errors = msg.errors.filter((error): error is string => typeof error === "string" && error.trim().length > 0);
  return errors.length > 0 ? errors.join("; ") : null;
}

function isSyntheticApiErrorMessage(msg: UnknownRecord): boolean {
  return msg.isApiErrorMessage === true || msg.is_api_error_message === true;
}

function contentBlocks(msg: UnknownRecord): unknown[] {
  const message = asRecord(msg.message);
  const content = message?.content ?? msg.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildCacheUsage(
  inputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
): ClaudeResultCacheUsage | null {
  const denominator = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (denominator <= 0) return null;
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheHitRate: (cacheReadInputTokens / denominator) * 100,
  };
}

function cacheUsageFromResult(msg: UnknownRecord): ClaudeResultCacheUsage | null {
  const apiUsage = asRecord(msg.usage);
  if (apiUsage) {
    const usage = buildCacheUsage(
      numberValue(apiUsage.input_tokens),
      numberValue(apiUsage.cache_read_input_tokens),
      numberValue(apiUsage.cache_creation_input_tokens),
    );
    if (usage) return usage;
  }

  const modelUsage = asRecord(msg.modelUsage);
  if (!modelUsage) return null;
  let inputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const value of Object.values(modelUsage)) {
    const usage = asRecord(value);
    if (!usage) continue;
    inputTokens += numberValue(usage.inputTokens);
    cacheReadInputTokens += numberValue(usage.cacheReadInputTokens);
    cacheCreationInputTokens += numberValue(usage.cacheCreationInputTokens);
  }
  return buildCacheUsage(inputTokens, cacheReadInputTokens, cacheCreationInputTokens);
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

function mcpMetadataForToolName(toolName: string): {
  server: string;
  tool: string;
} | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : null;
}

function mcpResultFromContent(content: unknown, isError: boolean): UiMcpResult {
  const blocks = Array.isArray(content)
    ? content.filter(isMcpContentBlock)
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  return {
    content: blocks,
    ...(isError ? { isError: true } : {}),
  };
}

function isMcpContentBlock(value: unknown): value is UiMcpContentBlock {
  return asRecord(value) !== null && typeof (value as Record<string, unknown>).type === "string";
}

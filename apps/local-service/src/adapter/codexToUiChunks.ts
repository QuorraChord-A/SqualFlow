import type { UiMcpContentBlock, UiMcpIcon, UiMcpResult, UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { UiMessageChunkBuilder } from "../protocol/uiMessageChunkBuilder.js";
import type { RuntimeCapability } from "../domain/runtimeCapabilities.js";
import {
  captureMcpServerIcons,
  mcpServerIconsForTool,
  type McpServerIconRegistry,
} from "../runtime/mcpServerIcons.js";

type UnknownRecord = Record<string, unknown>;

export const CODEX_COMMAND_DECLINED_OUTPUT = "用户已明确拒绝执行该风险命令。";

export function createCodexToUiChunkAdapter(
  messageId: string,
  metadata?: { startedAt?: string; mcpServerIcons?: McpServerIconRegistry } | unknown,
) {
  const startedAt = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as { startedAt?: unknown }).startedAt
    : undefined;
  const mcpServerIcons = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as { mcpServerIcons?: unknown }).mcpServerIcons
    : undefined;
  return new CodexToUiChunkAdapter(
    messageId,
    typeof startedAt === "string" ? startedAt : undefined,
    mcpServerIcons instanceof Map ? mcpServerIcons : undefined,
  );
}

export class CodexToUiChunkAdapter {
  private readonly builder: UiMessageChunkBuilder;
  private finished = false;
  private lastAgentMessageText = "";
  private currentAgentMessageItemId: string | null = null;
  private readonly startedMcpToolCallIds = new Set<string>();
  private _sdkSessionId: string | null = null;
  private _resultStatus: string | null = null;
  private _resultIsError: boolean | null = null;
  private _resultError: string | null = null;
  private _finalAssistantText: string | null = null;
  private _durationMs: number | null = null;
  private _resultCacheUsage: {
    inputTokens: number;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    cacheHitRate: number | null;
  } | null = null;

  constructor(
    messageId: string,
    startedAt?: string,
    private readonly mcpServerIcons?: McpServerIconRegistry,
  ) {
    this.builder = new UiMessageChunkBuilder(messageId, startedAt);
  }

  get sdkSessionId() { return this._sdkSessionId; }
  get resultStatus() { return this._resultStatus; }
  get resultIsError() { return this._resultIsError; }
  get resultError() { return this._resultError; }
  get finalAssistantText() { return this._finalAssistantText; }
  get durationMs() { return this._durationMs; }
  get resultCacheUsage() { return this._resultCacheUsage; }

  captureMcpServerStatus(value: unknown): void {
    if (this.mcpServerIcons) captureMcpServerIcons(this.mcpServerIcons, value);
  }

  start(): UiMessageChunk {
    return this.builder.start();
  }

  adapt(raw: unknown): UiMessageChunk[] {
    const message = asRecord(raw);
    if (!message) return [];
    const method = stringValue(message.method);
    const params = asRecord(message.params);
    if (!params) return [];
    this.captureSdkSessionId(params);

    if (method === "item/agentMessage/delta") {
      this.trackAgentMessageItem(stringValue(params.itemId));
      const delta = stringValue(params.delta);
      this.lastAgentMessageText += delta;
      // Keep the latest visible agent-message segment available even when a
      // provider ends a turn before sending its canonical item/completed event.
      this._finalAssistantText = this.lastAgentMessageText;
      return this.builder.textDelta(delta);
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      return this.builder.reasoningDelta(stringValue(params.delta));
    }
    if (method === "command/exec/outputDelta" || method === "item/commandExecution/outputDelta") {
      return [this.builder.toolResult(stringValue(params.itemId, "codex-command"), stringValue(params.delta), false)];
    }
    if (method === "thread/tokenUsage/updated") {
      this._resultCacheUsage = cacheUsage(asRecord(params.tokenUsage));
      return [];
    }
    if (method === "item/completed" || method === "item/started") {
      const item = asRecord(params.item);
      return item ? this.adaptItem(item, method === "item/started") : [];
    }
    if (method === "turn/completed") {
      this.adaptTurnCompleted(params);
      return [];
    }
    return [];
  }

  finish(): UiMessageChunk[] {
    if (this.finished) return [];
    this.finished = true;
    return this.builder.finish(this._durationMs);
  }

  private adaptTurnCompleted(params: UnknownRecord) {
    const turn = asRecord(params.turn);
    this.captureSdkSessionId(params);
    const status = stringValue(turn?.status) || "unknown";
    this._resultStatus = status === "completed" ? "success" : status;
    this._resultIsError = status !== "completed";
    if (this._resultIsError) this._resultError = codexTurnErrorText(params, turn);
    this._durationMs = numberOrNull(turn?.durationMs);
  }

  private captureSdkSessionId(params: UnknownRecord) {
    const threadId = stringValue(params.threadId);
    if (threadId) this._sdkSessionId = threadId;
  }

  private trackAgentMessageItem(itemId: string) {
    if (!itemId || itemId === this.currentAgentMessageItemId) return;
    this.currentAgentMessageItemId = itemId;
    this.lastAgentMessageText = "";
  }

  private adaptItem(item: UnknownRecord, isStart: boolean): UiMessageChunk[] {
    const type = stringValue(item.type);
    if (type === "agentMessage") {
      this.trackAgentMessageItem(stringValue(item.id));
      const text = stringValue(item.text);
      let chunks: UiMessageChunk[] = [];
      if (text && text !== this.lastAgentMessageText) {
        const delta = text.slice(this.lastAgentMessageText.length);
        this.lastAgentMessageText = text;
        chunks = delta ? this.builder.textDelta(delta) : [];
      }
      if (!isStart && text) this._finalAssistantText = text;
      return chunks;
    }
    if (type === "reasoning") {
      const summary = arrayValue(item.summary).map(String).join("\n");
      const content = arrayValue(item.content).map(String).join("\n");
      const text = [summary, content].filter(Boolean).join("\n");
      return text ? this.builder.reasoningDelta(text) : [];
    }
    if (type === "commandExecution") {
      const id = stringValue(item.id, "codex-command");
      if (isStart) {
        const input = { command: stringValue(item.command), path: stringValue(item.cwd) };
        return this.builder.toolCall("codex_command", id, input, {
          capability: "shell",
          providerToolName: "commandExecution",
        });
      }
      const status = stringValue(item.status);
      const declined = status === "declined";
      const output = declined ? CODEX_COMMAND_DECLINED_OUTPUT : stringValue(item.aggregatedOutput);
      return output ? [this.builder.toolResult(id, output, declined || status === "failed")] : [];
    }
    if (type === "fileChange") {
      const id = stringValue(item.id, "codex-file-change");
      const input = { changes: item.changes ?? [] };
      if (isStart) {
        return this.builder.toolCall("codex_file_change", id, input, {
          capability: "edit",
          providerToolName: "fileChange",
        });
      }
      const status = stringValue(item.status, "completed");
      const error = asRecord(item.error);
      return [this.builder.toolResult(id, JSON.stringify({
        status,
        changes: item.changes ?? [],
        ...(error ? { error: stringValue(error.message, JSON.stringify(error)) } : {}),
      }), status === "failed" || Boolean(error))];
    }
    if (type === "mcpToolCall") {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      const id = stringValue(item.id, `mcp-${server}-${tool}`);
      const toolName = `mcp__${server}__${tool}`;
      const itemIcons = iconsFromValue(item.icons);
      const itemServerIcons = iconsFromValue(item.serverIcons);
      const registryServerIcons = mcpServerIconsForTool(toolName, this.mcpServerIcons);
      const metadata = {
        providerToolName: "mcpToolCall",
        mcp: {
          server,
          tool,
          ...(stringValue(item.title) ? { title: stringValue(item.title) } : {}),
          ...(itemIcons ? { icons: itemIcons } : {}),
          ...(itemServerIcons ?? registryServerIcons
            ? { serverIcons: itemServerIcons ?? registryServerIcons }
            : {}),
        },
      };
      const chunks = isStart
        ? this.builder.toolCallStart(toolName, id, metadata)
        : this.startedMcpToolCallIds.has(id)
          ? [this.builder.toolInputAvailable(toolName, id, recordValue(item.arguments), metadata)]
          : this.builder.toolCall(toolName, id, recordValue(item.arguments), metadata);
      if (isStart) this.startedMcpToolCallIds.add(id);
      const result = asRecord(item.result);
      const error = asRecord(item.error);
      if (result || error) {
        const mcpResult = normalizeMcpResult(result, error);
        chunks.push(this.builder.toolResult(
          id,
          error ? stringValue(error.message) : stringifyMcpResult(result),
          Boolean(error) || mcpResult?.isError === true,
          mcpResult ?? undefined,
        ));
      }
      return chunks;
    }
    return [];
  }
}

function codexTurnErrorText(params: UnknownRecord, turn: UnknownRecord | null): string | null {
  const directError = stringValue(turn?.error) || stringValue(params.error);
  if (directError) return directError;
  const error = asRecord(turn?.error) ?? asRecord(params.error);
  return stringValue(error?.message)
    || stringValue(error?.additionalDetails)
    || stringValue(turn?.errorMessage)
    || stringValue(turn?.error_message)
    || stringValue(params.errorMessage)
    || stringValue(params.error_message)
    || null;
}

function cacheUsage(tokenUsage: UnknownRecord | null) {
  const last = asRecord(tokenUsage?.last);
  if (!last) return null;
  const inputTokens = numberOrNull(last.inputTokens);
  if (inputTokens === null) return null;
  const reportedCachedInputTokens = numberOrNull(last.cachedInputTokens);
  const cacheReadInputTokens = reportedCachedInputTokens !== null && reportedCachedInputTokens >= 0
    ? reportedCachedInputTokens
    : null;
  const cacheCreationInputTokens = cacheReadInputTokens === null ? null : 0;
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheHitRate: inputTokens > 0 && cacheReadInputTokens !== null
      ? (cacheReadInputTokens / inputTokens) * 100
      : null,
  };
}

function stringifyMcpResult(result: UnknownRecord | null): string {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => {
    const record = asRecord(item);
    return record ? stringValue(record.text, JSON.stringify(record)) : String(item);
  }).join("\n");
}

function normalizeMcpResult(result: UnknownRecord | null, error: UnknownRecord | null): UiMcpResult | null {
  if (!result && !error) return null;
  const content = Array.isArray(result?.content)
    ? result!.content.filter(isMcpContentBlock) as UiMcpContentBlock[]
    : [];
  const structuredContent = result?.structuredContent;
  const meta = asRecord(result?._meta);
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}),
    ...(meta ? { meta } : {}),
    ...(error ? { isError: true, meta: { error: stringValue(error.message) } } : {}),
  };
}

function isMcpContentBlock(value: unknown): value is UiMcpContentBlock {
  return asRecord(value) !== null && typeof (value as Record<string, unknown>).type === "string";
}

function iconsFromValue(value: unknown): UiMcpIcon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons = value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || typeof record.src !== "string" || !record.src) return [];
    const theme = record.theme === "light" || record.theme === "dark" ? record.theme : undefined;
    return [{
      src: record.src,
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
      ...(Array.isArray(record.sizes) ? { sizes: record.sizes.filter((size): size is string => typeof size === "string") } : {}),
      ...(theme ? { theme } : {}),
    }] as UiMcpIcon[];
  });
  return icons.length > 0 ? icons : undefined;
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

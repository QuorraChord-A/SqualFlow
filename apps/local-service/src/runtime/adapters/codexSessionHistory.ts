import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import type { RuntimeCapability } from "../../domain/runtimeCapabilities.js";
import type { AssistantUIMessage, ChatUIMessage } from "../../ws/chatJournal.js";
import {
  browserElementAttachmentsFromProjection,
  platformMessageToUiProjection,
  type ImageAttachmentMetadata,
} from "../../ws/sdkHistory.js";
import { bundledLegacyCodexVersion } from "./codexRuntimeProfile.js";

type UnknownRecord = Record<string, unknown>;
type AssistantPart = AssistantUIMessage["parts"][number];
type ToolPart = Extract<AssistantPart, { toolCallId: string }>;

type RolloutTurn = {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  ready: boolean;
  messages: ChatUIMessage[];
  assistantParts: AssistantUIMessage["parts"];
  assistantText: string;
  toolParts: Map<string, ToolPart>;
};

export async function getRawCodexSessionHistory(
  sessionId: string,
  flowId: string,
  runtimeConfig?: RuntimeConfig,
): Promise<ChatUIMessage[]> {
  const rolloutPath = codexRolloutPath(sessionId, runtimeConfig);
  if (!rolloutPath) throw new Error(`Codex rollout not found for session: ${sessionId}`);
  const raw = await fs.readFile(rolloutPath, "utf8");
  return codexRolloutToUiMessages(raw, flowId);
}

export async function getLatestCodexCompactTranscriptMetadata(
  sessionId: string,
  runtimeConfig?: RuntimeConfig,
): Promise<{ postTokens: number; timestamp?: string | null } | null> {
  const rolloutPath = codexRolloutPath(sessionId, runtimeConfig);
  if (!rolloutPath) return null;
  const raw = await fs.readFile(rolloutPath, "utf8").catch(() => "");
  if (!raw) return null;

  let hasCompaction = false;
  let latest: { postTokens: number; timestamp?: string | null } | null = null;
  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseJsonRecord(line);
    const payload = asRecord(parsed?.payload) ?? {};
    if (stringValue(parsed?.type) === "compacted" || stringValue(payload.type) === "context_compacted") {
      hasCompaction = true;
      latest = null;
    }
    if (stringValue(payload.type) !== "token_count") continue;
    const info = asRecord(payload.info) ?? {};
    const lastUsage = asRecord(info.last_token_usage) ?? {};
    const camelLastUsage = asRecord(info.lastTokenUsage) ?? {};
    const totalUsage = asRecord(info.total_token_usage) ?? {};
    const camelTotalUsage = asRecord(info.totalTokenUsage) ?? {};
    const postTokens = numberValue(lastUsage.total_tokens)
      ?? numberValue(camelLastUsage.totalTokens)
      ?? numberValue(totalUsage.total_tokens)
      ?? numberValue(camelTotalUsage.totalTokens)
      ?? numberValue(info.totalTokens);
    if (postTokens !== null) {
      latest = {
        postTokens,
        timestamp: stringValue(parsed?.timestamp) || null,
      };
    }
  }
  return hasCompaction ? latest : null;
}

export function codexRolloutToUiMessages(raw: string, flowId: string): ChatUIMessage[] {
  const messages: ChatUIMessage[] = [];
  let turn: RolloutTurn | null = null;
  let messageIndex = 0;

  const flushAssistant = () => {
    if (!turn || turn.assistantParts.length === 0) return;
    turn.messages.push({
      id: `codex-history-${messageIndex}`,
      role: "assistant",
      parts: turn.assistantParts,
      content: turn.assistantText,
      ...(turn.startedAt ? { createdAt: turn.startedAt } : {}),
    });
    messageIndex += 1;
    turn.assistantParts = [];
    turn.assistantText = "";
    turn.toolParts = new Map();
  };

  const finishTurn = (finishedAt: string | null) => {
    if (!turn) return;
    flushAssistant();
    turn.finishedAt = finishedAt;
    const durationMs = elapsedMs(turn.startedAt, turn.finishedAt);
    for (const message of turn.messages) {
      if (message.role !== "assistant") continue;
      message.metadata = {
        turnTiming: {
          startedAt: turn.startedAt,
          finishedAt: turn.finishedAt,
          durationMs,
        },
      };
    }
    messages.push(...turn.messages);
    turn = null;
  };

  for (const line of raw.split(/\r?\n/u)) {
    const entry = parseJsonRecord(line);
    if (!entry) continue;
    const timestamp = stringValue(entry.timestamp) || null;
    const payload = asRecord(entry.payload) ?? {};
    const entryType = stringValue(entry.type);
    const payloadType = stringValue(payload.type);

    if (entryType === "event_msg" && payloadType === "task_started") {
      finishTurn(timestamp);
      turn = {
        id: stringValue(payload.turn_id) || `turn-${messageIndex}`,
        startedAt: timestamp,
        finishedAt: null,
        ready: false,
        messages: [],
        assistantParts: [],
        assistantText: "",
        toolParts: new Map(),
      };
      continue;
    }

    if (!turn) continue;
    if (entryType === "turn_context" && (!payload.turn_id || stringValue(payload.turn_id) === turn.id)) {
      turn.ready = true;
      continue;
    }
    if (entryType === "event_msg" && (payloadType === "task_complete" || payloadType === "turn_aborted")) {
      finishTurn(timestamp);
      continue;
    }
    if (!turn.ready) continue;

    if (entryType === "response_item") {
      if (payloadType === "message") {
        const role = stringValue(payload.role);
        if (role === "user") {
          flushAssistant();
          const content = arrayValue(payload.content);
          const rawText = messageText(content, new Set(["input_text", "text"]));
          const projection = platformMessageToUiProjection(rawText, flowId);
          const imageAttachments = rolloutImageAttachments(content, projection, messageIndex, timestamp);
          const browserElementAttachments = browserElementAttachmentsFromProjection(
            projection.browserComments,
            imageAttachments,
            `codex-history-${messageIndex}`,
            timestamp ?? "",
          );
          const metadata = {
            ...projection.metadata,
            ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
            ...(browserElementAttachments.length > 0 ? { browserElementAttachments } : {}),
          };
          if (projection.text.trim() || imageAttachments.length > 0 || browserElementAttachments.length > 0) {
            turn.messages.push({
              id: `codex-history-${messageIndex}`,
              role: "user",
              parts: projection.text ? [{ type: "text", text: projection.text }] : [],
              content: projection.text,
              ...(timestamp ? { createdAt: timestamp } : {}),
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            });
            messageIndex += 1;
          }
        } else if (role === "assistant") {
          const text = messageText(arrayValue(payload.content), new Set(["output_text", "text"]));
          if (text) {
            turn.assistantParts.push({ type: "text", text });
            turn.assistantText += text;
          }
        }
        continue;
      }

      if (payloadType === "reasoning") {
        const text = reasoningText(payload);
        if (text) turn.assistantParts.push({ type: "reasoning", text, state: "done" });
        continue;
      }

      if (payloadType === "function_call") {
        const toolPart = functionCallPart(payload);
        turn.assistantParts.push(toolPart);
        turn.toolParts.set(toolPart.toolCallId, toolPart);
        continue;
      }

      if (payloadType === "function_call_output") {
        const toolPart = turn.toolParts.get(stringValue(payload.call_id));
        if (toolPart) {
          toolPart.state = "output-available";
          toolPart.output = rolloutToolOutput(payload.output);
        }
        continue;
      }
    }

    if (entryType === "event_msg") {
      const toolPart = normalizedEventToolPart(payload);
      if (toolPart) turn.assistantParts.push(toolPart);
    }
  }

  finishTurn(null);
  return messages;
}

function codexRolloutPath(sessionId: string, runtimeConfig?: RuntimeConfig): string | null {
  const codexHome = runtimeConfig?.authMode === "inherited"
    ? process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex")
    : process.env.SQUADFLOW_CODEX_HOME?.trim()
      || path.join(os.homedir(), "Library", "Application Support", "SquadFlow", "codex-runtime", bundledLegacyCodexVersion);
  let database: Database.Database | null = null;
  try {
    database = new Database(path.join(codexHome, "state_5.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?")
      .get(sessionId) as { rollout_path?: unknown } | undefined;
    return stringValue(row?.rollout_path) || null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function functionCallPart(payload: UnknownRecord): ToolPart {
  const toolName = stringValue(payload.name, "unknown");
  const toolCallId = stringValue(payload.call_id, `codex-${toolName}`);
  const capability = codexCapabilityForTool(toolName);
  return {
    type: `tool-${toolName}`,
    toolCallId,
    toolName,
    ...(capability ? { capability } : {}),
    providerToolName: "function_call",
    state: "input-available",
    inputText: "",
    input: parseJsonObject(payload.arguments),
    output: null,
  };
}

function normalizedEventToolPart(payload: UnknownRecord): ToolPart | null {
  const type = stringValue(payload.type);
  if (type === "mcp_tool_call_end") {
    const invocation = asRecord(payload.invocation) ?? {};
    const server = stringValue(invocation.server);
    const tool = stringValue(invocation.tool);
    if (!server || !tool) return null;
    const result = asRecord(payload.result) ?? {};
    const error = result.Err ?? result.err;
    const success = result.Ok ?? result.ok;
    return {
      type: `tool-mcp__${server}__${tool}`,
      toolCallId: stringValue(payload.call_id, `mcp-${server}-${tool}`),
      toolName: `mcp__${server}__${tool}`,
      providerToolName: "mcp_tool_call_end",
      state: "output-available",
      inputText: "",
      input: asRecord(invocation.arguments) ?? {},
      output: {
        content: mcpResultText(error ?? success),
        is_error: error !== undefined,
      },
    };
  }
  if (type === "patch_apply_end") {
    const success = payload.success !== false && stringValue(payload.status) !== "failed";
    return {
      type: "tool-codex_file_change",
      toolCallId: stringValue(payload.call_id, "codex-file-change"),
      toolName: "codex_file_change",
      capability: "edit",
      providerToolName: "patch_apply_end",
      state: "output-available",
      inputText: "",
      input: { changes: payload.changes ?? {} },
      output: {
        content: [stringValue(payload.stdout), stringValue(payload.stderr)].filter(Boolean).join("\n"),
        is_error: !success,
      },
    };
  }
  if (type === "web_search_end") {
    return {
      type: "tool-codex_web_search",
      toolCallId: stringValue(payload.call_id, "codex-web-search"),
      toolName: "codex_web_search",
      capability: "web_search",
      providerToolName: "web_search_end",
      state: "output-available",
      inputText: "",
      input: { query: stringValue(payload.query) },
      output: {
        content: payload.action === undefined ? "" : JSON.stringify(payload.action),
        is_error: false,
      },
    };
  }
  return null;
}

function rolloutToolOutput(value: unknown): ToolPart["output"] {
  if (typeof value === "string") {
    const parsed = parseJsonRecord(value);
    return {
      content: value,
      is_error: parsed?.is_error === true || parsed?.isError === true,
    };
  }
  return {
    content: value === undefined ? "" : JSON.stringify(value),
    is_error: asRecord(value)?.is_error === true || asRecord(value)?.isError === true,
  };
}

function rolloutImageAttachments(
  content: unknown[],
  projection: ReturnType<typeof platformMessageToUiProjection>,
  messageIndex: number,
  timestamp: string | null,
): ImageAttachmentMetadata[] {
  const addedAt = timestamp && !Number.isNaN(Date.parse(timestamp)) ? Date.parse(timestamp) : Date.now();
  const images = content.flatMap((item) => {
    const record = asRecord(item) ?? {};
    if (stringValue(record.type) !== "input_image") return [];
    const url = stringValue(record.image_url);
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/u.exec(url);
    if (!match) return [];
    return [{ url, mediaType: match[1] as ImageAttachmentMetadata["mediaType"] }];
  });
  return images.map((image, index) => {
    const descriptor = projection.attachments[index];
    const browserComment = descriptor?.kind === "browser_comment"
      ? projection.browserComments.find((comment) => comment.markerNumber === descriptor.markerNumber)
      : undefined;
    return {
      id: `codex-history-${messageIndex}-image-${index + 1}`,
      kind: descriptor?.kind ?? "image",
      mediaType: image.mediaType,
      dataUrl: image.url,
      ...(browserComment ? {
        markerNumber: browserComment.markerNumber,
        comment: browserComment.comment,
        label: browserComment.label,
        pageUrl: browserComment.pageUrl,
        selector: browserComment.selector,
      } : {}),
      addedAt,
    };
  });
}

function reasoningText(payload: UnknownRecord): string {
  const texts = [...arrayValue(payload.summary), ...arrayValue(payload.content)].flatMap((value) => {
    if (typeof value === "string") return [value];
    const record = asRecord(value);
    const text = stringValue(record?.text);
    return text ? [text] : [];
  });
  return texts.join("\n");
}

function messageText(content: unknown[], types: Set<string>): string {
  return content.flatMap((value) => {
    const record = asRecord(value);
    if (!record || !types.has(stringValue(record.type))) return [];
    return [stringValue(record.text)];
  }).join("");
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (asRecord(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return value ? { value } : {};
  }
}

function mcpResultText(value: unknown): string {
  const record = asRecord(value);
  const content = Array.isArray(record?.content) ? record.content : [];
  if (content.length > 0) {
    return content.map((item) => {
      const contentItem = asRecord(item);
      return contentItem ? stringValue(contentItem.text, JSON.stringify(contentItem)) : String(item);
    }).join("\n");
  }
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

function codexCapabilityForTool(toolName: string): RuntimeCapability | null {
  const normalized = toolName.toLowerCase();
  if (["exec_command", "write_stdin", "shell", "terminal"].includes(normalized)) return "shell";
  if (["apply_patch", "file_change", "edit_file"].includes(normalized)) return "edit";
  if (["read_file", "view_image"].includes(normalized)) return "read";
  if (["search_query", "web_search"].includes(normalized)) return "web_search";
  if (["grep", "glob", "rg"].includes(normalized)) return "search";
  return null;
}

function elapsedMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function parseJsonRecord(value: string): UnknownRecord | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

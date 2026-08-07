import { query as claudeQuery, type Options, type SDKControlGetContextUsageResponse, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeToUiChunkAdapter } from "../../adapter/claudeToUiChunks.js";
import {
  liveContextUsageToSnapshot,
  type ContextUsageCategory,
  type ContextUsageSnapshot,
} from "../../domain/contextUsage.js";
import {
  hasMessageImageData,
  type MessageImageAttachment,
  type MessageImageAttachmentWithData,
} from "../../protocol/wsMessages.js";
import {
  buildAttachmentEvent,
  buildLeaderGuidePrompt,
  buildLeaderPrompt,
  buildFlowNameRequestPrompt,
  type LeaderOrchestrationFeedback,
  type LeaderTurnInput,
} from "../leaderPrompt.js";
import { AsyncMessageQueue } from "./asyncMessageQueue.js";
import {
  buildClaudeExpertOptions as buildClaudeExpertSdkOptions,
  buildClaudeLeaderOptions as buildClaudeLeaderSdkOptions,
} from "./claudeOptions.js";
import {
  getLatestClaudeCompactTranscriptMetadata,
  getRawClaudeSessionHistory,
} from "./claudeSessionHistory.js";
import type { McpServerIconRegistry } from "../mcpServerIcons.js";
import { normalizeRuntimeQuery } from "./runtimeAdapter.js";
import type {
  AgentRuntimeAdapter,
  BuildExpertRuntimeOptionsInput,
  BuildLeaderRuntimeOptionsInput,
  RuntimeOutputAdapter,
  RuntimeQueryFn,
  RuntimeQueryInput,
  RuntimeRawQueryLike,
  RuntimePreviousContextUsage,
} from "./runtimeAdapter.js";
import type { RuntimeEvent } from "../runtimeEvents.js";

export type ClaudeQueryInput = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
};

export type ClaudeQueryLike = AsyncIterable<unknown> & {
  close?: () => void;
  streamInput?: (stream: AsyncIterable<SDKUserMessage>) => Promise<void>;
  getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
  mcpServerStatus?: () => Promise<unknown>;
};

export type ClaudeQueryFn = (input: ClaudeQueryInput) => ClaudeQueryLike;

type SdkContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

function textBlock(text: string): SdkContentBlock | null {
  return text ? { type: "text", text } as SdkContentBlock : null;
}

function imageBlock(attachment: MessageImageAttachmentWithData): SdkContentBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.media_type,
      data: attachment.data,
    },
  } as SdkContentBlock;
}

function runtimeMessageContentBlocks(
  flowId: string,
  message: string,
  attachments: MessageImageAttachment[] | undefined,
): SdkContentBlock[] {
  const blocks = [textBlock(message)].filter((block): block is SdkContentBlock => block !== null);
  for (const [index, attachment] of (attachments ?? []).entries()) {
    if (!hasMessageImageData(attachment)) continue;
    const description = textBlock(`\n\n${buildAttachmentEvent(flowId, attachment, index)}`);
    if (description) blocks.push(description);
    blocks.push(imageBlock(attachment));
  }
  return blocks;
}

function leaderUserContent(turn: LeaderTurnInput): SdkContentBlock[] {
  return runtimeMessageContentBlocks(turn.flowId, buildLeaderPrompt(turn), turn.attachments);
}

function leaderUserMessage(turn: LeaderTurnInput): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: leaderUserContent(turn),
    },
    parent_tool_use_id: null,
    priority: "later",
    timestamp: new Date().toISOString(),
  };
}

function leaderGuideMessage(
  flowId: string,
  content: string,
  attachments?: MessageImageAttachment[],
  orchestrationFeedback?: LeaderOrchestrationFeedback[],
  modes?: { behaviorMode: "execute" | "plan"; riskMode: "auto_edit" | "full_access"; orchestrationMode: "approval_required" | "automatic" },
): SDKUserMessage {
  const message = buildLeaderGuidePrompt({ flowId, content, attachments, orchestrationFeedback, ...modes });
  return {
    type: "user",
    message: {
      role: "user",
      content: runtimeMessageContentBlocks(flowId, message, attachments),
    },
    parent_tool_use_id: null,
    priority: "now",
    timestamp: new Date().toISOString(),
  };
}

function leaderFlowNameMessage(flowId: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: buildFlowNameRequestPrompt(flowId) }],
    },
    parent_tool_use_id: null,
    priority: "later",
    timestamp: new Date().toISOString(),
  };
}

async function* singleTextInput(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    priority: "later",
    timestamp: new Date().toISOString(),
  };
}

function expertUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: content }] },
    parent_tool_use_id: null,
    priority: "later",
    timestamp: new Date().toISOString(),
  };
}

function expertGuideMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: content }] },
    parent_tool_use_id: null,
    priority: "now",
    timestamp: new Date().toISOString(),
  };
}

function isResultMessage(raw: unknown) {
  return typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "result";
}

function resultInfo(raw: unknown) {
  if (!isResultMessage(raw)) return null;
  const record = raw as { subtype?: unknown; is_error?: unknown; session_id?: unknown };
  return {
    status: typeof record.subtype === "string" ? record.subtype : null,
    isError: record.is_error === true || (typeof record.is_error === "string" && record.is_error.toLowerCase() === "true"),
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
  };
}

function classifyEvent(raw: unknown, previous: RuntimePreviousContextUsage | undefined): RuntimeEvent {
  const failure = compactFailure(raw);
  if (failure) return { type: "compact_failed", error: failure, raw };
  const boundary = compactBoundarySnapshot(raw, previous);
  if (boundary) return { type: "compact_boundary", snapshot: boundary, raw };
  const result = resultInfo(raw);
  if (result) return { type: "turn_completed", result, raw };
  return { type: "other", raw };
}

type NowInjectionState = { inFlight: boolean };

/**
 * A `priority:"now"` injection kills the in-flight turn, which emits an extra result
 * (`terminal_reason:"aborted_streaming"`, subtype `error_during_execution`) before the
 * new turn processes the injected content. Adjudicate each result so runtimes only see
 * the real completion: terminal_reason is authoritative; the subtype heuristic is the
 * fallback for SDK builds that omit the optional field, and requires an injection in
 * flight so genuine execution errors are never swallowed.
 */
function adjudicateEvent(
  raw: unknown,
  previous: RuntimePreviousContextUsage | undefined,
  injection: NowInjectionState,
): RuntimeEvent {
  const event = classifyEvent(raw, previous);
  if (event.type !== "turn_completed") return event;
  const record = raw as { terminal_reason?: unknown; subtype?: unknown };
  const terminalReason = typeof record.terminal_reason === "string" ? record.terminal_reason : null;
  if (terminalReason === "aborted_streaming") {
    injection.inFlight = false;
    return { type: "turn_absorbed", reason: "aborted_streaming", result: event.result, raw };
  }
  if (terminalReason === null && record.subtype === "error_during_execution" && injection.inFlight) {
    injection.inFlight = false;
    return { type: "turn_absorbed", reason: "now_injection_echo", result: event.result, raw };
  }
  injection.inFlight = false;
  return event;
}

function trackNowInjections(
  prompt: string | AsyncIterable<SDKUserMessage>,
  injection: NowInjectionState,
): string | AsyncIterable<SDKUserMessage> {
  if (typeof prompt === "string") return prompt;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt) {
        if ((message as { priority?: unknown }).priority === "now") injection.inFlight = true;
        yield message;
      }
    },
  };
}

function compactFailure(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as { type?: unknown; subtype?: unknown; compact_result?: unknown; compact_error?: unknown };
  if (record.type !== "system" || record.subtype !== "status") return null;
  if (record.compact_result !== "failed") return null;
  return typeof record.compact_error === "string" ? record.compact_error : "Context compaction failed";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function previousUsageCategories(previous: RuntimePreviousContextUsage | undefined): ContextUsageCategory[] {
  if (!previous?.categoriesJson) return [];
  try {
    const parsed = JSON.parse(previous.categoriesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const category = item as Record<string, unknown>;
      if (typeof category.name !== "string" || typeof category.tokens !== "number") return [];
      return [{
        name: category.name,
        tokens: category.tokens,
        color: typeof category.color === "string" ? category.color : null,
        isDeferred: Boolean(category.isDeferred),
      }];
    });
  } catch {
    return [];
  }
}

function compactedTokenSnapshot(
  totalTokens: number,
  previous: RuntimePreviousContextUsage | undefined,
): ContextUsageSnapshot {
  const maxTokens = previous?.maxTokens ?? 200_000;
  return {
    totalTokens,
    maxTokens,
    rawMaxTokens: previous?.rawMaxTokens ?? maxTokens,
    percentage: maxTokens ? (totalTokens / maxTokens) * 100 : null,
    model: previous?.model ?? null,
    categories: previousUsageCategories(previous),
    cacheInputTokens: previous?.cacheInputTokens ?? null,
    cacheReadInputTokens: previous?.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? null,
    cacheHitRate: previous?.cacheHitRate ?? null,
    observedAt: new Date().toISOString(),
    compacted: true,
  };
}

function compactBoundarySnapshot(
  raw: unknown,
  previous: RuntimePreviousContextUsage | undefined,
): ContextUsageSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as { type?: unknown; subtype?: unknown; compactMetadata?: unknown; compact_metadata?: unknown };
  if (record.type !== "system" || record.subtype !== "compact_boundary") return null;
  const metadata = (record.compactMetadata ?? record.compact_metadata) as { postTokens?: unknown } | null;
  if (!metadata || typeof metadata !== "object") return null;
  const totalTokens = numberValue(metadata.postTokens);
  if (totalTokens === null) return null;
  return compactedTokenSnapshot(totalTokens, previous);
}

function createClaudeLeaderOptions(input: BuildLeaderRuntimeOptionsInput): Options {
  return buildClaudeLeaderSdkOptions(input);
}

function createClaudeExpertOptions(input: BuildExpertRuntimeOptionsInput): Options {
  return buildClaudeExpertSdkOptions(input);
}

function normalizeQueryInput(input: RuntimeQueryInput): ClaudeQueryInput {
  return {
    prompt: input.prompt as string | AsyncIterable<SDKUserMessage>,
    options: input.options as Options | undefined,
  };
}

function normalizeClaudeRawQuery(query: ClaudeQueryLike): RuntimeRawQueryLike {
  return {
    close: query.close,
    getContextUsage: query.getContextUsage,
    getMcpServerStatus: query.mcpServerStatus ? () => query.mcpServerStatus!() : undefined,
    async *[Symbol.asyncIterator]() {
      for await (const event of query) yield event;
    },
  };
}

function createOutputAdapter(
  messageId: string,
  metadata?: { startedAt?: string; mcpServerIcons?: McpServerIconRegistry } | unknown,
): RuntimeOutputAdapter {
  const adapter = createClaudeToUiChunkAdapter(messageId, metadata);
  return {
    get sdkSessionId() {
      return adapter.sdkSessionId;
    },
    get resultStatus() {
      return adapter.resultStatus;
    },
    get resultIsError() {
      return adapter.resultIsError;
    },
    get resultError() {
      return adapter.resultError;
    },
    get finalAssistantText() {
      return adapter.finalAssistantText;
    },
    get durationMs() {
      return adapter.durationMs;
    },
    get resultCacheUsage() {
      return adapter.resultCacheUsage;
    },
    captureMcpServerStatus: (value) => adapter.captureMcpServerStatus(value),
    start: () => adapter.start(),
    adapt: (event) => adapter.adapt(event.raw),
    finish: () => adapter.finish(),
  };
}

export function createClaudeAgentRuntimeAdapter(input: { query?: ClaudeQueryFn } = {}): AgentRuntimeAdapter {
  const runQuery = input.query ?? ((params: ClaudeQueryInput) => claudeQuery(params) as ClaudeQueryLike);
  return {
    sdk: "claudecode",
    capabilities: {
      steer: true,
      compact: true,
      historyRead: true,
      imageInput: true,
      tokenUsage: true,
      toolApproval: true,
    },
    buildLeaderOptions: createClaudeLeaderOptions,
    buildExpertOptions: createClaudeExpertOptions,
    prepareLeaderMcpServer: async ({ server }) => ({
      mcpServerConfig: { type: "sdk", name: "squadflow-leader", instance: server },
      close: async () => {},
    }),
    prepareExpertMcpServer: async ({ serverName, server }) => ({
      mcpServerConfig: { type: "sdk", name: serverName, instance: server },
      close: async () => {},
    }),
    createInputQueue: () => new AsyncMessageQueue<unknown>(),
    createLeaderUserMessage: leaderUserMessage as AgentRuntimeAdapter["createLeaderUserMessage"],
    createLeaderGuideMessage: leaderGuideMessage as AgentRuntimeAdapter["createLeaderGuideMessage"],
    createLeaderFlowNameMessage: leaderFlowNameMessage as AgentRuntimeAdapter["createLeaderFlowNameMessage"],
    createSingleTextInput: singleTextInput as AgentRuntimeAdapter["createSingleTextInput"],
    createExpertUserMessage: expertUserMessage as AgentRuntimeAdapter["createExpertUserMessage"],
    createExpertGuideMessage: expertGuideMessage as AgentRuntimeAdapter["createExpertGuideMessage"],
    createOutputAdapter,
    runQuery: (queryInput) => {
      const injection: NowInjectionState = { inFlight: false };
      const normalized = normalizeQueryInput(queryInput);
      return normalizeRuntimeQuery(
        normalizeClaudeRawQuery(runQuery({
          ...normalized,
          prompt: trackNowInjections(normalized.prompt, injection),
        })),
        (raw, previous) => adjudicateEvent(raw, previous, injection),
        queryInput.previousContextUsage,
      );
    },
    compactedTokenSnapshot,
    contextUsageSnapshot: (raw) => liveContextUsageToSnapshot(raw as SDKControlGetContextUsageResponse),
    compactContextInput: () => singleTextInput("/compact") as AsyncIterable<unknown>,
    loadSessionHistory: getRawClaudeSessionHistory,
    latestCompactTranscriptMetadata: getLatestClaudeCompactTranscriptMetadata,
  };
}

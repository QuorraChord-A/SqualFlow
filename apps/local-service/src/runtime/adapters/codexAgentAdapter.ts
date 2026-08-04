import { performance } from "node:perf_hooks";
import { createCodexToUiChunkAdapter } from "../../adapter/codexToUiChunks.js";
import {
  liveContextUsageToSnapshot,
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
  type LeaderPlanFeedback,
  type LeaderTurnInput,
} from "../leaderPrompt.js";
import { AsyncMessageQueue } from "./asyncMessageQueue.js";
import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexAppServerTransport, type CodexJsonRpcMessage } from "./codexAppServerClient.js";
import {
  getLatestCodexCompactTranscriptMetadata,
  getRawCodexSessionHistory,
} from "./codexSessionHistory.js";
import type { McpServerIconRegistry } from "../mcpServerIcons.js";
import {
  buildCodexExpertOptions,
  buildCodexLeaderOptions,
  codexAppServerArgs,
  type CodexRuntimeInput,
  type CodexRuntimeOptions,
} from "./codexOptions.js";
import { normalizeRuntimeQuery } from "./runtimeAdapter.js";
import type {
  AgentRuntimeAdapter,
  BuildExpertRuntimeOptionsInput,
  BuildLeaderRuntimeOptionsInput,
  RuntimeOutputAdapter,
  RuntimeDiagnosticEvent,
  RuntimeQueryInput,
  RuntimeRawQueryLike,
  RuntimeResultInfo,
  RuntimePreviousContextUsage,
} from "./runtimeAdapter.js";
import type { RuntimeEvent } from "../runtimeEvents.js";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";

export type CodexClientFactory = (options: CodexAppServerClientOptions) => CodexAppServerTransport;

type CodexQueryOptions = CodexRuntimeOptions & {
  clientOptions?: CodexAppServerClientOptions;
};

class InputCursor<T> {
  private pending: Promise<IteratorResult<T>> | null = null;

  constructor(private readonly iterator: AsyncIterator<T>) {}

  peek(): Promise<IteratorResult<T>> {
    if (!this.pending) this.pending = this.iterator.next();
    return this.pending;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.pending) {
      const result = await this.pending;
      this.pending = null;
      return result;
    }
    return this.iterator.next();
  }
}

function textInput(text: string): CodexRuntimeInput {
  return { type: "text", text };
}

function leaderUserMessage(turn: LeaderTurnInput): CodexRuntimeInput {
  return {
    type: "text",
    text: buildLeaderPrompt(turn),
    flowId: turn.flowId,
    attachments: turn.attachments,
    attachmentPlacement: "trailing",
  };
}

function leaderGuideMessage(
  flowId: string,
  content: string,
  attachments?: MessageImageAttachment[],
  planFeedback?: LeaderPlanFeedback[],
  specRequested?: boolean,
): CodexRuntimeInput {
  return {
    type: "text",
    text: buildLeaderGuidePrompt({ flowId, content, attachments, planFeedback, specRequested }),
    flowId,
    attachments,
    attachmentPlacement: "trailing",
  };
}

function leaderFlowNameMessage(flowId: string): CodexRuntimeInput {
  return {
    type: "text",
    text: buildFlowNameRequestPrompt(flowId),
    flowId,
  };
}

async function* singleTextInput(text: string): AsyncIterable<CodexRuntimeInput> {
  yield textInput(text);
}

function expertUserMessage(content: string): CodexRuntimeInput {
  return textInput(content);
}

// Mid-turn text inputs are delivered via `turn/steer` by the query loop, so the
// guide message shape is identical to a plain user message on Codex.
function expertGuideMessage(content: string): CodexRuntimeInput {
  return textInput(content);
}

function userInput(input: CodexRuntimeInput) {
  if (input.type !== "text") throw new Error(`Unsupported Codex runtime input: ${input.type}`);
  return codexContentWithAttachments(input.text, input.flowId, input.attachments, input.attachmentPlacement);
}

function textPart(text: string) {
  return text ? [{ type: "text", text, text_elements: [] }] : [];
}

function imagePart(attachment: MessageImageAttachmentWithData) {
  return {
    type: "image",
    url: `data:${attachment.media_type};base64,${attachment.data}`,
  };
}

function codexContentWithAttachments(
  text: string,
  flowId: string | undefined,
  attachments: MessageImageAttachment[] | undefined,
  placement: "inline" | "trailing" = "inline",
) {
  if (!attachments?.length) return textPart(text);
  if (!flowId) throw new Error("Codex attachments require a Flow ID");
  const imageAttachments = attachments.flatMap((attachment, index) =>
    hasMessageImageData(attachment) ? [{ attachment, index }] : []
  );
  if (imageAttachments.length === 0) return textPart(text);
  if (placement === "trailing") {
    return [
      ...textPart(text),
      ...imageAttachments.flatMap(({ attachment, index }) => [
        ...textPart(`\n\n${buildAttachmentEvent(flowId, attachment, index)}`),
        imagePart(attachment),
      ]),
    ];
  }
  const ordered = imageAttachments
    .map(({ attachment, index }) => ({
      attachment,
      index,
      offset: typeof attachment.text_offset === "number"
        ? Math.max(0, Math.min(text.length, attachment.text_offset))
        : text.length,
    }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index);
  const content: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const item of ordered) {
    content.push(...textPart(`${text.slice(cursor, item.offset)}\n\n${buildAttachmentEvent(flowId, item.attachment, item.index)}`));
    content.push(imagePart(item.attachment));
    cursor = item.offset;
  }
  content.push(...textPart(text.slice(cursor)));
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function appServerTransport(args: string[] | undefined): "stdio" | "websocket" | "unix" | "unknown" {
  if (!args) return "unknown";
  if (args.includes("--stdio") || args.includes("stdio://")) return "stdio";
  if (args.some((arg) => arg.startsWith("ws://") || arg.startsWith("wss://"))) return "websocket";
  if (args.some((arg) => arg.startsWith("unix://"))) return "unix";
  return "unknown";
}

function proxyPresence(env: NodeJS.ProcessEnv | undefined) {
  const has = (...names: string[]) => names.some((name) => Boolean(env?.[name]?.trim()));
  return {
    http: has("HTTP_PROXY", "http_proxy"),
    https: has("HTTPS_PROXY", "https_proxy"),
    all: has("ALL_PROXY", "all_proxy"),
    noProxy: has("NO_PROXY", "no_proxy"),
  };
}

function scrubDiagnosticText(value: string): string {
  const withoutAnsi = value.replace(/\u001B\[[0-9;]*m/gu, "");
  const withoutSecrets = withoutAnsi
    .replace(
      /(authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1$2<redacted>",
    )
    .replace(
      /(authorization|proxy-authorization|cookie|set-cookie)(\s+)([^\s,;}]+)/gi,
      "$1$2<redacted>",
    )
    .replace(/\bcache_path\s*=\s*("[^"]*"|'[^']*'|\S+)/giu, "cache_path=<redacted>")
    .replace(/\betag\s*=\s*("[^"]*"|'[^']*'|\S+)/giu, "etag=<redacted>");
  const withoutQuery = withoutSecrets.replace(/https?:\/\/[^\s"']+/gi, (value) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "<url>";
    }
  });
  return withoutQuery.slice(0, 500);
}

function sanitizedStderrLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      const fields = isRecord(parsed.fields) ? parsed.fields : {};
      const span = isRecord(parsed.span) ? parsed.span : {};
      const safeFields: Record<string, unknown> = {};
      for (const key of [
        "message",
        "method",
        "status",
        "transport",
        "api.path",
        "name",
        "client_version",
        "expected_version",
        "cached_version",
        "fetched_at",
        "cache_ttl_secs",
        "models_count",
      ]) {
        if (fields[key] !== undefined) safeFields[key] = typeof fields[key] === "string"
          ? scrubDiagnosticText(fields[key] as string)
          : fields[key];
      }
      const safeSpan: Record<string, unknown> = {};
      for (const key of ["api.path", "transport", "name", "refresh_strategy"]) {
        if (span[key] !== undefined) safeSpan[key] = span[key];
      }
      return JSON.stringify({
        ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
        ...(typeof parsed.level === "string" ? { level: parsed.level } : {}),
        ...(typeof parsed.target === "string" ? { target: parsed.target } : {}),
        ...(Object.keys(safeFields).length ? { fields: safeFields } : {}),
        ...(Object.keys(safeSpan).length ? { span: safeSpan } : {}),
      }).slice(0, 500);
    }
  } catch {
    // Keep plain-text diagnostics below.
  }
  return scrubDiagnosticText(line);
}

function isUsefulProviderStderr(line: string): boolean {
  return /models cache:|responses_(?:websocket|http)|stream_responses|falling back|reconnect|retry|timeout|failed|error|warn|proxy\(|websocket|transport/i.test(line);
}

function observedProviderTransport(line: string): "responses_websocket" | "responses_http" | null {
  const normalized = line.toLowerCase();
  if (normalized.includes("responses_websocket") || normalized.includes("stream_responses_websocket")) {
    return "responses_websocket";
  }
  if (normalized.includes("responses_http") || normalized.includes("stream_responses_http") || normalized.includes("falling back to http")) {
    return "responses_http";
  }
  return null;
}

type ProviderConnectionStatus = Omit<
  Extract<RuntimeDiagnosticEvent, { type: "provider_connection_status" }>,
  "type" | "sessionId" | "turnId"
>;

function retryProgress(text: string): { attempt?: number; maxAttempts?: number } {
  const matches = [...text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/gu)];
  const match = matches.at(-1);
  if (!match) return {};
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  return Number.isInteger(attempt) && attempt > 0 && Number.isInteger(maxAttempts) && maxAttempts > 0
    ? { attempt, maxAttempts }
    : {};
}

function retrySuffix(progress: { attempt?: number; maxAttempts?: number }) {
  return progress.attempt !== undefined && progress.maxAttempts !== undefined
    ? `（${progress.attempt}/${progress.maxAttempts}）`
    : "";
}

function providerConnectionStatusFromText(
  text: string,
  source: "stderr" | "provider_error" = "stderr",
): ProviderConnectionStatus | null {
  const normalized = text.toLowerCase();
  const progress = retryProgress(text);
  if (/fall(?:ing)?\s+back|fallback|switch(?:ed|ing)?\s+to\s+https?/iu.test(text)) {
    return {
      state: "fallback_https",
      message: "Codex WebSocket 不可用，已切换到 HTTPS",
    };
  }
  const explicitlyWebSocket = /websocket|responses[_-]?ws|\bwss?:\/\//iu.test(text);
  if (source === "stderr" && !explicitlyWebSocket) return null;
  if (/timed?\s*out|timeout/iu.test(text)) {
    return {
      state: "timeout",
      message: source === "provider_error" && !explicitlyWebSocket
        ? `Codex 网络连接超时，正在重试${retrySuffix(progress)}`
        : `Codex WebSocket 连接超时，正在重试${retrySuffix(progress)}`,
      ...progress,
    };
  }
  if (/reconnect|retry|will\s+retry/iu.test(normalized)) {
    return {
      state: "reconnecting",
      message: source === "provider_error" && !explicitlyWebSocket
        ? `Codex 网络连接异常，正在重试${retrySuffix(progress)}`
        : `Codex WebSocket 正在重连${retrySuffix(progress)}`,
      ...progress,
    };
  }
  return null;
}

function providerConnectionStatusFromEvent(event: CodexJsonRpcMessage): ProviderConnectionStatus | null {
  if (method(event) !== "error") return null;
  const payload = params(event);
  if (payload?.willRetry !== true) return null;
  const error = isRecord(payload.error) ? payload.error : {};
  const text = [stringValue(error.message), stringValue(error.additionalDetails)].filter(Boolean).join(" ");
  return providerConnectionStatusFromText(text, "provider_error") ?? {
    state: "reconnecting",
    message: "Codex 网络连接异常，正在重试",
  };
}

function isProviderOutputNotification(event: CodexJsonRpcMessage): boolean {
  const eventMethod = method(event);
  return eventMethod === "item/agentMessage/delta"
    || eventMethod === "item/reasoning/summaryTextDelta"
    || eventMethod === "item/reasoning/textDelta"
    || eventMethod === "item/started"
    || eventMethod === "item/completed"
    || eventMethod === "item/commandExecution/outputDelta";
}

function method(raw: unknown) {
  return isRecord(raw) ? stringValue(raw.method) : "";
}

function params(raw: unknown): Record<string, unknown> | null {
  return isRecord(raw) && isRecord(raw.params) ? raw.params : null;
}

function isResultMessage(raw: unknown) {
  return method(raw) === "turn/completed" || method(raw) === "codex/compact/completed";
}

function resultInfo(raw: unknown): RuntimeResultInfo | null {
  const payload = params(raw);
  if (!payload || !isResultMessage(raw)) return null;
  if (method(raw) === "codex/compact/completed") {
    return { status: "success", isError: false, sessionId: stringValue(payload.threadId) || null };
  }
  const turn = isRecord(payload.turn) ? payload.turn : {};
  const status = stringValue(turn.status, "unknown");
  return {
    status: status === "completed" ? "success" : status,
    isError: status !== "completed",
    sessionId: stringValue(payload.threadId) || null,
  };
}

function contextUsageFromTokenUsage(raw: unknown): ContextUsageSnapshot {
  const payload = params(raw);
  const usage = isRecord(payload?.tokenUsage) ? payload.tokenUsage : {};
  const total = isRecord(usage.total) ? usage.total : {};
  const last = isRecord(usage.last) ? usage.last : total;
  const maxTokens = numberValue(usage.modelContextWindow);
  const configuredContextWindow = isRecord(raw)
    ? numberValue(raw.__squadflowConfiguredContextWindow)
    : null;
  const totalTokens = numberValue(last.totalTokens);
  const inputTokens = numberValue(last.inputTokens);
  const reportedCachedInputTokens = numberValue(last.cachedInputTokens);
  const cachedInputTokens = reportedCachedInputTokens !== null && reportedCachedInputTokens >= 0
    ? reportedCachedInputTokens
    : null;
  return {
    ...liveContextUsageToSnapshot({
      totalTokens,
      maxTokens,
      rawMaxTokens: configuredContextWindow !== null && (maxTokens === null || configuredContextWindow >= maxTokens)
        ? configuredContextWindow
        : maxTokens,
      percentage: totalTokens !== null && maxTokens ? (totalTokens / maxTokens) * 100 : null,
      categories: [],
    }),
    compacted: isRecord(raw) && raw.__squadflowCompacted === true,
    cacheInputTokens: inputTokens,
    cacheReadInputTokens: cachedInputTokens,
    cacheCreationInputTokens: null,
    cacheHitRate: inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
      ? (cachedInputTokens / inputTokens) * 100
      : null,
  };
}

function compactedTokenSnapshot(totalTokens: number, previous: RuntimePreviousContextUsage | undefined): ContextUsageSnapshot {
  const maxTokens = previous?.maxTokens ?? previous?.rawMaxTokens ?? null;
  return {
    totalTokens,
    maxTokens,
    rawMaxTokens: previous?.rawMaxTokens ?? maxTokens,
    percentage: maxTokens ? (totalTokens / maxTokens) * 100 : null,
    model: previous?.model ?? null,
    categories: [],
    cacheInputTokens: previous?.cacheInputTokens ?? null,
    cacheReadInputTokens: previous?.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? null,
    cacheHitRate: previous?.cacheHitRate ?? null,
    observedAt: new Date().toISOString(),
    compacted: true,
  };
}

function compactBoundarySnapshot(raw: unknown, previous: RuntimePreviousContextUsage | undefined): ContextUsageSnapshot | null {
  if (method(raw) !== "thread/compacted") return null;
  const payload = params(raw);
  const postTokens = numberValue(payload?.postTokens) ?? numberValue(payload?.post_tokens);
  return postTokens === null ? null : compactedTokenSnapshot(postTokens, previous);
}

function classifyEvent(raw: unknown, previous: RuntimePreviousContextUsage | undefined): RuntimeEvent {
  const boundary = compactBoundarySnapshot(raw, previous);
  if (boundary) return { type: "compact_boundary", snapshot: boundary, raw };
  const result = resultInfo(raw);
  if (result) return { type: "turn_completed", result, raw };
  return { type: "other", raw };
}

class CodexRuntimeQuery implements RuntimeRawQueryLike {
  private readonly client: CodexAppServerTransport;
  private readonly transport: "stdio" | "websocket" | "unix" | "unknown";
  private readonly proxy: ReturnType<typeof proxyPresence>;
  private closed = false;
  private latestUsage: unknown = null;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private compactedInCurrentTurn = false;
  private readonly pendingInputs: CodexRuntimeInput[] = [];
  private readonly reportedForeignNotifications = new Set<string>();
  private readonly threadReady: Promise<string | null>;
  private resolveThreadReady!: (threadId: string | null) => void;
  private mcpServerStatusPromise: Promise<unknown> | null = null;
  private mcpServerStatusObserver: ((value: unknown) => void) | null = null;
  private readonly refreshedMcpToolCallIds = new Set<string>();
  private lastConnectionStatusKey = "";
  private observedProviderWebsocket = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly input: AsyncIterable<unknown>,
    private readonly options: CodexQueryOptions,
    clientFactory: CodexClientFactory,
  ) {
    this.threadReady = new Promise((resolve) => {
      this.resolveThreadReady = resolve;
    });
    this.proxy = proxyPresence(options.env);
    const clientOptions: CodexAppServerClientOptions = {
      command: options.appServerCommand,
      args: codexAppServerArgs(options),
      env: options.env,
      cwd: options.cwd,
      ...options.clientOptions,
    };
    this.transport = appServerTransport(clientOptions.args);
    const existingStderrHandler = clientOptions.onStderrLine;
    clientOptions.onStderrLine = (line) => {
      existingStderrHandler?.(line);
      const sanitized = sanitizedStderrLine(line);
      const transport = observedProviderTransport(line);
      if (isUsefulProviderStderr(line)) {
        this.options.diagnostics?.({
          type: "provider_stderr",
          message: sanitized,
          sessionId: this.currentThreadId,
          turnId: this.currentTurnId,
        });
      }
      if (transport) {
        if (transport === "responses_websocket") this.observedProviderWebsocket = true;
        this.options.diagnostics?.({
          type: "provider_transport_observed",
          transport,
          message: sanitized,
          sessionId: this.currentThreadId,
          turnId: this.currentTurnId,
        });
        if (transport === "responses_http" && this.observedProviderWebsocket) {
          this.emitConnectionStatus({
            state: "fallback_https",
            message: "Codex WebSocket 不可用，已切换到 HTTPS",
          });
        }
      }
      const connectionStatus = providerConnectionStatusFromText(line);
      if (connectionStatus) this.emitConnectionStatus(connectionStatus);
    };
    this.client = clientFactory(clientOptions);
  }

  private emitTransportStage(
    stage: "client_ready" | "thread_ready" | "turn_ack" | "first_notification" | "first_output" | "turn_completed",
    startedAt: number,
    details: { sessionId?: string | null; turnId?: string | null; method?: string; sinceTurnStartMs?: number; proxy?: boolean },
  ) {
    this.options.diagnostics?.({
      type: "provider_transport_stage",
      stage,
      transport: this.transport,
      modelProvider: this.options.modelProvider || undefined,
      model: this.options.model || undefined,
      runtimeProfile: this.options.runtimeProfile.id,
      sessionId: details.sessionId ?? this.currentThreadId,
      turnId: details.turnId ?? this.currentTurnId,
      ...(details.method ? { method: details.method } : {}),
      durationMs: Math.round(performance.now() - startedAt),
      ...(details.sinceTurnStartMs !== undefined ? { sinceTurnStartMs: Math.round(details.sinceTurnStartMs) } : {}),
      ...(details.proxy ? { proxy: this.proxy } : {}),
    });
    if (stage === "first_output" || stage === "turn_completed") {
      this.emitConnectionStatus({ state: "clear" });
    }
  }

  private emitConnectionStatus(status: ProviderConnectionStatus) {
    const key = JSON.stringify(status);
    if (key === this.lastConnectionStatusKey) return;
    this.lastConnectionStatusKey = key;
    this.options.diagnostics?.({
      type: "provider_connection_status",
      ...status,
      sessionId: this.currentThreadId,
      turnId: this.currentTurnId,
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.resolveThreadReady(null);
    const threadId = this.currentThreadId;
    const turnId = this.currentTurnId;
    if (threadId && turnId) {
      const interrupt = this.client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      const timeout = new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, 3000);
        handle.unref?.();
      });
      this.closePromise = Promise.race([interrupt, timeout]).then(() => {
        this.currentTurnId = null;
        this.client.close();
      });
      return this.closePromise;
    }
    this.client.close();
    this.closePromise = Promise.resolve();
    return this.closePromise;
  }

  async getContextUsage() {
    if (this.latestUsage) return this.latestUsage;
    throw new Error("Codex context usage is not available yet");
  }

  async getMcpServerStatus() {
    const threadId = this.currentThreadId ?? await this.threadReady;
    if (!threadId) throw new Error("Codex MCP server status is unavailable before thread initialization");
    if (!this.mcpServerStatusPromise) {
      this.mcpServerStatusPromise = this.refreshMcpServerStatus(threadId);
    }
    return this.mcpServerStatusPromise;
  }

  setMcpServerStatusObserver(observer: ((value: unknown) => void) | undefined) {
    this.mcpServerStatusObserver = observer ?? null;
  }

  /**
   * True while injected text input is still awaiting delivery: a mid-turn steer
   * failed and fell back to `pendingInputs`, so this `turn/completed` is not the
   * completion of the logical round — the queued input starts a follow-up turn.
   */
  hasPendingTextInputs() {
    return this.pendingInputs.some((input) => input.type === "text");
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    const clientStartedAt = performance.now();
    await this.client.start();
    this.emitTransportStage("client_ready", clientStartedAt, { sessionId: null, turnId: null, proxy: true });
    const inputCursor = new InputCursor(this.input[Symbol.asyncIterator]());
    const notifications = new InputCursor(this.client.notifications()[Symbol.asyncIterator]());
    const first = await inputCursor.next();
    if (first.done) {
      this.resolveThreadReady(null);
      return;
    }
    const firstInput = first.value as CodexRuntimeInput;
    const threadId = await this.startOrResumeThread();
    this.currentThreadId = threadId;
    this.resolveThreadReady(threadId);
    if (firstInput.type === "compact") {
      yield* this.compact(threadId, notifications);
      return;
    }
    yield* this.runTurn(threadId, firstInput, inputCursor, notifications);

    while (!this.closed) {
      const next = await this.nextQueuedOrStreamInput(inputCursor);
      if (next.done) return;
      const input = next.value;
      if (input.type === "compact") {
        yield* this.compact(threadId, notifications);
        continue;
      }
      yield* this.runTurn(threadId, input, inputCursor, notifications);
    }
  }

  private async nextQueuedOrStreamInput(
    inputCursor: InputCursor<unknown>,
  ): Promise<{ done: true } | { done: false; value: CodexRuntimeInput }> {
    if (this.pendingInputs.length > 0) return { done: false, value: this.pendingInputs.shift()! };
    const next = await inputCursor.next();
    return next.done ? { done: true } : { done: false, value: next.value as CodexRuntimeInput };
  }

  private async listMcpServerStatus(threadId: string): Promise<unknown> {
    const data: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const result = await this.client.request("mcpServerStatus/list", {
        threadId,
        cursor,
        limit: 100,
        detail: "toolsAndAuthOnly",
      });
      if (!isRecord(result)) return result;
      if (Array.isArray(result.data)) data.push(...result.data);
      const nextCursor = stringValue(result.nextCursor).trim();
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    return { data };
  }

  private async refreshMcpServerStatus(threadId: string): Promise<unknown> {
    const status = await this.listMcpServerStatus(threadId);
    this.mcpServerStatusObserver?.(status);
    return status;
  }

  private async refreshMcpServerStatusForToolEvent(
    event: CodexJsonRpcMessage,
    threadId: string,
  ) {
    const toolCallId = mcpToolCallId(event);
    if (!toolCallId || this.refreshedMcpToolCallIds.has(toolCallId)) return;
    this.refreshedMcpToolCallIds.add(toolCallId);
    try {
      // A newly-created thread can report MCP inventory before a stdio/HTTP
      // server has finished initialize. Once an actual MCP item arrives, that
      // server is ready, so a fresh status query is the authoritative place to
      // obtain its optional MCP-standard `serverInfo.icons` metadata.
      await this.refreshMcpServerStatus(threadId);
    } catch {
      // Icon metadata never participates in tool execution or turn success.
    }
  }

  private async startOrResumeThread(): Promise<string> {
    const params = {
      model: this.options.model || null,
      modelProvider: this.options.modelProvider || null,
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      sandbox: this.options.sandboxMode,
      config: this.options.config,
      developerInstructions: this.options.systemPrompt,
      ephemeral: this.options.ephemeral === true,
    };
    const threadStartedAt = performance.now();
    if (this.options.resume) {
      const result = await this.client.request("thread/resume", { threadId: this.options.resume, ...params });
      const sessionId = threadIdFromResult(result);
      this.emitTransportStage("thread_ready", threadStartedAt, { sessionId, turnId: null });
      this.options.diagnostics?.({
        type: "thread_established",
        operation: "resume",
        requestedSessionId: this.options.resume,
        sessionId,
      });
      return sessionId;
    }
    const result = await this.client.request("thread/start", params);
    const sessionId = threadIdFromResult(result);
    this.emitTransportStage("thread_ready", threadStartedAt, { sessionId, turnId: null });
    this.options.diagnostics?.({
      type: "thread_established",
      operation: "start",
      requestedSessionId: null,
      sessionId,
    });
    return sessionId;
  }

  private async *runTurn(
    threadId: string,
    input: CodexRuntimeInput,
    inputCursor: InputCursor<unknown>,
    notifications: InputCursor<CodexJsonRpcMessage>,
  ): AsyncIterable<unknown> {
    this.compactedInCurrentTurn = false;
    this.emitConnectionStatus({ state: "clear" });
    const turnAckStartedAt = performance.now();
    const started = await this.client.request("turn/start", {
      threadId,
      input: userInput(input),
      cwd: this.options.cwd,
      model: this.options.model || null,
      ...(this.options.ephemeral === true ? { effort: "none" } : {}),
    });
    const turnId = turnIdFromResult(started);
    this.currentTurnId = turnId;
    this.emitTransportStage("turn_ack", turnAckStartedAt, { sessionId: threadId, turnId });
    this.options.diagnostics?.({ type: "provider_turn_started", sessionId: threadId, turnId });
    const turnStartedAt = performance.now();
    try {
      yield* this.consumeUntilTurnCompleted(threadId, turnId, notifications, inputCursor, turnStartedAt);
    } finally {
      if (this.currentTurnId === turnId) this.currentTurnId = null;
    }
  }

  private async *compact(threadId: string, notifications: InputCursor<CodexJsonRpcMessage>): AsyncIterable<unknown> {
    await this.client.request("thread/compact/start", { threadId });
    yield* this.consumeUntilCompactCompleted(threadId, notifications);
  }

  private async *consumeUntilTurnCompleted(
    threadId: string,
    turnId: string,
    notifications: InputCursor<CodexJsonRpcMessage>,
    inputCursor: InputCursor<unknown>,
    turnStartedAt: number,
  ): AsyncIterable<unknown> {
    let inputOpen = true;
    let firstNotificationObserved = false;
    let firstOutputObserved = false;
    while (!this.closed) {
      const nextEvent = notifications.peek().then((result) => ({ kind: "event" as const, result }));
      const nextInput = inputOpen
        ? inputCursor.peek().then((result) => ({ kind: "input" as const, result }))
        : null;
      const next = await (nextInput ? Promise.race([nextEvent, nextInput]) : nextEvent);
      if (next.kind === "input") {
        const inputResult = await inputCursor.next();
        if (inputResult.done) {
          inputOpen = false;
          continue;
        }
        const input = inputResult.value as CodexRuntimeInput;
        if (input.type !== "text") {
          this.pendingInputs.push(input);
          continue;
        }
        try {
          await this.client.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: userInput(input),
          });
        } catch {
          this.pendingInputs.push(input);
        }
        continue;
      }
      const eventResult = await notifications.next();
      if (eventResult.done) return;
      const event = eventResult.value;
      if (this.closed) return;
      if (this.observeThreadNotification(event, threadId, turnId)) continue;
      const connectionStatus = providerConnectionStatusFromEvent(event);
      if (connectionStatus) this.emitConnectionStatus(connectionStatus);
      if (!firstNotificationObserved) {
        firstNotificationObserved = true;
        this.emitTransportStage("first_notification", turnStartedAt, {
          sessionId: threadId,
          turnId,
          method: method(event) || "unknown",
          sinceTurnStartMs: performance.now() - turnStartedAt,
        });
      }
      if (!firstOutputObserved && isProviderOutputNotification(event)) {
        firstOutputObserved = true;
        this.emitTransportStage("first_output", turnStartedAt, {
          sessionId: threadId,
          turnId,
          method: method(event) || "unknown",
          sinceTurnStartMs: performance.now() - turnStartedAt,
        });
      }
      if (isContextCompactionEvent(event)) this.compactedInCurrentTurn = true;
      if (method(event) === "thread/tokenUsage/updated") {
        this.latestUsage = {
          ...event,
          __squadflowCompacted: this.compactedInCurrentTurn,
          __squadflowConfiguredContextWindow: numberValue(this.options.config.model_context_window),
        };
      }
      if (isServerRequest(event)) {
        await this.answerServerRequest(event);
        continue;
      }
      // MCP server icon discovery is intentionally disabled. Do not query
      // mcpServerStatus/list on the tool-event path: it is optional UI metadata
      // and can block the actual MCP tool call while remote servers initialize.
      const completedTurn = method(event) === "turn/completed"
        && stringValue(params(event)?.threadId) === threadId;
      const eventTurn = completedTurn && isRecord(params(event)?.turn)
        ? params(event)?.turn as Record<string, unknown>
        : {};
      const observedTurnId = stringValue(params(event)?.turnId) || stringValue(eventTurn.id);
      const isCurrentCompletedTurn = completedTurn
        && (!turnId || !observedTurnId || observedTurnId === turnId);
      // The event is yielded before the generator resumes. Clear this state
      // first so an upper-layer normal-completion close cannot mistake the
      // already-finished turn for an active one and send turn/interrupt.
      if (isCurrentCompletedTurn && this.currentTurnId === turnId) this.currentTurnId = null;
      yield event;
      if (isCurrentCompletedTurn) {
        this.emitTransportStage("turn_completed", turnStartedAt, {
          sessionId: threadId,
          turnId,
          method: "turn/completed",
          sinceTurnStartMs: performance.now() - turnStartedAt,
        });
        this.options.diagnostics?.({
          type: "provider_turn_completed",
          sessionId: threadId,
          turnId,
          status: stringValue(eventTurn.status, "unknown"),
        });
        return;
      }
    }
  }

  private async *consumeUntilCompactCompleted(
    threadId: string,
    notifications: InputCursor<CodexJsonRpcMessage>,
  ): AsyncIterable<unknown> {
    while (!this.closed) {
      const next = await notifications.next();
      if (next.done) return;
      const event = next.value;
      if (this.observeThreadNotification(event, threadId, null)) continue;
      if (isContextCompactionEvent(event)) this.compactedInCurrentTurn = true;
      if (method(event) === "thread/tokenUsage/updated") {
        this.latestUsage = {
          ...event,
          __squadflowCompacted: this.compactedInCurrentTurn,
          __squadflowConfiguredContextWindow: numberValue(this.options.config.model_context_window),
        };
      }
      if (isServerRequest(event)) {
        await this.answerServerRequest(event);
        continue;
      }
      yield event;
      if (method(event) === "turn/completed" && stringValue(params(event)?.threadId) === threadId) return;
      if (method(event) === "thread/compacted" && stringValue(params(event)?.threadId) === threadId) return;
    }
  }

  private observeThreadNotification(
    event: CodexJsonRpcMessage,
    expectedSessionId: string,
    turnId: string | null,
  ): boolean {
    const observedSessionId = stringValue(params(event)?.threadId);
    const eventTurn = isRecord(params(event)?.turn) ? params(event)?.turn as Record<string, unknown> : {};
    const observedTurnId = stringValue(params(event)?.turnId) || stringValue(eventTurn.id);
    const foreignSession = Boolean(observedSessionId && observedSessionId !== expectedSessionId);
    const foreignTurn = Boolean(turnId && observedTurnId && observedTurnId !== turnId);
    if (!foreignSession && !foreignTurn) return false;
    const eventMethod = method(event) || "unknown";
    const key = `${eventMethod}\u0000${expectedSessionId}\u0000${observedSessionId || expectedSessionId}\u0000${turnId ?? ""}\u0000${observedTurnId}`;
    if (this.reportedForeignNotifications.has(key)) return true;
    this.reportedForeignNotifications.add(key);
    this.options.diagnostics?.({
      type: "foreign_thread_notification",
      method: eventMethod,
      expectedSessionId,
      observedSessionId: observedSessionId || expectedSessionId,
      turnId,
    });
    return true;
  }

  private async answerServerRequest(event: CodexJsonRpcMessage) {
    const id = requestId(event.id);
    if (id === null) return;
    const eventMethod = method(event);
    const eventParams = params(event) ?? {};
    if (eventMethod === "item/commandExecution/requestApproval") {
      if (requestsAdditionalPermissions(eventParams)) {
        this.client.respond(id, { decision: "decline" });
        return;
      }
      const command = commandFromApprovalParams(eventParams);
      if (!command) {
        this.client.respond(id, { decision: "decline" });
        return;
      }
      const result = await this.checkPermission({
        capability: "shell",
        providerToolName: "commandExecution",
        input: {
          command,
          path: stringValue(eventParams.cwd, this.options.cwd),
        },
        providerInput: eventParams,
        context: { toolUseId: stringValue(eventParams.itemId) || null },
      });
      this.client.respond(id, {
        decision: result.behavior === "allow" ? "accept" : "decline",
      });
    } else if (eventMethod === "item/fileChange/requestApproval") {
      const result = await this.checkPermission({
        capability: "write",
        providerToolName: "fileChange",
        input: { path: stringValue(eventParams.grantRoot, this.options.cwd) },
        providerInput: eventParams,
        context: { toolUseId: stringValue(eventParams.itemId) || null },
      });
      this.client.respond(id, { decision: result.behavior === "allow" ? "accept" : "decline" });
    } else if (eventMethod === "mcpServer/elicitation/request" && this.options.runtimeProfile.mcpApprovalProtocol === "elicitation-action") {
      const toolName = mcpToolNameFromElicitation(eventParams);
      const result = await this.checkPermission({
        capability: null,
        providerToolName: toolName,
        input: mcpToolInputFromElicitation(eventParams),
        providerInput: eventParams,
        context: { toolUseId: null },
      });
      this.client.respond(id, {
        action: result.behavior === "allow" ? "accept" : "decline",
        content: result.behavior === "allow" ? {} : null,
      });
    } else {
      this.client.respond(id, { decision: "cancel" });
    }
  }

  private async checkPermission(request: Parameters<NonNullable<CodexRuntimeOptions["canUseTool"]>>[0]) {
    return this.options.canUseTool ? this.options.canUseTool(request) : { behavior: "allow" as const };
  }
}

function isServerRequest(event: CodexJsonRpcMessage) {
  return requestId(event.id) !== null && typeof event.method === "string";
}

function isContextCompactionEvent(event: unknown) {
  if (method(event) === "thread/compacted") return true;
  if (method(event) !== "item/started" && method(event) !== "item/completed") return false;
  const payload = params(event);
  const item = isRecord(payload?.item) ? payload.item : {};
  return stringValue(item.type) === "contextCompaction";
}

function mcpToolCallId(event: CodexJsonRpcMessage): string | null {
  const eventMethod = method(event);
  if (eventMethod !== "item/started" && eventMethod !== "item/completed") return null;
  const item = params(event)?.item;
  if (!isRecord(item) || stringValue(item["type"]) !== "mcpToolCall") return null;
  return stringValue(item["id"]).trim() || null;
}

function requestId(value: unknown): string | number | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function commandFromApprovalParams(eventParams: Record<string, unknown>): string | null {
  const direct = stringValue(eventParams.command).trim();
  if (direct) return direct;

  if (!Array.isArray(eventParams.commandActions) || eventParams.commandActions.length === 0) return null;
  const commands: string[] = [];
  for (const action of eventParams.commandActions) {
    if (!isRecord(action)) return null;
    const command = stringValue(action.command).trim();
    if (!command) return null;
    commands.push(command);
  }
  return commands.join(" ; ");
}

function requestsAdditionalPermissions(eventParams: Record<string, unknown>): boolean {
  return eventParams.additionalPermissions != null || eventParams.additional_permissions != null;
}

function threadIdFromResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const thread = isRecord(record.thread) ? record.thread : {};
  const threadId = stringValue(thread.id);
  if (!threadId) throw new Error("Codex app-server did not return a thread id");
  return threadId;
}

function turnIdFromResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const turn = isRecord(record.turn) ? record.turn : {};
  const turnId = stringValue(turn.id);
  if (!turnId) throw new Error("Codex app-server did not return a turn id");
  return turnId;
}

function mcpToolNameFromElicitation(eventParams: Record<string, unknown>) {
  const serverName = stringValue(eventParams.serverName);
  const message = stringValue(eventParams.message);
  const tool = /tool\s+"([^"]+)"/u.exec(message)?.[1] ?? "";
  return serverName && tool ? `mcp__${serverName}__${tool}` : `mcp__${serverName}`;
}

function mcpToolInputFromElicitation(eventParams: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(eventParams._meta) ? eventParams._meta : {};
  return isRecord(meta.tool_params) ? meta.tool_params : {};
}

function createOutputAdapter(
  messageId: string,
  metadata?: { startedAt?: string; mcpServerIcons?: McpServerIconRegistry } | unknown,
): RuntimeOutputAdapter {
  const adapter = createCodexToUiChunkAdapter(messageId, metadata);
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

export function createCodexAgentRuntimeAdapter(input: {
  clientFactory?: CodexClientFactory;
  runtimeConfig?: RuntimeConfig;
} = {}): AgentRuntimeAdapter {
  const clientFactory = input.clientFactory ?? ((options) => new CodexAppServerClient(options));
  return {
    sdk: "codex",
    capabilities: {
      steer: true,
      compact: true,
      historyRead: true,
      imageInput: true,
      tokenUsage: true,
      toolApproval: true,
    },
    buildLeaderOptions: buildCodexLeaderOptions,
    buildExpertOptions: buildCodexExpertOptions,
    prepareLeaderMcpServer: async ({ server, serverFactory, bindingKey, bridgeRegistry }) => {
      if (!bridgeRegistry) throw new Error("Codex Leader requires a standard MCP bridge registry");
      const bridge = await bridgeRegistry.register(server, "leader", {
        ...(bindingKey ? { stableKey: bindingKey } : {}),
        ...(serverFactory ? { createServer: serverFactory } : {}),
      });
      return {
        mcpServerConfig: {
          type: "http",
          name: "squadflow-leader",
          url: bridge.url,
          bearerToken: bridge.bearerToken,
          bearerTokenEnvVar: bridge.bearerTokenEnvVar,
        },
        close: bridge.close,
      };
    },
    prepareExpertMcpServer: async ({ serverName, server, serverFactory, bindingKey, bridgeRegistry }) => {
      if (!bridgeRegistry) throw new Error("Codex Expert requires a standard MCP bridge registry");
      const bridge = await bridgeRegistry.register(server, serverName, {
        ...(bindingKey ? { stableKey: bindingKey } : {}),
        ...(serverFactory ? { createServer: serverFactory } : {}),
      });
      return {
        mcpServerConfig: {
          type: "http",
          name: serverName,
          url: bridge.url,
          bearerToken: bridge.bearerToken,
          bearerTokenEnvVar: bridge.bearerTokenEnvVar,
        },
        close: bridge.close,
      };
    },
    createInputQueue: () => new AsyncMessageQueue<unknown>(),
    createLeaderUserMessage: leaderUserMessage as AgentRuntimeAdapter["createLeaderUserMessage"],
    createLeaderGuideMessage: leaderGuideMessage as AgentRuntimeAdapter["createLeaderGuideMessage"],
    createLeaderFlowNameMessage: leaderFlowNameMessage as AgentRuntimeAdapter["createLeaderFlowNameMessage"],
    createSingleTextInput: singleTextInput as AgentRuntimeAdapter["createSingleTextInput"],
    createExpertUserMessage: expertUserMessage as AgentRuntimeAdapter["createExpertUserMessage"],
    createExpertGuideMessage: expertGuideMessage as AgentRuntimeAdapter["createExpertGuideMessage"],
    createOutputAdapter,
    runQuery: (queryInput: RuntimeQueryInput) => {
      const query = new CodexRuntimeQuery(queryInput.prompt as AsyncIterable<unknown>, queryInput.options as CodexQueryOptions, clientFactory);
      return normalizeRuntimeQuery(
        query,
        (raw, previous) => {
          const event = classifyEvent(raw, previous);
          // Steer-fallback race: the turn completed but the injected input is still
          // queued for a follow-up turn, so this is not the real completion yet.
          if (event.type === "turn_completed" && query.hasPendingTextInputs()) {
            return { type: "turn_absorbed", reason: "injection_pending", result: event.result, raw };
          }
          return event;
        },
        queryInput.previousContextUsage,
      );
    },
    compactedTokenSnapshot,
    contextUsageSnapshot: contextUsageFromTokenUsage,
    compactContextInput: async function* () { yield { type: "compact" }; } as AgentRuntimeAdapter["compactContextInput"],
    loadSessionHistory: (sessionId, flowId) => getRawCodexSessionHistory(sessionId, flowId, input.runtimeConfig),
    latestCompactTranscriptMetadata: (sessionId) => getLatestCodexCompactTranscriptMetadata(sessionId, input.runtimeConfig),
  };
}

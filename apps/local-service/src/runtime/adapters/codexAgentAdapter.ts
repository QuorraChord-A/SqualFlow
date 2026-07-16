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
  type LeaderPlanFeedback,
  type LeaderTurnInput,
} from "../leaderPrompt.js";
import { AsyncMessageQueue } from "./asyncMessageQueue.js";
import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexAppServerTransport, type CodexJsonRpcMessage } from "./codexAppServerClient.js";
import {
  getLatestCodexCompactTranscriptMetadata,
  getRawCodexSessionHistory,
} from "./codexSessionHistory.js";
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
): CodexRuntimeInput {
  return {
    type: "text",
    text: buildLeaderGuidePrompt({ flowId, content, attachments, planFeedback }),
    flowId,
    attachments,
    attachmentPlacement: "trailing",
  };
}

async function* singleTextInput(text: string): AsyncIterable<CodexRuntimeInput> {
  yield textInput(text);
}

function expertUserMessage(content: string): CodexRuntimeInput {
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
  private closed = false;
  private latestUsage: unknown = null;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private compactedInCurrentTurn = false;
  private readonly pendingInputs: CodexRuntimeInput[] = [];
  private readonly reportedForeignNotifications = new Set<string>();

  constructor(
    private readonly input: AsyncIterable<unknown>,
    private readonly options: CodexQueryOptions,
    clientFactory: CodexClientFactory,
  ) {
    this.client = clientFactory({
      command: options.appServerCommand,
      args: codexAppServerArgs(options),
      env: options.env,
      cwd: options.cwd,
      ...options.clientOptions,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const threadId = this.currentThreadId;
    const turnId = this.currentTurnId;
    if (threadId && turnId) {
      const interrupt = this.client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      const timeout = new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, 3000);
        handle.unref?.();
      });
      void Promise.race([interrupt, timeout]).finally(() => this.client.close());
      return;
    }
    this.client.close();
  }

  async getContextUsage() {
    if (this.latestUsage) return this.latestUsage;
    throw new Error("Codex context usage is not available yet");
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    await this.client.start();
    const inputCursor = new InputCursor(this.input[Symbol.asyncIterator]());
    const notifications = new InputCursor(this.client.notifications()[Symbol.asyncIterator]());
    const first = await inputCursor.next();
    if (first.done) return;
    const firstInput = first.value as CodexRuntimeInput;
    const threadId = await this.startOrResumeThread();
    this.currentThreadId = threadId;
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

  private async startOrResumeThread(): Promise<string> {
    const params = {
      model: this.options.model || null,
      modelProvider: this.options.modelProvider || null,
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      sandbox: this.options.sandboxMode,
      config: this.options.config,
      baseInstructions: this.options.systemPrompt,
      developerInstructions: this.options.systemPrompt,
      ephemeral: false,
    };
    if (this.options.resume) {
      const result = await this.client.request("thread/resume", { threadId: this.options.resume, ...params });
      const sessionId = threadIdFromResult(result);
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
    const started = await this.client.request("turn/start", {
      threadId,
      input: userInput(input),
      cwd: this.options.cwd,
      model: this.options.model || null,
    });
    const turnId = turnIdFromResult(started);
    this.currentTurnId = turnId;
    this.options.diagnostics?.({ type: "provider_turn_started", sessionId: threadId, turnId });
    try {
      yield* this.consumeUntilTurnCompleted(threadId, turnId, notifications, inputCursor);
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
  ): AsyncIterable<unknown> {
    let inputOpen = true;
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
      this.observeThreadNotification(event, threadId, turnId);
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
      if (method(event) === "turn/completed" && stringValue(params(event)?.threadId) === threadId) {
        const eventTurn = isRecord(params(event)?.turn) ? params(event)?.turn as Record<string, unknown> : {};
        if (!turnId || stringValue(eventTurn.id) === turnId) {
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
  }

  private async *consumeUntilCompactCompleted(
    threadId: string,
    notifications: InputCursor<CodexJsonRpcMessage>,
  ): AsyncIterable<unknown> {
    while (!this.closed) {
      const next = await notifications.next();
      if (next.done) return;
      const event = next.value;
      this.observeThreadNotification(event, threadId, null);
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

  private observeThreadNotification(event: CodexJsonRpcMessage, expectedSessionId: string, turnId: string | null) {
    const observedSessionId = stringValue(params(event)?.threadId);
    if (!observedSessionId || observedSessionId === expectedSessionId) return;
    const eventMethod = method(event) || "unknown";
    const key = `${eventMethod}\u0000${expectedSessionId}\u0000${observedSessionId}\u0000${turnId ?? ""}`;
    if (this.reportedForeignNotifications.has(key)) return;
    this.reportedForeignNotifications.add(key);
    this.options.diagnostics?.({
      type: "foreign_thread_notification",
      method: eventMethod,
      expectedSessionId,
      observedSessionId,
      turnId,
    });
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

function createOutputAdapter(messageId: string, metadata?: { startedAt?: string } | unknown): RuntimeOutputAdapter {
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
    get finalAssistantText() {
      return adapter.finalAssistantText;
    },
    get durationMs() {
      return adapter.durationMs;
    },
    get resultCacheUsage() {
      return adapter.resultCacheUsage;
    },
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
    prepareLeaderMcpServer: async ({ server, bridgeRegistry }) => {
      if (!bridgeRegistry) throw new Error("Codex Leader requires a standard MCP bridge registry");
      const bridge = await bridgeRegistry.register(server, "leader");
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
    prepareExpertMcpServer: async ({ server, bridgeRegistry }) => {
      if (!bridgeRegistry) throw new Error("Codex Expert requires a standard MCP bridge registry");
      const bridge = await bridgeRegistry.register(server, "browser");
      return {
        mcpServerConfig: {
          type: "http",
          name: "squadflow-browser",
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
    createSingleTextInput: singleTextInput as AgentRuntimeAdapter["createSingleTextInput"],
    createExpertUserMessage: expertUserMessage as AgentRuntimeAdapter["createExpertUserMessage"],
    createOutputAdapter,
    runQuery: (queryInput: RuntimeQueryInput) => normalizeRuntimeQuery(
      new CodexRuntimeQuery(queryInput.prompt as AsyncIterable<unknown>, queryInput.options as CodexQueryOptions, clientFactory),
      classifyEvent,
      queryInput.previousContextUsage,
    ),
    compactedTokenSnapshot,
    contextUsageSnapshot: contextUsageFromTokenUsage,
    compactContextInput: async function* () { yield { type: "compact" }; } as AgentRuntimeAdapter["compactContextInput"],
    loadSessionHistory: (sessionId, flowId) => getRawCodexSessionHistory(sessionId, flowId, input.runtimeConfig),
    latestCompactTranscriptMetadata: (sessionId) => getLatestCodexCompactTranscriptMetadata(sessionId, input.runtimeConfig),
  };
}

import type { AgentRuntimeRole, RuntimeConfig, RuntimeSdk } from "../../config/agentRuntimeConfig.js";
import type { ContextCacheUsage, ContextUsageSnapshot } from "../../domain/contextUsage.js";
import type { PermissionResult } from "../../permissions/permissionPolicy.js";
import type { MessageImageAttachment } from "../../protocol/wsMessages.js";
import type { UiMessageChunk } from "../../protocol/uiMessageChunks.js";
import type { ChatUIMessage } from "../../ws/chatJournal.js";
import type { McpBridgeRegistry } from "../../mcp/mcpBridgeRegistry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeCapability, RuntimeToolInput } from "../capabilities.js";
import type { LeaderPlanFeedback, LeaderTurnInput } from "../leaderPrompt.js";
import type { AsyncMessageQueue } from "./asyncMessageQueue.js";
import type { RuntimeAdapterCapabilities, RuntimeEvent } from "../runtimeEvents.js";

export type RuntimeQueryInput = {
  prompt: string | AsyncIterable<unknown>;
  options?: unknown;
  previousContextUsage?: RuntimePreviousContextUsage;
};

export type RuntimeQueryLike = AsyncIterable<RuntimeEvent> & {
  close?: () => void;
  getContextUsage?: () => Promise<unknown>;
};

export type RuntimeQueryFn = (input: RuntimeQueryInput) => RuntimeQueryLike;

export type RuntimeRawQueryLike = AsyncIterable<unknown> & {
  close?: () => void;
  getContextUsage?: () => Promise<unknown>;
};

export type RuntimeToolUseContext = {
  toolUseId: string | null;
};

export type RuntimeToolPermissionRequest = {
  capability: RuntimeCapability | null;
  providerToolName: string;
  input: RuntimeToolInput;
  providerInput: Record<string, unknown>;
  context: RuntimeToolUseContext;
};

export type RuntimeToolPermission = (request: RuntimeToolPermissionRequest) => PermissionResult | Promise<PermissionResult>;

export type RuntimeDiagnosticEvent =
  | {
      type: "provider_transport_stage";
      stage: "client_ready" | "thread_ready" | "turn_ack" | "first_notification" | "first_output" | "turn_completed";
      transport: "stdio" | "websocket" | "unix" | "unknown";
      modelProvider?: string;
      model?: string;
      runtimeProfile?: string;
      sessionId: string | null;
      turnId: string | null;
      method?: string;
      durationMs: number;
      sinceTurnStartMs?: number;
      proxy?: {
        http: boolean;
        https: boolean;
        all: boolean;
        noProxy: boolean;
      };
    }
  | {
      type: "provider_stderr";
      message: string;
      sessionId?: string | null;
      turnId?: string | null;
    }
  | {
      type: "provider_transport_observed";
      transport: "responses_websocket" | "responses_http";
      message: string;
      sessionId?: string | null;
      turnId?: string | null;
    }
  | {
      type: "provider_connection_status";
      state: "reconnecting" | "timeout" | "fallback_https" | "clear";
      message?: string;
      attempt?: number;
      maxAttempts?: number;
      sessionId?: string | null;
      turnId?: string | null;
    }
  | {
      type: "thread_established";
      operation: "start" | "resume";
      requestedSessionId: string | null;
      sessionId: string;
    }
  | {
      type: "foreign_thread_notification";
      method: string;
      expectedSessionId: string;
      observedSessionId: string;
      turnId: string | null;
    }
  | {
      type: "provider_turn_started";
      sessionId: string;
      turnId: string;
    }
  | {
      type: "provider_turn_completed";
      sessionId: string;
      turnId: string;
      status: string;
    };

export type RuntimeDiagnosticSink = (event: RuntimeDiagnosticEvent) => void;

export type RuntimeOutputAdapter = {
  readonly sdkSessionId: string | null;
  readonly resultStatus: string | null;
  readonly resultIsError: boolean | null;
  readonly resultError?: string | null;
  readonly finalAssistantText: string | null;
  readonly durationMs: number | null;
  readonly resultCacheUsage: ContextCacheUsage | null;
  start: () => UiMessageChunk;
  adapt: (event: RuntimeEvent) => UiMessageChunk[];
  finish: () => UiMessageChunk[];
};

export type RuntimeResultInfo = {
  status: string | null;
  isError: boolean;
  sessionId: string | null;
};

export type BuildLeaderRuntimeOptionsInput = {
  role: AgentRuntimeRole;
  systemPrompt: string;
  cwd: string;
  scratchDir?: string;
  capabilities: RuntimeCapability[];
  mcpTools: string[];
  mcpServerConfigs?: Record<string, unknown>;
  canUseTool?: RuntimeToolPermission;
  maxTurns?: number;
  /** Run a one-shot provider request without persisting a resumable session. */
  ephemeral?: boolean;
  resume?: string;
  sessionId?: string;
  runtimeConfig?: RuntimeConfig;
  modelName?: string;
  diagnostics?: RuntimeDiagnosticSink;
};

export type BuildExpertRuntimeOptionsInput = {
  role: AgentRuntimeRole;
  systemPrompt: string;
  cwd: string;
  scratchDir: string;
  capabilities: RuntimeCapability[];
  mcpTools: string[];
  mcpServerConfig?: unknown;
  canUseTool?: RuntimeToolPermission;
  maxTurns?: number;
  resume?: string;
  runtimeConfig?: RuntimeConfig;
  modelName?: string;
  diagnostics?: RuntimeDiagnosticSink;
};

export type CompactTranscriptMetadata = {
  postTokens: number;
  timestamp?: string | null;
};

export type RuntimePreviousContextUsage = {
  maxTokens?: number | null;
  rawMaxTokens?: number | null;
  model?: string | null;
  categoriesJson?: string | null;
  cacheInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheHitRate?: number | null;
};

export type RuntimeLeaderMcpBinding = {
  mcpServerConfig: unknown;
  close: () => Promise<void> | void;
};

export type AgentRuntimeAdapter = {
  sdk: RuntimeSdk;
  capabilities: RuntimeAdapterCapabilities;
  buildLeaderOptions: (input: BuildLeaderRuntimeOptionsInput) => unknown;
  buildExpertOptions: (input: BuildExpertRuntimeOptionsInput) => unknown;
  prepareLeaderMcpServer: (input: {
    server: McpServer;
    serverFactory?: () => McpServer;
    bindingKey?: string;
    bridgeRegistry?: McpBridgeRegistry;
  }) => Promise<RuntimeLeaderMcpBinding>;
  prepareExpertMcpServer: (input: {
    server: McpServer;
    serverFactory?: () => McpServer;
    bindingKey?: string;
    bridgeRegistry?: McpBridgeRegistry;
  }) => Promise<RuntimeLeaderMcpBinding>;
  createInputQueue: () => AsyncMessageQueue<unknown>;
  createLeaderUserMessage: (turn: LeaderTurnInput) => unknown;
  createLeaderGuideMessage: (
    flowId: string,
    content: string,
    attachments?: MessageImageAttachment[],
    planFeedback?: LeaderPlanFeedback[],
  ) => unknown;
  createLeaderFlowNameMessage: (flowId: string) => unknown;
  createSingleTextInput: (text: string) => AsyncIterable<unknown>;
  createExpertUserMessage: (content: string) => unknown;
  createOutputAdapter: (messageId: string, metadata?: { startedAt?: string } | unknown) => RuntimeOutputAdapter;
  runQuery: RuntimeQueryFn;
  compactedTokenSnapshot: (
    totalTokens: number,
    previous: RuntimePreviousContextUsage | undefined,
  ) => ContextUsageSnapshot;
  contextUsageSnapshot: (raw: unknown) => ContextUsageSnapshot;
  compactContextInput: () => AsyncIterable<unknown>;
  loadSessionHistory: (sessionId: string, flowId: string) => Promise<ChatUIMessage[]>;
  latestCompactTranscriptMetadata: (sessionId: string) => Promise<CompactTranscriptMetadata | null>;
};

export function normalizeRuntimeQuery(
  query: RuntimeRawQueryLike,
  classifyEvent: (raw: unknown, previous?: RuntimePreviousContextUsage) => RuntimeEvent,
  previous?: RuntimePreviousContextUsage,
): RuntimeQueryLike {
  return {
    close: query.close ? () => query.close?.() : undefined,
    getContextUsage: query.getContextUsage ? () => query.getContextUsage!() : undefined,
    async *[Symbol.asyncIterator]() {
      for await (const raw of query) {
        yield classifyEvent(raw, previous);
      }
    },
  };
}

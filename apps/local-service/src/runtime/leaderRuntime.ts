import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  legacySessionRuntimeSdk,
  readDefaultFlowRuntimeConfigForSdk,
  readRoleRuntimeConfig,
  readRuntimeConfig,
  resolveRuntimeModelId,
  runtimeConfigModelName,
  runtimeSdkFromValue,
  type RuntimeConfig,
} from "../config/agentRuntimeConfig.js";
import { normalizeRuntimeReasoningEffort } from "../config/runtimeReasoningEffort.js";
import type { MessageImageAttachment } from "../protocol/wsMessages.js";
import type { Store, AgentRunRow, AgentSessionRow } from "../db/store.js";
import { createLeaderMcpServer, createLeaderToolHandlers, type CurrentTurnInput } from "../mcp/leaderServer.js";
import { createBrowserMcpServer, createBrowserToolHandlers } from "../mcp/browserServer.js";
import type { McpBridgeRegistry } from "../mcp/mcpBridgeRegistry.js";
import type { DesktopBridge } from "../server/desktopBridge.js";
import { createStorePort } from "../mcp/storePort.js";
import type { EventBus } from "../ws/eventBus.js";
import type { ChatJournal } from "../ws/chatJournal.js";
import { finishInterruptedTurn, WsPusher } from "../ws/pusher.js";
import type { AgentDispatcher } from "./agentDispatcher.js";
import { ContextCompactionState } from "./contextCompactionState.js";
import { leaderTranscriptChannelId } from "../domain/transcriptChannels.js";
import { createAgentRuntimeAdapter } from "./adapters/factory.js";
import type { AgentRuntimeAdapterFactory } from "./adapters/factory.js";
import type { AgentRuntimeAdapter, RuntimeOutputAdapter, RuntimeQueryLike } from "./adapters/runtimeAdapter.js";
import { hasWriteRuntimeCapability, normalizeRuntimeCapabilities, type RuntimeCapability } from "./capabilities.js";
import {
  currentTurnInputFromTurn,
  type LeaderOrchestrationFeedback,
  type LeaderTurnInput,
} from "./leaderPrompt.js";
import type { ContextUsageSnapshot } from "../domain/contextUsage.js";
import { contextUsageSnapshotToPayload, overallContextUsageFromResultCache } from "../domain/contextUsage.js";
import { checkPermission, type CheckPermissionArgs } from "../permissions/permissionPolicy.js";
import type { RuntimePermissionGate } from "./expertRuntime.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";
import type { AsyncMessageQueue } from "./adapters/asyncMessageQueue.js";
import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { capturePersistentChangeBaseline, changesFromBaseline, type StoredChangeBaseline } from "./changeBaseline.js";
import { ChangeSetToolAttributor, WorkspaceMutationCoordinator } from "./changeSetFileAttribution.js";

export type { LeaderTurnInput } from "./leaderPrompt.js";

export class LeaderInputRejectedError extends Error {
  readonly code = "LEADER_RUN_ACTIVE";
  constructor() {
    super("Leader AgentSession 已有活跃 AgentRun；请排队或使用 Guide。 ");
  }
}

export type LeaderRuntime = {
  runLeaderTurn: (input: LeaderTurnInput) => Promise<void>;
  guideLeaderTurn: (input: {
    flowId: string;
    content: string;
    orchestrationFeedback?: LeaderOrchestrationFeedback[];
    leaderAgentRunId: string;
    messageId?: string;
    attachments?: MessageImageAttachment[];
    beforeDeliver?: () => void;
  }) => Promise<{ accepted: true; messageId: string }>;
  getContextUsage: (flowId: string) => Promise<ContextUsageSnapshot | null>;
  compactContext: (flowId: string) => Promise<ContextUsageSnapshot | null>;
  cancelFlow: (flowId: string) => boolean;
  close?: () => Promise<void>;
};

export type CreateLeaderRuntimeInput = {
  store: Store;
  eventBus: EventBus;
  chatJournal: ChatJournal;
  agentDispatcher: AgentDispatcher;
  contextCompactions?: ContextCompactionState;
  runtimeAdapterFactory?: AgentRuntimeAdapterFactory;
  mcpBridgeRegistry?: McpBridgeRegistry;
  desktopBridge?: DesktopBridge;
  permissionGate?: RuntimePermissionGate;
  mutationCoordinator?: WorkspaceMutationCoordinator;
  logger?: OperationalLogger;
};

type AgentDefinition = NonNullable<ReturnType<Store["getAgentDefinition"]>>;

type LockedRuntimeConfig = {
  config: RuntimeConfig & { reasoningEffort: string };
  runtimeSdk: string;
  runtimeConfigId: string;
  runtimeModelId: string | null;
  runtimeReasoningEffort: string;
};

type ActiveLeader = {
  flowId: string;
  run: AgentRunRow;
  session: AgentSessionRow;
  definition: AgentDefinition;
  runtimeAdapter: AgentRuntimeAdapter;
  inputQueue: AsyncMessageQueue<unknown>;
  query: RuntimeQueryLike | null;
  output: RuntimeOutputAdapter;
  pusher: WsPusher;
  cancelled: boolean;
  endAfterUserAction: boolean;
  closeBindings: Array<() => Promise<void> | void>;
};

function parseToolList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function withEffort(runtimeConfig: RuntimeConfig, value: unknown) {
  const reasoningEffort = normalizeRuntimeReasoningEffort(runtimeConfig.sdk, value);
  return { config: { ...runtimeConfig, reasoningEffort }, reasoningEffort };
}

async function resolveLeaderConfig(session: AgentSessionRow): Promise<LockedRuntimeConfig> {
  const sdk = runtimeSdkFromValue(session.runtimeSdk);
  if (sdk && session.runtimeConfigId) {
    const config = await readRuntimeConfig(session.runtimeConfigId);
    const modelId = config && config.sdk === sdk ? resolveRuntimeModelId(config, session.runtimeModelId) : "";
    if (!config || !modelId) throw new Error(`Leader AgentSession 的运行时配置不可用：${session.id}`);
    const resolved = withEffort(config, session.runtimeReasoningEffort);
    return {
      config: resolved.config,
      runtimeSdk: sdk,
      runtimeConfigId: session.runtimeConfigId,
      runtimeModelId: modelId,
      runtimeReasoningEffort: resolved.reasoningEffort,
    };
  }
  if (session.providerSessionId) {
    const legacy = await readDefaultFlowRuntimeConfigForSdk(legacySessionRuntimeSdk);
    if (!legacy) throw new Error("Leader 续接配置不可用");
    const resolved = withEffort(legacy.config, session.runtimeReasoningEffort);
    return {
      config: resolved.config,
      runtimeSdk: legacy.config.sdk,
      runtimeConfigId: legacy.configId,
      runtimeModelId: legacy.modelId,
      runtimeReasoningEffort: resolved.reasoningEffort,
    };
  }
  const roleConfig = await readRoleRuntimeConfig("leader");
  if (!roleConfig.binding.modelId) throw new Error("Leader 尚未配置模型");
  const resolved = withEffort(roleConfig.config, roleConfig.binding.reasoningEffort);
  return {
    config: resolved.config,
    runtimeSdk: roleConfig.config.sdk,
    runtimeConfigId: roleConfig.config.id,
    runtimeModelId: roleConfig.binding.modelId,
    runtimeReasoningEffort: resolved.reasoningEffort,
  };
}

function runtimeDirs(store: Store, flowId: string) {
  const flow = store.getFlow(flowId);
  const project = flow?.projectId ? store.getProject(flow.projectId) : undefined;
  if (!flow || !project?.localPath) throw new Error(`Flow 的项目目录不可用：${flowId}`);
  const cwd = project.localPath;
  const scratchDir = path.join(config.runtimeScratchRoot, flowId, "leader");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  return { cwd, scratchDir };
}

function leaderSystemPrompt(definition: AgentDefinition, flowId: string, cwd: string, scratchDir: string) {
  return [
    definition.systemPrompt,
    "",
    "## Supervisor 边界",
    `Flow：${flowId}`,
    `项目目录：${cwd}`,
    `临时目录：${scratchDir}`,
    "你自主选择工具和下一步。平台只校验身份、归属、引用、幂等、状态转换、Task 依赖、路径和权限。",
    "不要假设 AgentRun 结束会改变 Task 状态；需要改变时显式调用 Task 工具。",
    "单 Expert 不要求编排；多 Expert 按工作协议先提交编排计划。",
  ].join("\n");
}

function snapshotFromRow(row: ReturnType<Store["listAgentContextUsageSnapshots"]>[number] | undefined): ContextUsageSnapshot | null {
  if (!row) return null;
  let categories: ContextUsageSnapshot["categories"] = [];
  try { categories = JSON.parse(row.categoriesJson) as ContextUsageSnapshot["categories"]; } catch { categories = []; }
  return {
    totalTokens: row.totalTokens,
    maxTokens: row.maxTokens,
    rawMaxTokens: row.rawMaxTokens,
    percentage: row.percentage,
    model: row.model,
    categories,
    cacheInputTokens: row.cacheInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheHitRate: row.cacheHitRate,
    compacted: Boolean(row.compacted),
    observedAt: row.observedAt,
  };
}

function patchForChange(change: ReturnType<typeof changesFromBaseline>["changes"][number]) {
  if (change.detailStatus !== "ready") return null;
  return [
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    "@@",
    ...(change.beforeText ?? "").split("\n").map((line) => `-${line}`),
    ...(change.afterText ?? "").split("\n").map((line) => `+${line}`),
  ].join("\n");
}

export function createLeaderRuntime(input: CreateLeaderRuntimeInput): LeaderRuntime {
  const activeByFlow = new Map<string, ActiveLeader>();
  const mutationCoordinator = input.mutationCoordinator ?? new WorkspaceMutationCoordinator();

  const publishRun = async (runId: string) => {
    const run = input.store.getAgentRun(runId);
    if (!run) return;
    await input.eventBus.publish(run.flowId, {
      type: "agent_run:event",
      flow_id: run.flowId,
      data: {
        agent_run_id: run.id,
        agent_session_id: run.agentSessionId,
        task_id: run.taskId,
        trigger_kind: run.triggerKind,
        status: run.status,
        error_message: run.errorMessage,
      },
    });
  };

  const publishToolCall = async (flowId: string, toolCallId: string) => {
    const toolCall = input.store.getToolCall(toolCallId);
    if (toolCall) await input.eventBus.publish(flowId, { type: "tool_call:event", flow_id: flowId, data: toolCall });
  };

  const processToolChunks = async (run: AgentRunRow, chunks: UiMessageChunk[]) => {
    for (const chunk of chunks) {
      if (chunk.type === "tool-input-available") {
        const call = input.store.createToolCall({
          flowId: run.flowId,
          agentRunId: run.id,
          name: chunk.toolName,
          functionCallType: chunk.providerToolName ?? chunk.capability ?? null,
          idempotencyKey: chunk.toolCallId,
          arguments: chunk.input,
        });
        if (call) {
          input.store.updateToolCall({ toolCallId: String(call.id), status: "running" });
          await publishToolCall(run.flowId, String(call.id));
        }
      }
      if (chunk.type === "tool-output-available") {
        const call = input.store.listToolCalls(run.flowId).find((candidate) =>
          candidate.agentRunId === run.id && candidate.idempotencyKey === chunk.toolCallId);
        if (!call) continue;
        input.store.updateToolCall({
          toolCallId: String(call.id),
          status: chunk.output.is_error ? "failed" : "completed",
          result: chunk.output,
          errorMessage: chunk.output.is_error ? chunk.output.content : null,
        });
        await publishToolCall(run.flowId, String(call.id));
      }
    }
  };

  const materializeChangeSet = async (
    run: AgentRunRow,
    baseline: StoredChangeBaseline | undefined,
    attributor: ChangeSetToolAttributor | null,
  ) => {
    if (!baseline) return;
    const attributed = await attributor?.finish();
    const runDiff = changesFromBaseline(baseline);
    if (runDiff.status !== "ready") return;
    const touchedPaths = attributed
      ? attributed.files.map((file) => file.path)
      : runDiff.changes.map((change) => change.path);
    if (!touchedPaths.length) return;
    const existing = input.store.getOpenChangeSetForRun(run.id);
    const changeSet = existing ?? input.store.openChangeSet({ flowId: run.flowId, agentRunId: run.id });
    if (!changeSet) return;
    const cumulativeBaseline: StoredChangeBaseline = existing ? {
      id: `change-set:${String(changeSet.id)}`,
      flowId: run.flowId,
      agentRunId: run.id,
      taskId: run.taskId,
      rootPath: String(changeSet.rootPath),
      snapshotPath: String(changeSet.baselineSnapshotPath),
      baselineJson: String(changeSet.baselineJson),
      baselineKind: String(changeSet.baselineKind),
      baselineRef: typeof changeSet.baselineRef === "string" ? changeSet.baselineRef : null,
      status: "ready",
      errorMessage: null,
      createdAt: String(changeSet.createdAt),
    } : baseline;
    const cumulativeDiff = changesFromBaseline(cumulativeBaseline);
    const allowed = new Set(touchedPaths);
    const changes = cumulativeDiff.status === "ready"
      ? cumulativeDiff.changes.filter((change) => allowed.has(change.path))
      : [];
    input.store.reconcileChangeSetFiles({
      changeSetId: String(changeSet.id),
      touchedPaths,
      partialReason: attributed?.partialReason ?? null,
      files: changes.map((change) => ({
        path: change.path,
        status: change.status,
        patch: patchForChange(change),
        additions: change.afterText?.split("\n").length ?? 0,
        deletions: change.beforeText?.split("\n").length ?? 0,
        attributionKind: attributed?.files.find((file) => file.path === change.path)?.source ?? "snapshot",
      })),
    });
    await input.eventBus.publish(run.flowId, {
      type: "change_set:event",
      flow_id: run.flowId,
      data: { change_set: input.store.getChangeSet(String(changeSet.id)), files: input.store.listChangeSetFiles(String(changeSet.id)) },
    });
  };

  const runLeaderTurn = async (turn: LeaderTurnInput) => {
    const flow = input.store.getFlow(turn.flowId);
    const session = input.store.getAgentSession(turn.leaderSessionId) ?? input.store.getLeaderAgentSession(turn.flowId);
    const run = input.store.getAgentRun(turn.leaderAgentRunId);
    const definition = session ? input.store.getAgentDefinition(session.agentDefinitionId) : undefined;
    if (!flow || !session || !run || !definition || session.role !== "leader"
      || session.flowId !== flow.id || run.flowId !== flow.id || run.agentSessionId !== session.id) {
      throw new Error(`Leader AgentSession/AgentRun 归属无效：${turn.flowId}`);
    }
    if (activeByFlow.has(flow.id)) throw new LeaderInputRejectedError();
    const liveTurn: LeaderTurnInput = {
      ...turn,
      leaderSessionId: session.id,
      behaviorMode: flow.behaviorMode === "plan" ? "plan" : "execute",
      riskMode: flow.riskMode === "full_access" ? "full_access" : "auto_edit",
      orchestrationMode: flow.orchestrationMode === "automatic" ? "automatic" : "approval_required",
      currentTurnInput: turn.currentTurnInput ?? currentTurnInputFromTurn(turn),
    };
    const { cwd, scratchDir } = runtimeDirs(input.store, flow.id);
    const capabilities = normalizeRuntimeCapabilities(parseToolList(definition.builtinTools));
    const mcpTools = parseToolList(definition.mcpTools);
    const canWrite = hasWriteRuntimeCapability(capabilities);
    const baseline = canWrite
      ? capturePersistentChangeBaseline({ store: input.store, flowId: flow.id, agentRunId: run.id, rootPath: cwd })
      : undefined;
    const attributor = canWrite
      ? new ChangeSetToolAttributor(mutationCoordinator, { rootPath: cwd, ownerKey: flow.id, agentRunId: run.id })
      : null;
    const locked = await resolveLeaderConfig(session);
    if (!input.store.lockAgentSessionRuntime(session.id, {
      runtimeSdk: locked.runtimeSdk,
      runtimeConfigId: locked.runtimeConfigId,
      runtimeModelId: locked.runtimeModelId,
      runtimeReasoningEffort: locked.runtimeReasoningEffort,
    })) throw new Error(`Leader AgentSession 运行时锁冲突：${session.id}`);
    const runtimeAdapter = (input.runtimeAdapterFactory ?? createAgentRuntimeAdapter)({
      sdk: locked.config.sdk,
      role: "leader",
      runtimeConfig: locked.config,
    });
    const activeState = { currentTurnInput: liveTurn.currentTurnInput };
    let execution!: ActiveLeader;
    const hooks = {
      onFlowNameUpdated: async ({ flow: updatedFlow }: { flow: Record<string, unknown> }) => {
        await input.eventBus.publish(flow.id, { type: "flow:name_updated", flow_id: flow.id, data: updatedFlow as any });
      },
      onDecisionRequestCreated: async ({ decisionRequestId }: { decisionRequestId: string }) => {
        execution.endAfterUserAction = true;
        await input.eventBus.publish(flow.id, {
          type: "decision_request:event",
          flow_id: flow.id,
          data: input.store.getDecisionRequest(decisionRequestId),
        });
      },
      onPlanCreated: async ({ planRevision, approval }: { planRevision: Record<string, unknown>; approval: Record<string, unknown> }) => {
        execution.endAfterUserAction = true;
        await Promise.all([
          input.eventBus.publish(flow.id, { type: "plan:event", flow_id: flow.id, data: planRevision }),
          input.eventBus.publish(flow.id, { type: "plan_approval:event", flow_id: flow.id, data: approval }),
        ]);
      },
      onTaskCreated: async ({ task }: { task: Record<string, unknown> }) => {
        await input.eventBus.publish(flow.id, { type: "task:event", flow_id: flow.id, data: task });
      },
      onTaskUpdated: async ({ task }: { task: Record<string, unknown> }) => {
        await input.eventBus.publish(flow.id, { type: "task:event", flow_id: flow.id, data: task });
      },
      onOrchestrationCreated: async (created: {
        revision: Record<string, unknown>;
        approval: Record<string, unknown> | null;
        tasks: Array<Record<string, unknown>>;
      }) => {
        if (created.approval) execution.endAfterUserAction = true;
        await input.eventBus.publish(flow.id, { type: "orchestration:event", flow_id: flow.id, data: created });
        if (created.approval) await input.eventBus.publish(flow.id, {
          type: "orchestration_approval:event", flow_id: flow.id, data: created.approval,
        });
        await Promise.all(created.tasks.map((task) =>
          input.eventBus.publish(flow.id, { type: "task:event", flow_id: flow.id, data: task })));
      },
    };
    const createLeaderServer = () => createLeaderMcpServer(createLeaderToolHandlers(
      createStorePort(input.store, input.agentDispatcher),
      hooks,
      { getCurrentTurnInput: () => activeState.currentTurnInput, leaderAgentRunId: run.id },
    ));
    const leaderBinding = await runtimeAdapter.prepareLeaderMcpServer({
      server: createLeaderServer(),
      serverFactory: createLeaderServer,
      bindingKey: `leader:${session.id}:${run.id}`,
      bridgeRegistry: input.mcpBridgeRegistry,
    });
    const closeBindings: Array<() => Promise<void> | void> = [leaderBinding.close];
    const mcpServerConfigs: Record<string, unknown> = { "squadflow-leader": leaderBinding.mcpServerConfig };
    if (input.desktopBridge && mcpTools.some((tool) => tool.includes("browser"))) {
      const handlers = createBrowserToolHandlers({
        desktopBridge: input.desktopBridge,
        holderName: "Leader",
        flowId: flow.id,
        getAgentRunId: () => run.id,
        getScratchDir: () => scratchDir,
      });
      const createBrowserServer = () => createBrowserMcpServer(handlers);
      const browserBinding = await runtimeAdapter.prepareLeaderMcpServer({
        server: createBrowserServer(),
        serverFactory: createBrowserServer,
        bindingKey: `leader-browser:${session.id}:${run.id}`,
        bridgeRegistry: input.mcpBridgeRegistry,
      });
      closeBindings.push(browserBinding.close);
      mcpServerConfigs["squadflow-browser"] = browserBinding.mcpServerConfig;
    }
    const authorizedCapabilities = new Set<RuntimeCapability>(capabilities);
    const authorizedTools = new Set(mcpTools);
    const options = runtimeAdapter.buildLeaderOptions({
      role: "leader",
      systemPrompt: leaderSystemPrompt(definition, flow.id, cwd, scratchDir),
      cwd,
      scratchDir,
      capabilities,
      mcpTools,
      mcpServerConfigs,
      resume: session.providerSessionId ?? turn.resumeSessionId,
      runtimeConfig: locked.config,
      modelName: runtimeConfigModelName(locked.config, locked.runtimeModelId) ?? undefined,
      canUseTool: async (request) => {
        const permissionArgs: CheckPermissionArgs = {
          toolName: request.providerToolName,
          capability: request.capability,
          input: request.input,
          providerInput: request.providerInput,
          cwd,
          readableDirs: [cwd, scratchDir],
          writableDirs: canWrite ? [cwd] : [],
          authorizedCapabilities,
          authorizedTools,
          riskMode: input.store.getRiskMode(flow.id),
        };
        const result = await checkPermission(permissionArgs);
        if (result.behavior === "deny" && result.requiresConfirmation && input.permissionGate) {
          return input.permissionGate({
            flowId: flow.id,
            scope: { kind: "leader_run", agentRunId: run.id },
            request,
            permissionArgs,
          });
        }
        return result;
      },
    });
    const output = runtimeAdapter.createOutputAdapter(turn.messageId ?? `msg-${randomUUID()}`, { startedAt: turn.startedAt });
    const pusher = new WsPusher(
      flow.id,
      () => session.id,
      run.id,
      input.eventBus,
      input.chatJournal,
      (flowId) => { input.store.markFlowOutputCompleted(flowId); },
      session.id,
      leaderTranscriptChannelId(flow.id),
    );
    const inputQueue = runtimeAdapter.createInputQueue();
    execution = {
      flowId: flow.id,
      run,
      session,
      definition,
      runtimeAdapter,
      inputQueue,
      query: null,
      output,
      pusher,
      cancelled: false,
      endAfterUserAction: false,
      closeBindings,
    };
    activeByFlow.set(flow.id, execution);
    input.store.updateAgentRunStatus(run.id, "running");
    await publishRun(run.id);
    const visibleUserText = liveTurn.userMessage ?? liveTurn.decisionUserMessage ?? "";
    if (visibleUserText) await pusher.publishUserMessage(visibleUserText, turn.messageId ?? `msg-user-${randomUUID()}`);
    await pusher.consume(output.start());
    inputQueue.push(runtimeAdapter.createLeaderUserMessage(liveTurn));
    const query = runtimeAdapter.runQuery({ prompt: inputQueue, options });
    execution.query = query;
    let providerError: Error | null = null;
    try {
      for await (const event of query) {
        if (execution.cancelled) break;
        const chunks = output.adapt(event);
        await attributor?.observe(event, chunks);
        await processToolChunks(run, chunks);
        for (const chunk of chunks) await pusher.consume(chunk);
        if (event.type === "turn_completed") break;
        if (execution.endAfterUserAction && chunks.some((chunk) => chunk.type === "tool-output-available")) break;
      }
    } catch (error) {
      providerError = error instanceof Error ? error : new Error(String(error));
    } finally {
      inputQueue.close();
      await query.close?.();
      for (const chunk of output.finish()) await pusher.consume(chunk);
      for (const close of closeBindings) await close();
    }
    if (output.sdkSessionId) input.store.updateAgentSessionProviderSession(session.id, output.sdkSessionId);
    await materializeChangeSet(run, baseline, attributor);
    let snapshot: ContextUsageSnapshot | null = null;
    if (query.getContextUsage) {
      try { snapshot = runtimeAdapter.contextUsageSnapshot(await query.getContextUsage()); } catch { snapshot = null; }
    }
    snapshot ??= overallContextUsageFromResultCache(output.resultCacheUsage);
    if (snapshot) {
      input.store.upsertAgentContextUsageSnapshot({
        flowId: flow.id,
        agentRunId: run.id,
        providerSessionId: output.sdkSessionId,
        role: "leader",
        agentDefinitionId: definition.id,
        agentSessionId: session.id,
        ...snapshot,
      });
      await input.eventBus.publish(flow.id, {
        type: "context_usage:event",
        flow_id: flow.id,
        data: contextUsageSnapshotToPayload(snapshot, {
          agentRunId: run.id,
          providerSessionId: output.sdkSessionId,
          role: "leader",
          agentDefinitionId: definition.id,
          agentSessionId: session.id,
          displayName: session.displayName,
        }),
      });
    }
    const current = input.store.getAgentRun(run.id);
    if (current && ["queued", "running", "waiting_tool_approval"].includes(current.status)) {
      input.store.updateAgentRunStatus(
        run.id,
        execution.cancelled ? "cancelled" : providerError || output.resultIsError ? "failed" : "completed",
        providerError?.message ?? output.resultError ?? null,
      );
    }
    input.store.appendEventLog({
      flowId: flow.id,
      agentRunId: run.id,
      eventType: "agent_run.leader_completed",
      payload: { ended_for_user_action: execution.endAfterUserAction, error: providerError?.message ?? output.resultError ?? null },
    });
    await publishRun(run.id);
    activeByFlow.delete(flow.id);
  };

  return {
    runLeaderTurn,
    async guideLeaderTurn(guide) {
      const execution = activeByFlow.get(guide.flowId);
      if (!execution || execution.run.id !== guide.leaderAgentRunId) throw new LeaderInputRejectedError();
      const flow = input.store.getFlow(guide.flowId);
      if (!flow) throw new Error(`Flow 不存在：${guide.flowId}`);
      guide.beforeDeliver?.();
      const messageId = guide.messageId ?? `msg-guide-${randomUUID()}`;
      execution.inputQueue.push(execution.runtimeAdapter.createLeaderGuideMessage(
        guide.flowId,
        guide.content,
        guide.attachments,
        guide.orchestrationFeedback,
        {
          behaviorMode: flow.behaviorMode === "plan" ? "plan" : "execute",
          riskMode: flow.riskMode === "full_access" ? "full_access" : "auto_edit",
          orchestrationMode: flow.orchestrationMode === "automatic" ? "automatic" : "approval_required",
        },
      ));
      await execution.pusher.publishRunningGuide(guide.content, messageId);
      return { accepted: true, messageId };
    },
    async getContextUsage(flowId) {
      return snapshotFromRow(input.store.listAgentContextUsageSnapshots(flowId).at(-1));
    },
    async compactContext(flowId) {
      const snapshot = snapshotFromRow(input.store.listAgentContextUsageSnapshots(flowId).at(-1));
      if (!snapshot) return null;
      const compacted = { ...snapshot, compacted: true, observedAt: new Date().toISOString() };
      await input.eventBus.publish(flowId, { type: "context_compaction:event", flow_id: flowId, data: compacted });
      return compacted;
    },
    cancelFlow(flowId) {
      const execution = activeByFlow.get(flowId);
      if (!execution) return false;
      execution.cancelled = true;
      execution.inputQueue.close();
      void execution.query?.close?.();
      const run = input.store.getAgentRun(execution.run.id);
      if (run && ["queued", "running", "waiting_tool_approval"].includes(run.status)) {
        input.store.updateAgentRunStatus(run.id, "cancelled");
      }
      void finishInterruptedTurn({
        flowId,
        sessionId: execution.session.id,
        transcriptId: leaderTranscriptChannelId(flowId),
        agentRunId: execution.run.id,
        agentSessionId: execution.session.id,
        eventBus: input.eventBus,
        chatJournal: input.chatJournal,
      });
      void publishRun(execution.run.id);
      return true;
    },
    async close() {
      await Promise.all([...activeByFlow.values()].map(async (execution) => {
        execution.cancelled = true;
        execution.inputQueue.close();
        await execution.query?.close?.();
        for (const close of execution.closeBindings) await close();
      }));
      activeByFlow.clear();
    },
  };
}

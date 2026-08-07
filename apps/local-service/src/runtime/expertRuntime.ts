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
  runtimeRoleForExpertRole,
  runtimeSdkFromValue,
  type AgentRuntimeRole,
  type RuntimeConfig,
} from "../config/agentRuntimeConfig.js";
import { normalizeRuntimeReasoningEffort } from "../config/runtimeReasoningEffort.js";
import type { Store, AgentRunRow, AgentSessionRow, TaskRow } from "../db/store.js";
import { createAgentRuntimeAdapter } from "./adapters/factory.js";
import type { AgentRuntimeAdapterFactory } from "./adapters/factory.js";
import type {
  AgentRuntimeAdapter,
  RuntimeOutputAdapter,
  RuntimeQueryLike,
  RuntimeToolPermissionRequest,
} from "./adapters/runtimeAdapter.js";
import { hasWriteRuntimeCapability, normalizeRuntimeCapabilities, type RuntimeCapability } from "./capabilities.js";
import { assembleExpertResult, type ExpertResult, type TurnOutcome } from "../harness/expertResult.js";
import { contextUsageSnapshotToPayload, overallContextUsageFromResultCache } from "../domain/contextUsage.js";
import { checkPermission, type CheckPermissionArgs, type PermissionResult } from "../permissions/permissionPolicy.js";
import type { ChatJournal } from "../ws/chatJournal.js";
import type { EventBus } from "../ws/eventBus.js";
import { finishInterruptedTurn, WsPusher } from "../ws/pusher.js";
import type { McpBridgeRegistry } from "../mcp/mcpBridgeRegistry.js";
import type { DesktopBridge } from "../server/desktopBridge.js";
import type { OperationalLogger } from "../observability/operationalLogger.js";
import { BROWSER_MCP_TOOL_PREFIX, createBrowserMcpServer, createBrowserToolHandlers } from "../mcp/browserServer.js";
import {
  EXPERT_TASK_MCP_TOOL_NAMES,
  createExpertTaskMcpServer,
  createExpertTaskToolHandlers,
  type ExpertTask,
} from "../mcp/expertTaskServer.js";
import { createExpertTaskStorePort } from "../mcp/expertTaskStorePort.js";
import { buildPlatformEvent, computeFlowSig } from "../protocol/platformEvent.js";
import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import type { AsyncMessageQueue } from "./adapters/asyncMessageQueue.js";
import { capturePersistentChangeBaseline, changesFromBaseline, type StoredChangeBaseline } from "./changeBaseline.js";
import { ChangeSetToolAttributor, WorkspaceMutationCoordinator } from "./changeSetFileAttribution.js";

export type ExpertTaskInput = {
  flowId: string;
  taskId: string;
  agentSessionId: string;
  agentRunId: string;
  resumeSessionId?: string;
  prompt?: string;
};

export type ExpertConversationInput = {
  flowId: string;
  taskId?: string;
  agentSessionId: string;
  agentRunId: string;
  content: string;
  resumeSessionId?: string;
};

export type ExpertRuntimeMessageInput = {
  flowId: string;
  agentSessionId?: string;
  agentRunId: string;
  content: string;
};

export type RuntimePermissionScope =
  | { kind: "expert_task"; taskId: string; agentRunId: string }
  | { kind: "expert_conversation"; agentRunId: string }
  | { kind: "leader_run"; agentRunId: string };

export type RuntimePermissionGate = (input: {
  flowId: string;
  scope: RuntimePermissionScope;
  request: RuntimeToolPermissionRequest;
  permissionArgs: CheckPermissionArgs;
}) => Promise<PermissionResult>;

export type ExpertTaskFinishedEvent = {
  flowId: string;
  taskId: string;
  agentRunId: string;
  agentSessionId: string;
  agentDefinitionId: string;
  status: "completed" | "failed" | "cancelled";
  taskStatus: string;
  turnOutcome: TurnOutcome;
  summary: string;
  error: string | null;
  artifactRefs: string[];
  filesChanged: string[];
  metrics: Record<string, unknown>;
  completedAt: string;
};

export type ExpertConversationFinishedEvent = Omit<ExpertTaskFinishedEvent, "taskId" | "taskStatus"> & {
  taskId?: string;
};

export type ExpertRuntime = {
  runTask: (input: ExpertTaskInput) => Promise<void>;
  runConversation: (input: ExpertConversationInput) => Promise<void>;
  sendMessage: (input: ExpertRuntimeMessageInput) => boolean;
  cancelAgent: (input: { flowId: string; agentSessionId: string; agentRunId: string }) => Promise<boolean>;
  confirmPermission: RuntimePermissionGate;
  resolvePermissionCard: (input: {
    flowId: string;
    cardId: string;
    outcome: "approved" | "user_denied" | "card_cancelled";
    actionId?: string;
  }) => Promise<boolean>;
  close?: () => Promise<void>;
};

export type CreateExpertRuntimeInput = {
  store: Store;
  eventBus: EventBus;
  chatJournal: ChatJournal;
  runtimeAdapterFactory?: AgentRuntimeAdapterFactory;
  mcpBridgeRegistry?: McpBridgeRegistry;
  desktopBridge?: DesktopBridge;
  onTaskFinished?: (event: ExpertTaskFinishedEvent) => Promise<void> | void;
  onConversationFinished?: (event: ExpertConversationFinishedEvent) => Promise<void> | void;
  onTaskUpdated?: (event: { flowId: string; task: ExpertTask }) => Promise<void> | void;
  logger?: OperationalLogger;
  mutationCoordinator?: WorkspaceMutationCoordinator;
};

type AgentDefinition = NonNullable<ReturnType<Store["getAgentDefinition"]>>;

type ActiveExecution = {
  run: AgentRunRow;
  session: AgentSessionRow;
  definition: AgentDefinition;
  query: RuntimeQueryLike | null;
  runtimeAdapter: AgentRuntimeAdapter;
  inputQueue: AsyncMessageQueue<unknown>;
  output: RuntimeOutputAdapter;
  pusher: WsPusher;
  cancelled: boolean;
  closeBindings: Array<() => Promise<void> | void>;
  permissionRequestIds: Set<string>;
};

type PermissionWaiter = {
  flowId: string;
  agentRunId: string;
  resolve: (outcome: "approved" | "rejected" | "cancelled") => void;
};

type LockedRuntimeConfig = {
  config: RuntimeConfig & { reasoningEffort: string };
  runtimeSdk: string;
  runtimeConfigId: string;
  runtimeModelId: string | null;
  runtimeReasoningEffort: string;
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

function withReasoningEffort(runtimeConfig: RuntimeConfig, value: unknown) {
  const reasoningEffort = normalizeRuntimeReasoningEffort(runtimeConfig.sdk, value);
  return { config: { ...runtimeConfig, reasoningEffort }, reasoningEffort };
}

async function resolveSessionRuntimeConfig(
  session: AgentSessionRow,
  runtimeRole: AgentRuntimeRole,
  resumeSessionId?: string | null,
): Promise<LockedRuntimeConfig> {
  const lockedSdk = runtimeSdkFromValue(session.runtimeSdk);
  if (lockedSdk && session.runtimeConfigId) {
    const runtimeConfig = await readRuntimeConfig(session.runtimeConfigId);
    const modelId = runtimeConfig && runtimeConfig.sdk === lockedSdk
      ? resolveRuntimeModelId(runtimeConfig, session.runtimeModelId)
      : "";
    if (!runtimeConfig || !modelId) throw new Error(`AgentSession 的运行时配置不可用：${session.id}`);
    const resolved = withReasoningEffort(runtimeConfig, session.runtimeReasoningEffort);
    return {
      config: resolved.config,
      runtimeSdk: lockedSdk,
      runtimeConfigId: session.runtimeConfigId,
      runtimeModelId: modelId,
      runtimeReasoningEffort: resolved.reasoningEffort,
    };
  }
  if (resumeSessionId) {
    const legacy = await readDefaultFlowRuntimeConfigForSdk(legacySessionRuntimeSdk);
    if (!legacy) throw new Error(`续接 AgentSession 的运行时配置不可用：${session.id}`);
    const resolved = withReasoningEffort(legacy.config, session.runtimeReasoningEffort);
    return {
      config: resolved.config,
      runtimeSdk: legacy.config.sdk,
      runtimeConfigId: legacy.configId,
      runtimeModelId: legacy.modelId,
      runtimeReasoningEffort: resolved.reasoningEffort,
    };
  }
  const roleConfig = await readRoleRuntimeConfig(runtimeRole);
  if (!roleConfig.binding.modelId) throw new Error(`角色 ${runtimeRole} 尚未配置模型`);
  const resolved = withReasoningEffort(roleConfig.config, roleConfig.binding.reasoningEffort);
  return {
    config: resolved.config,
    runtimeSdk: roleConfig.config.sdk,
    runtimeConfigId: roleConfig.config.id,
    runtimeModelId: roleConfig.binding.modelId,
    runtimeReasoningEffort: resolved.reasoningEffort,
  };
}

function runtimeDirs(store: Store, flowId: string, agentSessionId: string) {
  const flow = store.getFlow(flowId);
  const project = flow?.projectId ? store.getProject(flow.projectId) : undefined;
  if (!flow || !project?.localPath) throw new Error(`Flow 的项目目录不可用：${flowId}`);
  const cwd = project.localPath;
  const scratchDir = path.join(config.runtimeScratchRoot, flowId, agentSessionId);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  return { cwd, scratchDir };
}

function systemPrompt(definition: AgentDefinition, flowId: string, cwd: string, scratchDir: string) {
  const sig = computeFlowSig(flowId);
  return [
    definition.systemPrompt,
    "",
    "## 运行环境",
    `执行目标目录（绝对路径）：${cwd}`,
    `临时工作目录：${scratchDir}`,
    "工具由你根据任务自行选择；平台只校验身份、归属、路径和权限边界。",
    `可信平台事件签名：${sig}`,
    "不要在回复中生成 <squadflow> 标签。",
  ].join("\n");
}

function taskPrompt(flowId: string, task: TaskRow, cwd: string, scratchDir: string, message?: string) {
  return [
    buildPlatformEvent({
      flowId,
      type: "dispatch_env",
      attrs: { cwd, scratch: scratchDir },
      body: "请在项目边界内完成 Task；Task 状态只通过 Task 工具显式修改。",
    }),
    `Task：${task.title}\n\n${task.description}`,
    ...(message?.trim() ? [buildPlatformEvent({ flowId, type: "leader_message", body: message.trim() })] : []),
  ].join("\n\n");
}

function conversationPrompt(flowId: string, content: string) {
  return buildPlatformEvent({ flowId, type: "leader_message", body: content.trim() });
}

function failureResult(message: string, outcome: TurnOutcome = "errored") {
  return assembleExpertResult({ finalAssistantText: null, turnOutcome: outcome, errorMessage: message });
}

function patchForChange(change: ReturnType<typeof changesFromBaseline>["changes"][number]) {
  if (change.detailStatus !== "ready") return null;
  const before = change.beforeText ?? "";
  const after = change.afterText ?? "";
  return [
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    "@@",
    ...before.split("\n").map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

function lineCount(text: string | null) {
  return text ? text.split("\n").length : 0;
}

export function createExpertRuntime(input: CreateExpertRuntimeInput): ExpertRuntime {
  const activeByRun = new Map<string, ActiveExecution>();
  const permissionWaiters = new Map<string, PermissionWaiter>();
  const mutationCoordinator = input.mutationCoordinator ?? new WorkspaceMutationCoordinator();
  const expertTaskStore = createExpertTaskStorePort(input.store, { onTaskUpdated: input.onTaskUpdated });

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
    const call = input.store.getToolCall(toolCallId);
    if (!call) return;
    await input.eventBus.publish(flowId, { type: "tool_call:event", flow_id: flowId, data: call });
  };

  const toolCallFor = (run: AgentRunRow, request: RuntimeToolPermissionRequest) => {
    const providerId = request.context.toolUseId ?? randomUUID();
    return input.store.createToolCall({
      flowId: run.flowId,
      agentRunId: run.id,
      taskId: run.taskId,
      name: request.providerToolName,
      functionCallType: request.capability,
      idempotencyKey: providerId,
      arguments: request.providerInput,
    });
  };

  const permissionGate: RuntimePermissionGate = async ({ flowId, scope, request, permissionArgs }) => {
    const initial = await checkPermission(permissionArgs);
    if (initial.behavior !== "deny" || !initial.requiresConfirmation) return initial;
    const run = input.store.getAgentRun(scope.agentRunId);
    if (!run || run.flowId !== flowId || !["queued", "running"].includes(run.status)) {
      return { behavior: "deny", message: "当前 AgentRun 已结束，风险操作未执行。" };
    }
    const toolCall = toolCallFor(run, request);
    if (!toolCall) return { behavior: "deny", message: "无法记录 ToolCall，风险操作未执行。" };
    const decision = input.store.createDecisionRequest({
      flowId,
      agentRunId: run.id,
      toolCallId: String(toolCall.id),
      requestType: "tool_permission",
      payload: {
        capability: request.capability,
        provider_tool_name: request.providerToolName,
        provider_input: request.providerInput,
      },
    });
    if (!decision) return { behavior: "deny", message: "无法创建工具权限请求，风险操作未执行。" };
    const requestId = String(decision.id);
    activeByRun.get(run.id)?.permissionRequestIds.add(requestId);
    await Promise.all([
      publishRun(run.id),
      publishToolCall(flowId, String(toolCall.id)),
      input.eventBus.publish(flowId, { type: "decision_request:event", flow_id: flowId, data: decision }),
    ]);
    const outcome = await new Promise<"approved" | "rejected" | "cancelled">((resolve) => {
      permissionWaiters.set(requestId, { flowId, agentRunId: run.id, resolve });
    });
    permissionWaiters.delete(requestId);
    activeByRun.get(run.id)?.permissionRequestIds.delete(requestId);
    if (outcome !== "approved") {
      return { behavior: "deny", message: "用户未批准本次风险操作，请继续其他工作或说明阻塞。" };
    }
    return checkPermission({ ...permissionArgs, riskMode: "full_access" });
  };

  const processToolChunks = async (run: AgentRunRow, chunks: UiMessageChunk[]) => {
    for (const chunk of chunks) {
      if (chunk.type === "tool-input-available") {
        const call = input.store.createToolCall({
          flowId: run.flowId,
          agentRunId: run.id,
          taskId: run.taskId,
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
        const call = input.store.listToolCalls(run.flowId).find((row) =>
          row.agentRunId === run.id && row.idempotencyKey === chunk.toolCallId);
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
    if (!baseline) return [] as string[];
    const attributed = await attributor?.finish();
    const runDiff = changesFromBaseline(baseline);
    if (runDiff.status !== "ready") return [] as string[];
    const touchedPaths = attributed
      ? attributed.files.map((file) => file.path)
      : runDiff.changes.map((change) => change.path);
    if (!touchedPaths.length) return [] as string[];
    const existing = input.store.getOpenChangeSetForRun(run.id);
    const changeSet = existing ?? input.store.openChangeSet({ flowId: run.flowId, agentRunId: run.id, taskId: run.taskId });
    if (!changeSet) return [] as string[];
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
    const allowedPaths = new Set(touchedPaths);
    const changes = cumulativeDiff.status === "ready"
      ? cumulativeDiff.changes.filter((change) => allowedPaths.has(change.path))
      : [];
    input.store.reconcileChangeSetFiles({
      changeSetId: String(changeSet.id),
      touchedPaths,
      partialReason: attributed?.partialReason ?? cumulativeDiff.reason ?? null,
      files: changes.map((change) => ({
        path: change.path,
        status: change.status,
        patch: patchForChange(change),
        additions: lineCount(change.afterText),
        deletions: lineCount(change.beforeText),
        attributionKind: attributed?.files.find((file) => file.path === change.path)?.source ?? "snapshot",
      })),
    });
    await input.eventBus.publish(run.flowId, {
      type: "change_set:event",
      flow_id: run.flowId,
      data: { change_set: input.store.getChangeSet(String(changeSet.id)), files: input.store.listChangeSetFiles(String(changeSet.id)) },
    });
    return changes.map((change) => change.path);
  };

  const execute = async (request: {
    run: AgentRunRow;
    session: AgentSessionRow;
    definition: AgentDefinition;
    content: string;
    resumeSessionId?: string;
  }) => {
    const { run, session, definition } = request;
    const { cwd, scratchDir } = runtimeDirs(input.store, run.flowId, session.id);
    const capabilities = normalizeRuntimeCapabilities(parseToolList(definition.builtinTools));
    const mcpTools = [...new Set([...parseToolList(definition.mcpTools), ...EXPERT_TASK_MCP_TOOL_NAMES])];
    const canWrite = hasWriteRuntimeCapability(capabilities);
    const baseline = canWrite
      ? capturePersistentChangeBaseline({ store: input.store, flowId: run.flowId, agentRunId: run.id, taskId: run.taskId, rootPath: cwd })
      : undefined;
    const attributor = canWrite
      ? new ChangeSetToolAttributor(mutationCoordinator, { rootPath: cwd, ownerKey: run.flowId, agentRunId: run.id })
      : null;
    const runtimeRole = runtimeRoleForExpertRole(definition.role);
    const locked = await resolveSessionRuntimeConfig(session, runtimeRole, session.providerSessionId ?? request.resumeSessionId);
    const lockedSession = input.store.lockAgentSessionRuntime(session.id, {
      runtimeSdk: locked.runtimeSdk,
      runtimeConfigId: locked.runtimeConfigId,
      runtimeModelId: locked.runtimeModelId,
      runtimeReasoningEffort: locked.runtimeReasoningEffort,
    });
    if (!lockedSession) throw new Error(`AgentSession 运行时锁冲突：${session.id}`);
    const runtimeAdapter = (input.runtimeAdapterFactory ?? createAgentRuntimeAdapter)({
      sdk: locked.config.sdk,
      role: runtimeRole,
      runtimeConfig: locked.config,
    });
    const taskContext = { runId: run.id };
    const createTaskServer = () => createExpertTaskMcpServer(createExpertTaskToolHandlers(expertTaskStore, {
      getActorScope: () => taskContext.runId
        ? { flowId: run.flowId, agentSessionId: session.id, agentRunId: taskContext.runId }
        : null,
    }));
    const taskBinding = await runtimeAdapter.prepareExpertMcpServer({
      serverName: "squadflow-expert-task",
      server: createTaskServer(),
      serverFactory: createTaskServer,
      bindingKey: `expert-task:${session.id}:${run.id}`,
      bridgeRegistry: input.mcpBridgeRegistry,
    });
    const closeBindings: Array<() => Promise<void> | void> = [taskBinding.close];
    const mcpServerConfigs: Record<string, unknown> = { "squadflow-expert-task": taskBinding.mcpServerConfig };
    if (mcpTools.some((tool) => tool.startsWith(BROWSER_MCP_TOOL_PREFIX)) && input.desktopBridge) {
      const handlers = createBrowserToolHandlers({
        desktopBridge: input.desktopBridge,
        holderName: definition.name,
        flowId: run.flowId,
        getAgentRunId: () => run.id,
        getScratchDir: () => scratchDir,
      });
      const createBrowserServer = () => createBrowserMcpServer(handlers);
      const browserBinding = await runtimeAdapter.prepareExpertMcpServer({
        serverName: "squadflow-browser",
        server: createBrowserServer(),
        serverFactory: createBrowserServer,
        bindingKey: `expert-browser:${session.id}:${run.id}`,
        bridgeRegistry: input.mcpBridgeRegistry,
      });
      closeBindings.push(browserBinding.close);
      mcpServerConfigs["squadflow-browser"] = browserBinding.mcpServerConfig;
    }
    const authorizedCapabilities = new Set<RuntimeCapability>(capabilities);
    const authorizedTools = new Set(mcpTools);
    const permissionScope: RuntimePermissionScope = run.taskId
      ? { kind: "expert_task", taskId: run.taskId, agentRunId: run.id }
      : { kind: "expert_conversation", agentRunId: run.id };
    const options = runtimeAdapter.buildExpertOptions({
      role: runtimeRole,
      systemPrompt: systemPrompt(definition, run.flowId, cwd, scratchDir),
      cwd,
      scratchDir,
      capabilities,
      mcpTools,
      mcpServerConfigs,
      resume: session.providerSessionId ?? request.resumeSessionId,
      runtimeConfig: locked.config,
      modelName: runtimeConfigModelName(locked.config, locked.runtimeModelId) ?? undefined,
      canUseTool: async (permissionRequest) => permissionGate({
        flowId: run.flowId,
        scope: permissionScope,
        request: permissionRequest,
        permissionArgs: {
          toolName: permissionRequest.providerToolName,
          capability: permissionRequest.capability,
          input: permissionRequest.input,
          providerInput: permissionRequest.providerInput,
          cwd,
          readableDirs: [cwd, scratchDir],
          writableDirs: canWrite ? [cwd] : [],
          authorizedCapabilities,
          authorizedTools,
          riskMode: input.store.getRiskMode(run.flowId),
        },
      }),
    });
    const messageId = `msg-${randomUUID()}`;
    const output = runtimeAdapter.createOutputAdapter(messageId, { startedAt: new Date().toISOString() });
    const pusher = new WsPusher(
      run.flowId,
      () => session.id,
      run.id,
      input.eventBus,
      input.chatJournal,
      (flowId) => { input.store.markFlowOutputCompleted(flowId); },
      session.id,
      session.id,
    );
    const inputQueue = runtimeAdapter.createInputQueue();
    const execution: ActiveExecution = {
      run,
      session,
      definition,
      query: null,
      runtimeAdapter,
      inputQueue,
      output,
      pusher,
      cancelled: false,
      closeBindings,
      permissionRequestIds: new Set(),
    };
    activeByRun.set(run.id, execution);
    input.store.updateAgentRunStatus(run.id, "running");
    await publishRun(run.id);
    await pusher.publishUserMessage(request.content, `msg-user-${randomUUID()}`);
    await pusher.consume(output.start());
    inputQueue.push(runtimeAdapter.createExpertUserMessage(request.content));
    const query = runtimeAdapter.runQuery({ prompt: inputQueue, options });
    execution.query = query;
    let providerCompleted = false;
    let providerError: Error | null = null;
    try {
      for await (const event of query) {
        if (execution.cancelled) break;
        const chunks = output.adapt(event);
        await attributor?.observe(event, chunks);
        await processToolChunks(run, chunks);
        for (const chunk of chunks) await pusher.consume(chunk);
        if (event.type === "turn_completed") {
          providerCompleted = true;
          break;
        }
      }
    } catch (error) {
      providerError = error instanceof Error ? error : new Error(String(error));
    } finally {
      inputQueue.close();
      await query.close?.();
      for (const chunk of output.finish()) await pusher.consume(chunk);
      for (const close of closeBindings) await close();
    }
    const providerSessionId = output.sdkSessionId;
    if (providerSessionId) input.store.updateAgentSessionProviderSession(session.id, providerSessionId);
    const filesChanged = await materializeChangeSet(run, baseline, attributor);
    const result = providerError
      ? failureResult(providerError.message)
      : assembleExpertResult({
          finalAssistantText: output.finalAssistantText,
          turnOutcome: execution.cancelled ? "interrupted" : providerCompleted && !output.resultIsError ? "completed" : "errored",
          errorMessage: output.resultError ?? undefined,
          filesChanged,
          metrics: output.durationMs === null ? {} : { duration_ms: output.durationMs },
        });
    if (query.getContextUsage) {
      try {
        const snapshot = runtimeAdapter.contextUsageSnapshot(await query.getContextUsage());
        input.store.upsertAgentContextUsageSnapshot({
          flowId: run.flowId,
          agentRunId: run.id,
          providerSessionId,
          role: definition.role,
          agentDefinitionId: definition.id,
          agentSessionId: session.id,
          ...snapshot,
        });
        await input.eventBus.publish(run.flowId, {
          type: "context_usage:event",
          flow_id: run.flowId,
          data: contextUsageSnapshotToPayload(snapshot, {
            agentRunId: run.id,
            providerSessionId,
            role: definition.role,
            agentDefinitionId: definition.id,
            agentSessionId: session.id,
            displayName: session.displayName,
          }),
        });
      } catch {
        const snapshot = overallContextUsageFromResultCache(output.resultCacheUsage);
        if (snapshot) input.store.upsertAgentContextUsageSnapshot({
          flowId: run.flowId,
          agentRunId: run.id,
          providerSessionId,
          role: definition.role,
          agentDefinitionId: definition.id,
          agentSessionId: session.id,
          ...snapshot,
        });
      }
    }
    const status: "completed" | "failed" | "cancelled" = execution.cancelled
      ? "cancelled"
      : providerError || output.resultIsError
        ? "failed"
        : "completed";
    const currentRun = input.store.getAgentRun(run.id);
    if (currentRun && ["queued", "running", "waiting_tool_approval"].includes(currentRun.status)) {
      input.store.updateAgentRunStatus(run.id, status, providerError?.message ?? output.resultError ?? null);
    }
    await publishRun(run.id);
    activeByRun.delete(run.id);
    return { status, result, filesChanged };
  };

  const notifyCompletion = async (
    run: AgentRunRow,
    session: AgentSessionRow,
    definition: AgentDefinition,
    outcome: Awaited<ReturnType<typeof execute>>,
  ) => {
    const completedAt = new Date().toISOString();
    const artifacts = input.store.listArtifacts(run.flowId)
      .filter((artifact) => artifact.sourceAgentRunId === run.id)
      .map((artifact) => String(artifact.id));
    input.store.appendEventLog({
      flowId: run.flowId,
      taskId: run.taskId,
      agentRunId: run.id,
      eventType: run.taskId ? "agent_run.task_completed" : "agent_run.message_completed",
      payload: { status: outcome.status, files_changed: outcome.filesChanged, completed_at: completedAt },
    });
    if (run.taskId) {
      const task = input.store.getTask(run.taskId);
      if (!task) return;
      await input.onTaskFinished?.({
        flowId: run.flowId,
        taskId: task.id,
        agentRunId: run.id,
        agentSessionId: session.id,
        agentDefinitionId: definition.id,
        status: outcome.status,
        taskStatus: task.status,
        turnOutcome: outcome.result.turn_outcome,
        summary: outcome.result.summary,
        error: outcome.result.error,
        artifactRefs: artifacts,
        filesChanged: outcome.filesChanged,
        metrics: outcome.result.metrics,
        completedAt,
      });
      await input.eventBus.publish(run.flowId, { type: "task:event", flow_id: run.flowId, data: task });
      return;
    }
    await input.onConversationFinished?.({
      flowId: run.flowId,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      agentRunId: run.id,
      agentSessionId: session.id,
      agentDefinitionId: definition.id,
      status: outcome.status,
      turnOutcome: outcome.result.turn_outcome,
      summary: outcome.result.summary,
      error: outcome.result.error,
      artifactRefs: artifacts,
      filesChanged: outcome.filesChanged,
      metrics: outcome.result.metrics,
      completedAt,
    });
  };

  const validate = (flowId: string, agentSessionId: string, agentRunId: string) => {
    const session = input.store.getAgentSession(agentSessionId);
    const run = input.store.getAgentRun(agentRunId);
    const definition = session ? input.store.getAgentDefinition(session.agentDefinitionId) : undefined;
    if (!session || !run || !definition || session.role !== "expert"
      || session.flowId !== flowId || run.flowId !== flowId || run.agentSessionId !== session.id) {
      throw new Error(`Expert AgentSession/AgentRun 归属无效：${agentSessionId}/${agentRunId}`);
    }
    return { session, run, definition };
  };

  return {
    async runTask(taskInput) {
      const { session, run, definition } = validate(taskInput.flowId, taskInput.agentSessionId, taskInput.agentRunId);
      const task = input.store.getTask(taskInput.taskId);
      if (!task || task.flowId !== taskInput.flowId || run.taskId !== task.id || task.agentSessionId !== session.id) {
        throw new Error(`Task 未绑定到当前 AgentSession/AgentRun：${taskInput.taskId}`);
      }
      const { cwd, scratchDir } = runtimeDirs(input.store, task.flowId, session.id);
      const outcome = await execute({
        run,
        session,
        definition,
        content: taskPrompt(task.flowId, task, cwd, scratchDir, taskInput.prompt),
        resumeSessionId: taskInput.resumeSessionId,
      });
      await notifyCompletion(run, session, definition, outcome);
    },
    async runConversation(conversationInput) {
      const { session, run, definition } = validate(
        conversationInput.flowId,
        conversationInput.agentSessionId,
        conversationInput.agentRunId,
      );
      if (run.taskId !== (conversationInput.taskId ?? null)) {
        throw new Error(`AgentRun 的 Task 绑定不匹配：${run.id}`);
      }
      const outcome = await execute({
        run,
        session,
        definition,
        content: conversationPrompt(conversationInput.flowId, conversationInput.content),
        resumeSessionId: conversationInput.resumeSessionId,
      });
      await notifyCompletion(run, session, definition, outcome);
    },
    sendMessage(message) {
      const execution = activeByRun.get(message.agentRunId);
      if (!execution || execution.run.flowId !== message.flowId
        || (message.agentSessionId && execution.session.id !== message.agentSessionId)) return false;
      execution.inputQueue.push(
        execution.runtimeAdapter.createExpertGuideMessage(conversationPrompt(message.flowId, message.content)),
      );
      void execution.pusher.publishRunningGuide(message.content, `msg-guide-${randomUUID()}`);
      return true;
    },
    async cancelAgent(cancelInput) {
      const execution = activeByRun.get(cancelInput.agentRunId);
      if (!execution || execution.run.flowId !== cancelInput.flowId || execution.session.id !== cancelInput.agentSessionId) {
        return !input.store.getActiveAgentRun(cancelInput.agentSessionId);
      }
      execution.cancelled = true;
      execution.inputQueue.close();
      await execution.query?.close?.();
      for (const requestId of execution.permissionRequestIds) {
        await this.resolvePermissionCard({
          flowId: cancelInput.flowId,
          cardId: requestId,
          outcome: "card_cancelled",
        });
      }
      const current = input.store.getAgentRun(cancelInput.agentRunId);
      if (current && ["queued", "running", "waiting_tool_approval"].includes(current.status)) {
        input.store.updateAgentRunStatus(current.id, "cancelled");
      }
      await finishInterruptedTurn({
        flowId: cancelInput.flowId,
        sessionId: cancelInput.agentSessionId,
        transcriptId: cancelInput.agentSessionId,
        agentRunId: cancelInput.agentRunId,
        agentSessionId: cancelInput.agentSessionId,
        eventBus: input.eventBus,
        chatJournal: input.chatJournal,
      });
      await publishRun(cancelInput.agentRunId);
      return true;
    },
    confirmPermission: permissionGate,
    async resolvePermissionCard(resolution) {
      const waiter = permissionWaiters.get(resolution.cardId);
      const request = input.store.getDecisionRequest(resolution.cardId) as {
        flowId?: string; status?: string; agentRunId?: string;
      } | undefined;
      if (!request || request.flowId !== resolution.flowId) return false;
      const status = resolution.outcome === "approved" ? "approved"
        : resolution.outcome === "user_denied" ? "rejected"
          : "cancelled";
      if (request.status === "pending") {
        input.store.resolveDecisionRequest({
          requestId: resolution.cardId,
          status,
          clientActionId: resolution.actionId ?? `permission-${randomUUID()}`,
        });
      }
      waiter?.resolve(status);
      if (request.agentRunId) await publishRun(request.agentRunId);
      await input.eventBus.publish(resolution.flowId, {
        type: "decision_request:event",
        flow_id: resolution.flowId,
        data: input.store.getDecisionRequest(resolution.cardId),
      });
      return true;
    },
    async close() {
      await Promise.all([...activeByRun.values()].map(async (execution) => {
        execution.cancelled = true;
        execution.inputQueue.close();
        await execution.query?.close?.();
        for (const close of execution.closeBindings) await close();
      }));
      for (const waiter of permissionWaiters.values()) waiter.resolve("cancelled");
      activeByRun.clear();
      permissionWaiters.clear();
    },
  };
}

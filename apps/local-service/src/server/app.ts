import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import { config, DEFAULT_PROJECT_DIRECTORY_NAME, DEFAULT_PROJECT_ID } from "../config.js";
import { createStore, type Store } from "../db/store.js";
import { ChatJournal } from "../ws/chatJournal.js";
import { EventBus } from "../ws/eventBus.js";
import { createLeaderRuntime, type LeaderRuntime } from "../runtime/leaderRuntime.js";
import {
  createExpertRuntime,
  type ExpertConversationFinishedEvent,
  type ExpertRuntime,
  type ExpertTaskFinishedEvent,
} from "../runtime/expertRuntime.js";
import { createAgentDispatcher } from "../runtime/agentDispatcher.js";
import { leaderTranscriptChannelId } from "../domain/transcriptChannels.js";
import { ContextCompactionState } from "../runtime/contextCompactionState.js";
import type { AgentRuntimeAdapterFactory } from "../runtime/adapters/factory.js";
import { McpBridgeRegistry, registerMcpBridgeRoutes } from "../mcp/mcpBridgeRegistry.js";
import { DesktopBridge } from "./desktopBridge.js";
import { registerDesktopWsGateway } from "./desktopWsGateway.js";
import { registerHttpRoutes } from "./httpRoutes.js";
import { registerWsGateway, type WsConnection } from "./wsGateway.js";
import { MessageQueueCoordinator } from "../runtime/messageQueueCoordinator.js";
import { errorDiagnostic } from "../observability/operationalLogger.js";
import { clearNativeRuntimeSessionFiles } from "../protocol/runtimeMessageProtocolMigration.js";
import { createAgentRuntimeAdapter } from "../runtime/adapters/factory.js";
import {
  CodexAppServerPool,
  codexPoolKindForRuntimeConfig,
  createCodexPoolProcessOptionsResolver,
} from "../runtime/adapters/codexAppServerPool.js";
import { readAgentRuntimeConfigSnapshotSync } from "../config/agentRuntimeConfig.js";
import { migrateLegacyClaudeSessions } from "../runtime/nativeContextDiscovery.js";
import { cleanupOrphanChangeBaselines } from "../runtime/changeBaseline.js";
import { WorkspaceMutationCoordinator } from "../runtime/changeSetFileAttribution.js";

type CreateAppOptions = {
  databasePath?: string;
  store?: Store;
  eventBus?: EventBus;
  chatJournal?: ChatJournal;
  runtimeAdapterFactory?: AgentRuntimeAdapterFactory;
  logger?: FastifyServerOptions["logger"];
};

function createLeaderRun(store: Store, flowId: string, triggerKind: string, modelInput: Record<string, unknown>) {
  const leader = store.getLeaderAgentSession(flowId);
  if (!leader || store.getActiveAgentRun(leader.id)) return undefined;
  return store.createAgentRun({
    flowId,
    agentSessionId: leader.id,
    triggerKind,
    modelInput,
  });
}

export async function routeExpertResultToLeader(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn" | "guideLeaderTurn">;
  event: ExpertTaskFinishedEvent;
}) {
  const leader = input.store.getLeaderAgentSession(input.event.flowId);
  if (!leader) return false;
  const active = input.store.getActiveAgentRun(leader.id);
  if (active?.status === "running") {
    await input.leaderRuntime.guideLeaderTurn({
      flowId: input.event.flowId,
      leaderAgentRunId: active.id,
      content: `Expert Session ${input.event.agentSessionId} 返回：${input.event.summary}\nTask ${input.event.taskId} 当前仍为 ${input.event.taskStatus}，请自主决定下一步。`,
    });
    return true;
  }
  if (active) {
    input.store.enqueueLeaderRunTrigger({
      flowId: input.event.flowId,
      kind: "expert_result",
      sourceId: input.event.agentRunId,
      payload: { expert_result: input.event },
    });
    return true;
  }
  const run = createLeaderRun(input.store, input.event.flowId, "expert_result", { expert_result: input.event });
  if (!run) {
    input.store.enqueueLeaderRunTrigger({
      flowId: input.event.flowId,
      kind: "expert_result",
      sourceId: input.event.agentRunId,
      payload: { expert_result: input.event },
    });
    return true;
  }
  await input.leaderRuntime.runLeaderTurn({
    flowId: input.event.flowId,
    kind: "expert_result",
    expertResult: {
      taskId: input.event.taskId,
      agentRunId: input.event.agentRunId,
      agentSessionId: input.event.agentSessionId,
      agentDefinitionId: input.event.agentDefinitionId,
      taskStatus: input.event.taskStatus,
      status: input.event.status,
      turnOutcome: input.event.turnOutcome,
      summary: input.event.summary,
      error: input.event.error,
      artifactRefs: input.event.artifactRefs,
      filesChanged: input.event.filesChanged,
      metrics: input.event.metrics,
      completedAt: input.event.completedAt,
    },
    leaderAgentRunId: run.id,
    leaderSessionId: leader.id,
    resumeSessionId: leader.providerSessionId ?? undefined,
  });
  return true;
}

export async function routeExpertMessageToLeader(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn" | "guideLeaderTurn">;
  event: ExpertConversationFinishedEvent;
}) {
  const leader = input.store.getLeaderAgentSession(input.event.flowId);
  if (!leader) return false;
  const active = input.store.getActiveAgentRun(leader.id);
  if (active?.status === "running") {
    await input.leaderRuntime.guideLeaderTurn({
      flowId: input.event.flowId,
      leaderAgentRunId: active.id,
      content: `Expert Session ${input.event.agentSessionId} 回复：${input.event.summary}`,
    });
    return true;
  }
  if (active) {
    input.store.enqueueLeaderRunTrigger({
      flowId: input.event.flowId,
      kind: "expert_message",
      sourceId: input.event.agentRunId,
      payload: { expert_message: input.event },
    });
    return true;
  }
  const run = createLeaderRun(input.store, input.event.flowId, "expert_message", { expert_message: input.event });
  if (!run) {
    input.store.enqueueLeaderRunTrigger({
      flowId: input.event.flowId,
      kind: "expert_message",
      sourceId: input.event.agentRunId,
      payload: { expert_message: input.event },
    });
    return true;
  }
  await input.leaderRuntime.runLeaderTurn({
    flowId: input.event.flowId,
    kind: "expert_message",
    expertMessage: {
      taskId: input.event.taskId,
      agentRunId: input.event.agentRunId,
      agentSessionId: input.event.agentSessionId,
      agentDefinitionId: input.event.agentDefinitionId,
      status: input.event.status,
      turnOutcome: input.event.turnOutcome,
      summary: input.event.summary,
      error: input.event.error,
      artifactRefs: input.event.artifactRefs,
      filesChanged: input.event.filesChanged,
      metrics: input.event.metrics,
      completedAt: input.event.completedAt,
    },
    leaderAgentRunId: run.id,
    leaderSessionId: leader.id,
    resumeSessionId: leader.providerSessionId ?? undefined,
  });
  return true;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const processRunId = randomUUID();
  const databasePath = options.store ? null : options.databasePath ?? config.databasePath;
  const store = options.store ?? createStore(databasePath!);
  const migration = store.migrate({ beforeRuntimeMessageProtocolReset: clearNativeRuntimeSessionFiles });
  store.seedExperts();
  const sealedTranscriptMessageCount = store.sealActiveTranscriptMessages();
  const interruptedAgentRunCount = store.interruptStaleAgentRuns();
  app.log.info({
    event: "backend_process_started",
    processRunId,
    databasePath,
    migration,
    sealedTranscriptMessageCount,
    interruptedAgentRunCount,
  }, "SqualFlow backend process started");

  const defaultProjectPath = path.join(config.defaultProjectRoot, DEFAULT_PROJECT_DIRECTORY_NAME);
  fs.mkdirSync(defaultProjectPath, { recursive: true });
  fs.mkdirSync(config.runtimeScratchRoot, { recursive: true });
  migrateLegacyClaudeSessions({ runtimeScratchRoot: config.runtimeScratchRoot });
  const defaultProject = store.getProject(DEFAULT_PROJECT_ID) ?? store.createProject({
    id: DEFAULT_PROJECT_ID,
    name: "默认项目",
    localPath: defaultProjectPath,
    description: "SqualFlow 默认项目目录",
  });
  if (defaultProject.localPath !== defaultProjectPath || defaultProject.name !== "默认项目") {
    store.updateProject(DEFAULT_PROJECT_ID, {
      name: "默认项目",
      localPath: defaultProjectPath,
      description: "SqualFlow 默认项目目录",
    });
  }
  store.assignUnboundFlows(DEFAULT_PROJECT_ID);

  const eventBus = options.eventBus ?? new EventBus();
  const chatJournal = options.chatJournal ?? new ChatJournal(store, processRunId);
  const contextCompactions = new ContextCompactionState();
  const mcpBridgeRegistry = new McpBridgeRegistry();
  const codexAppServerPool = options.runtimeAdapterFactory ? null : new CodexAppServerPool({
    resolveProcessOptions: createCodexPoolProcessOptionsResolver({
      getRuntimeConfigs: () => readAgentRuntimeConfigSnapshotSync().configs,
      mcpCredential: mcpBridgeRegistry.credentials(),
    }),
  });
  const runtimeAdapterFactory = options.runtimeAdapterFactory ?? ((runtimeInput) => createAgentRuntimeAdapter({
    ...runtimeInput,
    codexClientFactory: runtimeInput.sdk === "codex" && codexAppServerPool
      ? codexAppServerPool.clientFactory(codexPoolKindForRuntimeConfig(runtimeInput.runtimeConfig))
      : undefined,
  }));
  const desktopBridge = new DesktopBridge();
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  let leaderRuntime: LeaderRuntime;
  let expertRuntime: ExpertRuntime;

  const deliverTaskResult = async (event: ExpertTaskFinishedEvent) => {
    try {
      await routeExpertResultToLeader({ store, leaderRuntime, event });
    } catch (error) {
      app.log.error({ flowId: event.flowId, taskId: event.taskId, agentRunId: event.agentRunId, ...errorDiagnostic(error) },
        "failed to deliver Expert result to Leader");
    }
  };
  const deliverExpertMessage = async (event: ExpertConversationFinishedEvent) => {
    try {
      await routeExpertMessageToLeader({ store, leaderRuntime, event });
    } catch (error) {
      app.log.error({ flowId: event.flowId, agentRunId: event.agentRunId, ...errorDiagnostic(error) },
        "failed to deliver Expert message to Leader");
    }
  };
  expertRuntime = createExpertRuntime({
    store,
    eventBus,
    chatJournal,
    runtimeAdapterFactory,
    mcpBridgeRegistry,
    desktopBridge,
    logger: app.log,
    mutationCoordinator,
    onTaskFinished: deliverTaskResult,
    onConversationFinished: deliverExpertMessage,
    onTaskUpdated: async ({ flowId, task }) => {
      await eventBus.publish(flowId, { type: "task:event", flow_id: flowId, data: task });
    },
  });
  const agentDispatcher = createAgentDispatcher({ store, eventBus, expertRuntime });
  leaderRuntime = createLeaderRuntime({
    store,
    eventBus,
    chatJournal,
    runtimeAdapterFactory,
    agentDispatcher,
    contextCompactions,
    mcpBridgeRegistry,
    desktopBridge,
    logger: app.log,
    mutationCoordinator,
    permissionGate: expertRuntime.confirmPermission,
  });

  let messageQueueCoordinator!: MessageQueueCoordinator;
  messageQueueCoordinator = new MessageQueueCoordinator({
    store,
    eventBus,
    logger: app.log,
    connectionForFlow: (flowId): WsConnection => ({
      clientId: `queue-coordinator:${flowId}`,
      subscriptions: new Set([flowId]),
      eventBus,
      store,
      chatJournal,
      leaderRuntime,
      expertRuntime,
      logger: app.log,
      processRunId,
      requestQueueDrain: messageQueueCoordinator.request,
      send: async (message) => {
        if (message.type === "system:error" && message.flow_id === flowId) await eventBus.publish(flowId, message);
      },
    }),
  });
  const recoveredSubmissions = messageQueueCoordinator.start();
  app.log.info({ event: "message_submission_recovery_completed", ...recoveredSubmissions }, "message recovery completed");
  const baselineCleanup = cleanupOrphanChangeBaselines(store);
  app.log.info({ event: "change_baseline_recovery_completed", ...baselineCleanup }, "change baseline recovery completed");

  app.addHook("onClose", async () => {
    await messageQueueCoordinator.close();
    await Promise.allSettled([expertRuntime.close?.(), leaderRuntime.close?.()]);
    codexAppServerPool?.close();
    await mcpBridgeRegistry.close();
    if (!options.store) store.sqlite.close();
  });

  app.register(websocket);
  app.after(() => {
    registerMcpBridgeRoutes(app, mcpBridgeRegistry);
    registerDesktopWsGateway(app, desktopBridge);
    registerHttpRoutes(app, {
      store,
      leaderRuntime,
      contextCompactions,
      onRuntimeConfigChanged: () => codexAppServerPool?.invalidate("custom"),
    });
    registerWsGateway(app, {
      eventBus,
      chatJournal,
      store,
      leaderRuntime,
      expertRuntime,
      logger: app.log,
      processRunId,
      requestQueueDrain: messageQueueCoordinator.request,
    });
  });
  return app;
}

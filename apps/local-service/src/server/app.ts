import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import { config, DEFAULT_PROJECT_DIRECTORY_NAME, DEFAULT_PROJECT_ID } from "../config.js";
import { createStore, type Store } from "../db/store.js";
import { ChatJournal } from "../ws/chatJournal.js";
import { EventBus } from "../ws/eventBus.js";
import { createLeaderRuntime } from "../runtime/leaderRuntime.js";
import type { LeaderRuntime } from "../runtime/leaderRuntime.js";
import {
  createExpertRuntime,
  type ExpertConversationFinishedEvent,
  type ExpertRuntime,
  type ExpertTaskFinishedEvent,
} from "../runtime/expertRuntime.js";
import { createAgentDispatcher } from "../runtime/agentDispatcher.js";
import { createOrchestrationScheduler } from "../runtime/orchestrationScheduler.js";
import { finalizeWorkRun, pauseWorkRunIfAwaitingPlanFeedback, publishWorkRunEvent } from "../domain/workRun.js";
import { leaderTranscriptChannelId } from "../domain/transcriptChannels.js";
import { ContextCompactionState } from "../runtime/contextCompactionState.js";
import type { AgentRuntimeAdapterFactory } from "../runtime/adapters/factory.js";
import { McpBridgeRegistry, registerMcpBridgeRoutes } from "../mcp/mcpBridgeRegistry.js";
import { DesktopBridge } from "./desktopBridge.js";
import { registerDesktopWsGateway } from "./desktopWsGateway.js";
import { registerHttpRoutes } from "./httpRoutes.js";
import {
  recoverPendingDecisionCardLeaderInputs,
  publishInterruptedSessions,
  registerWsGateway,
  type WsConnection,
} from "./wsGateway.js";
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
import { WorkspaceMutationCoordinator } from "../runtime/workRunFileAttribution.js";

type CreateAppOptions = {
  databasePath?: string;
  store?: Store;
  eventBus?: EventBus;
  chatJournal?: ChatJournal;
  runtimeAdapterFactory?: AgentRuntimeAdapterFactory;
  logger?: FastifyServerOptions["logger"];
};

export async function routeExpertResultToLeader(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn">;
  event: ExpertTaskFinishedEvent;
}) {
  const { event } = input;
  const flowLeaderSessionId = input.store.getFlow(event.flowId)?.leaderSessionId ?? null;
  const workRun = input.store.getWorkRun(event.workRunId);
  if (
    !workRun
    || !workRun.executionStartedAt
    || !["executing", "waiting_user"].includes(workRun.status)
  ) return false;
  const leaderAgentSession = input.store.createAgentSession({
    flowId: event.flowId,
    workRunId: event.workRunId,
    expertId: "exp-leader",
    sessionId: flowLeaderSessionId,
    displayName: "Leader",
    status: "queued",
  });
  if (!leaderAgentSession) return false;

  await input.leaderRuntime.runLeaderTurn({
    flowId: event.flowId,
    kind: "expert_result",
    workRunId: event.workRunId,
    expertResult: {
      taskId: event.taskId,
      agentSessionId: event.agentSessionId,
      expertId: event.expertId,
      status: event.status,
      taskStatus: event.taskStatus,
      turnOutcome: event.turnOutcome,
      summary: event.summary,
      error: event.error,
      artifactRefs: event.artifactRefs,
      filesChanged: event.filesChanged,
      metrics: event.metrics,
      completedAt: event.completedAt,
    },
    leaderAgentSessionId: leaderAgentSession.id,
    leaderSessionId: leaderTranscriptChannelId(event.flowId),
    resumeSessionId: flowLeaderSessionId ?? undefined,
  });
  return true;
}

export async function routeExpertMessageToLeader(input: {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn">;
  event: ExpertConversationFinishedEvent;
}) {
  const { event } = input;
  const flowLeaderSessionId = input.store.getFlow(event.flowId)?.leaderSessionId ?? null;
  const workRun = event.workRunId ? input.store.getWorkRun(event.workRunId) : undefined;
  if (workRun && (!workRun.executionStartedAt || workRun.status !== "executing")) return false;
  const leaderAgentSession = input.store.createAgentSession({
    flowId: event.flowId,
    workRunId: event.workRunId ?? null,
    expertId: "exp-leader",
    sessionId: flowLeaderSessionId,
    displayName: "Leader",
    status: "queued",
  });
  if (!leaderAgentSession) return false;

  await input.leaderRuntime.runLeaderTurn({
    flowId: event.flowId,
    kind: "expert_message",
    workRunId: event.workRunId ?? undefined,
    expertMessage: {
      agentSessionId: event.agentSessionId,
      expertId: event.expertId,
      status: event.status,
      turnOutcome: event.turnOutcome,
      summary: event.summary,
      error: event.error,
      artifactRefs: event.artifactRefs,
      filesChanged: event.filesChanged,
      metrics: event.metrics,
      completedAt: event.completedAt,
    },
    leaderAgentSessionId: leaderAgentSession.id,
    leaderSessionId: leaderTranscriptChannelId(event.flowId),
    resumeSessionId: flowLeaderSessionId ?? undefined,
  });
  return true;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const runId = randomUUID();
  const databasePath = options.store ? null : options.databasePath ?? config.databasePath;
  const store = options.store ?? createStore(databasePath!);
  store.migrate({ beforeRuntimeMessageProtocolReset: clearNativeRuntimeSessionFiles });
  const sealedTranscriptMessageCount = store.sealActiveTranscriptMessages();
  const staleLeaderSessions = store.interruptStaleLeaderSessions();
  app.log.info({
    event: "backend_process_started",
    runId,
    backendVersion: process.env.npm_package_version ?? "0.1.0",
    pid: process.pid,
    databasePath,
    sealedTranscriptMessageCount,
    ...staleLeaderSessions,
  }, "SquadFlow backend process started");
  const defaultProjectPath = path.join(config.defaultProjectRoot, DEFAULT_PROJECT_DIRECTORY_NAME);
  const mutationCoordinator = new WorkspaceMutationCoordinator();
  fs.mkdirSync(defaultProjectPath, { recursive: true });
  fs.mkdirSync(config.runtimeScratchRoot, { recursive: true });
  const claudeSessionMigration = migrateLegacyClaudeSessions({
    runtimeScratchRoot: config.runtimeScratchRoot,
  });
  if (claudeSessionMigration.filesCopied > 0) {
    app.log.info({
      event: "claude_sessions_migrated",
      ...claudeSessionMigration,
    }, "Migrated legacy isolated Claude sessions into the shared Claude config");
  }
  const defaultProject = store.getProject(DEFAULT_PROJECT_ID)
    ?? store.createProject({
      id: DEFAULT_PROJECT_ID,
      name: "默认项目",
      localPath: defaultProjectPath,
      description: "SquadFlow 默认项目目录",
    });
  if (defaultProject.localPath !== defaultProjectPath || defaultProject.name !== "默认项目") {
    store.updateProject(DEFAULT_PROJECT_ID, {
      name: "默认项目",
      localPath: defaultProjectPath,
      description: "SquadFlow 默认项目目录",
    });
  }
  store.assignUnboundFlows(DEFAULT_PROJECT_ID);
  store.seedExperts();

  const eventBus = options.eventBus ?? new EventBus();
  const chatJournal = options.chatJournal ?? new ChatJournal(store, runId);
  const contextCompactions = new ContextCompactionState();
  const mcpBridgeRegistry = new McpBridgeRegistry();
  const codexAppServerPool = options.runtimeAdapterFactory
    ? null
    : new CodexAppServerPool({
        resolveProcessOptions: createCodexPoolProcessOptionsResolver({
          getRuntimeConfigs: () => readAgentRuntimeConfigSnapshotSync().configs,
          mcpCredential: mcpBridgeRegistry.credentials(),
        }),
      });
  const runtimeAdapterFactory = options.runtimeAdapterFactory ?? ((input) => createAgentRuntimeAdapter({
    ...input,
    codexClientFactory: input.sdk === "codex" && codexAppServerPool
      ? codexAppServerPool.clientFactory(codexPoolKindForRuntimeConfig(input.runtimeConfig))
      : undefined,
  }));
  const desktopBridge = new DesktopBridge();
  let leaderRuntime: LeaderRuntime;
  let expertRuntime: ExpertRuntime;
  // This is a deterministic plan ledger only. It never decides or changes a
  // Task; explicit Leader/Expert task-tool mutations are its only inputs.
  const orchestrationScheduler = createOrchestrationScheduler({ store, eventBus });
  const deliverExpertResultToLeader = async (event: ExpertTaskFinishedEvent) => {
    try {
      await routeExpertResultToLeader({ store, leaderRuntime, event });
    } catch (error) {
      app.log.error({
        flowId: event.flowId,
        workRunId: event.workRunId,
        taskId: event.taskId,
        ...errorDiagnostic(error),
      }, "failed to deliver Expert result to Leader");
      expertRuntime?.cancelWorkRun({ flowId: event.flowId, workRunId: event.workRunId });
      // A delivery/provider failure is not an actor-authored Task cancellation.
      // Preserve Task state; only the execution transport/WorkRun is stopped.
      for (const session of store.listAgentSessions(event.flowId)) {
        if (session.workRunId === event.workRunId && ['queued', 'streaming'].includes(session.status)) {
          store.updateAgentSessionStatus(session.id, 'interrupted');
        }
      }
      store.cancelWorkRunPendingActions(event.workRunId);
      await finalizeWorkRun({ store, eventBus, chatJournal, workRunId: event.workRunId, terminalStatus: "failed" });
      app.log.error({
        flowId: event.flowId,
        workRunId: event.workRunId,
        ...errorDiagnostic(error),
      }, "WorkRun failed after Leader delivery error");
    }
  };
  const deliverExpertMessageToLeader = async (event: ExpertConversationFinishedEvent) => {
    try {
      await routeExpertMessageToLeader({ store, leaderRuntime, event });
    } catch (error) {
      app.log.error({
        flowId: event.flowId,
        workRunId: event.workRunId,
        agentSessionId: event.agentSessionId,
        ...errorDiagnostic(error),
      }, "failed to deliver taskless Expert message to Leader");
      if (event.workRunId) {
        expertRuntime?.cancelWorkRun({ flowId: event.flowId, workRunId: event.workRunId });
        await finalizeWorkRun({ store, eventBus, chatJournal, workRunId: event.workRunId, terminalStatus: "failed" });
      }
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
    onTaskFinished: deliverExpertResultToLeader,
    onConversationFinished: deliverExpertMessageToLeader,
    onTaskUpdated: async ({ flowId, task }) => {
      await eventBus.publish(flowId, {
        type: "task:event",
        flow_id: flowId,
        data: {
          task_id: task.task_id,
          work_run_id: task.work_run_id,
          expert_id: task.assignment.expert_id,
          flow_expert_id: task.assignment.flow_expert_id,
          status: task.status,
          task,
        },
      });
      await orchestrationScheduler.advanceForTask(task.task_id);
    },
  });
  const agentDispatcher = createAgentDispatcher({
    store,
    eventBus,
    expertRuntime,
    onTaskFinished: deliverExpertResultToLeader,
    onConversationFinished: deliverExpertMessageToLeader,
  });
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
    orchestrationScheduler,
    permissionGate: expertRuntime.confirmPermission,
    onWorkRunFatal: ({ flowId, workRunId }) => {
      expertRuntime.cancelWorkRun({ flowId, workRunId });
    },
    onWorkRunAction: ({ flowId, workRunId, action }) => {
      if (action === "interrupt" || action === "cancel") {
        expertRuntime.cancelWorkRun({ flowId, workRunId });
        void publishInterruptedSessions(
          { store, eventBus, chatJournal },
          flowId,
          undefined,
          { workRunId, includeLeader: false },
        );
      }
    },
  });

  const messageQueueCoordinator: MessageQueueCoordinator = new MessageQueueCoordinator({
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
      orchestrationScheduler,
      logger: app.log,
      runId,
      requestQueueDrain: messageQueueCoordinator.request,
      send: async (message) => {
        if (message.type === "system:error" && message.flow_id === flowId) {
          await eventBus.publish(flowId, message);
        }
      },
    }),
  });
  const recoveredSubmissions = messageQueueCoordinator.start();
  app.log.info({ event: "message_submission_recovery_completed", runId, ...recoveredSubmissions }, "message submission recovery completed");
  void orchestrationScheduler.recover().then(() => {
    app.log.info({ event: "orchestration_recovery_completed", runId }, "orchestration recovery completed");
  }).catch((error) => {
    app.log.error({ event: "orchestration_recovery_failed", runId, ...errorDiagnostic(error) }, "orchestration recovery failed");
  });

  const staleExpertSessions = store.interruptStaleExpertSessions();
  app.log.info({
    event: "stale_runtime_sessions_interrupted",
    runId,
    ...staleExpertSessions,
  }, "stale runtime sessions interrupted");
  const baselineCleanup = cleanupOrphanChangeBaselines(store);
  app.log.info({ event: "change_baseline_recovery_completed", runId, ...baselineCleanup }, "change baseline recovery completed");

  for (const flow of store.listFlows()) {
    const openTurn = store.getOpenWorkRun(flow.id);
    if (openTurn?.status === "executing") pauseWorkRunIfAwaitingPlanFeedback(store, openTurn.id);
  }

  void recoverPendingDecisionCardLeaderInputs({
    store,
    leaderRuntime,
    onError: (error, inputId) => {
      app.log.error({ inputId, ...errorDiagnostic(error) }, "failed to recover pending decision-card Leader input");
    },
  }).then((result) => {
    app.log.info({ event: "decision_input_recovery_completed", runId, ...result }, "decision-card Leader input recovery completed");
  }).catch((error) => {
    app.log.error({ event: "decision_input_recovery_failed", runId, ...errorDiagnostic(error) }, "decision-card Leader input recovery failed");
  });

  app.addHook("onClose", async () => {
    await messageQueueCoordinator.close();
    const runtimeResults = await Promise.allSettled([
      expertRuntime.close?.(),
      leaderRuntime.close?.(),
    ]);
    codexAppServerPool?.close();
    await mcpBridgeRegistry.close();
    if (!options.store) store.sqlite.close();
    const failedRuntime = runtimeResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedRuntime) throw failedRuntime.reason;
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
      orchestrationScheduler,
      logger: app.log,
      runId,
      requestQueueDrain: messageQueueCoordinator.request,
    });
  });

  return app;
}

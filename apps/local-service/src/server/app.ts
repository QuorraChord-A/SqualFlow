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
import { createExpertRuntime, type ExpertRuntime, type ExpertTaskFinishedEvent } from "../runtime/expertRuntime.js";
import { createAgentDispatcher } from "../runtime/agentDispatcher.js";
import { createOrchestrationScheduler, type OrchestrationScheduler } from "../runtime/orchestrationScheduler.js";
import { listUserTurnsNeedingRecovery } from "../runtime/userTurnLifecycle.js";
import { pauseUserTurnIfAwaitingPlanFeedback, publishUserTurnEvent } from "../domain/userTurn.js";
import { ContextCompactionState } from "../runtime/contextCompactionState.js";
import type { AgentRuntimeAdapterFactory } from "../runtime/adapters/factory.js";
import { McpBridgeRegistry, registerMcpBridgeRoutes } from "../mcp/mcpBridgeRegistry.js";
import { DesktopBridge } from "./desktopBridge.js";
import { registerDesktopWsGateway } from "./desktopWsGateway.js";
import { registerHttpRoutes } from "./httpRoutes.js";
import {
  recoverPendingDecisionCardLeaderInputs,
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
  orchestrationScheduler?: Pick<OrchestrationScheduler, "advanceForTask">;
  leaderRuntime: Pick<LeaderRuntime, "runLeaderTurn">;
  event: ExpertTaskFinishedEvent;
}) {
  const { event } = input;
  await input.orchestrationScheduler?.advanceForTask(event.taskId);
  const leaderAgentSession = input.store
    .listAgentSessions(event.flowId)
    .find((session) => session.expertId === "exp-leader" && session.taskId === null);
  const leaderSessionId = input.store.getFlow(event.flowId)?.leaderSessionId ?? leaderAgentSession?.sessionId ?? "";
  const userTurn = input.store.getUserTurn(event.userTurnId);
  if (
    !leaderAgentSession
    || !leaderSessionId
    || !userTurn
    || ["completed", "failed", "cancelled"].includes(userTurn.status)
  ) return false;

  await input.leaderRuntime.runLeaderTurn({
    flowId: event.flowId,
    kind: "expert_result",
    userTurnId: event.userTurnId,
    expertResult: {
      taskId: event.taskId,
      agentSessionId: event.agentSessionId,
      expertId: event.expertId,
      status: event.status,
      turnOutcome: event.turnOutcome,
      summary: event.summary,
      error: event.error,
      artifactRefs: event.artifactRefs,
      completedAt: event.completedAt,
    },
    leaderAgentSessionId: leaderAgentSession.id,
    leaderSessionId,
    resumeSessionId: leaderSessionId,
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
  const staleRuntimeRecovery = store.expireStaleLeaderRuntimeState();
  app.log.info({
    event: "backend_process_started",
    runId,
    backendVersion: process.env.npm_package_version ?? "0.1.0",
    pid: process.pid,
    databasePath,
    sealedTranscriptMessageCount,
    ...staleRuntimeRecovery,
  }, "SquadFlow backend process started");
  const defaultProjectPath = path.join(config.defaultProjectRoot, DEFAULT_PROJECT_DIRECTORY_NAME);
  fs.mkdirSync(defaultProjectPath, { recursive: true });
  fs.mkdirSync(config.runtimeScratchRoot, { recursive: true });
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
  let orchestrationScheduler: OrchestrationScheduler;
  const deliverExpertResultToLeader = async (event: ExpertTaskFinishedEvent) => {
    try {
      await routeExpertResultToLeader({ store, orchestrationScheduler, leaderRuntime, event });
    } catch (error) {
      app.log.error({
        flowId: event.flowId,
        userTurnId: event.userTurnId,
        taskId: event.taskId,
        ...errorDiagnostic(error),
      }, "failed to deliver Expert result to Leader");
      expertRuntime?.cancelUserTurn({ flowId: event.flowId, userTurnId: event.userTurnId });
      for (const task of store.listUserTurnTasks(event.userTurnId)) {
        if (!['completed', 'failed', 'cancelled'].includes(task.status)) store.cancelTask(task.id);
      }
      for (const session of store.listAgentSessions(event.flowId)) {
        if (session.userTurnId === event.userTurnId && ['queued', 'streaming'].includes(session.status)) {
          store.updateAgentSessionStatus(session.id, 'interrupted');
        }
      }
      store.cancelUserTurnPendingActions(event.userTurnId);
      const failedTurn = store.failUserTurn(event.userTurnId, "failed");
      if (failedTurn) await publishUserTurnEvent(eventBus, failedTurn);
      app.log.error({
        flowId: event.flowId,
        userTurnId: event.userTurnId,
        ...errorDiagnostic(error),
      }, "UserTurn failed after Leader delivery error");
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
    onTaskFinished: deliverExpertResultToLeader,
  });
  const agentDispatcher = createAgentDispatcher({ store, eventBus, expertRuntime, onTaskFinished: deliverExpertResultToLeader });
  orchestrationScheduler = createOrchestrationScheduler({ store, eventBus });
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
    orchestrationScheduler,
    permissionGate: expertRuntime.confirmPermission,
    onUserTurnFatal: ({ flowId, userTurnId }) => {
      expertRuntime.cancelUserTurn({ flowId, userTurnId });
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

  const recoverableExpertWork = store.recoverFlowExpertRuntimeWork();
  const recoverableUserTurns = listUserTurnsNeedingRecovery(store);
  app.log.info({
    event: "runtime_recovery_scheduled",
    runId,
    expertTaskCount: recoverableExpertWork.length,
    leaderUserTurnCount: recoverableUserTurns.length,
  }, "runtime recovery work scheduled");

  for (const item of recoverableExpertWork) {
    void expertRuntime.runTask({
      flowId: item.flowId,
      userTurnId: item.userTurnId,
      taskId: item.taskId,
      flowExpertId: item.flowExpertId,
      agentSessionId: item.agentSessionId,
      prompt: item.prompt,
      resumeSessionId: item.resumeSessionId,
    }).catch((error) => {
      app.log.error({
        flowId: item.flowId,
        userTurnId: item.userTurnId,
        taskId: item.taskId,
        ...errorDiagnostic(error),
      }, "failed to recover Flow Expert task");
    });
  }

  for (const flow of store.listFlows()) {
    const openTurn = store.getOpenUserTurn(flow.id);
    if (openTurn?.status === "active") pauseUserTurnIfAwaitingPlanFeedback(store, openTurn.id);
  }

  for (const turn of recoverableUserTurns) {
    const leaderAgentSession = store.listAgentSessions(turn.flowId)
      .find((session) => session.expertId === "exp-leader" && session.taskId === null);
    const leaderSessionId = store.getFlow(turn.flowId)?.leaderSessionId ?? leaderAgentSession?.sessionId ?? "";
    if (!leaderAgentSession || !leaderSessionId) continue;
    void leaderRuntime.runLeaderTurn({
      flowId: turn.flowId,
      kind: "user_turn_recovery",
      userTurnId: turn.id,
      leaderAgentSessionId: leaderAgentSession.id,
      leaderSessionId,
      resumeSessionId: leaderSessionId,
    }).catch((error) => {
      app.log.error({ flowId: turn.flowId, userTurnId: turn.id, ...errorDiagnostic(error) }, "failed to recover UserTurn Leader work");
    });
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

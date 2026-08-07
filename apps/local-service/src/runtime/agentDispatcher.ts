import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.js";
import type { EventBus } from "../ws/eventBus.js";
import { isExpertRuntimeEnabled, readAgentRuntimeConfigSnapshot } from "../config/agentRuntimeConfig.js";
import type {
  ExpertConversationFinishedEvent,
  ExpertRuntime,
  ExpertTaskFinishedEvent,
} from "./expertRuntime.js";

export type AgentDispatcher = {
  dispatchAgent: (input: {
    flowId: string;
    taskId: string;
    agentDefinitionId: string;
    prompt?: string;
  }) => Promise<{
    agent_run_id: string;
    agent_session_id?: string;
    status: string;
    agent_definition_id?: string;
    task_id?: string | null;
    task?: Record<string, unknown>;
    error?: string;
  }>;
  sendMessage: (input: {
    flowId: string;
    agentSessionId: string;
    taskId?: string;
    message: string;
  }) => Promise<{
    accepted: boolean;
    agent_run_id?: string;
    message_id?: string;
    error?: { code: string; message: string };
  }>;
  cancelAgent: (input: { flowId: string; agentSessionId: string }) => Promise<{
    ok: boolean;
    idempotent?: boolean;
    agentRun?: NonNullable<ReturnType<Store["getAgentRun"]>>;
    error?: { code: string; message: string };
  }>;
};

function taskProjection(store: Store, task: NonNullable<ReturnType<Store["getTask"]>>) {
  return {
    task_id: task.id,
    flow_id: task.flowId,
    subject: task.title,
    description: task.description,
    active_form: task.activeForm,
    progress: task.progress,
    status: task.status,
    revision: task.revision,
    recommended_agent_definition_id: task.recommendedAgentDefinitionId,
    agent_session_id: task.agentSessionId,
    blocked_by: store.listTaskDependencies(task.id),
  };
}

async function auditLeaderMessage(store: Store, runId: string, message: string) {
  const run = store.getAgentRun(runId);
  if (!run) return "";
  const messageId = `msg-leader-${Date.now()}-${randomUUID().slice(0, 6)}`;
  store.appendEventLog({
    flowId: run.flowId,
    taskId: run.taskId,
    agentRunId: run.id,
    eventType: "agent_run.leader_message",
    payload: { message_id: messageId, message, created_at: new Date().toISOString() },
  });
  return messageId;
}

export function createAgentDispatcher(input: {
  store: Store;
  eventBus: EventBus;
  expertRuntime: Pick<ExpertRuntime, "runTask" | "runConversation" | "sendMessage" | "cancelAgent">;
  onTaskFinished?: (event: ExpertTaskFinishedEvent) => Promise<void> | void;
  onConversationFinished?: (event: ExpertConversationFinishedEvent) => Promise<void> | void;
}): AgentDispatcher {
  async function definitionIsEnabled(agentDefinitionId: string) {
    const definition = input.store.getAgentDefinition(agentDefinitionId);
    if (!definition || definition.role === "leader") return false;
    return isExpertRuntimeEnabled((await readAgentRuntimeConfigSnapshot()).roles, definition.role);
  }

  async function publishSession(sessionId: string, runId: string | null) {
    const session = input.store.getAgentSession(sessionId);
    if (!session) return;
    await input.eventBus.publish(session.flowId, {
      type: "agent_session:event",
      flow_id: session.flowId,
      data: {
        agent_session_id: session.id,
        agent_definition_id: session.agentDefinitionId,
        display_name: session.displayName,
        active_agent_run_id: runId,
      },
    });
  }

  async function publishRun(runId: string) {
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
  }

  return {
    async dispatchAgent(dispatch) {
      const task = input.store.getTask(dispatch.taskId);
      const definition = input.store.getAgentDefinition(dispatch.agentDefinitionId);
      if (!task || task.flowId !== dispatch.flowId) return { agent_run_id: "", status: "failed", error: "TASK_NOT_FOUND" };
      if (!definition || definition.role === "leader") return { agent_run_id: "", status: "failed", error: "AGENT_DEFINITION_NOT_FOUND" };
      if (!(await definitionIsEnabled(definition.id))) return { agent_run_id: "", status: "failed", error: "AGENT_DEFINITION_DISABLED" };
      if (!["pending", "in_progress", "blocked"].includes(task.status)) {
        return { agent_run_id: "", status: "failed", error: "TASK_NOT_DISPATCHABLE" };
      }
      if (!input.store.listTaskDependencies(task.id).every((dependencyId) => input.store.getTask(dependencyId)?.status === "completed")) {
        return { agent_run_id: "", status: "failed", error: "TASK_DEPENDENCY_BLOCKED" };
      }

      const session = input.store.createAgentSession({
        flowId: dispatch.flowId,
        agentDefinitionId: definition.id,
      });
      if (!session) return { agent_run_id: "", status: "failed", error: "AGENT_SESSION_CREATE_FAILED" };
      const run = input.store.createAgentRun({
        flowId: dispatch.flowId,
        agentSessionId: session.id,
        taskId: task.id,
        triggerKind: "dispatch",
        modelInput: { prompt: dispatch.prompt ?? "" },
      });
      if (!run) return { agent_run_id: "", status: "failed", error: "AGENT_RUN_CREATE_FAILED" };
      input.store.bindTaskAgentSession(task.id, session.id);
      await publishSession(session.id, run.id);
      await publishRun(run.id);
      await auditLeaderMessage(input.store, run.id, dispatch.prompt ?? "");

      void input.expertRuntime.runTask({
        flowId: dispatch.flowId,
        taskId: task.id,
        agentSessionId: session.id,
        agentRunId: run.id,
        prompt: dispatch.prompt || undefined,
        resumeSessionId: undefined,
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        input.store.updateAgentRunStatus(run.id, "failed", message);
        await publishRun(run.id);
      });

      return {
        agent_run_id: run.id,
        agent_session_id: session.id,
        status: run.status,
        agent_definition_id: definition.id,
        task_id: task.id,
        task: taskProjection(input.store, input.store.getTask(task.id)!),
      };
    },

    async sendMessage(message) {
      const session = input.store.getAgentSession(message.agentSessionId);
      if (!session || session.flowId !== message.flowId || session.role !== "expert") {
        return { accepted: false, error: { code: "AGENT_SESSION_NOT_FOUND", message: "AgentSession 不存在或不属于当前 Flow" } };
      }
      if (!(await definitionIsEnabled(session.agentDefinitionId))) {
        return { accepted: false, error: { code: "AGENT_DEFINITION_DISABLED", message: "AgentDefinition 当前不可用" } };
      }
      if (message.taskId) {
        const task = input.store.getTask(message.taskId);
        if (!task || task.flowId !== message.flowId) {
          return { accepted: false, error: { code: "TASK_NOT_FOUND", message: "Task 不存在或不属于当前 Flow" } };
        }
      }
      const active = input.store.getActiveAgentRun(session.id);
      if (active) {
        const accepted = input.expertRuntime.sendMessage({
          flowId: message.flowId,
          agentSessionId: session.id,
          agentRunId: active.id,
          content: message.message,
        });
        if (!accepted) return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "当前 AgentRun 暂时无法接收引导消息" },
        };
        return {
          accepted: true,
          agent_run_id: active.id,
          message_id: await auditLeaderMessage(input.store, active.id, message.message),
        };
      }

      const run = input.store.createAgentRun({
        flowId: message.flowId,
        agentSessionId: session.id,
        taskId: message.taskId ?? null,
        triggerKind: "leader_message",
        modelInput: { message: message.message },
      });
      if (!run) return { accepted: false, error: { code: "AGENT_RUN_CREATE_FAILED", message: "无法创建新的 AgentRun" } };
      if (message.taskId) input.store.bindTaskAgentSession(message.taskId, session.id);
      await publishSession(session.id, run.id);
      await publishRun(run.id);
      const messageId = await auditLeaderMessage(input.store, run.id, message.message);
      void input.expertRuntime.runConversation({
        flowId: message.flowId,
        taskId: message.taskId,
        agentSessionId: session.id,
        agentRunId: run.id,
        content: message.message,
        resumeSessionId: session.providerSessionId ?? undefined,
      }).catch(async (error) => {
        const failure = error instanceof Error ? error.message : String(error);
        input.store.updateAgentRunStatus(run.id, "failed", failure);
        await publishRun(run.id);
      });
      return { accepted: true, agent_run_id: run.id, message_id: messageId };
    },

    async cancelAgent(message) {
      const session = input.store.getAgentSession(message.agentSessionId);
      if (!session || session.flowId !== message.flowId || session.role !== "expert") {
        return { ok: false, error: { code: "AGENT_SESSION_NOT_FOUND", message: "AgentSession 不存在或不属于当前 Flow" } };
      }
      const active = input.store.getActiveAgentRun(session.id);
      if (!active) {
        return { ok: true, idempotent: true, agentRun: input.store.listAgentSessionRuns(session.id).at(-1) };
      }
      const cancelled = await input.expertRuntime.cancelAgent({
        flowId: message.flowId,
        agentSessionId: session.id,
        agentRunId: active.id,
      });
      if (!cancelled) return { ok: false, error: { code: "AGENT_CANCEL_FAILED", message: "无法取消当前 AgentRun" } };
      if (input.store.getAgentRun(active.id)?.status !== "cancelled") input.store.updateAgentRunStatus(active.id, "cancelled");
      await publishRun(active.id);
      await publishSession(session.id, null);
      return { ok: true, idempotent: false, agentRun: input.store.getAgentRun(active.id) };
    },
  };
}

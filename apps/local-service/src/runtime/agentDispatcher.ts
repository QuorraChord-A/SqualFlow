import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.js";
import { isExpertRuntimeEnabled, readAgentRuntimeConfigSnapshot } from "../config/agentRuntimeConfig.js";
import type { EventBus } from "../ws/eventBus.js";
import type { ExpertRuntime, ExpertTaskFinishedEvent } from "./expertRuntime.js";

export type AgentDispatcher = {
  dispatchAgent: (input: {
    flowId: string;
    taskId: string | null;
    expertId: string;
    prompt: string;
    resumeAgentSessionId: string;
  }) => Promise<{
    agent_session_id: string;
    flow_expert_id?: string;
    status: string;
    expert_id?: string;
    task_id?: string | null;
    user_turn_id?: string | null;
    task?: {
      task_id: string;
      user_turn_id: string;
      subject: string;
      description: string;
      active_form: string;
      status: string;
      expert_id: string | null;
      flow_expert_id: string | null;
      agent_session_id: string | null;
    };
    error?: string;
  }>;
  sendMessage: (input: {
    flowId: string;
    agentSessionId: string;
    content: string;
    summary?: string;
  }) => Promise<{
    accepted: boolean;
    message_id?: string;
    error?: { code: string; message: string };
  }>;
  cancelAgent: (input: {
    flowId: string;
    userTurnId: string;
    taskId: string;
    agentSessionId: string;
  }) => Promise<{
    ok: true;
    task: NonNullable<ReturnType<Store["getTask"]>>;
    agentSession: NonNullable<ReturnType<Store["getAgentSession"]>>;
  } | {
    ok: false;
    error: { code: string; message: string };
  }>;
};

function parseTaskMetadata(metadataJson: string | null): { planRevisionId: string | null; resourceKeys: string[] } {
  try {
    const parsed = JSON.parse(metadataJson ?? "{}") as Record<string, unknown>;
    const planRevisionId = typeof parsed.plan_revision_id === "string" ? parsed.plan_revision_id : null;
    const resourceKeys = Array.isArray(parsed.resource_keys)
      ? parsed.resource_keys.filter((key): key is string => typeof key === "string")
      : [];
    return { planRevisionId, resourceKeys };
  } catch {
    return { planRevisionId: null, resourceKeys: [] };
  }
}

async function recordLeaderInputAudit(
  store: Store,
  session: NonNullable<ReturnType<Store["getAgentSession"]>>,
  summary = "",
) {
  const messageId = `msg-leader-${Date.now()}-${randomUUID().slice(0, 6)}`;
  store.appendEventLog({
    flowId: session.flowId,
    userTurnId: session.userTurnId,
    taskId: session.taskId,
    agentSessionId: session.id,
    eventType: "agent_session.leader_message",
    payload: {
      message_id: messageId,
      summary,
      created_at: new Date().toISOString(),
      delivery_status: "accepted",
    },
  });
  return messageId;
}

export function createAgentDispatcher(input: {
  store: Store;
  eventBus: EventBus;
  expertRuntime: Pick<ExpertRuntime, "runTask"> & Partial<Pick<ExpertRuntime, "sendMessage" | "cancelTask">>;
  onTaskFinished?: (event: ExpertTaskFinishedEvent) => Promise<void> | void;
}): AgentDispatcher {
  return {
    async dispatchAgent(dispatch) {
      if (!dispatch.taskId) {
        return { agent_session_id: "", status: "failed", error: "task_id is required in V1" };
      }

      const flow = input.store.getFlow(dispatch.flowId);
      if (!flow) return { agent_session_id: "", status: "failed", error: "flow not found" };
      const expert = input.store.getExpert(dispatch.expertId);
      if (!expert) return { agent_session_id: "", status: "failed", error: "expert not found" };
      const task = input.store.getTask(dispatch.taskId);
      if (!task || task.flowId !== dispatch.flowId) {
        return { agent_session_id: "", status: "failed", error: "task not found" };
      }
      if (task.expertId && task.expertId !== dispatch.expertId) {
        return { agent_session_id: "", status: "failed", error: "expert does not match task expert" };
      }

      const userTurn = input.store.getUserTurn(task.userTurnId);
      if (!userTurn || userTurn.status !== "active") {
        return { agent_session_id: "", status: "failed", error: "task user turn is not active" };
      }
      if (!input.store.listTaskDependencies(task.id).every((dependencyId) =>
        input.store.getTask(dependencyId)?.status === "completed"
      )) {
        return { agent_session_id: "", status: "failed", error: "task is blocked by incomplete dependencies" };
      }
      const taskMetadata = parseTaskMetadata(task.metadataJson);
      if (taskMetadata.planRevisionId) {
        const run = input.store.getPlanRunForRevision(taskMetadata.planRevisionId);
        if (run?.status === "paused_for_feedback") {
          return { agent_session_id: "", status: "failed", error: "plan is paused for feedback" };
        }
      }
      if (taskMetadata.resourceKeys.length > 0) {
        const activeStatuses = new Set(["in_progress", "queued_for_expert", "recovery_pending"]);
        const conflicting = input.store.listUserTurnTasks(task.userTurnId).some((candidate) =>
          candidate.id !== task.id
          && activeStatuses.has(candidate.status)
          && parseTaskMetadata(candidate.metadataJson).resourceKeys.some((key) => taskMetadata.resourceKeys.includes(key))
        );
        if (conflicting) {
          return { agent_session_id: "", status: "failed", error: "resource conflict with a running task" };
        }
      }
      const runtimeConfigSnapshot = await readAgentRuntimeConfigSnapshot();
      if (!isExpertRuntimeEnabled(runtimeConfigSnapshot.roles, expert.role)) {
        return { agent_session_id: "", status: "failed", error: "expert is disabled" };
      }

      const currentSession = task.agentSessionId ? input.store.getAgentSession(task.agentSessionId) : null;
      if (currentSession?.status === "streaming" || currentSession?.status === "queued") {
        return { agent_session_id: "", status: "failed", error: "running sessions must use send_message" };
      }
      if (task.agentSessionId && !dispatch.resumeAgentSessionId) {
        return { agent_session_id: "", status: "failed", error: "resume_agent_session_id is required for an ended task" };
      }

      let resumeSessionId: string | undefined;
      if (dispatch.resumeAgentSessionId) {
        const oldSession = input.store.getAgentSession(dispatch.resumeAgentSessionId);
        if (
          !oldSession
          || oldSession.flowId !== dispatch.flowId
          || oldSession.taskId !== task.id
          || oldSession.expertId !== dispatch.expertId
          || task.agentSessionId !== oldSession.id
          || !["completed", "failed"].includes(oldSession.status)
          || !["completed", "failed", "cancelled"].includes(task.status)
          || !oldSession.sessionId
        ) {
          return { agent_session_id: "", status: "failed", error: "invalid resume_agent_session_id" };
        }
        resumeSessionId = oldSession.sessionId;
      } else if (task.status !== "pending" || task.agentSessionId) {
        return { agent_session_id: "", status: "failed", error: "task is not dispatchable" };
      }

      const flowExpert = input.store.getOrCreateFlowExpert({
        flowId: dispatch.flowId,
        expertId: dispatch.expertId,
      });
      const started = input.store.startAgentDispatch({
        flowId: dispatch.flowId,
        taskId: task.id,
        expertId: dispatch.expertId,
        flowExpertId: flowExpert.id,
        displayName: flowExpert.displayName,
        resumeFromAgentSessionId: dispatch.resumeAgentSessionId || undefined,
      });
      if (!started) {
        return { agent_session_id: "", status: "failed", error: "task could not be started" };
      }

      const { agentSession, task: startedTask, flowExpert: updatedFlowExpert } = started;
      await input.eventBus.publish(dispatch.flowId, {
        type: "task:event",
        flow_id: dispatch.flowId,
        data: {
          task_id: startedTask.id,
          user_turn_id: startedTask.userTurnId,
          expert_id: startedTask.expertId,
          flow_expert_id: startedTask.flowExpertId,
          status: startedTask.status,
        },
      });
      await input.eventBus.publish(dispatch.flowId, {
        type: "session:event",
        flow_id: dispatch.flowId,
        data: {
          event: "created",
          agent_session_id: agentSession.id,
          user_turn_id: agentSession.userTurnId,
          task_id: agentSession.taskId,
          expert_id: agentSession.expertId,
          flow_expert_id: agentSession.flowExpertId,
          display_name: agentSession.displayName,
          status: agentSession.status,
        },
      });
      await input.eventBus.publish(dispatch.flowId, {
        type: "flow_expert:event",
        flow_id: dispatch.flowId,
        data: {
          event: "updated",
          flow_expert_id: flowExpert.id,
          agent_session_id: agentSession.id,
          expert_id: flowExpert.expertId,
          display_name: flowExpert.displayName,
          status: updatedFlowExpert.status,
        },
      });
      await recordLeaderInputAudit(
        input.store,
        agentSession,
        dispatch.resumeAgentSessionId ? "继续执行" : "首次派发",
      );

      void input.expertRuntime.runTask({
        flowId: dispatch.flowId,
        userTurnId: startedTask.userTurnId,
        taskId: startedTask.id,
        flowExpertId: flowExpert.id,
        agentSessionId: agentSession.id,
        prompt: dispatch.prompt,
        resumeSessionId: flowExpert.sdkSessionId ?? resumeSessionId,
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        input.store.failTask(startedTask.id, message);
        input.store.updateAgentSessionStatus(agentSession.id, "failed");
        input.store.updateFlowExpertStatus(flowExpert.id, "failed");
        void input.eventBus.publish(dispatch.flowId, {
          type: "task:event",
          flow_id: dispatch.flowId,
          data: {
            task_id: startedTask.id,
            user_turn_id: startedTask.userTurnId,
            expert_id: startedTask.expertId,
            flow_expert_id: startedTask.flowExpertId,
            agent_session_id: agentSession.id,
            status: "failed",
            error_message: message,
          },
        });
        await input.onTaskFinished?.({
          flowId: dispatch.flowId,
          userTurnId: startedTask.userTurnId,
          taskId: startedTask.id,
          agentSessionId: agentSession.id,
          expertId: dispatch.expertId,
          status: "failed",
          turnOutcome: "errored",
          summary: message,
          error: message,
          artifactRefs: [],
          completedAt: new Date().toISOString(),
        });
      });

      return {
        agent_session_id: agentSession.id,
        flow_expert_id: flowExpert.id,
        status: agentSession.status,
        expert_id: agentSession.expertId,
        task_id: agentSession.taskId,
        user_turn_id: agentSession.userTurnId,
        task: {
          task_id: startedTask.id,
          user_turn_id: startedTask.userTurnId,
          subject: startedTask.title,
          description: startedTask.description,
          active_form: startedTask.activeForm,
          status: startedTask.status,
          expert_id: startedTask.expertId,
          flow_expert_id: startedTask.flowExpertId,
          agent_session_id: startedTask.agentSessionId,
        },
      };
    },

    async sendMessage(message) {
      const session = input.store.getAgentSession(message.agentSessionId);
      if (
        !session
        || session.flowId !== message.flowId
        || session.status !== "streaming"
        || !session.flowExpertId
      ) {
        return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "runtime delivery channel unavailable" },
        };
      }
      const accepted = input.expertRuntime.sendMessage?.({
        flowId: message.flowId,
        flowExpertId: session.flowExpertId,
        agentSessionId: session.id,
        content: message.content,
      }) ?? false;
      if (!accepted) {
        return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "runtime delivery channel unavailable" },
        };
      }
      const messageId = await recordLeaderInputAudit(input.store, session, message.summary);
      return { accepted: true, message_id: messageId };
    },

    async cancelAgent(message) {
      const session = input.store.getAgentSession(message.agentSessionId);
      const task = input.store.getTask(message.taskId);
      if (
        !session
        || !task
        || session.flowId !== message.flowId
        || session.userTurnId !== message.userTurnId
        || session.taskId !== task.id
        || task.agentSessionId !== session.id
        || task.status !== "in_progress"
        || session.status !== "streaming"
      ) {
        return { ok: false, error: { code: "TASK_NOT_RUNNING", message: "task is not attached to a running AgentSession" } };
      }
      if (!input.expertRuntime.cancelTask) {
        return { ok: false, error: { code: "UNSUPPORTED_V1", message: "expert runtime does not support task cancellation" } };
      }
      const cancelled = await input.expertRuntime.cancelTask({
        flowId: message.flowId,
        userTurnId: message.userTurnId,
        taskId: message.taskId,
        agentSessionId: message.agentSessionId,
      });
      if (!cancelled) {
        return { ok: false, error: { code: "TASK_CANCEL_FAILED", message: "running AgentSession could not be interrupted" } };
      }
      const cancelledTask = input.store.getTask(message.taskId);
      const cancelledSession = input.store.getAgentSession(message.agentSessionId);
      if (!cancelledTask || !cancelledSession) {
        return { ok: false, error: { code: "TASK_CANCEL_FAILED", message: "task cancellation did not persist" } };
      }
      return { ok: true, task: cancelledTask, agentSession: cancelledSession };
    },
  };
}

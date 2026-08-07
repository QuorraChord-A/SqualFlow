import { randomUUID } from "node:crypto";
import type { Store } from "../db/store.js";
import { isExpertRuntimeEnabled, readAgentRuntimeConfigSnapshot } from "../config/agentRuntimeConfig.js";
import type { EventBus } from "../ws/eventBus.js";
import type {
  ExpertConversationFinishedEvent,
  ExpertRuntime,
  ExpertTaskFinishedEvent,
} from "./expertRuntime.js";
import { publishWorkRunEvent } from "../domain/workRun.js";
import { capturePersistentChangeBaseline } from "./changeBaseline.js";

export type AgentDispatcher = {
  dispatchAgent: (input: {
    flowId: string;
    taskId: string | null;
    expertId: string;
    prompt?: string;
    resumeAgentSessionId: string;
  }) => Promise<{
    agent_session_id: string;
    flow_expert_id?: string;
    status: string;
    expert_id?: string;
    task_id?: string | null;
    work_run_id?: string | null;
    task?: {
      task_id: string;
      work_run_id: string;
      subject: string;
      description: string;
      active_form: string;
      progress: string | null;
      status: string;
      expert_id: string | null;
      flow_expert_id: string | null;
      agent_session_id: string | null;
      revision: number;
    };
    error?: string;
  }>;
  sendMessage: (input: {
    flowId: string;
    workRunId?: string;
    expertId: string;
    content: string;
    summary?: string;
  }) => Promise<{
    accepted: boolean;
    message_id?: string;
    error?: { code: string; message: string };
  }>;
  cancelAgent: (input: {
    flowId: string;
    workRunId: string;
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
    workRunId: session.workRunId,
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
  expertRuntime: Pick<ExpertRuntime, "runTask">
    & Partial<Pick<ExpertRuntime, "runConversation" | "sendMessage" | "cancelTask">>;
  onTaskFinished?: (event: ExpertTaskFinishedEvent) => Promise<void> | void;
  onConversationFinished?: (event: ExpertConversationFinishedEvent) => Promise<void> | void;
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

      const workRun = input.store.getWorkRun(task.workRunId);
      if (!workRun || !["ready", "executing"].includes(workRun.status)) {
        return { agent_session_id: "", status: "failed", error: workRun?.status === "interrupted" ? "WORK_RUN_INTERRUPTED" : "WORK_RUN_NOT_EXECUTABLE" };
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
        const activeStatuses = new Set(["in_progress"]);
        const conflicting = input.store.listWorkRunTasks(task.workRunId).some((candidate) =>
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
      let resumeSessionId: string | undefined;
      if (dispatch.resumeAgentSessionId) {
        const oldSession = input.store.getAgentSession(dispatch.resumeAgentSessionId);
        if (
          !oldSession
          || oldSession.flowId !== dispatch.flowId
          || oldSession.taskId !== task.id
          || oldSession.expertId !== dispatch.expertId
          || !["completed", "failed", "interrupted"].includes(oldSession.status)
          || !oldSession.sessionId
        ) {
          return { agent_session_id: "", status: "failed", error: "invalid resume_agent_session_id" };
        }
        resumeSessionId = oldSession.sessionId;
      } else if (currentSession?.sessionId && ["completed", "failed", "interrupted"].includes(currentSession.status)) {
        // A FlowExpert owns the provider conversation. A subsequent explicit
        // dispatch starts a new execution record while resuming that same
        // provider session by default.
        resumeSessionId = currentSession.sessionId;
      }

      if (!["pending", "in_progress"].includes(task.status)) {
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
        resumeFromAgentSessionId: dispatch.resumeAgentSessionId || currentSession?.id || undefined,
      });
      if (!started) {
        return { agent_session_id: "", status: "failed", error: "task could not be started" };
      }

      const { agentSession, task: startedTask, flowExpert: updatedFlowExpert } = started;
      capturePersistentChangeBaseline({
        store: input.store,
        flowId: dispatch.flowId,
        sourceAgentSessionId: agentSession.id,
        workRunId: startedTask.workRunId,
        rootPath: workRun.workRootPath,
      });
      const executingWorkRun = input.store.getWorkRun(startedTask.workRunId);
      if (executingWorkRun) await publishWorkRunEvent(input.eventBus, executingWorkRun);
      await input.eventBus.publish(dispatch.flowId, {
        type: "task:event",
        flow_id: dispatch.flowId,
        data: {
          task_id: startedTask.id,
          work_run_id: startedTask.workRunId,
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
          work_run_id: agentSession.workRunId,
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
        currentSession ? "继续执行" : "首次派发",
      );

      void input.expertRuntime.runTask({
        flowId: dispatch.flowId,
        workRunId: startedTask.workRunId,
        taskId: startedTask.id,
        flowExpertId: flowExpert.id,
        agentSessionId: agentSession.id,
        prompt: dispatch.prompt || undefined,
        resumeSessionId: flowExpert.sdkSessionId ?? resumeSessionId,
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        input.store.updateAgentSessionStatus(agentSession.id, "failed");
        input.store.updateFlowExpertStatus(flowExpert.id, "failed");
        void input.eventBus.publish(dispatch.flowId, {
          type: "task:event",
          flow_id: dispatch.flowId,
          data: {
            task_id: startedTask.id,
            work_run_id: startedTask.workRunId,
            expert_id: startedTask.expertId,
            flow_expert_id: startedTask.flowExpertId,
            agent_session_id: agentSession.id,
            status: input.store.getTask(startedTask.id)?.status ?? startedTask.status,
            session_status: "failed",
            error_message: message,
          },
        });
        await input.onTaskFinished?.({
          flowId: dispatch.flowId,
          workRunId: startedTask.workRunId,
          taskId: startedTask.id,
          agentSessionId: agentSession.id,
          expertId: dispatch.expertId,
          status: "failed",
          taskStatus: input.store.getTask(startedTask.id)?.status ?? startedTask.status,
          turnOutcome: "errored",
          summary: message,
          error: message,
          artifactRefs: [],
          filesChanged: [],
          metrics: {},
          completedAt: new Date().toISOString(),
        });
      });

      return {
        agent_session_id: agentSession.id,
        flow_expert_id: flowExpert.id,
        status: agentSession.status,
        expert_id: agentSession.expertId,
        task_id: agentSession.taskId,
        work_run_id: agentSession.workRunId,
        task: {
          task_id: startedTask.id,
          work_run_id: startedTask.workRunId,
          subject: startedTask.title,
          description: startedTask.description,
          active_form: startedTask.activeForm,
          progress: startedTask.progress,
          status: startedTask.status,
          expert_id: startedTask.expertId,
          flow_expert_id: startedTask.flowExpertId,
          agent_session_id: startedTask.agentSessionId,
          revision: startedTask.revision,
        },
      };
    },

    async sendMessage(message) {
      const flow = input.store.getFlow(message.flowId);
      const expert = input.store.getExpert(message.expertId);
      const workRun = message.workRunId ? input.store.getWorkRun(message.workRunId) : undefined;
      if (!flow || (workRun && (workRun.flowId !== message.flowId || workRun.status === "interrupted"))) {
        return {
          accepted: false,
          error: { code: "WORK_RUN_NOT_EXECUTABLE", message: "Expert conversation is not available for this WorkRun" },
        };
      }
      if (!expert || expert.role === "leader") {
        return {
          accepted: false,
          error: { code: "EXPERT_NOT_FOUND", message: `expert not found: ${message.expertId}` },
        };
      }
      const runtimeConfigSnapshot = await readAgentRuntimeConfigSnapshot();
      if (!isExpertRuntimeEnabled(runtimeConfigSnapshot.roles, expert.role)) {
        return {
          accepted: false,
          error: { code: "EXPERT_DISABLED", message: `expert is disabled: ${message.expertId}` },
        };
      }

      const flowExpert = input.store.getOrCreateFlowExpert({
        flowId: message.flowId,
        expertId: message.expertId,
      });
      const sessions = input.store.listAgentSessions(message.flowId)
        .filter((session) => session.flowExpertId === flowExpert.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const runningSession = sessions.find((session) => session.status === "streaming");
      if (runningSession) {
        const accepted = input.expertRuntime.sendMessage?.({
          flowId: message.flowId,
          flowExpertId: flowExpert.id,
          agentSessionId: runningSession.id,
          content: message.content,
        }) ?? false;
        if (!accepted) {
          return {
            accepted: false,
            error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "runtime delivery channel unavailable" },
          };
        }
        const messageId = await recordLeaderInputAudit(input.store, runningSession, message.summary);
        return { accepted: true, message_id: messageId };
      }
      if (sessions.some((session) => session.status === "queued")) {
        return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "Expert conversation is still starting" },
        };
      }

      const previousSession = sessions[0] ?? null;
      if (!input.expertRuntime.runConversation) {
        return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "Expert conversation runtime is unavailable" },
        };
      }
      const agentSession = input.store.createAgentSession({
        flowId: message.flowId,
        workRunId: message.workRunId ?? null,
        taskId: null,
        expertId: message.expertId,
        flowExpertId: flowExpert.id,
        sessionId: flowExpert.sdkSessionId,
        displayName: flowExpert.displayName,
        resumeFromAgentSessionId: previousSession?.id,
        status: "queued",
      });
      if (!agentSession) {
        return {
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "taskless Expert session could not be created" },
        };
      }
      input.store.updateFlowExpertStatus(flowExpert.id, "queued");
      await input.eventBus.publish(message.flowId, {
        type: "session:event",
        flow_id: message.flowId,
        data: {
          event: "created",
          agent_session_id: agentSession.id,
          work_run_id: agentSession.workRunId,
          task_id: null,
          expert_id: agentSession.expertId,
          flow_expert_id: agentSession.flowExpertId,
          display_name: agentSession.displayName,
          status: agentSession.status,
        },
      });
      await input.eventBus.publish(message.flowId, {
        type: "flow_expert:event",
        flow_id: message.flowId,
        data: {
          event: "updated",
          flow_expert_id: flowExpert.id,
          agent_session_id: agentSession.id,
          expert_id: flowExpert.expertId,
          display_name: flowExpert.displayName,
          status: "queued",
        },
      });
      const messageId = await recordLeaderInputAudit(input.store, agentSession, message.summary);
      void input.expertRuntime.runConversation({
        flowId: message.flowId,
        workRunId: message.workRunId,
        flowExpertId: flowExpert.id,
        agentSessionId: agentSession.id,
        expertId: message.expertId,
        content: message.content,
        resumeSessionId: flowExpert.sdkSessionId ?? previousSession?.sessionId ?? undefined,
      }).catch(async (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        input.store.updateAgentSessionStatus(agentSession.id, "failed");
        input.store.updateFlowExpertStatus(flowExpert.id, "failed");
        await input.onConversationFinished?.({
          flowId: message.flowId,
          workRunId: message.workRunId,
          agentSessionId: agentSession.id,
          expertId: message.expertId,
          status: "failed",
          turnOutcome: "errored",
          summary: errorMessage,
          error: errorMessage,
          artifactRefs: [],
          filesChanged: [],
          metrics: {},
          completedAt: new Date().toISOString(),
        });
      });
      return { accepted: true, message_id: messageId };
    },

    async cancelAgent(message) {
      const session = input.store.getAgentSession(message.agentSessionId);
      const task = input.store.getTask(message.taskId);
      if (
        !session
        || !task
        || session.flowId !== message.flowId
        || session.workRunId !== message.workRunId
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
        workRunId: message.workRunId,
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

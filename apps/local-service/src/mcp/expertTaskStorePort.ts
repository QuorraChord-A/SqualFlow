import type { Store } from "../db/store.js";
import type {
  ExpertTask,
  ExpertTaskActorScope,
  ExpertTaskStorePort,
  ExpertTaskUpdateFailure,
} from "./expertTaskServer.js";
import { ExpertTaskStatus } from "./expertTaskModels.js";

type ExpertTaskStorePortHooks = {
  /** Runs only after an explicit Expert task-tool mutation was persisted. */
  onTaskUpdated?: (input: { flowId: string; task: ExpertTask }) => Promise<void> | void;
};

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonValue(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toExpertTask(store: Store, task: NonNullable<ReturnType<Store["getTask"]>>): ExpertTask {
  const flowExpert = task.flowExpertId ? store.getFlowExpert(task.flowExpertId) : null;
  return {
    task_id: task.id,
    user_turn_id: task.userTurnId,
    subject: task.title,
    description: task.description,
    active_form: task.activeForm,
    assignment: {
      expert_id: task.expertId ?? "",
      flow_expert_id: task.flowExpertId ?? "",
      ...(flowExpert?.displayName ? { display_name: flowExpert.displayName } : {}),
    },
    status: ExpertTaskStatus.parse(task.status),
    dependency_task_ids: store.listTaskDependencies(task.id),
    acceptance_criteria: parseStringArray(task.acceptanceCriteriaJson),
    progress: task.progress,
    result: parseJsonValue(task.resultJson),
    error_message: task.errorMessage,
    revision: task.revision,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function failure(
  code: ExpertTaskUpdateFailure["error"]["code"],
  message: string,
): ExpertTaskUpdateFailure {
  return { ok: false, error: { code, message } };
}

/**
 * The only Store surface exposed to a running Expert Task MCP server.
 * Identity comes from the runtime, never from model-supplied arguments.
 */
export function createExpertTaskStorePort(
  store: Store,
  hooks: ExpertTaskStorePortHooks = {},
): ExpertTaskStorePort {
  const actorIsLiveForFlow = (scope: ExpertTaskActorScope) => {
    const session = store.getAgentSession(scope.agentSessionId);
    return Boolean(
      session
      && session.flowId === scope.flowId
      && session.flowExpertId === scope.flowExpertId,
    );
  };

  const scopedTask = (scope: ExpertTaskActorScope, taskId: string) => {
    const task = store.getTask(taskId);
    if (!task || task.flowId !== scope.flowId) return { task: null, failure: "not_found" as const };
    if (task.flowExpertId !== scope.flowExpertId) return { task: null, failure: "not_assigned" as const };
    return { task, failure: null };
  };

  return {
    listMyTasks(scope) {
      if (!actorIsLiveForFlow(scope)) return [];
      return store.listTasks(scope.flowId)
        .filter((task) => task.flowExpertId === scope.flowExpertId)
        .map((task) => toExpertTask(store, task));
    },

    getMyTask({ taskId, ...scope }) {
      if (!actorIsLiveForFlow(scope)) return null;
      const scoped = scopedTask(scope, taskId);
      return scoped.task ? toExpertTask(store, scoped.task) : null;
    },

    async updateMyTask(input) {
      if (!actorIsLiveForFlow(input)) {
        return failure("TASK_INVALID_STATE", "The active Expert session is no longer available.");
      }
      const scoped = scopedTask(input, input.taskId);
      if (scoped.failure === "not_found") {
        return failure("TASK_NOT_FOUND", `task not found: ${input.taskId}`);
      }
      if (scoped.failure === "not_assigned") {
        return failure("TASK_NOT_ASSIGNED", `task is not assigned to this Expert: ${input.taskId}`);
      }
      const current = scoped.task!;
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        return failure("TASK_REVISION_CONFLICT", `task changed; expected revision ${input.expectedRevision}, current revision ${current.revision}`);
      }

      let resultJson: string | null | undefined;
      if (input.result !== undefined) {
        resultJson = input.result === null ? null : JSON.stringify(input.result);
      }
      const updated = store.updateTask(current.id, {
        title: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        progress: input.progress,
        resultJson,
        errorMessage: input.errorMessage,
        status: input.status,
        expectedRevision: input.expectedRevision,
      });
      if (!updated) {
        return failure("TASK_INVALID_STATE", `Task cannot transition from ${current.status} using this update.`);
      }

      const task = toExpertTask(store, updated);
      store.appendEventLog({
        flowId: input.flowId,
        userTurnId: updated.userTurnId,
        taskId: updated.id,
        agentSessionId: input.agentSessionId,
        eventType: "expert_task.updated",
        payload: {
          flow_expert_id: input.flowExpertId,
          agent_session_id: input.agentSessionId,
          task_id: updated.id,
          status: updated.status,
          revision: updated.revision,
        },
      });
      await hooks.onTaskUpdated?.({ flowId: input.flowId, task });
      return { ok: true as const, task };
    },
  };
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetMyTaskInput,
  ListMyTasksInput,
  UpdateMyTaskInput,
  type GetMyTaskInputValue,
  type UpdateMyTaskInputValue,
  type ExpertTaskStatusValue,
} from "./expertTaskModels.js";

export const EXPERT_TASK_MCP_TOOL_PREFIX = "mcp__squadflow-expert-task__";

export const EXPERT_TASK_MCP_TOOL_NAMES = [
  "list_my_tasks",
  "get_my_task",
  "update_my_task",
].map((tool) => `${EXPERT_TASK_MCP_TOOL_PREFIX}${tool}`);

/**
 * This context is supplied by the running Expert session. None of these ids
 * are accepted from model tool arguments.
 */
export type ExpertTaskActorScope = {
  flowId: string;
  agentSessionId: string;
  agentRunId: string;
};

export type ExpertTaskAssignment = {
  agent_definition_id: string;
  agent_session_id: string;
  display_name?: string;
};

/** The read-only Task projection exposed to an Expert. */
export type ExpertTask = {
  task_id: string;
  subject: string;
  description: string;
  active_form: string;
  assignment: ExpertTaskAssignment;
  status: ExpertTaskStatusValue;
  dependency_task_ids: string[];
  acceptance_criteria: string[];
  progress: string | null;
  result: unknown | null;
  error_message: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type ExpertTaskUpdateFailure = {
  ok: false;
  error: {
    code: "TASK_NOT_FOUND" | "TASK_NOT_ASSIGNED" | "TASK_REVISION_CONFLICT" | "TASK_INVALID_STATE";
    message: string;
  };
};

export type ExpertTaskStorePort = {
  listMyTasks: (scope: ExpertTaskActorScope) => Promise<ExpertTask[]> | ExpertTask[];
  getMyTask: (input: ExpertTaskActorScope & { taskId: string }) => Promise<ExpertTask | null> | ExpertTask | null;
  updateMyTask: (input: ExpertTaskActorScope & {
    taskId: string;
    expectedRevision?: number;
    subject?: string;
    description?: string;
    activeForm?: string;
    progress?: string | null;
    result?: unknown | null;
    errorMessage?: string | null;
    status?: "blocked" | "completed" | "failed";
  }) => Promise<{ ok: true; task: ExpertTask } | ExpertTaskUpdateFailure> | { ok: true; task: ExpertTask } | ExpertTaskUpdateFailure;
};

export type ExpertTaskRuntimeContext = {
  /** Resolve the authenticated current Expert at call time, not from model input. */
  getActorScope: () => ExpertTaskActorScope | null;
};

function json(value: unknown) {
  return JSON.stringify(value);
}

function ok(fields: Record<string, unknown> = {}) {
  return json({ ok: true, ...fields });
}

function fail(code: string, message: string) {
  return json({ ok: false, error: { code, message } });
}

export function createExpertTaskToolHandlers(
  store: ExpertTaskStorePort,
  runtimeContext: ExpertTaskRuntimeContext,
) {
  const actorScope = () => runtimeContext.getActorScope();
  const unavailable = () => fail(
    "EXPERT_CONTEXT_UNAVAILABLE",
    "Task tools require an active Expert session.",
  );

  return {
    async listMyTasks() {
      const scope = actorScope();
      if (!scope) return unavailable();
      return ok({ tasks: await store.listMyTasks(scope) });
    },

    async getMyTask(input: GetMyTaskInputValue) {
      const parsed = GetMyTaskInput.parse(input);
      const scope = actorScope();
      if (!scope) return unavailable();
      const task = await store.getMyTask({ ...scope, taskId: parsed.task_id });
      return task
        ? ok({ task })
        : fail("TASK_NOT_FOUND", `task not found or not assigned to this Expert: ${parsed.task_id}`);
    },

    async updateMyTask(input: UpdateMyTaskInputValue) {
      const parsed = UpdateMyTaskInput.parse(input);
      const scope = actorScope();
      if (!scope) return unavailable();
      const result = await store.updateMyTask({
        ...scope,
        taskId: parsed.task_id,
        expectedRevision: parsed.expected_revision,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.active_form,
        progress: parsed.progress,
        result: parsed.result,
        errorMessage: parsed.error_message,
        status: parsed.status,
      });
      return result.ok ? ok({ task: result.task }) : fail(result.error.code, result.error.message);
    },
  };
}

export function createExpertTaskMcpServer(handlers: ReturnType<typeof createExpertTaskToolHandlers>) {
  const server = new McpServer({ name: "squadflow-expert-task", version: "0.1.0" });

  server.registerTool(
    "list_my_tasks",
    {
      title: "list_my_tasks",
      description: "List all Tasks assigned to you in this Flow. Assignment scope is derived from the active Expert session.",
      inputSchema: ListMyTasksInput,
    },
    async () => ({ content: [{ type: "text", text: await handlers.listMyTasks() }] }),
  );

  server.registerTool(
    "get_my_task",
    {
      title: "get_my_task",
      description: "Read one Task assigned to you in this Flow, including acceptance criteria, dependencies, progress, result, and revision.",
      inputSchema: GetMyTaskInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.getMyTask(input) }] }),
  );

  server.registerTool(
    "update_my_task",
    {
      title: "update_my_task",
      description: "Update your assigned Task's collaboration fields, progress, result, error, or explicit blocked/completed/failed status. You cannot change assignment, dependencies, Flow, or session bindings.",
      inputSchema: UpdateMyTaskInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.updateMyTask(input) }] }),
  );

  return server;
}

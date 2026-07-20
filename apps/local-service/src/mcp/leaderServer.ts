import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AskUserInput,
  CancelAgentInput,
  CreatePlanInput,
  CreateTaskInput,
  DispatchAgentInput,
  GetContextInput,
  GetTaskInput,
  ListTasksInput,
  SaveExecutionPlanInput,
  ResolvePlanFeedbackInput,
  SubmitOrchestrationPlanInput,
  SendMessageInput,
  UpdateTaskInput,
  type AskUserInputValue,
  type CancelAgentInputValue,
  type CreatePlanInputValue,
  type CreateTaskInputValue,
  type DispatchAgentInputValue,
  type GetContextInputValue,
  type GetTaskInputValue,
  type ListTasksInputValue,
  type QuestionInputValue,
  type SaveExecutionPlanInputValue,
  type ResolvePlanFeedbackInputValue,
  type SubmitOrchestrationPlanInputValue,
  type SendMessageInputValue,
  type UpdateTaskInputValue,
} from "./platformModels.js";

export interface CurrentTurnInput {
  trigger_kind: "user_message" | "decision_resolved" | "decision_cancelled" | "spec_run" | "expert_result" | "user_turn_recovery" | "plan_approved";
  user_turn_id?: string;
  message_id?: string;
  card_id?: string;
  content?: string;
  answers?: Record<string, string | string[]>;
  spec_requested?: boolean;
  created_at: string;
}

export interface PendingUserActionRow {
  id: string;
  type: "clarification" | "spec_approval" | "plan_approval";
  status: "pending";
}

export type LeaderToolHooks = {
  onDecisionCardCreated?: (args: {
    flowId: string;
    userTurnId: string;
    cardId: string;
    cardType: "clarification";
    questions: QuestionInputValue[];
    status: string;
  }) => Promise<void> | void;
  onSpecCardCreated?: (args: {
    flowId: string;
    specApprovalId: string;
    specRevisionId: string;
    userTurnId: string | null;
    status: "pending";
    fileName: string;
    overview: string;
  }) => Promise<void> | void;
  onTaskCreated?: (args: {
    flowId: string;
    userTurnId: string;
    task: Record<string, unknown>;
  }) => Promise<void> | void;
  onArtifactCreated?: (args: {
    flowId: string;
    artifact: Record<string, unknown>;
  }) => Promise<void> | void;
  onPlanCreated?: (args: {
    flowId: string;
    userTurnId: string;
    plan: Record<string, unknown>;
    revision: Record<string, unknown>;
    approval: Record<string, unknown>;
  }) => Promise<void> | void;
  onPlanApprovalChanged?: (args: { flowId: string; approval: Record<string, unknown> }) => Promise<void> | void;
  onPlanRunChanged?: (args: { flowId: string; run: Record<string, unknown> }) => Promise<void> | void;
};

export type PlanFeedbackResolution = {
  approval: Record<string, unknown>;
  run?: Record<string, unknown>;
};

export type CancelAgentResult =
  | { ok: true; agent_session: Record<string, unknown>; task: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

export interface StorePort {
  getContext: (flowId: string) => Record<string, unknown> | null;
  listPendingUserActions: (args: { flowId: string }) => PendingUserActionRow[];
  createPlan: (args: {
    flowId: string;
    mode: "write" | "rewrite";
    name?: string;
    overview: string;
    plan: string;
    sourceAgentSessionId?: string;
    currentTurnInput?: CurrentTurnInput;
  }) => { spec_revision: Record<string, unknown>; spec_approval: Record<string, unknown> } | null;
  askUser: (args: {
    flowId: string;
    cardId: string;
    sessionId: string;
    questions: QuestionInputValue[];
    currentTurnInput?: CurrentTurnInput;
  }) => { id: string; status: string; userTurnId: string } | undefined;
  createTask: (args: {
    flowId: string;
    subject: string;
    description: string;
    activeForm?: string;
    currentTurnInput?: CurrentTurnInput;
  }) => { user_turn_id: string; task: Record<string, unknown> } | { error: { code: string; message: string } };
  saveExecutionPlan: (args: {
    flowId: string;
    title: string;
    plan: string;
    sourceAgentSessionId?: string;
    currentTurnInput?: CurrentTurnInput;
  }) => Record<string, unknown> | null;
  submitOrchestrationPlan: (args: SubmitOrchestrationPlanInputValue & {
    sourceAgentSessionId?: string;
    currentTurnInput?: CurrentTurnInput;
  }) => Record<string, unknown> | null;
  resolvePlanFeedback: (args: { flowId: string; planApprovalId: string; resolutionNote: string; currentTurnInput?: CurrentTurnInput }) => PlanFeedbackResolution | Record<string, unknown> | null;
  updateTask: (args: {
    flowId: string;
    taskId: string;
    status?: "pending" | "queued_for_expert" | "recovery_pending" | "in_progress" | "completed" | "failed" | "cancelled";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
    currentTurnInput?: CurrentTurnInput;
  }) => Record<string, unknown> | null;
  listTasks: (args: { flowId: string; currentTurnInput?: CurrentTurnInput }) => Array<Record<string, unknown>>;
  getTask: (args: { flowId: string; taskId: string; currentTurnInput?: CurrentTurnInput }) => Record<string, unknown> | null;
  dispatchAgent: (args: {
    flowId: string;
    taskId: string;
    expertId: string;
    prompt: string;
    resumeAgentSessionId: string;
    currentTurnInput?: CurrentTurnInput;
  }) => Promise<
    | { ok: true; agent_session: Record<string, unknown>; task: Record<string, unknown> }
    | { ok: false; error: { code: string; message: string } }
  >;
  cancelAgent: (args: {
    flowId: string;
    taskId: string;
    currentTurnInput?: CurrentTurnInput;
  }) => Promise<CancelAgentResult> | CancelAgentResult;
  sendMessage: (args: {
    flowId: string;
    agentSessionId: string;
    content: string;
    summary?: string;
    currentTurnInput?: CurrentTurnInput;
  }) => Promise<{ ok: true; accepted: boolean; message_id?: string; error?: { code: string; message: string } }>
    | { ok: true; accepted: boolean; message_id?: string; error?: { code: string; message: string } };
}

export type LeaderToolRuntimeContext = {
  currentTurnInput?: CurrentTurnInput;
  getCurrentTurnInput?: () => CurrentTurnInput | undefined;
  leaderAgentSessionId?: string;
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

function hasOwn(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function createLeaderToolHandlers(
  store: StorePort,
  hooks: LeaderToolHooks = {},
  runtimeContext: LeaderToolRuntimeContext = {},
) {
  const currentTurnInput = () => runtimeContext.getCurrentTurnInput?.() ?? runtimeContext.currentTurnInput;
  const hasPendingUserAction = (flowId: string) => store.listPendingUserActions({ flowId }).length > 0;
  const isCancellationFollowup = () => currentTurnInput()?.trigger_kind === "decision_cancelled";
  const cancellationFailure = () => fail(
    "CLARIFICATION_CANCELLED",
    "The user cancelled the clarification card; respond in natural language before creating cards, plans, tasks, task updates, messages, or dispatches.",
  );

  return {
    async getContext(input: GetContextInputValue) {
      const parsed = GetContextInput.parse(input);
      const context = store.getContext(parsed.flow_id);
      return context ? ok(context) : fail("FLOW_NOT_FOUND", `flow not found: ${parsed.flow_id}`);
    },

    async askUser(input: AskUserInputValue) {
      const parsed = AskUserInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (!store.getContext(parsed.flow_id)) return fail("FLOW_NOT_FOUND", `flow not found: ${parsed.flow_id}`);
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");

      const cardId = `dc-${crypto.randomBytes(4).toString("hex")}`;
      const card = store.askUser({
        flowId: parsed.flow_id,
        cardId,
        sessionId: runtimeContext.leaderAgentSessionId ?? "",
        questions: parsed.questions,
        currentTurnInput: currentTurnInput(),
      });
      if (!card) return fail("ACTIVE_USER_TURN_REQUIRED", "Clarification requires an active UserTurn.");
      await hooks.onDecisionCardCreated?.({
        flowId: parsed.flow_id,
        userTurnId: card.userTurnId,
        cardId: card.id,
        cardType: "clarification",
        questions: parsed.questions,
        status: card.status,
      });
      return ok({
        card_id: card.id,
        status: card.status,
        question_count: parsed.questions.length,
      });
    },

    async createPlan(input: CreatePlanInputValue) {
      const parsed = CreatePlanInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (!store.getContext(parsed.flow_id)) return fail("FLOW_NOT_FOUND", `flow not found: ${parsed.flow_id}`);
      if (currentTurnInput()?.spec_requested !== true) return fail("SPEC_REQUEST_REQUIRED", "create_plan requires this message to request Spec.");
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      if (parsed.mode === "write" && !parsed.name) return fail("INVALID_SPEC_REVISION", "name is required when mode=write.");

      const result = store.createPlan({
        flowId: parsed.flow_id,
        mode: parsed.mode,
        name: parsed.name,
        overview: parsed.overview,
        plan: parsed.plan,
        sourceAgentSessionId: runtimeContext.leaderAgentSessionId,
        currentTurnInput: currentTurnInput(),
      });
      if (result) {
        const specRevision = result.spec_revision as {
          spec_revision_id: string;
          file_name: string;
          overview: string;
        };
        const specApproval = result.spec_approval as {
          spec_approval_id: string;
          user_turn_id?: string | null;
        };
        await hooks.onSpecCardCreated?.({
          flowId: parsed.flow_id,
          specApprovalId: specApproval.spec_approval_id,
          specRevisionId: specRevision.spec_revision_id,
          userTurnId: specApproval.user_turn_id ?? null,
          status: "pending",
          fileName: specRevision.file_name,
          overview: specRevision.overview,
        });
      }
      return result ? ok(result) : fail("INVALID_SPEC_REVISION", "Spec plan could not be created.");
    },

    async createTask(input: CreateTaskInputValue) {
      const parsed = CreateTaskInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      const result = store.createTask({
        flowId: parsed.flow_id,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.active_form,
        currentTurnInput: currentTurnInput(),
      });
      if (!result) return fail("ACTIVE_USER_TURN_REQUIRED", "Task could not be created for the current UserTurn.");
      if ("error" in result) return fail(result.error.code, result.error.message);
      await hooks.onTaskCreated?.({
        flowId: parsed.flow_id,
        userTurnId: result.user_turn_id,
        task: result.task,
      });
      return ok(result);
    },

    async saveExecutionPlan(input: SaveExecutionPlanInputValue) {
      const parsed = SaveExecutionPlanInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      const artifact = store.saveExecutionPlan({
        flowId: parsed.flow_id,
        title: parsed.title,
        plan: parsed.plan,
        sourceAgentSessionId: runtimeContext.leaderAgentSessionId,
        currentTurnInput: currentTurnInput(),
      });
      if (!artifact) return fail("ACTIVE_USER_TURN_REQUIRED", "编排计划需要一个活跃的 UserTurn。");
      await hooks.onArtifactCreated?.({
        flowId: parsed.flow_id,
        artifact,
      });
      return ok({ artifact });
    },

    async submitOrchestrationPlan(input: SubmitOrchestrationPlanInputValue) {
      const parsed = SubmitOrchestrationPlanInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      const result = store.submitOrchestrationPlan({
        ...parsed,
        sourceAgentSessionId: runtimeContext.leaderAgentSessionId,
        currentTurnInput: currentTurnInput(),
      });
      if (!result) return fail("INVALID_ORCHESTRATION_PLAN", "编排计划无法创建；请检查当前 UserTurn、依赖和 Expert。");
      if ("error" in result) {
        const error = result.error as { code?: string; issues?: unknown };
        return json({ ok: false, error: { code: error.code ?? "INVALID_ORCHESTRATION_PLAN", message: "编排计划未通过校验", issues: error.issues ?? [] } });
      }
      await hooks.onPlanCreated?.({
        flowId: parsed.flow_id,
        userTurnId: currentTurnInput()?.user_turn_id ?? "",
        plan: result.plan as Record<string, unknown>,
        revision: result.revision as Record<string, unknown>,
        approval: result.approval as Record<string, unknown>,
      });
      if (result.auto_approved) {
        // 自动批准：计划已物化，返回任务清单让 Leader 在本轮继续按依赖派发。
        return ok({
          ...result,
          tasks: store.listTasks({ flowId: parsed.flow_id, currentTurnInput: currentTurnInput() }),
          next: "计划已自动批准并物化为任务；由你按依赖用 dispatch_agent 派发，互不依赖的节点可并行派。",
        });
      }
      return ok(result);
    },

    async resolvePlanFeedback(input: ResolvePlanFeedbackInputValue) {
      const parsed = ResolvePlanFeedbackInput.parse(input);
      const rawResult = store.resolvePlanFeedback({
        flowId: parsed.flow_id,
        planApprovalId: parsed.plan_approval_id,
        resolutionNote: parsed.resolution_note,
        currentTurnInput: currentTurnInput(),
      });
      let result: PlanFeedbackResolution | null = null;
      if (rawResult) {
        const candidate = rawResult as Record<string, unknown>;
        result = "approval" in candidate && typeof candidate.approval === "object" && candidate.approval !== null
          ? rawResult as PlanFeedbackResolution
          : { approval: rawResult };
      }
      if (!result) return fail("INVALID_PLAN_FEEDBACK", "计划反馈无法恢复原审批。");
      await hooks.onPlanApprovalChanged?.({ flowId: parsed.flow_id, approval: result.approval });
      if (result.run) await hooks.onPlanRunChanged?.({ flowId: parsed.flow_id, run: result.run });
      return ok(result);
    },

    async updateTask(input: UpdateTaskInputValue) {
      const parsed = UpdateTaskInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      const task = store.updateTask({
        flowId: parsed.flow_id,
        taskId: parsed.task_id,
        status: parsed.status,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.active_form,
        owner: parsed.owner,
        metadata: parsed.metadata,
        addBlocks: parsed.add_blocks,
        addBlockedBy: parsed.add_blocked_by,
        currentTurnInput: currentTurnInput(),
      });
      return task ? ok({ task }) : fail("INVALID_TASK", `task not found: ${parsed.task_id}`);
    },

    async listTasks(input: ListTasksInputValue) {
      const parsed = ListTasksInput.parse(input);
      return ok({ tasks: store.listTasks({ flowId: parsed.flow_id, currentTurnInput: currentTurnInput() }) });
    },

    async getTask(input: GetTaskInputValue) {
      const parsed = GetTaskInput.parse(input);
      const task = store.getTask({ flowId: parsed.flow_id, taskId: parsed.task_id, currentTurnInput: currentTurnInput() });
      return task ? ok({ task }) : fail("INVALID_TASK", `task not found: ${parsed.task_id}`);
    },

    async dispatchAgent(input: DispatchAgentInputValue) {
      const parsed = DispatchAgentInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      const result = await store.dispatchAgent({
        flowId: parsed.flow_id,
        taskId: parsed.task_id,
        expertId: parsed.expert_id,
        prompt: parsed.prompt,
        resumeAgentSessionId: parsed.resume_agent_session_id,
        currentTurnInput: currentTurnInput(),
      });
      if (!result.ok) {
        return fail(result.error.code, result.error.message);
      }
      return ok({
        agent_session: result.agent_session,
        task: result.task,
      });
    },

    async cancelAgent(input: CancelAgentInputValue) {
      const parsed = CancelAgentInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      if (hasPendingUserAction(parsed.flow_id)) return fail("PENDING_USER_ACTION", "A user action is pending.");
      const result = await store.cancelAgent({
        flowId: parsed.flow_id,
        taskId: parsed.task_id,
        currentTurnInput: currentTurnInput(),
      });
      if (!result.ok) return fail(result.error.code, result.error.message);
      return ok({ agent_session: result.agent_session, task: result.task });
    },

    async sendMessage(input: SendMessageInputValue) {
      const parsed = SendMessageInput.parse(input);
      if (isCancellationFollowup()) return cancellationFailure();
      const result = await store.sendMessage({
        flowId: parsed.flow_id,
        agentSessionId: parsed.agent_session_id,
        content: parsed.content,
        summary: parsed.summary,
        currentTurnInput: currentTurnInput(),
      });
      return ok(result);
    },
  };
}

export function createLeaderMcpServer(handlers: ReturnType<typeof createLeaderToolHandlers>) {
  const server = new McpServer({ name: "squadflow-leader", version: "0.1.0" });

  server.registerTool(
    "get_context",
    { title: "get_context", description: "Return the current SquadFlow Platform context for a Flow.", inputSchema: GetContextInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.getContext(input) }] }),
  );

  server.registerTool(
    "ask_user",
    { title: "ask_user", description: "Ask the user clarification questions. Creates a pending clarification card.", inputSchema: AskUserInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.askUser(input) }] }),
  );

  server.registerTool(
    "create_plan",
    { title: "create_plan", description: "Create or rewrite a Spec plan. The UI shows it as a pending Spec card.", inputSchema: CreatePlanInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.createPlan(input) }] }),
  );

  server.registerTool(
    "create_task",
    { title: "create_task", description: "Create a task for the active UserTurn (single-expert path). Multi-step same-role work goes into one task description. Do not use after an orchestration plan was submitted this turn.", inputSchema: CreateTaskInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.createTask(input) }] }),
  );

  server.registerTool(
    "save_execution_plan",
    { title: "save_execution_plan", description: "Save an execution plan artifact for the active UserTurn (e.g. after Spec approval, single-expert path).", inputSchema: SaveExecutionPlanInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.saveExecutionPlan(input) }] }),
  );

  server.registerTool(
    "submit_orchestration_plan",
    {
      title: "submit_orchestration_plan",
      description:
        "Submit a multi-expert orchestration plan. Requires 2+ distinct enabled expert roles; single-role work must use create_task + dispatch_agent instead. node expert_id may be person_name, role_title, or template expert_id. After success, stop; platform handles approval and execution.",
      inputSchema: SubmitOrchestrationPlanInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.submitOrchestrationPlan(input) }] }),
  );

  server.registerTool(
    "resolve_plan_feedback",
    { title: "resolve_plan_feedback", description: "Resolve feedback without changing the plan and restore its pending approval.", inputSchema: ResolvePlanFeedbackInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.resolvePlanFeedback(input) }] }),
  );

  server.registerTool(
    "update_task",
    { title: "update_task", description: "Update task fields, status, or dependencies (single-expert / manual task path).", inputSchema: UpdateTaskInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.updateTask(input) }] }),
  );

  server.registerTool(
    "list_tasks",
    { title: "list_tasks", description: "List tasks for a Flow.", inputSchema: ListTasksInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.listTasks(input) }] }),
  );

  server.registerTool(
    "get_task",
    { title: "get_task", description: "Get one task by id.", inputSchema: GetTaskInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.getTask(input) }] }),
  );

  server.registerTool(
    "dispatch_agent",
    { title: "dispatch_agent", description: "Start or resume a task-bound Expert (single-expert path). expert_id must be an enabled template id from get_context.experts.", inputSchema: DispatchAgentInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.dispatchAgent(input) }] }),
  );

  server.registerTool(
    "cancel_agent",
    { title: "cancel_agent", description: "Interrupt the running Expert AgentSession bound to a Task.", inputSchema: CancelAgentInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.cancelAgent(input) }] }),
  );

  server.registerTool(
    "send_message",
    { title: "send_message", description: "Send a non-blocking runtime message to a running agent session.", inputSchema: SendMessageInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.sendMessage(input) }] }),
  );

  return server;
}

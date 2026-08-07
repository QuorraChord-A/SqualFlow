import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AskUserInput,
  AbandonChangeSetInput,
  BindChangeSetInput,
  CancelAgentInput,
  CreatePlanInput,
  CreateTaskInput,
  DispatchAgentInput,
  FinalizeChangeSetInput,
  GetContextInput,
  GetTaskInput,
  ListTasksInput,
  OpenChangeSetInput,
  ResolveOrchestrationFeedbackInput,
  SubmitOrchestrationPlanInput,
  SendMessageInput,
  UpdateTaskInput,
  UpdateFlowNameInput,
  type AskUserInputValue,
  type AbandonChangeSetInputValue,
  type BindChangeSetInputValue,
  type CancelAgentInputValue,
  type CreatePlanInputValue,
  type CreateTaskInputValue,
  type DispatchAgentInputValue,
  type FinalizeChangeSetInputValue,
  type GetContextInputValue,
  type GetTaskInputValue,
  type ListTasksInputValue,
  type OpenChangeSetInputValue,
  type QuestionInputValue,
  type ResolveOrchestrationFeedbackInputValue,
  type SubmitOrchestrationPlanInputValue,
  type SendMessageInputValue,
  type UpdateTaskInputValue,
  type UpdateFlowNameInputValue,
} from "./platformModels.js";

export interface CurrentTurnInput {
  trigger_kind:
    | "user_message"
    | "decision_resolved"
    | "decision_cancelled"
    | "plan_resolved"
    | "orchestration_resolved"
    | "expert_result"
    | "expert_message"
    | "flow_name_generation";
  agent_run_id?: string;
  message_id?: string;
  decision_request_id?: string;
  content?: string;
  answers?: Record<string, string | string[]>;
  created_at: string;
}

export interface PendingUserActionRow {
  id: string;
  type: "plan_approval" | "orchestration_approval" | "decision_request";
  status: "pending";
}

export type LeaderToolHooks = {
  onFlowNameUpdated?: (args: {
    flowId: string;
    flow: { flow_id: string; name: string; name_generation_status: "pending" | "generated" | "fallback" | "manual" };
  }) => Promise<void> | void;
  onDecisionRequestCreated?: (args: {
    flowId: string;
    decisionRequestId: string;
    agentRunId: string;
    questions: QuestionInputValue[];
  }) => Promise<void> | void;
  onPlanCreated?: (args: {
    flowId: string;
    planRevision: Record<string, unknown>;
    approval: Record<string, unknown>;
  }) => Promise<void> | void;
  onTaskCreated?: (args: { flowId: string; task: Record<string, unknown> }) => Promise<void> | void;
  onTaskUpdated?: (args: { flowId: string; task: Record<string, unknown> }) => Promise<void> | void;
  onOrchestrationCreated?: (args: {
    flowId: string;
    revision: Record<string, unknown>;
    approval: Record<string, unknown> | null;
    tasks: Array<Record<string, unknown>>;
  }) => Promise<void> | void;
};

export interface StorePort {
  getContext: (flowId: string) => Record<string, unknown> | null;
  updateFlowName: (args: { flowId: string; name: string; currentTurnInput?: CurrentTurnInput }) =>
    | { ok: true; flow: { flow_id: string; name: string; name_generation_status: "generated" } }
    | { ok: false; error: { code: string; message: string } };
  listPendingUserActions: (args: { flowId: string }) => PendingUserActionRow[];
  askUser: (args: {
    flowId: string;
    decisionRequestId: string;
    questions: QuestionInputValue[];
    sourceAgentRunId?: string;
  }) => Record<string, unknown> | null;
  createPlan: (args: {
    flowId: string;
    mode: "write" | "rewrite";
    name?: string;
    overview: string;
    plan: string;
    sourceAgentRunId?: string;
  }) => { plan_revision: Record<string, unknown>; plan_approval: Record<string, unknown> }
    | { error: { code: string; message: string } };
  createTask: (args: {
    flowId: string;
    subject: string;
    description: string;
    activeForm?: string;
    sourceAgentRunId?: string;
  }) => { task: Record<string, unknown> } | { error: { code: string; message: string } };
  submitOrchestrationPlan: (args: SubmitOrchestrationPlanInputValue & { sourceAgentRunId?: string }) =>
    | { revision: Record<string, unknown>; approval: Record<string, unknown> | null; tasks: Array<Record<string, unknown>>; [key: string]: unknown }
    | { error: { code: string; message: string; issues?: unknown[] } };
  resolveOrchestrationFeedback: (args: {
    flowId: string;
    orchestrationApprovalId: string;
    resolutionNote: string;
  }) => Record<string, unknown> | null;
  updateTask: (args: {
    flowId: string;
    taskId: string;
    status?: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
    expectedRevision?: number;
    subject?: string;
    description?: string;
    activeForm?: string;
    progress?: string | null;
    recommendedAgentDefinitionId?: string;
    metadata?: Record<string, unknown>;
    addBlockedBy?: string[];
  }) => Record<string, unknown> | null;
  listTasks: (args: { flowId: string }) => Array<Record<string, unknown>>;
  getTask: (args: { flowId: string; taskId: string }) => Record<string, unknown> | null;
  dispatchAgent: (args: {
    flowId: string;
    taskId: string;
    agentDefinitionId: string;
    prompt?: string;
  }) => Promise<{ ok: true; agent_run: Record<string, unknown>; task: Record<string, unknown> }
    | { ok: false; error: { code: string; message: string } }>;
  cancelAgent: (args: { flowId: string; agentSessionId: string }) => Promise<{
    ok: boolean;
    idempotent?: boolean;
    agent_run?: Record<string, unknown>;
    error?: { code: string; message: string };
  }>;
  sendMessage: (args: {
    flowId: string;
    agentSessionId: string;
    taskId?: string;
    message: string;
  }) => Promise<{
    ok: true;
    accepted: boolean;
    agent_run_id?: string;
    message_id?: string;
    error?: { code: string; message: string };
  }>;
  openChangeSet: (args: { flowId: string; agentRunId: string; title?: string }) => Record<string, unknown> | null;
  bindChangeSet: (args: { flowId: string; changeSetId: string; agentRunId: string; taskId?: string }) => Record<string, unknown> | null;
  finalizeChangeSet: (args: { flowId: string; changeSetId: string; summary: string }) => Record<string, unknown> | null;
  abandonChangeSet: (args: { flowId: string; changeSetId: string }) => Record<string, unknown> | null;
}

export type LeaderToolRuntimeContext = {
  currentTurnInput?: CurrentTurnInput;
  getCurrentTurnInput?: () => CurrentTurnInput | undefined;
  leaderAgentRunId?: string;
};

const json = (value: unknown) => JSON.stringify(value);
const ok = (fields: Record<string, unknown> = {}) => json({ ok: true, ...fields });
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error: { code, message, ...extra } });

export function createLeaderToolHandlers(
  store: StorePort,
  hooks: LeaderToolHooks = {},
  runtimeContext: LeaderToolRuntimeContext = {},
) {
  const current = () => runtimeContext.getCurrentTurnInput?.() ?? runtimeContext.currentTurnInput;
  const leaderRunId = () => runtimeContext.leaderAgentRunId ?? current()?.agent_run_id;

  return {
    async getContext(input: GetContextInputValue) {
      const parsed = GetContextInput.parse(input);
      const context = store.getContext(parsed.flow_id);
      return context ? ok(context) : fail("FLOW_NOT_FOUND", `flow not found: ${parsed.flow_id}`);
    },

    async updateFlowName(input: UpdateFlowNameInputValue) {
      const parsed = UpdateFlowNameInput.parse(input);
      const result = store.updateFlowName({ flowId: parsed.flow_id, name: parsed.name, currentTurnInput: current() });
      if (!result.ok) return fail(result.error.code, result.error.message);
      await hooks.onFlowNameUpdated?.({ flowId: parsed.flow_id, flow: result.flow });
      return ok({ flow: result.flow });
    },

    async askUser(input: AskUserInputValue) {
      const parsed = AskUserInput.parse(input);
      const sourceAgentRunId = leaderRunId();
      if (!sourceAgentRunId) return fail("AGENT_RUN_REQUIRED", "ask_user 只能由当前 Leader AgentRun 调用。");
      const decisionRequestId = `dreq-${crypto.randomBytes(6).toString("hex")}`;
      const request = store.askUser({
        flowId: parsed.flow_id,
        decisionRequestId,
        questions: parsed.questions,
        sourceAgentRunId,
      });
      if (!request) return fail("DECISION_REQUEST_CREATE_FAILED", "无法创建澄清请求。");
      await hooks.onDecisionRequestCreated?.({
        flowId: parsed.flow_id,
        decisionRequestId,
        agentRunId: sourceAgentRunId,
        questions: parsed.questions,
      });
      return ok({ decision_request_id: decisionRequestId, status: "pending", question_count: parsed.questions.length });
    },

    async createPlan(input: CreatePlanInputValue) {
      const parsed = CreatePlanInput.parse(input);
      const sourceAgentRunId = leaderRunId();
      if (!sourceAgentRunId) return fail("AGENT_RUN_REQUIRED", "create_plan 只能由当前 Leader AgentRun 调用。");
      if (parsed.mode === "write" && !parsed.name) return fail("INVALID_ARGUMENTS", "创建计划缺少 name。");
      const result = store.createPlan({
        flowId: parsed.flow_id,
        mode: parsed.mode,
        name: parsed.name,
        overview: parsed.overview,
        plan: parsed.plan,
        sourceAgentRunId,
      });
      if ("error" in result) return fail(result.error.code, result.error.message);
      await hooks.onPlanCreated?.({
        flowId: parsed.flow_id,
        planRevision: result.plan_revision,
        approval: result.plan_approval,
      });
      return ok(result);
    },

    async createTask(input: CreateTaskInputValue) {
      const parsed = CreateTaskInput.parse(input);
      const sourceAgentRunId = leaderRunId();
      if (!sourceAgentRunId) return fail("AGENT_RUN_REQUIRED", "create_task 只能由当前 Leader AgentRun 调用。");
      const result = store.createTask({
        flowId: parsed.flow_id,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.active_form,
        sourceAgentRunId,
      });
      if ("error" in result) return fail(result.error.code, result.error.message);
      await hooks.onTaskCreated?.({ flowId: parsed.flow_id, task: result.task });
      return ok(result);
    },

    async submitOrchestrationPlan(input: SubmitOrchestrationPlanInputValue) {
      const parsed = SubmitOrchestrationPlanInput.parse(input);
      const sourceAgentRunId = leaderRunId();
      if (!sourceAgentRunId) return fail("AGENT_RUN_REQUIRED", "submit_orchestration_plan 只能由当前 Leader AgentRun 调用。");
      const result = store.submitOrchestrationPlan({ ...parsed, sourceAgentRunId });
      if ("error" in result) {
        const error = result.error as { code: string; message: string; issues?: unknown[] };
        return fail(error.code, error.message, { issues: error.issues ?? [] });
      }
      await hooks.onOrchestrationCreated?.({
        flowId: parsed.flow_id,
        revision: result.revision,
        approval: result.approval,
        tasks: result.tasks,
      });
      return ok({
        ...result,
        next: result.approval
          ? "编排计划正在等待用户批准；结束当前 Leader Run。"
          : "编排计划已按 automatic 模式物化 Task；当前 Leader Run 可继续决定如何派发。",
      });
    },

    async resolveOrchestrationFeedback(input: ResolveOrchestrationFeedbackInputValue) {
      const parsed = ResolveOrchestrationFeedbackInput.parse(input);
      const result = store.resolveOrchestrationFeedback({
        flowId: parsed.flow_id,
        orchestrationApprovalId: parsed.orchestration_approval_id,
        resolutionNote: parsed.resolution_note,
      });
      return result ? ok({ feedback: result }) : fail("INVALID_ORCHESTRATION_FEEDBACK", "无法处理该编排反馈。");
    },

    async updateTask(input: UpdateTaskInputValue) {
      const parsed = UpdateTaskInput.parse(input);
      const task = store.updateTask({
        flowId: parsed.flow_id,
        taskId: parsed.task_id,
        status: parsed.status,
        expectedRevision: parsed.expected_revision,
        subject: parsed.subject,
        description: parsed.description,
        activeForm: parsed.active_form,
        progress: parsed.progress,
        recommendedAgentDefinitionId: parsed.recommended_agent_definition_id,
        metadata: parsed.metadata,
        addBlockedBy: parsed.add_blocked_by,
      });
      if (!task) return parsed.expected_revision === undefined
        ? fail("INVALID_TASK", `task not found: ${parsed.task_id}`)
        : fail("TASK_REVISION_CONFLICT", `task changed or was not found: ${parsed.task_id}`);
      await hooks.onTaskUpdated?.({ flowId: parsed.flow_id, task });
      return ok({ task });
    },

    async listTasks(input: ListTasksInputValue) {
      const parsed = ListTasksInput.parse(input);
      return ok({ tasks: store.listTasks({ flowId: parsed.flow_id }) });
    },

    async getTask(input: GetTaskInputValue) {
      const parsed = GetTaskInput.parse(input);
      const task = store.getTask({ flowId: parsed.flow_id, taskId: parsed.task_id });
      return task ? ok({ task }) : fail("INVALID_TASK", `task not found: ${parsed.task_id}`);
    },

    async dispatchAgent(input: DispatchAgentInputValue) {
      const parsed = DispatchAgentInput.parse(input);
      const result = await store.dispatchAgent({
        flowId: parsed.flow_id,
        taskId: parsed.task_id,
        agentDefinitionId: parsed.agent_definition_id,
        prompt: parsed.prompt,
      });
      return result.ok ? ok({ agent_run: result.agent_run, task: result.task }) : fail(result.error.code, result.error.message);
    },

    async cancelAgent(input: CancelAgentInputValue) {
      const parsed = CancelAgentInput.parse(input);
      const result = await store.cancelAgent({ flowId: parsed.flow_id, agentSessionId: parsed.agent_session_id });
      return result.ok
        ? ok({ agent_run: result.agent_run ?? null, idempotent: result.idempotent ?? false })
        : fail(result.error?.code ?? "AGENT_CANCEL_FAILED", result.error?.message ?? "取消 Agent 失败");
    },

    async sendMessage(input: SendMessageInputValue) {
      const parsed = SendMessageInput.parse(input);
      return ok(await store.sendMessage({
        flowId: parsed.flow_id,
        agentSessionId: parsed.agent_session_id,
        taskId: parsed.task_id,
        message: parsed.message,
      }));
    },

    async openChangeSet(input: OpenChangeSetInputValue) {
      const parsed = OpenChangeSetInput.parse(input);
      const sourceAgentRunId = leaderRunId();
      if (!sourceAgentRunId) return fail("AGENT_RUN_REQUIRED", "open_change_set 只能由当前 Leader AgentRun 调用。");
      const changeSet = store.openChangeSet({ flowId: parsed.flow_id, agentRunId: sourceAgentRunId, title: parsed.title });
      return changeSet ? ok({ change_set: changeSet }) : fail("CHANGE_SET_OPEN_FAILED", "无法从当前 AgentRun 的 baseline 打开 ChangeSet。");
    },

    async bindChangeSet(input: BindChangeSetInputValue) {
      const parsed = BindChangeSetInput.parse(input);
      const changeSet = store.bindChangeSet({
        flowId: parsed.flow_id,
        changeSetId: parsed.change_set_id,
        agentRunId: parsed.agent_run_id,
        taskId: parsed.task_id,
      });
      return changeSet ? ok({ change_set: changeSet }) : fail("CHANGE_SET_BIND_FAILED", "ChangeSet 必须处于 open，且 AgentRun、Task 与 Flow 归属一致。");
    },

    async finalizeChangeSet(input: FinalizeChangeSetInputValue) {
      const parsed = FinalizeChangeSetInput.parse(input);
      const changeSet = store.finalizeChangeSet({ flowId: parsed.flow_id, changeSetId: parsed.change_set_id, summary: parsed.summary });
      return changeSet ? ok({ change_set: changeSet }) : fail("CHANGE_SET_FINALIZE_FAILED", "ChangeSet 不存在、不属于当前 Flow 或已终态。");
    },

    async abandonChangeSet(input: AbandonChangeSetInputValue) {
      const parsed = AbandonChangeSetInput.parse(input);
      const changeSet = store.abandonChangeSet({ flowId: parsed.flow_id, changeSetId: parsed.change_set_id });
      return changeSet ? ok({ change_set: changeSet }) : fail("CHANGE_SET_ABANDON_FAILED", "ChangeSet 不存在、不属于当前 Flow 或已终态。");
    },
  };
}

export function createLeaderMcpServer(handlers: ReturnType<typeof createLeaderToolHandlers>) {
  const server = new McpServer({ name: "squadflow-leader", version: "0.2.0" });
  const register = (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (input: any) => Promise<string>,
  ) => (server.registerTool as any)(
    name,
    { title: name, description, inputSchema },
    async (input: any) => ({ content: [{ type: "text", text: await handler(input) }] }),
  );

  register("get_context", "读取当前 Flow 的 Supervisor 投影。", GetContextInput, handlers.getContext);
  register("update_flow_name", "在内部命名 Run 中设置 Flow 名称。", UpdateFlowNameInput, handlers.updateFlowName);
  register("ask_user", "创建普通澄清请求；解决后平台创建新的 Leader AgentRun。", AskUserInput, handlers.askUser);
  register("create_plan", "创建或修订 Flow 计划。每个修订精确绑定自己的审批。", CreatePlanInput, handlers.createPlan);
  register("create_task", "创建 Flow 内的持久 Task。Task 状态不会由 AgentRun 结果自动推导。", CreateTaskInput, handlers.createTask);
  register(
    "submit_orchestration_plan",
    "创建编排修订。单 Expert 也允许建卡；approval_required 等待批准，automatic 立即物化 Task。",
    SubmitOrchestrationPlanInput,
    handlers.submitOrchestrationPlan,
  );
  register("resolve_orchestration_feedback", "标记当前编排修订反馈已处理。", ResolveOrchestrationFeedbackInput, handlers.resolveOrchestrationFeedback);
  register("update_task", "显式更新 Task 字段、业务状态或依赖。", UpdateTaskInput, handlers.updateTask);
  register("list_tasks", "列出 Flow 内 Task。", ListTasksInput, handlers.listTasks);
  register("get_task", "读取一个 Task。", GetTaskInput, handlers.getTask);
  register(
    "dispatch_agent",
    "为 Task 创建新的 Expert AgentSession 与首个 AgentRun；平台不会替 Leader 选择是否复用旧 Session。",
    DispatchAgentInput,
    handlers.dispatchAgent,
  );
  register(
    "send_message",
    "向已有 Expert AgentSession 发送消息；运行中引导当前 Run，空闲时在同一 Session 创建新 Run。",
    SendMessageInput,
    handlers.sendMessage,
  );
  register("cancel_agent", "幂等取消指定 Expert AgentSession 的当前活跃 AgentRun。", CancelAgentInput, handlers.cancelAgent);
  register("open_change_set", "从当前 Leader AgentRun 已捕获的 baseline 显式打开 ChangeSet。首次真实写入仍会自动懒创建。", OpenChangeSetInput, handlers.openChangeSet);
  register("bind_change_set", "把同一 Flow 内的 AgentRun（及可选 Task）绑定到一个 open ChangeSet。", BindChangeSetInput, handlers.bindChangeSet);
  register("finalize_change_set", "冻结 ChangeSet 当前文件投影和 Review，后续修改不会覆盖该历史。", FinalizeChangeSetInput, handlers.finalizeChangeSet);
  register("abandon_change_set", "放弃 open ChangeSet，但保留历史记录。", AbandonChangeSetInput, handlers.abandonChangeSet);
  return server;
}

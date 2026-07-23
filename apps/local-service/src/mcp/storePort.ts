import type { Store } from "../db/store.js";
import type { AgentDispatcher } from "../runtime/agentDispatcher.js";
import { isExpertRuntimeEnabled, readAgentRuntimeConfigSnapshotSync } from "../config/agentRuntimeConfig.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import type { StorePort } from "./leaderServer.js";
import { DeclarativeOrchestrationRuleSchema, diffPlanNodes, evaluateDeclarativeRules, lintOrchestrationPlan } from "../domain/orchestration.js";
import type { PlanLintIssue, SubmitOrchestrationPlanInput } from "../domain/orchestration.js";
import { normalizeFlowName } from "../domain/flowName.js";

type AgentDispatchResult = {
  agent_session_id: string;
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
    agent_session_id: string | null;
  };
  error?: string;
};

type DispatchAgentResult =
  | { ok: true; agent_session: Record<string, unknown>; task: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function localIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number, width = 2) => String(part).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  return [
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`,
  ].join("");
}

function localizeContextTimestamps(value: unknown, key = ""): unknown {
  if (typeof value === "string" && key.endsWith("_at")) return localIsoTimestamp(value);
  if (Array.isArray(value)) return value.map((item) => localizeContextTimestamps(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      localizeContextTimestamps(childValue, childKey),
    ]),
  );
}

function taskToPlatform(
  task: ReturnType<Store["listTasks"]>[number],
  blockedBy: string[],
  blocks: string[] = [],
) {
  return {
    task_id: task.id,
    user_turn_id: task.userTurnId,
    subject: task.title,
    description: task.description,
    active_form: task.activeForm,
    status: task.status,
    expert_id: task.expertId,
    agent_session_id: task.agentSessionId,
    metadata: parseJsonObject(task.metadataJson),
    blocked_by: blockedBy,
    blocks,
  };
}

export type StorePortOptions = {
  /** Template expert ids whose runtime role is enabled. Injectable for tests; the default reads the runtime config synchronously. */
  getEnabledExpertIds?: () => Set<string>;
};

export function createStorePort(
  store: Store,
  agentDispatcher?: AgentDispatcher,
  options?: StorePortOptions,
): StorePort {
  const getEnabledExpertIds = options?.getEnabledExpertIds ?? (() => {
    const roles = readAgentRuntimeConfigSnapshotSync().roles;
    return new Set(
      store.listExperts()
        .filter((expert) => isExpertRuntimeEnabled(roles, expert.role))
        .map((expert) => expert.id),
    );
  });
  function activeCurrentTurn(flowId: string, currentTurnInput: { user_turn_id?: string } | undefined) {
    const userTurnId = currentTurnInput?.user_turn_id;
    const turn = userTurnId ? store.getUserTurn(userTurnId) : undefined;
    return turn && turn.flowId === flowId && turn.status === "active" ? turn : null;
  }

  function taskForCurrentTurn(
    flowId: string,
    taskId: string,
    currentTurnInput: { user_turn_id?: string } | undefined,
  ) {
    const turn = activeCurrentTurn(flowId, currentTurnInput);
    const task = store.getTask(taskId);
    return turn && task && task.flowId === flowId && task.userTurnId === turn.id ? task : null;
  }

  function listBlocks(taskId: string): string[] {
    return store.listTasks(store.getTask(taskId)!.flowId)
      .filter((other) => store.listTaskDependencies(other.id).includes(taskId))
      .map((other) => other.id);
  }

  return {
    getContext(flowId) {
      const snapshot = buildFlowSnapshot(store, flowId);
      if ("error" in snapshot) return null;
      const flow = store.getFlow(flowId);
      const project = flow?.projectId ? store.getProject(flow.projectId) : undefined;
      return localizeContextTimestamps({
        ...snapshot,
        flow_id: flowId,
        project_root_path: project?.localPath ?? "",
      }) as Record<string, unknown>;
    },

    updateFlowName(input) {
      const flow = store.getFlow(input.flowId);
      if (!flow) return { ok: false, error: { code: "FLOW_NOT_FOUND", message: "Flow not found." } };
      if (input.currentTurnInput?.trigger_kind !== "flow_name_generation") {
        return { ok: false, error: { code: "FLOW_NAME_GENERATION_REQUIRED", message: "Flow name generation is not active." } };
      }
      if (flow.nameGenerationStatus !== "pending") {
        return { ok: false, error: { code: "FLOW_NAME_ALREADY_RESOLVED", message: "Flow name generation is already resolved." } };
      }
      const updated = store.updateFlow(input.flowId, {
        name: normalizeFlowName(input.name, flow.name),
        nameGenerationStatus: "generated",
      });
      return updated
        ? { ok: true, flow: { flow_id: updated.id, name: updated.name, name_generation_status: "generated" } }
        : { ok: false, error: { code: "FLOW_NOT_FOUND", message: "Flow not found." } };
    },

    listPendingUserActions({ flowId }) {
      return [
        ...store.listDecisionCards(flowId)
          .filter((card) => card.status === "pending")
          .map((card) => ({ id: card.id, type: "clarification" as const, status: "pending" as const })),
        ...store.listSpecApprovals(flowId)
          .filter((approval) => approval.status === "pending")
          .map((approval) => ({ id: approval.id, type: "spec_approval" as const, status: "pending" as const })),
        ...store.listPlanApprovals(flowId)
          .filter((approval) => approval.status === "pending" || approval.status === "feedback_pending")
          .map((approval) => ({ id: approval.id, type: "plan_approval" as const, status: "pending" as const })),
      ];
    },

    createPlan(input) {
      const userTurnId = input.currentTurnInput?.user_turn_id;
      const turn = userTurnId ? store.getUserTurn(userTurnId) : undefined;
      if (!turn || turn.flowId !== input.flowId || turn.status !== "active") return null;
      const created = store.createSpecPlan({
        flowId: input.flowId,
        mode: input.mode,
        name: input.name,
        overview: input.overview,
        content: input.plan,
        sourceAgentSessionId: input.sourceAgentSessionId,
        userTurnId: turn.id,
      });
      if (!created) return null;
      const { spec, approval } = created;

      return {
        spec_revision: {
          spec_revision_id: spec.id,
          revision_number: spec.revisionNumber,
          status: spec.status,
          file_name: spec.fileName,
          overview: spec.overview,
        },
        spec_approval: {
          spec_approval_id: approval.id,
          user_turn_id: approval.userTurnId,
          status: approval.status,
          actions: ["run"],
        },
      };
    },

    askUser(input) {
      const userTurnId = input.currentTurnInput?.user_turn_id;
      if (!userTurnId) return undefined;
      const card = store.createDecisionCard({
        ...input,
        userTurnId,
        cardType: "clarification",
      });
      return card && card.userTurnId ? { id: card.id, status: card.status, userTurnId: card.userTurnId } : undefined;
    },

    createTask(input) {
      const createTaskError = (code: string, message: string) => ({ error: { code, message } });
      const userTurnId = input.currentTurnInput?.user_turn_id;
      const turn = userTurnId ? store.getUserTurn(userTurnId) : undefined;
      if (!turn || turn.flowId !== input.flowId || turn.status !== "active") {
        return createTaskError("ACTIVE_USER_TURN_REQUIRED", "Task could not be created for the current UserTurn.");
      }
      if (input.currentTurnInput?.spec_requested === true) {
        return createTaskError("SPEC_REQUEST_ACTIVE", "本消息要求 Spec：先 create_plan 并等待批准，不要直接创建任务。");
      }
      // Multi-expert orchestration owns task creation for this turn.
      if (store.listOrchestrationPlans(input.flowId).some((plan) => plan.userTurnId === turn.id)) {
        return createTaskError("ORCHESTRATION_PLAN_ACTIVE", "本轮已有编排计划，计划节点已物化为任务；用 dispatch_agent 派发它们，不要再 create_task。");
      }

      const current = input.currentTurnInput;
      const pendingActions = [
        ...store.listDecisionCards(input.flowId).filter((card) => card.status === "pending"),
        ...store.listSpecApprovals(input.flowId).filter((approval) => approval.status === "pending"),
      ];
      if (pendingActions.length > 0) {
        return createTaskError("PENDING_USER_ACTION", "存在待用户处理的卡片；等待用户完成后再创建任务。");
      }

      // First task(s) for a direct message turn: start work + create task.
      if (!turn.workSource) {
        if (!current || (current.trigger_kind !== "user_message" && current.trigger_kind !== "decision_resolved")) {
          return createTaskError("INVALID_TRIGGER", "当前触发类型不能开启新工作；仅用户消息或决策解决可创建本轮首个任务。");
        }
        const created = store.createDirectUserTurnTask({
          flowId: input.flowId,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          currentTurnInput: current,
        });
        return created ? {
          user_turn_id: created.userTurn.id,
          task: taskToPlatform(created.task, store.listTaskDependencies(created.task.id)),
        } : createTaskError("TASK_CREATE_FAILED", "Task could not be created for the current UserTurn.");
      }

      if (turn.workSource === "spec") {
        const hasPlan = store.listArtifacts(input.flowId)
          .some((artifact) => artifact.userTurnId === turn.id && artifact.type === "execution_plan");
        if (!hasPlan) {
          return createTaskError("EXECUTION_PLAN_REQUIRED", "Spec 轮次需先 save_execution_plan，再创建任务。");
        }
      }
      const task = store.createTask({
        flowId: input.flowId,
        userTurnId: turn.id,
        title: input.subject,
        description: input.description,
        expertId: null,
        activeForm: input.activeForm,
        dependsOnTaskIds: [],
      });
      return task ? {
        user_turn_id: turn.id,
        task: taskToPlatform(task, store.listTaskDependencies(task.id)),
      } : createTaskError("TASK_CREATE_FAILED", "Task could not be created for the current UserTurn.");
    },

    saveExecutionPlan(input) {
      const turn = activeCurrentTurn(input.flowId, input.currentTurnInput);
      if (!turn) return null;
      if (input.currentTurnInput?.spec_requested === true) return null;
      if (!turn.workSource) {
        const flow = store.getFlow(input.flowId);
        if (!flow?.projectId) return null;
        const initialized = store.startUserTurnWork({
          flowId: input.flowId,
          userTurnId: turn.id,
          workSource: "direct_message",
          targetProjectId: flow.projectId,
          inputSnapshotJson: JSON.stringify({ type: "direct_message", message_id: turn.triggerMessageId }),
        });
        if (!initialized) return null;
      }
      const artifact = store.createArtifact({
        flowId: input.flowId,
        userTurnId: turn.id,
        taskId: null,
        type: "execution_plan",
        title: input.title,
        content: input.plan,
        sourceAgentSessionId: input.sourceAgentSessionId,
      });
      if (!artifact) return null;
      return {
        id: artifact.id,
        flow_id: artifact.flowId,
        user_turn_id: artifact.userTurnId,
        task_id: artifact.taskId,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        source_agent_session_id: artifact.sourceAgentSessionId,
        created_at: artifact.createdAt,
        updated_at: artifact.updatedAt,
      };
    },

    submitOrchestrationPlan(input) {
      const turn = activeCurrentTurn(input.flow_id, input.currentTurnInput);
      if (!turn) return null;
      const flow = store.getFlow(input.flow_id);
      if (!flow?.projectId) return null;
      const current = input.currentTurnInput;
      if (current?.spec_requested === true) return null;
      // Resolve and lint before mutating the turn so a rejected submission has no side effects
      // and the Leader can fall back to the single-expert path in the same turn.
      // Leader may pass person_name, role_title, role, or template expert_id.
      // Does not pre-create FlowExperts; they appear when the plan runs / dispatch happens.
      const unresolved: string[] = [];
      const resolvedNodes = input.nodes.map((node) => {
        const templateId = store.resolveExpertRef(input.flow_id, node.expert_id);
        if (!templateId) unresolved.push(node.expert_id);
        return { ...node, expert_id: templateId ?? node.expert_id };
      });
      if (unresolved.length > 0) {
        return {
          error: {
            code: "PLAN_LINT_REJECTED",
            issues: unresolved.map((name) => ({
              code: "EXPERT_UNAVAILABLE",
              severity: "block" as const,
              message: `无法识别专家「${name}」：请使用 get_context.experts 中 enabled 的角色中文名/expert_id，或 team 中已有 person_name`,
            })),
          },
        };
      }
      const resolvedInput: SubmitOrchestrationPlanInput = { ...input, nodes: resolvedNodes };
      const availableExperts = new Set(store.listExperts().map((expert) => expert.id));
      const enabledExpertIds = getEnabledExpertIds();
      const runtimeDisabledIssues: PlanLintIssue[] = resolvedInput.nodes
        .filter((node) => availableExperts.has(node.expert_id) && !enabledExpertIds.has(node.expert_id))
        .map((node) => ({
          code: "EXPERT_RUNTIME_DISABLED",
          severity: "block" as const,
          message: `专家「${store.getExpert(node.expert_id)?.name ?? node.expert_id}」当前未启用（智能体配置）；请向用户说明该角色未启用并等待用户决定，不要改派其它角色顶替`,
          node_id: node.node_id,
        }));
      const customRules = store.listOrchestrationRules({ flowId: flow.id, projectId: flow.projectId })
        .filter((row) => row.enabled)
        .flatMap((row) => {
          const parsed = DeclarativeOrchestrationRuleSchema.safeParse(parseJsonObject(row.ruleJson));
          return parsed.success ? [{ id: row.id, name: row.name, severity: row.severity as "block" | "warn" | "info", rule: parsed.data }] : [];
        });
      const lint = [
        ...lintOrchestrationPlan(resolvedInput, availableExperts),
        ...runtimeDisabledIssues,
        ...evaluateDeclarativeRules(resolvedInput, customRules),
      ];
      const blocking = lint.filter((issue) => issue.severity === "block");
      if (blocking.length > 0) return { error: { code: "PLAN_LINT_REJECTED", issues: lint } };
      if (!turn.workSource) {
        const initialized = store.startUserTurnWork({
          flowId: input.flow_id,
          userTurnId: turn.id,
          workSource: "direct_message",
          specRevisionId: turn.specRevisionId,
          targetProjectId: flow.projectId,
          inputSnapshotJson: turn.inputSnapshotJson === "{}"
            ? JSON.stringify({ type: "direct_message", message_id: turn.triggerMessageId })
            : turn.inputSnapshotJson,
        });
        if (!initialized) return null;
      }

      const feedbackApproval = store.listPlanApprovals(input.flow_id)
        .find((approval) => approval.userTurnId === turn.id && approval.status === "feedback_pending");
      const basedOnRevisionId = input.based_on_revision_id ?? feedbackApproval?.planRevisionId;
      const sourceFeedbackMessageId = input.source_feedback_message_id ?? input.currentTurnInput?.message_id;
      let previousNodes: Array<{
        node_id: string; expert_id: string; title: string; description: string; depends_on: string[];
        acceptance_criteria: string[]; risk_tags: string[]; side_effects: string[]; resource_keys: string[];
      }> = [];
      if (basedOnRevisionId) {
        const previousRevision = store.getPlanRevision(basedOnRevisionId);
        const plan = previousRevision ? store.getOrchestrationPlan(previousRevision.planId) : undefined;
        if (!previousRevision || !plan || plan.userTurnId !== turn.id) return { error: { code: "INVALID_BASE_REVISION" } };
        const nodes = store.listPlanNodes(previousRevision.id);
        const keyById = new Map(nodes.map((node) => [node.id, node.stableKey]));
        previousNodes = nodes.map((node) => ({
          node_id: node.stableKey,
          expert_id: node.expertId,
          title: node.title,
          description: node.description,
          depends_on: store.listPlanNodeDependencies(previousRevision.id, node.id).map((id) => keyById.get(id) ?? id),
          acceptance_criteria: parseJsonArray(node.acceptanceCriteriaJson),
          risk_tags: parseJsonArray(node.riskTagsJson),
          side_effects: parseJsonArray(node.sideEffectsJson),
          resource_keys: parseJsonArray(node.resourceKeysJson),
        }));
      }
      const requiresUserApproval = store.getPlanApprovalMode(flow.id) === "on";
      const diff = diffPlanNodes(previousNodes, resolvedInput.nodes);
      const created = store.createOrchestrationPlanRevision({
        flowId: input.flow_id,
        userTurnId: turn.id,
        specRevisionId: turn.specRevisionId,
        title: input.title,
        objective: input.objective,
        workKind: input.work_kind,
        riskLevel: input.risk_level,
        basedOnRevisionId,
        sourceFeedbackMessageId,
        sourceAgentSessionId: input.sourceAgentSessionId,
        status: requiresUserApproval ? "pending_approval" : "approved",
        lint,
        diff,
        nodes: resolvedInput.nodes.map((node) => ({
          nodeId: node.node_id,
          expertId: node.expert_id,
          title: node.title,
          description: node.description,
          dependsOn: node.depends_on,
          acceptanceCriteria: node.acceptance_criteria,
          riskTags: node.risk_tags,
          sideEffects: node.side_effects,
          resourceKeys: node.resource_keys,
        })),
      });
      if (!created) return null;
      return { plan: created.plan, revision: created.revision, approval: created.approval, lint, diff, auto_approved: !requiresUserApproval };
    },
    resolvePlanFeedback(input) {
      const turn = activeCurrentTurn(input.flowId, input.currentTurnInput);
      const approval = store.getPlanApproval(input.planApprovalId);
      if (!turn || !approval || approval.flowId !== input.flowId || approval.userTurnId !== turn.id) return null;
      const restoredApproval = store.restorePlanApprovalAfterFeedback(approval.id, input.resolutionNote);
      if (restoredApproval) return restoredApproval;
      const run = store.getPlanRunForRevision(approval.planRevisionId);
      if (!run || run.userTurnId !== turn.id || run.status !== "paused_for_feedback") return null;
      const resumed = store.resumePlanRunAfterFeedback(run.id, input.resolutionNote);
      return resumed
        ? { approval: store.getPlanApproval(approval.id) ?? approval, run: resumed }
        : null;
    },

    updateTask(input) {
      const task = taskForCurrentTurn(input.flowId, input.taskId, input.currentTurnInput);
      if (!task) return null;
      const updated = store.updateTask(input.taskId, {
        title: input.subject,
        description: input.description,
        status: input.status,
        activeForm: input.activeForm,
        owner: input.owner,
        metadata: input.metadata,
        addBlocks: input.addBlocks,
        addBlockedBy: input.addBlockedBy,
      });
      return updated
        ? taskToPlatform(updated, store.listTaskDependencies(updated.id), listBlocks(updated.id))
        : null;
    },

    listTasks({ flowId, currentTurnInput }) {
      const turn = activeCurrentTurn(flowId, currentTurnInput);
      if (!turn) return [];
      return store.listUserTurnTasks(turn.id)
        .map((task) => taskToPlatform(task, store.listTaskDependencies(task.id), listBlocks(task.id)));
    },

    getTask({ flowId, taskId, currentTurnInput }) {
      const task = taskForCurrentTurn(flowId, taskId, currentTurnInput);
      if (!task) return null;
      return taskToPlatform(task, store.listTaskDependencies(task.id), listBlocks(task.id));
    },

    dispatchAgent(input): Promise<DispatchAgentResult> {
      if (!taskForCurrentTurn(input.flowId, input.taskId, input.currentTurnInput)) {
        return Promise.resolve({
          ok: false,
          error: { code: "INVALID_TASK", message: `task not found: ${input.taskId}` },
        });
      }
      if (!agentDispatcher) {
        return Promise.resolve({
          ok: false,
          error: { code: "UNSUPPORTED_V1", message: "agent dispatcher is not attached" },
        });
      }
      return agentDispatcher.dispatchAgent(input).then((result: AgentDispatchResult): DispatchAgentResult => {
        if (result.status === "failed") {
          const code = result.error === "task_id is required in V1"
            ? "INVALID_TASK"
            : result.error === "flow not found"
              ? "FLOW_NOT_FOUND"
              : result.error === "expert not found"
                ? "EXPERT_NOT_FOUND"
                : result.error === "expert is disabled"
                  ? "EXPERT_DISABLED"
                  : result.error === "task not found"
                    ? "INVALID_TASK"
                    : result.error === "expert does not match task expert"
                      ? "EXPERT_MISMATCH"
                      : result.error === "task user turn is not active"
                        ? "USER_TURN_NOT_ACTIVE"
                        : result.error === "task is blocked by incomplete dependencies"
                          ? "TASK_BLOCKED"
                          : result.error === "plan is paused for feedback"
                            ? "PLAN_PAUSED"
                            : result.error === "resource conflict with a running task"
                              ? "RESOURCE_CONFLICT"
                          : result.error === "running sessions must use send_message"
                            ? "SESSION_RUNNING"
                            : result.error === "resume_agent_session_id is required for an ended task"
                              ? "RESUME_REQUIRED"
                              : result.error === "invalid resume_agent_session_id"
                                ? "INVALID_RESUME_SESSION"
                                : result.error === "resume session is not completed or failed"
                                  ? "INVALID_RESUME_SESSION"
                                  : result.error === "task is not in a resumable state"
                                    ? "TASK_NOT_RESUMABLE"
                                    : result.error === "resume session has no SDK session_id"
                                      ? "INVALID_RESUME_SESSION"
                                      : result.error === "task is not dispatchable"
                                        ? "TASK_NOT_DISPATCHABLE"
                                        : result.error === "task could not be started"
                                          ? "TASK_START_FAILED"
                                          : "UNSUPPORTED_V1";
          return {
            ok: false,
            error: { code, message: result.error ?? "dispatch_agent failed" },
          };
        }
        const session = store.getAgentSession(result.agent_session_id);
        const task = session?.taskId ? store.getTask(session.taskId) : null;
        return {
          ok: true,
          agent_session: session ? {
            agent_session_id: session.id,
            status: session.status,
            expert_id: session.expertId,
            task_id: session.taskId,
            user_turn_id: session.userTurnId,
            resume_from_agent_session_id: session.resumeFromAgentSessionId ?? null,
          } : {
            agent_session_id: result.agent_session_id,
            status: result.status,
          },
          task: task ? taskToPlatform(task, store.listTaskDependencies(task.id)) : {},
        };
      });
    },

    cancelAgent(input) {
      const task = taskForCurrentTurn(input.flowId, input.taskId, input.currentTurnInput);
      if (!task) {
        return Promise.resolve({
          ok: false,
          error: { code: "INVALID_TASK", message: `task not found: ${input.taskId}` },
        });
      }
      if (task.status !== "in_progress") {
        return Promise.resolve({
          ok: false,
          error: { code: "TASK_NOT_RUNNING", message: `task is not running: ${input.taskId}` },
        });
      }
      const session = task.agentSessionId ? store.getAgentSession(task.agentSessionId) : undefined;
      if (
        !session
        || session.flowId !== input.flowId
        || session.userTurnId !== task.userTurnId
        || session.taskId !== task.id
        || session.status !== "streaming"
      ) {
        return Promise.resolve({
          ok: false,
          error: { code: "TASK_NOT_RUNNING", message: `task has no running AgentSession: ${input.taskId}` },
        });
      }
      if (!agentDispatcher?.cancelAgent) {
        return Promise.resolve({
          ok: false,
          error: { code: "UNSUPPORTED_V1", message: "agent cancellation is not attached" },
        });
      }
      return agentDispatcher.cancelAgent({
        flowId: input.flowId,
        userTurnId: task.userTurnId,
        taskId: task.id,
        agentSessionId: session.id,
      }).then((result) => {
        if (!result.ok) return result;
        const cancelledTask = store.getTask(task.id);
        const cancelledSession = store.getAgentSession(session.id);
        return cancelledTask && cancelledSession
          ? {
              ok: true as const,
              task: taskToPlatform(cancelledTask, store.listTaskDependencies(cancelledTask.id)),
              agent_session: {
                agent_session_id: cancelledSession.id,
                status: cancelledSession.status,
                expert_id: cancelledSession.expertId,
                task_id: cancelledSession.taskId,
                user_turn_id: cancelledSession.userTurnId,
              },
            }
          : {
              ok: false as const,
              error: { code: "TASK_CANCEL_FAILED", message: `task cancellation did not persist: ${input.taskId}` },
            };
      });
    },

    async sendMessage(input) {
      const turn = activeCurrentTurn(input.flowId, input.currentTurnInput);
      const session = store.getAgentSession(input.agentSessionId);
      if (!turn || !session || session.flowId !== input.flowId || session.userTurnId !== turn.id || session.status !== "streaming" || !agentDispatcher) {
        return {
          ok: true,
          accepted: false,
          error: {
            code: "RUNTIME_DELIVERY_UNAVAILABLE",
            message: "runtime delivery channel unavailable",
          },
        };
      }
      const result = await agentDispatcher.sendMessage(input);
      return { ok: true, ...result };
    },
  };
}

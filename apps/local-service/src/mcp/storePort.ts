import type { Store } from "../db/store.js";
import type { AgentDispatcher } from "../runtime/agentDispatcher.js";
import { isExpertRuntimeEnabled, readAgentRuntimeConfigSnapshotSync } from "../config/agentRuntimeConfig.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import type { CurrentTurnInput, StorePort } from "./leaderServer.js";
import { DeclarativeOrchestrationRuleSchema, diffPlanNodes, evaluateDeclarativeRules, lintOrchestrationPlan } from "../domain/orchestration.js";
import type { PlanLintIssue, SubmitOrchestrationPlanInput } from "../domain/orchestration.js";
import { normalizeFlowName } from "../domain/flowName.js";
import { workRunDto } from "../domain/workRun.js";

type AgentDispatchResult = {
  agent_session_id: string;
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
    work_run_id: task.workRunId,
    subject: task.title,
    description: task.description,
    active_form: task.activeForm,
    progress: task.progress,
    status: task.status,
    revision: task.revision,
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
  function activeCurrentTurn(flowId: string, currentTurnInput: { work_run_id?: string } | undefined) {
    const workRunId = currentTurnInput?.work_run_id;
    const turn = workRunId ? store.getWorkRun(workRunId) : undefined;
    return turn && turn.flowId === flowId && ["ready", "executing"].includes(turn.status) ? turn : null;
  }

  function ensureCurrentWorkRun(flowId: string, currentTurnInput: CurrentTurnInput | undefined) {
    const existing = activeCurrentTurn(flowId, currentTurnInput);
    if (existing) return existing;
    if (!currentTurnInput || !["user_message", "decision_resolved", "spec_run", "plan_approved"].includes(currentTurnInput.trigger_kind)) return null;
    const open = store.getOpenWorkRun(flowId);
    if (open) {
      if (open.status === "interrupted" || open.status === "waiting_user") return null;
      currentTurnInput.work_run_id = open.id;
      return open;
    }
    const created = store.createWorkRun({
      flowId,
      triggerMessageId: currentTurnInput.message_id ?? `msg-work-${Date.now()}`,
      specRequested: currentTurnInput.spec_requested === true,
    });
    if (!created) return null;
    currentTurnInput.work_run_id = created.id;
    return created;
  }

  function ensureCreatePlanWorkRun(flowId: string, currentTurnInput: CurrentTurnInput | undefined) {
    const workRunError = (code: string, message: string) => ({ error: { code, message } });
    const resolveStatus = (turn: ReturnType<Store["getWorkRun"]>) => {
      if (!turn || turn.flowId !== flowId) {
        return workRunError(
          "WORK_RUN_NOT_EXECUTABLE",
          "当前 WorkRun 状态不允许创建计划。请重新读取上下文后决定下一步。",
        );
      }
      if (turn.status === "interrupted") {
        return workRunError(
          "WORK_RUN_INTERRUPTED",
          "当前协作已中断，不能创建计划。请等待用户明确要求继续。",
        );
      }
      if (turn.status === "waiting_user") {
        return workRunError(
          "WORK_RUN_WAITING_USER",
          "当前正在等待用户操作，不能创建新计划。请等待用户处理。",
        );
      }
      if (!["ready", "executing"].includes(turn.status)) {
        return workRunError(
          "WORK_RUN_NOT_EXECUTABLE",
          "当前 WorkRun 状态不允许创建计划。请重新读取上下文后决定下一步。",
        );
      }
      return { turn };
    };

    if (currentTurnInput?.work_run_id) {
      return resolveStatus(store.getWorkRun(currentTurnInput.work_run_id));
    }
    if (!currentTurnInput || !["user_message", "decision_resolved", "spec_run", "plan_approved"].includes(currentTurnInput.trigger_kind)) {
      return workRunError(
        "WORK_RUN_NOT_EXECUTABLE",
        "当前 WorkRun 状态不允许创建计划。请重新读取上下文后决定下一步。",
      );
    }

    const open = store.getOpenWorkRun(flowId);
    if (open) {
      const resolved = resolveStatus(open);
      if ("turn" in resolved) currentTurnInput.work_run_id = resolved.turn.id;
      return resolved;
    }

    const created = store.createWorkRun({
      flowId,
      triggerMessageId: currentTurnInput.message_id ?? `msg-work-${Date.now()}`,
      specRequested: currentTurnInput.spec_requested === true,
    });
    if (!created) {
      return workRunError(
        "WORK_RUN_NOT_EXECUTABLE",
        "当前 WorkRun 状态不允许创建计划。请重新读取上下文后决定下一步。",
      );
    }
    currentTurnInput.work_run_id = created.id;
    return { turn: created };
  }

  function taskForCurrentTurn(
    flowId: string,
    taskId: string,
    currentTurnInput: { work_run_id?: string } | undefined,
  ) {
    const turn = activeCurrentTurn(flowId, currentTurnInput);
    const task = store.getTask(taskId);
    return turn && task && task.flowId === flowId && task.workRunId === turn.id ? task : null;
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
      const currentWorkRun = ensureCreatePlanWorkRun(input.flowId, input.currentTurnInput);
      if ("error" in currentWorkRun) return currentWorkRun;
      const { turn } = currentWorkRun;
      if (input.mode === "rewrite" && store.listSpecRevisions(input.flowId).length === 0) {
        return {
          error: {
            code: "SPEC_REVISION_NOT_FOUND",
            message: "没有可重写的旧计划。请改用 write 模式创建新计划。",
          },
        };
      }
      const created = store.createSpecPlan({
        flowId: input.flowId,
        mode: input.mode,
        name: input.name,
        overview: input.overview,
        content: input.plan,
        sourceAgentSessionId: input.sourceAgentSessionId,
        workRunId: turn.id,
      });
      if (!created) {
        return {
          error: {
            code: "SPEC_PERSISTENCE_FAILED",
            message: "计划保存失败。不要假设计划已创建，请向用户说明失败。",
          },
        };
      }
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
          work_run_id: approval.workRunId,
          status: approval.status,
          actions: ["run"],
        },
      };
    },

    askUser(input) {
      const turn = ensureCurrentWorkRun(input.flowId, input.currentTurnInput);
      if (!turn) return undefined;
      const card = store.createDecisionCard({
        ...input,
        workRunId: turn.id,
        cardType: "clarification",
      });
      return card && card.workRunId ? { id: card.id, status: card.status, workRunId: card.workRunId } : undefined;
    },

    createTask(input) {
      const createTaskError = (code: string, message: string) => ({ error: { code, message } });
      const turn = ensureCurrentWorkRun(input.flowId, input.currentTurnInput);
      if (!turn) {
        return createTaskError("WORK_RUN_REQUIRED", "Task could not be created for the current WorkRun.");
      }
      if (input.currentTurnInput?.spec_requested === true) {
        return createTaskError("SPEC_REQUEST_ACTIVE", "本消息要求 Spec：先 create_plan 并等待批准，不要直接创建任务。");
      }
      // Multi-expert orchestration owns task creation for this turn.
      if (store.listOrchestrationPlans(input.flowId).some((plan) => plan.workRunId === turn.id)) {
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
        const created = store.createDirectWorkRunTask({
          flowId: input.flowId,
          subject: input.subject,
          description: input.description,
          activeForm: input.activeForm,
          currentTurnInput: current,
        });
        return created ? {
          work_run_id: created.workRun.id,
          task: taskToPlatform(created.task, store.listTaskDependencies(created.task.id)),
        } : createTaskError("TASK_CREATE_FAILED", "Task could not be created for the current WorkRun.");
      }

      if (turn.workSource === "spec") {
        const hasPlan = store.listArtifacts(input.flowId)
          .some((artifact) => artifact.workRunId === turn.id && artifact.type === "execution_plan");
        if (!hasPlan) {
          return createTaskError("EXECUTION_PLAN_REQUIRED", "Spec 轮次需先 save_execution_plan，再创建任务。");
        }
      }
      const task = store.createTask({
        flowId: input.flowId,
        workRunId: turn.id,
        title: input.subject,
        description: input.description,
        expertId: null,
        activeForm: input.activeForm,
        dependsOnTaskIds: [],
      });
      return task ? {
        work_run_id: turn.id,
        task: taskToPlatform(task, store.listTaskDependencies(task.id)),
      } : createTaskError("TASK_CREATE_FAILED", "Task could not be created for the current WorkRun.");
    },

    saveExecutionPlan(input) {
      const turn = ensureCurrentWorkRun(input.flowId, input.currentTurnInput);
      if (!turn) return null;
      if (input.currentTurnInput?.spec_requested === true) return null;
      if (!turn.workSource) {
        const flow = store.getFlow(input.flowId);
        if (!flow?.projectId) return null;
        const initialized = store.startWorkRunWork({
          flowId: input.flowId,
          workRunId: turn.id,
          workSource: "direct_message",
          targetProjectId: flow.projectId,
          inputSnapshotJson: JSON.stringify({ type: "direct_message", message_id: turn.triggerMessageId }),
        });
        if (!initialized) return null;
      }
      const artifact = store.createArtifact({
        flowId: input.flowId,
        workRunId: turn.id,
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
        work_run_id: artifact.workRunId,
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
      const turn = ensureCurrentWorkRun(input.flow_id, input.currentTurnInput);
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
        const initialized = store.startWorkRunWork({
          flowId: input.flow_id,
          workRunId: turn.id,
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
        .find((approval) => approval.workRunId === turn.id && approval.status === "feedback_pending");
      const basedOnRevisionId = input.based_on_revision_id ?? feedbackApproval?.planRevisionId;
      const sourceFeedbackMessageId = input.source_feedback_message_id ?? input.currentTurnInput?.message_id;
      let previousNodes: Array<{
        node_id: string; expert_id: string; title: string; description: string; depends_on: string[];
        acceptance_criteria: string[]; risk_tags: string[]; side_effects: string[]; resource_keys: string[];
      }> = [];
      if (basedOnRevisionId) {
        const previousRevision = store.getPlanRevision(basedOnRevisionId);
        const plan = previousRevision ? store.getOrchestrationPlan(previousRevision.planId) : undefined;
        if (!previousRevision || !plan || plan.workRunId !== turn.id) return { error: { code: "INVALID_BASE_REVISION" } };
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
        workRunId: turn.id,
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
      if (!turn || !approval || approval.flowId !== input.flowId || approval.workRunId !== turn.id) return null;
      const restoredApproval = store.restorePlanApprovalAfterFeedback(approval.id, input.resolutionNote);
      if (restoredApproval) return restoredApproval;
      const run = store.getPlanRunForRevision(approval.planRevisionId);
      if (!run || run.workRunId !== turn.id || run.status !== "paused_for_feedback") return null;
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
        expectedRevision: input.expectedRevision,
        activeForm: input.activeForm,
        progress: input.progress,
        expertId: input.expertId,
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
      return store.listWorkRunTasks(turn.id)
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
                      : result.error === "WORK_RUN_INTERRUPTED"
                        ? "WORK_RUN_INTERRUPTED"
                        : result.error === "WORK_RUN_NOT_EXECUTABLE"
                          ? "WORK_RUN_NOT_EXECUTABLE"
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
            work_run_id: session.workRunId,
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
        || session.workRunId !== task.workRunId
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
        workRunId: task.workRunId,
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
                work_run_id: cancelledSession.workRunId,
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
      if (!agentDispatcher) {
        return {
          ok: true,
          accepted: false,
          error: {
            code: "RUNTIME_DELIVERY_UNAVAILABLE",
            message: "runtime delivery channel unavailable",
          },
        };
      }
      const result = await agentDispatcher.sendMessage({
        flowId: input.flowId,
        workRunId: turn?.id,
        expertId: input.expertId,
        content: input.content,
        summary: input.summary,
      });
      return { ok: true, ...result };
    },

    interruptWorkRun(input) {
      const turn = store.getWorkRun(input.workRunId);
      if (!turn || turn.flowId !== input.flowId) {
        return { ok: false as const, error: { code: "WORK_RUN_NOT_FOUND", message: "WorkRun not found." } };
      }
      const result = store.interruptWorkRun({ flowId: input.flowId, workRunId: turn.id, expectedRevision: turn.revision });
      if (!result.workRun || !["interrupted", "already_interrupted"].includes(result.outcome)) {
        return { ok: false as const, error: { code: result.outcome === "revision_conflict" ? "WORK_RUN_REVISION_CONFLICT" : "WORK_RUN_NOT_INTERRUPTIBLE", message: "WorkRun could not be interrupted." } };
      }
      return { ok: true as const, work_run: workRunDto(result.workRun) };
    },

    resumeWorkRun(input) {
      const turn = store.getWorkRun(input.workRunId);
      if (!turn || turn.flowId !== input.flowId) {
        return { ok: false as const, error: { code: "WORK_RUN_NOT_FOUND", message: "WorkRun not found." } };
      }
      if (turn.status !== "interrupted") {
        return { ok: false as const, error: { code: "WORK_RUN_NOT_INTERRUPTED", message: "Only an interrupted WorkRun can be resumed." } };
      }
      const resumed = store.resumeWorkRun(turn.id);
      return resumed
        ? { ok: true as const, work_run: workRunDto(resumed) }
        : { ok: false as const, error: { code: "WORK_RUN_RESUME_FAILED", message: "WorkRun could not be resumed." } };
    },

    cancelWorkRun(input) {
      const turn = store.getWorkRun(input.workRunId);
      if (!turn || turn.flowId !== input.flowId) {
        return { ok: false as const, error: { code: "WORK_RUN_NOT_FOUND", message: "WorkRun not found." } };
      }
      for (const task of store.listWorkRunTasks(turn.id)) store.cancelTask(task.id);
      store.cancelWorkRunPendingActions(turn.id);
      const cancelled = store.failWorkRun(turn.id, "cancelled");
      return cancelled
        ? { ok: true as const, work_run: workRunDto(cancelled) }
        : { ok: false as const, error: { code: "WORK_RUN_CANCEL_FAILED", message: "WorkRun could not be cancelled." } };
    },
  };
}

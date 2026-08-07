import type { Store, TaskRow } from "../db/store.js";
import type { AgentDispatcher } from "../runtime/agentDispatcher.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import { lintOrchestrationPlan } from "../domain/orchestration.js";
import { normalizeFlowName } from "../domain/flowName.js";
import type { StorePort } from "./leaderServer.js";

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function taskProjection(store: Store, task: TaskRow) {
  const blocks = store.listTasks(task.flowId)
    .filter((candidate) => store.listTaskDependencies(candidate.id).includes(task.id))
    .map((candidate) => candidate.id);
  return {
    task_id: task.id,
    flow_id: task.flowId,
    orchestration_revision_id: task.orchestrationRevisionId,
    orchestration_node_id: task.orchestrationNodeId,
    subject: task.title,
    description: task.description,
    active_form: task.activeForm,
    progress: task.progress,
    status: task.status,
    revision: task.revision,
    recommended_agent_definition_id: task.recommendedAgentDefinitionId,
    agent_session_id: task.agentSessionId,
    metadata: parseObject(task.metadataJson),
    blocked_by: store.listTaskDependencies(task.id),
    blocks,
  };
}

function localizeTimestamps(value: unknown, key = ""): unknown {
  if (typeof value === "string" && key.endsWith("_at")) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("sv-SE").replace(" ", "T");
  }
  if (Array.isArray(value)) return value.map((item) => localizeTimestamps(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, localizeTimestamps(child, childKey)]));
}

export function createStorePort(store: Store, dispatcher?: AgentDispatcher): StorePort {
  return {
    getContext(flowId) {
      const snapshot = buildFlowSnapshot(store, flowId);
      if ("error" in snapshot) return null;
      const flow = store.getFlow(flowId);
      const project = flow?.projectId ? store.getProject(flow.projectId) : null;
      return localizeTimestamps({ ...snapshot, flow_id: flowId, project_root_path: project?.localPath ?? "" }) as Record<string, unknown>;
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
        ? { ok: true, flow: { flow_id: updated.id, name: updated.name, name_generation_status: "generated" as const } }
        : { ok: false, error: { code: "FLOW_NOT_FOUND", message: "Flow not found." } };
    },

    listPendingUserActions({ flowId }) {
      return store.listPendingUserActions(flowId);
    },

    askUser(input) {
      if (!input.sourceAgentRunId) return null;
      const request = store.createDecisionRequest({
        id: input.decisionRequestId,
        flowId: input.flowId,
        agentRunId: input.sourceAgentRunId,
        requestType: "clarification",
        payload: { questions: input.questions },
      });
      return request ?? null;
    },

    createPlan(input) {
      const flow = store.getFlow(input.flowId);
      if (!flow) return { error: { code: "FLOW_NOT_FOUND", message: "Flow 不存在。" } };
      if (flow.behaviorMode !== "plan") {
        return { error: { code: "PLAN_MODE_REQUIRED", message: "当前 Flow 不在计划模式；Runtime 以 Leader 实际调用工具时的 Flow 模式为准。" } };
      }
      if (!input.sourceAgentRunId) return { error: { code: "AGENT_RUN_REQUIRED", message: "缺少来源 Leader AgentRun。" } };
      if (input.mode === "rewrite" && store.listPlanRevisions(input.flowId).length === 0) {
        return { error: { code: "PLAN_REVISION_NOT_FOUND", message: "没有可修订的计划，请使用 write。" } };
      }
      const created = store.createPlanRevision({
        flowId: input.flowId,
        title: input.name ?? (store.getPlanDocument(input.flowId)?.title as string | undefined) ?? "计划",
        overview: input.overview,
        content: input.plan,
        sourceAgentRunId: input.sourceAgentRunId,
      });
      if (!created) return { error: { code: "PLAN_PERSISTENCE_FAILED", message: "计划保存失败。" } };
      const revision = created.revision as {
        id: string; revisionNumber: number; title: string; overview: string; content: string; createdAt: string;
      };
      const approval = created.approval as { id: string; status: string; createdAt: string };
      return {
        plan_revision: {
          plan_revision_id: revision.id,
          revision_number: revision.revisionNumber,
          title: revision.title,
          overview: revision.overview,
          content: revision.content,
          created_at: revision.createdAt,
        },
        plan_approval: {
          plan_approval_id: approval.id,
          plan_revision_id: revision.id,
          status: approval.status,
          created_at: approval.createdAt,
        },
      };
    },

    createTask(input) {
      if (!input.sourceAgentRunId) return { error: { code: "AGENT_RUN_REQUIRED", message: "缺少来源 Leader AgentRun。" } };
      const task = store.createTask({
        flowId: input.flowId,
        title: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        createdByAgentRunId: input.sourceAgentRunId,
      });
      return task
        ? { task: taskProjection(store, task) }
        : { error: { code: "TASK_CREATE_FAILED", message: "Task 创建失败。" } };
    },

    submitOrchestrationPlan(input) {
      if (!input.sourceAgentRunId) return { error: { code: "AGENT_RUN_REQUIRED", message: "缺少来源 Leader AgentRun。" } };
      const issues = lintOrchestrationPlan(input, new Set(store.listAgentDefinitions().map((definition) => definition.id)));
      if (issues.length > 0) return { error: { code: "ORCHESTRATION_INVALID", message: "编排计划未通过边界校验。", issues } };
      const result = store.submitOrchestrationRevision({
        flowId: input.flow_id,
        title: input.title,
        objective: input.objective,
        sourceAgentRunId: input.sourceAgentRunId,
        parentRevisionId: input.based_on_revision_id,
        nodes: input.nodes.map((node) => ({
          stableKey: node.node_id,
          recommendedAgentDefinitionId: node.recommended_agent_definition_id,
          title: node.title,
          description: node.description,
          acceptanceCriteria: node.acceptance_criteria,
          metadata: node.metadata,
          dependsOnStableKeys: node.depends_on,
        })),
      });
      if (!result) return { error: { code: "ORCHESTRATION_CREATE_FAILED", message: "编排计划创建失败。" } };
      return {
        plan: result.plan as Record<string, unknown>,
        revision: result.revision as Record<string, unknown>,
        nodes: result.nodes as Array<Record<string, unknown>>,
        approval: result.approval as Record<string, unknown> | null,
        tasks: (result.tasks as TaskRow[]).map((task) => taskProjection(store, task)),
      };
    },

    resolveOrchestrationFeedback(input) {
      const approval = store.getOrchestrationApproval(input.orchestrationApprovalId) as {
        flowId?: string; orchestrationRevisionId?: string;
      } | undefined;
      if (approval?.flowId !== input.flowId || !approval.orchestrationRevisionId) return null;
      return {
        feedback: store.resolveOrchestrationFeedback(approval.orchestrationRevisionId, input.resolutionNote),
        approval,
      };
    },

    updateTask(input) {
      const task = store.getTask(input.taskId);
      if (!task || task.flowId !== input.flowId) return null;
      const updated = store.updateTask(input.taskId, {
        status: input.status,
        expectedRevision: input.expectedRevision,
        title: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        progress: input.progress,
        recommendedAgentDefinitionId: input.recommendedAgentDefinitionId,
        metadata: input.metadata,
        addBlockedBy: input.addBlockedBy,
      });
      return updated ? taskProjection(store, updated) : null;
    },

    listTasks({ flowId }) {
      return store.listTasks(flowId).map((task) => taskProjection(store, task));
    },

    getTask({ flowId, taskId }) {
      const task = store.getTask(taskId);
      return task?.flowId === flowId ? taskProjection(store, task) : null;
    },

    async dispatchAgent(input) {
      if (!dispatcher) return { ok: false, error: { code: "RUNTIME_UNAVAILABLE", message: "Agent Runtime 不可用。" } };
      const result = await dispatcher.dispatchAgent({
        flowId: input.flowId,
        taskId: input.taskId,
        agentDefinitionId: input.agentDefinitionId,
        prompt: input.prompt,
      });
      if (result.error) return { ok: false, error: { code: result.error, message: result.error } };
      return {
        ok: true,
        agent_run: {
          agent_run_id: result.agent_run_id,
          agent_session_id: result.agent_session_id,
          agent_definition_id: result.agent_definition_id,
          task_id: result.task_id,
          status: result.status,
        },
        task: result.task ?? {},
      };
    },

    async cancelAgent(input) {
      if (!dispatcher) return { ok: false, error: { code: "RUNTIME_UNAVAILABLE", message: "Agent Runtime 不可用。" } };
      const result = await dispatcher.cancelAgent({ flowId: input.flowId, agentSessionId: input.agentSessionId });
      return result.ok ? {
        ok: true,
        idempotent: result.idempotent,
        agent_run: result.agentRun ? {
          agent_run_id: result.agentRun.id,
          agent_session_id: result.agentRun.agentSessionId,
          task_id: result.agentRun.taskId,
          status: result.agentRun.status,
        } : undefined,
      } : { ok: false, error: result.error };
    },

    async sendMessage(input) {
      if (!dispatcher) return { ok: true, accepted: false, error: { code: "RUNTIME_UNAVAILABLE", message: "Agent Runtime 不可用。" } };
      const result = await dispatcher.sendMessage({
        flowId: input.flowId,
        agentSessionId: input.agentSessionId,
        taskId: input.taskId,
        message: input.message,
      });
      return { ok: true, ...result };
    },

    openChangeSet(input) {
      const run = store.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId) return null;
      return (store.getOpenChangeSetForRun(input.agentRunId)
        ?? store.openChangeSet({ flowId: input.flowId, agentRunId: input.agentRunId, title: input.title })) as Record<string, unknown> | null;
    },

    bindChangeSet(input) {
      const changeSet = store.getChangeSet(input.changeSetId) as { flowId?: string } | undefined;
      const run = store.getAgentRun(input.agentRunId);
      const task = input.taskId ? store.getTask(input.taskId) : undefined;
      if (changeSet?.flowId !== input.flowId || run?.flowId !== input.flowId || (input.taskId && task?.flowId !== input.flowId)) return null;
      return store.bindChangeSet({ changeSetId: input.changeSetId, agentRunId: input.agentRunId, taskId: input.taskId }) as Record<string, unknown> | null;
    },

    finalizeChangeSet(input) {
      const changeSet = store.getChangeSet(input.changeSetId) as { flowId?: string } | undefined;
      if (changeSet?.flowId !== input.flowId) return null;
      const files = store.listChangeSetFiles(input.changeSetId);
      return store.finalizeChangeSet(input.changeSetId, {
        summary: input.summary,
        file_count: files.length,
        files,
        finalized_from_current_projection: true,
      }) as Record<string, unknown> | null;
    },

    abandonChangeSet(input) {
      const changeSet = store.getChangeSet(input.changeSetId) as { flowId?: string } | undefined;
      if (changeSet?.flowId !== input.flowId) return null;
      return store.abandonChangeSet(input.changeSetId) as Record<string, unknown> | null;
    },
  };
}

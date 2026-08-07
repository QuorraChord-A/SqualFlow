import crypto from "node:crypto";
import { openDatabase } from "./client.js";
import { seedExpertsIntoStore } from "./seedExperts.js";
import { createCanonicalPersistence } from "./canonicalPersistence.js";
import type {
  CanonicalMessageKind,
  CanonicalQueueItem,
  CanonicalSubmission,
  CanonicalTimelineItem,
  SubmissionAcceptance,
} from "./canonicalPersistence.js";
import { migrateToSupervisorSchema } from "./supervisorSchema.js";
import {
  assertAgentRunTransition,
  assertTaskTransition,
  assertToolCallTransition,
  isActiveAgentRunStatus,
  type AgentRunStatus,
  type TaskStatus,
  type ToolCallStatus,
} from "../domain/supervisor.js";
import { parsePersonNameCandidates, pickPersonDisplayName } from "../domain/expertIdentity.js";
import type { ContextUsageCategory } from "../domain/contextUsage.js";

export type { CanonicalMessageKind, CanonicalQueueItem, CanonicalSubmission, CanonicalTimelineItem, SubmissionAcceptance };

type FlowRow = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  nameGenerationStatus: string;
  behaviorMode: string;
  riskMode: string;
  orchestrationMode: string;
  isPinned: number;
  lastOutputCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AgentDefinitionRow = {
  id: string;
  role: string;
  name: string;
  personNameCandidates: string;
  systemPrompt: string;
  builtinTools: string;
  mcpTools: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionRow = {
  id: string;
  flowId: string;
  agentDefinitionId: string;
  role: "leader" | "expert";
  displayName: string;
  providerSessionId: string | null;
  runtimeSdk: string | null;
  runtimeConfigId: string | null;
  runtimeModelId: string | null;
  runtimeReasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunRow = {
  id: string;
  flowId: string;
  agentSessionId: string;
  taskId: string | null;
  triggerKind: string;
  triggerMessageId: string | null;
  status: AgentRunStatus;
  modelInputJson: string;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type TaskRow = {
  id: string;
  flowId: string;
  orchestrationRevisionId: string | null;
  orchestrationNodeId: string | null;
  title: string;
  description: string;
  recommendedAgentDefinitionId: string | null;
  agentSessionId: string | null;
  status: TaskStatus;
  revision: number;
  activeForm: string;
  progress: string | null;
  metadataJson: string;
  acceptanceCriteriaJson: string;
  resultArtifactIdsJson: string;
  resultJson: string | null;
  errorMessage: string | null;
  createdByAgentRunId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type AgentContextUsageSnapshotRow = {
  id: string;
  flowId: string;
  agentRunId: string;
  providerSessionId: string | null;
  role: string;
  agentDefinitionId: string | null;
  agentSessionId: string | null;
  totalTokens: number | null;
  maxTokens: number | null;
  rawMaxTokens: number | null;
  percentage: number | null;
  model: string | null;
  categoriesJson: string;
  cacheInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheHitRate: number | null;
  compacted: number;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStrings(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function flowSelect(where = "") {
  return `SELECT id, project_id AS projectId, name, description,
    name_generation_status AS nameGenerationStatus, behavior_mode AS behaviorMode,
    risk_mode AS riskMode, orchestration_mode AS orchestrationMode,
    is_pinned AS isPinned, last_output_completed_at AS lastOutputCompletedAt,
    created_at AS createdAt, updated_at AS updatedAt FROM flows ${where}`;
}

function sessionSelect(where = "") {
  return `SELECT id, flow_id AS flowId, agent_definition_id AS agentDefinitionId, role,
    display_name AS displayName, provider_session_id AS providerSessionId,
    runtime_sdk AS runtimeSdk, runtime_config_id AS runtimeConfigId,
    runtime_model_id AS runtimeModelId, runtime_reasoning_effort AS runtimeReasoningEffort,
    created_at AS createdAt, updated_at AS updatedAt FROM agent_sessions ${where}`;
}

function runSelect(where = "") {
  return `SELECT id, flow_id AS flowId, agent_session_id AS agentSessionId, task_id AS taskId,
    trigger_kind AS triggerKind, trigger_message_id AS triggerMessageId, status,
    model_input_json AS modelInputJson, error_message AS errorMessage,
    created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
    updated_at AS updatedAt FROM agent_runs ${where}`;
}

function taskSelect(where = "") {
  return `SELECT id, flow_id AS flowId, orchestration_revision_id AS orchestrationRevisionId,
    orchestration_node_id AS orchestrationNodeId, title, description,
    recommended_agent_definition_id AS recommendedAgentDefinitionId,
    agent_session_id AS agentSessionId, status, revision, active_form AS activeForm,
    progress, metadata_json AS metadataJson, acceptance_criteria_json AS acceptanceCriteriaJson,
    result_artifact_ids_json AS resultArtifactIdsJson, result_json AS resultJson,
    error_message AS errorMessage, created_by_agent_run_id AS createdByAgentRunId,
    created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
    updated_at AS updatedAt FROM tasks ${where}`;
}

export function createStore(databasePath: string) {
  const { sqlite, db } = openDatabase(databasePath);
  const canonical = createCanonicalPersistence(sqlite);

  const api = {
    sqlite,
    db,
    ...canonical,

    migrate(options: {
      beforeRuntimeMessageProtocolReset?: (sessions: Array<{ runtimeSdk: string | null; sessionId: string }>) => void;
    } = {}) {
      const result = migrateToSupervisorSchema(sqlite, options.beforeRuntimeMessageProtocolReset);
      seedExpertsIntoStore(db);
      return result;
    },

    seedExperts() {
      seedExpertsIntoStore(db);
    },

    createProject(input: { id?: string; name: string; localPath: string; description?: string | null }) {
      const timestamp = now();
      const projectId = input.id ?? id("proj");
      sqlite.prepare(`
        INSERT INTO projects (id, name, local_path, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, input.name, input.localPath, input.description ?? null, timestamp, timestamp);
      return api.getProject(projectId)!;
    },

    listProjects() {
      return sqlite.prepare(`
        SELECT id, name, local_path AS localPath, description,
          created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY created_at ASC
      `).all() as Array<{ id: string; name: string; localPath: string; description: string | null; createdAt: string; updatedAt: string }>;
    },

    getProject(projectId: string) {
      return sqlite.prepare(`
        SELECT id, name, local_path AS localPath, description,
          created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?
      `).get(projectId) as { id: string; name: string; localPath: string; description: string | null; createdAt: string; updatedAt: string } | undefined;
    },

    updateProject(projectId: string, input: { name?: string; localPath?: string; description?: string | null }) {
      const current = api.getProject(projectId);
      if (!current) return undefined;
      sqlite.prepare("UPDATE projects SET name = ?, local_path = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(input.name ?? current.name, input.localPath ?? current.localPath,
          Object.prototype.hasOwnProperty.call(input, "description") ? input.description ?? null : current.description,
          now(), projectId);
      return api.getProject(projectId);
    },

    deleteProject(projectId: string) {
      const referenced = sqlite.prepare("SELECT 1 FROM flows WHERE project_id = ? LIMIT 1").get(projectId);
      if (referenced) return false;
      return sqlite.prepare("DELETE FROM projects WHERE id = ?").run(projectId).changes > 0;
    },

    createFlow(input: {
      id?: string;
      projectId?: string | null;
      name: string;
      description?: string | null;
      nameGenerationStatus?: "pending" | "generated" | "fallback" | "manual";
      behaviorMode?: "execute" | "plan";
      riskMode?: "auto_edit" | "full_access";
      orchestrationMode?: "approval_required" | "automatic";
    }) {
      if (input.projectId && !api.getProject(input.projectId)) return undefined;
      const timestamp = now();
      const flowId = input.id ?? id("flow");
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO flows (
            id, project_id, name, description, name_generation_status, behavior_mode,
            risk_mode, orchestration_mode, is_pinned, last_output_completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
        `).run(
          flowId,
          input.projectId ?? null,
          input.name,
          input.description ?? null,
          input.nameGenerationStatus ?? "generated",
          input.behaviorMode ?? "execute",
          input.riskMode ?? "auto_edit",
          input.orchestrationMode ?? "approval_required",
          timestamp,
          timestamp,
        );
        const leader = api.getAgentDefinition("exp-leader");
        if (!leader) throw new Error("Leader AgentDefinition is missing");
        sqlite.prepare(`
          INSERT INTO agent_sessions (
            id, flow_id, agent_definition_id, role, display_name, provider_session_id,
            runtime_sdk, runtime_config_id, runtime_model_id, runtime_reasoning_effort,
            created_at, updated_at
          ) VALUES (?, ?, 'exp-leader', 'leader', 'Leader', NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(id("asess"), flowId, timestamp, timestamp);
      })();
      return api.getFlow(flowId)!;
    },

    listFlows(projectId?: string) {
      const rows = projectId
        ? sqlite.prepare(`${flowSelect("WHERE project_id = ?")} ORDER BY created_at ASC`).all(projectId)
        : sqlite.prepare(`${flowSelect()} ORDER BY created_at ASC`).all();
      return rows as FlowRow[];
    },

    assignUnboundFlows(projectId: string) {
      if (!api.getProject(projectId)) return 0;
      return sqlite.prepare("UPDATE flows SET project_id = ?, updated_at = ? WHERE project_id IS NULL")
        .run(projectId, now()).changes;
    },

    getFlow(flowId: string) {
      return sqlite.prepare(flowSelect("WHERE id = ?")).get(flowId) as FlowRow | undefined;
    },

    getRiskMode(flowId: string) {
      return api.getFlow(flowId)?.riskMode === "full_access" ? "full_access" : "auto_edit";
    },

    updateFlow(flowId: string, input: {
      name?: string;
      description?: string | null;
      nameGenerationStatus?: "pending" | "generated" | "fallback" | "manual";
      behaviorMode?: "execute" | "plan";
      riskMode?: "auto_edit" | "full_access";
      orchestrationMode?: "approval_required" | "automatic";
      isPinned?: boolean;
    }) {
      const current = api.getFlow(flowId);
      if (!current) return undefined;
      sqlite.prepare(`
        UPDATE flows SET name = ?, description = ?, name_generation_status = ?, behavior_mode = ?,
          risk_mode = ?, orchestration_mode = ?, is_pinned = ?, updated_at = ? WHERE id = ?
      `).run(
        input.name ?? current.name,
        Object.prototype.hasOwnProperty.call(input, "description") ? input.description ?? null : current.description,
        input.nameGenerationStatus ?? current.nameGenerationStatus,
        input.behaviorMode ?? current.behaviorMode,
        input.riskMode ?? current.riskMode,
        input.orchestrationMode ?? current.orchestrationMode,
        input.isPinned === undefined ? current.isPinned : input.isPinned ? 1 : 0,
        now(),
        flowId,
      );
      return api.getFlow(flowId);
    },

    getFlowMode(flowId: string) {
      const flow = api.getFlow(flowId);
      return flow ? {
        behaviorMode: flow.behaviorMode === "plan" ? "plan" as const : "execute" as const,
        riskMode: flow.riskMode === "full_access" ? "full_access" as const : "auto_edit" as const,
        orchestrationMode: flow.orchestrationMode === "automatic" ? "automatic" as const : "approval_required" as const,
      } : undefined;
    },

    markFlowOutputCompleted(flowId: string, timestamp = now()) {
      const changed = sqlite.prepare("UPDATE flows SET last_output_completed_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, flowId).changes;
      return changed ? api.getFlow(flowId) : undefined;
    },

    markFlowRead(flowId: string, viewerId = "local-default", timestamp = now()) {
      if (!api.getFlow(flowId)) return undefined;
      sqlite.prepare(`
        INSERT INTO flow_read_states (flow_id, viewer_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(flow_id, viewer_id) DO UPDATE SET
          last_read_at = excluded.last_read_at, updated_at = excluded.updated_at
      `).run(flowId, viewerId, timestamp, timestamp);
      return api.getFlowReadState(flowId, viewerId);
    },

    getFlowReadState(flowId: string, viewerId = "local-default") {
      return sqlite.prepare(`
        SELECT flow_id AS flowId, viewer_id AS viewerId, last_read_at AS lastReadAt,
          updated_at AS updatedAt FROM flow_read_states WHERE flow_id = ? AND viewer_id = ?
      `).get(flowId, viewerId) as { flowId: string; viewerId: string; lastReadAt: string; updatedAt: string } | undefined;
    },

    hasUnreadOutput(flowId: string, viewerId = "local-default") {
      const flow = api.getFlow(flowId);
      if (!flow?.lastOutputCompletedAt) return false;
      return flow.lastOutputCompletedAt > (api.getFlowReadState(flowId, viewerId)?.lastReadAt ?? "");
    },

    getAgentDefinition(agentDefinitionId: string) {
      return sqlite.prepare(`
        SELECT id, role, name, person_name_candidates AS personNameCandidates,
          system_prompt AS systemPrompt, builtin_tools AS builtinTools, mcp_tools AS mcpTools,
          created_at AS createdAt, updated_at AS updatedAt
        FROM agent_definitions WHERE id = ?
      `).get(agentDefinitionId) as AgentDefinitionRow | undefined;
    },

    listAgentDefinitions() {
      return sqlite.prepare(`
        SELECT id, role, name, person_name_candidates AS personNameCandidates,
          system_prompt AS systemPrompt, builtin_tools AS builtinTools, mcp_tools AS mcpTools,
          created_at AS createdAt, updated_at AS updatedAt
        FROM agent_definitions ORDER BY created_at ASC
      `).all() as AgentDefinitionRow[];
    },

    getLeaderAgentSession(flowId: string) {
      return sqlite.prepare(sessionSelect("WHERE flow_id = ? AND role = 'leader'"))
        .get(flowId) as AgentSessionRow | undefined;
    },

    createAgentSession(input: {
      flowId: string;
      agentDefinitionId: string;
      displayName?: string;
    }) {
      const flow = api.getFlow(input.flowId);
      const definition = api.getAgentDefinition(input.agentDefinitionId);
      if (!flow || !definition) return undefined;
      const role = definition.role === "leader" ? "leader" : "expert";
      if (role === "leader" && api.getLeaderAgentSession(input.flowId)) return undefined;
      const timestamp = now();
      const sessionId = id("asess");
      const displayName = input.displayName?.trim()
        || (role === "leader"
          ? "Leader"
          : pickPersonDisplayName({
              candidates: parsePersonNameCandidates(definition.personNameCandidates),
              usedNames: api.listAgentSessions(input.flowId).map((session) => session.displayName),
              fallback: definition.name,
            }));
      sqlite.prepare(`
        INSERT INTO agent_sessions (
          id, flow_id, agent_definition_id, role, display_name, provider_session_id,
          runtime_sdk, runtime_config_id, runtime_model_id, runtime_reasoning_effort,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(sessionId, input.flowId, input.agentDefinitionId, role, displayName, timestamp, timestamp);
      return api.getAgentSession(sessionId)!;
    },

    getAgentSession(agentSessionId: string) {
      return sqlite.prepare(sessionSelect("WHERE id = ?")).get(agentSessionId) as AgentSessionRow | undefined;
    },

    listAgentSessions(flowId: string) {
      return sqlite.prepare(`${sessionSelect("WHERE flow_id = ?")} ORDER BY created_at ASC`).all(flowId) as AgentSessionRow[];
    },

    updateAgentSessionProviderSession(agentSessionId: string, providerSessionId: string) {
      const changed = sqlite.prepare("UPDATE agent_sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?")
        .run(providerSessionId, now(), agentSessionId).changes;
      return changed ? api.getAgentSession(agentSessionId) : undefined;
    },

    lockAgentSessionRuntime(agentSessionId: string, input: {
      runtimeSdk: string;
      runtimeConfigId: string;
      runtimeModelId?: string | null;
      runtimeReasoningEffort?: string | null;
    }) {
      const session = api.getAgentSession(agentSessionId);
      if (!session) return undefined;
      if (session.runtimeSdk && session.runtimeSdk !== input.runtimeSdk) return undefined;
      if (session.runtimeConfigId && session.runtimeConfigId !== input.runtimeConfigId) return undefined;
      sqlite.prepare(`
        UPDATE agent_sessions SET runtime_sdk = ?, runtime_config_id = ?, runtime_model_id = ?,
          runtime_reasoning_effort = ?, updated_at = ? WHERE id = ?
      `).run(
        session.runtimeSdk ?? input.runtimeSdk,
        session.runtimeConfigId ?? input.runtimeConfigId,
        input.runtimeModelId ?? session.runtimeModelId,
        input.runtimeReasoningEffort ?? session.runtimeReasoningEffort,
        now(),
        agentSessionId,
      );
      return api.getAgentSession(agentSessionId);
    },

    configureAgentSessionRuntime(agentSessionId: string, input: {
      runtimeSdk: string | null;
      runtimeConfigId: string | null;
      runtimeModelId: string | null;
      runtimeReasoningEffort: string | null;
    }) {
      const session = api.getAgentSession(agentSessionId);
      if (!session || api.getActiveAgentRun(agentSessionId)) return undefined;
      if (session.providerSessionId && session.runtimeSdk && input.runtimeSdk && session.runtimeSdk !== input.runtimeSdk) {
        return undefined;
      }
      sqlite.prepare(`
        UPDATE agent_sessions SET runtime_sdk = ?, runtime_config_id = ?, runtime_model_id = ?,
          runtime_reasoning_effort = ?, updated_at = ? WHERE id = ?
      `).run(
        input.runtimeSdk,
        input.runtimeConfigId,
        input.runtimeModelId,
        input.runtimeReasoningEffort,
        now(),
        agentSessionId,
      );
      return api.getAgentSession(agentSessionId);
    },

    createAgentRun(input: {
      id?: string;
      flowId: string;
      agentSessionId: string;
      taskId?: string | null;
      triggerKind?: string;
      triggerMessageId?: string | null;
      modelInput?: Record<string, unknown>;
      status?: AgentRunStatus;
    }) {
      const session = api.getAgentSession(input.agentSessionId);
      if (!session || session.flowId !== input.flowId) return undefined;
      if (input.taskId) {
        const task = api.getTask(input.taskId);
        if (!task || task.flowId !== input.flowId) return undefined;
      }
      if (api.getActiveAgentRun(input.agentSessionId)) return undefined;
      const timestamp = now();
      const runId = input.id ?? id("arun");
      const status = input.status ?? "queued";
      sqlite.prepare(`
        INSERT INTO agent_runs (
          id, flow_id, agent_session_id, task_id, trigger_kind, trigger_message_id, status,
          model_input_json, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        runId, input.flowId, input.agentSessionId, input.taskId ?? null,
        input.triggerKind ?? "user_message", input.triggerMessageId ?? null, status,
        JSON.stringify(input.modelInput ?? {}), timestamp,
        status === "running" ? timestamp : null,
        ["completed", "failed", "cancelled", "interrupted"].includes(status) ? timestamp : null,
        timestamp,
      );
      return api.getAgentRun(runId)!;
    },

    getAgentRun(agentRunId: string) {
      return sqlite.prepare(runSelect("WHERE id = ?")).get(agentRunId) as AgentRunRow | undefined;
    },

    listAgentRuns(flowId: string) {
      return sqlite.prepare(`${runSelect("WHERE flow_id = ?")} ORDER BY created_at ASC`).all(flowId) as AgentRunRow[];
    },

    listAgentSessionRuns(agentSessionId: string) {
      return sqlite.prepare(`${runSelect("WHERE agent_session_id = ?")} ORDER BY created_at ASC`).all(agentSessionId) as AgentRunRow[];
    },

    getActiveAgentRun(agentSessionId: string) {
      return (sqlite.prepare(`${runSelect("WHERE agent_session_id = ? AND status IN ('queued', 'running', 'waiting_tool_approval')")} ORDER BY created_at DESC LIMIT 1`)
        .get(agentSessionId) as AgentRunRow | undefined);
    },

    updateAgentRunStatus(agentRunId: string, status: AgentRunStatus, errorMessage?: string | null) {
      const run = api.getAgentRun(agentRunId);
      if (!run) return undefined;
      assertAgentRunTransition(run.status, status);
      const timestamp = now();
      sqlite.prepare(`
        UPDATE agent_runs SET status = ?, error_message = ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          finished_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled', 'interrupted') THEN ? ELSE NULL END,
          updated_at = ? WHERE id = ?
      `).run(status, errorMessage ?? run.errorMessage, status, timestamp, status, timestamp, timestamp, agentRunId);
      return api.getAgentRun(agentRunId);
    },

    interruptStaleAgentRuns() {
      const timestamp = now();
      return sqlite.prepare(`
        UPDATE agent_runs SET status = 'interrupted', finished_at = ?, updated_at = ?
        WHERE status IN ('queued', 'running', 'waiting_tool_approval')
      `).run(timestamp, timestamp).changes;
    },

    cancelAgentSession(agentSessionId: string) {
      const run = api.getActiveAgentRun(agentSessionId);
      if (!run) return { idempotent: true, run: api.listAgentSessionRuns(agentSessionId).at(-1) };
      return { idempotent: false, run: api.updateAgentRunStatus(run.id, "cancelled") };
    },

    interruptFlow(flowId: string) {
      const active = api.listAgentRuns(flowId).filter((run) => isActiveAgentRunStatus(run.status));
      sqlite.transaction(() => {
        for (const run of active) api.updateAgentRunStatus(run.id, "interrupted");
        const timestamp = now();
        sqlite.prepare(`
          UPDATE decision_requests SET status = 'cancelled', resolved_at = ?, updated_at = ?
          WHERE flow_id = ? AND request_type = 'tool_permission' AND status = 'pending'
        `).run(timestamp, timestamp, flowId);
        sqlite.prepare(`
          UPDATE tool_calls SET status = 'cancelled', completed_at = ?, updated_at = ?
          WHERE flow_id = ? AND status = 'waiting_approval'
        `).run(timestamp, timestamp, flowId);
      })();
      return active.map((run) => api.getAgentRun(run.id)!);
    },

    createToolCall(input: {
      id?: string;
      flowId: string;
      agentRunId: string;
      taskId?: string | null;
      name: string;
      functionCallType?: string | null;
      idempotencyKey?: string | null;
      arguments?: Record<string, unknown>;
    }) {
      const run = api.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId || !isActiveAgentRunStatus(run.status)) return undefined;
      if (input.taskId && input.taskId !== run.taskId) return undefined;
      if (input.idempotencyKey) {
        const existing = sqlite.prepare(`
          SELECT id FROM tool_calls WHERE agent_run_id = ? AND idempotency_key = ?
        `).get(input.agentRunId, input.idempotencyKey) as { id: string } | undefined;
        if (existing) return api.getToolCall(existing.id);
      }
      const timestamp = now();
      const toolCallId = input.id ?? id("tcall");
      sqlite.prepare(`
        INSERT INTO tool_calls (
          id, flow_id, agent_run_id, task_id, name, function_call_type, status,
          idempotency_key, arguments_json, result_json, error_message, decision_request_id,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        toolCallId, input.flowId, input.agentRunId, input.taskId ?? null, input.name,
        input.functionCallType ?? null, input.idempotencyKey ?? null,
        JSON.stringify(input.arguments ?? {}), timestamp, timestamp,
      );
      return api.getToolCall(toolCallId)!;
    },

    getToolCall(toolCallId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, task_id AS taskId, name,
          function_call_type AS functionCallType, status, idempotency_key AS idempotencyKey,
          arguments_json AS argumentsJson, result_json AS resultJson, error_message AS errorMessage,
          decision_request_id AS decisionRequestId, created_at AS createdAt,
          updated_at AS updatedAt, completed_at AS completedAt FROM tool_calls WHERE id = ?
      `).get(toolCallId) as Record<string, unknown> | undefined;
    },

    listToolCalls(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, task_id AS taskId, name,
          function_call_type AS functionCallType, status, idempotency_key AS idempotencyKey,
          arguments_json AS argumentsJson, result_json AS resultJson, error_message AS errorMessage,
          decision_request_id AS decisionRequestId, created_at AS createdAt,
          updated_at AS updatedAt, completed_at AS completedAt
        FROM tool_calls WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    updateToolCall(input: {
      toolCallId: string;
      status: Exclude<ToolCallStatus, "started">;
      result?: unknown;
      errorMessage?: string | null;
      decisionRequestId?: string | null;
    }) {
      const current = api.getToolCall(input.toolCallId) as {
        status?: ToolCallStatus;
        resultJson?: string | null;
        errorMessage?: string | null;
        decisionRequestId?: string | null;
      } | undefined;
      if (!current) return undefined;
      assertToolCallTransition(current.status ?? "started", input.status);
      if (input.decisionRequestId) {
        const request = api.getDecisionRequest(input.decisionRequestId) as {
          agentRunId?: string;
          toolCallId?: string | null;
        } | undefined;
        const call = api.getToolCall(input.toolCallId) as { agentRunId?: string } | undefined;
        if (!request || request.agentRunId !== call?.agentRunId || (request.toolCallId && request.toolCallId !== input.toolCallId)) {
          return undefined;
        }
      }
      const timestamp = now();
      sqlite.prepare(`
        UPDATE tool_calls SET status = ?, result_json = ?, error_message = ?, decision_request_id = ?,
          completed_at = ?, updated_at = ? WHERE id = ?
      `).run(
        input.status,
        input.result === undefined ? current.resultJson ?? null : JSON.stringify(input.result),
        input.errorMessage ?? current.errorMessage ?? null,
        input.decisionRequestId ?? current.decisionRequestId ?? null,
        ["completed", "failed", "cancelled"].includes(input.status) ? timestamp : null,
        timestamp,
        input.toolCallId,
      );
      return api.getToolCall(input.toolCallId);
    },

    createTask(input: {
      flowId: string;
      title: string;
      description: string;
      recommendedAgentDefinitionId?: string | null;
      activeForm?: string;
      dependsOnTaskIds?: string[];
      acceptanceCriteria?: string[];
      createdByAgentRunId: string;
      orchestrationRevisionId?: string | null;
      orchestrationNodeId?: string | null;
    }) {
      const sourceRun = api.getAgentRun(input.createdByAgentRunId);
      if (!sourceRun || sourceRun.flowId !== input.flowId || !isActiveAgentRunStatus(sourceRun.status)) return undefined;
      if (input.recommendedAgentDefinitionId && !api.getAgentDefinition(input.recommendedAgentDefinitionId)) return undefined;
      const dependencies = (input.dependsOnTaskIds ?? []).map((taskId) => api.getTask(taskId));
      if (dependencies.some((task) => !task || task.flowId !== input.flowId)) return undefined;
      const timestamp = now();
      const taskId = id("task");
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO tasks (
            id, flow_id, orchestration_revision_id, orchestration_node_id, title, description,
            recommended_agent_definition_id, agent_session_id, status, revision, active_form,
            progress, metadata_json, acceptance_criteria_json, result_artifact_ids_json,
            result_json, error_message, created_by_agent_run_id, created_at, started_at, finished_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, ?, NULL, '{}', ?, '[]', NULL, NULL, ?, ?, NULL, NULL, ?)
        `).run(
          taskId, input.flowId, input.orchestrationRevisionId ?? null, input.orchestrationNodeId ?? null,
          input.title, input.description, input.recommendedAgentDefinitionId ?? null,
          input.activeForm ?? "", JSON.stringify(input.acceptanceCriteria ?? []),
          input.createdByAgentRunId, timestamp, timestamp,
        );
        const insertDependency = sqlite.prepare(`
          INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)
        `);
        for (const dependencyId of input.dependsOnTaskIds ?? []) insertDependency.run(taskId, dependencyId, timestamp);
      })();
      return api.getTask(taskId)!;
    },

    getTask(taskId: string) {
      return sqlite.prepare(taskSelect("WHERE id = ?")).get(taskId) as TaskRow | undefined;
    },

    listTasks(flowId: string) {
      return sqlite.prepare(`${taskSelect("WHERE flow_id = ?")} ORDER BY created_at ASC`).all(flowId) as TaskRow[];
    },

    listTaskDependencies(taskId: string) {
      return (sqlite.prepare("SELECT depends_on_task_id AS taskId FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId) as Array<{ taskId: string }>).map((row) => row.taskId);
    },

    listRunnableTasks(flowId: string) {
      return api.listTasks(flowId).filter((task) => task.status === "pending" && api.listTaskDependencies(task.id)
        .every((dependencyId) => api.getTask(dependencyId)?.status === "completed"));
    },

    bindTaskAgentSession(taskId: string, agentSessionId: string) {
      const task = api.getTask(taskId);
      const session = api.getAgentSession(agentSessionId);
      if (!task || !session || task.flowId !== session.flowId || session.role !== "expert") return undefined;
      sqlite.prepare("UPDATE tasks SET agent_session_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(agentSessionId, now(), taskId);
      return api.getTask(taskId);
    },

    updateTask(taskId: string, input: {
      status?: TaskRow["status"];
      expectedRevision?: number;
      title?: string;
      description?: string;
      activeForm?: string;
      progress?: string | null;
      resultJson?: string | null;
      errorMessage?: string | null;
      recommendedAgentDefinitionId?: string | null;
      metadata?: Record<string, unknown>;
      addBlockedBy?: string[];
    }) {
      const task = api.getTask(taskId);
      if (!task || (input.expectedRevision !== undefined && input.expectedRevision !== task.revision)) return undefined;
      const nextStatus = input.status ?? task.status;
      assertTaskTransition(task.status, nextStatus);
      if (input.recommendedAgentDefinitionId && !api.getAgentDefinition(input.recommendedAgentDefinitionId)) return undefined;
      const additions = [...new Set(input.addBlockedBy ?? [])];
      const reachesTask = (dependencyId: string, visited = new Set<string>()): boolean => {
        if (dependencyId === task.id) return true;
        if (visited.has(dependencyId)) return false;
        visited.add(dependencyId);
        return api.listTaskDependencies(dependencyId).some((nextId) => reachesTask(nextId, visited));
      };
      if (additions.some((dependencyId) => {
        const dependency = api.getTask(dependencyId);
        return !dependency || dependency.flowId !== task.flowId || reachesTask(dependencyId);
      })) return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE tasks SET title = ?, description = ?, recommended_agent_definition_id = ?,
            status = ?, revision = revision + 1, active_form = ?, progress = ?, metadata_json = ?,
            result_json = ?, error_message = ?,
            started_at = CASE WHEN ? = 'in_progress' AND started_at IS NULL THEN ? ELSE started_at END,
            finished_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END,
            updated_at = ? WHERE id = ?
        `).run(
          input.title ?? task.title,
          input.description ?? task.description,
          Object.prototype.hasOwnProperty.call(input, "recommendedAgentDefinitionId")
            ? input.recommendedAgentDefinitionId ?? null
            : task.recommendedAgentDefinitionId,
          nextStatus,
          input.activeForm ?? task.activeForm,
          Object.prototype.hasOwnProperty.call(input, "progress") ? input.progress ?? null : task.progress,
          input.metadata ? JSON.stringify(input.metadata) : task.metadataJson,
          Object.prototype.hasOwnProperty.call(input, "resultJson") ? input.resultJson ?? null : task.resultJson,
          Object.prototype.hasOwnProperty.call(input, "errorMessage") ? input.errorMessage ?? null : task.errorMessage,
          nextStatus,
          timestamp,
          nextStatus,
          timestamp,
          timestamp,
          taskId,
        );
        const insert = sqlite.prepare(`
          INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)
        `);
        for (const dependencyId of additions) insert.run(taskId, dependencyId, timestamp);
      })();
      return api.getTask(taskId);
    },

    createPlanRevision(input: {
      flowId: string;
      title: string;
      overview: string;
      content: string;
      sourceAgentRunId: string;
    }) {
      const flow = api.getFlow(input.flowId);
      const run = api.getAgentRun(input.sourceAgentRunId);
      if (!flow || !run || run.flowId !== input.flowId || !isActiveAgentRunStatus(run.status)) return undefined;
      const timestamp = now();
      return sqlite.transaction(() => {
        let document = sqlite.prepare(`
          SELECT id, flow_id AS flowId, title, created_at AS createdAt, updated_at AS updatedAt
          FROM plan_documents WHERE flow_id = ?
        `).get(input.flowId) as { id: string; flowId: string; title: string; createdAt: string; updatedAt: string } | undefined;
        if (!document) {
          const documentId = id("pdoc");
          sqlite.prepare("INSERT INTO plan_documents (id, flow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(documentId, input.flowId, input.title, timestamp, timestamp);
          document = { id: documentId, flowId: input.flowId, title: input.title, createdAt: timestamp, updatedAt: timestamp };
        } else {
          sqlite.prepare("UPDATE plan_documents SET title = ?, updated_at = ? WHERE id = ?")
            .run(input.title, timestamp, document.id);
        }
        const revisionNumber = (sqlite.prepare(`
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS revisionNumber
          FROM plan_revisions WHERE plan_document_id = ?
        `).get(document.id) as { revisionNumber: number }).revisionNumber;
        const revisionId = id("prev");
        const approvalId = id("pappr");
        sqlite.prepare(`
          UPDATE plan_approvals SET status = 'superseded', resolved_at = ?
          WHERE flow_id = ? AND status = 'pending'
        `).run(timestamp, input.flowId);
        sqlite.prepare(`
          INSERT INTO plan_revisions (
            id, plan_document_id, flow_id, revision_number, title, overview, content,
            source_agent_run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revisionId, document.id, input.flowId, revisionNumber, input.title,
          input.overview, input.content, input.sourceAgentRunId, timestamp,
        );
        sqlite.prepare(`
          INSERT INTO plan_approvals (
            id, flow_id, plan_revision_id, status, resolution_action_id, feedback, created_at, resolved_at
          ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)
        `).run(approvalId, input.flowId, revisionId, timestamp);
        return { document, revision: api.getPlanRevision(revisionId)!, approval: api.getPlanApproval(approvalId)! };
      })();
    },

    getPlanDocument(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, title, created_at AS createdAt, updated_at AS updatedAt
        FROM plan_documents WHERE flow_id = ?
      `).get(flowId) as Record<string, unknown> | undefined;
    },

    getPlanRevision(planRevisionId: string) {
      return sqlite.prepare(`
        SELECT id, plan_document_id AS planDocumentId, flow_id AS flowId,
          revision_number AS revisionNumber, title, overview, content,
          source_agent_run_id AS sourceAgentRunId, created_at AS createdAt
        FROM plan_revisions WHERE id = ?
      `).get(planRevisionId) as Record<string, unknown> | undefined;
    },

    listPlanRevisions(flowId: string) {
      return sqlite.prepare(`
        SELECT id, plan_document_id AS planDocumentId, flow_id AS flowId,
          revision_number AS revisionNumber, title, overview, content,
          source_agent_run_id AS sourceAgentRunId, created_at AS createdAt
        FROM plan_revisions WHERE flow_id = ? ORDER BY revision_number ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    getPlanApproval(planApprovalId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, plan_revision_id AS planRevisionId, status,
          resolution_action_id AS resolutionActionId, feedback,
          created_at AS createdAt, resolved_at AS resolvedAt FROM plan_approvals WHERE id = ?
      `).get(planApprovalId) as Record<string, unknown> | undefined;
    },

    listPlanApprovals(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, plan_revision_id AS planRevisionId, status,
          resolution_action_id AS resolutionActionId, feedback,
          created_at AS createdAt, resolved_at AS resolvedAt
        FROM plan_approvals WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    resolvePlanApproval(input: {
      approvalId: string;
      status: "approved" | "rejected" | "cancelled";
      clientActionId: string;
      feedback?: string | null;
    }) {
      const approval = api.getPlanApproval(input.approvalId) as {
        id: string; flowId: string; status: string; resolutionActionId: string | null;
      } | undefined;
      if (!approval) return undefined;
      if (approval.status === input.status && approval.resolutionActionId === input.clientActionId) {
        return { approval: api.getPlanApproval(input.approvalId), idempotent: true, behaviorModeChanged: false };
      }
      if (approval.status !== "pending") return undefined;
      const timestamp = now();
      let behaviorModeChanged = false;
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE plan_approvals SET status = ?, resolution_action_id = ?, feedback = ?, resolved_at = ? WHERE id = ?
        `).run(input.status, input.clientActionId, input.feedback ?? null, timestamp, input.approvalId);
        if (input.status === "approved") {
          const flow = api.getFlow(approval.flowId);
          if (flow?.behaviorMode === "plan") {
            sqlite.prepare("UPDATE flows SET behavior_mode = 'execute', updated_at = ? WHERE id = ? AND behavior_mode = 'plan'")
              .run(timestamp, approval.flowId);
            behaviorModeChanged = true;
          }
        }
      })();
      return { approval: api.getPlanApproval(input.approvalId), idempotent: false, behaviorModeChanged };
    },

    submitOrchestrationRevision(input: {
      flowId: string;
      title: string;
      objective: string;
      sourceAgentRunId: string;
      parentRevisionId?: string | null;
      nodes: Array<{
        stableKey: string;
        recommendedAgentDefinitionId: string;
        title: string;
        description: string;
        acceptanceCriteria?: string[];
        metadata?: Record<string, unknown>;
        dependsOnStableKeys?: string[];
      }>;
    }) {
      const flow = api.getFlow(input.flowId);
      const run = api.getAgentRun(input.sourceAgentRunId);
      if (!flow || !run || run.flowId !== input.flowId || !isActiveAgentRunStatus(run.status) || input.nodes.length === 0) return undefined;
      const keys = input.nodes.map((node) => node.stableKey);
      if (new Set(keys).size !== keys.length) return undefined;
      if (input.nodes.some((node) => !api.getAgentDefinition(node.recommendedAgentDefinitionId)
        || (node.dependsOnStableKeys ?? []).some((key) => !keys.includes(key) || key === node.stableKey))) return undefined;
      const dependencyMap = new Map(input.nodes.map((node) => [node.stableKey, node.dependsOnStableKeys ?? []]));
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const hasCycle = (key: string): boolean => {
        if (visiting.has(key)) return true;
        if (visited.has(key)) return false;
        visiting.add(key);
        if ((dependencyMap.get(key) ?? []).some(hasCycle)) return true;
        visiting.delete(key);
        visited.add(key);
        return false;
      };
      if (keys.some(hasCycle)) return undefined;
      if (input.parentRevisionId) {
        const parent = api.getOrchestrationRevision(input.parentRevisionId) as { flowId?: string } | undefined;
        if (parent?.flowId !== input.flowId) return undefined;
      }
      const timestamp = now();
      return sqlite.transaction(() => {
        let plan = api.getOrchestrationPlanForFlow(input.flowId) as { id: string } | undefined;
        if (!plan) {
          const planId = id("oplan");
          sqlite.prepare("INSERT INTO orchestration_plans (id, flow_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .run(planId, input.flowId, timestamp, timestamp);
          plan = { id: planId };
        } else {
          sqlite.prepare("UPDATE orchestration_plans SET updated_at = ? WHERE id = ?").run(timestamp, plan.id);
        }
        const revisionNumber = (sqlite.prepare(`
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS revisionNumber
          FROM orchestration_revisions WHERE orchestration_plan_id = ?
        `).get(plan.id) as { revisionNumber: number }).revisionNumber;
        const revisionId = id("orev");
        const snapshot = flow.orchestrationMode === "automatic" ? "automatic" : "approval_required";
        const status = snapshot === "automatic" ? "active" : "waiting_approval";
        sqlite.prepare(`
          UPDATE orchestration_approvals SET status = 'superseded', resolved_at = ?
          WHERE flow_id = ? AND status = 'pending'
        `).run(timestamp, input.flowId);
        sqlite.prepare(`
          UPDATE orchestration_revisions SET status = 'superseded'
          WHERE flow_id = ? AND status = 'waiting_approval'
        `).run(input.flowId);
        if (snapshot === "automatic") {
          sqlite.prepare(`
            UPDATE orchestration_revisions SET status = 'superseded'
            WHERE flow_id = ? AND status = 'active'
          `).run(input.flowId);
        }
        sqlite.prepare(`
          INSERT INTO orchestration_revisions (
            id, orchestration_plan_id, flow_id, revision_number, parent_revision_id,
            status, approval_mode_snapshot, title, objective, source_agent_run_id,
            created_at, activated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revisionId, plan.id, input.flowId, revisionNumber, input.parentRevisionId ?? null,
          status, snapshot, input.title, input.objective, input.sourceAgentRunId,
          timestamp, snapshot === "automatic" ? timestamp : null,
        );
        const nodeIdByKey = new Map<string, string>();
        for (const node of input.nodes) {
          const nodeId = id("onode");
          nodeIdByKey.set(node.stableKey, nodeId);
          sqlite.prepare(`
            INSERT INTO orchestration_nodes (
              id, orchestration_revision_id, stable_key, recommended_agent_definition_id,
              title, description, acceptance_criteria_json, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            nodeId, revisionId, node.stableKey, node.recommendedAgentDefinitionId,
            node.title, node.description, JSON.stringify(node.acceptanceCriteria ?? []),
            JSON.stringify(node.metadata ?? {}), timestamp,
          );
        }
        for (const node of input.nodes) {
          for (const dependencyKey of node.dependsOnStableKeys ?? []) {
            sqlite.prepare(`
              INSERT INTO orchestration_node_dependencies (
                orchestration_revision_id, node_id, depends_on_node_id, created_at
              ) VALUES (?, ?, ?, ?)
            `).run(revisionId, nodeIdByKey.get(node.stableKey), nodeIdByKey.get(dependencyKey), timestamp);
          }
        }
        let approval: Record<string, unknown> | undefined;
        if (snapshot === "approval_required") {
          const approvalId = id("oappr");
          sqlite.prepare(`
            INSERT INTO orchestration_approvals (
              id, flow_id, orchestration_revision_id, status, resolution_action_id,
              feedback, created_at, resolved_at
            ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)
          `).run(approvalId, input.flowId, revisionId, timestamp);
          approval = api.getOrchestrationApproval(approvalId);
        } else {
          api.materializeOrchestrationTasks(revisionId);
        }
        return {
          plan: api.getOrchestrationPlan(plan.id),
          revision: api.getOrchestrationRevision(revisionId),
          nodes: api.listOrchestrationNodes(revisionId),
          approval,
          tasks: api.listTasks(input.flowId).filter((task) => task.orchestrationRevisionId === revisionId),
        };
      })();
    },

    getOrchestrationPlan(planId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, created_at AS createdAt, updated_at AS updatedAt
        FROM orchestration_plans WHERE id = ?
      `).get(planId) as Record<string, unknown> | undefined;
    },

    getOrchestrationPlanForFlow(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, created_at AS createdAt, updated_at AS updatedAt
        FROM orchestration_plans WHERE flow_id = ?
      `).get(flowId) as Record<string, unknown> | undefined;
    },

    listOrchestrationPlans(flowId: string) {
      const plan = api.getOrchestrationPlanForFlow(flowId);
      return plan ? [plan] : [];
    },

    getOrchestrationRevision(revisionId: string) {
      return sqlite.prepare(`
        SELECT id, orchestration_plan_id AS orchestrationPlanId, flow_id AS flowId,
          revision_number AS revisionNumber, parent_revision_id AS parentRevisionId, status,
          approval_mode_snapshot AS approvalModeSnapshot, title, objective,
          source_agent_run_id AS sourceAgentRunId, created_at AS createdAt, activated_at AS activatedAt
        FROM orchestration_revisions WHERE id = ?
      `).get(revisionId) as Record<string, unknown> | undefined;
    },

    listOrchestrationRevisions(planId: string) {
      return sqlite.prepare(`
        SELECT id, orchestration_plan_id AS orchestrationPlanId, flow_id AS flowId,
          revision_number AS revisionNumber, parent_revision_id AS parentRevisionId, status,
          approval_mode_snapshot AS approvalModeSnapshot, title, objective,
          source_agent_run_id AS sourceAgentRunId, created_at AS createdAt, activated_at AS activatedAt
        FROM orchestration_revisions WHERE orchestration_plan_id = ? ORDER BY revision_number ASC
      `).all(planId) as Array<Record<string, unknown>>;
    },

    listOrchestrationNodes(revisionId: string) {
      return sqlite.prepare(`
        SELECT id, orchestration_revision_id AS orchestrationRevisionId, stable_key AS stableKey,
          recommended_agent_definition_id AS recommendedAgentDefinitionId, title, description,
          acceptance_criteria_json AS acceptanceCriteriaJson, metadata_json AS metadataJson,
          created_at AS createdAt FROM orchestration_nodes
        WHERE orchestration_revision_id = ? ORDER BY created_at ASC
      `).all(revisionId) as Array<Record<string, unknown>>;
    },

    listOrchestrationNodeDependencies(revisionId: string, nodeId: string) {
      return (sqlite.prepare(`
        SELECT depends_on_node_id AS nodeId FROM orchestration_node_dependencies
        WHERE orchestration_revision_id = ? AND node_id = ? ORDER BY created_at ASC
      `).all(revisionId, nodeId) as Array<{ nodeId: string }>).map((row) => row.nodeId);
    },

    getOrchestrationApproval(approvalId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, orchestration_revision_id AS orchestrationRevisionId,
          status, resolution_action_id AS resolutionActionId, feedback,
          created_at AS createdAt, resolved_at AS resolvedAt
        FROM orchestration_approvals WHERE id = ?
      `).get(approvalId) as Record<string, unknown> | undefined;
    },

    getOrchestrationApprovalForRevision(revisionId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, orchestration_revision_id AS orchestrationRevisionId,
          status, resolution_action_id AS resolutionActionId, feedback,
          created_at AS createdAt, resolved_at AS resolvedAt
        FROM orchestration_approvals WHERE orchestration_revision_id = ?
      `).get(revisionId) as Record<string, unknown> | undefined;
    },

    listOrchestrationApprovals(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, orchestration_revision_id AS orchestrationRevisionId,
          status, resolution_action_id AS resolutionActionId, feedback,
          created_at AS createdAt, resolved_at AS resolvedAt
        FROM orchestration_approvals WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    materializeOrchestrationTasks(revisionId: string) {
      const revision = api.getOrchestrationRevision(revisionId) as {
        id: string; flowId: string; status: string; sourceAgentRunId: string; activatedAt: string | null;
      } | undefined;
      if (!revision || revision.status !== "active") return undefined;
      const nodes = api.listOrchestrationNodes(revisionId) as Array<{
        id: string; stableKey: string; recommendedAgentDefinitionId: string; title: string;
        description: string; acceptanceCriteriaJson: string; metadataJson: string;
      }>;
      const existing = api.listTasks(revision.flowId).filter((task) => task.orchestrationRevisionId === revisionId);
      if (existing.length === nodes.length && nodes.length > 0) return existing;
      const timestamp = now();
      return sqlite.transaction(() => {
        const taskIdByNodeId = new Map<string, string>();
        for (const node of nodes) {
          const existingTask = existing.find((task) => task.orchestrationNodeId === node.id);
          if (existingTask) {
            taskIdByNodeId.set(node.id, existingTask.id);
            continue;
          }
          const taskId = id("task");
          taskIdByNodeId.set(node.id, taskId);
          sqlite.prepare(`
            INSERT INTO tasks (
              id, flow_id, orchestration_revision_id, orchestration_node_id, title, description,
              recommended_agent_definition_id, agent_session_id, status, revision, active_form,
              progress, metadata_json, acceptance_criteria_json, result_artifact_ids_json,
              result_json, error_message, created_by_agent_run_id, created_at, started_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, ?, NULL, ?, ?, '[]', NULL, NULL, ?, ?, NULL, NULL, ?)
          `).run(
            taskId, revision.flowId, revisionId, node.id, node.title, node.description,
            node.recommendedAgentDefinitionId, node.title, node.metadataJson,
            node.acceptanceCriteriaJson, revision.sourceAgentRunId, timestamp, timestamp,
          );
        }
        const dependencies = sqlite.prepare(`
          SELECT node_id AS nodeId, depends_on_node_id AS dependsOnNodeId
          FROM orchestration_node_dependencies WHERE orchestration_revision_id = ?
        `).all(revisionId) as Array<{ nodeId: string; dependsOnNodeId: string }>;
        for (const edge of dependencies) {
          sqlite.prepare(`
            INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)
          `).run(taskIdByNodeId.get(edge.nodeId), taskIdByNodeId.get(edge.dependsOnNodeId), timestamp);
        }
        return api.listTasks(revision.flowId).filter((task) => task.orchestrationRevisionId === revisionId);
      })();
    },

    resolveOrchestrationApproval(input: {
      approvalId: string;
      status: "approved" | "rejected" | "cancelled";
      clientActionId: string;
      feedback?: string | null;
    }) {
      const approval = api.getOrchestrationApproval(input.approvalId) as {
        id: string; flowId: string; orchestrationRevisionId: string;
        status: string; resolutionActionId: string | null;
      } | undefined;
      if (!approval) return undefined;
      if (approval.status === input.status && approval.resolutionActionId === input.clientActionId) {
        return { approval, idempotent: true, tasks: [] as TaskRow[] };
      }
      if (approval.status !== "pending") return undefined;
      const timestamp = now();
      return sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE orchestration_approvals SET status = ?, resolution_action_id = ?, feedback = ?, resolved_at = ? WHERE id = ?
        `).run(input.status, input.clientActionId, input.feedback ?? null, timestamp, input.approvalId);
        if (input.status === "approved") {
          sqlite.prepare(`
            UPDATE orchestration_revisions SET status = 'superseded'
            WHERE flow_id = ? AND status = 'active' AND id <> ?
          `).run(approval.flowId, approval.orchestrationRevisionId);
          sqlite.prepare(`
            UPDATE orchestration_revisions SET status = 'active', activated_at = ?
            WHERE id = ? AND status = 'waiting_approval'
          `).run(timestamp, approval.orchestrationRevisionId);
        } else {
          sqlite.prepare("UPDATE orchestration_revisions SET status = 'rejected' WHERE id = ? AND status = 'waiting_approval'")
            .run(approval.orchestrationRevisionId);
        }
        return {
          approval: api.getOrchestrationApproval(input.approvalId),
          idempotent: false,
          tasks: input.status === "approved" ? api.materializeOrchestrationTasks(approval.orchestrationRevisionId) ?? [] : [],
        };
      })();
    },

    recordOrchestrationFeedback(input: {
      flowId: string;
      orchestrationRevisionId: string;
      sourceMessageId: string;
      feedback: Array<{ orchestrationNodeId?: string | null; markerNumber: number; comment: string }>;
    }) {
      const revision = api.getOrchestrationRevision(input.orchestrationRevisionId) as { flowId?: string } | undefined;
      if (revision?.flowId !== input.flowId) return undefined;
      const existing = api.listOrchestrationFeedback(input.orchestrationRevisionId)
        .filter((row) => row.sourceMessageId === input.sourceMessageId);
      if (existing.length > 0) return existing;
      const timestamp = now();
      sqlite.transaction(() => {
        for (const item of input.feedback) sqlite.prepare(`
          INSERT INTO orchestration_feedback (
            id, flow_id, orchestration_revision_id, orchestration_node_id, source_message_id,
            marker_number, comment, status, resolution_note, created_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
        `).run(
          id("ofb"), input.flowId, input.orchestrationRevisionId, item.orchestrationNodeId ?? null,
          input.sourceMessageId, item.markerNumber, item.comment, timestamp,
        );
      })();
      return api.listOrchestrationFeedback(input.orchestrationRevisionId)
        .filter((row) => row.sourceMessageId === input.sourceMessageId);
    },

    listOrchestrationFeedback(revisionId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, orchestration_revision_id AS orchestrationRevisionId,
          orchestration_node_id AS orchestrationNodeId, source_message_id AS sourceMessageId,
          marker_number AS markerNumber, comment, status, resolution_note AS resolutionNote,
          created_at AS createdAt, resolved_at AS resolvedAt
        FROM orchestration_feedback WHERE orchestration_revision_id = ? ORDER BY created_at ASC
      `).all(revisionId) as Array<Record<string, unknown>>;
    },

    resolveOrchestrationFeedback(revisionId: string, note: string) {
      const timestamp = now();
      sqlite.prepare(`
        UPDATE orchestration_feedback SET status = 'resolved', resolution_note = ?, resolved_at = ?
        WHERE orchestration_revision_id = ? AND status = 'pending'
      `).run(note, timestamp, revisionId);
      return api.listOrchestrationFeedback(revisionId);
    },

    createDecisionRequest(input: {
      id?: string;
      flowId: string;
      agentRunId: string;
      toolCallId?: string | null;
      requestType: "clarification" | "tool_permission";
      payload: Record<string, unknown>;
    }) {
      const run = api.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId || !isActiveAgentRunStatus(run.status)) return undefined;
      if (input.toolCallId) {
        const toolCall = api.getToolCall(input.toolCallId) as { agentRunId?: string } | undefined;
        if (toolCall?.agentRunId !== input.agentRunId) return undefined;
      }
      const timestamp = now();
      const requestId = input.id ?? id("dreq");
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO decision_requests (
            id, flow_id, agent_run_id, tool_call_id, request_type, payload_json, response_json,
            status, resolution_action_id, created_at, resolved_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, NULL, ?)
        `).run(
          requestId, input.flowId, input.agentRunId, input.toolCallId ?? null,
          input.requestType, JSON.stringify(input.payload), timestamp, timestamp,
        );
        if (input.requestType === "tool_permission") {
          api.updateAgentRunStatus(input.agentRunId, "waiting_tool_approval");
          if (input.toolCallId) api.updateToolCall({
            toolCallId: input.toolCallId,
            status: "waiting_approval",
            decisionRequestId: requestId,
          });
        }
      })();
      return api.getDecisionRequest(requestId)!;
    },

    getDecisionRequest(requestId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, tool_call_id AS toolCallId,
          request_type AS requestType, payload_json AS payloadJson, response_json AS responseJson,
          status, resolution_action_id AS resolutionActionId, created_at AS createdAt,
          resolved_at AS resolvedAt, updated_at AS updatedAt FROM decision_requests WHERE id = ?
      `).get(requestId) as Record<string, unknown> | undefined;
    },

    listDecisionRequests(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, tool_call_id AS toolCallId,
          request_type AS requestType, payload_json AS payloadJson, response_json AS responseJson,
          status, resolution_action_id AS resolutionActionId, created_at AS createdAt,
          resolved_at AS resolvedAt, updated_at AS updatedAt
        FROM decision_requests WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    resolveDecisionRequest(input: {
      requestId: string;
      status: "approved" | "rejected" | "cancelled";
      clientActionId: string;
      response?: Record<string, unknown>;
    }) {
      const request = api.getDecisionRequest(input.requestId) as {
        id: string; flowId: string; agentRunId: string; toolCallId: string | null;
        requestType: string; status: string; resolutionActionId: string | null;
      } | undefined;
      if (!request) return undefined;
      if (request.status === input.status && request.resolutionActionId === input.clientActionId) {
        return { request, idempotent: true };
      }
      if (request.status !== "pending") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE decision_requests SET status = ?, resolution_action_id = ?, response_json = ?,
            resolved_at = ?, updated_at = ? WHERE id = ?
        `).run(
          input.status, input.clientActionId, JSON.stringify(input.response ?? {}),
          timestamp, timestamp, input.requestId,
        );
        if (request.requestType === "tool_permission") {
          const run = api.getAgentRun(request.agentRunId);
          if (run?.status === "waiting_tool_approval") {
            api.updateAgentRunStatus(request.agentRunId, input.status === "cancelled" ? "cancelled" : "running");
          }
          if (request.toolCallId) api.updateToolCall({
            toolCallId: request.toolCallId,
            status: input.status === "approved" ? "running" : "cancelled",
          });
        }
      })();
      return { request: api.getDecisionRequest(input.requestId), idempotent: false };
    },

    listPendingUserActions(flowId: string) {
      return [
        ...api.listPlanApprovals(flowId)
          .filter((row) => row.status === "pending")
          .map((row) => ({ id: String(row.id), type: "plan_approval" as const, status: "pending" as const })),
        ...api.listOrchestrationApprovals(flowId)
          .filter((row) => row.status === "pending")
          .map((row) => ({ id: String(row.id), type: "orchestration_approval" as const, status: "pending" as const })),
        ...api.listDecisionRequests(flowId)
          .filter((row) => row.status === "pending")
          .map((row) => ({ id: String(row.id), type: "decision_request" as const, status: "pending" as const })),
      ];
    },

    enqueueLeaderRunTrigger(input: {
      flowId: string;
      kind: "decision_resolved" | "decision_cancelled" | "plan_resolved" | "orchestration_resolved" | "expert_result" | "expert_message";
      sourceId: string;
      payload?: Record<string, unknown>;
    }) {
      if (!api.getFlow(input.flowId)) return undefined;
      const timestamp = now();
      const triggerId = id("ltrg");
      sqlite.prepare(`
        INSERT INTO leader_run_triggers (
          id, flow_id, kind, source_id, payload_json, status, attempts,
          last_error, created_at, updated_at, sent_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)
        ON CONFLICT(flow_id, kind, source_id) DO NOTHING
      `).run(triggerId, input.flowId, input.kind, input.sourceId, JSON.stringify(input.payload ?? {}), timestamp, timestamp);
      return api.listLeaderRunTriggers(input.flowId).find((trigger) =>
        trigger.kind === input.kind && trigger.sourceId === input.sourceId);
    },

    listLeaderRunTriggers(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, kind, source_id AS sourceId, payload_json AS payloadJson,
          status, attempts, last_error AS lastError, created_at AS createdAt,
          updated_at AS updatedAt, sent_at AS sentAt
        FROM leader_run_triggers WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<{
        id: string; flowId: string; kind: string; sourceId: string; payloadJson: string;
        status: "pending" | "dispatching" | "completed"; attempts: number;
        lastError: string | null; createdAt: string; updatedAt: string; sentAt: string | null;
      }>;
    },

    claimLeaderRunTrigger(flowId: string) {
      const trigger = api.listLeaderRunTriggers(flowId).find((candidate) => candidate.status === "pending");
      if (!trigger) return undefined;
      const changed = sqlite.prepare(`
        UPDATE leader_run_triggers SET status = 'dispatching', attempts = attempts + 1,
          last_error = NULL, updated_at = ? WHERE id = ? AND status = 'pending'
      `).run(now(), trigger.id).changes;
      return changed ? api.listLeaderRunTriggers(flowId).find((candidate) => candidate.id === trigger.id) : undefined;
    },

    releaseLeaderRunTrigger(triggerId: string, error?: string | null) {
      return sqlite.prepare(`
        UPDATE leader_run_triggers SET status = 'pending', last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'dispatching'
      `).run(error ?? null, now(), triggerId).changes > 0;
    },

    completeLeaderRunTrigger(triggerId: string) {
      return sqlite.prepare(`
        UPDATE leader_run_triggers SET status = 'completed', sent_at = ?, updated_at = ?
        WHERE id = ? AND status = 'dispatching'
      `).run(now(), now(), triggerId).changes > 0;
    },

    createChangeBaselineCandidate(input: {
      id?: string;
      flowId: string;
      agentRunId: string;
      taskId?: string | null;
      rootPath: string;
      snapshotPath: string;
      baselineJson: string;
      baselineKind: string;
      baselineRef?: string | null;
      status?: "ready" | "skipped" | "failed";
      errorMessage?: string | null;
    }) {
      const run = api.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId || (input.taskId && input.taskId !== run.taskId)) return undefined;
      const candidateId = input.id ?? id("base");
      sqlite.prepare(`
        INSERT INTO change_baseline_candidates (
          id, flow_id, agent_run_id, task_id, root_path, baseline_json,
          snapshot_path, baseline_kind, baseline_ref, status, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_run_id) DO NOTHING
      `).run(
        candidateId, input.flowId, input.agentRunId, input.taskId ?? null, input.rootPath,
        input.baselineJson, input.snapshotPath, input.baselineKind, input.baselineRef ?? null,
        input.status ?? "ready", input.errorMessage ?? null, now(),
      );
      return api.getChangeBaselineCandidate(input.agentRunId);
    },

    getChangeBaselineCandidate(agentRunId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, task_id AS taskId,
          root_path AS rootPath, baseline_json AS baselineJson, baseline_kind AS baselineKind,
          snapshot_path AS snapshotPath, baseline_ref AS baselineRef, status,
          error_message AS errorMessage, created_at AS createdAt
        FROM change_baseline_candidates WHERE agent_run_id = ?
      `).get(agentRunId) as Record<string, unknown> | undefined;
    },

    listChangeBaselineCandidates(flowId?: string) {
      const rows = flowId
        ? sqlite.prepare(`
            SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, task_id AS taskId,
              root_path AS rootPath, baseline_json AS baselineJson, baseline_kind AS baselineKind,
              snapshot_path AS snapshotPath, baseline_ref AS baselineRef, status,
              error_message AS errorMessage, created_at AS createdAt
            FROM change_baseline_candidates WHERE flow_id = ? ORDER BY created_at ASC
          `).all(flowId)
        : sqlite.prepare(`
            SELECT id, flow_id AS flowId, agent_run_id AS agentRunId, task_id AS taskId,
              root_path AS rootPath, baseline_json AS baselineJson, baseline_kind AS baselineKind,
              snapshot_path AS snapshotPath, baseline_ref AS baselineRef, status,
              error_message AS errorMessage, created_at AS createdAt
            FROM change_baseline_candidates ORDER BY created_at ASC
          `).all();
      return rows as Array<Record<string, unknown>>;
    },

    deleteChangeBaselineCandidate(agentRunId: string) {
      return sqlite.prepare("DELETE FROM change_baseline_candidates WHERE agent_run_id = ?")
        .run(agentRunId).changes > 0;
    },

    openChangeSet(input: {
      flowId: string;
      agentRunId: string;
      taskId?: string | null;
      title?: string;
      rootPath?: string;
      baselineSnapshotPath?: string;
      baselineJson?: string;
      baselineKind?: string;
      baselineRef?: string | null;
    }) {
      const run = api.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId) return undefined;
      const candidate = api.getChangeBaselineCandidate(input.agentRunId) as {
        rootPath?: string; snapshotPath?: string; baselineJson?: string; baselineKind?: string; baselineRef?: string | null;
      } | undefined;
      const rootPath = input.rootPath ?? candidate?.rootPath;
      const baselineSnapshotPath = input.baselineSnapshotPath ?? candidate?.snapshotPath;
      const baselineJson = input.baselineJson ?? candidate?.baselineJson;
      const baselineKind = input.baselineKind ?? candidate?.baselineKind;
      if (!rootPath || !baselineSnapshotPath || !baselineJson || !baselineKind) return undefined;
      const timestamp = now();
      const changeSetId = id("cset");
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO change_sets (
            id, flow_id, title, status, root_path, baseline_snapshot_path, baseline_json, baseline_kind, baseline_ref,
            partial_reason, review_json, created_at, finalized_at, abandoned_at, updated_at
          ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)
        `).run(
          changeSetId, input.flowId, input.title ?? "代码变更", rootPath, baselineSnapshotPath, baselineJson,
          baselineKind, input.baselineRef ?? candidate?.baselineRef ?? null, timestamp, timestamp,
        );
        sqlite.prepare(`
          INSERT INTO change_set_contributions (change_set_id, agent_run_id, task_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(changeSetId, input.agentRunId, input.taskId ?? run.taskId, timestamp);
      })();
      return api.getChangeSet(changeSetId)!;
    },

    getChangeSet(changeSetId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, title, status, root_path AS rootPath, baseline_snapshot_path AS baselineSnapshotPath,
          baseline_json AS baselineJson, baseline_kind AS baselineKind, baseline_ref AS baselineRef,
          partial_reason AS partialReason, review_json AS reviewJson, created_at AS createdAt,
          finalized_at AS finalizedAt, abandoned_at AS abandonedAt, updated_at AS updatedAt
        FROM change_sets WHERE id = ?
      `).get(changeSetId) as Record<string, unknown> | undefined;
    },

    listChangeSets(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, title, status, root_path AS rootPath, baseline_snapshot_path AS baselineSnapshotPath,
          baseline_json AS baselineJson, baseline_kind AS baselineKind, baseline_ref AS baselineRef,
          partial_reason AS partialReason, review_json AS reviewJson, created_at AS createdAt,
          finalized_at AS finalizedAt, abandoned_at AS abandonedAt, updated_at AS updatedAt
        FROM change_sets WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    bindChangeSet(input: { changeSetId: string; agentRunId: string; taskId?: string | null }) {
      const changeSet = api.getChangeSet(input.changeSetId) as { flowId?: string; status?: string } | undefined;
      const run = api.getAgentRun(input.agentRunId);
      if (!changeSet || changeSet.status !== "open" || !run || run.flowId !== changeSet.flowId) return undefined;
      sqlite.prepare(`
        INSERT OR IGNORE INTO change_set_contributions (change_set_id, agent_run_id, task_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.changeSetId, input.agentRunId, input.taskId ?? run.taskId, now());
      return api.getChangeSet(input.changeSetId);
    },

    getOpenChangeSetForRun(agentRunId: string) {
      return sqlite.prepare(`
        SELECT cs.id, cs.flow_id AS flowId, cs.title, cs.status, cs.root_path AS rootPath, cs.baseline_snapshot_path AS baselineSnapshotPath,
          cs.baseline_json AS baselineJson, cs.baseline_kind AS baselineKind, cs.baseline_ref AS baselineRef,
          cs.partial_reason AS partialReason, cs.review_json AS reviewJson,
          cs.created_at AS createdAt, cs.finalized_at AS finalizedAt,
          cs.abandoned_at AS abandonedAt, cs.updated_at AS updatedAt
        FROM change_sets cs JOIN change_set_contributions c ON c.change_set_id = cs.id
        WHERE c.agent_run_id = ? AND cs.status = 'open' ORDER BY cs.created_at DESC LIMIT 1
      `).get(agentRunId) as Record<string, unknown> | undefined;
    },

    reconcileChangeSetFiles(input: {
      changeSetId: string;
      touchedPaths: string[];
      files: Array<{ path: string; status: string; patch?: string | null; additions?: number | null; deletions?: number | null; attributionKind?: string }>;
      partialReason?: string | null;
    }) {
      const changeSet = api.getChangeSet(input.changeSetId) as { status?: string } | undefined;
      if (!changeSet || changeSet.status !== "open") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        const currentPaths = new Set(input.files.map((file) => file.path));
        const remove = sqlite.prepare("DELETE FROM change_set_files WHERE change_set_id = ? AND path = ?");
        for (const touchedPath of new Set(input.touchedPaths)) {
          if (!currentPaths.has(touchedPath)) remove.run(input.changeSetId, touchedPath);
        }
        const insert = sqlite.prepare(`
          INSERT INTO change_set_files (
            change_set_id, path, status, patch, additions, deletions, attribution_kind, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(change_set_id, path) DO UPDATE SET
            status = excluded.status,
            patch = excluded.patch,
            additions = excluded.additions,
            deletions = excluded.deletions,
            attribution_kind = excluded.attribution_kind,
            updated_at = excluded.updated_at
        `);
        for (const file of input.files) insert.run(
          input.changeSetId, file.path, file.status, file.patch ?? null,
          file.additions ?? null, file.deletions ?? null, file.attributionKind ?? "direct",
          timestamp, timestamp,
        );
        const existingReason = typeof (changeSet as { partialReason?: unknown }).partialReason === "string"
          ? String((changeSet as { partialReason: string }).partialReason)
          : "";
        const partialReason = [...new Set([existingReason, input.partialReason ?? ""].filter(Boolean))].join("；") || null;
        sqlite.prepare("UPDATE change_sets SET partial_reason = ?, updated_at = ? WHERE id = ?")
          .run(partialReason, timestamp, input.changeSetId);
      })();
      return api.listChangeSetFiles(input.changeSetId);
    },

    listChangeSetFiles(changeSetId: string) {
      return sqlite.prepare(`
        SELECT change_set_id AS changeSetId, path, status, patch, additions, deletions,
          attribution_kind AS attributionKind, created_at AS createdAt, updated_at AS updatedAt
        FROM change_set_files WHERE change_set_id = ? ORDER BY path ASC
      `).all(changeSetId) as Array<Record<string, unknown>>;
    },

    finalizeChangeSet(changeSetId: string, review: Record<string, unknown>) {
      const changeSet = api.getChangeSet(changeSetId) as { status?: string } | undefined;
      if (!changeSet || changeSet.status !== "open") return undefined;
      const timestamp = now();
      sqlite.prepare(`
        UPDATE change_sets SET status = 'finalized', review_json = ?, finalized_at = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(review), timestamp, timestamp, changeSetId);
      return api.getChangeSet(changeSetId);
    },

    abandonChangeSet(changeSetId: string) {
      const changeSet = api.getChangeSet(changeSetId) as { status?: string } | undefined;
      if (!changeSet || changeSet.status !== "open") return undefined;
      const timestamp = now();
      sqlite.prepare("UPDATE change_sets SET status = 'abandoned', abandoned_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, changeSetId);
      return api.getChangeSet(changeSetId);
    },

    createArtifact(input: {
      flowId: string;
      taskId?: string | null;
      changeSetId?: string | null;
      type: string;
      title: string;
      content: string;
      sourceAgentRunId: string;
    }) {
      const run = api.getAgentRun(input.sourceAgentRunId);
      if (!run || run.flowId !== input.flowId) return undefined;
      if (input.taskId && api.getTask(input.taskId)?.flowId !== input.flowId) return undefined;
      if (input.changeSetId && (api.getChangeSet(input.changeSetId) as { flowId?: string } | undefined)?.flowId !== input.flowId) return undefined;
      const timestamp = now();
      const artifactId = id("artifact");
      sqlite.prepare(`
        INSERT INTO artifacts (
          id, flow_id, task_id, change_set_id, type, title, content,
          source_agent_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, input.flowId, input.taskId ?? null, input.changeSetId ?? null,
        input.type, input.title, input.content, input.sourceAgentRunId, timestamp, timestamp,
      );
      return api.getArtifact(artifactId)!;
    },

    getArtifact(artifactId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, task_id AS taskId, change_set_id AS changeSetId,
          type, title, content, source_agent_run_id AS sourceAgentRunId,
          created_at AS createdAt, updated_at AS updatedAt FROM artifacts WHERE id = ?
      `).get(artifactId) as Record<string, unknown> | undefined;
    },

    listArtifacts(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, task_id AS taskId, change_set_id AS changeSetId,
          type, title, content, source_agent_run_id AS sourceAgentRunId,
          created_at AS createdAt, updated_at AS updatedAt
        FROM artifacts WHERE flow_id = ? ORDER BY created_at ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    appendEventLog(input: {
      flowId: string;
      taskId?: string | null;
      agentRunId?: string | null;
      eventType: string;
      payload?: Record<string, unknown>;
    }) {
      if (!api.getFlow(input.flowId)) return undefined;
      const sequence = (sqlite.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM event_log WHERE flow_id = ?")
        .get(input.flowId) as { sequence: number }).sequence;
      const eventId = id("evt");
      sqlite.prepare(`
        INSERT INTO event_log (id, flow_id, task_id, agent_run_id, event_type, payload_json, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, input.flowId, input.taskId ?? null, input.agentRunId ?? null,
        input.eventType, JSON.stringify(input.payload ?? {}), sequence, now(),
      );
      return api.listEventLog(input.flowId).at(-1);
    },

    listEventLog(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, task_id AS taskId, agent_run_id AS agentRunId,
          event_type AS eventType, payload_json AS payloadJson, sequence, created_at AS createdAt
        FROM event_log WHERE flow_id = ? ORDER BY sequence ASC
      `).all(flowId) as Array<Record<string, unknown>>;
    },

    upsertAgentContextUsageSnapshot(input: {
      flowId: string;
      agentRunId: string;
      providerSessionId?: string | null;
      role: string;
      agentDefinitionId?: string | null;
      agentSessionId?: string | null;
      totalTokens?: number | null;
      maxTokens?: number | null;
      rawMaxTokens?: number | null;
      percentage?: number | null;
      model?: string | null;
      categories?: ContextUsageCategory[];
      cacheInputTokens?: number | null;
      cacheReadInputTokens?: number | null;
      cacheCreationInputTokens?: number | null;
      cacheHitRate?: number | null;
      compacted?: boolean;
      observedAt?: string;
    }) {
      const run = api.getAgentRun(input.agentRunId);
      if (!run || run.flowId !== input.flowId) return undefined;
      const timestamp = now();
      sqlite.prepare(`
        INSERT INTO agent_context_usage_snapshots (
          id, flow_id, agent_run_id, provider_session_id, role, agent_definition_id,
          agent_session_id, total_tokens, max_tokens, raw_max_tokens, percentage, model,
          categories_json, cache_input_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, cache_hit_rate, compacted, observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_run_id) DO UPDATE SET
          provider_session_id = excluded.provider_session_id, role = excluded.role,
          agent_definition_id = excluded.agent_definition_id, agent_session_id = excluded.agent_session_id,
          total_tokens = excluded.total_tokens, max_tokens = excluded.max_tokens,
          raw_max_tokens = excluded.raw_max_tokens, percentage = excluded.percentage,
          model = excluded.model, categories_json = excluded.categories_json,
          cache_input_tokens = excluded.cache_input_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          cache_hit_rate = excluded.cache_hit_rate, compacted = excluded.compacted,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at
      `).run(
        id("ctx"), input.flowId, input.agentRunId, input.providerSessionId ?? null,
        input.role, input.agentDefinitionId ?? null, input.agentSessionId ?? run.agentSessionId,
        input.totalTokens ?? null, input.maxTokens ?? null, input.rawMaxTokens ?? null,
        input.percentage ?? null, input.model ?? null, JSON.stringify(input.categories ?? []),
        input.cacheInputTokens ?? null, input.cacheReadInputTokens ?? null,
        input.cacheCreationInputTokens ?? null, input.cacheHitRate ?? null,
        input.compacted ? 1 : 0, input.observedAt ?? timestamp, timestamp, timestamp,
      );
      return api.getAgentContextUsageSnapshot(input.agentRunId);
    },

    getAgentContextUsageSnapshot(agentRunId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId,
          provider_session_id AS providerSessionId, role,
          agent_definition_id AS agentDefinitionId, agent_session_id AS agentSessionId,
          total_tokens AS totalTokens, max_tokens AS maxTokens, raw_max_tokens AS rawMaxTokens,
          percentage, model, categories_json AS categoriesJson, cache_input_tokens AS cacheInputTokens,
          cache_read_input_tokens AS cacheReadInputTokens,
          cache_creation_input_tokens AS cacheCreationInputTokens, cache_hit_rate AS cacheHitRate,
          compacted, observed_at AS observedAt, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_context_usage_snapshots WHERE agent_run_id = ?
      `).get(agentRunId) as AgentContextUsageSnapshotRow | undefined;
    },

    listAgentContextUsageSnapshots(flowId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, agent_run_id AS agentRunId,
          provider_session_id AS providerSessionId, role,
          agent_definition_id AS agentDefinitionId, agent_session_id AS agentSessionId,
          total_tokens AS totalTokens, max_tokens AS maxTokens, raw_max_tokens AS rawMaxTokens,
          percentage, model, categories_json AS categoriesJson, cache_input_tokens AS cacheInputTokens,
          cache_read_input_tokens AS cacheReadInputTokens,
          cache_creation_input_tokens AS cacheCreationInputTokens, cache_hit_rate AS cacheHitRate,
          compacted, observed_at AS observedAt, created_at AS createdAt, updated_at AS updatedAt
        FROM agent_context_usage_snapshots WHERE flow_id = ? ORDER BY observed_at ASC
      `).all(flowId) as AgentContextUsageSnapshotRow[];
    },

    deleteFlow(flowId: string) {
      if (!api.getFlow(flowId)) return false;
      const tables = [
        "chat_queue_items", "chat_submissions", "chat_timeline_items", "chat_transcript_channels",
        "change_set_files", "change_set_contributions", "change_baseline_candidates", "change_sets",
        "task_dependencies", "tasks", "orchestration_feedback", "orchestration_approvals",
        "orchestration_node_dependencies", "orchestration_nodes", "orchestration_revisions",
        "orchestration_plans", "plan_approvals", "plan_revisions", "plan_documents",
        "leader_run_triggers", "decision_requests", "tool_calls",
        "agent_context_usage_snapshots", "event_log", "artifacts", "agent_runs",
        "agent_sessions", "flow_read_states",
      ];
      sqlite.transaction(() => {
        const changeSetIds = (sqlite.prepare("SELECT id FROM change_sets WHERE flow_id = ?").all(flowId) as Array<{ id: string }>).map((row) => row.id);
        if (changeSetIds.length) {
          sqlite.prepare(`DELETE FROM change_set_files WHERE change_set_id IN (${placeholders(changeSetIds)})`).run(...changeSetIds);
          sqlite.prepare(`DELETE FROM change_set_contributions WHERE change_set_id IN (${placeholders(changeSetIds)})`).run(...changeSetIds);
        }
        const taskIds = (sqlite.prepare("SELECT id FROM tasks WHERE flow_id = ?").all(flowId) as Array<{ id: string }>).map((row) => row.id);
        if (taskIds.length) sqlite.prepare(`DELETE FROM task_dependencies WHERE task_id IN (${placeholders(taskIds)}) OR depends_on_task_id IN (${placeholders(taskIds)})`)
          .run(...taskIds, ...taskIds);
        const revisionIds = (sqlite.prepare("SELECT id FROM orchestration_revisions WHERE flow_id = ?").all(flowId) as Array<{ id: string }>).map((row) => row.id);
        const nodeIds = revisionIds.length
          ? (sqlite.prepare(`SELECT id FROM orchestration_nodes WHERE orchestration_revision_id IN (${placeholders(revisionIds)})`).all(...revisionIds) as Array<{ id: string }>).map((row) => row.id)
          : [];
        if (nodeIds.length) sqlite.prepare(`DELETE FROM orchestration_node_dependencies WHERE node_id IN (${placeholders(nodeIds)}) OR depends_on_node_id IN (${placeholders(nodeIds)})`)
          .run(...nodeIds, ...nodeIds);
        for (const table of tables) {
          if (["change_set_files", "change_set_contributions", "task_dependencies", "orchestration_node_dependencies"].includes(table)) continue;
          sqlite.prepare(`DELETE FROM ${table} WHERE flow_id = ?`).run(flowId);
        }
        sqlite.prepare("DELETE FROM flows WHERE id = ?").run(flowId);
      })();
      return true;
    },

    clearFlows() {
      for (const flow of api.listFlows()) api.deleteFlow(flow.id);
    },
  };

  return api;
}

export type Store = ReturnType<typeof createStore>;

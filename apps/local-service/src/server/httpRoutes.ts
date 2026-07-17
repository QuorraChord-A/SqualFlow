import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { config, DEFAULT_PROJECT_ID } from "../config.js";
import {
  createRuntimeConfig,
  deleteRuntimeConfig,
  readAgentRuntimeConfigSnapshot,
  readFlowLeaderRuntimeConfig,
  readRuntimeConfig,
  runtimeConfigModelName,
  runtimeSdkFromValue,
  updateRoleRuntimeBinding,
  updateRuntimeConfig,
  type AgentRuntimeRole,
} from "../config/agentRuntimeConfig.js";
import { runtimeModelContextWindowK } from "../config/runtimeModelContext.js";
import {
  checkRuntimeConfigLocalAuth,
  refreshRuntimeConfigModels,
  testRuntimeConfigConnection,
} from "../config/agentRuntimeConnectionTest.js";
import type { Store } from "../db/store.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import { buildFlowWorkbench } from "../domain/workbench.js";
import { planHistoryView, planRevisionView } from "../domain/orchestrationView.js";
import { RiskModeSchema, PlanApprovalSchema } from "../domain/flowSettings.js";
import { DeclarativeOrchestrationRuleSchema } from "../domain/orchestration.js";
import type { LeaderRuntime } from "../runtime/leaderRuntime.js";
import type { ContextCompactionSnapshot, ContextCompactionState } from "../runtime/contextCompactionState.js";
import { createAgentRuntimeAdapter } from "../runtime/adapters/factory.js";
import { runtimeSdkForPersistedAgentSession } from "./sessionRuntimeResolver.js";
import { legacyAgentType } from "./legacyCompat.js";
import {
  codexReasoningEffortsForModel,
  defaultCodexReasoningEffortForModel,
  parseCodexReasoningEffort,
} from "../runtime/codexReasoningEffort.js";

type RegisterHttpRoutesDeps = {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "compactContext">;
  contextCompactions: ContextCompactionState;
};

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function directoryName(localPath: string): string {
  const normalized = localPath.replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized;
}

async function removeFlowRuntimeDirectories(flowId: string) {
  await fs.rm(path.join(config.runtimeScratchRoot, flowId), { recursive: true, force: true });
}

async function removeManyFlowRuntimeDirectories(flowIds: string[]) {
  await Promise.all(flowIds.map((flowId) => removeFlowRuntimeDirectories(flowId)));
}

async function removeChildDirectories(root: string, shouldRemove: (name: string) => boolean) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && shouldRemove(entry.name))
      .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })),
  );
}

async function removeAllFlowRuntimeDirectories() {
  await removeChildDirectories(config.runtimeScratchRoot, (name) => name.startsWith("flow-"));
}

async function validateProjectDirectory(localPath: string): Promise<boolean> {
  if (!path.isAbsolute(localPath)) return false;
  try {
    return (await fs.stat(localPath)).isDirectory();
  } catch {
    return false;
  }
}

function validateProjectName(value: string): string | null {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return null;
  return name;
}

function projectToApi(row: ReturnType<Store["listProjects"]>[number]) {
  return {
    id: row.id,
    name: row.name,
    local_path: row.localPath,
    agent_type: legacyAgentType,
    description: row.description ?? "",
    created_at: row.createdAt,
    is_default: row.id === DEFAULT_PROJECT_ID,
  };
}

function agentSessionToApi(row: ReturnType<Store["listAgentSessions"]>[number]) {
  return {
    id: row.id,
    agent_session_id: row.id,
    flow_id: row.flowId,
    user_turn_id: row.userTurnId,
    task_id: row.taskId,
    expert_id: row.expertId,
    session_id: row.sessionId,
    runtime_sdk: row.runtimeSdk,
    runtime_config_id: row.runtimeConfigId,
    runtime_model_id: row.runtimeModelId,
    display_name: row.displayName,
    status: row.status,
    resume_from_agent_session_id: row.resumeFromAgentSessionId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function flowExpertToApi(store: Store, row: ReturnType<Store["listFlowExperts"]>[number]) {
  const sessions = store.listAgentSessions(row.flowId)
    .filter((session) => session.flowExpertId === row.id);
  const latestSession = sessions.at(-1) ?? null;
  const currentTask = store.listTasks(row.flowId)
    .filter((task) => task.flowExpertId === row.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

  return {
    id: row.id,
    flow_expert_id: row.id,
    flow_id: row.flowId,
    expert_id: row.expertId,
    display_name: row.displayName,
    status: row.status,
    session_id: row.sdkSessionId,
    runtime_sdk: row.runtimeSdk,
    runtime_config_id: row.runtimeConfigId,
    runtime_model_id: row.runtimeModelId,
    agent_session_id: latestSession?.id ?? null,
    current_task_id: currentTask?.id ?? null,
    current_task_title: currentTask?.title ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function expertToApi(row: ReturnType<Store["listExperts"]>[number]) {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    system_prompt: row.systemPrompt,
    builtin_tools: JSON.parse(row.builtinTools) as unknown[],
    mcp_tools: JSON.parse(row.mcpTools) as unknown[],
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function agentRuntimeConfigSnapshotToApi(snapshot: Awaited<ReturnType<typeof readAgentRuntimeConfigSnapshot>>) {
  return {
    ...snapshot,
    configs: snapshot.configs.map((runtimeConfig) => ({
      ...runtimeConfig,
      models: runtimeConfig.models.map((model) => ({
        ...model,
        contextWindowK: runtimeModelContextWindowK(runtimeConfig, model.name),
        ...(runtimeConfig.sdk === "codex" && runtimeConfig.authMode === "inherited"
          ? {
              reasoningEfforts: codexReasoningEffortsForModel(model.name),
              defaultReasoningEffort: defaultCodexReasoningEffortForModel(model.name),
            }
          : {}),
      })),
    })),
  };
}

function flowToApi(store: Store, row: NonNullable<ReturnType<Store["getFlow"]>>) {
  const snapshot = buildFlowSnapshot(store, row.id);
  if ("error" in snapshot) return snapshot;
  return {
    ...snapshot,
    name: row.name,
    type: "full",
    flow_type: "full",
    is_pinned: row.isPinned === 1,
    has_pending_decision: snapshot.decision_cards.some((card) => card.status === "pending"),
    has_unread_messages: store.hasUnreadOutput(row.id),
    last_output_completed_at: row.lastOutputCompletedAt,
    last_read_at: store.getFlowReadState(row.id)?.lastReadAt ?? null,
    agent_type: legacyAgentType,
    leader_runtime_sdk: row.leaderRuntimeSdk,
    leader_runtime_config_id: row.leaderRuntimeConfigId,
    leader_runtime_model_id: row.leaderRuntimeModelId,
    leader_runtime_reasoning_effort: row.leaderRuntimeReasoningEffort,
  };
}

async function defaultLeaderRuntimeSelection() {
  const snapshot = await readAgentRuntimeConfigSnapshot();
  const leaderRole = snapshot.roles.find((role) => role.role === "leader");
  const runtimeConfig = snapshot.configs.find((item) => item.id === leaderRole?.configId && item.models.some((model) => model.name.trim()))
    ?? snapshot.configs.find((item) => item.models.some((model) => model.name.trim()))
    ?? null;
  const model = runtimeConfig?.models.find((item) => item.name.trim()) ?? null;
  return {
    leaderRuntimeSdk: runtimeConfig?.sdk ?? null,
    leaderRuntimeConfigId: runtimeConfig?.id ?? null,
    leaderRuntimeModelId: model?.id ?? null,
  };
}

function contextUsageSnapshotToApi(
  store: Store,
  snapshot: ReturnType<Store["listAgentContextUsageSnapshots"]>[number],
) {
  const session = store.getAgentSession(snapshot.agentSessionId);
  return {
    agent_session_id: snapshot.agentSessionId,
    sdk_session_id: snapshot.sdkSessionId,
    role: snapshot.role,
    expert_id: snapshot.expertId,
    flow_expert_id: snapshot.flowExpertId,
    display_name: session?.displayName ?? snapshot.expertId ?? snapshot.role,
    total_tokens: snapshot.totalTokens,
    max_tokens: snapshot.maxTokens,
    raw_max_tokens: snapshot.rawMaxTokens,
    percentage: snapshot.percentage,
    model: snapshot.model,
    categories: parseJsonArray(snapshot.categoriesJson).flatMap((item) => {
      const category = isRecord(item) ? item : null;
      if (!category) return [];
      return [{
        name: stringValue(category.name),
        tokens: typeof category.tokens === "number" ? category.tokens : 0,
        color: nullableString(category.color),
        is_deferred: Boolean(category.isDeferred),
      }];
    }),
    cache_input_tokens: snapshot.cacheInputTokens,
    cache_read_input_tokens: snapshot.cacheReadInputTokens,
    cache_creation_input_tokens: snapshot.cacheCreationInputTokens,
    cache_hit_rate: snapshot.cacheHitRate,
    observed_at: snapshot.observedAt,
    compacted: snapshot.compacted === 1,
  };
}

function flowContextUsageToApi(store: Store, flowId: string) {
  const snapshots = store.listAgentContextUsageSnapshots(flowId)
    .map((snapshot) => contextUsageSnapshotToApi(store, snapshot));
  const leader = snapshots.find((snapshot) =>
    snapshot.role === "leader" || snapshot.expert_id === "exp-leader"
  ) ?? null;
  return {
    leader,
    experts: snapshots.filter((snapshot) => snapshot !== leader),
  };
}

async function flowContextCompactionsToApi(
  store: Store,
  contextCompactions: ContextCompactionState,
  flowId: string,
): Promise<ContextCompactionSnapshot[]> {
  const memoryItems = contextCompactions.listFlow(flowId);
  const memoryAgentSessionIds = new Set(memoryItems.map((item) => item.agent_session_id));
  const transcriptItems = await Promise.all(
    store.listAgentSessions(flowId).map(async (session): Promise<ContextCompactionSnapshot | null> => {
      if (!session.sessionId || memoryAgentSessionIds.has(session.id)) return null;
      let metadata;
      try {
        const runtimeConfig = session.runtimeConfigId
          ? await readRuntimeConfig(session.runtimeConfigId)
          : null;
        const adapter = createAgentRuntimeAdapter({
          sdk: await runtimeSdkForPersistedAgentSession({ store, flowId, agentSession: session }),
          ...(runtimeConfig ? { runtimeConfig } : {}),
        });
        metadata = await adapter.latestCompactTranscriptMetadata(session.sessionId);
      } catch {
        return null;
      }
      if (!metadata) return null;
      const timestamp = metadata.timestamp ?? session.updatedAt;
      const snapshot: ContextCompactionSnapshot = {
        flow_id: flowId,
        agent_session_id: session.id,
        sdk_session_id: session.sessionId,
        role: session.expertId === "exp-leader" ? "leader" : session.expertId,
        expert_id: session.expertId,
        flow_expert_id: session.flowExpertId,
        display_name: session.displayName,
        status: "completed" as const,
        started_at: timestamp,
        updated_at: timestamp,
        error_message: null,
      };
      return snapshot;
    }),
  );
  return [
    ...memoryItems,
    ...transcriptItems.filter((item): item is ContextCompactionSnapshot => item !== null),
  ];
}

async function flowDetailToApi(
  store: Store,
  contextCompactions: ContextCompactionState,
  row: NonNullable<ReturnType<Store["getFlow"]>>,
) {
  return {
    ...flowToApi(store, row),
    context_usage: flowContextUsageToApi(store, row.id),
    context_compactions: await flowContextCompactionsToApi(store, contextCompactions, row.id),
  };
}

function paramsId(request: { params: unknown }, key: string): string {
  return isRecord(request.params) ? stringValue(request.params[key]) : "";
}

function bodyRecord(request: { body: unknown }): Record<string, unknown> {
  return isRecord(request.body) ? request.body : {};
}

const WORKSPACE_TREE_EXCLUDED_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".playwright-cli",
  ".ruff_cache",
  ".venv",
  "node_modules",
  "__pycache__",
  "coverage",
  "dist",
  ".DS_Store",
]);
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 1000;

type WorkspacePathResolution =
  | { ok: true; root: string; target: string; relativePath: string }
  | { ok: false; statusCode: 400 | 403 | 404; detail: string };

async function resolveFlowWorkspacePath(
  store: Store,
  flowId: string,
  requestedPath: string,
  allowRoot: boolean,
): Promise<WorkspacePathResolution> {
  const flow = store.getFlow(flowId);
  if (!flow) return { ok: false, statusCode: 404, detail: "Flow not found" };

  if (path.isAbsolute(requestedPath)) {
    return { ok: false, statusCode: 400, detail: "A relative workspace path is required" };
  }
  if (!allowRoot && !requestedPath) {
    return { ok: false, statusCode: 400, detail: "A relative file path is required" };
  }

  const project = flow.projectId ? store.getProject(flow.projectId) : null;
  const openUserTurn = store.getOpenUserTurn(flowId);
  const rootPath = openUserTurn?.workRootPath || project?.localPath || "";
  if (!rootPath) return { ok: false, statusCode: 404, detail: "Project root not found" };

  let root: string;
  try {
    root = await fs.realpath(rootPath);
  } catch {
    return { ok: false, statusCode: 404, detail: "Project root not found" };
  }

  const relativePath = requestedPath.startsWith("./") ? requestedPath.slice(2) : requestedPath;
  const candidate = path.resolve(root, relativePath || ".");
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return { ok: false, statusCode: 403, detail: "Workspace path escapes workspace root" };
  }

  try {
    const target = await fs.realpath(candidate);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return { ok: false, statusCode: 403, detail: "Workspace path escapes workspace root" };
    }
    return { ok: true, root, target, relativePath };
  } catch {
    return { ok: false, statusCode: 404, detail: "Workspace path not found" };
  }
}

export function registerHttpRoutes(app: FastifyInstance, deps: RegisterHttpRoutesDeps): void {
  const { store, leaderRuntime, contextCompactions } = deps;

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/system/select-directory", async (_request, reply) => {
    if (process.platform !== "darwin") {
      return reply.code(501).send({ detail: "Directory picker is currently supported on macOS only" });
    }
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "选择项目文件夹")',
      ]);
      const localPath = stdout.trim().replace(/\/$/, "");
      if (!localPath) return reply.code(204).send();
      return { local_path: localPath, name: directoryName(localPath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("User canceled") || message.includes("-128")) {
        return reply.code(204).send();
      }
      return reply.code(500).send({ detail: "Unable to open directory picker" });
    }
  });

  app.get("/api/projects", async () => store.listProjects().map(projectToApi));

  app.post("/api/projects/new", async (request, reply) => {
    const body = bodyRecord(request);
    const name = validateProjectName(stringValue(body.name));
    if (!name) return reply.code(400).send({ detail: "name must be a valid folder name" });

    const localPath = path.join(config.defaultProjectRoot, name);
    const existingProject = store.listProjects().find((project) => path.resolve(project.localPath) === path.resolve(localPath));
    if (existingProject) return reply.code(409).send({ detail: "A project with this name already exists" });

    const existingPath = await fs.stat(localPath).catch((error) => {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (existingPath && !existingPath.isDirectory()) {
      return reply.code(409).send({ detail: "A non-directory path with this name already exists" });
    }
    if (!existingPath) {
      await fs.mkdir(localPath, { recursive: false });
    }

    const project = store.createProject({
      name,
      localPath,
      description: "",
    });
    reply.code(201);
    return projectToApi(project);
  });

  app.post("/api/projects", async (request, reply) => {
    const body = bodyRecord(request);
    const localPath = stringValue(body.local_path).trim().replace(/\/$/, "");
    if (!await validateProjectDirectory(localPath)) {
      return reply.code(400).send({ detail: "local_path must be an existing absolute directory" });
    }
    const existing = store.listProjects().find((project) => path.resolve(project.localPath) === path.resolve(localPath));
    if (existing) return projectToApi(existing);
    const project = store.createProject({
      name: stringValue(body.name, directoryName(localPath)),
      localPath,
      description: stringValue(body.description),
    });
    reply.code(201);
    return projectToApi(project);
  });

  app.get("/api/projects/:projectId", async (request, reply) => {
    const project = store.getProject(paramsId(request, "projectId"));
    if (!project) return reply.code(404).send({ detail: "Project not found" });
    return projectToApi(project);
  });

  app.put("/api/projects/:projectId", async (request, reply) => {
    const body = bodyRecord(request);
    const localPath = typeof body.local_path === "string" ? body.local_path.trim().replace(/\/$/, "") : undefined;
    if (localPath !== undefined && !await validateProjectDirectory(localPath)) {
      return reply.code(400).send({ detail: "local_path must be an existing absolute directory" });
    }
    const project = store.updateProject(paramsId(request, "projectId"), {
      name: typeof body.name === "string" ? body.name : undefined,
      localPath,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    if (!project) return reply.code(404).send({ detail: "Project not found" });
    return projectToApi(project);
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const projectId = paramsId(request, "projectId");
    if (projectId === DEFAULT_PROJECT_ID) return reply.code(409).send({ detail: "Default project cannot be deleted" });
    if (!store.getProject(projectId)) return reply.code(404).send({ detail: "Project not found" });
    const flowIds = store.listFlows(projectId).map((flow) => flow.id);
    for (const flowId of flowIds) store.deleteFlow(flowId);
    await removeManyFlowRuntimeDirectories(flowIds);
    store.deleteProject(projectId);
    return reply.code(204).send();
  });

  app.get("/api/experts", async () => store.listExperts().map(expertToApi));

  app.get("/api/agent-runtime-config", async () => agentRuntimeConfigSnapshotToApi(await readAgentRuntimeConfigSnapshot()));

  app.post("/api/agent-runtime-config/configs", async (request, reply) => {
    try {
      const runtimeConfig = await createRuntimeConfig(bodyRecord(request));
      reply.code(201);
      return runtimeConfig;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create runtime config";
      return reply.code(400).send({ detail: message });
    }
  });

  app.put("/api/agent-runtime-config/configs/:configId", async (request, reply) => {
    try {
      const runtimeConfig = await updateRuntimeConfig(paramsId(request, "configId"), bodyRecord(request));
      if (!runtimeConfig) return reply.code(404).send({ detail: "Runtime config not found" });
      return runtimeConfig;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update runtime config";
      return reply.code(400).send({ detail: message });
    }
  });

  app.delete("/api/agent-runtime-config/configs/:configId", async (request, reply) => {
    try {
      const snapshot = await deleteRuntimeConfig(paramsId(request, "configId"));
      if (!snapshot) return reply.code(404).send({ detail: "Runtime config not found" });
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete runtime config";
      return reply.code(409).send({ detail: message });
    }
  });

  app.post("/api/agent-runtime-config/configs/:configId/test-connection", async (request, reply) => {
    try {
      return await testRuntimeConfigConnection(paramsId(request, "configId"), bodyRecord(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to test runtime config";
      return reply.code(400).send({ detail: message });
    }
  });

  app.post("/api/agent-runtime-config/configs/:configId/local-auth", async (request, reply) => {
    try {
      return await checkRuntimeConfigLocalAuth(paramsId(request, "configId"), bodyRecord(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to check runtime local auth";
      return reply.code(400).send({ detail: message });
    }
  });

  app.post("/api/agent-runtime-config/configs/:configId/available-models", async (request, reply) => {
    try {
      return await refreshRuntimeConfigModels(paramsId(request, "configId"), bodyRecord(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh runtime models";
      return reply.code(400).send({ detail: message });
    }
  });

  app.put("/api/agent-runtime-config/roles/:role", async (request, reply) => {
    try {
      const role = paramsId(request, "role") as AgentRuntimeRole;
      const binding = await updateRoleRuntimeBinding(role, bodyRecord(request));
      if (!binding) return reply.code(404).send({ detail: "Runtime role not found" });
      return binding;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update role binding";
      return reply.code(400).send({ detail: message });
    }
  });

  app.get("/api/flows", async (request) => {
    const query = isRecord(request.query) ? request.query : {};
    const projectId = typeof query.project_id === "string" ? query.project_id : undefined;
    return store.listFlows(projectId).map((flow) => flowToApi(store, flow));
  });

  app.post("/api/flows", async (request, reply) => {
    const body = bodyRecord(request);
    const projectId = nullableString(body.project_id);
    if (!projectId || !store.getProject(projectId)) {
      return reply.code(400).send({ detail: "project_id must reference an existing project" });
    }
    const riskMode = body.risk_mode === undefined
      ? undefined
      : RiskModeSchema.safeParse(body.risk_mode);
    if (riskMode && !riskMode.success) {
      return reply.code(400).send({ detail: "risk_mode must be auto_edit or full_access" });
    }
    const planApproval = body.plan_approval === undefined
      ? undefined
      : PlanApprovalSchema.safeParse(body.plan_approval);
    if (planApproval && !planApproval.success) {
      return reply.code(400).send({ detail: "plan_approval must be on or off" });
    }
    let runtimeSelection = await defaultLeaderRuntimeSelection();
    if (
      Object.prototype.hasOwnProperty.call(body, "leader_runtime_config_id")
      || Object.prototype.hasOwnProperty.call(body, "leader_runtime_model_id")
    ) {
      const leaderRuntimeConfigId = nullableString(body.leader_runtime_config_id);
      const leaderRuntimeModelId = nullableString(body.leader_runtime_model_id);
      if (!leaderRuntimeConfigId || !leaderRuntimeModelId) {
        return reply.code(400).send({ detail: "Leader model is not configured" });
      }
      const resolved = await readFlowLeaderRuntimeConfig({
        configId: leaderRuntimeConfigId,
        modelId: leaderRuntimeModelId,
      });
      if (!resolved) return reply.code(400).send({ detail: "Leader model is not configured" });
      runtimeSelection = {
        leaderRuntimeSdk: resolved.config.sdk,
        leaderRuntimeConfigId,
        leaderRuntimeModelId,
      };
    }
    let leaderRuntimeReasoningEffort: string | null = null;
    if (
      Object.prototype.hasOwnProperty.call(body, "leader_runtime_reasoning_effort")
      && body.leader_runtime_reasoning_effort !== null
      && body.leader_runtime_reasoning_effort !== ""
    ) {
      if (runtimeSelection.leaderRuntimeSdk !== "codex") {
        return reply.code(400).send({ detail: "Leader reasoning effort is only supported for Codex" });
      }
      const resolved = await readFlowLeaderRuntimeConfig({
        sdk: runtimeSelection.leaderRuntimeSdk,
        configId: runtimeSelection.leaderRuntimeConfigId,
        modelId: runtimeSelection.leaderRuntimeModelId,
      });
      if (!resolved) return reply.code(400).send({ detail: "Leader model is not configured" });
      if (resolved.config.authMode !== "inherited") {
        return reply.code(400).send({ detail: "Leader reasoning effort requires official Codex login" });
      }
      const modelName = runtimeConfigModelName(resolved.config, resolved.modelId) ?? resolved.modelId;
      leaderRuntimeReasoningEffort = parseCodexReasoningEffort(modelName, body.leader_runtime_reasoning_effort);
      if (!leaderRuntimeReasoningEffort) {
        return reply.code(400).send({ detail: "Unsupported Codex reasoning effort" });
      }
    }
    const flow = store.createFlow({
      name: stringValue(body.name, "Task"),
      description: stringValue(body.description),
      projectId,
      ...(riskMode?.success ? { riskMode: riskMode.data } : {}),
      ...(planApproval?.success ? { planApproval: planApproval.data } : {}),
      ...runtimeSelection,
      leaderRuntimeReasoningEffort,
    });
    reply.code(201);
    return flowToApi(store, flow);
  });

  app.delete("/api/flows", async (_request, reply) => {
    const flowIds = store.listFlows().map((flow) => flow.id);
    store.clearFlows();
    await Promise.all([
      removeManyFlowRuntimeDirectories(flowIds),
      removeAllFlowRuntimeDirectories(),
    ]);
    return reply.code(204).send();
  });

  app.get("/api/flows/:flowId", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    return flowDetailToApi(store, contextCompactions, flow);
  });

  app.post("/api/flows/:flowId/context/compact", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const flow = store.getFlow(flowId);
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    if (store.getOpenUserTurn(flowId)) return reply.code(409).send({ detail: "Flow is not idle" });
    try {
      await leaderRuntime.compactContext(flowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message === "Flow not found" ? 404 : 409;
      return reply.code(statusCode).send({ detail: message });
    }
    return {
      context_usage: flowContextUsageToApi(store, flowId),
      context_compactions: await flowContextCompactionsToApi(store, contextCompactions, flowId),
    };
  });

  app.put("/api/flows/:flowId", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const existingFlow = store.getFlow(flowId);
    if (!existingFlow) return reply.code(404).send({ detail: "Flow not found" });
    const body = bodyRecord(request);
    const input: {
      name?: string;
      description?: string | null;
      projectId?: string | null;
      isPinned?: boolean;
      riskMode?: "auto_edit" | "full_access";
      planApproval?: "on" | "off";
      leaderRuntimeConfigId?: string | null;
      leaderRuntimeModelId?: string | null;
      leaderRuntimeSdk?: string | null;
      leaderRuntimeReasoningEffort?: string | null;
    } = {};
    if (typeof body.name === "string") input.name = body.name;
    if (typeof body.description === "string") input.description = body.description;
    if (Object.prototype.hasOwnProperty.call(body, "project_id")) {
      const projectId = nullableString(body.project_id);
      if (!projectId || !store.getProject(projectId)) {
        return reply.code(400).send({ detail: "project_id must reference an existing project" });
      }
      input.projectId = projectId;
    }
    if (typeof body.is_pinned === "boolean") input.isPinned = body.is_pinned;
    if (Object.prototype.hasOwnProperty.call(body, "risk_mode")) {
      const parsed = RiskModeSchema.safeParse(body.risk_mode);
      if (!parsed.success) return reply.code(400).send({ detail: "risk_mode must be auto_edit or full_access" });
      input.riskMode = parsed.data;
    }
    if (Object.prototype.hasOwnProperty.call(body, "plan_approval")) {
      const parsed = PlanApprovalSchema.safeParse(body.plan_approval);
      if (!parsed.success) return reply.code(400).send({ detail: "plan_approval must be on or off" });
      input.planApproval = parsed.data;
    }
    if (
      Object.prototype.hasOwnProperty.call(body, "leader_runtime_config_id")
      || Object.prototype.hasOwnProperty.call(body, "leader_runtime_model_id")
    ) {
      const latestLeaderSession = store.listAgentSessions(flowId)
        .filter((session) => session.expertId === "exp-leader" && session.taskId === null)
        .at(-1);
      const flowRuntimeConfig = existingFlow.leaderRuntimeConfigId
        ? await readRuntimeConfig(existingFlow.leaderRuntimeConfigId)
        : null;
      const sessionRuntimeConfig = !flowRuntimeConfig && latestLeaderSession?.runtimeConfigId
        ? await readRuntimeConfig(latestLeaderSession.runtimeConfigId)
        : null;
      const currentRuntimeConfig = flowRuntimeConfig ?? sessionRuntimeConfig;
      const lockedSdk = runtimeSdkFromValue(existingFlow.leaderRuntimeSdk)
        ?? runtimeSdkFromValue(latestLeaderSession?.runtimeSdk)
        ?? currentRuntimeConfig?.sdk
        ?? null;
      const leaderRuntimeConfigId = nullableString(body.leader_runtime_config_id);
      const leaderRuntimeModelId = nullableString(body.leader_runtime_model_id);
      if (!leaderRuntimeConfigId || !leaderRuntimeModelId) {
        input.leaderRuntimeSdk = lockedSdk;
        input.leaderRuntimeConfigId = null;
        input.leaderRuntimeModelId = null;
      } else {
        const resolved = await readFlowLeaderRuntimeConfig({
          configId: leaderRuntimeConfigId,
          modelId: leaderRuntimeModelId,
        });
        if (!resolved) return reply.code(400).send({ detail: "Leader model is not configured" });
        if (lockedSdk && resolved.config.sdk !== lockedSdk) {
          return reply.code(409).send({ detail: `Leader SDK is locked to ${lockedSdk} for this Flow` });
        }
        if (
          currentRuntimeConfig?.sdk === "codex"
          && resolved.config.sdk === "codex"
          && (currentRuntimeConfig.authMode === "inherited") !== (resolved.config.authMode === "inherited")
        ) {
          return reply.code(409).send({
            detail: "Codex official and custom providers cannot share one runtime session",
          });
        }
        input.leaderRuntimeSdk = lockedSdk ?? resolved.config.sdk;
        input.leaderRuntimeConfigId = leaderRuntimeConfigId;
        input.leaderRuntimeModelId = leaderRuntimeModelId;
        if (resolved.config.sdk !== "codex" || resolved.config.authMode !== "inherited") {
          input.leaderRuntimeReasoningEffort = null;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "leader_runtime_reasoning_effort")) {
      const sdk = input.leaderRuntimeSdk ?? existingFlow.leaderRuntimeSdk;
      if (sdk !== "codex") return reply.code(400).send({ detail: "Leader reasoning effort is only supported for Codex" });
      const runtimeConfig = await readFlowLeaderRuntimeConfig({
        sdk,
        configId: input.leaderRuntimeConfigId ?? existingFlow.leaderRuntimeConfigId,
        modelId: input.leaderRuntimeModelId ?? existingFlow.leaderRuntimeModelId,
      });
      if (!runtimeConfig) return reply.code(400).send({ detail: "Leader model is not configured" });
      if (runtimeConfig.config.authMode !== "inherited") {
        return reply.code(400).send({ detail: "Leader reasoning effort requires official Codex login" });
      }
      const modelName = runtimeConfigModelName(runtimeConfig.config, runtimeConfig.modelId) ?? runtimeConfig.modelId;
      const effort = parseCodexReasoningEffort(modelName, body.leader_runtime_reasoning_effort);
      if (!effort) return reply.code(400).send({ detail: "Unsupported Codex reasoning effort" });
      input.leaderRuntimeReasoningEffort = effort;
    }
    const flow = store.updateFlow(flowId, input);
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    return flowToApi(store, flow);
  });

  app.post("/api/flows/:flowId/read", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const flow = store.getFlow(flowId);
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    store.markFlowRead(flowId);
    return flowToApi(store, store.getFlow(flowId)!);
  });

  app.delete("/api/flows/:flowId", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const deleted = store.deleteFlow(flowId);
    if (!deleted) return reply.code(404).send({ detail: "Flow not found" });
    await removeFlowRuntimeDirectories(flowId);
    return reply.code(204).send();
  });

  app.post("/api/flows/:flowId/commit_plan", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    return reply.code(409).send({ detail: "commit_plan is handled by websocket runtime" });
  });

  app.get("/api/flows/:flowId/tasks", async (request) => {
    const snapshot = buildFlowSnapshot(store, paramsId(request, "flowId"));
    return "error" in snapshot ? [] : snapshot.tasks;
  });

  app.get("/api/flows/:flowId/spec-revisions", async (request) => {
    const snapshot = buildFlowSnapshot(store, paramsId(request, "flowId"));
    return "error" in snapshot ? [] : snapshot.spec_revisions;
  });

  app.get("/api/flows/:flowId/artifacts", async (request) => {
    const snapshot = buildFlowSnapshot(store, paramsId(request, "flowId"));
    return "error" in snapshot ? [] : snapshot.artifacts;
  });

  app.get("/api/flows/:flowId/workbench", async (request, reply) => {
    const workbench = buildFlowWorkbench(store, paramsId(request, "flowId"));
    if (!workbench) return reply.code(404).send({ detail: "Flow not found" });
    return workbench;
  });

  app.get("/api/flows/:flowId/orchestration-plans", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    if (!store.getFlow(flowId)) return reply.code(404).send({ detail: "Flow not found" });
    return planHistoryView(store, flowId);
  });

  app.get("/api/flows/:flowId/orchestration-plans/revisions/:revisionId", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const view = planRevisionView(store, paramsId(request, "revisionId"));
    if (!view || view.flow_id !== flowId) return reply.code(404).send({ detail: "Plan revision not found" });
    return view;
  });

  app.get("/api/flows/:flowId/orchestration-settings", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    return { plan_approval: store.getPlanApprovalMode(flow.id), rules: store.listOrchestrationRules({ flowId: flow.id, projectId: flow.projectId }) };
  });

  app.put("/api/flows/:flowId/orchestration-settings", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    const body = bodyRecord(request);
    const parsed = PlanApprovalSchema.safeParse(body.plan_approval);
    if (!parsed.success) return reply.code(400).send({ detail: "plan_approval must be on or off" });
    store.updateFlow(flow.id, { planApproval: parsed.data });
    return { plan_approval: store.getPlanApprovalMode(flow.id) };
  });

  app.post("/api/flows/:flowId/orchestration-rules", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    if (!flow) return reply.code(404).send({ detail: "Flow not found" });
    const body = bodyRecord(request);
    const parsed = DeclarativeOrchestrationRuleSchema.safeParse(body.rule);
    const severity = body.severity;
    if (!parsed.success || typeof body.name !== "string" || !["block", "warn", "info"].includes(String(severity))) {
      return reply.code(400).send({ detail: "Invalid declarative orchestration rule" });
    }
    return store.saveOrchestrationRule({
      scopeType: "flow", scopeId: flow.id, name: body.name.trim(),
      severity: severity as "block" | "warn" | "info", enabled: body.enabled !== false, rule: parsed.data,
    });
  });

  app.put("/api/flows/:flowId/orchestration-rules/:ruleId", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    const existing = store.listOrchestrationRules({ flowId: flow?.id, projectId: flow?.projectId }).find((row) => row.id === paramsId(request, "ruleId"));
    if (!flow || !existing || existing.scopeType !== "flow" || existing.scopeId !== flow.id) return reply.code(404).send({ detail: "Rule not found" });
    const body = bodyRecord(request);
    const parsed = DeclarativeOrchestrationRuleSchema.safeParse(body.rule);
    const severity = body.severity;
    if (!parsed.success || typeof body.name !== "string" || !["block", "warn", "info"].includes(String(severity))) return reply.code(400).send({ detail: "Invalid declarative orchestration rule" });
    return store.saveOrchestrationRule({ id: existing.id, scopeType: "flow", scopeId: flow.id, name: body.name.trim(), severity: severity as "block" | "warn" | "info", enabled: body.enabled !== false, rule: parsed.data });
  });

  app.delete("/api/flows/:flowId/orchestration-rules/:ruleId", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    const existing = store.listOrchestrationRules({ flowId: flow?.id, projectId: flow?.projectId }).find((row) => row.id === paramsId(request, "ruleId"));
    if (!flow || !existing || existing.scopeType !== "flow" || existing.scopeId !== flow.id) return reply.code(404).send({ detail: "Rule not found" });
    store.deleteOrchestrationRule(existing.id);
    return reply.code(204).send();
  });

  app.get("/api/flows/:flowId/agent-sessions", async (request) =>
    store.listAgentSessions(paramsId(request, "flowId")).map(agentSessionToApi)
  );

  app.get("/api/flows/:flowId/flow-experts", async (request) => {
    const flowId = paramsId(request, "flowId");
    store.projectLegacyFlowExperts(flowId);
    return store.listFlowExperts(flowId).map((row) => flowExpertToApi(store, row));
  });

  app.get("/api/flows/:flowId/files", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const query = isRecord(request.query) ? request.query : {};
    const requestedPath = typeof query.path === "string" ? query.path : "";
    const resolved = await resolveFlowWorkspacePath(store, flowId, requestedPath, true);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });

    let stat;
    try {
      stat = await fs.stat(resolved.target);
    } catch {
      return reply.code(404).send({ detail: "Workspace path not found" });
    }
    if (!stat.isDirectory()) return reply.code(400).send({ detail: "Path is not a directory" });

    let rawEntries;
    try {
      rawEntries = await fs.readdir(resolved.target, { withFileTypes: true });
    } catch {
      return reply.code(403).send({ detail: "Unable to read workspace directory" });
    }

    const visibleEntries = rawEntries
      .filter((entry) => !WORKSPACE_TREE_EXCLUDED_NAMES.has(entry.name) && !entry.isSymbolicLink())
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
      });
    const limitedEntries = visibleEntries.slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES);
    const basePath = resolved.relativePath.split(path.sep).join("/");
    const entries = await Promise.all(limitedEntries.map(async (entry) => {
      const entryPath = basePath ? path.posix.join(basePath, entry.name) : entry.name;
      const entryStat = await fs.stat(path.join(resolved.target, entry.name));
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "directory" : "file",
        has_children: entry.isDirectory(),
        size: entry.isFile() ? entryStat.size : null,
        modified_at: entryStat.mtime.toISOString(),
      };
    }));

    return {
      path: basePath,
      entries,
      truncated: visibleEntries.length > limitedEntries.length,
    };
  });

  app.delete("/api/flows/:flowId/files", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const query = isRecord(request.query) ? request.query : {};
    const requestedPath = typeof query.path === "string" ? query.path : "";
    const resolved = await resolveFlowWorkspacePath(store, flowId, requestedPath, false);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });

    try {
      await fs.rm(path.resolve(resolved.root, resolved.relativePath), { recursive: true });
    } catch {
      return reply.code(403).send({ detail: "Unable to delete workspace entry" });
    }
    return { deleted: requestedPath };
  });

  app.get("/api/flows/:flowId/file-preview", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const query = isRecord(request.query) ? request.query : {};
    const requestedPath = typeof query.path === "string" ? query.path : "";
    const resolved = await resolveFlowWorkspacePath(store, flowId, requestedPath, false);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });

    let stat;
    try {
      stat = await fs.stat(resolved.target);
    } catch {
      return reply.code(404).send({ detail: "File not found" });
    }
    if (!stat.isFile()) return reply.code(400).send({ detail: "Path is not a file" });
    if (stat.size > 1024 * 1024) return reply.code(413).send({ detail: "File exceeds 1 MiB preview limit" });

    const bytes = await fs.readFile(resolved.target);
    if (bytes.includes(0)) return reply.code(415).send({ detail: "Only UTF-8 text files can be previewed" });
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reply.code(415).send({ detail: "Only UTF-8 text files can be previewed" });
    }
    return { path: requestedPath, content };
  });
}

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { config, DEFAULT_PROJECT_ID } from "../config.js";
import {
  agentRuntimeConfigFilePath,
  createRuntimeConfig,
  deleteRuntimeConfig,
  readAgentRuntimeConfigSnapshot,
  readRuntimeConfig,
  runtimeSdkFromValue,
  updateRoleRuntimeBinding,
  updateRuntimeConfig,
  type AgentRuntimeRole,
} from "../config/agentRuntimeConfig.js";
import {
  checkRuntimeConfigLocalAuth,
  refreshRuntimeConfigModels,
  testRuntimeConfigConnection,
} from "../config/agentRuntimeConnectionTest.js";
import type { Store } from "../db/store.js";
import { buildFlowSnapshot } from "../domain/flowSnapshot.js";
import { normalizeFlowName } from "../domain/flowName.js";
import { buildFlowWorkbench } from "../domain/workbench.js";
import { orchestrationHistoryView, orchestrationRevisionView } from "../domain/orchestrationView.js";
import type { LeaderRuntime } from "../runtime/leaderRuntime.js";
import type { ContextCompactionState } from "../runtime/contextCompactionState.js";
import { resolveCodexRuntimeProfile } from "../runtime/adapters/codexRuntimeProfile.js";
import { discoverNativeContext } from "../runtime/nativeContextDiscovery.js";
import {
  defaultRuntimeReasoningEffortForSdk,
  normalizeRuntimeReasoningEffort,
  parseRuntimeReasoningEffort,
} from "../config/runtimeReasoningEffort.js";

type RegisterHttpRoutesDeps = {
  store: Store;
  leaderRuntime: Pick<LeaderRuntime, "compactContext">;
  contextCompactions: ContextCompactionState;
  onRuntimeConfigChanged?: () => void;
};

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJsonArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function paramsId(request: { params: unknown }, key: string) {
  return isRecord(request.params) ? stringValue(request.params[key]) : "";
}

function bodyRecord(request: { body: unknown }) {
  return isRecord(request.body) ? request.body : {};
}

function directoryName(localPath: string) {
  const normalized = localPath.replace(/[\\/]+$/u, "");
  return path.basename(normalized) || normalized;
}

async function validateProjectDirectory(localPath: string) {
  if (!path.isAbsolute(localPath)) return false;
  try { return (await fs.stat(localPath)).isDirectory(); } catch { return false; }
}

function validateProjectName(value: string) {
  const name = value.trim();
  return !name || name === "." || name === ".." || /[\\/\0]/u.test(name) ? null : name;
}

async function removeFlowRuntimeDirectories(flowId: string) {
  await fs.rm(path.join(config.runtimeScratchRoot, flowId), { recursive: true, force: true });
}

function projectToApi(row: ReturnType<Store["listProjects"]>[number]) {
  return {
    id: row.id,
    name: row.name,
    local_path: row.localPath,
    description: row.description ?? "",
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    is_default: row.id === DEFAULT_PROJECT_ID,
  };
}

function agentDefinitionToApi(row: ReturnType<Store["listAgentDefinitions"]>[number]) {
  return {
    agent_definition_id: row.id,
    role: row.role,
    name: row.name,
    person_name_candidates: parseJsonArray(row.personNameCandidates),
    system_prompt: row.systemPrompt,
    builtin_tools: parseJsonArray(row.builtinTools),
    mcp_tools: parseJsonArray(row.mcpTools),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function agentRunToApi(row: ReturnType<Store["listAgentRuns"]>[number]) {
  return {
    agent_run_id: row.id,
    flow_id: row.flowId,
    agent_session_id: row.agentSessionId,
    task_id: row.taskId,
    trigger_kind: row.triggerKind,
    trigger_message_id: row.triggerMessageId,
    status: row.status,
    error_message: row.errorMessage,
    created_at: row.createdAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    updated_at: row.updatedAt,
  };
}

function agentSessionToApi(store: Store, row: ReturnType<Store["listAgentSessions"]>[number]) {
  const runs = store.listAgentSessionRuns(row.id);
  const active = runs.find((run) => ["queued", "running", "waiting_tool_approval"].includes(run.status)) ?? null;
  return {
    agent_session_id: row.id,
    flow_id: row.flowId,
    agent_definition_id: row.agentDefinitionId,
    role: row.role,
    display_name: row.displayName,
    provider_session_id: row.providerSessionId,
    runtime_sdk: row.runtimeSdk,
    runtime_config_id: row.runtimeConfigId,
    runtime_model_id: row.runtimeModelId,
    runtime_reasoning_effort: row.runtimeReasoningEffort,
    active_agent_run_id: active?.id ?? null,
    latest_agent_run_id: runs.at(-1)?.id ?? null,
    status: active ? "active" : "idle",
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function runtimeConfigToApi(runtimeConfig: Awaited<ReturnType<typeof createRuntimeConfig>>) {
  return {
    ...runtimeConfig,
    filePath: agentRuntimeConfigFilePath(runtimeConfig.id),
    models: runtimeConfig.models.map((model) => ({
      ...model,
      contextWindowK: model.contextWindowK ?? null,
      metadataStatus: { contextWindow: typeof model.contextWindowK === "number" ? "available" : "unavailable" },
    })),
  };
}

function runtimeSnapshotToApi(snapshot: Awaited<ReturnType<typeof readAgentRuntimeConfigSnapshot>>) {
  return { ...snapshot, configs: snapshot.configs.map(runtimeConfigToApi) };
}

function contextUsageToApi(store: Store, flowId: string) {
  const snapshots = store.listAgentContextUsageSnapshots(flowId).map((snapshot) => {
    const session = snapshot.agentSessionId ? store.getAgentSession(snapshot.agentSessionId) : undefined;
    return {
      agent_run_id: snapshot.agentRunId,
      provider_session_id: snapshot.providerSessionId,
      role: snapshot.role,
      agent_definition_id: snapshot.agentDefinitionId,
      agent_session_id: snapshot.agentSessionId,
      display_name: session?.displayName ?? snapshot.role,
      total_tokens: snapshot.totalTokens,
      max_tokens: snapshot.maxTokens,
      raw_max_tokens: snapshot.rawMaxTokens,
      percentage: snapshot.percentage,
      model: snapshot.model,
      categories: parseJsonArray(snapshot.categoriesJson),
      cache_input_tokens: snapshot.cacheInputTokens,
      cache_read_input_tokens: snapshot.cacheReadInputTokens,
      cache_creation_input_tokens: snapshot.cacheCreationInputTokens,
      cache_hit_rate: snapshot.cacheHitRate,
      observed_at: snapshot.observedAt,
      compacted: snapshot.compacted === 1,
    };
  });
  return { leader: snapshots.find((snapshot) => snapshot.role === "leader") ?? null, experts: snapshots.filter((snapshot) => snapshot.role !== "leader") };
}

function flowToApi(store: Store, row: NonNullable<ReturnType<Store["getFlow"]>>) {
  const snapshot = buildFlowSnapshot(store, row.id);
  if ("error" in snapshot) return snapshot;
  const leader = store.getLeaderAgentSession(row.id);
  return {
    ...snapshot,
    type: "full",
    is_pinned: row.isPinned === 1,
    has_pending_user_action: snapshot.pending_user_actions.length > 0,
    last_output_completed_at: row.lastOutputCompletedAt,
    last_read_at: store.getFlowReadState(row.id)?.lastReadAt ?? null,
    leader_runtime_sdk: leader?.runtimeSdk ?? null,
    leader_runtime_config_id: leader?.runtimeConfigId ?? null,
    leader_runtime_model_id: leader?.runtimeModelId ?? null,
    leader_runtime_reasoning_effort: leader?.runtimeReasoningEffort ?? null,
  };
}

async function flowDetailToApi(store: Store, contextCompactions: ContextCompactionState, flow: NonNullable<ReturnType<Store["getFlow"]>>) {
  return {
    ...flowToApi(store, flow),
    context_usage: contextUsageToApi(store, flow.id),
    context_compactions: contextCompactions.listFlow(flow.id),
  };
}

async function defaultLeaderRuntimeSelection() {
  const snapshot = await readAgentRuntimeConfigSnapshot();
  const binding = snapshot.roles.find((role) => role.role === "leader");
  const runtimeConfig = snapshot.configs.find((candidate) => candidate.id === binding?.configId)
    ?? snapshot.configs.find((candidate) => candidate.models.some((model) => model.name.trim()))
    ?? null;
  const model = runtimeConfig?.models.find((candidate) => candidate.id === binding?.modelId)
    ?? runtimeConfig?.models.find((candidate) => candidate.name.trim())
    ?? null;
  return {
    runtimeSdk: runtimeConfig?.sdk ?? null,
    runtimeConfigId: runtimeConfig?.id ?? null,
    runtimeModelId: model?.id ?? null,
    runtimeReasoningEffort: runtimeConfig
      ? normalizeRuntimeReasoningEffort(runtimeConfig.sdk, binding?.reasoningEffort)
      : null,
  };
}

const WORKSPACE_TREE_EXCLUDED_NAMES = new Set([
  ".git", ".next", ".turbo", ".cache", ".pytest_cache", ".mypy_cache", ".playwright-cli",
  ".ruff_cache", ".venv", "node_modules", "__pycache__", "coverage", "dist", ".DS_Store",
]);
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 1000;

type WorkspacePathResolution =
  | { ok: true; root: string; target: string; relativePath: string }
  | { ok: false; statusCode: 400 | 403 | 404; detail: string };

async function resolveFlowWorkspacePath(store: Store, flowId: string, requestedPath: string, allowRoot: boolean): Promise<WorkspacePathResolution> {
  const flow = store.getFlow(flowId);
  if (!flow) return { ok: false, statusCode: 404, detail: "Flow not found" };
  if (path.isAbsolute(requestedPath)) return { ok: false, statusCode: 400, detail: "A relative workspace path is required" };
  if (!allowRoot && !requestedPath) return { ok: false, statusCode: 400, detail: "A relative file path is required" };
  const project = flow.projectId ? store.getProject(flow.projectId) : undefined;
  if (!project?.localPath) return { ok: false, statusCode: 404, detail: "Project root not found" };
  let root: string;
  try { root = await fs.realpath(project.localPath); } catch { return { ok: false, statusCode: 404, detail: "Project root not found" }; }
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
  } catch { return { ok: false, statusCode: 404, detail: "Workspace path not found" }; }
}

export function registerHttpRoutes(app: FastifyInstance, deps: RegisterHttpRoutesDeps) {
  const { store, leaderRuntime, contextCompactions } = deps;
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/system/select-directory", async (_request, reply) => {
    if (process.platform !== "darwin") return reply.code(501).send({ detail: "Directory picker is currently supported on macOS only" });
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择项目文件夹")']);
      const localPath = stdout.trim().replace(/\/$/u, "");
      return localPath ? { local_path: localPath, name: directoryName(localPath) } : reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("User canceled") || message.includes("-128")
        ? reply.code(204).send()
        : reply.code(500).send({ detail: "Unable to open directory picker" });
    }
  });

  app.get("/api/projects", async () => store.listProjects().map(projectToApi));
  app.post("/api/projects/new", async (request, reply) => {
    const name = validateProjectName(stringValue(bodyRecord(request).name));
    if (!name) return reply.code(400).send({ detail: "name must be a valid folder name" });
    const localPath = path.join(config.defaultProjectRoot, name);
    if (store.listProjects().some((project) => path.resolve(project.localPath) === path.resolve(localPath))) {
      return reply.code(409).send({ detail: "A project with this name already exists" });
    }
    await fs.mkdir(localPath, { recursive: false }).catch(async (error) => {
      if (!await validateProjectDirectory(localPath)) throw error;
    });
    const project = store.createProject({ name, localPath, description: "" });
    return reply.code(201).send(projectToApi(project));
  });
  app.post("/api/projects", async (request, reply) => {
    const body = bodyRecord(request);
    const localPath = stringValue(body.local_path).trim().replace(/\/$/u, "");
    if (!await validateProjectDirectory(localPath)) return reply.code(400).send({ detail: "local_path must be an existing absolute directory" });
    const existing = store.listProjects().find((project) => path.resolve(project.localPath) === path.resolve(localPath));
    if (existing) return projectToApi(existing);
    const project = store.createProject({ name: stringValue(body.name, directoryName(localPath)), localPath, description: stringValue(body.description) });
    return reply.code(201).send(projectToApi(project));
  });
  app.get("/api/projects/:projectId", async (request, reply) => {
    const project = store.getProject(paramsId(request, "projectId"));
    return project ? projectToApi(project) : reply.code(404).send({ detail: "Project not found" });
  });
  app.put("/api/projects/:projectId", async (request, reply) => {
    const body = bodyRecord(request);
    const localPath = typeof body.local_path === "string" ? body.local_path.trim().replace(/\/$/u, "") : undefined;
    if (localPath !== undefined && !await validateProjectDirectory(localPath)) return reply.code(400).send({ detail: "local_path must be an existing absolute directory" });
    const project = store.updateProject(paramsId(request, "projectId"), {
      name: typeof body.name === "string" ? body.name : undefined,
      localPath,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    return project ? projectToApi(project) : reply.code(404).send({ detail: "Project not found" });
  });
  app.delete("/api/projects/:projectId", async (request, reply) => {
    const projectId = paramsId(request, "projectId");
    if (projectId === DEFAULT_PROJECT_ID) return reply.code(409).send({ detail: "Default project cannot be deleted" });
    if (!store.getProject(projectId)) return reply.code(404).send({ detail: "Project not found" });
    for (const flow of store.listFlows(projectId)) {
      store.deleteFlow(flow.id);
      await removeFlowRuntimeDirectories(flow.id);
    }
    store.deleteProject(projectId);
    return reply.code(204).send();
  });

  app.get("/api/agent-definitions", async () => store.listAgentDefinitions().map(agentDefinitionToApi));
  app.get("/api/agent-runtime-config", async () => runtimeSnapshotToApi(await readAgentRuntimeConfigSnapshot()));
  app.get("/api/native-context", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const flowId = nullableString(query.flow_id);
    let configId = nullableString(query.config_id);
    let cwd: string | null = null;
    if (flowId) {
      const flow = store.getFlow(flowId);
      if (!flow) return reply.code(404).send({ detail: "Flow not found" });
      const leader = store.getLeaderAgentSession(flowId);
      configId ??= leader?.runtimeConfigId ?? null;
      cwd = flow.projectId ? store.getProject(flow.projectId)?.localPath ?? null : null;
    }
    if (!configId) return reply.code(400).send({ detail: "Runtime config is required" });
    const runtimeConfig = await readRuntimeConfig(configId);
    if (!runtimeConfig) return reply.code(404).send({ detail: "Runtime config not found" });
    return discoverNativeContext({
      sdk: runtimeConfig.sdk,
      cwd,
      includeProject: Boolean(flowId),
      codexHome: runtimeConfig.sdk === "codex" && runtimeConfig.authMode !== "inherited"
        ? resolveCodexRuntimeProfile().codexHome
        : undefined,
    });
  });
  app.post("/api/agent-runtime-config/configs", async (request, reply) => {
    try {
      const value = await createRuntimeConfig(bodyRecord(request));
      deps.onRuntimeConfigChanged?.();
      return reply.code(201).send(runtimeConfigToApi(value));
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.put("/api/agent-runtime-config/configs/:configId", async (request, reply) => {
    try {
      const value = await updateRuntimeConfig(paramsId(request, "configId"), bodyRecord(request));
      if (!value) return reply.code(404).send({ detail: "Runtime config not found" });
      deps.onRuntimeConfigChanged?.();
      return runtimeConfigToApi(value);
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete("/api/agent-runtime-config/configs/:configId", async (request, reply) => {
    try {
      const value = await deleteRuntimeConfig(paramsId(request, "configId"));
      if (!value) return reply.code(404).send({ detail: "Runtime config not found" });
      deps.onRuntimeConfigChanged?.();
      return runtimeSnapshotToApi(value);
    } catch (error) { return reply.code(409).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/agent-runtime-config/configs/:configId/test-connection", async (request, reply) => {
    try { return await testRuntimeConfigConnection(paramsId(request, "configId"), bodyRecord(request)); }
    catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/agent-runtime-config/configs/:configId/local-auth", async (request, reply) => {
    try { return await checkRuntimeConfigLocalAuth(paramsId(request, "configId"), bodyRecord(request)); }
    catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/agent-runtime-config/configs/:configId/available-models", async (request, reply) => {
    try { return await refreshRuntimeConfigModels(paramsId(request, "configId"), bodyRecord(request)); }
    catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });
  app.put("/api/agent-runtime-config/roles/:role", async (request, reply) => {
    try {
      const binding = await updateRoleRuntimeBinding(paramsId(request, "role") as AgentRuntimeRole, bodyRecord(request));
      return binding ?? reply.code(404).send({ detail: "Runtime role not found" });
    } catch (error) { return reply.code(400).send({ detail: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/flows", async (request) => {
    const query = isRecord(request.query) ? request.query : {};
    return store.listFlows(nullableString(query.project_id) ?? undefined).map((flow) => flowToApi(store, flow));
  });
  app.post("/api/flows", async (request, reply) => {
    const body = bodyRecord(request);
    const projectId = nullableString(body.project_id);
    if (!projectId || !store.getProject(projectId)) return reply.code(400).send({ detail: "project_id must reference an existing project" });
    const behaviorMode = body.behavior_mode === "plan" ? "plan" : "execute";
    const riskMode = body.risk_mode === "full_access" ? "full_access" : "auto_edit";
    const orchestrationMode = body.orchestration_mode === "automatic" ? "automatic" : "approval_required";
    const flow = store.createFlow({
      name: normalizeFlowName(stringValue(body.name, "新任务")),
      description: "",
      nameGenerationStatus: "pending",
      projectId,
      behaviorMode,
      riskMode,
      orchestrationMode,
    });
    if (!flow) return reply.code(500).send({ detail: "Unable to create Flow" });
    const leader = store.getLeaderAgentSession(flow.id);
    const defaults = await defaultLeaderRuntimeSelection();
    if (leader) store.configureAgentSessionRuntime(leader.id, {
      runtimeSdk: nullableString(body.leader_runtime_sdk) ?? defaults.runtimeSdk,
      runtimeConfigId: nullableString(body.leader_runtime_config_id) ?? defaults.runtimeConfigId,
      runtimeModelId: nullableString(body.leader_runtime_model_id) ?? defaults.runtimeModelId,
      runtimeReasoningEffort: nullableString(body.leader_runtime_reasoning_effort) ?? defaults.runtimeReasoningEffort,
    });
    return reply.code(201).send(flowToApi(store, flow));
  });
  app.delete("/api/flows", async (_request, reply) => {
    const flowIds = store.listFlows().map((flow) => flow.id);
    store.clearFlows();
    await Promise.all(flowIds.map(removeFlowRuntimeDirectories));
    return reply.code(204).send();
  });
  app.get("/api/flows/:flowId", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    return flow ? flowDetailToApi(store, contextCompactions, flow) : reply.code(404).send({ detail: "Flow not found" });
  });
  app.put("/api/flows/:flowId", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const current = store.getFlow(flowId);
    if (!current) return reply.code(404).send({ detail: "Flow not found" });
    const body = bodyRecord(request);
    const projectId = Object.prototype.hasOwnProperty.call(body, "project_id") ? nullableString(body.project_id) : undefined;
    if (projectId !== undefined && (!projectId || !store.getProject(projectId))) return reply.code(400).send({ detail: "Invalid project_id" });
    const behaviorMode = Object.prototype.hasOwnProperty.call(body, "behavior_mode")
      ? body.behavior_mode === "plan" ? "plan" : body.behavior_mode === "execute" ? "execute" : null
      : undefined;
    const riskMode = Object.prototype.hasOwnProperty.call(body, "risk_mode")
      ? body.risk_mode === "full_access" ? "full_access" : body.risk_mode === "auto_edit" ? "auto_edit" : null
      : undefined;
    const orchestrationMode = Object.prototype.hasOwnProperty.call(body, "orchestration_mode")
      ? body.orchestration_mode === "automatic" ? "automatic" : body.orchestration_mode === "approval_required" ? "approval_required" : null
      : undefined;
    if (behaviorMode === null || riskMode === null || orchestrationMode === null) return reply.code(400).send({ detail: "Invalid Flow mode" });
    const updated = store.updateFlow(flowId, {
      ...(typeof body.name === "string" ? { name: normalizeFlowName(body.name), nameGenerationStatus: "manual" as const } : {}),
      ...(projectId ? { projectId } : {}),
      ...(typeof body.is_pinned === "boolean" ? { isPinned: body.is_pinned } : {}),
      ...(behaviorMode ? { behaviorMode } : {}),
      ...(riskMode ? { riskMode } : {}),
      ...(orchestrationMode ? { orchestrationMode } : {}),
    });
    const leader = store.getLeaderAgentSession(flowId);
    if (leader && ["leader_runtime_sdk", "leader_runtime_config_id", "leader_runtime_model_id", "leader_runtime_reasoning_effort"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key))) {
      const configId = nullableString(body.leader_runtime_config_id) ?? leader.runtimeConfigId;
      const runtimeConfig = configId ? await readRuntimeConfig(configId) : null;
      const sdk = runtimeSdkFromValue(nullableString(body.leader_runtime_sdk) ?? runtimeConfig?.sdk ?? leader.runtimeSdk);
      const effortRaw = body.leader_runtime_reasoning_effort;
      const effort = effortRaw !== undefined && sdk
        ? parseRuntimeReasoningEffort(sdk, effortRaw)
        : leader.runtimeReasoningEffort ?? (sdk ? defaultRuntimeReasoningEffortForSdk(sdk) : null);
      if (effortRaw !== undefined && !effort) return reply.code(400).send({ detail: "Unsupported reasoning effort" });
      const configured = store.configureAgentSessionRuntime(leader.id, {
        runtimeSdk: sdk ?? null,
        runtimeConfigId: configId,
        runtimeModelId: nullableString(body.leader_runtime_model_id) ?? leader.runtimeModelId,
        runtimeReasoningEffort: effort,
      });
      if (!configured) return reply.code(409).send({ detail: "Leader AgentSession 正在运行或供应商上下文不允许切换 SDK" });
    }
    return flowToApi(store, updated!);
  });
  app.post("/api/flows/:flowId/read", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    if (!store.getFlow(flowId)) return reply.code(404).send({ detail: "Flow not found" });
    store.markFlowRead(flowId);
    return flowToApi(store, store.getFlow(flowId)!);
  });
  app.post("/api/flows/:flowId/context/compact", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    const leader = store.getLeaderAgentSession(flowId);
    if (!leader) return reply.code(404).send({ detail: "Flow not found" });
    if (store.getActiveAgentRun(leader.id)) return reply.code(409).send({ detail: "Leader AgentSession is active" });
    const snapshot = await leaderRuntime.compactContext(flowId);
    return { context_usage: contextUsageToApi(store, flowId), compacted: snapshot };
  });
  app.delete("/api/flows/:flowId", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    if (!store.deleteFlow(flowId)) return reply.code(404).send({ detail: "Flow not found" });
    await removeFlowRuntimeDirectories(flowId);
    return reply.code(204).send();
  });

  app.get("/api/flows/:flowId/tasks", async (request) => {
    const snapshot = buildFlowSnapshot(store, paramsId(request, "flowId"));
    return "error" in snapshot ? [] : snapshot.tasks;
  });
  app.get("/api/flows/:flowId/plan", async (request) => {
    const snapshot = buildFlowSnapshot(store, paramsId(request, "flowId"));
    return "error" in snapshot ? null : snapshot.plan;
  });
  app.get("/api/flows/:flowId/plan-revisions", async (request) => store.listPlanRevisions(paramsId(request, "flowId")));
  app.get("/api/flows/:flowId/artifacts", async (request) => store.listArtifacts(paramsId(request, "flowId")));
  app.get("/api/flows/:flowId/change-sets", async (request) => {
    const flowId = paramsId(request, "flowId");
    return store.listChangeSets(flowId).map((changeSet) => ({ ...changeSet, files: store.listChangeSetFiles(String(changeSet.id)) }));
  });
  app.post("/api/flows/:flowId/change-sets/:changeSetId/finalize", async (request, reply) => {
    const changeSet = store.getChangeSet(paramsId(request, "changeSetId")) as { flowId?: string } | undefined;
    if (!changeSet || changeSet.flowId !== paramsId(request, "flowId")) return reply.code(404).send({ detail: "ChangeSet not found" });
    return store.finalizeChangeSet(paramsId(request, "changeSetId"), bodyRecord(request)) ?? reply.code(409).send({ detail: "ChangeSet is not open" });
  });
  app.post("/api/flows/:flowId/change-sets/:changeSetId/abandon", async (request, reply) => {
    const changeSet = store.getChangeSet(paramsId(request, "changeSetId")) as { flowId?: string } | undefined;
    if (!changeSet || changeSet.flowId !== paramsId(request, "flowId")) return reply.code(404).send({ detail: "ChangeSet not found" });
    return store.abandonChangeSet(paramsId(request, "changeSetId")) ?? reply.code(409).send({ detail: "ChangeSet is not open" });
  });
  app.get("/api/flows/:flowId/workbench", async (request, reply) => {
    const workbench = buildFlowWorkbench(store, paramsId(request, "flowId"));
    return workbench ?? reply.code(404).send({ detail: "Flow not found" });
  });
  app.get("/api/flows/:flowId/orchestration-plans", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    return store.getFlow(flowId) ? orchestrationHistoryView(store, flowId) : reply.code(404).send({ detail: "Flow not found" });
  });
  app.get("/api/flows/:flowId/orchestration-plans/revisions/:revisionId", async (request, reply) => {
    const view = orchestrationRevisionView(store, paramsId(request, "revisionId"));
    return view && view.flow_id === paramsId(request, "flowId") ? view : reply.code(404).send({ detail: "Orchestration revision not found" });
  });
  app.get("/api/flows/:flowId/orchestration-settings", async (request, reply) => {
    const flow = store.getFlow(paramsId(request, "flowId"));
    return flow ? { orchestration_mode: flow.orchestrationMode } : reply.code(404).send({ detail: "Flow not found" });
  });
  app.put("/api/flows/:flowId/orchestration-settings", async (request, reply) => {
    const flowId = paramsId(request, "flowId");
    if (!store.getFlow(flowId)) return reply.code(404).send({ detail: "Flow not found" });
    const mode = bodyRecord(request).orchestration_mode;
    if (mode !== "approval_required" && mode !== "automatic") return reply.code(400).send({ detail: "Invalid orchestration_mode" });
    return { orchestration_mode: store.updateFlow(flowId, { orchestrationMode: mode })!.orchestrationMode };
  });
  app.get("/api/flows/:flowId/agent-runs", async (request) => store.listAgentRuns(paramsId(request, "flowId")).map(agentRunToApi));
  app.get("/api/flows/:flowId/agent-sessions", async (request) => store.listAgentSessions(paramsId(request, "flowId")).map((row) => agentSessionToApi(store, row)));

  app.get("/api/flows/:flowId/files", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const resolved = await resolveFlowWorkspacePath(store, paramsId(request, "flowId"), stringValue(query.path), true);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });
    const stat = await fs.stat(resolved.target);
    if (!stat.isDirectory()) return reply.code(400).send({ detail: "Path is not a directory" });
    const rawEntries = await fs.readdir(resolved.target, { withFileTypes: true });
    const visible = rawEntries.filter((entry) => !WORKSPACE_TREE_EXCLUDED_NAMES.has(entry.name) && !entry.isSymbolicLink())
      .sort((left, right) => left.isDirectory() === right.isDirectory()
        ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
        : left.isDirectory() ? -1 : 1);
    const limited = visible.slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES);
    const basePath = resolved.relativePath.split(path.sep).join("/");
    return {
      path: basePath,
      entries: await Promise.all(limited.map(async (entry) => {
        const entryStat = await fs.stat(path.join(resolved.target, entry.name));
        return {
          name: entry.name,
          path: basePath ? path.posix.join(basePath, entry.name) : entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          has_children: entry.isDirectory(),
          size: entry.isFile() ? entryStat.size : null,
          modified_at: entryStat.mtime.toISOString(),
        };
      })),
      truncated: visible.length > limited.length,
    };
  });
  app.delete("/api/flows/:flowId/files", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const requestedPath = stringValue(query.path);
    const resolved = await resolveFlowWorkspacePath(store, paramsId(request, "flowId"), requestedPath, false);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });
    await fs.rm(path.resolve(resolved.root, resolved.relativePath), { recursive: true });
    return { deleted: requestedPath };
  });
  app.get("/api/flows/:flowId/file-preview", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    const requestedPath = stringValue(query.path);
    const resolved = await resolveFlowWorkspacePath(store, paramsId(request, "flowId"), requestedPath, false);
    if (!resolved.ok) return reply.code(resolved.statusCode).send({ detail: resolved.detail });
    const stat = await fs.stat(resolved.target);
    if (!stat.isFile()) return reply.code(400).send({ detail: "Path is not a file" });
    if (stat.size > 1024 * 1024) return reply.code(413).send({ detail: "File exceeds 1 MiB preview limit" });
    const bytes = await fs.readFile(resolved.target);
    if (bytes.includes(0)) return reply.code(415).send({ detail: "Only UTF-8 text files can be previewed" });
    try { return { path: requestedPath, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch { return reply.code(415).send({ detail: "Only UTF-8 text files can be previewed" }); }
  });
}

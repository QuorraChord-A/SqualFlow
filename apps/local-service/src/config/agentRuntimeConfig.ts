import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { normalizeRuntimeModelContext } from "./runtimeModelContext.js";

export type AgentRuntimeRole = "leader" | "coder" | "research" | "verify" | "codereview";
export type RuntimeSdk = "claudecode" | "codex";
export type RuntimeAuthMode = "inherited" | "apiKey" | "accessToken";
export const legacySessionRuntimeSdk: RuntimeSdk = "claudecode";

export type RuntimeModelConfig = {
  id: string;
  name: string;
  contextWindowK?: number | null;
};

export type RuntimeConfig = {
  id: string;
  fileName: string;
  name: string;
  sdk: RuntimeSdk;
  authMode: RuntimeAuthMode;
  baseUrl: string;
  apiKey: string;
  models: RuntimeModelConfig[];
};

export type RoleRuntimeBinding = {
  role: AgentRuntimeRole;
  enabled: boolean;
  configId: string;
  modelId: string;
};

export type AgentRuntimeConfigSnapshot = {
  roles: RoleRuntimeBinding[];
  configs: RuntimeConfig[];
};

export type ResolvedRoleRuntimeConfig = {
  role: AgentRuntimeRole;
  binding: RoleRuntimeBinding;
  config: RuntimeConfig;
};

export type ResolvedFlowRuntimeConfig = {
  config: RuntimeConfig;
  configId: string;
  modelId: string;
};

type RuntimeConfigIndex = {
  version: 1;
  roles: Record<AgentRuntimeRole, Omit<RoleRuntimeBinding, "role">>;
};

const roleOrder: AgentRuntimeRole[] = ["leader", "coder", "research", "verify", "codereview"];
const configIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const obsoleteDefaultConfigIds = new Set(["backend-agent-sdk", "readonly-agent-sdk"]);
const legacySeedRuntimeConfigId = "default-agent-sdk";

const initialIndex: RuntimeConfigIndex = {
  version: 1,
  roles: {
    leader: { enabled: true, configId: "", modelId: "" },
    coder: { enabled: true, configId: "", modelId: "" },
    research: { enabled: false, configId: "", modelId: "" },
    verify: { enabled: true, configId: "", modelId: "" },
    codereview: { enabled: true, configId: "", modelId: "" },
  },
};

export function firstUsableRuntimeModelId(runtimeConfig: RuntimeConfig): string {
  return runtimeConfig.models.find((model) => model.name.trim())?.id ?? "";
}

export function resolveRuntimeModelId(runtimeConfig: RuntimeConfig, modelId: string | null | undefined): string {
  if (modelId && runtimeConfig.models.some((model) => model.id === modelId && model.name.trim())) return modelId;
  return firstUsableRuntimeModelId(runtimeConfig);
}

export function runtimeConfigModelName(runtimeConfig: RuntimeConfig, modelId: string | null | undefined): string | null {
  const model = runtimeConfigModel(runtimeConfig, modelId);
  return model ? model.name.trim() : null;
}

export function runtimeConfigModel(
  runtimeConfig: RuntimeConfig,
  modelId: string | null | undefined,
): RuntimeModelConfig | null {
  const model = modelId
    ? runtimeConfig.models.find((item) => item.id === modelId && item.name.trim())
    : undefined;
  return model ?? null;
}

export function runtimeRoleForExpertRole(role: string): AgentRuntimeRole {
  if (
    role === "coder"
    || role === "research"
    || role === "verify"
    || role === "codereview"
  ) return role;
  return "research";
}

export function isRuntimeRoleEnabled(roles: RoleRuntimeBinding[], role: AgentRuntimeRole) {
  if (role === "leader") return true;
  return roles.find((binding) => binding.role === role)?.enabled ?? false;
}

export function isExpertRuntimeEnabled(roles: RoleRuntimeBinding[], expertRole: string) {
  if (expertRole === "leader") return true;
  return isRuntimeRoleEnabled(roles, runtimeRoleForExpertRole(expertRole));
}

function rootDir() {
  return config.agentRuntimeConfigRoot;
}

function configsDir() {
  return path.join(rootDir(), "configs");
}

function indexPath() {
  return path.join(rootDir(), "index.json");
}

function configPath(configId: string) {
  assertConfigId(configId);
  return path.join(configsDir(), `${configId}.json`);
}

export function agentRuntimeConfigFilePath(configId: string) {
  return configPath(configId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function runtimeSdkFromValue(value: unknown): RuntimeSdk | null {
  if (value === "claudecode") return "claudecode";
  // Read-only compatibility for local configs written before the SDK name was corrected.
  if (value === "claudcode") return "claudecode";
  if (value === "codex") return "codex";
  return null;
}

function normalizeSdk(value: unknown): RuntimeSdk {
  if (value === undefined || value === null || value === "") return "claudecode";
  const sdk = runtimeSdkFromValue(value);
  if (sdk) return sdk;
  throw new Error(`Unsupported runtime sdk: ${String(value)}`);
}

function normalizeAuthMode(value: unknown, sdk: RuntimeSdk): RuntimeAuthMode {
  // Claude Code's official/local OAuth flow is intentionally not a
  // SquadFlow authentication mode. Old persisted values are migrated to the
  // API-key form so the UI cannot accidentally continue using local login.
  if (sdk === "claudecode") return "apiKey";
  if (value === "inherited" || value === "accessToken") return value;
  return "apiKey";
}

function assertSupportedAuthMode(sdk: RuntimeSdk, value: unknown) {
  if (
    sdk === "claudecode"
    && value !== undefined
    && value !== null
    && value !== ""
    && value !== "apiKey"
  ) {
    throw new Error("Claude Code 仅支持 API Key，不支持官方登录态或 Access Token");
  }
}

function assertConfigId(configId: string) {
  if (!configIdPattern.test(configId)) {
    throw new Error("config_id must contain only letters, numbers, hyphen, or underscore");
  }
}

function slugify(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function configNameKey(name: string) {
  return name.trim().replace(/\s+/g, "");
}

function normalizeConfigName(value: unknown, fallback: string) {
  return stringValue(value, fallback).trim();
}

function unnamedConfigName(configs: RuntimeConfig[]) {
  const existingNames = new Set(configs.map((item) => configNameKey(item.name)));
  let index = 1;
  while (existingNames.has(`未命名配置${index}`)) index += 1;
  return `未命名配置${index}`;
}

function assertUniqueConfigName(configs: RuntimeConfig[], name: string, currentConfigId?: string) {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("配置名称不能为空");
  if (/\s/.test(normalizedName)) throw new Error("配置名称不能包含空格");
  const key = configNameKey(normalizedName);
  const duplicate = configs.some((item) => item.id !== currentConfigId && configNameKey(item.name) === key);
  if (duplicate) throw new Error("配置名称不能重复");
  return normalizedName;
}

function preferredFallbackConfigId(configs: RuntimeConfig[]) {
  return configs[0]?.id ?? "";
}

function normalizeModels(
  value: unknown,
  sdk: RuntimeSdk,
  authMode: RuntimeAuthMode,
): RuntimeModelConfig[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = isRecord(item) ? item : {};
    const normalizedContext = normalizeRuntimeModelContext(
      sdk,
      authMode,
      stringValue(record.name),
      record.contextWindowK,
    );
    const name = normalizedContext.name;
    const id = stringValue(record.id, slugify(name, `model-${index + 1}`));
    return {
      id,
      name,
      ...(normalizedContext.contextWindowK === undefined
        ? {}
        : { contextWindowK: normalizedContext.contextWindowK }),
    };
  });
}

function normalizeRuntimeConfig(value: unknown, fallbackId: string): RuntimeConfig {
  const record = isRecord(value) ? value : {};
  const id = stringValue(record.id, fallbackId);
  assertConfigId(id);
  const fileName = stringValue(record.fileName, `${id}.json`);
  const sdk = normalizeSdk(record.sdk);
  const authMode = normalizeAuthMode(record.authMode, sdk);
  return {
    id,
    fileName: fileName.endsWith(".json") ? fileName : `${id}.json`,
    name: stringValue(record.name, id),
    sdk,
    authMode,
    baseUrl: stringValue(record.baseUrl),
    apiKey: stringValue(record.apiKey),
    models: normalizeModels(record.models, sdk, authMode),
  };
}

function isLegacySeedRuntimeConfig(value: unknown) {
  if (!isRecord(value) || value.id !== legacySeedRuntimeConfigId) return false;
  const models = Array.isArray(value.models) ? value.models : [];
  const expectedModels = [
    { id: "mimo-v25", name: "mimo-v2.5" },
    { id: "opus", name: "opus" },
  ];
  return value.fileName === `${legacySeedRuntimeConfigId}.json`
    && value.name === "项目claudecode配置"
    && value.sdk === "claudecode"
    && value.authMode === "apiKey"
    && stringValue(value.baseUrl) === ""
    && stringValue(value.apiKey) === ""
    && models.length === expectedModels.length
    && expectedModels.every((expected, index) => {
      const model = isRecord(models[index]) ? models[index] : {};
      return model.id === expected.id
        && model.name === expected.name
        && model.contextWindowK === 200;
    });
}

function normalizeIndex(value: unknown): RuntimeConfigIndex {
  const record = isRecord(value) ? value : {};
  const rolesRecord: Record<string, unknown> = isRecord(record.roles) ? { ...record.roles } : {};
  if (!isRecord(rolesRecord.coder)) {
    const legacyBinding = isRecord(rolesRecord.frontend)
      ? rolesRecord.frontend
      : (isRecord(rolesRecord.backend) ? rolesRecord.backend : undefined);
    if (legacyBinding) rolesRecord.coder = legacyBinding;
  }
  return {
    version: 1,
    roles: Object.fromEntries(roleOrder.map((role) => {
      const binding = isRecord(rolesRecord[role]) ? rolesRecord[role] : {};
      return [role, {
        enabled: role === "leader" ? true : booleanValue(binding.enabled, initialIndex.roles[role].enabled),
        configId: stringValue(binding.configId, initialIndex.roles[role].configId),
        modelId: stringValue(binding.modelId, initialIndex.roles[role].modelId),
      }];
    })) as RuntimeConfigIndex["roles"],
  };
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonSync(filePath: string): unknown | null {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureInitialized() {
  await fs.mkdir(configsDir(), { recursive: true });
  const storedIndex = await readJson(indexPath());
  const index = storedIndex === null ? initialIndex : normalizeIndex(storedIndex);
  const obsoleteConfigIds = new Set(obsoleteDefaultConfigIds);
  if (isLegacySeedRuntimeConfig(await readJson(configPath(legacySeedRuntimeConfigId)))) {
    obsoleteConfigIds.add(legacySeedRuntimeConfigId);
  }
  let indexChanged = storedIndex === null;
  for (const role of roleOrder) {
    if (obsoleteConfigIds.has(index.roles[role].configId)) {
      index.roles[role] = { ...index.roles[role], configId: "", modelId: "" };
      indexChanged = true;
    }
  }
  if (indexChanged) await writeJson(indexPath(), index);
  await Promise.all([...obsoleteConfigIds].map(async (configId) => {
    try {
      await fs.unlink(configPath(configId));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }));
}

async function readIndex() {
  await ensureInitialized();
  return normalizeIndex(await readJson(indexPath()));
}

async function writeIndex(index: RuntimeConfigIndex) {
  await writeJson(indexPath(), index);
}

async function readConfigs() {
  await ensureInitialized();
  const entries = await fs.readdir(configsDir(), { withFileTypes: true });
  const configs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const configId = entry.name.slice(0, -".json".length);
      const filePath = path.join(configsDir(), entry.name);
      const stat = await fs.stat(filePath);
      return {
        config: normalizeRuntimeConfig(await readJson(filePath), configId),
        createdAtMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs,
      };
    }));
  return configs
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.config.fileName.localeCompare(right.config.fileName))
    .map((entry) => entry.config);
}

function resolvedRoleBinding(
  role: AgentRuntimeRole,
  index: RuntimeConfigIndex,
  configs: RuntimeConfig[],
  fallbackConfigId: string,
): RoleRuntimeBinding {
  const configId = configs.some((item) => item.id === index.roles[role].configId)
    ? index.roles[role].configId
    : fallbackConfigId;
  const runtimeConfig = configs.find((item) => item.id === configId);
  return {
    role,
    enabled: role === "leader" ? true : index.roles[role].enabled,
    configId,
    modelId: runtimeConfig ? resolveRuntimeModelId(runtimeConfig, index.roles[role].modelId) : "",
  };
}

export async function readAgentRuntimeConfigSnapshot(): Promise<AgentRuntimeConfigSnapshot> {
  const [index, configs] = await Promise.all([readIndex(), readConfigs()]);
  const fallbackConfigId = preferredFallbackConfigId(configs);
  return {
    roles: roleOrder.map((role) => resolvedRoleBinding(role, index, configs, fallbackConfigId)),
    configs,
  };
}

export function readAgentRuntimeConfigSnapshotSync(): AgentRuntimeConfigSnapshot {
  const index = normalizeIndex(readJsonSync(indexPath()));
  const entries = fsSync.existsSync(configsDir()) ? fsSync.readdirSync(configsDir(), { withFileTypes: true }) : [];
  const configs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const configId = entry.name.slice(0, -".json".length);
      const filePath = path.join(configsDir(), entry.name);
      const stat = fsSync.statSync(filePath);
      return {
        config: normalizeRuntimeConfig(readJsonSync(filePath), configId),
        createdAtMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs,
      };
    })
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.config.fileName.localeCompare(right.config.fileName))
    .map((entry) => entry.config);
  const fallbackConfigId = preferredFallbackConfigId(configs);
  return {
    roles: roleOrder.map((role) => resolvedRoleBinding(role, index, configs, fallbackConfigId)),
    configs,
  };
}

export async function readRoleRuntimeConfig(
  role: AgentRuntimeRole,
  options: { requireEnabled?: boolean } = {},
): Promise<ResolvedRoleRuntimeConfig> {
  const snapshot = await readAgentRuntimeConfigSnapshot();
  const binding = snapshot.roles.find((item) => item.role === role);
  if (!binding) throw new Error(`Runtime role is not configured: ${role}`);
  if (options.requireEnabled !== false && !binding.enabled) {
    throw new Error(`Runtime role is disabled: ${role}`);
  }
  const runtimeConfig = snapshot.configs.find((item) => item.id === binding.configId);
  if (!runtimeConfig) throw new Error(`Runtime config is not found for role: ${role}`);
  return { role, binding, config: runtimeConfig };
}

export async function readFlowLeaderRuntimeConfig(input: {
  sdk?: string | null | undefined;
  configId: string | null | undefined;
  modelId: string | null | undefined;
}): Promise<ResolvedFlowRuntimeConfig | null> {
  const sdk = input.sdk === undefined ? null : runtimeSdkFromValue(input.sdk);
  const configId = input.configId?.trim();
  const modelId = input.modelId?.trim();
  if (!configId || !modelId) return null;
  const snapshot = await readAgentRuntimeConfigSnapshot();
  const runtimeConfig = snapshot.configs.find((item) => item.id === configId);
  if (!runtimeConfig) return null;
  if (sdk && runtimeConfig.sdk !== sdk) return null;
  const model = runtimeConfig.models.find((item) => item.id === modelId && item.name.trim());
  if (!model) return null;
  return { configId, modelId, config: runtimeConfig };
}

export async function readDefaultFlowRuntimeConfigForSdk(sdk: RuntimeSdk): Promise<ResolvedFlowRuntimeConfig | null> {
  const snapshot = await readAgentRuntimeConfigSnapshot();
  const runtimeConfig = snapshot.configs.find((item) =>
    item.sdk === sdk && item.models.some((model) => model.name.trim())
  ) ?? null;
  const model = runtimeConfig?.models.find((item) => item.name.trim()) ?? null;
  if (!runtimeConfig || !model) return null;
  return { configId: runtimeConfig.id, modelId: model.id, config: runtimeConfig };
}

export async function readRuntimeConfig(configId: string): Promise<RuntimeConfig | null> {
  assertConfigId(configId);
  const parsed = await readJson(configPath(configId));
  return parsed === null ? null : normalizeRuntimeConfig(parsed, configId);
}

export async function createRuntimeConfig(input: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  const configs = await readConfigs();
  const sdk = normalizeSdk(input.sdk);
  assertSupportedAuthMode(sdk, input.authMode);
  const id = randomUUID();
  const name = assertUniqueConfigName(configs, normalizeConfigName(input.name, unnamedConfigName(configs)));
  const nextConfig = normalizeRuntimeConfig({
    ...input,
    sdk,
    id,
    fileName: `${id}.json`,
    name,
    models: input.models?.length ? input.models : [{ id: `${id}-model-1`, name: "" }],
  }, id);
  await writeJson(configPath(id), nextConfig);
  return nextConfig;
}

export async function updateRuntimeConfig(configId: string, input: Partial<RuntimeConfig>): Promise<RuntimeConfig | null> {
  assertConfigId(configId);
  const existing = await readJson(configPath(configId));
  if (existing === null) return null;
  const configs = await readConfigs();
  const existingConfig = normalizeRuntimeConfig(existing, configId);
  const requestedSdk = (input as { sdk?: unknown }).sdk;
  if (requestedSdk !== undefined && requestedSdk !== null && requestedSdk !== "" && normalizeSdk(requestedSdk) !== existingConfig.sdk) {
    throw new Error("供应商的 Agent 类型创建后不可更改");
  }
  assertSupportedAuthMode(existingConfig.sdk, (input as { authMode?: unknown }).authMode);
  const name = assertUniqueConfigName(configs, normalizeConfigName(input.name, existingConfig.name), configId);
  const nextConfig = normalizeRuntimeConfig({
    ...existingConfig,
    ...input,
    id: configId,
    fileName: `${configId}.json`,
    name,
  }, configId);
  await writeJson(configPath(configId), nextConfig);
  return nextConfig;
}

export async function deleteRuntimeConfig(configId: string): Promise<AgentRuntimeConfigSnapshot | null> {
  assertConfigId(configId);
  const configs = await readConfigs();
  if (!configs.some((item) => item.id === configId)) return null;
  if (configs.length <= 1) throw new Error("at least one runtime config is required");
  await fs.unlink(configPath(configId));

  const remainingConfigs = configs.filter((item) => item.id !== configId);
  const fallbackConfigId = preferredFallbackConfigId(remainingConfigs);
  const fallbackConfig = remainingConfigs.find((item) => item.id === fallbackConfigId);
  const index = await readIndex();
  const nextIndex: RuntimeConfigIndex = {
    version: 1,
    roles: Object.fromEntries(roleOrder.map((role) => {
      const rebind = index.roles[role].configId === configId;
      return [role, {
        enabled: role === "leader" ? true : index.roles[role].enabled,
        configId: rebind ? fallbackConfigId : index.roles[role].configId,
        modelId: rebind
          ? (fallbackConfig ? firstUsableRuntimeModelId(fallbackConfig) : "")
          : index.roles[role].modelId,
      }];
    })) as RuntimeConfigIndex["roles"],
  };
  await writeIndex(nextIndex);
  return readAgentRuntimeConfigSnapshot();
}

export async function updateRoleRuntimeBinding(
  role: AgentRuntimeRole,
  input: Partial<Omit<RoleRuntimeBinding, "role">>,
): Promise<RoleRuntimeBinding | null> {
  if (!roleOrder.includes(role)) return null;
  const configs = await readConfigs();
  const index = await readIndex();
  const configId = typeof input.configId === "string" && input.configId
    ? input.configId
    : index.roles[role].configId;
  const runtimeConfig = configs.find((item) => item.id === configId);
  if (!runtimeConfig) {
    throw new Error("config_id must reference an existing runtime config");
  }
  const requestedModelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  if (requestedModelId && !runtimeConfig.models.some((item) => item.id === requestedModelId && item.name.trim())) {
    throw new Error("model_id must reference an existing model in the runtime config");
  }
  index.roles[role] = {
    enabled: role === "leader" ? true : booleanValue(input.enabled, index.roles[role].enabled),
    configId,
    modelId: requestedModelId || resolveRuntimeModelId(runtimeConfig, index.roles[role].modelId),
  };
  await writeIndex(index);
  return { role, ...index.roles[role] };
}

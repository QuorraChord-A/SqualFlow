import path from "node:path";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import { runtimeModelContextWindowK } from "../../config/runtimeModelContext.js";
import type { MessageImageAttachment } from "../../protocol/wsMessages.js";
import type { RuntimeCapability } from "../capabilities.js";
import {
  codexAppServerBaseArgs,
  codexPoolTempDir,
  resolveCodexRuntimeProfile,
  withCodexRuntimeProfileEnv,
  type CodexRuntimeProfile,
} from "./codexRuntimeProfile.js";
import type {
  BuildExpertRuntimeOptionsInput,
  BuildLeaderRuntimeOptionsInput,
  RuntimeDiagnosticSink,
  RuntimeToolPermission,
} from "./runtimeAdapter.js";

export type CodexRuntimeInput = {
  type: "text";
  text: string;
  flowId?: string;
  attachments?: MessageImageAttachment[];
  attachmentPlacement?: "inline" | "trailing";
} | {
  type: "compact";
};

export type CodexRuntimeOptions = {
  role: string;
  systemPrompt: string;
  cwd: string;
  model: string;
  modelProvider: string;
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  runtimeProfile: CodexRuntimeProfile;
  appServerCommand: string;
  ephemeral?: boolean;
  resume?: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  canUseTool?: RuntimeToolPermission;
  diagnostics?: RuntimeDiagnosticSink;
};

const MANAGED_SANDBOX_INSTRUCTIONS = [
  "SquadFlow 已提供受管理的工作区沙箱。调用命令工具时不得请求额外权限、不得关闭或绕过沙箱。",
  "禁止设置 sandbox_permissions=require_escalated 或任何等价的提权参数；风险确认由 SquadFlow 后端处理，请始终在现有沙箱内提交原始命令。",
].join("\n");

export function renderCodexTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function codexAppServerArgs(options: Pick<CodexRuntimeOptions, "config">): string[] {
  const profile = "runtimeProfile" in options && options.runtimeProfile
    ? options.runtimeProfile as CodexRuntimeProfile
    : resolveCodexRuntimeProfile();
  const args = codexAppServerBaseArgs(profile);
  for (const [key, value] of Object.entries(options.config)) {
    if (value === undefined || value === null || value === "") continue;
    args.push("-c", `${key}=${renderCodexTomlValue(value)}`);
  }
  return args;
}

function selectedModelName(runtimeConfig: RuntimeConfig | undefined): string {
  return runtimeConfig?.models.find((model) => model.name.trim())?.name.trim() || "";
}

function providerName(runtimeConfig: RuntimeConfig | undefined): string {
  return runtimeConfig?.id ? `squadflow-${runtimeConfig.id}` : "openai";
}

export const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export function normalizeCodexBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_OPENAI_API_BASE_URL;
  return trimmed.endsWith("/responses") ? trimmed.slice(0, -"/responses".length) : trimmed;
}

const CODEX_TRANSPORT_DEBUG_ENV = "SQUADFLOW_CODEX_TRANSPORT_DEBUG";
const CODEX_TRANSPORT_LOG_FILTER = "codex_api=debug,codex_http_client=debug,codex_app_server_transport=debug";
const CODEX_MODEL_CATALOG_LOG_FILTER = "codex_models_manager=info";
const CODEX_DEFAULT_LOG_FILTER = "warn";

function withCodexModelCatalogLogging(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const current = env.RUST_LOG?.trim();
  if (current?.split(",").some((directive) => directive.trim().startsWith("codex_models_manager="))) {
    return env;
  }
  return {
    ...env,
    RUST_LOG: current
      ? `${current},${CODEX_MODEL_CATALOG_LOG_FILTER}`
      : `${CODEX_DEFAULT_LOG_FILTER},${CODEX_MODEL_CATALOG_LOG_FILTER}`,
  };
}

function withCodexTransportDebug(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const diagnosticEnv = withCodexModelCatalogLogging(env);
  if (diagnosticEnv[CODEX_TRANSPORT_DEBUG_ENV]?.trim() !== "1") return diagnosticEnv;
  const current = diagnosticEnv.RUST_LOG?.trim();
  return {
    ...diagnosticEnv,
    RUST_LOG: current ? `${current},${CODEX_TRANSPORT_LOG_FILTER}` : CODEX_TRANSPORT_LOG_FILTER,
  };
}

function codexEnv(runtimeConfig: RuntimeConfig | undefined): NodeJS.ProcessEnv {
  const env = withLocalhostNoProxy({ ...process.env });
  if (!runtimeConfig) return withCodexTransportDebug(env);
  if (runtimeConfig.authMode === "inherited") {
    delete env.CODEX_ACCESS_TOKEN;
    delete env.OPENAI_API_KEY;
    return withCodexTransportDebug(env);
  }
  if (runtimeConfig.authMode === "apiKey") {
    const keyName = codexApiKeyEnvName(runtimeConfig);
    const apiKey = runtimeConfig.apiKey.trim();
    if (apiKey) env[keyName] = apiKey;
  } else if (runtimeConfig.authMode === "accessToken") {
    const accessToken = runtimeConfig.apiKey.trim();
    if (accessToken) env.CODEX_ACCESS_TOKEN = accessToken;
  }
  return withCodexTransportDebug(env);
}

function withLocalhostNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env.NO_PROXY?.trim() || env.no_proxy?.trim() || "";
  if (existing === "*") {
    env.NO_PROXY = existing;
    env.no_proxy = existing;
    return env;
  }
  const entries = existing.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const localHost of ["127.0.0.1", "localhost", "::1"]) {
    if (!entries.includes(localHost)) entries.push(localHost);
  }
  const value = entries.join(",");
  env.NO_PROXY = value;
  env.no_proxy = value;
  return env;
}

export function codexApiKeyEnvName(runtimeConfig: RuntimeConfig): string {
  return `SQUADFLOW_CODEX_API_KEY_${runtimeConfig.id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

function providerConfig(runtimeConfig: RuntimeConfig | undefined): Record<string, unknown> {
  if (!runtimeConfig || runtimeConfig.authMode === "inherited") return {};
  if (runtimeConfig.authMode === "accessToken") return {};
  const baseUrl = normalizeCodexBaseUrl(runtimeConfig.baseUrl);
  const envKey = codexApiKeyEnvName(runtimeConfig);
  return {
    [`model_providers.${providerName(runtimeConfig)}.name`]: providerName(runtimeConfig),
    [`model_providers.${providerName(runtimeConfig)}.base_url`]: baseUrl,
    [`model_providers.${providerName(runtimeConfig)}.wire_api`]: "responses",
    [`model_providers.${providerName(runtimeConfig)}.env_key`]: envKey,
    [`model_providers.${providerName(runtimeConfig)}.supports_websockets`]: false,
    [`model_providers.${providerName(runtimeConfig)}.stream_max_retries`]: 0,
  };
}

function sandboxMode(capabilities: RuntimeCapability[]): CodexRuntimeOptions["sandboxMode"] {
  return capabilities.some((capability) => capability === "write" || capability === "edit")
    ? "workspace-write"
    : "read-only";
}

type CodexRuntimeConfigOverrides = {
  reasoningEffort?: string | null;
};

function reasoningEffortConfig(runtimeConfig: RuntimeConfig | undefined, ephemeral = false): Record<string, unknown> {
  // The Flow Namer gets an explicit per-turn `none` effort below. Do not leave
  // the main Flow's configured effort in the thread-level config, otherwise it
  // would be inherited before the one-shot override is applied.
  if (ephemeral) return {};
  const effort = (runtimeConfig as (RuntimeConfig & CodexRuntimeConfigOverrides) | undefined)?.reasoningEffort?.trim();
  if (runtimeConfig?.sdk !== "codex" || !effort) return {};
  return { model_reasoning_effort: effort };
}

type HttpMcpServerConfig = { url?: unknown; bearerTokenEnvVar?: unknown; bearerToken?: unknown };

function configureHttpMcpServer(
  options: CodexRuntimeOptions,
  serverName: string,
  rawConfig: unknown,
  defaultEnvVar: string,
) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as HttpMcpServerConfig : null;
  if (!config?.url || typeof config.url !== "string") return;
  const envVar = typeof config.bearerTokenEnvVar === "string" ? config.bearerTokenEnvVar : defaultEnvVar;
  options.config[`mcp_servers.${serverName}.url`] = config.url;
  options.config[`mcp_servers.${serverName}.bearer_token_env_var`] = envVar;
  if (typeof config.bearerToken === "string") options.env[envVar] = config.bearerToken;
}

function modelAutoCompactTokenLimit(contextWindow: number): number {
  return Math.max(100_000, Math.floor(contextWindow * 0.8));
}

function baseOptions(input: BuildLeaderRuntimeOptionsInput | BuildExpertRuntimeOptionsInput): CodexRuntimeOptions {
  const runtimeConfig = input.runtimeConfig;
  const runtimeProfile = resolveCodexRuntimeProfile(process.env, {
    preferExternal: runtimeConfig?.authMode === "inherited",
  });
  const model = input.modelName?.trim() || selectedModelName(runtimeConfig);
  const modelProvider = runtimeConfig?.authMode === "inherited" ? "openai" : providerName(runtimeConfig);
  const contextWindowK = runtimeConfig?.authMode === "inherited"
    ? null
    : runtimeModelContextWindowK(runtimeConfig, model);
  const contextWindow = contextWindowK === null ? null : Math.round(contextWindowK * 1_000);
  const scratchDir = input.scratchDir ? path.resolve(input.scratchDir) : null;
  const isLeader = input.role === "leader";
  const env = withCodexRuntimeProfileEnv(codexEnv(runtimeConfig), runtimeProfile);
  if (scratchDir) {
    env.TMPDIR = scratchDir;
    env.TMP = scratchDir;
    env.TEMP = scratchDir;
  }
  return {
    role: input.role,
    systemPrompt: `${input.systemPrompt}\n\n${MANAGED_SANDBOX_INSTRUCTIONS}`,
    cwd: input.cwd,
    model,
    modelProvider,
    config: {
      ...providerConfig(runtimeConfig),
      ...reasoningEffortConfig(runtimeConfig, "ephemeral" in input && input.ephemeral === true),
      ...("ephemeral" in input && input.ephemeral === true ? { mcp_servers: {} } : {}),
      // SquadFlow owns Leader/Expert coordination. Keep Codex's native
      // multi-agent collaboration tools out of the Leader tool world so it
      // cannot wait for a different orchestration system (for example,
      // collaboration.wait_agent) instead of consuming SqualFlow results.
      ...(isLeader ? { "features.multi_agent": false } : {}),
      model,
      model_provider: modelProvider,
      web_search: "disabled",
      ...(contextWindow === null ? {} : {
        model_context_window: contextWindow,
        model_auto_compact_token_limit: modelAutoCompactTokenLimit(contextWindow),
      }),
      "sandbox_workspace_write.exclude_tmpdir_env_var": true,
      "sandbox_workspace_write.exclude_slash_tmp": !isLeader,
      "sandbox_workspace_write.writable_roots": [
        path.resolve(input.cwd),
        ...(scratchDir ? [scratchDir] : []),
        codexPoolTempDir(runtimeConfig?.authMode === "inherited" ? "official" : "custom"),
        ...(isLeader ? ["/tmp"] : []),
      ],
    },
    env,
    runtimeProfile,
    appServerCommand: runtimeProfile.command,
    ...('ephemeral' in input && input.ephemeral === true ? { ephemeral: true } : {}),
    resume: input.resume,
    sandboxMode: sandboxMode(input.capabilities),
    canUseTool: input.canUseTool,
    diagnostics: input.diagnostics,
  };
}

export function buildCodexLeaderOptions(input: BuildLeaderRuntimeOptionsInput): CodexRuntimeOptions {
  const options = baseOptions(input);
  configureHttpMcpServer(
    options,
    "squadflow-leader",
    input.mcpServerConfigs?.["squadflow-leader"],
    "SQUADFLOW_LEADER_MCP_TOKEN",
  );
  if (options.runtimeProfile.id === "external-modern") {
    configureHttpMcpServer(
      options,
      "squadflow-browser",
      input.mcpServerConfigs?.["squadflow-browser"],
      "SQUADFLOW_BROWSER_MCP_TOKEN",
    );
  }
  return options;
}

export function buildCodexExpertOptions(input: BuildExpertRuntimeOptionsInput): CodexRuntimeOptions {
  const options = baseOptions(input);
  for (const [serverName, serverConfig] of Object.entries(input.mcpServerConfigs ?? {})) {
    configureHttpMcpServer(options, serverName, serverConfig, "SQUADFLOW_MCP_BRIDGE_TOKEN");
  }
  return {
    ...options,
    sandboxMode: sandboxMode(input.capabilities),
    config: options.config,
  };
}

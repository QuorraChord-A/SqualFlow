import fs from "node:fs";
import path from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import { config, getAgentSettingsPath, type AgentConfigRole } from "../../config.js";
import type { AgentRuntimeRole, RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import {
  claudeRuntimeModelName,
  runtimeModelContextWindowK,
} from "../../config/runtimeModelContext.js";
import { parseRuntimeReasoningEffort } from "../codexReasoningEffort.js";
import type { RuntimeToolPermission } from "./runtimeAdapter.js";
import type { RuntimeToolInput } from "../capabilities.js";
import { claudeCapabilityForTool, claudeToolsForCapabilities } from "./claudeCapabilities.js";
import type { BuildExpertRuntimeOptionsInput, BuildLeaderRuntimeOptionsInput } from "./runtimeAdapter.js";

type BuildClaudeBaseOptionsInput = {
  systemPrompt: string;
  cwd: string;
  scratchDir?: string;
  allowedTools: string[];
  tools: string[];
  settingsPath: string;
  additionalDirectories?: string[];
  mcpServers?: Options["mcpServers"];
  canUseTool?: Options["canUseTool"];
  disallowedTools?: string[];
  maxTurns?: number;
  ephemeral?: boolean;
  resume?: string;
  sessionId?: string;
  runtimeConfig?: RuntimeConfig & { reasoningEffort?: string | null };
  modelName?: string;
  pathToClaudeCodeExecutable?: string;
};

const permissionGatedClaudeTools = new Set(["Write", "Edit", "Bash"]);

function legacySettingsRoleForRuntimeRole(role: AgentRuntimeRole): AgentConfigRole {
  if (role === "leader" || role === "coder" || role === "research") return role;
  return "expert";
}

function readSettingsFile(settingsPath: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Claude settings file must contain a JSON object: ${settingsPath}`);
  }
  return parsed as Settings;
}

function selectedModelName(runtimeConfig: RuntimeConfig | undefined): string | undefined {
  const modelName = runtimeConfig?.models.find((model) => model.name.trim())?.name.trim();
  return modelName || undefined;
}

function buildRuntimeEnv(
  runtimeConfig: RuntimeConfig | undefined,
  modelName: string | undefined,
  contextWindowK: number | null | undefined,
): Options["env"] | undefined {
  if (!runtimeConfig && !modelName) return undefined;
  const env: Record<string, string> = {};
  if (runtimeConfig?.authMode === "apiKey") {
    const apiKey = runtimeConfig.apiKey.trim();
    const baseUrl = runtimeConfig.baseUrl.trim();
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (modelName) env.ANTHROPIC_MODEL = modelName;
  if (runtimeConfig?.sdk === "claudecode" && contextWindowK !== undefined && contextWindowK !== null) {
    if (contextWindowK !== 1_000) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function inheritedProcessEnv(): NodeJS.ProcessEnv {
  // Anthropic auth and routing must come from app configuration only. The launching
  // environment may carry these vars (e.g. a terminal session), and Claude Code
  // prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY, so a leaked token would
  // silently override the configured key.
  const {
    ANTHROPIC_API_KEY: _apiKey,
    ANTHROPIC_AUTH_TOKEN: _authToken,
    ANTHROPIC_BASE_URL: _baseUrl,
    ANTHROPIC_MODEL: _model,
    ...rest
  } = process.env;
  return rest;
}

function buildInlineSettings(
  settingsPath: string,
  runtimeConfig?: RuntimeConfig,
  explicitModelName?: string,
  scratchDir?: string,
): { settings: Settings; env?: Options["env"]; model?: string } {
  const parsedSettings = readSettingsFile(settingsPath);
  const { env: settingsEnv, ...settingsWithoutEnv } = parsedSettings;
  const configuredModelName = explicitModelName?.trim()
    || selectedModelName(runtimeConfig)
    || (typeof settingsWithoutEnv.model === "string" ? settingsWithoutEnv.model : undefined);
  const contextWindowK = runtimeConfig && configuredModelName
    ? runtimeModelContextWindowK(runtimeConfig, configuredModelName)
    : undefined;
  const modelName = configuredModelName && contextWindowK !== undefined
    ? claudeRuntimeModelName(configuredModelName, contextWindowK)
    : configuredModelName;
  const runtimeEnv = buildRuntimeEnv(runtimeConfig, modelName, contextWindowK);
  const env: Options["env"] = {
    ...inheritedProcessEnv(),
    ...settingsEnv,
    ...runtimeEnv,
    ...(scratchDir ? {
      CLAUDE_CODE_TMPDIR: path.resolve(scratchDir),
      TMPDIR: path.resolve(scratchDir),
      TMP: path.resolve(scratchDir),
      TEMP: path.resolve(scratchDir),
    } : {}),
  };
  if (contextWindowK === 1_000) delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  return {
    settings: {
      ...settingsWithoutEnv,
      ...(modelName ? { model: modelName } : {}),
      sandbox: {
        ...settingsWithoutEnv.sandbox,
        enabled: false,
      },
    },
    env,
    model: modelName,
  };
}

function normalizeCanUseTool(canUseTool: Options["canUseTool"]): Options["canUseTool"] {
  if (!canUseTool) return undefined;
  return async (toolName, input, options) => {
    const result = await canUseTool(toolName, input, options);
    if (result.behavior === "allow" && result.updatedInput === undefined) {
      return { ...result, updatedInput: input };
    }
    return result;
  };
}

export function buildClaudeBaseOptions(input: BuildClaudeBaseOptionsInput): Options {
  const inlineSettings = buildInlineSettings(input.settingsPath, input.runtimeConfig, input.modelName, input.scratchDir);
  return {
    systemPrompt: input.systemPrompt,
    cwd: input.cwd,
    additionalDirectories: input.additionalDirectories ?? [],
    allowedTools: input.allowedTools,
    tools: input.tools,
    disallowedTools: input.disallowedTools ?? [],
    permissionMode: "default",
    canUseTool: normalizeCanUseTool(input.canUseTool),
    mcpServers: input.mcpServers ?? {},
    settings: inlineSettings.settings,
    env: inlineSettings.env,
    model: inlineSettings.model,
    settingSources: [],
    includePartialMessages: true,
    maxTurns: input.maxTurns,
    ...(input.ephemeral === true ? {
      // Flow Namer is a one-shot extraction request. Keep it fast and do not
      // spend tokens on extended thinking; normal Leader turns keep their
      // configured effort unchanged.
      persistSession: false,
      thinking: { type: "disabled" },
    } : {}),
    resume: input.resume,
    sessionId: input.sessionId,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    ...(input.ephemeral !== true && parseRuntimeReasoningEffort("claudecode", input.runtimeConfig?.reasoningEffort)
      ? { effort: parseRuntimeReasoningEffort("claudecode", input.runtimeConfig?.reasoningEffort) as Options["effort"] }
      : {}),
  };
}

function toClaudeCanUseTool(canUseTool: RuntimeToolPermission | undefined): Options["canUseTool"] {
  if (!canUseTool) return undefined;
  return async (toolName, input, options) => canUseTool({
    capability: claudeCapabilityForTool(toolName),
    providerToolName: toolName,
    input: claudeToolInput(toolName, input),
    providerInput: input,
    context: {
      toolUseId: options.toolUseID ?? null,
    },
  });
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function claudeToolInput(toolName: string, input: Record<string, unknown>): RuntimeToolInput {
  if (toolName === "Bash") return { command: stringField(input, "command") };
  if (toolName === "WebSearch") return { query: stringField(input, "query") };
  if (toolName === "Glob" || toolName === "Grep") {
    return {
      path: stringField(input, "path"),
      query: stringField(input, "query") ?? stringField(input, "pattern"),
    };
  }
  return { path: stringField(input, "file_path") ?? stringField(input, "path") };
}

export function buildClaudeLeaderOptions(input: BuildLeaderRuntimeOptionsInput): Options {
  const builtinTools = claudeToolsForCapabilities(input.capabilities);
  const mcpServers = input.mcpServerConfigs as Options["mcpServers"] | undefined;

  return buildClaudeBaseOptions({
    systemPrompt: input.systemPrompt,
    cwd: input.cwd,
    scratchDir: input.scratchDir,
    // Leader 内置工具不进 allowedTools 预授权名单：预授权会跳过 canUseTool，
    // 而 Leader 的路径守卫（checkLeaderToolPath）依赖 canUseTool 对每次调用生效。
    allowedTools: [...input.mcpTools],
    tools: builtinTools,
    disallowedTools: [],
    settingsPath: getAgentSettingsPath("leader"),
    additionalDirectories: [path.parse(input.cwd).root],
    canUseTool: toClaudeCanUseTool(input.canUseTool),
    maxTurns: input.maxTurns,
    ephemeral: input.ephemeral,
    resume: input.resume,
    sessionId: input.resume ? undefined : input.sessionId,
    mcpServers: mcpServers ?? {},
    runtimeConfig: input.runtimeConfig,
    modelName: input.modelName,
    pathToClaudeCodeExecutable: config.claudeCodeExecutable,
  });
}

export function buildClaudeExpertOptions(input: BuildExpertRuntimeOptionsInput): Options {
  const builtinTools = claudeToolsForCapabilities(input.capabilities);
  const authorizedToolSet = new Set([...builtinTools, ...input.mcpTools]);
  const allowedTools = [...builtinTools, ...input.mcpTools].filter((tool) => !permissionGatedClaudeTools.has(tool));
  const disallowedTools = [...permissionGatedClaudeTools].filter((tool) => !authorizedToolSet.has(tool));
  const mcpServerConfig = input.mcpServerConfig as NonNullable<Options["mcpServers"]>[string] | undefined;

  return buildClaudeBaseOptions({
    systemPrompt: input.systemPrompt,
    cwd: input.cwd,
    scratchDir: input.scratchDir,
    additionalDirectories: [],
    allowedTools,
    tools: builtinTools,
    disallowedTools,
    settingsPath: getAgentSettingsPath(legacySettingsRoleForRuntimeRole(input.role)),
    canUseTool: toClaudeCanUseTool(input.canUseTool),
    maxTurns: input.maxTurns,
    resume: input.resume,
    mcpServers: mcpServerConfig ? { "squadflow-browser": mcpServerConfig } : {},
    runtimeConfig: input.runtimeConfig,
    modelName: input.modelName,
    pathToClaudeCodeExecutable: config.claudeCodeExecutable,
  });
}

export const claudeOptionsTestExports = {
  buildClaudeBaseOptions,
};

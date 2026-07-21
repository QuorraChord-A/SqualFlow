import type { RuntimeConfig } from "./agentRuntimeConfig.js";
import { readRuntimeConfig } from "./agentRuntimeConfig.js";
import {
  normalizeRuntimeModelContext,
  refreshedRuntimeModelContextWindowK,
  stripClaudeExtendedContextSuffix,
} from "./runtimeModelContext.js";
import {
  detectRuntimeLocalAuth,
  type RuntimeLocalAuthResult,
} from "../runtime/localRuntimeAuth.js";
import {
  testAgentRuntimeConnection,
  type AgentRuntimeConnectionTestInput,
  type AgentRuntimeConnectionTestResult,
} from "../runtime/adapters/runtimeConnectionTest.js";
import { listCodexRuntimeModels } from "../runtime/adapters/codexModelList.js";
import {
  discoverRuntimeModels,
  runtimeModelMetadataWarnings,
  type RuntimeModelDiscoveryResult,
} from "../runtime/modelDiscovery.js";

export type { AgentRuntimeConnectionTestResult };
export type { RuntimeLocalAuthResult };

type TestConnectionInput = AgentRuntimeConnectionTestInput;

export function mergeRefreshedRuntimeModels(
  runtimeConfig: Pick<RuntimeConfig, "sdk" | "models">,
  models: RuntimeConfig["models"],
): RuntimeConfig["models"] {
  return models.map((model) => {
    const normalizedName = runtimeConfig.sdk === "claudecode"
      ? stripClaudeExtendedContextSuffix(model.name)
      : model.name.trim();
    const previous = runtimeConfig.models.find((item) => {
      const previousName = runtimeConfig.sdk === "claudecode"
        ? stripClaudeExtendedContextSuffix(item.name)
        : item.name.trim();
      return previousName === normalizedName;
    });
    return {
      id: model.id,
      name: normalizedName,
      contextWindowK: refreshedRuntimeModelContextWindowK(
        runtimeConfig.sdk,
        model.contextWindowK,
        previous?.contextWindowK,
      ),
    };
  });
}

function normalizedTestModels(
  runtimeConfig: Pick<RuntimeConfig, "sdk" | "authMode">,
  models: RuntimeConfig["models"],
): RuntimeConfig["models"] {
  return models.map((model, index) => {
    const { contextWindowK: _contextWindowK, ...modelWithoutContext } = model;
    const normalizedContext = normalizeRuntimeModelContext(
      runtimeConfig.sdk,
      runtimeConfig.authMode,
      model.name ?? "",
      model.contextWindowK,
    );
    return {
      ...modelWithoutContext,
      id: model.id || `model-${index + 1}`,
      name: normalizedContext.name,
      ...(normalizedContext.contextWindowK === undefined
        ? {}
        : { contextWindowK: normalizedContext.contextWindowK }),
    };
  });
}

function draftRuntimeConfig(configId: string, input: TestConnectionInput): RuntimeConfig | null {
  const patch = input.config;
  if (!patch) return null;
  const runtimeConfig: RuntimeConfig = {
    id: configId,
    fileName: patch.fileName ?? `${configId}.json`,
    name: patch.name ?? configId,
    sdk: patch.sdk ?? "claudecode",
    authMode: patch.authMode ?? "apiKey",
    baseUrl: patch.baseUrl ?? "",
    apiKey: patch.apiKey ?? "",
    models: [],
  };
  if (runtimeConfig.sdk === "claudecode" && runtimeConfig.authMode !== "apiKey") {
    throw new Error("Claude Code 仅支持 API Key，不支持官方登录态或 Access Token");
  }
  return {
    ...runtimeConfig,
    models: normalizedTestModels(runtimeConfig, Array.isArray(patch.models) ? patch.models : []),
  };
}

function mergeTestConfig(storedConfig: RuntimeConfig, input: TestConnectionInput): RuntimeConfig {
  const patch = input.config ?? {};
  const runtimeConfig: RuntimeConfig = {
    ...storedConfig,
    ...patch,
    id: storedConfig.id,
    fileName: storedConfig.fileName,
    models: [],
  };
  if (runtimeConfig.sdk === "claudecode" && runtimeConfig.authMode !== "apiKey") {
    throw new Error("Claude Code 仅支持 API Key，不支持官方登录态或 Access Token");
  }
  return {
    ...runtimeConfig,
    models: normalizedTestModels(
      runtimeConfig,
      Array.isArray(patch.models) ? patch.models : storedConfig.models,
    ),
  };
}

export async function testRuntimeConfigConnection(
  configId: string,
  input: TestConnectionInput = {},
): Promise<AgentRuntimeConnectionTestResult> {
  const storedConfig = await readRuntimeConfig(configId);
  const runtimeConfig = storedConfig
    ? mergeTestConfig(storedConfig, input)
    : draftRuntimeConfig(configId, input);
  if (!runtimeConfig) throw new Error("Runtime config not found");
  return testAgentRuntimeConnection(runtimeConfig, input);
}

export async function checkRuntimeConfigLocalAuth(
  configId: string,
  input: TestConnectionInput = {},
): Promise<RuntimeLocalAuthResult> {
  const storedConfig = await readRuntimeConfig(configId);
  const runtimeConfig = storedConfig
    ? mergeTestConfig(storedConfig, input)
    : draftRuntimeConfig(configId, input);
  if (!runtimeConfig) throw new Error("Runtime config not found");
  return detectRuntimeLocalAuth(runtimeConfig);
}

export async function refreshRuntimeConfigModels(
  configId: string,
  input: TestConnectionInput = {},
): Promise<RuntimeModelDiscoveryResult> {
  const storedConfig = await readRuntimeConfig(configId);
  const runtimeConfig = storedConfig
    ? mergeTestConfig(storedConfig, input)
    : draftRuntimeConfig(configId, input);
  if (!runtimeConfig) throw new Error("Runtime config not found");
  const mergeDiscoveredModels = (result: RuntimeModelDiscoveryResult): RuntimeModelDiscoveryResult => ({
    ...result,
    models: mergeRefreshedRuntimeModels(runtimeConfig, result.models),
  });
  if (runtimeConfig.sdk === "codex" && runtimeConfig.authMode === "inherited") {
    const models = await listCodexRuntimeModels(runtimeConfig);
    const warnings = runtimeModelMetadataWarnings(models, "Codex model/list");
    return mergeDiscoveredModels({
      sdk: runtimeConfig.sdk,
      models,
      warnings,
      endpoint: "codex-app-server:model/list",
    });
  }
  return mergeDiscoveredModels(await discoverRuntimeModels(runtimeConfig));
}

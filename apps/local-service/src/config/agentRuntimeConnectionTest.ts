import type { RuntimeConfig } from "./agentRuntimeConfig.js";
import { readRuntimeConfig } from "./agentRuntimeConfig.js";
import { normalizeRuntimeModelContext } from "./runtimeModelContext.js";
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

export type { AgentRuntimeConnectionTestResult };
export type { RuntimeLocalAuthResult };

type TestConnectionInput = AgentRuntimeConnectionTestInput;

function normalizedTestModels(
  runtimeConfig: Pick<RuntimeConfig, "sdk" | "authMode">,
  models: RuntimeConfig["models"],
): RuntimeConfig["models"] {
  return models.map((model, index) => {
    const normalizedContext = normalizeRuntimeModelContext(
      runtimeConfig.sdk,
      runtimeConfig.authMode,
      model.name ?? "",
      model.contextWindowK,
    );
    return {
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
): Promise<{ sdk: RuntimeConfig["sdk"]; models: RuntimeConfig["models"] }> {
  const storedConfig = await readRuntimeConfig(configId);
  const runtimeConfig = storedConfig
    ? mergeTestConfig(storedConfig, input)
    : draftRuntimeConfig(configId, input);
  if (!runtimeConfig) throw new Error("Runtime config not found");
  if (runtimeConfig.sdk !== "codex") throw new Error("Only Codex runtime supports available model refresh");
  return {
    sdk: runtimeConfig.sdk,
    models: await listCodexRuntimeModels(runtimeConfig),
  };
}

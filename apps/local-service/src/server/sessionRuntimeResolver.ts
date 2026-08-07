import {
  legacySessionRuntimeSdk,
  readFlowLeaderRuntimeConfig,
  readRoleRuntimeConfig,
  runtimeRoleForExpertRole,
  runtimeSdkFromValue,
  type RuntimeSdk,
} from "../config/agentRuntimeConfig.js";
import type { Store } from "../db/store.js";

type RuntimeAgentRun = NonNullable<ReturnType<Store["getAgentRun"]>>;

export async function runtimeSdkForPersistedAgentRun(input: {
  store: Store;
  flowId: string;
  agentRun?: RuntimeAgentRun | null;
  agentDefinitionId?: string | null;
  providerSessionId?: string | null;
}): Promise<RuntimeSdk> {
  const run = input.agentRun ?? null;
  const session = run ? input.store.getAgentSession(run.agentSessionId) : null;
  const definitionId = input.agentDefinitionId ?? session?.agentDefinitionId ?? null;
  const persistedProviderSessionId = input.providerSessionId ?? session?.providerSessionId ?? null;
  const lockedSdk = runtimeSdkFromValue(session?.runtimeSdk);
  if (lockedSdk) return lockedSdk;

  try {
    if (session?.role === "leader" || definitionId === "exp-leader") {
      const config = await readFlowLeaderRuntimeConfig({
        configId: session?.runtimeConfigId,
        modelId: session?.runtimeModelId,
        sdk: session?.runtimeSdk,
      });
      if (config) return config.config.sdk;
      if (persistedProviderSessionId) return legacySessionRuntimeSdk;
      return (await readRoleRuntimeConfig("leader")).config.sdk;
    }
    const definition = definitionId ? input.store.getAgentDefinition(definitionId) : null;
    if (persistedProviderSessionId) return legacySessionRuntimeSdk;
    if (definition) {
      return (await readRoleRuntimeConfig(runtimeRoleForExpertRole(definition.role), { requireEnabled: false })).config.sdk;
    }
  } catch {
    // A missing runtime lock falls back to the legacy SDK for persisted provider sessions.
  }
  return legacySessionRuntimeSdk;
}

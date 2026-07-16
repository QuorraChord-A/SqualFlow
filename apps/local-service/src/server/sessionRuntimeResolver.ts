import {
  legacySessionRuntimeSdk,
  readFlowLeaderRuntimeConfig,
  readRoleRuntimeConfig,
  runtimeRoleForExpertRole,
  runtimeSdkFromValue,
  type RuntimeSdk,
} from "../config/agentRuntimeConfig.js";
import type { Store } from "../db/store.js";

type RuntimeAgentSession = NonNullable<ReturnType<Store["getAgentSession"]>>;

export async function runtimeSdkForPersistedAgentSession(input: {
  store: Store;
  flowId: string;
  agentSession?: RuntimeAgentSession | null;
  expertId?: string | null;
  sdkSessionId?: string | null;
}): Promise<RuntimeSdk> {
  const agentSession = input.agentSession ?? null;
  const persistedSdkSessionId = input.sdkSessionId ?? agentSession?.sessionId ?? null;
  const sessionRuntimeSdk = agentSession ? runtimeSdkFromValue(agentSession.runtimeSdk) : null;
  if (sessionRuntimeSdk) return sessionRuntimeSdk;

  const resolvedExpertId = input.expertId ?? agentSession?.expertId ?? null;
  try {
    if (resolvedExpertId === "exp-leader") {
      const flow = input.store.getFlow(input.flowId);
      const lockedSdk = runtimeSdkFromValue(flow?.leaderRuntimeSdk);
      if (lockedSdk) return lockedSdk;
      const leaderConfig = await readFlowLeaderRuntimeConfig({
        configId: flow?.leaderRuntimeConfigId,
        modelId: flow?.leaderRuntimeModelId,
        sdk: flow?.leaderRuntimeSdk,
      });
      if (leaderConfig) return leaderConfig.config.sdk;
      if (persistedSdkSessionId) return legacySessionRuntimeSdk;
      return (await readRoleRuntimeConfig("leader")).config.sdk;
    }

    const expert = resolvedExpertId ? input.store.getExpert(resolvedExpertId) : null;
    const flowExpert = agentSession?.flowExpertId
      ? input.store.getFlowExpert(agentSession.flowExpertId)
      : resolvedExpertId
        ? input.store.listFlowExperts(input.flowId).find((item) => item.expertId === resolvedExpertId) ?? null
        : null;
    const flowExpertRuntimeSdk = runtimeSdkFromValue(flowExpert?.runtimeSdk);
    if (flowExpertRuntimeSdk) return flowExpertRuntimeSdk;
    if (flowExpert?.sdkSessionId || persistedSdkSessionId) return legacySessionRuntimeSdk;
    if (expert) {
      return (await readRoleRuntimeConfig(runtimeRoleForExpertRole(expert.role), { requireEnabled: false })).config.sdk;
    }
  } catch {
    // Sessions without runtime metadata were created before multi-SDK support.
  }
  return legacySessionRuntimeSdk;
}

import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import { detectRuntimeLocalAuth } from "../localRuntimeAuth.js";
import { testClaudeRuntimeConnection } from "./claudeConnectionTest.js";
import { testCodexRuntimeConnection } from "./codexConnectionTest.js";

export type AgentRuntimeConnectionTestResult = {
  ok: boolean;
  sdk: RuntimeConfig["sdk"];
  model: string;
  latencyMs: number;
  message: string;
  code?: string;
  totalCostUsd?: number;
  usage?: unknown;
};

export type AgentRuntimeConnectionTestInput = {
  model?: string;
  config?: Partial<RuntimeConfig>;
};

function requestedModel(runtimeConfig: RuntimeConfig, input: AgentRuntimeConnectionTestInput) {
  return input.model?.trim() || runtimeConfig.models.find((model) => model.name.trim())?.name.trim() || "";
}

export async function testAgentRuntimeConnection(
  runtimeConfig: RuntimeConfig,
  input: AgentRuntimeConnectionTestInput,
): Promise<AgentRuntimeConnectionTestResult> {
  if (runtimeConfig.authMode === "inherited" && runtimeConfig.sdk !== "codex") {
    const startedAt = Date.now();
    const auth = await detectRuntimeLocalAuth(runtimeConfig);
    return {
      ok: auth.status === "detected",
      sdk: runtimeConfig.sdk,
      model: requestedModel(runtimeConfig, input),
      latencyMs: Date.now() - startedAt,
      code: auth.status === "detected" ? undefined : auth.status.toUpperCase(),
      message: auth.accountHint ? `${auth.message}（${auth.accountHint}）` : auth.message,
    };
  }
  if (runtimeConfig.sdk === "claudecode") {
    return testClaudeRuntimeConnection(runtimeConfig, input);
  }
  if (runtimeConfig.sdk === "codex") {
    return testCodexRuntimeConnection(runtimeConfig, input);
  }
  return {
    ok: false,
    sdk: runtimeConfig.sdk,
    model: requestedModel(runtimeConfig, input),
    latencyMs: 0,
    code: "SDK_UNSUPPORTED",
    message: `Runtime SDK is not supported yet: ${runtimeConfig.sdk}`,
  };
}

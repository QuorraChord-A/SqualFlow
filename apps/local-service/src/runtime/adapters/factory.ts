import type { AgentRuntimeRole, RuntimeConfig, RuntimeSdk } from "../../config/agentRuntimeConfig.js";
import { createClaudeAgentRuntimeAdapter } from "./claudeAgentAdapter.js";
import { createCodexAgentRuntimeAdapter } from "./codexAgentAdapter.js";
import type { AgentRuntimeAdapter } from "./runtimeAdapter.js";

export type CreateAgentRuntimeAdapterInput = {
  sdk: RuntimeSdk;
  role?: AgentRuntimeRole;
  runtimeConfig?: RuntimeConfig;
};

export type AgentRuntimeAdapterFactory = (input: CreateAgentRuntimeAdapterInput) => AgentRuntimeAdapter;

export function createAgentRuntimeAdapter(input: CreateAgentRuntimeAdapterInput): AgentRuntimeAdapter {
  if (input.sdk === "claudecode") {
    return createClaudeAgentRuntimeAdapter();
  }
  if (input.sdk === "codex") {
    return createCodexAgentRuntimeAdapter({ runtimeConfig: input.runtimeConfig });
  }
  throw new Error(`Runtime SDK is not supported yet: ${input.sdk}`);
}

import { createClaudeAgentRuntimeAdapter, type ClaudeQueryFn } from "../../src/runtime/adapters/claudeAgentAdapter.js";
import type { AgentRuntimeAdapterFactory } from "../../src/runtime/adapters/factory.js";

export function createClaudeTestAdapterFactory(input: {
  query?: ClaudeQueryFn;
  leaderQuery?: ClaudeQueryFn;
  expertQuery?: ClaudeQueryFn;
}): AgentRuntimeAdapterFactory {
  return ({ sdk, role }) => {
    if (sdk !== "claudecode") {
      throw new Error(`Unexpected test runtime sdk: ${sdk}`);
    }
    const query = role === "leader"
      ? input.leaderQuery ?? input.query
      : input.expertQuery ?? input.query;
    return createClaudeAgentRuntimeAdapter({ query });
  };
}

import type { UiMessageChunk } from "../protocol/uiMessageChunks.js";
import { createClaudeAgentRuntimeAdapter, type ClaudeQueryFn } from "../runtime/adapters/claudeAgentAdapter.js";
import type { RuntimeQueryLike } from "../runtime/adapters/runtimeAdapter.js";
export type { ClaudeQueryFn, ClaudeQueryInput, ClaudeQueryLike } from "../runtime/adapters/claudeAgentAdapter.js";

export type AgentChunkConsumer = {
  consume: (event: UiMessageChunk) => Promise<void> | void;
};

export type RunClaudeAgentInput = {
  prompt: string;
  options?: unknown;
  messageId: string;
  startedAt?: string;
  pusher: AgentChunkConsumer;
  query?: ClaudeQueryFn;
  onSdkSessionId?: (sessionId: string) => Promise<void> | void;
};

export type RunClaudeAgentResult = {
  sdkSessionId: string | null;
  resultStatus: string | null;
  resultIsError: boolean | null;
  finalAssistantText: string | null;
  durationMs: number | null;
};

export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<RunClaudeAgentResult> {
  const runtimeAdapter = createClaudeAgentRuntimeAdapter({ query: input.query });
  const adapter = runtimeAdapter.createOutputAdapter(input.messageId, { startedAt: input.startedAt });
  let sdkQuery: RuntimeQueryLike | null = null;

  await input.pusher.consume(adapter.start());

  try {
    sdkQuery = runtimeAdapter.runQuery({ prompt: input.prompt, options: input.options });
    for await (const rawMessage of sdkQuery) {
      for (const chunk of adapter.adapt(rawMessage)) {
        await input.pusher.consume(chunk);
      }
    }

    for (const chunk of adapter.finish()) {
      await input.pusher.consume(chunk);
    }

    if (adapter.sdkSessionId) {
      await input.onSdkSessionId?.(adapter.sdkSessionId);
    }

    return {
      sdkSessionId: adapter.sdkSessionId,
      resultStatus: adapter.resultStatus,
      resultIsError: adapter.resultIsError,
      finalAssistantText: adapter.finalAssistantText,
      durationMs: adapter.durationMs,
    };
  } catch (error) {
    sdkQuery?.close?.();
    for (const chunk of adapter.finish()) {
      await input.pusher.consume(chunk);
    }
    throw error;
  }
}

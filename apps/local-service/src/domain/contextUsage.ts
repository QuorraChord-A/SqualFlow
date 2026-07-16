export type ContextUsageCategory = {
  name: string;
  tokens: number;
  color: string | null;
  isDeferred: boolean;
};

export type ContextUsageSnapshot = {
  totalTokens: number | null;
  maxTokens: number | null;
  rawMaxTokens: number | null;
  percentage: number | null;
  model: string | null;
  categories: ContextUsageCategory[];
  cacheInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheHitRate: number | null;
  observedAt: string;
  compacted: boolean;
};

export type ContextCacheUsage = {
  inputTokens: number;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheHitRate: number | null;
};

export function mergeContextCacheUsage(
  snapshot: ContextUsageSnapshot,
  observed: ContextCacheUsage | null,
  previous?: Pick<
    ContextUsageSnapshot,
    "cacheInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cacheHitRate"
  >,
): ContextUsageSnapshot {
  const telemetryObserved = observed !== null || snapshot.cacheInputTokens !== null;
  if (!telemetryObserved) {
    return {
      ...snapshot,
      cacheInputTokens: previous?.cacheInputTokens ?? null,
      cacheReadInputTokens: previous?.cacheReadInputTokens ?? null,
      cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? null,
      cacheHitRate: previous?.cacheHitRate ?? null,
    };
  }
  return {
    ...snapshot,
    cacheInputTokens: observed?.inputTokens ?? snapshot.cacheInputTokens,
    cacheReadInputTokens: observed ? observed.cacheReadInputTokens : snapshot.cacheReadInputTokens,
    cacheCreationInputTokens: observed ? observed.cacheCreationInputTokens : snapshot.cacheCreationInputTokens,
    cacheHitRate: observed ? observed.cacheHitRate : snapshot.cacheHitRate,
  };
}

export type AgentContextUsagePayload = {
  agent_session_id: string;
  sdk_session_id: string | null;
  role: string;
  expert_id: string | null;
  flow_expert_id: string | null;
  display_name: string;
  total_tokens: number | null;
  max_tokens: number | null;
  raw_max_tokens: number | null;
  percentage: number | null;
  model: string | null;
  categories: ContextUsageCategory[];
  cache_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_hit_rate: number | null;
  observed_at: string;
  compacted: boolean;
};

export type LiveContextUsage = {
  totalTokens: number | null;
  maxTokens: number | null;
  rawMaxTokens: number | null;
  percentage: number | null;
  model?: string | null;
  categories: Array<{
    name: string;
    tokens: number;
    color?: string | null;
    isDeferred?: boolean;
  }>;
};

export function liveContextUsageToSnapshot(raw: LiveContextUsage): ContextUsageSnapshot {
  return {
    totalTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    rawMaxTokens: raw.rawMaxTokens,
    percentage: raw.percentage,
    model: raw.model || null,
    categories: raw.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      color: category.color || null,
      isDeferred: Boolean(category.isDeferred),
    })),
    cacheInputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    cacheHitRate: null,
    observedAt: new Date().toISOString(),
    compacted: false,
  };
}

export function contextUsageSnapshotToPayload(
  snapshot: ContextUsageSnapshot,
  input: {
    agentSessionId: string;
    sdkSessionId: string | null;
    role: string;
    expertId: string | null;
    flowExpertId: string | null;
    displayName: string;
  },
): AgentContextUsagePayload {
  return {
    agent_session_id: input.agentSessionId,
    sdk_session_id: input.sdkSessionId,
    role: input.role,
    expert_id: input.expertId,
    flow_expert_id: input.flowExpertId,
    display_name: input.displayName,
    total_tokens: snapshot.totalTokens,
    max_tokens: snapshot.maxTokens,
    raw_max_tokens: snapshot.rawMaxTokens,
    percentage: snapshot.percentage,
    model: snapshot.model,
    categories: snapshot.categories,
    cache_input_tokens: snapshot.cacheInputTokens,
    cache_read_input_tokens: snapshot.cacheReadInputTokens,
    cache_creation_input_tokens: snapshot.cacheCreationInputTokens,
    cache_hit_rate: snapshot.cacheHitRate,
    observed_at: snapshot.observedAt,
    compacted: snapshot.compacted,
  };
}

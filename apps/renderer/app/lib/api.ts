export const API_BASE = process.env.NEXT_PUBLIC_SQUADFLOW_API_BASE ?? '';

export type AgentRuntimeRole = "leader" | "coder" | "research" | "verify" | "codereview";
export type RuntimeSdk = "claudecode" | "codex";
export type RuntimeAuthMode = "inherited" | "apiKey" | "accessToken";

export type RuntimeModelDto = {
  id: string;
  name: string;
  contextWindowK?: number | null;
  metadataStatus?: {
    contextWindow: "available" | "unavailable";
  };
};

export type AgentRuntimeConfigDto = {
  id: string;
  fileName: string;
  filePath?: string;
  name: string;
  sdk: RuntimeSdk;
  authMode: RuntimeAuthMode;
  baseUrl: string;
  apiKey: string;
  models: RuntimeModelDto[];
};

export type RoleRuntimeBindingDto = {
  role: AgentRuntimeRole;
  enabled: boolean;
  configId: string;
  modelId: string;
  reasoningEffort: string;
};

export type ExpertDto = {
  id: string;
  role: string;
  name: string;
  system_prompt: string;
  builtin_tools: unknown[];
  mcp_tools: unknown[];
  created_at: string;
  updated_at: string;
};

export type AgentRuntimeConfigSnapshotDto = {
  roles: RoleRuntimeBindingDto[];
  configs: AgentRuntimeConfigDto[];
};

export type NativeContextItemDto = {
  name: string;
  description: string;
  scope: "project" | "global";
  path: string | null;
};

export type NativeContextSnapshotDto = {
  sdk: RuntimeSdk;
  scope: "global" | "project";
  skills: NativeContextItemDto[];
  mcpServers: NativeContextItemDto[];
};

export type AgentRuntimeConnectionTestResultDto = {
  ok: boolean;
  sdk: RuntimeSdk;
  model: string;
  latencyMs: number;
  message: string;
  code?: string;
  totalCostUsd?: number;
  usage?: unknown;
};

export type RuntimeLocalAuthStatus = "detected" | "missing" | "invalid" | "unsupported";

export type RuntimeLocalAuthResultDto = {
  sdk: RuntimeSdk;
  status: RuntimeLocalAuthStatus;
  message: string;
  path?: string;
  source?: "oauth" | "api_key" | "keychain" | "file";
  accountHint?: string;
};

export type RuntimeAvailableModelsResultDto = {
  sdk: RuntimeSdk;
  models: RuntimeModelDto[];
  warnings?: string[];
  endpoint?: string;
};

export type AgentContextUsageDto = {
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
  categories: Array<{
    name: string;
    tokens: number;
    color: string | null;
    is_deferred: boolean;
  }>;
  cache_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_hit_rate: number | null;
  observed_at: string | null;
  compacted: boolean;
};

export type FlowContextUsageDto = {
  leader: AgentContextUsageDto | null;
  experts: AgentContextUsageDto[];
};

export type AgentContextCompactionDto = {
  flow_id: string;
  agent_session_id: string;
  sdk_session_id: string | null;
  role: string;
  expert_id: string | null;
  flow_expert_id: string | null;
  display_name: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  updated_at: string;
  error_message: string | null;
};

export type FlowContextStateDto = {
  context_usage?: FlowContextUsageDto | null;
  context_compactions?: AgentContextCompactionDto[];
};

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep the status-based fallback.
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function healthCheck(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchAgentRuntimeConfig(): Promise<AgentRuntimeConfigSnapshotDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config`);
  return parseJsonResponse<AgentRuntimeConfigSnapshotDto>(res);
}

export async function fetchExperts(): Promise<ExpertDto[]> {
  const res = await fetch(`${API_BASE}/api/experts`);
  return parseJsonResponse<ExpertDto[]>(res);
}

export async function fetchNativeContext(input: {
  flowId?: string | null;
  configId?: string | null;
}): Promise<NativeContextSnapshotDto> {
  const params = new URLSearchParams();
  if (input.flowId) params.set("flow_id", input.flowId);
  if (input.configId) params.set("config_id", input.configId);
  const res = await fetch(`${API_BASE}/api/native-context?${params.toString()}`);
  return parseJsonResponse<NativeContextSnapshotDto>(res);
}

export async function fetchFlowContextState(flowId: string): Promise<FlowContextStateDto> {
  const res = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`);
  return parseJsonResponse<FlowContextStateDto>(res);
}

export async function compactFlowContext(flowId: string): Promise<AgentContextUsageDto | null> {
  const res = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}/context/compact`, {
    method: "POST",
  });
  const flow = await parseJsonResponse<FlowContextStateDto>(res);
  return flow.context_usage?.leader ?? null;
}

export async function updateFlowLeaderRuntimeSelection(
  flowId: string,
  input: { configId?: string | null; modelId?: string | null; reasoningEffort?: string | null },
): Promise<{
  leader_runtime_sdk: RuntimeSdk | null;
  leader_runtime_config_id: string | null;
  leader_runtime_model_id: string | null;
  leader_runtime_reasoning_effort: string | null;
}> {
  const payload: Record<string, string | null> = {};
  if (Object.prototype.hasOwnProperty.call(input, "configId")) payload.leader_runtime_config_id = input.configId ?? null;
  if (Object.prototype.hasOwnProperty.call(input, "modelId")) payload.leader_runtime_model_id = input.modelId ?? null;
  if (Object.prototype.hasOwnProperty.call(input, "reasoningEffort")) {
    payload.leader_runtime_reasoning_effort = input.reasoningEffort ?? null;
  }
  const res = await fetch(`${API_BASE}/api/flows/${encodeURIComponent(flowId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJsonResponse<{
    leader_runtime_sdk: RuntimeSdk | null;
    leader_runtime_config_id: string | null;
    leader_runtime_model_id: string | null;
    leader_runtime_reasoning_effort: string | null;
  }>(res);
}

export async function createAgentRuntimeConfig(
  input: Partial<AgentRuntimeConfigDto>,
): Promise<AgentRuntimeConfigDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<AgentRuntimeConfigDto>(res);
}

export async function updateAgentRuntimeConfig(
  configId: string,
  input: Partial<AgentRuntimeConfigDto>,
): Promise<AgentRuntimeConfigDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs/${encodeURIComponent(configId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<AgentRuntimeConfigDto>(res);
}

export async function deleteAgentRuntimeConfig(configId: string): Promise<AgentRuntimeConfigSnapshotDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs/${encodeURIComponent(configId)}`, {
    method: "DELETE",
  });
  return parseJsonResponse<AgentRuntimeConfigSnapshotDto>(res);
}

export async function updateAgentRuntimeRole(
  role: AgentRuntimeRole,
  input: Partial<Omit<RoleRuntimeBindingDto, "role">>,
): Promise<RoleRuntimeBindingDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/roles/${encodeURIComponent(role)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<RoleRuntimeBindingDto>(res);
}

export async function testAgentRuntimeConnection(
  configId: string,
  input: { model?: string; config?: Partial<AgentRuntimeConfigDto> },
): Promise<AgentRuntimeConnectionTestResultDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs/${encodeURIComponent(configId)}/test-connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<AgentRuntimeConnectionTestResultDto>(res);
}

export async function checkAgentRuntimeLocalAuth(
  configId: string,
  input: { config?: Partial<AgentRuntimeConfigDto> },
): Promise<RuntimeLocalAuthResultDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs/${encodeURIComponent(configId)}/local-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<RuntimeLocalAuthResultDto>(res);
}

export async function refreshAgentRuntimeModels(
  configId: string,
  input: { config?: Partial<AgentRuntimeConfigDto> },
): Promise<RuntimeAvailableModelsResultDto> {
  const res = await fetch(`${API_BASE}/api/agent-runtime-config/configs/${encodeURIComponent(configId)}/available-models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<RuntimeAvailableModelsResultDto>(res);
}

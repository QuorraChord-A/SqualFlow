export interface Project {
  id: string;
  name: string;
  local_path: string;
  description: string;
  is_default?: boolean;
}

export type FlowType = "full" | "quick";
export type FlowStatus = "ready" | "active" | "idle";
export type FlowIndicator = "pending" | "active" | "unread" | "idle";
export type BehaviorMode = "execute" | "plan";
export type RiskMode = "auto_edit" | "full_access";
export type OrchestrationMode = "approval_required" | "automatic";

export interface SquadFlow {
  id: string;
  name: string;
  description?: string;
  name_generation_status?: "pending" | "generated" | "fallback" | "manual";
  type: FlowType;
  status: FlowStatus;
  indicator?: FlowIndicator;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
  is_pinned?: boolean;
  has_pending_user_action?: boolean;
  has_unread_output?: boolean;
  has_active_agent_run?: boolean;
  behavior_mode?: BehaviorMode;
  risk_mode?: RiskMode;
  orchestration_mode?: OrchestrationMode;
  leader_agent_session_id?: string | null;
  active_leader_agent_run_id?: string | null;
  latest_leader_agent_run_id?: string | null;
  leader_runtime_sdk?: string | null;
  leader_runtime_config_id?: string | null;
  leader_runtime_model_id?: string | null;
  leader_runtime_reasoning_effort?: string | null;
  last_output_completed_at?: string | null;
  last_read_at?: string | null;
}

export interface AgentContextUsage {
  agent_run_id: string;
  provider_session_id: string | null;
  role: string;
  agent_definition_id: string | null;
  agent_session_id: string | null;
  display_name: string;
  total_tokens: number | null;
  max_tokens: number | null;
  raw_max_tokens: number | null;
  percentage: number | null;
  model: string | null;
  categories: Array<{ name: string; tokens: number; color: string | null; is_deferred: boolean }>;
  cache_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_hit_rate: number | null;
  observed_at: string | null;
  compacted: boolean;
}

export interface FlowContextUsage {
  leader: AgentContextUsage | null;
  experts: AgentContextUsage[];
}

export interface AgentContextCompaction {
  flow_id: string;
  agent_run_id: string;
  provider_session_id: string | null;
  role: string;
  agent_definition_id: string | null;
  agent_session_id: string | null;
  display_name: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  updated_at: string;
  error_message: string | null;
}

export interface FlowDetail extends SquadFlow {
  context_usage?: FlowContextUsage | null;
  context_compactions?: AgentContextCompaction[];
}

export interface Project {
  id: string;
  name: string;
  local_path: string;
  description: string;
  is_default?: boolean;
}

export type FlowType = 'full' | 'quick';
export type FlowStatus = 'ready' | 'active' | 'idle';
export type StageType = 'start' | 'clarify' | 'architecture' | 'develop' | 'verify' | 'review' | 'diagnose';
export type StageStatus = 'pending' | 'active' | 'completed' | 'grayed';
export type RiskMode = 'auto_edit' | 'full_access';
export type PlanApproval = 'on' | 'off';

export interface SquadFlow {
  id: string;
  name: string;
  name_generation_status?: 'pending' | 'generated' | 'fallback' | 'manual';
  /** @deprecated Flow descriptions are no longer part of the product contract. */
  description?: string;
  type: FlowType;
  status: FlowStatus;
  current_stage: StageType | null;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
  is_pinned?: boolean;
  has_pending_decision?: boolean;
  has_unread_messages?: boolean;
  is_streaming?: boolean;
  has_active_execution?: boolean;
  leader_runtime_sdk?: string | null;
  leader_runtime_config_id?: string | null;
  leader_runtime_model_id?: string | null;
  leader_runtime_reasoning_effort?: string | null;
  legacy_spec_flow?: boolean;
  risk_mode?: RiskMode;
  plan_approval?: PlanApproval;
}

export interface AgentContextUsage {
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
  categories: {
    name: string;
    tokens: number;
    color: string | null;
    is_deferred: boolean;
  }[];
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
  agent_session_id: string;
  sdk_session_id: string | null;
  role: string;
  expert_id: string | null;
  flow_expert_id: string | null;
  display_name: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  updated_at: string;
  error_message: string | null;
}

export interface Message {
  id?: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  thinking?: string;
  timestamp?: string;
  isStreaming?: boolean;
}

export interface AgentOutput {
  agent_id: string;
  agent_name: string;
  project_name: string;
  output: string;
  timestamp: string;
  status: 'running' | 'completed' | 'error';
}

export interface Stage {
  type: StageType;
  status: StageStatus;
  title: string;
  description: string;
  session_id?: string | null;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  project_id: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface FlowDetail extends SquadFlow {
  stages: Stage[];
  messages: Message[];
  tasks: TaskItem[];
  agent_outputs: AgentOutput[];
  leader_session_id?: string | null;
  leader_runtime_sdk?: string | null;
  leader_runtime_config_id?: string | null;
  leader_runtime_model_id?: string | null;
  leader_runtime_reasoning_effort?: string | null;
  context_usage?: FlowContextUsage | null;
  context_compactions?: AgentContextCompaction[];
  context_bus?: {
    requirements_md?: string;
    tasks_md?: string;
    architecture_md?: string;
    contract_md?: string;
    task_list?: {
      id: string;
      type: 'coding' | 'qa';
      depends_on: string[];
      description: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
    }[];
  };
}

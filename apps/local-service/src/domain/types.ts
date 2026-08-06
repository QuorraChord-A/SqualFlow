export type FlowStatus = "ready" | "active" | "idle";
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type WorkSource = "spec" | "direct_message";
export type SpecApprovalStatus = "pending" | "approved" | "cancelled";
export type DecisionAnswer = string | string[];
export type DecisionAnswers = Record<string, DecisionAnswer>;

export interface Flow {
  id: string;
  project_id: string | null;
  // Project is the top-level local directory; there is no workspace container.
  name: string;
  name_generation_status: "pending" | "generated" | "fallback" | "manual";
  status: FlowStatus;
  legacy_spec_flow: boolean;
  leader_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  flow_id: string;
  work_run_id: string;
  title: string;
  description: string;
  expert_id: string | null;
  status: TaskStatus;
  revision: number;
  active_form: string;
  progress: string | null;
  agent_session_id: string | null;
  metadata_json: string;
  acceptance_criteria_json: string;
  result_artifact_ids_json: string;
  result_json: string | null;
  error_message: string | null;
  created_by_agent_session_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskItem {
  title: string;
  description: string;
  expert_id: string;
  depends_on_task_ids: string[];
  acceptance_criteria: string[];
  resume_from_agent_session_id: string;
}

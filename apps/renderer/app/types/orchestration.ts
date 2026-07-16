export type PlanNodeView = {
  plan_node_id: string;
  stable_key: string;
  expert_id: string;
  title: string;
  description: string;
  depends_on_node_ids: string[];
  acceptance_criteria: string[];
  risk_tags: string[];
  side_effects: string[];
  resource_keys: string[];
  task: { task_id: string; status: string; agent_session_id?: string | null; error_message?: string | null } | null;
};

export type OrchestrationPlanView = {
  plan_id: string;
  flow_id: string;
  user_turn_id: string;
  spec_revision_id?: string | null;
  revision: {
    plan_revision_id: string;
    revision_number: number;
    parent_revision_id?: string | null;
    source_feedback_message_id?: string | null;
    status: string;
    title: string;
    objective: string;
    work_kind: string;
    risk_level: string;
    lint: Array<Record<string, unknown>>;
    diff: { added?: string[]; removed?: string[]; modified?: Array<{ node_id: string; fields: string[] }> };
    created_at: string;
    approved_at?: string | null;
  };
  approval: {
    plan_approval_id: string;
    status: string;
    created_at: string;
    resolved_at?: string | null;
  } | null;
  run: { plan_run_id: string; status: string; started_at?: string | null; completed_at?: string | null } | null;
  nodes: PlanNodeView[];
  feedback: Array<{
    plan_feedback_id: string;
    plan_node_id?: string | null;
    source_message_id: string;
    marker_number: number;
    comment: string;
    status: string;
    resolution_note?: string | null;
    created_at: string;
  }>;
};

export type PlanFeedbackDraft = {
  id: string;
  flowId: string;
  planRevisionId: string;
  planNodeId: string | null;
  markerNumber: number;
  targetLabel: string;
  comment: string;
};

export type OutgoingPlanFeedback = {
  id: string;
  plan_revision_id: string;
  plan_node_id?: string | null;
  marker_number: number;
  comment: string;
};

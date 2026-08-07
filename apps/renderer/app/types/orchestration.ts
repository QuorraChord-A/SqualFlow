export type OrchestrationNodeView = {
  orchestration_node_id: string;
  stable_key: string;
  recommended_agent_definition_id: string;
  title: string;
  description: string;
  depends_on_node_ids: string[];
  acceptance_criteria: string[];
  metadata: Record<string, unknown>;
  task: {
    task_id: string;
    status: string;
    agent_session_id: string | null;
    error_message: string | null;
  } | null;
};

export type OrchestrationPlanView = {
  flow_id: string;
  orchestration_plan_id: string;
  revision: {
    orchestration_revision_id: string;
    revision_number: number;
    parent_revision_id: string | null;
    status: string;
    approval_mode_snapshot: "approval_required" | "automatic";
    title: string;
    objective: string;
    source_agent_run_id: string;
    created_at: string;
    activated_at: string | null;
  };
  approval: {
    orchestration_approval_id: string;
    status: string;
    resolution_action_id?: string | null;
    feedback?: string | null;
    created_at: string;
    resolved_at?: string | null;
  } | null;
  nodes: OrchestrationNodeView[];
  feedback: Array<{
    orchestration_feedback_id: string;
    orchestration_node_id?: string | null;
    source_message_id: string;
    marker_number: number;
    comment: string;
    status: string;
    resolution_note?: string | null;
    created_at: string;
  }>;
};

export type OrchestrationFeedbackDraft = {
  id: string;
  flowId: string;
  orchestrationRevisionId: string;
  orchestrationNodeId: string | null;
  markerNumber: number;
  targetLabel: string;
  comment: string;
};

export type OutgoingOrchestrationFeedback = {
  id: string;
  orchestration_revision_id: string;
  orchestration_node_id?: string | null;
  marker_number: number;
  comment: string;
};

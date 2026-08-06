import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  localPath: text("local_path").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull().default(""),
});

export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  name: text("name").notNull(),
  description: text("description"),
  nameGenerationStatus: text("name_generation_status").notNull().default("generated"),
  status: text("status").notNull().default("ready"),
  legacySpecFlow: integer("legacy_spec_flow").notNull().default(0),
  riskMode: text("risk_mode").notNull().default("auto_edit"),
  planApproval: text("plan_approval").notNull().default("on"),
  isPinned: integer("is_pinned").notNull().default(0),
  lastOutputCompletedAt: text("last_output_completed_at"),
  leaderSessionId: text("leader_session_id"),
  leaderRuntimeSdk: text("leader_runtime_sdk"),
  leaderRuntimeConfigId: text("leader_runtime_config_id"),
  leaderRuntimeModelId: text("leader_runtime_model_id"),
  leaderRuntimeReasoningEffort: text("leader_runtime_reasoning_effort"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const flowReadStates = sqliteTable("flow_read_states", {
  flowId: text("flow_id").notNull(),
  viewerId: text("viewer_id").notNull().default("local-default"),
  lastReadAt: text("last_read_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workRuns = sqliteTable("work_runs", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  triggerMessageId: text("trigger_message_id").notNull(),
  status: text("status").notNull().default("ready"),
  revision: integer("revision").notNull().default(1),
  startedAt: text("started_at").notNull(),
  executionStartedAt: text("execution_started_at"),
  activeStartedAt: text("active_started_at"),
  activeDurationMs: integer("active_duration_ms").notNull().default(0),
  waitingStartedAt: text("waiting_started_at"),
  completedAt: text("completed_at"),
  workSource: text("work_source"),
  specRevisionId: text("spec_revision_id"),
  targetProjectId: text("target_project_id"),
  workRootPath: text("work_root_path").notNull().default(""),
  inputSnapshotJson: text("input_snapshot_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("work_runs_one_open_per_flow")
    .on(table.flowId)
    .where(sql`${table.status} IN ('ready', 'executing', 'waiting_user', 'interrupted')`),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  expertId: text("expert_id"),
  flowExpertId: text("flow_expert_id"),
  status: text("status").notNull().default("pending"),
  revision: integer("revision").notNull().default(1),
  activeForm: text("active_form").notNull().default(""),
  /** Human-authored current progress; not inferred from provider turn outcomes. */
  progress: text("progress"),
  agentSessionId: text("agent_session_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull().default("[]"),
  resultArtifactIdsJson: text("result_artifact_ids_json").notNull().default("[]"),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  createdByAgentSessionId: text("created_by_agent_session_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  updatedAt: text("updated_at").notNull(),
});

export const specRevisions = sqliteTable("spec_revisions", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  status: text("status").notNull().default("draft"),
  title: text("title").notNull(),
  overview: text("overview").notNull().default(""),
  fileName: text("file_name").notNull().default(""),
  content: text("content").notNull(),
  sourceAgentSessionId: text("source_agent_session_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  approvedAt: text("approved_at"),
  executedAt: text("executed_at"),
});

export const specApprovals = sqliteTable("spec_approvals", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  specRevisionId: text("spec_revision_id").notNull(),
  workRunId: text("work_run_id"),
  status: text("status").notNull().default("pending"),
  fileName: text("file_name").notNull(),
  overview: text("overview").notNull().default(""),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const taskDependencies = sqliteTable("task_dependencies", {
  taskId: text("task_id").notNull(),
  dependsOnTaskId: text("depends_on_task_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
]);

export const orchestrationPlans = sqliteTable("orchestration_plans", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id").notNull(),
  specRevisionId: text("spec_revision_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("orchestration_plans_work_run_unique").on(table.workRunId),
]);

export const planRevisions = sqliteTable("plan_revisions", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  parentRevisionId: text("parent_revision_id"),
  sourceFeedbackMessageId: text("source_feedback_message_id"),
  status: text("status").notNull().default("generating"),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  workKind: text("work_kind").notNull().default("change"),
  riskLevel: text("risk_level").notNull().default("medium"),
  lintJson: text("lint_json").notNull().default("[]"),
  diffJson: text("diff_json").notNull().default("{}"),
  sourceAgentSessionId: text("source_agent_session_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  approvedAt: text("approved_at"),
  supersededAt: text("superseded_at"),
}, (table) => [
  uniqueIndex("plan_revisions_plan_number_unique").on(table.planId, table.revisionNumber),
]);

export const planNodes = sqliteTable("plan_nodes", {
  id: text("id").primaryKey(),
  planRevisionId: text("plan_revision_id").notNull(),
  stableKey: text("stable_key").notNull(),
  expertId: text("expert_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull().default("[]"),
  riskTagsJson: text("risk_tags_json").notNull().default("[]"),
  sideEffectsJson: text("side_effects_json").notNull().default("[]"),
  resourceKeysJson: text("resource_keys_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("plan_nodes_revision_key_unique").on(table.planRevisionId, table.stableKey),
]);

export const planDependencies = sqliteTable("plan_dependencies", {
  planRevisionId: text("plan_revision_id").notNull(),
  nodeId: text("node_id").notNull(),
  dependsOnNodeId: text("depends_on_node_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.planRevisionId, table.nodeId, table.dependsOnNodeId] }),
]);

export const planApprovals = sqliteTable("plan_approvals", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id").notNull(),
  planRevisionId: text("plan_revision_id").notNull(),
  status: text("status").notNull().default("pending"),
  resolutionActionId: text("resolution_action_id"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [
  uniqueIndex("plan_approvals_revision_unique").on(table.planRevisionId),
]);

export const planFeedback = sqliteTable("plan_feedback", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id").notNull(),
  planRevisionId: text("plan_revision_id").notNull(),
  planNodeId: text("plan_node_id"),
  sourceMessageId: text("source_message_id").notNull(),
  markerNumber: integer("marker_number").notNull(),
  comment: text("comment").notNull(),
  status: text("status").notNull().default("pending"),
  resolutionNote: text("resolution_note"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const planRuns = sqliteTable("plan_runs", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id").notNull(),
  planRevisionId: text("plan_revision_id").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("plan_runs_revision_unique").on(table.planRevisionId),
]);

export const planNodeTasks = sqliteTable("plan_node_tasks", {
  planRunId: text("plan_run_id").notNull(),
  planNodeId: text("plan_node_id").notNull(),
  taskId: text("task_id").notNull(),
  disposition: text("disposition").notNull().default("created"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.planRunId, table.planNodeId] }),
]);

export const orchestrationRules = sqliteTable("orchestration_rules", {
  id: text("id").primaryKey(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull().default(""),
  name: text("name").notNull(),
  severity: text("severity").notNull().default("warn"),
  enabled: integer("enabled").notNull().default(1),
  ruleJson: text("rule_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const eventLog = sqliteTable("event_log", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id"),
  taskId: text("task_id"),
  agentSessionId: text("agent_session_id"),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
});

export const experts = sqliteTable("experts", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  /** Fixed Chinese role title shown under the person name in UI, e.g. 全栈开发专家. */
  name: text("name").notNull(),
  /** Candidate person names for FlowExpert display_name; one is chosen per Flow. */
  personNameCandidates: text("person_name_candidates").notNull().default("[]"),
  systemPrompt: text("system_prompt").notNull(),
  builtinTools: text("builtin_tools").notNull().default("[]"),
  mcpTools: text("mcp_tools").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const flowExperts = sqliteTable(
  "flow_experts",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    expertId: text("expert_id").notNull(),
    displayName: text("display_name").notNull().default(""),
    status: text("status").notNull().default("idle"),
    sdkSessionId: text("sdk_session_id"),
    runtimeSdk: text("runtime_sdk"),
    runtimeConfigId: text("runtime_config_id"),
    runtimeModelId: text("runtime_model_id"),
    runtimeReasoningEffort: text("runtime_reasoning_effort"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("flow_experts_flow_id_expert_id_unique").on(table.flowId, table.expertId),
  ],
);

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id"),
  taskId: text("task_id"),
  expertId: text("expert_id").notNull(),
  flowExpertId: text("flow_expert_id"),
  sessionId: text("session_id"),
  runtimeSdk: text("runtime_sdk"),
  runtimeConfigId: text("runtime_config_id"),
  runtimeModelId: text("runtime_model_id"),
  runtimeReasoningEffort: text("runtime_reasoning_effort"),
  displayName: text("display_name").notNull().default(""),
  resumeFromAgentSessionId: text("resume_from_agent_session_id").notNull().default(""),
  status: text("status").notNull().default("queued"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentContextUsageSnapshots = sqliteTable(
  "agent_context_usage_snapshots",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    sdkSessionId: text("sdk_session_id"),
    role: text("role").notNull(),
    expertId: text("expert_id"),
    flowExpertId: text("flow_expert_id"),
    totalTokens: integer("total_tokens"),
    maxTokens: integer("max_tokens"),
    rawMaxTokens: integer("raw_max_tokens"),
    percentage: real("percentage"),
    model: text("model"),
    categoriesJson: text("categories_json").notNull().default("[]"),
    cacheInputTokens: integer("cache_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheHitRate: real("cache_hit_rate"),
    compacted: integer("compacted").notNull().default(0),
    observedAt: text("observed_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_context_usage_snapshots_agent_session_unique").on(table.agentSessionId),
  ],
);

export const decisionCards = sqliteTable("decision_cards", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id"),
  sessionId: text("session_id").notNull().default(""),
  cardType: text("card_type").notNull().default("generic"),
  questions: text("questions").notNull(),
  answers: text("answers"),
  status: text("status").notNull().default("pending"),
  resolutionKind: text("resolution_kind").notNull().default(""),
  resolutionActionId: text("resolution_action_id"),
  resolvedMessageId: text("resolved_message_id"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const decisionCardLeaderInputs = sqliteTable(
  "decision_card_leader_inputs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    cardId: text("card_id").notNull(),
    clientActionId: text("client_action_id").notNull(),
    messageId: text("message_id").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    sentAt: text("sent_at"),
  },
  (table) => [
    uniqueIndex("decision_card_leader_inputs_action_unique")
      .on(table.flowId, table.cardId, table.clientActionId),
  ],
);

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  workRunId: text("work_run_id"),
  taskId: text("task_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceAgentSessionId: text("source_agent_session_id").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

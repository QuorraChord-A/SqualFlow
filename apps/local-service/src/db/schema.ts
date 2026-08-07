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
  behaviorMode: text("behavior_mode").notNull().default("execute"),
  riskMode: text("risk_mode").notNull().default("auto_edit"),
  orchestrationMode: text("orchestration_mode").notNull().default("approval_required"),
  isPinned: integer("is_pinned").notNull().default(0),
  lastOutputCompletedAt: text("last_output_completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const flowReadStates = sqliteTable("flow_read_states", {
  flowId: text("flow_id").notNull(),
  viewerId: text("viewer_id").notNull().default("local-default"),
  lastReadAt: text("last_read_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.flowId, table.viewerId] })]);

export const agentDefinitions = sqliteTable("agent_definitions", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  name: text("name").notNull(),
  personNameCandidates: text("person_name_candidates").notNull().default("[]"),
  systemPrompt: text("system_prompt").notNull(),
  builtinTools: text("builtin_tools").notNull().default("[]"),
  mcpTools: text("mcp_tools").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentDefinitionId: text("agent_definition_id").notNull(),
  role: text("role").notNull(),
  displayName: text("display_name").notNull().default(""),
  providerSessionId: text("provider_session_id"),
  runtimeSdk: text("runtime_sdk"),
  runtimeConfigId: text("runtime_config_id"),
  runtimeModelId: text("runtime_model_id"),
  runtimeReasoningEffort: text("runtime_reasoning_effort"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("agent_sessions_one_leader_per_flow")
    .on(table.flowId)
    .where(sql`${table.role} = 'leader'`),
]);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentSessionId: text("agent_session_id").notNull(),
  taskId: text("task_id"),
  triggerKind: text("trigger_kind").notNull().default("user_message"),
  triggerMessageId: text("trigger_message_id"),
  status: text("status").notNull().default("queued"),
  modelInputJson: text("model_input_json").notNull().default("{}"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("agent_runs_one_active_per_session")
    .on(table.agentSessionId)
    .where(sql`${table.status} IN ('queued', 'running', 'waiting_tool_approval')`),
]);

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  taskId: text("task_id"),
  name: text("name").notNull(),
  functionCallType: text("function_call_type"),
  status: text("status").notNull().default("started"),
  idempotencyKey: text("idempotency_key"),
  argumentsJson: text("arguments_json").notNull().default("{}"),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  decisionRequestId: text("decision_request_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("tool_calls_run_idempotency_unique")
    .on(table.agentRunId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

export const planDocuments = sqliteTable("plan_documents", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("plan_documents_flow_unique").on(table.flowId)]);

export const planRevisions = sqliteTable("plan_revisions", {
  id: text("id").primaryKey(),
  planDocumentId: text("plan_document_id").notNull(),
  flowId: text("flow_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  title: text("title").notNull(),
  overview: text("overview").notNull().default(""),
  content: text("content").notNull(),
  sourceAgentRunId: text("source_agent_run_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("plan_revisions_document_number_unique").on(table.planDocumentId, table.revisionNumber)]);

export const planApprovals = sqliteTable("plan_approvals", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  planRevisionId: text("plan_revision_id").notNull(),
  status: text("status").notNull().default("pending"),
  resolutionActionId: text("resolution_action_id"),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [uniqueIndex("plan_approvals_revision_unique").on(table.planRevisionId)]);

export const orchestrationPlans = sqliteTable("orchestration_plans", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("orchestration_plans_flow_unique").on(table.flowId)]);

export const orchestrationRevisions = sqliteTable("orchestration_revisions", {
  id: text("id").primaryKey(),
  orchestrationPlanId: text("orchestration_plan_id").notNull(),
  flowId: text("flow_id").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  parentRevisionId: text("parent_revision_id"),
  status: text("status").notNull().default("active"),
  approvalModeSnapshot: text("approval_mode_snapshot").notNull(),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  sourceAgentRunId: text("source_agent_run_id").notNull(),
  createdAt: text("created_at").notNull(),
  activatedAt: text("activated_at"),
}, (table) => [
  uniqueIndex("orchestration_revisions_plan_number_unique")
    .on(table.orchestrationPlanId, table.revisionNumber),
]);

export const orchestrationNodes = sqliteTable("orchestration_nodes", {
  id: text("id").primaryKey(),
  orchestrationRevisionId: text("orchestration_revision_id").notNull(),
  stableKey: text("stable_key").notNull(),
  recommendedAgentDefinitionId: text("recommended_agent_definition_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull().default("[]"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("orchestration_nodes_revision_key_unique").on(table.orchestrationRevisionId, table.stableKey),
]);

export const orchestrationNodeDependencies = sqliteTable("orchestration_node_dependencies", {
  orchestrationRevisionId: text("orchestration_revision_id").notNull(),
  nodeId: text("node_id").notNull(),
  dependsOnNodeId: text("depends_on_node_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.orchestrationRevisionId, table.nodeId, table.dependsOnNodeId] })]);

export const orchestrationApprovals = sqliteTable("orchestration_approvals", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  orchestrationRevisionId: text("orchestration_revision_id").notNull(),
  status: text("status").notNull().default("pending"),
  resolutionActionId: text("resolution_action_id"),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => [uniqueIndex("orchestration_approvals_revision_unique").on(table.orchestrationRevisionId)]);

export const orchestrationFeedback = sqliteTable("orchestration_feedback", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  orchestrationRevisionId: text("orchestration_revision_id").notNull(),
  orchestrationNodeId: text("orchestration_node_id"),
  sourceMessageId: text("source_message_id").notNull(),
  markerNumber: integer("marker_number").notNull(),
  comment: text("comment").notNull(),
  status: text("status").notNull().default("pending"),
  resolutionNote: text("resolution_note"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  orchestrationRevisionId: text("orchestration_revision_id"),
  orchestrationNodeId: text("orchestration_node_id"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  recommendedAgentDefinitionId: text("recommended_agent_definition_id"),
  agentSessionId: text("agent_session_id"),
  status: text("status").notNull().default("pending"),
  revision: integer("revision").notNull().default(1),
  activeForm: text("active_form").notNull().default(""),
  progress: text("progress"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull().default("[]"),
  resultArtifactIdsJson: text("result_artifact_ids_json").notNull().default("[]"),
  resultJson: text("result_json"),
  errorMessage: text("error_message"),
  createdByAgentRunId: text("created_by_agent_run_id").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("tasks_orchestration_node_unique")
    .on(table.orchestrationRevisionId, table.orchestrationNodeId)
    .where(sql`${table.orchestrationRevisionId} IS NOT NULL AND ${table.orchestrationNodeId} IS NOT NULL`),
]);

export const taskDependencies = sqliteTable("task_dependencies", {
  taskId: text("task_id").notNull(),
  dependsOnTaskId: text("depends_on_task_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.taskId, table.dependsOnTaskId] })]);

export const decisionRequests = sqliteTable("decision_requests", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  toolCallId: text("tool_call_id"),
  requestType: text("request_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  responseJson: text("response_json"),
  status: text("status").notNull().default("pending"),
  resolutionActionId: text("resolution_action_id"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  updatedAt: text("updated_at").notNull(),
});

export const leaderRunTriggers = sqliteTable("leader_run_triggers", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  kind: text("kind").notNull(),
  sourceId: text("source_id").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sentAt: text("sent_at"),
}, (table) => [
  uniqueIndex("leader_run_triggers_source_unique")
    .on(table.flowId, table.kind, table.sourceId),
]);

export const changeSets = sqliteTable("change_sets", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  title: text("title").notNull().default("代码变更"),
  status: text("status").notNull().default("open"),
  rootPath: text("root_path").notNull(),
  baselineSnapshotPath: text("baseline_snapshot_path").notNull(),
  baselineJson: text("baseline_json").notNull(),
  baselineKind: text("baseline_kind").notNull(),
  baselineRef: text("baseline_ref"),
  partialReason: text("partial_reason"),
  reviewJson: text("review_json"),
  createdAt: text("created_at").notNull(),
  finalizedAt: text("finalized_at"),
  abandonedAt: text("abandoned_at"),
  updatedAt: text("updated_at").notNull(),
});

export const changeSetContributions = sqliteTable("change_set_contributions", {
  changeSetId: text("change_set_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  taskId: text("task_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.changeSetId, table.agentRunId] })]);

export const changeSetFiles = sqliteTable("change_set_files", {
  changeSetId: text("change_set_id").notNull(),
  path: text("path").notNull(),
  status: text("status").notNull(),
  patch: text("patch"),
  additions: integer("additions"),
  deletions: integer("deletions"),
  attributionKind: text("attribution_kind").notNull().default("direct"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.changeSetId, table.path] })]);

export const changeBaselineCandidates = sqliteTable("change_baseline_candidates", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  taskId: text("task_id"),
  rootPath: text("root_path").notNull(),
  snapshotPath: text("snapshot_path").notNull(),
  baselineJson: text("baseline_json").notNull(),
  baselineKind: text("baseline_kind").notNull(),
  baselineRef: text("baseline_ref"),
  status: text("status").notNull().default("ready"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("change_baseline_candidates_run_unique").on(table.agentRunId)]);

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  taskId: text("task_id"),
  changeSetId: text("change_set_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceAgentRunId: text("source_agent_run_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentContextUsageSnapshots = sqliteTable("agent_context_usage_snapshots", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  agentRunId: text("agent_run_id").notNull(),
  providerSessionId: text("provider_session_id"),
  role: text("role").notNull(),
  agentDefinitionId: text("agent_definition_id"),
  agentSessionId: text("agent_session_id"),
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
}, (table) => [uniqueIndex("agent_context_usage_snapshots_agent_run_unique").on(table.agentRunId)]);

export const eventLog = sqliteTable("event_log", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  taskId: text("task_id"),
  agentRunId: text("agent_run_id"),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
});

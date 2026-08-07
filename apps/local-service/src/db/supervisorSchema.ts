import type Database from "better-sqlite3";

export const SUPERVISOR_SCHEMA_VERSION = "4";

const FLOW_DATA_TABLES = [
  "chat_queue_items",
  "chat_submissions",
  "chat_timeline_items",
  "chat_transcript_channels",
  "event_log",
  "agent_context_usage_snapshots",
  "artifacts",
  "change_set_files",
  "change_set_contributions",
  "change_baseline_candidates",
  "change_sets",
  "decision_requests",
  "tool_calls",
  "task_dependencies",
  "tasks",
  "orchestration_feedback",
  "orchestration_approvals",
  "orchestration_node_dependencies",
  "orchestration_nodes",
  "orchestration_revisions",
  "orchestration_plans",
  "plan_approvals",
  "plan_revisions",
  "plan_documents",
  "leader_run_triggers",
  "agent_runs",
  "agent_sessions",
  "flow_read_states",
  "flows",
] as const;

const LEGACY_TABLES = [
  "work_run_reviews",
  "work_run_touched_files",
  "work_run_file_attributions",
  "change_baselines",
  "work_runs",
  "user_turn_reviews",
  "user_turns",
  "orchestration_node_tasks",
  "plan_dependencies",
  "orchestration_executions",
  "orchestration_rules",
  "decision_card_leader_inputs",
  "decision_request_leader_inputs",
  "decision_cards",
  "flow_experts",
  "experts",
] as const;

function hasTable(sqlite: Database.Database, table: string) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(sqlite: Database.Database, table: string, column: string) {
  if (!hasTable(sqlite, table)) return false;
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

export function createSupervisorTables(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL, description TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS flows (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, name TEXT NOT NULL, description TEXT,
      name_generation_status TEXT NOT NULL DEFAULT 'generated',
      behavior_mode TEXT NOT NULL DEFAULT 'execute' CHECK (behavior_mode IN ('execute', 'plan')),
      risk_mode TEXT NOT NULL DEFAULT 'auto_edit' CHECK (risk_mode IN ('auto_edit', 'full_access')),
      orchestration_mode TEXT NOT NULL DEFAULT 'approval_required' CHECK (orchestration_mode IN ('approval_required', 'automatic')),
      is_pinned INTEGER NOT NULL DEFAULT 0, last_output_completed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flow_read_states (
      flow_id TEXT NOT NULL, viewer_id TEXT NOT NULL DEFAULT 'local-default',
      last_read_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, viewer_id), FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL,
      person_name_candidates TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL,
      builtin_tools TEXT NOT NULL DEFAULT '[]', mcp_tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('leader', 'expert')), display_name TEXT NOT NULL DEFAULT '',
      provider_session_id TEXT, runtime_sdk TEXT, runtime_config_id TEXT,
      runtime_model_id TEXT, runtime_reasoning_effort TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_one_leader_per_flow
      ON agent_sessions(flow_id) WHERE role = 'leader';
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, task_id TEXT,
      trigger_kind TEXT NOT NULL DEFAULT 'user_message', trigger_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'running', 'waiting_tool_approval', 'completed', 'failed', 'cancelled', 'interrupted'
      )),
      model_input_json TEXT NOT NULL DEFAULT '{}', error_message TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_session
      ON agent_runs(agent_session_id) WHERE status IN ('queued', 'running', 'waiting_tool_approval');
    CREATE INDEX IF NOT EXISTS agent_runs_flow_created_idx ON agent_runs(flow_id, created_at);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      name TEXT NOT NULL, function_call_type TEXT,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'waiting_approval', 'running', 'completed', 'failed', 'cancelled')),
      idempotency_key TEXT, arguments_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
      error_message TEXT, decision_request_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_calls_run_idempotency_unique
      ON tool_calls(agent_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS plan_documents (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL UNIQUE REFERENCES flows(id) ON DELETE CASCADE, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_revisions (
      id TEXT PRIMARY KEY, plan_document_id TEXT NOT NULL REFERENCES plan_documents(id) ON DELETE CASCADE,
      flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL, title TEXT NOT NULL, overview TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      source_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(plan_document_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS plan_approvals (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      plan_revision_id TEXT NOT NULL UNIQUE REFERENCES plan_revisions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
      resolution_action_id TEXT, feedback TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orchestration_plans (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL UNIQUE REFERENCES flows(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestration_revisions (
      id TEXT PRIMARY KEY, orchestration_plan_id TEXT NOT NULL REFERENCES orchestration_plans(id) ON DELETE CASCADE,
      flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL,
      parent_revision_id TEXT REFERENCES orchestration_revisions(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('waiting_approval', 'active', 'rejected', 'superseded')),
      approval_mode_snapshot TEXT NOT NULL CHECK (approval_mode_snapshot IN ('approval_required', 'automatic')),
      title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
      source_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, activated_at TEXT,
      UNIQUE(orchestration_plan_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS orchestration_nodes (
      id TEXT PRIMARY KEY, orchestration_revision_id TEXT NOT NULL REFERENCES orchestration_revisions(id) ON DELETE CASCADE, stable_key TEXT NOT NULL,
      recommended_agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, UNIQUE(orchestration_revision_id, stable_key)
    );
    CREATE TABLE IF NOT EXISTS orchestration_node_dependencies (
      orchestration_revision_id TEXT NOT NULL, node_id TEXT NOT NULL, depends_on_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(orchestration_revision_id, node_id, depends_on_node_id),
      FOREIGN KEY(orchestration_revision_id) REFERENCES orchestration_revisions(id) ON DELETE CASCADE,
      FOREIGN KEY(node_id) REFERENCES orchestration_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_node_id) REFERENCES orchestration_nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS orchestration_approvals (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      orchestration_revision_id TEXT NOT NULL UNIQUE REFERENCES orchestration_revisions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
      resolution_action_id TEXT, feedback TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orchestration_feedback (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      orchestration_revision_id TEXT NOT NULL REFERENCES orchestration_revisions(id) ON DELETE CASCADE,
      orchestration_node_id TEXT REFERENCES orchestration_nodes(id) ON DELETE CASCADE, source_message_id TEXT NOT NULL, marker_number INTEGER NOT NULL,
      comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resolution_note TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      orchestration_revision_id TEXT REFERENCES orchestration_revisions(id) ON DELETE SET NULL,
      orchestration_node_id TEXT REFERENCES orchestration_nodes(id) ON DELETE SET NULL,
      title TEXT NOT NULL, description TEXT NOT NULL,
      recommended_agent_definition_id TEXT REFERENCES agent_definitions(id) ON DELETE RESTRICT,
      agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled'
      )),
      revision INTEGER NOT NULL DEFAULT 1, active_form TEXT NOT NULL DEFAULT '', progress TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      result_artifact_ids_json TEXT NOT NULL DEFAULT '[]', result_json TEXT, error_message TEXT,
      created_by_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_orchestration_node_unique
      ON tasks(orchestration_revision_id, orchestration_node_id)
      WHERE orchestration_revision_id IS NOT NULL AND orchestration_node_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, depends_on_task_id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS decision_requests (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('clarification', 'tool_permission')),
      payload_json TEXT NOT NULL DEFAULT '{}', response_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      resolution_action_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leader_run_triggers (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, kind TEXT NOT NULL, source_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT,
      UNIQUE(flow_id, kind, source_id)
    );
    CREATE TABLE IF NOT EXISTS change_sets (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT '代码变更',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalized', 'abandoned')),
      root_path TEXT NOT NULL, baseline_snapshot_path TEXT NOT NULL, baseline_json TEXT NOT NULL, baseline_kind TEXT NOT NULL,
      baseline_ref TEXT, partial_reason TEXT, review_json TEXT,
      created_at TEXT NOT NULL, finalized_at TEXT, abandoned_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_set_contributions (
      change_set_id TEXT NOT NULL, agent_run_id TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(change_set_id, agent_run_id),
      FOREIGN KEY(change_set_id) REFERENCES change_sets(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS change_set_files (
      change_set_id TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, patch TEXT,
      additions INTEGER, deletions INTEGER, attribution_kind TEXT NOT NULL DEFAULT 'direct',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(change_set_id, path),
      FOREIGN KEY(change_set_id) REFERENCES change_sets(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS change_baseline_candidates (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      root_path TEXT NOT NULL, snapshot_path TEXT NOT NULL, baseline_json TEXT NOT NULL,
      baseline_kind TEXT NOT NULL, baseline_ref TEXT, status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
      type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      source_agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_context_usage_snapshots (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
      agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
      provider_session_id TEXT, role TEXT NOT NULL, agent_definition_id TEXT, agent_session_id TEXT,
      total_tokens INTEGER, max_tokens INTEGER, raw_max_tokens INTEGER, percentage REAL, model TEXT,
      categories_json TEXT NOT NULL DEFAULT '[]', cache_input_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_hit_rate REAL,
      compacted INTEGER NOT NULL DEFAULT 0, observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, task_id TEXT, agent_run_id TEXT,
      event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_transcript_channels (
      flow_id TEXT NOT NULL, channel_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(flow_id, channel_id), FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_timeline_items (
      flow_id TEXT NOT NULL, channel_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL,
      item_type TEXT NOT NULL, message_id TEXT, session_id TEXT, agent_run_id TEXT,
      presentation_turn_id TEXT, message_kind TEXT, lifecycle TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(flow_id, channel_id, item_id), UNIQUE(flow_id, channel_id, position),
      FOREIGN KEY(flow_id, channel_id) REFERENCES chat_transcript_channels(flow_id, channel_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_queue_items (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(flow_id, position),
      FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_submissions (
      flow_id TEXT NOT NULL, client_message_id TEXT NOT NULL, submission_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', receipt_state TEXT NOT NULL,
      message_id TEXT, last_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(flow_id, client_message_id), FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
    );
  `);
}

export function migrateToSupervisorSchema(
  sqlite: Database.Database,
  beforeReset?: (sessions: Array<{ runtimeSdk: string | null; sessionId: string }>) => void,
) {
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const version = (sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'supervisor_schema_version'")
    .get() as { value?: string } | undefined)?.value;
  if (version === SUPERVISOR_SCHEMA_VERSION) {
    createSupervisorTables(sqlite);
    return { reset: false };
  }

  const sessions = hasTable(sqlite, "agent_runs") && hasColumn(sqlite, "agent_runs", "session_id")
    ? sqlite.prepare(`
        SELECT ${hasColumn(sqlite, "agent_runs", "runtime_sdk") ? "runtime_sdk" : "NULL"} AS runtimeSdk,
          session_id AS sessionId FROM agent_runs WHERE session_id IS NOT NULL AND session_id <> ''
      `).all() as Array<{ runtimeSdk: string | null; sessionId: string }>
    : [];
  beforeReset?.(sessions);

  sqlite.transaction(() => {
    for (const table of FLOW_DATA_TABLES) sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const table of LEGACY_TABLES) sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
    createSupervisorTables(sqlite);
    sqlite.prepare(`
      INSERT INTO app_metadata (key, value, updated_at) VALUES ('supervisor_schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SUPERVISOR_SCHEMA_VERSION, new Date().toISOString());
    sqlite.prepare("DELETE FROM app_metadata WHERE key IN ('execution_model_version', 'runtime_message_protocol_version')").run();
  })();
  return { reset: true };
}

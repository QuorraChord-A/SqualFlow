import crypto from "node:crypto";
import fs from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { openDatabase } from "./client.js";
import type { DecisionAnswers } from "../domain/types.js";
import type { CurrentTurnInput } from "../mcp/leaderServer.js";
import {
  agentSessions,
  artifacts,
  decisionCardLeaderInputs,
  decisionCards,
  eventLog,
  flowExperts,
  flowReadStates,
  experts,
  flows,
  orchestrationPlans,
  orchestrationRules,
  planApprovals,
  planDependencies,
  planFeedback,
  planNodes,
  planNodeTasks,
  planRevisions,
  planRuns,
  projects,
  specApprovals,
  specRevisions,
  tasks,
  taskDependencies,
  workRuns,
} from "./schema.js";
import { seedExpertsIntoStore } from "./seedExperts.js";
import type { ContextUsageCategory } from "../domain/contextUsage.js";
import { parsePersonNameCandidates, pickPersonDisplayName } from "../domain/expertIdentity.js";

export type AgentContextUsageSnapshotRow = {
  id: string;
  flowId: string;
  agentSessionId: string;
  sdkSessionId: string | null;
  role: string;
  expertId: string | null;
  flowExpertId: string | null;
  totalTokens: number | null;
  maxTokens: number | null;
  rawMaxTokens: number | null;
  percentage: number | null;
  model: string | null;
  categoriesJson: string;
  cacheInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheHitRate: number | null;
  compacted: number;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalTimelineItemType = "message" | "session_boundary" | "context_compaction";

export type CanonicalMessageKind =
  | "user"
  | "assistant"
  | "assistant-continuation"
  | "running-guide"
  | "work-run-terminal";

export type CanonicalTimelineItem = {
  flowId: string;
  channelId: string;
  itemId: string;
  position: number;
  itemType: CanonicalTimelineItemType;
  messageId: string | null;
  sessionId: string | null;
  agentSessionId: string | null;
  workRunId: string | null;
  presentationTurnId: string | null;
  messageKind: CanonicalMessageKind | null;
  lifecycle: "active" | "complete" | "sealed";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalQueueItem = {
  id: string;
  flowId: string;
  position: number;
  status: "accepted" | "dispatching";
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalSubmission = {
  flowId: string;
  clientMessageId: string;
  submissionType: "normal" | "guide";
  payloadHash: string;
  payload: Record<string, unknown>;
  receiptState: "received" | "dispatching" | "materialized" | "rejected" | "cancelled" | "uncertain";
  messageId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionAcceptance =
  | { outcome: "created"; submission: CanonicalSubmission }
  | { outcome: "duplicate"; submission: CanonicalSubmission }
  | { outcome: "conflict"; submission: CanonicalSubmission };

type CanonicalSubmissionRow = Omit<CanonicalSubmission, "payload"> & { payloadJson: string };

export type WorkRunStatus =
  | "ready"
  | "executing"
  | "waiting_user"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentSessionStatus = "queued" | "streaming" | "completed" | "failed" | "interrupted";

const OPEN_WORK_RUN_STATUSES = new Set<WorkRunStatus>([
  "ready",
  "executing",
  "waiting_user",
  "interrupted",
]);

const ACTIVE_AGENT_SESSION_STATUSES = new Set<AgentSessionStatus>(["queued", "streaming"]);

function canonicalSubmissionFromRow(row: CanonicalSubmissionRow): CanonicalSubmission {
  const { payloadJson, ...submission } = row;
  const receiptState = ["received", "dispatching", "materialized", "rejected", "cancelled", "uncertain"].includes(submission.receiptState)
    ? submission.receiptState
    : "uncertain";
  return {
    ...submission,
    submissionType: submission.submissionType === "guide" ? "guide" : "normal",
    receiptState: receiptState as CanonicalSubmission["receiptState"],
    payload: parseJsonObject(payloadJson),
  };
}

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function agentContextUsageSnapshotFromDb(row: Record<string, unknown>): AgentContextUsageSnapshotRow {
  return {
    id: String(row.id ?? ""),
    flowId: String(row.flow_id ?? ""),
    agentSessionId: String(row.agent_session_id ?? ""),
    sdkSessionId: typeof row.sdk_session_id === "string" ? row.sdk_session_id : null,
    role: String(row.role ?? ""),
    expertId: typeof row.expert_id === "string" ? row.expert_id : null,
    flowExpertId: typeof row.flow_expert_id === "string" ? row.flow_expert_id : null,
    totalTokens: typeof row.total_tokens === "number" ? row.total_tokens : null,
    maxTokens: typeof row.max_tokens === "number" ? row.max_tokens : null,
    rawMaxTokens: typeof row.raw_max_tokens === "number" ? row.raw_max_tokens : null,
    percentage: typeof row.percentage === "number" ? row.percentage : null,
    model: typeof row.model === "string" ? row.model : null,
    categoriesJson: typeof row.categories_json === "string" ? row.categories_json : "[]",
    cacheInputTokens: typeof row.cache_input_tokens === "number" ? row.cache_input_tokens : null,
    cacheReadInputTokens: typeof row.cache_read_input_tokens === "number" ? row.cache_read_input_tokens : null,
    cacheCreationInputTokens: typeof row.cache_creation_input_tokens === "number" ? row.cache_creation_input_tokens : null,
    cacheHitRate: typeof row.cache_hit_rate === "number" ? row.cache_hit_rate : null,
    compacted: typeof row.compacted === "number" ? row.compacted : 0,
    observedAt: String(row.observed_at ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function hasColumn(sqlite: ReturnType<typeof openDatabase>["sqlite"], tableName: string, columnName: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function hasTable(sqlite: ReturnType<typeof openDatabase>["sqlite"], tableName: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function dropColumnIfExists(
  sqlite: ReturnType<typeof openDatabase>["sqlite"],
  tableName: string,
  columnName: string,
) {
  if (!hasColumn(sqlite, tableName, columnName)) return;
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  const remaining = columns.filter((col) => col.name !== columnName);
  if (remaining.length === 0) {
    sqlite.exec(`DROP TABLE ${tableName}`);
    return;
  }
  const columnDefs = remaining
    .map((col) => {
      let def = `${col.name} ${col.type}`;
      if (col.pk) def += " PRIMARY KEY";
      if (col.notnull) def += " NOT NULL";
      if (col.dflt_value !== null) def += ` DEFAULT ${col.dflt_value}`;
      return def;
    })
    .join(", ");
  const columnNames = remaining.map((col) => col.name).join(", ");
  const tempTable = `${tableName}_tmp`;
  sqlite.exec(`
    CREATE TABLE ${tempTable} (${columnDefs});
    INSERT INTO ${tempTable} (${columnNames}) SELECT ${columnNames} FROM ${tableName};
    DROP TABLE ${tableName};
    ALTER TABLE ${tempTable} RENAME TO ${tableName};
  `);
}

function addColumnIfMissing(
  sqlite: ReturnType<typeof openDatabase>["sqlite"],
  tableName: string,
  columnName: string,
  definition: string,
) {
  if (!hasColumn(sqlite, tableName, columnName)) {
    sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function elapsedMs(startedAt: string | null, endedAt: string): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function rebuildPlanNodeTasksWithoutTaskUnique(sqlite: ReturnType<typeof openDatabase>["sqlite"]) {
  const indexes = sqlite.prepare("PRAGMA index_list(plan_node_tasks)").all() as Array<{ name: string; unique: number }>;
  const hasTaskUniqueIndex = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string | null }>;
    return columns.length === 1 && columns[0]?.name === "task_id";
  });
  if (!hasTaskUniqueIndex) return;

  sqlite.exec(`
    CREATE TABLE plan_node_tasks_tmp (
      plan_run_id TEXT NOT NULL,
      plan_node_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'created',
      created_at TEXT NOT NULL,
      PRIMARY KEY(plan_run_id, plan_node_id)
    );
    INSERT INTO plan_node_tasks_tmp (plan_run_id, plan_node_id, task_id, disposition, created_at)
      SELECT plan_run_id, plan_node_id, task_id, disposition, created_at FROM plan_node_tasks;
    DROP TABLE plan_node_tasks;
    ALTER TABLE plan_node_tasks_tmp RENAME TO plan_node_tasks;
  `);
}

function rebuildPlanApprovalsWithoutLegacyPolicy(sqlite: ReturnType<typeof openDatabase>["sqlite"]) {
  if (!hasColumn(sqlite, "plan_approvals", "policy") && !hasColumn(sqlite, "plan_approvals", "reason_json")) return;
  sqlite.exec(`
    CREATE TABLE plan_approvals_tmp (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      work_run_id TEXT NOT NULL,
      plan_revision_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution_action_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    INSERT INTO plan_approvals_tmp (
      id, flow_id, work_run_id, plan_revision_id, status,
      resolution_action_id, created_at, resolved_at
    )
    SELECT
      id, flow_id, work_run_id, plan_revision_id, status,
      resolution_action_id, created_at, resolved_at
    FROM plan_approvals;
    DROP TABLE plan_approvals;
    ALTER TABLE plan_approvals_tmp RENAME TO plan_approvals;
  `);
}

function rebuildProjectsWithoutWorkspace(sqlite: ReturnType<typeof openDatabase>["sqlite"]) {
  if (!hasColumn(sqlite, "projects", "workspace_id")) return;
  sqlite.exec(`
    CREATE TABLE projects_tmp (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO projects_tmp (id, name, local_path, description, created_at, updated_at)
    SELECT id, name, local_path, description, created_at, updated_at FROM projects;
    DROP TABLE projects;
    ALTER TABLE projects_tmp RENAME TO projects;
  `);
}

function rebuildFlowsWithoutWorkspace(sqlite: ReturnType<typeof openDatabase>["sqlite"]) {
  if (!hasColumn(sqlite, "flows", "workspace_id")) return;
  const legacySpecExpression = hasColumn(sqlite, "flows", "agent_mode")
    ? "CASE WHEN agent_mode = 'spec' THEN 1 ELSE 0 END"
    : "0";
  sqlite.exec(`
    CREATE TABLE flows_tmp (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      name_generation_status TEXT NOT NULL DEFAULT 'generated',
      status TEXT NOT NULL DEFAULT 'ready',
      legacy_spec_flow INTEGER NOT NULL DEFAULT 0,
      risk_mode TEXT NOT NULL DEFAULT 'auto_edit',
      plan_approval TEXT NOT NULL DEFAULT 'on',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      last_output_completed_at TEXT,
      leader_session_id TEXT,
      leader_runtime_sdk TEXT,
      leader_runtime_config_id TEXT,
      leader_runtime_model_id TEXT,
      leader_runtime_reasoning_effort TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO flows_tmp (
      id, project_id, name, description, name_generation_status, status, legacy_spec_flow, risk_mode, plan_approval, is_pinned,
      last_output_completed_at, leader_session_id, leader_runtime_sdk,
      leader_runtime_config_id, leader_runtime_model_id, leader_runtime_reasoning_effort,
      created_at, updated_at
    )
    SELECT
      id, project_id, name, description, 'generated', status, ${legacySpecExpression}, risk_mode, plan_approval, is_pinned,
      last_output_completed_at, leader_session_id, NULL, leader_runtime_config_id,
      leader_runtime_model_id, leader_runtime_reasoning_effort, created_at, updated_at
    FROM flows;
    DROP TABLE flows;
    ALTER TABLE flows_tmp RENAME TO flows;
  `);
}

export function createStore(databasePath: string) {
  const { sqlite, db } = openDatabase(databasePath);
  const syncFlowExecutionStatus = (flowId: string, timestamp = now()) => {
    const hasActiveSession = db.select().from(agentSessions).where(eq(agentSessions.flowId, flowId)).all()
      .some((session) => ACTIVE_AGENT_SESSION_STATUSES.has(session.status as AgentSessionStatus));
    db.update(flows)
      .set({ status: hasActiveSession ? "active" : "idle", updatedAt: timestamp })
      .where(eq(flows.id, flowId))
      .run();
  };
  const beginWorkRunExecution = (workRunId: string, timestamp = now()) => {
    const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
    if (!existing || !["ready", "executing"].includes(existing.status)) return existing;
    if (existing.status === "executing") return existing;
    db.update(workRuns)
      .set({
        status: "executing",
        revision: existing.revision + 1,
        executionStartedAt: existing.executionStartedAt ?? timestamp,
        activeStartedAt: timestamp,
        waitingStartedAt: null,
        updatedAt: timestamp,
      })
      .where(and(eq(workRuns.id, workRunId), eq(workRuns.revision, existing.revision)))
      .run();
    return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
  };
  const clearAllFlowData = () => {
    sqlite.exec(`
      DELETE FROM chat_queue_items;
      DELETE FROM chat_submissions;
      DELETE FROM chat_timeline_items;
      DELETE FROM chat_transcript_channels;
      DELETE FROM task_dependencies;
      DELETE FROM tasks;
      DELETE FROM agent_sessions;
      DELETE FROM agent_context_usage_snapshots;
      DELETE FROM flow_experts;
      DELETE FROM decision_cards;
      DELETE FROM decision_card_leader_inputs;
      DELETE FROM flow_read_states;
      DELETE FROM work_run_reviews;
      DELETE FROM work_run_touched_files;
      DELETE FROM work_run_file_attributions;
      DELETE FROM change_baselines;
      DELETE FROM work_runs;
      DELETE FROM artifacts;
      DELETE FROM spec_revisions;
      DELETE FROM spec_approvals;
      DELETE FROM event_log;
      DELETE FROM plan_node_tasks;
      DELETE FROM plan_dependencies;
      DELETE FROM plan_nodes;
      DELETE FROM plan_feedback;
      DELETE FROM plan_approvals;
      DELETE FROM plan_runs;
      DELETE FROM plan_revisions;
      DELETE FROM orchestration_plans;
      DELETE FROM orchestration_rules;
      DELETE FROM flows;
    `);
  };

  return {
    sqlite,
    db,
    migrate(options: {
      beforeRuntimeMessageProtocolReset?: (
        sessions: Array<{ runtimeSdk: string | null; sessionId: string }>,
      ) => void;
    } = {}) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const executionModelKey = "execution_model_version";
      const executionModelVersion = sqlite
        .prepare("SELECT value FROM app_metadata WHERE key = ?")
        .get(executionModelKey) as { value?: string } | undefined;
      if (executionModelVersion?.value !== "5") {
        const nativeSessions = hasTable(sqlite, "agent_sessions")
          && hasColumn(sqlite, "agent_sessions", "session_id")
          ? sqlite.prepare(`
              SELECT ${hasColumn(sqlite, "agent_sessions", "runtime_sdk") ? "runtime_sdk" : "NULL"} AS runtimeSdk,
                     session_id AS sessionId
              FROM agent_sessions
              WHERE session_id IS NOT NULL AND session_id <> ''
            `).all() as Array<{ runtimeSdk: string | null; sessionId: string }>
          : [];
        options.beforeRuntimeMessageProtocolReset?.(nativeSessions);
        sqlite.transaction(() => {
          sqlite.exec(`
            DROP TABLE IF EXISTS chat_queue_items;
            DROP TABLE IF EXISTS chat_submissions;
            DROP TABLE IF EXISTS chat_messages;
            DROP TABLE IF EXISTS chat_timeline_items;
            DROP TABLE IF EXISTS chat_transcript_channels;
            DROP TABLE IF EXISTS task_dependencies;
            DROP TABLE IF EXISTS tasks;
            DROP TABLE IF EXISTS agent_sessions;
            DROP TABLE IF EXISTS agent_context_usage_snapshots;
            DROP TABLE IF EXISTS flow_experts;
            DROP TABLE IF EXISTS decision_cards;
            DROP TABLE IF EXISTS decision_card_leader_inputs;
            DROP TABLE IF EXISTS flow_read_states;
            DROP TABLE IF EXISTS work_run_reviews;
            DROP TABLE IF EXISTS work_run_touched_files;
            DROP TABLE IF EXISTS work_run_file_attributions;
            DROP TABLE IF EXISTS change_baselines;
            DROP TABLE IF EXISTS user_turn_reviews;
            DROP TABLE IF EXISTS work_runs;
            DROP TABLE IF EXISTS user_turns;
            DROP TABLE IF EXISTS artifacts;
            DROP TABLE IF EXISTS spec_revisions;
            DROP TABLE IF EXISTS spec_approvals;
            DROP TABLE IF EXISTS event_log;
            DROP TABLE IF EXISTS plan_node_tasks;
            DROP TABLE IF EXISTS plan_dependencies;
            DROP TABLE IF EXISTS plan_nodes;
            DROP TABLE IF EXISTS plan_feedback;
            DROP TABLE IF EXISTS plan_approvals;
            DROP TABLE IF EXISTS plan_runs;
            DROP TABLE IF EXISTS plan_revisions;
            DROP TABLE IF EXISTS orchestration_plans;
            DROP TABLE IF EXISTS flows;
          `);
          sqlite.prepare(`
            INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `).run(executionModelKey, "5", now());
        })();
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, description TEXT, name_generation_status TEXT NOT NULL DEFAULT 'generated', status TEXT NOT NULL DEFAULT 'ready', legacy_spec_flow INTEGER NOT NULL DEFAULT 0, risk_mode TEXT NOT NULL DEFAULT 'auto_edit', plan_approval TEXT NOT NULL DEFAULT 'on', is_pinned INTEGER NOT NULL DEFAULT 0, last_output_completed_at TEXT, leader_session_id TEXT, leader_runtime_sdk TEXT, leader_runtime_config_id TEXT, leader_runtime_model_id TEXT, leader_runtime_reasoning_effort TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        DROP TABLE IF EXISTS flow_runs;
        DROP TABLE IF EXISTS flow_phases;
        DROP TABLE IF EXISTS flow_tasks;
        DROP TABLE IF EXISTS team_messages;
        DROP TABLE IF EXISTS agent_inbox;
        DROP TABLE IF EXISTS send_messages;
        DROP TABLE IF EXISTS teams;
        DROP TABLE IF EXISTS session_log;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          work_run_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          expert_id TEXT,
          flow_expert_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          revision INTEGER NOT NULL DEFAULT 1,
          active_form TEXT NOT NULL DEFAULT '',
          progress TEXT,
          agent_session_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
          result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
          result_json TEXT,
          error_message TEXT,
          created_by_agent_session_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS spec_revisions (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          title TEXT NOT NULL,
          overview TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          source_agent_session_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          approved_at TEXT,
          executed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS spec_approvals (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          spec_revision_id TEXT NOT NULL,
          work_run_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          file_name TEXT NOT NULL,
          overview TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL,
          depends_on_task_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, depends_on_task_id)
        );
        CREATE TABLE IF NOT EXISTS orchestration_plans (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT NOT NULL UNIQUE, spec_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plan_revisions (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision_number INTEGER NOT NULL, parent_revision_id TEXT, source_feedback_message_id TEXT, status TEXT NOT NULL DEFAULT 'generating', title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', work_kind TEXT NOT NULL DEFAULT 'change', risk_level TEXT NOT NULL DEFAULT 'medium', lint_json TEXT NOT NULL DEFAULT '[]', diff_json TEXT NOT NULL DEFAULT '{}', source_agent_session_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, approved_at TEXT, superseded_at TEXT, UNIQUE(plan_id, revision_number));
        CREATE TABLE IF NOT EXISTS plan_nodes (id TEXT PRIMARY KEY, plan_revision_id TEXT NOT NULL, stable_key TEXT NOT NULL, expert_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]', risk_tags_json TEXT NOT NULL DEFAULT '[]', side_effects_json TEXT NOT NULL DEFAULT '[]', resource_keys_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE(plan_revision_id, stable_key));
        CREATE TABLE IF NOT EXISTS plan_dependencies (plan_revision_id TEXT NOT NULL, node_id TEXT NOT NULL, depends_on_node_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(plan_revision_id, node_id, depends_on_node_id));
        CREATE TABLE IF NOT EXISTS plan_approvals (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', resolution_action_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE IF NOT EXISTS plan_feedback (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL, plan_node_id TEXT, source_message_id TEXT NOT NULL, marker_number INTEGER NOT NULL, comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resolution_note TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE IF NOT EXISTS plan_runs (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plan_node_tasks (plan_run_id TEXT NOT NULL, plan_node_id TEXT NOT NULL, task_id TEXT NOT NULL, disposition TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL, PRIMARY KEY(plan_run_id, plan_node_id));
        CREATE TABLE IF NOT EXISTS orchestration_rules (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warn', enabled INTEGER NOT NULL DEFAULT 1, rule_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS event_log (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          work_run_id TEXT,
          task_id TEXT,
          agent_session_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS experts (id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, person_name_candidates TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL, builtin_tools TEXT NOT NULL DEFAULT '[]', mcp_tools TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS flow_experts (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          expert_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'idle',
          sdk_session_id TEXT,
          runtime_sdk TEXT,
          runtime_config_id TEXT,
          runtime_model_id TEXT,
          runtime_reasoning_effort TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS flow_experts_flow_id_expert_id_unique
          ON flow_experts(flow_id, expert_id);
        CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT, task_id TEXT, expert_id TEXT NOT NULL, flow_expert_id TEXT, session_id TEXT, runtime_sdk TEXT, runtime_config_id TEXT, runtime_model_id TEXT, runtime_reasoning_effort TEXT, display_name TEXT NOT NULL DEFAULT '', resume_from_agent_session_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_context_usage_snapshots (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          sdk_session_id TEXT,
          role TEXT NOT NULL,
          expert_id TEXT,
          flow_expert_id TEXT,
          total_tokens INTEGER,
          max_tokens INTEGER,
          raw_max_tokens INTEGER,
          percentage REAL,
          model TEXT,
          categories_json TEXT NOT NULL DEFAULT '[]',
          cache_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_hit_rate REAL,
          compacted INTEGER NOT NULL DEFAULT 0,
          observed_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS agent_context_usage_snapshots_agent_session_unique
          ON agent_context_usage_snapshots(agent_session_id);
        CREATE INDEX IF NOT EXISTS agent_context_usage_snapshots_flow_idx
          ON agent_context_usage_snapshots(flow_id, role, updated_at);
        CREATE TABLE IF NOT EXISTS decision_cards (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT, session_id TEXT NOT NULL DEFAULT '', card_type TEXT NOT NULL DEFAULT 'generic', questions TEXT NOT NULL, answers TEXT, status TEXT NOT NULL DEFAULT 'pending', resolution_kind TEXT NOT NULL DEFAULT '', resolution_action_id TEXT, resolved_message_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE IF NOT EXISTS decision_card_leader_inputs (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          card_id TEXT NOT NULL,
          client_action_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sent_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS decision_card_leader_inputs_action_unique
          ON decision_card_leader_inputs(flow_id, card_id, client_action_id);
        CREATE TABLE IF NOT EXISTS flow_read_states (flow_id TEXT NOT NULL, viewer_id TEXT NOT NULL DEFAULT 'local-default', last_read_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, viewer_id));
        CREATE TABLE IF NOT EXISTS work_run_reviews (
          work_run_id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          anchor_message_id TEXT NOT NULL,
          status TEXT NOT NULL,
          review_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_run_reviews_flow_idx
          ON work_run_reviews(flow_id, updated_at);
        CREATE TABLE IF NOT EXISTS work_run_file_attributions (
          work_run_id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_run_file_attributions_flow_idx
          ON work_run_file_attributions(flow_id, updated_at);
        CREATE TABLE IF NOT EXISTS work_run_touched_files (
          work_run_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          sources_json TEXT NOT NULL,
          agent_session_ids_json TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (work_run_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS work_run_touched_files_work_run_idx
          ON work_run_touched_files(work_run_id, relative_path);
        CREATE TABLE IF NOT EXISTS change_baselines (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          source_agent_session_id TEXT NOT NULL UNIQUE,
          work_run_id TEXT UNIQUE,
          root_path TEXT NOT NULL,
          snapshot_path TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS change_baselines_flow_idx
          ON change_baselines(flow_id, created_at);
        CREATE TABLE IF NOT EXISTS work_runs (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          trigger_message_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready',
          revision INTEGER NOT NULL DEFAULT 1,
          started_at TEXT NOT NULL,
          execution_started_at TEXT,
          active_started_at TEXT,
          active_duration_ms INTEGER NOT NULL DEFAULT 0,
          waiting_started_at TEXT,
          completed_at TEXT,
          work_source TEXT,
          spec_revision_id TEXT,
          target_project_id TEXT,
          work_root_path TEXT NOT NULL DEFAULT '',
          input_snapshot_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, work_run_id TEXT, task_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source_agent_session_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_transcript_channels (
          flow_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          cursor INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (flow_id, channel_id)
        );
        CREATE TABLE IF NOT EXISTS chat_timeline_items (
          flow_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          item_type TEXT NOT NULL,
          message_id TEXT,
          session_id TEXT,
          agent_session_id TEXT,
          work_run_id TEXT,
          presentation_turn_id TEXT,
          message_kind TEXT,
          lifecycle TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (flow_id, channel_id, item_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS chat_timeline_items_channel_position_unique
          ON chat_timeline_items(flow_id, channel_id, position);
        CREATE INDEX IF NOT EXISTS chat_timeline_items_session_idx
          ON chat_timeline_items(flow_id, session_id, position);
        CREATE INDEX IF NOT EXISTS chat_timeline_items_agent_session_idx
          ON chat_timeline_items(agent_session_id, position);
        CREATE INDEX IF NOT EXISTS chat_timeline_items_work_run_idx
          ON chat_timeline_items(work_run_id, position);
        CREATE TABLE IF NOT EXISTS chat_queue_items (
          id TEXT NOT NULL,
          flow_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'accepted',
          revision INTEGER NOT NULL DEFAULT 1,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (flow_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS chat_queue_items_flow_position_unique
          ON chat_queue_items(flow_id, position);
        CREATE TABLE IF NOT EXISTS chat_submissions (
          flow_id TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          submission_type TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          receipt_state TEXT NOT NULL,
          message_id TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (flow_id, client_message_id)
        );
        CREATE INDEX IF NOT EXISTS chat_submissions_state_idx
          ON chat_submissions(flow_id, receipt_state, updated_at);
      `);
      addColumnIfMissing(sqlite, "projects", "updated_at", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "chat_queue_items", "revision", "INTEGER NOT NULL DEFAULT 1");
      dropColumnIfExists(sqlite, "projects", "agent_type");
      addColumnIfMissing(sqlite, "flows", "is_pinned", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(sqlite, "flows", "last_output_completed_at", "TEXT");
      addColumnIfMissing(sqlite, "flows", "name_generation_status", "TEXT NOT NULL DEFAULT 'generated'");
      addColumnIfMissing(sqlite, "tasks", "active_form", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "tasks", "progress", "TEXT");
      addColumnIfMissing(sqlite, "tasks", "flow_expert_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "work_run_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "flow_expert_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "task_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "runtime_sdk", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "runtime_config_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "runtime_model_id", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "runtime_reasoning_effort", "TEXT");
      addColumnIfMissing(sqlite, "agent_sessions", "display_name", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "agent_sessions", "resume_from_agent_session_id", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "agent_sessions", "status", "TEXT NOT NULL DEFAULT 'queued'");
      addColumnIfMissing(sqlite, "agent_sessions", "updated_at", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "decision_cards", "session_id", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "decision_cards", "work_run_id", "TEXT");
      addColumnIfMissing(sqlite, "decision_cards", "card_type", "TEXT NOT NULL DEFAULT 'generic'");
      addColumnIfMissing(sqlite, "decision_cards", "resolution_kind", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "decision_cards", "resolution_action_id", "TEXT");
      addColumnIfMissing(sqlite, "decision_cards", "resolved_message_id", "TEXT");
      addColumnIfMissing(sqlite, "decision_cards", "resolved_at", "TEXT");
      addColumnIfMissing(sqlite, "artifacts", "task_id", "TEXT");
      addColumnIfMissing(sqlite, "artifacts", "work_run_id", "TEXT");
      addColumnIfMissing(sqlite, "artifacts", "source_agent_session_id", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "artifacts", "updated_at", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "event_log", "task_id", "TEXT");
      addColumnIfMissing(sqlite, "event_log", "work_run_id", "TEXT");
      addColumnIfMissing(sqlite, "event_log", "agent_session_id", "TEXT");
      addColumnIfMissing(sqlite, "flows", "legacy_spec_flow", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(sqlite, "flows", "risk_mode", "TEXT NOT NULL DEFAULT 'auto_edit'");
      addColumnIfMissing(sqlite, "flows", "plan_approval", "TEXT NOT NULL DEFAULT 'on'");
      addColumnIfMissing(sqlite, "flows", "leader_runtime_sdk", "TEXT");
      addColumnIfMissing(sqlite, "flows", "leader_runtime_config_id", "TEXT");
      addColumnIfMissing(sqlite, "flows", "leader_runtime_model_id", "TEXT");
      addColumnIfMissing(sqlite, "flows", "leader_runtime_reasoning_effort", "TEXT");
      addColumnIfMissing(sqlite, "flow_experts", "runtime_sdk", "TEXT");
      addColumnIfMissing(sqlite, "flow_experts", "runtime_config_id", "TEXT");
      addColumnIfMissing(sqlite, "flow_experts", "runtime_model_id", "TEXT");
      addColumnIfMissing(sqlite, "flow_experts", "runtime_reasoning_effort", "TEXT");
      addColumnIfMissing(sqlite, "experts", "person_name_candidates", "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(sqlite, "spec_approvals", "work_run_id", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "active_started_at", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "revision", "INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(sqlite, "work_runs", "execution_started_at", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "active_duration_ms", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(sqlite, "work_runs", "waiting_started_at", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "completed_at", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "work_source", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "spec_revision_id", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "target_project_id", "TEXT");
      addColumnIfMissing(sqlite, "work_runs", "work_root_path", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "work_runs", "input_snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing(sqlite, "spec_revisions", "overview", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "spec_revisions", "file_name", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(sqlite, "tasks", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
      addColumnIfMissing(sqlite, "tasks", "revision", "INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing(sqlite, "agent_context_usage_snapshots", "cache_input_tokens", "INTEGER");
      addColumnIfMissing(sqlite, "agent_context_usage_snapshots", "cache_read_input_tokens", "INTEGER");
      addColumnIfMissing(sqlite, "agent_context_usage_snapshots", "cache_creation_input_tokens", "INTEGER");
      addColumnIfMissing(sqlite, "agent_context_usage_snapshots", "cache_hit_rate", "REAL");
      rebuildPlanNodeTasksWithoutTaskUnique(sqlite);
      rebuildPlanApprovalsWithoutLegacyPolicy(sqlite);
      rebuildProjectsWithoutWorkspace(sqlite);
      rebuildFlowsWithoutWorkspace(sqlite);
      if (hasColumn(sqlite, "flows", "agent_mode")) {
        sqlite.prepare("UPDATE flows SET legacy_spec_flow = CASE WHEN agent_mode = 'spec' THEN 1 ELSE legacy_spec_flow END").run();
        dropColumnIfExists(sqlite, "flows", "agent_mode");
      }
      if (hasTable(sqlite, "orchestration_settings")) {
        sqlite.exec(`
          UPDATE flows
          SET
            risk_mode = CASE (
              SELECT approval_policy FROM orchestration_settings
              WHERE scope_type = 'flow' AND scope_id = flows.id
            ) WHEN 'auto' THEN 'full_access' ELSE 'auto_edit' END,
            plan_approval = CASE (
              SELECT approval_policy FROM orchestration_settings
              WHERE scope_type = 'flow' AND scope_id = flows.id
            ) WHEN 'auto' THEN 'off' ELSE 'on' END;
          DROP TABLE orchestration_settings;
        `);
      }
      sqlite.exec("DROP TABLE IF EXISTS scoped_authorizations");
      sqlite.prepare("UPDATE tasks SET status = 'pending' WHERE status = 'ready'").run();
      sqlite.prepare("UPDATE tasks SET status = 'in_progress' WHERE status = 'running'").run();
      sqlite.prepare("UPDATE tasks SET status = 'in_progress' WHERE status IN ('queued_for_expert', 'recovery_pending')").run();
      sqlite.exec(`
        DROP TABLE IF EXISTS workspaces;
        CREATE UNIQUE INDEX IF NOT EXISTS work_runs_one_open_per_flow ON work_runs(flow_id)
          WHERE status IN ('ready', 'executing', 'waiting_user', 'interrupted');
      `);
      const protocolMigrationKey = "runtime_message_protocol_version";
      const protocolVersion = sqlite
        .prepare("SELECT value FROM app_metadata WHERE key = ?")
        .get(protocolMigrationKey) as { value?: string } | undefined;
      if (protocolVersion?.value !== "2") {
        const nativeSessions = sqlite.prepare(`
          SELECT runtime_sdk AS runtimeSdk, session_id AS sessionId
          FROM agent_sessions
          WHERE session_id IS NOT NULL AND session_id <> ''
        `).all() as Array<{ runtimeSdk: string | null; sessionId: string }>;
        options.beforeRuntimeMessageProtocolReset?.(nativeSessions);
        sqlite.transaction(() => {
          clearAllFlowData();
          sqlite.prepare(`
            INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `).run(protocolMigrationKey, "2", now());
        })();
      }
      const canonicalTranscriptMigrationKey = "canonical_transcript_version";
      const canonicalTranscriptVersion = sqlite
        .prepare("SELECT value FROM app_metadata WHERE key = ?")
        .get(canonicalTranscriptMigrationKey) as { value?: string } | undefined;
      if (canonicalTranscriptVersion?.value !== "3") {
        sqlite.transaction(() => {
          clearAllFlowData();
          sqlite.prepare(`
            INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `).run(canonicalTranscriptMigrationKey, "3", now());
        })();
      }
    },
    seedExperts() {
      seedExpertsIntoStore(db);
    },
    // Projects are the top-level local folders shown as workspaces in the UI.
    createProject(input: { id?: string; name: string; localPath: string; description?: string | null }) {
      const timestamp = now();
      const row = {
        id: input.id ?? id("proj"),
        name: input.name,
        localPath: input.localPath,
        description: input.description ?? "",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.insert(projects).values(row).run();
      return db.select().from(projects).where(eq(projects.id, row.id)).get()!;
    },
    listProjects() {
      return db.select().from(projects).all();
    },
    getProject(projectId: string) {
      return db.select().from(projects).where(eq(projects.id, projectId)).get();
    },
    updateProject(projectId: string, input: { name?: string; localPath?: string; description?: string | null }) {
      const existing = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!existing) return undefined;
      db.update(projects)
        .set({
          name: input.name ?? existing.name,
          localPath: input.localPath ?? existing.localPath,
          description: input.description ?? existing.description ?? "",
          updatedAt: now(),
        })
        .where(eq(projects.id, projectId))
        .run();
      return db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    },
    deleteProject(projectId: string) {
      const result = db.delete(projects).where(eq(projects.id, projectId)).run();
      return result.changes > 0;
    },
    createFlow(input: {
      id?: string;
      name: string;
      description: string;
      nameGenerationStatus?: "pending" | "generated" | "fallback" | "manual";
      projectId: string | null;
      riskMode?: "auto_edit" | "full_access";
      planApproval?: "on" | "off";
      leaderRuntimeSdk?: string | null;
      leaderRuntimeConfigId?: string | null;
      leaderRuntimeModelId?: string | null;
      leaderRuntimeReasoningEffort?: string | null;
    }) {
      const timestamp = now();
      const row = {
        id: input.id ?? id("flow"),
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        nameGenerationStatus: input.nameGenerationStatus ?? "generated",
        status: "ready",
        legacySpecFlow: 0,
        riskMode: input.riskMode ?? "auto_edit",
        planApproval: input.planApproval ?? "on",
        isPinned: 0,
        lastOutputCompletedAt: null,
        leaderSessionId: null,
        leaderRuntimeSdk: input.leaderRuntimeSdk ?? null,
        leaderRuntimeConfigId: input.leaderRuntimeConfigId ?? null,
        leaderRuntimeModelId: input.leaderRuntimeModelId ?? null,
        leaderRuntimeReasoningEffort: input.leaderRuntimeReasoningEffort ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.insert(flows).values(row).run();
      // Do not pre-create FlowExperts: team UI only shows experts after they are first used.
      return db.select().from(flows).where(eq(flows.id, row.id)).get()!;
    },
    listFlows(projectId?: string) {
      if (projectId) return db.select().from(flows).where(eq(flows.projectId, projectId)).all();
      return db.select().from(flows).all();
    },
    assignUnboundFlows(projectId: string) {
      const result = sqlite.prepare("UPDATE flows SET project_id = ? WHERE project_id IS NULL OR project_id = ''").run(projectId);
      return result.changes;
    },
    getFlow(flowId: string) {
      return db.select().from(flows).where(eq(flows.id, flowId)).get();
    },
    updateFlow(flowId: string, input: {
      name?: string;
      description?: string | null;
      nameGenerationStatus?: "pending" | "generated" | "fallback" | "manual";
      projectId?: string | null;
      status?: string;
      riskMode?: "auto_edit" | "full_access";
      planApproval?: "on" | "off";
      isPinned?: boolean;
      leaderSessionId?: string | null;
      leaderRuntimeSdk?: string | null;
      leaderRuntimeConfigId?: string | null;
      leaderRuntimeModelId?: string | null;
      leaderRuntimeReasoningEffort?: string | null;
    }) {
      const existing = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!existing) return undefined;
      db.update(flows)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description ?? "",
          nameGenerationStatus: input.nameGenerationStatus ?? existing.nameGenerationStatus,
          projectId: Object.prototype.hasOwnProperty.call(input, "projectId") ? input.projectId ?? null : existing.projectId,
          status: input.status ?? existing.status,
          riskMode: input.riskMode ?? existing.riskMode,
          planApproval: input.planApproval ?? existing.planApproval,
          isPinned: input.isPinned === undefined ? existing.isPinned : Number(input.isPinned),
          leaderSessionId: Object.prototype.hasOwnProperty.call(input, "leaderSessionId") ? input.leaderSessionId ?? null : existing.leaderSessionId,
          leaderRuntimeSdk: Object.prototype.hasOwnProperty.call(input, "leaderRuntimeSdk") ? input.leaderRuntimeSdk ?? null : existing.leaderRuntimeSdk,
          leaderRuntimeConfigId: Object.prototype.hasOwnProperty.call(input, "leaderRuntimeConfigId") ? input.leaderRuntimeConfigId ?? null : existing.leaderRuntimeConfigId,
          leaderRuntimeModelId: Object.prototype.hasOwnProperty.call(input, "leaderRuntimeModelId") ? input.leaderRuntimeModelId ?? null : existing.leaderRuntimeModelId,
          leaderRuntimeReasoningEffort: Object.prototype.hasOwnProperty.call(input, "leaderRuntimeReasoningEffort") ? input.leaderRuntimeReasoningEffort ?? null : existing.leaderRuntimeReasoningEffort,
          updatedAt: now(),
        })
        .where(eq(flows.id, flowId))
        .run();
      return db.select().from(flows).where(eq(flows.id, flowId)).get()!;
    },
    lockFlowLeaderRuntime(flowId: string, input: { runtimeSdk: string; runtimeConfigId: string; runtimeModelId: string }) {
      const existing = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!existing) return undefined;
      if (existing.leaderRuntimeSdk && existing.leaderRuntimeConfigId && existing.leaderRuntimeModelId) return existing;
      db.update(flows)
        .set({
          leaderRuntimeSdk: existing.leaderRuntimeSdk ?? input.runtimeSdk,
          leaderRuntimeConfigId: existing.leaderRuntimeConfigId ?? input.runtimeConfigId,
          leaderRuntimeModelId: existing.leaderRuntimeModelId ?? input.runtimeModelId,
          updatedAt: now(),
        })
        .where(eq(flows.id, flowId))
        .run();
      return db.select().from(flows).where(eq(flows.id, flowId)).get()!;
    },
    markFlowOutputCompleted(flowId: string, timestamp = now()) {
      const existing = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!existing) return undefined;
      db.update(flows)
        .set({ lastOutputCompletedAt: timestamp, updatedAt: timestamp })
        .where(eq(flows.id, flowId))
        .run();
      return db.select().from(flows).where(eq(flows.id, flowId)).get()!;
    },
    commitTimelineMutation(input: {
      flowId: string;
      channelId: string;
      sessionId: string;
      agentSessionId: string;
      messages: Array<{ message: Record<string, unknown>; lifecycle: "active" | "complete" | "sealed" }>;
      removedMessageIds?: string[];
    }) {
      const timestamp = now();
      return sqlite.transaction(() => {
        const committedItemIds = new Set<string>();
        const channel = sqlite.prepare(`
          SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?
        `).get(input.flowId, input.channelId) as { cursor: number } | undefined;
        const cursor = (channel?.cursor ?? 0) + 1;
        sqlite.prepare(`
          INSERT INTO chat_transcript_channels (flow_id, channel_id, cursor, revision, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(flow_id, channel_id) DO UPDATE SET
            cursor = excluded.cursor,
            revision = chat_transcript_channels.revision + 1,
            updated_at = excluded.updated_at
        `).run(input.flowId, input.channelId, cursor, timestamp);

        const selectExisting = sqlite.prepare(`
          SELECT position, session_id AS sessionId, agent_session_id AS agentSessionId,
            work_run_id AS workRunId, presentation_turn_id AS presentationTurnId,
            message_kind AS messageKind, lifecycle, payload_json AS payloadJson,
            created_at AS createdAt
          FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_id = ? AND item_type = 'message'
        `);
        const selectNextPosition = sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ?
        `);
        const upsert = sqlite.prepare(`
          INSERT INTO chat_timeline_items (
            flow_id, channel_id, item_id, position, item_type, message_id,
            session_id, agent_session_id, work_run_id, presentation_turn_id,
            message_kind, lifecycle, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(flow_id, channel_id, item_id) DO UPDATE SET
            session_id = excluded.session_id,
            agent_session_id = excluded.agent_session_id,
            work_run_id = excluded.work_run_id,
            presentation_turn_id = excluded.presentation_turn_id,
            message_kind = excluded.message_kind,
            lifecycle = excluded.lifecycle,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `);
        const agentSession = sqlite.prepare(`
          SELECT work_run_id AS workRunId, flow_expert_id AS flowExpertId,
            display_name AS displayName, created_at AS createdAt
          FROM agent_sessions WHERE id = ? AND flow_id = ?
        `).get(input.agentSessionId, input.flowId) as {
          workRunId: string | null;
          flowExpertId: string | null;
          displayName: string;
          createdAt: string;
        } | undefined;
        const hasAgentSessionMessage = sqlite.prepare(`
          SELECT 1 FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_type = 'message' AND agent_session_id = ?
          LIMIT 1
        `).get(input.flowId, input.channelId, input.agentSessionId);
        const hasAnyMessage = sqlite.prepare(`
          SELECT 1 FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_type = 'message'
          LIMIT 1
        `).get(input.flowId, input.channelId);
        if (agentSession?.flowExpertId && !hasAgentSessionMessage && hasAnyMessage) {
          const boundaryId = `session-boundary:${input.agentSessionId}`;
          const boundaryPosition = (selectNextPosition.get(input.flowId, input.channelId) as { position: number }).position;
          sqlite.prepare(`
            INSERT OR IGNORE INTO chat_timeline_items (
              flow_id, channel_id, item_id, position, item_type, message_id,
              session_id, agent_session_id, work_run_id, presentation_turn_id,
              message_kind, lifecycle, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'session_boundary', NULL, ?, ?, ?, NULL, NULL, 'complete', ?, ?, ?)
          `).run(
            input.flowId,
            input.channelId,
            boundaryId,
            boundaryPosition,
            input.sessionId,
            input.agentSessionId,
            agentSession.workRunId,
            JSON.stringify({
              flow_expert_id: agentSession.flowExpertId,
              agent_session_id: input.agentSessionId,
              display_name: agentSession.displayName,
              started_at: agentSession.createdAt,
              status: "loaded",
            }),
            agentSession.createdAt,
            timestamp,
          );
          committedItemIds.add(boundaryId);
        }
        for (const item of input.messages) {
          const messageId = typeof item.message.id === "string" ? item.message.id : "";
          if (!messageId) throw new Error("Canonical timeline message is missing an id");
          committedItemIds.add(messageId);
          const metadata = typeof item.message.metadata === "object" && item.message.metadata !== null
            ? item.message.metadata as Record<string, unknown>
            : {};
          const role = item.message.role === "assistant" ? "assistant" : "user";
          const messageKind = typeof metadata.messageKind === "string"
            ? metadata.messageKind
            : role;
          const presentationTurnId = typeof metadata.presentationTurnId === "string"
            ? metadata.presentationTurnId
            : role === "assistant" ? messageId : null;
          const existing = selectExisting.get(input.flowId, input.channelId, messageId) as
            | {
                position: number;
                sessionId: string | null;
                agentSessionId: string | null;
                workRunId: string | null;
                presentationTurnId: string | null;
                messageKind: string | null;
                lifecycle: string;
                payloadJson: string;
                createdAt: string;
              }
            | undefined;
          const position = existing?.position
            ?? (selectNextPosition.get(input.flowId, input.channelId) as { position: number }).position;
          const messageCreatedAt = typeof item.message.createdAt === "string"
            ? item.message.createdAt
            : existing?.createdAt ?? timestamp;
          const payloadJson = JSON.stringify(item.message);
          if (
            existing
            && existing.sessionId === input.sessionId
            && existing.agentSessionId === input.agentSessionId
            && existing.workRunId === (agentSession?.workRunId ?? null)
            && existing.presentationTurnId === presentationTurnId
            && existing.messageKind === messageKind
            && existing.lifecycle === item.lifecycle
            && existing.payloadJson === payloadJson
          ) continue;
          upsert.run(
            input.flowId,
            input.channelId,
            messageId,
            position,
            messageId,
            input.sessionId,
            input.agentSessionId,
            agentSession?.workRunId ?? null,
            presentationTurnId,
            messageKind,
            item.lifecycle,
            payloadJson,
            messageCreatedAt,
            timestamp,
          );
        }
        if (input.removedMessageIds?.length) {
          const remove = sqlite.prepare(`
            DELETE FROM chat_timeline_items
            WHERE flow_id = ? AND channel_id = ? AND item_type = 'message' AND message_id = ?
          `);
          for (const messageId of new Set(input.removedMessageIds)) {
            remove.run(input.flowId, input.channelId, messageId);
          }
        }
        const timelineItems = this.listTimelineItems(input.flowId, input.channelId)
          .filter((item) => committedItemIds.has(item.itemId));
        return { cursor, timelineItems };
      })();
    },
    listTimelineItems(flowId: string, channelId: string): CanonicalTimelineItem[] {
      const rows = sqlite.prepare(`
        SELECT
          flow_id AS flowId,
          channel_id AS channelId,
          item_id AS itemId,
          position,
          item_type AS itemType,
          message_id AS messageId,
          session_id AS sessionId,
          agent_session_id AS agentSessionId,
          work_run_id AS workRunId,
          presentation_turn_id AS presentationTurnId,
          message_kind AS messageKind,
          lifecycle,
          payload_json AS payloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM chat_timeline_items
        WHERE flow_id = ? AND channel_id = ?
        ORDER BY position ASC
      `).all(flowId, channelId) as Array<Omit<CanonicalTimelineItem, "payload"> & { payloadJson: string }>;
      return rows.map(({ payloadJson, ...row }) => ({
        ...row,
        itemType: row.itemType === "session_boundary"
          ? "session_boundary"
          : row.itemType === "context_compaction" ? "context_compaction" : "message",
        lifecycle: row.lifecycle === "active" ? "active" : row.lifecycle === "sealed" ? "sealed" : "complete",
        payload: parseJsonObject(payloadJson),
      }));
    },
    upsertContextCompactionTimelineItem(input: {
      flowId: string;
      channelId: string;
      agentSessionId: string;
      payload: Record<string, unknown> & { started_at: string; status: string };
    }) {
      const timestamp = now();
      const itemId = `context-compaction:${input.agentSessionId}:${input.payload.started_at}`;
      const lifecycle = input.payload.status === "running" ? "active" : "complete";
      return sqlite.transaction(() => {
        const channel = sqlite.prepare(`
          SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?
        `).get(input.flowId, input.channelId) as { cursor: number } | undefined;
        const cursor = (channel?.cursor ?? 0) + 1;
        sqlite.prepare(`
          INSERT INTO chat_transcript_channels (flow_id, channel_id, cursor, revision, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(flow_id, channel_id) DO UPDATE SET
            cursor = excluded.cursor,
            revision = chat_transcript_channels.revision + 1,
            updated_at = excluded.updated_at
        `).run(input.flowId, input.channelId, cursor, timestamp);
        const existing = sqlite.prepare(`
          SELECT position, created_at AS createdAt
          FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_id = ?
        `).get(input.flowId, input.channelId, itemId) as { position: number; createdAt: string } | undefined;
        const position = existing?.position ?? (sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position
          FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ?
        `).get(input.flowId, input.channelId) as { position: number }).position;
        const session = sqlite.prepare(`
          SELECT session_id AS sessionId, work_run_id AS workRunId
          FROM agent_sessions WHERE id = ? AND flow_id = ?
        `).get(input.agentSessionId, input.flowId) as { sessionId: string | null; workRunId: string | null } | undefined;
        sqlite.prepare(`
          INSERT INTO chat_timeline_items (
            flow_id, channel_id, item_id, position, item_type, message_id,
            session_id, agent_session_id, work_run_id, presentation_turn_id,
            message_kind, lifecycle, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'context_compaction', NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
          ON CONFLICT(flow_id, channel_id, item_id) DO UPDATE SET
            work_run_id = excluded.work_run_id,
            lifecycle = excluded.lifecycle,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `).run(
          input.flowId,
          input.channelId,
          itemId,
          position,
          session?.sessionId ?? input.channelId,
          input.agentSessionId,
          session?.workRunId ?? null,
          lifecycle,
          JSON.stringify(input.payload),
          existing?.createdAt ?? input.payload.started_at,
          timestamp,
        );
        const item = this.listTimelineItems(input.flowId, input.channelId)
          .find((candidate) => candidate.itemId === itemId);
        return { cursor, item };
      })();
    },
    sealActiveTranscriptMessages() {
      return sqlite.prepare(`
        UPDATE chat_timeline_items SET lifecycle = 'sealed', updated_at = ? WHERE lifecycle = 'active'
      `).run(now()).changes;
    },
    interruptStaleLeaderSessions() {
      const timestamp = now();
      return sqlite.transaction(() => {
        const staleSessions = sqlite.prepare(`
          SELECT id, flow_id AS flowId
          FROM agent_sessions
          WHERE expert_id = 'exp-leader'
            AND task_id IS NULL
            AND status IN ('queued', 'streaming')
        `).all() as Array<{ id: string; flowId: string }>;

        const updateSession = sqlite.prepare(`
          UPDATE agent_sessions
          SET status = 'interrupted', updated_at = ?
          WHERE id = ? AND status IN ('queued', 'streaming')
        `);
        for (const session of staleSessions) updateSession.run(timestamp, session.id);

        for (const flowId of new Set(staleSessions.map((session) => session.flowId))) {
          syncFlowExecutionStatus(flowId, timestamp);
        }
        return { interruptedLeaderSessions: staleSessions.length, finalizedWorkRuns: 0 };
      })();
    },
    getTranscriptCursor(flowId: string, channelId: string) {
      const row = sqlite.prepare(`
        SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?
      `).get(flowId, channelId) as { cursor: number } | undefined;
      return row?.cursor ?? 0;
    },
    renameTimelineSession(flowId: string, fromSessionId: string, toSessionId: string) {
      if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
      sqlite.prepare(`
        UPDATE chat_timeline_items SET session_id = ?, updated_at = ?
        WHERE flow_id = ? AND session_id = ?
      `).run(toSessionId, now(), flowId, fromSessionId);
    },
    clearTimeline(flowId: string, channelId?: string) {
      sqlite.transaction(() => {
        if (channelId) {
          sqlite.prepare("DELETE FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ?").run(flowId, channelId);
          sqlite.prepare("DELETE FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?").run(flowId, channelId);
        } else {
          sqlite.prepare("DELETE FROM chat_timeline_items WHERE flow_id = ?").run(flowId);
          sqlite.prepare("DELETE FROM chat_transcript_channels WHERE flow_id = ?").run(flowId);
        }
      })();
    },
    getSubmission(flowId: string, clientMessageId: string): CanonicalSubmission | undefined {
      const row = sqlite.prepare(`
        SELECT flow_id AS flowId, client_message_id AS clientMessageId,
          submission_type AS submissionType, payload_hash AS payloadHash,
          payload_json AS payloadJson, receipt_state AS receiptState,
          message_id AS messageId, last_error_code AS lastErrorCode,
          created_at AS createdAt, updated_at AS updatedAt
        FROM chat_submissions WHERE flow_id = ? AND client_message_id = ?
      `).get(flowId, clientMessageId) as CanonicalSubmissionRow | undefined;
      return row ? canonicalSubmissionFromRow(row) : undefined;
    },
    acceptSubmission(input: {
      flowId: string;
      clientMessageId: string;
      submissionType: "normal" | "guide";
      payloadHash: string;
      payload: Record<string, unknown>;
    }): SubmissionAcceptance {
      const timestamp = now();
      return sqlite.transaction(() => {
        const existing = this.getSubmission(input.flowId, input.clientMessageId);
        if (existing) {
          return {
            outcome: existing.submissionType === input.submissionType && existing.payloadHash === input.payloadHash
              ? "duplicate"
              : "conflict",
            submission: existing,
          } as SubmissionAcceptance;
        }
        sqlite.prepare(`
          INSERT INTO chat_submissions (
            flow_id, client_message_id, submission_type, payload_hash, payload_json,
            receipt_state, message_id, last_error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'received', NULL, NULL, ?, ?)
        `).run(
          input.flowId,
          input.clientMessageId,
          input.submissionType,
          input.payloadHash,
          JSON.stringify(input.payload),
          timestamp,
          timestamp,
        );
        return {
          outcome: "created",
          submission: this.getSubmission(input.flowId, input.clientMessageId)!,
        } as SubmissionAcceptance;
      })();
    },
    markSubmissionMaterialized(flowId: string, clientMessageId: string, messageId: string) {
      const result = sqlite.prepare(`
        UPDATE chat_submissions
        SET receipt_state = 'materialized', message_id = ?, payload_json = '{}',
          last_error_code = NULL, updated_at = ?
        WHERE flow_id = ? AND client_message_id = ?
      `).run(messageId, now(), flowId, clientMessageId);
      return result.changes > 0;
    },
    claimSubmission(flowId: string, clientMessageId: string) {
      const result = sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'dispatching', updated_at = ?
        WHERE flow_id = ? AND client_message_id = ? AND receipt_state = 'received'
      `).run(now(), flowId, clientMessageId);
      return result.changes > 0;
    },
    releaseSubmission(flowId: string, clientMessageId: string) {
      const result = sqlite.prepare(`
        UPDATE chat_submissions SET receipt_state = 'received', updated_at = ?
        WHERE flow_id = ? AND client_message_id = ? AND receipt_state = 'dispatching'
      `).run(now(), flowId, clientMessageId);
      return result.changes > 0;
    },
    markSubmissionRejected(flowId: string, clientMessageId: string, errorCode: string) {
      const result = sqlite.prepare(`
        UPDATE chat_submissions
        SET receipt_state = 'rejected', last_error_code = ?, updated_at = ?
        WHERE flow_id = ? AND client_message_id = ?
          AND receipt_state IN ('received', 'dispatching')
      `).run(errorCode, now(), flowId, clientMessageId);
      return result.changes > 0;
    },
    recoverDanglingSubmissions() {
      const timestamp = now();
      return sqlite.transaction(() => {
        const materialized = sqlite.prepare(`
          UPDATE chat_submissions
          SET receipt_state = 'materialized', message_id = client_message_id,
            payload_json = '{}', last_error_code = NULL, updated_at = ?
          WHERE receipt_state = 'dispatching'
            AND EXISTS (
              SELECT 1 FROM chat_timeline_items
              WHERE chat_timeline_items.flow_id = chat_submissions.flow_id
                AND chat_timeline_items.item_type = 'message'
                AND chat_timeline_items.message_id = chat_submissions.client_message_id
            )
        `).run(timestamp).changes;
        const requeued = sqlite.prepare(`
          UPDATE chat_submissions
          SET receipt_state = 'received', last_error_code = NULL, updated_at = ?
          WHERE receipt_state = 'dispatching'
        `).run(timestamp).changes;
        return { materialized, requeued };
      })();
    },
    addQueuedMessage(input: {
      id: string;
      flowId: string;
      payloadHash: string;
      payload: Record<string, unknown>;
    }): { acceptance: SubmissionAcceptance; item?: CanonicalQueueItem } {
      const timestamp = now();
      return sqlite.transaction(() => {
        const existingSubmission = this.getSubmission(input.flowId, input.id);
        if (existingSubmission) {
          const acceptance: SubmissionAcceptance = {
            outcome: existingSubmission.submissionType === "normal" && existingSubmission.payloadHash === input.payloadHash
              ? "duplicate"
              : "conflict",
            submission: existingSubmission,
          };
          return { acceptance, item: this.getQueuedMessage(input.flowId, input.id) };
        }
        sqlite.prepare(`
          INSERT INTO chat_submissions (
            flow_id, client_message_id, submission_type, payload_hash, payload_json,
            receipt_state, message_id, last_error_code, created_at, updated_at
          ) VALUES (?, ?, 'normal', ?, ?, 'received', NULL, NULL, ?, ?)
        `).run(input.flowId, input.id, input.payloadHash, JSON.stringify(input.payload), timestamp, timestamp);
        const next = sqlite.prepare(`
          SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_queue_items WHERE flow_id = ?
        `).get(input.flowId) as { position: number };
        sqlite.prepare(`
          INSERT INTO chat_queue_items (
            id, flow_id, position, status, revision, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'accepted', 1, ?, ?, ?)
        `).run(input.id, input.flowId, next.position, JSON.stringify(input.payload), timestamp, timestamp);
        const submission = this.getSubmission(input.flowId, input.id)!;
        const acceptance: SubmissionAcceptance = { outcome: "created", submission };
        return {
          acceptance,
          item: this.getQueuedMessage(input.flowId, input.id),
        };
      })();
    },
    listQueuedMessages(flowId: string): CanonicalQueueItem[] {
      const rows = sqlite.prepare(`
        SELECT id, flow_id AS flowId, position, status, revision, payload_json AS payloadJson,
          created_at AS createdAt, updated_at AS updatedAt
        FROM chat_queue_items WHERE flow_id = ? ORDER BY position ASC
      `).all(flowId) as Array<Omit<CanonicalQueueItem, "payload"> & { payloadJson: string }>;
      return rows.map(({ payloadJson, ...row }) => ({
        ...row,
        status: row.status === "dispatching" ? "dispatching" : "accepted",
        payload: parseJsonObject(payloadJson),
      }));
    },
    getQueuedMessage(flowId: string, queueId: string): CanonicalQueueItem | undefined {
      return this.listQueuedMessages(flowId).find((item) => item.id === queueId);
    },
    claimQueuedMessage(flowId: string, queueId?: string): CanonicalQueueItem | undefined {
      return sqlite.transaction(() => {
        const first = this.listQueuedMessages(flowId)[0];
        if (!first || first.status !== "accepted" || (queueId && first.id !== queueId)) return undefined;
        const result = sqlite.prepare(`
          UPDATE chat_queue_items
          SET status = 'dispatching', revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted' AND revision = ?
        `).run(now(), flowId, first.id, first.revision);
        return result.changes > 0 ? this.getQueuedMessage(flowId, first.id) : undefined;
      })();
    },
    claimQueuedMessageForGuide(flowId: string, queueId: string): CanonicalQueueItem | undefined {
      return sqlite.transaction(() => {
        const item = this.getQueuedMessage(flowId, queueId);
        if (!item || item.status !== "accepted") return undefined;
        const result = sqlite.prepare(`
          UPDATE chat_queue_items
          SET status = 'dispatching', revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted' AND revision = ?
        `).run(now(), flowId, queueId, item.revision);
        return result.changes > 0 ? this.getQueuedMessage(flowId, queueId) : undefined;
      })();
    },
    releaseQueuedMessage(flowId: string, queueId: string) {
      const result = sqlite.prepare(`
        UPDATE chat_queue_items
        SET status = 'accepted', revision = revision + 1, updated_at = ?
        WHERE flow_id = ? AND id = ? AND status = 'dispatching'
      `).run(now(), flowId, queueId);
      return result.changes > 0;
    },
    completeQueuedMessage(flowId: string, queueId: string, messageId = queueId) {
      return sqlite.transaction(() => {
        const result = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?")
          .run(flowId, queueId);
        this.markSubmissionMaterialized(flowId, queueId, messageId);
        return result.changes > 0;
      })();
    },
    completeGuidedQueuedMessage(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const result = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?")
          .run(flowId, queueId);
        sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'cancelled', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `).run(now(), flowId, queueId);
        return result.changes > 0;
      })();
    },
    markQueuedMessageUncertain(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const result = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ?")
          .run(flowId, queueId);
        sqlite.prepare(`
          UPDATE chat_submissions
          SET receipt_state = 'uncertain', last_error_code = 'PROCESS_RESTART', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `).run(now(), flowId, queueId);
        return result.changes > 0;
      })();
    },
    deleteQueuedMessage(flowId: string, queueId: string) {
      return sqlite.transaction(() => {
        const item = this.getQueuedMessage(flowId, queueId);
        if (!item || item.status !== "accepted") return false;
        const result = sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND id = ? AND status = 'accepted'")
          .run(flowId, queueId);
        if (result.changes > 0) {
          sqlite.prepare(`
            UPDATE chat_submissions
            SET receipt_state = 'cancelled', updated_at = ?
            WHERE flow_id = ? AND client_message_id = ?
          `).run(now(), flowId, queueId);
        }
        return result.changes > 0;
      })();
    },
    clearQueuedMessages(flowId: string) {
      sqlite.transaction(() => {
        const ids = this.listQueuedMessages(flowId)
          .filter((item) => item.status === "accepted")
          .map((item) => item.id);
        if (ids.length === 0) return;
        sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ? AND status = 'accepted'").run(flowId);
        const update = sqlite.prepare(`
          UPDATE chat_submissions SET receipt_state = 'cancelled', updated_at = ?
          WHERE flow_id = ? AND client_message_id = ?
        `);
        const timestamp = now();
        for (const id of ids) update.run(timestamp, flowId, id);
      })();
    },
    reorderQueuedMessages(flowId: string, queueIds: string[]) {
      const existing = this.listQueuedMessages(flowId);
      if (existing.length !== queueIds.length || new Set(queueIds).size !== queueIds.length) return false;
      if (existing.some((item) => !queueIds.includes(item.id))) return false;
      if (existing.some((item) => item.status !== "accepted")) return false;
      const timestamp = now();
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE chat_queue_items SET position = -position WHERE flow_id = ?").run(flowId);
        const update = sqlite.prepare(`
          UPDATE chat_queue_items
          SET position = ?, revision = revision + 1, updated_at = ?
          WHERE flow_id = ? AND id = ? AND status = 'accepted'
        `);
        queueIds.forEach((queueId, index) => update.run(index + 1, timestamp, flowId, queueId));
      })();
      return true;
    },
    markFlowRead(flowId: string, viewerId = "local-default", timestamp = now()) {
      const existing = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!existing) return undefined;
      sqlite.prepare(`
        INSERT INTO flow_read_states (flow_id, viewer_id, last_read_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(flow_id, viewer_id) DO UPDATE SET
          last_read_at = excluded.last_read_at,
          updated_at = excluded.updated_at
      `).run(flowId, viewerId, timestamp, timestamp);
      return db.select().from(flowReadStates).where(eq(flowReadStates.flowId, flowId)).all()
        .find((row) => row.viewerId === viewerId);
    },
    getFlowReadState(flowId: string, viewerId = "local-default") {
      return db.select().from(flowReadStates).where(eq(flowReadStates.flowId, flowId)).all()
        .find((row) => row.viewerId === viewerId);
    },
    hasUnreadOutput(flowId: string, viewerId = "local-default") {
      const flow = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!flow?.lastOutputCompletedAt) return false;
      const readState = db.select().from(flowReadStates).where(eq(flowReadStates.flowId, flowId)).all()
        .find((row) => row.viewerId === viewerId);
      if (!readState) return true;
      return flow.lastOutputCompletedAt > readState.lastReadAt;
    },
    createWorkRun(input: { flowId: string; triggerMessageId: string; startedAt?: string; specRequested?: boolean }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      if (!flow) return undefined;
      if (db.select().from(workRuns).where(eq(workRuns.flowId, input.flowId)).all()
        .some((turn) => OPEN_WORK_RUN_STATUSES.has(turn.status as WorkRunStatus))) return undefined;
      const timestamp = input.startedAt ?? now();
      const row = {
        id: id("wrun"),
        flowId: input.flowId,
        triggerMessageId: input.triggerMessageId,
        status: "ready",
        revision: 1,
        startedAt: timestamp,
        executionStartedAt: null,
        activeStartedAt: null,
        activeDurationMs: 0,
        waitingStartedAt: null,
        completedAt: null,
        workSource: null,
        specRevisionId: null,
        targetProjectId: null,
        workRootPath: "",
        inputSnapshotJson: input.specRequested
          ? JSON.stringify({ type: "direct_message", message_id: input.triggerMessageId, spec_requested: true })
          : "{}",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.insert(workRuns).values(row).run();
      return db.select().from(workRuns).where(eq(workRuns.id, row.id)).get()!;
    },
    listWorkRuns(flowId: string) {
      return db.select().from(workRuns).where(eq(workRuns.flowId, flowId)).all()
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    },
    getWorkRun(workRunId: string) {
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
    },
    getOpenWorkRun(flowId: string) {
      return db.select().from(workRuns).where(eq(workRuns.flowId, flowId)).all()
        .filter((turn) => OPEN_WORK_RUN_STATUSES.has(turn.status as WorkRunStatus))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    },
    startWorkRunWork(input: {
      flowId: string;
      workRunId: string;
      workSource: "spec" | "direct_message";
      specRevisionId?: string | null;
      targetProjectId: string;
      inputSnapshotJson: string;
    }) {
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      const project = db.select().from(projects).where(eq(projects.id, input.targetProjectId)).get();
      if (!turn || turn.flowId !== input.flowId || !OPEN_WORK_RUN_STATUSES.has(turn.status as WorkRunStatus) || turn.status === "interrupted" || !project?.localPath) return undefined;
      const desired = {
        workSource: input.workSource,
        specRevisionId: input.specRevisionId ?? null,
        targetProjectId: input.targetProjectId,
        workRootPath: project.localPath,
        inputSnapshotJson: input.inputSnapshotJson,
      };
      if (turn.workSource) {
        return turn.workSource === desired.workSource
          && turn.specRevisionId === desired.specRevisionId
          && turn.targetProjectId === desired.targetProjectId
          && turn.workRootPath === desired.workRootPath
          && turn.inputSnapshotJson === desired.inputSnapshotJson
          ? turn
          : undefined;
      }
      db.update(workRuns).set({ ...desired, updatedAt: now() }).where(eq(workRuns.id, turn.id)).run();
      return db.select().from(workRuns).where(eq(workRuns.id, turn.id)).get()!;
    },
    startWorkRunExecution(workRunId: string, timestamp = now()) {
      return beginWorkRunExecution(workRunId, timestamp);
    },
    updateWorkRunInputSnapshot(workRunId: string, inputSnapshotJson: string) {
      const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!existing || existing.status !== "ready") return undefined;
      db.update(workRuns)
        .set({ inputSnapshotJson, updatedAt: now() })
        .where(and(eq(workRuns.id, workRunId), eq(workRuns.revision, existing.revision)))
        .run();
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
    },
    waitWorkRunForUserAction(workRunId: string, timestamp = now()) {
      const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!existing || !["ready", "executing"].includes(existing.status)) return existing;
      const activeDurationMs = existing.status === "executing"
        ? existing.activeDurationMs + elapsedMs(existing.activeStartedAt, timestamp)
        : existing.activeDurationMs;
      db.update(workRuns)
        .set({
          status: "waiting_user",
          revision: existing.revision + 1,
          activeStartedAt: null,
          activeDurationMs,
          waitingStartedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(workRuns.id, workRunId))
        .run();
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get()!;
    },
    resumeWorkRun(workRunId: string, timestamp = now()) {
      const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!existing || !["waiting_user", "interrupted"].includes(existing.status)) return existing;
      const nextStatus = existing.executionStartedAt ? "executing" : "ready";
      db.update(workRuns)
        .set({
          status: nextStatus,
          revision: existing.revision + 1,
          activeStartedAt: nextStatus === "executing" ? timestamp : null,
          waitingStartedAt: null,
          updatedAt: timestamp,
        })
        .where(eq(workRuns.id, workRunId))
        .run();
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get()!;
    },
    interruptWorkRun(input: { flowId: string; workRunId: string; expectedRevision: number }, timestamp = now()) {
      const result: { outcome: "interrupted" | "already_interrupted" | "not_found" | "revision_conflict" | "not_interruptible" } = { outcome: "not_found" };
      sqlite.transaction(() => {
        const existing = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
        if (!existing || existing.flowId !== input.flowId) return;
        if (existing.status === "interrupted") {
          result.outcome = "already_interrupted";
          return;
        }
        if (existing.revision !== input.expectedRevision) {
          result.outcome = "revision_conflict";
          return;
        }
        if (!(existing.status === "executing"
          || (existing.status === "waiting_user" && existing.executionStartedAt))) {
          result.outcome = "not_interruptible";
          return;
        }
        const activeDurationMs = existing.status === "executing"
          ? existing.activeDurationMs + elapsedMs(existing.activeStartedAt, timestamp)
          : existing.activeDurationMs;
        db.update(workRuns)
          .set({
            status: "interrupted",
            revision: existing.revision + 1,
            activeStartedAt: null,
            activeDurationMs,
            waitingStartedAt: null,
            updatedAt: timestamp,
          })
          .where(and(eq(workRuns.id, existing.id), eq(workRuns.revision, input.expectedRevision)))
          .run();
        db.update(decisionCards)
          .set({ status: "cancelled", resolutionKind: "interrupted", resolvedAt: timestamp })
          .where(and(eq(decisionCards.workRunId, existing.id), eq(decisionCards.status, "pending")))
          .run();
        db.update(specApprovals)
          .set({ status: "cancelled", resolvedAt: timestamp })
          .where(and(eq(specApprovals.workRunId, existing.id), eq(specApprovals.status, "pending")))
          .run();
        db.update(planApprovals)
          .set({ status: "cancelled", resolvedAt: timestamp })
          .where(and(eq(planApprovals.workRunId, existing.id), sql`${planApprovals.status} IN ('pending', 'feedback_pending')`))
          .run();
        result.outcome = "interrupted";
      })();
      return {
        outcome: result.outcome,
        workRun: db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get(),
      };
    },
    completeWorkRun(workRunId: string, timestamp = now()) {
      const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!existing || !["executing", "waiting_user"].includes(existing.status)) {
        return existing;
      }
      const activeDurationMs = existing.status === "executing"
        ? existing.activeDurationMs + elapsedMs(existing.activeStartedAt, timestamp)
        : existing.activeDurationMs;
      db.update(workRuns)
        .set({
          status: "completed",
          revision: existing.revision + 1,
          activeStartedAt: null,
          activeDurationMs,
          waitingStartedAt: null,
          completedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(workRuns.id, workRunId))
        .run();
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get()!;
    },
    failWorkRun(workRunId: string, status: "failed" | "cancelled" = "failed", timestamp = now()) {
      const existing = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
        return existing;
      }
      const activeDurationMs = existing.status === "executing"
        ? existing.activeDurationMs + elapsedMs(existing.activeStartedAt, timestamp)
        : existing.activeDurationMs;
      db.update(workRuns)
        .set({
          status,
          revision: existing.revision + 1,
          activeStartedAt: null,
          activeDurationMs,
          waitingStartedAt: null,
          completedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(workRuns.id, workRunId))
        .run();
      return db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get()!;
    },
    finalizeWorkRunWithReview(input: {
      workRunId: string;
      expectedRevision: number;
      terminalStatus: "completed" | "failed" | "cancelled";
      timestamp: string;
      reviewStatus: "ready" | "empty" | "skipped" | "failed";
      reviewJson: string;
      anchorMessageId?: string | null;
    }) {
      let finalized = false;
      sqlite.transaction(() => {
        const existing = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
        if (!existing || existing.revision !== input.expectedRevision) return;
        if (["completed", "failed", "cancelled"].includes(existing.status)) return;
        if (input.terminalStatus === "completed" && !["executing", "waiting_user"].includes(existing.status)) return;
        const activeDurationMs = existing.status === "executing"
          ? existing.activeDurationMs + elapsedMs(existing.activeStartedAt, input.timestamp)
          : existing.activeDurationMs;
        const leaderChannelId = `leader:${existing.flowId}`;
        const requestedAnchor = input.anchorMessageId
          ? sqlite.prepare(`
              SELECT message_id AS messageId
              FROM chat_timeline_items
              WHERE flow_id = ? AND channel_id = ? AND item_type = 'message'
                AND message_id = ? AND json_extract(payload_json, '$.role') = 'assistant'
            `).get(existing.flowId, leaderChannelId, input.anchorMessageId) as { messageId: string } | undefined
          : undefined;
        const latestAssistant = requestedAnchor ?? sqlite.prepare(`
          SELECT message_id AS messageId
          FROM chat_timeline_items
          WHERE flow_id = ? AND channel_id = ? AND item_type = 'message'
            AND work_run_id = ? AND json_extract(payload_json, '$.role') = 'assistant'
          ORDER BY position DESC LIMIT 1
        `).get(existing.flowId, leaderChannelId, existing.id) as { messageId: string } | undefined;
        let anchorMessageId = latestAssistant?.messageId ?? null;
        if (anchorMessageId) {
          sqlite.prepare(`
            UPDATE chat_timeline_items SET work_run_id = ?, updated_at = ?
            WHERE flow_id = ? AND channel_id = ? AND message_id = ?
          `).run(existing.id, input.timestamp, existing.flowId, leaderChannelId, anchorMessageId);
        } else {
          anchorMessageId = `msg-work-run-terminal-${existing.id}`;
          const position = (sqlite.prepare(`
            SELECT COALESCE(MAX(position), 0) + 1 AS position
            FROM chat_timeline_items WHERE flow_id = ? AND channel_id = ?
          `).get(existing.flowId, leaderChannelId) as { position: number }).position;
          const payload = {
            id: anchorMessageId,
            role: "assistant",
            parts: [],
            content: "",
            createdAt: input.timestamp,
            metadata: {
              messageKind: "work-run-terminal",
              presentationTurnId: anchorMessageId,
              workRunId: existing.id,
              turnTiming: { startedAt: input.timestamp, finishedAt: input.timestamp, durationMs: 0 },
            },
          };
          sqlite.prepare(`
            INSERT INTO chat_timeline_items (
              flow_id, channel_id, item_id, position, item_type, message_id,
              session_id, agent_session_id, work_run_id, presentation_turn_id,
              message_kind, lifecycle, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'message', ?, ?, NULL, ?, ?, 'work-run-terminal', 'complete', ?, ?, ?)
          `).run(
            existing.flowId,
            leaderChannelId,
            anchorMessageId,
            position,
            anchorMessageId,
            leaderChannelId,
            existing.id,
            anchorMessageId,
            JSON.stringify(payload),
            input.timestamp,
            input.timestamp,
          );
          const channel = sqlite.prepare(`
            SELECT cursor FROM chat_transcript_channels WHERE flow_id = ? AND channel_id = ?
          `).get(existing.flowId, leaderChannelId) as { cursor: number } | undefined;
          sqlite.prepare(`
            INSERT INTO chat_transcript_channels (flow_id, channel_id, cursor, revision, updated_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(flow_id, channel_id) DO UPDATE SET
              cursor = excluded.cursor,
              revision = chat_transcript_channels.revision + 1,
              updated_at = excluded.updated_at
          `).run(existing.flowId, leaderChannelId, (channel?.cursor ?? 0) + 1, input.timestamp);
        }
        const review = { ...parseJsonObject(input.reviewJson), anchor_message_id: anchorMessageId };
        sqlite.prepare(`
          INSERT INTO work_run_reviews (
            work_run_id, flow_id, anchor_message_id, status, review_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_run_id) DO UPDATE SET
            flow_id = excluded.flow_id,
            anchor_message_id = excluded.anchor_message_id,
            status = excluded.status,
            review_json = excluded.review_json,
            updated_at = excluded.updated_at
        `).run(
          existing.id,
          existing.flowId,
          anchorMessageId,
          input.reviewStatus,
          JSON.stringify(review),
          input.timestamp,
          input.timestamp,
        );
        db.update(workRuns)
          .set({
            status: input.terminalStatus,
            revision: existing.revision + 1,
            activeStartedAt: null,
            activeDurationMs,
            waitingStartedAt: null,
            completedAt: input.timestamp,
            updatedAt: input.timestamp,
          })
          .where(and(eq(workRuns.id, existing.id), eq(workRuns.revision, input.expectedRevision)))
          .run();
        finalized = true;
      })();
      return finalized
        ? db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get()
        : undefined;
    },
    cancelWorkRunPendingActions(workRunId: string, timestamp = now()) {
      const turn = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!turn) return undefined;
      db.update(decisionCards)
        .set({ status: "cancelled", resolutionKind: "cancelled", resolvedAt: timestamp })
        .where(and(eq(decisionCards.workRunId, workRunId), eq(decisionCards.status, "pending")))
        .run();
      db.update(specApprovals)
        .set({ status: "cancelled", resolvedAt: timestamp })
        .where(and(eq(specApprovals.workRunId, workRunId), eq(specApprovals.status, "pending")))
        .run();
      db.update(planApprovals)
        .set({ status: "cancelled", resolvedAt: timestamp })
        .where(and(eq(planApprovals.workRunId, workRunId), eq(planApprovals.status, "pending")))
        .run();
      db.update(planApprovals)
        .set({ status: "cancelled", resolvedAt: timestamp })
        .where(and(eq(planApprovals.workRunId, workRunId), eq(planApprovals.status, "feedback_pending")))
        .run();
      db.update(planRuns)
        .set({ status: "cancelled", completedAt: timestamp, updatedAt: timestamp })
        .where(eq(planRuns.workRunId, workRunId))
        .run();
      return turn;
    },
    createSpecRevision(input: {
      flowId: string;
      name?: string;
      title?: string;
      overview?: string;
      content: string;
      sourceAgentSessionId?: string;
      fileName?: string;
    }) {
      const name = input.name ?? input.title;
      if (!name) return undefined;
      const overview = input.overview ?? "";
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      if (!flow) return undefined;
      const timestamp = now();
      const rowId = id("spec");
      const existing = db.select().from(specRevisions).where(eq(specRevisions.flowId, input.flowId)).all();
      const revisionNumber = existing.reduce((maxRevision, row) => Math.max(maxRevision, row.revisionNumber), 0) + 1;
      const stem = name.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Spec";
      const fileName = input.fileName ?? `${stem}_${crypto.randomBytes(4).toString("hex")}.md`;
      sqlite.transaction(() => {
        db.update(specRevisions)
          .set({ status: "superseded" })
          .where(and(eq(specRevisions.flowId, input.flowId), eq(specRevisions.status, "draft")))
          .run();
        db.insert(specRevisions).values({
          id: rowId,
          flowId: input.flowId,
          revisionNumber,
          status: "draft",
          title: name,
          overview,
          fileName,
          content: input.content,
          sourceAgentSessionId: input.sourceAgentSessionId ?? "",
          createdAt: timestamp,
          approvedAt: null,
          executedAt: null,
        }).run();
      })();
      return db.select().from(specRevisions).where(eq(specRevisions.id, rowId)).get()!;
    },
    listSpecRevisions(flowId: string) {
      return db.select().from(specRevisions).where(eq(specRevisions.flowId, flowId)).all()
        .sort((left, right) => left.revisionNumber - right.revisionNumber);
    },
    getSpecRevision(specRevisionId: string) {
      return db.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get();
    },
    approveSpecRevision(specRevisionId: string) {
      const existing = db.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get();
      if (!existing || existing.status === "superseded") return undefined;
      db.update(specRevisions)
        .set({ status: "approved", approvedAt: now() })
        .where(eq(specRevisions.id, specRevisionId))
        .run();
      return db.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get()!;
    },
    markSpecRevisionExecuted(specRevisionId: string) {
      const existing = db.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get();
      if (!existing || existing.status === "superseded") return undefined;
      db.update(specRevisions)
        .set({ status: "executed", executedAt: now() })
        .where(eq(specRevisions.id, specRevisionId))
        .run();
      return db.select().from(specRevisions).where(eq(specRevisions.id, specRevisionId)).get()!;
    },
    createSpecApproval(input: { flowId: string; specRevisionId: string; fileName: string; overview: string; workRunId: string }) {
      const spec = db.select().from(specRevisions).where(eq(specRevisions.id, input.specRevisionId)).get();
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!spec || !turn || turn.flowId !== input.flowId || !["ready", "executing"].includes(turn.status) || spec.flowId !== input.flowId || spec.status !== "draft") return undefined;
      const timestamp = now();
      const row = {
        id: id("sca"),
        flowId: input.flowId,
        specRevisionId: input.specRevisionId,
        workRunId: input.workRunId,
        status: "pending" as const,
        fileName: input.fileName,
        overview: input.overview,
        createdAt: timestamp,
        resolvedAt: null,
      };
      db.insert(specApprovals).values(row).run();
      return db.select().from(specApprovals).where(eq(specApprovals.id, row.id)).get()!;
    },
    listSpecApprovals(flowId: string) {
      return db.select().from(specApprovals).where(eq(specApprovals.flowId, flowId)).all();
    },
    getSpecApproval(specApprovalId: string) {
      return db.select().from(specApprovals).where(eq(specApprovals.id, specApprovalId)).get();
    },
    resolveSpecApproval(specApprovalId: string, status: "approved" | "cancelled") {
      const existing = db.select().from(specApprovals).where(eq(specApprovals.id, specApprovalId)).get();
      if (!existing || existing.status !== "pending") return undefined;
      db.update(specApprovals)
        .set({ status, resolvedAt: now() })
        .where(eq(specApprovals.id, specApprovalId))
        .run();
      return db.select().from(specApprovals).where(eq(specApprovals.id, specApprovalId)).get()!;
    },
    createSpecPlan(input: {
      flowId: string;
      mode: "write" | "rewrite";
      name?: string;
      overview: string;
      content: string;
      sourceAgentSessionId?: string;
      workRunId: string;
    }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!flow || !turn || turn.flowId !== input.flowId || !["ready", "executing"].includes(turn.status)) return undefined;
      const existing = db.select().from(specRevisions).where(eq(specRevisions.flowId, input.flowId)).all();
      const latest = existing.reduce<typeof existing[number] | null>(
        (current, row) => !current || row.revisionNumber > current.revisionNumber ? row : current,
        null,
      );
      if (input.mode === "rewrite" && !latest) return undefined;
      const name = input.mode === "rewrite" ? latest!.title : input.name;
      if (!name) return undefined;

      const revisionNumber = existing.reduce((maxRevision, row) => Math.max(maxRevision, row.revisionNumber), 0) + 1;
      const baseStem = input.mode === "rewrite"
        ? (latest!.fileName || latest!.title)
            .replace(/\.md$/i, "")
            .replace(/_r\d+_[0-9a-f]+$/i, "")
            .replace(/_[0-9a-f]+$/i, "")
        : name.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const safeStem = baseStem || "Spec";
      const fileName = input.mode === "rewrite"
        ? `${safeStem}_r${revisionNumber}_${crypto.randomBytes(2).toString("hex")}.md`
        : `${safeStem}_${crypto.randomBytes(4).toString("hex")}.md`;
      const timestamp = now();
      const specId = id("spec");
      const approvalId = id("sca");

      sqlite.transaction(() => {
        db.update(specRevisions)
          .set({ status: "superseded" })
          .where(and(eq(specRevisions.flowId, input.flowId), eq(specRevisions.status, "draft")))
          .run();
        db.insert(specRevisions).values({
          id: specId,
          flowId: input.flowId,
          revisionNumber,
          status: "draft",
          title: name,
          overview: input.overview,
          fileName,
          content: input.content,
          sourceAgentSessionId: input.sourceAgentSessionId ?? "",
          createdAt: timestamp,
          approvedAt: null,
          executedAt: null,
        }).run();
        db.insert(specApprovals).values({
          id: approvalId,
          flowId: input.flowId,
          specRevisionId: specId,
          workRunId: input.workRunId,
          status: "pending",
          fileName,
          overview: input.overview,
          createdAt: timestamp,
          resolvedAt: null,
        }).run();
      })();

      return {
        spec: db.select().from(specRevisions).where(eq(specRevisions.id, specId)).get()!,
        approval: db.select().from(specApprovals).where(eq(specApprovals.id, approvalId)).get()!,
      };
    },
    runApprovedSpecForWorkRun(input: {
      flowId: string;
      specApprovalId: string;
      specRevisionId: string;
      targetProjectId?: string | null;
      inputSnapshotJson: string;
    }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      const approval = db.select().from(specApprovals).where(eq(specApprovals.id, input.specApprovalId)).get();
      const spec = db.select().from(specRevisions).where(eq(specRevisions.id, input.specRevisionId)).get();
      const turn = approval?.workRunId
        ? db.select().from(workRuns).where(eq(workRuns.id, approval.workRunId)).get()
        : undefined;
      const targetProjectId = input.targetProjectId ?? flow?.projectId ?? null;
      const project = targetProjectId
        ? db.select().from(projects).where(eq(projects.id, targetProjectId)).get()
        : undefined;
      if (!flow || !approval || !spec || !turn || !project?.localPath) return undefined;
      if (approval.flowId !== input.flowId || approval.status !== "pending") return undefined;
      if (approval.specRevisionId !== input.specRevisionId) return undefined;
      if (spec.flowId !== input.flowId || spec.status !== "draft") return undefined;
      if (turn.flowId !== input.flowId || turn.status !== "waiting_user") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(specApprovals).set({ status: "approved", resolvedAt: timestamp }).where(eq(specApprovals.id, input.specApprovalId)).run();
        db.update(specRevisions).set({ status: "executed", executedAt: timestamp }).where(eq(specRevisions.id, input.specRevisionId)).run();
        db.update(workRuns).set({
          status: "ready",
          revision: turn.revision + 1,
          activeStartedAt: null,
          waitingStartedAt: null,
          workSource: "spec",
          specRevisionId: input.specRevisionId,
          targetProjectId,
          workRootPath: project.localPath,
          inputSnapshotJson: input.inputSnapshotJson,
          updatedAt: timestamp,
        }).where(eq(workRuns.id, turn.id)).run();
      })();
      return db.select().from(workRuns).where(eq(workRuns.id, turn.id)).get()!;
    },
    deleteFlow(flowId: string) {
      const existing = db.select().from(flows).where(eq(flows.id, flowId)).get();
      if (!existing) return false;
      const baselineSnapshotPaths = (sqlite.prepare("SELECT snapshot_path AS snapshotPath FROM change_baselines WHERE flow_id = ?").all(flowId) as Array<{ snapshotPath: string }>)
        .map((row) => row.snapshotPath);
      sqlite.transaction(() => {
        sqlite.prepare("DELETE FROM chat_queue_items WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM chat_submissions WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM chat_timeline_items WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM chat_transcript_channels WHERE flow_id = ?").run(flowId);
        for (const task of db.select().from(tasks).where(eq(tasks.flowId, flowId)).all()) {
          db.delete(taskDependencies).where(eq(taskDependencies.taskId, task.id)).run();
          db.delete(taskDependencies).where(eq(taskDependencies.dependsOnTaskId, task.id)).run();
        }
        db.delete(tasks).where(eq(tasks.flowId, flowId)).run();
        db.delete(agentSessions).where(eq(agentSessions.flowId, flowId)).run();
        sqlite.prepare("DELETE FROM agent_context_usage_snapshots WHERE flow_id = ?").run(flowId);
        db.delete(flowExperts).where(eq(flowExperts.flowId, flowId)).run();
        db.delete(decisionCards).where(eq(decisionCards.flowId, flowId)).run();
        db.delete(decisionCardLeaderInputs).where(eq(decisionCardLeaderInputs.flowId, flowId)).run();
        db.delete(flowReadStates).where(eq(flowReadStates.flowId, flowId)).run();
        sqlite.prepare("DELETE FROM work_run_reviews WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM work_run_touched_files WHERE work_run_id IN (SELECT id FROM work_runs WHERE flow_id = ?)").run(flowId);
        sqlite.prepare("DELETE FROM work_run_file_attributions WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM change_baselines WHERE flow_id = ?").run(flowId);
        db.delete(workRuns).where(eq(workRuns.flowId, flowId)).run();
        db.delete(artifacts).where(eq(artifacts.flowId, flowId)).run();
        db.delete(specRevisions).where(eq(specRevisions.flowId, flowId)).run();
        db.delete(specApprovals).where(eq(specApprovals.flowId, flowId)).run();
        db.delete(eventLog).where(eq(eventLog.flowId, flowId)).run();
        sqlite.prepare("DELETE FROM plan_node_tasks WHERE plan_run_id IN (SELECT id FROM plan_runs WHERE flow_id = ?)").run(flowId);
        sqlite.prepare("DELETE FROM plan_dependencies WHERE plan_revision_id IN (SELECT pr.id FROM plan_revisions pr JOIN orchestration_plans op ON op.id = pr.plan_id WHERE op.flow_id = ?)").run(flowId);
        sqlite.prepare("DELETE FROM plan_nodes WHERE plan_revision_id IN (SELECT pr.id FROM plan_revisions pr JOIN orchestration_plans op ON op.id = pr.plan_id WHERE op.flow_id = ?)").run(flowId);
        sqlite.prepare("DELETE FROM plan_feedback WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM plan_approvals WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM plan_runs WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM plan_revisions WHERE plan_id IN (SELECT id FROM orchestration_plans WHERE flow_id = ?)").run(flowId);
        sqlite.prepare("DELETE FROM orchestration_plans WHERE flow_id = ?").run(flowId);
        sqlite.prepare("DELETE FROM orchestration_rules WHERE scope_type = 'flow' AND scope_id = ?").run(flowId);
        db.delete(flows).where(eq(flows.id, flowId)).run();
      })();
      for (const snapshotPath of baselineSnapshotPaths) {
        try {
          fs.rmSync(snapshotPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup for snapshots owned by the deleted Flow.
        }
      }
      return true;
    },
    clearFlows() {
      sqlite.transaction(clearAllFlowData)();
    },
    createDirectWorkRunTask(input: {
      flowId: string;
      subject: string;
      description: string;
      activeForm?: string;
      currentTurnInput: CurrentTurnInput;
    }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      const workRunId = input.currentTurnInput.work_run_id;
      const turn = workRunId ? db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get() : undefined;
      const project = flow?.projectId ? db.select().from(projects).where(eq(projects.id, flow.projectId)).get() : undefined;
      if (!flow || !turn || turn.flowId !== flow.id || !["ready", "executing"].includes(turn.status) || !project?.localPath) return undefined;
      if (turn.workSource && (
        turn.workSource !== "direct_message"
        || turn.targetProjectId !== project.id
        || turn.workRootPath !== project.localPath
      )) return undefined;

      const timestamp = now();
      const taskId = id("task");
      const messageId = input.currentTurnInput.message_id ?? id("msg");
      const inputSnapshot: Record<string, unknown> = {
        type: "direct_message",
        trigger_kind: input.currentTurnInput.trigger_kind,
        message_id: messageId,
        content: input.currentTurnInput.content ?? "",
        answers: input.currentTurnInput.answers ?? {},
        created_at: input.currentTurnInput.created_at,
      };

      sqlite.transaction(() => {
        if (!turn.workSource) db.update(workRuns).set({
          workSource: "direct_message",
          specRevisionId: null,
          targetProjectId: project.id,
          workRootPath: project.localPath,
          inputSnapshotJson: JSON.stringify(inputSnapshot),
          updatedAt: timestamp,
        }).where(eq(workRuns.id, turn.id)).run();
        db.insert(tasks).values({
          id: taskId,
          flowId: input.flowId,
          workRunId: turn.id,
          title: input.subject,
          description: input.description,
          expertId: null,
          flowExpertId: null,
          status: "pending",
          revision: 1,
          activeForm: input.activeForm ?? "",
          progress: null,
          agentSessionId: null,
          metadataJson: "{}",
          acceptanceCriteriaJson: "[]",
          resultArtifactIdsJson: "[]",
          resultJson: null,
          errorMessage: null,
          createdByAgentSessionId: "",
          createdAt: timestamp,
          startedAt: null,
          finishedAt: null,
          updatedAt: timestamp,
        }).run();
      })();

      return {
        workRun: db.select().from(workRuns).where(eq(workRuns.id, turn.id)).get()!,
        task: db.select().from(tasks).where(eq(tasks.id, taskId)).get()!,
      };
    },

    createOrchestrationPlanRevision(input: {
      flowId: string;
      workRunId: string;
      specRevisionId?: string | null;
      title: string;
      objective: string;
      workKind: string;
      riskLevel: string;
      basedOnRevisionId?: string | null;
      sourceFeedbackMessageId?: string | null;
      sourceAgentSessionId?: string;
      status: string;
      lint: unknown[];
      nodes: Array<{
        nodeId: string;
        expertId: string;
        title: string;
        description: string;
        dependsOn: string[];
        acceptanceCriteria: string[];
        riskTags: string[];
        sideEffects: string[];
        resourceKeys: string[];
      }>;
      diff: Record<string, unknown>;
    }) {
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!turn || turn.flowId !== input.flowId || !["ready", "executing"].includes(turn.status)) return undefined;
      const timestamp = now();
      let plan = db.select().from(orchestrationPlans).where(eq(orchestrationPlans.workRunId, input.workRunId)).get();
      const planId = plan?.id ?? id("oplan");
      const existingRevisions = plan
        ? db.select().from(planRevisions).where(eq(planRevisions.planId, plan.id)).all()
        : [];
      const revisionNumber = existingRevisions.reduce((max, row) => Math.max(max, row.revisionNumber), 0) + 1;
      const revisionId = id("prev");
      const approvalId = id("pap");
      const nodeIds = new Map(input.nodes.map((node) => [node.nodeId, id("pnode")]));
      sqlite.transaction(() => {
        if (!plan) {
          db.insert(orchestrationPlans).values({
            id: planId,
            flowId: input.flowId,
            workRunId: input.workRunId,
            specRevisionId: input.specRevisionId ?? turn.specRevisionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run();
          plan = db.select().from(orchestrationPlans).where(eq(orchestrationPlans.id, planId)).get();
        } else {
          db.update(orchestrationPlans).set({ updatedAt: timestamp }).where(eq(orchestrationPlans.id, planId)).run();
        }
        if (input.basedOnRevisionId) {
          db.update(planRevisions)
            .set({ status: "superseded", supersededAt: timestamp })
            .where(eq(planRevisions.id, input.basedOnRevisionId))
            .run();
          db.update(planApprovals)
            .set({ status: "superseded", resolvedAt: timestamp })
            .where(eq(planApprovals.planRevisionId, input.basedOnRevisionId))
            .run();
          db.update(planFeedback)
            .set({ status: "resolved", resolutionNote: "已由新计划版本处理", resolvedAt: timestamp })
            .where(and(eq(planFeedback.planRevisionId, input.basedOnRevisionId), eq(planFeedback.status, "pending")))
            .run();
        }
        db.insert(planRevisions).values({
          id: revisionId,
          planId,
          revisionNumber,
          parentRevisionId: input.basedOnRevisionId ?? null,
          sourceFeedbackMessageId: input.sourceFeedbackMessageId ?? null,
          status: input.status,
          title: input.title,
          objective: input.objective,
          workKind: input.workKind,
          riskLevel: input.riskLevel,
          lintJson: JSON.stringify(input.lint),
          diffJson: JSON.stringify(input.diff),
          sourceAgentSessionId: input.sourceAgentSessionId ?? "",
          createdAt: timestamp,
          approvedAt: input.status === "approved" ? timestamp : null,
          supersededAt: null,
        }).run();
        for (const node of input.nodes) {
          const nodeId = nodeIds.get(node.nodeId)!;
          db.insert(planNodes).values({
            id: nodeId,
            planRevisionId: revisionId,
            stableKey: node.nodeId,
            expertId: node.expertId,
            title: node.title,
            description: node.description,
            acceptanceCriteriaJson: JSON.stringify(node.acceptanceCriteria),
            riskTagsJson: JSON.stringify(node.riskTags),
            sideEffectsJson: JSON.stringify(node.sideEffects),
            resourceKeysJson: JSON.stringify(node.resourceKeys),
            createdAt: timestamp,
          }).run();
          for (const dependencyKey of node.dependsOn) {
            db.insert(planDependencies).values({
              planRevisionId: revisionId,
              nodeId,
              dependsOnNodeId: nodeIds.get(dependencyKey)!,
              createdAt: timestamp,
            }).run();
          }
        }
        db.insert(planApprovals).values({
          id: approvalId,
          flowId: input.flowId,
          workRunId: input.workRunId,
          planRevisionId: revisionId,
          status: input.status === "approved" ? "auto_approved" : "pending",
          resolutionActionId: null,
          createdAt: timestamp,
          resolvedAt: input.status === "approved" ? timestamp : null,
        }).run();
        if (input.status === "pending_approval") {
          const activeDurationMs = turn.activeDurationMs + elapsedMs(turn.activeStartedAt, timestamp);
          db.update(workRuns).set({
            status: "waiting_user",
            activeStartedAt: null,
            activeDurationMs,
            waitingStartedAt: timestamp,
            updatedAt: timestamp,
          }).where(eq(workRuns.id, turn.id)).run();
        }
      })();
      return {
        plan: db.select().from(orchestrationPlans).where(eq(orchestrationPlans.id, planId)).get()!,
        revision: db.select().from(planRevisions).where(eq(planRevisions.id, revisionId)).get()!,
        approval: db.select().from(planApprovals).where(eq(planApprovals.id, approvalId)).get()!,
      };
    },
    listOrchestrationPlans(flowId: string) {
      return db.select().from(orchestrationPlans).where(eq(orchestrationPlans.flowId, flowId)).all();
    },
    getOrchestrationPlan(planId: string) {
      return db.select().from(orchestrationPlans).where(eq(orchestrationPlans.id, planId)).get();
    },
    listPlanRevisions(planId: string) {
      return db.select().from(planRevisions).where(eq(planRevisions.planId, planId)).all().sort((a, b) => a.revisionNumber - b.revisionNumber);
    },
    getPlanRevision(revisionId: string) {
      return db.select().from(planRevisions).where(eq(planRevisions.id, revisionId)).get();
    },
    listPlanNodes(revisionId: string) {
      return db.select().from(planNodes).where(eq(planNodes.planRevisionId, revisionId)).all();
    },
    listPlanNodeDependencies(revisionId: string, nodeId: string) {
      return db.select().from(planDependencies).where(eq(planDependencies.planRevisionId, revisionId)).all()
        .filter((row) => row.nodeId === nodeId)
        .map((row) => row.dependsOnNodeId);
    },
    listPlanApprovals(flowId: string) {
      return db.select().from(planApprovals).where(eq(planApprovals.flowId, flowId)).all();
    },
    getPlanApproval(approvalId: string) {
      return db.select().from(planApprovals).where(eq(planApprovals.id, approvalId)).get();
    },
    getPlanApprovalForRevision(revisionId: string) {
      return db.select().from(planApprovals).where(eq(planApprovals.planRevisionId, revisionId)).get();
    },
    setPlanApprovalFeedbackPending(input: { approvalId: string; sourceMessageId: string; feedback: Array<{ planNodeId?: string | null; markerNumber: number; comment: string }> }) {
      const approval = db.select().from(planApprovals).where(eq(planApprovals.id, input.approvalId)).get();
      if (!approval || approval.status !== "pending") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(planApprovals).set({ status: "feedback_pending" }).where(eq(planApprovals.id, approval.id)).run();
        for (const item of input.feedback) {
          db.insert(planFeedback).values({
            id: id("pfb"), flowId: approval.flowId, workRunId: approval.workRunId,
            planRevisionId: approval.planRevisionId, planNodeId: item.planNodeId ?? null,
            sourceMessageId: input.sourceMessageId, markerNumber: item.markerNumber,
            comment: item.comment, status: "pending", resolutionNote: null,
            createdAt: timestamp, resolvedAt: null,
          }).run();
        }
        const turn = db.select().from(workRuns).where(eq(workRuns.id, approval.workRunId)).get();
        if (turn?.status === "waiting_user") {
          const status = turn.executionStartedAt ? "executing" : "ready";
          db.update(workRuns).set({ status, revision: turn.revision + 1, activeStartedAt: status === "executing" ? timestamp : null, waitingStartedAt: null, updatedAt: timestamp }).where(eq(workRuns.id, turn.id)).run();
        }
      })();
      return db.select().from(planApprovals).where(eq(planApprovals.id, approval.id)).get()!;
    },
    listPlanFeedback(revisionId: string) {
      return db.select().from(planFeedback).where(eq(planFeedback.planRevisionId, revisionId)).all();
    },
    recordPlanFeedback(input: { flowId: string; workRunId: string; planRevisionId: string; sourceMessageId: string; feedback: Array<{ planNodeId?: string | null; markerNumber: number; comment: string }> }) {
      const revision = db.select().from(planRevisions).where(eq(planRevisions.id, input.planRevisionId)).get();
      const plan = revision ? db.select().from(orchestrationPlans).where(eq(orchestrationPlans.id, revision.planId)).get() : undefined;
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      const run = db.select().from(planRuns).where(eq(planRuns.planRevisionId, input.planRevisionId)).get();
      if (
        !plan
        || plan.flowId !== input.flowId
        || plan.workRunId !== input.workRunId
        || !turn
        || turn.flowId !== input.flowId
        || turn.status !== "executing"
        || !run
        || run.workRunId !== input.workRunId
        || !["running", "blocked", "paused_for_feedback"].includes(run.status)
      ) return undefined;
      const existing = db.select().from(planFeedback).where(eq(planFeedback.planRevisionId, input.planRevisionId)).all().filter((row) => row.sourceMessageId === input.sourceMessageId);
      if (existing.length > 0) return existing;
      const timestamp = now();
      sqlite.transaction(() => {
        for (const item of input.feedback) db.insert(planFeedback).values({
          id: id("pfb"), flowId: input.flowId, workRunId: input.workRunId,
          planRevisionId: input.planRevisionId, planNodeId: item.planNodeId ?? null,
          sourceMessageId: input.sourceMessageId, markerNumber: item.markerNumber,
          comment: item.comment, status: "pending", resolutionNote: null,
          createdAt: timestamp, resolvedAt: null,
        }).run();
        db.update(planRuns)
          .set({ status: "paused_for_feedback", completedAt: null, updatedAt: timestamp })
          .where(and(
            eq(planRuns.planRevisionId, input.planRevisionId),
            eq(planRuns.workRunId, input.workRunId),
            // A paused run is already frozen; terminal and superseded runs must remain historical.
            sql`${planRuns.status} IN ('running', 'blocked')`,
          ))
          .run();
      })();
      return db.select().from(planFeedback).where(eq(planFeedback.planRevisionId, input.planRevisionId)).all().filter((row) => row.sourceMessageId === input.sourceMessageId);
    },
    restorePlanApprovalAfterFeedback(approvalId: string, note = "") {
      const approval = db.select().from(planApprovals).where(eq(planApprovals.id, approvalId)).get();
      if (!approval || approval.status !== "feedback_pending") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(planApprovals).set({ status: "pending" }).where(eq(planApprovals.id, approvalId)).run();
        for (const feedback of db.select().from(planFeedback).where(eq(planFeedback.planRevisionId, approval.planRevisionId)).all().filter((row) => row.status === "pending")) {
          db.update(planFeedback).set({ status: "resolved", resolutionNote: note, resolvedAt: timestamp }).where(eq(planFeedback.id, feedback.id)).run();
        }
        const turn = db.select().from(workRuns).where(eq(workRuns.id, approval.workRunId)).get();
        if (turn && ["ready", "executing"].includes(turn.status)) {
          const activeDurationMs = turn.status === "executing"
            ? turn.activeDurationMs + elapsedMs(turn.activeStartedAt, timestamp)
            : turn.activeDurationMs;
          db.update(workRuns).set({ status: "waiting_user", revision: turn.revision + 1, activeStartedAt: null, activeDurationMs, waitingStartedAt: timestamp, updatedAt: timestamp }).where(eq(workRuns.id, turn.id)).run();
        }
      })();
      return db.select().from(planApprovals).where(eq(planApprovals.id, approvalId)).get()!;
    },
    resumePlanRunAfterFeedback(runId: string, note = "") {
      const run = db.select().from(planRuns).where(eq(planRuns.id, runId)).get();
      if (!run || run.status !== "paused_for_feedback") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(planRuns)
          .set({ status: "running", completedAt: null, updatedAt: timestamp })
          .where(eq(planRuns.id, runId))
          .run();
        for (const feedback of db.select().from(planFeedback)
          .where(eq(planFeedback.planRevisionId, run.planRevisionId))
          .all()
          .filter((row) => row.status === "pending")) {
          db.update(planFeedback)
            .set({ status: "resolved", resolutionNote: note, resolvedAt: timestamp })
            .where(eq(planFeedback.id, feedback.id))
            .run();
        }
      })();
      return db.select().from(planRuns).where(eq(planRuns.id, runId)).get()!;
    },
    resolvePlanApproval(input: { approvalId: string; clientActionId: string }) {
      const approval = db.select().from(planApprovals).where(eq(planApprovals.id, input.approvalId)).get();
      if (!approval) return undefined;
      if (approval.status === "approved" && approval.resolutionActionId === input.clientActionId) return approval;
      if (approval.status !== "pending") return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(planApprovals).set({ status: "approved", resolutionActionId: input.clientActionId, resolvedAt: timestamp }).where(eq(planApprovals.id, approval.id)).run();
        db.update(planRevisions).set({ status: "approved", approvedAt: timestamp }).where(eq(planRevisions.id, approval.planRevisionId)).run();
        const turn = db.select().from(workRuns).where(eq(workRuns.id, approval.workRunId)).get();
        if (turn?.status === "waiting_user") {
          const status = turn.executionStartedAt ? "executing" : "ready";
          db.update(workRuns).set({ status, revision: turn.revision + 1, activeStartedAt: status === "executing" ? timestamp : null, waitingStartedAt: null, updatedAt: timestamp }).where(eq(workRuns.id, turn.id)).run();
        }
      })();
      return db.select().from(planApprovals).where(eq(planApprovals.id, approval.id)).get()!;
    },
    materializePlanRun(revisionId: string) {
      const revision = db.select().from(planRevisions).where(eq(planRevisions.id, revisionId)).get();
      const plan = revision ? db.select().from(orchestrationPlans).where(eq(orchestrationPlans.id, revision.planId)).get() : undefined;
      if (!revision || !plan || revision.status !== "approved") return undefined;
      const existingRun = db.select().from(planRuns).where(eq(planRuns.planRevisionId, revisionId)).get();
      if (existingRun) return existingRun;
      const timestamp = now();
      const runId = id("prun");
      const nodes = db.select().from(planNodes).where(eq(planNodes.planRevisionId, revisionId)).all();
      const previousRevision = revision.parentRevisionId
        ? db.select().from(planRevisions).where(eq(planRevisions.id, revision.parentRevisionId)).get()
        : undefined;
      const previousRun = previousRevision
        ? db.select().from(planRuns).where(eq(planRuns.planRevisionId, previousRevision.id)).get()
        : undefined;
      const previousNodes = previousRevision
        ? db.select().from(planNodes).where(eq(planNodes.planRevisionId, previousRevision.id)).all()
        : [];
      const previousNodeById = new Map(previousNodes.map((node) => [node.id, node]));
      const previousNodeByStableKey = new Map(previousNodes.map((node) => [node.stableKey, node]));
      const previousMappingByNodeId = new Map(
        previousRun
          ? db.select().from(planNodeTasks).where(eq(planNodeTasks.planRunId, previousRun.id)).all().map((mapping) => [mapping.planNodeId, mapping])
          : [],
      );
      const diff = parseJsonObject(revision.diffJson);
      const modifiedStableKeys = new Set(
        Array.isArray(diff.modified)
          ? diff.modified.flatMap((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return [];
              const nodeId = (item as { node_id?: unknown }).node_id;
              return typeof nodeId === "string" ? [nodeId] : [];
            })
          : [],
      );
      const reusedTaskIds = new Map<string, string>();
      const createdTaskIds = new Map(nodes.map((node) => [node.id, id("task")]));
      if (previousRun) {
        for (const node of nodes) {
          const previousNode = previousNodeByStableKey.get(node.stableKey);
          const previousMapping = previousNode ? previousMappingByNodeId.get(previousNode.id) : undefined;
          const previousTask = previousMapping ? db.select().from(tasks).where(eq(tasks.id, previousMapping.taskId)).get() : undefined;
          if (
            previousNode
            && previousMapping
            && previousTask?.status === "completed"
            && !modifiedStableKeys.has(node.stableKey)
          ) {
            reusedTaskIds.set(node.id, previousMapping.taskId);
          }
        }
      }

      const taskIdForNode = (nodeId: string) => reusedTaskIds.get(nodeId) ?? createdTaskIds.get(nodeId)!;
      const activeTaskStatuses = new Set(["in_progress"]);
      sqlite.transaction(() => {
        if (previousRun) {
          for (const previousMapping of db.select().from(planNodeTasks).where(eq(planNodeTasks.planRunId, previousRun.id)).all()) {
            const previousNode = previousNodeById.get(previousMapping.planNodeId);
            const previousTask = db.select().from(tasks).where(eq(tasks.id, previousMapping.taskId)).get();
            const reused = previousTask?.status === "completed"
              && previousNode
              && nodes.some((node) => node.stableKey === previousNode.stableKey)
              && !modifiedStableKeys.has(previousNode.stableKey);
            if (reused) continue;
            if (previousTask?.status === "pending") {
              db.update(tasks)
                .set({ status: "cancelled", finishedAt: timestamp, updatedAt: timestamp })
                .where(eq(tasks.id, previousTask.id))
                .run();
            }
            if (!activeTaskStatuses.has(previousTask?.status ?? "")) {
              db.update(planNodeTasks)
                .set({ disposition: "replaced" })
                .where(and(eq(planNodeTasks.planRunId, previousRun.id), eq(planNodeTasks.planNodeId, previousMapping.planNodeId)))
                .run();
            }
          }
          db.update(planRuns)
            .set({ status: "superseded", completedAt: null, updatedAt: timestamp })
            .where(eq(planRuns.id, previousRun.id))
            .run();
        }
        db.insert(planRuns).values({ id: runId, flowId: plan.flowId, workRunId: plan.workRunId, planRevisionId: revisionId, status: "running", createdAt: timestamp, startedAt: timestamp, completedAt: null, updatedAt: timestamp }).run();
        for (const node of nodes) {
          const taskId = taskIdForNode(node.id);
          if (!reusedTaskIds.has(node.id)) {
            db.insert(tasks).values({
              id: taskId, flowId: plan.flowId, workRunId: plan.workRunId,
              title: node.title, description: node.description, expertId: node.expertId,
              flowExpertId: null, status: "pending", revision: 1, activeForm: node.title,
              progress: null,
              agentSessionId: null, metadataJson: JSON.stringify({ plan_revision_id: revisionId, plan_node_id: node.id, resource_keys: parseJsonStringArray(node.resourceKeysJson) }),
              acceptanceCriteriaJson: node.acceptanceCriteriaJson, resultArtifactIdsJson: "[]", resultJson: null, errorMessage: null,
              createdByAgentSessionId: revision.sourceAgentSessionId, createdAt: timestamp, startedAt: null, finishedAt: null, updatedAt: timestamp,
            }).run();
          }
          db.insert(planNodeTasks).values({ planRunId: runId, planNodeId: node.id, taskId, disposition: reusedTaskIds.has(node.id) ? "reused" : "created", createdAt: timestamp }).run();
        }
        const edges = db.select().from(planDependencies).where(eq(planDependencies.planRevisionId, revisionId)).all();
        for (const edge of edges) {
          db.insert(taskDependencies)
            .values({ taskId: taskIdForNode(edge.nodeId), dependsOnTaskId: taskIdForNode(edge.dependsOnNodeId), createdAt: timestamp })
            .onConflictDoNothing()
            .run();
        }
      })();
      return db.select().from(planRuns).where(eq(planRuns.id, runId)).get()!;
    },
    listPlanRuns(flowId: string) {
      return db.select().from(planRuns).where(eq(planRuns.flowId, flowId)).all();
    },
    getPlanRun(runId: string) {
      return db.select().from(planRuns).where(eq(planRuns.id, runId)).get();
    },
    getPlanRunForRevision(revisionId: string) {
      return db.select().from(planRuns).where(eq(planRuns.planRevisionId, revisionId)).get();
    },
    listPlanNodeTasks(runId: string) {
      return db.select().from(planNodeTasks).where(eq(planNodeTasks.planRunId, runId)).all();
    },
    updatePlanRunStatus(runId: string, status: string) {
      const timestamp = now();
      db.update(planRuns).set({ status, updatedAt: timestamp, completedAt: ["completed", "failed", "cancelled"].includes(status) ? timestamp : null }).where(eq(planRuns.id, runId)).run();
      return db.select().from(planRuns).where(eq(planRuns.id, runId)).get();
    },
    getRiskMode(flowId: string): "auto_edit" | "full_access" {
      return db.select().from(flows).where(eq(flows.id, flowId)).get()?.riskMode === "full_access"
        ? "full_access"
        : "auto_edit";
    },
    getPlanApprovalMode(flowId: string): "on" | "off" {
      return db.select().from(flows).where(eq(flows.id, flowId)).get()?.planApproval === "off" ? "off" : "on";
    },
    cancelPendingPermissionDecisionCards() {
      const timestamp = now();
      db.update(decisionCards)
        .set({ status: "cancelled", resolutionKind: "cancelled", resolvedAt: timestamp })
        .where(and(eq(decisionCards.cardType, "permission_confirmation"), eq(decisionCards.status, "pending")))
        .run();
    },
    listOrchestrationRules(input?: { flowId?: string; projectId?: string | null }) {
      return db.select().from(orchestrationRules).all().filter((row) =>
        row.scopeType === "global"
        || (row.scopeType === "project" && row.scopeId === input?.projectId)
        || (row.scopeType === "flow" && row.scopeId === input?.flowId)
      );
    },
    saveOrchestrationRule(input: {
      id?: string;
      scopeType: "global" | "project" | "flow";
      scopeId: string;
      name: string;
      severity: "block" | "warn" | "info";
      enabled: boolean;
      rule: Record<string, unknown>;
    }) {
      const timestamp = now();
      const ruleId = input.id ?? id("orule");
      const existing = input.id ? db.select().from(orchestrationRules).where(eq(orchestrationRules.id, input.id)).get() : undefined;
      if (input.id && !existing) return undefined;
      if (existing) {
        db.update(orchestrationRules).set({
          name: input.name, severity: input.severity, enabled: input.enabled ? 1 : 0,
          ruleJson: JSON.stringify(input.rule), updatedAt: timestamp,
        }).where(eq(orchestrationRules.id, ruleId)).run();
      } else {
        db.insert(orchestrationRules).values({
          id: ruleId, scopeType: input.scopeType, scopeId: input.scopeId,
          name: input.name, severity: input.severity, enabled: input.enabled ? 1 : 0,
          ruleJson: JSON.stringify(input.rule), createdAt: timestamp, updatedAt: timestamp,
        }).run();
      }
      return db.select().from(orchestrationRules).where(eq(orchestrationRules.id, ruleId)).get();
    },
    deleteOrchestrationRule(ruleId: string) {
      const existing = db.select().from(orchestrationRules).where(eq(orchestrationRules.id, ruleId)).get();
      if (!existing) return false;
      db.delete(orchestrationRules).where(eq(orchestrationRules.id, ruleId)).run();
      return true;
    },
    createTask(input: {
      flowId: string;
      workRunId: string;
      title: string;
      description: string;
      expertId?: string | null;
      activeForm?: string;
      dependsOnTaskIds?: string[];
      acceptanceCriteria?: string[];
      createdByAgentSessionId?: string;
    }) {
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!turn || turn.flowId !== input.flowId || !["ready", "executing"].includes(turn.status) || !turn.workRootPath) return undefined;
      const dependencyRows = (input.dependsOnTaskIds ?? []).map((taskId) => db.select().from(tasks).where(eq(tasks.id, taskId)).get());
      if (dependencyRows.some((task) => !task || task.workRunId !== input.workRunId)) return undefined;
      const timestamp = now();
      const row = {
        id: id("task"),
        flowId: input.flowId,
        workRunId: input.workRunId,
        title: input.title,
        description: input.description,
        expertId: input.expertId ?? null,
        flowExpertId: null,
        status: "pending",
        revision: 1,
        activeForm: input.activeForm ?? "",
        progress: null,
        agentSessionId: null,
        metadataJson: "{}",
        acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria ?? []),
        resultArtifactIdsJson: "[]",
        resultJson: null,
        errorMessage: null,
        createdByAgentSessionId: input.createdByAgentSessionId ?? "",
        createdAt: timestamp,
        startedAt: null,
        finishedAt: null,
        updatedAt: timestamp,
      };
      sqlite.transaction(() => {
        db.insert(tasks).values(row).run();
        for (const dependsOnTaskId of input.dependsOnTaskIds ?? []) {
          db.insert(taskDependencies).values({
            taskId: row.id,
            dependsOnTaskId,
            createdAt: timestamp,
          }).run();
        }
      })();
      return db.select().from(tasks).where(eq(tasks.id, row.id)).get()!;
    },
    listTasks(flowId: string) {
      return db.select().from(tasks).where(eq(tasks.flowId, flowId)).all();
    },
    listWorkRunTasks(workRunId: string) {
      return db.select().from(tasks).where(eq(tasks.workRunId, workRunId)).all();
    },
    getTask(taskId: string) {
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    },
    startAgentDispatch(input: {
      flowId: string;
      taskId: string;
      expertId: string;
      flowExpertId: string;
      displayName: string;
      resumeFromAgentSessionId?: string;
    }) {
      const sessionId = id("ags");
      const timestamp = now();
      let started = false;

      sqlite.transaction(() => {
        const task = db.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
        if (!task || task.flowId !== input.flowId) return;
        const flowExpert = db.select().from(flowExperts).where(eq(flowExperts.id, input.flowExpertId)).get();
        if (!flowExpert || flowExpert.flowId !== input.flowId || flowExpert.expertId !== input.expertId) return;
        const turn = db.select().from(workRuns).where(eq(workRuns.id, task.workRunId)).get();
        if (!turn || !["ready", "executing"].includes(turn.status)) return;
        if (task.expertId && task.expertId !== input.expertId) return;

        const dependencies = db.select()
          .from(taskDependencies)
          .where(eq(taskDependencies.taskId, task.id))
          .all();
        if (dependencies.some((edge) =>
          db.select().from(tasks).where(eq(tasks.id, edge.dependsOnTaskId)).get()?.status !== "completed"
        )) return;

        const currentSession = task.agentSessionId
          ? db.select().from(agentSessions).where(eq(agentSessions.id, task.agentSessionId)).get()
          : undefined;
        if (input.resumeFromAgentSessionId) {
          const resumeSession = db.select().from(agentSessions)
            .where(eq(agentSessions.id, input.resumeFromAgentSessionId))
            .get();
          if (
            !resumeSession
            || resumeSession.flowId !== input.flowId
            || resumeSession.taskId !== task.id
            || resumeSession.expertId !== input.expertId
            || !["completed", "failed", "interrupted"].includes(resumeSession.status)
          ) return;
        }
        if (task.status === "pending") {
          if (task.agentSessionId) return;
        } else if (task.status === "in_progress") {
          if (currentSession && !["completed", "failed", "interrupted"].includes(currentSession.status)) return;
        } else {
          return;
        }

        db.insert(agentSessions).values({
          id: sessionId,
          flowId: input.flowId,
          workRunId: task.workRunId,
          taskId: task.id,
          expertId: input.expertId,
          flowExpertId: input.flowExpertId,
          sessionId: null,
          displayName: input.displayName,
          resumeFromAgentSessionId: input.resumeFromAgentSessionId ?? "",
          status: "queued",
          createdAt: timestamp,
          updatedAt: timestamp,
        }).run();
        db.update(tasks)
          .set({
            expertId: input.expertId,
            flowExpertId: input.flowExpertId,
            agentSessionId: sessionId,
            status: "in_progress",
            revision: task.revision + 1,
            startedAt: task.startedAt ?? timestamp,
            finishedAt: null,
            resultJson: null,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(eq(tasks.id, task.id))
          .run();
        db.update(flowExperts)
          .set({ status: flowExpert.status === "streaming" ? "streaming" : "queued", updatedAt: timestamp })
          .where(eq(flowExperts.id, input.flowExpertId))
          .run();
        beginWorkRunExecution(turn.id, timestamp);
        syncFlowExecutionStatus(input.flowId, timestamp);
        started = true;
      })();

      if (!started) return undefined;
      return {
        task: db.select().from(tasks).where(eq(tasks.id, input.taskId)).get()!,
        agentSession: db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()!,
        flowExpert: db.select().from(flowExperts).where(eq(flowExperts.id, input.flowExpertId)).get()!,
      };
    },

    dispatchAgent(input: {
      flowId: string;
      taskId: string;
      expertId: string;
      resumeAgentSessionId: string;
    }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      if (!flow) return { ok: false as const, error: { code: "FLOW_NOT_FOUND", message: "flow not found" } };
      const expert = db.select().from(experts).where(eq(experts.id, input.expertId)).get();
      if (!expert) return { ok: false as const, error: { code: "EXPERT_NOT_FOUND", message: "expert not found" } };
      const task = db.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task || task.flowId !== input.flowId) return { ok: false as const, error: { code: "INVALID_TASK", message: "task not found" } };
      const turn = db.select().from(workRuns).where(eq(workRuns.id, task.workRunId)).get();
      if (!turn || !["ready", "executing"].includes(turn.status)) {
        return { ok: false as const, error: { code: turn?.status === "interrupted" ? "WORK_RUN_INTERRUPTED" : "WORK_RUN_NOT_EXECUTABLE", message: "work run is not executable" } };
      }
      if (task.expertId !== null && task.expertId !== input.expertId) {
        return { ok: false as const, error: { code: "EXPERT_MISMATCH", message: "expert does not match task expert" } };
      }
      const dependencyIds = db.select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, input.taskId))
        .all()
        .map((row) => row.dependsOnTaskId);
      const dependenciesComplete = dependencyIds.every((dependencyId) =>
        db.select().from(tasks).where(eq(tasks.id, dependencyId)).get()?.status === "completed"
      );
      if (!dependenciesComplete) {
        return { ok: false as const, error: { code: "TASK_BLOCKED", message: "task is blocked by incomplete dependencies" } };
      }
      if (task.status !== "pending") {
        return { ok: false as const, error: { code: "TASK_NOT_PENDING", message: "task is not pending" } };
      }

      const timestamp = now();
      const agentSessionId = id("ags");
      const displayName = expert.name || input.expertId;

      let started: typeof task | undefined;
      sqlite.transaction(() => {
        db.insert(agentSessions).values({
          id: agentSessionId,
          flowId: input.flowId,
          workRunId: task.workRunId,
          taskId: task.id,
          expertId: input.expertId,
          sessionId: null,
          displayName,
          resumeFromAgentSessionId: input.resumeAgentSessionId,
          status: "streaming",
          createdAt: timestamp,
          updatedAt: timestamp,
        }).run();
        db.update(tasks)
          .set({
            expertId: input.expertId,
            agentSessionId,
            status: "in_progress",
            revision: task.revision + 1,
            startedAt: timestamp,
            updatedAt: timestamp,
          })
          .where(eq(tasks.id, input.taskId))
          .run();
        beginWorkRunExecution(turn.id, timestamp);
        syncFlowExecutionStatus(input.flowId, timestamp);
        started = db.select().from(tasks).where(eq(tasks.id, input.taskId)).get() ?? undefined;
      })();

      if (!started) {
        return { ok: false as const, error: { code: "TASK_START_FAILED", message: "task could not be started" } };
      }

      return {
        ok: true as const,
        agent_session: db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!,
        task: started,
      };
    },
    assignTaskAgentSession(taskId: string, agentSessionId: string) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!existing || existing.agentSessionId) return undefined;
      db.update(tasks)
        .set({ agentSessionId, revision: existing.revision + 1, updatedAt: now() })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    listTaskDependencies(taskId: string) {
      return db.select().from(taskDependencies).where(eq(taskDependencies.taskId, taskId)).all()
        .map((row) => row.dependsOnTaskId);
    },
    listRunnableTasks(workRunId: string) {
      return db.select().from(tasks).where(eq(tasks.workRunId, workRunId)).all()
        .filter((task) => {
          if (task.status !== "pending" || task.agentSessionId) return false;
          const dependencyIds = db.select()
            .from(taskDependencies)
            .where(eq(taskDependencies.taskId, task.id))
            .all()
            .map((row) => row.dependsOnTaskId);
          return dependencyIds.every((dependencyId) =>
            db.select().from(tasks).where(eq(tasks.id, dependencyId)).get()?.status === "completed"
          );
        });
    },
    startTask(taskId: string, agentSessionId: string) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const workRun = existing ? db.select().from(workRuns).where(eq(workRuns.id, existing.workRunId)).get() : undefined;
      if (
        !existing
        || !workRun
        || !["ready", "executing"].includes(workRun.status)
        || existing.status !== "pending"
        || (existing.agentSessionId && existing.agentSessionId !== agentSessionId)
      ) return undefined;
      const dependencyIds = db.select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, taskId))
        .all()
        .map((row) => row.dependsOnTaskId);
      const dependenciesComplete = dependencyIds.every((dependencyId) =>
        db.select().from(tasks).where(eq(tasks.id, dependencyId)).get()?.status === "completed"
      );
      if (!dependenciesComplete) return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(tasks)
          .set({ status: "in_progress", agentSessionId, revision: existing.revision + 1, startedAt: timestamp, updatedAt: timestamp })
          .where(eq(tasks.id, taskId))
          .run();
        beginWorkRunExecution(workRun.id, timestamp);
        syncFlowExecutionStatus(existing.flowId, timestamp);
      })();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    completeTask(taskId: string, resultJson = "{}") {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const workRun = existing ? db.select().from(workRuns).where(eq(workRuns.id, existing.workRunId)).get() : undefined;
      if (!existing || existing.status !== "in_progress" || workRun?.status !== "executing") return undefined;
      const timestamp = now();
      db.update(tasks)
        .set({ status: "completed", revision: existing.revision + 1, resultJson, finishedAt: timestamp, updatedAt: timestamp })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    updateTask(taskId: string, input: {
      title?: string;
      description?: string;
      status?: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
      expectedRevision?: number;
      activeForm?: string;
      progress?: string | null;
      expertId?: string;
      owner?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      addBlockedBy?: string[];
      resultJson?: string | null;
      errorMessage?: string | null;
    }) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!existing) return undefined;
      const workRun = db.select().from(workRuns).where(eq(workRuns.id, existing.workRunId)).get();
      if (!workRun || ["interrupted", "completed", "failed", "cancelled"].includes(workRun.status)) return undefined;
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) return undefined;

      const isReassignment = input.expertId !== undefined && input.expertId !== existing.expertId;
      if (isReassignment && !db.select().from(experts).where(eq(experts.id, input.expertId!)).get()) {
        return undefined;
      }

      const allowedTransitions: Record<string, Set<string>> = {
        pending: new Set(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"]),
        in_progress: new Set(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"]),
        blocked: new Set(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"]),
        completed: new Set(["completed", "pending"]),
        failed: new Set(["failed", "pending"]),
        cancelled: new Set(["cancelled", "pending"]),
      };
      if (input.status && !allowedTransitions[existing.status]?.has(input.status)) {
        return undefined;
      }
      const isReopening = input.status === "pending" && existing.status !== "pending";
      if (isReopening && existing.agentSessionId) {
        const session = db.select().from(agentSessions).where(eq(agentSessions.id, existing.agentSessionId)).get();
        if (session && ["queued", "streaming"].includes(session.status)) return undefined;
      }
      if (isReassignment) {
        const currentSession = existing.agentSessionId
          ? db.select().from(agentSessions).where(eq(agentSessions.id, existing.agentSessionId)).get()
          : undefined;
        if (currentSession && ["queued", "streaming"].includes(currentSession.status)) return undefined;
      }

      function hasCycle(startTaskId: string, targetDependsOnTaskId: string): boolean {
        const visited = new Set<string>();
        function walk(currentTaskId: string): boolean {
          if (currentTaskId === startTaskId) return true;
          if (visited.has(currentTaskId)) return false;
          visited.add(currentTaskId);
          const nextIds = db.select().from(taskDependencies).where(eq(taskDependencies.taskId, currentTaskId)).all()
            .map((row) => row.dependsOnTaskId);
          return nextIds.some(walk);
        }
        return walk(targetDependsOnTaskId);
      }

      const addBlocks = input.addBlocks ?? [];
      const addBlockedBy = input.addBlockedBy ?? [];
      for (const dependsOnTaskId of [...addBlocks, ...addBlockedBy]) {
        const other = db.select().from(tasks).where(eq(tasks.id, dependsOnTaskId)).get();
        if (!other || other.workRunId !== existing.workRunId || dependsOnTaskId === taskId) {
          return undefined;
        }
      }

      const allNewDependencies = [
        ...addBlocks.map((dependsOnTaskId) => ({ taskId: dependsOnTaskId, dependsOnTaskId: taskId })),
        ...addBlockedBy.map((dependsOnTaskId) => ({ taskId: taskId, dependsOnTaskId })),
      ];
      for (const edge of allNewDependencies) {
        const edgeTarget = db.select().from(tasks).where(eq(tasks.id, edge.taskId)).get();
        if (!edgeTarget || edgeTarget.status !== "pending") {
          return undefined;
        }
        if (hasCycle(edge.taskId, edge.dependsOnTaskId)) {
          return undefined;
        }
      }

      if (existing.status !== "pending" && (addBlocks.length > 0 || addBlockedBy.length > 0)) {
        return undefined;
      }

      const metadata = parseJsonObject(existing.metadataJson);
      if (input.metadata) {
        for (const [key, value] of Object.entries(input.metadata)) {
          if (value === null) {
            delete metadata[key];
          } else {
            metadata[key] = value;
          }
        }
      }
      if (input.owner !== undefined) {
        metadata.owner = input.owner;
      }

      const timestamp = now();
      const nextStatus = input.status ?? existing.status;
      // Reassignment is an explicit Leader decision. A task that has already
      // started must first be returned to pending so the hand-off is visible
      // rather than silently looking like the new Expert was already working.
      if (isReassignment && nextStatus !== "pending") return undefined;
      const isTerminal = ["completed", "failed", "cancelled"].includes(nextStatus);
      const finishedAt = isTerminal
        ? (input.status !== undefined && input.status !== existing.status ? timestamp : existing.finishedAt ?? timestamp)
        : null;
      const startedAt = isReopening
        ? null
        : nextStatus === "in_progress"
          ? existing.startedAt ?? timestamp
          : existing.startedAt;

      sqlite.transaction(() => {
        db.update(tasks)
          .set({
            title: input.title ?? existing.title,
            description: input.description ?? existing.description,
            status: nextStatus,
            revision: existing.revision + 1,
            activeForm: input.activeForm ?? existing.activeForm,
            progress: input.progress === undefined ? existing.progress : input.progress,
            expertId: input.expertId ?? existing.expertId,
            // A FlowExpert owns a provider conversation. Moving this one Task
            // to a different Expert deliberately clears the source association;
            // the next explicit dispatch uses the target FlowExpert (and never
            // resumes the source Expert's provider session).
            flowExpertId: isReassignment ? null : existing.flowExpertId,
            agentSessionId: isReopening || isReassignment ? null : existing.agentSessionId,
            metadataJson: JSON.stringify(metadata),
            resultJson: isReopening ? null : (input.resultJson === undefined ? existing.resultJson : input.resultJson),
            errorMessage: isReopening ? null : (input.errorMessage === undefined ? existing.errorMessage : input.errorMessage),
            startedAt,
            finishedAt,
            updatedAt: timestamp,
          })
          .where(eq(tasks.id, taskId))
          .run();

        for (const edge of allNewDependencies) {
          try {
            db.insert(taskDependencies).values({
              taskId: edge.taskId,
              dependsOnTaskId: edge.dependsOnTaskId,
              createdAt: timestamp,
            }).run();
          } catch {
            // idempotent: composite primary key conflict, ignore
          }
        }
      })();

      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    failTask(taskId: string, errorMessage: string, resultJson?: string) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const workRun = existing ? db.select().from(workRuns).where(eq(workRuns.id, existing.workRunId)).get() : undefined;
      if (!existing || workRun?.status !== "executing" || ["completed", "failed", "cancelled"].includes(existing.status)) return undefined;
      const timestamp = now();
      db.update(tasks)
        .set({
          status: "failed",
          revision: existing.revision + 1,
          errorMessage,
          resultJson: resultJson ?? existing.resultJson,
          finishedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    cancelTask(taskId: string, resultJson?: string) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!existing || ["completed", "failed", "cancelled"].includes(existing.status)) return undefined;
      const timestamp = now();
      db.update(tasks)
        .set({ status: "cancelled", revision: existing.revision + 1, resultJson: resultJson ?? existing.resultJson, finishedAt: timestamp, updatedAt: timestamp })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    appendEventLog(input: {
      flowId: string;
      workRunId?: string | null;
      taskId?: string | null;
      agentSessionId?: string | null;
      eventType: string;
      payload?: Record<string, unknown>;
    }) {
      const flow = db.select().from(flows).where(eq(flows.id, input.flowId)).get();
      if (!flow) return undefined;
      const task = input.taskId ? db.select().from(tasks).where(eq(tasks.id, input.taskId)).get() : undefined;
      const session = input.agentSessionId ? db.select().from(agentSessions).where(eq(agentSessions.id, input.agentSessionId)).get() : undefined;
      const derivedWorkRunId = task?.workRunId ?? session?.workRunId ?? input.workRunId ?? null;
      if ((task && task.flowId !== input.flowId)
        || (session && session.flowId !== input.flowId)
        || (input.workRunId && derivedWorkRunId !== input.workRunId)) return undefined;
      const rowId = id("evt");
      sqlite.transaction(() => {
        const existing = db.select().from(eventLog).where(eq(eventLog.flowId, input.flowId)).all();
        db.insert(eventLog).values({
          id: rowId,
          flowId: input.flowId,
          workRunId: derivedWorkRunId,
          taskId: input.taskId ?? null,
          agentSessionId: input.agentSessionId ?? null,
          eventType: input.eventType,
          payloadJson: JSON.stringify(input.payload ?? {}),
          sequence: existing.reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0) + 1,
          createdAt: now(),
        }).run();
      })();
      return db.select().from(eventLog).where(eq(eventLog.id, rowId)).get()!;
    },
    listEventLog(flowId: string) {
      return db.select().from(eventLog).where(eq(eventLog.flowId, flowId)).all()
        .sort((left, right) => left.sequence - right.sequence);
    },
    getOrCreateFlowExpert(input: { flowId: string; expertId: string }) {
      const existing = db.select().from(flowExperts).where(eq(flowExperts.flowId, input.flowId)).all()
        .find((row) => row.expertId === input.expertId);
      if (existing) return existing;
      const expert = db.select().from(experts).where(eq(experts.id, input.expertId)).get();
      if (!expert) throw new Error(`expert not found: ${input.expertId}`);
      const usedNames = db.select().from(flowExperts).where(eq(flowExperts.flowId, input.flowId)).all()
        .map((row) => row.displayName);
      const displayName = pickPersonDisplayName({
        candidates: parsePersonNameCandidates(expert.personNameCandidates),
        usedNames,
        fallback: expert.name || input.expertId,
      });
      const timestamp = now();
      const row = {
        id: id("fexp"),
        flowId: input.flowId,
        expertId: input.expertId,
        displayName,
        status: "idle",
        sdkSessionId: null,
        runtimeSdk: null,
        runtimeConfigId: null,
        runtimeModelId: null,
        runtimeReasoningEffort: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.insert(flowExperts)
        .values(row)
        .onConflictDoNothing({ target: [flowExperts.flowId, flowExperts.expertId] })
        .run();
      return db.select().from(flowExperts)
        .where(eq(flowExperts.flowId, input.flowId))
        .all()
        .find((candidate) => candidate.expertId === input.expertId)!;
    },
    /**
     * Resolve a Leader-facing expert reference to a template expert id.
     * Does not pre-create FlowExperts.
     * Accepts: existing person_name, template expert_id, role, or role_title (experts.name).
     */
    resolveExpertRef(flowId: string, ref: string): string | null {
      const trimmed = ref.trim();
      if (!trimmed) return null;
      const byTemplate = db.select().from(experts).where(eq(experts.id, trimmed)).get();
      if (byTemplate && byTemplate.role !== "leader") return byTemplate.id;
      const byPerson = db.select().from(flowExperts).where(eq(flowExperts.flowId, flowId)).all()
        .find((row) => row.displayName === trimmed);
      if (byPerson) return byPerson.expertId;
      const lower = trimmed.toLowerCase();
      const byRoleOrTitle = db.select().from(experts).all().find((expert) => {
        if (expert.role === "leader") return false;
        return expert.role === lower || expert.role === trimmed || expert.name === trimmed;
      });
      return byRoleOrTitle?.id ?? null;
    },
    projectLegacyFlowExperts(flowId: string) {
      const sessions = db.select().from(agentSessions).where(eq(agentSessions.flowId, flowId)).all()
        .filter((session) => session.expertId !== "exp-leader");
      for (const session of sessions) {
        let flowExpert = db.select().from(flowExperts).where(eq(flowExperts.flowId, flowId)).all()
          .find((candidate) => candidate.expertId === session.expertId);
        if (!flowExpert) {
          flowExpert = this.getOrCreateFlowExpert({ flowId, expertId: session.expertId });
        }
        if (!flowExpert) continue;
        if (!session.flowExpertId) {
          db.update(agentSessions)
            .set({ flowExpertId: flowExpert.id, updatedAt: now() })
            .where(eq(agentSessions.id, session.id))
            .run();
        }
        if (session.taskId) {
          const task = db.select().from(tasks).where(eq(tasks.id, session.taskId)).get();
          if (task && !task.flowExpertId) {
            db.update(tasks)
              .set({ flowExpertId: flowExpert.id, updatedAt: now() })
              .where(eq(tasks.id, task.id))
              .run();
          }
        }
      }
      return db.select().from(flowExperts).where(eq(flowExperts.flowId, flowId)).all();
    },
    getFlowExpert(flowExpertId: string) {
      return db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get();
    },
    listFlowExperts(flowId: string) {
      return db.select().from(flowExperts).where(eq(flowExperts.flowId, flowId)).all();
    },
    updateFlowExpertSession(flowExpertId: string, sdkSessionId: string) {
      const existing = db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get();
      if (!existing) return undefined;
      db.update(flowExperts)
        .set({ sdkSessionId, updatedAt: now() })
        .where(eq(flowExperts.id, flowExpertId))
        .run();
      return db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get()!;
    },
    lockFlowExpertRuntime(flowExpertId: string, input: { runtimeSdk: string; runtimeConfigId: string; runtimeModelId?: string | null; runtimeReasoningEffort?: string | null }) {
      const existing = db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get();
      if (!existing) return undefined;
      if (existing.runtimeSdk && existing.runtimeConfigId) return existing;
      db.update(flowExperts)
        .set({
          runtimeSdk: existing.runtimeSdk ?? input.runtimeSdk,
          runtimeConfigId: existing.runtimeConfigId ?? input.runtimeConfigId,
          runtimeModelId: existing.runtimeModelId ?? input.runtimeModelId ?? null,
          runtimeReasoningEffort: existing.runtimeReasoningEffort ?? input.runtimeReasoningEffort ?? null,
          updatedAt: now(),
        })
        .where(eq(flowExperts.id, flowExpertId))
        .run();
      return db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get()!;
    },
    updateFlowExpertStatus(flowExpertId: string, status: "idle" | "queued" | "streaming" | "completed" | "failed") {
      const existing = db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get();
      if (!existing) return undefined;
      db.update(flowExperts)
        .set({ status, updatedAt: now() })
        .where(eq(flowExperts.id, flowExpertId))
        .run();
      return db.select().from(flowExperts).where(eq(flowExperts.id, flowExpertId)).get()!;
    },
    assignAgentSessionFlowExpert(agentSessionId: string, flowExpertId: string) {
      const existing = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      if (!existing || (existing.flowExpertId && existing.flowExpertId !== flowExpertId)) return undefined;
      db.update(agentSessions)
        .set({ flowExpertId, updatedAt: now() })
        .where(eq(agentSessions.id, agentSessionId))
        .run();
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!;
    },
    assignTaskFlowExpert(taskId: string, flowExpertId: string, agentSessionId?: string | null) {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!existing) return undefined;
      db.update(tasks)
        .set({
          flowExpertId,
          agentSessionId: agentSessionId ?? existing.agentSessionId,
          revision: existing.revision + 1,
          updatedAt: now(),
        })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    setTaskRuntimeStatus(taskId: string, status: "in_progress" | "blocked" | "completed" | "failed" | "cancelled") {
      const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!existing) return undefined;
      db.update(tasks)
        .set({ status, revision: existing.revision + 1, updatedAt: now() })
        .where(eq(tasks.id, taskId))
        .run();
      return db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    },
    activateFlowExpertTask(taskId: string, agentSessionId: string) {
      const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const session = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      if (
        !task
        || !session
        || session.taskId !== task.id
        || session.flowExpertId !== task.flowExpertId
        || task.status !== "in_progress"
        || !["queued", "interrupted"].includes(session.status)
      ) return undefined;
      const timestamp = now();
      db.update(agentSessions)
        .set({ status: "streaming", updatedAt: timestamp })
        .where(eq(agentSessions.id, agentSessionId))
        .run();
      if (task.flowExpertId) {
        db.update(flowExperts)
          .set({ status: "streaming", updatedAt: timestamp })
          .where(eq(flowExperts.id, task.flowExpertId))
          .run();
      }
      return {
        task,
        agentSession: db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!,
      };
    },
    interruptStaleExpertSessions() {
      const timestamp = now();
      const staleSessions = db.select().from(agentSessions).all()
        .filter((session) => session.expertId !== "exp-leader" && ACTIVE_AGENT_SESSION_STATUSES.has(session.status as AgentSessionStatus));
      sqlite.transaction(() => {
        for (const session of staleSessions) {
          db.update(agentSessions)
            .set({ status: "interrupted", updatedAt: timestamp })
            .where(eq(agentSessions.id, session.id))
            .run();
          if (session.flowExpertId) {
            db.update(flowExperts)
              .set({ status: "idle", updatedAt: timestamp })
              .where(eq(flowExperts.id, session.flowExpertId))
              .run();
          }
        }
        for (const flowId of new Set(staleSessions.map((session) => session.flowId))) {
          syncFlowExecutionStatus(flowId, timestamp);
        }
      })();
      return { interruptedSessionCount: staleSessions.length };
    },
    createAgentSession(input: { id?: string; flowId: string; workRunId?: string | null; taskId?: string | null; expertId: string; flowExpertId?: string | null; sessionId?: string | null; runtimeSdk?: string | null; runtimeConfigId?: string | null; runtimeModelId?: string | null; runtimeReasoningEffort?: string | null; displayName?: string; resumeFromAgentSessionId?: string; status?: AgentSessionStatus }) {
      const timestamp = now();
      const task = input.taskId ? db.select().from(tasks).where(eq(tasks.id, input.taskId)).get() : undefined;
      const workRunId = task?.workRunId ?? input.workRunId ?? null;
      if ((input.taskId && (!task || task.flowId !== input.flowId))
        || (input.workRunId && input.workRunId !== workRunId)) return undefined;
      const row = {
        id: input.id ?? id("ags"),
        flowId: input.flowId,
        workRunId,
        taskId: input.taskId ?? null,
        expertId: input.expertId,
        flowExpertId: input.flowExpertId ?? null,
        sessionId: input.sessionId ?? null,
        runtimeSdk: input.runtimeSdk ?? null,
        runtimeConfigId: input.runtimeConfigId ?? null,
        runtimeModelId: input.runtimeModelId ?? null,
        runtimeReasoningEffort: input.runtimeReasoningEffort ?? null,
        displayName: input.displayName ?? input.expertId,
        resumeFromAgentSessionId: input.resumeFromAgentSessionId ?? "",
        status: input.status ?? "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      sqlite.transaction(() => {
        db.insert(agentSessions).values(row).run();
        syncFlowExecutionStatus(input.flowId, timestamp);
      })();
      return db.select().from(agentSessions).where(eq(agentSessions.id, row.id)).get()!;
    },
    assignAgentSessionWorkRun(agentSessionId: string, workRunId: string) {
      const session = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      const turn = db.select().from(workRuns).where(eq(workRuns.id, workRunId)).get();
      if (!session || !turn || session.flowId !== turn.flowId) return undefined;
      if (session.workRunId && session.workRunId !== workRunId) return undefined;
      if (!session.workRunId) {
        const timestamp = now();
        sqlite.transaction(() => {
          db.update(agentSessions)
            .set({ workRunId, updatedAt: timestamp })
            .where(eq(agentSessions.id, agentSessionId))
            .run();
          sqlite.prepare(`
            UPDATE chat_timeline_items
            SET work_run_id = ?, updated_at = ?
            WHERE flow_id = ? AND agent_session_id = ? AND work_run_id IS NULL
          `).run(workRunId, timestamp, session.flowId, agentSessionId);
        })();
      }
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
    },
    listAgentSessions(flowId: string) {
      return db.select().from(agentSessions).where(eq(agentSessions.flowId, flowId)).all();
    },
    getAgentSession(agentSessionId: string) {
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
    },
    updateAgentSessionSession(agentSessionId: string, sessionId: string) {
      const existing = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      if (!existing) return undefined;
      db.update(agentSessions)
        .set({ sessionId, updatedAt: now() })
        .where(eq(agentSessions.id, agentSessionId))
        .run();
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!;
    },
    updateAgentSessionRuntime(agentSessionId: string, input: { runtimeSdk: string; runtimeConfigId?: string | null; runtimeModelId?: string | null; runtimeReasoningEffort?: string | null }) {
      const existing = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      if (!existing) return undefined;
      db.update(agentSessions)
        .set({
          runtimeSdk: input.runtimeSdk,
          runtimeConfigId: input.runtimeConfigId ?? null,
          runtimeModelId: input.runtimeModelId ?? null,
          runtimeReasoningEffort: input.runtimeReasoningEffort ?? null,
          updatedAt: now(),
        })
        .where(eq(agentSessions.id, agentSessionId))
        .run();
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!;
    },
    updateAgentSessionStatus(agentSessionId: string, status: AgentSessionStatus) {
      const existing = db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get();
      if (!existing) return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        db.update(agentSessions)
          .set({ status, updatedAt: timestamp })
          .where(eq(agentSessions.id, agentSessionId))
          .run();
        syncFlowExecutionStatus(existing.flowId, timestamp);
      })();
      return db.select().from(agentSessions).where(eq(agentSessions.id, agentSessionId)).get()!;
    },
    upsertAgentContextUsageSnapshot(input: {
      flowId: string;
      agentSessionId: string;
      sdkSessionId?: string | null;
      role: string;
      expertId?: string | null;
      flowExpertId?: string | null;
      totalTokens: number | null;
      maxTokens: number | null;
      rawMaxTokens: number | null;
      percentage: number | null;
      model: string | null;
      categories: ContextUsageCategory[];
      cacheInputTokens?: number | null;
      cacheReadInputTokens?: number | null;
      cacheCreationInputTokens?: number | null;
      cacheHitRate?: number | null;
      compacted?: boolean;
      observedAt: string;
    }) {
      const timestamp = now();
      sqlite.prepare(`
        INSERT INTO agent_context_usage_snapshots (
          id, flow_id, agent_session_id, sdk_session_id, role, expert_id, flow_expert_id,
          total_tokens, max_tokens, raw_max_tokens, percentage, model, categories_json,
          cache_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_hit_rate,
          compacted, observed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_session_id) DO UPDATE SET
          flow_id = excluded.flow_id,
          sdk_session_id = excluded.sdk_session_id,
          role = excluded.role,
          expert_id = excluded.expert_id,
          flow_expert_id = excluded.flow_expert_id,
          total_tokens = excluded.total_tokens,
          max_tokens = excluded.max_tokens,
          raw_max_tokens = excluded.raw_max_tokens,
          percentage = excluded.percentage,
          model = excluded.model,
          categories_json = excluded.categories_json,
          cache_input_tokens = COALESCE(excluded.cache_input_tokens, cache_input_tokens),
          cache_read_input_tokens = CASE
            WHEN excluded.cache_input_tokens IS NOT NULL THEN excluded.cache_read_input_tokens
            ELSE COALESCE(excluded.cache_read_input_tokens, cache_read_input_tokens)
          END,
          cache_creation_input_tokens = CASE
            WHEN excluded.cache_input_tokens IS NOT NULL THEN excluded.cache_creation_input_tokens
            ELSE COALESCE(excluded.cache_creation_input_tokens, cache_creation_input_tokens)
          END,
          cache_hit_rate = CASE
            WHEN excluded.cache_input_tokens IS NOT NULL THEN excluded.cache_hit_rate
            ELSE COALESCE(excluded.cache_hit_rate, cache_hit_rate)
          END,
          compacted = excluded.compacted,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
      `).run(
        id("ctx"),
        input.flowId,
        input.agentSessionId,
        input.sdkSessionId ?? null,
        input.role,
        input.expertId ?? null,
        input.flowExpertId ?? null,
        input.totalTokens,
        input.maxTokens,
        input.rawMaxTokens,
        input.percentage,
        input.model,
        JSON.stringify(input.categories),
        input.cacheInputTokens ?? null,
        input.cacheReadInputTokens ?? null,
        input.cacheCreationInputTokens ?? null,
        input.cacheHitRate ?? null,
        input.compacted ? 1 : 0,
        input.observedAt,
        timestamp,
        timestamp,
      );
      return this.getAgentContextUsageSnapshot(input.agentSessionId);
    },
    getAgentContextUsageSnapshot(agentSessionId: string) {
      const row = sqlite.prepare("SELECT * FROM agent_context_usage_snapshots WHERE agent_session_id = ?")
        .get(agentSessionId) as Record<string, unknown> | undefined;
      return row ? agentContextUsageSnapshotFromDb(row) : undefined;
    },
    listAgentContextUsageSnapshots(flowId: string) {
      const rows = sqlite.prepare("SELECT * FROM agent_context_usage_snapshots WHERE flow_id = ? ORDER BY updated_at DESC")
        .all(flowId) as Array<Record<string, unknown>>;
      return rows.map(agentContextUsageSnapshotFromDb);
    },
    createDecisionCard(input: { flowId: string; workRunId: string; cardId: string; sessionId: string; cardType: string; questions: unknown[] }) {
      const turn = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!turn || turn.flowId !== input.flowId || !["ready", "executing"].includes(turn.status)) return undefined;
      const row = { id: input.cardId, flowId: input.flowId, workRunId: input.workRunId, sessionId: input.sessionId, cardType: input.cardType, questions: JSON.stringify(input.questions), answers: null, status: "pending", resolutionKind: "", resolutionActionId: null, resolvedMessageId: null, createdAt: now(), resolvedAt: null };
      db.insert(decisionCards).values(row).run();
      return db.select().from(decisionCards).where(eq(decisionCards.id, row.id)).get()!;
    },
    listDecisionCards(flowId: string) {
      return db.select().from(decisionCards).where(eq(decisionCards.flowId, flowId)).all();
    },
    getDecisionCard(cardId: string) {
      return db.select().from(decisionCards).where(eq(decisionCards.id, cardId)).get();
    },
    resolvePermissionDecisionCard(input: {
      cardId: string;
      flowId: string;
      answers: DecisionAnswers;
      actionId: string;
      messageId: string;
    }) {
      return sqlite.transaction(() => {
        const existing = db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get();
        if (!existing || existing.flowId !== input.flowId || existing.cardType !== "permission_confirmation") return undefined;
        if (existing.status !== "pending") {
          return existing.resolutionActionId === input.actionId
            ? { card: existing, newlyResolved: false }
            : undefined;
        }
        const timestamp = now();
        const changed = db.update(decisionCards)
          .set({
            status: "resolved",
            answers: JSON.stringify(input.answers),
            resolutionKind: "resolved",
            resolutionActionId: input.actionId,
            resolvedMessageId: input.messageId,
            resolvedAt: timestamp,
          })
          .where(and(
            eq(decisionCards.id, input.cardId),
            eq(decisionCards.flowId, input.flowId),
            eq(decisionCards.status, "pending"),
          ))
          .run();
        if (changed.changes === 0) return undefined;
        return {
          card: db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get()!,
          newlyResolved: true,
        };
      })();
    },
    cancelPermissionDecisionCard(input: {
      cardId: string;
      flowId: string;
      actionId: string;
      messageId: string;
      answers?: DecisionAnswers;
      userDeniedCommand?: {
        scopeKind: "expert_task" | "expert_conversation" | "leader_work_run";
        workRunId: string;
        taskId?: string;
        agentSessionId?: string;
        cwd: string;
        commandSha256: string;
      };
    }) {
      return sqlite.transaction(() => {
        const existing = db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get();
        if (!existing || existing.flowId !== input.flowId || existing.cardType !== "permission_confirmation") return undefined;
        if (existing.status !== "pending") {
          return existing.resolutionActionId === input.actionId
            ? { card: existing, newlyResolved: false }
            : undefined;
        }
        const timestamp = now();
        const changed = db.update(decisionCards)
          .set({
            status: "cancelled",
            answers: input.answers ? JSON.stringify(input.answers) : null,
            resolutionKind: "cancelled",
            resolutionActionId: input.actionId,
            resolvedMessageId: input.messageId,
            resolvedAt: timestamp,
          })
          .where(and(
            eq(decisionCards.id, input.cardId),
            eq(decisionCards.flowId, input.flowId),
            eq(decisionCards.status, "pending"),
          ))
          .run();
        if (changed.changes === 0) return undefined;
        if (input.userDeniedCommand) {
          const denied = input.userDeniedCommand;
          const task = denied.taskId
            ? db.select().from(tasks).where(eq(tasks.id, denied.taskId)).get()
            : undefined;
          const session = denied.agentSessionId
            ? db.select().from(agentSessions).where(eq(agentSessions.id, denied.agentSessionId)).get()
            : undefined;
          const validScope = existing.workRunId === denied.workRunId
            && (denied.scopeKind === "leader_work_run"
              ? !denied.taskId && !denied.agentSessionId
              : denied.scopeKind === "expert_task"
                ? Boolean(
                  task
                  && task.flowId === input.flowId
                  && task.workRunId === denied.workRunId
                  && (!denied.agentSessionId || (session?.flowId === input.flowId && session.taskId === task.id)),
                )
                : Boolean(
                  !denied.taskId
                  && session
                  && session.flowId === input.flowId
                  && session.workRunId === denied.workRunId
                  && session.taskId === null,
                ));
          if (!validScope) throw new Error("permission denial scope does not match decision card");
          const existingEvents = db.select().from(eventLog).where(eq(eventLog.flowId, input.flowId)).all();
          db.insert(eventLog).values({
            id: id("evt"),
            flowId: input.flowId,
            workRunId: denied.workRunId,
            taskId: denied.taskId ?? null,
            agentSessionId: denied.agentSessionId ?? null,
            eventType: "permission_command.user_denied",
            payloadJson: JSON.stringify({
              card_id: input.cardId,
              scope_kind: denied.scopeKind,
              cwd: denied.cwd,
              command_sha256: denied.commandSha256,
            }),
            sequence: existingEvents.reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0) + 1,
            createdAt: timestamp,
          }).run();
        }
        return {
          card: db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get()!,
          newlyResolved: true,
        };
      })();
    },
    hasUserDeniedPermissionCommand(input: {
      flowId: string;
      workRunId: string;
      scopeKind: "expert_task" | "expert_conversation" | "leader_work_run";
      taskId?: string;
      cwd: string;
      commandSha256: string;
    }) {
      return db.select().from(eventLog).where(and(
        eq(eventLog.flowId, input.flowId),
        eq(eventLog.eventType, "permission_command.user_denied"),
      )).all().some((event) => {
        if (event.workRunId !== input.workRunId) return false;
        if (input.scopeKind === "expert_task" && event.taskId !== input.taskId) return false;
        if (input.scopeKind !== "expert_task" && event.taskId !== null) return false;
        const payload = parseJsonObject(event.payloadJson);
        return payload.scope_kind === input.scopeKind
          && payload.cwd === input.cwd
          && payload.command_sha256 === input.commandSha256;
      });
    },
    createDecisionCardLeaderInput(input: {
      flowId: string;
      cardId: string;
      clientActionId: string;
      messageId: string;
      kind: "resolved" | "cancelled";
      content: string;
    }) {
      const timestamp = now();
      const row = {
        id: id("dcli"),
        flowId: input.flowId,
        cardId: input.cardId,
        clientActionId: input.clientActionId,
        messageId: input.messageId,
        kind: input.kind,
        content: input.content,
        status: "pending",
        attempts: 0,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        sentAt: null,
      };
      db.insert(decisionCardLeaderInputs)
        .values(row)
        .onConflictDoNothing({
          target: [
            decisionCardLeaderInputs.flowId,
            decisionCardLeaderInputs.cardId,
            decisionCardLeaderInputs.clientActionId,
          ],
        })
        .run();
      return db.select().from(decisionCardLeaderInputs)
        .where(and(
          eq(decisionCardLeaderInputs.flowId, input.flowId),
          eq(decisionCardLeaderInputs.cardId, input.cardId),
          eq(decisionCardLeaderInputs.clientActionId, input.clientActionId),
        ))
        .get()!;
    },
    listPendingDecisionCardLeaderInputs(flowId?: string) {
      return db.select().from(decisionCardLeaderInputs).all()
        .filter((row) => row.status === "pending" || row.status === "failed")
        .filter((row) => !flowId || row.flowId === flowId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    resetOrphanedDecisionCardLeaderInputs() {
      db.update(decisionCardLeaderInputs)
        .set({ status: "pending", updatedAt: now() })
        .where(eq(decisionCardLeaderInputs.status, "sending"))
        .run();
    },
    claimDecisionCardLeaderInput(inputId: string) {
      const existing = db.select().from(decisionCardLeaderInputs)
        .where(eq(decisionCardLeaderInputs.id, inputId))
        .get();
      if (!existing || !["pending", "failed"].includes(existing.status)) return undefined;
      const changed = db.update(decisionCardLeaderInputs)
        .set({ status: "sending", attempts: existing.attempts + 1, updatedAt: now() })
        .where(and(
          eq(decisionCardLeaderInputs.id, inputId),
          eq(decisionCardLeaderInputs.status, existing.status),
        ))
        .run();
      if (changed.changes === 0) return undefined;
      return db.select().from(decisionCardLeaderInputs)
        .where(eq(decisionCardLeaderInputs.id, inputId))
        .get()!;
    },
    markDecisionCardLeaderInputSent(inputId: string) {
      db.update(decisionCardLeaderInputs)
        .set({ status: "sent", sentAt: now(), updatedAt: now(), lastError: null })
        .where(eq(decisionCardLeaderInputs.id, inputId))
        .run();
    },
    markDecisionCardLeaderInputFailed(inputId: string, error: string) {
      db.update(decisionCardLeaderInputs)
        .set({ status: "failed", lastError: error, updatedAt: now() })
        .where(eq(decisionCardLeaderInputs.id, inputId))
        .run();
    },
    cancelDecisionCard(input: { cardId: string; flowId: string; actionId: string; messageId: string; leaderInputContent: string }) {
      return sqlite.transaction(() => {
        const existing = db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get();
        if (!existing || existing.flowId !== input.flowId) return undefined;
        if (existing.status !== "pending") {
          if (existing.resolutionActionId !== input.actionId) return undefined;
          const leaderInput = db.select().from(decisionCardLeaderInputs).where(and(
            eq(decisionCardLeaderInputs.flowId, input.flowId),
            eq(decisionCardLeaderInputs.cardId, input.cardId),
            eq(decisionCardLeaderInputs.clientActionId, input.actionId),
          )).get();
          return leaderInput ? { card: existing, leaderInput, newlyResolved: false } : undefined;
        }

        const timestamp = now();
        const changed = db.update(decisionCards)
          .set({
            status: "cancelled",
            answers: null,
            resolutionKind: "cancelled",
            resolutionActionId: input.actionId,
            resolvedMessageId: input.messageId,
            resolvedAt: timestamp,
          })
          .where(and(
            eq(decisionCards.id, input.cardId),
            eq(decisionCards.flowId, input.flowId),
            eq(decisionCards.status, "pending"),
          ))
          .run();
        if (changed.changes === 0) return undefined;

        const leaderInputId = id("dcli");
        db.insert(decisionCardLeaderInputs).values({
          id: leaderInputId,
          flowId: input.flowId,
          cardId: input.cardId,
          clientActionId: input.actionId,
          messageId: input.messageId,
          kind: "cancelled",
          content: input.leaderInputContent,
          status: "pending",
          attempts: 0,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          sentAt: null,
        }).run();
        return {
          card: db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get()!,
          leaderInput: db.select().from(decisionCardLeaderInputs).where(eq(decisionCardLeaderInputs.id, leaderInputId)).get()!,
          newlyResolved: true,
        };
      })();
    },
    resolveDecisionCard(input: { cardId: string; flowId: string; answers: DecisionAnswers; actionId: string; messageId: string; leaderInputContent: string }) {
      return sqlite.transaction(() => {
        const existing = db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get();
        if (!existing || existing.flowId !== input.flowId) return undefined;
        if (existing.status !== "pending") {
          if (existing.resolutionActionId !== input.actionId) return undefined;
          const leaderInput = db.select().from(decisionCardLeaderInputs).where(and(
            eq(decisionCardLeaderInputs.flowId, input.flowId),
            eq(decisionCardLeaderInputs.cardId, input.cardId),
            eq(decisionCardLeaderInputs.clientActionId, input.actionId),
          )).get();
          return leaderInput ? { card: existing, leaderInput, newlyResolved: false } : undefined;
        }

        const timestamp = now();
        const changed = db.update(decisionCards)
          .set({
            status: "resolved",
            answers: JSON.stringify(input.answers),
            resolutionKind: "resolved",
            resolutionActionId: input.actionId,
            resolvedMessageId: input.messageId,
            resolvedAt: timestamp,
          })
          .where(and(
            eq(decisionCards.id, input.cardId),
            eq(decisionCards.flowId, input.flowId),
            eq(decisionCards.status, "pending"),
          ))
          .run();
        if (changed.changes === 0) return undefined;

        const leaderInputId = id("dcli");
        db.insert(decisionCardLeaderInputs).values({
          id: leaderInputId,
          flowId: input.flowId,
          cardId: input.cardId,
          clientActionId: input.actionId,
          messageId: input.messageId,
          kind: "resolved",
          content: input.leaderInputContent,
          status: "pending",
          attempts: 0,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          sentAt: null,
        }).run();
        return {
          card: db.select().from(decisionCards).where(eq(decisionCards.id, input.cardId)).get()!,
          leaderInput: db.select().from(decisionCardLeaderInputs).where(eq(decisionCardLeaderInputs.id, leaderInputId)).get()!,
          newlyResolved: true,
        };
      })();
    },
    listArtifacts(flowId: string) {
      return db.select().from(artifacts).where(eq(artifacts.flowId, flowId)).all();
    },
    getWorkRunReview(workRunId: string) {
      return sqlite.prepare(`
        SELECT work_run_id AS workRunId, flow_id AS flowId, anchor_message_id AS anchorMessageId,
          status, review_json AS reviewJson,
          created_at AS createdAt, updated_at AS updatedAt
        FROM work_run_reviews
        WHERE work_run_id = ?
      `).get(workRunId) as {
        workRunId: string;
        flowId: string;
        anchorMessageId: string;
        status: string;
        reviewJson: string;
        createdAt: string;
        updatedAt: string;
      } | undefined;
    },
    listWorkRunReviews(flowId: string) {
      return sqlite.prepare(`
        SELECT work_run_id AS workRunId, flow_id AS flowId, anchor_message_id AS anchorMessageId,
          status, review_json AS reviewJson,
          created_at AS createdAt, updated_at AS updatedAt
        FROM work_run_reviews
        WHERE flow_id = ?
        ORDER BY updated_at ASC
      `).all(flowId) as Array<{
        workRunId: string;
        flowId: string;
        anchorMessageId: string;
        status: string;
        reviewJson: string;
        createdAt: string;
        updatedAt: string;
      }>;
    },
    deleteWorkRunReviews(flowId: string) {
      sqlite.prepare("DELETE FROM work_run_reviews WHERE flow_id = ?").run(flowId);
    },
    recordWorkRunFileAttribution(input: {
      flowId: string;
      workRunId: string;
      agentSessionId: string;
      files: Array<{ path: string; source: "write" | "edit" | "file_change" | "shell" }>;
      partialReason?: string | null;
    }) {
      const workRun = db.select().from(workRuns).where(eq(workRuns.id, input.workRunId)).get();
      if (!workRun || workRun.flowId !== input.flowId) return undefined;
      const timestamp = now();
      sqlite.transaction(() => {
        const existingAttribution = sqlite.prepare(`
          SELECT status, reason FROM work_run_file_attributions WHERE work_run_id = ?
        `).get(input.workRunId) as { status: "ready" | "partial"; reason: string | null } | undefined;
        const reasons = new Set([
          ...(existingAttribution?.reason ? existingAttribution.reason.split("；").filter(Boolean) : []),
          ...(input.partialReason ? [input.partialReason] : []),
        ]);
        const status = existingAttribution?.status === "partial" || input.partialReason ? "partial" : "ready";
        sqlite.prepare(`
          INSERT INTO work_run_file_attributions (
            work_run_id, flow_id, status, reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_run_id) DO UPDATE SET
            status = excluded.status,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `).run(
          input.workRunId,
          input.flowId,
          status,
          reasons.size > 0 ? [...reasons].join("；") : null,
          timestamp,
          timestamp,
        );
        for (const file of input.files) {
          const relativePath = file.path.trim().replaceAll("\\", "/");
          if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("/")) continue;
          const existing = sqlite.prepare(`
            SELECT sources_json AS sourcesJson, agent_session_ids_json AS agentSessionIdsJson,
              first_seen_at AS firstSeenAt
            FROM work_run_touched_files WHERE work_run_id = ? AND relative_path = ?
          `).get(input.workRunId, relativePath) as {
            sourcesJson: string;
            agentSessionIdsJson: string;
            firstSeenAt: string;
          } | undefined;
          const sources = new Set([...(existing ? parseJsonStringArray(existing.sourcesJson) : []), file.source]);
          const agentSessionIds = new Set([
            ...(existing ? parseJsonStringArray(existing.agentSessionIdsJson) : []),
            input.agentSessionId,
          ]);
          sqlite.prepare(`
            INSERT INTO work_run_touched_files (
              work_run_id, relative_path, sources_json, agent_session_ids_json,
              first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(work_run_id, relative_path) DO UPDATE SET
              sources_json = excluded.sources_json,
              agent_session_ids_json = excluded.agent_session_ids_json,
              last_seen_at = excluded.last_seen_at
          `).run(
            input.workRunId,
            relativePath,
            JSON.stringify([...sources].sort()),
            JSON.stringify([...agentSessionIds].sort()),
            existing?.firstSeenAt ?? timestamp,
            timestamp,
          );
        }
      })();
      return { workRunId: input.workRunId, flowId: input.flowId };
    },
    getWorkRunFileAttribution(workRunId: string) {
      const attribution = sqlite.prepare(`
        SELECT work_run_id AS workRunId, flow_id AS flowId, status, reason,
          created_at AS createdAt, updated_at AS updatedAt
        FROM work_run_file_attributions WHERE work_run_id = ?
      `).get(workRunId) as {
        workRunId: string;
        flowId: string;
        status: "ready" | "partial";
        reason: string | null;
        createdAt: string;
        updatedAt: string;
      } | undefined;
      if (!attribution) return undefined;
      const files = sqlite.prepare(`
        SELECT relative_path AS path, sources_json AS sourcesJson,
          agent_session_ids_json AS agentSessionIdsJson,
          first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
        FROM work_run_touched_files
        WHERE work_run_id = ?
        ORDER BY relative_path ASC
      `).all(workRunId) as Array<{
        path: string;
        sourcesJson: string;
        agentSessionIdsJson: string;
        firstSeenAt: string;
        lastSeenAt: string;
      }>;
      return {
        ...attribution,
        files: files.map((file) => ({
          path: file.path,
          sources: parseJsonStringArray(file.sourcesJson),
          agentSessionIds: parseJsonStringArray(file.agentSessionIdsJson),
          firstSeenAt: file.firstSeenAt,
          lastSeenAt: file.lastSeenAt,
        })),
      };
    },
    createChangeBaseline(input: {
      flowId: string;
      sourceAgentSessionId: string;
      workRunId?: string | null;
      rootPath: string;
      snapshotPath: string;
      manifestJson: string;
      status: "ready" | "skipped" | "failed";
      errorMessage?: string | null;
    }) {
      const timestamp = now();
      const baselineId = id("cbl");
      sqlite.prepare(`
        INSERT INTO change_baselines (
          id, flow_id, source_agent_session_id, work_run_id, root_path, snapshot_path,
          manifest_json, status, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        baselineId,
        input.flowId,
        input.sourceAgentSessionId,
        input.workRunId ?? null,
        input.rootPath,
        input.snapshotPath,
        input.manifestJson,
        input.status,
        input.errorMessage ?? null,
        timestamp,
        timestamp,
      );
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
          work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
          manifest_json AS manifestJson, status, error_message AS errorMessage,
          created_at AS createdAt, updated_at AS updatedAt
        FROM change_baselines WHERE source_agent_session_id = ?
      `).get(input.sourceAgentSessionId) as {
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      } | undefined;
    },
    getChangeBaselineByAgentSession(agentSessionId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
          work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
          manifest_json AS manifestJson, status, error_message AS errorMessage,
          created_at AS createdAt, updated_at AS updatedAt
        FROM change_baselines WHERE source_agent_session_id = ?
      `).get(agentSessionId) as {
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      } | undefined;
    },
    getChangeBaselineForWorkRun(workRunId: string) {
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
          work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
          manifest_json AS manifestJson, status, error_message AS errorMessage,
          created_at AS createdAt, updated_at AS updatedAt
        FROM change_baselines WHERE work_run_id = ?
      `).get(workRunId) as {
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      } | undefined;
    },
    attachChangeBaselineToWorkRun(agentSessionId: string, workRunId: string) {
      const existing = sqlite.prepare(`
        SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
          work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
          manifest_json AS manifestJson, status, error_message AS errorMessage,
          created_at AS createdAt, updated_at AS updatedAt
        FROM change_baselines WHERE work_run_id = ?
      `).get(workRunId) as {
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      } | undefined;
      if (existing) return existing;
      sqlite.prepare(`
        UPDATE change_baselines SET work_run_id = ?, updated_at = ?
        WHERE source_agent_session_id = ? AND work_run_id IS NULL
      `).run(workRunId, now(), agentSessionId);
      return sqlite.prepare(`
        SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
          work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
          manifest_json AS manifestJson, status, error_message AS errorMessage,
          created_at AS createdAt, updated_at AS updatedAt
        FROM change_baselines WHERE work_run_id = ?
      `).get(workRunId) as {
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      } | undefined;
    },
    deleteChangeBaseline(baselineId: string) {
      return sqlite.prepare("DELETE FROM change_baselines WHERE id = ?").run(baselineId).changes > 0;
    },
    listChangeBaselines(flowId?: string) {
      const rows = flowId
        ? sqlite.prepare(`SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
            work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
            manifest_json AS manifestJson, status, error_message AS errorMessage,
            created_at AS createdAt, updated_at AS updatedAt FROM change_baselines WHERE flow_id = ?`).all(flowId)
        : sqlite.prepare(`SELECT id, flow_id AS flowId, source_agent_session_id AS sourceAgentSessionId,
            work_run_id AS workRunId, root_path AS rootPath, snapshot_path AS snapshotPath,
            manifest_json AS manifestJson, status, error_message AS errorMessage,
            created_at AS createdAt, updated_at AS updatedAt FROM change_baselines`).all();
      return rows as Array<{
        id: string; flowId: string; sourceAgentSessionId: string; workRunId: string | null;
        rootPath: string; snapshotPath: string; manifestJson: string; status: "ready" | "skipped" | "failed";
        errorMessage: string | null; createdAt: string; updatedAt: string;
      }>;
    },
    createArtifact(input: { flowId: string; workRunId?: string | null; taskId?: string | null; type: string; title: string; content: string; sourceAgentSessionId?: string }) {
      const timestamp = now();
      const task = input.taskId ? db.select().from(tasks).where(eq(tasks.id, input.taskId)).get() : undefined;
      const workRunId = task?.workRunId ?? input.workRunId ?? null;
      if ((input.taskId && (!task || task.flowId !== input.flowId))
        || (input.workRunId && input.workRunId !== workRunId)) return undefined;
      const row = {
        id: id("art"),
        flowId: input.flowId,
        workRunId,
        taskId: input.taskId ?? null,
        type: input.type,
        title: input.title,
        content: input.content,
        sourceAgentSessionId: input.sourceAgentSessionId ?? "",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.insert(artifacts).values(row).run();
      return db.select().from(artifacts).where(eq(artifacts.id, row.id)).get()!;
    },
    getExpert(expertId: string) {
      return db.select().from(experts).where(eq(experts.id, expertId)).get();
    },
    listExperts() {
      return db.select().from(experts).all();
    },
  };
}

export type Store = ReturnType<typeof createStore>;

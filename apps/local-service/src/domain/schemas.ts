import { z } from "zod";

export const FlowStatusSchema = z.enum(["ready", "active", "idle"]);
export const TaskStatusSchema = z.enum(["pending", "queued_for_expert", "recovery_pending", "in_progress", "completed", "failed", "cancelled"]);
export const WorkSourceSchema = z.enum(["spec", "direct_message"]);

export const UserTurnSchema = z.object({
  id: z.string(),
  flow_id: z.string(),
  trigger_message_id: z.string(),
  status: z.enum(["active", "waiting_user", "completed", "failed", "cancelled"]),
  started_at: z.string(),
  active_started_at: z.string().nullable(),
  active_duration_ms: z.number(),
  waiting_started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  work_source: WorkSourceSchema.nullable(),
  spec_revision_id: z.string().nullable(),
  target_project_id: z.string().nullable(),
  work_root_path: z.string(),
  input_snapshot_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const FlowSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  // Project is the top-level local directory.
  name: z.string(),
  name_generation_status: z.enum(["pending", "generated", "fallback", "manual"]),
  status: FlowStatusSchema,
  legacy_spec_flow: z.boolean().default(false),
  leader_session_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const TaskSchema = z.object({
  id: z.string(),
  flow_id: z.string(),
  user_turn_id: z.string(),
  title: z.string(),
  description: z.string(),
  expert_id: z.string().nullable(),
  status: TaskStatusSchema,
  active_form: z.string(),
  agent_session_id: z.string().nullable(),
  metadata_json: z.string(),
  acceptance_criteria_json: z.string(),
  result_artifact_ids_json: z.string(),
  result_json: z.string().nullable(),
  error_message: z.string().nullable(),
  created_by_agent_session_id: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  updated_at: z.string(),
});

export const TaskItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  expert_id: z.string().min(1),
  depends_on_task_ids: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  resume_from_agent_session_id: z.string().default(""),
});

export type Flow = z.infer<typeof FlowSchema>;
export type UserTurn = z.infer<typeof UserTurnSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskItem = z.infer<typeof TaskItemSchema>;

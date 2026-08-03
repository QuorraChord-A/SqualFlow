import { z } from "zod";
export { SubmitOrchestrationPlanSchema as SubmitOrchestrationPlanInput } from "../domain/orchestration.js";
export type { SubmitOrchestrationPlanInput as SubmitOrchestrationPlanInputValue } from "../domain/orchestration.js";

export const QuestionOptionInput = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const QuestionInput = z.object({
  question: z.string().min(1),
  header: z.string().max(12).optional(),
  multiSelect: z.boolean().default(false),
  options: z.array(QuestionOptionInput).min(2).max(4),
}).strict();

export const GetContextInput = z.object({
  flow_id: z.string().min(1),
}).strict();

export const UpdateFlowNameInput = z.object({
  flow_id: z.string().min(1),
  name: z.string().min(1),
}).strict();

export const AskUserInput = z.object({
  flow_id: z.string().min(1),
  questions: z.array(QuestionInput).min(1).max(4),
}).strict();

export const CreatePlanInput = z.object({
  flow_id: z.string().min(1),
  mode: z.enum(["write", "rewrite"]),
  name: z.string().min(1).optional(),
  overview: z.string().min(1),
  plan: z.string().min(1),
}).strict();

export const CreateTaskInput = z.object({
  flow_id: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  active_form: z.string().optional(),
}).strict();

export const SaveExecutionPlanInput = z.object({
  flow_id: z.string().min(1),
  title: z.string().min(1),
  plan: z.string().min(1),
}).strict();

export const ResolvePlanFeedbackInput = z.object({
  flow_id: z.string().min(1),
  plan_approval_id: z.string().min(1),
  resolution_note: z.string().min(1),
}).strict();

export const UpdateTaskInput = z.object({
  flow_id: z.string().min(1),
  task_id: z.string().min(1),
  status: z.enum(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"]).optional(),
  expected_revision: z.number().int().positive().optional(),
  subject: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  active_form: z.string().optional(),
  progress: z.string().nullable().optional(),
  /**
   * Explicit Leader reassignment. The task stays one durable Task; a later
   * dispatch creates a new AgentSession for this selected Expert.
   */
  expert_id: z.string().min(1).optional(),
  owner: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  add_blocks: z.array(z.string()).optional(),
  add_blocked_by: z.array(z.string()).optional(),
}).strict();

export const ListTasksInput = z.object({
  flow_id: z.string().min(1),
}).strict();

export const GetTaskInput = z.object({
  flow_id: z.string().min(1),
  task_id: z.string().min(1),
}).strict();

export const DispatchAgentInput = z.object({
  flow_id: z.string().min(1),
  task_id: z.string().min(1),
  expert_id: z.string().min(1),
  prompt: z.string().min(1).optional().default(""),
  resume_agent_session_id: z.string().optional().default(""),
}).strict();

export const CancelAgentInput = z.object({
  flow_id: z.string().min(1),
  task_id: z.string().min(1),
}).strict();

export const SendMessageInput = z.object({
  flow_id: z.string().min(1),
  expert_id: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().optional(),
}).strict();

export type QuestionOptionInputValue = z.input<typeof QuestionOptionInput>;
export type QuestionInputValue = z.input<typeof QuestionInput>;
export type GetContextInputValue = z.input<typeof GetContextInput>;
export type UpdateFlowNameInputValue = z.input<typeof UpdateFlowNameInput>;
export type AskUserInputValue = z.input<typeof AskUserInput>;
export type CreatePlanInputValue = z.input<typeof CreatePlanInput>;
export type CreateTaskInputValue = z.input<typeof CreateTaskInput>;
export type SaveExecutionPlanInputValue = z.input<typeof SaveExecutionPlanInput>;
export type ResolvePlanFeedbackInputValue = z.input<typeof ResolvePlanFeedbackInput>;
export type UpdateTaskInputValue = z.input<typeof UpdateTaskInput>;
export type ListTasksInputValue = z.input<typeof ListTasksInput>;
export type GetTaskInputValue = z.input<typeof GetTaskInput>;
export type DispatchAgentInputValue = z.input<typeof DispatchAgentInput>;
export type CancelAgentInputValue = z.input<typeof CancelAgentInput>;
export type SendMessageInputValue = z.input<typeof SendMessageInput>;

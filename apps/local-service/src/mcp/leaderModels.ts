import { z } from "zod";

export const QuestionOptionInput = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const QuestionInput = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  multiSelect: z.boolean(),
  options: z.array(QuestionOptionInput).min(2).max(4),
}).strict();

export const GetFlowSnapshotInput = z.object({
  flow_id: z.string().min(1),
}).strict();

export const ListExpertsInput = z.object({}).strict();

export const SaveSpecRevisionInput = z.object({
  flow_id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  source_agent_session_id: z.string().default(""),
}).strict();

export const TaskItemInput = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  expert_id: z.string().min(1),
  depends_on_task_ids: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  resume_from_agent_session_id: z.string().default(""),
}).strict();

export type QuestionInputValue = z.infer<typeof QuestionInput>;
export type GetFlowSnapshotInputValue = z.infer<typeof GetFlowSnapshotInput>;
export type ListExpertsInputValue = z.infer<typeof ListExpertsInput>;
export type SaveSpecRevisionInputValue = z.infer<typeof SaveSpecRevisionInput>;

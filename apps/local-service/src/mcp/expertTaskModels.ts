import { z } from "zod";

/**
 * User-facing Task states. Runtime transport states belong to AgentSession,
 * not to the Expert Task MCP contract.
 */
export const ExpertTaskStatus = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

/** Expert-authored task conclusions; reopening, dispatching, and cancelling stay with Leader. */
export const ExpertTaskStatusUpdate = z.enum(["blocked", "completed", "failed"]);

export const ListMyTasksInput = z.object({}).strict();

export const GetMyTaskInput = z.object({
  task_id: z.string().min(1),
}).strict();

export const UpdateMyTaskInput = z.object({
  task_id: z.string().min(1),
  expected_revision: z.number().int().positive().optional(),
  subject: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  active_form: z.string().optional(),
  progress: z.string().nullable().optional(),
  result: z.unknown().nullable().optional(),
  error_message: z.string().nullable().optional(),
  status: ExpertTaskStatusUpdate.optional(),
}).strict().refine(
  (input) => (
    input.subject !== undefined
    || input.description !== undefined
    || input.active_form !== undefined
    || input.progress !== undefined
    || input.result !== undefined
    || input.error_message !== undefined
    || input.status !== undefined
  ),
  { message: "Provide at least one task field to update." },
);

export type ExpertTaskStatusValue = z.infer<typeof ExpertTaskStatus>;
export type ExpertTaskStatusUpdateValue = z.infer<typeof ExpertTaskStatusUpdate>;
export type GetMyTaskInputValue = z.infer<typeof GetMyTaskInput>;
export type UpdateMyTaskInputValue = z.infer<typeof UpdateMyTaskInput>;

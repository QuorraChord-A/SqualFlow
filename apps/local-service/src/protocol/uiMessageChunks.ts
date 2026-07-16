import { z } from "zod";
import { runtimeCapabilities, type RuntimeCapability } from "../domain/runtimeCapabilities.js";

export type UiToolIdentity = {
  toolName: string;
  capability?: RuntimeCapability;
  providerToolName?: string;
};

export type UiMessageChunk =
  | { type: "start"; messageId: string; seq: number; startedAt?: string }
  | { type: "text-start"; messageId: string; seq: number; id: string }
  | { type: "text-delta"; messageId: string; seq: number; id: string; delta: string }
  | { type: "text-end"; messageId: string; seq: number; id: string }
  | { type: "reasoning-start"; messageId: string; seq: number; id: string }
  | { type: "reasoning-delta"; messageId: string; seq: number; id: string; delta: string }
  | { type: "reasoning-end"; messageId: string; seq: number; id: string }
  | ({ type: "tool-input-start"; messageId: string; seq: number; toolCallId: string } & UiToolIdentity)
  | { type: "tool-input-delta"; messageId: string; seq: number; toolCallId: string; inputTextDelta: string }
  | ({ type: "tool-input-available"; messageId: string; seq: number; toolCallId: string; input: Record<string, unknown> } & UiToolIdentity)
  | { type: "tool-output-available"; messageId: string; seq: number; toolCallId: string; output: { content: string; is_error: boolean } }
  | { type: "finish"; messageId: string; seq: number; durationMs: number | null; finishedAt: string };

const ToolOutputSchema = z.object({
  content: z.string(),
  is_error: z.boolean(),
}).strict();

function chunkSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

const EventBaseSchema = {
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
};
const RuntimeCapabilitySchema = z.enum(runtimeCapabilities);

export const UiMessageChunkSchema = z.union([
  chunkSchema({ type: z.literal("start"), ...EventBaseSchema, startedAt: z.string().optional() }),
  chunkSchema({ type: z.literal("text-start"), ...EventBaseSchema, id: z.string() }),
  chunkSchema({ type: z.literal("text-delta"), ...EventBaseSchema, id: z.string(), delta: z.string() }),
  chunkSchema({ type: z.literal("text-end"), ...EventBaseSchema, id: z.string() }),
  chunkSchema({ type: z.literal("reasoning-start"), ...EventBaseSchema, id: z.string() }),
  chunkSchema({ type: z.literal("reasoning-delta"), ...EventBaseSchema, id: z.string(), delta: z.string() }),
  chunkSchema({ type: z.literal("reasoning-end"), ...EventBaseSchema, id: z.string() }),
  chunkSchema({
    type: z.literal("tool-input-start"),
    ...EventBaseSchema,
    toolCallId: z.string(),
    toolName: z.string(),
    capability: RuntimeCapabilitySchema.optional(),
    providerToolName: z.string().optional(),
  }),
  chunkSchema({ type: z.literal("tool-input-delta"), ...EventBaseSchema, toolCallId: z.string(), inputTextDelta: z.string() }),
  chunkSchema({
    type: z.literal("tool-input-available"),
    ...EventBaseSchema,
    toolCallId: z.string(),
    toolName: z.string(),
    capability: RuntimeCapabilitySchema.optional(),
    providerToolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
  }),
  chunkSchema({
    type: z.literal("tool-output-available"),
    ...EventBaseSchema,
    toolCallId: z.string(),
    output: ToolOutputSchema,
  }),
  chunkSchema({ type: z.literal("finish"), ...EventBaseSchema, durationMs: z.number().nullable(), finishedAt: z.string() }),
]) satisfies z.ZodType<UiMessageChunk>;

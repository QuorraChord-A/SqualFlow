import { z } from "zod";

const MessageImageAttachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "browser_comment"]),
  media_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional(),
  data: z.string().min(1).max(16_000_000).optional(),
  name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  marker_number: z.number().int().positive().optional(),
  comment: z.string().optional(),
  label: z.string().optional(),
  page_url: z.string().optional(),
  selector: z.string().optional(),
  text_offset: z.number().int().nonnegative().optional(),
}).strict().superRefine((attachment, context) => {
  const hasMediaType = attachment.media_type !== undefined;
  const hasData = attachment.data !== undefined;
  if (attachment.kind === "image" && (!hasMediaType || !hasData)) {
    context.addIssue({ code: "custom", message: "image attachments require media_type and data" });
  }
  if (hasMediaType !== hasData) {
    context.addIssue({ code: "custom", message: "attachment media_type and data must be provided together" });
  }
});

const MessageImageAttachmentsSchema = z.array(MessageImageAttachmentSchema).max(8).optional();

const PlanFeedbackSchema = z.object({
  id: z.string().min(1),
  plan_revision_id: z.string().min(1),
  plan_node_id: z.string().min(1).nullable().optional(),
  marker_number: z.number().int().positive(),
  comment: z.string().min(1).max(8_000),
}).strict();

export const ClientWsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("flow:subscribe"), flow_id: z.string(), log_id: z.string().optional() }).strict(),
  z.object({ type: z.literal("flow:unsubscribe"), flow_id: z.string(), log_id: z.string().optional() }).strict(),
  z.object({
    type: z.literal("flow:message"),
    flow_id: z.string(),
    content: z.string(),
    spec_requested: z.boolean().optional(),
    attachments: MessageImageAttachmentsSchema,
    plan_feedback: z.array(PlanFeedbackSchema).max(40).optional(),
    client_message_id: z.string().optional(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:guide"),
    flow_id: z.string(),
    content: z.string(),
    attachments: MessageImageAttachmentsSchema,
    plan_feedback: z.array(PlanFeedbackSchema).max(40).optional(),
    client_message_id: z.string().optional(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_add"),
    flow_id: z.string(),
    queue_id: z.string().min(1),
    content: z.string(),
    display_content: z.string().optional(),
    spec_requested: z.boolean().optional(),
    attachments: MessageImageAttachmentsSchema,
    plan_feedback: z.array(PlanFeedbackSchema).max(40).optional(),
    client_payload: z.record(z.string(), z.unknown()).optional(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_delete"),
    flow_id: z.string(),
    queue_id: z.string().min(1),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_reorder"),
    flow_id: z.string(),
    queue_ids: z.array(z.string().min(1)).max(100),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_dispatch"),
    flow_id: z.string(),
    queue_id: z.string().min(1),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_guide"),
    flow_id: z.string(),
    queue_id: z.string().min(1),
    client_message_id: z.string().min(1),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:queue_clear"),
    flow_id: z.string(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:decision"),
    flow_id: z.string(),
    card_id: z.string(),
    answers: z.record(
      z.string(),
      z.union([z.string(), z.array(z.string().min(1)).min(1)]),
    ),
    client_action_id: z.string().optional(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:decision_cancel"),
    flow_id: z.string(),
    card_id: z.string(),
    client_action_id: z.string().optional(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:run_spec"),
    flow_id: z.string(),
    spec_approval_id: z.string(),
    log_id: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("flow:plan_approve"),
    flow_id: z.string(),
    plan_approval_id: z.string(),
    client_action_id: z.string().min(1),
    log_id: z.string().optional(),
  }).strict(),
  z.object({ type: z.literal("user_turn:cancel"), flow_id: z.string(), user_turn_id: z.string(), log_id: z.string().optional() }).strict(),
  z.object({ type: z.literal("session:get"), flow_id: z.string(), flow_expert_id: z.string().optional(), agent_session_id: z.string().optional(), session_id: z.string().optional(), log_id: z.string().optional() }).strict(),
  z.object({
    type: z.literal("client:diagnostic"),
    flow_id: z.string(),
    event: z.enum(["flow_switch_started", "flow_switch_ready", "flow_switch_failed"]),
    duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
    error_code: z.string().min(1).max(120).optional(),
    leader_agent_session_id: z.string().min(1).optional(),
    log_id: z.string().optional(),
  }).strict(),
]);

const HistoryBoundarySchema = z.object({
  id: z.string(),
  kind: z.literal("history_session_boundary"),
  flow_expert_id: z.string(),
  agent_session_id: z.string(),
  display_name: z.string(),
  started_at: z.string(),
  status: z.enum(["loaded", "missing"]),
  before_message_id: z.string().optional(),
}).strict();

const ActiveTurnSchema = z.object({
  message_id: z.string(),
  root_message_id: z.string().optional(),
  segment_index: z.number().int().nonnegative().optional(),
  started_at: z.string(),
}).strict();

export const ServerWsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("flow:state"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:status"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:name_updated"), flow_id: z.string(), log_id: z.string().optional(), data: z.object({ name: z.string(), name_generation_status: z.enum(["pending", "generated", "fallback", "manual"]) }).strict() }).strict(),
  z.object({ type: z.literal("flow:message_ack"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:guide_ack"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:queue_state"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("task:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("user_turn:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("session:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow_expert:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("context_usage:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("context_compaction:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({
    type: z.literal("runtime:transport"),
    flow_id: z.string(),
    agent_session_id: z.string(),
    flow_expert_id: z.string().optional(),
    data: z.object({
      state: z.enum(["reconnecting", "timeout", "fallback_https", "clear"]),
      message: z.string().optional(),
      attempt: z.number().int().positive().optional(),
      max_attempts: z.number().int().positive().optional(),
      runtime_role: z.enum(["leader", "expert"]),
      user_turn_id: z.string().optional(),
      task_id: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal("session:transcript_event"), flow_id: z.string(), session_id: z.string(), agent_session_id: z.string().optional(), flow_expert_id: z.string().optional(), log_id: z.string().optional(), data: z.object({ stream_epoch: z.string(), cursor: z.number().int().nonnegative(), event: z.unknown(), removed_message_ids: z.array(z.string()).optional(), active_turn: ActiveTurnSchema.optional() }).strict() }).strict(),
  z.object({ type: z.literal("session:transcript_snapshot"), flow_id: z.string(), session_id: z.string().optional(), agent_session_id: z.string().optional(), flow_expert_id: z.string().optional(), data: z.object({ stream_epoch: z.string(), cursor: z.number().int().nonnegative(), messages: z.array(z.unknown()), history_boundaries: z.array(HistoryBoundarySchema).optional(), active_turn: ActiveTurnSchema.optional() }).strict(), pending_cards: z.array(z.unknown()).optional(), decision_cards: z.array(z.unknown()).optional() }).strict(),
  z.object({ type: z.literal("flow:decision_card"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:decision_card_resolved"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:spec_card"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("flow:spec_card_resolved"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("artifact:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("plan:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("plan_approval:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({ type: z.literal("plan_run:event"), flow_id: z.string(), log_id: z.string().optional(), data: z.unknown() }).strict(),
  z.object({
    type: z.literal("system:error"),
    flow_id: z.string().optional(),
    log_id: z.string().optional(),
    data: z.object({ code: z.string(), message: z.string() }).passthrough(),
  }).strict(),
]);

export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;
export type ServerWsMessage = z.infer<typeof ServerWsMessageSchema>;
export type MessageImageAttachment = z.infer<typeof MessageImageAttachmentSchema>;
export type MessageImageAttachmentWithData = MessageImageAttachment & {
  media_type: NonNullable<MessageImageAttachment["media_type"]>;
  data: string;
};

export function hasMessageImageData(
  attachment: MessageImageAttachment,
): attachment is MessageImageAttachmentWithData {
  return attachment.media_type !== undefined && attachment.data !== undefined;
}

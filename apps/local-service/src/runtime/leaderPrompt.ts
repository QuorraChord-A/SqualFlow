import type { CurrentTurnInput } from "../mcp/leaderServer.js";
import { buildPlatformEvent } from "../protocol/platformEvent.js";
import type { MessageImageAttachment } from "../protocol/wsMessages.js";

export type LeaderPlanFeedback = {
  plan_node_id?: string | null;
  marker_number: number;
  comment: string;
};

export type LeaderTurnInput = {
  flowId: string;
  userMessage?: string;
  specRequested?: boolean;
  kind?: "user" | "expert_result" | "decision" | "decision_cancelled" | "spec_run" | "user_turn_recovery";
  expertResult?: {
    taskId: string;
    agentSessionId: string;
    expertId: string;
    status?: "completed" | "failed" | "cancelled";
    turnOutcome: string;
    summary: string;
    error: string | null;
    artifactRefs: string[];
    completedAt: string;
  };
  decisionAnswers?: Record<string, string | string[]>;
  decisionUserMessage?: string;
  decisionCardId?: string;
  decisionMessageId?: string;
  userTurnId?: string;
  currentTurnInput?: CurrentTurnInput;
  attachments?: MessageImageAttachment[];
  planFeedback?: LeaderPlanFeedback[];
  logId?: string;
  leaderAgentSessionId: string;
  leaderSessionId: string;
  resumeSessionId?: string;
  messageId?: string;
  startedAt?: string;
};

const LEADER_SUMMARY_TRUNCATE_LENGTH = 2000;
const SPEC_REQUESTED_BODY = "本消息明确要求 Spec:先澄清并调用 create_plan 生成可审批 Spec;在 Spec 获批前不要创建执行 Task 或派发 Expert。";
const PLAN_FEEDBACK_INSTRUCTION = "请把本批评论作为一个整体处理;需要修改时只提交一个完整的新计划版本,不要直接创建或派发 Task。";
export const DECISION_CANCELLED_BODY = "用户取消了本次澄清卡片。请不要直接执行,用自然语言重新说明问题或给出建议。";

function joinSegments(segments: Array<string | null | undefined>): string {
  return segments.filter((segment): segment is string => typeof segment === "string" && segment.length > 0).join("\n\n");
}

function truncatedSummary(summary: string): string {
  return summary.length <= LEADER_SUMMARY_TRUNCATE_LENGTH
    ? summary
    : summary.slice(0, LEADER_SUMMARY_TRUNCATE_LENGTH);
}

function expertResultBody(input: NonNullable<LeaderTurnInput["expertResult"]>): string {
  const cancelled = input.status === "cancelled" || input.turnOutcome === "cancelled";
  const failed = !cancelled && (input.status === "failed" || input.turnOutcome !== "completed");
  const prefix = cancelled ? "已取消：" : failed ? "失败：" : "完成：";
  return [
    `${prefix}${truncatedSummary(input.summary)}`,
    ...(failed && input.error ? [`错误：${input.error}`] : []),
    ...(input.artifactRefs.length > 0 ? [`产物：${input.artifactRefs.join("、")}`] : []),
  ].join("\n");
}

function decisionAnswerBody(input: LeaderTurnInput): string {
  const rows = Object.entries(input.decisionAnswers ?? {}).map(([question, answer]) => {
    const value = Array.isArray(answer) ? answer.join("、") : answer;
    return `${question}: ${value}`;
  });
  const answers = rows.join("\n");
  const supplemental = input.decisionUserMessage?.trim() ?? "";
  if (!answers) return supplemental || "用户已回答本次澄清卡片。";
  return supplemental && supplemental !== answers ? `${answers}\n${supplemental}` : answers;
}

export function buildPlanFeedbackEvent(
  flowId: string,
  feedback: LeaderPlanFeedback[] | undefined,
): string | null {
  if (!feedback?.length) return null;
  const lines = feedback.map((item) => item.plan_node_id
    ? `[标记${item.marker_number} → 节点${item.plan_node_id}] ${item.comment}`
    : `[标记${item.marker_number}] ${item.comment}`);
  return buildPlatformEvent({
    flowId,
    type: "plan_feedback",
    body: [...lines, PLAN_FEEDBACK_INSTRUCTION].join("\n"),
  });
}

export function buildBrowserCommentEvents(
  flowId: string,
  attachments: MessageImageAttachment[] | undefined,
): string[] {
  const comments = (attachments ?? []).filter((attachment) => attachment.kind === "browser_comment");
  return comments.map((attachment, index) => {
    const marker = attachment.marker_number ?? index + 1;
    const attrs = {
      n: String(marker),
      ...(attachment.page_url ? { url: attachment.page_url } : {}),
      ...(attachment.label ? { label: attachment.label } : {}),
      ...(attachment.selector ? { selector: attachment.selector } : {}),
    };
    return buildPlatformEvent({
      flowId,
      type: "browser_comment",
      attrs,
      body: attachment.comment ?? "",
    });
  });
}

export function buildAttachmentEvent(
  flowId: string,
  attachment: MessageImageAttachment,
  index: number,
): string {
  const body = attachment.kind === "browser_comment"
    ? `附图${index + 1}:Comment ${attachment.marker_number ?? index + 1} 的圈选截图,目标元素蓝框标出。`
    : `附图${index + 1}:用户上传的图片${attachment.name ? ` ${attachment.name}` : ""}。`;
  return buildPlatformEvent({ flowId, type: "attachment", body });
}

export function buildLeaderGuidePrompt(input: {
  flowId: string;
  content: string;
  attachments?: MessageImageAttachment[];
  planFeedback?: LeaderPlanFeedback[];
}): string {
  return joinSegments([
    input.content ? buildPlatformEvent({ flowId: input.flowId, type: "guide", body: input.content }) : null,
    buildPlanFeedbackEvent(input.flowId, input.planFeedback),
    ...buildBrowserCommentEvents(input.flowId, input.attachments),
  ]);
}

export function currentTurnInputFromTurn(turn: LeaderTurnInput): CurrentTurnInput | undefined {
  const createdAt = new Date().toISOString();
  if (turn.kind === "decision" || turn.kind === "decision_cancelled") {
    return {
      trigger_kind: turn.kind === "decision_cancelled" ? "decision_cancelled" : "decision_resolved",
      user_turn_id: turn.userTurnId,
      card_id: turn.decisionCardId,
      message_id: turn.decisionMessageId,
      content: turn.decisionUserMessage ?? "",
      ...(turn.kind === "decision" ? { answers: turn.decisionAnswers ?? {} } : {}),
      ...(turn.specRequested === true ? { spec_requested: true } : {}),
      created_at: createdAt,
    };
  }
  if (turn.kind === "spec_run") {
    return { trigger_kind: "spec_run", user_turn_id: turn.userTurnId, created_at: createdAt };
  }
  if (turn.kind === "expert_result") {
    return {
      trigger_kind: "expert_result",
      user_turn_id: turn.userTurnId,
      ...(turn.specRequested === true ? { spec_requested: true } : {}),
      created_at: createdAt,
    };
  }
  if (turn.kind === "user_turn_recovery") {
    return {
      trigger_kind: "user_turn_recovery",
      user_turn_id: turn.userTurnId,
      ...(turn.specRequested === true ? { spec_requested: true } : {}),
      created_at: createdAt,
    };
  }
  return undefined;
}

export function buildLeaderPrompt(input: LeaderTurnInput): string {
  if (input.kind === "expert_result" && input.expertResult) {
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "expert_result",
      attrs: { task: input.expertResult.taskId },
      body: expertResultBody(input.expertResult),
    });
  }
  if (input.kind === "decision") {
    return buildPlatformEvent({ flowId: input.flowId, type: "decision_answered", body: decisionAnswerBody(input) });
  }
  if (input.kind === "decision_cancelled") {
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "decision_cancelled",
      body: DECISION_CANCELLED_BODY,
    });
  }
  if (input.kind === "spec_run") {
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "spec_run",
      body: "Spec 已获批准。读取当前 SpecRevision 和 Flow snapshot,创建可执行的 Task DAG。",
    });
  }
  if (input.kind === "user_turn_recovery") {
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "turn_recovery",
      body: input.specRequested === true
        ? "恢复当前 UserTurn:原始用户消息要求 Spec;若 Spec 尚未创建,先调用 create_plan,不要创建执行 Task。"
        : "恢复当前 UserTurn:读取当前 Task、卡片与专家结果,继续处理或形成最终结论。",
    });
  }

  return joinSegments([
    input.userMessage ?? "",
    input.specRequested === true
      ? buildPlatformEvent({ flowId: input.flowId, type: "spec_requested", body: SPEC_REQUESTED_BODY })
      : null,
    buildPlanFeedbackEvent(input.flowId, input.planFeedback),
    ...buildBrowserCommentEvents(input.flowId, input.attachments),
  ]);
}

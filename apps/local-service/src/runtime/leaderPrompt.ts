import type { CurrentTurnInput } from "../mcp/leaderServer.js";
import { buildPlatformEvent } from "../protocol/platformEvent.js";
import type { MessageImageAttachment } from "../protocol/wsMessages.js";

export type LeaderOrchestrationFeedback = {
  orchestration_node_id?: string | null;
  marker_number: number;
  comment: string;
};

export type LeaderTurnInput = {
  flowId: string;
  userMessage?: string;
  kind?: "user" | "expert_result" | "expert_message" | "decision" | "decision_cancelled" | "plan_resolved" | "orchestration_resolved" | "flow_name_generation";
  expertResult?: {
    taskId: string;
    agentRunId: string;
    agentSessionId: string;
    agentDefinitionId: string;
    taskStatus?: string;
    status?: "completed" | "failed" | "cancelled";
    turnOutcome: string;
    summary: string;
    error: string | null;
    artifactRefs: string[];
    filesChanged: string[];
    metrics: Record<string, unknown>;
    completedAt: string;
  };
  expertMessage?: {
    taskId?: string;
    agentRunId: string;
    agentSessionId: string;
    agentDefinitionId: string;
    status?: "completed" | "failed" | "cancelled";
    turnOutcome: string;
    summary: string;
    error: string | null;
    artifactRefs: string[];
    filesChanged: string[];
    metrics: Record<string, unknown>;
    completedAt: string;
  };
  decisionAnswers?: Record<string, string | string[]>;
  decisionUserMessage?: string;
  decisionRequestId?: string;
  decisionMessageId?: string;
  currentTurnInput?: CurrentTurnInput;
  attachments?: MessageImageAttachment[];
  orchestrationFeedback?: LeaderOrchestrationFeedback[];
  behaviorMode?: "execute" | "plan";
  riskMode?: "auto_edit" | "full_access";
  orchestrationMode?: "approval_required" | "automatic";
  logId?: string;
  leaderAgentRunId: string;
  leaderSessionId: string;
  resumeSessionId?: string;
  messageId?: string;
  startedAt?: string;
};

export const DECISION_CANCELLED_BODY = "用户取消了本次澄清请求。请自行决定是继续、调整方案，还是再次说明需要什么信息。";

function joinSegments(segments: Array<string | null | undefined>) {
  return segments.filter((segment): segment is string => Boolean(segment)).join("\n\n");
}

function modeEvent(input: Pick<LeaderTurnInput, "flowId" | "behaviorMode" | "riskMode" | "orchestrationMode">) {
  return buildPlatformEvent({
    flowId: input.flowId,
    type: "flow_mode",
    attrs: {
      behavior: input.behaviorMode ?? "execute",
      risk: input.riskMode ?? "auto_edit",
      orchestration: input.orchestrationMode ?? "approval_required",
    },
    body: input.behaviorMode === "plan"
      ? "当前 Flow 处于计划模式：先澄清并调用 create_plan 提交计划；不要在计划获批前创建执行 Task 或派发 Expert。"
      : "当前 Flow 处于执行模式。工具选择和下一步由 Leader 自主决定，平台只校验边界。",
  });
}

export function buildOrchestrationFeedbackEvent(flowId: string, feedback?: LeaderOrchestrationFeedback[]) {
  if (!feedback?.length) return null;
  return buildPlatformEvent({
    flowId,
    type: "orchestration_feedback",
    body: feedback.map((item) => item.orchestration_node_id
      ? `[标记${item.marker_number} → 节点${item.orchestration_node_id}] ${item.comment}`
      : `[标记${item.marker_number}] ${item.comment}`).join("\n"),
  });
}

export function buildBrowserCommentEvents(flowId: string, attachments?: MessageImageAttachment[]) {
  return (attachments ?? [])
    .filter((attachment) => attachment.kind === "browser_comment")
    .map((attachment, index) => buildPlatformEvent({
      flowId,
      type: "browser_comment",
      attrs: {
        n: String(attachment.marker_number ?? index + 1),
        ...(attachment.page_url ? { url: attachment.page_url } : {}),
        ...(attachment.label ? { label: attachment.label } : {}),
        ...(attachment.selector ? { selector: attachment.selector } : {}),
      },
      body: attachment.comment ?? "",
    }));
}

export function buildAttachmentEvent(flowId: string, attachment: MessageImageAttachment, index: number) {
  return buildPlatformEvent({
    flowId,
    type: "attachment",
    body: attachment.kind === "browser_comment"
      ? `附图${index + 1}：浏览器评论 ${attachment.marker_number ?? index + 1} 的圈选截图。`
      : `附图${index + 1}：用户上传的图片${attachment.name ? ` ${attachment.name}` : ""}。`,
  });
}

export function buildLeaderGuidePrompt(input: {
  flowId: string;
  content: string;
  attachments?: MessageImageAttachment[];
  orchestrationFeedback?: LeaderOrchestrationFeedback[];
  behaviorMode?: "execute" | "plan";
  riskMode?: "auto_edit" | "full_access";
  orchestrationMode?: "approval_required" | "automatic";
}) {
  return joinSegments([
    modeEvent(input),
    buildPlatformEvent({ flowId: input.flowId, type: "guide", body: input.content }),
    buildOrchestrationFeedbackEvent(input.flowId, input.orchestrationFeedback),
    ...buildBrowserCommentEvents(input.flowId, input.attachments),
  ]);
}

export function buildFlowNameRequestPrompt(flowId: string) {
  return buildPlatformEvent({
    flowId,
    type: "flow_name_request",
    body: "根据首条用户需求和首轮回复生成不超过 10 个字的简洁中文名称；只调用 update_flow_name。",
  });
}

export function buildFlowNameWorkerPrompt(input: { userMessage: string; assistantMessage: string }) {
  return [
    "你是 SqualFlow 的 Flow 命名助手。只输出不超过 10 个字的中文名称，不要解释。",
    "【首条用户需求】",
    input.userMessage.trim().slice(0, 4_000) || "（无）",
    "【首轮回复】",
    input.assistantMessage.trim().slice(0, 6_000) || "（无）",
  ].join("\n");
}

export function currentTurnInputFromTurn(turn: LeaderTurnInput): CurrentTurnInput {
  const triggerMap: Record<NonNullable<LeaderTurnInput["kind"]>, CurrentTurnInput["trigger_kind"]> = {
    user: "user_message",
    decision: "decision_resolved",
    decision_cancelled: "decision_cancelled",
    plan_resolved: "plan_resolved",
    orchestration_resolved: "orchestration_resolved",
    expert_result: "expert_result",
    expert_message: "expert_message",
    flow_name_generation: "flow_name_generation",
  };
  return {
    trigger_kind: triggerMap[turn.kind ?? "user"],
    agent_run_id: turn.leaderAgentRunId,
    message_id: turn.messageId ?? turn.decisionMessageId,
    decision_request_id: turn.decisionRequestId,
    content: turn.userMessage ?? turn.decisionUserMessage ?? "",
    ...(turn.kind === "decision" ? { answers: turn.decisionAnswers ?? {} } : {}),
    created_at: turn.startedAt ?? new Date().toISOString(),
  };
}

function expertResultEvent(input: LeaderTurnInput) {
  const result = input.expertResult;
  if (!result) return null;
  return buildPlatformEvent({
    flowId: input.flowId,
    type: "expert_result",
    attrs: { task: result.taskId, session: result.agentSessionId, run: result.agentRunId },
    body: [
      result.summary,
      `AgentRun 状态：${result.status ?? result.turnOutcome}`,
      `Task 当前状态：${result.taskStatus ?? "unknown"}（不得由 AgentRun 结果自动推导）`,
      ...(result.error ? [`错误：${result.error}`] : []),
      `文件变化：${result.filesChanged.join("、") || "无"}`,
    ].join("\n"),
  });
}

function expertMessageEvent(input: LeaderTurnInput) {
  const result = input.expertMessage;
  if (!result) return null;
  return buildPlatformEvent({
    flowId: input.flowId,
    type: "expert_message",
    attrs: { session: result.agentSessionId, run: result.agentRunId },
    body: [result.summary, ...(result.error ? [`错误：${result.error}`] : [])].join("\n"),
  });
}

function decisionBody(input: LeaderTurnInput) {
  const answers = Object.entries(input.decisionAnswers ?? {}).map(([question, answer]) =>
    `${question}: ${Array.isArray(answer) ? answer.join("、") : answer}`).join("\n");
  return [answers, input.decisionUserMessage ?? ""].filter(Boolean).join("\n") || "用户已回复。";
}

export function buildLeaderPrompt(input: LeaderTurnInput) {
  const event = input.kind === "expert_result"
    ? expertResultEvent(input)
    : input.kind === "expert_message"
      ? expertMessageEvent(input)
      : input.kind === "decision"
        ? buildPlatformEvent({ flowId: input.flowId, type: "decision_answered", body: decisionBody(input) })
        : input.kind === "decision_cancelled"
          ? buildPlatformEvent({ flowId: input.flowId, type: "decision_cancelled", body: DECISION_CANCELLED_BODY })
          : input.kind === "plan_resolved"
            ? buildPlatformEvent({ flowId: input.flowId, type: "plan_resolved", body: input.userMessage || "计划审批已处理。请读取最新计划与审批结果，自主决定下一步；审批本身不会自动创建 Task 或派发 Expert。" })
            : input.kind === "orchestration_resolved"
              ? buildPlatformEvent({ flowId: input.flowId, type: "orchestration_resolved", body: input.userMessage || "编排审批已处理。获批时 Task 已物化；请读取最新状态并自主决定下一步。" })
              : input.userMessage ?? "";
  return joinSegments([
    modeEvent(input),
    event,
    buildOrchestrationFeedbackEvent(input.flowId, input.orchestrationFeedback),
    ...buildBrowserCommentEvents(input.flowId, input.attachments),
  ]);
}

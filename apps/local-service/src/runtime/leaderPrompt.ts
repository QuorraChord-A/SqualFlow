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
  kind?: "user" | "expert_result" | "expert_message" | "decision" | "decision_cancelled" | "spec_run" | "plan_approved";
  planApprovedTasks?: Array<{
    taskId: string;
    title: string;
    expertId: string;
    dependsOnTaskIds: string[];
  }>;
  expertResult?: {
    taskId: string;
    agentSessionId: string;
    expertId: string;
    /** Current user-maintained Task state; distinct from this provider turn's status. */
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
    agentSessionId: string;
    expertId: string;
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
  decisionCardId?: string;
  decisionMessageId?: string;
  workRunId?: string;
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

const SPEC_REQUESTED_BODY = "本消息明确要求 Spec:先澄清并调用 create_plan 生成可审批 Spec;在 Spec 获批前不要创建执行 Task 或派发 Expert。";
const PLAN_FEEDBACK_INSTRUCTION = "请把本批评论作为一个整体处理;需要修改时只提交一个完整的新计划版本,不要直接创建或派发 Task。";
export const DECISION_CANCELLED_BODY = "用户取消了本次澄清卡片。请不要直接执行,用自然语言重新说明问题或给出建议。";

function joinSegments(segments: Array<string | null | undefined>): string {
  return segments.filter((segment): segment is string => typeof segment === "string" && segment.length > 0).join("\n\n");
}

function expertResultBody(input: NonNullable<LeaderTurnInput["expertResult"]>): string {
  const filesChanged = input.filesChanged;
  const metrics = input.metrics;
  const taskStatus = input.taskStatus ?? "unknown";
  const cancelled = input.status === "cancelled" || input.turnOutcome === "cancelled";
  const failed = !cancelled && (input.status === "failed" || input.turnOutcome !== "completed");
  const taskCompleted = taskStatus === "completed";
  const prefix = cancelled
    ? "本次执行已取消："
    : failed
      ? "本次执行失败："
      : taskCompleted
        ? "Task 已标记完成："
        : `Expert 本次回复（Task 仍为 ${taskStatus}）：`;
  return [
    `${prefix}${input.summary}`,
    ...(failed && input.error ? [`错误：${input.error}`] : []),
    `当前 Task 状态：${taskStatus}`,
    ...(input.artifactRefs.length > 0 ? [`产物：${input.artifactRefs.join("、")}`] : []),
    `本 AgentSession 观察到的文件变化（仅辅助证据，可能与并行 AgentSession 重复，不能覆盖 WorkRun Review）：${filesChanged.length > 0 ? filesChanged.join("、") : "无"}`,
    `本 AgentSession metrics：${JSON.stringify(metrics)}`,
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
  specRequested?: boolean;
}): string {
  return joinSegments([
    input.content ? buildPlatformEvent({ flowId: input.flowId, type: "guide", body: input.content }) : null,
    input.specRequested === true
      ? buildPlatformEvent({ flowId: input.flowId, type: "spec_requested", body: SPEC_REQUESTED_BODY })
      : null,
    buildPlanFeedbackEvent(input.flowId, input.planFeedback),
    ...buildBrowserCommentEvents(input.flowId, input.attachments),
  ]);
}

export function buildFlowNameRequestPrompt(flowId: string): string {
  return buildPlatformEvent({
    flowId,
    type: "flow_name_request",
    body: [
      "根据本 Flow 的首条用户需求和你刚完成的首次回复，生成一个不超过 10 个字的简洁中文名称。",
      "只调用 update_flow_name；不要输出文字，不要调用其他工具。",
    ].join("\n"),
  });
}

export function buildFlowNameWorkerPrompt(input: {
  userMessage: string;
  assistantMessage: string;
}): string {
  const userMessage = input.userMessage.trim().slice(0, 4_000);
  const assistantMessage = input.assistantMessage.trim().slice(0, 6_000);
  return [
    "你是 SquadFlow 的 Flow 命名助手，不是主对话 Agent。",
    "请根据首条用户需求和首轮回复，生成一个准确、简洁的中文 Flow 名称。",
    "只输出名称本身，不要解释、标点、引号、Markdown 或换行；名称最多 10 个字。",
    "如果首轮回复只是问候，也请根据用户需求生成名称。",
    "\n【首条用户需求】",
    userMessage || "（无）",
    "\n【首轮回复】",
    assistantMessage || "（无）",
  ].join("\n");
}

export function currentTurnInputFromTurn(turn: LeaderTurnInput): CurrentTurnInput | undefined {
  const createdAt = new Date().toISOString();
  if (turn.kind === "decision" || turn.kind === "decision_cancelled") {
    return {
      trigger_kind: turn.kind === "decision_cancelled" ? "decision_cancelled" : "decision_resolved",
      work_run_id: turn.workRunId,
      card_id: turn.decisionCardId,
      message_id: turn.decisionMessageId,
      content: turn.decisionUserMessage ?? "",
      ...(turn.kind === "decision" ? { answers: turn.decisionAnswers ?? {} } : {}),
      ...(turn.specRequested === true ? { spec_requested: true } : {}),
      created_at: createdAt,
    };
  }
  if (turn.kind === "spec_run") {
    return { trigger_kind: "spec_run", work_run_id: turn.workRunId, created_at: createdAt };
  }
  if (turn.kind === "expert_result") {
    return {
      trigger_kind: "expert_result",
      work_run_id: turn.workRunId,
      ...(turn.specRequested === true ? { spec_requested: true } : {}),
      created_at: createdAt,
    };
  }
  if (turn.kind === "expert_message") {
    return {
      trigger_kind: "expert_message",
      work_run_id: turn.workRunId,
      created_at: createdAt,
    };
  }
  if (turn.kind === "plan_approved") {
    return {
      trigger_kind: "plan_approved",
      work_run_id: turn.workRunId,
      created_at: createdAt,
    };
  }
  return undefined;
}

export function planApprovedBody(tasks: NonNullable<LeaderTurnInput["planApprovedTasks"]>): string {
  const lines = tasks.map((task) => {
    const deps = task.dependsOnTaskIds.length > 0 ? `依赖 ${task.dependsOnTaskIds.join("、")}` : "无依赖";
    return `- ${task.taskId} ${task.title}（${task.expertId}，${deps}）`;
  });
  return [
    "编排计划已批准并物化为以下任务：",
    ...lines,
    "由你负责派发：依赖已完成的节点用 dispatch_agent 派出，互不依赖的节点可同轮并行派；每个专家结果回来后再决定下一步。",
  ].join("\n");
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
  if (input.kind === "expert_message" && input.expertMessage) {
    const failed = input.expertMessage.status === "failed" || input.expertMessage.turnOutcome !== "completed";
    const filesChanged = input.expertMessage.filesChanged;
    const metrics = input.expertMessage.metrics;
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "expert_message",
      attrs: {
        expert: input.expertMessage.expertId,
        session: input.expertMessage.agentSessionId,
      },
      body: [
        failed ? `Expert 普通对话失败：${input.expertMessage.summary}` : input.expertMessage.summary,
        ...(failed && input.expertMessage.error ? [`错误：${input.expertMessage.error}`] : []),
        `本 AgentSession 观察到的文件变化（仅辅助证据，可能与并行 AgentSession 重复，不能覆盖 WorkRun Review）：${filesChanged.length > 0 ? filesChanged.join("、") : "无"}`,
        `本 AgentSession metrics：${JSON.stringify(metrics)}`,
      ].join("\n"),
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
  if (input.kind === "plan_approved") {
    return buildPlatformEvent({
      flowId: input.flowId,
      type: "plan_approved",
      body: planApprovedBody(input.planApprovedTasks ?? []),
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

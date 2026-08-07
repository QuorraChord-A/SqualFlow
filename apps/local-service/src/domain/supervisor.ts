export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_tool_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TOOL_CALL_STATUSES = [
  "started",
  "waiting_approval",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export type FlowBehaviorMode = "execute" | "plan";
export type RiskMode = "auto_edit" | "full_access";
export type OrchestrationMode = "approval_required" | "automatic";
export type ChangeSetStatus = "open" | "finalized" | "abandoned";
export type FlowIndicator = "pending_user_action" | "running" | "unread" | "idle";

const RUN_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(["running", "cancelled", "interrupted", "failed"]),
  running: new Set(["waiting_tool_approval", "completed", "failed", "cancelled", "interrupted"]),
  waiting_tool_approval: new Set(["running", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "blocked", "completed", "failed", "cancelled"]),
  in_progress: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["pending", "in_progress", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const TOOL_CALL_TRANSITIONS: Record<ToolCallStatus, ReadonlySet<ToolCallStatus>> = {
  started: new Set(["waiting_approval", "running", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["running", "failed", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_tool_approval";
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return !isActiveAgentRunStatus(status);
}

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].has(to);
}

export function assertAgentRunTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!canTransitionAgentRun(from, to)) {
    throw new Error(`INVALID_AGENT_RUN_TRANSITION:${from}->${to}`);
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].has(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new Error(`INVALID_TASK_TRANSITION:${from}->${to}`);
}

export function canTransitionToolCall(from: ToolCallStatus, to: ToolCallStatus): boolean {
  return from === to || TOOL_CALL_TRANSITIONS[from].has(to);
}

export function assertToolCallTransition(from: ToolCallStatus, to: ToolCallStatus): void {
  if (!canTransitionToolCall(from, to)) throw new Error(`INVALID_TOOL_CALL_TRANSITION:${from}->${to}`);
}

export function deriveFlowIndicator(input: {
  hasPendingUserAction: boolean;
  hasActiveAgentRun: boolean;
  hasUnreadOutput: boolean;
}): FlowIndicator {
  if (input.hasPendingUserAction) return "pending_user_action";
  if (input.hasActiveAgentRun) return "running";
  if (input.hasUnreadOutput) return "unread";
  return "idle";
}

export function selectComposerMode(input: {
  behaviorMode: FlowBehaviorMode;
  riskMode: RiskMode;
}): "auto_edit" | "plan" | "full_access" {
  return input.behaviorMode === "plan" ? "plan" : input.riskMode;
}

export function applyComposerMode(
  current: { behaviorMode: FlowBehaviorMode; riskMode: RiskMode },
  selected: "auto_edit" | "plan" | "full_access",
): { behaviorMode: FlowBehaviorMode; riskMode: RiskMode } {
  if (selected === "plan") return { ...current, behaviorMode: "plan" };
  return { behaviorMode: "execute", riskMode: selected };
}

export function exitPlanModeAfterApproval(current: {
  behaviorMode: FlowBehaviorMode;
  riskMode: RiskMode;
}): { behaviorMode: FlowBehaviorMode; riskMode: RiskMode } {
  return current.behaviorMode === "plan"
    ? { ...current, behaviorMode: "execute" }
    : current;
}

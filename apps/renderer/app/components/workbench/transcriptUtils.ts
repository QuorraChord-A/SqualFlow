import type { UIMessage } from "ai";

export function parseDecisionRequestId(output: unknown): string {
  try {
    let obj = output as any;
    if (obj && typeof obj === "object" && "content" in obj) {
      obj = JSON.parse(obj.content);
    } else if (typeof obj === "string") {
      obj = JSON.parse(obj);
    }
    if (obj && typeof obj === "object" && "result" in obj) {
      const result = typeof obj.result === "string" ? JSON.parse(obj.result) : obj.result;
      return result?.decision_request_id || "";
    }
    return obj?.decision_request_id || "";
  } catch {
    return "";
  }
}

function parseToolOutputObject(output: unknown): Record<string, unknown> | null {
  try {
    let value = output;
    if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
      value = (value as { content?: unknown }).content;
    }
    if (typeof value === "string") {
      value = JSON.parse(value);
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parsePlanCardFromCreatePlanOutput(output: unknown): {
  plan_approval_id: string;
  plan_revision_id: string;
  title: string;
  overview: string;
} | null {
  const parsed = parseToolOutputObject(output);
  if (!parsed) return null;
  const approval = parsed.plan_approval;
  const revision = parsed.plan_revision;
  if (!approval || typeof approval !== "object" || !revision || typeof revision !== "object") return null;
  const planApprovalId = typeof (approval as { plan_approval_id?: unknown }).plan_approval_id === "string"
    ? (approval as { plan_approval_id: string }).plan_approval_id
    : "";
  const planRevisionId = typeof (revision as { plan_revision_id?: unknown }).plan_revision_id === "string"
    ? (revision as { plan_revision_id: string }).plan_revision_id
    : "";
  if (!planApprovalId || !planRevisionId) return null;
  return {
    plan_approval_id: planApprovalId,
    plan_revision_id: planRevisionId,
    title: typeof (revision as { title?: unknown }).title === "string"
      ? (revision as { title: string }).title
      : "",
    overview: typeof (revision as { overview?: unknown }).overview === "string"
      ? (revision as { overview: string }).overview
      : "",
  };
}

export function cloneUiMessage(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...(part as Record<string, unknown>) })) as UIMessage["parts"],
  } as UIMessage;
}

export function lastPartIndex(parts: UIMessage["parts"], partType: string): number {
  for (let idx = parts.length - 1; idx >= 0; idx -= 1) {
    if (parts[idx]?.type === partType) return idx;
  }
  return -1;
}

export function extractMessageAgentSessionId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const row = message as Record<string, unknown>;
  if (typeof row.agent_session_id === "string") return row.agent_session_id;
  const data = row.data;
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    if (typeof nested.agent_session_id === "string") return nested.agent_session_id;
  }
  return undefined;
}

export function extractMessageAgentRunId(message: unknown): string | undefined {
  const msg = message as { agent_run_id?: string };
  return msg.agent_run_id;
}

export function extractToolDecisionRequestIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("tool-mcp__") && part.type.endsWith("__ask_user")) {
        const requestId = parseDecisionRequestId((part as any).output);
        if (requestId) ids.add(requestId);
      }
    }
  }
  return ids;
}

export function extractToolPlanApprovalIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("tool-mcp__") && part.type.endsWith("__create_plan")) {
        const card = parsePlanCardFromCreatePlanOutput((part as { output?: unknown }).output);
        if (card?.plan_approval_id) ids.add(card.plan_approval_id);
      }
    }
  }
  return ids;
}

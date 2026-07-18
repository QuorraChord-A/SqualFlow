import type { UIMessage } from "ai";

export function parseDecisionCardId(output: unknown): string {
  try {
    let obj = output as any;
    if (obj && typeof obj === "object" && "content" in obj) {
      obj = JSON.parse(obj.content);
    } else if (typeof obj === "string") {
      obj = JSON.parse(obj);
    }
    if (obj && typeof obj === "object" && "result" in obj) {
      const result = typeof obj.result === "string" ? JSON.parse(obj.result) : obj.result;
      return result?.card_id || "";
    }
    return obj?.card_id || "";
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

export function parseSpecCardFromCreatePlanOutput(output: unknown): {
  spec_approval_id: string;
  spec_revision_id: string;
  file_name: string;
  overview: string;
} | null {
  const parsed = parseToolOutputObject(output);
  if (!parsed) return null;
  const approval = parsed.spec_approval;
  const revision = parsed.spec_revision;
  if (!approval || typeof approval !== "object" || !revision || typeof revision !== "object") return null;
  const specApprovalId = typeof (approval as { spec_approval_id?: unknown }).spec_approval_id === "string"
    ? (approval as { spec_approval_id: string }).spec_approval_id
    : "";
  const specRevisionId = typeof (revision as { spec_revision_id?: unknown }).spec_revision_id === "string"
    ? (revision as { spec_revision_id: string }).spec_revision_id
    : "";
  if (!specApprovalId || !specRevisionId) return null;
  return {
    spec_approval_id: specApprovalId,
    spec_revision_id: specRevisionId,
    file_name: typeof (revision as { file_name?: unknown }).file_name === "string"
      ? (revision as { file_name: string }).file_name
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

export function extractMessageFlowExpertId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const row = message as Record<string, unknown>;
  if (typeof row.flow_expert_id === "string") return row.flow_expert_id;
  const data = row.data;
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    if (typeof nested.flow_expert_id === "string") return nested.flow_expert_id;
  }
  return undefined;
}

export function extractMessageAgentSessionId(message: unknown): string | undefined {
  const msg = message as { agent_session_id?: string; flow_expert_id?: string };
  return msg.agent_session_id || msg.flow_expert_id;
}

export function extractToolDecisionCardIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("tool-mcp__") && part.type.endsWith("__ask_user")) {
        const cardId = parseDecisionCardId((part as any).output);
        if (cardId) ids.add(cardId);
      }
    }
  }
  return ids;
}

export function extractToolSpecApprovalIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("tool-mcp__") && part.type.endsWith("__create_plan")) {
        const card = parseSpecCardFromCreatePlanOutput((part as { output?: unknown }).output);
        if (card?.spec_approval_id) ids.add(card.spec_approval_id);
      }
    }
  }
  return ids;
}

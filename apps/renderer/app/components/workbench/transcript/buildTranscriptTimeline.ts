import type { UIMessage } from "ai";
import { isMcpToolNamed, parseMcpOutput } from "./mcpToolPresenters";
import type {
  TranscriptActivity,
  TimelineInputMessage,
  TimelineInputPart,
  TimelineTool,
  TimelineToolState,
  TranscriptBlock,
} from "./types";

export type { TranscriptActivity } from "./types";

/**
 * Turn timing payload. Mirrors the backend `TurnTiming` shape so the renderer
 * can treat live and historical turns uniformly.
 */
export type TurnTiming = {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  activeDurationMs?: number | null;
  label?: "working" | "waiting" | "finished";
};

/**
 * Derive the transcript activity for a realtime chunk. Returns `null` for
 * events that do not advance the activity (text-end, reasoning-end,
 * tool-input-delta, ...). `hasRunningTool` is only consulted for
 * `tool-output-available` to decide whether to stay in `tool-running` or fall
 * back to `waiting`.
 */
export function deriveActivity(
  eventType: string,
  hasRunningTool: boolean,
): TranscriptActivity | null {
  switch (eventType) {
    case "start":
      return "waiting";
    case "reasoning-start":
    case "reasoning-delta":
      return "reasoning";
    case "text-start":
      return "waiting";
    case "text-delta":
      return "text";
    case "tool-input-start":
    case "tool-input-available":
      return "tool-running";
    case "tool-output-available":
      return hasRunningTool ? "tool-running" : "waiting";
    case "finish":
      return "finished";
    default:
      return null;
  }
}

/**
 * Derive the transcript activity for a resumed assistant message from an active
 * `session:transcript_snapshot`. The rules mirror the live event mapping so a
 * refreshed in-flight turn keeps its visible state:
 *
 * - no parts -> `waiting`
 * - any tool still streaming/awaiting input -> `tool-running`
 * - last content part is reasoning -> `reasoning`
 * - last content part is text -> `text`
 * - all tools completed with nothing after -> `waiting`
 *
 * Empty text/reasoning parts are skipped so a trailing empty streaming part
 * does not masquerade as content.
 */
export function deriveActivityFromMessage(message: UIMessage): TranscriptActivity {
  const parts = (message?.parts ?? []) as ReadonlyArray<{
    type?: string;
    text?: string;
    state?: string;
  }>;
  if (parts.length === 0) return "waiting";

  const hasRunningTool = parts.some(
    (part) =>
      typeof part?.type === "string" &&
      part.type.startsWith("tool-") &&
      (part.state === "input-streaming" || part.state === "input-available"),
  );
  if (hasRunningTool) return "tool-running";

  for (let idx = parts.length - 1; idx >= 0; idx -= 1) {
    const part = parts[idx];
    if (!part) continue;
    if (part.type === "text" && part.text) return "text";
    if (part.type === "reasoning" && part.text) return "reasoning";
    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      // The most recent content is a (completed) tool with nothing after it.
      return "waiting";
    }
    // Skip empty text/reasoning parts and keep scanning backwards.
  }
  return "waiting";
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compute the final turn timing when a `finish` chunk arrives. Prefers the
 * SDK-provided `durationMs`; when it is null/invalid, falls back to local
 * elapsed milliseconds derived from `startedAt` and the resolved
 * `finishedAt`. `finishedAt` prefers the event value, otherwise local now.
 */
export function computeFinishedTiming(params: {
  startedAt: string | null;
  eventDurationMs: number | null;
  eventFinishedAt: string | null;
  now?: () => Date;
}): TurnTiming {
  const now = params.now ?? (() => new Date());
  const finishedAt = params.eventFinishedAt ?? now().toISOString();

  let durationMs: number | null;
  if (typeof params.eventDurationMs === "number" && Number.isFinite(params.eventDurationMs)) {
    durationMs = params.eventDurationMs;
  } else {
    const startMs = toMs(params.startedAt);
    const endMs = toMs(finishedAt);
    durationMs = startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null;
  }

  return {
    startedAt: params.startedAt,
    finishedAt,
    durationMs,
  };
}

/**
 * Read a normalized `TurnTiming` from a history message's metadata. Returns
 * `null` when the message carries no timing payload. Historical turns always
 * prefer the persisted `durationMs` over locally derived elapsed time.
 */
export function readHistoryTurnTiming(message: UIMessage): TurnTiming | null {
  const timing = (message as { metadata?: { turnTiming?: TurnTiming | null } }).metadata?.turnTiming;
  if (!timing) return null;
  return {
    startedAt: timing.startedAt ?? null,
    finishedAt: timing.finishedAt ?? null,
    durationMs:
      typeof timing.durationMs === "number" && Number.isFinite(timing.durationMs)
        ? timing.durationMs
        : null,
  };
}

function isToolPart(part: TimelineInputPart): part is Extract<TimelineInputPart, { type: `tool-${string}` }> {
  return part.type.startsWith("tool-");
}

function partStableId(
  messageId: string,
  prefix: string,
  part: TimelineInputPart | undefined,
  ordinal: number | string,
): string {
  const partId = part && typeof (part as unknown as { id?: unknown }).id === "string"
    ? (part as unknown as { id: string }).id
    : null;
  return partId
    ? `${messageId}:${prefix}:${partId}`
    : `${messageId}:${prefix}:${ordinal}`;
}

function toolGroupStableId(
  messageId: string,
  firstToolCallId: string | null,
  firstPartIndex: number,
): string {
  return firstToolCallId
    ? `${messageId}:tool-group:${firstToolCallId}`
    : `${messageId}:tool-group:${firstPartIndex}`;
}

function toolStateFromPart(state: "input-streaming" | "input-available" | "output-available"): TimelineToolState {
  switch (state) {
    case "output-available":
      return "completed";
    case "input-streaming":
    case "input-available":
    default:
      return "running";
  }
}

function parseDecisionCardId(output: unknown): string {
  const parsed = parseMcpOutput(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.decision_card_id === "string" && obj.decision_card_id) {
      return obj.decision_card_id;
    }
    if (obj.result && typeof obj.result === "object") {
      const result = obj.result as Record<string, unknown>;
      return typeof result.card_id === "string" ? result.card_id : "";
    }
    if (typeof obj.card_id === "string") return obj.card_id;
  }
  return "";
}

function parseSpecCard(output: unknown): { specApprovalId: string } | null {
  const parsed = parseMcpOutput(output);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.spec_approval_id === "string" && obj.spec_approval_id) {
      return { specApprovalId: obj.spec_approval_id };
    }
    const approval = obj.spec_approval;
    if (approval && typeof approval === "object") {
      const specApprovalId = (approval as Record<string, unknown>).spec_approval_id;
      if (typeof specApprovalId === "string" && specApprovalId) {
        return { specApprovalId };
      }
    }
  }
  return null;
}

function parsePlanCard(output: unknown): { planRevisionId: string } | null {
  const parsed = parseMcpOutput(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const revision = (parsed as Record<string, unknown>).revision;
  if (!revision || typeof revision !== "object") return null;
  const row = revision as Record<string, unknown>;
  const id = typeof row.plan_revision_id === "string" ? row.plan_revision_id : typeof row.id === "string" ? row.id : "";
  return id ? { planRevisionId: id } : null;
}

/**
 * Preserve the normalized MCP envelope for the result renderer. Older
 * transcript records only contain the already-stringified tool output, so
 * those continue through the legacy parser.
 */
function timelineToolOutput(
  part: Extract<TimelineInputPart, { type: `tool-${string}` }>,
): unknown {
  if (part.output == null) return null;
  const output = part.output;
  if (
    part.mcp
    && output
    && typeof output === "object"
    && !Array.isArray(output)
    && "mcp" in (output as Record<string, unknown>)
  ) {
    return output;
  }
  return parseMcpOutput(output);
}

type BuildOptions = {
  message: TimelineInputMessage;
  activity: TranscriptActivity;
};

type PendingToolGroup = {
  id: string;
  tools: TimelineTool[];
  cards: TranscriptBlock[];
};

export function buildTranscriptTimeline({ message, activity }: BuildOptions): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  if (message.role === "user") {
    const text = message.parts
      .filter((part): part is Extract<TimelineInputPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    const decisionCardId = message.metadata?.decisionCardId;
    const decisionStatus = message.metadata?.decisionStatus;
    if (decisionCardId && (decisionStatus === "resolved" || decisionStatus === "cancelled")) {
      return [{
        id: `${message.id}:decision-card-result:${decisionCardId}`,
        type: "decision-card-result",
        cardId: decisionCardId,
        status: decisionStatus,
        collapseState: "shallow",
      }];
    }
    return text
      ? [{ id: `${message.id}:text:0`, type: "text", text, streaming: false }]
      : [];
  }
  let currentGroup: PendingToolGroup | null = null;
  let postGroupBlocks: TranscriptBlock[] = [];
  let postGroupHasText = false;

  function pushGroupBlock(params: {
    finalized: boolean;
    activeState?: "thinking" | "running" | "pinned";
    currentToolCallId?: string | null;
  }) {
    if (!currentGroup || currentGroup.tools.length === 0) return;
    blocks.push({
      id: currentGroup.id,
      type: "tool-group",
      tools: currentGroup.tools,
      finalized: params.finalized,
      defaultCollapsed: true,
      activeState: params.activeState,
      currentToolCallId: params.currentToolCallId ?? null,
    });
    for (const card of currentGroup.cards) {
      blocks.push(card);
    }
  }

  function materializeCurrentGroup() {
    pushGroupBlock({ finalized: true });
    currentGroup = null;
  }

  function flushPostGroupBlocks() {
    if (postGroupBlocks.length > 0) {
      blocks.push(...postGroupBlocks);
    }
    postGroupBlocks = [];
    postGroupHasText = false;
  }

  function addOrUpdateTool(part: Extract<TimelineInputPart, { type: `tool-${string}` }>, partIndex: number) {
    if (!currentGroup) {
      currentGroup = {
        id: toolGroupStableId(message.id, part.toolCallId || null, partIndex),
        tools: [],
        cards: [],
      };
    }

    const existing = currentGroup.tools.find((tool) => tool.toolCallId === part.toolCallId);
    if (existing) {
      existing.toolName = part.toolName;
      existing.capability = part.capability ?? existing.capability;
      existing.providerToolName = part.providerToolName ?? existing.providerToolName;
      existing.mcp = part.mcp ?? existing.mcp;
      existing.input = part.input ?? existing.input;
      if (part.state === "output-available") {
        existing.output = timelineToolOutput(part);
        existing.state = "completed";
      }
      return;
    }

    currentGroup.tools.push({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      capability: part.capability,
      providerToolName: part.providerToolName,
      mcp: part.mcp,
      state: toolStateFromPart(part.state),
      input: part.input ?? null,
      output: timelineToolOutput(part),
    });
  }

  function maybeEmitCardBlock(part: Extract<TimelineInputPart, { type: `tool-${string}` }>) {
    if (part.state !== "output-available" || !currentGroup) return;

    if (isMcpToolNamed(part.toolName, "ask_user", part.mcp?.tool)) {
      const cardId = parseDecisionCardId(part.output);
      if (cardId && !currentGroup.cards.some((card) => card.type === "decision-card" && card.cardId === cardId)) {
        currentGroup.cards.push({
          id: `${message.id}:decision-card:${cardId}`,
          type: "decision-card",
          cardId,
          toolCallId: part.toolCallId,
        });
      }
      return;
    }

    if (isMcpToolNamed(part.toolName, "create_plan", part.mcp?.tool)) {
      const specCard = parseSpecCard(part.output);
      if (specCard) {
        currentGroup.cards.push({
          id: `${message.id}:spec-card:${specCard.specApprovalId}`,
          type: "spec-card",
          specApprovalId: specCard.specApprovalId,
          toolCallId: part.toolCallId,
        });
      }
      return;
    }

    if (isMcpToolNamed(part.toolName, "submit_orchestration_plan", part.mcp?.tool)) {
      const planCard = parsePlanCard(part.output);
      if (planCard) currentGroup.cards.push({
        id: `tool-card:${part.toolCallId}:orchestration-plan`,
        type: "plan-card",
        planRevisionId: planCard.planRevisionId,
        toolCallId: part.toolCallId,
      });
    }
  }

  function currentRunningToolCallId(): string | null {
    if (!currentGroup) return null;
    const runningTool = [...currentGroup.tools].reverse().find((tool) => tool.state === "running");
    return runningTool?.toolCallId ?? null;
  }

  function currentPinnedToolCallId(): string | null {
    if (!currentGroup) return null;
    const latestTool = [...currentGroup.tools].reverse().find((tool) => tool.state !== "interrupted");
    return latestTool?.toolCallId ?? null;
  }

  for (let idx = 0; idx < message.parts.length; idx += 1) {
    const part = message.parts[idx];
    if (!part) continue;

    if (part.type === "text") {
      if (part.text.length > 0) {
        const textBlock: TranscriptBlock = {
          id: partStableId(message.id, "text", part, idx),
          type: "text",
          text: part.text,
          streaming: false,
        };
        if (currentGroup) {
          postGroupBlocks.push(textBlock);
          postGroupHasText = true;
        } else {
          blocks.push(textBlock);
        }
      }
      continue;
    }

    if (part.type === "reasoning") {
      const reasoningBlock: TranscriptBlock = {
        id: partStableId(message.id, "reasoning", part, idx),
        type: "reasoning",
        text: part.text,
        streaming: false,
        defaultCollapsed: false,
      };
      if (currentGroup) {
        postGroupBlocks.push(reasoningBlock);
      } else {
        blocks.push(reasoningBlock);
      }
      continue;
    }

    if (isToolPart(part)) {
      if (currentGroup && (postGroupHasText || postGroupBlocks.length > 0)) {
        materializeCurrentGroup();
        flushPostGroupBlocks();
      }
      addOrUpdateTool(part, idx);
      maybeEmitCardBlock(part);
      continue;
    }
  }

  if (activity === "finished") {
    materializeCurrentGroup();
    flushPostGroupBlocks();
  } else {
    const group = currentGroup as PendingToolGroup | null;
    if (group && group.tools.length > 0) {
      const runningToolCallId = currentRunningToolCallId();
      pushGroupBlock({
        finalized: false,
        activeState: runningToolCallId ? "running" : activity === "reasoning" ? "thinking" : "pinned",
        currentToolCallId: runningToolCallId ?? currentPinnedToolCallId(),
      });
      flushPostGroupBlocks();
      currentGroup = null;
    }
  }

  // Delay reasoning collapse: only collapse reasoning blocks that are followed by a non-reasoning block.
  for (let idx = blocks.length - 1; idx >= 0; idx -= 1) {
    const block = blocks[idx];
    if (block?.type === "reasoning") {
      const hasNonReasoningAfter = blocks.some(
        (laterBlock, laterIdx) => laterIdx > idx && laterBlock.type !== "reasoning",
      );
      block.defaultCollapsed = hasNonReasoningAfter || activity === "finished";
    }
  }

  // Apply streaming semantics based on activity.
  const isStreamingActivity = activity === "text" || activity === "reasoning";
  if (isStreamingActivity) {
    const lastTextIdx = blocks.findLastIndex((block) => block.type === "text");
    const lastReasoningIdx = blocks.findLastIndex((block) => block.type === "reasoning");

    for (let idx = 0; idx < blocks.length; idx += 1) {
      const block = blocks[idx];
      if (block.type === "text") {
        block.streaming = activity === "text" && idx === lastTextIdx;
      }
      if (block.type === "reasoning") {
        const isLastReasoning = idx === lastReasoningIdx;
        const hasNonReasoningAfter = blocks.some(
          (laterBlock, laterIdx) => laterIdx > idx && laterBlock.type !== "reasoning",
        );
        block.streaming = activity === "reasoning" && isLastReasoning && !hasNonReasoningAfter;
      }
    }
  }

  // Mark any running tools in a finalized group as interrupted.
  for (const block of blocks) {
    if (block.type === "tool-group" && block.finalized) {
      for (const tool of block.tools) {
        if (tool.state === "running") {
          tool.state = "interrupted";
        }
      }
    }
  }

  if ((activity === "waiting" || activity === "tool-running") && !blocks.some(
    (block) => block.type === "tool-group" && !block.finalized,
  )) {
    const anchorId = [...blocks]
      .reverse()
      .find((block) => block.type !== "decision-card" && block.type !== "spec-card")?.id ?? "initial";
    blocks.push({ id: `${message.id}:thinking-after:${anchorId}`, type: "thinking" });
  }

  return blocks;
}

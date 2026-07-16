import type { ContextUsageSnapshot } from "../domain/contextUsage.js";

export type RuntimeTurnResult = {
  status: string | null;
  isError: boolean;
  sessionId: string | null;
};

export type RuntimeEvent =
  | { type: "turn_completed"; result: RuntimeTurnResult; raw: unknown }
  | { type: "compact_boundary"; snapshot: ContextUsageSnapshot; raw: unknown }
  | { type: "compact_failed"; error: string; raw: unknown }
  | { type: "other"; raw: unknown };

export type RuntimeAdapterCapabilities = {
  /** Live message injection into an in-progress turn (e.g. Leader `flow:guide`). */
  steer: boolean;
  /** Context compaction support (`/compact`-style turn). */
  compact: boolean;
  /** SDK-native session transcript loading; when false, SquadFlow's chatJournal is the only history source. */
  historyRead: boolean;
  imageInput: boolean;
  tokenUsage: boolean;
  toolApproval: boolean;
};

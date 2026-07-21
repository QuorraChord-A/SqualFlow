import type { ContextUsageSnapshot } from "../domain/contextUsage.js";

export type RuntimeTurnResult = {
  status: string | null;
  isError: boolean;
  sessionId: string | null;
};

export type RuntimeEvent =
  | { type: "turn_completed"; result: RuntimeTurnResult; raw: unknown }
  /**
   * A provider turn boundary the adapter adjudged as NOT the real completion of the
   * logical round: the echo of a turn killed by a live injection (Claude `priority:"now"`,
   * `terminal_reason:"aborted_streaming"`), or a Codex turn that ended while injected
   * input is still pending delivery. Runtimes must not finalize on this event.
   */
  | { type: "turn_absorbed"; reason: string; result: RuntimeTurnResult; raw: unknown }
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

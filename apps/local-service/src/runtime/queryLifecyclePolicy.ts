/**
 * Query lifecycle policy shared by Leader and Expert runtimes.
 *
 * - Zero-progress: while a turn is active, any stretch with no SDK events this long
 *   means the connection is treated as dead — fail the turn and tear down so the UI
 *   cannot stay on "thinking" forever.
 * - Wait-finished: when a prior stream already closed input, bound how long the next
 *   turn waits for finalize before force-release.
 *
 * Note: idle-window hot-reuse of the same Claude/Mimo streaming query is intentionally
 * not used. After a turn completes with an empty queue we close and resume next message
 * (real agent CLI does not reliably accept a new user message after an idle gap on the
 * same query). Same-query reuse still works for turns already queued mid-stream.
 */

export const DEFAULT_QUERY_ZERO_PROGRESS_MS = 3 * 60_000;
export const DEFAULT_QUERY_WAIT_FINISHED_MS = 5_000;

type QueryLifecycleTimeouts = {
  zeroProgressMs: number;
  waitFinishedMs: number;
};

const defaults: QueryLifecycleTimeouts = {
  zeroProgressMs: DEFAULT_QUERY_ZERO_PROGRESS_MS,
  waitFinishedMs: DEFAULT_QUERY_WAIT_FINISHED_MS,
};

let timeouts: QueryLifecycleTimeouts = { ...defaults };

export function queryZeroProgressMs() {
  return timeouts.zeroProgressMs;
}

export function queryWaitFinishedMs() {
  return timeouts.waitFinishedMs;
}

/** Test-only: shorten lifecycle timeouts without sleeping for minutes. */
export function setQueryLifecycleTimeoutsForTests(partial: Partial<QueryLifecycleTimeouts>) {
  timeouts = { ...timeouts, ...partial };
}

export function resetQueryLifecycleTimeoutsForTests() {
  timeouts = { ...defaults };
}

export const ZERO_PROGRESS_ERROR_MESSAGE =
  "Runtime made no progress (no SDK events); the connection was closed so you can retry.";

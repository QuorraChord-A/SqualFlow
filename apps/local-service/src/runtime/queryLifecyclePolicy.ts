/**
 * Query lifecycle policy shared by Leader and Expert runtimes.
 *
 * - Wait-finished: when a prior stream already closed input, bound how long the next
 *   turn waits for finalize before force-release.
 *
 * Note: idle-window hot-reuse of the same Claude/Mimo streaming query is intentionally
 * not used. After a turn completes with an empty queue we close and resume next message
 * (real agent CLI does not reliably accept a new user message after an idle gap on the
 * same query). Same-query reuse still works for turns already queued mid-stream.
 */

export const DEFAULT_QUERY_WAIT_FINISHED_MS = 5_000;

export function queryWaitFinishedMs() {
  return DEFAULT_QUERY_WAIT_FINISHED_MS;
}

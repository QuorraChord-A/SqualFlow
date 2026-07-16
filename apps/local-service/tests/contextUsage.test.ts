import { describe, expect, it } from "vitest";
import {
  mergeContextCacheUsage,
  type ContextUsageSnapshot,
} from "../src/domain/contextUsage.js";

function snapshot(input: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    totalTokens: 100,
    maxTokens: 1_000,
    rawMaxTokens: 1_000,
    percentage: 10,
    model: "mimo-v2.5",
    categories: [],
    cacheInputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    cacheHitRate: null,
    observedAt: "2026-07-12T21:00:00.000Z",
    compacted: false,
    ...input,
  };
}

describe("mergeContextCacheUsage", () => {
  const previous = snapshot({
    cacheInputTokens: 80,
    cacheReadInputTokens: 64,
    cacheCreationInputTokens: 0,
    cacheHitRate: 80,
  });

  it("preserves previous cache stats when no telemetry was observed", () => {
    expect(mergeContextCacheUsage(snapshot(), null, previous)).toEqual(expect.objectContaining({
      cacheInputTokens: 80,
      cacheReadInputTokens: 64,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
    }));
  });

  it("clears previous cache stats when the latest telemetry is explicitly unknown", () => {
    expect(mergeContextCacheUsage(snapshot({ cacheInputTokens: 90 }), {
      inputTokens: 90,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    }, previous)).toEqual(expect.objectContaining({
      cacheInputTokens: 90,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    }));
  });

  it("allows a later valid sample to replace unknown cache telemetry", () => {
    expect(mergeContextCacheUsage(snapshot({ cacheInputTokens: 100 }), {
      inputTokens: 100,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
      cacheHitRate: 90,
    }, snapshot({ cacheInputTokens: 90 }))).toEqual(expect.objectContaining({
      cacheInputTokens: 100,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 0,
      cacheHitRate: 90,
    }));
  });
});

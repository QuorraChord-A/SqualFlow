import { describe, expect, it } from "vitest";
import {
  mergeContextCacheUsage,
  overallContextUsageFromResultCache,
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

describe("overallContextUsageFromResultCache", () => {
  it("sums input + cache_read + cache_creation for overall occupancy", () => {
    // Real Mimo session: 80 + 24896 matched getContextUsage.totalTokens (24976).
    const snap = overallContextUsageFromResultCache({
      inputTokens: 80,
      cacheReadInputTokens: 24_896,
      cacheCreationInputTokens: 0,
      cacheHitRate: 99.7,
    }, { maxTokens: 1_000_000, model: "mimo-v2.5[1m]" });
    expect(snap).toEqual(expect.objectContaining({
      totalTokens: 24_976,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      model: "mimo-v2.5[1m]",
      categories: [],
      cacheInputTokens: 80,
      cacheReadInputTokens: 24_896,
      cacheCreationInputTokens: 0,
    }));
    expect(snap?.percentage).toBeCloseTo(2.4976, 4);
  });

  it("does not treat bare input_tokens as total context when cache is present", () => {
    const snapshot = overallContextUsageFromResultCache({
      inputTokens: 80,
      cacheReadInputTokens: 24_896,
      cacheCreationInputTokens: 0,
      cacheHitRate: null,
    }, { maxTokens: 1_000_000 });
    expect(snapshot?.totalTokens).not.toBe(80);
    expect(snapshot?.totalTokens).toBe(24_976);
  });

  it("returns null when result usage is missing", () => {
    expect(overallContextUsageFromResultCache(null, { maxTokens: 200_000 })).toBeNull();
  });
});

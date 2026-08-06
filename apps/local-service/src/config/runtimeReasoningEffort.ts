import type { RuntimeSdk } from "./agentRuntimeConfig.js";

const RUNTIME_REASONING_EFFORTS: Record<RuntimeSdk, readonly string[]> = {
  claudecode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

const DEFAULT_RUNTIME_REASONING_EFFORT: Record<RuntimeSdk, string> = {
  claudecode: "high",
  codex: "medium",
};

/** Effort is a SquadFlow SDK capability, not provider catalog metadata. */
export function runtimeReasoningEffortsForSdk(sdk: RuntimeSdk): string[] {
  return [...RUNTIME_REASONING_EFFORTS[sdk]];
}

export function defaultRuntimeReasoningEffortForSdk(sdk: RuntimeSdk): string {
  return DEFAULT_RUNTIME_REASONING_EFFORT[sdk];
}

export function parseRuntimeReasoningEffort(sdk: RuntimeSdk, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  return RUNTIME_REASONING_EFFORTS[sdk].includes(effort) ? effort : null;
}

export function normalizeRuntimeReasoningEffort(sdk: RuntimeSdk, value: unknown): string {
  return parseRuntimeReasoningEffort(sdk, value) ?? defaultRuntimeReasoningEffortForSdk(sdk);
}

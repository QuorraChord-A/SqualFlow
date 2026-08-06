import type { AgentRuntimeConfigDto, RuntimeSdk } from "./api";

const RUNTIME_REASONING_EFFORTS: Record<RuntimeSdk, readonly string[]> = {
  claudecode: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

const DEFAULT_RUNTIME_REASONING_EFFORT: Record<RuntimeSdk, string> = {
  claudecode: "high",
  codex: "medium",
};

const CODEX_REASONING_EFFORT_LABELS: Record<string, string> = {
  low: "轻度",
  medium: "中",
  high: "高级",
  xhigh: "超高",
  max: "最高",
  ultra: "极高",
};

export type RuntimeReasoningEffortOption = {
  value: string;
  label: string;
};

export function reasoningEffortOptionsForSdk(sdk: RuntimeSdk): RuntimeReasoningEffortOption[] {
  return RUNTIME_REASONING_EFFORTS[sdk].map((value) => ({
    value,
    label: sdk === "codex" ? CODEX_REASONING_EFFORT_LABELS[value] ?? value : value,
  }));
}

export function reasoningEffortOptionsForLeaderConfig(
  config: AgentRuntimeConfigDto | null | undefined,
): RuntimeReasoningEffortOption[] {
  if (!config || (config.sdk === "codex" && config.authMode !== "inherited")) return [];
  return reasoningEffortOptionsForSdk(config.sdk);
}

export function defaultReasoningEffortForSdk(sdk: RuntimeSdk): string {
  return DEFAULT_RUNTIME_REASONING_EFFORT[sdk];
}

export function defaultReasoningEffortForLeaderConfig(
  config: AgentRuntimeConfigDto | null | undefined,
) {
  const options = reasoningEffortOptionsForLeaderConfig(config);
  const fallback = config ? defaultReasoningEffortForSdk(config.sdk) : "";
  return options.some((option) => option.value === fallback) ? fallback : "";
}

export function normalizeReasoningEffortForSdk(sdk: RuntimeSdk, value: string | null | undefined) {
  return RUNTIME_REASONING_EFFORTS[sdk].includes(value ?? "")
    ? value!
    : defaultReasoningEffortForSdk(sdk);
}

export function normalizeReasoningEffortForLeaderConfig(
  config: AgentRuntimeConfigDto | null | undefined,
  value: string | null | undefined,
) {
  const options = reasoningEffortOptionsForLeaderConfig(config);
  if (options.length === 0) return "";
  return options.some((option) => option.value === value)
    ? value!
    : defaultReasoningEffortForLeaderConfig(config);
}

export function reasoningEffortLabelForSdk(sdk: RuntimeSdk, value: string | null | undefined) {
  return reasoningEffortOptionsForSdk(sdk).find((option) => option.value === value)?.label ?? value ?? "";
}

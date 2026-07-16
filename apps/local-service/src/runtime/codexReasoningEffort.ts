const baseEfforts = ["low", "medium", "high", "xhigh"] as const;

export function codexReasoningEffortsForModel(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (/^gpt-5\.6-luna(?:$|-)/u.test(normalized)) return [...baseEfforts, "max"];
  if (/^gpt-5\.6(?:$|-)/u.test(normalized)) return [...baseEfforts, "max", "ultra"];
  return [...baseEfforts];
}

export function defaultCodexReasoningEffortForModel(model: string): string {
  return /^gpt-5\.6-sol(?:$|-)/u.test(model.trim().toLowerCase()) ? "low" : "medium";
}

export function parseCodexReasoningEffort(model: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  return codexReasoningEffortsForModel(model).includes(effort) ? effort : null;
}

export function normalizeCodexReasoningEffort(model: string, value: unknown): string {
  return parseCodexReasoningEffort(model, value) ?? defaultCodexReasoningEffortForModel(model);
}

/** Parse person-name candidate JSON stored on the Expert template. */
export function parsePersonNameCandidates(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Pick a person display name for a new FlowExpert.
 * Prefers unused candidates within the Flow; falls back to suffixing.
 */
export function pickPersonDisplayName(input: {
  candidates: string[];
  usedNames: Iterable<string>;
  fallback: string;
}): string {
  const used = new Set(
    [...input.usedNames]
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const candidates = input.candidates.map((name) => name.trim()).filter(Boolean);
  const available = candidates.filter((name) => !used.has(name));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)]!;
  }
  if (candidates.length > 0) {
    const base = candidates[0]!;
    let suffix = 2;
    while (used.has(`${base}${suffix}`)) suffix += 1;
    return `${base}${suffix}`;
  }
  const fallback = input.fallback.trim() || "专家";
  if (!used.has(fallback)) return fallback;
  let suffix = 2;
  while (used.has(`${fallback}${suffix}`)) suffix += 1;
  return `${fallback}${suffix}`;
}

/** Capability hint for Leader when choosing who does what (no template ids required). */
export function expertCapabilityHint(role: string): string {
  switch (role) {
    case "coder":
      return "实现与修改代码、修复缺陷";
    case "research":
      return "调研、影响面分析、只读查证";
    case "verify":
      return "独立验证、测试与验收";
    case "codereview":
      return "代码审查与风险识别";
    case "leader":
      return "编排与对话";
    default:
      return "专家工作";
  }
}

import {
  isRuntimeCapability,
  type RuntimeCapability,
} from "../domain/runtimeCapabilities.js";

export * from "../domain/runtimeCapabilities.js";

const legacyProviderToolCapabilities = new Map<string, RuntimeCapability[]>([
  ["Read", ["read"]],
  ["LS", ["read"]],
  ["Write", ["write"]],
  ["Edit", ["edit"]],
  ["Bash", ["shell"]],
  ["Glob", ["search"]],
  ["Grep", ["search"]],
  ["WebSearch", ["web_search"]],
]);

export function capabilitiesForLegacyProviderTool(toolName: string): RuntimeCapability[] {
  return legacyProviderToolCapabilities.get(toolName) ?? [];
}

export function normalizeRuntimeCapabilities(values: readonly string[]): RuntimeCapability[] {
  const capabilities = new Set<RuntimeCapability>();
  for (const value of values) {
    if (isRuntimeCapability(value)) {
      capabilities.add(value);
      continue;
    }
    for (const capability of capabilitiesForLegacyProviderTool(value)) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}

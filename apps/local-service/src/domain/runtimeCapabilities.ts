export const runtimeCapabilities = [
  "read",
  "write",
  "edit",
  "shell",
  "search",
  "web_search",
] as const;

export type RuntimeCapability = typeof runtimeCapabilities[number];

const runtimeCapabilitySet = new Set<string>(runtimeCapabilities);

export type RuntimeToolInput = {
  path?: string | null;
  command?: string | null;
  query?: string | null;
};

export function isRuntimeCapability(value: string): value is RuntimeCapability {
  return runtimeCapabilitySet.has(value);
}

export function hasRuntimeCapability(
  capabilities: ReadonlySet<RuntimeCapability> | readonly RuntimeCapability[],
  capability: RuntimeCapability,
): boolean {
  const maybeSet = capabilities as ReadonlySet<RuntimeCapability>;
  if (typeof maybeSet.has === "function") return maybeSet.has(capability);
  return (capabilities as readonly RuntimeCapability[]).includes(capability);
}

export function hasWriteRuntimeCapability(
  capabilities: ReadonlySet<RuntimeCapability> | readonly RuntimeCapability[],
): boolean {
  return hasRuntimeCapability(capabilities, "write") || hasRuntimeCapability(capabilities, "edit");
}

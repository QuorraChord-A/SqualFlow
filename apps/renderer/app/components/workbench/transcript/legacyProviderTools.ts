import type { ToolKind } from "./types";

const legacyProviderToolKinds: Record<string, ToolKind> = {
  Glob: "glob",
  Grep: "grep",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  WebSearch: "web-search",
};

export function isLegacyProviderTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(legacyProviderToolKinds, toolName);
}

export function kindForLegacyProviderTool(toolName: string): ToolKind | null {
  return legacyProviderToolKinds[toolName] ?? null;
}

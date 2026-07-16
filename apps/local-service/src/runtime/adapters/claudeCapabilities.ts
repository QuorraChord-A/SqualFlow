import type { RuntimeCapability } from "../capabilities.js";

const capabilityToClaudeTools: Record<RuntimeCapability, string[]> = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  shell: ["Bash"],
  search: ["Glob", "Grep"],
  web_search: ["WebSearch"],
};

const claudeToolToCapability = new Map<string, RuntimeCapability>([
  ["Read", "read"],
  ["LS", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Bash", "shell"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["WebSearch", "web_search"],
]);

export function claudeToolsForCapabilities(capabilities: readonly RuntimeCapability[]): string[] {
  const tools = new Set<string>();
  for (const capability of capabilities) {
    for (const tool of capabilityToClaudeTools[capability] ?? []) {
      tools.add(tool);
    }
  }
  return [...tools];
}

export function claudeCapabilityForTool(toolName: string): RuntimeCapability | null {
  return claudeToolToCapability.get(toolName) ?? null;
}

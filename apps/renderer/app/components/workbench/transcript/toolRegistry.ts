import { isExplicitPermissionDenial, presentBuiltInTool } from "./builtinToolPresenters";
import { kindForLegacyProviderTool } from "./legacyProviderTools";
import { isMcpTool, presentMcpTool } from "./mcpToolPresenters";
import { kindForCapability } from "./toolKinds";
import type { TimelineTool, ToolKind, ToolPresentation } from "./types";

export type { ToolPresentation } from "./types";

export function presentTool(tool: TimelineTool): ToolPresentation {
  if (isMcpTool(tool.toolName)) {
    return presentMcpTool(tool);
  }
  return presentBuiltInTool(tool);
}

const SUMMARY_TEMPLATES: Record<ToolKind | "unknown", (n: number) => string> = {
  glob: (n) => `探索了 ${n} 个列表`,
  grep: (n) => `搜索了 ${n} 次`,
  read: (n) => `读取了 ${n} 个文件`,
  write: (n) => `写入了 ${n} 个文件`,
  edit: (n) => `编辑了 ${n} 个文件`,
  bash: (n) => `执行了 ${n} 条命令`,
  "web-search": (n) => `联网搜索了 ${n} 次`,
  mcp: (n) => `调用了 ${n} 个 MCP 工具`,
  unknown: (n) => `调用了 ${n} 个工具`,
};

function kindOfTool(tool: TimelineTool): ToolKind {
  const capabilityKind = kindForCapability(tool.capability);
  if (capabilityKind) return capabilityKind;
  if (isMcpTool(tool.toolName)) return "mcp";
  return kindForLegacyProviderTool(tool.toolName) ?? "unknown";
}

export function summarizeToolGroup(tools: TimelineTool[]): string {
  if (tools.length === 0) return "";

  const interruptedCount = tools.filter((tool) => tool.state === "interrupted").length;
  const deniedCount = tools.filter((tool) => isExplicitPermissionDenial(tool.output)).length;
  if (deniedCount === tools.length) return "已拒绝";
  if (interruptedCount === tools.length) return "已中断";

  const counts = new Map<ToolKind, number>();
  const order: ToolKind[] = [];

  for (const tool of tools) {
    if (tool.state === "interrupted" || isExplicitPermissionDenial(tool.output)) continue;
    const kind = kindOfTool(tool);
    if (!counts.has(kind)) {
      counts.set(kind, 0);
      order.push(kind);
    }
    counts.set(kind, counts.get(kind)! + 1);
  }

  const phrases = order.map((kind) => SUMMARY_TEMPLATES[kind](counts.get(kind)!));

  const summaryParts = [phrases.join("和")];
  if (deniedCount > 0) summaryParts.push(`${deniedCount} 个工具已拒绝`);
  if (interruptedCount > 0) summaryParts.push(`${interruptedCount} 个工具已中断`);
  return summaryParts.filter(Boolean).join("，");
}

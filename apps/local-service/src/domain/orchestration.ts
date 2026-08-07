import { z } from "zod";

export const OrchestrationNodeInputSchema = z.object({
  node_id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/u),
  recommended_agent_definition_id: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(8_000),
  depends_on: z.array(z.string().min(1)).default([]),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const SubmitOrchestrationPlanSchema = z.object({
  flow_id: z.string().min(1),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(8_000),
  based_on_revision_id: z.string().optional(),
  nodes: z.array(OrchestrationNodeInputSchema).min(1).max(40),
}).strict();

export type OrchestrationNodeInput = z.infer<typeof OrchestrationNodeInputSchema>;
export type SubmitOrchestrationPlanInput = z.infer<typeof SubmitOrchestrationPlanSchema>;

export type OrchestrationLintIssue = {
  code: string;
  severity: "block";
  message: string;
  node_id?: string;
};

function hasCycle(nodes: OrchestrationNodeInput[]) {
  const dependencies = new Map(nodes.map((node) => [node.node_id, node.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ((dependencies.get(nodeId) ?? []).some(visit)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.node_id));
}

/**
 * The backend validates identity and DAG integrity only. Whether collaboration
 * deserves an orchestration plan remains Leader protocol, not a platform state machine.
 */
export function lintOrchestrationPlan(
  input: SubmitOrchestrationPlanInput,
  availableAgentDefinitionIds: Set<string>,
): OrchestrationLintIssue[] {
  const issues: OrchestrationLintIssue[] = [];
  const ids = new Set(input.nodes.map((node) => node.node_id));
  for (const node of input.nodes) {
    if (!availableAgentDefinitionIds.has(node.recommended_agent_definition_id)) {
      issues.push({
        code: "AGENT_DEFINITION_UNAVAILABLE",
        severity: "block",
        message: `AgentDefinition 不可用：${node.recommended_agent_definition_id}`,
        node_id: node.node_id,
      });
    }
    for (const dependency of node.depends_on) {
      if (!ids.has(dependency)) issues.push({
        code: "DEPENDENCY_NOT_FOUND",
        severity: "block",
        message: `依赖节点不存在：${dependency}`,
        node_id: node.node_id,
      });
      if (dependency === node.node_id) issues.push({
        code: "SELF_DEPENDENCY",
        severity: "block",
        message: "编排节点不能依赖自身",
        node_id: node.node_id,
      });
    }
  }
  if (hasCycle(input.nodes)) issues.push({ code: "DAG_CYCLE", severity: "block", message: "编排依赖存在循环" });
  return issues;
}

export function diffOrchestrationNodes(previous: OrchestrationNodeInput[], next: OrchestrationNodeInput[]) {
  const before = new Map(previous.map((node) => [node.node_id, node]));
  const after = new Map(next.map((node) => [node.node_id, node]));
  const added = next.filter((node) => !before.has(node.node_id)).map((node) => node.node_id);
  const removed = previous.filter((node) => !after.has(node.node_id)).map((node) => node.node_id);
  const modified = next.flatMap((node) => {
    const old = before.get(node.node_id);
    if (!old) return [];
    const fields = ([
      "recommended_agent_definition_id",
      "title",
      "description",
      "depends_on",
      "acceptance_criteria",
      "metadata",
    ] as const).filter((field) => JSON.stringify(old[field]) !== JSON.stringify(node[field]));
    return fields.length > 0 ? [{ node_id: node.node_id, fields }] : [];
  });
  return { added, removed, modified };
}

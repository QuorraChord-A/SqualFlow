import { z } from "zod";

export const PlanNodeInputSchema = z.object({
  node_id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/u),
  expert_id: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(8_000),
  depends_on: z.array(z.string().min(1)).default([]).describe("前置计划节点 node_id；Verify 必须位于实现任务之后，CodeReview 必须位于 Verify 之后"),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  risk_tags: z.array(z.string().min(1)).default([]),
  side_effects: z.array(z.string().min(1)).default([]),
  resource_keys: z.array(z.string().min(1)).default([]),
}).strict();

export const SubmitOrchestrationPlanSchema = z.object({
  flow_id: z.string().min(1),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(8_000),
  work_kind: z.enum(["research", "change", "bugfix", "database", "protocol", "security", "destructive"]).default("change"),
  risk_level: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  based_on_revision_id: z.string().optional(),
  source_feedback_message_id: z.string().optional(),
  nodes: z.array(PlanNodeInputSchema).min(1).max(40),
}).strict();

export type PlanNodeInput = z.infer<typeof PlanNodeInputSchema>;
export type SubmitOrchestrationPlanInput = z.infer<typeof SubmitOrchestrationPlanSchema>;

export const DeclarativeOrchestrationRuleSchema = z.object({
  when: z.object({
    work_kinds: z.array(SubmitOrchestrationPlanSchema.shape.work_kind).optional(),
    risk_levels: z.array(SubmitOrchestrationPlanSchema.shape.risk_level).optional(),
    risk_tags: z.array(z.string().min(1)).optional(),
    minimum_nodes: z.number().int().positive().optional(),
  }).default({}),
  require_expert_ids: z.array(z.string().min(1)).min(1),
}).strict();
export type DeclarativeOrchestrationRule = z.infer<typeof DeclarativeOrchestrationRuleSchema>;

export type PlanLintIssue = {
  code: string;
  severity: "block" | "warn" | "info";
  message: string;
  node_id?: string;
};

function hasRole(nodes: PlanNodeInput[], token: string) {
  return nodes.some((node) => node.expert_id.toLowerCase().includes(token));
}

function hasRoleToken(node: PlanNodeInput, token: string) {
  return node.expert_id.toLowerCase().includes(token);
}

function dependsTransitively(nodes: PlanNodeInput[], nodeId: string, dependencyId: string) {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const visited = new Set<string>();
  const walk = (currentId: string): boolean => {
    if (currentId === dependencyId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    return (byId.get(currentId)?.depends_on ?? []).some(walk);
  };
  return (byId.get(nodeId)?.depends_on ?? []).some(walk);
}

function detectCycle(nodes: PlanNodeInput[]) {
  const dependencies = new Map(nodes.map((node) => [node.node_id, node.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    if ((dependencies.get(nodeId) ?? []).some(walk)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => walk(node.node_id));
}

export function lintOrchestrationPlan(input: SubmitOrchestrationPlanInput, availableExpertIds: Set<string>): PlanLintIssue[] {
  const issues: PlanLintIssue[] = [];
  const ids = new Set(input.nodes.map((node) => node.node_id));
  for (const node of input.nodes) {
    if (!availableExpertIds.has(node.expert_id)) {
      issues.push({ code: "EXPERT_UNAVAILABLE", severity: "block", message: `Expert 不可用：${node.expert_id}`, node_id: node.node_id });
    }
    for (const dependency of node.depends_on) {
      if (!ids.has(dependency)) issues.push({ code: "DEPENDENCY_NOT_FOUND", severity: "block", message: `依赖节点不存在：${dependency}`, node_id: node.node_id });
      if (dependency === node.node_id) issues.push({ code: "SELF_DEPENDENCY", severity: "block", message: "任务不能依赖自身", node_id: node.node_id });
    }
  }
  if (detectCycle(input.nodes)) issues.push({ code: "DAG_CYCLE", severity: "block", message: "计划依赖存在循环" });

  const requiresVerify = ["bugfix", "database", "protocol", "security", "destructive"].includes(input.work_kind)
    || ["high", "critical"].includes(input.risk_level);
  if (requiresVerify && !hasRole(input.nodes, "verify")) {
    issues.push({ code: "VERIFY_REQUIRED", severity: "block", message: "该工作类型必须包含独立 Verify 任务" });
  }
  const requiresReview = ["protocol", "security", "destructive"].includes(input.work_kind)
    || ["high", "critical"].includes(input.risk_level);
  if (requiresReview && !hasRole(input.nodes, "review")) {
    issues.push({ code: "REVIEW_REQUIRED", severity: "block", message: "高风险或契约变更必须包含 CodeReview 任务" });
  }

  const verifyNodes = input.nodes.filter((node) => hasRoleToken(node, "verify"));
  const reviewNodes = input.nodes.filter((node) => hasRoleToken(node, "review"));
  const implementationNodes = input.nodes.filter((node) => (
    !hasRoleToken(node, "research")
    && !hasRoleToken(node, "verify")
    && !hasRoleToken(node, "review")
  ));
  if (implementationNodes.length > 0 && verifyNodes.length > 0) {
    for (const implementation of implementationNodes) {
      if (!verifyNodes.some((verify) => dependsTransitively(input.nodes, verify.node_id, implementation.node_id))) {
        issues.push({
          code: "IMPLEMENTATION_NOT_VERIFIED",
          severity: "block",
          message: `实现任务「${implementation.title}」必须进入 Verify 依赖链`,
          node_id: implementation.node_id,
        });
      }
    }
    for (const verify of verifyNodes) {
      if (!implementationNodes.some((implementation) => dependsTransitively(input.nodes, verify.node_id, implementation.node_id))) {
        issues.push({
          code: "VERIFY_WITHOUT_IMPLEMENTATION_DEPENDENCY",
          severity: "block",
          message: `Verify 任务「${verify.title}」必须依赖对应实现任务`,
          node_id: verify.node_id,
        });
      }
    }
  }
  if (verifyNodes.length > 0 && reviewNodes.length > 0) {
    for (const verify of verifyNodes) {
      if (!reviewNodes.some((review) => dependsTransitively(input.nodes, review.node_id, verify.node_id))) {
        issues.push({
          code: "VERIFY_NOT_REVIEWED",
          severity: "block",
          message: `Verify 任务「${verify.title}」必须进入 CodeReview 依赖链`,
          node_id: verify.node_id,
        });
      }
    }
    for (const review of reviewNodes) {
      if (!verifyNodes.some((verify) => dependsTransitively(input.nodes, review.node_id, verify.node_id))) {
        issues.push({
          code: "REVIEW_WITHOUT_VERIFY_DEPENDENCY",
          severity: "block",
          message: `CodeReview 任务「${review.title}」必须依赖对应 Verify 任务`,
          node_id: review.node_id,
        });
      }
    }
  }

  for (let leftIndex = 0; leftIndex < input.nodes.length; leftIndex += 1) {
    const left = input.nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < input.nodes.length; rightIndex += 1) {
      const right = input.nodes[rightIndex]!;
      const sharesResource = left.resource_keys.some((key) => right.resource_keys.includes(key));
      if (!sharesResource) continue;
      const ordered = left.depends_on.includes(right.node_id) || right.depends_on.includes(left.node_id);
      if (!ordered) {
        issues.push({
          code: "RESOURCE_CONFLICT",
          severity: "block",
          message: `任务「${left.title}」与「${right.title}」共享写资源，必须建立依赖或合并`,
        });
      }
    }
  }
  return issues;
}

export function evaluateDeclarativeRules(
  input: SubmitOrchestrationPlanInput,
  rules: Array<{ id: string; name: string; severity: "block" | "warn" | "info"; rule: DeclarativeOrchestrationRule }>,
): PlanLintIssue[] {
  return rules.flatMap(({ id, name, severity, rule }) => {
    const when = rule.when;
    if (when.work_kinds?.length && !when.work_kinds.includes(input.work_kind)) return [];
    if (when.risk_levels?.length && !when.risk_levels.includes(input.risk_level)) return [];
    if (when.risk_tags?.length && !input.nodes.some((node) => node.risk_tags.some((tag) => when.risk_tags!.includes(tag)))) return [];
    if (when.minimum_nodes && input.nodes.length < when.minimum_nodes) return [];
    const missing = rule.require_expert_ids.filter((expertId) => !input.nodes.some((node) => node.expert_id === expertId));
    return missing.length > 0 ? [{ code: `CUSTOM_RULE:${id}`, severity, message: `规则「${name}」要求包含 Expert：${missing.join("、")}` }] : [];
  });
}

type ComparableNode = Pick<PlanNodeInput, "node_id" | "expert_id" | "title" | "description" | "depends_on" | "acceptance_criteria" | "risk_tags" | "side_effects" | "resource_keys">;

export function diffPlanNodes(previous: ComparableNode[], next: ComparableNode[]) {
  const before = new Map(previous.map((node) => [node.node_id, node]));
  const after = new Map(next.map((node) => [node.node_id, node]));
  const added = next.filter((node) => !before.has(node.node_id)).map((node) => node.node_id);
  const removed = previous.filter((node) => !after.has(node.node_id)).map((node) => node.node_id);
  const modified = next.flatMap((node) => {
    const old = before.get(node.node_id);
    if (!old) return [];
    const fields = (["expert_id", "title", "description", "depends_on", "acceptance_criteria", "risk_tags", "side_effects", "resource_keys"] as const)
      .filter((field) => JSON.stringify(old[field]) !== JSON.stringify(node[field]));
    return fields.length > 0 ? [{ node_id: node.node_id, fields }] : [];
  });
  return { added, removed, modified };
}

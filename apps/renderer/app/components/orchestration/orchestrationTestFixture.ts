import type { OrchestrationPlanView } from "../../types/orchestration";

export const orchestrationPlanFixture: OrchestrationPlanView = {
  plan_id: "plan-1", flow_id: "flow-1", work_run_id: "turn-1",
  revision: { plan_revision_id: "revision-1", revision_number: 1, status: "pending_approval", title: "成员邀请编排计划", objective: "完成成员邀请", work_kind: "change", risk_level: "medium", lint: [], diff: {}, created_at: "2026-07-11T00:00:00Z" },
  approval: { plan_approval_id: "approval-1", status: "pending", created_at: "2026-07-11T00:00:00Z" },
  run: null,
  nodes: [
    { plan_node_id: "node-1", stable_key: "research", expert_id: "exp-research", title: "确认权限边界", description: "确认认证与权限边界。", depends_on_node_ids: [], acceptance_criteria: ["边界明确"], risk_tags: [], side_effects: [], resource_keys: [], task: null },
    { plan_node_id: "node-2", stable_key: "coder", expert_id: "exp-coder", title: "实现邀请 API", description: "实现成员邀请接口。", depends_on_node_ids: ["node-1"], acceptance_criteria: ["接口通过测试"], risk_tags: [], side_effects: [], resource_keys: ["backend"], task: null },
  ],
  feedback: [],
};

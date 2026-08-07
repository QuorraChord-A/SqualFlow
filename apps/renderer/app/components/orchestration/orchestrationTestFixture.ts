import type { OrchestrationPlanView } from "../../types/orchestration";

export const orchestrationPlanFixture: OrchestrationPlanView = {
  orchestration_plan_id: "plan-1", flow_id: "flow-1",
  revision: { orchestration_revision_id: "revision-1", revision_number: 1, parent_revision_id: null, status: "waiting_approval", approval_mode_snapshot: "approval_required", title: "成员邀请编排计划", objective: "完成成员邀请", source_agent_run_id: "run-1", created_at: "2026-07-11T00:00:00Z", activated_at: null },
  approval: { orchestration_approval_id: "approval-1", status: "pending", created_at: "2026-07-11T00:00:00Z" },
  nodes: [
    { orchestration_node_id: "node-1", stable_key: "research", recommended_agent_definition_id: "exp-research", title: "确认权限边界", description: "确认认证与权限边界。", depends_on_node_ids: [], acceptance_criteria: ["边界明确"], metadata: {}, task: null },
    { orchestration_node_id: "node-2", stable_key: "coder", recommended_agent_definition_id: "exp-coder", title: "实现邀请 API", description: "实现成员邀请接口。", depends_on_node_ids: ["node-1"], acceptance_criteria: ["接口通过测试"], metadata: { resource_keys: ["backend"] }, task: null },
  ],
  feedback: [],
};

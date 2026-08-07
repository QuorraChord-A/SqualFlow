import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SquadFlow } from "../types";
import type { PlanCardState, DecisionRequestCardData } from "../hooks/useDashboardData";
import FlowItem from "./FlowItem";
import DecisionRequestCard from "./DecisionRequestCard";
import PendingPlanCard from "./workbench/PendingPlanCard";
import PendingDecisionRequestDock from "./workbench/PendingDecisionRequestDock";
import ChangeSetDiffPanel from "./workbench/ChangeSetDiffPanel";
import OrchestrationPlanCard from "./orchestration/OrchestrationPlanCard";
import { orchestrationPlanFixture } from "./orchestration/orchestrationTestFixture";

const wsSend = vi.hoisted(() => vi.fn());
vi.mock("../lib/ws", () => ({ wsClient: { send: wsSend } }));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const baseFlow: SquadFlow = {
  id: "flow-1",
  name: "Supervisor Flow",
  type: "full",
  status: "idle",
  project_id: "project-1",
  created_at: "2026-08-07T00:00:00.000Z",
  updated_at: "2026-08-07T00:00:00.000Z",
};

afterEach(() => wsSend.mockReset());

describe("Supervisor UI projections", () => {
  it("renders yellow, green, blue, then gray Flow indicators by fixed priority", () => {
    const { rerender } = render(<FlowItem flow={{ ...baseFlow, indicator: "pending", has_active_agent_run: true, has_unread_output: true }} selected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId("flow-pending-spinner")).toBeInTheDocument();

    rerender(<FlowItem flow={{ ...baseFlow, indicator: "active", has_active_agent_run: true, has_unread_output: true }} selected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId("flow-streaming-spinner")).toBeInTheDocument();

    rerender(<FlowItem flow={{ ...baseFlow, indicator: "unread", has_unread_output: true }} selected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-blue-500");

    rerender(<FlowItem flow={{ ...baseFlow, indicator: "idle" }} selected={false} onClick={vi.fn()} />);
    expect(screen.getByTestId("flow-status-dot")).toHaveClass("bg-muted-foreground/45");
  });

  it("labels the sidebar action as collaboration interruption only while a Run is active", async () => {
    const user = userEvent.setup();
    const onAbortFlow = vi.fn();
    const { rerender } = render(<FlowItem flow={{ ...baseFlow, status: "active", has_active_agent_run: true }} selected onClick={vi.fn()} onAbortFlow={onAbortFlow} />);
    await user.click(screen.getByRole("button", { name: "Supervisor Flow 操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "中断协作" }));
    expect(onAbortFlow).toHaveBeenCalledWith(expect.objectContaining({ id: "flow-1" }));

    rerender(<FlowItem flow={{ ...baseFlow, status: "idle", has_active_agent_run: false }} selected onClick={vi.fn()} onAbortFlow={onAbortFlow} />);
    await user.click(screen.getByRole("button", { name: "Supervisor Flow 操作" }));
    expect(screen.queryByRole("menuitem", { name: "中断协作" })).not.toBeInTheDocument();
  });

  it("uses exact Plan approval ids and presents revision feedback", async () => {
    const user = userEvent.setup();
    const card: PlanCardState = {
      plan_approval_id: "plan-approval-2",
      plan_revision_id: "plan-revision-2",
      revision_number: 2,
      status: "pending",
      title: "启动恢复计划",
      overview: "按项目隔离配置",
      content: "# 计划",
      created_at: "2026-08-07T00:00:00.000Z",
    };
    render(<PendingPlanCard flowId="flow-1" card={card} />);
    expect(screen.getByText("计划 · 启动恢复计划")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "计划修改意见" }), "请增加重启恢复验证");
    await user.click(screen.getByRole("button", { name: "要求修改" }));
    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "plan:resolve",
      plan_approval_id: "plan-approval-2",
      resolution: "rejected",
      feedback: "请增加重启恢复验证",
    }));
  });

  it("always shows orchestration cards but hides approval in automatic mode", () => {
    const onApprove = vi.fn();
    const onOpenPlan = vi.fn();
    const { rerender } = render(<OrchestrationPlanCard plan={orchestrationPlanFixture} onApprove={onApprove} onOpenPlan={onOpenPlan} />);
    expect(screen.getByRole("button", { name: /批准编排/ })).toBeInTheDocument();

    rerender(<OrchestrationPlanCard
      plan={{
        ...orchestrationPlanFixture,
        revision: { ...orchestrationPlanFixture.revision, status: "active", approval_mode_snapshot: "automatic" },
        approval: null,
      }}
      onApprove={onApprove}
      onOpenPlan={onOpenPlan}
    />);
    expect(screen.getByTestId("orchestration-plan-card-revision-1")).toBeInTheDocument();
    expect(screen.getByText("自动执行")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准编排/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看完整编排" })).toBeInTheDocument();
  });

  it("separates tool approval from clarification and exposes only Leader stop in the dock", async () => {
    const user = userEvent.setup();
    const permission: DecisionRequestCardData = {
      decision_request_id: "permission-1",
      request_type: "tool_permission",
      questions: [],
      status: "pending",
      tool_name: "Bash",
      tool_arguments: { command: "npm test" },
    };
    const { rerender } = render(<DecisionRequestCard flowId="flow-1" card={permission} />);
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "decision_request:reject",
      decision_request_id: "permission-1",
    }));

    const onStop = vi.fn();
    rerender(<PendingDecisionRequestDock flowId="flow-1" cards={[permission]} onStopCurrentTurn={onStop} />);
    expect(screen.getByText("仅停止当前 Leader 运行")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expert/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停止当前 Leader" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("renders finalized ChangeSet history, partial attribution notes, and cumulative totals", async () => {
    render(<ChangeSetDiffPanel changeSet={{
      change_set_id: "changes-1",
      title: "配置恢复修复",
      status: "finalized",
      root_path: "/project",
      baseline_kind: "filesystem",
      baseline_ref: null,
      partial_reason: "并发 Shell 共享文件已排除",
      review: { verdict: "approved" },
      created_at: "2026-08-07T00:00:00.000Z",
      finalized_at: "2026-08-07T01:00:00.000Z",
      abandoned_at: null,
      updated_at: "2026-08-07T01:00:00.000Z",
      files: [
        { path: "src/a.ts", status: "modified", patch: "+const a = 1", additions: 1, deletions: 0, attribution_kind: "direct" },
        { path: "src/b.ts", status: "deleted", patch: "-old", additions: 0, deletions: 1, attribution_kind: "shell_snapshot" },
      ],
    }} />);
    expect(screen.getByText("配置恢复修复")).toBeInTheDocument();
    expect(screen.getByText("并发 Shell 共享文件已排除")).toBeInTheDocument();
    expect(screen.getAllByText("+1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("change-set-file-card")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "隐藏变更文件列表" }));
    await waitFor(() => expect(screen.queryByText("变更文件")).not.toBeInTheDocument());
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import OrchestrationPlanCard from "./OrchestrationPlanCard";
import { orchestrationPlanFixture } from "./orchestrationTestFixture";

vi.mock("./OrchestrationPlanGraph", () => ({ default: () => <button type="button">确认权限边界</button> }));

it("只有查看完整计划会打开右侧计划面板", async () => {
  const user = userEvent.setup();
  const onOpenPlan = vi.fn();
  render(<OrchestrationPlanCard plan={orchestrationPlanFixture} onOpenPlan={onOpenPlan} onApprove={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "确认权限边界" }));
  expect(onOpenPlan).not.toHaveBeenCalled();
  const open = screen.getByRole("button", { name: "查看完整计划" });
  expect(open.querySelector("svg")).toBeNull();
  await user.click(open);
  expect(onOpenPlan).toHaveBeenCalledWith(orchestrationPlanFixture);
});

it("中断执行后显示计划已取消", () => {
  render(<OrchestrationPlanCard
    plan={{ ...orchestrationPlanFixture, approval: { ...orchestrationPlanFixture.approval!, status: "approved" }, run: { plan_run_id: "run-1", status: "cancelled" } }}
    onOpenPlan={vi.fn()}
    onApprove={vi.fn()}
  />);

  expect(screen.getAllByText("已取消")).toHaveLength(2);
});

it("运行中收到计划反馈后显示反馈暂停", () => {
  render(<OrchestrationPlanCard
    plan={{ ...orchestrationPlanFixture, approval: { ...orchestrationPlanFixture.approval!, status: "approved" }, run: { plan_run_id: "run-1", status: "paused_for_feedback" } }}
    onOpenPlan={vi.fn()}
    onApprove={vi.fn()}
  />);

  expect(screen.getAllByText("反馈暂停")).toHaveLength(2);
});

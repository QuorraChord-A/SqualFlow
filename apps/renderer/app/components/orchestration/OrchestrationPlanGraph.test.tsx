import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import OrchestrationPlanGraph, { buildPlanEdges } from "./OrchestrationPlanGraph";
import { orchestrationPlanFixture } from "./orchestrationTestFixture";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

it("Chat 图节点只显示锚定任务提示窗", async () => {
  render(<div style={{ width: 700, height: 300 }}><OrchestrationPlanGraph compact planNodes={orchestrationPlanFixture.nodes} /></div>);
  fireEvent.click(screen.getByText("确认权限边界").closest("button")!);
  expect(await screen.findByText("确认认证与权限边界。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查看完整计划" })).not.toBeInTheDocument();
});

it("待审批计划沿用原型的动画依赖连线与状态点", () => {
  const { container } = render(<div style={{ width: 700, height: 300 }}><OrchestrationPlanGraph compact planNodes={orchestrationPlanFixture.nodes} /></div>);

  expect(buildPlanEdges(orchestrationPlanFixture.nodes)).toEqual([
    expect.objectContaining({ source: "node-1", target: "node-2", animated: true, type: "smoothstep" }),
  ]);
  expect(container.querySelectorAll(".bg-status-pending")).toHaveLength(orchestrationPlanFixture.nodes.length);
  expect(screen.getByTestId("chat-orchestration-graph")).toHaveClass("orchestration-plan-graph", "is-compact");
});

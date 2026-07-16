import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import OrchestrationPlanPanel from "./OrchestrationPlanPanel";
import { orchestrationPlanFixture } from "./orchestrationTestFixture";
import { usePlanFeedbackStore } from "../../stores/usePlanFeedbackStore";

vi.mock("./OrchestrationPlanGraph", () => ({ default: () => <div>计划拓扑图</div> }));

beforeEach(() => {
  usePlanFeedbackStore.setState({ activeFlowId: "flow-1", drafts: [], draftsByFlow: { "flow-1": [] } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [orchestrationPlanFixture] }));
});

it("双击任务行添加结构化评论而不是编辑字段", async () => {
  const user = userEvent.setup();
  render(<OrchestrationPlanPanel flowId="flow-1" initialPlan={orchestrationPlanFixture} onApprove={vi.fn()} />);
  fireEvent.doubleClick(screen.getByText("实现邀请 API").closest("article")!);
  const input = await screen.findByPlaceholderText("说明希望 Leader 如何调整…");
  await user.type(input, "请补充重复邀请的处理");
  await user.click(screen.getByRole("button", { name: "确认到输入框" }));
  expect(usePlanFeedbackStore.getState().drafts).toEqual([expect.objectContaining({ planNodeId: "node-2", comment: "请补充重复邀请的处理" })]);
  expect(screen.queryByText("保存为新版本")).not.toBeInTheDocument();
});

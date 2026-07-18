import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it("将任务卡片中选中的文字和评论一起添加到输入框", async () => {
  const user = userEvent.setup();
  render(<OrchestrationPlanPanel flowId="flow-1" initialPlan={orchestrationPlanFixture} onApprove={vi.fn()} />);
  const selectedText = screen.getByText(orchestrationPlanFixture.nodes[1]!.description);
  const range = document.createRange();
  range.selectNodeContents(selectedText);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(selectedText);
  expect(await screen.findByText(`“${orchestrationPlanFixture.nodes[1]!.description}”`)).toBeVisible();
  const input = await screen.findByPlaceholderText("说明希望 Leader 如何调整…");
  await user.type(input, "请补充重复邀请的处理");
  await user.click(screen.getByRole("button", { name: "确认到输入框" }));
  expect(usePlanFeedbackStore.getState().drafts).toEqual([expect.objectContaining({
    planNodeId: "node-2",
    comment: `引用：\n“${orchestrationPlanFixture.nodes[1]!.description}”\n\n评论：\n请补充重复邀请的处理`,
  })]);
  expect(screen.queryByText("保存为新版本")).not.toBeInTheDocument();
});

it("历史版本只显示同一份计划并在新版本到达时自动切换", async () => {
  const revisionTwo = {
    ...orchestrationPlanFixture,
    revision: {
      ...orchestrationPlanFixture.revision,
      plan_revision_id: "revision-2",
      revision_number: 2,
      title: "成员邀请编排计划 v2",
    },
  };
  const anotherPlan = {
    ...orchestrationPlanFixture,
    plan_id: "plan-another",
    revision: {
      ...orchestrationPlanFixture.revision,
      plan_revision_id: "revision-another-v1",
      revision_number: 1,
      title: "另一份计划 v1",
    },
  };
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => [orchestrationPlanFixture, revisionTwo, anotherPlan],
  } as Response);

  const { rerender } = render(
    <OrchestrationPlanPanel flowId="flow-1" initialPlan={orchestrationPlanFixture} onApprove={vi.fn()} />,
  );
  const versionBar = await screen.findByText("历史版本").then((label) => label.parentElement!);
  await waitFor(() => expect(within(versionBar).getAllByRole("button")).toHaveLength(2));
  expect(within(versionBar).getAllByRole("button").map((button) => button.textContent)).toEqual(["v1", "v2"]);
  expect(screen.queryByText("另一份计划 v1")).not.toBeInTheDocument();

  rerender(<OrchestrationPlanPanel flowId="flow-1" initialPlan={revisionTwo} onApprove={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "成员邀请编排计划 v2" })).toBeVisible();
});

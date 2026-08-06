import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionCardData } from "../../hooks/useDashboardData";
import PendingDecisionDock from "./PendingDecisionDock";

vi.mock("../../lib/ws", () => ({
  wsClient: {
    send: vi.fn(),
  },
}));

const pendingCard: DecisionCardData = {
  card_id: "card-1",
  card_type: "approval",
  status: "pending",
  questions: [
    {
      header: "推进方式",
      question: "下一步怎么做？",
      multiSelect: false,
      options: [
        { label: "进入开发", description: "开始 coding run" },
        { label: "继续讨论", description: "留在 chat" },
      ],
    },
  ],
};

const resolvedCard: DecisionCardData = {
  card_id: "card-2",
  card_type: "approval",
  status: "resolved",
  answers: { 推进方式: "继续讨论" },
  questions: [
    {
      header: "已解决",
      question: "这张卡不应显示",
      multiSelect: false,
      options: [
        { label: "继续讨论", description: "留在 chat" },
      ],
    },
  ],
};

const multiQuestionCard: DecisionCardData = {
  card_id: "card-3",
  card_type: "generic",
  status: "pending",
  questions: [
    {
      header: "第一组",
      question: "第一组问题？",
      multiSelect: false,
      options: [{ label: "第一项", description: "第一项描述" }],
    },
    {
      header: "第二组",
      question: "第二组问题？",
      multiSelect: false,
      options: [{ label: "第二项", description: "第二项描述" }],
    },
  ],
};

describe("PendingDecisionDock", () => {
  beforeEach(async () => {
    const { wsClient } = await import("../../lib/ws");
    vi.mocked(wsClient.send).mockClear();
  });

  it("renders only pending cards and not resolved cards", () => {
    render(<PendingDecisionDock flowId="flow-1" cards={[pendingCard, resolvedCard]} />);

    expect(screen.getByTestId("pending-decision-dock")).toBeInTheDocument();
    expect(screen.getByTestId("decision-card-pending")).toBeInTheDocument();
    expect(screen.getByText(/下一步怎么做？/)).toBeInTheDocument();
    expect(screen.queryByText("这张卡不应显示")).not.toBeInTheDocument();
  });

  it("renders pending cards when flowId is an empty string", () => {
    render(<PendingDecisionDock flowId="" cards={[pendingCard]} />);

    expect(screen.getByTestId("pending-decision-dock")).toBeInTheDocument();
  });

  it("returns null when flowId is null", () => {
    render(<PendingDecisionDock flowId={null} cards={[pendingCard]} />);

    expect(screen.queryByTestId("pending-decision-dock")).not.toBeInTheDocument();
  });

  it("sends the decision only after submitting a selected option", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    render(<PendingDecisionDock flowId="flow-1" cards={[pendingCard]} />);

    await user.click(screen.getByRole("button", { name: /进入开发/ }));

    expect(wsClient.send).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(wsClient.send).toHaveBeenCalledTimes(1);
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision",
      flow_id: "flow-1",
      card_id: "card-1",
      answers: { 推进方式: "进入开发" },
      client_action_id: expect.any(String),
    }));
  });

  it("renders multiple questions in one scrollable card body", () => {
    render(<PendingDecisionDock flowId="flow-1" cards={[multiQuestionCard]} />);

    const scrollArea = screen.getByTestId("decision-card-scroll-area");

    expect(within(scrollArea).getByText(/第一组问题/)).toBeInTheDocument();
    expect(within(scrollArea).getByText(/第二组问题/)).toBeInTheDocument();
  });

  it("keeps stopping the current Leader reply separate from cancelling the current card", async () => {
    const user = userEvent.setup();
    const onStopCurrentTurn = vi.fn();
    const { wsClient } = await import("../../lib/ws");

    render(
      <PendingDecisionDock
        flowId="flow-1"
        cards={[pendingCard]}
        onStopCurrentTurn={onStopCurrentTurn}
      />,
    );

    await user.click(screen.getByRole("button", { name: "停止本轮" }));

    expect(onStopCurrentTurn).toHaveBeenCalledOnce();
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision_cancel",
    }));
    expect(screen.getByText("停止整个本轮及其待执行工作")).toBeVisible();
  });
});

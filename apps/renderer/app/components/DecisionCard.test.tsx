import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DecisionCard from "./DecisionCard";
import { wsClient } from "../lib/ws";

describe("DecisionCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a cancelled clarification as terminal and non-interactive", () => {
    render(
      <DecisionCard
        flowId="flow-1"
        card={{
          card_id: "dc-1",
          card_type: "clarification",
          status: "cancelled",
          questions: [{
            header: "页面",
            question: "选择页面类型",
            multiSelect: false,
            options: [
              { label: "HTML", description: "静态页面" },
              { label: "React", description: "React 页面" },
            ],
          }],
        }}
      />,
    );

    expect(screen.getByTestId("decision-card-cancelled")).toHaveTextContent("已取消");
    expect(screen.queryByRole("button", { name: "提交回答" })).not.toBeInTheDocument();
  });

  it("sends the explicit decision-cancel protocol action", () => {
    const send = vi.spyOn(wsClient, "send").mockImplementation(() => undefined);
    render(<DecisionCard flowId="flow-1" card={{
      card_id: "dc-1",
      card_type: "clarification",
      status: "pending",
      questions: [{ header: "页面", question: "选择页面类型", multiSelect: false, options: [] }],
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision_cancel",
      flow_id: "flow-1",
      card_id: "dc-1",
      client_action_id: expect.any(String),
    }));
  });

  it("submits every selected option for a multi-select question", () => {
    const send = vi.spyOn(wsClient, "send").mockImplementation(() => undefined);
    render(
      <DecisionCard
        flowId="flow-1"
        card={{
          card_id: "dc-multi",
          card_type: "clarification",
          status: "pending",
          questions: [{
            header: "范围",
            question: "选择修改范围",
            multiSelect: true,
            options: [
              { label: "前端", description: "修改 UI" },
              { label: "后端", description: "修改 API" },
            ],
          }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /前端/ }));
    fireEvent.click(screen.getByRole("button", { name: /后端/ }));

    expect(send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision",
      answers: { 范围: ["前端", "后端"] },
    }));
  });

  it("renders a dedicated permission card and sends an explicit command denial", () => {
    const send = vi.spyOn(wsClient, "send").mockImplementation(() => undefined);
    render(
      <DecisionCard
        flowId="flow-1"
        card={{
          card_id: "dc-permission",
          card_type: "permission_confirmation",
          status: "pending",
          questions: [{
            header: "permission",
            question: "Agent 请求执行风险操作。rm -rf a-very-long-directory-name-that-must-wrap 是否允许？",
            multiSelect: false,
            options: [
              { label: "允许本次操作", description: "仅允许一次" },
              { label: "拒绝当前命令", description: "当前 Task 继续，完全相同的命令不再询问。" },
            ],
          }],
        }}
      />,
    );

    expect(screen.queryByPlaceholderText("其他 / 自定义")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
    expect(screen.getByText(/拒绝只阻止当前命令/)).toHaveTextContent(
      "当前 Task 继续，完全相同的命令不再询问。",
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝当前命令" }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision",
      flow_id: "flow-1",
      card_id: "dc-permission",
      answers: { permission: "拒绝当前命令" },
      client_action_id: expect.stringMatching(/^deny-/),
    }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:decision_cancel" }));
  });

  it("shows the backend-provided Leader UserTurn scope on a permission card", () => {
    render(
      <DecisionCard
        flowId="flow-1"
        card={{
          card_id: "dc-leader-permission",
          card_type: "permission_confirmation",
          status: "pending",
          questions: [{
            header: "permission",
            question: "Leader 请求执行风险操作。",
            multiSelect: false,
            options: [
              { label: "允许本次操作", description: "仅允许一次" },
              { label: "拒绝当前命令", description: "当前 UserTurn 继续，完全相同的命令不再询问。" },
            ],
          }],
        }}
      />,
    );

    const scopeCopy = screen.getByText(/拒绝只阻止当前命令/);
    expect(scopeCopy).toHaveTextContent("当前 UserTurn 继续，完全相同的命令不再询问。");
    expect(scopeCopy).not.toHaveTextContent("当前 Task");
  });

  it("distinguishes an explicit permission denial from a generic cancellation", () => {
    render(
      <DecisionCard
        flowId="flow-1"
        card={{
          card_id: "dc-permission-denied",
          card_type: "permission_confirmation",
          status: "cancelled",
          answers: { permission: "拒绝当前命令" },
          questions: [],
        }}
      />,
    );

    expect(screen.getByTestId("decision-card-cancelled")).toHaveTextContent("已拒绝当前命令");
  });
});

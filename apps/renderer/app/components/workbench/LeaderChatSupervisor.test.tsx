import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  sendAgentRunCancel: vi.fn(),
  onMessage: vi.fn(() => () => undefined),
}));

vi.mock("../../lib/ws", () => ({
  wsClient: {
    send: mocks.send,
    sendAgentRunCancel: mocks.sendAgentRunCancel,
    onMessage: mocks.onMessage,
    genLogId: () => "log-1",
  },
}));

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:8001",
  fetchFlowContextState: vi.fn(async () => ({ context_usage: null, context_compactions: [] })),
  compactFlowContext: vi.fn(async () => null),
}));

vi.mock("../../hooks/useNativeContextSlashMenu", () => ({
  useNativeContextSlashMenu: () => ({ skills: [], mcpServers: [], loading: false, error: null }),
}));

vi.mock("../LeaderModelSelector", async () => {
  const React = await import("react");
  return {
    default: (props: { onConfiguredChange?: (configured: boolean) => void }) => {
      React.useEffect(() => props.onConfiguredChange?.(true), []);
      return <div aria-label="Leader 模型">测试模型</div>;
    },
  };
});

import LeaderChatPanel from "./LeaderChatPanel";
import { useRunningMessageQueueStore } from "../../stores/useRunningMessageQueueStore";

describe("LeaderChat Supervisor controls", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.sendAgentRunCancel.mockReset();
    mocks.onMessage.mockClear();
    useRunningMessageQueueStore.setState({ queuesByFlow: {} });
  });

  it("the round stop control cancels only the active Leader AgentRun", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <LeaderChatPanel
        flowId="flow-1"
        leaderAgentRunId="leader-run-1"
        activeLeaderAgentRunId="leader-run-1"
        flowStatus="active"
        decisionRequests={[]}
        planCards={{}}
        composerOnly
      />,
    );
    await user.click(await screen.findByRole("button", { name: "停止本轮" }));
    expect(mocks.sendAgentRunCancel).toHaveBeenCalledWith("flow-1", "leader-run-1", expect.stringMatching(/^leader-cancel-/));
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:interrupt" }));

    rerender(
      <LeaderChatPanel
        flowId="flow-1"
        leaderAgentRunId="leader-run-1"
        activeLeaderAgentRunId={null}
        flowStatus="active"
        decisionRequests={[]}
        planCards={{}}
        composerOnly
      />,
    );
    expect(screen.queryByRole("button", { name: "停止本轮" })).not.toBeInTheDocument();
  });

  it("Guide is a queue action independent of the current Plan mode", async () => {
    const user = userEvent.setup();
    useRunningMessageQueueStore.setState({
      queuesByFlow: {
        "flow-1": [{ id: "queue-1", content: "先停一下，我想改功能", revision: 1 }],
      },
    });
    render(
      <LeaderChatPanel
        flowId="flow-1"
        leaderAgentRunId="leader-run-1"
        activeLeaderAgentRunId="leader-run-1"
        flowStatus="active"
        behaviorMode="plan"
        riskMode="auto_edit"
        decisionRequests={[]}
        planCards={{}}
        composerOnly
      />,
    );
    await user.click(await screen.findByRole("button", { name: "引导消息 1" }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_guide",
      flow_id: "flow-1",
      queue_id: "queue-1",
    }));
    const payload = mocks.send.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("behavior_mode");
    expect(payload).not.toHaveProperty("plan_requested");
  });
});

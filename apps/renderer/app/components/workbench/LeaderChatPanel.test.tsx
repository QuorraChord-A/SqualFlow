import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import type { DecisionCardData } from "../../hooks/useDashboardData";
import type { WsInMessage } from "../../lib/ws";
import { useBrowserSelectionStore } from "../../stores/useBrowserSelectionStore";
import { useFlowStore } from "../../stores/useFlowStore";
import { resetRunningMessageQueueStoreForTests, useRunningMessageQueueStore } from "../../stores/useRunningMessageQueueStore";
import { usePlanFeedbackStore } from "../../stores/usePlanFeedbackStore";
import LeaderChatPanel from "./LeaderChatPanel";

const wsMessageHandlers = vi.hoisted(() => new Set<(message: WsInMessage) => void>());
const leaderSelectorMock = vi.hoisted(() => ({
  configured: true,
  onUpdatingChange: undefined as ((updating: boolean) => void) | undefined,
}));
const apiMocks = vi.hoisted(() => ({
  compactFlowContext: vi.fn(),
  fetchAgentRuntimeConfig: vi.fn(),
  fetchFlowContextState: vi.fn(),
  updateAgentRuntimeConfig: vi.fn(),
  updateAgentRuntimeRole: vi.fn(),
  updateFlowLeaderRuntimeSelection: vi.fn(),
}));

vi.mock("../LeaderModelSelector", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({
      onConfiguredChange,
      onUpdatingChange,
    }: {
      onConfiguredChange?: (configured: boolean) => void;
      onUpdatingChange?: (updating: boolean) => void;
    }) => {
      React.useEffect(() => {
        onConfiguredChange?.(leaderSelectorMock.configured);
      }, [onConfiguredChange]);
      React.useEffect(() => {
        leaderSelectorMock.onUpdatingChange = onUpdatingChange;
        return () => {
          leaderSelectorMock.onUpdatingChange = undefined;
        };
      }, [onUpdatingChange]);
      return <button type="button">qwen3.6-plus-2026-04-02</button>;
    },
  };
});

vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: Object.assign(
    ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    {
      Content: ({ children, className }: { children: React.ReactNode; className?: string }) => (
        <div className={className}>{children}</div>
      ),
    },
  ),
  useStickToBottomContext: () => ({
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
}));

vi.mock("../../lib/ws", () => ({
  wsClient: {
    genLogId: vi.fn(() => "log-1"),
    send: vi.fn(),
    sendUserTurnCancel: vi.fn(),
    sendSessionGet: vi.fn(),
    sendRunSpec: vi.fn(),
    sendFlowGuide: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    onMessage: vi.fn((handler: (message: WsInMessage) => void) => {
      wsMessageHandlers.add(handler);
      return () => wsMessageHandlers.delete(handler);
    }),
  },
}));

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:8001",
  compactFlowContext: apiMocks.compactFlowContext,
  fetchAgentRuntimeConfig: apiMocks.fetchAgentRuntimeConfig,
  fetchFlowContextState: apiMocks.fetchFlowContextState,
  updateAgentRuntimeConfig: apiMocks.updateAgentRuntimeConfig,
  updateAgentRuntimeRole: apiMocks.updateAgentRuntimeRole,
  updateFlowLeaderRuntimeSelection: apiMocks.updateFlowLeaderRuntimeSelection,
}));

const runtimeSnapshot = {
  roles: [
    { role: "leader", enabled: true, configId: "default-agent-sdk" },
    { role: "coder", enabled: true, configId: "default-agent-sdk" },
    { role: "research", enabled: true, configId: "default-agent-sdk" },
    { role: "verify", enabled: true, configId: "default-agent-sdk" },
    { role: "codereview", enabled: true, configId: "default-agent-sdk" },
  ],
  configs: [
    {
      id: "default-agent-sdk",
      fileName: "default-agent-sdk.json",
      name: "百炼",
      sdk: "claudecode",
      authMode: "apiKey",
      baseUrl: "",
      apiKey: "",
      models: [{ id: "qwen-plus", name: "qwen3.6-plus-2026-04-02" }],
    },
  ],
};

const pendingCard: DecisionCardData = {
  card_id: "card-1",
  card_type: "approval",
  status: "pending",
  questions: [
    {
      header: "下一步",
      question: "是否继续？",
      multiSelect: false,
      options: [{ label: "继续", description: "进入下一步" }],
    },
  ],
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof LeaderChatPanel>> = {}) {
  return render(
    <LeaderChatPanel
      flowId="flow-1"
      leaderAgentSessionId="leader-session-1"
      flowStatus="ready"
      decisionCardStatuses={{}}
      decisionCardAnswers={{}}
      decisionCards={[]}
      specCards={{}}
      onOpenSpecPreview={vi.fn()}
      {...overrides}
    />,
  );
}

describe("LeaderChatPanel", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    const { wsClient } = await import("../../lib/ws");
    vi.mocked(wsClient.genLogId).mockClear();
    vi.mocked(wsClient.send).mockClear();
    vi.mocked(wsClient.sendUserTurnCancel).mockClear();
    vi.mocked(wsClient.sendSessionGet).mockClear();
    vi.mocked(wsClient.sendRunSpec).mockClear();
    vi.mocked(wsClient.sendFlowGuide).mockClear();
    vi.mocked(wsClient.onMessage).mockClear();
    leaderSelectorMock.configured = true;
    leaderSelectorMock.onUpdatingChange = undefined;
    apiMocks.compactFlowContext.mockReset();
    apiMocks.compactFlowContext.mockResolvedValue(null);
    apiMocks.fetchAgentRuntimeConfig.mockReset();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.fetchFlowContextState.mockReset();
    apiMocks.fetchFlowContextState.mockResolvedValue({ context_usage: { leader: null, experts: [] }, context_compactions: [] });
    apiMocks.updateAgentRuntimeConfig.mockReset();
    apiMocks.updateAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot.configs[0]);
    apiMocks.updateAgentRuntimeRole.mockReset();
    apiMocks.updateAgentRuntimeRole.mockResolvedValue({ role: "leader", enabled: true, configId: "default-agent-sdk" });
    apiMocks.updateFlowLeaderRuntimeSelection.mockReset();
    apiMocks.updateFlowLeaderRuntimeSelection.mockResolvedValue({
      leader_runtime_config_id: "default-agent-sdk",
      leader_runtime_model_id: "qwen-plus",
    });
    wsMessageHandlers.clear();
    window.localStorage.clear();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "default-agent-sdk",
        leader_runtime_model_id: "qwen-plus",
      }],
      selectedFlowId: "flow-1",
      selectedFlow: null,
      pendingApproval: false,
    });
    resetRunningMessageQueueStoreForTests();
    useBrowserSelectionStore.setState({ activeFlowId: null, elements: [], elementsByFlow: {} });
    usePlanFeedbackStore.setState({ activeFlowId: null, drafts: [], draftsByFlow: {} });
  });

  it("sends user input as a leader flow message without an expert session", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel();

    await user.type(screen.getByPlaceholderText("输入消息..."), "hello leader");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(wsClient.genLogId).toHaveBeenCalledTimes(1);
    expect(wsClient.send).toHaveBeenCalledWith({
      type: "flow:message",
      flow_id: "flow-1",
      content: "hello leader",
      client_message_id: expect.stringMatching(/^msg-user-/),
      log_id: "log-1",
    });
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ agent_session_id: expect.anything() }));
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ flow_expert_id: expect.anything() }));
  });

  it("keeps the drafted message unsent until the runtime selection finishes saving", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel();
    const input = screen.getByPlaceholderText("输入消息...");
    await user.type(input, "switch then send");
    await waitFor(() => expect(leaderSelectorMock.onUpdatingChange).toBeTypeOf("function"));

    act(() => leaderSelectorMock.onUpdatingChange?.(true));
    await user.keyboard("{Enter}");

    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:message" }));
    expect(input).toHaveValue("switch then send");

    act(() => leaderSelectorMock.onUpdatingChange?.(false));
    await user.keyboard("{Enter}");

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      content: "switch then send",
    }));
  });

  it("sends plan feedback with an empty content field and only a display-layer summary", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    usePlanFeedbackStore.setState({
      activeFlowId: "flow-1",
      drafts: [{
        id: "pf-1",
        flowId: "flow-1",
        planRevisionId: "revision-1",
        planNodeId: "node-1",
        markerNumber: 1,
        targetLabel: "任务一",
        comment: "补充验收条件",
      }],
      draftsByFlow: {},
    });

    renderPanel();
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      flow_id: "flow-1",
      content: "",
      plan_feedback: [{
        id: "pf-1",
        plan_revision_id: "revision-1",
        plan_node_id: "node-1",
        marker_number: 1,
        comment: "补充验收条件",
      }],
    }));
    expect(await screen.findByText("计划评论（1 条）")).toBeInTheDocument();
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("对编排计划添加了"),
    }));
  });

  it("sends a browser comment even when no screenshot payload is available", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    useBrowserSelectionStore.setState({
      activeFlowId: "flow-1",
      elements: [{
        tagName: "button",
        text: "高级",
        selector: 'button[data-state="]:ready"] · span',
        role: "button",
        ariaLabel: '高级 ]: \"设置\"',
        title: "",
        url: "https://example.test/settings",
        pageTitle: "Settings",
        markerNumber: 1,
        comment: "截图失败也要保留",
        viewport: { width: 1200, height: 800 },
        rect: { x: 0, y: 0, width: 100, height: 30 },
        attributes: { id: "", className: "", href: "", name: "", type: "button" },
        id: "browser-no-image",
        addedAt: 1,
      }],
      elementsByFlow: {},
    });

    renderPanel();
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      content: "",
      attachments: [{
        id: "browser-no-image",
        kind: "browser_comment",
        marker_number: 1,
        comment: "截图失败也要保留",
        label: '高级 ]: \"设置\"',
        page_url: "https://example.test/settings",
        selector: 'button[data-state="]:ready"] · span',
      }],
    }));
  });

  it("blocks sending when the flow leader model is not configured", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    leaderSelectorMock.configured = false;

    renderPanel();

    const input = await screen.findByPlaceholderText("请先选择模型");
    expect(input).toBeDisabled();
    await user.keyboard("{Enter}");

    expect(wsClient.send).not.toHaveBeenCalled();
  });

  it("renders a compact floating composer that reuses leader send behavior", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel({ composerOnly: true, composerVariant: "compactFloating" });

    expect(screen.queryByTestId("leader-chat-transcript-shell")).not.toBeInTheDocument();
    const composer = screen.getByTestId("leader-chat-composer");
    expect(composer.className).toContain("pointer-events-auto");

    await user.type(screen.getByPlaceholderText("输入消息..."), "compact hello");
    await user.keyboard("{Enter}");

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      flow_id: "flow-1",
      content: "compact hello",
    }));
  });

  it("turns the composer send button into stop while a user turn is running", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };

    renderPanel({ userTurns: [activeTurn] });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "不要继续了");
    await user.click(screen.getByRole("button", { name: "停止本轮" }));

    expect(wsClient.sendUserTurnCancel).toHaveBeenCalledWith("flow-1", activeTurn.id);
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
    }));
    expect(screen.queryByTestId("running-message-queue")).not.toBeInTheDocument();
  });

  it("lets an authoritative idle Flow clear a stale active turn and queueing composer", async () => {
    const user = userEvent.setup();
    const staleActiveTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 10_000,
      completedAt: null,
    };

    function Harness() {
      const [flowStatus, setFlowStatus] = useState("active");
      return (
        <>
          <button type="button" onClick={() => setFlowStatus("idle")}>settle flow</button>
          <LeaderChatPanel
            flowId="flow-1"
            leaderAgentSessionId="leader-session-1"
            flowStatus={flowStatus}
            decisionCardStatuses={{}}
            decisionCardAnswers={{}}
            decisionCards={[]}
            specCards={{}}
            userTurns={[staleActiveTurn]}
            onOpenSpecPreview={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);

    expect(screen.getByRole("button", { name: "停止本轮" })).toBeVisible();
    expect(screen.getByPlaceholderText("继续输入以排队后续修改")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "settle flow" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "停止本轮" })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("输入消息开始新的讨论...")).toBeVisible();
    });
    expect(useRunningMessageQueueStore.getState().knownRunningByFlow["flow-1"]).toBe(false);
  });

  it("sends directly instead of showing stop or queueing while a user turn waits for input", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    renderPanel({
      userTurns: [{
        id: "turn-flow-1",
        triggerMessageId: "msg-user-1",
        status: "waiting_user",
        startedAt: "2026-06-29T07:00:00.000Z",
        activeStartedAt: null,
        activeDurationMs: 1200,
        completedAt: null,
      }],
    });

    expect(screen.queryByRole("button", { name: "停止本轮" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入消息...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("输入消息..."), "继续执行");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      flow_id: "flow-1",
      content: "继续执行",
    }));
    expect(screen.queryByTestId("running-message-queue")).not.toBeInTheDocument();
  });

  it("offers stopping the active user turn beside a pending permission decision", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 1200,
      completedAt: null,
    };

    renderPanel({
      userTurns: [activeTurn],
      decisionCards: [pendingCard],
      decisionCardStatuses: { [pendingCard.card_id]: "pending" },
    });

    expect(screen.getByTestId("pending-decision-dock")).toBeVisible();
    expect(screen.queryByRole("button", { name: "发送消息" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "停止本轮" }));

    expect(wsClient.sendUserTurnCancel).toHaveBeenCalledWith("flow-1", activeTurn.id);
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:decision_cancel",
    }));
  });

  it("preserves the controlled composer draft when switching composer variants", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [draft, setDraft] = useState("打开 AGENTS.md");
      const [compact, setCompact] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setCompact(true)}>compact</button>
          <LeaderChatPanel
            flowId="flow-1"
            leaderAgentSessionId="leader-session-1"
            flowStatus="ready"
            decisionCardStatuses={{}}
            decisionCardAnswers={{}}
            decisionCards={[]}
            specCards={{}}
            onOpenSpecPreview={vi.fn()}
            composerOnly={compact}
            composerVariant={compact ? "compactFloating" : "default"}
            composerValue={draft}
            onComposerValueChange={setDraft}
          />
        </>
      );
    }

    render(<Harness />);

    expect(screen.getByPlaceholderText("输入消息...")).toHaveValue("打开 AGENTS.md");
    await user.type(screen.getByPlaceholderText("输入消息..."), " 继续");
    expect(screen.getByPlaceholderText("输入消息...")).toHaveValue("打开 AGENTS.md 继续");

    await user.click(screen.getByRole("button", { name: "compact" }));

    expect(screen.getByPlaceholderText("输入消息...")).toHaveValue("打开 AGENTS.md 继续");
  });

  it("preserves controlled composer drafts by flow", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [flowId, setFlowId] = useState("flow-1");
      const [drafts, setDrafts] = useState<Record<string, string>>({});
      return (
        <>
          <button type="button" onClick={() => setFlowId("flow-1")}>flow 1</button>
          <button type="button" onClick={() => setFlowId("flow-2")}>flow 2</button>
          <LeaderChatPanel
            flowId={flowId}
            leaderAgentSessionId="leader-session-1"
            flowStatus="ready"
            decisionCardStatuses={{}}
            decisionCardAnswers={{}}
            decisionCards={[]}
            specCards={{}}
            onOpenSpecPreview={vi.fn()}
            composerValue={drafts[flowId] ?? ""}
            onComposerValueChange={(value) => setDrafts((current) => ({ ...current, [flowId]: value }))}
          />
        </>
      );
    }

    render(<Harness />);

    await user.type(screen.getByPlaceholderText("输入消息..."), "flow one draft");
    await user.click(screen.getByRole("button", { name: "flow 2" }));
    expect(screen.getByPlaceholderText("输入消息...")).toHaveValue("");

    await user.type(screen.getByPlaceholderText("输入消息..."), "flow two draft");
    await user.click(screen.getByRole("button", { name: "flow 1" }));

    expect(screen.getByPlaceholderText("输入消息...")).toHaveValue("flow one draft");
  });

  it("does not send while IME composition is confirming text", async () => {
    const { wsClient } = await import("../../lib/ws");

    renderPanel();

    const input = screen.getByPlaceholderText("输入消息...");
    fireEvent.change(input, { target: { value: "他" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });

    expect(wsClient.send).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });

    expect(wsClient.send).not.toHaveBeenCalled();
  });

  it("queues editable follow-up messages while the leader is running", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { stream_epoch: "legacy", cursor: 0, messages: [] },
        } as unknown as WsInMessage);
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { cursor: 1, event: { type: "turn-started", messageId: "msg-assistant-1" } },
        } as unknown as WsInMessage);
      }
    });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "排队消息 1");
    await user.keyboard("{Enter}");

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_add",
      flow_id: "flow-1",
      content: "排队消息 1",
    }));
    expect(screen.getByText("拖拽排序")).toBeInTheDocument();
    expect(screen.getByText("排队消息 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑消息 1" }));

    const composerInput = screen.getByPlaceholderText("继续输入以排队后续修改");
    expect(screen.queryByTestId("running-message-queue")).not.toBeInTheDocument();
    expect(composerInput).toHaveValue("排队消息 1");

    await user.clear(composerInput);
    await user.type(composerInput, "排队消息 33");
    await user.keyboard("{Enter}");

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_add",
      flow_id: "flow-1",
      content: "排队消息 33",
    }));
    expect(screen.getByText("排队消息 33")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "引导消息 1" }));

    const queueGuideCall = vi.mocked(wsClient.send).mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "flow:queue_guide");
    expect(queueGuideCall).toEqual(expect.objectContaining({
      type: "flow:queue_guide",
      flow_id: "flow-1",
      client_message_id: expect.stringMatching(/^msg-user-guided-/),
      log_id: "log-1",
    }));
    expect(screen.getByTestId("running-message-queue")).toBeInTheDocument();
    expect(await screen.findByTestId("chat-message-user")).toHaveTextContent("排队消息 33");
    expect(screen.getByText("已引导对话")).toBeInTheDocument();

    const clientMessageId = String(queueGuideCall?.client_message_id ?? "msg-user-guided-test");
    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 2,
            event: {
              type: "message-added",
              message: {
                id: clientMessageId,
                role: "user",
                parts: [{ type: "text", text: "排队消息 33" }],
                content: "排队消息 33",
                metadata: { localMessageKind: "running-guide", guideStatusLabel: "已引导对话" },
              },
            },
          },
        } as unknown as WsInMessage);
      }
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:guide_ack",
          flow_id: "flow-1",
          log_id: "log-1",
          data: {
            accepted: true,
            message_id: clientMessageId,
            client_message_id: clientMessageId,
            leader_agent_session_id: "leader-session-1",
          },
        });
      }
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:queue_state",
          flow_id: "flow-1",
          log_id: "log-1",
          data: { messages: [] },
        } as unknown as WsInMessage);
      }
    });
    expect(screen.queryByTestId("running-message-queue")).not.toBeInTheDocument();

    expect(screen.getByTestId("chat-message-user")).toHaveTextContent("排队消息 33");
    expect(screen.getByText("已引导对话")).toBeInTheDocument();

    expect(screen.getByTestId("chat-message-user")).toHaveTextContent("排队消息 33");
    expect(screen.queryByTestId("chat-message-guide")).not.toBeInTheDocument();
    expect(screen.getByText("已引导对话")).toBeInTheDocument();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { cursor: 3, event: { type: "text-start", messageId: "msg-assistant-1:guide-1", id: "text-after-guide" } },
        } as unknown as WsInMessage);
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { cursor: 4, event: { type: "text-delta", messageId: "msg-assistant-1:guide-1", id: "text-after-guide", delta: "已收到引导" } },
        } as unknown as WsInMessage);
      }
    });

    await waitFor(() => expect(screen.getByText("已引导对话")).toBeInTheDocument());
  });

  it("keeps queued running messages across flow switches", async () => {
    const user = userEvent.setup();
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    const flowTwoTurn = {
      ...activeTurn,
      id: "turn-flow-2",
      triggerMessageId: "msg-user-2",
    };

    const { rerender } = renderPanel({ userTurns: [activeTurn] });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "切换后还在的排队消息");
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("running-message-queue")).toHaveTextContent("切换后还在的排队消息");

    rerender(
      <LeaderChatPanel
        flowId="flow-2"
        leaderAgentSessionId="leader-session-2"
        flowStatus="ready"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        userTurns={[flowTwoTurn]}
        onOpenSpecPreview={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("切换后还在的排队消息")).not.toBeInTheDocument();
    });

    rerender(
      <LeaderChatPanel
        flowId="flow-1"
        leaderAgentSessionId="leader-session-1"
        flowStatus="ready"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        userTurns={[activeTurn]}
        onOpenSpecPreview={vi.fn()}
      />,
    );

    expect(await screen.findByText("切换后还在的排队消息")).toBeInTheDocument();
    expect(screen.getByTestId("running-message-queue")).toHaveTextContent("切换后还在的排队消息");
  });

  it("keeps browser comment metadata out of queued text and sends it as attachments", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    useBrowserSelectionStore.getState().addElement({
      tagName: "button",
      text: "打开任务：你好",
      selector: "button#task-open",
      role: "button",
      ariaLabel: "打开任务：你好",
      title: "",
      url: "http://localhost:3000/",
      pageTitle: "SquadFlow - AI Squad Orchestration",
      markerNumber: 1,
      screenshotDataUrl: "data:image/png;base64,abc",
      viewport: { width: 1327, height: 963 },
      rect: { x: 66, y: 34, width: 151, height: 40 },
      attributes: { id: "task-open", className: "", href: "", name: "", type: "button" },
    });

    renderPanel({ userTurns: [activeTurn] });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "那这也发出来吧");
    await user.keyboard("{Enter}");

    const queue = screen.getByTestId("running-message-queue");
    expect(queue).toHaveTextContent("那这也发出来吧");
    expect(queue).not.toHaveTextContent("Browser comments");
    expect(queue).not.toHaveTextContent("打开任务：你好");
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_add",
      flow_id: "flow-1",
      content: "那这也发出来吧",
      attachments: expect.arrayContaining([
        expect.objectContaining({
          kind: "browser_comment",
          selector: "button#task-open",
          marker_number: 1,
        }),
      ]),
    }));

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "user_turn:event",
          flow_id: "flow-1",
          data: {
            user_turn_id: "turn-flow-1",
            trigger_message_id: "msg-user-1",
            status: "completed",
            started_at: "2026-06-29T07:00:00.000Z",
            active_started_at: null,
            active_duration_ms: 10_000,
            completed_at: "2026-06-29T07:00:10.000Z",
          },
        } as unknown as WsInMessage);
      }
    });

    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_dispatch",
      flow_id: "flow-1",
    }));

    const queueAddCall = vi.mocked(wsClient.send).mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "flow:queue_add");
    const queuedMessageId = String(queueAddCall?.client_message_id ?? "msg-user-browser-queued");
    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { stream_epoch: "legacy", cursor: 0, messages: [] },
        } as unknown as WsInMessage);
        handler({
          type: "flow:queue_state",
          flow_id: "flow-1",
          data: { messages: [] },
        } as unknown as WsInMessage);
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 1,
            event: {
              type: "message-added",
              message: {
                id: queuedMessageId,
                role: "user",
                parts: [{ type: "text", text: "那这也发出来吧" }],
                content: "那这也发出来吧",
                metadata: queueAddCall?.client_payload,
              },
            },
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByTestId("chat-message-user")).toHaveTextContent("那这也发出来吧");
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
  });

  it("keeps the browser page when sending a browser comment message directly", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const reset = vi.fn().mockResolvedValue(null);
    const stopElementPicker = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      reset,
      stopElementPicker,
      setConfirmedMarkers: vi.fn().mockResolvedValue(null),
    });
    useBrowserSelectionStore.getState().addElement({
      tagName: "button",
      text: "需要解释的按钮",
      selector: "button#explain",
      role: "button",
      ariaLabel: "需要解释的按钮",
      title: "",
      url: "https://www.google.com/search?q=1",
      pageTitle: "Google",
      markerNumber: 1,
      comment: "解释这个",
      screenshotDataUrl: "data:image/png;base64,abc",
      viewport: { width: 1327, height: 963 },
      rect: { x: 66, y: 34, width: 151, height: 40 },
      attributes: { id: "explain", className: "", href: "", name: "", type: "button" },
    });

    renderPanel();

    await user.type(screen.getByPlaceholderText("输入消息..."), "这个呢");
    await user.keyboard("{Enter}");

    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      flow_id: "flow-1",
      content: "这个呢",
      attachments: expect.arrayContaining([
        expect.objectContaining({ kind: "browser_comment", selector: "button#explain" }),
      ]),
    }));
    expect(reset).not.toHaveBeenCalled();
    expect(stopElementPicker).toHaveBeenCalledOnce();
    expect(await screen.findByText("这个呢")).toBeInTheDocument();
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
  });

  it("keeps the browser page while queued and restores browser annotations when editing the queued message", async () => {
    const user = userEvent.setup();
    const reset = vi.fn().mockResolvedValue(null);
    const stopElementPicker = vi.fn().mockResolvedValue(null);
    const setConfirmedMarkers = vi.fn().mockResolvedValue(null);
    const startElementPicker = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      reset,
      stopElementPicker,
      setConfirmedMarkers,
      startElementPicker,
      getState: vi.fn().mockResolvedValue({
        url: "https://www.google.com/search?q=1",
        title: "Google",
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        pickerActive: false,
      }),
    });
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active" as const,
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    useBrowserSelectionStore.getState().addElement({
      tagName: "button",
      text: "当前目录按钮",
      selector: "button#current-directory",
      role: "button",
      ariaLabel: "当前目录按钮",
      title: "",
      url: "https://www.google.com/search?q=1",
      pageTitle: "Google",
      markerNumber: 1,
      comment: "查这个",
      screenshotDataUrl: "data:image/png;base64,abc",
      viewport: { width: 1327, height: 963 },
      rect: { x: 66, y: 34, width: 151, height: 40 },
      attributes: { id: "current-directory", className: "", href: "", name: "", type: "button" },
    });

    renderPanel({ userTurns: [activeTurn] });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "排队带注释");
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("running-message-queue")).toHaveTextContent("排队带注释");
    expect(reset).not.toHaveBeenCalled();
    expect(stopElementPicker).toHaveBeenCalledOnce();
    expect(screen.queryByText("1 条注释")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑消息 1" }));

    expect(screen.queryByTestId("running-message-queue")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("排队带注释");
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
    await waitFor(() => expect(setConfirmedMarkers).toHaveBeenLastCalledWith([
      {
        markerNumber: 1,
        selector: "button#current-directory",
        rect: { x: 66, y: 34, width: 151, height: 40 },
      },
    ]));
    expect(startElementPicker).toHaveBeenLastCalledWith(2);
  });

  it("keeps queued annotations across pages and mixes new current-page annotations after editing", async () => {
    const user = userEvent.setup();
    const setConfirmedMarkers = vi.fn().mockResolvedValue(null);
    const startElementPicker = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      reset: vi.fn().mockResolvedValue(null),
      stopElementPicker: vi.fn().mockResolvedValue(null),
      setConfirmedMarkers,
      startElementPicker,
      getState: vi.fn().mockResolvedValue({
        url: "https://page-b.test/",
        title: "Page B",
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        pickerActive: false,
      }),
    });
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active" as const,
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    useBrowserSelectionStore.getState().addElement({
      tagName: "button",
      text: "页面 A 按钮",
      selector: "button#page-a",
      role: "button",
      ariaLabel: "页面 A 按钮",
      title: "",
      url: "https://page-a.test/",
      pageTitle: "Page A",
      markerNumber: 1,
      comment: "页面 A 注释",
      screenshotDataUrl: "data:image/png;base64,a",
      viewport: { width: 1200, height: 800 },
      rect: { x: 10, y: 20, width: 120, height: 36 },
      attributes: { id: "page-a", className: "", href: "", name: "", type: "button" },
    });

    renderPanel({ userTurns: [activeTurn] });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "跨页排队消息");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("running-message-queue")).toHaveTextContent("跨页排队消息");
    expect(screen.queryByText("1 条注释")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑消息 1" }));

    expect(screen.getByRole("textbox")).toHaveValue("跨页排队消息");
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
    await waitFor(() => expect(setConfirmedMarkers).toHaveBeenLastCalledWith([]));
    expect(startElementPicker).toHaveBeenLastCalledWith(2);

    act(() => {
      useBrowserSelectionStore.getState().addElement({
        tagName: "button",
        text: "页面 B 按钮",
        selector: "button#page-b",
        role: "button",
        ariaLabel: "页面 B 按钮",
        title: "",
        url: "https://page-b.test/",
        pageTitle: "Page B",
        markerNumber: 2,
        comment: "页面 B 注释",
        screenshotDataUrl: "data:image/png;base64,b",
        viewport: { width: 1200, height: 800 },
        rect: { x: 30, y: 40, width: 140, height: 38 },
        attributes: { id: "page-b", className: "", href: "", name: "", type: "button" },
      });
    });

    expect(screen.getByText("2 条注释")).toBeInTheDocument();
    await waitFor(() => expect(setConfirmedMarkers).toHaveBeenLastCalledWith([
      {
        markerNumber: 2,
        selector: "button#page-b",
        rect: { x: 30, y: 40, width: 140, height: 38 },
      },
    ]));

    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const queued = useRunningMessageQueueStore.getState().queuesByFlow["flow-1"] ?? [];
      expect(queued).toHaveLength(1);
      expect(queued[0]?.browserElementAttachments?.map((item) => item.url)).toEqual([
        "https://page-a.test/",
        "https://page-b.test/",
      ]);
    });
  });

  it("guides queued browser comment messages without exposing hidden browser templates or resetting the browser", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const reset = vi.fn().mockResolvedValue(null);
    const stopElementPicker = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("squadflowDesktopBrowser", {
      isAvailable: true,
      reset,
      stopElementPicker,
      setConfirmedMarkers: vi.fn().mockResolvedValue(null),
    });
    const activeTurn = {
      id: "turn-flow-1",
      triggerMessageId: "msg-user-1",
      status: "active" as const,
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    useBrowserSelectionStore.getState().addElement({
      tagName: "div",
      text: "你能输出图片吗",
      selector: "div.user-message",
      role: "",
      ariaLabel: "",
      title: "",
      url: "http://localhost:3000/",
      pageTitle: "SquadFlow",
      markerNumber: 1,
      comment: "你能输出图片吗",
      screenshotDataUrl: "data:image/png;base64,abc",
      viewport: { width: 1008, height: 769 },
      rect: { x: 828, y: 192, width: 120, height: 32 },
      attributes: { id: "", className: "", href: "", name: "", type: "" },
    });

    renderPanel({ userTurns: [activeTurn] });
    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 1,
            event: { type: "turn-started", messageId: "msg-assistant-1", startedAt: "2026-06-29T07:00:00.000Z" },
          },
        } as unknown as WsInMessage);
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: { cursor: 2, event: { type: "text-start", messageId: "msg-assistant-1", id: "text-before-guide" } },
        } as unknown as WsInMessage);
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 3,
            event: { type: "text-delta", messageId: "msg-assistant-1", id: "text-before-guide", delta: "引导前输出" },
          },
        } as unknown as WsInMessage);
      }
    });

    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "这个是什么");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "引导消息 1" }));

    const call = vi.mocked(wsClient.send).mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "flow:queue_guide");
    const queuedCall = vi.mocked(wsClient.send).mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "flow:queue_add");
    expect(call).toEqual(expect.objectContaining({
      type: "flow:queue_guide",
      flow_id: "flow-1",
      client_message_id: expect.stringMatching(/^msg-user-guided-/),
      log_id: "log-1",
    }));
    expect(reset).not.toHaveBeenCalled();
    expect(stopElementPicker).toHaveBeenCalled();
    expect(await screen.findByTestId("chat-message-user")).toHaveTextContent("这个是什么");
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
    expect(screen.getByText("已引导对话")).toBeInTheDocument();
    expect(screen.queryByText(/Browser comments/i)).not.toBeInTheDocument();

    const guideContent = "这个是什么";
    const clientMessageId = String(call?.client_message_id ?? "msg-user-guided-test");
    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 4,
            event: {
              type: "message-added",
              message: {
                id: clientMessageId,
                role: "user",
                parts: [{ type: "text", text: guideContent }],
                content: guideContent,
                metadata: {
                  localMessageKind: "running-guide",
                  guideStatusLabel: "已引导对话",
                  browserElementAttachments: queuedCall?.client_payload?.browserElementAttachments,
                  imageAttachments: queuedCall?.client_payload?.imageAttachments,
                },
              },
            },
          },
        } as unknown as WsInMessage);
      }
    });

    expect(screen.getByTestId("chat-message-user")).toHaveTextContent("这个是什么");
    expect(screen.getByText("1 条注释")).toBeInTheDocument();
    expect(screen.getByText("已引导对话")).toBeInTheDocument();
    expect(screen.queryByText(/Browser comments/i)).not.toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();

  });

  it("shares queued running messages between full and compact composer instances", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const activeTurn = {
      id: "turn-shared",
      triggerMessageId: "msg-user-shared",
      status: "active",
      startedAt: "2026-06-29T07:00:00.000Z",
      activeStartedAt: "2026-06-29T07:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };

    render(
      <>
        <div data-testid="full-panel">
          <LeaderChatPanel
            flowId="flow-1"
            leaderAgentSessionId="leader-session-1"
            flowStatus="ready"
            decisionCardStatuses={{}}
            decisionCardAnswers={{}}
            decisionCards={[]}
            specCards={{}}
            userTurns={[activeTurn]}
            onOpenSpecPreview={vi.fn()}
          />
        </div>
        <div data-testid="compact-panel">
          <LeaderChatPanel
            flowId="flow-1"
            leaderAgentSessionId="leader-session-1"
            flowStatus="ready"
            decisionCardStatuses={{}}
            decisionCardAnswers={{}}
            decisionCards={[]}
            specCards={{}}
            userTurns={[activeTurn]}
            onOpenSpecPreview={vi.fn()}
            composerOnly
            composerVariant="compactFloating"
          />
        </div>
      </>,
    );

    await user.type(within(screen.getByTestId("compact-panel")).getByPlaceholderText("继续输入以排队后续修改"), "共享排队消息");
    await user.keyboard("{Enter}");

    expect(within(screen.getByTestId("compact-panel")).getByText("共享排队消息")).toBeInTheDocument();
    expect(within(screen.getByTestId("full-panel")).getByText("共享排队消息")).toBeInTheDocument();
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:queue_add",
      flow_id: "flow-1",
      content: "共享排队消息",
    }));
  });

  it("shows the submitted user message and chat loading state immediately", async () => {
    const user = userEvent.setup();

    renderPanel();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: { stream_epoch: "legacy", cursor: 0, messages: [] },
        });
      }
    });

    await user.type(screen.getByPlaceholderText("输入消息..."), "你好");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(screen.getByText("正在思考")).toBeInTheDocument();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
        data: {
          stream_epoch: "legacy",
          cursor: 0,
            messages: [
              {
                id: "msg-user-remote",
                role: "user",
                parts: [{ type: "text", text: "你好" }],
                content: "你好",
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(screen.getByText("正在思考")).toBeInTheDocument();
  });

  it("keeps the first submitted user message when a new flow gets its leader session later", async () => {
    const user = userEvent.setup();

    const { rerender } = renderPanel({ leaderAgentSessionId: null, flowStatus: "idle" });

    await user.type(screen.getByPlaceholderText("输入消息开始新的讨论..."), "新 flow 首条消息");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("新 flow 首条消息")).toBeInTheDocument();

    rerender(
      <LeaderChatPanel
        flowId="flow-1"
        leaderAgentSessionId="leader-session-1"
        flowStatus="idle"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        onOpenSpecPreview={vi.fn()}
      />,
    );

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: { cursor: 0, messages: [] },
        } as unknown as WsInMessage);
      }
    });

    expect(screen.getByText("新 flow 首条消息")).toBeInTheDocument();
  });

  it("renders execution modes beside the plus menu and orchestration approval inside it", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.queryByRole("button", { name: "提交方案" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Spec$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行模式：自动编辑" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    expect(screen.getByRole("button", { name: "编排审批设置，当前：需要批准" })).toHaveTextContent("需要批准");
  });

  it("keeps existing Flow settings isolated from new-Flow defaults and other Flows", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("squadflow-new-task-mode-defaults", JSON.stringify({
      riskMode: "full_access",
      planApproval: "off",
    }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderPanel({ riskMode: "auto_edit", planApproval: "on" });
    expect(screen.getByRole("button", { name: "执行模式：自动编辑" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行模式：自动编辑" }));
    await user.click(screen.getByRole("button", { name: /完全访问：/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8001/api/flows/flow-1",
      expect.objectContaining({ body: JSON.stringify({ risk_mode: "full_access" }) }),
    ));
    expect(screen.getByRole("button", { name: "执行模式：完全访问" })).toHaveClass(
      "text-orange-700",
      "hover:text-orange-700",
      "dark:text-orange-500",
      "dark:hover:text-orange-500",
    );
    expect(JSON.parse(window.localStorage.getItem("squadflow-new-task-mode-defaults") ?? "{}")).toEqual({
      riskMode: "full_access",
      planApproval: "off",
    });

    rerender(
      <LeaderChatPanel
        flowId="flow-2"
        leaderAgentSessionId="leader-session-2"
        flowStatus="ready"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        riskMode="auto_edit"
        planApproval="on"
        onOpenSpecPreview={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "执行模式：自动编辑" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    expect(screen.getByRole("button", { name: "编排审批设置，当前：需要批准" })).toBeInTheDocument();
  });

  it("does not let a failed settings request from the previous Flow roll back the current Flow", async () => {
    const user = userEvent.setup();
    let resolvePreviousRequest!: (response: { ok: boolean }) => void;
    const previousRequest = new Promise<{ ok: boolean }>((resolve) => {
      resolvePreviousRequest = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => previousRequest));

    const { rerender } = renderPanel({ flowId: "flow-1", riskMode: "auto_edit" });
    await user.click(screen.getByRole("button", { name: "执行模式：自动编辑" }));
    await user.click(screen.getByRole("button", { name: /完全访问：/ }));
    expect(screen.getByRole("button", { name: "执行模式：完全访问" })).toBeDisabled();

    rerender(
      <LeaderChatPanel
        flowId="flow-2"
        leaderAgentSessionId="leader-session-2"
        flowStatus="ready"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        riskMode="full_access"
        planApproval="off"
        onOpenSpecPreview={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "执行模式：完全访问" })).toBeEnabled();

    await act(async () => {
      resolvePreviousRequest({ ok: false });
      await previousRequest;
    });

    expect(screen.getByRole("button", { name: "执行模式：完全访问" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "添加消息选项" }));
    expect(screen.getByRole("button", { name: "编排审批设置，当前：自动执行" })).toBeInTheDocument();
  });

  it("shows context usage in the composer action area", async () => {
    const usage = {
      agent_session_id: "leader-session-1",
      sdk_session_id: "leader-sdk-session-1",
      role: "leader",
      expert_id: "exp-leader",
      flow_expert_id: null,
      display_name: "Leader",
      total_tokens: 219_000,
      max_tokens: 258_000,
      raw_max_tokens: 258_000,
      percentage: 84.8,
      model: "claude-sonnet-4-20250514",
      categories: [
        { name: "System tools", tokens: 6_000, color: "color-mix(in srgb, var(--primary) 72%, var(--ui-surface-raised))", is_deferred: false },
        { name: "Messages", tokens: 3_000, color: "color-mix(in srgb, var(--primary) 56%, var(--ui-surface-raised))", is_deferred: false },
        { name: "System prompt", tokens: 1_000, color: "color-mix(in srgb, var(--primary) 40%, var(--ui-surface-raised))", is_deferred: false },
      ],
      cache_input_tokens: 2_000,
      cache_read_input_tokens: 8_000,
      cache_creation_input_tokens: 0,
      cache_hit_rate: 80,
      observed_at: "2026-06-28T10:00:00.000Z",
      compacted: false,
    };
    apiMocks.fetchFlowContextState.mockResolvedValueOnce({
      context_usage: { leader: usage, experts: [] },
      context_compactions: [],
    });

    renderPanel();

    const usageIndicator = await screen.findByLabelText(/上下文已用 85%/);
    expect(usageIndicator).toBeInTheDocument();
    fireEvent.mouseEnter(usageIndicator);
    expect(screen.getByText("上下文用量")).toBeInTheDocument();
    expect(screen.getByText("系统工具")).toBeInTheDocument();
    expect(screen.getByText("消息")).toBeInTheDocument();
    expect(screen.getByText("系统提示词")).toBeInTheDocument();
    expect(screen.getByText("平均缓存命中率")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    expect(apiMocks.fetchFlowContextState).toHaveBeenCalledWith("flow-1");
  });

  it("shows unknown instead of a false zero when cache telemetry omits cached tokens", async () => {
    apiMocks.fetchFlowContextState.mockResolvedValueOnce({
      context_usage: {
        leader: {
          agent_session_id: "leader-session-1",
          sdk_session_id: "leader-sdk-session-1",
          role: "leader",
          expert_id: "exp-leader",
          flow_expert_id: null,
          display_name: "Leader",
          total_tokens: 100,
          max_tokens: 1_000,
          raw_max_tokens: 1_000,
          percentage: 10,
          model: "mimo-v2.5",
          categories: [],
          cache_input_tokens: 80,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_hit_rate: null,
          observed_at: "2026-07-12T21:00:00.000Z",
          compacted: false,
        },
        experts: [],
      },
      context_compactions: [],
    });

    renderPanel();

    const usageIndicator = await screen.findByLabelText(/上下文已用 10%/);
    fireEvent.mouseEnter(usageIndicator);
    expect(screen.getByText("平均缓存命中率")).toBeInTheDocument();
    expect(screen.getByText("数据未知")).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("uses uppercase token units and explains the configured Codex reserve", async () => {
    apiMocks.fetchFlowContextState.mockResolvedValueOnce({
      context_usage: {
        leader: {
          agent_session_id: "leader-session-1",
          sdk_session_id: "leader-sdk-session-1",
          role: "leader",
          expert_id: "exp-leader",
          flow_expert_id: null,
          display_name: "Leader",
          total_tokens: 14_000,
          max_tokens: 950_000,
          raw_max_tokens: 1_000_000,
          percentage: 1.47,
          model: "mimo-v2.5",
          categories: [],
          cache_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_hit_rate: null,
          observed_at: "2026-07-14T08:49:33.909Z",
          compacted: false,
        },
        experts: [],
      },
      context_compactions: [],
    });

    renderPanel();
    const usageIndicator = await screen.findByLabelText(/14\.0K \/ 950K/);
    fireEvent.mouseEnter(usageIndicator);
    expect(screen.getByText("配置上限 1.0M，Codex 预留 5% 后当前可用 950K")).toBeInTheDocument();
  });

  it("loads context state once after the switched Flow session is known", async () => {
    const { rerender } = renderPanel({ flowId: "flow-2", leaderAgentSessionId: null });

    expect(apiMocks.fetchFlowContextState).not.toHaveBeenCalled();

    rerender(
      <LeaderChatPanel
        flowId="flow-2"
        leaderAgentSessionId="leader-session-2"
        flowStatus="ready"
        decisionCardStatuses={{}}
        decisionCardAnswers={{}}
        decisionCards={[]}
        specCards={{}}
        onOpenSpecPreview={vi.fn()}
      />,
    );

    await waitFor(() => expect(apiMocks.fetchFlowContextState).toHaveBeenCalledTimes(1));
    expect(apiMocks.fetchFlowContextState).toHaveBeenCalledWith("flow-2");
  });

  it("shows 1% when context usage is above zero but below one percent", async () => {
    apiMocks.fetchFlowContextState.mockResolvedValueOnce({
      context_usage: {
        leader: {
          agent_session_id: "leader-session-1",
          sdk_session_id: "leader-sdk-session-1",
          role: "leader",
          expert_id: "exp-leader",
          flow_expert_id: null,
          display_name: "Leader",
          total_tokens: 1_100,
          max_tokens: 200_000,
          raw_max_tokens: 200_000,
          percentage: 0.2,
          model: "claude-sonnet",
          categories: [],
          observed_at: "2026-06-28T10:00:00.000Z",
          compacted: false,
        },
        experts: [],
      },
      context_compactions: [],
    });

    renderPanel();

    expect(await screen.findByLabelText(/上下文已用 1%/)).toBeInTheDocument();
  });

  it("updates context usage from websocket events", async () => {
    renderPanel();
    await screen.findByLabelText("上下文使用量暂不可用");
    expect(screen.queryByRole("button", { name: "压缩当前会话" })).not.toBeInTheDocument();

    await act(async () => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "context_usage:event",
          flow_id: "flow-1",
          data: {
            agent_session_id: "leader-session-1",
            sdk_session_id: "leader-sdk-session-1",
            role: "leader",
            expert_id: "exp-leader",
            flow_expert_id: null,
            display_name: "Leader",
            total_tokens: 12_000,
            max_tokens: 200_000,
            raw_max_tokens: 200_000,
            percentage: 6,
            model: "claude-sonnet",
            categories: [],
            observed_at: "2026-06-28T10:00:00.000Z",
            compacted: false,
          },
        });
      }
    });

    expect(await screen.findByLabelText(/上下文已用 6%/)).toBeInTheDocument();
  });

  it("shows running and completed context compaction dividers from websocket events", async () => {
    renderPanel();
    await screen.findByLabelText("上下文使用量暂不可用");

    await act(async () => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "context_compaction:event",
          flow_id: "flow-1",
          data: {
            flow_id: "flow-1",
            agent_session_id: "leader-session-1",
            sdk_session_id: "leader-sdk-session-1",
            role: "leader",
            expert_id: "exp-leader",
            flow_expert_id: null,
            display_name: "Leader",
            status: "running",
            started_at: "2026-06-28T10:00:00.000Z",
            updated_at: "2026-06-28T10:00:00.000Z",
            error_message: null,
          },
        });
      }
    });

    expect(await screen.findByTestId("transcript-status-divider")).toHaveTextContent("正在压缩当前会话");

    await act(async () => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "context_compaction:event",
          flow_id: "flow-1",
          data: {
            flow_id: "flow-1",
            agent_session_id: "leader-session-1",
            sdk_session_id: "leader-sdk-session-1",
            role: "leader",
            expert_id: "exp-leader",
            flow_expert_id: null,
            display_name: "Leader",
            status: "completed",
            started_at: "2026-06-28T10:00:00.000Z",
            updated_at: "2026-06-28T10:00:10.000Z",
            error_message: null,
          },
        });
      }
    });

    expect(await screen.findByTestId("transcript-status-divider")).toHaveTextContent("已压缩当前会话");
  });

  it("requests context compaction from the composer usage popover", async () => {
    const user = userEvent.setup();
    const usage = {
      agent_session_id: "leader-session-1",
      sdk_session_id: "leader-sdk-session-1",
      role: "leader",
      expert_id: "exp-leader",
      flow_expert_id: null,
      display_name: "Leader",
      total_tokens: 10_000,
      max_tokens: 200_000,
      raw_max_tokens: 200_000,
      percentage: 5,
      model: "claude-sonnet",
      categories: [],
      observed_at: "2026-06-28T10:00:00.000Z",
      compacted: false,
    };
    apiMocks.fetchFlowContextState.mockResolvedValue({
      context_usage: { leader: usage, experts: [] },
      context_compactions: [],
    });
    let resolveCompact!: (value: typeof usage) => void;
    apiMocks.compactFlowContext.mockReturnValue(new Promise((resolve) => {
      resolveCompact = resolve;
    }));

    renderPanel();

    fireEvent.mouseEnter(await screen.findByLabelText(/上下文已用 5%/));
    const compactButton = screen.getByRole("button", { name: "压缩当前会话" });
    await user.click(compactButton);

    expect(apiMocks.compactFlowContext).toHaveBeenCalledWith("flow-1");
    expect(compactButton).toHaveTextContent("正在压缩当前会话");
    expect(await screen.findByTestId("transcript-status-divider")).toHaveTextContent("正在压缩当前会话");

    await act(async () => {
      resolveCompact({ ...usage, total_tokens: 2_000, percentage: 1, compacted: true });
    });

    expect(await screen.findByLabelText(/上下文已用 1%/)).toBeInTheDocument();
    expect(await screen.findByTestId("transcript-status-divider")).toHaveTextContent("已压缩当前会话");
  });

  it("keeps Plan mode locked until the generated plan is approved", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel();
    await user.click(screen.getByRole("button", { name: "执行模式：自动编辑" }));
    await user.click(screen.getByRole("button", { name: /计划模式：/ }));
    expect(screen.getByRole("button", { name: "执行模式：计划模式" })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("输入消息..."), "先生成计划");
    await user.keyboard("{Enter}");
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      spec_requested: true,
      content: "先生成计划",
    }));
    expect(screen.getByRole("button", { name: "执行模式：计划模式" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行模式：计划模式" }));
    expect(screen.getByRole("button", { name: /自动编辑：/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /完全访问：/ })).toBeDisabled();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "plan_approval:event",
          flow_id: "flow-1",
          data: { status: "approved" },
        } as unknown as WsInMessage);
      }
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "执行模式：自动编辑" })).toBeInTheDocument());
    expect(wsClient.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:set_agent_mode" }));
  });

  it("keeps a newly created Flow in Plan mode during the UI handoff", async () => {
    const user = userEvent.setup();
    const onInitialPlanModeResolved = vi.fn();

    renderPanel({
      riskMode: "full_access",
      initialPlanModeReturnRiskMode: "full_access",
      onInitialPlanModeResolved,
    });

    expect(await screen.findByRole("button", { name: "执行模式：计划模式" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "执行模式：计划模式" }));
    expect(screen.getByRole("button", { name: /自动编辑：/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /完全访问：/ })).toBeDisabled();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "plan_approval:event",
          flow_id: "flow-1",
          data: { status: "approved", plan_revision_id: "revision-new-flow" },
        } as unknown as WsInMessage);
      }
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "执行模式：完全访问" })).toBeInTheDocument());
    expect(onInitialPlanModeResolved).toHaveBeenCalledTimes(1);
  });

  it("restores Plan mode from an active spec-requested UserTurn before a card exists", async () => {
    renderPanel({ riskMode: "full_access" });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:state",
          flow_id: "flow-1",
          data: {
            user_turns: [{
              user_turn_id: "turn-plan-refresh",
              trigger_message_id: "msg-plan-refresh",
              status: "active",
              started_at: "2026-07-18T05:00:00.000Z",
              active_started_at: "2026-07-18T05:00:00.000Z",
              active_duration_ms: 0,
              input_snapshot_json: JSON.stringify({ spec_requested: true }),
            }],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByRole("button", { name: "执行模式：计划模式" })).toBeInTheDocument();
  });

  it("restores plan mode after a refresh while Spec or Plan approval is pending", async () => {
    renderPanel({
      specCards: {
        "spec-approval-1": {
          spec_approval_id: "spec-approval-1",
          spec_revision_id: "spec-revision-1",
          user_turn_id: "turn-1",
          status: "pending",
          file_name: "plan.md",
          overview: "先确认范围",
          actions: ["run"],
        },
      },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "执行模式：计划模式" })).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole("button", { name: "执行模式：计划模式" }));
    expect(screen.getByRole("button", { name: /自动编辑：/ })).toBeDisabled();
  });

  it("returns to the risk mode that was active before entering Plan mode", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel({ riskMode: "full_access" });
    await user.click(screen.getByRole("button", { name: "执行模式：完全访问" }));
    await user.click(screen.getByRole("button", { name: /计划模式：/ }));
    await user.type(screen.getByPlaceholderText("输入消息..."), "保留原档位");
    await user.keyboard("{Enter}");

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({ type: "plan_approval:event", flow_id: "flow-1", data: { status: "approved" } } as unknown as WsInMessage);
      }
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "执行模式：完全访问" })).toBeInTheDocument());
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ spec_requested: true }));
  });

  it("keeps a queued Spec request for the next turn instead of sending it as a guide", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");
    const activeTurn = {
      id: "turn-spec-queue",
      triggerMessageId: "msg-running",
      status: "active" as const,
      startedAt: "2026-07-11T10:00:00.000Z",
      activeStartedAt: "2026-07-11T10:00:00.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    renderPanel({ userTurns: [activeTurn] });
    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_event",
          flow_id: "flow-1",
          session_id: "sdk-leader-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 1,
            event: { type: "turn-started", messageId: "msg-assistant-running", startedAt: activeTurn.startedAt },
          },
        } as unknown as WsInMessage);
      }
    });

    await user.click(screen.getByRole("button", { name: "执行模式：自动编辑" }));
    await user.click(screen.getByRole("button", { name: /计划模式：/ }));
    await user.type(screen.getByPlaceholderText("继续输入以排队后续修改"), "下一轮先写 Spec");
    await user.keyboard("{Enter}");

    const waitButton = screen.getByRole("button", { name: "Spec 消息 1 需等待当前任务结束" });
    expect(waitButton).toBeDisabled();
    await user.click(waitButton);
    expect(wsClient.sendFlowGuide).not.toHaveBeenCalled();
    expect(useRunningMessageQueueStore.getState().queuesByFlow["flow-1"]?.[0]).toEqual(expect.objectContaining({
      content: "下一轮先写 Spec",
      specRequested: true,
    }));
  });

  it("renders a pending spec card and runs it on click", async () => {
    const user = userEvent.setup();
    const { wsClient } = await import("../../lib/ws");

    renderPanel({
      specCards: {
        "sca-1": {
          spec_approval_id: "sca-1",
          spec_revision_id: "spec-1",
          status: "pending",
          file_name: "Hello_World_abcd.md",
          overview: "Create page.",
          actions: ["run"],
        },
      },
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              {
                id: "msg-plan",
                role: "assistant",
                content: "Spec 已生成",
                parts: [
                  { type: "text", text: "Spec 已生成" },
                  {
                    type: "tool-mcp__squadflow-leader__create_plan",
                    toolCallId: "tool-plan",
                    toolName: "mcp__squadflow-leader__create_plan",
                    state: "output-available",
                    output: {
                      content: JSON.stringify({
                        ok: true,
                        spec_revision: {
                          spec_revision_id: "spec-1",
                          file_name: "Hello_World_abcd.md",
                          overview: "Create page.",
                        },
                        spec_approval: {
                          spec_approval_id: "sca-1",
                        },
                      }),
                      is_error: false,
                    },
                  },
                ],
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("Spec Hello_World_abcd.md")).toBeInTheDocument();
    expect(screen.getByText("Create page.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批准并执行" }));

    expect(wsClient.sendRunSpec).toHaveBeenCalledWith("flow-1", "sca-1");
  });

  it("opens spec preview from the card detail button", async () => {
    const user = userEvent.setup();
    const onOpenSpecPreview = vi.fn();

    renderPanel({
      onOpenSpecPreview,
      specCards: {
        "sca-1": {
          spec_approval_id: "sca-1",
          spec_revision_id: "spec-1",
          status: "pending",
          file_name: "Hello_World_abcd.md",
          overview: "Create page.",
          actions: ["run"],
        },
      },
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              {
                id: "msg-plan",
                role: "assistant",
                content: "Spec 已生成",
                parts: [
                  { type: "text", text: "Spec 已生成" },
                  {
                    type: "tool-mcp__squadflow-leader__create_plan",
                    toolCallId: "tool-plan",
                    toolName: "mcp__squadflow-leader__create_plan",
                    state: "output-available",
                    output: {
                      content: JSON.stringify({
                        ok: true,
                        spec_revision: {
                          spec_revision_id: "spec-1",
                          file_name: "Hello_World_abcd.md",
                          overview: "Create page.",
                        },
                        spec_approval: {
                          spec_approval_id: "sca-1",
                        },
                      }),
                      is_error: false,
                    },
                  },
                ],
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    await user.click(await screen.findByRole("button", { name: "查看详情" }));

    expect(onOpenSpecPreview).toHaveBeenCalledWith("spec-1", "Hello_World_abcd.md");
  });

  it("renders one product work header for multiple leader SDK turns in the same user turn", async () => {
    renderPanel();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:state",
          flow_id: "flow-1",
          data: {
            user_turns: [{
              user_turn_id: "utn-1",
              trigger_message_id: "msg-user-1",
              status: "completed",
              started_at: "2026-06-26T10:00:00.000Z",
              active_started_at: null,
              active_duration_ms: 4000,
              completed_at: "2026-06-26T10:00:04.000Z",
            }],
          },
        } as WsInMessage);
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              { id: "msg-user-1", role: "user", parts: [{ type: "text", text: "调研一下" }], content: "调研一下" },
              {
                id: "msg-assistant-1",
                role: "assistant",
                parts: [{ type: "text", text: "先交给 Research。" }],
                content: "先交给 Research。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:00.000Z",
                    finishedAt: "2026-06-26T10:00:01.000Z",
                    durationMs: 1000,
                  },
                },
              },
              {
                id: "msg-assistant-2",
                role: "assistant",
                parts: [{ type: "text", text: "最终结论。" }],
                content: "最终结论。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:03.000Z",
                    finishedAt: "2026-06-26T10:00:04.000Z",
                    durationMs: 1000,
                  },
                },
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("最终结论。")).toBeInTheDocument();
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1);
    const header = screen.getByText("已工作 4 秒");
    expect(header).toBeInTheDocument();
    expect(header.compareDocumentPosition(screen.getByText("最终结论。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
  });

  it("uses dashboard user turns for historical flows even if the panel missed flow:state", async () => {
    renderPanel({
      userTurns: [{
        id: "utn-1",
        triggerMessageId: "msg-user-1",
        status: "completed",
        startedAt: "2026-06-26T10:00:00.000Z",
        activeStartedAt: null,
        activeDurationMs: 17000,
        completedAt: "2026-06-26T10:00:17.000Z",
      }],
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              { id: "msg-user-1", role: "user", parts: [{ type: "text", text: "调研一下" }], content: "调研一下" },
              {
                id: "msg-assistant-1",
                role: "assistant",
                parts: [{ type: "text", text: "已派出 Research。" }],
                content: "已派出 Research。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:00.000Z",
                    finishedAt: "2026-06-26T10:00:10.000Z",
                    durationMs: 10000,
                  },
                },
              },
              {
                id: "msg-assistant-2",
                role: "assistant",
                parts: [{ type: "text", text: "调研完成。" }],
                content: "调研完成。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:10.000Z",
                    finishedAt: "2026-06-26T10:00:17.000Z",
                    durationMs: 7000,
                  },
                },
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("调研完成。")).toBeInTheDocument();
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1);
    const header = screen.getByText("已工作 17 秒");
    expect(header).toBeInTheDocument();
    expect(header.compareDocumentPosition(screen.getByText("调研完成。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
    expect(screen.queryByText("已工作 10 秒")).toBeNull();
    expect(screen.queryByText("已工作 7 秒")).toBeNull();
  });

  it("groups canonical messages by the stable UserTurn trigger id", async () => {
    renderPanel({
      userTurns: [{
        id: "utn-1",
        triggerMessageId: "msg-user-original",
        status: "completed",
        startedAt: "2026-06-26T10:00:00.000Z",
        activeStartedAt: null,
        activeDurationMs: 17000,
        completedAt: "2026-06-26T10:00:17.000Z",
      }],
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              {
                id: "msg-user-original",
                role: "user",
                parts: [{ type: "text", text: "调研一下" }],
                content: "调研一下",
                createdAt: "2026-06-26T10:00:00.000Z",
              },
              {
                id: "msg-1",
                role: "assistant",
                parts: [{ type: "text", text: "已派出 Research。" }],
                content: "已派出 Research。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:00.000Z",
                    finishedAt: "2026-06-26T10:00:10.000Z",
                    durationMs: 10000,
                  },
                },
              },
              {
                id: "msg-2",
                role: "assistant",
                parts: [{ type: "text", text: "调研完成。" }],
                content: "调研完成。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:10.000Z",
                    finishedAt: "2026-06-26T10:00:17.000Z",
                    durationMs: 7000,
                  },
                },
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("调研完成。")).toBeInTheDocument();
    expect(screen.getAllByText(/^已工作/)).toHaveLength(1);
    const header = screen.getByText("已工作 17 秒");
    expect(header).toBeInTheDocument();
    expect(header.compareDocumentPosition(screen.getByText("调研完成。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
    expect(screen.queryByText("已工作 10 秒")).toBeNull();
    expect(screen.queryByText("已工作 7 秒")).toBeNull();
  });

  it("keeps the product turn working after an internal leader turn has finished", async () => {
    renderPanel();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:state",
          flow_id: "flow-1",
          data: {
            user_turns: [{
              user_turn_id: "utn-1",
              trigger_message_id: "msg-user-1",
              status: "active",
              started_at: "2026-06-26T10:00:00.000Z",
              active_started_at: "2026-06-26T10:00:01.000Z",
              active_duration_ms: 1000,
              completed_at: null,
            }],
          },
        } as WsInMessage);
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              { id: "msg-user-1", role: "user", parts: [{ type: "text", text: "调研一下" }], content: "调研一下" },
              {
                id: "msg-assistant-1",
                role: "assistant",
                parts: [{ type: "text", text: "我去调研。" }],
                content: "我去调研。",
                metadata: {
                  turnTiming: {
                    startedAt: "2026-06-26T10:00:00.000Z",
                    finishedAt: "2026-06-26T10:00:01.000Z",
                    durationMs: 1000,
                  },
                },
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("我去调研。")).toBeInTheDocument();
    expect(screen.getByText(/工作中/)).toBeInTheDocument();
    expect(screen.queryByText("已工作 1 秒")).toBeNull();
  });

  it("shows a paused product turn while waiting for a decision card", async () => {
    renderPanel();

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "flow:state",
          flow_id: "flow-1",
          data: {
            user_turns: [{
              user_turn_id: "utn-1",
              trigger_message_id: "msg-user-1",
              status: "waiting_user",
              started_at: "2026-06-26T10:00:00.000Z",
              active_started_at: null,
              active_duration_ms: 3000,
              completed_at: null,
            }],
          },
        } as WsInMessage);
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              { id: "msg-user-1", role: "user", parts: [{ type: "text", text: "调研一下" }], content: "调研一下" },
              {
                id: "msg-assistant-1",
                role: "assistant",
                parts: [{ type: "text", text: "需要你确认一个选项。" }],
                content: "需要你确认一个选项。",
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    expect(await screen.findByText("需要你确认一个选项。")).toBeInTheDocument();
    expect(screen.getByText("等待你确认 · 已工作 3 秒")).toBeInTheDocument();
    expect(screen.queryByText(/工作中/)).toBeNull();
  });

  it("renders a pending decision card in the composer dock and hides the free-form input", async () => {
    renderPanel({
      decisionCardStatuses: { "card-1": "pending" },
      decisionCards: [pendingCard],
    });

    act(() => {
      for (const handler of wsMessageHandlers) {
        handler({
          type: "session:transcript_snapshot",
          flow_id: "flow-1",
          agent_session_id: "leader-session-1",
          data: {
            cursor: 0,
            messages: [
              {
                id: "msg-card",
                role: "assistant",
                content: "",
                parts: [
                  {
                    type: "tool-mcp__squadflow-leader__ask_user",
                    toolCallId: "tool-card",
                    toolName: "mcp__squadflow-leader__ask_user",
                    state: "output-available",
                    input: {
                      flow_id: "flow-1",
                      questions: [
                        {
                          question: "是否继续？",
                          header: "下一步",
                          multiSelect: false,
                          options: [{ label: "继续", description: "进入下一步" }],
                        },
                      ],
                    },
                    output: { content: "{\"decision_card_id\":\"card-1\"}", is_error: false },
                  },
                ],
              },
            ],
          },
        } as unknown as WsInMessage);
      }
    });

    const transcriptShell = screen.getByTestId("leader-chat-transcript-shell");
    const composer = screen.getByTestId("leader-chat-composer");

    await within(composer).findByText(/是否继续？/);
    expect(composer).toHaveAttribute("data-layout", "docked");
    expect(composer.className).not.toContain("absolute");
    expect(composer.className).toContain("shrink-0");
    expect(within(transcriptShell).queryByText(/是否继续？/)).toBeNull();
    expect(screen.queryByPlaceholderText("请先完成澄清卡片...")).toBeNull();
    expect(screen.queryByPlaceholderText("输入消息...")).toBeNull();
  });

  it("disables the composer when no flow is selected", () => {
    renderPanel({ flowId: null });

    expect(screen.getByPlaceholderText("输入消息...")).toBeDisabled();
  });

  it("does not render a project selector inside an existing task", () => {
    renderPanel({ flowStatus: "ready" });

    expect(screen.queryByText("不使用项目")).not.toBeInTheDocument();
    expect(screen.queryByText("目标目录已锁定")).not.toBeInTheDocument();
  });
});

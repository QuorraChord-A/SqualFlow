import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsInMessage } from "../../lib/ws";
import SessionTranscriptPanel, { formatMessageTimestamp, interleaveStatusDivider, reconcileDurablePlanCard, shouldBatchTranscriptEvent, type WorkRunDisplay } from "./SessionTranscriptPanel";
import { orchestrationPlanFixture } from "../orchestration/orchestrationTestFixture";
import { resetCollapseStoreForTests } from "./transcript/useCollapse";

const wsHandlers = new Set<(message: any) => void>();
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
const stickToBottomMock = vi.hoisted(() => ({
  isAtBottom: true,
  scrollToBottom: vi.fn(),
}));
let transcriptCursor = 0;
let hasTranscriptSnapshot = false;
let activeMessageId = "";
let activeTextBlockId = "";
let activeReasoningBlockId = "";
let textBlockSequence = 0;
let reasoningBlockSequence = 0;
const cursorsByLegacySequence = new Map<string, number>();

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});

it("keeps a completed compaction divider before the first later prompt", () => {
  const before = { id: "before", role: "assistant", createdAt: "2026-07-09T23:49:00.000Z", parts: [{ type: "text", text: "压缩前" }] } as UIMessage;
  const after = { id: "after", role: "user", createdAt: "2026-07-09T23:51:00.000Z", parts: [{ type: "text", text: "新 prompt" }] } as UIMessage;

  expect(interleaveStatusDivider([before, after], "已压缩当前会话", false, "2026-07-09T23:50:00.000Z").map((item) => item.id)).toEqual([
    "before",
    "status-divider:2026-07-09T23:50:00.000Z",
    "after",
  ]);
});

it("batches every tool state update with text and reasoning deltas", () => {
  expect(shouldBatchTranscriptEvent({ type: "text-delta", messageId: "msg-1", id: "text-1", delta: "a" })).toBe(true);
  expect(shouldBatchTranscriptEvent({ type: "tool-input-start", messageId: "msg-1", toolCallId: "tool-1", toolName: "mcp__squadflow-browser__browser_click" })).toBe(true);
  expect(shouldBatchTranscriptEvent({ type: "tool-input-start", messageId: "msg-1", toolCallId: "tool-2", toolName: "mcp__squadflow-leader__get_context" })).toBe(true);
  expect(shouldBatchTranscriptEvent({ type: "tool-output-available", messageId: "msg-1", toolCallId: "tool-1", output: {} })).toBe(true);
  expect(shouldBatchTranscriptEvent({ type: "turn-finished", messageId: "msg-1", durationMs: 10, finishedAt: "2026-07-10T00:00:00.000Z" })).toBe(false);
});

it("does not synthesize a plan card without its transcript tool anchor", () => {
  const blocks = [{ id: "text-1", type: "text" as const, text: "计划已提交", streaming: false }];
  expect(reconcileDurablePlanCard(blocks, [orchestrationPlanFixture], orchestrationPlanFixture)).toEqual(blocks);
});

it("reconciles a persisted plan with a stale submit-plan tool state", () => {
  const reconciled = reconcileDurablePlanCard([{
    id: "tool-group-1",
    type: "tool-group",
    tools: [{
      toolCallId: "submit-plan-1",
      toolName: "mcp__squadflow-leader__submit_orchestration_plan",
      state: "running",
      input: { flow_id: "flow-1", title: "成员邀请编排计划" },
      output: null,
    }],
    finalized: false,
    defaultCollapsed: true,
    activeState: "running",
    currentToolCallId: "submit-plan-1",
  }, {
    id: "final-text",
    type: "text",
    text: "后续执行结果",
    streaming: false,
  }], [orchestrationPlanFixture]);

  expect(reconciled.map((block) => block.type)).toEqual(["tool-group", "plan-card", "text"]);

  expect(reconciled).toContainEqual(expect.objectContaining({
    type: "tool-group",
    finalized: true,
    activeState: undefined,
    currentToolCallId: null,
    tools: [expect.objectContaining({ state: "completed" })],
  }));
  expect(reconciled).toContainEqual(expect.objectContaining({
    type: "plan-card",
    id: "tool-card:submit-plan-1:orchestration-plan",
    planRevisionId: orchestrationPlanFixture.revision.plan_revision_id,
  }));
});

it("shows a persisted pending plan when the reloaded SDK transcript keeps a stale submit state", async () => {
  render(
    <SessionTranscriptPanel
      flowId="flow-1"
      agentSessionId="leader-1"
      readonly
      orchestrationPlans={[orchestrationPlanFixture]}
    />,
  );

  emit({
    type: "session:transcript_snapshot",
    flow_id: "flow-1",
    agent_session_id: "leader-1",
    data: {
      cursor: 0,
      messages: [{ id: "msg-user-plan", role: "user", parts: [{ type: "text", text: "请提交计划" }] }, {
        id: "msg-assistant-plan",
        role: "assistant",
        parts: [{
          type: "tool-mcp__squadflow-leader__submit_orchestration_plan",
          toolCallId: "submit-plan-1",
          toolName: "mcp__squadflow-leader__submit_orchestration_plan",
          state: "input-available",
          input: { flow_id: "flow-1", title: "成员邀请编排计划" },
        }],
      }],
    },
  });

  expect(await screen.findByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).toBeVisible();
  expect(screen.queryByText("正在生成编排计划…")).not.toBeInTheDocument();
});

it("reloads the canonical transcript when a completed Leader turn is missing its pending plan anchor", async () => {
  const { wsClient } = await import("../../lib/ws");
  const { rerender } = render(
    <SessionTranscriptPanel
      flowId="flow-1"
      agentSessionId="leader-1"
      readonly
      isAwaitingResponse
      orchestrationPlans={[orchestrationPlanFixture]}
    />,
  );

  emit({
    type: "session:transcript_snapshot",
    flow_id: "flow-1",
    agent_session_id: "leader-1",
    data: {
      stream_epoch: "epoch-plan-recovery",
      cursor: 12,
      messages: [
        { id: "msg-user-plan", role: "user", parts: [{ type: "text", text: "请提交计划" }] },
        { id: "msg-assistant-plan", role: "assistant", parts: [{ type: "text", text: "正在提交计划" }] },
      ],
      active_turn: {
        message_id: "msg-assistant-plan",
        started_at: "2026-08-05T00:00:00.000Z",
      },
    },
  });

  expect(await screen.findByText("正在提交计划")).toBeVisible();
  expect(screen.queryByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).not.toBeInTheDocument();
  vi.mocked(wsClient.sendSessionGet).mockClear();

  rerender(
    <SessionTranscriptPanel
      flowId="flow-1"
      agentSessionId="leader-1"
      readonly
      isAwaitingResponse={false}
      orchestrationPlans={[orchestrationPlanFixture]}
    />,
  );

  await waitFor(() => {
    expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(1);
    expect(wsClient.sendSessionGet).toHaveBeenCalledWith("flow-1", "", "leader-1", undefined);
  });

  stickToBottomMock.scrollToBottom.mockClear();
  emit({
    type: "session:transcript_snapshot",
    flow_id: "flow-1",
    agent_session_id: "leader-1",
    data: {
      stream_epoch: "epoch-plan-recovery",
      cursor: 16,
      messages: [
        { id: "msg-user-plan", role: "user", parts: [{ type: "text", text: "请提交计划" }] },
        {
          id: "msg-assistant-plan",
          role: "assistant",
          parts: [{
            type: "tool-mcp__squadflow-leader__submit_orchestration_plan",
            toolCallId: "submit-plan-recovered",
            toolName: "mcp__squadflow-leader__submit_orchestration_plan",
            mcp: { server: "squadflow-leader", tool: "submit_orchestration_plan" },
            state: "output-available",
            input: { flow_id: "flow-1", title: orchestrationPlanFixture.revision.title },
            output: {
              content: JSON.stringify({
                revision: { id: orchestrationPlanFixture.revision.plan_revision_id },
              }),
            },
          }],
        },
      ],
    },
  });

  expect(await screen.findByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).toBeVisible();
  await waitFor(() => expect(stickToBottomMock.scrollToBottom).toHaveBeenCalledWith({ animation: "instant" }));
});

it("shows the durable plan instead of thinking when persisted session history is empty", async () => {
  render(
    <SessionTranscriptPanel
      flowId="flow-1"
      agentSessionId="leader-1"
      readonly
      isAwaitingResponse
      orchestrationPlans={[orchestrationPlanFixture]}
      workRuns={[{
        id: "turn-1",
        triggerMessageId: "msg-user-plan",
        status: "waiting_user",
        startedAt: "2026-07-11T00:00:00.000Z",
        activeStartedAt: null,
        activeDurationMs: 37_000,
        completedAt: null,
      }]}
    />,
  );

  emit({
    type: "session:transcript_snapshot",
    flow_id: "flow-1",
    agent_session_id: "leader-1",
    data: { cursor: 0, messages: [] },
  });

  expect(await screen.findByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).toBeVisible();
  expect(screen.getByText("等待你确认 · 已工作 37 秒")).toBeVisible();
  expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
});

vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: Object.assign(
    ({ children, className, ...rest }: { children: React.ReactNode; className?: string }) => (
      <div className={className} {...rest}>{children}</div>
    ),
    {
      Content: ({ children, className, ...rest }: { children: React.ReactNode; className?: string }) => (
        <div className={className} {...rest}>{children}</div>
      ),
    },
  ),
  useStickToBottomContext: () => ({
    isAtBottom: stickToBottomMock.isAtBottom,
    scrollToBottom: stickToBottomMock.scrollToBottom,
  }),
}));

vi.mock("../../lib/ws", () => ({
  wsClient: {
    sendSessionGet: vi.fn(),
    sendRunSpec: vi.fn(),
    onMessage: vi.fn((handler: (message: any) => void) => {
      wsHandlers.add(handler);
      return () => wsHandlers.delete(handler);
    }),
  },
}));

function normalizeLegacyMessage(message: any): any[] {
  if (message.type === "session:history" || message.type === "session:snapshot") {
    const sourceMessages = Array.isArray(message.data) ? message.data : [];
    const current = message.type === "session:snapshot"
      ? [...sourceMessages].reverse().find((item) => item?.role === "assistant")
      : undefined;
    const messages = sourceMessages.map((item: any) => {
      if (item?.id !== current?.id || !Array.isArray(item.parts)) return item;
      return {
        ...item,
        parts: item.parts.map((part: Record<string, unknown>, index: number) => {
          if ((part.type !== "text" && part.type !== "reasoning") || part.id) return part;
          const id = `${part.type}-${item.id}-${index + 1}`;
          if (part.type === "text") activeTextBlockId = id;
          if (part.type === "reasoning") activeReasoningBlockId = id;
          return { ...part, id };
        }),
      };
    });
    if (current?.id) activeMessageId = current.id;
    hasTranscriptSnapshot = true;
    return [{
      ...message,
      type: "session:transcript_snapshot",
      data: {
        cursor: 0,
        messages,
        ...(message.history_boundaries ? { history_boundaries: message.history_boundaries } : {}),
        ...(current ? {
          active_turn: {
            message_id: current.id,
            started_at: current.metadata?.turnTiming?.startedAt ?? current.createdAt ?? "2026-06-24T10:00:00.000Z",
          },
        } : {}),
      },
    }];
  }

  if (message.type !== "session:chat_event") return [message];
  const raw = { ...(message.data?.event ?? {}) } as Record<string, any>;
  const originalType = String(raw.type ?? "");
  const messageId = typeof raw.messageId === "string" && raw.messageId
    ? raw.messageId
    : activeMessageId || "msg-test-live";
  const event: Record<string, any> = { ...raw, messageId };
  if (originalType === "start") {
    activeMessageId = messageId;
    event.type = "turn-started";
  } else if (originalType === "finish") {
    event.type = "turn-finished";
  } else if (originalType.startsWith("text-")) {
    if (originalType === "text-start") activeTextBlockId = raw.id || `text-${messageId}-${++textBlockSequence}`;
    event.id = raw.id || activeTextBlockId || `text-${messageId}`;
  } else if (originalType.startsWith("reasoning-")) {
    if (originalType === "reasoning-start") activeReasoningBlockId = raw.id || `reasoning-${messageId}-${++reasoningBlockSequence}`;
    event.id = raw.id || activeReasoningBlockId || `reasoning-${messageId}`;
  }

  const sequenceKey = typeof raw.seq === "number" ? `${messageId}:${raw.seq}` : "";
  const cursor = sequenceKey
    ? cursorsByLegacySequence.get(sequenceKey) ?? (++transcriptCursor)
    : ++transcriptCursor;
  if (sequenceKey) cursorsByLegacySequence.set(sequenceKey, cursor);

  const result: any[] = [];
  if (!hasTranscriptSnapshot) {
    hasTranscriptSnapshot = true;
    result.push({
      type: "session:transcript_snapshot",
      flow_id: message.flow_id,
      ...(message.agent_session_id ? { agent_session_id: message.agent_session_id } : {}),
      ...(message.flow_expert_id ? { flow_expert_id: message.flow_expert_id } : {}),
      data: { cursor: 0, messages: [] },
    });
  }
  result.push({
    ...message,
    type: "session:transcript_event",
    data: { cursor, event },
  });
  return result;
}

function emit(message: any) {
  act(() => {
    for (const normalized of normalizeLegacyMessage(message)) {
      for (const handler of wsHandlers) handler(normalized);
    }
  });
}

function message(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    content: text,
  } as UIMessage;
}

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    content: text,
  } as UIMessage;
}

describe("formatMessageTimestamp", () => {
  const now = new Date(2026, 5, 20, 12, 0);

  it("shows only time for today", () => {
    expect(formatMessageTimestamp(new Date(2026, 5, 20, 9, 10), now)).toBe("09:10");
  });

  it("shows weekday and time for another day in the current week", () => {
    expect(formatMessageTimestamp(new Date(2026, 5, 17, 9, 10), now)).toBe("星期三 09:10");
  });

  it("shows month, day, and time outside the current week in the current year", () => {
    expect(formatMessageTimestamp(new Date(2026, 5, 10, 18, 30), now)).toBe("6月10日 18:30");
  });

  it("shows year, month, day, and time outside the current year", () => {
    expect(formatMessageTimestamp(new Date(2025, 11, 3, 14, 8), now)).toBe("2025年12月3日 14:08");
  });
});

describe("SessionTranscriptPanel", () => {
  beforeEach(async () => {
    wsHandlers.clear();
    transcriptCursor = 0;
    hasTranscriptSnapshot = false;
    activeMessageId = "";
    activeTextBlockId = "";
    activeReasoningBlockId = "";
    textBlockSequence = 0;
    reasoningBlockSequence = 0;
    cursorsByLegacySequence.clear();
    resetCollapseStoreForTests();
    stickToBottomMock.isAtBottom = true;
    stickToBottomMock.scrollToBottom.mockClear();
    clipboardWriteText.mockClear();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const { wsClient } = await import("../../lib/ws");
    vi.mocked(wsClient.sendSessionGet).mockClear();
    vi.mocked(wsClient.onMessage).mockClear();
  });

  it("requests history for the selected agent session", async () => {
    const { wsClient } = await import("../../lib/ws");

    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    expect(wsClient.sendSessionGet).toHaveBeenCalledWith("flow-1", "", "leader-1");
  });

  it("requests one canonical snapshot when live transcript cursors have a gap", async () => {
    const { wsClient } = await import("../../lib/ws");
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { stream_epoch: "epoch-gap", cursor: 1, messages: [] },
    });
    vi.mocked(wsClient.sendSessionGet).mockClear();

    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        stream_epoch: "epoch-gap",
        cursor: 3,
        event: { type: "message-added", message: userMessage("msg-after-gap", "断档后") },
      },
    });

    await waitFor(() => {
      expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(1);
      expect(wsClient.sendSessionGet).toHaveBeenCalledWith("flow-1", "", "leader-1", undefined);
    });

    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        stream_epoch: "epoch-gap",
        cursor: 4,
        event: { type: "message-added", message: userMessage("msg-still-after-gap", "仍在断档后") },
      },
    });

    await waitFor(() => expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("断档后")).not.toBeInTheDocument();
    expect(screen.queryByText("仍在断档后")).not.toBeInTheDocument();
  });

  it("keeps one stable Leader transcript when the current AgentSession changes", async () => {
    const { wsClient } = await import("../../lib/ws");
    const { rerender } = render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-run-1"
        stableTranscriptChannel
        readonly
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      session_id: "leader:flow-1",
      agent_session_id: "leader-run-1",
      data: {
        cursor: 1,
        messages: [message("leader-first", "第一轮 Leader 回复")],
      },
    });
    expect(await screen.findByText("第一轮 Leader 回复")).toBeInTheDocument();

    rerender(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-run-2"
        stableTranscriptChannel
        readonly
      />,
    );

    expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(1);
    expect(screen.getByText("第一轮 Leader 回复")).toBeInTheDocument();

    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      session_id: "leader:flow-1",
      agent_session_id: "leader-run-2",
      data: {
        cursor: 2,
        event: {
          type: "message-added",
          message: message("leader-second", "第二轮 Leader 回复"),
        },
      },
    });

    expect(await screen.findByText("第二轮 Leader 回复")).toBeInTheDocument();
    expect(screen.getByText("第一轮 Leader 回复")).toBeInTheDocument();
  });

  it("shows live Codex reconnect status in place of the thinking label and clears it after recovery", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        isAwaitingResponse
      />,
    );

    expect(screen.getByText("正在思考")).toBeInTheDocument();
    emit({
      type: "runtime:transport",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        state: "reconnecting",
        message: "Codex WebSocket 正在重连（2/5）",
        attempt: 2,
        max_attempts: 5,
        runtime_role: "leader",
      },
    });
    expect(screen.getByText("Codex WebSocket 正在重连（2/5）")).toBeInTheDocument();
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();

    emit({
      type: "runtime:transport",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { state: "clear", runtime_role: "leader" },
    });
    expect(screen.getByText("正在思考")).toBeInTheDocument();
  });

  it("renders the real permission-denied session part as rejected, not executed", async () => {
    const user = userEvent.setup();
    const command = "rm /repo/e2e-risk.txt";
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="coder-1" readonly />);

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "coder-1",
      data: {
        cursor: 0,
        messages: [{
          id: "msg-assistant-denied",
          role: "assistant",
          parts: [{
            type: "tool-Bash",
            toolCallId: "call-denied",
            toolName: "Bash",
            capability: "shell",
            providerToolName: "Bash",
            state: "output-available",
            input: { command },
            output: {
              content: `用户已明确拒绝执行该风险命令：${command}。不得在当前 Task 中再次请求或重试完全相同的命令。`,
              is_error: true,
            },
          }],
          content: "",
        }],
      },
    });

    const summary = await screen.findByRole("button", { name: /已拒绝/ });
    expect(summary).not.toHaveTextContent("执行了");
    await user.click(summary);
    expect(screen.getAllByText("已拒绝")).toHaveLength(2);
    expect(screen.queryByText("已执行")).not.toBeInTheDocument();
  });

  it("renders legacy history boundaries as dividers rather than chat messages", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId={null}
        flowExpertId="fexp-frontend"
        readonly
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      flow_expert_id: "fexp-frontend",
      data: [message("legacy-1", "first"), message("legacy-2", "second")],
      history_boundaries: [{
        id: "boundary-2",
        kind: "history_session_boundary",
        flow_expert_id: "fexp-frontend",
        agent_session_id: "ags-2",
        display_name: "Frontend 5924",
        started_at: "2026-06-22T00:01:00.000Z",
        status: "loaded",
        before_message_id: "legacy-2",
      }],
    });

    expect(screen.getByTestId("history-session-boundary")).toHaveTextContent("历史会话：Frontend 5924");
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(2);
    expect(screen.queryByText("历史运行记录：Frontend 5924")).not.toBeInTheDocument();
  });

  it("renders consecutive completed Leader replies as separate assistant messages", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        workRuns={[
          {
            id: "turn-hello",
            triggerMessageId: "msg-user-hello",
            status: "completed",
            startedAt: "2026-07-10T11:18:16.000Z",
            activeStartedAt: "2026-07-10T11:18:16.000Z",
            activeDurationMs: 8_000,
            completedAt: "2026-07-10T11:18:26.000Z",
          },
          {
            id: "turn-capabilities",
            triggerMessageId: "msg-user-capabilities",
            status: "completed",
            startedAt: "2026-07-10T11:18:27.000Z",
            activeStartedAt: "2026-07-10T11:18:27.000Z",
            activeDurationMs: 9_000,
            completedAt: "2026-07-10T11:18:39.000Z",
          },
        ]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        messages: [
          userMessage("msg-user-hello", "你好"),
          message("msg-assistant-hello", "你好！有什么我可以帮你处理的吗？"),
          userMessage("msg-user-capabilities", "你能做什么"),
          message("msg-assistant-capabilities", "我可以帮你分析代码与问题。"),
        ],
      },
    });

    expect(screen.getAllByTestId("chat-message-user")).toHaveLength(2);
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(2);
    expect(screen.getByText("你好！有什么我可以帮你处理的吗？")).toBeInTheDocument();
    expect(screen.getByText("我可以帮你分析代码与问题。")).toBeInTheDocument();
  });

  it("renders completed guided turns as guide bubbles followed by the final summary", async () => {
    const user = userEvent.setup();
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        workRuns={[{
          id: "turn-1",
          triggerMessageId: "msg-user-1",
          status: "completed",
          startedAt: "2026-06-29T06:00:00.000Z",
          activeStartedAt: "2026-06-29T06:00:00.000Z",
          activeDurationMs: 41_000,
          completedAt: "2026-06-29T06:00:41.000Z",
        }]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        messages: [
          userMessage("msg-user-1", "开始调研"),
          message("assistant-before", "调研中间过程"),
          {
            ...userMessage("msg-guide-1", "15遍吧"),
            metadata: {
              localMessageKind: "running-guide",
              guideStatusLabel: "已引导对话",
              browserElementAttachments: [{
                id: "browser-comment-1",
                markerNumber: 1,
                text: "需要解释的按钮",
                selector: "button#explain",
                comment: "这是引导里的评论",
                screenshotDataUrl: "data:image/png;base64,abc",
              }],
              imageAttachments: [{
                id: "browser-comment-image-1",
                kind: "browser_comment",
                mediaType: "image/png",
                dataUrl: "data:image/png;base64,abc",
              }],
            },
          } as UIMessage,
          message("assistant-between-guides", "收到，改成15遍"),
          userMessage("msg-guide-2", "18遍吧"),
          message("assistant-after-guide-2", "收到，改成18遍"),
          userMessage("msg-guide-3", "注意必须要求你没满足"),
          {
            id: "assistant-final",
            role: "assistant",
            parts: [
              { type: "text", text: "最终段过程文本" },
              { type: "text", text: "最终回答内容" },
            ],
            content: "最终段过程文本最终回答内容",
          } as UIMessage,
        ],
      },
    });

    expect(screen.getAllByTestId("chat-message-user")).toHaveLength(1);
    const guideMessages = screen.getAllByTestId("chat-message-guide");
    expect(guideMessages).toHaveLength(3);
    expect(guideMessages[0]).toHaveTextContent("1 条注释");
    await user.hover(within(guideMessages[0]!).getByText("1 条注释"));
    expect(screen.getByText("需要解释的按钮")).toBeInTheDocument();
    expect(screen.getByText("这是引导里的评论")).toBeInTheDocument();
    expect(screen.getByText("15遍吧")).toBeInTheDocument();
    expect(screen.getByText("18遍吧")).toBeInTheDocument();
    expect(screen.getByText("注意必须要求你没满足")).toBeInTheDocument();
    expect(screen.getAllByText("已引导对话")).toHaveLength(1);
    expect(screen.getByText("最终回答内容")).toBeInTheDocument();
    expect(screen.getByText("调研中间过程")).toBeInTheDocument();
    expect(screen.getByText("收到，改成15遍")).toBeInTheDocument();
    expect(screen.getByText("收到，改成18遍")).toBeInTheDocument();
    expect(screen.getByText("最终段过程文本")).toBeInTheDocument();
    expect(screen.queryByText("已工作 41 秒")).not.toBeInTheDocument();

    const firstGuide = screen.getByText("15遍吧");
    const secondGuide = screen.getByText("18遍吧");
    const thirdGuide = screen.getByText("注意必须要求你没满足");
    const finalText = screen.getByText("最终回答内容");
    expect(firstGuide.compareDocumentPosition(secondGuide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(secondGuide.compareDocumentPosition(thirdGuide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(thirdGuide.compareDocumentPosition(finalText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("已引导对话")).toHaveLength(1);
  });

  it("renders the matching completed WorkRun review summary and opens review", () => {
    vi.useFakeTimers();
    const onOpenReview = vi.fn();
    try {
      render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          workRuns={[{
            id: "turn-review",
            triggerMessageId: "msg-user-review",
            status: "completed",
            startedAt: "2026-06-29T06:00:00.000Z",
            activeStartedAt: "2026-06-29T06:00:00.000Z",
            activeDurationMs: 3_000,
            completedAt: "2026-06-29T06:00:03.000Z",
          }]}
          review={{
            flow_id: "flow-1",
            work_run_id: "turn-review",
            completed_at: "2026-06-29T06:00:03.000Z",
            totals: { files: 2, additions: 3, deletions: 1, modified: 2, added: 0, deleted: 0 },
            files: [
              {
                path: "apps/renderer/app/page.tsx",
                status: "modified",
                additions: 2,
                deletions: 1,
                lines: [
                  { kind: "removed", old_line: 1, new_line: null, text: "old" },
                  { kind: "added", old_line: null, new_line: 1, text: "new" },
                ],
              },
              {
                path: "apps/renderer/app/other.tsx",
                status: "modified",
                additions: 1,
                deletions: 0,
                lines: [
                  { kind: "context", old_line: 3, new_line: 3, text: "same" },
                  { kind: "added", old_line: null, new_line: 4, text: "other new" },
                ],
              },
            ],
          }}
          onOpenReview={onOpenReview}
        />,
      );

      emit({
        type: "session:transcript_snapshot",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: {
          cursor: 1,
          messages: [
            userMessage("msg-user-review", "改文件"),
            message("assistant-review", "已完成"),
          ],
        },
      });

      const assistantMessage = screen.getByTestId("chat-message-assistant");
      const reviewSummary = within(assistantMessage).getByTestId("work-run-review-summary");
      expect(reviewSummary).toHaveClass("w-full");
      expect(reviewSummary).toHaveClass("max-w-[820px]");
      expect(reviewSummary).toHaveTextContent("已编辑 2 个文件");
      expect(reviewSummary).toHaveTextContent("apps/renderer/app/page.tsx");
      const assistantCopyButton = within(assistantMessage).getByRole("button", { name: "复制消息" });
      expect(reviewSummary.compareDocumentPosition(assistantCopyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const rows = within(reviewSummary).getAllByTestId("review-file-row");
      const firstRow = rows[0];
      const secondRow = rows[1];
      if (!firstRow || !secondRow) throw new Error("Expected two review file rows");

      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();
      fireEvent.mouseEnter(firstRow);
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      let diffPreview = within(reviewSummary).getByTestId("review-file-diff-preview");
      expect(diffPreview).toHaveTextContent("apps/renderer/app/page.tsx");
      expect(diffPreview).toHaveTextContent("old");
      expect(diffPreview).toHaveTextContent("new");
      expect(within(diffPreview).getByTestId("review-file-diff-preview-body")).toHaveClass("overflow-auto");

      fireEvent.mouseLeave(firstRow);
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(749);
      });
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();

      fireEvent.mouseEnter(secondRow);
      diffPreview = within(reviewSummary).getByTestId("review-file-diff-preview");
      expect(diffPreview).toHaveTextContent("apps/renderer/app/other.tsx");
      expect(diffPreview).toHaveTextContent("other new");

      fireEvent.mouseLeave(secondRow);
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();

      fireEvent.mouseEnter(firstRow);
      expect(within(reviewSummary).queryByTestId("review-file-diff-preview")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(within(reviewSummary).getByTestId("review-file-diff-preview")).toHaveTextContent("apps/renderer/app/page.tsx");

      fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
      expect(onOpenReview).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a running guided reply grouped when its active snapshot arrives first", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        active_turn: {
          message_id: "assistant-active",
          started_at: "2026-06-29T06:00:00.000Z",
        },
        messages: [
          userMessage("msg-user-1", "开始调研"),
          message("assistant-before-guide", "引导前内容"),
          {
            ...userMessage("msg-guide-1", "总共改为18次吧"),
            metadata: {
              localMessageKind: "running-guide",
              guideStatusLabel: "已引导对话",
            },
          } as UIMessage,
          message("assistant-active", "引导后继续执行"),
        ],
      },
    });

    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
    expect(screen.queryByText(/^工作中/)).not.toBeInTheDocument();
    expect(screen.getByText("引导前内容")).toBeInTheDocument();
    expect(screen.getByText("总共改为18次吧")).toBeInTheDocument();
    expect(screen.getByText("引导后继续执行")).toBeInTheDocument();
  });

  it("keeps a tool-free live completed guided turn expanded without waiting for a refreshed history snapshot", () => {
    const activeTurn = {
      id: "turn-live-guided",
      triggerMessageId: "msg-user-live",
      status: "executing",
      startedAt: "2026-06-29T08:58:56.000Z",
      activeStartedAt: "2026-06-29T08:58:56.000Z",
      activeDurationMs: 0,
      completedAt: null,
    };
    const { rerender } = render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        workRuns={[activeTurn]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 0,
        messages: [userMessage("msg-user-live", "开始调研")],
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        event: { type: "turn-started", messageId: "msg-assistant-live", startedAt: "2026-06-29T08:58:56.000Z" },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 2, event: { type: "text-start", messageId: "msg-assistant-live", id: "text-before" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 3, event: { type: "text-delta", messageId: "msg-assistant-live", id: "text-before", delta: "过程 A" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 4,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-1", "19次吧"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 5,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-2", "改成18次吧"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 6,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-3", "12次就行"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 7, event: { type: "text-start", messageId: "msg-assistant-live", id: "text-final" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 8, event: { type: "text-delta", messageId: "msg-assistant-live", id: "text-final", delta: "当前工具第12次调用。\\n\\n最终总结" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 9,
        event: {
          type: "turn-finished",
          messageId: "msg-assistant-live",
          durationMs: 36_000,
          finishedAt: "2026-06-29T08:59:32.000Z",
        },
      },
    });

    rerender(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        workRuns={[{
          ...activeTurn,
          status: "completed",
          activeStartedAt: null,
          activeDurationMs: 36_000,
          completedAt: "2026-06-29T08:59:32.000Z",
        }]}
      />,
    );

    expect(screen.getByText("19次吧")).toBeInTheDocument();
    expect(screen.getByText("改成18次吧")).toBeInTheDocument();
    expect(screen.getByText("12次就行")).toBeInTheDocument();
    expect(screen.getByText(/最终总结/)).toBeInTheDocument();
    expect(screen.getByText("过程 A")).toBeInTheDocument();
  });

  it("keeps the final canonical guide segment when live execution state is unavailable", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 0,
        messages: [userMessage("msg-user-live", "开始调研")],
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        event: { type: "turn-started", messageId: "msg-assistant-live", startedAt: "2026-06-29T09:54:01.000Z" },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 2, event: { type: "reasoning-start", messageId: "msg-assistant-live", id: "reason-before" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 3, event: { type: "reasoning-delta", messageId: "msg-assistant-live", id: "reason-before", delta: "过程 A" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 4,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-1", "22次就行。"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 5, event: { type: "reasoning-start", messageId: "msg-assistant-live:guide-1", id: "reason-guide-1" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 6, event: { type: "reasoning-delta", messageId: "msg-assistant-live:guide-1", id: "reason-guide-1", delta: "过程 B" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 7,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-2", "25次就可以。"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 8, event: { type: "text-start", messageId: "msg-assistant-live:guide-2", id: "text-final" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 9, event: { type: "text-delta", messageId: "msg-assistant-live:guide-2", id: "text-final", delta: "最终总结" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 10,
        event: {
          type: "turn-finished",
          messageId: "msg-assistant-live:guide-2",
          durationMs: 41_000,
          finishedAt: "2026-06-29T09:54:43.000Z",
        },
      },
    });

    expect(screen.getByText("22次就行。")).toBeInTheDocument();
    expect(screen.getByText("25次就可以。")).toBeInTheDocument();
    expect(screen.getByText("最终总结")).toBeInTheDocument();
    expect(screen.queryByText("过程 A")).not.toBeInTheDocument();
    expect(screen.queryByText("过程 B")).not.toBeInTheDocument();
  });

  it("uses a completed snapshot even when its cursor is older than the live finish cursor", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 0,
        messages: [userMessage("msg-user-live", "开始调研")],
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        event: { type: "turn-started", messageId: "msg-assistant-live", startedAt: "2026-06-29T09:54:01.000Z" },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 2,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-guide-live-1", "25次就可以。"),
            metadata: { localMessageKind: "running-guide" },
          } as UIMessage,
        },
      },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 3, event: { type: "text-start", messageId: "msg-assistant-live:guide-1", id: "text-final" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 4, event: { type: "text-delta", messageId: "msg-assistant-live:guide-1", id: "text-final", delta: "当前工具第25次调用" } },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 10,
        event: {
          type: "turn-finished",
          messageId: "msg-assistant-live:guide-1",
          durationMs: 41_000,
          finishedAt: "2026-06-29T09:54:43.000Z",
        },
      },
    });

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 9,
        messages: [
          userMessage("msg-0", "开始调研"),
          {
            ...message("msg-1", "过程 A"),
            metadata: { turnTiming: { startedAt: "2026-06-29T09:54:01.000Z", finishedAt: "2026-06-29T09:54:10.000Z", durationMs: 9_000 } },
          } as UIMessage,
          {
            ...userMessage("msg-guide-live-1", "25次就可以。"),
            metadata: { localMessageKind: "running-guide", guideStatusLabel: "已引导对话" },
          } as UIMessage,
          {
            ...message("msg-5", "当前工具第25次调用\n\n完整目录调研总结"),
            metadata: { turnTiming: { startedAt: "2026-06-29T09:54:01.000Z", finishedAt: "2026-06-29T09:54:43.000Z", durationMs: 41_000 } },
          } as UIMessage,
        ],
      },
    });

    expect(screen.getByText("25次就可以。")).toBeInTheDocument();
    expect(screen.getByText(/完整目录调研总结/)).toBeInTheDocument();
    expect(screen.getByText("过程 A")).toBeInTheDocument();
  });

  it("loads an Expert tab by flow_expert_id", async () => {
    const { wsClient } = await import("../../lib/ws");

    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId={null}
        flowExpertId="fexp-frontend"
        readonly
      />,
    );

    expect(wsClient.sendSessionGet).toHaveBeenCalledWith(
      "flow-1",
      "",
      undefined,
      "fexp-frontend",
    );
  });

  it("requests a resync when an Expert stream event arrives without a started turn", async () => {
    const { wsClient } = await import("../../lib/ws");
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} flowExpertId="fexp-frontend" readonly />);
    vi.mocked(wsClient.sendSessionGet).mockClear();
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      flow_expert_id: "fexp-frontend",
      data: { event: { type: "text-start", id: "text-1" } },
    });
    await waitFor(() => {
      expect(wsClient.sendSessionGet).toHaveBeenCalledWith("flow-1", "", undefined, "fexp-frontend");
    });
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("does not replace the committed Expert transcript when the Expert completes", async () => {
    const { wsClient } = await import("../../lib/ws");
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} flowExpertId="fexp-research" readonly />);
    vi.mocked(wsClient.sendSessionGet).mockClear();

    emit({
      type: "flow_expert:event",
      flow_id: "flow-1",
      data: {
        flow_expert_id: "fexp-research",
        agent_session_id: "ags-research",
        expert_id: "exp-research",
        status: "completed",
      },
    });

    expect(wsClient.sendSessionGet).not.toHaveBeenCalled();
  });

  it("finishes an active Expert transcript when its session is interrupted", async () => {
    const { wsClient } = await import("../../lib/ws");
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} flowExpertId="fexp-coder" readonly />);

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      flow_expert_id: "fexp-coder",
      agent_session_id: "ags-coder",
      data: {
        cursor: 3,
        active_turn: {
          message_id: "assistant-coder",
          started_at: "2026-07-11T13:19:20.000Z",
        },
        messages: [{
          id: "assistant-coder",
          role: "assistant",
          content: "",
          parts: [{
            type: "tool-Write",
            toolCallId: "tool-write",
            toolName: "Write",
            state: "input-available",
            input: { file_path: "login/index.html" },
          }],
        } as unknown as UIMessage],
      },
    });

    expect(screen.getByTestId("chat-message-assistant")).toHaveAttribute("data-transcript-activity", "tool-running");

    emit({
      type: "session:event",
      flow_id: "flow-1",
      data: {
        agent_session_id: "ags-coder",
        flow_expert_id: "fexp-coder",
        expert_id: "exp-coder",
        status: "interrupted",
      },
    });

    expect(screen.getByText("已中断")).toBeVisible();
    expect(screen.getByTestId("chat-message-assistant")).not.toHaveAttribute("data-transcript-activity", "tool-running");
  });

  it("keeps a freshly resolved card result expanded throughout the live page session", async () => {
    const card = {
      card_id: "dc-1",
      card_type: "clarification",
      status: "resolved" as const,
      questions: [{ header: "选择", question: "选哪个？", multiSelect: false, options: [] }],
      answers: { 选择: "重新优化 Hello World" },
    };
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        decisionCards={[card]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 0, messages: [] },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        event: {
          type: "message-added",
          message: {
            ...userMessage("msg-decision-1", "clarification_card_id: dc-1\n用户已回答澄清卡片。"),
            metadata: { decisionCardId: "dc-1", decisionStatus: "resolved" },
          },
        },
      },
    });

    expect(screen.getByTestId("decision-card-result-details")).toBeVisible();

    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "start", messageId: "assistant-after-card" } },
    });

    expect(screen.getByTestId("decision-card-result-details")).toBeVisible();
    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("重新优化 Hello World");
  });

  it("keeps cancelled card results as decision cards inside grouped Leader replies", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        decisionCards={[{
          card_id: "dc-1",
          card_type: "clarification",
          status: "cancelled",
          questions: [{ header: "类型", question: "选择任务类型", multiSelect: false, options: [] }],
          answers: {},
        }]}
        workRuns={[{
          id: "turn-1",
          triggerMessageId: "msg-user-1",
          status: "completed",
          startedAt: "2026-06-29T06:00:00.000Z",
          activeStartedAt: "2026-06-29T06:00:00.000Z",
          activeDurationMs: 12_000,
          completedAt: "2026-06-29T06:00:12.000Z",
        }]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 1,
        messages: [
          userMessage("msg-user-1", "开始"),
          message("assistant-before-card", "我已经向你提出了一个问题"),
          {
            ...userMessage("msg-decision-1", "clarification_card_id: dc-1\n用户取消了本次澄清卡片。"),
            metadata: { decisionCardId: "dc-1", decisionStatus: "cancelled" },
          } as UIMessage,
          message("assistant-after-card", "后续说明"),
        ],
      },
    });

    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("已取消");
    expect(screen.queryByText(/clarification_card_id/)).not.toBeInTheDocument();
    expect(screen.queryByText("用户取消了本次澄清卡片。")).not.toBeInTheDocument();
  });

  it("renders historical card results shallow-collapsed", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        decisionCards={[{
          card_id: "dc-1",
          card_type: "clarification",
          status: "resolved",
          questions: [{ header: "选择", question: "选哪个？", multiSelect: false, options: [] }],
          answers: { 选择: "重新优化 Hello World" },
        }]}
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [{
        ...userMessage(
          "msg-decision-1",
          "clarification_card_id: dc-1\n用户已回答澄清卡片。\n\n1. 选择\n回答：重新优化 Hello World",
        ),
        metadata: { decisionCardId: "dc-1", decisionStatus: "resolved" },
      } as UIMessage],
    });

    expect(screen.queryByTestId("decision-card-result-details")).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("重新优化 Hello World");
  });

  it("renders only history for the selected agent session", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "worker-1",
      data: [message("m-worker", "worker text")],
    });
    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [message("m-leader", "leader text")],
    });

    expect(await screen.findByText("leader text")).toBeInTheDocument();
    expect(screen.queryByText("worker text")).not.toBeInTheDocument();
  });

  it("hides history messages that only contain reasoning when reasoning visibility is turned off", async () => {
    render(
      <SessionTranscriptPanel
        {...({
          flowId: "flow-1",
          agentSessionId: "leader-1",
          readonly: true,
          showReasoning: false,
        } as any)}
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          id: "reasoning-only",
          role: "assistant",
          content: "",
          parts: [{ type: "reasoning", text: "内部思考", state: "done" }],
        } as unknown as UIMessage,
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText("内部思考")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /思考过程/ })).toBeNull();
  });

  it("keeps rendered messages when the selected agent session becomes null", async () => {
    const { rerender } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [message("m-leader", "leader text")],
    });

    expect(await screen.findByText("leader text")).toBeInTheDocument();

    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly />);

    expect(screen.getByText("leader text")).toBeInTheDocument();
  });

  it("refetches history after the selected agent session becomes null and returns to the same session", async () => {
    const { wsClient } = await import("../../lib/ws");
    const { rerender } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(1);
    expect(wsClient.sendSessionGet).toHaveBeenLastCalledWith("flow-1", "", "leader-1");

    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly />);
    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    expect(wsClient.sendSessionGet).toHaveBeenCalledTimes(2);
    expect(wsClient.sendSessionGet).toHaveBeenLastCalledWith("flow-1", "", "leader-1");
  });

  it("clears old real-session messages after real to null to different real", async () => {
    const { rerender } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [message("m-leader", "leader text")],
    });

    expect(await screen.findByText("leader text")).toBeInTheDocument();

    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly />);

    expect(screen.getByText("leader text")).toBeInTheDocument();

    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId="worker-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "worker-1",
      data: [message("m-worker", "worker text")],
    });

    expect(await screen.findByText("worker text")).toBeInTheDocument();
    expect(screen.queryByText("leader text")).not.toBeInTheDocument();
  });

  it("clears loading overlay when the selected agent session becomes null while loading", () => {
    const { rerender } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    expect(screen.getByText("加载消息...")).toBeInTheDocument();

    rerender(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly />);

    expect(screen.queryByText("加载消息...")).not.toBeInTheDocument();
  });

  it("clears loading overlay when the live turn starts before the snapshot arrives", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    expect(screen.getByText("加载消息...")).toBeInTheDocument();

    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "start", messageId: "a-live" } },
    });

    expect(screen.queryByText("加载消息...")).not.toBeInTheDocument();
  });

  it("streams text deltas into the selected session", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "start", messageId: "a1" } },
    });
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "text-start" } },
    });
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "text-delta", delta: "hello" } },
    });

    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  });

  it("infers the agent session from the first live event when enabled", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly allowInferredAgentSessionId />);

    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "start", messageId: "a1" } },
    });
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "text-start" } },
    });
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "text-delta", delta: "hello" } },
    });

    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  });

  it("does not infer an agent session unless enabled", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId={null} readonly />);

    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "start", messageId: "a1" } },
    });
    emit({
      type: "session:chat_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { event: { type: "text-delta", delta: "hello" } },
    });

    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("renders text deltas that arrive after a tool result in the same assistant message", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    const emitEvent = (event: any) =>
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });

    emitEvent({ type: "start", messageId: "a1" });
    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "before tool" });
    emitEvent({ type: "text-end" });
    emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
    emitEvent({
      type: "tool-input-available",
      toolName: "mcp__squadflow-leader__get_context",
      toolCallId: "tool-1",
      input: { flow_id: "flow-1" },
    });
    emitEvent({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "{}", is_error: false },
    });
    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "after tool" });

    await waitFor(() => expect(screen.getByText("before tool")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("after tool")).toBeInTheDocument());
  });

  it("renders final text after reasoning and tool events in the same assistant message", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    const emitEvent = (event: any) =>
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });

    emitEvent({ type: "start", messageId: "assistant-1" });
    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "先查看 flow 状态" });
    emitEvent({ type: "reasoning-end" });
    emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
    emitEvent({
      type: "tool-input-available",
      toolName: "mcp__squadflow-leader__get_context",
      toolCallId: "tool-1",
      input: { flow_id: "flow-1" },
    });
    emitEvent({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "{}", is_error: false },
    });
    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "准备回复用户" });
    emitEvent({ type: "reasoning-end" });
    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "你好！欢迎来到 SquadFlow。" });
    emitEvent({ type: "text-end" });
    emitEvent({ type: "finish" });

    await waitFor(() => expect(screen.getByText("你好！欢迎来到 SquadFlow。")).toBeInTheDocument());
  });

  it("keeps a live assistant message when an early user-only snapshot arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId={null}
        readonly
        optimisticMessages={[userMessage("msg-user-1", "你好")]}
        isAwaitingResponse
        allowInferredAgentSessionId
      />,
    );

    const emitEvent = (event: any) =>
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });

    emitEvent({ type: "start", messageId: "assistant-1" });

    rerender(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[userMessage("msg-user-1", "你好")]}
        isAwaitingResponse
        allowInferredAgentSessionId
      />,
    );

    emit({
      type: "session:snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [userMessage("msg-user-1", "你好")],
    });

    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "先查看状态" });
    emitEvent({ type: "reasoning-end" });
    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "你好！我是 Leader。" });
    emitEvent({ type: "text-end" });
    emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
    emitEvent({
      type: "tool-input-available",
      toolName: "mcp__squadflow-leader__get_context",
      toolCallId: "tool-1",
      input: { flow_id: "flow-1" },
    });
    emitEvent({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { content: "{}", is_error: false },
    });
    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "准备回复" });
    emitEvent({ type: "reasoning-end" });
    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "请告诉我你的具体需求。" });
    emitEvent({ type: "text-end" });
    emitEvent({ type: "finish" });

    expect(screen.getByText("请告诉我你的具体需求。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /已工作 1 秒/ }));
    expect(screen.getByText("你好！我是 Leader。")).toBeInTheDocument();
  });

  it("renders final text from history after reasoning and tool parts", async () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        userMessage("msg-0", "你好"),
        {
          id: "msg-1",
          role: "assistant",
          content: "你好！欢迎来到 SquadFlow。",
          parts: [
            { type: "reasoning", text: "先查看 flow 状态", state: "done" },
            {
              type: "tool-mcp__squadflow-leader__get_context",
              toolCallId: "tool-1",
              toolName: "mcp__squadflow-leader__get_context",
              state: "output-available",
              inputText: "",
              input: { flow_id: "flow-1" },
              output: { content: "{}", is_error: false },
            },
            { type: "reasoning", text: "准备回复用户", state: "done" },
            { type: "text", text: "你好！欢迎来到 SquadFlow。" },
          ],
        } as unknown as UIMessage,
      ],
    });

    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(screen.getByText("你好！欢迎来到 SquadFlow。")).toBeInTheDocument();
  });

  it("does not show a work header for history messages without timing", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          id: "msg-1",
          role: "assistant",
          content: "hello",
          parts: [{ type: "text", text: "hello" }],
        } as unknown as UIMessage,
      ],
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByText(/已工作|工作中/)).not.toBeInTheDocument();
  });

  it("shows 已工作 X 秒 for history messages with persisted durationMs", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          id: "msg-1",
          role: "assistant",
          content: "hello",
          parts: [
            {
              type: "tool-bash",
              toolCallId: "tool-1",
              toolName: "bash",
              state: "output-available",
              input: { command: "ls" },
              output: { stdout: "a.txt", stderr: "", exit_code: 0 },
            },
            { type: "text", text: "hello" },
          ],
          metadata: {
            turnTiming: {
              startedAt: "2026-06-19T10:00:00.000Z",
              finishedAt: "2026-06-19T10:00:03.000Z",
              durationMs: 3000,
            },
          },
        } as unknown as UIMessage,
      ],
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("已工作 3 秒")).toBeInTheDocument();
  });

  it("does not show the work header for a finished text-only turn", () => {
    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          id: "msg-1",
          role: "assistant",
          content: "hello",
          parts: [{ type: "text", text: "hello" }],
          metadata: {
            turnTiming: {
              startedAt: "2026-06-19T10:00:00.000Z",
              finishedAt: "2026-06-19T10:00:03.000Z",
              durationMs: 3000,
            },
          },
        } as unknown as UIMessage,
      ],
    });

    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByText("已工作 3 秒")).not.toBeInTheDocument();
  });

  it("keeps the original start time through text and tool events", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event: { type: "start", messageId: "a1", startedAt: new Date(startTime - 5000).toISOString() } },
      });

      expect(screen.getByText("正在思考")).toBeInTheDocument();
      expect(screen.queryByText(/^工作中/)).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1100);
      });

      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event: { type: "text-start", id: "text-1" } },
      });
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event: { type: "text-delta", id: "text-1", delta: "继续处理" } },
      });
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event: { type: "tool-input-start", toolCallId: "tool-1", toolName: "Read" } },
      });

      act(() => {
        // Streaming text/tool updates are intentionally merged once per
        // animation frame; advance that frame before asserting the UI.
        vi.advanceTimersByTime(20);
      });
      expect(screen.getByText("工作中 6 秒")).toBeInTheDocument();

      act(() => {
        vi.setSystemTime(startTime + 7200);
      });

      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event: { type: "finish", durationMs: 7200 } },
      });

      expect(screen.getByText("已工作 7 秒")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders transcript content without overflow-y-hidden", () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[userMessage("msg-user-1", "你好")]}
      />,
    );

    const thread = screen.getByTestId("transcript-thread");
    expect(thread.className).not.toMatch(/overflow-y-hidden/);
    expect(thread).toBeInTheDocument();
  });

  it("aligns user messages to the right side of the transcript", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[userMessage("msg-user-1", "你好")]}
      />,
    );

    const userRow = await screen.findByTestId("chat-message-user");
    expect(userRow.className).toMatch(/userRow/);
    expect(screen.getByText("你好").closest("div")?.className).toMatch(/userBubble/);
  });

  it("renders canonical Skill and MCP Markdown as inline tokens in user messages", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[
          userMessage(
            "msg-user-1",
            "请使用 [$grill-me](/Users/test/.claude/skills/grill-me/SKILL.md) 和 [@context7](/.squadflow/mcp/context7) 查询",
          ),
        ]}
      />,
    );

    expect((await screen.findByText("Grill Me")).parentElement).toHaveClass("text-sky-400");
    expect(screen.getByText("Context7 MCP").parentElement).toHaveClass("text-sky-400");
    expect(screen.queryByText(/SKILL\.md|\\.squadflow/u)).not.toBeInTheDocument();
  });

  it("renders user message timestamp when createdAt is available", async () => {
    const createdAt = new Date();
    createdAt.setHours(9, 10, 0, 0);

    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[
          {
            ...userMessage("msg-user-1", "你好"),
            createdAt,
          } as UIMessage,
        ]}
      />,
    );

    expect(await screen.findByText("09:10")).toBeInTheDocument();
  });

  it("renders persisted user message time from created_at", async () => {
    const createdAt = new Date();
    createdAt.setHours(23, 10, 0, 0);

    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          ...userMessage("history-user-1", "历史消息"),
          created_at: createdAt.toISOString(),
        } as UIMessage,
      ],
    });

    expect((await screen.findByText("历史消息")).closest("div")?.className).toMatch(/userBubble/);
    expect(screen.getByText("23:10")).toBeInTheDocument();
  });

  it("copies user message text from the transcript action", async () => {
    const user = userEvent.setup();

    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[userMessage("msg-user-1", "复制这条消息")]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "复制消息" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "已复制消息" })).toBeInTheDocument();
    });
  });

  it("does not duplicate a resolved decision card at the assistant ask_user position", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        decisionCards={[
          {
            card_id: "dc-1",
            card_type: "generic",
            status: "pending",
            questions: [
              {
                question: "请选择需求类型",
                header: "需求类型",
                multiSelect: false,
                options: [
                  { label: "新功能开发", description: "新增功能" },
                  { label: "Bug 修复", description: "修复问题" },
                ],
              },
            ],
          },
        ]}
        decisionCardStatuses={{ "dc-1": "resolved" }}
        decisionCardAnswers={{ "dc-1": { "需求类型": "新功能开发" } }}
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
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
                card_type: "generic",
                questions: [
                  {
                    question: "请选择需求类型",
                    header: "需求类型",
                    multiSelect: false,
                    options: [
                      { label: "新功能开发", description: "新增功能" },
                      { label: "Bug 修复", description: "修复问题" },
                    ],
                  },
                ],
              },
              output: { content: "{\"card_id\":\"dc-1\"}", is_error: false },
            },
          ],
        } as unknown as UIMessage,
      ],
    });

    await waitFor(() => expect(screen.queryByTestId("decision-card-resolved")).not.toBeInTheDocument());
    expect(screen.queryByText("已提交决策")).not.toBeInTheDocument();
    expect(screen.queryByText("新功能开发")).not.toBeInTheDocument();
  });

  it("renders create_plan spec cards inline with the related assistant message", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        specCards={{
          "sca-1": {
            spec_approval_id: "sca-1",
            spec_revision_id: "spec-1",
            status: "approved",
            file_name: "Web_d8f00163.md",
            overview: "开发一个四则运算计算器",
            actions: ["run"],
          },
        }}
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
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
                    file_name: "Web_d8f00163.md",
                    overview: "开发一个四则运算计算器",
                  },
                  spec_approval: {
                    spec_approval_id: "sca-1",
                  },
                }),
                is_error: false,
              },
            },
          ],
        } as unknown as UIMessage,
      ],
    });

    expect(await screen.findByText("Spec Web_d8f00163.md")).toBeInTheDocument();
    expect(screen.getByText("开发一个四则运算计算器")).toBeInTheDocument();
    expect(screen.getAllByTestId("spec-card-sca-1")).toHaveLength(1);
  });

  it("restores a pending spec card when Codex history omits MCP tool calls", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        specCards={{
          "sca-cold": {
            spec_approval_id: "sca-cold",
            spec_revision_id: "spec-cold",
            status: "pending",
            file_name: "Cold_Load.md",
            overview: "Restore the durable Spec approval.",
            actions: ["run"],
          },
        }}
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [{
        id: "codex-history-text-only",
        role: "assistant",
        content: "Spec 已生成，等待审批。",
        parts: [{ type: "text", text: "Spec 已生成，等待审批。" }],
      } as unknown as UIMessage],
    });

    expect(await screen.findByText("Spec Cold_Load.md")).toBeInTheDocument();
    expect(screen.getByText("Restore the durable Spec approval.")).toBeInTheDocument();
    expect(screen.getAllByTestId("spec-card-sca-cold")).toHaveLength(1);
  });

  it("collapses completed tool attachments and expands on click", async () => {
    const user = userEvent.setup();

    render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

    emit({
      type: "session:history",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [
        {
          id: "msg-tool",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool-mcp__squadflow-leader__get_context",
              toolCallId: "tool-1",
              toolName: "mcp__squadflow-leader__get_context",
              state: "output-available",
              input: { flow_id: "flow-1" },
              output: { content: "{}", is_error: false },
            },
          ],
        } as unknown as UIMessage,
      ],
    });

    const summary = await screen.findByRole("button", { name: /调用了 1 个 MCP 工具/ });
    expect(summary).toBeInTheDocument();
    expect(screen.queryByText("工具调用（tool）")).not.toBeInTheDocument();

    await user.click(summary);
    expect(screen.getByText("已读取")).toBeInTheDocument();
  });

  it("keeps an immediately submitted next turn after the completed turn it follows", async () => {
    const previousUser = {
      ...userMessage("msg-user-previous", "上一轮问题"),
      createdAt: "2026-07-18T06:10:45.876Z",
    } as UIMessage;
    const previousAssistant = {
      ...message("msg-assistant-previous", "上一轮回复"),
      createdAt: "2026-07-18T06:10:45.899Z",
      metadata: {
        turnTiming: {
          startedAt: "2026-07-18T06:10:45.899Z",
          finishedAt: "2026-07-18T06:10:50.291Z",
          durationMs: 4392,
        },
      },
    } as UIMessage;
    const previousTurn: WorkRunDisplay = {
      id: "turn-previous",
      triggerMessageId: previousUser.id,
      status: "completed",
      startedAt: "2026-07-18T06:10:45.876Z",
      activeStartedAt: null,
      activeDurationMs: 4392,
      completedAt: "2026-07-18T06:10:50.291Z",
    };
    const nextUser = {
      ...userMessage("msg-user-next", "下一轮立即发送"),
      createdAt: "2026-07-18T06:10:50.314Z",
    } as UIMessage;
    const nextTurn: WorkRunDisplay = {
      id: "turn-next",
      triggerMessageId: nextUser.id,
      status: "executing",
      startedAt: "2026-07-18T06:10:50.314Z",
      activeStartedAt: "2026-07-18T06:10:50.314Z",
      activeDurationMs: 0,
      completedAt: null,
    };

    const { container, rerender } = render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        workRuns={[previousTurn]}
      />,
    );

    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 10, messages: [previousUser, previousAssistant] },
    });
    await waitFor(() => expect(screen.getByText("上一轮回复")).toBeInTheDocument());

    rerender(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[nextUser]}
        workRuns={[previousTurn, nextTurn]}
        isAwaitingResponse
      />,
    );
    await waitFor(() => expect(screen.getByText("下一轮立即发送")).toBeInTheDocument());

    // A completion resync can arrive after the next message was submitted,
    // but before the next assistant turn starts. It must not move the local
    // message ahead of the completed snapshot it originally followed.
    emit({
      type: "session:transcript_snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: { cursor: 11, messages: [previousUser, previousAssistant] },
    });
    emit({
      type: "session:transcript_event",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: {
        cursor: 12,
        event: {
          type: "turn-started",
          messageId: "msg-assistant-next",
          startedAt: "2026-07-18T06:10:50.337Z",
        },
      },
    });

    await waitFor(() => expect(screen.getByText("正在思考")).toBeInTheDocument());
    const text = container.textContent ?? "";
    expect(text.indexOf("上一轮回复")).toBeLessThan(text.indexOf("下一轮立即发送"));
    expect(text.indexOf("下一轮立即发送")).toBeLessThan(text.lastIndexOf("正在思考"));
  });

  it("renders annotation previews from user-message metadata", async () => {
    const user = userEvent.setup();
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
      />,
    );

    emit({
      type: "session:snapshot",
      flow_id: "flow-1",
      agent_session_id: "leader-1",
      data: [{
        ...userMessage("msg-user-browser", "那这两也发出来吧"),
        metadata: {
          browserElementAttachments: [
            {
              id: "browser-1",
              tagName: "button",
              text: "切换到前一个任务",
              selector: "button#previous",
              role: "button",
              ariaLabel: "切换到前一个任务",
              title: "",
              url: "http://localhost:3000/",
              pageTitle: "SquadFlow",
              markerNumber: 1,
              comment: "标记1",
              screenshotDataUrl: "data:image/png;base64,abc",
              viewport: { width: 1327, height: 963 },
              rect: { x: 66, y: 34, width: 151, height: 40 },
              attributes: { id: "previous", className: "", href: "", name: "", type: "button" },
            },
            {
              id: "browser-2",
              tagName: "button",
              text: "切换到后一个任务",
              selector: "button#next",
              role: "button",
              ariaLabel: "切换到后一个任务",
              title: "",
              url: "http://localhost:3000/",
              pageTitle: "SquadFlow",
              markerNumber: 2,
              comment: "标记2",
              screenshotDataUrl: "data:image/png;base64,def",
              viewport: { width: 1327, height: 963 },
              rect: { x: 115, y: 29, width: 151, height: 40 },
              attributes: { id: "next", className: "", href: "", name: "", type: "button" },
            },
          ],
        },
      } as UIMessage],
    });

    expect(await screen.findByText("那这两也发出来吧")).toBeInTheDocument();
    expect(screen.getByText("2 条注释")).toBeInTheDocument();
    const previewButtons = screen.getAllByRole("button", { name: /预览网页注释/ });
    expect(previewButtons).toHaveLength(2);
    expect(screen.queryByText("Browser comments")).not.toBeInTheDocument();
    expect(screen.queryByText("标记1")).not.toBeInTheDocument();

    await user.click(previewButtons[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.hover(screen.getByText("2 条注释"));
    expect(await screen.findByText("标记1")).toBeInTheDocument();
    expect(screen.getByText("标记2")).toBeInTheDocument();
  });

  it("does not append a stale thinking indicator after rendered assistant history", async () => {
    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId={null}
        flowExpertId="fexp-frontend"
        readonly
        isAwaitingResponse
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      flow_expert_id: "fexp-frontend",
      data: [message("assistant-1", "Expert output")],
    });

    await waitFor(() => expect(screen.getByText("Expert output")).toBeInTheDocument());
    expect(screen.queryAllByText((_, element) => element?.textContent === "正在思考")).toHaveLength(0);
  });

  it("renders Expert history in server order when assistant timing starts before user createdAt", async () => {
    const { container } = render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId={null}
        flowExpertId="fexp-frontend"
        readonly
      />,
    );

    emit({
      type: "session:history",
      flow_id: "flow-1",
      flow_expert_id: "fexp-frontend",
      data: [
        {
          ...userMessage("msg-user-sdk", "请修复一下吧"),
          createdAt: "2026-06-23T09:21:48.817Z",
        },
        {
          ...message("msg-assistant-sdk", "修复完成"),
          metadata: {
            turnTiming: {
              startedAt: "2026-06-23T09:21:47.904Z",
              finishedAt: "2026-06-23T09:22:12.000Z",
              durationMs: 24096,
            },
          },
        },
      ] as UIMessage[],
    });

    await waitFor(() => expect(screen.getByText("修复完成")).toBeInTheDocument());
    const text = container.textContent || "";
    expect(text.indexOf("请修复一下吧")).toBeLessThan(text.indexOf("修复完成"));
  });

  it("keeps the fixed thinking slot through reasoning and hides it after the first text appears", async () => {
    function emitEvent(event: any) {
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });
    }

    render(
      <SessionTranscriptPanel
        flowId="flow-1"
        agentSessionId="leader-1"
        readonly
        optimisticMessages={[userMessage("msg-user-1", "你好")]}
        isAwaitingResponse
      />,
    );

    const thinking = await screen.findAllByText((_, element) => element?.textContent === "正在思考");
    expect(thinking.length).toBeGreaterThanOrEqual(1);

    emitEvent({ type: "start", messageId: "assistant-1" });

    expect(screen.getAllByText((_, element) => element?.textContent === "正在思考").length).toBeGreaterThanOrEqual(1);

    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "先分析一下" });

    expect(
      screen.queryAllByText((_, element) => element?.textContent === "正在思考").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("先分析一下")).not.toBeInTheDocument();

    emitEvent({ type: "text-start" });
    emitEvent({ type: "text-delta", delta: "首字" });

    await waitFor(() => expect(screen.getByText("首字")).toBeInTheDocument());
    expect(screen.queryAllByText((_, element) => element?.textContent === "正在思考")).toHaveLength(0);
  });

  it("keeps showing thinking while reasoning is hidden during a live turn", async () => {
    function emitEvent(event: any) {
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });
    }

    render(
      <SessionTranscriptPanel
        {...({
          flowId: "flow-1",
          agentSessionId: "leader-1",
          readonly: true,
          optimisticMessages: [userMessage("msg-user-1", "你好")],
          isAwaitingResponse: true,
          showReasoning: false,
        } as any)}
      />,
    );

    expect(await screen.findByText("正在思考")).toBeInTheDocument();

    emitEvent({ type: "start", messageId: "assistant-1" });
    emitEvent({ type: "reasoning-start" });
    emitEvent({ type: "reasoning-delta", delta: "先分析一下" });

    expect(screen.getByText("正在思考")).toBeInTheDocument();
    expect(screen.queryByText("先分析一下")).toBeNull();
  });

  describe("realtime activity state", () => {
    function emitEvent(event: any) {
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });
    }

    it("marks the assistant message as waiting after start", async () => {
      render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          isAwaitingResponse
        />,
      );

      emitEvent({ type: "start", messageId: "a1" });

      const marker = await screen.findByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("switches activity to reasoning after reasoning delta and drops waiting", async () => {
      render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          isAwaitingResponse
        />,
      );

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "reasoning-start" });
      emitEvent({ type: "reasoning-delta", delta: "分析中" });

      const marker = await screen.findByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "reasoning");
    });

    it("switches activity to text after text delta", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "text-start" });
      emitEvent({ type: "text-delta", delta: "hello" });

      await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "text");
    });

    it("shows thinking after a canonical text block closes while the turn remains active", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "text-start", id: "text-1" });
      emitEvent({ type: "text-delta", id: "text-1", delta: "Now I have a comprehensive understanding." });
      emitEvent({ type: "text-end", id: "text-1" });

      await waitFor(() => expect(screen.getByText("Now I have a comprehensive understanding.")).toBeInTheDocument());
      expect(screen.getByText("正在思考")).toBeInTheDocument();
      expect(screen.getByTestId("chat-message-assistant")).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps the completed tool title pinned after text-start until text content arrives", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "Read", toolCallId: "read-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "Read",
        toolCallId: "read-1",
        input: { file_path: "README.md" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "read-1",
        output: { content: "README content", is_error: false },
      });
      emitEvent({ type: "text-start", id: "text-after-read" });

      await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());
      expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps the committed live turn without reloading a second history source", async () => {
      const { wsClient } = await import("../../lib/ws");
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);
      vi.mocked(wsClient.sendSessionGet).mockClear();

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "finish", messageId: "a1", durationMs: 9000, finishedAt: "2026-06-24T08:57:52.463Z" });

      expect(wsClient.sendSessionGet).not.toHaveBeenCalled();
    });

    it("replaces an incomplete live finished turn with snapshot final text", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "Write", toolCallId: "write-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "Write",
        toolCallId: "write-1",
        input: { file_path: "README.md", content: "# README" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "write-1",
        output: { content: "updated", is_error: false },
      });
      emitEvent({ type: "finish", messageId: "a1", durationMs: 9000, finishedAt: "2026-06-24T08:57:52.463Z" });

      emit({
        type: "session:transcript_snapshot",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: {
          cursor: 999,
          messages: [
            {
              id: "a1-history",
              role: "assistant",
              parts: [
                {
                  type: "tool-Write",
                  toolCallId: "write-1",
                  toolName: "Write",
                  state: "output-available",
                  inputText: "",
                  input: { file_path: "README.md", content: "# README" },
                  output: { content: "updated", is_error: false },
                },
                {
                  type: "text",
                  text: "已将 README.md 从 61 行精简至 9 行（减少约 85%）。",
                },
              ],
              content: "已将 README.md 从 61 行精简至 9 行（减少约 85%）。",
              metadata: {
                turnTiming: {
                  startedAt: "2026-06-24T08:57:42.941Z",
                  finishedAt: "2026-06-24T08:57:52.463Z",
                  durationMs: 9094,
                },
              },
            },
          ],
        },
      } as unknown as WsInMessage);

      await waitFor(() => {
        expect(screen.getByText("已将 README.md 从 61 行精简至 9 行（减少约 85%）。")).toBeInTheDocument();
      });
    });

    it("ignores duplicate realtime events with the same messageId and seq", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1", seq: 0 });
      emitEvent({ type: "text-start", messageId: "a1", seq: 1, id: "text-1" });
      emitEvent({ type: "text-delta", messageId: "a1", seq: 2, id: "text-1", delta: "hello" });
      emitEvent({ type: "text-delta", messageId: "a1", seq: 2, id: "text-1", delta: "hello" });

      await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
      expect(screen.queryByText("hellohello")).not.toBeInTheDocument();
    });

    it("shows the tool row immediately after tool-input-start in a running state before any output", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });

      // Tool row appears immediately, before tool-input-available or tool-output-available.
      const row = await screen.findByRole("button", { name: /Context/ });
      expect(row).toBeInTheDocument();
      // input-streaming maps to the running status label in the timeline renderer.
      expect(row).toHaveTextContent(/读取中/);
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "tool-running");
    });

    it("shows dispatch preparation before the dispatch_agent result arrives", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({
        type: "tool-input-start",
        toolName: "mcp__squadflow-leader__dispatch_agent",
        toolCallId: "dispatch-1",
      });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__dispatch_agent",
        toolCallId: "dispatch-1",
        input: { expert_id: "exp-frontend", task_id: "task-1" },
      });

      const row = await screen.findByRole("button", { name: /exp-frontend/ });
      expect(row).toHaveTextContent("准备派遣");
      expect(row).toHaveTextContent("Agent");
      expect(row).toHaveTextContent("exp-frontend");
    });

    it("requests a resync if a tool event arrives before the start event", async () => {
      const { wsClient } = await import("../../lib/ws");
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({
        type: "tool-input-start",
        toolName: "mcp__squadflow-leader__dispatch_agent",
        toolCallId: "dispatch-early",
      });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__dispatch_agent",
        toolCallId: "dispatch-early",
        input: { expert_id: "exp-frontend", task_id: "task-1" },
      });

      await waitFor(() => {
        expect(wsClient.sendSessionGet).toHaveBeenCalledWith("flow-1", "", "leader-1", undefined);
      });
      expect(screen.queryByRole("button", { name: /exp-frontend/ })).not.toBeInTheDocument();
    });

    it("pins the same toolCallId in the active slot after tool output while activity returns to waiting", async () => {
      const user = userEvent.setup();
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "{}", is_error: false },
      });

      const activeSlot = await screen.findByRole("button", { name: /Context/ });
      expect(activeSlot).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /正在思考/ })).not.toBeInTheDocument();

      await user.click(activeSlot);
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(2);
      expect(screen.getAllByText("已读取").length).toBeGreaterThanOrEqual(2);

      // Activity fell back to waiting because no tool is still running.
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps the completed tool batch pinned in the active slot while the assistant is waiting on the next step", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "Read", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "Read",
        toolCallId: "tool-1",
        input: { file_path: "/repo/index.html" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "<html></html>", is_error: false },
      });
      emitEvent({ type: "text-start", messageId: "a1", id: "text-2" });

      expect(await screen.findByText("index.html")).toBeInTheDocument();
      expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-message-assistant")).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps prior tool batches and text visible while switching to the next active tool", async () => {
      render(
        <SessionTranscriptPanel
          {...({
            flowId: "flow-1",
            agentSessionId: "leader-1",
            readonly: true,
            showReasoning: false,
          } as any)}
        />,
      );

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "Read", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "Read",
        toolCallId: "tool-1",
        input: { file_path: "/repo/a.txt" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "a", is_error: false },
      });
      emitEvent({ type: "text-start", messageId: "a1", id: "text-1" });
      emitEvent({ type: "text-delta", messageId: "a1", id: "text-1", delta: "text-1" });
      emitEvent({ type: "text-end", messageId: "a1", id: "text-1" });
      emitEvent({ type: "reasoning-start", messageId: "a1", id: "reasoning-1" });
      emitEvent({ type: "reasoning-delta", messageId: "a1", id: "reasoning-1", delta: "internal" });

      const thinkingSlot = await screen.findByRole("button", { name: /正在思考/ });
      expect(thinkingSlot).toHaveAttribute("aria-expanded", "false");

      emitEvent({ type: "tool-input-start", toolName: "Read", toolCallId: "tool-2" });
      emitEvent({
        type: "tool-input-available",
        toolName: "Read",
        toolCallId: "tool-2",
        input: { file_path: "/repo/b.txt" },
      });

      const activeTool = await screen.findByText("b.txt");
      expect(activeTool).toBeInTheDocument();
      expect(screen.getByText("a.txt")).toBeVisible();
      expect(screen.getByText("text-1")).toBeVisible();
      expect(screen.queryAllByRole("button", { name: /正在思考/ })).toHaveLength(0);
      expect(screen.queryByRole("button", { name: /读取了 1 个文件/ })).not.toBeInTheDocument();
    });

    it("keeps activity as tool-running when another tool is still running after an output", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-2" });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "{}", is_error: false },
      });

      await screen.findByRole("button", { name: /Context/ });
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "tool-running");
    });

    it("does not create a duplicate tool row for repeated tool-input-start with the same toolCallId", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });

      await screen.findByRole("button", { name: /Context/ });
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(1);
      // The single row is still running before any output.
      expect(screen.getByRole("button", { name: /Context/ })).toHaveTextContent(/读取中/);
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "tool-running");
    });

    it("keeps a completed tool completed when a duplicate tool-input-start arrives after output", async () => {
      const user = userEvent.setup();
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "{}", is_error: false },
      });

      // Duplicate start for the already-completed tool must not add a row or
      // revert the state.
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });

      const activeSlot = await screen.findByRole("button", { name: /Context/ });
      await user.click(activeSlot);
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(2);
      expect(screen.getAllByText("已读取").length).toBeGreaterThanOrEqual(2);

      // Activity stays waiting (no running tool) instead of flipping back to tool-running.
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps a completed tool terminal when a duplicate tool-input-available arrives after output", async () => {
      const user = userEvent.setup();
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "{}", is_error: false },
      });

      // Duplicate tool-input-available for the completed tool must not revert
      // it to input-available nor flip the activity back to tool-running.
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });

      const activeSlot = await screen.findByRole("button", { name: /Context/ });
      await user.click(activeSlot);
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(2);
      expect(screen.getAllByText("已读取").length).toBeGreaterThanOrEqual(2);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("keeps a single running tool row when tool-input-available is repeated before output", async () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });
      // Duplicate tool-input-available while the tool is still running: no new
      // row, activity stays tool-running.
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });

      await screen.findByRole("button", { name: /Context/ });
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(1);
      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "tool-running");
    });

    it("ignores tool-input-delta for an already completed tool", async () => {
      const user = userEvent.setup();
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({ type: "tool-input-start", toolName: "mcp__squadflow-leader__get_context", toolCallId: "tool-1" });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__get_context",
        toolCallId: "tool-1",
        input: { flow_id: "flow-1" },
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { content: "{}", is_error: false },
      });

      // A late input delta for the completed tool must not add a row or revert
      // state.
      emitEvent({ type: "tool-input-delta", toolCallId: "tool-1", inputTextDelta: "late" });

      const activeSlot = await screen.findByRole("button", { name: /Context/ });
      await user.click(activeSlot);
      expect(screen.getAllByRole("button", { name: /Context/ })).toHaveLength(2);
      expect(screen.getAllByText("已读取").length).toBeGreaterThanOrEqual(2);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });
  });

  describe("card ordering", () => {
    it("does not inline a pending decision card between surrounding text parts", async () => {
      const { container } = render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          decisionCards={[
            {
              card_id: "dc-1",
              card_type: "generic",
              status: "pending",
              questions: [
                {
                  question: "是否继续？",
                  header: "下一步",
                  multiSelect: false,
                  options: [{ label: "继续", description: "进入下一步" }],
                },
              ],
            },
          ]}
        />,
      );

      emit({
        type: "session:history",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: [
          {
            id: "msg-card",
            role: "assistant",
            content: "before after",
            parts: [
              { type: "text", text: "before" },
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
                output: { content: "{\"decision_card_id\":\"dc-1\"}", is_error: false },
              },
              { type: "text", text: "after" },
            ],
          } as unknown as UIMessage,
        ],
      });

      const text = container.textContent || "";
      expect(text).not.toContain("是否继续？");
      expect(text.indexOf("before")).toBeLessThan(text.indexOf("after"));
    });

    it("places the spec card between the surrounding text parts", async () => {
      const { container } = render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          specCards={{
            "sca-1": {
              spec_approval_id: "sca-1",
              spec_revision_id: "spec-1",
              status: "pending",
              file_name: "Hello_World.md",
              overview: "Create page.",
              actions: ["run"],
            },
          }}
        />,
      );

      emit({
        type: "session:history",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: [
          {
            id: "msg-plan",
            role: "assistant",
            content: "before after",
            parts: [
              { type: "text", text: "before" },
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
                      file_name: "Hello_World.md",
                      overview: "Create page.",
                    },
                    spec_approval: { spec_approval_id: "sca-1" },
                  }),
                  is_error: false,
                },
              },
              { type: "text", text: "after" },
            ],
          } as unknown as UIMessage,
        ],
      });

      expect(await screen.findByText("Spec Hello_World.md")).toBeInTheDocument();
      const text = container.textContent || "";
      expect(text.indexOf("before")).toBeLessThan(text.indexOf("Spec Hello_World.md"));
      expect(text.indexOf("Spec Hello_World.md")).toBeLessThan(text.indexOf("after"));
    });

  it("does not render a pending ask_user card inline when the tool output arrives in real time", async () => {
      render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          decisionCards={[
            {
              card_id: "dc-1",
              card_type: "generic",
              status: "pending",
              questions: [
                {
                  question: "是否继续？",
                  header: "下一步",
                  multiSelect: false,
                  options: [{ label: "继续", description: "进入下一步" }],
                },
              ],
            },
          ]}
        />,
      );

      function emitEvent(event: any) {
        emit({
          type: "session:chat_event",
          flow_id: "flow-1",
          agent_session_id: "leader-1",
          data: { event },
        });
      }

      emitEvent({ type: "start", messageId: "a1" });
      emitEvent({
        type: "tool-input-start",
        toolName: "mcp__squadflow-leader__ask_user",
        toolCallId: "tool-card",
      });
      emitEvent({
        type: "tool-input-available",
        toolName: "mcp__squadflow-leader__ask_user",
        toolCallId: "tool-card",
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
      });
      emitEvent({
        type: "tool-output-available",
        toolCallId: "tool-card",
        output: { content: "{\"decision_card_id\":\"dc-1\"}", is_error: false },
      });

      await waitFor(() => {
        expect(screen.queryByTestId("decision-card-pending")).toBeNull();
      });
    });

    it("opens spec preview and runs the spec from a pending spec card", async () => {
      const user = userEvent.setup();
      const onOpenSpec = vi.fn();
      const { wsClient } = await import("../../lib/ws");

      render(
        <SessionTranscriptPanel
          flowId="flow-1"
          agentSessionId="leader-1"
          readonly
          specCards={{
            "sca-1": {
              spec_approval_id: "sca-1",
              spec_revision_id: "spec-1",
              status: "pending",
              file_name: "Hello_World.md",
              overview: "Create page.",
              actions: ["run"],
            },
          }}
          onOpenSpec={onOpenSpec}
        />,
      );

      emit({
        type: "session:history",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: [
          {
            id: "msg-plan",
            role: "assistant",
            content: "Spec 已生成",
            parts: [
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
                      file_name: "Hello_World.md",
                      overview: "Create page.",
                    },
                    spec_approval: { spec_approval_id: "sca-1" },
                  }),
                  is_error: false,
                },
              },
            ],
          } as unknown as UIMessage,
        ],
      });

      expect(await screen.findByTestId("spec-card-sca-1")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "查看详情" }));
      expect(onOpenSpec).toHaveBeenCalledWith("spec-1", "Hello_World.md");

      await user.click(screen.getByRole("button", { name: "批准并执行" }));
      expect(wsClient.sendRunSpec).toHaveBeenCalledWith("flow-1", "sca-1");
    });
  });
  describe("active snapshot activity", () => {
    function emitEvent(event: any) {
      emit({
        type: "session:chat_event",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data: { event },
      });
    }

    function emitSnapshot(data: UIMessage[]) {
      emit({
        type: "session:snapshot",
        flow_id: "flow-1",
        agent_session_id: "leader-1",
        data,
      });
    }

    it("derives waiting activity for an active snapshot with an empty assistant message", () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitSnapshot([
        { id: "a1", role: "assistant", parts: [], content: "" } as UIMessage,
      ]);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("derives tool-running activity for an active snapshot with a streaming tool", () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitSnapshot([
        {
          id: "a1",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool-mcp__squadflow-leader__get_context",
              toolCallId: "tool-1",
              toolName: "mcp__squadflow-leader__get_context",
              state: "input-streaming",
              inputText: "",
              input: undefined,
              output: undefined,
            },
          ],
        } as unknown as UIMessage,
      ]);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "tool-running");
    });

    it("derives reasoning activity for an active snapshot whose last part is reasoning", () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitSnapshot([
        {
          id: "a1",
          role: "assistant",
          content: "",
          parts: [{ type: "reasoning", text: "思考中", state: "streaming" }],
        } as unknown as UIMessage,
      ]);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "reasoning");
    });

    it("keeps live activity during long gaps after an active snapshot", () => {
      vi.useFakeTimers();
      try {
        render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

        emitSnapshot([
          {
            id: "a1",
            role: "assistant",
            content: "",
            parts: [{ type: "reasoning", text: "思考中", state: "streaming" }],
          } as unknown as UIMessage,
        ]);

        const marker = screen.getByTestId("chat-message-assistant");
        expect(marker).toHaveAttribute("data-transcript-activity", "reasoning");

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(screen.getByTestId("chat-message-assistant")).toHaveAttribute(
          "data-transcript-activity",
          "reasoning",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves live activity when an early user-only snapshot arrives mid-turn", () => {
      render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitEvent({ type: "start", messageId: "assistant-1" });

      // Early user-only snapshot: a live turn is already in flight, so the
      // snapshot must only merge the user message and leave the activity intact.
      emitSnapshot([userMessage("msg-user-1", "你好")]);

      const marker = screen.getByTestId("chat-message-assistant");
      expect(marker).toHaveAttribute("data-transcript-activity", "waiting");
    });

    it("resumes text deltas to the last text part after a snapshot with multiple text parts", async () => {
      const { container } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitSnapshot([
        {
          id: "a1",
          role: "assistant",
          content: "first second",
          parts: [
            { type: "text", text: "first " },
            { type: "text", text: "second" },
          ],
        } as unknown as UIMessage,
      ]);

      emitEvent({ type: "text-delta", delta: " third" });

      await waitFor(() => {
        const text = container.textContent || "";
        expect(text).toContain("second third");
      });
      expect(screen.getByText("first")).toBeInTheDocument();
    });

    it("keeps resumed reasoning deltas out of the live layout until the turn finishes", async () => {
      const user = userEvent.setup();
      const { container } = render(<SessionTranscriptPanel flowId="flow-1" agentSessionId="leader-1" readonly />);

      emitSnapshot([
        {
          id: "a1",
          role: "assistant",
          content: "",
          parts: [
            { type: "reasoning", text: "first ", state: "streaming" },
            { type: "reasoning", text: "second", state: "streaming" },
          ],
        } as unknown as UIMessage,
      ]);

      emitEvent({ type: "reasoning-delta", delta: " third" });

      expect(container.textContent).not.toContain("second third");
      expect(screen.queryByText("first")).not.toBeInTheDocument();
      expect(screen.getByText("正在思考")).toBeInTheDocument();

      emitEvent({ type: "finish" });

      const reasoningButtons = await screen.findAllByRole("button", { name: /思考过程/ });
      expect(reasoningButtons).toHaveLength(2);
      await user.click(reasoningButtons[0]!);
      await user.click(reasoningButtons[1]!);
      expect(container.textContent || "").toContain("second third");
      expect(screen.getByText("first")).toBeInTheDocument();
    });
  });
});

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import type { TranscriptTimelineItem } from "../../../lib/ws";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionTranscriptPanel from "../SessionTranscriptPanel";
import {
  parityAgentRunId,
  parityDecisionRequests,
  parityFlowId,
  parityHistoryMessages,
  parityPlanCards,
  parityUserMessage,
} from "./transcriptParity.fixture";
import { resetCollapseStoreForTests } from "./useCollapse";

const wsHandlers = new Set<(message: any) => void>();
let transcriptCursor = 0;
let activeMessageId = "";
let activeTextBlockId = "";
let activeReasoningBlockId = "";
const toolNamesByCallId = new Map<string, string>();

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
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
}));

vi.mock("../../../lib/ws", () => ({
  wsClient: {
    sendSessionGet: vi.fn(),
    sendRunPlan: vi.fn(),
    onMessage: vi.fn((handler: (message: any) => void) => {
      wsHandlers.add(handler);
      return () => wsHandlers.delete(handler);
    }),
  },
}));

function emit(message: any) {
  const normalized = normalizeFixtureMessage(message);
  act(() => {
    for (const item of normalized) {
      for (const handler of wsHandlers) handler(item);
    }
  });
}

function fixtureTimelineItems(messages: UIMessage[]): TranscriptTimelineItem[] {
  return messages.map((source, index) => {
    const metadata = source.metadata && typeof source.metadata === "object"
      ? source.metadata as Record<string, unknown>
      : {};
    const presentationTurnId = source.role === "assistant"
      ? typeof metadata.presentationTurnId === "string" ? metadata.presentationTurnId : source.id
      : null;
    const messageKind = source.role === "assistant" ? "assistant" : "user";
    const payload = {
      ...source,
      metadata: { ...metadata, messageKind, ...(presentationTurnId ? { presentationTurnId } : {}) },
    } as UIMessage;
    return {
      id: source.id,
      position: index + 1,
      type: "message",
      lifecycle: "complete",
      message_id: source.id,
      session_id: parityAgentRunId,
      agent_run_id: parityAgentRunId,
      work_run_id: null,
      presentation_turn_id: presentationTurnId,
      message_kind: messageKind,
      payload,
      created_at: "2026-06-19T10:00:00.000Z",
      updated_at: "2026-06-19T10:00:00.000Z",
    };
  });
}

function normalizeFixtureMessage(message: any): any[] {
  if (message.type === "session:history") {
    return [{
      ...message,
      type: "session:transcript_snapshot",
      data: {
        stream_epoch: "epoch-parity",
        cursor: 0,
        timeline_items: fixtureTimelineItems(message.data as UIMessage[]),
      },
    }];
  }
  if (message.type !== "session:chat_event") return [message];

  const raw = { ...(message.data?.event ?? {}) } as Record<string, any>;
  const originalType = String(raw.type ?? "");
  const messageId = raw.messageId || activeMessageId;
  if (originalType === "start") activeMessageId = raw.messageId;
  if (originalType === "text-start") activeTextBlockId = raw.id || `text-${messageId}`;
  if (originalType === "reasoning-start") activeReasoningBlockId = raw.id || `reasoning-${messageId}`;

  const event: Record<string, unknown> = { ...raw, messageId };
  if (originalType === "start") event.type = "turn-started";
  if (originalType === "finish") event.type = "turn-finished";
  if (originalType.startsWith("text-")) event.id = raw.id || activeTextBlockId;
  if (originalType.startsWith("reasoning-")) event.id = raw.id || activeReasoningBlockId;
  if (originalType === "tool-input-start" && typeof raw.toolCallId === "string" && typeof raw.toolName === "string") {
    toolNamesByCallId.set(raw.toolCallId, raw.toolName);
  }
  if (originalType === "tool-input-available" && typeof raw.toolCallId === "string" && !raw.toolName) {
    event.toolName = toolNamesByCallId.get(raw.toolCallId) ?? "unknown";
  }
  return [{
    ...message,
    type: "session:transcript_event",
    data: {
      stream_epoch: "epoch-parity",
      cursor: ++transcriptCursor,
      timeline_items: [],
      event,
      ...(originalType !== "finish" ? {
        active_turn: {
          message_id: activeMessageId,
          presentation_turn_id: activeMessageId,
          segment_index: 0,
          started_at: "2026-06-19T10:00:00.000Z",
        },
      } : {}),
    },
  }];
}

async function assertParityRenders() {
  const user = userEvent.setup();
  const workHeader = await screen.findByRole("button", { name: "已工作 18 秒" });
  // Finished turns default to deep-collapsed (compact "已工作 x 秒" summary)
  // to keep the transcript concise, but the final text is the one invariant
  // that must stay visible regardless of collapse state.
  expect(workHeader).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("完成演示。")).toBeVisible();

  await user.click(workHeader);
  expect(workHeader).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("完成演示。")).toBeVisible();

  const summary = screen.getByRole("button", { name: /探索了/ });
  expect(summary).toBeInTheDocument();
  expect(summary.textContent).toContain("读取了 2 个文件");
  expect(summary.textContent).toContain("编辑了 2 个文件和执行了 1 条命令");
  expect(summary.textContent).toContain("联网搜索了 1 次");

  expect(summary).toHaveAttribute("aria-expanded", "false");
  await user.click(summary);
  expect(summary).toHaveAttribute("aria-expanded", "true");

  const body = document.body.textContent ?? "";
  expect(body).toContain("已询问");
  expect(body).toContain("Plan");
  expect(body).toContain("Task");
  expect(body).toContain("Agent");
  expect(body).toContain("Message");

  await user.click(workHeader);
  expect(workHeader).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("完成演示。")).toBeVisible();
}

function replayRealtimeChunks() {
  const assistantMessageId = "msg-assistant-parity-realtime";

  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "start", messageId: assistantMessageId } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "reasoning-start" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "reasoning-delta", delta: "I need to demonstrate the split between tool_call and tool_result." } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "reasoning-end" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-start", id: "text-parity-1" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-delta", delta: "好的，我来演示一组聊天内工具轨迹。" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-end" } },
  });

  const toolCalls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown>; output: unknown }> = [
    { toolCallId: "tc-glob-1", toolName: "Glob", input: { pattern: "*.tsx", path: "/workspace/ZCodeProject" }, output: { files: ["LoginForm.tsx", "LoginPage.tsx", "LoginPage.css"] } },
    { toolCallId: "tc-read-1", toolName: "Read", input: { file_path: "/workspace/ZCodeProject/package.json" }, output: { content: "{}" } },
    { toolCallId: "tc-read-2", toolName: "Read", input: { file_path: "/workspace/ZCodeProject/LoginForm.tsx" }, output: { content: "export default function LoginForm() {}" } },
    { toolCallId: "tc-edit-1", toolName: "Edit", input: { file_path: "/workspace/ZCodeProject/LoginForm.tsx", old_string: "const x = 1;", new_string: "const x = 2;\nconst y = 3;" }, output: { ok: true } },
    { toolCallId: "tc-edit-2", toolName: "Edit", input: { file_path: "/workspace/ZCodeProject/LoginPage.tsx", old_string: "old", new_string: "new" }, output: { ok: true } },
    { toolCallId: "tc-bash-1", toolName: "Bash", input: { command: "python3 /workspace/ZCodeProject/greet.py" }, output: { stdout: "Hello, ZCode!", stderr: "", exit_code: 0 } },
    { toolCallId: "tc-websearch-1", toolName: "WebSearch", input: { query: "AI technology trends 2026" }, output: { results: [{ title: "Trend 1" }] } },
    { toolCallId: "tc-getcontext-1", toolName: "mcp__squadflow-leader__get_context", input: {}, output: { active_work_run_id: null, pending_action: null } },
    { toolCallId: "tc-askuser-1", toolName: "mcp__squadflow-leader__ask_user", input: { questions: [{ question: "你更喜欢哪种界面主题？" }] }, output: { decision_request_id: "decision-theme", answer: "浅色模式" } },
    { toolCallId: "tc-createplan-1", toolName: "mcp__squadflow-leader__create_plan", input: { name: "Web_Calculator.md", overview: "开发一个支持加减乘除四则运算的 Web 界面计算器" }, output: { plan_approval_id: "plan-calc", plan_revision: { file_name: "Web_Calculator.md" } } },
    { toolCallId: "tc-createtask-1", toolName: "mcp__squadflow-leader__create_task", input: { subject: "实现 Web 计算器" }, output: { task: { task_id: "task-101", subject: "实现 Web 计算器", status: "pending" } } },
    { toolCallId: "tc-updatetask-1", toolName: "mcp__squadflow-leader__update_task", input: { task_id: "task-101", status: "in_progress" }, output: { task: { task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" } } },
    { toolCallId: "tc-listtasks-1", toolName: "mcp__squadflow-leader__list_tasks", input: {}, output: { tasks: [{ task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" }, { task_id: "task-102", subject: "浏览器验证", status: "blocked" }, { task_id: "task-103", subject: "代码审查", status: "pending" }] } },
    { toolCallId: "tc-gettask-1", toolName: "mcp__squadflow-leader__get_task", input: { task_id: "task-101" }, output: { task: { task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" } } },
    { toolCallId: "tc-dispatchagent-1", toolName: "mcp__squadflow-leader__dispatch_agent", input: { expert_id: "Frontend Expert", task_id: "task-101" }, output: { agent_run: { agent_run_id: "ags-frontend-7a2f", expert_id: "Frontend Expert", task_id: "task-101" } } },
    { toolCallId: "tc-sendmessage-1", toolName: "mcp__squadflow-leader__send_message", input: { expert_id: "Frontend Expert", summary: "补充指令", content: "请保留键盘输入支持，并补充除零提示" }, output: { accepted: true } },
  ];

  for (const tool of toolCalls) {
    emit({
      type: "session:chat_event",
      flow_id: parityFlowId,
      agent_run_id: parityAgentRunId,
      data: {
        event: {
          type: "tool-input-start",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
        },
      },
    });
    emit({
      type: "session:chat_event",
      flow_id: parityFlowId,
      agent_run_id: parityAgentRunId,
      data: {
        event: {
          type: "tool-input-available",
          toolCallId: tool.toolCallId,
          input: tool.input,
        },
      },
    });
    emit({
      type: "session:chat_event",
      flow_id: parityFlowId,
      agent_run_id: parityAgentRunId,
      data: {
        event: {
          type: "tool-output-available",
          toolCallId: tool.toolCallId,
          output: tool.output,
        },
      },
    });
  }

  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-start", id: "text-parity-2" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-delta", delta: "完成演示。" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "text-end" } },
  });
  emit({
    type: "session:chat_event",
    flow_id: parityFlowId,
    agent_run_id: parityAgentRunId,
    data: { event: { type: "finish", durationMs: 18800, finishedAt: "2026-06-19T10:00:18.800Z" } },
  });
}

describe("transcript parity", () => {
  beforeEach(async () => {
    wsHandlers.clear();
    transcriptCursor = 0;
    activeMessageId = "";
    activeTextBlockId = "";
    activeReasoningBlockId = "";
    toolNamesByCallId.clear();
    resetCollapseStoreForTests();
    const { wsClient } = await import("../../../lib/ws");
    vi.mocked(wsClient.sendSessionGet).mockClear();
    vi.mocked(wsClient.onMessage).mockClear();
  });

  it("renders the fixture from a historical session:get message list", async () => {
    render(
      <SessionTranscriptPanel
        flowId={parityFlowId}
        agentRunId={parityAgentRunId}
        readonly
        decisionRequests={parityDecisionRequests}
        planCards={parityPlanCards}
      />,
    );

    emit({
      type: "session:history",
      flow_id: parityFlowId,
      agent_run_id: parityAgentRunId,
      data: parityHistoryMessages as UIMessage[],
    });

    await assertParityRenders();
  });

  it("renders the fixture from a realtime chunk sequence replay", async () => {
    render(
      <SessionTranscriptPanel
        flowId={parityFlowId}
        agentRunId={parityAgentRunId}
        readonly
        decisionRequests={parityDecisionRequests}
        planCards={parityPlanCards}
      />,
    );

    emit({
      type: "session:history",
      flow_id: parityFlowId,
      agent_run_id: parityAgentRunId,
      data: [parityUserMessage],
    });

    replayRealtimeChunks();

    await assertParityRenders();
  });
});

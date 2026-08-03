import type { UIMessage } from "ai";
import type { SpecCardState } from "../../../hooks/useDashboardData";

const flowId = "flow-parity";
const agentSessionId = "session-parity";
const assistantMessageId = "msg-assistant-parity";
const userMessageId = "msg-user-parity";

export const parityFlowId = flowId;
export const parityAgentSessionId = agentSessionId;

function toolPart(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
): Extract<UIMessage["parts"][number], { type: `tool-${string}` }> {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    toolName,
    state: "output-available",
    input,
    output,
  } as Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;
}

export const parityUserMessage: UIMessage = {
  id: userMessageId,
  role: "user",
  parts: [{ type: "text", text: "你把文件操作的 tool 执行一下吧" }],
  content: "你把文件操作的 tool 执行一下吧",
} as UIMessage;

export const parityAssistantMessage: UIMessage = {
  id: assistantMessageId,
  role: "assistant",
  parts: [
    { type: "reasoning", text: "I need to demonstrate the split between tool_call and tool_result." },
    { type: "text", text: "好的，我来演示一组聊天内工具轨迹。" },
    toolPart("tc-glob-1", "Glob", { pattern: "*.tsx", path: "/workspace/ZCodeProject" }, {
      files: ["LoginForm.tsx", "LoginPage.tsx", "LoginPage.css"],
    }),
    toolPart("tc-read-1", "Read", { file_path: "/workspace/ZCodeProject/package.json" }, {
      content: "{}",
    }),
    toolPart("tc-read-2", "Read", { file_path: "/workspace/ZCodeProject/LoginForm.tsx" }, {
      content: "export default function LoginForm() {}",
    }),
    toolPart("tc-edit-1", "Edit", {
      file_path: "/workspace/ZCodeProject/LoginForm.tsx",
      old_string: "const x = 1;",
      new_string: "const x = 2;\nconst y = 3;",
    }, { ok: true }),
    toolPart("tc-edit-2", "Edit", {
      file_path: "/workspace/ZCodeProject/LoginPage.tsx",
      old_string: "old",
      new_string: "new",
    }, { ok: true }),
    toolPart("tc-bash-1", "Bash", { command: "python3 /workspace/ZCodeProject/greet.py" }, {
      stdout: "Hello, ZCode!",
      stderr: "",
      exit_code: 0,
    }),
    toolPart("tc-websearch-1", "WebSearch", { query: "AI technology trends 2026" }, {
      results: [{ title: "Trend 1" }],
    }),
    toolPart("tc-getcontext-1", "mcp__squadflow-leader__get_context", {}, {
      active_user_turn_id: null,
      pending_action: null,
    }),
    toolPart("tc-askuser-1", "mcp__squadflow-leader__ask_user", {
      questions: [{ question: "你更喜欢哪种界面主题？" }],
    }, {
      decision_card_id: "card-theme",
      answer: "浅色模式",
    }),
    toolPart("tc-createplan-1", "mcp__squadflow-leader__create_plan", {
      name: "Web_Calculator.md",
      overview: "开发一个支持加减乘除四则运算的 Web 界面计算器",
    }, {
      spec_approval_id: "spec-calc",
      spec_revision: { file_name: "Web_Calculator.md" },
    }),
    toolPart("tc-createtask-1", "mcp__squadflow-leader__create_task", {
      subject: "实现 Web 计算器",
    }, {
      task: { task_id: "task-101", subject: "实现 Web 计算器", status: "pending" },
    }),
    toolPart("tc-updatetask-1", "mcp__squadflow-leader__update_task", {
      task_id: "task-101",
      status: "in_progress",
    }, {
      task: { task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" },
    }),
    toolPart("tc-listtasks-1", "mcp__squadflow-leader__list_tasks", {}, {
      tasks: [
        { task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" },
        { task_id: "task-102", subject: "浏览器验证", status: "blocked" },
        { task_id: "task-103", subject: "代码审查", status: "pending" },
      ],
    }),
    toolPart("tc-gettask-1", "mcp__squadflow-leader__get_task", { task_id: "task-101" }, {
      task: { task_id: "task-101", subject: "实现 Web 计算器", status: "in_progress" },
    }),
    toolPart("tc-dispatchagent-1", "mcp__squadflow-leader__dispatch_agent", {
      expert_id: "Frontend Expert",
      task_id: "task-101",
    }, {
      agent_session: { agent_session_id: "ags-frontend-7a2f", expert_id: "Frontend Expert", task_id: "task-101" },
    }),
    toolPart("tc-sendmessage-1", "mcp__squadflow-leader__send_message", {
      expert_id: "Frontend Expert",
      summary: "补充指令",
      content: "请保留键盘输入支持，并补充除零提示",
    }, { accepted: true }),
    { type: "text", text: "完成演示。" },
  ],
  content: "好的，我来演示一组聊天内工具轨迹。完成演示。",
  metadata: {
    turnTiming: {
      startedAt: "2026-06-19T10:00:00.000Z",
      finishedAt: "2026-06-19T10:00:18.800Z",
      durationMs: 18800,
    },
  },
} as UIMessage;

export const parityHistoryMessages: UIMessage[] = [parityUserMessage, parityAssistantMessage];

export const parityDecisionCards = [
  {
    card_id: "card-theme",
    flow_id: flowId,
    card_type: "clarification",
    questions: [
      {
        header: "主题",
        question: "你更喜欢哪种界面主题？",
        multiSelect: false,
        options: [
          { label: "深色模式", description: "使用深色主题" },
          { label: "浅色模式", description: "使用浅色主题" },
        ],
      },
    ],
    status: "resolved" as const,
    answers: { 主题: "浅色模式" },
  },
];

export const paritySpecCards: Record<string, SpecCardState> = {
  "spec-calc": {
    spec_approval_id: "spec-calc",
    spec_revision_id: "spec-revision-calc",
    status: "pending",
    file_name: "Web_Calculator.md",
    overview: "开发一个支持加减乘除四则运算的 Web 界面计算器",
    actions: ["approve", "cancel"],
  },
};

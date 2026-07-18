import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TranscriptTimelineRenderer from "./TranscriptTimelineRenderer";
import type { TurnTiming } from "./buildTranscriptTimeline";
import type { TranscriptBlock, TimelineTool } from "./types";
import { resetCollapseStoreForTests } from "./useCollapse";
import { orchestrationPlanFixture } from "../../orchestration/orchestrationTestFixture";

vi.mock("../../orchestration/OrchestrationPlanCard", () => ({
  default: ({ plan }: { plan: typeof orchestrationPlanFixture }) => (
    <div data-testid={`orchestration-plan-card-${plan.revision.plan_revision_id}`}>{plan.revision.title}</div>
  ),
}));

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

function editTool(id: string, file: string, oldString: string, newString: string): TimelineTool {
  return {
    toolCallId: id,
    toolName: "Edit",
    state: "completed",
    input: { file_path: file, old_string: oldString, new_string: newString },
    output: null,
  };
}

function writeTool(id: string, file: string, content: string): TimelineTool {
  return {
    toolCallId: id,
    toolName: "Write",
    state: "completed",
    input: { file_path: file, content },
    output: null,
  };
}

function bashTool(id: string, command: string, output: unknown): TimelineTool {
  return {
    toolCallId: id,
    toolName: "Bash",
    state: "completed",
    input: { command },
    output,
  };
}

function buildFinalizedGroup(tools: TimelineTool[]): TranscriptBlock {
  return {
    id: "group-1",
    type: "tool-group",
    tools,
    finalized: true,
    defaultCollapsed: true,
  };
}

function buildActiveGroup(
  tools: TimelineTool[],
  activeState: "thinking" | "running" | "pinned",
  currentToolCallId: string | null = tools.find((tool) => tool.state === "running")?.toolCallId ?? null,
): TranscriptBlock {
  return {
    id: "group-active-1",
    type: "tool-group",
    tools,
    finalized: false,
    defaultCollapsed: true,
    activeState,
    currentToolCallId,
  };
}

describe("TranscriptTimelineRenderer", () => {
  beforeEach(() => {
    clipboardWriteText.mockClear();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    resetCollapseStoreForTests();
  });

  it("renders a user-rejected shell command as denied instead of executed", async () => {
    const user = userEvent.setup();
    const command = "rm /repo/e2e-risk.txt";

    render(
      <TranscriptTimelineRenderer
        blocks={[buildFinalizedGroup([bashTool("bash-denied", command, {
          content: `用户已明确拒绝执行该风险命令：${command}。不得在当前 Task 中再次请求或重试完全相同的命令。`,
          is_error: true,
        })])]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const summary = screen.getByRole("button", { name: /已拒绝/ });
    expect(summary).not.toHaveTextContent("执行了");

    await user.click(summary);

    expect(screen.getAllByText("已拒绝")).toHaveLength(2);
    expect(screen.queryByText("已执行")).not.toBeInTheDocument();
  });

  it("renders a resolved decision-card result with shallow and expanded states", async () => {
    const user = userEvent.setup();
    const card = {
      card_id: "dc-1",
      card_type: "clarification",
      status: "resolved",
      questions: [{ header: "选择", question: "选哪个？", options: [], multiSelect: false }],
      answers: { 选择: "重新优化 Hello World" },
    } as any;
    const { rerender } = render(
      <TranscriptTimelineRenderer
        blocks={[{ id: "result-1", type: "decision-card-result", cardId: "dc-1", status: "resolved", collapseState: "shallow" }]}
        flowId="flow-1"
        decisionCardsById={new Map([["dc-1", card]])}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("重新优化 Hello World");
    expect(screen.queryByTestId("decision-card-result-details")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("decision-card-result-summary"));
    expect(screen.getByTestId("decision-card-result-details")).toBeVisible();

    rerender(
      <TranscriptTimelineRenderer
        blocks={[{ id: "result-1", type: "decision-card-result", cardId: "dc-1", status: "resolved", collapseState: "expanded" }]}
        flowId="flow-1"
        decisionCardsById={new Map([["dc-1", card]])}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );
    expect(screen.getByTestId("decision-card-result-details")).toBeVisible();
  });

  it("renders a cancelled decision-card result with fixed copy", () => {
    render(
      <TranscriptTimelineRenderer
        blocks={[{ id: "result-cancel", type: "decision-card-result", cardId: "dc-2", status: "cancelled", collapseState: "expanded" }]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );
    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("已取消");
    expect(screen.getByTestId("decision-card-result-details")).toHaveTextContent("用户取消了本次澄清卡片");
  });

  it("renders an explicit permission denial differently from a generic cancellation", () => {
    const card = {
      card_id: "dc-permission-denied",
      card_type: "permission_confirmation",
      status: "cancelled",
      questions: [{ header: "permission", question: "允许执行 rm target 吗？", options: [], multiSelect: false }],
      answers: { permission: "拒绝当前命令" },
    } as any;
    render(
      <TranscriptTimelineRenderer
        blocks={[{
          id: "result-permission-denied",
          type: "decision-card-result",
          cardId: card.card_id,
          status: "cancelled",
          collapseState: "expanded",
        }]}
        flowId="flow-1"
        decisionCardsById={new Map([[card.card_id, card]])}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    expect(screen.getByTestId("decision-card-result-summary")).toHaveTextContent("已拒绝当前命令");
    expect(screen.getByTestId("decision-card-result-details")).toHaveTextContent("本轮可继续执行其他工作");
    expect(screen.queryByText("用户取消了本次澄清卡片。")).not.toBeInTheDocument();
  });

  it("finalized group shows summary and toggles tool rows", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        editTool("edit-1", "LoginForm.tsx", "const x = 1;", "const x = 2;\nconst y = 3;"),
        editTool("edit-2", "LoginPage.tsx", "old", "new\nnew2"),
        editTool("edit-3", "Button.tsx", "a", "b"),
        bashTool("bash-1", "npm test", { stdout: "ok", stderr: "", exit_code: 0 }),
      ]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const summary = screen.getByRole("button", { name: /编辑了 3 个文件和执行了 1 条命令/ });
    expect(summary).toBeVisible();

    await user.click(summary);
    expect(screen.getByText("LoginForm.tsx")).toBeVisible();

    await user.click(summary);
    expect(screen.getByText("LoginForm.tsx")).not.toBeVisible();
    expect(summary).toBeVisible();
  });

  it("limits expanded tool groups to six rows before scrolling", async () => {
    const user = userEvent.setup();
    const tools = Array.from({ length: 7 }, (_, index) => (
      bashTool(`bash-${index + 1}`, `command-${index + 1}`, { stdout: "ok", stderr: "", exit_code: 0 })
    ));

    render(
      <TranscriptTimelineRenderer
        blocks={[buildFinalizedGroup(tools)]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /执行了 7 条命令/ }));
    expect(screen.getByText("command-1").closest("div[data-scrollable]"))
      .toHaveAttribute("data-scrollable", "true");
  });

  it("does not make a six-tool group scrollable", async () => {
    const user = userEvent.setup();
    const tools = Array.from({ length: 6 }, (_, index) => (
      bashTool(`bash-${index + 1}`, `command-${index + 1}`, { stdout: "ok", stderr: "", exit_code: 0 })
    ));

    render(
      <TranscriptTimelineRenderer
        blocks={[buildFinalizedGroup(tools)]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /执行了 6 条命令/ }));
    expect(screen.getByText("command-1").closest("div[data-scrollable]"))
      .toBeNull();
  });

  it("Edit row expands diff inline without duplicate title", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        editTool("edit-1", "LoginForm.tsx", "const x = 1;", "const x = 2;\nconst y = 3;"),
      ]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const summary = screen.getByRole("button", { name: /编辑了 1 个文件/ });
    await user.click(summary);

    const row = screen.getByText("LoginForm.tsx").closest("button, [role='button']") ?? screen.getByText("LoginForm.tsx").parentElement;
    expect(row).toBeTruthy();
    await user.click(row!);

    const titles = screen.getAllByText("LoginForm.tsx");
    expect(titles.length).toBe(1);
  });

  it("Edit expansion shows actual diff text", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        editTool("edit-1", "LoginForm.tsx", "const x = 1;", "const x = 2;\nconst y = 3;"),
      ]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const summary = screen.getByRole("button", { name: /编辑了 1 个文件/ });
    await user.click(summary);

    const row = screen.getByText("LoginForm.tsx").closest("button, [role='button']") ?? screen.getByText("LoginForm.tsx").parentElement;
    await user.click(row!);

    expect(screen.getByText("const x = 1;")).toBeVisible();
    expect(screen.getByText("const x = 2;")).toBeVisible();
    expect(screen.getByText("const y = 3;")).toBeVisible();
  });

  it("Write expansion shows the written file content as additions", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        writeTool("write-1", "index.html", "<main>Hello</main>\n<p>Welcome</p>"),
      ]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /写入了 1 个文件/ }));
    await user.click(screen.getByRole("button", { name: /index\.html/ }));

    expect(screen.getByText("<main>Hello</main>")).toBeVisible();
    expect(screen.getByText("<p>Welcome</p>")).toBeVisible();
  });

  it("leader-prefixed MCP tools expand with visible detail rows", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        {
          toolCallId: "dispatch-1",
          toolName: "mcp__leader__dispatch_agent",
          state: "completed",
          input: { task_id: "task-1", expert_id: "Backend Expert" },
          output: {
            agent_session: {
              agent_session_id: "ags-1",
              expert_id: "Backend Expert",
              task_id: "task-1",
            },
          },
        },
      ]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /调用了 1 个 MCP 工具/ }));
    await user.click(screen.getByRole("button", { name: /Backend Expert/ }));

    expect(screen.getByText("Expert")).toBeVisible();
    expect(screen.getByText("task-1")).toBeVisible();
    expect(screen.getByText("首次派发")).toBeVisible();
  });

  it("running row shows spinner and completed row does not", () => {
    const blocks: TranscriptBlock[] = [
      buildActiveGroup([
        { toolCallId: "read-1", toolName: "Read", state: "running", input: { file_path: "/a.txt" }, output: null },
        { toolCallId: "read-2", toolName: "Read", state: "completed", input: { file_path: "/b.txt" }, output: null },
      ], "running"),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const readIcon = screen.getByTestId("read-file-icon");
    expect(readIcon.querySelector('[role="status"]')).toBeInTheDocument();
  });

  it("active slot expands into the current batch list before any tool detail is opened", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildActiveGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
        bashTool("bash-2", "echo two", { stdout: "two", stderr: "", exit_code: 0 }),
      ], "pinned", "bash-2"),
      { id: "text-1", type: "text", text: "text-1", streaming: true },
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="text"
      />,
    );

    await user.click(screen.getByRole("button", { name: /echo two/ }));
    expect(screen.getByRole("button", { name: /echo one/ })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /echo two/ })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /echo one/ }));
    expect(screen.getByText("one")).toBeVisible();
  });

  it("reasoning defaultCollapsed can be expanded", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      { id: "r-1", type: "reasoning", text: "I will read the files first.", streaming: false, defaultCollapsed: true },
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /思考过程/ });
    expect(screen.queryByText("I will read the files first.")).toBeNull();

    await user.click(button);
    expect(screen.getByText("I will read the files first.")).toBeVisible();
  });

  it("does not render reasoning blocks when reasoning visibility is turned off", () => {
    const blocks: TranscriptBlock[] = [
      { id: "r-1", type: "reasoning", text: "I will read the files first.", streaming: false, defaultCollapsed: false },
    ];

    render(
      <TranscriptTimelineRenderer
        {...({
          blocks,
          flowId: "flow-1",
          decisionCardsById: new Map(),
          specCardsById: new Map(),
          onSpecOpen: () => {},
          showReasoning: false,
        } as any)}
      />,
    );

    expect(screen.queryByRole("button", { name: /思考过程/ })).toBeNull();
    expect(screen.queryByText("I will read the files first.")).toBeNull();
  });

    it("shows thinking indicator while reasoning is hidden during a live reasoning activity", () => {
      const blocks: TranscriptBlock[] = [
        { id: "text-1", type: "text", text: "I read the project files.", streaming: false },
        { id: "r-1", type: "reasoning", text: "I will read the files first.", streaming: true, defaultCollapsed: false },
      ];

    render(
      <TranscriptTimelineRenderer
        {...({
          blocks,
          flowId: "flow-1",
          decisionCardsById: new Map(),
          specCardsById: new Map(),
          onSpecOpen: () => {},
          showReasoning: false,
          activity: "reasoning",
        } as any)}
      />,
    );

    expect(screen.getByText("正在思考")).toBeVisible();
    expect(screen.queryByRole("button", { name: /思考过程/ })).toBeNull();
  });

  it("merges tool groups separated only by hidden reasoning into one shallow-collapsed summary", () => {
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
      ]),
      { id: "r-1", type: "reasoning", text: "internal", streaming: false, defaultCollapsed: true },
      {
        id: "group-2",
        type: "tool-group",
        tools: [
          bashTool("bash-2", "echo two", { stdout: "two", stderr: "", exit_code: 0 }),
        ],
        finalized: true,
        defaultCollapsed: true,
      },
    ];

    render(
      <TranscriptTimelineRenderer
        {...({
          blocks,
          flowId: "flow-1",
          decisionCardsById: new Map(),
          specCardsById: new Map(),
          onSpecOpen: () => {},
          showReasoning: false,
        } as any)}
      />,
    );

    expect(screen.getByRole("button", { name: /执行了 2 条命令/ })).toBeVisible();
    expect(screen.queryAllByRole("button", { name: /执行了 1 条命令/ })).toHaveLength(0);
  });

  it("resets to shallow-collapsed when the merged group's id shifts because the active side changed", async () => {
    const user = userEvent.setup();
    const baseProps = {
      flowId: "flow-1",
      decisionCardsById: new Map(),
      specCardsById: new Map(),
      onSpecOpen: () => {},
      showReasoning: false,
    } as const;
    const initialBlocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
      ]),
      { id: "r-1", type: "reasoning", text: "internal", streaming: false, defaultCollapsed: true },
      {
        id: "group-2",
        type: "tool-group",
        tools: [bashTool("bash-2", "echo two", { stdout: "two", stderr: "", exit_code: 0 })],
        finalized: true,
        defaultCollapsed: true,
      },
    ];

    const { rerender } = render(
      <TranscriptTimelineRenderer {...({ ...baseProps, blocks: initialBlocks } as any)} />,
    );

    const mergedSummary = screen.getByRole("button", { name: /执行了 2 条命令/ });
    expect(mergedSummary).toHaveAttribute("aria-expanded", "false");
    await user.click(mergedSummary);
    expect(mergedSummary).toHaveAttribute("aria-expanded", "true");

    // The second group becomes the live/unfinalized side, so the merge's
    // `activeSource` (and therefore the merged block's id) switches from the
    // first group's id to the second group's id — a fresh identity that has
    // never been recorded, so it falls back to its own `defaultCollapsed`
    // instead of inheriting the expanded choice made above.
    const shiftedBlocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
      ]),
      { id: "r-1", type: "reasoning", text: "internal", streaming: false, defaultCollapsed: true },
      buildActiveGroup([
        { toolCallId: "bash-2", toolName: "Bash", state: "running", input: { command: "echo two" }, output: null },
      ], "running", "bash-2"),
    ];

    rerender(<TranscriptTimelineRenderer {...({ ...baseProps, blocks: shiftedBlocks, activity: "tool-running" } as any)} />);

    const shiftedSlot = screen.getByRole("button", { name: /echo two/ });
    expect(shiftedSlot).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the prior shallow group collapsed and shows the current Read row when reasoning is hidden", () => {
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
      ]),
      { id: "r-1", type: "reasoning", text: "internal", streaming: false, defaultCollapsed: true },
      buildActiveGroup([
        { toolCallId: "read-1", toolName: "Read", state: "running", input: { file_path: "/repo/a.txt" }, output: null },
      ], "running", "read-1"),
    ];

    render(
      <TranscriptTimelineRenderer
        {...({
          blocks,
          flowId: "flow-1",
          decisionCardsById: new Map(),
          specCardsById: new Map(),
          onSpecOpen: () => {},
          showReasoning: false,
          activity: "tool-running",
        } as any)}
      />,
    );

    expect(screen.getByRole("button", { name: /执行了 1 条命令/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("a.txt")).toBeVisible();
    expect(screen.queryByText("/repo/a.txt")).toBeNull();
    expect(screen.queryByRole("button", { name: /正在思考/ })).toBeNull();
  });

  it("keeps completed text and shallow tool groups visible while the live slot advances", () => {
    const blocks: TranscriptBlock[] = [
      { id: "text-1", type: "text", text: "先做第一步。", streaming: false },
      buildFinalizedGroup([
        bashTool("bash-1", "echo one", { stdout: "one", stderr: "", exit_code: 0 }),
      ]),
      { id: "reasoning-1", type: "reasoning", text: "first reasoning", streaming: false, defaultCollapsed: true },
      { id: "text-2", type: "text", text: "现在执行最后一步。", streaming: false },
      {
        id: "group-2",
        type: "tool-group",
        tools: [
          bashTool("bash-2", "echo two", { stdout: "two", stderr: "", exit_code: 0 }),
          bashTool("bash-3", "echo three", { stdout: "three", stderr: "", exit_code: 0 }),
        ],
        finalized: true,
        defaultCollapsed: true,
      },
      { id: "reasoning-2", type: "reasoning", text: "second reasoning", streaming: true, defaultCollapsed: false },
      buildActiveGroup([
        { toolCallId: "read-3", toolName: "Read", state: "running", input: { file_path: "/repo/a.txt" }, output: null },
      ], "running", "read-3"),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="tool-running"
        showReasoning
      />,
    );

    expect(screen.getByText("先做第一步。")).toBeVisible();
    expect(screen.getByText("现在执行最后一步。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /思考过程/ })).not.toBeInTheDocument();
    expect(screen.queryByText("first reasoning")).not.toBeInTheDocument();
    expect(screen.queryByText("second reasoning")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /执行了 1 条命令/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /执行了 2 条命令/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("a.txt")).toBeVisible();
  });

  it("renders a pinned completed Read row without a loading spinner", () => {
    const blocks: TranscriptBlock[] = [
      buildActiveGroup([
        { toolCallId: "read-1", toolName: "Read", state: "completed", input: { file_path: "/repo/a.txt" }, output: { content: "a" } },
      ], "pinned", "read-1"),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="waiting"
      />,
    );

    expect(screen.getByText("a.txt")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /正在思考/ })).toBeNull();
  });

  it("uses the same fixed-height activity slot for thinking and tool states", () => {
    const blocks: TranscriptBlock[] = [{ id: "t-1", type: "thinking" }];

    const { rerender } = render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const thinkingSlotClasses = [...screen.getByText("正在思考").parentElement!.classList];
    rerender(
      <TranscriptTimelineRenderer
        blocks={[buildActiveGroup([
          { toolCallId: "read-1", toolName: "Read", state: "running", input: { file_path: "/repo/a.txt" }, output: null },
        ], "running", "read-1")]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="tool-running"
      />,
    );
    const toolSlotClasses = [...screen.getByText("a.txt").closest("section")!.classList];

    expect(thinkingSlotClasses.some((className) => (
      className.includes("activitySlot") && toolSlotClasses.includes(className)
    ))).toBe(true);
  });

  it("keeps the thinking slot mounted during the reasoning-start transition", () => {
    const { rerender } = render(
      <TranscriptTimelineRenderer
        blocks={[]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="reasoning"
      />,
    );

    expect(screen.getByText("正在思考")).toBeVisible();

    rerender(
      <TranscriptTimelineRenderer
        blocks={[{
          id: "reasoning-1",
          type: "reasoning",
          text: "streaming trace",
          streaming: true,
          defaultCollapsed: false,
        }]}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
        activity="waiting"
      />,
    );

    expect(screen.getByText("正在思考")).toBeVisible();
    expect(screen.queryByText("streaming trace")).not.toBeInTheDocument();
  });

  it("unknown tool does not throw", () => {
    const blocks: TranscriptBlock[] = [
      {
        id: "group-1",
        type: "tool-group",
        tools: [
          { toolCallId: "unknown-1", toolName: "UnknownTool", state: "completed", input: { x: 1 }, output: null },
        ],
        finalized: true,
        defaultCollapsed: true,
      },
    ];

    expect(() =>
      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("does not render resolved DecisionCard placeholders inline", () => {
    const cardId = "dc-1";
    const blocks: TranscriptBlock[] = [{ id: "card-1", type: "decision-card", cardId, toolCallId: "tool-1" }];
    const decisionCardsById = new Map([
      [
        cardId,
        {
          card_id: cardId,
          card_type: "clarification",
          status: "resolved" as const,
          questions: [
            {
              header: "范围",
              question: "选择修改范围",
              multiSelect: false,
              options: [
                { label: "前端", description: "修改 UI" },
                { label: "后端", description: "修改 API" },
              ],
            },
          ],
          answers: {
            范围: "前端",
          },
        },
      ],
    ]);

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={decisionCardsById}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    expect(screen.queryByText("已提交决策")).not.toBeInTheDocument();
    expect(screen.queryByText("范围")).not.toBeInTheDocument();
    expect(screen.queryByText("前端")).not.toBeInTheDocument();
    expect(screen.queryByTestId("decision-card-resolved")).not.toBeInTheDocument();
  });

  it("renders real PendingSpecCard for spec-card block", () => {
    const specApprovalId = "spec-1";
    const blocks: TranscriptBlock[] = [{ id: "card-1", type: "spec-card", specApprovalId, toolCallId: "tool-1" }];
    const specCardsById = new Map([
      [
        specApprovalId,
        {
          spec_approval_id: specApprovalId,
          spec_revision_id: "rev-1",
          file_name: "Web_Calculator.md",
          overview: "四则运算计算器",
          status: "pending" as const,
          actions: ["run"],
        },
      ],
    ]);

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={specCardsById}
        onSpecOpen={() => {}}
      />,
    );

    expect(screen.getByTestId(`spec-card-${specApprovalId}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "批准并执行" })).toBeVisible();
    expect(screen.getByRole("button", { name: /查看详情/ })).toBeVisible();
  });

  it("keeps an execution plan card visible when a completed turn is collapsed", () => {
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([bashTool("bash-1", "pwd", "/repo")]),
      {
        id: "plan-card-1",
        type: "plan-card",
        planRevisionId: orchestrationPlanFixture.revision.plan_revision_id,
        toolCallId: "plan-tool-1",
      },
      { id: "final-text", type: "text", text: "计划已提交，等待审批。", streaming: false },
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        turnId="turn-with-plan"
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        plansByRevisionId={new Map([[orchestrationPlanFixture.revision.plan_revision_id, orchestrationPlanFixture]])}
        onSpecOpen={() => {}}
        activity="finished"
        turnTiming={{ startedAt: "2026-07-11T00:00:00Z", finishedAt: "2026-07-11T00:00:01Z", durationMs: 1000 }}
      />,
    );

    expect(screen.getByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).toBeVisible();
    expect(screen.getByText("计划已提交，等待审批。")).toBeVisible();
  });

  it("lets the user expand text hidden while an execution plan waits for approval", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      { id: "intro-text", type: "text", text: "我会先分析现有登录流程。", streaming: false },
      buildFinalizedGroup([bashTool("bash-plan", "pwd", "/repo")]),
      {
        id: "plan-card-waiting",
        type: "plan-card",
        planRevisionId: orchestrationPlanFixture.revision.plan_revision_id,
        toolCallId: "plan-tool-waiting",
      },
      { id: "final-waiting-text", type: "text", text: "计划已提交，等待审批。", streaming: false },
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        turnId="turn-waiting-for-plan-approval"
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        plansByRevisionId={new Map([[orchestrationPlanFixture.revision.plan_revision_id, orchestrationPlanFixture]])}
        onSpecOpen={() => {}}
        activity="waiting"
        turnTiming={{ startedAt: "2026-07-11T00:00:00Z", finishedAt: null, durationMs: null, activeDurationMs: 37_000, label: "waiting" }}
      />,
    );

    expect(screen.getByTestId(`orchestration-plan-card-${orchestrationPlanFixture.revision.plan_revision_id}`)).toBeVisible();
    expect(screen.getByText("计划已提交，等待审批。")).toBeVisible();
    expect(screen.queryByText("我会先分析现有登录流程。")).not.toBeInTheDocument();

    const expandButton = screen.getByRole("button", { name: /等待你确认 · 已工作 37 秒/ });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    await user.click(expandButton);

    expect(screen.getByText("我会先分析现有登录流程。")).toBeVisible();
    expect(expandButton).toHaveAttribute("aria-expanded", "true");
  });

  it("Bash with string output shows stdout", async () => {
    const user = userEvent.setup();
    const blocks: TranscriptBlock[] = [
      buildFinalizedGroup([bashTool("bash-1", "echo hello", "hello world")]),
    ];

    render(
      <TranscriptTimelineRenderer
        blocks={blocks}
        flowId="flow-1"
        decisionCardsById={new Map()}
        specCardsById={new Map()}
        onSpecOpen={() => {}}
      />,
    );

    const summary = screen.getByRole("button", { name: /执行了 1 条命令/ });
    await user.click(summary);

    const row = screen.getByText("echo hello").closest("button, [role='button']") ?? screen.getByText("echo hello").parentElement;
    await user.click(row!);

    expect(screen.getByText("hello world")).toBeVisible();
  });

  describe("work header", () => {
    it("shows 已工作 X 秒 when activity is finished with durationMs", () => {
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:03.000Z",
        durationMs: 3000,
      };

      render(
        <TranscriptTimelineRenderer
          blocks={[buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })])]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      expect(screen.getByText("已工作 3 秒")).toBeVisible();
    });

    it("derives 已工作 X 秒 from startedAt/finishedAt when durationMs is null", () => {
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:05.000Z",
        durationMs: null,
      };

      render(
        <TranscriptTimelineRenderer
          blocks={[buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })])]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      expect(screen.getByText("已工作 5 秒")).toBeVisible();
    });

    it("keeps the pre-output phase in thinking without a work header", () => {
      const startedAt = new Date(Date.now() - 2000).toISOString();
      const turnTiming: TurnTiming = {
        startedAt,
        finishedAt: null,
        durationMs: null,
      };

      render(
        <TranscriptTimelineRenderer
          blocks={[{ id: "thinking-1", type: "thinking" }]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="waiting"
          turnTiming={turnTiming}
        />,
      );

      expect(screen.getByText("正在思考")).toBeVisible();
      expect(screen.queryByText(/工作中 \d 秒/)).toBeNull();
    });

    it("shows the accumulated work header after the first text appears", () => {
      const startedAt = new Date(Date.now() - 2000).toISOString();
      const turnTiming: TurnTiming = {
        startedAt,
        finishedAt: null,
        durationMs: null,
      };
      const blocks: TranscriptBlock[] = [{ id: "text-1", type: "text", text: "开始处理。", streaming: true }];

      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="text"
          turnTiming={turnTiming}
        />,
      );

      const workLabel = screen.getByText(/工作中 \d 秒/);
      expect(workLabel.className).toContain("animatedStatusText");
      expect(screen.getByText("开始处理。")).toBeVisible();
      expect(screen.queryByText("正在思考")).toBeNull();
    });

    it("shows the accumulated work header after the first MCP tool call", () => {
      const startedAt = new Date(Date.now() - 2000).toISOString();
      const turnTiming: TurnTiming = {
        startedAt,
        finishedAt: null,
        durationMs: null,
      };
      const blocks: TranscriptBlock[] = [buildActiveGroup([{
        toolCallId: "tool-1",
        toolName: "mcp__squadflow-leader__submit_orchestration_plan",
        state: "running",
        input: {},
        output: null,
      }], "running", "tool-1")];

      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="tool-running"
          turnTiming={turnTiming}
        />,
      );

      expect(screen.getByText(/工作中 \d 秒/)).toBeVisible();
      expect(screen.queryByText("正在思考")).toBeNull();
    });

    it("does not animate finished work header text", () => {
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:03.000Z",
        durationMs: 3000,
      };

      render(
        <TranscriptTimelineRenderer
          blocks={[buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })])]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      const finishedLabel = screen.getByText("已工作 3 秒");
      expect(finishedLabel.className).not.toContain("animatedStatusText");
    });

    it("defaults finished turns to compact mode and lets the user expand them", async () => {
      const user = userEvent.setup();
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:08.000Z",
        durationMs: 8000,
      };
      const blocks: TranscriptBlock[] = [
        { id: "text-1", type: "text", text: "先查看一下目录。", streaming: false },
        buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })]),
        { id: "text-2", type: "text", text: "文件操作完成！✅", streaming: false },
      ];

      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      const header = screen.getByRole("button", { name: /已工作 8 秒/ });
      expect(header).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("先查看一下目录。")).toBeNull();
      expect(screen.queryByRole("button", { name: /执行了 1 条命令/ })).toBeNull();
      expect(screen.getByText("文件操作完成！✅")).toBeVisible();

      await user.click(header);

      expect(header).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("先查看一下目录。")).toBeVisible();
      expect(screen.getByRole("button", { name: /执行了 1 条命令/ })).toBeVisible();
      expect(screen.getByText("文件操作完成！✅")).toBeVisible();
    });

    it("keeps the final non-empty text visible when a finished turn has a trailing empty text block", async () => {
      const user = userEvent.setup();
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:08.000Z",
        durationMs: 8000,
      };
      const blocks: TranscriptBlock[] = [
        buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })]),
        { id: "text-final", type: "text", text: "最终调查结果已经完成。", streaming: false },
        { id: "text-empty", type: "text", text: "", streaming: false },
      ];

      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      const header = screen.getByRole("button", { name: /已工作 8 秒/ });
      expect(header).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: /执行了 1 条命令/ })).toBeNull();
      expect(screen.getByText("最终调查结果已经完成。")).toBeVisible();

      await user.click(header);

      expect(header).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: /执行了 1 条命令/ })).toBeVisible();
      expect(screen.getByText("最终调查结果已经完成。")).toBeVisible();
    });

    it("keeps earlier text and its shallow tool group while streaming the latest text", () => {
      const startedAt = new Date(Date.now() - 2000).toISOString();
      const turnTiming: TurnTiming = {
        startedAt,
        finishedAt: null,
        durationMs: null,
      };
      const blocks: TranscriptBlock[] = [
        { id: "text-1", type: "text", text: "先查看一下目录。", streaming: false },
        buildFinalizedGroup([
          bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 }),
          bashTool("bash-2", "pwd", { stdout: "/repo", stderr: "", exit_code: 0 }),
        ]),
        { id: "text-2", type: "text", text: "文件操作完成！✅", streaming: true },
      ];

      render(
        <TranscriptTimelineRenderer
          blocks={blocks}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="text"
          turnTiming={turnTiming}
        />,
      );

      expect(screen.queryByRole("button", { name: /工作中/ })).toBeNull();
      expect(screen.getByText("先查看一下目录。")).toBeVisible();
      expect(screen.getByRole("button", { name: /执行了 2 条命令/ })).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: /ls/ })).not.toBeInTheDocument();
      expect(screen.getByText("文件操作完成！✅")).toBeVisible();
    });

    it("keeps a manually expanded finished turn's work header expanded after new tail content is appended", async () => {
      const user = userEvent.setup();
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T10:00:08.000Z",
        durationMs: 8000,
      };
      const initialBlocks: TranscriptBlock[] = [
        buildFinalizedGroup([bashTool("bash-1", "ls", { stdout: "a.txt", stderr: "", exit_code: 0 })]),
        { id: "text-final-1", type: "text", text: "第一次的最终回答。", streaming: false },
      ];

      const { rerender } = render(
        <TranscriptTimelineRenderer
          blocks={initialBlocks}
          turnId="turn-1"
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      const header = screen.getByRole("button", { name: /已工作 8 秒/ });
      expect(header).toHaveAttribute("aria-expanded", "false");

      await user.click(header);
      expect(header).toHaveAttribute("aria-expanded", "true");

      const appendedBlocks: TranscriptBlock[] = [
        ...initialBlocks,
        { id: "assistant-1:guide-0", type: "guide-message", text: "追问一下细节" },
        { id: "text-final-2", type: "text", text: "追加后的最终回答。", streaming: false },
      ];

      rerender(
        <TranscriptTimelineRenderer
          blocks={appendedBlocks}
          turnId="turn-1"
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      expect(header).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: /执行了 1 条命令/ })).toBeVisible();
      expect(screen.getByText("第一次的最终回答。")).toBeVisible();
      expect(screen.getByText("追问一下细节")).toBeVisible();
      expect(screen.getByText("追加后的最终回答。")).toBeVisible();
    });

    it("does not render a work header when activity and turnTiming are absent", () => {
      render(
        <TranscriptTimelineRenderer
          blocks={[]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
        />,
      );

      expect(screen.queryByText(/已工作|工作中/)).toBeNull();
    });

    it("shows finished-turn footer time and supports copying assistant text", async () => {
      const user = userEvent.setup();
      const turnTiming: TurnTiming = {
        startedAt: "2026-06-19T10:00:00.000Z",
        finishedAt: "2026-06-19T15:10:00.000Z",
        durationMs: 3000,
      };

      render(
        <TranscriptTimelineRenderer
          blocks={[{ id: "text-1", type: "text", text: "最终答复内容", streaming: false }]}
          flowId="flow-1"
          decisionCardsById={new Map()}
          specCardsById={new Map()}
          onSpecOpen={() => {}}
          activity="finished"
          turnTiming={turnTiming}
        />,
      );

      const expectedFinishedAt = new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(turnTiming.finishedAt!));
      expect(screen.getByText(expectedFinishedAt)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "复制消息" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "已复制消息" })).toBeInTheDocument();
      });
    });
  });
});

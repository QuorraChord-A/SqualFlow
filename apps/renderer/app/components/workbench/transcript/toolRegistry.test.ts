import { describe, expect, it } from "vitest";

import { presentTool, summarizeToolGroup } from "./toolRegistry";
import type { TimelineTool } from "./types";

function makeTool(
  toolName: string,
  state: TimelineTool["state"],
  input: Record<string, unknown> | null = null,
  output: unknown = null,
): TimelineTool {
  return {
    toolCallId: `call-${toolName}`,
    toolName,
    state,
    input,
    output,
  };
}

describe("toolRegistry", () => {
  describe("presentTool", () => {
    it("presents tools from system capability even when provider tool names differ", () => {
      const tool: TimelineTool = {
        toolCallId: "call-provider-read",
        toolName: "codex_file_read",
        capability: "read",
        providerToolName: "codex_file_read",
        state: "completed",
        input: { path: "/repo/package.json" },
        output: { content: "{}" },
      };

      expect(presentTool(tool)).toMatchObject({
        kind: "read",
        icon: "file",
        statusLabel: "已读取",
        title: "package.json",
        file: { path: "/repo/package.json", name: "package.json" },
      });
    });

    it("presents a completed Read tool", () => {
      const tool = makeTool("Read", "completed", {
        file_path: "/repo/package.json",
        offset: 10,
        limit: 50,
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "read",
        icon: "file",
        status: "completed",
        statusLabel: "已读取",
        title: "package.json",
        operationLabel: "读取",
        file: { path: "/repo/package.json", name: "package.json" },
        query: undefined,
        command: undefined,
        diff: undefined,
        rawInput: tool.input,
        rawOutput: tool.output,
        read: {
          path: "/repo/package.json",
          parentPath: "/ repo",
          returnedStart: 10,
          rangeLabel: "L10–59",
          sizeLabel: "未返回内容",
        },
      });
    });

    it("presents a running Read tool", () => {
      const tool = makeTool("Read", "running", { file_path: "/repo/LoginForm.tsx" });

      expect(presentTool(tool)).toMatchObject({
        kind: "read",
        status: "running",
        statusLabel: "读取中",
        title: "LoginForm.tsx",
        read: {
          path: "/repo/LoginForm.tsx",
          rangeLabel: "完整文件",
          sizeLabel: "等待返回",
          detailMetaLabel: "正在读取",
        },
      });
    });

    it("presents Read output metadata without inventing file metadata", () => {
      const tool = makeTool(
        "Read",
        "completed",
        { file_path: "apps/local-service/src/domain/runtimeCapabilities.ts", offset: 1, limit: 64 },
        { content: "line one\nline two" },
      );

      expect(presentTool(tool).read).toMatchObject({
        parentPath: "apps / local-service / src / domain",
        returnedStart: 1,
        returnedLineCount: 2,
        rangeLabel: "L1–2",
        sizeLabel: "17 B",
        detailMetaLabel: "2 行 · UTF-8",
        truncated: false,
      });
    });

    it("removes provider line-number prefixes from Read content", () => {
      const tool = makeTool(
        "Read",
        "completed",
        { file_path: "/repo/example.ts" },
        { content: "     1\tline one\n     2→line two" },
      );

      expect(presentTool(tool).read).toMatchObject({
        content: "line one\nline two",
        returnedLineCount: 2,
        sizeLabel: "17 B",
      });
    });

    it("treats an errored Read output as failed", () => {
      const tool = makeTool(
        "Read",
        "completed",
        { file_path: "/repo/missing.ts" },
        { is_error: true, content: "File not found" },
      );

      expect(presentTool(tool)).toMatchObject({
        status: "failed",
        statusLabel: "失败",
        read: {
          error: "File not found",
          rangeLabel: "未读取",
          sizeLabel: "未返回内容",
          detailMetaLabel: "未返回内容",
        },
      });
    });

    it("presents a completed Write tool", () => {
      const tool = makeTool("Write", "completed", {
        file_path: "/repo/calculator.js",
        content: "const a = 1;\nconst b = 2;\n",
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "write",
        icon: "file",
        status: "completed",
        statusLabel: "已写入",
        title: "calculator.js",
        operationLabel: "写入",
        file: { path: "/repo/calculator.js", name: "calculator.js" },
        diff: { additions: 3, deletions: 0 },
      });
    });

    it("presents a completed Edit tool with diff line counts", () => {
      const tool = makeTool("Edit", "completed", {
        file_path: "/repo/LoginForm.tsx",
        old_string: "const emailError = null;\n",
        new_string: "const emailError = validateEmail(email);\nconst [isSubmitting, setIsSubmitting] = useState(false);\n",
        replace_all: false,
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "edit",
        icon: "edit",
        status: "completed",
        statusLabel: "已编辑",
        title: "LoginForm.tsx",
        operationLabel: "编辑",
        file: { path: "/repo/LoginForm.tsx", name: "LoginForm.tsx" },
        diff: { additions: 3, deletions: 2 },
      });
    });

    it("does not include diff when old_string and new_string are empty", () => {
      const tool = makeTool("Edit", "completed", {
        file_path: "/repo/LoginForm.tsx",
        old_string: "",
        new_string: "",
      });

      expect(presentTool(tool).diff).toBeUndefined();
    });

    it("presents a completed Glob tool", () => {
      const tool = makeTool("Glob", "completed", {
        pattern: "**/*.ts",
        path: "/repo",
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "glob",
        icon: "search",
        status: "completed",
        statusLabel: "已探索",
        title: "**/*.ts",
        operationLabel: "探索",
        query: "**/*.ts",
      });
    });

    it("presents a completed Grep tool", () => {
      const tool = makeTool("Grep", "completed", {
        pattern: "main\\(\\)",
        path: "/repo",
        glob: "*.py",
        output_mode: "file",
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "grep",
        icon: "search",
        status: "completed",
        statusLabel: "已搜索",
        title: "main\\(\\)",
        operationLabel: "搜索",
        query: "main\\(\\)",
      });
    });

    it("presents a completed Bash tool", () => {
      const tool = makeTool("Bash", "completed", {
        command: "python3 /repo/greet.py",
        description: "Run greet script",
        timeout: 30_000,
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "bash",
        icon: "terminal",
        status: "completed",
        statusLabel: "已执行",
        title: "python3 /repo/greet.py",
        operationLabel: "执行",
        command: "python3 /repo/greet.py",
      });
    });

    it("presents a failed Bash tool", () => {
      const tool = makeTool("Bash", "failed", { command: "npm run build" });

      expect(presentTool(tool)).toMatchObject({
        kind: "bash",
        status: "failed",
        statusLabel: "执行失败",
        title: "npm run build",
      });
    });

    it("presents an explicitly rejected permission command as denied", () => {
      const command = "rm /repo/e2e-risk.txt";
      const tool = makeTool("Bash", "completed", { command }, {
        content: `用户已明确拒绝执行该风险命令：${command}。不得在当前 Task 中再次请求或重试完全相同的命令。`,
        is_error: true,
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "bash",
        status: "denied",
        statusLabel: "已拒绝",
        title: command,
        operationLabel: "命令",
      });
    });

    it("presents a declined Codex command as denied", () => {
      const command = "rm /repo/e2e-risk.txt";
      const tool: TimelineTool = {
        toolCallId: "call-codex-command",
        toolName: "codex_command",
        capability: "shell",
        providerToolName: "commandExecution",
        state: "completed",
        input: { command },
        output: { content: "用户已明确拒绝执行该风险命令。", is_error: true },
      };

      expect(presentTool(tool)).toMatchObject({
        kind: "bash",
        status: "denied",
        statusLabel: "已拒绝",
        title: command,
      });
    });

    it("does not confuse an ordinary command error with a permission denial", () => {
      const tool = makeTool("Bash", "completed", { command: "npm test 2>&1" }, {
        content: "Exit code 254\nnpm error code ENOENT",
        is_error: true,
      });

      expect(presentTool(tool)).toMatchObject({
        status: "completed",
        statusLabel: "已执行",
      });
    });

    it("presents a completed WebSearch tool", () => {
      const tool = makeTool("WebSearch", "completed", {
        query: "AI technology trends 2026",
      });

      expect(presentTool(tool)).toMatchObject({
        kind: "web-search",
        icon: "search",
        status: "completed",
        statusLabel: "已搜索",
        title: "AI technology trends 2026",
        operationLabel: "搜索",
        query: "AI technology trends 2026",
      });
    });

    it("falls back to unknown for unrecognized tool names", () => {
      const tool = makeTool("CustomTool", "completed", { foo: "bar" });

      expect(presentTool(tool)).toMatchObject({
        kind: "unknown",
        icon: "unknown",
        status: "completed",
        statusLabel: "已完成",
        title: "CustomTool",
        operationLabel: "调用",
      });
    });

    it("presents any external MCP by server and exact tool name", () => {
      const tool = makeTool(
        "mcp__tavily-mcp__tavily_search",
        "completed",
        { query: "MCP" },
        {
          content: "Detailed Results",
          is_error: false,
          mcp: {
            content: [{ type: "text", text: "Detailed Results" }],
            structuredContent: { results: 1 },
          },
        },
      );
      tool.mcp = {
        server: "tavily-mcp",
        tool: "tavily_search",
        title: "Tavily Search",
        icons: [{ src: "https://example.com/tavily.png" }],
      };

      expect(presentTool(tool)).toMatchObject({
        kind: "mcp",
        title: "Tavily Search",
        operationLabel: "MCP · tavily-mcp",
        mcp: {
          server: "tavily-mcp",
          tool: "tavily_search",
          icons: [{ src: "https://example.com/tavily.png" }],
        },
        detailRows: [{ label: "工具名", value: "mcp__tavily-mcp__tavily_search" }],
      });
    });

    it("marks interrupted tools with the interrupted status", () => {
      const tool = makeTool("Read", "interrupted", { file_path: "/repo/a.txt" });

      expect(presentTool(tool)).toMatchObject({
        status: "interrupted",
        statusLabel: "已中断",
      });
    });

    describe("MCP SquadFlow tools", () => {
      it("recognizes both MCP prefixes", () => {
        const hyphenated = makeTool("mcp__squadflow-leader__create_plan", "completed", {});
        const underscored = makeTool("mcp__squadflow_leader__create_plan", "completed", {});
        expect(presentTool(hyphenated).kind).toBe("mcp");
        expect(presentTool(underscored).kind).toBe("mcp");
      });

      it("resolves all supported SquadFlow MCP tools to kind mcp", () => {
        const tools = [
          "get_context",
          "ask_user",
          "create_plan",
          "create_task",
          "save_execution_plan",
          "update_task",
          "list_tasks",
          "get_task",
          "dispatch_agent",
          "send_message",
          "submit_orchestration_plan",
        ];
        for (const name of tools) {
          expect(presentTool(makeTool(`mcp__squadflow-leader__${name}`, "completed")).kind).toBe("mcp");
        }
      });

      it("presents a running orchestration submission as plan generation", () => {
        const tool = makeTool("mcp__squadflow-leader__submit_orchestration_plan", "running", {
          title: "登录失败次数限制",
        });

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "spec",
          status: "running",
          statusLabel: "正在生成编排计划…",
          title: "登录失败次数限制",
          operationLabel: "编排计划",
        });
      });

      it("presents create_plan with spec labels", () => {
        const tool = makeTool("mcp__squadflow-leader__create_plan", "completed", {
          flow_id: "flow-1",
          mode: "write",
          name: "Plan title",
          overview: "overview",
          plan: "steps",
        });

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "spec",
          status: "completed",
          statusLabel: "已创建",
          title: "Plan title",
          operationLabel: "Spec",
        });
      });

      it("presents ask_user with ask labels", () => {
        const tool = makeTool("mcp__squadflow-leader__ask_user", "completed", {
          flow_id: "flow-1",
          questions: [
            {
              question: "Confirm?",
              header: "Confirm",
              multiSelect: false,
              options: [
                { label: "Yes", description: "Proceed" },
                { label: "No", description: "Cancel" },
              ],
            },
          ],
        });

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "question",
          status: "completed",
          statusLabel: "已询问",
          operationLabel: "Ask",
          title: "Confirm?",
          detailRows: [{ label: "问题", value: "Confirm?" }],
        });
      });

      it("presents create_task with task labels, output task_id and status", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__create_task",
          "completed",
          {
            flow_id: "flow-1",
            subject: "Implement login",
            description: "Build login form",
          },
          {
            content: JSON.stringify({
              ok: true,
              task: {
                task_id: "task-2",
                subject: "Implement login",
                status: "pending",
              },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          status: "completed",
          statusLabel: "已创建",
          title: "Implement login",
          operationLabel: "Task",
          detailRows: [
            { label: "任务", value: "Implement login" },
            { label: "ID", value: "task-2" },
            { label: "状态", value: "pending" },
          ],
        });
      });

      it("marks MCP tools as failed when the parsed output returns ok false", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__dispatch_agent",
          "completed",
          {
            flow_id: "flow-1",
            expert_id: "exp-backend",
            task_id: "task-1",
          },
          {
            content: JSON.stringify({
              ok: false,
              error: {
                code: "BOOTSTRAP_LIMIT",
                message: "dispatch requires a task in the current UserTurn",
              },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          status: "failed",
          statusLabel: "失败",
          title: "exp-backend",
          detailRows: expect.arrayContaining([
            { label: "错误码", value: "BOOTSTRAP_LIMIT" },
            { label: "错误", value: "dispatch requires a task in the current UserTurn" },
          ]),
        });
      });

      it("falls back create_task title to output task.subject when input subject is missing", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__create_task",
          "completed",
          { flow_id: "flow-1" },
          {
            content: JSON.stringify({
              ok: true,
              task: { task_id: "task-2", subject: "Output title", status: "pending" },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          title: "Output title",
          detailRows: [
            { label: "任务", value: "Output title" },
            { label: "ID", value: "task-2" },
            { label: "状态", value: "pending" },
          ],
        });
      });

      it("presents save_execution_plan with plan labels without exposing full plan content", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__save_execution_plan",
          "completed",
          {
            flow_id: "flow-1",
            title: "Execution Plan",
            plan: "# Execution Plan\n\nLong internal execution details.",
          },
          {
            content: JSON.stringify({
              ok: true,
              artifact: {
                id: "art-plan",
                type: "execution_plan",
                title: "Execution Plan",
              },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "spec",
          status: "completed",
          statusLabel: "已保存",
          title: "Execution Plan",
          operationLabel: "Plan",
          detailRows: [{ label: "标题", value: "Execution Plan" }],
        });
      });

      it("presents update_task with output owner and dependency change", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__update_task",
          "completed",
          {
            flow_id: "flow-1",
            task_id: "task-1",
            status: "in_progress",
            add_blocks: ["task-3"],
            add_blocked_by: ["task-0"],
          },
          {
            content: JSON.stringify({
              ok: true,
              task: {
                task_id: "task-1",
                subject: "Update owner",
                status: "in_progress",
                owner: "expert-a",
                expert_id: "expert-a",
              },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          status: "completed",
          statusLabel: "已更新",
          title: "Update owner",
          operationLabel: "Task",
          detailRows: [
            { label: "任务", value: "task-1" },
            { label: "状态", value: "in_progress" },
            { label: "负责人", value: "expert-a" },
            { label: "依赖变更", value: "+blocks 1, +blocked_by 1" },
          ],
        });
      });

      it("presents list_tasks with total count and status aggregation", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__list_tasks",
          "completed",
          { flow_id: "flow-1" },
          {
            content: JSON.stringify({
              ok: true,
              tasks: [
                { task_id: "t-1", status: "pending", subject: "A" },
                { task_id: "t-2", status: "pending", subject: "B" },
                { task_id: "t-3", status: "in_progress", subject: "C" },
              ],
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          statusLabel: "已列出",
          operationLabel: "Task",
          detailRows: [
            { label: "总数", value: "3" },
            { label: "按状态", value: "pending 2, in_progress 1" },
          ],
        });
      });

      it("presents get_task with task fields from real output", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__get_task",
          "completed",
          { flow_id: "flow-1", task_id: "task-1" },
          {
            content: JSON.stringify({
              ok: true,
              task: {
                task_id: "task-1",
                subject: "Get me",
                status: "in_progress",
                expert_id: "expert-b",
                blocked_by: ["task-0"],
                blocks: ["task-2"],
                metadata: {
                  acceptance: "must be fast",
                  acceptance_criteria: ["criterion 1", "criterion 2"],
                },
              },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          statusLabel: "已读取",
          operationLabel: "Task",
          title: "Get me",
          detailRows: [
            { label: "任务", value: "Get me" },
            { label: "状态", value: "in_progress" },
            { label: "负责人", value: "expert-b" },
            { label: "blocked_by", value: "task-0" },
            { label: "blocks", value: "task-2" },
            { label: "验收", value: "must be fast" },
          ],
        });
      });

      it("presents dispatch_agent with agent_session.agent_session_id and resume", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__dispatch_agent",
          "completed",
          {
            flow_id: "flow-1",
            task_id: "task-1",
            expert_id: "expert-1",
            resume_agent_session_id: "session-old",
          },
          {
            content: JSON.stringify({
              ok: true,
              agent_session: {
                agent_session_id: "session-new",
                status: "streaming",
                expert_id: "expert-1",
                task_id: "task-1",
                resume_from_agent_session_id: "session-old",
              },
              task: { task_id: "task-1", subject: "Dispatch me" },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "agent",
          status: "completed",
          statusLabel: "已派遣",
          operationLabel: "Agent",
          title: "expert-1",
          detailRows: [
            { label: "Expert", value: "expert-1" },
            { label: "Task", value: "task-1" },
            { label: "AgentSession", value: "session-new" },
            { label: "派发", value: "恢复 session-old" },
          ],
        });
      });

      it("presents dispatch_agent first dispatch when resume is absent", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__dispatch_agent",
          "completed",
          {
            flow_id: "flow-1",
            task_id: "task-1",
            expert_id: "expert-1",
          },
          {
            content: JSON.stringify({
              ok: true,
              agent_session: {
                agent_session_id: "session-new",
                status: "streaming",
                expert_id: "expert-1",
                task_id: "task-1",
                resume_from_agent_session_id: null,
              },
              task: { task_id: "task-1", subject: "Dispatch me" },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          detailRows: [
            { label: "Expert", value: "expert-1" },
            { label: "Task", value: "task-1" },
            { label: "AgentSession", value: "session-new" },
            { label: "派发", value: "首次派发" },
          ],
        });
      });

      it("presents send_message accepted=false with error code", () => {
        const tool = makeTool(
          "mcp__squadflow-leader__send_message",
          "completed",
          {
            flow_id: "flow-1",
            agent_session_id: "session-1",
            content: "What is the current status?",
            summary: "status?",
          },
          {
            content: JSON.stringify({
              ok: true,
              accepted: false,
              error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "runtime delivery channel unavailable" },
            }),
          },
        );

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "message",
          status: "completed",
          statusLabel: "已发送",
          title: "status?",
          operationLabel: "Message",
          detailRows: [
            { label: "会话", value: "session-1" },
            { label: "摘要", value: "status?" },
            { label: "送达", value: "未接受" },
            { label: "错误", value: "RUNTIME_DELIVERY_UNAVAILABLE" },
          ],
        });
      });

      it("presents send_message with message labels", () => {
        const tool = makeTool("mcp__squadflow-leader__send_message", "completed", {
          flow_id: "flow-1",
          agent_session_id: "session-1",
          content: "What is the current status?",
          summary: "status?",
        });

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "message",
          status: "completed",
          statusLabel: "已发送",
          title: "status?",
          operationLabel: "Message",
          detailRows: [
            { label: "会话", value: "session-1" },
            { label: "摘要", value: "status?" },
            { label: "内容", value: "What is the current status?" },
          ],
        });
      });

      it("presents get_context with context labels", () => {
        const tool = makeTool("mcp__squadflow-leader__get_context", "completed", {
          flow_id: "flow-1",
        });

        expect(presentTool(tool)).toMatchObject({
          kind: "mcp",
          icon: "context",
          status: "completed",
          statusLabel: "已读取",
          operationLabel: "Context",
        });
      });

      it("presents list_tasks and get_task with task labels", () => {
        const listTool = makeTool("mcp__squadflow-leader__list_tasks", "completed", { flow_id: "flow-1" });
        const getTool = makeTool("mcp__squadflow-leader__get_task", "completed", {
          flow_id: "flow-1",
          task_id: "task-1",
        });

        expect(presentTool(listTool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          statusLabel: "已列出",
          operationLabel: "Task",
        });
        expect(presentTool(getTool)).toMatchObject({
          kind: "mcp",
          icon: "task",
          statusLabel: "已读取",
          operationLabel: "Task",
        });
      });
    });
  });

  describe("summarizeToolGroup", () => {
    it("does not count a rejected permission command as executed", () => {
      const denied = makeTool("Bash", "completed", { command: "rm /repo/e2e-risk.txt" }, {
        content: "该风险命令已在当前 Task 中被用户明确拒绝，本次已自动拒绝且不会再次询问用户。",
        is_error: true,
      });

      expect(summarizeToolGroup([denied])).toBe("已拒绝");
      expect(summarizeToolGroup([
        makeTool("Bash", "completed", { command: "npm test" }, { content: "ok" }),
        denied,
      ])).toBe("执行了 1 条命令，1 个工具已拒绝");
    });

    it("does not describe an interrupted write as completed", () => {
      expect(summarizeToolGroup([
        makeTool("Write", "interrupted", { file_path: "/repo/login/index.html" }),
      ])).toBe("已中断");
    });

    it("summarizes tools from system capability before provider names", () => {
      const tools: TimelineTool[] = [
        {
          toolCallId: "call-provider-read",
          toolName: "codex_file_read",
          capability: "read",
          state: "completed",
          input: { path: "/repo/a.txt" },
          output: null,
        },
        {
          toolCallId: "call-provider-shell",
          toolName: "codex_exec",
          capability: "shell",
          state: "completed",
          input: { command: "npm test" },
          output: null,
        },
      ];

      expect(summarizeToolGroup(tools)).toBe("读取了 1 个文件和执行了 1 条命令");
    });

    it("merges same-kind counts and joins two kinds with 和", () => {
      const editOne = makeTool("Edit", "completed", { file_path: "/repo/a.tsx" });
      const editTwo = makeTool("Edit", "completed", { file_path: "/repo/b.tsx" });
      const editThree = makeTool("Edit", "completed", { file_path: "/repo/c.tsx" });
      const bashOne = makeTool("Bash", "completed", { command: "npm test" });

      expect(summarizeToolGroup([editOne, editTwo, editThree, bashOne])).toBe(
        "编辑了 3 个文件和执行了 1 条命令",
      );
    });

    it("joins all kinds with 和", () => {
      const tools = [
        makeTool("Read", "completed", { file_path: "/repo/a.txt" }),
        makeTool("Read", "completed", { file_path: "/repo/b.txt" }),
        makeTool("Edit", "completed", { file_path: "/repo/c.tsx" }),
        makeTool("Bash", "completed", { command: "npm test" }),
      ];

      expect(summarizeToolGroup(tools)).toBe("读取了 2 个文件和编辑了 1 个文件和执行了 1 条命令");
    });

    it("preserves first-appearance order of tool kinds", () => {
      const tools = [
        makeTool("Bash", "completed", { command: "a" }),
        makeTool("Glob", "completed", { pattern: "**/*" }),
        makeTool("Read", "completed", { file_path: "/repo/a.txt" }),
        makeTool("Grep", "completed", { pattern: "x" }),
        makeTool("Write", "completed", { file_path: "/repo/b.txt" }),
        makeTool("Edit", "completed", { file_path: "/repo/c.tsx" }),
        makeTool("WebSearch", "completed", { query: "q" }),
      ];

      expect(summarizeToolGroup(tools)).toBe(
        "执行了 1 条命令和探索了 1 个列表和读取了 1 个文件和搜索了 1 次和写入了 1 个文件和编辑了 1 个文件和联网搜索了 1 次",
      );
    });

    it("uses the unknown template for unrecognized tools", () => {
      const tools = [makeTool("CustomTool", "completed"), makeTool("OtherTool", "completed")];

      expect(summarizeToolGroup(tools)).toBe("调用了 2 个工具");
    });

    it("summarizes MCP tools with a dedicated template", () => {
      const tools = [
        makeTool("mcp__squadflow-leader__ask_user", "completed"),
        makeTool("mcp__squadflow-leader__create_plan", "completed"),
      ];

      expect(summarizeToolGroup(tools)).toBe("调用了 2 个 MCP 工具");
    });

    it("keeps MCP and built-in tools separate in summaries", () => {
      const tools = [
        makeTool("Read", "completed", { file_path: "/repo/a.txt" }),
        makeTool("mcp__squadflow-leader__ask_user", "completed"),
        makeTool("Edit", "completed", { file_path: "/repo/b.tsx" }),
      ];

      expect(summarizeToolGroup(tools)).toBe("读取了 1 个文件和调用了 1 个 MCP 工具和编辑了 1 个文件");
    });

    it("returns an empty string for an empty group", () => {
      expect(summarizeToolGroup([])).toBe("");
    });

    it("counts multiple occurrences of the same kind in first-appearance order", () => {
      const tools = [
        makeTool("Read", "completed", { file_path: "/repo/a.txt" }),
        makeTool("Read", "completed", { file_path: "/repo/b.txt" }),
        makeTool("Read", "completed", { file_path: "/repo/c.txt" }),
      ];

      expect(summarizeToolGroup(tools)).toBe("读取了 3 个文件");
    });
  });
});

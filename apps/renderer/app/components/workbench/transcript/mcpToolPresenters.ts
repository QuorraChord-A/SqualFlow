import type { TimelineTool, ToolIcon, ToolPresentation } from "./types";

export type { ToolPresentation } from "./types";

export type McpResultViewModel = {
  content: Array<Record<string, unknown> & { type: string }>;
  structuredContent?: unknown;
  isError: boolean;
};

const MCP_NAME_PREFIXES = [
  "mcp__squadflow-leader__",
  "mcp__squadflow_leader__",
  "mcp__leader__",
];

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

export function mcpToolName(toolName: string): string {
  for (const prefix of MCP_NAME_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  const parts = parseMcpToolName(toolName);
  return parts?.tool ?? toolName;
}

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  return match ? { server: match[1], tool: match[2] } : null;
}

export function parseToolPayload(value: unknown, depth = 0): unknown {
  if (depth >= 3 || typeof value !== "string") return value;
  try {
    return parseToolPayload(JSON.parse(value), depth + 1);
  } catch {
    return value;
  }
}

function unwrapContent(output: unknown): unknown {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    const mcp = record.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const mcpRecord = mcp as Record<string, unknown>;
      if (mcpRecord.structuredContent !== undefined) return mcpRecord.structuredContent;
      if (Array.isArray(mcpRecord.content)) {
        const text = mcpRecord.content
          .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text")
          .map((item) => (item as Record<string, unknown>).text)
          .filter((item): item is string => typeof item === "string")
          .join("\n");
        return text || mcpRecord.content;
      }
    }
    if ("content" in record) return record.content;
  }
  return output;
}

export function parseMcpOutput(output: unknown): unknown {
  const content = unwrapContent(output);
  return parseToolPayload(content, 0);
}

export function mcpResultForOutput(output: unknown): McpResultViewModel | null {
  const record = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : null;
  const envelope = record?.mcp;
  const mcpRecord = envelope && typeof envelope === "object" && !Array.isArray(envelope)
    ? envelope as Record<string, unknown>
    : record;
  if (!mcpRecord) {
    const parsed = parseToolPayload(output, 0);
    if (parsed === output) {
      return typeof output === "string"
        ? { content: [{ type: "text", text: output }], isError: false }
        : null;
    }
    return mcpResultForOutput(parsed);
  }
  const rawContent = mcpRecord.content;
  const content = Array.isArray(rawContent)
    ? rawContent.filter((item): item is Record<string, unknown> & { type: string } => (
      Boolean(item)
      && typeof item === "object"
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).type === "string"
    ))
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  const structuredContent = mcpRecord.structuredContent
    ?? (record && record !== mcpRecord && !("content" in mcpRecord) ? record : undefined);
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    isError: mcpRecord.isError === true
      || mcpRecord.is_error === true
      || record?.is_error === true,
  };
}

function mcpFailure(output: unknown): { code?: string; message?: string } | null {
  const mcpResult = mcpResultForOutput(output);
  if (mcpResult?.isError) {
    return { message: "MCP tool returned an error" };
  }
  const parsed = parseMcpOutput(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.isError === true || obj.is_error === true) {
    return { message: typeof obj.message === "string" ? obj.message : undefined };
  }
  if (obj.ok !== false) return null;
  const error = obj.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return {};
}

type McpKind =
  | "get_context"
  | "ask_user"
  | "create_plan"
  | "create_task"
  | "save_execution_plan"
  | "submit_orchestration_plan"
  | "update_task"
  | "list_tasks"
  | "get_task"
  | "dispatch_agent"
  | "send_message";

const MCP_STATUS_LABELS: Record<McpKind, string> = {
  get_context: "已读取",
  ask_user: "已询问",
  create_plan: "已创建",
  create_task: "已创建",
  save_execution_plan: "已保存",
  submit_orchestration_plan: "已生成",
  update_task: "已更新",
  list_tasks: "已列出",
  get_task: "已读取",
  dispatch_agent: "已派遣",
  send_message: "已发送",
};

const MCP_OPERATION_LABELS: Record<McpKind, string> = {
  get_context: "Context",
  ask_user: "Ask",
  create_plan: "Spec",
  create_task: "Task",
  save_execution_plan: "Plan",
  submit_orchestration_plan: "编排计划",
  update_task: "Task",
  list_tasks: "Task",
  get_task: "Task",
  dispatch_agent: "Agent",
  send_message: "Message",
};

const MCP_ICONS: Record<McpKind, ToolIcon> = {
  get_context: "context",
  ask_user: "question",
  create_plan: "spec",
  create_task: "task",
  save_execution_plan: "spec",
  submit_orchestration_plan: "spec",
  update_task: "task",
  list_tasks: "task",
  get_task: "task",
  dispatch_agent: "agent",
  send_message: "message",
};

function isMcpKind(name: string): name is McpKind {
  return name in MCP_STATUS_LABELS;
}

function statusLabelForState(state: ToolPresentation["status"], kind: McpKind): string {
  switch (state) {
    case "queued":
      return "等待中";
    case "running": {
      switch (kind) {
        case "dispatch_agent":
          return "准备派遣";
        case "create_task":
        case "create_plan":
          return "准备创建";
        case "save_execution_plan":
          return "准备保存";
        case "submit_orchestration_plan":
          return "正在生成编排计划…";
        case "ask_user":
          return "准备询问";
        case "send_message":
          return "准备发送";
        case "update_task":
          return "准备更新";
        case "get_context":
        case "get_task":
          return "读取中";
        case "list_tasks":
          return "列出中";
        default:
          return `${MCP_OPERATION_LABELS[kind]}中`;
      }
    }
    case "completed":
      return MCP_STATUS_LABELS[kind];
    case "failed":
      return "失败";
    case "interrupted":
      return "已中断";
    case "denied":
      return "已拒绝";
    default:
      return "";
  }
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  return undefined;
}

function titleForCreatePlan(input: Record<string, unknown> | null, output: unknown): string {
  const parsedOutput = parseMcpOutput(output);
  const parsedObj = parsedOutput && typeof parsedOutput === "object" && !Array.isArray(parsedOutput)
    ? (parsedOutput as Record<string, unknown>)
    : null;
  const specRevision = parsedObj?.spec_revision && typeof parsedObj.spec_revision === "object" && !Array.isArray(parsedObj.spec_revision)
    ? (parsedObj.spec_revision as Record<string, unknown>)
    : null;

  return (
    firstString(input?.name) ??
    firstString(specRevision?.file_name) ??
    "create_plan"
  );
}

function firstQuestionText(input: Record<string, unknown> | null): string | undefined {
  const questions = Array.isArray(input?.questions) ? input!.questions : [];
  const first = questions[0];
  if (first && typeof first === "object" && "question" in first) {
    const text = (first as { question?: unknown }).question;
    if (typeof text === "string" && text) return text;
  }
  return undefined;
}

function titleForAskUser(input: Record<string, unknown> | null): string {
  return firstQuestionText(input) ?? "ask_user";
}

function taskRecordFromOutput(output: unknown): Record<string, unknown> | null {
  const parsed = parseMcpOutput(output);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const task = obj?.task;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    return task as Record<string, unknown>;
  }
  return null;
}

function agentSessionRecordFromOutput(output: unknown): Record<string, unknown> | null {
  const parsed = parseMcpOutput(output);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const session = obj?.agent_session;
  if (session && typeof session === "object" && !Array.isArray(session)) {
    return session as Record<string, unknown>;
  }
  return null;
}

function taskSubject(input: Record<string, unknown> | null, output: unknown): string | undefined {
  return firstString(input?.subject) ?? firstString(taskRecordFromOutput(output)?.subject);
}

function titleForDispatchAgent(input: Record<string, unknown> | null, output: unknown): string {
  const session = agentSessionRecordFromOutput(output);
  return firstString(session?.expert_id) ?? firstString(input?.expert_id) ?? firstString(input?.task_id) ?? "dispatch_agent";
}

function titleForGetTask(input: Record<string, unknown> | null, output: unknown): string {
  return taskSubject(input, output) ?? firstString(input?.task_id) ?? "get_task";
}

function titleForCreateTask(input: Record<string, unknown> | null, output: unknown): string {
  return taskSubject(input, output) ?? firstString(taskRecordFromOutput(output)?.task_id) ?? "create_task";
}

function titleForSaveExecutionPlan(input: Record<string, unknown> | null, output: unknown): string {
  const parsed = parseMcpOutput(output);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const artifact = obj?.artifact && typeof obj.artifact === "object" && !Array.isArray(obj.artifact)
    ? (obj.artifact as Record<string, unknown>)
    : null;
  return firstString(input?.title) ?? firstString(artifact?.title) ?? "save_execution_plan";
}

function titleForUpdateTask(input: Record<string, unknown> | null, output: unknown): string {
  return taskSubject(input, output) ?? firstString(input?.task_id) ?? "update_task";
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function titleForSendMessage(input: Record<string, unknown> | null): string {
  const summary = firstString(input?.summary);
  if (summary) return truncate(summary, 40);
  const content = firstString(input?.content);
  if (content) return truncate(content, 40);
  return firstString(input?.expert_id) ?? "send_message";
}

function titleForListTasks(): string {
  return "list_tasks";
}

function titleForGetContext(): string {
  return "get_context";
}

function titleForMcp(kind: McpKind, input: Record<string, unknown> | null, output: unknown): string {
  switch (kind) {
    case "create_plan":
      return titleForCreatePlan(input, output);
    case "ask_user":
      return titleForAskUser(input);
    case "create_task":
      return titleForCreateTask(input, output);
    case "save_execution_plan":
      return titleForSaveExecutionPlan(input, output);
    case "submit_orchestration_plan":
      return firstString(input?.title) ?? "";
    case "update_task":
      return titleForUpdateTask(input, output);
    case "get_task":
      return titleForGetTask(input, output);
    case "list_tasks":
      return titleForListTasks();
    case "dispatch_agent":
      return titleForDispatchAgent(input, output);
    case "send_message":
      return titleForSendMessage(input);
    case "get_context":
      return titleForGetContext();
    default:
      return kind;
  }
}

function humanizeToolName(value: string): string {
  return value
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function safeIconList(value: unknown): Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((icon) => {
    if (!icon || typeof icon !== "object" || Array.isArray(icon)) return [];
    const record = icon as Record<string, unknown>;
    if (typeof record.src !== "string" || !record.src) return [];
    return [{
      src: record.src,
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
      ...(Array.isArray(record.sizes) ? { sizes: record.sizes.filter((size): size is string => typeof size === "string") } : {}),
      ...(record.theme === "light" || record.theme === "dark" ? { theme: record.theme } : {}),
    }];
  });
}

function joinStrings(values: unknown[], separator = ", "): string {
  const strings = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  return strings.join(separator);
}

function acceptanceValue(metadata: Record<string, unknown> | null | undefined): string | undefined {
  if (!metadata) return undefined;
  if (typeof metadata.acceptance === "string" && metadata.acceptance) return metadata.acceptance;
  const criteria = metadata.acceptance_criteria;
  if (Array.isArray(criteria) && criteria.length > 0) {
    return criteria.filter((c): c is string => typeof c === "string").join("; ");
  }
  return undefined;
}

function detailRowsForMcp(kind: McpKind, input: Record<string, unknown> | null, output: unknown): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (!input) return rows;

  const parsedOutput = parseMcpOutput(output);
  const failure = mcpFailure(output);
  const parsedObj = parsedOutput && typeof parsedOutput === "object" && !Array.isArray(parsedOutput)
    ? (parsedOutput as Record<string, unknown>)
    : null;
  const taskRecord = taskRecordFromOutput(output);
  const agentSession = agentSessionRecordFromOutput(output);

  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value) rows.push({ label, value: truncate(value, 120) });
    else if (typeof value === "number") rows.push({ label, value: String(value) });
  };

  switch (kind) {
    case "get_context":
      push("当前轮", parsedObj?.active_user_turn_id);
      push("动作", parsedObj?.pending_action);
      break;
    case "ask_user":
      push("问题", firstQuestionText(input));
      break;
    case "create_plan":
      push("名称", input?.name);
      push("概述", input?.overview);
      break;
    case "create_task": {
      const subject = taskSubject(input, output);
      push("任务", subject);
      push("ID", taskRecord?.task_id ?? input?.task_id);
      push("状态", taskRecord?.status);
      break;
    }
    case "save_execution_plan":
      push("标题", input?.title);
      break;
    case "submit_orchestration_plan":
      push("标题", input?.title);
      push("目标", input?.objective);
      if (Array.isArray(input?.nodes)) push("任务数", input.nodes.length);
      break;
    case "update_task": {
      const subject = taskSubject(input, output);
      push("任务", input?.task_id ?? subject);
      push("状态", taskRecord?.status ?? input?.status);
      push("负责人", taskRecord?.expert_id ?? input?.owner);
      const addBlocks = Array.isArray(input?.add_blocks) ? input!.add_blocks as unknown[] : [];
      const addBlockedBy = Array.isArray(input?.add_blocked_by) ? input!.add_blocked_by as unknown[] : [];
      if (addBlocks.length > 0 || addBlockedBy.length > 0) {
        const parts: string[] = [];
        if (addBlocks.length > 0) parts.push(`+blocks ${addBlocks.length}`);
        if (addBlockedBy.length > 0) parts.push(`+blocked_by ${addBlockedBy.length}`);
        rows.push({ label: "依赖变更", value: parts.join(", ") });
      }
      break;
    }
    case "list_tasks": {
      const tasks = parsedObj?.tasks;
      const taskArray = Array.isArray(tasks) ? tasks : [];
      push("总数", String(taskArray.length));
      const counts = new Map<string, number>();
      for (const item of taskArray) {
        if (item && typeof item === "object") {
          const status = (item as Record<string, unknown>).status;
          if (typeof status === "string" && status) {
            counts.set(status, (counts.get(status) ?? 0) + 1);
          }
        }
      }
      if (counts.size > 0) {
        const statusSummary = Array.from(counts.entries()).map(([status, count]) => `${status} ${count}`).join(", ");
        rows.push({ label: "按状态", value: statusSummary });
      }
      break;
    }
    case "get_task": {
      const task = taskRecord;
      push("任务", task?.subject ?? input?.task_id);
      push("状态", task?.status);
      push("负责人", task?.expert_id);
      const blockedBy = Array.isArray(task?.blocked_by) ? task!.blocked_by as unknown[] : [];
      const blocks = Array.isArray(task?.blocks) ? task!.blocks as unknown[] : [];
      push("blocked_by", joinStrings(blockedBy));
      push("blocks", joinStrings(blocks));
      const metadata = task?.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
        ? (task.metadata as Record<string, unknown>)
        : null;
      push("验收", acceptanceValue(metadata));
      break;
    }
    case "dispatch_agent": {
      const session = agentSession;
      push("Expert", session?.expert_id ?? input?.expert_id);
      push("Task", session?.task_id ?? input?.task_id);
      push("AgentSession", session?.agent_session_id);
      const resumeFrom = session?.resume_from_agent_session_id ?? input?.resume_agent_session_id;
      if (typeof resumeFrom === "string" && resumeFrom) {
        rows.push({ label: "派发", value: `恢复 ${resumeFrom}` });
      } else {
        rows.push({ label: "派发", value: "首次派发" });
      }
      break;
    }
    case "send_message": {
      push("Expert", input?.expert_id);
      push("摘要", input?.summary);
      const accepted = parsedObj?.accepted;
      if (typeof accepted === "boolean") {
        rows.push({ label: "送达", value: accepted ? "已接受" : "未接受" });
        if (!accepted) {
          const errorCode = parsedObj?.error && typeof parsedObj.error === "object" && !Array.isArray(parsedObj.error)
            ? (parsedObj.error as Record<string, unknown>).code
            : undefined;
          push("错误", errorCode);
        }
      } else if (typeof input?.content === "string" && input.content) {
        rows.push({ label: "内容", value: truncate(input.content, 120) });
      }
      break;
    }
  }

  if (failure) {
    push("错误码", failure.code);
    push("错误", failure.message);
  }

  return rows;
}

export function presentMcpTool(tool: TimelineTool): ToolPresentation {
  const parsed = parseMcpToolName(tool.toolName);
  const name = parsed?.tool ?? mcpToolName(tool.toolName);
  const kind: McpKind | "unknown" = isMcpKind(name) ? name : "unknown";
  const status = tool.state === "failed" || mcpFailure(tool.output) ? "failed" : tool.state;
  const input = tool.input ?? null;
  const mcp = parsed
    ? {
      server: tool.mcp?.server ?? parsed.server,
      tool: tool.mcp?.tool ?? parsed.tool,
      title: tool.mcp?.title ?? humanizeToolName(tool.mcp?.tool ?? parsed.tool),
      icons: safeIconList(tool.mcp?.icons),
      serverIcons: safeIconList(tool.mcp?.serverIcons),
    }
    : undefined;

  if (kind === "unknown") {
    return {
      kind: "mcp",
      icon: "unknown",
      status,
      statusLabel: status === "interrupted" ? "已中断" : status === "failed" ? "失败" : status === "running" ? "调用中" : "已完成",
      title: mcp?.title ?? (parsed ? humanizeToolName(parsed.tool) : tool.toolName),
      operationLabel: mcp ? `MCP · ${mcp.server}` : "调用",
      file: undefined,
      command: undefined,
      query: undefined,
      diff: undefined,
      detailRows: [
        ...(mcp ? [{ label: "工具名", value: tool.toolName }] : []),
      ],
      rawInput: input,
      rawOutput: tool.output,
      ...(mcp ? { mcp } : {}),
    };
  }

  return {
    kind: "mcp",
    icon: MCP_ICONS[kind],
    status,
    statusLabel: statusLabelForState(status, kind),
    title: titleForMcp(kind, input, tool.output),
    operationLabel: MCP_OPERATION_LABELS[kind],
    file: undefined,
    command: undefined,
    query: undefined,
    diff: undefined,
    detailRows: detailRowsForMcp(kind, input, tool.output),
    rawInput: input,
    rawOutput: tool.output,
    ...(mcp ? { mcp } : {}),
  };
}

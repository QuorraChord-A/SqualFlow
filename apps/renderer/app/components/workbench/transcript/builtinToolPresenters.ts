import { isLegacyProviderTool, kindForLegacyProviderTool } from "./legacyProviderTools";
import { kindForCapability } from "./toolKinds";
import { languageFromFilePath } from "../codeLanguage";
import type { ReadToolPresentation, TimelineTool, ToolIcon, ToolKind, ToolPresentation } from "./types";

export type { ToolPresentation } from "./types";

export function isBuiltInTool(toolName: string): boolean {
  return isLegacyProviderTool(toolName);
}

export function isExplicitPermissionDenial(output: unknown): boolean {
  let content: unknown = output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const result = output as Record<string, unknown>;
    if (result.is_error !== true) return false;
    content = result.content;
  }
  if (typeof content !== "string") return false;
  return content.startsWith("用户已明确拒绝执行该风险命令")
    || /^该风险命令已在当前 (?:Task|WorkRun) 中被用户明确拒绝/u.test(content);
}

function kindForBuiltInTool(tool: TimelineTool): ToolKind {
  const capabilityKind = kindForCapability(tool.capability);
  if (capabilityKind) return capabilityKind;
  return kindForLegacyProviderTool(tool.toolName) ?? "unknown";
}

function iconForKind(kind: ToolKind): ToolIcon {
  switch (kind) {
    case "glob":
    case "grep":
    case "web-search":
      return "search";
    case "read":
    case "write":
      return "file";
    case "edit":
      return "edit";
    case "bash":
      return "terminal";
    default:
      return "unknown";
  }
}

function runningLabelForKind(kind: ToolKind): string {
  switch (kind) {
    case "glob":
      return "探索中";
    case "grep":
    case "web-search":
      return "搜索中";
    case "read":
      return "读取中";
    case "write":
      return "写入中";
    case "edit":
      return "编辑中";
    case "bash":
      return "执行中";
    default:
      return "调用中";
  }
}

function completedLabelForKind(kind: ToolKind): string {
  switch (kind) {
    case "glob":
      return "已探索";
    case "grep":
    case "web-search":
      return "已搜索";
    case "read":
      return "已读取";
    case "write":
      return "已写入";
    case "edit":
      return "已编辑";
    case "bash":
      return "已执行";
    default:
      return "已完成";
  }
}

function operationLabelForKind(kind: ToolKind): string {
  switch (kind) {
    case "glob":
      return "探索";
    case "grep":
    case "web-search":
      return "搜索";
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "edit":
      return "编辑";
    case "bash":
      return "执行";
    default:
      return "调用";
  }
}

function statusLabelForState(status: ToolPresentation["status"], kind: ToolKind): string {
  switch (status) {
    case "queued":
      return "等待中";
    case "running":
      return runningLabelForKind(kind);
    case "completed":
      return completedLabelForKind(kind);
    case "failed":
      return kind === "bash" ? "执行失败" : "失败";
    case "interrupted":
      return "已中断";
    case "denied":
      return "已拒绝";
    default:
      return "";
  }
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(idx + 1) || trimmed || path;
}

function fileFromInput(input: Record<string, unknown> | null) {
  const filePath = stringInput(input, "path") ?? stringInput(input, "file_path");
  if (!filePath) return undefined;
  const name = lastSegment(filePath);
  return { path: filePath, name, language: languageFromFilePath(filePath) };
}

function stringInput(input: Record<string, unknown> | null, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

function parentPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "";
  const parent = normalized.slice(0, index);
  const prefix = parent.startsWith("/") ? "/ " : "";
  return `${prefix}${parent.split("/").filter(Boolean).join(" / ")}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOutputRecord(output: unknown): Record<string, unknown> | null {
  return output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : null;
}

function readOutputContent(output: unknown): string | undefined {
  const normalize = (content: string) => {
    const lines = content.split(/\r?\n/u);
    const nonEmptyLines = lines.filter((line) => line.length > 0);
    if (nonEmptyLines.length === 0 || !nonEmptyLines.every((line) => /^\s*\d+(?:→|\t)/u.test(line))) return content;
    return lines.map((line) => line.replace(/^\s*\d+(?:→|\t)/u, "")).join("\n");
  };

  if (typeof output === "string") return normalize(output);
  const record = readOutputRecord(output);
  return typeof record?.content === "string" ? normalize(record.content) : undefined;
}

function readOutputError(output: unknown): string | undefined {
  const record = readOutputRecord(output);
  if (record?.is_error !== true) return undefined;
  if (typeof record.content === "string" && record.content.length > 0) return record.content;
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  return "读取文件失败";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildReadPresentation(
  input: Record<string, unknown> | null,
  output: unknown,
  status: ToolPresentation["status"],
): ReadToolPresentation {
  const path = stringInput(input, "path") ?? stringInput(input, "file_path") ?? "";
  const requestedStart = Math.max(1, Math.trunc(finiteNumber(input?.offset) ?? 1));
  const requestedLimit = finiteNumber(input?.limit);
  const requestedEnd = requestedLimit && requestedLimit > 0
    ? requestedStart + Math.trunc(requestedLimit) - 1
    : undefined;
  const outputRecord = readOutputRecord(output);
  const error = status === "failed" || status === "denied" || status === "interrupted"
    ? readOutputError(output)
      ?? (typeof output === "string" && output.length > 0 ? output : undefined)
      ?? (status === "denied" ? "没有读取该文件的权限" : status === "interrupted" ? "读取已中断" : "读取文件失败")
    : undefined;
  const content = error ? undefined : readOutputContent(output);
  const returnedLineCount = content === undefined ? undefined : countLines(content);
  const returnedStart = Math.max(1, Math.trunc(
    finiteNumber(outputRecord?.returned_start)
      ?? finiteNumber(outputRecord?.returnedStart)
      ?? requestedStart,
  ));
  const returnedEnd = returnedLineCount && returnedLineCount > 0
    ? Math.trunc(finiteNumber(outputRecord?.returned_end) ?? finiteNumber(outputRecord?.returnedEnd) ?? (returnedStart + returnedLineCount - 1))
    : undefined;
  const truncated = outputRecord?.truncated === true || outputRecord?.is_truncated === true;
  const totalLines = finiteNumber(outputRecord?.total_lines) ?? finiteNumber(outputRecord?.totalLines);
  const encoding = typeof outputRecord?.encoding === "string" && outputRecord.encoding.length > 0
    ? outputRecord.encoding
    : "UTF-8";
  const resultBytes = content === undefined ? undefined : new TextEncoder().encode(content).byteLength;

  const rangeLabel = error
    ? "未读取"
    : returnedEnd
      ? `L${returnedStart}–${returnedEnd}`
      : returnedLineCount === 0
        ? "0 行"
        : requestedEnd
          ? `L${requestedStart}–${requestedEnd}`
          : requestedStart > 1
            ? `从 L${requestedStart}`
            : "完整文件";

  const sizeLabel = error
    ? "未返回内容"
    : status === "running" || status === "queued"
      ? "等待返回"
      : truncated
        ? "内容已截断"
        : resultBytes === undefined
          ? "未返回内容"
          : formatBytes(resultBytes);

  const detailMetaLabel = error
    ? "未返回内容"
    : status === "running" || status === "queued"
      ? "正在读取"
      : truncated && totalLines
        ? `显示 ${rangeLabel} · 文件共 ${Math.trunc(totalLines)} 行`
        : returnedLineCount === undefined
          ? "等待文件内容"
          : `${returnedLineCount} 行 · ${encoding}`;

  return {
    path,
    parentPath: parentPath(path),
    content,
    error,
    returnedStart,
    returnedLineCount,
    truncated,
    totalLines: totalLines === undefined ? undefined : Math.trunc(totalLines),
    rangeLabel,
    sizeLabel,
    detailMetaLabel,
  };
}

function computeDiff(input: Record<string, unknown> | null): { additions: number; deletions: number } | undefined {
  const oldString = typeof input?.old_string === "string" ? input.old_string : "";
  const newString = typeof input?.new_string === "string" ? input.new_string : "";
  if (oldString === "" && newString === "") return undefined;
  return { additions: countLines(newString), deletions: countLines(oldString) };
}

function computeWriteDiff(input: Record<string, unknown> | null): { additions: number; deletions: number } | undefined {
  const content = typeof input?.content === "string" ? input.content : "";
  return content === "" ? undefined : { additions: countLines(content), deletions: 0 };
}

function detailRowsFromInput(kind: ToolKind, input: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (!input) return rows;

  switch (kind) {
    case "read": {
      const filePath = stringInput(input, "path") ?? stringInput(input, "file_path");
      if (filePath) {
        rows.push({ label: "文件", value: filePath });
      }
      if (typeof input.offset === "number") {
        rows.push({ label: "偏移", value: String(input.offset) });
      }
      if (typeof input.limit === "number") {
        rows.push({ label: "限制", value: String(input.limit) });
      }
      break;
    }
    case "write": {
      const filePath = stringInput(input, "path") ?? stringInput(input, "file_path");
      if (filePath) {
        rows.push({ label: "文件", value: filePath });
      }
      const content = typeof input.content === "string" ? input.content : "";
      if (content) {
        rows.push({ label: "行数", value: String(countLines(content)) });
      }
      break;
    }
    case "edit": {
      const filePath = stringInput(input, "path") ?? stringInput(input, "file_path");
      if (filePath) {
        rows.push({ label: "文件", value: filePath });
      }
      break;
    }
    case "glob": {
      const pattern = stringInput(input, "pattern") ?? stringInput(input, "query");
      if (pattern) {
        rows.push({ label: "模式", value: pattern });
      }
      const basePath = stringInput(input, "path");
      if (basePath) {
        rows.push({ label: "路径", value: basePath });
      }
      break;
    }
    case "grep": {
      const pattern = stringInput(input, "pattern") ?? stringInput(input, "query");
      if (pattern) {
        rows.push({ label: "模式", value: pattern });
      }
      const basePath = stringInput(input, "path");
      if (basePath) {
        rows.push({ label: "路径", value: basePath });
      }
      if (typeof input.glob === "string") {
        rows.push({ label: "过滤", value: input.glob });
      }
      if (typeof input.output_mode === "string") {
        rows.push({ label: "输出", value: input.output_mode });
      }
      break;
    }
    case "bash": {
      const command = input.command;
      if (typeof command === "string") {
        rows.push({ label: "命令", value: command });
      }
      if (typeof input.description === "string") {
        rows.push({ label: "说明", value: input.description });
      }
      if (typeof input.timeout === "number") {
        rows.push({ label: "超时", value: `${input.timeout}ms` });
      }
      break;
    }
    case "web-search": {
      const query = stringInput(input, "query");
      if (query) {
        rows.push({ label: "查询", value: query });
      }
      break;
    }
    default:
      break;
  }

  return rows;
}

function titleForBuiltInTool(toolName: string, kind: ToolKind, input: Record<string, unknown> | null): string {
  if (kind === "read" || kind === "write" || kind === "edit") {
    const file = fileFromInput(input);
    if (file) return file.name;
  }

  switch (kind) {
    case "glob":
      return stringInput(input, "pattern") ?? stringInput(input, "query") ?? toolName;
    case "grep":
      return stringInput(input, "pattern") ?? stringInput(input, "query") ?? toolName;
    case "bash":
      return stringInput(input, "command") ?? toolName;
    case "web-search":
      return stringInput(input, "query") ?? toolName;
    default:
      return toolName;
  }
}

export function presentBuiltInTool(tool: TimelineTool): ToolPresentation {
  const kind = kindForBuiltInTool(tool);
  const readError = kind === "read" ? readOutputError(tool.output) : undefined;
  const status = isExplicitPermissionDenial(tool.output)
    ? "denied"
    : tool.state === "failed" || readError
      ? "failed"
      : tool.state;
  const input = tool.input ?? null;
  const file = kind === "read" || kind === "write" || kind === "edit" ? fileFromInput(input) : undefined;

  const base: ToolPresentation = {
    kind,
    icon: iconForKind(kind),
    status,
    statusLabel: statusLabelForState(status, kind),
    title: titleForBuiltInTool(tool.toolName, kind, input),
    operationLabel: status === "denied" && kind === "bash" ? "命令" : operationLabelForKind(kind),
    file,
    command: kind === "bash" ? stringInput(input, "command") : undefined,
    query: (kind === "glob" || kind === "grep" || kind === "web-search") && input
      ? String(input.pattern ?? input.query ?? "")
      : undefined,
    diff: kind === "edit" ? computeDiff(input) : kind === "write" ? computeWriteDiff(input) : undefined,
    read: kind === "read" ? buildReadPresentation(input, tool.output, status) : undefined,
    detailRows: detailRowsFromInput(kind, input),
    rawInput: input,
    rawOutput: tool.output,
  };

  return base;
}

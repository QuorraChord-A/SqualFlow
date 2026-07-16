"use client";

import { useEffect, useState } from "react";
import type { AgentSession } from "../../hooks/useFlowExperts";
import type { TaskData } from "../../hooks/useDashboardData";

interface TaskListPanelProps {
  tasks: TaskData[];
  agentSessions: AgentSession[];
  onOpenSession: (agentSessionId: string, taskId: string) => void;
}

function statusLabel(status: string) {
  if (status === "pending") return "等待依赖";
  if (status === "queued_for_expert") return "等待专家";
  if (status === "recovery_pending") return "等待恢复";
  if (status === "in_progress") return "运行中";
  if (status === "ready") return "待执行";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status || "未知";
}

function findEmphasizedTaskId(tasks: TaskData[]) {
  return (
    tasks.find((task) => task.status === "running")?.id ??
    tasks.find((task) => task.status === "ready")?.id ??
    tasks.find((task) => task.status === "pending")?.id ??
    tasks[0]?.id ??
    null
  );
}

type TaskResultView = {
  outcome: string | null;
  summary: string | null;
  files: string[];
  findings: string[];
  notes: string[];
  metrics: string[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function findingArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];

    const record = item as Record<string, unknown>;
    const severity = stringValue(record.severity);
    const description = stringValue(record.description);
    const text = severity && description ? `${severity}: ${description}` : severity ?? description;
    if (!text) return [];

    const file = stringValue(record.file);
    const rawLine = record.line;
    const line = typeof rawLine === "number" && Number.isFinite(rawLine)
      ? String(rawLine)
      : stringValue(rawLine);
    return [`${text}${file ? ` (${file}${line ? `:${line}` : ""})` : ""}`];
  });
}

function metricLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      return [`${key}: ${String(item)}`];
    }
    return [];
  });
}

function parseTaskResult(resultJson: string | null | undefined): TaskResultView | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const notes = stringArray(record.notes);
    const note = stringValue(record.notes);
    return {
      outcome: stringValue(record.turn_outcome) ?? stringValue(record.status),
      summary: stringValue(record.summary),
      files: stringArray(record.files_changed),
      findings: findingArray(record.findings),
      notes: note ? [note] : notes,
      metrics: metricLines(record.metrics),
    };
  } catch {
    return null;
  }
}

export default function TaskListPanel({ tasks, agentSessions, onOpenSession }: TaskListPanelProps) {
  const emphasizedTaskId = findEmphasizedTaskId(tasks);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(emphasizedTaskId);

  useEffect(() => {
    setExpandedTaskId((current) => {
      if (current && tasks.some((task) => task.id === current)) return current;
      return findEmphasizedTaskId(tasks);
    });
  }, [tasks]);

  if (tasks.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">暂无任务</div>;
  }

  return (
    <div className="p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">本轮任务</div>
      {tasks.map((task, index) => {
        const session = agentSessions.find((agentSession) => agentSession.id === task.agent_session_id)
          ?? agentSessions.find((agentSession) => agentSession.task_id === task.id);
        const isEmphasized = task.id === emphasizedTaskId;
        const isExpanded = task.id === expandedTaskId;
        const result = parseTaskResult(task.result_json);

        return (
          <article
            key={task.id}
            className={`border-b border-border transition-colors ${isExpanded ? "bg-primary/5" : ""}`}
          >
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
              className="grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-0.5 py-2 text-left"
            >
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Task {index + 1}</div>
                <div
                  className={`truncate text-sm font-semibold ${
                    isExpanded || isEmphasized ? "text-primary" : "text-foreground"
                  }`}
                >
                  {task.title}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                {statusLabel(task.status)}
              </span>
            </button>

            {isExpanded && (
              <div className="mb-2 ml-3 border-l-2 border-primary/20 bg-gradient-to-r from-primary/5 to-transparent pl-3">
                <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-2 text-sm leading-relaxed">
                  <div className="font-semibold text-muted-foreground">任务详情</div>
                  <div className="text-foreground">{task.description || task.id}</div>
                </div>
                <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-2 text-sm leading-relaxed">
                  <div className="font-semibold text-muted-foreground">依赖</div>
                  <div className="text-foreground">
                    {task.depends_on_task_ids.length > 0 ? task.depends_on_task_ids.join("、") : "无"}
                  </div>
                </div>
                <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-2 text-sm leading-relaxed">
                  <div className="font-semibold text-muted-foreground">验收标准</div>
                  <div className="text-foreground">
                    {task.acceptance_criteria?.length ? task.acceptance_criteria.join("；") : "未设置"}
                  </div>
                </div>
                {result && (
                  <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-2 text-sm leading-relaxed">
                    <div className="font-semibold text-muted-foreground">执行结果</div>
                    <div className="space-y-1 text-foreground">
                      {result.outcome && <div>{result.outcome}</div>}
                      {result.summary && <div>{result.summary}</div>}
                      {result.files.map((file) => <div key={`file-${file}`}>{file}</div>)}
                      {result.findings.map((finding) => <div key={`finding-${finding}`}>{finding}</div>)}
                      {result.notes.map((note) => <div key={`note-${note}`}>{note}</div>)}
                      {result.metrics.map((metric) => <div key={`metric-${metric}`}>{metric}</div>)}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">执行专家</div>
                    <div className="truncate text-sm font-semibold text-foreground">
                      {session?.display_name || task.expert_id}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!session}
                    onClick={() => {
                      if (session) onOpenSession(session.id, task.id);
                    }}
                    className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    查看会话
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

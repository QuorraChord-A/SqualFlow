"use client";

import { useState } from "react";
import type { AgentSession } from "../../hooks/useFlowExperts";
import type { TaskData } from "../../hooks/useDashboardData";

interface ExpertListPanelProps {
  agentSessions: AgentSession[];
  tasks: TaskData[];
  onOpenSession: (agentSessionId: string, taskId: string | null) => void;
}

function shortId(id: string | null) {
  return id?.slice(0, 8) || "—";
}

function statusLabel(status: string) {
  if (status === "running") return "运行中";
  if (status === "pending") return "等待依赖";
  if (status === "ready") return "待执行";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return status || "未知";
}

function tasksForSession(session: AgentSession, tasks: TaskData[]) {
  if (!session.task_id) return [];
  return tasks.filter((task) => task.id === session.task_id);
}

function SessionRow({
  session,
  tasks,
  isExpanded,
  onToggle,
  onOpenSession,
}: {
  session: AgentSession;
  tasks: TaskData[];
  isExpanded: boolean;
  onToggle: () => void;
  onOpenSession: (agentSessionId: string, taskId: string | null) => void;
}) {
  const sessionTasks = tasksForSession(session, tasks);
  const latestTask = sessionTasks[0] ?? null;

  return (
    <article className={`border-b border-border ${isExpanded ? "bg-primary/5" : ""}`}>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-0.5 py-2 text-left"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
          {session.display_name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{session.expert_id}</div>
          <div className="truncate text-sm font-bold text-foreground">{session.display_name}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            最新任务：{latestTask?.title || "暂无任务"}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <div>{sessionTasks.length} 任务</div>
          <div className="mt-1">{shortId(session.session_id)}</div>
        </div>
      </button>

      {isExpanded && (
        <div className="mb-3 ml-10 border-l-2 border-primary/20 pl-3">
          <div className="py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">最新任务</div>
          {sessionTasks.length === 0 ? (
            <div className="pb-2 text-sm text-muted-foreground">暂无任务</div>
          ) : (
            <div className="max-h-36 overflow-auto">
              {sessionTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenSession(session.id, task.id)}
                  className="grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 py-1.5 text-left last:border-b-0"
                >
                  <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
                  <span className="rounded-full bg-background px-2 py-1 text-[10px] text-muted-foreground">
                    {statusLabel(task.status)}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => onOpenSession(session.id, session.task_id)}
            className="mt-2 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            查看会话
          </button>
        </div>
      )}
    </article>
  );
}

export default function ExpertListPanel({ agentSessions, tasks, onOpenSession }: ExpertListPanelProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const leaderSession = agentSessions.find((session) => session.expert_id === "exp-leader");
  const workerSessions = agentSessions.filter((session) => session.expert_id !== "exp-leader");
  const toggleSession = (sessionId: string) => {
    setExpandedSessionId((current) => (current === sessionId ? null : sessionId));
  };

  return (
    <div className="p-3">
      <section>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Leader</div>
        {leaderSession ? (
          <SessionRow
            session={leaderSession}
            tasks={tasks}
            isExpanded={expandedSessionId === leaderSession.id}
            onToggle={() => toggleSession(leaderSession.id)}
            onOpenSession={onOpenSession}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            暂无 Leader 会话
          </div>
        )}
      </section>

      <section className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">专家</div>
        {workerSessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            暂无专家会话
          </div>
        ) : (
          <div>
            {workerSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                tasks={tasks}
                isExpanded={expandedSessionId === session.id}
                onToggle={() => toggleSession(session.id)}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

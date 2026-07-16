import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TaskListPanel from "./TaskListPanel";
import type { TaskData } from "../../hooks/useDashboardData";

function task(overrides: Partial<TaskData>): TaskData {
  return {
    id: "task-1",
    user_turn_id: "utn-1",
    title: "Implement form",
    description: "Add the form",
    expert_id: "exp-frontend",
    status: "completed",
    agent_session_id: "session-1",
    depends_on_task_ids: [],
    acceptance_criteria: [],
    result_json: null,
    ...overrides,
  };
}

describe("TaskListPanel task result rendering", () => {
  it("renders the new ExpertResult result_json shape", () => {
    render(
      <TaskListPanel
        tasks={[task({
          result_json: JSON.stringify({
            turn_outcome: "completed",
            summary: "Implemented the checkout form",
            files_changed: ["app/checkout.tsx"],
            metrics: { tests: "3 passed" },
          }),
        })]}
        agentSessions={[]}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByText("执行结果")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("Implemented the checkout form")).toBeInTheDocument();
    expect(screen.getByText("app/checkout.tsx")).toBeInTheDocument();
    expect(screen.getByText("tests: 3 passed")).toBeInTheDocument();
  });

  it("renders the legacy result_json shape", () => {
    render(
      <TaskListPanel
        tasks={[task({
          id: "task-legacy",
          result_json: JSON.stringify({
            status: "done",
            summary: "Legacy result summary",
            findings: ["Finding one"],
            notes: "Legacy note",
          }),
        })]}
        agentSessions={[]}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("Legacy result summary")).toBeInTheDocument();
    expect(screen.getByText("Finding one")).toBeInTheDocument();
    expect(screen.getByText("Legacy note")).toBeInTheDocument();
  });

  it("renders legacy object findings", () => {
    render(
      <TaskListPanel
        tasks={[task({
          id: "task-legacy-findings",
          result_json: JSON.stringify({
            status: "done",
            findings: [
              { severity: "high", description: "Missing validation", file: "app/form.tsx", line: 42 },
              { severity: "low", description: "Copy is unclear", file: "app/copy.tsx" },
            ],
          }),
        })]}
        agentSessions={[]}
        onOpenSession={vi.fn()}
      />,
    );

    expect(screen.getByText("high: Missing validation (app/form.tsx:42)")).toBeInTheDocument();
    expect(screen.getByText("low: Copy is unclear (app/copy.tsx)")).toBeInTheDocument();
  });
});

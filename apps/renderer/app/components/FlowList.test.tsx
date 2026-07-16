import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SquadFlow } from "../types";
import FlowList, { sortFlows } from "./FlowList";

const flows: SquadFlow[] = [
  {
    id: "flow-old",
    name: "Old",
    description: "",
    type: "full",
    status: "idle",
    current_stage: "review",
    project_id: "project-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_pinned: false,
    has_pending_decision: false,
  },
  {
    id: "flow-pinned",
    name: "Pinned",
    description: "",
    type: "full",
    status: "idle",
    current_stage: "clarify",
    project_id: "project-1",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    is_pinned: true,
    has_pending_decision: true,
  },
];

vi.mock("../stores/useFlowStore", () => ({
  useFlowStore: () => ({
    flows,
    selectedFlowId: null,
    handleSelectFlow: vi.fn(),
    setFlowPinned: vi.fn(),
  }),
}));

describe("FlowList", () => {
  it("sorts pinned flows before recently updated unpinned flows", () => {
    expect(sortFlows(flows).map((flow) => flow.id)).toEqual(["flow-pinned", "flow-old"]);
  });

  it("does not render a duplicate New Flow button below the list", () => {
    render(<FlowList onNewFlow={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "+ New Flow" })).not.toBeInTheDocument();
  });

  it("shows pinned and waiting-operation states", () => {
    render(<FlowList onNewFlow={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByRole("button", { name: "取消置顶" })).toBeInTheDocument();
    expect(screen.getByTestId("flow-pending-spinner")).toBeInTheDocument();
    expect(screen.getAllByTestId("flow-status-dot")).toHaveLength(1);
    expect(screen.getByText("等待操作")).toBeInTheDocument();
  });
});

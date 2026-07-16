import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPanel from "./SessionDetailPanel";

const { mockUseFlowExperts } = vi.hoisted(() => ({ mockUseFlowExperts: vi.fn() }));

vi.mock("../../hooks/useFlowExperts", () => ({ useFlowExperts: mockUseFlowExperts }));
vi.mock("./SessionTranscriptPanel", () => ({
  default: ({ isAwaitingResponse, workspaceRootPath }: { isAwaitingResponse?: boolean; workspaceRootPath?: string | null }) => (
    <div data-testid="transcript-state" data-workspace-root={workspaceRootPath ?? ""}>
      {isAwaitingResponse ? "awaiting" : "idle"}
    </div>
  ),
}));

function expert(status: string) {
  return {
    id: "fexp-1",
    flow_expert_id: "fexp-1",
    flow_id: "flow-1",
    expert_id: "exp-frontend",
    display_name: "Frontend",
    status,
    agent_session_id: "ags-1",
    session_id: null,
    current_task_id: "task-1",
    current_task_title: "Build UI",
  };
}

describe("SessionDetailPanel", () => {
  beforeEach(() => mockUseFlowExperts.mockReset());

  it.each(["queued", "streaming"])("shows waiting while Expert is %s", (status) => {
    mockUseFlowExperts.mockReturnValue({ flowExperts: [expert(status)] });
    render(<SessionDetailPanel flowId="flow-1" flowExpertId="fexp-1" />);
    expect(screen.getByTestId("transcript-state")).toHaveTextContent("awaiting");
  });

  it.each(["idle", "completed", "failed"])("does not show waiting while Expert is %s", (status) => {
    mockUseFlowExperts.mockReturnValue({ flowExperts: [expert(status)] });
    render(<SessionDetailPanel flowId="flow-1" flowExpertId="fexp-1" />);
    expect(screen.getByTestId("transcript-state")).toHaveTextContent("idle");
  });

  it("passes the workspace root to the Expert transcript", () => {
    mockUseFlowExperts.mockReturnValue({ flowExperts: [expert("idle")] });
    render(<SessionDetailPanel flowId="flow-1" flowExpertId="fexp-1" workspaceRootPath="/repo" />);
    expect(screen.getByTestId("transcript-state")).toHaveAttribute("data-workspace-root", "/repo");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessions } from "./useAgentSessions";

vi.mock("../lib/ws", () => ({
  wsClient: {
    onEvent: vi.fn(() => () => undefined),
  },
}));

function Probe() {
  const { agentSessions } = useAgentSessions("flow-1");
  return <output>{agentSessions.map((expert) => expert.agent_session_id).join(",")}</output>;
}

describe("useAgentSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads one Flow Expert identity from the Flow-level endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "fexp-frontend",
      agent_session_id: "fexp-frontend",
      flow_id: "flow-1",
      expert_id: "exp-frontend",
      display_name: "Frontend",
      status: "idle",
      agent_run_id: "ags-2",
      session_id: "sdk-frontend",
      current_task_id: "task-2",
      current_task_title: "优化页面",
    }]), { status: 200 })));

    render(<Probe />);

    await waitFor(() => expect(screen.getByText("fexp-frontend")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith("/api/flows/flow-1/agent-sessions");
  });
});

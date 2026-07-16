import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFlowExperts } from "./useFlowExperts";

vi.mock("../lib/ws", () => ({
  wsClient: {
    onEvent: vi.fn(() => () => undefined),
  },
}));

function Probe() {
  const { flowExperts } = useFlowExperts("flow-1");
  return <output>{flowExperts.map((expert) => expert.flow_expert_id).join(",")}</output>;
}

describe("useFlowExperts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads one Flow Expert identity from the Flow-level endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "fexp-frontend",
      flow_expert_id: "fexp-frontend",
      flow_id: "flow-1",
      expert_id: "exp-frontend",
      display_name: "Frontend",
      status: "idle",
      agent_session_id: "ags-2",
      session_id: "sdk-frontend",
      current_task_id: "task-2",
      current_task_title: "优化页面",
    }]), { status: 200 })));

    render(<Probe />);

    await waitFor(() => expect(screen.getByText("fexp-frontend")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith("/api/flows/flow-1/flow-experts");
  });
});

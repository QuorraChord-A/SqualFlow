import { describe, expect, it, vi } from "vitest";
import { reportRuntimeDiagnostic } from "../src/runtime/runtimeDiagnosticReporter.js";
import { EventBus } from "../src/ws/eventBus.js";

describe("reportRuntimeDiagnostic", () => {
  it("publishes only the fixed connection status to the active flow", async () => {
    const eventBus = new EventBus();
    const received: unknown[] = [];
    eventBus.subscribe("flow-1", "client-1", (message) => received.push(message));
    const context = {
      runtimeRole: "expert" as const,
      flowId: "flow-1",
      userTurnId: "turn-1",
      taskId: "task-1",
      flowExpertId: "fexp-1",
      agentSessionId: "agent-1",
    };

    reportRuntimeDiagnostic({
      eventBus,
      context,
      event: {
        type: "provider_connection_status",
        state: "reconnecting",
        message: "Codex WebSocket 正在重连（2/5）",
        attempt: 2,
        maxAttempts: 5,
      },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      type: "runtime:transport",
      flow_id: "flow-1",
      agent_session_id: "agent-1",
      flow_expert_id: "fexp-1",
      data: {
        state: "reconnecting",
        message: "Codex WebSocket 正在重连（2/5）",
        attempt: 2,
        max_attempts: 5,
        runtime_role: "expert",
        user_turn_id: "turn-1",
        task_id: "task-1",
      },
    });

    reportRuntimeDiagnostic({
      eventBus,
      context,
      event: { type: "provider_stderr", message: "raw diagnostic must stay in logs" },
    });
    await Promise.resolve();
    expect(received).toHaveLength(1);
  });
});

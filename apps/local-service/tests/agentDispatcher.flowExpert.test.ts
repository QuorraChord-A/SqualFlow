import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginUserTurn, createWorkingUserTurn } from "./helpers/userTurnTestHelpers.js";
import { createAgentDispatcher } from "../src/runtime/agentDispatcher.js";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "squadflow-dispatch-flow-expert-"));
  const store = createStore(path.join(dir, "test.db"));
  store.migrate();
  store.seedExperts();
  const project = store.createProject({ name: "p", localPath: "/tmp/p" });
  const flow = store.createFlow({ projectId: project.id, name: "flow" });
  const userTurn = beginUserTurn(store, { flowId: flow.id, source: "direct_message" })!;
  return {
    store,
    flow,
    userTurn,
    cleanup: () => {
      store.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AgentDispatcher Flow Expert reuse", () => {
  it("reuses one Flow Expert and initially queues both task runtimes", async () => {
    const { store, flow, userTurn, cleanup } = setup();
    const runTask = vi.fn(async () => undefined);
    const eventBus = { publish: vi.fn(async () => undefined) };
    try {
      const dispatcher = createAgentDispatcher({ store, eventBus: eventBus as any, expertRuntime: { runTask } });
      const task1 = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "t1", description: "one", expertId: null, activeForm: "", dependsOnTaskIds: [] })!;
      const task2 = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "t2", description: "two", expertId: null, activeForm: "", dependsOnTaskIds: [] })!;

      const first = await dispatcher.dispatchAgent({ flowId: flow.id, taskId: task1.id, expertId: "exp-coder", prompt: "one", resumeAgentSessionId: "" });
      const second = await dispatcher.dispatchAgent({ flowId: flow.id, taskId: task2.id, expertId: "exp-coder", prompt: "two", resumeAgentSessionId: "" });

      expect(first.flow_expert_id).toBeTruthy();
      expect(second.flow_expert_id).toBe(first.flow_expert_id);
      expect(store.getTask(task1.id)).toEqual(expect.objectContaining({
        flowExpertId: first.flow_expert_id,
        status: "queued_for_expert",
      }));
      expect(store.getTask(task2.id)).toEqual(expect.objectContaining({
        flowExpertId: first.flow_expert_id,
        status: "queued_for_expert",
      }));
      expect(store.getAgentSession(first.agent_session_id)?.status).toBe("queued");
      expect(store.getAgentSession(second.agent_session_id)?.status).toBe("queued");
      expect(runTask).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });
});

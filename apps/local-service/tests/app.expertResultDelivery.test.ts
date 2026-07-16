import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { routeExpertResultToLeader } from "../src/server/app.js";

describe("Expert result delivery", () => {
  it("delivers a completed Expert result while the UserTurn waits for plan approval", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const project = store.createProject({ id: "project-delivery", name: "Delivery", localPath: "/tmp/delivery" });
    const flow = store.createFlow({ id: "flow-delivery", name: "Delivery", description: "", projectId: project.id });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-delivery" })!;
    store.pauseUserTurnForUserAction(userTurn.id);
    const leader = store.createAgentSession({
      flowId: flow.id,
      taskId: null,
      userTurnId: null,
      expertId: "exp-leader",
      sessionId: "leader-session",
      status: "completed",
    })!;
    const runLeaderTurn = vi.fn(async () => undefined);
    const advanceForTask = vi.fn(async () => undefined);

    try {
      await expect(routeExpertResultToLeader({
        store,
        orchestrationScheduler: { advanceForTask },
        leaderRuntime: { runLeaderTurn },
        event: {
          flowId: flow.id,
          userTurnId: userTurn.id,
          taskId: "task-v1",
          agentSessionId: "ags-v1",
          expertId: "exp-coder",
          status: "completed",
          turnOutcome: "completed",
          summary: "完成旧版本任务",
          error: null,
          artifactRefs: [],
          completedAt: "2026-07-11T19:00:00.000Z",
        },
      })).resolves.toBe(true);

      expect(advanceForTask).toHaveBeenCalledWith("task-v1");
      expect(runLeaderTurn).toHaveBeenCalledWith(expect.objectContaining({
        kind: "expert_result",
        userTurnId: userTurn.id,
      }));
      expect(store.getUserTurn(userTurn.id)?.status).toBe("waiting_user");
      expect(leader.status).toBe("completed");
    } finally {
      store.sqlite.close();
    }
  });
});

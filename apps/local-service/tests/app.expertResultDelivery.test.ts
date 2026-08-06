import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { routeExpertMessageToLeader, routeExpertResultToLeader } from "../src/server/app.js";
import { beginWorkRun } from "./helpers/workRunTestHelpers.js";

describe("Expert result delivery", () => {
  it("delivers a completed Expert result while the WorkRun waits for plan approval", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const project = store.createProject({ id: "project-delivery", name: "Delivery", localPath: "/tmp/delivery" });
    const flow = store.createFlow({ id: "flow-delivery", name: "Delivery", description: "", projectId: project.id });
    const workRun = beginWorkRun(store, { flowId: flow.id, triggerMessageId: "msg-delivery" })!;
    store.waitWorkRunForUserAction(workRun.id);
    const leader = store.createAgentSession({
      flowId: flow.id,
      taskId: null,
      workRunId: null,
      expertId: "exp-leader",
      sessionId: "leader-session",
      status: "completed",
    })!;
    const runLeaderTurn = vi.fn(async () => undefined);
    try {
      await expect(routeExpertResultToLeader({
        store,
        leaderRuntime: { runLeaderTurn },
        event: {
          flowId: flow.id,
          workRunId: workRun.id,
          taskId: "task-v1",
          agentSessionId: "ags-v1",
          expertId: "exp-coder",
          status: "completed",
          taskStatus: "in_progress",
          turnOutcome: "completed",
          summary: "完成旧版本任务",
          error: null,
          artifactRefs: [],
          completedAt: "2026-07-11T19:00:00.000Z",
        },
      })).resolves.toBe(true);

      expect(runLeaderTurn).toHaveBeenCalledWith(expect.objectContaining({
        kind: "expert_result",
        workRunId: workRun.id,
      }));
      expect(store.getWorkRun(workRun.id)?.status).toBe("waiting_user");
      expect(leader.status).toBe("completed");
    } finally {
      store.sqlite.close();
    }
  });

  it("delivers a taskless Expert message back to the same active Leader turn", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const project = store.createProject({ id: "project-message", name: "Message", localPath: "/tmp/message" });
    const flow = store.createFlow({ id: "flow-message", name: "Message", description: "", projectId: project.id });
    store.createAgentSession({
      flowId: flow.id,
      taskId: null,
      workRunId: null,
      expertId: "exp-leader",
      sessionId: "leader-message-session",
      status: "completed",
    });
    const runLeaderTurn = vi.fn(async () => undefined);
    try {
      await expect(routeExpertMessageToLeader({
        store,
        leaderRuntime: { runLeaderTurn },
        event: {
          flowId: flow.id,
          workRunId: null,
          agentSessionId: "ags-message",
          expertId: "exp-research",
          status: "completed",
          turnOutcome: "completed",
          summary: "我有 Context7 和 Tavily。",
          error: null,
          artifactRefs: [],
          completedAt: "2026-07-31T02:00:00.000Z",
        },
      })).resolves.toBe(true);

      expect(runLeaderTurn).toHaveBeenCalledWith(expect.objectContaining({
        flowId: flow.id,
        kind: "expert_message",
        workRunId: undefined,
        expertMessage: expect.objectContaining({
          agentSessionId: "ags-message",
          expertId: "exp-research",
          summary: "我有 Context7 和 Tavily。",
        }),
      }));
      expect(store.listTasks(flow.id)).toEqual([]);
    } finally {
      store.sqlite.close();
    }
  });
});

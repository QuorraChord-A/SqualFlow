import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginWorkRun } from "./helpers/workRunTestHelpers.js";
import { createApp } from "../src/server/app.js";

describe("Flow Expert app recovery", () => {
  function createRunningExpertWork(store: ReturnType<typeof createStore>, flowId: string) {
    const flow = store.createFlow({ id: flowId, workspaceId: "ws-default", name: "Recover", description: "", projectId: null });
    const workRun = beginWorkRun(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-before-restart");
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Recover task",
      description: "Recover the interrupted task",
      expertId: "exp-coder",
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      displayName: "Coder",
      status: "queued",
    })!;
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "in_progress");
    store.activateFlowExpertTask(task.id, session.id);
    return { flow, workRun, flowExpert, task, session };
  }

  it("on first restart interrupts stale Expert work without scheduling recovery", () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const fixture = createRunningExpertWork(store, "flow-first-restart");

    const result = store.interruptStaleExpertSessions();

    expect(result).toEqual({ interruptedSessionCount: 1 });
    expect(store.getTask(fixture.task.id)?.status).toBe("in_progress");
    expect(store.getAgentSession(fixture.session.id)?.status).toBe("interrupted");
    expect(store.getWorkRun(fixture.workRun.id)?.status).toBe("executing");
    store.sqlite.close();
  });

  it("does not repeatedly process an already interrupted Expert session", () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const fixture = createRunningExpertWork(store, "flow-second-restart");

    const firstRestart = store.interruptStaleExpertSessions();
    const secondRestart = store.interruptStaleExpertSessions();

    expect(firstRestart).toEqual({ interruptedSessionCount: 1 });
    expect(secondRestart).toEqual({ interruptedSessionCount: 0 });
    expect(store.getFlowExpert(fixture.flowExpert.id)?.sdkSessionId).toBe("sdk-before-restart");
    expect(store.getTask(fixture.task.id)?.status).toBe("in_progress");
    expect(store.getAgentSession(fixture.session.id)?.status).toBe("interrupted");
    store.sqlite.close();
  });

  it("does not close an active WorkRun merely because the app started", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-stuck-turn",
      workspaceId: "ws-default",
      name: "Stuck",
      description: "",
      projectId: null,
    });
    const finishedTurn = store.createWorkRun({
      flowId: flow.id,
      triggerMessageId: "msg-finished",
      startedAt: "2026-06-28T09:06:47.701Z",
    })!;
    store.failWorkRun(finishedTurn.id, "failed", "2026-06-28T09:08:09.770Z");
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      workRunId: finishedTurn.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Finished task",
      description: "already done",
      expertId: "exp-research",
      dependsOnTaskIds: [],
    })!;
    store.startTask(task.id, "ags-finished");
    store.completeTask(task.id, JSON.stringify({ status: "done", summary: "done" }));
    const app = createApp({ logger: false, store });

    try {
      expect(store.getWorkRun(workRun.id)?.status).toBe("executing");
      expect(store.getFlow(flow.id)?.status).toBe("idle");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("preserves a confirmed FlowExpert ProviderSession without auto-resuming it after cold startup", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-app-recover",
      workspaceId: "ws-default",
      name: "Recover",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-before-restart");
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Recover task",
      description: "Recover the queued task",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      displayName: "Frontend",
      status: "queued",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "in_progress");

    const app = createApp({ logger: false, store });

    try {
      expect(store.getTask(task.id)?.status).toBe("in_progress");
      expect(store.getAgentSession(session.id)?.status).toBe("interrupted");
      expect(store.getFlowExpert(flowExpert.id)?.status).toBe("idle");
      expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBe("sdk-before-restart");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("interrupts a stale temporary AgentSession without promoting it to ProviderSession", async () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({
      id: "flow-app-recover-temporary-session",
      workspaceId: "ws-default",
      name: "Recover temporary session",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Recover task with temporary session",
      description: "Recover without resuming the temporary session",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      sessionId: "temporary-worker-uuid",
      displayName: "Frontend",
      status: "queued",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "in_progress");

    const app = createApp({ logger: false, store });

    try {
      expect(store.getTask(task.id)?.status).toBe("in_progress");
      expect(store.getAgentSession(session.id)?.status).toBe("interrupted");
      expect(store.getFlowExpert(flowExpert.id)?.status).toBe("idle");
      expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBeNull();
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });
});

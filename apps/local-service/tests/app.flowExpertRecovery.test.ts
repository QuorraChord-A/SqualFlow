import { describe, expect, it } from "vitest";
import type { ClaudeQueryInput, ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { createStore } from "../src/db/store.js";
import { beginUserTurn } from "./helpers/userTurnTestHelpers.js";
import { createApp } from "../src/server/app.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";
import { listUserTurnsNeedingRecovery } from "../src/runtime/userTurnLifecycle.js";

function successfulQuery(onDrained: () => void): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result",
        subtype: "success",
        session_id: "sdk-recovered-frontend",
        is_error: false,
        structured_output: {
          status: "done",
          summary: "recovered",
          files_changed: [],
          findings: [],
          metrics: {},
          notes: "",
        },
      };
      onDrained();
    },
    close() {},
  };
}

describe("Flow Expert app recovery", () => {
  function createRunningExpertWork(store: ReturnType<typeof createStore>, flowId: string) {
    const flow = store.createFlow({ id: flowId, workspaceId: "ws-default", name: "Recover", description: "", projectId: null });
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-before-restart");
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Recover task",
      description: "Recover the interrupted task",
      expertId: "exp-coder",
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      displayName: "Coder",
      status: "queued",
    })!;
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "queued_for_expert");
    store.activateFlowExpertTask(task.id, session.id);
    return { flow, userTurn, flowExpert, task, session };
  }

  it("on first restart schedules interrupted Expert work without scheduling Leader recovery", () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const fixture = createRunningExpertWork(store, "flow-first-restart");

    const expertRecovery = store.recoverFlowExpertRuntimeWork();

    expect(expertRecovery).toEqual([
      expect.objectContaining({ taskId: fixture.task.id, userTurnId: fixture.userTurn.id }),
    ]);
    expect(store.getTask(fixture.task.id)?.status).toBe("recovery_pending");
    expect(store.getAgentSession(fixture.session.id)?.status).toBe("interrupted");
    expect(listUserTurnsNeedingRecovery(store)).toEqual([]);
    store.sqlite.close();
  });

  it("on a second restart recovers the same recovery_pending and interrupted Expert work", () => {
    const store = createStore(":memory:");
    store.migrate();
    store.seedExperts();
    const fixture = createRunningExpertWork(store, "flow-second-restart");

    const firstRestart = store.recoverFlowExpertRuntimeWork();
    const secondRestart = store.recoverFlowExpertRuntimeWork();

    expect(firstRestart.map((item) => item.taskId)).toEqual([fixture.task.id]);
    expect(secondRestart).toEqual([
      expect.objectContaining({
        taskId: fixture.task.id,
        userTurnId: fixture.userTurn.id,
        agentSessionId: fixture.session.id,
      }),
    ]);
    expect(secondRestart[0]?.resumeSessionId).toBe("sdk-before-restart");
    expect(store.getFlowExpert(fixture.flowExpert.id)?.sdkSessionId).toBe("sdk-before-restart");
    expect(store.getTask(fixture.task.id)?.status).toBe("recovery_pending");
    expect(store.getAgentSession(fixture.session.id)?.status).toBe("interrupted");
    store.sqlite.close();
  });

  it("does not close an active UserTurn merely because the app started", async () => {
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
    const finishedTurn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-finished",
      startedAt: "2026-06-28T09:06:47.701Z",
    })!;
    store.failUserTurn(finishedTurn.id, "failed", "2026-06-28T09:08:09.770Z");
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      userTurnId: finishedTurn.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Finished task",
      description: "already done",
      expertId: "exp-research",
      dependsOnTaskIds: [],
    })!;
    store.startTask(task.id, "ags-finished");
    store.completeTask(task.id, JSON.stringify({ status: "done", summary: "done" }));
    const app = createApp({ logger: false, store });

    try {
      expect(store.getUserTurn(userTurn.id)?.status).toBe("active");
      expect(store.getFlow(flow.id)?.status).toBe("active");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("preserves a confirmed FlowExpert SDK session and resumes it after cold startup", async () => {
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
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-before-restart");
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Recover task",
      description: "Recover the queued task",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      displayName: "Frontend",
      status: "queued",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "queued_for_expert");

    let captured: ClaudeQueryInput | null = null;
    let persistedSessionAtQueryStart: string | null | undefined;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        persistedSessionAtQueryStart = store.getFlowExpert(flowExpert.id)?.sdkSessionId;
        return successfulQuery(resolveDrained);
      } }),
    });

    try {
      await drained;
      expect(persistedSessionAtQueryStart).toBe("sdk-before-restart");
      expect(captured?.options?.resume).toBe("sdk-before-restart");
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getAgentSession(session.id)?.status).toBe("completed");
      expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBe("sdk-recovered-frontend");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("starts a fresh session when only AgentSession has a temporary session ID", async () => {
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
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Recover task with temporary session",
      description: "Recover without resuming the temporary session",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      sessionId: "temporary-worker-uuid",
      displayName: "Frontend",
      status: "queued",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "queued_for_expert");

    let captured: ClaudeQueryInput | null = null;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        return successfulQuery(resolveDrained);
      } }),
    });

    try {
      await drained;
      expect(captured?.options?.resume).toBeUndefined();
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getAgentSession(session.id)?.status).toBe("completed");
      expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBe("sdk-recovered-frontend");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });
});

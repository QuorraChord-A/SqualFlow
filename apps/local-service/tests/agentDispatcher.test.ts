import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginUserTurn, createWorkingUserTurn } from "./helpers/userTurnTestHelpers.js";
import { createAgentDispatcher } from "../src/runtime/agentDispatcher.js";
import { EventBus } from "../src/ws/eventBus.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-dispatcher-"));
  dirs.push(dir);
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runtime(runTask: (...args: any[]) => Promise<void> = async () => undefined) {
  return { runTask };
}

describe("agent dispatcher", () => {
  it("rejects flow-level support sessions in V1", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-support",
      workspaceId: "ws-default",
      name: "Support",
      description: "",
      projectId: null,
    });
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: null,
      expertId: "exp-research",
      prompt: "Research options",
      resumeAgentSessionId: "",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "task_id is required in V1",
    });
  });

  it("rejects missing tasks", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-missing",
      workspaceId: "ws-default",
      name: "Missing",
      description: "",
      projectId: null,
    });
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: "task-missing",
      expertId: "exp-research",
      prompt: "Research options",
      resumeAgentSessionId: "",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "task not found",
    });
  });

  it("binds an expert and starts a V1 task with no pre-assigned expert", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-v1-bind",
      workspaceId: "ws-default",
      name: "V1 Bind",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: null,
      dependsOnTaskIds: [],
    })!;
    const runTask = vi.fn(async () => undefined);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(runTask),
    });

    const result = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Implement Build",
      resumeAgentSessionId: "",
    });

    expect(result.status).toBe("queued");
    expect(result.flow_expert_id).toBeTruthy();
    const agentSessionId = result.agent_session_id;
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "queued_for_expert",
      expertId: "exp-coder",
      flowExpertId: result.flow_expert_id,
      agentSessionId,
    }));
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      flowExpertId: result.flow_expert_id,
      agentSessionId,
      prompt: "Implement Build",
    }));
  });

  it("rejects expert mismatch when task already has a different expert", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-mismatch",
      workspaceId: "ws-default",
      name: "Mismatch",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-verify",
      prompt: "Implement Build",
      resumeAgentSessionId: "",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "expert does not match task expert",
    });
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "pending",
      expertId: "exp-coder",
      agentSessionId: null,
    }));
  });

  it("starts runnable UserTurn Task sessions", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-task",
      workspaceId: "ws-default",
      name: "Task",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const runTask = vi.fn(async () => undefined);
    const eventBus = new EventBus();
    const events: any[] = [];
    eventBus.subscribe(flow.id, "test", (message) => events.push(message));
    const dispatcher = createAgentDispatcher({
      store,
      eventBus,
      expertRuntime: runtime(runTask),
    });

    const result = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Implement Build",
      resumeAgentSessionId: "",
    });

    expect(result.status).toBe("queued");
    expect(result.flow_expert_id).toBeTruthy();
    const agentSessionId = result.agent_session_id;
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "queued_for_expert",
      flowExpertId: result.flow_expert_id,
      agentSessionId,
    }));
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      flowExpertId: result.flow_expert_id,
      agentSessionId,
      prompt: "Implement Build",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "session:event",
      flow_id: flow.id,
      data: expect.objectContaining({
        event: "created",
        agent_session_id: agentSessionId,
        task_id: task.id,
        expert_id: "exp-coder",
        flow_expert_id: result.flow_expert_id,
        // Person name from template candidates (not role title / "Coder").
        display_name: expect.stringMatching(/^.{2,3}$/),
        status: "queued",
      }),
    }));
    const createdSessionEvent = events.find((event) =>
      event.type === "session:event"
      && (event as { data?: { event?: string } }).data?.event === "created"
    ) as { data: { display_name: string } } | undefined;
    expect(createdSessionEvent?.data.display_name).not.toBe("Coder");
    expect(createdSessionEvent?.data.display_name).not.toBe("全栈开发专家");
    expect(events.some((event) => event.type === "session:history")).toBe(false);
    const audit = store.listEventLog(flow.id).find((event) =>
      event.agentSessionId === agentSessionId && event.eventType === "agent_session.leader_message"
    );
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.payloadJson)).not.toHaveProperty("content");
  });

  it("delivers and records a Leader message for a running Expert session", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-runtime-message",
      workspaceId: "ws-default",
      name: "Runtime Message",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const sendMessage = vi.fn(() => true);
    const eventBus = new EventBus();
    const events: any[] = [];
    eventBus.subscribe(flow.id, "test", (message) => events.push(message));
    const dispatcher = createAgentDispatcher({
      store,
      eventBus,
      expertRuntime: { runTask: async () => undefined, sendMessage },
    });
    const dispatched = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Initial prompt",
      resumeAgentSessionId: "",
    });

    store.activateFlowExpertTask(task.id, dispatched.agent_session_id);
    const result = await dispatcher.sendMessage({
      flowId: flow.id,
      agentSessionId: dispatched.agent_session_id,
      content: "Use the existing API contract",
      summary: "补充约束",
    });

    expect(result).toEqual({ accepted: true, message_id: expect.any(String) });
    expect(sendMessage).toHaveBeenCalledWith({
      flowId: flow.id,
      flowExpertId: dispatched.flow_expert_id,
      agentSessionId: dispatched.agent_session_id,
      content: "Use the existing API contract",
    });
    const audit = store.listEventLog(flow.id).find((event) =>
      event.agentSessionId === dispatched.agent_session_id
      && event.eventType === "agent_session.leader_message"
      && JSON.parse(event.payloadJson).summary === "补充约束"
    );
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit!.payloadJson)).not.toHaveProperty("content");
    expect(events.some((event) => event.type === "session:history")).toBe(false);
  });

  it("interrupts a running Task through the Expert runtime", async () => {
    const store = tempStore();
    const flow = store.createFlow({ id: "flow-cancel-dispatch", name: "Cancel", description: "", projectId: null });
    const userTurn = beginUserTurn(store, { flowId: flow.id, createdBy: "user" })!;
    const task = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "Build", description: "Build", expertId: "exp-coder", dependsOnTaskIds: [] })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      status: "streaming",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "in_progress");
    const cancelTask = vi.fn(async (input: { taskId: string; agentSessionId: string }) => {
      store.cancelTask(input.taskId);
      store.updateAgentSessionStatus(input.agentSessionId, "interrupted");
      return true;
    });
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: { runTask: async () => undefined, cancelTask },
    });

    const result = await dispatcher.cancelAgent({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(cancelTask).toHaveBeenCalledWith({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      task: expect.objectContaining({ id: task.id, status: "cancelled" }),
      agentSession: expect.objectContaining({ id: session.id, status: "interrupted" }),
    }));
  });

  it("rejects blocked task dispatch and leaves task unchanged", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-blocked",
      workspaceId: "ws-default",
      name: "Blocked",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const first = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "First",
      description: "First",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const second = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Second",
      description: "Second",
      expertId: "exp-verify",
      dependsOnTaskIds: [first.id],
    })!;
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: second.id,
      expertId: "exp-verify",
      prompt: "Verify",
      resumeAgentSessionId: "",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "task is blocked by incomplete dependencies",
    });
    expect(store.getTask(second.id)).toEqual(expect.objectContaining({
      status: "pending",
      agentSessionId: null,
    }));
    expect(store.listAgentSessions(flow.id)).toHaveLength(0);
  });

  it("allows task-bound resume only after the previous session has ended", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-resume",
      workspaceId: "ws-default",
      name: "Resume",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: null,
      dependsOnTaskIds: [],
    })!;
    const oldSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      sessionId: "sdk-old",
      status: "completed",
    });
    store.startTask(task.id, oldSession.id);
    store.completeTask(task.id);
    const runTask = vi.fn(async () => undefined);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(runTask),
    });

    const result = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Resume with full context",
      resumeAgentSessionId: oldSession.id,
    });

    expect(result.status).toBe("queued");
    expect(store.getAgentSession(result.agent_session_id)).toEqual(expect.objectContaining({
      resumeFromAgentSessionId: oldSession.id,
      taskId: task.id,
      expertId: "exp-coder",
    }));
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: "sdk-old" }));
  });

  it("rejects resume for a running session", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-running",
      workspaceId: "ws-default",
      name: "Running",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const oldSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      sessionId: "sdk-running",
      status: "streaming",
    });
    store.startTask(task.id, oldSession.id);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Resume with full context",
      resumeAgentSessionId: oldSession.id,
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "running sessions must use send_message",
    });
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      agentSessionId: oldSession.id,
    }));
  });

  it("rejects resume with mismatched session and leaves task unchanged", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-resume-mismatch",
      workspaceId: "ws-default",
      name: "Resume Mismatch",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const otherSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      sessionId: "sdk-other",
      status: "completed",
    });
    store.startTask(task.id, otherSession.id);
    store.completeTask(task.id);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(),
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Resume with full context",
      resumeAgentSessionId: "ags-nonexistent",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "invalid resume_agent_session_id",
    });
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "completed",
      agentSessionId: otherSession.id,
    }));
  });

  it("does not create duplicate agent sessions for concurrent dispatch", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-concurrent",
      workspaceId: "ws-default",
      name: "Concurrent",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const runTask = vi.fn(async () => undefined);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(runTask),
    });

    const [first, second] = await Promise.all([
      dispatcher.dispatchAgent({
        flowId: flow.id,
        taskId: task.id,
        expertId: "exp-coder",
        prompt: "First",
        resumeAgentSessionId: "",
      }),
      dispatcher.dispatchAgent({
        flowId: flow.id,
        taskId: task.id,
        expertId: "exp-coder",
        prompt: "Second",
        resumeAgentSessionId: "",
      }),
    ]);

    const successes = [first, second].filter((r) => r.status === "queued");
    const failures = [first, second].filter((r) => r.status === "failed");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(store.listAgentSessions(flow.id)).toHaveLength(1);
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});

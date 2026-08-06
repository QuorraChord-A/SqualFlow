import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginWorkRun, createWorkingWorkRun } from "./helpers/workRunTestHelpers.js";
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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
      status: "in_progress",
      expertId: "exp-coder",
      flowExpertId: result.flow_expert_id,
      agentSessionId,
    }));
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      workRunId: workRun.id,
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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

  it("starts runnable WorkRun Task sessions", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-task",
      workspaceId: "ws-default",
      name: "Task",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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
      status: "in_progress",
      flowExpertId: result.flow_expert_id,
      agentSessionId,
    }));
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      workRunId: workRun.id,
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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
      workRunId: workRun.id,
      expertId: "exp-coder",
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

  it("starts a taskless conversation for an idle Expert and resumes its provider session", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-idle-expert-message",
      workspaceId: "ws-default",
      name: "Idle Expert Message",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const flowExpert = store.getOrCreateFlowExpert({
      flowId: flow.id,
      expertId: "exp-coder",
    });
    const previousSession = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
      taskId: null,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      sessionId: "sdk-research",
      status: "completed",
    });
    store.updateFlowExpertSession(flowExpert.id, "sdk-research");
    store.updateFlowExpertStatus(flowExpert.id, "idle");
    const runConversation = vi.fn(async () => undefined);
    const eventBus = new EventBus();
    const events: any[] = [];
    eventBus.subscribe(flow.id, "test", (message) => events.push(message));
    const dispatcher = createAgentDispatcher({
      store,
      eventBus,
      expertRuntime: {
        runTask: async () => undefined,
        runConversation,
      },
    });

    const result = await dispatcher.sendMessage({
      flowId: flow.id,
      workRunId: workRun.id,
      expertId: "exp-coder",
      content: "你有哪些 MCP 工具？",
      summary: "询问能力",
    });

    expect(result).toEqual({ accepted: true, message_id: expect.any(String) });
    expect(store.listTasks(flow.id)).toEqual([]);
    const created = store.listAgentSessions(flow.id)
      .find((session) => session.id !== previousSession.id);
    expect(created).toEqual(expect.objectContaining({
      taskId: null,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      resumeFromAgentSessionId: previousSession.id,
      status: "queued",
    }));
    expect(runConversation).toHaveBeenCalledWith({
      flowId: flow.id,
      workRunId: workRun.id,
      flowExpertId: flowExpert.id,
      agentSessionId: created!.id,
      expertId: "exp-coder",
      content: "你有哪些 MCP 工具？",
      resumeSessionId: "sdk-research",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session:event",
      data: expect.objectContaining({
        event: "created",
        task_id: null,
        expert_id: "exp-coder",
      }),
    }));
  });

  it("interrupts a running Task through the Expert runtime", async () => {
    const store = tempStore();
    const flow = store.createFlow({ id: "flow-cancel-dispatch", name: "Cancel", description: "", projectId: null });
    const workRun = beginWorkRun(store, { flowId: flow.id, createdBy: "user" })!;
    const task = store.createTask({ flowId: flow.id, workRunId: workRun.id, title: "Build", description: "Build", expertId: "exp-coder", dependsOnTaskIds: [] })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const session = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
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
      workRunId: workRun.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(cancelTask).toHaveBeenCalledWith({
      flowId: flow.id,
      workRunId: workRun.id,
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const first = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "First",
      description: "First",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const second = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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

  it("reuses the FlowExpert provider session for an explicit follow-up dispatch without completing the Task", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-resume",
      workspaceId: "ws-default",
      name: "Resume",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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

    const first = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Start the implementation",
      resumeAgentSessionId: "",
    });
    store.updateAgentSessionSession(first.agent_session_id, "sdk-flow-expert");
    store.updateAgentSessionStatus(first.agent_session_id, "completed");
    store.updateFlowExpertSession(first.flow_expert_id!, "sdk-flow-expert");

    // A reply ends an AgentSession, not its Task. Leader explicitly dispatches
    // the next turn and the provider conversation remains the same.
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      agentSessionId: first.agent_session_id,
    }));

    const result = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Please clarify the remaining risk.",
      resumeAgentSessionId: "",
    });

    expect(result.status).toBe("queued");
    expect(store.getAgentSession(result.agent_session_id)).toEqual(expect.objectContaining({
      resumeFromAgentSessionId: first.agent_session_id,
      taskId: task.id,
      expertId: "exp-coder",
    }));
    expect(runTask).toHaveBeenLastCalledWith(expect.objectContaining({
      resumeSessionId: "sdk-flow-expert",
      prompt: "Please clarify the remaining risk.",
    }));
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      agentSessionId: result.agent_session_id,
    }));
  });

  it("lets the Leader explicitly reassign a finished execution without resuming the source Expert session", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-reassign",
      workspaceId: "ws-default",
      name: "Reassign",
      description: "",
      projectId: null,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Review",
      description: "Review",
      expertId: null,
      dependsOnTaskIds: [],
    })!;
    const runTask = vi.fn(async () => undefined);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: runtime(runTask),
    });

    const first = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-coder",
      prompt: "Inspect the implementation.",
      resumeAgentSessionId: "",
    });

    expect(store.updateTask(task.id, { expertId: "exp-verify", status: "pending" })).toBeUndefined();

    store.updateAgentSessionSession(first.agent_session_id, "sdk-coder");
    store.updateAgentSessionStatus(first.agent_session_id, "completed");
    store.updateFlowExpertSession(first.flow_expert_id!, "sdk-coder");
    const reassigned = store.updateTask(task.id, { expertId: "exp-verify", status: "pending" });
    expect(reassigned).toEqual(expect.objectContaining({
      expertId: "exp-verify",
      flowExpertId: null,
      agentSessionId: null,
      status: "pending",
    }));

    const second = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-verify",
      prompt: "Independently verify the implementation.",
      resumeAgentSessionId: "",
    });

    expect(second.status).toBe("queued");
    expect(second.flow_expert_id).not.toBe(first.flow_expert_id);
    expect(store.getAgentSession(second.agent_session_id)).toEqual(expect.objectContaining({
      resumeFromAgentSessionId: "",
      expertId: "exp-verify",
    }));
    expect(runTask).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: "Independently verify the implementation.",
      resumeSessionId: undefined,
    }));
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const oldSession = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const otherSession = store.createAgentSession({
      flowId: flow.id,
      workRunId: workRun.id,
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
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
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

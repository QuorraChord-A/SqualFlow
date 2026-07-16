import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createLeaderMcpServer,
  createLeaderToolHandlers,
  type CurrentTurnInput,
  type StorePort,
} from "../src/mcp/leaderServer.js";

function jsonResult(result: string) {
  return JSON.parse(result) as Record<string, any>;
}

function fakeStore(overrides: Partial<StorePort> = {}): StorePort {
  return {
    getContext: (flowId) => ({ flow_id: flowId, status: "ready" }),
    listPendingUserActions: () => [],
    createPlan: () => ({
      spec_revision: {
        spec_revision_id: "spec-1",
        revision_number: 1,
        status: "draft",
        file_name: "spec.md",
        overview: "overview",
      },
      spec_approval: {
        spec_approval_id: "sca-1",
        status: "pending",
        actions: ["run"],
      },
    }),
    askUser: (input) => ({
      id: input.cardId,
      status: "pending",
      userTurnId: "utn-1",
    }),
    createTask: () => ({
      user_turn_id: "utn-1",
      task: {
        task_id: "task-1",
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "pending",
        expert_id: null,
        agent_session_id: null,
        metadata: {},
        blocked_by: [],
        blocks: [],
      },
    }),
    saveExecutionPlan: (input) => ({
      id: "art-plan",
      flow_id: input.flowId,
      user_turn_id: "utn-1",
      task_id: null,
      type: "execution_plan",
      title: input.title,
      content: input.plan,
      source_agent_session_id: input.sourceAgentSessionId ?? "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    updateTask: (input) => ({
      task_id: input.taskId,
      user_turn_id: "utn-1",
      subject: input.subject ?? "Build",
      description: input.description ?? "Build feature",
      active_form: input.activeForm ?? "",
      status: input.status ?? "pending",
      expert_id: null,
      agent_session_id: null,
      metadata: input.metadata ?? {},
      blocked_by: input.addBlockedBy ?? [],
      blocks: input.addBlocks ?? [],
    }),
    listTasks: () => [
      {
        task_id: "task-1",
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "pending",
        expert_id: null,
        agent_session_id: null,
        metadata: {},
        blocked_by: [],
        blocks: [],
      },
    ],
    getTask: ({ taskId }) => ({
      task_id: taskId,
      user_turn_id: "utn-1",
      subject: "Build",
      description: "Build feature",
      active_form: "",
      status: "pending",
      expert_id: null,
      agent_session_id: null,
      metadata: {},
      blocked_by: [],
      blocks: [],
    }),
    dispatchAgent: async (input) => ({
      ok: true,
      agent_session: {
        agent_session_id: "ags-task",
        status: "streaming",
        expert_id: input.expertId,
        task_id: input.taskId,
        user_turn_id: "utn-1",
      },
      task: {
        task_id: input.taskId,
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "in_progress",
        expert_id: input.expertId,
        agent_session_id: "ags-task",
      },
    }),
    resolvePlanFeedback: () => ({ approval: { id: "pap-1", status: "pending" } }),
    cancelAgent: async (input) => ({
      ok: true,
      agent_session: {
        agent_session_id: "ags-task",
        status: "interrupted",
        task_id: input.taskId,
        user_turn_id: "utn-1",
      },
      task: {
        task_id: input.taskId,
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "cancelled",
        expert_id: "exp-coder",
        agent_session_id: "ags-task",
      },
    }),
    sendMessage: () => ({
      ok: true,
      accepted: false,
      error: {
        code: "RUNTIME_DELIVERY_UNAVAILABLE",
        message: "runtime delivery channel unavailable",
      },
    }),
    ...overrides,
  };
}

const question = {
  question: "是否继续？",
  header: "确认",
  multiSelect: false,
  options: [
    { label: "继续", description: "继续执行" },
    { label: "调整", description: "继续讨论" },
  ],
};

describe("leader MCP handlers", () => {
  it("exposes only the V1 camelCase handler names", () => {
    const handlers = createLeaderToolHandlers(fakeStore());

    expect(Object.keys(handlers).sort()).toEqual([
      "askUser",
      "cancelAgent",
      "createPlan",
      "createTask",
      "dispatchAgent",
      "getContext",
      "getTask",
      "listTasks",
      "resolvePlanFeedback",
      "saveExecutionPlan",
      "sendMessage",
      "submitOrchestrationPlan",
      "updateTask",
    ]);
  });

  it("does not expose old leader handlers", () => {
    const handlers = createLeaderToolHandlers(fakeStore());

    expect(handlers).not.toHaveProperty("saveSpec");
    expect(handlers).not.toHaveProperty("saveArtifact");
    expect(handlers).not.toHaveProperty("getFlowSnapshot");
    expect(handlers).not.toHaveProperty("listExperts");
    expect(handlers).not.toHaveProperty("createExecution");
    expect(handlers).not.toHaveProperty("createTasks");
  });

  it("returns ok wrapped context as JSON", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      getContext: (flowId) => ({ flow_id: flowId, status: "ready" }),
    }));

    const result = jsonResult(await handlers.getContext({ flow_id: "flow-1" }));
    expect(result).toEqual({
      ok: true,
      flow_id: "flow-1",
      status: "ready",
    });
  });

  it("returns error for missing flow context", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      getContext: () => null,
    }));

    const result = jsonResult(await handlers.getContext({ flow_id: "flow-1" }));
    expect(result).toEqual({
      ok: false,
      error: { code: "FLOW_NOT_FOUND", message: "flow not found: flow-1" },
    });
  });

  it("creates a plan through the V1 contract", async () => {
    const saved: unknown[] = [];
    const events: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      createPlan(args) {
        saved.push(args);
        return {
          spec_revision: {
            spec_revision_id: "spec-2",
            revision_number: 2,
            status: "draft",
            file_name: "spec.md",
            overview: "overview",
          },
          spec_approval: {
            spec_approval_id: "sca-2",
            status: "pending",
            actions: ["run"],
          },
        };
      },
    }), {
      onSpecCardCreated: (event) => {
        events.push(event);
      },
    }, {
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        spec_requested: true,
        created_at: "2026-06-15T10:00:00.000Z",
      },
    });

    const result = jsonResult(await handlers.createPlan({
      flow_id: "flow-1",
      mode: "write",
      name: "Plan",
      overview: "overview",
      plan: "# Plan",
    }));

    expect(result).toEqual({
      ok: true,
      spec_revision: {
        spec_revision_id: "spec-2",
        revision_number: 2,
        status: "draft",
        file_name: "spec.md",
        overview: "overview",
      },
      spec_approval: {
        spec_approval_id: "sca-2",
        status: "pending",
        actions: ["run"],
      },
    });
    expect(saved).toEqual([{
      flowId: "flow-1",
      mode: "write",
      name: "Plan",
      overview: "overview",
      plan: "# Plan",
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        spec_requested: true,
        created_at: "2026-06-15T10:00:00.000Z",
      },
      sourceAgentSessionId: undefined,
    }]);
    expect(events).toEqual([{
      flowId: "flow-1",
      specApprovalId: "sca-2",
      specRevisionId: "spec-2",
      status: "pending",
      fileName: "spec.md",
      overview: "overview",
      userTurnId: null,
    }]);
  });

  it("rejects create_plan when the message does not request Spec", async () => {
    const handlers = createLeaderToolHandlers(fakeStore(), {}, {
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        spec_requested: false,
        created_at: "2026-06-15T10:00:00.000Z",
      },
    });

    const result = jsonResult(await handlers.createPlan({
      flow_id: "flow-1",
      mode: "write",
      name: "Plan",
      overview: "overview",
      plan: "# Plan",
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "SPEC_REQUEST_REQUIRED", message: "create_plan requires this message to request Spec." },
    });
  });

  it("rejects create_plan when a user action is pending", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      listPendingUserActions: () => [{ id: "dc-existing", type: "clarification", status: "pending" }],
    }), {}, {
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        spec_requested: true,
        created_at: "2026-06-15T10:00:00.000Z",
      },
    });

    const result = jsonResult(await handlers.createPlan({
      flow_id: "flow-1",
      mode: "write",
      name: "Plan",
      overview: "overview",
      plan: "# Plan",
    }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PENDING_USER_ACTION");
  });

  it("saves an execution plan through the V1 contract", async () => {
    const saved: unknown[] = [];
    const events: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      saveExecutionPlan(args) {
        saved.push(args);
        return {
          id: "art-plan",
          flow_id: args.flowId,
          user_turn_id: "utn-1",
          task_id: null,
          type: "execution_plan",
          title: args.title,
          content: args.plan,
          source_agent_session_id: args.sourceAgentSessionId ?? "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
      },
    }), {
      onArtifactCreated: (event) => {
        events.push(event);
      },
    }, {
      leaderAgentSessionId: "ags-leader",
    });

    const result = jsonResult(await handlers.saveExecutionPlan({
      flow_id: "flow-1",
      title: "Execution Plan",
      plan: "# Execution Plan",
    }));

    expect(result).toEqual({
      ok: true,
      artifact: {
        id: "art-plan",
        flow_id: "flow-1",
        user_turn_id: "utn-1",
        task_id: null,
        type: "execution_plan",
        title: "Execution Plan",
        content: "# Execution Plan",
        source_agent_session_id: "ags-leader",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(saved).toEqual([{
      flowId: "flow-1",
      title: "Execution Plan",
      plan: "# Execution Plan",
      sourceAgentSessionId: "ags-leader",
    }]);
    expect(events).toEqual([{
      flowId: "flow-1",
      artifact: result.artifact,
    }]);
  });

  it("rejects plan save when store returns null", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      saveExecutionPlan: () => null,
    }));

    const result = jsonResult(await handlers.saveExecutionPlan({
      flow_id: "flow-1",
      title: "Execution Plan",
      plan: "# Execution Plan",
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "ACTIVE_USER_TURN_REQUIRED", message: "编排计划需要一个活跃的 UserTurn。" },
    });
  });

  it("blocks task creation, plan saves, updates, and dispatch while a clarification card is pending", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      listPendingUserActions: () => [{ id: "dc-existing", type: "clarification", status: "pending" }],
    }));

    const task = jsonResult(await handlers.createTask({
      flow_id: "flow-1",
      subject: "Build",
      description: "Build feature",
    }));
    const plan = jsonResult(await handlers.saveExecutionPlan({
      flow_id: "flow-1",
      title: "Execution Plan",
      plan: "# Execution Plan",
    }));
    const update = jsonResult(await handlers.updateTask({
      flow_id: "flow-1",
      task_id: "task-1",
      status: "completed",
    }));
    const dispatch = jsonResult(await handlers.dispatchAgent({
      flow_id: "flow-1",
      task_id: "task-1",
      expert_id: "exp-frontend",
      prompt: "Build",
      resume_agent_session_id: "ags-old",
    }));

    for (const result of [task, plan, update, dispatch]) {
      expect(result).toEqual({
        ok: false,
        error: { code: "PENDING_USER_ACTION", message: "A user action is pending." },
      });
    }
  });

  it("rejects create_plan write mode without name", async () => {
    const handlers = createLeaderToolHandlers(fakeStore(), {}, {
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        spec_requested: true,
        created_at: "2026-06-15T10:00:00.000Z",
      },
    });

    const result = jsonResult(await handlers.createPlan({
      flow_id: "flow-1",
      mode: "write",
      overview: "overview",
      plan: "# Plan",
    }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_SPEC_REVISION");
  });

  it("creates a task through the V1 contract", async () => {
    const created: unknown[] = [];
    const events: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      createTask(args) {
        created.push(args);
        return {
          user_turn_id: "utn-1",
          task: {
            task_id: "task-1",
            user_turn_id: "utn-1",
            subject: args.subject,
            description: args.description,
            active_form: args.activeForm ?? "",
            status: "pending",
            expert_id: null,
            agent_session_id: null,
            metadata: {},
            blocked_by: [],
            blocks: [],
          },
        };
      },
    }), {
      onTaskCreated: (event) => {
        events.push(event);
      },
    });

    const result = jsonResult(await handlers.createTask({
      flow_id: "flow-1",
      subject: "Build",
      description: "Build feature",
      active_form: "Building feature",
    }));

    expect(result.ok).toBe(true);
    expect(result.task.task_id).toBe("task-1");
    expect(created).toEqual([{
      flowId: "flow-1",
      subject: "Build",
      description: "Build feature",
      activeForm: "Building feature",
      currentTurnInput: undefined,
    }]);
    expect(events).toEqual([{
      flowId: "flow-1",
      userTurnId: "utn-1",
      task: result.task,
    }]);
  });

  it("rejects task creation when store returns null", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      createTask: () => null,
    }));

    const result = jsonResult(await handlers.createTask({
      flow_id: "flow-1",
      subject: "Build",
      description: "Build feature",
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "ACTIVE_USER_TURN_REQUIRED", message: "Task could not be created for the current UserTurn." },
    });
  });

  it("updates tasks with snake_case input mapped to store fields", async () => {
    const updated: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      updateTask(args) {
        updated.push(args);
        return {
          task_id: args.taskId,
          user_turn_id: "utn-1",
          subject: args.subject ?? "Build",
          description: args.description ?? "Build feature",
          active_form: args.activeForm ?? "",
          status: args.status ?? "pending",
          expert_id: null,
          agent_session_id: null,
          metadata: args.metadata ?? {},
          blocked_by: args.addBlockedBy ?? [],
          blocks: args.addBlocks ?? [],
        };
      },
    }));

    const result = jsonResult(await handlers.updateTask({
      flow_id: "flow-1",
      task_id: "task-1",
      status: "completed",
      active_form: "done",
      owner: "exp-frontend",
      metadata: { priority: "P0" },
    }));

    expect(result).toEqual({
      ok: true,
      task: {
        task_id: "task-1",
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "done",
        status: "completed",
        expert_id: null,
        agent_session_id: null,
        metadata: { priority: "P0" },
        blocked_by: [],
        blocks: [],
      },
    });
    expect(updated).toEqual([{
      flowId: "flow-1",
      taskId: "task-1",
      status: "completed",
      activeForm: "done",
      owner: "exp-frontend",
      metadata: { priority: "P0" },
      addBlocks: undefined,
      addBlockedBy: undefined,
    }]);
  });

  it("updates task dependencies through the V1 contract", async () => {
    const updated: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      updateTask(args) {
        updated.push(args);
        return {
          task_id: args.taskId,
          user_turn_id: "utn-1",
          subject: "Build",
          description: "Build feature",
          active_form: "",
          status: args.status ?? "pending",
          expert_id: null,
          agent_session_id: null,
          metadata: {},
          blocked_by: args.addBlockedBy ?? [],
          blocks: args.addBlocks ?? [],
        };
      },
    }));

    const result = jsonResult(await handlers.updateTask({
      flow_id: "flow-1",
      task_id: "task-1",
      add_blocked_by: ["task-0"],
      add_blocks: ["task-2"],
    }));

    expect(result.ok).toBe(true);
    expect(result.task.blocked_by).toEqual(["task-0"]);
    expect(result.task.blocks).toEqual(["task-2"]);
    expect(updated).toEqual([{
      flowId: "flow-1",
      taskId: "task-1",
      addBlocks: ["task-2"],
      addBlockedBy: ["task-0"],
    }]);
  });

  it("rejects update for missing task", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      updateTask: () => null,
    }));

    const result = jsonResult(await handlers.updateTask({
      flow_id: "flow-1",
      task_id: "task-missing",
      status: "completed",
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_TASK", message: "task not found: task-missing" },
    });
  });

  it("lists and gets tasks", async () => {
    const handlers = createLeaderToolHandlers(fakeStore());

    expect(jsonResult(await handlers.listTasks({ flow_id: "flow-1" }))).toEqual({
      ok: true,
      tasks: [
        {
          task_id: "task-1",
          user_turn_id: "utn-1",
          subject: "Build",
          description: "Build feature",
          active_form: "",
          status: "pending",
          expert_id: null,
          agent_session_id: null,
          metadata: {},
          blocked_by: [],
          blocks: [],
        },
      ],
    });
    expect(jsonResult(await handlers.getTask({ flow_id: "flow-1", task_id: "task-1" }))).toEqual({
      ok: true,
      task: {
        task_id: "task-1",
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "pending",
        expert_id: null,
        agent_session_id: null,
        metadata: {},
        blocked_by: [],
        blocks: [],
      },
    });
  });

  it("creates a clarification decision card and invokes the hook", async () => {
    const created: unknown[] = [];
    const events: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      askUser(args) {
        created.push(args);
        return { id: args.cardId, status: "pending", userTurnId: "utn-1" };
      },
    }), {
      onDecisionCardCreated: (event) => {
        events.push(event);
      },
    });

    const createdResult = jsonResult(await handlers.askUser({
      flow_id: "flow-1",
      questions: [question],
    }));

    expect(createdResult.ok).toBe(true);
    expect(createdResult.card_id).toMatch(/^dc-/);
    expect(createdResult.question_count).toBe(1);
    expect(created).toEqual([expect.objectContaining({
      flowId: "flow-1",
      sessionId: "",
      cardId: createdResult.card_id,
      questions: [question],
    })]);
    expect(events).toEqual([{
      flowId: "flow-1",
      cardId: createdResult.card_id,
      cardType: "clarification",
      questions: [question],
      status: "pending",
      userTurnId: "utn-1",
    }]);
  });

  it("rejects ask_user when a user action is pending", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      listPendingUserActions: () => [{ id: "dc-existing", type: "clarification", status: "pending" }],
    }));

    const result = jsonResult(await handlers.askUser({
      flow_id: "flow-1",
      questions: [question],
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "PENDING_USER_ACTION", message: "A user action is pending." },
    });
  });

  it("rejects ask_user for unknown flow", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      getContext: () => null,
    }));

    const result = jsonResult(await handlers.askUser({
      flow_id: "flow-missing",
      questions: [question],
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "FLOW_NOT_FOUND", message: "flow not found: flow-missing" },
    });
  });

  it("dispatches a task-bound agent through the V1 contract", async () => {
    const calls: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      async dispatchAgent(args) {
        calls.push(args);
        return {
          ok: true,
          agent_session: {
            agent_session_id: "ags-task",
            status: "streaming",
            expert_id: args.expertId,
            task_id: args.taskId,
            user_turn_id: "utn-1",
          },
          task: {
            task_id: args.taskId,
            user_turn_id: "utn-1",
            subject: "Build",
            description: "Build feature",
            active_form: "",
            status: "in_progress",
            expert_id: args.expertId,
            agent_session_id: "ags-task",
          },
        };
      },
    }));

    const result = jsonResult(await handlers.dispatchAgent({
      flow_id: "flow-1",
      task_id: "task-1",
      expert_id: "exp-frontend",
      prompt: "Build",
      resume_agent_session_id: "ags-old",
    }));

    expect(result).toEqual({
      ok: true,
      agent_session: {
        agent_session_id: "ags-task",
        status: "streaming",
        expert_id: "exp-frontend",
        task_id: "task-1",
        user_turn_id: "utn-1",
      },
      task: {
        task_id: "task-1",
        user_turn_id: "utn-1",
        subject: "Build",
        description: "Build feature",
        active_form: "",
        status: "in_progress",
        expert_id: "exp-frontend",
        agent_session_id: "ags-task",
      },
    });
    expect(calls).toEqual([{
      flowId: "flow-1",
      taskId: "task-1",
      expertId: "exp-frontend",
      prompt: "Build",
      resumeAgentSessionId: "ags-old",
    }]);
  });

  it("propagates dispatch_agent failures", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      dispatchAgent: async () => ({
        ok: false,
        error: { code: "TASK_BLOCKED", message: "task is blocked" },
      }),
    }));

    const result = jsonResult(await handlers.dispatchAgent({
      flow_id: "flow-1",
      task_id: "task-1",
      expert_id: "exp-frontend",
      prompt: "Build",
    }));

    expect(result).toEqual({
      ok: false,
      error: { code: "TASK_BLOCKED", message: "task is blocked" },
    });
  });

  it("cancels a running task through the independent cancel_agent tool", async () => {
    const calls: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      cancelAgent: async (args) => {
        calls.push(args);
        return {
          ok: true,
          agent_session: { agent_session_id: "ags-task", status: "interrupted" },
          task: { task_id: args.taskId, status: "cancelled" },
        };
      },
    }), {}, {
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: "utn-1",
        created_at: "2026-07-11T00:00:00.000Z",
      },
    });

    const result = jsonResult(await handlers.cancelAgent({ flow_id: "flow-1", task_id: "task-1" }));

    expect(result).toEqual({
      ok: true,
      agent_session: { agent_session_id: "ags-task", status: "interrupted" },
      task: { task_id: "task-1", status: "cancelled" },
    });
    expect(calls).toEqual([{
      flowId: "flow-1",
      taskId: "task-1",
      currentTurnInput: expect.objectContaining({ user_turn_id: "utn-1" }),
    }]);
  });

  it("propagates explicit non-running task errors from cancel_agent", async () => {
    const handlers = createLeaderToolHandlers(fakeStore({
      cancelAgent: async () => ({
        ok: false,
        error: { code: "TASK_NOT_RUNNING", message: "task is not running" },
      }),
    }));

    const result = jsonResult(await handlers.cancelAgent({ flow_id: "flow-1", task_id: "task-1" }));

    expect(result).toEqual({
      ok: false,
      error: { code: "TASK_NOT_RUNNING", message: "task is not running" },
    });
  });

  it("rejects dispatch for missing task_id or expert_id", async () => {
    const handlers = createLeaderToolHandlers(fakeStore());

    await expect(handlers.dispatchAgent({
      flow_id: "flow-1",
      task_id: "",
      expert_id: "exp-frontend",
      prompt: "Build",
    })).rejects.toThrow();

    await expect(handlers.dispatchAgent({
      flow_id: "flow-1",
      task_id: "task-1",
      expert_id: "",
      prompt: "Build",
    })).rejects.toThrow();
  });

  it("sendMessage returns the store result wrapped in ok", async () => {
    const calls: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      sendMessage(args) {
        calls.push(args);
        return {
          ok: true,
          accepted: false,
          error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "offline" },
        };
      },
    }));

    const result = jsonResult(await handlers.sendMessage({
      flow_id: "flow-1",
      agent_session_id: "ags-1",
      content: "hello",
      summary: "greeting",
    }));

    expect(result).toEqual({
      ok: true,
      accepted: false,
      error: { code: "RUNTIME_DELIVERY_UNAVAILABLE", message: "offline" },
    });
    expect(calls).toEqual([{
      flowId: "flow-1",
      agentSessionId: "ags-1",
      content: "hello",
      summary: "greeting",
    }]);
  });

  it("blocks mutating tools during a decision-cancelled follow-up turn", async () => {
    const handlers = createLeaderToolHandlers(fakeStore(), {}, {
      currentTurnInput: {
        trigger_kind: "decision_cancelled",
        card_id: "dc-1",
        message_id: "msg-1",
        content: "用户取消了本次澄清卡片。",
        created_at: "2026-06-22T00:00:00.000Z",
      },
    });

    const results = await Promise.all([
      handlers.askUser({ flow_id: "flow-1", questions: [question] }),
      handlers.createPlan({ flow_id: "flow-1", mode: "write", name: "Plan", overview: "overview", plan: "# Plan" }),
      handlers.createTask({ flow_id: "flow-1", subject: "Build", description: "Build feature" }),
      handlers.saveExecutionPlan({ flow_id: "flow-1", title: "Execution Plan", plan: "# Execution Plan" }),
      handlers.updateTask({ flow_id: "flow-1", task_id: "task-1", status: "completed" }),
      handlers.dispatchAgent({ flow_id: "flow-1", task_id: "task-1", expert_id: "exp-frontend", prompt: "Build" }),
      handlers.sendMessage({ flow_id: "flow-1", agent_session_id: "ags-1", content: "hello" }),
    ]);

    for (const raw of results) {
      expect(jsonResult(raw)).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "CLARIFICATION_CANCELLED" }),
      }));
    }
  });

  it("rejects empty sendMessage content before calling the store", async () => {
    const calls: unknown[] = [];
    const handlers = createLeaderToolHandlers(fakeStore({
      sendMessage(args) {
        calls.push(args);
        return { ok: true, accepted: true };
      },
    }));

    await expect(handlers.sendMessage({
      flow_id: "flow-1",
      agent_session_id: "ags-1",
      content: "",
    })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("leader MCP server", () => {
  it("registers exact V1 tool names and serves callbacks through MCP", async () => {
    const handlers = createLeaderToolHandlers(fakeStore());
    const server = createLeaderMcpServer(handlers);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "ask_user",
        "cancel_agent",
        "create_plan",
        "create_task",
        "dispatch_agent",
        "get_context",
        "get_task",
        "list_tasks",
        "resolve_plan_feedback",
        "save_execution_plan",
        "send_message",
        "submit_orchestration_plan",
        "update_task",
      ]);

      const result = await client.callTool({
        name: "get_context",
        arguments: { flow_id: "flow-1" },
      });
      expect(result.content).toEqual([{
        type: "text",
        text: JSON.stringify({ ok: true, flow_id: "flow-1", status: "ready" }),
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

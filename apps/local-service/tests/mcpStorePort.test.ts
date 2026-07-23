import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginUserTurn } from "./helpers/userTurnTestHelpers.js";
import { createStorePort } from "../src/mcp/storePort.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-mcp-port-"));
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

function currentTurnInput(userTurnId: string) {
  return {
    trigger_kind: "user_message" as const,
    user_turn_id: userTurnId,
    message_id: "msg-current",
    content: "continue",
    created_at: "2026-06-15T10:00:00.000Z",
  };
}

describe("createStorePort", () => {
  it("updates a pending Flow name only from the internal naming turn", () => {
    const store = tempStore();
    const project = store.createProject({ name: "fixture", localPath: "/repo" });
    const flow = store.createFlow({
      id: "flow-name",
      name: "临时名称",
      description: "",
      nameGenerationStatus: "pending",
      projectId: project.id,
    });
    const port = createStorePort(store);

    const result = port.updateFlowName({
      flowId: flow.id,
      name: "后台登录系统名称过长",
      currentTurnInput: {
        trigger_kind: "flow_name_generation",
        user_turn_id: "turn-name",
        created_at: new Date().toISOString(),
      },
    });

    expect(result).toEqual({
      ok: true,
      flow: { flow_id: flow.id, name: "后台登录系统名称过长".slice(0, 10), name_generation_status: "generated" },
    });
    expect(store.getFlow(flow.id)?.nameGenerationStatus).toBe("generated");
  });

  it("exposes context for a Flow", () => {
    const store = tempStore();
    const project = store.createProject({
      workspaceId: "ws-default",
      name: "fixture",
      localPath: "/repo",
    });
    const flow = store.createFlow({
      id: "flow-target",
      workspaceId: "ws-default",
      name: "Target",
      description: "",
      projectId: project.id,
    });
    const port = createStorePort(store);

    expect(port.getContext(flow.id)).toEqual(expect.objectContaining({
      flow_id: flow.id,
      status: "ready",
    }));
    expect(port.getContext(flow.id)).toEqual(expect.objectContaining({ legacy_spec_flow: false }));
  });

  it("returns get_context timestamps in the system timezone instead of UTC", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-local-time",
      workspaceId: "ws-default",
      name: "Local time",
      description: "",
      projectId: null,
    });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-local-time" })!;
    store.appendEventLog({
      flowId: flow.id,
      userTurnId: turn.id,
      eventType: "test.timestamp",
      payload: { observed_at: "2026-07-23T03:28:10.473Z" },
    });

    const context = createStorePort(store).getContext(flow.id)!;
    const turns = context.user_turns as Array<Record<string, unknown>>;
    const events = context.recent_events as Array<Record<string, unknown>>;
    const payload = events[0]!.payload as Record<string, unknown>;

    for (const timestamp of [
      context.created_at,
      turns[0]!.started_at,
      events[0]!.created_at,
      payload.observed_at,
    ]) {
      expect(timestamp).toEqual(expect.stringMatching(/[+-]\d{2}:\d{2}$/));
      expect(String(timestamp)).not.toMatch(/Z$/);
    }
    expect(new Date(String(context.created_at)).toISOString()).toBe(flow.createdAt);
    expect(new Date(String(turns[0]!.started_at)).toISOString()).toBe(turn.startedAt);
    expect(new Date(String(payload.observed_at)).toISOString()).toBe("2026-07-23T03:28:10.473Z");
  });

  it("creates and lists current-UserTurn tasks through the V1 API", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-tasks",
      workspaceId: "ws-default",
      name: "Tasks",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "leader",
    })!;
    const port = createStorePort(store);

    const created = port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(created).toEqual(expect.objectContaining({
      user_turn_id: userTurn.id,
      task: expect.objectContaining({
        task_id: expect.stringMatching(/^task-/),
        subject: "Build",
        status: "pending",
      }),
    }));
    expect(port.listTasks({ flowId: flow.id, currentTurnInput: currentTurnInput(userTurn.id) })[0]).toEqual(expect.objectContaining({
      subject: "Build",
      status: "pending",
    }));
  });

  it("allows create_task on a new UserTurn without orchestration plan (single-expert path)", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Direct", localPath: "/repo/direct" });
    const flow = store.createFlow({
      id: "flow-direct",
      workspaceId: "ws-default",
      name: "Direct",
      description: "",
      projectId: project.id,
    });
    const port = createStorePort(store);
    const createdAt = "2026-06-15T10:00:00.000Z";
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1", startedAt: createdAt })!;

    const created = port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: userTurn.id,
        message_id: "msg-1",
        content: "build it",
        created_at: createdAt,
      },
    });

    expect(created).toEqual(expect.objectContaining({
      user_turn_id: userTurn.id,
      task: expect.objectContaining({ subject: "Build", status: "pending" }),
    }));
    expect(store.listTasks(flow.id)).toHaveLength(1);
  });

  it("rejects direct UserTurn work outside execute mode or valid triggers", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-direct-reject",
      workspaceId: "ws-default",
      name: "Direct Reject",
      description: "",
      projectId: null,
    });
    const port = createStorePort(store);
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: userTurn.id,
        message_id: "msg-1",
        content: "build it",
        created_at: new Date().toISOString(),
      },
    })).toMatchObject({ error: { code: "TASK_CREATE_FAILED" } });

    store.createDecisionCard({
      flowId: flow.id,
      cardId: "dc-1",
      sessionId: "ags-leader",
      cardType: "clarification",
      userTurnId: userTurn.id,
      questions: [],
    });

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: userTurn.id,
        message_id: "msg-2",
        content: "build it",
        created_at: new Date().toISOString(),
      },
    })).toMatchObject({ error: { code: "PENDING_USER_ACTION" } });

    store.resolveDecisionCard({
      cardId: "dc-1",
      flowId: flow.id,
      answers: {},
      actionId: "action-1",
      messageId: "msg-resolve",
      leaderInputContent: "resolved",
    });

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: {
        trigger_kind: "expert_result",
        user_turn_id: userTurn.id,
        message_id: "msg-3",
        content: "build it",
        created_at: new Date().toISOString(),
      },
    })).toMatchObject({ error: { code: "INVALID_TRIGGER" } });

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
    })).toMatchObject({ error: { code: "ACTIVE_USER_TURN_REQUIRED" } });
  });

  it("returns a structured error when creating a task without an active UserTurn", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-no-exec",
      workspaceId: "ws-default",
      name: "No Exec",
      description: "",
      projectId: null,
    });
    const port = createStorePort(store);

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
    })).toMatchObject({ error: { code: "ACTIVE_USER_TURN_REQUIRED" } });
  });

  it("saves an execution plan artifact on the active UserTurn", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-plan-artifact",
      workspaceId: "ws-default",
      name: "Plan Artifact",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "leader",
      source: "spec",
    })!;
    const port = createStorePort(store);

    const artifact = port.saveExecutionPlan({
      flowId: flow.id,
      title: "Execution Plan",
      plan: "# Execution Plan",
      sourceAgentSessionId: "ags-leader",
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(artifact).toEqual(expect.objectContaining({
      flow_id: flow.id,
      user_turn_id: userTurn.id,
      task_id: null,
      type: "execution_plan",
      title: "Execution Plan",
      content: "# Execution Plan",
      source_agent_session_id: "ags-leader",
    }));
    expect(store.listArtifacts(flow.id)).toEqual([
      expect.objectContaining({
        id: artifact?.id,
        userTurnId: userTurn.id,
        taskId: null,
        type: "execution_plan",
        title: "Execution Plan",
        content: "# Execution Plan",
        sourceAgentSessionId: "ags-leader",
      }),
    ]);
  });

  it("returns null when saving an execution plan without an active UserTurn", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-no-plan-exec",
      workspaceId: "ws-default",
      name: "No Plan Execution",
      description: "",
      projectId: null,
    });
    const port = createStorePort(store);

    expect(port.saveExecutionPlan({
      flowId: flow.id,
      title: "Execution Plan",
      plan: "# Execution Plan",
    })).toBeNull();
  });

  it("rejects a submitted plan when Verify and CodeReview are disconnected", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Plan Validation", localPath: "/repo/plan-validation" });
    const flow = store.createFlow({
      id: "flow-plan-validation",
      workspaceId: "ws-default",
      name: "Plan Validation",
      description: "",
      projectId: project.id,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "leader",
    })!;
    const port = createStorePort(store);

    const result = port.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "登录失败次数限制",
      objective: "实现并验证登录失败次数限制",
      work_kind: "change",
      risk_level: "medium",
      nodes: [
        { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现限制", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "verify", expert_id: "exp-verify", title: "验证", description: "验证限制", depends_on: [], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "review", expert_id: "exp-codereview", title: "审查", description: "审查限制", depends_on: [], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(result).toEqual(expect.objectContaining({
      error: expect.objectContaining({
        code: "PLAN_LINT_REJECTED",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "IMPLEMENTATION_NOT_VERIFIED" }),
          expect.objectContaining({ code: "VERIFY_NOT_REVIEWED" }),
        ]),
      }),
    }));
    expect(store.listOrchestrationPlans(flow.id)).toEqual([]);
  });

  it("uses only plan_approval to decide whether a valid orchestration plan waits", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Plan approval", localPath: "/repo/plan-approval" });
    const submit = (planApproval: "on" | "off") => {
      const flow = store.createFlow({
        name: `Plan ${planApproval}`,
        description: "",
        projectId: project.id,
        planApproval,
      });
      const turn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "leader" })!;
      return createStorePort(store).submitOrchestrationPlan({
        flow_id: flow.id,
        title: "实现页面",
        objective: "实现页面",
        work_kind: "change",
        risk_level: "low",
        nodes: [
          {
            node_id: "code",
            expert_id: "exp-coder",
            title: "实现",
            description: "实现页面",
            depends_on: [],
            acceptance_criteria: ["完成"],
            risk_tags: [],
            side_effects: [],
            resource_keys: [],
          },
          {
            node_id: "verify",
            expert_id: "exp-verify",
            title: "验证",
            description: "验证页面",
            depends_on: ["code"],
            acceptance_criteria: ["通过"],
            risk_tags: [],
            side_effects: [],
            resource_keys: [],
          },
        ],
        currentTurnInput: currentTurnInput(turn.id),
      });
    };

    expect(submit("on")).toEqual(expect.objectContaining({
      revision: expect.objectContaining({ status: "pending_approval" }),
      approval: expect.objectContaining({ status: "pending" }),
      auto_approved: false,
    }));
    expect(submit("off")).toEqual(expect.objectContaining({
      revision: expect.objectContaining({ status: "approved" }),
      approval: expect.objectContaining({ status: "auto_approved" }),
      auto_approved: true,
    }));
  });

  it("rejects a single-role plan without side effects and allows same-turn single-expert fallback", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Single role", localPath: "/repo/single-role" });
    const flow = store.createFlow({ id: "flow-single-role", name: "Single role", description: "", projectId: project.id });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const port = createStorePort(store);
    const input = currentTurnInput(turn.id);

    const rejected = port.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "单角色",
      objective: "单角色计划",
      work_kind: "change",
      risk_level: "low",
      nodes: [
        { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
      currentTurnInput: input,
    });

    expect(rejected).toMatchObject({
      error: {
        code: "PLAN_LINT_REJECTED",
        issues: expect.arrayContaining([expect.objectContaining({ code: "ORCHESTRATION_REQUIRES_MULTIPLE_EXPERTS" })]),
      },
    });
    expect(store.listOrchestrationPlans(flow.id)).toEqual([]);
    expect(store.getUserTurn(turn.id)?.workSource).toBeFalsy();

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: input,
    })).toEqual(expect.objectContaining({
      user_turn_id: turn.id,
      task: expect.objectContaining({ subject: "Build", status: "pending" }),
    }));
  });

  it("rejects same-role nodes referenced through different aliases as a single-role plan", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Alias", localPath: "/repo/alias" });
    const flow = store.createFlow({ id: "flow-alias", name: "Alias", description: "", projectId: project.id });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;

    const rejected = createStorePort(store).submitOrchestrationPlan({
      flow_id: flow.id,
      title: "别名",
      objective: "同角色两种写法",
      work_kind: "change",
      risk_level: "low",
      nodes: [
        { node_id: "a", expert_id: "全栈开发专家", title: "步骤一", description: "步骤一", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "b", expert_id: "exp-coder", title: "步骤二", description: "步骤二", depends_on: ["a"], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
      currentTurnInput: currentTurnInput(turn.id),
    });

    expect(rejected).toMatchObject({
      error: {
        code: "PLAN_LINT_REJECTED",
        issues: expect.arrayContaining([expect.objectContaining({ code: "ORCHESTRATION_REQUIRES_MULTIPLE_EXPERTS" })]),
      },
    });
  });

  it("rejects plan nodes whose runtime role is disabled and allows same-turn fallback", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Disabled", localPath: "/repo/disabled" });
    const flow = store.createFlow({ id: "flow-disabled", name: "Disabled", description: "", projectId: project.id, planApproval: "off" });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const input = currentTurnInput(turn.id);
    const nodes = [
      { node_id: "research", expert_id: "exp-research", title: "调研", description: "调研", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
      { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现", depends_on: ["research"], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
    ];

    const disabledPort = createStorePort(store, undefined, {
      getEnabledExpertIds: () => new Set(["exp-coder", "exp-verify", "exp-codereview"]),
    });
    const rejected = disabledPort.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "禁用角色",
      objective: "含禁用角色",
      work_kind: "change",
      risk_level: "low",
      nodes,
      currentTurnInput: input,
    });

    expect(rejected).toMatchObject({
      error: {
        code: "PLAN_LINT_REJECTED",
        issues: expect.arrayContaining([expect.objectContaining({ code: "EXPERT_RUNTIME_DISABLED", node_id: "research" })]),
      },
    });
    expect(store.listOrchestrationPlans(flow.id)).toEqual([]);
    expect(store.getUserTurn(turn.id)?.workSource).toBeFalsy();

    const enabledPort = createStorePort(store, undefined, {
      getEnabledExpertIds: () => new Set(["exp-coder", "exp-research", "exp-verify", "exp-codereview"]),
    });
    expect(enabledPort.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "启用后",
      objective: "启用后可提交",
      work_kind: "change",
      risk_level: "low",
      nodes,
      currentTurnInput: input,
    })).toEqual(expect.objectContaining({
      revision: expect.objectContaining({ status: "approved" }),
    }));
  });

  it("rejects unresolved expert names without side effects and allows same-turn fallback", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Unknown", localPath: "/repo/unknown" });
    const flow = store.createFlow({ id: "flow-unknown", name: "Unknown", description: "", projectId: project.id });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const input = currentTurnInput(turn.id);
    const port = createStorePort(store);

    expect(port.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "未知专家",
      objective: "未知专家",
      work_kind: "change",
      risk_level: "low",
      nodes: [
        { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "ghost", expert_id: "不存在的专家", title: "幽灵", description: "幽灵", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
      currentTurnInput: input,
    })).toMatchObject({
      error: {
        code: "PLAN_LINT_REJECTED",
        issues: expect.arrayContaining([expect.objectContaining({ code: "EXPERT_UNAVAILABLE" })]),
      },
    });
    expect(store.getUserTurn(turn.id)?.workSource).toBeFalsy();

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: input,
    })).toEqual(expect.objectContaining({ user_turn_id: turn.id }));
  });

  it("blocks create_task with a dedicated error once an orchestration plan exists for the turn", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Plan active", localPath: "/repo/plan-active" });
    const flow = store.createFlow({ id: "flow-plan-active", name: "Plan active", description: "", projectId: project.id, planApproval: "off" });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const input = currentTurnInput(turn.id);
    const port = createStorePort(store);

    const submitted = port.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "实现并验证",
      objective: "实现并验证",
      work_kind: "change",
      risk_level: "low",
      nodes: [
        { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "verify", expert_id: "exp-verify", title: "验证", description: "验证", depends_on: ["code"], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
      currentTurnInput: input,
    });
    expect(submitted).toEqual(expect.objectContaining({ revision: expect.anything() }));

    expect(port.createTask({
      flowId: flow.id,
      subject: "抢活",
      description: "不应创建",
      currentTurnInput: input,
    })).toMatchObject({ error: { code: "ORCHESTRATION_PLAN_ACTIVE" } });
  });

  it("requires a saved execution plan before creating tasks for spec UserTurns", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-spec-task-order",
      workspaceId: "ws-default",
      name: "Spec Task Order",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
      source: "spec",
    })!;
    const port = createStorePort(store);

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: currentTurnInput(userTurn.id),
    })).toMatchObject({ error: { code: "EXECUTION_PLAN_REQUIRED" } });

    port.saveExecutionPlan({
      flowId: flow.id,
      title: "Execution Plan",
      plan: "# Execution Plan",
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(port.createTask({
      flowId: flow.id,
      subject: "Build",
      description: "Build feature",
      currentTurnInput: currentTurnInput(userTurn.id),
    })).toEqual(expect.objectContaining({
      user_turn_id: userTurn.id,
      task: expect.objectContaining({
        subject: "Build",
        status: "pending",
      }),
    }));
  });

  it("updates task metadata, owner and dependencies through the V1 API", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-update",
      workspaceId: "ws-default",
      name: "Update",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "leader",
    })!;
    const taskA = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "A",
      description: "A",
      dependsOnTaskIds: [],
    })!;
    const taskB = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "B",
      description: "B",
      dependsOnTaskIds: [],
    })!;
    const port = createStorePort(store);

    const updated = port.updateTask({
      flowId: flow.id,
      taskId: taskA.id,
      owner: "exp-frontend",
      metadata: { priority: "P0" },
      addBlockedBy: [taskB.id],
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(updated).toEqual(expect.objectContaining({
      task_id: taskA.id,
      status: "pending",
      metadata: { priority: "P0", owner: "exp-frontend" },
      blocked_by: [taskB.id],
    }));
    expect(store.listTaskDependencies(taskA.id)).toEqual([taskB.id]);
  });

  it("returns flat UserTurn task snapshot without legacy run fields", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-snapshot",
      workspaceId: "ws-default",
      name: "Snapshot",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      inputSnapshotJson: JSON.stringify({ prompt: "build" }),
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build feature",
      dependsOnTaskIds: [],
    })!;
    store.appendEventLog({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      eventType: "task.created",
      payload: { task_id: task.id },
    });

    const snapshot = createStorePort(store).getContext(flow.id);

    expect(snapshot).toMatchObject({
      status: "active",
      active_user_turn_id: userTurn.id,
      tasks: [expect.objectContaining({ id: task.id, title: "Build", user_turn_id: userTurn.id })],
    });
    expect(snapshot).not.toHaveProperty("current_run");
    expect(JSON.stringify(snapshot)).not.toContain("current_phase");
  });

  it("creates a spec plan and returns V1 DTOs", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-plan",
      workspaceId: "ws-default",
      name: "Plan",
      description: "",
      projectId: null,
    });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-plan" })!;
    const port = createStorePort(store);

    const plan = port.createPlan({
      flowId: flow.id,
      mode: "write",
      name: "Plan",
      overview: "overview",
      plan: "# Plan",
      currentTurnInput: { ...currentTurnInput(userTurn.id), spec_requested: true },
    });

    expect(plan).toEqual({
      spec_revision: expect.objectContaining({
        spec_revision_id: expect.stringMatching(/^spec-/),
        revision_number: 1,
        status: "draft",
        file_name: expect.stringMatching(/\.md$/),
        overview: "overview",
      }),
      spec_approval: expect.objectContaining({
        spec_approval_id: expect.stringMatching(/^sca-/),
        status: "pending",
        actions: ["run"],
      }),
    });
  });

  it("blocks execution tools while the current message still requires Spec approval", () => {
    const store = tempStore();
    const project = store.createProject({ name: "Spec guard", localPath: "/repo/spec-guard" });
    const flow = store.createFlow({ id: "flow-spec-guard", name: "Spec guard", description: "", projectId: project.id });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-spec-guard", specRequested: true })!;
    store.startUserTurnWork({
      flowId: flow.id,
      userTurnId: turn.id,
      workSource: "direct_message",
      targetProjectId: project.id,
      inputSnapshotJson: turn.inputSnapshotJson,
    });
    const input = { ...currentTurnInput(turn.id), spec_requested: true };
    const port = createStorePort(store);

    expect(port.saveExecutionPlan({ flowId: flow.id, title: "Bypass", plan: "Do it", currentTurnInput: input })).toBeNull();
    expect(port.createTask({ flowId: flow.id, subject: "Bypass", description: "Do it", currentTurnInput: input })).toMatchObject({ error: { code: "SPEC_REQUEST_ACTIVE" } });
    expect(port.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "Bypass",
      objective: "Do it",
      work_kind: "change",
      risk_level: "low",
      nodes: [{
        node_id: "code",
        expert_id: "exp-coder",
        title: "Code",
        description: "Code",
        depends_on: [],
        acceptance_criteria: ["done"],
        risk_tags: [],
        side_effects: [],
        resource_keys: [],
      }],
      currentTurnInput: input,
    })).toBeNull();
  });

  it("creates a clarification card and lists pending user actions", () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-card",
      workspaceId: "ws-default",
      name: "Card",
      description: "",
      projectId: null,
    });
    const port = createStorePort(store);
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-card" })!;

    const card = port.askUser({
      flowId: flow.id,
      cardId: "dc-1",
      sessionId: "ags-leader",
      questions: [{
        question: "是否继续？",
        options: [
          { label: "继续", description: "继续执行" },
          { label: "调整", description: "继续讨论" },
        ],
      }],
      currentTurnInput: currentTurnInput(userTurn.id),
    });

    expect(card).toEqual(expect.objectContaining({
      id: "dc-1",
      status: "pending",
      userTurnId: userTurn.id,
    }));
    expect(port.listPendingUserActions({ flowId: flow.id })).toEqual([
      { id: "dc-1", type: "clarification", status: "pending" },
    ]);
  });

  it("does not persist runtime-only messages for inactive agents", async () => {
    const store = tempStore();
    const flow = store.createFlow({
      id: "flow-message",
      workspaceId: "ws-default",
      name: "Message",
      description: "",
      projectId: null,
    });
    const port = createStorePort(store);

    await expect(port.sendMessage({
      flowId: flow.id,
      agentSessionId: "ags-offline",
      content: "ping",
    })).resolves.toEqual({
      ok: true,
      accepted: false,
      error: {
        code: "RUNTIME_DELIVERY_UNAVAILABLE",
        message: "runtime delivery channel unavailable",
      },
    });
  });

  it("only cancels the current UserTurn's running Task", async () => {
    const store = tempStore();
    const flow = store.createFlow({ id: "flow-cancel-agent", name: "Cancel", description: "", projectId: null });
    const userTurn = beginUserTurn(store, { flowId: flow.id });
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      status: "streaming",
    });
    store.startTask(task.id, session.id);
    const port = createStorePort(store, {
      cancelAgent: async (input) => {
        const cancelledTask = store.cancelTask(input.taskId)!;
        const cancelledSession = store.updateAgentSessionStatus(input.agentSessionId, "interrupted")!;
        return { ok: true, task: cancelledTask, agentSession: cancelledSession };
      },
    } as any);

    const cancelled = await port.cancelAgent({
      flowId: flow.id,
      taskId: task.id,
      currentTurnInput: currentTurnInput(userTurn.id),
    });
    expect(cancelled).toEqual(expect.objectContaining({
      ok: true,
      task: expect.objectContaining({ task_id: task.id, status: "cancelled" }),
      agent_session: expect.objectContaining({ agent_session_id: session.id, status: "interrupted" }),
    }));

    const rejected = await port.cancelAgent({
      flowId: flow.id,
      taskId: task.id,
      currentTurnInput: currentTurnInput(userTurn.id),
    });
    expect(rejected).toEqual({
      ok: false,
      error: { code: "TASK_NOT_RUNNING", message: `task is not running: ${task.id}` },
    });
  });
});

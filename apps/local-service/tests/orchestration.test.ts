import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { diffPlanNodes, evaluateDeclarativeRules, lintOrchestrationPlan } from "../src/domain/orchestration.js";
import { createLeaderToolHandlers } from "../src/mcp/leaderServer.js";
import { createStorePort } from "../src/mcp/storePort.js";
import { createOrchestrationScheduler } from "../src/runtime/orchestrationScheduler.js";
import { EventBus } from "../src/ws/eventBus.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-orchestration-"));
  dirs.push(dir);
  const store = createStore(path.join(dir, "db.sqlite"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  const project = store.createProject({ id: "project-plan", name: "Plan", localPath: dir, description: "" });
  const flow = store.createFlow({ id: "flow-plan", name: "Plan", description: "", projectId: project.id });
  const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
  store.startWorkRunWork({ flowId: flow.id, workRunId: turn.id, workSource: "direct_message", targetProjectId: project.id, inputSnapshotJson: "{}" });
  return { store, flow, turn };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("structured orchestration", () => {
  it("rejects cycles and required quality roles", () => {
    const input = {
      flow_id: "flow",
      title: "Fix",
      objective: "Fix a bug",
      work_kind: "bugfix" as const,
      risk_level: "high" as const,
      nodes: [{
        node_id: "code", expert_id: "exp-coder", title: "实现", description: "修复问题",
        depends_on: ["code"], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [],
      }],
    };
    expect(lintOrchestrationPlan(input, new Set(["exp-coder"])).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SELF_DEPENDENCY", "DAG_CYCLE", "VERIFY_REQUIRED", "REVIEW_REQUIRED",
    ]));
  });

  it("requires at least two distinct expert roles for an orchestration plan", () => {
    const node = {
      node_id: "a", expert_id: "exp-coder", title: "步骤", description: "步骤",
      depends_on: [] as string[], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [],
    };
    const base = { flow_id: "flow", title: "多步", objective: "多步", work_kind: "change" as const, risk_level: "low" as const };

    const singleNode = lintOrchestrationPlan({ ...base, nodes: [node] }, new Set(["exp-coder"]));
    expect(singleNode.map((issue) => issue.code)).toContain("ORCHESTRATION_REQUIRES_MULTIPLE_EXPERTS");

    const sameRoleTwice = lintOrchestrationPlan(
      { ...base, nodes: [node, { ...node, node_id: "b", depends_on: ["a"] }] },
      new Set(["exp-coder"]),
    );
    expect(sameRoleTwice.map((issue) => issue.code)).toContain("ORCHESTRATION_REQUIRES_MULTIPLE_EXPERTS");

    const twoRoles = lintOrchestrationPlan(
      {
        ...base,
        nodes: [node, { ...node, node_id: "verify", expert_id: "exp-verify", depends_on: ["a"] }],
      },
      new Set(["exp-coder", "exp-verify"]),
    );
    expect(twoRoles.map((issue) => issue.code)).not.toContain("ORCHESTRATION_REQUIRES_MULTIPLE_EXPERTS");
  });

  it("requires review nodes to depend on the implementation chain even without verify", () => {
    const base = { flow_id: "flow", title: "实现加审查", objective: "实现加审查", work_kind: "change" as const, risk_level: "medium" as const };
    const code = {
      node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现",
      depends_on: [] as string[], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [],
    };
    const review = {
      node_id: "review", expert_id: "exp-codereview", title: "审查", description: "审查",
      depends_on: [] as string[], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [],
    };
    const available = new Set(["exp-coder", "exp-codereview"]);

    const parallelReview = lintOrchestrationPlan({ ...base, nodes: [code, review] }, available);
    expect(parallelReview.map((issue) => issue.code)).toContain("REVIEW_WITHOUT_IMPLEMENTATION_DEPENDENCY");

    const orderedReview = lintOrchestrationPlan(
      { ...base, nodes: [code, { ...review, depends_on: ["code"] }] },
      available,
    );
    expect(orderedReview.filter((issue) => issue.severity === "block")).toEqual([]);
  });

  it("rejects quality tasks that are not connected to the implementation chain", () => {
    const input = {
      flow_id: "flow",
      title: "登录失败次数限制",
      objective: "实现并验证登录失败次数限制",
      work_kind: "change" as const,
      risk_level: "medium" as const,
      nodes: [
        {
          node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现限制逻辑",
          depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [],
        },
        {
          node_id: "verify", expert_id: "exp-verify", title: "验证", description: "验证限制逻辑",
          depends_on: [], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [],
        },
        {
          node_id: "review", expert_id: "exp-codereview", title: "审查", description: "审查限制逻辑",
          depends_on: [], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [],
        },
      ],
    };

    expect(lintOrchestrationPlan(input, new Set(["exp-coder", "exp-verify", "exp-codereview"]))
      .map((issue) => issue.code))
      .toEqual(expect.arrayContaining([
        "IMPLEMENTATION_NOT_VERIFIED",
        "VERIFY_WITHOUT_IMPLEMENTATION_DEPENDENCY",
        "VERIFY_NOT_REVIEWED",
        "REVIEW_WITHOUT_VERIFY_DEPENDENCY",
      ]));
  });

  it("computes one revision diff for a batch of changes", () => {
    const base = { node_id: "code", expert_id: "exp-coder", title: "实现", description: "旧", depends_on: [], acceptance_criteria: ["旧"], risk_tags: [], side_effects: [], resource_keys: [] };
    const diff = diffPlanNodes([base], [{ ...base, description: "新", acceptance_criteria: ["新"] }, { ...base, node_id: "verify", expert_id: "exp-verify" }]);
    expect(diff.added).toEqual(["verify"]);
    expect(diff.modified).toEqual([{ node_id: "code", fields: ["description", "acceptance_criteria"] }]);
  });

  it("evaluates scoped declarative rules without executable scripts", () => {
    const input = {
      flow_id: "flow", title: "Fix", objective: "Fix", work_kind: "bugfix" as const, risk_level: "medium" as const,
      nodes: [{ node_id: "code", expert_id: "exp-coder", title: "实现", description: "修复", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] }],
    };
    const issues = evaluateDeclarativeRules(input, [{ id: "verify-rule", name: "Bug 必须验证", severity: "block", rule: { when: { work_kinds: ["bugfix"] }, require_expert_ids: ["exp-verify"] } }]);
    expect(issues).toEqual([{ code: "CUSTOM_RULE:verify-rule", severity: "block", message: "规则「Bug 必须验证」要求包含 Expert：exp-verify" }]);
  });

  it("persists approval, feedback, revision history and atomically materializes tasks", () => {
    const { store, flow, turn } = setup();
    const first = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "邀请计划", objective: "完成邀请", workKind: "change", riskLevel: "medium",
      status: "pending_approval", lint: [], diff: {},
      nodes: [
        { nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现邀请", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] },
        { nodeId: "verify", expertId: "exp-verify", title: "验证", description: "验证邀请", dependsOn: ["code"], acceptanceCriteria: ["通过"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    expect(store.getWorkRun(turn.id)?.status).toBe("waiting_user");
    const codeNode = store.listPlanNodes(first.revision.id).find((node) => node.stableKey === "code")!;
    expect(store.setPlanApprovalFeedbackPending({ approvalId: first.approval.id, sourceMessageId: "feedback-1", feedback: [{ planNodeId: codeNode.id, markerNumber: 1, comment: "收窄范围" }] })?.status).toBe("feedback_pending");
    expect(store.getWorkRun(turn.id)?.status).toBe("ready");
    expect(store.restorePlanApprovalAfterFeedback(first.approval.id, "无需修改")?.status).toBe("pending");
    expect(store.getWorkRun(turn.id)?.status).toBe("waiting_user");
    const approved = store.resolvePlanApproval({ approvalId: first.approval.id, clientActionId: "approve-1" })!;
    expect(approved.status).toBe("approved");
    const run = store.materializePlanRun(first.revision.id)!;
    expect(run.status).toBe("running");
    const mappings = store.listPlanNodeTasks(run.id);
    expect(mappings).toHaveLength(2);
    const tasks = mappings.map((mapping) => store.getTask(mapping.taskId)!);
    expect(tasks.map((task) => task.title)).toEqual(expect.arrayContaining(["实现", "验证"]));
    const verifyTask = tasks.find((task) => task.title === "验证")!;
    expect(store.listTaskDependencies(verifyTask.id)).toHaveLength(1);
    expect(store.materializePlanRun(first.revision.id)?.id).toBe(run.id);
  });

  it("pauses a running plan for feedback and resumes it through the Leader handler", async () => {
    const { store, flow, turn } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "运行中反馈", objective: "继续执行", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [{ nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] }],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    expect(run.status).toBe("running");
    const task = store.getTask(store.listPlanNodeTasks(run.id)[0]!.taskId)!;
    expect(store.startTask(task.id, "ags-feedback-running")).toEqual(expect.objectContaining({ status: "in_progress" }));

    store.recordPlanFeedback({
      flowId: flow.id,
      workRunId: turn.id,
      planRevisionId: created.revision.id,
      sourceMessageId: "feedback-running",
      feedback: [{ markerNumber: 1, comment: "不用修改计划" }],
    });
    expect(store.getPlanRun(run.id)?.status).toBe("paused_for_feedback");

    let resumedRun: Record<string, unknown> | undefined;
    const handlers = createLeaderToolHandlers(
      createStorePort(store),
      { onPlanRunChanged: ({ run: changedRun }) => { resumedRun = changedRun; } },
      { currentTurnInput: { trigger_kind: "user_message", work_run_id: turn.id, created_at: new Date().toISOString() } },
    );
    const resolution = JSON.parse(await handlers.resolvePlanFeedback({
      flow_id: flow.id,
      plan_approval_id: created.approval.id,
      resolution_note: "评论不影响当前计划",
    })) as Record<string, any>;
    expect(resolution).toEqual(expect.objectContaining({
      ok: true,
      approval: expect.objectContaining({ status: "auto_approved" }),
      run: expect.objectContaining({ id: run.id, status: "running" }),
    }));
    expect(resumedRun).toEqual(expect.objectContaining({ id: run.id, status: "running" }));
    expect(store.listPlanFeedback(created.revision.id)[0]?.status).toBe("resolved");
  });

  it("rejects feedback for a plan run that is no longer active", () => {
    const { store, flow, turn } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "历史计划", objective: "历史计划", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [{ nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: [] }],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    store.updatePlanRunStatus(run.id, "completed");

    expect(store.recordPlanFeedback({
      flowId: flow.id,
      workRunId: turn.id,
      planRevisionId: created.revision.id,
      sourceMessageId: "feedback-history",
      feedback: [{ markerNumber: 1, comment: "不应写入" }],
    })).toBeUndefined();
    expect(store.listPlanFeedback(created.revision.id)).toEqual([]);
  });

  it("publishes refreshed current and parent plan views after revision materialization", async () => {
    const { store, flow, turn } = setup();
    const first = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v1", objective: "v1", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [{ nodeId: "old", expertId: "exp-coder", title: "旧任务", description: "旧任务", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["old"] }],
    })!;
    const firstRun = store.materializePlanRun(first.revision.id)!;
    const oldTaskId = store.listPlanNodeTasks(firstRun.id)[0]!.taskId;
    const second = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v2", objective: "v2", workKind: "change", riskLevel: "low",
      basedOnRevisionId: first.revision.id, status: "approved", lint: [],
      diff: { added: ["new"], removed: ["old"], modified: [] },
      nodes: [{ nodeId: "new", expertId: "exp-coder", title: "新任务", description: "新任务", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["new"] }],
    })!;
    const eventBus = new EventBus();
    const events: Array<{ type: string; data?: any }> = [];
    eventBus.subscribe(flow.id, "plan-view-test", (event) => events.push(event));
    const scheduler = createOrchestrationScheduler({ store, eventBus });

    await scheduler.startRevision(second.revision.id);

    const planEvents = events.filter((event) => event.type === "plan:event");
    expect(planEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ revision: expect.objectContaining({ plan_revision_id: first.revision.id }), run: expect.objectContaining({ status: "superseded" }) }) }),
      expect.objectContaining({ data: expect.objectContaining({ revision: expect.objectContaining({ plan_revision_id: second.revision.id }), nodes: [expect.objectContaining({ task: expect.objectContaining({ task_id: expect.any(String) }) })] }) }),
    ]));
    expect(store.getTask(oldTaskId)?.status).toBe("cancelled");
  });

  it("migrates a revised run by reusing completed stable tasks and replacing pending tasks", () => {
    const { store, flow, turn } = setup();
    const first = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v1", objective: "旧计划", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [
        { nodeId: "done", expertId: "exp-coder", title: "已完成", description: "已完成", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] },
        { nodeId: "stable", expertId: "exp-verify", title: "稳定验证", description: "稳定验证", dependsOn: ["done"], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
        { nodeId: "pending", expertId: "exp-verify", title: "待取消", description: "待取消", dependsOn: [], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    const firstRun = store.materializePlanRun(first.revision.id)!;
    const firstMappings = store.listPlanNodeTasks(firstRun.id);
    const doneTask = store.getTask(firstMappings.find((mapping) => store.listPlanNodes(first.revision.id).find((node) => node.id === mapping.planNodeId)?.stableKey === "done")!.taskId)!;
    const pendingMapping = firstMappings.find((mapping) => store.listPlanNodes(first.revision.id).find((node) => node.id === mapping.planNodeId)?.stableKey === "pending")!;
    store.startTask(doneTask.id, "ags-revision-done");
    store.completeTask(doneTask.id);
    const stableTask = store.getTask(firstMappings.find((mapping) => store.listPlanNodes(first.revision.id).find((node) => node.id === mapping.planNodeId)?.stableKey === "stable")!.taskId)!;
    store.startTask(stableTask.id, "ags-revision-stable");
    store.completeTask(stableTask.id);

    const second = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v2", objective: "新计划", workKind: "change", riskLevel: "low",
      basedOnRevisionId: first.revision.id, status: "approved", lint: [],
      diff: { added: ["new"], removed: ["pending"], modified: [] },
      nodes: [
        { nodeId: "done", expertId: "exp-coder", title: "已完成", description: "已完成", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] },
        { nodeId: "stable", expertId: "exp-verify", title: "稳定验证", description: "稳定验证", dependsOn: ["done"], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
        { nodeId: "new", expertId: "exp-verify", title: "新验证", description: "新验证", dependsOn: [], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    const secondRun = store.materializePlanRun(second.revision.id)!;

    expect(store.getPlanRun(firstRun.id)?.status).toBe("superseded");
    expect(store.getTask(doneTask.id)?.status).toBe("completed");
    expect(store.getTask(pendingMapping.taskId)?.status).toBe("cancelled");
    expect(store.listPlanNodeTasks(firstRun.id).find((mapping) => mapping.taskId === pendingMapping.taskId)?.disposition).toBe("replaced");
    expect(store.listPlanNodeTasks(secondRun.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: doneTask.id, disposition: "reused" }),
      expect.objectContaining({ taskId: stableTask.id, disposition: "reused" }),
      expect.objectContaining({ disposition: "created" }),
    ]));
  });

  it("keeps superseded running resources mutually exclusive with a revised run", async () => {
    const { store, flow, turn } = setup();
    const first = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v1", objective: "旧计划", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [{ nodeId: "code", expertId: "exp-coder", title: "旧实现", description: "旧实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] }],
    })!;
    const firstRun = store.materializePlanRun(first.revision.id)!;
    const firstTask = store.getTask(store.listPlanNodeTasks(firstRun.id)[0]!.taskId)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const session = store.createAgentSession({ flowId: flow.id, workRunId: turn.id, taskId: firstTask.id, expertId: "exp-coder", flowExpertId: flowExpert.id, status: "streaming" });
    store.assignTaskFlowExpert(firstTask.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(firstTask.id, "in_progress");

    const second = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "v2", objective: "改写计划", workKind: "change", riskLevel: "low",
      basedOnRevisionId: first.revision.id, status: "approved", lint: [],
      diff: { added: [], removed: [], modified: [{ node_id: "code", fields: ["description"] }] },
      nodes: [{ nodeId: "code", expertId: "exp-coder", title: "新实现", description: "新实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] }],
    })!;
    const scheduler = createOrchestrationScheduler({ store, eventBus: new EventBus() });
    await scheduler.startRevision(second.revision.id);

    // L2：物化不派发——旧任务照常在跑，新任务保持 pending 等 Leader 派发。
    expect(store.getTask(firstTask.id)?.status).toBe("in_progress");
    const secondRun = store.getPlanRunForRevision(second.revision.id)!;
    const secondTask = store.getTask(store.listPlanNodeTasks(secondRun.id)[0]!.taskId)!;
    expect(secondTask.status).toBe("pending");
  });

  it("returns materialized tasks on auto-approved submit so the Leader dispatches in the same turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-orchestration-"));
    dirs.push(dir);
    const store = createStore(path.join(dir, "db.sqlite"));
    stores.push(store);
    store.migrate();
    store.seedExperts();
    const project = store.createProject({ id: "project-auto", name: "Auto", localPath: dir, description: "" });
    const flow = store.createFlow({ id: "flow-auto", name: "Auto", description: "", projectId: project.id, planApproval: "off" });
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const scheduler = createOrchestrationScheduler({ store, eventBus: new EventBus() });
    const handlers = createLeaderToolHandlers(
      createStorePort(store),
      {
        onPlanCreated: async ({ revision }) => {
          const revisionId = String((revision as { id?: unknown }).id ?? "");
          if (String((revision as { status?: unknown }).status ?? "") === "approved" && revisionId) {
            await scheduler.startRevision(revisionId);
          }
        },
      },
      { currentTurnInput: { trigger_kind: "user_message", work_run_id: turn.id, created_at: new Date().toISOString() } },
    );

    const response = JSON.parse(await handlers.submitOrchestrationPlan({
      flow_id: flow.id,
      title: "自动批准",
      objective: "自动批准后同轮派发",
      work_kind: "change",
      risk_level: "low",
      nodes: [
        { node_id: "code", expert_id: "exp-coder", title: "实现", description: "实现", depends_on: [], acceptance_criteria: ["完成"], risk_tags: [], side_effects: [], resource_keys: [] },
        { node_id: "verify", expert_id: "exp-verify", title: "验证", description: "验证", depends_on: ["code"], acceptance_criteria: ["通过"], risk_tags: [], side_effects: [], resource_keys: [] },
      ],
    })) as Record<string, any>;

    expect(response.ok).toBe(true);
    expect(response.auto_approved).toBe(true);
    expect(response.next).toContain("dispatch_agent");
    expect(response.tasks).toHaveLength(2);
    expect(response.tasks.every((task: any) => task.status === "pending")).toBe(true);
  });

  it("materializes an approved revision without auto-dispatch and reconciles run status from tasks", async () => {
    const { store, flow, turn } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "账本", objective: "账本对账", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [
        { nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: [] },
        { nodeId: "verify", expertId: "exp-verify", title: "验证", description: "验证", dependsOn: ["code"], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    const scheduler = createOrchestrationScheduler({ store, eventBus: new EventBus() });
    const run = (await scheduler.startRevision(created.revision.id))!;
    const mappings = store.listPlanNodeTasks(run.id);
    const tasks = mappings.map((mapping) => store.getTask(mapping.taskId)!);
    const implementationTask = tasks.find((task) => store.listTaskDependencies(task.id).length === 0)!;
    const verificationTask = tasks.find((task) => task.id !== implementationTask.id)!;

    // 物化后所有任务 pending，无自动派发
    expect(tasks.every((task) => task.status === "pending")).toBe(true);
    expect(run.status).toBe("running");
    expect(store.startTask(implementationTask.id, "ags-scheduler-code")).toEqual(expect.objectContaining({ status: "in_progress" }));

    // The scheduler is a ledger only: an explicit Expert/Leader blocked state
    // is reflected in the Plan Run, and an explicit restart clears it.
    store.updateTask(implementationTask.id, { status: "blocked" });
    await scheduler.advanceForTask(implementationTask.id);
    expect(store.getPlanRun(run.id)?.status).toBe("blocked");
    store.updateTask(implementationTask.id, { status: "in_progress" });
    await scheduler.advanceForTask(implementationTask.id);
    expect(store.getPlanRun(run.id)?.status).toBe("running");

    // 任务失败且无在跑任务 → blocked
    store.failTask(implementationTask.id, "boom");
    await scheduler.advanceForTask(implementationTask.id);
    expect(store.getPlanRun(run.id)?.status).toBe("blocked");

    // 任务重新在跑 → running
    store.setTaskRuntimeStatus(implementationTask.id, "in_progress");
    await scheduler.advanceForTask(implementationTask.id);
    expect(store.getPlanRun(run.id)?.status).toBe("running");

    // 全部完成 → completed
    store.completeTask(implementationTask.id);
    store.startTask(verificationTask.id, "ags-scheduler-verify");
    store.completeTask(verificationTask.id);
    await scheduler.advanceForTask(verificationTask.id);
    expect(store.getPlanRun(run.id)?.status).toBe("completed");
  });

  it("restores a paused run and its revision mappings after reopening the database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-orchestration-recovery-"));
    dirs.push(dir);
    const databasePath = path.join(dir, "db.sqlite");
    const firstStore = createStore(databasePath);
    firstStore.migrate();
    firstStore.seedExperts();
    const project = firstStore.createProject({ id: "project-recovery", name: "Recovery", localPath: dir, description: "" });
    const flow = firstStore.createFlow({ id: "flow-recovery", name: "Recovery", description: "", projectId: project.id });
    const turn = firstStore.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-recovery" })!;
    firstStore.startWorkRunWork({ flowId: flow.id, workRunId: turn.id, workSource: "direct_message", targetProjectId: project.id, inputSnapshotJson: "{}" });
    const plan = firstStore.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "Recovery", objective: "恢复", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [{ nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: [] }],
    })!;
    const run = firstStore.materializePlanRun(plan.revision.id)!;
    const task = firstStore.getTask(firstStore.listPlanNodeTasks(run.id)[0]!.taskId)!;
    firstStore.startTask(task.id, "ags-recovery-running");
    firstStore.recordPlanFeedback({ flowId: flow.id, workRunId: turn.id, planRevisionId: plan.revision.id, sourceMessageId: "recovery-feedback", feedback: [{ markerNumber: 1, comment: "暂停" }] });
    expect(firstStore.getPlanRun(run.id)?.status).toBe("paused_for_feedback");
    firstStore.sqlite.close();

    const restored = createStore(databasePath);
    stores.push(restored);
    restored.migrate();
    expect(restored.getPlanRun(run.id)).toEqual(expect.objectContaining({ status: "paused_for_feedback", planRevisionId: plan.revision.id }));
    expect(restored.listPlanNodeTasks(run.id)).toHaveLength(1);
    expect(restored.listPlanFeedback(plan.revision.id)[0]?.status).toBe("pending");
  });
});

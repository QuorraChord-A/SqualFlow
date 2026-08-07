import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/db/store.js";
import { buildFlowSnapshot } from "../src/domain/flowSnapshot.js";

const stores: Store[] = [];

function storeFixture() {
  const store = createStore(":memory:");
  stores.push(store);
  store.migrate();
  const project = store.createProject({ id: `project-${stores.length}`, name: "测试项目", localPath: "/tmp" });
  const flow = store.createFlow({
    id: `flow-${stores.length}`,
    projectId: project.id,
    name: "Supervisor Flow",
  })!;
  const leader = store.getLeaderAgentSession(flow.id)!;
  const leaderRun = store.createAgentRun({
    id: `leader-run-${stores.length}`,
    flowId: flow.id,
    agentSessionId: leader.id,
    status: "running",
  })!;
  return { store, project, flow, leader, leaderRun };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

describe("Supervisor persistence", () => {
  it("creates one durable Leader Session and enforces one active Run per Session", () => {
    const { store, flow, leader, leaderRun } = storeFixture();
    expect(store.listAgentSessions(flow.id)).toEqual([expect.objectContaining({ id: leader.id, role: "leader" })]);
    expect(store.createAgentSession({ flowId: flow.id, agentDefinitionId: "exp-leader" })).toBeUndefined();
    expect(store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id })).toBeUndefined();

    store.updateAgentRunStatus(leaderRun.id, "completed");
    const next = store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id, triggerKind: "follow_up" });
    expect(next).toEqual(expect.objectContaining({ agentSessionId: leader.id, status: "queued" }));
    expect(() => store.updateAgentRunStatus(leaderRun.id, "running")).toThrow("INVALID_AGENT_RUN_TRANSITION");
  });

  it("does not infer Task status from AgentRun completion and rejects dependency cycles", () => {
    const { store, flow, leaderRun } = storeFixture();
    const first = store.createTask({
      flowId: flow.id,
      title: "实现",
      description: "实现功能",
      createdByAgentRunId: leaderRun.id,
    })!;
    const second = store.createTask({
      flowId: flow.id,
      title: "验证",
      description: "验证功能",
      dependsOnTaskIds: [first.id],
      createdByAgentRunId: leaderRun.id,
    })!;
    const expert = store.createAgentSession({ flowId: flow.id, agentDefinitionId: "exp-coder" })!;
    const expertRun = store.createAgentRun({
      flowId: flow.id,
      agentSessionId: expert.id,
      taskId: first.id,
      status: "running",
    })!;
    store.updateAgentRunStatus(expertRun.id, "completed");
    expect(store.getTask(first.id)?.status).toBe("pending");
    expect(store.listRunnableTasks(flow.id).map((task) => task.id)).toEqual([first.id]);
    expect(store.updateTask(first.id, { addBlockedBy: [second.id] })).toBeUndefined();

    const completed = store.updateTask(first.id, { status: "completed", expectedRevision: first.revision })!;
    expect(store.listRunnableTasks(flow.id).map((task) => task.id)).toContain(second.id);
    expect(() => store.updateTask(first.id, { status: "in_progress", expectedRevision: completed.revision }))
      .toThrow("INVALID_TASK_TRANSITION");
  });

  it("keeps tool permission on the same AgentRun and makes resolution idempotent", () => {
    const { store, flow, leaderRun } = storeFixture();
    const call = store.createToolCall({
      id: "tool-1",
      flowId: flow.id,
      agentRunId: leaderRun.id,
      name: "Bash",
      idempotencyKey: "once",
      arguments: { command: "npm test" },
    })!;
    expect(store.createToolCall({
      flowId: flow.id,
      agentRunId: leaderRun.id,
      name: "Bash",
      idempotencyKey: "once",
    })?.id).toBe(call.id);
    const request = store.createDecisionRequest({
      id: "permission-1",
      flowId: flow.id,
      agentRunId: leaderRun.id,
      toolCallId: call.id as string,
      requestType: "tool_permission",
      payload: { provider_tool_name: "Bash" },
    })!;
    expect(store.getAgentRun(leaderRun.id)?.status).toBe("waiting_tool_approval");
    expect(store.getToolCall(call.id as string)?.status).toBe("waiting_approval");

    const first = store.resolveDecisionRequest({
      requestId: request.id as string,
      status: "approved",
      clientActionId: "approve-once",
    });
    const duplicate = store.resolveDecisionRequest({
      requestId: request.id as string,
      status: "approved",
      clientActionId: "approve-once",
    });
    expect(first?.idempotent).toBe(false);
    expect(duplicate?.idempotent).toBe(true);
    expect(store.getAgentRun(leaderRun.id)?.status).toBe("running");
    expect(store.getToolCall(call.id as string)?.status).toBe("running");
    store.updateToolCall({ toolCallId: call.id as string, status: "completed", result: { ok: true } });
    expect(() => store.updateToolCall({ toolCallId: call.id as string, status: "running" }))
      .toThrow("INVALID_TOOL_CALL_TRANSITION");
  });

  it("binds every Plan revision to a fresh approval and preserves a user's later mode choice", () => {
    const { store, flow, leaderRun } = storeFixture();
    store.updateFlow(flow.id, { behaviorMode: "plan", riskMode: "full_access" });
    const first = store.createPlanRevision({
      flowId: flow.id,
      title: "启动修复计划",
      overview: "第一版",
      content: "# 第一版",
      sourceAgentRunId: leaderRun.id,
    })! as any;
    const second = store.createPlanRevision({
      flowId: flow.id,
      title: "启动修复计划",
      overview: "第二版",
      content: "# 第二版",
      sourceAgentRunId: leaderRun.id,
    })! as any;
    expect(first.revision.planDocumentId).toBe(second.revision.planDocumentId);
    expect(first.approval.id).not.toBe(second.approval.id);
    expect((store.getPlanApproval(first.approval.id) as any).status).toBe("superseded");
    expect(store.resolvePlanApproval({
      approvalId: first.approval.id,
      status: "approved",
      clientActionId: "stale",
    })).toBeUndefined();

    store.updateFlow(flow.id, { behaviorMode: "execute", riskMode: "auto_edit" });
    const resolved = store.resolvePlanApproval({
      approvalId: second.approval.id,
      status: "approved",
      clientActionId: "approve-v2",
    });
    expect(resolved?.behaviorModeChanged).toBe(false);
    expect(store.getFlowMode(flow.id)).toEqual({
      behaviorMode: "execute",
      riskMode: "auto_edit",
      orchestrationMode: "approval_required",
    });
    expect(store.listTasks(flow.id)).toHaveLength(0);
  });

  it("snapshots orchestration approval mode and materializes only the activated revision", () => {
    const { store, flow, leaderRun } = storeFixture();
    const nodes = [
      {
        stableKey: "develop",
        recommendedAgentDefinitionId: "exp-coder",
        title: "开发",
        description: "实现修复",
        acceptanceCriteria: ["测试通过"],
      },
      {
        stableKey: "verify",
        recommendedAgentDefinitionId: "exp-verify",
        title: "验证",
        description: "执行回归",
        acceptanceCriteria: ["无回归"],
        dependsOnStableKeys: ["develop"],
      },
    ];
    expect(store.submitOrchestrationRevision({
      flowId: flow.id,
      title: "非法循环",
      objective: "验证 DAG",
      sourceAgentRunId: leaderRun.id,
      nodes: [
        { ...nodes[0], dependsOnStableKeys: ["verify"] },
        { ...nodes[1], dependsOnStableKeys: ["develop"] },
      ],
    })).toBeUndefined();

    const waiting = store.submitOrchestrationRevision({
      flowId: flow.id,
      title: "协作修复",
      objective: "先开发后验证",
      sourceAgentRunId: leaderRun.id,
      nodes,
    })! as any;
    expect(waiting.revision.approvalModeSnapshot).toBe("approval_required");
    expect(waiting.approval.status).toBe("pending");
    expect(waiting.tasks).toEqual([]);

    store.updateFlow(flow.id, { orchestrationMode: "automatic" });
    const automatic = store.submitOrchestrationRevision({
      flowId: flow.id,
      title: "自动协作修复",
      objective: "立即执行",
      sourceAgentRunId: leaderRun.id,
      parentRevisionId: waiting.revision.id,
      nodes,
    })! as any;
    expect(automatic.revision.approvalModeSnapshot).toBe("automatic");
    expect(automatic.approval).toBeUndefined();
    expect(automatic.tasks).toHaveLength(2);
    expect((store.getOrchestrationApproval(waiting.approval.id) as any).status).toBe("superseded");
    const verifyTask = automatic.tasks.find((task: any) => task.orchestrationNodeId === automatic.nodes[1].id)!;
    expect(store.listTaskDependencies(verifyTask.id)).toHaveLength(1);

    store.updateFlow(flow.id, { orchestrationMode: "approval_required" });
    const revised = store.submitOrchestrationRevision({
      flowId: flow.id,
      title: "需批准的新版本",
      objective: "保留旧工作直到批准",
      sourceAgentRunId: leaderRun.id,
      parentRevisionId: automatic.revision.id,
      nodes,
    })! as any;
    expect(store.listTasks(flow.id).filter((task) => task.orchestrationRevisionId === revised.revision.id)).toHaveLength(0);
    expect(store.listTasks(flow.id).filter((task) => task.orchestrationRevisionId === automatic.revision.id)).toHaveLength(2);
    const approved = store.resolveOrchestrationApproval({
      approvalId: revised.approval.id,
      status: "approved",
      clientActionId: "approve-revision",
    })!;
    expect(approved.tasks).toHaveLength(2);
    expect((store.getOrchestrationRevision(automatic.revision.id) as any).status).toBe("superseded");
    expect(store.listTasks(flow.id)).toHaveLength(4);
  });

  it("interrupts all active Runs and tool permissions without deleting collaboration history", () => {
    const { store, flow, leaderRun } = storeFixture();
    const plan = store.createPlanRevision({
      flowId: flow.id,
      title: "保留的计划",
      overview: "等待批准",
      content: "# 计划",
      sourceAgentRunId: leaderRun.id,
    })! as any;
    const expert = store.createAgentSession({ flowId: flow.id, agentDefinitionId: "exp-coder" })!;
    const expertRun = store.createAgentRun({ flowId: flow.id, agentSessionId: expert.id, status: "running" })!;
    const call = store.createToolCall({ flowId: flow.id, agentRunId: expertRun.id, name: "Bash" })!;
    const permission = store.createDecisionRequest({
      flowId: flow.id,
      agentRunId: expertRun.id,
      toolCallId: call.id as string,
      requestType: "tool_permission",
      payload: {},
    })!;
    const interrupted = store.interruptFlow(flow.id);
    expect(interrupted.map((run) => run.id).sort()).toEqual([leaderRun.id, expertRun.id].sort());
    expect(store.getAgentRun(leaderRun.id)?.status).toBe("interrupted");
    expect(store.getAgentRun(expertRun.id)?.status).toBe("interrupted");
    expect((store.getDecisionRequest(permission.id as string) as any).status).toBe("cancelled");
    expect(store.getToolCall(call.id as string)?.status).toBe("cancelled");
    expect((store.getPlanApproval(plan.approval.id) as any).status).toBe("pending");
    expect(store.getPlanDocument(flow.id)).toBeDefined();
  });

  it("supports shared and multiple ChangeSets while finalized history stays immutable", () => {
    const { store, flow, leaderRun } = storeFixture();
    const expert = store.createAgentSession({ flowId: flow.id, agentDefinitionId: "exp-coder" })!;
    const expertRun = store.createAgentRun({ flowId: flow.id, agentSessionId: expert.id, status: "running" })!;
    store.createChangeBaselineCandidate({
      flowId: flow.id,
      agentRunId: leaderRun.id,
      rootPath: "/tmp/project",
      snapshotPath: "/tmp/baseline-a",
      baselineJson: "{}",
      baselineKind: "filesystem",
    });
    const shared = store.openChangeSet({ flowId: flow.id, agentRunId: leaderRun.id, title: "共享变更" })! as any;
    expect(store.bindChangeSet({ changeSetId: shared.id, agentRunId: expertRun.id })).toBeDefined();
    store.reconcileChangeSetFiles({
      changeSetId: shared.id,
      touchedPaths: ["src/a.ts"],
      files: [{ path: "src/a.ts", status: "modified", patch: "+a", attributionKind: "direct" }],
    });
    store.reconcileChangeSetFiles({
      changeSetId: shared.id,
      touchedPaths: ["src/b.ts"],
      files: [{ path: "src/b.ts", status: "added", patch: "+b", attributionKind: "shell_snapshot" }],
      partialReason: "共享文件无法可靠归属，已排除",
    });
    expect(store.listChangeSetFiles(shared.id).map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    store.finalizeChangeSet(shared.id, { verdict: "approved" });
    expect(store.reconcileChangeSetFiles({
      changeSetId: shared.id,
      touchedPaths: ["src/a.ts"],
      files: [],
    })).toBeUndefined();
    expect(store.listChangeSetFiles(shared.id)).toHaveLength(2);

    store.createChangeBaselineCandidate({
      flowId: flow.id,
      agentRunId: expertRun.id,
      rootPath: "/tmp/project",
      snapshotPath: "/tmp/baseline-b",
      baselineJson: "{}",
      baselineKind: "filesystem",
    });
    expect(store.openChangeSet({ flowId: flow.id, agentRunId: expertRun.id, title: "第二个变更" })).toBeDefined();
    expect(store.listChangeSets(flow.id)).toHaveLength(2);
  });

  it("persists unread output independently and exposes no removed snapshot contract", () => {
    const { store, flow } = storeFixture();
    store.markFlowRead(flow.id, "local-default", "2026-01-01T00:00:00.000Z");
    store.markFlowOutputCompleted(flow.id, "2026-01-02T00:00:00.000Z");
    expect(store.hasUnreadOutput(flow.id)).toBe(true);
    const snapshot = buildFlowSnapshot(store, flow.id) as Record<string, unknown>;
    expect(snapshot.indicator).toBe("running");
    expect(snapshot.has_unread_output).toBe(true);
    for (const removed of ["work_runs", "work_run", "flow_experts", "spec", "plan_run", "current_stage"]) {
      expect(snapshot).not.toHaveProperty(removed);
    }
    store.markFlowRead(flow.id, "local-default", "2026-01-03T00:00:00.000Z");
    expect(store.hasUnreadOutput(flow.id)).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { createAgentDispatcher } from "../src/runtime/agentDispatcher.js";
import { EventBus } from "../src/ws/eventBus.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-plan-gates-"));
  dirs.push(dir);
  const store = createStore(path.join(dir, "db.sqlite"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  const project = store.createProject({ id: "project-gates", name: "Gates", localPath: dir, description: "" });
  const flow = store.createFlow({ id: "flow-gates", name: "Gates", description: "", projectId: project.id });
  const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
  store.startWorkRunWork({ flowId: flow.id, workRunId: turn.id, workSource: "direct_message", targetProjectId: project.id, inputSnapshotJson: "{}" });
  const dispatcher = createAgentDispatcher({
    store,
    eventBus: new EventBus(),
    expertRuntime: { runTask: async () => undefined },
  });
  return { store, flow, turn, dispatcher };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// L2：派发权归 Leader，服务端在派发时把关。
describe("dispatch-time plan gates", () => {
  it("dispatches a materialized plan task and blocks its dependent until completion", async () => {
    const { store, flow, turn, dispatcher } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "计划", objective: "实现并验证", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [
        { nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: [] },
        { nodeId: "verify", expertId: "exp-verify", title: "验证", description: "验证", dependsOn: ["code"], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    const nodes = store.listPlanNodes(created.revision.id);
    const taskByKey = new Map(store.listPlanNodeTasks(run.id).map((mapping) => [
      nodes.find((node) => node.id === mapping.planNodeId)!.stableKey,
      store.getTask(mapping.taskId)!,
    ]));
    const codeTask = taskByKey.get("code")!;
    const verifyTask = taskByKey.get("verify")!;

    // 依赖未完成 → 拒绝
    const blocked = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: verifyTask.id, expertId: "exp-verify", prompt: "验证", resumeAgentSessionId: "",
    });
    expect(blocked).toEqual(expect.objectContaining({ status: "failed", error: "task is blocked by incomplete dependencies" }));

    // 无依赖节点可派
    const dispatched = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: codeTask.id, expertId: "exp-coder", prompt: "实现", resumeAgentSessionId: "",
    });
    expect(dispatched.status).toBe("queued");

    // 依赖完成后可派
    store.setTaskRuntimeStatus(codeTask.id, "in_progress");
    store.completeTask(codeTask.id);
    const afterDep = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: verifyTask.id, expertId: "exp-verify", prompt: "验证", resumeAgentSessionId: "",
    });
    expect(afterDep.status).toBe("queued");
  });

  it("rejects dispatch while the plan run is paused for feedback", async () => {
    const { store, flow, turn, dispatcher } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "暂停", objective: "暂停中不派", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [
        { nodeId: "code", expertId: "exp-coder", title: "实现", description: "实现", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: [] },
        { nodeId: "verify", expertId: "exp-verify", title: "验证", description: "验证", dependsOn: [], acceptanceCriteria: ["验证"], riskTags: [], sideEffects: [], resourceKeys: [] },
      ],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    const [runningMapping, blockedMapping] = store.listPlanNodeTasks(run.id);
    const runningTask = store.getTask(runningMapping!.taskId)!;
    const blockedTask = store.getTask(blockedMapping!.taskId)!;
    const started = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: runningTask.id,
      expertId: runningTask.expertId!,
      prompt: "先开始实现",
      resumeAgentSessionId: "",
    });
    expect(started.status).toBe("queued");
    store.recordPlanFeedback({
      flowId: flow.id,
      workRunId: turn.id,
      planRevisionId: created.revision.id,
      sourceMessageId: "feedback-1",
      feedback: [{ markerNumber: 1, comment: "先等等" }],
    });
    expect(store.getPlanRun(run.id)?.status).toBe("paused_for_feedback");

    const rejected = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: blockedTask.id,
      expertId: blockedTask.expertId!,
      prompt: "实现",
      resumeAgentSessionId: "",
    });
    expect(rejected).toEqual(expect.objectContaining({ status: "failed", error: "plan is paused for feedback" }));
  });

  it("rejects dispatch when resource keys conflict with a running task", async () => {
    const { store, flow, turn, dispatcher } = setup();
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id, workRunId: turn.id, title: "资源", objective: "共享写范围串行", workKind: "change", riskLevel: "low",
      status: "approved", lint: [], diff: {},
      nodes: [
        { nodeId: "a", expertId: "exp-coder", title: "改 src A", description: "A", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] },
        { nodeId: "b", expertId: "exp-verify", title: "改 src B", description: "B", dependsOn: [], acceptanceCriteria: ["完成"], riskTags: [], sideEffects: [], resourceKeys: ["src"] },
      ],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    const nodes = store.listPlanNodes(created.revision.id);
    const taskByKey = new Map(store.listPlanNodeTasks(run.id).map((mapping) => [
      nodes.find((node) => node.id === mapping.planNodeId)!.stableKey,
      store.getTask(mapping.taskId)!,
    ]));

    const first = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: taskByKey.get("a")!.id, expertId: "exp-coder", prompt: "A", resumeAgentSessionId: "",
    });
    expect(first.status).toBe("queued");

    const conflicted = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: taskByKey.get("b")!.id, expertId: "exp-verify", prompt: "B", resumeAgentSessionId: "",
    });
    expect(conflicted).toEqual(expect.objectContaining({ status: "failed", error: "resource conflict with a running task" }));

    // 冲突任务完成后放行
    const taskA = taskByKey.get("a")!;
    store.setTaskRuntimeStatus(taskA.id, "in_progress");
    store.completeTask(taskA.id);
    const released = await dispatcher.dispatchAgent({
      flowId: flow.id, taskId: taskByKey.get("b")!.id, expertId: "exp-verify", prompt: "B", resumeAgentSessionId: "",
    });
    expect(released.status).toBe("queued");
  });
});

import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { TaskStatusSchema } from "../src/domain/schemas.js";
import {
  isWorkRunAwaitingPlanFeedback,
  isWorkRunSettled,
  pauseWorkRunIfAwaitingPlanFeedback,
} from "../src/domain/workRun.js";
import { currentTurnInputFromTurn } from "../src/runtime/leaderPrompt.js";
import { beginWorkRun } from "./helpers/workRunTestHelpers.js";

function setup() {
  const store = createStore(":memory:");
  store.migrate();
  const project = store.createProject({ name: "Project", localPath: "/tmp/project" });
  const flow = store.createFlow({ name: "Flow", description: "", projectId: project.id });
  return { store, flow };
}

describe("WorkRun single lifecycle", () => {
  it("atomically prepares one WorkRun without making the Flow active", () => {
    const { store, flow } = setup();
    const first = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" });

    expect(first?.status).toBe("ready");
    expect(store.getFlow(flow.id)?.status).toBe("ready");
    expect(store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-2" })).toBeUndefined();
    expect(store.listWorkRuns(flow.id)).toHaveLength(1);
    store.sqlite.close();
  });

  it("does not mirror WorkRun completion into Flow status", () => {
    const { store, flow } = setup();
    const turn = beginWorkRun(store, { flowId: flow.id })!;

    expect(store.completeWorkRun(turn.id)?.status).toBe("completed");
    expect(store.getFlow(flow.id)?.status).toBe("ready");
    store.sqlite.close();
  });

  it.each(["in_progress", "blocked"])("recognizes %s as a valid non-terminal Task status", (status) => {
    expect(TaskStatusSchema.parse(status)).toBe(status);
  });

  it.each(["in_progress", "blocked"] as const)("does not settle while a Task is %s", (status) => {
    const { store, flow } = setup();
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const started = store.startWorkRunWork({
      flowId: flow.id,
      workRunId: turn.id,
      workSource: "direct_message",
      targetProjectId: flow.projectId!,
      inputSnapshotJson: "{}",
    })!;
    const task = store.createTask({ flowId: flow.id, workRunId: started.id, title: "Task", description: "Task" })!;
    store.setTaskRuntimeStatus(task.id, status);

    expect(isWorkRunSettled(store, turn.id)).toBe(false);
    store.sqlite.close();
  });

  it("treats failed Tasks as recoverable work rather than a fatal WorkRun", () => {
    const { store, flow } = setup();
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    store.startWorkRunWork({
      flowId: flow.id,
      workRunId: turn.id,
      workSource: "direct_message",
      targetProjectId: flow.projectId!,
      inputSnapshotJson: "{}",
    });
    const task = store.createTask({ flowId: flow.id, workRunId: turn.id, title: "Verify", description: "Verify" })!;
    store.startTask(task.id, "ags-verify");
    store.failTask(task.id, "verification failed");

    expect(isWorkRunSettled(store, turn.id)).toBe(true);
    expect(store.getWorkRun(turn.id)?.status).toBe("executing");
    store.sqlite.close();
  });

  it("does not settle while an orchestration run is paused for feedback", () => {
    const { store, flow } = setup();
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-plan-feedback" })!;
    const plan = store.createOrchestrationPlanRevision({
      flowId: flow.id,
      workRunId: turn.id,
      title: "Feedback",
      objective: "Keep the turn open",
      workKind: "change",
      riskLevel: "low",
      status: "approved",
      lint: [],
      diff: {},
      nodes: [{
        nodeId: "code",
        expertId: "exp-coder",
        title: "Code",
        description: "Code",
        dependsOn: [],
        acceptanceCriteria: ["done"],
        riskTags: [],
        sideEffects: [],
        resourceKeys: [],
      }],
    })!;
    const run = store.materializePlanRun(plan.revision.id)!;
    const task = store.getTask(store.listPlanNodeTasks(run.id)[0]!.taskId)!;
    store.startTask(task.id, "ags-plan");
    store.completeTask(task.id);
    store.recordPlanFeedback({
      flowId: flow.id,
      workRunId: turn.id,
      planRevisionId: plan.revision.id,
      sourceMessageId: "msg-feedback",
      feedback: [{ markerNumber: 1, comment: "Please revisit this" }],
    });

    expect(store.getPlanRun(run.id)?.status).toBe("paused_for_feedback");
    expect(isWorkRunSettled(store, turn.id)).toBe(false);
    expect(isWorkRunAwaitingPlanFeedback(store, turn.id)).toBe(true);
    expect(pauseWorkRunIfAwaitingPlanFeedback(store, turn.id)?.status).toBe("waiting_user");
    store.sqlite.close();
  });

  it("freezes the work root when the WorkRun first starts work", () => {
    const { store, flow } = setup();
    const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const firstProject = store.getProject(flow.projectId!)!;
    const secondProject = store.createProject({ name: "Other", localPath: "/tmp/other" });
    store.startWorkRunWork({
      flowId: flow.id,
      workRunId: turn.id,
      workSource: "direct_message",
      targetProjectId: firstProject.id,
      inputSnapshotJson: "{}",
    });
    store.updateFlow(flow.id, { projectId: secondProject.id });

    expect(store.getWorkRun(turn.id)).toEqual(expect.objectContaining({
      targetProjectId: firstProject.id,
      workRootPath: firstProject.localPath,
    }));
    store.sqlite.close();
  });

});

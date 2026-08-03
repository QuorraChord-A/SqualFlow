import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { TaskStatusSchema } from "../src/domain/schemas.js";
import {
  isUserTurnAwaitingPlanFeedback,
  isUserTurnSettled,
  pauseUserTurnIfAwaitingPlanFeedback,
} from "../src/domain/userTurn.js";
import { currentTurnInputFromTurn } from "../src/runtime/leaderPrompt.js";

function setup() {
  const store = createStore(":memory:");
  store.migrate();
  const project = store.createProject({ name: "Project", localPath: "/tmp/project" });
  const flow = store.createFlow({ name: "Flow", description: "", projectId: project.id });
  return { store, flow };
}

describe("UserTurn single lifecycle", () => {
  it("atomically marks the Flow active and rejects a second open UserTurn", () => {
    const { store, flow } = setup();
    const first = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" });

    expect(first?.status).toBe("active");
    expect(store.getFlow(flow.id)?.status).toBe("active");
    expect(store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-2" })).toBeUndefined();
    expect(store.listUserTurns(flow.id)).toHaveLength(1);
    store.sqlite.close();
  });

  it("updates Flow status in the same lifecycle transition as UserTurn completion", () => {
    const { store, flow } = setup();
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;

    expect(store.completeUserTurn(turn.id)?.status).toBe("completed");
    expect(store.getFlow(flow.id)?.status).toBe("idle");
    store.sqlite.close();
  });

  it.each(["in_progress", "blocked"])("recognizes %s as a valid non-terminal Task status", (status) => {
    expect(TaskStatusSchema.parse(status)).toBe(status);
  });

  it.each(["in_progress", "blocked"] as const)("does not settle while a Task is %s", (status) => {
    const { store, flow } = setup();
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const started = store.startUserTurnWork({
      flowId: flow.id,
      userTurnId: turn.id,
      workSource: "direct_message",
      targetProjectId: flow.projectId!,
      inputSnapshotJson: "{}",
    })!;
    const task = store.createTask({ flowId: flow.id, userTurnId: started.id, title: "Task", description: "Task" })!;
    store.setTaskRuntimeStatus(task.id, status);

    expect(isUserTurnSettled(store, turn.id)).toBe(false);
    store.sqlite.close();
  });

  it("treats failed Tasks as recoverable work rather than a fatal UserTurn", () => {
    const { store, flow } = setup();
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    store.startUserTurnWork({
      flowId: flow.id,
      userTurnId: turn.id,
      workSource: "direct_message",
      targetProjectId: flow.projectId!,
      inputSnapshotJson: "{}",
    });
    const task = store.createTask({ flowId: flow.id, userTurnId: turn.id, title: "Verify", description: "Verify" })!;
    store.updateTask(task.id, { status: "in_progress" });
    store.failTask(task.id, "verification failed");

    expect(isUserTurnSettled(store, turn.id)).toBe(true);
    expect(store.getUserTurn(turn.id)?.status).toBe("active");
    store.sqlite.close();
  });

  it("does not settle while an orchestration run is paused for feedback", () => {
    const { store, flow } = setup();
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-plan-feedback" })!;
    const plan = store.createOrchestrationPlanRevision({
      flowId: flow.id,
      userTurnId: turn.id,
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
    store.setTaskRuntimeStatus(task.id, "in_progress");
    store.completeTask(task.id);
    store.recordPlanFeedback({
      flowId: flow.id,
      userTurnId: turn.id,
      planRevisionId: plan.revision.id,
      sourceMessageId: "msg-feedback",
      feedback: [{ markerNumber: 1, comment: "Please revisit this" }],
    });

    expect(store.getPlanRun(run.id)?.status).toBe("paused_for_feedback");
    expect(isUserTurnSettled(store, turn.id)).toBe(false);
    expect(isUserTurnAwaitingPlanFeedback(store, turn.id)).toBe(true);
    expect(pauseUserTurnIfAwaitingPlanFeedback(store, turn.id)?.status).toBe("waiting_user");
    store.sqlite.close();
  });

  it("freezes the work root when the UserTurn first starts work", () => {
    const { store, flow } = setup();
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    const firstProject = store.getProject(flow.projectId!)!;
    const secondProject = store.createProject({ name: "Other", localPath: "/tmp/other" });
    store.startUserTurnWork({
      flowId: flow.id,
      userTurnId: turn.id,
      workSource: "direct_message",
      targetProjectId: firstProject.id,
      inputSnapshotJson: "{}",
    });
    store.updateFlow(flow.id, { projectId: secondProject.id });

    expect(store.getUserTurn(turn.id)).toEqual(expect.objectContaining({
      targetProjectId: firstProject.id,
      workRootPath: firstProject.localPath,
    }));
    store.sqlite.close();
  });

  it("gives cold-start recovery turns the current UserTurn tool context", () => {
    expect(currentTurnInputFromTurn({
      flowId: "flow-1",
      kind: "user_turn_recovery",
      userTurnId: "utn-1",
      leaderAgentSessionId: "ags-leader",
      leaderSessionId: "sdk-leader",
    })).toEqual(expect.objectContaining({
      trigger_kind: "user_turn_recovery",
      user_turn_id: "utn-1",
    }));
  });
});

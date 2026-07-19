import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginUserTurn, createWorkingUserTurn } from "./helpers/userTurnTestHelpers.js";
import { buildFlowWorkbench } from "../src/domain/workbench.js";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "squadflow-workbench-"));
  const store = createStore(path.join(dir, "test.db"));
  store.migrate();
  store.seedExperts();
  const project = store.createProject({ name: "p", localPath: "/tmp/p" });
  const flow = store.createFlow({ projectId: project.id, name: "t3" });
  return {
    store,
    flow,
    cleanup: () => {
      store.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Flow workbench projection", () => {
  it("projects legacy per-task agent sessions into one Flow Expert", () => {
    const { store, flow, cleanup } = setup();
    try {
      const userTurn = beginUserTurn(store, { flowId: flow.id, source: "direct_message" })!;
      const task1 = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "实现 Hello World", description: "one", expertId: "exp-coder", activeForm: "", dependsOnTaskIds: [] })!;
      const task2 = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "优化 Hello World 页面", description: "two", expertId: "exp-coder", activeForm: "", dependsOnTaskIds: [] })!;
      const session1 = store.createAgentSession({ flowId: flow.id, userTurnId: userTurn.id, taskId: task1.id, expertId: "exp-coder", displayName: "Frontend 2482", sessionId: "sdk-1" });
      const session2 = store.createAgentSession({ flowId: flow.id, userTurnId: userTurn.id, taskId: task2.id, expertId: "exp-coder", displayName: "Frontend 5924", sessionId: "sdk-2" });
      store.assignTaskAgentSession(task1.id, session1.id);
      store.assignTaskAgentSession(task2.id, session2.id);

      store.projectLegacyFlowExperts(flow.id);
      const workbench = buildFlowWorkbench(store, flow.id)!;
      const coderMembers = workbench.team.filter((member) => member.expert_id === "exp-coder");

      expect(coderMembers).toHaveLength(1);
      expect(coderMembers[0]?.display_name).toMatch(/^.{2,3}$/);
      expect(coderMembers[0]?.display_name).not.toBe("Coder");
      expect(coderMembers[0]?.role).toBe("全栈开发专家");
      const personName = coderMembers[0]!.display_name;
      expect(workbench.tasks.map((task) => task.owner_name)).toEqual([personName, personName]);
    } finally {
      cleanup();
    }
  });

  it("shows one Coder team member and all Flow Tasks across UserTurns", () => {
    const { store, flow, cleanup } = setup();
    try {
      store.createAgentSession({
        flowId: flow.id,
        userTurnId: null,
        taskId: null,
        expertId: "exp-leader",
        displayName: "Leader",
        sessionId: "leader-sdk",
      });

      const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
      const execution1 = beginUserTurn(store, { flowId: flow.id, source: "direct_message" })!;
      const task1 = store.createTask({
        flowId: flow.id,
        userTurnId: execution1.id,
        title: "实现 Hello World",
        description: "write page",
        expertId: "exp-coder",
        activeForm: "",
        dependsOnTaskIds: [],
      })!;
      const session1 = store.createAgentSession({
        flowId: flow.id,
        userTurnId: execution1.id,
        taskId: task1.id,
        expertId: "exp-coder",
        flowExpertId: flowExpert.id,
        displayName: "Frontend 2482",
        status: "completed",
      });
      store.assignTaskFlowExpert(task1.id, flowExpert.id, session1.id);
      store.completeTask(task1.id, JSON.stringify({ status: "done", summary: "done" }));
      store.completeUserTurn(execution1.id);

      const execution2 = beginUserTurn(store, { flowId: flow.id, source: "direct_message" })!;
      const task2 = store.createTask({
        flowId: flow.id,
        userTurnId: execution2.id,
        title: "优化 Hello World 页面",
        description: "optimize page",
        expertId: "exp-coder",
        activeForm: "",
        dependsOnTaskIds: [],
      })!;
      const session2 = store.createAgentSession({
        flowId: flow.id,
        userTurnId: execution2.id,
        taskId: task2.id,
        expertId: "exp-coder",
        flowExpertId: flowExpert.id,
        displayName: "Frontend 5924",
        status: "completed",
      });
      store.assignTaskFlowExpert(task2.id, flowExpert.id, session2.id);
      store.completeTask(task2.id, JSON.stringify({ status: "done", summary: "done" }));

      const workbench = buildFlowWorkbench(store, flow.id)!;
      const personName = flowExpert.displayName;

      expect(workbench.team.map((member) => member.display_name)).toEqual(["Leader", personName]);
      expect(workbench.team.filter((member) => member.expert_id === "exp-coder")).toHaveLength(1);
      expect(workbench.tasks.map((task) => task.subject)).toEqual([
        "实现 Hello World",
        "优化 Hello World 页面",
      ]);
      expect(workbench.tasks.every((task) => task.owner_name === personName)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { beginUserTurn, createWorkingUserTurn } from "./helpers/userTurnTestHelpers.js";

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "squadflow-flow-expert-"));
  const dbPath = path.join(dir, "test.db");
  const store = createStore(dbPath);
  store.migrate();
  store.seedExperts();
  return {
    store,
    cleanup: () => {
      store.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("flow expert persistence", () => {
  it("creates one Flow Expert per flow and expert template", () => {
    const { store, cleanup } = createTempStore();
    try {
      const project = store.createProject({ name: "p", localPath: "/tmp/p" });
      const flowA = store.createFlow({ projectId: project.id, name: "flow-a" });
      const flowB = store.createFlow({ projectId: project.id, name: "flow-b" });

      const first = store.getOrCreateFlowExpert({
        flowId: flowA.id,
        expertId: "exp-coder",
      });
      const second = store.getOrCreateFlowExpert({
        flowId: flowA.id,
        expertId: "exp-coder",
      });
      const otherFlow = store.getOrCreateFlowExpert({
        flowId: flowB.id,
        expertId: "exp-coder",
      });

      expect(first.id).toBe(second.id);
      expect(first.flowId).toBe(flowA.id);
      expect(first.expertId).toBe("exp-coder");
      // Person name from template candidates (not the role title).
      expect(first.displayName.length).toBeGreaterThanOrEqual(2);
      expect(first.displayName.length).toBeLessThanOrEqual(3);
      expect(first.displayName).not.toBe("全栈开发专家");
      expect(["阿码","小栈","码仔","修修","北辰","青禾","灵犀","通哥"]).toContain(first.displayName);
      expect(otherFlow.id).not.toBe(first.id);
      expect(store.getExpert("exp-coder")?.name).toBe("全栈开发专家");
    } finally {
      cleanup();
    }
  });

  it("links tasks and agent sessions to a Flow Expert", () => {
    const { store, cleanup } = createTempStore();
    try {
      const project = store.createProject({ name: "p", localPath: "/tmp/p" });
      const flow = store.createFlow({ projectId: project.id, name: "flow" });
      const userTurn = beginUserTurn(store, { flowId: flow.id, source: "direct_message" })!;
      const task = store.createTask({
        flowId: flow.id,
        userTurnId: userTurn.id,
        title: "实现 Hello World",
        description: "create page",
        expertId: null,
        activeForm: "",
        dependsOnTaskIds: [],
      })!;

      const flowExpert = store.getOrCreateFlowExpert({
        flowId: flow.id,
        expertId: "exp-coder",
      });
      const session = store.createAgentSession({
        flowId: flow.id,
        userTurnId: userTurn.id,
        taskId: task.id,
        expertId: "exp-coder",
        flowExpertId: flowExpert.id,
        displayName: "Coder",
        status: "streaming",
      });
      const updatedTask = store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);

      expect(session.flowExpertId).toBe(flowExpert.id);
      expect(updatedTask?.flowExpertId).toBe(flowExpert.id);
      expect(updatedTask?.agentSessionId).toBe(session.id);
    } finally {
      cleanup();
    }
  });
});

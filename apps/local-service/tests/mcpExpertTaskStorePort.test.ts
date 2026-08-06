import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { createExpertTaskStorePort } from "../src/mcp/expertTaskStorePort.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-expert-task-store-"));
  dirs.push(dir);
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

function setup() {
  const store = tempStore();
  const project = store.createProject({ name: "Project", localPath: fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-expert-task-project-")) });
  dirs.push(project.localPath);
  const flow = store.createFlow({ name: "Flow", description: "", projectId: project.id });
  const turn = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
  const workRun = store.startWorkRunWork({
    flowId: flow.id,
    workRunId: turn.id,
    workSource: "direct_message",
    targetProjectId: project.id,
    inputSnapshotJson: "{}",
  })!;
  const coder = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
  const verifier = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-verify" });
  const mine = store.createTask({
    flowId: flow.id,
    workRunId: workRun.id,
    title: "Implement the change",
    description: "Implement and verify the requested change.",
    expertId: "exp-coder",
    activeForm: "Implementing the change",
    acceptanceCriteria: ["Tests pass"],
  })!;
  const mineSession = store.createAgentSession({
    flowId: flow.id,
    workRunId: workRun.id,
    taskId: mine.id,
    expertId: "exp-coder",
    flowExpertId: coder.id,
    displayName: coder.displayName,
    status: "streaming",
  });
  store.assignTaskFlowExpert(mine.id, coder.id, mineSession.id);
  store.setTaskRuntimeStatus(mine.id, "in_progress");

  const mineLater = store.createTask({
    flowId: flow.id,
    workRunId: workRun.id,
    title: "Follow up",
    description: "Handle the follow-up after the first task.",
    expertId: "exp-coder",
    activeForm: "Waiting for follow-up",
  })!;
  store.assignTaskFlowExpert(mineLater.id, coder.id);

  const peer = store.createTask({
    flowId: flow.id,
    workRunId: workRun.id,
    title: "Peer task",
    description: "A verifier-owned task.",
    expertId: "exp-verify",
  })!;
  store.assignTaskFlowExpert(peer.id, verifier.id);

  return {
    store,
    flow,
    mine: store.getTask(mine.id)!,
    mineLater: store.getTask(mineLater.id)!,
    peer: store.getTask(peer.id)!,
    scope: { flowId: flow.id, flowExpertId: coder.id, agentSessionId: mineSession.id },
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Expert Task Store port", () => {
  it("lists every Task assigned to the active Expert, but never another Expert's Task", () => {
    const { store, mine, mineLater, peer, scope } = setup();
    const port = createExpertTaskStorePort(store);

    expect(port.listMyTasks(scope).map((task) => task.task_id).sort()).toEqual([mine.id, mineLater.id].sort());
    expect(port.getMyTask({ ...scope, taskId: mineLater.id })).toEqual(expect.objectContaining({
      task_id: mineLater.id,
      assignment: expect.objectContaining({ flow_expert_id: scope.flowExpertId }),
    }));
    expect(port.getMyTask({ ...scope, taskId: peer.id })).toBeNull();
  });

  it("lets an Expert explicitly update its own Task, publishes once, and retains a structured result", async () => {
    const { store, flow, mineLater, scope } = setup();
    const onTaskUpdated = vi.fn();
    const port = createExpertTaskStorePort(store, { onTaskUpdated });

    const updated = await port.updateMyTask({
      ...scope,
      taskId: mineLater.id,
      expectedRevision: mineLater.revision,
      progress: "Implementation finished; validation is complete.",
      result: { files_changed: ["apps/renderer/app/page.tsx"] },
      status: "completed",
    });

    expect(updated).toEqual(expect.objectContaining({
      ok: true,
      task: expect.objectContaining({
        task_id: mineLater.id,
        status: "completed",
        progress: "Implementation finished; validation is complete.",
        result: { files_changed: ["apps/renderer/app/page.tsx"] },
        revision: mineLater.revision + 1,
      }),
    }));
    expect(onTaskUpdated).toHaveBeenCalledTimes(1);
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      task: expect.objectContaining({ task_id: mineLater.id, status: "completed" }),
    }));
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "expert_task.updated", taskId: mineLater.id }),
    ]));
  });

  it("uses revision conflicts and assignment checks instead of broad Store access", async () => {
    const { store, mine, peer, scope } = setup();
    const port = createExpertTaskStorePort(store);
    const first = await port.updateMyTask({
      ...scope,
      taskId: mine.id,
      expectedRevision: mine.revision,
      progress: "Started implementation.",
    });
    expect(first.ok).toBe(true);

    await expect(port.updateMyTask({
      ...scope,
      taskId: mine.id,
      expectedRevision: mine.revision,
      progress: "Stale update.",
    })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "TASK_REVISION_CONFLICT" }),
    });
    await expect(port.updateMyTask({
      ...scope,
      taskId: peer.id,
      progress: "Attempt to change another Expert's Task.",
    })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "TASK_NOT_ASSIGNED" }),
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import { createExpertRuntime } from "../src/runtime/expertRuntime.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";

/**
 * Live end-to-end check of the fixed-steer send_message path through the real
 * ExpertRuntime + real SDK adapter (no mocks): dispatch a long task, steer a
 * Leader message into the running turn, and assert the round settles exactly once.
 *
 * Requires a prepared agent-runtime config root (real provider credentials on the
 * local machine, never committed) via env:
 *   SQUADFLOW_E2E_RUNTIME_ROOT=/path/to/agent-runtime-copy
 * Skipped when absent.
 */
const runtimeRoot = process.env.SQUADFLOW_E2E_RUNTIME_ROOT;
const enabled = Boolean(runtimeRoot && fs.existsSync(path.join(runtimeRoot, "index.json")));

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-e2e-steer-"));
  dirs.push(dir);
  config.agentRuntimeConfigRoot = runtimeRoot!;
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

function seedRunningTask(store: ReturnType<typeof createStore>) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-e2e-steer-project-"));
  dirs.push(projectRoot);
  const project = store.createProject({ name: "E2E Steer Project", localPath: projectRoot });
  const flow = store.createFlow({
    id: "flow-e2e-steer",
    name: "E2E steer",
    description: "",
    projectId: project.id,
  });
  const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: `msg-${Date.now()}` })!;
  const userTurn = store.startUserTurnWork({
    flowId: flow.id,
    userTurnId: turn.id,
    workSource: "direct_message",
    targetProjectId: project.id,
    inputSnapshotJson: "{}",
  })!;
  const task = store.createTask({
    flowId: flow.id,
    userTurnId: userTurn.id,
    title: "Count",
    description: "数数任务",
    expertId: "exp-coder",
    dependsOnTaskIds: [],
  })!;
  const session = store.createAgentSession({
    flowId: flow.id,
    userTurnId: userTurn.id,
    taskId: task.id,
    expertId: "exp-coder",
    displayName: "exp-coder",
    status: "streaming",
  });
  store.startTask(task.id, session.id);
  return { flow, userTurn, task, session };
}

afterEach(() => {
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("Expert steer live e2e", () => {
  it("steers a Leader message into a live running turn and settles once", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = seedRunningTask(store);
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
      prompt: "不要使用任何工具。请从 1 数到 60，每行输出一个数字，中途不要输出别的内容,数完后单独输出一行 COUNT-DONE。",
    });

    let accepted = false;
    const deadline = Date.now() + 120_000;
    while (!accepted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      accepted = runtime.sendMessage({
        flowId: flow.id,
        agentSessionId: session.id,
        content: "立即停止数数。改为只输出一行 STEER-ACK,然后结束回答。",
      });
    }
    expect(accepted).toBe(true);

    await running;

    const finishedTask = store.getTask(task.id);
    expect(finishedTask?.status).toBe("completed");
    const completions = store.listEventLog(flow.id)
      .filter((event) => event.eventType === "agent_session.turn_completed");
    expect(completions).toHaveLength(1);
    const result = JSON.parse(finishedTask?.resultJson ?? "{}") as { summary?: string };
    // Model compliance with the steer wording is provider-dependent; the mechanical
    // contract (single settled round) is asserted above. Log the tail for review.
    console.log("final summary tail:", String(result.summary ?? "").slice(-200).replaceAll("\n", "\\n"));
  }, 600_000);
});

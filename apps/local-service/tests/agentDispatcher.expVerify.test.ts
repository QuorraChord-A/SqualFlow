import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import { beginWorkRun, createWorkingWorkRun } from "./helpers/workRunTestHelpers.js";
import { createAgentDispatcher } from "../src/runtime/agentDispatcher.js";
import { createExpertRuntime } from "../src/runtime/expertRuntime.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeRuntimeConfig(root: string) {
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
    version: 1,
    roles: {
      leader: { enabled: true, configId: "test-claude", modelId: "test-model" },
      coder: { enabled: true, configId: "test-claude", modelId: "test-model" },
      research: { enabled: true, configId: "test-claude", modelId: "test-model" },
      verify: { enabled: true, configId: "test-claude", modelId: "test-model" },
      codereview: { enabled: true, configId: "test-claude", modelId: "test-model" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "test-claude.json"), `${JSON.stringify({
    id: "test-claude",
    fileName: "test-claude.json",
    name: "Test Claude",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models: [{ id: "test-model", name: "test-model" }],
  }, null, 2)}\n`);
}

function query(messages: unknown[]): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    close() {},
  };
}

afterEach(() => {
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentDispatcher exp-verify runtime failures", () => {
  it("preserves the provider error on AgentSession when direct exp-verify dispatch ends with success plus is_error", async () => {
    const runtimeConfigRoot = tempDir("squadflow-exp-verify-config-");
    writeRuntimeConfig(runtimeConfigRoot);
    config.agentRuntimeConfigRoot = runtimeConfigRoot;

    const store = createStore(path.join(tempDir("squadflow-exp-verify-store-"), "squadflow.db"));
    stores.push(store);
    store.migrate();
    store.seedExperts();
    const project = store.createProject({ name: "Verify Project", localPath: tempDir("squadflow-exp-verify-project-") });
    const flow = store.createFlow({
      id: "flow-exp-verify",
      name: "Verify",
      description: "",
      projectId: project.id,
    });
    const workRun = beginWorkRun(store, {
      flowId: flow.id,
      inputSnapshotJson: "{}",
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      workRunId: workRun.id,
      title: "Run tests",
      description: "Run npm test",
      expertId: "exp-verify",
      dependsOnTaskIds: [],
    })!;
    let finished!: () => void;
    const completion = new Promise<void>((resolve) => { finished = resolve; });
    const eventBus = new EventBus();
    const expertRuntime = createExpertRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => query([
        {
          type: "assistant",
          error: "authentication_failed",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: "Failed to authenticate. API Error: 403 AccessDenied: free quota exhausted",
            }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-exp-verify",
          is_error: true,
          result: "Failed to authenticate. API Error: 403 AccessDenied: free quota exhausted",
        },
      ]) }),
      onTaskFinished: () => finished(),
    });
    const dispatcher = createAgentDispatcher({ store, eventBus, expertRuntime });

    const dispatched = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-verify",
      prompt: "Run npm test and report the output",
      resumeAgentSessionId: "",
    });
    await completion;

    expect(dispatched).toEqual(expect.objectContaining({ status: "queued", expert_id: "exp-verify" }));
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      errorMessage: null,
    }));
    expect(store.getAgentSession(dispatched.agent_session_id)?.status).toBe("failed");
  });

  it.each(["exp-verify", "exp-research", "exp-codereview"])(
    "records a successful read-only %s execution without auto-completing its Task",
    async (expertId) => {
      const runtimeConfigRoot = tempDir(`squadflow-${expertId}-config-`);
      writeRuntimeConfig(runtimeConfigRoot);
      config.agentRuntimeConfigRoot = runtimeConfigRoot;

      const store = createStore(path.join(tempDir(`squadflow-${expertId}-store-`), "squadflow.db"));
      stores.push(store);
      store.migrate();
      store.seedExperts();
      const project = store.createProject({ name: "Read-only Project", localPath: tempDir(`squadflow-${expertId}-project-`) });
      const flow = store.createFlow({
        id: `flow-${expertId}`,
        name: expertId,
        description: "",
        projectId: project.id,
      });
      const workRun = beginWorkRun(store, {
        flowId: flow.id,
        inputSnapshotJson: "{}",
        createdBy: "user",
      })!;
      const task = store.createTask({
        flowId: flow.id,
        workRunId: workRun.id,
        title: "Read-only task",
        description: "Inspect and report",
        expertId,
        dependsOnTaskIds: [],
      })!;
      let finished!: () => void;
      const completion = new Promise<void>((resolve) => { finished = resolve; });
      const eventBus = new EventBus();
      const expertRuntime = createExpertRuntime({
        store,
        eventBus,
        chatJournal: new ChatJournal(),
        runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => query([{
          type: "result",
          subtype: "success",
          session_id: `sdk-${expertId}`,
          is_error: false,
          result: "Read-only task completed",
        }]) }),
        onTaskFinished: () => finished(),
      });
      const dispatcher = createAgentDispatcher({ store, eventBus, expertRuntime });

      const dispatched = await dispatcher.dispatchAgent({
        flowId: flow.id,
        taskId: task.id,
        expertId,
        prompt: "Inspect and report",
        resumeAgentSessionId: "",
      });
      await completion;

      expect(dispatched.status).toBe("queued");
      expect(store.getTask(task.id)?.status).toBe("in_progress");
      expect(store.getAgentSession(dispatched.agent_session_id)?.status).toBe("completed");
    },
  );
});

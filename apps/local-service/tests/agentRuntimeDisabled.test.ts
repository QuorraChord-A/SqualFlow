import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";
import { beginUserTurn, createWorkingUserTurn } from "./helpers/userTurnTestHelpers.js";

const dirs: string[] = [];
const stores: Array<{ sqlite: { close: () => void } }> = [];
let previousConfigRoot: string | undefined;

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
      leader: { enabled: true, configId: "default-agent-sdk" },
      coder: { enabled: true, configId: "default-agent-sdk" },
      research: { enabled: false, configId: "default-agent-sdk" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "default-agent-sdk.json"), `${JSON.stringify({
    id: "default-agent-sdk",
    fileName: "default-agent-sdk.json",
    name: "Default",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models: [{ id: "model-1", name: "model-1" }],
  }, null, 2)}\n`);
}

async function createIsolatedStore() {
  vi.resetModules();
  const root = tempDir("squadflow-disabled-runtime-config-");
  writeRuntimeConfig(root);
  process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT = root;

  const { createStore } = await import("../src/db/store.js");
  const store = createStore(path.join(tempDir("squadflow-disabled-db-"), "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

beforeEach(() => {
  previousConfigRoot = process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT;
});

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT;
  else process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT = previousConfigRoot;
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("disabled runtime experts", () => {
  it("shows every expert and includes runtime enabled status in flow context", async () => {
    const store = await createIsolatedStore();
    const { createStorePort } = await import("../src/mcp/storePort.js");
    const flow = store.createFlow({
      id: "flow-context",
      workspaceId: "ws-default",
      name: "Context",
      description: "",
      projectId: null,
    });

    const snapshot = createStorePort(store).getContext(flow.id)! as {
      experts: Array<{ expert_id: string; runtime_role: string; enabled: boolean; disabled_reason: string | null }>;
    };

    expect(snapshot.experts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        expert_id: "exp-research",
        runtime_role: "research",
        enabled: false,
        disabled_reason: "runtime_role_disabled",
      }),
      expect.objectContaining({
        expert_id: "exp-coder",
        runtime_role: "coder",
        enabled: true,
        disabled_reason: null,
      }),
    ]));
  });

  it("rejects dispatch to a disabled expert before creating an agent session", async () => {
    const store = await createIsolatedStore();
    const { createAgentDispatcher } = await import("../src/runtime/agentDispatcher.js");
    const { EventBus } = await import("../src/ws/eventBus.js");
    const flow = store.createFlow({
      id: "flow-dispatch",
      workspaceId: "ws-default",
      name: "Dispatch",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Research",
      description: "Research",
      expertId: "exp-research",
      dependsOnTaskIds: [],
    })!;
    const runTask = vi.fn(async () => undefined);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: { runTask },
    });

    await expect(dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      expertId: "exp-research",
      prompt: "Research",
      resumeAgentSessionId: "",
    })).resolves.toEqual({
      agent_session_id: "",
      status: "failed",
      error: "expert is disabled",
    });
    expect(runTask).not.toHaveBeenCalled();
    expect(store.listAgentSessions(flow.id)).toHaveLength(0);
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "pending",
      agentSessionId: null,
    }));
  });

  it("maps disabled expert dispatch errors for the Leader MCP tool", async () => {
    const store = await createIsolatedStore();
    const { createStorePort } = await import("../src/mcp/storePort.js");
    const flow = store.createFlow({ id: "flow-any", name: "Any", description: "", projectId: null });
    const userTurn = beginUserTurn(store, { flowId: flow.id })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Research",
      description: "Research",
      expertId: "exp-research",
      dependsOnTaskIds: [],
    })!;
    const port = createStorePort(store, {
      dispatchAgent: async () => ({ agent_session_id: "", status: "failed", error: "expert is disabled" }),
      sendMessage: async () => ({ accepted: false }),
    });

    await expect(port.dispatchAgent({
      flowId: "flow-any",
      taskId: task.id,
      expertId: "exp-research",
      prompt: "Research",
      resumeAgentSessionId: "",
      currentTurnInput: {
        trigger_kind: "user_message",
        user_turn_id: userTurn.id,
        created_at: new Date().toISOString(),
      },
    })).resolves.toEqual({
      ok: false,
      error: { code: "EXPERT_DISABLED", message: "expert is disabled" },
    });
  });

  it("records the failed execution without changing Task state if a disabled expert reaches runtime directly", async () => {
    const store = await createIsolatedStore();
    const { createExpertRuntime } = await import("../src/runtime/expertRuntime.js");
    const { ChatJournal } = await import("../src/ws/chatJournal.js");
    const { EventBus } = await import("../src/ws/eventBus.js");
  const flow = store.createFlow({
    id: "flow-runtime",
    name: "Runtime",
    description: "",
    projectId: store.createProject({ name: "Runtime Project", localPath: tempDir("squadflow-runtime-project-") }).id,
  });
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Research",
      description: "Research",
      expertId: "exp-research",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-research",
      displayName: "Research",
      status: "streaming",
    });
    store.startTask(task.id, session.id);
    const finished: unknown[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      onTaskFinished: (event: unknown) => finished.push(event),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: vi.fn(() => {
        throw new Error("query should not start");
      }) }),
    });

    await expect(runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    })).resolves.toBeUndefined();

    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "in_progress",
      errorMessage: null,
      resultJson: null,
    }));
    expect(store.getAgentSession(session.id)).toEqual(expect.objectContaining({ status: "failed" }));
    expect(finished).toEqual([
      expect.objectContaining({
        agentSessionId: session.id,
        expertId: "exp-research",
        status: "failed",
        error: "Runtime role is disabled: research",
      }),
    ]);
  });
});

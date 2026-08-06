import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createExpertTaskMcpServer,
  createExpertTaskToolHandlers,
  type ExpertTask,
  type ExpertTaskActorScope,
  type ExpertTaskStorePort,
} from "../src/mcp/expertTaskServer.js";

function jsonResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

const actor: ExpertTaskActorScope = {
  flowId: "flow-a",
  flowExpertId: "fexp-coder-a",
  agentSessionId: "ags-coder-a",
};

function task(overrides: Partial<ExpertTask> = {}): ExpertTask {
  return {
    task_id: "task-a",
    work_run_id: "utn-a",
    subject: "Build the feature",
    description: "Implement and verify the feature.",
    active_form: "Implementing the feature",
    assignment: {
      expert_id: "exp-coder",
      flow_expert_id: actor.flowExpertId,
      display_name: "阿码",
    },
    status: "in_progress",
    dependency_task_ids: ["task-dependency"],
    acceptance_criteria: ["Tests pass"],
    progress: "Located the affected component.",
    result: null,
    error_message: null,
    revision: 4,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:01:00.000Z",
    ...overrides,
  };
}

function fakeStore(overrides: Partial<ExpertTaskStorePort> = {}): ExpertTaskStorePort {
  return {
    listMyTasks: () => [task()],
    getMyTask: ({ taskId }) => task({ task_id: taskId }),
    updateMyTask: (input) => ({
      ok: true,
      task: task({
        task_id: input.taskId,
        subject: input.subject ?? "Build the feature",
        description: input.description ?? "Implement and verify the feature.",
        active_form: input.activeForm ?? "Implementing the feature",
        progress: input.progress === undefined ? "Located the affected component." : input.progress,
        result: input.result === undefined ? null : input.result,
        error_message: input.errorMessage === undefined ? null : input.errorMessage,
        status: input.status ?? "in_progress",
        revision: 5,
      }),
    }),
    ...overrides,
  };
}

async function withClient(
  store: ExpertTaskStorePort,
  context: { getActorScope: () => ExpertTaskActorScope | null } = { getActorScope: () => actor },
  run: (client: Client) => Promise<void>,
) {
  const server = createExpertTaskMcpServer(createExpertTaskToolHandlers(store, context));
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("expert task MCP server", () => {
  it("exposes only the three scoped Task tools", async () => {
    await withClient(fakeStore(), undefined, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_my_task",
        "list_my_tasks",
        "update_my_task",
      ]);
      expect(tools.tools.map((tool) => tool.name)).not.toContain("get_context");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("update_task");
    });
  });

  it("derives list scope from the active Expert session", async () => {
    const listMyTasks = vi.fn<ExpertTaskStorePort["listMyTasks"]>(() => [task()]);
    await withClient(fakeStore({ listMyTasks }), undefined, async (client) => {
      const result = jsonResult(await client.callTool({ name: "list_my_tasks", arguments: {} }) as any);
      expect(result).toEqual({ ok: true, tasks: [task()] });
    });
    expect(listMyTasks).toHaveBeenCalledWith(actor);
  });

  it("returns complete read-only Task context for an assigned task", async () => {
    await withClient(fakeStore(), undefined, async (client) => {
      const result = jsonResult(await client.callTool({ name: "get_my_task", arguments: { task_id: "task-a" } }) as any);
      expect(result).toEqual({ ok: true, task: task() });
    });
  });

  it("does not pass a model-supplied FlowExpert or Flow scope to the store", async () => {
    const getMyTask = vi.fn<ExpertTaskStorePort["getMyTask"]>(() => task());
    const handlers = createExpertTaskToolHandlers(fakeStore({ getMyTask }), { getActorScope: () => actor });

    await expect(handlers.getMyTask({ task_id: "task-a", flow_expert_id: "fexp-other" } as any)).rejects.toThrow();
    expect(getMyTask).not.toHaveBeenCalled();
  });

  it("updates only permitted collaboration, progress, result, and explicit status fields", async () => {
    const updateMyTask = vi.fn<ExpertTaskStorePort["updateMyTask"]>((input) => ({
      ok: true,
      task: task({
        task_id: input.taskId,
        description: input.description ?? "Implement and verify the feature.",
        progress: input.progress ?? null,
        result: input.result ?? null,
        status: input.status ?? "in_progress",
        revision: 5,
      }),
    }));
    await withClient(fakeStore({ updateMyTask }), undefined, async (client) => {
      const result = jsonResult(await client.callTool({
        name: "update_my_task",
        arguments: {
          task_id: "task-a",
          expected_revision: 4,
          description: "Implemented the component; verifying now.",
          progress: "Validation running.",
          result: { files_changed: ["app.tsx"] },
          status: "completed",
        },
      }) as any);
      expect(result).toEqual(expect.objectContaining({ ok: true, task: expect.objectContaining({ revision: 5, status: "completed" }) }));
    });
    expect(updateMyTask).toHaveBeenCalledWith({
      ...actor,
      taskId: "task-a",
      expectedRevision: 4,
      subject: undefined,
      description: "Implemented the component; verifying now.",
      activeForm: undefined,
      progress: "Validation running.",
      result: { files_changed: ["app.tsx"] },
      errorMessage: undefined,
      status: "completed",
    });
  });

  it("does not permit Expert reopening, dispatch, or cancellation states", async () => {
    const handlers = createExpertTaskToolHandlers(fakeStore(), { getActorScope: () => actor });
    for (const status of ["pending", "in_progress", "cancelled"]) {
      await expect(handlers.updateMyTask({ task_id: "task-a", status } as any)).rejects.toThrow();
    }
  });

  it("does not accept assignment, dependency, Flow, or session mutations", async () => {
    const handlers = createExpertTaskToolHandlers(fakeStore(), { getActorScope: () => actor });
    for (const mutation of [
      { owner: "exp-other" },
      { flow_id: "flow-other" },
      { flow_expert_id: "fexp-other" },
      { dependency_task_ids: ["task-other"] },
      { agent_session_id: "ags-other" },
    ]) {
      await expect(handlers.updateMyTask({ task_id: "task-a", ...mutation } as any)).rejects.toThrow();
    }
  });

  it("surfaces the store's revision conflict without broadening scope", async () => {
    const updateMyTask = vi.fn<ExpertTaskStorePort["updateMyTask"]>(() => ({
      ok: false,
      error: { code: "TASK_REVISION_CONFLICT", message: "Task changed; reload it before updating." },
    }));
    await withClient(fakeStore({ updateMyTask }), undefined, async (client) => {
      const result = jsonResult(await client.callTool({
        name: "update_my_task",
        arguments: { task_id: "task-a", expected_revision: 3, progress: "Still working." },
      }) as any);
      expect(result).toEqual({
        ok: false,
        error: { code: "TASK_REVISION_CONFLICT", message: "Task changed; reload it before updating." },
      });
    });
    expect(updateMyTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: actor.flowId,
      flowExpertId: actor.flowExpertId,
      agentSessionId: actor.agentSessionId,
      taskId: "task-a",
      expectedRevision: 3,
    }));
  });

  it("rejects calls when there is no active authenticated Expert session", async () => {
    const store = fakeStore({
      listMyTasks: vi.fn(() => [task()]),
    });
    await withClient(store, { getActorScope: () => null }, async (client) => {
      const result = jsonResult(await client.callTool({ name: "list_my_tasks", arguments: {} }) as any);
      expect(result).toEqual({
        ok: false,
        error: { code: "EXPERT_CONTEXT_UNAVAILABLE", message: "Task tools require an active Expert session." },
      });
    });
    expect(store.listMyTasks).not.toHaveBeenCalled();
  });
});

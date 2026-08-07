import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/agentRuntimeConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/agentRuntimeConfig.js")>();
  return {
    ...actual,
    readAgentRuntimeConfigSnapshot: vi.fn(async () => ({
      roles: [
        { role: "leader", enabled: true, configId: "test", modelId: "model", reasoningEffort: "high" },
        { role: "coder", enabled: true, configId: "test", modelId: "model", reasoningEffort: "high" },
        { role: "research", enabled: true, configId: "test", modelId: "model", reasoningEffort: "high" },
        { role: "verify", enabled: true, configId: "test", modelId: "model", reasoningEffort: "high" },
        { role: "codereview", enabled: true, configId: "test", modelId: "model", reasoningEffort: "high" },
      ],
      configs: [],
    })),
  };
});

import { createStore, type Store } from "../src/db/store.js";
import { createAgentDispatcher } from "../src/runtime/agentDispatcher.js";
import { EventBus } from "../src/ws/eventBus.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

describe("Supervisor Agent dispatcher", () => {
  it("lets Leader choose a new dispatch or reuse an existing Expert Session", async () => {
    const store = createStore(":memory:");
    stores.push(store);
    store.migrate();
    const project = store.createProject({ id: "project", name: "项目", localPath: "/tmp" });
    const flow = store.createFlow({ id: "flow", projectId: project.id, name: "Agent 身份" })!;
    const leader = store.getLeaderAgentSession(flow.id)!;
    const leaderRun = store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id, status: "running" })!;
    const task = store.createTask({
      flowId: flow.id,
      title: "修复配置",
      description: "修复重启丢失",
      createdByAgentRunId: leaderRun.id,
    })!;
    const runTask = vi.fn(() => new Promise<never>(() => undefined));
    const runConversation = vi.fn(() => new Promise<never>(() => undefined));
    const sendMessage = vi.fn(() => true);
    const cancelAgent = vi.fn(async () => true);
    const dispatcher = createAgentDispatcher({
      store,
      eventBus: new EventBus(),
      expertRuntime: { runTask, runConversation, sendMessage, cancelAgent } as any,
    });

    const first = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      agentDefinitionId: "exp-coder",
      prompt: "先实现",
    });
    expect(first.agent_session_id).toBeTruthy();
    const guided = await dispatcher.sendMessage({
      flowId: flow.id,
      agentSessionId: first.agent_session_id!,
      taskId: task.id,
      message: "把存储改为按项目隔离",
    });
    expect(guided.agent_run_id).toBe(first.agent_run_id);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: first.agent_run_id }));

    store.updateAgentRunStatus(first.agent_run_id, "running");
    store.updateAgentRunStatus(first.agent_run_id, "completed");
    store.updateAgentSessionProviderSession(first.agent_session_id!, "provider-session-1");
    const reused = await dispatcher.sendMessage({
      flowId: flow.id,
      agentSessionId: first.agent_session_id!,
      taskId: task.id,
      message: "继续处理新任务",
    });
    expect(reused.agent_run_id).not.toBe(first.agent_run_id);
    expect(store.getAgentRun(reused.agent_run_id!)?.agentSessionId).toBe(first.agent_session_id);
    expect(runConversation).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: "provider-session-1" }));

    store.updateAgentRunStatus(reused.agent_run_id!, "running");
    store.updateAgentRunStatus(reused.agent_run_id!, "completed");
    const redispatched = await dispatcher.dispatchAgent({
      flowId: flow.id,
      taskId: task.id,
      agentDefinitionId: "exp-coder",
      prompt: "这次重新找一位开发",
    });
    expect(redispatched.agent_session_id).not.toBe(first.agent_session_id);
    expect(store.listAgentSessions(flow.id).filter((session) => session.role === "expert")).toHaveLength(2);
    expect(store.getTask(task.id)?.status).toBe("pending");

    const cancelled = await dispatcher.cancelAgent({ flowId: flow.id, agentSessionId: redispatched.agent_session_id! });
    const duplicate = await dispatcher.cancelAgent({ flowId: flow.id, agentSessionId: redispatched.agent_session_id! });
    expect(cancelled).toEqual(expect.objectContaining({ ok: true, idempotent: false }));
    expect(duplicate).toEqual(expect.objectContaining({ ok: true, idempotent: true }));
  });
});

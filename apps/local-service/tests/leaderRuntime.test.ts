import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeQueryInput, ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { config } from "../src/config.js";
import type { RuntimeSdk } from "../src/config/agentRuntimeConfig.js";
import { parseMessageSegments } from "../src/protocol/platformEvent.js";
import { createStore } from "../src/db/store.js";
import { beginUserTurn } from "./helpers/userTurnTestHelpers.js";
import { captureUserTurnBaseline } from "../src/runtime/userTurnDiff.js";
import { createExpertRuntime } from "../src/runtime/expertRuntime.js";
import { createLeaderRuntime, leaderRuntimeTestExports } from "../src/runtime/leaderRuntime.js";
import { createStorePort } from "../src/mcp/storePort.js";
import { DesktopBridge } from "../src/server/desktopBridge.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";
import {
  resetQueryLifecycleTimeoutsForTests,
  setQueryLifecycleTimeoutsForTests,
  ZERO_PROGRESS_ERROR_MESSAGE,
} from "../src/runtime/queryLifecyclePolicy.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-leader-runtime-"));
  dirs.push(dir);
  const runtimeConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-leader-runtime-config-"));
  dirs.push(runtimeConfigRoot);
  writeRuntimeConfig(runtimeConfigRoot);
  config.agentRuntimeConfigRoot = runtimeConfigRoot;
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

function writeRuntimeConfig(root: string) {
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
    version: 1,
    roles: {
      leader: { enabled: true, configId: "default-agent-sdk" },
      frontend: { enabled: true, configId: "default-agent-sdk" },
      backend: { enabled: true, configId: "default-agent-sdk" },
      research: { enabled: true, configId: "default-agent-sdk" },
      verify: { enabled: true, configId: "default-agent-sdk" },
      codereview: { enabled: true, configId: "default-agent-sdk" },
    },
  }, null, 2)}\n`);
  writeRuntimeConfigFile(root, "default-agent-sdk", "claudecode");
}

function writeRuntimeConfigFile(
  root: string,
  configId: string,
  sdk: RuntimeSdk,
  models = [{ id: "model-1", name: "model-1", contextWindowK: 200 }],
) {
  fs.writeFileSync(path.join(root, "configs", `${configId}.json`), `${JSON.stringify({
    id: configId,
    fileName: `${configId}.json`,
    name: configId,
    sdk,
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models,
  }, null, 2)}\n`);
}

function switchAllRolesRuntimeConfig(root: string, configId: string, sdk: RuntimeSdk) {
  writeRuntimeConfigFile(root, configId, sdk);
  fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
    version: 1,
    roles: {
      leader: { enabled: true, configId },
      frontend: { enabled: true, configId },
      backend: { enabled: true, configId },
      research: { enabled: true, configId },
      verify: { enabled: true, configId },
      codereview: { enabled: true, configId },
    },
  }, null, 2)}\n`);
}

function createQuery(messages: unknown[]): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    close() {},
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createContextUsageQuery(messages: AsyncIterable<unknown> | unknown[]): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const message of messages) yield message;
    },
    close() {},
    async getContextUsage() {
      return {
        totalTokens: 10_100,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 5.05,
        model: "claude-sonnet",
        categories: [{ name: "Messages", tokens: 10_100, color: "#22c55e" }],
        gridRows: [],
        memoryFiles: [],
        mcpTools: [],
      };
    },
  };
}

async function firstPromptText(input: ClaudeQueryInput | null): Promise<string> {
  if (!input) return "";
  if (typeof input.prompt === "string") return input.prompt;
  const iterator = input.prompt[Symbol.asyncIterator]();
  const next = await iterator.next();
  await iterator.return?.();
  const content = next.value?.message.content;
  const firstBlock = Array.isArray(content) ? content[0] : undefined;
  return firstBlock?.type === "text" ? firstBlock.text : "";
}

async function firstPromptContent(input: ClaudeQueryInput | null): Promise<unknown[]> {
  if (!input || typeof input.prompt === "string") return [];
  const iterator = input.prompt[Symbol.asyncIterator]();
  const next = await iterator.next();
  await iterator.return?.();
  const content = next.value?.message.content;
  return Array.isArray(content) ? content : [];
}

function createFlowLeader(
  store: ReturnType<typeof createStore>,
  flowId = "flow-1",
  sessionId: string | null = "leader-session-1",
) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-leader-project-"));
  dirs.push(projectRoot);
  const project = store.createProject({ name: "Leader Runtime Project", localPath: projectRoot });
  const flow = store.createFlow({
    id: flowId,
    workspaceId: "ws-default",
    name: "Hello",
    description: "",
    projectId: project.id,
    leaderRuntimeConfigId: "default-agent-sdk",
    leaderRuntimeModelId: "model-1",
  });
  const leader = store.createAgentSession({
    flowId: flow.id,
    userTurnId: null,
    taskId: null,
    expertId: "exp-leader",
    sessionId,
    displayName: "Leader",
  });
  return { flow, leader };
}

afterEach(() => {
  resetQueryLifecycleTimeoutsForTests();
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LeaderRuntime platform event protocol", () => {
  it("keeps local AgentSession IDs out of provider options when multiple Flows start concurrently", async () => {
    const store = tempStore();
    const first = createFlowLeader(store, "flow-concurrent-a", null);
    const second = createFlowLeader(store, "flow-concurrent-b", null);
    store.updateFlow(first.flow.id, { leaderSessionId: first.leader.id });
    store.updateFlow(second.flow.id, { leaderSessionId: second.leader.id });
    const providerSessionIds = ["sdk-flow-concurrent-a", "sdk-flow-concurrent-b"];
    const capturedOptions: Array<ClaudeQueryInput["options"]> = [];
    let queryIndex = 0;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        const providerSessionId = providerSessionIds[queryIndex++]!;
        capturedOptions.push(input.options);
        return createQuery([
          { type: "system", subtype: "init", session_id: providerSessionId },
          { type: "result", subtype: "success", session_id: providerSessionId, is_error: false },
        ]);
      } }),
    });

    await Promise.all([
      runtime.runLeaderTurn({
        flowId: first.flow.id,
        kind: "user",
        userMessage: "并发 Flow A",
        leaderAgentSessionId: first.leader.id,
        leaderSessionId: first.leader.id,
      }),
      runtime.runLeaderTurn({
        flowId: second.flow.id,
        kind: "user",
        userMessage: "并发 Flow B",
        leaderAgentSessionId: second.leader.id,
        leaderSessionId: second.leader.id,
      }),
    ]);

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions.every((options) => options?.sessionId === undefined)).toBe(true);
    expect(capturedOptions.every((options) => options?.resume === undefined)).toBe(true);
    const persistedProviderSessionIds = [
      store.getAgentSession(first.leader.id)?.sessionId,
      store.getAgentSession(second.leader.id)?.sessionId,
    ];
    expect(new Set(persistedProviderSessionIds)).toEqual(new Set(providerSessionIds));
    expect(store.getFlow(first.flow.id)?.leaderSessionId).toBe(store.getAgentSession(first.leader.id)?.sessionId);
    expect(store.getFlow(second.flow.id)?.leaderSessionId).toBe(store.getAgentSession(second.leader.id)?.sessionId);
  });

  it("tells Leader that permission confirmations do not time out", () => {
    const store = tempStore();
    const { flow } = createFlowLeader(store);
    const prompt = leaderRuntimeTestExports.withRuntimeEnvironmentNote("leader", "/tmp/project", flow.id);
    expect(prompt).toContain("风险确认卡没有超时机制");
    expect(prompt).toContain("不得描述为权限确认超时");
    expect(prompt).toContain("<squadflow type=\"...\"");
    expect(prompt).toMatch(/本会话平台事件签名:[0-9a-f]{8}/u);
  });

  it("encodes a resumed clarification answer as one decision event", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-spec-request",
      specRequested: true,
    })!;
    store.pauseUserTurnForUserAction(userTurn.id);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (query) => {
        captured = query;
        return createQuery([{ type: "result", subtype: "success", session_id: "sdk-leader-spec-resume", is_error: false }]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "decision",
      userTurnId: userTurn.id,
      decisionCardId: "dc-spec-clarification",
      decisionAnswers: { scope: "当前项目" },
      decisionUserMessage: "用户已确认范围。",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const segments = parseMessageSegments(await firstPromptText(captured), flow.id);
    expect(segments).toEqual([
      expect.objectContaining({
        kind: "event",
        type: "decision_answered",
        body: "scope: 当前项目\n用户已确认范围。",
      }),
    ]);
  });

  it("keeps a legacy started Leader session on claudecode after the role config changes", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    store.updateFlow(flow.id, {
      leaderSessionId: "legacy-leader-sdk",
      leaderRuntimeSdk: null,
      leaderRuntimeConfigId: null,
      leaderRuntimeModelId: null,
    });
    store.updateAgentSessionSession(leader.id, "legacy-leader-sdk");
    switchAllRolesRuntimeConfig(config.agentRuntimeConfigRoot, "codex-agent-sdk", "codex");

    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () =>
        createQuery([{ type: "result", subtype: "success", session_id: "legacy-leader-sdk", is_error: false }]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "继续旧会话",
      leaderAgentSessionId: leader.id,
      leaderSessionId: "legacy-leader-sdk",
      resumeSessionId: "legacy-leader-sdk",
    });

    expect(store.getFlow(flow.id)).toEqual(expect.objectContaining({
      leaderRuntimeSdk: "claudecode",
      leaderRuntimeConfigId: "default-agent-sdk",
      leaderRuntimeModelId: "model-1",
    }));
    expect(store.getAgentSession(leader.id)).toEqual(expect.objectContaining({
      runtimeSdk: "claudecode",
      runtimeConfigId: "default-agent-sdk",
      runtimeModelId: "model-1",
    }));
  });

  it("uses an updated same-SDK provider and model on the next Leader turn", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    writeRuntimeConfigFile(config.agentRuntimeConfigRoot, "bailian", "claudecode", [
      { id: "model-2", name: "qwen3.7-plus" },
    ]);
    store.updateFlow(flow.id, {
      leaderRuntimeSdk: "claudecode",
      leaderRuntimeConfigId: "bailian",
      leaderRuntimeModelId: "model-2",
    });
    let selectedRuntimeConfigId: string | null = null;
    const testAdapterFactory = createClaudeTestAdapterFactory({ leaderQuery: () =>
      createQuery([{ type: "result", subtype: "success", session_id: "leader-session-1", is_error: false }]) });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: (input) => {
        selectedRuntimeConfigId = input.runtimeConfig?.id ?? null;
        return testAdapterFactory(input);
      },
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "使用新模型继续",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
      resumeSessionId: leader.sessionId,
    });

    expect(selectedRuntimeConfigId).toBe("bailian");
    expect(store.getAgentSession(leader.id)).toEqual(expect.objectContaining({
      sessionId: "leader-session-1",
      runtimeSdk: "claudecode",
      runtimeConfigId: "bailian",
      runtimeModelId: "model-2",
    }));
  });

  it("sends raw user text and an attachment event before native SDK image blocks", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([{ type: "result", subtype: "success", session_id: "sdk-image-session", is_error: false }]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "你好早上好",
      attachments: [{
        id: "img-1",
        kind: "image",
        media_type: "image/png",
        data: "iVBORw0KGgo=",
        name: "pasted.png",
        text_offset: 2,
      }],
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const content = await firstPromptContent(captured);
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "你好早上好" });
    expect(content[1]).toEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("<squadflow type=\"attachment\""),
    }));
    expect(content[1]?.type === "text" ? parseMessageSegments(content[1].text.trim(), flow.id) : []).toEqual([
      expect.objectContaining({ kind: "event", type: "attachment", body: expect.stringContaining("pasted.png") }),
    ]);
    expect(content[2]).toEqual(expect.objectContaining({
      type: "image",
      source: expect.objectContaining({
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo=",
      }),
    }));
  });

  it("persists the latest live context usage snapshot for the Leader session", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => createContextUsageQuery((async function* () {
        if (typeof input.prompt === "string") throw new Error("expected streaming input");
        const messages = input.prompt[Symbol.asyncIterator]();
        await messages.next();
        yield {
          type: "result",
          subtype: "success",
          session_id: "sdk-leader-context",
          is_error: false,
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 0,
          },
        };
      })()) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "查上下文",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    // Overall occupancy = input + cache_read + cache_creation (not getContextUsage control channel).
    expect(store.getAgentContextUsageSnapshot(leader.id)).toEqual(expect.objectContaining({
      flowId: flow.id,
      agentSessionId: leader.id,
      sdkSessionId: "sdk-leader-context",
      role: "leader",
      expertId: "exp-leader",
      totalTokens: 100,
      maxTokens: 200_000,
      percentage: 0.05,
      cacheInputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
    }));
  });

  it("cancels a Leader turn while its runtime stream is still being prepared", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const prepareStarted = deferred<void>();
    const releasePrepare = deferred<void>();
    const capturedQueries: ClaudeQueryInput[] = [];
    const leaderQuery = vi.fn((query: ClaudeQueryInput) => {
      capturedQueries.push(query);
      return createQuery([
        { type: "result", subtype: "success", session_id: "leader-session-1", is_error: false },
      ]);
    });
    const baseFactory = createClaudeTestAdapterFactory({ leaderQuery });
    let prepareCount = 0;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: (factoryInput) => {
        const adapter = baseFactory(factoryInput);
        return {
          ...adapter,
          prepareLeaderMcpServer: async (input) => {
            prepareCount += 1;
            if (prepareCount === 1) {
              prepareStarted.resolve();
              await releasePrepare.promise;
            }
            return adapter.prepareLeaderMcpServer(input);
          },
        };
      },
    });

    const runningTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "启动后立即中断",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await prepareStarted.promise;

    const cancelled = runtime.cancelFlow(flow.id);
    let compactSettled = false;
    const compact = runtime.compactContext(flow.id).finally(() => {
      compactSettled = true;
    });
    await Promise.resolve();
    expect(compactSettled).toBe(false);
    releasePrepare.resolve();
    await Promise.all([runningTurn, compact]);

    expect(cancelled).toBe(true);
    expect(leaderQuery).toHaveBeenCalledTimes(1);
    expect(await firstPromptText(capturedQueries[0] ?? null)).toBe("/compact");
    expect(store.getAgentSession(leader.id)?.status).not.toBe("streaming");
  });

  it("does not start a queued Leader turn after cancelling the previous closing stream", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const firstUserTurn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-first",
    })!;
    const releaseFirstQuery = deferred<void>();
    const leaderQuery = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", session_id: "leader-session-1", is_error: false };
        await releaseFirstQuery.promise;
      },
      close() {
        releaseFirstQuery.resolve();
      },
    }));
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userTurnId: firstUserTurn.id,
      userMessage: "第一轮",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    const secondUserTurn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-second",
    })!;
    const secondTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userTurnId: secondUserTurn.id,
      userMessage: "第二轮立即中断",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const cancelled = (runtime.cancelFlow as (flowId: string, userTurnId: string) => boolean)(flow.id, secondUserTurn.id);
    await secondTurn;

    expect(cancelled).toBe(true);
    expect(leaderQuery).toHaveBeenCalledTimes(1);
    expect(store.getUserTurn(secondUserTurn.id)?.status).toBe("active");
  });

  it("compacts an idle Leader SDK session and persists the refreshed context snapshot", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", session_id: "leader-session-1", is_error: false };
          },
          close() {},
          async getContextUsage() {
            return {
              totalTokens: 2_000,
              maxTokens: 200_000,
              rawMaxTokens: 200_000,
              percentage: 1,
              model: "claude-sonnet",
              categories: [],
              gridRows: [],
              memoryFiles: [],
              mcpTools: [],
            };
          },
        };
      } }),
    });

    const snapshot = await runtime.compactContext(flow.id);

    expect(await firstPromptText(captured)).toBe("/compact");
    expect(captured?.options?.resume).toBe("leader-session-1");
    expect(captured?.options?.mcpServers).toEqual({});
    expect(captured?.options?.canUseTool).toBeUndefined();
    expect(captured?.options?.tools).toEqual([]);
    expect(captured?.options?.allowedTools).toEqual([]);
    expect(snapshot).toEqual(expect.objectContaining({
      totalTokens: 2_000,
      maxTokens: 200_000,
      percentage: 1,
      compacted: true,
    }));
    expect(store.getAgentContextUsageSnapshot(leader.id)).toEqual(expect.objectContaining({
      flowId: flow.id,
      agentSessionId: leader.id,
      sdkSessionId: "leader-session-1",
      role: "leader",
      expertId: "exp-leader",
      totalTokens: 2_000,
      maxTokens: 200_000,
      percentage: 1,
      compacted: 1,
    }));
  });

  it("uses compact boundary token metadata when post-compact context usage is unavailable", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: leader.id,
      sdkSessionId: leader.sessionId,
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 12_343,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 6,
      model: "claude-sonnet",
      categories: [{ name: "Messages", tokens: 12_343, color: "#8a8a8a", isDeferred: false }],
      observedAt: "2026-06-28T10:00:00.000Z",
    });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 12_891, postTokens: 810 },
        },
      ]) }),
    });

    const snapshot = await runtime.compactContext(flow.id);

    expect(snapshot).toEqual(expect.objectContaining({
      totalTokens: 810,
      maxTokens: 200_000,
      model: "claude-sonnet",
      compacted: true,
      categories: [{ name: "Messages", tokens: 12_343, color: "#8a8a8a", isDeferred: false }],
    }));
    expect(snapshot?.percentage).toBeCloseTo(0.405);
    expect(store.getAgentContextUsageSnapshot(leader.id)).toEqual(expect.objectContaining({
      totalTokens: 810,
      compacted: 1,
    }));
    expect(store.getAgentContextUsageSnapshot(leader.id)?.categoriesJson).toContain("Messages");
    expect(store.getAgentContextUsageSnapshot(leader.id)?.percentage).toBeCloseTo(0.405);
  });

  it("uses one streaming query to process queued Flow turns in order", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const prompts: string[] = [];
    let queryCount = 0;
    let signalFirstInput!: () => void;
    const firstInput = new Promise<void>((resolve) => { signalFirstInput = resolve; });
    let releaseFirstTurn!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          queryCount += 1;
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          const first = await messages.next();
          const firstContent = Array.isArray(first.value?.message.content) ? first.value.message.content[0] : undefined;
          prompts.push(firstContent?.type === "text" ? firstContent.text : "");
          signalFirstInput();
          await release;
          yield { type: "result", subtype: "success", session_id: "sdk-leader-stream", is_error: false };

          const second = await messages.next();
          const secondContent = Array.isArray(second.value?.message.content) ? second.value.message.content[0] : undefined;
          prompts.push(secondContent?.type === "text" ? secondContent.text : "");
          yield { type: "result", subtype: "success", session_id: "sdk-leader-stream", is_error: false };
        },
        close() {},
      }) }),
    });

    const firstTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "先处理第一条",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await firstInput;
    const secondTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "decision",
      decisionCardId: "dc-1",
      decisionAnswers: { language: "TypeScript" },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    releaseFirstTurn();
    await Promise.all([firstTurn, secondTurn]);

    expect(queryCount).toBe(1);
    expect(prompts[0]).toBe("先处理第一条");
    expect(parseMessageSegments(prompts[1] ?? "", flow.id)).toEqual([
      expect.objectContaining({ kind: "event", type: "decision_answered", body: "language: TypeScript" }),
    ]);
  });

  it("runs the first Flow name generation after the visible turn and keeps it out of transcript output", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    store.updateFlow(flow.id, { nameGenerationStatus: "pending" });
    const prompts: string[] = [];
    const namerOptions: Record<string, unknown>[] = [];
    const transcriptEvents: unknown[] = [];
    const nameUpdates: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "flow-name-test", (event) => {
      if (event.type === "session:transcript_event") transcriptEvents.push(event);
      if (event.type === "flow:name_updated") nameUpdates.push(event);
    });
    const runtime = createLeaderRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          const ephemeral = typeof input.options === "object"
            && input.options !== null
            && "persistSession" in input.options
            && input.options.persistSession === false;
          if (ephemeral) {
            namerOptions.push(input.options as Record<string, unknown>);
            const messages = input.prompt[Symbol.asyncIterator]();
            const namingMessage = await messages.next();
            const namingContent = Array.isArray(namingMessage.value?.message.content) ? namingMessage.value.message.content[0] : undefined;
            prompts.push(namingContent?.type === "text" ? namingContent.text : "");
            yield { type: "assistant", message: { content: [{ type: "text", text: "登录页面" }] } };
            yield { type: "result", subtype: "success", session_id: "sdk-flow-name", is_error: false };
            return;
          }
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          const first = await messages.next();
          const firstContent = Array.isArray(first.value?.message.content) ? first.value.message.content[0] : undefined;
          prompts.push(firstContent?.type === "text" ? firstContent.text : "");
          yield { type: "result", subtype: "success", session_id: "sdk-flow-name", is_error: false };
        },
        close() {},
      }) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "实现一个登录页面",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(prompts[0]).toBe("实现一个登录页面");
    await vi.waitFor(() => expect(prompts[1]).toContain("首条用户需求"));
    await vi.waitFor(() => expect(store.getFlow(flow.id)?.nameGenerationStatus).toBe("generated"));
    expect(store.getFlow(flow.id)?.name).toBe("登录页面");
    expect(namerOptions[0]).toMatchObject({
      persistSession: false,
      thinking: { type: "disabled" },
    });
    expect(nameUpdates).toHaveLength(1);
    expect(transcriptEvents.every((event) => JSON.stringify(event).includes("flow_name_request") === false)).toBe(true);
  });

  it("closes a completed streaming query so the runtime lease can be reused", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const close = vi.fn();
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", session_id: "sdk-reusable-leader", is_error: false };
        },
        close,
      }) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "完成后释放运行时租约",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("fails a stuck Leader turn when the SDK produces no progress events", async () => {
    setQueryLifecycleTimeoutsForTests({ zeroProgressMs: 40 });
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const close = vi.fn();
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({
        leaderQuery: () => ({
          async *[Symbol.asyncIterator]() {
            // Never yields — reproduces a dead query after the user message was accepted.
            await new Promise(() => {});
          },
          close,
        }),
      }),
    });

    await expect(runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "这句话会卡住",
      userTurnId: userTurn.id,
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    })).rejects.toThrow(ZERO_PROGRESS_ERROR_MESSAGE);

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(store.getUserTurn(userTurn.id)?.status).toBe("failed");
    expect(store.getAgentSession(leader.id)?.status).toBe("failed");
  });

  it("starts the next Leader turn even when prior context usage never returns and the iterator stays open", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let queryCount = 0;
    const prompts: string[] = [];
    const closeFns: Array<ReturnType<typeof vi.fn>> = [];
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({
        leaderQuery: (input) => {
          queryCount += 1;
          // A resumed Leader must keep the provider session identity stable.
          const sessionId = "sdk-hung-context-1";
          let releaseIterator!: () => void;
          const iteratorHeld = new Promise<void>((resolve) => {
            releaseIterator = resolve;
          });
          const close = vi.fn(() => {
            releaseIterator();
          });
          closeFns.push(close);
          return {
            async *[Symbol.asyncIterator]() {
              if (typeof input.prompt === "string") throw new Error("expected streaming input");
              const messages = input.prompt[Symbol.asyncIterator]();
              const next = await messages.next();
              const content = Array.isArray(next.value?.message.content) ? next.value.message.content[0] : undefined;
              prompts.push(content?.type === "text" ? content.text : "");
              yield { type: "result", subtype: "success", session_id: sessionId, is_error: false };
              // Reproduce real Claude SDK: turn completed, but async iterator stays alive
              // until query.close() (e.g. hung get_context_usage / count_tokens).
              await iteratorHeld;
            },
            close,
            async getContextUsage() {
              // Never resolves — mirrors a stuck SDK control request.
              return new Promise(() => {});
            },
          };
        },
      }),
    });

    const firstTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "测试3",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    // First turn must finish without waiting forever on hung context usage.
    await firstTurn;
    expect(closeFns[0]).toHaveBeenCalled();

    const secondStartedAt = Date.now();
    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "直接输出1-500",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    const secondDurationMs = Date.now() - secondStartedAt;

    expect(queryCount).toBe(2);
    expect(prompts[0]).toBe("测试3");
    expect(prompts[1]).toBe("直接输出1-500");
    expect(secondDurationMs).toBeLessThan(5_000);
    expect(closeFns[1]).toHaveBeenCalled();
  });

  it("keeps the UserTurn open while a failed Expert result and its recovery are queued", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const coderTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Implement",
      description: "Implement",
      expertId: "exp-coder",
    })!;
    const verifyTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Verify",
      description: "Verify",
      expertId: "exp-verify",
    })!;
    store.updateTask(coderTask.id, { status: "in_progress" });
    store.completeTask(coderTask.id);
    store.updateTask(verifyTask.id, { status: "in_progress" });
    store.failTask(verifyTask.id, "verification failed");

    const inputReady = [deferred(), deferred(), deferred()];
    const releaseResult = [deferred(), deferred(), deferred()];
    const published: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "test", (event) => { published.push(event); });
    const runtime = createLeaderRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          for (let index = 0; index < 3; index += 1) {
            await messages.next();
            inputReady[index]!.resolve();
            await releaseResult[index]!.promise;
            yield { type: "result", subtype: "success", session_id: "sdk-leader-bug-b", is_error: false };
          }
        },
        close() {},
      }) }),
    });
    const expertTurn = (taskId: string, expertId: string, turnOutcome: string, error: string | null) => ({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result" as const,
      expertResult: {
        taskId,
        agentSessionId: `ags-${taskId}`,
        expertId,
        turnOutcome,
        summary: error ?? "done",
        error,
        artifactRefs: [],
        completedAt: "2026-07-09T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const coderResultTurn = runtime.runLeaderTurn(expertTurn(coderTask.id, "exp-coder", "completed", null));
    await inputReady[0]!.promise;
    const verifyFailureTurn = runtime.runLeaderTurn(expertTurn(verifyTask.id, "exp-verify", "errored", "verification failed"));
    releaseResult[0]!.resolve();
    await coderResultTurn;
    await inputReady[1]!.promise;

    expect(store.getUserTurn(userTurn.id)?.status).toBe("active");
    const dispatches: unknown[] = [];
    const port = createStorePort(store, {
      dispatchAgent: async (input) => {
        dispatches.push(input);
        return {
          agent_session_id: "ags-recovery",
          status: "streaming",
          expert_id: input.expertId,
          task_id: input.taskId,
          user_turn_id: userTurn.id,
        };
      },
      sendMessage: async () => ({ accepted: false }),
    });
    const currentTurnInput = {
      trigger_kind: "expert_result" as const,
      user_turn_id: userTurn.id,
      created_at: "2026-07-09T10:00:01.000Z",
    };
    const recovery = port.createTask({
      flowId: flow.id,
      subject: "Recover verification failure",
      description: "Fix and verify again",
      currentTurnInput,
    })!;
    expect(await port.dispatchAgent({
      flowId: flow.id,
      taskId: recovery.task.task_id as string,
      expertId: "exp-coder",
      prompt: "Recover",
      resumeAgentSessionId: "",
      currentTurnInput,
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(dispatches).toHaveLength(1);
    const recoveryTaskId = recovery.task.task_id as string;
    store.updateTask(recoveryTaskId, { status: "in_progress" });
    store.completeTask(recoveryTaskId);

    const recoveryResultTurn = runtime.runLeaderTurn(expertTurn(recoveryTaskId, "exp-coder", "completed", null));
    releaseResult[1]!.resolve();
    await verifyFailureTurn;
    await inputReady[2]!.promise;
    expect(store.getUserTurn(userTurn.id)?.status).toBe("active");

    releaseResult[2]!.resolve();
    await recoveryResultTurn;
    expect(store.getUserTurn(userTurn.id)?.status).toBe("completed");
    expect(published.filter((event) => (
      event as { type?: string; data?: { status?: string } }
    ).type === "user_turn:event" && (
      event as { data?: { status?: string } }
    ).data?.status === "completed")).toHaveLength(1);
  });

  it("completes a recovery turn that forms a normal conclusion without creating another Task", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const failedTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Verify",
      description: "Verify",
      expertId: "exp-verify",
    })!;
    store.updateTask(failedTask.id, { status: "in_progress" });
    store.failTask(failedTask.id, "external prerequisite unavailable");
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([{
        type: "result",
        subtype: "success",
        session_id: "sdk-leader-conclusion",
        is_error: false,
      }]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result",
      expertResult: {
        taskId: failedTask.id,
        agentSessionId: "ags-verify",
        expertId: "exp-verify",
        turnOutcome: "errored",
        summary: "Cannot verify because the external prerequisite is unavailable.",
        error: "external prerequisite unavailable",
        artifactRefs: [],
        completedAt: "2026-07-09T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(store.listUserTurnTasks(userTurn.id).map((task) => task.id)).toEqual([failedTask.id]);
    expect(store.getUserTurn(userTurn.id)?.status).toBe("completed");
  });

  it("moves a feedback-paused turn to waiting_user after Leader becomes idle", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Pause for feedback",
      objective: "Pause safely",
      workKind: "change",
      riskLevel: "low",
      status: "approved",
      lint: [],
      diff: {},
      nodes: [{
        nodeId: "verify",
        expertId: "exp-verify",
        title: "Verify",
        description: "Verify",
        dependsOn: [],
        acceptanceCriteria: ["verified"],
        riskTags: [],
        sideEffects: [],
        resourceKeys: [],
      }],
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    const task = store.getTask(store.listPlanNodeTasks(run.id)[0]!.taskId)!;
    store.updateTask(task.id, { status: "in_progress" });
    store.cancelTask(task.id);
    store.recordPlanFeedback({
      flowId: flow.id,
      userTurnId: userTurn.id,
      planRevisionId: created.revision.id,
      sourceMessageId: "msg-pause",
      feedback: [{ markerNumber: 1, comment: "暂停并等待下一步" }],
    });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([{
        type: "result",
        subtype: "success",
        session_id: "sdk-leader-paused",
        is_error: false,
      }]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "user_turn_recovery",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(store.getPlanRun(run.id)?.status).toBe("paused_for_feedback");
    expect(store.getUserTurn(userTurn.id)?.status).toBe("waiting_user");
  });

  it("serializes concurrent Expert results and completes their UserTurn exactly once", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const firstTask = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "First", description: "First" })!;
    const secondTask = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "Second", description: "Second" })!;
    store.updateTask(firstTask.id, { status: "in_progress" });
    store.completeTask(firstTask.id);
    store.updateTask(secondTask.id, { status: "in_progress" });
    store.failTask(secondTask.id, "failed second");
    const inputs = [deferred(), deferred()];
    const releases = [deferred(), deferred()];
    const prompts: string[] = [];
    const published: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "test", (event) => { published.push(event); });
    const runtime = createLeaderRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (queryInput) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
          const messages = queryInput.prompt[Symbol.asyncIterator]();
          for (let index = 0; index < 2; index += 1) {
            const message = await messages.next();
            const content = Array.isArray(message.value?.message.content) ? message.value.message.content[0] : undefined;
            prompts.push(content?.type === "text" ? content.text : "");
            inputs[index]!.resolve();
            await releases[index]!.promise;
            yield { type: "result", subtype: "success", session_id: "sdk-leader-concurrent", is_error: false };
          }
        },
        close() {},
      }) }),
    });
    const expertTurn = (taskId: string, turnOutcome: string, error: string | null) => runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result",
      expertResult: {
        taskId,
        agentSessionId: `ags-${taskId}`,
        expertId: "exp-verify",
        turnOutcome,
        summary: error ?? "done",
        error,
        artifactRefs: [],
        completedAt: "2026-07-09T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const first = expertTurn(firstTask.id, "completed", null);
    await inputs[0]!.promise;
    const second = expertTurn(secondTask.id, "errored", "failed second");
    releases[0]!.resolve();
    await inputs[1]!.promise;
    expect(store.getUserTurn(userTurn.id)?.status).toBe("active");
    releases[1]!.resolve();
    await Promise.all([first, second]);

    expect(prompts[0]).toContain(firstTask.id);
    expect(prompts[1]).toContain(secondTask.id);
    expect(store.getUserTurn(userTurn.id)?.status).toBe("completed");
    expect(published.filter((event) => (
      event as { type?: string; data?: { status?: string } }
    ).type === "user_turn:event" && (
      event as { data?: { status?: string } }
    ).data?.status === "completed")).toHaveLength(1);
  });

  it("drops a late Expert result after its UserTurn was cancelled without starting Leader", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}" })!;
    const task = store.createTask({ flowId: flow.id, userTurnId: userTurn.id, title: "Cancelled", description: "Cancelled" })!;
    store.cancelTask(task.id);
    store.failUserTurn(userTurn.id, "cancelled");
    let queryCount = 0;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-unused", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => {
        queryCount += 1;
        return createQuery([]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result",
      expertResult: {
        taskId: task.id,
        agentSessionId: "ags-late",
        expertId: "exp-coder",
        turnOutcome: "completed",
        summary: "late",
        error: null,
        artifactRefs: [],
        completedAt: "2026-07-09T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(queryCount).toBe(0);
    expect(store.getUserTurn(userTurn.id)?.status).toBe("cancelled");
  });

  it("guides the active Leader turn with a now-priority user message", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let signalFirstInput!: () => void;
    const firstInput = new Promise<void>((resolve) => { signalFirstInput = resolve; });
    let releaseResult!: () => void;
    const resultReleased = new Promise<void>((resolve) => { releaseResult = resolve; });
    const priorities: Array<string | undefined> = [];
    const contents: string[] = [];
    const guideDeliveryOrder: string[] = [];
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          const first = await messages.next();
          priorities.push(first.value?.priority);
          const firstContent = Array.isArray(first.value?.message.content) ? first.value.message.content[0] : undefined;
          contents.push(firstContent?.type === "text" ? firstContent.text : "");
          signalFirstInput();

          const guide = await messages.next();
          guideDeliveryOrder.push("runtime");
          priorities.push(guide.value?.priority);
          const guideContent = Array.isArray(guide.value?.message.content) ? guide.value.message.content[0] : undefined;
          contents.push(guideContent?.type === "text" ? guideContent.text : "");
          // Echo of the now-interrupted turn: absorbed by the adapter, must not settle the round.
          yield {
            type: "result",
            subtype: "error_during_execution",
            session_id: "sdk-leader-before-guide-result",
            is_error: true,
            terminal_reason: "aborted_streaming",
          };
          await resultReleased;
          yield { type: "result", subtype: "success", session_id: "sdk-leader-before-guide-result", is_error: false };
        },
        close() {},
      }) }),
    });

    const turn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "开始处理",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await firstInput;
    const accepted = await runtime.guideLeaderTurn({
      flowId: flow.id,
      leaderAgentSessionId: leader.id,
      content: "补充当前 turn",
      messageId: "msg-guide-1",
      beforeDeliver: () => guideDeliveryOrder.push("persisted"),
    });

    releaseResult();
    await turn;

    expect(accepted).toEqual({ accepted: true, messageId: "msg-guide-1" });
    expect(priorities).toEqual(["later", "now"]);
    expect(contents[0]).toContain("开始处理");
    expect(guideDeliveryOrder).toEqual(["persisted", "runtime"]);
    expect(parseMessageSegments(contents[1] ?? "", flow.id)).toEqual([
      expect.objectContaining({ kind: "event", type: "guide", body: "补充当前 turn" }),
    ]);
    expect(store.getAgentSession(leader.id)?.sessionId).toBe("sdk-leader-before-guide-result");
  });

  it("completes a guided turn that produces a single completed result (Codex steer-merge semantics)", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let signalFirstInput!: () => void;
    const firstInput = new Promise<void>((resolve) => { signalFirstInput = resolve; });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          await messages.next();
          signalFirstInput();
          // Steer merged into the running turn: the guide arrives, then exactly ONE
          // completed result closes the whole round (no interrupted-turn echo).
          await messages.next();
          yield { type: "result", subtype: "success", session_id: "sdk-leader-steer-merge", is_error: false };
        },
        close() {},
      }) }),
    });

    const turn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "开始处理",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await firstInput;
    const accepted = await runtime.guideLeaderTurn({
      flowId: flow.id,
      leaderAgentSessionId: leader.id,
      content: "并入当前 turn",
      messageId: "msg-guide-merge",
    });

    await turn;

    expect(accepted).toEqual({ accepted: true, messageId: "msg-guide-merge" });
    expect(store.getAgentSession(leader.id)?.status).toBe("completed");
  });

  it("waits for a card-paused stream to exit before resuming the same Leader session", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-card" })!;
    let queryCount = 0;
    let signalFirstInput!: () => void;
    const firstInput = new Promise<void>((resolve) => { signalFirstInput = resolve; });
    let releaseFirstResult!: () => void;
    const releaseResult = new Promise<void>((resolve) => { releaseFirstResult = resolve; });
    let releaseOldQueryExit!: () => void;
    const releaseOldQuery = new Promise<void>((resolve) => { releaseOldQueryExit = resolve; });

    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          queryCount += 1;
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          const messages = input.prompt[Symbol.asyncIterator]();
          await messages.next();
          if (queryCount === 1) {
            signalFirstInput();
            await releaseResult;
            yield { type: "result", subtype: "success", session_id: "sdk-leader-card", is_error: false };
            await releaseOldQuery;
            await messages.next();
            return;
          }
          yield { type: "result", subtype: "success", session_id: "sdk-leader-card", is_error: false };
        },
        close() {},
      }) }),
    });

    const firstTurn = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "请先澄清",
      userTurnId: userTurn.id,
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await firstInput;
    const card = store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-card",
      sessionId: leader.sessionId ?? leader.id,
      cardType: "clarification",
      questions: [{ question: "语言？" }],
    });
    releaseFirstResult();
    await firstTurn;

    store.resolveDecisionCard(card.id, flow.id, { language: "TypeScript" });
    store.resumeUserTurn(userTurn.id);
    const decision = runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "decision",
      userTurnId: userTurn.id,
      decisionCardId: card.id,
      decisionAnswers: { language: "TypeScript" },
      leaderAgentSessionId: leader.id,
      leaderSessionId: store.getFlow(flow.id)?.leaderSessionId ?? leader.id,
      resumeSessionId: store.getFlow(flow.id)?.leaderSessionId ?? undefined,
    });

    expect(queryCount).toBe(1);
    releaseOldQueryExit();
    await decision;
    expect(queryCount).toBe(2);
  });

  it("omits user_turn_id for ordinary Flow chat", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: {
        dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }),
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-1", duration_ms: 4321, is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "请你输出1到100 直接输出，不写文件内",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const prompt = await firstPromptText(captured);
    expect(prompt).toBe("请你输出1到100 直接输出，不写文件内");
    expect(prompt).not.toContain("user_turn_id:");
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentSessionId: leader.id,
        eventType: "agent_session.turn_completed",
        payloadJson: expect.stringContaining('"sdk_session_id":"sdk-leader-1"'),
      }),
    ]));
    const turnCompletedPayload = JSON.parse(store.listEventLog(flow.id)
      .find((event) => event.eventType === "agent_session.turn_completed")!.payloadJson);
    expect(turnCompletedPayload).toMatchObject({
      message_id: expect.any(String),
      agent_session_id: leader.id,
      sdk_session_id: "sdk-leader-1",
      started_at: expect.any(String),
      finished_at: expect.any(String),
      duration_ms: 4321,
    });
  });

  it("allows long Leader-only research turns", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: {
        dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }),
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-long", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "最少用20遍工具。不能派专家。",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(captured?.options?.maxTurns).toBe(80);
  });

  it("sends Expert results with the Task ID only in the event attribute", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id, inputSnapshotJson: "{}", createdBy: "user" })!;
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: {
        dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }),
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-1", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result",
      expertResult: {
        taskId: "task-1",
        agentSessionId: "ags-backend-1",
        expertId: "exp-backend",
        turnOutcome: "completed",
        summary: "built",
        error: null,
        artifactRefs: [],
        completedAt: "2026-06-15T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const prompt = await firstPromptText(captured);
    expect(parseMessageSegments(prompt, flow.id)).toEqual([
      expect.objectContaining({
        kind: "event",
        type: "expert_result",
        attrs: { task: "task-1" },
        body: "完成：built",
      }),
    ]);
    expect(prompt).not.toContain(userTurn.id);
    expect(prompt).not.toContain("agent_session_id");
    expect(prompt).not.toContain("expert_id");
  });

  it("does not include commit_plan instructions in user turns", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([{ type: "result", subtype: "success", session_id: "sdk-leader-1", is_error: false }]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "写个 helloworld",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const prompt = await firstPromptText(captured);
    expect(prompt).toBe("写个 helloworld");
    expect(prompt).not.toContain("commit_plan");
    expect(prompt).not.toContain("保存 SpecRevision");
  });

  it("accepts a string false SDK result flag as successful", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-leader-1", is_error: "false" },
      ]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "写个 helloworld",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(store.getAgentSession(leader.id)?.status).toBe("completed");
  });

  it("persists the provider error text when a Leader turn fails", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id });
    const chatJournal = new ChatJournal(store);
    const eventBus = new EventBus();
    const published: unknown[] = [];
    eventBus.subscribe(flow.id, "test", (event) => { published.push(event); });
    const providerError = "Failed to authenticate. API Error: 403 AccessDenied: Free quota exhausted.";
    const runtime = createLeaderRuntime({
      store,
      eventBus,
      chatJournal,
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        {
          type: "assistant",
          isApiErrorMessage: true,
          error: "authentication_failed",
          message: { content: [{ type: "text", text: providerError }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sdk-leader-auth-failure",
          is_error: true,
          result: providerError,
        },
      ]) }),
    });

    await expect(runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn!.id,
      kind: "user",
      userMessage: "你好",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    })).rejects.toThrow(providerError);

    expect(store.getAgentSession(leader.id)?.status).toBe("failed");
    expect(store.getUserTurn(userTurn!.id)?.status).toBe("failed");
    expect(chatJournal.getTranscriptMessages(flow.id, leader.id)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: providerError,
        parts: [expect.objectContaining({ type: "text", text: providerError })],
      }),
    ]);
    expect(published).toContainEqual(expect.objectContaining({
      type: "session:event",
      data: expect.objectContaining({
        agent_session_id: leader.id,
        status: "failed",
        error_message: providerError,
      }),
    }));
  });

  it("marks the Leader session failed when SDK query creation throws", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => {
        throw new Error("model not found");
      } }),
    });

    await expect(runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "写个 helloworld",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    })).rejects.toThrow("model not found");

    expect(store.getAgentSession(leader.id)?.status).toBe("failed");
  });

  it("exposes all local Leader tools except web search and enforces read/write path policy", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id });
    let captured: ClaudeQueryInput | null = null;
    const permissionGate = vi.fn().mockResolvedValue({ behavior: "deny", message: "用户未批准该风险操作。" });
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: {
        dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }),
      },
      permissionGate,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-1", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userTurnId: userTurn.id,
      userMessage: "build",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(captured?.options?.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    for (const builtinTool of ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]) {
      expect(captured?.options?.allowedTools).not.toContain(builtinTool);
    }
    expect(captured?.options?.tools).not.toContain("WebSearch");

    await expect(
      captured?.options?.canUseTool?.(
        "Read",
        { file_path: "/etc/hosts" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "/etc/hosts" } });
    await expect(
      captured?.options?.canUseTool?.(
        "Write",
        { file_path: "/tmp/squadflow-leader-note.txt", content: "note" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/tmp/squadflow-leader-note.txt", content: "note" },
    });
    await expect(
      captured?.options?.canUseTool?.(
        "Write",
        { file_path: "/etc/squadflow-leader-denied.txt", content: "no" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: "deny" }));

    await expect(
      captured?.options?.canUseTool?.("Bash", { command: "echo hi" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { command: "echo hi" } });
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: 'echo -n "temporary" > /tmp/squadflow-leader-boundary.txt' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: 'echo -n "temporary" > /tmp/squadflow-leader-boundary.txt' },
    });
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: 'echo -n "denied" > /etc/squadflow-leader-boundary.txt' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Bash 写操作必须落在项目或授权可写目录内。",
    });
    await expect(
      captured?.options?.canUseTool?.("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ behavior: "deny", message: "用户未批准该风险操作。" });
    expect(permissionGate).toHaveBeenCalledWith(expect.objectContaining({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope: { kind: "leader_user_turn" },
      permissionArgs: expect.objectContaining({ riskMode: "auto_edit" }),
    }));

    store.updateFlow(flow.id, { riskMode: "full_access" });
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: 'echo -n "denied" > /etc/squadflow-leader-boundary.txt' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Bash 写操作必须落在项目或授权可写目录内。",
    });
    await expect(
      captured?.options?.canUseTool?.("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
  });

  it("does not let an unexpected Claude tool request add its own capability", async () => {
    const store = tempStore();
    store.sqlite.prepare("UPDATE experts SET builtin_tools = ? WHERE id = ?")
      .run(JSON.stringify(["read", "search"]), "exp-leader");
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-static-auth", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "inspect",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(captured?.options?.tools).toEqual(["Read", "Glob", "Grep"]);
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: "echo hi" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ behavior: "deny", message: "tool not allowed by expert: Bash" });
  });

  it("captures platform diff artifacts before completing a quiescent UserTurn", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-user-turn-root-"));
    dirs.push(root);
    store.updateProject(flow.projectId!, { localPath: root });
    fs.writeFileSync(path.join(root, "hello.txt"), "before");
    const baseline = captureUserTurnBaseline(root);
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: root,
      inputSnapshotJson: JSON.stringify({ diff_baseline: baseline }),
      createdBy: "user",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Change hello",
      description: "Change hello",
      expertId: "exp-backend",
      dependsOnTaskIds: [],
    })!;
    store.assignTaskAgentSession(task.id, "ags-task");
    store.startTask(task.id, "ags-task");
    store.completeTask(task.id);
    fs.writeFileSync(path.join(root, "hello.txt"), "after");

    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: {
        dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }),
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-leader-1", is_error: false },
      ]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "expert_result",
      expertResult: {
        taskId: task.id,
        agentSessionId: "ags-task",
        expertId: "exp-backend",
        turnOutcome: "completed",
        summary: "done",
        error: null,
        artifactRefs: [],
        completedAt: "2026-06-15T10:00:00.000Z",
      },
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(store.getUserTurn(userTurn.id)?.status).toBe("completed");
    expect(store.listArtifacts(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userTurnId: userTurn.id, type: "changed_files" }),
      expect.objectContaining({ userTurnId: userTurn.id, type: "diff_summary", content: expect.stringContaining("hello.txt") }),
    ]));
  });

  it("rejects a normal user turn while a clarification card is pending", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-pending" })!;
    store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-pending",
      sessionId: leader.sessionId ?? leader.id,
      cardType: "clarification",
      questions: [],
    });
    let queryCount = 0;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "", status: "failed" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => {
        queryCount += 1;
        return createQuery([]);
      } }),
    });

    await expect(runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "不要悄悄开始第二轮",
      userTurnId: userTurn.id,
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    })).rejects.toMatchObject({ code: "PENDING_DECISION" });
    expect(queryCount).toBe(0);
  });

  it("attaches a squadflow-browser MCP server for the Leader session when a desktopBridge is available", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const desktopBridge = new DesktopBridge();
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      desktopBridge,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-browser", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "打开 hello.html",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const mcpServers = captured?.options?.mcpServers as Record<string, { name?: string }> | undefined;
    expect(Object.keys(mcpServers ?? {})).toEqual(["squadflow-leader", "squadflow-browser"]);
    expect(mcpServers?.["squadflow-browser"]?.name).toBe("squadflow-browser");
  });

  it("does not attach a squadflow-browser MCP server when no desktopBridge is configured", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    let captured: ClaudeQueryInput | null = null;
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        captured = input;
        return createQuery([
          { type: "result", subtype: "success", session_id: "sdk-leader-no-browser", is_error: false },
        ]);
      } }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "打开 hello.html",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    const mcpServers = captured?.options?.mcpServers as Record<string, unknown> | undefined;
    expect(Object.keys(mcpServers ?? {})).toEqual(["squadflow-leader"]);
  });

  it("releases the browser lease held by the Leader AgentSession once its turn completes", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const desktopBridge = new DesktopBridge();
    desktopBridge.acquireLease(leader.id, "Leader", flow.id);
    const runtime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: "ags-1", status: "streaming" }) },
      desktopBridge,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-leader-lease", is_error: false },
      ]) }),
    });

    await runtime.runLeaderTurn({
      flowId: flow.id,
      kind: "user",
      userMessage: "截个图给我看看",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });

    expect(desktopBridge.getLease()).toBeNull();
  });

  it("stops a running Expert and cancels nonterminal UserTurn work when the Leader fails fatally", async () => {
    const store = tempStore();
    const { flow, leader } = createFlowLeader(store);
    const userTurn = beginUserTurn(store, { flowId: flow.id })!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Keep working",
      description: "Keep working",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      displayName: "Coder",
      status: "queued",
    });
    store.assignTaskFlowExpert(task.id, flowExpert.id, session.id);
    store.setTaskRuntimeStatus(task.id, "queued_for_expert");

    const completedTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Already done",
      description: "Already done",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const completedSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: completedTask.id,
      expertId: "exp-coder",
      displayName: "Coder",
      status: "queued",
    });
    store.assignTaskAgentSession(completedTask.id, completedSession.id);
    store.startTask(completedTask.id, completedSession.id);
    store.completeTask(completedTask.id);
    store.updateAgentSessionStatus(completedSession.id, "completed");

    const spec = store.createSpecRevision({
      flowId: flow.id,
      title: "Fatal spec",
      content: "# Fatal spec",
      sourceAgentSessionId: leader.id,
    })!;

    const expertStarted = deferred<void>();
    const releaseExpert = deferred<void>();
    const desktopBridge = new DesktopBridge();
    const lateWritePath = path.join(userTurn.workRootPath!, "late-write.txt");
    let expertClosed = false;
    const expertRuntime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => ({
        async *[Symbol.asyncIterator]() {
          expertStarted.resolve();
          await releaseExpert.promise;
          if (expertClosed) return;
          fs.writeFileSync(lateWritePath, "late");
          yield { type: "result", subtype: "success", session_id: "sdk-expert-late", is_error: false };
        },
        close() {
          expertClosed = true;
          releaseExpert.resolve();
        },
      }) }),
    });
    const expertRun = expertRuntime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: session.id,
      prompt: "keep working",
    });
    await expertStarted.promise;
    desktopBridge.acquireLease(session.id, "Coder", flow.id);

    const leaderStarted = deferred<void>();
    const releaseLeader = deferred<void>();
    const leaderRuntime = createLeaderRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      agentDispatcher: { dispatchAgent: async () => ({ agent_session_id: session.id, status: "streaming" }) },
      onUserTurnFatal: ({ flowId, userTurnId }) => {
        expertRuntime.cancelUserTurn({ flowId, userTurnId });
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => ({
        async *[Symbol.asyncIterator]() {
          leaderStarted.resolve();
          await releaseLeader.promise;
          throw new Error("leader fatal");
        },
        close() {},
      }) }),
    });

    const leaderRun = leaderRuntime.runLeaderTurn({
      flowId: flow.id,
      userTurnId: userTurn.id,
      kind: "user",
      userMessage: "start",
      leaderAgentSessionId: leader.id,
      leaderSessionId: leader.sessionId ?? leader.id,
    });
    await leaderStarted.promise;
    const card = store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-leader-fatal",
      sessionId: leader.sessionId ?? leader.id,
      cardType: "clarification",
      questions: [],
    });
    const approval = store.createSpecApproval({
      flowId: flow.id,
      userTurnId: userTurn.id,
      specRevisionId: spec.id,
      fileName: spec.fileName,
      overview: spec.overview,
    })!;
    releaseLeader.resolve();
    await expect(leaderRun).rejects.toThrow("leader fatal");
    const stoppedByFatal = expertClosed;
    if (!stoppedByFatal) releaseExpert.resolve();
    await expertRun;

    expect(stoppedByFatal).toBe(true);
    expect(desktopBridge.getLease()).toBeNull();
    expect(fs.existsSync(lateWritePath)).toBe(false);
    expect(store.getUserTurn(userTurn.id)?.status).toBe("failed");
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.getAgentSession(session.id)?.status).toBe("interrupted");
    expect(store.getDecisionCard(card.id)?.status).toBe("cancelled");
    expect(store.getSpecApproval(approval.id)?.status).toBe("cancelled");
    expect(store.getTask(completedTask.id)?.status).toBe("completed");
    expect(store.getAgentSession(completedSession.id)?.status).toBe("completed");

    await expertRuntime.close();
  });
});

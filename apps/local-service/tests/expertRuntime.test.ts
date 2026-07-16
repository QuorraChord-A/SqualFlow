import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClaudeQueryInput, ClaudeQueryLike } from "../src/harness/agentRunner.js";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import { createExpertRuntime, type ExpertTaskFinishedEvent } from "../src/runtime/expertRuntime.js";
import { AsyncMessageQueue } from "../src/runtime/adapters/asyncMessageQueue.js";
import type { RuntimeSdk } from "../src/config/agentRuntimeConfig.js";
import { parseMessageSegments } from "../src/protocol/platformEvent.js";
import type { AgentRuntimeAdapter, BuildExpertRuntimeOptionsInput, RuntimeOutputAdapter } from "../src/runtime/adapters/runtimeAdapter.js";
import type { RuntimeEvent } from "../src/runtime/runtimeEvents.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";
import { DesktopBridge } from "../src/server/desktopBridge.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

function tempStore(sdk: RuntimeSdk = "claudecode") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-expert-runtime-"));
  dirs.push(dir);
  const runtimeConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-expert-runtime-config-"));
  dirs.push(runtimeConfigRoot);
  writeRuntimeConfig(runtimeConfigRoot, sdk);
  config.agentRuntimeConfigRoot = runtimeConfigRoot;
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  store.migrate();
  store.seedExperts();
  return store;
}

function writeRuntimeConfig(root: string, sdk: RuntimeSdk) {
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
    version: 1,
    roles: {
      leader: { enabled: true, configId: "default-agent-sdk" },
      frontend: { enabled: true, configId: "default-agent-sdk" },
      backend: { enabled: true, configId: "default-agent-sdk" },
      research: { enabled: true, configId: "default-agent-sdk" },
    },
  }, null, 2)}\n`);
  writeRuntimeConfigFile(root, "default-agent-sdk", sdk);
}

function writeRuntimeConfigFile(root: string, configId: string, sdk: RuntimeSdk) {
  fs.writeFileSync(path.join(root, "configs", `${configId}.json`), `${JSON.stringify({
    id: configId,
    fileName: `${configId}.json`,
    name: configId,
    sdk,
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models: [{ id: "model-1", name: "model-1" }],
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

function fakeOutputAdapter(messageId: string): RuntimeOutputAdapter {
  let finalAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let resultStatus: string | null = null;
  let resultIsError = false;
  return {
    get sdkSessionId() {
      return sdkSessionId;
    },
    get resultStatus() {
      return resultStatus;
    },
    get resultIsError() {
      return resultIsError;
    },
    get finalAssistantText() {
      return finalAssistantText;
    },
    durationMs: 1,
    resultCacheUsage: null,
    start: () => ({ type: "start", messageId, seq: 0, startedAt: "2026-01-01T00:00:00.000Z" }),
    adapt: (event) => {
      const raw = event.raw;
      if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "result") {
        const result = raw as { session_id?: unknown; subtype?: unknown; is_error?: unknown; final_text?: unknown };
        sdkSessionId = typeof result.session_id === "string" ? result.session_id : null;
        resultStatus = typeof result.subtype === "string" ? result.subtype : null;
        resultIsError = result.is_error === true;
        finalAssistantText = typeof result.final_text === "string" ? result.final_text : null;
      }
      return [];
    },
    finish: () => [{ type: "finish", messageId, seq: 1, durationMs: 1, finishedAt: "2026-01-01T00:00:01.000Z" }],
  };
}

function createFakeNonClaudeAdapter(
  captured: BuildExpertRuntimeOptionsInput[],
  sdk: RuntimeSdk = "codex",
): AgentRuntimeAdapter {
  return {
    sdk,
    buildLeaderOptions: () => ({}),
    buildExpertOptions: (input) => {
      captured.push(input);
      return {};
    },
    prepareLeaderMcpServer: async () => ({ mcpServerConfig: {}, close: async () => {} }),
    createInputQueue: () => new AsyncMessageQueue<unknown>(),
    createLeaderUserMessage: () => ({}),
    createLeaderGuideMessage: () => ({}),
    createSingleTextInput: async function* () {},
    createExpertUserMessage: (content) => ({ role: "user", content }),
    createOutputAdapter: (messageId) => fakeOutputAdapter(messageId),
    runQuery: () => ({
      async *[Symbol.asyncIterator]() {
        const raw = {
          type: "result",
          subtype: "success",
          session_id: `fake-${sdk}-session`,
          is_error: false,
          final_text: "fake adapter completed",
        };
        yield {
          type: "turn_completed",
          result: { status: "success", isError: false, sessionId: "fake-codex-session" },
          raw,
        } satisfies RuntimeEvent;
      },
      close() {},
    }),
    capabilities: {
      steer: true,
      compact: true,
      historyRead: true,
      imageInput: true,
      tokenUsage: true,
      toolApproval: true,
    },
    compactedTokenSnapshot: (totalTokens) => ({
      totalTokens,
      maxTokens: null,
      rawMaxTokens: null,
      percentage: null,
      model: null,
      categories: [],
      cacheInputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
      observedAt: "2026-01-01T00:00:00.000Z",
      compacted: true,
    }),
    contextUsageSnapshot: () => ({
      totalTokens: null,
      maxTokens: null,
      rawMaxTokens: null,
      percentage: null,
      model: null,
      categories: [],
      cacheInputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
      observedAt: "2026-01-01T00:00:00.000Z",
      compacted: false,
    }),
    compactContextInput: async function* () {},
    loadSessionHistory: async () => [],
    latestCompactTranscriptMetadata: async () => null,
  };
}

function createProject(store: ReturnType<typeof createStore>, flowId: string) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${flowId}-project-`));
  dirs.push(projectRoot);
  return store.createProject({ name: `${flowId} Project`, localPath: projectRoot });
}

function createFlowWithProject(store: ReturnType<typeof createStore>, input: { id: string; name: string; description?: string }) {
  const project = createProject(store, input.id);
  const flow = store.createFlow({
    id: input.id,
    name: input.name,
    description: input.description ?? "",
    projectId: project.id,
  });
  return { flow, projectRoot: project.localPath };
}

function createQuery(messages: unknown[], contextUsage?: {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
}): ClaudeQueryLike {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
    close() {},
    ...(contextUsage ? {
      async getContextUsage() {
        return {
          ...contextUsage,
          categories: [{ name: "Messages", tokens: contextUsage.totalTokens, color: "#22c55e" }],
          gridRows: [],
          memoryFiles: [],
          mcpTools: [],
        };
      },
    } : {}),
  };
}

function parseToolJson(result: unknown) {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, any>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function connectBrowserMcpClient(server: McpServer) {
  const client = new Client({ name: "expert-runtime-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

class RecordingDesktopBridge extends DesktopBridge {
  readonly acquireCalls: string[] = [];
  readonly releaseCalls: string[] = [];

  override async request(command: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return { command, params, timeoutMs };
  }

  override acquireLease(agentSessionId: string, holderName: string, flowId: string) {
    this.acquireCalls.push(agentSessionId);
    return super.acquireLease(agentSessionId, holderName, flowId);
  }

  override releaseLease(agentSessionId: string) {
    this.releaseCalls.push(agentSessionId);
    super.releaseLease(agentSessionId);
  }
}

function sdkUserMessageText(message: Awaited<ReturnType<AsyncIterator<any>["next"]>>["value"]): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .filter((part: { type: string }): part is { type: "text"; text: string } => part.type === "text")
    .map((part: { text: string }) => part.text)
    .join("");
}

async function firstPromptText(prompt: ClaudeQueryInput["prompt"]): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt) return sdkUserMessageText(message);
  return "";
}

function createWorkingUserTurn(store: ReturnType<typeof createStore>, flowId: string) {
  let flow = store.getFlow(flowId)!;
  if (!flow.projectId) {
    const project = store.createProject({ name: `Project ${flowId}`, localPath: `/tmp/${flowId}` });
    flow = store.updateFlow(flowId, { projectId: project.id })!;
  }
  const turn = store.createUserTurn({ flowId, triggerMessageId: `msg-${flowId}-${Date.now()}` })!;
  return store.startUserTurnWork({
    flowId,
    userTurnId: turn.id,
    workSource: "direct_message",
    targetProjectId: flow.projectId!,
    inputSnapshotJson: "{}",
  })!;
}

function createAssignedTaskForFlowExpert(
  store: ReturnType<typeof createStore>,
  input: {
    flowId: string;
    userTurnId: string;
    expertId: string;
    flowExpertId: string;
    title: string;
  },
) {
  const task = store.createTask({
    flowId: input.flowId,
    userTurnId: input.userTurnId,
    title: input.title,
    description: input.title,
    expertId: input.expertId,
    dependsOnTaskIds: [],
  })!;
  const session = store.createAgentSession({
    flowId: input.flowId,
    userTurnId: input.userTurnId,
    taskId: task.id,
    expertId: input.expertId,
    flowExpertId: input.flowExpertId,
    displayName: "Frontend",
    status: "queued",
  });
  store.assignTaskFlowExpert(task.id, input.flowExpertId, session.id);
  store.setTaskRuntimeStatus(task.id, "queued_for_expert");
  return { task: store.getTask(task.id)!, session };
}

function createRunningTask(store: ReturnType<typeof createStore>, expertId = "exp-verify") {
  const { flow } = createFlowWithProject(store, {
    id: "flow-1",
    name: "Hello",
    description: "",
  });
  const userTurn = createWorkingUserTurn(store, flow.id);
  const task = store.createTask({
    flowId: flow.id,
    userTurnId: userTurn.id,
    title: "Verify",
    description: "验证 hello world",
    expertId,
    dependsOnTaskIds: [],
  })!;
  const session = store.createAgentSession({
    flowId: flow.id,
    userTurnId: userTurn.id,
    taskId: task.id,
    expertId,
    displayName: expertId,
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

describe("ExpertRuntime", () => {
  it("runs through a non-Claude adapter using system capabilities", async () => {
    const store = tempStore("codex");
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const capturedOptions: BuildExpertRuntimeOptionsInput[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: ({ sdk }) => {
        expect(sdk).toBe("codex");
        return createFakeNonClaudeAdapter(capturedOptions);
      },
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].capabilities).toEqual(["read", "search", "shell"]);
    expect(capturedOptions[0].capabilities).not.toContain("Read");
    expect(store.getAgentSession(session.id)).toEqual(expect.objectContaining({
      runtimeSdk: "codex",
      sessionId: "fake-codex-session",
      status: "completed",
    }));
    expect(store.getTask(task.id)?.status).toBe("completed");
  });

  it("locks a Flow Expert runtime after first start while unstarted experts use the latest role config", async () => {
    const store = tempStore("codex");
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-research");
    const capturedOptions: BuildExpertRuntimeOptionsInput[] = [];
    const sdkCalls: RuntimeSdk[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: ({ sdk }) => {
        sdkCalls.push(sdk);
        return createFakeNonClaudeAdapter(capturedOptions, sdk);
      },
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });
    const researchFlowExpert = store.listFlowExperts(flow.id)
      .find((flowExpert) => flowExpert.expertId === "exp-research")!;
    expect(researchFlowExpert).toEqual(expect.objectContaining({
      runtimeSdk: "codex",
      runtimeConfigId: "default-agent-sdk",
    }));

    switchAllRolesRuntimeConfig(config.agentRuntimeConfigRoot, "claude-agent-sdk", "claudecode");

    const secondResearch = createAssignedTaskForFlowExpert(store, {
      flowId: flow.id,
      userTurnId: userTurn.id,
      expertId: "exp-research",
      flowExpertId: researchFlowExpert.id,
      title: "Research again",
    });
    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: secondResearch.task.id,
      flowExpertId: researchFlowExpert.id,
      agentSessionId: secondResearch.session.id,
    });

    const backendTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Backend first run",
      description: "Backend first run",
      expertId: "exp-coder",
      dependsOnTaskIds: [],
    })!;
    const backendSession = store.createAgentSession({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: backendTask.id,
      expertId: "exp-coder",
      displayName: "Backend",
      status: "streaming",
    });
    store.startTask(backendTask.id, backendSession.id);
    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: backendTask.id,
      agentSessionId: backendSession.id,
    });

    expect(sdkCalls).toEqual(["codex", "codex", "claudecode"]);
    expect(store.getAgentSession(secondResearch.session.id)).toEqual(expect.objectContaining({
      runtimeSdk: "codex",
      runtimeConfigId: "default-agent-sdk",
    }));
    expect(store.getAgentSession(backendSession.id)).toEqual(expect.objectContaining({
      runtimeSdk: "claudecode",
      runtimeConfigId: "claude-agent-sdk",
    }));
  });

  it("keeps a legacy started Flow Expert session on claudecode after the role config changes", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-legacy-expert", name: "Legacy Expert" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "legacy-frontend-sdk");
    const assigned = createAssignedTaskForFlowExpert(store, {
      flowId: flow.id,
      userTurnId: userTurn.id,
      expertId: "exp-coder",
      flowExpertId: flowExpert.id,
      title: "Legacy frontend task",
    });
    switchAllRolesRuntimeConfig(config.agentRuntimeConfigRoot, "codex-agent-sdk", "codex");

    const sdkCalls: RuntimeSdk[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: (input) => {
        sdkCalls.push(input.sdk);
        return createClaudeTestAdapterFactory({ expertQuery: () => createQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "legacy-frontend-sdk",
            is_error: false,
          },
        ]) })(input);
      },
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: assigned.task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: assigned.session.id,
    });

    expect(sdkCalls).toEqual(["claudecode"]);
    expect(store.getFlowExpert(flowExpert.id)).toEqual(expect.objectContaining({
      runtimeSdk: "claudecode",
      runtimeConfigId: "default-agent-sdk",
      runtimeModelId: "model-1",
    }));
    expect(store.getAgentSession(assigned.session.id)).toEqual(expect.objectContaining({
      runtimeSdk: "claudecode",
      runtimeConfigId: "default-agent-sdk",
      runtimeModelId: "model-1",
      sessionId: "legacy-frontend-sdk",
      status: "completed",
    }));
  });

  it("completes a running task and persists the ExpertResult and session state", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const finished: unknown[] = [];
    const events: unknown[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "test-client", (message) => events.push(message));
    const runtime = createExpertRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      onTaskFinished: (event) => finished.push(event),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery(
        [
          { type: "stream_event", event: { delta: { type: "text_delta", text: "验证通过" } } },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-expert-verify",
            duration_ms: 5678,
            is_error: false,
          },
        ],
        {
          totalTokens: 14_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 7,
          model: "claude-sonnet",
        },
      ) }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "completed",
      agentSessionId: session.id,
      resultJson: expect.stringContaining("验证通过"),
    }));
    expect(store.listAgentSessions(flow.id)).toEqual([
      expect.objectContaining({
        id: session.id,
        sessionId: "sdk-expert-verify",
        status: "completed",
      }),
    ]);
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentSessionId: session.id,
        eventType: "agent_session.completion",
        payloadJson: expect.stringContaining('"summary":"验证通过"'),
      }),
      expect.objectContaining({
        agentSessionId: session.id,
        eventType: "agent_session.turn_completed",
        payloadJson: expect.stringContaining('"message_id"'),
      }),
    ]));
    const turnCompletedPayload = JSON.parse(store.listEventLog(flow.id)
      .find((event) => event.eventType === "agent_session.turn_completed")!.payloadJson);
    expect(turnCompletedPayload).toMatchObject({
      message_id: expect.any(String),
      agent_session_id: session.id,
      sdk_session_id: "sdk-expert-verify",
      started_at: expect.any(String),
      finished_at: expect.any(String),
      duration_ms: 5678,
    });
    const eventPayload = JSON.parse(store.listEventLog(flow.id)
      .find((event) => event.eventType === "agent_session.completion")!.payloadJson);
    expect(finished).toEqual([
      expect.objectContaining({
        agentSessionId: session.id,
        status: "completed",
        summary: "验证通过",
        error: null,
        artifactRefs: [],
        completedAt: eventPayload.completed_at,
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task:event",
        data: expect.objectContaining({ task_id: task.id, status: "completed" }),
      }),
      expect.objectContaining({
        type: "flow_expert:event",
        data: expect.objectContaining({ agent_session_id: session.id, status: "completed" }),
      }),
    ]));
    expect(store.getAgentContextUsageSnapshot(session.id)).toEqual(expect.objectContaining({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-expert-verify",
      role: "verify",
      expertId: "exp-verify",
      totalTokens: 14_000,
      maxTokens: 200_000,
      percentage: 7,
      model: "claude-sonnet",
    }));
  });

  it("notifies the Leader queue before publishing an Expert completion event", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const publishStarted = deferred<void>();
    const releasePublish = deferred<void>();
    let leaderNotified = false;
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "blocking-client", async (message) => {
      if (message.type !== "task:event" || message.data.status !== "completed") return;
      publishStarted.resolve();
      await releasePublish.promise;
    });
    const runtime = createExpertRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      onTaskFinished: () => {
        leaderNotified = true;
      },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery([{
        type: "result",
        subtype: "success",
        session_id: "sdk-expert-notify-order",
        is_error: false,
      }]) }),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });
    await publishStarted.promise;

    const notifiedBeforePublish = leaderNotified;
    releasePublish.resolve();
    await running;
    expect(notifiedBeforePublish).toBe(true);
  });

  it("releases the browser lease held by an AgentSession once its turn completes successfully", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const desktopBridge = new DesktopBridge();
    desktopBridge.acquireLease(session.id, "Verify", flow.id);
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery([
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-expert-verify-lease",
          is_error: false,
        },
      ]) }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(desktopBridge.getLease()).toBeNull();
  });

  it("releases the browser lease held by an AgentSession when its turn fails", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const desktopBridge = new DesktopBridge();
    desktopBridge.acquireLease(session.id, "Verify", flow.id);
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sdk-expert-verify-lease-fail",
          is_error: true,
        },
      ]) }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(store.getTask(task.id)?.status).toBe("failed");
    expect(desktopBridge.getLease()).toBeNull();
  });

  it("uses the active turn AgentSession id for browser tools across queued tasks on one FlowExpertWorker", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-browser-context", name: "Browser Context" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first browser task" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second browser task" });
    const desktopBridge = new RecordingDesktopBridge();
    desktopBridge.connect({ send: () => {} });
    let browserServer: McpServer | null = null;
    const toolResults: Array<Record<string, any>> = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: (input) => {
        const base = createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
          async *[Symbol.asyncIterator]() {
            if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
            if (!browserServer) throw new Error("missing browser server");
            const browser = await connectBrowserMcpClient(browserServer);
            try {
              let index = 0;
              for await (const message of queryInput.prompt) {
                sdkUserMessageText(message);
                const result = await browser.client.callTool({ name: "browser_snapshot", arguments: {} });
                toolResults.push(parseToolJson(result));
                yield {
                  type: "result",
                  subtype: "success",
                  session_id: "sdk-browser-context",
                  is_error: false,
                  final_text: `done-${index}`,
                };
                index += 1;
              }
            } finally {
              await browser.close();
            }
          },
          close() {},
        }) })(input);
        return {
          ...base,
          prepareExpertMcpServer: async ({ server, bridgeRegistry }) => {
            browserServer = server;
            return base.prepareExpertMcpServer({ server, bridgeRegistry });
          },
        };
      },
    });

    await Promise.all([
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id, prompt: "task one" }),
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id, prompt: "task two" }),
    ]);

    expect(toolResults).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(desktopBridge.acquireCalls).toEqual([first.session.id, second.session.id]);
    expect(desktopBridge.releaseCalls).toEqual(expect.arrayContaining([first.session.id, second.session.id]));
    expect(desktopBridge.getLease()).toBeNull();
  });

  it("keeps browser lease revocation scoped to the reclaimed AgentSession on a reused FlowExpertWorker", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-browser-reclaim", name: "Browser Reclaim" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first browser task" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second browser task" });
    const desktopBridge = new RecordingDesktopBridge();
    desktopBridge.connect({ send: () => {} });
    let browserServer: McpServer | null = null;
    const toolResults: Array<Record<string, any>> = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: (input) => {
        const base = createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
          async *[Symbol.asyncIterator]() {
            if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
            if (!browserServer) throw new Error("missing browser server");
            const browser = await connectBrowserMcpClient(browserServer);
            try {
              let index = 0;
              for await (const message of queryInput.prompt) {
                sdkUserMessageText(message);
                toolResults.push(parseToolJson(await browser.client.callTool({ name: "browser_snapshot", arguments: {} })));
                if (index === 0) {
                  desktopBridge.reclaimLease();
                  toolResults.push(parseToolJson(await browser.client.callTool({ name: "browser_snapshot", arguments: {} })));
                }
                yield {
                  type: "result",
                  subtype: "success",
                  session_id: "sdk-browser-reclaim",
                  is_error: false,
                  final_text: `done-${index}`,
                };
                index += 1;
              }
            } finally {
              await browser.close();
            }
          },
          close() {},
        }) })(input);
        return {
          ...base,
          prepareExpertMcpServer: async ({ server, bridgeRegistry }) => {
            browserServer = server;
            return base.prepareExpertMcpServer({ server, bridgeRegistry });
          },
        };
      },
    });

    await Promise.all([
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id, prompt: "task one" }),
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id, prompt: "task two" }),
    ]);

    expect(toolResults).toEqual([
      expect.objectContaining({ ok: true }),
      { ok: false, error: { code: "BROWSER_LEASE_REVOKED", message: expect.any(String) } },
      expect.objectContaining({ ok: true }),
    ]);
    expect(desktopBridge.acquireCalls).toEqual([first.session.id, first.session.id, second.session.id]);
    expect(desktopBridge.getLease()).toBeNull();
  });

  it("releases the active browser lease when a FlowExpertWorker is closed mid-turn", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-browser-close", name: "Browser Close" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const assigned = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "active browser task" });
    const desktopBridge = new RecordingDesktopBridge();
    desktopBridge.connect({ send: () => {} });
    let browserServer: McpServer | null = null;
    const leaseAcquired = deferred();
    const releaseQuery = deferred();
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: (input) => {
        const base = createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
          async *[Symbol.asyncIterator]() {
            if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
            if (!browserServer) throw new Error("missing browser server");
            const browser = await connectBrowserMcpClient(browserServer);
            try {
              for await (const message of queryInput.prompt) {
                sdkUserMessageText(message);
                await browser.client.callTool({ name: "browser_snapshot", arguments: {} });
                leaseAcquired.resolve();
                await releaseQuery.promise;
                return;
              }
            } finally {
              await browser.close();
            }
          },
          close() {
            releaseQuery.resolve();
          },
        }) })(input);
        return {
          ...base,
          prepareExpertMcpServer: async ({ server, bridgeRegistry }) => {
            browserServer = server;
            return base.prepareExpertMcpServer({ server, bridgeRegistry });
          },
        };
      },
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: assigned.task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: assigned.session.id,
      prompt: "hold browser",
    });
    await leaseAcquired.promise;
    expect(desktopBridge.getLease()?.agentSessionId).toBe(assigned.session.id);

    await runtime.close?.();
    await running;

    expect(desktopBridge.releaseCalls).toContain(assigned.session.id);
    expect(desktopBridge.getLease()).toBeNull();
  });

  it("releases the active browser lease and closes the MCP binding when a UserTurn is cancelled mid-turn", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-browser-cancel", name: "Browser Cancel" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const assigned = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "cancel browser task" });
    const desktopBridge = new RecordingDesktopBridge();
    desktopBridge.connect({ send: () => {} });
    let browserServer: McpServer | null = null;
    const leaseAcquired = deferred();
    const releaseQuery = deferred();
    let mcpCloseCalls = 0;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      desktopBridge,
      runtimeAdapterFactory: (input) => {
        const base = createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
          async *[Symbol.asyncIterator]() {
            if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
            if (!browserServer) throw new Error("missing browser server");
            const browser = await connectBrowserMcpClient(browserServer);
            try {
              for await (const message of queryInput.prompt) {
                sdkUserMessageText(message);
                await browser.client.callTool({ name: "browser_snapshot", arguments: {} });
                leaseAcquired.resolve();
                await releaseQuery.promise;
                return;
              }
            } finally {
              await browser.close();
            }
          },
          close() {
            releaseQuery.resolve();
          },
        }) })(input);
        return {
          ...base,
          prepareExpertMcpServer: async ({ server, bridgeRegistry }) => {
            browserServer = server;
            const binding = await base.prepareExpertMcpServer({ server, bridgeRegistry });
            return {
              ...binding,
              close: async () => {
                mcpCloseCalls += 1;
                await binding.close();
              },
            };
          },
        };
      },
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: assigned.task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: assigned.session.id,
      prompt: "hold browser",
    });
    await leaseAcquired.promise;
    expect(desktopBridge.getLease()?.agentSessionId).toBe(assigned.session.id);

    expect(runtime.cancelUserTurn({ flowId: flow.id, userTurnId: userTurn.id })).toBe(1);
    await running;

    expect(desktopBridge.releaseCalls).toContain(assigned.session.id);
    expect(desktopBridge.getLease()).toBeNull();
    expect(mcpCloseCalls).toBe(1);
  });

  it("cancels one running Task and publishes a cancelled expert_result", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const started = deferred();
    const releaseQuery = deferred();
    const finished: ExpertTaskFinishedEvent[] = [];
    const events: any[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe(flow.id, "cancel-task-test", (message) => events.push(message));
    const runtime = createExpertRuntime({
      store,
      eventBus,
      chatJournal: new ChatJournal(),
      onTaskFinished: (event) => { finished.push(event); },
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
          for await (const _message of queryInput.prompt) {
            started.resolve();
            await releaseQuery.promise;
            return;
          }
        },
        close() {
          releaseQuery.resolve();
        },
      }) }),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
      prompt: "hold task",
    });
    await started.promise;

    expect(runtime.sendMessage({
      flowId: flow.id,
      agentSessionId: session.id,
      content: "queued follow-up",
    })).toBe(true);

    await expect(runtime.cancelTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    })).resolves.toBe(true);
    await running;

    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      resultJson: expect.stringContaining('"turn_outcome":"interrupted"'),
    }));
    expect(store.getAgentSession(session.id)?.status).toBe("interrupted");
    expect(finished).toEqual([expect.objectContaining({
      taskId: task.id,
      agentSessionId: session.id,
      status: "cancelled",
      turnOutcome: "interrupted",
    })]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "task:event",
      data: expect.objectContaining({ task_id: task.id, status: "cancelled" }),
    }));
    const completion = store.listEventLog(flow.id).find((event) => event.eventType === "agent_session.completion");
    expect(JSON.parse(completion!.payloadJson)).toEqual(expect.objectContaining({ status: "cancelled" }));
  });

  it("persists the temporary runtime session before the SDK result arrives", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const chatJournal = new ChatJournal();
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => ({
        async *[Symbol.asyncIterator]() {
          await queryGate;
          yield {
            type: "result",
            subtype: "success",
            session_id: "sdk-expert-after-gate",
            is_error: false,
          };
        },
        close() {
          releaseQuery();
        },
      }) }),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    try {
      let runtimeSessionId: string | null = null;
      for (let attempt = 0; attempt < 50 && !runtimeSessionId; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        runtimeSessionId = store.getAgentSession(session.id)?.sessionId ?? null;
      }

      expect(runtimeSessionId).toEqual(expect.any(String));
      expect(chatJournal.getCurrentMessage(flow.id, runtimeSessionId!)).toEqual(expect.objectContaining({
        role: "assistant",
      }));
    } finally {
      releaseQuery();
      await running;
    }

    expect(store.getAgentSession(session.id)?.sessionId).toBe("sdk-expert-after-gate");
  });

  it("persists the SDK session id as soon as the runtime announces it", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const chatJournal = new ChatJournal();
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sdk-expert-early" };
          await queryGate;
        },
        close() { releaseQuery(); },
      }) }),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    try {
      for (let attempt = 0; attempt < 50 && store.getAgentSession(session.id)?.sessionId !== "sdk-expert-early"; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(store.getAgentSession(session.id)?.sessionId).toBe("sdk-expert-early");
      expect(chatJournal.getCurrentMessage(flow.id, "sdk-expert-early")).toEqual(expect.objectContaining({ role: "assistant" }));
    } finally {
      runtime.cancelUserTurn({ flowId: flow.id, userTurnId: userTurn.id });
      await running;
    }
  });

  it("completes the task on a successful turn even when the Expert leaves no final assistant text", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery([
        { type: "result", subtype: "success", session_id: "sdk-expert-missing", is_error: false },
      ]) }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "completed",
      resultJson: expect.stringContaining('"turn_outcome":"completed"'),
    }));
    expect(JSON.parse(store.getTask(task.id)!.resultJson!)).toEqual(expect.objectContaining({
      summary: "Expert turn completed without a final message; review the session transcript before judging completion.",
    }));
    expect(store.listAgentSessions(flow.id)[0]?.status).toBe("completed");
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentSessionId: session.id,
        eventType: "agent_session.turn_completed",
        payloadJson: expect.stringContaining('"sdk_session_id":"sdk-expert-missing"'),
      }),
    ]));
  });

  it("fails the task with an errored turn outcome when the SDK turn ends in error", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => createQuery([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sdk-expert-frontend",
          is_error: true,
        },
      ]) }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "failed",
      errorMessage: expect.stringContaining("error_during_execution"),
    }));
    expect(JSON.parse(store.getTask(task.id)!.resultJson!)).toEqual(expect.objectContaining({
      turn_outcome: "errored",
    }));
    expect(store.listAgentSessions(flow.id)[0]?.status).toBe("failed");
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentSessionId: session.id,
        eventType: "agent_session.turn_completed",
        payloadJson: expect.stringContaining('"sdk_session_id":"sdk-expert-frontend"'),
      }),
    ]));
  });

  it("passes expert tool authorization into the SDK permission callback", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    store.updateFlow(flow.id, { riskMode: "full_access" });
    let captured: ClaudeQueryInput | null = null;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        return createQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-expert-backend",
            is_error: false,
          },
        ]);
      } }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    await expect(
      captured?.options?.canUseTool?.("Write", { file_path: "hello.html" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "hello.html" } });
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: 'echo -n "should_not_exist" > /tmp/squadflow-expert-boundary.txt' },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Bash 写操作必须落在项目或授权可写目录内。",
    });
    await expect(
      captured?.options?.canUseTool?.("mcp__unknown__tool", {}, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "tool not allowed by expert: mcp__unknown__tool",
    });
  });

  it("waits on an auto-edit risk card and denies when the UserTurn is cancelled", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    let captured: ClaudeQueryInput | null = null;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        return createQuery([{
          type: "result",
          subtype: "success",
          session_id: "sdk-expert-manual",
          is_error: false,
        }]);
      } }),
    });

    await runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: task.id, agentSessionId: session.id });
    const canUseTool = captured?.options?.canUseTool;
    if (!canUseTool) throw new Error("expected Expert permission callback");
    const permissionPromise = canUseTool(
      "Bash",
      { command: "rm -rf hello" },
      { signal: new AbortController().signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const card = store.listDecisionCards(flow.id).find((item) => item.cardType === "permission_confirmation");
    expect(card).toEqual(expect.objectContaining({ status: "pending", userTurnId: userTurn.id }));

    runtime.cancelUserTurn({ flowId: flow.id, userTurnId: userTurn.id });
    await expect(permissionPromise).resolves.toEqual({
      behavior: "deny",
      message: "用户已停止当前 UserTurn，未确认的风险操作已拒绝。",
    });
    expect(store.getDecisionCard(card!.id)?.status).toBe("cancelled");
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied")).toHaveLength(0);
    await runtime.close?.();
  });

  it("distinguishes card cancellation and runtime close from explicit denial memory", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    const cwd = store.getProject(flow.projectId!)!.localPath;
    const command = "rm runtime-close-target";
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory(),
    });
    const permission = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope: { kind: "expert_task", taskId: task.id, agentSessionId: session.id },
      request: {
        capability: "shell",
        providerToolName: "Bash",
        input: { command },
        providerInput: { command },
        context: { toolUseId: "tool-runtime-close" },
      },
      permissionArgs: {
        toolName: "Bash",
        capability: "shell",
        input: { command },
        providerInput: { command },
        cwd,
        readableDirs: [cwd],
        writableDirs: [cwd],
        authorizedCapabilities: new Set(["shell"]),
        authorizedTools: new Set(["Bash"]),
        riskMode: "auto_edit",
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cancelledCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    await runtime.resolvePermissionCard({
      flowId: flow.id,
      cardId: cancelledCard.id,
      outcome: "card_cancelled",
    });

    await expect(permission).resolves.toEqual({
      behavior: "deny",
      message: "用户已取消当前风险确认，操作已拒绝；当前 Task 或 UserTurn 可继续。",
    });
    expect(store.getDecisionCard(cancelledCard.id)?.answers).toBeNull();
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied")).toHaveLength(0);

    const runtimeClosePermission = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope: { kind: "expert_task", taskId: task.id, agentSessionId: session.id },
      request: {
        capability: "shell",
        providerToolName: "Bash",
        input: { command },
        providerInput: { command },
        context: { toolUseId: "tool-runtime-close-retry" },
      },
      permissionArgs: {
        toolName: "Bash",
        capability: "shell",
        input: { command },
        providerInput: { command },
        cwd,
        readableDirs: [cwd],
        writableDirs: [cwd],
        authorizedCapabilities: new Set(["shell"]),
        authorizedTools: new Set(["Bash"]),
        riskMode: "auto_edit",
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.listDecisionCards(flow.id).filter((card) => card.status === "pending")).toHaveLength(1);
    await runtime.close?.();

    await expect(runtimeClosePermission).resolves.toEqual({
      behavior: "deny",
      message: "Runtime 已关闭或重启，未确认的风险操作已拒绝。",
    });
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied")).toHaveLength(0);
  });

  it("keeps an unanswered risk card pending without a timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = tempStore();
      const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
      let captured: ClaudeQueryInput | null = null;
      const runtime = createExpertRuntime({
        store,
        eventBus: new EventBus(),
        chatJournal: new ChatJournal(),
        runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
          captured = input;
          return createQuery([{
            type: "result",
            subtype: "success",
            session_id: "sdk-expert-timeout",
            is_error: false,
          }]);
        } }),
      });

      await runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: task.id, agentSessionId: session.id });
      const canUseTool = captured?.options?.canUseTool;
      if (!canUseTool) throw new Error("expected Expert permission callback");
      const permissionPromise = canUseTool(
        "Bash",
        { command: "rm -rf hello" },
        { signal: new AbortController().signal },
      );
      await vi.advanceTimersByTimeAsync(0);
      const card = store.listDecisionCards(flow.id).find((item) => item.cardType === "permission_confirmation");
      expect(card?.status).toBe("pending");

      let settled = false;
      void permissionPromise.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(settled).toBe(false);
      expect(store.getDecisionCard(card!.id)?.status).toBe("pending");
      await runtime.resolvePermissionCard({ flowId: flow.id, cardId: card!.id, outcome: "user_denied" });
      await expect(permissionPromise).resolves.toEqual({
        behavior: "deny",
        message: expect.stringContaining("用户已明确拒绝执行该风险命令：rm -rf hello"),
      });
      expect(store.getDecisionCard(card!.id)?.status).toBe("cancelled");
      await runtime.close?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers only an exactly matching user-denied command in the same Task across runtime restart", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    const cwd = store.getProject(flow.projectId!)!.localPath;
    const permissionArgs = (command: string) => ({
      toolName: "Bash",
      capability: "shell" as const,
      input: { command },
      providerInput: { command },
      cwd,
      readableDirs: [cwd],
      writableDirs: [cwd],
      authorizedCapabilities: new Set(["shell" as const]),
      authorizedTools: new Set(["Bash"]),
      riskMode: "auto_edit" as const,
    });
    const request = (command: string) => ({
      capability: "shell" as const,
      providerToolName: "Bash",
      input: { command },
      providerInput: { command },
      context: { toolUseId: `tool-${command}` },
    });
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory(),
    });
    const scope = { kind: "expert_task" as const, taskId: task.id, agentSessionId: session.id };

    const first = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope,
      request: request("rm target"),
      permissionArgs: permissionArgs("rm target"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: firstCard.id, outcome: "user_denied" });
    await expect(first).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("不得在当前 Task 中再次请求或重试完全相同的命令"),
    });
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: task.id,
        agentSessionId: session.id,
        eventType: "permission_command.user_denied",
        payloadJson: expect.stringContaining('"scope_kind":"expert_task"'),
      }),
    ]));
    expect(JSON.parse(store.getDecisionCard(firstCard.id)?.answers ?? "null")).toEqual({
      permission: "拒绝当前命令",
    });
    expect(store.getTask(task.id)?.status).toBe("in_progress");

    const cardCount = store.listDecisionCards(flow.id).length;
    await expect(runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope,
      request: request("rm target"),
      permissionArgs: permissionArgs("rm target"),
    })).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("本次已自动拒绝且不会再次询问用户"),
    });
    expect(store.listDecisionCards(flow.id)).toHaveLength(cardCount);

    const otherCwd = path.join(cwd, "nested");
    const differentCwd = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope,
      request: request("rm target"),
      permissionArgs: { ...permissionArgs("rm target"), cwd: otherCwd },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const differentCwdCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    expect(differentCwdCard).toBeDefined();
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: differentCwdCard.id, outcome: "approved" });
    await expect(differentCwd).resolves.toEqual({ behavior: "allow" });

    const different = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope,
      request: request("rm  target"),
      permissionArgs: permissionArgs("rm  target"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const differentCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    expect(differentCard).toBeDefined();
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: differentCard.id, outcome: "approved" });
    await expect(different).resolves.toEqual({ behavior: "allow" });
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied")).toHaveLength(1);
    await runtime.close?.();

    const restarted = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory(),
    });
    await expect(restarted.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope,
      request: request("rm target"),
      permissionArgs: permissionArgs("rm target"),
    })).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("本次已自动拒绝且不会再次询问用户"),
    });
    await restarted.close?.();
  });

  it("scopes an exact command denial to the current Leader UserTurn", async () => {
    const store = tempStore();
    const { flow, userTurn } = createRunningTask(store, "exp-coder");
    const cwd = store.getProject(flow.projectId!)!.localPath;
    const command = "rm leader-target";
    const request = {
      capability: "shell" as const,
      providerToolName: "Bash",
      input: { command },
      providerInput: { command },
      context: { toolUseId: "tool-leader-denial" },
    };
    const permissionArgs = {
      toolName: "Bash",
      capability: "shell" as const,
      input: { command },
      providerInput: { command },
      cwd,
      readableDirs: [cwd],
      writableDirs: [cwd],
      authorizedCapabilities: new Set(["shell" as const]),
      authorizedTools: new Set(["Bash"]),
      riskMode: "auto_edit" as const,
    };
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory(),
    });

    const first = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope: { kind: "leader_user_turn" },
      request,
      permissionArgs,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: firstCard.id, outcome: "user_denied" });
    await expect(first).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("当前 UserTurn"),
    });
    expect(store.listEventLog(flow.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userTurnId: userTurn.id,
        taskId: null,
        eventType: "permission_command.user_denied",
        payloadJson: expect.stringContaining('"scope_kind":"leader_user_turn"'),
      }),
    ]));

    const cardCount = store.listDecisionCards(flow.id).length;
    await expect(runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: userTurn.id,
      scope: { kind: "leader_user_turn" },
      request,
      permissionArgs,
    })).resolves.toEqual({
      behavior: "deny",
      message: expect.stringContaining("不会再次询问用户"),
    });
    expect(store.listDecisionCards(flow.id)).toHaveLength(cardCount);

    store.completeUserTurn(userTurn.id);
    const nextTurn = createWorkingUserTurn(store, flow.id);
    const next = runtime.confirmPermission({
      flowId: flow.id,
      userTurnId: nextTurn.id,
      scope: { kind: "leader_user_turn" },
      request,
      permissionArgs,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const nextCard = store.listDecisionCards(flow.id).find((card) => card.status === "pending")!;
    expect(nextCard.userTurnId).toBe(nextTurn.id);
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: nextCard.id, outcome: "approved" });
    await expect(next).resolves.toEqual({ behavior: "allow" });
    await runtime.close?.();
  });

  it("cancels persisted permission cards on runtime restart", async () => {
    const store = tempStore();
    const { flow, userTurn } = createRunningTask(store, "exp-coder");
    const card = store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-permission-restart",
      sessionId: "tool-restart",
      cardType: "permission_confirmation",
      questions: [{
        header: "permission",
        question: "允许吗？",
        multiSelect: false,
        options: [{ label: "允许本次操作", description: "仅本次" }, { label: "拒绝当前命令", description: "拒绝" }],
      }],
    })!;

    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory(),
    });
    expect(store.getDecisionCard(card.id)?.status).toBe("cancelled");
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied")).toHaveLength(0);
    await runtime.close?.();
  });

  it("keeps verify Bash in read-only project mode", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-verify");
    let captured: ClaudeQueryInput | null = null;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        return createQuery([
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-expert-verify",
            is_error: false,
          },
        ]);
      } }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
    });

    const projectDir = store.getProject(flow.projectId!)!.localPath;
    expect(captured?.options?.cwd).toBe(projectDir);
    expect(captured?.options?.additionalDirectories).toEqual([]);
    await expect(
      captured?.options?.canUseTool?.(
        "Bash",
        { command: `cd ${projectDir} && echo hacked > app/page.tsx` },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Bash is running in read-only project mode; write operations are not allowed.",
    });
  });

  it("queues a Leader follow-up into the active Expert streaming session", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    const received: string[] = [];
    const chatJournal = new ChatJournal();
    let releaseFirst!: () => void;
    let markFirstReceived!: () => void;
    const firstReceived = new Promise<void>((resolve) => { markFirstReceived = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof input.prompt === "string") throw new Error("expected streaming input");
          let turn = 0;
          for await (const message of input.prompt) {
            received.push(sdkUserMessageText(message));
            if (turn === 0) {
              markFirstReceived();
              await firstRelease;
            }
            yield { type: "stream_event", event: { delta: { type: "text_delta", text: `done-${turn}` } } };
            yield {
              type: "result",
              subtype: "success",
              session_id: "sdk-expert-streaming",
              is_error: false,
            };
            turn += 1;
          }
        },
        close() {},
      }) }),
    });

    const running = runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
      prompt: "task_id: task-1\n---\nInitial implementation prompt\n---\nKeep this separator visible",
    });
    await firstReceived;

    expect(runtime.sendMessage({
      flowId: flow.id,
      agentSessionId: session.id,
      content: "Also preserve backwards compatibility",
    })).toBe(true);
    releaseFirst();
    await running;

    expect(parseMessageSegments(received[0] ?? "", flow.id)).toEqual([
      expect.objectContaining({
        kind: "event",
        type: "dispatch_env",
        attrs: expect.objectContaining({ write: "true" }),
      }),
      {
        kind: "user_text",
        raw: "task_id: task-1\n---\nInitial implementation prompt\n---\nKeep this separator visible",
      },
    ]);
    expect(parseMessageSegments(received[1] ?? "", flow.id)).toEqual([
      expect.objectContaining({
        kind: "event",
        type: "leader_message",
        body: "Also preserve backwards compatibility",
      }),
    ]);
    expect(chatJournal.getHistory(flow.id, "sdk-expert-streaming")
      .filter((message) => message.role === "user")
      .map((message) => message.content))
      .toEqual([
        "task_id: task-1\n---\nInitial implementation prompt\n---\nKeep this separator visible",
        "Also preserve backwards compatibility",
      ]);
    expect(store.getTask(task.id)).toEqual(expect.objectContaining({
      status: "completed",
      resultJson: expect.stringContaining('"summary":"done-1"'),
    }));
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "agent_session.turn_completed"))
      .toHaveLength(2);
  });

  it("uses the dispatch prompt instead of only the stored task description", async () => {
    const store = tempStore();
    const { flow, userTurn, task, session } = createRunningTask(store, "exp-coder");
    let captured: ClaudeQueryInput | null = null;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        captured = input;
        return createQuery([{
          type: "result",
          subtype: "success",
          session_id: "sdk-expert-frontend",
          is_error: false,
        }]);
      } }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      taskId: task.id,
      agentSessionId: session.id,
      prompt: "DISPATCH PROMPT CONTENT",
    });

    expect(await firstPromptText(captured!.prompt)).toContain("DISPATCH PROMPT CONTENT");
  });

  it("uses one active SDK query for two queued tasks of the same Flow Expert", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-shared", name: "Shared" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second" });
    const queryInputs: ClaudeQueryInput[] = [];
    const received: string[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        queryInputs.push(input);
        return {
          async *[Symbol.asyncIterator]() {
            if (typeof input.prompt === "string") throw new Error("expected streaming input");
            let index = 0;
            for await (const message of input.prompt) {
              received.push(sdkUserMessageText(message));
              yield {
                type: "result",
                subtype: "success",
                session_id: "sdk-flow-expert-frontend",
                is_error: false,
              };
              index += 1;
            }
          },
          close() {},
        };
      } }),
    });

    await Promise.all([
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id, prompt: "task one" }),
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id, prompt: "task two" }),
    ]);

    expect(queryInputs).toHaveLength(1);
    expect(received).toHaveLength(2);
    expect(store.getTask(first.task.id)?.status).toBe("completed");
    expect(store.getTask(second.task.id)?.status).toBe("completed");
    expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBe("sdk-flow-expert-frontend");
  });

  it("uses the active Task permission scope across queued tasks on one FlowExpertWorker", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-permission-scope", name: "Permission Scope" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first permission task" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second permission task" });
    const permissionResults: unknown[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (queryInput) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof queryInput.prompt === "string") throw new Error("expected streaming input");
          for await (const message of queryInput.prompt) {
            sdkUserMessageText(message);
            const result = await queryInput.options?.canUseTool?.(
              "Bash",
              { command: "rm shared-target" },
              { signal: new AbortController().signal },
            );
            permissionResults.push(result);
            yield {
              type: "result",
              subtype: "success",
              session_id: "sdk-permission-scope",
              is_error: false,
            };
          }
        },
        close() {},
      }) }),
    });
    const waitForNewPendingCard = async (seen: Set<string>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const card = store.listDecisionCards(flow.id).find((item) => item.status === "pending" && !seen.has(item.id));
        if (card) return card;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for permission card: ${JSON.stringify(permissionResults)}`);
    };

    const running = Promise.all([
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id }),
      runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id }),
    ]);
    const seen = new Set<string>();
    const firstCard = await waitForNewPendingCard(seen);
    seen.add(firstCard.id);
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: firstCard.id, outcome: "user_denied" });
    const secondCard = await waitForNewPendingCard(seen);
    seen.add(secondCard.id);
    await runtime.resolvePermissionCard({ flowId: flow.id, cardId: secondCard.id, outcome: "user_denied" });
    await running;

    expect(permissionResults).toEqual([
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining("用户已明确拒绝") }),
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining("用户已明确拒绝") }),
    ]);
    expect(store.listEventLog(flow.id).filter((event) => event.eventType === "permission_command.user_denied").map((event) => event.taskId))
      .toEqual([first.task.id, second.task.id]);
    await runtime.close?.();
  });

  it("resumes the stable SDK session for a later task after natural release", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-resume", name: "Resume" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second" });
    const inputs: ClaudeQueryInput[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        inputs.push(input);
        return createQuery([{ type: "result", subtype: "success", session_id: "sdk-stable", is_error: false }]);
      } }),
    });

    await runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id, prompt: "first" });
    await runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id, prompt: "second" });

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.options?.resume).toBe("sdk-stable");
    expect(store.getTask(second.task.id)?.status).toBe("completed");
  });

  it("keeps read-only FlowExpert SDK sessions on the stable project cwd across UserTurns", async () => {
    const store = tempStore();
    const { flow, projectRoot } = createFlowWithProject(store, { id: "flow-readonly-resume", name: "Readonly Resume" });
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-verify" });
    const firstExecution = createWorkingUserTurn(store, flow.id)!;
    const first = createAssignedTaskForFlowExpert(store, {
      flowId: flow.id,
      userTurnId: firstExecution.id,
      expertId: "exp-verify",
      flowExpertId: flowExpert.id,
      title: "first verify",
    });
    const inputs: ClaudeQueryInput[] = [];
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: (input) => {
        inputs.push(input);
        return createQuery([{ type: "result", subtype: "success", session_id: "sdk-stable-readonly", is_error: false }]);
      } }),
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: firstExecution.id,
      taskId: first.task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: first.session.id,
      prompt: "first",
    });
    store.completeUserTurn(firstExecution.id);
    const secondExecution = createWorkingUserTurn(store, flow.id)!;
    const second = createAssignedTaskForFlowExpert(store, {
      flowId: flow.id,
      userTurnId: secondExecution.id,
      expertId: "exp-verify",
      flowExpertId: flowExpert.id,
      title: "second verify",
    });

    await runtime.runTask({
      flowId: flow.id,
      userTurnId: secondExecution.id,
      taskId: second.task.id,
      flowExpertId: flowExpert.id,
      agentSessionId: second.session.id,
      prompt: "second",
    });

    const projectDir = projectRoot;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.options?.cwd).toBe(projectDir);
    expect(inputs[1]?.options?.cwd).toBe(projectDir);
    expect(inputs[1]?.options?.resume).toBe("sdk-stable-readonly");
    expect(inputs[1]?.options?.cwd).not.toContain(secondExecution.id);
  });

  it("waits for a draining stream before starting the next SDK query", async () => {
    const store = tempStore();
    const { flow } = createFlowWithProject(store, { id: "flow-draining", name: "Draining" });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    const first = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "first" });
    const second = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "second" });
    let releaseFirst!: () => void;
    const firstMayExit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let queryCount = 0;
    const runtime = createExpertRuntime({
      store,
      eventBus: new EventBus(),
      chatJournal: new ChatJournal(),
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ expertQuery: () => ({
        async *[Symbol.asyncIterator]() {
          queryCount += 1;
          yield { type: "result", subtype: "success", session_id: "sdk-draining", is_error: false };
          if (queryCount === 1) await firstMayExit;
        },
        close() {},
      }) }),
    });

    await runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: first.task.id, flowExpertId: flowExpert.id, agentSessionId: first.session.id, prompt: "first" });
    const secondRun = runtime.runTask({ flowId: flow.id, userTurnId: userTurn.id, taskId: second.task.id, flowExpertId: flowExpert.id, agentSessionId: second.session.id, prompt: "second" });
    await Promise.resolve();
    expect(queryCount).toBe(1);
    releaseFirst();
    await secondRun;
    expect(queryCount).toBe(2);
    expect(store.getTask(second.task.id)?.status).toBe("completed");
  });

  it("recovers queued and interrupted Flow Expert tasks in dispatch order", () => {
    const store = tempStore();
    const flow = store.createFlow({ id: "flow-recovery", workspaceId: "ws-default", name: "Recovery", description: "", projectId: null });
    const userTurn = createWorkingUserTurn(store, flow.id)!;
    const flowExpert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
    store.updateFlowExpertSession(flowExpert.id, "sdk-existing");
    const queued = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "queued" });
    const interrupted = createAssignedTaskForFlowExpert(store, { flowId: flow.id, userTurnId: userTurn.id, expertId: "exp-coder", flowExpertId: flowExpert.id, title: "interrupted" });
    store.activateFlowExpertTask(interrupted.task.id, interrupted.session.id);

    const work = store.recoverFlowExpertRuntimeWork();

    expect(work.map((item) => item.taskId)).toEqual([queued.task.id, interrupted.task.id]);
    expect(work[0]).toEqual(expect.objectContaining({ prompt: "queued", resumeSessionId: "sdk-existing" }));
    expect(work[1]?.prompt).toContain(`继续任务 ${interrupted.task.id}`);
    expect(store.getTask(interrupted.task.id)?.status).toBe("recovery_pending");
    expect(store.getAgentSession(interrupted.session.id)?.status).toBe("interrupted");
    expect(store.getFlowExpert(flowExpert.id)?.sdkSessionId).toBe("sdk-existing");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerPool,
  createCodexPoolProcessOptionsResolver,
  stripCodexProcessConfigArgs,
} from "../src/runtime/adapters/codexAppServerPool.js";
import type {
  CodexAppServerClientOptions,
  CodexAppServerTransport,
  CodexJsonRpcMessage,
} from "../src/runtime/adapters/codexAppServerClient.js";

class FakeCore implements CodexAppServerTransport {
  start = vi.fn(async () => {});
  close = vi.fn(() => this.finish());
  notify = vi.fn();
  respond = vi.fn();
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  private readonly events: CodexJsonRpcMessage[] = [];
  private waiter: ((result: IteratorResult<CodexJsonRpcMessage>) => void) | null = null;
  private closed = false;
  private nextThread = 1;
  private nextTurn = 1;

  async request(method: string, params?: unknown) {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: `thread-${this.nextThread++}` } };
    }
    if (method === "turn/start") return { turn: { id: `turn-${this.nextTurn++}` } };
    return {};
  }

  push(message: CodexJsonRpcMessage) {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
      return;
    }
    this.events.push(message);
  }

  async *notifications(): AsyncIterable<CodexJsonRpcMessage> {
    while (true) {
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<CodexJsonRpcMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter({ value: undefined, done: true });
  }
}

function createPool() {
  const cores: FakeCore[] = [];
  const processOptions: CodexAppServerClientOptions[] = [];
  const pool = new CodexAppServerPool({
    coreFactory: (options) => {
      processOptions.push(options);
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    resolveProcessOptions: (_kind, requested) => requested,
  });
  return { pool, cores, processOptions };
}

describe("CodexAppServerPool", () => {
  it("reuses one process and isolates concurrent thread notifications", async () => {
    const { pool, cores } = createPool();
    const factory = pool.clientFactory("custom");
    const first = factory({ command: "codex", args: ["app-server"] });
    const second = factory({ command: "codex", args: ["app-server"] });

    await Promise.all([first.start(), second.start()]);
    expect(cores).toHaveLength(1);
    expect(cores[0]!.start).toHaveBeenCalledTimes(1);

    const firstThread = await first.request("thread/start", {});
    const secondThread = await second.request("thread/start", {});
    expect(firstThread).toEqual({ thread: { id: "thread-1" } });
    expect(secondThread).toEqual({ thread: { id: "thread-2" } });

    const firstEvents = first.notifications()[Symbol.asyncIterator]();
    const secondEvents = second.notifications()[Symbol.asyncIterator]();
    const firstNext = firstEvents.next();
    const secondNext = secondEvents.next();
    cores[0]!.push({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: "second" },
    });
    cores[0]!.push({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "first" },
    });

    await expect(firstNext).resolves.toMatchObject({ value: { params: { delta: "first" } } });
    await expect(secondNext).resolves.toMatchObject({ value: { params: { delta: "second" } } });

    first.close();
    expect(cores[0]!.close).not.toHaveBeenCalled();
    second.close();
    expect(cores[0]!.close).not.toHaveBeenCalled();

    pool.close();
    expect(cores[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("isolates a pooled Namer thread from Leader and drops its late scoped notifications", async () => {
    const { pool, cores } = createPool();
    const factory = pool.clientFactory("official");
    const namer = factory({ command: "codex", args: ["app-server"] });
    const leader = factory({ command: "codex", args: ["app-server"] });

    await Promise.all([namer.start(), leader.start()]);
    expect(cores).toHaveLength(1);
    const namerThread = await namer.request("thread/start", {}) as { thread: { id: string } };
    const leaderThread = await leader.request("thread/start", {}) as { thread: { id: string } };
    expect(namerThread.thread.id).not.toBe(leaderThread.thread.id);
    namer.close();
    expect(cores[0]!.close).not.toHaveBeenCalled();

    const leaderEvent = leader.notifications()[Symbol.asyncIterator]().next();
    cores[0]!.push({
      method: "turn/completed",
      params: {
        threadId: namerThread.thread.id,
        turn: { id: "turn-namer", status: "interrupted" },
      },
    });
    cores[0]!.push({
      method: "item/agentMessage/delta",
      params: { threadId: leaderThread.thread.id, delta: "leader" },
    });

    await expect(leaderEvent).resolves.toMatchObject({
      value: { params: { threadId: leaderThread.thread.id, delta: "leader" } },
    });
    leader.close();
    pool.close();
  });

  it("keeps exactly one current process per official/custom pool", async () => {
    const { pool, cores } = createPool();
    const official = pool.clientFactory("official")({ command: "external-codex" });
    const custom = pool.clientFactory("custom")({ command: "bundled-codex" });
    await Promise.all([official.start(), custom.start()]);

    expect(cores).toHaveLength(2);
    pool.close();
    expect(cores.every((core) => core.close.mock.calls.length === 1)).toBe(true);
  });

  it("routes server approval requests and responses to the owning turn", async () => {
    const { pool, cores } = createPool();
    const factory = pool.clientFactory("custom");
    const first = factory({ command: "codex" });
    const second = factory({ command: "codex" });
    await Promise.all([first.start(), second.start()]);
    await first.request("thread/start", {});
    const secondThread = await second.request("thread/start", {}) as { thread: { id: string } };
    await first.request("turn/start", {});
    const secondTurn = await second.request("turn/start", {}) as { turn: { id: string } };
    const secondEvent = second.notifications()[Symbol.asyncIterator]().next();

    cores[0]!.push({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: secondThread.thread.id,
        turnId: secondTurn.turn.id,
        command: "pwd",
      },
    });

    await expect(secondEvent).resolves.toMatchObject({
      value: { id: 91, method: "item/commandExecution/requestApproval" },
    });
    first.respond(91, { decision: "decline" });
    expect(cores[0]!.respond).not.toHaveBeenCalled();
    second.respond(91, { decision: "accept" });
    expect(cores[0]!.respond).toHaveBeenCalledWith(91, { decision: "accept" });
    pool.close();
  });

  it("drains an invalidated custom process before replacing it", async () => {
    const { pool, cores } = createPool();
    const factory = pool.clientFactory("custom");
    const active = factory({ command: "bundled-codex" });
    await active.start();

    pool.invalidate("custom");
    expect(cores[0]!.close).not.toHaveBeenCalled();

    const replacement = factory({ command: "bundled-codex" });
    await replacement.start();
    expect(cores).toHaveLength(2);

    active.close();
    expect(cores[0]!.close).toHaveBeenCalledTimes(1);
    expect(cores[1]!.close).not.toHaveBeenCalled();
    replacement.close();
    pool.close();
    expect(cores[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("removes per-thread -c overrides from the shared process command", () => {
    expect(stripCodexProcessConfigArgs([
      "app-server",
      "--stdio",
      "-c",
      "model=\"gpt-5\"",
      "--disable",
      "image_generation",
      "--config",
      "web_search=\"disabled\"",
    ])).toEqual([
      "app-server",
      "--stdio",
      "--disable",
      "image_generation",
    ]);
  });

  it("preloads custom provider credentials and the shared MCP credential into one process", () => {
    const resolve = createCodexPoolProcessOptionsResolver({
      getRuntimeConfigs: () => [{
        id: "provider-a",
        fileName: "provider-a.json",
        name: "Provider A",
        sdk: "codex",
        authMode: "apiKey",
        baseUrl: "https://provider.example/v1",
        apiKey: "sk-provider-a",
        models: [{ id: "model-a", name: "model-a" }],
      }],
      mcpCredential: { envVar: "SQUADFLOW_MCP_BRIDGE_TOKEN", token: "mcp-token" },
    });

    const options = resolve("custom", {
      command: "codex",
      args: ["app-server", "-c", "model=\"model-a\""],
      env: { PATH: "/usr/bin" },
      cwd: "/per-flow-cwd",
    });

    expect(options.args).toEqual(["app-server"]);
    expect(options.cwd).not.toBe("/per-flow-cwd");
    expect(options.env).toMatchObject({
      SQUADFLOW_CODEX_API_KEY_PROVIDER_A: "sk-provider-a",
      SQUADFLOW_MCP_BRIDGE_TOKEN: "mcp-token",
    });
    expect(options.env?.TMPDIR).toMatch(/codex-pool\/custom$/);
  });
});

import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import { codexApiKeyEnvName } from "./codexOptions.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerTransport,
  type CodexJsonRpcMessage,
} from "./codexAppServerClient.js";
import { codexPoolTempDir } from "./codexRuntimeProfile.js";

export type CodexAppServerPoolKind = "official" | "custom";

type CoreFactory = (options: CodexAppServerClientOptions) => CodexAppServerTransport;
type ProcessOptionsResolver = (
  kind: CodexAppServerPoolKind,
  requested: CodexAppServerClientOptions,
) => CodexAppServerClientOptions;

type PoolOptions = {
  coreFactory?: CoreFactory;
  resolveProcessOptions?: ProcessOptionsResolver;
};

type PoolEnvironmentOptions = {
  getRuntimeConfigs: () => RuntimeConfig[];
  mcpCredential: {
    envVar: string;
    token: string;
  };
};

class LeaseEventQueue implements AsyncIterable<CodexJsonRpcMessage> {
  private readonly messages: CodexJsonRpcMessage[] = [];
  private waiter: ((result: IteratorResult<CodexJsonRpcMessage>) => void) | null = null;
  private closed = false;

  push(message: CodexJsonRpcMessage) {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: message, done: false });
      return;
    }
    this.messages.push(message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<CodexJsonRpcMessage> {
    while (true) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
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
}

function requestId(value: unknown): string | number | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedString(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (!isRecord(value) || depth > 4) return null;
  for (const [key, candidate] of Object.entries(value)) {
    if (keys.has(key) && typeof candidate === "string" && candidate) return candidate;
  }
  for (const candidate of Object.values(value)) {
    const nested = nestedString(candidate, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const threadIdKeys = new Set(["threadId", "thread_id"]);
const turnIdKeys = new Set(["turnId", "turn_id"]);

function messageThreadId(message: CodexJsonRpcMessage): string | null {
  return nestedString(message.params, threadIdKeys);
}

function messageTurnId(message: CodexJsonRpcMessage): string | null {
  return nestedString(message.params, turnIdKeys)
    ?? (isRecord(message.params) && isRecord(message.params.turn) && typeof message.params.turn.id === "string"
      ? message.params.turn.id
      : null);
}

function resultThreadId(result: unknown): string | null {
  return isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string"
    ? result.thread.id
    : null;
}

function resultTurnId(result: unknown): string | null {
  return isRecord(result) && isRecord(result.turn) && typeof result.turn.id === "string"
    ? result.turn.id
    : null;
}

class CodexAppServerLease implements CodexAppServerTransport {
  readonly events = new LeaseEventQueue();
  readonly threadIds = new Set<string>();
  readonly turnIds = new Set<string>();
  closed = false;

  constructor(
    readonly id: number,
    private readonly slot: CodexAppServerSlot,
    readonly onStderrLine?: (line: string) => void,
  ) {}

  start() {
    return this.slot.start();
  }

  request(method: string, params?: unknown) {
    return this.slot.request(this, method, params);
  }

  notify(method: string, params?: unknown) {
    this.slot.notify(method, params);
  }

  respond(id: string | number, result: unknown) {
    this.slot.respond(this, id, result);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.events.close();
    this.slot.release(this);
  }

  notifications() {
    return this.events;
  }
}

class CodexAppServerSlot {
  private readonly core: CodexAppServerTransport;
  private readonly leases = new Set<CodexAppServerLease>();
  private readonly threadOwners = new Map<string, CodexAppServerLease>();
  private readonly turnOwners = new Map<string, CodexAppServerLease>();
  private readonly responseOwners = new Map<string | number, CodexAppServerLease>();
  private started: Promise<void> | null = null;
  private pump: Promise<void> | null = null;
  private closed = false;
  private retired = false;

  constructor(
    readonly kind: CodexAppServerPoolKind,
    requested: CodexAppServerClientOptions,
    coreFactory: CoreFactory,
    resolveProcessOptions: ProcessOptionsResolver,
    private readonly onEnded: (slot: CodexAppServerSlot) => void,
  ) {
    const processOptions = resolveProcessOptions(kind, requested);
    this.core = coreFactory({
      ...processOptions,
      onStderrLine: (line) => this.broadcastStderr(line),
    });
  }

  acquire(id: number, onStderrLine?: (line: string) => void) {
    if (this.closed || this.retired) throw new Error("Codex app-server pool slot is not available");
    const lease = new CodexAppServerLease(id, this, onStderrLine);
    this.leases.add(lease);
    return lease;
  }

  async start() {
    if (this.closed) throw new Error("Codex app-server pool slot is closed");
    if (!this.started) {
      this.started = this.core.start().then(() => {
        this.pump = this.pumpNotifications();
      }).catch((error) => {
        this.close();
        throw error;
      });
    }
    return this.started;
  }

  async request(lease: CodexAppServerLease, method: string, params?: unknown) {
    if (lease.closed) throw new Error("Codex app-server lease is closed");
    await this.start();
    const result = await this.core.request(method, params);
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      const threadId = resultThreadId(result);
      if (threadId) this.registerThread(lease, threadId);
    }
    if (method === "turn/start") {
      const turnId = resultTurnId(result);
      if (turnId) {
        lease.turnIds.add(turnId);
        this.turnOwners.set(turnId, lease);
      }
    }
    return result;
  }

  notify(method: string, params?: unknown) {
    if (this.closed) throw new Error("Codex app-server pool slot is closed");
    this.core.notify(method, params);
  }

  respond(lease: CodexAppServerLease, id: string | number, result: unknown) {
    if (this.closed || lease.closed) return;
    const owner = this.responseOwners.get(id);
    if (owner && owner !== lease) return;
    this.responseOwners.delete(id);
    this.core.respond(id, result);
  }

  release(lease: CodexAppServerLease) {
    this.leases.delete(lease);
    for (const threadId of lease.threadIds) {
      if (this.threadOwners.get(threadId) === lease) this.threadOwners.delete(threadId);
    }
    for (const turnId of lease.turnIds) {
      if (this.turnOwners.get(turnId) === lease) this.turnOwners.delete(turnId);
    }
    for (const [id, owner] of this.responseOwners) {
      if (owner === lease) this.responseOwners.delete(id);
    }
    if (this.retired && this.leases.size === 0) this.close();
  }

  retire() {
    if (this.retired) return;
    this.retired = true;
    if (this.leases.size === 0) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.core.close();
    for (const lease of this.leases) {
      lease.closed = true;
      lease.events.close();
    }
    this.leases.clear();
    this.threadOwners.clear();
    this.turnOwners.clear();
    this.responseOwners.clear();
    this.onEnded(this);
  }

  private registerThread(lease: CodexAppServerLease, threadId: string) {
    const existing = this.threadOwners.get(threadId);
    if (existing && existing !== lease && !existing.closed) {
      throw new Error(`Codex thread is already active in another runtime stream: ${threadId}`);
    }
    lease.threadIds.add(threadId);
    this.threadOwners.set(threadId, lease);
  }

  private async pumpNotifications() {
    try {
      for await (const message of this.core.notifications()) {
        if (this.closed) return;
        this.routeNotification(message);
      }
    } finally {
      if (!this.closed) this.close();
    }
  }

  private routeNotification(message: CodexJsonRpcMessage) {
    const turnId = messageTurnId(message);
    const threadId = messageThreadId(message);
    const owner = (turnId ? this.turnOwners.get(turnId) : null)
      ?? (threadId ? this.threadOwners.get(threadId) : null)
      ?? null;
    const id = requestId(message.id);
    if (owner && !owner.closed) {
      if (id !== null && typeof message.method === "string") this.responseOwners.set(id, owner);
      owner.events.push(message);
      return;
    }

    // A scoped notification without a live owner belongs to a lease that has
    // already closed. Never broadcast late thread/turn events into another
    // active runtime stream.
    if (threadId || turnId) return;

    const activeLeases = [...this.leases].filter((lease) => !lease.closed);
    if (id !== null && typeof message.method === "string" && activeLeases.length === 1) {
      this.responseOwners.set(id, activeLeases[0]!);
      activeLeases[0]!.events.push(message);
      return;
    }
    for (const lease of activeLeases) lease.events.push(message);
  }

  private broadcastStderr(line: string) {
    for (const lease of this.leases) lease.onStderrLine?.(line);
  }
}

export class CodexAppServerPool {
  private readonly coreFactory: CoreFactory;
  private readonly resolveProcessOptions: ProcessOptionsResolver;
  private readonly slots = new Map<CodexAppServerPoolKind, CodexAppServerSlot>();
  private readonly retiredSlots = new Set<CodexAppServerSlot>();
  private nextLeaseId = 1;
  private closed = false;

  constructor(options: PoolOptions = {}) {
    this.coreFactory = options.coreFactory ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.resolveProcessOptions = options.resolveProcessOptions ?? ((_kind, requested) => requested);
  }

  clientFactory(kind: CodexAppServerPoolKind) {
    return (requested: CodexAppServerClientOptions): CodexAppServerTransport => {
      if (this.closed) throw new Error("Codex app-server pool is closed");
      let slot = this.slots.get(kind);
      if (!slot) {
        slot = new CodexAppServerSlot(
          kind,
          requested,
          this.coreFactory,
          this.resolveProcessOptions,
          (ended) => this.handleEnded(ended),
        );
        this.slots.set(kind, slot);
      }
      return slot.acquire(this.nextLeaseId++, requested.onStderrLine);
    };
  }

  invalidate(kind: CodexAppServerPoolKind) {
    const slot = this.slots.get(kind);
    if (!slot) return;
    this.slots.delete(kind);
    this.retiredSlots.add(slot);
    slot.retire();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots.values()) slot.close();
    for (const slot of this.retiredSlots) slot.close();
    this.slots.clear();
    this.retiredSlots.clear();
  }

  private handleEnded(slot: CodexAppServerSlot) {
    if (this.slots.get(slot.kind) === slot) this.slots.delete(slot.kind);
    this.retiredSlots.delete(slot);
  }
}

export function codexPoolKindForRuntimeConfig(
  runtimeConfig: Pick<RuntimeConfig, "authMode"> | undefined,
): CodexAppServerPoolKind {
  return runtimeConfig?.authMode === "inherited" ? "official" : "custom";
}

export function stripCodexProcessConfigArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "--config") {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function createCodexPoolProcessOptionsResolver(
  options: PoolEnvironmentOptions,
): ProcessOptionsResolver {
  return (kind, requested) => {
    const env = { ...(requested.env ?? process.env) };
    env[options.mcpCredential.envVar] = options.mcpCredential.token;

    if (kind === "custom") {
      const accessTokens = new Set<string>();
      for (const runtimeConfig of options.getRuntimeConfigs()) {
        if (runtimeConfig.sdk !== "codex") continue;
        if (runtimeConfig.authMode === "apiKey" && runtimeConfig.apiKey.trim()) {
          env[codexApiKeyEnvName(runtimeConfig)] = runtimeConfig.apiKey.trim();
        } else if (runtimeConfig.authMode === "accessToken" && runtimeConfig.apiKey.trim()) {
          accessTokens.add(runtimeConfig.apiKey.trim());
        }
      }
      if (accessTokens.size > 1) {
        throw new Error("多个不同的 Codex Access Token 不能共享同一个非官方 app-server");
      }
      const [accessToken] = accessTokens;
      if (accessToken) env.CODEX_ACCESS_TOKEN = accessToken;
    }

    const tempDir = codexPoolTempDir(kind);
    fs.mkdirSync(tempDir, { recursive: true });
    env.TMPDIR = tempDir;
    env.TMP = tempDir;
    env.TEMP = tempDir;

    return {
      command: requested.command,
      args: stripCodexProcessConfigArgs(requested.args),
      env,
      cwd: config.workspaceRoot,
    };
  };
}

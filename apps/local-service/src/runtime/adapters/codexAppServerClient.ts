import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { ProviderRequestError } from "./runtimeErrors.js";

export type CodexJsonRpcMessage = Record<string, unknown>;

export type CodexAppServerClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onStderrLine?: (line: string) => void;
};

export type CodexAppServerTransport = {
  start: () => Promise<void>;
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  respond: (id: string | number, result: unknown) => void;
  close: () => void;
  notifications: () => AsyncIterable<CodexJsonRpcMessage>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerClient implements CodexAppServerTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private closed = false;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly pendingRequestParams = new Map<string | number, { method: string; params?: unknown }>();
  private readonly events: CodexJsonRpcMessage[] = [];
  private eventWaiter: ((value: IteratorResult<CodexJsonRpcMessage>) => void) | null = null;
  private stderrRemainder = "";

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start() {
    if (this.initialized) return this.initialized;
    this.initialized = this.startInner();
    return this.initialized;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.pendingRequestParams.set(id, { method, params });
      this.send(message);
    });
  }

  notify(method: string, params?: unknown) {
    const message = params === undefined ? { method } : { method, params };
    this.send(message);
  }

  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    this.proc?.kill();
    this.rejectAll(new Error("Codex app-server client closed"));
    this.resolveEventWaiterDone();
  }

  async *notifications(): AsyncIterable<CodexJsonRpcMessage> {
    while (true) {
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<CodexJsonRpcMessage>>((resolve) => {
        this.eventWaiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  private async startInner() {
    const args = this.options.args ?? ["app-server", "--stdio"];
    this.proc = spawn(this.options.command ?? "codex", args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.fail(new Error(`Codex app-server exited with ${detail}`));
    });
    this.proc.once("error", (error) => {
      this.fail(error);
    });
    this.proc.stderr.on("data", (chunk) => {
      // app-server stderr is diagnostic-only; JSON-RPC data stays on stdout.
      // Keep the callback optional so normal runs do not add another logging sink.
      if (!this.options.onStderrLine) return;
      const text = `${this.stderrRemainder}${String(chunk)}`;
      const lines = text.split(/\r?\n/);
      this.stderrRemainder = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.options.onStderrLine(trimmed);
      }
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.requestRaw("initialize", {
      clientInfo: {
        name: "squadflow",
        title: "SquadFlow",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.notify("initialized", {});
  }

  private requestRaw(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private send(message: unknown) {
    if (this.closed || !this.proc) throw new Error("Codex app-server client is closed");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    let message: CodexJsonRpcMessage;
    try {
      message = JSON.parse(line) as CodexJsonRpcMessage;
    } catch {
      return;
    }
    const id = requestId(message.id);
    if (id !== null) {
      if (typeof message.method === "string") {
        this.pushEvent(message);
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: unknown; code?: unknown; data?: unknown };
        const request = this.pendingRequestParams.get(id);
        this.pendingRequestParams.delete(id);
        const params = request?.params && typeof request.params === "object" ? request.params as Record<string, unknown> : undefined;
        pending.reject(new ProviderRequestError({
          provider: "codex",
          method: request?.method ?? "unknown",
          code: typeof error.code === "string" || typeof error.code === "number" ? error.code : null,
          message: typeof error.message === "string" ? error.message : `Codex app-server request failed: ${String(error.code)}`,
          data: error.data,
          requestedSessionId: typeof params?.threadId === "string" ? params.threadId : null,
        }));
      } else {
        this.pendingRequestParams.delete(id);
        pending.resolve(message.result);
      }
      return;
    }
    this.pushEvent(message);
  }

  private pushEvent(message: CodexJsonRpcMessage) {
    if (this.eventWaiter) {
      const waiter = this.eventWaiter;
      this.eventWaiter = null;
      waiter({ value: message, done: false });
    } else {
      this.events.push(message);
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    this.rejectAll(error);
    this.resolveEventWaiterDone();
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.pendingRequestParams.clear();
  }

  private resolveEventWaiterDone() {
    if (!this.eventWaiter) return;
    const waiter = this.eventWaiter;
    this.eventWaiter = null;
    waiter({ value: undefined, done: true });
  }
}

function requestId(value: unknown): string | number | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

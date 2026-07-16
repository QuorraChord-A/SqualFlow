import crypto from "node:crypto";

export type DesktopBridgeConnection = {
  send: (data: string) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type BrowserLease = {
  flowId: string;
  agentSessionId: string;
  holderName: string;
  since: string;
};

export type LeaseAcquireResult = { ok: true } | { ok: false; heldBy: string; reason: "busy" | "revoked" };

const DEFAULT_TIMEOUT_MS = 15000;
const NAVIGATE_TIMEOUT_MS = 30000;
const NAVIGATE_COMMANDS = new Set(["navigate", "reload"]);

export class DesktopBridge {
  private connection: DesktopBridgeConnection | null = null;
  private connectionId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private lease: BrowserLease | null = null;
  private readonly revokedSessionIds = new Set<string>();
  private readonly leaseChangeHandlers = new Set<(lease: BrowserLease | null) => void>();

  isConnected(): boolean {
    return this.connection !== null;
  }

  connect(connection: DesktopBridgeConnection): number {
    this.rejectAllPending(new Error("desktop bridge reconnected"));
    this.connection = connection;
    this.connectionId += 1;
    this.syncLeaseToConnection();
    return this.connectionId;
  }

  disconnect(connectionId: number) {
    if (this.connectionId !== connectionId) return;
    this.connection = null;
    this.rejectAllPending(new Error("desktop bridge disconnected"));
  }

  private rejectAllPending(error: Error) {
    for (const [id, pendingRequest] of this.pending) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
      this.pending.delete(id);
    }
  }

  handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    if (message.type !== "response") return;
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return;
    this.pending.delete(id);
    clearTimeout(pendingRequest.timeout);
    if (message.ok) {
      pendingRequest.resolve(message.result);
    } else {
      pendingRequest.reject(new Error(typeof message.error === "string" ? message.error : "desktop bridge request failed"));
    }
  }

  async request(command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (!this.connection) {
      throw new Error("desktop 不可用：未检测到已连接的 Electron 客户端");
    }
    const connection = this.connection;
    const id = crypto.randomUUID();
    const requestTimeoutMs = timeoutMs ?? (NAVIGATE_COMMANDS.has(command) ? NAVIGATE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop bridge request timed out: ${command}`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      connection.send(JSON.stringify({ type: "request", id, command, params }));
    });
  }

  acquireLease(agentSessionId: string, holderName: string, flowId: string): LeaseAcquireResult {
    if (this.revokedSessionIds.has(agentSessionId)) {
      return { ok: false, heldBy: "用户", reason: "revoked" };
    }
    if (this.lease && this.lease.agentSessionId !== agentSessionId) {
      return { ok: false, heldBy: this.lease.holderName, reason: "busy" };
    }
    if (!this.lease) {
      this.lease = { flowId, agentSessionId, holderName, since: new Date().toISOString() };
      this.notifyLeaseChange();
    }
    return { ok: true };
  }

  releaseLease(agentSessionId: string) {
    if (this.lease?.agentSessionId !== agentSessionId) return;
    this.lease = null;
    this.notifyLeaseChange();
  }

  reclaimLease(): void {
    if (this.lease) this.revokedSessionIds.add(this.lease.agentSessionId);
    this.lease = null;
    this.notifyLeaseChange();
  }

  getLease(): BrowserLease | null {
    return this.lease;
  }

  onLeaseChange(handler: (lease: BrowserLease | null) => void): () => void {
    this.leaseChangeHandlers.add(handler);
    return () => this.leaseChangeHandlers.delete(handler);
  }

  private notifyLeaseChange() {
    for (const handler of this.leaseChangeHandlers) handler(this.lease);
    this.syncLeaseToConnection();
  }

  private syncLeaseToConnection() {
    void this.request("lease_changed", { lease: this.lease }).catch(() => {});
  }
}

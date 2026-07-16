export type ContextCompactionStatus = "running" | "completed" | "failed";

export type ContextCompactionSnapshot = {
  flow_id: string;
  agent_session_id: string;
  sdk_session_id: string | null;
  role: string;
  expert_id: string | null;
  flow_expert_id: string | null;
  display_name: string;
  status: ContextCompactionStatus;
  started_at: string;
  updated_at: string;
  error_message: string | null;
};

export type StartContextCompactionInput = Omit<
  ContextCompactionSnapshot,
  "status" | "started_at" | "updated_at" | "error_message"
>;

export class ContextCompactionState {
  private readonly items = new Map<string, ContextCompactionSnapshot>();

  listFlow(flowId: string): ContextCompactionSnapshot[] {
    return [...this.items.values()].filter((item) => item.flow_id === flowId);
  }

  get(agentSessionId: string): ContextCompactionSnapshot | null {
    return this.items.get(agentSessionId) ?? null;
  }

  start(input: StartContextCompactionInput): ContextCompactionSnapshot {
    const existing = this.items.get(input.agent_session_id);
    if (existing?.status === "running") return existing;
    const now = new Date().toISOString();
    const snapshot: ContextCompactionSnapshot = {
      ...input,
      status: "running",
      started_at: now,
      updated_at: now,
      error_message: null,
    };
    this.items.set(input.agent_session_id, snapshot);
    return snapshot;
  }

  complete(agentSessionId: string): ContextCompactionSnapshot | null {
    return this.finish(agentSessionId, "completed");
  }

  fail(agentSessionId: string, error: string): ContextCompactionSnapshot | null {
    return this.finish(agentSessionId, "failed", error);
  }

  private finish(
    agentSessionId: string,
    status: "completed" | "failed",
    errorMessage: string | null = null,
  ): ContextCompactionSnapshot | null {
    const current = this.items.get(agentSessionId);
    if (!current) return null;
    const snapshot = {
      ...current,
      status,
      updated_at: new Date().toISOString(),
      error_message: errorMessage,
    };
    this.items.set(agentSessionId, snapshot);
    return snapshot;
  }
}

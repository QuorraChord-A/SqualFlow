export type ContextCompactionStatus = "running" | "completed" | "failed";

export type ContextCompactionSnapshot = {
  flow_id: string;
  agent_run_id: string;
  provider_session_id: string | null;
  role: string;
  agent_definition_id: string | null;
  agent_session_id: string | null;
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

  get(agentRunId: string): ContextCompactionSnapshot | null {
    return this.items.get(agentRunId) ?? null;
  }

  start(input: StartContextCompactionInput): ContextCompactionSnapshot {
    const existing = this.items.get(input.agent_run_id);
    if (existing?.status === "running") return existing;
    const now = new Date().toISOString();
    const snapshot: ContextCompactionSnapshot = {
      ...input,
      status: "running",
      started_at: now,
      updated_at: now,
      error_message: null,
    };
    this.items.set(input.agent_run_id, snapshot);
    return snapshot;
  }

  complete(agentRunId: string): ContextCompactionSnapshot | null {
    return this.finish(agentRunId, "completed");
  }

  fail(agentRunId: string, error: string): ContextCompactionSnapshot | null {
    return this.finish(agentRunId, "failed", error);
  }

  private finish(
    agentRunId: string,
    status: "completed" | "failed",
    errorMessage: string | null = null,
  ): ContextCompactionSnapshot | null {
    const current = this.items.get(agentRunId);
    if (!current) return null;
    const snapshot = {
      ...current,
      status,
      updated_at: new Date().toISOString(),
      error_message: errorMessage,
    };
    this.items.set(agentRunId, snapshot);
    return snapshot;
  }
}

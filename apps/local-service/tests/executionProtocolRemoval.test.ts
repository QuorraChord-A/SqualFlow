import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";
import { buildFlowSnapshot } from "../src/domain/flowSnapshot.js";
import { ClientWsMessageSchema, ServerWsMessageSchema } from "../src/protocol/wsMessages.js";
import { createApp } from "../src/server/app.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const stores: Array<ReturnType<typeof createStore>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.sqlite.close();
});

describe("Execution protocol removal", () => {
  it("accepts only the new interrupt actions and rejects removed cancellation messages", () => {
    expect(ClientWsMessageSchema.safeParse({
      type: "work_run:interrupt",
      flow_id: "flow-1",
      work_run_id: "wrn-1",
      expected_revision: 1,
      client_action_id: "action-1",
    }).success).toBe(true);
    expect(ClientWsMessageSchema.safeParse({
      type: "agent_session:interrupt",
      flow_id: "flow-1",
      agent_session_id: "ags-1",
      client_action_id: "action-2",
    }).success).toBe(true);
    expect(ClientWsMessageSchema.safeParse({ type: "work_run:cancel", flow_id: "flow-1", work_run_id: "wrn-1" }).success).toBe(false);
    expect(ClientWsMessageSchema.safeParse({ type: "execution:cancel", flow_id: "flow-1", execution_id: "exec-1" }).success).toBe(false);
  });

  it("rejects removed execution snapshot and event server messages", () => {
    expect(ServerWsMessageSchema.safeParse({ type: "execution:snapshot", flow_id: "flow-1", data: {} }).success).toBe(false);
    expect(ServerWsMessageSchema.safeParse({ type: "execution:event", flow_id: "flow-1", data: {} }).success).toBe(false);
  });

  it("builds a flat WorkRun snapshot with no Execution fields", () => {
    const store = createStore(":memory:");
    stores.push(store);
    store.migrate();
    const flow = store.createFlow({ name: "Flow", description: "", projectId: null });

    const snapshot = buildFlowSnapshot(store, flow.id) as Record<string, unknown>;

    expect(snapshot).toHaveProperty("current_work_run_id", null);
    expect(snapshot).toHaveProperty("tasks", []);
    expect(snapshot).not.toHaveProperty("active_execution_id");
    expect(snapshot).not.toHaveProperty("executions");
  });

  it("does not treat a user-waiting Flow as active execution", () => {
    const store = createStore(":memory:");
    stores.push(store);
    store.migrate();
    const flow = store.createFlow({ name: "Flow", description: "", projectId: null });
    const workRun = store.createWorkRun({ flowId: flow.id, triggerMessageId: "msg-1" })!;
    store.waitWorkRunForUserAction(workRun.id);

    expect(buildFlowSnapshot(store, flow.id)).toEqual(expect.objectContaining({
      status: "idle",
      has_active_execution: false,
    }));
  });

  it("returns 404 for the removed executions REST endpoint", async () => {
    const store = createStore(":memory:");
    stores.push(store);
    const app = createApp({ logger: false, store } as any);
    apps.push(app);
    const flow = store.createFlow({ name: "Flow", description: "", projectId: null });

    const response = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/executions` });

    expect(response.statusCode).toBe(404);
  });
});

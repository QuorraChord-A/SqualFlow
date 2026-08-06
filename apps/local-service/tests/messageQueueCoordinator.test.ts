import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/db/store.js";
import { MessageQueueCoordinator } from "../src/runtime/messageQueueCoordinator.js";
import { EventBus } from "../src/ws/eventBus.js";
import type { WsConnection } from "../src/server/wsGateway.js";

function createFlowStore(flowId: string) {
  const store = createStore(":memory:");
  store.migrate();
  store.seedExperts();
  store.createFlow({
    id: flowId,
    workspaceId: "ws-default",
    name: flowId,
    description: "",
    projectId: null,
    leaderRuntimeConfigId: "default-agent-sdk",
    leaderRuntimeModelId: "mimo-v25",
  });
  return store;
}

describe("MessageQueueCoordinator", () => {
  it("drains the backend queue after a terminal WorkRun event without a frontend client", async () => {
    const flowId = "flow-queue-coordinator";
    const store = createFlowStore(flowId);
    const eventBus = new EventBus();
    const drain = vi.fn(async () => true);
    const coordinator = new MessageQueueCoordinator({
      store,
      eventBus,
      drain,
      connectionForFlow: () => ({}) as WsConnection,
    });
    coordinator.start();
    store.addQueuedMessage({
      id: "msg-queued-1",
      flowId,
      payloadHash: "hash-1",
      payload: { content: "断线后也继续" },
    });

    await eventBus.publish(flowId, {
      type: "work_run:event",
      flow_id: flowId,
      data: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    expect(drain).toHaveBeenCalledWith(flowId, expect.anything());
    await coordinator.close();
  });

  it("requeues a claimed item when restart happened before canonical materialization", async () => {
    const flowId = "flow-queue-recovery";
    const store = createFlowStore(flowId);
    store.addQueuedMessage({
      id: "msg-uncertain-1",
      flowId,
      payloadHash: "hash-1",
      payload: { content: "不要重复执行" },
    });
    expect(store.claimQueuedMessage(flowId, "msg-uncertain-1")).toBeDefined();
    expect(store.claimSubmission(flowId, "msg-uncertain-1")).toBe(true);

    const drain = vi.fn(async () => false);
    const coordinator = new MessageQueueCoordinator({
      store,
      eventBus: new EventBus(),
      drain,
      connectionForFlow: () => ({}) as WsConnection,
    });
    const recovered = coordinator.start();

    expect(recovered.requeued).toBe(1);
    expect(store.listQueuedMessages(flowId)).toEqual([
      expect.objectContaining({ id: "msg-uncertain-1", status: "accepted" }),
    ]);
    expect(store.getSubmission(flowId, "msg-uncertain-1")).toEqual(expect.objectContaining({
      receiptState: "received",
      lastErrorCode: null,
    }));
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    await coordinator.close();
  });
});

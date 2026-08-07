import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../src/db/store.js";
import { ClientWsMessageSchema } from "../src/protocol/wsMessages.js";
import { handleWsClientMessage, type WsConnection } from "../src/server/wsGateway.js";
import { ChatJournal } from "../src/ws/chatJournal.js";
import { EventBus } from "../src/ws/eventBus.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

function connectionFixture() {
  const store = createStore(":memory:");
  stores.push(store);
  store.migrate();
  const project = store.createProject({ id: "project", name: "项目", localPath: "/tmp" });
  const flow = store.createFlow({ id: "flow", projectId: project.id, name: "协议测试" })!;
  const sent: any[] = [];
  const modesSeenByGuide: unknown[] = [];
  const eventBus = new EventBus();
  const connection = {
    clientId: "client",
    subscriptions: new Set<string>(),
    eventBus,
    store,
    chatJournal: new ChatJournal(store, "process"),
    leaderRuntime: {
      runLeaderTurn: vi.fn(),
      guideLeaderTurn: vi.fn(async () => { modesSeenByGuide.push(store.getFlowMode(flow.id)); }),
      cancelFlow: vi.fn(),
    },
    expertRuntime: { cancelAgent: vi.fn(async () => true), resolvePermissionCard: vi.fn() },
    send: vi.fn(async (message: unknown) => { sent.push(message); }),
  } as unknown as WsConnection;
  return { store, flow, sent, modesSeenByGuide, connection };
}

describe("Supervisor queue and WS protocol", () => {
  it("accepts only clean-break message names and rejects removed fields", () => {
    expect(ClientWsMessageSchema.safeParse({
      type: "flow:message",
      flow_id: "flow",
      content: "继续",
    }).success).toBe(true);
    expect(ClientWsMessageSchema.safeParse({
      type: "flow:message",
      flow_id: "flow",
      content: "先计划",
      plan_requested: true,
    }).success).toBe(false);
    expect(ClientWsMessageSchema.safeParse({
      type: "flow:decision_cancel",
      flow_id: "flow",
      card_id: "old",
    }).success).toBe(false);
    expect(ClientWsMessageSchema.safeParse({
      type: "agent_run:cancel",
      flow_id: "flow",
      agent_run_id: "run",
      client_action_id: "cancel-once",
    }).success).toBe(true);
  });

  it("restores the durable queue in the initial Flow snapshot", async () => {
    const { store, flow, sent, connection } = connectionFixture();
    store.addQueuedMessage({ id: "queued-1", flowId: flow.id, payloadHash: "hash", payload: { content: "稍后处理" } });
    await handleWsClientMessage(JSON.stringify({ type: "flow:subscribe", flow_id: flow.id }), connection);
    expect(sent.at(-1)).toEqual(expect.objectContaining({
      type: "flow:state",
      flow_id: flow.id,
      data: expect.objectContaining({ queued_messages: [expect.objectContaining({ id: "queued-1", content: "稍后处理" })] }),
    }));
  });

  it("keeps queue payloads mode-free and Guide observes the latest Flow mode", async () => {
    const { store, flow, modesSeenByGuide, connection } = connectionFixture();
    await handleWsClientMessage(JSON.stringify({
      type: "flow:queue_add",
      flow_id: flow.id,
      queue_id: "queued-guide",
      content: "先停一下，我想改功能",
      client_payload: {
        browserElementAttachments: [],
        behavior_mode: "execute",
        riskMode: "full_access",
        plan_requested: true,
      },
    }), connection);
    const queued = store.getQueuedMessage(flow.id, "queued-guide")!;
    expect(queued.payload.client_payload).toEqual({ browserElementAttachments: [] });
    expect(queued.payload).not.toHaveProperty("behavior_mode");

    store.updateFlow(flow.id, { behaviorMode: "plan", riskMode: "auto_edit" });
    const leader = store.getLeaderAgentSession(flow.id)!;
    store.createAgentRun({ flowId: flow.id, agentSessionId: leader.id, status: "running" });
    await handleWsClientMessage(JSON.stringify({
      type: "flow:queue_guide",
      flow_id: flow.id,
      queue_id: "queued-guide",
      client_message_id: "guide-message",
    }), connection);
    expect(modesSeenByGuide).toEqual([{
      behaviorMode: "plan",
      riskMode: "auto_edit",
      orchestrationMode: "approval_required",
    }]);
    expect(store.getQueuedMessage(flow.id, "queued-guide")).toBeUndefined();
  });

  it("edits and reorders queue items with optimistic revisions", () => {
    const { store, flow } = connectionFixture();
    const first = store.addQueuedMessage({ id: "one", flowId: flow.id, payloadHash: "1", payload: { content: "一" } }).item!;
    store.addQueuedMessage({ id: "two", flowId: flow.id, payloadHash: "2", payload: { content: "二" } });
    expect(store.updateQueuedMessage({
      flowId: flow.id,
      queueId: first.id,
      expectedRevision: first.revision + 1,
      payloadHash: "bad",
      payload: { content: "冲突" },
    })).toBeUndefined();
    expect(store.updateQueuedMessage({
      flowId: flow.id,
      queueId: first.id,
      expectedRevision: first.revision,
      payloadHash: "updated",
      payload: { content: "一（修改）" },
    })?.revision).toBe(first.revision + 1);
    expect(store.reorderQueuedMessages(flow.id, ["two", "one"])).toBe(true);
    expect(store.listQueuedMessages(flow.id).map((item) => item.id)).toEqual(["two", "one"]);
  });
});

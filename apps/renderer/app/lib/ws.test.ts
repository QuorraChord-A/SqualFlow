import { afterEach, describe, expect, it, vi } from "vitest";
import { SquadFlowWs } from "./ws";

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  static instances: MockWebSocket[] = [];
}

function sentTypes(socket: MockWebSocket) {
  return socket.sent.map((item) => JSON.parse(item).data.type);
}

describe("SquadFlowWs subscriptions", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    MockWebSocket.instances = [];
  });

  it("requests a fresh flow snapshot for each logical subscription while ref-counting unsubscribe", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const client = new SquadFlowWs();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();

    client.sendFlowSubscribe("flow-1");
    client.sendFlowSubscribe("flow-1");
    client.sendFlowUnsubscribe("flow-1");
    client.sendFlowUnsubscribe("flow-1");

    expect(sentTypes(socket)).toEqual([
      "flow:subscribe",
      "flow:subscribe",
      "flow:unsubscribe",
    ]);
  });

  it("sends only bounded Flow switch diagnostic fields", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const client = new SquadFlowWs();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();

    client.sendClientDiagnostic({
      flowId: "flow-1",
      event: "flow_switch_failed",
      durationMs: 12.6,
      errorCode: "SESSION_HISTORY_UNAVAILABLE",
      leaderAgentSessionId: "agent-1",
    });

    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(socket.sent.at(-1)!).data).toMatchObject({
      type: "client:diagnostic",
      flow_id: "flow-1",
      event: "flow_switch_failed",
      duration_ms: 13,
      error_code: "SESSION_HISTORY_UNAVAILABLE",
      leader_agent_session_id: "agent-1",
    });
  });

  it("replays an unacknowledged message with the same id after reconnect", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const client = new SquadFlowWs();
    client.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.onopen?.();
    firstSocket.readyState = 3;

    client.send({
      type: "flow:message",
      flow_id: "flow-1",
      content: "只执行一次",
      client_message_id: "msg-stable-1",
      log_id: "log-stable-1",
    });
    client.disconnect();
    client.connect();
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.onopen?.();

    await vi.waitFor(() => expect(secondSocket.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(secondSocket.sent.at(-1)!).data).toMatchObject({
      type: "flow:message",
      client_message_id: "msg-stable-1",
      log_id: "log-stable-1",
    });
    secondSocket.onmessage?.({ data: JSON.stringify({
      type: "flow:message_ack",
      flow_id: "flow-1",
      log_id: "log-stable-1",
      data: { accepted: true, message_id: "msg-stable-1" },
    }) });
    expect(window.localStorage.getItem("squadflow.messageOutbox.v1")).toBeNull();
  });

  it("still sends while connected when a large outbox payload cannot fit localStorage", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new SquadFlowWs();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.onopen?.();

    client.send({
      type: "flow:message",
      flow_id: "flow-1",
      content: "看图",
      client_message_id: "msg-image-1",
      attachments: [{ id: "img-1", kind: "image", media_type: "image/png", data: "x".repeat(6_000_000) }],
    });

    await vi.waitFor(() => expect(sentTypes(socket)).toContain("flow:message"));
  });

  it("replays pending submissions in their original order", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const client = new SquadFlowWs();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.readyState = 3;

    client.send({ type: "flow:message", flow_id: "flow-1", content: "第一条", client_message_id: "msg-1", log_id: "log-1" });
    client.send({ type: "flow:message", flow_id: "flow-1", content: "第二条", client_message_id: "msg-2", log_id: "log-2" });
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent.map((item) => JSON.parse(item).data.client_message_id)).toEqual(["msg-1", "msg-2"]);
  });
});

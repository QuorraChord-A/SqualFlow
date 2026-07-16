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
    vi.unstubAllGlobals();
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

  it("sends only bounded Flow switch diagnostic fields", () => {
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

    expect(JSON.parse(socket.sent.at(-1)!).data).toMatchObject({
      type: "client:diagnostic",
      flow_id: "flow-1",
      event: "flow_switch_failed",
      duration_ms: 13,
      error_code: "SESSION_HISTORY_UNAVAILABLE",
      leader_agent_session_id: "agent-1",
    });
  });
});

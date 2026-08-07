import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBridge } from "../src/server/desktopBridge.js";

function connectionWithSpy() {
  const sent: string[] = [];
  return {
    sent,
    connection: { send: (data: string) => sent.push(data) },
  };
}

function requestIdFrom(sent: string[], index = sent.length - 1) {
  return (JSON.parse(sent[index]) as { id: string }).id;
}

describe("DesktopBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects requests when no Electron client is connected", async () => {
    const bridge = new DesktopBridge();
    expect(bridge.isConnected()).toBe(false);
    await expect(bridge.request("navigate", { url: "http://localhost:3000" })).rejects.toThrow(/desktop 不可用/);
  });

  it("resolves a request once a matching response arrives", async () => {
    const bridge = new DesktopBridge();
    const { connection, sent } = connectionWithSpy();
    bridge.connect(connection);
    sent.length = 0;

    const pending = bridge.request("navigate", { url: "http://localhost:3000" });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const id = requestIdFrom(sent);
    bridge.handleMessage(JSON.stringify({ type: "response", id, ok: true, result: { url: "http://localhost:3000", title: "Home" } }));

    await expect(pending).resolves.toEqual({ url: "http://localhost:3000", title: "Home" });
  });

  it("rejects a request when the response carries ok:false", async () => {
    const bridge = new DesktopBridge();
    const { connection, sent } = connectionWithSpy();
    bridge.connect(connection);

    const pending = bridge.request("click", { ref: "e1" });
    const id = requestIdFrom(sent);
    bridge.handleMessage(JSON.stringify({ type: "response", id, ok: false, error: "ref expired" }));

    await expect(pending).rejects.toThrow(/ref expired/);
  });

  it("times out a request that never receives a response", async () => {
    const bridge = new DesktopBridge();
    const { connection } = connectionWithSpy();
    bridge.connect(connection);

    const pending = bridge.request("console_logs", {});
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it("uses a longer timeout for navigate-class commands", async () => {
    const bridge = new DesktopBridge();
    const { connection } = connectionWithSpy();
    bridge.connect(connection);

    const pending = bridge.request("navigate", { url: "http://localhost:3000" });
    const rejected = vi.fn();
    pending.catch(rejected);

    await vi.advanceTimersByTimeAsync(15_001);
    expect(rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(rejected).toHaveBeenCalled();
  });

  it("honors a per-request timeout override for long wait_for calls", async () => {
    const bridge = new DesktopBridge();
    const { connection, sent } = connectionWithSpy();
    bridge.connect(connection);
    sent.length = 0;

    const pending = bridge.request("wait_for", { text: "Ready", timeoutMs: 25000 }, 30000);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const id = requestIdFrom(sent);
    await vi.advanceTimersByTimeAsync(20_000);
    bridge.handleMessage(JSON.stringify({ type: "response", id, ok: true, result: { matched: true } }));

    await expect(pending).resolves.toEqual({ matched: true });
  });

  it("keeps the default 15s timeout when no per-request timeout is supplied", async () => {
    const bridge = new DesktopBridge();
    const { connection } = connectionWithSpy();
    bridge.connect(connection);

    const pending = bridge.request("wait_for", { text: "Ready" });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it("rejects in-flight requests from a stale connection when a new one connects", async () => {
    const bridge = new DesktopBridge();
    const first = connectionWithSpy();
    bridge.connect(first.connection);
    const pending = bridge.request("navigate", { url: "http://localhost:3000" });

    const second = connectionWithSpy();
    bridge.connect(second.connection);

    await expect(pending).rejects.toThrow(/reconnected/);
  });

  it("keeps the latest connection authoritative on repeated registration", async () => {
    const bridge = new DesktopBridge();
    const first = connectionWithSpy();
    const firstId = bridge.connect(first.connection);
    const second = connectionWithSpy();
    const secondId = bridge.connect(second.connection);
    expect(secondId).not.toBe(firstId);

    bridge.disconnect(firstId);
    expect(bridge.isConnected()).toBe(true);

    bridge.disconnect(secondId);
    expect(bridge.isConnected()).toBe(false);
  });

  it("syncs an existing lease to a newly connected Electron client", () => {
    const bridge = new DesktopBridge();
    bridge.acquireLease("session-a", "Verify", "flow-a");

    const { connection, sent } = connectionWithSpy();
    bridge.connect(connection);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual(expect.objectContaining({
      type: "request",
      command: "lease_changed",
      params: { lease: bridge.getLease() },
    }));
  });

  it("enforces a single-holder lease bound to agentRunId", () => {
    const bridge = new DesktopBridge();
    expect(bridge.acquireLease("session-a", "Verify", "flow-a")).toEqual({ ok: true });
    expect(bridge.getLease()).toEqual(expect.objectContaining({ flowId: "flow-a" }));
    expect(bridge.acquireLease("session-a", "Verify", "flow-a")).toEqual({ ok: true });
    expect(bridge.acquireLease("session-b", "Frontend", "flow-b")).toEqual({ ok: false, heldBy: "Verify", reason: "busy" });

    bridge.releaseLease("session-a");
    expect(bridge.acquireLease("session-b", "Frontend", "flow-b")).toEqual({ ok: true });
  });

  it("blocks the reclaimed session from re-acquiring the lease", () => {
    const bridge = new DesktopBridge();
    bridge.acquireLease("session-a", "Verify", "flow-a");
    bridge.reclaimLease();
    expect(bridge.getLease()).toBeNull();
    expect(bridge.acquireLease("session-a", "Verify", "flow-a")).toEqual({ ok: false, heldBy: "用户", reason: "revoked" });
    expect(bridge.acquireLease("session-b", "Frontend", "flow-b")).toEqual({ ok: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserMcpServer, createBrowserToolHandlers } from "../src/mcp/browserServer.js";
import { DesktopBridge } from "../src/server/desktopBridge.js";

function jsonResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

function findRequest(sent: string[], command: string) {
  const match = sent
    .map((raw) => JSON.parse(raw) as { id: string; command: string; params: Record<string, unknown> })
    .find((request) => request.command === command);
  if (!match) throw new Error(`no ${command} request found in ${JSON.stringify(sent)}`);
  return match;
}

async function withClient(
  desktopBridge: DesktopBridge,
  ctxOverrides: Partial<Parameters<typeof createBrowserToolHandlers>[0]> = {},
  run: (client: Client) => Promise<void>,
) {
  const handlers = createBrowserToolHandlers({
    desktopBridge,
    holderName: "Verify",
    flowId: "flow-a",
    getAgentSessionId: () => "session-a",
    getScratchDir: () => "/tmp/scratch",
    ...ctxOverrides,
  });
  const server = createBrowserMcpServer(handlers);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("browser MCP server", () => {
  it("registers exactly the fixed 9-tool v1 set", async () => {
    const desktopBridge = new DesktopBridge();
    await withClient(desktopBridge, {}, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "browser_click",
        "browser_console_logs",
        "browser_eval",
        "browser_fill",
        "browser_navigate",
        "browser_reload",
        "browser_screenshot",
        "browser_snapshot",
        "browser_wait_for",
      ]);
    });
  });

  it("describes ref lifetime and recovery on snapshot, click, and fill", async () => {
    const desktopBridge = new DesktopBridge();
    await withClient(desktopBridge, {}, async (client) => {
      const tools = await client.listTools();
      const description = (name: string) => tools.tools.find((tool) => tool.name === name)?.description;

      expect(description("browser_snapshot")).toContain("DOM replacement");
      expect(description("browser_click")).toContain("reason=ref_expired");
      expect(description("browser_fill")).toContain("take a new browser_snapshot");
    });
  });

  it("reports desktop unavailable when Electron is not connected", async () => {
    const desktopBridge = new DesktopBridge();
    await withClient(desktopBridge, {}, async (client) => {
      const result = await client.callTool({ name: "browser_navigate", arguments: { url: "http://localhost:3000" } });
      const parsed = jsonResult(result as any);
      expect(parsed).toEqual({ ok: false, error: { code: "DESKTOP_UNAVAILABLE", message: expect.any(String) } });
    });
  });

  it("forwards navigate to the desktop bridge and returns the result", async () => {
    const desktopBridge = new DesktopBridge();
    const sent: string[] = [];
    desktopBridge.connect({ send: (data) => sent.push(data) });

    await withClient(desktopBridge, {}, async (client) => {
      const pending = client.callTool({ name: "browser_navigate", arguments: { url: "http://localhost:3000" } });
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
      const leaseNotify = findRequest(sent, "lease_changed");
      desktopBridge.handleMessage(JSON.stringify({ type: "response", id: leaseNotify.id, ok: true, result: {} }));
      const request = findRequest(sent, "navigate");
      expect(request.params).toEqual({ url: "http://localhost:3000" });
      desktopBridge.handleMessage(JSON.stringify({ type: "response", id: request.id, ok: true, result: { url: "http://localhost:3000", title: "Home" } }));

      const result = await pending;
      expect(jsonResult(result as any)).toEqual({ ok: true, url: "http://localhost:3000", title: "Home" });
    });
  });

  it("rejects tool calls from a session that does not hold the lease", async () => {
    const desktopBridge = new DesktopBridge();
    desktopBridge.connect({ send: () => {} });
    desktopBridge.acquireLease("session-other", "Frontend", "flow-other");

    await withClient(desktopBridge, { getAgentSessionId: () => "session-a" }, async (client) => {
      const result = await client.callTool({ name: "browser_snapshot", arguments: {} });
      const parsed = jsonResult(result as any);
      expect(parsed).toEqual({ ok: false, error: { code: "BROWSER_BUSY", message: expect.stringContaining("Frontend") } });
    });
  });

  it("rejects further calls from a session whose lease was reclaimed by the user", async () => {
    const desktopBridge = new DesktopBridge();
    desktopBridge.connect({ send: () => {} });
    desktopBridge.acquireLease("session-a", "Verify", "flow-a");
    desktopBridge.reclaimLease();

    await withClient(desktopBridge, { getAgentSessionId: () => "session-a" }, async (client) => {
      const result = await client.callTool({ name: "browser_snapshot", arguments: {} });
      const parsed = jsonResult(result as any);
      expect(parsed).toEqual({ ok: false, error: { code: "BROWSER_LEASE_REVOKED", message: expect.any(String) } });
    });
  });

  it("propagates a ref-expired click result from the bridge", async () => {
    const desktopBridge = new DesktopBridge();
    const sent: string[] = [];
    desktopBridge.connect({ send: (data) => sent.push(data) });

    await withClient(desktopBridge, {}, async (client) => {
      const pending = client.callTool({ name: "browser_click", arguments: { ref: "e1" } });
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
      const leaseNotify = findRequest(sent, "lease_changed");
      desktopBridge.handleMessage(JSON.stringify({ type: "response", id: leaseNotify.id, ok: true, result: {} }));
      const request = findRequest(sent, "click");
      desktopBridge.handleMessage(JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result: {
          ok: false,
          reason: "ref_expired",
          message: "The ref no longer points to a connected element.",
          recovery: "Call browser_snapshot and use refs from the new snapshot.",
        },
      }));

      const result = await pending;
      expect(jsonResult(result as any)).toEqual({
        ok: false,
        reason: "ref_expired",
        message: "The ref no longer points to a connected element.",
        recovery: "Call browser_snapshot and use refs from the new snapshot.",
      });
    });
  });

  it("passes browser_wait_for timeout plus transport margin to the desktop bridge", async () => {
    const desktopBridge = new class extends DesktopBridge {
      requests: Array<{ command: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
      override async request(command: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
        this.requests.push({ command, params, timeoutMs });
        return { matched: true };
      }
    }();
    desktopBridge.connect({ send: () => {} });

    await withClient(desktopBridge, {}, async (client) => {
      const result = await client.callTool({ name: "browser_wait_for", arguments: { text: "Ready", timeoutMs: 25000 } });
      expect(jsonResult(result as any)).toEqual({ ok: true, matched: true });
    });

    expect(desktopBridge.requests.find((request) => request.command === "wait_for")).toEqual({
      command: "wait_for",
      params: { text: "Ready", selector: undefined, timeoutMs: 25000 },
      timeoutMs: 30000,
    });
  });
});

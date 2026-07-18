import { describe, expect, it, vi } from "vitest";

type TransportOptions = {
  sessionIdGenerator?: () => string;
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
};

const transportMocks = vi.hoisted(() => ({
  options: [] as TransportOptions[],
  instances: [] as Array<{
    sessionId?: string;
    handleRequest: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    sessionId?: string;
    onclose?: () => void;
    readonly handleRequest;
    readonly close;

    constructor(private readonly options: TransportOptions) {
      transportMocks.options.push(options);
      this.handleRequest = vi.fn(async (request: { method?: string }, _reply: unknown, body: unknown) => {
        const messages = Array.isArray(body) ? body : [body];
        const initialize = messages.some((message) => (
          typeof message === "object"
          && message !== null
          && (message as { method?: unknown }).method === "initialize"
        ));
        if (initialize && !this.sessionId) {
          this.sessionId = this.options.sessionIdGenerator?.();
          if (this.sessionId) await this.options.onsessioninitialized?.(this.sessionId);
        }
        if (request.method === "DELETE" && this.sessionId) {
          await this.options.onsessionclosed?.(this.sessionId);
        }
      });
      this.close = vi.fn(async () => {
        this.onclose?.();
      });
      transportMocks.instances.push(this);
    }
  },
}));

function fakeReply() {
  const reply = {
    raw: {},
    statusCode: 200,
    payload: undefined as unknown,
    hijack: vi.fn(),
    code: vi.fn((statusCode: number) => {
      reply.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload;
      return reply;
    }),
  };
  return reply;
}

function fakeRequest(input: {
  bridgeId: string;
  bearerToken: string;
  body?: unknown;
  sessionId?: string;
  method?: string;
}) {
  const method = input.method ?? "POST";
  return {
    params: { bridgeId: input.bridgeId },
    headers: {
      authorization: `Bearer ${input.bearerToken}`,
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
    },
    method,
    body: input.body,
    raw: { method },
  };
}

describe("McpBridgeRegistry", () => {
  it("creates stateful MCP transports lazily and routes every session independently", async () => {
    transportMocks.options.length = 0;
    transportMocks.instances.length = 0;
    const { McpBridgeRegistry } = await import("../src/mcp/mcpBridgeRegistry.js");
    const registry = new McpBridgeRegistry();
    const firstServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const secondServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const bridge = await registry.register(firstServer as any, "browser", {
      stableKey: "expert-browser:flow-expert-1",
      createServer: () => secondServer as any,
    });

    expect(transportMocks.options).toHaveLength(0);
    await registry.handleRequest(
      fakeRequest({
        bridgeId: bridge.id,
        bearerToken: bridge.bearerToken,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
      }) as any,
      fakeReply() as any,
    );
    await registry.handleRequest(
      fakeRequest({
        bridgeId: bridge.id,
        bearerToken: bridge.bearerToken,
        body: { jsonrpc: "2.0", id: 2, method: "initialize" },
      }) as any,
      fakeReply() as any,
    );

    expect(transportMocks.options).toHaveLength(2);
    expect(typeof transportMocks.options[0]?.sessionIdGenerator).toBe("function");
    expect(firstServer.connect).toHaveBeenCalledTimes(1);
    expect(secondServer.connect).toHaveBeenCalledTimes(1);
    const firstSessionId = transportMocks.instances[0]?.sessionId;
    expect(firstSessionId).toMatch(/^[0-9a-f-]{36}$/);

    await registry.handleRequest(
      fakeRequest({
        bridgeId: bridge.id,
        bearerToken: bridge.bearerToken,
        sessionId: firstSessionId,
        body: { jsonrpc: "2.0", id: 3, method: "tools/list" },
      }) as any,
      fakeReply() as any,
    );
    expect(transportMocks.instances[0]?.handleRequest).toHaveBeenCalledTimes(2);
    expect(transportMocks.instances[1]?.handleRequest).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it("reuses one deterministic bridge URL for the same logical runtime session", async () => {
    const { McpBridgeRegistry } = await import("../src/mcp/mcpBridgeRegistry.js");
    const firstRegistry = new McpBridgeRegistry();
    const secondRegistry = new McpBridgeRegistry();
    const firstServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const duplicateServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const restartedServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };

    const first = await firstRegistry.register(firstServer as any, "leader", {
      stableKey: "leader:agent-session-1",
      createServer: () => firstServer as any,
    });
    const duplicate = await firstRegistry.register(duplicateServer as any, "leader", {
      stableKey: "leader:agent-session-1",
      createServer: () => duplicateServer as any,
    });
    const afterRestart = await secondRegistry.register(restartedServer as any, "leader", {
      stableKey: "leader:agent-session-1",
      createServer: () => restartedServer as any,
    });

    expect(duplicate.url).toBe(first.url);
    expect(afterRestart.url).toBe(first.url);
    expect(duplicateServer.close).toHaveBeenCalledTimes(1);
    await first.close();
    expect(firstServer.close).not.toHaveBeenCalled();
    await firstRegistry.close();
    await secondRegistry.close();
    expect(firstServer.close).toHaveBeenCalledTimes(1);
    expect(restartedServer.close).toHaveBeenCalledTimes(1);
  });

  it("uses one process-level credential across all pooled Codex bridge URLs", async () => {
    const { McpBridgeRegistry } = await import("../src/mcp/mcpBridgeRegistry.js");
    const registry = new McpBridgeRegistry();
    const firstServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const secondServer = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };

    const first = await registry.register(firstServer as any, "leader");
    const second = await registry.register(secondServer as any, "browser");

    expect(first.url).not.toBe(second.url);
    expect(first.bearerTokenEnvVar).toBe("SQUADFLOW_MCP_BRIDGE_TOKEN");
    expect(second.bearerTokenEnvVar).toBe(first.bearerTokenEnvVar);
    expect(second.bearerToken).toBe(first.bearerToken);
    expect(registry.credentials()).toEqual({
      envVar: first.bearerTokenEnvVar,
      token: first.bearerToken,
    });
    await registry.close();
  });
});

import { describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  options: [] as Array<{ sessionIdGenerator?: () => string }>,
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    constructor(options: { sessionIdGenerator?: () => string }) {
      transportMocks.options.push(options);
    }

    handleRequest = vi.fn();
    close = vi.fn();
  },
}));

describe("McpBridgeRegistry", () => {
  it("uses a stateful Streamable HTTP transport for reusable bridges", async () => {
    const { McpBridgeRegistry } = await import("../src/mcp/mcpBridgeRegistry.js");
    const registry = new McpBridgeRegistry();
    const server = {
      connect: vi.fn(),
      close: vi.fn(),
    };

    await registry.register(server as any, "browser");

    expect(transportMocks.options).toHaveLength(1);
    expect(typeof transportMocks.options[0].sessionIdGenerator).toBe("function");
    expect(transportMocks.options[0].sessionIdGenerator?.()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

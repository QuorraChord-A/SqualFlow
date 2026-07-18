import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpBridgeRegistry, registerMcpBridgeRoutes } from "../src/mcp/mcpBridgeRegistry.js";

describe("McpBridgeRegistry HTTP integration", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((close) => close()));
  });

  it("keeps one stable URL while serving multiple independent MCP sessions", async () => {
    const registry = new McpBridgeRegistry();
    const app = Fastify({ logger: false });
    registerMcpBridgeRoutes(app, registry);
    const state = { value: "first" };
    const createServer = () => {
      const server = new McpServer({ name: "stable-bridge-test", version: "1.0.0" });
      server.registerTool("current_value", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: state.value }],
      }));
      return server;
    };
    const bridge = await registry.register(createServer(), "leader", {
      stableKey: "leader:integration-session",
      createServer,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(`/api/mcp/bridge/${bridge.id}`, address);
    const connectClient = async (name: string) => {
      const client = new Client({ name, version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
      });
      await client.connect(transport);
      cleanup.push(async () => client.close());
      return client;
    };

    cleanup.push(async () => app.close());
    cleanup.push(async () => registry.close());
    const firstClient = await connectClient("first-client");
    const secondClient = await connectClient("second-client");
    state.value = "updated";

    const [firstResult, secondResult] = await Promise.all([
      firstClient.callTool({ name: "current_value", arguments: {} }),
      secondClient.callTool({ name: "current_value", arguments: {} }),
    ]);
    expect(firstResult.content).toEqual([{ type: "text", text: "updated" }]);
    expect(secondResult.content).toEqual([{ type: "text", text: "updated" }]);

    await bridge.close();
    const repeated = await registry.register(createServer(), "leader", {
      stableKey: "leader:integration-session",
      createServer,
    });
    expect(repeated.url).toBe(bridge.url);
    expect((await firstClient.listTools()).tools.map((tool) => tool.name)).toContain("current_value");
  });
});

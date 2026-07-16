import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";

export type McpBridge = {
  id: string;
  url: string;
  bearerToken: string;
  bearerTokenEnvVar: string;
  close: () => Promise<void>;
};

type BridgeEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  bearerToken: string;
};

export class McpBridgeRegistry {
  private readonly bridges = new Map<string, BridgeEntry>();

  async register(server: McpServer, namePrefix = "leader"): Promise<McpBridge> {
    const id = `${namePrefix}-${crypto.randomBytes(8).toString("hex")}`;
    const bearerToken = crypto.randomBytes(24).toString("hex");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);
    this.bridges.set(id, { server, transport, bearerToken });
    return {
      id,
      bearerToken,
      bearerTokenEnvVar: `SQUADFLOW_MCP_BRIDGE_TOKEN_${id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`,
      url: `http://127.0.0.1:${config.port}/api/mcp/bridge/${id}`,
      close: async () => {
        await this.unregister(id);
      },
    };
  }

  async unregister(id: string) {
    const entry = this.bridges.get(id);
    if (!entry) return;
    this.bridges.delete(id);
    await entry.server.close().catch(() => {});
    await entry.transport.close().catch(() => {});
  }

  async handleRequest(request: FastifyRequest<{ Params: { bridgeId: string } }>, reply: FastifyReply) {
    const entry = this.bridges.get(request.params.bridgeId);
    if (!entry) {
      reply.code(404).send({ error: "mcp bridge not found" });
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${entry.bearerToken}`) {
      reply.code(401).send({ error: "invalid mcp bridge token" });
      return;
    }
    await entry.transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  }

  async close() {
    await Promise.all([...this.bridges.keys()].map((id) => this.unregister(id)));
  }
}

export function registerMcpBridgeRoutes(app: FastifyInstance, registry: McpBridgeRegistry) {
  app.all<{ Params: { bridgeId: string } }>("/api/mcp/bridge/:bridgeId", async (request, reply) => {
    await registry.handleRequest(request, reply);
  });
}

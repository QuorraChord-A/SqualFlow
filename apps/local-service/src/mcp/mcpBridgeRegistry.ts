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

type BridgeSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
};

type BridgeEntry = {
  initialServer: McpServer | null;
  createServer: () => McpServer;
  sessions: Map<string, BridgeSession>;
  bearerToken: string;
  stableRegistryKey: string | null;
};

type RegisterBridgeOptions = {
  stableKey?: string;
  createServer?: () => McpServer;
};

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isInitializeRequestBody(value: unknown): boolean {
  const messages = Array.isArray(value) ? value : [value];
  return messages.some((message) => (
    typeof message === "object"
    && message !== null
    && !Array.isArray(message)
    && (message as { method?: unknown }).method === "initialize"
  ));
}

export class McpBridgeRegistry {
  private readonly bridges = new Map<string, BridgeEntry>();
  private readonly stableBridgeIds = new Map<string, string>();
  private readonly bearerToken = crypto.randomBytes(24).toString("hex");
  private readonly bearerTokenEnvVar = "SQUADFLOW_MCP_BRIDGE_TOKEN";

  credentials() {
    return {
      token: this.bearerToken,
      envVar: this.bearerTokenEnvVar,
    };
  }

  async register(
    server: McpServer,
    namePrefix = "leader",
    options: RegisterBridgeOptions = {},
  ): Promise<McpBridge> {
    const stableRegistryKey = options.stableKey ? `${namePrefix}\u0000${options.stableKey}` : null;
    const existingId = stableRegistryKey ? this.stableBridgeIds.get(stableRegistryKey) : undefined;
    if (existingId && this.bridges.has(existingId)) {
      await server.close().catch(() => {});
      return this.bridgeHandle(existingId, true);
    }

    const id = stableRegistryKey
      ? `${namePrefix}-${crypto.createHash("sha256").update(stableRegistryKey).digest("hex").slice(0, 16)}`
      : `${namePrefix}-${crypto.randomBytes(8).toString("hex")}`;
    const existing = this.bridges.get(id);
    if (existing) {
      await server.close().catch(() => {});
      throw new Error(`MCP bridge ID collision: ${id}`);
    }
    this.bridges.set(id, {
      initialServer: server,
      createServer: options.createServer ?? (() => {
        throw new Error(`MCP bridge ${id} cannot create another session`);
      }),
      sessions: new Map(),
      bearerToken: this.bearerToken,
      stableRegistryKey,
    });
    if (stableRegistryKey) this.stableBridgeIds.set(stableRegistryKey, id);
    return this.bridgeHandle(id, Boolean(stableRegistryKey));
  }

  private bridgeHandle(id: string, persistent: boolean): McpBridge {
    return {
      id,
      bearerToken: this.bearerToken,
      bearerTokenEnvVar: this.bearerTokenEnvVar,
      url: `http://127.0.0.1:${config.port}/api/mcp/bridge/${id}`,
      close: async () => {
        if (!persistent) await this.unregister(id);
      },
    };
  }

  async unregister(id: string) {
    const entry = this.bridges.get(id);
    if (!entry) return;
    this.bridges.delete(id);
    if (entry.stableRegistryKey) this.stableBridgeIds.delete(entry.stableRegistryKey);
    const initialServer = entry.initialServer;
    entry.initialServer = null;
    await Promise.all([
      initialServer?.close().catch(() => {}),
      ...[...entry.sessions.entries()].map(([sessionId, session]) => this.closeSession(entry, sessionId, session)),
    ]);
  }

  async handleRequest(request: FastifyRequest<{ Params: { bridgeId: string } }>, reply: FastifyReply) {
    const entry = this.bridges.get(request.params.bridgeId);
    if (!entry) {
      reply.code(404).send({ error: "mcp bridge not found" });
      return;
    }
    const authorization = headerValue(request.headers.authorization) ?? "";
    if (authorization !== `Bearer ${entry.bearerToken}`) {
      reply.code(401).send({ error: "invalid mcp bridge token" });
      return;
    }

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    let session = sessionId ? entry.sessions.get(sessionId) : undefined;
    if (!session && !sessionId && request.method === "POST" && isInitializeRequestBody(request.body)) {
      session = await this.createSession(entry);
    }
    if (!session) {
      reply.code(sessionId ? 404 : 400).send({
        error: sessionId ? "mcp session not found" : "mcp session id or initialize request required",
      });
      return;
    }

    await session.transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  }

  private async createSession(entry: BridgeEntry): Promise<BridgeSession> {
    const server = entry.initialServer ?? entry.createServer();
    entry.initialServer = null;
    let session!: BridgeSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        entry.sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        void this.closeSession(entry, sessionId, session);
      },
    });
    session = { server, transport, closed: false };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) void this.closeSession(entry, sessionId, session);
    };
    try {
      await server.connect(transport);
      return session;
    } catch (error) {
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private async closeSession(entry: BridgeEntry, sessionId: string, session: BridgeSession) {
    if (session.closed) return;
    session.closed = true;
    if (entry.sessions.get(sessionId) === session) entry.sessions.delete(sessionId);
    await session.server.close().catch(() => {});
    await session.transport.close().catch(() => {});
  }

  async close() {
    await Promise.all([...this.bridges.keys()].map((id) => this.unregister(id)));
    this.stableBridgeIds.clear();
  }
}

export function registerMcpBridgeRoutes(app: FastifyInstance, registry: McpBridgeRegistry) {
  app.all<{ Params: { bridgeId: string } }>("/api/mcp/bridge/:bridgeId", async (request, reply) => {
    await registry.handleRequest(request, reply);
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DesktopBridge } from "./desktopBridge.js";

const HEARTBEAT_INTERVAL_MS = 15000;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRequest(request: FastifyRequest): boolean {
  const remoteAddress = request.socket.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(remoteAddress);
}

function handleInboundCommand(desktopBridge: DesktopBridge, command: string): { ok: true; result: unknown } | { ok: false; error: string } {
  if (command === "reclaim_lease") {
    desktopBridge.reclaimLease();
    return { ok: true, result: { lease: desktopBridge.getLease() } };
  }
  if (command === "get_lease") {
    return { ok: true, result: { lease: desktopBridge.getLease() } };
  }
  return { ok: false, error: `unknown desktop bridge command: ${command}` };
}

export function registerDesktopWsGateway(app: FastifyInstance, desktopBridge: DesktopBridge): void {
  app.get("/desktop/ws", { websocket: true }, (socket, request) => {
    if (!isLoopbackRequest(request)) {
      socket.close(1008, "desktop bridge is only reachable from localhost");
      return;
    }

    let registered = false;
    let connectionId: number | null = null;
    let alive = true;

    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("pong", () => {
      alive = true;
    });

    socket.on("message", (rawMessage: Buffer | string) => {
      const text = rawMessage.toString();
      if (!registered) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "register") {
          registered = true;
          connectionId = desktopBridge.connect({ send: (data: string) => socket.send(data) });
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const message = parsed as Record<string, unknown>;
      if (message.type === "request" && typeof message.id === "string" && typeof message.command === "string") {
        const outcome = handleInboundCommand(desktopBridge, message.command);
        socket.send(JSON.stringify(outcome.ok
          ? { type: "response", id: message.id, ok: true, result: outcome.result }
          : { type: "response", id: message.id, ok: false, error: outcome.error }));
        return;
      }
      desktopBridge.handleMessage(text);
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      if (connectionId !== null) desktopBridge.disconnect(connectionId);
    });
  });
}

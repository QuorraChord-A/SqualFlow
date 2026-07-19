import path from "node:path";
import { config } from "../config.js";
import { createRotatingFileLog, DEFAULT_LOG_MAX_BYTES, type RotatingFileLog } from "./rotatingFileLog.js";

/** Cap a single WS log entry so one huge snapshot cannot blow the file alone. */
const MAX_PAYLOAD_CHARS = 256_000;

let singleton: RotatingFileLog | null = null;

export function wsLogFilePath(): string {
  const override = process.env.SQUADFLOW_WS_LOG?.trim();
  if (override) return override;
  // Packaged: SQUADFLOW_OUTPUT_ROOT = userData → same folder family as desktop.log
  // Dev: output/logs/ws.log under repo
  return path.join(config.outputRoot, "logs", "ws.log");
}

export function getWsWireLog(): RotatingFileLog {
  if (!singleton) {
    singleton = createRotatingFileLog({
      filePath: wsLogFilePath(),
      maxBytes: Number(process.env.SQUADFLOW_WS_LOG_MAX_BYTES ?? DEFAULT_LOG_MAX_BYTES),
    });
  }
  return singleton;
}

function compactPayload(value: unknown): unknown {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= MAX_PAYLOAD_CHARS) return value;
    return {
      _truncated: true,
      original_chars: raw.length,
      preview: raw.slice(0, MAX_PAYLOAD_CHARS),
    };
  } catch {
    return { _unserializable: true };
  }
}

export function logWsWire(input: {
  direction: "in" | "out";
  channel: "api_ws" | "event_bus";
  clientId?: string;
  flowId?: string | null;
  type?: string;
  payload: unknown;
}): void {
  const log = getWsWireLog();
  const type = input.type ?? (isRecord(input.payload) && typeof input.payload.type === "string"
    ? input.payload.type
    : "unknown");
  log.write("info", `ws ${input.direction} ${input.channel} ${type}`, {
    direction: input.direction,
    channel: input.channel,
    clientId: input.clientId,
    flowId: input.flowId ?? undefined,
    type,
    payload: compactPayload(input.payload),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

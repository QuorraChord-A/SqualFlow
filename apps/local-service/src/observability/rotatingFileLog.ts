import fs from "node:fs";
import path from "node:path";

/** Same default as desktop electron-log maxSize (desktop.log). */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export type RotatingFileLog = {
  path: string;
  write: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
  close: () => void;
};

function formatTimestamp(date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Append-only file logger with size-based rotation (rename to *.old.log).
 * Independent of Fastify / electron-log; safe for concurrent-ish appends on one process.
 */
export function createRotatingFileLog(input: {
  filePath: string;
  maxBytes?: number;
}): RotatingFileLog {
  const filePath = input.filePath;
  const maxBytes = input.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const rotateIfNeeded = () => {
    try {
      if (!fs.existsSync(filePath)) return;
      const size = fs.statSync(filePath).size;
      if (size < maxBytes) return;
      const archived = filePath.replace(/\.log$/u, ".old.log");
      try {
        if (fs.existsSync(archived)) fs.unlinkSync(archived);
      } catch {
        // best-effort
      }
      fs.renameSync(filePath, archived);
    } catch {
      // best-effort
    }
  };

  return {
    path: filePath,
    write(level, message, fields) {
      rotateIfNeeded();
      const payload = fields && Object.keys(fields).length > 0
        ? ` ${JSON.stringify(fields)}`
        : "";
      const line = `[${formatTimestamp()}] [${level}] ${message}${payload}\n`;
      try {
        fs.appendFileSync(filePath, line, "utf8");
      } catch {
        // never throw into request/WS path
      }
    },
    close() {
      // sync appender; nothing to flush
    },
  };
}

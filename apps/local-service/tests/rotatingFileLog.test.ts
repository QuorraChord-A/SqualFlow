import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRotatingFileLog } from "../src/observability/rotatingFileLog.js";

describe("rotatingFileLog", () => {
  it("appends timestamped lines and rotates when maxBytes exceeded", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws-log-"));
    const filePath = path.join(dir, "ws.log");
    try {
      const log = createRotatingFileLog({ filePath, maxBytes: 200 });
      log.write("info", "hello", { n: 1 });
      const first = readFileSync(filePath, "utf8");
      expect(first).toContain("[info] hello");
      expect(first).toContain('"n":1');

      // Force near-max size then write again → rotation
      writeFileSync(filePath, "x".repeat(250), "utf8");
      log.write("info", "after-rotate", { ok: true });
      expect(statSync(filePath).size).toBeLessThan(250);
      const body = readFileSync(filePath, "utf8");
      expect(body).toContain("after-rotate");
      const archived = path.join(dir, "ws.old.log");
      expect(readFileSync(archived, "utf8").length).toBeGreaterThanOrEqual(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

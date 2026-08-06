import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../src/db/store.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-fresh-database-"));
  dirs.push(dir);
  const store = createStore(path.join(dir, "squadflow.db"));
  stores.push(store);
  return store;
}

function tableNames(store: ReturnType<typeof createStore>) {
  return (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columnNames(store: ReturnType<typeof createStore>, table: string) {
  return (store.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fresh database schema", () => {
  it("initializes the WorkRun model idempotently without legacy business data", () => {
    const store = tempStore();

    store.migrate();
    store.migrate();
    store.seedExperts();

    expect(tableNames(store)).not.toContain("executions");
    for (const table of ["tasks", "agent_sessions", "decision_cards", "artifacts", "event_log"]) {
      expect(columnNames(store, table)).not.toContain("execution_id");
      expect(columnNames(store, table)).toContain("work_run_id");
    }

    const businessTables = [
      "projects",
      "flows",
      "work_runs",
      "tasks",
      "agent_sessions",
      "decision_cards",
      "spec_approvals",
      "artifacts",
      "event_log",
    ];
    for (const table of businessTables) {
      expect(store.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }

    expect(store.sqlite.prepare("SELECT id FROM experts ORDER BY id").all()).toEqual([
      { id: "exp-coder" },
      { id: "exp-codereview" },
      { id: "exp-leader" },
      { id: "exp-research" },
      { id: "exp-verify" },
    ]);
    expect(store.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../src/db/store.js";
import { SUPERVISOR_SCHEMA_VERSION } from "../src/db/supervisorSchema.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
});

describe("Supervisor schema migration", () => {
  it("initializes idempotently with foreign keys enabled", () => {
    const store = createStore(":memory:");
    stores.push(store);
    expect(store.migrate()).toEqual({ reset: true });
    expect(store.migrate()).toEqual({ reset: false });
    expect(store.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'supervisor_schema_version'").get())
      .toEqual({ value: SUPERVISOR_SCHEMA_VERSION });
  });

  it("clean-breaks Flow runtime data while preserving Project records", () => {
    const store = createStore(":memory:");
    stores.push(store);
    store.migrate();
    const project = store.createProject({ id: "keep-project", name: "保留项目", localPath: "/tmp/project" });
    store.createFlow({ id: "remove-flow", projectId: project.id, name: "旧 Flow" });
    store.sqlite.exec("CREATE TABLE work_runs (id TEXT PRIMARY KEY)");
    store.sqlite.prepare("INSERT INTO work_runs (id) VALUES ('legacy-run')").run();
    store.sqlite.prepare("UPDATE app_metadata SET value = 'legacy' WHERE key = 'supervisor_schema_version'").run();

    expect(store.migrate()).toEqual({ reset: true });
    expect(store.getProject(project.id)).toEqual(expect.objectContaining({ name: "保留项目" }));
    expect(store.listFlows()).toEqual([]);
    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_runs'").get())
      .toBeUndefined();
    expect(store.listAgentDefinitions().map((definition) => definition.id)).toContain("exp-leader");
  });

  it("does not mutate the database when the pre-reset hook fails", () => {
    const store = createStore(":memory:");
    stores.push(store);
    store.migrate();
    const project = store.createProject({ id: "project-before-failure", name: "项目", localPath: "/tmp" });
    store.createFlow({ id: "flow-before-failure", projectId: project.id, name: "仍应存在" });
    store.sqlite.prepare("UPDATE app_metadata SET value = 'legacy' WHERE key = 'supervisor_schema_version'").run();

    expect(() => store.migrate({ beforeRuntimeMessageProtocolReset: () => { throw new Error("stop reset"); } }))
      .toThrow("stop reset");
    expect(store.getFlow("flow-before-failure")).toBeDefined();
    expect(store.getProject("project-before-failure")).toBeDefined();
  });
});

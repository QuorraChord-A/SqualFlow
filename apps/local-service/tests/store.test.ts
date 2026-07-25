import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LEADER_SYSTEM_PROMPT } from "../src/db/defaultLeaderSystemPrompt.js";
import { experts } from "../src/db/schema.js";
import { createStore } from "../src/db/store.js";
import { beginUserTurn } from "./helpers/userTurnTestHelpers.js";
import { buildFlowSnapshot } from "../src/domain/flowSnapshot.js";

const dirs: string[] = [];
const stores: Array<ReturnType<typeof createStore>> = [];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-store-"));
  dirs.push(dir);
  return path.join(dir, "squadflow.db");
}

function tempStore() {
  const store = createStore(tempDb());
  stores.push(store);
  return store;
}

function tableNames(store: ReturnType<typeof createStore>) {
  return (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columnNames(store: ReturnType<typeof createStore>, tableName: string) {
  return (store.sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function markRuntimeMessageProtocolV2(store: ReturnType<typeof createStore>) {
  store.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('runtime_message_protocol_version', '2', 'now');
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('canonical_transcript_version', '2', 'now');
  `);
}

function createFlowWithRuntimeRows(store: ReturnType<typeof createStore>, flowId: string) {
  const flow = store.createFlow({ id: flowId, workspaceId: "ws-default", name: flowId, description: "", projectId: null });
  const userTurn = beginUserTurn(store, {
    flowId: flow.id,
    inputSnapshotJson: "{}",
    createdBy: "user",
  })!;
  const task = store.createTask({
    flowId: flow.id,
    userTurnId: userTurn.id,
    title: "Research",
    description: "Research task",
    expertId: "exp-research",
    dependsOnTaskIds: [],
  })!;
  store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-research" });
  store.createAgentSession({
    flowId: flow.id,
    userTurnId: userTurn.id,
    taskId: task.id,
    expertId: "exp-research",
    sessionId: "sdk-session",
    displayName: "Research",
  });
  store.createDecisionCard({
    flowId: flow.id,
    userTurnId: userTurn.id,
    cardId: `dc-${flow.id}`,
    sessionId: "sdk-session",
    cardType: "generic",
    questions: [{ header: "审批", question: "继续吗", multiSelect: false, options: [{ label: "通过", description: "继续" }, { label: "不通过", description: "停止" }] }],
  });
  store.createDecisionCardLeaderInput({
    flowId: flow.id,
    cardId: `dc-${flow.id}`,
    clientActionId: `action-${flow.id}`,
    messageId: `msg-${flow.id}`,
    kind: "resolved",
    content: "通过",
  });
  store.createArtifact({
    flowId: flow.id,
    userTurnId: userTurn.id,
    taskId: task.id,
    type: "spec",
    title: "Spec",
    content: "content",
    sourceAgentSessionId: "",
  });
  return flow;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.sqlite.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("does not create a UserTurn when a flow is created", () => {
    const store = tempStore();
    store.migrate();

    const flow = store.createFlow({ id: "flow-idle", workspaceId: "ws-default", name: "Idle", description: "", projectId: null });

    expect(flow.status).toBe("ready");
    expect(store.listUserTurns(flow.id)).toEqual([]);
  });

  it("persists flow-scoped leader runtime selection ids", () => {
    const store = tempStore();
    store.migrate();

    const flow = store.createFlow({
      id: "flow-runtime",
      workspaceId: "ws-default",
      name: "Runtime",
      description: "",
      projectId: null,
      leaderRuntimeConfigId: "config-a",
      leaderRuntimeModelId: "model-a",
    });
    expect(flow.leaderRuntimeConfigId).toBe("config-a");
    expect(flow.leaderRuntimeModelId).toBe("model-a");

    const updated = store.updateFlow(flow.id, {
      leaderRuntimeConfigId: "config-b",
      leaderRuntimeModelId: "model-b",
    });

    expect(updated).toEqual(expect.objectContaining({
      leaderRuntimeConfigId: "config-b",
      leaderRuntimeModelId: "model-b",
    }));
    expect(store.getFlow(flow.id)).toEqual(expect.objectContaining({
      leaderRuntimeConfigId: "config-b",
      leaderRuntimeModelId: "model-b",
    }));
  });

  it("tracks product user turn active duration across wait and resume", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-turn", workspaceId: "ws-default", name: "Turn", description: "", projectId: null });

    const turn = store.createUserTurn({
      flowId: flow.id,
      triggerMessageId: "msg-user-1",
      startedAt: "2026-06-26T10:00:00.000Z",
    })!;
    const waiting = store.pauseUserTurnForUserAction(turn.id, "2026-06-26T10:00:03.000Z")!;
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.activeDurationMs).toBe(3000);

    const resumed = store.resumeUserTurn(turn.id, "2026-06-26T10:00:10.000Z")!;
    expect(resumed.status).toBe("active");
    expect(resumed.activeDurationMs).toBe(3000);

    const completed = store.completeUserTurn(turn.id, "2026-06-26T10:00:12.000Z")!;
    expect(completed.status).toBe("completed");
    expect(completed.activeDurationMs).toBe(5000);
  });

  it("migrates legacy project rows that do not have updated_at", () => {
    const store = tempStore();
    store.sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'claude_code',
        description TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects (id, workspace_id, name, local_path, agent_type, description, created_at)
      VALUES ('proj-legacy', 'ws-default', 'Legacy Project', '/tmp/legacy', 'claude_code', '', '2026-01-01T00:00:00.000Z');
    `);

    store.migrate();

    expect(columnNames(store, "projects")).not.toEqual(expect.arrayContaining(["workspace_id"]));
    expect(columnNames(store, "projects")).not.toEqual(expect.arrayContaining(["agent_type"]));
    expect(store.listProjects()).toEqual([
      expect.objectContaining({
        id: "proj-legacy",
        updatedAt: "",
      }),
    ]);
  });

  it("migrates legacy flow rows with an unpinned default", () => {
    const store = tempStore();
    store.sqlite.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'ws-default',
        project_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        leader_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO flows (
        id, workspace_id, project_id, name, description, status,
        leader_session_id, created_at, updated_at
      ) VALUES (
        'flow-legacy', 'ws-default', NULL, 'Legacy Flow', '', 'ready',
        NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    markRuntimeMessageProtocolV2(store);

    store.migrate();

    expect(columnNames(store, "flows")).not.toEqual(expect.arrayContaining(["workspace_id"]));
    expect(store.getFlow("flow-legacy")).toEqual(expect.objectContaining({ isPinned: 0 }));
  });

  it("clears pre-canonical Flows instead of retaining a mixed history architecture", () => {
    const store = tempStore();
    store.migrate();
    store.createFlow({ id: "flow-pre-canonical", workspaceId: "ws-default", name: "Old Flow", description: "", projectId: null });
    store.sqlite.prepare("DELETE FROM app_metadata WHERE key = 'canonical_transcript_version'").run();

    store.migrate();

    expect(store.getFlow("flow-pre-canonical")).toBeUndefined();
    expect(store.sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'canonical_transcript_version'").get())
      .toEqual({ value: "2" });
  });

  it("requires decision cards to belong to an active UserTurn", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-card", workspaceId: "ws-default", name: "Card", description: "", projectId: null });
    expect(store.createDecisionCard({
      flowId: flow.id,
      cardId: "dc-without-turn",
      sessionId: "session",
      cardType: "SpecApprovalCard",
      questions: [{ header: "审批", question: "通过吗？", multiSelect: false, options: [{ label: "是", description: "通过" }, { label: "否", description: "拒绝" }] }],
    })).toBeUndefined();
    const userTurn = beginUserTurn(store, { flowId: flow.id })!;
    const card = store.createDecisionCard({
      flowId: flow.id,
      userTurnId: userTurn.id,
      cardId: "dc-user-turn",
      sessionId: "session",
      cardType: "SpecApprovalCard",
      questions: [{ header: "审批", question: "通过吗？", multiSelect: false, options: [{ label: "是", description: "通过" }, { label: "否", description: "拒绝" }] }],
    })!;
    expect(card.userTurnId).toBe(userTurn.id);
    expect(card.cardType).toBe("SpecApprovalCard");
  });

  it("migrates legacy runtime tables to include UserTurn ownership columns", () => {
    const store = tempStore();
    store.sqlite.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        expert_id TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE decision_cards (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        questions TEXT NOT NULL,
        answers TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE event_log (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    store.migrate();

    expect(columnNames(store, "agent_sessions")).toEqual(expect.arrayContaining([
      "user_turn_id",
      "task_id",
      "display_name",
      "resume_from_agent_session_id",
      "status",
      "updated_at",
    ]));
    expect(columnNames(store, "decision_cards")).toEqual(expect.arrayContaining([
      "user_turn_id",
      "session_id",
      "card_type",
      "resolved_at",
    ]));
    expect(columnNames(store, "artifacts")).toEqual(expect.arrayContaining([
      "user_turn_id",
      "task_id",
      "source_agent_session_id",
      "updated_at",
    ]));
    expect(columnNames(store, "event_log")).toEqual(expect.arrayContaining([
      "user_turn_id",
      "task_id",
      "agent_session_id",
    ]));
  });

  it("uses UserTurn task tables without legacy runtime tables", () => {
    const store = tempStore();
    store.migrate();

    expect(tableNames(store)).toEqual(expect.arrayContaining([
      "user_turns",
      "tasks",
      "event_log",
      "spec_revisions",
      "task_dependencies",
    ]));

    expect(tableNames(store)).not.toEqual(expect.arrayContaining([
      "flow_runs",
      "flow_phases",
      "flow_tasks",
    ]));

    expect(tableNames(store)).not.toContain("executions");
    expect(columnNames(store, "user_turns")).toEqual(expect.arrayContaining([
      "id",
      "flow_id",
      "spec_revision_id",
      "target_project_id",
      "work_root_path",
      "input_snapshot_json",
      "status",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at",
    ]));

    expect(columnNames(store, "tasks")).toEqual(expect.arrayContaining([
      "id",
      "flow_id",
      "user_turn_id",
      "title",
      "description",
      "expert_id",
      "status",
      "active_form",
      "agent_session_id",
      "acceptance_criteria_json",
      "result_artifact_ids_json",
      "result_json",
      "error_message",
      "created_by_agent_session_id",
      "created_at",
      "started_at",
      "finished_at",
      "updated_at",
    ]));
  });

  it("migrates legacy task statuses to the public task state model", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({
      id: "flow-task-status-migration",
      workspaceId: "ws-default",
      name: "Status migration",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: "/tmp/flow-task-status-migration",
    })!;
    const readyTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Ready",
      description: "Ready",
      expertId: "exp-frontend",
      dependsOnTaskIds: [],
    })!;
    const runningTask = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Running",
      description: "Running",
      expertId: "exp-backend",
      dependsOnTaskIds: [],
    })!;
    store.sqlite.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(readyTask.id);
    store.sqlite.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(runningTask.id);

    store.migrate();

    expect(store.getTask(readyTask.id)?.status).toBe("pending");
    expect(store.getTask(runningTask.id)?.status).toBe("in_progress");
  });

  it("creates and transitions spec revisions without allowing superseded work", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-spec", workspaceId: "ws-default", name: "Spec", description: "", projectId: null });

    const first = store.createSpecRevision({
      flowId: flow.id,
      title: "Login Spec",
      content: "# Login",
      sourceAgentSessionId: "ags-leader",
    });
    expect(first.revisionNumber).toBe(1);
    expect(first.status).toBe("draft");

    const second = store.createSpecRevision({
      flowId: flow.id,
      title: "Login Spec v2",
      content: "# Login v2",
      sourceAgentSessionId: "ags-leader",
    });

    expect(second.revisionNumber).toBe(2);
    expect(store.listSpecRevisions(flow.id).map((row) => [row.revisionNumber, row.status])).toEqual([
      [1, "superseded"],
      [2, "draft"],
    ]);

    expect(store.approveSpecRevision(second.id)?.status).toBe("approved");
    expect(store.markSpecRevisionExecuted(second.id)?.status).toBe("executed");
    expect(store.markSpecRevisionExecuted(first.id)).toBeUndefined();
  });

  it("starts approved Spec work on its existing UserTurn", () => {
    const store = tempStore();
    store.migrate();
    const project = store.createProject({ workspaceId: "ws-default", name: "Project", localPath: "/tmp/project" });
    const flow = store.createFlow({ id: "flow-exec", workspaceId: "ws-default", name: "Execution", description: "", projectId: project.id });
    const spec = store.createSpecRevision({
      flowId: flow.id,
      title: "Spec",
      content: "content",
      sourceAgentSessionId: "ags-leader",
    })!;

    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-spec" })!;
    const approval = store.createSpecApproval({
      flowId: flow.id,
      userTurnId: userTurn.id,
      specRevisionId: spec.id,
      fileName: spec.fileName,
      overview: spec.overview,
    })!;
    store.pauseUserTurnForUserAction(userTurn.id);
    const started = store.runApprovedSpecForUserTurn({
      flowId: flow.id,
      specApprovalId: approval.id,
      specRevisionId: spec.id,
      targetProjectId: project.id,
      inputSnapshotJson: JSON.stringify({ prompt: "build login" }),
    })!;

    expect(started.id).toBe(userTurn.id);
    expect(started.status).toBe("active");
    expect(started.specRevisionId).toBe(spec.id);
    expect(started.targetProjectId).toBe(project.id);
    expect(started.workRootPath).toBe("/tmp/project");
    expect(store.getFlow(flow.id)?.status).toBe("active");
    expect(store.getSpecRevision(spec.id)?.status).toBe("executed");

    expect(store.completeUserTurn(started.id)?.status).toBe("completed");
    expect(store.getFlow(flow.id)?.status).toBe("idle");
    expect(store.listUserTurns(flow.id).map((row) => row.id)).toEqual([started.id]);
  });

  it("allows only one open UserTurn per flow", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-one-active", workspaceId: "ws-default", name: "One", description: "", projectId: null });

    const first = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-first" });
    const second = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-second" });

    expect(first?.status).toBe("active");
    expect(second).toBeUndefined();
    expect(store.listUserTurns(flow.id)).toHaveLength(1);
  });

  it("creates task dependencies and unlocks downstream tasks when dependencies complete", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-dag", workspaceId: "ws-default", name: "DAG", description: "", projectId: null });
    const userTurn = beginUserTurn(store, { flowId: flow.id, sandboxPath: "/tmp/flow-dag" })!;

    const implement = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Implement login",
      description: "Create login UI",
      expertId: "exp-frontend",
      dependsOnTaskIds: [],
      acceptanceCriteria: ["login form exists"],
      createdByAgentSessionId: "ags-leader",
    })!;
    const verify = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Verify login",
      description: "Check login behavior",
      expertId: "exp-verify",
      dependsOnTaskIds: [implement.id],
      acceptanceCriteria: ["valid login succeeds"],
      createdByAgentSessionId: "ags-leader",
    })!;

    expect(implement.status).toBe("pending");
    expect(verify.status).toBe("pending");
    expect(store.listTaskDependencies(verify.id)).toEqual([implement.id]);
    expect(store.listRunnableTasks(userTurn.id).map((task) => task.id)).toEqual([implement.id]);

    expect(store.startTask(implement.id, "ags-implement")?.status).toBe("in_progress");
    store.completeTask(implement.id, JSON.stringify({ summary: "done" }));

    expect(store.getTask(verify.id)?.status).toBe("pending");
    expect(store.listRunnableTasks(userTurn.id).map((task) => task.id)).toEqual([verify.id]);
  });

  it("updates task fields through the platform task API", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({
      id: "flow-update-task",
      workspaceId: "ws-default",
      name: "Update",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: "/tmp/flow-update-task",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Old",
      description: "Old desc",
      expertId: "exp-frontend",
      dependsOnTaskIds: [],
    })!;

    store.assignTaskAgentSession(task.id, "ags-update");
    store.startTask(task.id, "ags-update");

    const updated = store.updateTask(task.id, {
      title: "New",
      description: "New desc",
      status: "failed",
      activeForm: "Fix failed validation",
      resultJson: JSON.stringify({ summary: "failed" }),
      errorMessage: "validation failed",
    });

    expect(updated).toEqual(expect.objectContaining({
      id: task.id,
      title: "New",
      description: "New desc",
      status: "failed",
      activeForm: "Fix failed validation",
      resultJson: JSON.stringify({ summary: "failed" }),
      errorMessage: "validation failed",
    }));
  });

  it("rejects invalid status transitions", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({
      id: "flow-transition",
      workspaceId: "ws-default",
      name: "Transition",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: "/tmp/flow-transition",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "T",
      description: "T",
      dependsOnTaskIds: [],
    })!;

    expect(store.updateTask(task.id, { status: "completed" })).toBeUndefined();
    expect(store.updateTask(task.id, { status: "failed" })).toBeUndefined();
    expect(store.updateTask(task.id, { status: "in_progress" })?.status).toBe("in_progress");
  });

  it("rejects adding blocks to a non-pending task", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({
      id: "flow-block-target",
      workspaceId: "ws-default",
      name: "Block target",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: "/tmp/flow-block-target",
    })!;
    const pending = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Pending",
      description: "Pending",
      dependsOnTaskIds: [],
    })!;
    const started = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Started",
      description: "Started",
      dependsOnTaskIds: [],
    })!;
    store.assignTaskAgentSession(started.id, "ags-started");
    store.startTask(started.id, "ags-started");

    expect(store.updateTask(pending.id, { addBlocks: [started.id] })).toBeUndefined();
  });

  it("starts a task with its already assigned agent session", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({
      id: "flow-assigned-task",
      workspaceId: "ws-default",
      name: "Assigned",
      description: "",
      projectId: null,
    });
    const userTurn = beginUserTurn(store, {
      flowId: flow.id,
      sandboxPath: "/tmp/flow-assigned-task",
    })!;
    const task = store.createTask({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Build",
      description: "Build",
      expertId: "exp-frontend",
      dependsOnTaskIds: [],
    })!;

    store.assignTaskAgentSession(task.id, "ags-build");

    expect(store.startTask(task.id, "ags-build")?.status).toBe("in_progress");
    expect(store.startTask(task.id, "ags-other")).toBeUndefined();
  });

  it("appends event log records with monotonic sequence numbers", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-events", workspaceId: "ws-default", name: "Events", description: "", projectId: null });
    const first = store.appendEventLog({
      flowId: flow.id,
      eventType: "flow.message",
      payload: { text: "hello" },
    })!;
    const second = store.appendEventLog({
      flowId: flow.id,
      eventType: "leader.message",
      payload: { text: "hi" },
    })!;

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.listEventLog(flow.id).map((event) => [event.sequence, event.eventType])).toEqual([
      [1, "flow.message"],
      [2, "leader.message"],
    ]);
  });

  it("tracks unread only after completed session output and clears it when read", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-unread", workspaceId: "ws-default", name: "Unread", description: "", projectId: null });

    expect(store.hasUnreadOutput(flow.id)).toBe(false);

    store.markFlowOutputCompleted(flow.id, "2026-06-12T01:00:00.000Z");
    expect(store.hasUnreadOutput(flow.id)).toBe(true);

    store.markFlowRead(flow.id, "local-default", "2026-06-12T01:00:00.000Z");
    expect(store.hasUnreadOutput(flow.id)).toBe(false);
  });

  it("creates the database parent directory when it is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-nested-db-"));
    dirs.push(dir);
    const databasePath = path.join(dir, "data", "nested", "squadflow.db");
    const store = createStore(databasePath);
    stores.push(store);

    store.migrate();

    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("seeds stable expert ids", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    store.seedExperts();

    const expertRows = store.db.select().from(experts).all();
    expect(expertRows).toHaveLength(5);
    expect(new Set(expertRows.map((expert) => expert.id)).size).toBe(expertRows.length);

    const leader = store.getExpert("exp-leader");
    expect(leader?.role).toBe("leader");
    expect(store.getExpert("exp-verify")?.role).toBe("verify");
  });

  it("seeds the default leader system prompt into the experts table", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();

    const leader = store.getExpert("exp-leader");
    expect(leader?.systemPrompt).toBe(DEFAULT_LEADER_SYSTEM_PROMPT);
    expect(JSON.parse(leader?.builtinTools ?? "[]")).toEqual([
      "read",
      "write",
      "edit",
      "search",
      "shell",
    ]);
    const leaderMcpTools = JSON.parse(leader?.mcpTools ?? "[]") as string[];
    expect(leaderMcpTools).not.toContain("save_spec");
    expect(leaderMcpTools).not.toContain("save_artifact");
    expect(leaderMcpTools).toEqual([
      "mcp__squadflow-leader__get_context",
      "mcp__squadflow-leader__ask_user",
      "mcp__squadflow-leader__create_plan",
      "mcp__squadflow-leader__create_task",
      "mcp__squadflow-leader__save_execution_plan",
      "mcp__squadflow-leader__submit_orchestration_plan",
      "mcp__squadflow-leader__resolve_plan_feedback",
      "mcp__squadflow-leader__update_task",
      "mcp__squadflow-leader__list_tasks",
      "mcp__squadflow-leader__get_task",
      "mcp__squadflow-leader__dispatch_agent",
      "mcp__squadflow-leader__cancel_agent",
      "mcp__squadflow-leader__send_message",
      "mcp__squadflow-browser__browser_navigate",
      "mcp__squadflow-browser__browser_reload",
      "mcp__squadflow-browser__browser_snapshot",
      "mcp__squadflow-browser__browser_click",
      "mcp__squadflow-browser__browser_fill",
      "mcp__squadflow-browser__browser_wait_for",
      "mcp__squadflow-browser__browser_screenshot",
      "mcp__squadflow-browser__browser_console_logs",
      "mcp__squadflow-browser__browser_eval",
    ]);
  });

  it("refreshes an existing built-in leader prompt when experts are reseeded", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    store.sqlite
      .prepare("UPDATE experts SET system_prompt = ? WHERE id = ?")
      .run("# Leader 系统提示词 legacy", "exp-leader");

    store.seedExperts();

    expect(store.getExpert("exp-leader")?.systemPrompt).toBe(DEFAULT_LEADER_SYSTEM_PROMPT);
  });

  it("seeds non-leader experts without artifact/spec save instructions", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();

    const nonLeaderIds = ["exp-research", "exp-coder", "exp-verify", "exp-codereview"];
    for (const id of nonLeaderIds) {
      const expert = store.getExpert(id);
      expect(expert).toBeTruthy();
      expect(expert?.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(expert?.systemPrompt).not.toContain("save_artifact");
      expect(expert?.systemPrompt).not.toContain("save_spec");
    }
  });

  it("replaces the deprecated message table and removes legacy runtime tables", () => {
    const store = tempStore();
    const deprecatedTables = [
      "team_messages",
      "agent_inbox",
      "send_messages",
      "teams",
      "flow_runs",
      "flow_phases",
      "flow_tasks",
      "session_log",
      "workspaces",
    ];
    for (const table of deprecatedTables) {
      store.sqlite.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    }

    store.migrate();

    for (const table of deprecatedTables) {
      expect(
        store.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .all(table),
      ).toEqual([]);
    }
    expect(tableNames(store)).toContain("flow_experts");
    expect(columnNames(store, "chat_messages")).toEqual(expect.arrayContaining([
      "flow_id",
      "channel_id",
      "message_id",
      "position",
      "payload_json",
    ]));
    expect(columnNames(store, "flow_experts")).toEqual(expect.arrayContaining([
      "flow_id",
      "expert_id",
      "sdk_session_id",
      "runtime_sdk",
      "runtime_config_id",
      "runtime_model_id",
    ]));
  });

  it("migrates the legacy Spec marker, spec approval, and V1 task columns", () => {
    const store = tempStore();
    store.migrate();

    expect(columnNames(store, "flows")).toEqual(expect.arrayContaining(["legacy_spec_flow"]));
    expect(columnNames(store, "flows")).not.toContain("agent_mode");
    expect(columnNames(store, "user_turns")).toEqual(expect.arrayContaining(["work_source", "work_root_path"]));
    expect(columnNames(store, "spec_revisions")).toEqual(expect.arrayContaining(["overview", "file_name"]));
    expect(tableNames(store)).toEqual(expect.arrayContaining(["spec_approvals"]));
    expect(columnNames(store, "tasks")).toEqual(expect.arrayContaining(["metadata_json"]));

    const taskExpert = (store.sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; notnull: number }>)
      .find((row) => row.name === "expert_id");
    expect(taskExpert?.notnull).toBe(0);
  });

  it("migrates legacy approval policies into independent Flow modes and removes legacy tables", () => {
    const store = tempStore();
    store.sqlite.exec(`
      CREATE TABLE flows (
        id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'ready', legacy_spec_flow INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0, last_output_completed_at TEXT,
        leader_session_id TEXT, leader_runtime_sdk TEXT, leader_runtime_config_id TEXT,
        leader_runtime_model_id TEXT, leader_runtime_reasoning_effort TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE orchestration_settings (
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '',
        approval_policy TEXT NOT NULL DEFAULT 'smart', config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id)
      );
      CREATE TABLE scoped_authorizations (
        id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, user_turn_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL, operation_type TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE TABLE plan_approvals (
        id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, user_turn_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
        policy TEXT NOT NULL DEFAULT 'smart', reason_json TEXT NOT NULL DEFAULT '[]',
        resolution_action_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      INSERT INTO flows (id, name, created_at, updated_at) VALUES
        ('flow-manual', 'manual', 'now', 'now'),
        ('flow-smart', 'smart', 'now', 'now'),
        ('flow-auto', 'auto', 'now', 'now');
      INSERT INTO orchestration_settings (scope_type, scope_id, approval_policy, updated_at) VALUES
        ('flow', 'flow-manual', 'manual', 'now'),
        ('flow', 'flow-smart', 'smart', 'now'),
        ('flow', 'flow-auto', 'auto', 'now');
    `);
    markRuntimeMessageProtocolV2(store);

    store.migrate();

    expect(store.getFlow("flow-manual")).toEqual(expect.objectContaining({ riskMode: "auto_edit", planApproval: "on" }));
    expect(store.getFlow("flow-smart")).toEqual(expect.objectContaining({ riskMode: "auto_edit", planApproval: "on" }));
    expect(store.getFlow("flow-auto")).toEqual(expect.objectContaining({ riskMode: "full_access", planApproval: "off" }));
    expect(tableNames(store)).not.toEqual(expect.arrayContaining(["orchestration_settings", "scoped_authorizations"]));
    expect(columnNames(store, "plan_approvals")).not.toEqual(expect.arrayContaining(["policy", "reason_json"]));
  });

  it("keeps Flow modes after reopening the database", () => {
    const databasePath = tempDb();
    const first = createStore(databasePath);
    first.migrate();
    const flow = first.createFlow({ name: "Persistent modes", description: "", projectId: null });
    first.updateFlow(flow.id, { riskMode: "full_access", planApproval: "off" });
    first.sqlite.close();

    const reopened = createStore(databasePath);
    stores.push(reopened);
    reopened.migrate();
    expect(reopened.getFlow(flow.id)).toEqual(expect.objectContaining({ riskMode: "full_access", planApproval: "off" }));
  });

  it("uses fixed Flow mode defaults and persists independent overrides", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-mode", workspaceId: "ws-default", name: "Mode", description: "", projectId: null });
    const otherFlow = store.createFlow({ id: "flow-mode-other", workspaceId: "ws-default", name: "Other mode", description: "", projectId: null });

    expect(store.getFlow(flow.id)?.legacySpecFlow).toBe(0);
    expect(store.getRiskMode(flow.id)).toBe("auto_edit");
    expect(store.getPlanApprovalMode(flow.id)).toBe("on");
    store.updateFlow(flow.id, { riskMode: "full_access", planApproval: "off" });
    expect(store.getRiskMode(flow.id)).toBe("full_access");
    expect(store.getPlanApprovalMode(flow.id)).toBe("off");
    expect(store.getRiskMode(otherFlow.id)).toBe("auto_edit");
    expect(store.getPlanApprovalMode(otherFlow.id)).toBe("on");
  });

  it("persists a message-level Spec request on the UserTurn until Spec starts", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-spec-request", name: "Spec request", description: "", projectId: null });
    const turn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-spec-request", specRequested: true });

    expect(JSON.parse(turn!.inputSnapshotJson)).toEqual({
      type: "direct_message",
      message_id: "msg-spec-request",
      spec_requested: true,
    });
  });

  it("materializes plan tasks without the removed scoped authorization table", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-authz", workspaceId: "ws-default", name: "Authz", description: "", projectId: null });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-authz" })!;
    const created = store.createOrchestrationPlanRevision({
      flowId: flow.id,
      userTurnId: userTurn.id,
      title: "Scoped write",
      objective: "Write only src",
      workKind: "change",
      riskLevel: "high",
      status: "approved",
      lint: [],
      nodes: [{
        nodeId: "code",
        expertId: "exp-coder",
        title: "Write src",
        description: "Write src",
        dependsOn: [],
        acceptanceCriteria: ["done"],
        riskTags: ["destructive"],
        sideEffects: ["write"],
        resourceKeys: ["src"],
      }],
      diff: {},
    })!;
    const run = store.materializePlanRun(created.revision.id)!;
    expect(run.status).toBe("running");
    expect(store.listPlanNodeTasks(run.id)).toHaveLength(1);
    expect(tableNames(store)).not.toContain("scoped_authorizations");
  });

  it("creates pending spec approvals separately from decision cards", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-spec", workspaceId: "ws-default", name: "Spec", description: "", projectId: null });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-spec" })!;
    const spec = store.createSpecRevision({
      flowId: flow.id,
      name: "Hello World",
      overview: "Create a Hello World page.",
      content: "# Hello World",
      sourceAgentSessionId: "ags-leader",
    })!;
    const approval = store.createSpecApproval({
      flowId: flow.id,
      specRevisionId: spec.id,
      fileName: spec.fileName,
      overview: spec.overview,
      userTurnId: userTurn.id,
    })!;

    expect(approval).toEqual(expect.objectContaining({
      flowId: flow.id,
      specRevisionId: spec.id,
      status: "pending",
      fileName: spec.fileName,
      overview: spec.overview,
    }));
    expect(store.listDecisionCards(flow.id)).toEqual([]);
  });

  it("creates Spec revision and approval together without overwriting executed history", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-plan", workspaceId: "ws-default", name: "Plan", description: "", projectId: null });
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-plan" })!;
    const first = store.createSpecPlan({
      flowId: flow.id,
      mode: "write",
      name: "Hello World",
      overview: "First version.",
      content: "# First",
      userTurnId: userTurn.id,
    })!;
    store.resolveSpecApproval(first.approval.id, "approved");
    store.markSpecRevisionExecuted(first.spec.id);

    const second = store.createSpecPlan({
      flowId: flow.id,
      mode: "rewrite",
      overview: "Second version.",
      content: "# Second",
      userTurnId: userTurn.id,
    })!;

    expect(store.getSpecRevision(first.spec.id)?.status).toBe("executed");
    expect(second.spec.revisionNumber).toBe(2);
    expect(second.spec.fileName).toMatch(/^Hello_World_r2_[0-9a-f]+\.md$/);
    expect(second.approval).toEqual(expect.objectContaining({
      specRevisionId: second.spec.id,
      status: "pending",
    }));
  });

  it("returns V1 flow control pointers in the snapshot", () => {
    const store = tempStore();
    store.migrate();
    const flow = store.createFlow({ id: "flow-snapshot", workspaceId: "ws-default", name: "Snapshot", description: "", projectId: null });
    store.sqlite.prepare("UPDATE flows SET legacy_spec_flow = 1 WHERE id = ?").run(flow.id);
    const userTurn = store.createUserTurn({ flowId: flow.id, triggerMessageId: "msg-snapshot" })!;
    const spec = store.createSpecRevision({
      flowId: flow.id,
      name: "Hello World",
      overview: "Create a Hello World page.",
      content: "# Hello World",
    })!;
    const approval = store.createSpecApproval({
      flowId: flow.id,
      specRevisionId: spec.id,
      fileName: spec.fileName,
      overview: spec.overview,
      userTurnId: userTurn.id,
    })!;

    const snapshot = buildFlowSnapshot(store, flow.id);

    expect(snapshot).toEqual(expect.objectContaining({
      legacy_spec_flow: true,
      latest_spec: expect.objectContaining({
        spec_revision_id: spec.id,
        file_name: spec.fileName,
        overview: spec.overview,
      }),
      pending_spec_approval: expect.objectContaining({
        spec_approval_id: approval.id,
        spec_revision_id: spec.id,
        status: "pending",
      }),
    }));
  });

  it("deletes a flow together with its runtime rows", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    const flow = createFlowWithRuntimeRows(store, "flow-delete");

    expect(store.deleteFlow(flow.id)).toBe(true);

    expect(store.getFlow(flow.id)).toBeUndefined();
    expect(store.listUserTurns(flow.id)).toEqual([]);
    expect(store.listTasks(flow.id)).toEqual([]);
    expect(store.listAgentSessions(flow.id)).toEqual([]);
    expect(store.listFlowExperts(flow.id)).toEqual([]);
    expect(store.listDecisionCards(flow.id)).toEqual([]);
    expect(store.listPendingDecisionCardLeaderInputs(flow.id)).toEqual([]);
    expect(store.listArtifacts(flow.id)).toEqual([]);
  });

  it("clears flows together with their runtime rows", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    const first = createFlowWithRuntimeRows(store, "flow-clear-1");
    const second = createFlowWithRuntimeRows(store, "flow-clear-2");

    store.clearFlows();

    expect(store.listFlows()).toEqual([]);
    for (const flow of [first, second]) {
      expect(store.listUserTurns(flow.id)).toEqual([]);
      expect(store.listTasks(flow.id)).toEqual([]);
      expect(store.listAgentSessions(flow.id)).toEqual([]);
      expect(store.listFlowExperts(flow.id)).toEqual([]);
      expect(store.listDecisionCards(flow.id)).toEqual([]);
      expect(store.listPendingDecisionCardLeaderInputs(flow.id)).toEqual([]);
      expect(store.listArtifacts(flow.id)).toEqual([]);
    }
  });

  it("keeps context usage cache stats when a later live sample has none", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({ id: "flow-context-cache", workspaceId: "ws-default", name: "Context Cache", description: "", projectId: null });
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-context-cache",
      displayName: "Leader",
    });

    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 1_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.5,
      model: "claude-sonnet",
      categories: [],
      cacheInputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
      observedAt: "2026-06-28T10:00:00.000Z",
    });
    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 1_100,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.55,
      model: "claude-sonnet",
      categories: [],
      cacheInputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
      observedAt: "2026-06-28T10:00:05.000Z",
    });

    expect(store.getAgentContextUsageSnapshot(session.id)).toEqual(expect.objectContaining({
      totalTokens: 1_100,
      percentage: 0.55,
      cacheInputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
    }));
  });

  it("clears stale cache stats when input usage explicitly reports cache telemetry as unknown", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({ id: "flow-context-cache-unknown", workspaceId: "ws-default", name: "Context Cache Unknown", description: "", projectId: null });
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-context-cache-unknown",
      displayName: "Leader",
    });

    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache-unknown",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 1_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.5,
      model: "mimo-v2.5",
      categories: [],
      cacheInputTokens: 800,
      cacheReadInputTokens: 640,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
      observedAt: "2026-07-12T21:00:00.000Z",
    });
    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache-unknown",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 1_100,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.55,
      model: "mimo-v2.5",
      categories: [],
      cacheInputTokens: 900,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
      observedAt: "2026-07-12T21:00:05.000Z",
    });

    expect(store.getAgentContextUsageSnapshot(session.id)).toEqual(expect.objectContaining({
      totalTokens: 1_100,
      cacheInputTokens: 900,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    }));

    store.upsertAgentContextUsageSnapshot({
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache-unknown",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      totalTokens: 1_200,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0.6,
      model: "mimo-v2.5",
      categories: [],
      cacheInputTokens: 1_000,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
      cacheHitRate: 90,
      observedAt: "2026-07-12T21:00:10.000Z",
    });

    expect(store.getAgentContextUsageSnapshot(session.id)).toEqual(expect.objectContaining({
      cacheInputTokens: 1_000,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
      cacheHitRate: 90,
    }));
  });

  it("clears a stale cache rate when observed input and cache counts have a zero denominator", () => {
    const store = tempStore();
    store.migrate();
    store.seedExperts();
    const flow = store.createFlow({ id: "flow-context-cache-zero", workspaceId: "ws-default", name: "Context Cache Zero", description: "", projectId: null });
    const session = store.createAgentSession({
      flowId: flow.id,
      userTurnId: null,
      taskId: null,
      expertId: "exp-leader",
      sessionId: "sdk-context-cache-zero",
      displayName: "Leader",
    });
    const base = {
      flowId: flow.id,
      agentSessionId: session.id,
      sdkSessionId: "sdk-context-cache-zero",
      role: "leader",
      expertId: "exp-leader",
      flowExpertId: null,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      model: "mimo-v2.5",
      categories: [],
    };

    store.upsertAgentContextUsageSnapshot({
      ...base,
      totalTokens: 1_000,
      percentage: 0.5,
      cacheInputTokens: 800,
      cacheReadInputTokens: 640,
      cacheCreationInputTokens: 0,
      cacheHitRate: 80,
      observedAt: "2026-07-12T21:10:00.000Z",
    });
    store.upsertAgentContextUsageSnapshot({
      ...base,
      totalTokens: 1_010,
      percentage: 0.505,
      cacheInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
      observedAt: "2026-07-12T21:10:05.000Z",
    });

    expect(store.getAgentContextUsageSnapshot(session.id)).toEqual(expect.objectContaining({
      cacheInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: null,
      cacheHitRate: null,
    }));
  });
});

import { describe, expect, it } from "vitest";
import {
  FlowSchema,
  FlowStatusSchema,
  TaskSchema,
  TaskItemSchema,
  WorkRunSchema,
} from "../src/domain/schemas.js";
import { ClientWsMessageSchema, ServerWsMessageSchema } from "../src/protocol/wsMessages.js";

describe("domain schemas", () => {
  it("accepts the three supported flow statuses", () => {
    expect(FlowStatusSchema.parse("ready")).toBe("ready");
    expect(FlowStatusSchema.parse("active")).toBe("active");
    expect(FlowStatusSchema.parse("idle")).toBe("idle");
  });

  it("rejects deprecated done flow status", () => {
    expect(() => FlowStatusSchema.parse("done")).toThrow();
  });

  it("parses a flow row shape", () => {
    const flow = FlowSchema.parse({
      id: "flow-abc",
      workspace_id: "ws-default",
      project_id: null,
      name: "hello",
      description: "",
      name_generation_status: "generated",
      status: "ready",
      legacy_spec_flow: false,
      leader_session_id: null,
      created_at: "2026-06-06T12:00:00+08:00",
      updated_at: "2026-06-06T12:00:00+08:00",
    });
    expect(flow.status).toBe("ready");
  });

  it("parses a WorkRun row shape", () => {
    const workRun = WorkRunSchema.parse({
      id: "utn-abc",
      flow_id: "flow-abc",
      trigger_message_id: "msg-abc",
      work_source: "direct_message",
      spec_revision_id: null,
      target_project_id: null,
      work_root_path: "/repo",
      input_snapshot_json: "{}",
      status: "executing",
      revision: 2,
      started_at: "2026-06-06T12:00:00+08:00",
      execution_started_at: "2026-06-06T12:00:00+08:00",
      active_started_at: "2026-06-06T12:00:00+08:00",
      active_duration_ms: 0,
      waiting_started_at: null,
      completed_at: null,
      created_at: "2026-06-06T12:00:00+08:00",
      updated_at: "2026-06-06T12:00:00+08:00",
    });
    expect(workRun.status).toBe("executing");
  });

  it("parses a task row shape", () => {
    const task = TaskSchema.parse({
      id: "task-abc",
      flow_id: "flow-abc",
      work_run_id: "utn-abc",
      title: "Create script",
      description: "Create hello.py",
      expert_id: "exp-backend",
      status: "pending",
      revision: 1,
      active_form: "",
      progress: null,
      agent_session_id: null,
      metadata_json: "{}",
      acceptance_criteria_json: "[]",
      result_artifact_ids_json: "[]",
      result_json: null,
      error_message: null,
      created_by_agent_session_id: "",
      created_at: "2026-06-06T12:00:00+08:00",
      started_at: null,
      finished_at: null,
      updated_at: "2026-06-06T12:00:00+08:00",
    });
    expect(task.work_run_id).toBe("utn-abc");
  });

  it("parses a task row shape with nullable expert_id", () => {
    const task = TaskSchema.parse({
      id: "task-no-expert",
      flow_id: "flow-abc",
      work_run_id: "utn-abc",
      title: "Unassigned task",
      description: "No expert assigned yet",
      expert_id: null,
      status: "pending",
      revision: 1,
      active_form: "",
      progress: null,
      agent_session_id: null,
      metadata_json: "{}",
      acceptance_criteria_json: "[]",
      result_artifact_ids_json: "[]",
      result_json: null,
      error_message: null,
      created_by_agent_session_id: "",
      created_at: "2026-06-06T12:00:00+08:00",
      started_at: null,
      finished_at: null,
      updated_at: "2026-06-06T12:00:00+08:00",
    });
    expect(task.expert_id).toBeNull();
  });

  it("parses MCP task input", () => {
    const item = TaskItemSchema.parse({
      title: "Create script",
      description: "Create hello.py",
      expert_id: "exp-backend",
      depends_on_task_ids: [],
      acceptance_criteria: ["prints hello"],
      resume_from_agent_session_id: "",
    });
    expect(item.expert_id).toBe("exp-backend");
  });
});

describe("ws schemas", () => {
  it("parses client flow message envelope payload", () => {
    const parsed = ClientWsMessageSchema.parse({
      type: "flow:message",
      flow_id: "flow-abc",
      content: "写个 helloworld",
      log_id: "L1",
    });
    expect(parsed.type).toBe("flow:message");
  });

  it("parses client flow message image attachments", () => {
    const parsed = ClientWsMessageSchema.parse({
      type: "flow:message",
      flow_id: "flow-abc",
      content: "看这张图",
      attachments: [{
        id: "img-1",
        kind: "image",
        media_type: "image/png",
        data: "iVBORw0KGgo=",
        name: "pasted.png",
        width: 120,
        height: 80,
        text_offset: 2,
      }],
      log_id: "L1",
    });
    expect(parsed.type).toBe("flow:message");
    expect(parsed.attachments?.[0]).toEqual(expect.objectContaining({
      id: "img-1",
      media_type: "image/png",
      text_offset: 2,
    }));
  });

  it("parses client flow guide payload", () => {
    const parsed = ClientWsMessageSchema.parse({
      type: "flow:guide",
      flow_id: "flow-abc",
      content: "补充当前 turn",
      client_message_id: "msg-guide-1",
      log_id: "L1",
    });
    expect(parsed.type).toBe("flow:guide");
  });

  it("rejects unexpected top-level client message fields", () => {
    expect(() =>
      ClientWsMessageSchema.parse({
        type: "flow:message",
        flow_id: "flow-abc",
        content: "写个 helloworld",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("parses a cursor-addressed transcript event", () => {
    const parsed = ServerWsMessageSchema.parse({
      type: "session:transcript_event",
      flow_id: "flow-abc",
      session_id: "sdk-session",
      agent_session_id: "as-1",
      flow_expert_id: "as-1",
      log_id: "L1",
      data: { stream_epoch: "epoch-1", cursor: 7, timeline_items: [], event: { type: "text-delta", messageId: "msg-1", id: "blk-1", delta: "hello" } },
    });
    expect(parsed.type).toBe("session:transcript_event");
  });

  it("rejects uncontracted transcript event metadata", () => {
    expect(() => ServerWsMessageSchema.parse({
      type: "session:transcript_event",
      flow_id: "flow-abc",
      session_id: "sdk-session",
      agent_session_id: "as-1",
      flow_expert_id: "as-1",
      log_id: "L1",
      data: {
        stream_epoch: "epoch-1",
        cursor: 7,
        timeline_items: [],
        event: { type: "text-delta", messageId: "msg-1", id: "blk-1", delta: "hello" },
        agent: "Frontend",
        agent_role: "frontend",
      },
    })).toThrow();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { parseMessageSegments } from "../src/protocol/platformEvent.js";
import { buildLeaderPrompt } from "../src/runtime/leaderPrompt.js";

const originalRuntimeConfigRoot = config.agentRuntimeConfigRoot;
let runtimeConfigRoot = "";

beforeAll(() => {
  runtimeConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leader-prompt-"));
  config.agentRuntimeConfigRoot = runtimeConfigRoot;
});

afterAll(() => {
  config.agentRuntimeConfigRoot = originalRuntimeConfigRoot;
  fs.rmSync(runtimeConfigRoot, { recursive: true, force: true });
});

function expertResultInput(summary: string) {
  return {
    flowId: "flow-1",
    kind: "expert_result" as const,
    expertResult: {
      taskId: "task-1",
      agentSessionId: "ags-1",
      expertId: "exp-backend",
      turnOutcome: "completed",
      summary,
      error: null,
      artifactRefs: [],
      completedAt: "2026-07-03T00:00:00.000Z",
    },
    leaderAgentSessionId: "leader-ags",
    leaderSessionId: "leader-session",
  };
}

describe("buildLeaderPrompt", () => {
  it("emits one expert_result event with the Task ID only in its attribute", () => {
    const prompt = buildLeaderPrompt(expertResultInput("done"));
    const segments = parseMessageSegments(prompt, "flow-1");

    expect(segments).toEqual([expect.objectContaining({
      kind: "event",
      type: "expert_result",
      attrs: { task: "task-1" },
      body: "完成：done",
    })]);
    expect(prompt).not.toContain("agentSessionId");
    expect(prompt).not.toContain("expertId");
  });

  it("truncates expert summaries to 2000 characters", () => {
    const prompt = buildLeaderPrompt(expertResultInput("x".repeat(2500)));
    const segment = parseMessageSegments(prompt, "flow-1")[0];

    expect(segment).toMatchObject({ kind: "event", type: "expert_result" });
    expect(segment?.kind === "event" ? segment.body : "").toBe(`完成：${"x".repeat(2000)}`);
  });

  it("keeps user text raw and appends spec, plan feedback and browser events", () => {
    const prompt = buildLeaderPrompt({
      flowId: "flow-1",
      kind: "user",
      userMessage: "原始问题 <div>",
      specRequested: true,
      planFeedback: [{ marker_number: 1, plan_node_id: "node-1", comment: "补充测试" }],
      attachments: [{
        id: "browser-1",
        kind: "browser_comment",
        media_type: "image/png",
        data: "abc",
        marker_number: 1,
        comment: "按钮无响应",
        label: "提交按钮",
        selector: "#submit",
        page_url: "https://example.test",
      }],
      leaderAgentSessionId: "leader-ags",
      leaderSessionId: "leader-session",
    });
    const segments = parseMessageSegments(prompt, "flow-1");

    expect(segments.map((segment) => segment.kind === "event" ? segment.type : segment.raw)).toEqual([
      "原始问题 <div>",
      "spec_requested",
      "plan_feedback",
      "browser_comment",
    ]);
    expect(segments[3]).toMatchObject({
      kind: "event",
      type: "browser_comment",
      attrs: {
        n: "1",
        url: "https://example.test",
        label: "提交按钮",
        selector: "#submit",
      },
      body: "按钮无响应",
    });
    expect(prompt.match(/原始问题 <div>/gu)).toHaveLength(1);
  });

  it("emits plan feedback without synthesizing user text when content is empty", () => {
    const prompt = buildLeaderPrompt({
      flowId: "flow-1",
      kind: "user",
      userMessage: "",
      planFeedback: [{ marker_number: 2, comment: "补上验收条件" }],
      leaderAgentSessionId: "leader-ags",
      leaderSessionId: "leader-session",
    });

    expect(parseMessageSegments(prompt, "flow-1")).toEqual([
      expect.objectContaining({ kind: "event", type: "plan_feedback" }),
    ]);
    expect(prompt).not.toContain("对编排计划添加了");
  });

  it("uses the fixed decision cancellation body without extra instructions", () => {
    const prompt = buildLeaderPrompt({
      flowId: "flow-1",
      kind: "decision_cancelled",
      decisionUserMessage: "这条取消附言也不得写入运行时事件",
      leaderAgentSessionId: "leader-ags",
      leaderSessionId: "leader-session",
    });

    expect(parseMessageSegments(prompt, "flow-1")).toEqual([
      expect.objectContaining({
        kind: "event",
        type: "decision_cancelled",
        body: "用户取消了本次澄清卡片。请不要直接执行,用自然语言重新说明问题或给出建议。",
      }),
    ]);
    expect(prompt).not.toContain("取消附言");
  });
});

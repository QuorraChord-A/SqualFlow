/**
 * Verification for dual path: on-demand team, single vs multi expert tools, enabled flags, names.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStore } from "../src/db/store.js";
import { DEFAULT_LEADER_SYSTEM_PROMPT } from "../src/db/defaultLeaderSystemPrompt.js";
import { buildFlowWorkbench } from "../src/domain/workbench.js";
import { buildFlowSnapshot } from "../src/domain/flowSnapshot.js";
import { createStorePort } from "../src/mcp/storePort.js";
import { createLeaderMcpServer, createLeaderToolHandlers } from "../src/mcp/leaderServer.js";
import { beginWorkRun } from "./helpers/workRunTestHelpers.js";

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "squadflow-verify-roster-"));
  const store = createStore(path.join(dir, "test.db"));
  store.migrate();
  store.seedExperts();
  return {
    store,
    cleanup: () => {
      store.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("verify: on-demand team + dual expert path", () => {
  it("seeds 2–3 char person names and dual-path leader tools", () => {
    const { store, cleanup } = tempStore();
    try {
      const coder = store.getExpert("exp-coder")!;
      expect(coder.name).toBe("全栈开发专家");
      const names = JSON.parse(coder.personNameCandidates) as string[];
      expect(names).toEqual(expect.arrayContaining(["阿码", "小栈", "码仔"]));
      expect(names.every((n) => n.length >= 2 && n.length <= 3)).toBe(true);

      const leaderTools = JSON.parse(store.getExpert("exp-leader")!.mcpTools) as string[];
      expect(leaderTools).toContain("mcp__squadflow-leader__create_task");
      expect(leaderTools).toContain("mcp__squadflow-leader__dispatch_agent");
      expect(leaderTools).toContain("mcp__squadflow-leader__submit_orchestration_plan");
    } finally {
      cleanup();
    }
  });

  it("createFlow does not pre-create team; workbench empty until expert used", () => {
    const { store, cleanup } = tempStore();
    try {
      const project = store.createProject({ name: "p", localPath: "/tmp/verify-p" });
      const flow = store.createFlow({ projectId: project.id, name: "verify-flow" });
      expect(store.listFlowExperts(flow.id)).toHaveLength(0);

      const wb = buildFlowWorkbench(store, flow.id)!;
      expect(wb.team.filter((m) => !m.is_leader)).toHaveLength(0);

      const snap = buildFlowSnapshot(store, flow.id) as Record<string, unknown>;
      expect(snap.team).toEqual([]);
      const experts = snap.experts as Array<{ enabled: boolean; expert_id: string }>;
      expect(experts.some((e) => e.expert_id === "exp-coder")).toBe(true);

      store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
      const wb2 = buildFlowWorkbench(store, flow.id)!;
      const members = wb2.team.filter((m) => !m.is_leader);
      expect(members).toHaveLength(1);
      expect(members[0]!.role).toBe("全栈开发专家");
      expect(members[0]!.display_name.length).toBeGreaterThanOrEqual(2);
      expect(members[0]!.display_name).not.toBe("全栈开发专家");
    } finally {
      cleanup();
    }
  });

  it("resolveExpertRef accepts role_title without pre-creating roster", () => {
    const { store, cleanup } = tempStore();
    try {
      const project = store.createProject({ name: "p", localPath: "/tmp/r" });
      const flow = store.createFlow({ projectId: project.id, name: "f" });
      expect(store.resolveExpertRef(flow.id, "全栈开发专家")).toBe("exp-coder");
      expect(store.resolveExpertRef(flow.id, "exp-verify")).toBe("exp-verify");
      expect(store.resolveExpertRef(flow.id, "coder")).toBe("exp-coder");
      expect(store.listFlowExperts(flow.id)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("submit_orchestration_plan resolves role_title and multi-expert nodes", async () => {
    const { store, cleanup } = tempStore();
    try {
      const project = store.createProject({ name: "p", localPath: "/tmp/verify-plan" });
      const flow = store.createFlow({
        projectId: project.id,
        name: "plan-flow",
        planApproval: "off",
      });
      const turn = beginWorkRun(store, { flowId: flow.id, source: "direct_message" })!;
      const port = createStorePort(store);
      const ok = await port.submitOrchestrationPlan({
        flow_id: flow.id,
        title: "实现并验证",
        objective: "改一处并验证",
        work_kind: "bugfix",
        risk_level: "low",
        nodes: [
          {
            node_id: "impl",
            expert_id: "全栈开发专家",
            title: "实现",
            description: "修 bug",
            depends_on: [],
            acceptance_criteria: ["修好"],
            risk_tags: [],
            side_effects: [],
            resource_keys: ["file:a"],
          },
          {
            node_id: "verify",
            expert_id: "测试验证专家",
            title: "验证",
            description: "独立验证",
            depends_on: ["impl"],
            acceptance_criteria: ["通过"],
            risk_tags: [],
            side_effects: [],
            resource_keys: [],
          },
        ],
        sourceAgentSessionId: "ags-leader",
        currentTurnInput: {
          work_run_id: turn.id,
          flow_id: flow.id,
          trigger_kind: "user_message",
        },
      });
      expect(ok && !("error" in (ok as object))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("Leader MCP registers single + multi tools", async () => {
    const { store, cleanup } = tempStore();
    try {
      const handlers = createLeaderToolHandlers(createStorePort(store));
      const server = createLeaderMcpServer(handlers);
      const client = new Client({ name: "verify", version: "0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const listedTools = (await client.listTools()).tools;
        const tools = listedTools.map((t) => t.name).sort();
        expect(tools).toEqual([
          "ask_user",
          "cancel_agent",
          "cancel_work_run",
          "create_plan",
          "create_task",
          "dispatch_agent",
          "get_context",
          "get_task",
          "interrupt_work_run",
          "list_tasks",
          "resolve_plan_feedback",
          "resume_work_run",
          "save_execution_plan",
          "send_message",
          "submit_orchestration_plan",
          "update_flow_name",
          "update_task",
        ]);
        const submitDescription = listedTools.find((tool) => tool.name === "submit_orchestration_plan")?.description;
        expect(submitDescription).toContain("If approval is pending, stop and wait");
        expect(submitDescription).toContain("the Leader dispatches approved tasks by dependency");
        expect(submitDescription).not.toContain("platform handles approval and execution");
        expect(listedTools.find((tool) => tool.name === "dispatch_agent")?.description)
          .toContain("single-expert task or a materialized plan node");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      cleanup();
    }
  });

  it("Leader prompt v13.0.5 keeps autonomous triage and leader-driven dispatch", () => {
    const p = DEFAULT_LEADER_SYSTEM_PROMPT;
    expect(p).toContain("系统提示词 v13.0.5");
    expect(p).toContain("本提示词不撤销本轮已经提供给你的任何工具能力");
    expect(p).toContain("你的默认职责是编排");
    expect(p).toContain("判断重点不是固定工具次数或文件数量");
    expect(p).toContain("Research 返回后，不要只转发结果");
    expect(p).toContain("Leader 自己使用当前工具完成");
    expect(p).not.toContain("一次自查合计 ≤5 次工具调用");
    expect(p).toContain("至少两种不同 Expert 角色");
    expect(p).toContain("当前未启用");
    expect(p).toContain("create_task");
    expect(p).toContain("dispatch_agent");
    expect(p).toContain("submit_orchestration_plan");
    expect(p).toContain("enabled=true");
    expect(p).toContain("两种及以上");
    expect(p).not.toContain("Scheduler");
    // L2：派发权归 Leader，服务端不再自动推进
    expect(p).toContain("由 Leader 逐节点 `dispatch_agent`");
    expect(p).toContain("plan_approved");
    expect(p).toContain("auto_approved");
    expect(p).toContain("服务端只负责计划物化");
    expect(p).not.toContain("由系统执行");
  });
});

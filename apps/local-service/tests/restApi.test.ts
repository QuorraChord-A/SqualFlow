import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createStore } from "../src/db/store.js";
import { beginWorkRun } from "./helpers/workRunTestHelpers.js";
import { createApp } from "../src/server/app.js";
import { createClaudeTestAdapterFactory } from "./helpers/claudeTestAdapterFactory.js";

const dirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalAgentRuntimeConfigRoot = config.agentRuntimeConfigRoot;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-ts-rest-"));
  dirs.push(dir);
  return path.join(dir, "squadflow.db");
}

function tempProjectDir(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `squadflow-project-${name}-`));
  dirs.push(dir);
  return dir;
}

function tempRuntimeConfigRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-rest-runtime-config-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
    version: 1,
    roles: {
      leader: { enabled: true, configId: "default-agent-sdk", reasoningEffort: "max" },
      frontend: { enabled: true, configId: "default-agent-sdk" },
      backend: { enabled: true, configId: "default-agent-sdk" },
      research: { enabled: true, configId: "default-agent-sdk" },
      verify: { enabled: true, configId: "default-agent-sdk" },
      codereview: { enabled: true, configId: "default-agent-sdk" },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "default-agent-sdk.json"), `${JSON.stringify({
    id: "default-agent-sdk",
    fileName: "default-agent-sdk.json",
    name: "Default",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models: [
      { id: "model-1", name: "model-1" },
      { id: "model-2", name: "model-2" },
    ],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "bailian.json"), `${JSON.stringify({
    id: "bailian",
    fileName: "bailian.json",
    name: "Bailian",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "",
    models: [{ id: "qwen-a3b", name: "qwen3.6-35b-a3b" }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "codex-local.json"), `${JSON.stringify({
    id: "codex-local",
    fileName: "codex-local.json",
    name: "Codex Local",
    sdk: "codex",
    authMode: "inherited",
    baseUrl: "",
    apiKey: "",
    models: [{
      id: "gpt-55",
      name: "gpt-5.5",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "configs", "codex-api.json"), `${JSON.stringify({
    id: "codex-api",
    fileName: "codex-api.json",
    name: "Codex API",
    sdk: "codex",
    authMode: "apiKey",
    baseUrl: "https://provider.example/v1",
    apiKey: "sk-test",
    models: [{ id: "qwen-plus", name: "qwen3.7-plus" }],
  }, null, 2)}\n`);
  return root;
}

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  if (!prompt || typeof prompt !== "object" || !(Symbol.asyncIterator in prompt)) return "";
  const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const next = await iterator.next();
  await iterator.return?.();
  const message = next.value as { message?: { content?: unknown } } | undefined;
  const content = Array.isArray(message?.message?.content) ? message.message.content[0] : undefined;
  return typeof content === "object" && content !== null && "text" in content && typeof content.text === "string"
    ? content.text
    : "";
}

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  config.agentRuntimeConfigRoot = originalAgentRuntimeConfigRoot;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("REST API", () => {
  it("keeps the default project in the default_project folder", async () => {
    const originalDefaultProjectRoot = config.defaultProjectRoot;
    config.defaultProjectRoot = tempProjectDir("default-root");
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);

    try {
      const defaultProject = store.getProject("proj-default");
      const expectedPath = path.join(config.defaultProjectRoot, "default_project");
      expect(defaultProject).toEqual(expect.objectContaining({
        id: "proj-default",
        name: "默认项目",
        localPath: expectedPath,
      }));
      expect(fs.statSync(expectedPath).isDirectory()).toBe(true);
    } finally {
      config.defaultProjectRoot = originalDefaultProjectRoot;
      await app.close();
    }
  });

  it("creates new projects under the default workspace and adopts an existing folder", async () => {
    const originalDefaultProjectRoot = config.defaultProjectRoot;
    config.defaultProjectRoot = tempProjectDir("new-project-root");
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const existingProjectPath = path.join(config.defaultProjectRoot, "existing-project");
    fs.mkdirSync(existingProjectPath, { recursive: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/new",
        payload: { name: "existing-project" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(expect.objectContaining({
        name: "existing-project",
        local_path: existingProjectPath,
      }));
      expect(fs.statSync(existingProjectPath).isDirectory()).toBe(true);

      const duplicateResponse = await app.inject({
        method: "POST",
        url: "/api/projects/new",
        payload: { name: "existing-project" },
      });
      expect(duplicateResponse.statusCode).toBe(409);
    } finally {
      config.defaultProjectRoot = originalDefaultProjectRoot;
      await app.close();
    }
  });

  it("deletes a project association and its app data without deleting the project directory", async () => {
    const originalRuntimeScratchRoot = config.runtimeScratchRoot;
    config.runtimeScratchRoot = tempProjectDir("project-runtime-scratch");
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("delete-project");

    try {
      const project = store.createProject({ name: "Delete Project", localPath: projectPath });
      const flow = store.createFlow({ name: "Delete Project Flow", description: "", projectId: project.id });
      const runtimeDirs = [path.join(config.runtimeScratchRoot, flow.id)];
      for (const dir of runtimeDirs) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "marker.txt"), "runtime");
      }

      const response = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });

      expect(response.statusCode).toBe(204);
      expect(store.getProject(project.id)).toBeUndefined();
      expect(store.getFlow(flow.id)).toBeUndefined();
      expect(fs.existsSync(projectPath)).toBe(true);
      for (const dir of runtimeDirs) expect(fs.existsSync(dir)).toBe(false);
    } finally {
      config.runtimeScratchRoot = originalRuntimeScratchRoot;
      await app.close();
    }
  });

  it("removes flow runtime directories without deleting the project directory", async () => {
    const originalRuntimeScratchRoot = config.runtimeScratchRoot;
    config.runtimeScratchRoot = tempProjectDir("runtime-scratch");
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("delete-flow-project");

    try {
      const project = store.createProject({ name: "Delete Flow Project", localPath: projectPath });
      const flow = store.createFlow({ name: "Delete Flow", description: "", projectId: project.id });
      const runtimeScratchDir = path.join(config.runtimeScratchRoot, flow.id);
      for (const dir of [runtimeScratchDir]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "marker.txt"), "runtime");
      }

      const response = await app.inject({ method: "DELETE", url: `/api/flows/${flow.id}` });

      expect(response.statusCode).toBe(204);
      expect(store.getFlow(flow.id)).toBeUndefined();
      expect(fs.existsSync(runtimeScratchDir)).toBe(false);
      expect(fs.existsSync(projectPath)).toBe(true);
    } finally {
      config.runtimeScratchRoot = originalRuntimeScratchRoot;
      await app.close();
    }
  });

  it("removes runtime directories when clearing all flows", async () => {
    const originalRuntimeScratchRoot = config.runtimeScratchRoot;
    config.runtimeScratchRoot = tempProjectDir("runtime-scratch-clear");
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("clear-flow-project");

    try {
      const project = store.createProject({ name: "Clear Flow Project", localPath: projectPath });
      const flows = [
        store.createFlow({ name: "Clear Flow 1", description: "", projectId: project.id }),
        store.createFlow({ name: "Clear Flow 2", description: "", projectId: project.id }),
      ];
      const runtimeDirs = flows.map((flow) => path.join(config.runtimeScratchRoot, flow.id));
      const orphanRuntimeDirs = [path.join(config.runtimeScratchRoot, "flow-orphan")];
      for (const dir of [...runtimeDirs, ...orphanRuntimeDirs]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "marker.txt"), "runtime");
      }

      const response = await app.inject({ method: "DELETE", url: "/api/flows" });

      expect(response.statusCode).toBe(204);
      expect(store.listFlows()).toEqual([]);
      for (const dir of runtimeDirs) expect(fs.existsSync(dir)).toBe(false);
      for (const dir of orphanRuntimeDirs) expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(projectPath)).toBe(true);
    } finally {
      config.runtimeScratchRoot = originalRuntimeScratchRoot;
      await app.close();
    }
  });

  it("serves project, task flow, and agent session contracts used by the frontend", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("primary");
    const secondProjectPath = tempProjectDir("secondary");

    try {
      const projectResponse = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "Primary Project",
          local_path: projectPath,
          agent_type: "claude_code",
          description: "Fixture project",
        },
      });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json();
      expect(project).toEqual(expect.objectContaining({
        id: expect.stringMatching(/^proj-/),
        name: "Primary Project",
        local_path: projectPath,
        agent_type: "claude_code",
        description: "Fixture project",
      }));

      const defaultAgentProjectResponse = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "Default Agent Project",
          local_path: secondProjectPath,
        },
      });
      expect(defaultAgentProjectResponse.statusCode).toBe(201);
      const secondProject = defaultAgentProjectResponse.json();
      expect(secondProject).toEqual(expect.objectContaining({ agent_type: "claude_code" }));

      const projectsResponse = await app.inject({ method: "GET", url: "/api/projects" });
      expect(projectsResponse.statusCode).toBe(200);
      expect(projectsResponse.json()).toHaveLength(3);
      expect(projectsResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "proj-default", name: "默认项目", is_default: true }),
      ]));

      const flowResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "hello-flow",
          description: "写个 helloworld",
          flow_type: "full",
          project_id: project.id,
          agent_type: "claude_code",
        },
      });
      expect(flowResponse.statusCode).toBe(201);
      const flow = flowResponse.json();
      expect(flow).toEqual(expect.objectContaining({
        id: expect.stringMatching(/^flow-/),
        name: "hello-flow",
        name_generation_status: "pending",
        type: "full",
        status: "idle",
        project_id: project.id,
        agent_type: "claude_code",
        leader_session_id: null,
        is_pinned: false,
        has_pending_decision: false,
        has_unread_messages: false,
        leader_runtime_config_id: "default-agent-sdk",
        leader_runtime_model_id: "model-1",
        leader_runtime_reasoning_effort: "max",
        risk_mode: "auto_edit",
        plan_approval: "on",
      }));

      const pendingNameUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: { name: "用户尝试修改" },
      });
      expect(pendingNameUpdateResponse.statusCode).toBe(409);
      expect(pendingNameUpdateResponse.json()).toEqual({ detail: "FLOW_NAME_GENERATING" });

      const selectedRuntimeFlowResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "selected-runtime-flow",
          description: "",
          project_id: project.id,
          leader_runtime_config_id: "bailian",
          leader_runtime_model_id: "qwen-a3b",
        },
      });
      expect(selectedRuntimeFlowResponse.statusCode).toBe(201);
      expect(selectedRuntimeFlowResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_config_id: "bailian",
        leader_runtime_model_id: "qwen-a3b",
      }));

      const selectedCodexEffortFlowResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "selected-codex-effort-flow",
          description: "",
          project_id: project.id,
          leader_runtime_config_id: "codex-local",
          leader_runtime_model_id: "gpt-55",
          leader_runtime_reasoning_effort: "high",
        },
      });
      expect(selectedCodexEffortFlowResponse.statusCode).toBe(201);
      expect(selectedCodexEffortFlowResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: "high",
      }));

      const apiKeyCodexEffortResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "api-key-codex-effort-flow",
          description: "",
          project_id: project.id,
          leader_runtime_config_id: "codex-api",
          leader_runtime_model_id: "qwen-plus",
          leader_runtime_reasoning_effort: "high",
        },
      });
      expect(apiKeyCodexEffortResponse.statusCode).toBe(201);
      expect(apiKeyCodexEffortResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_reasoning_effort: "high",
      }));

      store.markFlowOutputCompleted(flow.id, "2026-06-12T01:00:00.000Z");
      const unreadFlowResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });
      expect(unreadFlowResponse.json()).toEqual(expect.objectContaining({
        has_unread_messages: true,
        context_usage: expect.objectContaining({
          leader: null,
          experts: [],
        }),
      }));

      const readResponse = await app.inject({ method: "POST", url: `/api/flows/${flow.id}/read` });
      expect(readResponse.statusCode).toBe(200);
      expect(readResponse.json()).toEqual(expect.objectContaining({ has_unread_messages: false }));

      const flowsResponse = await app.inject({ method: "GET", url: `/api/flows?project_id=${project.id}` });
      expect(flowsResponse.statusCode).toBe(200);
      expect(flowsResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: flow.id, name: "hello-flow" }),
      ]));
      for (const item of flowsResponse.json()) expect(item).not.toHaveProperty("context_usage");

      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: { project_id: secondProject.id },
      });
      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json()).toEqual(expect.objectContaining({ id: flow.id, project_id: secondProject.id }));

      const modeResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: { risk_mode: "full_access" },
      });
      expect(modeResponse.statusCode).toBe(200);
      expect(modeResponse.json()).toEqual(expect.objectContaining({ risk_mode: "full_access", plan_approval: "on" }));

      const planApprovalResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}/orchestration-settings`,
        payload: { plan_approval: "off" },
      });
      expect(planApprovalResponse.statusCode).toBe(200);
      expect(await app.inject({ method: "GET", url: `/api/flows/${flow.id}/orchestration-settings` }).then((response) => response.json()))
        .toEqual(expect.objectContaining({ plan_approval: "off" }));

      const pinResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: { is_pinned: true },
      });
      expect(pinResponse.statusCode).toBe(200);
      expect(pinResponse.json()).toEqual(expect.objectContaining({ id: flow.id, is_pinned: true }));

      const runtimeUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: {
          leader_runtime_config_id: "default-agent-sdk",
          leader_runtime_model_id: "missing-model",
        },
      });
      expect(runtimeUpdateResponse.statusCode).toBe(400);
      expect(runtimeUpdateResponse.json()).toEqual({ detail: "Leader model is not configured" });
      expect(store.getFlow(flow.id)).toEqual(expect.objectContaining({
        leaderRuntimeConfigId: "default-agent-sdk",
        leaderRuntimeModelId: "model-1",
      }));

      const workRun = beginWorkRun(store, {
        flowId: flow.id,
        inputSnapshotJson: "{}",
        createdBy: "user",
      })!;
      store.createDecisionCard({
        flowId: flow.id,
        workRunId: workRun.id,
        cardId: "dc-pending",
        sessionId: "session-pending",
        cardType: "generic",
        questions: [],
      });
      const pendingFlowResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });
      expect(pendingFlowResponse.json()).toEqual(expect.objectContaining({ has_pending_decision: true }));

      const agentSessionsResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/agent-sessions` });
      expect(agentSessionsResponse.statusCode).toBe(200);
      expect(agentSessionsResponse.json()).toEqual([]);

      const removedRouteResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/executions` });
      expect(removedRouteResponse.statusCode).toBe(404);

      const leader = store.createAgentSession({
        flowId: flow.id,
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId: "leader-session",
        displayName: "Leader",
        status: "streaming",
      });
      store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });
      store.upsertAgentContextUsageSnapshot({
        flowId: flow.id,
        agentSessionId: leader.id,
        sdkSessionId: "leader-session",
        role: "leader",
        expertId: "exp-leader",
        flowExpertId: null,
        totalTokens: 10_100,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 5.05,
        model: "claude-sonnet",
        categories: [{ name: "Messages", tokens: 10_100, color: "#22c55e", isDeferred: false }],
        observedAt: "2026-06-28T10:00:00.000Z",
      });
      const usageFlowResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });
      expect(usageFlowResponse.json().context_usage).toEqual({
        leader: expect.objectContaining({
          agent_session_id: leader.id,
          sdk_session_id: "leader-session",
          role: "leader",
          expert_id: "exp-leader",
          display_name: "Leader",
          total_tokens: 10_100,
          max_tokens: 200_000,
          percentage: 5.05,
        }),
        experts: [],
      });
      const task = store.createTask({
        flowId: flow.id,
        workRunId: workRun.id,
        title: "Build hello",
        description: "Create hello",
        expertId: "exp-coder",
        dependsOnTaskIds: [],
      })!;
      const expertSession = store.createAgentSession({
        flowId: flow.id,
        workRunId: workRun.id,
        taskId: task.id,
        expertId: "exp-coder",
        displayName: "Coder",
        status: "idle",
      });
      store.assignTaskAgentSession(task.id, expertSession.id);
      const changedFiles = store.createArtifact({
        flowId: flow.id,
        workRunId: workRun.id,
        taskId: task.id,
        type: "changed_files",
        title: "Changed files",
        content: JSON.stringify([{ path: "app/page.tsx", status: "modified" }]),
      });
      const spec = store.createSpecRevision({
        flowId: flow.id,
        name: "Hello World",
        overview: "Create a Hello World page.",
        content: "# Hello World",
        sourceAgentSessionId: leader.id,
      })!;
      const reportArtifact = store.createArtifact({
        flowId: flow.id,
        workRunId: workRun.id,
        taskId: task.id,
        type: "verify_report",
        title: "Verify report",
        content: "All checks passed.",
      });
      const planArtifact = store.createArtifact({
        flowId: flow.id,
        workRunId: workRun.id,
        taskId: null,
        type: "execution_plan",
        title: "Execution plan",
        content: "# Execution plan",
      });

      const workbenchResponse = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/workbench`,
      });
      expect(workbenchResponse.statusCode).toBe(200);
      const workbench = workbenchResponse.json();
      expect(workbench.team).toEqual([
        expect.objectContaining({
          display_name: "Leader",
          role: "Leader",
          status: "running",
          agent_session_id: null,
          is_leader: true,
        }),
        expect.objectContaining({
          // Person name on top; fixed Chinese role title below.
          display_name: expect.stringMatching(/^.{2,3}$/),
          role: "全栈开发专家",
          status: "idle",
          flow_expert_id: expect.any(String),
          expert_id: "exp-coder",
          agent_session_id: null,
          is_leader: false,
        }),
      ]);
      expect(workbench.team[1]?.display_name).not.toBe("Coder");
      expect(workbench.team[1]?.display_name).not.toBe("全栈开发专家");
      expect(workbench.artifacts.specs).toEqual([
        expect.objectContaining({
          id: spec.id,
          spec_revision_id: spec.id,
          title: spec.fileName,
          file_name: spec.fileName,
          overview: spec.overview,
          content: spec.content,
          status: spec.status,
          created_at: spec.createdAt,
        }),
      ]);
      expect(workbench.artifacts.files).toEqual([{
        path: "app/page.tsx",
        status: "modified",
        source_artifact_id: changedFiles.id,
      }]);
      expect(workbench.artifacts.reports).toEqual([
        expect.objectContaining({
          id: reportArtifact.id,
          type: reportArtifact.type,
          title: reportArtifact.title,
          content: reportArtifact.content,
          created_at: reportArtifact.createdAt,
        }),
        expect.objectContaining({
          id: planArtifact.id,
          type: planArtifact.type,
          title: planArtifact.title,
          content: planArtifact.content,
          created_at: planArtifact.createdAt,
        }),
      ]);
      expect(workbench.tasks).toEqual([
        expect.objectContaining({
          id: task.id,
          subject: "Build hello",
          status: "pending",
          owner_name: workbench.team[1]?.display_name,
          owner_role: "全栈开发专家",
          owner_expert_id: "exp-coder",
          active_form: "",
          blocked_by: [],
        }),
      ]);
      expect(workbench.files).toEqual({
        root_path: secondProjectPath,
        tree_available: true,
      });

      const detail = pendingFlowResponse.json();
      expect(detail).not.toHaveProperty("runs");
      expect(detail).not.toHaveProperty("phases");
      expect(detail).not.toHaveProperty("current_stage");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("keeps unavailable model metadata explicit and rejects invalid custom Codex context", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);

    try {
      const snapshotResponse = await app.inject({ method: "GET", url: "/api/agent-runtime-config" });
      expect(snapshotResponse.statusCode).toBe(200);
      const configs = snapshotResponse.json().configs as Array<{
        id: string;
        filePath: string;
        models: Array<{
          contextWindowK: number | null;
          metadataStatus: { contextWindow: string };
        }>;
      }>;
      expect(configs.find((item) => item.id === "default-agent-sdk")?.models[0]).toEqual(expect.objectContaining({
        contextWindowK: 1_000,
        metadataStatus: { contextWindow: "available" },
      }));
      expect(configs.find((item) => item.id === "default-agent-sdk")?.filePath).toBe(
        path.join(config.agentRuntimeConfigRoot, "configs", "default-agent-sdk.json"),
      );
      expect(configs.find((item) => item.id === "codex-api")?.models[0]?.contextWindowK).toBe(256);
      expect(configs.find((item) => item.id === "codex-local")?.models[0]).toEqual(expect.objectContaining({
        contextWindowK: 256,
        metadataStatus: { contextWindow: "available" },
      }));

      const invalidResponse = await app.inject({
        method: "POST",
        url: "/api/agent-runtime-config/configs",
        payload: {
          name: "InvalidCodexContext",
          sdk: "codex",
          authMode: "apiKey",
          models: [{ id: "mimo", name: "mimo-v2.5", contextWindowK: 127 }],
        },
      });
      expect(invalidResponse.statusCode).toBe(400);
      expect(invalidResponse.json().detail).toContain("大于等于 128K 的数字");

      const claudeLocalAuthResponse = await app.inject({
        method: "POST",
        url: "/api/agent-runtime-config/configs",
        payload: {
          name: "ClaudeLocalAuth",
          sdk: "claudecode",
          authMode: "inherited",
          models: [{ id: "claude", name: "claude-test", contextWindowK: 200 }],
        },
      });
      expect(claudeLocalAuthResponse.statusCode).toBe(400);
      expect(claudeLocalAuthResponse.json().detail).toContain("Claude Code 仅支持 API Key");
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("locks the Leader SDK while allowing same-SDK provider and model changes", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("leader-runtime-selection");

    try {
      const project = store.createProject({ name: "Leader Runtime Selection", localPath: projectPath });
      const flowResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "Claude Flow",
          description: "",
          project_id: project.id,
          leader_runtime_config_id: "default-agent-sdk",
          leader_runtime_model_id: "model-1",
        },
      });
      expect(flowResponse.statusCode).toBe(201);
      const flow = store.getFlow(flowResponse.json().id)!;

      const initialSdkUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: {
          leader_runtime_config_id: "codex-local",
          leader_runtime_model_id: "gpt-55",
        },
      });
      expect(initialSdkUpdateResponse.statusCode).toBe(409);

      store.createAgentSession({
        flowId: flow.id,
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId: "leader-sdk-session",
        displayName: "Leader",
      });

      const providerUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: {
          leader_runtime_config_id: "bailian",
          leader_runtime_model_id: "qwen-a3b",
        },
      });
      expect(providerUpdateResponse.statusCode).toBe(200);
      expect(providerUpdateResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_sdk: "claudecode",
        leader_runtime_config_id: "bailian",
        leader_runtime_model_id: "qwen-a3b",
      }));

      const modelUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: {
          leader_runtime_config_id: "default-agent-sdk",
          leader_runtime_model_id: "model-2",
        },
      });
      expect(modelUpdateResponse.statusCode).toBe(200);
      expect(modelUpdateResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_sdk: "claudecode",
        leader_runtime_config_id: "default-agent-sdk",
        leader_runtime_model_id: "model-2",
      }));

      const sdkUpdateResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flow.id}`,
        payload: {
          leader_runtime_config_id: "codex-local",
          leader_runtime_model_id: "gpt-55",
        },
      });
      expect(sdkUpdateResponse.statusCode).toBe(409);
      expect(store.getFlow(flow.id)).toEqual(expect.objectContaining({
        leaderRuntimeSdk: "claudecode",
        leaderRuntimeConfigId: "default-agent-sdk",
        leaderRuntimeModelId: "model-2",
      }));
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("keeps Codex official and custom runtime profiles separated inside one Flow", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const projectPath = tempProjectDir("codex-runtime-profile");

    try {
      const project = store.createProject({ name: "Codex Runtime Profile", localPath: projectPath });
      const flowResponse = await app.inject({
        method: "POST",
        url: "/api/flows",
        payload: {
          name: "Codex Flow",
          description: "",
          project_id: project.id,
          leader_runtime_config_id: "codex-local",
          leader_runtime_model_id: "gpt-55",
        },
      });
      const flowId = flowResponse.json().id;

      const effortResponse = await app.inject({
        method: "PUT",
        url: `/api/flows/${flowId}`,
        payload: { leader_runtime_reasoning_effort: "high" },
      });
      expect(effortResponse.statusCode).toBe(200);
      expect(effortResponse.json()).toEqual(expect.objectContaining({
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: "high",
      }));

      const response = await app.inject({
        method: "PUT",
        url: `/api/flows/${flowId}`,
        payload: {
          leader_runtime_config_id: "codex-api",
          leader_runtime_model_id: "qwen-plus",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        detail: "Codex official and custom providers cannot share one runtime session",
      });
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("compacts an idle Leader session through the flow context endpoint", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    let compactPrompt: unknown = null;
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: (input) => {
        compactPrompt = input.prompt;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", session_id: "leader-sdk-session", is_error: false };
          },
          close() {},
          async getContextUsage() {
            return {
              totalTokens: 2_400,
              maxTokens: 200_000,
              rawMaxTokens: 200_000,
              percentage: 1.2,
              model: "claude-sonnet",
              categories: [],
              gridRows: [],
              memoryFiles: [],
              mcpTools: [],
            };
          },
        };
      } }),
    } as any);

    try {
      const project = store.createProject({ name: "Compact Project", localPath: tempProjectDir("compact") });
      const flow = store.createFlow({
        name: "Compact Flow",
        description: "",
        projectId: project.id,
        leaderRuntimeConfigId: "default-agent-sdk",
        leaderRuntimeModelId: "model-1",
      });
      const leader = store.createAgentSession({
        flowId: flow.id,
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId: "leader-sdk-session",
        displayName: "Leader",
        status: "completed",
      });
      store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });

      const response = await app.inject({ method: "POST", url: `/api/flows/${flow.id}/context/compact` });

      expect(response.statusCode).toBe(200);
      expect(await promptText(compactPrompt)).toBe("/compact");
      expect(response.json().context_usage.leader).toEqual(expect.objectContaining({
        agent_session_id: leader.id,
        sdk_session_id: "leader-sdk-session",
        total_tokens: 2_400,
        max_tokens: 200_000,
        percentage: 1.2,
        compacted: true,
      }));

      const flowResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });
      expect(flowResponse.statusCode).toBe(200);
      expect(flowResponse.json()).toEqual(expect.objectContaining({
        has_unread_messages: true,
        last_output_completed_at: expect.any(String),
      }));
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("exposes in-memory Leader context compaction state while compact is running", async () => {
    config.agentRuntimeConfigRoot = tempRuntimeConfigRoot();
    const store = createStore(tempDb());
    let releaseCompact!: () => void;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let compactStarted = false;
    const app = createApp({
      logger: false,
      store,
      runtimeAdapterFactory: createClaudeTestAdapterFactory({ leaderQuery: () => ({
        async *[Symbol.asyncIterator]() {
          compactStarted = true;
          await compactGate;
          yield { type: "result", subtype: "success", session_id: "leader-sdk-session", is_error: false };
        },
        close() {},
        async getContextUsage() {
          return {
            totalTokens: 2_400,
            maxTokens: 200_000,
            rawMaxTokens: 200_000,
            percentage: 1.2,
            model: "claude-sonnet",
            categories: [],
            gridRows: [],
            memoryFiles: [],
            mcpTools: [],
          };
        },
      }) }),
    } as any);

    try {
      const project = store.createProject({ name: "Compact Running Project", localPath: tempProjectDir("compact-running") });
      const flow = store.createFlow({
        name: "Compact Running Flow",
        description: "",
        projectId: project.id,
        leaderRuntimeConfigId: "default-agent-sdk",
        leaderRuntimeModelId: "model-1",
      });
      const leader = store.createAgentSession({
        flowId: flow.id,
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId: "leader-sdk-session",
        displayName: "Leader",
        status: "completed",
      });
      store.updateFlow(flow.id, { leaderSessionId: leader.sessionId });

      const compactResponsePromise = app.inject({ method: "POST", url: `/api/flows/${flow.id}/context/compact` });
      for (let index = 0; index < 20 && !compactStarted; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const runningResponse = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });
      expect(runningResponse.statusCode).toBe(200);
      expect(runningResponse.json().context_compactions).toEqual([
        expect.objectContaining({
          flow_id: flow.id,
          agent_session_id: leader.id,
          role: "leader",
          expert_id: "exp-leader",
          status: "running",
        }),
      ]);

      releaseCompact();
      const compactResponse = await compactResponsePromise;
      expect(compactResponse.statusCode).toBe(200);
      expect(compactResponse.json().context_compactions).toEqual([
        expect.objectContaining({
          flow_id: flow.id,
          agent_session_id: leader.id,
          role: "leader",
          expert_id: "exp-leader",
          status: "completed",
        }),
      ]);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("recovers completed context compaction state from the raw Claude transcript", async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-claude-transcript-"));
    dirs.push(claudeRoot);
    process.env.CLAUDE_CONFIG_DIR = claudeRoot;
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const transcriptDir = path.join(claudeRoot, "projects", "-tmp-project");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-06-28T12:00:00.000Z",
        compactMetadata: { preTokens: 120_000, postTokens: 2_400 },
      }),
    ].join("\n"));

    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);

    try {
      const project = store.createProject({ name: "Recovered Compact Project", localPath: tempProjectDir("compact-recovered") });
      const flow = store.createFlow({ name: "Recovered Compact Flow", description: "", projectId: project.id });
      const leader = store.createAgentSession({
        flowId: flow.id,
        workRunId: null,
        taskId: null,
        expertId: "exp-leader",
        sessionId,
        displayName: "Leader",
        status: "completed",
      });
      store.updateFlow(flow.id, { leaderSessionId: sessionId });

      const response = await app.inject({ method: "GET", url: `/api/flows/${flow.id}` });

      expect(response.statusCode).toBe(200);
      expect(response.json().context_compactions).toEqual([
        expect.objectContaining({
          flow_id: flow.id,
          agent_session_id: leader.id,
          sdk_session_id: sessionId,
          role: "leader",
          expert_id: "exp-leader",
          status: "completed",
          started_at: "2026-06-28T12:00:00.000Z",
          updated_at: "2026-06-28T12:00:00.000Z",
        }),
      ]);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("lists workspace files lazily with directories first and excludes generated directories", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-files-"));
    dirs.push(root);

    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.mkdirSync(path.join(root, ".playwright-cli"));
      fs.writeFileSync(path.join(root, ".DS_Store"), "metadata");
      fs.writeFileSync(path.join(root, "README.md"), "# Readme");
      fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};");
      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Files",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-files",
        workspaceId: "ws-default",
        name: "Files",
        description: "",
        projectId: project.id,
      });

      const rootResponse = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/files`,
      });
      expect(rootResponse.statusCode).toBe(200);
      expect(rootResponse.json()).toEqual({
        path: "",
        entries: [
          expect.objectContaining({ name: "src", path: "src", type: "directory", has_children: true }),
          expect.objectContaining({ name: "README.md", path: "README.md", type: "file", has_children: false }),
        ],
        truncated: false,
      });

      const nestedResponse = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/files?path=src`,
      });
      expect(nestedResponse.statusCode).toBe(200);
      expect(nestedResponse.json()).toEqual({
        path: "src",
        entries: [
          expect.objectContaining({ name: "index.ts", path: "src/index.ts", type: "file" }),
        ],
        truncated: false,
      });
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects workspace tree path traversal", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-files-"));
    dirs.push(root);

    try {
      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Files traversal",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-files-traversal",
        workspaceId: "ws-default",
        name: "Files traversal",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/files?path=../`,
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("deletes a file or directory inside the Flow workspace", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-delete-"));
    dirs.push(root);

    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};");
      const project = store.createProject({ workspaceId: "ws-default", name: "Delete", localPath: root, description: "" });
      const flow = store.createFlow({ id: "flow-delete", workspaceId: "ws-default", name: "Delete", description: "", projectId: project.id });

      const response = await app.inject({ method: "DELETE", url: `/api/flows/${flow.id}/files?path=src` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deleted: "src" });
      expect(fs.existsSync(path.join(root, "src"))).toBe(false);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("previews a UTF-8 file inside the Flow workspace", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    dirs.push(root);

    try {
      fs.writeFileSync(path.join(root, "hello.txt"), "hello");
      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview",
        workspaceId: "ws-default",
        name: "Preview",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=hello.txt`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ path: "hello.txt", content: "hello" });
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects file preview path traversal", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    dirs.push(root);

    try {
      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview traversal",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview-traversal",
        workspaceId: "ws-default",
        name: "Preview traversal",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=../secret.txt`,
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects absolute path for file preview", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    dirs.push(root);

    try {
      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview absolute",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview-absolute",
        workspaceId: "ws-default",
        name: "Preview absolute",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=${encodeURIComponent("/etc/passwd")}`,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects symlink escape for file preview", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-outside-"));
    dirs.push(root, outside);

    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview symlink",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview-symlink",
        workspaceId: "ws-default",
        name: "Preview symlink",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=link.txt`,
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects NUL byte files for preview", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    dirs.push(root);

    try {
      fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));

      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview binary",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview-binary",
        workspaceId: "ws-default",
        name: "Preview binary",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=binary.bin`,
      });
      expect(response.statusCode).toBe(415);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("returns one Flow Expert DTO for multiple runtime sessions", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    try {
      const flow = store.createFlow({ id: "flow-rest-flow-expert", workspaceId: "ws-default", projectId: null, name: "Flow Expert REST", description: "" });
      const workRun = beginWorkRun(store, { flowId: flow.id, source: "direct_message" })!;
      const expert = store.getOrCreateFlowExpert({ flowId: flow.id, expertId: "exp-coder" });
      const task = store.createTask({ flowId: flow.id, workRunId: workRun.id, title: "实现页面", description: "", expertId: "exp-coder", activeForm: "", dependsOnTaskIds: [] })!;
      const first = store.createAgentSession({ flowId: flow.id, workRunId: workRun.id, taskId: task.id, expertId: "exp-coder", flowExpertId: expert.id, displayName: "Frontend 2482", sessionId: "sdk-frontend", status: "completed" });
      const second = store.createAgentSession({ flowId: flow.id, workRunId: workRun.id, taskId: task.id, expertId: "exp-coder", flowExpertId: expert.id, displayName: "Frontend 5924", sessionId: "sdk-frontend", status: "completed" });
      store.assignTaskFlowExpert(task.id, expert.id, second.id);
      store.updateFlowExpertSession(expert.id, "sdk-frontend");

      const response = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/flow-experts` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([expect.objectContaining({
        id: expert.id,
        flow_expert_id: expert.id,
        expert_id: "exp-coder",
        display_name: expert.displayName,
        agent_session_id: second.id,
        session_id: "sdk-frontend",
        current_task_title: "实现页面",
      })]);
      expect(expert.displayName).not.toBe("Coder");
      expect(response.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });

  it("rejects files larger than 1 MiB for preview", async () => {
    const store = createStore(tempDb());
    const app = createApp({ logger: false, store } as any);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-preview-"));
    dirs.push(root);

    try {
      fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(1024 * 1024 + 1));

      const project = store.createProject({
        workspaceId: "ws-default",
        name: "Preview huge",
        localPath: root,
        description: "",
      });
      const flow = store.createFlow({
        id: "flow-preview-huge",
        workspaceId: "ws-default",
        name: "Preview huge",
        description: "",
        projectId: project.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/flows/${flow.id}/file-preview?path=huge.txt`,
      });
      expect(response.statusCode).toBe(413);
    } finally {
      await app.close();
      store.sqlite.close();
    }
  });
});

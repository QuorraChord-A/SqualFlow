import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalConfigRoot = process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT;

async function loadRuntimeConfigModule(setup?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-config-"));
  tempDirs.push(root);
  setup?.(root);
  process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT = root;
  vi.resetModules();
  return import("../src/config/agentRuntimeConfig.js");
}

afterEach(() => {
  if (originalConfigRoot === undefined) {
    delete process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT;
  } else {
    process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT = originalConfigRoot;
  }
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent runtime config storage", () => {
  it("starts with stable runtime roles and no provider configuration", async () => {
    const { readAgentRuntimeConfigSnapshot } = await loadRuntimeConfigModule();

    const snapshot = await readAgentRuntimeConfigSnapshot();

    expect(snapshot.roles.map((role) => role.role)).toEqual([
      "leader",
      "coder",
      "research",
      "verify",
      "codereview",
    ]);
    expect(snapshot.configs).toEqual([]);
    expect(snapshot.roles.every((role) => role.configId === "" && role.modelId === "")).toBe(true);
    expect(snapshot.roles.find((role) => role.role === "leader")?.enabled).toBe(true);
    expect(snapshot.roles.filter((role) => role.role !== "leader").every((role) => !role.enabled)).toBe(true);
  });

  it("allows an unbound Expert role to be disabled without a provider", async () => {
    const { readAgentRuntimeConfigSnapshot, updateRoleRuntimeBinding } = await loadRuntimeConfigModule();

    await expect(updateRoleRuntimeBinding("coder", {
      enabled: false,
      configId: "",
      modelId: "",
      reasoningEffort: "high",
    })).resolves.toMatchObject({ role: "coder", enabled: false, configId: "", modelId: "" });

    expect((await readAgentRuntimeConfigSnapshot()).roles.find((role) => role.role === "coder"))
      .toMatchObject({ enabled: false, configId: "", modelId: "" });
  });

  it("removes the exact legacy seeded provider without deleting user-created configs", async () => {
    const { readAgentRuntimeConfigSnapshot } = await loadRuntimeConfigModule((root) => {
      fs.mkdirSync(path.join(root, "configs"), { recursive: true });
      fs.writeFileSync(path.join(root, "index.json"), `${JSON.stringify({
        version: 1,
        roles: {
          leader: { enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
          coder: { enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
          research: { enabled: false, configId: "", modelId: "" },
          verify: { enabled: true, configId: "", modelId: "" },
          codereview: { enabled: true, configId: "", modelId: "" },
        },
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(root, "configs", "default-agent-sdk.json"), `${JSON.stringify({
        id: "default-agent-sdk",
        fileName: "default-agent-sdk.json",
        name: "项目claudecode配置",
        sdk: "claudecode",
        authMode: "apiKey",
        baseUrl: "",
        apiKey: "",
        models: [
          { id: "mimo-v25", name: "mimo-v2.5", contextWindowK: 200 },
          { id: "opus", name: "opus", contextWindowK: 200 },
        ],
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(root, "configs", "user-config.json"), `${JSON.stringify({
        id: "user-config",
        fileName: "user-config.json",
        name: "我的配置",
        sdk: "codex",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "gpt-5", name: "gpt-5" }],
      }, null, 2)}\n`);
    });

    const snapshot = await readAgentRuntimeConfigSnapshot();

    expect(snapshot.configs.map((config) => config.id)).toEqual(["user-config"]);
    expect(snapshot.roles.find((role) => role.role === "leader")).toMatchObject({
      configId: "user-config",
      modelId: "gpt-5",
    });
  });

  it("uses a UUID config id and filename for newly created runtime configs", async () => {
    const { createRuntimeConfig } = await loadRuntimeConfigModule();

    const config = await createRuntimeConfig({
      name: "未命名配置1",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });

    expect(config.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(config.fileName).toBe(`${config.id}.json`);
    expect(config.name).toBe("未命名配置1");
    expect(config.models[0].contextWindowK).toBe(1_000);
  });

  it("lists providers by creation time ascending even when their filenames sort differently", async () => {
    const { createRuntimeConfig, readAgentRuntimeConfigSnapshot } = await loadRuntimeConfigModule();
    const first = await createRuntimeConfig({
      name: "最早添加",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "first", name: "first", contextWindowK: 256 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createRuntimeConfig({
      name: "稍后添加",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "second", name: "second", contextWindowK: 256 }],
    });

    const snapshot = await readAgentRuntimeConfigSnapshot();

    expect(snapshot.configs.map((config) => config.id)).toEqual([first.id, second.id]);
  });

  it("allows only API key authentication for Claude Code", async () => {
    const { createRuntimeConfig } = await loadRuntimeConfigModule();

    await expect(createRuntimeConfig({
      name: "ClaudeLocal",
      sdk: "claudecode",
      authMode: "inherited",
      models: [{ id: "opus", name: "opus", contextWindowK: 200 }],
    })).rejects.toThrow("Claude Code 仅支持 API Key");
  });

  it("reads legacy Claude local-auth configs as API-key configs", async () => {
    const { readRuntimeConfig } = await loadRuntimeConfigModule((root) => {
      fs.mkdirSync(path.join(root, "configs"), { recursive: true });
      fs.writeFileSync(path.join(root, "configs", "legacy-claude.json"), `${JSON.stringify({
        id: "legacy-claude",
        fileName: "legacy-claude.json",
        name: "LegacyClaude",
        sdk: "claudecode",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "opus", name: "opus" }],
      }, null, 2)}\n`);
    });

    await expect(readRuntimeConfig("legacy-claude")).resolves.toEqual(expect.objectContaining({
      sdk: "claudecode",
      authMode: "apiKey",
    }));
  });

  it("normalizes Claude Code context metadata to the supported runtime sizes", async () => {
    const { createRuntimeConfig } = await loadRuntimeConfigModule();

    const extended = await createRuntimeConfig({
      name: "Claude1M",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "opus", name: "opus[1m]" }],
    });
    expect(extended.models).toEqual([{ id: "opus", name: "opus", contextWindowK: 1_000 }]);

    const providerSized = await createRuntimeConfig({
      name: "Claude200K",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "opus", name: "opus", contextWindowK: 200 }],
    });
    expect(providerSized.models[0]).toEqual({ id: "opus", name: "opus", contextWindowK: 200 });

    await expect(createRuntimeConfig({
      name: "ClaudeInvalid",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "opus", name: "opus", contextWindowK: 0 }],
    })).rejects.toThrow("只能是 200K 或 1000K");
  });

  it("defaults Codex context for both official and custom configs", async () => {
    const { createRuntimeConfig } = await loadRuntimeConfigModule();

    const custom = await createRuntimeConfig({
      name: "CodexCustom",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "mimo", name: "mimo-v2.5" }],
    });
    expect(custom.models[0].contextWindowK).toBe(256);

    const official = await createRuntimeConfig({
      name: "CodexOfficial",
      sdk: "codex",
      authMode: "inherited",
      models: [{ id: "gpt-56", name: "gpt-5.6-terra", contextWindowK: 128 }],
    });
    expect(official.models[0]).toEqual({ id: "gpt-56", name: "gpt-5.6-terra", contextWindowK: 128 });

    await expect(createRuntimeConfig({
      name: "CodexTooSmall",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "mimo", name: "mimo-v2.5", contextWindowK: 127 }],
    })).rejects.toThrow("大于等于 128K 的数字");
    const exactTokenWindow = await createRuntimeConfig({
      name: "Codex131072",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "mimo", name: "mimo-v2.5", contextWindowK: 131.072 }],
    });
    expect(exactTokenWindow.models[0]?.contextWindowK).toBe(131.072);
  });

  it("resolves flow leader runtime selection by config and model ids", async () => {
    const {
      createRuntimeConfig,
      readFlowLeaderRuntimeConfig,
      updateRuntimeConfig,
    } = await loadRuntimeConfigModule();

    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });

    await expect(readFlowLeaderRuntimeConfig({
      configId: config.id,
      modelId: "missing-model",
    })).resolves.toBeNull();
    await expect(readFlowLeaderRuntimeConfig({
      configId: "missing-config",
      modelId: "model-1",
    })).resolves.toBeNull();

    await updateRuntimeConfig(config.id, {
      ...config,
      models: [{ id: "model-1", name: "renamed-model" }],
    });

    await expect(readFlowLeaderRuntimeConfig({
      configId: config.id,
      modelId: "model-1",
    })).resolves.toEqual(expect.objectContaining({
      configId: config.id,
      modelId: "model-1",
      config: expect.objectContaining({
        models: [expect.objectContaining({ id: "model-1", name: "renamed-model" })],
      }),
    }));
  });

  it("rejects invalid or duplicate config names", async () => {
    const { createRuntimeConfig, updateRuntimeConfig } = await loadRuntimeConfigModule();
    const first = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });
    const second = await createRuntimeConfig({
      name: "配置B",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-2", name: "opus" }],
    });

    await expect(createRuntimeConfig({
      name: "配置 A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-3", name: "haiku" }],
    })).rejects.toThrow("配置名称不能包含空格");
    await expect(updateRuntimeConfig(second.id, { ...second, name: first.name })).rejects.toThrow("配置名称不能重复");
  });

  it("rejects unknown runtime sdk values instead of falling back to Claude", async () => {
    const { createRuntimeConfig } = await loadRuntimeConfigModule();

    await expect(createRuntimeConfig({
      name: "配置A",
      sdk: "unknown-sdk" as "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    })).rejects.toThrow("Unsupported runtime sdk");
  });

  it("uses the first created provider and usable model for unbound roles", async () => {
    const { createRuntimeConfig, readAgentRuntimeConfigSnapshot } = await loadRuntimeConfigModule();
    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });

    const snapshot = await readAgentRuntimeConfigSnapshot();
    for (const binding of snapshot.roles) {
      expect(binding.configId).toBe(config.id);
      expect(binding.modelId).toBe("model-1");
      expect(binding.reasoningEffort).toBe("high");
    }
  });

  it("uses the selected SDK default effort for legacy unbound roles", async () => {
    const { createRuntimeConfig, readAgentRuntimeConfigSnapshot } = await loadRuntimeConfigModule();
    await createRuntimeConfig({
      name: "Codex配置",
      sdk: "codex",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "gpt-5.6" }],
    });

    const snapshot = await readAgentRuntimeConfigSnapshot();
    expect(snapshot.roles.every((binding) => binding.reasoningEffort === "medium")).toBe(true);
  });

  it("persists role binding modelId and rejects unknown models", async () => {
    const {
      createRuntimeConfig,
      readAgentRuntimeConfigSnapshot,
      updateRoleRuntimeBinding,
    } = await loadRuntimeConfigModule();

    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [
        { id: "model-1", name: "mimo-v2.5" },
        { id: "model-2", name: "opus" },
      ],
    });

    await expect(updateRoleRuntimeBinding("coder", {
      configId: config.id,
      modelId: "missing-model",
    })).rejects.toThrow("model_id must reference an existing model");

    const binding = await updateRoleRuntimeBinding("coder", {
      configId: config.id,
      modelId: "model-2",
    });
    expect(binding).toMatchObject({ role: "coder", configId: config.id, modelId: "model-2" });

    const snapshot = await readAgentRuntimeConfigSnapshot();
    expect(snapshot.roles.find((item) => item.role === "coder")).toMatchObject({
      configId: config.id,
      modelId: "model-2",
    });
  });

  it("falls back to the first usable model when switching config without modelId", async () => {
    const { createRuntimeConfig, updateRoleRuntimeBinding } = await loadRuntimeConfigModule();

    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "codex",
      authMode: "apiKey",
      models: [
        { id: "blank", name: " " },
        { id: "glm-47", name: "glm-4.7" },
      ],
    });

    const binding = await updateRoleRuntimeBinding("coder", { configId: config.id });
    expect(binding).toMatchObject({ configId: config.id, modelId: "glm-47" });
  });

  it("persists role effort and validates it against the selected SDK", async () => {
    const { createRuntimeConfig, readAgentRuntimeConfigSnapshot, updateRoleRuntimeBinding } = await loadRuntimeConfigModule();
    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });

    await expect(updateRoleRuntimeBinding("coder", {
      configId: config.id,
      reasoningEffort: "ultra",
    })).rejects.toThrow("reasoning_effort must be supported");

    const binding = await updateRoleRuntimeBinding("coder", {
      configId: config.id,
      reasoningEffort: "max",
    });
    expect(binding).toMatchObject({ reasoningEffort: "max" });
    expect((await readAgentRuntimeConfigSnapshot()).roles.find((role) => role.role === "coder"))
      .toMatchObject({ reasoningEffort: "max" });
  });

  it("rebinds roles to the fallback config and model when their config is deleted", async () => {
    const {
      createRuntimeConfig,
      deleteRuntimeConfig,
      updateRoleRuntimeBinding,
    } = await loadRuntimeConfigModule();

    const fallback = await createRuntimeConfig({
      name: "配置B",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-2", name: "opus" }],
    });
    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });
    await updateRoleRuntimeBinding("verify", { configId: config.id, modelId: "model-1" });

    const snapshot = await deleteRuntimeConfig(config.id);
    const verifyBinding = snapshot?.roles.find((item) => item.role === "verify");
    const fallbackConfig = snapshot?.configs.find((item) => item.id === verifyBinding?.configId);
    expect(verifyBinding?.configId).not.toBe(config.id);
    expect(verifyBinding?.configId).toBe(fallback.id);
    expect(verifyBinding?.modelId).toBe(fallbackConfig?.models.find((model) => model.name.trim())?.id ?? "");
  });

  it("rejects changing the sdk of an existing runtime config", async () => {
    const { createRuntimeConfig, updateRuntimeConfig } = await loadRuntimeConfigModule();

    const config = await createRuntimeConfig({
      name: "配置A",
      sdk: "claudecode",
      authMode: "apiKey",
      models: [{ id: "model-1", name: "mimo-v2.5" }],
    });

    await expect(updateRuntimeConfig(config.id, { ...config, sdk: "codex" }))
      .rejects.toThrow("Agent 类型创建后不可更改");

    const unchanged = await updateRuntimeConfig(config.id, { ...config, name: "配置A2" });
    expect(unchanged).toMatchObject({ name: "配置A2", sdk: "claudecode" });
  });
});

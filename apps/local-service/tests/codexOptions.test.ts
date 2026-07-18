import { afterEach, describe, expect, it } from "vitest";
import { buildCodexExpertOptions, buildCodexLeaderOptions } from "../src/runtime/adapters/codexOptions.js";
import { BROWSER_MCP_TOOL_PREFIX } from "../src/mcp/browserServer.js";
import type { BuildExpertRuntimeOptionsInput } from "../src/runtime/adapters/runtimeAdapter.js";

const originalExternalCodexCommand = process.env.SQUADFLOW_EXTERNAL_CODEX_COMMAND;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCodexRuntimeMode = process.env.SQUADFLOW_CODEX_RUNTIME_MODE;
const originalTransportDebug = process.env.SQUADFLOW_CODEX_TRANSPORT_DEBUG;
const originalRustLog = process.env.RUST_LOG;

afterEach(() => {
  if (originalExternalCodexCommand === undefined) {
    delete process.env.SQUADFLOW_EXTERNAL_CODEX_COMMAND;
  } else {
    process.env.SQUADFLOW_EXTERNAL_CODEX_COMMAND = originalExternalCodexCommand;
  }
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  if (originalCodexRuntimeMode === undefined) {
    delete process.env.SQUADFLOW_CODEX_RUNTIME_MODE;
  } else {
    process.env.SQUADFLOW_CODEX_RUNTIME_MODE = originalCodexRuntimeMode;
  }
  if (originalTransportDebug === undefined) {
    delete process.env.SQUADFLOW_CODEX_TRANSPORT_DEBUG;
  } else {
    process.env.SQUADFLOW_CODEX_TRANSPORT_DEBUG = originalTransportDebug;
  }
  if (originalRustLog === undefined) {
    delete process.env.RUST_LOG;
  } else {
    process.env.RUST_LOG = originalRustLog;
  }
});

function baseInput(overrides: Partial<BuildExpertRuntimeOptionsInput> = {}): BuildExpertRuntimeOptionsInput {
  return {
    role: "verify",
    systemPrompt: "system",
    cwd: "/tmp/cwd",
    scratchDir: "/managed/scratch",
    capabilities: ["read", "search", "shell"],
    mcpTools: [],
    ...overrides,
  };
}

describe("buildCodexExpertOptions browser MCP config", () => {
  it("grants the project, per-flow scratch, and shared pooled Codex temp as writable roots", () => {
    const options = buildCodexExpertOptions(baseInput({
      cwd: "/repo/project",
      scratchDir: "/managed/scratch",
      capabilities: ["read", "write", "shell"],
    }));

    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.config).toEqual(expect.objectContaining({
      "sandbox_workspace_write.exclude_tmpdir_env_var": true,
      "sandbox_workspace_write.exclude_slash_tmp": true,
    }));
    expect(options.config["sandbox_workspace_write.writable_roots"]).toEqual([
      "/repo/project",
      "/managed/scratch",
      expect.stringMatching(/output\/runtime\/scratch\/codex-pool\/custom$/),
    ]);
    expect(options.env).toMatchObject({
      TMPDIR: "/managed/scratch",
      TMP: "/managed/scratch",
      TEMP: "/managed/scratch",
    });
    expect(options.systemPrompt).toContain("禁止设置 sandbox_permissions=require_escalated");
  });

  it("configures the mcp_servers key so the resulting mcp__<server>__<tool> toolName matches BROWSER_MCP_TOOL_PREFIX", () => {
    const options = buildCodexExpertOptions(baseInput({
      mcpServerConfig: {
        type: "http",
        name: "squadflow-browser",
        url: "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
        bearerToken: "secret-token",
        bearerTokenEnvVar: "SQUADFLOW_MCP_BRIDGE_TOKEN_TEST",
      },
    }));

    const configuredKeys = Object.keys(options.config).filter((key) => key.startsWith("mcp_servers."));
    expect(configuredKeys.sort()).toEqual([
      "mcp_servers.squadflow-browser.bearer_token_env_var",
      "mcp_servers.squadflow-browser.url",
    ]);
    expect(options.config["mcp_servers.squadflow-browser.url"]).toBe("http://127.0.0.1:8001/api/mcp/bridge/browser-test");
    expect(options.config["mcp_servers.squadflow-browser.bearer_token_env_var"]).toBe("SQUADFLOW_MCP_BRIDGE_TOKEN_TEST");
    expect(options.env.SQUADFLOW_MCP_BRIDGE_TOKEN_TEST).toBe("secret-token");

    const [, serverKey] = "mcp_servers.squadflow-browser.url".split(".");
    expect(`mcp__${serverKey}__browser_navigate`).toBe(`${BROWSER_MCP_TOOL_PREFIX}browser_navigate`);
  });

  it("does not add any mcp_servers config when no browser MCP binding is provided", () => {
    const options = buildCodexExpertOptions(baseInput());
    const configuredKeys = Object.keys(options.config).filter((key) => key.startsWith("mcp_servers."));
    expect(configuredKeys).toEqual([]);
  });

  it("uses external Codex without isolated CODEX_HOME for inherited local auth", () => {
    process.env.SQUADFLOW_EXTERNAL_CODEX_COMMAND = "/usr/local/bin/codex";
    process.env.OPENAI_API_KEY = "sk-should-not-be-forwarded";

    const options = buildCodexExpertOptions(baseInput({
      runtimeConfig: {
        id: "codex-local",
        fileName: "codex-local.json",
        name: "codex-local",
        sdk: "codex",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "gpt-5", name: "gpt-5" }],
      },
    }));

    expect(options.runtimeProfile.id).toBe("external-modern");
    expect(options.appServerCommand).toBe("/usr/local/bin/codex");
    expect(options.env.CODEX_HOME).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.modelProvider).toBe("openai");
    expect(options.config.model_reasoning_effort).toBeUndefined();
    expect(Object.keys(options.config).some((key) => key.startsWith("model_providers."))).toBe(false);
    expect(options.config["sandbox_workspace_write.writable_roots"]).toContainEqual(
      expect.stringMatching(/output\/runtime\/scratch\/codex-pool\/official$/),
    );
  });

  it("enables opt-in Codex transport diagnostics without changing normal runs", () => {
    process.env.SQUADFLOW_CODEX_TRANSPORT_DEBUG = "1";
    process.env.RUST_LOG = "codex_app_server=info";
    const options = buildCodexExpertOptions(baseInput());

    expect(options.env.RUST_LOG).toContain("codex_app_server=info");
    expect(options.env.RUST_LOG).toContain("codex_api=debug");
    expect(options.env.RUST_LOG).toContain("codex_http_client=debug");
    expect(options.env.RUST_LOG).toContain("codex_app_server_transport=debug");
  });

  it("passes Codex reasoning effort through config", () => {
    const options = buildCodexExpertOptions(baseInput({
      runtimeConfig: {
        id: "codex-local",
        fileName: "codex-local.json",
        name: "codex-local",
        sdk: "codex",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        reasoningEffort: "xhigh",
        models: [{ id: "gpt-5", name: "gpt-5" }],
      } as BuildExpertRuntimeOptionsInput["runtimeConfig"] & { reasoningEffort: string },
    }));

    expect(options.config.model_reasoning_effort).toBe("xhigh");
  });

  it("does not pass reasoning effort to an API-key Codex provider", () => {
    const options = buildCodexExpertOptions(baseInput({
      runtimeConfig: {
        ...baseInput().runtimeConfig,
        id: "codex-api",
        fileName: "codex-api.json",
        name: "Codex API",
        sdk: "codex",
        authMode: "apiKey",
        baseUrl: "https://provider.example/v1",
        apiKey: "sk-test",
        reasoningEffort: "high",
        models: [{ id: "qwen-plus", name: "qwen3.7-plus" }],
      } as BuildExpertRuntimeOptionsInput["runtimeConfig"] & { reasoningEffort: string },
    }));

    expect(options.config.model_reasoning_effort).toBeUndefined();
  });

  it.each(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini"])(
    "leaves official Codex context metadata to the runtime for %s",
    (model) => {
    const options = buildCodexExpertOptions(baseInput({
      runtimeConfig: {
        id: "codex-local",
        fileName: "codex-local.json",
        name: "codex-local",
        sdk: "codex",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [{ id: model, name: model }],
      },
    }));

      expect(options.config.model_context_window).toBeUndefined();
      expect(options.config.model_auto_compact_token_limit).toBeUndefined();
    },
  );

  it.each(["inherited", "apiKey"] as const)(
    "configures automatic compaction for %s Codex providers",
    (authMode) => {
      const options = buildCodexExpertOptions(baseInput({
        runtimeConfig: {
          id: `codex-${authMode}`,
          fileName: `codex-${authMode}.json`,
          name: `Codex ${authMode}`,
          sdk: "codex",
          authMode,
          baseUrl: authMode === "apiKey" ? "https://provider.example/v1" : "",
          apiKey: authMode === "apiKey" ? "sk-test" : "",
          models: [{
            id: "gpt-5.6-terra",
            name: "gpt-5.6-terra",
            ...(authMode === "apiKey" ? { contextWindowK: 512 } : {}),
          }],
        },
      }));

      expect(options.config.model_context_window).toBe(authMode === "inherited" ? undefined : 512_000);
      expect(options.config.model_auto_compact_token_limit).toBe(authMode === "inherited" ? undefined : 409_600);
    },
  );
});

describe("buildCodexLeaderOptions MCP config", () => {
  it("exposes Leader and browser MCP namespaces to the external official-login runtime", () => {
    process.env.SQUADFLOW_EXTERNAL_CODEX_COMMAND = "/usr/local/bin/codex";
    const options = buildCodexLeaderOptions({
      role: "leader",
      systemPrompt: "system",
      cwd: "/tmp/cwd",
      capabilities: ["read", "search", "shell"],
      mcpTools: [],
      runtimeConfig: {
        id: "codex-local",
        fileName: "codex-local.json",
        name: "Codex Local",
        sdk: "codex",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "gpt-5.6-terra", name: "gpt-5.6-terra" }],
      },
      mcpServerConfigs: {
        "squadflow-leader": {
          url: "http://127.0.0.1:8001/api/mcp/bridge/leader-test",
          bearerToken: "leader-secret",
          bearerTokenEnvVar: "SQUADFLOW_LEADER_TOKEN_TEST",
        },
        "squadflow-browser": {
          url: "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
          bearerToken: "browser-secret",
          bearerTokenEnvVar: "SQUADFLOW_BROWSER_TOKEN_TEST",
        },
      },
    });

    expect(options.config).toEqual(expect.objectContaining({
      "mcp_servers.squadflow-leader.url": "http://127.0.0.1:8001/api/mcp/bridge/leader-test",
      "mcp_servers.squadflow-leader.bearer_token_env_var": "SQUADFLOW_LEADER_TOKEN_TEST",
      "mcp_servers.squadflow-browser.url": "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
      "mcp_servers.squadflow-browser.bearer_token_env_var": "SQUADFLOW_BROWSER_TOKEN_TEST",
    }));
    expect(options.env.SQUADFLOW_LEADER_TOKEN_TEST).toBe("leader-secret");
    expect(options.env.SQUADFLOW_BROWSER_TOKEN_TEST).toBe("browser-secret");
  });

  it("does not expose the browser MCP namespace to the bundled legacy runtime", () => {
    process.env.SQUADFLOW_CODEX_RUNTIME_MODE = "bundled-legacy-flat-mcp";
    const options = buildCodexLeaderOptions({
      role: "leader",
      systemPrompt: "system",
      cwd: "/tmp/cwd",
      capabilities: ["read", "search", "shell"],
      mcpTools: [],
      runtimeConfig: {
        id: "codex-mimo",
        fileName: "codex-mimo.json",
        name: "Codex Mimo",
        sdk: "codex",
        authMode: "apiKey",
        baseUrl: "https://api.xiaomimimo.com/v1",
        apiKey: "mimo-secret",
        models: [{ id: "mimo-v2.5", name: "mimo-v2.5" }],
      },
      mcpServerConfigs: {
        "squadflow-leader": {
          url: "http://127.0.0.1:8001/api/mcp/bridge/leader-test",
          bearerToken: "leader-secret",
          bearerTokenEnvVar: "SQUADFLOW_LEADER_TOKEN_TEST",
        },
        "squadflow-browser": {
          url: "http://127.0.0.1:8001/api/mcp/bridge/browser-test",
          bearerToken: "browser-secret",
          bearerTokenEnvVar: "SQUADFLOW_BROWSER_TOKEN_TEST",
        },
      },
    });

    expect(options.runtimeProfile.id).toBe("bundled-legacy-flat-mcp");
    expect(options.config).toEqual(expect.objectContaining({
      "mcp_servers.squadflow-leader.url": "http://127.0.0.1:8001/api/mcp/bridge/leader-test",
    }));
    expect(options.config).not.toHaveProperty("mcp_servers.squadflow-browser.url");
    expect(options.env.SQUADFLOW_LEADER_TOKEN_TEST).toBe("leader-secret");
    expect(options.env.SQUADFLOW_BROWSER_TOKEN_TEST).toBeUndefined();
  });
});

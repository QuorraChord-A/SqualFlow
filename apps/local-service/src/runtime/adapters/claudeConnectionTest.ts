import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import {
  claudeRuntimeModelName,
  runtimeModelContextWindowK,
} from "../../config/runtimeModelContext.js";
import type { AgentRuntimeConnectionTestInput, AgentRuntimeConnectionTestResult } from "./runtimeConnectionTest.js";
import { inheritedProcessEnv } from "./claudeOptions.js";

function testModel(runtimeConfig: RuntimeConfig, input: AgentRuntimeConnectionTestInput) {
  const bodyModel = input.model?.trim();
  const firstConfigModel = runtimeConfig.models.find((model) => model.name.trim())?.name.trim();
  return bodyModel || firstConfigModel || "";
}

function testEnv(
  runtimeConfig: RuntimeConfig,
  model: string,
  contextWindowK: number | null,
  claudeConfigDir: string,
) {
  const env: Record<string, string> = {
    ...inheritedProcessEnv(),
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ANTHROPIC_MODEL: model,
  };
  if (contextWindowK === 1_000) {
    delete env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  } else if (contextWindowK !== null) {
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
  }
  if (runtimeConfig.authMode === "apiKey") {
    const apiKey = runtimeConfig.apiKey.trim();
    const baseUrl = runtimeConfig.baseUrl.trim();
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  }
  return env;
}

function resultErrorCode(message: SDKMessage) {
  if (message.type !== "result" || !message.is_error) return null;
  const errors = "errors" in message && Array.isArray(message.errors)
    ? message.errors.map((item) => String(item)).join("\n")
    : "";
  const text = errors || message.stop_reason || message.subtype;
  if (/auth|api key|unauthorized|401|403/i.test(text)) return "AUTH_FAILED";
  if (/model|not_found|not found|404/i.test(text)) return "MODEL_UNAVAILABLE";
  if (/rate|429/i.test(text)) return "RATE_LIMITED";
  if (/overload|529/i.test(text)) return "PROVIDER_OVERLOADED";
  return "GENERATION_TEST_FAILED";
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|abort/i.test(message)) return "TIMEOUT";
  if (/auth|api key|unauthorized|401|403/i.test(message)) return "AUTH_FAILED";
  if (/model|not_found|not found|404/i.test(message)) return "MODEL_UNAVAILABLE";
  if (/rate|429/i.test(message)) return "RATE_LIMITED";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(message)) return "NETWORK_ERROR";
  return "GENERATION_TEST_FAILED";
}

function resultErrorMessage(message: SDKMessage | null) {
  if (!message || message.type !== "result") return "连接测试未成功完成。";
  if ("errors" in message && Array.isArray(message.errors) && message.errors.length > 0) {
    return message.errors.map((item) => String(item)).join("\n");
  }
  if ("result" in message && typeof message.result === "string" && message.result.trim()) {
    return message.result;
  }
  return message.stop_reason || message.subtype || "连接测试未成功完成。";
}

export async function testClaudeRuntimeConnection(
  runtimeConfig: RuntimeConfig,
  input: AgentRuntimeConnectionTestInput,
): Promise<AgentRuntimeConnectionTestResult> {
  const configuredModel = testModel(runtimeConfig, input);
  if (!configuredModel) {
    return {
      ok: false,
      sdk: runtimeConfig.sdk,
      model: "",
      latencyMs: 0,
      code: "MODEL_REQUIRED",
      message: "请先填写要测试的模型名称。",
    };
  }

  const contextWindowK = runtimeModelContextWindowK(runtimeConfig, configuredModel);
  const runtimeModel = claudeRuntimeModelName(configuredModel, contextWindowK);
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15_000);
  const claudeConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "squadflow-claude-test-"));

  try {
    const stream = claudeQuery({
      prompt: "OK",
      options: {
        systemPrompt: "Reply exactly: OK",
        cwd: config.workspaceRoot,
        tools: [],
        allowedTools: [],
        disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch"],
        mcpServers: {},
        permissionMode: "default",
        canUseTool: async () => ({ behavior: "deny", message: "Connection test does not allow tool use." }),
        settingSources: [],
        settings: { model: runtimeModel },
        env: testEnv(runtimeConfig, runtimeModel, contextWindowK, claudeConfigDir),
        model: runtimeModel,
        maxTurns: 1,
        persistSession: false,
        abortController,
        pathToClaudeCodeExecutable: config.claudeCodeExecutable,
      },
    });

    let finalResult: SDKMessage | null = null;
    for await (const message of stream) {
      if (message.type === "result") finalResult = message;
    }

    const latencyMs = Date.now() - startedAt;
    if (finalResult?.type === "result" && !finalResult.is_error && finalResult.subtype === "success") {
      return {
        ok: true,
        sdk: runtimeConfig.sdk,
        model: configuredModel,
        latencyMs,
        message: "连接成功",
        totalCostUsd: finalResult.total_cost_usd,
        usage: finalResult.usage,
      };
    }

    return {
      ok: false,
      sdk: runtimeConfig.sdk,
      model: configuredModel,
      latencyMs,
      code: finalResult ? resultErrorCode(finalResult) ?? "GENERATION_TEST_FAILED" : "NO_RESULT",
      message: resultErrorMessage(finalResult),
    };
  } catch (error) {
    return {
      ok: false,
      sdk: runtimeConfig.sdk,
      model: configuredModel,
      latencyMs: Date.now() - startedAt,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    await fs.rm(claudeConfigDir, { recursive: true, force: true });
  }
}

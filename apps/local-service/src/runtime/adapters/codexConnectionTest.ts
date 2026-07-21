import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.js";
import type { RuntimeConfig } from "../../config/agentRuntimeConfig.js";
import { runtimeModelContextWindowK } from "../../config/runtimeModelContext.js";
import {
  buildCodexExpertOptions,
  codexAppServerArgs,
  type CodexRuntimeOptions,
} from "./codexOptions.js";
import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexAppServerTransport } from "./codexAppServerClient.js";
import type { AgentRuntimeConnectionTestInput, AgentRuntimeConnectionTestResult } from "./runtimeConnectionTest.js";

const execFileAsync = promisify(execFile);

type CodexConnectionTestOptions = {
  clientFactory?: (options: CodexAppServerClientOptions) => CodexAppServerTransport;
  skipVersionCheck?: boolean;
};

function requestedModel(runtimeConfig: RuntimeConfig, input: AgentRuntimeConnectionTestInput) {
  return input.model?.trim() || runtimeConfig.models.find((model) => model.name.trim())?.name.trim() || "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex app-server startup timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function withRequestedModel(runtimeConfig: RuntimeConfig, model: string): RuntimeConfig {
  const configuredModel = runtimeConfig.models.find((item) => item.name.trim() === model);
  const contextWindowK = runtimeConfig.authMode === "inherited"
    ? null
    : runtimeModelContextWindowK(runtimeConfig, model);
  return {
    ...runtimeConfig,
    models: [
      {
        id: configuredModel?.id ?? "connection-test-model",
        name: model,
        ...(contextWindowK === null ? {} : { contextWindowK }),
      },
      ...runtimeConfig.models.filter((item) => item.id !== configuredModel?.id),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function requestId(value: unknown): string | number | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function providerErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/spawn codex ENOENT|codex.*ENOENT|codex.*not found|command not found/i.test(message)) return "CODEX_CLI_UNAVAILABLE";
  if (/timed out|timeout|aborted|abort/i.test(message)) return "TIMEOUT";
  if (/auth|api key|unauthorized|401|403/i.test(message)) return "AUTH_FAILED";
  if (/model|not_found|not found|404/i.test(message)) return "MODEL_UNAVAILABLE";
  if (/rate|429/i.test(message)) return "RATE_LIMITED";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(message)) return "NETWORK_ERROR";
  return "GENERATION_TEST_FAILED";
}

function providerConfigError(runtimeConfig: RuntimeConfig): { code: string; message: string } | null {
  if (runtimeConfig.authMode !== "apiKey") return null;
  if (!runtimeConfig.apiKey.trim()) {
    return { code: "API_KEY_REQUIRED", message: "Codex runtime API key is not configured" };
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function codexTurnFailureMessage(status: string, completedTurn: Record<string, unknown>) {
  const details = [
    completedTurn.error,
    completedTurn.lastError,
    completedTurn.result,
    completedTurn.output,
  ].filter((value) => value !== undefined && value !== null && value !== "");
  const suffix = details.length ? `: ${details.map(safeJson).join(" | ")}` : "";
  return `Codex connection test turn ended with status: ${status || "unknown"}${suffix}`;
}

function codexConnectionOptions(runtimeConfig: RuntimeConfig, model: string): CodexRuntimeOptions {
  return buildCodexExpertOptions({
    role: "coder",
    systemPrompt: "Reply with a short plain-text message.",
    cwd: config.workspaceRoot,
    scratchDir: path.join(os.tmpdir(), "squadflow-codex-connection-test"),
    capabilities: ["read"],
    mcpTools: [],
    runtimeConfig: withRequestedModel(runtimeConfig, model),
  });
}

async function runCodexSmokeTurn(
  client: CodexAppServerTransport,
  options: CodexRuntimeOptions,
): Promise<{ usage: unknown; message: string }> {
  await client.start();
  const threadResult = await client.request("thread/start", {
    model: options.model || null,
    modelProvider: options.modelProvider || null,
    cwd: options.cwd,
    approvalPolicy: "on-request",
    sandbox: "read-only",
    config: options.config,
    baseInstructions: options.systemPrompt,
    developerInstructions: options.systemPrompt,
    ephemeral: true,
  });
  const thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : {};
  const threadId = stringValue(thread.id);
  if (!threadId) throw new Error("Codex app-server did not return a thread id");
  const turnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with the single word: ok.", text_elements: [] }],
    cwd: options.cwd,
    model: options.model || null,
  });
  const turn = isRecord(turnResult) && isRecord(turnResult.turn) ? turnResult.turn : {};
  const turnId = stringValue(turn.id);
  if (!turnId) throw new Error("Codex app-server did not return a turn id");

  let text = "";
  let usage: unknown;
  for await (const event of client.notifications()) {
    if (requestId(event.id) !== null && typeof event.method === "string") {
      client.respond(requestId(event.id)!, { decision: "decline" });
      continue;
    }
    const params = isRecord(event.params) ? event.params : {};
    if (event.method === "item/agentMessage/delta") text += stringValue(params.delta);
    if (event.method === "thread/tokenUsage/updated") usage = params.tokenUsage;
    if (event.method !== "turn/completed") continue;
    const completedTurn = isRecord(params.turn) ? params.turn : {};
    if (stringValue(params.threadId) !== threadId || stringValue(completedTurn.id) !== turnId) continue;
    const status = stringValue(completedTurn.status);
    if (status !== "completed") throw new Error(codexTurnFailureMessage(status, completedTurn));
    if (!text.trim()) {
      throw new Error("Codex connection test did not return any assistant text");
    }
    return { usage, message: "连接成功；Codex app-server 已完成普通对话轮次测试。" };
  }
  throw new Error("Codex app-server ended before the connection test turn completed");
}

export async function testCodexRuntimeConnection(
  runtimeConfig: RuntimeConfig,
  input: AgentRuntimeConnectionTestInput,
  options: CodexConnectionTestOptions = {},
): Promise<AgentRuntimeConnectionTestResult> {
  const startedAt = Date.now();
  const model = requestedModel(runtimeConfig, input);
  let client: CodexAppServerTransport | null = null;
  try {
    if (!model) {
      return {
        ok: false,
        sdk: "codex",
        model,
        latencyMs: Date.now() - startedAt,
        code: "MODEL_REQUIRED",
        message: "Codex runtime model is not configured",
      };
    }
    const configError = providerConfigError(runtimeConfig);
    if (configError) {
      return {
        ok: false,
        sdk: "codex",
        model,
        latencyMs: Date.now() - startedAt,
        code: configError.code,
        message: configError.message,
      };
    }
    const runtimeOptions = codexConnectionOptions(runtimeConfig, model);
    if (!options.skipVersionCheck) await execFileAsync(runtimeOptions.appServerCommand, ["--version"], {
      env: runtimeOptions.env,
      timeout: 5_000,
    });
    client = options.clientFactory
      ? options.clientFactory({
        command: runtimeOptions.appServerCommand,
        args: codexAppServerArgs(runtimeOptions),
        env: runtimeOptions.env,
        cwd: runtimeOptions.cwd,
      })
      : new CodexAppServerClient({
        command: runtimeOptions.appServerCommand,
        args: codexAppServerArgs(runtimeOptions),
        env: runtimeOptions.env,
        cwd: runtimeOptions.cwd,
      });
    const smoke = await withTimeout(runCodexSmokeTurn(client, runtimeOptions), 30_000);
    return {
      ok: true,
      sdk: "codex",
      model,
      latencyMs: Date.now() - startedAt,
      message: smoke.message,
      usage: smoke.usage,
    };
  } catch (error) {
    return {
      ok: false,
      sdk: "codex",
      model,
      latencyMs: Date.now() - startedAt,
      code: providerErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client?.close();
  }
}

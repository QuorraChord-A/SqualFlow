import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import type { RuntimeConfig, RuntimeModelConfig } from "../../config/agentRuntimeConfig.js";
import { officialCodexContextWindowK } from "../../config/runtimeModelContext.js";
import {
  buildCodexExpertOptions,
  codexAppServerArgs,
  type CodexRuntimeOptions,
} from "./codexOptions.js";
import { CodexAppServerClient, type CodexAppServerClientOptions, type CodexAppServerTransport } from "./codexAppServerClient.js";

type CodexModelListOptions = {
  clientFactory?: (options: CodexAppServerClientOptions) => CodexAppServerTransport;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex model list request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function codexModelListOptions(runtimeConfig: RuntimeConfig): CodexRuntimeOptions {
  return buildCodexExpertOptions({
    role: "coder",
    systemPrompt: "List available Codex models.",
    cwd: config.workspaceRoot,
    scratchDir: path.join(os.tmpdir(), "squadflow-codex-model-list"),
    capabilities: ["read"],
    mcpTools: [],
    runtimeConfig,
  });
}

function modelFromValue(value: unknown): RuntimeModelConfig | null {
  const record = isRecord(value) ? value : {};
  const name = stringValue(record.model) || stringValue(record.id);
  if (!name.trim()) return null;
  return {
    id: stringValue(record.id, name).trim(),
    name: name.trim(),
  };
}

async function requestAllModels(client: CodexAppServerTransport): Promise<RuntimeModelConfig[]> {
  const models: RuntimeModelConfig[] = [];
  let cursor: string | null = null;
  do {
    const result = await client.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    });
    const record = isRecord(result) ? result : {};
    const page = Array.isArray(record.data) ? record.data : [];
    for (const item of page) {
      const model = modelFromValue(item);
      if (model && !models.some((existing) => existing.name === model.name)) models.push(model);
    }
    cursor = stringValue(record.nextCursor) || null;
  } while (cursor);
  return models;
}

export async function listCodexRuntimeModels(
  runtimeConfig: RuntimeConfig,
  options: CodexModelListOptions = {},
): Promise<RuntimeModelConfig[]> {
  const runtimeOptions = codexModelListOptions(runtimeConfig);
  const client = options.clientFactory
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

  try {
    await client.start();
    const models = await withTimeout(requestAllModels(client), 20_000);
    return runtimeConfig.authMode === "inherited"
      ? models.map((model) => ({
          ...model,
          contextWindowK: officialCodexContextWindowK(model.name),
        }))
      : models;
  } finally {
    client.close();
  }
}

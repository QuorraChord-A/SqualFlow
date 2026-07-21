import type { RuntimeConfig, RuntimeSdk } from "../config/agentRuntimeConfig.js";
import {
  CodexAppServerClient,
  type CodexAppServerTransport,
} from "./adapters/codexAppServerClient.js";
import {
  codexAppServerBaseArgs,
  resolveCodexRuntimeProfile,
} from "./adapters/codexRuntimeProfile.js";

export type RuntimeLocalAuthStatus = "detected" | "missing" | "invalid" | "unsupported";

export type RuntimeLocalAuthResult = {
  sdk: RuntimeSdk;
  status: RuntimeLocalAuthStatus;
  message: string;
  path?: string;
  source?: "oauth" | "api_key" | "keychain" | "file";
  accountHint?: string;
};

export type RuntimeLocalAuthDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  codexAppServerClient?: Pick<CodexAppServerTransport, "request" | "close">;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function detectCodexLocalAuth(options: RuntimeLocalAuthDetectionOptions): Promise<RuntimeLocalAuthResult> {
  const env = options.env ?? process.env;
  let command: string | undefined;
  let client = options.codexAppServerClient;
  try {
    if (!client) {
      const profile = resolveCodexRuntimeProfile(env, { preferExternal: true });
      command = profile.command;
      client = new CodexAppServerClient({
        command: profile.command,
        args: codexAppServerBaseArgs(profile),
        env,
      });
    }
    const response = await client.request("account/read", { refreshToken: false });
    if (!isRecord(response) || typeof response.requiresOpenaiAuth !== "boolean") {
      return {
        sdk: "codex",
        status: "invalid",
        message: "Codex app-server 返回了无效的账号状态。",
        path: command,
      };
    }

    if (response.account === null || response.account === undefined) {
      return {
        sdk: "codex",
        status: "missing",
        message: "Codex 当前未登录，请先在 Codex 完成登录。",
        path: command,
      };
    }

    if (!isRecord(response.account) || typeof response.account.type !== "string") {
      return {
        sdk: "codex",
        status: "invalid",
        message: "Codex app-server 返回了无效的账号信息。",
        path: command,
      };
    }

    if (response.account.type === "chatgpt") {
      return {
        sdk: "codex",
        status: "detected",
        message: "已通过 Codex 官方接口检测到 ChatGPT 登录态。",
        path: command,
        source: "oauth",
        accountHint: typeof response.account.email === "string" ? response.account.email : undefined,
      };
    }

    if (response.account.type === "apiKey") {
      return {
        sdk: "codex",
        status: "detected",
        message: "已通过 Codex 官方接口检测到 API Key 登录态。",
        path: command,
        source: "api_key",
      };
    }

    return {
      sdk: "codex",
      status: "detected",
      message: `已通过 Codex 官方接口检测到 ${response.account.type} 认证状态。`,
      path: command,
    };
  } catch (error) {
    return {
      sdk: "codex",
      status: "invalid",
      message: `Codex 官方接口登录态检测失败：${error instanceof Error ? error.message : String(error)}`,
      path: command,
    };
  } finally {
    client?.close();
  }
}


export async function detectRuntimeLocalAuth(
  runtimeConfig: Pick<RuntimeConfig, "sdk">,
  options: RuntimeLocalAuthDetectionOptions = {},
): Promise<RuntimeLocalAuthResult> {
  if (runtimeConfig.sdk === "codex") return detectCodexLocalAuth(options);
  if (runtimeConfig.sdk === "claudecode") {
    return {
      sdk: runtimeConfig.sdk,
      status: "unsupported",
      message: "Claude Code 不提供官方登录入口，请使用 API Key。",
    };
  }
  return {
    sdk: runtimeConfig.sdk,
    status: "unsupported",
    message: `不支持检测该 Agent 类型的本地登录态：${runtimeConfig.sdk}`,
  };
}

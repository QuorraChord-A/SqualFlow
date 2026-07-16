import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

type ExecFile = typeof execFile;

export type RuntimeLocalAuthDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFile;
  codexAppServerClient?: Pick<CodexAppServerTransport, "request" | "close">;
};

const execFileAsync = promisify(execFile);

function trimEnvPath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.trim().replace(/^["']|["']$/g, "").trim();
  return unquoted || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
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

function claudeConfigDir(options: RuntimeLocalAuthDetectionOptions) {
  return trimEnvPath(options.env?.CLAUDE_CONFIG_DIR)
    ?? path.join(options.homeDir ?? os.homedir(), ".claude");
}

function claudeGlobalConfigPath(configDir: string, options: RuntimeLocalAuthDetectionOptions) {
  const configJson = path.join(configDir, ".config.json");
  if (fsSync.existsSync(configJson)) return configJson;
  const defaultDir = path.join(options.homeDir ?? os.homedir(), ".claude");
  if (path.resolve(configDir) !== path.resolve(defaultDir)) return path.join(configDir, ".claude.json");
  return path.join(options.homeDir ?? os.homedir(), ".claude.json");
}

function claudeKeychainServiceName(configDir: string, options: RuntimeLocalAuthDetectionOptions) {
  const envConfigDir = trimEnvPath(options.env?.CLAUDE_CONFIG_DIR);
  const defaultDir = path.join(options.homeDir ?? os.homedir(), ".claude");
  const defaultUnscopedDir = !envConfigDir && path.resolve(configDir) === path.resolve(defaultDir);
  const hashSuffix = defaultUnscopedDir
    ? ""
    : `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
  return `Claude Code-credentials${hashSuffix}`;
}

function claudeKeychainAccountName(options: RuntimeLocalAuthDetectionOptions) {
  return options.env?.USER?.trim() || options.env?.LOGNAME?.trim() || "claude-code-user";
}

async function readClaudeKeychainCredentials(configDir: string, options: RuntimeLocalAuthDetectionOptions) {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const run = options.execFile ? promisify(options.execFile) : execFileAsync;
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-a",
      claudeKeychainAccountName(options),
      "-w",
      "-s",
      claudeKeychainServiceName(configDir, options),
    ]);
    const text = String(stdout).trim();
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    return null;
  }
}

async function readClaudeFileCredentials(configDir: string) {
  const credentialsPath = path.join(configDir, ".credentials.json");
  try {
    return await readJsonFile(credentialsPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function hasClaudeOauth(credentials: unknown) {
  return isRecord(credentials) && isRecord(credentials.claudeAiOauth);
}

function claudeAccountHint(config: unknown) {
  if (!isRecord(config) || !isRecord(config.oauthAccount)) return undefined;
  const account = config.oauthAccount;
  return typeof account.emailAddress === "string"
    ? account.emailAddress
    : typeof account.email === "string"
      ? account.email
      : undefined;
}

async function detectClaudeLocalAuth(options: RuntimeLocalAuthDetectionOptions): Promise<RuntimeLocalAuthResult> {
  const configDir = claudeConfigDir(options);
  const keychainCredentials = await readClaudeKeychainCredentials(configDir, options);
  let fileCredentials: unknown = null;
  let fileReadError: unknown = null;
  try {
    fileCredentials = keychainCredentials ? null : await readClaudeFileCredentials(configDir);
  } catch (error) {
    fileReadError = error;
  }
  const credentials = keychainCredentials ?? fileCredentials;

  if (!credentials) {
    return {
      sdk: "claudecode",
      status: fileReadError ? "invalid" : "missing",
      message: fileReadError
        ? `Claude Code credentials 读取或解析失败：${fileReadError instanceof Error ? fileReadError.message : String(fileReadError)}`
        : "未找到本机 Claude Code 登录信息，请先在 Claude Code 完成 OAuth 登录。",
      path: path.join(configDir, ".credentials.json"),
    };
  }

  if (!hasClaudeOauth(credentials)) {
    return {
      sdk: "claudecode",
      status: "invalid",
      message: "Claude Code credentials 缺少 claudeAiOauth 字段。",
      path: keychainCredentials ? undefined : path.join(configDir, ".credentials.json"),
      source: keychainCredentials ? "keychain" : "file",
    };
  }

  const configPath = claudeGlobalConfigPath(configDir, options);
  let configFile: unknown;
  try {
    configFile = await readJsonFile(configPath);
  } catch (error) {
    return {
      sdk: "claudecode",
      status: "invalid",
      message: `未找到或无法解析 Claude Code 配置文件：${error instanceof Error ? error.message : String(error)}`,
      path: configPath,
      source: keychainCredentials ? "keychain" : "file",
    };
  }

  if (!isRecord(configFile) || !isRecord(configFile.oauthAccount)) {
    return {
      sdk: "claudecode",
      status: "invalid",
      message: "Claude Code 配置缺少 oauthAccount，请先在 Claude Code 完成登录。",
      path: configPath,
      source: keychainCredentials ? "keychain" : "file",
    };
  }

  return {
    sdk: "claudecode",
    status: "detected",
    message: "已检测到 Claude Code 本地账号登录态。",
    path: configPath,
    source: keychainCredentials ? "keychain" : "file",
    accountHint: claudeAccountHint(configFile),
  };
}

export async function detectRuntimeLocalAuth(
  runtimeConfig: Pick<RuntimeConfig, "sdk">,
  options: RuntimeLocalAuthDetectionOptions = {},
): Promise<RuntimeLocalAuthResult> {
  if (runtimeConfig.sdk === "codex") return detectCodexLocalAuth(options);
  if (runtimeConfig.sdk === "claudecode") return detectClaudeLocalAuth(options);
  return {
    sdk: runtimeConfig.sdk,
    status: "unsupported",
    message: `不支持检测该 Agent 类型的本地登录态：${runtimeConfig.sdk}`,
  };
}

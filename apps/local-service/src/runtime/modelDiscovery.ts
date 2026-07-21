import type { RuntimeConfig, RuntimeModelConfig } from "../config/agentRuntimeConfig.js";

type RecordValue = Record<string, unknown>;

export type RuntimeModelDiscoveryResult = {
  sdk: RuntimeConfig["sdk"];
  models: RuntimeModelConfig[];
  warnings: string[];
  endpoint: string;
};

export type ModelDiscoveryOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function toContextWindowK(value: unknown, unit: "k" | "tokens" | "auto"): number | undefined {
  const number = finiteNumber(value);
  if (number === null) return undefined;
  const result = unit === "tokens" || (unit === "auto" && number > 10_000) ? number / 1_000 : number;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function contextWindowFromRecord(record: RecordValue): number | undefined {
  const directKKeys = ["contextWindowK", "context_window_k", "context_k"];
  for (const key of directKKeys) {
    const value = toContextWindowK(record[key], "k");
    if (value !== undefined) return value;
  }

  const tokenKeys = [
    "max_input_tokens",
    "contextWindowTokens",
    "context_window_tokens",
    "max_context_tokens",
    "input_token_limit",
  ];
  for (const key of tokenKeys) {
    const value = toContextWindowK(record[key], "tokens");
    if (value !== undefined) return value;
  }

  const autoKeys = [
    "contextWindow",
    "context_window",
    "maxContextWindow",
    "max_context_window",
    "contextLength",
    "context_length",
    "maxContextLength",
    "max_context_length",
  ];
  for (const key of autoKeys) {
    const value = toContextWindowK(record[key], "auto");
    if (value !== undefined) return value;
  }
  for (const nestedKey of ["limits", "metadata", "capabilities"]) {
    const nested = record[nestedKey];
    if (!isRecord(nested) || nested === record) continue;
    const value = contextWindowFromRecord(nested);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Parse common OpenAI/Anthropic model object shapes. Effort is intentionally
 * not read from catalogs; SquadFlow defines it per SDK.
 */
export function runtimeModelFromProviderValue(value: unknown): RuntimeModelConfig | null {
  if (!isRecord(value)) return null;
  const id = (stringValue(value.id) || stringValue(value.model)).trim();
  if (!id) return null;
  const contextWindowK = contextWindowFromRecord(value);
  return {
    id,
    name: id,
    ...(contextWindowK === undefined ? {} : { contextWindowK }),
  };
}

function responseItems(body: unknown): { items: unknown[]; standard: boolean } {
  if (!isRecord(body)) return { items: [], standard: false };
  if (Array.isArray(body.data)) return { items: body.data, standard: true };
  // A few OpenAI-compatible gateways use `models`; accepting it keeps the
  // adapter useful while warning that the canonical catalog shape was absent.
  if (Array.isArray(body.models)) return { items: body.models, standard: false };
  return { items: [], standard: false };
}

function defaultBaseUrl(sdk: RuntimeConfig["sdk"]): string {
  return sdk === "claudecode" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

/** Resolve a provider root to the standard GET /models resource. */
export function runtimeModelsEndpoint(runtimeConfig: Pick<RuntimeConfig, "sdk" | "baseUrl">): string {
  const raw = runtimeConfig.baseUrl.trim() || defaultBaseUrl(runtimeConfig.sdk);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL 不是有效的 URL，无法获取模型列表");
  }
  let pathname = url.pathname.replace(/\/+$/u, "");
  for (const suffix of ["/chat/completions", "/responses", "/messages", "/models"]) {
    if (pathname.endsWith(suffix)) pathname = pathname.slice(0, -suffix.length);
  }
  if (!pathname || pathname === "/") pathname = "/v1";
  url.pathname = `${pathname.replace(/\/+$/u, "")}/models`;
  url.search = "";
  return url.toString();
}

function authHeaders(runtimeConfig: RuntimeConfig): Record<string, string> {
  const key = runtimeConfig.apiKey.trim();
  if (!key) throw new Error("请先填写 API Key，再获取模型列表");
  if (runtimeConfig.sdk === "claudecode") {
    return {
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    };
  }
  return {
    accept: "application/json",
    authorization: `Bearer ${key}`,
  };
}

async function fetchJson(
  endpoint: string,
  runtimeConfig: RuntimeConfig,
  options: ModelDiscoveryOptions,
  cursor: string | null,
): Promise<{ body: unknown; response: Response }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(endpoint);
  if (runtimeConfig.sdk === "claudecode") {
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: authHeaders(runtimeConfig),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("获取模型列表超时，请检查 Base URL 或网络连接");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接模型列表接口：${message}`);
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The status-based error below is more useful than a JSON parse error.
    }
    return { body, response };
  } finally {
    clearTimeout(timeout);
  }
}

function responseError(endpoint: string, response: Response): Error {
  return new Error(`获取模型列表失败（HTTP ${response.status}）。请确认 API Key、Base URL，并确认提供商支持标准 GET ${new URL(endpoint).pathname} 接口。`);
}

function missingModelsSummary(models: RuntimeModelConfig[]) {
  const names = models.slice(0, 3).map((model) => model.name).join("、");
  return models.length <= 3 ? names : `${names} 等 ${models.length} 个模型`;
}

export function runtimeModelMetadataWarnings(
  models: RuntimeModelConfig[],
  source = "提供商",
): string[] {
  const missingContext = models.filter((model) => model.contextWindowK === undefined || model.contextWindowK === null);
  return [
    ...(missingContext.length > 0
      ? [`${source}未返回上下文大小（max_input_tokens/context_window）：${missingModelsSummary(missingContext)}；刷新时会保留已有配置，新模型使用 SDK 默认值。`]
      : []),
  ];
}

export async function discoverRuntimeModels(
  runtimeConfig: RuntimeConfig,
  options: ModelDiscoveryOptions = {},
): Promise<RuntimeModelDiscoveryResult> {
  if (runtimeConfig.authMode === "inherited") {
    throw new Error("官方登录态模型列表必须通过 Codex app-server 获取");
  }
  const endpoint = runtimeModelsEndpoint(runtimeConfig);
  const models: RuntimeModelConfig[] = [];
  const warnings: string[] = [];
  let cursor: string | null = null;
  let usedNonStandardShape = false;
  for (let page = 0; page < 10; page += 1) {
    const { body, response } = await fetchJson(endpoint, runtimeConfig, options, cursor);
    if (!response.ok) throw responseError(endpoint, response);
    const parsed = responseItems(body);
    if (!parsed.standard) usedNonStandardShape = true;
    for (const item of parsed.items) {
      const model = runtimeModelFromProviderValue(item);
      if (model && !models.some((existing) => existing.id === model.id)) models.push(model);
    }
    if (runtimeConfig.sdk !== "claudecode" || !isRecord(body) || body.has_more !== true || models.length === 0) break;
    const nextCursor = stringValue(body.last_id).trim();
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  if (usedNonStandardShape) warnings.push("提供商未使用标准 { data: [...] } 模型目录格式，已按兼容格式解析。");
  if (models.length === 0) {
    throw new Error("提供商未返回可用模型，或未实现标准 GET /models 接口；请手动填写模型名称。");
  }
  return {
    sdk: runtimeConfig.sdk,
    models,
    warnings: [...warnings, ...runtimeModelMetadataWarnings(models)],
    endpoint,
  };
}

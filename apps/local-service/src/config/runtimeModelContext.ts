export const MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K = 128;
export const CLAUDE_CONTEXT_WINDOW_K_OPTIONS = [200, 1_000] as const;
export const DEFAULT_CLAUDE_CONTEXT_WINDOW_K = 1_000;
export const DEFAULT_CODEX_CONTEXT_WINDOW_K = 256;

type RuntimeSdk = "claudecode" | "codex";
type RuntimeAuthMode = "inherited" | "apiKey" | "accessToken";

type RuntimeModelWithContext = {
  name: string;
  contextWindowK?: number | null;
};

type RuntimeConfigWithModelContext = {
  sdk: RuntimeSdk;
  authMode: RuntimeAuthMode;
  models: RuntimeModelWithContext[];
};

export function stripClaudeExtendedContextSuffix(modelName: string): string {
  return modelName.trim().replace(/\[1m\]$/iu, "");
}

function hasClaudeExtendedContextSuffix(modelName: string): boolean {
  return /\[1m\]$/iu.test(modelName.trim());
}

export function claudeRuntimeModelName(modelName: string, contextWindowK?: number | null): string {
  const normalizedName = stripClaudeExtendedContextSuffix(modelName);
  return contextWindowK === 1_000 && normalizedName ? `${normalizedName}[1m]` : normalizedName;
}

export function normalizeRuntimeModelContext(
  sdk: RuntimeSdk,
  _authMode: RuntimeAuthMode,
  modelName: string,
  rawContextWindowK: unknown,
): { name: string; contextWindowK?: number | null } {
  if (sdk === "claudecode") {
    const name = stripClaudeExtendedContextSuffix(modelName);
    const contextWindowK = rawContextWindowK === undefined
      ? (hasClaudeExtendedContextSuffix(modelName) ? 1_000 : DEFAULT_CLAUDE_CONTEXT_WINDOW_K)
      : rawContextWindowK;
    if (contextWindowK === null) return { name, contextWindowK: DEFAULT_CLAUDE_CONTEXT_WINDOW_K };
    if (
      typeof contextWindowK !== "number"
      || !Number.isFinite(contextWindowK)
      || !CLAUDE_CONTEXT_WINDOW_K_OPTIONS.includes(contextWindowK as 200 | 1_000)
    ) {
      throw new Error("Claude Code 上下文只能是 200K 或 1000K");
    }
    return { name, contextWindowK };
  }

  const contextWindowK = rawContextWindowK ?? DEFAULT_CODEX_CONTEXT_WINDOW_K;
  if (
    typeof contextWindowK !== "number"
    || !Number.isFinite(contextWindowK)
    || contextWindowK < MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K
  ) {
    throw new Error(`Codex 上下文必须是大于等于 ${MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}K 的数字`);
  }
  return { name: modelName, contextWindowK };
}

export function defaultRuntimeModelContextWindowK(sdk: RuntimeSdk): number {
  return sdk === "claudecode" ? DEFAULT_CLAUDE_CONTEXT_WINDOW_K : DEFAULT_CODEX_CONTEXT_WINDOW_K;
}

/** Normalize metadata returned by a provider without applying a fallback. */
export function discoveredRuntimeModelContextWindowK(
  sdk: RuntimeSdk,
  rawContextWindowK: unknown,
): number | null {
  if (typeof rawContextWindowK !== "number" || !Number.isFinite(rawContextWindowK)) return null;
  if (sdk === "claudecode") return rawContextWindowK >= 1_000 ? 1_000 : 200;
  return rawContextWindowK >= MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K ? rawContextWindowK : null;
}

/**
 * Provider metadata wins. If it is absent, retain the model's previous value;
 * only a newly discovered model receives the SDK fallback.
 */
export function refreshedRuntimeModelContextWindowK(
  sdk: RuntimeSdk,
  discoveredContextWindowK: unknown,
  previousContextWindowK: unknown,
): number {
  return discoveredRuntimeModelContextWindowK(sdk, discoveredContextWindowK)
    ?? discoveredRuntimeModelContextWindowK(sdk, previousContextWindowK)
    ?? defaultRuntimeModelContextWindowK(sdk);
}

/**
 * Returns the normalized context configured for the selected model.
 */
export function runtimeModelContextWindowK(
  runtimeConfig: RuntimeConfigWithModelContext | undefined,
  modelName: string,
): number | null {
  if (!runtimeConfig) return null;

  const normalizedRequestedName = runtimeConfig.sdk === "claudecode"
    ? stripClaudeExtendedContextSuffix(modelName)
    : modelName.trim();
  const configuredModel = runtimeConfig.models.find((model) => {
    const configuredName = runtimeConfig.sdk === "claudecode"
      ? stripClaudeExtendedContextSuffix(model.name)
      : model.name.trim();
    return configuredName === normalizedRequestedName;
  });
  const contextWindowK = configuredModel?.contextWindowK;
  return typeof contextWindowK === "number" && Number.isFinite(contextWindowK)
    ? contextWindowK
    : null;
}

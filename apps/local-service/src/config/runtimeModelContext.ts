export const CLAUDE_CONTEXT_WINDOW_K_OPTIONS = [200, 1_000] as const;
export const DEFAULT_CLAUDE_CONTEXT_WINDOW_K = 200;
export const MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K = 128;
export const DEFAULT_CUSTOM_CODEX_CONTEXT_WINDOW_K = MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K;

type RuntimeSdk = "claudecode" | "codex";
type RuntimeAuthMode = "inherited" | "apiKey" | "accessToken";

type RuntimeModelWithContext = {
  name: string;
  contextWindowK?: number;
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

export function claudeRuntimeModelName(modelName: string, contextWindowK: number): string {
  const normalizedName = stripClaudeExtendedContextSuffix(modelName);
  return contextWindowK === 1_000 && normalizedName ? `${normalizedName}[1m]` : normalizedName;
}

export function officialCodexContextWindowK(modelName: string): number {
  const normalizedName = modelName.trim().toLowerCase();
  if (/^gpt-5(?:$|\.)/u.test(normalizedName)) return 258;
  return DEFAULT_CUSTOM_CODEX_CONTEXT_WINDOW_K;
}

export function normalizeRuntimeModelContext(
  sdk: RuntimeSdk,
  authMode: RuntimeAuthMode,
  modelName: string,
  rawContextWindowK: unknown,
): { name: string; contextWindowK?: number } {
  if (sdk === "claudecode") {
    const name = stripClaudeExtendedContextSuffix(modelName);
    const contextWindowK = rawContextWindowK === undefined
      ? (hasClaudeExtendedContextSuffix(modelName) ? 1_000 : DEFAULT_CLAUDE_CONTEXT_WINDOW_K)
      : rawContextWindowK;
    if (
      typeof contextWindowK !== "number"
      || !CLAUDE_CONTEXT_WINDOW_K_OPTIONS.some((option) => option === contextWindowK)
    ) {
      throw new Error("Claude Code 上下文只能选择 200K 或 1M");
    }
    return { name, contextWindowK };
  }

  if (authMode === "inherited") {
    return { name: modelName };
  }

  const contextWindowK = rawContextWindowK === undefined
    ? DEFAULT_CUSTOM_CODEX_CONTEXT_WINDOW_K
    : rawContextWindowK;
  if (
    typeof contextWindowK !== "number"
    || !Number.isFinite(contextWindowK)
    || !Number.isInteger(contextWindowK)
    || contextWindowK < MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K
  ) {
    throw new Error(`非官方 Codex 上下文必须是大于等于 ${MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K}K 的整数`);
  }
  return { name: modelName, contextWindowK };
}

export function runtimeModelContextWindowK(
  runtimeConfig: RuntimeConfigWithModelContext | undefined,
  modelName: string,
): number {
  if (!runtimeConfig) return DEFAULT_CUSTOM_CODEX_CONTEXT_WINDOW_K;
  if (runtimeConfig.sdk === "codex" && runtimeConfig.authMode === "inherited") {
    return officialCodexContextWindowK(modelName);
  }

  const normalizedRequestedName = runtimeConfig.sdk === "claudecode"
    ? stripClaudeExtendedContextSuffix(modelName)
    : modelName.trim();
  const configuredModel = runtimeConfig.models.find((model) => {
    const configuredName = runtimeConfig.sdk === "claudecode"
      ? stripClaudeExtendedContextSuffix(model.name)
      : model.name.trim();
    return configuredName === normalizedRequestedName;
  });

  if (runtimeConfig.sdk === "claudecode") {
    return configuredModel?.contextWindowK === 1_000 ? 1_000 : DEFAULT_CLAUDE_CONTEXT_WINDOW_K;
  }
  const configuredContextWindowK = configuredModel?.contextWindowK;
  return typeof configuredContextWindowK === "number"
    && Number.isInteger(configuredContextWindowK)
    && configuredContextWindowK >= MIN_CUSTOM_CODEX_CONTEXT_WINDOW_K
    ? configuredContextWindowK
    : DEFAULT_CUSTOM_CODEX_CONTEXT_WINDOW_K;
}

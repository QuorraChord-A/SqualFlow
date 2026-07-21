export type ResumeFailureCategory = "session_missing" | "session_invalid" | "resume_failed";

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly method: string;
  readonly code: string | number | null;
  readonly data: unknown;
  readonly requestedSessionId: string | null;

  constructor(input: {
    provider: string;
    method: string;
    code?: string | number | null;
    message: string;
    data?: unknown;
    requestedSessionId?: string | null;
  }) {
    super(input.message);
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.method = input.method;
    this.code = input.code ?? null;
    this.data = input.data;
    this.requestedSessionId = input.requestedSessionId ?? null;
  }
}

export class LeaderSessionRecoveryError extends Error {
  readonly code = "LEADER_SESSION_RECOVERY_REQUIRED";
  readonly category: ResumeFailureCategory;
  readonly provider: string;
  readonly sessionId: string;
  readonly providerCode: string | number | null;

  constructor(input: {
    category: ResumeFailureCategory;
    provider: string;
    sessionId: string;
    message: string;
    providerCode?: string | number | null;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "LeaderSessionRecoveryError";
    this.category = input.category;
    this.provider = input.provider;
    this.sessionId = input.sessionId;
    this.providerCode = input.providerCode ?? null;
  }
}

function codexMissingSession(error: ProviderRequestError, sessionId: string) {
  if (error.provider !== "codex" || error.method !== "thread/resume") return false;
  if (error.requestedSessionId !== sessionId) return false;
  return error.code === -32600 && error.message === `no rollout found for thread id ${sessionId}`;
}

function codexInvalidSession(error: ProviderRequestError, sessionId: string) {
  if (error.provider !== "codex" || error.method !== "thread/resume") return false;
  if (error.requestedSessionId !== sessionId) return false;
  return error.code === -32600 && error.message.startsWith("invalid session id:");
}

export function classifyLeaderResumeFailure(
  error: unknown,
  provider: string,
  sessionId: string,
): LeaderSessionRecoveryError {
  if (error instanceof LeaderSessionRecoveryError) return error;
  if (error instanceof ProviderRequestError && codexMissingSession(error, sessionId)) {
    return new LeaderSessionRecoveryError({
      category: "session_missing",
      provider,
      sessionId,
      providerCode: error.code,
      cause: error,
      message: "Provider 返回原 Leader 会话不存在，系统不会创建新会话。",
    });
  }
  if (error instanceof ProviderRequestError && codexInvalidSession(error, sessionId)) {
    return new LeaderSessionRecoveryError({
      category: "session_invalid",
      provider,
      sessionId,
      providerCode: error.code,
      cause: error,
      message: "Provider 拒绝了原 Leader 会话 ID，系统不会创建新会话。",
    });
  }
  return new LeaderSessionRecoveryError({
    category: "resume_failed",
    provider,
    sessionId,
    providerCode: error instanceof ProviderRequestError ? error.code : null,
    cause: error,
    message: "原 Leader 会话暂时无法恢复，系统不会创建新会话。请重试恢复。",
  });
}

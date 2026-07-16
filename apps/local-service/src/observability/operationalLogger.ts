import { createHash } from "node:crypto";

export type OperationalLogger = {
  info: (bindings: Record<string, unknown>, message?: string) => void;
  warn: (bindings: Record<string, unknown>, message?: string) => void;
  error: (bindings: Record<string, unknown>, message?: string) => void;
};

export function errorDiagnostic(error: unknown): Record<string, unknown> {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof record?.code === "string" || typeof record?.code === "number"
    ? record.code
    : undefined;
  return {
    errorName: name,
    ...(code !== undefined ? { errorCode: code } : {}),
    errorFingerprint: createHash("sha256").update(message).digest("hex"),
  };
}

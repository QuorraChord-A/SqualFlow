import { describe, expect, it } from "vitest";
import {
  classifyLeaderResumeFailure,
  ProviderRequestError,
} from "../src/runtime/adapters/runtimeErrors.js";

describe("Leader session recovery classification", () => {
  it("only classifies the exact Codex missing-thread response", () => {
    const error = new ProviderRequestError({
      provider: "codex",
      method: "thread/resume",
      code: -32600,
      message: "no rollout found for thread id thread-1",
      requestedSessionId: "thread-1",
    });
    expect(classifyLeaderResumeFailure(error, "codex", "thread-1").category).toBe("session_missing");
    expect(classifyLeaderResumeFailure(error, "codex", "thread-2").category).toBe("resume_failed");
  });

  it("does not call transport failures session-missing", () => {
    const classified = classifyLeaderResumeFailure(new Error("socket closed"), "claudecode", "session-1");
    expect(classified.category).toBe("resume_failed");
    expect(classified.code).toBe("LEADER_SESSION_RECOVERY_REQUIRED");
  });
});

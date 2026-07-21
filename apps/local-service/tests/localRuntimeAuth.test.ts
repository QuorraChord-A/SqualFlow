import { describe, expect, it } from "vitest";
import { detectRuntimeLocalAuth } from "../src/runtime/localRuntimeAuth.js";

describe("runtime local auth detection", () => {
  it("detects Codex ChatGPT auth through account/read without refreshing tokens", async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    let closed = false;
    const result = await detectRuntimeLocalAuth({ sdk: "codex" }, {
      codexAppServerClient: {
        request: async (method, params) => {
          requests.push({ method, params });
          return {
            account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
            requiresOpenaiAuth: true,
          };
        },
        close: () => { closed = true; },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      sdk: "codex",
      status: "detected",
      source: "oauth",
      accountHint: "user@example.com",
    }));
    expect(requests).toEqual([{
      method: "account/read",
      params: { refreshToken: false },
    }]);
    expect(closed).toBe(true);
  });

  it("reports a missing Codex account from account/read", async () => {
    const result = await detectRuntimeLocalAuth({ sdk: "codex" }, {
      codexAppServerClient: {
        request: async () => ({ account: null, requiresOpenaiAuth: true }),
        close: () => undefined,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      sdk: "codex",
      status: "missing",
    }));
    expect(result.message).not.toContain("auth.json");
  });

  it("does not expose Claude Code local authentication", async () => {
    const result = await detectRuntimeLocalAuth({ sdk: "claudecode" });

    expect(result).toEqual(expect.objectContaining({
      sdk: "claudecode",
      status: "unsupported",
    }));
    expect(result.message).toContain("API Key");
    expect(result.path).toBeUndefined();
  });
});

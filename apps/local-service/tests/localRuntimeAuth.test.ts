import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRuntimeLocalAuth } from "../src/runtime/localRuntimeAuth.js";

const tempDirs: string[] = [];

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squadflow-local-auth-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

  it("detects Claude Code file credentials from a temp config dir", async () => {
    const home = tempHome();
    writeJson(path.join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: {
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
      },
    });
    writeJson(path.join(home, ".claude.json"), {
      oauthAccount: {
        emailAddress: "claude@example.com",
      },
    });

    const result = await detectRuntimeLocalAuth(
      { sdk: "claudecode" },
      { homeDir: home, platform: "linux" },
    );

    expect(result).toEqual(expect.objectContaining({
      sdk: "claudecode",
      status: "detected",
      source: "file",
      accountHint: "claude@example.com",
    }));
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
  });

  it("reports missing Claude Code credentials without reading the real machine", async () => {
    const home = tempHome();

    const result = await detectRuntimeLocalAuth(
      { sdk: "claudecode" },
      { homeDir: home, platform: "linux" },
    );

    expect(result).toEqual(expect.objectContaining({
      sdk: "claudecode",
      status: "missing",
    }));
    expect(result.path).toContain(path.join(home, ".claude", ".credentials.json"));
  });
});

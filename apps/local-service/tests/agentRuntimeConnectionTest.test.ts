import { describe, expect, it } from "vitest";
import { testCodexRuntimeConnection } from "../src/runtime/adapters/codexConnectionTest.js";
import type { CodexAppServerClientOptions } from "../src/runtime/adapters/codexAppServerClient.js";

describe("agent runtime connection test", () => {
  it("surfaces Codex app-server turn failure details", async () => {
    const result = await testCodexRuntimeConnection({
      id: "draft-runtime-config",
      fileName: "draft-runtime-config.json",
      name: "Draft",
      sdk: "codex",
      authMode: "apiKey",
      baseUrl: "https://example.test/v1/responses",
      apiKey: "sk-test",
      models: [{ id: "model-1", name: "gpt-test" }],
    }, {
      model: "gpt-test",
    }, {
      skipVersionCheck: true,
      clientFactory: () => {
        return {
          start: async () => {},
          request: async (method) => {
            if (method === "thread/start") return { thread: { id: "thread-1" } };
            if (method === "turn/start") return { turn: { id: "turn-1" } };
            throw new Error(`unexpected request: ${method}`);
          },
          notify: () => {},
          respond: () => {},
          close: () => {},
          notifications: async function* () {
            yield {
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "failed",
                  error: { message: "provider rejected request", code: "bad_request" },
                },
              },
            };
          },
        };
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      sdk: "codex",
      model: "gpt-test",
      code: "GENERATION_TEST_FAILED",
      message: expect.stringContaining("provider rejected request"),
    }));
  });

  it("tests Codex draft configs with a real app-server turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const clientOptions: CodexAppServerClientOptions[] = [];
    const result = await testCodexRuntimeConnection({
      id: "draft-runtime-config",
      fileName: "draft-runtime-config.json",
      name: "Draft",
      sdk: "codex",
      authMode: "apiKey",
      baseUrl: "https://example.test/v1/responses",
      apiKey: "sk-test",
      models: [{ id: "model-1", name: "gpt-test" }],
    }, {
      model: "gpt-test",
    }, {
      skipVersionCheck: true,
      clientFactory: (options) => {
        clientOptions.push(options);
        return {
          start: async () => {},
          request: async (method, params) => {
            requests.push({ method, params });
            if (method === "thread/start") return { thread: { id: "thread-1" } };
            if (method === "turn/start") return { turn: { id: "turn-1" } };
            throw new Error(`unexpected request: ${method}`);
          },
          notify: () => {},
          respond: () => {},
          close: () => {},
          notifications: async function* () {
            yield {
              method: "item/agentMessage/delta",
              params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "ok" },
            };
            yield {
              method: "turn/completed",
              params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
            };
          },
        };
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sdk: "codex",
      model: "gpt-test",
    }));
    expect(clientOptions[0].args).toEqual(expect.arrayContaining([
      "-c",
      "model_providers.squadflow-draft-runtime-config.base_url=\"https://example.test/v1\"",
    ]));
    expect(requests.find((request) => request.method === "turn/start")?.params).toEqual(expect.objectContaining({
      input: [{ type: "text", text: "Reply with the single word: ok.", text_elements: [] }],
    }));
    const threadStart = requests.find((request) => request.method === "thread/start")?.params as Record<string, unknown>;
    expect(threadStart.developerInstructions).toEqual(expect.stringContaining("Reply with a short plain-text message."));
    expect(threadStart).not.toHaveProperty("baseInstructions");
  });
});

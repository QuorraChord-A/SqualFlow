import { describe, expect, it, vi } from "vitest";
import {
  discoverRuntimeModels,
  runtimeModelFromProviderValue,
  runtimeModelsEndpoint,
} from "../src/runtime/modelDiscovery.js";
import type { RuntimeConfig } from "../src/config/agentRuntimeConfig.js";
import { mergeRefreshedRuntimeModels } from "../src/config/agentRuntimeConnectionTest.js";

function runtimeConfig(patch: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    id: "provider-1",
    fileName: "provider-1.json",
    name: "Provider",
    sdk: "claudecode",
    authMode: "apiKey",
    baseUrl: "",
    apiKey: "sk-test",
    models: [],
    ...patch,
  };
}

describe("runtime model discovery", () => {
  it("parses Anthropic model context and ignores provider effort metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: "claude-sonnet-test",
        display_name: "Claude Sonnet Test",
        max_input_tokens: 200_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: false },
          },
        },
      }],
      has_more: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await discoverRuntimeModels(runtimeConfig(), { fetchImpl });

    expect(result.endpoint).toBe("https://api.anthropic.com/v1/models");
    expect(result.models).toEqual([{
      id: "claude-sonnet-test",
      name: "claude-sonnet-test",
      contextWindowK: 200,
    }]);
    expect(result.warnings).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(init?.headers).toEqual(expect.objectContaining({
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-test",
    }));
  });

  it("keeps missing OpenAI-compatible metadata unavailable instead of guessing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-provider-model", object: "model" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await discoverRuntimeModels(runtimeConfig({
      sdk: "codex",
      baseUrl: "https://provider.example/v1/responses",
    }), { fetchImpl });

    expect(result.endpoint).toBe("https://provider.example/v1/models");
    expect(result.models).toEqual([{ id: "gpt-provider-model", name: "gpt-provider-model" }]);
    expect(result.warnings).toEqual([
      expect.stringContaining("未返回上下文大小"),
    ]);
  });

  it("parses Codex model metadata without model-name rules", () => {
    expect(runtimeModelFromProviderValue({
      id: "gpt-future",
      model: "gpt-future",
      supportedReasoningEfforts: [
        { reasoningEffort: "minimal", description: "Fast" },
        { reasoningEffort: "high", description: "Deep" },
      ],
      defaultReasoningEffort: "minimal",
    })).toEqual({
      id: "gpt-future",
      name: "gpt-future",
    });
  });

  it("normalizes common provider endpoint suffixes", () => {
    expect(runtimeModelsEndpoint({ sdk: "codex", baseUrl: "https://api.openai.com/v1/responses" }))
      .toBe("https://api.openai.com/v1/models");
    expect(runtimeModelsEndpoint({ sdk: "claudecode", baseUrl: "https://api.anthropic.com/v1/messages" }))
      .toBe("https://api.anthropic.com/v1/models");
  });

  it("reports providers that do not implement the model catalog", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));

    await expect(discoverRuntimeModels(runtimeConfig(), { fetchImpl }))
      .rejects.toThrow("支持标准 GET /v1/models 接口");
  });

  it("keeps a configured context when a refresh omits it", () => {
    expect(mergeRefreshedRuntimeModels({
      sdk: "claudecode",
      models: [{ id: "m1", name: "claude-sonnet-test", contextWindowK: 200 }],
    }, [{ id: "m1", name: "claude-sonnet-test" }])).toEqual([{
      id: "m1",
      name: "claude-sonnet-test",
      contextWindowK: 200,
    }]);
    expect(mergeRefreshedRuntimeModels({ sdk: "codex", models: [] }, [{ id: "m2", name: "gpt-new" }])[0].contextWindowK)
      .toBe(256);
  });
});

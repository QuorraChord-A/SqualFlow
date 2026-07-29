import { describe, expect, it } from "vitest";
import {
  captureMcpServerIcons,
  mcpServerIconsForTool,
  refreshMcpServerIcons,
} from "../src/runtime/mcpServerIcons.js";

describe("MCP server icon discovery", () => {
  it("captures serverInfo icons and resolves them from a namespaced tool", () => {
    const registry = new Map();
    captureMcpServerIcons(registry, [{
      name: "context7",
      serverInfo: {
        icons: [{
          src: "https://context7.com/context7-icon-green.png",
          mimeType: "image/png",
        }],
      },
    }]);

    expect(mcpServerIconsForTool("mcp__context7__query-docs", registry)).toEqual([{
      src: "https://context7.com/context7-icon-green.png",
      mimeType: "image/png",
    }]);
    expect(mcpServerIconsForTool("mcp__tavily__tavily_search", registry)).toBeUndefined();
  });

  it("accepts app-server status envelopes without retaining invalid icons", () => {
    const registry = new Map();
    captureMcpServerIcons(registry, {
      mcp_servers: [
        {
          name: "context7",
          server_info: {
            icons: [{ src: "", mimeType: "image/png" }, { src: "data:image/png;base64,abc" }],
          },
        },
        { name: "tavily", serverInfo: {} },
      ],
    });

    expect(registry.get("context7")).toEqual([{ src: "data:image/png;base64,abc" }]);
    expect(registry.has("tavily")).toBe(false);
  });

  it("does not block a Flow while status discovery is unavailable", async () => {
    const captured: unknown[] = [];
    await refreshMcpServerIcons(
      { getMcpServerStatus: () => new Promise(() => {}) },
      { captureMcpServerStatus: (value) => captured.push(value) },
      1,
    );

    expect(captured).toEqual([]);
  });
});

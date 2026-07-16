import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DesktopBridge } from "../server/desktopBridge.js";

export const BROWSER_MCP_TOOL_PREFIX = "mcp__squadflow-browser__";

export const BROWSER_MCP_TOOL_NAMES = [
  "browser_navigate",
  "browser_reload",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_wait_for",
  "browser_screenshot",
  "browser_console_logs",
  "browser_eval",
].map((tool) => `${BROWSER_MCP_TOOL_PREFIX}${tool}`);

export const BROWSER_OBSERVE_TOOL_NAMES = [
  "browser_navigate",
  "browser_reload",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console_logs",
  "browser_wait_for",
].map((tool) => `${BROWSER_MCP_TOOL_PREFIX}${tool}`);

const BrowserNavigateInput = z.object({ url: z.string().min(1) }).strict();
const BrowserReloadInput = z.object({}).strict();
const BrowserSnapshotInput = z.object({}).strict();
const BrowserClickInput = z.object({ ref: z.string().min(1) }).strict();
const BrowserFillInput = z.object({ ref: z.string().min(1), value: z.string() }).strict();
const BrowserWaitForInput = z.object({
  text: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(30000).optional(),
}).strict();
const BrowserScreenshotInput = z.object({}).strict();
const BrowserConsoleLogsInput = z.object({ limit: z.number().int().positive().max(200).optional() }).strict();
const BrowserEvalInput = z.object({ js: z.string().min(1) }).strict();

export type BrowserToolRuntimeContext = {
  desktopBridge: DesktopBridge;
  holderName: string;
  flowId: string;
  getAgentSessionId: () => string | null;
  getScratchDir: () => string;
};

function ok(fields: Record<string, unknown> = {}) {
  return JSON.stringify({ ok: true, ...fields });
}

function fail(code: string, message: string) {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function leaseErrorText(heldBy: string, reason: "busy" | "revoked") {
  if (reason === "revoked") {
    return fail("BROWSER_LEASE_REVOKED", "浏览器控制权已被用户收回，本次任务不得再操作浏览器。");
  }
  return fail("BROWSER_BUSY", `浏览器正被 ${heldBy} 占用，请稍后重试。`);
}

function desktopUnavailableText() {
  return fail("DESKTOP_UNAVAILABLE", "desktop 不可用：未检测到已连接的 Electron 客户端。");
}

export function createBrowserToolHandlers(ctx: BrowserToolRuntimeContext) {
  const withLease = async (fn: () => Promise<Record<string, unknown>>): Promise<string> => {
    if (!ctx.desktopBridge.isConnected()) return desktopUnavailableText();
    const agentSessionId = ctx.getAgentSessionId();
    if (!agentSessionId) return fail("NO_ACTIVE_TURN", "浏览器工具只能在活动任务中使用。");
    const lease = ctx.desktopBridge.acquireLease(agentSessionId, ctx.holderName, ctx.flowId);
    if (!lease.ok) return leaseErrorText(lease.heldBy, lease.reason);
    try {
      return ok(await fn());
    } catch (error) {
      return fail("BRIDGE_ERROR", error instanceof Error ? error.message : String(error));
    }
  };

  return {
    async navigate(input: unknown) {
      const parsed = BrowserNavigateInput.parse(input);
      return withLease(async () => (await ctx.desktopBridge.request("navigate", { url: parsed.url })) as Record<string, unknown>);
    },
    async reload() {
      return withLease(async () => (await ctx.desktopBridge.request("reload", {})) as Record<string, unknown>);
    },
    async snapshot() {
      return withLease(async () => (await ctx.desktopBridge.request("snapshot", {})) as Record<string, unknown>);
    },
    async click(input: unknown) {
      const parsed = BrowserClickInput.parse(input);
      return withLease(async () => (await ctx.desktopBridge.request("click", { ref: parsed.ref })) as Record<string, unknown>);
    },
    async fill(input: unknown) {
      const parsed = BrowserFillInput.parse(input);
      return withLease(async () => (await ctx.desktopBridge.request("fill", { ref: parsed.ref, value: parsed.value })) as Record<string, unknown>);
    },
    async waitFor(input: unknown) {
      const parsed = BrowserWaitForInput.parse(input);
      if (!parsed.text && !parsed.selector) {
        return fail("INVALID_INPUT", "browser_wait_for requires text or selector.");
      }
      return withLease(async () => (await ctx.desktopBridge.request("wait_for", {
        text: parsed.text,
        selector: parsed.selector,
        timeoutMs: parsed.timeoutMs ?? 5000,
      }, (parsed.timeoutMs ?? 5000) + 5000)) as Record<string, unknown>);
    },
    async screenshot() {
      return withLease(async () => {
        const result = await ctx.desktopBridge.request("screenshot", {}) as { dataUrl: string; width: number; height: number };
        const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
        const scratchDir = ctx.getScratchDir();
        fs.mkdirSync(scratchDir, { recursive: true });
        const fileName = `browser-screenshot-${Date.now()}.png`;
        const filePath = path.join(scratchDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
        return { path: filePath, width: result.width, height: result.height };
      });
    },
    async consoleLogs(input: unknown) {
      const parsed = BrowserConsoleLogsInput.parse(input);
      return withLease(async () => (await ctx.desktopBridge.request("console_logs", { limit: parsed.limit ?? 50 })) as Record<string, unknown>);
    },
    async evalJs(input: unknown) {
      const parsed = BrowserEvalInput.parse(input);
      return withLease(async () => (await ctx.desktopBridge.request("eval", { js: parsed.js })) as Record<string, unknown>);
    },
  };
}

export function createBrowserMcpServer(handlers: ReturnType<typeof createBrowserToolHandlers>) {
  const server = new McpServer({ name: "squadflow-browser", version: "0.1.0" });

  server.registerTool(
    "browser_navigate",
    { title: "browser_navigate", description: "Navigate the embedded desktop browser to a URL and wait for load. Returns {url, title}.", inputSchema: BrowserNavigateInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.navigate(input) }] }),
  );
  server.registerTool(
    "browser_reload",
    { title: "browser_reload", description: "Reload the current page in the embedded desktop browser. Returns {url, title}.", inputSchema: BrowserReloadInput },
    async () => ({ content: [{ type: "text", text: await handlers.reload() }] }),
  );
  server.registerTool(
    "browser_snapshot",
    {
      title: "browser_snapshot",
      description: "Capture the current interactive DOM and return refs for browser_click/browser_fill. Refs identify the current element instances, not permanent selectors; they may expire after navigation, reload, SPA updates, DOM replacement, or user interaction.",
      inputSchema: BrowserSnapshotInput,
    },
    async () => ({ content: [{ type: "text", text: await handlers.snapshot() }] }),
  );
  server.registerTool(
    "browser_click",
    {
      title: "browser_click",
      description: "Click one element using a ref from the latest browser_snapshot. Sequential clicks are supported while refs remain valid. Inspect every result; if ok=false or reason=ref_expired, stop using refs from that snapshot and take a new browser_snapshot before continuing.",
      inputSchema: BrowserClickInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.click(input) }] }),
  );
  server.registerTool(
    "browser_fill",
    {
      title: "browser_fill",
      description: "Fill one element using a ref from the latest browser_snapshot. Inspect the result before the next action; if ok=false or reason=ref_expired, stop using refs from that snapshot and take a new browser_snapshot before continuing.",
      inputSchema: BrowserFillInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.fill(input) }] }),
  );
  server.registerTool(
    "browser_wait_for",
    { title: "browser_wait_for", description: "Wait until page text or a CSS selector appears, or until timeoutMs elapses.", inputSchema: BrowserWaitForInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.waitFor(input) }] }),
  );
  server.registerTool(
    "browser_screenshot",
    {
      title: "browser_screenshot",
      description: "Capture a screenshot of the current page, saved to this AgentSession's scratch directory. Returns the file path.",
      inputSchema: BrowserScreenshotInput,
    },
    async () => ({ content: [{ type: "text", text: await handlers.screenshot() }] }),
  );
  server.registerTool(
    "browser_console_logs",
    { title: "browser_console_logs", description: "Return the most recent browser console log entries.", inputSchema: BrowserConsoleLogsInput },
    async (input) => ({ content: [{ type: "text", text: await handlers.consoleLogs(input) }] }),
  );
  server.registerTool(
    "browser_eval",
    {
      title: "browser_eval",
      description: "Evaluate JavaScript in the page for debugging/inspection ONLY. Never use this as a substitute for browser_click/browser_fill to implement a deliverable.",
      inputSchema: BrowserEvalInput,
    },
    async (input) => ({ content: [{ type: "text", text: await handlers.evalJs(input) }] }),
  );

  return server;
}

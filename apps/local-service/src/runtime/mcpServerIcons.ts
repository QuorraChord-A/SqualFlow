import type { UiMcpIcon } from "../protocol/uiMessageChunks.js";

export type McpServerIconRegistry = Map<string, UiMcpIcon[]>;

type McpStatusQuery = {
  getMcpServerStatus?: () => Promise<unknown>;
};

type McpStatusCapture = {
  captureMcpServerStatus?: (value: unknown) => void;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iconList(value: unknown): UiMcpIcon[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.src !== "string" || item.src.trim() === "") return [];
    const theme = item.theme === "light" || item.theme === "dark" ? item.theme : undefined;
    return [{
      src: item.src,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
      ...(Array.isArray(item.sizes)
        ? { sizes: item.sizes.filter((size): size is string => typeof size === "string") }
        : {}),
      ...(theme ? { theme } : {}),
    }];
  });
}

function statusList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.mcpServers)) return value.mcpServers;
  return Array.isArray(value.mcp_servers) ? value.mcp_servers : [];
}

/**
 * Capture MCP server metadata returned by a runtime without persisting it.
 *
 * Claude's SDK currently types `serverInfo` narrowly, but the MCP protocol
 * carries the optional `icons` field there. Keep the parsing tolerant so an
 * SDK/app-server can add the field without coupling the UI to one provider.
 */
export function captureMcpServerIcons(
  registry: McpServerIconRegistry,
  value: unknown,
): void {
  for (const item of statusList(value)) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const serverInfo = isRecord(item.serverInfo)
      ? item.serverInfo
      : isRecord(item.server_info)
        ? item.server_info
        : null;
    const icons = iconList(serverInfo?.icons ?? item.icons);
    if (icons.length > 0) registry.set(item.name, icons);
  }
}

export function mcpServerIconsForTool(
  toolName: string,
  registry: ReadonlyMap<string, UiMcpIcon[]> | undefined,
): UiMcpIcon[] | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  if (!match) return undefined;
  const icons = registry?.get(match[1]);
  return icons && icons.length > 0 ? icons : undefined;
}

/**
 * Ask a runtime for the current MCP status without making icon discovery part
 * of the turn's critical path. The registry belongs to the active Flow and is
 * deliberately never persisted.
 */
export async function refreshMcpServerIcons(
  query: McpStatusQuery | null | undefined,
  capture: McpStatusCapture | null | undefined,
  timeoutMs = 2_000,
): Promise<void> {
  if (!query?.getMcpServerStatus || !capture?.captureMcpServerStatus) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      query.getMcpServerStatus(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("MCP server status timed out")), timeoutMs);
      }),
    ]);
    capture.captureMcpServerStatus(status);
  } catch {
    // Icon discovery is best-effort. A slow or unavailable MCP server must
    // never delay or fail the user's turn.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

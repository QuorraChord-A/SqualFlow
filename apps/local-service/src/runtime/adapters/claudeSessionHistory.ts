import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatUIMessage } from "../../ws/chatJournal.js";
import { rawSdkTranscriptToUiMessages } from "../../ws/sdkHistory.js";

type UnknownRecord = Record<string, unknown>;

export type ClaudeCompactTranscriptMetadata = {
  preTokens: number | null;
  postTokens: number;
  timestamp: string | null;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactMetadataFromEntry(entry: unknown): ClaudeCompactTranscriptMetadata | null {
  const record = asRecord(entry);
  if (!record || record.type !== "system" || record.subtype !== "compact_boundary") return null;
  const metadata = asRecord(record.compactMetadata ?? record.compact_metadata);
  if (!metadata) return null;
  const postTokens = numberValue(metadata.postTokens);
  if (postTokens === null) return null;
  return {
    preTokens: numberValue(metadata.preTokens),
    postTokens,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
  };
}

async function findClaudeSessionTranscriptPath(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return null;
  const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let projectDirs;
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Continue searching other project directories.
    }
  }

  return null;
}

// Claude Agent SDK also exposes getSessionMessages(sessionId); SquadFlow reads the native
// transcript so visible history and compact metadata share the same persisted source.
export async function getRawClaudeSessionHistory(sessionId: string, flowId: string): Promise<ChatUIMessage[]> {
  const transcriptPath = await findClaudeSessionTranscriptPath(sessionId);
  if (!transcriptPath) return [];
  const raw = await fs.readFile(transcriptPath, "utf8");
  return rawSdkTranscriptToUiMessages(raw, flowId);
}

export async function getLatestClaudeCompactTranscriptMetadata(
  sessionId: string,
): Promise<ClaudeCompactTranscriptMetadata | null> {
  const transcriptPath = await findClaudeSessionTranscriptPath(sessionId);
  if (!transcriptPath) return null;

  let latest: ClaudeCompactTranscriptMetadata | null = null;
  const raw = await fs.readFile(transcriptPath, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      latest = compactMetadataFromEntry(JSON.parse(trimmed)) ?? latest;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return latest;
}

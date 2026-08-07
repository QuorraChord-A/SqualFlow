import type { MessageImageAttachment } from "../../../types/messageAttachments";
import type { BrowserElementAttachment } from "../../../stores/useBrowserSelectionStore";

export type TranscriptActivity = "waiting" | "reasoning" | "text" | "tool-running" | "finished";

export type TimelineToolState = "running" | "completed" | "failed" | "interrupted";

export type RuntimeCapability = "read" | "write" | "edit" | "shell" | "search" | "web_search";

export type TimelineTool = {
  toolCallId: string;
  toolName: string;
  capability?: RuntimeCapability;
  providerToolName?: string;
  mcp?: {
    server: string;
    tool: string;
    title?: string;
    icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
    serverIcons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  };
  state: TimelineToolState;
  input: Record<string, unknown> | null;
  output: unknown;
};

export type TranscriptBlock =
  | { id: string; type: "text"; text: string; streaming: boolean }
  | {
      id: string;
      type: "guide-message";
      text: string;
      statusLabel?: string | null;
      imageAttachments?: MessageImageAttachment[];
      browserAttachments?: BrowserElementAttachment[];
      commentCount?: number;
      comments?: Array<{ markerNumber: number; label: string; comment: string }>;
    }
  | { id: string; type: "reasoning"; text: string; streaming: boolean; defaultCollapsed: boolean }
  | {
      id: string;
      type: "tool-group";
      tools: TimelineTool[];
      finalized: boolean;
      defaultCollapsed: boolean;
      activeState?: "thinking" | "running" | "pinned";
      currentToolCallId?: string | null;
    }
  | { id: string; type: "decision-request"; requestId: string; toolCallId: string }
  | {
      id: string;
      type: "decision-request-result";
      requestId: string;
      status: "resolved" | "cancelled";
      collapseState: "expanded" | "shallow";
    }
  | { id: string; type: "plan-card"; planApprovalId: string; toolCallId: string }
  | { id: string; type: "orchestration-card"; orchestrationRevisionId: string; toolCallId: string }
  | { id: string; type: "thinking" };

export type TimelineInputPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; state?: string }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      toolName: string;
      capability?: RuntimeCapability;
      providerToolName?: string;
      mcp?: TimelineTool["mcp"];
      state: "input-streaming" | "input-available" | "output-available";
      input?: Record<string, unknown> | null;
      output?: unknown;
    };

export type TimelineInputMessage = {
  id: string;
  role: "assistant" | "user";
  parts: TimelineInputPart[];
  metadata?: {
    decisionRequestId?: string;
    decisionRequestStatus?: "resolved" | "cancelled";
  } & Record<string, unknown>;
};

export type ToolKind =
  | "glob"
  | "grep"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "web-search"
  | "mcp"
  | "unknown";

export type ToolIcon =
  | "search"
  | "file"
  | "edit"
  | "terminal"
  | "question"
  | "plan"
  | "task"
  | "agent"
  | "message"
  | "context"
  | "unknown";

export type ReadToolPresentation = {
  path: string;
  parentPath: string;
  content?: string;
  error?: string;
  returnedStart: number;
  returnedLineCount?: number;
  truncated: boolean;
  totalLines?: number;
  rangeLabel: string;
  sizeLabel: string;
  detailMetaLabel: string;
};

export type ToolPresentation = {
  kind: ToolKind;
  icon: ToolIcon;
  status: "queued" | "running" | "completed" | "failed" | "interrupted" | "denied";
  statusLabel: string;
  title: string;
  operationLabel: string;
  file?: { path: string; name: string; language?: string };
  command?: string;
  query?: string;
  diff?: { additions: number; deletions: number };
  read?: ReadToolPresentation;
  detailRows: Array<{ label: string; value: string }>;
  rawInput: unknown;
  rawOutput: unknown;
  mcp?: {
    server: string;
    tool: string;
    title: string;
    icons: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
    serverIcons: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>;
  };
};

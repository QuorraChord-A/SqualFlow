"use client";

import { useAgentSessions } from "../../hooks/useAgentSessions";
import SessionTranscriptPanel from "./SessionTranscriptPanel";

interface SessionDetailPanelProps {
  flowId: string | null;
  agentSessionId: string;
  workspaceRootPath?: string | null;
  onOpenWorkspaceFile?: (path: string) => void;
}

export default function SessionDetailPanel({ flowId, agentSessionId, workspaceRootPath, onOpenWorkspaceFile }: SessionDetailPanelProps) {
  const { agentSessions } = useAgentSessions(flowId);
  const agentSession = agentSessions.find((expert) => expert.agent_session_id === agentSessionId);
  const isAwaitingResponse = agentSession?.status === "queued" || agentSession?.status === "streaming";

  return (
    <div data-testid="session-detail-panel" className="flex h-full min-h-0 flex-col">
      <SessionTranscriptPanel
        flowId={flowId}
        agentSessionId={agentSessionId}
        agentRunId={null}
        readonly
        isAwaitingResponse={isAwaitingResponse}
        emptyTitle="暂无专家消息"
        className="min-h-0 flex-1"
        workspaceRootPath={workspaceRootPath}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    </div>
  );
}

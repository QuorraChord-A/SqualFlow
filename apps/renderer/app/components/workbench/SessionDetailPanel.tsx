"use client";

import { useFlowExperts } from "../../hooks/useFlowExperts";
import SessionTranscriptPanel from "./SessionTranscriptPanel";

interface SessionDetailPanelProps {
  flowId: string | null;
  flowExpertId: string;
  workspaceRootPath?: string | null;
  onOpenWorkspaceFile?: (path: string) => void;
}

export default function SessionDetailPanel({ flowId, flowExpertId, workspaceRootPath, onOpenWorkspaceFile }: SessionDetailPanelProps) {
  const { flowExperts } = useFlowExperts(flowId);
  const flowExpert = flowExperts.find((expert) => expert.flow_expert_id === flowExpertId);
  const isAwaitingResponse = flowExpert?.status === "queued" || flowExpert?.status === "streaming";

  return (
    <div data-testid="session-detail-panel" className="flex h-full min-h-0 flex-col">
      <SessionTranscriptPanel
        flowId={flowId}
        flowExpertId={flowExpertId}
        agentSessionId={null}
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

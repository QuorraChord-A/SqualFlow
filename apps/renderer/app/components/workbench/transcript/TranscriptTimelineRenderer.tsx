import type { ReactNode } from "react";
import type { DecisionRequestCardData, PlanCardState } from "../../../hooks/useDashboardData";
import type { TranscriptActivity } from "./types";
import type { TurnTiming } from "./buildTranscriptTimeline";
import type { TranscriptBlock } from "./types";
import AssistantTurn from "./AssistantTurn";
import type { OrchestrationPlanView } from "../../../types/orchestration";
import { TranscriptPathProvider } from "./TranscriptPathContext";

type TranscriptTimelineRendererProps = {
  blocks: TranscriptBlock[];
  turnId?: string;
  flowId: string;
  decisionRequestsById: Map<string, DecisionRequestCardData>;
  planCardsById: Map<string, PlanCardState>;
  plansByRevisionId?: Map<string, OrchestrationPlanView>;
  onPlanOpen: (planRevisionId: string, title: string) => void;
  onOrchestrationOpen?: (plan: OrchestrationPlanView) => void;
  onOrchestrationApprove?: (plan: OrchestrationPlanView) => void;
  activity?: TranscriptActivity;
  turnTiming?: TurnTiming | null;
  showReasoning?: boolean;
  beforeFooter?: ReactNode;
  thinkingLabel?: string;
  workspaceRootPath?: string | null;
  onOpenWorkspaceFile?: (path: string) => void;
  "data-testid"?: string;
  "data-transcript-activity"?: string;
};

export default function TranscriptTimelineRenderer({
  blocks,
  turnId,
  flowId,
  decisionRequestsById,
  planCardsById,
  plansByRevisionId = new Map(),
  onPlanOpen,
  onOrchestrationOpen = () => {},
  onOrchestrationApprove = () => {},
  activity,
  turnTiming,
  showReasoning = true,
  beforeFooter,
  thinkingLabel,
  workspaceRootPath,
  onOpenWorkspaceFile,
  "data-testid": dataTestId,
  "data-transcript-activity": dataActivity,
}: TranscriptTimelineRendererProps) {
  return (
    <TranscriptPathProvider rootPath={workspaceRootPath} onOpenWorkspaceFile={onOpenWorkspaceFile}>
      <div
        data-testid={dataTestId}
        data-transcript-activity={dataActivity}
        data-transcript-anchor-id={turnId}
      >
        <AssistantTurn
          blocks={blocks}
          turnId={turnId}
          flowId={flowId}
          decisionRequestsById={decisionRequestsById}
          planCardsById={planCardsById}
          plansByRevisionId={plansByRevisionId}
          onPlanOpen={onPlanOpen}
          onOrchestrationOpen={onOrchestrationOpen}
          onOrchestrationApprove={onOrchestrationApprove}
          activity={activity}
          turnTiming={turnTiming}
          showReasoning={showReasoning}
          beforeFooter={beforeFooter}
          thinkingLabel={thinkingLabel}
        />
      </div>
    </TranscriptPathProvider>
  );
}

export type { TranscriptBlock, TranscriptActivity, TurnTiming, DecisionRequestCardData, PlanCardState };

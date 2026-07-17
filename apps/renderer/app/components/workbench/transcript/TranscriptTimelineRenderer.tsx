import type { ReactNode } from "react";
import type { DecisionCardData, SpecCardState } from "../../../hooks/useDashboardData";
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
  decisionCardsById: Map<string, DecisionCardData>;
  specCardsById: Map<string, SpecCardState>;
  plansByRevisionId?: Map<string, OrchestrationPlanView>;
  onSpecOpen: (specRevisionId: string, title: string) => void;
  onPlanOpen?: (plan: OrchestrationPlanView) => void;
  onPlanApprove?: (plan: OrchestrationPlanView) => void;
  activity?: TranscriptActivity;
  turnTiming?: TurnTiming | null;
  showReasoning?: boolean;
  beforeFooter?: ReactNode;
  workspaceRootPath?: string | null;
  onOpenWorkspaceFile?: (path: string) => void;
  "data-testid"?: string;
  "data-transcript-activity"?: string;
};

export default function TranscriptTimelineRenderer({
  blocks,
  turnId,
  flowId,
  decisionCardsById,
  specCardsById,
  plansByRevisionId = new Map(),
  onSpecOpen,
  onPlanOpen = () => {},
  onPlanApprove = () => {},
  activity,
  turnTiming,
  showReasoning = true,
  beforeFooter,
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
          decisionCardsById={decisionCardsById}
          specCardsById={specCardsById}
          plansByRevisionId={plansByRevisionId}
          onSpecOpen={onSpecOpen}
          onPlanOpen={onPlanOpen}
          onPlanApprove={onPlanApprove}
          activity={activity}
          turnTiming={turnTiming}
          showReasoning={showReasoning}
          beforeFooter={beforeFooter}
        />
      </div>
    </TranscriptPathProvider>
  );
}

export type { TranscriptBlock, TranscriptActivity, TurnTiming, DecisionCardData, SpecCardState };

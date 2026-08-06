import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { TranscriptBlock } from "./types";
import { presentTool, summarizeToolGroup } from "./toolRegistry";
import ToolRow from "./ToolRow";
import { ReadToolSummary } from "./ReadToolView";
import styles from "./transcript.module.css";
import { useTranscriptScroll } from "./TranscriptScrollContext";
import { useCollapse } from "./useCollapse";
import McpToolIcon from "./McpToolIcon";

type ToolGroupProps = {
  group: Extract<TranscriptBlock, { type: "tool-group" }>;
};

export default function ToolGroup({ group }: ToolGroupProps) {
  const { expanded, toggle: toggleExpanded } = useCollapse(group.id, group.defaultCollapsed);
  const [hasRenderedDetail, setHasRenderedDetail] = useState(expanded);
  const { toggle } = useTranscriptScroll();
  const summary = summarizeToolGroup(group.tools);
  const currentTool = group.currentToolCallId
    ? group.tools.find((tool) => tool.toolCallId === group.currentToolCallId) ?? null
    : null;
  const currentPresentation = currentTool ? presentTool(currentTool) : null;
  const isFinalizedReadOnlyGroup = group.finalized
    && group.tools.length > 0
    && group.tools.every((tool) => {
      const presentation = presentTool(tool);
      return presentation.kind === "read" && Boolean(presentation.read);
    });
  const isSingleActiveRead = !group.finalized
    && group.tools.length === 1
    && currentPresentation?.kind === "read"
    && Boolean(currentPresentation.read);
  const toolRenderKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return group.tools.map((tool) => {
      const identity = tool.toolCallId || tool.toolName || "tool";
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return `${identity}:${occurrence}`;
    });
  }, [group.tools]);

  useEffect(() => {
    if (expanded) setHasRenderedDetail(true);
  }, [expanded]);

  const renderActiveSlotButton = () => {
    if (
      currentPresentation?.kind === "read"
      && currentPresentation.read
      && (group.activeState === "running" || group.activeState === "pinned")
    ) {
      return <ReadToolSummary presentation={currentPresentation} />;
    }

    if (group.activeState === "running" && currentTool?.state === "running" && currentPresentation) {
      return (
        <button
          type="button"
          className={styles.toolSummary}
          onClick={(event) => toggle(event, toggleExpanded)}
          aria-expanded={expanded}
        >
          <span className={styles.rowSpinner} role="status" aria-label="Loading" />
          <span className={styles.toolMain}>
            <span className={styles.toolState}>{currentPresentation.statusLabel}</span>
            <span className={styles.toolCount} title={currentPresentation.title}>{currentPresentation.title}</span>
            <span className={styles.toolName}>{currentPresentation.operationLabel}</span>
          </span>
          <ChevronDown className={styles.chevron} size={14} />
        </button>
      );
    }

    if (group.activeState === "pinned" && currentTool && currentPresentation) {
      return (
        <button
          type="button"
          className={styles.toolSummary}
          onClick={(event) => toggle(event, toggleExpanded)}
          aria-expanded={expanded}
        >
          <span className={styles.rowIcon}>
            {currentPresentation.kind === "mcp"
              ? <McpToolIcon presentation={currentPresentation} size={18} />
              : <Check size={15} aria-hidden="true" />}
          </span>
          <span className={styles.toolMain}>
            <span className={styles.toolState}>{currentPresentation.statusLabel}</span>
            <span className={styles.toolCount} title={currentPresentation.title}>{currentPresentation.title}</span>
            <span className={styles.toolName}>{currentPresentation.operationLabel}</span>
          </span>
          <ChevronDown className={styles.chevron} size={14} />
        </button>
      );
    }

    return (
      <button
        type="button"
        className={styles.toolSummary}
        onClick={(event) => toggle(event, toggleExpanded)}
        aria-expanded={expanded}
      >
        <span className={styles.rowSpinner} role="status" aria-label="Loading" />
        <span className={styles.animatedStatusText} data-text="正在思考">正在思考</span>
        <ChevronDown className={styles.chevron} size={14} />
      </button>
    );
  };

  if (isFinalizedReadOnlyGroup) {
    return (
      <section className={`${styles.activitySlot} ${styles.toolGroup} ${styles.finalized} ${styles.readOnlyToolGroup}`}>
        <div
          className={`${styles.toolGroupDetail} ${group.tools.length > 6 ? styles.scrollableToolGroupDetail : ""}`}
          data-scrollable={group.tools.length > 6 ? "true" : undefined}
        >
          {group.tools.map((tool, index) => (
            <ToolRow key={toolRenderKeys[index]} id={toolRenderKeys[index]} tool={tool} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${styles.activitySlot} ${styles.toolGroup} ${group.finalized ? styles.finalized : ""} ${!expanded ? styles.collapsed : ""}`}
    >
      {group.finalized ? (
        <button
          type="button"
          className={styles.toolGroupSummary}
          onClick={(event) => toggle(event, toggleExpanded)}
          aria-expanded={expanded}
        >
          <span className={styles.traceIcon}>⌁</span>
          <span>{summary}</span>
          <ChevronDown className={styles.chevron} size={14} />
        </button>
      ) : (
        renderActiveSlotButton()
      )}
      {isSingleActiveRead ? null : (
        <div
          className={`${styles.toolGroupDetail} ${group.tools.length > 6 ? styles.scrollableToolGroupDetail : ""}`}
          data-scrollable={group.tools.length > 6 ? "true" : undefined}
          hidden={!expanded}
        >
          {hasRenderedDetail && group.tools.map((tool, index) => (
            <ToolRow key={toolRenderKeys[index]} id={toolRenderKeys[index]} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}

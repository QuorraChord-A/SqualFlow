import { useEffect, useState } from "react";
import { ChevronDown, FileText, Search, Edit3, Terminal, HelpCircle, FileQuestion } from "lucide-react";
import type { TimelineTool, ToolPresentation } from "./types";
import { presentTool } from "./toolRegistry";
import ToolDetail from "./ToolDetail";
import { ReadToolSummary } from "./ReadToolView";
import styles from "./transcript.module.css";
import { useTranscriptScroll } from "./TranscriptScrollContext";
import { useCollapse } from "./useCollapse";
import McpToolIcon from "./McpToolIcon";

const ICONS: Record<ToolPresentation["icon"], React.ComponentType<{ size?: number; className?: string }>> = {
  search: Search,
  file: FileText,
  edit: Edit3,
  terminal: Terminal,
  question: HelpCircle,
  spec: FileQuestion,
  task: FileText,
  agent: FileQuestion,
  message: FileQuestion,
  context: FileQuestion,
  unknown: FileQuestion,
};

type ToolRowProps = {
  id: string;
  tool: TimelineTool;
};

export default function ToolRow({ id, tool }: ToolRowProps) {
  const { expanded, toggle: toggleExpanded } = useCollapse(id, true);
  const [hasRenderedDetail, setHasRenderedDetail] = useState(expanded);
  const { toggle } = useTranscriptScroll();
  const presentation = presentTool(tool);
  const Icon = ICONS[presentation.icon] ?? FileQuestion;
  const isRunning = presentation.status === "running";
  const hasDiff = Boolean(presentation.diff);
  const isRead = presentation.kind === "read" && Boolean(presentation.read);

  useEffect(() => {
    if (expanded) setHasRenderedDetail(true);
  }, [expanded]);

  return (
    <section className={`${styles.toolRun} ${isRead ? styles.readToolRun : ""} ${!isRead && !expanded ? styles.collapsed : ""}`}>
      {isRead ? (
        <ReadToolSummary presentation={presentation} />
      ) : (
        <button
          type="button"
          className={styles.toolSummary}
          onClick={(event) => toggle(event, toggleExpanded)}
          aria-expanded={expanded}
        >
          {isRunning ? (
            <span className={styles.rowSpinner} role="status" aria-label="Loading" />
          ) : (
            <span className={styles.rowIcon}>
              {presentation.kind === "mcp"
                ? <McpToolIcon presentation={presentation} size={18} />
                : <Icon size={15} />}
            </span>
          )}
          <span className={styles.toolMain}>
            <span className={styles.toolState}>{presentation.statusLabel}</span>
            <span className={styles.toolCount} title={presentation.title}>{presentation.title}</span>
            <span className={styles.toolName}>{presentation.operationLabel}</span>
          </span>
          {hasDiff && <ChevronDown className={`${styles.rowArrow} ${expanded ? styles.expanded : ""}`} size={22} />}
        </button>
      )}
      {!isRead ? (
        <div hidden={!expanded}>
          {hasRenderedDetail && <ToolDetail presentation={presentation} />}
        </div>
      ) : null}
    </section>
  );
}

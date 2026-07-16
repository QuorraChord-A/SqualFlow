import { ChevronDown, BrainCircuit } from "lucide-react";
import type { TranscriptBlock } from "./types";
import styles from "./transcript.module.css";
import { useTranscriptScroll } from "./TranscriptScrollContext";
import { useCollapse } from "./useCollapse";

type ReasoningBlockProps = {
  block: Extract<TranscriptBlock, { type: "reasoning" }>;
};

export default function ReasoningBlock({ block }: ReasoningBlockProps) {
  const { expanded, toggle: toggleExpanded } = useCollapse(block.id, block.defaultCollapsed);
  const { toggle } = useTranscriptScroll();

  return (
    <section className={`${styles.reasonBlock} ${!expanded ? styles.collapsed : ""}`}>
      <div className={styles.reasonSummary}>
        <button
          type="button"
          className={styles.traceButton}
          onClick={(event) => toggle(event, toggleExpanded)}
          aria-expanded={expanded}
        >
          <BrainCircuit className={styles.traceIcon} size={18} />
          <span>思考过程</span>
          <ChevronDown className={styles.chevron} size={14} />
        </button>
      </div>
      {expanded && <div className={styles.reasonContent}>{block.text}</div>}
    </section>
  );
}

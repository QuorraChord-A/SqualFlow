import { Loader2 } from "lucide-react";
import styles from "./transcript.module.css";

export default function ThinkingIndicator({ label = "正在思考" }: { label?: string }) {
  return (
    <div className={`${styles.activitySlot} ${styles.thinkingRow}`}>
      <Loader2 className={`${styles.traceIcon} animate-spin`} size={18} />
      <span className={styles.animatedStatusText} data-text={label}>{label}</span>
    </div>
  );
}

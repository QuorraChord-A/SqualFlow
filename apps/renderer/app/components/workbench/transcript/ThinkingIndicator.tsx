import { Loader2 } from "lucide-react";
import styles from "./transcript.module.css";

export default function ThinkingIndicator() {
  return (
    <div className={`${styles.activitySlot} ${styles.thinkingRow}`}>
      <Loader2 className={`${styles.traceIcon} animate-spin`} size={18} />
      <span className={styles.animatedStatusText} data-text="正在思考">正在思考</span>
    </div>
  );
}

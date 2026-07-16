import type { ToolPresentation } from "./types";
import styles from "./transcript.module.css";

function DiffDetail({ oldString, newString }: { oldString: string; newString: string }) {
  const oldLines = oldString === "" ? [] : oldString.split("\n");
  const newLines = newString === "" ? [] : newString.split("\n");
  const rows: Array<{ kind: "add" | "del" | "neutral"; no: string; code: string }> = [];

  oldLines.forEach((line, index) => {
    rows.push({ kind: "del", no: String(index + 1), code: line });
  });
  newLines.forEach((line, index) => {
    rows.push({ kind: "add", no: String(index + 1), code: line });
  });

  if (rows.length === 0) {
    rows.push({ kind: "neutral", no: "", code: "无变更" });
  }

  return (
    <div className={styles.diffCard}>
      {rows.map((row, index) => (
        <div
          key={index}
          className={`${styles.diffRow} ${
            row.kind === "add" ? styles.diffRowAdd : row.kind === "del" ? styles.diffRowDel : styles.diffRowNeutral
          }`}
        >
          <div className={styles.diffLine}>{row.no}</div>
          <div className={styles.diffCode}>{row.code}</div>
        </div>
      ))}
    </div>
  );
}

function ShellDetail({ command, output }: { command?: string; output: unknown }) {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  if (typeof output === "string") {
    stdout = output;
  } else if (output && typeof output === "object" && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    if (typeof obj.content === "string") {
      stdout = obj.content;
    } else {
      stdout = typeof obj.stdout === "string" ? obj.stdout : "";
      stderr = typeof obj.stderr === "string" ? obj.stderr : "";
      exitCode = typeof obj.exit_code === "number" ? obj.exit_code : undefined;
    }
  }

  return (
    <div className={styles.terminalCard}>
      {command && <div>$ {command}</div>}
      {stdout && <div className={styles.terminalMuted}>{stdout}</div>}
      {stderr && <div className={styles.terminalMuted}>{stderr}</div>}
      {exitCode !== undefined && <div className={styles.terminalMuted}>exit {exitCode}</div>}
    </div>
  );
}

type ToolDetailProps = {
  presentation: ToolPresentation;
};

export default function ToolDetail({ presentation }: ToolDetailProps) {
  const input = presentation.rawInput as Record<string, unknown> | null;

  if ((presentation.kind === "edit" || presentation.kind === "write") && presentation.diff) {
    return (
      <div className={styles.toolDetail}>
        <DiffDetail
          oldString={typeof input?.old_string === "string" ? input.old_string : ""}
          newString={presentation.kind === "write"
            ? (typeof input?.content === "string" ? input.content : "")
            : (typeof input?.new_string === "string" ? input.new_string : "")}
        />
      </div>
    );
  }

  if (presentation.kind === "bash") {
    return (
      <div className={styles.toolDetail}>
        <ShellDetail command={presentation.command} output={presentation.rawOutput} />
      </div>
    );
  }

  return (
    <div className={styles.toolDetail}>
      {presentation.detailRows.map((row, index) => (
        <div key={index} className={styles.traceRow}>
          <span className={styles.traceLabel}>{row.label}</span>
          <span className={styles.traceMain}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

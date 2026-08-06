import type { ToolPresentation } from "./types";
import UnifiedDiff, { type UnifiedDiffLine } from "../UnifiedDiff";
import styles from "./transcript.module.css";
import { mcpResultForOutput } from "./mcpToolPresenters";

function DiffDetail({ oldString, newString }: { oldString: string; newString: string }) {
  const oldLines = oldString === "" ? [] : oldString.split("\n");
  const newLines = newString === "" ? [] : newString.split("\n");
  const rows: UnifiedDiffLine[] = [];

  oldLines.forEach((line, index) => {
    rows.push({ kind: "removed", old_line: index + 1, new_line: null, text: line });
  });
  newLines.forEach((line, index) => {
    rows.push({ kind: "added", old_line: null, new_line: index + 1, text: line });
  });

  if (rows.length === 0) {
    rows.push({ kind: "context", old_line: null, new_line: null, text: "无变更" });
  }

  return (
    <div className={styles.diffCard}>
      <UnifiedDiff lines={rows} lineNumbers="single" />
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
    <div className={styles.terminalCard} role="region" aria-label="命令输出" tabIndex={0}>
      {command && <div>$ {command}</div>}
      {stdout && <div className={styles.terminalMuted}>{stdout}</div>}
      {stderr && <div className={styles.terminalMuted}>{stderr}</div>}
      {exitCode !== undefined && <div className={styles.terminalMuted}>exit {exitCode}</div>}
    </div>
  );
}

function McpContentBlock({ block, index }: { block: Record<string, unknown> & { type: string }; index: number }) {
  switch (block.type) {
    case "text":
      return (
        <pre key={index} className={styles.mcpResultText}>
          {typeof block.text === "string" ? block.text : JSON.stringify(block.text ?? "", null, 2)}
        </pre>
      );
    case "image": {
      const data = typeof block.data === "string" ? block.data : "";
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
      return data ? (
        <img
          key={index}
          src={`data:${mimeType};base64,${data}`}
          alt="MCP tool result"
          className={styles.mcpResultImage}
        />
      ) : null;
    }
    case "audio": {
      const data = typeof block.data === "string" ? block.data : "";
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "audio/mpeg";
      return data ? <audio key={index} controls src={`data:${mimeType};base64,${data}`} /> : null;
    }
    case "resource_link":
      return typeof block.uri === "string" ? (
        <a
          key={index}
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          className={styles.mcpResultLink}
        >
          {typeof block.name === "string" && block.name ? block.name : block.uri}
        </a>
      ) : null;
    case "resource": {
      const resource = block.resource;
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) return null;
      const record = resource as Record<string, unknown>;
      if (typeof record.text === "string") {
        return <pre key={index} className={styles.mcpResultText}>{record.text}</pre>;
      }
      return (
        <pre key={index} className={styles.mcpResultText}>
          {JSON.stringify(record, null, 2)}
        </pre>
      );
    }
    default:
      return (
        <pre key={index} className={styles.mcpResultText}>
          {JSON.stringify(block, null, 2)}
        </pre>
      );
  }
}

function McpResultDetail({ presentation }: { presentation: ToolPresentation }) {
  const result = mcpResultForOutput(presentation.rawOutput);
  if (!result) return null;
  const hasStructured = result.structuredContent !== undefined;
  const hasContent = result.content.length > 0;
  if (!hasContent && !hasStructured) return null;

  return (
    <div className={styles.mcpResultCard} data-testid="mcp-result">
      <div className={styles.mcpResultHeader}>
        <span className={styles.mcpResultEyebrow}>Result</span>
        {result.isError ? <span className={styles.mcpResultError}>失败</span> : null}
      </div>
      {result.content.map((block, index) => <McpContentBlock key={index} block={block} index={index} />)}
      {hasStructured ? (
        <details className={styles.mcpStructuredResult}>
          <summary>结构化结果</summary>
          <pre>{JSON.stringify(result.structuredContent, null, 2)}</pre>
        </details>
      ) : null}
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

  if (presentation.kind === "mcp") {
    return (
      <div className={styles.toolDetail}>
        <McpResultDetail presentation={presentation} />
        {presentation.detailRows.map((row, index) => (
          <div key={index} className={styles.traceRow}>
            <span className={styles.traceLabel}>{row.label}</span>
            <span className={styles.traceMain}>{row.value}</span>
          </div>
        ))}
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

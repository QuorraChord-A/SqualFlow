export type UnifiedDiffLine = {
  kind: "context" | "added" | "removed";
  old_line: number | null;
  new_line: number | null;
  text: string;
};

type UnifiedDiffProps = {
  lines: UnifiedDiffLine[];
  lineNumbers?: "split" | "single";
};

function rowClassName(kind: UnifiedDiffLine["kind"]) {
  if (kind === "added") return "bg-emerald-500/15 text-foreground";
  if (kind === "removed") return "bg-red-500/15 text-foreground";
  return "text-muted-foreground";
}

function markerClassName(kind: UnifiedDiffLine["kind"]) {
  if (kind === "added") return "text-emerald-700 dark:text-emerald-400";
  if (kind === "removed") return "text-red-700 dark:text-red-400";
  return "text-muted-foreground";
}

export default function UnifiedDiff({ lines, lineNumbers = "split" }: UnifiedDiffProps) {
  return (
    <div data-line-numbers={lineNumbers} className="min-w-max font-mono text-[12px] leading-6">
      {lines.map((line, index) => {
        const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
        const singleLineNumber = line.kind === "removed" ? line.old_line : line.new_line ?? line.old_line;
        return (
          <div
            key={`${line.old_line ?? ""}:${line.new_line ?? ""}:${index}`}
            data-diff-kind={line.kind}
            className={`grid ${lineNumbers === "split"
              ? "grid-cols-[52px_52px_28px_minmax(0,1fr)]"
              : "grid-cols-[52px_28px_minmax(0,1fr)]"} ${rowClassName(line.kind)}`}
          >
            {lineNumbers === "split" ? (
              <>
                <span data-diff-line-number="old" className="select-none border-r border-border/45 px-2 text-right text-muted-foreground/80">
                  {line.old_line ?? ""}
                </span>
                <span data-diff-line-number="new" className="select-none border-r border-border/45 px-2 text-right text-muted-foreground/80">
                  {line.new_line ?? ""}
                </span>
              </>
            ) : (
              <span data-diff-line-number="single" className="select-none border-r border-border/45 px-2 text-right text-muted-foreground/80">
                {singleLineNumber ?? ""}
              </span>
            )}
            <span className={`select-none px-2 font-semibold ${markerClassName(line.kind)}`}>{marker}</span>
            <code className="whitespace-pre px-2 text-foreground">{line.text || " "}</code>
          </div>
        );
      })}
    </div>
  );
}

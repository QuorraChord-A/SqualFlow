/**
 * Fix nested code fences for correct markdown rendering.
 *
 * CommonMark spec: a closing fence must have "at least as many" backticks
 * as the opening fence. When AI wraps content in ```markdown that itself
 * contains inner ``` blocks, the inner fence prematurely closes the outer.
 *
 * This preprocessor scans the text and increases outer fence backtick count
 * to be strictly greater than any inner fence it contains.
 */
export function fixNestedFences(text: string): string {
    const lines = text.split("\n");

    // Gather all fence lines: { index in lines, backtick count, meta string }
    const fences: { idx: number; len: number; meta: string }[] = [];
    lines.forEach((line, idx) => {
        const m = line.match(/^(`{3,})(.*)/);
        if (m) {
            fences.push({ idx, len: m[1].length, meta: m[2] });
        }
    });

    if (fences.length < 2) {
        return text;
    }

    const first = fences[0];
    const last = fences[fences.length - 1];

    // Only treat first/last as an outer pair when the message is actually
    // wrapped in a code block (first fence is the first non-blank line and
    // last fence is the last non-blank line). Otherwise they are just
    // independent code blocks inside normal markdown and must not be altered.
    const firstNonBlankIdx = lines.findIndex((l) => l.trim() !== "");
    const lastNonBlankIdx =
        lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim() !== "");
    if (first.idx !== firstNonBlankIdx || last.idx !== lastNonBlankIdx) {
        return text;
    }

    // Determine whether there are inner fences between first and last.
    const innerFences = fences.filter((f) => f.idx > first.idx && f.idx < last.idx);

    if (innerFences.length === 0) {
        return text;
    }

    // Compute the maximum inner fence length.
    const maxInner = Math.max(...innerFences.map((f) => f.len));

    // Only rewrite when an inner fence is long enough to close the outer.
    if (maxInner < first.len) {
        return text;
    }

    const newLen = maxInner + 1;
    const newFence = "`".repeat(newLen);

    // Rewrite the outer opening fence (preserve meta).
    lines[first.idx] = newFence + first.meta;
    // Rewrite the outer closing fence.
    lines[last.idx] = newFence;

    return lines.join("\n");
}

/**
 * Unwrap markdown code blocks (```markdown ... ```) so their inner content
 * is rendered as markdown instead of shown as source code.
 *
 * When AI wraps an example markdown document inside a ```markdown fence,
 * users typically want to see the rendered output (headings, tables,
 * code blocks) rather than the raw source inside a code block.
 */
export function unwrapMarkdownCodeBlock(text: string): string {
    const lines = text.split("\n");
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const openMatch = lines[i].match(/^(`{3,})markdown\s*$/);
        if (!openMatch) {
            result.push(lines[i]);
            i++;
            continue;
        }

        const openCount = openMatch[1].length;
        const contentLines: string[] = [];
        let j = i + 1;
        let foundClose = false;

        while (j < lines.length) {
            const closeMatch = lines[j].match(
                new RegExp("^`{" + openCount + ",}\\s*$")
            );
            if (closeMatch) {
                foundClose = true;
                break;
            }
            contentLines.push(lines[j]);
            j++;
        }

        if (foundClose) {
            // Unwrap: emit inner content directly so it renders as markdown.
            result.push(...contentLines);
            i = j + 1;
        } else {
            // No matching close fence – keep the line as-is.
            result.push(lines[i]);
            i++;
        }
    }

    return result.join("\n");
}

/** Combined pipeline: fix nested fences then unwrap markdown blocks. */
export function processMarkdown(text: string): string {
    return unwrapMarkdownCodeBlock(fixNestedFences(text));
}

/**
 * Extract fully-closed mermaid code blocks from markdown text.
 *
 * Returns closed mermaid blocks (stable, no longer changing) and the
 * remaining text (still being streamed).  Used to render finished
 * mermaid diagrams with stable React keys so their DOM / panzoom
 * state survives streaming updates.
 */
export function extractClosedMermaidBlocks(text: string): {
    blocks: string[];
    remaining: string;
    segments: Array<{ type: "text" | "mermaid"; content: string }>;
} {
    const lines = text.split("\n");
    const blocks: string[] = [];
    const segments: Array<{ type: "text" | "mermaid"; content: string }> = [];
    const remainingLines: string[] = [];
    let textBuf: string[] = [];
    let currentFenceLines: string[] = [];
    let inFence = false;
    let fenceOpenTicks = "";
    let fenceLang = "";

    function flushTextBuf() {
        if (textBuf.length > 0) {
            const txt = textBuf.join("\n");
            remainingLines.push(...textBuf);
            segments.push({ type: "text", content: txt });
            textBuf = [];
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^(\`{3,})(.*)/);

        if (!match) {
            if (inFence) {
                currentFenceLines.push(line);
            } else {
                textBuf.push(line);
            }
            continue;
        }

        const ticks = match[1];
        const meta = match[2].trim();

        if (inFence) {
            currentFenceLines.push(line);
            if (ticks.length >= fenceOpenTicks.length) {
                // Fence closed
                if (fenceLang === "mermaid") {
                    const mermaidContent = currentFenceLines.join("\n");
                    blocks.push(mermaidContent);
                    flushTextBuf();
                    segments.push({ type: "mermaid", content: mermaidContent });
                } else {
                    textBuf.push(...currentFenceLines);
                }
                currentFenceLines = [];
                inFence = false;
                fenceOpenTicks = "";
                fenceLang = "";
            }
        } else {
            inFence = true;
            fenceOpenTicks = ticks;
            fenceLang = meta;
            currentFenceLines.push(line);
        }
    }

    // Unclosed fence + trailing text go into remaining
    if (currentFenceLines.length > 0) {
        textBuf.push(...currentFenceLines);
    }
    flushTextBuf();

    return {
        blocks,
        remaining: remainingLines.join("\n"),
        segments,
    };
}

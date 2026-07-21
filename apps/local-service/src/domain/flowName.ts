export const FLOW_NAME_MAX_LENGTH = 10;

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

export function normalizeFlowName(value: string, fallback = "新任务"): string {
  const normalized = value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  const selected = normalized || fallback;
  return graphemes(selected).slice(0, FLOW_NAME_MAX_LENGTH).join("");
}

export function flowNameFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  return normalizeFlowName(firstLine);
}

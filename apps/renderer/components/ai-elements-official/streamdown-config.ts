import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { defaultRemarkPlugins } from "streamdown";
import type { ControlsConfig, PluginConfig, StreamdownTranslations } from "streamdown";

const code = createCodePlugin({
  themes: ["github-light", "github-dark"],
});
const math = createMathPlugin({ singleDollarTextMath: true });

export const streamdownPlugins: PluginConfig = { cjk, code, math, mermaid };

type MarkdownTree = {
  type?: string;
  lang?: string | null;
  value?: string;
  children?: MarkdownTree[];
};

function walkMarkdownTree(node: MarkdownTree, visitCode: (node: MarkdownTree) => void) {
  if (node.type === "code") visitCode(node);
  for (const child of node.children ?? []) walkMarkdownTree(child, visitCode);
}

function inferCodeLanguage(value: string) {
  const codeValue = value.trim();
  if (!codeValue) return undefined;
  if (/^(\{|\[)/.test(codeValue)) return "json";
  if (/^<!doctype html|<html[\s>]|<\/[a-z][\w-]*>/i.test(codeValue)) return "html";
  if (/^\s*#include\s+[<"]/.test(codeValue)) return "c";
  if (/\b(public\s+class|System\.out\.println|public\s+static\s+void\s+main)\b/.test(codeValue)) return "java";
  if (/\b(package\s+main|func\s+main\s*\(|fmt\.Println)\b/.test(codeValue)) return "go";
  if (/\b(fn\s+main\s*\(|println!\s*\()/m.test(codeValue)) return "rust";
  if (/\b(def\s+\w+\s*\(|print\s*\(|import\s+\w+)/.test(codeValue)) return "python";
  if (/\b(interface|type\s+\w+\s*=|:\s*(string|number|boolean)\b)/.test(codeValue)) return "typescript";
  if (/\b(console\.log|function\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|=>)\b/.test(codeValue)) return "javascript";
  if (/^\s*[:.#@a-z-][^{\n]*\{[\s\S]*\}/i.test(codeValue)) return "css";
  if (/^#!\/|^\s*(echo|cd|ls|mkdir|npm|pnpm|yarn|python|node)\s/m.test(codeValue)) return "bash";
  return undefined;
}

const inferCodeLanguagePlugin = () => (tree: MarkdownTree) => {
  walkMarkdownTree(tree, (node) => {
    if (node.lang || !node.value) return;
    const language = inferCodeLanguage(node.value);
    if (language) node.lang = language;
  });
};

export const streamdownRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  inferCodeLanguagePlugin,
];

export const chatMarkdownControls: ControlsConfig = {
  table: { copy: true, download: false, fullscreen: false },
  code: { copy: true, download: false },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};

export const streamdownTranslations: Partial<StreamdownTranslations> = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制代码",
  copyLink: "复制链接",
  copyTable: "复制表格",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsTsv: "复制为 TSV",
  downloadFile: "下载文件",
  downloadImage: "下载图片",
  externalLinkWarning: "即将在系统浏览器中打开外部网站。",
  imageNotAvailable: "图片无法显示",
  openExternalLink: "打开外部链接？",
  openLink: "打开链接",
  viewFullscreen: "全屏查看",
};

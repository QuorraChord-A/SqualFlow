import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { c, cpp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function fileExtension(filePath: string) {
  const fileName = filePath.replaceAll("\\", "/").split("/").at(-1) ?? filePath;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
}

export function isMarkdownFile(filePath: string) {
  const extension = fileExtension(filePath);
  return extension === "md" || extension === "mdx";
}

export function languageFromFilePath(filePath: string) {
  return LANGUAGE_BY_EXTENSION[fileExtension(filePath)];
}

export function codeLanguageExtension(language: string): Extension[] {
  switch (language) {
    case "bash":
    case "shell":
      return [StreamLanguage.define(shell)];
    case "c":
      return [StreamLanguage.define(c)];
    case "cpp":
      return [StreamLanguage.define(cpp)];
    case "css":
      return [css()];
    case "go":
      return [StreamLanguage.define(go)];
    case "html":
    case "xml":
    case "vue":
      return [html()];
    case "java":
      return [StreamLanguage.define(java)];
    case "javascript":
    case "jsx":
      return [javascript({ jsx: language === "jsx" })];
    case "json":
      return [json()];
    case "kotlin":
      return [StreamLanguage.define(kotlin)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "markdown":
      return [markdown()];
    case "php":
      return [php({ plain: true })];
    case "python":
      return [python()];
    case "r":
      return [StreamLanguage.define(r)];
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "rust":
      return [StreamLanguage.define(rust)];
    case "sql":
      return [sql()];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "typescript":
      return [javascript({ typescript: true })];
    case "yaml":
      return [StreamLanguage.define(yaml)];
    default:
      return [];
  }
}

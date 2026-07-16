"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import angularIcon from "@iconify-icons/devicon/angular";
import astroIcon from "@iconify-icons/devicon/astro";
import bashIcon from "@iconify-icons/devicon/bash";
import cIcon from "@iconify-icons/devicon/c";
import clojureIcon from "@iconify-icons/devicon/clojure";
import cppIcon from "@iconify-icons/devicon/cplusplus";
import csharpIcon from "@iconify-icons/devicon/csharp";
import cssIcon from "@iconify-icons/devicon/css3";
import dartIcon from "@iconify-icons/devicon/dart";
import dockerIcon from "@iconify-icons/devicon/docker";
import elixirIcon from "@iconify-icons/devicon/elixir";
import erlangIcon from "@iconify-icons/devicon/erlang";
import fsharpIcon from "@iconify-icons/devicon/fsharp";
import goIcon from "@iconify-icons/devicon/go";
import groovyIcon from "@iconify-icons/devicon/groovy";
import haskellIcon from "@iconify-icons/devicon/haskell";
import htmlIcon from "@iconify-icons/devicon/html5";
import javaIcon from "@iconify-icons/devicon/java";
import javascriptIcon from "@iconify-icons/devicon/javascript";
import jsonIcon from "@iconify-icons/devicon/json";
import kotlinIcon from "@iconify-icons/devicon/kotlin";
import luaIcon from "@iconify-icons/devicon/lua";
import matlabIcon from "@iconify-icons/devicon/matlab";
import perlIcon from "@iconify-icons/devicon/perl";
import phpIcon from "@iconify-icons/devicon/php";
import pythonIcon from "@iconify-icons/devicon/python";
import rIcon from "@iconify-icons/devicon/r";
import reactIcon from "@iconify-icons/devicon/react";
import rubyIcon from "@iconify-icons/devicon/ruby";
import rustIcon from "@iconify-icons/devicon-plain/rust";
import sassIcon from "@iconify-icons/devicon/sass";
import scalaIcon from "@iconify-icons/devicon/scala";
import solidityIcon from "@iconify-icons/devicon/solidity";
import svelteIcon from "@iconify-icons/devicon/svelte";
import swiftIcon from "@iconify-icons/devicon/swift";
import terraformIcon from "@iconify-icons/devicon/terraform";
import typescriptIcon from "@iconify-icons/devicon/typescript";
import vueIcon from "@iconify-icons/devicon/vuejs";
import xmlIcon from "@iconify-icons/devicon/xml";
import yamlIcon from "@iconify-icons/devicon/yaml";
import zigIcon from "@iconify-icons/devicon/zig";
import { Check, Copy, FileCode2, FileText, Info } from "lucide-react";
import type { ToolPresentation } from "./types";
import styles from "./transcript.module.css";
import {
  displayPathForWorkspace,
  useOpenTranscriptWorkspaceFile,
  useTranscriptWorkspaceRoot,
} from "./TranscriptPathContext";

const ICON_BY_EXTENSION: Record<string, typeof pythonIcon> = {
  astro: astroIcon,
  c: cIcon,
  cc: cppIcon,
  cpp: cppIcon,
  cxx: cppIcon,
  cs: csharpIcon,
  css: cssIcon,
  dart: dartIcon,
  edn: clojureIcon,
  erl: erlangIcon,
  ex: elixirIcon,
  exs: elixirIcon,
  fs: fsharpIcon,
  fsx: fsharpIcon,
  go: goIcon,
  gradle: groovyIcon,
  groovy: groovyIcon,
  h: cIcon,
  hs: haskellIcon,
  hpp: cppIcon,
  hrl: erlangIcon,
  hxx: cppIcon,
  htm: htmlIcon,
  html: htmlIcon,
  java: javaIcon,
  js: javascriptIcon,
  jsx: reactIcon,
  json: jsonIcon,
  jsonc: jsonIcon,
  kt: kotlinIcon,
  kts: kotlinIcon,
  lua: luaIcon,
  m: matlabIcon,
  mjs: javascriptIcon,
  cjs: javascriptIcon,
  pl: perlIcon,
  pm: perlIcon,
  php: phpIcon,
  py: pythonIcon,
  pyw: pythonIcon,
  r: rIcon,
  rb: rubyIcon,
  rs: rustIcon,
  sass: sassIcon,
  scala: scalaIcon,
  scss: sassIcon,
  sh: bashIcon,
  bash: bashIcon,
  fish: bashIcon,
  zsh: bashIcon,
  sol: solidityIcon,
  svelte: svelteIcon,
  swift: swiftIcon,
  tf: terraformIcon,
  tfvars: terraformIcon,
  ts: typescriptIcon,
  tsx: reactIcon,
  vue: vueIcon,
  xml: xmlIcon,
  yaml: yamlIcon,
  yml: yamlIcon,
  zig: zigIcon,
};

function iconForFile(path: string) {
  const fileName = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) return dockerIcon;
  if (fileName === "angular.json") return angularIcon;
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return ICON_BY_EXTENSION[extension] ?? null;
}

function isTextFile(path: string): boolean {
  const fileName = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return ["md", "mdx", "text", "toml", "txt"].includes(extension);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the local document copy path.
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

function FailureReason({ reason }: { reason: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const reasonId = useId();

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <span className={styles.readFailureWrap}>
      <button type="button" className={styles.readFailureTrigger} aria-describedby={reasonId}>
        执行失败
      </button>
      <span id={reasonId} role="tooltip" className={styles.readFailurePopover}>
        <span className={styles.readFailureReason}>{reason}</span>
        <button
          type="button"
          className={styles.readFailureCopy}
          onClick={() => void copyText(reason).then((copied) => setCopyState(copied ? "copied" : "failed"))}
          aria-label={copyState === "copied" ? "已复制失败原因" : "复制失败原因"}
          title={copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制失败原因"}
        >
          {copyState === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>
      </span>
    </span>
  );
}

function ReadRowContents({
  presentation,
  pathLabel,
}: {
  presentation: ToolPresentation;
  pathLabel: string;
}) {
  const read = presentation.read!;
  const isRunning = presentation.status === "queued" || presentation.status === "running";
  const isFailure = Boolean(read.error)
    || presentation.status === "failed"
    || presentation.status === "denied"
    || presentation.status === "interrupted";
  const lineCount = read.totalLines ?? read.returnedLineCount;
  const statusLabel = isFailure ? "已读取" : isRunning ? presentation.statusLabel : "已读取";
  const fileIcon = iconForFile(read.path);
  let trailing: ReactNode = null;
  if (isFailure) {
    trailing = <FailureReason reason={read.error ?? "读取文件失败"} />;
  } else if (typeof lineCount === "number") {
    trailing = <span className={styles.readToolLineCount}>{Math.trunc(lineCount)} 行</span>;
  }

  return (
    <>
      <span className={styles.toolState}>{statusLabel}</span>
      <span className={styles.readToolFileIcon} aria-hidden="true" data-testid="read-file-icon">
        {isRunning ? (
          <span className={styles.rowSpinner} role="status" aria-label="正在读取" />
        ) : isFailure ? (
          <Info size={17} />
        ) : fileIcon ? (
          <Icon icon={fileIcon} width={19} height={19} />
        ) : isTextFile(read.path) ? (
          <FileText size={17} />
        ) : (
          <FileCode2 size={17} />
        )}
      </span>
      <span className={styles.readToolFileName} title={presentation.title}>{presentation.title}</span>
      <span className={styles.readToolParentPath} title={pathLabel}>{pathLabel}</span>
      <span className={styles.readToolTrailing}>{trailing}</span>
    </>
  );
}

export function ReadToolSummary({ presentation }: { presentation: ToolPresentation }) {
  const read = presentation.read;
  const workspaceRootPath = useTranscriptWorkspaceRoot();
  const openWorkspaceFile = useOpenTranscriptWorkspaceFile();
  if (!read) return null;

  const displayPath = displayPathForWorkspace(read.path, workspaceRootPath);
  const isFailure = Boolean(read.error)
    || presentation.status === "failed"
    || presentation.status === "denied"
    || presentation.status === "interrupted";
  const isRunning = presentation.status === "queued" || presentation.status === "running";
  const canOpen = !isFailure && !isRunning && Boolean(openWorkspaceFile && displayPath.workspaceFilePath);
  const rowContents = (
    <ReadRowContents presentation={presentation} pathLabel={displayPath.compactParentPath} />
  );

  if (canOpen) {
    return (
      <button
        type="button"
        className={`${styles.toolSummary} ${styles.readToolSummary} ${styles.readToolOpenButton}`}
        onClick={() => openWorkspaceFile!(displayPath.workspaceFilePath!)}
        aria-label={`已读取 ${displayPath.displayPath || presentation.title}，在右侧打开文件`}
      >
        {rowContents}
      </button>
    );
  }

  return (
    <div className={`${styles.toolSummary} ${styles.readToolSummary}`}>
      {rowContents}
    </div>
  );
}

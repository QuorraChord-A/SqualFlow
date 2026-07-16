"use client";

import { createContext, useContext, type ReactNode } from "react";

const TranscriptWorkspaceRootContext = createContext<string | null>(null);
const TranscriptOpenWorkspaceFileContext = createContext<((path: string) => void) | null>(null);

function normalizeForDisplay(path: string): string {
  return path.replaceAll("\\", "/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || /^[a-zA-Z]:\//u.test(path);
}

function isWindowsDrivePath(path: string): boolean {
  return /^[a-zA-Z]:\//u.test(path);
}

function parentBreadcrumb(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) return "";
  return path
    .slice(0, separatorIndex)
    .split("/")
    .filter(Boolean)
    .join(" / ");
}

function compactParentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) return "";
  return `${path.slice(0, separatorIndex)}/`;
}

export function displayPathForWorkspace(rawPath: string, workspaceRootPath: string | null) {
  const normalizedPath = normalizeForDisplay(rawPath);
  const normalizedRoot = workspaceRootPath
    ? normalizeForDisplay(workspaceRootPath).replace(/\/+$/u, "")
    : "";

  let displayPath = normalizedPath;
  if (normalizedRoot && isAbsolutePath(normalizedPath)) {
    const caseInsensitive = isWindowsDrivePath(normalizedPath) && isWindowsDrivePath(normalizedRoot);
    const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;

    if (comparablePath === comparableRoot) {
      displayPath = ".";
    } else if (comparablePath.startsWith(`${comparableRoot}/`)) {
      displayPath = normalizedPath.slice(normalizedRoot.length + 1);
    }
  }

  return {
    copyPath: rawPath,
    displayPath,
    parentPath: parentBreadcrumb(displayPath),
    compactParentPath: compactParentPath(displayPath),
    workspaceFilePath: isAbsolutePath(displayPath) ? null : displayPath,
  };
}

export function TranscriptPathProvider({
  children,
  onOpenWorkspaceFile,
  rootPath,
}: {
  children: ReactNode;
  onOpenWorkspaceFile?: (path: string) => void;
  rootPath?: string | null;
}) {
  return (
    <TranscriptWorkspaceRootContext.Provider value={rootPath ?? null}>
      <TranscriptOpenWorkspaceFileContext.Provider value={onOpenWorkspaceFile ?? null}>
        {children}
      </TranscriptOpenWorkspaceFileContext.Provider>
    </TranscriptWorkspaceRootContext.Provider>
  );
}

export function useTranscriptWorkspaceRoot(): string | null {
  return useContext(TranscriptWorkspaceRootContext);
}

export function useOpenTranscriptWorkspaceFile(): ((path: string) => void) | null {
  return useContext(TranscriptOpenWorkspaceFileContext);
}

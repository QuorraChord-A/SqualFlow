import fs from "node:fs";
import path from "node:path";
import {
  hasRuntimeCapability,
  hasWriteRuntimeCapability,
  isRuntimeCapability,
  type RuntimeCapability,
  type RuntimeToolInput,
} from "../domain/runtimeCapabilities.js";

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; requiresConfirmation?: boolean };

export type CheckPermissionArgs = {
  toolName: string;
  capability?: RuntimeCapability | null;
  input: RuntimeToolInput;
  providerInput?: Record<string, unknown>;
  cwd: string;
  readableDirs: readonly string[];
  writableDirs: readonly string[];
  allowReadOutsideDirs?: boolean;
  authorizedTools: ReadonlySet<string> | readonly string[];
  authorizedCapabilities?: ReadonlySet<RuntimeCapability> | readonly RuntimeCapability[];
  riskMode?: "auto_edit" | "full_access";
  npmRegistry?: string;
  packageInstallTimeoutMs?: number;
};

const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const DEFAULT_PACKAGE_INSTALL_TIMEOUT_MS = 120_000;

const proxyEnvNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "npm_config_proxy",
  "npm_config_https_proxy",
] as const;

const proxyEnvNameSet = new Set<string>(proxyEnvNames);

const internalTools = new Set([
  "Task",
  "Skill",
  "EnterPlanMode",
  "ListMcpResources",
  "ReadMcpResource",
  "LSP",
  "TodoWrite",
  "TodoRead",
  "SandboxNetworkAccess",
]);

type ShellToken =
  | { kind: "word"; value: string; start: number; end: number }
  | { kind: "operator"; value: string; start: number; end: number };
type ShellWord = Extract<ShellToken, { kind: "word" }>;

const installSubcommands = new Set(["install", "i", "ci", "add", "update"]);
const npmSubcommands = new Set([...installSubcommands, "exec"]);
const pnpmSubcommands = new Set([...installSubcommands, "dlx"]);
const yarnSubcommands = new Set(["install", "add", "upgrade", "dlx"]);
const bunSubcommands = new Set(["install", "add", "update"]);
const shellCommands = new Set(["bash", "sh", "zsh"]);
const packageOptionsWithValues = new Set([
  "--cache",
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--globalconfig",
  "--prefix",
  "--registry",
  "--userconfig",
  "--workspace",
]);
const packageShortOptionsWithValues = new Set(["-C", "-c", "-F", "-w"]);
const envOptionsWithValues = new Set(["--block-signal", "--chdir", "--default-signal", "--ignore-signal", "--split-string", "--unset", "-C", "-S", "-u"]);
const timeOptionsWithValues = new Set(["--format", "--output", "-f", "-o"]);
const xargsOptionsWithValues = new Set([
  "--arg-file",
  "--delimiter",
  "--eof",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--process-slot-var",
  "--replace",
  "-E",
  "-I",
  "-J",
  "-L",
  "-P",
  "-R",
  "-S",
  "-a",
  "-d",
  "-e",
  "-i",
  "-l",
  "-n",
  "-s",
]);

function hasAuthorizedTool(authorizedTools: CheckPermissionArgs["authorizedTools"], toolName: string): boolean {
  if (Array.isArray(authorizedTools)) {
    return authorizedTools.includes(toolName);
  }
  return (authorizedTools as ReadonlySet<string>).has(toolName);
}

function hasAuthorizedCapability(
  authorizedCapabilities: CheckPermissionArgs["authorizedCapabilities"] | undefined,
  authorizedTools: CheckPermissionArgs["authorizedTools"],
  capability: RuntimeCapability,
): boolean {
  if (authorizedCapabilities) return hasRuntimeCapability(authorizedCapabilities, capability);
  const values = Array.isArray(authorizedTools) ? authorizedTools : [...authorizedTools as ReadonlySet<string>];
  return values.some((value) => isRuntimeCapability(value) && value === capability);
}

function requestCapability(toolName: string, capability: RuntimeCapability | null | undefined): RuntimeCapability | null {
  if (capability !== undefined) return capability;
  if (isRuntimeCapability(toolName)) return toolName;
  return null;
}

function inputPath(input: RuntimeToolInput): string | null {
  return typeof input.path === "string" && input.path.length > 0 ? input.path : null;
}

function realpathOrResolved(resolvedPath: string): string {
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    // Continue below: writes often target files that do not exist yet.
  }

  const missingTail: string[] = [];
  let cursor = resolvedPath;

  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return resolvedPath;
    }

    missingTail.unshift(path.basename(cursor));
    cursor = parent;

    try {
      return path.join(fs.realpathSync.native(cursor), ...missingTail);
    } catch {
      // Keep walking toward an existing ancestor, matching Python realpath(abspath).
    }
  }
}

export function resolveInputPath(cwd: string, inputPath: string): string {
  return realpathOrResolved(path.resolve(cwd, inputPath));
}

function isInsideResolvedDir(resolvedPath: string, allowedDir: string): boolean {
  if (allowedDir.length === 0) {
    return false;
  }

  const resolvedDir = realpathOrResolved(path.resolve(allowedDir));
  return resolvedPath === resolvedDir || resolvedPath.startsWith(`${resolvedDir}${path.sep}`);
}

export function isInsideAnyDir(resolvedPath: string, allowedDirs: readonly string[]): boolean {
  return allowedDirs.some((dir) => isInsideResolvedDir(resolvedPath, dir));
}

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;

  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i] ?? "")) {
      i += 1;
    }
    if (i >= command.length) {
      break;
    }

    const start = i;
    const char = command[i];
    const next = command[i + 1];

    if (char === "#") {
      break;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      tokens.push({ kind: "operator", value: `${char}${next}`, start, end: i + 2 });
      i += 2;
      continue;
    }
    const redirectionPrefix = command.slice(i).match(/^(?:\d?>{1,2}|&>{1,2})/u)?.[0];
    if (redirectionPrefix) {
      tokens.push({ kind: "word", value: redirectionPrefix, start, end: i + redirectionPrefix.length });
      i += redirectionPrefix.length;
      continue;
    }
    if (char === ";" || char === "|") {
      tokens.push({ kind: "operator", value: char, start, end: i + 1 });
      i += 1;
      continue;
    }

    let value = "";
    while (i < command.length) {
      const wordChar = command[i];

      if (wordChar === "'" || wordChar === "\"") {
        const quote = wordChar;
        i += 1;
        while (i < command.length) {
          const quotedChar = command[i];
          if (quotedChar === quote) {
            i += 1;
            break;
          }
          if (quote === "\"" && quotedChar === "\\" && i + 1 < command.length) {
            value += command[i + 1];
            i += 2;
            continue;
          }
          value += quotedChar;
          i += 1;
        }
        continue;
      }

      if (wordChar === "\\") {
        if (i + 1 < command.length) {
          value += command[i + 1];
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }

      if (/\s/.test(wordChar) || wordChar === ";" || wordChar === "|" || wordChar === ">") {
        break;
      }
      if (wordChar === "&" && command[i + 1] === "&") {
        break;
      }
      value += wordChar;
      i += 1;
    }

    tokens.push({ kind: "word", value, start, end: i });
  }

  return tokens;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function envAssignmentName(value: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value);
  return match?.[1] ?? null;
}

function commandName(value: string): string {
  return path.basename(value);
}

function skipPackageOptions(words: readonly ShellWord[], index: number): number {
  let current = index;
  while (current < words.length) {
    const word = words[current]?.value ?? "";
    if (word === "--") {
      current += 1;
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      current += packageOptionsWithValues.has(option) && !word.includes("=") ? 2 : 1;
      continue;
    }
    if (/^-[^-]/.test(word)) {
      current += packageShortOptionsWithValues.has(word) ? 2 : 1;
      continue;
    }
    break;
  }
  return current;
}

function isPackageCommandAt(words: readonly ShellWord[], index: number): boolean {
  const command = commandName(words[index]?.value ?? "");

  if (command === "npx" || command === "bunx") {
    return true;
  }
  const subcommand = words[skipPackageOptions(words, index + 1)]?.value;
  if (command === "npm") {
    return subcommand !== undefined && npmSubcommands.has(subcommand);
  }
  if (command === "pnpm") {
    return subcommand !== undefined && pnpmSubcommands.has(subcommand);
  }
  if (command === "yarn") {
    return subcommand !== undefined && yarnSubcommands.has(subcommand);
  }
  if (command === "bun") {
    return subcommand !== undefined && bunSubcommands.has(subcommand);
  }
  return false;
}

function wordsContainShellPackageInstall(words: readonly ShellWord[], commandIndex: number): boolean {
  const shell = commandName(words[commandIndex]?.value ?? "");
  if (!shellCommands.has(shell)) {
    return false;
  }

  for (let i = commandIndex + 1; i < words.length; i += 1) {
    const word = words[i]?.value ?? "";
    if (!word.startsWith("-")) {
      continue;
    }
    if (word.includes("c") && words[i + 1]?.value) {
      return isPackageInstallCommand(words[i + 1].value);
    }
  }
  return false;
}

function skipEnvWrapperPrefix(words: readonly ShellWord[], index: number): number {
  let current = index;
  while (current < words.length) {
    const word = words[current]?.value ?? "";
    if (isEnvAssignment(word)) {
      current += 1;
      continue;
    }
    if (word === "--") {
      current += 1;
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      current += envOptionsWithValues.has(option) && !word.includes("=") ? 2 : 1;
      continue;
    }
    if (/^-[^-]/.test(word)) {
      current += envOptionsWithValues.has(word) ? 2 : 1;
      continue;
    }
    break;
  }
  return current;
}

function skipSimpleWrapperOptions(words: readonly ShellWord[], index: number, optionsWithValues: ReadonlySet<string>): number {
  let current = index;
  while (current < words.length) {
    const word = words[current]?.value ?? "";
    if (word === "--") {
      current += 1;
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      current += optionsWithValues.has(option) && !word.includes("=") ? 2 : 1;
      continue;
    }
    if (/^-[^-]/.test(word)) {
      current += optionsWithValues.has(word) ? 2 : 1;
      continue;
    }
    break;
  }
  return current;
}

function packageCommandIndexFrom(words: readonly ShellWord[], startIndex: number, depth = 0): number | null {
  if (depth > 8) {
    return null;
  }

  let index = startIndex;
  while (index < words.length && isEnvAssignment(words[index]?.value ?? "")) {
    index += 1;
  }
  if (index >= words.length) {
    return null;
  }
  if (isPackageCommandAt(words, index) || wordsContainShellPackageInstall(words, index)) {
    return index;
  }

  const command = commandName(words[index]?.value ?? "");
  if (command === "env") {
    return packageCommandIndexFrom(words, skipEnvWrapperPrefix(words, index + 1), depth + 1);
  }
  if (command === "time") {
    return packageCommandIndexFrom(words, skipSimpleWrapperOptions(words, index + 1, timeOptionsWithValues), depth + 1);
  }
  if (command === "command") {
    return packageCommandIndexFrom(words, skipSimpleWrapperOptions(words, index + 1, new Set()), depth + 1);
  }

  return null;
}

function packageCommandIndex(words: readonly ShellWord[]): number | null {
  return packageCommandIndexFrom(words, 0);
}

function commandSegments(tokens: readonly ShellToken[]): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let current: ShellWord[] = [];

  for (const token of tokens) {
    if (token.kind === "operator") {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function isWritablePathTarget(value: string): boolean {
  return value.length > 0 && value !== "-" && !value.startsWith("&") && value !== "/dev/null";
}

function resolveShellPath(currentCwd: string, value: string): string | null {
  if (!isWritablePathTarget(value)) {
    return null;
  }
  if (value.includes("*") || value.includes("?") || value.includes("$") || value.includes("`")) {
    return null;
  }
  return resolveInputPath(currentCwd, value);
}

function isProtectedReadOnlyWrite(resolvedPath: string, protectedRoots: readonly string[], writableDirs: readonly string[]): boolean {
  return isInsideAnyDir(resolvedPath, protectedRoots) && !isInsideAnyDir(resolvedPath, writableDirs);
}

function targetViolatesReadOnlyMode(
  currentCwd: string,
  value: string,
  protectedRoots: readonly string[],
  writableDirs: readonly string[],
): boolean {
  const resolvedPath = resolveShellPath(currentCwd, value);
  return resolvedPath ? isProtectedReadOnlyWrite(resolvedPath, protectedRoots, writableDirs) : false;
}

function redirectionTarget(words: readonly ShellWord[], index: number): string | null {
  const value = words[index]?.value ?? "";
  if (/^(?:\d?>{1,2}|&>{1,2})$/.test(value)) {
    return words[index + 1]?.value ?? null;
  }

  const match = /^(?:\d?>{1,2}|&>{1,2})(.+)$/.exec(value);
  return match?.[1] ?? null;
}

function commandStartIndex(words: readonly ShellWord[]): number {
  let index = 0;
  while (index < words.length && isEnvAssignment(words[index]?.value ?? "")) {
    index += 1;
  }
  return index;
}

function nonOptionOperands(words: readonly ShellWord[], startIndex: number): string[] {
  const operands: string[] = [];
  let afterOptionTerminator = false;
  for (const word of words.slice(startIndex)) {
    if (!afterOptionTerminator && word.value === "--") {
      afterOptionTerminator = true;
      continue;
    }
    if (!afterOptionTerminator && word.value.startsWith("-")) {
      continue;
    }
    operands.push(word.value);
  }
  return operands;
}

function segmentViolatesReadOnlyMode(
  currentCwd: string,
  words: readonly ShellWord[],
  protectedRoots: readonly string[],
  writableDirs: readonly string[],
): boolean {
  for (let i = 0; i < words.length; i += 1) {
    const target = redirectionTarget(words, i);
    if (target && targetViolatesReadOnlyMode(currentCwd, target, protectedRoots, writableDirs)) {
      return true;
    }
  }

  const commandIndex = commandStartIndex(words);
  const command = commandName(words[commandIndex]?.value ?? "");
  if (!command) {
    return false;
  }

  if (command === "tee") {
    return nonOptionOperands(words, commandIndex + 1).some((target) =>
      targetViolatesReadOnlyMode(currentCwd, target, protectedRoots, writableDirs),
    );
  }

  if (command === "sed" && words.some((word) => /^-i(?:$|[^A-Za-z])/.test(word.value))) {
    const operands = nonOptionOperands(words, commandIndex + 1);
    return operands.slice(1).some((target) =>
      targetViolatesReadOnlyMode(currentCwd, target, protectedRoots, writableDirs),
    );
  }

  if (command === "rm" || command === "mv" || command === "cp") {
    return nonOptionOperands(words, commandIndex + 1).some((target) =>
      targetViolatesReadOnlyMode(currentCwd, target, protectedRoots, writableDirs),
    );
  }

  return false;
}

function updateCwdFromCdSegment(currentCwd: string, words: readonly ShellWord[]): string {
  const commandIndex = commandStartIndex(words);
  if (commandName(words[commandIndex]?.value ?? "") !== "cd") {
    return currentCwd;
  }

  const target = words[commandIndex + 1]?.value;
  if (!target || target === "-") {
    return currentCwd;
  }

  return resolveInputPath(currentCwd, target);
}

function bashViolatesReadOnlyProjectMode(
  command: string,
  cwd: string,
  readableDirs: readonly string[],
  writableDirs: readonly string[],
): boolean {
  const protectedRoots = [cwd, ...readableDirs].filter((dir) => {
    const resolvedDir = resolveInputPath(cwd, dir);
    return !isInsideAnyDir(resolvedDir, writableDirs);
  });
  if (protectedRoots.length === 0) {
    return false;
  }

  let currentCwd = resolveInputPath(cwd, ".");
  for (const segment of commandSegments(tokenizeShellCommand(command))) {
    if (segmentViolatesReadOnlyMode(currentCwd, segment, protectedRoots, writableDirs)) {
      return true;
    }
    currentCwd = updateCwdFromCdSegment(currentCwd, segment);
  }
  return false;
}

function packageWorkingDirectory(cwd: string, words: readonly ShellWord[], commandIndex: number): string | null {
  for (let index = commandIndex + 1; index < words.length; index += 1) {
    const value = words[index]?.value ?? "";
    if (value === "--") break;
    const [option, inlineValue] = value.includes("=") ? value.split(/=(.*)/u, 2) as [string, string] : [value, ""];
    if (!["--prefix", "--cwd", "-C"].includes(option)) continue;
    const target = inlineValue || words[index + 1]?.value;
    if (!target) return null;
    return resolveShellPath(cwd, target);
  }
  return resolveInputPath(cwd, ".");
}

function shellWriteTargets(
  currentCwd: string,
  words: readonly ShellWord[],
): { targets: string[]; uncertain: boolean } {
  const targets: string[] = [];
  let uncertain = false;
  const addTarget = (value: string | undefined) => {
    if (!value || !isWritablePathTarget(value)) {
      if (value?.startsWith("&")) return;
      uncertain = true;
      return;
    }
    const resolved = resolveShellPath(currentCwd, value);
    if (!resolved) uncertain = true;
    else targets.push(resolved);
  };

  for (let index = 0; index < words.length; index += 1) {
    const target = redirectionTarget(words, index);
    if (target) addTarget(target);
  }

  const commandIndex = commandStartIndex(words);
  const command = commandName(words[commandIndex]?.value ?? "");
  if (!command) return { targets, uncertain: true };
  if (command === "sed" && !words.some((word) => /^-i(?:$|[^A-Za-z])/u.test(word.value))) {
    return { targets, uncertain };
  }

  if (shellWriteCommands.has(command)) {
    const operands = nonOptionOperands(words, commandIndex + 1);
    const writeOperands = ["cp", "mv", "install", "ln"].includes(command)
      ? operands.slice(-1)
      : command === "sed"
        ? operands.slice(1)
        : operands;
    if (writeOperands.length === 0) uncertain = true;
    for (const operand of writeOperands) addTarget(operand);
  } else if (packageCommandIndex(words) !== null) {
    const packageRoot = packageWorkingDirectory(currentCwd, words, commandIndex);
    if (!packageRoot) uncertain = true;
    else targets.push(packageRoot);
  } else if (command === "git") {
    const git = gitCommandParts(words, commandIndex);
    if (["apply", "checkout", "clean", "commit", "merge", "push", "reset", "revert"].includes(git?.subcommand ?? "")) {
      const explicitRootIndex = words.findIndex((word) => word.value === "-C");
      const explicitRoot = explicitRootIndex >= 0 ? words[explicitRootIndex + 1]?.value : undefined;
      addTarget(explicitRoot ?? ".");
    }
  } else if (command === "curl" || command === "wget") {
    for (let index = commandIndex + 1; index < words.length; index += 1) {
      const value = words[index]?.value ?? "";
      if (value === "-o" || value === "-O" || value === "--output") addTarget(words[index + 1]?.value);
      else if (value.startsWith("--output=")) addTarget(value.slice("--output=".length));
    }
  }

  return { targets, uncertain };
}

function bashViolatesWritableProjectBoundary(command: string, cwd: string, writableDirs: readonly string[]): boolean {
  let currentCwd = resolveInputPath(cwd, ".");
  for (const segment of commandSegments(tokenizeShellCommand(command))) {
    const writeTargets = shellWriteTargets(currentCwd, segment);
    if (writeTargets.uncertain || writeTargets.targets.some((target) => !isInsideAnyDir(target, writableDirs))) {
      return true;
    }
    currentCwd = updateCwdFromCdSegment(currentCwd, segment);
  }
  return false;
}

const shellWriteCommands = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "sed",
  "tee",
  "touch",
]);

function gitCommandParts(words: readonly ShellWord[], commandIndex: number): { subcommand: string; args: string[] } | null {
  const args = words.slice(commandIndex + 1).map((word) => word.value);
  let index = 0;
  while (index < args.length) {
    const value = args[index] ?? "";
    if (value === "--") {
      index += 1;
      break;
    }
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(value)) {
      if (!args[index + 1]) return null;
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/u.test(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    return { subcommand: value, args: args.slice(index + 1) };
  }
  return null;
}

type ParsedCommandSubstitution = { command: string; end: number };

function parseCommandSubstitution(command: string, start: number, delimiter: ")" | "`"): ParsedCommandSubstitution | null {
  let quote: "'" | "\"" | null = null;

  for (let index = start; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (index + 1 >= command.length) return null;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "`" || (char === "$" && command[index + 1] === "(")) return null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (
      char === "\n"
      || char === "\r"
      || (char === "&" && command[index + 1] !== "&")
      || (char === "#" && (index === start || /[\s;|&]/u.test(command[index - 1] ?? "")))
    ) return null;
    if (char === "$" && command[index + 1] === "(") return null;
    if (char === delimiter) {
      return { command: command.slice(start, index), end: index };
    }
    if (char === "`" || (delimiter === ")" && char === "(")) return null;
  }

  return null;
}

function commandSubstitutions(command: string): { commands: string[]; uncertain: boolean } {
  const commands: string[] = [];
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (index + 1 >= command.length) return { commands, uncertain: true };
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'") {
      if (!quote) quote = char;
      continue;
    }
    if (char === "\"") {
      quote = quote === char ? null : char;
      continue;
    }
    if (!quote && char === "#" && (index === 0 || /[\s;|&]/u.test(command[index - 1] ?? ""))) break;

    let parsed: ParsedCommandSubstitution | null = null;
    if (char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      parsed = parseCommandSubstitution(command, index + 2, ")");
    } else if (char === "`") {
      parsed = parseCommandSubstitution(command, index + 1, "`");
    } else {
      continue;
    }
    if (!parsed) return { commands, uncertain: true };
    commands.push(parsed.command);
    index = parsed.end;
  }

  return { commands, uncertain: quote !== null };
}

function segmentContainsRisk(words: readonly ShellWord[], depth = 0): boolean {
  if (depth > 8) return true;
  const commandIndex = commandStartIndex(words);
  const name = commandName(words[commandIndex]?.value ?? "");
  if (name === "rm" || name === "rmdir") return true;
  if (name === "git") {
    const git = gitCommandParts(words, commandIndex);
    if (!git) return true;
    if (git.subcommand === "clean") return true;
    if (git.subcommand === "reset") return git.args.includes("--hard");
    if (git.subcommand === "push") {
      return git.args.some((arg) => arg === "--force" || /^-[^-]*f/u.test(arg));
    }
    return false;
  }
  if (shellCommands.has(name)) {
    const commandFlagIndex = words.findIndex((word, index) => index > commandIndex && /^-[^-]*c/u.test(word.value));
    const nested = commandFlagIndex >= 0 ? words[commandFlagIndex + 1]?.value : undefined;
    return nested ? isRiskyShellCommand(nested, depth + 1) : false;
  }
  if (name === "env") return segmentContainsRisk(words.slice(skipEnvWrapperPrefix(words, commandIndex + 1)), depth + 1);
  if (name === "time") return segmentContainsRisk(words.slice(skipSimpleWrapperOptions(words, commandIndex + 1, timeOptionsWithValues)), depth + 1);
  if (name === "command") return segmentContainsRisk(words.slice(skipSimpleWrapperOptions(words, commandIndex + 1, new Set())), depth + 1);
  if (name === "xargs") return segmentContainsRisk(words.slice(skipSimpleWrapperOptions(words, commandIndex + 1, xargsOptionsWithValues)), depth + 1);
  return false;
}

function isRiskyShellCommand(command: string, depth = 0): boolean {
  if (depth > 8) return true;
  const substitutions = commandSubstitutions(command);
  if (substitutions.uncertain || substitutions.commands.some((nested) => isRiskyShellCommand(nested, depth + 1))) return true;
  const segments = commandSegments(tokenizeShellCommand(command));
  return segments.length === 0 || segments.some((segment) => segmentContainsRisk(segment, depth));
}

export function isRiskyToolInput(input: {
  capability: RuntimeCapability | null | undefined;
  toolInput: RuntimeToolInput;
}): boolean {
  if (input.capability !== "shell" || typeof input.toolInput.command !== "string") return false;
  return isRiskyShellCommand(input.toolInput.command);
}

function requiresRiskConfirmation(args: CheckPermissionArgs, capability: RuntimeCapability | null): boolean {
  return args.riskMode !== "full_access" && isRiskyToolInput({ capability, toolInput: args.input });
}

function isPackageInstallCommand(command: string): boolean {
  return commandSegments(tokenizeShellCommand(command)).some((words) => packageCommandIndex(words) !== null);
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripProxyAssignmentsBeforePackageInstalls(command: string): string {
  const rangesToRemove: { start: number; end: number }[] = [];

  for (const words of commandSegments(tokenizeShellCommand(command))) {
    const commandIndex = packageCommandIndex(words);
    if (commandIndex === null) {
      continue;
    }

    for (const token of words.slice(0, commandIndex)) {
      const name = envAssignmentName(token.value);
      if (name && proxyEnvNameSet.has(name)) {
        rangesToRemove.push({ start: token.start, end: token.end });
      }
    }
  }

  if (rangesToRemove.length === 0) {
    return command;
  }

  let stripped = "";
  let pos = 0;
  for (const range of rangesToRemove.sort((a, b) => a.start - b.start)) {
    stripped += command.slice(pos, range.start);
    pos = range.end;
  }
  stripped += command.slice(pos);
  return stripped.replace(/\s+/g, " ").trim();
}

function withPackageInstallDefaults(
  input: Record<string, unknown>,
  npmRegistry: string,
  packageInstallTimeoutMs: number,
): Record<string, unknown> {
  const command = input.command;
  if (typeof command !== "string" || !isPackageInstallCommand(command)) {
    return input;
  }

  const strippedCommand = stripProxyAssignmentsBeforePackageInstalls(command);
  const envEntries: [string, string][] = [
    ["NPM_CONFIG_FETCH_RETRIES", "1"],
    ["NPM_CONFIG_FETCH_TIMEOUT", "30000"],
    ["NPM_CONFIG_AUDIT", "false"],
    ["NPM_CONFIG_FUND", "false"],
    ["NPM_CONFIG_LOGLEVEL", "warn"],
    ["NPM_CONFIG_PROXY", ""],
    ["NPM_CONFIG_HTTPS_PROXY", ""],
    ["npm_config_proxy", ""],
    ["npm_config_https_proxy", ""],
  ];

  if (!strippedCommand.includes("NPM_CONFIG_REGISTRY") && !strippedCommand.includes("npm_config_registry")) {
    envEntries.push(["NPM_CONFIG_REGISTRY", npmRegistry]);
    envEntries.push(["npm_config_registry", npmRegistry]);
  }

  const unsetProxy = proxyEnvNames.map((name) => `-u ${name}`).join(" ");
  const envPrefix = envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  const updatedInput: Record<string, unknown> = {
    ...input,
    command: `env ${unsetProxy} ${envPrefix} bash -lc ${shellQuote(strippedCommand)}`,
  };

  const timeout = input.timeout;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > packageInstallTimeoutMs
  ) {
    updatedInput.timeout = packageInstallTimeoutMs;
  }

  return updatedInput;
}

export function checkPermission(args: CheckPermissionArgs): PermissionResult {
  const {
    toolName,
    capability: explicitCapability,
    input,
    cwd,
    readableDirs,
    writableDirs,
    authorizedTools,
    npmRegistry = DEFAULT_NPM_REGISTRY,
    packageInstallTimeoutMs = DEFAULT_PACKAGE_INSTALL_TIMEOUT_MS,
  } = args;
  const providerInput = args.providerInput ?? args.input as Record<string, unknown>;
  const capability = requestCapability(toolName, explicitCapability);

  if (toolName === "AskUserQuestion") {
    return {
      behavior: "deny",
      message: "请使用 ask_user MCP tool 代替 AskUserQuestion。调用 mcp__squadflow-leader__ask_user 向用户展示决策卡片。",
    };
  }

  const isMcpTool = toolName.startsWith("mcp__");
  const isInternalTool = internalTools.has(toolName);
  const isAuthorized = hasAuthorizedTool(authorizedTools, toolName);
  const isCapabilityAuthorized = capability
    ? hasAuthorizedCapability(args.authorizedCapabilities, authorizedTools, capability)
    : false;

  if (isMcpTool && !isAuthorized) {
    return { behavior: "deny", message: `tool not allowed by expert: ${toolName}` };
  }

  if (!isMcpTool && !isInternalTool && !isAuthorized && !isCapabilityAuthorized) {
    return { behavior: "deny", message: `tool not allowed by expert: ${toolName}` };
  }

  if (isInternalTool) {
    return { behavior: "allow" };
  }

  if (capability === "shell") {
    const command = input.command;
    const canWrite = args.authorizedCapabilities
      ? hasWriteRuntimeCapability(args.authorizedCapabilities)
      : hasAuthorizedCapability(undefined, authorizedTools, "write") || hasAuthorizedCapability(undefined, authorizedTools, "edit");
    if (typeof command === "string" && !canWrite && isPackageInstallCommand(command)) {
      return {
        behavior: "deny",
        message: "只读 Expert 不允许执行依赖安装命令；请改用静态检查或返回验证失败。",
      };
    }
    if (typeof command === "string" && !canWrite && bashViolatesReadOnlyProjectMode(command, cwd, readableDirs, writableDirs)) {
      return {
        behavior: "deny",
        message: "Bash is running in read-only project mode; write operations are not allowed.",
      };
    }
    if (typeof command === "string" && bashViolatesWritableProjectBoundary(command, cwd, writableDirs)) {
      return {
        behavior: "deny",
        message: "Bash 写操作必须落在项目或授权可写目录内。",
      };
    }

    const updatedInput = withPackageInstallDefaults(providerInput, npmRegistry, packageInstallTimeoutMs);
    if (requiresRiskConfirmation(args, capability)) {
      return {
        behavior: "deny",
        message: "该风险操作需要用户确认",
        requiresConfirmation: true,
      };
    }
    if (updatedInput !== providerInput) {
      return { behavior: "allow", updatedInput };
    }
    return { behavior: "allow" };
  }

  if (capability === "write" || capability === "edit") {
    const filePath = inputPath(input);
    if (!filePath) {
      return { behavior: "deny", message: `${toolName} 需要明确的文件路径` };
    }

    const resolvedPath = resolveInputPath(cwd, filePath);
    if (!isInsideAnyDir(resolvedPath, writableDirs)) {
      return { behavior: "deny", message: `仅允许在授权可写目录内写入，当前路径: ${filePath}` };
    }
    return { behavior: "allow" };
  }

  if (capability === "read" || capability === "search") {
    if (args.allowReadOutsideDirs === true) {
      return { behavior: "allow" };
    }
    const filePath = inputPath(input);
    if (!filePath) {
      return { behavior: "allow" };
    }

    const resolvedPath = resolveInputPath(cwd, filePath);
    return isInsideAnyDir(resolvedPath, [cwd, ...readableDirs, ...writableDirs])
      ? { behavior: "allow" }
      : { behavior: "deny", message: `路径不在允许范围: ${filePath}` };
  }

  if (capability === "web_search") {
    return { behavior: "allow" };
  }

  if (isMcpTool) {
    return { behavior: "allow" };
  }

  return { behavior: "deny", message: `未授权工具: ${toolName}` };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type NativeContextScope = "project" | "global";

export type NativeContextItem = {
  name: string;
  description: string;
  scope: NativeContextScope;
  path: string | null;
};

export type NativeContextSnapshot = {
  sdk: "claudecode" | "codex";
  scope: "global" | "project";
  skills: NativeContextItem[];
  mcpServers: NativeContextItem[];
};

export type PreparedClaudeNativeContext = {
  pluginDir: string;
  sessionConfigDir: string;
  systemPrompt: string;
  mcpServers: Options["mcpServers"];
};

export type ClaudeSessionMigrationResult = {
  filesCopied: number;
  legacyRootsFound: number;
};

type SkillEntry = NativeContextItem & {
  sourcePath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function findProjectDirectories(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const directoriesToRoot: string[] = [];
  let current = resolvedCwd;
  while (true) {
    directoriesToRoot.push(current);
    if (fs.existsSync(path.join(current, ".git"))) return directoriesToRoot;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // A Flow cwd is already the selected project root. Without a repository
  // marker, walking beyond it would misclassify ~/.claude as project context.
  return [resolvedCwd];
}

function frontmatterValue(markdown: string, key: string): string {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/gu, "");
}

function readSkillDirectory(directory: string, scope: NativeContextScope): SkillEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    const sourcePath = path.join(directory, entry.name);
    const skillPath = path.join(sourcePath, "SKILL.md");
    let markdown: string;
    try {
      markdown = fs.readFileSync(skillPath, "utf8");
    } catch {
      return [];
    }
    return [{
      name: frontmatterValue(markdown, "name") || entry.name,
      description: frontmatterValue(markdown, "description"),
      scope,
      path: skillPath,
      sourcePath,
    }];
  });
}

function claudeSourceConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function claudeGlobalStatePath(sourceConfigDir: string): string {
  return sourceConfigDir === path.join(os.homedir(), ".claude")
    ? path.join(os.homedir(), ".claude.json")
    : path.join(sourceConfigDir, ".claude.json");
}

function mcpServerItems(
  servers: Record<string, unknown>,
  scope: NativeContextScope,
  sourcePath: string,
): NativeContextItem[] {
  return Object.keys(servers).map((name) => ({
    name,
    description: "",
    scope,
    path: sourcePath,
  }));
}

function eagerlyLoadedMcpServers(servers: Record<string, unknown>): Options["mcpServers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      isRecord(config) ? { ...config, alwaysLoad: true } : config,
    ]),
  ) as Options["mcpServers"];
}

function claudeGlobalMcpServers(sourceConfigDir: string): Record<string, unknown> {
  const state = readJsonObject(claudeGlobalStatePath(sourceConfigDir));
  return isRecord(state.mcpServers) ? state.mcpServers : {};
}

function claudeProjectMcpServers(cwd: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const directories = findProjectDirectories(cwd).reverse();
  for (const directory of directories) {
    const config = readJsonObject(path.join(directory, ".mcp.json"));
    if (isRecord(config.mcpServers)) Object.assign(merged, config.mcpServers);
  }
  const globalState = readJsonObject(claudeGlobalStatePath(claudeSourceConfigDir()));
  const projects = isRecord(globalState.projects) ? globalState.projects : {};
  for (const directory of directories) {
    const projectState = isRecord(projects[directory]) ? projects[directory] : {};
    if (isRecord(projectState.mcpServers)) Object.assign(merged, projectState.mcpServers);
  }
  return merged;
}

function parseCodexMcpNames(configPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*\[mcp_servers\.((?:"[^"]+")|(?:'[^']+')|(?:[A-Za-z0-9_-]+))\]\s*$/gmu)) {
    names.add(match[1].replace(/^["']|["']$/gu, ""));
  }
  return [...names];
}

function codexGlobalRoot(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function sortNearestFirst(items: NativeContextItem[]): NativeContextItem[] {
  return [...items].sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function discoverNativeContext(input: {
  sdk: "claudecode" | "codex";
  cwd?: string | null;
  includeProject: boolean;
  codexHome?: string;
}): NativeContextSnapshot {
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  if (input.sdk === "claudecode") {
    const sourceConfigDir = claudeSourceConfigDir();
    const globalSkills = readSkillDirectory(path.join(sourceConfigDir, "skills"), "global");
    const projectSkills = input.includeProject && cwd
      ? findProjectDirectories(cwd).flatMap((directory) =>
          readSkillDirectory(path.join(directory, ".claude", "skills"), "project")
        )
      : [];
    const globalMcpPath = claudeGlobalStatePath(sourceConfigDir);
    const globalMcp = mcpServerItems(claudeGlobalMcpServers(sourceConfigDir), "global", globalMcpPath);
    const projectMcp = input.includeProject && cwd
      ? findProjectDirectories(cwd).flatMap((directory) => {
          const configPath = path.join(directory, ".mcp.json");
          const config = readJsonObject(configPath);
          return isRecord(config.mcpServers)
            ? mcpServerItems(config.mcpServers, "project", configPath)
            : [];
        })
      : [];
    return {
      sdk: input.sdk,
      scope: input.includeProject ? "project" : "global",
      skills: sortNearestFirst([...projectSkills, ...globalSkills]),
      mcpServers: sortNearestFirst([...projectMcp, ...globalMcp]),
    };
  }

  const globalRoot = codexGlobalRoot(input.codexHome);
  const globalSkillRoots = [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(globalRoot, "skills"),
  ];
  const globalSkills = globalSkillRoots.flatMap((directory) => readSkillDirectory(directory, "global"));
  const projectDirectories = input.includeProject && cwd ? findProjectDirectories(cwd) : [];
  const projectSkills = projectDirectories.flatMap((directory) =>
    readSkillDirectory(path.join(directory, ".agents", "skills"), "project")
  );
  const globalConfigPath = path.join(globalRoot, "config.toml");
  const globalMcp = parseCodexMcpNames(globalConfigPath).map((name) => ({
    name,
    description: "",
    scope: "global" as const,
    path: globalConfigPath,
  }));
  const projectMcp = projectDirectories.flatMap((directory) => {
    const configPath = path.join(directory, ".codex", "config.toml");
    return parseCodexMcpNames(configPath).map((name) => ({
      name,
      description: "",
      scope: "project" as const,
      path: configPath,
    }));
  });
  return {
    sdk: input.sdk,
    scope: input.includeProject ? "project" : "global",
    skills: sortNearestFirst([...projectSkills, ...globalSkills]),
    mcpServers: sortNearestFirst([...projectMcp, ...globalMcp]),
  };
}

function projectClaudeInstructions(cwd: string): string {
  const instructionBlocks: string[] = [];
  for (const directory of findProjectDirectories(cwd).reverse()) {
    for (const fileName of ["CLAUDE.md", path.join(".claude", "CLAUDE.md")]) {
      const filePath = path.join(directory, fileName);
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) instructionBlocks.push(`File: ${filePath}\n${content}`);
      } catch {
        // Missing or unreadable project instructions are skipped, matching native discovery.
      }
    }
  }
  if (instructionBlocks.length === 0) return "";
  return [
    "<project_instructions>",
    "These project-local instructions supplement the SquadFlow role prompt. They do not replace the agent identity, role boundaries, or platform safety rules.",
    ...instructionBlocks,
    "</project_instructions>",
  ].join("\n\n");
}

function resetDirectory(directory: string) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function copyMissingDirectory(source: string, destination: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return 0;
  }

  fs.mkdirSync(destination, { recursive: true });
  let filesCopied = 0;
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      filesCopied += copyMissingDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(destinationPath)) continue;
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    filesCopied += 1;
  }
  return filesCopied;
}

export function migrateLegacyClaudeSessions(input: {
  runtimeScratchRoot: string;
  targetConfigDir?: string;
}): ClaudeSessionMigrationResult {
  const scratchRoot = path.resolve(input.runtimeScratchRoot);
  const targetProjectsDir = path.join(
    path.resolve(input.targetConfigDir ?? claudeSourceConfigDir()),
    "projects",
  );
  const stack = [scratchRoot];
  let filesCopied = 0;
  let legacyRootsFound = 0;

  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (path.basename(directory) === "claude-native-context") {
      const legacyProjectsDir = path.join(directory, "projects");
      if (fs.existsSync(legacyProjectsDir)) {
        legacyRootsFound += 1;
        filesCopied += copyMissingDirectory(legacyProjectsDir, targetProjectsDir);
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(directory, entry.name));
    }
  }

  return { filesCopied, legacyRootsFound };
}

export function prepareClaudeNativeContext(input: {
  cwd: string;
  scratchDir: string;
  systemPrompt: string;
}): PreparedClaudeNativeContext {
  const pluginDir = path.join(path.resolve(input.scratchDir), "claude-native-context-plugin");
  const skillsDir = path.join(pluginDir, "skills");
  resetDirectory(skillsDir);
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify({
      name: "squadflow-native-context",
      version: "1.0.0",
      description: "Native Claude Skills projected into SquadFlow.",
    }, null, 2)}\n`,
    "utf8",
  );

  const sourceConfigDir = claudeSourceConfigDir();
  const skillLayers = [
    ...readSkillDirectory(path.join(sourceConfigDir, "skills"), "global"),
    ...findProjectDirectories(input.cwd).reverse().flatMap((directory) =>
      readSkillDirectory(path.join(directory, ".claude", "skills"), "project")
    ),
  ];
  const selectedSkills = new Map(skillLayers.map((skill) => [skill.name, skill]));
  for (const [name, skill] of selectedSkills) {
    const safeName = name.replace(/[^A-Za-z0-9._-]/gu, "-");
    fs.symlinkSync(skill.sourcePath, path.join(skillsDir, safeName), process.platform === "win32" ? "junction" : "dir");
  }

  const mcpServers = eagerlyLoadedMcpServers({
    ...claudeGlobalMcpServers(sourceConfigDir),
    ...claudeProjectMcpServers(input.cwd),
  });
  const instructions = projectClaudeInstructions(input.cwd);
  return {
    pluginDir,
    sessionConfigDir: sourceConfigDir,
    systemPrompt: [input.systemPrompt, instructions].filter(Boolean).join("\n\n"),
    mcpServers,
  };
}

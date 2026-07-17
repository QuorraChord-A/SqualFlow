import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workspaceRoot = process.env.SQUADFLOW_WORKSPACE_ROOT ?? repoRoot;
const outputRoot = process.env.SQUADFLOW_OUTPUT_ROOT ?? path.join(repoRoot, "output");

export const DEFAULT_PROJECT_ID = "proj-default";
export const DEFAULT_PROJECT_DIRECTORY_NAME = "default_project";

export type AgentConfigRole = "leader" | "coder" | "research" | "expert";

function envOrDefault(value: string | undefined, fallback: string) {
  return value && value.trim() ? value : fallback;
}

export const config = {
  host: process.env.SQUADFLOW_TS_HOST ?? "0.0.0.0",
  port: Number(process.env.SQUADFLOW_TS_PORT ?? "8001"),
  outputRoot,
  databasePath: process.env.SQUADFLOW_TS_DB ?? path.join(outputRoot, "data", "squadflow.db"),
  checkpointPath: process.env.SQUADFLOW_TS_CHECKPOINT_DB ?? path.join(outputRoot, "data", "squadflow_checkpoints.db"),
  agentRuntimeConfigRoot: process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT ?? path.join(outputRoot, "data", "agent-runtime"),
  runtimeScratchRoot: process.env.SQUADFLOW_RUNTIME_SCRATCH_ROOT ?? path.join(outputRoot, "runtime", "scratch"),
  workspaceRoot,
  defaultProjectRoot: process.env.SQUADFLOW_DEFAULT_PROJECT_ROOT ?? path.join(outputRoot, "workspace"),
  claudeSettingsPath: envOrDefault(process.env.SQUADFLOW_CLAUDE_SETTINGS, path.join(outputRoot, "settings", "claude.json")),
  claudeCodeExecutable: process.env.SQUADFLOW_BUNDLED_CLAUDE_COMMAND?.trim() || undefined,
};

export function getAgentSettingsPath(role: AgentConfigRole) {
  if (role === "leader") {
    return envOrDefault(
      process.env.SQUADFLOW_LEADER_SETTINGS,
      envOrDefault(process.env.SQUADFLOW_LEADER_AGENTSDK_SETTINGS, config.claudeSettingsPath),
    );
  }
  if (role === "coder") {
    return envOrDefault(
      process.env.SQUADFLOW_CODER_EXPERT_SETTINGS,
      envOrDefault(process.env.SQUADFLOW_EXPERT_AGENTSDK_SETTINGS, config.claudeSettingsPath),
    );
  }
  if (role === "research") {
    return envOrDefault(
      process.env.SQUADFLOW_RESEARCH_EXPERT_SETTINGS,
      envOrDefault(process.env.SQUADFLOW_EXPERT_AGENTSDK_SETTINGS, config.claudeSettingsPath),
    );
  }
  return envOrDefault(process.env.SQUADFLOW_EXPERT_SETTINGS, config.claudeSettingsPath);
}

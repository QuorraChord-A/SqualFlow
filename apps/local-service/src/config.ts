import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workspaceRoot = process.env.SQUADFLOW_WORKSPACE_ROOT ?? repoRoot;

export const DEFAULT_PROJECT_ID = "proj-default";
export const DEFAULT_PROJECT_DIRECTORY_NAME = "default_project";

export type AgentConfigRole = "leader" | "coder" | "research" | "expert";

function envOrDefault(value: string | undefined, fallback: string) {
  return value && value.trim() ? value : fallback;
}

export const config = {
  host: process.env.SQUADFLOW_TS_HOST ?? "0.0.0.0",
  port: Number(process.env.SQUADFLOW_TS_PORT ?? "8001"),
  databasePath: process.env.SQUADFLOW_TS_DB ?? path.join(repoRoot, "data", "squadflow.db"),
  checkpointPath: process.env.SQUADFLOW_TS_CHECKPOINT_DB ?? path.join(repoRoot, "data", "squadflow_checkpoints.db"),
  agentRuntimeConfigRoot: process.env.SQUADFLOW_AGENT_RUNTIME_CONFIG_ROOT ?? path.join(repoRoot, "data", "agent-runtime"),
  runtimeScratchRoot: process.env.SQUADFLOW_RUNTIME_SCRATCH_ROOT ?? path.join(os.homedir(), ".squadflow", "scratch"),
  workspaceRoot,
  testWorkspaceRoot: process.env.SQUADFLOW_TEST_WORKSPACE_ROOT ?? path.join(repoRoot, "testworkspace"),
  defaultProjectRoot: process.env.SQUADFLOW_DEFAULT_PROJECT_ROOT ?? path.join(os.homedir(), ".squadflow", "workspace"),
  claudeSettingsPath: envOrDefault(process.env.SQUADFLOW_CLAUDE_SETTINGS, path.join(repoRoot, "data", "claude-settings.json")),
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

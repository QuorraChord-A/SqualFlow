import type { RuntimeSdk } from "./api";

export const AGENT_ORDER: RuntimeSdk[] = ["claudecode", "codex"];

export const AGENT_META: Record<RuntimeSdk, { label: string; iconPath: string; format: string; hint: string }> = {
  claudecode: {
    label: "ClaudeCode",
    iconPath: "/icons/claudecode.svg",
    format: "Anthropic Messages 格式",
    hint: "Base URL 与 API key 按 Anthropic 协议配置。",
  },
  codex: {
    label: "Codex",
    iconPath: "/icons/codex.svg",
    format: "OpenAI Responses 格式",
    hint: "Base URL 填 provider 根路径，例如 https://host/v1。",
  },
};

export function runtimeSdkLabel(sdk: RuntimeSdk) {
  return AGENT_META[sdk]?.label ?? sdk;
}

export function AgentIcon({ sdk }: { sdk: RuntimeSdk }) {
  return (
    <img
      src={AGENT_META[sdk].iconPath}
      alt=""
      aria-hidden="true"
      className={`size-3.5 shrink-0 object-contain ${sdk === "codex" ? "dark:invert" : ""}`}
    />
  );
}

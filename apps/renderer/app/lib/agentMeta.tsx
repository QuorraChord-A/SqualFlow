import type { RuntimeSdk } from "./api";

export const AGENT_ORDER: RuntimeSdk[] = ["claudecode", "codex"];

export const AGENT_META: Record<RuntimeSdk, { label: string; dotColor: string; format: string; hint: string }> = {
  claudecode: {
    label: "claudecode",
    dotColor: "#7F77DD",
    format: "Anthropic Messages 格式",
    hint: "Base URL 与 API key 按 Anthropic 协议配置。",
  },
  codex: {
    label: "codex",
    dotColor: "#1D9E75",
    format: "OpenAI Responses 格式",
    hint: "Base URL 填 provider 根路径，例如 https://host/v1。",
  },
};

export function runtimeSdkLabel(sdk: RuntimeSdk) {
  return AGENT_META[sdk]?.label ?? sdk;
}

export function AgentDot({ sdk }: { sdk: RuntimeSdk }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-[7px] shrink-0 rounded-full"
      style={{ backgroundColor: AGENT_META[sdk]?.dotColor ?? "#888888" }}
    />
  );
}

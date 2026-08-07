import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppSettingsDialog from "./AppSettingsDialog";
import { useThemeStore } from "../stores/useThemeStore";
import type { DesktopUpdateBridge, DesktopUpdateState } from "../lib/desktopUpdate";

const apiMocks = vi.hoisted(() => ({
  fetchAgentRuntimeConfig: vi.fn(),
  fetchAgentDefinitions: vi.fn(),
  createAgentRuntimeConfig: vi.fn(),
  deleteAgentRuntimeConfig: vi.fn(),
  checkAgentRuntimeLocalAuth: vi.fn(),
  refreshAgentRuntimeModels: vi.fn(),
  testAgentRuntimeConnection: vi.fn(),
  updateAgentRuntimeConfig: vi.fn(),
  updateAgentRuntimeRole: vi.fn(),
}));
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
const updateState: DesktopUpdateState = {
  enabled: true,
  automaticUpdates: true,
  status: "idle",
  currentVersion: "0.1.0",
  availableVersion: null,
  notes: null,
  progress: null,
  error: null,
  lastCheckedAt: "2026-07-22T20:00:00.000Z",
};

function installUpdateBridge(state = updateState) {
  const bridge: DesktopUpdateBridge = {
    getState: vi.fn().mockResolvedValue(state),
    check: vi.fn().mockResolvedValue(state),
    download: vi.fn().mockResolvedValue(true),
    pause: vi.fn().mockResolvedValue(true),
    resume: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
    setAutomaticUpdates: vi.fn().mockImplementation(async (enabled) => ({
      ...state,
      automaticUpdates: enabled,
    })),
    install: vi.fn().mockResolvedValue(true),
    onState: vi.fn().mockReturnValue(() => {}),
  };
  window.squadflowDesktopUpdate = bridge;
  return bridge;
}

vi.mock("../lib/api", () => ({
  ...apiMocks,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const runtimeSnapshot = {
  roles: [
    { role: "leader", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25", reasoningEffort: "high" },
    { role: "coder", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25", reasoningEffort: "high" },
    { role: "research", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25", reasoningEffort: "high" },
    { role: "verify", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25", reasoningEffort: "high" },
    { role: "codereview", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25", reasoningEffort: "high" },
  ],
  configs: [
    {
      id: "default-agent-sdk",
      fileName: "default-agent-sdk.json",
      filePath: "/tmp/agent-runtime/configs/default-agent-sdk.json",
      name: "项目claudecode配置",
      sdk: "claudecode",
      authMode: "apiKey",
      baseUrl: "",
      apiKey: "",
      models: [
        { id: "mimo-v25", name: "mimo-v2.5" },
        { id: "opus", name: "opus" },
      ],
    },
    {
      id: "codex-glm",
      fileName: "codex-glm.json",
      filePath: "/tmp/agent-runtime/configs/codex-glm.json",
      name: "codex-glm",
      sdk: "codex",
      authMode: "apiKey",
      baseUrl: "https://open.bigmodel.cn/api/v1",
      apiKey: "",
      models: [{ id: "glm-47", name: "glm-4.7" }],
    },
  ],
};

describe("AppSettingsDialog", () => {
  beforeEach(() => {
    delete window.squadflowDesktopUpdate;
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.fetchAgentDefinitions.mockResolvedValue([]);
    clipboardWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboardWriteText } });
    useThemeStore.setState({ theme: "system", resolvedTheme: "dark" });
  });

  it("shows the selected theme in Chinese instead of its internal value", () => {
    render(<AppSettingsDialog open onOpenChange={vi.fn()} />);

    const themeSelect = screen.getByRole("combobox");
    expect(themeSelect).toHaveTextContent("跟随系统");
    expect(themeSelect).not.toHaveTextContent("system");
  });

  it("controls background updates and keeps the version row concise", async () => {
    const user = userEvent.setup();
    const bridge = installUpdateBridge();

    render(<AppSettingsDialog open onOpenChange={vi.fn()} />);

    const automaticUpdates = await screen.findByRole("switch", { name: "自动更新" });
    expect(automaticUpdates).toBeChecked();
    expect(screen.queryByText(/不会自动重启/)).not.toBeInTheDocument();
    expect(screen.getByText("版本 0.1.0")).toBeInTheDocument();

    await user.click(automaticUpdates);
    expect(bridge.setAutomaticUpdates).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
  });

  it("does not render role switches with initial defaults while agent settings are loading", async () => {
    const user = userEvent.setup();
    const snapshotLoad = deferred<typeof runtimeSnapshot>();
    apiMocks.fetchAgentRuntimeConfig.mockReturnValue(snapshotLoad.promise);

    render(<AppSettingsDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "智能体设置" }));

    expect(screen.getByText("正在加载智能体配置...")).toBeInTheDocument();
    expect(screen.queryByText("调研 Expert")).not.toBeInTheDocument();

    snapshotLoad.resolve(runtimeSnapshot);

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });
    expect(screen.getByText("调研 Expert")).toBeInTheDocument();
    expect(screen.getByLabelText("调研 Expert 状态")).toBeChecked();
  });

  it("opens the full system prompt as a styled Markdown document", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.fetchAgentDefinitions.mockResolvedValue([{
      id: "exp-leader",
      role: "leader",
      name: "Leader",
      system_prompt: "# Leader Prompt\n\n- 保持任务边界清晰。\n- 在关键节点向用户追问。\n\n## 工作方式\n\n先理解目标，再拆解计划，最后汇总结果。\n\n### 约束\n\n保持上下文清晰，不做无关修改，并在完成后给出可验证结论。",
      builtin_tools: [],
      mcp_tools: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }]);

    render(<AppSettingsDialog open onOpenChange={vi.fn()} initialSection="agents" />);

    const expandButton = await screen.findByRole("button", { name: "展开查看全文" });
    expect(expandButton).toHaveClass("border");
    await user.click(expandButton);

    expect(screen.getByRole("heading", { name: "Leader · system-prompt.md" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Leader Prompt" })).toBeInTheDocument();
    expect(screen.getByText("保持任务边界清晰。")).toBeInTheDocument();
  });

  it("binds a role to a provider model through the grouped picker", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.updateAgentRuntimeRole.mockResolvedValue({
      role: "coder",
      enabled: true,
      configId: "codex-glm",
      modelId: "glm-47",
      reasoningEffort: "high",
    });

    render(<AppSettingsDialog open onOpenChange={vi.fn()} initialSection="agents" />);

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "选择 Coder Expert 模型" }));
    expect(screen.getByTestId("role-model-picker")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "codex-glm" }));
    expect(screen.getByText(/跨 Agent 切换/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "glm-4.7" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentRuntimeRole).toHaveBeenCalledWith("coder", {
        configId: "codex-glm",
        modelId: "glm-47",
        enabled: true,
        reasoningEffort: "high",
      });
    });
    expect(screen.queryByTestId("role-model-picker")).not.toBeInTheDocument();
  });

  it("updates and displays the default effort for each role", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.updateAgentRuntimeRole.mockResolvedValue({
      ...runtimeSnapshot.roles[0],
      reasoningEffort: "max",
    });

    render(<AppSettingsDialog open onOpenChange={vi.fn()} initialSection="agents" />);

    const effortSelect = await screen.findByRole("combobox", { name: "选择 Leader Effort" });
    expect(effortSelect).toHaveTextContent("high");
    await user.click(effortSelect);
    await user.click(await screen.findByRole("option", { name: "max" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentRuntimeRole).toHaveBeenCalledWith("leader", {
        enabled: true,
        configId: "default-agent-sdk",
        modelId: "mimo-v25",
        reasoningEffort: "max",
      });
    });
    expect(effortSelect).toHaveTextContent("max");
  });

  it("rolls back the role binding when the update fails", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.updateAgentRuntimeRole.mockRejectedValue(new Error("绑定失败"));

    render(<AppSettingsDialog open onOpenChange={vi.fn()} initialSection="agents" />);

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "选择 Coder Expert 模型" }));
    await user.click(screen.getByRole("button", { name: "codex-glm" }));
    await user.click(screen.getByRole("button", { name: "glm-4.7" }));

    await waitFor(() => {
      expect(screen.getByText("绑定失败")).toBeInTheDocument();
    });
    const chip = screen.getByRole("button", { name: "选择 Coder Expert 模型" });
    expect(chip.textContent).toContain("项目claudecode配置");
    expect(chip.textContent).toContain("mimo-v2.5");
  });

  it("creates a provider draft through agent and auth choice steps with an immutable sdk", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByText("先选择 Agent 运行时。它决定供应商的接口格式，创建后不可更改。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OpenAI Responses 格式/ }));
    expect(screen.getByText("选择认证方式。创建后仍可在详情中调整连接信息。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Codex 本地账号登录态/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /自定义 API Key/ }));

    expect(screen.getAllByText("未命名配置1")).toHaveLength(2);
    expect(screen.getAllByText(/OpenAI Responses 格式/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent 类型创建后不可更改")).not.toBeInTheDocument();
    expect(screen.queryByText("保存后生成UUID.json")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /SDK/ })).not.toBeInTheDocument();
  });

  it("offers only API key authentication for Claude Code", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("button", { name: /Anthropic Messages 格式/ }));

    expect(screen.getByText(/Claude Code 仅支持 API Key/)).toBeInTheDocument();
    const apiKeyChoice = screen.getByRole("button", { name: /自定义 API Key/ });
    expect(apiKeyChoice).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /本地账号登录态/ })).not.toBeInTheDocument();
    await user.click(apiKeyChoice);
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue("https://api.anthropic.com/v1");
  });

  it("does not expose local auth controls for Claude Code configs", async () => {
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [
        {
          ...runtimeSnapshot.configs[0],
          id: "claude-local",
          fileName: "claude-local.json",
          name: "claude-local",
          authMode: "apiKey",
          apiKey: "",
        },
      ],
    });
    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    expect(screen.queryByText("自定义 API Key")).not.toBeInTheDocument();
    expect(screen.getByText("API Key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检测登录态" })).not.toBeInTheDocument();
    expect(apiMocks.checkAgentRuntimeLocalAuth).not.toHaveBeenCalled();
  });

  it("shows only provider names with distinct Agent icons and copies the selected config path", async () => {
    const user = userEvent.setup();
    const clipboardSpy = vi.spyOn(navigator.clipboard, "writeText");
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    const claudeProvider = screen.getByRole("button", { name: "项目claudecode配置" });
    const codexProvider = screen.getByRole("button", { name: "codex-glm" });
    expect(claudeProvider.querySelector('img[src="/icons/claudecode.svg"]')).toBeNull();
    expect(codexProvider.querySelector('img[src="/icons/codex.svg"]')).toBeNull();
    expect(screen.getByText("ClaudeCode").parentElement?.querySelector('img[src="/icons/claudecode.svg"]')).toHaveClass("size-5");
    expect(screen.getByText("Codex").parentElement?.querySelector('img[src="/icons/codex.svg"]')).toHaveClass("size-5");
    expect(screen.queryByText("default-agent-sdk.json")).not.toBeInTheDocument();
    expect(screen.queryByText(/用于角色配置中选择/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制配置路径" }));
    await waitFor(() => expect(clipboardSpy).toHaveBeenCalledWith("/tmp/agent-runtime/configs/default-agent-sdk.json"));
    expect(await screen.findByRole("button", { name: "已复制路径" })).toBeInTheDocument();
  });

  it("keeps provider model order and inserts a new model on the first row", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    const modelValues = () => screen.getAllByText("模型名称").map((label) => (
      within(label.closest("label") as HTMLLabelElement).getByRole("textbox") as HTMLInputElement
    ).value);

    expect(modelValues()).toEqual(["mimo-v2.5", "opus"]);

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(modelValues()).toEqual(["", "mimo-v2.5", "opus"]);
    expect(screen.queryByText("请填写所有模型名称。")).not.toBeInTheDocument();
  });

  it("does not keep auto-saving or reorder a newly added model", async () => {
    const user = userEvent.setup();
    const snapshot = {
      ...runtimeSnapshot,
      configs: runtimeSnapshot.configs.map((config, index) => index === 0
        ? {
            ...config,
            models: config.models.map((model) => ({ ...model, contextWindowK: 1_000 })),
          }
        : config),
    };
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(snapshot);
    apiMocks.updateAgentRuntimeConfig.mockImplementation(async (_configId, config) => config);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    const firstModelInput = within(screen.getAllByText("模型名称")[0].closest("label") as HTMLLabelElement)
      .getByRole("textbox");
    await user.type(firstModelInput, "aaa");

    await waitFor(() => {
      expect(apiMocks.updateAgentRuntimeConfig).toHaveBeenCalledTimes(1);
    }, { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(apiMocks.updateAgentRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateAgentRuntimeConfig).toHaveBeenCalledWith(
      "default-agent-sdk",
      expect.objectContaining({
        models: [
          expect.objectContaining({ name: "aaa" }),
          expect.objectContaining({ name: "mimo-v2.5" }),
          expect.objectContaining({ name: "opus" }),
        ],
      }),
    );
  });

  it("refreshes Claude API-key models and surfaces missing metadata", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [{
        ...runtimeSnapshot.configs[0],
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-test",
        models: [{ id: "old", name: "old-model", contextWindowK: 200 }],
      }],
    });
    apiMocks.refreshAgentRuntimeModels.mockResolvedValue({
      sdk: "claudecode",
      endpoint: "https://api.anthropic.com/v1/models",
      models: [
        { id: "old-refreshed", name: "old-model" },
        { id: "claude-new", name: "claude-new", contextWindowK: 200 },
      ],
      warnings: ["模型 claude-new 未返回上下文大小；刷新时会保留已有配置，新模型使用 SDK 默认值。"],
    });

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));

    await waitFor(() => expect(apiMocks.refreshAgentRuntimeModels).toHaveBeenCalledWith("default-agent-sdk", {
      config: expect.objectContaining({ sdk: "claudecode", authMode: "apiKey" }),
    }));
    const modelDialog = screen.getByRole("dialog", { name: "获取可用模型" });
    expect(modelDialog).toHaveClass("!left-1/2", "!top-1/2", "!w-[min(760px,calc(100vw-3rem))]");
    expect(within(modelDialog).getByRole("heading", { name: "获取可用模型" })).toHaveClass("text-center", "text-xl");
    const searchInput = within(modelDialog).getByRole("searchbox", { name: "搜索模型" });
    await user.type(searchInput, "claude-new");
    expect(within(modelDialog).queryByRole("button", { name: "old-model" })).not.toBeInTheDocument();
    await user.clear(searchInput);
    expect(within(modelDialog).queryByText("已配置")).not.toBeInTheDocument();
    expect(within(modelDialog).queryByText("新模型")).not.toBeInTheDocument();
    expect(within(modelDialog).getByRole("combobox", { name: "old-model 上下文窗口" })).toHaveTextContent("200K");
    expect(within(modelDialog).getByRole("button", { name: "claude-new" })).toBeInTheDocument();
    expect(within(modelDialog).getByRole("combobox", { name: "claude-new 上下文窗口" })).toBeInTheDocument();
    await user.click(within(modelDialog).getByRole("button", { name: "claude-new" }));
    await user.click(within(modelDialog).getByRole("button", { name: "加入配置" }));
    expect(screen.getByDisplayValue("claude-new")).toBeInTheDocument();
  });

  it("refreshes and tests models for Codex local auth configs", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [
        {
          ...runtimeSnapshot.configs[1],
          id: "codex-local",
          fileName: "codex-local.json",
          name: "codex-local",
          authMode: "inherited",
          baseUrl: "",
          apiKey: "",
          models: [{ id: "gpt-old", name: "gpt-5.4" }],
        },
      ],
    });
    apiMocks.refreshAgentRuntimeModels.mockResolvedValue({
      sdk: "codex",
      models: [
        { id: "gpt-54", name: "gpt-5.4", contextWindowK: 256 },
        { id: "gpt-55", name: "gpt-5.5", contextWindowK: 256 },
      ],
    });
    apiMocks.testAgentRuntimeConnection.mockResolvedValue({
      ok: true,
      sdk: "codex",
      model: "gpt-5.5",
      latencyMs: 1200,
      message: "连接成功",
    });

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    expect(screen.getByText("本地登录态")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));

    await waitFor(() => {
      expect(apiMocks.refreshAgentRuntimeModels).toHaveBeenCalledWith("codex-local", {
        config: expect.objectContaining({ id: "codex-local", authMode: "inherited", sdk: "codex" }),
      });
    });
    const modelDialog = screen.getByRole("dialog", { name: "获取可用模型" });
    expect(within(modelDialog).getByRole("button", { name: "gpt-5.5" })).toBeInTheDocument();
    await user.click(within(modelDialog).getByRole("button", { name: "gpt-5.5" }));
    await user.click(within(modelDialog).getByRole("button", { name: "加入配置" }));
    expect(screen.getByDisplayValue("gpt-5.5")).toBeInTheDocument();

    const latestModelInput = screen.getByDisplayValue("gpt-5.5");
    const latestModelRow = latestModelInput.closest("div.grid");
    expect(latestModelRow).not.toBeNull();
    await user.click(within(latestModelRow as HTMLElement).getByRole("button", { name: "测试" }));

    await waitFor(() => {
      expect(apiMocks.testAgentRuntimeConnection).toHaveBeenCalledWith("codex-local", {
        model: "gpt-5.5",
        config: expect.objectContaining({ id: "codex-local", authMode: "inherited", sdk: "codex" }),
      });
    });
    expect(screen.getByText(/连接成功 · gpt-5.5 · 1200ms/)).toBeInTheDocument();
  });

  it("saves provider-reported Claude Code context sizes per model", async () => {
    const user = userEvent.setup();
    const snapshot = {
      ...runtimeSnapshot,
      configs: [{
        ...runtimeSnapshot.configs[0],
        models: [{ id: "mimo-v25", name: "mimo-v2.5", contextWindowK: 200 }],
      }],
    };
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(snapshot);
    apiMocks.updateAgentRuntimeConfig.mockImplementation(async (_configId, config) => config);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    const contextInput = screen.getByRole("combobox", { name: "模型 mimo-v2.5 上下文窗口" });
    expect(contextInput).toHaveTextContent("200");
    await user.click(contextInput);
    await user.click(await screen.findByRole("option", { name: "1M" }));
    await waitFor(() => {
      expect(apiMocks.updateAgentRuntimeConfig).toHaveBeenCalledWith(
        "default-agent-sdk",
        expect.objectContaining({
          models: [expect.objectContaining({
            id: "mimo-v25",
            name: "mimo-v2.5",
            contextWindowK: 1000,
          })],
        }),
      );
    });
  });

  it("validates custom Codex context as at least 128K", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [{
        ...runtimeSnapshot.configs[1],
        models: [{ id: "glm-47", name: "glm-4.7", contextWindowK: 128 }],
      }],
    });

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    const input = screen.getByRole("spinbutton", { name: "模型 glm-4.7 上下文窗口（K）" });
    await user.clear(input);
    await user.type(input, "127");
    await waitFor(() => expect(screen.getByText("非官方 Codex 上下文窗口不能低于 128K。")).toBeInTheDocument());
    expect(apiMocks.updateAgentRuntimeConfig).not.toHaveBeenCalled();
  });

  it("shows official Codex context only when model metadata provides it", async () => {
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [{
        ...runtimeSnapshot.configs[1],
        id: "codex-local",
        fileName: "codex-local.json",
        name: "codex-local",
        authMode: "inherited",
        baseUrl: "",
        apiKey: "",
        models: [
          { id: "gpt-56", name: "gpt-5.6-terra", contextWindowK: 258.4 },
          { id: "gpt-54-mini", name: "gpt-5.4-mini" },
        ],
      }],
    });

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("spinbutton", { name: "模型 gpt-5.6-terra 上下文窗口（K）" })).toHaveValue(258.4);
    expect(screen.getByRole("spinbutton", { name: "模型 gpt-5.4-mini 上下文窗口（K）" })).toHaveValue(256);
    expect(screen.queryByRole("combobox", { name: /上下文窗口/ })).not.toBeInTheDocument();
  });

  it("blocks deleting a model that is still bound to a role", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);

    render(
      <AppSettingsDialog
        open
        onOpenChange={vi.fn()}
        initialSection="agents"
        initialAgentTab="runtime_configs"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载智能体配置...")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "删除模型 mimo-v2.5" }));

    expect(screen.getByText(/正在使用该模型，请先调整角色绑定/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("mimo-v2.5")).toBeInTheDocument();
  });
});

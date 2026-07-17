import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppSettingsDialog from "./AppSettingsDialog";
import { useThemeStore } from "../stores/useThemeStore";

const apiMocks = vi.hoisted(() => ({
  fetchAgentRuntimeConfig: vi.fn(),
  fetchExperts: vi.fn(),
  createAgentRuntimeConfig: vi.fn(),
  deleteAgentRuntimeConfig: vi.fn(),
  checkAgentRuntimeLocalAuth: vi.fn(),
  refreshAgentRuntimeModels: vi.fn(),
  testAgentRuntimeConnection: vi.fn(),
  updateAgentRuntimeConfig: vi.fn(),
  updateAgentRuntimeRole: vi.fn(),
}));

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
    { role: "leader", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
    { role: "coder", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
    { role: "research", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
    { role: "verify", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
    { role: "codereview", enabled: true, configId: "default-agent-sdk", modelId: "mimo-v25" },
  ],
  configs: [
    {
      id: "default-agent-sdk",
      fileName: "default-agent-sdk.json",
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
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.fetchExperts.mockResolvedValue([]);
    useThemeStore.setState({ theme: "system", resolvedTheme: "dark" });
  });

  it("shows the selected theme in Chinese instead of its internal value", () => {
    render(<AppSettingsDialog open onOpenChange={vi.fn()} />);

    const themeSelect = screen.getByRole("combobox");
    expect(themeSelect).toHaveTextContent("跟随系统");
    expect(themeSelect).not.toHaveTextContent("system");
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
    apiMocks.fetchExperts.mockResolvedValue([{
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
      });
    });
    expect(screen.queryByTestId("role-model-picker")).not.toBeInTheDocument();
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

    expect(screen.getByText(/未命名配置1 · 草稿/)).toBeInTheDocument();
    expect(screen.getAllByText("OpenAI Responses 格式").length).toBeGreaterThan(0);
    expect(screen.getByText("Agent 类型创建后不可更改")).toBeInTheDocument();
    expect(screen.getByText("保存后生成UUID.json")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /SDK/ })).not.toBeInTheDocument();
  });

  it("labels the Claude Code local auth choice explicitly", async () => {
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

    expect(screen.getByRole("button", { name: /Claude Code本地账号登录态/ })).toBeInTheDocument();
  });

  it("checks local auth status for inherited configs without exposing API key fields", async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: [
        {
          ...runtimeSnapshot.configs[0],
          id: "claude-local",
          fileName: "claude-local.json",
          name: "claude-local",
          authMode: "inherited",
          apiKey: "",
        },
      ],
    });
    apiMocks.checkAgentRuntimeLocalAuth.mockResolvedValue({
      sdk: "claudecode",
      status: "detected",
      message: "已检测到 Claude Code 本地账号登录态。",
      path: "/tmp/.claude.json",
      source: "file",
      accountHint: "claude@example.com",
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

    expect(screen.getByText("Claude Code本地账号登录态")).toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "测试" }).every((button) => button.hasAttribute("disabled"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "检测登录态" }));

    await waitFor(() => {
      expect(apiMocks.checkAgentRuntimeLocalAuth).toHaveBeenCalledWith("claude-local", {
        config: expect.objectContaining({ id: "claude-local", authMode: "inherited" }),
      });
    });
    expect(screen.getByText(/已检测到 Claude Code 本地账号登录态/)).toBeInTheDocument();
    expect(screen.getByText("/tmp/.claude.json")).toBeInTheDocument();
  });

  it("orders provider models descending and inserts a new model on the first row", async () => {
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

    expect(modelValues()).toEqual(["opus", "mimo-v2.5"]);

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    expect(modelValues()).toEqual(["", "opus", "mimo-v2.5"]);
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
        { id: "gpt-54", name: "gpt-5.4" },
        { id: "gpt-55", name: "gpt-5.5" },
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

    expect(screen.getByText("Codex 本地账号登录态")).toBeInTheDocument();
    expect(screen.getByText("可联网刷新 Codex 账号可用模型，并逐个测试")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "刷新可用模型" }));

    await waitFor(() => {
      expect(apiMocks.refreshAgentRuntimeModels).toHaveBeenCalledWith("codex-local", {
        config: expect.objectContaining({ id: "codex-local", authMode: "inherited", sdk: "codex" }),
      });
    });
    expect(screen.getByDisplayValue("gpt-5.5")).toBeInTheDocument();
    expect(screen.getByText(/已刷新 2 个 Codex 可用模型/)).toBeInTheDocument();

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

  it("saves the selected Claude Code 200K or 1M context per model", async () => {
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

    const contextSelect = screen.getByRole("combobox", { name: "模型 mimo-v2.5 上下文大小" });
    expect(contextSelect).toHaveTextContent("200K");
    await user.click(contextSelect);
    await user.click(await screen.findByRole("option", { name: "1M" }));
    await waitFor(() => {
      expect(contextSelect).toHaveTextContent("1M");
    });
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentRuntimeConfig).toHaveBeenCalledWith(
        "default-agent-sdk",
        expect.objectContaining({
          models: [expect.objectContaining({
            id: "mimo-v25",
            name: "mimo-v2.5",
            contextWindowK: 1_000,
          })],
        }),
      );
    });
  });

  it("validates custom Codex context as an integer of at least 128K", async () => {
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

    const input = screen.getByRole("spinbutton", { name: "模型 glm-4.7 上下文大小（K）" });
    await user.clear(input);
    await user.type(input, "127");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("非官方 Codex 上下文不能低于 128K。")).toBeInTheDocument();
    expect(apiMocks.updateAgentRuntimeConfig).not.toHaveBeenCalled();
  });

  it("shows official Codex context as a fixed read-only value", async () => {
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
          { id: "gpt-54-mini", name: "gpt-5.4-mini", contextWindowK: 258.4 },
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

    expect(screen.getByLabelText("模型 gpt-5.6-terra 官方固定上下文")).toHaveTextContent("258K（官方固定）");
    expect(screen.getByLabelText("模型 gpt-5.4-mini 官方固定上下文")).toHaveTextContent("258K（官方固定）");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /上下文大小/ })).not.toBeInTheDocument();
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

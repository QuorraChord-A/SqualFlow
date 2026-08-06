import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFlowStore } from "../stores/useFlowStore";
import LeaderModelSelector from "./LeaderModelSelector";

const apiMocks = vi.hoisted(() => ({
  fetchAgentRuntimeConfig: vi.fn(),
  updateFlowLeaderRuntimeSelection: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  API_BASE: "http://localhost:8001",
  fetchAgentRuntimeConfig: apiMocks.fetchAgentRuntimeConfig,
  updateFlowLeaderRuntimeSelection: apiMocks.updateFlowLeaderRuntimeSelection,
}));

const runtimeSnapshot = {
  roles: [{
    role: "leader",
    enabled: true,
    configId: "default-agent-sdk",
    modelId: "qwen-plus",
    reasoningEffort: "max",
  }],
  configs: [
    {
      id: "default-agent-sdk",
      fileName: "default-agent-sdk.json",
      name: "默认",
      sdk: "claudecode",
      authMode: "apiKey",
      baseUrl: "",
      apiKey: "",
      models: [{ id: "qwen-plus", name: "qwen3.6-plus-2026-04-02" }],
    },
    {
      id: "bailian",
      fileName: "bailian.json",
      name: "百炼",
      sdk: "claudecode",
      authMode: "apiKey",
      baseUrl: "",
      apiKey: "",
      models: [{ id: "qwen-a3b", name: "qwen3.6-35b-a3b" }],
    },
    {
      id: "codex-local",
      fileName: "codex-local.json",
      name: "Codex",
      sdk: "codex",
      authMode: "inherited",
      baseUrl: "",
      apiKey: "",
      models: [
        {
          id: "gpt-55",
          name: "gpt-5.5",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
        {
          id: "gpt-56-terra",
          name: "gpt-5.6-terra",
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          defaultReasoningEffort: "medium",
        },
      ],
    },
    {
      id: "codex-api",
      fileName: "codex-api.json",
      name: "Codex API",
      sdk: "codex",
      authMode: "apiKey",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      models: [{ id: "custom-codex", name: "custom-codex" }],
    },
  ],
};

describe("LeaderModelSelector", () => {
  beforeEach(() => {
    apiMocks.fetchAgentRuntimeConfig.mockReset();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.updateFlowLeaderRuntimeSelection.mockReset();
    apiMocks.updateFlowLeaderRuntimeSelection.mockResolvedValue({
      leader_runtime_config_id: "default-agent-sdk",
      leader_runtime_model_id: "qwen-plus",
      leader_runtime_reasoning_effort: null,
    });
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_sdk: "claudecode",
        leader_runtime_config_id: "default-agent-sdk",
        leader_runtime_model_id: "missing-model",
        leader_runtime_reasoning_effort: null,
      }],
      selectedFlowId: "flow-1",
      selectedFlow: null,
      refreshFlowDetail: vi.fn().mockResolvedValue(undefined),
      refreshFlows: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("shows unconfigured when the flow-bound model id no longer exists", async () => {
    const onConfiguredChange = vi.fn();

    render(<LeaderModelSelector flowId="flow-1" onConfiguredChange={onConfiguredChange} />);

    expect(await screen.findByText("未配置")).toBeInTheDocument();
    await waitFor(() => expect(onConfiguredChange).toHaveBeenLastCalledWith(false));
  });

  it("does not reload model configuration when parent callbacks change identity", async () => {
    const { rerender } = render(
      <LeaderModelSelector
        flowId="flow-1"
        onSelectionChange={() => undefined}
      />,
    );

    await waitFor(() => expect(apiMocks.fetchAgentRuntimeConfig).toHaveBeenCalledTimes(1));

    rerender(
      <LeaderModelSelector
        flowId="flow-1"
        onSelectionChange={() => undefined}
      />,
    );
    rerender(
      <LeaderModelSelector
        flowId="flow-1"
        onSelectionChange={() => undefined}
      />,
    );

    expect(apiMocks.fetchAgentRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("opens provider settings when no model configuration exists", async () => {
    const user = userEvent.setup();
    const onOpenModelSettings = vi.fn();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      roles: [{ role: "leader", enabled: true, configId: "", modelId: "" }],
      configs: [],
    });

    render(
      <LeaderModelSelector
        defaultSelection
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "配置模型" });
    expect(trigger).toHaveTextContent("未配置");
    expect(trigger).toBeEnabled();
    await user.click(trigger);

    expect(onOpenModelSettings).toHaveBeenCalledOnce();
  });

  it("updates only the selected flow when choosing a model", async () => {
    const user = userEvent.setup();

    render(<LeaderModelSelector flowId="flow-1" />);

    const trigger = await screen.findByRole("button", { name: "切换模型" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /默认/ }));
    await user.click(await screen.findByRole("button", { name: /qwen3\.6-plus-2026-04-02/ }));

    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      configId: "default-agent-sdk",
      modelId: "qwen-plus",
    }));
  });

  it("allows switching providers inside the Flow-locked SDK", async () => {
    const user = userEvent.setup();

    render(<LeaderModelSelector flowId="flow-1" />);

    await user.click(await screen.findByRole("button", { name: "切换模型" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "百炼" }));
    const model = await screen.findByRole("button", { name: "qwen3.6-35b-a3b" });
    expect(model).toBeEnabled();
    await user.click(model);

    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      configId: "bailian",
      modelId: "qwen-a3b",
    }));
  });

  it("reports the provider selection as updating until the flow save completes", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    const onUpdatingChange = vi.fn();
    let finishUpdate: (() => void) | undefined;
    apiMocks.updateFlowLeaderRuntimeSelection.mockImplementation(() => new Promise((resolve) => {
      finishUpdate = () => resolve({
        leader_runtime_config_id: "bailian",
        leader_runtime_model_id: "qwen-a3b",
        leader_runtime_reasoning_effort: null,
      });
    }));

    render(
      <LeaderModelSelector
        flowId="flow-1"
        onSelectionChange={onSelectionChange}
        onUpdatingChange={onUpdatingChange}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "切换模型" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "百炼" }));
    await user.click(await screen.findByRole("button", { name: "qwen3.6-35b-a3b" }));

    await waitFor(() => expect(onUpdatingChange).toHaveBeenLastCalledWith(true));
    expect(finishUpdate).toBeTypeOf("function");
    finishUpdate?.();
    await waitFor(() => expect(onUpdatingChange).toHaveBeenLastCalledWith(false));
    expect(onSelectionChange).toHaveBeenCalledWith({
      configId: "bailian",
      modelId: "qwen-a3b",
    });
  });

  it("keeps another SDK visible but disables all of its models", async () => {
    const user = userEvent.setup();

    render(<LeaderModelSelector flowId="flow-1" />);

    await user.click(await screen.findByRole("button", { name: "切换模型" }));
    const codexConfig = screen.getByRole("button", { name: "Codex" });
    fireEvent.mouseEnter(codexConfig);

    expect(codexConfig).toHaveAttribute("aria-disabled", "true");
    expect(codexConfig).toHaveClass("cursor-not-allowed");
    expect(await screen.findByText("当前 Flow 已锁定 ClaudeCode，不能切换到 Codex。")).toBeInTheDocument();
    const model = screen.getByRole("button", { name: "gpt-5.5" });
    expect(model).toBeDisabled();
    await user.click(model);
    expect(apiMocks.updateFlowLeaderRuntimeSelection).not.toHaveBeenCalled();
  });

  it("keeps Codex official and custom runtime profiles visible but separated", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_sdk: "codex",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: "medium",
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);

    await user.click(await screen.findByRole("button", { name: "切换模型" }));
    const customConfig = screen.getByRole("button", { name: "Codex API" });
    fireEvent.mouseEnter(customConfig);

    expect(customConfig).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText("Codex 官方登录态与非官方配置不能在同一 Flow 内直接切换。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "custom-codex" })).toBeDisabled();
  });

  it("updates Codex reasoning effort for the selected flow", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: null,
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);

    expect(await screen.findByRole("button", { name: "切换模型" })).toHaveTextContent("gpt-5.5");
    expect(screen.getByRole("button", { name: "调整 Codex 推理强度" })).toHaveTextContent("中");

    await user.click(screen.getByRole("button", { name: "调整 Codex 推理强度" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Codex 推理强度" }), { key: "ArrowRight" });

    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      reasoningEffort: "high",
    }));
  });

  it("uses a distinct Claude SDK effort menu and persists the selected SDK value", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_sdk: "claudecode",
        leader_runtime_config_id: "default-agent-sdk",
        leader_runtime_model_id: "qwen-plus",
        leader_runtime_reasoning_effort: "high",
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);

    const trigger = await screen.findByRole("button", { name: "调整 Claude effort" });
    expect(trigger).toHaveTextContent("high");
    await user.click(trigger);

    const popover = screen.getByTestId("claude-effort-popover");
    expect(popover).toHaveAttribute("data-effort-variant", "claude-menu");
    expect(screen.getByTestId("leader-model-selector")).toHaveAttribute("data-effort-layout", "claude-menu");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(screen.getByRole("menuitemradio", { name: /xhigh/ })).toBeInTheDocument();
    expect(popover).not.toHaveTextContent("Claude Agent SDK");
    expect(popover).not.toHaveTextContent("更快，适合简单任务");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemradio", { name: /xhigh/ }));

    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      reasoningEffort: "xhigh",
    }));
    await waitFor(() => expect(screen.queryByTestId("claude-effort-popover")).not.toBeInTheDocument());
  });

  it("shows the fixed Codex effort scale when model metadata omits it", async () => {
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      configs: runtimeSnapshot.configs.map((config) => config.id === "codex-local"
        ? { ...config, models: [{ id: "gpt-55", name: "gpt-5.5" }] }
        : config),
    });
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: null,
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);

    expect(await screen.findByRole("button", { name: "调整 Codex 推理强度" })).toBeInTheDocument();
  });

  it("previews Codex reasoning effort while dragging and commits on release", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: null,
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);

    const effortTrigger = await screen.findByRole("button", { name: "调整 Codex 推理强度" });
    expect(effortTrigger).toHaveTextContent("中");

    await user.click(effortTrigger);
    const slider = screen.getByRole("slider", { name: "Codex 推理强度" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      bottom: 28,
      height: 28,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(slider, { buttons: 1, clientX: 61, pointerId: 1 });

    expect(apiMocks.updateFlowLeaderRuntimeSelection).not.toHaveBeenCalled();
    expect(effortTrigger).toHaveTextContent("超高");
    expect(screen.getByTestId("codex-effort-current-label")).toHaveTextContent("超高");
    expect(slider).toHaveAttribute("aria-valuetext", "超高");

    fireEvent.pointerUp(slider, { clientX: 61, pointerId: 1 });

    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      reasoningEffort: "xhigh",
    }));
  });

  it("uses the official visual treatment only for inherited Codex auth", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-55",
        leader_runtime_reasoning_effort: "medium",
      }],
    });

    const { rerender } = render(<LeaderModelSelector flowId="flow-1" />);
    await user.click(await screen.findByRole("button", { name: "调整 Codex 推理强度" }));
    expect(screen.getByTestId("codex-effort-popover")).toHaveAttribute("data-effort-variant", "official");
    expect(screen.getByTestId("codex-effort-popover")).toHaveTextContent("中");
    expect(screen.queryByText("更快")).not.toBeInTheDocument();
    expect(screen.queryByText("更智能")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("codex-effort-particle")).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: "调整 Codex 推理强度" }));
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-api",
        leader_runtime_model_id: "custom-codex",
        leader_runtime_reasoning_effort: "medium",
      }],
    });
    rerender(<LeaderModelSelector flowId="flow-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "切换模型" })).toHaveTextContent("custom-codex");
      expect(screen.queryByRole("button", { name: "调整 Codex 推理强度" })).not.toBeInTheDocument();
    });
  });

  it("matches the compact official Codex scale and reveals the effect only at the highest level", async () => {
    const user = userEvent.setup();
    useFlowStore.setState({
      flows: [{
        id: "flow-1",
        name: "Flow 1",
        description: "",
        type: "full",
        status: "ready",
        current_stage: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        leader_runtime_config_id: "codex-local",
        leader_runtime_model_id: "gpt-56-terra",
        leader_runtime_reasoning_effort: "medium",
      }],
    });

    render(<LeaderModelSelector flowId="flow-1" />);
    await user.click(await screen.findByRole("button", { name: "调整 Codex 推理强度" }));

    const popover = screen.getByTestId("codex-effort-popover");
    const slider = screen.getByRole("slider", { name: "Codex 推理强度" });
    expect(screen.getByTestId("leader-model-selector")).toHaveAttribute("data-effort-layout", "combined");
    expect(screen.getByRole("button", { name: "切换模型" })).toHaveTextContent("5.6 Terra");
    expect(screen.getByTestId("codex-effort-trigger-label")).toHaveClass("w-7");
    expect(popover).toHaveClass("w-[225px]");
    expect(slider).toHaveClass("h-8");
    expect(slider).toHaveAttribute("aria-valuemax", "5");
    expect(screen.getByTestId("codex-effort-knob")).toHaveClass("size-8");
    expect(screen.getByTestId("codex-effort-knob")).not.toHaveClass("-translate-x-1/2", "-translate-y-1/2");
    expect(screen.getAllByTestId("codex-effort-particle")).toHaveLength(10);
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      bottom: 32,
      height: 32,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(slider, { clientX: 70, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 70, pointerId: 1 });

    expect(await screen.findByTestId("codex-effort-current-label")).toHaveTextContent("最高");
    expect(screen.getByTestId("codex-effort-trigger-label")).toHaveTextContent("最高");
    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      reasoningEffort: "max",
    }));

    fireEvent.pointerDown(slider, { clientX: 84, pointerId: 2 });
    fireEvent.pointerUp(slider, { clientX: 84, pointerId: 2 });

    expect(await screen.findByTestId("codex-effort-current-label")).toHaveTextContent("极高");
    expect(screen.getByTestId("codex-effort-trigger-label")).toHaveTextContent("极高");
    expect(screen.getAllByTestId("codex-effort-particle")).toHaveLength(10);
    expect(screen.getByTestId("codex-effort-fill")).toHaveStyle({ clipPath: "inset(0 0% 0 0 round 999px)" });
    expect(screen.getByTestId("codex-effort-knob")).toHaveStyle({ left: "calc(100% - 16px)" });
    await waitFor(() => expect(apiMocks.updateFlowLeaderRuntimeSelection).toHaveBeenCalledWith("flow-1", {
      reasoningEffort: "ultra",
    }));
  });

  it("supports local default selection before a flow exists", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();

    render(
      <LeaderModelSelector
        defaultSelection
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "切换模型" })).toHaveTextContent("qwen3.6-plus-2026-04-02"));
    await user.click(screen.getByRole("button", { name: "切换模型" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /百炼/ }));
    await user.click(await screen.findByRole("button", { name: /qwen3\.6-35b-a3b/ }));

    expect(onSelectionChange).toHaveBeenCalledWith({
      configId: "bailian",
      modelId: "qwen-a3b",
    });
    expect(apiMocks.updateFlowLeaderRuntimeSelection).not.toHaveBeenCalled();
  });

  it("uses the Leader role effort as the default for a new flow", async () => {
    const onSelectionReasoningEffortChange = vi.fn();

    render(
      <LeaderModelSelector
        defaultSelection
        onSelectionReasoningEffortChange={onSelectionReasoningEffortChange}
      />,
    );

    expect(await screen.findByRole("button", { name: "调整 Claude effort" })).toHaveTextContent("max");
    await waitFor(() => expect(onSelectionReasoningEffortChange).toHaveBeenCalledWith("max"));
  });

  it("supports local Codex effort selection before a flow exists without a lightning icon", async () => {
    const user = userEvent.setup();
    const onSelectionReasoningEffortChange = vi.fn();

    render(
      <LeaderModelSelector
        defaultSelection
        selection={{ configId: "codex-local", modelId: "gpt-56-terra" }}
        selectionReasoningEffort="medium"
        onSelectionReasoningEffortChange={onSelectionReasoningEffortChange}
      />,
    );

    const selector = await screen.findByTestId("leader-model-selector");
    expect(screen.getByRole("button", { name: "切换模型" })).toHaveTextContent("5.6 Terra");
    expect(selector.querySelector(".lucide-zap")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调整 Codex 推理强度" })).toHaveTextContent("中");

    await user.click(screen.getByRole("button", { name: "调整 Codex 推理强度" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Codex 推理强度" }), { key: "End" });

    expect(onSelectionReasoningEffortChange).toHaveBeenCalledWith("ultra");
    expect(apiMocks.updateFlowLeaderRuntimeSelection).not.toHaveBeenCalled();
  });
});

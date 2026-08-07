import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SquadFlow } from "../types";
import { setupRichEditorUser } from "../../test/rich-editor-user";

const userEvent = { setup: setupRichEditorUser };

const mocks = vi.hoisted(() => ({
  createFlow: vi.fn(),
  send: vi.fn(),
}));

const project: Project = {
  id: "project-1",
  name: "演示项目",
  local_path: "/tmp/demo",
  description: "",
};

vi.mock("../stores/useProjectStore", () => ({
  useProjectStore: () => ({
    projects: [project],
    selectedProjectId: project.id,
    selectProject: vi.fn(),
    openProjectDirectory: vi.fn(),
    createProject: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("../stores/useFlowStore", () => ({
  useFlowStore: (selector: (state: { handleCreateFlow: typeof mocks.createFlow }) => unknown) => selector({
    handleCreateFlow: mocks.createFlow,
  }),
}));

vi.mock("../lib/ws", () => ({ wsClient: { send: mocks.send } }));
vi.mock("../hooks/useNativeContextSlashMenu", () => ({
  useNativeContextSlashMenu: () => ({ skills: [], mcpServers: [], loading: false, error: null }),
}));
vi.mock("./LeaderModelSelector", async () => {
  const React = await import("react");
  return {
    default: (props: {
      onSelectionChange?: (selection: { configId: string; modelId: string }) => void;
      onConfiguredChange?: (configured: boolean) => void;
    }) => {
      React.useEffect(() => {
        props.onSelectionChange?.({ configId: "runtime-1", modelId: "model-1" });
        props.onConfiguredChange?.(true);
      }, []);
      return <div aria-label="Leader 模型">测试模型</div>;
    },
  };
});

import NewTaskView from "./NewTaskView";

const createdFlow: SquadFlow = {
  id: "flow-new",
  name: "配置恢复",
  type: "full",
  status: "ready",
  project_id: project.id,
  created_at: "2026-08-07T00:00:00.000Z",
  updated_at: "2026-08-07T00:00:00.000Z",
};

describe("NewTask Supervisor modes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.createFlow.mockReset().mockResolvedValue(createdFlow);
    mocks.send.mockReset();
  });

  it("stores Plan on the Flow and sends an ordinary mode-free first message", async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);
    await screen.findByLabelText("Leader 模型");
    await user.click(await screen.findByRole("button", { name: "执行模式：自动编辑" }));
    await user.click(screen.getByRole("button", { name: /计划模式：/ }));
    const input = screen.getByRole("textbox", { name: "随心输入" });
    await user.type(input, "先不要改代码，先给我一份配置恢复计划");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(mocks.createFlow).toHaveBeenCalledWith(expect.objectContaining({
      behavior_mode: "plan",
      risk_mode: "auto_edit",
      orchestration_mode: "approval_required",
    }), project.id));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "flow:message",
      flow_id: "flow-new",
      content: "先不要改代码，先给我一份配置恢复计划",
    }));
    const wireMessage = mocks.send.mock.calls[0][0] as Record<string, unknown>;
    expect(wireMessage).not.toHaveProperty("plan_requested");
    expect(wireMessage).not.toHaveProperty("behavior_mode");
    expect(wireMessage).not.toHaveProperty("risk_mode");
  });
});

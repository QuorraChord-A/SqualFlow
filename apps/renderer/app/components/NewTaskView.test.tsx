import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, SquadFlow } from '../types';
import NewTaskView, {
  NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY,
  NEW_TASK_MODE_DEFAULTS_STORAGE_KEY,
} from './NewTaskView';

const defaultProject = {
  id: 'proj-default',
  name: '默认项目',
  local_path: '/Users/test/.squadflow/workspace',
  description: '',
  is_default: true,
} satisfies Project;

const project = {
  id: 'project-ccdev',
  name: 'ccdev',
  local_path: '/Users/test/ccdev',
  description: '',
} satisfies Project;

const createdFlow = {
  id: 'flow-new',
  name: '实现左侧面板',
  description: '实现左侧面板',
  type: 'full',
  status: 'ready',
  current_stage: null,
  project_id: project.id,
  created_at: '2026-06-21T10:00:00.000Z',
  updated_at: '2026-06-21T10:00:00.000Z',
} satisfies SquadFlow;

const projectState = vi.hoisted(() => ({
  projects: [] as Project[],
  selectedProjectId: null as string | null,
  selectProject: vi.fn(),
  openProjectDirectory: vi.fn(),
  createProject: vi.fn(),
  isLoading: false,
}));
const handleCreateFlow = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({
  fetchAgentRuntimeConfig: vi.fn(),
  updateAgentRuntimeConfig: vi.fn(),
  updateAgentRuntimeRole: vi.fn(),
  updateFlowLeaderRuntimeSelection: vi.fn(),
}));

vi.mock('../stores/useProjectStore', () => ({
  useProjectStore: vi.fn(() => projectState),
}));

vi.mock('../stores/useFlowStore', () => ({
  useFlowStore: vi.fn((selector: (state: {
    flows: SquadFlow[];
    selectedFlow: null;
    handleCreateFlow: typeof handleCreateFlow;
    refreshFlowDetail: () => Promise<void>;
    refreshFlows: () => Promise<void>;
  }) => unknown) =>
    selector({
      flows: [],
      selectedFlow: null,
      handleCreateFlow,
      refreshFlowDetail: vi.fn().mockResolvedValue(undefined),
      refreshFlows: vi.fn().mockResolvedValue(undefined),
    }),
  ),
}));

vi.mock('../lib/ws', () => ({
  wsClient: {
    send: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  API_BASE: 'http://localhost:8001',
  fetchAgentRuntimeConfig: apiMocks.fetchAgentRuntimeConfig,
  updateAgentRuntimeConfig: apiMocks.updateAgentRuntimeConfig,
  updateAgentRuntimeRole: apiMocks.updateAgentRuntimeRole,
  updateFlowLeaderRuntimeSelection: apiMocks.updateFlowLeaderRuntimeSelection,
}));

const runtimeSnapshot = {
  roles: [
    { role: 'leader', enabled: true, configId: 'default-agent-sdk' },
    { role: 'coder', enabled: true, configId: 'default-agent-sdk' },
    { role: 'research', enabled: true, configId: 'default-agent-sdk' },
    { role: 'verify', enabled: true, configId: 'default-agent-sdk' },
    { role: 'codereview', enabled: true, configId: 'default-agent-sdk' },
  ],
  configs: [
    {
      id: 'default-agent-sdk',
      fileName: 'default-agent-sdk.json',
      name: 'mimo',
      sdk: 'claudecode',
      authMode: 'apiKey',
      baseUrl: 'https://example.test/anthropic',
      apiKey: '',
      models: [{ id: 'mimo-v25', name: 'mimo-v2.5' }],
    },
    {
      id: 'bailian',
      fileName: 'bailian.json',
      name: '百炼',
      sdk: 'claudecode',
      authMode: 'apiKey',
      baseUrl: 'https://dashscope.example/anthropic',
      apiKey: '',
      models: [
        { id: 'qwen-flash', name: 'qwen3.6-flash' },
        { id: 'qwen-a3b', name: 'qwen3.6-35b-a3b' },
      ],
    },
    {
      id: 'codex-local',
      fileName: 'codex-local.json',
      name: 'Codex',
      sdk: 'codex',
      authMode: 'inherited',
      baseUrl: '',
      apiKey: '',
      models: [{
        id: 'gpt-56-terra',
        name: 'gpt-5.6-terra',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'medium',
      }],
    },
    {
      id: 'codex-api',
      fileName: 'codex-api.json',
      name: 'Codex API',
      sdk: 'codex',
      authMode: 'apiKey',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-test',
      models: [{ id: 'qwen-plus', name: 'qwen3.7-plus' }],
    },
  ],
};

describe('NewTaskView', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    projectState.projects = [defaultProject, project];
    projectState.selectedProjectId = project.id;
    projectState.selectProject.mockReset();
    projectState.openProjectDirectory.mockReset();
    projectState.createProject.mockReset();
    projectState.createProject.mockResolvedValue({ project: defaultProject });
    handleCreateFlow.mockReset();
    handleCreateFlow.mockResolvedValue(createdFlow);
    apiMocks.fetchAgentRuntimeConfig.mockReset();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot);
    apiMocks.updateAgentRuntimeConfig.mockReset();
    apiMocks.updateAgentRuntimeConfig.mockResolvedValue(runtimeSnapshot.configs[1]);
    apiMocks.updateAgentRuntimeRole.mockReset();
    apiMocks.updateAgentRuntimeRole.mockResolvedValue({ role: 'leader', enabled: true, configId: 'bailian' });
    apiMocks.updateFlowLeaderRuntimeSelection.mockReset();
    apiMocks.updateFlowLeaderRuntimeSelection.mockResolvedValue({
      leader_runtime_config_id: 'bailian',
      leader_runtime_model_id: 'qwen-a3b',
    });
    const { wsClient } = await import('../lib/ws');
    vi.mocked(wsClient.send).mockReset();
  });

  it('creates a task in the selected project and sends the first prompt', async () => {
    const user = userEvent.setup();
    const onTaskCreated = vi.fn();
    const { wsClient } = await import('../lib/ws');

    render(<NewTaskView onTaskCreated={onTaskCreated} />);

    expect(screen.getByRole('heading', { name: /我们应该在\s+ccdev\s+中做些什么？/ })).toBeInTheDocument();
    const input = screen.getByPlaceholderText('随心输入');
    await user.type(input, '实现左侧面板');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(handleCreateFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '实现左侧面板',
          description: '实现左侧面板',
          type: 'full',
          leader_runtime_config_id: 'default-agent-sdk',
          leader_runtime_model_id: 'mimo-v25',
        }),
        project.id,
      );
    });
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'flow:message',
      flow_id: createdFlow.id,
      content: '实现左侧面板',
      client_message_id: expect.stringMatching(/^msg-user-/),
    }));
    expect(onTaskCreated).toHaveBeenCalledWith(
      createdFlow.id,
      expect.objectContaining({
        role: 'user',
        content: '实现左侧面板',
        parts: [{ type: 'text', text: '实现左侧面板' }],
      }),
    );
  });

  it('creates a task with a one-shot Plan mode request', async () => {
    const user = userEvent.setup();
    const { wsClient } = await import('../lib/ws');

    render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '执行模式：自动编辑' }));
    await user.click(screen.getByRole('button', { name: /计划模式：/ }));
    expect(screen.getByRole('button', { name: '执行模式：计划模式' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('随心输入'), '先写规格');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(handleCreateFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '先写规格',
          description: '先写规格',
        }),
        project.id,
      );
    });
    expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'flow:message',
      flow_id: createdFlow.id,
      content: '先写规格',
      spec_requested: true,
    }));
  });

  it('persists new-Flow mode choices only as defaults for later new Flows', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '执行模式：自动编辑' }));
    await user.click(screen.getByRole('button', { name: /完全访问：/ }));
    await user.click(screen.getByRole('button', { name: '添加消息选项' }));
    expect(screen.getByRole('button', { name: '编排审批设置，当前：需要批准' })).toHaveTextContent('需要批准');
    await user.click(screen.getByRole('button', { name: '编排审批设置，当前：需要批准' }));
    await user.click(screen.getByRole('button', { name: '自动执行' }));

    await user.type(screen.getByPlaceholderText('随心输入'), '使用自动档创建');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(handleCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({ risk_mode: 'full_access', plan_approval: 'off' }),
      project.id,
    ));
    expect(screen.getByRole('button', { name: '执行模式：完全访问' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(NEW_TASK_MODE_DEFAULTS_STORAGE_KEY) ?? '{}')).toEqual({
      riskMode: 'full_access',
      planApproval: 'off',
    });

    unmount();
    render(<NewTaskView />);
    expect(await screen.findByRole('button', { name: '执行模式：完全访问' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '添加消息选项' }));
    expect(screen.getByRole('button', { name: '编排审批设置，当前：自动执行' })).toHaveTextContent('自动执行');
  });

  it('does not submit while IME composition is confirming text', async () => {
    render(<NewTaskView />);

    const input = screen.getByPlaceholderText('随心输入');
    fireEvent.change(input, { target: { value: '他' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(handleCreateFlow).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(handleCreateFlow).not.toHaveBeenCalled();
  });

  it('searches projects by absolute path without case sensitivity', async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '选择项目' }));
    const search = screen.getByRole('textbox', { name: '搜索项目路径' });
    await user.type(search, 'uSeRs/TeSt/C');

    expect(screen.getByText('/Users/test/ccdev')).toBeInTheDocument();
    expect(screen.queryByText('/Users/test/.squadflow/workspace')).not.toBeInTheDocument();
  });

  it('opens the native folder picker from the add-project submenu', async () => {
    const user = userEvent.setup();
    projectState.openProjectDirectory.mockResolvedValue(project);
    render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '选择项目' }));
    await user.click(screen.getByRole('button', { name: '添加新项目' }));
    await user.click(screen.getByRole('button', { name: '使用现有文件夹' }));

    expect(projectState.openProjectDirectory).toHaveBeenCalledTimes(1);
  });

  it('hides the add-project submenu after the pointer leaves its hover zone', async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '选择项目' }));
    const addProjectButton = screen.getByRole('button', { name: '添加新项目' });
    await user.hover(addProjectButton);

    expect(screen.getByRole('button', { name: '使用现有文件夹' })).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId('add-project-menu-zone'));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '使用现有文件夹' })).not.toBeInTheDocument();
    });
  });

  it('uses the default available Leader model when creating a task', async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);

    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('mimo-v2.5'));

    await user.type(screen.getByPlaceholderText('随心输入'), '用默认模型创建');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(handleCreateFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          leader_runtime_config_id: 'default-agent-sdk',
          leader_runtime_model_id: 'mimo-v25',
        }),
        project.id,
      );
    });
  });

  it('keeps the composer disabled until the new-flow runtime selection is ready', async () => {
    const user = userEvent.setup();
    let resolveRuntime!: (snapshot: typeof runtimeSnapshot) => void;
    apiMocks.fetchAgentRuntimeConfig.mockReturnValue(new Promise((resolve) => {
      resolveRuntime = resolve;
    }));
    render(<NewTaskView />);

    const input = screen.getByPlaceholderText('随心输入');
    await user.type(input, '不要在模型选择完成前创建');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(handleCreateFlow).not.toHaveBeenCalled();

    resolveRuntime(runtimeSnapshot);
    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('mimo-v2.5'));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送消息' })).not.toBeDisabled());
  });

  it('uses the persisted new-flow default model when creating a task', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY, JSON.stringify({
      configId: 'bailian',
      modelId: 'qwen-a3b',
    }));
    render(<NewTaskView />);

    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('qwen3.6-35b-a3b'));

    await user.type(screen.getByPlaceholderText('随心输入'), '用上次的新建默认模型创建');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(handleCreateFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          leader_runtime_config_id: 'bailian',
          leader_runtime_model_id: 'qwen-a3b',
        }),
        project.id,
      );
    });
  });

  it('selects Codex effort before creation and sends it with the new Flow', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY, JSON.stringify({
      configId: 'codex-local',
      modelId: 'gpt-56-terra',
      reasoningEffort: 'medium',
    }));
    render(<NewTaskView />);

    expect(await screen.findByRole('button', { name: '切换模型' })).toHaveTextContent('5.6 Terra');
    expect(screen.getByRole('button', { name: '调整 Codex 推理强度' })).toHaveTextContent('中');
    await user.click(screen.getByRole('button', { name: '调整 Codex 推理强度' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Codex 推理强度' }), { key: 'End' });
    expect(screen.getByRole('button', { name: '调整 Codex 推理强度' })).toHaveTextContent('极高');

    await user.type(screen.getByPlaceholderText('随心输入'), '用最高 Effort 创建');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(handleCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        leader_runtime_config_id: 'codex-local',
        leader_runtime_model_id: 'gpt-56-terra',
        leader_runtime_reasoning_effort: 'ultra',
      }),
      project.id,
    ));
    expect(JSON.parse(window.localStorage.getItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      configId: 'codex-local',
      modelId: 'gpt-56-terra',
      reasoningEffort: 'ultra',
    });
  });

  it('does not show or submit effort for API-key Codex when creating a Flow', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY, JSON.stringify({
      configId: 'codex-api',
      modelId: 'qwen-plus',
      reasoningEffort: 'high',
    }));
    render(<NewTaskView />);

    expect(await screen.findByRole('button', { name: '切换模型' })).toHaveTextContent('qwen3.7-plus');
    expect(screen.queryByRole('button', { name: '调整 Codex 推理强度' })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('随心输入'), 'API Key Codex 创建');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(handleCreateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        leader_runtime_config_id: 'codex-api',
        leader_runtime_model_id: 'qwen-plus',
        leader_runtime_reasoning_effort: undefined,
      }),
      project.id,
    ));
    expect(JSON.parse(window.localStorage.getItem(NEW_TASK_LEADER_RUNTIME_SELECTION_STORAGE_KEY) ?? '{}')).toEqual({
      configId: 'codex-api',
      modelId: 'qwen-plus',
      reasoningEffort: null,
    });
  });

  it('opens the default model picker without mutating global model settings', async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);

    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('mimo-v2.5'));

    await user.click(screen.getByRole('button', { name: '切换模型' }));
    fireEvent.click(screen.getByRole('button', { name: '百炼' }));

    expect(screen.getByText('供应商')).toBeInTheDocument();
    expect(apiMocks.updateAgentRuntimeConfig).not.toHaveBeenCalled();
    expect(apiMocks.updateAgentRuntimeRole).not.toHaveBeenCalled();
  });

  it('opens the model picker on the current Leader provider and model', async () => {
    const user = userEvent.setup();
    apiMocks.fetchAgentRuntimeConfig.mockResolvedValue({
      ...runtimeSnapshot,
      roles: runtimeSnapshot.roles.map((role) => (role.role === 'leader' ? { ...role, configId: 'bailian' } : role)),
      configs: runtimeSnapshot.configs.map((config) => (
        config.id === 'bailian'
          ? {
            ...config,
            models: [
              { id: 'qwen-a3b', name: 'qwen3.6-35b-a3b' },
              { id: 'qwen-flash', name: 'qwen3.6-flash' },
            ],
          }
          : config
      )),
    });
    render(<NewTaskView />);

    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('qwen3.6-35b-a3b'));

    await user.click(screen.getByRole('button', { name: '切换模型' }));

    expect(screen.getByText('供应商')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '百炼' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'qwen3.6-35b-a3b' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mimo-v2.5' })).not.toBeInTheDocument();
  });

  it('hides the model submenu after the pointer leaves the provider and model menus', async () => {
    const user = userEvent.setup();
    render(<NewTaskView />);

    await waitFor(() => expect(screen.getByRole('button', { name: '切换模型' })).toHaveTextContent('mimo-v2.5'));

    await user.click(screen.getByRole('button', { name: '切换模型' }));
    expect(screen.getByRole('button', { name: 'mimo-v2.5' })).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId('runtime-model-menu-zone'));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'mimo-v2.5' })).not.toBeInTheDocument();
    });
  });

  it('creates a named project from the modal', async () => {
    const user = userEvent.setup();
    projectState.createProject.mockResolvedValue({ project });
    render(<NewTaskView />);

    await user.click(screen.getByRole('button', { name: '选择项目' }));
    await user.click(screen.getByRole('button', { name: '添加新项目' }));
    await user.click(screen.getByRole('button', { name: '新建项目' }));

    const input = screen.getByRole('textbox', { name: '项目名称' });
    fireEvent.change(input, { target: { value: 'calculator' } });
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(projectState.createProject).toHaveBeenCalledWith('calculator'));
  });
});

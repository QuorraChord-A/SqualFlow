import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, SquadFlow } from '../types';
import ProjectTaskList from './ProjectTaskList';

const projectState = vi.hoisted(() => ({
  projects: [] as Project[],
  openProjectDirectory: vi.fn(),
  deleteProject: vi.fn(),
}));
const flowState = vi.hoisted(() => ({
  flows: [] as SquadFlow[],
  selectedFlowId: null as string | null,
  setFlowPinned: vi.fn(),
}));

vi.mock('../stores/useProjectStore', () => ({
  useProjectStore: vi.fn(() => projectState),
}));

vi.mock('../stores/useFlowStore', () => ({
  useFlowStore: vi.fn(() => flowState),
}));

function project(id: string, name: string, isDefault = false): Project {
  return {
    id,
    name,
    local_path: `/tmp/${name}`,
    description: '',
    is_default: isDefault,
  };
}

function flow(
  id: string,
  name: string,
  projectId: string | null,
  overrides: Partial<SquadFlow> = {},
): SquadFlow {
  return {
    id,
    name,
    description: '',
    type: 'full',
    status: 'idle',
    current_stage: null,
    project_id: projectId,
    created_at: '2026-06-20T10:00:00.000Z',
    updated_at: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof ProjectTaskList>> = {}) {
  return render(
    <ProjectTaskList
      onNewTask={vi.fn()}
      onRefresh={vi.fn()}
      onSelectTask={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ProjectTaskList', () => {
  beforeEach(() => {
    localStorage.clear();
    projectState.projects = [];
    projectState.openProjectDirectory.mockReset();
    projectState.deleteProject.mockReset();
    flowState.flows = [];
    flowState.selectedFlowId = null;
    flowState.setFlowPinned.mockReset();
  });

  it('shows 暂无任务 only for projects that have no tasks', () => {
    projectState.projects = [project('project-empty', 'ccdev'), project('project-used', 'squadflow')];
    flowState.flows = [flow('flow-1', '实现侧边栏', 'project-used')];

    renderList();

    const emptyGroup = screen.getByTestId('project-group-project-empty');
    const usedGroup = screen.getByTestId('project-group-project-used');
    expect(within(emptyGroup).getByText('暂无任务')).toBeInTheDocument();
    expect(within(usedGroup).queryByText('暂无任务')).not.toBeInTheDocument();
    expect(within(usedGroup).getByText('实现侧边栏')).toBeInTheDocument();
  });

  it('groups unbound tasks under the collapsible default project', () => {
    projectState.projects = [project('proj-default', '默认项目', true)];
    flowState.flows = [flow('flow-legacy', '旧任务', null)];

    renderList();

    const defaultGroup = screen.getByTestId('project-group-proj-default');
    expect(within(defaultGroup).getByText('默认项目')).toBeInTheDocument();
    expect(within(defaultGroup).getByText('旧任务')).toBeInTheDocument();

    fireEvent.click(within(defaultGroup).getByRole('button', { name: '默认项目' }));
    expect(within(defaultGroup).getByTestId('project-group-drawer-proj-default')).toHaveAttribute('data-state', 'closed');
    expect(within(defaultGroup).getByTestId('project-group-drawer-proj-default')).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens the new-task page from the primary action', () => {
    const onNewTask = vi.fn();
    renderList({ onNewTask });

    fireEvent.click(screen.getByRole('button', { name: '新建Flow' }));
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it('separates pinned tasks from project task groups', () => {
    projectState.projects = [project('project-1', 'ccdev')];
    flowState.flows = [
      flow('flow-pinned', '置顶任务 A', 'project-1', { is_pinned: true }),
      flow('flow-regular', '普通任务 B', 'project-1'),
    ];

    renderList();

    const pinnedSection = screen.getByRole('heading', { name: '置顶' }).closest('section');
    const projectGroup = screen.getByTestId('project-group-project-1');
    expect(pinnedSection).not.toBeNull();
    expect(within(pinnedSection as HTMLElement).getByText('置顶任务 A')).toBeInTheDocument();
    expect(within(pinnedSection as HTMLElement).queryByText('普通任务 B')).not.toBeInTheDocument();
    expect(within(projectGroup).getByText('普通任务 B')).toBeInTheDocument();
    expect(within(projectGroup).queryByText('置顶任务 A')).not.toBeInTheDocument();
  });

  it('collapses all projects and restores the previously expanded groups', async () => {
    const user = userEvent.setup();
    projectState.projects = [project('project-a', 'A'), project('project-b', 'B')];
    flowState.flows = [flow('flow-a', '任务 A', 'project-a'), flow('flow-b', '任务 B', 'project-b')];

    renderList();

    await user.click(screen.getByRole('button', { name: '全部收起' }));
    expect(within(screen.getByTestId('project-group-project-a')).getByRole('button', { name: 'A' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(screen.getByTestId('project-group-project-b')).getByRole('button', { name: 'B' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('project-group-drawer-project-a')).toHaveAttribute('data-state', 'closed');
    expect(screen.getByTestId('project-group-drawer-project-a')).toHaveClass('grid-rows-[0fr]');

    await user.click(screen.getByRole('button', { name: '恢复之前展开的分组' }));
    expect(within(screen.getByTestId('project-group-project-a')).getByRole('button', { name: 'A' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByTestId('project-group-project-b')).getByRole('button', { name: 'B' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('project-group-drawer-project-a')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('project-group-drawer-project-a')).toHaveClass('grid-rows-[1fr]');
  });

  it('exposes sidebar organization and sorting controls from the options menu', async () => {
    projectState.projects = [project('project-a', 'A')];

    renderList();

    const optionsButton = screen.getByRole('button', { name: '项目列表选项' });
    fireEvent.pointerDown(optionsButton, { button: 0 });
    fireEvent.click(optionsButton);
    await waitFor(() => expect(optionsButton).toHaveAttribute('aria-expanded', 'true'));
    expect(await screen.findByRole('menuitemradio', { name: '按项目' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '近期项目' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '按时间顺序' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '下移' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '上移' })).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitemradio', { name: '创建时间' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '更新时间' })).toBeInTheDocument();
  });

  it('opens the native project picker from the project header', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const addedProject = project('project-added', 'added');
    projectState.openProjectDirectory.mockResolvedValue(addedProject);

    renderList({ onRefresh });
    await user.click(screen.getByRole('button', { name: '添加项目' }));

    expect(projectState.openProjectDirectory).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('deletes a project from the project row menu', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    projectState.projects = [project('project-a', 'A')];
    projectState.deleteProject.mockResolvedValue(true);

    renderList({ onRefresh });

    const projectGroup = screen.getByTestId('project-group-project-a');
    const optionsButton = within(projectGroup).getByRole('button', { name: 'A 项目选项' });
    fireEvent.pointerDown(optionsButton, { button: 0 });
    fireEvent.click(optionsButton);
    await user.click(await screen.findByRole('menuitem', { name: '删除项目' }));

    expect(projectState.deleteProject).toHaveBeenCalledWith('project-a');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

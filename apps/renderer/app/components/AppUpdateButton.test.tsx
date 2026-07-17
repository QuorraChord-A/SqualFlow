import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppUpdateButton from './AppUpdateButton';
import { useFlowStore } from '../stores/useFlowStore';
import type { DesktopUpdateBridge, DesktopUpdateState } from '../lib/desktopUpdate';
import type { SquadFlow } from '../types';

const readyState: DesktopUpdateState = {
  enabled: true,
  status: 'ready',
  currentVersion: '0.1.0',
  availableVersion: '0.2.0',
  notes: '修复若干问题',
  progress: 100,
  error: null,
};

function installBridge(state: DesktopUpdateState) {
  const bridge: DesktopUpdateBridge = {
    getState: vi.fn().mockResolvedValue(state),
    check: vi.fn().mockResolvedValue(state),
    install: vi.fn().mockResolvedValue(true),
    onState: vi.fn().mockReturnValue(() => {}),
  };
  window.squadflowDesktopUpdate = bridge;
  return bridge;
}

function activeFlow(id: string): SquadFlow {
  return {
    id,
    name: `Flow ${id}`,
    description: '',
    type: 'full',
    status: 'active',
    current_stage: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

afterEach(() => {
  delete window.squadflowDesktopUpdate;
  useFlowStore.setState({ flows: [] });
});

describe('AppUpdateButton', () => {
  it('restarts immediately from the ready state when no flow is running', async () => {
    const user = userEvent.setup();
    const bridge = installBridge(readyState);

    render(<AppUpdateButton />);

    const button = await screen.findByRole('button', { name: '重启并更新 SquadFlow 到 0.2.0' });
    expect(button).toHaveTextContent('更新');
    expect(button.className).toContain('bg-emerald-400');

    await user.click(button);
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before restarting while flows are running', async () => {
    const user = userEvent.setup();
    const bridge = installBridge(readyState);
    useFlowStore.setState({ flows: [activeFlow('f1'), activeFlow('f2')] });

    render(<AppUpdateButton />);

    await user.click(await screen.findByRole('button', { name: '重启并更新 SquadFlow 到 0.2.0' }));
    expect(bridge.install).not.toHaveBeenCalled();
    expect(await screen.findByText('重启并更新')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '中断并重启' }));
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it('shows download progress and opens details with release notes on click', async () => {
    const user = userEvent.setup();
    installBridge({ ...readyState, status: 'downloading', progress: 42 });

    render(<AppUpdateButton />);

    const trigger = await screen.findByRole('button', { name: '正在下载 SquadFlow 更新，42%' });
    expect(trigger).toHaveTextContent('42%');

    await user.click(trigger);
    expect(await screen.findByText('正在下载 0.2.0，42%')).toBeInTheDocument();
    expect(screen.getByText('修复若干问题')).toBeInTheDocument();
  });

  it('stays hidden when automatic updates are unavailable', async () => {
    installBridge({ ...readyState, enabled: false, status: 'idle', notes: null });

    render(<AppUpdateButton />);

    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('stays hidden after checking confirms the current version is latest', async () => {
    installBridge({ ...readyState, status: 'idle', availableVersion: null, notes: null, progress: null });

    render(<AppUpdateButton />);

    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('renders nothing outside the desktop shell', async () => {
    render(<AppUpdateButton />);
    await waitFor(() => {
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});

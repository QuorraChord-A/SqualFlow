import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppUpdateButton from './AppUpdateButton';
import { useFlowStore } from '../stores/useFlowStore';
import type { DesktopUpdateBridge, DesktopUpdateState } from '../lib/desktopUpdate';
import type { SquadFlow } from '../types';

const readyState: DesktopUpdateState = {
  enabled: true,
  automaticUpdates: true,
  status: 'ready',
  currentVersion: '0.1.0',
  availableVersion: '0.2.0',
  notes: '修复若干问题',
  progress: 100,
  error: null,
  lastCheckedAt: '2026-07-22T20:00:00.000Z',
};

function installBridge(state: DesktopUpdateState) {
  const bridge: DesktopUpdateBridge = {
    getState: vi.fn().mockResolvedValue(state),
    check: vi.fn().mockResolvedValue(state),
    download: vi.fn().mockResolvedValue(true),
    pause: vi.fn().mockResolvedValue(true),
    resume: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
    setAutomaticUpdates: vi.fn().mockResolvedValue(state),
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
    has_active_agent_run: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

afterEach(() => {
  delete window.squadflowDesktopUpdate;
  useFlowStore.setState({ flows: [] });
});

describe('AppUpdateButton', () => {
  it('asks for confirmation before restarting from the ready state', async () => {
    const user = userEvent.setup();
    const bridge = installBridge(readyState);

    render(<AppUpdateButton />);

    const button = await screen.findByRole('button', { name: '重启并更新 SquadFlow 到 0.2.0' });
    expect(button.querySelector('svg')).toBeInTheDocument();
    expect(button.className).toContain('bg-sidebar-accent');
    expect(button).toHaveTextContent('重启');
    await user.hover(button);
    expect(await screen.findByText('重启并更新')).toBeInTheDocument();

    await user.click(button);
    expect(bridge.install).not.toHaveBeenCalled();
    expect(await screen.findByText('SquadFlow 将安装更新并重新打开。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重启' }));
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

  it('does not warn for an active flow that is waiting for user input', async () => {
    const user = userEvent.setup();
    const bridge = installBridge(readyState);
    useFlowStore.setState({ flows: [{ ...activeFlow('f1'), status: 'idle', has_active_agent_run: false }] });

    render(<AppUpdateButton />);

    await user.click(await screen.findByRole('button', { name: '重启并更新 SquadFlow 到 0.2.0' }));
    expect(await screen.findByText('SquadFlow 将安装更新并重新打开。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '中断并重启' })).not.toBeInTheDocument();
    expect(bridge.install).not.toHaveBeenCalled();
  });

  it('shows download progress and opens controls without release notes', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({ ...readyState, status: 'downloading', progress: 42 });

    render(<AppUpdateButton />);

    const trigger = await screen.findByRole('button', { name: '正在下载 SquadFlow 更新，42%' });
    expect(trigger).not.toHaveTextContent('42%');

    await user.click(trigger);
    expect(await screen.findByText('正在下载 0.2.0 · 42%')).toBeInTheDocument();
    expect(screen.queryByText('修复若干问题')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(bridge.pause).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry action visible after a download error', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      ...readyState,
      status: 'error',
      availableVersion: '0.2.0',
      error: '网络连接中断',
      progress: null,
    });

    render(<AppUpdateButton />);

    const retryButton = await screen.findByRole('button', { name: '下载失败，重新下载' });
    await user.click(retryButton);
    expect(bridge.resume).toHaveBeenCalledTimes(1);
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

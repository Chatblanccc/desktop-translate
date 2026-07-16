// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsApp } from './SettingsApp.js';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type SettingsRendererApi,
  type UiShellSnapshot
} from '../shared/shell-api.js';

afterEach(cleanup);

function createSettingsApi(snapshot: UiShellSnapshot = DEFAULT_UI_SHELL_SNAPSHOT): {
  readonly api: SettingsRendererApi;
  readonly setBallVisible: ReturnType<typeof vi.fn>;
  readonly setEdgeSnap: ReturnType<typeof vi.fn>;
  readonly setTheme: ReturnType<typeof vi.fn>;
  readonly resetBallPosition: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  const setBallVisible = vi.fn().mockResolvedValue(undefined);
  const setEdgeSnap = vi.fn().mockResolvedValue(undefined);
  const setTheme = vi.fn().mockResolvedValue(undefined);
  const resetBallPosition = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();

  return {
    api: {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      onSnapshotChanged: vi.fn().mockReturnValue(unsubscribe),
      setBallVisible,
      setEdgeSnap,
      setTheme,
      resetBallPosition
    },
    setBallVisible,
    setEdgeSnap,
    setTheme,
    resetBallPosition,
    unsubscribe
  };
}

describe('SettingsApp', () => {
  it('exposes the planned shell controls and delegates changes', async () => {
    const { api, setBallVisible, setEdgeSnap, setTheme, resetBallPosition } = createSettingsApi();
    render(<SettingsApp api={api} />);

    const visibleToggle = await screen.findByRole('checkbox', { name: /显示悬浮球/ });
    const snapToggle = screen.getByRole('checkbox', { name: /自动吸附屏幕边缘/ });

    await waitFor(() => {
      expect((visibleToggle as HTMLInputElement).disabled).toBe(false);
    });

    fireEvent.click(visibleToggle);
    await waitFor(() => {
      expect(setBallVisible).toHaveBeenCalledWith(false);
      expect((snapToggle as HTMLInputElement).disabled).toBe(false);
    });

    fireEvent.click(snapToggle);
    await waitFor(() => {
      expect(setEdgeSnap).toHaveBeenCalledWith(false);
    });

    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    await waitFor(() => {
      expect(setTheme).toHaveBeenCalledWith('dark');
    });

    fireEvent.click(screen.getByRole('button', { name: '重置位置' }));
    await waitFor(() => {
      expect(resetBallPosition).toHaveBeenCalledOnce();
    });
  });

  it('renders degraded capabilities and the injected phase version', async () => {
    const degradedSnapshot: UiShellSnapshot = {
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: {
        status: 'degraded',
        degradedCapabilities: ['ocr']
      }
    };
    const { api } = createSettingsApi(degradedSnapshot);
    render(<SettingsApp api={api} />);

    await waitFor(() => {
      expect(screen.getByText('原生服务：部分可用')).toBeTruthy();
    });
    expect(screen.getByText('OCR 未配置')).toBeTruthy();
    expect(screen.getByText(/0\.2\.0-phase2/)).toBeTruthy();
  });

  it('shows a safe message when the initial snapshot cannot be loaded', async () => {
    const { api } = createSettingsApi();
    api.getSnapshot = vi.fn().mockRejectedValue(new Error('sensitive native detail'));
    render(<SettingsApp api={api} />);

    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取应用状态');
    expect(screen.queryByText('sensitive native detail')).toBeNull();
  });

  it('keeps settings read-only until the persisted snapshot is available', () => {
    const { api, setBallVisible } = createSettingsApi();
    api.getSnapshot = vi.fn(() => new Promise<UiShellSnapshot>(() => undefined));
    render(<SettingsApp api={api} />);

    const visibleToggle = screen.getByRole('checkbox', { name: /显示悬浮球/ });
    expect((visibleToggle as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(visibleToggle);
    expect(setBallVisible).not.toHaveBeenCalled();
  });

  it('removes the snapshot listener when the settings window unmounts', () => {
    const { api, unsubscribe } = createSettingsApi();
    const view = render(<SettingsApp api={api} />);

    view.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BallApp } from './BallApp.js';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type BallRendererApi,
  type UiShellSnapshot
} from '../shared/shell-api.js';

afterEach(cleanup);

function createBallApi(snapshot: UiShellSnapshot = DEFAULT_UI_SHELL_SNAPSHOT): {
  readonly api: BallRendererApi;
  readonly openSettings: ReturnType<typeof vi.fn>;
  readonly openContextMenu: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  const openSettings = vi.fn().mockResolvedValue(undefined);
  const openContextMenu = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();

  return {
    api: {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      onSnapshotChanged: vi.fn().mockReturnValue(unsubscribe),
      openSettings,
      openContextMenu
    },
    openSettings,
    openContextMenu,
    unsubscribe
  };
}

describe('BallApp', () => {
  it('uses a native button and delegates primary and context-menu actions', async () => {
    const { api, openSettings, openContextMenu } = createBallApi();
    render(<BallApp api={api} />);

    const button = await screen.findByRole('button', { name: /打开桌面翻译设置/ });
    expect(button.tagName).toBe('BUTTON');

    fireEvent.click(button);
    fireEvent.contextMenu(button);

    expect(openSettings).toHaveBeenCalledOnce();
    expect(openContextMenu).toHaveBeenCalledOnce();
  });

  it('reflects degraded native status in its accessible name', async () => {
    const degradedSnapshot: UiShellSnapshot = {
      ...DEFAULT_UI_SHELL_SNAPSHOT,
      native: {
        status: 'degraded',
        degradedCapabilities: ['ocr']
      }
    };
    const { api } = createBallApi(degradedSnapshot);
    render(<BallApp api={api} />);

    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-label')).toContain('部分能力暂不可用');
    });
  });

  it('opens settings from Enter and Space using native button semantics', async () => {
    const user = userEvent.setup();
    const { api, openSettings } = createBallApi();
    render(<BallApp api={api} />);

    const button = await screen.findByRole('button');
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(openSettings).toHaveBeenCalledTimes(2);
  });

  it('removes the snapshot listener when unmounted', () => {
    const { api, unsubscribe } = createBallApi();
    const view = render(<BallApp api={api} />);

    view.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

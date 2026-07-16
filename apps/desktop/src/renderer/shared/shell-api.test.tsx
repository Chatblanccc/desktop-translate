// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type SnapshotChangedListener,
  type ThemeMode,
  type UiShellReaderApi,
  type UiShellSnapshot,
  useDocumentTheme,
  useUiShellSnapshot
} from './shell-api.js';

afterEach(cleanup);

const READY_SNAPSHOT: UiShellSnapshot = {
  ...DEFAULT_UI_SHELL_SNAPSHOT,
  native: {
    status: 'ready',
    degradedCapabilities: []
  }
};

function SnapshotProbe({ api }: { readonly api: UiShellReaderApi }): JSX.Element {
  const state = useUiShellSnapshot(api);
  return <output data-testid="snapshot-state">{`${state.snapshot.native.status}|${state.error ?? ''}`}</output>;
}

function ThemeProbe({ theme }: { readonly theme: ThemeMode }): JSX.Element {
  useDocumentTheme(theme);
  return <output>{theme}</output>;
}

describe('useUiShellSnapshot', () => {
  it('does not let an older initial snapshot overwrite a newer subscription event', async () => {
    let resolveInitial: ((snapshot: UiShellSnapshot) => void) | undefined;
    let listener: SnapshotChangedListener | undefined;
    const api: UiShellReaderApi = {
      getSnapshot: vi.fn(() => new Promise<UiShellSnapshot>((resolve) => {
        resolveInitial = resolve;
      })),
      onSnapshotChanged: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      })
    };
    render(<SnapshotProbe api={api} />);

    act(() => {
      listener?.(READY_SNAPSHOT);
    });
    expect(screen.getByTestId('snapshot-state').textContent).toBe('ready|');

    await act(async () => {
      resolveInitial?.(DEFAULT_UI_SHELL_SNAPSHOT);
      await Promise.resolve();
    });
    expect(screen.getByTestId('snapshot-state').textContent).toBe('ready|');
  });

  it('does not show an initial-load error after a subscription event succeeds', async () => {
    let rejectInitial: ((reason: unknown) => void) | undefined;
    let listener: SnapshotChangedListener | undefined;
    const api: UiShellReaderApi = {
      getSnapshot: vi.fn(() => new Promise<UiShellSnapshot>((_resolve, reject) => {
        rejectInitial = reject;
      })),
      onSnapshotChanged: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      })
    };
    render(<SnapshotProbe api={api} />);

    act(() => {
      listener?.(READY_SNAPSHOT);
    });
    await act(async () => {
      rejectInitial?.(new Error('stale failure'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('snapshot-state').textContent).toBe('ready|');
  });
});

describe('useDocumentTheme', () => {
  it.each(['system', 'light', 'dark'] as const)('applies and cleans up the %s theme', (theme) => {
    const view = render(<ThemeProbe theme={theme} />);
    expect(document.documentElement.dataset.theme).toBe(theme);

    view.unmount();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

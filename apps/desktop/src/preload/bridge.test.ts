import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI_SHELL_SNAPSHOT } from '@desktop-translate/contracts/ui-shell';
import { UI_SHELL_CHANNELS } from '../shared/ui-shell-channels.js';
import {
  createBallRendererBridge,
  createSettingsRendererBridge,
  type IpcRendererBridgePort
} from './bridge.js';

function createIpc(): {
  readonly port: IpcRendererBridgePort;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly removeListener: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn();
  const removeListener = vi.fn();
  return { port: { invoke, on, removeListener }, invoke, on, removeListener };
}

describe('renderer bridges', () => {
  it('validates snapshots returned by Main', async () => {
    const { port, invoke } = createIpc();
    invoke.mockResolvedValueOnce(DEFAULT_UI_SHELL_SNAPSHOT);
    await expect(createBallRendererBridge(port).getSnapshot()).resolves.toEqual(
      DEFAULT_UI_SHELL_SNAPSHOT
    );
    invoke.mockResolvedValueOnce({ version: 999 });
    await expect(createBallRendererBridge(port).getSnapshot()).rejects.toThrow(/invalid/u);
  });

  it('maps settings calls to explicit channels and payloads', async () => {
    const { port, invoke } = createIpc();
    const api = createSettingsRendererBridge(port);
    await api.setBallVisible(false);
    await api.setEdgeSnap(false);
    await api.setTheme('dark');
    await api.resetBallPosition();
    expect(invoke.mock.calls).toEqual([
      [UI_SHELL_CHANNELS.setBallVisible, { value: false }],
      [UI_SHELL_CHANNELS.setEdgeSnap, { value: false }],
      [UI_SHELL_CHANNELS.setTheme, { value: 'dark' }],
      [UI_SHELL_CHANNELS.resetBallPosition]
    ]);
  });

  it('maps ball calls to explicit parameter-free channels', async () => {
    const { port, invoke } = createIpc();
    const api = createBallRendererBridge(port);
    await api.openSettings();
    await api.openContextMenu();
    expect(invoke.mock.calls).toEqual([
      [UI_SHELL_CHANNELS.openSettings],
      [UI_SHELL_CHANNELS.openContextMenu]
    ]);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('gets a valid snapshot through either role API', async () => {
    const { port, invoke } = createIpc();
    invoke.mockResolvedValue(DEFAULT_UI_SHELL_SNAPSHOT);
    await expect(createSettingsRendererBridge(port).getSnapshot()).resolves.toEqual(
      DEFAULT_UI_SHELL_SNAPSHOT
    );
  });

  it('rejects non-void command responses', async () => {
    const { port, invoke } = createIpc();
    invoke.mockResolvedValue({ unexpected: true });
    await expect(createBallRendererBridge(port).openSettings()).rejects.toThrow(/unexpected/u);
    await expect(createSettingsRendererBridge(port).setBallVisible(true)).rejects.toThrow(
      /unexpected/u
    );
  });

  it('strips Electron events and removes only its own listener', () => {
    const { port, on, removeListener } = createIpc();
    const listener = vi.fn();
    const unsubscribe = createBallRendererBridge(port).onSnapshotChanged(listener);
    const wrapped = on.mock.calls[0]?.[1] as ((event: unknown, value: unknown) => void);
    wrapped({ sensitive: true }, DEFAULT_UI_SHELL_SNAPSHOT);
    expect(listener).toHaveBeenCalledWith(DEFAULT_UI_SHELL_SNAPSHOT);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(UI_SHELL_CHANNELS.snapshotChanged, wrapped);
  });

  it('ignores invalid published snapshots and validates listener types', () => {
    const { port, on } = createIpc();
    const listener = vi.fn();
    createSettingsRendererBridge(port).onSnapshotChanged(listener);
    const wrapped = on.mock.calls[0]?.[1] as ((event: unknown, value: unknown) => void);
    wrapped({}, { version: 999 });
    expect(listener).not.toHaveBeenCalled();
    expect(() => createBallRendererBridge(port).onSnapshotChanged(
      undefined as unknown as (snapshot: typeof DEFAULT_UI_SHELL_SNAPSHOT) => void
    )).toThrow(/must be a function/u);
  });
});

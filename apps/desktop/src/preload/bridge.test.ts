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
    await api.setSelectionEnabled(false);
    await api.setOcrActivation('alt-drag');
    await api.setTranslationEnabled(false);
    await api.setTranslationSourceLanguage('auto');
    await api.setTranslationTargetLanguage('en');
    await api.saveBaiduCredentials('app-id', 'secret-key', 1);
    await api.deleteBaiduCredentials();
    await api.openProviderPrivacyPolicy();
    await api.openProviderServiceTerms();
    await api.resetBallPosition();
    await api.clearAllLocalData('清除全部本地数据');
    expect(invoke.mock.calls).toEqual([
      [UI_SHELL_CHANNELS.setBallVisible, { value: false }],
      [UI_SHELL_CHANNELS.setEdgeSnap, { value: false }],
      [UI_SHELL_CHANNELS.setTheme, { value: 'dark' }],
      [UI_SHELL_CHANNELS.setSelectionEnabled, { value: false }],
      [UI_SHELL_CHANNELS.setOcrActivation, { value: 'alt-drag' }],
      [UI_SHELL_CHANNELS.setTranslationEnabled, { value: false }],
      [UI_SHELL_CHANNELS.setTranslationSourceLanguage, { value: 'auto' }],
      [UI_SHELL_CHANNELS.setTranslationTargetLanguage, { value: 'en' }],
      [UI_SHELL_CHANNELS.saveBaiduCredentials, {
        appId: 'app-id', secretKey: 'secret-key', consentVersion: 1
      }],
      [UI_SHELL_CHANNELS.deleteBaiduCredentials],
      [UI_SHELL_CHANNELS.openProviderPrivacyPolicy],
      [UI_SHELL_CHANNELS.openProviderServiceTerms],
      [UI_SHELL_CHANNELS.resetBallPosition],
      [UI_SHELL_CHANNELS.clearAllLocalData, { confirmation: '清除全部本地数据' }]
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

  it('accepts only sanitized provider test results', async () => {
    const { port, invoke } = createIpc();
    const api = createSettingsRendererBridge(port);
    invoke.mockResolvedValueOnce({ ok: true });
    await expect(api.testTranslationProvider()).resolves.toEqual({ ok: true });
    invoke.mockResolvedValueOnce({ ok: false, code: 'network-unavailable' });
    await expect(api.testTranslationProvider()).resolves.toEqual({
      ok: false,
      code: 'network-unavailable'
    });

    for (const invalid of [
      null,
      [],
      'failed',
      { ok: 'yes' },
      { ok: false, code: 500 },
      { ok: false, code: 'INVALID CODE' },
      { ok: true, raw: 'secret' }
    ]) {
      invoke.mockResolvedValueOnce(invalid);
      await expect(api.testTranslationProvider()).rejects.toThrow(/invalid provider test result/u);
    }
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

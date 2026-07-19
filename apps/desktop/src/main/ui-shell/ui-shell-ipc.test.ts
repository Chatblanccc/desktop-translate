import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI_SHELL_SNAPSHOT } from '@desktop-translate/contracts/ui-shell';
import { UI_SHELL_CHANNELS } from '../../shared/ui-shell-channels.js';
import {
  registerUiShellIpc,
  type InvokeEventLike,
  type IpcMainPort,
  type UiShellIpcActions
} from './ui-shell-ipc.js';

function setup(role: 'ball' | 'settings' = 'settings') {
  const handlers = new Map<string, (event: InvokeEventLike, ...args: readonly unknown[]) => unknown>();
  const ipcMain: IpcMainPort = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => { handlers.delete(channel); }
  };
  const actions: UiShellIpcActions = {
    getSnapshot: () => DEFAULT_UI_SHELL_SNAPSHOT,
    openSettings: vi.fn(),
    openContextMenu: vi.fn(),
    setBallVisible: vi.fn().mockResolvedValue(undefined),
    setEdgeSnap: vi.fn().mockResolvedValue(undefined),
    setTheme: vi.fn().mockResolvedValue(undefined),
    setSelectionEnabled: vi.fn().mockResolvedValue(undefined),
    setOcrActivation: vi.fn().mockResolvedValue(undefined),
    setTranslationEnabled: vi.fn().mockResolvedValue(undefined),
    setTranslationSourceLanguage: vi.fn().mockResolvedValue(undefined),
    setTranslationTargetLanguage: vi.fn().mockResolvedValue(undefined),
    saveBaiduCredentials: vi.fn().mockResolvedValue(undefined),
    deleteBaiduCredentials: vi.fn().mockResolvedValue(undefined),
    testTranslationProvider: vi.fn().mockResolvedValue({ ok: true }),
    openProviderPrivacyPolicy: vi.fn().mockResolvedValue(undefined),
    openProviderServiceTerms: vi.fn().mockResolvedValue(undefined),
    resetBallPosition: vi.fn().mockResolvedValue(undefined),
    clearAllLocalData: vi.fn().mockResolvedValue(undefined)
  };
  const mainFrame = { url: `file:///desktop/${role}.html` };
  const event: InvokeEventLike = {
    sender: { id: 7, mainFrame },
    senderFrame: mainFrame
  };
  const dispose = registerUiShellIpc({ ipcMain, actions, resolveRole: () => role });
  return { handlers, actions, event, dispose };
}

function requireHandler(
  handlers: ReadonlyMap<string, (event: InvokeEventLike, ...args: readonly unknown[]) => unknown>,
  channel: string
): (event: InvokeEventLike, ...args: readonly unknown[]) => unknown {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

describe('UI shell IPC', () => {
  it('allows explicit settings writes with validated payloads', async () => {
    const { handlers, actions, event } = setup('settings');
    await requireHandler(handlers, UI_SHELL_CHANNELS.setBallVisible)(event, { value: false });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setEdgeSnap)(event, { value: false });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setTheme)(event, { value: 'dark' });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setSelectionEnabled)(event, { value: false });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setOcrActivation)(event, {
      value: 'alt-drag'
    });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationEnabled)(event, { value: true });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationSourceLanguage)(event, {
      value: 'auto'
    });
    await requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationTargetLanguage)(event, {
      value: 'zh-CN'
    });
    await requireHandler(handlers, UI_SHELL_CHANNELS.saveBaiduCredentials)(event, {
      appId: 'app-id', secretKey: 'secret-key', consentVersion: 1
    });
    await requireHandler(handlers, UI_SHELL_CHANNELS.testTranslationProvider)(event);
    await requireHandler(handlers, UI_SHELL_CHANNELS.openProviderPrivacyPolicy)(event);
    await requireHandler(handlers, UI_SHELL_CHANNELS.openProviderServiceTerms)(event);
    await requireHandler(handlers, UI_SHELL_CHANNELS.resetBallPosition)(event);
    await requireHandler(handlers, UI_SHELL_CHANNELS.clearAllLocalData)(event, {
      confirmation: '清除全部本地数据'
    });
    expect(actions.setBallVisible).toHaveBeenCalledWith(false);
    expect(actions.setEdgeSnap).toHaveBeenCalledWith(false);
    expect(actions.setTheme).toHaveBeenCalledWith('dark');
    expect(actions.setSelectionEnabled).toHaveBeenCalledWith(false);
    expect(actions.setOcrActivation).toHaveBeenCalledWith('alt-drag');
    expect(actions.setTranslationEnabled).toHaveBeenCalledWith(true);
    expect(actions.setTranslationSourceLanguage).toHaveBeenCalledWith('auto');
    expect(actions.setTranslationTargetLanguage).toHaveBeenCalledWith('zh-CN');
    expect(actions.saveBaiduCredentials).toHaveBeenCalledWith(
      { appId: 'app-id', secretKey: 'secret-key' },
      1
    );
    expect(actions.resetBallPosition).toHaveBeenCalledOnce();
    expect(actions.clearAllLocalData).toHaveBeenCalledOnce();
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTheme)(event, { value: 'remote-code' })
    ).rejects.toThrow(/Invalid/u);
  });

  it('allows Ball reads and parameter-free Ball commands', () => {
    const { handlers, actions, event } = setup('ball');
    expect(requireHandler(handlers, UI_SHELL_CHANNELS.getSnapshot)(event)).toEqual(
      DEFAULT_UI_SHELL_SNAPSHOT
    );
    requireHandler(handlers, UI_SHELL_CHANNELS.openSettings)(event);
    requireHandler(handlers, UI_SHELL_CHANNELS.openContextMenu)(event);
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.openContextMenu).toHaveBeenCalledOnce();
  });

  it('rejects a ball attempting to write settings', async () => {
    const { handlers, event } = setup('ball');
    await expect(
      handlers.get(UI_SHELL_CHANNELS.setBallVisible)?.(event, { value: false })
    ).rejects.toThrow(/rejected/u);
  });

  it('rejects missing, extra, and malformed write payloads', async () => {
    const { handlers, event } = setup('settings');
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setBallVisible)(event)
    ).rejects.toThrow(/Invalid ball/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setBallVisible)(event, { value: true }, 'extra')
    ).rejects.toThrow(/Invalid ball/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setEdgeSnap)(event, { value: 'yes' })
    ).rejects.toThrow(/Invalid edge/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTheme)(event, { value: 'dark', extra: true })
    ).rejects.toThrow(/Invalid theme/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setSelectionEnabled)(event, { value: 'yes' })
    ).rejects.toThrow(/Invalid selection/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setOcrActivation)(event, { value: 'always' })
    ).rejects.toThrow(/Invalid OCR/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationEnabled)(event, { value: 'yes' })
    ).rejects.toThrow(/Invalid translation enabled/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationSourceLanguage)(event, {
        value: 'eo'
      })
    ).rejects.toThrow(/Invalid translation source language/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationTargetLanguage)(event, { value: 'bad value' })
    ).rejects.toThrow(/Invalid translation language/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.setTranslationTargetLanguage)(event, { value: 'eo' })
    ).rejects.toThrow(/Invalid translation language/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.saveBaiduCredentials)(event, {
        appId: 'app-id', secretKey: 'secret-key', consentVersion: 0
      })
    ).rejects.toThrow(/Invalid provider credential/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.resetBallPosition)(event, {})
    ).rejects.toThrow(/does not accept/u);
    await expect(
      requireHandler(handlers, UI_SHELL_CHANNELS.clearAllLocalData)(event, {
        confirmation: '清除全部本地数据 ', extra: true
      })
    ).rejects.toThrow(/Invalid local-data reset confirmation/u);
  });

  it('rejects subframes and unexpected arguments', () => {
    const { handlers, event } = setup('ball');
    expect(() => handlers.get(UI_SHELL_CHANNELS.getSnapshot)?.(
      { ...event, senderFrame: { url: 'file:///desktop/iframe.html' } }
    )).toThrow(/rejected/u);
    expect(() => handlers.get(UI_SHELL_CHANNELS.openSettings)?.(event, 'extra')).toThrow(
      /does not accept/u
    );
  });

  it('rejects missing frames and unknown window registrations', () => {
    const missingFrame = setup('ball');
    expect(() => requireHandler(
      missingFrame.handlers,
      UI_SHELL_CHANNELS.getSnapshot
    )({ ...missingFrame.event, senderFrame: null })).toThrow(/rejected/u);

    const unknown = setup('ball');
    const registered = registerUiShellIpc({
      ipcMain: {
        handle: (channel, listener) => unknown.handlers.set(channel, listener),
        removeHandler: (channel) => { unknown.handlers.delete(channel); }
      },
      actions: unknown.actions,
      resolveRole: () => undefined
    });
    expect(() => requireHandler(unknown.handlers, UI_SHELL_CHANNELS.getSnapshot)(
      unknown.event
    )).toThrow(/rejected/u);
    registered();
  });

  it('removes every registered handler during shutdown', () => {
    const { handlers, dispose } = setup();
    expect(handlers.size).toBeGreaterThan(0);
    dispose();
    expect(handlers.size).toBe(0);
  });
});

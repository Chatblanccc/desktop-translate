import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn()
  }
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron.ipcRenderer
}));

describe('role-isolated preload entrypoints', () => {
  beforeEach(() => {
    vi.resetModules();
    electron.exposeInMainWorld.mockClear();
  });

  it('exposes only the Ball API under the Ball namespace', async () => {
    await import('./ball.js');
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [namespace, api] = electron.exposeInMainWorld.mock.calls[0] ?? [];
    expect(namespace).toBe('desktopTranslateBall');
    expect(Object.keys(api as object).sort()).toEqual([
      'getSnapshot',
      'onSnapshotChanged',
      'openContextMenu',
      'openSettings'
    ]);
  });

  it('exposes only the Settings API under the Settings namespace', async () => {
    await import('./settings.js');
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [namespace, api] = electron.exposeInMainWorld.mock.calls[0] ?? [];
    expect(namespace).toBe('desktopTranslateSettings');
    expect(Object.keys(api as object).sort()).toEqual([
      'clearAllLocalData',
      'deleteBaiduCredentials',
      'getBaiduCredentialSummary',
      'getSnapshot',
      'onSnapshotChanged',
      'openProviderPrivacyPolicy',
      'openProviderServiceTerms',
      'resetBallPosition',
      'saveBaiduCredentials',
      'setBallVisible',
      'setEdgeSnap',
      'setOcrActivation',
      'setSelectionEnabled',
      'setTheme',
      'setTranslationEnabled',
      'setTranslationSourceLanguage',
      'setTranslationTargetLanguage',
      'testTranslationProvider'
    ]);
  });

  it('exposes only the translation card API under the Card namespace', async () => {
    await import('./card.js');
    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [namespace, api] = electron.exposeInMainWorld.mock.calls[0] ?? [];
    expect(namespace).toBe('desktopTranslateCard');
    expect(Object.keys(api as object).sort()).toEqual([
      'acknowledgePaint',
      'dismiss',
      'getCurrent',
      'onChanged',
      'onPaintProbe',
      'retry'
    ]);
  });
});

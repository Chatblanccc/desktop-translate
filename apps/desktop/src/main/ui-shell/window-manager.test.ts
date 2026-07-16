import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI_SHELL_SNAPSHOT } from '@desktop-translate/contracts/ui-shell';
import { SELECTION_CARD_CHANNELS } from '../../shared/selection-card-channels.js';
import { UI_SHELL_CHANNELS } from '../../shared/ui-shell-channels.js';

type Handler = (...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  class FakeEmitter {
    private readonly listeners = new Map<string, Array<{ handler: Handler; once: boolean }>>();

    public on(event: string, handler: Handler): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { handler, once: false }]);
      return this;
    }

    public once(event: string, handler: Handler): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { handler, once: true }]);
      return this;
    }

    public emit(event: string, ...args: unknown[]): void {
      const entries = [...(this.listeners.get(event) ?? [])];
      this.listeners.set(event, entries.filter((entry) => !entry.once));
      for (const entry of entries) entry.handler(...args);
    }
  }

  let nextId = 1;
  class FakeWebContents extends FakeEmitter {
    public readonly id = nextId++;
    public readonly send = vi.fn();
    public readonly setWindowOpenHandler = vi.fn();
    public readonly insertCSS = vi.fn(async () => 'accent-css');
  }

  class FakeBrowserWindow extends FakeEmitter {
    public static readonly instances: FakeBrowserWindow[] = [];
    private readonly contents = new FakeWebContents();
    public readonly setAlwaysOnTop = vi.fn();
    public readonly showInactive = vi.fn(() => { this.visible = true; });
    public readonly show = vi.fn(() => { this.visible = true; });
    public readonly hide = vi.fn(() => { this.visible = false; });
    public readonly focus = vi.fn();
    public readonly restore = vi.fn(() => { this.minimized = false; });
    public readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    public readonly loadFile = vi.fn(async (file: string) => { this.loadedFile = file; });
    public destroyed = false;
    public visible = false;
    public minimized = false;
    public loadedFile: string | undefined;
    public bounds: { x: number; y: number; width: number; height: number };

    public constructor(public readonly options: Record<string, unknown>) {
      super();
      this.bounds = {
        x: Number(options.x ?? 0),
        y: Number(options.y ?? 0),
        width: Number(options.width ?? 0),
        height: Number(options.height ?? 0)
      };
      FakeBrowserWindow.instances.push(this);
    }

    public get webContents(): FakeWebContents {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }

    public isDestroyed(): boolean { return this.destroyed; }
    public isVisible(): boolean { return this.visible; }
    public isMinimized(): boolean { return this.minimized; }
    public getBounds(): typeof this.bounds { return { ...this.bounds }; }

    public close(): { readonly prevented: boolean } {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
      return { prevented };
    }

    public destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    systemPreferences: {
      getColor: vi.fn((name: string) => name === 'highlight' ? '#112233ff' : '#fefefeff')
    }
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  nativeTheme: electron.nativeTheme,
  systemPreferences: electron.systemPreferences
}));

import {
  WindowManager,
  createBallWindowOptions,
  createCardWindowOptions,
  createSecureWebPreferences,
  createSettingsWindowOptions,
  createSystemAccentCss
} from './window-manager.js';

const initialBounds = { x: 100, y: 200, width: 56, height: 56 };

function makeManager(initialBallVisible = true) {
  const onBallMoved = vi.fn();
  const onCardDismissed = vi.fn();
  const manager = new WindowManager({
    appPath: 'C:\\app',
    buildDirectory: 'C:\\app\\.vite\\build',
    initialBallBounds: initialBounds,
    initialBallVisible,
    onBallMoved,
    onCardDismissed
  });
  return { manager, onBallMoved, onCardDismissed };
}

function latestWindow(): InstanceType<typeof electron.BrowserWindow> {
  const window = electron.BrowserWindow.instances.at(-1);
  if (window === undefined) throw new Error('Expected a window');
  return window;
}

describe('secure window options', () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  it('enforces the Renderer security boundary and disables CI devtools', () => {
    delete process.env.CI;
    expect(createSecureWebPreferences('C:\\preload.cjs')).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      devTools: true
    });
    process.env.CI = '1';
    expect(createSecureWebPreferences('C:\\preload.cjs').devTools).toBe(false);
  });

  it('creates a 56 DIP non-taskbar floating ball', () => {
    const options = createBallWindowOptions('C:\\ball.cjs', initialBounds);
    expect(options).toMatchObject({
      ...initialBounds,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false
    });
  });

  it('uses a theme-matched background for a framed settings window', () => {
    electron.nativeTheme.shouldUseDarkColors = false;
    expect(createSettingsWindowOptions('C:\\settings.cjs')).toMatchObject({
      frame: true,
      transparent: false,
      show: false,
      width: 720,
      height: 640,
      backgroundColor: '#f3f3f3'
    });
    electron.nativeTheme.shouldUseDarkColors = true;
    expect(createSettingsWindowOptions('C:\\settings.cjs').backgroundColor).toBe('#202020');
  });

  it('creates a fixed, secure, non-taskbar source card', () => {
    expect(createCardWindowOptions('C:\\card.cjs', { x: 10, y: 20, width: 1, height: 1 }))
      .toMatchObject({
        x: 10,
        y: 20,
        width: 380,
        height: 220,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false
      });
  });

  it('validates Windows system colors before generating accent CSS', () => {
    expect(createSystemAccentCss('#112233ff', '#fefefeff')).toContain('#112233ff');
    expect(createSystemAccentCss('unsafe; color: red', 'invalid')).toContain('#005fb8');
    expect(createSystemAccentCss('unsafe; color: red', 'invalid')).toContain('#ffffff');
    expect(createSystemAccentCss('#00000000', '#00000000')).toContain('#005fb8');
  });
});

describe('WindowManager', () => {
  beforeEach(() => {
    electron.BrowserWindow.instances.length = 0;
    electron.nativeTheme.shouldUseDarkColors = false;
    electron.systemPreferences.getColor.mockImplementation(
      (name: string) => name === 'highlight' ? '#112233ff' : '#fefefeff'
    );
  });

  it('creates and secures one Ball window, shows it inactive, and reports moves', async () => {
    const { manager, onBallMoved } = makeManager();
    await manager.start();
    await manager.start();
    expect(electron.BrowserWindow.instances).toHaveLength(1);
    const ball = latestWindow();
    expect(ball.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(ball.loadedFile).toMatch(/ball[\\/]index\.html$/u);
    expect(ball.webContents.insertCSS).toHaveBeenCalledWith(
      expect.stringContaining('--color-accent: #112233ff')
    );

    const deny = ball.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown;
    expect(deny()).toEqual({ action: 'deny' });
    const preventNavigation = vi.fn();
    ball.webContents.emit('will-navigate', { preventDefault: preventNavigation });
    ball.webContents.emit('will-redirect', { preventDefault: preventNavigation });
    ball.webContents.emit('will-attach-webview', { preventDefault: preventNavigation });
    expect(preventNavigation).toHaveBeenCalledTimes(3);

    ball.emit('ready-to-show');
    expect(ball.showInactive).toHaveBeenCalledOnce();
    ball.emit('moved');
    expect(onBallMoved).toHaveBeenCalledWith(initialBounds);
    ball.destroyed = true;
    ball.emit('moved');
    expect(onBallMoved).toHaveBeenCalledOnce();
  });

  it('defers visibility until ready and then toggles the Ball', async () => {
    const { manager } = makeManager(false);
    await manager.start();
    const ball = latestWindow();
    manager.setBallVisible(true);
    expect(ball.showInactive).not.toHaveBeenCalled();
    ball.emit('ready-to-show');
    expect(ball.showInactive).toHaveBeenCalledOnce();
    manager.setBallVisible(false);
    expect(ball.hide).toHaveBeenCalledOnce();
    manager.setBallVisible(true);
    expect(ball.showInactive).toHaveBeenCalledTimes(2);
    ball.destroyed = true;
    manager.setBallVisible(false);
    expect(ball.hide).toHaveBeenCalledOnce();
  });

  it('hides rather than destroys the Ball on close and reuses it when shown again', async () => {
    const { manager } = makeManager();
    await manager.start();
    const ball = latestWindow();
    ball.emit('ready-to-show');

    expect(ball.close().prevented).toBe(true);
    expect(ball.hide).toHaveBeenCalledOnce();
    expect(ball.destroyed).toBe(false);
    expect(manager.getBallWindow()).toBe(ball);

    manager.setBallVisible(true);
    await manager.start();
    expect(ball.showInactive).toHaveBeenCalledTimes(2);
    expect(electron.BrowserWindow.instances).toHaveLength(1);
  });

  it('sets, gets, and clears Ball bounds safely', async () => {
    const { manager } = makeManager();
    expect(manager.getBallBounds()).toBeUndefined();
    manager.setBallBounds({ x: 1, y: 2, width: 56, height: 56 });
    await manager.start();
    const ball = latestWindow();
    manager.setBallBounds({ x: 20, y: 30, width: 56, height: 56 });
    expect(manager.getBallBounds()).toEqual({ x: 20, y: 30, width: 56, height: 56 });
    ball.destroyed = true;
    manager.setBallBounds(initialBounds);
    expect(manager.getBallBounds()).toBeUndefined();
  });

  it('authorizes only the registered role at its exact local URL', async () => {
    const { manager } = makeManager();
    await manager.start();
    const ball = latestWindow();
    const expectedUrl = pathToFileURL('C:\\app\\.vite\\renderer\\ball\\index.html').href;
    const mainFrame = { url: expectedUrl };
    expect(manager.resolveRole({
      sender: { id: ball.webContents.id, mainFrame },
      senderFrame: mainFrame
    })).toBe('ball');
    expect(manager.resolveRole({
      sender: { id: ball.webContents.id, mainFrame },
      senderFrame: { url: 'https://attacker.example/' }
    })).toBeUndefined();
    expect(manager.resolveRole({ sender: { id: 999, mainFrame }, senderFrame: mainFrame })).toBeUndefined();
  });

  it('creates Settings lazily, restores an existing window, and hides on close', async () => {
    const { manager } = makeManager();
    await manager.start();
    manager.openSettings();
    await Promise.resolve();
    expect(electron.BrowserWindow.instances).toHaveLength(2);
    const settings = latestWindow();
    expect(settings.loadedFile).toMatch(/settings[\\/]index\.html$/u);
    settings.emit('ready-to-show');
    expect(settings.show).toHaveBeenCalledOnce();
    expect(settings.focus).toHaveBeenCalledOnce();

    settings.minimized = true;
    manager.openSettings();
    expect(settings.restore).toHaveBeenCalledOnce();
    expect(settings.show).toHaveBeenCalledTimes(2);
    expect(settings.focus).toHaveBeenCalledTimes(2);
    expect(settings.close().prevented).toBe(true);
    expect(settings.hide).toHaveBeenCalledOnce();
  });

  it('does not show Settings when it was not requested or was destroyed before ready', async () => {
    const { manager } = makeManager();
    await manager.start();
    manager.openSettings();
    await Promise.resolve();
    const settings = latestWindow();
    settings.destroyed = true;
    settings.emit('ready-to-show');
    expect(settings.show).not.toHaveBeenCalled();
  });

  it('broadcasts to live role windows and unregisters closed windows', async () => {
    const { manager } = makeManager();
    await manager.start();
    const ball = latestWindow();
    manager.openSettings();
    await Promise.resolve();
    const settings = latestWindow();
    manager.broadcast(DEFAULT_UI_SHELL_SNAPSHOT);
    expect(ball.webContents.send).toHaveBeenCalledWith(
      UI_SHELL_CHANNELS.snapshotChanged,
      DEFAULT_UI_SHELL_SNAPSHOT
    );
    expect(settings.webContents.send).toHaveBeenCalledOnce();
    settings.destroy();
    expect(manager.getSettingsWindow()).toBeUndefined();
    ball.destroy();
    expect(manager.getBallWindow()).toBeUndefined();
  });

  it('creates one source card lazily, presents replacements, and returns isolated state', async () => {
    const { manager } = makeManager();
    await manager.start();
    const first = {
      selectionId: '123e4567-e89b-42d3-a456-426614174000',
      text: 'First source text',
      source: 'uia' as const,
      confidence: 1
    };
    const firstBounds = { x: 100, y: 120, width: 380, height: 220 };
    manager.presentSelectionCard(first, firstBounds);
    await Promise.resolve();
    expect(electron.BrowserWindow.instances).toHaveLength(2);
    const card = latestWindow();
    expect(card.loadedFile).toMatch(/card[\\/]index\.html$/u);
    expect(card.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(card.showInactive).not.toHaveBeenCalled();
    expect(manager.getCurrentSelectionCard()).toEqual(first);

    const returned = manager.getCurrentSelectionCard()!;
    (returned as { text: string }).text = 'mutated';
    expect(manager.getCurrentSelectionCard()?.text).toBe(first.text);

    card.emit('ready-to-show');
    expect(card.setBounds).toHaveBeenCalledWith(firstBounds, false);
    expect(card.webContents.send).toHaveBeenCalledWith(SELECTION_CARD_CHANNELS.changed, first);
    expect(card.showInactive).toHaveBeenCalledOnce();

    const replacement = { ...first, text: 'Replacement source text', source: 'ocr' as const };
    const replacementBounds = { x: -500, y: 700, width: 380, height: 220 };
    manager.presentSelectionCard(replacement, replacementBounds);
    expect(card.setBounds).toHaveBeenLastCalledWith(replacementBounds, false);
    expect(card.webContents.send).toHaveBeenLastCalledWith(
      SELECTION_CARD_CHANNELS.changed,
      replacement
    );
    expect(card.showInactive).toHaveBeenCalledTimes(2);
    expect(electron.BrowserWindow.instances).toHaveLength(2);
  });

  it('dismisses cards before or after ready and reports an explicit user dismissal', async () => {
    const { manager, onCardDismissed } = makeManager();
    await manager.start();
    const cardModel = {
      selectionId: '123e4567-e89b-42d3-a456-426614174000',
      text: 'Source text',
      source: 'uia' as const,
      confidence: 1
    };
    manager.presentSelectionCard(cardModel, { x: 1, y: 2, width: 380, height: 220 });
    await Promise.resolve();
    const card = latestWindow();
    manager.dismissSelectionCard();
    expect(manager.getCurrentSelectionCard()).toBeUndefined();
    card.emit('ready-to-show');
    expect(card.showInactive).not.toHaveBeenCalled();

    manager.presentSelectionCard(cardModel, { x: 3, y: 4, width: 380, height: 220 });
    expect(card.showInactive).toHaveBeenCalledOnce();
    expect(card.close().prevented).toBe(true);
    expect(card.webContents.send).toHaveBeenLastCalledWith(
      SELECTION_CARD_CHANNELS.changed,
      undefined
    );
    expect(card.hide).toHaveBeenCalledTimes(2);
    expect(onCardDismissed).toHaveBeenCalledOnce();

    card.destroy();
    expect(manager.getCardWindow()).toBeUndefined();
    manager.dismissSelectionCard(true);
    expect(onCardDismissed).toHaveBeenCalledTimes(2);
  });

  it('falls back safely when Windows accent lookup and CSS injection fail', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    electron.systemPreferences.getColor.mockImplementation(() => { throw new Error('color'); });
    const { manager } = makeManager();
    const start = manager.start();
    const ball = latestWindow();
    ball.webContents.insertCSS.mockRejectedValueOnce(new Error('css'));
    await start;
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/accent color/u));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/apply/u));
    warning.mockRestore();
  });

  it('destroys all role windows during an idempotent shutdown without close-to-hide', async () => {
    const { manager } = makeManager();
    await manager.start();
    const ball = latestWindow();
    manager.openSettings();
    await Promise.resolve();
    const settings = latestWindow();
    manager.presentSelectionCard({
      selectionId: '123e4567-e89b-42d3-a456-426614174000',
      text: 'Source text',
      source: 'uia',
      confidence: 1
    }, { x: 1, y: 2, width: 380, height: 220 });
    await Promise.resolve();
    const card = latestWindow();
    manager.dispose();
    manager.dispose();
    expect(ball.destroyed).toBe(true);
    expect(settings.destroyed).toBe(true);
    expect(card.destroyed).toBe(true);
    expect(manager.getBallWindow()).toBeUndefined();
    expect(manager.getSettingsWindow()).toBeUndefined();
    expect(manager.getCardWindow()).toBeUndefined();
  });
});

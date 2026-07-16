import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  nativeTheme,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type Rectangle
} from 'electron';
import type { UiShellSnapshot } from '@desktop-translate/contracts/ui-shell';
import type { SelectionCardViewModel } from '@desktop-translate/contracts/selection-card';
import { SELECTION_CARD_CHANNELS } from '../../shared/selection-card-channels.js';
import { UI_SHELL_CHANNELS } from '../../shared/ui-shell-channels.js';
import { BALL_SIZE_DIP } from './ball-position.js';
import { CARD_HEIGHT_DIP, CARD_WIDTH_DIP } from './selection-card-position.js';
import type { InvokeEventLike, WindowRole } from './ui-shell-ipc.js';

export interface WindowManagerOptions {
  readonly appPath: string;
  readonly buildDirectory: string;
  readonly initialBallBounds: Rectangle;
  readonly initialBallVisible: boolean;
  readonly onBallMoved: (bounds: Rectangle) => void;
  readonly onCardDismissed: () => void;
}

interface WindowRegistration {
  readonly role: WindowRole;
  readonly expectedUrl: string;
}

export function createSecureWebPreferences(preload: string) {
  return {
    preload,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    devTools: !process.env.CI
  } satisfies NonNullable<BrowserWindowConstructorOptions['webPreferences']>;
}

export function createBallWindowOptions(preload: string, bounds: Rectangle): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    width: BALL_SIZE_DIP,
    height: BALL_SIZE_DIP,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    webPreferences: createSecureWebPreferences(preload)
  };
}

export function createSettingsWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 720,
    height: 640,
    minWidth: 640,
    minHeight: 560,
    show: false,
    frame: true,
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    autoHideMenuBar: true,
    title: '桌面翻译设置',
    webPreferences: createSecureWebPreferences(preload)
  };
}

export function createCardWindowOptions(preload: string, bounds: Rectangle): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    width: CARD_WIDTH_DIP,
    height: CARD_HEIGHT_DIP,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    webPreferences: createSecureWebPreferences(preload)
  };
}

export function createSystemAccentCss(accentColor: string, accentTextColor: string): string {
  const isVisibleColor = (value: string): boolean =>
    /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value) &&
    (value.length === 7 || Number.parseInt(value.slice(7), 16) > 0);
  const accent = isVisibleColor(accentColor)
    ? accentColor
    : '#005fb8';
  const accentText = isVisibleColor(accentTextColor)
    ? accentTextColor
    : '#ffffff';
  return `
@media (forced-colors: none) {
  :root {
    --color-accent: ${accent} !important;
    --color-accent-hover: color-mix(in srgb, ${accent} 84%, #000 16%) !important;
    --color-accent-text: ${accentText} !important;
    --focus-ring: ${accent} !important;
  }
}`;
}

export class WindowManager {
  private readonly registrations = new Map<number, WindowRegistration>();
  private ballWindow: BrowserWindow | undefined;
  private settingsWindow: BrowserWindow | undefined;
  private cardWindow: BrowserWindow | undefined;
  private cardReady = false;
  private currentCard: SelectionCardViewModel | undefined;
  private currentCardBounds: Rectangle | undefined;
  private ballReady = false;
  private ballVisible: boolean;
  private settingsShouldShow = false;
  private quitting = false;

  public constructor(private readonly options: WindowManagerOptions) {
    this.ballVisible = options.initialBallVisible;
  }

  public async start(): Promise<void> {
    if (this.ballWindow !== undefined) return;
    const preload = join(this.options.buildDirectory, 'ball-preload.cjs');
    const html = join(this.options.appPath, '.vite', 'renderer', 'ball', 'index.html');
    const window = new BrowserWindow(createBallWindowOptions(preload, this.options.initialBallBounds));
    const webContentsId = window.webContents.id;
    this.ballWindow = window;
    window.setAlwaysOnTop(true, 'floating');
    this.register(window, 'ball', html);
    this.secure(window);
    window.on('moved', () => {
      if (!window.isDestroyed()) this.options.onBallMoved(window.getBounds());
    });
    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.once('ready-to-show', () => {
      this.ballReady = true;
      if (this.ballVisible) window.showInactive();
    });
    window.on('closed', () => {
      this.registrations.delete(webContentsId);
      if (this.ballWindow === window) this.ballWindow = undefined;
    });
    await window.loadFile(html);
    await this.applySystemAccent(window);
  }

  public resolveRole(event: InvokeEventLike): WindowRole | undefined {
    const registration = this.registrations.get(event.sender.id);
    if (registration === undefined || event.senderFrame?.url !== registration.expectedUrl) return undefined;
    return registration.role;
  }

  public setBallVisible(visible: boolean): void {
    this.ballVisible = visible;
    const window = this.ballWindow;
    if (window === undefined || window.isDestroyed() || !this.ballReady) return;
    if (visible) window.showInactive();
    else window.hide();
  }

  public setBallBounds(bounds: Rectangle): void {
    const window = this.ballWindow;
    if (window !== undefined && !window.isDestroyed()) window.setBounds(bounds, false);
  }

  public getBallBounds(): Rectangle | undefined {
    const window = this.ballWindow;
    return window === undefined || window.isDestroyed() ? undefined : window.getBounds();
  }

  public openSettings(): void {
    this.settingsShouldShow = true;
    const existing = this.settingsWindow;
    if (existing === undefined || existing.isDestroyed()) {
      void this.createSettingsWindow();
      return;
    }
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  }

  public getBallWindow(): BrowserWindow | undefined {
    return this.ballWindow;
  }

  public getSettingsWindow(): BrowserWindow | undefined {
    return this.settingsWindow;
  }

  public getCardWindow(): BrowserWindow | undefined {
    return this.cardWindow;
  }

  public getCurrentSelectionCard(): SelectionCardViewModel | undefined {
    return this.currentCard === undefined ? undefined : structuredClone(this.currentCard);
  }

  public presentSelectionCard(card: SelectionCardViewModel, bounds: Rectangle): void {
    this.currentCard = structuredClone(card);
    this.currentCardBounds = { ...bounds };
    const window = this.cardWindow;
    if (window === undefined || window.isDestroyed()) {
      void this.createCardWindow();
      return;
    }
    if (!this.cardReady) return;
    window.setBounds(bounds, false);
    window.webContents.send(SELECTION_CARD_CHANNELS.changed, this.currentCard);
    window.showInactive();
  }

  public dismissSelectionCard(notify = false): void {
    this.currentCard = undefined;
    this.currentCardBounds = undefined;
    const window = this.cardWindow;
    if (window !== undefined && !window.isDestroyed()) {
      if (this.cardReady) window.webContents.send(SELECTION_CARD_CHANNELS.changed, undefined);
      window.hide();
    }
    if (notify) this.options.onCardDismissed();
  }

  public broadcast(snapshot: UiShellSnapshot): void {
    for (const window of [this.ballWindow, this.settingsWindow]) {
      if (window !== undefined && !window.isDestroyed()) {
        window.webContents.send(UI_SHELL_CHANNELS.snapshotChanged, snapshot);
      }
    }
  }

  public dispose(): void {
    this.quitting = true;
    for (const window of [this.cardWindow, this.settingsWindow, this.ballWindow]) {
      if (window !== undefined && !window.isDestroyed()) window.destroy();
    }
    this.settingsWindow = undefined;
    this.ballWindow = undefined;
    this.cardWindow = undefined;
    this.currentCard = undefined;
    this.currentCardBounds = undefined;
    this.registrations.clear();
  }

  private async createSettingsWindow(): Promise<void> {
    if (this.settingsWindow !== undefined) return;
    const preload = join(this.options.buildDirectory, 'settings-preload.cjs');
    const html = join(this.options.appPath, '.vite', 'renderer', 'settings', 'index.html');
    const window = new BrowserWindow(createSettingsWindowOptions(preload));
    const webContentsId = window.webContents.id;
    this.settingsWindow = window;
    this.register(window, 'settings', html);
    this.secure(window);
    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('closed', () => {
      this.registrations.delete(webContentsId);
      if (this.settingsWindow === window) this.settingsWindow = undefined;
    });
    window.once('ready-to-show', () => {
      if (!this.settingsShouldShow || window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    await window.loadFile(html);
    await this.applySystemAccent(window);
  }

  private async createCardWindow(): Promise<void> {
    if (this.cardWindow !== undefined || this.currentCard === undefined || this.currentCardBounds === undefined) {
      return;
    }
    const preload = join(this.options.buildDirectory, 'card-preload.cjs');
    const html = join(this.options.appPath, '.vite', 'renderer', 'card', 'index.html');
    const window = new BrowserWindow(createCardWindowOptions(preload, this.currentCardBounds));
    const webContentsId = window.webContents.id;
    this.cardWindow = window;
    window.setAlwaysOnTop(true, 'floating');
    this.register(window, 'card', html);
    this.secure(window);
    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        this.dismissSelectionCard(true);
      }
    });
    window.on('closed', () => {
      this.registrations.delete(webContentsId);
      if (this.cardWindow === window) this.cardWindow = undefined;
      this.cardReady = false;
    });
    window.once('ready-to-show', () => {
      this.cardReady = true;
      if (
        this.currentCard === undefined ||
        this.currentCardBounds === undefined ||
        window.isDestroyed()
      ) return;
      window.setBounds(this.currentCardBounds, false);
      window.webContents.send(SELECTION_CARD_CHANNELS.changed, this.currentCard);
      window.showInactive();
    });
    await window.loadFile(html);
    await this.applySystemAccent(window);
  }

  private register(window: BrowserWindow, role: WindowRole, html: string): void {
    this.registrations.set(window.webContents.id, {
      role,
      expectedUrl: pathToFileURL(html).href
    });
  }

  private secure(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  }

  private async applySystemAccent(window: BrowserWindow): Promise<void> {
    let css: string;
    try {
      css = createSystemAccentCss(
        systemPreferences.getColor('highlight'),
        systemPreferences.getColor('highlight-text')
      );
    } catch {
      css = createSystemAccentCss('#005fb8', '#ffffff');
      console.warn('[phase2:windows] Failed to read the Windows accent color.');
    }
    try {
      await window.webContents.insertCSS(css);
    } catch {
      console.warn('[phase2:windows] Failed to apply the Windows accent color.');
    }
  }
}

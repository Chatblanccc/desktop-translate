import { Buffer } from 'node:buffer';
import {
  Menu,
  Tray,
  app,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron';
import type {
  NativeUiStatus,
  SelectionLifecycle,
  UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';

const STATUS_LABELS: Readonly<Record<NativeUiStatus, string>> = {
  unavailable: '状态：原生服务未连接',
  starting: '状态：正在连接原生服务',
  ready: '状态：原生服务可用',
  degraded: '状态：部分原生能力不可用',
  faulted: '状态：原生服务连接故障'
};

const SELECTION_STATUS_LABELS: Readonly<Record<SelectionLifecycle, string>> = {
  disabled: '取词：已暂停',
  starting: '取词：正在启动',
  listening: '取词：监听中',
  degraded: '取词：监听中，部分能力不可用',
  faulted: '取词：故障'
};

const TRAY_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="14" fill="#005fb8"/>
  <path d="M8 9h9M12.5 7v2c0 5-2 8-5 10m3-6c1 3 3 5 6 6M19 22l3-10 3 10m-5-4h4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export interface TrayControllerActions {
  readonly openSettings: () => void;
  readonly setBallVisible: (visible: boolean) => Promise<void>;
  readonly setSelectionEnabled: (enabled: boolean) => Promise<void>;
  readonly resetBallPosition: () => Promise<void>;
  readonly quit: () => void;
}

export class TrayController {
  private tray: Tray | undefined;
  private menu: Menu | undefined;
  private snapshot: UiShellSnapshot | undefined;

  public constructor(private readonly actions: TrayControllerActions) {}

  public async start(snapshot: UiShellSnapshot): Promise<void> {
    if (this.tray !== undefined) return;
    this.snapshot = snapshot;
    const tray = new Tray(await createTrayIcon());
    this.tray = tray;
    tray.setToolTip('桌面翻译');
    tray.on('click', this.actions.openSettings);
    this.rebuild(snapshot);
  }

  public update(snapshot: UiShellSnapshot): void {
    this.snapshot = snapshot;
    if (this.tray !== undefined) this.rebuild(snapshot);
  }

  public openContextMenu(window?: BrowserWindow): void {
    if (this.menu === undefined && this.snapshot !== undefined) this.rebuild(this.snapshot);
    this.menu?.popup(window === undefined ? {} : { window });
  }

  public getTray(): Tray | undefined {
    return this.tray;
  }

  public dispose(): void {
    this.tray?.destroy();
    this.tray = undefined;
    this.menu = undefined;
  }

  private rebuild(snapshot: UiShellSnapshot): void {
    const template: MenuItemConstructorOptions[] = [
      { label: STATUS_LABELS[snapshot.native.status], enabled: false },
      { label: SELECTION_STATUS_LABELS[snapshot.selection.lifecycle], enabled: false },
      {
        label: '启用划词取词',
        type: 'checkbox',
        checked: snapshot.selection.enabled,
        click: (item) => this.runAction(() => this.actions.setSelectionEnabled(item.checked))
      },
      {
        label: '显示悬浮球',
        type: 'checkbox',
        checked: snapshot.ball.visible,
        click: (item) => this.runAction(() => this.actions.setBallVisible(item.checked))
      },
      { label: '打开设置', click: this.actions.openSettings },
      {
        label: '重置位置',
        click: () => this.runAction(this.actions.resetBallPosition)
      },
      { type: 'separator' },
      { label: '退出', click: this.actions.quit }
    ];
    this.menu = Menu.buildFromTemplate(template);
    this.tray?.setContextMenu(this.menu);
  }

  private runAction(action: () => Promise<void>): void {
    void action().catch(() => {
      console.warn('[phase2:tray] Tray command failed.');
    });
  }
}

async function createTrayIcon(): Promise<NativeImage> {
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(TRAY_ICON_SVG).toString('base64')}`;
  const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16, quality: 'best' });
  if (!image.isEmpty()) return image;
  return app.getFileIcon(process.execPath, { size: 'small' });
}

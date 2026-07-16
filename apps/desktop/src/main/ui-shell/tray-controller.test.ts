import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_SHELL_SNAPSHOT,
  type NativeUiStatus,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';

type TrayHandler = () => void;

const electron = vi.hoisted(() => {
  const image = {
    resize: vi.fn(),
    isEmpty: vi.fn(() => false)
  };
  image.resize.mockImplementation(() => image);
  const fallbackImage = { fallback: true };

  class FakeTray {
    public static readonly instances: FakeTray[] = [];
    public readonly setToolTip = vi.fn();
    public readonly setContextMenu = vi.fn();
    public readonly destroy = vi.fn();
    public readonly handlers = new Map<string, TrayHandler>();

    public constructor(public readonly icon: unknown) {
      FakeTray.instances.push(this);
    }

    public on(event: string, handler: TrayHandler): this {
      this.handlers.set(event, handler);
      return this;
    }
  }

  const menus: Array<{ popup: ReturnType<typeof vi.fn>; template: readonly unknown[] }> = [];
  const buildFromTemplate = vi.fn((template: readonly unknown[]) => {
    const menu = { popup: vi.fn(), template };
    menus.push(menu);
    return menu;
  });
  const getFileIcon = vi.fn(async () => fallbackImage);

  return { FakeTray, image, fallbackImage, menus, buildFromTemplate, getFileIcon };
});

vi.mock('electron', () => ({
  Tray: electron.FakeTray,
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  nativeImage: { createFromDataURL: vi.fn(() => electron.image) },
  app: { getFileIcon: electron.getFileIcon }
}));

import { TrayController, type TrayControllerActions } from './tray-controller.js';

function createActions(): TrayControllerActions {
  return {
    openSettings: vi.fn(),
    setBallVisible: vi.fn().mockResolvedValue(undefined),
    resetBallPosition: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn()
  };
}

function withStatus(status: NativeUiStatus): UiShellSnapshot {
  return { ...DEFAULT_UI_SHELL_SNAPSHOT, native: { status, degradedCapabilities: [] } };
}

describe('TrayController', () => {
  beforeEach(() => {
    electron.FakeTray.instances.length = 0;
    electron.menus.length = 0;
    electron.buildFromTemplate.mockClear();
    electron.getFileIcon.mockClear();
    electron.image.resize.mockClear();
    electron.image.isEmpty.mockReset().mockReturnValue(false);
  });

  it('starts exactly once, installs a native menu, and opens Settings on click', async () => {
    const actions = createActions();
    const controller = new TrayController(actions);
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    expect(electron.FakeTray.instances).toHaveLength(1);
    const tray = electron.FakeTray.instances[0]!;
    expect(tray.setToolTip).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledOnce();
    tray.handlers.get('click')?.();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(controller.getTray()).toBe(tray);
  });

  it('falls back to the application icon when SVG decoding is empty', async () => {
    electron.image.isEmpty.mockReturnValue(true);
    const controller = new TrayController(createActions());
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    expect(electron.getFileIcon).toHaveBeenCalledWith(process.execPath, { size: 'small' });
    expect(electron.FakeTray.instances[0]?.icon).toBe(electron.fallbackImage);
  });

  it('rebuilds status and visibility state for all native statuses', async () => {
    const controller = new TrayController(createActions());
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    for (const status of ['unavailable', 'starting', 'ready', 'degraded', 'faulted'] as const) {
      controller.update({
        ...withStatus(status),
        ball: { ...DEFAULT_UI_SHELL_SNAPSHOT.ball, visible: status !== 'faulted' }
      });
    }
    const tray = electron.FakeTray.instances[0]!;
    expect(tray.setContextMenu).toHaveBeenCalledTimes(6);
    const latestTemplate = electron.menus.at(-1)?.template as Array<Record<string, unknown>>;
    expect(latestTemplate[0]?.enabled).toBe(false);
    expect(latestTemplate.map(({ label, type }) => label ?? type)).toEqual([
      '状态：原生服务连接故障',
      '显示悬浮球',
      '打开设置',
      '重置位置',
      'separator',
      '退出'
    ]);
    expect(latestTemplate[1]?.checked).toBe(false);
  });

  it('routes each actionable menu item without exposing Electron', async () => {
    const actions = createActions();
    const controller = new TrayController(actions);
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    const template = electron.menus.at(-1)?.template as Array<{
      click?: (item: { checked: boolean }) => void;
    }>;
    template[1]?.click?.({ checked: false });
    template[2]?.click?.({ checked: false });
    template[3]?.click?.({ checked: false });
    template[5]?.click?.({ checked: false });
    await Promise.resolve();
    expect(actions.setBallVisible).toHaveBeenCalledWith(false);
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.resetBallPosition).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it('contains rejected asynchronous Tray commands', async () => {
    const actions = createActions();
    vi.mocked(actions.setBallVisible).mockRejectedValue(new Error('sensitive database failure'));
    vi.mocked(actions.resetBallPosition).mockRejectedValue(new Error('sensitive database failure'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new TrayController(actions);
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    const template = electron.menus.at(-1)?.template as Array<{
      click?: (item: { checked: boolean }) => void;
    }>;
    template[1]?.click?.({ checked: false });
    template[3]?.click?.({ checked: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('sensitive'));
    warning.mockRestore();
  });

  it('opens a context menu both before Tray creation and for a Ball window', async () => {
    const controller = new TrayController(createActions());
    controller.update(DEFAULT_UI_SHELL_SNAPSHOT);
    controller.openContextMenu();
    expect(electron.menus.at(-1)?.popup).toHaveBeenCalledWith({});

    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    const window = { role: 'ball' };
    controller.openContextMenu(window as never);
    expect(electron.menus.at(-1)?.popup).toHaveBeenCalledWith({ window });
  });

  it('disposes safely before and after creation', async () => {
    const controller = new TrayController(createActions());
    controller.dispose();
    await controller.start(DEFAULT_UI_SHELL_SNAPSHOT);
    const tray = electron.FakeTray.instances[0]!;
    controller.dispose();
    controller.dispose();
    expect(tray.destroy).toHaveBeenCalledOnce();
    expect(controller.getTray()).toBeUndefined();
    controller.openContextMenu();
  });
});

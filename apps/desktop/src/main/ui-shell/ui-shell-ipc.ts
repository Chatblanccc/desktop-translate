import {
  isSetBallVisiblePayload,
  isSetEdgeSnapPayload,
  isSetThemePayload,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import { UI_SHELL_CHANNELS } from '../../shared/ui-shell-channels.js';

export type WindowRole = 'ball' | 'settings';

export interface InvokeEventLike {
  readonly sender: {
    readonly id: number;
    readonly mainFrame: unknown;
  };
  readonly senderFrame: { readonly url: string } | null;
}

export interface IpcMainPort {
  handle(
    channel: string,
    listener: (event: InvokeEventLike, ...args: readonly unknown[]) => unknown
  ): void;
  removeHandler(channel: string): void;
}

export interface UiShellIpcActions {
  getSnapshot(): UiShellSnapshot;
  openSettings(): void;
  openContextMenu(): void;
  setBallVisible(value: boolean): Promise<void>;
  setEdgeSnap(value: boolean): Promise<void>;
  setTheme(value: ThemeMode): Promise<void>;
  resetBallPosition(): Promise<void>;
}

export interface UiShellIpcOptions {
  readonly ipcMain: IpcMainPort;
  readonly resolveRole: (event: InvokeEventLike) => WindowRole | undefined;
  readonly actions: UiShellIpcActions;
}

function assertNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new TypeError('UI shell request does not accept arguments');
}

function assertRole(
  event: InvokeEventLike,
  resolveRole: UiShellIpcOptions['resolveRole'],
  allowed: readonly WindowRole[]
): WindowRole {
  if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('UI shell request rejected');
  }
  const role = resolveRole(event);
  if (role === undefined || !allowed.includes(role)) throw new Error('UI shell request rejected');
  return role;
}

export function registerUiShellIpc(options: UiShellIpcOptions): () => void {
  const { ipcMain, actions, resolveRole } = options;
  const channels = Object.values(UI_SHELL_CHANNELS).filter(
    (channel) => channel !== UI_SHELL_CHANNELS.snapshotChanged
  );

  ipcMain.handle(UI_SHELL_CHANNELS.getSnapshot, (event, ...args) => {
    assertRole(event, resolveRole, ['ball', 'settings']);
    assertNoArguments(args);
    return actions.getSnapshot();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.openSettings, (event, ...args) => {
    assertRole(event, resolveRole, ['ball']);
    assertNoArguments(args);
    actions.openSettings();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.openContextMenu, (event, ...args) => {
    assertRole(event, resolveRole, ['ball']);
    assertNoArguments(args);
    actions.openContextMenu();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setBallVisible, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSetBallVisiblePayload(args[0])) {
      throw new TypeError('Invalid ball visibility request');
    }
    await actions.setBallVisible(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setEdgeSnap, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSetEdgeSnapPayload(args[0])) {
      throw new TypeError('Invalid edge snap request');
    }
    await actions.setEdgeSnap(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setTheme, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSetThemePayload(args[0])) {
      throw new TypeError('Invalid theme request');
    }
    await actions.setTheme(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.resetBallPosition, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    assertNoArguments(args);
    await actions.resetBallPosition();
  });

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

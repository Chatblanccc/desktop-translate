import {
  isUiShellSnapshot,
  type OcrActivation,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import { UI_SHELL_CHANNELS } from '../shared/ui-shell-channels.js';

export type SnapshotChangedListener = (snapshot: UiShellSnapshot) => void;

export interface BallRendererBridge {
  getSnapshot(): Promise<UiShellSnapshot>;
  openSettings(): Promise<void>;
  openContextMenu(): Promise<void>;
  onSnapshotChanged(listener: SnapshotChangedListener): () => void;
}

export interface SettingsRendererBridge {
  getSnapshot(): Promise<UiShellSnapshot>;
  setBallVisible(visible: boolean): Promise<void>;
  setEdgeSnap(enabled: boolean): Promise<void>;
  setTheme(theme: ThemeMode): Promise<void>;
  setSelectionEnabled(enabled: boolean): Promise<void>;
  setOcrActivation(activation: OcrActivation): Promise<void>;
  resetBallPosition(): Promise<void>;
  onSnapshotChanged(listener: SnapshotChangedListener): () => void;
}

export interface IpcRendererBridgePort {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void;
}

async function getSnapshot(ipc: IpcRendererBridgePort): Promise<UiShellSnapshot> {
  const value = await ipc.invoke(UI_SHELL_CHANNELS.getSnapshot);
  if (!isUiShellSnapshot(value)) throw new Error('Main returned an invalid UI shell snapshot');
  return value;
}

async function invokeVoid(
  ipc: IpcRendererBridgePort,
  channel: string,
  payload?: unknown
): Promise<void> {
  const result = payload === undefined
    ? await ipc.invoke(channel)
    : await ipc.invoke(channel, payload);
  if (result !== undefined) throw new Error('Main returned an unexpected UI shell response');
}

function subscribe(
  ipc: IpcRendererBridgePort,
  listener: SnapshotChangedListener
): () => void {
  if (typeof listener !== 'function') throw new TypeError('Snapshot listener must be a function');
  const wrapped = (_event: unknown, value: unknown): void => {
    if (isUiShellSnapshot(value)) listener(value);
  };
  ipc.on(UI_SHELL_CHANNELS.snapshotChanged, wrapped);
  return () => ipc.removeListener(UI_SHELL_CHANNELS.snapshotChanged, wrapped);
}

export function createBallRendererBridge(ipc: IpcRendererBridgePort): BallRendererBridge {
  return Object.freeze({
    getSnapshot: () => getSnapshot(ipc),
    openSettings: () => invokeVoid(ipc, UI_SHELL_CHANNELS.openSettings),
    openContextMenu: () => invokeVoid(ipc, UI_SHELL_CHANNELS.openContextMenu),
    onSnapshotChanged: (listener: SnapshotChangedListener) => subscribe(ipc, listener)
  });
}

export function createSettingsRendererBridge(ipc: IpcRendererBridgePort): SettingsRendererBridge {
  return Object.freeze({
    getSnapshot: () => getSnapshot(ipc),
    setBallVisible: (value: boolean) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setBallVisible, { value }),
    setEdgeSnap: (value: boolean) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setEdgeSnap, { value }),
    setTheme: (value: ThemeMode) => invokeVoid(ipc, UI_SHELL_CHANNELS.setTheme, { value }),
    setSelectionEnabled: (value: boolean) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setSelectionEnabled, { value }),
    setOcrActivation: (value: OcrActivation) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setOcrActivation, { value }),
    resetBallPosition: () => invokeVoid(ipc, UI_SHELL_CHANNELS.resetBallPosition),
    onSnapshotChanged: (listener: SnapshotChangedListener) => subscribe(ipc, listener)
  });
}

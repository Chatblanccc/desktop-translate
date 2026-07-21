import {
  isUiShellSnapshot,
  CLEAR_LOCAL_DATA_CONFIRMATION,
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
  setTranslationEnabled(enabled: boolean): Promise<void>;
  setTranslationSourceLanguage(language: string): Promise<void>;
  setTranslationTargetLanguage(language: string): Promise<void>;
  saveBaiduCredentials(appId: string, secretKey: string, consentVersion: number): Promise<void>;
  deleteBaiduCredentials(): Promise<void>;
  testTranslationProvider(): Promise<TranslationProviderTestResult>;
  openProviderPrivacyPolicy(): Promise<void>;
  openProviderServiceTerms(): Promise<void>;
  resetBallPosition(): Promise<void>;
  clearAllLocalData(confirmation: typeof CLEAR_LOCAL_DATA_CONFIRMATION): Promise<void>;
  onSnapshotChanged(listener: SnapshotChangedListener): () => void;
}

export interface TranslationProviderTestResult {
  readonly ok: boolean;
  readonly code?: string;
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

function isTranslationProviderTestResult(value: unknown): value is TranslationProviderTestResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ['ok', 'code'].includes(key))) return false;
  return typeof record.ok === 'boolean'
    && (record.code === undefined
      || (typeof record.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(record.code)));
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
    setTranslationEnabled: (value: boolean) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setTranslationEnabled, { value }),
    setTranslationSourceLanguage: (value: string) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setTranslationSourceLanguage, { value }),
    setTranslationTargetLanguage: (value: string) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.setTranslationTargetLanguage, { value }),
    saveBaiduCredentials: (appId: string, secretKey: string, consentVersion: number) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.saveBaiduCredentials, {
        appId,
        secretKey,
        consentVersion
      }),
    deleteBaiduCredentials: () =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.deleteBaiduCredentials),
    async testTranslationProvider() {
      const value = await ipc.invoke(UI_SHELL_CHANNELS.testTranslationProvider);
      if (!isTranslationProviderTestResult(value)) {
        throw new Error('Main returned an invalid provider test result');
      }
      return value;
    },
    openProviderPrivacyPolicy: () =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.openProviderPrivacyPolicy),
    openProviderServiceTerms: () =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.openProviderServiceTerms),
    resetBallPosition: () => invokeVoid(ipc, UI_SHELL_CHANNELS.resetBallPosition),
    clearAllLocalData: (confirmation: typeof CLEAR_LOCAL_DATA_CONFIRMATION) =>
      invokeVoid(ipc, UI_SHELL_CHANNELS.clearAllLocalData, { confirmation }),
    onSnapshotChanged: (listener: SnapshotChangedListener) => subscribe(ipc, listener)
  });
}

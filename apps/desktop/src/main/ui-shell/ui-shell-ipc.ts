import {
  isSetBallVisiblePayload,
  isSetEdgeSnapPayload,
  isSetThemePayload,
  isSetSelectionEnabledPayload,
  isSetOcrActivationPayload,
  type OcrActivation,
  type ThemeMode,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import {
  isPhase4TranslationSourceLanguage,
  isPhase4TranslationTargetLanguage
} from '@desktop-translate/contracts/translation';
import { UI_SHELL_CHANNELS } from '../../shared/ui-shell-channels.js';
import { isBaiduProviderCredentials } from '../translation/provider-credential-store.js';

export type WindowRole = 'ball' | 'settings' | 'card';

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
  setSelectionEnabled(value: boolean): Promise<void>;
  setOcrActivation(value: OcrActivation): Promise<void>;
  setTranslationEnabled(value: boolean): Promise<void>;
  setTranslationSourceLanguage(value: string): Promise<void>;
  setTranslationTargetLanguage(value: string): Promise<void>;
  saveBaiduCredentials(
    credentials: { readonly appId: string; readonly secretKey: string },
    consentVersion: number
  ): Promise<void>;
  deleteBaiduCredentials(): Promise<void>;
  testTranslationProvider(): Promise<{ readonly ok: boolean; readonly code?: string }>;
  openProviderPrivacyPolicy(): Promise<void>;
  openProviderServiceTerms(): Promise<void>;
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

function isSingleBooleanValue(value: unknown): value is { readonly value: boolean } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as Record<string, unknown>).value === 'boolean';
}

function isTranslationLanguagePayload(value: unknown): value is { readonly value: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1
    && isPhase4TranslationTargetLanguage(record.value);
}

function isTranslationSourceLanguagePayload(value: unknown): value is { readonly value: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1
    && isPhase4TranslationSourceLanguage(record.value);
}

function isSaveCredentialsPayload(value: unknown): value is {
  readonly appId: string;
  readonly secretKey: string;
  readonly consentVersion: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && isBaiduProviderCredentials({ appId: record.appId, secretKey: record.secretKey })
    && Number.isSafeInteger(record.consentVersion)
    && record.consentVersion === 1;
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
  ipcMain.handle(UI_SHELL_CHANNELS.setSelectionEnabled, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSetSelectionEnabledPayload(args[0])) {
      throw new TypeError('Invalid selection enabled request');
    }
    await actions.setSelectionEnabled(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setOcrActivation, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSetOcrActivationPayload(args[0])) {
      throw new TypeError('Invalid OCR activation request');
    }
    await actions.setOcrActivation(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setTranslationEnabled, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSingleBooleanValue(args[0])) {
      throw new TypeError('Invalid translation enabled request');
    }
    await actions.setTranslationEnabled(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setTranslationSourceLanguage, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isTranslationSourceLanguagePayload(args[0])) {
      throw new TypeError('Invalid translation source language request');
    }
    await actions.setTranslationSourceLanguage(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.setTranslationTargetLanguage, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isTranslationLanguagePayload(args[0])) {
      throw new TypeError('Invalid translation language request');
    }
    await actions.setTranslationTargetLanguage(args[0].value);
  });
  ipcMain.handle(UI_SHELL_CHANNELS.saveBaiduCredentials, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    if (args.length !== 1 || !isSaveCredentialsPayload(args[0])) {
      throw new TypeError('Invalid provider credential request');
    }
    await actions.saveBaiduCredentials(
      { appId: args[0].appId, secretKey: args[0].secretKey },
      args[0].consentVersion
    );
  });
  ipcMain.handle(UI_SHELL_CHANNELS.deleteBaiduCredentials, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    assertNoArguments(args);
    await actions.deleteBaiduCredentials();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.testTranslationProvider, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    assertNoArguments(args);
    return actions.testTranslationProvider();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.openProviderPrivacyPolicy, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    assertNoArguments(args);
    await actions.openProviderPrivacyPolicy();
  });
  ipcMain.handle(UI_SHELL_CHANNELS.openProviderServiceTerms, async (event, ...args) => {
    assertRole(event, resolveRole, ['settings']);
    assertNoArguments(args);
    await actions.openProviderServiceTerms();
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

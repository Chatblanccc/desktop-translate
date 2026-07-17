import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  app,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
  session,
  shell,
  type Rectangle
} from 'electron';
import type {
  HealthResponse,
  HostError,
  SelectionResult,
  StartConfig
} from '@desktop-translate/contracts/native-ipc';
import type {
  OcrActivation,
  ThemeMode,
  UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import {
  SqliteAppExclusionsRepository,
  SqlitePhase4SettingsRepository,
  SqliteSecretsRepository,
  runStorageMigrations
} from '@desktop-translate/storage';
import {
  BaiduTranslationProvider,
  TranslationProviderError,
  type BaiduTransport
} from '@desktop-translate/translation';
import { NativeHostClient } from '../native-host/native-host-client.js';
import { NativeHostSupervisor } from '../native-host/native-host-supervisor.js';
import {
  createDefaultBallAnchor,
  deriveBallPlacement,
  resolveBallBounds,
  type DisplayLike
} from './ball-position.js';
import { UiShellState } from './shell-state.js';
import { TrayController } from './tray-controller.js';
import { registerUiShellIpc } from './ui-shell-ipc.js';
import { registerSelectionCardIpc } from './selection-card-ipc.js';
import {
  resolveSelectionCardBounds,
  unionRectangles
} from './selection-card-position.js';
import { WindowManager } from './window-manager.js';
import { ProviderCredentialStore } from '../translation/provider-credential-store.js';
import { TranslationController } from '../translation/translation-controller.js';

const PROVIDER_PRIVACY_URL = 'https://fanyi-app.baidu.com/static/agreement/privacy.html';
const PROVIDER_SERVICE_TERMS_URL = 'https://fanyi-api.baidu.com/doc/6';
const TRANSLATION_CONSENT_VERSION = 1;

export interface ShellControllerOptions {
  readonly requestQuit: () => void;
  readonly translationTransport?: BaiduTransport;
}

interface NativeLaunchOptions {
  readonly executablePath: string;
  readonly executableArguments?: readonly string[];
}

export interface Phase2DebugState {
  readonly snapshot: UiShellSnapshot;
  readonly trayCreated: boolean;
  readonly ballCreated: boolean;
  readonly ballVisible: boolean;
  readonly ballBounds?: Rectangle;
  readonly settingsCreated: boolean;
  readonly settingsVisible: boolean;
  readonly cardCreated: boolean;
  readonly cardVisible: boolean;
}

export class ShellController {
  private readonly state = new UiShellState();
  private database: DatabaseSync | undefined;
  private settings: SqlitePhase4SettingsRepository | undefined;
  private exclusions: SqliteAppExclusionsRepository | undefined;
  private credentials: ProviderCredentialStore | undefined;
  private translationProvider: BaiduTranslationProvider | undefined;
  private translation: TranslationController | undefined;
  private providerTestAbortController: AbortController | undefined;
  private windows: WindowManager | undefined;
  private tray: TrayController | undefined;
  private nativeHost: NativeHostSupervisor | undefined;
  private nativeClient: NativeHostClient | undefined;
  private disposeIpc: (() => void) | undefined;
  private disposeCardIpc: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private positionWrite = Promise.resolve();
  private selectionCommand = Promise.resolve();
  private readonly displayChanged = (): void => {
    this.dismissTranslationCard();
    void this.recoverBallPosition().catch(() => {
      console.warn('[phase2:display] Failed to persist recovered ball position.');
    });
    if (this.state.getSnapshot().selection.enabled && this.nativeClient !== undefined) {
      this.selectionCommand = this.selectionCommand
        .catch(() => undefined)
        .then(() => this.restartNativeListening())
        .catch(() => {
          this.state.setSelectionLifecycle('faulted');
        });
    }
  };
  private readonly onStateChanged = (snapshot: UiShellSnapshot): void => {
    nativeTheme.themeSource = snapshot.theme;
    this.windows?.setBallVisible(snapshot.ball.visible);
    this.windows?.broadcast(snapshot);
    this.tray?.update(snapshot);
  };

  public constructor(private readonly options: ShellControllerOptions) {}

  public async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.configureSessionSecurity();

    const database = new DatabaseSync(join(app.getPath('userData'), 'desktop-translate.sqlite3'));
    this.database = database;
    runStorageMigrations(database, { migrationsDirectory: resolveMigrationsDirectory() });
    const settings = new SqlitePhase4SettingsRepository(database, {
      onInvalidSetting: (key) => console.warn(`[phase4:settings] Ignored invalid setting: ${key}`)
    });
    this.settings = settings;
    this.exclusions = new SqliteAppExclusionsRepository(database);
    const credentials = new ProviderCredentialStore(
      new SqliteSecretsRepository(database),
      safeStorage
    );
    this.credentials = credentials;
    const credentialStatus = await credentials.getStatus();
    this.state.initialize(await settings.load(), credentialStatus);
    const translationProvider = new BaiduTranslationProvider({
      credentials: () => credentials.load(),
      ...(this.options.translationTransport === undefined
        ? {}
        : { transport: this.options.translationTransport })
    });
    this.translationProvider = translationProvider;
    if (this.disposed) return;
    nativeTheme.themeSource = this.state.getSnapshot().theme;

    const displays = getDisplays();
    const initialBounds = resolveBallBounds(this.state.getSnapshot().ball.anchor, displays);
    const buildDirectory = join(app.getAppPath(), '.vite', 'build');
    const windows = new WindowManager({
      appPath: app.getAppPath(),
      buildDirectory,
      initialBallBounds: initialBounds,
      initialBallVisible: this.state.getSnapshot().ball.visible,
      onBallMoved: (bounds) => {
        void this.handleBallMoved(bounds).catch(() => {
          console.warn('[phase2:display] Failed to persist the moved ball position.');
        });
      },
      onCardDismissed: () => this.translation?.dismiss()
    });
    this.windows = windows;
    this.translation = new TranslationController({
      provider: translationProvider,
      getSettings: () => this.state.getSnapshot().translation,
      presentCard: (card, bounds) => windows.presentSelectionCard(card, bounds),
      hideCard: () => windows.dismissSelectionCard()
    });
    this.disposeIpc = registerUiShellIpc({
      ipcMain,
      resolveRole: (event) => windows.resolveRole(event),
      actions: {
        getSnapshot: () => this.state.getSnapshot(),
        openSettings: () => windows.openSettings(),
        openContextMenu: () => this.tray?.openContextMenu(windows.getBallWindow()),
        setBallVisible: (value) => this.setBallVisible(value),
        setEdgeSnap: (value) => this.setEdgeSnap(value),
        setTheme: (value) => this.setTheme(value),
        setSelectionEnabled: (value) => this.setSelectionEnabled(value),
        setOcrActivation: (value) => this.setOcrActivation(value),
        setTranslationEnabled: (value) => this.setTranslationEnabled(value),
        setTranslationSourceLanguage: (value) => this.setTranslationSourceLanguage(value),
        setTranslationTargetLanguage: (value) => this.setTranslationTargetLanguage(value),
        saveBaiduCredentials: (value, consentVersion) =>
          this.saveBaiduCredentials(value, consentVersion),
        deleteBaiduCredentials: () => this.deleteBaiduCredentials(),
        testTranslationProvider: () => this.testTranslationProvider(),
        openProviderPrivacyPolicy: () => this.openProviderPrivacyPolicy(),
        openProviderServiceTerms: () => this.openProviderServiceTerms(),
        resetBallPosition: () => this.resetBallPosition()
      }
    });
    this.disposeCardIpc = registerSelectionCardIpc({
      ipcMain,
      resolveRole: (event) => windows.resolveRole(event),
      getCurrent: () => windows.getCurrentSelectionCard(),
      dismiss: () => windows.dismissSelectionCard(true),
      retry: () => this.translation?.retry()
    });

    const tray = new TrayController({
      openSettings: () => windows.openSettings(),
      setBallVisible: (value) => this.setBallVisible(value),
      setSelectionEnabled: (value) => this.setSelectionEnabled(value),
      resetBallPosition: () => this.resetBallPosition(),
      quit: this.options.requestQuit
    });
    this.tray = tray;
    this.state.on('changed', this.onStateChanged);
    await tray.start(this.state.getSnapshot());
    if (this.disposed) {
      tray.dispose();
      windows.dispose();
      return;
    }
    await windows.start();
    if (this.disposed) {
      tray.dispose();
      windows.dispose();
      return;
    }

    screen.on('display-added', this.displayChanged);
    screen.on('display-removed', this.displayChanged);
    screen.on('display-metrics-changed', this.displayChanged);
    void this.startNativeHost();
  }

  public openSettings(): void {
    this.windows?.openSettings();
  }

  public closeSettingsForTest(): void {
    if (process.env.DESKTOP_TRANSLATE_E2E !== '1') throw new Error('Test API is disabled');
    this.windows?.getSettingsWindow()?.close();
  }

  public async moveBallForTest(x: number, y: number): Promise<void> {
    if (process.env.DESKTOP_TRANSLATE_E2E !== '1') throw new Error('Test API is disabled');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('Invalid test bounds');
    const current = this.windows?.getBallBounds();
    if (current === undefined) throw new Error('Ball window is unavailable');
    await this.handleBallMoved({ ...current, x: Math.round(x), y: Math.round(y) });
  }

  public getDebugState(): Phase2DebugState {
    const ball = this.windows?.getBallWindow();
    const settings = this.windows?.getSettingsWindow();
    const card = this.windows?.getCardWindow();
    const ballBounds = ball === undefined || ball.isDestroyed() ? undefined : ball.getBounds();
    const base = {
      snapshot: this.state.getSnapshot(),
      trayCreated: this.tray?.getTray() !== undefined,
      ballCreated: ball !== undefined && !ball.isDestroyed(),
      ballVisible: ball !== undefined && !ball.isDestroyed() && ball.isVisible(),
      settingsCreated: settings !== undefined && !settings.isDestroyed(),
      settingsVisible: settings !== undefined && !settings.isDestroyed() && settings.isVisible(),
      cardCreated: card !== undefined && !card.isDestroyed(),
      cardVisible: card !== undefined && !card.isDestroyed() && card.isVisible()
    };
    return ballBounds === undefined ? base : { ...base, ballBounds };
  }

  public async setBallVisible(value: boolean): Promise<void> {
    const settings = this.requireSettings();
    await settings.setBallVisible(value);
    this.state.setBallVisible(value);
  }

  public async setEdgeSnap(value: boolean): Promise<void> {
    const settings = this.requireSettings();
    await settings.setEdgeSnap(value);
    this.state.setEdgeSnap(value);
    const bounds = this.windows?.getBallBounds();
    if (bounds !== undefined) await this.handleBallMoved(bounds);
  }

  public async setTheme(value: ThemeMode): Promise<void> {
    const settings = this.requireSettings();
    await settings.setTheme(value);
    this.state.setTheme(value);
  }

  public async resetBallPosition(): Promise<void> {
    const settings = this.requireSettings();
    const primary = toDisplayLike(screen.getPrimaryDisplay());
    const anchor = createDefaultBallAnchor(primary);
    await settings.setBallAnchor(anchor);
    this.state.setBallAnchor(anchor);
    this.windows?.setBallBounds(resolveBallBounds(anchor, getDisplays()));
  }

  public async setSelectionEnabled(value: boolean): Promise<void> {
    const settings = this.requireSettings();
    await settings.setSelectionEnabled(value);
    this.state.setSelectionEnabled(value);
    if (!value) this.dismissTranslationCard();
    const client = this.nativeClient;
    if (client === undefined) return;
    this.selectionCommand = this.selectionCommand
      .catch(() => undefined)
      .then(async () => {
        if (value) await this.startNativeListening(client);
        else await this.stopNativeListening(client);
      });
    await this.selectionCommand;
  }

  public async setOcrActivation(value: OcrActivation): Promise<void> {
    this.dismissTranslationCard();
    const settings = this.requireSettings();
    await settings.setOcrActivation(value);
    this.state.setOcrActivation(value);
    if (!this.state.getSnapshot().selection.enabled || this.nativeClient === undefined) return;
    this.selectionCommand = this.selectionCommand
      .catch(() => undefined)
      .then(() => this.restartNativeListening());
    await this.selectionCommand;
  }

  public async setTranslationEnabled(value: boolean): Promise<void> {
    const settings = this.requireSettings();
    if (!value) {
      // Fail closed in memory before touching persistence. A database failure
      // must not leave the old credential usable for another outbound request.
      this.dismissTranslationCard();
      this.cancelProviderTest('translation-disabled');
      this.state.setTranslationEnabled(false);
      await settings.setTranslationEnabled(false);
      return;
    }
    const snapshot = this.state.getSnapshot();
    if (
      snapshot.translation.credentialStatus !== 'configured'
      || snapshot.translation.consentVersion < TRANSLATION_CONSENT_VERSION
    ) {
      throw new Error('Online translation requires configured credentials and consent');
    }
    await settings.setTranslationEnabled(true);
    this.state.setTranslationEnabled(true);
  }

  public async setTranslationTargetLanguage(value: string): Promise<void> {
    this.dismissTranslationCard();
    const settings = this.requireSettings();
    await settings.setTranslationTargetLanguage(value);
    this.state.setTranslationTargetLanguage(value);
  }

  public async setTranslationSourceLanguage(value: string): Promise<void> {
    this.dismissTranslationCard();
    const settings = this.requireSettings();
    await settings.setTranslationSourceLanguage(value);
    this.state.setTranslationSourceLanguage(value);
  }

  public async saveBaiduCredentials(
    credentials: { readonly appId: string; readonly secretKey: string },
    consentVersion: number
  ): Promise<void> {
    if (consentVersion !== TRANSLATION_CONSENT_VERSION) {
      throw new TypeError('Translation consent version is invalid');
    }
    this.dismissTranslationCard();
    this.cancelProviderTest('credentials-replaced');
    await this.requireCredentials().save(credentials);
    await this.requireSettings().setTranslationConsentVersion(consentVersion);
    this.state.setTranslationConsentVersion(consentVersion);
    this.state.setTranslationCredentialStatus(await this.requireCredentials().getStatus());
  }

  public async deleteBaiduCredentials(): Promise<void> {
    this.dismissTranslationCard();
    this.cancelProviderTest('credentials-deleted');
    // Reflect the most conservative runtime state before any storage operation.
    this.state.setTranslationEnabled(false);
    this.state.setTranslationConsentVersion(0);
    this.state.setTranslationCredentialStatus('unavailable');

    const settings = this.requireSettings();
    let persistenceError: unknown;
    try {
      await settings.setTranslationEnabled(false);
    } catch (error) {
      persistenceError = error;
    }
    try {
      await settings.resetTranslationConsent();
    } catch (error) {
      persistenceError ??= error;
    }

    let credentialDeleted = false;
    try {
      await this.requireCredentials().delete();
      credentialDeleted = true;
    } catch (error) {
      persistenceError ??= error;
    }
    this.state.setTranslationCredentialStatus(credentialDeleted ? 'missing' : 'unavailable');
    if (persistenceError !== undefined) {
      throw new Error('Provider credentials could not be fully removed');
    }
  }

  public async testTranslationProvider(): Promise<{ readonly ok: boolean; readonly code?: string }> {
    const translation = this.state.getSnapshot().translation;
    if (translation.credentialStatus !== 'configured') {
      return { ok: false, code: 'credentials-missing' };
    }
    if (translation.consentVersion < TRANSLATION_CONSENT_VERSION) {
      return { ok: false, code: 'consent-required' };
    }
    this.cancelProviderTest('provider-test-replaced');
    const controller = new AbortController();
    this.providerTestAbortController = controller;
    try {
      await this.requireTranslationProvider().translate({
        requestId: randomUUID(),
        selectionId: randomUUID(),
        text: 'hello',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN'
      }, {
        signal: controller.signal,
        now: () => new Date()
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof TranslationProviderError ? error.failure.code : 'unknown'
      };
    } finally {
      if (this.providerTestAbortController === controller) {
        this.providerTestAbortController = undefined;
      }
      controller.abort('provider-test-complete');
    }
  }

  public async openProviderPrivacyPolicy(): Promise<void> {
    await shell.openExternal(PROVIDER_PRIVACY_URL);
  }

  public async openProviderServiceTerms(): Promise<void> {
    await shell.openExternal(PROVIDER_SERVICE_TERMS_URL);
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.performDispose();
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    this.disposed = true;
    this.cancelProviderTest('app-disposed');
    this.translation?.cancelAndHide();
    screen.removeListener('display-added', this.displayChanged);
    screen.removeListener('display-removed', this.displayChanged);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    this.state.removeListener('changed', this.onStateChanged);
    this.disposeIpc?.();
    this.disposeIpc = undefined;
    this.disposeCardIpc?.();
    this.disposeCardIpc = undefined;
    await this.positionWrite.catch(() => undefined);
    await this.nativeHost?.stop().catch(() => undefined);
    this.nativeHost = undefined;
    this.nativeClient = undefined;
    this.tray?.dispose();
    this.tray = undefined;
    this.windows?.dispose();
    this.windows = undefined;
    this.database?.close();
    this.database = undefined;
    this.settings = undefined;
    this.exclusions = undefined;
    this.credentials = undefined;
    this.translationProvider = undefined;
    this.translation = undefined;
  }

  private requireSettings(): SqlitePhase4SettingsRepository {
    if (this.settings === undefined) throw new Error('Phase 4 settings are not initialized');
    return this.settings;
  }

  private requireCredentials(): ProviderCredentialStore {
    if (this.credentials === undefined) throw new Error('Provider credentials are not initialized');
    return this.credentials;
  }

  private requireTranslationProvider(): BaiduTranslationProvider {
    if (this.translationProvider === undefined) throw new Error('Translation provider is not initialized');
    return this.translationProvider;
  }

  private dismissTranslationCard(): void {
    if (this.translation === undefined) this.windows?.dismissSelectionCard();
    else this.translation.cancelAndHide();
  }

  private cancelProviderTest(reason: string): void {
    const controller = this.providerTestAbortController;
    this.providerTestAbortController = undefined;
    controller?.abort(reason);
  }

  private async handleBallMoved(bounds: Rectangle): Promise<void> {
    const placement = deriveBallPlacement(bounds, getDisplays(), this.state.getSnapshot().ball.edgeSnap);
    if (
      placement.bounds.x !== bounds.x ||
      placement.bounds.y !== bounds.y ||
      placement.bounds.width !== bounds.width ||
      placement.bounds.height !== bounds.height
    ) {
      this.windows?.setBallBounds(placement.bounds);
    }
    this.state.setBallAnchor(placement.anchor);
    this.positionWrite = this.positionWrite
      .catch(() => undefined)
      .then(() => this.requireSettings().setBallAnchor(placement.anchor));
    await this.positionWrite;
  }

  private async recoverBallPosition(): Promise<void> {
    const snapshot = this.state.getSnapshot();
    const displays = getDisplays();
    const resolved = resolveBallBounds(snapshot.ball.anchor, displays);
    const placement = deriveBallPlacement(resolved, displays, snapshot.ball.edgeSnap);
    this.windows?.setBallBounds(placement.bounds);
    if (JSON.stringify(placement.anchor) !== JSON.stringify(snapshot.ball.anchor)) {
      this.state.setBallAnchor(placement.anchor);
      await this.requireSettings().setBallAnchor(placement.anchor);
    }
  }

  private configureSessionSecurity(): void {
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionCheckHandler(() => false);
    defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    defaultSession.on('will-download', (event) => event.preventDefault());
  }

  private async startNativeHost(): Promise<void> {
    if (this.disposed) return;
    const launch = resolveNativeLaunchOptions();
    if (launch === undefined || !existsSync(launch.executablePath)) {
      this.state.setNativeStatus('unavailable');
      this.state.setSelectionLifecycle(
        this.state.getSnapshot().selection.enabled ? 'faulted' : 'disabled'
      );
      return;
    }
    this.state.setNativeStatus('starting');
    const supervisor = new NativeHostSupervisor({
      ...launch,
      desktopVersion: app.getVersion()
    });
    this.nativeHost = supervisor;
    supervisor.on('ready', () => this.state.setNativeStatus('ready'));
    supervisor.on('clientReady', (client: NativeHostClient) => {
      this.nativeClient = client;
      this.selectionCommand = this.selectionCommand
        .catch(() => undefined)
        .then(async () => {
          if (this.state.getSnapshot().selection.enabled) await this.startNativeListening(client);
          else this.state.setSelectionLifecycle('disabled');
        })
        .catch(() => {
          if (this.nativeClient === client) this.state.setSelectionLifecycle('faulted');
        });
    });
    supervisor.on('selection', (selection: SelectionResult) => this.handleSelection(selection));
    supervisor.on('hostError', (error: HostError) => this.handleHostError(error));
    supervisor.on('health', (health: HealthResponse) => this.applyHealth(health));
    supervisor.on('unhealthy', () => {
      this.nativeClient = undefined;
      this.dismissTranslationCard();
      this.state.setNativeStatus('starting');
      this.state.setSelectionLifecycle(
        this.state.getSnapshot().selection.enabled ? 'starting' : 'disabled'
      );
    });
    supervisor.on('restarting', () => {
      this.nativeClient = undefined;
      this.dismissTranslationCard();
      this.state.setNativeStatus('starting');
      this.state.setSelectionLifecycle(
        this.state.getSnapshot().selection.enabled ? 'starting' : 'disabled'
      );
    });
    supervisor.on('fatal', () => {
      this.nativeClient = undefined;
      this.dismissTranslationCard();
      this.state.setNativeStatus('faulted');
      this.state.setSelectionLifecycle('faulted');
    });
    try {
      await supervisor.start();
    } catch {
      this.state.setNativeStatus('faulted');
      this.state.setSelectionLifecycle('faulted');
    }
  }

  private applyHealth(health: HealthResponse): void {
    const status = health.payload.status === 'degraded'
      ? 'degraded'
      : health.payload.status === 'ready'
        ? 'ready'
        : health.payload.status === 'starting'
          ? 'starting'
          : 'faulted';
    this.state.setNativeStatus(status, health.payload.degradedCapabilities ?? []);
    const enabled = this.state.getSnapshot().selection.enabled;
    if (!enabled) {
      this.state.setSelectionLifecycle('disabled');
      if (health.payload.listening && this.nativeClient !== undefined) {
        void this.stopNativeListening(this.nativeClient);
      }
      return;
    }
    this.state.setSelectionLifecycle(
      health.payload.listening
        ? health.payload.degradedCapabilities?.length ? 'degraded' : 'listening'
        : 'starting'
    );
  }

  private async nativeStartConfig(): Promise<StartConfig> {
    const persistedExclusions = await this.exclusions?.listEnabledProcessNames() ?? [];
    const selfProcess = basename(process.execPath);
    const excludedProcessNames = [...new Map(
      [selfProcess, ...persistedExclusions].map((name) => [name.toLocaleLowerCase('en-US'), name])
    ).values()];
    return {
      enableUia: true,
      enableOcrFallback: true,
      ocrActivation: this.state.getSnapshot().selection.ocrActivation,
      settleDelayMs: 80,
      minDragDistancePx: 4,
      uiaTimeoutMs: 350,
      ocrTimeoutMs: 2_500,
      excludedProcessNames
    };
  }

  private async startNativeListening(client: NativeHostClient): Promise<void> {
    if (this.nativeClient !== client || !this.state.getSnapshot().selection.enabled) return;
    this.state.setSelectionLifecycle('starting');
    await client.request('start', await this.nativeStartConfig(), 3_000);
    const health = await client.request('health', {});
    this.applyHealth(health);
  }

  private async stopNativeListening(client: NativeHostClient): Promise<void> {
    if (this.nativeClient !== client) return;
    await client.request('stop', { reason: 'selection-disabled' });
    this.state.setSelectionLifecycle('disabled');
    this.dismissTranslationCard();
  }

  private async restartNativeListening(): Promise<void> {
    const client = this.nativeClient;
    if (client === undefined || !this.state.getSnapshot().selection.enabled) return;
    await client.request('stop', { reason: 'selection-config-changed' });
    await this.startNativeListening(client);
  }

  private handleHostError(error: HostError): void {
    if (error.selectionId !== undefined && error.recoverable) return;
    if (!error.recoverable) {
      this.state.setSelectionLifecycle('faulted');
      this.dismissTranslationCard();
    }
  }

  private handleSelection(selection: SelectionResult): void {
    if (!this.state.getSnapshot().selection.enabled) return;
    const physicalRects = selection.physicalRects.length > 0
      ? selection.physicalRects
      : [{ x: selection.releasePoint.x, y: selection.releasePoint.y, width: 1, height: 1 }];
    const dipRects = physicalRects.map((rect) => screen.screenToDipRect(null, rect));
    const anchor = unionRectangles(dipRects);
    if (anchor === undefined) return;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2)
    });
    this.translation?.handleSelection(
      selection,
      resolveSelectionCardBounds(anchor, display.workArea)
    );
  }
}

function toDisplayLike(display: Electron.Display): DisplayLike {
  return { id: display.id, workArea: display.workArea };
}

function getDisplays(): readonly DisplayLike[] {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)].map(
    toDisplayLike
  );
}

function resolveMigrationsDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : resolve(app.getAppPath(), '..', '..', 'packages', 'storage', 'migrations');
}

function resolveNativeLaunchOptions(): NativeLaunchOptions | undefined {
  if (app.isPackaged) {
    return { executablePath: join(process.resourcesPath, 'selection-host', 'selection-host.exe') };
  }
  if (process.env.DESKTOP_TRANSLATE_E2E === '1') {
    const nodePath = process.env.DESKTOP_TRANSLATE_E2E_NODE_PATH;
    const fixturePath = process.env.DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE;
    if (nodePath && fixturePath) {
      const mode = process.env.DESKTOP_TRANSLATE_E2E_NATIVE_MODE;
      return {
        executablePath: nodePath,
        executableArguments: mode
          ? [fixturePath, '--fake-mode', mode]
          : [fixturePath]
      };
    }
  }
  const executablePath = process.env.SELECTION_HOST_PATH?.trim();
  return executablePath ? { executablePath } : undefined;
}

import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';
import type { BaiduTransport } from '@desktop-translate/translation';
import {
  createE2eBaiduTransport
} from '../../e2e/fixtures/e2e-baidu-transport.js';
import { ShellLifecycle } from './shell-lifecycle.js';
import {
  createPhase4AuditTransport,
  PHASE4_AUDIT_FILE_ENV
} from './translation/phase4-audit-transport.js';
import { ShellController, type Phase2DebugState } from './ui-shell/shell-controller.js';
import { createRuntimeMetricsFromEnvironment } from './metrics/runtime-metrics-config.js';
import {
  localDataResetMarkerPath,
  scheduleLocalDataResetAfterExit
} from './local-data-reset.js';
import { DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED } from './build-flavor.js';

const testUserData = process.env.DESKTOP_TRANSLATE_USER_DATA_DIR;
if (DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED && !app.isPackaged && testUserData) {
  app.setPath('userData', resolve(testUserData));
}

routeApplicationStart();

function routeApplicationStart(): void {
  const userDataDirectory = app.getPath('userData');
  if (existsSync(localDataResetMarkerPath(userDataDirectory))) {
    // A prior helper encountered a locked file or was interrupted. Do not open
    // the database or any renderer until deletion has been rescheduled.
    void scheduleLocalDataResetAfterExit({
      userDataDirectory,
      parentProcessId: process.pid,
      executablePath: process.execPath,
      helperScriptPath: resolveLocalDataResetHelperPath()
    }).then(
      () => app.quit(),
      () => {
        console.error('[phase5:data-reset] Pending local-data cleanup could not be scheduled.');
        app.exit(1);
      }
    );
    return;
  }

  startDesktopApplication(userDataDirectory);
}

function startDesktopApplication(userDataDirectory: string): void {
  let lifecycle!: ShellLifecycle<ShellController>;
  lifecycle = new ShellLifecycle<ShellController>({
    createShell: (requestQuit) => {
      const metrics = resolveRuntimeMetrics();
      return new ShellController({
        requestQuit,
        requestLocalDataReset: async () => {
          await scheduleLocalDataResetAfterExit({
            userDataDirectory,
            parentProcessId: process.pid,
            executablePath: process.execPath,
            helperScriptPath: resolveLocalDataResetHelperPath()
          });
          lifecycle.requestShutdown();
        },
        ...(metrics === undefined ? {} : { metrics }),
        ...resolveTranslationTransport()
      });
    },
    onShellStarted: (controller) => {
      if (DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED) {
        installTestApi(controller, lifecycle.requestShutdown);
      }
    },
    onInitializationFailure: () => {
      console.error('[phase2] Desktop shell failed to initialize.');
      app.quit();
    },
    onCleanupFailure: () => console.error('[phase2] Desktop shell cleanup failed.'),
    // ShellController has now awaited Native Host shutdown and pending
    // persistence, destroyed every renderer/tray surface, closed SQLite and
    // the metrics writer, and marked lifecycle cleanup complete. Preserve the
    // complete before-quit/will-quit/quit contract. Release the ProcessSingleton
    // listener before entering Electron's native OnQuit path; otherwise its
    // post-`quit` cleanup can keep an already-disposed tray application alive
    // for a non-deterministic tail. Once the full quit event is reached, use
    // Electron's own immediate-exit API to trim the remaining Chromium tail;
    // no harness termination API is used on the normal exit path.
    // Credential ciphertext is committed before the repository/database close;
    // the Phase 4 restart gate protects that durability contract.
    finishShutdown: () => {
      app.releaseSingleInstanceLock();
      app.once('quit', () => app.exit(0));
      app.quit();
    }
  });

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => lifecycle.handleSecondInstance());
  app.on('window-all-closed', () => {
    // The application is tray-resident. Only an explicit command exits it.
  });
  void lifecycle.startWhenReady(app.whenReady());
  app.on('before-quit', (event) => lifecycle.handleBeforeQuit(event));
}

function resolveLocalDataResetHelperPath(): string {
  return join(app.getAppPath(), '.vite', 'build', 'local-data-reset-helper.js');
}

function resolveRuntimeMetrics() {
  return createRuntimeMetricsFromEnvironment({
    isPackaged: app.isPackaged,
    userDataDirectory: app.getPath('userData'),
    ...(app.isPackaged
      ? {
          resourcesDirectory: process.resourcesPath,
          appBundlePath: join(process.resourcesPath, 'app.asar')
        }
      : {})
  });
}

function resolveTranslationTransport(): { readonly translationTransport?: BaiduTransport } {
  if (DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED) {
    const e2e = resolveE2eTranslationTransport();
    if (e2e.translationTransport !== undefined || process.env.DESKTOP_TRANSLATE_E2E === '1') {
      return e2e;
    }
  }
  const auditTransport = createPhase4AuditTransport(process.env[PHASE4_AUDIT_FILE_ENV]);
  return auditTransport === undefined ? {} : { translationTransport: auditTransport };
}

function resolveE2eTranslationTransport(): { readonly translationTransport?: BaiduTransport } {
  if (app.isPackaged || process.env.DESKTOP_TRANSLATE_E2E !== '1') return {};
  const mode = process.env.DESKTOP_TRANSLATE_E2E_FETCH_MODE;
  if (mode === undefined) return {};
  if (mode !== 'block' && mode !== 'baidu-success') {
    throw new Error('Unsupported E2E translation transport mode');
  }
  const tracePath = process.env.DESKTOP_TRANSLATE_E2E_FETCH_TRACE;
  if (!tracePath) throw new Error('E2E translation transport trace path is required');
  return {
    translationTransport: createE2eBaiduTransport({
      mode,
      tracePath
    })
  };
}

interface Phase2TestApi {
  getState(): Phase2DebugState;
  openSettings(): void;
  closeSettings(): void;
  setBallVisible(value: boolean): Promise<void>;
  setEdgeSnap(value: boolean): Promise<void>;
  setTheme(value: 'system' | 'light' | 'dark'): Promise<void>;
  resetBallPosition(): Promise<void>;
  moveBall(x: number, y: number): Promise<void>;
  quit(): void;
}

function installTestApi(controller: ShellController, requestShutdown: () => void): void {
  if (
    !DESKTOP_TRANSLATE_TEST_HOOKS_ENABLED
    || process.env.DESKTOP_TRANSLATE_E2E !== '1'
    || app.isPackaged
  ) return;
  const testApi: Phase2TestApi = Object.freeze({
    getState: () => controller.getDebugState(),
    openSettings: () => controller.openSettings(),
    closeSettings: () => controller.closeSettingsForTest(),
    setBallVisible: (value: boolean) => controller.setBallVisible(value),
    setEdgeSnap: (value: boolean) => controller.setEdgeSnap(value),
    setTheme: (value: 'system' | 'light' | 'dark') => controller.setTheme(value),
    resetBallPosition: () => controller.resetBallPosition(),
    moveBall: (x: number, y: number) => controller.moveBallForTest(x, y),
    quit: requestShutdown
  });
  Object.defineProperty(globalThis, '__desktopTranslateTestApi', {
    value: testApi,
    enumerable: false,
    configurable: true
  });
}

declare global {
  // Main-process-only E2E hook. It is never exposed through Preload or Renderer.
  var __desktopTranslateTestApi: Phase2TestApi | undefined;
}

import { resolve } from 'node:path';
import { app } from 'electron';
import { ShellLifecycle } from './shell-lifecycle.js';
import { ShellController, type Phase2DebugState } from './ui-shell/shell-controller.js';

const testUserData = process.env.DESKTOP_TRANSLATE_USER_DATA_DIR;
if (!app.isPackaged && testUserData) app.setPath('userData', resolve(testUserData));

const lifecycle = new ShellLifecycle<ShellController>({
  createShell: (requestQuit) => new ShellController({ requestQuit }),
  onShellStarted: installTestApi,
  onInitializationFailure: () => {
    console.error('[phase2] Desktop shell failed to initialize.');
    app.quit();
  },
  onCleanupFailure: () => console.error('[phase2] Desktop shell cleanup failed.'),
  finishShutdown: () => {
    if (process.env.DESKTOP_TRANSLATE_E2E === '1') {
      // Playwright keeps a main-process inspector attached; terminate the
      // already-clean process through the OS after lifecycle assertions.
      process.kill(process.pid, 'SIGTERM');
      return;
    }
    app.exit(0);
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => lifecycle.handleSecondInstance());

  app.on('window-all-closed', () => {
    // Phase 2 is tray-resident. Only the explicit Tray command exits the app.
  });

  void lifecycle.startWhenReady(app.whenReady());
  app.on('before-quit', (event) => lifecycle.handleBeforeQuit(event));
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

function installTestApi(controller: ShellController): void {
  if (process.env.DESKTOP_TRANSLATE_E2E !== '1' || app.isPackaged) return;
  const testApi: Phase2TestApi = Object.freeze({
    getState: () => controller.getDebugState(),
    openSettings: () => controller.openSettings(),
    closeSettings: () => controller.closeSettingsForTest(),
    setBallVisible: (value: boolean) => controller.setBallVisible(value),
    setEdgeSnap: (value: boolean) => controller.setEdgeSnap(value),
    setTheme: (value: 'system' | 'light' | 'dark') => controller.setTheme(value),
    resetBallPosition: () => controller.resetBallPosition(),
    moveBall: (x: number, y: number) => controller.moveBallForTest(x, y),
    quit: lifecycle.requestShutdown
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

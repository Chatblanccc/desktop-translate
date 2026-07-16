import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BallAnchor,
  type UiShellSnapshot
} from '@desktop-translate/contracts/ui-shell';
import type { HealthResponse } from '@desktop-translate/contracts/native-ipc';
import type { SelectionResult } from '@desktop-translate/contracts/native-ipc';

type EventHandler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  const appState = { isPackaged: false };
  const app = {
    getPath: vi.fn(() => 'C:\\profile'),
    getAppPath: vi.fn(() => 'C:\\repo\\apps\\desktop'),
    getVersion: vi.fn(() => '0.3.0-phase3'),
    get isPackaged(): boolean { return appState.isPackaged; }
  };

  const primaryDisplay = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1032 }
  };
  const secondaryDisplay = {
    id: 2,
    workArea: { x: -1280, y: 0, width: 1280, height: 984 }
  };
  const screenHandlers = new Map<string, Set<EventHandler>>();
  const screen = {
    getPrimaryDisplay: vi.fn(() => primaryDisplay),
    getAllDisplays: vi.fn(() => [primaryDisplay, secondaryDisplay]),
    screenToDipRect: vi.fn((_window: unknown, rect: object) => rect),
    getDisplayNearestPoint: vi.fn(() => primaryDisplay),
    on: vi.fn((event: string, handler: EventHandler) => {
      const handlers = screenHandlers.get(event) ?? new Set<EventHandler>();
      handlers.add(handler);
      screenHandlers.set(event, handlers);
    }),
    removeListener: vi.fn((event: string, handler: EventHandler) => {
      screenHandlers.get(event)?.delete(handler);
    }),
    emit(event: string, ...args: unknown[]): void {
      for (const handler of screenHandlers.get(event) ?? []) handler(...args);
    }
  };

  const permissionCheck = vi.fn();
  const permissionRequest = vi.fn();
  const sessionOn = vi.fn();
  const session = {
    defaultSession: {
      setPermissionCheckHandler: permissionCheck,
      setPermissionRequestHandler: permissionRequest,
      on: sessionOn
    }
  };
  const nativeTheme = { themeSource: 'system' };
  const ipcMain = { role: 'ipc-main' };

  class FakeDatabaseSync {
    public static readonly instances: FakeDatabaseSync[] = [];
    public readonly close = vi.fn();
    public constructor(public readonly path: string) {
      FakeDatabaseSync.instances.push(this);
    }
  }

  const runStorageMigrations = vi.fn();
  const settingsState: {
    loadResult: {
      ball: { visible: boolean; edgeSnap: boolean; anchor?: BallAnchor };
      theme: 'system' | 'light' | 'dark';
      selection: { enabled: boolean; ocrActivation: 'fallback' | 'alt-drag' };
    };
    rejectAnchor: boolean;
  } = {
    loadResult: {
      ball: { visible: true, edgeSnap: true },
      theme: 'system',
      selection: { enabled: true, ocrActivation: 'fallback' }
    },
    rejectAnchor: false
  };
  class FakeSettingsRepository {
    public static readonly instances: FakeSettingsRepository[] = [];
    public readonly load = vi.fn(async () => structuredClone(settingsState.loadResult));
    public readonly setBallVisible = vi.fn(async (_value: boolean) => undefined);
    public readonly setEdgeSnap = vi.fn(async (_value: boolean) => undefined);
    public readonly setTheme = vi.fn(async (_value: string) => undefined);
    public readonly setSelectionEnabled = vi.fn(async (_value: boolean) => undefined);
    public readonly setOcrActivation = vi.fn(async (_value: string) => undefined);
    public readonly setBallAnchor = vi.fn(async (_value: BallAnchor) => {
      if (settingsState.rejectAnchor) throw new Error('anchor write failed');
    });
    public constructor(
      public readonly database: FakeDatabaseSync,
      public readonly options: { readonly onInvalidSetting?: (key: string) => void }
    ) {
      FakeSettingsRepository.instances.push(this);
    }
  }

  class FakeExclusionsRepository {
    public static readonly instances: FakeExclusionsRepository[] = [];
    public readonly listEnabledProcessNames = vi.fn(async () => [...exclusionsState.result]);
    public constructor() { FakeExclusionsRepository.instances.push(this); }
  }
  const exclusionsState = { result: [] as string[] };

  function makeBrowserWindow(bounds: { x: number; y: number; width: number; height: number }) {
    return {
      destroyed: false,
      visible: true,
      bounds: { ...bounds },
      isDestroyed(): boolean { return this.destroyed; },
      isVisible(): boolean { return this.visible; },
      getBounds(): typeof bounds { return { ...this.bounds }; },
      close: vi.fn()
    };
  }

  const startupState = {
    windowStart: Promise.resolve(),
    recreateWindowAfterStart: false
  };

  class FakeWindowManager {
    public static readonly instances: FakeWindowManager[] = [];
    public readonly start = vi.fn(async () => {
      await startupState.windowStart;
      if (startupState.recreateWindowAfterStart) {
        this.ball = makeBrowserWindow(this.options.initialBallBounds);
      }
    });
    public readonly openSettings = vi.fn();
    public readonly setBallVisible = vi.fn((visible: boolean) => {
      if (this.ball !== undefined) this.ball.visible = visible;
    });
    public readonly broadcast = vi.fn();
    public readonly setBallBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      if (this.ball !== undefined) this.ball.bounds = { ...bounds };
    });
    public readonly dispose = vi.fn(() => {
      this.ball = undefined;
      this.settings = undefined;
      this.card = undefined;
    });
    public readonly resolveRole = vi.fn(() => 'ball' as const);
    public ball: ReturnType<typeof makeBrowserWindow> | undefined;
    public settings: ReturnType<typeof makeBrowserWindow> | undefined;
    public card: ReturnType<typeof makeBrowserWindow> | undefined;
    public currentCard: unknown;

    public constructor(public readonly options: {
      readonly initialBallBounds: { x: number; y: number; width: number; height: number };
      readonly initialBallVisible: boolean;
      readonly onBallMoved: (bounds: { x: number; y: number; width: number; height: number }) => void;
    }) {
      this.ball = makeBrowserWindow(options.initialBallBounds);
      this.ball.visible = options.initialBallVisible;
      FakeWindowManager.instances.push(this);
    }

    public getBallBounds(): { x: number; y: number; width: number; height: number } | undefined {
      return this.ball === undefined || this.ball.destroyed ? undefined : { ...this.ball.bounds };
    }
    public getBallWindow(): ReturnType<typeof makeBrowserWindow> | undefined { return this.ball; }
    public getSettingsWindow(): ReturnType<typeof makeBrowserWindow> | undefined { return this.settings; }
    public getCardWindow(): ReturnType<typeof makeBrowserWindow> | undefined { return this.card; }
    public getCurrentSelectionCard(): unknown { return this.currentCard; }
    public presentSelectionCard = vi.fn((card: unknown, bounds: { x: number; y: number; width: number; height: number }) => {
      this.currentCard = card;
      this.card = makeBrowserWindow(bounds);
    });
    public dismissSelectionCard = vi.fn(() => {
      this.currentCard = undefined;
      if (this.card !== undefined) this.card.visible = false;
    });
  }

  class FakeTrayController {
    public static readonly instances: FakeTrayController[] = [];
    public readonly start = vi.fn(async (_snapshot: UiShellSnapshot) => undefined);
    public readonly update = vi.fn();
    public readonly openContextMenu = vi.fn();
    public readonly dispose = vi.fn(() => { this.tray = undefined; });
    public tray: { readonly id: number } | undefined = { id: 1 };
    public constructor(public readonly actions: Record<string, unknown>) {
      FakeTrayController.instances.push(this);
    }
    public getTray(): { readonly id: number } | undefined { return this.tray; }
  }

  const ipcDispose = vi.fn();
  const registerUiShellIpc = vi.fn(() => ipcDispose);
  const cardIpcDispose = vi.fn();
  const registerSelectionCardIpc = vi.fn(() => cardIpcDispose);

  const existsSync = vi.fn(() => false);
  const readyHealth: HealthResponse = {
    v: 1,
    kind: 'response',
    id: 'health-1',
    method: 'health',
    timestamp: '2026-07-16T00:00:00.000Z',
    payload: {
      status: 'ready',
      listening: false,
      uptimeMs: 10,
      degradedCapabilities: []
    }
  };
  const nativeState: {
    rejectStart: boolean;
    rejectStop: boolean;
    rejectRequestStart: boolean;
    rejectRequestStop: boolean;
    health: HealthResponse;
  } = {
    rejectStart: false,
    rejectStop: false,
    rejectRequestStart: false,
    rejectRequestStop: false,
    health: readyHealth
  };

  class FakeNativeHostSupervisor {
    public static readonly instances: FakeNativeHostSupervisor[] = [];
    private readonly handlers = new Map<string, EventHandler[]>();
    public readonly request = vi.fn(async (type: string, _payload: object) => {
      if (type === 'health') return nativeState.health;
      if (type === 'start') {
        if (nativeState.rejectRequestStart) throw new Error('start request failed');
        return { v: 1, kind: 'response', id: 'start', method: 'start', timestamp: '2026-07-16T00:00:00.000Z', payload: { ok: true, listening: true } };
      }
      if (nativeState.rejectRequestStop) throw new Error('stop request failed');
      return { v: 1, kind: 'response', id: 'stop', method: 'stop', timestamp: '2026-07-16T00:00:00.000Z', payload: { ok: true, listening: false } };
    });
    public readonly start = vi.fn(async () => {
      if (nativeState.rejectStart) throw new Error('native start failed');
      const client = { request: this.request };
      queueMicrotask(() => {
        this.emit('ready', {});
        this.emit('clientReady', client, {});
      });
      return client;
    });
    public readonly stop = vi.fn(async () => {
      if (nativeState.rejectStop) throw new Error('native stop failed');
    });
    public constructor(public readonly options: Record<string, unknown>) {
      FakeNativeHostSupervisor.instances.push(this);
    }
    public on(event: string, handler: EventHandler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    public emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return {
    appState,
    app,
    primaryDisplay,
    secondaryDisplay,
    screen,
    screenHandlers,
    permissionCheck,
    permissionRequest,
    sessionOn,
    session,
    nativeTheme,
    ipcMain,
    FakeDatabaseSync,
    runStorageMigrations,
    settingsState,
    startupState,
    FakeSettingsRepository,
    FakeExclusionsRepository,
    exclusionsState,
    FakeWindowManager,
    FakeTrayController,
    ipcDispose,
    registerUiShellIpc,
    cardIpcDispose,
    registerSelectionCardIpc,
    existsSync,
    readyHealth,
    nativeState,
    FakeNativeHostSupervisor
  };
});

vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('node:sqlite', () => ({ DatabaseSync: mocks.FakeDatabaseSync }));
vi.mock('electron', () => ({
  app: mocks.app,
  ipcMain: mocks.ipcMain,
  nativeTheme: mocks.nativeTheme,
  screen: mocks.screen,
  session: mocks.session
}));
vi.mock('@desktop-translate/storage', () => ({
  SqlitePhase3SettingsRepository: mocks.FakeSettingsRepository,
  SqliteAppExclusionsRepository: mocks.FakeExclusionsRepository,
  runStorageMigrations: mocks.runStorageMigrations
}));
vi.mock('../native-host/native-host-supervisor.js', () => ({
  NativeHostSupervisor: mocks.FakeNativeHostSupervisor
}));
vi.mock('./window-manager.js', () => ({ WindowManager: mocks.FakeWindowManager }));
vi.mock('./tray-controller.js', () => ({ TrayController: mocks.FakeTrayController }));
vi.mock('./ui-shell-ipc.js', () => ({ registerUiShellIpc: mocks.registerUiShellIpc }));
vi.mock('./selection-card-ipc.js', () => ({
  registerSelectionCardIpc: mocks.registerSelectionCardIpc
}));

import { ShellController } from './shell-controller.js';

const ENVIRONMENT_KEYS = [
  'DESKTOP_TRANSLATE_E2E',
  'DESKTOP_TRANSLATE_E2E_NODE_PATH',
  'DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE',
  'DESKTOP_TRANSLATE_E2E_NATIVE_MODE',
  'SELECTION_HOST_PATH'
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
);

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

function latestSettings(): InstanceType<typeof mocks.FakeSettingsRepository> {
  const settings = mocks.FakeSettingsRepository.instances.at(-1);
  if (settings === undefined) throw new Error('Expected settings repository');
  return settings;
}

function latestWindows(): InstanceType<typeof mocks.FakeWindowManager> {
  const windows = mocks.FakeWindowManager.instances.at(-1);
  if (windows === undefined) throw new Error('Expected window manager');
  return windows;
}

function latestTray(): InstanceType<typeof mocks.FakeTrayController> {
  const tray = mocks.FakeTrayController.instances.at(-1);
  if (tray === undefined) throw new Error('Expected Tray controller');
  return tray;
}

function latestSupervisor(): InstanceType<typeof mocks.FakeNativeHostSupervisor> {
  const supervisor = mocks.FakeNativeHostSupervisor.instances.at(-1);
  if (supervisor === undefined) throw new Error('Expected Native supervisor');
  return supervisor;
}

function selectionResult(overrides: Partial<SelectionResult> = {}): SelectionResult {
  return {
    selectionId: '123e4567-e89b-42d3-a456-426614174000',
    source: 'uia',
    text: 'Phase Three source text',
    ranges: [{ start: 0, end: 23 }],
    confidence: 1,
    physicalRects: [{ x: 700, y: 300, width: 200, height: 30 }],
    releasePoint: { x: 900, y: 330 },
    monitor: {
      id: 'primary',
      handle: '1',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1032 },
      dpiX: 96,
      dpiY: 96,
      scaleFactor: 1
    },
    target: { pid: '100', hwnd: '200', processName: 'notepad.exe' },
    coordinateSpace: 'physical-px',
    timestamp: '2026-07-16T00:00:00.000Z',
    ...overrides
  };
}

describe('ShellController', () => {
  beforeEach(() => {
    for (const key of ENVIRONMENT_KEYS) delete process.env[key];
    mocks.appState.isPackaged = false;
    mocks.settingsState.loadResult = {
      ball: { visible: true, edgeSnap: true },
      theme: 'system',
      selection: { enabled: true, ocrActivation: 'fallback' }
    };
    mocks.settingsState.rejectAnchor = false;
    mocks.startupState.windowStart = Promise.resolve();
    mocks.startupState.recreateWindowAfterStart = false;
    mocks.nativeState.rejectStart = false;
    mocks.nativeState.rejectStop = false;
    mocks.nativeState.rejectRequestStart = false;
    mocks.nativeState.rejectRequestStop = false;
    mocks.nativeState.health = mocks.readyHealth;
    mocks.exclusionsState.result = [];
    mocks.existsSync.mockReset().mockReturnValue(false);
    mocks.app.getPath.mockClear();
    mocks.app.getAppPath.mockClear();
    mocks.app.getVersion.mockClear();
    mocks.screen.getPrimaryDisplay.mockClear();
    mocks.screen.getPrimaryDisplay.mockReturnValue(mocks.primaryDisplay);
    mocks.screen.getAllDisplays.mockClear();
    mocks.screen.getAllDisplays.mockReturnValue([mocks.primaryDisplay, mocks.secondaryDisplay]);
    mocks.screen.screenToDipRect.mockClear();
    mocks.screen.screenToDipRect.mockImplementation((_window: unknown, rect: object) => rect);
    mocks.screen.getDisplayNearestPoint.mockClear();
    mocks.screen.getDisplayNearestPoint.mockReturnValue(mocks.primaryDisplay);
    mocks.screen.on.mockClear();
    mocks.screen.removeListener.mockClear();
    mocks.screenHandlers.clear();
    mocks.permissionCheck.mockClear();
    mocks.permissionRequest.mockClear();
    mocks.sessionOn.mockClear();
    mocks.FakeDatabaseSync.instances.length = 0;
    mocks.FakeSettingsRepository.instances.length = 0;
    mocks.FakeExclusionsRepository.instances.length = 0;
    mocks.FakeWindowManager.instances.length = 0;
    mocks.FakeTrayController.instances.length = 0;
    mocks.FakeNativeHostSupervisor.instances.length = 0;
    mocks.runStorageMigrations.mockClear();
    mocks.registerUiShellIpc.mockClear();
    mocks.ipcDispose.mockClear();
    mocks.nativeTheme.themeSource = 'system';
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('starts the secure shell once and remains available without a Native Host', async () => {
    const requestQuit = vi.fn();
    const controller = new ShellController({ requestQuit });
    await controller.start();
    await controller.start();
    await flushAsyncWork();

    expect(mocks.permissionCheck).toHaveBeenCalledOnce();
    expect(mocks.permissionRequest).toHaveBeenCalledOnce();
    expect(mocks.sessionOn).toHaveBeenCalledWith('will-download', expect.any(Function));
    expect(mocks.FakeDatabaseSync.instances[0]?.path).toBe(
      'C:\\profile\\desktop-translate.sqlite3'
    );
    expect(mocks.runStorageMigrations).toHaveBeenCalledOnce();
    expect(mocks.FakeWindowManager.instances).toHaveLength(1);
    expect(mocks.FakeTrayController.instances).toHaveLength(1);
    expect(latestTray().start).toHaveBeenCalledOnce();
    expect(latestWindows().start).toHaveBeenCalledOnce();
    expect(mocks.screen.on).toHaveBeenCalledTimes(3);
    expect(controller.getDebugState().snapshot.native.status).toBe('unavailable');
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('faulted');
    expect(mocks.FakeNativeHostSupervisor.instances).toHaveLength(0);

    const check = mocks.permissionCheck.mock.calls[0]?.[0] as () => boolean;
    expect(check()).toBe(false);
    const request = mocks.permissionRequest.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: unknown,
      callback: (allowed: boolean) => void
    ) => void;
    const callback = vi.fn();
    request({}, 'camera', callback);
    expect(callback).toHaveBeenCalledWith(false);
    const download = mocks.sessionOn.mock.calls[0]?.[1] as (event: { preventDefault(): void }) => void;
    const preventDefault = vi.fn();
    download({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('loads settings and synchronizes mutations across Window and Tray state', async () => {
    const anchor: BallAnchor = { displayId: '2', edge: 'left', verticalRatio: 0.4 };
    mocks.settingsState.loadResult = {
      ball: { visible: false, edgeSnap: false, anchor },
      theme: 'dark',
      selection: { enabled: true, ocrActivation: 'fallback' }
    };
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    const settings = latestSettings();
    const windows = latestWindows();
    const tray = latestTray();

    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(windows.options.initialBallVisible).toBe(false);
    await controller.setBallVisible(true);
    await controller.setTheme('light');
    await controller.setEdgeSnap(true);
    expect(settings.setBallVisible).toHaveBeenCalledWith(true);
    expect(settings.setTheme).toHaveBeenCalledWith('light');
    expect(settings.setEdgeSnap).toHaveBeenCalledWith(true);
    expect(windows.setBallVisible).toHaveBeenCalled();
    expect(windows.broadcast).toHaveBeenCalled();
    expect(tray.update).toHaveBeenCalled();
    expect(mocks.nativeTheme.themeSource).toBe('light');

    await controller.resetBallPosition();
    expect(settings.setBallAnchor).toHaveBeenLastCalledWith({
      displayId: '1', edge: 'right', verticalRatio: 0.6
    });
    expect(windows.setBallBounds).toHaveBeenCalled();
  });

  it('wires IPC actions to the existing role objects', async () => {
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    const registrationCall = mocks.registerUiShellIpc.mock.calls as unknown as readonly [unknown][];
    const registration = registrationCall[0]?.[0] as {
      readonly ipcMain: unknown;
      readonly resolveRole: (event: unknown) => unknown;
      readonly actions: Record<string, ((...args: unknown[]) => unknown) | undefined>;
    };
    expect(registration.ipcMain).toBe(mocks.ipcMain);
    expect(registration.resolveRole({})).toBe('ball');
    expect(registration.actions.getSnapshot?.()).toMatchObject({ version: 2 });
    registration.actions.openSettings?.();
    registration.actions.openContextMenu?.();
    expect(latestWindows().openSettings).toHaveBeenCalledOnce();
    expect(latestTray().openContextMenu).toHaveBeenCalledWith(latestWindows().ball);
    await registration.actions.setBallVisible?.(false);
    await registration.actions.setEdgeSnap?.(false);
    await registration.actions.setTheme?.('dark');
    await registration.actions.resetBallPosition?.();
    expect(controller.getDebugState().snapshot.theme).toBe('dark');

    const trayActions = latestTray().actions as {
      readonly openSettings: () => void;
      readonly setBallVisible: (value: boolean) => Promise<void>;
      readonly resetBallPosition: () => Promise<void>;
    };
    trayActions.openSettings();
    await trayActions.setBallVisible(true);
    await trayActions.resetBallPosition();
    expect(latestWindows().openSettings).toHaveBeenCalledTimes(2);
  });

  it('guards test-only APIs and validates synthetic movement', async () => {
    const controller = new ShellController({ requestQuit: vi.fn() });
    await expect(controller.setBallVisible(false)).rejects.toThrow(/not initialized/u);
    await controller.start();
    expect(() => controller.closeSettingsForTest()).toThrow(/disabled/u);
    await expect(controller.moveBallForTest(1, 2)).rejects.toThrow(/disabled/u);
    process.env.DESKTOP_TRANSLATE_E2E = '1';
    expect(() => controller.closeSettingsForTest()).not.toThrow();
    const windows = latestWindows();
    windows.settings = {
      destroyed: false,
      visible: true,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      isDestroyed: () => false,
      isVisible: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      close: vi.fn()
    };
    controller.closeSettingsForTest();
    expect(windows.settings.close).toHaveBeenCalledOnce();
    await expect(controller.moveBallForTest(Number.NaN, 1)).rejects.toThrow(/Invalid/u);
    await controller.moveBallForTest(-9000.2, 9000.8);
    expect(windows.setBallBounds).toHaveBeenCalled();
    expect(latestSettings().setBallAnchor).toHaveBeenCalled();
    windows.ball = undefined;
    await expect(controller.moveBallForTest(1, 2)).rejects.toThrow(/unavailable/u);
  });

  it('reports live and destroyed debug state without throwing', async () => {
    const controller = new ShellController({ requestQuit: vi.fn() });
    expect(controller.getDebugState()).toMatchObject({
      trayCreated: false,
      ballCreated: false,
      settingsCreated: false
    });
    await controller.start();
    const windows = latestWindows();
    windows.settings = {
      destroyed: false,
      visible: true,
      bounds: { x: 0, y: 0, width: 720, height: 640 },
      isDestroyed(): boolean { return this.destroyed; },
      isVisible(): boolean { return this.visible; },
      getBounds(): typeof this.bounds { return { ...this.bounds }; },
      close: vi.fn()
    };
    expect(controller.getDebugState()).toMatchObject({
      trayCreated: true,
      ballCreated: true,
      ballVisible: true,
      settingsCreated: true,
      settingsVisible: true,
      ballBounds: expect.objectContaining({ width: 56 })
    });
    windows.ball!.destroyed = true;
    windows.settings.destroyed = true;
    expect(controller.getDebugState()).toMatchObject({
      ballCreated: false,
      ballVisible: false,
      settingsCreated: false,
      settingsVisible: false
    });
  });

  it('recovers the Ball after a display change and contains persistence failures', async () => {
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    mocks.screen.emit('display-added');
    await flushAsyncWork();
    expect(latestWindows().setBallBounds).toHaveBeenCalled();

    latestWindows().setBallBounds.mockClear();
    mocks.screen.emit('display-removed');
    await flushAsyncWork();
    expect(latestWindows().setBallBounds).toHaveBeenCalled();
    expect(latestSettings().setBallAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: '1' })
    );

    mocks.settingsState.rejectAnchor = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const replacementDisplay = {
      id: 3,
      workArea: { x: 0, y: 0, width: 1600, height: 900 }
    };
    mocks.screen.getPrimaryDisplay.mockReturnValue(replacementDisplay);
    mocks.screen.getAllDisplays.mockReturnValue([replacementDisplay]);
    mocks.screen.emit('display-metrics-changed');
    await flushAsyncWork();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/Failed to persist/u));
    latestWindows().options.onBallMoved({ x: 500, y: 500, width: 56, height: 56 });
    await flushAsyncWork();
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/moved ball/u));
    mocks.settingsState.rejectAnchor = false;
    process.env.DESKTOP_TRANSLATE_E2E = '1';
    await expect(controller.moveBallForTest(300, 300)).resolves.toBeUndefined();
    warning.mockRestore();
  });

  it('starts an explicit development Host and maps every health state', async () => {
    process.env.SELECTION_HOST_PATH = ' C:\\native\\selection-host.exe ';
    mocks.existsSync.mockReturnValue(true);
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    const supervisor = latestSupervisor();
    expect(supervisor.options).toMatchObject({
      executablePath: 'C:\\native\\selection-host.exe',
      desktopVersion: '0.3.0-phase3'
    });
    expect(supervisor.request).toHaveBeenCalledWith('health', {});
    expect(controller.getDebugState().snapshot.native.status).toBe('ready');

    supervisor.emit('unhealthy');
    expect(controller.getDebugState().snapshot.native.status).toBe('starting');
    supervisor.emit('ready');
    expect(controller.getDebugState().snapshot.native.status).toBe('ready');
    supervisor.emit('health', {
      ...mocks.readyHealth,
      payload: { status: 'degraded', listening: false, uptimeMs: 20, degradedCapabilities: ['ocr'] }
    });
    expect(controller.getDebugState().snapshot.native).toEqual({
      status: 'degraded', degradedCapabilities: ['ocr']
    });
    supervisor.emit('health', {
      ...mocks.readyHealth,
      payload: { status: 'starting', listening: false, uptimeMs: 20, degradedCapabilities: [] }
    });
    expect(controller.getDebugState().snapshot.native.status).toBe('starting');
    supervisor.emit('health', {
      ...mocks.readyHealth,
      payload: { status: 'faulted', listening: false, uptimeMs: 20, degradedCapabilities: [] }
    });
    expect(controller.getDebugState().snapshot.native.status).toBe('faulted');
    supervisor.emit('fatal');
    expect(controller.getDebugState().snapshot.native.status).toBe('faulted');
    supervisor.emit('health', {
      ...mocks.readyHealth,
      payload: { status: 'ready', listening: true, uptimeMs: 20, degradedCapabilities: [] }
    });
    expect(controller.getDebugState().snapshot.native.status).toBe('ready');
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('listening');
    expect(supervisor.stop).not.toHaveBeenCalled();
  });

  it('faults safely when Native startup fails', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    mocks.nativeState.rejectStart = true;
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    expect(controller.getDebugState().snapshot.native.status).toBe('faulted');
  });

  it('accepts listening health as the expected Phase 3 state', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    const supervisor = latestSupervisor();
    supervisor.emit('health', {
      ...mocks.readyHealth,
      payload: { status: 'ready', listening: true, uptimeMs: 20, degradedCapabilities: [] }
    });
    await flushAsyncWork();

    expect(controller.getDebugState().snapshot.native.status).toBe('ready');
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('listening');
    expect(supervisor.stop).not.toHaveBeenCalled();
  });

  it('persists selection controls and restarts the Host with current exclusions', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    mocks.exclusionsState.result = ['blocked.exe', 'BLOCKED.exe'];
    mocks.nativeState.health = {
      ...mocks.readyHealth,
      payload: { ...mocks.readyHealth.payload, listening: true }
    };
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    const supervisor = latestSupervisor();

    const initialStart = supervisor.request.mock.calls.find(([method]) => method === 'start');
    if (initialStart === undefined) throw new Error('Expected an initial start request');
    const initialConfig = initialStart[1] as { excludedProcessNames: string[] };
    expect(initialConfig).toMatchObject({
      enableUia: true,
      enableOcrFallback: true,
      ocrActivation: 'fallback',
      excludedProcessNames: expect.arrayContaining(['BLOCKED.exe'])
    });
    expect(new Set(initialConfig.excludedProcessNames).size).toBe(2);

    await controller.setSelectionEnabled(false);
    expect(latestSettings().setSelectionEnabled).toHaveBeenCalledWith(false);
    expect(supervisor.request).toHaveBeenCalledWith('stop', { reason: 'selection-disabled' });
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('disabled');
    expect(latestWindows().dismissSelectionCard).toHaveBeenCalled();

    await controller.setSelectionEnabled(true);
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('listening');
    await controller.setOcrActivation('alt-drag');
    expect(latestSettings().setOcrActivation).toHaveBeenCalledWith('alt-drag');
    expect(supervisor.request).toHaveBeenCalledWith('stop', {
      reason: 'selection-config-changed'
    });
    const latestStart = supervisor.request.mock.calls.filter(([method]) => method === 'start').at(-1);
    expect(latestStart?.[1]).toMatchObject({ ocrActivation: 'alt-drag' });
    expect(controller.getDebugState().snapshot.selection.ocrActivation).toBe('alt-drag');
  });

  it('keeps disabled persisted selection stopped when the Host becomes ready', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    mocks.settingsState.loadResult.selection.enabled = false;
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    expect(latestSupervisor().request).not.toHaveBeenCalledWith('start', expect.anything());
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('disabled');

    await controller.setOcrActivation('alt-drag');
    expect(latestSettings().setOcrActivation).toHaveBeenCalledWith('alt-drag');
    expect(latestSupervisor().request).not.toHaveBeenCalledWith('start', expect.anything());
  });

  it('converts Native selection rectangles to DIP and presents a source-only card', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    mocks.screen.screenToDipRect.mockImplementation((_window: unknown, value: object) => {
      const rect = value as { x: number; y: number; width: number; height: number };
      return {
        ...rect,
        x: rect.x / 2,
        y: rect.y / 2,
        width: rect.width / 2,
        height: rect.height / 2
      };
    });
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    const supervisor = latestSupervisor();
    supervisor.emit('selection', selectionResult({ source: 'ocr', confidence: 0.75 }));

    expect(mocks.screen.screenToDipRect).toHaveBeenCalledOnce();
    expect(latestWindows().presentSelectionCard).toHaveBeenCalledWith({
      selectionId: '123e4567-e89b-42d3-a456-426614174000',
      text: 'Phase Three source text',
      source: 'ocr',
      confidence: 0.75
    }, { x: 210, y: 175, width: 380, height: 220 });
    expect(controller.getDebugState()).toMatchObject({ cardCreated: true, cardVisible: true });

    latestWindows().presentSelectionCard.mockClear();
    supervisor.emit('selection', selectionResult({
      selectionId: '123e4567-e89b-42d3-a456-426614174001',
      physicalRects: [],
      releasePoint: { x: 100, y: 200 }
    }));
    expect(latestWindows().presentSelectionCard).toHaveBeenCalledOnce();

    await controller.setSelectionEnabled(false);
    latestWindows().presentSelectionCard.mockClear();
    supervisor.emit('selection', selectionResult());
    expect(latestWindows().presentSelectionCard).not.toHaveBeenCalled();
  });

  it('contains Host errors, disconnects, and display-driven listener restarts', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    const supervisor = latestSupervisor();

    supervisor.emit('hostError', {
      code: 'uia_no_selection', scope: 'uia', recoverable: true,
      message: 'safe', selectionId: '123e4567-e89b-42d3-a456-426614174000'
    });
    expect(controller.getDebugState().snapshot.selection.lifecycle).not.toBe('faulted');
    supervisor.emit('hostError', {
      code: 'pipe_error', scope: 'host', recoverable: false, message: 'safe'
    });
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('faulted');
    expect(latestWindows().dismissSelectionCard).toHaveBeenCalled();

    supervisor.request.mockClear();
    mocks.screen.emit('display-metrics-changed');
    await flushAsyncWork();
    expect(supervisor.request).toHaveBeenCalledWith('stop', {
      reason: 'selection-config-changed'
    });
    expect(supervisor.request).toHaveBeenCalledWith('start', expect.anything(), 3_000);

    supervisor.emit('unhealthy');
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('starting');
    supervisor.emit('restarting');
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('starting');
  });

  it('faults a rejected background start command without an unhandled rejection', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    mocks.nativeState.rejectRequestStart = true;
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    expect(controller.getDebugState().snapshot.selection.lifecycle).toBe('faulted');

    mocks.nativeState.rejectRequestStart = false;
    await controller.setSelectionEnabled(false);
    mocks.nativeState.rejectRequestStart = true;
    await expect(controller.setSelectionEnabled(true)).rejects.toThrow(/start request/u);
  });

  it('builds E2E and packaged Native launch options without accepting arbitrary packaged paths', async () => {
    process.env.DESKTOP_TRANSLATE_E2E = '1';
    process.env.DESKTOP_TRANSLATE_E2E_NODE_PATH = 'C:\\node.exe';
    process.env.DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE = 'C:\\fixture.mjs';
    process.env.DESKTOP_TRANSLATE_E2E_NATIVE_MODE = 'degraded';
    mocks.existsSync.mockReturnValue(true);
    const e2e = new ShellController({ requestQuit: vi.fn() });
    await e2e.start();
    await flushAsyncWork();
    expect(latestSupervisor().options).toMatchObject({
      executablePath: 'C:\\node.exe',
      executableArguments: ['C:\\fixture.mjs', '--fake-mode', 'degraded']
    });
    await e2e.dispose();

    mocks.FakeNativeHostSupervisor.instances.length = 0;
    mocks.appState.isPackaged = true;
    process.env.SELECTION_HOST_PATH = 'C:\\untrusted.exe';
    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: 'C:\\resources' });
    const packaged = new ShellController({ requestQuit: vi.fn() });
    await packaged.start();
    await flushAsyncWork();
    expect(latestSupervisor().options).toMatchObject({
      executablePath: 'C:\\resources\\selection-host\\selection-host.exe'
    });
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath
    });
  });

  it('cancels startup cleanly when disposal finishes before Window startup', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    let releaseWindowStart: (() => void) | undefined;
    mocks.startupState.windowStart = new Promise<void>((resolve) => {
      releaseWindowStart = resolve;
    });
    mocks.startupState.recreateWindowAfterStart = true;
    const controller = new ShellController({ requestQuit: vi.fn() });

    const starting = controller.start();
    await vi.waitFor(() => expect(latestWindows().start).toHaveBeenCalledOnce());
    await controller.dispose();
    releaseWindowStart?.();
    await starting;

    expect(mocks.screen.on).not.toHaveBeenCalled();
    expect(mocks.FakeNativeHostSupervisor.instances).toHaveLength(0);
    expect(latestTray().getTray()).toBeUndefined();
    expect(latestWindows().getBallWindow()).toBeUndefined();
    expect(mocks.ipcDispose).toHaveBeenCalledOnce();
    expect(mocks.FakeDatabaseSync.instances.at(-1)?.close).toHaveBeenCalledOnce();

    await controller.start();
    expect(mocks.FakeWindowManager.instances).toHaveLength(1);
    expect(mocks.FakeTrayController.instances).toHaveLength(1);
  });

  it('cleans all resources once even when Native stop or position persistence rejects', async () => {
    process.env.SELECTION_HOST_PATH = 'C:\\native\\selection-host.exe';
    mocks.existsSync.mockReturnValue(true);
    const controller = new ShellController({ requestQuit: vi.fn() });
    await controller.start();
    await flushAsyncWork();
    mocks.nativeState.rejectStop = true;
    mocks.settingsState.rejectAnchor = true;
    process.env.DESKTOP_TRANSLATE_E2E = '1';
    await expect(controller.moveBallForTest(500, 500)).rejects.toThrow(/anchor write failed/u);
    await controller.dispose();
    await controller.dispose();
    expect(mocks.screen.removeListener).toHaveBeenCalledTimes(3);
    expect(mocks.ipcDispose).toHaveBeenCalledOnce();
    expect(latestSupervisor().stop).toHaveBeenCalled();
    expect(latestTray().dispose).toHaveBeenCalledOnce();
    expect(latestWindows().dispose).toHaveBeenCalledOnce();
    expect(mocks.FakeDatabaseSync.instances.at(-1)?.close).toHaveBeenCalledOnce();
  });

  it('opens existing Settings idempotently from second-instance routing', async () => {
    const controller = new ShellController({ requestQuit: vi.fn() });
    controller.openSettings();
    await controller.start();
    controller.openSettings();
    expect(latestWindows().openSettings).toHaveBeenCalledOnce();
  });
});

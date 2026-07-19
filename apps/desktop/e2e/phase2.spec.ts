import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appPath = resolve(process.cwd());
const fixturePath = resolve(appPath, 'src/main/native-host/test-fixtures/fake-native-host.mjs');
const electronExecutablePath = createRequire(import.meta.url)('electron') as string;
const BALL_SIZE_DIP = 56;
const BALL_MARGIN_DIP = 12;
const PRODUCT_EXIT_TIMEOUT_MS = 30_000;
const HARNESS_RESIDUAL_TIMEOUT_MS = 40_000;
const failedQuitApplications = new WeakSet<ElectronApplication>();
const applicationProcesses = new WeakMap<ElectronApplication, ChildProcess>();
const applicationMainProcessIds = new WeakMap<ElectronApplication, number>();
const applicationExitTracePaths = new WeakMap<ElectronApplication, string>();

interface RectangleLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DebugState {
  readonly snapshot: {
    readonly ball: { readonly visible: boolean; readonly edgeSnap: boolean; readonly anchor?: unknown };
    readonly theme: string;
    readonly native: { readonly status: string; readonly degradedCapabilities: readonly string[] };
    readonly selection: {
      readonly enabled: boolean;
      readonly lifecycle: string;
      readonly ocrActivation: string;
    };
    readonly translation: {
      readonly enabled: boolean;
      readonly providerId: string;
      readonly sourceLanguage: string;
      readonly targetLanguage: string;
      readonly credentialStatus: string;
      readonly consentVersion: number;
    };
  };
  readonly trayCreated: boolean;
  readonly ballCreated: boolean;
  readonly ballVisible: boolean;
  readonly ballBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly settingsCreated: boolean;
  readonly settingsVisible: boolean;
  readonly cardCreated: boolean;
  readonly cardVisible: boolean;
  readonly shutdownPhase: string;
}

type FetchMode = 'block' | 'baidu-success';

function environment(
  userData: string,
  nativeMode?: string,
  fetchMode?: FetchMode
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const env: Record<string, string> = {
    ...inherited,
    DESKTOP_TRANSLATE_E2E: '1',
    DESKTOP_TRANSLATE_USER_DATA_DIR: userData,
    SELECTION_HOST_PATH: ''
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (nativeMode) {
    env.DESKTOP_TRANSLATE_E2E_NODE_PATH = process.execPath;
    env.DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE = fixturePath;
    env.DESKTOP_TRANSLATE_E2E_NATIVE_MODE = nativeMode;
    env.DESKTOP_TRANSLATE_E2E_NATIVE_TRACE = join(userData, 'native-methods.log');
    env.DESKTOP_TRANSLATE_E2E_NATIVE_PROCESS_TRACE = join(userData, 'native-processes.log');
  }
  if (fetchMode) {
    env.DESKTOP_TRANSLATE_E2E_FETCH_MODE = fetchMode;
    env.DESKTOP_TRANSLATE_E2E_FETCH_TRACE = join(userData, 'main-fetches.log');
  }
  return env;
}

async function launch(
  userData: string,
  nativeMode?: string,
  fetchMode?: FetchMode
): Promise<ElectronApplication> {
  const application = await electron.launch({
    args: [appPath],
    env: environment(userData, nativeMode, fetchMode),
    timeout: 30_000
  });
  const childProcess = application.process();
  const mainProcessId = await application.evaluate(() => process.pid);
  applicationProcesses.set(application, childProcess);
  applicationMainProcessIds.set(application, mainProcessId);
  applicationExitTracePaths.set(
    application,
    join(userData, `electron-exit-events-${childProcess.pid ?? 'unknown'}.log`)
  );
  return application;
}

interface ElectronProcessIdentity {
  readonly pid: number;
  readonly type: string;
  readonly executablePath: string;
  readonly creationTime: number;
}

async function readJsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
  try {
    const value = await readFile(path, 'utf8');
    return value.trim() === ''
      ? []
      : value.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function expectEncryptedStorageDoesNotContain(
  userData: string,
  plaintext: string
): Promise<void> {
  const encodedValues = [Buffer.from(plaintext, 'utf8'), Buffer.from(plaintext, 'utf16le')];
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(userData, `desktop-translate.sqlite3${suffix}`);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const encoded of encodedValues) expect(contents.includes(encoded)).toBe(false);
  }
}

function corruptStoredBaiduCredentials(userData: string): void {
  const database = new DatabaseSync(join(userData, 'desktop-translate.sqlite3'));
  try {
    const result = database.prepare(
      'UPDATE secrets SET encrypted_value = ? WHERE key = ?'
    ).run(
      Buffer.from('phase4-corrupted-ciphertext', 'utf8'),
      'translation.provider.baidu.credentials'
    );
    expect(Number(result.changes)).toBe(1);
  } finally {
    database.close();
  }
}

async function quitApplication(application: ElectronApplication, userData: string): Promise<void> {
  const childProcess = applicationProcesses.get(application) ?? application.process();
  const mainProcessId = applicationMainProcessIds.get(application);
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  if (failedQuitApplications.has(application)) {
    childProcess.kill();
    await waitForChildExit(childProcess, 5_000);
    return;
  }
  const exitTracePath = applicationExitTracePaths.get(application)
    ?? join(userData, `electron-exit-events-${childProcess.pid ?? 'unknown'}.log`);
  let electronProcessIdentities: readonly ElectronProcessIdentity[] = [];
  let nativeHostProcessIdentities: readonly ElectronProcessIdentity[] = [];
  try {
    if (mainProcessId === undefined) throw new Error('Electron main-process PID was not captured.');
    nativeHostProcessIdentities = await captureE2ENativeHostProcessIdentities(userData, mainProcessId);
    electronProcessIdentities = await application.evaluate(({ app }, tracePath) => {
      const identities = app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        executablePath: process.execPath,
        creationTime: metric.creationTime
      }));
      const { appendFileSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      const record = (event: string): void => appendFileSync(tracePath, `${event}\n`, 'utf8');
      app.once('before-quit', () => record('before-quit'));
      app.once('will-quit', () => record('will-quit'));
      process.once('exit', (code) => record(`node-exit:${code}`));
      app.once('quit', () => {
        record('quit');
        record('quit-listener-complete');
      });
      globalThis.__desktopTranslateTestApi?.quit();
      return identities;
    }, exitTracePath);
    expect(electronProcessIdentities.some((identity) => identity.pid === mainProcessId)).toBe(true);
    // Playwright's injected Node inspector can keep the Windows Main process
    // and its GPU child alive after a complete product quit. Give every child a
    // bounded natural-exit window, then clean up only the exact captured process
    // identities from the parent harness. The trace proves the synchronous
    // before-quit/will-quit/quit listener contract and Node's final exit event;
    // all async product cleanup has already completed before finishShutdown.
    // It is test-only Playwright/Windows cleanup, not product graceful-exit or
    // PERF09 evidence.
    await waitForProductExitTrace(exitTracePath, PRODUCT_EXIT_TIMEOUT_MS);
    const lingeringNativeHosts = await waitForProcessIdentitiesContinuouslyGone(
      nativeHostProcessIdentities,
      5_000,
      1_000
    );
    if (lingeringNativeHosts.length > 0) {
      throw new Error(
        `Native Host processes remained after product shutdown: ${lingeringNativeHosts.map((identity) => identity.pid).join(',')}.`
      );
    }
    const childIdentities = electronProcessIdentities
      .filter((identity) => identity.pid !== mainProcessId);
    await waitForProcessIdentitiesContinuouslyGone(childIdentities, 5_000, 1_000);
    const mainIdentity = electronProcessIdentities.find(
      (identity) => identity.pid === mainProcessId
    );
    if (mainIdentity === undefined) throw new Error('Captured Electron Main identity is missing.');
    for (const childIdentity of childIdentities) {
      if (isProcessAlive(childIdentity.pid)) await stopExactWindowsProcess(childIdentity);
    }
    if (isProcessAlive(mainProcessId)) await stopExactWindowsProcess(mainIdentity);
    await waitForProcessGone(mainProcessId, 5_000);
    const lingeringChildren = await waitForProcessIdentitiesContinuouslyGone(
      childIdentities,
      5_000,
      1_000
    );
    if (lingeringChildren.length > 0) {
      throw new Error(
        `Electron Chromium child processes remained after exact Main cleanup: ${lingeringChildren.map((identity) => `${identity.pid}:${identity.type}`).join(',')}.`
      );
    }
    await waitForProcessIdsGone(
      [...electronProcessIdentities, ...nativeHostProcessIdentities].map((identity) => identity.pid),
      5_000
    );
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill();
      await waitForChildExit(childProcess, 5_000);
    }
    await waitForUserDataLockRelease(userData, HARNESS_RESIDUAL_TIMEOUT_MS);
  } catch (error) {
    const nativeMethods = await readFile(join(userData, 'native-methods.log'), 'utf8')
      .then((value) => value.trim().split(/\r?\n/u).filter(Boolean).join(','))
      .catch(() => 'unavailable');
    const exitEvents = await readFile(exitTracePath, 'utf8')
      .then((value) => value.trim().split(/\r?\n/u).filter(Boolean).join(','))
      .catch(() => 'unavailable');
    const mainProcessAlive = mainProcessId === undefined ? 'unknown' : isProcessAlive(mainProcessId);
    // Do not spend a second 30-second budget retrying the same failed exit from
    // the test's finally block. Preserve the first diagnostic and clean up the
    // exact Playwright child process directly.
    failedQuitApplications.add(application);
    let forcedCleanupError: unknown;
    try {
      const mainIdentity = electronProcessIdentities.find(
        (identity) => identity.pid === mainProcessId
      );
      const childIdentities = electronProcessIdentities.filter(
        (identity) => identity.pid !== mainProcessId
      );
      for (const nativeHostIdentity of nativeHostProcessIdentities) {
        if (isProcessAlive(nativeHostIdentity.pid)) await stopExactWindowsProcess(nativeHostIdentity);
      }
      for (const childIdentity of childIdentities) {
        if (isProcessAlive(childIdentity.pid)) await stopExactWindowsProcess(childIdentity);
      }
      if (mainIdentity !== undefined && isProcessAlive(mainIdentity.pid)) {
        await stopExactWindowsProcess(mainIdentity);
      }
      await waitForProcessIdsGone(
        [...electronProcessIdentities, ...nativeHostProcessIdentities].map((identity) => identity.pid),
        5_000
      );
    } catch (cleanupError) {
      forcedCleanupError = cleanupError;
    }
    childProcess.kill();
    try {
      await waitForChildExit(childProcess, 5_000);
    } catch (cleanupError) {
      forcedCleanupError = forcedCleanupError === undefined
        ? cleanupError
        : new AggregateError([forcedCleanupError, cleanupError], 'Harness cleanup failed.');
    }
    throw new Error(
      `Electron did not close cleanly within the 30-second exit budget (wrapperPid=${childProcess.pid ?? 'unknown'}, mainPid=${mainProcessId ?? 'unknown'}, mainAlive=${mainProcessAlive}, wrapperExitCode=${childProcess.exitCode ?? 'running'}, exitEvents=${exitEvents}, nativeMethods=${nativeMethods}, forcedCleanup=${forcedCleanupError === undefined ? 'complete' : 'failed'}).`,
      {
        cause: forcedCleanupError === undefined
          ? error
          : new AggregateError([error, forcedCleanupError], 'Product exit and forced cleanup both failed.')
      }
    );
  }
}

async function waitForProductExitTrace(path: string, timeoutMs: number): Promise<void> {
  const expected = 'before-quit\nwill-quit\nnode-exit:0\nquit\nquit-listener-complete\n';
  const deadline = Date.now() + timeoutMs;
  let observed = '';
  while (observed !== expected) {
    try {
      observed = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (observed === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Electron product lifecycle did not complete within ${timeoutMs}ms (exitEvents=${observed.trim().replace(/\r?\n/gu, ',') || 'unavailable'}).`
      );
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function captureE2ENativeHostProcessIdentities(
  userData: string,
  mainProcessId: number
): Promise<readonly ElectronProcessIdentity[]> {
  const tracePath = join(userData, 'native-processes.log');
  let processIds: readonly number[];
  try {
    processIds = [...new Set(
      (await readFile(tracePath, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    )];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (processIds.length === 0) return [];
  if (process.platform !== 'win32') {
    throw new Error('Strict Native Host identity capture is only supported on Windows.');
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$expectedParent = [uint32]$env:DESKTOP_TRANSLATE_E2E_NATIVE_PARENT_PID',
    '$expectedPath = [IO.Path]::GetFullPath($env:DESKTOP_TRANSLATE_E2E_NATIVE_PATH)',
    "$ids = $env:DESKTOP_TRANSLATE_E2E_NATIVE_PIDS.Split(',', [StringSplitOptions]::RemoveEmptyEntries)",
    'foreach ($idText in $ids) {',
    '  $targetId = [uint32]$idText',
    '  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue',
    '  if ($null -eq $cim) { continue }',
    "  if ([uint32]$cim.ParentProcessId -ne $expectedParent) { throw 'Native Host parent PID mismatch.' }",
    '  $target = Get-Process -Id $targetId -ErrorAction Stop',
    '  $actualPath = [IO.Path]::GetFullPath($target.Path)',
    "  if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native Host executable path mismatch.' }",
    '  $creation = [DateTimeOffset]::new($target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
    "  [pscustomobject]@{ pid = [int]$targetId; type = 'native-host'; executablePath = $actualPath; creationTime = [long]$creation } | ConvertTo-Json -Compress",
    '}'
  ].join('; ');

  return await new Promise<readonly ElectronProcessIdentity[]>((resolveCapture, rejectCapture) => {
    const capture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: {
        ...process.env,
        DESKTOP_TRANSLATE_E2E_NATIVE_PARENT_PID: String(mainProcessId),
        DESKTOP_TRANSLATE_E2E_NATIVE_PATH: process.execPath,
        DESKTOP_TRANSLATE_E2E_NATIVE_PIDS: processIds.join(',')
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    capture.stdout?.setEncoding('utf8');
    capture.stdout?.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`;
    });
    capture.stderr?.setEncoding('utf8');
    capture.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });
    capture.once('error', rejectCapture);
    capture.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        rejectCapture(new Error(
          `Native Host identity capture failed (code=${code ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr.trim() || 'unavailable'}).`
        ));
        return;
      }
      try {
        resolveCapture(stdout.trim() === ''
          ? []
          : stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as ElectronProcessIdentity));
      } catch (error) {
        rejectCapture(new Error('Native Host identity capture returned invalid JSON.', { cause: error }));
      }
    });
  });
}

async function waitForProcessIdentitiesContinuouslyGone(
  identities: readonly ElectronProcessIdentity[],
  timeoutMs: number,
  stableMs: number
): Promise<readonly ElectronProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let zeroSince: number | undefined;
  while (true) {
    const alive = identities.filter((identity) => isProcessAlive(identity.pid));
    if (alive.length === 0) {
      zeroSince ??= Date.now();
      if (Date.now() - zeroSince >= stableMs) return [];
    } else {
      zeroSince = undefined;
    }
    if (Date.now() >= deadline) return alive;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function stopExactWindowsProcess(identity: ElectronProcessIdentity): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The strict Electron test-tail cleanup is only supported on Windows.');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$targetId = [int]$env:DESKTOP_TRANSLATE_E2E_TARGET_PID',
    '$expectedCreation = [long]$env:DESKTOP_TRANSLATE_E2E_TARGET_CREATION',
    '$expectedPath = [IO.Path]::GetFullPath($env:DESKTOP_TRANSLATE_E2E_TARGET_PATH)',
    '$target = Get-Process -Id $targetId -ErrorAction SilentlyContinue',
    'if ($null -eq $target) { exit 0 }',
    '$actualCreation = [DateTimeOffset]::new($target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
    '$actualPath = [IO.Path]::GetFullPath($target.Path)',
    "if ([Math]::Abs([double]($actualCreation - $expectedCreation)) -gt 5) { throw 'Creation time mismatch.' }",
    "if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Executable path mismatch.' }",
    'Stop-Process -InputObject $target -Force -ErrorAction Stop'
  ].join('; ');
  await new Promise<void>((resolveStop, rejectStop) => {
    const cleanup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: {
        ...process.env,
        DESKTOP_TRANSLATE_E2E_TARGET_PID: String(identity.pid),
        DESKTOP_TRANSLATE_E2E_TARGET_CREATION: String(identity.creationTime),
        DESKTOP_TRANSLATE_E2E_TARGET_PATH: identity.executablePath
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    cleanup.stderr?.setEncoding('utf8');
    cleanup.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });
    cleanup.once('error', rejectStop);
    cleanup.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolveStop();
      else rejectStop(new Error(
        `Exact process cleanup failed (pid=${identity.pid}, type=${identity.type}, code=${code ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr.trim() || 'unavailable'}).`
      ));
    });
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessIdsGone(processIds: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIds.some((processId) => isProcessAlive(processId))) {
    if (Date.now() >= deadline) {
      const alive = processIds.filter((processId) => isProcessAlive(processId));
      throw new Error(`Electron harness processes remained alive: ${alive.join(',')}.`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function waitForChildExit(childProcess: ChildProcess, timeoutMs: number): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveExit) => childProcess.once('exit', () => resolveExit())),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for killed Electron.')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForSecondaryInstanceExit(childProcess: ChildProcess): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolveExit) => childProcess.once('exit', (code, signal) => resolveExit({ code, signal }))
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Second Electron instance did not exit within 30000ms.')),
          30_000
        );
      })
    ]);
    expect(result).toEqual({ code: 0, signal: null });
  } catch (error) {
    childProcess.kill();
    await waitForChildExit(childProcess, 5_000);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForProcessGone(processId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Electron main process ${processId} remained alive for ${timeoutMs}ms.`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function waitForUserDataLockRelease(userData: string, timeoutMs: number): Promise<void> {
  const lockPath = join(userData, 'lockfile');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await rm(lockPath, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Electron user-data lock remained held for ${timeoutMs}ms.`, { cause: error });
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

async function removeUserData(userData: string): Promise<void> {
  await rm(userData, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

async function debugState(application: ElectronApplication): Promise<DebugState | undefined> {
  return application.evaluate(() => globalThis.__desktopTranslateTestApi?.getState());
}

async function primaryWorkArea(application: ElectronApplication): Promise<RectangleLike> {
  return application.evaluate(({ screen }) => {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    return { x, y, width, height };
  });
}

function bottomLeftBallBounds(workArea: RectangleLike): RectangleLike {
  return {
    x: workArea.x + BALL_MARGIN_DIP,
    y: workArea.y + workArea.height - BALL_MARGIN_DIP - BALL_SIZE_DIP,
    width: BALL_SIZE_DIP,
    height: BALL_SIZE_DIP
  };
}

async function waitForShell(application: ElectronApplication): Promise<DebugState> {
  await expect.poll(() => debugState(application)).toMatchObject({
    trayCreated: true,
    ballCreated: true
  });
  return (await debugState(application))!;
}

async function findWindow(application: ElectronApplication, title: string): Promise<Page> {
  let match: Page | undefined;
  await expect.poll(async () => {
    for (const page of application.windows()) {
      if ((await page.title()) === title) {
        match = page;
        return true;
      }
    }
    return false;
  }).toBe(true);
  return match!;
}

async function expectBallRendered(ball: Page): Promise<void> {
  const appearance = await ball.getByRole('button').evaluate((button) => {
    const style = getComputedStyle(button);
    const icon = getComputedStyle(button.querySelector('.ball-icon')!);
    return {
      width: style.width,
      height: style.height,
      opacity: style.opacity,
      backgroundColor: style.backgroundColor,
      color: style.color,
      maskImage: icon.maskImage || icon.getPropertyValue('-webkit-mask-image')
    };
  });
  expect(appearance).toMatchObject({ width: '44px', height: '44px', opacity: '1' });
  expect(appearance.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(appearance.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(appearance.maskImage).not.toBe('none');
}

test('Phase 2 shell stays usable without Native Host and persists UI settings @smoke', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-phase2-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData);
    await expect.poll(() => debugState(application!)).toMatchObject({
      trayCreated: true,
      ballCreated: true,
      ballVisible: true,
      snapshot: { native: { status: 'unavailable' } }
    });
    const workArea = await primaryWorkArea(application);
    const expectedBottomLeftBounds = bottomLeftBallBounds(workArea);
    const ball = await findWindow(application, '桌面翻译悬浮球');
    await expect(ball.getByRole('button', { name: /打开桌面翻译设置/u })).toBeVisible();
    await expectBallRendered(ball);
    expect(await ball.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await ball.evaluate(() => typeof window.process)).toBe('undefined');
    expect(await ball.evaluate(() => {
      const exposed = window as typeof window & {
        readonly desktopTranslateBall?: object;
        readonly electron?: unknown;
        readonly ipcRenderer?: unknown;
      };
      return {
        electron: typeof exposed.electron,
        ipcRenderer: typeof exposed.ipcRenderer,
        bridgeKeys: Object.keys(exposed.desktopTranslateBall ?? {}).sort()
      };
    })).toEqual({
      electron: 'undefined',
      ipcRenderer: 'undefined',
      bridgeKeys: ['getSnapshot', 'onSnapshotChanged', 'openContextMenu', 'openSettings']
    });

    const blockedOrigin = 'https://phase2-network.invalid';
    const externalRequests: string[] = [];
    ball.on('request', (request) => {
      if (request.url().startsWith(blockedOrigin)) externalRequests.push(request.url());
    });
    expect(await ball.evaluate(async (origin) => {
      try {
        await fetch(`${origin}/blocked`, { mode: 'no-cors' });
        return false;
      } catch {
        return true;
      }
    }, blockedOrigin)).toBe(true);
    expect(externalRequests).toEqual([]);
    expect(await ball.evaluate((origin) => window.open(`${origin}/popup`) === null, blockedOrigin))
      .toBe(true);
    expect(await ball.evaluate(() => Notification.requestPermission())).toBe('denied');

    await ball.getByRole('button').click();
    const settings = await findWindow(application, '桌面翻译设置');
    await expect(settings.getByText('原生服务：未连接')).toBeVisible();
    await settings.getByRole('checkbox', { name: /显示悬浮球/u }).click();
    await expect.poll(() => debugState(application!)).toMatchObject({ ballVisible: false });
    await settings.getByRole('checkbox', { name: /显示悬浮球/u }).click();
    await settings.getByRole('radio', { name: '深色' }).click();
    await expect.poll(() => debugState(application!)).toMatchObject({
      ballVisible: true,
      snapshot: { theme: 'dark' }
    });
    await expectBallRendered(ball);

    await application.evaluate(async (_electron, bounds) => {
      await globalThis.__desktopTranslateTestApi?.moveBall(bounds.x, bounds.y + bounds.height);
    }, workArea);
    await expect.poll(() => debugState(application!)).toMatchObject({
      ballBounds: expectedBottomLeftBounds
    });
    application.evaluate(() => globalThis.__desktopTranslateTestApi?.closeSettings());
    await expect.poll(() => debugState(application!)).toMatchObject({ settingsVisible: false });

    const second = spawn(electronExecutablePath, [appPath], {
      env: environment(userData),
      stdio: 'ignore',
      windowsHide: true
    });
    await waitForSecondaryInstanceExit(second);
    await expect.poll(
      () => debugState(application!),
      { timeout: 10_000 }
    ).toMatchObject({ settingsVisible: true });

    const downloadObserved = ball.waitForEvent('download', { timeout: 500 })
      .then(() => true, () => false);
    await ball.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'data:text/plain,phase2-download-must-be-blocked';
      link.download = 'blocked.txt';
      document.body.append(link);
      link.click();
      link.remove();
    });
    expect(await downloadObserved).toBe(false);
    const originalUrl = ball.url();
    await ball.evaluate((origin) => window.location.assign(`${origin}/navigation`), blockedOrigin);
    await expect.poll(() => ball.url()).toBe(originalUrl);

    await quitApplication(application, userData);
    application = undefined;

    application = await launch(userData);
    await waitForShell(application);
    const restartedBottomLeftBounds = bottomLeftBallBounds(await primaryWorkArea(application));
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: { theme: 'dark' },
      ballVisible: true,
      ballBounds: restartedBottomLeftBounds
    });
    await expectBallRendered(await findWindow(application, '桌面翻译悬浮球'));
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

test('Native fixture reports degraded OCR while UIA selection remains listening @smoke', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-native-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData, 'degraded');
    const runningApplication = application;
    await waitForShell(runningApplication);
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: {
        native: { status: 'degraded', degradedCapabilities: ['ocr'] },
        selection: { enabled: true, lifecycle: 'degraded' }
      }
    });
    await runningApplication.evaluate(() => globalThis.__desktopTranslateTestApi?.openSettings());
    const settings = await findWindow(runningApplication, '桌面翻译设置');
    await expect(settings.getByText('原生服务：部分可用')).toBeVisible();
    await expect(settings.getByText('OCR 未配置')).toBeVisible();
    await quitApplication(runningApplication, userData);
    application = undefined;

    const nativeMethods = (await readFile(join(userData, 'native-methods.log'), 'utf8'))
      .trim()
      .split(/\r?\n/u);
    expect(nativeMethods[0]).toBe('hello');
    expect(nativeMethods.at(-1)).toBe('shutdown');
    expect(nativeMethods).toContain('start');
    expect(nativeMethods.every((method) => ['hello', 'start', 'health', 'shutdown'].includes(method)))
      .toBe(true);
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

test('Native selection event opens a sandboxed source-only card @smoke', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-selection-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData, 'selection', 'block');
    const runningApplication = application;
    await waitForShell(runningApplication);
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { selection: { enabled: true, lifecycle: 'listening' } },
      cardCreated: true,
      cardVisible: true
    });

    const card = await findWindow(runningApplication, '桌面翻译识别结果');
    await expect(card.getByRole('heading', { name: '识别结果' })).toBeVisible();
    await expect(card.getByText('Phase 4 selection preview')).toBeVisible();
    await expect(card.getByText('应用文字')).toBeVisible();
    await expect(card.getByText('在线翻译未启用 · 原文预览')).toBeVisible();
    expect(await card.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await card.evaluate(() => typeof window.process)).toBe('undefined');
    expect(await card.evaluate(() => {
      const exposed = window as typeof window & {
        readonly desktopTranslateCard?: object;
        readonly electron?: unknown;
        readonly ipcRenderer?: unknown;
      };
      return {
        electron: typeof exposed.electron,
        ipcRenderer: typeof exposed.ipcRenderer,
        bridgeKeys: Object.keys(exposed.desktopTranslateCard ?? {}).sort()
      };
    })).toEqual({
      electron: 'undefined',
      ipcRenderer: 'undefined',
      bridgeKeys: [
        'acknowledgePaint',
        'dismiss',
        'getCurrent',
        'onChanged',
        'onPaintProbe',
        'retry'
      ]
    });

    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await card.getByRole('button', { name: '关闭识别结果' }).click();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({ cardVisible: false });
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

test('Phase 4 translation is fail-closed until credentials and consent are saved', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-phase4-settings-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData, undefined, 'block');
    const runningApplication = application;
    await waitForShell(runningApplication);
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          providerId: 'baidu',
          targetLanguage: 'zh-CN',
          credentialStatus: 'missing',
          consentVersion: 0
        }
      }
    });

    await runningApplication.evaluate(() => globalThis.__desktopTranslateTestApi?.openSettings());
    const settings = await findWindow(runningApplication, '桌面翻译设置');
    const translationToggle = settings.getByRole('checkbox', { name: /启用百度在线翻译/u });
    await expect(translationToggle).toBeDisabled();
    await expect(settings.locator('.provider-status')).toContainText('未配置凭据');

    await settings.getByLabel('APP ID', { exact: true }).fill('phase4-e2e-app');
    await settings.getByLabel('密钥', { exact: true }).fill('phase4-e2e-secret');
    await settings.getByRole('checkbox', { name: /我已了解/u }).check();
    await settings.getByRole('button', { name: '保存凭据' }).click();

    await expect(settings.locator('.provider-status')).toContainText('凭据已配置');
    await expect(settings.locator('.provider-status')).toContainText('凭据已安全保存');
    await expect(settings.getByLabel('APP ID', { exact: true })).toHaveValue('');
    await expect(settings.getByLabel('密钥', { exact: true })).toHaveValue('');
    expect(await settings.locator('body').innerText()).not.toContain('phase4-e2e-app');
    expect(await settings.locator('body').innerText()).not.toContain('phase4-e2e-secret');
    await expectEncryptedStorageDoesNotContain(userData, 'phase4-e2e-app');
    await expectEncryptedStorageDoesNotContain(userData, 'phase4-e2e-secret');
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          credentialStatus: 'configured',
          consentVersion: 1
        }
      }
    });

    await expect(translationToggle).toBeEnabled();
    await translationToggle.check();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { translation: { enabled: true } }
    });
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await settings.getByRole('button', { name: '删除凭据' }).click();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          credentialStatus: 'missing',
          consentVersion: 0
        }
      }
    });
    await expect(translationToggle).toBeDisabled();
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

test('Phase 4 settings survive a full restart and credential deletion stays fail-closed', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-phase4-restart-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData, undefined, 'block');
    await waitForShell(application);
    await application.evaluate(() => globalThis.__desktopTranslateTestApi?.openSettings());
    const initialSettings = await findWindow(application, '桌面翻译设置');

    await initialSettings.locator('#translation-source-language').selectOption('en');
    await initialSettings.locator('#translation-target-language').selectOption('ja');
    await initialSettings.getByLabel('APP ID', { exact: true }).fill('phase4-restart-app');
    await initialSettings.getByLabel('密钥', { exact: true }).fill('phase4-restart-secret');
    await initialSettings.getByRole('checkbox', { name: /我已了解/u }).check();
    await initialSettings.getByRole('button', { name: '保存凭据' }).click();
    const initialTranslationToggle = initialSettings.getByRole('checkbox', {
      name: /启用百度在线翻译/u
    });
    await expect(initialTranslationToggle).toBeEnabled();
    await initialTranslationToggle.check();
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: {
        translation: {
          enabled: true,
          providerId: 'baidu',
          sourceLanguage: 'en',
          targetLanguage: 'ja',
          credentialStatus: 'configured',
          consentVersion: 1
        }
      }
    });
    await expectEncryptedStorageDoesNotContain(userData, 'phase4-restart-app');
    await expectEncryptedStorageDoesNotContain(userData, 'phase4-restart-secret');
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await quitApplication(application, userData);
    application = await launch(userData, undefined, 'block');
    await waitForShell(application);
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: {
        translation: {
          enabled: true,
          providerId: 'baidu',
          sourceLanguage: 'en',
          targetLanguage: 'ja',
          credentialStatus: 'configured',
          consentVersion: 1
        }
      }
    });
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await quitApplication(application, userData);
    corruptStoredBaiduCredentials(userData);
    application = await launch(userData, undefined, 'block');
    await waitForShell(application);
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          providerId: 'baidu',
          sourceLanguage: 'en',
          targetLanguage: 'ja',
          credentialStatus: 'unavailable',
          consentVersion: 1
        }
      }
    });
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await application.evaluate(() => globalThis.__desktopTranslateTestApi?.openSettings());
    const restartedSettings = await findWindow(application, '桌面翻译设置');
    await expect(restartedSettings.locator('#translation-source-language')).toHaveValue('en');
    await expect(restartedSettings.locator('#translation-target-language')).toHaveValue('ja');
    const restartedTranslationToggle = restartedSettings.getByRole('checkbox', {
      name: /启用百度在线翻译/u
    });
    await expect(restartedTranslationToggle).not.toBeChecked();
    await expect(restartedTranslationToggle).toBeDisabled();
    await expect(restartedSettings.locator('.provider-status')).toContainText('不可用');
    const recoveryDeleteButton = restartedSettings.getByRole('button', { name: '删除凭据' });
    await expect(recoveryDeleteButton).toBeEnabled();
    await recoveryDeleteButton.click();
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          sourceLanguage: 'en',
          targetLanguage: 'ja',
          credentialStatus: 'missing',
          consentVersion: 0
        }
      }
    });
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await quitApplication(application, userData);
    application = await launch(userData, undefined, 'block');
    await waitForShell(application);
    await expect.poll(() => debugState(application!)).toMatchObject({
      snapshot: {
        translation: {
          enabled: false,
          providerId: 'baidu',
          sourceLanguage: 'en',
          targetLanguage: 'ja',
          credentialStatus: 'missing',
          consentVersion: 0
        }
      }
    });
    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

test('Phase 4 runs the translated card chain through the allowlisted Main transport', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desktop-translate-phase4-translation-'));
  let application: ElectronApplication | undefined;
  try {
    application = await launch(userData, 'selection-on-restart', 'baidu-success');
    const runningApplication = application;
    await waitForShell(runningApplication);
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { selection: { enabled: true, lifecycle: 'listening' } },
      cardVisible: false
    });

    await runningApplication.evaluate(() => globalThis.__desktopTranslateTestApi?.openSettings());
    const settings = await findWindow(runningApplication, '桌面翻译设置');
    await settings.getByLabel('APP ID', { exact: true }).fill('phase4-e2e-app');
    await settings.getByLabel('密钥', { exact: true }).fill('phase4-e2e-secret');
    await settings.getByRole('checkbox', { name: /我已了解/u }).check();
    await settings.getByRole('button', { name: '保存凭据' }).click();
    await expect(settings.locator('.provider-status')).toContainText('凭据已配置');

    await settings.getByRole('button', { name: '测试连接' }).click();
    await expect(settings.locator('.provider-status')).toContainText('连接测试成功');
    const translationToggle = settings.getByRole('checkbox', { name: /启用百度在线翻译/u });
    await translationToggle.check();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { translation: { enabled: true } }
    });

    const selectionToggle = settings.getByRole('checkbox', { name: /启用划词取词/u });
    await selectionToggle.uncheck();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { selection: { enabled: false, lifecycle: 'disabled' } }
    });
    await selectionToggle.check();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({
      snapshot: { selection: { enabled: true, lifecycle: 'listening' } },
      cardCreated: true,
      cardVisible: true
    });

    const card = await findWindow(runningApplication, '桌面翻译识别结果');
    await expect(card.getByRole('heading', { name: '翻译结果' })).toBeVisible();
    await expect(card.getByText('Phase 4 selection preview')).toBeVisible();
    await expect(card.getByText('E2E translated (25)')).toBeVisible();
    await expect(card.getByText('百度翻译')).toBeVisible();

    const expectedTrace = [
      expect.objectContaining({
        kind: 'baidu-request',
        method: 'POST',
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        queryBytes: 5,
        appIdPresent: true,
        signatureShapeValid: true
      }),
      expect.objectContaining({
        kind: 'baidu-request',
        method: 'POST',
        sourceLanguage: 'auto',
        targetLanguage: 'zh',
        queryBytes: 25,
        appIdPresent: true,
        signatureShapeValid: true
      })
    ];
    await expect.poll(() => readJsonLines(join(userData, 'main-fetches.log'))).toEqual(expectedTrace);
    const traceText = JSON.stringify(await readJsonLines(join(userData, 'main-fetches.log')));
    expect(traceText).not.toContain('phase4-e2e-app');
    expect(traceText).not.toContain('phase4-e2e-secret');
    expect(traceText).not.toContain('hello');
    expect(traceText).not.toContain('Phase 4 selection preview');
  } finally {
    try {
      if (application !== undefined) await quitApplication(application, userData);
    } finally {
      await removeUserData(userData);
    }
  }
});

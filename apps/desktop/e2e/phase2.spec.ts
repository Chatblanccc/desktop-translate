import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appPath = resolve(process.cwd());
const fixturePath = resolve(appPath, 'src/main/native-host/test-fixtures/fake-native-host.mjs');
const electronExecutablePath = createRequire(import.meta.url)('electron') as string;
const BALL_SIZE_DIP = 56;
const BALL_MARGIN_DIP = 12;

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
  return electron.launch({ args: [appPath], env: environment(userData, nativeMode, fetchMode) });
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

async function quitApplication(application: ElectronApplication): Promise<void> {
  if (application.process().exitCode !== null) return;
  const closed = application.waitForEvent('close', { timeout: 10_000 });
  await application.evaluate(() => globalThis.__desktopTranslateTestApi?.quit());
  await closed;
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
    await new Promise<void>((resolveExit) => second.once('exit', () => resolveExit()));
    await expect.poll(() => debugState(application!)).toMatchObject({ settingsVisible: true });

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

    await quitApplication(application);
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
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
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
    await quitApplication(runningApplication);
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
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
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
      bridgeKeys: ['dismiss', 'getCurrent', 'onChanged', 'retry']
    });

    expect(await readJsonLines(join(userData, 'main-fetches.log'))).toEqual([]);

    await card.getByRole('button', { name: '关闭识别结果' }).click();
    await expect.poll(() => debugState(runningApplication)).toMatchObject({ cardVisible: false });
  } finally {
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
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
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
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

    await quitApplication(application);
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

    await quitApplication(application);
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

    await quitApplication(application);
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
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
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
    if (application !== undefined) {
      await quitApplication(application).catch(() => application?.process().kill());
    }
    await removeUserData(userData);
  }
});

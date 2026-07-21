import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_DATA_RESET_NONCE_PREFIX,
  LOCAL_DATA_RESET_PARENT_PID_PREFIX,
  LOCAL_DATA_RESET_TARGET_PREFIX,
  assertSafeUserDataDirectory,
  isLocalDataResetPending,
  localDataResetMarkerPath,
  parseLocalDataResetHelperArguments,
  runLocalDataResetHelper,
  scheduleLocalDataResetAfterExit,
  type ResetChildProcess,
  type ScheduleLocalDataResetOptions
} from './local-data-reset.js';

const temporaryDirectories: string[] = [];
const NONCE = 'a'.repeat(64);

async function makeUserDataDirectory(label = 'reset'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `desktop-translate-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function makeSpawnedChild(): {
  readonly child: ResetChildProcess;
  readonly unref: ReturnType<typeof vi.fn>;
} {
  const unref = vi.fn();
  const child: ResetChildProcess = {
    once(event, listener) {
      if (event === 'spawn') queueMicrotask(() => (listener as () => void)());
      return this;
    },
    unref
  };
  return { child, unref };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('local-data reset', () => {
  it('accepts one strict target/PID/nonce binding and rejects malformed arguments', async () => {
    const target = await makeUserDataDirectory();
    expect(parseLocalDataResetHelperArguments([
      `${LOCAL_DATA_RESET_TARGET_PREFIX}${target}`,
      `${LOCAL_DATA_RESET_PARENT_PID_PREFIX}42`,
      `${LOCAL_DATA_RESET_NONCE_PREFIX}${NONCE}`
    ])).toEqual({ userDataDirectory: target, parentProcessId: 42, nonce: NONCE });
    expect(() => parseLocalDataResetHelperArguments([
      `${LOCAL_DATA_RESET_TARGET_PREFIX}${target}`,
      `${LOCAL_DATA_RESET_PARENT_PID_PREFIX}0`,
      `${LOCAL_DATA_RESET_NONCE_PREFIX}${NONCE}`
    ])).toThrow(/identifier/u);
    expect(() => parseLocalDataResetHelperArguments([
      `${LOCAL_DATA_RESET_TARGET_PREFIX}${target}`,
      `${LOCAL_DATA_RESET_TARGET_PREFIX}${target}`,
      `${LOCAL_DATA_RESET_PARENT_PID_PREFIX}42`,
      `${LOCAL_DATA_RESET_NONCE_PREFIX}${NONCE}`
    ])).toThrow(/target arguments/u);
  });

  it('binds a marker before launching a fixed plain-Node helper without a shell', async () => {
    const userDataDirectory = await makeUserDataDirectory();
    const helperScriptPath = join(process.cwd(), '.vite', 'build', 'local-data-reset-helper.js');
    const { child, unref } = makeSpawnedChild();
    const spawnProcess = vi.fn<NonNullable<ScheduleLocalDataResetOptions['spawnProcess']>>(
      () => child
    );

    await scheduleLocalDataResetAfterExit({
      userDataDirectory,
      parentProcessId: 123,
      executablePath: 'C:\\DesktopTranslate.exe',
      helperScriptPath,
      spawnProcess,
      createNonce: () => NONCE
    });

    expect(await isLocalDataResetPending(userDataDirectory)).toBe(true);
    expect(JSON.parse(await readFile(localDataResetMarkerPath(userDataDirectory), 'utf8')))
      .toEqual({
        version: 1,
        target: userDataDirectory,
        parentProcessId: 123,
        nonce: NONCE
      });
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\DesktopTranslate.exe',
      [
        helperScriptPath,
        `${LOCAL_DATA_RESET_TARGET_PREFIX}${userDataDirectory}`,
        `${LOCAL_DATA_RESET_PARENT_PID_PREFIX}123`,
        `${LOCAL_DATA_RESET_NONCE_PREFIX}${NONCE}`
      ],
      expect.objectContaining({
        cwd: dirname(userDataDirectory),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' })
      })
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it('deletes only the bound non-ASCII userData directory after the parent exits', async () => {
    const userDataDirectory = await makeUserDataDirectory('用户数据');
    const sibling = await makeUserDataDirectory('sibling');
    const helperScriptPath = join(process.cwd(), 'local-data-reset-helper.js');
    const { child } = makeSpawnedChild();
    await scheduleLocalDataResetAfterExit({
      userDataDirectory,
      parentProcessId: 456,
      executablePath: process.execPath,
      helperScriptPath,
      spawnProcess: () => child,
      createNonce: () => NONCE
    });
    await writeFile(join(userDataDirectory, 'desktop-translate.sqlite3'), 'database');
    await mkdir(join(userDataDirectory, 'phase5-evidence', 'perf'), { recursive: true });
    await writeFile(join(userDataDirectory, 'phase5-evidence', 'perf', 'raw.jsonl'), '{}');
    await writeFile(join(sibling, 'keep.txt'), 'keep');
    const checks = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    await runLocalDataResetHelper({
      userDataDirectory,
      parentProcessId: 456,
      nonce: NONCE,
      pollIntervalMs: 10,
      isProcessAlive: checks
    });

    expect(await isLocalDataResetPending(userDataDirectory)).toBe(false);
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep');
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it('rejects an unbound target or wrong nonce before deleting anything', async () => {
    const userDataDirectory = await makeUserDataDirectory();
    const helperScriptPath = join(process.cwd(), 'local-data-reset-helper.js');
    const { child } = makeSpawnedChild();
    await scheduleLocalDataResetAfterExit({
      userDataDirectory,
      parentProcessId: 11,
      executablePath: process.execPath,
      helperScriptPath,
      spawnProcess: () => child,
      createNonce: () => NONCE
    });
    const removeDirectory = vi.fn().mockResolvedValue(undefined);

    await expect(runLocalDataResetHelper({
      userDataDirectory,
      parentProcessId: 11,
      nonce: 'b'.repeat(64),
      isProcessAlive: () => false,
      removeDirectory
    })).rejects.toThrow(/binding does not match/u);
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it('restores the exact pending binding when Windows-style removal fails', async () => {
    const userDataDirectory = await makeUserDataDirectory();
    const helperScriptPath = join(process.cwd(), 'local-data-reset-helper.js');
    const { child } = makeSpawnedChild();
    await scheduleLocalDataResetAfterExit({
      userDataDirectory,
      parentProcessId: 789,
      executablePath: process.execPath,
      helperScriptPath,
      spawnProcess: () => child,
      createNonce: () => NONCE
    });
    const removeDirectory = vi.fn(async (directory: string) => {
      await rm(directory, { recursive: true, force: true });
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });

    await expect(runLocalDataResetHelper({
      userDataDirectory,
      parentProcessId: 789,
      nonce: NONCE,
      isProcessAlive: () => false,
      removeDirectory
    })).rejects.toThrow(/locked/u);

    expect(JSON.parse(await readFile(localDataResetMarkerPath(userDataDirectory), 'utf8')))
      .toEqual({
        version: 1,
        target: userDataDirectory,
        parentProcessId: 789,
        nonce: NONCE
      });
  });

  it('refuses relative, drive-root, and drive-top-level targets', () => {
    expect(() => assertSafeUserDataDirectory('relative')).toThrow(/absolute/u);
    const root = parse(process.cwd()).root;
    expect(() => assertSafeUserDataDirectory(root)).toThrow(/unsafe/u);
    expect(() => assertSafeUserDataDirectory(join(root, 'broad-target'))).toThrow(/unsafe/u);
  });
});

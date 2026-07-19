import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export const LOCAL_DATA_RESET_MARKER = '.desktop-translate-clear-data-pending' as const;
export const LOCAL_DATA_RESET_TARGET_PREFIX = '--target=' as const;
export const LOCAL_DATA_RESET_PARENT_PID_PREFIX = '--parent-pid=' as const;
export const LOCAL_DATA_RESET_NONCE_PREFIX = '--nonce=' as const;

interface LocalDataResetBinding {
  readonly version: 1;
  readonly target: string;
  readonly parentProcessId: number;
  readonly nonce: string;
}

export interface ResetChildProcess {
  once(event: string, listener: (() => void) | ((error: Error) => void)): this;
  unref(): void;
}

export interface ScheduleLocalDataResetOptions {
  readonly userDataDirectory: string;
  readonly parentProcessId: number;
  readonly executablePath: string;
  /** Fixed application-owned JavaScript entry bundled inside app.asar. */
  readonly helperScriptPath: string;
  readonly spawnProcess?: (
    executablePath: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly detached: true;
      readonly stdio: 'ignore';
      readonly windowsHide: true;
      readonly env: NodeJS.ProcessEnv;
    }
  ) => ResetChildProcess;
  readonly createNonce?: () => string;
}

export interface RunLocalDataResetHelperOptions {
  readonly userDataDirectory: string;
  readonly parentProcessId: number;
  readonly nonce: string;
  readonly pollIntervalMs?: number;
  readonly isProcessAlive?: (processId: number) => boolean;
  readonly removeDirectory?: (directory: string) => Promise<void>;
}

export interface LocalDataResetHelperArguments {
  readonly userDataDirectory: string;
  readonly parentProcessId: number;
  readonly nonce: string;
}

export function assertSafeUserDataDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error('The userData directory must be absolute');
  const trusted = resolve(directory);
  const root = parse(trusted).root;
  if (trusted === root || trusted.length <= root.length || dirname(trusted) === root) {
    throw new Error('Refusing to clear an unsafe userData directory');
  }
  return trusted;
}

function assertValidProcessId(processId: number): number {
  if (
    !Number.isSafeInteger(processId)
    || processId < 1
    || processId > 0xFFFF_FFFF
  ) {
    throw new Error('Invalid local-data reset parent process identifier');
  }
  return processId;
}

function assertValidNonce(nonce: string): string {
  if (!/^[0-9a-f]{64}$/u.test(nonce)) throw new Error('Invalid local-data reset nonce');
  return nonce;
}

export function localDataResetMarkerPath(userDataDirectory: string): string {
  return join(assertSafeUserDataDirectory(userDataDirectory), LOCAL_DATA_RESET_MARKER);
}

function requireSingleArgument(
  arguments_: readonly string[],
  prefix: string,
  label: string
): string {
  const matching = arguments_.filter((value) => value.startsWith(prefix));
  if (matching.length !== 1) throw new Error(`Invalid local-data reset ${label} arguments`);
  return matching[0]?.slice(prefix.length) ?? '';
}

export function parseLocalDataResetHelperArguments(
  arguments_: readonly string[]
): LocalDataResetHelperArguments {
  const userDataDirectory = assertSafeUserDataDirectory(
    requireSingleArgument(arguments_, LOCAL_DATA_RESET_TARGET_PREFIX, 'target')
  );
  const rawProcessId = requireSingleArgument(
    arguments_,
    LOCAL_DATA_RESET_PARENT_PID_PREFIX,
    'parent process'
  );
  if (!/^[1-9][0-9]{0,9}$/u.test(rawProcessId)) {
    throw new Error('Invalid local-data reset parent process identifier');
  }
  const parentProcessId = assertValidProcessId(Number(rawProcessId));
  const nonce = assertValidNonce(
    requireSingleArgument(arguments_, LOCAL_DATA_RESET_NONCE_PREFIX, 'nonce')
  );
  return { userDataDirectory, parentProcessId, nonce };
}

export async function isLocalDataResetPending(userDataDirectory: string): Promise<boolean> {
  try {
    await access(localDataResetMarkerPath(userDataDirectory));
    return true;
  } catch {
    return false;
  }
}

async function writeLocalDataResetMarker(binding: LocalDataResetBinding): Promise<void> {
  await mkdir(binding.target, { recursive: true });
  await writeFile(
    localDataResetMarkerPath(binding.target),
    `${JSON.stringify(binding)}\n`,
    { encoding: 'utf8', flag: 'w' }
  );
}

async function readAndValidateLocalDataResetMarker(
  expected: LocalDataResetBinding
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(localDataResetMarkerPath(expected.target), 'utf8'));
  } catch {
    throw new Error('Local-data reset marker is missing or invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Local-data reset marker is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4
    || record.version !== expected.version
    || record.target !== expected.target
    || record.parentProcessId !== expected.parentProcessId
    || record.nonce !== expected.nonce
  ) {
    throw new Error('Local-data reset marker binding does not match');
  }
}

export async function scheduleLocalDataResetAfterExit(
  options: ScheduleLocalDataResetOptions
): Promise<void> {
  const target = assertSafeUserDataDirectory(options.userDataDirectory);
  const parentProcessId = assertValidProcessId(options.parentProcessId);
  if (!isAbsolute(options.helperScriptPath)) {
    throw new Error('The local-data reset helper path must be absolute');
  }
  const helperScriptPath = resolve(options.helperScriptPath);
  const nonce = assertValidNonce(
    options.createNonce?.() ?? randomBytes(32).toString('hex')
  );
  const binding: LocalDataResetBinding = { version: 1, target, parentProcessId, nonce };
  await writeLocalDataResetMarker(binding);

  const arguments_ = [
    helperScriptPath,
    `${LOCAL_DATA_RESET_TARGET_PREFIX}${target}`,
    `${LOCAL_DATA_RESET_PARENT_PID_PREFIX}${parentProcessId}`,
    `${LOCAL_DATA_RESET_NONCE_PREFIX}${nonce}`
  ];
  const spawnProcess = options.spawnProcess ?? ((executablePath, childArguments, spawnOptions) =>
    spawn(executablePath, childArguments, spawnOptions) as unknown as ResetChildProcess);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawnProcess(options.executablePath, arguments_, {
      // Never start a second Electron application/profile. Electron executes
      // the fixed helper as a plain Node.js script in this mode.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: dirname(target),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolvePromise();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForParentExit(
  parentProcessId: number,
  checkAlive: (processId: number) => boolean,
  pollIntervalMs: number
): Promise<void> {
  while (checkAlive(parentProcessId)) {
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, pollIntervalMs);
    });
  }
}

export async function runLocalDataResetHelper(
  options: RunLocalDataResetHelperOptions
): Promise<void> {
  const target = assertSafeUserDataDirectory(options.userDataDirectory);
  const parentProcessId = assertValidProcessId(options.parentProcessId);
  const nonce = assertValidNonce(options.nonce);
  const binding: LocalDataResetBinding = { version: 1, target, parentProcessId, nonce };
  await readAndValidateLocalDataResetMarker(binding);

  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw new Error('Invalid local-data reset polling interval');
  }
  await waitForParentExit(
    parentProcessId,
    options.isProcessAlive ?? isProcessAlive,
    pollIntervalMs
  );

  const removeDirectory = options.removeDirectory ?? ((directory: string) =>
    rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  try {
    await removeDirectory(target);
  } catch (error) {
    // A failed recursive removal may already have removed the original marker.
    // Restore the exact PID/nonce/target binding so startup stays fail-closed.
    await writeLocalDataResetMarker(binding);
    throw error;
  }
}

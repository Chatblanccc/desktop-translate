import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createMetricsSink } from './metrics-sink.js';
import {
  PHASE5_BUILD_MODES,
  PHASE5_MEASUREMENT_MODES,
  type Phase5BuildMode,
  type Phase5MeasurementMode
} from './phase5-metrics.js';
import { Phase5RuntimeMetrics } from './runtime-metrics.js';

export const PHASE5_RUNTIME_METRICS_ENV = Object.freeze({
  enabled: 'DESKTOP_TRANSLATE_PHASE5_METRICS',
  userDataDirectory: 'DESKTOP_TRANSLATE_PHASE5_USER_DATA_DIR',
  developmentFile: 'DESKTOP_TRANSLATE_PHASE5_METRICS_FILE',
  gitSha: 'DESKTOP_TRANSLATE_PHASE5_GIT_SHA',
  binarySha256: 'DESKTOP_TRANSLATE_PHASE5_BINARY_SHA256',
  buildMode: 'DESKTOP_TRANSLATE_PHASE5_BUILD_MODE',
  measurementMode: 'DESKTOP_TRANSLATE_PHASE5_MEASUREMENT_MODE',
  runId: 'DESKTOP_TRANSLATE_PHASE5_RUN_ID'
} as const);

export interface RuntimeMetricsConfigurationOptions {
  readonly isPackaged: boolean;
  readonly userDataDirectory: string;
  readonly resourcesDirectory?: string;
  readonly appBundlePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface PackagedRuntimeMetricsUserDataOptions {
  readonly isPackaged: boolean;
  readonly commandLineUserDataDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly temporaryDirectory?: string;
}

/**
 * Electron's Chromium `--user-data-dir` switch does not change
 * `app.getPath('userData')` soon enough for Main bootstrap on every packaged
 * runtime. Bind it explicitly only for a complete, real packaged Phase 5
 * metrics request and only inside the runner-owned temporary-directory shape.
 * Ordinary product launches remain completely default-off.
 */
export function resolvePackagedRuntimeMetricsUserDataDirectory(
  options: PackagedRuntimeMetricsUserDataOptions
): string | undefined {
  const environment = options.environment ?? process.env;
  const buildMode = environment[PHASE5_RUNTIME_METRICS_ENV.buildMode];
  const measurementMode = environment[PHASE5_RUNTIME_METRICS_ENV.measurementMode];
  const runId = environment[PHASE5_RUNTIME_METRICS_ENV.runId];
  if (
    !options.isPackaged
    || environment[PHASE5_RUNTIME_METRICS_ENV.enabled] !== '1'
    || !isBuildMode(buildMode)
    || !isMeasurementMode(measurementMode)
    || !isPackagedMode(buildMode, measurementMode)
    || !isRunId(runId)
  ) return undefined;

  const candidate = environment[PHASE5_RUNTIME_METRICS_ENV.userDataDirectory];
  if (candidate === undefined) return undefined;
  const commandLineCandidate = options.commandLineUserDataDirectory;
  if (
    commandLineCandidate.length > 0
    && resolve(commandLineCandidate).toLowerCase() !== resolve(candidate).toLowerCase()
  ) return undefined;
  if (!isSafeAbsoluteDirectoryPath(candidate)) return undefined;
  try {
    const resolvedCandidate = resolve(candidate);
    const resolvedTemporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    const runRoot = dirname(resolvedCandidate);
    const relativeRunRoot = relative(resolvedTemporaryDirectory, runRoot);
    if (
      relativeRunRoot.length === 0
      || isAbsolute(relativeRunRoot)
      || relativeRunRoot === '..'
      || relativeRunRoot.startsWith(`..${sep}`)
      || relativeRunRoot.includes(sep)
      || !/^desktop-translate-phase5-perf03-[a-f0-9]{32}$/u.test(basename(runRoot))
      || !/^User Data [^\\/\u0000-\u001f]{1,80}$/u.test(basename(resolvedCandidate))
    ) return undefined;

    const runRootState = lstatSync(runRoot);
    const candidateState = lstatSync(resolvedCandidate);
    if (
      !runRootState.isDirectory()
      || runRootState.isSymbolicLink()
      || !candidateState.isDirectory()
      || candidateState.isSymbolicLink()
    ) return undefined;
    if (
      realpathSync.native(runRoot).toLowerCase() !== runRoot.toLowerCase()
      || realpathSync.native(resolvedCandidate).toLowerCase() !== resolvedCandidate.toLowerCase()
    ) return undefined;
    return resolvedCandidate;
  } catch {
    return undefined;
  }
}

export function createRuntimeMetricsFromEnvironment(
  options: RuntimeMetricsConfigurationOptions
): Phase5RuntimeMetrics | undefined {
  const environment = options.environment ?? process.env;
  if (environment[PHASE5_RUNTIME_METRICS_ENV.enabled] !== '1') return undefined;

  const buildMode = environment[PHASE5_RUNTIME_METRICS_ENV.buildMode];
  const measurementMode = environment[PHASE5_RUNTIME_METRICS_ENV.measurementMode];
  const runId = environment[PHASE5_RUNTIME_METRICS_ENV.runId];
  if (
    !isBuildMode(buildMode)
    || !isMeasurementMode(measurementMode)
  ) return undefined;

  const identity = options.isPackaged
    ? resolvePackagedIdentity(options, environment)
    : resolveDevelopmentIdentity(environment);
  if (identity === undefined) return undefined;
  if (options.isPackaged && !isPackagedMode(buildMode, measurementMode)) return undefined;

  const filePath = options.isPackaged
    ? isRunId(runId)
      ? join(options.userDataDirectory, 'phase5-evidence', 'perf', runId, 'raw.jsonl')
      : undefined
    : environment[PHASE5_RUNTIME_METRICS_ENV.developmentFile];
  if (
    filePath === undefined
    || !isAbsolute(filePath)
    || existsSync(filePath)
    || (options.isPackaged && existsSync(dirname(filePath)))
  ) return undefined;

  const sink = createMetricsSink({
    enabled: true,
    filePath,
    exclusiveCreate: options.isPackaged
  });
  if (sink.getState().status !== 'enabled') return undefined;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    return undefined;
  }
  return new Phase5RuntimeMetrics({
    sink,
    context: {
      gitSha: identity.gitSha,
      buildMode,
      measurementMode,
      ...(identity.binarySha256 === undefined ? {} : { binarySha256: identity.binarySha256 })
    }
  });
}

interface MetricsIdentity {
  readonly gitSha: string;
  readonly binarySha256?: string;
}

function resolveDevelopmentIdentity(
  environment: Readonly<Record<string, string | undefined>>
): MetricsIdentity | undefined {
  const gitSha = environment[PHASE5_RUNTIME_METRICS_ENV.gitSha];
  const binarySha256 = environment[PHASE5_RUNTIME_METRICS_ENV.binarySha256];
  if (
    gitSha === undefined
    || !/^[0-9a-f]{40}$/u.test(gitSha)
    || (binarySha256 !== undefined && !/^[0-9a-f]{64}$/u.test(binarySha256))
  ) return undefined;
  return binarySha256 === undefined ? { gitSha } : { gitSha, binarySha256 };
}

function resolvePackagedIdentity(
  options: RuntimeMetricsConfigurationOptions,
  environment: Readonly<Record<string, string | undefined>>
): MetricsIdentity | undefined {
  if (options.resourcesDirectory === undefined || options.appBundlePath === undefined) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(readFileSync(
      join(options.resourcesDirectory, 'manifest', 'component-manifest.json'),
      'utf8'
    )) as unknown;
    if (!isRecord(manifest) || !/^[0-9a-f]{40}$/u.test(String(manifest.gitSha ?? ''))) {
      return undefined;
    }
    const gitSha = String(manifest.gitSha);
    const binarySha256 = createHash('sha256')
      .update(readRawAppBundleBytes(options.appBundlePath))
      .digest('hex');
    const expectedGitSha = environment[PHASE5_RUNTIME_METRICS_ENV.gitSha];
    const expectedBinarySha256 = environment[PHASE5_RUNTIME_METRICS_ENV.binarySha256];
    if (
      (expectedGitSha !== undefined && expectedGitSha !== gitSha)
      || (expectedBinarySha256 !== undefined && expectedBinarySha256 !== binarySha256)
    ) return undefined;
    return { gitSha, binarySha256 };
  } catch {
    return undefined;
  }
}

/**
 * Electron patches `node:fs` so an ASAR archive behaves like a directory.
 * Identity binding needs the archive's exact bytes, so disable that patch only
 * for the synchronous read and restore the process-wide setting even on error.
 */
export function readRawAppBundleBytes(
  filePath: string,
  read: (path: string) => Buffer = readFileSync
): Buffer {
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return read(filePath);
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function isPackagedMode(
  buildMode: Phase5BuildMode,
  measurementMode: Phase5MeasurementMode
): boolean {
  return buildMode !== 'development'
    && measurementMode !== 'instrumentation-only'
    && measurementMode !== 'deterministic-fixture';
}

function isRunId(value: string | undefined): value is string {
  return value !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBuildMode(value: string | undefined): value is Phase5BuildMode {
  return value !== undefined && PHASE5_BUILD_MODES.includes(value as Phase5BuildMode);
}

function isMeasurementMode(value: string | undefined): value is Phase5MeasurementMode {
  return value !== undefined
    && PHASE5_MEASUREMENT_MODES.includes(value as Phase5MeasurementMode);
}

function isSafeAbsoluteDirectoryPath(value: string): boolean {
  if (!isAbsolute(value) || value.includes('\0')) return false;
  if (process.platform !== 'win32') return true;
  if (!/^[a-z]:[\\/]/iu.test(value)) return false;
  return !value.replaceAll('/', '\\').slice(2).includes(':');
}

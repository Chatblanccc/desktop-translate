import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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
      .update(readFileSync(options.appBundlePath))
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

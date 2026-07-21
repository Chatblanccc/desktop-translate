export const PHASE5_METRICS_SCHEMA_VERSION = 1 as const;

export const PHASE5_METRIC_IDS = [
  'PERF-01',
  'PERF-02',
  'PERF-03',
  'PERF-04',
  'PERF-05',
  'PERF-06',
  'PERF-07',
  'PERF-08',
  'PERF-09',
  'RES-01',
  'RES-02',
  'RES-03',
  'RES-04',
  'RES-05',
  'RES-06',
  'P5-METRICS-ENCODE-OVERHEAD'
] as const;

export const PHASE5_MEASUREMENT_MODES = [
  'instrumentation-only',
  'deterministic-fixture',
  'real-acquisition',
  'provider-smoke'
] as const;

export const PHASE5_BUILD_MODES = [
  'development',
  'packaged-unsigned',
  'release-equivalent',
  'signed-rc'
] as const;

export const PHASE5_METRIC_ROLES = [
  'benchmark-controller',
  'main',
  'renderer',
  'native-host',
  'electron-process-tree'
] as const;

export const PHASE5_METRIC_SCENARIOS = [
  'cold-start',
  'warm-start',
  'host-ready',
  'uia-source-card',
  'ocr-source-card',
  'renderer-paint-ack',
  'fake-provider-translation',
  'provider-smoke',
  'shutdown',
  'idle',
  'soak',
  'metrics-pipeline'
] as const;

export const PHASE5_METRIC_SOURCES = [
  'synthetic',
  'electron-main',
  'renderer',
  'native-host',
  'fake-native',
  'fake-provider',
  'windows-uia',
  'windows-ocr',
  'process-tree'
] as const;

export const PHASE5_MEASUREMENTS = [
  'durationMs',
  'privateWorkingSetBytes',
  'privateBytes',
  'cpuCapacityPercent',
  'handleCount',
  'gdiObjectCount',
  'userObjectCount'
] as const;

export const PHASE5_METRIC_UNITS = ['milliseconds', 'bytes', 'percent', 'count'] as const;

export const PHASE5_CHARACTER_COUNT_BUCKETS = [
  'not-applicable',
  '0',
  '1-16',
  '17-64',
  '65-256',
  '257+'
] as const;

export const PHASE5_METRIC_ERROR_CODES = [
  'HOST_NOT_READY',
  'NATIVE_DISCONNECTED',
  'OPERATION_TIMEOUT',
  'PAINT_ACK_TIMEOUT',
  'PROCESS_EXIT_TIMEOUT',
  'PROVIDER_FAILURE',
  'INSTRUMENTATION_OPERATION_FAILED'
] as const;

export type Phase5MetricId = (typeof PHASE5_METRIC_IDS)[number];
export type Phase5MeasurementMode = (typeof PHASE5_MEASUREMENT_MODES)[number];
export type Phase5BuildMode = (typeof PHASE5_BUILD_MODES)[number];
export type Phase5MetricRole = (typeof PHASE5_METRIC_ROLES)[number];
export type Phase5MetricScenario = (typeof PHASE5_METRIC_SCENARIOS)[number];
export type Phase5MetricSource = (typeof PHASE5_METRIC_SOURCES)[number];
export type Phase5Measurement = (typeof PHASE5_MEASUREMENTS)[number];
export type Phase5MetricUnit = (typeof PHASE5_METRIC_UNITS)[number];
export type Phase5CharacterCountBucket = (typeof PHASE5_CHARACTER_COUNT_BUCKETS)[number];
export type Phase5MetricErrorCode = (typeof PHASE5_METRIC_ERROR_CODES)[number];

export interface Phase5MetricSample {
  readonly schemaVersion: typeof PHASE5_METRICS_SCHEMA_VERSION;
  readonly recordType: 'metric-sample';
  readonly metricId: Phase5MetricId;
  readonly measurementMode: Phase5MeasurementMode;
  readonly buildMode: Phase5BuildMode;
  readonly role: Phase5MetricRole;
  readonly scenario: Phase5MetricScenario;
  readonly source: Phase5MetricSource;
  readonly measurement: Phase5Measurement;
  readonly unit: Phase5MetricUnit;
  readonly status: 'success' | 'failure';
  readonly value: number;
  readonly characterCountBucket: Phase5CharacterCountBucket;
  readonly gitSha: string;
  readonly binarySha256?: string;
  readonly errorCode?: Phase5MetricErrorCode;
}

export type Phase5MetricSampleInput = Omit<
  Phase5MetricSample,
  'schemaVersion' | 'recordType'
>;

const SAMPLE_REQUIRED_KEYS = [
  'schemaVersion',
  'recordType',
  'metricId',
  'measurementMode',
  'buildMode',
  'role',
  'scenario',
  'source',
  'measurement',
  'unit',
  'status',
  'value',
  'characterCountBucket',
  'gitSha'
] as const;
const SAMPLE_OPTIONAL_KEYS = ['binarySha256', 'errorCode'] as const;
const SAMPLE_ALLOWED_KEYS = new Set<string>([
  ...SAMPLE_REQUIRED_KEYS,
  ...SAMPLE_OPTIONAL_KEYS
]);
const MEASUREMENT_UNITS: Readonly<Record<Phase5Measurement, Phase5MetricUnit>> = Object.freeze({
  durationMs: 'milliseconds',
  privateWorkingSetBytes: 'bytes',
  privateBytes: 'bytes',
  cpuCapacityPercent: 'percent',
  handleCount: 'count',
  gdiObjectCount: 'count',
  userObjectCount: 'count'
});

export function createPhase5MetricSample(
  input: Phase5MetricSampleInput
): Phase5MetricSample {
  const sample: Phase5MetricSample = {
    schemaVersion: PHASE5_METRICS_SCHEMA_VERSION,
    recordType: 'metric-sample',
    metricId: input.metricId,
    measurementMode: input.measurementMode,
    buildMode: input.buildMode,
    role: input.role,
    scenario: input.scenario,
    source: input.source,
    measurement: input.measurement,
    unit: input.unit,
    status: input.status,
    value: input.value,
    characterCountBucket: input.characterCountBucket,
    gitSha: input.gitSha,
    ...(input.binarySha256 === undefined ? {} : { binarySha256: input.binarySha256 }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  };
  if (!isPhase5MetricSample(sample)) {
    throw new TypeError('Phase 5 metric sample violates the privacy-safe v1 contract');
  }
  return Object.freeze(sample);
}

export function isPhase5MetricSample(value: unknown): value is Phase5MetricSample {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !SAMPLE_ALLOWED_KEYS.has(key))
    || SAMPLE_REQUIRED_KEYS.some((key) => !(key in value))
  ) return false;

  if (
    value.schemaVersion !== PHASE5_METRICS_SCHEMA_VERSION
    || value.recordType !== 'metric-sample'
    || !includes(PHASE5_METRIC_IDS, value.metricId)
    || !includes(PHASE5_MEASUREMENT_MODES, value.measurementMode)
    || !includes(PHASE5_BUILD_MODES, value.buildMode)
    || !includes(PHASE5_METRIC_ROLES, value.role)
    || !includes(PHASE5_METRIC_SCENARIOS, value.scenario)
    || !includes(PHASE5_METRIC_SOURCES, value.source)
    || !includes(PHASE5_MEASUREMENTS, value.measurement)
    || !includes(PHASE5_METRIC_UNITS, value.unit)
    || !includes(PHASE5_CHARACTER_COUNT_BUCKETS, value.characterCountBucket)
    || (value.status !== 'success' && value.status !== 'failure')
    || !isNonNegativeFiniteNumber(value.value)
    || typeof value.gitSha !== 'string'
    || !/^[0-9a-f]{40}$/u.test(value.gitSha)
  ) return false;

  if (MEASUREMENT_UNITS[value.measurement] !== value.unit) return false;
  if (value.unit === 'bytes' || value.unit === 'count') {
    if (!Number.isSafeInteger(value.value)) return false;
  }
  if (value.unit === 'percent' && value.value > 100) return false;

  if (
    value.binarySha256 !== undefined
    && (typeof value.binarySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.binarySha256))
  ) return false;

  if (value.status === 'success') return value.errorCode === undefined;
  return includes(PHASE5_METRIC_ERROR_CODES, value.errorCode);
}

export function serializePhase5MetricSample(sample: unknown): string {
  if (!isPhase5MetricSample(sample)) {
    throw new TypeError('Phase 5 metric sample violates the privacy-safe v1 contract');
  }
  return JSON.stringify(sample);
}

export function bucketCharacterCount(count: number): Phase5CharacterCountBucket {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('Character count must be a non-negative safe integer');
  }
  if (count === 0) return '0';
  if (count <= 16) return '1-16';
  if (count <= 64) return '17-64';
  if (count <= 256) return '65-256';
  return '257+';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

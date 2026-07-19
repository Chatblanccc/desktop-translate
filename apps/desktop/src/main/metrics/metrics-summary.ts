import {
  isPhase5MetricSample,
  PHASE5_METRICS_SCHEMA_VERSION,
  type Phase5BuildMode,
  type Phase5CharacterCountBucket,
  type Phase5Measurement,
  type Phase5MeasurementMode,
  type Phase5MetricId,
  type Phase5MetricRole,
  type Phase5MetricSample,
  type Phase5MetricScenario,
  type Phase5MetricSource,
  type Phase5MetricUnit
} from './phase5-metrics.js';

export interface Phase5MetricSummaryGroup {
  readonly metricId: Phase5MetricId;
  readonly measurementMode: Phase5MeasurementMode;
  readonly buildMode: Phase5BuildMode;
  readonly role: Phase5MetricRole;
  readonly scenario: Phase5MetricScenario;
  readonly source: Phase5MetricSource;
  readonly measurement: Phase5Measurement;
  readonly unit: Phase5MetricUnit;
  readonly characterCountBucket: Phase5CharacterCountBucket;
  readonly gitSha: string;
  readonly binarySha256?: string;
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly failureCount: number;
}

export interface Phase5MetricsSummary {
  readonly schemaVersion: typeof PHASE5_METRICS_SCHEMA_VERSION;
  readonly recordType: 'metrics-summary';
  readonly statisticsMethod: 'nearest-rank';
  readonly percentilePopulation: 'all-samples';
  readonly evidenceScope: 'instrumentation-only' | 'contains-non-instrumentation';
  readonly groups: readonly Phase5MetricSummaryGroup[];
}

export function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new RangeError('Cannot calculate a percentile without samples');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new RangeError('Percentile must be greater than zero and at most one');
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Metric values must be finite non-negative numbers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[index]!;
}

export function summarizePhase5Metrics(
  samples: readonly Phase5MetricSample[]
): Phase5MetricsSummary {
  if (samples.length === 0) throw new RangeError('Cannot summarize an empty metric set');
  for (const sample of samples) {
    if (!isPhase5MetricSample(sample)) {
      throw new TypeError('Phase 5 metric sample violates the privacy-safe v1 contract');
    }
  }

  const grouped = new Map<string, Phase5MetricSample[]>();
  for (const sample of samples) {
    const key = groupKey(sample);
    const entries = grouped.get(key);
    if (entries === undefined) grouped.set(key, [sample]);
    else entries.push(sample);
  }

  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entries]) => summarizeGroup(entries));
  return Object.freeze({
    schemaVersion: PHASE5_METRICS_SCHEMA_VERSION,
    recordType: 'metrics-summary',
    statisticsMethod: 'nearest-rank',
    percentilePopulation: 'all-samples',
    evidenceScope: samples.every(({ measurementMode }) => measurementMode === 'instrumentation-only')
      ? 'instrumentation-only'
      : 'contains-non-instrumentation',
    groups: Object.freeze(groups)
  });
}

export function parsePhase5MetricJsonl(text: string): readonly Phase5MetricSample[] {
  const samples = text.split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new TypeError('Phase 5 metric JSONL contains malformed JSON');
      }
      if (!isPhase5MetricSample(value)) {
        throw new TypeError('Phase 5 metric JSONL violates the privacy-safe v1 contract');
      }
      return value;
    });
  if (samples.length === 0) throw new RangeError('Phase 5 metric JSONL is empty');
  return Object.freeze(samples);
}

function summarizeGroup(entries: readonly Phase5MetricSample[]): Phase5MetricSummaryGroup {
  const first = entries[0]!;
  const values = entries.map(({ value }) => value);
  return Object.freeze({
    metricId: first.metricId,
    measurementMode: first.measurementMode,
    buildMode: first.buildMode,
    role: first.role,
    scenario: first.scenario,
    source: first.source,
    measurement: first.measurement,
    unit: first.unit,
    characterCountBucket: first.characterCountBucket,
    gitSha: first.gitSha,
    ...(first.binarySha256 === undefined ? {} : { binarySha256: first.binarySha256 }),
    n: entries.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values),
    failureCount: entries.filter(({ status }) => status === 'failure').length
  });
}

function groupKey(sample: Phase5MetricSample): string {
  return [
    sample.metricId,
    sample.measurementMode,
    sample.buildMode,
    sample.role,
    sample.scenario,
    sample.source,
    sample.measurement,
    sample.unit,
    sample.characterCountBucket,
    sample.gitSha,
    sample.binarySha256 ?? ''
  ].join('\u001f');
}

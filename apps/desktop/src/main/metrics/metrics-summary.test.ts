import { describe, expect, it } from 'vitest';
import { createPhase5MetricSample } from './phase5-metrics.js';
import {
  nearestRank,
  parsePhase5MetricJsonl,
  summarizePhase5Metrics
} from './metrics-summary.js';

const gitSha = 'b'.repeat(40);

describe('Phase 5 metric statistics', () => {
  it('uses nearest-rank and keeps every value in the percentile population', () => {
    const values = Array.from({ length: 20 }, (_value, index) => index + 1);

    expect(nearestRank(values, 0.5)).toBe(10);
    expect(nearestRank(values, 0.95)).toBe(19);
    expect(nearestRank(values, 1)).toBe(20);
    expect(nearestRank(values.slice(0, 10), 0.95)).toBe(10);
  });

  it('reports N, p50, p95, max and failureCount without removing failures', () => {
    const samples = Array.from({ length: 20 }, (_value, index) => metric(
      index + 1,
      index === 19 ? 'failure' : 'success'
    ));

    const summary = summarizePhase5Metrics(samples);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      recordType: 'metrics-summary',
      statisticsMethod: 'nearest-rank',
      percentilePopulation: 'all-samples',
      evidenceScope: 'instrumentation-only'
    });
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      n: 20,
      p50: 10,
      p95: 19,
      max: 20,
      failureCount: 1
    });
  });

  it('parses only contract-valid JSONL and rejects unknown fields or empty input', () => {
    const valid = JSON.stringify(metric(1));
    expect(parsePhase5MetricJsonl(`${valid}\n`)).toHaveLength(1);
    expect(() => parsePhase5MetricJsonl('')).toThrow('empty');
    expect(() => parsePhase5MetricJsonl('{not-json}\n')).toThrow('malformed JSON');
    expect(() => parsePhase5MetricJsonl(
      `${JSON.stringify({ ...metric(1), text: 'private source text' })}\n`
    )).toThrow('privacy-safe v1 contract');
  });

  it('rejects invalid percentile and summary inputs', () => {
    for (const percentile of [Number.NaN, 0, -0.1, 1.1]) {
      expect(() => nearestRank([1], percentile)).toThrow('Percentile');
    }
    for (const values of [[], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      expect(() => nearestRank(values, 0.5)).toThrow();
    }
    expect(() => summarizePhase5Metrics([])).toThrow('empty metric set');
    expect(() => summarizePhase5Metrics([
      { ...metric(1), text: 'private source text' } as never
    ])).toThrow('privacy-safe v1 contract');
  });

  it('groups unlike evidence deterministically and preserves binary identity', () => {
    const binarySha256 = 'f'.repeat(64);
    const real = createPhase5MetricSample({
      metricId: 'PERF-03',
      measurementMode: 'real-acquisition',
      buildMode: 'signed-rc',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      measurement: 'durationMs',
      unit: 'milliseconds',
      status: 'success',
      value: 5,
      characterCountBucket: 'not-applicable',
      gitSha,
      binarySha256
    });
    const summary = summarizePhase5Metrics([real, metric(2), real]);

    expect(summary.evidenceScope).toBe('contains-non-instrumentation');
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.find(({ metricId }) => metricId === 'PERF-03')).toMatchObject({
      binarySha256,
      n: 2,
      p50: 5,
      p95: 5
    });
  });
});

function metric(value: number, status: 'success' | 'failure' = 'success') {
  return createPhase5MetricSample({
    metricId: 'P5-METRICS-ENCODE-OVERHEAD',
    measurementMode: 'instrumentation-only',
    buildMode: 'development',
    role: 'benchmark-controller',
    scenario: 'metrics-pipeline',
    source: 'synthetic',
    measurement: 'durationMs',
    unit: 'milliseconds',
    status,
    value,
    characterCountBucket: 'not-applicable',
    gitSha,
    ...(status === 'failure' ? { errorCode: 'INSTRUMENTATION_OPERATION_FAILED' as const } : {})
  });
}

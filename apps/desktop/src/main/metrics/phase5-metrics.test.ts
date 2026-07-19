import { describe, expect, it } from 'vitest';
import {
  bucketCharacterCount,
  createPhase5MetricSample,
  isPhase5MetricSample,
  serializePhase5MetricSample,
  type Phase5MetricSample
} from './phase5-metrics.js';

const valid = createPhase5MetricSample({
  metricId: 'P5-METRICS-ENCODE-OVERHEAD',
  measurementMode: 'instrumentation-only',
  buildMode: 'development',
  role: 'benchmark-controller',
  scenario: 'metrics-pipeline',
  source: 'synthetic',
  measurement: 'durationMs',
  unit: 'milliseconds',
  status: 'success',
  value: 1,
  characterCountBucket: 'not-applicable',
  gitSha: '1'.repeat(40)
});

describe('Phase 5 metric runtime contract', () => {
  it('accepts allowlisted duration, resource and failure samples', () => {
    expect(isPhase5MetricSample(valid)).toBe(true);
    expect(isPhase5MetricSample({
      ...valid,
      metricId: 'RES-02',
      role: 'electron-process-tree',
      scenario: 'idle',
      source: 'process-tree',
      measurement: 'privateWorkingSetBytes',
      unit: 'bytes',
      value: 1024,
      binarySha256: '2'.repeat(64)
    })).toBe(true);
    expect(isPhase5MetricSample({
      ...valid,
      metricId: 'RES-04',
      measurement: 'handleCount',
      unit: 'count',
      value: 42
    })).toBe(true);
    expect(isPhase5MetricSample({
      ...valid,
      metricId: 'RES-01',
      measurement: 'cpuCapacityPercent',
      unit: 'percent',
      value: 0.5
    })).toBe(true);
    expect(isPhase5MetricSample({
      ...valid,
      status: 'failure',
      errorCode: 'INSTRUMENTATION_OPERATION_FAILED'
    })).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['array', []],
    ['scalar', 'metric'],
    ['unknown key', { ...valid, text: 'private source text' }],
    ['missing key', without(valid, 'gitSha')],
    ['schema version', { ...valid, schemaVersion: 2 }],
    ['record type', { ...valid, recordType: 'log' }],
    ['metric id', { ...valid, metricId: 'PRIVATE-METRIC' }],
    ['measurement mode', { ...valid, measurementMode: 'private-mode' }],
    ['build mode', { ...valid, buildMode: 'private-build' }],
    ['role', { ...valid, role: 'private-role' }],
    ['scenario', { ...valid, scenario: 'private-scenario' }],
    ['source', { ...valid, source: 'private-source' }],
    ['measurement', { ...valid, measurement: 'private-measurement' }],
    ['unit', { ...valid, unit: 'private-unit' }],
    ['character bucket', { ...valid, characterCountBucket: 'private-bucket' }],
    ['status', { ...valid, status: 'private-status' }],
    ['negative value', { ...valid, value: -1 }],
    ['non-finite value', { ...valid, value: Number.NaN }],
    ['non-number value', { ...valid, value: 'private-value' }],
    ['git SHA type', { ...valid, gitSha: 42 }],
    ['git SHA format', { ...valid, gitSha: 'ABC' }],
    ['unit mismatch', { ...valid, unit: 'bytes' }],
    ['fractional bytes', {
      ...valid,
      measurement: 'privateBytes',
      unit: 'bytes',
      value: 1.5
    }],
    ['fractional count', {
      ...valid,
      measurement: 'handleCount',
      unit: 'count',
      value: 1.5
    }],
    ['CPU above capacity', {
      ...valid,
      measurement: 'cpuCapacityPercent',
      unit: 'percent',
      value: 100.1
    }],
    ['binary hash type', { ...valid, binarySha256: 42 }],
    ['binary hash format', { ...valid, binarySha256: 'ABC' }],
    ['success error code', { ...valid, errorCode: 'HOST_NOT_READY' }],
    ['missing failure error code', { ...valid, status: 'failure' }],
    ['unknown failure error code', {
      ...valid,
      status: 'failure',
      errorCode: 'PRIVATE_ERROR_TEXT'
    }]
  ])('rejects %s', (_name, candidate) => {
    expect(isPhase5MetricSample(candidate)).toBe(false);
  });

  it('throws before constructing or serializing a non-allowlisted sample', () => {
    expect(() => createPhase5MetricSample({
      ...valid,
      gitSha: 'invalid'
    } as unknown as Omit<Phase5MetricSample, 'schemaVersion' | 'recordType'>))
      .toThrow('privacy-safe v1 contract');
    expect(() => serializePhase5MetricSample({ ...valid, body: 'private body' }))
      .toThrow('privacy-safe v1 contract');
  });

  it('derives only coarse character-count buckets without accepting content', () => {
    expect([0, 1, 16, 17, 64, 65, 256, 257].map(bucketCharacterCount)).toEqual([
      '0',
      '1-16',
      '1-16',
      '17-64',
      '17-64',
      '65-256',
      '65-256',
      '257+'
    ]);
    for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bucketCharacterCount(invalid)).toThrow('non-negative safe integer');
    }
  });
});

function without(value: Phase5MetricSample, key: keyof Phase5MetricSample): object {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

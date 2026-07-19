import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsSink } from './metrics-sink.js';
import {
  createPhase5MetricSample,
  type Phase5MetricSample
} from './phase5-metrics.js';

const temporaryDirectories: string[] = [];
const gitSha = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('Phase 5 MetricsSink', () => {
  it('is default-off and performs no validation or filesystem writes', async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'metrics.jsonl');
    const sink = createMetricsSink();

    await expect(sink.record({ text: 'private source text' } as unknown as Phase5MetricSample))
      .resolves.toBeUndefined();
    await sink.close();

    expect(sink.getState()).toEqual({
      status: 'disabled',
      recordsWritten: 0,
      reason: 'not-enabled'
    });
    await expect(access(outputPath)).rejects.toThrow();
  });

  it('persists only the exact privacy-safe allowlist as JSONL', async () => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'metrics.jsonl');
    const sink = createMetricsSink({ enabled: true, filePath: outputPath });

    await sink.record(sample(12.5));
    await sink.record(sample(21.25));
    await sink.close();

    expect(sink.getState()).toEqual({ status: 'enabled', recordsWritten: 2 });
    const text = await readFile(outputPath, 'utf8');
    const records = text.trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(Object.keys(records[0]!).sort()).toEqual([
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
    ].sort());
    for (const forbidden of [
      'text',
      'credential',
      'path',
      'pid',
      'hwnd',
      'windowTitle',
      'body',
      'private source text'
    ]) expect(text).not.toContain(forbidden);
  });

  it.each([
    ['source text', { text: 'private source text' }],
    ['credential', { credential: 'private-secret' }],
    ['filesystem path', { path: 'C:\\Users\\private\\metrics.jsonl' }],
    ['window identity', { pid: 4242, hwnd: '0x1234', windowTitle: 'Private window' }],
    ['arbitrary error text', { status: 'failure', errorCode: 'PRIVATE_ERROR_TEXT' }]
  ])('rejects a sample containing non-allowlisted %s', async (_name, extra) => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'metrics.jsonl');
    const sink = createMetricsSink({ enabled: true, filePath: outputPath });
    const invalid = { ...sample(1), ...extra } as unknown as Phase5MetricSample;

    await expect(sink.record(invalid)).rejects.toThrow('privacy-safe v1 contract');
    await sink.close();
    await expect(access(outputPath)).rejects.toThrow();
  });

  it('fails closed without exposing an invalid target path', async () => {
    const sink = createMetricsSink({ enabled: true, filePath: 'relative-metrics.jsonl' });
    await expect(sink.record(sample(1))).resolves.toBeUndefined();
    expect(sink.getState()).toEqual({
      status: 'disabled',
      recordsWritten: 0,
      reason: 'invalid-target'
    });
  });

  it.each([
    undefined,
    'C:\\ambiguous:stream\\metrics.jsonl',
    `C:\\metrics\0private.jsonl`
  ])('does not enable an invalid target variant', async (filePath) => {
    const sink = createMetricsSink({ enabled: true, ...(filePath === undefined ? {} : { filePath }) });
    expect(sink.getState()).toMatchObject({ status: 'disabled', reason: 'invalid-target' });
    await sink.close();
  });

  it.each([
    { initial: '{"existing":true}', expectedPrefix: '{"existing":true}\n' },
    { initial: '{"existing":true}\n', expectedPrefix: '{"existing":true}\n' }
  ])('separates an appended run from existing bytes', async ({ initial, expectedPrefix }) => {
    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'metrics.jsonl');
    await writeFile(outputPath, initial, 'utf8');
    const sink = createMetricsSink({ enabled: true, filePath: outputPath });

    await sink.record(sample(3));
    await sink.close();

    const text = await readFile(outputPath, 'utf8');
    expect(text.startsWith(expectedPrefix)).toBe(true);
    expect(text.trim().split(/\r?\n/u)).toHaveLength(2);
  });

  it('faults closed with a stable reason when the target cannot be created', async () => {
    const directory = await temporaryDirectory();
    const missingParent = join(directory, 'missing-parent', 'metrics.jsonl');
    const sink = createMetricsSink({ enabled: true, filePath: missingParent });

    await expect(sink.record(sample(1))).rejects.toThrow('metrics sink write failed');
    expect(sink.getState()).toEqual({
      status: 'disabled',
      recordsWritten: 0,
      reason: 'write-failed'
    });
    await sink.close();
  });

  it('rejects a directory target as a non-file target', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'metrics-target');
    await mkdir(target);
    const sink = createMetricsSink({ enabled: true, filePath: target });

    await expect(sink.record(sample(1))).rejects.toThrow('metrics sink write failed');
    expect(sink.getState()).toMatchObject({ status: 'disabled', reason: 'write-failed' });
    await sink.close();
  });
});

function sample(value: number): Phase5MetricSample {
  return createPhase5MetricSample({
    metricId: 'P5-METRICS-ENCODE-OVERHEAD',
    measurementMode: 'instrumentation-only',
    buildMode: 'development',
    role: 'benchmark-controller',
    scenario: 'metrics-pipeline',
    source: 'synthetic',
    measurement: 'durationMs',
    unit: 'milliseconds',
    status: 'success',
    value,
    characterCountBucket: 'not-applicable',
    gitSha
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-translate-phase5-metrics-'));
  temporaryDirectories.push(directory);
  return directory;
}

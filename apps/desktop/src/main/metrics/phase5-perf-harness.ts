import { performance } from 'node:perf_hooks';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMetricsSink } from './metrics-sink.js';
import {
  createPhase5MetricSample,
  PHASE5_BUILD_MODES,
  serializePhase5MetricSample,
  type Phase5BuildMode
} from './phase5-metrics.js';
import {
  parsePhase5MetricJsonl,
  summarizePhase5Metrics
} from './metrics-summary.js';

export interface InstrumentationOptions {
  readonly outputDirectory: string;
  readonly gitSha: string;
  readonly binarySha256?: string;
  readonly buildMode: Phase5BuildMode;
  readonly sampleCount: number;
}

export async function runInstrumentationBaseline(
  options: InstrumentationOptions
): Promise<void> {
  validateInstrumentationOptions(options);
  const outputDirectory = resolve(options.outputDirectory);
  const rawPath = resolve(outputDirectory, 'raw.jsonl');
  const summaryPath = resolve(outputDirectory, 'summary.json');
  await mkdir(outputDirectory, { recursive: true });
  await assertMissing(rawPath);
  await assertMissing(summaryPath);

  const sink = createMetricsSink({ enabled: true, filePath: rawPath });
  try {
    for (let index = 0; index < options.sampleCount; index += 1) {
      const probe = createInstrumentationSample(options, 0);
      const startedAt = performance.now();
      serializePhase5MetricSample(probe);
      const durationMs = performance.now() - startedAt;
      await sink.record(createInstrumentationSample(options, durationMs));
    }
  } finally {
    await sink.close();
  }
  if (sink.getState().recordsWritten !== options.sampleCount) {
    throw new Error('Instrumentation baseline did not persist every sample');
  }

  await summarizeFile(rawPath, summaryPath);
}

export async function summarizeFile(inputPath: string, outputPath: string): Promise<void> {
  const raw = await readFile(resolve(inputPath), 'utf8');
  const samples = parsePhase5MetricJsonl(raw);
  const summary = summarizePhase5Metrics(samples);
  await writeFile(resolve(outputPath), `${JSON.stringify(summary, undefined, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

function createInstrumentationSample(
  options: InstrumentationOptions,
  value: number
) {
  return createPhase5MetricSample({
    metricId: 'P5-METRICS-ENCODE-OVERHEAD',
    measurementMode: 'instrumentation-only',
    buildMode: options.buildMode,
    role: 'benchmark-controller',
    scenario: 'metrics-pipeline',
    source: 'synthetic',
    measurement: 'durationMs',
    unit: 'milliseconds',
    status: 'success',
    value,
    characterCountBucket: 'not-applicable',
    gitSha: options.gitSha,
    ...(options.binarySha256 === undefined
      ? {}
      : { binarySha256: options.binarySha256 })
  });
}

function validateInstrumentationOptions(options: InstrumentationOptions): void {
  if (!/^[0-9a-f]{40}$/u.test(options.gitSha)) {
    throw new TypeError('The instrumentation harness requires a lowercase 40-character git SHA');
  }
  if (
    options.binarySha256 !== undefined
    && !/^[0-9a-f]{64}$/u.test(options.binarySha256)
  ) throw new TypeError('Binary SHA-256 must contain 64 lowercase hexadecimal characters');
  if (!PHASE5_BUILD_MODES.includes(options.buildMode)) {
    throw new TypeError('Unsupported Phase 5 build mode');
  }
  if (!Number.isSafeInteger(options.sampleCount) || options.sampleCount < 1) {
    throw new RangeError('Sample count must be a positive safe integer');
  }
}

async function assertMissing(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    return;
  }
  throw new Error('Phase 5 harness refuses to overwrite an existing evidence file');
}

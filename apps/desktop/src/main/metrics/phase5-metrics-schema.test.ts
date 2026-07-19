import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createPhase5MetricSample } from './phase5-metrics.js';
import { summarizePhase5Metrics } from './metrics-summary.js';

const schemaUrl = new URL('./phase5-metrics.schema.json', import.meta.url);

describe('Phase 5 metrics JSON Schema', () => {
  it('compiles and matches the runtime allowlist for raw samples and summaries', async () => {
    const schema = JSON.parse(await readFile(schemaUrl, 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const sample = createPhase5MetricSample({
      metricId: 'P5-METRICS-ENCODE-OVERHEAD',
      measurementMode: 'instrumentation-only',
      buildMode: 'development',
      role: 'benchmark-controller',
      scenario: 'metrics-pipeline',
      source: 'synthetic',
      measurement: 'durationMs',
      unit: 'milliseconds',
      status: 'success',
      value: 1.25,
      characterCountBucket: 'not-applicable',
      gitSha: 'c'.repeat(40)
    });

    expect(validate(sample)).toBe(true);
    expect(validate(summarizePhase5Metrics([sample]))).toBe(true);
    for (const invalid of [
      { ...sample, text: 'private source text' },
      { ...sample, credential: 'private-secret' },
      { ...sample, path: 'C:\\Users\\private\\metrics.jsonl' },
      { ...sample, pid: 4242 },
      { ...sample, status: 'failure' },
      { ...sample, measurement: 'privateBytes', unit: 'milliseconds' }
    ]) expect(validate(invalid)).toBe(false);
  });
});

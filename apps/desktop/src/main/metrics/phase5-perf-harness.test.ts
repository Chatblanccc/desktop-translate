import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInstrumentationBaseline } from './phase5-perf-harness.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('Phase 5 perf harness', () => {
  it('produces only instrumentation pipeline evidence and a nearest-rank summary', async () => {
    const directory = await temporaryDirectory();
    await runInstrumentationBaseline({
      outputDirectory: directory,
      gitSha: 'd'.repeat(40),
      buildMode: 'development',
      sampleCount: 5
    });

    const raw = await readFile(join(directory, 'raw.jsonl'), 'utf8');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as {
      evidenceScope: string;
      statisticsMethod: string;
      groups: Array<Record<string, unknown>>;
    };
    expect(raw.trim().split(/\r?\n/u)).toHaveLength(5);
    expect(summary.evidenceScope).toBe('instrumentation-only');
    expect(summary.statisticsMethod).toBe('nearest-rank');
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      metricId: 'P5-METRICS-ENCODE-OVERHEAD',
      measurementMode: 'instrumentation-only',
      source: 'synthetic',
      n: 5,
      failureCount: 0
    });
    for (const forbidden of [
      'PERF-04',
      'PERF-05',
      'windows-uia',
      'windows-ocr',
      'text',
      'credential',
      'path',
      'pid',
      'hwnd',
      'body'
    ]) {
      expect(raw).not.toContain(forbidden);
      expect(JSON.stringify(summary)).not.toContain(forbidden);
    }
  });

  it('refuses to overwrite prior evidence', async () => {
    const directory = await temporaryDirectory();
    const options = {
      outputDirectory: directory,
      gitSha: 'e'.repeat(40),
      buildMode: 'development' as const,
      sampleCount: 1
    };
    await runInstrumentationBaseline(options);
    await expect(runInstrumentationBaseline(options)).rejects.toThrow('refuses to overwrite');
    await expect(access(join(directory, 'raw.jsonl'))).resolves.toBeUndefined();
  });

  it('preserves an optional binary hash and refuses a pre-existing summary', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'summary.json'), '{}', 'utf8');
    await expect(runInstrumentationBaseline({
      outputDirectory: directory,
      gitSha: 'e'.repeat(40),
      binarySha256: 'f'.repeat(64),
      buildMode: 'packaged-unsigned',
      sampleCount: 1
    })).rejects.toThrow('refuses to overwrite');
  });

  it.each([
    { name: 'git SHA', gitSha: 'invalid' },
    { name: 'binary SHA', binarySha256: 'invalid' },
    { name: 'build mode', buildMode: 'invalid' },
    { name: 'zero samples', sampleCount: 0 },
    { name: 'fractional samples', sampleCount: 1.5 }
  ])('rejects invalid $name before writing evidence', async (override) => {
    const directory = await temporaryDirectory();
    await expect(runInstrumentationBaseline({
      outputDirectory: directory,
      gitSha: 'a'.repeat(40),
      binarySha256: 'b'.repeat(64),
      buildMode: 'development',
      sampleCount: 1,
      ...override
    } as never)).rejects.toThrow();
    await expect(access(join(directory, 'raw.jsonl'))).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-translate-phase5-harness-'));
  temporaryDirectories.push(directory);
  return directory;
}

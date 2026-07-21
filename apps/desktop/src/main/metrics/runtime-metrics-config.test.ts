import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeMetricsFromEnvironment,
  PHASE5_RUNTIME_METRICS_ENV,
  readRawAppBundleBytes,
  resolvePackagedRuntimeMetricsUserDataDirectory
} from './runtime-metrics-config.js';

const temporaryDirectories: string[] = [];
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('Phase 5 runtime metrics configuration', () => {
  it('reads raw ASAR bytes with virtualization disabled and restores the prior state', () => {
    const previousNoAsar = process.noAsar;
    process.noAsar = false;
    try {
      const bytes = readRawAppBundleBytes('C:\\package\\resources\\app.asar', (path) => {
        expect(path).toBe('C:\\package\\resources\\app.asar');
        expect(process.noAsar).toBe(true);
        return Buffer.from('raw-asar-bytes');
      });
      expect(bytes.toString('utf8')).toBe('raw-asar-bytes');
      expect(process.noAsar).toBe(false);
    } finally {
      process.noAsar = previousNoAsar;
    }
  });

  it('restores ASAR virtualization after a raw archive read failure', () => {
    const previousNoAsar = process.noAsar;
    process.noAsar = false;
    try {
      expect(() => readRawAppBundleBytes('C:\\package\\resources\\app.asar', () => {
        expect(process.noAsar).toBe(true);
        throw new Error('simulated archive read failure');
      })).toThrow('simulated archive read failure');
      expect(process.noAsar).toBe(false);
    } finally {
      process.noAsar = previousNoAsar;
    }
  });

  it('binds packaged metrics to the exact runner-owned temporary userData directory', async () => {
    const directory = await temporaryDirectory();
    const runRoot = join(
      directory,
      'desktop-translate-phase5-perf03-0123456789abcdef0123456789abcdef'
    );
    const userData = join(runRoot, 'User Data 阶段五-启动');
    await mkdir(userData, { recursive: true });

    expect(resolvePackagedRuntimeMetricsUserDataDirectory({
      isPackaged: true,
      commandLineUserDataDirectory: userData,
      temporaryDirectory: directory,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: userData,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
      })
    })).toBe(userData);
  });

  it.runIf(process.platform === 'win32')(
    'accepts equivalent Windows path spellings for the same runner-owned profile',
    async () => {
      const directory = await temporaryDirectory();
      const runRootName = 'desktop-translate-phase5-perf03-11111111111111111111111111111111';
      const runRoot = join(directory, runRootName);
      const userData = join(runRoot, 'User Data path-equivalence');
      await mkdir(userData, { recursive: true });
      const commandLineUserData = realpathSync.native(userData).replace(
        runRootName,
        runRootName.toUpperCase()
      );

      expect(commandLineUserData).not.toBe(userData);
      expect(resolvePackagedRuntimeMetricsUserDataDirectory({
        isPackaged: true,
        commandLineUserDataDirectory: commandLineUserData,
        temporaryDirectory: realpathSync.native(directory),
        environment: environment({
          [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: userData,
          [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
          [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
          [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
        })
      })).toBe(userData);
    }
  );

  it.runIf(hasWindowsShortTemporaryPath())(
    'accepts the Windows 8.3 temporary path when it resolves to the same profile',
    async () => {
      const shortDirectory = await temporaryDirectory();
      const runRoot = join(
        shortDirectory,
        'desktop-translate-phase5-perf03-22222222222222222222222222222222'
      );
      const shortUserData = join(runRoot, 'User Data short-path');
      await mkdir(shortUserData, { recursive: true });
      const canonicalDirectory = realpathSync.native(shortDirectory);
      const canonicalUserData = realpathSync.native(shortUserData);

      expect(canonicalDirectory.toLowerCase()).not.toBe(shortDirectory.toLowerCase());
      expect(resolvePackagedRuntimeMetricsUserDataDirectory({
        isPackaged: true,
        commandLineUserDataDirectory: canonicalUserData,
        temporaryDirectory: canonicalDirectory,
        environment: environment({
          [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: shortUserData,
          [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
          [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
          [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
        })
      })).toBe(shortUserData);
    }
  );

  it.runIf(process.platform === 'win32')(
    'rejects a profile reached through a junction even when it resolves inside the temporary root',
    async () => {
      const directory = await temporaryDirectory();
      const aliasContainer = await temporaryDirectory();
      const runRootName = 'desktop-translate-phase5-perf03-33333333333333333333333333333333';
      const userDataName = 'User Data junction';
      await mkdir(join(directory, runRootName, userDataName), { recursive: true });
      const temporaryAlias = join(aliasContainer, 'temporary-alias');
      await symlink(directory, temporaryAlias, 'junction');
      const aliasedUserData = join(temporaryAlias, runRootName, userDataName);

      expect(resolvePackagedRuntimeMetricsUserDataDirectory({
        isPackaged: true,
        commandLineUserDataDirectory: aliasedUserData,
        temporaryDirectory: directory,
        environment: environment({
          [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: aliasedUserData,
          [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
          [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
          [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
        })
      })).toBeUndefined();
    }
  );

  it('keeps ordinary packaged launches default-off and rejects arbitrary profile paths', async () => {
    const directory = await temporaryDirectory();
    const arbitrary = join(directory, 'ordinary-profile');
    await mkdir(arbitrary);

    expect(resolvePackagedRuntimeMetricsUserDataDirectory({
      isPackaged: true,
      commandLineUserDataDirectory: arbitrary,
      temporaryDirectory: directory,
      environment: {}
    })).toBeUndefined();
    expect(resolvePackagedRuntimeMetricsUserDataDirectory({
      isPackaged: true,
      commandLineUserDataDirectory: arbitrary,
      temporaryDirectory: directory,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
      })
    })).toBeUndefined();
  });

  it('rejects a runner-owned environment profile that differs from the command line profile', async () => {
    const directory = await temporaryDirectory();
    const runRoot = join(
      directory,
      'desktop-translate-phase5-perf03-fedcba9876543210fedcba9876543210'
    );
    const userData = join(runRoot, 'User Data 阶段五-启动');
    const differentUserData = join(runRoot, 'User Data 阶段五-不同');
    await mkdir(userData, { recursive: true });
    await mkdir(differentUserData, { recursive: true });

    expect(resolvePackagedRuntimeMetricsUserDataDirectory({
      isPackaged: true,
      commandLineUserDataDirectory: differentUserData,
      temporaryDirectory: directory,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: userData,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'packaged-unsigned',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
      })
    })).toBeUndefined();
  });

  it.each([
    ['non-packaged runtime', false, 'packaged-unsigned', 'real-acquisition', RUN_ID],
    ['development build mode', true, 'development', 'real-acquisition', RUN_ID],
    ['fixture measurement mode', true, 'packaged-unsigned', 'deterministic-fixture', RUN_ID],
    ['missing run id', true, 'packaged-unsigned', 'real-acquisition', undefined]
  ])('refuses benchmark userData binding for %s', async (
    _label,
    isPackaged,
    buildMode,
    measurementMode,
    runId
  ) => {
    const directory = await temporaryDirectory();
    const runRoot = join(
      directory,
      'desktop-translate-phase5-perf03-abcdef0123456789abcdef0123456789'
    );
    const userData = join(runRoot, 'User Data 阶段五-启动');
    await mkdir(userData, { recursive: true });
    expect(resolvePackagedRuntimeMetricsUserDataDirectory({
      isPackaged,
      commandLineUserDataDirectory: userData,
      temporaryDirectory: directory,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.userDataDirectory]: userData,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: buildMode,
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: measurementMode,
        [PHASE5_RUNTIME_METRICS_ENV.runId]: runId
      })
    })).toBeUndefined();
  });

  it('is completely default-off and creates no evidence directory', async () => {
    const userData = await temporaryDirectory();
    const evidenceDirectory = join(userData, 'phase5-evidence');
    expect(createRuntimeMetricsFromEnvironment({
      isPackaged: true,
      userDataDirectory: userData,
      environment: {}
    })).toBeUndefined();
    await expect(access(evidenceDirectory)).rejects.toThrow();
  });

  it('allows an explicit absolute development target with complete metadata', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'evidence', 'raw.jsonl');
    const metrics = createRuntimeMetricsFromEnvironment({
      isPackaged: false,
      userDataDirectory: directory,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.developmentFile]: output,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'development',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'instrumentation-only'
      })
    });
    expect(metrics?.enabled).toBe(true);
    const startedAt = metrics!.beginDuration();
    metrics!.recordDuration({
      metricId: 'PERF-03',
      role: 'main',
      scenario: 'host-ready',
      source: 'native-host',
      startedAt,
      status: 'success',
      characterCountBucket: 'not-applicable'
    });
    await metrics?.close();
    expect((await readFile(output, 'utf8')).trim()).toContain('"metricId":"PERF-03"');
  });

  it('forces packaged evidence into userData and ignores an arbitrary environment path', async () => {
    const directory = await temporaryDirectory();
    const userData = join(directory, 'user-data');
    const untrusted = join(directory, 'untrusted', 'raw.jsonl');
    const packaged = await packagedFixture(directory);
    const metrics = createRuntimeMetricsFromEnvironment({
      isPackaged: true,
      userDataDirectory: userData,
      ...packaged.options,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.developmentFile]: untrusted,
        [PHASE5_RUNTIME_METRICS_ENV.gitSha]: packaged.gitSha,
        [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: packaged.binarySha256,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'signed-rc',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
      })
    });
    expect(metrics?.enabled).toBe(true);
    const startedAt = metrics!.beginDuration();
    metrics!.recordDuration({
      metricId: 'PERF-06',
      role: 'main',
      scenario: 'renderer-paint-ack',
      source: 'renderer',
      startedAt,
      status: 'success',
      characterCountBucket: '1-16'
    });
    await metrics?.close();

    await expect(access(untrusted)).rejects.toThrow();
    const controlled = join(userData, 'phase5-evidence', 'perf', RUN_ID, 'raw.jsonl');
    expect((await readFile(controlled, 'utf8')).trim()).toContain('"buildMode":"signed-rc"');
    expect((await readFile(controlled, 'utf8')).trim()).toContain(
      `"binarySha256":"${packaged.binarySha256}"`
    );
  });

  it.each([
    ['missing SHA', { [PHASE5_RUNTIME_METRICS_ENV.gitSha]: undefined }],
    ['invalid SHA', { [PHASE5_RUNTIME_METRICS_ENV.gitSha]: 'invalid' }],
    ['invalid binary hash', { [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: 'invalid' }],
    ['invalid build mode', { [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'private' }],
    ['invalid measurement mode', { [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'private' }],
    ['relative dev target', { [PHASE5_RUNTIME_METRICS_ENV.developmentFile]: 'relative.jsonl' }],
    ['alternate data stream target', {
      [PHASE5_RUNTIME_METRICS_ENV.developmentFile]: 'C:\\phase5-evidence:private\\raw.jsonl'
    }]
  ])('fails closed for %s', async (_name, override) => {
    const directory = await temporaryDirectory();
    expect(createRuntimeMetricsFromEnvironment({
      isPackaged: false,
      userDataDirectory: directory,
      environment: environment(override)
    })).toBeUndefined();
  });

  it.each([
    ['mismatched binary hash', { [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: 'b'.repeat(64) }],
    ['development build', {
      [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: 'b'.repeat(64),
      [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'development'
    }],
    ['deterministic fixture mode', {
      [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'deterministic-fixture'
    }],
    ['missing run id', { [PHASE5_RUNTIME_METRICS_ENV.runId]: undefined }]
  ])('fails closed in packaged mode for %s', async (_name, override) => {
    const directory = await temporaryDirectory();
    const packaged = await packagedFixture(directory);
    expect(createRuntimeMetricsFromEnvironment({
      isPackaged: true,
      userDataDirectory: directory,
      ...packaged.options,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.gitSha]: packaged.gitSha,
        [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: packaged.binarySha256,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'signed-rc',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID,
        ...override
      })
    })).toBeUndefined();
  });

  it('refuses to append a packaged run into an existing evidence file', async () => {
    const directory = await temporaryDirectory();
    const packaged = await packagedFixture(directory);
    const output = join(directory, 'phase5-evidence', 'perf', RUN_ID, 'raw.jsonl');
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, '{"old":true}\n');

    expect(createRuntimeMetricsFromEnvironment({
      isPackaged: true,
      userDataDirectory: directory,
      ...packaged.options,
      environment: environment({
        [PHASE5_RUNTIME_METRICS_ENV.gitSha]: packaged.gitSha,
        [PHASE5_RUNTIME_METRICS_ENV.binarySha256]: packaged.binarySha256,
        [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'signed-rc',
        [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'real-acquisition',
        [PHASE5_RUNTIME_METRICS_ENV.runId]: RUN_ID
      })
    })).toBeUndefined();
    expect(await readFile(output, 'utf8')).toBe('{"old":true}\n');
  });
});

function environment(
  override: Readonly<Record<string, string | undefined>> = {}
): Record<string, string | undefined> {
  return {
    [PHASE5_RUNTIME_METRICS_ENV.enabled]: '1',
    [PHASE5_RUNTIME_METRICS_ENV.developmentFile]: 'C:\\phase5-evidence\\raw.jsonl',
    [PHASE5_RUNTIME_METRICS_ENV.gitSha]: 'a'.repeat(40),
    [PHASE5_RUNTIME_METRICS_ENV.buildMode]: 'development',
    [PHASE5_RUNTIME_METRICS_ENV.measurementMode]: 'instrumentation-only',
    ...override
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-translate-phase5-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

function hasWindowsShortTemporaryPath(): boolean {
  return process.platform === 'win32'
    && realpathSync.native(tmpdir()).toLowerCase() !== tmpdir().toLowerCase();
}

async function packagedFixture(directory: string): Promise<{
  readonly options: { readonly resourcesDirectory: string; readonly appBundlePath: string };
  readonly gitSha: string;
  readonly binarySha256: string;
}> {
  const resourcesDirectory = join(directory, 'resources');
  const manifestDirectory = join(resourcesDirectory, 'manifest');
  const appBundlePath = join(resourcesDirectory, 'app.asar');
  const gitSha = 'c'.repeat(40);
  const bundle = Buffer.from('phase5-packaged-app');
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    join(manifestDirectory, 'component-manifest.json'),
    JSON.stringify({ schemaVersion: 1, gitSha })
  );
  await writeFile(appBundlePath, bundle);
  return {
    options: { resourcesDirectory, appBundlePath },
    gitSha,
    binarySha256: createHash('sha256').update(bundle).digest('hex')
  };
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { arch, cpus, platform, release } from 'node:os';
import { basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BERGAMOT_MEASUREMENT_SCHEMA_VERSION,
  DEFAULT_BERGAMOT_MANIFEST_PATH,
  DEFAULT_BERGAMOT_RUNTIME_ROOT,
  DEFAULT_BERGAMOT_SUPPLY_ROOT,
  bergamotManifestSha256,
  loadBergamotManifest,
  materializeBergamotRuntime,
  selectBergamotCandidates,
  verifyBergamotAuthorization,
  verifyBergamotSupply
} from './bergamot-lib.mjs';
import { latencySummary, sampleSummary } from './bergamot-benchmark-worker.mjs';
import {
  parseBergamotRuntimeSpikeArguments,
  runBergamotRuntimeSpike
} from './bergamot-runtime-spike.mjs';
import {
  DEFAULT_FIXTURE_PATH,
  POC_RESEARCH_SCOPE,
  PocError,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';
import { evaluateGateAInputCompleteness } from './gate-a-completeness.mjs';

const SCRIPT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const BENCHMARK_WORKER = resolve(SCRIPT_ROOT, 'bergamot-benchmark-worker.mjs');
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

const HELP = `Phase 7 Firefox/Bergamot bidirectional local benchmark

Runs with zero network after verified artifacts are prepared:
  node tooling/phase7-offline-poc/bergamot-benchmark.mjs \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json \\
    --output artifacts/phase7/offline-poc/measurements/bergamot-bidirectional.json

Metrics: WASM cold start, first translation (including model load), warm p50/p95,
RSS memory, character n-gram fixture score, and exact digit/URL/placeholder
preservation. Source, reference, and translated text are never emitted.

The unmodified official npm package is probed first. If it cannot initialize,
the command records BLOCKED_RUNTIME_COMPATIBILITY and does not patch the package.
`;

export async function runBergamotBenchmark(options) {
  const manifest = await loadBergamotManifest(options.manifestPath);
  const candidates = selectBergamotCandidates(manifest, options);
  if (!options.pocAuthorizationPath) {
    throw new PocError('BERGAMOT_POC_AUTHORIZATION_REQUIRED_FOR_BENCHMARK');
  }
  const authorization = await loadJson(options.pocAuthorizationPath);
  verifyBergamotAuthorization(
    authorization,
    manifest,
    candidates.map((candidate) => candidate.id)
  );
  const supply = await verifyBergamotSupply(manifest, candidates, {
    includeModels: true,
    supplyRoot: options.supplyRoot
  });
  const materialized = await materializeBergamotRuntime(manifest, {
    supplyRoot: options.supplyRoot,
    runtimeRoot: options.runtimeRoot
  });
  const { samples, bytes: fixtureBytes } = await loadQualityFixture(options.fixturePath);

  const spikeOptions = {
    ...parseBergamotRuntimeSpikeArguments([]),
    candidateId: options.candidateId,
    candidateSetId: options.candidateSetId,
    manifestPath: options.manifestPath,
    outputPath: null,
    pocAuthorizationPath: options.pocAuthorizationPath,
    probeTimeoutMs: options.probeTimeoutMs,
    runtimeRoot: options.runtimeRoot,
    supplyRoot: options.supplyRoot
  };
  const runtimeSpike = await runBergamotRuntimeSpike(spikeOptions);
  let hardKillCount = 0;
  let routeResults;
  if (runtimeSpike.probe.status !== 'READY') {
    routeResults = candidates.map((candidate) => emptyBlockedRoute(
      `${candidate.route.source}-${candidate.route.target}`,
      runtimeSpike.probe.blockerCode
    ));
  } else {
    routeResults = [];
    for (const candidate of candidates) {
      const direction = `${candidate.route.source}-${candidate.route.target}`;
      const routeSamples = samples.filter((sample) => sample.direction === direction);
      if (routeSamples.length < 1) {
        throw new PocError('BERGAMOT_FIXTURE_ROUTE_MISSING');
      }
      const result = await executeRouteWorker({
        direction,
        source: candidate.route.source,
        target: candidate.route.target,
        packageRoot: materialized.packageRoot,
        supplyRoot: resolve(options.supplyRoot),
        models: [{
          source: candidate.route.source,
          target: candidate.route.target,
          files: candidate.sourceFiles.map((file) => ({
            compression: file.compression,
            localPath: file.localPath,
            runtimePart: file.runtimePart
          }))
        }],
        samples: routeSamples,
        iterations: options.iterations,
        runtimeProbeTimeoutMs: options.probeTimeoutMs
      }, options.routeTimeoutMs);
      hardKillCount += result.hardKilled ? 1 : 0;
      routeResults.push(result.route);
    }
  }

  const report = buildBergamotMeasurement({
    manifest,
    candidates,
    supply,
    fixtureBytes,
    samples,
    runtimeSpike,
    routes: routeResults,
    routeTimeoutMs: options.routeTimeoutMs,
    probeTimeoutMs: options.probeTimeoutMs,
    hardKillCount
  });
  assertBergamotMeasurementPrivacy(report, samples);
  if (options.outputPath) {
    await writeJsonArtifact(resolveArtifactOutput(options.outputPath), report);
  }
  return report;
}

export function buildBergamotMeasurement({
  manifest,
  candidates,
  supply,
  fixtureBytes,
  runtimeSpike,
  routes,
  routeTimeoutMs,
  probeTimeoutMs,
  hardKillCount
}) {
  const measured = routes.every((route) => route.status === 'MEASURED');
  const status = measured
    ? 'PARTIAL_M4_MEASUREMENT'
    : runtimeSpike.probe.status === 'BLOCKED'
      ? 'BLOCKED_RUNTIME_COMPATIBILITY'
      : 'BLOCKED_SUPPLY_ARTIFACTS';
  const emittedRoutes = routes.map((route) => ({
    direction: route.direction,
    status: route.status,
    blockerCode: route.blockerCode,
    coldStartMs: route.coldStartMs,
    firstTranslationMs: route.firstTranslationMs,
    warmLatency: route.warmLatency,
    memory: route.memory,
    quality: route.quality,
    samples: route.samples
  }));
  const gateACompleteness = evaluateGateAInputCompleteness({
    directions: emittedRoutes.map((route) => route.direction),
    candidateIdentityComplete: false,
    artifactSizingComplete: false,
    rawResultsAttached: false,
    routes: Object.fromEntries(emittedRoutes.map((route) => [
      route.direction,
      {
        cold: {
          freshProcessPerTrial: true,
          n: route.firstTranslationMs === null ? 0 : 1,
          p50Ms: route.firstTranslationMs,
          p95Ms: route.firstTranslationMs,
          maxMs: route.firstTranslationMs,
          failureCount: route.status === 'MEASURED' ? 0 : 1
        },
        warm: {
          ...route.warmLatency,
          failureCount: route.status === 'MEASURED' ? 0 : 1
        },
        blindEvaluation: {
          blind: false,
          humanReviewed: false,
          sampleCount: 0,
          rawScoresRecorded: false,
          severeErrorClassificationRecorded: false
        }
      }
    ])),
    windowsPrivateWorkingSet: {
      metric: 'RSS',
      measured: false,
      peakBytes: 0,
      sampleCount: 0,
      tool: '',
      device: ''
    }
  });
  return {
    schemaVersion: BERGAMOT_MEASUREMENT_SCHEMA_VERSION,
    status,
    measuredAt: new Date().toISOString(),
    scope: POC_RESEARCH_SCOPE,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      sha256: bergamotManifestSha256(manifest),
      candidateIds: candidates.map((candidate) => candidate.id).sort()
    },
    runtime: {
      packageName: manifest.runtime.packageName,
      version: manifest.runtime.version,
      sourceCommit: manifest.runtime.sourceCommit,
      tarballSha256: manifest.runtime.tarball.sha256,
      tarballIntegrity: manifest.runtime.tarball.integrity,
      installScriptsExecuted: false,
      packageMutated: false,
      probe: {
        status: runtimeSpike.probe.status,
        blockerCode: runtimeSpike.probe.blockerCode,
        importMs: runtimeSpike.probe.importMs,
        wasmInitMs: runtimeSpike.probe.wasmInitMs,
        rawErrorEmitted: false
      }
    },
    environment: {
      os: `${platform()} ${release()}`,
      architecture: arch(),
      node: process.version,
      logicalCpuCount: cpus().length
    },
    networkIsolation: {
      mode: 'PROCESS_LEVEL_OFFLINE_GUARD',
      offlineEnvironment: true,
      mainThreadSocketGuard: true,
      attemptedCalls: runtimeSpike.networkIsolation.attemptedCalls
        + routes.reduce((sum, route) => sum + (route.attemptedNetworkCalls ?? 0), 0),
      externalNetworkAccess: 'NOT_VERIFIED',
      osFirewallVerified: false
    },
    artifacts: {
      verifiedFileCount: supply.fileCount,
      verifiedCompressedBytes: supply.totalBytes,
      supplyTreeSha256: supply.treeSha256,
      fixtureBytes: fixtureBytes.length,
      fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex')
    },
    routes: emittedRoutes,
    quality: {
      metric: 'CHARACTER_NGRAM_F1_V1',
      sampleCount: measured
        ? emittedRoutes.reduce((sum, route) => sum + route.samples.length, 0)
        : 0,
      humanReviewStatus: 'NOT_PERFORMED',
      rawTextEmitted: false
    },
    gateACompleteness,
    timeouts: {
      runtimeProbeBudgetMs: probeTimeoutMs,
      routeBudgetMs: routeTimeoutMs,
      hardKillCount
    },
    limitations: [
      'The official npm package is executed unmodified; no omitted package file or Windows file-URL behavior is patched.',
      'Process-level network guards are not independent OS firewall or packet-capture evidence.',
      'Quality uses a small synthetic fixture and has no bilingual human review.',
      'M0 POC research authorization does not authorize product integration, packaging, redistribution, or commercial use.',
      'The repository-root MPL-2.0 evidence does not replace legal review of model-weight scope and training-data provenance.'
    ]
  };
}

async function executeRouteWorker(config, timeoutMs) {
  return new Promise((resolveResult) => {
    const environment = {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      NO_PROXY: '',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      npm_config_audit: 'false',
      npm_config_offline: 'true'
    };
    const child = spawn(process.execPath, [BENCHMARK_WORKER], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let exceededBuffer = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        exceededBuffer = true;
        child.kill();
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdin.end(JSON.stringify(config));
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      const hardKilled = signal !== null || exceededBuffer;
      if (hardKilled) {
        resolveResult({
          hardKilled: true,
          route: emptyTimedOutRoute(config.direction)
        });
        return;
      }
      try {
        const route = JSON.parse(stdout);
        if (!validRouteWorkerResult(route, config.direction)) {
          throw new Error('INVALID_ROUTE_RESULT');
        }
        resolveResult({ hardKilled: false, route });
      } catch {
        resolveResult({
          hardKilled: false,
          route: emptyBlockedRoute(
            config.direction,
            'BERGAMOT_BENCHMARK_WORKER_INVALID_RESULT'
          )
        });
      }
    });
  });
}

function validRouteWorkerResult(route, direction) {
  return route !== null
    && typeof route === 'object'
    && route.direction === direction
    && ['MEASURED', 'BLOCKED_RUNTIME'].includes(route.status)
    && (route.blockerCode === null || /^[A-Z0-9_]+$/u.test(route.blockerCode))
    && route.rawTextEmitted === false
    && Number.isSafeInteger(route.attemptedNetworkCalls)
    && route.attemptedNetworkCalls >= 0;
}

function emptyBlockedRoute(direction, blockerCode) {
  return {
    direction,
    status: 'BLOCKED_RUNTIME',
    blockerCode,
    coldStartMs: null,
    firstTranslationMs: null,
    warmLatency: latencySummary([]),
    memory: {
      rssBeforeBytes: 0,
      rssAfterLoadBytes: 0,
      peakRssBytes: 0
    },
    quality: {
      characterNgramF1: null,
      digitsPreservedRate: 0,
      urlsPreservedRate: 0,
      placeholdersPreservedRate: 0,
      nonEmptyRate: 0
    },
    samples: [],
    attemptedNetworkCalls: 0,
    rawTextEmitted: false
  };
}

function emptyTimedOutRoute(direction) {
  return {
    ...emptyBlockedRoute(direction, 'BERGAMOT_ROUTE_HARD_TIMEOUT'),
    status: 'TIMEOUT'
  };
}

export async function loadQualityFixture(path = DEFAULT_FIXTURE_PATH) {
  const bytes = await readFile(path);
  const lines = bytes.toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const samples = lines.map((line) => JSON.parse(line));
  const ids = new Set();
  for (const sample of samples) {
    if (!sample
        || typeof sample.id !== 'string'
        || ids.has(sample.id)
        || !['en-zh', 'zh-en'].includes(sample.direction)
        || typeof sample.source !== 'string'
        || sample.source.length < 1
        || typeof sample.reference !== 'string'
        || sample.reference.length < 1
        || !Array.isArray(sample.tags)) {
      throw new PocError('BERGAMOT_QUALITY_FIXTURE_INVALID');
    }
    ids.add(sample.id);
  }
  if (!['en-zh', 'zh-en'].every(
    (direction) => samples.some((sample) => sample.direction === direction)
  )) {
    throw new PocError('BERGAMOT_QUALITY_FIXTURE_NOT_BIDIRECTIONAL');
  }
  return { samples, bytes };
}

export function assertBergamotMeasurementPrivacy(report, samples) {
  const serialized = JSON.stringify(report);
  for (const sample of samples) {
    for (const text of [sample.source, sample.reference]) {
      if (text.length >= 8 && serialized.includes(text)) {
        throw new PocError('BERGAMOT_RAW_FIXTURE_TEXT_LEAKED_TO_MEASUREMENT');
      }
    }
  }
  const forbiddenKeys = [
    '"sourceText"',
    '"targetText"',
    '"translatedText"',
    '"translation"',
    '"absolutePath"',
    '"stderr"',
    '"stack"'
  ];
  if (forbiddenKeys.some((key) => serialized.includes(key))) {
    throw new PocError('BERGAMOT_MEASUREMENT_FORBIDDEN_FIELD');
  }
  const homeName = basename(process.env.USERPROFILE ?? '');
  if (homeName && serialized.toLowerCase().includes(homeName.toLowerCase())) {
    throw new PocError('BERGAMOT_MEASUREMENT_LOCAL_IDENTITY_LEAKED');
  }
}

export async function runBergamotBenchmarkSelfTest() {
  const manifest = await loadBergamotManifest();
  const candidates = selectBergamotCandidates(manifest, {});
  const { samples, bytes } = await loadQualityFixture();
  const selectedSamples = samples.slice(0, 2);
  const summaries = selectedSamples.map((sample) => sampleSummary(sample, sample.reference));
  const fakeRoute = {
    direction: 'en-zh',
    status: 'STATIC_FIXTURE_ONLY',
    blockerCode: null,
    coldStartMs: 10,
    firstTranslationMs: 20,
    warmLatency: latencySummary([1, 2, 3, 4]),
    memory: {
      rssBeforeBytes: 1,
      rssAfterLoadBytes: 2,
      peakRssBytes: 3
    },
    quality: {
      characterNgramF1: 1,
      digitsPreservedRate: 1,
      urlsPreservedRate: 1,
      placeholdersPreservedRate: 1,
      nonEmptyRate: 1
    },
    samples: summaries,
    attemptedNetworkCalls: 0,
    rawTextEmitted: false
  };
  const runtimeSpike = {
    probe: {
      status: 'STATIC_FIXTURE_ONLY',
      blockerCode: null,
      importMs: 1,
      wasmInitMs: 2
    },
    networkIsolation: {
      attemptedCalls: 0
    }
  };
  const report = buildBergamotMeasurement({
    manifest,
    candidates,
    supply: {
      fileCount: 12,
      totalBytes: 1,
      treeSha256: '0'.repeat(64)
    },
    fixtureBytes: bytes,
    samples,
    runtimeSpike,
    routes: [
      fakeRoute,
      {
        ...fakeRoute,
        direction: 'zh-en',
        samples: []
      }
    ],
    routeTimeoutMs: 1000,
    probeTimeoutMs: 500,
    hardKillCount: 0
  });
  report.status = 'NO_MODEL_STATIC_SELF_TEST_PASS';
  assertBergamotMeasurementPrivacy(report, samples);
  return report;
}

export function parseBergamotBenchmarkArguments(args) {
  const options = {
    candidateId: null,
    candidateSetId: null,
    fixturePath: DEFAULT_FIXTURE_PATH,
    help: false,
    iterations: null,
    manifestPath: DEFAULT_BERGAMOT_MANIFEST_PATH,
    outputPath: null,
    pocAuthorizationPath: null,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    routeTimeoutMs: null,
    runtimeRoot: DEFAULT_BERGAMOT_RUNTIME_ROOT,
    selfTest: false,
    supplyRoot: DEFAULT_BERGAMOT_SUPPLY_ROOT
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--candidate') {
      options.candidateId = requireValue(args, ++index, argument);
    } else if (argument === '--candidate-set') {
      options.candidateSetId = requireValue(args, ++index, argument);
    } else if (argument === '--fixture') {
      options.fixturePath = requireValue(args, ++index, argument);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--iterations') {
      options.iterations = parseBoundedInteger(
        requireValue(args, ++index, argument),
        1,
        100,
        'BERGAMOT_BENCHMARK_ITERATIONS_INVALID'
      );
    } else if (argument === '--manifest') {
      options.manifestPath = requireValue(args, ++index, argument);
    } else if (argument === '--output') {
      options.outputPath = requireValue(args, ++index, argument);
    } else if (argument === '--poc-authorization') {
      options.pocAuthorizationPath = requireValue(args, ++index, argument);
    } else if (argument === '--probe-timeout-ms') {
      options.probeTimeoutMs = parseBoundedInteger(
        requireValue(args, ++index, argument),
        100,
        60_000,
        'BERGAMOT_RUNTIME_PROBE_TIMEOUT_INVALID'
      );
    } else if (argument === '--route-timeout-ms') {
      options.routeTimeoutMs = parseBoundedInteger(
        requireValue(args, ++index, argument),
        1_000,
        3_600_000,
        'BERGAMOT_ROUTE_TIMEOUT_INVALID'
      );
    } else if (argument === '--runtime-root') {
      options.runtimeRoot = requireValue(args, ++index, argument);
    } else if (argument === '--self-test') {
      options.selfTest = true;
    } else if (argument === '--supply-root') {
      options.supplyRoot = requireValue(args, ++index, argument);
    } else {
      throw new PocError('UNKNOWN_BERGAMOT_BENCHMARK_ARGUMENT');
    }
  }
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('BERGAMOT_CANDIDATE_AND_SET_MUTUALLY_EXCLUSIVE');
  }
  return options;
}

function parseBoundedInteger(value, minimum, maximum, errorCode) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PocError(errorCode);
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(`MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

async function runCli() {
  const options = parseBergamotBenchmarkArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.selfTest) {
    const report = await runBergamotBenchmarkSelfTest();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const manifest = await loadBergamotManifest(options.manifestPath);
  options.iterations ??= manifest.policy.benchmarkWarmIterations;
  options.routeTimeoutMs ??= manifest.policy.benchmarkRouteTimeoutMs;
  const report = await runBergamotBenchmark(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function directInvocation() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (directInvocation()) {
  runCli().catch((error) => {
    const code = error instanceof PocError
      ? error.code
      : 'UNEXPECTED_BERGAMOT_BENCHMARK_FAILURE';
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      errorCode: code,
      rawPathsEmitted: false,
      rawTextEmitted: false
    })}\n`);
    process.exitCode = 1;
  });
}

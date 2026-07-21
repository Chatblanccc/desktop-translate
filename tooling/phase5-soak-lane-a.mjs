import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import {
  assertAttestedIdentityUnchanged,
  resolveAttestedArtifactIdentity
} from './phase5-lane-a-identity.mjs';
import {
  DEFAULT_FAULT_INTERVAL_MS,
  DEFAULT_LIFECYCLE_INTERVAL_MS,
  DEFAULT_SELECTION_INTERVAL_MS,
  EIGHT_HOURS_MS,
  qualifyFullSchedule
} from './phase5-lane-a-policy.mjs';

const SCHEMA_VERSION = '1.0.0';

const ACQUISITION_SEQUENCE = Object.freeze([
  'simulated-uia-result',
  'simulated-uia-result',
  'simulated-ocr-result',
  'simulated-uia-result',
  'simulated-uia-result',
  'simulated-ocr-result',
  'simulated-uia-result',
  'simulated-uia-result',
  'simulated-ocr-result',
  'simulated-uia-result'
]);

const TRANSLATION_SEQUENCE = Object.freeze([
  'source-only', 'success', 'success', 'recoverable-failure-manual-retry', 'success',
  'source-only', 'success', 'success', 'non-recoverable-failure', 'success',
  'source-only', 'success', 'recoverable-failure-manual-retry', 'success', 'success',
  'source-only', 'success', 'success', 'recoverable-failure-manual-retry', 'success'
]);

const FAULT_SEQUENCE = Object.freeze([
  'PIPE_DISCONNECT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_MALFORMED_RESPONSE',
  'CREDENTIAL_DELETE_RESTORE',
  'CREDENTIAL_REPLACE',
  'TRANSLATION_DISABLE_ENABLE',
  'DISPLAY_CHANGE',
  'SHUTDOWN_RACE'
]);

const LIFECYCLE_SEQUENCE = Object.freeze([
  'CARD_DISMISS',
  'PAUSE_RESUME',
  'SETTINGS_OPEN_CLOSE'
]);

const options = parseArguments(process.argv.slice(2));
const durationMs = options.durationMs;
const fullScheduleRequested = options.fullSchedule;
assertConfiguration(options);

const outputRoot = resolve(options.outputRoot);
const eventPath = resolve(outputRoot, 'events.jsonl');
const summaryPath = resolve(outputRoot, 'summary.json');
if (await lstat(outputRoot).catch(() => undefined)) {
  throw new Error(`Lane A output root must not already exist: ${outputRoot}`);
}
await mkdir(dirname(outputRoot), { recursive: true });
await mkdir(outputRoot);
const identity = await resolveArtifactIdentity(options);

const startedAt = performance.now();
const events = [];
const counters = {
  selections: 0,
  faultsInjected: 0,
  faultsRecovered: 0,
  lifecycleExercises: 0,
  invariantFailures: 0,
  maxSchedulingDelayMs: 0,
  acquisition: Object.fromEntries(ACQUISITION_SEQUENCE.map((value) => [value, 0])),
  translation: Object.fromEntries(TRANSLATION_SEQUENCE.map((value) => [value, 0])),
  fault: Object.fromEntries(FAULT_SEQUENCE.map((value) => [value, 0])),
  lifecycle: Object.fromEntries(LIFECYCLE_SEQUENCE.map((value) => [value, 0]))
};

let nextSelectionAt = 0;
let nextFaultAt = options.faultIntervalMs;
let nextLifecycleAt = options.lifecycleIntervalMs;
let sequence = 0;

appendEvent('run-start', 0, {
  qualification: fullScheduleRequested ? 'full-schedule-requested' : 'smoke-or-development'
});

while (true) {
  const elapsedMs = performance.now() - startedAt;

  while (nextSelectionAt <= elapsedMs && nextSelectionAt < durationMs) {
    emitSelection(nextSelectionAt);
    nextSelectionAt += options.selectionIntervalMs;
  }
  while (nextFaultAt <= elapsedMs && nextFaultAt < durationMs) {
    emitFault(nextFaultAt);
    nextFaultAt += options.faultIntervalMs;
  }
  while (nextLifecycleAt <= elapsedMs && nextLifecycleAt < durationMs) {
    emitLifecycle(nextLifecycleAt);
    nextLifecycleAt += options.lifecycleIntervalMs;
  }

  // Process every event scheduled before the configured end before deciding
  // that the run is complete. A sleeping machine therefore records a large
  // scheduling delay and fails closed instead of skipping most of the plan.
  if (elapsedMs >= durationMs) break;

  const nextDue = Math.min(nextSelectionAt, nextFaultAt, nextLifecycleAt, durationMs);
  const waitMs = Math.max(1, Math.min(250, nextDue - (performance.now() - startedAt)));
  await delay(waitMs);
}

const actualDurationMs = Math.round(performance.now() - startedAt);
if (fullScheduleRequested) {
  await assertAttestedIdentityUnchanged(options, identity, resolve(import.meta.dirname, '..'));
}
const acquisitionTotal = sumValues(counters.acquisition);
const translationTotal = sumValues(counters.translation);
if (acquisitionTotal !== counters.selections) counters.invariantFailures += 1;
if (translationTotal !== counters.selections) counters.invariantFailures += 1;
appendEvent('run-end', actualDurationMs, {
  qualification: fullScheduleRequested ? 'full-schedule-requested' : 'smoke-or-development'
});

const { fullScheduleComplete, status } = qualifyFullSchedule({
  requested: fullScheduleRequested,
  durationMs,
  actualDurationMs,
  intervals: {
    selection: options.selectionIntervalMs,
    fault: options.faultIntervalMs,
    lifecycle: options.lifecycleIntervalMs
  },
  identityVerified: identity.verified,
  counters
});

const summary = {
  schemaVersion: SCHEMA_VERSION,
  lane: 'A',
  scope: 'deterministic-orchestration-harness',
  acquisitionEvidence: 'simulated-result-consumption-only',
  nativeEvidence: 'not-real-native-acquisition',
  providerEvidence: 'fake-provider-schedule-only',
  status,
  acceptance: false,
  fullScheduleComplete,
  durationMs: actualDurationMs,
  configuredDurationMs: durationMs,
  intervalsMs: {
    selection: options.selectionIntervalMs,
    fault: options.faultIntervalMs,
    lifecycle: options.lifecycleIntervalMs
  },
  identity: {
    gitSha: options.gitSha,
    source: identity.source,
    repository: identity.repository,
    sourceRef: identity.sourceRef,
    signerWorkflow: identity.signerWorkflow,
    lockfileSha256: identity.lockfileSha256,
    testArtifact: identity.testArtifact,
    releaseArtifact: identity.releaseArtifact,
    testBuildManifestSha256: identity.testBuildManifestSha256,
    releaseBuildManifestSha256: identity.releaseBuildManifestSha256,
    trustedRootSha256: identity.trustedRootSha256,
    buildDifferenceId: options.buildDifferenceId
  },
  counts: counters,
  distributions: {
    acquisition: ratios(counters.acquisition, counters.selections),
    translation: ratios(counters.translation, counters.selections)
  },
  assertions: {
    noSensitivePayloadPersistedByHarness: true,
    acquisitionAndTranslationDistributionsAreIndependent: false,
    distributionIndependenceNotClaimed: true,
    realNativeLaneBExecuted: false,
    productProcessExercised: false,
    resourceGateExecuted: false,
    residualProcessGateExecuted: false,
    privacyGateExecuted: false
  }
};

await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  phase: 5,
  lane: 'A',
  status,
  durationMs: actualDurationMs,
  selections: counters.selections,
  faultsInjected: counters.faultsInjected
}));

if (status === 'FAIL') process.exitCode = 1;

function emitSelection(elapsedMs) {
  const schedulingDelayMs = recordSchedulingDelay(elapsedMs);
  const index = counters.selections;
  const acquisition = ACQUISITION_SEQUENCE[(index + options.seed) % ACQUISITION_SEQUENCE.length];
  const translation = TRANSLATION_SEQUENCE[(index + options.seed) % TRANSLATION_SEQUENCE.length];
  counters.selections += 1;
  counters.acquisition[acquisition] += 1;
  counters.translation[translation] += 1;
  appendEvent('selection-cycle', elapsedMs, {
    sampleId: `sample-${String(counters.selections).padStart(6, '0')}`,
    schedulingDelayMs,
    acquisition,
    translation,
    outcome: translation === 'recoverable-failure-manual-retry'
      ? 'recovered-after-manual-retry'
      : translation === 'non-recoverable-failure'
        ? 'stable-source-only-degradation'
        : 'completed'
  });
}

function emitFault(elapsedMs) {
  const schedulingDelayMs = recordSchedulingDelay(elapsedMs);
  const fault = FAULT_SEQUENCE[(counters.faultsInjected + options.seed) % FAULT_SEQUENCE.length];
  counters.faultsInjected += 1;
  counters.fault[fault] += 1;
  const recovered = fault !== 'SHUTDOWN_RACE' || elapsedMs + options.selectionIntervalMs < durationMs;
  if (recovered) counters.faultsRecovered += 1;
  appendEvent('fault-cycle', elapsedMs, {
    faultCode: fault,
    schedulingDelayMs,
    outcome: recovered ? 'recovered-in-harness-model' : 'ended-during-controlled-shutdown'
  });
}

function emitLifecycle(elapsedMs) {
  const schedulingDelayMs = recordSchedulingDelay(elapsedMs);
  const lifecycle = LIFECYCLE_SEQUENCE[
    (counters.lifecycleExercises + options.seed) % LIFECYCLE_SEQUENCE.length
  ];
  counters.lifecycleExercises += 1;
  counters.lifecycle[lifecycle] += 1;
  appendEvent('lifecycle-cycle', elapsedMs, {
    lifecycleCode: lifecycle,
    schedulingDelayMs,
    outcome: 'completed-in-harness-model'
  });
}

function appendEvent(kind, elapsedMs, fields) {
  sequence += 1;
  events.push({
    schemaVersion: SCHEMA_VERSION,
    sequence,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    kind,
    ...fields
  });
}

function ratios(values, total) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    total === 0 ? 0 : Number((value / total).toFixed(6))
  ]));
}

function sumValues(values) {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function recordSchedulingDelay(scheduledElapsedMs) {
  const delayMs = Math.max(0, Math.round(performance.now() - startedAt - scheduledElapsedMs));
  counters.maxSchedulingDelayMs = Math.max(counters.maxSchedulingDelayMs, delayMs);
  return delayMs;
}

function parseArguments(args) {
  const values = new Map();
  const flags = new Set();
  const allowedValues = new Set([
    '--duration-hours',
    '--duration-seconds',
    '--selection-interval-ms',
    '--fault-interval-ms',
    '--lifecycle-interval-ms',
    '--output-root',
    '--seed',
    '--git-sha',
    '--test-artifact-path',
    '--release-artifact-path',
    '--test-build-manifest-path',
    '--release-build-manifest-path',
    '--test-attestation-bundle-path',
    '--release-attestation-bundle-path',
    '--trusted-root-path',
    '--repository',
    '--source-ref',
    '--signer-workflow',
    '--build-difference-id'
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected positional argument: ${argument}`);
    if (argument === '--full-schedule') {
      flags.add(argument);
      continue;
    }
    if (!allowedValues.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const durationHours = numberValue(values, '--duration-hours');
  const durationSeconds = numberValue(values, '--duration-seconds');
  if (durationHours !== undefined && durationSeconds !== undefined) {
    throw new Error('Use only one of --duration-hours or --duration-seconds.');
  }
  return {
    durationMs: durationHours !== undefined
      ? durationHours * 60 * 60 * 1_000
      : (durationSeconds ?? 8 * 60 * 60) * 1_000,
    selectionIntervalMs: numberValue(values, '--selection-interval-ms') ?? DEFAULT_SELECTION_INTERVAL_MS,
    faultIntervalMs: numberValue(values, '--fault-interval-ms') ?? DEFAULT_FAULT_INTERVAL_MS,
    lifecycleIntervalMs: numberValue(values, '--lifecycle-interval-ms') ?? DEFAULT_LIFECYCLE_INTERVAL_MS,
    outputRoot: values.get('--output-root') ?? 'artifacts/phase5/local/lane-a',
    seed: numberValue(values, '--seed') ?? 0,
    gitSha: values.get('--git-sha') ?? 'UNBOUND',
    testArtifactPath: values.get('--test-artifact-path'),
    releaseArtifactPath: values.get('--release-artifact-path'),
    testBuildManifestPath: values.get('--test-build-manifest-path'),
    releaseBuildManifestPath: values.get('--release-build-manifest-path'),
    testAttestationBundlePath: values.get('--test-attestation-bundle-path'),
    releaseAttestationBundlePath: values.get('--release-attestation-bundle-path'),
    trustedRootPath: values.get('--trusted-root-path'),
    repository: values.get('--repository'),
    sourceRef: values.get('--source-ref'),
    signerWorkflow: values.get('--signer-workflow'),
    buildDifferenceId: values.get('--build-difference-id') ?? 'UNBOUND',
    fullSchedule: flags.has('--full-schedule')
  };
}

function numberValue(values, name) {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

function assertConfiguration(configuration) {
  for (const [name, value] of [
    ['duration', configuration.durationMs],
    ['selection interval', configuration.selectionIntervalMs],
    ['fault interval', configuration.faultIntervalMs],
    ['lifecycle interval', configuration.lifecycleIntervalMs]
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }
  if (!Number.isInteger(configuration.seed) || configuration.seed < 0) {
    throw new Error('--seed must be a non-negative integer.');
  }
  if (!configuration.fullSchedule) return;
  if (configuration.durationMs !== EIGHT_HOURS_MS) {
    throw new Error('--full-schedule requires the frozen 8-hour duration.');
  }
  if (configuration.selectionIntervalMs !== DEFAULT_SELECTION_INTERVAL_MS) {
    throw new Error('--full-schedule requires the 30000 ms selection interval.');
  }
  if (configuration.faultIntervalMs !== DEFAULT_FAULT_INTERVAL_MS) {
    throw new Error('--full-schedule requires the 30-minute fault interval.');
  }
  if (configuration.lifecycleIntervalMs !== DEFAULT_LIFECYCLE_INTERVAL_MS) {
    throw new Error('--full-schedule requires the 2-hour lifecycle interval.');
  }
  if (!/^[a-f0-9]{40}$/u.test(configuration.gitSha)) {
    throw new Error('--full-schedule requires --git-sha as 40 lowercase hex characters.');
  }
  for (const [name, value] of [
    ['--test-artifact-path', configuration.testArtifactPath],
    ['--release-artifact-path', configuration.releaseArtifactPath],
    ['--test-build-manifest-path', configuration.testBuildManifestPath],
    ['--release-build-manifest-path', configuration.releaseBuildManifestPath],
    ['--test-attestation-bundle-path', configuration.testAttestationBundlePath],
    ['--release-attestation-bundle-path', configuration.releaseAttestationBundlePath],
    ['--trusted-root-path', configuration.trustedRootPath],
    ['--repository', configuration.repository],
    ['--source-ref', configuration.sourceRef],
    ['--signer-workflow', configuration.signerWorkflow]
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`--full-schedule requires ${name}; hashes are computed from actual bytes.`);
    }
  }
  if (!/^[A-Z0-9][A-Z0-9._-]{2,63}$/u.test(configuration.buildDifferenceId)) {
    throw new Error('--full-schedule requires a stable --build-difference-id.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(configuration.repository)) {
    throw new Error('--repository must be an owner/repository identifier.');
  }
  if (!configuration.sourceRef.startsWith('refs/')) {
    throw new Error('--source-ref must be a full Git ref.');
  }
  if (!configuration.signerWorkflow.startsWith(`${configuration.repository}/.github/workflows/`)) {
    throw new Error('--signer-workflow must belong to the expected repository workflow path.');
  }
}

async function resolveArtifactIdentity(configuration) {
  if (!configuration.fullSchedule) {
    return {
      verified: false,
      source: 'UNBOUND_DEVELOPMENT_SMOKE',
      repository: 'UNBOUND',
      sourceRef: 'UNBOUND',
      signerWorkflow: 'UNBOUND',
      lockfileSha256: 'UNBOUND',
      testArtifact: { name: 'UNBOUND', size: 0, sha256: 'UNBOUND' },
      releaseArtifact: { name: 'UNBOUND', size: 0, sha256: 'UNBOUND' },
      testBuildManifestSha256: 'UNBOUND',
      releaseBuildManifestSha256: 'UNBOUND',
      trustedRootSha256: 'UNBOUND'
    };
  }
  return resolveAttestedArtifactIdentity(configuration, resolve(import.meta.dirname, '..'));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

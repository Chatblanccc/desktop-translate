import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertAttestedIdentityUnchanged,
  resolveAttestedArtifactIdentity
} from './phase5-lane-a-identity.mjs';
import {
  currentRuntimeControlBlockers,
  PRODUCT_LANE_A_REQUIRED_ASSERTIONS,
  qualifyProductLaneA
} from './phase5-lane-a-product-policy.mjs';
import {
  DEFAULT_FAULT_INTERVAL_MS,
  DEFAULT_LIFECYCLE_INTERVAL_MS,
  DEFAULT_SELECTION_INTERVAL_MS,
  EIGHT_HOURS_MS
} from './phase5-lane-a-policy.mjs';

const WORKSPACE_ROOT = resolve(import.meta.dirname, '..');

export async function runProductLaneAPreflight(options) {
  assertConfiguration(options);
  const outputRoot = resolve(options.outputRoot);
  if (await lstat(outputRoot).catch(() => undefined)) {
    throw new Error(`Lane A product output root must not already exist: ${outputRoot}`);
  }

  const identity = options.developmentSelftest
    ? developmentIdentity()
    : await resolveAttestedArtifactIdentity({ ...options, outputRoot }, WORKSPACE_ROOT);
  if (!options.developmentSelftest) {
    await assertAttestedIdentityUnchanged({ ...options, outputRoot }, identity, WORKSPACE_ROOT);
  }

  const blockers = currentRuntimeControlBlockers();
  const assertions = Object.fromEntries(
    PRODUCT_LANE_A_REQUIRED_ASSERTIONS.map((name) => [name, false])
  );
  assertions.attestedIdentityVerified = identity.verified === true;
  assertions.fakeProductionIsolationVerified = identity.verified === true;
  const qualification = qualifyProductLaneA({
    fullScheduleComplete: false,
    assertions,
    blockers
  });
  const summary = {
    schemaVersion: 1,
    phase: 5,
    lane: 'A',
    scope: 'attested-product-process',
    status: qualification.status,
    acceptance: qualification.acceptance,
    developmentSelftest: options.developmentSelftest,
    configuredDurationMs: EIGHT_HOURS_MS,
    intervalsMs: {
      selection: DEFAULT_SELECTION_INTERVAL_MS,
      fault: DEFAULT_FAULT_INTERVAL_MS,
      lifecycle: DEFAULT_LIFECYCLE_INTERVAL_MS,
      resourceSample: 5_000
    },
    requiredSchedule: {
      selectionCycles: 960,
      faultCycles: 15,
      lifecycleCycles: 3,
      delivery: 'restricted-test-only-product-control-plane',
      confirmations: ['main-result', 'renderer-result']
    },
    identity: summarizeIdentity(identity, options),
    controlPlane: {
      protocolBoundByAttestation: false,
      packagedProductEndpointAvailable: false,
      fakeInjectionRestrictedToTestArtifact: identity.verified === true,
      publicArtifactFakeInjectionExcluded: identity.verified === true
    },
    execution: {
      productExecutableResolved: false,
      productPid: null,
      startedAt: null,
      completedAt: null,
      actionEventsWritten: 0,
      mainConfirmations: 0,
      rendererConfirmations: 0,
      resourceReport: null,
      residualProcessReport: null,
      werReport: null,
      privacyReport: null
    },
    assertions,
    missingAssertions: qualification.missingAssertions,
    blockers,
    acceptanceRule: 'PASS requires the frozen 8-hour schedule plus every product, resource, residual, WER, privacy, and graceful-exit assertion to be true.'
  };

  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot);
  await writeFile(resolve(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function summarizeIdentity(identity, options) {
  return {
    verified: identity.verified,
    source: identity.source,
    gitSha: options.developmentSelftest ? 'UNBOUND' : options.gitSha,
    repository: identity.repository,
    sourceRef: identity.sourceRef,
    signerWorkflow: identity.signerWorkflow,
    lockfileSha256: identity.lockfileSha256,
    testArtifact: identity.testArtifact,
    releaseArtifact: identity.releaseArtifact,
    testBuildManifestSha256: identity.testBuildManifestSha256,
    releaseBuildManifestSha256: identity.releaseBuildManifestSha256,
    trustedRootSha256: identity.trustedRootSha256,
    buildDifferenceId: options.developmentSelftest ? 'UNBOUND' : options.buildDifferenceId
  };
}

function developmentIdentity() {
  const artifact = { name: 'UNBOUND', size: 0, sha256: 'UNBOUND' };
  return {
    verified: false,
    source: 'UNBOUND_DEVELOPMENT_SELFTEST',
    repository: 'UNBOUND',
    sourceRef: 'UNBOUND',
    signerWorkflow: 'UNBOUND',
    lockfileSha256: 'UNBOUND',
    testArtifact: artifact,
    releaseArtifact: artifact,
    testBuildManifestSha256: 'UNBOUND',
    releaseBuildManifestSha256: 'UNBOUND',
    trustedRootSha256: 'UNBOUND'
  };
}

function assertConfiguration(options) {
  if (typeof options.outputRoot !== 'string' || options.outputRoot.trim() === '') {
    throw new Error('--output-root is required.');
  }
  if (options.developmentSelftest) return;
  if (!/^[a-f0-9]{40}$/u.test(options.gitSha ?? '')) {
    throw new Error('Product Lane A requires --git-sha as 40 lowercase hex characters.');
  }
  for (const name of [
    'testArtifactPath',
    'releaseArtifactPath',
    'testBuildManifestPath',
    'releaseBuildManifestPath',
    'testAttestationBundlePath',
    'releaseAttestationBundlePath',
    'trustedRootPath',
    'repository',
    'sourceRef',
    'signerWorkflow',
    'buildDifferenceId'
  ]) {
    if (typeof options[name] !== 'string' || options[name].trim() === '') {
      throw new Error(`Product Lane A requires --${toKebabCase(name)}.`);
    }
  }
}

function parseArguments(args) {
  const values = new Map();
  let developmentSelftest = false;
  const allowed = new Set([
    '--output-root',
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
    if (argument === '--development-selftest') {
      developmentSelftest = true;
      continue;
    }
    if (!allowed.has(argument)) throw new Error(`Unknown product Lane A argument: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  return {
    developmentSelftest,
    outputRoot: values.get('--output-root'),
    gitSha: values.get('--git-sha'),
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
    buildDifferenceId: values.get('--build-difference-id')
  };
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArguments(process.argv.slice(2));
  const summary = await runProductLaneAPreflight(options);
  console.log(JSON.stringify({
    phase: summary.phase,
    lane: summary.lane,
    status: summary.status,
    acceptance: summary.acceptance,
    blockers: summary.blockers.map(({ code }) => code)
  }));
  if (!options.developmentSelftest && !summary.acceptance) process.exitCode = 2;
}

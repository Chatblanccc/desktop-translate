import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  bergamotManifestSha256,
  createPendingBergamotAuthorization,
  isAllowedDownloadUrl,
  loadBergamotManifest,
  selectBergamotCandidates,
  validateBergamotManifest,
  verifyBergamotAuthorization
} from './bergamot-lib.mjs';
import {
  buildBergamotMeasurement,
  runBergamotBenchmarkSelfTest
} from './bergamot-benchmark.mjs';
import {
  buildBergamotPreparationPlan,
  parseBergamotPrepareArguments
} from './bergamot-prepare.mjs';
import {
  assertRuntimeSpikePrivacy,
  buildRuntimeSpikeReport
} from './bergamot-runtime-spike.mjs';
import { PocError } from './lib.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const schemaRoot = resolve(scriptRoot, 'schemas');

const manifest = await loadBergamotManifest();
assert.deepEqual(validateBergamotManifest(manifest), []);
assert.equal(manifest.gateA.status, 'BLOCKED');
assert.equal(manifest.gateA.blocksPocResearch, false);
assert.equal(manifest.runtime.packageName, '@browsermt/bergamot-translator');
assert.equal(manifest.runtime.version, '0.4.9');
assert.equal(manifest.runtime.tarball.size, 1_852_075);
assert.equal(
  manifest.runtime.tarball.sha256,
  '9011be93222d839d7448ffdf00549d53ce8f541fd782ffc79779d1756397c41f'
);
assert.equal(manifest.runtime.packageContainsLicenseFile, false);
assert.equal(manifest.runtime.installScriptsAllowed, false);
assert.equal(manifest.runtime.node23Compatibility, 'BLOCKED');
assert.ok(
  manifest.gateA.blockers.some(
    (blocker) => blocker.code === 'NODE_23_RUNTIME_COMPATIBILITY_BLOCKED'
  )
);
assert.ok(
  manifest.gateA.blockers.some(
    (blocker) => blocker.code === 'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED'
  )
);

const candidates = selectBergamotCandidates(manifest, {});
assert.equal(candidates.length, 2);
assert.deepEqual(
  candidates.map((candidate) => `${candidate.route.source}-${candidate.route.target}`).sort(),
  ['en-zh', 'zh-en']
);
assert.ok(
  candidates.every(
    (candidate) => candidate.license.expression === 'NOASSERTION'
      && candidate.license.observedRepositoryExpression === 'MPL-2.0'
      && candidate.license.commercialUseConclusion === 'NOT_ESTABLISHED'
  )
);
assert.equal(
  candidates.flatMap((candidate) => candidate.sourceFiles)
    .reduce((sum, file) => sum + file.size, 0),
  76_038_846
);
assert.equal(
  candidates[0].sourceFiles.find((file) => file.runtimePart === 'model').sha256,
  '7f255403b3bb2502f08ac4d5ca397a8a5a13f899d2f2e987a4934e089d241d16'
);

const plan = buildBergamotPreparationPlan(manifest, candidates);
assert.equal(plan.network.defaultAccess, false);
assert.equal(plan.network.activity, 'NOT_REQUESTED');
assert.equal(plan.fileCount, 12);
assert.equal(plan.totalBytes, 77_924_371);
assert.equal(plan.runtimeInstallScriptsAllowed, false);
assert.equal(plan.modelExecution, 'NOT_RUN');
const runtimeOnlyPlan = buildBergamotPreparationPlan(
  manifest,
  candidates,
  { includeModels: false }
);
assert.equal(runtimeOnlyPlan.fileCount, 3);
assert.equal(runtimeOnlyPlan.totalBytes, 1_885_525);

const pending = createPendingBergamotAuthorization(
  manifest,
  candidates.map((candidate) => candidate.id)
);
assert.equal(pending.authorization, 'PENDING');
assert.throws(
  () => verifyBergamotAuthorization(
    pending,
    manifest,
    candidates.map((candidate) => candidate.id)
  ),
  (error) => error instanceof PocError
    && error.code === 'BERGAMOT_POC_AUTHORIZATION_INVALID_OR_STALE'
);
const authorized = {
  ...pending,
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  authorizationRecordId: 'bergamot-selftest-m0',
  authorizedAt: '2026-07-23T00:00:00.000Z'
};
assert.doesNotThrow(() => verifyBergamotAuthorization(
  authorized,
  manifest,
  candidates.map((candidate) => candidate.id)
));
assert.throws(
  () => verifyBergamotAuthorization(
    { ...authorized, manifestSha256: '0'.repeat(64) },
    manifest,
    candidates.map((candidate) => candidate.id)
  ),
  (error) => error instanceof PocError
    && error.code === 'BERGAMOT_POC_AUTHORIZATION_INVALID_OR_STALE'
);

assert.equal(
  parseBergamotPrepareArguments([]).allowNetwork,
  false
);
assert.equal(
  parseBergamotPrepareArguments(['--runtime-only']).runtimeOnly,
  true
);
assert.throws(
  () => parseBergamotPrepareArguments(['--allow-network']),
  (error) => error instanceof PocError
    && error.code === 'BERGAMOT_ALLOW_NETWORK_REQUIRES_DOWNLOAD_ACTION'
);
assert.equal(
  isAllowedDownloadUrl('https://registry.npmjs.org/a.tgz'),
  true
);
assert.equal(
  isAllowedDownloadUrl(
    'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/model.gz?generation=1'
  ),
  true
);
assert.equal(
  isAllowedDownloadUrl(
    'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/model.gz'
  ),
  false
);
assert.equal(
  isAllowedDownloadUrl(
    'https://storage.googleapis.com/unrelated-bucket/model.gz?generation=1'
  ),
  false
);
assert.equal(
  isAllowedDownloadUrl('https://example.invalid/a.tgz'),
  false
);
assert.equal(
  isAllowedDownloadUrl('https://storage.googleapis.com.example.invalid/model.gz'),
  false
);
assert.equal(
  isAllowedDownloadUrl('https://user:secret@registry.npmjs.org/a.tgz'),
  false
);

const mutated = structuredClone(manifest);
mutated.runtime.tarball.sha256 = '0'.repeat(64);
assert.ok(
  validateBergamotManifest(mutated).includes('BERGAMOT_RUNTIME_TARBALL_PIN_INVALID')
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const manifestSchema = JSON.parse(
  await readFile(resolve(schemaRoot, 'bergamot-candidate-manifest.schema.json'), 'utf8')
);
const measurementSchema = JSON.parse(
  await readFile(resolve(schemaRoot, 'bergamot-measurement.schema.json'), 'utf8')
);
const authorizationSchema = JSON.parse(
  await readFile(resolve(schemaRoot, 'poc-authorization.schema.json'), 'utf8')
);
assert.equal(ajv.compile(manifestSchema)(manifest), true);
assert.equal(ajv.compile(authorizationSchema)(authorized), true);

const benchmarkSelfTest = await runBergamotBenchmarkSelfTest();
const validateMeasurement = ajv.compile(measurementSchema);
assert.equal(
  validateMeasurement(benchmarkSelfTest),
  true,
  JSON.stringify(validateMeasurement.errors)
);
assert.equal(benchmarkSelfTest.status, 'NO_MODEL_STATIC_SELF_TEST_PASS');
assert.equal(
  benchmarkSelfTest.runtime.probe.status,
  'STATIC_FIXTURE_ONLY'
);
assert.ok(
  benchmarkSelfTest.routes.every(
    (route) => route.status === 'STATIC_FIXTURE_ONLY'
  )
);
assert.equal(benchmarkSelfTest.quality.rawTextEmitted, false);
assert.equal(
  benchmarkSelfTest.networkIsolation.externalNetworkAccess,
  'NOT_VERIFIED'
);
assert.equal(benchmarkSelfTest.gateACompleteness.ready, false);
assert.equal(
  benchmarkSelfTest.gateACompleteness.inputStatus,
  'GATE_A_INPUT_INCOMPLETE'
);

const blockedSpike = buildRuntimeSpikeReport({
  manifest,
  candidates,
  supply: {
    fileCount: 3,
    totalBytes: 1_885_525,
    treeSha256: '1'.repeat(64)
  },
  materialized: {
    fileCount: 7,
    unpackedBytes: 5_314_609,
    treeSha256: '2'.repeat(64),
    installScriptsExecuted: false,
    packageMutated: false
  },
  probe: {
    status: 'BLOCKED',
    blockerCode: 'NODE_ESM_WORKER_REQUIRE_UNDEFINED',
    importMs: 1,
    wasmInitMs: 2,
    attemptedNetworkCalls: 0,
    rawErrorEmitted: false
  },
  probeTimeoutMs: 5_000
});
assert.equal(blockedSpike.status, 'BLOCKED_RUNTIME_COMPATIBILITY');
assert.equal(blockedSpike.probe.rawErrorEmitted, false);
assert.doesNotThrow(() => assertRuntimeSpikePrivacy(blockedSpike));

const preparationGuard = await expectFailure(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-prepare.mjs'), '--download']
);
assert.equal(
  JSON.parse(preparationGuard.stderr).errorCode,
  'NETWORK_OPERATION_REQUIRES_ALLOW_NETWORK'
);
const runtimeAuthorizationGuard = await expectFailure(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-runtime-spike.mjs')]
);
assert.equal(
  JSON.parse(runtimeAuthorizationGuard.stderr).errorCode,
  'BERGAMOT_POC_AUTHORIZATION_REQUIRED_FOR_RUNTIME_SPIKE'
);
const benchmarkHelp = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-benchmark.mjs'), '--help'],
  { maxBuffer: 1024 * 1024 }
);
assert.match(benchmarkHelp.stdout, /--poc-authorization/u);
assert.match(benchmarkHelp.stdout, /p50\/p95/u);

process.stdout.write(`${JSON.stringify({
  status: 'STATIC_SCHEMA_SELF_TEST_PASS',
  manifestSha256: bergamotManifestSha256(manifest),
  checks: [
    'pinned-model-files',
    'pinned-official-npm-runtime',
    'separate-mpl-evidence',
    'm0-authorization-binding',
    'network-activity-not-verified',
    'schema-validation',
    'static-measurement-shape-and-privacy',
    'gate-a-input-fails-closed',
    'runtime-blocker-report'
  ],
  networkActivityVerification: 'NOT_PERFORMED_STATIC_SCHEMA_SELFTEST',
  modelWeightsDownloaded: false,
  runtimeExecuted: false
}, null, 2)}\n`);

async function expectFailure(command, args) {
  try {
    await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
  assert.fail('Expected command to fail.');
}

void bergamotManifestSha256;
void buildBergamotMeasurement;

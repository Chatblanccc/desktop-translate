import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink
} from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { auditManifest } from './audit.mjs';
import {
  PocError,
  DEFAULT_ARTIFACT_ROOT,
  assertNetworkPermission,
  assertNoReparsePointsWithinRoot,
  createPendingPocAuthorization,
  loadManifest,
  manifestSha256,
  verifyPocAuthorization
} from './lib.mjs';
import { buildPreparationPlan, parseArguments } from './prepare.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));

const manifest = await loadManifest();
const audit = auditManifest(manifest);
assert.equal(audit.status, 'GATE_A_BLOCKED_POC_RESEARCH_ELIGIBLE');
assert.deepEqual(audit.validationErrors, []);
assert.equal(audit.network.mode, 'OFFLINE_STATIC');
assert.equal(audit.network.modelWeightsDownloaded, false);

const preferred = manifest.candidateSets.find(
  (candidateSet) => candidateSet.id === 'marian-opus-zh-en-bidirectional'
);
assert.equal(preferred.licenseConsistency, 'UNRESOLVED_CONFLICT');
assert.deepEqual(preferred.licenseExpressions, ['NOASSERTION']);
assert.deepEqual(
  preferred.observedMetadataExpressions,
  ['Apache-2.0', 'CC-BY-4.0']
);
assert.equal(preferred.status, 'BLOCKED_GATE_A');
assert.ok(
  manifest.gateA.blockers.some(
    (blocker) => blocker.code === 'WEIGHT_LICENSE_SCOPE_UNRESOLVED'
      && blocker.evidence.length >= 5
  )
);
assert.ok(
  manifest.candidates.every(
    (candidate) => candidate.license.expression === 'NOASSERTION'
      && candidate.license.commercialUseConclusion === 'NOT_ESTABLISHED'
  )
);

const enZh = manifest.candidates.find((candidate) => candidate.id === 'opus-mt-en-zh');
const m2m = manifest.candidates.find((candidate) => candidate.id === 'm2m100-418m');
assert.match(enZh.revision, /^[a-f0-9]{40}$/u);
assert.match(
  enZh.sourceFiles.find((file) => file.path === 'pytorch_model.bin').digest,
  /^[a-f0-9]{64}$/u
);
assert.equal(
  m2m.sourceFiles.find((file) => file.path === 'pytorch_model.bin').size,
  1_935_796_948
);

const plan = buildPreparationPlan(manifest, [enZh]);
assert.equal(plan.status, 'POC_AUTHORIZATION_REQUIRED');
assert.equal(plan.gateAStatus, 'BLOCKED_PENDING_POC_EVIDENCE');
assert.equal(plan.networkAccess, 'NOT_REQUESTED');
assert.equal(plan.modelWeightsDownloaded, false);
assert.equal(plan.sourceBytes, 315_321_723);

const parsedPlan = parseArguments(['--candidate', 'opus-mt-en-zh']);
assert.equal(parsedPlan.download, false);
assert.equal(parsedPlan.allowNetwork, false);
assert.throws(
  () => assertNetworkPermission({ operationRequested: true, allowNetwork: false }),
  (error) => error instanceof PocError
    && error.code === 'NETWORK_OPERATION_REQUIRES_ALLOW_NETWORK'
);

await mkdir(DEFAULT_ARTIFACT_ROOT, { recursive: true });
const rootChainSandbox = await mkdtemp(resolve(
  DEFAULT_ARTIFACT_ROOT,
  'root-chain-selftest-'
));
assert.ok(!relative(DEFAULT_ARTIFACT_ROOT, rootChainSandbox).startsWith('..'));
let activeJunction = null;
try {
  const fakeRepository = resolve(rootChainSandbox, 'repository');
  const fakeArtifacts = resolve(fakeRepository, 'artifacts');
  const externalPhase7 = resolve(rootChainSandbox, 'external-phase7');
  await mkdir(fakeArtifacts, { recursive: true });
  await mkdir(resolve(externalPhase7, 'offline-poc'), { recursive: true });
  activeJunction = resolve(fakeArtifacts, 'phase7');
  await symlink(externalPhase7, activeJunction, 'junction');
  await assert.rejects(
    assertNoReparsePointsWithinRoot({
      repositoryRoot: fakeRepository,
      artifactRoot: resolve(fakeArtifacts, 'phase7', 'offline-poc'),
      target: resolve(fakeArtifacts, 'phase7', 'offline-poc', 'result.json')
    }),
    (error) => error instanceof PocError
      && error.code === 'ARTIFACT_ROOT_REPARSE_POINT_REJECTED'
  );
  await unlink(activeJunction);
  activeJunction = null;

  const realPhase7 = resolve(fakeArtifacts, 'phase7');
  const externalPoc = resolve(rootChainSandbox, 'external-poc');
  await mkdir(realPhase7, { recursive: true });
  await mkdir(externalPoc, { recursive: true });
  activeJunction = resolve(realPhase7, 'offline-poc');
  await symlink(externalPoc, activeJunction, 'junction');
  await assert.rejects(
    assertNoReparsePointsWithinRoot({
      repositoryRoot: fakeRepository,
      artifactRoot: activeJunction,
      target: resolve(activeJunction, 'result.json')
    }),
    (error) => error instanceof PocError
      && error.code === 'ARTIFACT_ROOT_REPARSE_POINT_REJECTED'
  );
  await unlink(activeJunction);
  activeJunction = null;
} finally {
  if (activeJunction) {
    await unlink(activeJunction).catch(() => {});
  }
  await rm(rootChainSandbox, { recursive: true, force: true });
}

const authorization = createPendingPocAuthorization(manifest, ['opus-mt-en-zh']);
assert.equal(authorization.authorization, 'PENDING');
assert.equal(
  authorization.scope,
  'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
);
assert.throws(
  () => verifyPocAuthorization(authorization, manifest, ['opus-mt-en-zh']),
  (error) => error instanceof PocError
    && error.code === 'POC_AUTHORIZATION_INVALID_OR_STALE'
);
const authorized = {
  ...authorization,
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  authorizationRecordId: 'selftest-m0-record',
  authorizedAt: '2026-07-23T00:00:00.000Z'
};
assert.doesNotThrow(
  () => verifyPocAuthorization(authorized, manifest, ['opus-mt-en-zh'])
);
assert.throws(
  () => verifyPocAuthorization(
    { ...authorized, manifestSha256: '0'.repeat(64) },
    manifest,
    ['opus-mt-en-zh']
  ),
  (error) => error instanceof PocError
    && error.code === 'POC_AUTHORIZATION_INVALID_OR_STALE'
);

const mutated = structuredClone(manifest);
mutated.candidates[0].sourceFiles[0].digest = '';
const invalidAudit = auditManifest(mutated);
assert.equal(invalidAudit.status, 'INVALID');
assert.ok(invalidAudit.validationErrors.some((error) => error.startsWith('CANDIDATE_FILE_PIN_INVALID')));

for (const schema of [
  'candidate-manifest.schema.json',
  'poc-authorization.schema.json',
  'measurement.schema.json'
]) {
  const value = JSON.parse(
    await readFile(resolve(scriptRoot, 'schemas', schema), 'utf8')
  );
  assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
}

const auditGuardFailure = await expectFailure(
  process.execPath,
  [resolve(scriptRoot, 'audit.mjs'), '--refresh-remote']
);
assert.equal(
  JSON.parse(auditGuardFailure.stderr).errorCode,
  'NETWORK_OPERATION_REQUIRES_ALLOW_NETWORK'
);

const authorizationGuardFailure = await expectFailure(
  process.execPath,
  [
    resolve(scriptRoot, 'prepare.mjs'),
    '--candidate',
    'opus-mt-en-zh',
    '--download',
    '--allow-network'
  ]
);
assert.equal(
  JSON.parse(authorizationGuardFailure.stderr).errorCode,
  'POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD'
);

const pythonConvert = await execFileAsync(
  'python',
  ['-B', resolve(scriptRoot, 'convert.py'), '--self-test'],
  { maxBuffer: 1024 * 1024 }
);
assert.equal(
  JSON.parse(pythonConvert.stdout).status,
  'NO_MODEL_STATIC_SELF_TEST_PASS'
);
const convertHelp = await execFileAsync(
  'python',
  ['-B', resolve(scriptRoot, 'convert.py'), '--help'],
  { maxBuffer: 1024 * 1024 }
);
assert.match(convertHelp.stdout, /--poc-authorization/u);
assert.doesNotMatch(convertHelp.stdout, /--gate-a-decision/u);

const pythonBenchmark = await execFileAsync(
  'python',
  ['-B', resolve(scriptRoot, 'benchmark.py'), '--self-test'],
  { maxBuffer: 1024 * 1024 }
);
const benchmarkReport = JSON.parse(pythonBenchmark.stdout);
const measurementSchema = JSON.parse(
  await readFile(
    resolve(scriptRoot, 'schemas', 'measurement.schema.json'),
    'utf8'
  )
);
const measurementAjv = new Ajv2020({ allErrors: true, strict: true });
addFormats(measurementAjv);
const validateMeasurement = measurementAjv.compile(measurementSchema);
assert.equal(
  validateMeasurement(benchmarkReport),
  true,
  JSON.stringify(validateMeasurement.errors)
);
assert.equal(benchmarkReport.status, 'NO_MODEL_STATIC_SELF_TEST_PASS');
assert.ok(
  benchmarkReport.routes.every(
    (route) => route.status === 'STATIC_FIXTURE_ONLY'
  )
);
assert.equal(benchmarkReport.quality.rawTextEmitted, false);
assert.equal(benchmarkReport.timeouts.hardKillCount, 1);
assert.equal(benchmarkReport.gateACompleteness.ready, false);
assert.equal(
  benchmarkReport.gateACompleteness.inputStatus,
  'GATE_A_INPUT_INCOMPLETE'
);
assert.equal(
  benchmarkReport.networkIsolation.externalNetworkAccess,
  'NOT_VERIFIED'
);
const benchmarkHelp = await execFileAsync(
  'python',
  ['-B', resolve(scriptRoot, 'benchmark.py'), '--help'],
  { maxBuffer: 1024 * 1024 }
);
assert.match(benchmarkHelp.stdout, /--poc-authorization/u);
assert.doesNotMatch(benchmarkHelp.stdout, /--gate-a-decision/u);

const preflight = await execFileAsync(
  'powershell',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve(scriptRoot, 'preflight.ps1')
  ],
  { maxBuffer: 1024 * 1024 }
);
const preflightReport = JSON.parse(preflight.stdout);
assert.equal(preflightReport.network.externalNetworkAccess, 'NOT_VERIFIED');
assert.equal(preflightReport.modelExecution, 'NOT_RUN');
assert.equal(preflightReport.gateA.status, 'BLOCKED');
assert.equal(preflightReport.gateA.occursAfterPocMeasurement, true);
assert.equal(preflightReport.gateA.blocksPocResearch, false);
assert.equal(preflightReport.pocAuthorization.grantsIntegrationOrDistribution, false);

const bergamotSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-selftest.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const bergamotReport = JSON.parse(bergamotSelfTest.stdout);
assert.equal(bergamotReport.status, 'STATIC_SCHEMA_SELF_TEST_PASS');
assert.equal(
  bergamotReport.networkActivityVerification,
  'NOT_PERFORMED_STATIC_SCHEMA_SELFTEST'
);
assert.equal(bergamotReport.modelWeightsDownloaded, false);
assert.equal(bergamotReport.runtimeExecuted, false);

const bergamotElectronSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-electron-poc-selftest.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const bergamotElectronReport = JSON.parse(bergamotElectronSelfTest.stdout);
assert.equal(bergamotElectronReport.status, 'SELF_TEST_PASS');
assert.equal(
  bergamotElectronReport.externalNetworkVerification,
  'NOT_VERIFIED'
);
assert.equal(bergamotElectronReport.loopbackServerClosed, true);

const bergamotColdPwsSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'bergamot-cold-pws-selftest.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const bergamotColdPwsReport = JSON.parse(bergamotColdPwsSelfTest.stdout);
assert.equal(bergamotColdPwsReport.status, 'SELF_TEST_PASS');
assert.equal(
  bergamotColdPwsReport.windowsQueryWorkingSetRunnerExecuted,
  process.platform === 'win32'
);
assert.equal(bergamotColdPwsReport.processIdentifiersEmitted, false);

const argosSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'argos-selftest.mjs')],
  { maxBuffer: 4 * 1024 * 1024 }
);
const argosReport = JSON.parse(argosSelfTest.stdout);
assert.equal(
  argosReport.status,
  'ARGOS_STATIC_SCHEMA_AND_SAFETY_SELF_TEST_PASS'
);
assert.equal(argosReport.networkActivity, 'NOT_PERFORMED');
assert.equal(argosReport.modelArchivesDownloaded, false);
assert.equal(argosReport.runtimeWheelsDownloaded, false);
assert.equal(argosReport.runtimeImported, false);
assert.equal(argosReport.modelExecuted, false);
assert.equal(argosReport.candidateOutputArtifactCreated, false);

const blindEvaluationSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'blind-eval-selftest.mjs')],
  { maxBuffer: 4 * 1024 * 1024 }
);
const blindEvaluationReport = JSON.parse(blindEvaluationSelfTest.stdout);
assert.equal(
  blindEvaluationReport.status,
  'BLIND_EVALUATION_STATIC_SELF_TEST_PASS'
);
assert.equal(blindEvaluationReport.humanReviewExecuted, false);
assert.equal(blindEvaluationReport.modelExecution, 'NOT_RUN');
assert.equal(
  blindEvaluationReport.gateAInputStatus,
  'GATE_A_INPUT_INCOMPLETE'
);

const qvacRuntimeSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'qvac-runtime-selftest.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const qvacRuntimeReport = JSON.parse(qvacRuntimeSelfTest.stdout);
assert.equal(qvacRuntimeReport.status, 'STATIC_SCHEMA_SELF_TEST_PASS');
assert.equal(
  qvacRuntimeReport.networkActivityVerification,
  'NOT_PERFORMED_STATIC_SCHEMA_SELFTEST'
);
assert.equal(qvacRuntimeReport.modelWeightsDownloaded, false);
assert.equal(qvacRuntimeReport.modelLoad, 'NOT_RUN');
assert.equal(qvacRuntimeReport.firstTranslation, 'NOT_RUN');
assert.equal(qvacRuntimeReport.productIntegration, 'NOT_AUTHORIZED');

const completenessSelfTest = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'gate-a-completeness-selftest.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const completenessReport = JSON.parse(completenessSelfTest.stdout);
assert.equal(
  completenessReport.status,
  'STATIC_COMPLETENESS_SELF_TEST_PASS'
);
assert.equal(completenessReport.runtimeExecuted, false);
assert.equal(completenessReport.modelLoad, 'NOT_RUN');
assert.equal(completenessReport.failClosedFixture, 'GATE_A_INPUT_INCOMPLETE');

process.stdout.write(`${JSON.stringify({
  status: 'STATIC_SCHEMA_SELF_TEST_PASS',
  manifestSha256: manifestSha256(manifest),
  checks: [
    'manifest-pins',
    'license-mismatch-fail-closed',
    'network-opt-in',
    'artifact-root-chain-reparse-rejection',
    'm0-poc-authorization-binding',
    'schema-json',
    'conversion-no-model-static-selftest',
    'benchmark-static-invariants-and-timeout-harness',
    'gate-a-input-completeness-fail-closed',
    'windows-preflight',
    'firefox-bergamot-supply-runtime-and-benchmark',
    'firefox-bergamot-electron-loopback-compatibility-harness',
    'firefox-bergamot-fresh-process-query-working-set-runner',
    'argos-ctranslate2-supply-archive-and-direct-poc-static-harness',
    'human-blind-evaluation-randomization-and-privacy-harness',
    'qvac-bare-runtime-candidate-supply-and-boundaries'
  ],
  networkActivityVerification: 'NOT_PERFORMED_STATIC_SCHEMA_SELFTEST',
  modelWeightsDownloaded: false,
  modelExecution: 'NOT_RUN'
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

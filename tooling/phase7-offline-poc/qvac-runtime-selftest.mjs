import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  assertQvacRuntimeExecutionTreeBound,
  buildQvacRuntimeAudit,
  createPendingQvacAuthorization,
  loadQvacRuntimeCandidate,
  qvacRuntimeCandidateSha256,
  selectedQvacRiskCodes,
  verifyQvacAuthorization,
  validateQvacRuntimeCandidate
} from './qvac-runtime-audit.mjs';
import { runQvacImportConstructorProbe } from './qvac-runtime-probe.mjs';
import { PocError } from './lib.mjs';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const execFileAsync = promisify(execFile);
const manifest = await loadQvacRuntimeCandidate();
assert.deepEqual(validateQvacRuntimeCandidate(manifest), []);

const schema = JSON.parse(
  await readFile(
    resolve(scriptRoot, 'schemas', 'qvac-runtime-candidate.schema.json'),
    'utf8'
  )
);
const authorizationSchema = JSON.parse(
  await readFile(
    resolve(scriptRoot, 'schemas', 'poc-authorization.schema.json'),
    'utf8'
  )
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const validateAuthorizationSchema = ajv.compile(authorizationSchema);
assert.equal(validateSchema(manifest), true, JSON.stringify(validateSchema.errors));

assert.equal(manifest.policy.defaultNetworkAccess, false);
assert.equal(manifest.policy.modelFetcherAllowed, false);
assert.equal(manifest.policy.productIntegrationAllowed, false);
assert.equal(manifest.runtime.packageName, '@qvac/translation-nmtcpp');
assert.equal(manifest.runtime.version, '8.1.0');
assert.equal(manifest.runtime.engine.requiredRange, '>=1.19.0');
assert.equal(manifest.runtime.engine.pocVersion, '1.30.3');
assert.equal(manifest.runtime.tarball.size, 177_006_150);
assert.equal(
  manifest.runtime.tarball.sha256,
  'fd05f5ebdd97872e89d35086e47cf72be0dfafb866562eac8db979b1b1511c86'
);
assert.equal(manifest.runtime.windowsX64Prebuilds.length, 2);
assert.equal(
  manifest.runtime.windowsX64Prebuilds[0].sha256,
  '8a058f85166574b08ac8d89847a2fb6a1fd8f36c2b96400309c6bc67269cf3b9'
);
assert.equal(manifest.runtime.windowsX64Prebuilds[0].authenticode, 'NOT_SIGNED');
assert.equal(manifest.runtime.dependencies.distributionLockStatus, 'INCOMPLETE');
assert.equal(manifest.runtime.dependencies.executionTreeStatus, 'UNVERIFIED');
assert.equal(manifest.runtime.dependencies.probeExecutionAllowed, false);
assert.equal(manifest.runtime.barePocRuntime.source.revision, 'NOT_VERIFIED');
assert.equal(
  manifest.runtime.barePocRuntime.licenseEvidence.status,
  'LOCAL_PACKAGE_FILE_PRESENT_NOT_PINNED'
);
assert.equal(manifest.runtime.barePocRuntime.packageTarball.sha256, 'NOT_VERIFIED');
assert.equal(manifest.runtime.barePocRuntime.packageTarball.size, 'NOT_VERIFIED');
assert.equal(
  manifest.runtime.barePocRuntime.platformSource.revision,
  'NOT_VERIFIED'
);
assert.equal(
  manifest.runtime.barePocRuntime.platformLicenseEvidence.status,
  'LOCAL_PACKAGE_FILE_PRESENT_NOT_PINNED'
);
assert.equal(
  manifest.runtime.barePocRuntime.platformPackageTarball.sha256,
  'NOT_VERIFIED'
);
assert.equal(
  manifest.runtime.barePocRuntime.platformPackageTarball.size,
  'NOT_VERIFIED'
);
assert.equal(
  manifest.runtime.barePocRuntime.executableAuthenticode,
  'NOT_SIGNED'
);

const zhEn = manifest.modelContract.routes.find((route) => route.route === 'zh-en');
assert.equal(zhEn.sourceVocabulary, 'vocab.zhen.spm');
assert.equal(zhEn.targetVocabulary, 'vocab.zhen.spm');
assert.equal(zhEn.helperStatus, 'BYPASSED_DUE_TO_FILENAME_BUG');
assert.equal(manifest.modelContract.compressedInputsAccepted, false);
assert.equal(manifest.modelContract.modelFetcherAllowed, false);

assert.equal(
  manifest.probeEvidence.evidenceStatus,
  'HISTORICAL_UNBOUND_OBSERVATION_ONLY'
);
assert.equal(manifest.probeEvidence.eligibleForGateA, false);
assert.equal(
  manifest.probeEvidence.node.status,
  'HISTORICAL_BLOCKED_OBSERVATION'
);
assert.equal(
  manifest.probeEvidence.node.blockerCode,
  'BARE_GLOBAL_NOT_DEFINED'
);
assert.equal(
  manifest.probeEvidence.bare.status,
  'HISTORICAL_IMPORT_AND_CONSTRUCTOR_OBSERVATION'
);
assert.equal(manifest.probeEvidence.bare.modelLoad, 'NOT_RUN');
assert.equal(manifest.probeEvidence.bare.firstTranslation, 'NOT_RUN');
assert.equal(manifest.probeEvidence.networkAccessedDuringProbe, 'NOT_VERIFIED');
assert.equal(manifest.gateA.status, 'BLOCKED');
assert.ok(
  manifest.gateA.blockers.some(
    (blocker) => blocker.code === 'REAL_BIDIRECTIONAL_TRANSLATION_NOT_RUN'
  )
);
for (const blockerCode of [
  'QVAC_RUNTIME_EXECUTION_TREE_UNVERIFIED',
  'BARE_RUNTIME_PROVENANCE_INCOMPLETE',
  'UNSIGNED_BARE_WINDOWS_EXECUTABLE'
]) {
  assert.ok(
    manifest.gateA.blockers.some((blocker) => blocker.code === blockerCode)
  );
}

const pendingAuthorization = createPendingQvacAuthorization(manifest);
assert.equal(pendingAuthorization.authorization, 'PENDING');
assert.equal(
  pendingAuthorization.manifestSha256,
  qvacRuntimeCandidateSha256(manifest)
);
assert.deepEqual(
  pendingAuthorization.acknowledgedRiskCodes,
  selectedQvacRiskCodes(manifest)
);
assert.throws(
  () => verifyQvacAuthorization(pendingAuthorization, manifest),
  (error) => error instanceof PocError
    && error.code === 'QVAC_POC_AUTHORIZATION_INVALID_OR_STALE'
);
const authorized = {
  ...pendingAuthorization,
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  authorizationRecordId: 'qvac-selftest-m0',
  authorizedAt: '2026-07-23T00:00:00.000Z'
};
assert.equal(
  validateAuthorizationSchema(authorized),
  true,
  JSON.stringify(validateAuthorizationSchema.errors)
);
assert.doesNotThrow(() => verifyQvacAuthorization(authorized, manifest));
assert.throws(
  () => verifyQvacAuthorization(
    { ...authorized, manifestSha256: '0'.repeat(64) },
    manifest
  ),
  (error) => error instanceof PocError
    && error.code === 'QVAC_POC_AUTHORIZATION_INVALID_OR_STALE'
);
assert.throws(
  () => verifyQvacAuthorization(
    {
      ...authorized,
      acknowledgedRiskCodes:
        authorized.acknowledgedRiskCodes.slice(1)
    },
    manifest
  ),
  (error) => error instanceof PocError
    && error.code === 'QVAC_POC_AUTHORIZATION_INVALID_OR_STALE'
);
assert.throws(
  () => assertQvacRuntimeExecutionTreeBound(manifest),
  (error) => error instanceof PocError
    && error.code === 'QVAC_RUNTIME_EXECUTION_TREE_NOT_BOUND'
);
await assert.rejects(
  runQvacImportConstructorProbe({
    authorization: authorized,
    manifest,
    probeRoot: 'unused-because-runtime-tree-is-unverified'
  }),
  (error) => error instanceof PocError
    && error.code === 'QVAC_RUNTIME_EXECUTION_TREE_NOT_BOUND'
);

const mutated = structuredClone(manifest);
mutated.runtime.tarball.sha256 = '0'.repeat(64);
assert.ok(
  validateQvacRuntimeCandidate(mutated).includes('QVAC_TARBALL_PIN_INVALID')
);
const audit = buildQvacRuntimeAudit(manifest);
assert.equal(audit.status, 'GATE_A_BLOCKED_CONTROLLED_RUNTIME_CANDIDATE');
assert.equal(audit.network.accessed, 'NOT_VERIFIED');
assert.equal(audit.productIntegration, 'NOT_AUTHORIZED');
assert.equal(audit.probe.bare.firstTranslation, 'NOT_RUN');

const probeGuard = await expectFailure(
  process.execPath,
  [resolve(scriptRoot, 'qvac-runtime-probe.mjs')]
);
assert.equal(
  JSON.parse(probeGuard.stderr).errorCode,
  'QVAC_RUNTIME_PROBE_BOUND_AUTHORIZATION_REQUIRED'
);
const probeHelp = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'qvac-runtime-probe.mjs'), '--help'],
  { maxBuffer: 1024 * 1024 }
);
assert.match(probeHelp.stdout, /--acknowledge-poc-scope/u);
assert.match(probeHelp.stdout, /--poc-authorization/u);

process.stdout.write(`${JSON.stringify({
  status: 'STATIC_SCHEMA_SELF_TEST_PASS',
  manifestSha256: qvacRuntimeCandidateSha256(manifest),
  checks: [
    'pinned-qvac-npm-tarball',
    'pinned-windows-x64-prebuilds',
    'bare-runtime-provenance-recorded-as-incomplete',
    'license-and-notice-evidence',
    'network-activity-not-verified',
    'authorization-bound-to-manifest-candidate-and-risk-set',
    'unverified-runtime-tree-fails-closed-before-process-launch',
    'node-incompatibility-preserved',
    'historical-unbound-bare-import-constructor-observation-preserved',
    'zhen-helper-bypass-contract',
    'gate-a-blockers-preserved'
  ],
  networkActivityVerification: 'NOT_PERFORMED_STATIC_SCHEMA_SELFTEST',
  modelWeightsDownloaded: false,
  modelLoad: 'NOT_RUN',
  firstTranslation: 'NOT_RUN',
  productIntegration: 'NOT_AUTHORIZED'
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

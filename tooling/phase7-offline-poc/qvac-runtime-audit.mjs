import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ARTIFACT_ROOT,
  POC_AUTHORIZATION_SCHEMA_VERSION,
  POC_RESEARCH_SCOPE,
  PocError,
  assertNoReparsePointsWithinRoot,
  canonicalJson,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

export const QVAC_MANIFEST_PATH = fileURLToPath(
  new URL('./qvac-runtime-candidate.json', import.meta.url)
);

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const QVAC_AUTHORIZATION_CANDIDATE_ID = 'qvac-translation-nmtcpp-bare';

export async function loadQvacRuntimeCandidate(path = QVAC_MANIFEST_PATH) {
  const manifest = await loadJson(path);
  const errors = validateQvacRuntimeCandidate(manifest);
  if (errors.length > 0) {
    const error = new PocError('INVALID_QVAC_RUNTIME_CANDIDATE');
    error.validationErrors = errors;
    throw error;
  }
  return manifest;
}

export function validateQvacRuntimeCandidate(manifest) {
  const errors = [];
  const add = (code) => errors.push(code);

  if (!isRecord(manifest)) {
    return ['QVAC_MANIFEST_NOT_OBJECT'];
  }
  if (manifest.schemaVersion !== 'phase7-qvac-runtime-candidate-v1') {
    add('QVAC_SCHEMA_VERSION_INVALID');
  }
  if (!isRecord(manifest.policy)
      || manifest.policy.defaultNetworkAccess !== false
      || manifest.policy.pocAuthorizationScope
        !== 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
      || manifest.policy.packageInstallScriptsAllowed !== false
      || manifest.policy.modelFetcherAllowed !== false
      || manifest.policy.probeRequiresBoundAuthorization !== true
      || manifest.policy.runtimeExecutionRequiresVerifiedTree !== true
      || manifest.policy.productIntegrationAllowed !== false
      || manifest.policy.distributionAllowed !== false) {
    add('QVAC_POLICY_NOT_FAIL_CLOSED');
  }

  const runtime = manifest.runtime;
  if (!isRecord(runtime)
      || runtime.packageName !== '@qvac/translation-nmtcpp'
      || runtime.version !== '8.1.0'
      || !/^[a-f0-9]{40}$/u.test(runtime.sourceCommit ?? '')
      || runtime.declaredLicenseExpression !== 'Apache-2.0') {
    add('QVAC_RUNTIME_PIN_INVALID');
  }
  if (!isRecord(runtime?.engine)
      || runtime.engine.name !== 'bare'
      || runtime.engine.requiredRange !== '>=1.19.0'
      || runtime.engine.pocVersion !== '1.30.3'
      || runtime.engine.nodeDirectCompatibility !== 'BLOCKED') {
    add('QVAC_ENGINE_CONTRACT_INVALID');
  }
  if (!isPinnedTarball(runtime?.tarball)) {
    add('QVAC_TARBALL_PIN_INVALID');
  }
  if (!Array.isArray(runtime?.windowsX64Prebuilds)
      || runtime.windowsX64Prebuilds.length !== 2
      || runtime.windowsX64Prebuilds.some((file) => !isPinnedFile(file))) {
    add('QVAC_WINDOWS_PREBUILD_PINS_INVALID');
  }
  if (!Array.isArray(runtime?.licenseEvidence)
      || runtime.licenseEvidence.length !== 2
      || runtime.licenseEvidence.some((file) => !isPinnedFile(file))) {
    add('QVAC_LICENSE_EVIDENCE_INVALID');
  }
  if (!isRecord(runtime?.barePocRuntime)
      || runtime.barePocRuntime.version !== '1.30.3'
      || !SHA256_PATTERN.test(runtime.barePocRuntime.executableSha256 ?? '')
      || runtime.barePocRuntime.source?.revision !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.platformSource?.revision !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.declaredLicenseExpression !== 'Apache-2.0'
      || runtime.barePocRuntime.licenseEvidence?.status
        !== 'LOCAL_PACKAGE_FILE_PRESENT_NOT_PINNED'
      || runtime.barePocRuntime.platformLicenseEvidence?.status
        !== 'LOCAL_PACKAGE_FILE_PRESENT_NOT_PINNED'
      || runtime.barePocRuntime.packageTarball?.sha256 !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.packageTarball?.size !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.platformPackageTarball?.sha256 !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.platformPackageTarball?.size !== 'NOT_VERIFIED'
      || runtime.barePocRuntime.executableAuthenticode !== 'NOT_SIGNED'
      || !String(runtime.barePocRuntime.platformPackageIntegrity ?? '').startsWith('sha512-')) {
    add('QVAC_BARE_RUNTIME_PIN_INVALID');
  }
  if (runtime?.dependencies?.distributionLockStatus !== 'INCOMPLETE'
      || runtime?.dependencies?.executionTreeStatus !== 'UNVERIFIED'
      || runtime?.dependencies?.probeExecutionAllowed !== false) {
    add('QVAC_DEPENDENCY_LOCK_STATUS_MUST_REMAIN_INCOMPLETE');
  }

  const routes = manifest.modelContract?.routes;
  const enZh = routes?.find((route) => route.route === 'en-zh');
  const zhEn = routes?.find((route) => route.route === 'zh-en');
  if (manifest.modelContract?.compressedInputsAccepted !== false
      || manifest.modelContract?.modelFetcherAllowed !== false
      || enZh?.model !== 'model.enzh.intgemm.alphas.bin'
      || enZh?.sourceVocabulary !== 'srcvocab.enzh.spm'
      || enZh?.targetVocabulary !== 'trgvocab.enzh.spm'
      || zhEn?.sourceVocabulary !== 'vocab.zhen.spm'
      || zhEn?.targetVocabulary !== 'vocab.zhen.spm'
      || zhEn?.helperStatus !== 'BYPASSED_DUE_TO_FILENAME_BUG') {
    add('QVAC_MODEL_CONTRACT_INVALID');
  }

  if (manifest.probeEvidence?.evidenceStatus
        !== 'HISTORICAL_UNBOUND_OBSERVATION_ONLY'
      || manifest.probeEvidence?.eligibleForGateA !== false
      || manifest.probeEvidence?.node?.status
        !== 'HISTORICAL_BLOCKED_OBSERVATION'
      || manifest.probeEvidence?.node?.blockerCode !== 'BARE_GLOBAL_NOT_DEFINED'
      || manifest.probeEvidence?.bare?.status
        !== 'HISTORICAL_IMPORT_AND_CONSTRUCTOR_OBSERVATION'
      || manifest.probeEvidence?.bare?.modelLoad !== 'NOT_RUN'
      || manifest.probeEvidence?.bare?.firstTranslation !== 'NOT_RUN'
      || manifest.probeEvidence?.networkAccessedDuringProbe !== 'NOT_VERIFIED'
      || manifest.probeEvidence?.modelWeightsDownloadedForProbe !== false) {
    add('QVAC_PROBE_EVIDENCE_INVALID');
  }
  const blockerCodes = new Set(
    Array.isArray(manifest.gateA?.blockers)
      ? manifest.gateA.blockers.map((blocker) => blocker.code)
      : []
  );
  if (manifest.gateA?.status !== 'BLOCKED'
      || manifest.gateA?.candidateOnly !== true
      || manifest.gateA?.productIntegrationAllowed !== false
      || !blockerCodes.has('REAL_BIDIRECTIONAL_TRANSLATION_NOT_RUN')
      || !blockerCodes.has('UNSIGNED_WINDOWS_NATIVE_PREBUILD')
      || !blockerCodes.has('UNSIGNED_BARE_WINDOWS_EXECUTABLE')
      || !blockerCodes.has('BARE_RUNTIME_PROVENANCE_INCOMPLETE')
      || !blockerCodes.has('QVAC_RUNTIME_EXECUTION_TREE_UNVERIFIED')
      || !blockerCodes.has('TRANSITIVE_NPM_LOCK_AND_LICENSE_BUNDLE_PENDING')) {
    add('QVAC_GATE_A_MUST_REMAIN_BLOCKED');
  }

  return errors;
}

export function qvacRuntimeCandidateSha256(manifest) {
  return createHash('sha256')
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

export function selectedQvacRiskCodes(manifest) {
  return [...new Set(manifest.gateA.blockers.map((blocker) => blocker.code))].sort();
}

export function createPendingQvacAuthorization(manifest) {
  return {
    schemaVersion: POC_AUTHORIZATION_SCHEMA_VERSION,
    authorization: 'PENDING',
    scope: POC_RESEARCH_SCOPE,
    basis: 'PHASE7_M0_USER_AUTHORIZATION',
    manifestSha256: qvacRuntimeCandidateSha256(manifest),
    candidateIds: [QVAC_AUTHORIZATION_CANDIDATE_ID],
    observedLicenseMetadataExpressions: ['Apache-2.0'],
    acknowledgedRiskCodes: selectedQvacRiskCodes(manifest),
    authorizationRecordId: 'UNASSIGNED',
    authorizedAt: null
  };
}

export function verifyQvacAuthorization(authorization, manifest) {
  if (!isRecord(authorization)
      || authorization.schemaVersion !== POC_AUTHORIZATION_SCHEMA_VERSION
      || authorization.authorization !== 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      || authorization.scope !== POC_RESEARCH_SCOPE
      || authorization.basis !== 'PHASE7_M0_USER_AUTHORIZATION'
      || authorization.manifestSha256 !== qvacRuntimeCandidateSha256(manifest)
      || !sameStringSet(
        authorization.candidateIds,
        [QVAC_AUTHORIZATION_CANDIDATE_ID]
      )
      || !sameStringSet(
        authorization.observedLicenseMetadataExpressions,
        ['Apache-2.0']
      )
      || !sameStringSet(
        authorization.acknowledgedRiskCodes,
        selectedQvacRiskCodes(manifest)
      )
      || typeof authorization.authorizationRecordId !== 'string'
      || authorization.authorizationRecordId.length < 1
      || authorization.authorizationRecordId === 'UNASSIGNED'
      || typeof authorization.authorizedAt !== 'string'
      || Number.isNaN(Date.parse(authorization.authorizedAt))) {
    throw new PocError('QVAC_POC_AUTHORIZATION_INVALID_OR_STALE');
  }
  return {
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizedAt: authorization.authorizedAt
  };
}

export function assertQvacRuntimeExecutionTreeBound(manifest) {
  if (manifest.runtime.dependencies.executionTreeStatus !== 'VERIFIED_EXACT_TREE'
      || manifest.runtime.dependencies.probeExecutionAllowed !== true) {
    throw new PocError('QVAC_RUNTIME_EXECUTION_TREE_NOT_BOUND');
  }
}

export function buildQvacRuntimeAudit(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    status: 'GATE_A_BLOCKED_CONTROLLED_RUNTIME_CANDIDATE',
    candidate: {
      id: manifest.runtime.id,
      package: `${manifest.runtime.packageName}@${manifest.runtime.version}`,
      sourceCommit: manifest.runtime.sourceCommit,
      declaredLicenseExpression: manifest.runtime.declaredLicenseExpression,
      hostRuntime: `bare@${manifest.runtime.barePocRuntime.version}`,
      nodeDirectCompatibility: manifest.runtime.engine.nodeDirectCompatibility
    },
    supplyChain: {
      tarballBytes: manifest.runtime.tarball.size,
      tarballSha256: manifest.runtime.tarball.sha256,
      unpackedBytes: manifest.runtime.tarball.unpackedSize,
      windowsX64Prebuilds: manifest.runtime.windowsX64Prebuilds.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        authenticode: file.authenticode
      })),
      distributionLockStatus: manifest.runtime.dependencies.distributionLockStatus,
      executionTreeStatus: manifest.runtime.dependencies.executionTreeStatus,
      probeExecutionAllowed: manifest.runtime.dependencies.probeExecutionAllowed,
      bareRuntime: {
        sourceRevision: manifest.runtime.barePocRuntime.source.revision,
        licenseEvidenceStatus: manifest.runtime.barePocRuntime.licenseEvidence.status,
        tarballSha256: manifest.runtime.barePocRuntime.packageTarball.sha256,
        tarballSize: manifest.runtime.barePocRuntime.packageTarball.size,
        platformSourceRevision: manifest.runtime.barePocRuntime.platformSource.revision,
        platformLicenseEvidenceStatus:
          manifest.runtime.barePocRuntime.platformLicenseEvidence.status,
        platformTarballSha256:
          manifest.runtime.barePocRuntime.platformPackageTarball.sha256,
        platformTarballSize: manifest.runtime.barePocRuntime.platformPackageTarball.size,
        executableAuthenticode:
          manifest.runtime.barePocRuntime.executableAuthenticode
      }
    },
    probe: structuredClone(manifest.probeEvidence),
    modelContract: {
      compressedInputsAccepted: manifest.modelContract.compressedInputsAccepted,
      modelFetcherAllowed: manifest.modelContract.modelFetcherAllowed,
      routes: structuredClone(manifest.modelContract.routes),
      shortlistContract: manifest.modelContract.shortlistContract
    },
    gateA: {
      status: manifest.gateA.status,
      blockerCodes: manifest.gateA.blockers.map((blocker) => blocker.code)
    },
    network: {
      defaultAccess: false,
      accessed: 'NOT_VERIFIED'
    },
    productIntegration: 'NOT_AUTHORIZED',
    distribution: 'NOT_AUTHORIZED',
    manifestSha256: qvacRuntimeCandidateSha256(manifest)
  };
}

export async function verifyQvacProbeArtifacts(manifest, probeRoot) {
  const root = resolve(probeRoot);
  await assertNoReparsePointsWithinRoot({
    repositoryRoot: resolve(DEFAULT_ARTIFACT_ROOT, '..', '..', '..'),
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    target: root
  });
  const expected = [
    {
      ...manifest.runtime.tarball,
      path: 'qvac-translation-nmtcpp-8.1.0.tgz'
    },
    ...manifest.runtime.licenseEvidence.map((file) => ({
      ...file,
      path: `unpacked/package/${file.path}`
    })),
    ...manifest.runtime.windowsX64Prebuilds.map((file) => ({
      ...file,
      path: `unpacked/package/${file.path}`
    })),
    {
      path: 'runtime/node_modules/bare-runtime-win32-x64/bin/bare.exe',
      size: manifest.runtime.barePocRuntime.executableSize,
      sha256: manifest.runtime.barePocRuntime.executableSha256
    }
  ];

  const verified = [];
  for (const expectedFile of expected) {
    const path = resolve(root, expectedFile.path);
    await assertNoReparsePointsWithinRoot({
      repositoryRoot: resolve(DEFAULT_ARTIFACT_ROOT, '..', '..', '..'),
      artifactRoot: DEFAULT_ARTIFACT_ROOT,
      target: path
    });
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedFile.size) {
      throw new PocError('QVAC_PROBE_ARTIFACT_SIZE_OR_TYPE_MISMATCH');
    }
    const sha256Hash = createHash('sha256');
    const sha1Hash = expectedFile.sha1 ? createHash('sha1') : null;
    const sha512Hash = expectedFile.integrity ? createHash('sha512') : null;
    for await (const chunk of createReadStream(path)) {
      sha256Hash.update(chunk);
      sha1Hash?.update(chunk);
      sha512Hash?.update(chunk);
    }
    const sha256 = sha256Hash.digest('hex');
    if (sha256 !== expectedFile.sha256) {
      throw new PocError('QVAC_PROBE_ARTIFACT_SHA256_MISMATCH');
    }
    if (sha1Hash && sha1Hash.digest('hex') !== expectedFile.sha1) {
      throw new PocError('QVAC_PROBE_TARBALL_SHA1_MISMATCH');
    }
    if (sha512Hash
        && `sha512-${sha512Hash.digest('base64')}` !== expectedFile.integrity) {
      throw new PocError('QVAC_PROBE_TARBALL_INTEGRITY_MISMATCH');
    }
    verified.push({
      path: expectedFile.path,
      size: stat.size,
      sha256
    });
  }
  return {
    status: 'OFFLINE_ARTIFACT_VERIFICATION_PASS',
    fileCount: verified.length,
    totalBytes: verified.reduce((sum, file) => sum + file.size, 0),
    files: verified,
    networkActivityVerification: 'NOT_PERFORMED_STATIC_ARTIFACT_AUDIT'
  };
}

function isPinnedTarball(value) {
  return isRecord(value)
    && value.filename === 'qvac-translation-nmtcpp-8.1.0.tgz'
    && value.size === 177_006_150
    && value.unpackedSize === 546_237_344
    && value.fileCount === 155
    && value.sha1 === 'c9a62131fc6671a85eb1f8d9754116cccf1bd11f'
    && value.sha256
      === 'fd05f5ebdd97872e89d35086e47cf72be0dfafb866562eac8db979b1b1511c86'
    && value.integrity
      === 'sha512-F5kAg4WP6MfKV5Qwfh9NNJMDqWNdXXFCE6lHoBuclmh5iTtO3Le4MpZCCHBixnZXM4n1l9IKB5h1AbihPoqYfQ=='
    && SHA1_PATTERN.test(value.sha1)
    && SHA256_PATTERN.test(value.sha256)
    && String(value.url ?? '').startsWith('https://');
}

function isPinnedFile(value) {
  return isRecord(value)
    && typeof value.path === 'string'
    && value.path.length > 0
    && Number.isSafeInteger(value.size)
    && value.size > 0
    && SHA256_PATTERN.test(value.sha256 ?? '');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && JSON.stringify([...new Set(left)].sort())
      === JSON.stringify([...new Set(right)].sort())
    && left.length === new Set(left).size
    && right.length === new Set(right).size;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node qvac-runtime-audit.mjs '
      + '[--verify-artifacts <ignored-qvac-probe-root> '
      + '| --authorization-template <ignored-json>]\n'
    );
    return;
  }
  let probeRoot = null;
  let authorizationTemplatePath = null;
  if (args.length > 0) {
    if (args.length !== 2
        || !['--verify-artifacts', '--authorization-template'].includes(args[0])) {
      throw new PocError('QVAC_AUDIT_ARGUMENT_INVALID');
    }
    if (args[0] === '--verify-artifacts') {
      probeRoot = args[1];
    } else {
      authorizationTemplatePath = args[1];
    }
  }
  const manifest = await loadQvacRuntimeCandidate();
  if (authorizationTemplatePath) {
    const authorization = createPendingQvacAuthorization(manifest);
    await writeJsonArtifact(
      resolveArtifactOutput(authorizationTemplatePath),
      authorization
    );
    process.stdout.write(`${JSON.stringify({
      status: 'PENDING_POC_AUTHORIZATION_TEMPLATE_CREATED',
      manifestSha256: authorization.manifestSha256,
      candidateIds: authorization.candidateIds,
      networkActivityVerification: 'NOT_PERFORMED_STATIC_TEMPLATE_GENERATION'
    }, null, 2)}\n`);
    return;
  }
  const report = buildQvacRuntimeAudit(manifest);
  if (probeRoot) {
    report.offlineArtifactVerification = await verifyQvacProbeArtifacts(
      manifest,
      probeRoot
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      errorCode: error instanceof PocError
        ? error.code
        : 'QVAC_AUDIT_UNEXPECTED_FAILURE'
    })}\n`);
    process.exitCode = 1;
  });
}

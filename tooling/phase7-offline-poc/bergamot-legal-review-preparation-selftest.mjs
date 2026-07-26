import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  createLegalReviewPreparation,
  inspectNpmTarballBuffer
} from './bergamot-legal-review-preparation.mjs';
import { canonicalJson, sha256Text } from './lib.mjs';

const runtimeMetadata = Buffer.from(JSON.stringify({
  name: '@browsermt/bergamot-translator',
  version: '0.4.9',
  license: 'MPL-2.0'
}), 'utf8');
const tarball = createTar([
  ['package/package.json', runtimeMetadata],
  ['package/README.md', Buffer.from('synthetic readme', 'utf8')],
  ['package/worker/runtime.wasm', Buffer.from('synthetic wasm', 'utf8')]
]);
const runtimeInspection = inspectNpmTarballBuffer(gzipSync(tarball));
assert.deepEqual(runtimeInspection, {
  entryCount: 3,
  packageJsonSha256: sha(runtimeMetadata),
  packageName: '@browsermt/bergamot-translator',
  version: '0.4.9',
  declaredLicenseExpression: 'MPL-2.0',
  licenseLikeEntries: [],
  packageContainsLicenseFile: false
});

const manifest = createManifest();
const supplyFiles = [
  manifest.runtime.tarball,
  ...manifest.licenseEvidence,
  ...manifest.candidates.flatMap((candidate) => candidate.sourceFiles)
].map(({ localPath, size, sha256 }) => ({ localPath, size, sha256 }))
  .sort((left, right) => left.localPath.localeCompare(right.localPath));
const verifiedSupply = {
  fileCount: supplyFiles.length,
  totalBytes: supplyFiles.reduce((total, entry) => total + entry.size, 0),
  treeSha256: sha256Text(canonicalJson(supplyFiles)),
  files: supplyFiles
};
const bindings = manifest.candidates.map((candidate) => ({
  direction: `${candidate.route.source}-${candidate.route.target}`,
  candidateId: candidate.id,
  generationRunId: `generation-${candidate.route.source}-${candidate.route.target}`,
  generationArtifactSha256: sha(`generation:${candidate.id}`),
  generationIdentitySha256: sha(`identity:${candidate.id}`),
  sourceSetIdentitySha256: sha(`source:${candidate.id}`),
  sourceSetRecordCount: 200,
  candidateOutputArtifactSha256: sha(`output:${candidate.id}`),
  candidateOutputItemIdentitySetSha256: sha(`items:${candidate.id}`)
}));
const candidateBindings = {
  manifestSha256: sha256Text(canonicalJson(manifest)),
  authorizationSha256: sha('authorization'),
  authorizationRecordId: 'synthetic-authorization',
  bindingSetSha256: sha256Text(canonicalJson(bindings)),
  bindings,
  integrationOrDistributionAuthorized: false
};
const sizing = {
  schemaVersion: 'phase7-bergamot-core-pack-sizing-preparation-v1',
  status: 'PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  candidateGenerationBindingSetSha256: candidateBindings.bindingSetSha256,
  coreModelPack: { sha256: sha('core-pack') },
  integrationOrDistributionAuthorized: false
};
const report = createLegalReviewPreparation({
  manifest,
  candidateBindings,
  verifiedSupply,
  packageSizingPreparation: sizing,
  packageSizingPreparationSha256: sha('sizing'),
  runtimeTarInspection: runtimeInspection,
  preparedAt: '2026-07-26T00:00:00.000Z'
});
assert.equal(report.status, 'LEGAL_REVIEW_PREPARED_NOT_APPROVED');
assert.equal(report.legalReview.approvalRecorded, false);
assert.equal(report.legalReview.commercialUseConclusion, 'NOT_ESTABLISHED');
assert.equal(report.legalReview.redistributionConclusion, 'NOT_ESTABLISHED');
assert.equal(report.gateA.legalReviewComponentComplete, false);
assert.equal(report.gateA.userDecisionRecorded, false);
assert.equal(report.integrationOrDistributionAuthorized, false);
assert.deepEqual(report.runtime.licenseLikeEntries, []);
assert.deepEqual(report.legalReview.unresolvedIssueCodes, [
  'ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK',
  'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED',
  'MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED',
  'NPM_TARBALL_LICENSE_FILE_MISSING'
]);

const tarballWithLicense = createTar([
  ['package/package.json', runtimeMetadata],
  ['package/LICENSE', Buffer.from('synthetic license', 'utf8')]
]);
const withLicense = inspectNpmTarballBuffer(gzipSync(tarballWithLicense));
assert.equal(withLicense.packageContainsLicenseFile, true);
assert.deepEqual(withLicense.licenseLikeEntries, ['package/LICENSE']);
assert.throws(
  () => createLegalReviewPreparation({
    manifest,
    candidateBindings,
    verifiedSupply,
    packageSizingPreparation: sizing,
    packageSizingPreparationSha256: sha('sizing'),
    runtimeTarInspection: withLicense,
    preparedAt: '2026-07-26T00:00:00.000Z'
  }),
  /LEGAL_REVIEW_RUNTIME_METADATA_INVALID/u
);

process.stdout.write(`${JSON.stringify({
  status: 'BERGAMOT_LEGAL_REVIEW_PREPARATION_SELF_TEST_PASS',
  candidateBindingRequired: true,
  supplyHashVerificationRequired: true,
  npmTarballLicensePresenceInspected: true,
  legalApprovalFabricationRejected: true,
  integrationOrDistributionAuthorized: false
}, null, 2)}\n`);

function createManifest() {
  const blockerCodes = [
    'ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK',
    'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED',
    'MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED',
    'NODE_23_RUNTIME_COMPATIBILITY_BLOCKED',
    'NPM_TARBALL_LICENSE_FILE_MISSING'
  ];
  const candidateIds = ['candidate-en-zh', 'candidate-zh-en'];
  return {
    schemaVersion: 'phase7-bergamot-poc-candidates-v1',
    gateA: {
      blockers: blockerCodes.map((code) => ({ code }))
    },
    runtime: {
      id: 'runtime',
      packageName: '@browsermt/bergamot-translator',
      version: '0.4.9',
      sourceCommit: '1'.repeat(40),
      declaredLicenseExpression: 'MPL-2.0',
      packageContainsLicenseFile: false,
      tarball: {
        localPath: 'runtime/runtime.tgz',
        size: 3,
        sha256: sha('runtime')
      }
    },
    licenseEvidence: [{
      id: 'model-license',
      repository: 'example/models',
      revision: '2'.repeat(40),
      path: 'LICENSE',
      localPath: 'licenses/model.txt',
      expression: 'MPL-2.0',
      size: 4,
      sha256: sha('license')
    }],
    candidateSets: [{
      id: 'firefox-bergamot-base-memory-en-zh-bidirectional',
      candidateIds
    }],
    candidates: candidateIds.map((id, index) => ({
      id,
      repository: 'example/models',
      revision: '2'.repeat(40),
      route: index === 0
        ? { source: 'en', target: 'zh' }
        : { source: 'zh', target: 'en' },
      license: {
        expression: 'NOASSERTION',
        observedRepositoryExpression: 'MPL-2.0',
        commercialUseConclusion: 'NOT_ESTABLISHED',
        evidenceId: 'model-license'
      },
      sourceFiles: [{
        localPath: `models/${id}.bin`,
        size: 5 + index,
        sha256: sha(id)
      }]
    }))
  };
}

function createTar(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeOctal(header, 148, 8, checksum(header));
    blocks.push(header, content);
    const padding = content.length % 512;
    if (padding !== 0) blocks.push(Buffer.alloc(512 - padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  buffer.write(`${encoded}\0`, offset, length, 'ascii');
}

function checksum(buffer) {
  return buffer.reduce((total, value) => total + value, 0);
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

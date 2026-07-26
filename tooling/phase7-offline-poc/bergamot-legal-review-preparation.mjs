import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  DEFAULT_BERGAMOT_MANIFEST_PATH,
  DEFAULT_BERGAMOT_SUPPLY_ROOT,
  bergamotManifestSha256,
  loadBergamotManifest,
  selectBergamotCandidates,
  verifyBergamotAuthorization,
  verifyBergamotSupply
} from './bergamot-lib.mjs';
import { deriveGateACandidateBindings } from './gate-a-candidate-bindings.mjs';
import {
  POC_RESEARCH_SCOPE,
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  canonicalJson,
  resolveArtifactOutput,
  sha256Text,
  writeJsonArtifact
} from './lib.mjs';

const LEGAL_ISSUE_CODES = Object.freeze([
  'ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK',
  'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED',
  'MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED',
  'NPM_TARBALL_LICENSE_FILE_MISSING'
]);
const NON_LEGAL_RISK_CODES = Object.freeze([
  'NODE_23_RUNTIME_COMPATIBILITY_BLOCKED'
]);
const LICENSE_ENTRY = /(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu;
const SAFE_TAR_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/u;

const USAGE = `Usage:
  node bergamot-legal-review-preparation.mjs \\
    --authorization <phase7-authorization.json> \\
    --generation-en-zh <generation-en-zh.json> \\
    --generation-zh-en <generation-zh-en.json> \\
    --package-sizing-preparation <sizing-preparation.json> \\
    --output <legal-review-preparation.json>

Optional:
    --manifest <bergamot-candidates.json>
    --supply-root <verified-bergamot-supply-root>

This command only prepares candidate-bound evidence for qualified legal or
compliance review. Its output can never approve commercial use, integration,
packaging, redistribution, or Gate A.
`;

export function inspectNpmTarballBuffer(rawTarball) {
  let tar;
  try {
    tar = gunzipSync(rawTarball);
  } catch {
    throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_GZIP_INVALID');
  }
  const entries = [];
  const regularFiles = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const logicalName = prefix ? `${prefix}/${name}` : name;
    if (!SAFE_TAR_PATH.test(logicalName)) {
      throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_PATH_UNSAFE');
    }
    const size = parseTarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) {
      throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_TRUNCATED');
    }
    if (entries.includes(logicalName)) {
      throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_DUPLICATE_ENTRY');
    }
    entries.push(logicalName);
    if (type === '0' || type === '\0') {
      regularFiles.set(logicalName, tar.subarray(contentStart, contentEnd));
    } else if (type !== '5') {
      throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_TYPE_UNSUPPORTED');
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  const packageJson = regularFiles.get('package/package.json');
  if (!packageJson) {
    throw new PocError('LEGAL_REVIEW_RUNTIME_PACKAGE_JSON_MISSING');
  }
  let metadata;
  try {
    metadata = JSON.parse(packageJson.toString('utf8'));
  } catch {
    throw new PocError('LEGAL_REVIEW_RUNTIME_PACKAGE_JSON_INVALID');
  }
  const licenseLikeEntries = entries.filter((entry) =>
    LICENSE_ENTRY.test(entry)
  ).sort();
  return {
    entryCount: entries.length,
    packageJsonSha256: sha256Bytes(packageJson),
    packageName: metadata.name,
    version: metadata.version,
    declaredLicenseExpression: metadata.license,
    licenseLikeEntries,
    packageContainsLicenseFile: licenseLikeEntries.length > 0
  };
}

export function createLegalReviewPreparation({
  manifest,
  candidateBindings,
  verifiedSupply,
  packageSizingPreparation,
  packageSizingPreparationSha256,
  runtimeTarInspection,
  preparedAt
}) {
  const candidates = selectBergamotCandidates(manifest);
  const candidateIds = candidates.map((candidate) => candidate.id).sort();
  assert(
    candidateBindings.manifestSha256 === bergamotManifestSha256(manifest)
      && candidateBindings.integrationOrDistributionAuthorized === false
      && sameStrings(
        candidateBindings.bindings.map((binding) => binding.candidateId),
        candidateIds
      ),
    'LEGAL_REVIEW_CANDIDATE_BINDING_INVALID'
  );
  assert(
    packageSizingPreparation?.schemaVersion
      === 'phase7-bergamot-core-pack-sizing-preparation-v1'
      && packageSizingPreparation.status
        === 'PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET'
      && packageSizingPreparation.scope === POC_RESEARCH_SCOPE
      && packageSizingPreparation.candidateGenerationBindingSetSha256
        === candidateBindings.bindingSetSha256
      && packageSizingPreparation.integrationOrDistributionAuthorized === false
      && validSha(packageSizingPreparationSha256),
    'LEGAL_REVIEW_PACKAGE_SIZING_BINDING_INVALID'
  );
  const expectedSupplyFiles = [
    manifest.runtime.tarball,
    ...manifest.licenseEvidence,
    ...candidates.flatMap((candidate) => candidate.sourceFiles)
  ].map((entry) => ({
    localPath: entry.localPath,
    size: entry.size,
    sha256: entry.sha256
  })).sort(compareLocalPath);
  assert(
    verifiedSupply.fileCount === expectedSupplyFiles.length
      && verifiedSupply.totalBytes === expectedSupplyFiles.reduce(
        (total, entry) => total + entry.size,
        0
      )
      && verifiedSupply.treeSha256
        === sha256Text(canonicalJson(expectedSupplyFiles))
      && canonicalJson([...verifiedSupply.files].sort(compareLocalPath))
        === canonicalJson(expectedSupplyFiles),
    'LEGAL_REVIEW_VERIFIED_SUPPLY_INVALID'
  );
  assert(
    runtimeTarInspection.packageName === manifest.runtime.packageName
      && runtimeTarInspection.version === manifest.runtime.version
      && runtimeTarInspection.declaredLicenseExpression
        === manifest.runtime.declaredLicenseExpression
      && runtimeTarInspection.packageContainsLicenseFile
        === manifest.runtime.packageContainsLicenseFile
      && Array.isArray(runtimeTarInspection.licenseLikeEntries),
    'LEGAL_REVIEW_RUNTIME_METADATA_INVALID'
  );
  const manifestBlockers = new Set(
    manifest.gateA.blockers.map((blocker) => blocker.code)
  );
  assert(
    [...LEGAL_ISSUE_CODES, ...NON_LEGAL_RISK_CODES].every(
      (code) => manifestBlockers.has(code)
    ),
    'LEGAL_REVIEW_REQUIRED_RISK_MISSING'
  );
  if (
    typeof preparedAt !== 'string'
    || Number.isNaN(Date.parse(preparedAt))
  ) {
    throw new PocError('LEGAL_REVIEW_PREPARED_AT_INVALID');
  }
  const licenseEvidence = manifest.licenseEvidence.map((evidence) => ({
    id: evidence.id,
    repository: evidence.repository,
    revision: evidence.revision,
    repositoryPath: evidence.path,
    observedExpression: evidence.expression,
    sizeBytes: evidence.size,
    sha256: evidence.sha256
  })).sort((left, right) => left.id.localeCompare(right.id));
  const report = {
    schemaVersion: 'phase7-bergamot-legal-review-preparation-v1',
    status: 'LEGAL_REVIEW_PREPARED_NOT_APPROVED',
    scope: POC_RESEARCH_SCOPE,
    candidateGenerationBindingSetSha256:
      candidateBindings.bindingSetSha256,
    candidateBindings: candidateBindings.bindings,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.id,
      direction: `${candidate.route.source}-${candidate.route.target}`,
      repository: candidate.repository,
      revision: candidate.revision,
      declaredWeightLicenseExpression: candidate.license.expression,
      observedRepositoryExpression:
        candidate.license.observedRepositoryExpression,
      commercialUseConclusion: candidate.license.commercialUseConclusion,
      licenseEvidenceId: candidate.license.evidenceId
    })).sort((left, right) => left.direction.localeCompare(right.direction)),
    runtime: {
      runtimeId: manifest.runtime.id,
      packageName: manifest.runtime.packageName,
      version: manifest.runtime.version,
      sourceCommit: manifest.runtime.sourceCommit,
      declaredLicenseExpression:
        runtimeTarInspection.declaredLicenseExpression,
      packageJsonSha256: runtimeTarInspection.packageJsonSha256,
      tarballSha256: manifest.runtime.tarball.sha256,
      tarballSizeBytes: manifest.runtime.tarball.size,
      tarballEntryCount: runtimeTarInspection.entryCount,
      packageContainsLicenseFile:
        runtimeTarInspection.packageContainsLicenseFile,
      licenseLikeEntries: runtimeTarInspection.licenseLikeEntries
    },
    evidence: {
      manifestSha256: bergamotManifestSha256(manifest),
      authorizationSha256: candidateBindings.authorizationSha256,
      authorizationRecordId: candidateBindings.authorizationRecordId,
      verifiedSupplyTreeSha256: verifiedSupply.treeSha256,
      verifiedSupplyFileCount: verifiedSupply.fileCount,
      verifiedSupplyBytes: verifiedSupply.totalBytes,
      packageSizingPreparationSha256,
      coreModelPackSha256: packageSizingPreparation.coreModelPack.sha256,
      licenseEvidence
    },
    legalReview: {
      status: 'AWAITING_QUALIFIED_LEGAL_OR_COMPLIANCE_REVIEW',
      approvalRecorded: false,
      commercialUseConclusion: 'NOT_ESTABLISHED',
      modelWeightLicenseScopeConclusion: 'NOT_ESTABLISHED',
      redistributionConclusion: 'NOT_ESTABLISHED',
      releaseCompliancePlanStatus: 'NOT_CREATED',
      unresolvedIssueCodes: [...LEGAL_ISSUE_CODES]
    },
    nonLegalRisksStillOpen: [...NON_LEGAL_RISK_CODES],
    gateA: {
      legalReviewComponentComplete: false,
      inputStatus: 'GATE_A_INPUT_INCOMPLETE',
      userDecisionRecorded: false
    },
    privacy: {
      sourceTextIncluded: false,
      translationTextIncluded: false,
      absolutePathsIncluded: false,
      usernamesIncluded: false
    },
    integrationOrDistributionAuthorized: false,
    preparedAt
  };
  assertNonAuthorizing(report);
  return report;
}

export async function prepareLegalReview(options) {
  const manifest = await loadBergamotManifest(
    options.manifestPath ?? DEFAULT_BERGAMOT_MANIFEST_PATH
  );
  const candidates = selectBergamotCandidates(manifest);
  const authorization = await readArtifactJson(options.authorizationPath);
  verifyBergamotAuthorization(
    authorization.document,
    manifest,
    candidates.map((candidate) => candidate.id)
  );
  const candidateBindings = await deriveGateACandidateBindings({
    authorizationPath: authorization.path,
    generationPaths: {
      'en-zh': await resolveArtifactInput(options.generationEnZhPath),
      'zh-en': await resolveArtifactInput(options.generationZhEnPath)
    }
  });
  const packageSizing = await readArtifactJson(
    options.packageSizingPreparationPath
  );
  const supplyRoot = resolve(
    options.supplyRoot ?? DEFAULT_BERGAMOT_SUPPLY_ROOT
  );
  const verifiedSupply = await verifyBergamotSupply(manifest, candidates, {
    includeModels: true,
    supplyRoot
  });
  const runtimeTarballPath = resolve(
    supplyRoot,
    ...manifest.runtime.tarball.localPath.split('/')
  );
  await assertNoReparsePointsWithinArtifactRoot(runtimeTarballPath);
  const runtimeTarInspection = inspectNpmTarballBuffer(
    await readFile(runtimeTarballPath)
  );
  const report = createLegalReviewPreparation({
    manifest,
    candidateBindings,
    verifiedSupply,
    packageSizingPreparation: packageSizing.document,
    packageSizingPreparationSha256: sha256Bytes(packageSizing.raw),
    runtimeTarInspection,
    preparedAt: new Date().toISOString()
  });
  const outputPath = resolveArtifactOutput(options.outputPath);
  await writeJsonArtifact(outputPath, report);
  return {
    schemaVersion: report.schemaVersion,
    status: report.status,
    candidateGenerationBindingSetSha256:
      report.candidateGenerationBindingSetSha256,
    candidateCount: report.candidates.length,
    verifiedSupplyFileCount: report.evidence.verifiedSupplyFileCount,
    unresolvedIssueCodes: report.legalReview.unresolvedIssueCodes,
    approvalRecorded: false,
    integrationOrDistributionAuthorized: false,
    outputSha256: sha256Text(`${JSON.stringify(report, null, 2)}\n`)
  };
}

async function readArtifactJson(inputPath) {
  const path = await resolveArtifactInput(inputPath);
  const raw = await readFile(path);
  try {
    return { path, raw, document: JSON.parse(raw.toString('utf8')) };
  } catch {
    throw new PocError('LEGAL_REVIEW_INPUT_JSON_INVALID');
  }
}

async function resolveArtifactInput(inputPath) {
  const path = resolveArtifactOutput(resolve(inputPath));
  await assertNoReparsePointsWithinArtifactRoot(path);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new PocError('LEGAL_REVIEW_INPUT_FILE_MISSING_OR_UNSAFE');
  }
  return path;
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(
    offset,
    end >= offset && end < offset + length ? end : offset + length
  ).toString('utf8');
}

function parseTarOctal(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_SIZE_INVALID');
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new PocError('LEGAL_REVIEW_RUNTIME_TARBALL_SIZE_INVALID');
  }
  return size;
}

function assertNonAuthorizing(report) {
  assert(
    report.status === 'LEGAL_REVIEW_PREPARED_NOT_APPROVED'
      && report.legalReview.approvalRecorded === false
      && report.legalReview.commercialUseConclusion === 'NOT_ESTABLISHED'
      && report.legalReview.redistributionConclusion === 'NOT_ESTABLISHED'
      && report.gateA.legalReviewComponentComplete === false
      && report.gateA.userDecisionRecorded === false
      && report.integrationOrDistributionAuthorized === false,
    'LEGAL_REVIEW_PREPARATION_MUST_NOT_AUTHORIZE'
  );
}

function compareLocalPath(left, right) {
  return left.localPath.localeCompare(right.localPath);
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, code) {
  if (!condition) throw new PocError(code);
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') return { help: true };
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new PocError('LEGAL_REVIEW_ARGUMENT_INVALID');
    }
    if (values.has(key)) {
      throw new PocError('LEGAL_REVIEW_ARGUMENT_DUPLICATE');
    }
    values.set(key, value);
    index += 1;
  }
  const required = [
    '--authorization',
    '--generation-en-zh',
    '--generation-zh-en',
    '--package-sizing-preparation',
    '--output'
  ];
  const allowed = new Set([...required, '--manifest', '--supply-root']);
  if (
    required.some((key) => !values.has(key))
    || [...values.keys()].some((key) => !allowed.has(key))
  ) {
    throw new PocError('LEGAL_REVIEW_REQUIRED_ARGUMENT_MISSING_OR_UNKNOWN');
  }
  return {
    authorizationPath: values.get('--authorization'),
    generationEnZhPath: values.get('--generation-en-zh'),
    generationZhEnPath: values.get('--generation-zh-en'),
    packageSizingPreparationPath:
      values.get('--package-sizing-preparation'),
    outputPath: values.get('--output'),
    manifestPath: values.get('--manifest'),
    supplyRoot: values.get('--supply-root')
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await prepareLegalReview(options), null, 2)}\n`
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED_CLOSED',
      errorCode: error?.code ?? error?.message
        ?? 'LEGAL_REVIEW_PREPARATION_INTERNAL_FAILURE'
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

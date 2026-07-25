import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, '..', '..');
export const DEFAULT_MANIFEST_PATH = resolve(SCRIPT_ROOT, 'candidates.json');
export const DEFAULT_FIXTURE_PATH = resolve(SCRIPT_ROOT, 'fixtures', 'quality-samples.jsonl');
export const DEFAULT_ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, 'artifacts', 'phase7', 'offline-poc');
export const MANIFEST_SCHEMA_VERSION = 'phase7-offline-poc-candidates-v1';
export const POC_AUTHORIZATION_SCHEMA_VERSION = 'phase7-offline-poc-authorization-v1';
export const POC_RESEARCH_SCOPE = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ROUTE_LANGUAGES = new Set(['en', 'zh']);

export class PocError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PocError';
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new PocError('NON_FINITE_JSON_NUMBER');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new PocError('UNSERIALIZABLE_JSON_VALUE');
  }
  return serialized;
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function manifestSha256(manifest) {
  return sha256Text(canonicalJson(manifest));
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  const manifest = await loadJson(path);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    const error = new PocError('INVALID_CANDIDATE_MANIFEST');
    error.validationErrors = errors;
    throw error;
  }
  return manifest;
}

export function validateManifest(manifest) {
  const errors = [];
  const add = (code) => errors.push(code);

  if (!isRecord(manifest)) {
    return ['MANIFEST_NOT_OBJECT'];
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    add('MANIFEST_SCHEMA_VERSION_INVALID');
  }
  if (!isRecord(manifest.policy)
      || manifest.policy.defaultNetworkAccess !== false
      || manifest.policy.largeDownloadsRequirePocAuthorization !== true
      || manifest.policy.pocAuthorizationScope !== POC_RESEARCH_SCOPE
      || manifest.policy.gateARequiredForPocResearch !== false
      || manifest.policy.conversionQuantization !== 'int8'
      || manifest.policy.conversionTrustRemoteCode !== false
      || manifest.policy.artifactRoot !== 'artifacts/phase7/offline-poc') {
    add('POLICY_FAIL_CLOSED_VALUES_INVALID');
  }
  if (!isRecord(manifest.gateA)
      || manifest.gateA.status !== 'BLOCKED'
      || manifest.gateA.harnessMayDecide !== false
      || manifest.gateA.blocksPocResearch !== false
      || typeof manifest.gateA.requiredInput !== 'string'
      || !Array.isArray(manifest.gateA.blockers)
      || manifest.gateA.blockers.length === 0) {
    add('GATE_A_MUST_START_BLOCKED');
  }

  validateRuntime(manifest.runtime, add);
  validateToolchain(manifest.toolchain, add);

  if (!Array.isArray(manifest.candidates) || manifest.candidates.length === 0) {
    add('CANDIDATES_MISSING');
  }
  const candidates = Array.isArray(manifest.candidates) ? manifest.candidates : [];
  const candidateById = new Map();
  for (const candidate of candidates) {
    validateCandidate(candidate, add);
    if (isRecord(candidate) && typeof candidate.id === 'string') {
      if (candidateById.has(candidate.id)) {
        add(`DUPLICATE_CANDIDATE_ID:${candidate.id}`);
      }
      candidateById.set(candidate.id, candidate);
    }
  }

  if (!Array.isArray(manifest.candidateSets) || manifest.candidateSets.length === 0) {
    add('CANDIDATE_SETS_MISSING');
  }
  const candidateSets = Array.isArray(manifest.candidateSets) ? manifest.candidateSets : [];
  const setIds = new Set();
  for (const candidateSet of candidateSets) {
    if (!isRecord(candidateSet) || !IDENTIFIER_PATTERN.test(candidateSet.id ?? '')) {
      add('CANDIDATE_SET_ID_INVALID');
      continue;
    }
    if (setIds.has(candidateSet.id)) {
      add(`DUPLICATE_CANDIDATE_SET_ID:${candidateSet.id}`);
    }
    setIds.add(candidateSet.id);
    if (!Array.isArray(candidateSet.candidateIds) || candidateSet.candidateIds.length === 0) {
      add(`CANDIDATE_SET_EMPTY:${candidateSet.id}`);
      continue;
    }
    const selected = candidateSet.candidateIds.map((id) => candidateById.get(id));
    if (selected.some((candidate) => candidate === undefined)) {
      add(`CANDIDATE_SET_UNKNOWN_MEMBER:${candidateSet.id}`);
      continue;
    }
    const actualLicenses = uniqueSorted(selected.map((candidate) => candidate.license.expression));
    const observedLicenses = uniqueSorted(
      selected.map((candidate) => candidate.license.observedMetadataExpression)
    );
    if (!sameStringSet(actualLicenses, candidateSet.licenseExpressions)) {
      add(`CANDIDATE_SET_LICENSES_DRIFTED:${candidateSet.id}`);
    }
    if (!sameStringSet(observedLicenses, candidateSet.observedMetadataExpressions)) {
      add(`CANDIDATE_SET_OBSERVED_LICENSES_DRIFTED:${candidateSet.id}`);
    }
    const actualConsistency = observedLicenses.length > 1
      ? 'UNRESOLVED_CONFLICT'
      : 'UNRESOLVED_SCOPE';
    if (actualLicenses.some((expression) => expression !== 'NOASSERTION')
        || candidateSet.licenseConsistency !== actualConsistency) {
      add(`CANDIDATE_SET_LICENSE_CONSISTENCY_INVALID:${candidateSet.id}`);
    }
    if (candidateSet.status !== 'BLOCKED_GATE_A') {
      add(`CANDIDATE_SET_NOT_BLOCKED:${candidateSet.id}`);
    }
  }

  const mismatchExists = candidateSets.some(
    (candidateSet) => candidateSet.licenseConsistency === 'UNRESOLVED_CONFLICT'
  );
  const blockerCodes = new Set(
    Array.isArray(manifest.gateA?.blockers)
      ? manifest.gateA.blockers.map((blocker) => blocker?.code)
      : []
  );
  if (mismatchExists && !blockerCodes.has('BIDIRECTIONAL_LICENSE_SET_MISMATCH')) {
    add('LICENSE_MISMATCH_NOT_BLOCKED');
  }
  if (candidates.some((candidate) => candidate.license?.expression === 'NOASSERTION')
      && !blockerCodes.has('WEIGHT_LICENSE_SCOPE_UNRESOLVED')) {
    add('UNRESOLVED_WEIGHT_LICENSE_NOT_BLOCKED');
  }
  if (candidates.some((candidate) => candidate.sourceFiles?.some((file) => file.purpose === 'conversion-pickle-weight'))
      && !blockerCodes.has('PICKLE_SOURCE_WEIGHT_ISOLATION_REVIEW_REQUIRED')) {
    add('PICKLE_WEIGHT_NOT_BLOCKED');
  }
  return uniqueSorted(errors);
}

function validateRuntime(runtime, add) {
  if (!isRecord(runtime)
      || runtime.id !== 'ctranslate2'
      || !GIT_SHA_PATTERN.test(runtime.commit ?? '')
      || !GIT_SHA_PATTERN.test(runtime.tagObjectSha ?? '')
      || runtime.license?.expression !== 'MIT'
      || !isHttpsUrl(runtime.source)
      || !isHttpsUrl(runtime.release)) {
    add('RUNTIME_PIN_INVALID');
    return;
  }
  validateWheel(runtime.windowsWheel, 'RUNTIME', add);
}

function validateToolchain(toolchain, add) {
  if (!Array.isArray(toolchain) || toolchain.length === 0) {
    add('TOOLCHAIN_MISSING');
    return;
  }
  const ids = new Set();
  for (const tool of toolchain) {
    if (!isRecord(tool)
        || !IDENTIFIER_PATTERN.test(tool.id ?? '')
        || typeof tool.version !== 'string'
        || tool.version.length === 0
        || typeof tool.license?.expression !== 'string'
        || !isHttpsUrl(tool.license?.evidence)) {
      add('TOOLCHAIN_ENTRY_INVALID');
      continue;
    }
    if (ids.has(tool.id)) {
      add(`TOOLCHAIN_DUPLICATE:${tool.id}`);
    }
    ids.add(tool.id);
    validateWheel(tool.wheel, `TOOLCHAIN_${tool.id}`, add);
  }
}

function validateWheel(wheel, prefix, add) {
  if (!isRecord(wheel)
      || typeof wheel.filename !== 'string'
      || !Number.isSafeInteger(wheel.size)
      || wheel.size <= 0
      || !SHA256_PATTERN.test(wheel.sha256 ?? '')
      || !isHttpsUrl(wheel.url)
      || new URL(wheel.url).hostname !== 'files.pythonhosted.org') {
    add(`${prefix}_WHEEL_PIN_INVALID`);
  }
}

function validateCandidate(candidate, add) {
  if (!isRecord(candidate)
      || !IDENTIFIER_PATTERN.test(candidate.id ?? '')
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate.repository ?? '')
      || !GIT_SHA_PATTERN.test(candidate.revision ?? '')
      || !['MarianMT', 'M2M100'].includes(candidate.architecture)
      || candidate.gated !== false
      || !isHttpsUrl(candidate.modelCard)
      || !candidate.modelCard.includes(candidate.revision)) {
    add(`CANDIDATE_IDENTITY_INVALID:${candidate?.id ?? 'unknown'}`);
    return;
  }
  if (typeof candidate.license?.expression !== 'string'
      || candidate.license.expression !== 'NOASSERTION'
      || candidate.license.status !== 'UNRESOLVED'
      || typeof candidate.license.observedMetadataExpression !== 'string'
      || candidate.license.observedMetadataExpression.length === 0
      || candidate.license.commercialUseConclusion !== 'NOT_ESTABLISHED'
      || candidate.license.requiresGateAForIntegration !== true
      || !isHttpsUrl(candidate.license.evidence)
      || !isHttpsUrl(candidate.license.upstreamLicenseEvidence)
      || !candidate.license.evidence.includes(candidate.revision)) {
    add(`CANDIDATE_LICENSE_PIN_INVALID:${candidate.id}`);
  }
  if (!Array.isArray(candidate.routes) || candidate.routes.length === 0) {
    add(`CANDIDATE_ROUTES_MISSING:${candidate.id}`);
  } else {
    for (const route of candidate.routes) {
      if (!isRecord(route)
          || !ROUTE_LANGUAGES.has(route.source)
          || !ROUTE_LANGUAGES.has(route.target)
          || route.source === route.target) {
        add(`CANDIDATE_ROUTE_INVALID:${candidate.id}`);
      }
    }
  }
  if (!Array.isArray(candidate.sourceFiles) || candidate.sourceFiles.length === 0) {
    add(`CANDIDATE_FILES_MISSING:${candidate.id}`);
    return;
  }
  const paths = new Set();
  for (const file of candidate.sourceFiles) {
    if (!isSafeRelativeArtifactPath(file?.path)
        || !Number.isSafeInteger(file?.size)
        || file.size <= 0
        || !['sha256', 'git-blob-sha1'].includes(file?.digestAlgorithm)
        || !digestMatchesAlgorithm(file?.digest, file?.digestAlgorithm)
        || typeof file?.purpose !== 'string') {
      add(`CANDIDATE_FILE_PIN_INVALID:${candidate.id}`);
      continue;
    }
    if (paths.has(file.path)) {
      add(`CANDIDATE_FILE_DUPLICATE:${candidate.id}:${file.path}`);
    }
    paths.add(file.path);
  }
  if (!paths.has('pytorch_model.bin')) {
    add(`CANDIDATE_WEIGHT_MISSING:${candidate.id}`);
  }
  if (!isRecord(candidate.conversion)
      || candidate.conversion.converter !== 'ctranslate2.converters.TransformersConverter'
      || candidate.conversion.quantization !== 'int8'
      || candidate.conversion.trustRemoteCode !== false
      || !Array.isArray(candidate.conversion.copyFiles)
      || candidate.conversion.copyFiles.some((path) => !paths.has(path))) {
    add(`CANDIDATE_CONVERSION_POLICY_INVALID:${candidate.id}`);
  }
}

export function summarizeCandidate(manifest, candidate) {
  const sourceBytes = candidate.sourceFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    id: candidate.id,
    architecture: candidate.architecture,
    repository: candidate.repository,
    revision: candidate.revision,
    routes: candidate.routes.map(({ source, target }) => `${source}-${target}`),
    licenseExpression: candidate.license.expression,
    observedLicenseMetadataExpression: candidate.license.observedMetadataExpression,
    commercialUseConclusion: candidate.license.commercialUseConclusion,
    sourceFileCount: candidate.sourceFiles.length,
    sourceBytes,
    weightBytes: candidate.sourceFiles
      .filter((file) => file.purpose === 'conversion-pickle-weight')
      .reduce((sum, file) => sum + file.size, 0),
    quantization: manifest.policy.conversionQuantization,
    trustRemoteCode: manifest.policy.conversionTrustRemoteCode
  };
}

export function selectedCandidates(manifest, options) {
  const byId = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
  let ids;
  if (options.candidateId) {
    ids = [options.candidateId];
  } else if (options.candidateSetId) {
    const candidateSet = manifest.candidateSets.find((item) => item.id === options.candidateSetId);
    if (!candidateSet) {
      throw new PocError('UNKNOWN_CANDIDATE_SET');
    }
    ids = candidateSet.candidateIds;
  } else {
    throw new PocError('CANDIDATE_SELECTION_REQUIRED');
  }
  const candidates = ids.map((id) => byId.get(id));
  if (candidates.some((candidate) => candidate === undefined)) {
    throw new PocError('UNKNOWN_CANDIDATE');
  }
  return candidates;
}

export function selectedResearchRiskCodes(manifest, candidateIds) {
  const selected = new Set(candidateIds);
  const candidateSetIds = new Set(
    manifest.candidateSets
      .filter((candidateSet) => candidateSet.candidateIds.some((id) => selected.has(id)))
      .map((candidateSet) => candidateSet.id)
  );
  return uniqueSorted(
    manifest.gateA.blockers
      .filter((blocker) => blocker.appliesTo.some(
        (subject) => selected.has(subject)
          || candidateSetIds.has(subject)
          || subject === 'ctranslate2-transformers-toolchain'
      ))
      .map((blocker) => blocker.code)
  );
}

export function createPendingPocAuthorization(manifest, candidateIds) {
  const candidates = candidateIds.map((id) => {
    const candidate = manifest.candidates.find((item) => item.id === id);
    if (!candidate) {
      throw new PocError('UNKNOWN_CANDIDATE');
    }
    return candidate;
  });
  return {
    schemaVersion: POC_AUTHORIZATION_SCHEMA_VERSION,
    authorization: 'PENDING',
    scope: POC_RESEARCH_SCOPE,
    basis: 'PHASE7_M0_USER_AUTHORIZATION',
    manifestSha256: manifestSha256(manifest),
    candidateIds: [...candidateIds].sort(),
    observedLicenseMetadataExpressions: uniqueSorted(
      candidates.map((candidate) => candidate.license.observedMetadataExpression)
    ),
    acknowledgedRiskCodes: selectedResearchRiskCodes(manifest, candidateIds),
    authorizationRecordId: 'UNASSIGNED',
    authorizedAt: null
  };
}

export function verifyPocAuthorization(authorization, manifest, candidateIds) {
  if (!isRecord(authorization)
      || authorization.schemaVersion !== POC_AUTHORIZATION_SCHEMA_VERSION
      || authorization.authorization !== 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      || authorization.scope !== POC_RESEARCH_SCOPE
      || authorization.basis !== 'PHASE7_M0_USER_AUTHORIZATION'
      || authorization.manifestSha256 !== manifestSha256(manifest)
      || !sameStringSet(authorization.candidateIds, candidateIds)
      || typeof authorization.authorizationRecordId !== 'string'
      || authorization.authorizationRecordId.length < 1
      || authorization.authorizationRecordId === 'UNASSIGNED'
      || typeof authorization.authorizedAt !== 'string'
      || Number.isNaN(Date.parse(authorization.authorizedAt))) {
    throw new PocError('POC_AUTHORIZATION_INVALID_OR_STALE');
  }
  const candidates = candidateIds.map((id) => manifest.candidates.find((candidate) => candidate.id === id));
  if (candidates.some((candidate) => candidate === undefined)) {
    throw new PocError('POC_AUTHORIZATION_UNKNOWN_CANDIDATE');
  }
  const expectedObservedLicenses = uniqueSorted(
    candidates.map((candidate) => candidate.license.observedMetadataExpression)
  );
  if (!sameStringSet(
    authorization.observedLicenseMetadataExpressions,
    expectedObservedLicenses
  )) {
    throw new PocError('POC_AUTHORIZATION_OBSERVED_LICENSE_SET_MISMATCH');
  }
  const expectedRisks = selectedResearchRiskCodes(manifest, candidateIds);
  if (!sameStringSet(authorization.acknowledgedRiskCodes, expectedRisks)) {
    throw new PocError('POC_AUTHORIZATION_RISK_SET_MISMATCH');
  }
  return {
    authorization: authorization.authorization,
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizedAt: authorization.authorizedAt
  };
}

export function candidateDownloadUrl(candidate, file) {
  const encodedPath = file.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://huggingface.co/${candidate.repository}/resolve/${candidate.revision}/${encodedPath}?download=true`;
}

export function assertNetworkPermission({ operationRequested, allowNetwork }) {
  if (operationRequested && !allowNetwork) {
    throw new PocError('NETWORK_OPERATION_REQUIRES_ALLOW_NETWORK');
  }
}

export function resolveArtifactOutput(path) {
  const target = resolve(path);
  const relation = relative(DEFAULT_ARTIFACT_ROOT, target);
  if (relation === ''
      || relation.startsWith(`..${sep}`)
      || relation === '..'
      || isAbsolute(relation)) {
    throw new PocError('OUTPUT_MUST_BE_CHILD_OF_PHASE7_ARTIFACT_ROOT');
  }
  return target;
}

export async function assertNoReparsePointsWithinArtifactRoot(target) {
  return assertNoReparsePointsWithinRoot({
    repositoryRoot: REPOSITORY_ROOT,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    target
  });
}

export async function assertNoReparsePointsWithinRoot({
  repositoryRoot,
  artifactRoot,
  target
}) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedArtifactRoot = resolve(artifactRoot);
  const resolvedTarget = resolve(target);
  assertStrictChild(resolvedRepositoryRoot, resolvedArtifactRoot, 'ARTIFACT_ROOT_MUST_BE_REPOSITORY_CHILD');
  assertStrictChild(resolvedArtifactRoot, resolvedTarget, 'OUTPUT_MUST_BE_CHILD_OF_PHASE7_ARTIFACT_ROOT');

  const repositoryReal = await realpathOrSelf(resolvedRepositoryRoot);
  const artifactRootRelation = relative(resolvedRepositoryRoot, resolvedArtifactRoot);
  const artifactRootSegments = artifactRootRelation.split(/[\\/]/u);
  let current = resolvedRepositoryRoot;
  for (const segment of artifactRootSegments) {
    current = resolve(current, segment);
    const status = await inspectExistingPath(current);
    if (status === null) {
      break;
    }
    if (status.isSymbolicLink()) {
      throw new PocError('ARTIFACT_ROOT_REPARSE_POINT_REJECTED');
    }
    const currentReal = await realpath(current);
    if (!isPathWithin(repositoryReal, currentReal, { allowSame: false })) {
      throw new PocError('ARTIFACT_ROOT_ESCAPES_REAL_REPOSITORY');
    }
  }

  const rootReal = await realpathOrSelf(resolvedArtifactRoot);
  const targetParent = resolve(resolvedTarget, '..');
  const relativeParent = relative(resolvedArtifactRoot, targetParent);
  const segments = relativeParent === '' ? [] : relativeParent.split(/[\\/]/u);
  current = resolvedArtifactRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    const status = await inspectExistingPath(current);
    if (status === null) {
      break;
    }
    if (status.isSymbolicLink()) {
      throw new PocError('ARTIFACT_PATH_REPARSE_POINT_REJECTED');
    }
    const currentReal = await realpath(current);
    if (!isPathWithin(rootReal, currentReal, { allowSame: true })) {
      throw new PocError('ARTIFACT_PATH_ESCAPES_REAL_ROOT');
    }
  }
  return resolvedTarget;
}

export async function writeJsonArtifact(path, value) {
  const target = await assertNoReparsePointsWithinArtifactRoot(path);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return target;
}

function digestMatchesAlgorithm(digest, algorithm) {
  if (algorithm === 'sha256') {
    return SHA256_PATTERN.test(digest ?? '');
  }
  if (algorithm === 'git-blob-sha1') {
    return GIT_SHA_PATTERN.test(digest ?? '');
  }
  return false;
}

function isHttpsUrl(value) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeRelativeArtifactPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (isAbsolute(value)) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right));
}

function assertStrictChild(parent, child, errorCode) {
  if (!isPathWithin(parent, child, { allowSame: false })) {
    throw new PocError(errorCode);
  }
}

function isPathWithin(parent, child, { allowSame }) {
  const relation = relative(parent, child);
  if (relation === '') {
    return allowSame;
  }
  return !relation.startsWith(`..${sep}`)
    && relation !== '..'
    && !isAbsolute(relation);
}

async function inspectExistingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function realpathOrSelf(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return resolve(path);
    }
    throw error;
  }
}

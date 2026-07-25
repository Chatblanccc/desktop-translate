import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile
} from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  DEFAULT_ARTIFACT_ROOT,
  POC_AUTHORIZATION_SCHEMA_VERSION,
  POC_RESEARCH_SCOPE,
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  canonicalJson,
  loadJson,
  resolveArtifactOutput,
  sha256Text
} from './lib.mjs';

export const BERGAMOT_MANIFEST_SCHEMA_VERSION = 'phase7-bergamot-poc-candidates-v1';
export const BERGAMOT_MEASUREMENT_SCHEMA_VERSION = 'phase7-bergamot-poc-measurement-v1';
export const DEFAULT_BERGAMOT_MANIFEST_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'bergamot-candidates.json'
);
export const DEFAULT_BERGAMOT_SUPPLY_ROOT = resolve(
  DEFAULT_ARTIFACT_ROOT,
  'bergamot',
  'supply-chain'
);
export const DEFAULT_BERGAMOT_RUNTIME_ROOT = resolve(
  DEFAULT_ARTIFACT_ROOT,
  'bergamot',
  'runtime-install'
);

const gunzipAsync = promisify(gunzip);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const REQUIRED_BLOCKERS = new Set([
  'ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK',
  'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED',
  'MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED',
  'NODE_23_RUNTIME_COMPATIBILITY_BLOCKED',
  'NPM_TARBALL_LICENSE_FILE_MISSING'
]);
const SIMPLE_ALLOWED_DOWNLOAD_HOSTS = new Set([
  'raw.githubusercontent.com',
  'registry.npmjs.org'
]);
const MOZILLA_MODEL_BUCKET_PATH =
  '/moz-fx-translations-data--303e-prod-translations-data/';

export async function loadBergamotManifest(path = DEFAULT_BERGAMOT_MANIFEST_PATH) {
  const manifest = await loadJson(path);
  const errors = validateBergamotManifest(manifest);
  if (errors.length > 0) {
    const error = new PocError('INVALID_BERGAMOT_MANIFEST');
    error.validationErrors = errors;
    throw error;
  }
  return manifest;
}

export function bergamotManifestSha256(manifest) {
  return sha256Text(canonicalJson(manifest));
}

export function validateBergamotManifest(manifest) {
  const errors = [];
  const add = (code) => errors.push(code);
  if (!isRecord(manifest)) {
    return ['BERGAMOT_MANIFEST_NOT_OBJECT'];
  }
  if (manifest.schemaVersion !== BERGAMOT_MANIFEST_SCHEMA_VERSION) {
    add('BERGAMOT_MANIFEST_SCHEMA_VERSION_INVALID');
  }
  if (!isRecord(manifest.policy)
      || manifest.policy.defaultNetworkAccess !== false
      || manifest.policy.largeDownloadsRequirePocAuthorization !== true
      || manifest.policy.pocAuthorizationScope !== POC_RESEARCH_SCOPE
      || manifest.policy.artifactRoot !== 'artifacts/phase7/offline-poc'
      || manifest.policy.packageInstallScriptsAllowed !== false
      || manifest.policy.runtimeExecutionMode !== 'OFFLINE_LOCAL_WASM'
      || !Number.isSafeInteger(manifest.policy.benchmarkWarmIterations)
      || manifest.policy.benchmarkWarmIterations < 1
      || !Number.isSafeInteger(manifest.policy.benchmarkRouteTimeoutMs)
      || manifest.policy.benchmarkRouteTimeoutMs < 1) {
    add('BERGAMOT_POLICY_FAIL_CLOSED_VALUES_INVALID');
  }
  if (!isRecord(manifest.gateA)
      || manifest.gateA.status !== 'BLOCKED'
      || manifest.gateA.blocksPocResearch !== false
      || manifest.gateA.harnessMayDecide !== false
      || !Array.isArray(manifest.gateA.blockers)) {
    add('BERGAMOT_GATE_A_MUST_START_BLOCKED');
  }
  const blockers = new Set(
    Array.isArray(manifest.gateA?.blockers)
      ? manifest.gateA.blockers.map((blocker) => blocker?.code)
      : []
  );
  for (const code of REQUIRED_BLOCKERS) {
    if (!blockers.has(code)) {
      add(`BERGAMOT_REQUIRED_BLOCKER_MISSING:${code}`);
    }
  }

  const evidenceIds = new Set();
  if (!Array.isArray(manifest.licenseEvidence) || manifest.licenseEvidence.length < 2) {
    add('BERGAMOT_LICENSE_EVIDENCE_MISSING');
  } else {
    for (const evidence of manifest.licenseEvidence) {
      if (!isRecord(evidence)
          || !ID_PATTERN.test(evidence.id ?? '')
          || !GIT_SHA_PATTERN.test(evidence.revision ?? '')
          || evidence.expression !== 'MPL-2.0'
          || !validPinnedFile(evidence)) {
        add(`BERGAMOT_LICENSE_EVIDENCE_INVALID:${evidence?.id ?? 'unknown'}`);
        continue;
      }
      if (evidenceIds.has(evidence.id)) {
        add(`BERGAMOT_LICENSE_EVIDENCE_DUPLICATE:${evidence.id}`);
      }
      evidenceIds.add(evidence.id);
    }
  }

  validateRuntime(manifest.runtime, add);
  const candidateById = new Map();
  const allLocalPaths = new Set();
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length !== 2) {
    add('BERGAMOT_BIDIRECTIONAL_CANDIDATES_REQUIRED');
  } else {
    for (const candidate of manifest.candidates) {
      validateCandidate(candidate, evidenceIds, add);
      if (isRecord(candidate) && typeof candidate.id === 'string') {
        if (candidateById.has(candidate.id)) {
          add(`BERGAMOT_CANDIDATE_DUPLICATE:${candidate.id}`);
        }
        candidateById.set(candidate.id, candidate);
      }
      for (const file of candidate?.sourceFiles ?? []) {
        if (allLocalPaths.has(file.localPath)) {
          add(`BERGAMOT_LOCAL_PATH_DUPLICATE:${file.localPath}`);
        }
        allLocalPaths.add(file.localPath);
      }
    }
  }
  for (const evidence of manifest.licenseEvidence ?? []) {
    if (allLocalPaths.has(evidence.localPath)) {
      add(`BERGAMOT_LOCAL_PATH_DUPLICATE:${evidence.localPath}`);
    }
    allLocalPaths.add(evidence.localPath);
  }
  if (isRecord(manifest.runtime?.tarball)) {
    if (allLocalPaths.has(manifest.runtime.tarball.localPath)) {
      add(`BERGAMOT_LOCAL_PATH_DUPLICATE:${manifest.runtime.tarball.localPath}`);
    }
    allLocalPaths.add(manifest.runtime.tarball.localPath);
  }

  if (!Array.isArray(manifest.candidateSets) || manifest.candidateSets.length !== 1) {
    add('BERGAMOT_CANDIDATE_SET_INVALID');
  } else {
    const set = manifest.candidateSets[0];
    const members = set?.candidateIds?.map((id) => candidateById.get(id));
    const bytes = Array.isArray(members) && members.every(Boolean)
      ? members.flatMap((candidate) => candidate.sourceFiles)
        .reduce((sum, file) => sum + file.size, 0)
      : -1;
    if (!isRecord(set)
        || !ID_PATTERN.test(set.id ?? '')
        || !Array.isArray(set.candidateIds)
        || set.candidateIds.length !== 2
        || new Set(set.candidateIds).size !== 2
        || members?.some((candidate) => candidate === undefined)
        || set.runtimeId !== manifest.runtime?.id
        || set.status !== 'BLOCKED_GATE_A'
        || set.compressedBytes !== bytes) {
      add('BERGAMOT_CANDIDATE_SET_PIN_INVALID');
    }
  }
  return [...new Set(errors)].sort();
}

function validateRuntime(runtime, add) {
  if (!isRecord(runtime)
      || runtime.id !== 'browsermt-bergamot-translator-wasm'
      || runtime.packageName !== '@browsermt/bergamot-translator'
      || runtime.version !== '0.4.9'
      || runtime.declaredLicenseExpression !== 'MPL-2.0'
      || runtime.sourceCommit !== '8cc5d0495479c9ec56eafafd6bcd7fb5b929ca98'
      || runtime.packageContainsLicenseFile !== false
      || runtime.installScriptsAllowed !== false
      || runtime.node23Compatibility !== 'BLOCKED'
      || !isHttpsUrl(runtime.sourceRepository)
      || !isHttpsUrl(runtime.sourceLicenseEvidence)) {
    add('BERGAMOT_RUNTIME_PIN_INVALID');
    return;
  }
  const tarball = runtime.tarball;
  if (!validPinnedFile(tarball)
      || tarball.filename !== 'browsermt-bergamot-translator-0.4.9.tgz'
      || tarball.localPath !== 'runtime/browsermt-bergamot-translator-0.4.9.tgz'
      || tarball.size !== 1_852_075
      || tarball.sha1 !== '224cd32c6e89c92a0d4945dc0fceb4400dcb2ae4'
      || tarball.sha256 !== '9011be93222d839d7448ffdf00549d53ce8f541fd782ffc79779d1756397c41f'
      || tarball.integrity !== 'sha512-bNuuCwM/JnsIYQCKXcYKFT4Qc5vLMoB8Nbvz8ReIgs7xzebK8Sa+R8iEK8mLvNBe/WaZ6zrPaUQilLsRT/ea8Q=='
      || tarball.unpackedSize !== 5_314_609
      || tarball.fileCount !== 7) {
    add('BERGAMOT_RUNTIME_TARBALL_PIN_INVALID');
  }
}

function validateCandidate(candidate, evidenceIds, add) {
  if (!isRecord(candidate)
      || !ID_PATTERN.test(candidate.id ?? '')
      || candidate.repository !== 'mozilla/firefox-translations-models'
      || !GIT_SHA_PATTERN.test(candidate.revision ?? '')
      || candidate.architecture !== 'BergamotMarianBaseMemoryIntgemm'
      || !isRecord(candidate.route)
      || !['en', 'zh'].includes(candidate.route.source)
      || !['en', 'zh'].includes(candidate.route.target)
      || candidate.route.source === candidate.route.target) {
    add(`BERGAMOT_CANDIDATE_IDENTITY_INVALID:${candidate?.id ?? 'unknown'}`);
    return;
  }
  if (!isRecord(candidate.license)
      || candidate.license.expression !== 'NOASSERTION'
      || candidate.license.status !== 'LEGAL_REVIEW_REQUIRED'
      || candidate.license.observedRepositoryExpression !== 'MPL-2.0'
      || candidate.license.commercialUseConclusion !== 'NOT_ESTABLISHED'
      || !evidenceIds.has(candidate.license.evidenceId)) {
    add(`BERGAMOT_CANDIDATE_LICENSE_INVALID:${candidate.id}`);
  }
  if (!Array.isArray(candidate.sourceFiles)) {
    add(`BERGAMOT_CANDIDATE_FILES_MISSING:${candidate.id}`);
    return;
  }
  const parts = new Set();
  for (const file of candidate.sourceFiles) {
    if (!validPinnedFile(file)
        || !['gzip', 'none'].includes(file.compression)
        || ![
          'metadata',
          'model',
          'shared-vocabulary',
          'shortlist',
          'source-vocabulary',
          'target-vocabulary'
        ].includes(file.runtimePart)) {
      add(`BERGAMOT_CANDIDATE_FILE_INVALID:${candidate.id}`);
      continue;
    }
    if (parts.has(file.runtimePart)) {
      add(`BERGAMOT_CANDIDATE_RUNTIME_PART_DUPLICATE:${candidate.id}:${file.runtimePart}`);
    }
    parts.add(file.runtimePart);
  }
  const expectedParts = candidate.route.source === 'en'
    ? ['metadata', 'model', 'shortlist', 'source-vocabulary', 'target-vocabulary']
    : ['metadata', 'model', 'shared-vocabulary', 'shortlist'];
  if (!sameStringSet([...parts], expectedParts)) {
    add(`BERGAMOT_CANDIDATE_RUNTIME_PARTS_INVALID:${candidate.id}`);
  }
}

function validPinnedFile(file) {
  return isRecord(file)
    && isSafeRelativePath(file.path ?? file.filename)
    && isSafeRelativePath(file.localPath)
    && Number.isSafeInteger(file.size)
    && file.size > 0
    && SHA256_PATTERN.test(file.sha256 ?? '')
    && isAllowedDownloadUrl(file.url);
}

export function selectBergamotCandidates(manifest, options = {}) {
  const byId = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
  let ids;
  if (options.candidateId) {
    ids = [options.candidateId];
  } else {
    const setId = options.candidateSetId
      ?? 'firefox-bergamot-base-memory-en-zh-bidirectional';
    const set = manifest.candidateSets.find((candidateSet) => candidateSet.id === setId);
    if (!set) {
      throw new PocError('UNKNOWN_BERGAMOT_CANDIDATE_SET');
    }
    ids = set.candidateIds;
  }
  const candidates = ids.map((id) => byId.get(id));
  if (candidates.some((candidate) => candidate === undefined)) {
    throw new PocError('UNKNOWN_BERGAMOT_CANDIDATE');
  }
  return candidates;
}

export function selectedBergamotRiskCodes(manifest, candidateIds) {
  const subjects = new Set([...candidateIds, manifest.runtime.id]);
  return [...new Set(
    manifest.gateA.blockers
      .filter((blocker) => blocker.appliesTo.some((subject) => subjects.has(subject)))
      .map((blocker) => blocker.code)
  )].sort();
}

export function createPendingBergamotAuthorization(manifest, candidateIds) {
  assertKnownCandidateIds(manifest, candidateIds);
  return {
    schemaVersion: POC_AUTHORIZATION_SCHEMA_VERSION,
    authorization: 'PENDING',
    scope: POC_RESEARCH_SCOPE,
    basis: 'PHASE7_M0_USER_AUTHORIZATION',
    manifestSha256: bergamotManifestSha256(manifest),
    candidateIds: [...candidateIds].sort(),
    observedLicenseMetadataExpressions: ['MPL-2.0'],
    acknowledgedRiskCodes: selectedBergamotRiskCodes(manifest, candidateIds),
    authorizationRecordId: 'UNASSIGNED',
    authorizedAt: null
  };
}

export function verifyBergamotAuthorization(authorization, manifest, candidateIds) {
  assertKnownCandidateIds(manifest, candidateIds);
  if (!isRecord(authorization)
      || authorization.schemaVersion !== POC_AUTHORIZATION_SCHEMA_VERSION
      || authorization.authorization !== 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      || authorization.scope !== POC_RESEARCH_SCOPE
      || authorization.basis !== 'PHASE7_M0_USER_AUTHORIZATION'
      || authorization.manifestSha256 !== bergamotManifestSha256(manifest)
      || !sameStringSet(authorization.candidateIds, candidateIds)
      || !sameStringSet(authorization.observedLicenseMetadataExpressions, ['MPL-2.0'])
      || !sameStringSet(
        authorization.acknowledgedRiskCodes,
        selectedBergamotRiskCodes(manifest, candidateIds)
      )
      || typeof authorization.authorizationRecordId !== 'string'
      || authorization.authorizationRecordId.length < 1
      || authorization.authorizationRecordId === 'UNASSIGNED'
      || typeof authorization.authorizedAt !== 'string'
      || Number.isNaN(Date.parse(authorization.authorizedAt))) {
    throw new PocError('BERGAMOT_POC_AUTHORIZATION_INVALID_OR_STALE');
  }
  return {
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizedAt: authorization.authorizedAt
  };
}

function assertKnownCandidateIds(manifest, candidateIds) {
  const known = new Set(manifest.candidates.map((candidate) => candidate.id));
  if (!Array.isArray(candidateIds)
      || candidateIds.length < 1
      || candidateIds.some((id) => !known.has(id))) {
    throw new PocError('BERGAMOT_AUTHORIZATION_UNKNOWN_CANDIDATE');
  }
}

export function selectedBergamotSupplyEntries(
  manifest,
  candidates,
  { includeModels = true } = {}
) {
  const entries = [
    {
      ...manifest.runtime.tarball,
      id: manifest.runtime.id,
      kind: 'runtime-tarball'
    },
    ...manifest.licenseEvidence.map((evidence) => ({
      ...evidence,
      kind: 'license-evidence'
    }))
  ];
  if (includeModels) {
    for (const candidate of candidates) {
      for (const file of candidate.sourceFiles) {
        entries.push({
          ...file,
          id: candidate.id,
          kind: file.runtimePart === 'metadata' ? 'model-metadata' : 'model-file'
        });
      }
    }
  }
  return entries;
}

export async function verifyBergamotSupply(
  manifest,
  candidates,
  {
    includeModels = true,
    supplyRoot = DEFAULT_BERGAMOT_SUPPLY_ROOT
  } = {}
) {
  const root = resolveArtifactOutput(resolve(supplyRoot));
  const entries = selectedBergamotSupplyEntries(manifest, candidates, { includeModels });
  const verified = [];
  for (const entry of entries) {
    const path = resolve(root, ...entry.localPath.split('/'));
    await assertNoReparsePointsWithinArtifactRoot(path);
    await verifyPinnedFile(path, entry);
    verified.push({
      localPath: entry.localPath,
      size: entry.size,
      sha256: entry.sha256
    });
  }
  return {
    fileCount: verified.length,
    totalBytes: verified.reduce((sum, entry) => sum + entry.size, 0),
    treeSha256: sha256Text(canonicalJson(verified.sort(compareLocalPath))),
    files: verified
  };
}

export async function verifyPinnedFile(path, pin) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PocError('BERGAMOT_SUPPLY_ARTIFACT_MISSING');
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size) {
    throw new PocError('BERGAMOT_SUPPLY_ARTIFACT_SIZE_MISMATCH');
  }
  const sha256 = createHash('sha256');
  const sha1 = pin.sha1 ? createHash('sha1') : null;
  const sha512 = pin.integrity ? createHash('sha512') : null;
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    sha256.update(chunk);
    sha1?.update(chunk);
    sha512?.update(chunk);
  }
  if (bytes !== pin.size || sha256.digest('hex') !== pin.sha256) {
    throw new PocError('BERGAMOT_SUPPLY_ARTIFACT_DIGEST_MISMATCH');
  }
  if (sha1 && sha1.digest('hex') !== pin.sha1) {
    throw new PocError('BERGAMOT_RUNTIME_TARBALL_SHA1_MISMATCH');
  }
  if (sha512 && `sha512-${sha512.digest('base64')}` !== pin.integrity) {
    throw new PocError('BERGAMOT_RUNTIME_TARBALL_INTEGRITY_MISMATCH');
  }
  return { size: bytes, sha256: pin.sha256 };
}

export async function materializeBergamotRuntime(
  manifest,
  {
    supplyRoot = DEFAULT_BERGAMOT_SUPPLY_ROOT,
    runtimeRoot = DEFAULT_BERGAMOT_RUNTIME_ROOT
  } = {}
) {
  const tarballPin = manifest.runtime.tarball;
  const tarballPath = resolve(supplyRoot, ...tarballPin.localPath.split('/'));
  await assertNoReparsePointsWithinArtifactRoot(tarballPath);
  await verifyPinnedFile(tarballPath, tarballPin);
  const compressed = await readFile(tarballPath);
  const archive = await gunzipAsync(compressed);
  const entries = parseTarEntries(archive);
  const fileEntries = entries.filter((entry) => entry.type === 'file');
  const totalBytes = fileEntries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (fileEntries.length !== tarballPin.fileCount
      || totalBytes !== tarballPin.unpackedSize
      || fileEntries.some((entry) => !entry.path.startsWith('package/'))
      || fileEntries.some((entry) => (
        entry.path === 'package/LICENSE'
        || entry.path === 'package/worker/package.json'
      ))) {
    throw new PocError('BERGAMOT_RUNTIME_TARBALL_CONTENTS_UNEXPECTED');
  }
  const installRoot = resolveArtifactOutput(resolve(
    runtimeRoot,
    `${manifest.runtime.version}-${tarballPin.sha256.slice(0, 12)}`
  ));
  await assertNoReparsePointsWithinArtifactRoot(resolve(installRoot, '_safety-probe'));
  await mkdir(installRoot, { recursive: true });
  const expected = new Map();
  for (const entry of fileEntries) {
    if (!isSafeRelativePath(entry.path)) {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_PATH_REJECTED');
    }
    const target = resolve(installRoot, ...entry.path.split('/'));
    await assertNoReparsePointsWithinArtifactRoot(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    const digest = createHash('sha256').update(entry.data).digest('hex');
    expected.set(entry.path, { size: entry.data.length, sha256: digest });
    const existing = await existingFileIdentity(target);
    if (existing === null) {
      await writeFile(target, entry.data, { flag: 'wx' });
    } else if (existing.size !== entry.data.length || existing.sha256 !== digest) {
      throw new PocError('BERGAMOT_MATERIALIZED_RUNTIME_MISMATCH');
    }
  }
  const actualPaths = await listFiles(installRoot);
  if (!sameStringSet(actualPaths, [...expected.keys()])) {
    throw new PocError('BERGAMOT_MATERIALIZED_RUNTIME_EXTRA_FILES');
  }
  return {
    packageRoot: resolve(installRoot, 'package'),
    fileCount: fileEntries.length,
    unpackedBytes: totalBytes,
    treeSha256: sha256Text(canonicalJson(
      [...expected.entries()]
        .map(([path, identity]) => ({ path, ...identity }))
        .sort((left, right) => left.path.localeCompare(right.path))
    )),
    packageMutated: false,
    installScriptsExecuted: false
  };
}

function parseTarEntries(archive) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const typeFlag = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_SIZE_INVALID');
    }
    offset += 512;
    if (offset + size > archive.length) {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_TRUNCATED');
    }
    if (typeFlag === '0' || typeFlag === '\0') {
      entries.push({ type: 'file', path, data: archive.subarray(offset, offset + size) });
    } else if (typeFlag !== '5') {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_ENTRY_TYPE_REJECTED');
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

async function existingFileIdentity(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PocError('BERGAMOT_MATERIALIZED_RUNTIME_MISMATCH');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function listFiles(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PocError('BERGAMOT_MATERIALIZED_RUNTIME_REPARSE_POINT_REJECTED');
    }
    if (entry.isDirectory()) {
      output.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      output.push(relative(root, path).split(sep).join('/'));
    } else {
      throw new PocError('BERGAMOT_MATERIALIZED_RUNTIME_SPECIAL_FILE_REJECTED');
    }
  }
  return output.sort();
}

export function isAllowedDownloadUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.hash) {
      return false;
    }
    if (SIMPLE_ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
      return true;
    }
    return parsed.hostname === 'storage.googleapis.com'
      && parsed.pathname.startsWith(MOZILLA_MODEL_BUCKET_PATH)
      && parsed.searchParams.size === 1
      && /^\d+$/u.test(parsed.searchParams.get('generation') ?? '');
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.includes('\\')
      || value.includes('\0')
      || isAbsolute(value)) {
    return false;
  }
  return !value.split('/').some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
  ));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function compareLocalPath(left, right) {
  return left.localPath.localeCompare(right.localPath);
}

export function sanitizedArtifactName(path) {
  return basename(path);
}

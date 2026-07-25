import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzip } from 'node:zlib';

import {
  POC_RESEARCH_SCOPE,
  REPOSITORY_ROOT,
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  assertNoReparsePointsWithinRoot,
  canonicalJson,
  resolveArtifactOutput,
  sha256Text
} from './lib.mjs';
import {
  bergamotManifestSha256,
  verifyPinnedFile
} from './bergamot-lib.mjs';

export const CORE_PACK_MANIFEST_SCHEMA_VERSION =
  'phase7-bergamot-core-pack-manifest-v1';
export const CORE_PACK_PREPARATION_SCHEMA_VERSION =
  'phase7-bergamot-core-pack-sizing-preparation-v1';
export const CORE_PACK_TARGET_BYTES = 300 * 1024 * 1024;
export const CORE_PACK_HARD_LIMIT_BYTES = 400 * 1024 * 1024;
export const BASE_INSTALLER_LIMIT_BYTES = 150 * 1024 * 1024;

const GENERATION_SCHEMA_VERSION =
  'phase7-gate-a-candidate-generation-v1';
const GENERATION_IDENTITY_SCHEMA_VERSION =
  'phase7-gate-a-candidate-generation-identity-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const EXPECTED_DIRECTIONS = new Set(['en-zh', 'zh-en']);
const ALLOWED_PAYLOAD_SUFFIXES = new Set([
  '.bin.gz',
  '.spm.gz',
  '.json',
  '.txt'
]);
const ARTIFACTS_ROOT = resolve(REPOSITORY_ROOT, 'artifacts');
const gunzipAsync = promisify(gunzip);

export async function loadCandidateGenerationSet({
  paths,
  manifest,
  candidates,
  authorizationRaw,
  authorizationRecordId,
  modelTreeByCandidate
}) {
  if (!Array.isArray(paths) || paths.length !== EXPECTED_DIRECTIONS.size) {
    throw new PocError('CORE_PACK_GENERATION_ARTIFACT_COUNT_INVALID');
  }
  if (!Buffer.isBuffer(authorizationRaw) || authorizationRaw.length < 1) {
    throw new PocError('CORE_PACK_AUTHORIZATION_RAW_INVALID');
  }
  const manifestSha256 = bergamotManifestSha256(manifest);
  const authorizationSha256 = sha256Bytes(authorizationRaw);
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  const bindings = [];
  for (const path of paths) {
    const artifact = await readPhase7JsonArtifact(
      path,
      'CORE_PACK_GENERATION_ARTIFACT'
    );
    const document = artifact.document;
    validateGenerationDocument(document);
    const identity = document.identity;
    const candidate = candidateById.get(identity.candidateId);
    const expectedDirection = candidate
      ? `${candidate.route.source}-${candidate.route.target}`
      : null;
    if (!candidate
        || identity.direction !== expectedDirection
        || identity.manifestSha256 !== manifestSha256
        || identity.authorizationSha256 !== authorizationSha256
        || identity.authorizationRecordId !== authorizationRecordId
        || identity.model.treeSha256
          !== modelTreeByCandidate.get(candidate.id)) {
      throw new PocError('CORE_PACK_GENERATION_BINDING_MISMATCH');
    }
    bindings.push({
      direction: identity.direction,
      candidateId: identity.candidateId,
      generationRunId: identity.generationRunId,
      generationArtifactSha256: artifact.sha256,
      generationIdentitySha256: document.identitySha256,
      sourceSetIdentitySha256: identity.sourceSet.identitySha256,
      sourceSetRecordCount: identity.sourceSet.recordCount,
      candidateOutputArtifactSha256:
        document.candidateOutput.artifactSha256,
      candidateOutputItemIdentitySetSha256:
        document.candidateOutput.itemIdentitySetSha256
    });
  }
  bindings.sort(compareCandidateBinding);
  if (!sameStringSet(
    bindings.map((binding) => binding.direction),
    EXPECTED_DIRECTIONS
  )
      || !sameStringSet(
        bindings.map((binding) => binding.candidateId),
        candidates.map((candidate) => candidate.id)
      )
      || new Set(
        bindings.map((binding) => binding.generationRunId)
      ).size !== bindings.length
      || new Set(
        bindings.map((binding) => binding.generationIdentitySha256)
      ).size !== bindings.length) {
    throw new PocError('CORE_PACK_GENERATION_SET_INVALID');
  }
  return {
    schemaVersion: 'phase7-gate-a-candidate-generation-set-v1',
    manifestSha256,
    authorizationSha256,
    authorizationRecordId,
    bindingSetSha256: candidateBindingSetSha256(bindings),
    bindings
  };
}

export async function createBergamotCorePackPlan({
  manifest,
  candidates,
  generationSet,
  supplyRoot
}) {
  if (!Array.isArray(candidates)
      || candidates.length !== EXPECTED_DIRECTIONS.size) {
    throw new PocError('CORE_PACK_CANDIDATE_SET_INVALID');
  }
  const payloadEntries = [];
  for (const candidate of [...candidates].sort(compareCandidate)) {
    const direction = `${candidate.route.source}-${candidate.route.target}`;
    for (const pin of candidate.sourceFiles) {
      const sourcePath = resolve(
        supplyRoot,
        ...pin.localPath.split('/')
      );
      await assertNoReparsePointsWithinArtifactRoot(sourcePath);
      await verifyPinnedFile(sourcePath, pin);
      const archivePath = `models/${direction}/${basename(pin.localPath)}`;
      assertDataOnlyArchivePath(archivePath);
      payloadEntries.push({
        archivePath,
        sourcePath,
        sizeBytes: pin.size,
        sha256: pin.sha256,
        role: pin.runtimePart,
        sourceCompression: pin.compression
      });
    }
  }
  const licenseIds = new Set(
    candidates.map((candidate) => candidate.license.evidenceId)
  );
  for (const pin of manifest.licenseEvidence
    .filter((entry) => licenseIds.has(entry.id))
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const sourcePath = resolve(supplyRoot, ...pin.localPath.split('/'));
    await assertNoReparsePointsWithinArtifactRoot(sourcePath);
    await verifyPinnedFile(sourcePath, pin);
    const archivePath = `licenses/${basename(pin.localPath)}`;
    assertDataOnlyArchivePath(archivePath);
    payloadEntries.push({
      archivePath,
      sourcePath,
      sizeBytes: pin.size,
      sha256: pin.sha256,
      role: 'license-evidence',
      sourceCompression: 'none'
    });
  }
  payloadEntries.sort((left, right) => (
    left.archivePath.localeCompare(right.archivePath)
  ));
  assertUniqueArchivePaths(payloadEntries);

  const packManifest = {
    schemaVersion: CORE_PACK_MANIFEST_SCHEMA_VERSION,
    status: 'RESEARCH_CORE_PACK_STAGED_LEGAL_REVIEW_REQUIRED',
    scope: POC_RESEARCH_SCOPE,
    archiveFormat: 'DETERMINISTIC_USTAR_GZIP',
    containsExecutableCode: false,
    sourceCandidateManifestSha256: generationSet.manifestSha256,
    sourceRepository: candidates[0].repository,
    sourceRevision: candidates[0].revision,
    runtime: {
      included: false,
      id: manifest.runtime.id,
      version: manifest.runtime.version
    },
    candidateGenerationBindingSetSha256:
      generationSet.bindingSetSha256,
    candidates: generationSet.bindings.map((binding) => {
      const candidate = candidates.find(
        (entry) => entry.id === binding.candidateId
      );
      return {
        candidateId: binding.candidateId,
        direction: binding.direction,
        generationIdentitySha256:
          binding.generationIdentitySha256,
        licenseExpression: candidate.license.expression,
        licenseStatus: candidate.license.status,
        observedRepositoryExpression:
          candidate.license.observedRepositoryExpression,
        commercialUseConclusion:
          candidate.license.commercialUseConclusion
      };
    }),
    files: payloadEntries.map((entry) => ({
      path: entry.archivePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      role: entry.role,
      sourceCompression: entry.sourceCompression
    })),
    gateA: {
      legalReviewComplete: false,
      integrationOrDistributionAuthorized: false
    }
  };
  const packManifestBytes = Buffer.from(
    `${JSON.stringify(packManifest, null, 2)}\n`,
    'utf8'
  );
  const entries = [
    {
      archivePath: 'pack-manifest.json',
      data: packManifestBytes,
      sizeBytes: packManifestBytes.length,
      sha256: sha256Bytes(packManifestBytes)
    },
    ...payloadEntries
  ];
  const installedSizeBytes = entries.reduce(
    (sum, entry) => sum + entry.sizeBytes,
    0
  );
  const installedTreeSha256 = sha256Text(canonicalJson(
    entries.map((entry) => ({
      path: entry.archivePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256
    }))
  ));
  return {
    packManifest,
    packManifestSha256: entries[0].sha256,
    entries,
    installedSizeBytes,
    installedTreeSha256
  };
}

export async function writeDeterministicTarGzip({
  entries,
  outputPath
}) {
  const target = resolveArtifactOutput(outputPath);
  await assertNoReparsePointsWithinArtifactRoot(target);
  validateArchiveEntries(entries);
  await mkdir(dirname(target), { recursive: true });
  let created = false;
  try {
    const output = createWriteStream(target, { flags: 'wx' });
    created = true;
    await pipeline(
      Readable.from(createTarChunks(entries)),
      createGzip({ level: 9, mtime: 0 }),
      output
    );
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new PocError('CORE_PACK_ARCHIVE_OUTPUT_INVALID');
    }
    const compressed = await readFile(target);
    const unpacked = await gunzipAsync(compressed);
    const expectedTarBytes = entries.reduce(
      (sum, entry) => (
        sum + 512 + entry.sizeBytes + tarPadding(entry.sizeBytes)
      ),
      1024
    );
    if (unpacked.length !== expectedTarBytes) {
      throw new PocError('CORE_PACK_ARCHIVE_TAR_SIZE_MISMATCH');
    }
    const archivedEntries = parseTarArchive(unpacked);
    if (archivedEntries.length !== entries.length) {
      throw new PocError('CORE_PACK_ARCHIVE_ENTRY_COUNT_MISMATCH');
    }
    for (let index = 0; index < entries.length; index += 1) {
      const expected = entries[index];
      const actual = archivedEntries[index];
      if (actual.path !== expected.archivePath
          || actual.sizeBytes !== expected.sizeBytes
          || sha256Bytes(actual.data) !== expected.sha256) {
        throw new PocError('CORE_PACK_ARCHIVE_POST_WRITE_VERIFY_FAILED');
      }
    }
    return {
      path: target,
      sizeBytes: stat.size,
      sha256: await sha256File(target),
      verifiedEntryCount: archivedEntries.length
    };
  } catch (error) {
    if (created) {
      await rm(target, { force: true });
    }
    throw error;
  }
}

export async function verifyBaseInstallerPackage({
  installerPath,
  unpackedPath,
  evidenceRoot,
  modelPins
}) {
  const installer = await assertRegularArtifactFile(installerPath);
  const installerSha256 = await sha256File(installer.path);
  if (installer.sizeBytes > BASE_INSTALLER_LIMIT_BYTES) {
    throw new PocError('CORE_PACK_BASE_INSTALLER_OVER_LIMIT');
  }
  const evidence = await assertArtifactDirectory(evidenceRoot);
  const binaryManifest = await readArtifactJson(
    resolve(evidence.path, 'binary-manifest.json')
  );
  const sizeManifest = await readArtifactJson(
    resolve(evidence.path, 'package', 'size-manifest.json')
  );
  const releaseManifest = await readArtifactJson(
    resolve(evidence.path, 'release', 'evidence-manifest.json')
  );
  const fileManifest = await readArtifactText(
    resolve(evidence.path, 'package', 'file-manifest.sha256')
  );
  const binaryInstaller = binaryManifest.document?.artifacts?.find(
    (artifact) => artifact.role === 'installer'
  );
  for (const candidate of [
    binaryInstaller,
    binaryManifest.document?.binaries?.installer,
    releaseManifest.document?.package?.installer
  ]) {
    if (candidate?.size !== installer.sizeBytes
        || candidate?.sha256 !== installerSha256) {
      throw new PocError('CORE_PACK_BASE_INSTALLER_EVIDENCE_MISMATCH');
    }
  }
  if (releaseManifest.document?.package?.status !== 'PASS'
      || sizeManifest.document?.installer?.bytes !== installer.sizeBytes
      || sizeManifest.document?.installer?.limitMebibytes !== 150
      || sizeManifest.document?.installer?.mebibytes > 150) {
    throw new PocError('CORE_PACK_BASE_INSTALLER_GATE_INVALID');
  }

  const expectedFiles = parseSha256FileManifest(fileManifest.rawText);
  const modelHashes = new Set(modelPins.map((pin) => pin.sha256));
  const modelNames = new Set(
    modelPins.map((pin) => basename(pin.localPath).toLowerCase())
  );
  const actualFiles = await listArtifactFiles(unpackedPath);
  if (!sameStringSet(
    actualFiles.map((file) => file.relativePath),
    expectedFiles.keys()
  )) {
    throw new PocError('CORE_PACK_BASE_UNPACKED_FILE_SET_MISMATCH');
  }
  for (const file of actualFiles) {
    const expectedSha256 = expectedFiles.get(file.relativePath);
    const actualSha256 = await sha256File(file.path);
    if (actualSha256 !== expectedSha256
        || modelHashes.has(actualSha256)
        || looksLikeModelPayload(file.relativePath, modelNames)) {
      throw new PocError('CORE_PACK_BASE_CONTAINS_MODEL_OR_HASH_MISMATCH');
    }
  }
  return {
    sha256: installerSha256,
    sizeBytes: installer.sizeBytes,
    containsModel: false,
    installedSizeBytes: sizeManifest.document.installed.bytes,
    evidence: {
      binaryManifestSha256: binaryManifest.sha256,
      sizeManifestSha256: sizeManifest.sha256,
      releaseEvidenceManifestSha256: releaseManifest.sha256,
      fileManifestSha256: fileManifest.sha256,
      unpackedFileCount: actualFiles.length
    }
  };
}

export function createCorePackSizingPreparation({
  baseInstaller,
  archive,
  plan,
  generationSet,
  measuredAt
}) {
  if (!validIsoDateTime(measuredAt)
      || archive.sizeBytes < 1
      || archive.sizeBytes > CORE_PACK_HARD_LIMIT_BYTES
      || archive.verifiedEntryCount !== plan.entries.length
      || plan.installedSizeBytes < archive.sizeBytes
      || baseInstaller.containsModel !== false
      || baseInstaller.sizeBytes > BASE_INSTALLER_LIMIT_BYTES) {
    throw new PocError('CORE_PACK_SIZING_PREPARATION_INVALID');
  }
  const customModelPathDecisionRequired =
    archive.sizeBytes > CORE_PACK_TARGET_BYTES;
  return {
    schemaVersion: CORE_PACK_PREPARATION_SCHEMA_VERSION,
    status:
      'PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET',
    scope: POC_RESEARCH_SCOPE,
    candidateGenerationBindingSetSha256:
      generationSet.bindingSetSha256,
    baseInstaller,
    coreModelPack: {
      sha256: archive.sha256,
      archiveSizeBytes: archive.sizeBytes,
      installedSizeBytes: plan.installedSizeBytes,
      installedTreeSha256: plan.installedTreeSha256,
      packManifestSha256: plan.packManifestSha256,
      archiveFormat: plan.packManifest.archiveFormat,
      entryCount: plan.entries.length,
      postWriteVerifiedEntryCount: archive.verifiedEntryCount,
      containsExecutableCode: false,
      runtimeIncluded: false,
      candidateGenerationIdentitySha256s:
        generationSet.bindings.map(
          (binding) => binding.generationIdentitySha256
        ).sort()
    },
    limits: {
      baseInstallerMaximumBytes: BASE_INSTALLER_LIMIT_BYTES,
      corePackTargetBytes: CORE_PACK_TARGET_BYTES,
      corePackHardMaximumBytes: CORE_PACK_HARD_LIMIT_BYTES,
      customModelPathDecisionRequired
    },
    finalization: {
      primaryEvidenceSetSha256: null,
      finalGateAPackageSizingStatus: 'NOT_CREATED',
      blockers: [
        'HUMAN_BLIND_EVALUATION_REPORT_NOT_AVAILABLE',
        'PRIMARY_EVIDENCE_SET_SHA256_NOT_AVAILABLE'
      ]
    },
    privacy: {
      sourceTextIncluded: false,
      translationTextIncluded: false,
      absolutePathsIncluded: false,
      usernamesIncluded: false
    },
    integrationOrDistributionAuthorized: false,
    measuredAt
  };
}

export function parseTarArchive(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarText(header.subarray(0, 100));
    const prefix = readTarText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      readTarText(header.subarray(124, 136)) || '0',
      8
    );
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new PocError('CORE_PACK_TAR_SIZE_INVALID');
    }
    const storedChecksum = Number.parseInt(
      readTarText(header.subarray(148, 156)).trim() || '0',
      8
    );
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const checksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== checksum) {
      throw new PocError('CORE_PACK_TAR_CHECKSUM_INVALID');
    }
    offset += 512;
    if (offset + size > buffer.length) {
      throw new PocError('CORE_PACK_TAR_TRUNCATED');
    }
    entries.push({
      path,
      sizeBytes: size,
      data: buffer.subarray(offset, offset + size)
    });
    offset += size + tarPadding(size);
  }
  return entries;
}

async function* createTarChunks(entries) {
  for (const entry of entries) {
    yield createTarHeader(entry.archivePath, entry.sizeBytes);
    let emitted = 0;
    if (Buffer.isBuffer(entry.data)) {
      emitted = entry.data.length;
      yield entry.data;
    } else {
      for await (const chunk of createReadStream(entry.sourcePath)) {
        emitted += chunk.length;
        yield chunk;
      }
    }
    if (emitted !== entry.sizeBytes) {
      throw new PocError('CORE_PACK_SOURCE_SIZE_CHANGED_DURING_ARCHIVE');
    }
    const padding = tarPadding(emitted);
    if (padding > 0) {
      yield Buffer.alloc(padding);
    }
  }
  yield Buffer.alloc(1024);
}

function createTarHeader(path, sizeBytes) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  writeTarText(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o444);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, sizeBytes);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarText(header, 257, 6, 'ustar\0');
  writeTarText(header, 263, 2, '00');
  if (prefix) {
    writeTarText(header, 345, 155, prefix);
  }
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, '0');
  header.write(encoded, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) {
    return { name: path, prefix: '' };
  }
  const segments = path.split('/');
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join('/');
    const name = segments.slice(index).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155
        && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new PocError('CORE_PACK_TAR_PATH_TOO_LONG');
}

function writeTarText(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new PocError('CORE_PACK_TAR_FIELD_TOO_LONG');
  }
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PocError('CORE_PACK_TAR_NUMERIC_FIELD_INVALID');
  }
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) {
    throw new PocError('CORE_PACK_TAR_NUMERIC_FIELD_OVERFLOW');
  }
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function readTarText(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end)
    .toString('utf8');
}

function tarPadding(size) {
  return (512 - (size % 512)) % 512;
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new PocError('CORE_PACK_ARCHIVE_ENTRIES_INVALID');
  }
  for (const entry of entries) {
    assertDataOnlyArchivePath(entry.archivePath);
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1
        || !SHA256.test(entry.sha256 ?? '')
        || (!Buffer.isBuffer(entry.data)
          && typeof entry.sourcePath !== 'string')) {
      throw new PocError('CORE_PACK_ARCHIVE_ENTRY_INVALID');
    }
    if (Buffer.isBuffer(entry.data)
        && (entry.data.length !== entry.sizeBytes
          || sha256Bytes(entry.data) !== entry.sha256)) {
      throw new PocError('CORE_PACK_ARCHIVE_BUFFER_IDENTITY_MISMATCH');
    }
  }
  assertUniqueArchivePaths(entries);
}

function assertDataOnlyArchivePath(path) {
  if (typeof path !== 'string'
      || path.length < 1
      || path.includes('\\')
      || path.startsWith('/')
      || path.endsWith('/')
      || path.split('/').some(
        (segment) => segment === '' || segment === '.' || segment === '..'
      )
      || isAbsolute(path)
      || ![...ALLOWED_PAYLOAD_SUFFIXES].some(
        (suffix) => path.toLowerCase().endsWith(suffix)
      )) {
    throw new PocError('CORE_PACK_NON_DATA_ARCHIVE_PATH_REJECTED');
  }
}

function assertUniqueArchivePaths(entries) {
  const normalized = entries.map(
    (entry) => entry.archivePath.toLowerCase()
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new PocError('CORE_PACK_DUPLICATE_ARCHIVE_PATH');
  }
}

function validateGenerationDocument(document) {
  if (!exactKeys(document, [
    'schemaVersion',
    'status',
    'scope',
    'identity',
    'identitySha256',
    'candidateOutput',
    'privacy',
    'gateA'
  ])
      || document.schemaVersion !== GENERATION_SCHEMA_VERSION
      || document.status
        !== 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE'
      || document.scope !== POC_RESEARCH_SCOPE) {
    throw new PocError('CORE_PACK_GENERATION_DOCUMENT_INVALID');
  }
  const identity = document.identity;
  if (!exactKeys(identity, [
    'schemaVersion',
    'direction',
    'candidateId',
    'generationRunId',
    'manifestSha256',
    'authorizationSha256',
    'authorizationRecordId',
    'model',
    'runtime',
    'sourceSet',
    'workloadIdentitySha256'
  ])
      || identity.schemaVersion !== GENERATION_IDENTITY_SCHEMA_VERSION
      || !EXPECTED_DIRECTIONS.has(identity.direction)
      || !SAFE_ID.test(identity.candidateId ?? '')
      || !SAFE_ID.test(identity.generationRunId ?? '')
      || !SAFE_ID.test(identity.authorizationRecordId ?? '')
      || !SHA256.test(identity.manifestSha256 ?? '')
      || !SHA256.test(identity.authorizationSha256 ?? '')
      || !SHA256.test(identity.workloadIdentitySha256 ?? '')
      || !exactKeys(identity.model, ['treeSha256'])
      || !SHA256.test(identity.model.treeSha256 ?? '')
      || !exactKeys(identity.runtime, [
        'materializedTreeSha256',
        'servedTreeSha256'
      ])
      || !SHA256.test(identity.runtime.materializedTreeSha256 ?? '')
      || !SHA256.test(identity.runtime.servedTreeSha256 ?? '')
      || !exactKeys(identity.sourceSet, [
        'schemaVersion',
        'recordCount',
        'identitySha256'
      ])
      || identity.sourceSet.schemaVersion
        !== 'phase7-gate-a-source-set-v1'
      || !Number.isSafeInteger(identity.sourceSet.recordCount)
      || identity.sourceSet.recordCount < 200
      || !SHA256.test(identity.sourceSet.identitySha256 ?? '')
      || document.identitySha256
        !== sha256Text(canonicalJson(identity))) {
    throw new PocError('CORE_PACK_GENERATION_IDENTITY_INVALID');
  }
  if (!exactKeys(document.candidateOutput, [
    'artifactSha256',
    'recordCount',
    'itemIdentitySetSha256',
    'rawTextEmittedInEvidence'
  ])
      || !SHA256.test(document.candidateOutput.artifactSha256 ?? '')
      || document.candidateOutput.recordCount
        !== identity.sourceSet.recordCount
      || !SHA256.test(
        document.candidateOutput.itemIdentitySetSha256 ?? ''
      )
      || document.candidateOutput.rawTextEmittedInEvidence !== false
      || !exactKeys(document.privacy, [
        'sourceTextInEvidence',
        'translationTextInEvidence',
        'absolutePathsInEvidence',
        'usernamesInEvidence'
      ])
      || Object.values(document.privacy).some((value) => value !== false)
      || !exactKeys(document.gateA, [
        'ready',
        'integrationOrDistributionAuthorized'
      ])
      || document.gateA.ready !== false
      || document.gateA.integrationOrDistributionAuthorized !== false) {
    throw new PocError('CORE_PACK_GENERATION_PRIVACY_OR_OUTPUT_INVALID');
  }
}

async function readPhase7JsonArtifact(path, prefix) {
  const target = resolveArtifactOutput(path);
  await assertNoReparsePointsWithinArtifactRoot(target);
  const file = await assertRegularFile(target, prefix);
  const raw = await readFile(file.path);
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PocError(`${prefix}_JSON_INVALID`);
  }
  return { document, sha256: sha256Bytes(raw) };
}

async function assertRegularArtifactFile(path) {
  const target = await assertNoReparsePointsWithinRoot({
    repositoryRoot: REPOSITORY_ROOT,
    artifactRoot: ARTIFACTS_ROOT,
    target: resolve(path)
  });
  return assertRegularFile(target, 'CORE_PACK_ARTIFACT');
}

async function assertArtifactDirectory(path) {
  const target = await assertNoReparsePointsWithinRoot({
    repositoryRoot: REPOSITORY_ROOT,
    artifactRoot: ARTIFACTS_ROOT,
    target: resolve(path)
  });
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PocError('CORE_PACK_ARTIFACT_DIRECTORY_INVALID');
  }
  return { path: target };
}

async function assertRegularFile(path, prefix) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PocError(`${prefix}_FILE_INVALID`);
  }
  return { path, sizeBytes: stat.size };
}

async function readArtifactJson(path) {
  const file = await assertRegularArtifactFile(path);
  const raw = await readFile(file.path);
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PocError('CORE_PACK_BASE_EVIDENCE_JSON_INVALID');
  }
  return { document, sha256: sha256Bytes(raw) };
}

async function readArtifactText(path) {
  const file = await assertRegularArtifactFile(path);
  const raw = await readFile(file.path);
  return {
    rawText: raw.toString('utf8'),
    sha256: sha256Bytes(raw)
  };
}

async function listArtifactFiles(rootPath) {
  const root = await assertArtifactDirectory(rootPath);
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relation = relative(root.path, path);
      if (relation === ''
          || relation.startsWith(`..${sep}`)
          || relation === '..'
          || isAbsolute(relation)
          || entry.isSymbolicLink()) {
        throw new PocError('CORE_PACK_BASE_UNPACKED_PATH_INVALID');
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new PocError('CORE_PACK_BASE_UNPACKED_REPARSE_REJECTED');
      }
      if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile() && stat.nlink === 1) {
        files.push({
          path,
          relativePath: relation.replaceAll('\\', '/')
        });
      } else {
        throw new PocError('CORE_PACK_BASE_UNPACKED_ENTRY_INVALID');
      }
    }
  }
  await visit(root.path);
  return files.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
  ));
}

function parseSha256FileManifest(rawText) {
  const entries = new Map();
  for (const line of rawText.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match) {
      throw new PocError('CORE_PACK_BASE_FILE_MANIFEST_INVALID');
    }
    const path = match[2].replaceAll('\\', '/');
    if (entries.has(path)
        || path.startsWith('/')
        || path.split('/').some(
          (segment) => segment === '' || segment === '.' || segment === '..'
        )) {
      throw new PocError('CORE_PACK_BASE_FILE_MANIFEST_PATH_INVALID');
    }
    entries.set(path, match[1]);
  }
  if (entries.size < 1) {
    throw new PocError('CORE_PACK_BASE_FILE_MANIFEST_EMPTY');
  }
  return entries;
}

function looksLikeModelPayload(path, modelNames) {
  const normalized = path.toLowerCase();
  const name = basename(normalized);
  return modelNames.has(name)
    || /(^|\/)(models?|model-packs?|bergamot)(\/|$)/u.test(normalized)
    || /(^|[._-])(intgemm|alphas|s2t|spm)([._-]|$)/u.test(name);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function candidateBindingSetSha256(bindings) {
  return sha256Text(canonicalJson(
    [...bindings].sort(compareCandidateBinding).map((binding) => ({
      direction: binding.direction,
      candidateId: binding.candidateId,
      generationRunId: binding.generationRunId,
      generationArtifactSha256: binding.generationArtifactSha256,
      generationIdentitySha256: binding.generationIdentitySha256,
      sourceSetIdentitySha256: binding.sourceSetIdentitySha256,
      sourceSetRecordCount: binding.sourceSetRecordCount,
      candidateOutputArtifactSha256:
        binding.candidateOutputArtifactSha256,
      candidateOutputItemIdentitySetSha256:
        binding.candidateOutputItemIdentitySetSha256
    }))
  ));
}

function compareCandidateBinding(left, right) {
  return left.direction.localeCompare(right.direction)
    || left.candidateId.localeCompare(right.candidateId)
    || left.generationRunId.localeCompare(right.generationRunId);
}

function compareCandidate(left, right) {
  return `${left.route.source}-${left.route.target}`.localeCompare(
    `${right.route.source}-${right.route.target}`
  );
}

function sameStringSet(values, expected) {
  const expectedSet = expected instanceof Set
    ? expected
    : new Set(expected);
  return values.length === expectedSet.size
    && new Set(values).size === values.length
    && values.every((value) => expectedSet.has(value));
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0')
      === [...keys].sort().join('\0');
}

function isRecord(value) {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function validIsoDateTime(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

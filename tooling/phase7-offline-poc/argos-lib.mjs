import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
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

export const ARGOS_MANIFEST_SCHEMA_VERSION =
  'phase7-argos-direct-poc-candidates-v1';
export const ARGOS_MATERIALIZATION_RECEIPT_SCHEMA_VERSION =
  'phase7-argos-materialization-receipt-v1';
export const DEFAULT_ARGOS_MANIFEST_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'argos-candidates.json'
);
export const DEFAULT_ARGOS_SUPPLY_ROOT = resolve(
  DEFAULT_ARTIFACT_ROOT,
  'argos',
  'supply'
);
export const DEFAULT_ARGOS_MATERIALIZED_ROOT = resolve(
  DEFAULT_ARTIFACT_ROOT,
  'argos',
  'materialized'
);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const AUTHORIZATION_RECORD_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const AUTHORIZATION_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SAFE_ZIP_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTION_FLAGS = 0x0041;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const WINDOWS_REPARSE_ATTRIBUTE = 0x0400;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_SYMBOLIC_LINK = 0xa000;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const MAX_MATERIALIZATION_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORIZATION_BYTES = 1024 * 1024;
const RECEIPT_FILENAME = '.argos-materialization-receipt.json';
const REQUIRED_BLOCKERS = new Set([
  'ARGOS_MODEL_PACKAGE_LICENSE_LEGAL_REVIEW_REQUIRED',
  'ARGOS_QUALITY_PERFORMANCE_AND_OS_NETWORK_EVIDENCE_MISSING',
  'ARGOS_TRANSITIVE_RUNTIME_LOCK_AND_SBOM_INCOMPLETE',
  'ARGOS_WINDOWS_RUNTIME_AND_PACKAGE_SIGNING_REVIEW_REQUIRED'
]);
const EXPECTED_CANDIDATE_IDS = new Set([
  'argos-opus-en-zh-1.9',
  'argos-opus-zh-en-1.9'
]);
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'argos-net.com',
  'files.pythonhosted.org',
  'www.python.org'
]);
const WINDOWS_RESERVED_NAMES = new Set([
  'AUX',
  'CLOCK$',
  'CON',
  'NUL',
  'PRN',
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
]);

export async function loadArgosManifest(path = DEFAULT_ARGOS_MANIFEST_PATH) {
  const manifest = await loadJson(path);
  const errors = validateArgosManifest(manifest);
  if (errors.length > 0) {
    const error = new PocError('INVALID_ARGOS_MANIFEST');
    error.validationErrors = errors;
    throw error;
  }
  return manifest;
}

export function argosManifestSha256(manifest) {
  return sha256Text(canonicalJson(manifest));
}

export function validateArgosManifest(manifest) {
  const errors = [];
  const add = (code) => errors.push(code);
  if (!isRecord(manifest)) {
    return ['ARGOS_MANIFEST_NOT_OBJECT'];
  }
  if (manifest.schemaVersion !== ARGOS_MANIFEST_SCHEMA_VERSION) {
    add('ARGOS_MANIFEST_SCHEMA_VERSION_INVALID');
  }
  if (!isRecord(manifest.metadataSnapshot)
      || manifest.metadataSnapshot.packageIndexRepository
        !== 'argosopentech/argospm-index'
      || manifest.metadataSnapshot.packageIndexRevision
        !== 'ff90de60728f7c1338ff6b75974e4c89b2442d22'
      || manifest.metadataSnapshot.argosTranslateRepository
        !== 'argosopentech/argos-translate'
      || manifest.metadataSnapshot.argosTranslateRevision
        !== 'c72ec9040a580bc5f9ad4272f2c8a685d9bc66dd'
      || !isHttpsUrl(manifest.metadataSnapshot.packageIndexUrl)
      || !manifest.metadataSnapshot.packageIndexUrl.includes(
        manifest.metadataSnapshot.packageIndexRevision
      )) {
    add('ARGOS_METADATA_REVISIONS_INVALID');
  }
  if (!isRecord(manifest.policy)
      || manifest.policy.scope !== POC_RESEARCH_SCOPE
      || manifest.policy.defaultNetworkAccess !== false
      || !sameStringArray(
        manifest.policy.downloadsRequireExplicitFlags,
        ['--download', '--allow-network']
      )
      || manifest.policy.downloadsRequireBoundResearchAuthorization !== true
      || manifest.policy.artifactRoot !== 'artifacts/phase7/offline-poc'
      || manifest.policy.globalPackageInstallationAllowed !== false
      || manifest.policy.automaticPackageInstallationAllowed !== false
      || manifest.policy.productIntegrationAllowed !== false
      || manifest.policy.modelDistributionAllowed !== false
      || manifest.policy.rawSourceOrTranslationTextInReportsAllowed !== false
      || manifest.policy.privateBlindEvaluationCandidateOutputAllowed !== true
      || !isPositiveSafeInteger(
        manifest.policy.maximumArchiveCompressionRatio
      )
      || !isPositiveSafeInteger(
        manifest.policy.maximumSingleExtractedFileBytes
      )) {
    add('ARGOS_POLICY_FAIL_CLOSED_VALUES_INVALID');
  }
  const blockerCodes = new Set(
    Array.isArray(manifest.gateA?.blockers)
      ? manifest.gateA.blockers.map((blocker) => blocker?.code)
      : []
  );
  if (!isRecord(manifest.gateA)
      || manifest.gateA.status !== 'BLOCKED'
      || manifest.gateA.harnessMayDecide !== false
      || manifest.gateA.blocksPocResearch !== false) {
    add('ARGOS_GATE_A_MUST_START_BLOCKED');
  }
  for (const code of REQUIRED_BLOCKERS) {
    if (!blockerCodes.has(code)) {
      add(`ARGOS_REQUIRED_BLOCKER_MISSING:${code}`);
    }
  }

  validateArgosRuntime(manifest.runtime, add);

  const candidates = Array.isArray(manifest.candidates)
    ? manifest.candidates
    : [];
  if (candidates.length !== 2) {
    add('ARGOS_EXACT_BIDIRECTIONAL_CANDIDATES_REQUIRED');
  }
  const candidateById = new Map();
  const localPaths = new Set();
  for (const candidate of candidates) {
    validateArgosCandidate(candidate, manifest.policy, add);
    if (typeof candidate?.id === 'string') {
      if (candidateById.has(candidate.id)) {
        add(`ARGOS_DUPLICATE_CANDIDATE:${candidate.id}`);
      }
      candidateById.set(candidate.id, candidate);
    }
    if (typeof candidate?.archive?.localPath === 'string') {
      if (localPaths.has(candidate.archive.localPath)) {
        add(`ARGOS_DUPLICATE_LOCAL_PATH:${candidate.archive.localPath}`);
      }
      localPaths.add(candidate.archive.localPath);
    }
  }
  if (!sameStringSet([...candidateById.keys()], [...EXPECTED_CANDIDATE_IDS])) {
    add('ARGOS_CANDIDATE_IDENTITIES_DRIFTED');
  }
  for (const wheel of runtimeWheels(manifest)) {
    if (localPaths.has(wheel.localPath)) {
      add(`ARGOS_DUPLICATE_LOCAL_PATH:${wheel.localPath}`);
    }
    localPaths.add(wheel.localPath);
  }
  const pythonDistributionPath =
    manifest.runtime?.python?.distribution?.localPath;
  if (typeof pythonDistributionPath === 'string') {
    if (localPaths.has(pythonDistributionPath)) {
      add(`ARGOS_DUPLICATE_LOCAL_PATH:${pythonDistributionPath}`);
    }
    localPaths.add(pythonDistributionPath);
  }

  const sets = Array.isArray(manifest.candidateSets)
    ? manifest.candidateSets
    : [];
  if (sets.length !== 1) {
    add('ARGOS_EXACT_CANDIDATE_SET_REQUIRED');
  } else {
    const set = sets[0];
    const selected = Array.isArray(set?.candidateIds)
      ? set.candidateIds.map((id) => candidateById.get(id))
      : [];
    const archiveBytes = selected.every(Boolean)
      ? selected.reduce((sum, candidate) => sum + candidate.archive.size, 0)
      : -1;
    const unpackedBytes = selected.every(Boolean)
      ? selected.reduce(
        (sum, candidate) => sum + candidate.archive.unpackedSize,
        0
      )
      : -1;
    const topLevelWheelBytes = topLevelRuntimeWheels(manifest).reduce(
      (sum, wheel) => sum + wheel.size,
      0
    );
    const dependencyWheelBytes = runtimeDependencyWheels(manifest).reduce(
      (sum, wheel) => sum + wheel.size,
      0
    );
    const pythonDistributionBytes =
      manifest.runtime?.python?.distribution?.size ?? -1;
    if (!isRecord(set)
        || set.id !== 'argos-opus-en-zh-bidirectional-1.9'
        || !sameStringSet(set.candidateIds, [...EXPECTED_CANDIDATE_IDS])
        || set.runtimeId !== manifest.runtime?.id
        || set.archiveBytes !== archiveBytes
        || set.archiveUnpackedBytes !== unpackedBytes
        || set.topLevelWheelBytes !== topLevelWheelBytes
        || set.dependencyWheelBytes !== dependencyWheelBytes
        || set.pythonDistributionBytes !== pythonDistributionBytes
        || set.pinnedDownloadBytes !== archiveBytes
          + topLevelWheelBytes
          + dependencyWheelBytes
          + pythonDistributionBytes
        || set.status !== 'BLOCKED_GATE_A') {
      add('ARGOS_CANDIDATE_SET_TOTALS_OR_POLICY_INVALID');
    }
  }
  return [...new Set(errors)].sort();
}

function validateArgosRuntime(runtime, add) {
  if (!isRecord(runtime)
      || runtime.id !== 'argos-direct-ctranslate2-runtime'
      || runtime.executionMode !== 'DIRECT_SENTENCEPIECE_AND_CTRANSLATE2'
      || runtime.python?.requiredMajorMinor !== '3.13'
      || runtime.python?.isolatedEnvironmentRequired !== true
      || runtime.executionTreeStatus
        !== 'PINNED_CONTROLLED_MATERIALIZATION_V1'
      || runtime.runtimeSupplySetSha256
        !== '467c14a8205fd3f10a82ee39424d792ca7daa80d64111defa160ff21df12ed88'
      || runtime.executionTreeSha256
        !== '161fdea29bd9910a7c9e33d64a8c733099bbdee0829e921adeb951c45268147c'
      || runtime.executionTreeFileCount !== 1_435
      || runtime.executionTreeBytes !== 132_513_327
      || runtime.excludedWheelFileCount !== 79
      || runtime.builderScriptSha256
        !== 'd6482b9c66dd79f4eefb392dac234b336a54bcfaaf5a17515986251d788ddf9e'
      || runtime.translationOptions?.beamSize !== 4
      || runtime.translationOptions?.replaceUnknowns !== true
      || runtime.translationOptions?.lengthPenalty !== 0.2
      || runtime.translationOptions?.device !== 'cpu') {
    add('ARGOS_RUNTIME_POLICY_INVALID');
  }
  const pythonDistribution = runtime?.python?.distribution;
  if (!isRecord(pythonDistribution)
      || pythonDistribution.filename
        !== 'python-3.13.10-embed-amd64.zip'
      || pythonDistribution.localPath
        !== 'runtime/python-3.13.10-embed-amd64.zip'
      || pythonDistribution.size !== 10_924_998
      || pythonDistribution.sha256
        !== 'e0780912ee37496035bfc81120cc18a0d93921842012d5e83a71b42110452965'
      || pythonDistribution.url
        !== 'https://www.python.org/ftp/python/3.13.10/python-3.13.10-embed-amd64.zip'
      || pythonDistribution.spdxUrl
        !== 'https://www.python.org/ftp/python/3.13.10/python-3.13.10-embed-amd64.zip.spdx.json') {
    add('ARGOS_PYTHON_DISTRIBUTION_PIN_INVALID');
  }
  const ctranslate2 = runtime?.ctranslate2;
  if (!isRecord(ctranslate2)
      || ctranslate2.version !== '4.8.1'
      || ctranslate2.tag !== 'v4.8.1'
      || ctranslate2.tagObjectSha
        !== '399239a790ad0da4e4363e0dcbb83495b5abd742'
      || ctranslate2.commit
        !== '0d8bcd362ac75ef860ef161d6f0efad0ae439ff0'
      || ctranslate2.declaredLicenseExpression !== 'MIT'
      || !isHttpsUrl(ctranslate2.source)
      || !isHttpsUrl(ctranslate2.licenseEvidence)) {
    add('ARGOS_CTRANSLATE2_IDENTITY_INVALID');
  }
  validateWheel(
    ctranslate2?.wheel,
    {
      filename: 'ctranslate2-4.8.1-cp313-cp313-win_amd64.whl',
      size: 19_220_784,
      sha256:
        'd52499f05a60a791aeadee28d609efa130142f376d1ea76b2b1c593bb01f8827'
    },
    'ARGOS_CTRANSLATE2_WHEEL',
    add
  );
  const expectedDependencies = new Map([
    ['numpy', {
      version: '2.2.6',
      filename: 'numpy-2.2.6-cp313-cp313-win_amd64.whl',
      size: 12_610_885,
      sha256:
        'b0544343a702fa80c95ad5d3d608ea3599dd54d4632df855e4c8d24eb6ecfa1c'
    }],
    ['PyYAML', {
      version: '6.0.3',
      filename: 'pyyaml-6.0.3-cp313-cp313-win_amd64.whl',
      size: 154_090,
      sha256:
        '79005a0d97d5ddabfeeea4cf676af11e647e41d81c9a7722a193022accdb6b7c'
    }],
    ['setuptools', {
      version: '80.9.0',
      filename: 'setuptools-80.9.0-py3-none-any.whl',
      size: 1_201_486,
      sha256:
        '062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922'
    }]
  ]);
  const dependencies = Array.isArray(runtime?.dependencyWheels)
    ? runtime.dependencyWheels
    : [];
  if (dependencies.length !== expectedDependencies.size) {
    add('ARGOS_RUNTIME_DEPENDENCY_LOCK_INVALID');
  }
  const observedPackages = new Set();
  for (const dependency of dependencies) {
    const expected = expectedDependencies.get(dependency?.package);
    if (!expected
        || observedPackages.has(dependency.package)
        || dependency.version !== expected.version) {
      add('ARGOS_RUNTIME_DEPENDENCY_LOCK_INVALID');
      continue;
    }
    observedPackages.add(dependency.package);
    validateWheel(
      dependency.wheel,
      expected,
      `ARGOS_RUNTIME_DEPENDENCY_${dependency.package.toUpperCase()}`,
      add
    );
  }
  const sentencepiece = runtime?.sentencepiece;
  if (!isRecord(sentencepiece)
      || sentencepiece.version !== '0.2.1'
      || sentencepiece.sourceRevision !== 'v0.2.1'
      || sentencepiece.declaredLicenseExpression !== 'Apache-2.0'
      || !isHttpsUrl(sentencepiece.source)
      || !isHttpsUrl(sentencepiece.licenseEvidence)) {
    add('ARGOS_SENTENCEPIECE_IDENTITY_INVALID');
  }
  validateWheel(
    sentencepiece?.wheel,
    {
      filename: 'sentencepiece-0.2.1-cp313-cp313-win_amd64.whl',
      size: 1_054_669,
      sha256:
        '10ed3dab2044c47f7a2e7b4969b0c430420cdd45735d78c8f853191fa0e3148b'
    },
    'ARGOS_SENTENCEPIECE_WHEEL',
    add
  );
}

function validateWheel(wheel, expected, prefix, add) {
  if (!isRecord(wheel)
      || wheel.filename !== expected.filename
      || wheel.size !== expected.size
      || wheel.sha256 !== expected.sha256
      || !isSafeRelativePath(wheel.localPath)
      || !isHttpsUrl(wheel.url)
      || new URL(wheel.url).hostname !== 'files.pythonhosted.org') {
    add(`${prefix}_PIN_INVALID`);
  }
}

function validateArgosCandidate(candidate, policy, add) {
  const prefix = candidate?.id ?? 'unknown';
  if (!isRecord(candidate)
      || !SAFE_ID_PATTERN.test(candidate.id ?? '')
      || !EXPECTED_CANDIDATE_IDS.has(candidate.id)
      || !isRecord(candidate.route)
      || !new Set(['en', 'zh']).has(candidate.route.source)
      || !new Set(['en', 'zh']).has(candidate.route.target)
      || candidate.route.source === candidate.route.target
      || candidate.indexMetadata?.packageVersion !== '1.9'
      || candidate.indexMetadata?.argosVersion !== '1.9.0') {
    add(`ARGOS_CANDIDATE_IDENTITY_INVALID:${prefix}`);
    return;
  }
  if (candidate.license?.expression !== 'NOASSERTION'
      || candidate.license?.status !== 'LEGAL_REVIEW_REQUIRED'
      || candidate.license?.commercialUseConclusion
        !== 'LEGAL_REVIEW_REQUIRED'
      || candidate.license?.packageReadmeObservation?.statementScope
        !== 'ORIGINAL_OPUS_MODEL_FROM_WHICH_THE_PACKAGED_MODEL_DERIVES'
      || candidate.license?.packageReadmeObservation?.observedExpression
        !== 'CC-BY-4.0'
      || candidate.license?.packageReadmeObservation?.coverageStatus
        !== 'LEGAL_REVIEW_REQUIRED') {
    add(`ARGOS_MODEL_LICENSE_MUST_REMAIN_UNRESOLVED:${prefix}`);
  }
  const expected = candidate.id === 'argos-opus-en-zh-1.9'
    ? {
      source: 'en',
      target: 'zh',
      code: 'translate-en_zh',
      filename: 'translate-en_zh-1_9.argosmodel',
      size: 70_743_021,
      sha256:
        '433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab',
      unpackedSize: 85_640_765,
      extractedTreeSha256:
        '65b50a0764aa356b7053984bff1b7f7bd867adc1058bf33be7776a53c53e1da2',
      flags: [0]
    }
    : {
      source: 'zh',
      target: 'en',
      code: 'translate-zh_en',
      filename: 'translate-zh_en-1_9.argosmodel',
      size: 74_481_402,
      sha256:
        '62e7af5a3a48b530e47b7b3e5c78c2de79073ecd815750d2bf3ab35b4a67da2d',
      unpackedSize: 86_137_496,
      extractedTreeSha256:
        '60b0a02913d6bd4082cd247c2686cf4c91e6dc634114d4fc1df641b72bfdeb34',
      flags: [0, ZIP_DATA_DESCRIPTOR_FLAG]
    };
  const archive = candidate.archive;
  if (candidate.route.source !== expected.source
      || candidate.route.target !== expected.target
      || candidate.indexMetadata.code !== expected.code
      || !isRecord(archive)
      || archive.filename !== expected.filename
      || archive.size !== expected.size
      || archive.sha256 !== expected.sha256
      || archive.unpackedSize !== expected.unpackedSize
      || archive.extractedFileCount !== 8
      || archive.extractedTreeSha256 !== expected.extractedTreeSha256
      || archive.centralDirectoryEntryCount !== 13
      || archive.packageRoot !== expected.filename.replace('.argosmodel', '/')
      || !isSafeRelativePath(archive.localPath)
      || archive.url !== `https://argos-net.com/v1/${expected.filename}`
      || !sameNumberSet(archive.allowedGeneralPurposeFlags, expected.flags)
      || !sameNumberArray(archive.allowedCompressionMethods, [0, 8])
      || !isPositiveSafeInteger(policy?.maximumArchiveCompressionRatio)
      || !isPositiveSafeInteger(policy?.maximumSingleExtractedFileBytes)) {
    add(`ARGOS_ARCHIVE_PIN_INVALID:${prefix}`);
  }
  const requiredFiles = new Set(archive?.requiredFiles ?? []);
  for (const required of [
    'README.md',
    'metadata.json',
    'model/config.json',
    'model/model.bin',
    'model/shared_vocabulary.json',
    'sentencepiece.model'
  ]) {
    if (!requiredFiles.has(required)) {
      add(`ARGOS_REQUIRED_ARCHIVE_FILE_MISSING:${prefix}:${required}`);
    }
  }
  if (!sameStringSet(
    archive?.requiredDirectoryPrefixes,
    ['model/', 'stanza/']
  )) {
    add(`ARGOS_REQUIRED_ARCHIVE_PREFIXES_INVALID:${prefix}`);
  }
  const embeddedPins = new Map(
    Array.isArray(archive?.embeddedFilePins)
      ? archive.embeddedFilePins.map((pin) => [pin.path, pin])
      : []
  );
  for (const path of ['README.md', 'metadata.json']) {
    const pin = embeddedPins.get(path);
    if (!isRecord(pin)
        || !isPositiveSafeInteger(pin.size)
        || !SHA256_PATTERN.test(pin.sha256 ?? '')) {
      add(`ARGOS_EMBEDDED_EVIDENCE_PIN_INVALID:${prefix}:${path}`);
    }
  }
}

export function selectArgosCandidates(manifest, options = {}) {
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('ARGOS_CANDIDATE_AND_SET_MUTUALLY_EXCLUSIVE');
  }
  if (options.candidateId) {
    const candidate = manifest.candidates.find(
      (item) => item.id === options.candidateId
    );
    if (!candidate) {
      throw new PocError('UNKNOWN_ARGOS_CANDIDATE');
    }
    return [candidate];
  }
  const setId = options.candidateSetId
    ?? 'argos-opus-en-zh-bidirectional-1.9';
  const candidateSet = manifest.candidateSets.find(
    (item) => item.id === setId
  );
  if (!candidateSet) {
    throw new PocError('UNKNOWN_ARGOS_CANDIDATE_SET');
  }
  return candidateSet.candidateIds.map((id) => {
    const candidate = manifest.candidates.find((item) => item.id === id);
    if (!candidate) {
      throw new PocError('ARGOS_CANDIDATE_SET_MEMBER_MISSING');
    }
    return candidate;
  });
}

export function selectedArgosRiskCodes(manifest, candidateIds) {
  const selected = new Set(candidateIds);
  return [...new Set(
    manifest.gateA.blockers
      .filter((blocker) => blocker.appliesTo.some(
        (subject) => selected.has(subject)
          || subject === manifest.runtime.id
      ))
      .map((blocker) => blocker.code)
  )].sort();
}

export function createPendingArgosAuthorization(manifest, candidateIds) {
  assertKnownArgosCandidateIds(manifest, candidateIds);
  return {
    schemaVersion: POC_AUTHORIZATION_SCHEMA_VERSION,
    authorization: 'PENDING',
    scope: POC_RESEARCH_SCOPE,
    basis: 'PHASE7_M0_USER_AUTHORIZATION',
    manifestSha256: argosManifestSha256(manifest),
    candidateIds: [...candidateIds].sort(),
    observedLicenseMetadataExpressions: ['CC-BY-4.0'],
    acknowledgedRiskCodes: selectedArgosRiskCodes(manifest, candidateIds),
    authorizationRecordId: 'UNASSIGNED',
    authorizedAt: null
  };
}

export function verifyArgosAuthorization(
  authorization,
  manifest,
  candidateIds
) {
  assertKnownArgosCandidateIds(manifest, candidateIds);
  if (!isRecord(authorization)
      || !sameStringSet(
        Object.keys(authorization),
        [
          'acknowledgedRiskCodes',
          'authorization',
          'authorizationRecordId',
          'authorizedAt',
          'basis',
          'candidateIds',
          'manifestSha256',
          'observedLicenseMetadataExpressions',
          'schemaVersion',
          'scope'
        ]
      )
      || authorization.schemaVersion !== POC_AUTHORIZATION_SCHEMA_VERSION
      || authorization.authorization !== 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      || authorization.scope !== POC_RESEARCH_SCOPE
      || authorization.basis !== 'PHASE7_M0_USER_AUTHORIZATION'
      || authorization.manifestSha256 !== argosManifestSha256(manifest)
      || !hasUniqueStrings(authorization.candidateIds)
      || !sameStringSet(authorization.candidateIds, candidateIds)
      || !hasUniqueStrings(
        authorization.observedLicenseMetadataExpressions
      )
      || !sameStringSet(
        authorization.observedLicenseMetadataExpressions,
        ['CC-BY-4.0']
      )
      || !hasUniqueStrings(authorization.acknowledgedRiskCodes)
      || !sameStringSet(
        authorization.acknowledgedRiskCodes,
        selectedArgosRiskCodes(manifest, candidateIds)
      )
      || !AUTHORIZATION_RECORD_ID_PATTERN.test(
        authorization.authorizationRecordId ?? ''
      )
      || typeof authorization.authorizedAt !== 'string'
      || !AUTHORIZATION_DATETIME_PATTERN.test(authorization.authorizedAt)
      || Number.isNaN(Date.parse(authorization.authorizedAt))) {
    throw new PocError('ARGOS_POC_AUTHORIZATION_INVALID_OR_STALE');
  }
  return {
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizedAt: authorization.authorizedAt,
    candidateIds: [...authorization.candidateIds].sort(),
    manifestSha256: authorization.manifestSha256
  };
}

export async function loadExactArgosAuthorization(
  path,
  manifest,
  candidateIds
) {
  const target = resolveArtifactOutput(resolve(path));
  await assertNoReparsePointsWithinArtifactRoot(target);
  const pathStat = await lstat(target);
  if (!pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || pathStat.size < 2
      || pathStat.size > MAX_AUTHORIZATION_BYTES) {
    throw new PocError('ARGOS_POC_AUTHORIZATION_FILE_UNSAFE');
  }
  const handle = await open(target, 'r');
  try {
    const before = await handle.stat();
    if (!sameFileIdentity(pathStat, before)
        || !before.isFile()
        || before.nlink !== 1
        || before.size < 2
        || before.size > MAX_AUTHORIZATION_BYTES) {
      throw new PocError('ARGOS_POC_AUTHORIZATION_FILE_UNSAFE');
    }
    const raw = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)
        || raw.length !== before.size) {
      throw new PocError('ARGOS_POC_AUTHORIZATION_CHANGED_DURING_READ');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
    }
    const authorization = parseJsonRejectDuplicateKeys(text);
    const verified = verifyArgosAuthorization(
      authorization,
      manifest,
      candidateIds
    );
    return {
      ...verified,
      authorizationSha256: createHash('sha256').update(raw).digest('hex')
    };
  } finally {
    await handle.close();
  }
}

function assertKnownArgosCandidateIds(manifest, candidateIds) {
  if (!Array.isArray(candidateIds)
      || candidateIds.length < 1
      || new Set(candidateIds).size !== candidateIds.length
      || candidateIds.some((id) => !manifest.candidates.some(
        (candidate) => candidate.id === id
      ))) {
    throw new PocError('ARGOS_AUTHORIZATION_UNKNOWN_CANDIDATE');
  }
}

function sameFileIdentity(left, right) {
  return (left.dev === 0 || right.dev === 0 || left.dev === right.dev)
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function parseJsonRejectDuplicateKeys(text) {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/[\t\n\r ]/u.test(text[cursor] ?? '')) {
      cursor += 1;
    }
  };
  const parseString = () => {
    if (text[cursor] !== '"') {
      throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
    }
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch {
          throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
        }
      }
      if (character === '\\') {
        cursor += 2;
      } else {
        if (character.charCodeAt(0) < 0x20) {
          throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
        }
        cursor += 1;
      }
    }
    throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
  };
  const parseValue = () => {
    skipWhitespace();
    const character = text[cursor];
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        const key = parseString();
        if (keys.has(key)) {
          throw new PocError(
            'ARGOS_POC_AUTHORIZATION_DUPLICATE_JSON_KEY'
          );
        }
        keys.add(key);
        skipWhitespace();
        if (text[cursor] !== ':') {
          throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
        }
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (text[cursor] === '}') {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ',') {
          throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
        }
        cursor += 1;
        skipWhitespace();
      }
    } else if (character === '[') {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        parseValue();
        skipWhitespace();
        if (text[cursor] === ']') {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ',') {
          throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
        }
        cursor += 1;
      }
    } else if (character === '"') {
      parseString();
      return;
    } else {
      const remainder = text.slice(cursor);
      const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u
        .exec(remainder)?.[0];
      if (!scalar) {
        throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
      }
      cursor += scalar.length;
      return;
    }
    throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
  };
  try {
    parseValue();
    skipWhitespace();
    if (cursor !== text.length) {
      throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof PocError) {
      throw error;
    }
    throw new PocError('ARGOS_POC_AUTHORIZATION_JSON_INVALID');
  }
}

export function selectedArgosSupplyEntries(
  manifest,
  candidates,
  { includeWheels = true } = {}
) {
  const entries = candidates.map((candidate) => ({
    id: candidate.id,
    kind: 'ARGOS_MODEL_ARCHIVE',
    ...candidate.archive
  }));
  if (includeWheels) {
    entries.push(
      {
        id: manifest.runtime.python.distribution.filename,
        kind: 'PYTHON_EMBEDDED_DISTRIBUTION',
        ...manifest.runtime.python.distribution
      },
      ...topLevelRuntimeWheels(manifest).map((wheel) => ({
        id: wheel.filename,
        kind: 'TOP_LEVEL_RUNTIME_WHEEL',
        ...wheel
      })),
      ...runtimeDependencyWheels(manifest).map((wheel) => ({
        id: wheel.filename,
        kind: 'RUNTIME_DEPENDENCY_WHEEL',
        ...wheel
      }))
    );
  }
  return entries;
}

function runtimeWheels(manifest) {
  return [
    ...topLevelRuntimeWheels(manifest),
    ...runtimeDependencyWheels(manifest)
  ];
}

function topLevelRuntimeWheels(manifest) {
  return [
    manifest.runtime?.ctranslate2?.wheel,
    manifest.runtime?.sentencepiece?.wheel
  ].filter(Boolean);
}

function runtimeDependencyWheels(manifest) {
  return (manifest.runtime?.dependencyWheels ?? [])
    .map((dependency) => dependency?.wheel)
    .filter(Boolean);
}

export function isAllowedArgosDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
      && !url.hash;
  } catch {
    return false;
  }
}

export async function verifyArgosPinnedFile(path, pin) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PocError('ARGOS_PINNED_FILE_MISSING');
    }
    throw error;
  }
  if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.size !== pin.size) {
    throw new PocError('ARGOS_PINNED_FILE_IDENTITY_MISMATCH');
  }
  const digest = await hashFile(path, pin.size);
  if (digest.size !== pin.size || digest.sha256 !== pin.sha256) {
    throw new PocError('ARGOS_PINNED_FILE_DIGEST_MISMATCH');
  }
  return digest;
}

export async function inspectArgosZip(archivePath, candidate) {
  const pin = candidate.archive;
  if (!isPositiveSafeInteger(pin.maximumArchiveCompressionRatio)
      || !isPositiveSafeInteger(pin.maximumSingleExtractedFileBytes)) {
    throw new PocError('ARGOS_ZIP_POLICY_LIMITS_REQUIRED');
  }
  await verifyArgosPinnedFile(archivePath, pin);
  const handle = await open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    const eocd = await readZipEndOfCentralDirectory(handle, stat.size);
    if (eocd.totalEntries !== pin.centralDirectoryEntryCount) {
      throw new PocError('ARGOS_ZIP_CENTRAL_ENTRY_COUNT_MISMATCH');
    }
    if (eocd.centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new PocError('ARGOS_ZIP_CENTRAL_DIRECTORY_TOO_LARGE');
    }
    const central = Buffer.alloc(eocd.centralDirectorySize);
    await readExactly(
      handle,
      central,
      eocd.centralDirectoryOffset,
      'ARGOS_ZIP_CENTRAL_DIRECTORY_TRUNCATED'
    );
    const entries = parseCentralDirectory(central, pin, eocd);
    await bindLocalHeaders(handle, entries, eocd.centralDirectoryOffset);
    validateArgosArchiveShape(entries, pin);
    return {
      schemaVersion: 'phase7-argos-zip-inspection-v1',
      candidateId: candidate.id,
      archiveSha256: pin.sha256,
      archiveBytes: pin.size,
      centralDirectoryEntryCount: entries.length,
      unpackedBytes: entries.reduce(
        (sum, entry) => sum + entry.uncompressedSize,
        0
      ),
      dataDescriptorEntryCount: entries.filter(
        (entry) => (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
      ).length,
      entries
    };
  } finally {
    await handle.close();
  }
}

async function readZipEndOfCentralDirectory(handle, archiveSize) {
  if (archiveSize < 22) {
    throw new PocError('ARGOS_ZIP_TOO_SMALL');
  }
  const tailSize = Math.min(archiveSize, MAX_EOCD_SEARCH_BYTES);
  const tail = Buffer.alloc(tailSize);
  await readExactly(
    handle,
    tail,
    archiveSize - tailSize,
    'ARGOS_ZIP_EOCD_READ_TRUNCATED'
  );
  let offset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength === tail.length) {
      offset = index;
      break;
    }
  }
  if (offset < 0) {
    throw new PocError('ARGOS_ZIP_EOCD_MISSING_OR_TRAILING_BYTES');
  }
  const diskNumber = tail.readUInt16LE(offset + 4);
  const centralDiskNumber = tail.readUInt16LE(offset + 6);
  const entriesOnDisk = tail.readUInt16LE(offset + 8);
  const totalEntries = tail.readUInt16LE(offset + 10);
  const centralDirectorySize = tail.readUInt32LE(offset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(offset + 16);
  if (diskNumber !== 0
      || centralDiskNumber !== 0
      || entriesOnDisk !== totalEntries) {
    throw new PocError('ARGOS_ZIP_MULTIDISK_REJECTED');
  }
  if (entriesOnDisk === ZIP64_SENTINEL_16
      || totalEntries === ZIP64_SENTINEL_16
      || centralDirectorySize === ZIP64_SENTINEL_32
      || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw new PocError('ARGOS_ZIP64_REJECTED');
  }
  const globalEocdOffset = archiveSize - tailSize + offset;
  if (centralDirectoryOffset + centralDirectorySize !== globalEocdOffset) {
    throw new PocError('ARGOS_ZIP_CENTRAL_DIRECTORY_BOUNDS_INVALID');
  }
  return {
    centralDirectoryOffset,
    centralDirectorySize,
    totalEntries
  };
}

function parseCentralDirectory(buffer, pin, eocd) {
  const entries = [];
  const caseFoldedNames = new Set();
  let cursor = 0;
  while (cursor < buffer.length) {
    if (cursor + 46 > buffer.length
        || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new PocError('ARGOS_ZIP_CENTRAL_HEADER_INVALID');
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || nameLength < 1) {
      throw new PocError('ARGOS_ZIP_CENTRAL_ENTRY_TRUNCATED');
    }
    if (compressedSize === ZIP64_SENTINEL_32
        || uncompressedSize === ZIP64_SENTINEL_32
        || localHeaderOffset === ZIP64_SENTINEL_32
        || diskStart === ZIP64_SENTINEL_16) {
      throw new PocError('ARGOS_ZIP64_REJECTED');
    }
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = buffer.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength
    );
    validateExtraFields(extra);
    const name = decodeZipName(nameBytes, flags);
    validateZipEntryName(name, pin.packageRoot);
    const collisionKey = name.toLowerCase();
    if (caseFoldedNames.has(collisionKey)) {
      throw new PocError('ARGOS_ZIP_CASE_INSENSITIVE_PATH_COLLISION');
    }
    caseFoldedNames.add(collisionKey);
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0
        || !pin.allowedGeneralPurposeFlags.includes(flags)) {
      throw new PocError('ARGOS_ZIP_GENERAL_PURPOSE_FLAGS_REJECTED');
    }
    if (!pin.allowedCompressionMethods.includes(method)
        || ![ZIP_METHOD_STORE, ZIP_METHOD_DEFLATE].includes(method)) {
      throw new PocError('ARGOS_ZIP_COMPRESSION_METHOD_REJECTED');
    }
    if (diskStart !== 0) {
      throw new PocError('ARGOS_ZIP_MULTIDISK_REJECTED');
    }
    const directory = name.endsWith('/');
    validateExternalAttributes(
      versionMadeBy,
      externalAttributes,
      directory
    );
    if (directory
        && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new PocError('ARGOS_ZIP_DIRECTORY_HAS_DATA');
    }
    if (!directory
        && uncompressedSize
          > pin.maximumSingleExtractedFileBytes) {
      throw new PocError('ARGOS_ZIP_SINGLE_FILE_SIZE_LIMIT_EXCEEDED');
    }
    if (!directory
        && compressedSize === 0
        && uncompressedSize !== 0) {
      throw new PocError('ARGOS_ZIP_IMPOSSIBLE_COMPRESSION_SIZE');
    }
    if (!directory
        && compressedSize > 0
        && uncompressedSize / compressedSize
          > pin.maximumArchiveCompressionRatio) {
      throw new PocError('ARGOS_ZIP_COMPRESSION_RATIO_LIMIT_EXCEEDED');
    }
    entries.push({
      name,
      relativePath: name.slice(pin.packageRoot.length),
      directory,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: null
    });
    cursor = end;
  }
  if (cursor !== buffer.length || entries.length !== eocd.totalEntries) {
    throw new PocError('ARGOS_ZIP_CENTRAL_DIRECTORY_COUNT_INVALID');
  }
  return entries;
}

function validateExtraFields(extra) {
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) {
      throw new PocError('ARGOS_ZIP_EXTRA_FIELD_TRUNCATED');
    }
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.length) {
      throw new PocError('ARGOS_ZIP_EXTRA_FIELD_TRUNCATED');
    }
    if (id === ZIP64_EXTRA_ID) {
      throw new PocError('ARGOS_ZIP64_REJECTED');
    }
    cursor += size;
  }
}

function decodeZipName(nameBytes, flags) {
  if ((flags & ZIP_UTF8_FLAG) === 0
      && nameBytes.some((value) => value > 0x7f)) {
    throw new PocError('ARGOS_ZIP_NON_ASCII_LEGACY_NAME_REJECTED');
  }
  const name = nameBytes.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(nameBytes)) {
    throw new PocError('ARGOS_ZIP_INVALID_UTF8_NAME');
  }
  return name;
}

function validateZipEntryName(name, packageRoot) {
  if (name.length > 240
      || !name.startsWith(packageRoot)
      || name.includes('\0')
      || name.includes('\\')
      || name.startsWith('/')
      || /^[A-Za-z]:/u.test(name)
      || !SAFE_ZIP_NAME_PATTERN.test(name)) {
    throw new PocError('ARGOS_ZIP_UNSAFE_ENTRY_PATH');
  }
  const directory = name.endsWith('/');
  const normalized = directory ? name.slice(0, -1) : name;
  const segments = normalized.split('/');
  if (segments.some(
    (segment) => segment.length < 1
      || segment === '.'
      || segment === '..'
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || WINDOWS_RESERVED_NAMES.has(
        segment.split('.')[0].toUpperCase()
      )
  )) {
    throw new PocError('ARGOS_ZIP_WINDOWS_PATH_REJECTED');
  }
}

function validateExternalAttributes(
  versionMadeBy,
  externalAttributes,
  directory
) {
  const host = versionMadeBy >>> 8;
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  if ((externalAttributes & WINDOWS_REPARSE_ATTRIBUTE) !== 0
      || unixType === UNIX_SYMBOLIC_LINK
      || (host === 3
        && unixType !== 0
        && unixType !== UNIX_REGULAR_FILE
        && unixType !== UNIX_DIRECTORY)
      || (directory && unixType === UNIX_REGULAR_FILE)
      || (!directory && unixType === UNIX_DIRECTORY)) {
    throw new PocError('ARGOS_ZIP_LINK_OR_SPECIAL_FILE_REJECTED');
  }
}

async function bindLocalHeaders(handle, entries, centralDirectoryOffset) {
  const sorted = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset
  );
  if (sorted[0]?.localHeaderOffset !== 0) {
    throw new PocError('ARGOS_ZIP_PREFIX_BYTES_REJECTED');
  }
  const offsets = new Set();
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    if (offsets.has(entry.localHeaderOffset)
        || entry.localHeaderOffset >= centralDirectoryOffset) {
      throw new PocError('ARGOS_ZIP_LOCAL_HEADER_OFFSET_INVALID');
    }
    offsets.add(entry.localHeaderOffset);
    const header = Buffer.alloc(30);
    await readExactly(
      handle,
      header,
      entry.localHeaderOffset,
      'ARGOS_ZIP_LOCAL_HEADER_TRUNCATED'
    );
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      throw new PocError('ARGOS_ZIP_LOCAL_HEADER_SIGNATURE_INVALID');
    }
    const localFlags = header.readUInt16LE(6);
    const localMethod = header.readUInt16LE(8);
    const localCrc32 = header.readUInt32LE(14);
    const localCompressedSize = header.readUInt32LE(18);
    const localUncompressedSize = header.readUInt32LE(22);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const variable = Buffer.alloc(nameLength + extraLength);
    await readExactly(
      handle,
      variable,
      entry.localHeaderOffset + 30,
      'ARGOS_ZIP_LOCAL_HEADER_TRUNCATED'
    );
    const nameBytes = variable.subarray(0, nameLength);
    const extra = variable.subarray(nameLength);
    validateExtraFields(extra);
    const localName = decodeZipName(nameBytes, localFlags);
    if (localName !== entry.name
        || localFlags !== entry.flags
        || localMethod !== entry.method) {
      throw new PocError('ARGOS_ZIP_LOCAL_CENTRAL_IDENTITY_MISMATCH');
    }
    if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0
        && (localCrc32 !== entry.crc32
          || localCompressedSize !== entry.compressedSize
          || localUncompressedSize !== entry.uncompressedSize)) {
      throw new PocError('ARGOS_ZIP_LOCAL_CENTRAL_SIZE_MISMATCH');
    }
    if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
        && ![0, entry.crc32].includes(localCrc32)) {
      throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_LOCAL_CRC_INVALID');
    }
    if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
        && ![0, entry.compressedSize].includes(localCompressedSize)) {
      throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_LOCAL_SIZE_INVALID');
    }
    if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0
        && ![0, entry.uncompressedSize].includes(localUncompressedSize)) {
      throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_LOCAL_SIZE_INVALID');
    }
    entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = entry.dataOffset + entry.compressedSize;
    const nextBoundary = sorted[index + 1]?.localHeaderOffset
      ?? centralDirectoryOffset;
    if (dataEnd > nextBoundary) {
      throw new PocError('ARGOS_ZIP_COMPRESSED_DATA_OVERLAP');
    }
    const trailingSize = nextBoundary - dataEnd;
    if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0) {
      if (trailingSize !== 0) {
        throw new PocError('ARGOS_ZIP_UNBOUND_BYTES_BETWEEN_ENTRIES');
      }
    } else {
      await verifyDataDescriptor(
        handle,
        dataEnd,
        trailingSize,
        entry
      );
    }
  }
}

async function verifyDataDescriptor(handle, offset, size, entry) {
  if (![12, 16].includes(size)) {
    throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_SIZE_INVALID');
  }
  const descriptor = Buffer.alloc(size);
  await readExactly(
    handle,
    descriptor,
    offset,
    'ARGOS_ZIP_DATA_DESCRIPTOR_TRUNCATED'
  );
  let cursor = 0;
  if (size === 16) {
    if (descriptor.readUInt32LE(0) !== 0x08074b50) {
      throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_SIGNATURE_INVALID');
    }
    cursor = 4;
  }
  if (descriptor.readUInt32LE(cursor) !== entry.crc32
      || descriptor.readUInt32LE(cursor + 4) !== entry.compressedSize
      || descriptor.readUInt32LE(cursor + 8) !== entry.uncompressedSize) {
    throw new PocError('ARGOS_ZIP_DATA_DESCRIPTOR_IDENTITY_MISMATCH');
  }
}

function validateArgosArchiveShape(entries, pin) {
  const total = entries.reduce(
    (sum, entry) => sum + entry.uncompressedSize,
    0
  );
  if (total !== pin.unpackedSize) {
    throw new PocError('ARGOS_ZIP_UNPACKED_SIZE_MISMATCH');
  }
  const rootEntries = entries.filter(
    (entry) => entry.name === pin.packageRoot && entry.directory
  );
  if (rootEntries.length !== 1) {
    throw new PocError('ARGOS_ZIP_PACKAGE_ROOT_INVALID');
  }
  const relativeFiles = new Set(
    entries
      .filter((entry) => !entry.directory)
      .map((entry) => entry.relativePath)
  );
  const relativeDirectories = new Set(
    entries
      .filter((entry) => entry.directory)
      .map((entry) => entry.relativePath)
  );
  for (const path of pin.requiredFiles) {
    if (!relativeFiles.has(path)) {
      throw new PocError('ARGOS_ZIP_REQUIRED_FILE_MISSING');
    }
  }
  for (const prefix of pin.requiredDirectoryPrefixes) {
    if (!relativeDirectories.has(prefix)
        || ![...relativeFiles].some((path) => path.startsWith(prefix))) {
      throw new PocError('ARGOS_ZIP_REQUIRED_DIRECTORY_MISSING');
    }
  }
  for (const entry of entries) {
    if (entry.relativePath === '') {
      continue;
    }
    const isAllowed = pin.requiredFiles.includes(entry.relativePath)
      || pin.requiredDirectoryPrefixes.some(
        (prefix) => entry.relativePath === prefix
          || entry.relativePath.startsWith(prefix)
      );
    if (!isAllowed) {
      throw new PocError('ARGOS_ZIP_UNEXPECTED_ENTRY');
    }
  }
  const filePaths = [...relativeFiles];
  const directoryPaths = [...relativeDirectories];
  for (const file of filePaths) {
    if (directoryPaths.includes(`${file}/`)
        || filePaths.some(
          (other) => other !== file && other.startsWith(`${file}/`)
        )) {
      throw new PocError('ARGOS_ZIP_FILE_DIRECTORY_PREFIX_COLLISION');
    }
  }
}

export async function materializeArgosArchive({
  archivePath,
  candidate,
  manifest,
  authorizationContext,
  targetRoot = DEFAULT_ARGOS_MATERIALIZED_ROOT
}) {
  assertArgosMaterializationAuthorizationContext(
    authorizationContext,
    manifest,
    candidate
  );
  const inspection = await inspectArgosZip(archivePath, {
    ...candidate,
    archive: {
      ...candidate.archive,
      maximumArchiveCompressionRatio:
        manifest.policy.maximumArchiveCompressionRatio,
      maximumSingleExtractedFileBytes:
        manifest.policy.maximumSingleExtractedFileBytes
    }
  });
  const root = resolveArtifactOutput(resolve(targetRoot));
  const target = resolveArtifactOutput(resolve(root, candidate.id));
  await assertNoReparsePointsWithinArtifactRoot(target);
  await assertPathMissing(target, 'ARGOS_MATERIALIZATION_TARGET_ALREADY_EXISTS');
  await mkdir(root, { recursive: true });
  await assertNoReparsePointsWithinArtifactRoot(target);
  const stage = resolveArtifactOutput(resolve(
    root,
    `.${candidate.id}.partial-${randomUUID()}`
  ));
  await mkdir(stage, { recursive: false });
  let renamed = false;
  try {
    const extractedFiles = [];
    for (const entry of inspection.entries) {
      if (entry.relativePath === '') {
        continue;
      }
      const output = resolveStrictRelative(stage, entry.relativePath);
      if (entry.directory) {
        await mkdir(output, { recursive: true });
        continue;
      }
      await mkdir(resolve(output, '..'), { recursive: true });
      const extracted = await extractZipEntry(
        archivePath,
        entry,
        output,
        manifest.policy.maximumSingleExtractedFileBytes
      );
      extractedFiles.push({
        path: entry.relativePath,
        size: extracted.size,
        sha256: extracted.sha256
      });
    }
    extractedFiles.sort(compareOrdinalFilePaths);
    validateEmbeddedFilePins(extractedFiles, candidate.archive.embeddedFilePins);
    const treeSha256 = sha256Text(canonicalJson(extractedFiles));
    if (treeSha256 !== candidate.archive.extractedTreeSha256
        || extractedFiles.length !== candidate.archive.extractedFileCount
        || extractedFiles.reduce((sum, file) => sum + file.size, 0)
          !== candidate.archive.unpackedSize) {
      throw new PocError('ARGOS_EXTRACTED_TREE_MANIFEST_PIN_MISMATCH');
    }
    await verifyArgosPinnedFile(archivePath, candidate.archive);
    const receipt = {
      schemaVersion: ARGOS_MATERIALIZATION_RECEIPT_SCHEMA_VERSION,
      scope: POC_RESEARCH_SCOPE,
      manifestSha256: argosManifestSha256(manifest),
      candidateId: candidate.id,
      authorizationRecordId:
        authorizationContext.authorizationRecordId,
      authorizationSha256: authorizationContext.authorizationSha256,
      archive: {
        filename: candidate.archive.filename,
        size: candidate.archive.size,
        sha256: candidate.archive.sha256,
        centralDirectoryEntryCount:
          candidate.archive.centralDirectoryEntryCount,
        unpackedSize: candidate.archive.unpackedSize
      },
      extraction: {
        safePathPolicy: 'WINDOWS_FAIL_CLOSED_V1',
        symlinksOrReparsePointsCreated: false,
        dataDescriptorEntryCount: inspection.dataDescriptorEntryCount,
        fileCount: extractedFiles.length,
        totalBytes: extractedFiles.reduce(
          (sum, file) => sum + file.size,
          0
        ),
        treeSha256,
        files: extractedFiles
      },
      rawTextEmitted: false,
      productIntegrationAuthorized: false,
      modelDistributionAuthorized: false
    };
    await writeFile(
      resolve(stage, RECEIPT_FILENAME),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    await rename(stage, target);
    renamed = true;
    return {
      schemaVersion: 'phase7-argos-materialization-result-v1',
      status: 'ARGOS_RESEARCH_PACKAGE_MATERIALIZED',
      scope: POC_RESEARCH_SCOPE,
      manifestSha256: receipt.manifestSha256,
      candidateId: candidate.id,
      archiveSha256: candidate.archive.sha256,
      fileCount: receipt.extraction.fileCount,
      unpackedBytes: receipt.extraction.totalBytes,
      treeSha256,
      dataDescriptorEntryCount: inspection.dataDescriptorEntryCount,
      rawPathsEmitted: false,
      rawTextEmitted: false,
      gateAStatus: 'BLOCKED'
    };
  } catch (error) {
    if (!renamed) {
      await cleanupMaterializationStage(stage);
    }
    throw error;
  }
}

export async function deriveArgosArchiveTreePin(
  archivePath,
  candidate,
  manifest
) {
  const inspection = await inspectArgosZip(archivePath, {
    ...candidate,
    archive: {
      ...candidate.archive,
      maximumArchiveCompressionRatio:
        manifest.policy.maximumArchiveCompressionRatio,
      maximumSingleExtractedFileBytes:
        manifest.policy.maximumSingleExtractedFileBytes
    }
  });
  const files = [];
  for (const entry of inspection.entries) {
    if (entry.relativePath === '' || entry.directory) {
      continue;
    }
    const measured = await hashZipEntry(
      archivePath,
      entry,
      manifest.policy.maximumSingleExtractedFileBytes
    );
    files.push({
      path: entry.relativePath,
      size: measured.size,
      sha256: measured.sha256
    });
  }
  files.sort(compareOrdinalFilePaths);
  validateEmbeddedFilePins(files, candidate.archive.embeddedFilePins);
  const treeSha256 = sha256Text(canonicalJson(files));
  return {
    treeSha256,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files
  };
}

async function cleanupMaterializationStage(stage) {
  let stat;
  try {
    stat = await lstat(stage);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw new PocError('ARGOS_MATERIALIZATION_STAGE_QUARANTINE_REQUIRED');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PocError('ARGOS_MATERIALIZATION_STAGE_QUARANTINE_REQUIRED');
  }
  try {
    await rm(stage, { recursive: true, force: false });
  } catch {
    throw new PocError('ARGOS_MATERIALIZATION_STAGE_QUARANTINE_REQUIRED');
  }
}

async function extractZipEntry(
  archivePath,
  entry,
  output,
  maximumBytes
) {
  let observedSize = 0;
  let crc = 0xffffffff;
  const sha256 = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedSize += chunk.length;
      if (observedSize > entry.uncompressedSize
          || observedSize > maximumBytes) {
        callback(new PocError('ARGOS_ZIP_EXTRACTED_SIZE_EXCEEDED'));
        return;
      }
      crc = updateCrc32(crc, chunk);
      sha256.update(chunk);
      callback(null, chunk);
    }
  });
  const compressed = entry.compressedSize === 0
    ? Readable.from([])
    : createReadStream(archivePath, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1
    });
  const streams = [compressed];
  if (entry.method === ZIP_METHOD_DEFLATE) {
    streams.push(createInflateRaw());
  }
  streams.push(
    meter,
    createWriteStream(output, { flags: 'wx', mode: 0o600 })
  );
  try {
    await pipeline(...streams);
  } catch {
    throw new PocError('ARGOS_ZIP_EXTRACTION_FAILED');
  }
  const finalCrc = (crc ^ 0xffffffff) >>> 0;
  if (observedSize !== entry.uncompressedSize
      || finalCrc !== entry.crc32) {
    throw new PocError('ARGOS_ZIP_EXTRACTED_CRC_OR_SIZE_MISMATCH');
  }
  return {
    size: observedSize,
    sha256: sha256.digest('hex')
  };
}

async function hashZipEntry(archivePath, entry, maximumBytes) {
  let observedSize = 0;
  let crc = 0xffffffff;
  const sha256 = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedSize += chunk.length;
      if (observedSize > entry.uncompressedSize
          || observedSize > maximumBytes) {
        callback(new PocError('ARGOS_ZIP_EXTRACTED_SIZE_EXCEEDED'));
        return;
      }
      crc = updateCrc32(crc, chunk);
      sha256.update(chunk);
      callback(null, chunk);
    }
  });
  const discard = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const compressed = entry.compressedSize === 0
    ? Readable.from([])
    : createReadStream(archivePath, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1
    });
  const streams = [compressed];
  if (entry.method === ZIP_METHOD_DEFLATE) {
    streams.push(createInflateRaw());
  }
  streams.push(meter, discard);
  try {
    await pipeline(...streams);
  } catch {
    throw new PocError('ARGOS_ZIP_TREE_PIN_DERIVATION_FAILED');
  }
  const finalCrc = (crc ^ 0xffffffff) >>> 0;
  if (observedSize !== entry.uncompressedSize
      || finalCrc !== entry.crc32) {
    throw new PocError('ARGOS_ZIP_EXTRACTED_CRC_OR_SIZE_MISMATCH');
  }
  return {
    size: observedSize,
    sha256: sha256.digest('hex')
  };
}

function compareOrdinalFilePaths(left, right) {
  if (left.path < right.path) {
    return -1;
  }
  return left.path > right.path ? 1 : 0;
}

function validateEmbeddedFilePins(files, pins) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const pin of pins) {
    const file = byPath.get(pin.path);
    if (!file || file.size !== pin.size || file.sha256 !== pin.sha256) {
      throw new PocError('ARGOS_EMBEDDED_FILE_PIN_MISMATCH');
    }
  }
}

export async function loadAndVerifyArgosMaterialization(
  materializedPath,
  manifest,
  candidate,
  authorizationContext
) {
  assertArgosMaterializationAuthorizationContext(
    authorizationContext,
    manifest,
    candidate
  );
  const target = resolveArtifactOutput(resolve(materializedPath));
  await assertNoReparsePointsWithinArtifactRoot(
    resolve(target, RECEIPT_FILENAME)
  );
  const receiptStat = await lstat(resolve(target, RECEIPT_FILENAME));
  if (!receiptStat.isFile()
      || receiptStat.isSymbolicLink()
      || receiptStat.nlink !== 1
      || receiptStat.size < 2
      || receiptStat.size > MAX_MATERIALIZATION_RECEIPT_BYTES) {
    throw new PocError('ARGOS_MATERIALIZATION_RECEIPT_FILE_UNSAFE');
  }
  const receipt = JSON.parse(
    await readFile(resolve(target, RECEIPT_FILENAME), 'utf8')
  );
  if (!isRecord(receipt)
      || receipt.schemaVersion
        !== ARGOS_MATERIALIZATION_RECEIPT_SCHEMA_VERSION
      || receipt.scope !== POC_RESEARCH_SCOPE
      || receipt.manifestSha256 !== argosManifestSha256(manifest)
      || receipt.candidateId !== candidate.id
      || receipt.authorizationRecordId
        !== authorizationContext.authorizationRecordId
      || receipt.authorizationSha256
        !== authorizationContext.authorizationSha256
      || receipt.archive?.sha256 !== candidate.archive.sha256
      || receipt.archive?.size !== candidate.archive.size
      || receipt.extraction?.treeSha256
        !== candidate.archive.extractedTreeSha256
      || receipt.extraction?.fileCount
        !== candidate.archive.extractedFileCount
      || receipt.extraction?.safePathPolicy !== 'WINDOWS_FAIL_CLOSED_V1'
      || receipt.extraction?.symlinksOrReparsePointsCreated !== false
      || !Array.isArray(receipt.extraction?.files)
      || !SHA256_PATTERN.test(receipt.extraction?.treeSha256 ?? '')) {
    throw new PocError('ARGOS_MATERIALIZATION_RECEIPT_INVALID_OR_STALE');
  }
  const actualFiles = [];
  const receiptPaths = new Set();
  for (const expected of receipt.extraction.files) {
    if (!isSafeRelativePath(expected.path)
        || expected.path === RECEIPT_FILENAME
        || !isPositiveSafeInteger(expected.size)
        || !SHA256_PATTERN.test(expected.sha256 ?? '')
        || receiptPaths.has(expected.path)) {
      throw new PocError('ARGOS_MATERIALIZATION_RECEIPT_FILE_INVALID');
    }
    receiptPaths.add(expected.path);
    const path = resolveStrictRelative(target, expected.path);
    await assertNoReparsePointsWithinArtifactRoot(path);
    const actual = await verifyArgosPinnedFile(path, expected);
    actualFiles.push({
      path: expected.path,
      size: actual.size,
      sha256: actual.sha256
    });
  }
  actualFiles.sort(compareOrdinalFilePaths);
  const treeSha256 = sha256Text(canonicalJson(actualFiles));
  if (treeSha256 !== receipt.extraction.treeSha256
      || actualFiles.length !== receipt.extraction.fileCount
      || actualFiles.reduce((sum, file) => sum + file.size, 0)
        !== receipt.extraction.totalBytes) {
    throw new PocError('ARGOS_MATERIALIZATION_TREE_MISMATCH');
  }
  const enumerated = await enumerateMaterializedFiles(target);
  const expectedPaths = new Set(actualFiles.map((file) => file.path));
  if (enumerated.length !== expectedPaths.size
      || enumerated.some((path) => !expectedPaths.has(path))) {
    throw new PocError('ARGOS_MATERIALIZATION_EXTRA_OR_MISSING_FILE');
  }
  return {
    receipt,
    treeSha256,
    files: actualFiles
  };
}

function assertArgosMaterializationAuthorizationContext(
  authorizationContext,
  manifest,
  candidate
) {
  const manifestCandidate = manifest.candidates?.find(
    (entry) => entry?.id === candidate.id
  );
  if (!isRecord(authorizationContext)
      || !isRecord(manifestCandidate)
      || canonicalJson(manifestCandidate) !== canonicalJson(candidate)
      || authorizationContext.scope !== POC_RESEARCH_SCOPE
      || authorizationContext.manifestSha256
        !== argosManifestSha256(manifest)
      || !AUTHORIZATION_RECORD_ID_PATTERN.test(
        authorizationContext.authorizationRecordId ?? ''
      )
      || !SHA256_PATTERN.test(
        authorizationContext.authorizationSha256 ?? ''
      )
      || !Array.isArray(authorizationContext.candidateIds)
      || authorizationContext.candidateIds.length !== 1
      || authorizationContext.candidateIds[0] !== candidate.id) {
    throw new PocError(
      'ARGOS_MATERIALIZATION_AUTHORIZATION_CONTEXT_INVALID'
    );
  }
}

async function enumerateMaterializedFiles(root, current = root) {
  const results = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new PocError('ARGOS_MATERIALIZATION_REPARSE_POINT_REJECTED');
    }
    if (entry.isDirectory()) {
      results.push(...await enumerateMaterializedFiles(root, path));
      continue;
    }
    if (!entry.isFile() || stat.nlink !== 1) {
      throw new PocError('ARGOS_MATERIALIZATION_SPECIAL_FILE_REJECTED');
    }
    const relation = relative(root, path).split(sep).join('/');
    if (relation !== RECEIPT_FILENAME) {
      results.push(relation);
    }
  }
  return results.sort();
}

async function readExactly(handle, buffer, position, code) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (result.bytesRead < 1) {
      throw new PocError(code);
    }
    offset += result.bytesRead;
  }
}

async function hashFile(path, maximumBytes) {
  const sha256 = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new PocError('ARGOS_PINNED_FILE_EXCEEDED_EXPECTED_SIZE');
    }
    sha256.update(chunk);
  }
  return { size, sha256: sha256.digest('hex') };
}

async function assertPathMissing(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new PocError(code);
}

function resolveStrictRelative(root, path) {
  if (!isSafeRelativePath(path)) {
    throw new PocError('ARGOS_UNSAFE_RELATIVE_OUTPUT_PATH');
  }
  const target = resolve(root, ...path.split('/'));
  const relation = relative(root, target);
  if (relation === ''
      || relation === '..'
      || relation.startsWith(`..${sep}`)
      || isAbsolute(relation)) {
    throw new PocError('ARGOS_OUTPUT_PATH_ESCAPES_ROOT');
  }
  return target;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.includes('\0')
      || value.includes('\\')
      || value.includes(':')
      || isAbsolute(value)) {
    return false;
  }
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  return normalized.split('/').every(
    (segment) => segment.length > 0
      && segment !== '.'
      && segment !== '..'
  );
}

function isHttpsUrl(value) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && JSON.stringify(left) === JSON.stringify(right);
}

function sameNumberArray(left, right) {
  return Array.isArray(left)
    && JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return JSON.stringify([...new Set(left)].sort())
    === JSON.stringify([...new Set(right)].sort());
}

function sameNumberSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return JSON.stringify([...new Set(left)].sort((a, b) => a - b))
    === JSON.stringify([...new Set(right)].sort((a, b) => a - b));
}

function hasUniqueStrings(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string')
    && new Set(value).size === value.length;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? (value >>> 1) ^ 0xedb88320
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(current, buffer) {
  let crc = current >>> 0;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

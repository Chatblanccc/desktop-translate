import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ARGOS_MANIFEST_PATH,
  DEFAULT_ARGOS_MATERIALIZED_ROOT,
  DEFAULT_ARGOS_SUPPLY_ROOT,
  argosManifestSha256,
  createPendingArgosAuthorization,
  inspectArgosZip,
  isAllowedArgosDownloadUrl,
  loadExactArgosAuthorization,
  loadArgosManifest,
  materializeArgosArchive,
  selectArgosCandidates,
  selectedArgosSupplyEntries,
  verifyArgosPinnedFile
} from './argos-lib.mjs';
import {
  PocError,
  assertNetworkPermission,
  assertNoReparsePointsWithinArtifactRoot,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const DEFAULT_MAX_BYTES = 200_000_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const HELP = `Phase 7 Argos direct CTranslate2 research POC

Plan only (default; zero writes and zero network):
  node tooling/phase7-offline-poc/argos-prepare.mjs

Create a pending research authorization template:
  node tooling/phase7-offline-poc/argos-prepare.mjs \\
    --authorization-template artifacts/phase7/offline-poc/authorizations/argos.json

Download exact model archives and top-level runtime wheels:
  node tooling/phase7-offline-poc/argos-prepare.mjs \\
    --download --allow-network \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/argos.json

Verify already-downloaded supply without network:
  node tooling/phase7-offline-poc/argos-prepare.mjs --verify

Safely materialize verified archives without installing Python packages:
  node tooling/phase7-offline-poc/argos-prepare.mjs \\
    --materialize \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/argos.json

Downloads require both --download and --allow-network plus an exact manifest-
bound Phase 7 M0 research authorization. No command installs a wheel, mutates
the product, emits model text, or authorizes packaging or distribution.
`;

export function buildArgosPreparationPlan(
  manifest,
  candidates,
  { includeWheels = true } = {}
) {
  const files = selectedArgosSupplyEntries(
    manifest,
    candidates,
    { includeWheels }
  );
  return {
    schemaVersion: 'phase7-argos-preparation-plan-v1',
    status: 'POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD_OR_MATERIALIZATION',
    scope: manifest.policy.scope,
    manifestSha256: argosManifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    network: {
      defaultAccess: false,
      activity: 'NOT_REQUESTED',
      explicitFlagsRequired: ['--download', '--allow-network']
    },
    files: files.map((file) => ({
      id: file.id,
      kind: file.kind,
      filename: file.filename,
      size: file.size,
      sha256: file.sha256,
      url: file.url
    })),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    archiveUnpackedBytes: candidates.reduce(
      (sum, candidate) => sum + candidate.archive.unpackedSize,
      0
    ),
    artifactRoot: 'artifacts/phase7/offline-poc/argos',
    automaticPackageInstallationAllowed: false,
    globalPackageInstallationAllowed: false,
    modelExecution: 'NOT_RUN',
    gateAStatus: 'BLOCKED'
  };
}

export async function downloadArgosSupply(manifest, candidates, options) {
  assertNetworkPermission({
    operationRequested: true,
    allowNetwork: options.allowNetwork
  });
  const authorization = await loadAndVerifyAuthorization(
    options.pocAuthorizationPath,
    manifest,
    candidates,
    'ARGOS_POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD'
  );
  const entries = selectedArgosSupplyEntries(manifest, candidates, {
    includeWheels: !options.packagesOnly
  });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > options.maxBytes) {
    throw new PocError('ARGOS_PINNED_DOWNLOAD_EXCEEDS_MAX_BYTES');
  }
  const supplyRoot = resolveArtifactOutput(resolve(options.supplyRoot));
  await assertNoReparsePointsWithinArtifactRoot(
    resolve(supplyRoot, '_safety-probe')
  );
  await mkdir(supplyRoot, { recursive: true });
  const results = [];
  for (const entry of entries) {
    const target = resolve(
      supplyRoot,
      ...entry.localPath.split('/')
    );
    await assertNoReparsePointsWithinArtifactRoot(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    const status = await existingPinnedFileStatus(target, entry);
    if (status === 'MISMATCH') {
      throw new PocError('ARGOS_EXISTING_SUPPLY_ARTIFACT_MISMATCH');
    }
    if (status === 'MISSING') {
      await downloadPinnedEntry(entry, target);
      results.push(sanitizedResult(entry, 'DOWNLOADED_VERIFIED'));
    } else {
      results.push(sanitizedResult(entry, 'EXISTING_VERIFIED'));
    }
    if (entry.kind === 'ARGOS_MODEL_ARCHIVE') {
      const candidate = candidates.find(
        (item) => item.id === entry.id
      );
      await inspectArchiveWithPolicy(target, candidate, manifest);
    }
  }
  return {
    schemaVersion: 'phase7-argos-preparation-result-v1',
    status: options.packagesOnly
      ? 'ARGOS_MODEL_ARCHIVES_READY_FOR_RESEARCH_MATERIALIZATION'
      : 'ARGOS_PINNED_SUPPLY_READY_FOR_ISOLATED_RESEARCH',
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizationSha256: authorization.authorizationSha256,
    manifestSha256: argosManifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    network: {
      defaultAccess: false,
      explicitlyAllowed: true,
      accessed: true
    },
    fileCount: entries.length,
    totalBytes,
    files: results,
    rawPathsEmitted: false,
    rawTextEmitted: false,
    wheelsInstalled: false,
    modelExecution: 'NOT_RUN',
    gateAStatus: 'BLOCKED'
  };
}

export async function verifyArgosSupply(manifest, candidates, options) {
  const supplyRoot = resolveArtifactOutput(resolve(options.supplyRoot));
  const entries = selectedArgosSupplyEntries(manifest, candidates, {
    includeWheels: !options.packagesOnly
  });
  const results = [];
  for (const entry of entries) {
    const target = resolve(supplyRoot, ...entry.localPath.split('/'));
    await assertNoReparsePointsWithinArtifactRoot(target);
    await verifyArgosPinnedFile(target, entry);
    let zip = null;
    if (entry.kind === 'ARGOS_MODEL_ARCHIVE') {
      const candidate = candidates.find((item) => item.id === entry.id);
      const inspection = await inspectArchiveWithPolicy(
        target,
        candidate,
        manifest
      );
      zip = {
        centralDirectoryEntryCount:
          inspection.centralDirectoryEntryCount,
        unpackedBytes: inspection.unpackedBytes,
        dataDescriptorEntryCount:
          inspection.dataDescriptorEntryCount
      };
    }
    results.push({
      ...sanitizedResult(entry, 'VERIFIED_OFFLINE'),
      ...(zip ? { zip } : {})
    });
  }
  return {
    schemaVersion: 'phase7-argos-supply-verification-v1',
    status: 'ARGOS_PINNED_SUPPLY_VERIFIED_OFFLINE',
    manifestSha256: argosManifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    files: results,
    networkActivityVerification:
      'NOT_PERFORMED_STATIC_ARTIFACT_AUDIT',
    wheelsInstalled: false,
    modelExecution: 'NOT_RUN',
    rawPathsEmitted: false,
    rawTextEmitted: false,
    gateAStatus: 'BLOCKED'
  };
}

async function materializeSelected(manifest, candidates, options) {
  const authorization = await loadAndVerifyAuthorization(
    options.pocAuthorizationPath,
    manifest,
    candidates,
    'ARGOS_POC_AUTHORIZATION_REQUIRED_FOR_MATERIALIZATION'
  );
  const supplyRoot = resolveArtifactOutput(resolve(options.supplyRoot));
  const results = [];
  for (const candidate of candidates) {
    const archivePath = resolve(
      supplyRoot,
      ...candidate.archive.localPath.split('/')
    );
    await assertNoReparsePointsWithinArtifactRoot(archivePath);
    const result = await materializeArgosArchive({
      archivePath,
      candidate,
      manifest,
      authorizationContext: authorization,
      targetRoot: options.materializedRoot
    });
    results.push(result);
  }
  return {
    schemaVersion: 'phase7-argos-materialization-batch-result-v1',
    status: 'ARGOS_RESEARCH_PACKAGES_MATERIALIZED',
    scope: authorization.scope,
    authorizationRecordId: authorization.authorizationRecordId,
    authorizationSha256: authorization.authorizationSha256,
    manifestSha256: argosManifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    packages: results,
    wheelsInstalled: false,
    modelExecution: 'NOT_RUN',
    rawPathsEmitted: false,
    rawTextEmitted: false,
    gateAStatus: 'BLOCKED'
  };
}

async function inspectArchiveWithPolicy(path, candidate, manifest) {
  return inspectArgosZip(path, {
    ...candidate,
    archive: {
      ...candidate.archive,
      maximumArchiveCompressionRatio:
        manifest.policy.maximumArchiveCompressionRatio,
      maximumSingleExtractedFileBytes:
        manifest.policy.maximumSingleExtractedFileBytes
    }
  });
}

async function loadAndVerifyAuthorization(
  path,
  manifest,
  candidates,
  missingCode
) {
  if (!path) {
    throw new PocError(missingCode);
  }
  return loadExactArgosAuthorization(
    path,
    manifest,
    candidates.map((candidate) => candidate.id)
  );
}

async function downloadPinnedEntry(entry, target) {
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadPinnedEntryOnce(entry, target);
      return;
    } catch (error) {
      if (error instanceof PocError || attempt === MAX_DOWNLOAD_ATTEMPTS) {
        throw error instanceof PocError
          ? error
          : new PocError('ARGOS_SUPPLY_DOWNLOAD_TRANSIENT_FAILURE');
      }
      await delay(attempt * 250);
    }
  }
}

async function downloadPinnedEntryOnce(entry, target) {
  let url = entry.url;
  let response;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    assertAllowedUrl(url);
    response = await fetch(url, {
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'desktop-translate-phase7-argos-poc/1'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      break;
    }
    const location = response.headers.get('location');
    if (!location || redirect === MAX_REDIRECTS) {
      throw new PocError('ARGOS_SUPPLY_REDIRECT_REJECTED');
    }
    url = new URL(location, url).href;
  }
  if (!response?.ok || !response.body) {
    throw new PocError('ARGOS_SUPPLY_DOWNLOAD_HTTP_FAILURE');
  }
  assertAllowedUrl(response.url);
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new PocError('ARGOS_SUPPLY_CONTENT_ENCODING_REJECTED');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== entry.size) {
    throw new PocError('ARGOS_SUPPLY_CONTENT_LENGTH_MISMATCH');
  }
  const partial = `${target}.partial-${randomUUID()}`;
  const sha256 = createHash('sha256');
  let observedSize = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedSize += chunk.length;
      if (observedSize > entry.size) {
        callback(new PocError('ARGOS_SUPPLY_EXCEEDED_PINNED_SIZE'));
        return;
      }
      sha256.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(partial, { flags: 'wx', mode: 0o600 })
    );
    if (observedSize !== entry.size
        || sha256.digest('hex') !== entry.sha256) {
      throw new PocError('ARGOS_SUPPLY_DIGEST_MISMATCH');
    }
    await rename(partial, target);
  } catch (error) {
    try {
      await unlink(partial);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new PocError('ARGOS_PARTIAL_DOWNLOAD_QUARANTINE_REQUIRED');
      }
    }
    throw error;
  }
}

async function existingPinnedFileStatus(path, pin) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || stat.size !== pin.size) {
      return 'MISMATCH';
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'MISSING';
    }
    throw error;
  }
  const sha256 = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > pin.size) {
      return 'MISMATCH';
    }
    sha256.update(chunk);
  }
  return size === pin.size && sha256.digest('hex') === pin.sha256
    ? 'MATCH'
    : 'MISMATCH';
}

function assertAllowedUrl(value) {
  if (!isAllowedArgosDownloadUrl(value)) {
    throw new PocError('ARGOS_SUPPLY_DOWNLOAD_HOST_REJECTED');
  }
}

function sanitizedResult(entry, status) {
  return {
    id: entry.id,
    kind: entry.kind,
    filename: basename(entry.localPath),
    size: entry.size,
    sha256: entry.sha256,
    status
  };
}

export function parseArgosPrepareArguments(args) {
  const options = {
    allowNetwork: false,
    authorizationTemplatePath: null,
    candidateId: null,
    candidateSetId: null,
    download: false,
    help: false,
    manifestPath: DEFAULT_ARGOS_MANIFEST_PATH,
    materialize: false,
    materializedRoot: DEFAULT_ARGOS_MATERIALIZED_ROOT,
    maxBytes: DEFAULT_MAX_BYTES,
    packagesOnly: false,
    pocAuthorizationPath: null,
    supplyRoot: DEFAULT_ARGOS_SUPPLY_ROOT,
    verify: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-network') {
      options.allowNetwork = true;
    } else if (argument === '--authorization-template') {
      options.authorizationTemplatePath = requireValue(
        args,
        ++index,
        argument
      );
    } else if (argument === '--candidate') {
      options.candidateId = requireValue(args, ++index, argument);
    } else if (argument === '--candidate-set') {
      options.candidateSetId = requireValue(args, ++index, argument);
    } else if (argument === '--download') {
      options.download = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--manifest') {
      options.manifestPath = requireValue(args, ++index, argument);
    } else if (argument === '--materialize') {
      options.materialize = true;
    } else if (argument === '--materialized-root') {
      options.materializedRoot = requireValue(args, ++index, argument);
    } else if (argument === '--max-bytes') {
      options.maxBytes = parsePositiveInteger(
        requireValue(args, ++index, argument)
      );
    } else if (argument === '--packages-only') {
      options.packagesOnly = true;
    } else if (argument === '--poc-authorization') {
      options.pocAuthorizationPath = requireValue(
        args,
        ++index,
        argument
      );
    } else if (argument === '--supply-root') {
      options.supplyRoot = requireValue(args, ++index, argument);
    } else if (argument === '--verify') {
      options.verify = true;
    } else {
      throw new PocError('UNKNOWN_ARGOS_PREPARE_ARGUMENT');
    }
  }
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('ARGOS_CANDIDATE_AND_SET_MUTUALLY_EXCLUSIVE');
  }
  const actionCount = [
    Boolean(options.authorizationTemplatePath),
    options.download,
    options.materialize,
    options.verify
  ].filter(Boolean).length;
  if (actionCount > 1) {
    throw new PocError('ARGOS_PREPARE_ACTIONS_MUTUALLY_EXCLUSIVE');
  }
  if (options.allowNetwork && !options.download) {
    throw new PocError('ARGOS_ALLOW_NETWORK_REQUIRES_DOWNLOAD_ACTION');
  }
  if (options.materialize && !options.candidateId) {
    throw new PocError(
      'ARGOS_MATERIALIZATION_REQUIRES_EXACTLY_ONE_CANDIDATE'
    );
  }
  return options;
}

async function runCli() {
  const options = parseArgosPrepareArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const manifest = await loadArgosManifest(options.manifestPath);
  const candidates = selectArgosCandidates(manifest, options);
  if (options.authorizationTemplatePath) {
    const authorization = createPendingArgosAuthorization(
      manifest,
      candidates.map((candidate) => candidate.id)
    );
    await writeJsonArtifact(
      options.authorizationTemplatePath,
      authorization
    );
    process.stdout.write(`${JSON.stringify({
      status: 'PENDING_ARGOS_POC_AUTHORIZATION_TEMPLATE_CREATED',
      scope: authorization.scope,
      manifestSha256: authorization.manifestSha256,
      candidateIds: authorization.candidateIds,
      outputFile: basename(options.authorizationTemplatePath),
      networkActivityVerification:
        'NOT_PERFORMED_STATIC_TEMPLATE_GENERATION',
      modelArchivesDownloaded: false,
      wheelsInstalled: false
    }, null, 2)}\n`);
    return;
  }
  if (options.download) {
    process.stdout.write(`${JSON.stringify(
      await downloadArgosSupply(manifest, candidates, options),
      null,
      2
    )}\n`);
    return;
  }
  if (options.verify) {
    process.stdout.write(`${JSON.stringify(
      await verifyArgosSupply(manifest, candidates, options),
      null,
      2
    )}\n`);
    return;
  }
  if (options.materialize) {
    process.stdout.write(`${JSON.stringify(
      await materializeSelected(manifest, candidates, options),
      null,
      2
    )}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(
    buildArgosPreparationPlan(manifest, candidates, {
      includeWheels: !options.packagesOnly
    }),
    null,
    2
  )}\n`);
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PocError('ARGOS_MAX_BYTES_INVALID');
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(
      `MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`
    );
  }
  return value;
}

function directInvocation() {
  return process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (directInvocation()) {
  runCli().catch((error) => {
    const code = error instanceof PocError
      ? error.code
      : 'UNEXPECTED_ARGOS_PREPARATION_FAILURE';
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      errorCode: code,
      rawPathsEmitted: false,
      rawTextEmitted: false
    })}\n`);
    process.exitCode = 1;
  });
}

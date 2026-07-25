import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BERGAMOT_MANIFEST_PATH,
  DEFAULT_BERGAMOT_SUPPLY_ROOT,
  bergamotManifestSha256,
  createPendingBergamotAuthorization,
  isAllowedDownloadUrl,
  loadBergamotManifest,
  selectBergamotCandidates,
  selectedBergamotSupplyEntries,
  verifyBergamotAuthorization,
  verifyBergamotSupply
} from './bergamot-lib.mjs';
import {
  PocError,
  assertNetworkPermission,
  assertNoReparsePointsWithinArtifactRoot,
  loadJson,
  resolveArtifactOutput,
  writeJsonArtifact
} from './lib.mjs';

const DEFAULT_MAX_BYTES = 100_000_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;

const HELP = `Phase 7 Firefox/Bergamot POC supply preparation

Plan only (default, zero network and zero writes):
  node tooling/phase7-offline-poc/bergamot-prepare.mjs

Create a pending authorization template under ignored artifacts:
  node tooling/phase7-offline-poc/bergamot-prepare.mjs \\
    --authorization-template artifacts/phase7/offline-poc/authorizations/bergamot.json

Download the exact runtime, license evidence, and both model directions:
  node tooling/phase7-offline-poc/bergamot-prepare.mjs \\
    --download --allow-network \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json

Download only the runtime and license evidence for the Node compatibility spike:
  node tooling/phase7-offline-poc/bergamot-prepare.mjs \\
    --download --runtime-only --allow-network \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json

Verify already-downloaded artifacts without network:
  node tooling/phase7-offline-poc/bergamot-prepare.mjs --verify

Every download requires the existing Phase 7 M0 research-only authorization
bound to this exact manifest and candidate set. Files are written only below
ignored artifacts/, verified by exact size and SHA-256 (plus npm SHA-1 and
SHA-512 integrity), and atomically renamed. No package install script runs.
`;

export function buildBergamotPreparationPlan(
  manifest,
  candidates,
  { includeModels = true } = {}
) {
  const files = selectedBergamotSupplyEntries(manifest, candidates, { includeModels });
  return {
    schemaVersion: 'phase7-bergamot-poc-preparation-plan-v1',
    status: 'POC_AUTHORIZATION_REQUIRED',
    scope: manifest.policy.pocAuthorizationScope,
    manifestSha256: bergamotManifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    includeModels,
    network: {
      defaultAccess: false,
      activity: 'NOT_REQUESTED',
      explicitAllowNetworkRequired: true
    },
    files: files.map((file) => ({
      id: file.id,
      kind: file.kind,
      localPath: file.localPath,
      size: file.size,
      sha256: file.sha256,
      url: file.url
    })),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    artifactRoot: 'artifacts/phase7/offline-poc/bergamot/supply-chain',
    runtimeInstallScriptsAllowed: false,
    gateAStatus: 'BLOCKED_PENDING_POC_EVIDENCE',
    modelExecution: 'NOT_RUN'
  };
}

export async function downloadBergamotSupply(manifest, candidates, options) {
  assertNetworkPermission({ operationRequested: true, allowNetwork: options.allowNetwork });
  if (!options.pocAuthorizationPath) {
    throw new PocError('BERGAMOT_POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD');
  }
  const authorization = await loadJson(options.pocAuthorizationPath);
  const candidateIds = candidates.map((candidate) => candidate.id).sort();
  const authorizationSummary = verifyBergamotAuthorization(
    authorization,
    manifest,
    candidateIds
  );
  const plan = buildBergamotPreparationPlan(manifest, candidates, {
    includeModels: !options.runtimeOnly
  });
  if (plan.totalBytes > options.maxBytes) {
    throw new PocError('BERGAMOT_PINNED_DOWNLOAD_EXCEEDS_MAX_BYTES');
  }
  const supplyRoot = resolveArtifactOutput(resolve(options.supplyRoot));
  await assertNoReparsePointsWithinArtifactRoot(resolve(supplyRoot, '_safety-probe'));
  await mkdir(supplyRoot, { recursive: true });
  const results = [];
  const entries = selectedBergamotSupplyEntries(manifest, candidates, {
    includeModels: !options.runtimeOnly
  });
  for (const entry of entries) {
    const target = resolve(supplyRoot, ...entry.localPath.split('/'));
    await assertNoReparsePointsWithinArtifactRoot(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    const existing = await existingPinnedFileStatus(target, entry);
    if (existing === 'MATCH') {
      results.push(sanitizedDownloadResult(entry, 'EXISTING_VERIFIED'));
      continue;
    }
    if (existing === 'MISMATCH') {
      throw new PocError('BERGAMOT_EXISTING_SUPPLY_ARTIFACT_MISMATCH');
    }
    await downloadPinnedEntry(entry, target);
    results.push(sanitizedDownloadResult(entry, 'DOWNLOADED_VERIFIED'));
  }
  const verification = await verifyBergamotSupply(manifest, candidates, {
    includeModels: !options.runtimeOnly,
    supplyRoot
  });
  return {
    schemaVersion: 'phase7-bergamot-poc-preparation-result-v1',
    status: options.runtimeOnly
      ? 'RUNTIME_SUPPLY_READY_FOR_COMPATIBILITY_SPIKE'
      : 'BIDIRECTIONAL_SUPPLY_READY_FOR_POC',
    scope: authorizationSummary.scope,
    pocAuthorizationRecordId: authorizationSummary.authorizationRecordId,
    manifestSha256: bergamotManifestSha256(manifest),
    candidateIds,
    includeModels: !options.runtimeOnly,
    network: {
      defaultAccess: false,
      explicitlyAllowed: true,
      accessed: true
    },
    fileCount: verification.fileCount,
    totalBytes: verification.totalBytes,
    supplyTreeSha256: verification.treeSha256,
    files: results,
    output: 'artifacts/phase7/offline-poc/bergamot/supply-chain',
    runtimeInstallScriptsExecuted: false,
    modelExecution: 'NOT_RUN',
    gateAStatus: 'BLOCKED_PENDING_POC_EVIDENCE'
  };
}

async function downloadPinnedEntry(entry, target) {
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadPinnedEntryOnce(entry, target);
      return;
    } catch (error) {
      if (error instanceof PocError) {
        throw error;
      }
      if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
        throw new PocError('BERGAMOT_SUPPLY_DOWNLOAD_TRANSIENT_FAILURE');
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
        'User-Agent': 'desktop-translate-phase7-bergamot-poc/1'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      break;
    }
    const location = response.headers.get('location');
    if (!location || redirect === MAX_REDIRECTS) {
      throw new PocError('BERGAMOT_SUPPLY_REDIRECT_REJECTED');
    }
    url = new URL(location, url).href;
  }
  if (!response?.ok || !response.body) {
    throw new PocError('BERGAMOT_SUPPLY_DOWNLOAD_HTTP_FAILURE');
  }
  assertAllowedUrl(response.url);
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== entry.size) {
    throw new PocError('BERGAMOT_SUPPLY_CONTENT_LENGTH_MISMATCH');
  }

  const partial = `${target}.partial-${randomUUID()}`;
  const sha256 = createHash('sha256');
  const sha1 = entry.sha1 ? createHash('sha1') : null;
  const sha512 = entry.integrity ? createHash('sha512') : null;
  let observedSize = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedSize += chunk.length;
      if (observedSize > entry.size) {
        callback(new PocError('BERGAMOT_SUPPLY_EXCEEDED_PINNED_SIZE'));
        return;
      }
      sha256.update(chunk);
      sha1?.update(chunk);
      sha512?.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(partial, { flags: 'wx' })
    );
    if (observedSize !== entry.size || sha256.digest('hex') !== entry.sha256) {
      throw new PocError('BERGAMOT_SUPPLY_DIGEST_MISMATCH');
    }
    if (sha1 && sha1.digest('hex') !== entry.sha1) {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_SHA1_MISMATCH');
    }
    if (sha512 && `sha512-${sha512.digest('base64')}` !== entry.integrity) {
      throw new PocError('BERGAMOT_RUNTIME_TARBALL_INTEGRITY_MISMATCH');
    }
    await rename(partial, target);
  } catch (error) {
    try {
      await unlink(partial);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new PocError('BERGAMOT_PARTIAL_DOWNLOAD_QUARANTINE_REQUIRED');
      }
    }
    throw error;
  }
}

async function existingPinnedFileStatus(path, pin) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size) {
      return 'MISMATCH';
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'MISSING';
    }
    throw error;
  }
  const sha256 = createHash('sha256');
  const sha1 = pin.sha1 ? createHash('sha1') : null;
  const sha512 = pin.integrity ? createHash('sha512') : null;
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    sha1?.update(chunk);
    sha512?.update(chunk);
  }
  const matches = size === pin.size
    && sha256.digest('hex') === pin.sha256
    && (!sha1 || sha1.digest('hex') === pin.sha1)
    && (!sha512 || `sha512-${sha512.digest('base64')}` === pin.integrity);
  return matches ? 'MATCH' : 'MISMATCH';
}

function sanitizedDownloadResult(entry, status) {
  return {
    id: entry.id,
    kind: entry.kind,
    filename: basename(entry.localPath),
    size: entry.size,
    sha256: entry.sha256,
    status
  };
}

function assertAllowedUrl(value) {
  if (!isAllowedDownloadUrl(value)) {
    throw new PocError('BERGAMOT_SUPPLY_DOWNLOAD_HOST_REJECTED');
  }
}

async function runCli() {
  const options = parseBergamotPrepareArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const manifest = await loadBergamotManifest(options.manifestPath);
  const candidates = selectBergamotCandidates(manifest, options);
  if (options.authorizationTemplatePath) {
    const authorization = createPendingBergamotAuthorization(
      manifest,
      candidates.map((candidate) => candidate.id)
    );
    await writeJsonArtifact(options.authorizationTemplatePath, authorization);
    process.stdout.write(`${JSON.stringify({
      status: 'PENDING_POC_AUTHORIZATION_TEMPLATE_CREATED',
      scope: authorization.scope,
      manifestSha256: authorization.manifestSha256,
      candidateIds: authorization.candidateIds,
      outputFile: basename(options.authorizationTemplatePath),
      networkActivityVerification: 'NOT_PERFORMED_STATIC_TEMPLATE_GENERATION',
      modelWeightsDownloaded: false
    }, null, 2)}\n`);
    return;
  }
  if (options.download) {
    const report = await downloadBergamotSupply(manifest, candidates, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (options.verify) {
    const verification = await verifyBergamotSupply(manifest, candidates, {
      includeModels: !options.runtimeOnly,
      supplyRoot: options.supplyRoot
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'phase7-bergamot-poc-supply-verification-v1',
      status: 'VERIFIED_OFFLINE',
      manifestSha256: bergamotManifestSha256(manifest),
      candidateIds: candidates.map((candidate) => candidate.id).sort(),
      includeModels: !options.runtimeOnly,
      networkActivityVerification: 'NOT_PERFORMED_STATIC_ARTIFACT_AUDIT',
      ...verification
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(
    buildBergamotPreparationPlan(manifest, candidates, {
      includeModels: !options.runtimeOnly
    }),
    null,
    2
  )}\n`);
}

export function parseBergamotPrepareArguments(args) {
  const options = {
    allowNetwork: false,
    authorizationTemplatePath: null,
    candidateId: null,
    candidateSetId: null,
    download: false,
    help: false,
    manifestPath: DEFAULT_BERGAMOT_MANIFEST_PATH,
    maxBytes: DEFAULT_MAX_BYTES,
    pocAuthorizationPath: null,
    runtimeOnly: false,
    supplyRoot: DEFAULT_BERGAMOT_SUPPLY_ROOT,
    verify: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-network') {
      options.allowNetwork = true;
    } else if (argument === '--authorization-template') {
      options.authorizationTemplatePath = requireValue(args, ++index, argument);
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
    } else if (argument === '--max-bytes') {
      options.maxBytes = parsePositiveInteger(requireValue(args, ++index, argument));
    } else if (argument === '--poc-authorization') {
      options.pocAuthorizationPath = requireValue(args, ++index, argument);
    } else if (argument === '--runtime-only') {
      options.runtimeOnly = true;
    } else if (argument === '--supply-root') {
      options.supplyRoot = requireValue(args, ++index, argument);
    } else if (argument === '--verify') {
      options.verify = true;
    } else {
      throw new PocError('UNKNOWN_BERGAMOT_PREPARE_ARGUMENT');
    }
  }
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('BERGAMOT_CANDIDATE_AND_SET_MUTUALLY_EXCLUSIVE');
  }
  const actionCount = [
    Boolean(options.authorizationTemplatePath),
    options.download,
    options.verify
  ].filter(Boolean).length;
  if (actionCount > 1) {
    throw new PocError('BERGAMOT_PREPARE_ACTIONS_MUTUALLY_EXCLUSIVE');
  }
  if (options.allowNetwork && !options.download) {
    throw new PocError('BERGAMOT_ALLOW_NETWORK_REQUIRES_DOWNLOAD_ACTION');
  }
  return options;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new PocError('BERGAMOT_MAX_BYTES_INVALID');
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(`MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

function directInvocation() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (directInvocation()) {
  runCli().catch((error) => {
    const code = error instanceof PocError
      ? error.code
      : 'UNEXPECTED_BERGAMOT_PREPARATION_FAILURE';
    process.stderr.write(`${JSON.stringify({
      status: 'BLOCKED',
      errorCode: code,
      rawPathsEmitted: false,
      rawTextEmitted: false
    })}\n`);
    process.exitCode = 1;
  });
}

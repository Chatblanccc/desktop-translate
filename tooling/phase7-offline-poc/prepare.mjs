import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ARTIFACT_ROOT,
  DEFAULT_MANIFEST_PATH,
  PocError,
  assertNetworkPermission,
  assertNoReparsePointsWithinArtifactRoot,
  candidateDownloadUrl,
  createPendingPocAuthorization,
  loadJson,
  loadManifest,
  manifestSha256,
  resolveArtifactOutput,
  selectedCandidates,
  verifyPocAuthorization,
  writeJsonArtifact
} from './lib.mjs';

const DEFAULT_SOURCE_ROOT = resolve(DEFAULT_ARTIFACT_ROOT, 'sources');
const DEFAULT_MAX_BYTES = 2_500_000_000;
const ALLOWED_FINAL_HOSTS = Object.freeze([
  'huggingface.co',
  '.huggingface.co',
  '.hf.co',
  '.xethub.hf.co'
]);

const HELP = `Phase 7 offline model source preparation

Plan only (default; no writes and no network):
  node tooling/phase7-offline-poc/prepare.mjs --candidate-set marian-opus-zh-en-bidirectional
  node tooling/phase7-offline-poc/prepare.mjs --candidate m2m100-418m

Create a pending M0 POC research authorization template under ignored artifacts:
  node tooling/phase7-offline-poc/prepare.mjs --candidate opus-mt-en-zh \\
    --authorization-template artifacts/phase7/offline-poc/authorizations/opus-en-zh.json

Download exact pinned source files after recording research-only M0 authorization:
  node tooling/phase7-offline-poc/prepare.mjs --candidate opus-mt-en-zh \\
    --download --allow-network \\
    --poc-authorization artifacts/phase7/offline-poc/authorizations/opus-en-zh.json

This command does not install Python packages and does not convert a model.
Downloads are streamed into artifacts/phase7/offline-poc, size checked, hash
verified, and atomically renamed. Existing mismatched files are never replaced.
POC authorization never grants integration or distribution; Gate A remains
blocked until the completed measurement evidence is reviewed.
`;

export function buildPreparationPlan(manifest, candidates) {
  const files = candidates.flatMap((candidate) => candidate.sourceFiles.map((file) => ({
    candidateId: candidate.id,
    path: file.path,
    size: file.size,
    digestAlgorithm: file.digestAlgorithm,
    digest: file.digest,
    purpose: file.purpose,
    url: candidateDownloadUrl(candidate, file)
  })));
  return {
    schemaVersion: 'phase7-offline-poc-preparation-plan-v1',
    status: 'POC_AUTHORIZATION_REQUIRED',
    networkAccess: 'NOT_REQUESTED',
    modelWeightsDownloaded: false,
    manifestSha256: manifestSha256(manifest),
    candidateIds: candidates.map((candidate) => candidate.id).sort(),
    sourceBytes: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.length,
    files,
    artifactRoot: manifest.policy.artifactRoot,
    gateAStatus: 'BLOCKED_PENDING_POC_EVIDENCE',
    nextStep: 'Bind the existing Phase 7 M0 authorization to this exact manifest and candidate set as POC_RESEARCH_ONLY; Gate A occurs after measurement.'
  };
}

async function downloadCandidates(manifest, candidates, options) {
  assertNetworkPermission({ operationRequested: true, allowNetwork: options.allowNetwork });
  if (!options.pocAuthorizationPath) {
    throw new PocError('POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD');
  }
  const authorization = await loadJson(options.pocAuthorizationPath);
  const candidateIds = candidates.map((candidate) => candidate.id).sort();
  const authorizationSummary = verifyPocAuthorization(authorization, manifest, candidateIds);
  const plan = buildPreparationPlan(manifest, candidates);
  if (plan.sourceBytes > options.maxBytes) {
    throw new PocError('PINNED_DOWNLOAD_EXCEEDS_MAX_BYTES');
  }
  const sourceRoot = resolveArtifactOutput(options.sourceRoot);
  await assertNoReparsePointsWithinArtifactRoot(resolve(sourceRoot, '_safety-probe'));
  await mkdir(sourceRoot, { recursive: true });

  const downloaded = [];
  for (const candidate of candidates) {
    const candidateRoot = resolve(sourceRoot, candidate.id, candidate.revision);
    await assertNoReparsePointsWithinArtifactRoot(resolve(candidateRoot, '_safety-probe'));
    await mkdir(candidateRoot, { recursive: true });
    for (const file of candidate.sourceFiles) {
      const target = resolve(candidateRoot, ...file.path.split('/'));
      await assertNoReparsePointsWithinArtifactRoot(target);
      await mkdir(resolve(target, '..'), { recursive: true });
      const existing = await verifyExistingFile(target, file);
      if (existing === 'MATCH') {
        downloaded.push({
          candidateId: candidate.id,
          path: file.path,
          size: file.size,
          status: 'EXISTING_VERIFIED'
        });
        continue;
      }
      if (existing === 'MISMATCH') {
        throw new PocError('EXISTING_SOURCE_FILE_HASH_MISMATCH');
      }
      const result = await downloadPinnedFile(candidateDownloadUrl(candidate, file), target, file);
      downloaded.push({
        candidateId: candidate.id,
        path: file.path,
        size: result.size,
        status: 'DOWNLOADED_VERIFIED'
      });
    }
  }
  return {
    schemaVersion: 'phase7-offline-poc-preparation-result-v1',
    status: 'DOWNLOADED_FOR_POC_NOT_CONVERTED',
    scope: authorizationSummary.scope,
    pocAuthorizationRecordId: authorizationSummary.authorizationRecordId,
    gateAStatus: 'BLOCKED_PENDING_POC_EVIDENCE',
    manifestSha256: manifestSha256(manifest),
    candidateIds,
    sourceBytes: plan.sourceBytes,
    fileCount: downloaded.length,
    files: downloaded,
    output: 'artifacts/phase7/offline-poc/sources',
    modelExecution: 'NOT_RUN'
  };
}

async function downloadPinnedFile(url, target, expected) {
  assertAllowedDownloadUrl(url);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'desktop-translate-phase7-offline-poc/1'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000)
  });
  if (!response.ok || !response.body) {
    throw new PocError('MODEL_SOURCE_DOWNLOAD_HTTP_FAILURE');
  }
  assertAllowedDownloadUrl(response.url);
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== expected.size) {
    throw new PocError('MODEL_SOURCE_CONTENT_LENGTH_MISMATCH');
  }

  const partial = `${target}.partial-${randomUUID()}`;
  const hash = createExpectedHash(expected);
  let observedSize = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      observedSize += chunk.length;
      if (observedSize > expected.size) {
        callback(new PocError('MODEL_SOURCE_EXCEEDED_PINNED_SIZE'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(partial, { flags: 'wx' })
    );
    if (observedSize !== expected.size || hash.digest('hex') !== expected.digest) {
      throw new PocError('MODEL_SOURCE_DIGEST_MISMATCH');
    }
    await rename(partial, target);
    return { size: observedSize };
  } catch (error) {
    try {
      await unlink(partial);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new PocError('PARTIAL_DOWNLOAD_QUARANTINE_REQUIRED');
      }
    }
    throw error;
  }
}

async function verifyExistingFile(path, expected) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) {
      return 'MISMATCH';
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'MISSING';
    }
    throw error;
  }
  const hash = createExpectedHash(expected);
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return size === expected.size && hash.digest('hex') === expected.digest ? 'MATCH' : 'MISMATCH';
}

function createExpectedHash(expected) {
  if (expected.digestAlgorithm === 'sha256') {
    return createHash('sha256');
  }
  if (expected.digestAlgorithm === 'git-blob-sha1') {
    return createHash('sha1').update(`blob ${expected.size}\0`, 'utf8');
  }
  throw new PocError('UNSUPPORTED_DIGEST_ALGORITHM');
}

function assertAllowedDownloadUrl(value) {
  const parsed = new URL(value);
  const allowed = parsed.protocol === 'https:'
    && ALLOWED_FINAL_HOSTS.some((host) => (
      host.startsWith('.') ? parsed.hostname.endsWith(host) : parsed.hostname === host
    ));
  if (!allowed || parsed.username || parsed.password) {
    throw new PocError('MODEL_SOURCE_DOWNLOAD_HOST_REJECTED');
  }
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const manifest = await loadManifest(options.manifestPath);
  const candidates = selectedCandidates(manifest, options);
  if (options.authorizationTemplatePath) {
    const authorization = createPendingPocAuthorization(
      manifest,
      candidates.map((candidate) => candidate.id)
    );
    await writeJsonArtifact(options.authorizationTemplatePath, authorization);
    process.stdout.write(`${JSON.stringify({
      status: 'PENDING_POC_AUTHORIZATION_TEMPLATE_CREATED',
      manifestSha256: authorization.manifestSha256,
      candidateIds: authorization.candidateIds,
      scope: authorization.scope,
      gateAStatus: 'BLOCKED_PENDING_POC_EVIDENCE',
      outputFile: basename(options.authorizationTemplatePath),
      modelWeightsDownloaded: false
    }, null, 2)}\n`);
    return;
  }
  if (options.download) {
    const report = await downloadCandidates(manifest, candidates, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(buildPreparationPlan(manifest, candidates), null, 2)}\n`);
}

export function parseArguments(args) {
  const options = {
    allowNetwork: false,
    candidateId: null,
    candidateSetId: null,
    authorizationTemplatePath: null,
    download: false,
    pocAuthorizationPath: null,
    help: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    maxBytes: DEFAULT_MAX_BYTES,
    sourceRoot: DEFAULT_SOURCE_ROOT
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-network') {
      options.allowNetwork = true;
    } else if (argument === '--candidate') {
      options.candidateId = requireValue(args, ++index, argument);
    } else if (argument === '--candidate-set') {
      options.candidateSetId = requireValue(args, ++index, argument);
    } else if (argument === '--authorization-template') {
      options.authorizationTemplatePath = requireValue(args, ++index, argument);
    } else if (argument === '--download') {
      options.download = true;
    } else if (argument === '--poc-authorization') {
      options.pocAuthorizationPath = requireValue(args, ++index, argument);
    } else if (argument === '--manifest') {
      options.manifestPath = requireValue(args, ++index, argument);
    } else if (argument === '--max-bytes') {
      options.maxBytes = parsePositiveInteger(requireValue(args, ++index, argument));
    } else if (argument === '--source-root') {
      options.sourceRoot = requireValue(args, ++index, argument);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new PocError('UNKNOWN_ARGUMENT');
    }
  }
  if (options.candidateId && options.candidateSetId) {
    throw new PocError('CANDIDATE_AND_SET_ARE_MUTUALLY_EXCLUSIVE');
  }
  if (options.authorizationTemplatePath && options.download) {
    throw new PocError('AUTHORIZATION_TEMPLATE_AND_DOWNLOAD_ARE_MUTUALLY_EXCLUSIVE');
  }
  return options;
}

function parsePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new PocError('MAX_BYTES_MUST_BE_POSITIVE_INTEGER');
  }
  return number;
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
    const code = error instanceof PocError ? error.code : 'UNEXPECTED_PREPARATION_FAILURE';
    process.stderr.write(`${JSON.stringify({ status: 'BLOCKED', errorCode: code })}\n`);
    process.exitCode = 1;
  });
}

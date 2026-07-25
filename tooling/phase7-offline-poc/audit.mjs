import { pathToFileURL } from 'node:url';
import {
  DEFAULT_MANIFEST_PATH,
  PocError,
  assertNetworkPermission,
  loadManifest,
  manifestSha256,
  summarizeCandidate,
  validateManifest,
  writeJsonArtifact
} from './lib.mjs';

const HELP = `Phase 7 offline model candidate audit

Usage:
  node tooling/phase7-offline-poc/audit.mjs
  node tooling/phase7-offline-poc/audit.mjs --refresh-remote --allow-network
  node tooling/phase7-offline-poc/audit.mjs --output artifacts/phase7/offline-poc/audits/audit.json

The default command performs no network access and no model download.
--refresh-remote reads small Hugging Face metadata JSON only and requires
--allow-network. It never mutates candidates.json.
`;

export function auditManifest(manifest, remoteAudit = null) {
  const validationErrors = validateManifest(manifest);
  const candidateSummaries = Array.isArray(manifest.candidates)
    ? manifest.candidates.map((candidate) => summarizeCandidate(manifest, candidate))
    : [];
  const candidateById = new Map(candidateSummaries.map((candidate) => [candidate.id, candidate]));
  const candidateSets = Array.isArray(manifest.candidateSets)
    ? manifest.candidateSets.map((candidateSet) => ({
        id: candidateSet.id,
        priority: candidateSet.priority,
        status: candidateSet.status,
        candidateIds: candidateSet.candidateIds,
        licenseExpressions: candidateSet.licenseExpressions,
        licenseConsistency: candidateSet.licenseConsistency,
        sourceBytes: candidateSet.candidateIds.reduce(
          (sum, id) => sum + (candidateById.get(id)?.sourceBytes ?? 0),
          0
        )
      }))
    : [];
  return {
    schemaVersion: 'phase7-offline-poc-audit-v1',
    auditedAt: new Date().toISOString(),
    status: validationErrors.length > 0
      ? 'INVALID'
      : 'GATE_A_BLOCKED_POC_RESEARCH_ELIGIBLE',
    scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    network: {
      requested: remoteAudit !== null,
      modelWeightsDownloaded: false,
      mode: remoteAudit === null ? 'OFFLINE_STATIC' : 'METADATA_ONLY'
    },
    manifest: {
      schemaVersion: manifest.schemaVersion ?? null,
      sha256: manifestSha256(manifest),
      capturedAt: manifest.metadataSnapshot?.capturedAt ?? null
    },
    runtime: {
      id: manifest.runtime?.id ?? null,
      version: manifest.runtime?.version ?? null,
      tag: manifest.runtime?.tag ?? null,
      commit: manifest.runtime?.commit ?? null,
      wheelSha256: manifest.runtime?.windowsWheel?.sha256 ?? null,
      licenseExpression: manifest.runtime?.license?.expression ?? null
    },
    candidateSets,
    candidates: candidateSummaries,
    gateA: {
      status: manifest.gateA?.status ?? 'INVALID',
      harnessMayDecide: manifest.gateA?.harnessMayDecide ?? null,
      blocksPocResearch: manifest.gateA?.blocksPocResearch ?? null,
      requiredInput: manifest.gateA?.requiredInput ?? null,
      blockerCodes: Array.isArray(manifest.gateA?.blockers)
        ? manifest.gateA.blockers.map((blocker) => blocker.code).sort()
        : []
    },
    validationErrors,
    remoteAudit
  };
}

export async function refreshRemoteMetadata(manifest) {
  const results = [];
  for (const candidate of manifest.candidates) {
    const endpoint = new URL(`https://huggingface.co/api/models/${candidate.repository}`);
    endpoint.searchParams.set('blobs', 'true');
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent': manifest.metadataSnapshot.userAgent
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      throw new PocError('REMOTE_METADATA_HTTP_FAILURE');
    }
    const metadata = await response.json();
    const remoteFiles = new Map(
      (metadata.siblings ?? []).map((file) => [
        file.rfilename,
        {
          size: file.size,
          digestAlgorithm: file.lfs?.sha256 ? 'sha256' : 'git-blob-sha1',
          digest: file.lfs?.sha256 ?? file.blobId
        }
      ])
    );
    const mismatches = [];
    if (metadata.sha !== candidate.revision) {
      mismatches.push('REVISION');
    }
    if (normalizeLicense(metadata.cardData?.license) !== normalizeLicense(candidate.license.observedMetadata)) {
      mismatches.push('LICENSE');
    }
    if (metadata.gated !== candidate.gated) {
      mismatches.push('GATED_STATUS');
    }
    for (const expectedFile of candidate.sourceFiles) {
      const observed = remoteFiles.get(expectedFile.path);
      if (!observed) {
        mismatches.push(`FILE_MISSING:${expectedFile.path}`);
      } else if (observed.size !== expectedFile.size
          || observed.digestAlgorithm !== expectedFile.digestAlgorithm
          || observed.digest !== expectedFile.digest) {
        mismatches.push(`FILE_PIN:${expectedFile.path}`);
      }
    }
    results.push({
      candidateId: candidate.id,
      status: mismatches.length === 0 ? 'MATCH' : 'DRIFT',
      remoteRevision: metadata.sha ?? null,
      remoteLicense: metadata.cardData?.license ?? null,
      lastModified: metadata.lastModified ?? null,
      filesChecked: candidate.sourceFiles.length,
      mismatches
    });
  }
  return {
    checkedAt: new Date().toISOString(),
    source: 'Hugging Face official metadata API',
    status: results.every((result) => result.status === 'MATCH') ? 'MATCH' : 'DRIFT',
    candidates: results
  };
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  assertNetworkPermission({
    operationRequested: options.refreshRemote,
    allowNetwork: options.allowNetwork
  });
  const manifest = await loadManifest(options.manifestPath);
  const remoteAudit = options.refreshRemote ? await refreshRemoteMetadata(manifest) : null;
  const report = auditManifest(manifest, remoteAudit);
  if (options.outputPath) {
    await writeJsonArtifact(options.outputPath, report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArguments(args) {
  const options = {
    allowNetwork: false,
    help: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    outputPath: null,
    refreshRemote: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-network') {
      options.allowNetwork = true;
    } else if (argument === '--refresh-remote') {
      options.refreshRemote = true;
    } else if (argument === '--manifest') {
      options.manifestPath = requireValue(args, ++index, '--manifest');
    } else if (argument === '--output') {
      options.outputPath = requireValue(args, ++index, '--output');
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new PocError('UNKNOWN_ARGUMENT');
    }
  }
  return options;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new PocError(`MISSING_VALUE_${option.slice(2).toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

function normalizeLicense(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function directInvocation() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (directInvocation()) {
  runCli().catch((error) => {
    const code = error instanceof PocError ? error.code : 'UNEXPECTED_AUDIT_FAILURE';
    const validationErrors = Array.isArray(error?.validationErrors) ? error.validationErrors : [];
    process.stderr.write(`${JSON.stringify({ status: 'BLOCKED', errorCode: code, validationErrors })}\n`);
    process.exitCode = 1;
  });
}

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import {
  POC_RESEARCH_SCOPE,
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  canonicalJson,
  resolveArtifactOutput,
  sha256Text
} from './lib.mjs';

const DATASET_SCHEMA_VERSION = 'phase7-gate-a-self-authored-dataset-v1';
const OUTPUT_SCHEMA_VERSION = 'phase7-bergamot-private-candidate-output-v1';
const OUTPUT_ITEM_SCHEMA_VERSION =
  'phase7-bergamot-generation-output-item-v1';
const GENERATION_SCHEMA_VERSION = 'phase7-gate-a-candidate-generation-v1';
const GENERATION_IDENTITY_SCHEMA_VERSION =
  'phase7-gate-a-candidate-generation-identity-v1';
const MINIMUM_RECORDS = 200;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DIRECTIONS = new Set(['en-zh', 'zh-en']);

export async function loadBergamotGenerationDataset(path, direction) {
  assertDirection(direction);
  const target = resolveArtifactOutput(path);
  await assertNoReparsePointsWithinArtifactRoot(target);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PocError('BERGAMOT_GENERATION_DATASET_FILE_INVALID');
  }
  const raw = await readFile(target);
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PocError('BERGAMOT_GENERATION_DATASET_JSON_INVALID');
  }
  validateDatasetDocument(document, direction);

  const sourceHashes = new Set();
  const itemIds = new Set();
  const itemIdentities = document.records.map((record) => {
    const sourceSha256 = sha256Text(record.source);
    const referenceSha256 = sha256Text(record.reference);
    if (itemIds.has(record.itemId)) {
      throw new PocError('BERGAMOT_GENERATION_DATASET_ITEM_ID_DUPLICATE');
    }
    if (sourceHashes.has(sourceSha256)) {
      throw new PocError('BERGAMOT_GENERATION_DATASET_SOURCE_DUPLICATE');
    }
    itemIds.add(record.itemId);
    sourceHashes.add(sourceSha256);
    return {
      itemId: record.itemId,
      direction: record.direction,
      sourceSha256,
      referenceSha256,
      tags: [...record.tags].sort()
    };
  }).sort(compareItemIdentity);
  const sourceSetIdentity = {
    schemaVersion: 'phase7-gate-a-source-set-identity-v1',
    datasetId: document.datasetId,
    snapshotId: document.snapshotId,
    licenseExpression: document.licenseExpression,
    contentDeclaration: document.contentDeclaration,
    usageAuthorization: document.usageAuthorization,
    records: itemIdentities
  };
  return {
    document,
    rawSha256: sha256Bytes(raw),
    rendererRecords: document.records.map((record) => ({
      itemId: record.itemId,
      direction: record.direction,
      source: record.source
    })),
    sourceSet: {
      schemaVersion: 'phase7-gate-a-source-set-v1',
      recordCount: document.records.length,
      identitySha256: sha256Text(canonicalJson(sourceSetIdentity))
    }
  };
}

export function buildBergamotGenerationArtifacts({
  authorization,
  authorizationRaw,
  candidateId,
  direction,
  generationRunId,
  manifestSha256,
  materializedRuntimeTreeSha256,
  modelTreeSha256,
  rendererGeneration,
  servedRuntimeTreeSha256,
  sourceSet,
  workloadIdentity
}) {
  assertDirection(direction);
  assertSafeId(candidateId, 'BERGAMOT_GENERATION_CANDIDATE_ID_INVALID');
  assertSafeId(
    generationRunId,
    'BERGAMOT_GENERATION_RUN_ID_INVALID'
  );
  if (!Buffer.isBuffer(authorizationRaw)
      || authorizationRaw.length < 1
      || !isRecord(authorization)
      || !SAFE_ID.test(authorization.authorizationRecordId ?? '')) {
    throw new PocError('BERGAMOT_GENERATION_AUTHORIZATION_INVALID');
  }
  for (const [value, code] of [
    [manifestSha256, 'BERGAMOT_GENERATION_MANIFEST_IDENTITY_INVALID'],
    [modelTreeSha256, 'BERGAMOT_GENERATION_MODEL_IDENTITY_INVALID'],
    [
      materializedRuntimeTreeSha256,
      'BERGAMOT_GENERATION_MATERIALIZED_RUNTIME_IDENTITY_INVALID'
    ],
    [
      servedRuntimeTreeSha256,
      'BERGAMOT_GENERATION_SERVED_RUNTIME_IDENTITY_INVALID'
    ]
  ]) {
    if (!SHA256.test(value ?? '')) {
      throw new PocError(code);
    }
  }
  if (!isRecord(sourceSet)
      || sourceSet.schemaVersion !== 'phase7-gate-a-source-set-v1'
      || !Number.isSafeInteger(sourceSet.recordCount)
      || sourceSet.recordCount < MINIMUM_RECORDS
      || !SHA256.test(sourceSet.identitySha256 ?? '')) {
    throw new PocError('BERGAMOT_GENERATION_SOURCE_SET_INVALID');
  }
  validateWorkloadIdentity(workloadIdentity);
  const records = validateRendererGeneration({
    candidateId,
    direction,
    generationRunId,
    rendererGeneration,
    sourceSet
  });
  const candidateOutput = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    scope: POC_RESEARCH_SCOPE,
    candidateId,
    generationRunId,
    direction,
    records
  };
  const candidateOutputSerialized = serializeJsonArtifact(candidateOutput);
  const itemIdentitySet = records.map((record) => ({
    itemId: record.itemId,
    direction: record.direction,
    candidateId: record.candidateId,
    generationRunId: record.generationRunId,
    sourceSha256: record.sourceSha256
  })).sort(compareItemIdentity);
  const authorizationSha256 = sha256Bytes(authorizationRaw);
  const identity = {
    schemaVersion: GENERATION_IDENTITY_SCHEMA_VERSION,
    direction,
    candidateId,
    generationRunId,
    manifestSha256,
    authorizationSha256,
    authorizationRecordId: authorization.authorizationRecordId,
    model: {
      treeSha256: modelTreeSha256
    },
    runtime: {
      materializedTreeSha256: materializedRuntimeTreeSha256,
      servedTreeSha256: servedRuntimeTreeSha256
    },
    sourceSet: {
      schemaVersion: sourceSet.schemaVersion,
      recordCount: sourceSet.recordCount,
      identitySha256: sourceSet.identitySha256
    },
    workloadIdentitySha256: sha256Text(canonicalJson(workloadIdentity))
  };
  const evidence = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    status: 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE',
    scope: POC_RESEARCH_SCOPE,
    identity,
    identitySha256: sha256Text(canonicalJson(identity)),
    candidateOutput: {
      artifactSha256: sha256Text(candidateOutputSerialized),
      recordCount: records.length,
      itemIdentitySetSha256: sha256Text(canonicalJson(itemIdentitySet)),
      rawTextEmittedInEvidence: false
    },
    privacy: {
      sourceTextInEvidence: false,
      translationTextInEvidence: false,
      absolutePathsInEvidence: false,
      usernamesInEvidence: false
    },
    gateA: {
      ready: false,
      integrationOrDistributionAuthorized: false
    }
  };
  assertBergamotGenerationEvidencePrivacy(evidence);
  return {
    candidateOutput,
    candidateOutputSerialized,
    evidence,
    summary: {
      schemaVersion: 'phase7-bergamot-generation-summary-v1',
      status: evidence.status,
      direction,
      candidateId,
      generationRunId,
      recordCount: records.length,
      sourceSetIdentitySha256: sourceSet.identitySha256,
      candidateOutputArtifactSha256:
        evidence.candidateOutput.artifactSha256,
      candidateOutputItemIdentitySetSha256:
        evidence.candidateOutput.itemIdentitySetSha256,
      generationIdentitySha256: evidence.identitySha256,
      rawTextEmitted: false,
      absolutePathsEmitted: false,
      integrationOrDistributionAuthorized: false
    }
  };
}

export function assertBergamotGenerationEvidencePrivacy(value) {
  const serialized = JSON.stringify(value);
  for (const key of [
    '"source"',
    '"reference"',
    '"translation"',
    '"sourceText"',
    '"translatedText"',
    '"absolutePath"',
    '"username"'
  ]) {
    if (serialized.includes(key)) {
      throw new PocError('BERGAMOT_GENERATION_EVIDENCE_PRIVACY_VIOLATION');
    }
  }
}

export function serializeJsonArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateDatasetDocument(document, direction) {
  if (!exactKeys(document, [
    'schemaVersion',
    'status',
    'scope',
    'datasetId',
    'snapshotId',
    'licenseExpression',
    'contentDeclaration',
    'containsPersonalData',
    'usageAuthorization',
    'records'
  ])
      || document.schemaVersion !== DATASET_SCHEMA_VERSION
      || document.status !== 'SELF_AUTHORED_SYNTHETIC_DATASET_FROZEN'
      || document.scope !== POC_RESEARCH_SCOPE
      || !SAFE_ID.test(document.datasetId ?? '')
      || !SAFE_ID.test(document.snapshotId ?? '')
      || document.licenseExpression
        !== 'SELF-AUTHORED-FOR-PHASE7-RESEARCH'
      || document.contentDeclaration
        !== 'NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS'
      || document.containsPersonalData !== false
      || document.usageAuthorization
        !== 'AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION'
      || !Array.isArray(document.records)
      || document.records.length < MINIMUM_RECORDS) {
    throw new PocError('BERGAMOT_GENERATION_DATASET_INVALID');
  }
  for (const record of document.records) {
    if (!exactKeys(record, [
      'itemId',
      'direction',
      'source',
      'reference',
      'tags'
    ])
        || !SAFE_ID.test(record.itemId ?? '')
        || record.direction !== direction
        || typeof record.source !== 'string'
        || record.source.trim().length < 1
        || record.source.length > 12_000
        || typeof record.reference !== 'string'
        || record.reference.trim().length < 1
        || record.reference.length > 12_000
        || !Array.isArray(record.tags)
        || record.tags.length < 1
        || record.tags.length > 8
        || record.tags.some((tag) => (
          typeof tag !== 'string'
          || !/^[a-z0-9][a-z0-9-]{1,31}$/u.test(tag)
        ))) {
      throw new PocError('BERGAMOT_GENERATION_DATASET_RECORD_INVALID');
    }
  }
}

function validateRendererGeneration({
  candidateId,
  direction,
  generationRunId,
  rendererGeneration,
  sourceSet
}) {
  if (!isRecord(rendererGeneration)
      || rendererGeneration.schemaVersion
        !== 'phase7-bergamot-renderer-generation-v1'
      || rendererGeneration.generationRunId !== generationRunId
      || !Array.isArray(rendererGeneration.records)
      || rendererGeneration.records.length !== sourceSet.recordCount) {
    throw new PocError('BERGAMOT_GENERATION_RENDERER_RESULT_INVALID');
  }
  const itemIds = new Set();
  return rendererGeneration.records.map((record) => {
    if (!exactKeys(record, [
      'itemId',
      'direction',
      'sourceSha256',
      'translation'
    ])
        || !SAFE_ID.test(record.itemId ?? '')
        || itemIds.has(record.itemId)
        || record.direction !== direction
        || !SHA256.test(record.sourceSha256 ?? '')
        || typeof record.translation !== 'string'
        || record.translation.trim().length < 1
        || record.translation.length > 48_000) {
      throw new PocError('BERGAMOT_GENERATION_RENDERER_RECORD_INVALID');
    }
    itemIds.add(record.itemId);
    return {
      schemaVersion: OUTPUT_ITEM_SCHEMA_VERSION,
      itemId: record.itemId,
      direction,
      candidateId,
      generationRunId,
      sourceSha256: record.sourceSha256,
      translation: record.translation
    };
  });
}

function validateWorkloadIdentity(value) {
  if (!exactKeys(value, [
    'sourceChars',
    'sourceSha256',
    'sampleIdentitySha256',
    'workloadConfigSha256'
  ])
      || !Number.isSafeInteger(value.sourceChars)
      || value.sourceChars < 1
      || !SHA256.test(value.sourceSha256 ?? '')
      || !SHA256.test(value.sampleIdentitySha256 ?? '')
      || !SHA256.test(value.workloadConfigSha256 ?? '')) {
    throw new PocError('BERGAMOT_GENERATION_WORKLOAD_IDENTITY_INVALID');
  }
}

function compareItemIdentity(left, right) {
  return left.itemId.localeCompare(right.itemId)
    || left.direction.localeCompare(right.direction);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0')
      === [...keys].sort().join('\0');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertDirection(direction) {
  if (!DIRECTIONS.has(direction)) {
    throw new PocError('BERGAMOT_GENERATION_DIRECTION_INVALID');
  }
}

function assertSafeId(value, code) {
  if (!SAFE_ID.test(value ?? '')) {
    throw new PocError(code);
  }
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  INPUT_SCHEMA_VERSION,
  validateInputRecords
} from './blind-eval.mjs';
import {
  loadBergamotGenerationDataset
} from './bergamot-generation-lib.mjs';
import {
  POC_RESEARCH_SCOPE,
  PocError,
  assertNoReparsePointsWithinArtifactRoot,
  canonicalJson,
  resolveArtifactOutput,
  sha256Text
} from './lib.mjs';

const DIRECTIONS = Object.freeze(['en-zh', 'zh-en']);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

export async function assembleBlindEvaluationInput({
  datasetPaths,
  candidateOutputPaths,
  generationEvidencePaths
}) {
  const records = [];
  const bindings = [];
  for (const direction of DIRECTIONS) {
    const dataset = await loadBergamotGenerationDataset(
      requiredDirectionPath(datasetPaths, direction, 'DATASET'),
      direction
    );
    const candidateOutputArtifact = await loadRegularArtifact(
      requiredDirectionPath(
        candidateOutputPaths,
        direction,
        'CANDIDATE_OUTPUT'
      ),
      'BLIND_ASSEMBLY_CANDIDATE_OUTPUT'
    );
    const generationArtifact = await loadRegularArtifact(
      requiredDirectionPath(
        generationEvidencePaths,
        direction,
        'GENERATION_EVIDENCE'
      ),
      'BLIND_ASSEMBLY_GENERATION_EVIDENCE'
    );
    const assembled = assembleDirection({
      direction,
      dataset,
      candidateOutput: candidateOutputArtifact.document,
      candidateOutputRaw: candidateOutputArtifact.raw,
      generationEvidence: generationArtifact.document,
      generationEvidenceRaw: generationArtifact.raw
    });
    records.push(...assembled.records);
    bindings.push(assembled.binding);
  }
  const validation = await validateInputRecords(records);
  if (validation.itemCount !== 400
      || validation.itemCountByDirection['en-zh'] !== 200
      || validation.itemCountByDirection['zh-en'] !== 200
      || validation.candidateCountByDirection['en-zh'] !== 1
      || validation.candidateCountByDirection['zh-en'] !== 1) {
    throw new PocError('BLIND_ASSEMBLY_INPUT_VALIDATION_INVALID');
  }
  return {
    records,
    validation,
    bindings: bindings.sort((left, right) =>
      left.direction.localeCompare(right.direction))
  };
}

export function assembleDirection({
  direction,
  dataset,
  candidateOutput,
  candidateOutputRaw,
  generationEvidence,
  generationEvidenceRaw
}) {
  assertDirection(direction);
  validateCandidateOutput(candidateOutput, direction);
  validateGenerationEvidence(generationEvidence, direction);
  if (!Buffer.isBuffer(candidateOutputRaw)
      || !Buffer.isBuffer(generationEvidenceRaw)) {
    throw new PocError('BLIND_ASSEMBLY_RAW_ARTIFACT_INVALID');
  }
  const identity = generationEvidence.identity;
  const candidateOutputIdentity = generationEvidence.candidateOutput;
  const candidateOutputSha256 = sha256Bytes(candidateOutputRaw);
  if (candidateOutputSha256 !== candidateOutputIdentity.artifactSha256
      || sha256Bytes(generationEvidenceRaw) === candidateOutputSha256
      || identity.sourceSet.identitySha256
        !== dataset.sourceSet.identitySha256
      || identity.sourceSet.recordCount !== dataset.sourceSet.recordCount
      || candidateOutputIdentity.recordCount !== dataset.sourceSet.recordCount
      || candidateOutput.candidateId !== identity.candidateId
      || candidateOutput.generationRunId !== identity.generationRunId
      || generationEvidence.identitySha256
        !== sha256Text(canonicalJson(identity))) {
    throw new PocError('BLIND_ASSEMBLY_CROSS_BINDING_MISMATCH');
  }

  const outputByItemId = new Map();
  const itemIdentities = [];
  for (const output of candidateOutput.records) {
    if (outputByItemId.has(output.itemId)) {
      throw new PocError('BLIND_ASSEMBLY_OUTPUT_ITEM_DUPLICATE');
    }
    outputByItemId.set(output.itemId, output);
    itemIdentities.push({
      itemId: output.itemId,
      direction: output.direction,
      candidateId: output.candidateId,
      generationRunId: output.generationRunId,
      sourceSha256: output.sourceSha256
    });
  }
  itemIdentities.sort(compareItemIdentity);
  if (sha256Text(canonicalJson(itemIdentities))
      !== candidateOutputIdentity.itemIdentitySetSha256) {
    throw new PocError('BLIND_ASSEMBLY_OUTPUT_IDENTITY_SET_MISMATCH');
  }

  const records = dataset.document.records.map((sourceRecord) => {
    const output = outputByItemId.get(sourceRecord.itemId);
    if (!output
        || output.direction !== direction
        || output.sourceSha256 !== sha256Text(sourceRecord.source)) {
      throw new PocError('BLIND_ASSEMBLY_SOURCE_OUTPUT_MISMATCH');
    }
    outputByItemId.delete(sourceRecord.itemId);
    return {
      schemaVersion: INPUT_SCHEMA_VERSION,
      itemId: sourceRecord.itemId,
      direction,
      source: sourceRecord.source,
      reference: sourceRecord.reference,
      tags: [...sourceRecord.tags],
      provenance: {
        kind: 'SELF_AUTHORED_SYNTHETIC',
        datasetId: dataset.document.datasetId,
        snapshotId: dataset.document.snapshotId,
        licenseExpression: dataset.document.licenseExpression,
        sourceLocator: 'SELF_AUTHORED_SYNTHETIC',
        contentDeclaration: dataset.document.contentDeclaration,
        derivedFromUserActivity: false,
        containsPersonalData: dataset.document.containsPersonalData,
        usageAuthorization: dataset.document.usageAuthorization
      },
      candidates: [{
        candidateId: candidateOutput.candidateId,
        generationRunId: candidateOutput.generationRunId,
        translation: output.translation
      }]
    };
  });
  if (outputByItemId.size !== 0) {
    throw new PocError('BLIND_ASSEMBLY_OUTPUT_ITEM_SET_MISMATCH');
  }
  return {
    records,
    binding: {
      direction,
      candidateId: candidateOutput.candidateId,
      generationRunId: candidateOutput.generationRunId,
      generationArtifactSha256: sha256Bytes(generationEvidenceRaw),
      generationIdentitySha256: generationEvidence.identitySha256,
      sourceSetIdentitySha256: identity.sourceSet.identitySha256,
      candidateOutputArtifactSha256: candidateOutputSha256,
      candidateOutputItemIdentitySetSha256:
        candidateOutputIdentity.itemIdentitySetSha256
    }
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  const assembled = await assembleBlindEvaluationInput({
    datasetPaths: {
      'en-zh': options.get('--dataset-en-zh'),
      'zh-en': options.get('--dataset-zh-en')
    },
    candidateOutputPaths: {
      'en-zh': options.get('--candidate-output-en-zh'),
      'zh-en': options.get('--candidate-output-zh-en')
    },
    generationEvidencePaths: {
      'en-zh': options.get('--generation-en-zh'),
      'zh-en': options.get('--generation-zh-en')
    }
  });
  const output = resolveArtifactOutput(options.get('--output'));
  await assertNoReparsePointsWithinArtifactRoot(output);
  await mkdir(dirname(output), { recursive: true });
  const serialized = `${assembled.records
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
  await writeFile(output, serialized, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'phase7-blind-eval-input-assembly-summary-v1',
    status: 'PRIVATE_BLIND_EVAL_INPUT_ASSEMBLED',
    scope: POC_RESEARCH_SCOPE,
    artifactSha256: sha256Text(serialized),
    itemCount: assembled.validation.itemCount,
    itemCountByDirection: assembled.validation.itemCountByDirection,
    candidateCountByDirection:
      assembled.validation.candidateCountByDirection,
    provenanceKinds: assembled.validation.provenanceKinds,
    bindings: assembled.bindings,
    rawTextEmittedInSummary: false,
    absolutePathsEmittedInSummary: false,
    humanReviewStatus: 'NOT_STARTED',
    integrationOrDistributionAuthorized: false
  }, null, 2)}\n`);
}

function parseArguments(argv) {
  const allowed = new Set([
    '--dataset-en-zh',
    '--dataset-zh-en',
    '--candidate-output-en-zh',
    '--candidate-output-zh-en',
    '--generation-en-zh',
    '--generation-zh-en',
    '--output'
  ]);
  if (argv.length !== allowed.size * 2) {
    throw new PocError('BLIND_ASSEMBLY_CLI_ARGUMENTS_INVALID');
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key)
        || options.has(key)
        || typeof value !== 'string'
        || value.length < 1
        || value.startsWith('--')) {
      throw new PocError('BLIND_ASSEMBLY_CLI_ARGUMENT_INVALID');
    }
    options.set(key, value);
  }
  if (options.size !== allowed.size) {
    throw new PocError('BLIND_ASSEMBLY_CLI_ARGUMENT_REQUIRED');
  }
  return options;
}

async function loadRegularArtifact(path, prefix) {
  const target = resolveArtifactOutput(path);
  await assertNoReparsePointsWithinArtifactRoot(target);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PocError(`${prefix}_FILE_INVALID`);
  }
  const raw = await readFile(target);
  try {
    return { raw, document: JSON.parse(raw.toString('utf8')) };
  } catch {
    throw new PocError(`${prefix}_JSON_INVALID`);
  }
}

function validateCandidateOutput(document, direction) {
  if (!exactKeys(document, [
    'schemaVersion',
    'scope',
    'candidateId',
    'generationRunId',
    'direction',
    'records'
  ])
      || document.schemaVersion
        !== 'phase7-bergamot-private-candidate-output-v1'
      || document.scope !== POC_RESEARCH_SCOPE
      || document.direction !== direction
      || !SAFE_ID.test(document.candidateId ?? '')
      || !SAFE_ID.test(document.generationRunId ?? '')
      || !Array.isArray(document.records)
      || document.records.length < 200) {
    throw new PocError('BLIND_ASSEMBLY_CANDIDATE_OUTPUT_INVALID');
  }
  for (const record of document.records) {
    if (!exactKeys(record, [
      'schemaVersion',
      'itemId',
      'direction',
      'candidateId',
      'generationRunId',
      'sourceSha256',
      'translation'
    ])
        || record.schemaVersion
          !== 'phase7-bergamot-generation-output-item-v1'
        || !SAFE_ID.test(record.itemId ?? '')
        || record.direction !== direction
        || record.candidateId !== document.candidateId
        || record.generationRunId !== document.generationRunId
        || !SHA256.test(record.sourceSha256 ?? '')
        || typeof record.translation !== 'string'
        || record.translation.trim().length < 1
        || record.translation.length > 48_000) {
      throw new PocError('BLIND_ASSEMBLY_CANDIDATE_OUTPUT_RECORD_INVALID');
    }
  }
}

function validateGenerationEvidence(document, direction) {
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
      || document.schemaVersion !== 'phase7-gate-a-candidate-generation-v1'
      || document.status !== 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE'
      || document.scope !== POC_RESEARCH_SCOPE
      || document.identity?.direction !== direction
      || !SAFE_ID.test(document.identity?.candidateId ?? '')
      || !SAFE_ID.test(document.identity?.generationRunId ?? '')
      || !SHA256.test(document.identitySha256 ?? '')
      || document.identity?.sourceSet?.schemaVersion
        !== 'phase7-gate-a-source-set-v1'
      || !Number.isSafeInteger(document.identity?.sourceSet?.recordCount)
      || document.identity.sourceSet.recordCount < 200
      || !SHA256.test(document.identity?.sourceSet?.identitySha256 ?? '')
      || !SHA256.test(document.candidateOutput?.artifactSha256 ?? '')
      || !SHA256.test(
        document.candidateOutput?.itemIdentitySetSha256 ?? ''
      )
      || document.candidateOutput?.rawTextEmittedInEvidence !== false
      || document.privacy?.sourceTextInEvidence !== false
      || document.privacy?.translationTextInEvidence !== false
      || document.privacy?.absolutePathsInEvidence !== false
      || document.privacy?.usernamesInEvidence !== false
      || document.gateA?.ready !== false
      || document.gateA?.integrationOrDistributionAuthorized !== false) {
    throw new PocError('BLIND_ASSEMBLY_GENERATION_EVIDENCE_INVALID');
  }
}

function requiredDirectionPath(paths, direction, kind) {
  const path = paths?.[direction];
  if (typeof path !== 'string' || path.length < 1) {
    throw new PocError(`BLIND_ASSEMBLY_${kind}_PATH_REQUIRED`);
  }
  return path;
}

function compareItemIdentity(left, right) {
  return left.itemId.localeCompare(right.itemId)
    || left.direction.localeCompare(right.direction);
}

function assertDirection(direction) {
  if (!DIRECTIONS.includes(direction)) {
    throw new PocError('BLIND_ASSEMBLY_DIRECTION_INVALID');
  }
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}

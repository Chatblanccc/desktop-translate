import {
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from './lib.mjs';
import {
  deriveGateACandidateBindings
} from './gate-a-candidate-bindings.mjs';

export const INPUT_SCHEMA_VERSION = 'phase7-blind-eval-input-item-v1';
export const BATCH_SCHEMA_VERSION = 'phase7-blind-eval-review-batch-item-v1';
export const SCORE_SCHEMA_VERSION = 'phase7-blind-eval-score-v1';
export const MANIFEST_SCHEMA_VERSION = 'phase7-blind-eval-manifest-v1';
export const ANSWER_KEY_SCHEMA_VERSION = 'phase7-blind-eval-private-answer-key-v1';
export const REPORT_SCHEMA_VERSION = 'phase7-blind-eval-report-v1';
export const REPORT_V2_SCHEMA_VERSION = 'phase7-blind-eval-report-v2';
export const MINIMUM_ITEMS_PER_DIRECTION = 200;
export const REQUIRED_DIRECTIONS = Object.freeze(['en-zh', 'zh-en']);
export const POC_SCOPE = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const artifactRoot = resolve(
  repositoryRoot,
  'artifacts',
  'phase7',
  'offline-poc'
);
const blindEvalArtifactRoot = resolve(artifactRoot, 'blind-eval');
const allowedInputRoots = [
  resolve(scriptRoot, 'fixtures', 'blind-eval'),
  resolve(artifactRoot, 'blind-eval-input')
];
const schemaRoot = resolve(scriptRoot, 'schemas');
const allowedLicenseExpressions = new Set([
  'Apache-2.0',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'MIT',
  'PUBLIC-DOMAIN',
  'SELF-AUTHORED-FOR-PHASE7-RESEARCH'
]);
const forbiddenTextPatterns = Object.freeze([
  {
    code: 'ABSOLUTE_WINDOWS_PATH_DETECTED',
    pattern: /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+)/u
  },
  {
    code: 'HOME_DIRECTORY_PATH_DETECTED',
    pattern: /(?:^|[\s"'(])\/(?:home|Users)\/[^/\s]+/u
  },
  {
    code: 'EMAIL_ADDRESS_DETECTED',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
  },
  {
    code: 'MAINLAND_PHONE_NUMBER_DETECTED',
    pattern: /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u
  },
  {
    code: 'CREDENTIAL_LIKE_VALUE_DETECTED',
    pattern: /\b(?:sk-(?:proj-)?|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{12,}\b/u
  },
  {
    code: 'CONTROL_CHARACTER_DETECTED',
    pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
  }
]);
const scoreErrorKeys = Object.freeze([
  'severeMistranslation',
  'untranslated',
  'garbled',
  'properNounError',
  'longSentenceError'
]);

let validatorsPromise;

export class BlindEvalError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'BlindEvalError';
    this.code = code;
    this.details = details;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJsonLines(content, kind) {
  const records = [];
  const seenBlankLine = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      if (index !== lines.length - 1) {
        seenBlankLine.push(index + 1);
      }
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new BlindEvalError('JSONL_PARSE_FAILED', {
        kind,
        lineNumber: index + 1
      });
    }
  }
  if (seenBlankLine.length > 0) {
    throw new BlindEvalError('JSONL_BLANK_LINE_REJECTED', {
      kind,
      lineNumber: seenBlankLine[0]
    });
  }
  if (records.length === 0) {
    throw new BlindEvalError('JSONL_EMPTY', { kind });
  }
  return records;
}

export async function validateInputRecords(
  records,
  { minimumItemsPerDirection = MINIMUM_ITEMS_PER_DIRECTION } = {}
) {
  if (
    !Number.isSafeInteger(minimumItemsPerDirection)
    || minimumItemsPerDirection < 1
  ) {
    throw new BlindEvalError('MINIMUM_ITEM_COUNT_INVALID');
  }
  const { validateInput } = await loadValidators();
  const itemIds = new Set();
  const sourceDigestsByDirection = new Map(
    REQUIRED_DIRECTIONS.map((direction) => [direction, new Set()])
  );
  const recordsByDirection = new Map(
    REQUIRED_DIRECTIONS.map((direction) => [direction, []])
  );
  const candidateContractByDirection = new Map();
  const phenomenonCoverage = new Map(
    REQUIRED_DIRECTIONS.map((direction) => [
      direction,
      new Set()
    ])
  );

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!validateInput(record)) {
      throw new BlindEvalError('INPUT_SCHEMA_VALIDATION_FAILED', {
        lineNumber: index + 1,
        schemaKeyword: validateInput.errors?.[0]?.keyword ?? 'unknown'
      });
    }
    assertAllowedProvenance(record, index + 1);
    for (const [field, text] of [
      ['source', record.source],
      ['reference', record.reference],
      ...record.candidates.map((candidate) => [
        `candidate:${candidate.candidateId}`,
        candidate.translation
      ])
    ]) {
      assertTextIsPrivacySafe(text, {
        lineNumber: index + 1,
        field
      });
    }
    if (itemIds.has(record.itemId)) {
      throw new BlindEvalError('DUPLICATE_ITEM_ID_REJECTED', {
        lineNumber: index + 1
      });
    }
    itemIds.add(record.itemId);

    const sourceDigest = sha256(normalizeTextForDuplicateCheck(record.source));
    const sourceDigests = sourceDigestsByDirection.get(record.direction);
    if (sourceDigests.has(sourceDigest)) {
      throw new BlindEvalError('DUPLICATE_SOURCE_ITEM_REJECTED', {
        direction: record.direction,
        lineNumber: index + 1
      });
    }
    sourceDigests.add(sourceDigest);

    const candidateIds = new Set();
    const candidateContract = [];
    for (const candidate of record.candidates) {
      if (candidateIds.has(candidate.candidateId)) {
        throw new BlindEvalError('DUPLICATE_CANDIDATE_ON_ITEM_REJECTED', {
          direction: record.direction,
          lineNumber: index + 1
        });
      }
      candidateIds.add(candidate.candidateId);
      candidateContract.push(
        `${candidate.candidateId}\u0000${candidate.generationRunId}`
      );
    }
    candidateContract.sort();
    const contractDigest = sha256(candidateContract.join('\n'));
    const expectedContract = candidateContractByDirection.get(record.direction);
    if (expectedContract && expectedContract !== contractDigest) {
      throw new BlindEvalError(
        'CANDIDATE_SET_OR_GENERATION_RUN_CHANGED_WITHIN_DIRECTION',
        {
          direction: record.direction,
          lineNumber: index + 1
        }
      );
    }
    candidateContractByDirection.set(record.direction, contractDigest);
    recordsByDirection.get(record.direction).push(record);
    for (const tag of record.tags) {
      phenomenonCoverage.get(record.direction).add(tag);
    }
  }

  for (const direction of REQUIRED_DIRECTIONS) {
    const count = recordsByDirection.get(direction).length;
    if (count < minimumItemsPerDirection) {
      throw new BlindEvalError('MINIMUM_ITEMS_PER_DIRECTION_NOT_MET', {
        direction,
        actual: count,
        required: minimumItemsPerDirection
      });
    }
    for (const tag of ['proper-noun', 'long-sentence']) {
      if (!phenomenonCoverage.get(direction).has(tag)) {
        throw new BlindEvalError('REQUIRED_PHENOMENON_COVERAGE_MISSING', {
          direction,
          tag
        });
      }
    }
  }

  return {
    itemCount: records.length,
    itemCountByDirection: Object.fromEntries(
      REQUIRED_DIRECTIONS.map((direction) => [
        direction,
        recordsByDirection.get(direction).length
      ])
    ),
    candidateCountByDirection: Object.fromEntries(
      REQUIRED_DIRECTIONS.map((direction) => [
        direction,
        recordsByDirection.get(direction)[0].candidates.length
      ])
    ),
    provenanceKinds: [
      ...new Set(records.map((record) => record.provenance.kind))
    ].sort(),
    minimumItemsPerDirection
  };
}

export async function buildEvaluationArtifacts(
  records,
  {
    runId,
    inputSha256,
    createdAt = new Date().toISOString(),
    seed = randomBytes(32).toString('hex'),
    reviewerToken = `reviewer-${randomBytes(12).toString('hex')}`,
    minimumItemsPerDirection = MINIMUM_ITEMS_PER_DIRECTION
  }
) {
  assertRunId(runId);
  assertSha256(inputSha256, 'INPUT_SHA256_INVALID');
  assertHex(seed, 64, 'RANDOMIZATION_SEED_INVALID');
  if (!/^reviewer-[a-f0-9]{24}$/u.test(reviewerToken)) {
    throw new BlindEvalError('REVIEWER_TOKEN_INVALID');
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new BlindEvalError('CREATED_AT_INVALID');
  }

  const validation = await validateInputRecords(records, {
    minimumItemsPerDirection
  });
  const seedBuffer = Buffer.from(seed, 'hex');
  const seedCommitment = sha256(`phase7-blind-eval-seed:${seed}`);
  const preparedItems = records.map((record) => {
    const candidates = record.candidates
      .map((candidate) => ({
        ...candidate,
        rank: deterministicRank(
          seedBuffer,
          `candidate:${record.direction}:${record.itemId}:${candidate.candidateId}`
        )
      }))
      .sort(compareRankThenCandidate);
    const itemToken = deterministicToken(
      seedBuffer,
      `item-token:${record.direction}:${record.itemId}`,
      24
    );
    return {
      rank: deterministicRank(
        seedBuffer,
        `item-order:${record.direction}:${record.itemId}`
      ),
      record,
      itemToken,
      candidates: candidates.map((candidate, index) => ({
        evaluationId: deterministicToken(
          seedBuffer,
          `evaluation:${record.direction}:${record.itemId}:${candidate.candidateId}`,
          32
        ),
        candidateAlias: candidateAlias(index),
        candidateId: candidate.candidateId,
        generationRunId: candidate.generationRunId,
        translation: candidate.translation
      }))
    };
  }).sort(compareRankThenItem);

  const batchRecords = preparedItems.map((item) => ({
    schemaVersion: BATCH_SCHEMA_VERSION,
    itemToken: item.itemToken,
    direction: item.record.direction,
    source: item.record.source,
    reference: item.record.reference,
    tags: item.record.tags,
    candidates: item.candidates.map((candidate) => ({
      evaluationId: candidate.evaluationId,
      candidateAlias: candidate.candidateAlias,
      translation: candidate.translation
    }))
  }));
  const scoreTemplateRecords = preparedItems.flatMap((item) =>
    item.candidates.map((candidate) => ({
      schemaVersion: SCORE_SCHEMA_VERSION,
      status: 'PENDING_HUMAN_REVIEW',
      evaluationId: candidate.evaluationId,
      reviewerToken
    }))
  );
  const answerKey = {
    schemaVersion: ANSWER_KEY_SCHEMA_VERSION,
    runId,
    scope: POC_SCOPE,
    randomizationSeed: seed,
    randomizationCommitment: seedCommitment,
    inputSha256,
    records: preparedItems.map((item) => ({
      itemToken: item.itemToken,
      itemId: item.record.itemId,
      direction: item.record.direction,
      sourceSha256: sha256(item.record.source),
      referenceSha256: sha256(item.record.reference),
      candidates: item.candidates.map((candidate) => ({
        evaluationId: candidate.evaluationId,
        candidateAlias: candidate.candidateAlias,
        candidateId: candidate.candidateId,
        generationRunId: candidate.generationRunId,
        translationSha256: sha256(candidate.translation)
      }))
    }))
  };

  const batchContent = toJsonLines(batchRecords);
  const scoreTemplateContent = toJsonLines(scoreTemplateRecords);
  const answerKeyContent = toPrettyJson(answerKey);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status: 'PENDING_HUMAN_REVIEW',
    runId,
    createdAt,
    scope: POC_SCOPE,
    requirements: {
      directions: REQUIRED_DIRECTIONS,
      minimumUniqueItemsPerCandidateDirection: MINIMUM_ITEMS_PER_DIRECTION,
      humanOnly: true,
      blindCandidateIdentity: true,
      duplicateEvaluationCountingAllowed: false
    },
    input: {
      sha256: inputSha256,
      itemCount: validation.itemCount,
      itemCountByDirection: validation.itemCountByDirection,
      candidateCountByDirection: validation.candidateCountByDirection,
      provenanceKinds: validation.provenanceKinds,
      acceptedProvenance:
        'PUBLIC_DATASET_OR_SELF_AUTHORED_SYNTHETIC_ONLY',
      userHistoryAccepted: false,
      freeFormSourceAccepted: false
    },
    randomization: {
      algorithm: 'HMAC_SHA256_RANK_V1',
      seedCommitment,
      candidateIdentityPresentInReviewBatch: false,
      privateAnswerKeyMustBeWithheldFromReviewer: true
    },
    reviewerToken,
    files: {
      reviewBatch: {
        logicalName: 'review-batch.jsonl',
        sha256: sha256(batchContent),
        recordCount: batchRecords.length
      },
      scoreTemplate: {
        logicalName: 'score-template.jsonl',
        sha256: sha256(scoreTemplateContent),
        recordCount: scoreTemplateRecords.length
      },
      privateAnswerKey: {
        logicalName: 'private-answer-key.json',
        sha256: sha256(answerKeyContent),
        recordCount: answerKey.records.length
      }
    },
    privacy: {
      sourceTextPresentOnlyInReviewBatch: true,
      sourceTextEmittedInManifestOrReport: false,
      absolutePathsEmitted: false,
      usernamesEmitted: false,
      freeTextReviewerNotesAccepted: false,
      structuredScoresOnly: true
    },
    gateA: {
      inputStatus: 'GATE_A_INPUT_INCOMPLETE',
      blindEvaluationStatus: 'PENDING_HUMAN_REVIEW',
      overallGateAStatus: 'BLOCKED_INCOMPLETE_M4_EVIDENCE'
    }
  };
  const manifestContent = toPrettyJson(manifest);
  const { validateManifest, validateAnswerKey } = await loadValidators();
  if (!validateManifest(manifest)) {
    throw new BlindEvalError('MANIFEST_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateManifest.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  if (!validateAnswerKey(answerKey)) {
    throw new BlindEvalError('PRIVATE_ANSWER_KEY_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateAnswerKey.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  assertNoCandidateIdentityInBatch(batchRecords);
  assertReportPrivacy(manifestContent);

  return {
    preparationReport: {
      status: 'BLIND_EVALUATION_BATCH_PREPARED',
      runId,
      scope: POC_SCOPE,
      itemCountByDirection: validation.itemCountByDirection,
      candidateCountByDirection: validation.candidateCountByDirection,
      evaluationCount: scoreTemplateRecords.length,
      randomizationCommitment: seedCommitment,
      files: Object.fromEntries(
        Object.entries(manifest.files).map(([key, value]) => [
          key,
          {
            logicalName: value.logicalName,
            sha256: value.sha256,
            recordCount: value.recordCount
          }
        ])
      ),
      humanReviewStatus: 'NOT_STARTED',
      gateAInputStatus: 'GATE_A_INPUT_INCOMPLETE',
      manifestSha256: sha256(manifestContent),
      modelExecution: 'NOT_RUN',
      networkActivity: 'NOT_PERFORMED'
    },
    manifest,
    manifestContent,
    batchRecords,
    batchContent,
    scoreTemplateRecords,
    scoreTemplateContent,
    answerKey,
    answerKeyContent
  };
}

export async function summarizeHumanScores({
  manifest,
  manifestContent = toPrettyJson(manifest),
  batchContent,
  scoreTemplateContent,
  answerKeyContent,
  scoresContent,
  reportId,
  summarizedAt = new Date().toISOString()
}) {
  assertReportId(reportId);
  if (Number.isNaN(Date.parse(summarizedAt))) {
    throw new BlindEvalError('SUMMARIZED_AT_INVALID');
  }
  assertManifestShape(manifest);
  let parsedManifestContent;
  try {
    parsedManifestContent = JSON.parse(manifestContent);
  } catch {
    throw new BlindEvalError('MANIFEST_PARSE_FAILED');
  }
  if (
    JSON.stringify(parsedManifestContent) !== JSON.stringify(manifest)
  ) {
    throw new BlindEvalError('MANIFEST_CONTENT_OBJECT_MISMATCH');
  }
  assertContentHash(
    batchContent,
    manifest.files.reviewBatch.sha256,
    'REVIEW_BATCH_HASH_MISMATCH'
  );
  assertContentHash(
    scoreTemplateContent,
    manifest.files.scoreTemplate.sha256,
    'SCORE_TEMPLATE_HASH_MISMATCH'
  );
  assertContentHash(
    answerKeyContent,
    manifest.files.privateAnswerKey.sha256,
    'PRIVATE_ANSWER_KEY_HASH_MISMATCH'
  );

  const batchRecords = parseJsonLines(batchContent, 'review-batch');
  const templateRecords = parseJsonLines(scoreTemplateContent, 'score-template');
  const scoreRecords = parseJsonLines(scoresContent, 'scores');
  let answerKey;
  try {
    answerKey = JSON.parse(answerKeyContent);
  } catch {
    throw new BlindEvalError('PRIVATE_ANSWER_KEY_PARSE_FAILED');
  }
  await validatePreparedArtifacts({
    manifest,
    batchRecords,
    templateRecords,
    answerKey
  });
  const normalizedScores = await validateScores({
    scoreRecords,
    expectedEvaluationIds: new Set(
      templateRecords.map((record) => record.evaluationId)
    ),
    reviewerToken: manifest.reviewerToken
  });

  const keyByEvaluationId = new Map();
  for (const item of answerKey.records) {
    for (const candidate of item.candidates) {
      keyByEvaluationId.set(candidate.evaluationId, {
        itemToken: item.itemToken,
        direction: item.direction,
        candidateId: candidate.candidateId,
        generationRunId: candidate.generationRunId
      });
    }
  }
  const joinedScores = normalizedScores.map((score) => ({
    ...keyByEvaluationId.get(score.evaluationId),
    ...score
  }));
  const aggregateGroups = new Map();
  for (const keyRecord of keyByEvaluationId.values()) {
    const key = `${keyRecord.direction}\u0000${keyRecord.candidateId}`;
    if (!aggregateGroups.has(key)) {
      aggregateGroups.set(key, {
        direction: keyRecord.direction,
        candidateId: keyRecord.candidateId,
        generationRunIds: new Set(),
        assignedItemTokens: new Set(),
        reviewedItemTokens: new Set(),
        reviewedScores: []
      });
    }
    const group = aggregateGroups.get(key);
    group.generationRunIds.add(keyRecord.generationRunId);
    group.assignedItemTokens.add(keyRecord.itemToken);
  }
  for (const score of joinedScores) {
    if (score.status !== 'HUMAN_REVIEWED') {
      continue;
    }
    const key = `${score.direction}\u0000${score.candidateId}`;
    const group = aggregateGroups.get(key);
    if (group.reviewedItemTokens.has(score.itemToken)) {
      throw new BlindEvalError('DUPLICATE_ITEM_COUNT_REJECTED', {
        direction: score.direction,
        candidateId: score.candidateId
      });
    }
    group.reviewedItemTokens.add(score.itemToken);
    group.reviewedScores.push(score);
  }

  const directions = REQUIRED_DIRECTIONS.map((direction) => ({
    direction,
    candidates: [...aggregateGroups.values()]
      .filter((group) => group.direction === direction)
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
      .map(summarizeCandidateGroup)
  }));
  const blindEvaluationComplete = directions.every((direction) =>
    direction.candidates.length > 0
    && direction.candidates.every(
      (candidate) => candidate.blindEvaluationEvidence.humanReviewed
    )
  );
  const rawScores = joinedScores
    .filter((score) => score.status === 'HUMAN_REVIEWED')
    .map((score) => ({
      evaluationId: score.evaluationId,
      itemToken: score.itemToken,
      direction: score.direction,
      candidateId: score.candidateId,
      generationRunId: score.generationRunId,
      reviewerToken: score.reviewerToken,
      reviewMode: score.reviewMode,
      blindnessAttestation: score.blindnessAttestation,
      humanReviewAttestation: score.humanReviewAttestation,
      reviewedAt: score.reviewedAt,
      acceptability: score.acceptability,
      adequacyScore: score.adequacyScore,
      fluencyScore: score.fluencyScore,
      errors: score.errors
    }));
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: blindEvaluationComplete
      ? 'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE'
      : 'HUMAN_BLIND_EVALUATION_INCOMPLETE',
    reportId,
    runId: manifest.runId,
    summarizedAt,
    scope: POC_SCOPE,
    humanOnly: true,
    blindCandidateIdentity: true,
    requirements: {
      directions: REQUIRED_DIRECTIONS,
      minimumUniqueItemsPerCandidateDirection: MINIMUM_ITEMS_PER_DIRECTION,
      duplicateEvaluationCountingAllowed: false
    },
    audit: {
      manifestSha256: sha256(manifestContent),
      inputSha256: manifest.input.sha256,
      reviewBatchSha256: sha256(batchContent),
      scoreTemplateSha256: sha256(scoreTemplateContent),
      privateAnswerKeySha256: sha256(answerKeyContent),
      rawScoresSha256: sha256(scoresContent),
      randomizationAlgorithm: manifest.randomization.algorithm,
      randomizationCommitment: manifest.randomization.seedCommitment,
      randomizedMappingVerified: true,
      candidateIdentityWithheldFromReviewBatch: true
    },
    counts: {
      assignedEvaluationCount: templateRecords.length,
      submittedRecordCount: normalizedScores.length,
      validHumanReviewCount: rawScores.length,
      pendingHumanReviewCount: normalizedScores.length - rawScores.length
    },
    directions,
    rawScores,
    privacy: {
      acceptedSourcePolicy:
        'PUBLIC_DATASET_OR_SELF_AUTHORED_SYNTHETIC_ONLY',
      userHistoryAccepted: false,
      freeFormSourceAccepted: false,
      rawSourceReferenceOrTranslationTextEmitted: false,
      absolutePathsEmitted: false,
      usernamesEmitted: false,
      freeTextReviewerNotesAccepted: false
    },
    gateA: {
      blindEvaluationComponentComplete: blindEvaluationComplete,
      inputStatus: 'GATE_A_INPUT_INCOMPLETE',
      overallGateAStatus: blindEvaluationComplete
        ? 'BLOCKED_PENDING_OTHER_M4_EVIDENCE_AND_USER_GATE_A_DECISION'
        : 'BLOCKED_PENDING_HUMAN_REVIEW_AND_OTHER_M4_EVIDENCE',
      limitation:
        'This human-only report can satisfy only the blind-evaluation component; it cannot authorize Gate A, product integration, packaging, or distribution.'
    }
  };
  const reportContent = toPrettyJson(report);
  const { validateReport } = await loadValidators();
  if (!validateReport(report)) {
    throw new BlindEvalError('REPORT_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateReport.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  assertReportPrivacy(reportContent);
  return {
    report,
    reportContent
  };
}

export async function summarizeHumanScoresV2({
  candidateBindingReport,
  ...summaryInput
}) {
  assertCandidateBindingReport(candidateBindingReport);
  const base = await summarizeHumanScores(summaryInput);
  if (
    base.report.status !== 'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE'
    || base.report.counts.pendingHumanReviewCount !== 0
  ) {
    throw new BlindEvalError('V2_REQUIRES_COMPLETE_HUMAN_REVIEW');
  }
  const bindingByDirection = new Map(
    candidateBindingReport.bindings.map((binding) => [
      binding.direction,
      binding
    ])
  );
  const answerKey = JSON.parse(summaryInput.answerKeyContent);
  const itemIdentitySetSha256ByDirection = Object.fromEntries(
    REQUIRED_DIRECTIONS.map((direction) => {
      const binding = bindingByDirection.get(direction);
      const itemIdentities = answerKey.records
        .filter((record) => record.direction === direction)
        .map((record) => ({
          direction: record.direction,
          itemId: record.itemId,
          sourceSha256: record.sourceSha256
        }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId));
      const itemIdentitySetSha256 = sha256(canonicalJson(itemIdentities));
      if (
        !binding
        || itemIdentities.length !== binding.sourceSetRecordCount
        || itemIdentitySetSha256
          !== binding.candidateOutputItemIdentitySetSha256
      ) {
        throw new BlindEvalError(
          'V2_REVIEWED_ITEM_SET_CANDIDATE_OUTPUT_MISMATCH',
          { direction }
        );
      }
      return [direction, itemIdentitySetSha256];
    })
  );
  const report = structuredClone(base.report);
  report.schemaVersion = REPORT_V2_SCHEMA_VERSION;
  report.candidateGenerationBindings =
    structuredClone(candidateBindingReport.bindings);
  report.rawScores = report.rawScores.map((score) => {
    const binding = bindingByDirection.get(score.direction);
    if (
      !binding
      || score.candidateId !== binding.candidateId
      || score.generationRunId !== binding.generationRunId
    ) {
      throw new BlindEvalError(
        'V2_RAW_SCORE_CANDIDATE_GENERATION_MISMATCH',
        { direction: score.direction }
      );
    }
    return {
      ...score,
      generationIdentitySha256: binding.generationIdentitySha256
    };
  });
  report.directions = report.directions.map((direction) => {
    const binding = bindingByDirection.get(direction.direction);
    if (
      !binding
      || direction.candidates.length !== 1
      || direction.candidates[0].candidateId !== binding.candidateId
      || direction.candidates[0].generationRunIds.length !== 1
      || direction.candidates[0].generationRunIds[0]
        !== binding.generationRunId
    ) {
      throw new BlindEvalError(
        'V2_DIRECTION_CANDIDATE_GENERATION_SET_MISMATCH',
        { direction: direction.direction }
      );
    }
    return {
      ...direction,
      candidates: [{
        ...direction.candidates[0],
        generationIdentitySha256: binding.generationIdentitySha256
      }]
    };
  });
  report.audit.candidateGenerationBindingSetSha256 =
    candidateBindingReport.bindingSetSha256;
  report.audit.candidateOutputItemIdentitySetSha256ByDirection =
    itemIdentitySetSha256ByDirection;
  report.audit.rawScoresSha256 = sha256(JSON.stringify(report.rawScores));

  const { validateReportV2 } = await loadValidators();
  if (!validateReportV2(report)) {
    throw new BlindEvalError('REPORT_V2_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateReportV2.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  const reportContent = toPrettyJson(report);
  assertReportPrivacy(reportContent);
  return { report, reportContent };
}

function assertCandidateBindingReport(report) {
  const bindings = Array.isArray(report?.bindings) ? report.bindings : [];
  const normalized = bindings.map((binding) => ({
    direction: binding?.direction,
    candidateId: binding?.candidateId,
    generationRunId: binding?.generationRunId,
    generationArtifactSha256: binding?.generationArtifactSha256,
    generationIdentitySha256: binding?.generationIdentitySha256,
    sourceSetIdentitySha256: binding?.sourceSetIdentitySha256,
    sourceSetRecordCount: binding?.sourceSetRecordCount,
    candidateOutputArtifactSha256:
      binding?.candidateOutputArtifactSha256,
    candidateOutputItemIdentitySetSha256:
      binding?.candidateOutputItemIdentitySetSha256
  })).sort((left, right) => left.direction.localeCompare(right.direction));
  if (
    report?.schemaVersion !== 'phase7-gate-a-candidate-binding-set-v1'
    || report?.integrationOrDistributionAuthorized !== false
    || report?.rawTextEmitted !== false
    || report?.absolutePathsEmitted !== false
    || bindings.length !== REQUIRED_DIRECTIONS.length
    || new Set(bindings.map((binding) => binding.direction)).size
      !== REQUIRED_DIRECTIONS.length
    || !REQUIRED_DIRECTIONS.every(
      (direction) => bindings.some((binding) => binding.direction === direction)
    )
    || bindings.some((binding) => (
      typeof binding.candidateId !== 'string'
      || typeof binding.generationRunId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(binding.generationArtifactSha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(binding.generationIdentitySha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(binding.sourceSetIdentitySha256 ?? '')
      || !Number.isSafeInteger(binding.sourceSetRecordCount)
      || binding.sourceSetRecordCount < MINIMUM_ITEMS_PER_DIRECTION
      || !/^[a-f0-9]{64}$/u.test(
        binding.candidateOutputArtifactSha256 ?? ''
      )
      || !/^[a-f0-9]{64}$/u.test(
        binding.candidateOutputItemIdentitySetSha256 ?? ''
      )
    ))
    || report.bindingSetSha256
      !== sha256(canonicalJson(normalized))
  ) {
    throw new BlindEvalError('CANDIDATE_BINDING_REPORT_INVALID');
  }
}

async function validatePreparedArtifacts({
  manifest,
  batchRecords,
  templateRecords,
  answerKey
}) {
  const { validateBatch, validateScore } = await loadValidators();
  const { validateAnswerKey } = await loadValidators();
  if (!validateAnswerKey(answerKey)) {
    throw new BlindEvalError('PRIVATE_ANSWER_KEY_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateAnswerKey.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  if (
    answerKey?.schemaVersion !== ANSWER_KEY_SCHEMA_VERSION
    || answerKey.runId !== manifest.runId
    || answerKey.scope !== POC_SCOPE
    || answerKey.inputSha256 !== manifest.input.sha256
    || answerKey.randomizationCommitment
      !== manifest.randomization.seedCommitment
  ) {
    throw new BlindEvalError('PRIVATE_ANSWER_KEY_BINDING_INVALID');
  }
  assertHex(
    answerKey.randomizationSeed,
    64,
    'PRIVATE_ANSWER_KEY_SEED_INVALID'
  );
  if (
    sha256(`phase7-blind-eval-seed:${answerKey.randomizationSeed}`)
    !== answerKey.randomizationCommitment
  ) {
    throw new BlindEvalError('RANDOMIZATION_COMMITMENT_MISMATCH');
  }
  if (
    batchRecords.length !== manifest.files.reviewBatch.recordCount
    || templateRecords.length !== manifest.files.scoreTemplate.recordCount
    || answerKey.records.length
      !== manifest.files.privateAnswerKey.recordCount
  ) {
    throw new BlindEvalError('PREPARED_RECORD_COUNT_MISMATCH');
  }

  for (let index = 0; index < batchRecords.length; index += 1) {
    if (!validateBatch(batchRecords[index])) {
      throw new BlindEvalError('REVIEW_BATCH_SCHEMA_VALIDATION_FAILED', {
        lineNumber: index + 1,
        schemaKeyword: validateBatch.errors?.[0]?.keyword ?? 'unknown'
      });
    }
  }
  for (let index = 0; index < templateRecords.length; index += 1) {
    if (!validateScore(templateRecords[index])) {
      throw new BlindEvalError('SCORE_TEMPLATE_SCHEMA_VALIDATION_FAILED', {
        lineNumber: index + 1,
        schemaKeyword: validateScore.errors?.[0]?.keyword ?? 'unknown'
      });
    }
    if (templateRecords[index].status !== 'PENDING_HUMAN_REVIEW') {
      throw new BlindEvalError('SCORE_TEMPLATE_NOT_PENDING', {
        lineNumber: index + 1
      });
    }
  }

  const seedBuffer = Buffer.from(answerKey.randomizationSeed, 'hex');
  const expectedItemOrder = [...answerKey.records].sort((left, right) => {
    const leftRank = deterministicRank(
      seedBuffer,
      `item-order:${left.direction}:${left.itemId}`
    );
    const rightRank = deterministicRank(
      seedBuffer,
      `item-order:${right.direction}:${right.itemId}`
    );
    return leftRank.localeCompare(rightRank)
      || left.itemId.localeCompare(right.itemId);
  });
  if (
    expectedItemOrder.some(
      (item, index) => item.itemToken !== answerKey.records[index]?.itemToken
    )
  ) {
    throw new BlindEvalError('ITEM_RANDOMIZATION_ORDER_INVALID');
  }

  const batchByItemToken = new Map(
    batchRecords.map((record) => [record.itemToken, record])
  );
  const expectedEvaluationIds = [];
  for (const item of answerKey.records) {
    const expectedItemToken = deterministicToken(
      seedBuffer,
      `item-token:${item.direction}:${item.itemId}`,
      24
    );
    if (item.itemToken !== expectedItemToken) {
      throw new BlindEvalError('ITEM_RANDOMIZATION_TOKEN_INVALID');
    }
    const batchItem = batchByItemToken.get(item.itemToken);
    if (
      !batchItem
      || batchItem.direction !== item.direction
      || sha256(batchItem.source) !== item.sourceSha256
      || sha256(batchItem.reference) !== item.referenceSha256
    ) {
      throw new BlindEvalError('REVIEW_BATCH_ANSWER_KEY_MISMATCH');
    }
    const expectedCandidates = [...item.candidates].sort((left, right) => {
      const leftRank = deterministicRank(
        seedBuffer,
        `candidate:${item.direction}:${item.itemId}:${left.candidateId}`
      );
      const rightRank = deterministicRank(
        seedBuffer,
        `candidate:${item.direction}:${item.itemId}:${right.candidateId}`
      );
      return leftRank.localeCompare(rightRank)
        || left.candidateId.localeCompare(right.candidateId);
    });
    for (let index = 0; index < expectedCandidates.length; index += 1) {
      const candidate = expectedCandidates[index];
      const expectedEvaluationId = deterministicToken(
        seedBuffer,
        `evaluation:${item.direction}:${item.itemId}:${candidate.candidateId}`,
        32
      );
      if (
        candidate.evaluationId !== expectedEvaluationId
        || candidate.candidateAlias !== candidateAlias(index)
      ) {
        throw new BlindEvalError('CANDIDATE_RANDOMIZATION_MAPPING_INVALID');
      }
      const batchCandidate = batchItem.candidates[index];
      if (
        batchCandidate?.evaluationId !== candidate.evaluationId
        || batchCandidate.candidateAlias !== candidate.candidateAlias
        || sha256(batchCandidate.translation) !== candidate.translationSha256
      ) {
        throw new BlindEvalError('REVIEW_BATCH_CANDIDATE_MAPPING_INVALID');
      }
      expectedEvaluationIds.push(candidate.evaluationId);
    }
  }
  if (
    new Set(expectedEvaluationIds).size !== expectedEvaluationIds.length
    || new Set(templateRecords.map((record) => record.evaluationId)).size
      !== templateRecords.length
  ) {
    throw new BlindEvalError('DUPLICATE_EVALUATION_ID_REJECTED');
  }
  if (
    templateRecords.some(
      (record, index) => record.evaluationId !== expectedEvaluationIds[index]
    )
  ) {
    throw new BlindEvalError('SCORE_TEMPLATE_ORDER_OR_MAPPING_INVALID');
  }
}

async function validateScores({
  scoreRecords,
  expectedEvaluationIds,
  reviewerToken
}) {
  const { validateScore } = await loadValidators();
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < scoreRecords.length; index += 1) {
    const score = scoreRecords[index];
    if (!validateScore(score)) {
      throw new BlindEvalError('SCORE_SCHEMA_VALIDATION_FAILED', {
        lineNumber: index + 1,
        schemaKeyword: validateScore.errors?.[0]?.keyword ?? 'unknown'
      });
    }
    if (!expectedEvaluationIds.has(score.evaluationId)) {
      throw new BlindEvalError('UNKNOWN_EVALUATION_ID_REJECTED', {
        lineNumber: index + 1
      });
    }
    if (seen.has(score.evaluationId)) {
      throw new BlindEvalError('DUPLICATE_SCORE_REJECTED', {
        lineNumber: index + 1
      });
    }
    if (score.reviewerToken !== reviewerToken) {
      throw new BlindEvalError('REVIEWER_TOKEN_MISMATCH', {
        lineNumber: index + 1
      });
    }
    if (score.status === 'HUMAN_REVIEWED') {
      const anyError = scoreErrorKeys.some((key) => score.errors[key]);
      if (
        (score.acceptability === 'ACCEPTABLE' && anyError)
        || (score.acceptability === 'UNACCEPTABLE' && !anyError)
      ) {
        throw new BlindEvalError(
          'ACCEPTABILITY_AND_ERROR_CLASSIFICATION_CONFLICT',
          { lineNumber: index + 1 }
        );
      }
    }
    seen.add(score.evaluationId);
    normalized.push(score);
  }
  if (seen.size !== expectedEvaluationIds.size) {
    throw new BlindEvalError('SCORE_RECORD_SET_INCOMPLETE', {
      actual: seen.size,
      required: expectedEvaluationIds.size
    });
  }
  return normalized;
}

function summarizeCandidateGroup(group) {
  const assignedN = group.assignedItemTokens.size;
  const validN = group.reviewedItemTokens.size;
  const acceptableN = group.reviewedScores.filter(
    (score) => score.acceptability === 'ACCEPTABLE'
  ).length;
  const severeErrors = Object.fromEntries(
    scoreErrorKeys.map((key) => {
      const count = group.reviewedScores.filter(
        (score) => score.errors[key]
      ).length;
      return [
        key,
        {
          count,
          rate: ratioOrNull(count, validN)
        }
      ];
    })
  );
  const complete = assignedN >= MINIMUM_ITEMS_PER_DIRECTION
    && validN === assignedN;
  return {
    candidateId: group.candidateId,
    generationRunIds: [...group.generationRunIds].sort(),
    N: assignedN,
    validN,
    uniqueItemN: validN,
    pendingN: assignedN - validN,
    acceptance: {
      count: acceptableN,
      rate: ratioOrNull(acceptableN, validN)
    },
    adequacyMean: meanOrNull(
      group.reviewedScores.map((score) => score.adequacyScore)
    ),
    fluencyMean: meanOrNull(
      group.reviewedScores.map((score) => score.fluencyScore)
    ),
    severeErrors,
    blindEvaluationEvidence: {
      blind: true,
      humanReviewed: complete,
      sampleCount: validN,
      rawScoresRecorded: validN > 0,
      severeErrorClassificationRecorded: validN > 0,
      minimumRequired: MINIMUM_ITEMS_PER_DIRECTION,
      componentStatus: complete
        ? 'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE'
        : 'HUMAN_BLIND_EVALUATION_INCOMPLETE'
    }
  };
}

function assertAllowedProvenance(record, lineNumber) {
  const provenance = record.provenance;
  if (!allowedLicenseExpressions.has(provenance.licenseExpression)) {
    throw new BlindEvalError('LICENSE_EXPRESSION_NOT_ALLOWED', {
      lineNumber
    });
  }
  if (
    provenance.contentDeclaration
      !== 'NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS'
    || provenance.derivedFromUserActivity !== false
    || provenance.containsPersonalData !== false
    || provenance.usageAuthorization
      !== 'AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION'
  ) {
    throw new BlindEvalError('PROVENANCE_PRIVACY_ATTESTATION_INVALID', {
      lineNumber
    });
  }
  if (provenance.kind === 'PUBLIC_DATASET') {
    let sourceUrl;
    try {
      sourceUrl = new URL(provenance.sourceLocator);
    } catch {
      throw new BlindEvalError('PUBLIC_SOURCE_LOCATOR_INVALID', {
        lineNumber
      });
    }
    if (
      sourceUrl.protocol !== 'https:'
      || sourceUrl.username.length > 0
      || sourceUrl.password.length > 0
      || sourceUrl.hash.length > 0
      || provenance.licenseExpression
        === 'SELF-AUTHORED-FOR-PHASE7-RESEARCH'
    ) {
      throw new BlindEvalError('PUBLIC_SOURCE_LOCATOR_INVALID', {
        lineNumber
      });
    }
  } else if (
    provenance.kind === 'SELF_AUTHORED_SYNTHETIC'
    && (
      provenance.sourceLocator !== 'SELF_AUTHORED_SYNTHETIC'
      || provenance.licenseExpression
        !== 'SELF-AUTHORED-FOR-PHASE7-RESEARCH'
    )
  ) {
    throw new BlindEvalError('SYNTHETIC_SOURCE_DECLARATION_INVALID', {
      lineNumber
    });
  }
}

function assertTextIsPrivacySafe(text, details) {
  for (const forbidden of forbiddenTextPatterns) {
    if (forbidden.pattern.test(text)) {
      throw new BlindEvalError('PRIVACY_TEXT_REJECTED', {
        ...details,
        reason: forbidden.code
      });
    }
  }
}

function assertNoCandidateIdentityInBatch(batchRecords) {
  const serialized = JSON.stringify(batchRecords);
  if (
    serialized.includes('"candidateId"')
    || serialized.includes('"generationRunId"')
  ) {
    throw new BlindEvalError('CANDIDATE_IDENTITY_LEAKED_INTO_REVIEW_BATCH');
  }
}

function assertReportPrivacy(serialized) {
  const privacyReportPatterns = [
    forbiddenTextPatterns[0],
    forbiddenTextPatterns[1],
    forbiddenTextPatterns[2],
    forbiddenTextPatterns[4]
  ];
  for (const forbidden of privacyReportPatterns) {
    if (forbidden.pattern.test(serialized)) {
      throw new BlindEvalError('REPORT_PRIVACY_INVARIANT_FAILED', {
        reason: forbidden.code
      });
    }
  }
  if (
    serialized.includes('"source":')
    || serialized.includes('"reference":')
    || serialized.includes('"translation":')
  ) {
    throw new BlindEvalError('RAW_TEXT_LEAKED_INTO_REPORT');
  }
}

function normalizeTextForDuplicateCheck(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function deterministicRank(seed, context) {
  return createHmac('sha256', seed).update(context).digest('hex');
}

function deterministicToken(seed, context, length) {
  return deterministicRank(seed, context).slice(0, length);
}

function compareRankThenCandidate(left, right) {
  return left.rank.localeCompare(right.rank)
    || left.candidateId.localeCompare(right.candidateId);
}

function compareRankThenItem(left, right) {
  return left.rank.localeCompare(right.rank)
    || left.record.itemId.localeCompare(right.record.itemId);
}

function candidateAlias(index) {
  if (index >= 26) {
    throw new BlindEvalError('TOO_MANY_CANDIDATES_PER_ITEM');
  }
  return String.fromCodePoint('A'.codePointAt(0) + index);
}

function toJsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function toPrettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ratioOrNull(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function meanOrNull(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertRunId(value) {
  if (!/^run-[a-f0-9]{16}$/u.test(value ?? '')) {
    throw new BlindEvalError('RUN_ID_INVALID');
  }
}

function assertReportId(value) {
  if (!/^report-[a-f0-9]{16}$/u.test(value ?? '')) {
    throw new BlindEvalError('REPORT_ID_INVALID');
  }
}

function assertSha256(value, code) {
  assertHex(value, 64, code);
}

function assertHex(value, length, code) {
  if (
    typeof value !== 'string'
    || value.length !== length
    || !/^[a-f0-9]+$/u.test(value)
  ) {
    throw new BlindEvalError(code);
  }
}

function assertContentHash(content, expected, code) {
  if (sha256(content) !== expected) {
    throw new BlindEvalError(code);
  }
}

function assertManifestShape(manifest) {
  if (
    manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || manifest.scope !== POC_SCOPE
    || manifest.status !== 'PENDING_HUMAN_REVIEW'
    || manifest.requirements?.minimumUniqueItemsPerCandidateDirection
      !== MINIMUM_ITEMS_PER_DIRECTION
    || manifest.requirements?.humanOnly !== true
    || manifest.requirements?.blindCandidateIdentity !== true
    || manifest.requirements?.duplicateEvaluationCountingAllowed !== false
    || manifest.randomization?.algorithm !== 'HMAC_SHA256_RANK_V1'
    || manifest.randomization?.candidateIdentityPresentInReviewBatch !== false
    || manifest.input?.userHistoryAccepted !== false
    || manifest.input?.freeFormSourceAccepted !== false
  ) {
    throw new BlindEvalError('MANIFEST_CONTRACT_INVALID');
  }
  assertRunId(manifest.runId);
  assertSha256(manifest.input?.sha256, 'MANIFEST_INPUT_SHA256_INVALID');
  assertSha256(
    manifest.randomization?.seedCommitment,
    'MANIFEST_RANDOMIZATION_COMMITMENT_INVALID'
  );
  for (const key of [
    'reviewBatch',
    'scoreTemplate',
    'privateAnswerKey'
  ]) {
    assertSha256(
      manifest.files?.[key]?.sha256,
      'MANIFEST_FILE_SHA256_INVALID'
    );
  }
}

async function loadValidators() {
  validatorsPromise ??= (async () => {
    const schemaFiles = {
      input: 'blind-evaluation-input.schema.json',
      batch: 'blind-evaluation-batch.schema.json',
      score: 'blind-evaluation-score.schema.json',
      manifest: 'blind-evaluation-manifest.schema.json',
      answerKey: 'blind-evaluation-private-answer-key.schema.json',
      report: 'blind-evaluation-report.schema.json'
    };
    const entries = await Promise.all(
      Object.entries(schemaFiles).map(async ([key, filename]) => [
        key,
        JSON.parse(await readFile(resolve(schemaRoot, filename), 'utf8'))
      ])
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const schemas = Object.fromEntries(entries);
    const reportV2Schema = buildReportV2Schema(schemas.report);
    return {
      validateInput: ajv.compile(schemas.input),
      validateBatch: ajv.compile(schemas.batch),
      validateScore: ajv.compile(schemas.score),
      validateManifest: ajv.compile(schemas.manifest),
      validateAnswerKey: ajv.compile(schemas.answerKey),
      validateReport: ajv.compile(schemas.report),
      validateReportV2: ajv.compile(reportV2Schema)
    };
  })();
  return validatorsPromise;
}

function buildReportV2Schema(reportV1Schema) {
  const schema = structuredClone(reportV1Schema);
  schema.$id =
    'https://desktop-translate.invalid/schemas/phase7-blind-eval-report-v2.json';
  schema.title = 'Phase 7 cross-bound human blind evaluation report';
  schema.properties.schemaVersion.const = REPORT_V2_SCHEMA_VERSION;
  schema.required.push('candidateGenerationBindings');
  schema.properties.candidateGenerationBindings = {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: { $ref: '#/$defs/candidateBinding' }
  };
  schema.properties.audit.required.push(
    'candidateGenerationBindingSetSha256',
    'candidateOutputItemIdentitySetSha256ByDirection'
  );
  schema.properties.audit.properties
    .candidateGenerationBindingSetSha256 = { $ref: '#/$defs/sha256' };
  schema.properties.audit.properties
    .candidateOutputItemIdentitySetSha256ByDirection = {
      type: 'object',
      additionalProperties: false,
      required: REQUIRED_DIRECTIONS,
      properties: Object.fromEntries(
        REQUIRED_DIRECTIONS.map((direction) => [
          direction,
          { $ref: '#/$defs/sha256' }
        ])
      )
    };
  schema.$defs.rawScore.required.push('generationIdentitySha256');
  schema.$defs.rawScore.properties.generationIdentitySha256 = {
    $ref: '#/$defs/sha256'
  };
  schema.$defs.candidateReport.required.push(
    'generationIdentitySha256'
  );
  schema.$defs.candidateReport.properties.generationIdentitySha256 = {
    $ref: '#/$defs/sha256'
  };
  schema.$defs.candidateBinding = {
    type: 'object',
    additionalProperties: false,
    required: [
      'direction',
      'candidateId',
      'generationRunId',
      'generationArtifactSha256',
      'generationIdentitySha256',
      'sourceSetIdentitySha256',
      'sourceSetRecordCount',
      'candidateOutputArtifactSha256',
      'candidateOutputItemIdentitySetSha256'
    ],
    properties: {
      direction: {
        enum: REQUIRED_DIRECTIONS
      },
      candidateId: {
        $ref: '#/$defs/slug'
      },
      generationRunId: {
        $ref: '#/$defs/slug'
      },
      generationArtifactSha256: {
        $ref: '#/$defs/sha256'
      },
      generationIdentitySha256: {
        $ref: '#/$defs/sha256'
      },
      sourceSetIdentitySha256: {
        $ref: '#/$defs/sha256'
      },
      sourceSetRecordCount: {
        type: 'integer',
        minimum: MINIMUM_ITEMS_PER_DIRECTION
      },
      candidateOutputArtifactSha256: {
        $ref: '#/$defs/sha256'
      },
      candidateOutputItemIdentitySetSha256: {
        $ref: '#/$defs/sha256'
      }
    }
  };
  return schema;
}

async function prepareCommand(options) {
  const runId = `run-${randomBytes(8).toString('hex')}`;
  const inputOption = requiredOption(options, 'input');
  assertRunId(runId);
  const inputPath = await resolveSafeInputPath(inputOption);
  const inputContent = await readFile(inputPath, 'utf8').catch(() => {
    throw new BlindEvalError('INPUT_READ_FAILED');
  });
  const records = parseJsonLines(inputContent, 'input');
  const artifacts = await buildEvaluationArtifacts(records, {
    runId,
    inputSha256: sha256(inputContent)
  });
  await writePreparedArtifacts(runId, artifacts);
  return artifacts.preparationReport;
}

async function summarizeCommand(options) {
  const runId = requiredOption(options, 'run-id');
  const reportId = `report-${randomBytes(8).toString('hex')}`;
  assertRunId(runId);
  assertReportId(reportId);
  const runDirectory = await resolveSafeRunDirectory(runId);
  const [
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    scoresContent
  ] = await Promise.all([
    readRunFile(runDirectory, 'manifest.json'),
    readRunFile(runDirectory, 'review-batch.jsonl'),
    readRunFile(runDirectory, 'score-template.jsonl'),
    readRunFile(runDirectory, 'private-answer-key.json'),
    readRunFile(runDirectory, 'scores.jsonl')
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new BlindEvalError('MANIFEST_PARSE_FAILED');
  }
  const { report, reportContent } = await summarizeHumanScores({
    manifest,
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    scoresContent,
    reportId
  });
  const outputPath = resolve(runDirectory, `report-${reportId}.json`);
  await assertDirectChildPath(runDirectory, outputPath);
  await writeFile(outputPath, reportContent, {
    encoding: 'utf8',
    flag: 'wx'
  }).catch((error) => {
    if (error?.code === 'EEXIST') {
      throw new BlindEvalError('REPORT_ALREADY_EXISTS');
    }
    throw new BlindEvalError('REPORT_WRITE_FAILED');
  });
  return {
    status: report.status,
    reportId,
    runId,
    blindEvaluationComponentComplete:
      report.gateA.blindEvaluationComponentComplete,
    validHumanReviewCount: report.counts.validHumanReviewCount,
    pendingHumanReviewCount: report.counts.pendingHumanReviewCount,
    reportSha256: sha256(reportContent),
    logicalName: basename(outputPath),
    gateAInputStatus: report.gateA.inputStatus,
    overallGateAStatus: report.gateA.overallGateAStatus
  };
}

async function summarizeV2Command(options) {
  const runId = requiredOption(options, 'run-id');
  const authorizationPath = await resolveSafeEvidencePath(
    requiredOption(options, 'authorization')
  );
  const generationPaths = {
    'en-zh': await resolveSafeEvidencePath(
      requiredOption(options, 'generation-en-zh')
    ),
    'zh-en': await resolveSafeEvidencePath(
      requiredOption(options, 'generation-zh-en')
    )
  };
  const candidateBindingReport = await deriveGateACandidateBindings({
    authorizationPath,
    generationPaths
  });
  const reportId = `report-${randomBytes(8).toString('hex')}`;
  assertRunId(runId);
  assertReportId(reportId);
  const runDirectory = await resolveSafeRunDirectory(runId);
  const [
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    scoresContent
  ] = await Promise.all([
    readRunFile(runDirectory, 'manifest.json'),
    readRunFile(runDirectory, 'review-batch.jsonl'),
    readRunFile(runDirectory, 'score-template.jsonl'),
    readRunFile(runDirectory, 'private-answer-key.json'),
    readRunFile(runDirectory, 'scores.jsonl')
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new BlindEvalError('MANIFEST_PARSE_FAILED');
  }
  const { report, reportContent } = await summarizeHumanScoresV2({
    manifest,
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    scoresContent,
    reportId,
    candidateBindingReport
  });
  const outputPath = resolve(runDirectory, `report-${reportId}-v2.json`);
  await assertDirectChildPath(runDirectory, outputPath);
  await writeFile(outputPath, reportContent, {
    encoding: 'utf8',
    flag: 'wx'
  }).catch((error) => {
    if (error?.code === 'EEXIST') {
      throw new BlindEvalError('REPORT_ALREADY_EXISTS');
    }
    throw new BlindEvalError('REPORT_WRITE_FAILED');
  });
  return {
    status: report.status,
    schemaVersion: report.schemaVersion,
    reportId,
    runId,
    blindEvaluationComponentComplete:
      report.gateA.blindEvaluationComponentComplete,
    validHumanReviewCount: report.counts.validHumanReviewCount,
    pendingHumanReviewCount: report.counts.pendingHumanReviewCount,
    candidateGenerationBindingSetSha256:
      report.audit.candidateGenerationBindingSetSha256,
    reportSha256: sha256(reportContent),
    logicalName: basename(outputPath),
    gateAInputStatus: report.gateA.inputStatus,
    overallGateAStatus: report.gateA.overallGateAStatus
  };
}

export async function inspectHumanReviewStatus({
  manifest,
  batchContent,
  scoreTemplateContent,
  scoresContent = null,
  lockPresent = false
}) {
  assertManifestShape(manifest);
  assertContentHash(
    batchContent,
    manifest.files.reviewBatch.sha256,
    'REVIEW_BATCH_HASH_MISMATCH'
  );
  assertContentHash(
    scoreTemplateContent,
    manifest.files.scoreTemplate.sha256,
    'SCORE_TEMPLATE_HASH_MISMATCH'
  );
  const batchRecords = parseJsonLines(batchContent, 'review-batch');
  const templateRecords = parseJsonLines(
    scoreTemplateContent,
    'score-template'
  );
  const { validateBatch, validateScore, validateManifest } =
    await loadValidators();
  if (!validateManifest(manifest)) {
    throw new BlindEvalError('MANIFEST_SCHEMA_VALIDATION_FAILED', {
      schemaKeyword: validateManifest.errors?.[0]?.keyword ?? 'unknown'
    });
  }
  for (let index = 0; index < batchRecords.length; index += 1) {
    if (!validateBatch(batchRecords[index])) {
      throw new BlindEvalError('REVIEW_BATCH_SCHEMA_VALIDATION_FAILED', {
        lineNumber: index + 1,
        schemaKeyword: validateBatch.errors?.[0]?.keyword ?? 'unknown'
      });
    }
  }
  for (let index = 0; index < templateRecords.length; index += 1) {
    const record = templateRecords[index];
    if (
      !validateScore(record)
      || record.status !== 'PENDING_HUMAN_REVIEW'
      || record.reviewerToken !== manifest.reviewerToken
    ) {
      throw new BlindEvalError('SCORE_TEMPLATE_CONTRACT_INVALID', {
        lineNumber: index + 1
      });
    }
  }
  if (
    manifest.files.reviewBatch.recordCount !== batchRecords.length
    || manifest.files.scoreTemplate.recordCount !== templateRecords.length
  ) {
    throw new BlindEvalError('MANIFEST_RECORD_COUNT_MISMATCH');
  }
  const evaluationIds = [];
  for (const item of batchRecords) {
    for (const candidate of item.candidates) {
      evaluationIds.push(candidate.evaluationId);
    }
  }
  if (
    new Set(evaluationIds).size !== evaluationIds.length
    || evaluationIds.length !== templateRecords.length
    || templateRecords.some(
      (record, index) => record.evaluationId !== evaluationIds[index]
    )
  ) {
    throw new BlindEvalError('REVIEW_MATERIAL_TEMPLATE_MISMATCH');
  }
  const scoreRecords = scoresContent === null
    ? structuredClone(templateRecords)
    : parseJsonLines(scoresContent, 'scores');
  await validateScores({
    scoreRecords,
    expectedEvaluationIds: new Set(evaluationIds),
    reviewerToken: manifest.reviewerToken
  });
  const validHumanReviewCount = scoreRecords.filter(
    (score) => score.status === 'HUMAN_REVIEWED'
  ).length;
  const pendingHumanReviewCount =
    scoreRecords.length - validHumanReviewCount;
  return {
    schemaVersion: 'phase7-blind-eval-review-status-v1',
    status: validHumanReviewCount === 0
      ? 'HUMAN_REVIEW_NOT_STARTED'
      : pendingHumanReviewCount === 0
        ? 'HUMAN_REVIEW_COMPLETE'
        : 'HUMAN_REVIEW_IN_PROGRESS',
    runId: manifest.runId,
    evaluationCount: scoreRecords.length,
    validHumanReviewCount,
    pendingHumanReviewCount,
    scoreSnapshotPresent: scoresContent !== null,
    humanReviewLockPresent: lockPresent,
    humanOnly: true,
    privateAnswerKeyRead: false,
    candidateIdentityViewedByHarness: false,
    sourceTextEmitted: false,
    referenceTextEmitted: false,
    translationTextEmitted: false,
    integrationOrDistributionAuthorized: false,
    gateAInputStatus: 'GATE_A_INPUT_INCOMPLETE'
  };
}

async function statusCommand(options) {
  const runId = requiredOption(options, 'run-id');
  assertRunId(runId);
  const runDirectory = await resolveSafeRunDirectory(runId);
  const [manifestContent, batchContent, scoreTemplateContent] =
    await Promise.all([
      readRunFile(runDirectory, 'manifest.json'),
      readRunFile(runDirectory, 'review-batch.jsonl'),
      readRunFile(runDirectory, 'score-template.jsonl')
    ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch {
    throw new BlindEvalError('MANIFEST_PARSE_FAILED');
  }
  if (manifest.runId !== runId) {
    throw new BlindEvalError('RUN_ID_MISMATCH');
  }
  const scoresPath = resolve(runDirectory, 'scores.jsonl');
  const lockPath = resolve(runDirectory, '.human-review.lock');
  await assertDirectChildPath(runDirectory, scoresPath);
  await assertDirectChildPath(runDirectory, lockPath);
  const [scoresStat, lockStat] = await Promise.all([
    lstat(scoresPath).catch(() => null),
    lstat(lockPath).catch(() => null)
  ]);
  if (scoresStat && (!scoresStat.isFile() || scoresStat.isSymbolicLink())) {
    throw new BlindEvalError('SCORES_FILE_UNSAFE');
  }
  if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink())) {
    throw new BlindEvalError('HUMAN_REVIEW_LOCK_UNSAFE');
  }
  const scoresContent = scoresStat
    ? await readFile(scoresPath, 'utf8').catch(() => {
      throw new BlindEvalError('SCORES_FILE_READ_FAILED');
    })
    : null;
  return inspectHumanReviewStatus({
    manifest,
    batchContent,
    scoreTemplateContent,
    scoresContent,
    lockPresent: Boolean(lockStat)
  });
}

async function resolveSafeEvidencePath(inputOption) {
  if (extname(inputOption).toLowerCase() !== '.json') {
    throw new BlindEvalError('EVIDENCE_EXTENSION_INVALID');
  }
  const candidatePath = resolve(repositoryRoot, inputOption);
  const candidateStat = await lstat(candidatePath).catch(() => null);
  if (!candidateStat?.isFile() || candidateStat.isSymbolicLink()) {
    throw new BlindEvalError('EVIDENCE_FILE_MISSING_OR_UNSAFE');
  }
  const rootRealPath = await realpath(artifactRoot);
  const candidateRealPath = await realpath(candidatePath);
  if (!isWithin(rootRealPath, candidateRealPath)) {
    throw new BlindEvalError('EVIDENCE_FILE_OUTSIDE_ARTIFACT_ROOT');
  }
  await assertNoLinkSegments(rootRealPath, candidateRealPath);
  return candidateRealPath;
}

async function reviewCommand(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new BlindEvalError('HUMAN_REVIEW_REQUIRES_INTERACTIVE_TTY');
  }
  const runId = requiredOption(options, 'run-id');
  assertRunId(runId);
  const runDirectory = await resolveSafeRunDirectory(runId);
  const lockPath = resolve(runDirectory, '.human-review.lock');
  await assertDirectChildPath(runDirectory, lockPath);
  await writeFile(lockPath, '', { encoding: 'utf8', flag: 'wx' }).catch(
    (error) => {
      if (error?.code === 'EEXIST') {
        throw new BlindEvalError('HUMAN_REVIEW_ALREADY_ACTIVE');
      }
      throw new BlindEvalError('HUMAN_REVIEW_LOCK_FAILED');
    }
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const [manifestContent, batchContent, scoreTemplateContent] =
      await Promise.all([
        readRunFile(runDirectory, 'manifest.json'),
        readRunFile(runDirectory, 'review-batch.jsonl'),
        readRunFile(runDirectory, 'score-template.jsonl')
      ]);
    let manifest;
    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      throw new BlindEvalError('MANIFEST_PARSE_FAILED');
    }
    assertManifestShape(manifest);
    assertContentHash(
      batchContent,
      manifest.files.reviewBatch.sha256,
      'REVIEW_BATCH_HASH_MISMATCH'
    );
    assertContentHash(
      scoreTemplateContent,
      manifest.files.scoreTemplate.sha256,
      'SCORE_TEMPLATE_HASH_MISMATCH'
    );
    const batchRecords = parseJsonLines(batchContent, 'review-batch');
    const templateRecords = parseJsonLines(
      scoreTemplateContent,
      'score-template'
    );
    const { validateBatch, validateScore } = await loadValidators();
    for (const record of batchRecords) {
      if (!validateBatch(record)) {
        throw new BlindEvalError('REVIEW_BATCH_SCHEMA_VALIDATION_FAILED');
      }
    }
    for (const record of templateRecords) {
      if (
        !validateScore(record)
        || record.status !== 'PENDING_HUMAN_REVIEW'
        || record.reviewerToken !== manifest.reviewerToken
      ) {
        throw new BlindEvalError('SCORE_TEMPLATE_CONTRACT_INVALID');
      }
    }
    const reviewMaterialByEvaluationId = new Map();
    for (const item of batchRecords) {
      for (const candidate of item.candidates) {
        if (reviewMaterialByEvaluationId.has(candidate.evaluationId)) {
          throw new BlindEvalError('DUPLICATE_EVALUATION_ID_REJECTED');
        }
        reviewMaterialByEvaluationId.set(candidate.evaluationId, {
          direction: item.direction,
          source: item.source,
          reference: item.reference,
          tags: item.tags,
          candidateAlias: candidate.candidateAlias,
          translation: candidate.translation
        });
      }
    }
    if (
      reviewMaterialByEvaluationId.size !== templateRecords.length
      || templateRecords.some(
        (record) => !reviewMaterialByEvaluationId.has(record.evaluationId)
      )
    ) {
      throw new BlindEvalError('REVIEW_MATERIAL_TEMPLATE_MISMATCH');
    }

    const scoresPath = resolve(runDirectory, 'scores.jsonl');
    await assertDirectChildPath(runDirectory, scoresPath);
    const scoresStat = await lstat(scoresPath).catch(() => null);
    let scores;
    if (scoresStat) {
      if (!scoresStat.isFile() || scoresStat.isSymbolicLink()) {
        throw new BlindEvalError('SCORES_FILE_UNSAFE');
      }
      scores = parseJsonLines(
        await readFile(scoresPath, 'utf8'),
        'scores'
      );
    } else {
      scores = structuredClone(templateRecords);
      await writeFile(scoresPath, toJsonLines(scores), {
        encoding: 'utf8',
        flag: 'wx'
      });
    }
    await validateScores({
      scoreRecords: scores,
      expectedEvaluationIds: new Set(
        templateRecords.map((record) => record.evaluationId)
      ),
      reviewerToken: manifest.reviewerToken
    });

    process.stdout.write(
      '\n候选身份已随机隐藏。不要打开 private-answer-key.json。\n'
      + '本步骤只接受人工判断，不允许自动评分或模型辅助。\n'
    );
    const attestation = await terminal.question(
      '如确认遵守以上要求，请输入 HUMAN-BLIND；输入其他内容将退出：'
    );
    if (attestation.trim() !== 'HUMAN-BLIND') {
      throw new BlindEvalError('HUMAN_REVIEW_ATTESTATION_DECLINED');
    }

    let newlyReviewed = 0;
    for (let index = 0; index < scores.length; index += 1) {
      const score = scores[index];
      if (score.status === 'HUMAN_REVIEWED') {
        continue;
      }
      const material = reviewMaterialByEvaluationId.get(score.evaluationId);
      process.stdout.write(
        `\n[${index + 1}/${scores.length}] ${material.direction}`
        + ` 候选 ${material.candidateAlias}\n`
        + `标签：${material.tags.join(', ')}\n`
        + `原文：${material.source}\n`
        + `参考：${material.reference}\n`
        + `候选译文：${material.translation}\n`
      );
      const action = await askChoice(
        terminal,
        '是否可接受？[y=可接受/n=不可接受/q=保存并退出]：',
        new Set(['y', 'n', 'q'])
      );
      if (action === 'q') {
        break;
      }
      const adequacyScore = await askInteger(
        terminal,
        '忠实度 1-5：',
        1,
        5
      );
      const fluencyScore = await askInteger(
        terminal,
        '流畅度 1-5：',
        1,
        5
      );
      let errors = Object.fromEntries(
        scoreErrorKeys.map((key) => [key, false])
      );
      if (action === 'n') {
        do {
          errors = {
            severeMistranslation: await askBoolean(
              terminal,
              '存在严重错译？[y/n]：'
            ),
            untranslated: await askBoolean(
              terminal,
              '存在未译内容？[y/n]：'
            ),
            garbled: await askBoolean(
              terminal,
              '存在乱码或不可读输出？[y/n]：'
            ),
            properNounError: await askBoolean(
              terminal,
              '存在专名错误？[y/n]：'
            ),
            longSentenceError: await askBoolean(
              terminal,
              '存在长句处理错误？[y/n]：'
            )
          };
          if (!scoreErrorKeys.some((key) => errors[key])) {
            process.stdout.write(
              '不可接受的项目必须至少标记一个错误类别，请重新标记。\n'
            );
          }
        } while (!scoreErrorKeys.some((key) => errors[key]));
      }
      scores[index] = {
        schemaVersion: SCORE_SCHEMA_VERSION,
        status: 'HUMAN_REVIEWED',
        evaluationId: score.evaluationId,
        reviewerToken: score.reviewerToken,
        reviewMode: 'HUMAN_ONLY_NO_AUTOMATED_SCORING',
        blindnessAttestation: 'CANDIDATE_IDENTITY_NOT_VIEWED',
        humanReviewAttestation:
          'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING',
        reviewedAt: new Date().toISOString(),
        acceptability: action === 'y' ? 'ACCEPTABLE' : 'UNACCEPTABLE',
        adequacyScore,
        fluencyScore,
        errors
      };
      await writeScoresSnapshot(runDirectory, scoresPath, scores);
      newlyReviewed += 1;
    }
    const validHumanReviewCount = scores.filter(
      (score) => score.status === 'HUMAN_REVIEWED'
    ).length;
    return {
      status: validHumanReviewCount === scores.length
        ? 'HUMAN_REVIEW_RECORDING_COMPLETE'
        : 'HUMAN_REVIEW_RECORDING_INCOMPLETE',
      runId,
      newlyReviewed,
      validHumanReviewCount,
      pendingHumanReviewCount: scores.length - validHumanReviewCount,
      humanOnly: true,
      candidateIdentityViewedByHarness: false,
      gateAInputStatus: 'GATE_A_INPUT_INCOMPLETE'
    };
  } finally {
    terminal.close();
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function askChoice(terminal, prompt, allowed) {
  while (true) {
    const answer = (await terminal.question(prompt)).trim().toLowerCase();
    if (allowed.has(answer)) {
      return answer;
    }
    process.stdout.write('输入无效，请重试。\n');
  }
}

async function askInteger(terminal, prompt, minimum, maximum) {
  while (true) {
    const value = Number.parseInt((await terminal.question(prompt)).trim(), 10);
    if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) {
      return value;
    }
    process.stdout.write(`请输入 ${minimum}-${maximum} 的整数。\n`);
  }
}

async function askBoolean(terminal, prompt) {
  return (await askChoice(terminal, prompt, new Set(['y', 'n']))) === 'y';
}

async function writeScoresSnapshot(runDirectory, scoresPath, scores) {
  const temporaryPath = resolve(
    runDirectory,
    `.scores-${randomBytes(8).toString('hex')}.tmp`
  );
  await assertDirectChildPath(runDirectory, temporaryPath);
  try {
    await writeFile(temporaryPath, toJsonLines(scores), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await rename(temporaryPath, scoresPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new BlindEvalError('SCORES_SNAPSHOT_WRITE_FAILED');
  }
}

async function writePreparedArtifacts(runId, artifacts) {
  await ensureSafeOutputRoot();
  const runDirectory = resolve(blindEvalArtifactRoot, runId);
  await assertDirectChildPath(blindEvalArtifactRoot, runDirectory);
  try {
    await mkdir(runDirectory, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new BlindEvalError('RUN_ALREADY_EXISTS');
    }
    throw new BlindEvalError('RUN_DIRECTORY_CREATE_FAILED');
  }
  try {
    await Promise.all([
      writeFile(
        resolve(runDirectory, 'manifest.json'),
        artifacts.manifestContent,
        { encoding: 'utf8', flag: 'wx' }
      ),
      writeFile(
        resolve(runDirectory, 'review-batch.jsonl'),
        artifacts.batchContent,
        { encoding: 'utf8', flag: 'wx' }
      ),
      writeFile(
        resolve(runDirectory, 'score-template.jsonl'),
        artifacts.scoreTemplateContent,
        { encoding: 'utf8', flag: 'wx' }
      ),
      writeFile(
        resolve(runDirectory, 'private-answer-key.json'),
        artifacts.answerKeyContent,
        { encoding: 'utf8', flag: 'wx' }
      )
    ]);
  } catch {
    throw new BlindEvalError('PREPARED_ARTIFACT_WRITE_FAILED');
  }
}

async function resolveSafeInputPath(inputOption) {
  if (extname(inputOption).toLowerCase() !== '.jsonl') {
    throw new BlindEvalError('INPUT_EXTENSION_INVALID');
  }
  const candidatePath = resolve(repositoryRoot, inputOption);
  let candidateRealPath;
  try {
    candidateRealPath = await realpath(candidatePath);
  } catch {
    throw new BlindEvalError('INPUT_NOT_FOUND');
  }
  const candidateStat = await lstat(candidatePath).catch(() => null);
  if (!candidateStat?.isFile() || candidateStat.isSymbolicLink()) {
    throw new BlindEvalError('INPUT_MUST_BE_REGULAR_NON_LINK_FILE');
  }
  let allowed = false;
  for (const root of allowedInputRoots) {
    const lexicalRoot = resolve(root);
    let rootRealPath;
    try {
      await assertExistingSegmentsNoLinks(repositoryRoot, lexicalRoot);
      rootRealPath = await realpath(lexicalRoot);
    } catch {
      continue;
    }
    if (
      isWithin(lexicalRoot, candidatePath)
      && isWithin(rootRealPath, candidateRealPath)
    ) {
      await assertNoLinkSegments(lexicalRoot, candidatePath);
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    throw new BlindEvalError('INPUT_OUTSIDE_ALLOWED_DATASET_ROOTS');
  }
  return candidateRealPath;
}

async function ensureSafeOutputRoot() {
  await assertExistingSegmentsNoLinks(repositoryRoot, blindEvalArtifactRoot);
  await mkdir(blindEvalArtifactRoot, { recursive: true });
  await assertExistingSegmentsNoLinks(repositoryRoot, blindEvalArtifactRoot);
  const repositoryRealPath = await realpath(repositoryRoot);
  const outputRealPath = await realpath(blindEvalArtifactRoot);
  if (!isWithin(repositoryRealPath, outputRealPath)) {
    throw new BlindEvalError('OUTPUT_ROOT_ESCAPED_REPOSITORY');
  }
  await assertNoLinkSegments(repositoryRealPath, outputRealPath);
}

async function resolveSafeRunDirectory(runId) {
  await ensureSafeOutputRoot();
  const runDirectory = resolve(blindEvalArtifactRoot, runId);
  await assertDirectChildPath(blindEvalArtifactRoot, runDirectory);
  const stat = await lstat(runDirectory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new BlindEvalError('RUN_DIRECTORY_NOT_FOUND_OR_UNSAFE');
  }
  const rootRealPath = await realpath(blindEvalArtifactRoot);
  const runRealPath = await realpath(runDirectory);
  if (!isWithin(rootRealPath, runRealPath)) {
    throw new BlindEvalError('RUN_DIRECTORY_ESCAPED_OUTPUT_ROOT');
  }
  await assertNoLinkSegments(rootRealPath, runRealPath);
  return runRealPath;
}

async function readRunFile(runDirectory, filename) {
  const filePath = resolve(runDirectory, filename);
  await assertDirectChildPath(runDirectory, filePath);
  const stat = await lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new BlindEvalError('REQUIRED_RUN_FILE_MISSING_OR_UNSAFE', {
      logicalName: filename
    });
  }
  return readFile(filePath, 'utf8').catch(() => {
    throw new BlindEvalError('REQUIRED_RUN_FILE_READ_FAILED', {
      logicalName: filename
    });
  });
}

async function assertNoLinkSegments(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  if (rel.startsWith('..') || resolve(rootPath, rel) !== resolve(targetPath)) {
    throw new BlindEvalError('PATH_ESCAPED_ALLOWED_ROOT');
  }
  let current = rootPath;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new BlindEvalError('PATH_LINK_SEGMENT_REJECTED');
    }
  }
}

async function assertExistingSegmentsNoLinks(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  if (
    rel.startsWith('..')
    || isAbsolute(rel)
    || resolve(rootPath, rel) !== resolve(targetPath)
  ) {
    throw new BlindEvalError('PATH_ESCAPED_ALLOWED_ROOT');
  }
  let current = resolve(rootPath);
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        break;
      }
      throw new BlindEvalError('PATH_SEGMENT_INSPECTION_FAILED');
    }
    if (stat.isSymbolicLink()) {
      throw new BlindEvalError('PATH_LINK_SEGMENT_REJECTED');
    }
  }
}

async function assertDirectChildPath(parent, child) {
  if (dirname(child) !== parent) {
    throw new BlindEvalError('PATH_NOT_DIRECT_CHILD');
  }
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) {
    throw new BlindEvalError('REQUIRED_OPTION_MISSING', { option: name });
  }
  return value;
}

function parseCliArguments(args) {
  const [command, ...rest] = args;
  if (
    !['prepare', 'review', 'status', 'summarize', 'summarize-v2']
      .includes(command)
  ) {
    throw new BlindEvalError('COMMAND_INVALID');
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new BlindEvalError('OPTION_SYNTAX_INVALID');
    }
    const name = flag.slice(2);
    if (options.has(name)) {
      throw new BlindEvalError('DUPLICATE_OPTION_REJECTED', { option: name });
    }
    options.set(name, value);
  }
  const allowed = command === 'prepare'
    ? new Set(['input'])
    : command === 'review' || command === 'status'
      ? new Set(['run-id'])
      : command === 'summarize'
        ? new Set(['run-id'])
        : new Set([
          'run-id',
          'authorization',
          'generation-en-zh',
          'generation-zh-en'
        ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new BlindEvalError('UNKNOWN_OPTION_REJECTED', { option: name });
    }
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseCliArguments(process.argv.slice(2));
  let result;
  if (command === 'prepare') {
    result = await prepareCommand(options);
  } else if (command === 'review') {
    result = await reviewCommand(options);
  } else if (command === 'status') {
    result = await statusCommand(options);
  } else if (command === 'summarize-v2') {
    result = await summarizeV2Command(options);
  } else {
    result = await summarizeCommand(options);
  }
  process.stdout.write(toPrettyJson(result));
}

function serializeFailure(error) {
  if (error instanceof BlindEvalError) {
    return {
      status: 'FAILED_CLOSED',
      errorCode: error.code,
      details: error.details
    };
  }
  return {
    status: 'FAILED_CLOSED',
    errorCode: 'BLIND_EVALUATION_INTERNAL_FAILURE',
    details: {}
  };
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(toPrettyJson(serializeFailure(error)));
    process.exitCode = 1;
  });
}

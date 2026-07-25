import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BlindEvalError,
  INPUT_SCHEMA_VERSION,
  MINIMUM_ITEMS_PER_DIRECTION,
  REPORT_V2_SCHEMA_VERSION,
  SCORE_SCHEMA_VERSION,
  buildEvaluationArtifacts,
  sha256,
  summarizeHumanScores,
  summarizeHumanScoresV2,
  validateInputRecords
} from './blind-eval.mjs';
import { canonicalJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const fixedSeed = '12'.repeat(32);
const fixedReviewerToken = `reviewer-${'34'.repeat(12)}`;
const fixedRunId = `run-${'56'.repeat(8)}`;
const records = buildSyntheticRecords(MINIMUM_ITEMS_PER_DIRECTION);
const inputContent = toJsonLines(records);

const validation = await validateInputRecords(records);
assert.equal(validation.itemCount, MINIMUM_ITEMS_PER_DIRECTION * 2);
assert.deepEqual(validation.itemCountByDirection, {
  'en-zh': MINIMUM_ITEMS_PER_DIRECTION,
  'zh-en': MINIMUM_ITEMS_PER_DIRECTION
});
assert.deepEqual(validation.candidateCountByDirection, {
  'en-zh': 2,
  'zh-en': 2
});
assert.deepEqual(validation.provenanceKinds, ['SELF_AUTHORED_SYNTHETIC']);

const artifacts = await buildEvaluationArtifacts(records, {
  runId: fixedRunId,
  inputSha256: sha256(inputContent),
  createdAt: '2026-07-23T00:00:00.000Z',
  seed: fixedSeed,
  reviewerToken: fixedReviewerToken
});
assert.equal(
  artifacts.preparationReport.status,
  'BLIND_EVALUATION_BATCH_PREPARED'
);
assert.equal(artifacts.preparationReport.evaluationCount, 800);
assert.equal(artifacts.preparationReport.modelExecution, 'NOT_RUN');
assert.equal(artifacts.preparationReport.networkActivity, 'NOT_PERFORMED');
assert.equal(
  artifacts.preparationReport.manifestSha256,
  sha256(artifacts.manifestContent)
);
assert.doesNotMatch(artifacts.batchContent, /candidate-alpha/u);
assert.doesNotMatch(artifacts.batchContent, /candidate-beta/u);
assert.doesNotMatch(artifacts.batchContent, /generationRunId/u);
assert.match(artifacts.answerKeyContent, /candidate-alpha/u);
assert.equal(
  artifacts.manifest.randomization.candidateIdentityPresentInReviewBatch,
  false
);
assert.equal(
  artifacts.manifest.input.acceptedProvenance,
  'PUBLIC_DATASET_OR_SELF_AUTHORED_SYNTHETIC_ONLY'
);
assert.equal(artifacts.manifest.input.userHistoryAccepted, false);
assert.equal(artifacts.manifest.input.freeFormSourceAccepted, false);

const alphaAliases = new Set();
const itemIdByEvaluationId = new Map();
for (const item of artifacts.answerKey.records) {
  alphaAliases.add(
    item.candidates.find(
      (candidate) => candidate.candidateId === 'candidate-alpha'
    ).candidateAlias
  );
  for (const candidate of item.candidates) {
    itemIdByEvaluationId.set(candidate.evaluationId, item.itemId);
  }
}
assert.deepEqual([...alphaAliases].sort(), ['A', 'B']);

const reviewedScores = artifacts.scoreTemplateRecords.map((record) => {
  const itemId = itemIdByEvaluationId.get(record.evaluationId);
  const itemNumber = Number.parseInt(itemId.slice(-3), 10);
  const acceptable = itemNumber % 10 !== 0;
  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    status: 'HUMAN_REVIEWED',
    evaluationId: record.evaluationId,
    reviewerToken: record.reviewerToken,
    reviewMode: 'HUMAN_ONLY_NO_AUTOMATED_SCORING',
    blindnessAttestation: 'CANDIDATE_IDENTITY_NOT_VIEWED',
    humanReviewAttestation:
      'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING',
    reviewedAt: '2026-07-23T01:00:00.000Z',
    acceptability: acceptable ? 'ACCEPTABLE' : 'UNACCEPTABLE',
    adequacyScore: acceptable ? 5 : 2,
    fluencyScore: acceptable ? 5 : 3,
    errors: {
      severeMistranslation: !acceptable,
      untranslated: false,
      garbled: false,
      properNounError: false,
      longSentenceError: false
    }
  };
});
const reviewedScoresContent = toJsonLines(reviewedScores);
const complete = await summarizeHumanScores({
  manifest: artifacts.manifest,
  batchContent: artifacts.batchContent,
  scoreTemplateContent: artifacts.scoreTemplateContent,
  answerKeyContent: artifacts.answerKeyContent,
  scoresContent: reviewedScoresContent,
  reportId: `report-${'61'.repeat(8)}`,
  summarizedAt: '2026-07-23T02:00:00.000Z'
});
assert.equal(
  complete.report.status,
  'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE'
);
assert.equal(complete.report.counts.assignedEvaluationCount, 800);
assert.equal(complete.report.counts.validHumanReviewCount, 800);
assert.equal(complete.report.counts.pendingHumanReviewCount, 0);
assert.equal(complete.report.rawScores.length, 800);
assert.equal(complete.report.humanOnly, true);
assert.equal(complete.report.audit.randomizedMappingVerified, true);
assert.equal(
  complete.report.audit.candidateIdentityWithheldFromReviewBatch,
  true
);
assert.equal(
  complete.report.gateA.blindEvaluationComponentComplete,
  true
);
assert.equal(complete.report.gateA.inputStatus, 'GATE_A_INPUT_INCOMPLETE');
assert.equal(
  complete.report.gateA.overallGateAStatus,
  'BLOCKED_PENDING_OTHER_M4_EVIDENCE_AND_USER_GATE_A_DECISION'
);
for (const direction of complete.report.directions) {
  assert.equal(direction.candidates.length, 2);
  for (const candidate of direction.candidates) {
    assert.equal(candidate.N, 200);
    assert.equal(candidate.validN, 200);
    assert.equal(candidate.uniqueItemN, 200);
    assert.equal(candidate.pendingN, 0);
    assert.equal(candidate.acceptance.rate, 0.9);
    assert.equal(candidate.severeErrors.severeMistranslation.count, 20);
    assert.equal(candidate.blindEvaluationEvidence.humanReviewed, true);
    assert.equal(candidate.blindEvaluationEvidence.sampleCount, 200);
    assert.equal(candidate.blindEvaluationEvidence.rawScoresRecorded, true);
    assert.equal(
      candidate.blindEvaluationEvidence.severeErrorClassificationRecorded,
      true
    );
  }
}
assert.doesNotMatch(complete.reportContent, /"source":/u);
assert.doesNotMatch(complete.reportContent, /"reference":/u);
assert.doesNotMatch(complete.reportContent, /"translation":/u);
assert.doesNotMatch(complete.reportContent, /en-zh-item-/u);
assert.doesNotMatch(complete.reportContent, /[A-Za-z]:[\\/]/u);
assert.doesNotMatch(
  complete.reportContent,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
);

const v2Records = records.map((record) => ({
  ...record,
  candidates: [{
    ...record.candidates[0],
    candidateId: `candidate-${record.direction}`,
    generationRunId: `generation-${record.direction}`
  }]
}));
const v2InputContent = toJsonLines(v2Records);
const v2Artifacts = await buildEvaluationArtifacts(v2Records, {
  runId: `run-${'71'.repeat(8)}`,
  inputSha256: sha256(v2InputContent),
  createdAt: '2026-07-23T03:00:00.000Z',
  seed: '72'.repeat(32),
  reviewerToken: `reviewer-${'73'.repeat(12)}`
});
const v2ScoresContent = toJsonLines(
  v2Artifacts.scoreTemplateRecords.map((record) => ({
    schemaVersion: SCORE_SCHEMA_VERSION,
    status: 'HUMAN_REVIEWED',
    evaluationId: record.evaluationId,
    reviewerToken: record.reviewerToken,
    reviewMode: 'HUMAN_ONLY_NO_AUTOMATED_SCORING',
    blindnessAttestation: 'CANDIDATE_IDENTITY_NOT_VIEWED',
    humanReviewAttestation:
      'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING',
    reviewedAt: '2026-07-23T04:00:00.000Z',
    acceptability: 'ACCEPTABLE',
    adequacyScore: 5,
    fluencyScore: 5,
    errors: {
      severeMistranslation: false,
      untranslated: false,
      garbled: false,
      properNounError: false,
      longSentenceError: false
    }
  }))
);
const v2Bindings = ['en-zh', 'zh-en'].map((direction, index) => {
  const itemIdentities = v2Artifacts.answerKey.records
    .filter((record) => record.direction === direction)
    .map((record) => ({
      direction: record.direction,
      itemId: record.itemId,
      sourceSha256: record.sourceSha256
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  return {
    direction,
    candidateId: `candidate-${direction}`,
    generationRunId: `generation-${direction}`,
    generationArtifactSha256:
      index === 0 ? '74'.repeat(32) : '75'.repeat(32),
    generationIdentitySha256:
      index === 0 ? '76'.repeat(32) : '77'.repeat(32),
    sourceSetIdentitySha256:
      index === 0 ? '81'.repeat(32) : '82'.repeat(32),
    sourceSetRecordCount: itemIdentities.length,
    candidateOutputArtifactSha256:
      index === 0 ? '83'.repeat(32) : '84'.repeat(32),
    candidateOutputItemIdentitySetSha256:
      sha256(canonicalJson(itemIdentities))
  };
});
const candidateBindingReport = {
  schemaVersion: 'phase7-gate-a-candidate-binding-set-v1',
  authorizationSha256: '78'.repeat(32),
  authorizationRecordId: 'blind-v2-selftest',
  manifestSha256: '79'.repeat(32),
  bindingSetSha256: sha256(canonicalJson(v2Bindings)),
  bindings: v2Bindings,
  rawTextEmitted: false,
  absolutePathsEmitted: false,
  integrationOrDistributionAuthorized: false
};
const completeV2 = await summarizeHumanScoresV2({
  manifest: v2Artifacts.manifest,
  batchContent: v2Artifacts.batchContent,
  scoreTemplateContent: v2Artifacts.scoreTemplateContent,
  answerKeyContent: v2Artifacts.answerKeyContent,
  scoresContent: v2ScoresContent,
  reportId: `report-${'80'.repeat(8)}`,
  summarizedAt: '2026-07-23T05:00:00.000Z',
  candidateBindingReport
});
assert.equal(completeV2.report.schemaVersion, REPORT_V2_SCHEMA_VERSION);
assert.equal(completeV2.report.rawScores.length, 400);
assert.equal(completeV2.report.candidateGenerationBindings.length, 2);
assert.equal(
  completeV2.report.audit.candidateGenerationBindingSetSha256,
  candidateBindingReport.bindingSetSha256
);
assert.deepEqual(
  completeV2.report.audit
    .candidateOutputItemIdentitySetSha256ByDirection,
  Object.fromEntries(v2Bindings.map((binding) => [
    binding.direction,
    binding.candidateOutputItemIdentitySetSha256
  ]))
);
assert.ok(completeV2.report.rawScores.every(
  (score) => /^[a-f0-9]{64}$/u.test(score.generationIdentitySha256)
));
assert.ok(completeV2.report.directions.every(
  (direction) => direction.candidates.length === 1
    && /^[a-f0-9]{64}$/u.test(
      direction.candidates[0].generationIdentitySha256
    )
));
assert.doesNotMatch(completeV2.reportContent, /"source":/u);
assert.doesNotMatch(completeV2.reportContent, /"translation":/u);

const mismatchedV2Bindings = structuredClone(candidateBindingReport);
mismatchedV2Bindings.bindings[0].candidateId = 'candidate-remapped';
mismatchedV2Bindings.bindingSetSha256 = sha256(
  canonicalJson(mismatchedV2Bindings.bindings)
);
await expectBlindEvalFailure(
  () => summarizeHumanScoresV2({
    manifest: v2Artifacts.manifest,
    batchContent: v2Artifacts.batchContent,
    scoreTemplateContent: v2Artifacts.scoreTemplateContent,
    answerKeyContent: v2Artifacts.answerKeyContent,
    scoresContent: v2ScoresContent,
    reportId: `report-${'81'.repeat(8)}`,
    summarizedAt: '2026-07-23T05:00:00.000Z',
    candidateBindingReport: mismatchedV2Bindings
  }),
  'V2_RAW_SCORE_CANDIDATE_GENERATION_MISMATCH'
);

const mismatchedV2ItemSet = structuredClone(candidateBindingReport);
mismatchedV2ItemSet.bindings[0].candidateOutputItemIdentitySetSha256 =
  '85'.repeat(32);
mismatchedV2ItemSet.bindingSetSha256 = sha256(
  canonicalJson(mismatchedV2ItemSet.bindings)
);
await expectBlindEvalFailure(
  () => summarizeHumanScoresV2({
    manifest: v2Artifacts.manifest,
    batchContent: v2Artifacts.batchContent,
    scoreTemplateContent: v2Artifacts.scoreTemplateContent,
    answerKeyContent: v2Artifacts.answerKeyContent,
    scoresContent: v2ScoresContent,
    reportId: `report-${'86'.repeat(8)}`,
    summarizedAt: '2026-07-23T05:30:00.000Z',
    candidateBindingReport: mismatchedV2ItemSet
  }),
  'V2_REVIEWED_ITEM_SET_CANDIDATE_OUTPUT_MISMATCH'
);

const partial = await summarizeHumanScores({
  manifest: artifacts.manifest,
  batchContent: artifacts.batchContent,
  scoreTemplateContent: artifacts.scoreTemplateContent,
  answerKeyContent: artifacts.answerKeyContent,
  scoresContent: artifacts.scoreTemplateContent,
  reportId: `report-${'62'.repeat(8)}`,
  summarizedAt: '2026-07-23T02:00:00.000Z'
});
assert.equal(
  partial.report.status,
  'HUMAN_BLIND_EVALUATION_INCOMPLETE'
);
assert.equal(partial.report.counts.validHumanReviewCount, 0);
assert.equal(partial.report.counts.pendingHumanReviewCount, 800);
assert.equal(partial.report.rawScores.length, 0);
assert.equal(
  partial.report.gateA.blindEvaluationComponentComplete,
  false
);
assert.equal(
  partial.report.gateA.overallGateAStatus,
  'BLOCKED_PENDING_HUMAN_REVIEW_AND_OTHER_M4_EVIDENCE'
);

const duplicateScores = structuredClone(reviewedScores);
duplicateScores[1] = structuredClone(duplicateScores[0]);
await expectBlindEvalFailure(
  () => summarizeHumanScores({
    manifest: artifacts.manifest,
    batchContent: artifacts.batchContent,
    scoreTemplateContent: artifacts.scoreTemplateContent,
    answerKeyContent: artifacts.answerKeyContent,
    scoresContent: toJsonLines(duplicateScores),
    reportId: `report-${'63'.repeat(8)}`,
    summarizedAt: '2026-07-23T02:00:00.000Z'
  }),
  'DUPLICATE_SCORE_REJECTED'
);

const conflictingScores = structuredClone(reviewedScores);
conflictingScores[1].errors.properNounError = true;
await expectBlindEvalFailure(
  () => summarizeHumanScores({
    manifest: artifacts.manifest,
    batchContent: artifacts.batchContent,
    scoreTemplateContent: artifacts.scoreTemplateContent,
    answerKeyContent: artifacts.answerKeyContent,
    scoresContent: toJsonLines(conflictingScores),
    reportId: `report-${'64'.repeat(8)}`,
    summarizedAt: '2026-07-23T02:00:00.000Z'
  }),
  'ACCEPTABILITY_AND_ERROR_CLASSIFICATION_CONFLICT'
);

await expectBlindEvalFailure(
  () => summarizeHumanScores({
    manifest: artifacts.manifest,
    batchContent: artifacts.batchContent.replace(
      '"source":"Synthetic',
      '"source":"Tampered synthetic'
    ),
    scoreTemplateContent: artifacts.scoreTemplateContent,
    answerKeyContent: artifacts.answerKeyContent,
    scoresContent: reviewedScoresContent,
    reportId: `report-${'65'.repeat(8)}`,
    summarizedAt: '2026-07-23T02:00:00.000Z'
  }),
  'REVIEW_BATCH_HASH_MISMATCH'
);

const remappedAnswerKey = structuredClone(artifacts.answerKey);
remappedAnswerKey.records[0].candidates[0].translationSha256 = 'ab'.repeat(32);
const remappedAnswerKeyContent =
  `${JSON.stringify(remappedAnswerKey, null, 2)}\n`;
const remappedManifest = structuredClone(artifacts.manifest);
remappedManifest.files.privateAnswerKey.sha256 = sha256(
  remappedAnswerKeyContent
);
await expectBlindEvalFailure(
  () => summarizeHumanScores({
    manifest: remappedManifest,
    batchContent: artifacts.batchContent,
    scoreTemplateContent: artifacts.scoreTemplateContent,
    answerKeyContent: remappedAnswerKeyContent,
    scoresContent: reviewedScoresContent,
    reportId: `report-${'66'.repeat(8)}`,
    summarizedAt: '2026-07-23T02:00:00.000Z'
  }),
  'REVIEW_BATCH_CANDIDATE_MAPPING_INVALID'
);

const duplicateItemRecords = structuredClone(records);
duplicateItemRecords[1].itemId = duplicateItemRecords[0].itemId;
await expectBlindEvalFailure(
  () => validateInputRecords(duplicateItemRecords),
  'DUPLICATE_ITEM_ID_REJECTED'
);

const duplicateSourceRecords = structuredClone(records);
duplicateSourceRecords[1].source = duplicateSourceRecords[0].source;
await expectBlindEvalFailure(
  () => validateInputRecords(duplicateSourceRecords),
  'DUPLICATE_SOURCE_ITEM_REJECTED'
);

const userHistoryRecords = structuredClone(records);
userHistoryRecords[0].provenance.derivedFromUserActivity = true;
await expectBlindEvalFailure(
  () => validateInputRecords(userHistoryRecords),
  'INPUT_SCHEMA_VALIDATION_FAILED'
);

const freeSourceRecords = structuredClone(records);
freeSourceRecords[0].provenance.kind = 'FREE_FORM';
await expectBlindEvalFailure(
  () => validateInputRecords(freeSourceRecords),
  'INPUT_SCHEMA_VALIDATION_FAILED'
);

const privatePathRecords = structuredClone(records);
privatePathRecords[0].source =
  'Open C:\\Users\\ExamplePerson\\private-document.txt.';
await expectBlindEvalFailure(
  () => validateInputRecords(privatePathRecords),
  'PRIVACY_TEXT_REJECTED',
  (error) => {
    assert.equal(error.details.reason, 'ABSOLUTE_WINDOWS_PATH_DETECTED');
  }
);

const emailRecords = structuredClone(records);
emailRecords[0].reference = 'Contact example.person@example.com.';
await expectBlindEvalFailure(
  () => validateInputRecords(emailRecords),
  'PRIVACY_TEXT_REJECTED',
  (error) => {
    assert.equal(error.details.reason, 'EMAIL_ADDRESS_DETECTED');
  }
);

await expectBlindEvalFailure(
  () => validateInputRecords(records.slice(0, 10)),
  'MINIMUM_ITEMS_PER_DIRECTION_NOT_MET'
);

for (const schema of [
  'blind-evaluation-input.schema.json',
  'blind-evaluation-batch.schema.json',
  'blind-evaluation-score.schema.json',
  'blind-evaluation-manifest.schema.json',
  'blind-evaluation-private-answer-key.schema.json',
  'blind-evaluation-report.schema.json'
]) {
  const value = JSON.parse(
    await readFile(resolve(scriptRoot, 'schemas', schema), 'utf8')
  );
  assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
}

const nonInteractiveReview = await expectProcessFailure([
  resolve(scriptRoot, 'blind-eval.mjs'),
  'review',
  '--run-id',
  'selftest-no-tty'
]);
assert.equal(
  JSON.parse(nonInteractiveReview.stderr).errorCode,
  'HUMAN_REVIEW_REQUIRES_INTERACTIVE_TTY'
);
assert.doesNotMatch(nonInteractiveReview.stderr, /[A-Za-z]:[\\/]/u);
assert.doesNotMatch(nonInteractiveReview.stderr, /BlindEvalError/u);

process.stdout.write(`${JSON.stringify({
  status: 'BLIND_EVALUATION_STATIC_SELF_TEST_PASS',
  inputSchemaVersion: INPUT_SCHEMA_VERSION,
  minimumUniqueItemsPerCandidateDirection: MINIMUM_ITEMS_PER_DIRECTION,
  candidateAnonymousRandomization: 'VERIFIED_WITH_FIXED_SELF_TEST_SEED',
  duplicateCounting: 'REJECTED',
  privacyFailClosed: true,
  humanReviewExecuted: false,
  modelExecution: 'NOT_RUN',
  networkActivity: 'NOT_PERFORMED',
  gateAInputStatus: 'GATE_A_INPUT_INCOMPLETE'
}, null, 2)}\n`);

function buildSyntheticRecords(itemsPerDirection) {
  return ['en-zh', 'zh-en'].flatMap((direction) =>
    Array.from({ length: itemsPerDirection }, (_, index) => {
      const itemNumber = index.toString().padStart(3, '0');
      const tags = index === 0
        ? ['proper-noun']
        : index === 1
          ? ['long-sentence']
          : ['basic'];
      const source = direction === 'en-zh'
        ? `Synthetic source sentence ${itemNumber} for offline evaluation.`
        : `用于离线评测的合成源句 ${itemNumber}。`;
      const reference = direction === 'en-zh'
        ? `用于离线评测的合成参考译文 ${itemNumber}。`
        : `Synthetic reference sentence ${itemNumber} for offline evaluation.`;
      return {
        schemaVersion: INPUT_SCHEMA_VERSION,
        itemId: `${direction}-item-${itemNumber}`,
        direction,
        source,
        reference,
        tags,
        provenance: {
          kind: 'SELF_AUTHORED_SYNTHETIC',
          datasetId: 'phase7-selftest-synthetic',
          snapshotId: 'selftest-snapshot-v1',
          licenseExpression: 'SELF-AUTHORED-FOR-PHASE7-RESEARCH',
          sourceLocator: 'SELF_AUTHORED_SYNTHETIC',
          contentDeclaration:
            'NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS',
          derivedFromUserActivity: false,
          containsPersonalData: false,
          usageAuthorization: 'AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION'
        },
        candidates: [
          {
            candidateId: 'candidate-alpha',
            generationRunId: `${direction}-alpha-generation-v1`,
            translation: direction === 'en-zh'
              ? `候选甲合成译文 ${itemNumber}。`
              : `Candidate alpha synthetic translation ${itemNumber}.`
          },
          {
            candidateId: 'candidate-beta',
            generationRunId: `${direction}-beta-generation-v1`,
            translation: direction === 'en-zh'
              ? `候选乙合成译文 ${itemNumber}。`
              : `Candidate beta synthetic translation ${itemNumber}.`
          }
        ]
      };
    })
  );
}

function toJsonLines(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function expectBlindEvalFailure(action, expectedCode, inspect) {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof BlindEvalError);
    assert.equal(error.code, expectedCode);
    inspect?.(error);
    return;
  }
  assert.fail(`Expected ${expectedCode}.`);
}

async function expectProcessFailure(args) {
  try {
    await execFileAsync(process.execPath, args, {
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
  assert.fail('Expected process failure.');
}

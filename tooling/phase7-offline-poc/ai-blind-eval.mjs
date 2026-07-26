import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import {
  basename,
  resolve
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  BlindEvalError,
  SCORE_SCHEMA_VERSION,
  parseJsonLines,
  sha256,
  summarizeHumanScoresV2
} from './blind-eval.mjs';
import {
  deriveGateACandidateBindings
} from './gate-a-candidate-bindings.mjs';

export const AI_DECISIONS_SCHEMA_VERSION =
  'phase7-ai-blind-eval-decisions-v1';
export const AI_SCORE_SCHEMA_VERSION =
  'phase7-ai-blind-eval-score-v1';
export const AI_REPORT_SCHEMA_VERSION =
  'phase7-ai-blind-eval-report-v1';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const blindRoot = resolve(
  repositoryRoot,
  'artifacts',
  'phase7',
  'offline-poc',
  'blind-eval'
);
const directions = Object.freeze(['en-zh', 'zh-en']);
const errorKeys = Object.freeze([
  'severeMistranslation',
  'untranslated',
  'garbled',
  'properNounError',
  'longSentenceError'
]);
const emptyErrors = Object.freeze(Object.fromEntries(
  errorKeys.map((key) => [key, false])
));

function assert(condition, code, details = {}) {
  if (!condition) {
    throw new BlindEvalError(code, details);
  }
}

function validScoreDecision(decision) {
  return decision?.acceptability === 'ACCEPTABLE'
    || (
      decision?.acceptability === 'UNACCEPTABLE'
      && errorKeys.some((key) => decision?.errors?.[key] === true)
    );
}

function normalizeDecision(decision, fallback) {
  const value = { ...fallback, ...decision };
  value.errors = {
    ...emptyErrors,
    ...fallback?.errors,
    ...decision?.errors
  };
  assert(validScoreDecision(value), 'AI_DECISION_ACCEPTABILITY_INVALID');
  assert(
    Number.isInteger(value.adequacyScore)
      && value.adequacyScore >= 1
      && value.adequacyScore <= 5
      && Number.isInteger(value.fluencyScore)
      && value.fluencyScore >= 1
      && value.fluencyScore <= 5
      && errorKeys.every((key) => typeof value.errors[key] === 'boolean'),
    'AI_DECISION_SCORE_INVALID'
  );
  if (value.acceptability === 'ACCEPTABLE') {
    assert(
      errorKeys.every((key) => value.errors[key] === false),
      'AI_DECISION_ACCEPTABLE_WITH_ERROR'
    );
  }
  return value;
}

function validateDecisions(document, manifest, batchContent, batchRecords) {
  assert(
    document?.schemaVersion === AI_DECISIONS_SCHEMA_VERSION,
    'AI_DECISIONS_SCHEMA_UNSUPPORTED'
  );
  assert(
    document?.status === 'AI_MODEL_ASSESSMENT_COMPLETE'
      && document?.runId === manifest.runId
      && document?.reviewBatchSha256 === sha256(batchContent)
      && document?.rubricVersion
        === 'phase7-ai-translation-quality-rubric-v1'
      && document?.allEvaluationItemsIndividuallyAssessed === true,
    'AI_DECISIONS_BINDING_OR_ATTESTATION_INVALID'
  );
  assert(
    document?.assessor?.assessorType === 'AI_LANGUAGE_MODEL'
      && document?.assessor?.candidateIdentityViewed === false
      && document?.assessor?.referenceTranslationViewed === true
      && typeof document?.assessor?.modelIdentifier === 'string'
      && document.assessor.modelIdentifier.length > 0
      && typeof document?.assessorToken === 'string'
      && /^ai-assessor-[a-z0-9-]{8,80}$/u.test(document.assessorToken)
      && !Number.isNaN(Date.parse(document?.assessedAt)),
    'AI_ASSESSOR_METADATA_INVALID'
  );
  const evaluationIds = new Set(batchRecords.flatMap(
    (record) => record.candidates.map((candidate) => candidate.evaluationId)
  ));
  const overrides = Array.isArray(document.overrides)
    ? document.overrides
    : [];
  assert(
    overrides.length === new Set(
      overrides.map((entry) => entry.evaluationId)
    ).size
      && overrides.every((entry) => evaluationIds.has(entry.evaluationId)),
    'AI_DECISION_OVERRIDE_SET_INVALID'
  );
  normalizeDecision(document.defaultDecision, {});
  normalizeDecision(document.exactReferenceDecision, {});
  for (const override of overrides) {
    normalizeDecision(override, document.defaultDecision);
  }
}

export async function summarizeAiScores({
  manifest,
  manifestContent,
  batchContent,
  scoreTemplateContent,
  answerKeyContent,
  decisions,
  decisionsContent,
  candidateBindingReport,
  reportId,
  summarizedAt = new Date().toISOString()
}) {
  const batchRecords = parseJsonLines(batchContent, 'review-batch');
  const templates = parseJsonLines(scoreTemplateContent, 'score-template');
  validateDecisions(decisions, manifest, batchContent, batchRecords);
  let parsedDecisionsContent;
  try {
    parsedDecisionsContent = JSON.parse(decisionsContent);
  } catch {
    throw new BlindEvalError('AI_DECISIONS_CONTENT_INVALID');
  }
  assert(
    JSON.stringify(parsedDecisionsContent) === JSON.stringify(decisions),
    'AI_DECISIONS_CONTENT_OBJECT_MISMATCH'
  );
  const batchByEvaluationId = new Map();
  for (const item of batchRecords) {
    for (const candidate of item.candidates) {
      batchByEvaluationId.set(candidate.evaluationId, {
        reference: item.reference,
        translation: candidate.translation
      });
    }
  }
  const overrideById = new Map(
    decisions.overrides.map((entry) => [entry.evaluationId, entry])
  );
  const aiScores = templates.map((template) => {
    const reviewed = batchByEvaluationId.get(template.evaluationId);
    assert(reviewed, 'AI_REVIEW_BATCH_MAPPING_MISSING');
    const exact = reviewed.translation.trim() === reviewed.reference.trim();
    const base = exact
      ? decisions.exactReferenceDecision
      : decisions.defaultDecision;
    const decision = normalizeDecision(
      overrideById.get(template.evaluationId),
      base
    );
    return {
      schemaVersion: AI_SCORE_SCHEMA_VERSION,
      status: 'AI_REVIEWED',
      evaluationId: template.evaluationId,
      assessorToken: decisions.assessorToken,
      reviewMode: 'AI_MODEL_BLIND_REVIEW',
      blindnessAttestation: 'CANDIDATE_IDENTITY_NOT_VIEWED',
      aiReviewAttestation:
        'AI_MODEL_ASSESSED_SOURCE_REFERENCE_AND_CANDIDATE_OUTPUT',
      reviewedAt: decisions.assessedAt,
      acceptability: decision.acceptability,
      adequacyScore: decision.adequacyScore,
      fluencyScore: decision.fluencyScore,
      errors: decision.errors
    };
  });

  // This adapter exists only in memory to reuse the established randomized
  // mapping, private-answer-key and candidate-generation binding audit. It is
  // never emitted and is not human-review evidence.
  const structuralAdapterScores = aiScores.map((score) => ({
    schemaVersion: SCORE_SCHEMA_VERSION,
    status: 'HUMAN_REVIEWED',
    evaluationId: score.evaluationId,
    reviewerToken: manifest.reviewerToken,
    reviewMode: 'HUMAN_ONLY_NO_AUTOMATED_SCORING',
    blindnessAttestation: score.blindnessAttestation,
    humanReviewAttestation:
      'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING',
    reviewedAt: score.reviewedAt,
    acceptability: score.acceptability,
    adequacyScore: score.adequacyScore,
    fluencyScore: score.fluencyScore,
    errors: score.errors
  }));
  const structural = await summarizeHumanScoresV2({
    manifest,
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    scoresContent: `${structuralAdapterScores.map(
      (score) => JSON.stringify(score)
    ).join('\n')}\n`,
    reportId,
    summarizedAt,
    candidateBindingReport
  });
  const aiById = new Map(aiScores.map((score) => [
    score.evaluationId,
    score
  ]));
  const report = structuredClone(structural.report);
  report.schemaVersion = AI_REPORT_SCHEMA_VERSION;
  report.status = 'AI_BLIND_QUALITY_EVALUATION_COMPONENT_COMPLETE';
  delete report.humanOnly;
  report.aiOnly = true;
  report.assessmentMode = 'AI_MODEL_BLIND_REVIEW';
  report.assessor = structuredClone(decisions.assessor);
  report.rubricVersion = decisions.rubricVersion;
  report.method = {
    itemLevelAssessment: true,
    deterministicExactReferenceUpgrade: true,
    compactDecisionArtifactExpandedToItemScores: true,
    humanReviewClaimed: false
  };
  report.counts = {
    assignedEvaluationCount: aiScores.length,
    submittedRecordCount: aiScores.length,
    validAiReviewCount: aiScores.length,
    pendingAiReviewCount: 0
  };
  report.rawScores = report.rawScores.map((joined) => ({
    ...joined,
    ...aiById.get(joined.evaluationId),
    reviewerToken: undefined,
    humanReviewAttestation: undefined
  }));
  report.rawScores = report.rawScores.map((score) => Object.fromEntries(
    Object.entries(score).filter(([, value]) => value !== undefined)
  ));
  report.directions = report.directions.map((direction) => ({
    ...direction,
    candidates: direction.candidates.map((candidate) => ({
      ...candidate,
      blindEvaluationEvidence: {
        ...candidate.blindEvaluationEvidence,
        humanReviewed: false,
        aiReviewed: true,
        componentStatus:
          'AI_BLIND_QUALITY_EVALUATION_COMPONENT_COMPLETE'
      }
    }))
  }));
  report.audit.aiDecisionsSha256 = sha256(decisionsContent);
  report.audit.rawScoresSha256 = sha256(JSON.stringify(report.rawScores));
  report.audit.structuralBindingAuditReused = true;
  report.gateA = {
    qualityEvaluationComponentComplete: true,
    assessmentType: 'AI_REVIEW',
    inputStatus: 'GATE_A_INPUT_INCOMPLETE',
    overallGateAStatus:
      'BLOCKED_PENDING_OTHER_M4_EVIDENCE_AND_USER_GATE_A_DECISION',
    limitation:
      'This AI review replaces the Phase 7 400-item human review requirement only. It is not human evidence and cannot authorize legal approval, integration, packaging, distribution, or Gate A.'
  };
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  assert(
    report.rawScores.length === 400
      && directions.every((direction) =>
        report.rawScores.filter((score) => score.direction === direction)
          .length >= 200)
      && report.rawScores.every((score) =>
        score.reviewMode === 'AI_MODEL_BLIND_REVIEW'
        && score.aiReviewAttestation
          === 'AI_MODEL_ASSESSED_SOURCE_REFERENCE_AND_CANDIDATE_OUTPUT'
        && !Object.hasOwn(score, 'humanReviewAttestation')),
    'AI_REPORT_SCORE_SET_INVALID'
  );
  const [scoreSchema, reportSchema] = await Promise.all([
    readFile(resolve(
      scriptRoot,
      'schemas',
      'blind-evaluation-ai-score.schema.json'
    ), 'utf8').then(JSON.parse),
    readFile(resolve(
      scriptRoot,
      'schemas',
      'blind-evaluation-ai-report.schema.json'
    ), 'utf8').then(JSON.parse)
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateScore = ajv.compile(scoreSchema);
  const validateReport = ajv.compile(reportSchema);
  assert(
    report.rawScores.every((score) => validateScore(score)),
    'AI_SCORE_SCHEMA_VALIDATION_FAILED',
    { error: validateScore.errors?.[0] ?? null }
  );
  assert(
    validateReport(report),
    'AI_REPORT_SCHEMA_VALIDATION_FAILED',
    { error: validateReport.errors?.[0] ?? null }
  );
  return { report, reportContent };
}

async function runCli() {
  const options = parseOptions(process.argv.slice(2));
  const runId = required(options, 'run-id');
  assert(/^run-[a-f0-9]{16}$/u.test(runId), 'RUN_ID_INVALID');
  const runDirectory = resolve(blindRoot, runId);
  const decisionsPath = resolve(required(options, 'decisions'));
  const authorizationPath = resolve(required(options, 'authorization'));
  const generationPaths = {
    'en-zh': resolve(required(options, 'generation-en-zh')),
    'zh-en': resolve(required(options, 'generation-zh-en'))
  };
  const [
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    decisionsContent
  ] = await Promise.all([
    readFile(resolve(runDirectory, 'manifest.json'), 'utf8'),
    readFile(resolve(runDirectory, 'review-batch.jsonl'), 'utf8'),
    readFile(resolve(runDirectory, 'score-template.jsonl'), 'utf8'),
    readFile(resolve(runDirectory, 'private-answer-key.json'), 'utf8'),
    readFile(decisionsPath, 'utf8')
  ]);
  const manifest = JSON.parse(manifestContent);
  const decisions = JSON.parse(decisionsContent);
  const candidateBindingReport = await deriveGateACandidateBindings({
    authorizationPath,
    generationPaths
  });
  const reportId = `report-${randomBytes(8).toString('hex')}`;
  const { report, reportContent } = await summarizeAiScores({
    manifest,
    manifestContent,
    batchContent,
    scoreTemplateContent,
    answerKeyContent,
    decisions,
    decisionsContent,
    candidateBindingReport,
    reportId
  });
  await mkdir(runDirectory, { recursive: true });
  const outputPath = resolve(runDirectory, `${reportId}-ai-v1.json`);
  await writeFile(outputPath, reportContent, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    schemaVersion: report.schemaVersion,
    assessmentType: 'AI_REVIEW',
    validAiReviewCount: report.counts.validAiReviewCount,
    pendingAiReviewCount: report.counts.pendingAiReviewCount,
    candidateGenerationBindingSetSha256:
      report.audit.candidateGenerationBindingSetSha256,
    reportSha256: sha256(reportContent),
    logicalName: basename(outputPath),
    overallGateAStatus: report.gateA.overallGateAStatus
  }, null, 2)}\n`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index]?.startsWith('--'), 'CLI_OPTION_INVALID');
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function required(options, key) {
  assert(typeof options[key] === 'string' && options[key].length > 0,
    `CLI_OPTION_REQUIRED:${key}`);
  return options[key];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: error?.code ?? error?.message ?? 'AI_BLIND_EVAL_FAILED',
      details: error?.details ?? {}
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

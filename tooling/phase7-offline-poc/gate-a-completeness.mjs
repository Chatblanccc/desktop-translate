import { createHash } from 'node:crypto';
import {
  validateM4AiCompletion
} from './m4-ai-completion.mjs';

export const GATE_A_INPUT_READY = 'GATE_A_INPUT_READY';
export const GATE_A_INPUT_INCOMPLETE = 'GATE_A_INPUT_INCOMPLETE';
export const GATE_A_INPUT_NON_AUTHORIZING_SHAPE_CHECK =
  'GATE_A_INPUT_NON_AUTHORIZING_SHAPE_CHECK';
export const MIN_COLD_TRIALS_PER_DIRECTION = 20;
export const MIN_BLIND_REVIEWS_PER_DIRECTION = 200;

const DIRECTIONS = Object.freeze(['en-zh', 'zh-en']);
const POC_SCOPE = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION';
const SHA256 = /^[a-f0-9]{64}$/u;
const NUMBER_TOLERANCE = 0.01;
const ONE_GIB_BYTES = 1_073_741_824;
const ONE_POINT_ONE_GIB_BYTES = 1_181_116_006;
const BASE_INSTALLER_LIMIT_BYTES = 157_286_400;
const CORE_PACK_TARGET_BYTES = 314_572_800;
const CORE_PACK_HARD_LIMIT_BYTES = 419_430_400;
const MAX_VERIFIED_TRANSITION_SAMPLES = 8;
const MAX_ADJACENT_VALID_SAMPLE_GAP_MS = 500;
const MAX_EXIT_ONLY_ADJACENT_VALID_SAMPLE_GAP_MS = 1250;
const MAX_TOTAL_VERIFIED_TRANSITION_GAP_MS = 1000;
const COMPLETE_DISCOVERY_STATUSES = Object.freeze([
  'COMPLETE_PROCESS_ID_LIST',
  'ACCOUNTING_BOUND_KNOWN_IDENTITIES',
  'HEADER_INCONSISTENT_ACCOUNTING_BOUND',
  'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES'
]);
const HARNESS_SOURCES = Object.freeze([
  ['runner', 'coldPwsRunner', 'runnerSha256'],
  ['native', 'coldPwsNative', 'nativeSha256'],
  ['main', 'electronMain', 'electronMainSha256'],
  ['library', 'electronLibrary', 'electronLibrarySha256'],
  ['renderer', 'electronRenderer', 'electronRendererSha256'],
  ['bindings', 'candidateBindings', 'candidateBindingsSha256']
]);

/*
 * This is deliberately a non-authorizing raw-artifact reader, not a Gate A
 * decision maker. It accepts exact raw bytes plus their SHA-256 digests and
 * re-derives the v3 cold-PWS result from the logical samples. Convenience
 * booleans and producer summaries are never accepted as proof.
 */
export function evaluateGateAInputCompleteness(input) {
  if (input?.artifacts?.m4AiCompletion) {
    return evaluateAiDelegatedM4Completion(input.artifacts.m4AiCompletion);
  }
  const unmet = [];
  const cold = readBoundJsonArtifact(
    input?.artifacts?.coldPws,
    'COLD_PWS_RAW_ARTIFACT',
    unmet
  );
  const blind = readBoundJsonArtifact(
    input?.artifacts?.blindEvaluation,
    'HUMAN_BLIND_RAW_ARTIFACT',
    unmet
  );
  const authorization = readBoundJsonArtifact(
    input?.artifacts?.pocAuthorization,
    'POC_AUTHORIZATION_RAW_ARTIFACT',
    unmet
  );
  const candidateGenerations = readBoundJsonArtifactCollection(
    input?.artifacts?.candidateGenerations,
    'CANDIDATE_GENERATION_RAW_ARTIFACT',
    unmet
  );
  const legalReview = readBoundJsonArtifact(
    input?.artifacts?.legalReview,
    'LEGAL_REVIEW_RAW_ARTIFACT',
    unmet
  );
  const osNetworkVerification = readBoundJsonArtifact(
    input?.artifacts?.osNetworkVerification,
    'OS_NETWORK_VERIFICATION_RAW_ARTIFACT',
    unmet
  );
  const osNetworkCapture = readBoundRawArtifact(
    input?.artifacts?.osNetworkCapture,
    'OS_NETWORK_CAPTURE_RAW_ARTIFACT',
    unmet
  );
  const packageSizing = readBoundJsonArtifact(
    input?.artifacts?.packageSizing,
    'PACKAGE_SIZING_RAW_ARTIFACT',
    unmet
  );
  const harness = deriveHarnessSourceIdentity(input?.sources, unmet);
  const generationSummary = deriveCandidateGenerationEvidence(
    candidateGenerations,
    unmet
  );
  const authorizationSummary = authorization
    ? derivePocAuthorization(
      authorization.document,
      authorization.sha256,
      generationSummary,
      unmet
    )
    : null;

  const coldSummary = cold
    ? deriveColdPwsEvidence(
      cold.document,
      harness,
      authorizationSummary,
      generationSummary,
      unmet
    )
    : null;
  const blindSummary = blind
    ? deriveBlindEvidence(blind.document, generationSummary, unmet)
    : null;

  if (coldSummary && generationSummary
      && coldSummary.manifestSha256 !== generationSummary.manifestSha256) {
    unmet.push('MEASUREMENT_AND_GENERATION_MANIFEST_IDENTITY_MISMATCH');
  }
  if (coldSummary && blindSummary && generationSummary) {
    requireCondition(
      coldSummary.candidateGenerationBindingSetSha256
        === blindSummary.candidateGenerationBindingSetSha256
        && coldSummary.candidateGenerationBindingSetSha256
          === generationSummary.bindingSetSha256,
      'CANDIDATE_GENERATION_BINDING_SET_MISMATCH',
      unmet
    );
  }

  const primaryEvidenceSetSha256 = derivePrimaryEvidenceSetSha256({
    cold,
    blind,
    authorization,
    candidateGenerations,
    harness,
    generationSummary
  });
  const legalSummary = legalReview
    ? deriveLegalReviewEvidence(
      legalReview.document,
      primaryEvidenceSetSha256,
      generationSummary,
      unmet
    )
    : null;
  const networkSummary = osNetworkVerification
    ? deriveOsNetworkEvidence(
      osNetworkVerification.document,
      osNetworkCapture,
      primaryEvidenceSetSha256,
      generationSummary,
      unmet
    )
    : null;
  const sizingSummary = packageSizing
    ? derivePackageSizingEvidence(
      packageSizing.document,
      primaryEvidenceSetSha256,
      generationSummary,
      unmet
    )
    : null;

  const structurallyComplete = unmet.length === 0;
  return {
    inputStatus: structurallyComplete
      ? GATE_A_INPUT_READY
      : GATE_A_INPUT_INCOMPLETE,
    ready: structurallyComplete,
    gateAStatus: structurallyComplete
      ? 'READY_FOR_EXPLICIT_USER_GATE_A_DECISION'
      : 'BLOCKED_INCOMPLETE_M4_EVIDENCE',
    authorizationMode: structurallyComplete
      ? 'NON_AUTHORIZING_EVIDENCE_INPUT_COMPLETE'
      : 'NON_AUTHORIZING_SHAPE_CHECK',
    ...(structurallyComplete ? {
      gateDecisionStatus: 'AWAITING_EXPLICIT_USER_DECISION',
      integrationOrDistributionAuthorized: false
    } : {}),
    requirements: {
      minimumColdTrialsPerDirection: MIN_COLD_TRIALS_PER_DIRECTION,
      coldTrialsRequireFreshProcess: true,
      privateWorkingSetMetric: 'WINDOWS_PRIVATE_WORKING_SET',
      minimumValidSamplesPerTrial: 10,
      minimumCoverageMillisecondsPerTrial: 1000,
      maximumLaunchToFirstSampleMilliseconds: 250,
      maximumSamplingCadenceMilliseconds: 250,
      maximumLogicalSampleSpanMilliseconds: 250,
      maximumProcessQuerySkewMilliseconds: 250,
      maximumVerifiedMembershipTransitionSamples:
        MAX_VERIFIED_TRANSITION_SAMPLES,
      maximumAdjacentValidSampleGapMilliseconds:
        MAX_ADJACENT_VALID_SAMPLE_GAP_MS,
      maximumExitOnlyAdjacentValidSampleGapMilliseconds:
        MAX_EXIT_ONLY_ADJACENT_VALID_SAMPLE_GAP_MS,
      maximumTotalVerifiedTransitionGapMilliseconds:
        MAX_TOTAL_VERIFIED_TRANSITION_GAP_MS,
      transitionReservePassBytes: ONE_GIB_BYTES,
      privateWorkingSetBudgetBytes: ONE_POINT_ONE_GIB_BYTES,
      minimumHumanBlindReviewsPerDirection:
        MIN_BLIND_REVIEWS_PER_DIRECTION,
      rawArtifactSha256Binding: true,
      runnerAndHarnessSha256Binding: true,
      authorizationSha256Binding: true,
      logicalSamplesRecomputed: true,
      ...(structurallyComplete ? {
        baseInstallerMaximumBytes: BASE_INSTALLER_LIMIT_BYTES,
        coreModelPackTargetBytes: CORE_PACK_TARGET_BYTES,
        coreModelPackHardMaximumBytes: CORE_PACK_HARD_LIMIT_BYTES,
        candidateGenerationCrossBinding: true,
        legalReviewRequired: true,
        osLevelNetworkCaptureRequired: true,
        finalPackageSizingRequired: true
      } : {})
    },
    artifactBindings: {
      coldPwsSha256: cold?.sha256 ?? null,
      blindEvaluationSha256: blind?.sha256 ?? null,
      pocAuthorizationSha256: authorization?.sha256 ?? null,
      harnessFileSetSha256: harness?.fileSetSha256 ?? null,
      coldPwsRunnerSha256: harness?.runnerSha256 ?? null,
      coldPwsNativeSha256: harness?.nativeSha256 ?? null,
      electronMainSha256: harness?.electronMainSha256 ?? null,
      electronLibrarySha256: harness?.electronLibrarySha256 ?? null,
      electronRendererSha256: harness?.electronRendererSha256 ?? null,
      ...(structurallyComplete ? {
        candidateGenerationSha256s:
          candidateGenerations.map((artifact) => artifact.sha256).sort(),
        legalReviewSha256: legalReview.sha256,
        osNetworkVerificationSha256: osNetworkVerification.sha256,
        osNetworkCaptureSha256: osNetworkCapture.sha256,
        packageSizingSha256: packageSizing.sha256,
        primaryEvidenceSetSha256
      } : {})
    },
    derived: {
      coldPws: coldSummary,
      blindEvaluation: blindSummary,
      candidateGenerations: generationSummary,
      pocAuthorization: authorizationSummary,
      legalReview: legalSummary,
      osNetworkVerification: networkSummary,
      packageSizing: sizingSummary
    },
    unmetConditions: unique(unmet)
  };
}

function evaluateAiDelegatedM4Completion(artifact) {
  const unmet = [];
  const bound = readBoundJsonArtifact(
    artifact,
    'M4_AI_COMPLETION_RAW_ARTIFACT',
    unmet
  );
  if (bound) {
    try {
      validateM4AiCompletion(bound.document);
    } catch (error) {
      unmet.push(error?.code ?? 'M4_AI_COMPLETION_INVALID');
    }
  }
  const ready = unmet.length === 0;
  return {
    inputStatus: ready ? GATE_A_INPUT_READY : GATE_A_INPUT_INCOMPLETE,
    ready,
    gateAStatus: ready
      ? 'READY_FOR_EXPLICIT_USER_GATE_A_DECISION'
      : 'BLOCKED_INCOMPLETE_M4_EVIDENCE',
    authorizationMode: ready
      ? 'NON_AUTHORIZING_AI_DELEGATED_M4_EVIDENCE_COMPLETE'
      : 'NON_AUTHORIZING_SHAPE_CHECK',
    ...(ready ? {
      gateDecisionStatus: 'AWAITING_EXPLICIT_USER_DECISION',
      integrationOrDistributionAuthorized: false
    } : {}),
    requirements: {
      completionSchema: 'phase7-m4-ai-completion-v1',
      aiApprovalMustBeExplicit: true,
      qualifiedLegalOpinionRequired: false,
      osLevelCaptureRequired: false,
      zeroExternalTrafficClaimRequired: false,
      gateAUserDecisionRequired: true
    },
    artifactBindings: {
      m4AiCompletionSha256: bound?.sha256 ?? null,
      primaryEvidenceSetSha256:
        ready ? bound.document.primaryEvidenceSetSha256 : null
    },
    derived: {
      m4AiCompletion: ready ? {
        schemaVersion: bound.document.schemaVersion,
        status: bound.document.status,
        approvalType: 'AI_M4_COMPLETION',
        m4Complete: bound.document.decision.m4Complete,
        legalApprovalType:
          bound.document.legalApproval.approvalType,
        osCapturePerformed:
          bound.document.networkApproval
            .osFirewallOrPacketCapturePerformed,
        zeroExternalTrafficClaimed:
          bound.document.networkApproval.zeroExternalTrafficClaimed,
        m5Authorized: bound.document.decision.m5Authorized
      } : null
    },
    unmetConditions: unique(unmet)
  };
}

export function assertGateAInputReady(input) {
  const result = evaluateGateAInputCompleteness(input);
  if (result.ready) return result;
  const error = new Error('GATE_A_INPUT_NOT_AUTHORIZING');
  error.code = 'GATE_A_INPUT_NOT_AUTHORIZING';
  error.unmetConditions = result.unmetConditions;
  throw error;
}

function deriveHarnessSourceIdentity(sources, unmet) {
  const bound = new Map();
  for (const [, inputKey] of HARNESS_SOURCES) {
    bound.set(inputKey, readBoundSource(
      sources?.[inputKey],
      `HARNESS_SOURCE:${inputKey}`,
      unmet
    ));
  }
  if ([...bound.values()].some((value) => value === null)) {
    return null;
  }
  const lines = [];
  let totalBytes = 0;
  const result = {
    fileCount: HARNESS_SOURCES.length,
    totalBytes: 0,
    fileSetSha256: null
  };
  for (const [fileSetKey, inputKey, reportKey] of HARNESS_SOURCES) {
    const source = bound.get(inputKey);
    result[reportKey] = source.sha256;
    totalBytes += source.sizeBytes;
    lines.push(`${fileSetKey}\0${source.sizeBytes}\0${source.sha256}`);
  }
  result.totalBytes = totalBytes;
  result.fileSetSha256 = sha256(`${lines.join('\n')}\n`);
  return result;
}

function deriveCandidateGenerationEvidence(artifacts, unmet) {
  const prefix = 'CANDIDATE_GENERATION';
  if (!artifacts) return null;
  requireCondition(
    artifacts.length === DIRECTIONS.length,
    `${prefix}_ARTIFACT_COUNT_INVALID`,
    unmet
  );
  const summaries = artifacts.map((artifact, index) => (
    deriveCandidateGenerationArtifact(
      artifact.document,
      artifact.sha256,
      `${prefix}:${index + 1}`,
      unmet
    )
  ));
  const identities = summaries.map((summary) => summary.identity);
  requireCondition(
    sameStringSet(
      identities.map((identity) => identity.direction),
      [...DIRECTIONS]
    ),
    `${prefix}_DIRECTION_SET_INVALID`,
    unmet
  );
  for (const [field, code] of [
    ['candidateId', 'DUPLICATE_CANDIDATE_ID'],
    ['generationRunId', 'DUPLICATE_GENERATION_RUN_ID'],
    ['identitySha256', 'DUPLICATE_IDENTITY'],
    ['artifactSha256', 'DUPLICATE_ARTIFACT']
  ]) {
    const values = summaries.map((summary) => (
      field === 'artifactSha256' ? summary.artifactSha256 : summary.identity[field]
    ));
    requireCondition(
      new Set(values).size === values.length,
      `${prefix}_${code}`,
      unmet
    );
  }
  const manifestSha256s = unique(
    identities.map((identity) => identity.manifestSha256)
  );
  const authorizationSha256s = unique(
    identities.map((identity) => identity.authorizationSha256)
  );
  const authorizationRecordIds = unique(
    identities.map((identity) => identity.authorizationRecordId)
  );
  requireCondition(
    manifestSha256s.length === 1,
    `${prefix}_MANIFEST_IDENTITY_DRIFT`,
    unmet
  );
  requireCondition(
    authorizationSha256s.length === 1
      && authorizationRecordIds.length === 1,
    `${prefix}_AUTHORIZATION_IDENTITY_DRIFT`,
    unmet
  );
  const bindings = summaries.map((summary) => ({
    direction: summary.identity.direction,
    candidateId: summary.identity.candidateId,
    generationRunId: summary.identity.generationRunId,
    generationArtifactSha256: summary.artifactSha256,
    generationIdentitySha256: summary.identity.identitySha256,
    sourceSetIdentitySha256:
      summary.identity.sourceSet.identitySha256,
    sourceSetRecordCount: summary.identity.sourceSet.recordCount,
    candidateOutputArtifactSha256:
      summary.candidateOutput.artifactSha256,
    candidateOutputItemIdentitySetSha256:
      summary.candidateOutput.itemIdentitySetSha256
  })).sort(compareCandidateBinding);
  return {
    schemaVersion: 'phase7-gate-a-candidate-generation-set-v1',
    artifactCount: artifacts.length,
    manifestSha256: manifestSha256s[0] ?? null,
    authorizationSha256: authorizationSha256s[0] ?? null,
    authorizationRecordId: authorizationRecordIds[0] ?? null,
    bindingSetSha256: candidateBindingSetSha256(bindings),
    bindings,
    candidates: summaries.sort(
      (left, right) => compareCandidateBinding(left.identity, right.identity)
    )
  };
}

function deriveCandidateGenerationArtifact(
  document,
  artifactSha256,
  prefix,
  unmet
) {
  requireCondition(
    exactKeys(document, [
      'schemaVersion',
      'status',
      'scope',
      'identity',
      'identitySha256',
      'candidateOutput',
      'privacy',
      'gateA'
    ]),
    `${prefix}_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    document?.schemaVersion === 'phase7-gate-a-candidate-generation-v1',
    `${prefix}_SCHEMA_UNSUPPORTED`,
    unmet
  );
  requireCondition(
    document?.status === 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE'
      && document?.scope === POC_SCOPE,
    `${prefix}_STATUS_OR_SCOPE_INVALID`,
    unmet
  );
  const identity = document?.identity;
  requireCondition(
    exactKeys(identity, [
      'schemaVersion',
      'direction',
      'candidateId',
      'generationRunId',
      'manifestSha256',
      'authorizationSha256',
      'authorizationRecordId',
      'model',
      'runtime',
      'sourceSet',
      'workloadIdentitySha256'
    ]),
    `${prefix}_IDENTITY_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    identity?.schemaVersion
      === 'phase7-gate-a-candidate-generation-identity-v1'
      && DIRECTIONS.includes(identity?.direction)
      && validSafeId(identity?.candidateId)
      && validSafeId(identity?.generationRunId)
      && validSafeId(identity?.authorizationRecordId)
      && validSha(identity?.manifestSha256)
      && validSha(identity?.authorizationSha256)
      && validSha(identity?.workloadIdentitySha256),
    `${prefix}_IDENTITY_FIELDS_INVALID`,
    unmet
  );
  requireCondition(
    exactKeys(identity?.model, ['treeSha256'])
      && validSha(identity?.model?.treeSha256),
    `${prefix}_MODEL_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    exactKeys(identity?.runtime, [
      'materializedTreeSha256',
      'servedTreeSha256'
    ])
      && validSha(identity?.runtime?.materializedTreeSha256)
      && validSha(identity?.runtime?.servedTreeSha256),
    `${prefix}_RUNTIME_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    exactKeys(identity?.sourceSet, [
      'schemaVersion',
      'recordCount',
      'identitySha256'
    ])
      && identity?.sourceSet?.schemaVersion
        === 'phase7-gate-a-source-set-v1'
      && Number.isSafeInteger(identity?.sourceSet?.recordCount)
      && identity.sourceSet.recordCount >= MIN_BLIND_REVIEWS_PER_DIRECTION
      && validSha(identity?.sourceSet?.identitySha256),
    `${prefix}_SOURCE_SET_IDENTITY_INVALID`,
    unmet
  );
  const identityWithoutDigest = isRecord(identity)
    ? { ...identity }
    : {};
  delete identityWithoutDigest.identitySha256;
  const derivedIdentitySha256 = sha256Canonical(identityWithoutDigest);
  requireCondition(
    validSha(document?.identitySha256)
      && document.identitySha256 === derivedIdentitySha256,
    `${prefix}_IDENTITY_SHA256_MISMATCH`,
    unmet
  );
  requireCondition(
    exactKeys(document?.candidateOutput, [
      'artifactSha256',
      'recordCount',
      'itemIdentitySetSha256',
      'rawTextEmittedInEvidence'
    ])
      && validSha(document?.candidateOutput?.artifactSha256)
      && document?.candidateOutput?.recordCount
        === identity?.sourceSet?.recordCount
      && validSha(document?.candidateOutput?.itemIdentitySetSha256)
      && document?.candidateOutput?.rawTextEmittedInEvidence === false,
    `${prefix}_CANDIDATE_OUTPUT_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    exactKeys(document?.privacy, [
      'sourceTextInEvidence',
      'translationTextInEvidence',
      'absolutePathsInEvidence',
      'usernamesInEvidence'
    ])
      && Object.values(document?.privacy ?? {}).every(
        (value) => value === false
      ),
    `${prefix}_PRIVACY_ATTESTATION_INVALID`,
    unmet
  );
  requireCondition(
    exactKeys(document?.gateA, [
      'ready',
      'integrationOrDistributionAuthorized'
    ])
      && document?.gateA?.ready === false
      && document?.gateA?.integrationOrDistributionAuthorized === false,
    `${prefix}_NON_AUTHORIZING_STATUS_INVALID`,
    unmet
  );
  return {
    artifactSha256,
    identity: {
      ...identity,
      identitySha256: document?.identitySha256 ?? null
    },
    candidateOutput: document?.candidateOutput ?? null
  };
}

function derivePocAuthorization(
  document,
  artifactSha256,
  generationSummary,
  unmet
) {
  const prefix = 'POC_AUTHORIZATION';
  requireCondition(
    exactKeys(document, [
      'schemaVersion',
      'authorization',
      'scope',
      'basis',
      'manifestSha256',
      'candidateIds',
      'observedLicenseMetadataExpressions',
      'acknowledgedRiskCodes',
      'authorizationRecordId',
      'authorizedAt'
    ]),
    `${prefix}_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    document?.schemaVersion === 'phase7-offline-poc-authorization-v1'
      && document?.authorization === 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      && document?.scope === POC_SCOPE
      && document?.basis === 'PHASE7_M0_USER_AUTHORIZATION',
    `${prefix}_STATUS_OR_SCOPE_INVALID`,
    unmet
  );
  requireCondition(
    validSha(document?.manifestSha256)
      && validSafeId(document?.authorizationRecordId)
      && validIsoDateTime(document?.authorizedAt)
      && uniqueNonEmptyStrings(document?.candidateIds)
      && uniqueNonEmptyStrings(
        document?.observedLicenseMetadataExpressions
      )
      && uniqueNonEmptyStrings(document?.acknowledgedRiskCodes),
    `${prefix}_FIELDS_INVALID`,
    unmet
  );
  if (generationSummary) {
    const generationCandidateIds = generationSummary.bindings.map(
      (binding) => binding.candidateId
    );
    requireCondition(
      document?.manifestSha256 === generationSummary.manifestSha256,
      `${prefix}_MANIFEST_MISMATCH`,
      unmet
    );
    requireCondition(
      artifactSha256 === generationSummary.authorizationSha256
        && document?.authorizationRecordId
          === generationSummary.authorizationRecordId,
      `${prefix}_RAW_ARTIFACT_NOT_BOUND_TO_GENERATIONS`,
      unmet
    );
    requireCondition(
      sameStringSet(document?.candidateIds, generationCandidateIds),
      `${prefix}_CANDIDATE_SET_MISMATCH`,
      unmet
    );
  }
  return {
    sha256: artifactSha256,
    manifestSha256: document?.manifestSha256 ?? null,
    authorizationRecordId: document?.authorizationRecordId ?? null,
    candidateIds: Array.isArray(document?.candidateIds)
      ? [...document.candidateIds].sort()
      : []
  };
}

function deriveColdPwsEvidence(
  report,
  suppliedHarnessIdentity,
  suppliedAuthorization,
  candidateGenerations,
  unmet
) {
  const prefix = 'COLD_PWS';
  requireCondition(
    report?.schemaVersion === 'phase7-offline-cold-pws-v3',
    `${prefix}_SCHEMA_UNSUPPORTED`,
    unmet
  );
  requireCondition(
    report?.status === 'PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE',
    `${prefix}_STATUS_NOT_COMPLETE`,
    unmet
  );
  validateAuthorizationBoundary(report, prefix, unmet);
  validateMeasurementMethod(report?.measurementMethod, prefix, unmet);
  validateRunnerConfiguration(report, prefix, unmet);
  validateHarnessIdentity(
    report?.harnessIdentity,
    suppliedHarnessIdentity,
    prefix,
    unmet
  );
  requireCondition(
    report?.environment?.runnerSha256
      === report?.harnessIdentity?.runnerSha256,
    `${prefix}_ENVIRONMENT_RUNNER_HASH_MISMATCH`,
    unmet
  );
  requireCondition(
    validSha(report?.authorizationSha256),
    `${prefix}_AUTHORIZATION_HASH_MISSING`,
    unmet
  );
  requireCondition(
    report?.authorizationSha256 === suppliedAuthorization?.sha256,
    `${prefix}_AUTHORIZATION_HASH_NOT_BOUND_TO_RAW_ARTIFACT`,
    unmet
  );
  validateElectronIdentity(report, prefix, unmet);
  validateArtifactIdentity(report?.artifactIdentity, prefix, unmet);
  const generationBindings = validateCandidateGenerationBindings(
    report?.candidateGenerationBindings,
    candidateGenerations,
    `${prefix}_CANDIDATE_GENERATION`,
    unmet
  );
  validateColdCandidateGenerationIdentity(
    report?.artifactIdentity,
    generationBindings,
    candidateGenerations,
    unmet
  );
  requireCondition(
    report?.externalNetworkVerification
      === 'NOT_VERIFIED_BY_OS_FIREWALL_OR_PACKET_CAPTURE',
    `${prefix}_NETWORK_VERIFICATION_STATUS_UNKNOWN`,
    unmet
  );
  requireCondition(
    report?.gateA?.status === 'INCOMPLETE'
      && report?.gateA?.eligible === false
      && report?.gateA?.coldAndPrivateWorkingSetEvidenceStatus === 'COMPLETE'
      && report?.gateA?.warmEvidenceStatus === 'COMPLETE',
    `${prefix}_GATE_A_NON_AUTHORIZING_STATUS_INVALID`,
    unmet
  );
  requireCondition(
    report?.rawTextEmitted === false
      && report?.rawPathsEmitted === false
      && report?.processIdentifiersEmitted === false,
    `${prefix}_PRIVACY_ATTESTATION_INVALID`,
    unmet
  );

  const configuration = report?.runnerConfiguration;
  const trials = Array.isArray(report?.trials) ? report.trials : [];
  const derivedTrials = trials.map((trial) => (
    deriveColdTrial(
      trial,
      configuration,
      report?.artifactIdentity,
      unmet
    )
  ));
  const directionReports = Array.isArray(report?.directions)
    ? report.directions
    : [];
  for (const direction of DIRECTIONS) {
    const matching = derivedTrials.filter(
      (entry) => entry.direction === direction
    );
    const aggregate = directionReports.find(
      (entry) => entry?.direction === direction
    );
    validateDirectionTrials(
      direction,
      matching,
      aggregate,
      report?.artifactIdentity?.workloadIdentityByDirection?.[direction],
      unmet
    );
  }
  requireCondition(
    trials.length
      === DIRECTIONS.length * Number(configuration?.trialsPerDirection),
    `${prefix}_TRIAL_COUNT_MISMATCH`,
    unmet
  );
  requireCondition(
    new Set(directionReports.map((entry) => entry?.direction)).size
      === DIRECTIONS.length
      && directionReports.length === DIRECTIONS.length,
    `${prefix}_DIRECTION_AGGREGATE_SET_INVALID`,
    unmet
  );

  const derivedFailures = derivedTrials.filter((trial) => !trial.valid).length;
  const derivedForcedKills = safeSum(
    trials.map((trial) => trial?.forcedKillCount)
  );
  const derivedWarmFailures = safeSum(
    trials.map((trial) => trial?.warm?.failures)
  );
  const derivedTransitionSamples = safeSum(
    derivedTrials.map((trial) => trial.transitionSampleCount)
  );
  const derivedTransitionGaps = safeSum(
    derivedTrials.map((trial) => trial.transitionGapCount)
  );
  validateTotals(
    report?.totals,
    trials.length,
    derivedFailures,
    derivedForcedKills,
    derivedWarmFailures,
    derivedTransitionSamples,
    derivedTransitionGaps,
    unmet
  );
  requireCondition(
    derivedFailures === 0,
    `${prefix}_TRIAL_FAILURES_PRESENT`,
    unmet
  );
  requireCondition(
    derivedForcedKills === 0,
    `${prefix}_FORCED_CLEANUP_PRESENT`,
    unmet
  );
  requireCondition(
    derivedWarmFailures === 0,
    `${prefix}_WARM_FAILURES_PRESENT`,
    unmet
  );

  return {
    schemaVersion: report?.schemaVersion ?? null,
    status: report?.status ?? null,
    manifestSha256: report?.artifactIdentity?.manifestSha256 ?? null,
    trials: trials.length,
    successfulTrials: trials.length - derivedFailures,
    failures: derivedFailures,
    forcedKillCount: derivedForcedKills,
    validLogicalSamples: safeSum(
      derivedTrials.map((trial) => trial.validSampleCount)
    ),
    discardedLogicalSamples: safeSum(
      derivedTrials.map((trial) => trial.discardedSampleCount)
    ),
    verifiedMembershipTransitionSamples: safeSum(
      derivedTrials.map((trial) => trial.transitionSampleCount)
    ),
    verifiedMembershipTransitionGaps: safeSum(
      derivedTrials.map((trial) => trial.transitionGapCount)
    ),
    harnessFileSetSha256: report?.harnessIdentity?.fileSetSha256 ?? null,
    runnerConfigurationSha256:
      report?.runnerConfigurationSha256 ?? null,
    authorizationSha256: report?.authorizationSha256 ?? null,
    electronDistTreeSha256: report?.electronDistTree?.treeSha256 ?? null,
    candidateGenerationBindingSetSha256:
      report?.artifactIdentity?.candidateGenerationBindingSetSha256 ?? null
  };
}

function validateCandidateGenerationBindings(
  bindings,
  generationSummary,
  prefix,
  unmet
) {
  const normalized = Array.isArray(bindings)
    ? bindings.map((binding) => ({
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
    }))
    : [];
  requireCondition(
    Array.isArray(bindings)
      && bindings.length === DIRECTIONS.length
      && bindings.every((binding) => (
        exactKeys(binding, [
          'direction',
          'candidateId',
          'generationRunId',
          'generationArtifactSha256',
          'generationIdentitySha256',
          'sourceSetIdentitySha256',
          'sourceSetRecordCount',
          'candidateOutputArtifactSha256',
          'candidateOutputItemIdentitySetSha256'
        ])
        && DIRECTIONS.includes(binding.direction)
        && validSafeId(binding.candidateId)
        && validSafeId(binding.generationRunId)
        && validSha(binding.generationArtifactSha256)
        && validSha(binding.generationIdentitySha256)
        && validSha(binding.sourceSetIdentitySha256)
        && Number.isSafeInteger(binding.sourceSetRecordCount)
        && binding.sourceSetRecordCount
          >= MIN_BLIND_REVIEWS_PER_DIRECTION
        && validSha(binding.candidateOutputArtifactSha256)
        && validSha(binding.candidateOutputItemIdentitySetSha256)
      )),
    `${prefix}_BINDINGS_INVALID`,
    unmet
  );
  requireCondition(
    sameStringSet(
      normalized.map((binding) => binding.direction),
      [...DIRECTIONS]
    )
      && new Set(
        normalized.map((binding) => binding.candidateId)
      ).size === normalized.length
      && new Set(
        normalized.map((binding) => binding.generationRunId)
      ).size === normalized.length
      && new Set(
        normalized.map((binding) => binding.generationArtifactSha256)
      ).size === normalized.length
      && new Set(
        normalized.map((binding) => binding.generationIdentitySha256)
      ).size === normalized.length,
    `${prefix}_DUPLICATE_OR_REMAPPED_BINDING`,
    unmet
  );
  if (generationSummary) {
    requireCondition(
      candidateBindingsEqual(normalized, generationSummary.bindings),
      `${prefix}_RAW_GENERATION_ARTIFACT_SET_MISMATCH`,
      unmet
    );
  }
  return normalized.sort(compareCandidateBinding);
}

function validateColdCandidateGenerationIdentity(
  artifactIdentity,
  bindings,
  generationSummary,
  unmet
) {
  const prefix = 'COLD_PWS_CANDIDATE_GENERATION';
  const reportedBindingSetSha256 =
    artifactIdentity?.candidateGenerationBindingSetSha256;
  requireCondition(
    validSha(reportedBindingSetSha256)
      && reportedBindingSetSha256 === candidateBindingSetSha256(bindings)
      && reportedBindingSetSha256 === generationSummary?.bindingSetSha256,
    `${prefix}_BINDING_SET_SHA256_MISMATCH`,
    unmet
  );
  requireCondition(
    artifactIdentity?.manifestSha256 === generationSummary?.manifestSha256,
    `${prefix}_MANIFEST_IDENTITY_MISMATCH`,
    unmet
  );
  for (const binding of bindings) {
    const generation = generationSummary?.candidates?.find(
      (candidate) => candidate.identity.direction === binding.direction
    );
    const identity = generation?.identity;
    const workload =
      artifactIdentity?.workloadIdentityByDirection?.[binding.direction];
    requireCondition(
      identity?.candidateId === binding.candidateId
        && identity?.generationRunId === binding.generationRunId
        && identity?.authorizationSha256
          === generationSummary?.authorizationSha256,
      `${prefix}_CANDIDATE_OR_AUTHORIZATION_MISMATCH:${binding.direction}`,
      unmet
    );
    requireCondition(
      identity?.model?.treeSha256
        === artifactIdentity?.supplyTreeSha256ByDirection?.[binding.direction],
      `${prefix}_MODEL_TREE_MISMATCH:${binding.direction}`,
      unmet
    );
    requireCondition(
      identity?.runtime?.materializedTreeSha256
        === artifactIdentity?.materializedRuntimeTreeSha256
        && identity?.runtime?.servedTreeSha256
          === artifactIdentity?.servedRuntimeTreeSha256,
      `${prefix}_RUNTIME_TREE_MISMATCH:${binding.direction}`,
      unmet
    );
    requireCondition(
      validWorkloadIdentity(workload)
        && identity?.workloadIdentitySha256
          === sha256Canonical(workload),
      `${prefix}_WORKLOAD_IDENTITY_MISMATCH:${binding.direction}`,
      unmet
    );
  }
}

function validateAuthorizationBoundary(report, prefix, unmet) {
  const boundary = report?.authorizationBoundary;
  requireCondition(
    boundary?.scope === 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
      && boundary?.evidenceStatus === 'NON_AUTHORIZING_RAW_M4_EVIDENCE'
      && boundary?.integrationOrDistributionAuthorized === false
      && boundary?.gateDecisionAuthorized === false
      && report?.integrationOrDistributionAuthorized === false,
    `${prefix}_AUTHORIZATION_BOUNDARY_INVALID`,
    unmet
  );
}

function validateMeasurementMethod(method, prefix, unmet) {
  requireCondition(
    method?.privateWorkingSet
      === 'QUERY_WORKING_SET_SHARED_BIT_PRIVATE_PAGES',
    `${prefix}_WINDOWS_PRIVATE_WORKING_SET_NOT_RECORDED`,
    unmet
  );
  requireCondition(
    method?.qwsIdentityValidation
      === 'SAME_HANDLE_PRE_AND_POST_ACTIVE_CREATION_TIME',
    `${prefix}_SAME_HANDLE_QWS_BINDING_MISSING`,
    unmet
  );
  requireCondition(
    method?.processLaunch
      === 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME'
      && method?.processContainment
        === 'JOB_KILL_ON_CLOSE_NO_BREAKAWAY_FLAGS'
      && method?.processDiscovery
        === 'QUERY_INFORMATION_JOB_OBJECT_MEMBERS'
      && method?.processListCompleteness
        === 'COMPLETE_LIST_OR_ACCOUNTING_BOUND_KNOWN_IDENTITIES'
      && method?.processHistoryCompleteness
        === 'TOTAL_PROCESSES_EQUALS_ALL_OBSERVED_BOUND_IDENTITIES'
      && method?.exitAccountingLagRecovery
        === 'STABLE_DOUBLE_ACCOUNTING_AND_BOUND_ACTIVE_IDENTITY_ENUMERATION'
      && method?.logicalSampleMembership
        === 'PRE_POST_COMPLETE_OR_BOUNDED_VERIFIED_TRANSITION_WITH_TERMINAL_ZERO'
      && method?.membershipTransitionPolicy
        === 'COMPLETE_BOUND_OR_STRICT_EXIT_ONLY_MARKER_BOUND_TERMINAL_ZERO'
      && method?.qwsJobMembershipValidation
        === 'SAME_HANDLE_PRE_AND_POST_IS_PROCESS_IN_JOB'
      && method?.warmCompletionBoundary
        === 'CREATE_NEW_MARKER_BOUND_TO_FINAL_CHILD_REPORT'
      && method?.terminalBoundary
        === 'MARKER_VALIDATED_EXIT_ZERO_EXACT_HISTORY_THREE_ZERO_POLLS'
      && method?.jobProcessQueryRetryPolicy
        === 'ONE_IMMEDIATE_RETRY_PRE_AND_POST_FAIL_CLOSED'
      && method?.postExitJobQueryFailurePolicy
        === 'NO_RETRY_FAIL_FAST_TO_CLEANUP'
      && method?.recursiveDescendantTracking === true,
    `${prefix}_JOB_PROCESS_TREE_BINDING_MISSING`,
    unmet
  );
  requireCondition(
    method?.processIdentityBinding === 'PID_AND_CREATION_TIME_INTERNAL_ONLY',
    `${prefix}_PROCESS_IDENTITY_BINDING_MISSING`,
    unmet
  );
  requireCondition(
    method?.termination
      === 'JOB_LEVEL_TIMEOUT_AND_SAME_HANDLE_BOUND_PROCESS_FALLBACK',
    `${prefix}_BOUND_TERMINATION_METHOD_MISSING`,
    unmet
  );
  requireCondition(
    method?.electronAppMetricsGateAEligible === false,
    `${prefix}_APP_METRICS_MUST_NOT_BE_GATE_A_ELIGIBLE`,
    unmet
  );
}

function validateRunnerConfiguration(report, prefix, unmet) {
  const configuration = report?.runnerConfiguration;
  requireCondition(
    isRecord(configuration),
    `${prefix}_RUNNER_CONFIGURATION_MISSING`,
    unmet
  );
  if (!isRecord(configuration)) return;
  requireCondition(
    report?.runnerConfigurationSha256
      === sha256(JSON.stringify(configuration)),
    `${prefix}_RUNNER_CONFIGURATION_HASH_MISMATCH`,
    unmet
  );
  requireCondition(
    configuration.schemaVersion === report?.schemaVersion
      && sameStringSet(configuration.directions, DIRECTIONS)
      && Number.isSafeInteger(configuration.trialsPerDirection)
      && configuration.trialsPerDirection >= MIN_COLD_TRIALS_PER_DIRECTION
      && configuration.warmIterationsPerTrial === 5,
    `${prefix}_RUNNER_CONFIGURATION_SCOPE_INVALID`,
    unmet
  );
  requireCondition(
    Number.isFinite(configuration.sampleIntervalMilliseconds)
      && configuration.sampleIntervalMilliseconds >= 50
      && configuration.maximumLaunchToFirstSampleMilliseconds <= 250
      && configuration.maximumLaunchToFirstSampleMilliseconds > 0
      && configuration.maximumCadenceMilliseconds <= 250
      && configuration.maximumCadenceMilliseconds > 0
      && configuration.maximumSampleSpanMilliseconds <= 250
      && configuration.maximumSampleSpanMilliseconds > 0
      && configuration.maximumProcessQuerySkewMilliseconds <= 250
      && configuration.maximumProcessQuerySkewMilliseconds > 0
      && configuration.maximumVerifiedMembershipTransitionSamples
        === MAX_VERIFIED_TRANSITION_SAMPLES
      && configuration.maximumAdjacentValidSampleGapMilliseconds
        === MAX_ADJACENT_VALID_SAMPLE_GAP_MS
      && configuration.maximumExitOnlyAdjacentValidSampleGapMilliseconds
        === MAX_EXIT_ONLY_ADJACENT_VALID_SAMPLE_GAP_MS
      && configuration.maximumTotalVerifiedTransitionGapMilliseconds
        === MAX_TOTAL_VERIFIED_TRANSITION_GAP_MS
      && configuration.transitionReservePassBytes === ONE_GIB_BYTES
      && configuration.privateWorkingSetBudgetBytes
        === ONE_POINT_ONE_GIB_BYTES
      && Number.isSafeInteger(configuration.minimumValidSamples)
      && configuration.minimumValidSamples >= 10
      && Number.isFinite(configuration.minimumCoverageMilliseconds)
      && configuration.minimumCoverageMilliseconds >= 1000,
    `${prefix}_RUNNER_CONFIGURATION_SAMPLING_GATES_WEAK`,
    unmet
  );
  requireCondition(
    Number.isSafeInteger(configuration.maximumCaptureBytes)
      && configuration.maximumCaptureBytes > 0
      && configuration.maximumCaptureBytes <= 1_048_576
      && Number.isFinite(configuration.trialTimeoutSeconds)
      && configuration.trialTimeoutSeconds > 0
      && configuration.trialTimeoutSeconds <= 600
      && Number.isFinite(configuration.residualTimeoutSeconds)
      && configuration.residualTimeoutSeconds > 0
      && configuration.residualTimeoutSeconds <= 60
      && Number.isSafeInteger(configuration.residualPollMilliseconds)
      && configuration.residualPollMilliseconds > 0
      && configuration.residualPollMilliseconds <= 1000
      && Number.isSafeInteger(configuration.postTerminateWaitMilliseconds)
      && configuration.postTerminateWaitMilliseconds > 0
      && configuration.postTerminateWaitMilliseconds <= 5000
      && Number.isSafeInteger(configuration.captureReadTimeoutMilliseconds)
      && configuration.captureReadTimeoutMilliseconds > 0
      && configuration.captureReadTimeoutMilliseconds <= 5000
      && Number.isSafeInteger(configuration.maximumFinalReportBytes)
      && configuration.maximumFinalReportBytes > 0
      && configuration.maximumFinalReportBytes <= 67_108_864,
    `${prefix}_RUNNER_CONFIGURATION_BOUNDS_INVALID`,
    unmet
  );
}

function validateHarnessIdentity(
  reported,
  supplied,
  prefix,
  unmet
) {
  requireCondition(
    isRecord(reported)
      && reported.fileCount === HARNESS_SOURCES.length
      && Number.isSafeInteger(reported.totalBytes)
      && reported.totalBytes > 0
      && validSha(reported.fileSetSha256)
      && HARNESS_SOURCES.every(([, , key]) => validSha(reported[key])),
    `${prefix}_HARNESS_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    supplied !== null
      && reported?.fileCount === supplied?.fileCount
      && reported?.totalBytes === supplied?.totalBytes
      && reported?.fileSetSha256 === supplied?.fileSetSha256
      && HARNESS_SOURCES.every(
        ([, , key]) => reported?.[key] === supplied?.[key]
      ),
    `${prefix}_HARNESS_NOT_BOUND_TO_SUPPLIED_RAW_SOURCES`,
    unmet
  );
  requireCondition(
    reported?.runnerSha256 === supplied?.runnerSha256,
    `${prefix}_RUNNER_HASH_NOT_BOUND_TO_SOURCE`,
    unmet
  );
}

function validateElectronIdentity(report, prefix, unmet) {
  const executable = report?.electronExecutable;
  const tree = report?.electronDistTree;
  requireCondition(
    isRecord(executable)
      && typeof executable.version === 'string'
      && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(executable.version)
      && Number.isSafeInteger(executable.sizeBytes)
      && executable.sizeBytes > 0
      && validSha(executable.sha256)
      && validSha(executable.productVersionHash),
    `${prefix}_ELECTRON_EXECUTABLE_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    isRecord(tree)
      && Number.isSafeInteger(tree.fileCount)
      && tree.fileCount > 0
      && Number.isSafeInteger(tree.totalBytes)
      && tree.totalBytes >= executable?.sizeBytes
      && validSha(tree.treeSha256),
    `${prefix}_ELECTRON_DIST_TREE_IDENTITY_INVALID`,
    unmet
  );
}

function validateArtifactIdentity(identity, prefix, unmet) {
  requireCondition(
    validSha(identity?.manifestSha256),
    `${prefix}_MANIFEST_HASH_MISSING`,
    unmet
  );
  requireCondition(
    validSha(identity?.materializedRuntimeTreeSha256),
    `${prefix}_RUNTIME_TREE_HASH_MISSING`,
    unmet
  );
  requireCondition(
    validSha(identity?.servedRuntimeTreeSha256),
    `${prefix}_SERVED_RUNTIME_TREE_HASH_MISSING`,
    unmet
  );
  requireCondition(
    validSha(identity?.candidateGenerationBindingSetSha256),
    `${prefix}_CANDIDATE_GENERATION_BINDING_SET_HASH_MISSING`,
    unmet
  );
  for (const direction of DIRECTIONS) {
    requireCondition(
      validSha(identity?.supplyTreeSha256ByDirection?.[direction]),
      `${prefix}_SUPPLY_TREE_HASH_MISSING:${direction}`,
      unmet
    );
    requireCondition(
      validWorkloadIdentity(identity?.workloadIdentityByDirection?.[direction]),
      `${prefix}_WORKLOAD_IDENTITY_MISSING:${direction}`,
      unmet
    );
  }
}

function deriveColdTrial(trial, configuration, artifactIdentity, unmet) {
  const direction = trial?.direction;
  const trialNumber = trial?.trial;
  const prefix = `COLD_PWS_TRIAL:${direction ?? 'UNKNOWN'}:${trialNumber ?? 'UNKNOWN'}`;
  const samples = Array.isArray(trial?.logicalSamples)
    ? trial.logicalSamples
    : [];
  const completeSamples = samples.filter(
    (sample) => sample?.status === 'COMPLETE'
  );
  const transitionSamples = samples.filter(
    (sample) => sample?.status === 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
  );
  const discardedSamples = samples.filter(
    (sample) => sample?.status === 'DISCARDED'
  ).length;
  const allStarts = samples.map((sample) => sample?.startElapsedMs);
  const starts = completeSamples.map((sample) => sample?.startElapsedMs);
  const ends = completeSamples.map((sample) => sample?.endElapsedMs);
  const spans = samples.map((sample) => sample?.spanMs);
  const skews = samples.map(
    (sample) => sample?.maximumProcessQuerySkewMs
  );
  const intervals = allStarts.slice(1).map(
    (start, index) => start - allStarts[index]
  );
  let processQueryFailures = 0;
  let samplesValid = samples.length > 0;
  let peakBytes = 0;
  let maximumMemberCount = 0;
  const executableHashes = new Set();

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const sampleResult = validateLogicalSample(sample, index + 1);
    samplesValid &&= sampleResult.valid;
    processQueryFailures += sampleResult.nonTransitionProcessQueryFailures;
    if (sampleResult.kind === 'COMPLETE') {
      peakBytes = Math.max(peakBytes, sampleResult.privateWorkingSetBytes);
    }
    maximumMemberCount = Math.max(
      maximumMemberCount,
      sampleResult.memberCount
    );
    for (const hash of sampleResult.executableHashes) {
      executableHashes.add(hash);
    }
  }

  const transitionGapSummary = deriveMembershipTransitionGaps(samples);
  const coverage = completeSamples.length === 0
    ? 0
    : ends.at(-1) - starts[0];
  const budgetStatus = derivePrivateWorkingSetBudgetStatus(
    peakBytes,
    transitionSamples.length,
    configuration
  );
  const budgetAccepted = [
    'PASS_CONTINUOUS_SAMPLING',
    'PASS_WITH_TRANSITION_RESERVE'
  ].includes(budgetStatus);
  const transitionGapCadenceAccepted = isTransitionGapCadenceAccepted(
    transitionGapSummary.gaps,
    configuration
  );
  const expectedSamplingStatus = transitionSamples.length > 0
    ? 'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
    : 'COMPLETE';
  const expectedTrialStatus = transitionSamples.length > 0
    ? 'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
    : 'COMPLETE';
  const expectedContinuityClaim = transitionSamples.length > 0
    ? 'BOUNDED_TRANSITION_GAPS_NOT_CONTINUOUS'
    : 'CONTINUOUS_COMPLETE_SAMPLES';
  const rawSamplingValid = samplesValid
    && discardedSamples === 0
    && samples.length === completeSamples.length + transitionSamples.length
    && allStarts.every(finiteNonNegative)
    && starts.every(finiteNonNegative)
    && ends.every(finiteNonNegative)
    && spans.every(finiteNonNegative)
    && skews.every(finiteNonNegative)
    && isMonotonic(allStarts)
    && isMonotonic(starts)
    && completeSamples.length >= Number(configuration?.minimumValidSamples)
    && coverage >= Number(configuration?.minimumCoverageMilliseconds)
    && allStarts[0] <= Number(
      configuration?.maximumLaunchToFirstSampleMilliseconds
    )
    && intervals.length > 0
    && Math.max(...intervals)
      <= Number(configuration?.maximumCadenceMilliseconds)
    && Math.max(...spans)
      <= Number(configuration?.maximumSampleSpanMilliseconds)
    && Math.max(...skews)
      <= Number(configuration?.maximumProcessQuerySkewMilliseconds)
    && processQueryFailures === 0
    && transitionGapSummary.boundedByCompleteSamples
    && transitionSamples.length
      <= Number(configuration?.maximumVerifiedMembershipTransitionSamples)
    && transitionGapCadenceAccepted
    && transitionGapSummary.totalDurationMs
      <= Number(configuration?.maximumTotalVerifiedTransitionGapMilliseconds)
    && budgetAccepted;

  const summaryMatchesRaw = trial?.validSampleCount === completeSamples.length
    && trial?.discardedSampleCount === discardedSamples
    && trial?.measurementFailureCount === processQueryFailures
    && trial?.verifiedMembershipTransitionSampleCount
      === transitionSamples.length
    && trial?.verifiedMembershipTransitionGapCount
      === transitionGapSummary.gaps.length
    && approximatelyEqual(
      trial?.verifiedMembershipTransitionGapTotalMs,
      transitionGapSummary.totalDurationMs
    )
    && approximatelyEqual(
      trial?.maximumAdjacentValidSampleGapMs,
      transitionGapSummary.maximumAdjacentValidSampleGapMs
    )
    && transitionGapSummariesEqual(
      trial?.membershipTransitionGaps,
      transitionGapSummary.gaps
    )
    && trial?.samplingContinuityClaim === expectedContinuityClaim
    && trial?.privateWorkingSetBudgetStatus === budgetStatus
    && trial?.privateWorkingSetPeakBytes === peakBytes
    && trial?.maximumTreeProcessCount === maximumMemberCount
    && approximatelyEqual(trial?.launchToFirstSampleMs, allStarts[0])
    && approximatelyEqual(trial?.validCoverageMs, coverage)
    && distributionEqual(
      trial?.samplingIntervalMilliseconds,
      distribution(intervals)
    )
    && distributionEqual(
      trial?.logicalSampleSpanMilliseconds,
      distribution(spans)
    )
    && distributionEqual(
      trial?.processQuerySkewMilliseconds,
      distribution(skews)
    );
  requireCondition(
    rawSamplingValid,
    `${prefix}_RAW_LOGICAL_SAMPLING_INVALID`,
    unmet
  );
  requireCondition(
    summaryMatchesRaw,
    `${prefix}_SAMPLING_SUMMARY_NOT_DERIVED_FROM_RAW`,
    unmet
  );

  const workloadIdentity = trial?.workloadIdentity;
  const warmValid = trial?.warm?.iterationsRequested === 5
    && trial?.warm?.failures === 0
    && Array.isArray(trial?.warm?.observations)
    && trial.warm.observations.length === 5
    && trial.warm.observations.every(validWarmObservation);
  const markerBinding = {
    direction,
    manifestSha256: artifactIdentity?.manifestSha256,
    supplyTreeSha256:
      artifactIdentity?.supplyTreeSha256ByDirection?.[direction],
    materializedRuntimeTreeSha256:
      artifactIdentity?.materializedRuntimeTreeSha256,
    servedRuntimeTreeSha256:
      artifactIdentity?.servedRuntimeTreeSha256,
    workloadConfigSha256: workloadIdentity?.workloadConfigSha256,
    sourceSha256: workloadIdentity?.sourceSha256,
    sampleIdentitySha256: workloadIdentity?.sampleIdentitySha256,
    targetSha256: trial?.rendererColdTargetSha256,
    warmTargetSha256: Array.isArray(trial?.warm?.observations)
      ? trial.warm.observations.map(
        (observation) => observation?.targetSha256
      )
      : [],
    harnessStartToWarmSequenceCompleteMs:
      trial?.harnessStartToWarmSequenceCompleteMs
  };
  const markerBindingValid = validSha(markerBinding.manifestSha256)
    && validSha(markerBinding.supplyTreeSha256)
    && validSha(markerBinding.materializedRuntimeTreeSha256)
    && validSha(markerBinding.servedRuntimeTreeSha256)
    && validSha(markerBinding.workloadConfigSha256)
    && validSha(markerBinding.sourceSha256)
    && validSha(markerBinding.sampleIdentitySha256)
    && validSha(markerBinding.targetSha256)
    && markerBinding.warmTargetSha256.length === 5
    && markerBinding.warmTargetSha256.every(validSha)
    && finiteNonNegative(
      markerBinding.harnessStartToWarmSequenceCompleteMs
    )
    && trial?.completionMarkerBindingSha256
      === sha256(JSON.stringify(markerBinding));
  const lifecycleValid = trial?.status === expectedTrialStatus
    && trial?.blockerCode === null
    && trial?.launchMode === 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME'
    && trial?.jobPolicy === 'KILL_ON_JOB_CLOSE_NO_BREAKAWAY_FLAGS'
    && trial?.childReportValidated === true
    && trial?.completionMarkerObserved === true
    && trial?.completionMarkerValidated === true
    && markerBindingValid
    && finiteNonNegative(trial?.rendererFirstTranslationMs)
    && finiteNonNegative(trial?.rendererColdRouteTotalMs)
    && validSha(trial?.rendererColdTargetSha256)
    && finiteNonNegative(trial?.freshProcessWallClockMs)
    && finiteNonNegative(trial?.harnessStartToWarmSequenceCompleteMs)
    && trial?.samplingStatus === expectedSamplingStatus
    && trial?.normalExit === true
    && trial?.rootExitCodeZero === true
    && trial?.residualProcessVerification
      === 'JOB_THREE_CONSECUTIVE_ZERO_POLLS'
    && Number.isSafeInteger(trial?.residualZeroPolls)
    && trial.residualZeroPolls >= 3
    && trial?.maximumResidualProcessCount === 0
    && trial?.residualQueryFailures === 0
    && trial?.finalProcessHistoryStatus
      === 'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO'
    && Number.isSafeInteger(trial?.finalKnownProcessIdentityCount)
    && trial.finalKnownProcessIdentityCount > 0
    && trial?.finalKnownProcessIdentityCount
      === trial?.finalJobTotalProcesses
    && trial?.finalJobActiveProcesses === 0
    && trial?.finalJobReportedAccountingActiveProcesses === 0
    && trial?.jobCleanupStatus === 'EMPTY_AND_HANDLES_CLOSED'
    && trial?.forcedKillCount === 0
    && validOutputCapture(trial?.outputCapture, configuration);
  const workloadValid = validWorkloadIdentity(workloadIdentity)
    && workloadIdentity.sampleIdentitySha256 === sha256(
      `${direction}\0${workloadIdentity.sourceChars}\0`
        + workloadIdentity.sourceSha256
    )
    && workloadIdentity.workloadConfigSha256 === sha256(JSON.stringify({
      schemaVersion: 'phase7-bergamot-fixed-workload-v1',
      runMode: 'DIRECTION_COLD_TRIAL',
      warmIterations: 5,
      routes: [{
        direction,
        sourceChars: workloadIdentity.sourceChars,
        sourceSha256: workloadIdentity.sourceSha256,
        sampleIdentitySha256: workloadIdentity.sampleIdentitySha256
      }]
    }));
  requireCondition(
    lifecycleValid,
    `${prefix}_PROCESS_LIFECYCLE_OR_CLEANUP_INVALID`,
    unmet
  );
  requireCondition(
    warmValid,
    `${prefix}_WARM_OBSERVATIONS_INVALID`,
    unmet
  );
  requireCondition(
    workloadValid,
    `${prefix}_WORKLOAD_IDENTITY_INVALID`,
    unmet
  );
  requireCondition(
    executableHashes.size > 0
      && [...executableHashes].every(validSha),
    `${prefix}_EXECUTABLE_IDENTITIES_INVALID`,
    unmet
  );

  return {
    direction,
    trialNumber,
    valid: rawSamplingValid
      && summaryMatchesRaw
      && lifecycleValid
      && warmValid
      && workloadValid
      && executableHashes.size > 0,
    validSampleCount: completeSamples.length,
    discardedSampleCount: discardedSamples,
    transitionSampleCount: transitionSamples.length,
    transitionGapCount: transitionGapSummary.gaps.length,
    transitionGapTotalMs: transitionGapSummary.totalDurationMs,
    maximumAdjacentValidSampleGapMs:
      transitionGapSummary.maximumAdjacentValidSampleGapMs,
    processQueryFailures,
    peakBytes,
    budgetStatus,
    workloadIdentity
  };
}

function validateLogicalSample(sample, expectedNumber) {
  const commonValid = isRecord(sample)
    && sample.sample === expectedNumber
    && finiteNonNegative(sample.startElapsedMs)
    && finiteNonNegative(sample.endElapsedMs)
    && sample.endElapsedMs >= sample.startElapsedMs
    && finiteNonNegative(sample.spanMs)
    && approximatelyEqual(
      sample.spanMs,
      sample.endElapsedMs - sample.startElapsedMs
    )
    && finiteNonNegative(sample.jobMemberQueryMs)
    && sample.jobMemberQueryMs <= sample.spanMs + NUMBER_TOLERANCE
    && finiteNonNegative(sample.maximumProcessQuerySkewMs)
    && Array.isArray(sample.processQueries)
    && Number.isSafeInteger(sample.transitionInternalMeasurementFailureCount)
    && sample.transitionInternalMeasurementFailureCount >= 0;
  const processQueries = Array.isArray(sample?.processQueries)
    ? sample.processQueries
    : [];
  const ordinals = new Set();
  const executableHashes = new Set();
  let processQueryFailures = 0;
  let privateWorkingSetBytes = 0;
  const queryStarts = [];
  let processQueriesValid = true;
  for (const query of processQueries) {
    const complete = query?.status === 'COMPLETE';
    const failureStatusValid = [
      'OPEN_FAILED',
      'PRE_IDENTITY_OR_ACTIVE_MISMATCH',
      'PRE_JOB_BINDING_QUERY_FAILED',
      'PRE_JOB_BINDING_MISMATCH',
      'QUERY_FAILED',
      'POST_IDENTITY_OR_ACTIVE_MISMATCH',
      'POST_JOB_BINDING_QUERY_FAILED',
      'POST_JOB_BINDING_MISMATCH',
      'BUFFER_LIMIT_EXCEEDED'
    ].includes(query?.status);
    const queryValid = isRecord(query)
      && Number.isSafeInteger(query.processOrdinal)
      && query.processOrdinal > 0
      && !ordinals.has(query.processOrdinal)
      && validSha(query.executableSha256)
      && finiteNonNegative(query.startOffsetMs)
      && finiteNonNegative(query.endOffsetMs)
      && query.endOffsetMs >= query.startOffsetMs
      && query.endOffsetMs <= sample.spanMs + NUMBER_TOLERANCE
      && finiteNonNegative(query.durationMs)
      && approximatelyEqual(
        query.durationMs,
        query.endOffsetMs - query.startOffsetMs
      )
      && (complete || failureStatusValid)
      && (complete
        ? Number.isSafeInteger(query.privateWorkingSetBytes)
          && query.privateWorkingSetBytes >= 0
        : query.privateWorkingSetBytes === null);
    processQueriesValid &&= queryValid;
    if (!complete) processQueryFailures += 1;
    if (Number.isSafeInteger(query?.processOrdinal)) {
      ordinals.add(query.processOrdinal);
    }
    if (validSha(query?.executableSha256)) {
      executableHashes.add(query.executableSha256);
    }
    if (complete
        && Number.isSafeInteger(query?.privateWorkingSetBytes)
        && query.privateWorkingSetBytes >= 0) {
      privateWorkingSetBytes += query.privateWorkingSetBytes;
    }
    if (finiteNonNegative(query?.startOffsetMs)) {
      queryStarts.push(query.startOffsetMs);
    }
  }
  const derivedSkew = queryStarts.length < 2
    ? 0
    : Math.max(...queryStarts) - Math.min(...queryStarts);
  const skewValid = approximatelyEqual(
    sample?.maximumProcessQuerySkewMs,
    derivedSkew
  );
  const preOrdinals = Array.isArray(sample?.preProcessOrdinals)
    ? sample.preProcessOrdinals
    : [];
  const postOrdinals = Array.isArray(sample?.postProcessOrdinals)
    ? sample.postProcessOrdinals
    : [];
  const preSnapshotValid = validSnapshot({
    queryStatus: sample?.preJobQueryStatus,
    discoveryStatus: sample?.memberDiscoveryStatus,
    memberCount: sample?.memberCount,
    totalProcesses: sample?.jobTotalProcesses,
    activeProcesses: sample?.jobActiveProcesses,
    reportedAccountingActiveProcesses:
      sample?.jobReportedAccountingActiveProcesses,
    knownProcessIdentityCount: sample?.preKnownProcessIdentityCount,
    ordinals: preOrdinals
  });
  const postSnapshotValid = validSnapshot({
    queryStatus: sample?.postJobQueryStatus,
    discoveryStatus: sample?.membershipRevalidationStatus,
    memberCount: sample?.postMemberCount,
    totalProcesses: sample?.postJobTotalProcesses,
    activeProcesses: sample?.postJobActiveProcesses,
    reportedAccountingActiveProcesses:
      sample?.postJobReportedAccountingActiveProcesses,
    knownProcessIdentityCount: sample?.postKnownProcessIdentityCount,
    ordinals: postOrdinals
  });
  const queryOrdinals = processQueries.map(
    (query) => query?.processOrdinal
  );
  const postOrdinalSet = new Set(postOrdinals);
  const removedPreOrdinals = new Set(
    preOrdinals.filter((ordinal) => !postOrdinalSet.has(ordinal))
  );
  const transitionExitFailureStatuses = new Set([
    'OPEN_FAILED',
    'PRE_IDENTITY_OR_ACTIVE_MISMATCH',
    'POST_IDENTITY_OR_ACTIVE_MISMATCH'
  ]);
  const exactTransitionQueryFailuresBound = processQueries.every(
    (query) => query?.status === 'COMPLETE'
      || (
        transitionExitFailureStatuses.has(query?.status)
        && removedPreOrdinals.has(query?.processOrdinal)
      )
  );
  const boundActiveEntries = Array.isArray(
    sample?.transitionBoundActiveProcessEntries
  )
    ? sample.transitionBoundActiveProcessEntries
    : [];
  const boundActiveOrdinals = new Set();
  let boundActiveEntriesValid = true;
  for (const entry of boundActiveEntries) {
    const entryValid = isRecord(entry)
      && Number.isSafeInteger(entry.processOrdinal)
      && entry.processOrdinal > 0
      && !boundActiveOrdinals.has(entry.processOrdinal)
      && validSha(entry.executableSha256);
    boundActiveEntriesValid &&= entryValid;
    if (Number.isSafeInteger(entry?.processOrdinal)) {
      boundActiveOrdinals.add(entry.processOrdinal);
    }
    if (validSha(entry?.executableSha256)) {
      executableHashes.add(entry.executableSha256);
    }
  }
  const queriesMatchPreSnapshot = preSnapshotValid
    && processQueries.length === sample.memberCount
    && sameNumberSet(queryOrdinals, preOrdinals);
  const actualInternalFailures = processQueryFailures
    + (sample?.preJobQueryStatus === 'FAILED' ? 1 : 0)
    + (sample?.postJobQueryStatus === 'FAILED' ? 1 : 0);

  let valid = false;
  let kind = 'INVALID';
  let nonTransitionProcessQueryFailures = actualInternalFailures;
  if (sample?.status === 'COMPLETE') {
    kind = 'COMPLETE';
    valid = commonValid
      && processQueriesValid
      && skewValid
      && preSnapshotValid
      && postSnapshotValid
      && sample.memberCount > 0
      && sameNumberSet(preOrdinals, postOrdinals)
      && sample.jobTotalProcesses === sample.postJobTotalProcesses
      && sample.jobActiveProcesses === sample.postJobActiveProcesses
      && queriesMatchPreSnapshot
      && processQueryFailures === 0
      && sample.transitionInternalMeasurementFailureCount === 0
      && sample.transitionReason === null
      && sample.transitionVerificationStatus === 'NOT_VERIFIED'
      && transitionProbeFieldsNull(sample)
      && sample.privateWorkingSetBytes === privateWorkingSetBytes
      && privateWorkingSetBytes > 0;
    nonTransitionProcessQueryFailures = actualInternalFailures;
  } else if (sample?.status === 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
      && sample?.transitionReason === 'EXACT_ACTIVE_SET_CHANGED') {
    kind = 'TRANSITION';
    valid = commonValid
      && processQueriesValid
      && skewValid
      && preSnapshotValid
      && postSnapshotValid
      && queriesMatchPreSnapshot
      && !sameNumberSet(preOrdinals, postOrdinals)
      && sample.transitionVerificationStatus
        === 'VERIFIED_PRE_POST_COMPLETE_HISTORY_IDENTITY_SET_CHANGE'
      && sample.transitionInternalMeasurementFailureCount
        === actualInternalFailures
      && processQueryFailures === actualInternalFailures
      && exactTransitionQueryFailuresBound
      && transitionProbeFieldsNull(sample)
      && sample.privateWorkingSetBytes === null;
    nonTransitionProcessQueryFailures = 0;
  } else if (sample?.status === 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
      && sample?.transitionReason === 'BOUND_PROCESS_EXIT_ACCOUNTING_LAG') {
    kind = 'TRANSITION';
    const preStateValid = sample?.preJobQueryStatus === 'COMPLETE'
      ? preSnapshotValid && queriesMatchPreSnapshot
      : sample?.preJobQueryStatus === 'FAILED'
        && sample?.memberCount === 0
        && sample?.memberDiscoveryStatus === 'NOT_AVAILABLE'
        && sample?.jobTotalProcesses === null
        && sample?.jobActiveProcesses === null
        && sample?.jobReportedAccountingActiveProcesses === null
        && sample?.preKnownProcessIdentityCount === null
        && preOrdinals.length === 0
        && processQueries.length === 0;
    const postStateValid = sample?.postJobQueryStatus === 'COMPLETE'
      ? postSnapshotValid
      : ['FAILED', 'NOT_RUN'].includes(sample?.postJobQueryStatus)
        && sample?.postMemberCount === null
        && sample?.postJobTotalProcesses === null
        && sample?.postJobActiveProcesses === null
        && sample?.postJobReportedAccountingActiveProcesses === null
        && sample?.postKnownProcessIdentityCount === null
        && postOrdinals.length === 0
        && sample?.membershipRevalidationStatus
          === (sample?.postJobQueryStatus === 'FAILED'
            ? 'FAILED'
            : 'NOT_RUN');
    const transitionAccountingValid =
      sample?.transitionVerificationStatus
        === 'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
      && Number.isSafeInteger(sample?.transitionTotalProcessesBefore)
      && sample.transitionTotalProcessesBefore > 0
      && sample?.transitionTotalProcessesAfter
        === sample.transitionTotalProcessesBefore
      && Number.isSafeInteger(
        sample?.transitionAccountingActiveProcessesBefore
      )
      && sample.transitionAccountingActiveProcessesBefore > 0
      && sample?.transitionAccountingActiveProcessesAfter
        === sample.transitionAccountingActiveProcessesBefore
      && Number.isSafeInteger(sample?.transitionBoundActiveProcesses)
      && sample.transitionBoundActiveProcesses >= 0
      && sample.transitionBoundActiveProcesses
        < sample.transitionAccountingActiveProcessesAfter
      && Number.isSafeInteger(
        sample?.transitionKnownProcessIdentityCount
      )
      && sample.transitionKnownProcessIdentityCount
        === sample.transitionTotalProcessesBefore
      && sample.transitionBoundActiveProcesses
        <= sample.transitionKnownProcessIdentityCount
      && boundActiveEntriesValid
      && boundActiveEntries.length
        === sample.transitionBoundActiveProcesses
      && processQueries.every(
        (query) => query?.status === 'COMPLETE'
          || (
            transitionExitFailureStatuses.has(query?.status)
            && !boundActiveOrdinals.has(query?.processOrdinal)
          )
      );
    valid = commonValid
      && processQueriesValid
      && skewValid
      && preStateValid
      && postStateValid
      && transitionAccountingValid
      && sample.transitionInternalMeasurementFailureCount
        === actualInternalFailures
      && sample.privateWorkingSetBytes === null;
    nonTransitionProcessQueryFailures = 0;
  }
  return {
    valid,
    kind,
    nonTransitionProcessQueryFailures,
    privateWorkingSetBytes,
    memberCount: Math.max(
      Number.isSafeInteger(sample?.memberCount) ? sample.memberCount : 0,
      Number.isSafeInteger(sample?.postMemberCount)
        ? sample.postMemberCount
        : 0,
      Number.isSafeInteger(sample?.transitionBoundActiveProcesses)
        ? sample.transitionBoundActiveProcesses
        : 0
    ),
    executableHashes
  };
}

function validSnapshot({
  queryStatus,
  discoveryStatus,
  memberCount,
  totalProcesses,
  activeProcesses,
  reportedAccountingActiveProcesses,
  knownProcessIdentityCount,
  ordinals
}) {
  const accountingSemanticsValid = discoveryStatus
    === 'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES'
    ? Number.isSafeInteger(reportedAccountingActiveProcesses)
      && reportedAccountingActiveProcesses > activeProcesses
      && reportedAccountingActiveProcesses <= totalProcesses
    : reportedAccountingActiveProcesses === activeProcesses;
  return queryStatus === 'COMPLETE'
    && COMPLETE_DISCOVERY_STATUSES.includes(discoveryStatus)
    && Number.isSafeInteger(memberCount)
    && memberCount >= 0
    && Number.isSafeInteger(totalProcesses)
    && totalProcesses >= memberCount
    && Number.isSafeInteger(activeProcesses)
    && activeProcesses === memberCount
    && accountingSemanticsValid
    && Number.isSafeInteger(knownProcessIdentityCount)
    && knownProcessIdentityCount === totalProcesses
    && validOrdinalArray(ordinals, memberCount);
}

function validOrdinalArray(value, expectedLength) {
  return Array.isArray(value)
    && value.length === expectedLength
    && value.every(
      (ordinal) => Number.isSafeInteger(ordinal) && ordinal > 0
    )
    && new Set(value).size === value.length;
}

function sameNumberSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function transitionProbeFieldsNull(sample) {
  return [
    'transitionTotalProcessesBefore',
    'transitionTotalProcessesAfter',
    'transitionAccountingActiveProcessesBefore',
    'transitionAccountingActiveProcessesAfter',
    'transitionBoundActiveProcesses',
    'transitionKnownProcessIdentityCount',
    'transitionBoundActiveProcessEntries'
  ].every((key) => sample?.[key] === null);
}

function deriveMembershipTransitionGaps(samples) {
  const completeSamples = samples.filter(
    (sample) => sample?.status === 'COMPLETE'
  );
  const validStartGaps = completeSamples.slice(1).map(
    (sample, index) => (
      sample.startElapsedMs - completeSamples[index].startElapsedMs
    )
  );
  const gaps = [];
  let boundedByCompleteSamples = true;
  let cursor = 0;
  while (cursor < samples.length) {
    if (samples[cursor]?.status
        !== 'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
      cursor += 1;
      continue;
    }
    const first = cursor;
    while (cursor + 1 < samples.length
        && samples[cursor + 1]?.status
          === 'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
      cursor += 1;
    }
    const last = cursor;
    const previous = first - 1;
    const next = last + 1;
    if (previous < 0
        || next >= samples.length
        || samples[previous]?.status !== 'COMPLETE'
        || samples[next]?.status !== 'COMPLETE') {
      boundedByCompleteSamples = false;
      cursor += 1;
      continue;
    }
    const durationMs = round3(
      samples[next].startElapsedMs - samples[previous].endElapsedMs
    );
    const adjacentValidStartGapMs = round3(
      samples[next].startElapsedMs - samples[previous].startElapsedMs
    );
    if (durationMs < 0 || adjacentValidStartGapMs < 0) {
      boundedByCompleteSamples = false;
    }
    gaps.push({
      firstTransitionSample: samples[first].sample,
      lastTransitionSample: samples[last].sample,
      transitionSampleCount: last - first + 1,
      previousValidSample: samples[previous].sample,
      nextValidSample: samples[next].sample,
      durationMs,
      adjacentValidStartGapMs,
      reasonCodes: [...new Set(
        samples.slice(first, last + 1).map(
          (sample) => sample.transitionReason
        )
      )].sort()
    });
    cursor += 1;
  }
  return {
    boundedByCompleteSamples,
    maximumAdjacentValidSampleGapMs: validStartGaps.length === 0
      ? 0
      : round3(Math.max(...validStartGaps)),
    totalDurationMs: round3(gaps.reduce(
      (total, gap) => total + gap.durationMs,
      0
    )),
    gaps
  };
}

export function isTransitionGapCadenceAccepted(gaps, configuration) {
  return Array.isArray(gaps) && gaps.every((gap) => (
    Array.isArray(gap?.reasonCodes)
      && gap.reasonCodes.includes('EXACT_ACTIVE_SET_CHANGED')
      ? gap.adjacentValidStartGapMs
        <= Number(configuration?.maximumAdjacentValidSampleGapMilliseconds)
      : Array.isArray(gap?.reasonCodes)
        && gap.reasonCodes.length === 1
        && gap.reasonCodes[0] === 'BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
        && gap.adjacentValidStartGapMs <= Number(
          configuration?.maximumExitOnlyAdjacentValidSampleGapMilliseconds
        )
  ));
}

function transitionGapSummariesEqual(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((gap, index) => {
      const derived = expected[index];
      return gap?.firstTransitionSample === derived.firstTransitionSample
        && gap?.lastTransitionSample === derived.lastTransitionSample
        && gap?.transitionSampleCount === derived.transitionSampleCount
        && gap?.previousValidSample === derived.previousValidSample
        && gap?.nextValidSample === derived.nextValidSample
        && approximatelyEqual(gap?.durationMs, derived.durationMs)
        && approximatelyEqual(
          gap?.adjacentValidStartGapMs,
          derived.adjacentValidStartGapMs
        )
        && sameStringSet(gap?.reasonCodes, derived.reasonCodes);
    });
}

function derivePrivateWorkingSetBudgetStatus(
  peakBytes,
  transitionSampleCount,
  configuration
) {
  if (!Number.isSafeInteger(peakBytes) || peakBytes < 1) {
    return 'NOT_EVALUATED';
  }
  if (peakBytes > Number(configuration?.privateWorkingSetBudgetBytes)) {
    return 'FAIL_BUDGET_EXCEEDED';
  }
  if (transitionSampleCount > 0) {
    if (peakBytes <= Number(configuration?.transitionReservePassBytes)) {
      return 'PASS_WITH_TRANSITION_RESERVE';
    }
    return 'INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET';
  }
  return 'PASS_CONTINUOUS_SAMPLING';
}

function validateDirectionTrials(
  direction,
  trials,
  aggregate,
  reportWorkloadIdentity,
  unmet
) {
  const prefix = `COLD_PWS:${direction}`;
  requireCondition(
    trials.length >= MIN_COLD_TRIALS_PER_DIRECTION,
    `${prefix}_FRESH_PROCESS_TRIAL_COUNT_BELOW_MINIMUM`,
    unmet
  );
  const trialNumbers = new Set(trials.map((trial) => trial.trialNumber));
  requireCondition(
    trialNumbers.size === trials.length
      && [...trialNumbers].every(
        (value) => Number.isSafeInteger(value) && value > 0
      ),
    `${prefix}_DUPLICATE_OR_INVALID_TRIAL_NUMBER`,
    unmet
  );
  const failures = trials.filter((trial) => !trial.valid).length;
  requireCondition(
    failures === 0,
    `${prefix}_COLD_WARM_OR_CLEANUP_FAILURE_PRESENT`,
    unmet
  );
  requireCondition(
    validWorkloadIdentity(reportWorkloadIdentity)
      && trials.every(
        (trial) => workloadIdentityEqual(
          trial.workloadIdentity,
          reportWorkloadIdentity
        )
      ),
    `${prefix}_WORKLOAD_HASH_OR_LENGTH_DRIFT`,
    unmet
  );
  requireCondition(
    aggregate?.requestedTrials === trials.length
      && aggregate?.successfulTrials === trials.length - failures
      && aggregate?.failures === failures
      && aggregate?.coldAndPrivateWorkingSetFailures === failures
    && aggregate?.warm?.requestedObservations === trials.length * 5
    && aggregate?.warm?.successfulObservations === trials.length * 5
    && aggregate?.warm?.failures === 0
    && aggregate?.verifiedMembershipTransitionSamples === safeSum(
      trials.map((trial) => trial.transitionSampleCount)
    )
    && aggregate?.verifiedMembershipTransitionGaps === safeSum(
      trials.map((trial) => trial.transitionGapCount)
    )
    && approximatelyEqual(
      aggregate?.verifiedMembershipTransitionGapTotalMs,
      trials.reduce(
        (total, trial) => total + trial.transitionGapTotalMs,
        0
      )
    )
    && aggregate?.transitionReservePassTrials === trials.filter(
      (trial) => trial.budgetStatus === 'PASS_WITH_TRANSITION_RESERVE'
    ).length,
    `${prefix}_AGGREGATE_COUNTS_NOT_DERIVED`,
    unmet
  );
}

function validateTotals(
  totals,
  trialCount,
  failures,
  forcedKills,
  warmFailures,
  transitionSamples,
  transitionGaps,
  unmet
) {
  requireCondition(
    totals?.requestedTrials === trialCount
      && totals?.successfulTrials === trialCount - failures
      && totals?.failures === failures
      && totals?.coldAndPrivateWorkingSetFailures === failures
      && totals?.warmFailures === warmFailures
      && totals?.forcedKillCount === forcedKills
      && totals?.verifiedMembershipTransitionSamples
        === transitionSamples
      && totals?.verifiedMembershipTransitionGaps === transitionGaps,
    'COLD_PWS_TOTALS_NOT_DERIVED_FROM_RAW_TRIALS',
    unmet
  );
}

function validOutputCapture(capture, configuration) {
  return capture?.mode === 'BOUNDED_CREATE_NEW_FILES_NO_PIPES'
    && Number.isSafeInteger(capture?.stdoutBytes)
    && capture.stdoutBytes >= 0
    && Number.isSafeInteger(capture?.stderrBytes)
    && capture.stderrBytes >= 0
    && capture?.maximumBytesPerStream === configuration?.maximumCaptureBytes
    && capture.stdoutBytes <= capture.maximumBytesPerStream
    && capture.stderrBytes <= capture.maximumBytesPerStream
    && capture?.readTimeoutMilliseconds
      === configuration?.captureReadTimeoutMilliseconds;
}

function validWarmObservation(observation) {
  return finiteNonNegative(observation?.translationOnlyMs)
    && Number.isSafeInteger(observation?.targetChars)
    && observation.targetChars > 0
    && validSha(observation?.targetSha256);
}

function validWorkloadIdentity(identity) {
  return isRecord(identity)
    && Number.isSafeInteger(identity.sourceChars)
    && identity.sourceChars > 0
    && validSha(identity.sourceSha256)
    && validSha(identity.sampleIdentitySha256)
    && validSha(identity.workloadConfigSha256);
}

function workloadIdentityEqual(left, right) {
  return validWorkloadIdentity(left)
    && validWorkloadIdentity(right)
    && left.sourceChars === right.sourceChars
    && left.sourceSha256 === right.sourceSha256
    && left.sampleIdentitySha256 === right.sampleIdentitySha256
    && left.workloadConfigSha256 === right.workloadConfigSha256;
}

function deriveBlindEvidence(report, candidateGenerations, unmet) {
  const aiReview =
    report?.schemaVersion === 'phase7-ai-blind-eval-report-v1';
  const prefix = aiReview ? 'AI_BLIND' : 'HUMAN_BLIND';
  const validReviewScore = aiReview ? validAiScore : validHumanScore;
  requireCondition(
    aiReview
      || report?.schemaVersion === 'phase7-blind-eval-report-v2',
    `${prefix}_SCHEMA_UNSUPPORTED`,
    unmet
  );
  requireCondition(
    report?.status === (
      aiReview
        ? 'AI_BLIND_QUALITY_EVALUATION_COMPONENT_COMPLETE'
        : 'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE'
    ),
    `${prefix}_STATUS_NOT_COMPLETE`,
    unmet
  );
  requireCondition(
    report?.scope === 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    `${prefix}_SCOPE_INVALID`,
    unmet
  );
  requireCondition(
    (
      aiReview
        ? (
          report?.aiOnly === true
          && report?.assessmentMode === 'AI_MODEL_BLIND_REVIEW'
          && report?.method?.humanReviewClaimed === false
          && report?.assessor?.assessorType === 'AI_LANGUAGE_MODEL'
          && report?.assessor?.candidateIdentityViewed === false
        )
        : report?.humanOnly === true
    )
      && report?.blindCandidateIdentity === true,
    `${prefix}_ASSESSOR_OR_BLIND_ATTESTATION_MISSING`,
    unmet
  );
  requireCondition(
    report?.audit?.randomizedMappingVerified === true
      && report?.audit?.candidateIdentityWithheldFromReviewBatch === true,
    `${prefix}_RANDOMIZATION_AUDIT_INCOMPLETE`,
    unmet
  );
  for (const key of [
    'manifestSha256',
    'inputSha256',
    'reviewBatchSha256',
    'scoreTemplateSha256',
    'privateAnswerKeySha256',
    'rawScoresSha256',
    'candidateGenerationBindingSetSha256'
  ]) {
    requireCondition(
      validSha(report?.audit?.[key]),
      `${prefix}_AUDIT_HASH_MISSING:${key}`,
      unmet
    );
  }
  if (aiReview) {
    requireCondition(
      validSha(report?.audit?.aiDecisionsSha256),
      `${prefix}_AUDIT_HASH_MISSING:aiDecisionsSha256`,
      unmet
    );
  }
  requireCondition(
    exactKeys(
      report?.audit?.candidateOutputItemIdentitySetSha256ByDirection,
      DIRECTIONS
    )
      && DIRECTIONS.every((direction) => validSha(
      report.audit.candidateOutputItemIdentitySetSha256ByDirection[
          direction
        ]
      )),
    `${prefix}_REVIEWED_ITEM_SET_HASHES_INVALID`,
    unmet
  );
  const generationBindings = validateCandidateGenerationBindings(
    report?.candidateGenerationBindings,
    candidateGenerations,
    `${prefix}_CANDIDATE_GENERATION`,
    unmet
  );
  requireCondition(
    report?.audit?.candidateGenerationBindingSetSha256
      === candidateBindingSetSha256(generationBindings)
      && report?.audit?.candidateGenerationBindingSetSha256
        === candidateGenerations?.bindingSetSha256,
    `${prefix}_CANDIDATE_GENERATION_BINDING_SET_SHA256_MISMATCH`,
    unmet
  );
  const rawScores = Array.isArray(report?.rawScores) ? report.rawScores : [];
  const directionReports = Array.isArray(report?.directions)
    ? report.directions
    : [];
  for (const direction of DIRECTIONS) {
    const directionScores = rawScores.filter(
      (score) => score?.direction === direction
    );
    const candidateReports = directionReports.find(
      (entry) => entry?.direction === direction
    )?.candidates;
    const directionBinding = generationBindings.find(
      (binding) => binding.direction === direction
    );
    requireCondition(
      report?.audit?.candidateOutputItemIdentitySetSha256ByDirection
        ?.[direction]
        === directionBinding?.candidateOutputItemIdentitySetSha256,
      `${prefix}_REVIEWED_ITEM_SET_CANDIDATE_OUTPUT_MISMATCH:${direction}`,
      unmet
    );
    requireCondition(
      directionScores.length >= MIN_BLIND_REVIEWS_PER_DIRECTION,
      `${prefix}_RAW_SCORE_COUNT_BELOW_MINIMUM:${direction}`,
      unmet
    );
    requireCondition(
      directionScores.every(validReviewScore),
      `${prefix}_RAW_SCORE_ATTESTATION_INVALID:${direction}`,
      unmet
    );
    requireCondition(
      directionScores.every((score) => (
        score?.candidateId === directionBinding?.candidateId
        && score?.generationRunId === directionBinding?.generationRunId
        && score?.generationIdentitySha256
          === directionBinding?.generationIdentitySha256
      )),
      `${prefix}_RAW_SCORE_GENERATION_BINDING_MISMATCH:${direction}`,
      unmet
    );
    const rawCandidateIds = new Set(
      directionScores.map((score) => score?.candidateId)
    );
    requireCondition(
      Array.isArray(candidateReports)
        && candidateReports.length === rawCandidateIds.size
        && candidateReports.length > 0,
      `${prefix}_CANDIDATE_SET_NOT_DERIVED:${direction}`,
      unmet
    );
    for (const candidate of candidateReports ?? []) {
      const rawCandidateScores = directionScores.filter(
        (score) => score?.candidateId === candidate?.candidateId
      );
      const uniqueItems = new Set(
        rawCandidateScores.map((score) => score?.itemToken)
      );
      requireCondition(
        rawCandidateIds.has(candidate?.candidateId)
          && candidate?.candidateId === directionBinding?.candidateId
          && sameStringSet(
            candidate?.generationRunIds,
            [directionBinding?.generationRunId]
          )
          && candidate?.generationIdentitySha256
            === directionBinding?.generationIdentitySha256
          && rawCandidateScores.length >= MIN_BLIND_REVIEWS_PER_DIRECTION
          && uniqueItems.size === rawCandidateScores.length
          && candidate?.validN === rawCandidateScores.length
          && candidate?.uniqueItemN === uniqueItems.size
          && candidate?.pendingN === 0,
        `${prefix}_CANDIDATE_COUNTS_NOT_DERIVED:${direction}`,
        unmet
      );
      if (aiReview) {
        requireCondition(
          candidate?.blindEvaluationEvidence?.aiReviewed === true
            && candidate?.blindEvaluationEvidence?.humanReviewed === false
            && candidate?.blindEvaluationEvidence?.componentStatus
              === 'AI_BLIND_QUALITY_EVALUATION_COMPONENT_COMPLETE',
          `${prefix}_CANDIDATE_AI_ATTESTATION_INVALID:${direction}`,
          unmet
        );
      }
    }
  }
  requireCondition(
    report?.counts?.[
      aiReview ? 'validAiReviewCount' : 'validHumanReviewCount'
    ] === rawScores.length,
    `${prefix}_TOTAL_VALID_REVIEW_COUNT_MISMATCH`,
    unmet
  );
  requireCondition(
    report?.counts?.[
      aiReview ? 'pendingAiReviewCount' : 'pendingHumanReviewCount'
    ] === 0,
    `${prefix}_PENDING_REVIEWS_PRESENT`,
    unmet
  );
  requireCondition(
    rawScores.every(validReviewScore),
    `${prefix}_RAW_SCORE_ATTESTATION_INVALID`,
    unmet
  );
  requireCondition(
    new Set(rawScores.map((score) => score?.evaluationId)).size
      === rawScores.length,
    `${prefix}_DUPLICATE_EVALUATION_ID`,
    unmet
  );
  return {
    schemaVersion: report?.schemaVersion ?? null,
    status: report?.status ?? null,
    manifestSha256: candidateGenerations?.manifestSha256 ?? null,
    blindEvaluationManifestSha256:
      report?.audit?.manifestSha256 ?? null,
    candidateGenerationBindingSetSha256:
      report?.audit?.candidateGenerationBindingSetSha256 ?? null,
    rawScoreCount: rawScores.length,
    assessmentType: aiReview ? 'AI_REVIEW' : 'HUMAN_REVIEW',
    validAiReviewCount:
      report?.counts?.validAiReviewCount ?? null,
    validHumanReviewCount:
      report?.counts?.validHumanReviewCount ?? null
  };
}

function validAiScore(score) {
  return score?.schemaVersion === 'phase7-ai-blind-eval-score-v1'
    && score?.status === 'AI_REVIEWED'
    && typeof score?.evaluationId === 'string'
    && score.evaluationId.length > 0
    && typeof score?.candidateId === 'string'
    && score.candidateId.length > 0
    && typeof score?.generationRunId === 'string'
    && score.generationRunId.length > 0
    && validSha(score?.generationIdentitySha256)
    && typeof score?.itemToken === 'string'
    && score.itemToken.length > 0
    && typeof score?.assessorToken === 'string'
    && score.assessorToken.startsWith('ai-assessor-')
    && score?.reviewMode === 'AI_MODEL_BLIND_REVIEW'
    && score?.blindnessAttestation === 'CANDIDATE_IDENTITY_NOT_VIEWED'
    && score?.aiReviewAttestation
      === 'AI_MODEL_ASSESSED_SOURCE_REFERENCE_AND_CANDIDATE_OUTPUT'
    && !Object.hasOwn(score, 'humanReviewAttestation')
    && Number.isInteger(score?.adequacyScore)
    && score.adequacyScore >= 1
    && score.adequacyScore <= 5
    && Number.isInteger(score?.fluencyScore)
    && score.fluencyScore >= 1
    && score.fluencyScore <= 5
    && ['ACCEPTABLE', 'UNACCEPTABLE'].includes(score?.acceptability)
    && isRecord(score?.errors)
    && [
      'severeMistranslation',
      'untranslated',
      'garbled',
      'properNounError',
      'longSentenceError'
    ].every((key) => typeof score.errors[key] === 'boolean')
    && (
      score.acceptability === 'ACCEPTABLE'
        ? Object.values(score.errors).every((value) => value === false)
        : Object.values(score.errors).some((value) => value === true)
    );
}

function validHumanScore(score) {
  return typeof score?.evaluationId === 'string'
    && score.evaluationId.length > 0
    && typeof score?.candidateId === 'string'
    && score.candidateId.length > 0
    && typeof score?.generationRunId === 'string'
    && score.generationRunId.length > 0
    && validSha(score?.generationIdentitySha256)
    && typeof score?.itemToken === 'string'
    && score.itemToken.length > 0
    && score?.reviewMode === 'HUMAN_ONLY_NO_AUTOMATED_SCORING'
    && score?.blindnessAttestation === 'CANDIDATE_IDENTITY_NOT_VIEWED'
    && score?.humanReviewAttestation
      === 'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING'
    && isRecord(score?.errors)
    && [
      'severeMistranslation',
      'untranslated',
      'garbled',
      'properNounError',
      'longSentenceError'
    ].every((key) => typeof score.errors[key] === 'boolean');
}

function derivePrimaryEvidenceSetSha256({
  cold,
  blind,
  authorization,
  candidateGenerations,
  harness,
  generationSummary
}) {
  if (!cold || !blind || !authorization || !candidateGenerations
      || !harness || !generationSummary) {
    return null;
  }
  return sha256Canonical({
    schemaVersion: 'phase7-gate-a-primary-evidence-set-v1',
    coldPwsSha256: cold.sha256,
    blindEvaluationSha256: blind.sha256,
    pocAuthorizationSha256: authorization.sha256,
    candidateGenerationSha256s:
      candidateGenerations.map((artifact) => artifact.sha256).sort(),
    candidateGenerationBindingSetSha256:
      generationSummary.bindingSetSha256,
    harnessFileSetSha256: harness.fileSetSha256
  });
}

function deriveLegalReviewEvidence(
  document,
  primaryEvidenceSetSha256,
  generationSummary,
  unmet
) {
  const prefix = 'LEGAL_REVIEW';
  requireCondition(
    exactKeys(document, [
      'schemaVersion',
      'status',
      'scope',
      'primaryEvidenceSetSha256',
      'candidateGenerationBindingSetSha256',
      'reviewedManifestSha256',
      'reviewedCandidateIds',
      'licenseNoticeSbomReviewComplete',
      'redistributionConclusion',
      'integrationOrDistributionAuthorized',
      'reviewedAt'
    ]),
    `${prefix}_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    document?.schemaVersion === 'phase7-gate-a-legal-review-v1'
      && document?.status
        === 'LEGAL_REVIEW_COMPLETE_FOR_GATE_A_DECISION'
      && document?.scope === POC_SCOPE
      && document?.licenseNoticeSbomReviewComplete === true
      && document?.redistributionConclusion
        === 'PERMITTED_FOR_PROPOSED_LIMITED_BETA'
      && document?.integrationOrDistributionAuthorized === false
      && validIsoDateTime(document?.reviewedAt),
    `${prefix}_STATUS_OR_ATTESTATION_INVALID`,
    unmet
  );
  validateAncillaryEvidenceBinding(
    document,
    primaryEvidenceSetSha256,
    generationSummary,
    prefix,
    unmet
  );
  requireCondition(
    document?.reviewedManifestSha256 === generationSummary?.manifestSha256
      && sameStringSet(
        document?.reviewedCandidateIds,
        generationSummary?.bindings?.map((binding) => binding.candidateId)
          ?? []
      ),
    `${prefix}_REVIEWED_CANDIDATE_SET_MISMATCH`,
    unmet
  );
  return {
    schemaVersion: document?.schemaVersion ?? null,
    status: document?.status ?? null,
    redistributionConclusion:
      document?.redistributionConclusion ?? null
  };
}

function deriveOsNetworkEvidence(
  document,
  capture,
  primaryEvidenceSetSha256,
  generationSummary,
  unmet
) {
  const prefix = 'OS_NETWORK_VERIFICATION';
  requireCondition(
    exactKeys(document, [
      'schemaVersion',
      'status',
      'scope',
      'primaryEvidenceSetSha256',
      'candidateGenerationBindingSetSha256',
      'method',
      'captureSha256',
      'captureSizeBytes',
      'observedExternalConnectionCount',
      'osLevelVerified',
      'rawTextEmitted',
      'integrationOrDistributionAuthorized',
      'verifiedAt'
    ]),
    `${prefix}_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    document?.schemaVersion
      === 'phase7-gate-a-os-network-verification-v1'
      && document?.status === 'OS_LEVEL_NO_EXTERNAL_TRAFFIC_OBSERVED'
      && document?.scope === POC_SCOPE
      && document?.method === 'WINDOWS_FIREWALL_AND_PACKET_CAPTURE'
      && document?.observedExternalConnectionCount === 0
      && document?.osLevelVerified === true
      && document?.rawTextEmitted === false
      && document?.integrationOrDistributionAuthorized === false
      && validIsoDateTime(document?.verifiedAt),
    `${prefix}_STATUS_OR_METHOD_INVALID`,
    unmet
  );
  validateAncillaryEvidenceBinding(
    document,
    primaryEvidenceSetSha256,
    generationSummary,
    prefix,
    unmet
  );
  requireCondition(
    capture !== null
      && document?.captureSha256 === capture?.sha256
      && Number.isSafeInteger(document?.captureSizeBytes)
      && document.captureSizeBytes > 0
      && document.captureSizeBytes
        === Buffer.byteLength(capture?.content ?? '', 'utf8'),
    `${prefix}_CAPTURE_NOT_BOUND_TO_RAW_ARTIFACT`,
    unmet
  );
  return {
    schemaVersion: document?.schemaVersion ?? null,
    status: document?.status ?? null,
    captureSha256: capture?.sha256 ?? null,
    captureSizeBytes: document?.captureSizeBytes ?? null
  };
}

function derivePackageSizingEvidence(
  document,
  primaryEvidenceSetSha256,
  generationSummary,
  unmet
) {
  const prefix = 'PACKAGE_SIZING';
  requireCondition(
    exactKeys(document, [
      'schemaVersion',
      'status',
      'scope',
      'primaryEvidenceSetSha256',
      'candidateGenerationBindingSetSha256',
      'baseInstaller',
      'coreModelPack',
      'limits',
      'integrationOrDistributionAuthorized',
      'measuredAt'
    ]),
    `${prefix}_SHAPE_INVALID`,
    unmet
  );
  requireCondition(
    document?.schemaVersion === 'phase7-gate-a-package-sizing-v1'
      && document?.status === 'FINAL_PACKAGE_SIZING_COMPLETE'
      && document?.scope === POC_SCOPE
      && document?.integrationOrDistributionAuthorized === false
      && validIsoDateTime(document?.measuredAt),
    `${prefix}_STATUS_OR_SCOPE_INVALID`,
    unmet
  );
  validateAncillaryEvidenceBinding(
    document,
    primaryEvidenceSetSha256,
    generationSummary,
    prefix,
    unmet
  );
  const base = document?.baseInstaller;
  const core = document?.coreModelPack;
  const limits = document?.limits;
  requireCondition(
    exactKeys(base, ['sha256', 'sizeBytes', 'containsModel'])
      && validSha(base?.sha256)
      && Number.isSafeInteger(base?.sizeBytes)
      && base.sizeBytes > 0
      && base.sizeBytes <= BASE_INSTALLER_LIMIT_BYTES
      && base?.containsModel === false,
    `${prefix}_BASE_INSTALLER_INVALID_OR_OVER_LIMIT`,
    unmet
  );
  requireCondition(
    exactKeys(core, [
      'sha256',
      'archiveSizeBytes',
      'installedSizeBytes',
      'candidateGenerationIdentitySha256s'
    ])
      && validSha(core?.sha256)
      && Number.isSafeInteger(core?.archiveSizeBytes)
      && core.archiveSizeBytes > 0
      && core.archiveSizeBytes <= CORE_PACK_HARD_LIMIT_BYTES
      && Number.isSafeInteger(core?.installedSizeBytes)
      && core.installedSizeBytes >= core.archiveSizeBytes
      && sameStringSet(
        core?.candidateGenerationIdentitySha256s,
        generationSummary?.bindings?.map(
          (binding) => binding.generationIdentitySha256
        ) ?? []
      ),
    `${prefix}_CORE_MODEL_PACK_INVALID_OR_OVER_LIMIT`,
    unmet
  );
  requireCondition(
    exactKeys(limits, [
      'baseInstallerMaximumBytes',
      'corePackTargetBytes',
      'corePackHardMaximumBytes',
      'customModelPathDecisionRequired'
    ])
      && limits?.baseInstallerMaximumBytes === BASE_INSTALLER_LIMIT_BYTES
      && limits?.corePackTargetBytes === CORE_PACK_TARGET_BYTES
      && limits?.corePackHardMaximumBytes === CORE_PACK_HARD_LIMIT_BYTES
      && limits?.customModelPathDecisionRequired
        === (core?.archiveSizeBytes > CORE_PACK_TARGET_BYTES),
    `${prefix}_LIMIT_POLICY_MISMATCH`,
    unmet
  );
  return {
    schemaVersion: document?.schemaVersion ?? null,
    status: document?.status ?? null,
    baseInstallerBytes: base?.sizeBytes ?? null,
    coreModelPackArchiveBytes: core?.archiveSizeBytes ?? null,
    coreModelPackInstalledBytes: core?.installedSizeBytes ?? null,
    customModelPathDecisionRequired:
      limits?.customModelPathDecisionRequired ?? null
  };
}

function validateAncillaryEvidenceBinding(
  document,
  primaryEvidenceSetSha256,
  generationSummary,
  prefix,
  unmet
) {
  requireCondition(
    validSha(primaryEvidenceSetSha256)
      && document?.primaryEvidenceSetSha256 === primaryEvidenceSetSha256,
    `${prefix}_PRIMARY_EVIDENCE_SET_MISMATCH`,
    unmet
  );
  requireCondition(
    document?.candidateGenerationBindingSetSha256
      === generationSummary?.bindingSetSha256,
    `${prefix}_CANDIDATE_GENERATION_BINDING_SET_MISMATCH`,
    unmet
  );
}

function readBoundJsonArtifact(value, label, unmet) {
  const raw = readBoundRawArtifact(value, label, unmet);
  if (!raw) return null;
  try {
    return { document: JSON.parse(raw.content), sha256: raw.sha256 };
  } catch {
    unmet.push(`${label}_JSON_PARSE_FAILED`);
    return null;
  }
}

function readBoundJsonArtifactCollection(value, label, unmet) {
  if (!Array.isArray(value) || value.length === 0) {
    unmet.push(`${label}_COLLECTION_MISSING_OR_EMPTY`);
    return null;
  }
  const artifacts = value.map((artifact, index) => (
    readBoundJsonArtifact(artifact, `${label}:${index + 1}`, unmet)
  ));
  if (artifacts.some((artifact) => artifact === null)) return null;
  const hashes = artifacts.map((artifact) => artifact.sha256);
  if (new Set(hashes).size !== hashes.length) {
    unmet.push(`${label}_DUPLICATE_ARTIFACT`);
  }
  return artifacts;
}

function readBoundRawArtifact(value, label, unmet) {
  if (!isRecord(value)
      || typeof value.content !== 'string'
      || !validSha(value.sha256)) {
    unmet.push(`${label}_MISSING_OR_UNBOUND`);
    return null;
  }
  const actual = sha256(value.content);
  if (actual !== value.sha256) {
    unmet.push(`${label}_SHA256_MISMATCH`);
    return null;
  }
  return { content: value.content, sha256: actual };
}

function readBoundSource(value, label, unmet) {
  const source = readBoundRawArtifact(value, label, unmet);
  if (!source) return null;
  return {
    sha256: source.sha256,
    sizeBytes: Buffer.byteLength(source.content, 'utf8')
  };
}

function distribution(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { n: 0, p50: null, p95: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: round3(sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)]),
    p95: round3(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]),
    max: round3(sorted.at(-1))
  };
}

function distributionEqual(actual, expected) {
  return isRecord(actual)
    && actual.n === expected.n
    && approximatelyEqual(actual.p50, expected.p50)
    && approximatelyEqual(actual.p95, expected.p95)
    && approximatelyEqual(actual.max, expected.max);
}

function approximatelyEqual(left, right) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= NUMBER_TOLERANCE;
}

function round3(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sha256Canonical(value) {
  return sha256(stableStringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function candidateBindingSetSha256(bindings) {
  return sha256Canonical(
    [...bindings].sort(compareCandidateBinding).map((binding) => ({
      direction: binding.direction,
      candidateId: binding.candidateId,
      generationRunId: binding.generationRunId,
      generationArtifactSha256: binding.generationArtifactSha256,
      generationIdentitySha256: binding.generationIdentitySha256,
      sourceSetIdentitySha256: binding.sourceSetIdentitySha256,
      sourceSetRecordCount: binding.sourceSetRecordCount,
      candidateOutputArtifactSha256:
        binding.candidateOutputArtifactSha256,
      candidateOutputItemIdentitySetSha256:
        binding.candidateOutputItemIdentitySetSha256
    }))
  );
}

function candidateBindingsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)
      || left.length !== right.length) {
    return false;
  }
  const leftSorted = [...left].sort(compareCandidateBinding);
  const rightSorted = [...right].sort(compareCandidateBinding);
  return leftSorted.every((binding, index) => (
    binding.direction === rightSorted[index]?.direction
    && binding.candidateId === rightSorted[index]?.candidateId
    && binding.generationRunId === rightSorted[index]?.generationRunId
    && binding.generationArtifactSha256
      === rightSorted[index]?.generationArtifactSha256
    && binding.generationIdentitySha256
      === rightSorted[index]?.generationIdentitySha256
    && binding.sourceSetIdentitySha256
      === rightSorted[index]?.sourceSetIdentitySha256
    && binding.sourceSetRecordCount
      === rightSorted[index]?.sourceSetRecordCount
    && binding.candidateOutputArtifactSha256
      === rightSorted[index]?.candidateOutputArtifactSha256
    && binding.candidateOutputItemIdentitySetSha256
      === rightSorted[index]?.candidateOutputItemIdentitySetSha256
  ));
}

function compareCandidateBinding(left, right) {
  return String(left?.direction).localeCompare(String(right?.direction))
    || String(left?.candidateId).localeCompare(String(right?.candidateId))
    || String(left?.generationRunId).localeCompare(
      String(right?.generationRunId)
    );
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && new Set(left).size === left.length
    && right.every((value) => left.includes(value));
}

function isMonotonic(values) {
  return values.every(
    (value, index) => index === 0 || value >= values[index - 1]
  );
}

function validSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validSafeId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value);
}

function validIsoDateTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value));
}

function uniqueNonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => (
      typeof item === 'string' && item.length > 0
    ))
    && new Set(value).size === value.length;
}

function exactKeys(value, expected) {
  return isRecord(value)
    && sameStringSet(Object.keys(value), expected);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function isRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function safeSum(values) {
  return values.every(
    (value) => Number.isSafeInteger(value) && value >= 0
  )
    ? values.reduce((total, value) => total + value, 0)
    : Number.NaN;
}

function requireCondition(condition, code, unmet) {
  if (!condition) unmet.push(code);
}

function unique(values) {
  return [...new Set(values)].sort();
}

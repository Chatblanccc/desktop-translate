import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  GATE_A_INPUT_INCOMPLETE,
  GATE_A_INPUT_NON_AUTHORIZING_SHAPE_CHECK,
  GATE_A_INPUT_READY,
  assertGateAInputReady,
  evaluateGateAInputCompleteness,
  isTransitionGapCadenceAccepted
} from './gate-a-completeness.mjs';

const sha = (value) => (
  createHash('sha256').update(value, 'utf8').digest('hex')
);
const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};
const shaCanonical = (value) => sha(stableStringify(value));
const artifact = (document) => {
  const content = JSON.stringify(document);
  return { content, sha256: sha(content) };
};
const hex = (character) => character.repeat(64);
const directions = ['en-zh', 'zh-en'];
const sourceContents = {
  coldPwsRunner: 'phase7-cold-pws-runner-source-fixture',
  coldPwsNative: 'phase7-cold-pws-native-source-fixture',
  electronMain: 'phase7-electron-main-source-fixture',
  electronLibrary: 'phase7-electron-library-source-fixture',
  electronRenderer: 'phase7-electron-renderer-source-fixture',
  candidateBindings: 'phase7-candidate-bindings-source-fixture'
};
const harnessDefinitions = [
  ['runner', 'coldPwsRunner', 'runnerSha256'],
  ['native', 'coldPwsNative', 'nativeSha256'],
  ['main', 'electronMain', 'electronMainSha256'],
  ['library', 'electronLibrary', 'electronLibrarySha256'],
  ['renderer', 'electronRenderer', 'electronRendererSha256'],
  ['bindings', 'candidateBindings', 'candidateBindingsSha256']
];
const harnessIdentity = {
  fileCount: harnessDefinitions.length,
  totalBytes: 0
};
const harnessLines = [];
for (const [fileSetKey, sourceKey, reportKey] of harnessDefinitions) {
  const content = sourceContents[sourceKey];
  const size = Buffer.byteLength(content, 'utf8');
  const digest = sha(content);
  harnessIdentity[reportKey] = digest;
  harnessIdentity.totalBytes += size;
  harnessLines.push(`${fileSetKey}\0${size}\0${digest}`);
}
harnessIdentity.fileSetSha256 = sha(`${harnessLines.join('\n')}\n`);

const authorizationContent = JSON.stringify({
  schemaVersion: 'phase7-offline-poc-authorization-v1',
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  basis: 'PHASE7_M0_USER_AUTHORIZATION',
  manifestSha256: hex('d'),
  candidateIds: ['candidate-en-zh', 'candidate-zh-en'],
  observedLicenseMetadataExpressions: ['TEST-ONLY-NO-DISTRIBUTION'],
  acknowledgedRiskCodes: ['SELF_TEST_FIXTURE_ONLY'],
  authorizationRecordId: 'phase7-gate-a-selftest-auth',
  authorizedAt: '2026-07-24T00:00:00.000Z'
});
const runnerConfiguration = {
  schemaVersion: 'phase7-offline-cold-pws-v3',
  directions,
  trialsPerDirection: 20,
  warmIterationsPerTrial: 5,
  sampleIntervalMilliseconds: 100,
  maximumLaunchToFirstSampleMilliseconds: 250,
  maximumCadenceMilliseconds: 250,
  maximumSampleSpanMilliseconds: 250,
  maximumProcessQuerySkewMilliseconds: 250,
  maximumVerifiedMembershipTransitionSamples: 8,
  maximumAdjacentValidSampleGapMilliseconds: 500,
  maximumExitOnlyAdjacentValidSampleGapMilliseconds: 1250,
  maximumTotalVerifiedTransitionGapMilliseconds: 1000,
  transitionReservePassBytes: 1_073_741_824,
  privateWorkingSetBudgetBytes: 1_181_116_006,
  minimumValidSamples: 10,
  minimumCoverageMilliseconds: 1000,
  trialTimeoutSeconds: 360,
  residualTimeoutSeconds: 10,
  residualPollMilliseconds: 200,
  postTerminateWaitMilliseconds: 5000,
  maximumCaptureBytes: 1_048_576,
  captureReadTimeoutMilliseconds: 5000,
  maximumFinalReportBytes: 67_108_864
};
assert.equal(isTransitionGapCadenceAccepted([{
  adjacentValidStartGapMs: 1200,
  reasonCodes: ['BOUND_PROCESS_EXIT_ACCOUNTING_LAG']
}], runnerConfiguration), true);
assert.equal(isTransitionGapCadenceAccepted([{
  adjacentValidStartGapMs: 501,
  reasonCodes: ['EXACT_ACTIVE_SET_CHANGED']
}], runnerConfiguration), false);
assert.equal(isTransitionGapCadenceAccepted([{
  adjacentValidStartGapMs: 100,
  reasonCodes: ['UNVERIFIED_TRANSITION']
}], runnerConfiguration), false);

const workloadIdentity = (direction) => {
  const sourceChars = direction === 'en-zh' ? 57 : 21;
  const sourceSha256 = direction === 'en-zh' ? hex('6') : hex('7');
  const sampleIdentitySha256 = sha(
    `${direction}\0${sourceChars}\0${sourceSha256}`
  );
  const workloadConfigSha256 = sha(JSON.stringify({
    schemaVersion: 'phase7-bergamot-fixed-workload-v1',
    runMode: 'DIRECTION_COLD_TRIAL',
    warmIterations: 5,
    routes: [{
      direction,
      sourceChars,
      sourceSha256,
      sampleIdentitySha256
    }]
  }));
  return {
    sourceChars,
    sourceSha256,
    sampleIdentitySha256,
    workloadConfigSha256
  };
};
const workloadByDirection = Object.fromEntries(
  directions.map((direction) => [direction, workloadIdentity(direction)])
);
const artifactIdentityFixture = {
  manifestSha256: hex('d'),
  materializedRuntimeTreeSha256: hex('e'),
  servedRuntimeTreeSha256: hex('f'),
  supplyTreeSha256ByDirection: {
    'en-zh': hex('1'),
    'zh-en': hex('2')
  },
  workloadIdentityByDirection: workloadByDirection
};
const candidateGenerationDocuments = directions.map((direction, index) => {
  const identity = {
    schemaVersion: 'phase7-gate-a-candidate-generation-identity-v1',
    direction,
    candidateId: `candidate-${direction}`,
    generationRunId: `generation-${direction}`,
    manifestSha256: artifactIdentityFixture.manifestSha256,
    authorizationSha256: sha(authorizationContent),
    authorizationRecordId: 'phase7-gate-a-selftest-auth',
    model: {
      treeSha256:
        artifactIdentityFixture.supplyTreeSha256ByDirection[direction]
    },
    runtime: {
      materializedTreeSha256:
        artifactIdentityFixture.materializedRuntimeTreeSha256,
      servedTreeSha256:
        artifactIdentityFixture.servedRuntimeTreeSha256
    },
    sourceSet: {
      schemaVersion: 'phase7-gate-a-source-set-v1',
      recordCount: 200,
      identitySha256: index === 0 ? hex('a') : hex('b')
    },
    workloadIdentitySha256: shaCanonical(workloadByDirection[direction])
  };
  return {
    schemaVersion: 'phase7-gate-a-candidate-generation-v1',
    status: 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE',
    scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    identity,
    identitySha256: shaCanonical(identity),
    candidateOutput: {
      artifactSha256: index === 0 ? hex('3') : hex('4'),
      recordCount: 200,
      itemIdentitySetSha256: index === 0 ? hex('5') : hex('6'),
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
});
const candidateGenerationArtifacts =
  candidateGenerationDocuments.map(artifact);
const candidateGenerationBindings = candidateGenerationDocuments.map(
  (document, index) => ({
    direction: document.identity.direction,
    candidateId: document.identity.candidateId,
    generationRunId: document.identity.generationRunId,
    generationArtifactSha256:
      candidateGenerationArtifacts[index].sha256,
    generationIdentitySha256: document.identitySha256,
    sourceSetIdentitySha256:
      document.identity.sourceSet.identitySha256,
    sourceSetRecordCount: document.identity.sourceSet.recordCount,
    candidateOutputArtifactSha256:
      document.candidateOutput.artifactSha256,
    candidateOutputItemIdentitySetSha256:
      document.candidateOutput.itemIdentitySetSha256
  })
).sort((left, right) => left.direction.localeCompare(right.direction));
const candidateGenerationBindingSetSha256 = shaCanonical(
  candidateGenerationBindings
);
artifactIdentityFixture.candidateGenerationBindingSetSha256 =
  candidateGenerationBindingSetSha256;
const logicalSamples = () => Array.from({ length: 13 }, (_, index) => {
  const startElapsedMs = 10 + (index * 100);
  const privateWorkingSetBytes = 4096 + index;
  const afterTransition = index >= 5;
  const totalProcesses = afterTransition ? 2 : 1;
  if (index === 3) {
    return {
      sample: index + 1,
      startElapsedMs,
      endElapsedMs: startElapsedMs + 1,
      spanMs: 1,
      jobMemberQueryMs: 0.1,
      preJobQueryStatus: 'COMPLETE',
      postJobQueryStatus: 'COMPLETE',
      memberCount: 1,
      memberDiscoveryStatus: 'COMPLETE_PROCESS_ID_LIST',
      membershipRevalidationStatus: 'COMPLETE_PROCESS_ID_LIST',
      jobTotalProcesses: 1,
      jobActiveProcesses: 1,
      jobReportedAccountingActiveProcesses: 1,
      preKnownProcessIdentityCount: 1,
      postMemberCount: 2,
      postJobTotalProcesses: 2,
      postJobActiveProcesses: 2,
      postJobReportedAccountingActiveProcesses: 2,
      postKnownProcessIdentityCount: 2,
      preProcessOrdinals: [1],
      postProcessOrdinals: [1, 2],
      maximumProcessQuerySkewMs: 0,
      status: 'VERIFIED_MEMBERSHIP_TRANSITION_GAP',
      transitionReason: 'EXACT_ACTIVE_SET_CHANGED',
      transitionVerificationStatus:
        'VERIFIED_PRE_POST_COMPLETE_HISTORY_IDENTITY_SET_CHANGE',
      transitionInternalMeasurementFailureCount: 0,
      transitionTotalProcessesBefore: null,
      transitionTotalProcessesAfter: null,
      transitionAccountingActiveProcessesBefore: null,
      transitionAccountingActiveProcessesAfter: null,
      transitionBoundActiveProcesses: null,
      transitionKnownProcessIdentityCount: null,
      transitionBoundActiveProcessEntries: null,
      privateWorkingSetBytes: null,
      processQueries: [{
        processOrdinal: 1,
        executableSha256: hex('8'),
        startOffsetMs: 0.2,
        endOffsetMs: 0.7,
        durationMs: 0.5,
        status: 'COMPLETE',
        privateWorkingSetBytes
      }]
    };
  }
  if (index === 4) {
    return {
      sample: index + 1,
      startElapsedMs,
      endElapsedMs: startElapsedMs + 1,
      spanMs: 1,
      jobMemberQueryMs: 0.1,
      preJobQueryStatus: 'COMPLETE',
      postJobQueryStatus: 'FAILED',
      memberCount: 2,
      memberDiscoveryStatus: 'COMPLETE_PROCESS_ID_LIST',
      membershipRevalidationStatus: 'FAILED',
      jobTotalProcesses: 2,
      jobActiveProcesses: 2,
      jobReportedAccountingActiveProcesses: 2,
      preKnownProcessIdentityCount: 2,
      postMemberCount: null,
      postJobTotalProcesses: null,
      postJobActiveProcesses: null,
      postJobReportedAccountingActiveProcesses: null,
      postKnownProcessIdentityCount: null,
      preProcessOrdinals: [1, 2],
      postProcessOrdinals: [],
      maximumProcessQuerySkewMs: 0.3,
      status: 'VERIFIED_MEMBERSHIP_TRANSITION_GAP',
      transitionReason: 'BOUND_PROCESS_EXIT_ACCOUNTING_LAG',
      transitionVerificationStatus:
        'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG',
      transitionInternalMeasurementFailureCount: 2,
      transitionTotalProcessesBefore: 2,
      transitionTotalProcessesAfter: 2,
      transitionAccountingActiveProcessesBefore: 2,
      transitionAccountingActiveProcessesAfter: 2,
      transitionBoundActiveProcesses: 1,
      transitionKnownProcessIdentityCount: 2,
      transitionBoundActiveProcessEntries: [{
        processOrdinal: 1,
        executableSha256: hex('8')
      }],
      privateWorkingSetBytes: null,
      processQueries: [{
        processOrdinal: 1,
        executableSha256: hex('8'),
        startOffsetMs: 0.2,
        endOffsetMs: 0.4,
        durationMs: 0.2,
        status: 'COMPLETE',
        privateWorkingSetBytes
      }, {
        processOrdinal: 2,
        executableSha256: hex('8'),
        startOffsetMs: 0.5,
        endOffsetMs: 0.7,
        durationMs: 0.2,
        status: 'PRE_IDENTITY_OR_ACTIVE_MISMATCH',
        privateWorkingSetBytes: null
      }]
    };
  }
  const exitAccountingLagRecovery = index === 5;
  return {
    sample: index + 1,
    startElapsedMs,
    endElapsedMs: startElapsedMs + 1,
    spanMs: 1,
    jobMemberQueryMs: 0.1,
    preJobQueryStatus: 'COMPLETE',
    postJobQueryStatus: 'COMPLETE',
    memberCount: 1,
    memberDiscoveryStatus: exitAccountingLagRecovery
      ? 'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES'
      : 'COMPLETE_PROCESS_ID_LIST',
    membershipRevalidationStatus: exitAccountingLagRecovery
      ? 'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES'
      : 'COMPLETE_PROCESS_ID_LIST',
    jobTotalProcesses: totalProcesses,
    jobActiveProcesses: 1,
    jobReportedAccountingActiveProcesses:
      exitAccountingLagRecovery ? 2 : 1,
    preKnownProcessIdentityCount: totalProcesses,
    postMemberCount: 1,
    postJobTotalProcesses: totalProcesses,
    postJobActiveProcesses: 1,
    postJobReportedAccountingActiveProcesses:
      exitAccountingLagRecovery ? 2 : 1,
    postKnownProcessIdentityCount: totalProcesses,
    preProcessOrdinals: [1],
    postProcessOrdinals: [1],
    maximumProcessQuerySkewMs: 0,
    status: 'COMPLETE',
    transitionReason: null,
    transitionVerificationStatus: 'NOT_VERIFIED',
    transitionInternalMeasurementFailureCount: 0,
    transitionTotalProcessesBefore: null,
    transitionTotalProcessesAfter: null,
    transitionAccountingActiveProcessesBefore: null,
    transitionAccountingActiveProcessesAfter: null,
    transitionBoundActiveProcesses: null,
    transitionKnownProcessIdentityCount: null,
    transitionBoundActiveProcessEntries: null,
    privateWorkingSetBytes,
    processQueries: [{
      processOrdinal: 1,
      executableSha256: hex('8'),
      startOffsetMs: 0.2,
      endOffsetMs: 0.7,
      durationMs: 0.5,
      status: 'COMPLETE',
      privateWorkingSetBytes
    }]
  };
});
const trial = (direction, number) => {
  const warmObservations = Array.from({ length: 5 }, () => ({
    translationOnlyMs: 10,
    targetChars: 20,
    targetSha256: hex('9')
  }));
  const rendererColdTargetSha256 = hex('4');
  const harnessStartToWarmSequenceCompleteMs = 1150;
  const markerBinding = {
    direction,
    manifestSha256: artifactIdentityFixture.manifestSha256,
    supplyTreeSha256:
      artifactIdentityFixture.supplyTreeSha256ByDirection[direction],
    materializedRuntimeTreeSha256:
      artifactIdentityFixture.materializedRuntimeTreeSha256,
    servedRuntimeTreeSha256:
      artifactIdentityFixture.servedRuntimeTreeSha256,
    workloadConfigSha256:
      workloadByDirection[direction].workloadConfigSha256,
    sourceSha256: workloadByDirection[direction].sourceSha256,
    sampleIdentitySha256:
      workloadByDirection[direction].sampleIdentitySha256,
    targetSha256: rendererColdTargetSha256,
    warmTargetSha256: warmObservations.map(
      (observation) => observation.targetSha256
    ),
    harnessStartToWarmSequenceCompleteMs
  };
  return {
  direction,
  trial: number,
  status: 'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS',
  blockerCode: null,
  launchMode: 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME',
  jobPolicy: 'KILL_ON_JOB_CLOSE_NO_BREAKAWAY_FLAGS',
  freshProcessWallClockMs: 1200,
  childReportValidated: true,
  completionMarkerObserved: true,
  completionMarkerValidated: true,
  completionMarkerBindingSha256: sha(JSON.stringify(markerBinding)),
  workloadIdentity: workloadByDirection[direction],
  rendererFirstTranslationMs: 100,
  rendererColdRouteTotalMs: 110,
  rendererColdTargetSha256,
  harnessStartToWarmSequenceCompleteMs,
  warm: {
    iterationsRequested: 5,
    failures: 0,
    observations: warmObservations
  },
  privateWorkingSetPeakBytes: 4108,
  logicalSamples: logicalSamples(),
  validSampleCount: 11,
  discardedSampleCount: 0,
  measurementFailureCount: 0,
  verifiedMembershipTransitionSampleCount: 2,
  verifiedMembershipTransitionGapCount: 1,
  verifiedMembershipTransitionGapTotalMs: 299,
  maximumAdjacentValidSampleGapMs: 300,
  membershipTransitionGaps: [{
    firstTransitionSample: 4,
    lastTransitionSample: 5,
    transitionSampleCount: 2,
    previousValidSample: 3,
    nextValidSample: 6,
    durationMs: 299,
    adjacentValidStartGapMs: 300,
    reasonCodes: [
      'BOUND_PROCESS_EXIT_ACCOUNTING_LAG',
      'EXACT_ACTIVE_SET_CHANGED'
    ]
  }],
  samplingContinuityClaim: 'BOUNDED_TRANSITION_GAPS_NOT_CONTINUOUS',
  privateWorkingSetBudgetStatus: 'PASS_WITH_TRANSITION_RESERVE',
  maximumTreeProcessCount: 2,
  launchToFirstSampleMs: 10,
  samplingIntervalMilliseconds: {
    n: 12,
    p50: 100,
    p95: 100,
    max: 100
  },
  logicalSampleSpanMilliseconds: { n: 13, p50: 1, p95: 1, max: 1 },
  processQuerySkewMilliseconds: {
    n: 13,
    p50: 0,
    p95: 0.3,
    max: 0.3
  },
  validCoverageMs: 1201,
  samplingStatus: 'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS',
  normalExit: true,
  rootExitCodeZero: true,
  residualProcessVerification: 'JOB_THREE_CONSECUTIVE_ZERO_POLLS',
  residualZeroPolls: 3,
  maximumResidualProcessCount: 0,
  residualQueryFailures: 0,
  finalProcessHistoryStatus: 'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO',
  finalKnownProcessIdentityCount: 2,
  finalJobTotalProcesses: 2,
  finalJobActiveProcesses: 0,
  finalJobReportedAccountingActiveProcesses: 0,
  jobCleanupStatus: 'EMPTY_AND_HANDLES_CLOSED',
  forcedKillCount: 0,
  outputCapture: {
    mode: 'BOUNDED_CREATE_NEW_FILES_NO_PIPES',
    stdoutBytes: 512,
    stderrBytes: 0,
    maximumBytesPerStream: 1_048_576,
    readTimeoutMilliseconds: 5000
  }
  };
};
const completeFixtureSample = (index) => {
  const sample = structuredClone(logicalSamples()[0]);
  const privateWorkingSetBytes = 5000 + index;
  sample.sample = index + 1;
  sample.startElapsedMs = 10 + (index * 100);
  sample.endElapsedMs = sample.startElapsedMs + 1;
  sample.jobTotalProcesses = 2;
  sample.preKnownProcessIdentityCount = 2;
  sample.postJobTotalProcesses = 2;
  sample.postKnownProcessIdentityCount = 2;
  sample.privateWorkingSetBytes = privateWorkingSetBytes;
  sample.processQueries[0].privateWorkingSetBytes =
    privateWorkingSetBytes;
  return sample;
};
const exactTransitionFixtureSample = (index) => {
  const sample = structuredClone(logicalSamples()[3]);
  sample.sample = index + 1;
  sample.startElapsedMs = 10 + (index * 100);
  sample.endElapsedMs = sample.startElapsedMs + 1;
  return sample;
};
const trials = directions.flatMap((direction) => Array.from(
  { length: 20 },
  (_, index) => trial(direction, index + 1)
));
const coldDocument = {
  schemaVersion: 'phase7-offline-cold-pws-v3',
  status: 'PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE',
  blockerCode: null,
  authorizationBoundary: {
    scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    evidenceStatus: 'NON_AUTHORIZING_RAW_M4_EVIDENCE',
    integrationOrDistributionAuthorized: false,
    gateDecisionAuthorized: false
  },
  runnerConfiguration,
  runnerConfigurationSha256: sha(JSON.stringify(runnerConfiguration)),
  measurementMethod: {
    privateWorkingSet: 'QUERY_WORKING_SET_SHARED_BIT_PRIVATE_PAGES',
    qwsIdentityValidation: 'SAME_HANDLE_PRE_AND_POST_ACTIVE_CREATION_TIME',
    processLaunch: 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME',
    processContainment: 'JOB_KILL_ON_CLOSE_NO_BREAKAWAY_FLAGS',
    processDiscovery: 'QUERY_INFORMATION_JOB_OBJECT_MEMBERS',
    processListCompleteness:
      'COMPLETE_LIST_OR_ACCOUNTING_BOUND_KNOWN_IDENTITIES',
    processHistoryCompleteness:
      'TOTAL_PROCESSES_EQUALS_ALL_OBSERVED_BOUND_IDENTITIES',
    exitAccountingLagRecovery:
      'STABLE_DOUBLE_ACCOUNTING_AND_BOUND_ACTIVE_IDENTITY_ENUMERATION',
    logicalSampleMembership:
      'PRE_POST_COMPLETE_OR_BOUNDED_VERIFIED_TRANSITION_WITH_TERMINAL_ZERO',
    membershipTransitionPolicy:
      'COMPLETE_BOUND_OR_STRICT_EXIT_ONLY_MARKER_BOUND_TERMINAL_ZERO',
    qwsJobMembershipValidation:
      'SAME_HANDLE_PRE_AND_POST_IS_PROCESS_IN_JOB',
    warmCompletionBoundary:
      'CREATE_NEW_MARKER_BOUND_TO_FINAL_CHILD_REPORT',
    terminalBoundary:
      'MARKER_VALIDATED_EXIT_ZERO_EXACT_HISTORY_THREE_ZERO_POLLS',
    jobProcessQueryRetryPolicy:
      'ONE_IMMEDIATE_RETRY_PRE_AND_POST_FAIL_CLOSED',
    postExitJobQueryFailurePolicy:
      'NO_RETRY_FAIL_FAST_TO_CLEANUP',
    treeAggregation: 'ONE_JOB_MEMBERSHIP_SNAPSHOT_PER_LOGICAL_SAMPLE',
    processQueriesAtomic: false,
    processIdentityBinding: 'PID_AND_CREATION_TIME_INTERNAL_ONLY',
    recursiveDescendantTracking: true,
    termination:
      'JOB_LEVEL_TIMEOUT_AND_SAME_HANDLE_BOUND_PROCESS_FALLBACK',
    electronAppMetricsGateAEligible: false
  },
  harnessIdentity,
  authorizationSha256: sha(authorizationContent),
  electronExecutable: {
    version: '39.1.0',
    sizeBytes: 1024,
    sha256: hex('a'),
    productVersionHash: hex('b')
  },
  electronDistTree: {
    fileCount: 10,
    totalBytes: 10_240,
    treeSha256: hex('c')
  },
  artifactIdentity: artifactIdentityFixture,
  candidateGenerationBindings,
  environment: {
    runnerSha256: harnessIdentity.runnerSha256
  },
  directions: directions.map((direction) => ({
    direction,
    requestedTrials: 20,
    successfulTrials: 20,
    failures: 0,
    coldAndPrivateWorkingSetFailures: 0,
    verifiedMembershipTransitionSamples: 40,
    verifiedMembershipTransitionGaps: 20,
    verifiedMembershipTransitionGapTotalMs: 5980,
    transitionReservePassTrials: 20,
    warm: {
      requestedObservations: 100,
      successfulObservations: 100,
      failures: 0
    }
  })),
  trials,
  totals: {
    requestedTrials: 40,
    successfulTrials: 40,
    failures: 0,
    coldAndPrivateWorkingSetFailures: 0,
    warmFailures: 0,
    forcedKillCount: 0,
    verifiedMembershipTransitionSamples: 80,
    verifiedMembershipTransitionGaps: 40
  },
  externalNetworkVerification:
    'NOT_VERIFIED_BY_OS_FIREWALL_OR_PACKET_CAPTURE',
  rawTextEmitted: false,
  rawPathsEmitted: false,
  processIdentifiersEmitted: false,
  integrationOrDistributionAuthorized: false,
  gateA: {
    status: 'INCOMPLETE',
    eligible: false,
    coldAndPrivateWorkingSetEvidenceStatus: 'COMPLETE',
    warmEvidenceStatus: 'COMPLETE'
  }
};

const score = (direction, index) => ({
  direction,
  evaluationId: `${direction}-${index}`,
  itemToken: `${direction}-item-${index}`,
  candidateId: `candidate-${direction}`,
  generationRunId: `generation-${direction}`,
  generationIdentitySha256:
    candidateGenerationDocuments.find(
      (document) => document.identity.direction === direction
    ).identitySha256,
  reviewerToken: 'reviewer-fixture',
  reviewMode: 'HUMAN_ONLY_NO_AUTOMATED_SCORING',
  blindnessAttestation: 'CANDIDATE_IDENTITY_NOT_VIEWED',
  humanReviewAttestation:
    'I_REVIEWED_THIS_ITEM_WITHOUT_AUTOMATED_SCORING',
  errors: {
    severeMistranslation: false,
    untranslated: false,
    garbled: false,
    properNounError: false,
    longSentenceError: false
  }
});
const rawScores = directions.flatMap((direction) => Array.from(
  { length: 200 },
  (_, index) => score(direction, index)
));
const blindDocument = {
  schemaVersion: 'phase7-blind-eval-report-v2',
  status: 'HUMAN_BLIND_EVALUATION_COMPONENT_COMPLETE',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  humanOnly: true,
  blindCandidateIdentity: true,
  audit: {
    manifestSha256: hex('d'),
    inputSha256: hex('3'),
    reviewBatchSha256: hex('4'),
    scoreTemplateSha256: hex('5'),
    privateAnswerKeySha256: hex('6'),
    rawScoresSha256: hex('7'),
    candidateGenerationBindingSetSha256,
    candidateOutputItemIdentitySetSha256ByDirection:
      Object.fromEntries(candidateGenerationBindings.map((binding) => [
        binding.direction,
        binding.candidateOutputItemIdentitySetSha256
      ])),
    randomizedMappingVerified: true,
    candidateIdentityWithheldFromReviewBatch: true
  },
  candidateGenerationBindings,
  counts: {
    validHumanReviewCount: 400,
    pendingHumanReviewCount: 0
  },
  rawScores,
  directions: directions.map((direction) => ({
    direction,
    candidates: [{
      candidateId: `candidate-${direction}`,
      generationRunIds: [`generation-${direction}`],
      generationIdentitySha256:
        candidateGenerationDocuments.find(
          (document) => document.identity.direction === direction
        ).identitySha256,
      validN: 200,
      uniqueItemN: 200,
      pendingN: 0
    }]
  }))
};
const coldArtifact = artifact(coldDocument);
const blindArtifact = artifact(blindDocument);
const authorizationArtifact = {
  content: authorizationContent,
  sha256: sha(authorizationContent)
};
const primaryEvidenceSetSha256 = shaCanonical({
  schemaVersion: 'phase7-gate-a-primary-evidence-set-v1',
  coldPwsSha256: coldArtifact.sha256,
  blindEvaluationSha256: blindArtifact.sha256,
  pocAuthorizationSha256: authorizationArtifact.sha256,
  candidateGenerationSha256s:
    candidateGenerationArtifacts.map((entry) => entry.sha256).sort(),
  candidateGenerationBindingSetSha256,
  harnessFileSetSha256: harnessIdentity.fileSetSha256
});
const legalReviewDocument = {
  schemaVersion: 'phase7-gate-a-legal-review-v1',
  status: 'LEGAL_REVIEW_COMPLETE_FOR_GATE_A_DECISION',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  primaryEvidenceSetSha256,
  candidateGenerationBindingSetSha256,
  reviewedManifestSha256: artifactIdentityFixture.manifestSha256,
  reviewedCandidateIds: directions.map(
    (direction) => `candidate-${direction}`
  ),
  licenseNoticeSbomReviewComplete: true,
  redistributionConclusion: 'PERMITTED_FOR_PROPOSED_LIMITED_BETA',
  integrationOrDistributionAuthorized: false,
  reviewedAt: '2026-07-24T00:00:00.000Z'
};
const osNetworkCaptureContent =
  'PHASE7 SELF TEST CAPTURE FIXTURE; NOT REAL NETWORK EVIDENCE';
const osNetworkCaptureArtifact = {
  content: osNetworkCaptureContent,
  sha256: sha(osNetworkCaptureContent)
};
const osNetworkVerificationDocument = {
  schemaVersion: 'phase7-gate-a-os-network-verification-v1',
  status: 'OS_LEVEL_NO_EXTERNAL_TRAFFIC_OBSERVED',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  primaryEvidenceSetSha256,
  candidateGenerationBindingSetSha256,
  method: 'WINDOWS_FIREWALL_AND_PACKET_CAPTURE',
  captureSha256: osNetworkCaptureArtifact.sha256,
  captureSizeBytes: Buffer.byteLength(osNetworkCaptureContent, 'utf8'),
  observedExternalConnectionCount: 0,
  osLevelVerified: true,
  rawTextEmitted: false,
  integrationOrDistributionAuthorized: false,
  verifiedAt: '2026-07-24T00:00:00.000Z'
};
const packageSizingDocument = {
  schemaVersion: 'phase7-gate-a-package-sizing-v1',
  status: 'FINAL_PACKAGE_SIZING_COMPLETE',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  primaryEvidenceSetSha256,
  candidateGenerationBindingSetSha256,
  baseInstaller: {
    sha256: hex('8'),
    sizeBytes: 150_000_000,
    containsModel: false
  },
  coreModelPack: {
    sha256: hex('9'),
    archiveSizeBytes: 300_000_000,
    installedSizeBytes: 350_000_000,
    candidateGenerationIdentitySha256s:
      candidateGenerationBindings.map(
        (binding) => binding.generationIdentitySha256
      )
  },
  limits: {
    baseInstallerMaximumBytes: 157_286_400,
    corePackTargetBytes: 314_572_800,
    corePackHardMaximumBytes: 419_430_400,
    customModelPathDecisionRequired: false
  },
  integrationOrDistributionAuthorized: false,
  measuredAt: '2026-07-24T00:00:00.000Z'
};
const schemaRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'schemas'
);
const crossBoundEvidenceSchema = JSON.parse(readFileSync(
  resolve(schemaRoot, 'gate-a-cross-bound-evidence.schema.json'),
  'utf8'
));
const schemaValidator = new Ajv2020({
  allErrors: true,
  strict: true
});
addFormats(schemaValidator);
const validateCrossBoundEvidence =
  schemaValidator.compile(crossBoundEvidenceSchema);
for (const document of [
  ...candidateGenerationDocuments,
  legalReviewDocument,
  osNetworkVerificationDocument,
  packageSizingDocument
]) {
  assert.equal(
    validateCrossBoundEvidence(document),
    true,
    JSON.stringify(validateCrossBoundEvidence.errors)
  );
}
const rawEvidence = {
  artifacts: {
    coldPws: coldArtifact,
    blindEvaluation: blindArtifact,
    pocAuthorization: authorizationArtifact,
    candidateGenerations: candidateGenerationArtifacts,
    legalReview: artifact(legalReviewDocument),
    osNetworkVerification: artifact(osNetworkVerificationDocument),
    osNetworkCapture: osNetworkCaptureArtifact,
    packageSizing: artifact(packageSizingDocument)
  },
  sources: Object.fromEntries(
    Object.entries(sourceContents).map(([key, content]) => [
      key,
      { content, sha256: sha(content) }
    ])
  )
};

const completeInput = evaluateGateAInputCompleteness(rawEvidence);
assert.equal(completeInput.inputStatus, GATE_A_INPUT_READY);
assert.equal(completeInput.ready, true);
assert.equal(
  completeInput.authorizationMode,
  'NON_AUTHORIZING_EVIDENCE_INPUT_COMPLETE'
);
assert.equal(
  completeInput.gateDecisionStatus,
  'AWAITING_EXPLICIT_USER_DECISION'
);
assert.equal(completeInput.integrationOrDistributionAuthorized, false);
assert.deepEqual(completeInput.unmetConditions, []);
assert.equal(completeInput.derived.coldPws.validLogicalSamples, 440);
assert.equal(completeInput.derived.coldPws.discardedLogicalSamples, 0);
assert.equal(
  completeInput.derived.coldPws.verifiedMembershipTransitionSamples,
  80
);
assert.equal(
  completeInput.derived.coldPws.verifiedMembershipTransitionGaps,
  40
);
assert.equal(
  assertGateAInputReady(rawEvidence).inputStatus,
  GATE_A_INPUT_READY
);

const tamperedBytes = structuredClone(rawEvidence);
tamperedBytes.artifacts.coldPws.content += ' ';
const hashMismatch = evaluateGateAInputCompleteness(tamperedBytes);
assert.equal(hashMismatch.inputStatus, GATE_A_INPUT_INCOMPLETE);
assert.ok(
  hashMismatch.unmetConditions.includes(
    'COLD_PWS_RAW_ARTIFACT_SHA256_MISMATCH'
  )
);

const tamperedSample = structuredClone(coldDocument);
tamperedSample.trials[0].logicalSamples[0].privateWorkingSetBytes += 1;
const rawSamplingMismatch = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(tamperedSample)
  }
});
assert.equal(rawSamplingMismatch.inputStatus, GATE_A_INPUT_INCOMPLETE);
assert.ok(rawSamplingMismatch.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const tamperedMembership = structuredClone(coldDocument);
tamperedMembership.trials[0].logicalSamples[0]
  .membershipRevalidationStatus = 'NOT_RUN';
const membershipMismatch = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(tamperedMembership)
  }
});
assert.equal(membershipMismatch.inputStatus, GATE_A_INPUT_INCOMPLETE);
assert.ok(membershipMismatch.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const unknownTransition = structuredClone(coldDocument);
unknownTransition.trials[0].logicalSamples[3].transitionReason =
  'UNVERIFIED_TRANSITION';
const unknownTransitionResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(unknownTransition)
  }
});
assert.ok(unknownTransitionResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const unknownNewborn = structuredClone(coldDocument);
unknownNewborn.trials[0].logicalSamples[4]
  .transitionKnownProcessIdentityCount = 1;
const unknownNewbornResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(unknownNewborn)
  }
});
assert.ok(unknownNewbornResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const unboundExactTransitionQueryFailure = structuredClone(coldDocument);
const unboundExactSample =
  unboundExactTransitionQueryFailure.trials[0].logicalSamples[3];
unboundExactSample.processQueries[0].status = 'QUERY_FAILED';
unboundExactSample.processQueries[0].privateWorkingSetBytes = null;
unboundExactSample.transitionInternalMeasurementFailureCount = 1;
const unboundExactResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(unboundExactTransitionQueryFailure)
  }
});
assert.ok(unboundExactResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const unboundExitLagQueryFailure = structuredClone(coldDocument);
const unboundExitLagSample =
  unboundExitLagQueryFailure.trials[0].logicalSamples[4];
unboundExitLagSample.preJobQueryStatus = 'COMPLETE';
unboundExitLagSample.memberDiscoveryStatus =
  'COMPLETE_PROCESS_ID_LIST';
unboundExitLagSample.memberCount = 1;
unboundExitLagSample.jobTotalProcesses = 2;
unboundExitLagSample.jobActiveProcesses = 1;
unboundExitLagSample.jobReportedAccountingActiveProcesses = 1;
unboundExitLagSample.preKnownProcessIdentityCount = 2;
unboundExitLagSample.preProcessOrdinals = [1];
unboundExitLagSample.transitionInternalMeasurementFailureCount = 1;
unboundExitLagSample.processQueries = [{
  processOrdinal: 1,
  executableSha256: hex('8'),
  startOffsetMs: 0.2,
  endOffsetMs: 0.7,
  durationMs: 0.5,
  status: 'QUERY_FAILED',
  privateWorkingSetBytes: null
}];
const unboundExitLagResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(unboundExitLagQueryFailure)
  }
});
assert.ok(unboundExitLagResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const activeExitLagQueryFailure = structuredClone(coldDocument);
activeExitLagQueryFailure.trials[0].logicalSamples[4]
  .transitionBoundActiveProcessEntries[0].processOrdinal = 2;
const activeExitLagQueryFailureResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(activeExitLagQueryFailure)
  }
});
assert.ok(activeExitLagQueryFailureResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const unknownRecoveryIdentity = structuredClone(coldDocument);
unknownRecoveryIdentity.trials[0].logicalSamples[5]
  .preKnownProcessIdentityCount = 1;
const unknownRecoveryIdentityResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(unknownRecoveryIdentity)
  }
});
assert.ok(unknownRecoveryIdentityResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const changedRecoveryActiveSet = structuredClone(coldDocument);
changedRecoveryActiveSet.trials[0].logicalSamples[5]
  .postProcessOrdinals = [2];
const changedRecoveryActiveSetResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(changedRecoveryActiveSet)
  }
});
assert.ok(changedRecoveryActiveSetResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const failedRecoveryQws = structuredClone(coldDocument);
const failedRecoveryQwsSample =
  failedRecoveryQws.trials[0].logicalSamples[5];
failedRecoveryQwsSample.processQueries[0].status = 'QUERY_FAILED';
failedRecoveryQwsSample.processQueries[0].privateWorkingSetBytes = null;
failedRecoveryQwsSample.privateWorkingSetBytes = null;
failedRecoveryQwsSample.transitionInternalMeasurementFailureCount = 1;
const failedRecoveryQwsResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(failedRecoveryQws)
  }
});
assert.ok(failedRecoveryQwsResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const nonLagRecoveryAccounting = structuredClone(coldDocument);
nonLagRecoveryAccounting.trials[0].logicalSamples[5]
  .jobReportedAccountingActiveProcesses = 1;
const nonLagRecoveryAccountingResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(nonLagRecoveryAccounting)
  }
});
assert.ok(nonLagRecoveryAccountingResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const excessiveTransitionSamples = structuredClone(coldDocument);
const excessiveTrial = excessiveTransitionSamples.trials[0];
excessiveTrial.logicalSamples = Array.from(
  { length: 13 },
  (_, index) => (
    index >= 1 && index <= 9
      ? exactTransitionFixtureSample(index)
      : completeFixtureSample(index)
  )
);
excessiveTrial.validSampleCount = 4;
excessiveTrial.verifiedMembershipTransitionSampleCount = 9;
excessiveTrial.verifiedMembershipTransitionGapCount = 1;
excessiveTrial.verifiedMembershipTransitionGapTotalMs = 999;
excessiveTrial.maximumAdjacentValidSampleGapMs = 1000;
excessiveTrial.membershipTransitionGaps = [{
  firstTransitionSample: 2,
  lastTransitionSample: 10,
  transitionSampleCount: 9,
  previousValidSample: 1,
  nextValidSample: 11,
  durationMs: 999,
  adjacentValidStartGapMs: 1000,
  reasonCodes: ['EXACT_ACTIVE_SET_CHANGED']
}];
excessiveTrial.privateWorkingSetPeakBytes = 5012;
excessiveTrial.validCoverageMs = 1201;
const excessiveTransitionResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(excessiveTransitionSamples)
  }
});
assert.ok(excessiveTransitionResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const excessiveAdjacentGap = structuredClone(coldDocument);
const adjacentTrial = excessiveAdjacentGap.trials[0];
adjacentTrial.logicalSamples = Array.from(
  { length: 16 },
  (_, index) => (
    index >= 3 && index <= 7
      ? exactTransitionFixtureSample(index)
      : completeFixtureSample(index)
  )
);
adjacentTrial.validSampleCount = 11;
adjacentTrial.verifiedMembershipTransitionSampleCount = 5;
adjacentTrial.verifiedMembershipTransitionGapCount = 1;
adjacentTrial.verifiedMembershipTransitionGapTotalMs = 599;
adjacentTrial.maximumAdjacentValidSampleGapMs = 600;
adjacentTrial.membershipTransitionGaps = [{
  firstTransitionSample: 4,
  lastTransitionSample: 8,
  transitionSampleCount: 5,
  previousValidSample: 3,
  nextValidSample: 9,
  durationMs: 599,
  adjacentValidStartGapMs: 600,
  reasonCodes: ['EXACT_ACTIVE_SET_CHANGED']
}];
adjacentTrial.privateWorkingSetPeakBytes = 5015;
adjacentTrial.validCoverageMs = 1501;
adjacentTrial.samplingIntervalMilliseconds.n = 15;
adjacentTrial.logicalSampleSpanMilliseconds.n = 16;
adjacentTrial.processQuerySkewMilliseconds.n = 16;
const excessiveAdjacentGapResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(excessiveAdjacentGap)
  }
});
assert.ok(excessiveAdjacentGapResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const excessiveTotalGap = structuredClone(coldDocument);
const totalGapTrial = excessiveTotalGap.trials[0];
const transitionIndexes = new Set([2, 3, 7, 8, 12, 13, 17, 18]);
totalGapTrial.logicalSamples = Array.from(
  { length: 21 },
  (_, index) => (
    transitionIndexes.has(index)
      ? exactTransitionFixtureSample(index)
      : completeFixtureSample(index)
  )
);
totalGapTrial.validSampleCount = 13;
totalGapTrial.verifiedMembershipTransitionSampleCount = 8;
totalGapTrial.verifiedMembershipTransitionGapCount = 4;
totalGapTrial.verifiedMembershipTransitionGapTotalMs = 1196;
totalGapTrial.maximumAdjacentValidSampleGapMs = 300;
totalGapTrial.membershipTransitionGaps = [
  [3, 4, 2, 5],
  [8, 9, 7, 10],
  [13, 14, 12, 15],
  [18, 19, 17, 20]
].map(([first, last, previous, next]) => ({
  firstTransitionSample: first,
  lastTransitionSample: last,
  transitionSampleCount: 2,
  previousValidSample: previous,
  nextValidSample: next,
  durationMs: 299,
  adjacentValidStartGapMs: 300,
  reasonCodes: ['EXACT_ACTIVE_SET_CHANGED']
}));
totalGapTrial.privateWorkingSetPeakBytes = 5020;
totalGapTrial.validCoverageMs = 2001;
totalGapTrial.samplingIntervalMilliseconds.n = 20;
totalGapTrial.logicalSampleSpanMilliseconds.n = 21;
totalGapTrial.processQuerySkewMilliseconds.n = 21;
const excessiveTotalGapResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(excessiveTotalGap)
  }
});
assert.ok(excessiveTotalGapResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const transitionNearBudget = structuredClone(coldDocument);
const nearBudgetTrial = transitionNearBudget.trials[0];
const nearBudgetSample = nearBudgetTrial.logicalSamples[12];
nearBudgetSample.privateWorkingSetBytes = 1_073_741_825;
nearBudgetSample.processQueries[0].privateWorkingSetBytes = 1_073_741_825;
nearBudgetTrial.privateWorkingSetPeakBytes = 1_073_741_825;
nearBudgetTrial.privateWorkingSetBudgetStatus =
  'INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET';
const transitionNearBudgetResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(transitionNearBudget)
  }
});
assert.ok(transitionNearBudgetResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_RAW_LOGICAL_SAMPLING_INVALID'
));

const tamperedMarkerBinding = structuredClone(coldDocument);
tamperedMarkerBinding.trials[0].rendererColdTargetSha256 = hex('5');
const tamperedMarkerBindingResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(tamperedMarkerBinding)
  }
});
assert.ok(tamperedMarkerBindingResult.unmetConditions.includes(
  'COLD_PWS_TRIAL:en-zh:1_PROCESS_LIFECYCLE_OR_CLEANUP_INVALID'
));

const tamperedHarness = structuredClone(rawEvidence);
tamperedHarness.sources.electronRenderer.content += 'tamper';
const harnessMismatch = evaluateGateAInputCompleteness(tamperedHarness);
assert.equal(harnessMismatch.inputStatus, GATE_A_INPUT_INCOMPLETE);
assert.ok(harnessMismatch.unmetConditions.includes(
  'HARNESS_SOURCE:electronRenderer_SHA256_MISMATCH'
));

const missingGeneration = structuredClone(rawEvidence);
delete missingGeneration.artifacts.candidateGenerations;
const missingGenerationResult =
  evaluateGateAInputCompleteness(missingGeneration);
assert.ok(missingGenerationResult.unmetConditions.includes(
  'CANDIDATE_GENERATION_RAW_ARTIFACT_COLLECTION_MISSING_OR_EMPTY'
));

const wrongGenerationCandidate = structuredClone(
  candidateGenerationDocuments[0]
);
wrongGenerationCandidate.identity.candidateId = 'remapped-candidate-en-zh';
wrongGenerationCandidate.identitySha256 = shaCanonical(
  wrongGenerationCandidate.identity
);
const wrongGenerationCandidateInput = structuredClone(rawEvidence);
wrongGenerationCandidateInput.artifacts.candidateGenerations[0] =
  artifact(wrongGenerationCandidate);
const wrongGenerationCandidateResult = evaluateGateAInputCompleteness(
  wrongGenerationCandidateInput
);
assert.ok(wrongGenerationCandidateResult.unmetConditions.includes(
  'COLD_PWS_CANDIDATE_GENERATION_RAW_GENERATION_ARTIFACT_SET_MISMATCH'
));
assert.ok(wrongGenerationCandidateResult.unmetConditions.includes(
  'HUMAN_BLIND_CANDIDATE_GENERATION_RAW_GENERATION_ARTIFACT_SET_MISMATCH'
));

const duplicateGeneration = structuredClone(
  candidateGenerationDocuments[1]
);
duplicateGeneration.identity.direction = 'en-zh';
duplicateGeneration.identity.candidateId = 'candidate-en-zh';
duplicateGeneration.identity.generationRunId = 'generation-en-zh';
duplicateGeneration.identity.sourceSet.identitySha256 = hex('a');
duplicateGeneration.identity.workloadIdentitySha256 =
  shaCanonical(workloadByDirection['en-zh']);
duplicateGeneration.identitySha256 = shaCanonical(
  duplicateGeneration.identity
);
const duplicateGenerationInput = structuredClone(rawEvidence);
duplicateGenerationInput.artifacts.candidateGenerations[1] =
  artifact(duplicateGeneration);
const duplicateGenerationResult = evaluateGateAInputCompleteness(
  duplicateGenerationInput
);
assert.ok(duplicateGenerationResult.unmetConditions.includes(
  'CANDIDATE_GENERATION_DIRECTION_SET_INVALID'
));
assert.ok(duplicateGenerationResult.unmetConditions.includes(
  'CANDIDATE_GENERATION_DUPLICATE_CANDIDATE_ID'
));
assert.ok(duplicateGenerationResult.unmetConditions.includes(
  'CANDIDATE_GENERATION_DUPLICATE_GENERATION_RUN_ID'
));

const remappedCold = structuredClone(coldDocument);
[
  remappedCold.candidateGenerationBindings[0].generationArtifactSha256,
  remappedCold.candidateGenerationBindings[1].generationArtifactSha256
] = [
  remappedCold.candidateGenerationBindings[1].generationArtifactSha256,
  remappedCold.candidateGenerationBindings[0].generationArtifactSha256
];
const remappedColdResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(remappedCold)
  }
});
assert.ok(remappedColdResult.unmetConditions.includes(
  'COLD_PWS_CANDIDATE_GENERATION_RAW_GENERATION_ARTIFACT_SET_MISMATCH'
));

const oldColdSchema = structuredClone(coldDocument);
oldColdSchema.schemaVersion = 'phase7-bergamot-cold-pws-v2';
oldColdSchema.runnerConfiguration.schemaVersion =
  'phase7-bergamot-cold-pws-v2';
const oldColdSchemaResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    coldPws: artifact(oldColdSchema)
  }
});
assert.ok(oldColdSchemaResult.unmetConditions.includes(
  'COLD_PWS_SCHEMA_UNSUPPORTED'
));

const oldBlindSchema = structuredClone(blindDocument);
oldBlindSchema.schemaVersion = 'phase7-blind-eval-report-v1';
const oldBlindSchemaResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    blindEvaluation: artifact(oldBlindSchema)
  }
});
assert.ok(oldBlindSchemaResult.unmetConditions.includes(
  'HUMAN_BLIND_SCHEMA_UNSUPPORTED'
));

const oldGenerationSchema = structuredClone(
  candidateGenerationDocuments[0]
);
oldGenerationSchema.schemaVersion =
  'phase7-argos-generation-artifact-manifest-v1';
const oldGenerationSchemaInput = structuredClone(rawEvidence);
oldGenerationSchemaInput.artifacts.candidateGenerations[0] =
  artifact(oldGenerationSchema);
const oldGenerationSchemaResult = evaluateGateAInputCompleteness(
  oldGenerationSchemaInput
);
assert.ok(oldGenerationSchemaResult.unmetConditions.includes(
  'CANDIDATE_GENERATION:1_SCHEMA_UNSUPPORTED'
));

const staleAuthorizationDocument = JSON.parse(authorizationContent);
staleAuthorizationDocument.manifestSha256 = hex('0');
const staleAuthorizationInput = structuredClone(rawEvidence);
staleAuthorizationInput.artifacts.pocAuthorization =
  artifact(staleAuthorizationDocument);
const staleAuthorizationResult = evaluateGateAInputCompleteness(
  staleAuthorizationInput
);
assert.ok(staleAuthorizationResult.unmetConditions.includes(
  'POC_AUTHORIZATION_MANIFEST_MISMATCH'
));
assert.ok(staleAuthorizationResult.unmetConditions.includes(
  'POC_AUTHORIZATION_RAW_ARTIFACT_NOT_BOUND_TO_GENERATIONS'
));

const wrongBlindIdentity = structuredClone(blindDocument);
wrongBlindIdentity.rawScores[0].generationIdentitySha256 = hex('0');
const wrongBlindIdentityResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    blindEvaluation: artifact(wrongBlindIdentity)
  }
});
assert.ok(wrongBlindIdentityResult.unmetConditions.includes(
  'HUMAN_BLIND_RAW_SCORE_GENERATION_BINDING_MISMATCH:en-zh'
));

const wrongBlindItemSet = structuredClone(blindDocument);
wrongBlindItemSet.audit
  .candidateOutputItemIdentitySetSha256ByDirection['en-zh'] = hex('0');
const wrongBlindItemSetResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    blindEvaluation: artifact(wrongBlindItemSet)
  }
});
assert.ok(wrongBlindItemSetResult.unmetConditions.includes(
  'HUMAN_BLIND_REVIEWED_ITEM_SET_CANDIDATE_OUTPUT_MISMATCH:en-zh'
));

for (const [artifactName, expectedCode] of [
  ['legalReview', 'LEGAL_REVIEW_RAW_ARTIFACT_MISSING_OR_UNBOUND'],
  [
    'osNetworkVerification',
    'OS_NETWORK_VERIFICATION_RAW_ARTIFACT_MISSING_OR_UNBOUND'
  ],
  ['osNetworkCapture', 'OS_NETWORK_CAPTURE_RAW_ARTIFACT_MISSING_OR_UNBOUND'],
  ['packageSizing', 'PACKAGE_SIZING_RAW_ARTIFACT_MISSING_OR_UNBOUND']
]) {
  const incomplete = structuredClone(rawEvidence);
  delete incomplete.artifacts[artifactName];
  const result = evaluateGateAInputCompleteness(incomplete);
  assert.equal(result.ready, false);
  assert.ok(result.unmetConditions.includes(expectedCode));
}

const overLimitSizing = structuredClone(packageSizingDocument);
overLimitSizing.coreModelPack.archiveSizeBytes = 419_430_401;
overLimitSizing.coreModelPack.installedSizeBytes = 419_430_401;
overLimitSizing.limits.customModelPathDecisionRequired = true;
const overLimitSizingResult = evaluateGateAInputCompleteness({
  ...rawEvidence,
  artifacts: {
    ...rawEvidence.artifacts,
    packageSizing: artifact(overLimitSizing)
  }
});
assert.ok(overLimitSizingResult.unmetConditions.includes(
  'PACKAGE_SIZING_CORE_MODEL_PACK_INVALID_OR_OVER_LIMIT'
));

const missingLegal = structuredClone(rawEvidence);
delete missingLegal.artifacts.legalReview;
assert.throws(
  () => assertGateAInputReady(missingLegal),
  (error) => error?.code === 'GATE_A_INPUT_NOT_AUTHORIZING'
);

const syntheticBooleans = evaluateGateAInputCompleteness({
  directions,
  candidateIdentityComplete: true,
  artifactSizingComplete: true,
  rawResultsAttached: true
});
assert.equal(syntheticBooleans.inputStatus, GATE_A_INPUT_INCOMPLETE);
assert.equal(syntheticBooleans.ready, false);
assert.ok(syntheticBooleans.unmetConditions.includes(
  'COLD_PWS_RAW_ARTIFACT_MISSING_OR_UNBOUND'
));

process.stdout.write(`${JSON.stringify({
  status: 'STATIC_COMPLETENESS_SELF_TEST_PASS',
  runtimeExecuted: false,
  modelLoad: 'NOT_RUN',
  firstTranslation: 'NOT_RUN',
  structurallyReadyFixture: GATE_A_INPUT_READY,
  nonAuthorizingIncompleteMode:
    GATE_A_INPUT_NON_AUTHORIZING_SHAPE_CHECK,
  readyAuthorizationMode: 'NON_AUTHORIZING_EVIDENCE_INPUT_COMPLETE',
  userGateADecision: 'NOT_RECORDED',
  integrationOrDistributionAuthorized: false,
  failClosedFixture: GATE_A_INPUT_INCOMPLETE,
  rawLogicalSamplesRecomputed: true,
  verifiedTransitionPositiveFixture: true,
  stableExitAccountingLagRecoveryPositiveFixture: true,
  verifiedTransitionNegativeFixtures: 14,
  crossBindingNegativeFixtures: 16,
  syntheticBooleansIgnored: true
}, null, 2)}\n`);

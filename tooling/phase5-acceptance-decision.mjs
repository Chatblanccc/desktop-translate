import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const execFileAsync = promisify(execFile);

export const ACCEPTANCE_RULE = 'Phase 5 is PASS only when the exact frozen gate set is PASS and Product, Engineering, SecurityPrivacy, and QualityRelease all APPROVE the same canonical payload digest.';
export const CANONICALIZATION = 'UTF8_RECURSIVE_SORTED_KEYS_V1';
export const PAYLOAD_DOMAIN = 'desktop-translate-phase5-acceptance-payload-v1\0';
export const ARTIFACT_SET_DOMAIN = 'desktop-translate-phase5-artifact-set-v1\0';

export const REQUIRED_APPROVAL_ROLES = Object.freeze([
  'Product',
  'Engineering',
  'SecurityPrivacy',
  'QualityRelease'
]);

export const FROZEN_GATES = Object.freeze([
  gate('G0-SCOPE-FREEZE', 'REPOSITORY', false),
  gate('G1-PHASE4-BASELINE', 'REPOSITORY', false),
  gate('G2-CLEAN-SOURCE', 'REPOSITORY', false),
  gate('G2-VERSION-TOOLCHAIN', 'REPOSITORY', false),
  gate('WP1-METRICS-PRIVACY', 'REPOSITORY', false),
  gate('WP2-BASELINE-REGRESSION', 'FIXED_LAB', true),
  ...Array.from({ length: 9 }, (_, index) => gate(
    `WP3-PERF-${String(index + 1).padStart(2, '0')}`,
    index === 7 ? 'PROVIDER' : 'FIXED_LAB',
    true
  )),
  ...Array.from({ length: 6 }, (_, index) => gate(
    `WP4-RES-${String(index + 1).padStart(2, '0')}`,
    'FIXED_LAB',
    true
  )),
  gate('WP4-LANE-A-8H', 'FIXED_LAB', true),
  gate('WP4-LANE-B-8H', 'FIXED_LAB', true),
  gate('WP4-FAULT-RECOVERY', 'FIXED_LAB', true),
  gate('WP4-PRIVACY-CANARY', 'FIXED_LAB', true),
  gate('WP5-PACKAGE-CONTENTS', 'RELEASE', false),
  gate('WP5-PACKAGE-SIZE', 'RELEASE', false),
  gate('WP5-SUPPLY-CHAIN', 'RELEASE', false),
  gate('WP5-FINAL-RELEASE-MANIFEST', 'CRYPTOGRAPHIC', true),
  gate('WP5-AUTHENTICODE', 'CRYPTOGRAPHIC', true),
  gate('WP5-ARTIFACT-ATTESTATION', 'CRYPTOGRAPHIC', true),
  gate('WP5-FINAL-MANIFEST-ATTESTATION', 'CRYPTOGRAPHIC', true),
  gate('WP5-CLEAN-DOWNLOAD', 'CRYPTOGRAPHIC', true),
  gate('WP6-DETERMINISTIC-VERIFY', 'REPOSITORY', false),
  gate('WP6-FRESH-RUNNER-CI', 'RELEASE', true),
  gate('WP6-RELEASE-GOVERNANCE', 'RELEASE', true),
  gate('WP7-CLEAN-VM', 'CLEAN_VM', true),
  gate('WP7-INSTALL-UPGRADE-UNINSTALL', 'CLEAN_VM', true),
  gate('WP7-DISPLAY-HARDWARE', 'HARDWARE', true),
  gate('WP7-APPLICATION-COMPATIBILITY', 'HARDWARE', true),
  gate('WP7-PERMISSION-BOUNDARIES', 'HARDWARE', true),
  gate('WP7-DATA-LIFECYCLE', 'CLEAN_VM', true),
  gate('WP7-RESIDUAL-WER-ZERO', 'FIXED_LAB', true)
]);

export const FROZEN_GATE_IDS = Object.freeze(FROZEN_GATES.map(({ id }) => id));

const EXACT_ARTIFACT_ROLES = Object.freeze(['application', 'asar', 'installer', 'nativeHost']);
const EXACT_SIGNED_ARTIFACT_ROLES = Object.freeze(['application', 'installer', 'nativeHost']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const ROLE_DECISION_STATEMENT = 'This role decision is bound to the exact Phase 5 acceptance payload.';
const PHASE5_TAG_PATTERN = /^refs\/tags\/phase5-rc-[A-Za-z0-9._-]+$/u;
const OFFICIAL_REPOSITORY = 'Chatblanccc/desktop-translate';
const OFFICIAL_SIGNER_WORKFLOW_PATH = '.github/workflows/phase5-windows.yml';

function officialSignerWorkflow() {
  return `${OFFICIAL_REPOSITORY}/${OFFICIAL_SIGNER_WORKFLOW_PATH}`;
}

const claim = Object.freeze({
  exact: (value) => ({ kind: 'exact', value, example: value }),
  maximum: (value) => ({ kind: 'maximum', value, example: value }),
  minimum: (value) => ({ kind: 'minimum', value, example: value }),
  integerMaximum: (value) => ({ kind: 'integerMaximum', value, example: value }),
  integerMinimum: (value) => ({ kind: 'integerMinimum', value, example: value }),
  candidateGitSha: () => ({ kind: 'candidateGitSha', example: null }),
  candidateArtifactSetDigest: () => ({ kind: 'candidateArtifactSetDigest', example: null }),
  phase5Tag: () => ({ kind: 'phase5Tag', example: 'refs/tags/phase5-rc-test' })
});

const jsonSource = (role) => ({ role, mediaType: 'application/json' });
const jsonlSource = (role) => ({ role, mediaType: 'application/jsonl' });
const textSource = (role) => ({ role, mediaType: 'text/plain' });
const standardPerfSources = Object.freeze([jsonSource('summary'), jsonSource('environment'), jsonSource('privacyScan')]);
const standardResourceSources = Object.freeze([jsonSource('summary'), jsonSource('environment'), jsonSource('privacyScan')]);

function policy(validatorId, sources, claims) {
  return { validatorId, sources, claims };
}

/**
 * This is the complete fail-closed gateId -> validation-policy registry. A new
 * frozen gate cannot pass until it has an explicit entry here.
 */
export const GATE_VALIDATION_POLICIES = deepFreeze({
  'G0-SCOPE-FREEZE': policy('phase5.scope-freeze.v1', [jsonSource('scopeDecision')], {
    scopeDecisionsFrozen: claim.exact(true),
    successMetricsFrozen: claim.exact(true),
    acceptedRisksFrozen: claim.exact(true),
    unresolvedScopeAmbiguities: claim.integerMaximum(0)
  }),
  'G1-PHASE4-BASELINE': policy('phase5.phase4-baseline.v1', [jsonSource('phase4Archive'), jsonSource('regressionSummary')], {
    historicalAcceptanceArchived: claim.exact(true),
    strictSupersetRegressionPassed: claim.exact(true),
    unresolvedP0P1: claim.integerMaximum(0)
  }),
  'G2-CLEAN-SOURCE': policy('phase5.clean-source.v1', [jsonSource('workspaceState')], {
    sourceGitSha: claim.candidateGitSha(),
    worktreeClean: claim.exact(true),
    developmentDirty: claim.exact(false),
    patchDigest: claim.exact(null)
  }),
  'G2-VERSION-TOOLCHAIN': policy('phase5.version-toolchain.v1', [jsonSource('environment')], {
    productVersion: claim.exact('0.5.0-phase5'),
    nativeProductVersion: claim.exact('0.5.0-phase5'),
    nativeNumericVersion: claim.exact('0.5.0.0'),
    toolchainFrozen: claim.exact(true),
    msvcRuntimeStatic: claim.exact(true)
  }),
  'WP1-METRICS-PRIVACY': policy('phase5.metrics-privacy.v1', [jsonSource('instrumentationSummary'), jsonSource('privacyScan')], {
    metricsDefaultOff: claim.exact(true),
    allowlistTestsPassed: claim.exact(true),
    negativePrivacyTestsPassed: claim.exact(true),
    sensitiveHits: claim.integerMaximum(0)
  }),
  'WP2-BASELINE-REGRESSION': policy('phase5.baseline-regression.v1', [jsonSource('baselineSummary'), jsonSource('environment')], {
    rounds: claim.integerMinimum(3),
    sameDeviceBuildModeHarness: claim.exact(true),
    thresholdsFrozenBeforeOptimization: claim.exact(true),
    maximumRelativeRegressionPercent: claim.maximum(10),
    correctnessRegression: claim.exact(false)
  }),
  'WP3-PERF-01': policy('phase5.perf01.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    samplesPerRound: claim.integerMinimum(30),
    p50Ms: claim.maximum(1800),
    p95Ms: claim.maximum(3000),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-02': policy('phase5.perf02.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    warmupsPerRound: claim.integerMinimum(10),
    samplesPerRound: claim.integerMinimum(50),
    p50Ms: claim.maximum(1000),
    p95Ms: claim.maximum(1800),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-03': policy('phase5.perf03.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    samplesPerRound: claim.integerMinimum(100),
    p50Ms: claim.maximum(700),
    p95Ms: claim.maximum(1500),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0),
    forcedCleanupCount: claim.integerMaximum(0)
  }),
  'WP3-PERF-04': policy('phase5.perf04.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    warmupsPerRound: claim.integerMinimum(20),
    samplesPerRound: claim.integerMinimum(200),
    p50Ms: claim.maximum(250),
    p95Ms: claim.maximum(500),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-05': policy('phase5.perf05.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    samplesPerFixtureGroup: claim.integerMinimum(100),
    p50Ms: claim.maximum(1500),
    p95Ms: claim.maximum(3000),
    maximumRelativeRegressionPercent: claim.maximum(10),
    correctnessRegression: claim.exact(false),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-06': policy('phase5.perf06.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    samplesPerRound: claim.integerMinimum(200),
    p50Ms: claim.maximum(50),
    p95Ms: claim.maximum(100),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-07': policy('phase5.perf07.v1', standardPerfSources, {
    rounds: claim.integerMinimum(3),
    warmupsPerRound: claim.integerMinimum(20),
    samplesPerRound: claim.integerMinimum(200),
    totalP95Ms: claim.maximum(300),
    localOverheadP95Ms: claim.maximum(200),
    maximumRelativeRegressionPercent: claim.maximum(10),
    failures: claim.integerMaximum(0)
  }),
  'WP3-PERF-08': policy('phase5.perf08-provider.v1', [
    jsonSource('aggregate'),
    jsonSource('health'),
    jsonSource('faultTimeout'),
    jsonSource('faultNetworkUnavailable'),
    jsonSource('faultMalformedResponse'),
    jsonSource('faultRecovery'),
    jsonSource('runMetadata')
  ], {
    targetLanguages: claim.exact(['en', 'ja', 'ko']),
    samplesPerLanguage: claim.integerMinimum(10),
    maximumHealthyDurationMs: claim.maximum(8000),
    healthySuccessSamplesPresent: claim.exact(true),
    failureModeStableDegradation: claim.exact(true),
    sourceOnlyRemainedUsable: claim.exact(true),
    networkExplicitlyAuthorized: claim.exact(true),
    privacyPassed: claim.exact(true),
    credentialOrBodyHits: claim.integerMaximum(0)
  }),
  'WP3-PERF-09': policy('phase5.perf09.v1', standardPerfSources, {
    rounds: claim.exact(3),
    samplesPerRound: claim.exact(50),
    worstRoundP50Ms: claim.maximum(2000),
    worstRoundP95Ms: claim.maximum(5000),
    maximumMs: claim.maximum(10000),
    failures: claim.integerMaximum(0),
    forcedCleanupCount: claim.integerMaximum(0),
    residualProcessCount: claim.integerMaximum(0),
    privacyPassed: claim.exact(true)
  }),
  'WP4-RES-01': policy('phase5.res01.v1', standardResourceSources, {
    durationSeconds: claim.integerMinimum(900),
    sampleIntervalSeconds: claim.exact(5),
    averageCpuPercent: claim.maximum(1),
    p95CpuPercent: claim.maximum(3),
    completeProcessTree: claim.exact(true)
  }),
  'WP4-RES-02': policy('phase5.res02.v1', standardResourceSources, {
    durationSeconds: claim.integerMinimum(900),
    sampleIntervalSeconds: claim.exact(5),
    maximumTreePrivateWorkingSetMiB: claim.maximum(350),
    maximumHostPrivateWorkingSetMiB: claim.maximum(100),
    completeProcessTree: claim.exact(true)
  }),
  'WP4-RES-03': policy('phase5.res03.v1', standardResourceSources, {
    durationSeconds: claim.integerMinimum(28800),
    memoryGrowthMiB: claim.maximum(50),
    memoryGrowthPercent: claim.maximum(20),
    sustainedMonotonicGrowth: claim.exact(false),
    crashOrHangCount: claim.integerMaximum(0)
  }),
  'WP4-RES-04': policy('phase5.res04.v1', standardResourceSources, {
    durationSeconds: claim.integerMinimum(28800),
    objectGrowthPercent: claim.maximum(10),
    objectGrowthCount: claim.integerMaximum(100),
    monotonicGrowthForSixtyMinutes: claim.exact(false)
  }),
  'WP4-RES-05': policy('phase5.res05.v1', [jsonSource('faultSummary'), jsonSource('privacyScan')], {
    boundedBackoffObserved: claim.exact(true),
    circuitBreakerObserved: claim.exact(true),
    infiniteRestartObserved: claim.exact(false),
    uiExitRemainedAvailable: claim.exact(true),
    staleResultCount: claim.integerMaximum(0)
  }),
  'WP4-RES-06': policy('phase5.res06.v1', [jsonSource('exitSummary'), jsonSource('residualReport'), jsonSource('privacyScan')], {
    residualProcessCount: claim.integerMaximum(0),
    temporaryMetricsOpenHandleCount: claim.integerMaximum(0),
    forcedCleanupCount: claim.integerMaximum(0),
    privacyPassed: claim.exact(true)
  }),
  'WP4-LANE-A-8H': policy('phase5.lane-a-8h.v1', [jsonSource('summary'), jsonSource('environment'), jsonSource('privacyScan'), jsonSource('werReport'), jsonSource('residualReport')], {
    durationSeconds: claim.integerMinimum(28800),
    releaseEquivalentArtifact: claim.exact(true),
    realProductProcess: claim.exact(true),
    productionPackageContainsFakeDependencies: claim.exact(false),
    crashHangWerCount: claim.integerMaximum(0),
    privacyHits: claim.integerMaximum(0),
    residualProcessCount: claim.integerMaximum(0)
  }),
  'WP4-LANE-B-8H': policy('phase5.lane-b-8h.v1', [jsonSource('summary'), jsonSource('environment'), jsonSource('privacyScan'), jsonSource('werReport'), jsonSource('residualReport')], {
    durationSeconds: claim.integerMinimum(28800),
    finalSignedRc: claim.exact(true),
    authenticodeVerified: claim.exact(true),
    realUiaSelections: claim.integerMinimum(600),
    realOcrSelections: claim.integerMinimum(300),
    crashHangWerCount: claim.integerMaximum(0),
    privacyHits: claim.integerMaximum(0),
    residualProcessCount: claim.integerMaximum(0)
  }),
  'WP4-FAULT-RECOVERY': policy('phase5.fault-recovery.v1', [jsonSource('faultSummary'), jsonSource('privacyScan')], {
    hostKillRecoveryPassed: claim.exact(true),
    networkFailureRecoveryPassed: claim.exact(true),
    timeoutRecoveryPassed: claim.exact(true),
    displayRecoveryPassed: claim.exact(true),
    sleepResumeRecoveryPassed: claim.exact(true),
    exitStormPassed: claim.exact(true),
    restartStormObserved: claim.exact(false),
    uiExitRemainedAvailable: claim.exact(true)
  }),
  'WP4-PRIVACY-CANARY': policy('phase5.privacy-canary.v1', [jsonSource('privacyScan')], {
    utf8ScanPassed: claim.exact(true),
    utf16LeScanPassed: claim.exact(true),
    scannedSurfaceCount: claim.integerMinimum(5),
    sensitiveHits: claim.integerMaximum(0)
  }),
  'WP5-PACKAGE-CONTENTS': policy('phase5.package-contents.v1', [jsonSource('packageManifest'), jsonSource('privacyScan')], {
    asarIntegrityPassed: claim.exact(true),
    nativeHostBundled: claim.exact(true),
    migrationsBundled: claim.exact(true),
    prohibitedFileCount: claim.integerMaximum(0),
    sensitiveHits: claim.integerMaximum(0)
  }),
  'WP5-PACKAGE-SIZE': policy('phase5.package-size.v1', [jsonSource('sizeManifest')], {
    installerMiB: claim.maximum(150),
    installedMiB: claim.maximum(350),
    hostAndNonElectronResourcesMiB: claim.maximum(25),
    maximumUnapprovedGrowthPercent: claim.maximum(10)
  }),
  'WP5-SUPPLY-CHAIN': policy('phase5.supply-chain.v1', [jsonSource('dependencyAudit'), jsonSource('sbom'), textSource('notices'), jsonSource('provenance')], {
    frozenInstallPassed: claim.exact(true),
    sbomComplete: claim.exact(true),
    noticesComplete: claim.exact(true),
    provenanceVerified: claim.exact(true),
    unresolvedCritical: claim.integerMaximum(0),
    unresolvedHigh: claim.integerMaximum(0)
  }),
  'WP5-FINAL-RELEASE-MANIFEST': policy('phase5.final-release-manifest.v1', [jsonSource('finalReleaseManifest')], {
    exactCandidateSource: claim.exact(true),
    exactArtifactSetDigest: claim.candidateArtifactSetDigest(),
    packageEvidencePassed: claim.exact(true),
    supplyChainPassed: claim.exact(true)
  }),
  'WP5-AUTHENTICODE': policy('phase5.authenticode.v1', [jsonSource('signatureReport')], {
    allRequiredPeSigned: claim.exact(true),
    publisherIdentityConsistent: claim.exact(true),
    signerChainsValid: claim.exact(true),
    trustedTimestampsValid: claim.exact(true),
    tamperTestsRejected: claim.exact(true)
  }),
  'WP5-ARTIFACT-ATTESTATION': policy('phase5.artifact-attestation.v1', [jsonSource('artifactAttestation'), jsonlSource('trustedRoot')], {
    offlineVerificationPassed: claim.exact(true),
    independentTrustRoot: claim.exact(true),
    sourceGitSha: claim.candidateGitSha(),
    subjectArtifactSetDigest: claim.candidateArtifactSetDigest()
  }),
  'WP5-FINAL-MANIFEST-ATTESTATION': policy('phase5.final-manifest-attestation.v1', [jsonSource('manifestAttestation'), jsonlSource('trustedRoot')], {
    offlineVerificationPassed: claim.exact(true),
    independentTrustRoot: claim.exact(true),
    sourceGitSha: claim.candidateGitSha(),
    subjectIsExactFinalManifest: claim.exact(true)
  }),
  'WP5-CLEAN-DOWNLOAD': policy('phase5.clean-download.v1', [jsonSource('cleanDownloadVerification'), jsonlSource('independentTrustedRoot')], {
    independentlyDownloaded: claim.exact(true),
    exactArtifactSetDigest: claim.candidateArtifactSetDigest(),
    authenticodeReverified: claim.exact(true),
    artifactAttestationsReverified: claim.exact(true),
    manifestAttestationReverified: claim.exact(true)
  }),
  'WP6-DETERMINISTIC-VERIFY': policy('phase5.deterministic-verify.v1', [jsonSource('verifySummary')], {
    sourceGitSha: claim.candidateGitSha(),
    strictPhase4Superset: claim.exact(true),
    worktreeDirty: claim.exact(false),
    criticalSkips: claim.integerMaximum(0),
    failures: claim.integerMaximum(0)
  }),
  'WP6-FRESH-RUNNER-CI': policy('phase5.fresh-runner-ci.v1', [jsonSource('workflowRun'), jsonSource('verifySummary')], {
    sourceGitSha: claim.candidateGitSha(),
    freshRunner: claim.exact(true),
    workflowConclusion: claim.exact('success'),
    criticalSkips: claim.integerMaximum(0),
    artifactSetDigest: claim.candidateArtifactSetDigest()
  }),
  'WP6-RELEASE-GOVERNANCE': policy('phase5.release-governance.v1', [jsonSource('governanceReport')], {
    protectedReleaseEnvironment: claim.exact(true),
    requiredChecksEnforced: claim.exact(true),
    protectedRcTagRule: claim.exact(true),
    minimumWorkflowPermissions: claim.exact(true),
    forkSecretsExposed: claim.exact(false)
  }),
  'WP7-CLEAN-VM': policy('phase5.clean-vm.v1', [jsonSource('cleanVmSummary'), jsonSource('environment'), jsonSource('privacyScan')], {
    windows11Baseline: claim.exact(true),
    cleanInstallPassed: claim.exact(true),
    hiddenPrerequisiteCount: claim.integerMaximum(0),
    corePackagedE2ePassed: claim.exact(true),
    privacyPassed: claim.exact(true)
  }),
  'WP7-INSTALL-UPGRADE-UNINSTALL': policy('phase5.install-upgrade-uninstall.v1', [jsonSource('lifecycleSummary'), jsonSource('privacyScan')], {
    cleanInstallPassed: claim.exact(true),
    phase4DataReadPassed: claim.exact(true),
    betaToRcUpgradePassed: claim.exact(true),
    repairPassed: claim.exact(true),
    uninstallPassed: claim.exact(true),
    reinstallPassed: claim.exact(true),
    rollbackPassed: claim.exact(true),
    dataSemanticsMatchD8: claim.exact(true)
  }),
  'WP7-DISPLAY-HARDWARE': policy('phase5.display-hardware.v1', [jsonSource('displayMatrix'), jsonSource('environment')], {
    physicalDualMonitorTested: claim.exact(true),
    negativeCoordinateTested: claim.exact(true),
    mixedDpiTested: claim.exact(true),
    dpi100Tested: claim.exact(true),
    dpi125Tested: claim.exact(true),
    dpi150Tested: claim.exact(true),
    dpi200Tested: claim.exact(true),
    rotationTested: claim.exact(true),
    physicalHotplugTested: claim.exact(true),
    releasePromiseCasesPassed: claim.exact(true)
  }),
  'WP7-APPLICATION-COMPATIBILITY': policy('phase5.application-compatibility.v1', [jsonSource('compatibilityMatrix'), jsonSource('environment')], {
    testedApplications: claim.exact(['Notepad', 'Chrome', 'Edge', 'Word', 'PDF', 'VSCode', 'Terminal', 'ImageOCR']),
    corePathsPassedOrStableDegraded: claim.exact(true),
    correctnessRegression: claim.exact(false),
    unresolvedP0P1: claim.integerMaximum(0)
  }),
  'WP7-PERMISSION-BOUNDARIES': policy('phase5.permission-boundaries.v1', [jsonSource('permissionMatrix'), jsonSource('privacyScan')], {
    standardUserTested: claim.exact(true),
    administratorTargetTested: claim.exact(true),
    passwordFieldTested: claim.exact(true),
    secureDesktopTested: claim.exact(true),
    drmProtectedContentTested: claim.exact(true),
    elevationAttempted: claim.exact(false),
    boundaryBypassObserved: claim.exact(false),
    sensitiveTargetsRejected: claim.exact(true)
  }),
  'WP7-DATA-LIFECYCLE': policy('phase5.data-lifecycle.v1', [jsonSource('dataLifecycleSummary'), jsonSource('privacyScan')], {
    normalUninstallSemanticsPassed: claim.exact(true),
    clearAllLocalDataSemanticsPassed: claim.exact(true),
    reinstallSemanticsPassed: claim.exact(true),
    credentialDeletionVerified: claim.exact(true),
    databaseWalLifecycleVerified: claim.exact(true),
    residualSensitiveHits: claim.integerMaximum(0)
  }),
  'WP7-RESIDUAL-WER-ZERO': policy('phase5.residual-wer-zero.v1', [jsonSource('werReport'), jsonSource('residualReport'), jsonSource('privacyScan')], {
    crashCount: claim.integerMaximum(0),
    hangCount: claim.integerMaximum(0),
    werCount: claim.integerMaximum(0),
    crashDumpCount: claim.integerMaximum(0),
    residualProcessCount: claim.integerMaximum(0),
    privacyHits: claim.integerMaximum(0)
  })
});

assertPolicyRegistryComplete();

const sourceValidator = Object.freeze({
  implemented: (implementation) => ({ kind: 'IMPLEMENTED', implementation }),
  notImplemented: (reason) => ({ kind: 'NOT_IMPLEMENTED', reason })
});

/**
 * Source validation is deliberately separate from envelope validation. An
 * envelope may only repeat claims; it cannot confer trust on an arbitrary
 * report. Gates without a frozen runner/source schema remain blocked here.
 */
export const GATE_SOURCE_VALIDATORS = deepFreeze({
  'G0-SCOPE-FREEZE': sourceValidator.notImplemented('No frozen scope-decision source schema is implemented.'),
  'G1-PHASE4-BASELINE': sourceValidator.notImplemented('No frozen Phase 4 archive/regression source schema is implemented.'),
  'G2-CLEAN-SOURCE': sourceValidator.implemented('CLEAN_WORKSPACE_STATE_V1'),
  'G2-VERSION-TOOLCHAIN': sourceValidator.notImplemented('No frozen version/toolchain environment source schema is implemented.'),
  'WP1-METRICS-PRIVACY': sourceValidator.notImplemented('No frozen instrumentation/privacy source schema is implemented.'),
  'WP2-BASELINE-REGRESSION': sourceValidator.notImplemented('No frozen three-round baseline source schema is implemented.'),
  'WP3-PERF-01': sourceValidator.notImplemented('No formal PERF-01 runner/source schema is implemented.'),
  'WP3-PERF-02': sourceValidator.notImplemented('No formal PERF-02 runner/source schema is implemented.'),
  'WP3-PERF-03': sourceValidator.notImplemented('Formal PERF-03 evidence is not yet independently verified against the terminal privacy report and protected-run provenance; runner summaries alone cannot confer trust.'),
  'WP3-PERF-04': sourceValidator.notImplemented('No formal PERF-04 runner/source schema is implemented.'),
  'WP3-PERF-05': sourceValidator.notImplemented('No formal PERF-05 runner/source schema is implemented.'),
  'WP3-PERF-06': sourceValidator.notImplemented('No formal PERF-06 runner/source schema is implemented.'),
  'WP3-PERF-07': sourceValidator.notImplemented('No formal PERF-07 runner/source schema is implemented.'),
  'WP3-PERF-08': sourceValidator.notImplemented('Formal PERF-08 fault evidence has no independently verifiable fault-controller attestation; scenario-labelled reports cannot confer trust.'),
  'WP3-PERF-09': sourceValidator.notImplemented('The PERF-09 source schema has not yet been frozen into this decision validator.'),
  'WP4-RES-01': sourceValidator.notImplemented('The formal 900-second CPU source schema has not yet been frozen into this decision validator.'),
  'WP4-RES-02': sourceValidator.notImplemented('The formal 900-second memory source schema has not yet been frozen into this decision validator.'),
  'WP4-RES-03': sourceValidator.notImplemented('No formal eight-hour memory-trend source schema is implemented.'),
  'WP4-RES-04': sourceValidator.notImplemented('No formal eight-hour object-trend source schema is implemented.'),
  'WP4-RES-05': sourceValidator.notImplemented('No frozen Host-restart source schema is implemented.'),
  'WP4-RES-06': sourceValidator.notImplemented('No frozen exit/residual source schema is implemented for this gate.'),
  'WP4-LANE-A-8H': sourceValidator.notImplemented('The product Lane A runtime/source contract remains unimplemented.'),
  'WP4-LANE-B-8H': sourceValidator.notImplemented('No final signed-RC Lane B source schema is implemented.'),
  'WP4-FAULT-RECOVERY': sourceValidator.notImplemented('No frozen complete fault-recovery source schema is implemented.'),
  'WP4-PRIVACY-CANARY': sourceValidator.notImplemented('No frozen multi-surface privacy-canary source schema is implemented.'),
  'WP5-PACKAGE-CONTENTS': sourceValidator.notImplemented('The package-content source schema has not yet been frozen into this decision validator.'),
  'WP5-PACKAGE-SIZE': sourceValidator.notImplemented('The package-size source schema has not yet been frozen into this decision validator.'),
  'WP5-SUPPLY-CHAIN': sourceValidator.notImplemented('The supply-chain source set has not yet been frozen into this decision validator.'),
  'WP5-FINAL-RELEASE-MANIFEST': sourceValidator.notImplemented('No trusted verifier currently recomputes the final release manifest from independently verified artifact bytes and protected-run provenance.'),
  'WP5-AUTHENTICODE': sourceValidator.notImplemented('No source validator currently invokes the operating-system trust verifier against the exact bound PE bytes, including revocation and timestamp validation.'),
  'WP5-ARTIFACT-ATTESTATION': sourceValidator.notImplemented('No source validator currently performs offline DSSE/Sigstore verification against independently acquired trust material and the exact artifact subjects.'),
  'WP5-FINAL-MANIFEST-ATTESTATION': sourceValidator.notImplemented('No source validator currently performs offline DSSE/Sigstore verification of the exact final-manifest subject against independently acquired trust material.'),
  'WP5-CLEAN-DOWNLOAD': sourceValidator.notImplemented('No source validator currently verifies independently downloaded artifact bytes, operating-system signatures, attestations, and trust-root independence.'),
  'WP6-DETERMINISTIC-VERIFY': sourceValidator.notImplemented('The deterministic verify-summary source schema has not yet been frozen into this decision validator.'),
  'WP6-FRESH-RUNNER-CI': sourceValidator.notImplemented('No frozen fresh-runner workflow source schema is implemented.'),
  'WP6-RELEASE-GOVERNANCE': sourceValidator.notImplemented('No frozen GitHub governance-report source schema is implemented.'),
  'WP7-CLEAN-VM': sourceValidator.notImplemented('No frozen clean-VM source schema is implemented.'),
  'WP7-INSTALL-UPGRADE-UNINSTALL': sourceValidator.notImplemented('No frozen installer lifecycle source schema is implemented.'),
  'WP7-DISPLAY-HARDWARE': sourceValidator.notImplemented('No frozen physical display-matrix source schema is implemented.'),
  'WP7-APPLICATION-COMPATIBILITY': sourceValidator.notImplemented('No frozen application-compatibility source schema is implemented.'),
  'WP7-PERMISSION-BOUNDARIES': sourceValidator.notImplemented('No frozen permission-boundary source schema is implemented.'),
  'WP7-DATA-LIFECYCLE': sourceValidator.notImplemented('No frozen data-lifecycle source schema is implemented.'),
  'WP7-RESIDUAL-WER-ZERO': sourceValidator.notImplemented('No frozen residual/WER source schema is implemented.')
});

const SOURCE_VALIDATOR_IMPLEMENTATIONS = Object.freeze({
  CLEAN_WORKSPACE_STATE_V1: verifyCleanWorkspaceStateSource,
  PERF03_FORMAL_SUMMARY_V1: verifyPerf03Source,
  PERF08_PROVIDER_SMOKE_V2: verifyProviderSmokeSources,
  FINAL_RELEASE_MANIFEST_V1: verifyFinalManifestGateSource,
  AUTHENTICODE_SIGNATURE_REPORT_V2: verifyAuthenticodeGateSource,
  ARTIFACT_ATTESTATION_DSSE: verifyArtifactAttestationGateSource,
  MANIFEST_ATTESTATION_DSSE: verifyManifestAttestationGateSource,
  CLEAN_DOWNLOAD_VERIFICATION_V1: verifyCleanDownloadGateSource
});

assertSourceValidatorRegistryComplete();

function gate(id, evidenceClass, externalEvidence) {
  return Object.freeze({ id, evidenceClass, externalEvidence });
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function computeAcceptancePayloadDigest(payload) {
  return sha256Text(`${PAYLOAD_DOMAIN}${canonicalJson(payload)}`);
}

export function computeArtifactSetDigest(artifacts) {
  const normalized = normalizeArtifactSet(artifacts);
  return sha256Text(`${ARTIFACT_SET_DOMAIN}${canonicalJson(normalized)}`);
}

export function acceptancePayload(decision) {
  return {
    schemaVersion: decision.schemaVersion,
    phase: decision.phase,
    candidate: structuredClone(decision.candidate),
    gates: structuredClone(decision.gates)
  };
}

export async function evaluateAcceptanceDecision(input, options = {}) {
  assertDraftStructure(input);
  const workspaceRoot = resolve(options.workspaceRoot ?? resolve(import.meta.dirname, '..'));
  const now = options.now ?? new Date().toISOString();
  const evidenceSnapshots = [];
  const decision = {
    schemaVersion: 1,
    phase: 5,
    candidate: structuredClone(input.candidate),
    gates: structuredClone(input.gates),
    payload: {
      algorithm: 'sha256',
      canonicalization: CANONICALIZATION,
      sha256: ''
    },
    approvals: structuredClone(input.approvals),
    repositoryState: {
      before: unavailableRepositoryState(),
      after: unavailableRepositoryState()
    },
    evaluatedAt: now,
    status: 'PENDING',
    acceptance: false,
    pending: [],
    blockers: [],
    acceptanceRule: ACCEPTANCE_RULE
  };
  decision.payload.sha256 = computeAcceptancePayloadDigest(acceptancePayload(decision));

  decision.repositoryState.before = await captureRepositoryState(decision, readGitRepositoryState, workspaceRoot, 'before');

  let finalManifest;
  let cleanDownload;
  const candidateBindings = [
    ['finalReleaseManifest', decision.candidate.finalReleaseManifest],
    ['cleanDownloadVerification', decision.candidate.cleanDownloadVerification]
  ];
  for (const [label, binding] of candidateBindings) {
    const result = await readBoundFile(workspaceRoot, binding, evidenceSnapshots, `candidate.${label}`);
    if (!result.ok) {
      addBlocker(decision, `CANDIDATE_${toCode(label)}_INVALID`, label, result.detail);
      continue;
    }
    try {
      const parsed = parseJsonBytes(result.bytes);
      if (label === 'finalReleaseManifest') finalManifest = parsed;
      else cleanDownload = parsed;
    } catch {
      addBlocker(decision, `CANDIDATE_${toCode(label)}_MALFORMED`, label, 'The bound file is not valid JSON.');
    }
  }

  if (finalManifest) verifyFinalManifestBinding(decision, finalManifest);
  if (cleanDownload) verifyCleanDownloadBinding(decision, cleanDownload, finalManifest);

  const verifiedGates = new Map();
  for (const item of decision.gates) {
    if (item.status === 'PENDING') {
      decision.pending.push(`gate:${item.id}`);
      continue;
    }
    if (item.status === 'BLOCKED') {
      addBlocker(decision, 'GATE_BLOCKED', item.id, item.note ?? 'The frozen acceptance gate is blocked.');
      continue;
    }
    const policy_ = GATE_VALIDATION_POLICIES[item.id];
    if (!policy_) {
      addBlocker(decision, 'GATE_VALIDATOR_MISSING', item.id, 'No explicit validation policy exists for this frozen gate.');
      continue;
    }
    const result = await verifyGateEvidenceEnvelope(
      decision,
      workspaceRoot,
      item,
      policy_,
      evidenceSnapshots
    );
    if (result) verifiedGates.set(item.id, result);
  }

  verifyCriticalEvidenceBindings(decision, verifiedGates, finalManifest, cleanDownload);
  verifyApprovals(decision);
  await reverifyEvidenceSnapshots(decision, workspaceRoot, evidenceSnapshots);
  decision.repositoryState.after = await captureRepositoryState(decision, readGitRepositoryState, workspaceRoot, 'after');

  if (decision.blockers.length > 0) {
    decision.status = 'BLOCKED';
  } else if (decision.pending.length > 0) {
    decision.status = 'PENDING';
  } else {
    decision.status = 'PASS';
    decision.acceptance = true;
  }

  await validateDecisionSchema(decision, options.schemaPath);
  return decision;
}

async function captureRepositoryState(decision, provider, workspaceRoot, checkpoint) {
  let state;
  try {
    state = normalizeRepositoryState(await provider({ workspaceRoot, checkpoint }));
  } catch {
    addBlocker(decision, `REPOSITORY_STATE_${checkpoint.toUpperCase()}_UNAVAILABLE`, 'candidate', `The Git repository state could not be verified ${checkpoint} evidence evaluation.`);
    return unavailableRepositoryState();
  }
  if (state.gitSha !== decision.candidate.gitSha) {
    addBlocker(decision, `REPOSITORY_HEAD_${checkpoint.toUpperCase()}_MISMATCH`, 'candidate', `Repository HEAD ${checkpoint} evidence evaluation differs from candidate.gitSha.`);
  }
  if (!state.clean) {
    addBlocker(decision, `REPOSITORY_DIRTY_${checkpoint.toUpperCase()}`, 'candidate', `The repository was dirty ${checkpoint} evidence evaluation.`);
  }
  return { ...state, verified: state.gitSha === decision.candidate.gitSha && state.clean };
}

function normalizeRepositoryState(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Repository state must be an object.');
  assert(GIT_SHA_PATTERN.test(value.gitSha), 'Repository state gitSha must be a lowercase full Git SHA.');
  assert(typeof value.clean === 'boolean', 'Repository state clean must be boolean.');
  return { gitSha: value.gitSha, clean: value.clean };
}

function unavailableRepositoryState() {
  return { gitSha: null, clean: false, verified: false };
}

async function readGitRepositoryState({ workspaceRoot }) {
  const rootResult = await runGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
  const [realWorkspaceRoot, realRepositoryRoot] = await Promise.all([
    realpath(workspaceRoot),
    realpath(rootResult.trim())
  ]);
  if (relative(realWorkspaceRoot, realRepositoryRoot) !== '') {
    throw new Error('workspaceRoot must be the exact Git repository root.');
  }
  const headBefore = (await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD'])).trim().toLowerCase();
  const statusResult = await runGit(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  const headAfter = (await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD'])).trim().toLowerCase();
  if (headBefore !== headAfter) throw new Error('Git HEAD changed while repository status was captured.');
  const gitSha = headAfter;
  assert(GIT_SHA_PATTERN.test(gitSha), 'Git returned an invalid HEAD identity.');
  return { gitSha, clean: statusResult.length === 0 };
}

async function runGit(workspaceRoot, arguments_) {
  const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, ...arguments_], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function verifyGateEvidenceEnvelope(decision, workspaceRoot, item, policy_, snapshots) {
  const evidenceResult = await readBoundFile(workspaceRoot, item.evidence, snapshots, `gate.${item.id}.envelope`);
  if (!evidenceResult.ok) {
    addBlocker(decision, 'GATE_EVIDENCE_INVALID', item.id, evidenceResult.detail);
    return undefined;
  }
  let envelope;
  try {
    envelope = parseJsonBytes(evidenceResult.bytes);
  } catch {
    addBlocker(decision, 'GATE_EVIDENCE_NOT_JSON', item.id, 'PASS gate evidence must be a strict JSON envelope.');
    return undefined;
  }
  const errors = validateEnvelopeShape(envelope, item, decision.candidate, policy_);
  if (errors.length > 0) {
    for (const detail of errors) addBlocker(decision, 'GATE_EVIDENCE_SEMANTIC_INVALID', item.id, detail);
    return undefined;
  }

  const sourceResults = new Map();
  for (const source of envelope.sources) {
    if (source.path === item.evidence.path) {
      addBlocker(decision, 'GATE_SOURCE_INVALID', item.id, `Source '${source.role}' must not reference its own envelope.`);
      continue;
    }
    const sourceResult = await readBoundFile(workspaceRoot, source, snapshots, `gate.${item.id}.source.${source.role}`);
    if (!sourceResult.ok) {
      addBlocker(decision, 'GATE_SOURCE_INVALID', item.id, `Source '${source.role}' is invalid: ${sourceResult.detail}`);
      continue;
    }
    let parsed;
    try {
      parsed = parseSourceBytes(sourceResult.bytes, source.mediaType);
    } catch {
      addBlocker(decision, 'GATE_SOURCE_MALFORMED', item.id, `Source '${source.role}' does not match mediaType '${source.mediaType}'.`);
      continue;
    }
    sourceResults.set(source.role, { binding: source, bytes: sourceResult.bytes, parsed });
  }
  if (sourceResults.size !== policy_.sources.length) return undefined;
  const verified = { envelope, sourceResults };
  return verifyGateSourceSemantics(decision, item, verified)
    ? verified
    : undefined;
}

function verifyGateSourceSemantics(decision, item, verified) {
  const descriptor = GATE_SOURCE_VALIDATORS[item.id];
  if (!descriptor) {
    addBlocker(decision, 'GATE_SOURCE_VALIDATOR_MISSING', item.id, 'No source-validator registry entry exists for this frozen gate.');
    return false;
  }
  if (descriptor.kind === 'NOT_IMPLEMENTED') {
    addBlocker(decision, 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED', item.id, descriptor.reason);
    return false;
  }
  const implementation = SOURCE_VALIDATOR_IMPLEMENTATIONS[descriptor.implementation];
  if (typeof implementation !== 'function') {
    addBlocker(decision, 'GATE_SOURCE_VALIDATOR_MISSING', item.id, `Source-validator implementation '${descriptor.implementation}' is unavailable.`);
    return false;
  }
  const blockerCountBefore = decision.blockers.length;
  implementation(decision, verified);
  return decision.blockers.length === blockerCountBefore;
}

function verifyCleanWorkspaceStateSource(decision, verified) {
  const state = verified.sourceResults.get('workspaceState')?.parsed;
  const errors = [];
  if (!isPlainObject(state)) {
    errors.push('workspaceState must be a JSON object.');
  } else {
    assertExactKeys(state, [
      'schemaVersion',
      'headSha',
      'sourceIdentity',
      'developmentDirty',
      'acceptanceEligible',
      'patchDigest',
      'statusDigest',
      'trackedPatchSha256',
      'untrackedFileCount',
      'untrackedBytes',
      'captureMode'
    ], errors, 'workspaceState');
    if (state.schemaVersion !== 1) errors.push('workspaceState.schemaVersion must be 1.');
    if (state.headSha !== decision.candidate.gitSha) errors.push('workspaceState.headSha must equal candidate.gitSha.');
    if (state.sourceIdentity !== `HEAD:${decision.candidate.gitSha}`) errors.push('workspaceState.sourceIdentity must identify the exact clean candidate HEAD.');
    if (state.developmentDirty !== false) errors.push('workspaceState.developmentDirty must be false.');
    if (state.acceptanceEligible !== true) errors.push('workspaceState.acceptanceEligible must be true.');
    if (state.patchDigest !== null) errors.push('workspaceState.patchDigest must be null.');
    if (state.statusDigest !== EMPTY_SHA256) errors.push('workspaceState.statusDigest must be the SHA-256 of an empty Git status.');
    if (state.trackedPatchSha256 !== EMPTY_SHA256) errors.push('workspaceState.trackedPatchSha256 must be the SHA-256 of an empty tracked patch.');
    if (!Object.is(state.untrackedFileCount, 0)) errors.push('workspaceState.untrackedFileCount must be the integer 0.');
    if (!Object.is(state.untrackedBytes, 0)) errors.push('workspaceState.untrackedBytes must be the integer 0.');
    if (state.captureMode !== 'signed') errors.push("workspaceState.captureMode must be 'signed'.");

    const claims = verified.envelope.claims;
    if (
      state.headSha !== claims.sourceGitSha
      || claims.worktreeClean !== true
      || state.developmentDirty !== claims.developmentDirty
      || state.patchDigest !== claims.patchDigest
    ) {
      errors.push('workspaceState must agree with every clean-source envelope claim.');
    }
  }

  const repositoryState = decision.repositoryState.before;
  if (
    repositoryState.verified !== true
    || repositoryState.clean !== true
    || repositoryState.gitSha !== decision.candidate.gitSha
    || (isPlainObject(state) && repositoryState.gitSha !== state.headSha)
  ) {
    errors.push('workspaceState must agree with the evaluator independently captured clean repository state.');
  }

  for (const detail of errors) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'G2-CLEAN-SOURCE', detail);
  }
}

function verifyPerf03Source(decision, verified) {
  const summary = verified.sourceResults.get('summary')?.parsed;
  const { candidate } = decision;
  const roundsPass = Array.isArray(summary?.rounds)
    && summary.rounds.length === 3
    && summary.rounds.every((round, index) => (
      round?.round === index + 1
      && round.configuredSampleCount === 100
      && round.successCount === 100
      && round.failureCount === 0
      && Number.isFinite(round.p50Ms)
      && round.p50Ms <= 700
      && Number.isFinite(round.p95Ms)
      && round.p95Ms <= 1500
      && round.forcedTerminationCount === 0
      && round.status === 'PASS'
      && Array.isArray(round.stableFailureCodes)
      && round.stableFailureCodes.length === 0
    ));
  const gatesPass = isPlainObject(summary?.gates)
    && Object.values(summary.gates).every((value) => value === 'PASS');
  if (
    summary?.schemaVersion !== 'phase5-perf03-summary-v1'
    || summary.metricId !== 'PERF-03'
    || summary.status !== 'PASS'
    || summary.acceptance !== true
    || summary.evidenceLevel !== 'fixed-lab-benchmark'
    || summary.buildMode !== 'signed-rc'
    || summary.configuredRoundCount !== 3
    || summary.configuredSamplesPerRound !== 100
    || summary.statisticsMethod !== 'nearest-rank'
    || summary.thresholds?.p50Ms !== 700
    || summary.thresholds?.p95Ms !== 1500
    || summary.thresholds?.failureCount !== 0
    || summary.gitSha !== candidate.gitSha
    || summary.artifact?.finalReleaseManifestSha256 !== candidate.finalReleaseManifest.sha256
    || summary.artifact?.cleanDownloadVerificationSha256 !== candidate.cleanDownloadVerification.sha256
    || summary.artifact?.acceptanceEligibleManifestBound !== true
    || summary.artifact?.signedReleaseIdentityBound !== true
    || summary.artifact?.attestedFinalReleaseBound !== true
    || summary.artifact?.independentCleanDownloadBound !== true
    || !SHA256_PATTERN.test(summary.artifact?.independentTrustedRootSha256 ?? '')
    || summary.run?.workflowName !== 'phase5-perf03-host-ready'
    || summary.run?.dedicatedInteractiveSession !== true
    || summary.run?.foregroundInputExclusive !== true
    || !SHA256_PATTERN.test(summary.run?.runMetadataSha256 ?? '')
    || summary.totalFailureCount !== 0
    || summary.forcedTerminationCount !== 0
    || !roundsPass
    || !gatesPass
    || !Array.isArray(summary.stableFailureCodes)
    || summary.stableFailureCodes.length !== 0
    || Number.isNaN(Date.parse(summary.completedAt))
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-03', 'The primary summary is not a formal phase5-perf03-summary-v1 PASS bound to this signed, attested candidate.');
  }
}

function verifyProviderSmokeSources(decision, verified) {
  const { candidate } = decision;
  const aggregate = verified.sourceResults.get('aggregate')?.parsed;
  const health = verified.sourceResults.get('health')?.parsed;
  const metadataRecord = verified.sourceResults.get('runMetadata');
  const faultRoles = new Map([
    ['timeout', 'faultTimeout'],
    ['network-unavailable', 'faultNetworkUnavailable'],
    ['malformed-response', 'faultMalformedResponse'],
    ['recovery', 'faultRecovery']
  ]);
  const identityMatches = (identity) => isPlainObject(identity)
    && identity.gitSha === candidate.gitSha
    && identity.artifactSetDigest === candidate.artifactSetDigest
    && SHA256_PATTERN.test(identity.runMetadataSha256 ?? '')
    && identity.workflowName === 'phase5-provider-smoke';
  const healthTargetsPass = Array.isArray(health?.healthTargets)
    && canonicalJson(health.healthTargets.map(({ targetLanguage }) => targetLanguage).sort()) === canonicalJson(['en', 'ja', 'ko'])
    && health.healthTargets.every((target) => (
      target.attemptCount === 10
      && target.successCount === 10
      && target.failureCount === 0
      && Number.isFinite(target.durationMs?.max)
      && target.durationMs.max <= 8000
      && target.durationMs.p95 === target.durationMs.max
    ));
  if (
    aggregate?.schemaVersion !== 'phase5-provider-smoke-v2'
    || aggregate.evidenceKind !== 'aggregate'
    || aggregate.formal !== true
    || aggregate.providerBoundary !== 'REAL_BAIDU_PRODUCT_PROVIDER'
    || aggregate.acceptance !== false
    || aggregate.perf08Status !== 'PASS'
    || aggregate.sourceTextId !== 'PERF08_PUBLIC_ZH_SHORT_V1'
    || aggregate.stableCode !== 'PASS'
    || !identityMatches(aggregate.identity)
    || aggregate.healthEvidenceSha256 !== verified.sourceResults.get('health')?.binding.sha256
    || !Array.isArray(aggregate.faultEvidenceDigests)
    || aggregate.faultEvidenceDigests.length !== faultRoles.size
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', 'The aggregate source is not a formal real-provider PERF-08 PASS bound to this candidate and exact child evidence.');
    return;
  }
  if (
    health?.schemaVersion !== 'phase5-provider-smoke-v2'
    || health.evidenceKind !== 'health'
    || health.formal !== true
    || health.providerBoundary !== 'REAL_BAIDU_PRODUCT_PROVIDER'
    || health.acceptance !== false
    || health.perf08Status !== 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED'
    || health.statisticsMethod !== 'nearest-rank'
    || health.p95Interpretation !== 'N10_NEAREST_RANK_P95_EQUALS_MAX'
    || health.targetCount !== 3
    || health.samplesPerTarget !== 10
    || health.stableCode !== 'HEALTH_PASS'
    || !identityMatches(health.identity)
    || !healthTargetsPass
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', 'The bound health source is not the exact formal 3-language x 10 real-provider health PASS.');
  }
  const aggregateByScenario = new Map(aggregate.faultEvidenceDigests.map((entry) => [entry.scenario, entry.sha256]));
  const faultControlIds = new Map();
  for (const [scenario, role] of faultRoles) {
    const source = verified.sourceResults.get(role);
    const fault = source?.parsed;
    const expectedCode = scenario === 'recovery' ? 'success' : scenario === 'malformed-response' ? 'malformed-response' : 'network-unavailable';
    if (
      fault?.schemaVersion !== 'phase5-provider-smoke-v2'
      || fault.evidenceKind !== 'fault'
      || fault.formal !== true
      || fault.providerBoundary !== 'REAL_BAIDU_PRODUCT_PROVIDER'
      || fault.acceptance !== false
      || fault.perf08Status !== 'BLOCKED_AGGREGATION_REQUIRED'
      || fault.scenario !== scenario
      || fault.attemptCount !== 1
      || fault.observedStableCode !== expectedCode
      || fault.scenarioStatus !== 'PASS'
      || fault.stableCode !== 'SCENARIO_PASS'
      || !identityMatches(fault.identity)
      || aggregateByScenario.get(scenario) !== source?.binding.sha256
      || typeof fault.faultControlId !== 'string'
      || fault.faultControlId.length === 0
    ) {
      addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', `Fault source '${scenario}' is not an exact formal PASS bound by the aggregate.`);
      continue;
    }
    faultControlIds.set(scenario, fault.faultControlId);
    if (scenario !== 'recovery' && (!Array.isArray(fault.recoveryOfControlIds) || fault.recoveryOfControlIds.length !== 0)) {
      addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', `Fault source '${scenario}' has invalid recovery bindings.`);
    }
  }
  const recovery = verified.sourceResults.get('faultRecovery')?.parsed;
  const expectedRecoveryControls = [...faultControlIds.entries()].filter(([scenario]) => scenario !== 'recovery').map(([, controlId]) => controlId).sort();
  if (!Array.isArray(recovery?.recoveryOfControlIds) || canonicalJson([...recovery.recoveryOfControlIds].sort()) !== canonicalJson(expectedRecoveryControls)) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', 'Recovery evidence is not bound to all three prior fault controls.');
  }
  if (
    aggregate.identity.runMetadataSha256 !== metadataRecord?.binding.sha256
    || metadataRecord?.parsed?.schemaVersion !== 'phase5-provider-smoke-run-metadata-v1'
    || metadataRecord.parsed.run?.workflowName !== 'phase5-provider-smoke'
    || metadataRecord.parsed.run?.evidenceLevel !== 'provider-smoke'
    || metadataRecord.parsed.run?.dedicatedInteractiveSession !== true
    || metadataRecord.parsed.run?.foregroundInputExclusive !== true
    || metadataRecord.parsed.run?.debuggerClosed !== true
    || metadataRecord.parsed.run?.unrelatedForegroundTasksClosed !== true
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP3-PERF-08', 'Provider run metadata is not the exact exclusive formal session bound by the aggregate identity.');
  }
}

function verifyFinalManifestGateSource(decision, verified) {
  const source = verified.sourceResults.get('finalReleaseManifest');
  const manifest = source?.parsed;
  const { candidate } = decision;
  let artifactSetDigest;
  try {
    artifactSetDigest = computeArtifactSetDigest(manifest?.artifacts);
  } catch {
    artifactSetDigest = null;
  }
  if (
    source?.binding.path !== candidate.finalReleaseManifest.path
    || source?.binding.sha256 !== candidate.finalReleaseManifest.sha256
    || manifest?.schemaVersion !== 1
    || manifest.productVersion !== candidate.productVersion
    || manifest.source?.gitSha !== candidate.gitSha
    || manifest.source?.developmentDirty !== false
    || manifest.source?.patchDigest !== null
    || manifest.packageSmoke?.status !== 'PASS'
    || manifest.packageEvidence?.status !== 'PASS'
    || manifest.supplyChain?.status !== 'PASS'
    || artifactSetDigest !== candidate.artifactSetDigest
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP5-FINAL-RELEASE-MANIFEST', 'The final-manifest source is not the exact clean candidate release manifest with package and supply-chain PASS.');
  }
}

function verifyAuthenticodeGateSource(decision, verified) {
  const report = verified.sourceResults.get('signatureReport')?.parsed;
  if (
    report?.schemaVersion !== 2
    || report.status !== 'PASS'
    || report.requireSigned !== true
    || typeof report.expectedSubject !== 'string'
    || report.expectedSubject.length === 0
    || canonicalJson(report.exactArtifactRoles) !== canonicalJson(EXACT_SIGNED_ARTIFACT_ROLES)
    || !Array.isArray(report.blockers)
    || report.blockers.length !== 0
    || !Array.isArray(report.artifacts)
    || report.artifacts.length !== EXACT_SIGNED_ARTIFACT_ROLES.length
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP5-AUTHENTICODE', 'The signature source is not a signed, exact-role Authenticode PASS report.');
  }
}

function verifyArtifactAttestationGateSource(decision, verified) {
  const bundle = verified.sourceResults.get('artifactAttestation')?.parsed;
  const trustedRoot = verified.sourceResults.get('trustedRoot')?.parsed;
  if (!containsDsseEnvelope(bundle) || !Array.isArray(trustedRoot) || trustedRoot.length === 0) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP5-ARTIFACT-ATTESTATION', 'Artifact attestation must contain a DSSE envelope and a non-empty independently bound trusted root.');
  }
}

function verifyManifestAttestationGateSource(decision, verified) {
  const bundle = verified.sourceResults.get('manifestAttestation')?.parsed;
  const trustedRoot = verified.sourceResults.get('trustedRoot')?.parsed;
  if (!containsDsseEnvelope(bundle) || !Array.isArray(trustedRoot) || trustedRoot.length === 0) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP5-FINAL-MANIFEST-ATTESTATION', 'Manifest attestation must contain a DSSE envelope and a non-empty independently bound trusted root.');
  }
}

function verifyCleanDownloadGateSource(decision, verified) {
  const source = verified.sourceResults.get('cleanDownloadVerification');
  const verification = source?.parsed;
  const trustedRoot = verified.sourceResults.get('independentTrustedRoot')?.parsed;
  const { candidate } = decision;
  let artifactSetDigest;
  try {
    artifactSetDigest = computeArtifactSetDigest(verification?.exactArtifacts);
  } catch {
    artifactSetDigest = null;
  }
  if (
    source?.binding.path !== candidate.cleanDownloadVerification.path
    || source?.binding.sha256 !== candidate.cleanDownloadVerification.sha256
    || verification?.schemaVersion !== 1
    || verification.status !== 'PASS'
    || verification.releaseStatus !== 'PASS'
    || verification.sourceDigest !== candidate.gitSha
    || verification.finalManifestSha256 !== candidate.finalReleaseManifest.sha256
    || verification.trustedRootSha256 !== verification.independentlyAcquiredTrustedRootSha256
    || artifactSetDigest !== candidate.artifactSetDigest
    || !Array.isArray(trustedRoot)
    || trustedRoot.length === 0
  ) {
    addBlocker(decision, 'GATE_SOURCE_SEMANTIC_INVALID', 'WP5-CLEAN-DOWNLOAD', 'The clean-download source is not the exact independent PASS verification for this candidate artifact set and trusted root.');
  }
}

function validateEnvelopeShape(envelope, item, candidate, policy_) {
  const errors = [];
  if (!isPlainObject(envelope)) return ['The gate evidence envelope must be an object.'];
  assertExactKeys(envelope, ['schemaVersion', 'phase', 'gateId', 'evidenceClass', 'externalEvidence', 'status', 'acceptance', 'candidate', 'validator', 'claims', 'sources'], errors, 'envelope');
  if (envelope.schemaVersion !== 1 || envelope.phase !== 5) errors.push('Envelope schemaVersion/phase must be 1/5.');
  if (envelope.gateId !== item.id) errors.push('Envelope gateId does not match the frozen gate.');
  if (envelope.evidenceClass !== item.evidenceClass || envelope.externalEvidence !== item.externalEvidence) errors.push('Envelope evidence class/boundary differs from the frozen gate.');
  if (envelope.status !== 'PASS' || envelope.acceptance !== true) errors.push('A PASS gate requires envelope status=PASS and acceptance=true.');

  if (!isPlainObject(envelope.candidate)) {
    errors.push('Envelope candidate binding must be an object.');
  } else {
    assertExactKeys(envelope.candidate, ['gitSha', 'artifactSetDigest'], errors, 'envelope.candidate');
    if (envelope.candidate.gitSha !== candidate.gitSha || envelope.candidate.artifactSetDigest !== candidate.artifactSetDigest) {
      errors.push('Envelope candidate binding differs from the exact acceptance candidate.');
    }
  }
  if (!isPlainObject(envelope.validator)) {
    errors.push('Envelope validator must be an object.');
  } else {
    assertExactKeys(envelope.validator, ['id', 'version'], errors, 'envelope.validator');
    if (envelope.validator.id !== policy_.validatorId || envelope.validator.version !== 1) errors.push('Envelope validator identity/version is not the frozen policy.');
  }
  validateClaims(envelope.claims, policy_.claims, candidate, errors);
  validateSourceShapes(envelope.sources, policy_.sources, errors);
  return errors;
}

function validateClaims(claims, claimPolicy, candidate, errors) {
  if (!isPlainObject(claims)) {
    errors.push('Envelope claims must be an object.');
    return;
  }
  assertExactKeys(claims, Object.keys(claimPolicy), errors, 'envelope.claims');
  for (const [name, rule] of Object.entries(claimPolicy)) {
    const value = claims[name];
    if (rule.kind === 'exact' && canonicalJson(value) !== canonicalJson(rule.value)) {
      errors.push(`Claim '${name}' must equal the frozen value.`);
    } else if (rule.kind === 'maximum' && (!Number.isFinite(value) || value > rule.value)) {
      errors.push(`Claim '${name}' exceeds the frozen maximum ${rule.value}.`);
    } else if (rule.kind === 'minimum' && (!Number.isFinite(value) || value < rule.value)) {
      errors.push(`Claim '${name}' is below the frozen minimum ${rule.value}.`);
    } else if (rule.kind === 'integerMaximum' && (!Number.isSafeInteger(value) || value > rule.value)) {
      errors.push(`Claim '${name}' exceeds the frozen integer maximum ${rule.value}.`);
    } else if (rule.kind === 'integerMinimum' && (!Number.isSafeInteger(value) || value < rule.value)) {
      errors.push(`Claim '${name}' is below the frozen integer minimum ${rule.value}.`);
    } else if (rule.kind === 'candidateGitSha' && value !== candidate.gitSha) {
      errors.push(`Claim '${name}' is not bound to candidate.gitSha.`);
    } else if (rule.kind === 'candidateArtifactSetDigest' && value !== candidate.artifactSetDigest) {
      errors.push(`Claim '${name}' is not bound to candidate.artifactSetDigest.`);
    } else if (rule.kind === 'phase5Tag' && (typeof value !== 'string' || !PHASE5_TAG_PATTERN.test(value))) {
      errors.push(`Claim '${name}' is not a Phase 5 RC tag ref.`);
    }
  }
}

function validateSourceShapes(sources, sourcePolicy, errors) {
  if (!Array.isArray(sources) || sources.length !== sourcePolicy.length) {
    errors.push(`Envelope sources must contain exactly ${sourcePolicy.length} entries.`);
    return;
  }
  const seenPaths = new Set();
  sources.forEach((source, index) => {
    const expected = sourcePolicy[index];
    if (!isPlainObject(source)) {
      errors.push(`Envelope source[${index}] must be an object.`);
      return;
    }
    assertExactKeys(source, ['role', 'mediaType', 'path', 'sha256'], errors, `envelope.sources[${index}]`);
    if (source.role !== expected.role || source.mediaType !== expected.mediaType) errors.push(`Envelope source[${index}] must be role '${expected.role}' and mediaType '${expected.mediaType}'.`);
    try {
      assertFileBindingShape(source, `envelope.sources[${index}]`);
    } catch (error) {
      errors.push(error.message);
    }
    if (seenPaths.has(source.path)) errors.push('Envelope source paths must be unique within a gate.');
    seenPaths.add(source.path);
  });
}

function parseSourceBytes(bytes, mediaType) {
  if (mediaType === 'application/json') return parseJsonBytes(bytes);
  const text = bytes.toString('utf8');
  assert(text.length > 0 && !text.includes('\0'), 'Text evidence must be non-empty UTF-8 text.');
  if (mediaType === 'application/jsonl') {
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    assert(lines.length > 0, 'JSONL evidence must contain at least one record.');
    return lines.map((line) => JSON.parse(line));
  }
  assert(mediaType === 'text/plain', 'Unsupported evidence media type.');
  return text;
}

function parseJsonBytes(bytes) {
  const text = bytes.toString('utf8');
  assert(!text.includes('\0'), 'JSON evidence contains NUL.');
  return JSON.parse(text);
}

function verifyFinalManifestBinding(decision, manifest) {
  const { candidate } = decision;
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) {
    addBlocker(decision, 'FINAL_MANIFEST_SCHEMA_INVALID', 'candidate', 'Final release manifest schemaVersion must be 1.');
    return;
  }
  if (manifest.productVersion !== candidate.productVersion) {
    addBlocker(decision, 'FINAL_MANIFEST_VERSION_MISMATCH', 'candidate', 'Final release manifest productVersion differs from the candidate.');
  }
  if (manifest.source?.repository !== OFFICIAL_REPOSITORY || manifest.source?.gitSha !== candidate.gitSha || manifest.source?.developmentDirty !== false || manifest.source?.patchDigest !== null || !PHASE5_TAG_PATTERN.test(manifest.source?.ref ?? '')) {
    addBlocker(decision, 'FINAL_MANIFEST_SOURCE_MISMATCH', 'candidate', 'Final release manifest is not bound to the clean candidate Git SHA and a Phase 5 RC tag.');
  }
  if (manifest.packageSmoke?.status !== 'PASS' || manifest.packageEvidence?.status !== 'PASS' || manifest.supplyChain?.status !== 'PASS') {
    addBlocker(decision, 'FINAL_MANIFEST_RELEASE_EVIDENCE_NOT_PASS', 'candidate', 'Final release manifest package smoke, package evidence, and supply-chain status must all be PASS.');
  }
  if (manifest.authenticode?.status !== 'PASS' || !SHA256_PATTERN.test(manifest.authenticode?.signatureReportSha256 ?? '') || typeof manifest.authenticode?.expectedSubject !== 'string' || manifest.authenticode.expectedSubject.length === 0 || canonicalJson(manifest.authenticode?.exactArtifactRoles) !== canonicalJson(EXACT_SIGNED_ARTIFACT_ROLES)) {
    addBlocker(decision, 'AUTHENTICODE_NOT_PASS', 'candidate', 'Final release manifest does not record the exact Authenticode PASS contract.');
  }
  if (manifest.independentTrustRoot?.status !== 'PASS' || manifest.independentTrustRoot?.type !== 'github-artifact-attestation-sigstore' || manifest.independentTrustRoot?.repository !== OFFICIAL_REPOSITORY || manifest.independentTrustRoot?.sourceDigest !== candidate.gitSha || manifest.independentTrustRoot?.sourceRef !== manifest.source?.ref || manifest.independentTrustRoot?.signerWorkflow !== officialSignerWorkflow() || !SHA256_PATTERN.test(manifest.independentTrustRoot?.artifactBundleSha256 ?? '') || !SHA256_PATTERN.test(manifest.independentTrustRoot?.trustedRootSha256 ?? '')) {
    addBlocker(decision, 'ARTIFACT_ATTESTATION_NOT_PASS', 'candidate', 'Final release manifest does not record the exact independent artifact-attestation trust contract.');
  }
  try {
    const digest = computeArtifactSetDigest(manifest.artifacts);
    if (digest !== candidate.artifactSetDigest) {
      addBlocker(decision, 'ARTIFACT_SET_DIGEST_MISMATCH', 'candidate', 'Candidate artifactSetDigest differs from the exact final manifest artifact set.');
    }
  } catch (error) {
    addBlocker(decision, 'FINAL_MANIFEST_ARTIFACT_SET_INVALID', 'candidate', error.message);
  }
}

function verifyCleanDownloadBinding(decision, verification, finalManifest) {
  const { candidate } = decision;
  if (!isPlainObject(verification) || verification.schemaVersion !== 1 || verification.status !== 'PASS' || verification.releaseStatus !== 'PASS') {
    addBlocker(decision, 'CLEAN_DOWNLOAD_NOT_PASS', 'candidate', 'Clean-download verification must have schemaVersion 1 and status/releaseStatus PASS.');
    return;
  }
  if (verification.repository !== OFFICIAL_REPOSITORY || verification.sourceDigest !== candidate.gitSha || !PHASE5_TAG_PATTERN.test(verification.sourceRef ?? '') || verification.signerWorkflow !== officialSignerWorkflow() || (finalManifest && (verification.repository !== finalManifest.source?.repository || verification.sourceRef !== finalManifest.source?.ref || verification.signerWorkflow !== finalManifest.independentTrustRoot?.signerWorkflow))) {
    addBlocker(decision, 'CLEAN_DOWNLOAD_SOURCE_MISMATCH', 'candidate', 'Clean-download source/repository/workflow identity differs from the candidate final manifest.');
  }
  if (verification.finalManifestSha256 !== candidate.finalReleaseManifest.sha256) {
    addBlocker(decision, 'CLEAN_DOWNLOAD_MANIFEST_MISMATCH', 'candidate', 'Clean-download verification is bound to another final release manifest.');
  }
  if (!SHA256_PATTERN.test(verification.manifestAttestationSha256 ?? '') || !SHA256_PATTERN.test(verification.trustedRootSha256 ?? '') || verification.trustedRootSha256 !== verification.independentlyAcquiredTrustedRootSha256 || (finalManifest && verification.authenticodeSubject !== finalManifest.authenticode?.expectedSubject)) {
    addBlocker(decision, 'CLEAN_DOWNLOAD_TRUST_ROOT_MISMATCH', 'candidate', 'Clean-download verification does not bind the independently acquired trust root, manifest attestation, and Authenticode subject.');
  }
  try {
    const digest = computeArtifactSetDigest(verification.exactArtifacts);
    if (digest !== candidate.artifactSetDigest) {
      addBlocker(decision, 'CLEAN_DOWNLOAD_ARTIFACT_SET_MISMATCH', 'candidate', 'Clean-download artifact set differs from the candidate artifactSetDigest.');
    }
    if (finalManifest && canonicalJson(normalizeArtifactSet(finalManifest.artifacts)) !== canonicalJson(normalizeArtifactSet(verification.exactArtifacts))) {
      addBlocker(decision, 'CLEAN_DOWNLOAD_EXACT_SET_MISMATCH', 'candidate', 'Final manifest and clean-download exact artifact records differ.');
    }
  } catch (error) {
    addBlocker(decision, 'CLEAN_DOWNLOAD_ARTIFACT_SET_INVALID', 'candidate', error.message);
  }
}

function verifyCriticalEvidenceBindings(decision, verifiedGates, finalManifest, cleanDownload) {
  if (!finalManifest || !cleanDownload) return;
  const manifestGate = verifiedGates.get('WP5-FINAL-RELEASE-MANIFEST');
  const authenticodeGate = verifiedGates.get('WP5-AUTHENTICODE');
  const artifactAttestationGate = verifiedGates.get('WP5-ARTIFACT-ATTESTATION');
  const manifestAttestationGate = verifiedGates.get('WP5-FINAL-MANIFEST-ATTESTATION');
  const cleanDownloadGate = verifiedGates.get('WP5-CLEAN-DOWNLOAD');

  if (manifestGate) assertSourceBinding(decision, manifestGate, 'finalReleaseManifest', decision.candidate.finalReleaseManifest, 'The final-manifest gate must source the exact candidate final release manifest.');
  if (authenticodeGate) assertSourceDigest(decision, authenticodeGate, 'signatureReport', finalManifest.authenticode?.signatureReportSha256, 'The Authenticode gate must source the signature report referenced by the final manifest.');
  if (artifactAttestationGate) {
    assertSourceDigest(decision, artifactAttestationGate, 'artifactAttestation', finalManifest.independentTrustRoot?.artifactBundleSha256, 'The artifact-attestation gate must source the final manifest artifact bundle.');
    assertSourceDigest(decision, artifactAttestationGate, 'trustedRoot', finalManifest.independentTrustRoot?.trustedRootSha256, 'The artifact-attestation gate must source the final manifest trusted root.');
  }
  if (manifestAttestationGate) {
    assertSourceDigest(decision, manifestAttestationGate, 'manifestAttestation', cleanDownload.manifestAttestationSha256, 'The manifest-attestation gate must source the independently verified manifest bundle.');
    assertSourceDigest(decision, manifestAttestationGate, 'trustedRoot', cleanDownload.trustedRootSha256, 'The manifest-attestation gate must source the independently verified trusted root.');
  }
  if (cleanDownloadGate) {
    assertSourceBinding(decision, cleanDownloadGate, 'cleanDownloadVerification', decision.candidate.cleanDownloadVerification, 'The clean-download gate must source the exact candidate clean-download verification.');
    assertSourceDigest(decision, cleanDownloadGate, 'independentTrustedRoot', cleanDownload.independentlyAcquiredTrustedRootSha256, 'The clean-download gate must source the independently acquired trusted root.');
  }

  const signatureReport = authenticodeGate?.sourceResults.get('signatureReport')?.parsed;
  if (authenticodeGate) verifySignatureReport(decision, signatureReport, finalManifest);
  for (const [gateId, role] of [
    ['WP5-ARTIFACT-ATTESTATION', 'artifactAttestation'],
    ['WP5-FINAL-MANIFEST-ATTESTATION', 'manifestAttestation']
  ]) {
    const gateResult = verifiedGates.get(gateId);
    if (!gateResult) continue;
    const parsed = gateResult.sourceResults.get(role)?.parsed;
    if (!containsDsseEnvelope(parsed)) addBlocker(decision, 'CRITICAL_ATTESTATION_BUNDLE_INVALID', gateId, `Source '${role}' does not contain a DSSE envelope.`);
  }
}

function verifySignatureReport(decision, report, finalManifest) {
  if (!isPlainObject(report) || report.schemaVersion !== 2 || report.status !== 'PASS' || report.requireSigned !== true || report.expectedSubject !== finalManifest.authenticode?.expectedSubject || canonicalJson(report.exactArtifactRoles) !== canonicalJson(EXACT_SIGNED_ARTIFACT_ROLES) || !Array.isArray(report.blockers) || report.blockers.length !== 0 || !Array.isArray(report.artifacts)) {
    addBlocker(decision, 'CRITICAL_SIGNATURE_REPORT_INVALID', 'WP5-AUTHENTICODE', 'The bound signature report does not meet the signed PASS contract.');
    return;
  }
  const finalByRole = new Map(finalManifest.artifacts.map((artifact) => [artifact.role, artifact]));
  const reportRoles = report.artifacts.map((artifact) => artifact.role).sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(reportRoles) !== canonicalJson(EXACT_SIGNED_ARTIFACT_ROLES)) {
    addBlocker(decision, 'CRITICAL_SIGNATURE_REPORT_INVALID', 'WP5-AUTHENTICODE', 'The signature report artifact roles are not exact.');
    return;
  }
  for (const artifact of report.artifacts) {
    const finalArtifact = finalByRole.get(artifact.role);
    if (!finalArtifact || artifact.path !== finalArtifact.path || artifact.name !== finalArtifact.name || artifact.size !== finalArtifact.size || artifact.sha256 !== finalArtifact.sha256 || artifact.signatureStatus !== 'Valid' || artifact.signed !== true || artifact.subject !== report.expectedSubject || artifact.signerChain?.valid !== true || typeof artifact.timestampSubject !== 'string' || artifact.timestampSubject.length === 0 || artifact.timestampChain?.valid !== true || artifact.tamperTest?.rejected !== true) {
      addBlocker(decision, 'CRITICAL_SIGNATURE_ARTIFACT_INVALID', 'WP5-AUTHENTICODE', `Signed artifact '${artifact.role}' is not the exact valid, timestamped, tamper-tested final artifact.`);
    }
  }
}

function containsDsseEnvelope(value) {
  if (Array.isArray(value)) return value.some(containsDsseEnvelope);
  if (!isPlainObject(value)) return false;
  if (isPlainObject(value.dsseEnvelope) && typeof value.dsseEnvelope.payload === 'string' && value.dsseEnvelope.payload.length > 0) return true;
  return Object.values(value).some(containsDsseEnvelope);
}

function assertSourceBinding(decision, verifiedGate, role, expected, detail) {
  const binding = verifiedGate?.sourceResults.get(role)?.binding;
  if (!binding || binding.path !== expected.path || binding.sha256 !== expected.sha256) {
    addBlocker(decision, 'CRITICAL_GATE_BINDING_MISMATCH', verifiedGate?.envelope.gateId ?? role, detail);
  }
}

function assertSourceDigest(decision, verifiedGate, role, expectedDigest, detail) {
  const binding = verifiedGate?.sourceResults.get(role)?.binding;
  if (!binding || !SHA256_PATTERN.test(expectedDigest ?? '') || binding.sha256 !== expectedDigest) {
    addBlocker(decision, 'CRITICAL_GATE_DIGEST_MISMATCH', verifiedGate?.envelope.gateId ?? role, detail);
  }
}

function verifyApprovals(decision) {
  const payloadSha256 = decision.payload.sha256;
  const signerCounts = new Map();
  for (const approval of decision.approvals) {
    if (approval.decision === 'PENDING') {
      decision.pending.push(`approval:${approval.role}`);
      continue;
    }
    if (approval.decision === 'REJECT') {
      addBlocker(decision, 'ROLE_REJECTED', approval.role, `The ${approval.role} role rejected this payload.`);
    }
    addBlocker(
      decision,
      'APPROVAL_RECEIPT_VERIFIER_NOT_IMPLEMENTED',
      approval.role,
      'Role decisions are self-reported JSON until a domain-separated cryptographic signature or protected-platform approval receipt is independently verified.'
    );
    if (approval.signedPayloadSha256 !== payloadSha256) {
      addBlocker(decision, 'APPROVAL_PAYLOAD_MISMATCH', approval.role, `The ${approval.role} approval is not bound to the canonical payload digest.`);
    }
    const signerKey = approval.signerId.toLocaleLowerCase('en-US');
    signerCounts.set(signerKey, (signerCounts.get(signerKey) ?? 0) + 1);
  }

  for (const approval of decision.approvals) {
    if (approval.decision === 'PENDING') continue;
    const signerKey = approval.signerId.toLocaleLowerCase('en-US');
    if ((signerCounts.get(signerKey) ?? 0) > 1 && approval.authorityMode !== 'MERGED_PROJECT_OWNER') {
      addBlocker(decision, 'MERGED_AUTHORITY_REQUIRED', approval.role, 'A signer covering more than one role must use authorityMode MERGED_PROJECT_OWNER for every covered role.');
    }
  }
}

async function readBoundFile(workspaceRoot, binding, snapshots, label) {
  if (!binding?.sha256) return { ok: false, detail: 'The evidence SHA-256 is missing.' };
  let absolutePath;
  try {
    absolutePath = resolveWorkspacePath(workspaceRoot, binding.path);
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  try {
    const [realWorkspaceRoot, realEvidencePath] = await Promise.all([
      realpath(workspaceRoot),
      realpath(absolutePath)
    ]);
    const realRelation = relative(realWorkspaceRoot, realEvidencePath);
    if (realRelation.startsWith('..') || isAbsolute(realRelation)) {
      return { ok: false, detail: 'The evidence path resolves outside the workspace root.' };
    }
    await assertNoLinkedPathSegments(workspaceRoot, binding.path);
    const before = await lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, detail: 'The evidence path is not a regular, non-linked file.' };
    }
    const bytes = await readFile(absolutePath);
    const after = await lstat(absolutePath);
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return { ok: false, detail: 'The evidence file changed while it was read.' };
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== binding.sha256) return { ok: false, detail: 'The current evidence bytes do not match the declared SHA-256.' };
    if (snapshots) snapshots.push({ label, binding: { path: binding.path, sha256: binding.sha256 } });
    return { ok: true, absolutePath, bytes };
  } catch (error) {
    return { ok: false, detail: `The evidence file is unavailable: ${error.code ?? error.message}` };
  }
}

async function reverifyEvidenceSnapshots(decision, workspaceRoot, snapshots) {
  const unique = new Map(snapshots.map((snapshot) => [`${snapshot.binding.path}\0${snapshot.binding.sha256}`, snapshot]));
  for (const snapshot of unique.values()) {
    const result = await readBoundFile(workspaceRoot, snapshot.binding, undefined, snapshot.label);
    if (!result.ok) addBlocker(decision, 'EVIDENCE_CHANGED_AFTER_READ', snapshot.label, result.detail);
  }
}

async function assertNoLinkedPathSegments(workspaceRoot, logicalPath) {
  let current = workspaceRoot;
  for (const segment of logicalPath.split('/')) {
    current = resolve(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error('The evidence path contains a linked path segment.');
  }
}

function resolveWorkspacePath(workspaceRoot, logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0 || isAbsolute(logicalPath) || /^[A-Za-z]:/u.test(logicalPath) || /[\\\0\r\n]/u.test(logicalPath)) {
    throw new Error('Evidence paths must be non-empty POSIX-style paths relative to the workspace root.');
  }
  const segments = logicalPath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Evidence paths must not contain empty, dot, or parent segments.');
  }
  const absolutePath = resolve(workspaceRoot, ...segments);
  const relation = relative(workspaceRoot, absolutePath);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('Evidence path escapes the workspace root.');
  return absolutePath;
}

function normalizeArtifactSet(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error('Artifact set must be an array.');
  const normalized = artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object') throw new Error('Artifact records must be objects.');
    if (!EXACT_ARTIFACT_ROLES.includes(artifact.role)) throw new Error(`Unexpected artifact role '${artifact.role}'.`);
    if (typeof artifact.path !== 'string' || artifact.path.length === 0 || typeof artifact.name !== 'string' || artifact.name.length === 0) {
      throw new Error(`Artifact '${artifact.role}' has an invalid path or name.`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !SHA256_PATTERN.test(artifact.sha256)) {
      throw new Error(`Artifact '${artifact.role}' has an invalid size or SHA-256.`);
    }
    return {
      role: artifact.role,
      path: artifact.path,
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256
    };
  }).sort((left, right) => left.role.localeCompare(right.role, 'en'));
  const roles = normalized.map(({ role }) => role);
  if (new Set(roles).size !== roles.length || canonicalJson(roles) !== canonicalJson(EXACT_ARTIFACT_ROLES)) {
    throw new Error(`Artifact roles must be exactly [${EXACT_ARTIFACT_ROLES.join(', ')}].`);
  }
  return normalized;
}

function assertDraftStructure(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Acceptance decision input must be an object.');
  assert(input.schemaVersion === 1 && input.phase === 5, 'Acceptance decision must use schemaVersion 1 and phase 5.');
  assert(input.candidate && typeof input.candidate === 'object', 'candidate is required.');
  assert(GIT_SHA_PATTERN.test(input.candidate.gitSha), 'candidate.gitSha must be a lowercase full Git SHA.');
  assert(input.candidate.productVersion === '0.5.0-phase5', 'candidate.productVersion must be 0.5.0-phase5.');
  assert(SHA256_PATTERN.test(input.candidate.artifactSetDigest), 'candidate.artifactSetDigest must be SHA-256.');
  for (const name of ['finalReleaseManifest', 'cleanDownloadVerification']) {
    assertFileBindingShape(input.candidate[name], `candidate.${name}`);
  }

  assert(Array.isArray(input.gates) && input.gates.length === FROZEN_GATES.length, `gates must contain exactly ${FROZEN_GATES.length} entries.`);
  input.gates.forEach((item, index) => {
    const frozen = FROZEN_GATES[index];
    assert(item.id === frozen.id, `gates[${index}].id must be ${frozen.id}.`);
    assert(item.evidenceClass === frozen.evidenceClass, `${item.id}.evidenceClass must be ${frozen.evidenceClass}.`);
    assert(item.externalEvidence === frozen.externalEvidence, `${item.id}.externalEvidence is frozen to ${frozen.externalEvidence}.`);
    assert(['PASS', 'PENDING', 'BLOCKED'].includes(item.status), `${item.id}.status is invalid.`);
    assertFileBindingShape(item.evidence, `${item.id}.evidence`, item.status !== 'PASS');
    assert(item.note === null || (typeof item.note === 'string' && item.note.length > 0), `${item.id}.note must be null or non-empty text.`);
  });

  assert(Array.isArray(input.approvals) && input.approvals.length === REQUIRED_APPROVAL_ROLES.length, 'Exactly four role approvals are required.');
  input.approvals.forEach((approval, index) => {
    const expectedRole = REQUIRED_APPROVAL_ROLES[index];
    assert(approval.role === expectedRole, `approvals[${index}].role must be ${expectedRole}.`);
    assert(['APPROVE', 'PENDING', 'REJECT'].includes(approval.decision), `${expectedRole}.decision is invalid.`);
    if (approval.decision === 'PENDING') {
      assert(approval.signerId === null && approval.displayName === null && approval.authorityMode === null && approval.signedPayloadSha256 === null && approval.signedAt === null && approval.statement === null, `${expectedRole} pending approval must not contain signature fields.`);
    } else {
      assert(typeof approval.signerId === 'string' && approval.signerId.length > 0, `${expectedRole}.signerId is required.`);
      assert(typeof approval.displayName === 'string' && approval.displayName.length > 0, `${expectedRole}.displayName is required.`);
      assert(['ROLE_HOLDER', 'MERGED_PROJECT_OWNER'].includes(approval.authorityMode), `${expectedRole}.authorityMode is invalid.`);
      assert(SHA256_PATTERN.test(approval.signedPayloadSha256), `${expectedRole}.signedPayloadSha256 is invalid.`);
      assert(!Number.isNaN(Date.parse(approval.signedAt)), `${expectedRole}.signedAt must be an RFC 3339 timestamp.`);
      assert(approval.statement === ROLE_DECISION_STATEMENT, `${expectedRole}.statement must use the frozen role-decision statement.`);
    }
  });
}

function assertFileBindingShape(binding, label, allowMissingDigest = false) {
  assert(binding && typeof binding === 'object' && !Array.isArray(binding), `${label} must be an object.`);
  resolveWorkspacePath(resolve('.'), binding.path);
  assert((allowMissingDigest && binding.sha256 === null) || SHA256_PATTERN.test(binding.sha256), `${label}.sha256 is invalid.`);
}

function assertPolicyRegistryComplete() {
  const policyIds = Object.keys(GATE_VALIDATION_POLICIES);
  assert(canonicalJson([...policyIds].sort()) === canonicalJson([...FROZEN_GATE_IDS].sort()), 'Gate validation policy registry must exactly cover all frozen gates.');
  const validators = policyIds.map((id) => GATE_VALIDATION_POLICIES[id].validatorId);
  assert(new Set(validators).size === validators.length, 'Every frozen gate must have a unique validator identity.');
}

function assertSourceValidatorRegistryComplete() {
  const sourceValidatorIds = Object.keys(GATE_SOURCE_VALIDATORS);
  assert(canonicalJson([...sourceValidatorIds].sort()) === canonicalJson([...FROZEN_GATE_IDS].sort()), 'Gate source-validator registry must exactly cover all frozen gates.');
  for (const [gateId, descriptor] of Object.entries(GATE_SOURCE_VALIDATORS)) {
    assert(['IMPLEMENTED', 'NOT_IMPLEMENTED'].includes(descriptor.kind), `Gate '${gateId}' source-validator disposition is invalid.`);
    if (descriptor.kind === 'IMPLEMENTED') {
      assert(typeof SOURCE_VALIDATOR_IMPLEMENTATIONS[descriptor.implementation] === 'function', `Gate '${gateId}' source-validator implementation is unavailable.`);
    } else {
      assert(typeof descriptor.reason === 'string' && descriptor.reason.length > 0, `Gate '${gateId}' source-validator blocker reason is required.`);
    }
  }
}

async function validateDecisionSchema(decision, schemaPath) {
  const path = schemaPath ?? resolve(import.meta.dirname, '..', 'schemas', 'phase5', 'acceptance-decision.schema.json');
  const schema = JSON.parse(await readFile(path, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(decision)) throw new Error(`Generated acceptance decision failed schema validation: ${ajv.errorsText(validate.errors)}`);
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object') throw new Error(`Canonical JSON rejects ${typeof value}.`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function assertExactKeys(value, keys, errors, label) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) errors.push(`${label} contains missing or unexpected fields.`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function addBlocker(decision, code, subject, detail) {
  decision.blockers.push({ code, subject, detail });
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toCode(value) {
  return value.replaceAll(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(`Invalid or duplicate argument near '${name ?? ''}'.`);
    }
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (!['--input', '--output', '--workspace-root'].includes(name)) throw new Error(`Unknown argument '${name}'.`);
  }
  if (!values.has('--input') || !values.has('--output')) throw new Error('--input and --output are required.');
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const inputPath = resolve(args.get('--input'));
  const outputPath = resolve(args.get('--output'));
  const workspaceRoot = resolve(args.get('--workspace-root') ?? resolve(import.meta.dirname, '..'));
  if (inputPath === outputPath) throw new Error('Acceptance decision output must be a new file, not the input file.');
  await access(inputPath, fsConstants.R_OK);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const decision = await evaluateAcceptanceDecision(input, { workspaceRoot });
  const finalState = await readGitRepositoryState({ workspaceRoot });
  if (finalState.gitSha !== decision.candidate.gitSha || !finalState.clean) {
    throw new Error('Repository HEAD/clean state changed after acceptance evaluation; no decision was written.');
  }
  await writeFile(outputPath, `${JSON.stringify(decision, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`[phase5:acceptance-decision] ${decision.status}: ${outputPath}`);
  console.log(`[phase5:acceptance-decision] canonical payload sha256=${decision.payload.sha256}`);
  if (!decision.acceptance) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[phase5:acceptance-decision] BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runnerUrl = new URL('./bergamot-cold-pws-runner.ps1', import.meta.url);
const nativeUrl = new URL('./bergamot-cold-pws-native.cs', import.meta.url);
const source = await readFile(runnerUrl, 'utf8');
const nativeSource = await readFile(nativeUrl, 'utf8');

assert.match(source, /PID_AND_CREATION_TIME_INTERNAL_ONLY/u);
assert.match(source, /CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME/u);
assert.match(source, /QUERY_INFORMATION_JOB_OBJECT_MEMBERS/u);
assert.match(source, /JOB_THREE_CONSECUTIVE_ZERO_POLLS/u);
assert.match(source, /MinimumValidSamples = 10/u);
assert.match(source, /MinimumCoverageMilliseconds = 1000/u);
assert.match(source, /MaximumLaunchToFirstSampleMilliseconds = 250/u);
assert.match(source, /MaximumSampleSpanMilliseconds = 250/u);
assert.match(source, /MaximumProcessQuerySkewMilliseconds = 250/u);
assert.match(source, /MaximumVerifiedMembershipTransitionSamples = 8/u);
assert.match(source, /MaximumAdjacentValidSampleGapMilliseconds = 500/u);
assert.match(
  source,
  /MaximumTotalVerifiedTransitionGapMilliseconds = 1000/u
);
assert.match(source, /TransitionReservePassBytes = \[int64\]1073741824/u);
assert.match(source, /PrivateWorkingSetBudgetBytes = \[int64\]1181116006/u);
assert.match(source, /VERIFIED_MEMBERSHIP_TRANSITION_GAP/u);
assert.match(source, /VERIFIED_TERMINAL_JOB_ZERO/u);
assert.match(source, /Test-ExactExitOnlyTransitionEpisode/u);
assert.match(source, /Test-VerifiedTerminalBoundary/u);
assert.match(source, /Test-SamplingTerminalBoundaryGate/u);
assert.match(source, /Test-TerminalSamplingEndpointCadence/u);
assert.match(source, /Test-VerifiedTerminalExitAccountingLagSample/u);
assert.match(source, /Test-TerminalExitOnlyTransitionEpisode/u);
assert.match(source, /Test-ExactEmptyJobSnapshot/u);
assert.match(source, /Get-ExactEmptySnapshotDisposition/u);
assert.match(source, /Invoke-JobProcessQueryWithSingleRetry/u);
assert.match(source, /\$terminalEndpointCadenceAccepted -and/u);
assert.match(source, /terminalBoundary = \$terminalBoundary/u);
assert.match(source, /BOUNDED_TRANSITION_GAPS_NOT_CONTINUOUS/u);
assert.match(source, /PASS_WITH_TRANSITION_RESERVE/u);
assert.match(source, /INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET/u);
assert.match(source, /\$cadence\.max/u);
assert.match(source, /discardedSampleCount -eq 0/u);
assert.match(source, /logicalSamples = @\(\$logicalSamples\)/u);
assert.match(source, /forcedKillCount/u);
assert.match(source, /electronAppMetricsGateAEligible = \$false/u);
assert.match(source, /warmIterationsPerRoute -ne 5/u);
assert.match(source, /warmFailureCount/u);
assert.match(source, /Assert-ReportPrivacy/u);
assert.match(source, /harnessIdentity/u);
assert.match(source, /authorizationSha256/u);
assert.match(source, /electronDistTree/u);
assert.match(source, /runnerConfigurationSha256/u);
assert.match(source, /sampleIdentitySha256/u);
assert.match(source, /sourceSha256_\$Direction/u);
assert.match(source, /completionMarkerBindingSha256/u);
assert.match(source, /membershipRevalidationStatus/u);
assert.match(source, /preJobQueryAttempts/u);
assert.match(source, /preJobQueryRetryCount/u);
assert.match(source, /preJobQueryRetryReasonCode/u);
assert.match(source, /postJobQueryAttempts/u);
assert.match(source, /postJobQueryRetryCount/u);
assert.match(source, /postJobQueryRetryReasonCode/u);
assert.match(source, /jobReportedAccountingActiveProcesses/u);
assert.match(source, /postJobReportedAccountingActiveProcesses/u);
assert.match(source, /finalJobReportedAccountingActiveProcesses/u);
assert.match(
  source,
  /STABLE_DOUBLE_ACCOUNTING_AND_BOUND_ACTIVE_IDENTITY_ENUMERATION/u
);
assert.match(source, /Resolve-VerifiedExecutableSha256/u);
assert.match(source, /WriteUniqueFile/u);
assert.match(source, /ValidateUniqueRegularFile\(\$hardlinkTarget\)/u);
assert.match(source, /SELFTEST_FINAL_PATH_MISMATCH_ACCEPTED/u);
assert.match(
  source,
  /forcedKillCount -gt 0 -and \$null -eq \$failureCode/u
);
assert.doesNotMatch(source, /app\.getAppMetrics/u);
assert.doesNotMatch(source, /WorkingSet64/u);
assert.doesNotMatch(source, /PrivateMemorySize64/u);
assert.doesNotMatch(source, /Stop-Process/u);
assert.match(
  source,
  /ReadToEndAsync\(\)[\s\S]*?\.Wait\(\$TimeoutMilliseconds\)/u
);
assert.doesNotMatch(source, /ProcessStartInfo/u);
const samplingLoopStart = source.indexOf(
  'while ($wall.Elapsed.TotalSeconds -lt $TrialTimeoutSeconds)'
);
const samplingLoopEnd = source.indexOf(
  '$trialDeadlineExceeded =',
  samplingLoopStart
);
assert.ok(samplingLoopStart >= 0 && samplingLoopEnd > samplingLoopStart);
const samplingLoop = source.slice(samplingLoopStart, samplingLoopEnd);
assert.match(samplingLoop, /Test-Path -LiteralPath \$completionMarkerPath/u);
assert.doesNotMatch(samplingLoop, /Read-WarmCompletionMarker/u);
const rootExitQueryStart = samplingLoop.indexOf(
  '$rootState = [Phase7BergamotNative]::WaitForRoot($launch, 0)'
);
const rootExitQueryEnd = samplingLoop.indexOf(
  'foreach ($capturePath in @($stdoutPath, $stderrPath))',
  rootExitQueryStart
);
assert.ok(rootExitQueryStart >= 0 && rootExitQueryEnd > rootExitQueryStart);
const rootExitQueryBlock = samplingLoop.slice(
  rootExitQueryStart,
  rootExitQueryEnd
);
assert.match(
  rootExitQueryBlock,
  /\$postExitJobQueryFailureCount \+= 1[\s\S]*?BERGAMOT_COLD_PWS_POST_EXIT_JOB_QUERY_FAILED[\s\S]*?break/u
);
const exactEmptyStart = samplingLoop.indexOf(
  '$preSnapshotExactZero = Test-ExactEmptyJobSnapshot'
);
const exactEmptyEnd = samplingLoop.indexOf(
  '$maximumTreeProcessCount =',
  exactEmptyStart
);
assert.ok(exactEmptyStart >= 0 && exactEmptyEnd > exactEmptyStart);
const exactEmptyBlock = samplingLoop.slice(exactEmptyStart, exactEmptyEnd);
assert.equal(
  exactEmptyBlock.match(/WaitForRoot\(\$launch, 0\)/gu)?.length,
  1
);
assert.match(exactEmptyBlock, /Get-ExactEmptySnapshotDisposition/u);
assert.match(exactEmptyBlock, /\$pendingTerminalZeroPollCount \+= 1/u);
assert.match(exactEmptyBlock, /continue/u);
assert.match(
  samplingLoop,
  /\$sampleStatus = 'DISCARDED'[\s\S]*?\} elseif \(\$jobQueryStatus -eq 'COMPLETE' -and\s*\$postJobQueryStatus -ne 'FAILED'\) \{\s*try \{\s*\$transitionProbe/u
);

const retryWrapperStart = source.indexOf(
  'function Invoke-JobProcessQueryWithSingleRetry'
);
const retryWrapperEnd = source.indexOf(
  'function Read-BoundedUtf8File',
  retryWrapperStart
);
assert.ok(retryWrapperStart >= 0 && retryWrapperEnd > retryWrapperStart);
const retryWrapper = source.slice(retryWrapperStart, retryWrapperEnd);
assert.match(retryWrapper, /while \(\$attempts -lt 2\)/u);
assert.match(retryWrapper, /RetryCount = \$attempts - 1/u);
assert.match(retryWrapper, /RetryReasonCode = \$firstFailureCode/u);

assert.match(nativeSource, /CreateProcessW/u);
assert.match(nativeSource, /CREATE_SUSPENDED/u);
assert.match(nativeSource, /AssignProcessToJobObject/u);
assert.match(nativeSource, /ResumeThread/u);
assert.ok(
  nativeSource.indexOf('AssignProcessToJobObject(job, processInformation.hProcess)')
    < nativeSource.indexOf('ResumeJobRoot')
);
assert.match(nativeSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
assert.doesNotMatch(nativeSource, /JOB_OBJECT_LIMIT_BREAKAWAY_OK/u);
assert.doesNotMatch(nativeSource, /JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK/u);
assert.match(
  nativeSource,
  /PrivateWorkingSetBytes\(\s*int processId,\s*long expectedCreationTicks/um
);
const qwsStart = nativeSource.indexOf(
  'public static Phase7BergamotPwsResult PrivateWorkingSetBytes'
);
const qwsEnd = nativeSource.indexOf(
  'public static bool TerminateBoundProcess',
  qwsStart
);
const qwsBody = nativeSource.slice(qwsStart, qwsEnd);
assert.ok(
  qwsBody.indexOf('IsHandleActiveIdentity(process, expectedCreationTicks)')
    < qwsBody.indexOf('QueryWorkingSet(process, buffer, size)')
);
assert.ok(
  qwsBody.lastIndexOf('IsHandleActiveIdentity(process, expectedCreationTicks)')
    > qwsBody.indexOf('QueryWorkingSet(process, buffer, size)')
);
assert.match(nativeSource, /TerminateBoundProcess/u);
assert.match(nativeSource, /TerminateProcess\(process, exitCode\)/u);
assert.match(nativeSource, /TerminateJobObject/u);
assert.match(nativeSource, /numberOfAssignedProcesses/u);
assert.match(nativeSource, /numberOfProcessIdsInList/u);
assert.match(nativeSource, /BERGAMOT_JOB_PROCESS_LIST_INCOMPLETE_OR_UNSTABLE/u);
assert.match(nativeSource, /JOBOBJECT_BASIC_ACCOUNTING_INFORMATION/u);
assert.match(nativeSource, /ACCOUNTING_BOUND_KNOWN_IDENTITIES/u);
assert.match(nativeSource, /HEADER_INCONSISTENT_ACCOUNTING_BOUND/u);
assert.match(
  nativeSource,
  /EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES/u
);
assert.match(nativeSource, /ClassifyExitAccountingLagRecovery/u);
assert.match(nativeSource, /ExactIdentitySetsMatch/u);
assert.match(nativeSource, /LastReportedAccountingActiveProcesses/u);
assert.match(nativeSource, /ClassifyBoundProcessExitTransition/u);
assert.match(nativeSource, /VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG/u);
assert.match(nativeSource, /IsProcessInJob/u);
assert.match(nativeSource, /CREATE_NEW/u);
assert.match(nativeSource, /NumberOfLinks != 1/u);
assert.match(nativeSource, /FILE_FLAG_OPEN_REPARSE_POINT/u);

let windowsProof = null;
if (process.platform === 'win32') {
  const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const { stdout } = await execFileAsync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(runnerUrl),
      '-SelfTest'
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      windowsHide: true
    }
  );
  const report = JSON.parse(stdout);
  windowsProof = report;
  assert.equal(report.status, 'SELF_TEST_PASS');
  assert.equal(report.sameHandleQwsIdentityValidation, 'PASS');
  assert.equal(report.wrongCreationTerminationRejected, 'PASS');
  assert.equal(report.sameHandleBoundTermination, 'PASS');
  assert.equal(report.suspendedJobAssignmentBeforeResume, 'PASS');
  assert.equal(report.partialJobMemberListRejected, 'PASS');
  assert.equal(report.accountingBoundKnownIdentityRecovery, 'PASS');
  assert.equal(
    report.headerInconsistentAccountingBoundRecovery,
    'PASS'
  );
  assert.equal(
    report.exitAccountingLagCompleteRecoveryClassification,
    'PASS'
  );
  assert.equal(report.jobBoundQwsMembershipValidation, 'PASS');
  assert.equal(
    report.boundedMembershipTransitionClassification,
    'PASS'
  );
  assert.equal(
    report.markerBoundTerminalJobZeroClassification,
    'PASS'
  );
  assert.equal(
    report.terminalEndpointCadenceClassification,
    'PASS'
  );
  assert.equal(
    report.terminalExitAccountingLagClassification,
    'PASS'
  );
  assert.equal(
    report.exactEmptyPendingZeroClassification,
    'PASS'
  );
  assert.equal(
    report.singleRetryJobQueryClassification,
    'PASS'
  );
  assert.equal(
    report.postExitQueryFailFastClassification,
    'PASS'
  );
  assert.equal(report.transitionReserveBudgetClassification, 'PASS');
  assert.equal(report.finalKnownEqualsTotalHistory, 'PASS');
  assert.equal(
    report.completionMarkerCreateNewAndReportBinding,
    'PASS'
  );
  assert.equal(
    report.jobTerminationAndThreeZeroPollCleanup,
    'PASS'
  );
  assert.equal(
    report.createNewHardlinkReparseAndFinalPathRejection,
    'PASS'
  );
  assert.equal(report.rawTextEmitted, false);
  assert.equal(report.rawPathsEmitted, false);
  assert.equal(report.processIdentifiersEmitted, false);
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'phase7-bergamot-cold-pws-selftest-v2',
  status: 'SELF_TEST_PASS',
  windowsQueryWorkingSetRunnerExecuted: process.platform === 'win32',
  sameHandleQwsIdentityValidation:
    windowsProof?.sameHandleQwsIdentityValidation ?? 'NOT_RUN',
  wrongCreationTerminationRejected:
    windowsProof?.wrongCreationTerminationRejected ?? 'NOT_RUN',
  sameHandleBoundTermination:
    windowsProof?.sameHandleBoundTermination ?? 'NOT_RUN',
  suspendedJobAssignmentBeforeResume:
    windowsProof?.suspendedJobAssignmentBeforeResume ?? 'NOT_RUN',
  partialJobMemberListRejected:
    windowsProof?.partialJobMemberListRejected ?? 'NOT_RUN',
  accountingBoundKnownIdentityRecovery:
    windowsProof?.accountingBoundKnownIdentityRecovery ?? 'NOT_RUN',
  headerInconsistentAccountingBoundRecovery:
    windowsProof?.headerInconsistentAccountingBoundRecovery ?? 'NOT_RUN',
  exitAccountingLagCompleteRecoveryClassification:
    windowsProof?.exitAccountingLagCompleteRecoveryClassification
      ?? 'NOT_RUN',
  jobBoundQwsMembershipValidation:
    windowsProof?.jobBoundQwsMembershipValidation ?? 'NOT_RUN',
  boundedMembershipTransitionClassification:
    windowsProof?.boundedMembershipTransitionClassification ?? 'NOT_RUN',
  markerBoundTerminalJobZeroClassification:
    windowsProof?.markerBoundTerminalJobZeroClassification ?? 'NOT_RUN',
  terminalEndpointCadenceClassification:
    windowsProof?.terminalEndpointCadenceClassification ?? 'NOT_RUN',
  terminalExitAccountingLagClassification:
    windowsProof?.terminalExitAccountingLagClassification ?? 'NOT_RUN',
  exactEmptyPendingZeroClassification:
    windowsProof?.exactEmptyPendingZeroClassification ?? 'NOT_RUN',
  singleRetryJobQueryClassification:
    windowsProof?.singleRetryJobQueryClassification ?? 'NOT_RUN',
  postExitQueryFailFastClassification:
    windowsProof?.postExitQueryFailFastClassification ?? 'NOT_RUN',
  transitionReserveBudgetClassification:
    windowsProof?.transitionReserveBudgetClassification ?? 'NOT_RUN',
  finalKnownEqualsTotalHistory:
    windowsProof?.finalKnownEqualsTotalHistory ?? 'NOT_RUN',
  completionMarkerCreateNewAndReportBinding:
    windowsProof?.completionMarkerCreateNewAndReportBinding ?? 'NOT_RUN',
  jobTerminationAndThreeZeroPollCleanup:
    windowsProof?.jobTerminationAndThreeZeroPollCleanup ?? 'NOT_RUN',
  createNewHardlinkReparseAndFinalPathRejection:
    windowsProof?.createNewHardlinkReparseAndFinalPathRejection
      ?? 'NOT_RUN',
  rawTextEmitted: false,
  rawPathsEmitted: false,
  processIdentifiersEmitted: false
}, null, 2)}\n`);

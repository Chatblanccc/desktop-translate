[CmdletBinding()]
param(
    [Parameter()][string]$PocAuthorizationPath,
    [Parameter()][ValidateRange(1, 100)][int]$TrialsPerDirection = 20,
    [Parameter()][ValidateRange(50, 1000)][int]$SampleIntervalMilliseconds = 100,
    [Parameter()][ValidateRange(30, 600)][int]$TrialTimeoutSeconds = 360,
    [Parameter()][ValidateRange(1, 60)][int]$ResidualTimeoutSeconds = 10,
    [Parameter()][ValidateSet('en-zh', 'zh-en')][string[]]$Directions = @('en-zh', 'zh-en'),
    [Parameter()][string]$OutputPath,
    [Parameter()][switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 'phase7-bergamot-cold-pws-v2'
$script:SuccessPocStatus = 'PARTIAL_M4_DIRECTION_COLD_TRIAL'
$script:Sha256Pattern = '^[a-f0-9]{64}$'
$script:MinimumValidSamples = 10
$script:MinimumCoverageMilliseconds = 1000
$script:MaximumLaunchToFirstSampleMilliseconds = 250
$script:MaximumSampleSpanMilliseconds = 250
$script:MaximumProcessQuerySkewMilliseconds = 250
$script:MaximumVerifiedMembershipTransitionSamples = 8
$script:MaximumAdjacentValidSampleGapMilliseconds = 500
$script:MaximumExitOnlyAdjacentValidSampleGapMilliseconds = 1250
$script:MaximumTotalVerifiedTransitionGapMilliseconds = 1000
$script:TransitionReservePassBytes = [int64]1073741824
$script:PrivateWorkingSetBudgetBytes = [int64]1181116006
$script:MaximumCaptureBytes = 1048576
$script:MaximumFinalReportBytes = 67108864
$script:CaptureReadTimeoutMilliseconds = 5000
$script:PostTerminateWaitMilliseconds = 5000
$script:ResidualPollMilliseconds = 200

function Get-Sha256Text {
    param([Parameter(Mandatory = $true)][string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hash.Dispose()
    }
}

function Get-NearestRank {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][ValidateRange(0.01, 1.0)][double]$Percentile
    )
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $rank = [Math]::Ceiling($Percentile * $sorted.Count)
    return [double]$sorted[[Math]::Max(0, $rank - 1)]
}

function Get-Distribution {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Values
    )
    $numbers = @($Values | ForEach-Object { [double]$_ })
    if ($numbers.Count -eq 0) {
        return [ordered]@{ n = 0; p50 = $null; p95 = $null; max = $null }
    }
    return [ordered]@{
        n = $numbers.Count
        p50 = [Math]::Round((Get-NearestRank -Values $numbers -Percentile 0.50), 3)
        p95 = [Math]::Round((Get-NearestRank -Values $numbers -Percentile 0.95), 3)
        max = [Math]::Round([double](($numbers | Measure-Object -Maximum).Maximum), 3)
    }
}

function Get-MembershipTransitionGapSummary {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$LogicalSamples,
        [Parameter()]$TerminalBoundary
    )
    $samples = @($LogicalSamples)
    $transitionSamples = @(
        $samples |
            Where-Object status -eq 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
    )
    $completeSamples = @($samples | Where-Object status -eq 'COMPLETE')
    $validStartGaps = @(for (
        $index = 1;
        $index -lt $completeSamples.Count;
        $index += 1
    ) {
        [double]$completeSamples[$index].startElapsedMs -
            [double]$completeSamples[$index - 1].startElapsedMs
    })
    $maximumAdjacentValidGap = if ($validStartGaps.Count -eq 0) {
        0.0
    } else {
        [double](($validStartGaps | Measure-Object -Maximum).Maximum)
    }

    $episodes = [Collections.Generic.List[object]]::new()
    $bounded = $true
    $cursor = 0
    while ($cursor -lt $samples.Count) {
        if ([string]$samples[$cursor].status -ne
            'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
            $cursor += 1
            continue
        }
        $first = $cursor
        while ($cursor + 1 -lt $samples.Count -and
            [string]$samples[$cursor + 1].status -eq
                'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
            $cursor += 1
        }
        $last = $cursor
        $previous = $first - 1
        $next = $last + 1
        if ($previous -lt 0 -or
            [string]$samples[$previous].status -ne 'COMPLETE') {
            $bounded = $false
            $cursor += 1
            continue
        }
        $terminalBoundaryStatus = $null
        $nextValidSample = $null
        if ($next -ge $samples.Count) {
            if (-not (Test-VerifiedTerminalBoundary `
                    -Boundary $TerminalBoundary) -or
                -not (Test-TerminalExitOnlyTransitionEpisode `
                    -Samples @($samples[$first..$last])) -or
                [double]$TerminalBoundary.elapsedMs -lt
                    [double]$samples[$last].endElapsedMs) {
                $bounded = $false
                $cursor += 1
                continue
            }
            $nextElapsed = [double]$TerminalBoundary.elapsedMs
            $terminalBoundaryStatus = [string]$TerminalBoundary.status
        } elseif ([string]$samples[$next].status -eq 'COMPLETE') {
            $nextElapsed = [double]$samples[$next].startElapsedMs
            $nextValidSample = [int]$samples[$next].sample
        } else {
            $bounded = $false
            $cursor += 1
            continue
        }
        $duration = $nextElapsed -
            [double]$samples[$previous].endElapsedMs
        $adjacentValidStartGap = $nextElapsed -
            [double]$samples[$previous].startElapsedMs
        if ($duration -lt 0 -or $adjacentValidStartGap -lt 0) {
            $bounded = $false
        }
        $reasonCodes = @(
            $samples[$first..$last] |
                ForEach-Object { [string]$_.transitionReason } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique |
                Sort-Object
        )
        $episodes.Add([ordered]@{
            firstTransitionSample = [int]$samples[$first].sample
            lastTransitionSample = [int]$samples[$last].sample
            transitionSampleCount = $last - $first + 1
            previousValidSample = [int]$samples[$previous].sample
            nextValidSample = $nextValidSample
            terminalBoundaryStatus = $terminalBoundaryStatus
            durationMs = [Math]::Round($duration, 3)
            adjacentValidStartGapMs =
                [Math]::Round($adjacentValidStartGap, 3)
            reasonCodes = $reasonCodes
        })
        $maximumAdjacentValidGap = [Math]::Max(
            $maximumAdjacentValidGap,
            $adjacentValidStartGap
        )
        $cursor += 1
    }
    $totalDuration = [double]((
        $episodes |
            ForEach-Object { [double]$_.durationMs } |
            Measure-Object -Sum
    ).Sum)
    return [ordered]@{
        sampleCount = $transitionSamples.Count
        gapCount = $episodes.Count
        totalDurationMs = [Math]::Round($totalDuration, 3)
        maximumAdjacentValidSampleGapMs =
            [Math]::Round($maximumAdjacentValidGap, 3)
        boundedByCompleteSamples = $bounded
        gaps = @($episodes)
    }
}

function Get-PrivateWorkingSetBudgetStatus {
    param(
        [Parameter(Mandatory = $true)][int64]$PeakBytes,
        [Parameter(Mandatory = $true)][int]$TransitionSampleCount
    )
    if ($PeakBytes -lt 1) {
        return 'NOT_EVALUATED'
    }
    if ($PeakBytes -gt $script:PrivateWorkingSetBudgetBytes) {
        return 'FAIL_BUDGET_EXCEEDED'
    }
    if ($TransitionSampleCount -gt 0) {
        if ($PeakBytes -le $script:TransitionReservePassBytes) {
            return 'PASS_WITH_TRANSITION_RESERVE'
        }
        return 'INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET'
    }
    return 'PASS_CONTINUOUS_SAMPLING'
}

function Test-MembershipTransitionGapCadence {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Gaps
    )
    $failures = @(
        $Gaps |
            Where-Object {
                $containsSetChange =
                    @($_.reasonCodes) -contains 'EXACT_ACTIVE_SET_CHANGED'
                if ($containsSetChange) {
                    return [double]$_.adjacentValidStartGapMs -gt
                        $script:MaximumAdjacentValidSampleGapMilliseconds
                }
                return @($_.reasonCodes).Count -ne 1 -or
                    [string]$_.reasonCodes[0] -ne
                        'BOUND_PROCESS_EXIT_ACCOUNTING_LAG' -or
                    [double]$_.adjacentValidStartGapMs -gt
                        $script:MaximumExitOnlyAdjacentValidSampleGapMilliseconds
            }
    )
    return $failures.Count -eq 0
}

function Test-ExactTransitionQueryFailuresBound {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ProcessQueries,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PreProcessOrdinals,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [int[]]$PostProcessOrdinals
    )
    $removedOrdinals = @(
        $PreProcessOrdinals |
            Where-Object { $PostProcessOrdinals -notcontains [int]$_ }
    )
    $exitBoundFailureStatuses = @(
        'OPEN_FAILED',
        'PRE_IDENTITY_OR_ACTIVE_MISMATCH',
        'POST_IDENTITY_OR_ACTIVE_MISMATCH'
    )
    $unboundFailures = @(
        $ProcessQueries |
            Where-Object status -ne 'COMPLETE' |
            Where-Object {
                $exitBoundFailureStatuses -notcontains [string]$_.status -or
                $removedOrdinals -notcontains [int]$_.processOrdinal
            }
    )
    return $unboundFailures.Count -eq 0
}

function Test-ExactExitOnlyTransitionEpisode {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Samples
    )
    $episode = @($Samples)
    if ($episode.Count -lt 1) { return $false }
    $expectedPreOrdinals = $null
    foreach ($sample in $episode) {
        if ([string]$sample.status -ne
                'VERIFIED_MEMBERSHIP_TRANSITION_GAP' -or
            [string]$sample.transitionReason -ne
                'EXACT_ACTIVE_SET_CHANGED' -or
            [string]$sample.transitionVerificationStatus -ne
                'VERIFIED_PRE_POST_COMPLETE_HISTORY_IDENTITY_SET_CHANGE') {
            return $false
        }
        $preOrdinals = @($sample.preProcessOrdinals |
            ForEach-Object { [int]$_ })
        $postOrdinals = @($sample.postProcessOrdinals |
            ForEach-Object { [int]$_ })
        if ($preOrdinals.Count -le $postOrdinals.Count -or
            @($preOrdinals | Select-Object -Unique).Count -ne
                $preOrdinals.Count -or
            @($postOrdinals | Select-Object -Unique).Count -ne
                $postOrdinals.Count -or
            @($postOrdinals | Where-Object {
                $preOrdinals -notcontains [int]$_
            }).Count -ne 0) {
            return $false
        }
        if ($null -ne $expectedPreOrdinals) {
            $chainDifference = @(
                Compare-Object `
                    -ReferenceObject @($expectedPreOrdinals) `
                    -DifferenceObject @($preOrdinals)
            )
            if ($chainDifference.Count -ne 0) { return $false }
        }
        if ($null -eq $sample.jobTotalProcesses -or
            $null -eq $sample.postJobTotalProcesses -or
            $null -eq $sample.preKnownProcessIdentityCount -or
            $null -eq $sample.postKnownProcessIdentityCount -or
            [int]$sample.preKnownProcessIdentityCount -ne
                [int]$sample.jobTotalProcesses -or
            [int]$sample.postKnownProcessIdentityCount -ne
                [int]$sample.postJobTotalProcesses -or
            [int]$sample.jobTotalProcesses -ne
                [int]$sample.postJobTotalProcesses -or
            [int]$sample.memberCount -ne $preOrdinals.Count -or
            [int]$sample.postMemberCount -ne $postOrdinals.Count -or
            [int]$sample.postMemberCount -ge [int]$sample.memberCount -or
            [int]$sample.postJobActiveProcesses -ge
                [int]$sample.jobActiveProcesses) {
            return $false
        }
        $failedQueries = @(
            $sample.processQueries |
                Where-Object status -ne 'COMPLETE'
        )
        $queryOrdinals = @(
            $sample.processQueries |
                ForEach-Object { [int]$_.processOrdinal }
        )
        $queryIdentityDifference = @(
            Compare-Object `
                -ReferenceObject @($preOrdinals) `
                -DifferenceObject @($queryOrdinals)
        )
        if ($queryOrdinals.Count -ne $preOrdinals.Count -or
            @($queryOrdinals | Select-Object -Unique).Count -ne
                $queryOrdinals.Count -or
            $queryIdentityDifference.Count -ne 0 -or
            [int]$sample.transitionInternalMeasurementFailureCount -ne
                $failedQueries.Count -or
            -not (Test-ExactTransitionQueryFailuresBound `
                -ProcessQueries @($sample.processQueries) `
                -PreProcessOrdinals $preOrdinals `
                -PostProcessOrdinals $postOrdinals)) {
            return $false
        }
        $expectedPreOrdinals = @($postOrdinals)
    }
    return $true
}

function Test-VerifiedTerminalExitAccountingLagSample {
    param([Parameter(Mandatory = $true)]$Sample)
    try {
        if ($null -eq $Sample.jobTotalProcesses -or
            $null -eq $Sample.jobActiveProcesses -or
            $null -eq $Sample.jobReportedAccountingActiveProcesses -or
            $null -eq $Sample.preKnownProcessIdentityCount -or
            $null -eq $Sample.transitionTotalProcessesBefore -or
            $null -eq $Sample.transitionTotalProcessesAfter -or
            $null -eq $Sample.transitionAccountingActiveProcessesBefore -or
            $null -eq $Sample.transitionAccountingActiveProcessesAfter -or
            $null -eq $Sample.transitionBoundActiveProcesses -or
            $null -eq $Sample.transitionKnownProcessIdentityCount -or
            $null -ne $Sample.postJobTotalProcesses -or
            $null -ne $Sample.postJobActiveProcesses -or
            $null -ne $Sample.postJobReportedAccountingActiveProcesses -or
            $null -ne $Sample.postKnownProcessIdentityCount) {
            return $false
        }
        $preOrdinals = @($Sample.preProcessOrdinals)
        $postOrdinals = @($Sample.postProcessOrdinals)
        $queries = @($Sample.processQueries)
        $boundEntries = @($Sample.transitionBoundActiveProcessEntries)
        return [string]$Sample.status -eq
                'VERIFIED_MEMBERSHIP_TRANSITION_GAP' -and
            [string]$Sample.transitionReason -eq
                'BOUND_PROCESS_EXIT_ACCOUNTING_LAG' -and
            [string]$Sample.transitionVerificationStatus -eq
                'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG' -and
            [string]$Sample.preJobQueryStatus -eq 'COMPLETE' -and
            [string]$Sample.postJobQueryStatus -eq 'NOT_RUN' -and
            [string]$Sample.memberDiscoveryStatus -eq
                'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES' -and
            [string]$Sample.membershipRevalidationStatus -eq 'NOT_RUN' -and
            [int]$Sample.memberCount -eq 0 -and
            $null -eq $Sample.postMemberCount -and
            $preOrdinals.Count -eq 0 -and
            $postOrdinals.Count -eq 0 -and
            $queries.Count -eq 0 -and
            $boundEntries.Count -eq 0 -and
            [int]$Sample.jobActiveProcesses -eq 0 -and
            [int]$Sample.jobReportedAccountingActiveProcesses -gt 0 -and
            [int]$Sample.transitionBoundActiveProcesses -eq 0 -and
            [int]$Sample.transitionInternalMeasurementFailureCount -eq 0 -and
            [int]$Sample.transitionTotalProcessesBefore -gt 0 -and
            [int]$Sample.transitionTotalProcessesBefore -eq
                [int]$Sample.transitionTotalProcessesAfter -and
            [int]$Sample.transitionTotalProcessesBefore -eq
                [int]$Sample.transitionKnownProcessIdentityCount -and
            [int]$Sample.transitionTotalProcessesBefore -eq
                [int]$Sample.jobTotalProcesses -and
            [int]$Sample.preKnownProcessIdentityCount -eq
                [int]$Sample.jobTotalProcesses -and
            [int]$Sample.transitionAccountingActiveProcessesBefore -gt 0 -and
            [int]$Sample.transitionAccountingActiveProcessesBefore -eq
                [int]$Sample.transitionAccountingActiveProcessesAfter -and
            [int]$Sample.transitionAccountingActiveProcessesBefore -eq
                [int]$Sample.jobReportedAccountingActiveProcesses
    } catch {
        return $false
    }
}

function Test-TerminalExitOnlyTransitionEpisode {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Samples
    )
    $episode = @($Samples)
    if ($episode.Count -lt 1) { return $false }
    $last = $episode[$episode.Count - 1]
    if ([string]$last.transitionReason -ne
        'BOUND_PROCESS_EXIT_ACCOUNTING_LAG') {
        return Test-ExactExitOnlyTransitionEpisode -Samples $episode
    }
    if (-not (Test-VerifiedTerminalExitAccountingLagSample `
        -Sample $last)) {
        return $false
    }
    if ($episode.Count -eq 1) { return $true }
    $exactPrefix = @($episode[0..($episode.Count - 2)])
    if (-not (Test-ExactExitOnlyTransitionEpisode `
        -Samples $exactPrefix)) {
        return $false
    }
    $prefixLast = $exactPrefix[$exactPrefix.Count - 1]
    return [int]$prefixLast.postJobTotalProcesses -eq
            [int]$last.jobTotalProcesses -and
        [int]$prefixLast.postKnownProcessIdentityCount -eq
            [int]$last.preKnownProcessIdentityCount
}

function Test-VerifiedTerminalBoundary {
    param([Parameter()]$Boundary)
    if ($null -eq $Boundary) { return $false }
    try {
        if ($null -eq $Boundary.elapsedMs -or
            $null -eq $Boundary.markerObservedElapsedMs -or
            $null -eq $Boundary.jobMemberCount -or
            $null -eq $Boundary.jobActiveProcesses -or
            $null -eq $Boundary.jobReportedAccountingActiveProcesses -or
            $null -eq $Boundary.knownProcessIdentityCount -or
            $null -eq $Boundary.jobTotalProcesses -or
            $null -eq $Boundary.residualConsecutiveZeroPolls -or
            $null -eq $Boundary.residualQueryFailures) {
            return $false
        }
        return [string]$Boundary.status -eq
                'VERIFIED_TERMINAL_JOB_ZERO' -and
            [double]$Boundary.elapsedMs -ge 0 -and
            [double]$Boundary.markerObservedElapsedMs -ge 0 -and
            [double]$Boundary.markerObservedElapsedMs -le
                [double]$Boundary.elapsedMs -and
            [bool]$Boundary.completionMarkerValidated -and
            [bool]$Boundary.childReportValidated -and
            [bool]$Boundary.normalExit -and
            [bool]$Boundary.rootExitCodeZero -and
            [int]$Boundary.forcedKillCount -eq 0 -and
            [int]$Boundary.jobMemberCount -eq 0 -and
            [int]$Boundary.jobActiveProcesses -eq 0 -and
            [int]$Boundary.jobReportedAccountingActiveProcesses -eq 0 -and
            [int]$Boundary.knownProcessIdentityCount -eq
                [int]$Boundary.jobTotalProcesses -and
            [bool]$Boundary.residualVerified -and
            [int]$Boundary.residualConsecutiveZeroPolls -ge 3 -and
            [int]$Boundary.residualQueryFailures -eq 0 -and
            [string]$Boundary.finalProcessHistoryStatus -eq
                'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO' -and
            [string]$Boundary.jobCleanupStatus -eq
                'EMPTY_AND_HANDLES_CLOSED'
    } catch {
        return $false
    }
}

function Test-SamplingTerminalBoundaryGate {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$SamplingMetricsAccepted,
        [Parameter()]$TerminalBoundary
    )
    return $SamplingMetricsAccepted -and
        (Test-VerifiedTerminalBoundary -Boundary $TerminalBoundary)
}

function Test-ExactEmptyJobSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$QueryStatus,
        [Parameter(Mandatory = $true)][int]$MemberCount,
        [Parameter()]$ActiveProcesses,
        [Parameter()]$ReportedAccountingActiveProcesses,
        [Parameter()]$KnownProcessIdentityCount,
        [Parameter()]$TotalProcesses
    )
    if ($null -eq $ActiveProcesses -or
        $null -eq $ReportedAccountingActiveProcesses -or
        $null -eq $KnownProcessIdentityCount -or
        $null -eq $TotalProcesses) {
        return $false
    }
    return $QueryStatus -eq 'COMPLETE' -and
        $MemberCount -eq 0 -and
        [int]$ActiveProcesses -eq 0 -and
        [int]$ReportedAccountingActiveProcesses -eq 0 -and
        [int]$KnownProcessIdentityCount -eq [int]$TotalProcesses
}

function Get-ExactEmptySnapshotDisposition {
    param(
        [Parameter(Mandatory = $true)][string]$RootState,
        [Parameter(Mandatory = $true)][bool]$CompletionMarkerObserved
    )
    if ($RootState -eq 'EXITED' -and $CompletionMarkerObserved) {
        return 'RECORD_TERMINAL_ZERO'
    }
    return 'PENDING_TERMINAL_ZERO'
}

function Test-TerminalSamplingEndpointCadence {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$LogicalSamples,
        [Parameter()]$TerminalBoundary,
        [Parameter(Mandatory = $true)][double]$MaximumCadenceMilliseconds
    )
    $samples = @($LogicalSamples)
    if ($samples.Count -lt 1 -or
        -not (Test-VerifiedTerminalBoundary -Boundary $TerminalBoundary)) {
        return $false
    }
    $last = $samples[$samples.Count - 1]
    if ([string]$last.status -eq 'COMPLETE') {
        $endpointGap = [double]$TerminalBoundary.elapsedMs -
            [double]$last.startElapsedMs
        return $endpointGap -ge 0 -and
            $endpointGap -le $MaximumCadenceMilliseconds
    }
    if ([string]$last.status -ne
        'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
        return $false
    }
    $first = $samples.Count - 1
    while ($first -gt 0 -and
        [string]$samples[$first - 1].status -eq
            'VERIFIED_MEMBERSHIP_TRANSITION_GAP') {
        $first -= 1
    }
    return [double]$TerminalBoundary.elapsedMs -ge
            [double]$last.endElapsedMs -and
        (Test-TerminalExitOnlyTransitionEpisode `
            -Samples @($samples[$first..($samples.Count - 1)]))
}

function Test-MembershipTransitionPolicy {
    param([Parameter(Mandatory = $true)]$Summary)
    return [bool]$Summary.boundedByCompleteSamples -and
        [int]$Summary.sampleCount -le
            $script:MaximumVerifiedMembershipTransitionSamples -and
        (Test-MembershipTransitionGapCadence -Gaps @($Summary.gaps)) -and
        [double]$Summary.totalDurationMs -le
            $script:MaximumTotalVerifiedTransitionGapMilliseconds
}

function Resolve-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\?\', [StringComparison]::Ordinal)) {
        $fullPath = $fullPath.Substring(4)
    }
    if (Test-Path -LiteralPath $fullPath) {
        $fullPath = (Get-Item -LiteralPath $fullPath -Force).FullName
    }
    return $fullPath.TrimEnd('\')
}

function Assert-PathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $resolvedPath = Resolve-NormalizedPath -Path $Path
    $resolvedRoot = Resolve-NormalizedPath -Path $Root
    if (-not $resolvedPath.StartsWith(
        "$resolvedRoot\",
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'BERGAMOT_COLD_PWS_PATH_OUTSIDE_ARTIFACT_ROOT'
    }
    return $resolvedPath
}

function Assert-NoReparsePointsInParentChain {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    $cursor = Split-Path -Parent $Path
    $stop = Resolve-NormalizedPath -Path $RepositoryRoot
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'BERGAMOT_COLD_PWS_PARENT_REPARSE_POINT_REJECTED'
            }
        }
        $normalized = Resolve-NormalizedPath -Path $cursor
        if ($normalized.Equals($stop, [StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        $parent = Split-Path -Parent $normalized
        if ($parent -eq $normalized) { break }
        $cursor = $parent
    }
    throw 'BERGAMOT_COLD_PWS_PARENT_CHAIN_INVALID'
}

function Assert-OutputTargetAbsent {
    param([Parameter(Mandatory = $true)][string]$Path)
    $parent = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    $existing = @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop |
        Where-Object { $_.Name.Equals($leaf, [StringComparison]::OrdinalIgnoreCase) })
    if ($existing.Count -ne 0) {
        throw 'BERGAMOT_COLD_PWS_OUTPUT_ALREADY_EXISTS_OR_LINKED'
    }
}

function Assert-RegularFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'BERGAMOT_COLD_PWS_REQUIRED_FILE_INVALID'
    }
    return $item
}

function Convert-ToSafeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.IndexOfAny([char[]]@('"', "`r", "`n", [char]0)) -ge 0) {
        throw 'BERGAMOT_COLD_PWS_PROCESS_ARGUMENT_INVALID'
    }
    return '"' + $Value + '"'
}

function Get-NativeExitCode {
    param([Parameter(Mandatory = $true)][string]$Hex)
    return [Convert]::ToUInt32($Hex, 16)
}

function Get-SanitizedBlockerCode {
    param(
        [Parameter()]$ErrorValue,
        [Parameter(Mandatory = $true)][string]$Fallback
    )
    $value = @(
        [string]$ErrorValue.Exception.Message,
        [string]$ErrorValue.FullyQualifiedErrorId
    ) -join ' '
    $match = [regex]::Match($value, '\bBERGAMOT_[A-Z0-9_]+\b')
    if ($match.Success) { return $match.Value }
    return $Fallback
}

function Invoke-JobProcessQueryWithSingleRetry {
    param(
        [Parameter(Mandatory = $true)]$Launch,
        [Parameter()][scriptblock]$QueryOperation
    )
    $operation = $QueryOperation
    if ($null -eq $operation) {
        $operation = {
            param($BoundLaunch)
            [Phase7BergamotNative]::QueryJobProcesses($BoundLaunch)
        }
    }
    $attempts = 0
    $firstFailureCode = $null
    $lastFailureCode = $null
    while ($attempts -lt 2) {
        $attempts += 1
        try {
            $members = @(& $operation $Launch)
            return [pscustomobject]@{
                Status = 'COMPLETE'
                Members = $members
                Attempts = $attempts
                RetryCount = $attempts - 1
                RetryReasonCode = $firstFailureCode
                FailureCode = $null
                DiscoveryStatus =
                    [string]$Launch.LastProcessDiscoveryStatus
                TotalProcesses = [int]$Launch.LastTotalProcesses
                ActiveProcesses = [int]$Launch.LastActiveProcesses
                ReportedAccountingActiveProcesses =
                    [int]$Launch.LastReportedAccountingActiveProcesses
                KnownProcessIdentityCount =
                    [int]$Launch.KnownProcessIdentities.Count
            }
        } catch {
            $lastFailureCode = Get-SanitizedBlockerCode `
                -ErrorValue $_ `
                -Fallback 'BERGAMOT_JOB_PROCESS_LIST_QUERY_FAILED'
            if ($null -eq $firstFailureCode) {
                $firstFailureCode = $lastFailureCode
            }
        }
    }
    return [pscustomobject]@{
        Status = 'FAILED'
        Members = @()
        Attempts = $attempts
        RetryCount = $attempts - 1
        RetryReasonCode = $firstFailureCode
        FailureCode = $lastFailureCode
        DiscoveryStatus = 'FAILED'
        TotalProcesses = $null
        ActiveProcesses = $null
        ReportedAccountingActiveProcesses = $null
        KnownProcessIdentityCount = $null
    }
}

function Read-BoundedUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int64]$MaximumBytes,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
    )
    $item = Assert-RegularFile -Path $Path
    if ([int64]$item.Length -gt $MaximumBytes) {
        throw 'BERGAMOT_COLD_PWS_CAPTURE_SIZE_LIMIT_EXCEEDED'
    }
    $stream = [IO.FileStream]::new(
        $item.FullName,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None,
        65536,
        [IO.FileOptions]::SequentialScan
    )
    [Phase7BergamotNative]::ValidateUniqueRegularFileHandle(
        $stream.SafeFileHandle.DangerousGetHandle(),
        $item.FullName
    )
    $reader = [IO.StreamReader]::new(
        $stream,
        [Text.UTF8Encoding]::new($false, $true),
        $true,
        65536,
        $false
    )
    try {
        $task = $reader.ReadToEndAsync()
        if (-not $task.Wait($TimeoutMilliseconds)) {
            throw 'BERGAMOT_COLD_PWS_CAPTURE_READ_TIMEOUT'
        }
        $content = $task.GetAwaiter().GetResult()
        [Phase7BergamotNative]::ValidateUniqueRegularFileHandle(
            $stream.SafeFileHandle.DangerousGetHandle(),
            $item.FullName
        )
        return $content
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Get-FileIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Assert-RegularFile -Path $Path
    return [ordered]@{
        sizeBytes = [int64]$item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-TreeIdentity {
    param([Parameter(Mandatory = $true)][string]$Root)
    $resolvedRoot = Resolve-NormalizedPath -Path $Root
    $files = @(Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force |
        Sort-Object FullName)
    $lines = [Collections.Generic.List[string]]::new()
    $verificationEntries = [Collections.Generic.List[object]]::new()
    $totalBytes = 0L
    foreach ($file in $files) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'BERGAMOT_COLD_PWS_TREE_REPARSE_POINT_REJECTED'
        }
        $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart('\').Replace('\', '/')
        $sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $totalBytes += [int64]$file.Length
        $lines.Add("$relative`0$([int64]$file.Length)`0$sha256")
        $verificationEntries.Add([pscustomobject]@{
            AbsolutePath = $file.FullName
            FileName = $file.Name
            SizeBytes = [int64]$file.Length
            Sha256 = $sha256
        })
    }
    if ($files.Count -lt 1) {
        throw 'BERGAMOT_COLD_PWS_TREE_EMPTY'
    }
    return [pscustomobject]@{
        Report = [ordered]@{
            fileCount = $files.Count
            totalBytes = $totalBytes
            treeSha256 = Get-Sha256Text -Value (($lines -join "`n") + "`n")
        }
        VerificationEntries = @($verificationEntries)
    }
}

function Resolve-VerifiedExecutableSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$ObservedPath,
        [Parameter(Mandatory = $true)][object[]]$VerificationEntries,
        [Parameter(Mandatory = $true)][hashtable]$Cache
    )
    $cacheKey = $ObservedPath.ToLowerInvariant()
    if ($Cache.ContainsKey($cacheKey)) {
        return [string]$Cache[$cacheKey]
    }
    $leaf = [IO.Path]::GetFileName($ObservedPath)
    $matches = @($VerificationEntries | Where-Object {
        $_.FileName.Equals($leaf, [StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($candidate in $matches) {
        if ([Phase7BergamotNative]::SameFile(
            $ObservedPath,
            [string]$candidate.AbsolutePath
        )) {
            $Cache[$cacheKey] = [string]$candidate.Sha256
            return [string]$candidate.Sha256
        }
    }
    throw 'BERGAMOT_COLD_PWS_JOB_MEMBER_OUTSIDE_VERIFIED_ELECTRON_DIST'
}

function Get-HarnessIdentity {
    param([Parameter(Mandatory = $true)][string]$ScriptRoot)
    $definitions = [ordered]@{
        runner = 'bergamot-cold-pws-runner.ps1'
        native = 'bergamot-cold-pws-native.cs'
        main = 'bergamot-electron-poc.mjs'
        library = 'bergamot-electron-poc-lib.mjs'
        renderer = 'bergamot-electron-poc-renderer.mjs'
    }
    $identities = [ordered]@{}
    $lines = [Collections.Generic.List[string]]::new()
    $totalBytes = 0L
    foreach ($entry in $definitions.GetEnumerator()) {
        $identity = Get-FileIdentity -Path (Join-Path $ScriptRoot $entry.Value)
        $identities[$entry.Key] = $identity.sha256
        $totalBytes += [int64]$identity.sizeBytes
        $lines.Add("$($entry.Key)`0$($identity.sizeBytes)`0$($identity.sha256)")
    }
    return [ordered]@{
        fileCount = $definitions.Count
        totalBytes = $totalBytes
        fileSetSha256 = Get-Sha256Text -Value (($lines -join "`n") + "`n")
        runnerSha256 = $identities.runner
        nativeSha256 = $identities.native
        electronMainSha256 = $identities.main
        electronLibrarySha256 = $identities.library
        electronRendererSha256 = $identities.renderer
    }
}

function Get-JobZeroEvidence {
    param(
        [Parameter(Mandatory = $true)]$Launch,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    Start-Sleep -Milliseconds $script:ResidualPollMilliseconds
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $consecutiveZero = 0
    $maximumObserved = 0
    $queryFailures = 0
    $lastQueryFailure = $null
    do {
        try {
            $count = @(
                [Phase7BergamotNative]::QueryJobProcessesForCleanup($Launch)
            ).Count
            $maximumObserved = [Math]::Max($maximumObserved, $count)
            $reportedAccountingActiveProcesses =
                [int]$Launch.LastReportedAccountingActiveProcesses
            if ($count -eq 0 -and
                $reportedAccountingActiveProcesses -eq 0) {
                $consecutiveZero += 1
                if ($consecutiveZero -ge 3) {
                    return [pscustomobject]@{
                        Verified = $true
                        ConsecutiveZeroPolls = $consecutiveZero
                        MaximumObserved = $maximumObserved
                        QueryFailures = $queryFailures
                        LastQueryFailure = $lastQueryFailure
                    }
                }
            } else {
                $consecutiveZero = 0
            }
        } catch {
            $queryFailures += 1
            $consecutiveZero = 0
            $lastQueryFailure = Get-SanitizedBlockerCode `
                -ErrorValue $_ `
                -Fallback 'BERGAMOT_JOB_PROCESS_LIST_QUERY_FAILED'
        }
        Start-Sleep -Milliseconds $script:ResidualPollMilliseconds
    } while ([DateTime]::UtcNow -lt $deadline)
    return [pscustomobject]@{
        Verified = $false
        ConsecutiveZeroPolls = $consecutiveZero
        MaximumObserved = $maximumObserved
        QueryFailures = $queryFailures
        LastQueryFailure = $lastQueryFailure
    }
}

function Read-WarmCompletionMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Direction
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds(
        $script:CaptureReadTimeoutMilliseconds
    )
    do {
        try {
            $json = Read-BoundedUtf8File `
                -Path $Path `
                -MaximumBytes 65536 `
                -TimeoutMilliseconds $script:CaptureReadTimeoutMilliseconds
            $marker = $json | ConvertFrom-Json
            if ($marker.schemaVersion -ne
                    'phase7-bergamot-warm-complete-v1' -or
                $marker.status -ne 'WARM_SEQUENCE_COMPLETE' -or
                $marker.direction -ne $Direction -or
                [string]$marker.bindingSha256 -notmatch
                    $script:Sha256Pattern -or
                $marker.rawTextEmitted -ne $false -or
                $marker.rawPathsEmitted -ne $false -or
                $null -eq $marker.binding) {
                throw 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_INVALID'
            }
            $canonicalBinding = [ordered]@{
                direction = [string]$marker.binding.direction
                manifestSha256 = [string]$marker.binding.manifestSha256
                supplyTreeSha256 =
                    [string]$marker.binding.supplyTreeSha256
                materializedRuntimeTreeSha256 =
                    [string]$marker.binding.materializedRuntimeTreeSha256
                servedRuntimeTreeSha256 =
                    [string]$marker.binding.servedRuntimeTreeSha256
                workloadConfigSha256 =
                    [string]$marker.binding.workloadConfigSha256
                sourceSha256 = [string]$marker.binding.sourceSha256
                sampleIdentitySha256 =
                    [string]$marker.binding.sampleIdentitySha256
                targetSha256 = [string]$marker.binding.targetSha256
                warmTargetSha256 = @(
                    $marker.binding.warmTargetSha256 |
                        ForEach-Object { [string]$_ }
                )
                harnessStartToWarmSequenceCompleteMs =
                    [double]$marker.binding.harnessStartToWarmSequenceCompleteMs
            }
            if ($canonicalBinding.direction -ne $Direction -or
                $canonicalBinding.warmTargetSha256.Count -ne 5 -or
                (Get-Sha256Text -Value (
                    $canonicalBinding |
                        ConvertTo-Json -Depth 10 -Compress
                )) -ne [string]$marker.bindingSha256) {
                throw 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_BINDING_INVALID'
            }
            return [pscustomobject]@{
                Binding = $canonicalBinding
                BindingSha256 = [string]$marker.bindingSha256
            }
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_READ_FAILED'
            }
            Start-Sleep -Milliseconds 25
        }
    } while ($true)
}

function Assert-WarmCompletionMarkerBinding {
    param(
        [Parameter(Mandatory = $true)]$Marker,
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string]$Direction
    )
    $route = $Report.routes[0]
    $reportBinding = [ordered]@{
        direction = $Direction
        manifestSha256 = [string]$Report.manifestSha256
        supplyTreeSha256 = [string]$Report.supplyTreeSha256
        materializedRuntimeTreeSha256 =
            [string]$Report.materializedRuntimeTreeSha256
        servedRuntimeTreeSha256 =
            [string]$Report.servedRuntimeTreeSha256
        workloadConfigSha256 = [string]$Report.workloadConfigSha256
        sourceSha256 = [string]$route.sourceSha256
        sampleIdentitySha256 = [string]$route.sampleIdentitySha256
        targetSha256 = [string]$route.targetSha256
        warmTargetSha256 = @(
            $route.warm.observations |
                ForEach-Object { [string]$_.targetSha256 }
        )
        harnessStartToWarmSequenceCompleteMs =
            [double]$Report.harnessStartToWarmSequenceCompleteMs
    }
    $reportBindingSha256 = Get-Sha256Text -Value (
        $reportBinding | ConvertTo-Json -Depth 10 -Compress
    )
    if ($Report.completionMarker.status -ne
            'BOUND_CREATE_NEW_ARTIFACT' -or
        [string]$Report.completionMarker.bindingSha256 -ne
            [string]$Marker.BindingSha256 -or
        $reportBindingSha256 -ne [string]$Marker.BindingSha256) {
        throw 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_REPORT_MISMATCH'
    }
}

function Assert-ChildReport {
    param(
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string]$Direction,
        [Parameter(Mandatory = $true)]$ElectronIdentity
    )
    if ($Report.status -ne $script:SuccessPocStatus -or
        $Report.runMode -ne 'DIRECTION_COLD_TRIAL' -or
        $Report.requestedDirection -ne $Direction -or
        $Report.rawTextEmitted -ne $false -or
        $Report.rawPathsEmitted -ne $false -or
        $Report.packageMutated -ne $false -or
        $Report.integrationOrDistributionAuthorized -ne $false) {
        throw 'BERGAMOT_COLD_PWS_CHILD_REPORT_STATUS_INVALID'
    }
    if ($Report.routes.Count -ne 1 -or
        $Report.routes[0].direction -ne $Direction -or
        $Report.routes[0].status -ne 'FIRST_TRANSLATION_COMPLETE' -or
        $Report.routes[0].translatorCleanupStatus -ne 'DELETE_PROMISE_RESOLVED') {
        throw 'BERGAMOT_COLD_PWS_CHILD_ROUTE_INVALID'
    }
    $route = $Report.routes[0]
    if ([int]$route.sourceChars -lt 1 -or
        [string]$route.sourceSha256 -notmatch $script:Sha256Pattern -or
        [string]$Report.workloadConfigSha256 -notmatch $script:Sha256Pattern -or
        [string]$route.sampleIdentitySha256 -notmatch $script:Sha256Pattern) {
        throw 'BERGAMOT_COLD_PWS_CHILD_WORKLOAD_IDENTITY_INVALID'
    }
    $warm = $route.warm
    if ([int]$Report.warmIterationsPerRoute -ne 5 -or
        [int]$warm.iterationsRequested -ne 5 -or
        [int]$warm.failures -lt 0 -or
        [int]$warm.failures -gt 5 -or
        @($warm.observations).Count -ne (5 - [int]$warm.failures)) {
        throw 'BERGAMOT_COLD_PWS_CHILD_WARM_RESULT_INVALID'
    }
    foreach ($observation in @($warm.observations)) {
        if ([double]$observation.translationOnlyMs -lt 0 -or
            [int]$observation.targetChars -lt 1 -or
            [string]$observation.targetSha256 -notmatch $script:Sha256Pattern) {
            throw 'BERGAMOT_COLD_PWS_CHILD_WARM_OBSERVATION_INVALID'
        }
    }
    if ($Report.cleanup.browserWindow -ne 'DESTROYED' -or
        $Report.cleanup.sessionStorage -ne 'CLEARED' -or
        $Report.cleanup.sessionCache -ne 'CLEARED' -or
        $Report.cleanup.sessionConnections -ne 'CLOSED' -or
        $Report.cleanup.staticServer -ne 'CLOSED') {
        throw 'BERGAMOT_COLD_PWS_CHILD_CLEANUP_INVALID'
    }
    if ($Report.networkPolicy.allowedRequestCount -ne $Report.networkPolicy.servedRequestCount -or
        $Report.networkPolicy.blockedExternalRequestCount -ne 0 -or
        $Report.networkPolicy.blockedUnknownLoopbackRequestCount -ne 0 -or
        $Report.networkPolicy.deniedStaticRequestCount -ne 0) {
        throw 'BERGAMOT_COLD_PWS_CHILD_NETWORK_POLICY_INVALID'
    }
    if ($Report.environmentStatus.electronVersion -ne $ElectronIdentity.version -or
        [int64]$Report.environmentStatus.electronExecutable.sizeBytes -ne [int64]$ElectronIdentity.sizeBytes -or
        $Report.environmentStatus.electronExecutable.sha256 -ne $ElectronIdentity.sha256 -or
        $Report.environmentStatus.electronExecutable.authenticodeStatus -ne
            'NOT_VERIFIED') {
        throw 'BERGAMOT_COLD_PWS_CHILD_ELECTRON_IDENTITY_MISMATCH'
    }
    foreach ($hashValue in @(
        $Report.manifestSha256,
        $Report.supplyTreeSha256,
        $Report.materializedRuntimeTreeSha256,
        $Report.servedRuntimeTreeSha256
    )) {
        if ([string]$hashValue -notmatch $script:Sha256Pattern) {
            throw 'BERGAMOT_COLD_PWS_CHILD_ARTIFACT_IDENTITY_INVALID'
        }
    }
    foreach ($metric in @(
        $route.firstTranslationMs,
        $route.coldRouteTotalMs,
        $route.totalMs,
        $Report.harnessStartToWarmSequenceCompleteMs
    )) {
        if ($null -eq $metric -or [double]$metric -lt 0) {
            throw 'BERGAMOT_COLD_PWS_CHILD_TIMING_INVALID'
        }
    }
}

function Assert-IdentityConsistency {
    param(
        [Parameter(Mandatory = $true)]$ChildReport,
        [Parameter(Mandatory = $true)][string]$Direction,
        [Parameter(Mandatory = $true)][hashtable]$IdentityState
    )
    $route = $ChildReport.routes[0]
    $values = [ordered]@{
        manifestSha256 = [string]$ChildReport.manifestSha256
        materializedRuntimeTreeSha256 = [string]$ChildReport.materializedRuntimeTreeSha256
        servedRuntimeTreeSha256 = [string]$ChildReport.servedRuntimeTreeSha256
        "supplyTreeSha256_$Direction" = [string]$ChildReport.supplyTreeSha256
        "workloadConfigSha256_$Direction" = [string]$ChildReport.workloadConfigSha256
        "sampleIdentitySha256_$Direction" = [string]$route.sampleIdentitySha256
        "sourceSha256_$Direction" = [string]$route.sourceSha256
        "sourceChars_$Direction" = [int]$route.sourceChars
    }
    foreach ($entry in $values.GetEnumerator()) {
        if ($IdentityState.ContainsKey($entry.Key) -and
            $IdentityState[$entry.Key] -ne $entry.Value) {
            throw 'BERGAMOT_COLD_PWS_IDENTITY_DRIFT'
        }
        $IdentityState[$entry.Key] = $entry.Value
    }
}

function Invoke-DirectionTrial {
    param(
        [Parameter(Mandatory = $true)][string]$Direction,
        [Parameter(Mandatory = $true)][int]$TrialNumber,
        [Parameter(Mandatory = $true)][string]$ElectronPath,
        [Parameter(Mandatory = $true)][string]$PocScriptPath,
        [Parameter(Mandatory = $true)][string]$AuthorizationPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$TrialArtifactRoot,
        [Parameter(Mandatory = $true)]$ElectronIdentity,
        [Parameter(Mandatory = $true)][object[]]$ElectronDistVerificationEntries,
        [Parameter(Mandatory = $true)][hashtable]$ExecutableVerificationCache,
        [Parameter(Mandatory = $true)][hashtable]$IdentityState
    )
    $failureCode = $null
    $forcedKillCount = 0
    $measurementFailureCount = 0
    $discardedSampleCount = 0
    $jobProcessQueryRetryCount = 0
    $jobProcessQueryFailedAfterRetryCount = 0
    $pendingTerminalZeroPollCount = 0
    $postExitJobQueryFailureCount = 0
    $launch = $null
    $launchResumed = $false
    $loopCompletedNormally = $false
    $jobClosed = $false
    $jobCleanupStatus = 'NOT_CREATED'
    $finalProcessHistoryStatus = 'NOT_VERIFIED'
    $finalKnownProcessIdentityCount = $null
    $finalJobTotalProcesses = $null
    $finalJobActiveProcesses = $null
    $finalJobReportedAccountingActiveProcesses = $null
    $normalExit = $false
    $childReportValidated = $false
    $childReport = $null
    $completionMarkerObserved = $false
    $completionMarkerValidated = $false
    $completionMarker = $null
    $markerObservedElapsedMilliseconds = $null
    $terminalJobZeroElapsedMilliseconds = $null
    $terminalJobZeroKnownProcessIdentityCount = $null
    $terminalJobZeroTotalProcesses = $null
    $terminalJobZeroActiveProcesses = $null
    $terminalJobZeroReportedAccountingActiveProcesses = $null
    $terminalBoundary = $null
    $logicalSamples = [Collections.Generic.List[object]]::new()
    $sampleStarts = [Collections.Generic.List[double]]::new()
    $validSampleStarts = [Collections.Generic.List[double]]::new()
    $validSampleEnds = [Collections.Generic.List[double]]::new()
    $ordinalByIdentity = @{}
    $nextProcessOrdinal = 1
    $privateWorkingSetPeakBytes = 0L
    $maximumTreeProcessCount = 0
    $launchToFirstSampleMilliseconds = $null
    $rootExitCode = $null
    $captureStdoutBytes = 0L
    $captureStderrBytes = 0L
    $residual = [pscustomobject]@{
        Verified = $false
        ConsecutiveZeroPolls = 0
        MaximumObserved = 0
        QueryFailures = 0
    }
    $wall = [Diagnostics.Stopwatch]::new()

    $trialPrefix = "$Direction-$TrialNumber-$([Guid]::NewGuid().ToString('N'))"
    $stdoutPath = Join-Path $TrialArtifactRoot "$trialPrefix.stdout.json"
    $stderrPath = Join-Path $TrialArtifactRoot "$trialPrefix.stderr.txt"
    $childReportPath = Join-Path $TrialArtifactRoot "$trialPrefix.report.json"
    $completionMarkerPath = Join-Path `
        $TrialArtifactRoot `
        "$trialPrefix.warm-complete.json"
    foreach ($path in @(
        $stdoutPath,
        $stderrPath,
        $childReportPath,
        $completionMarkerPath
    )) {
        Assert-OutputTargetAbsent -Path $path
    }

    try {
        $arguments = @(
            $PocScriptPath,
            '--poc-authorization',
            $AuthorizationPath,
            '--direction',
            $Direction,
            '--completion-marker',
            $completionMarkerPath,
            '--output',
            $childReportPath
        )
        $argumentLine = ($arguments | ForEach-Object {
            Convert-ToSafeArgument -Value ([string]$_)
        }) -join ' '
        $launch = [Phase7BergamotNative]::CreateSuspendedJobProcess(
            $ElectronPath,
            $argumentLine,
            $WorkingDirectory,
            $stdoutPath,
            $stderrPath
        )
        $initialMembers = @([Phase7BergamotNative]::QueryJobProcesses($launch))
        if ($initialMembers.Count -ne 1 -or
            [int]$initialMembers[0].ProcessId -ne [int]$launch.ProcessId -or
            [int64]$initialMembers[0].CreationTicks -ne [int64]$launch.CreationTicks -or
            -not [Phase7BergamotNative]::SameFile(
                [string]$initialMembers[0].ExecutablePath,
                $ElectronPath
            )) {
            throw 'BERGAMOT_COLD_PWS_SUSPENDED_JOB_ROOT_IDENTITY_INVALID'
        }

        $wall.Start()
        [Phase7BergamotNative]::ResumeJobRoot($launch)
        $launchResumed = $true
        $nextSampleDue = 0.0

        while ($wall.Elapsed.TotalSeconds -lt $TrialTimeoutSeconds) {
            if (-not $completionMarkerObserved -and
                (Test-Path -LiteralPath $completionMarkerPath)) {
                $completionMarkerObserved = $true
                $markerObservedElapsedMilliseconds =
                    $wall.Elapsed.TotalMilliseconds
            }

            $skipPrivateWorkingSetSample = $false
            $rootState = [Phase7BergamotNative]::WaitForRoot($launch, 0)
            if ($rootState -eq 'EXITED') {
                try {
                    $terminalMembers = @(
                        [Phase7BergamotNative]::QueryJobProcesses($launch)
                    )
                    $terminalExactZero =
                        $terminalMembers.Count -eq 0 -and
                        [int]$launch.LastActiveProcesses -eq 0 -and
                        [int]$launch.LastReportedAccountingActiveProcesses -eq
                            0 -and
                        [int]$launch.KnownProcessIdentities.Count -eq
                            [int]$launch.LastTotalProcesses
                    if ($terminalExactZero -and $completionMarkerObserved) {
                        $terminalJobZeroElapsedMilliseconds =
                            $wall.Elapsed.TotalMilliseconds
                        $terminalJobZeroKnownProcessIdentityCount =
                            [int]$launch.KnownProcessIdentities.Count
                        $terminalJobZeroTotalProcesses =
                            [int]$launch.LastTotalProcesses
                        $terminalJobZeroActiveProcesses =
                            [int]$launch.LastActiveProcesses
                        $terminalJobZeroReportedAccountingActiveProcesses =
                            [int]$launch.LastReportedAccountingActiveProcesses
                        $loopCompletedNormally = $true
                        break
                    }
                    if ($terminalMembers.Count -eq 0) {
                        $skipPrivateWorkingSetSample = $true
                    }
                } catch {
                    $postExitJobQueryFailureCount += 1
                    if ($null -eq $failureCode) {
                        $failureCode =
                            'BERGAMOT_COLD_PWS_POST_EXIT_JOB_QUERY_FAILED'
                    }
                    break
                }
            }

            foreach ($capturePath in @($stdoutPath, $stderrPath)) {
                if (Test-Path -LiteralPath $capturePath) {
                    $captureLength = [int64](Get-Item -LiteralPath $capturePath -Force).Length
                    if ($captureLength -gt $script:MaximumCaptureBytes) {
                        if ($null -eq $failureCode) {
                            $failureCode = 'BERGAMOT_COLD_PWS_CAPTURE_SIZE_LIMIT_EXCEEDED'
                        }
                        $forcedKillCount += [Math]::Max(
                            1,
                            [Phase7BergamotNative]::TerminateJob(
                                $launch,
                                (Get-NativeExitCode -Hex 'E0000002')
                            )
                        )
                        break
                    }
                }
            }
            if ($forcedKillCount -gt 0) { break }
            if ($skipPrivateWorkingSetSample) {
                $nextSampleDue += $SampleIntervalMilliseconds
                $remaining = $nextSampleDue -
                    $wall.Elapsed.TotalMilliseconds
                if ($remaining -gt 0) {
                    Start-Sleep -Milliseconds ([int][Math]::Min(
                        $remaining,
                        $SampleIntervalMilliseconds
                    ))
                }
                continue
            }

            $sampleStart = $wall.Elapsed.TotalMilliseconds
            if ($null -eq $launchToFirstSampleMilliseconds) {
                $launchToFirstSampleMilliseconds = $sampleStart
            }
            $sampleStarts.Add($sampleStart)
            $jobQueryStarted = $wall.Elapsed.TotalMilliseconds
            $members = @()
            $postMembers = @()
            $jobQueryStatus = 'COMPLETE'
            $postJobQueryStatus = 'NOT_RUN'
            $memberDiscoveryStatus = 'NOT_AVAILABLE'
            $membershipRevalidationStatus = 'NOT_RUN'
            $preTotalProcesses = $null
            $preActiveProcesses = $null
            $preReportedAccountingActiveProcesses = $null
            $preKnownProcessIdentityCount = $null
            $postTotalProcesses = $null
            $postActiveProcesses = $null
            $postReportedAccountingActiveProcesses = $null
            $postKnownProcessIdentityCount = $null
            $preJobQueryAttempts = 0
            $preJobQueryRetryCount = 0
            $preJobQueryRetryReasonCode = $null
            $preJobQueryFailureCode = $null
            $postJobQueryAttempts = 0
            $postJobQueryRetryCount = 0
            $postJobQueryRetryReasonCode = $null
            $postJobQueryFailureCode = $null
            $transitionReason = $null
            $transitionVerificationStatus = 'NOT_VERIFIED'
            $transitionTotalProcessesBefore = $null
            $transitionTotalProcessesAfter = $null
            $transitionAccountingActiveProcessesBefore = $null
            $transitionAccountingActiveProcessesAfter = $null
            $transitionBoundActiveProcesses = $null
            $transitionKnownProcessIdentityCount = $null
            $transitionBoundActiveProcessEntries = $null
            $localMeasurementFailureCount = 0
            $preJobQuery = Invoke-JobProcessQueryWithSingleRetry `
                -Launch $launch
            $preJobQueryAttempts = [int]$preJobQuery.Attempts
            $preJobQueryRetryCount = [int]$preJobQuery.RetryCount
            $preJobQueryRetryReasonCode =
                $preJobQuery.RetryReasonCode
            $preJobQueryFailureCode = $preJobQuery.FailureCode
            $jobProcessQueryRetryCount += $preJobQueryRetryCount
            if ($preJobQuery.Status -eq 'COMPLETE') {
                $members = @(
                    $preJobQuery.Members |
                        Sort-Object CreationTicks, ProcessId
                )
                $memberDiscoveryStatus =
                    [string]$preJobQuery.DiscoveryStatus
                $preTotalProcesses = [int]$preJobQuery.TotalProcesses
                $preActiveProcesses = [int]$preJobQuery.ActiveProcesses
                $preReportedAccountingActiveProcesses =
                    [int]$preJobQuery.ReportedAccountingActiveProcesses
                $preKnownProcessIdentityCount =
                    [int]$preJobQuery.KnownProcessIdentityCount
            } else {
                $jobQueryStatus = 'FAILED'
                $localMeasurementFailureCount += 1
                $jobProcessQueryFailedAfterRetryCount += 1
            }
            $jobQueryEnded = $wall.Elapsed.TotalMilliseconds
            $preSnapshotExactZero = Test-ExactEmptyJobSnapshot `
                -QueryStatus $jobQueryStatus `
                -MemberCount $members.Count `
                -ActiveProcesses $preActiveProcesses `
                -ReportedAccountingActiveProcesses `
                    $preReportedAccountingActiveProcesses `
                -KnownProcessIdentityCount `
                    $preKnownProcessIdentityCount `
                -TotalProcesses $preTotalProcesses
            if ($preSnapshotExactZero) {
                $rootStateAfterEmptySnapshot =
                    [Phase7BergamotNative]::WaitForRoot($launch, 0)
                $emptySnapshotDisposition =
                    Get-ExactEmptySnapshotDisposition `
                        -RootState $rootStateAfterEmptySnapshot `
                        -CompletionMarkerObserved `
                            $completionMarkerObserved
                if ($emptySnapshotDisposition -eq
                    'RECORD_TERMINAL_ZERO') {
                    $terminalJobZeroElapsedMilliseconds =
                        $wall.Elapsed.TotalMilliseconds
                    $terminalJobZeroKnownProcessIdentityCount =
                        [int]$preKnownProcessIdentityCount
                    $terminalJobZeroTotalProcesses =
                        [int]$preTotalProcesses
                    $terminalJobZeroActiveProcesses =
                        [int]$preActiveProcesses
                    $terminalJobZeroReportedAccountingActiveProcesses =
                        [int]$preReportedAccountingActiveProcesses
                    $loopCompletedNormally = $true
                    break
                }
                $pendingTerminalZeroPollCount += 1
                $nextSampleDue += $SampleIntervalMilliseconds
                $remaining = $nextSampleDue -
                    $wall.Elapsed.TotalMilliseconds
                if ($remaining -gt 0) {
                    Start-Sleep -Milliseconds ([int][Math]::Min(
                        $remaining,
                        $SampleIntervalMilliseconds
                    ))
                }
                continue
            }
            $maximumTreeProcessCount = [Math]::Max(
                $maximumTreeProcessCount,
                $members.Count
            )
            $queries = [Collections.Generic.List[object]]::new()
            $samplePrivateBytes = 0L
            $preProcessOrdinals = [Collections.Generic.List[int]]::new()
            foreach ($member in $members) {
                $identityKey = "$([int]$member.ProcessId):$([int64]$member.CreationTicks)"
                $memberExecutableSha256 = Resolve-VerifiedExecutableSha256 `
                    -ObservedPath ([string]$member.ExecutablePath) `
                    -VerificationEntries $ElectronDistVerificationEntries `
                    -Cache $ExecutableVerificationCache
                if (-not $ordinalByIdentity.ContainsKey($identityKey)) {
                    $ordinalByIdentity[$identityKey] = $nextProcessOrdinal
                    $nextProcessOrdinal += 1
                }
                $preProcessOrdinals.Add(
                    [int]$ordinalByIdentity[$identityKey]
                )
                $queryStart = $wall.Elapsed.TotalMilliseconds
                $queryResult = [Phase7BergamotNative]::PrivateWorkingSetBytes(
                    $launch,
                    [int]$member.ProcessId,
                    [int64]$member.CreationTicks
                )
                $queryEnd = $wall.Elapsed.TotalMilliseconds
                if ($queryResult.Status -ne 'COMPLETE') {
                    $localMeasurementFailureCount += 1
                } else {
                    $samplePrivateBytes += [int64]$queryResult.PrivateWorkingSetBytes
                }
                $queries.Add([ordered]@{
                    processOrdinal = [int]$ordinalByIdentity[$identityKey]
                    executableSha256 = $memberExecutableSha256
                    startOffsetMs = [Math]::Round($queryStart - $sampleStart, 3)
                    endOffsetMs = [Math]::Round($queryEnd - $sampleStart, 3)
                    durationMs = [Math]::Round($queryEnd - $queryStart, 3)
                    status = [string]$queryResult.Status
                    privateWorkingSetBytes = if ($queryResult.Status -eq 'COMPLETE') {
                        [int64]$queryResult.PrivateWorkingSetBytes
                    } else { $null }
                })
            }

            $postProcessOrdinals = [Collections.Generic.List[int]]::new()
            $identitySetChanged = $false
            $accountingChanged = $false
            if ($jobQueryStatus -eq 'COMPLETE' -and $members.Count -gt 0) {
                $postJobQuery =
                    Invoke-JobProcessQueryWithSingleRetry -Launch $launch
                $postJobQueryAttempts = [int]$postJobQuery.Attempts
                $postJobQueryRetryCount = [int]$postJobQuery.RetryCount
                $postJobQueryRetryReasonCode =
                    $postJobQuery.RetryReasonCode
                $postJobQueryFailureCode = $postJobQuery.FailureCode
                $jobProcessQueryRetryCount += $postJobQueryRetryCount
                if ($postJobQuery.Status -eq 'COMPLETE') {
                    $postMembers = @(
                        $postJobQuery.Members |
                            Sort-Object CreationTicks, ProcessId
                    )
                    $preIdentitySet = @($members | ForEach-Object {
                        "$([int]$_.ProcessId):$([int64]$_.CreationTicks)"
                    })
                    $postIdentitySet = @($postMembers | ForEach-Object {
                        "$([int]$_.ProcessId):$([int64]$_.CreationTicks)"
                    })
                    foreach ($postMember in $postMembers) {
                        $postIdentityKey =
                            "$([int]$postMember.ProcessId):$([int64]$postMember.CreationTicks)"
                        if (-not $ordinalByIdentity.ContainsKey(
                            $postIdentityKey
                        )) {
                            $ordinalByIdentity[$postIdentityKey] =
                                $nextProcessOrdinal
                            $nextProcessOrdinal += 1
                        }
                        $postProcessOrdinals.Add(
                            [int]$ordinalByIdentity[$postIdentityKey]
                        )
                    }
                    $identityDifferences = @(
                        Compare-Object `
                            -ReferenceObject $preIdentitySet `
                            -DifferenceObject $postIdentitySet
                    )
                    $identitySetChanged =
                        $preIdentitySet.Count -ne $postIdentitySet.Count -or
                        $identityDifferences.Count -ne 0
                    $postTotalProcesses =
                        [int]$postJobQuery.TotalProcesses
                    $postActiveProcesses =
                        [int]$postJobQuery.ActiveProcesses
                    $postReportedAccountingActiveProcesses =
                        [int]$postJobQuery.ReportedAccountingActiveProcesses
                    $postKnownProcessIdentityCount =
                        [int]$postJobQuery.KnownProcessIdentityCount
                    $accountingChanged =
                        $postTotalProcesses -ne [int]$preTotalProcesses -or
                        $postActiveProcesses -ne [int]$preActiveProcesses
                    $membershipRevalidationStatus =
                        [string]$postJobQuery.DiscoveryStatus
                    $postJobQueryStatus = 'COMPLETE'
                } else {
                    $localMeasurementFailureCount += 1
                    $jobProcessQueryFailedAfterRetryCount += 1
                    $postJobQueryStatus = 'FAILED'
                    $membershipRevalidationStatus = 'FAILED'
                }
            }

            $sampleStatus = 'DISCARDED'
            $exactTransitionQueryFailuresBound =
                Test-ExactTransitionQueryFailuresBound `
                    -ProcessQueries @($queries) `
                    -PreProcessOrdinals @($preProcessOrdinals) `
                    -PostProcessOrdinals @($postProcessOrdinals)
            if ($jobQueryStatus -eq 'COMPLETE' -and
                $members.Count -gt 0 -and
                $postJobQueryStatus -eq 'COMPLETE' -and
                -not $identitySetChanged -and
                -not $accountingChanged -and
                $localMeasurementFailureCount -eq 0) {
                $sampleStatus = 'COMPLETE'
            } elseif ($jobQueryStatus -eq 'COMPLETE' -and
                $postJobQueryStatus -eq 'COMPLETE' -and
                $identitySetChanged -and
                [int]$preKnownProcessIdentityCount -eq
                    [int]$preTotalProcesses -and
                [int]$postKnownProcessIdentityCount -eq
                    [int]$postTotalProcesses -and
                $exactTransitionQueryFailuresBound) {
                $sampleStatus = 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
                $transitionReason = 'EXACT_ACTIVE_SET_CHANGED'
                $transitionVerificationStatus =
                    'VERIFIED_PRE_POST_COMPLETE_HISTORY_IDENTITY_SET_CHANGE'
            } elseif ($jobQueryStatus -eq 'COMPLETE' -and
                $postJobQueryStatus -ne 'FAILED') {
                try {
                    $transitionProbe =
                        [Phase7BergamotNative]::ProbeKnownProcessExitTransition(
                            $launch
                        )
                    if ($transitionProbe.Status -eq
                        'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG') {
                        $boundActiveEntries =
                            [Collections.Generic.List[object]]::new()
                        foreach ($activeRecord in @(
                            $transitionProbe.BoundActiveRecords
                        )) {
                            $activeIdentityKey =
                                "$([int]$activeRecord.ProcessId):$([int64]$activeRecord.CreationTicks)"
                            if (-not $ordinalByIdentity.ContainsKey(
                                $activeIdentityKey
                            )) {
                                throw 'BERGAMOT_TRANSITION_ACTIVE_IDENTITY_NOT_PREVIOUSLY_BOUND'
                            }
                            $activeExecutableSha256 =
                                Resolve-VerifiedExecutableSha256 `
                                    -ObservedPath ([string]$activeRecord.ExecutablePath) `
                                    -VerificationEntries $ElectronDistVerificationEntries `
                                    -Cache $ExecutableVerificationCache
                            $boundActiveEntries.Add([ordered]@{
                                processOrdinal =
                                    [int]$ordinalByIdentity[$activeIdentityKey]
                                executableSha256 =
                                    $activeExecutableSha256
                            })
                        }
                        if ($boundActiveEntries.Count -ne
                            [int]$transitionProbe.BoundActiveProcesses) {
                            throw 'BERGAMOT_TRANSITION_ACTIVE_IDENTITY_COUNT_MISMATCH'
                        }
                        $boundActiveOrdinals = @(
                            $boundActiveEntries |
                                ForEach-Object { [int]$_.processOrdinal }
                        )
                        $exitBoundFailureStatuses = @(
                            'OPEN_FAILED',
                            'PRE_IDENTITY_OR_ACTIVE_MISMATCH',
                            'POST_IDENTITY_OR_ACTIVE_MISMATCH'
                        )
                        $unboundProcessQueryFailures = @(
                            $queries |
                                Where-Object status -ne 'COMPLETE' |
                                Where-Object {
                                    $exitBoundFailureStatuses -notcontains
                                        [string]$_.status -or
                                    $boundActiveOrdinals -contains
                                        [int]$_.processOrdinal
                                }
                        )
                        if ($unboundProcessQueryFailures.Count -ne 0) {
                            throw 'BERGAMOT_TRANSITION_QUERY_FAILURE_NOT_BOUND_TO_EXIT'
                        }
                        $sampleStatus =
                            'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
                        $transitionReason =
                            'BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
                        $transitionVerificationStatus =
                            [string]$transitionProbe.Status
                        $transitionTotalProcessesBefore =
                            [int]$transitionProbe.TotalProcessesBefore
                        $transitionTotalProcessesAfter =
                            [int]$transitionProbe.TotalProcessesAfter
                        $transitionAccountingActiveProcessesBefore =
                            [int]$transitionProbe.AccountingActiveProcessesBefore
                        $transitionAccountingActiveProcessesAfter =
                            [int]$transitionProbe.AccountingActiveProcessesAfter
                        $transitionBoundActiveProcesses =
                            [int]$transitionProbe.BoundActiveProcesses
                        $transitionKnownProcessIdentityCount =
                            [int]$transitionProbe.KnownProcessIdentities
                        $transitionBoundActiveProcessEntries =
                            @($boundActiveEntries)
                    }
                } catch {}
            }

            $sampleEnd = $wall.Elapsed.TotalMilliseconds
            $queryStarts = @($queries | ForEach-Object startOffsetMs)
            $maximumQuerySkew = if ($queryStarts.Count -lt 2) {
                0.0
            } else {
                [double](($queryStarts | Measure-Object -Maximum).Maximum) -
                    [double](($queryStarts | Measure-Object -Minimum).Minimum)
            }
            if ($sampleStatus -eq 'DISCARDED') {
                $discardedSampleCount += 1
                $measurementFailureCount +=
                    $localMeasurementFailureCount
            } elseif ($sampleStatus -eq 'COMPLETE') {
                $validSampleStarts.Add($sampleStart)
                $validSampleEnds.Add($sampleEnd)
                $privateWorkingSetPeakBytes = [Math]::Max(
                    $privateWorkingSetPeakBytes,
                    $samplePrivateBytes
                )
            }
            $maximumTreeProcessCount = [Math]::Max(
                $maximumTreeProcessCount,
                [Math]::Max(
                    $postMembers.Count,
                    $(if ($null -eq $transitionBoundActiveProcesses) {
                        0
                    } else {
                        [int]$transitionBoundActiveProcesses
                    })
                )
            )
            $logicalSamples.Add([ordered]@{
                sample = $logicalSamples.Count + 1
                startElapsedMs = [Math]::Round($sampleStart, 3)
                endElapsedMs = [Math]::Round($sampleEnd, 3)
                spanMs = [Math]::Round($sampleEnd - $sampleStart, 3)
                jobMemberQueryMs = [Math]::Round($jobQueryEnded - $jobQueryStarted, 3)
                preJobQueryStatus = $jobQueryStatus
                preJobQueryAttempts = $preJobQueryAttempts
                preJobQueryRetryCount = $preJobQueryRetryCount
                preJobQueryRetryReasonCode =
                    $preJobQueryRetryReasonCode
                preJobQueryFailureCode = $preJobQueryFailureCode
                postJobQueryStatus = $postJobQueryStatus
                postJobQueryAttempts = $postJobQueryAttempts
                postJobQueryRetryCount = $postJobQueryRetryCount
                postJobQueryRetryReasonCode =
                    $postJobQueryRetryReasonCode
                postJobQueryFailureCode = $postJobQueryFailureCode
                memberCount = $members.Count
                memberDiscoveryStatus = $memberDiscoveryStatus
                membershipRevalidationStatus =
                    $membershipRevalidationStatus
                jobTotalProcesses = $preTotalProcesses
                jobActiveProcesses = $preActiveProcesses
                jobReportedAccountingActiveProcesses =
                    $preReportedAccountingActiveProcesses
                preKnownProcessIdentityCount =
                    $preKnownProcessIdentityCount
                postMemberCount = if ($postJobQueryStatus -eq 'COMPLETE') {
                    $postMembers.Count
                } else { $null }
                postJobTotalProcesses = $postTotalProcesses
                postJobActiveProcesses = $postActiveProcesses
                postJobReportedAccountingActiveProcesses =
                    $postReportedAccountingActiveProcesses
                postKnownProcessIdentityCount =
                    $postKnownProcessIdentityCount
                preProcessOrdinals = @($preProcessOrdinals)
                postProcessOrdinals = @($postProcessOrdinals)
                maximumProcessQuerySkewMs = [Math]::Round($maximumQuerySkew, 3)
                status = $sampleStatus
                transitionReason = $transitionReason
                transitionVerificationStatus =
                    $transitionVerificationStatus
                transitionInternalMeasurementFailureCount =
                    $localMeasurementFailureCount
                transitionTotalProcessesBefore =
                    $transitionTotalProcessesBefore
                transitionTotalProcessesAfter =
                    $transitionTotalProcessesAfter
                transitionAccountingActiveProcessesBefore =
                    $transitionAccountingActiveProcessesBefore
                transitionAccountingActiveProcessesAfter =
                    $transitionAccountingActiveProcessesAfter
                transitionBoundActiveProcesses =
                    $transitionBoundActiveProcesses
                transitionKnownProcessIdentityCount =
                    $transitionKnownProcessIdentityCount
                transitionBoundActiveProcessEntries =
                    $transitionBoundActiveProcessEntries
                privateWorkingSetBytes = if ($sampleStatus -eq 'COMPLETE') {
                    [int64]$samplePrivateBytes
                } else { $null }
                processQueries = @($queries)
            })

            $nextSampleDue += $SampleIntervalMilliseconds
            $remaining = $nextSampleDue - $wall.Elapsed.TotalMilliseconds
            if ($remaining -gt 0) {
                Start-Sleep -Milliseconds ([int][Math]::Min(
                    $remaining,
                    $SampleIntervalMilliseconds
                ))
            }
        }

        $trialDeadlineExceeded =
            -not $loopCompletedNormally -and
            $wall.Elapsed.TotalSeconds -ge $TrialTimeoutSeconds
        if ($trialDeadlineExceeded) {
            if ($null -eq $failureCode) {
                $failureCode = 'BERGAMOT_COLD_PWS_TRIAL_TIMEOUT'
            }
            $forcedKillCount += [Math]::Max(
                1,
                [Phase7BergamotNative]::TerminateJob(
                    $launch,
                    (Get-NativeExitCode -Hex 'E0000003')
                )
            )
            $waitAfterTerminate = [Phase7BergamotNative]::WaitForRoot(
                $launch,
                $script:PostTerminateWaitMilliseconds
            )
            if ($waitAfterTerminate -ne 'EXITED' -and $null -eq $failureCode) {
                $failureCode = 'BERGAMOT_COLD_PWS_ROOT_DID_NOT_EXIT_AFTER_JOB_TERMINATION'
            }
        } elseif ([Phase7BergamotNative]::WaitForRoot(
            $launch,
            0
        ) -ne 'EXITED') {
            if ($forcedKillCount -eq 0) {
                if ($null -eq $failureCode) {
                    $failureCode =
                        'BERGAMOT_COLD_PWS_UNEXPECTED_ACTIVE_JOB_AFTER_LOOP'
                }
                $forcedKillCount += [Math]::Max(
                    1,
                    [Phase7BergamotNative]::TerminateJob(
                        $launch,
                        (Get-NativeExitCode -Hex 'E0000003')
                    )
                )
            }
            if ([Phase7BergamotNative]::WaitForRoot(
                $launch,
                $script:PostTerminateWaitMilliseconds
            ) -ne 'EXITED' -and $null -eq $failureCode) {
                $failureCode =
                    'BERGAMOT_COLD_PWS_ROOT_DID_NOT_EXIT_AFTER_JOB_TERMINATION'
            }
        }
        if ([Phase7BergamotNative]::WaitForRoot($launch, 0) -eq 'EXITED') {
            $rootExitCode = [Phase7BergamotNative]::GetRootExitCode($launch)
            $normalExit = $rootExitCode -eq 0 -and $forcedKillCount -eq 0
            if ($rootExitCode -ne 0 -and $null -eq $failureCode) {
                $failureCode = 'BERGAMOT_COLD_PWS_CHILD_NONZERO_EXIT'
            }
        }

        $residual = Get-JobZeroEvidence `
            -Launch $launch `
            -TimeoutSeconds $ResidualTimeoutSeconds
        if (-not $residual.Verified -or $residual.QueryFailures -ne 0) {
            if ($null -eq $failureCode) {
                $failureCode = 'BERGAMOT_COLD_PWS_JOB_RESIDUAL_OR_QUERY_FAILURE'
            }
            $observedBeforeKill = 0
            try {
                $observedBeforeKill = @(
                    [Phase7BergamotNative]::QueryJobProcessesForCleanup(
                        $launch
                    )
                ).Count
            } catch {
                $observedBeforeKill = 1
            }
            if ($observedBeforeKill -gt 0) {
                $killed = [Phase7BergamotNative]::TerminateJob(
                    $launch,
                    (Get-NativeExitCode -Hex 'E0000004')
                )
                $forcedKillCount += [Math]::Max(1, $killed)
                $null = Get-JobZeroEvidence `
                    -Launch $launch `
                    -TimeoutSeconds $ResidualTimeoutSeconds
            }
        }

        try {
            $finalMembers = @(
                [Phase7BergamotNative]::QueryJobProcesses($launch)
            )
            $finalKnownProcessIdentityCount =
                [int]$launch.KnownProcessIdentities.Count
            $finalJobTotalProcesses =
                [int]$launch.LastTotalProcesses
            $finalJobActiveProcesses =
                [int]$launch.LastActiveProcesses
            $finalJobReportedAccountingActiveProcesses =
                [int]$launch.LastReportedAccountingActiveProcesses
            if ($finalMembers.Count -ne 0 -or
                $finalJobActiveProcesses -ne 0 -or
                $finalJobReportedAccountingActiveProcesses -ne 0 -or
                $finalKnownProcessIdentityCount -ne
                    $finalJobTotalProcesses) {
                throw 'BERGAMOT_COLD_PWS_FINAL_PROCESS_HISTORY_INCOMPLETE'
            }
            $finalProcessHistoryStatus =
                'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO'
        } catch {
            if ($null -eq $failureCode) {
                $failureCode = Get-SanitizedBlockerCode `
                    -ErrorValue $_ `
                    -Fallback 'BERGAMOT_COLD_PWS_FINAL_PROCESS_HISTORY_INVALID'
            }
        }

        [Phase7BergamotNative]::CloseJobLaunch($launch, $true)
        $jobClosed = $true
        $jobCleanupStatus = 'EMPTY_AND_HANDLES_CLOSED'
        $wall.Stop()

        $captureStdoutBytes = [int64](Assert-RegularFile -Path $stdoutPath).Length
        $captureStderrBytes = [int64](Assert-RegularFile -Path $stderrPath).Length
        $stdout = Read-BoundedUtf8File `
            -Path $stdoutPath `
            -MaximumBytes $script:MaximumCaptureBytes `
            -TimeoutMilliseconds $script:CaptureReadTimeoutMilliseconds
        $null = Read-BoundedUtf8File `
            -Path $stderrPath `
            -MaximumBytes $script:MaximumCaptureBytes `
            -TimeoutMilliseconds $script:CaptureReadTimeoutMilliseconds
        $childJson = Read-BoundedUtf8File `
            -Path $childReportPath `
            -MaximumBytes $script:MaximumCaptureBytes `
            -TimeoutMilliseconds $script:CaptureReadTimeoutMilliseconds
        try {
            $stdoutReport = $stdout | ConvertFrom-Json
            $childReport = $childJson | ConvertFrom-Json
            $stdoutCanonical = $stdoutReport | ConvertTo-Json -Depth 30 -Compress
            $childCanonical = $childReport | ConvertTo-Json -Depth 30 -Compress
            if ((Get-Sha256Text -Value $stdoutCanonical) -ne
                (Get-Sha256Text -Value $childCanonical)) {
                throw 'BERGAMOT_COLD_PWS_STDOUT_AND_ARTIFACT_REPORT_MISMATCH'
            }
            Assert-ChildReport `
                -Report $childReport `
                -Direction $Direction `
                -ElectronIdentity $ElectronIdentity
            if ($null -eq $completionMarker) {
                if (-not (Test-Path -LiteralPath $completionMarkerPath)) {
                    throw 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_MISSING'
                }
                $completionMarker = Read-WarmCompletionMarker `
                    -Path $completionMarkerPath `
                    -Direction $Direction
                $completionMarkerObserved = $true
            }
            Assert-WarmCompletionMarkerBinding `
                -Marker $completionMarker `
                -Report $childReport `
                -Direction $Direction
            $completionMarkerValidated = $true
            Assert-IdentityConsistency `
                -ChildReport $childReport `
                -Direction $Direction `
                -IdentityState $IdentityState
            $childReportValidated = $true
            if ([int]$childReport.routes[0].warm.failures -gt 0 -and
                $null -eq $failureCode) {
                $failureCode = 'BERGAMOT_COLD_PWS_WARM_TRANSLATION_FAILURES_PRESENT'
            }
        } catch {
            if ($null -eq $failureCode) {
                $failureCode = Get-SanitizedBlockerCode `
                    -ErrorValue $_ `
                    -Fallback 'BERGAMOT_COLD_PWS_CHILD_REPORT_INVALID'
            }
        }
    } catch {
        $wall.Stop()
        if ($null -eq $failureCode) {
            $failureCode = Get-SanitizedBlockerCode `
                -ErrorValue $_ `
                -Fallback 'BERGAMOT_COLD_PWS_TRIAL_UNEXPECTED_FAILURE'
        }
    } finally {
        if ($null -ne $launch -and -not $jobClosed) {
            try {
                $active = @(
                    [Phase7BergamotNative]::QueryJobProcessesForCleanup(
                        $launch
                    )
                ).Count
                if ($active -gt 0) {
                    $killed = [Phase7BergamotNative]::TerminateJob(
                        $launch,
                        (Get-NativeExitCode -Hex 'E0000005')
                    )
                    $forcedKillCount += [Math]::Max(1, $killed)
                    $null = Get-JobZeroEvidence `
                        -Launch $launch `
                        -TimeoutSeconds $ResidualTimeoutSeconds
                }
            } catch {
                $forcedKillCount += 1
            }
            try {
                [Phase7BergamotNative]::CloseJobLaunch($launch, $true)
                $jobCleanupStatus = 'EMPTY_AND_HANDLES_CLOSED'
            } catch {
                try {
                    [Phase7BergamotNative]::CloseJobLaunch($launch, $false)
                } catch {}
                $jobCleanupStatus = 'FORCED_CLOSE'
            }
            $jobClosed = $true
        }
        if ($wall.IsRunning) { $wall.Stop() }
    }

    if ($null -ne $terminalJobZeroElapsedMilliseconds -and
        $null -ne $markerObservedElapsedMilliseconds) {
        $terminalBoundaryCandidate = [ordered]@{
            status = 'VERIFIED_TERMINAL_JOB_ZERO'
            elapsedMs = [Math]::Round(
                [double]$terminalJobZeroElapsedMilliseconds,
                3
            )
            markerObservedElapsedMs = [Math]::Round(
                [double]$markerObservedElapsedMilliseconds,
                3
            )
            completionMarkerValidated = $completionMarkerValidated
            childReportValidated = $childReportValidated
            normalExit = $normalExit
            rootExitCodeZero = $rootExitCode -eq 0
            forcedKillCount = $forcedKillCount
            jobMemberCount = 0
            jobActiveProcesses = $terminalJobZeroActiveProcesses
            jobReportedAccountingActiveProcesses =
                $terminalJobZeroReportedAccountingActiveProcesses
            knownProcessIdentityCount =
                $terminalJobZeroKnownProcessIdentityCount
            jobTotalProcesses = $terminalJobZeroTotalProcesses
            residualVerified = $residual.Verified
            residualConsecutiveZeroPolls =
                [int]$residual.ConsecutiveZeroPolls
            residualQueryFailures = [int]$residual.QueryFailures
            finalProcessHistoryStatus = $finalProcessHistoryStatus
            jobCleanupStatus = $jobCleanupStatus
        }
        if (Test-VerifiedTerminalBoundary `
            -Boundary $terminalBoundaryCandidate) {
            $terminalBoundary = $terminalBoundaryCandidate
        }
    }

    $sampleIntervals = for ($index = 1; $index -lt $sampleStarts.Count; $index += 1) {
        $sampleStarts[$index] - $sampleStarts[$index - 1]
    }
    $cadence = Get-Distribution -Values @($sampleIntervals)
    $sampleSpans = @($logicalSamples | ForEach-Object spanMs)
    $spanDistribution = Get-Distribution -Values $sampleSpans
    $querySkews = @($logicalSamples | ForEach-Object maximumProcessQuerySkewMs)
    $skewDistribution = Get-Distribution -Values $querySkews
    $transitionGapSummary = Get-MembershipTransitionGapSummary `
        -LogicalSamples @($logicalSamples) `
        -TerminalBoundary $terminalBoundary
    $coverageMilliseconds = if ($validSampleStarts.Count -lt 1) {
        0.0
    } else {
        [double]$validSampleEnds[$validSampleEnds.Count - 1] -
            [double]$validSampleStarts[0]
    }
    $maximumCadenceMilliseconds = [int][Math]::Max(
        250,
        [Math]::Ceiling($SampleIntervalMilliseconds * 2.5)
    )
    $terminalEndpointCadenceAccepted =
        Test-TerminalSamplingEndpointCadence `
            -LogicalSamples @($logicalSamples) `
            -TerminalBoundary $terminalBoundary `
            -MaximumCadenceMilliseconds $maximumCadenceMilliseconds
    $terminalEndpointCadenceMilliseconds = if (
        $logicalSamples.Count -gt 0 -and
        $null -ne $terminalBoundary -and
        [string]$logicalSamples[$logicalSamples.Count - 1].status -eq
            'COMPLETE'
    ) {
        [Math]::Round(
            [double]$terminalBoundary.elapsedMs -
                [double]$logicalSamples[
                    $logicalSamples.Count - 1
                ].startElapsedMs,
            3
        )
    } else { $null }
    $privateWorkingSetBudgetStatus = Get-PrivateWorkingSetBudgetStatus `
        -PeakBytes $privateWorkingSetPeakBytes `
        -TransitionSampleCount $transitionGapSummary.sampleCount
    $privateWorkingSetBudgetAccepted =
        $privateWorkingSetBudgetStatus -eq
            'PASS_CONTINUOUS_SAMPLING' -or
        $privateWorkingSetBudgetStatus -eq
            'PASS_WITH_TRANSITION_RESERVE'
    $transitionGapsAccepted =
        Test-MembershipTransitionPolicy -Summary $transitionGapSummary
    $samplingMetricsComplete =
        $null -ne $launchToFirstSampleMilliseconds -and
        [double]$launchToFirstSampleMilliseconds -le
            $script:MaximumLaunchToFirstSampleMilliseconds -and
        $cadence.n -ge 1 -and
        [double]$cadence.max -le $maximumCadenceMilliseconds -and
        $spanDistribution.n -ge 1 -and
        [double]$spanDistribution.max -le $script:MaximumSampleSpanMilliseconds -and
        $skewDistribution.n -ge 1 -and
        [double]$skewDistribution.max -le
            $script:MaximumProcessQuerySkewMilliseconds -and
        $validSampleStarts.Count -ge $script:MinimumValidSamples -and
        $coverageMilliseconds -ge $script:MinimumCoverageMilliseconds -and
        $discardedSampleCount -eq 0 -and
        $measurementFailureCount -eq 0 -and
        $transitionGapsAccepted -and
        $terminalEndpointCadenceAccepted -and
        $privateWorkingSetBudgetAccepted
    $samplingComplete = Test-SamplingTerminalBoundaryGate `
        -SamplingMetricsAccepted $samplingMetricsComplete `
        -TerminalBoundary $terminalBoundary
    if ($privateWorkingSetBudgetStatus -eq
            'INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET' -and
        $null -eq $failureCode) {
        $failureCode =
            'BERGAMOT_COLD_PWS_TRANSITION_RESERVE_INCONCLUSIVE'
    }
    if ($privateWorkingSetBudgetStatus -eq 'FAIL_BUDGET_EXCEEDED' -and
        $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_BUDGET_EXCEEDED'
    }
    if (-not $samplingComplete -and $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_SAMPLING_EVIDENCE_INCOMPLETE'
    }
    if (-not $completionMarkerValidated -and $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_COMPLETION_MARKER_NOT_VALIDATED'
    }
    if (-not $normalExit -and $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_NORMAL_EXIT_NOT_VERIFIED'
    }
    if (-not $residual.Verified -and $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_JOB_ZERO_NOT_VERIFIED'
    }
    if ($finalProcessHistoryStatus -ne
            'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO' -and
        $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_FINAL_PROCESS_HISTORY_INVALID'
    }
    if ($jobCleanupStatus -ne 'EMPTY_AND_HANDLES_CLOSED' -and
        $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_JOB_CLEANUP_INCOMPLETE'
    }
    if ($forcedKillCount -gt 0 -and $null -eq $failureCode) {
        $failureCode = 'BERGAMOT_COLD_PWS_FORCED_JOB_TERMINATION_USED'
    }

    $warmObservations = @()
    if ($childReportValidated) {
        $warmObservations = @($childReport.routes[0].warm.observations |
            ForEach-Object {
                [ordered]@{
                    translationOnlyMs = [double]$_.translationOnlyMs
                    targetChars = [int]$_.targetChars
                    targetSha256 = [string]$_.targetSha256
                }
            })
    }
    $successful = $null -eq $failureCode
    return [ordered]@{
        direction = $Direction
        trial = $TrialNumber
        status = if (-not $successful) {
            'FAILED'
        } elseif ($transitionGapSummary.sampleCount -gt 0) {
            'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
        } else {
            'COMPLETE'
        }
        blockerCode = $failureCode
        launchMode = 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME'
        jobPolicy = 'KILL_ON_JOB_CLOSE_NO_BREAKAWAY_FLAGS'
        freshProcessWallClockMs = [Math]::Round($wall.Elapsed.TotalMilliseconds, 3)
        childReportValidated = $childReportValidated
        completionMarkerObserved = $completionMarkerObserved
        completionMarkerValidated = $completionMarkerValidated
        completionMarkerBindingSha256 = if ($completionMarkerValidated) {
            [string]$completionMarker.BindingSha256
        } else { $null }
        workloadIdentity = if ($childReportValidated) {
            [ordered]@{
                sourceChars = [int]$childReport.routes[0].sourceChars
                sourceSha256 = [string]$childReport.routes[0].sourceSha256
                sampleIdentitySha256 =
                    [string]$childReport.routes[0].sampleIdentitySha256
                workloadConfigSha256 =
                    [string]$childReport.workloadConfigSha256
            }
        } else { $null }
        rendererFirstTranslationMs = if ($childReportValidated) {
            [double]$childReport.routes[0].firstTranslationMs
        } else { $null }
        rendererColdRouteTotalMs = if ($childReportValidated) {
            [double]$childReport.routes[0].coldRouteTotalMs
        } else { $null }
        rendererColdTargetSha256 = if ($childReportValidated) {
            [string]$childReport.routes[0].targetSha256
        } else { $null }
        harnessStartToWarmSequenceCompleteMs = if ($childReportValidated) {
            [double]$childReport.harnessStartToWarmSequenceCompleteMs
        } else { $null }
        warm = [ordered]@{
            iterationsRequested = 5
            failures = if ($childReportValidated) {
                [int]$childReport.routes[0].warm.failures
            } else { 5 }
            observations = @($warmObservations)
        }
        privateWorkingSetPeakBytes = if ($privateWorkingSetPeakBytes -gt 0) {
            [int64]$privateWorkingSetPeakBytes
        } else { $null }
        logicalSamples = @($logicalSamples)
        terminalBoundary = $terminalBoundary
        validSampleCount = $validSampleStarts.Count
        discardedSampleCount = $discardedSampleCount
        measurementFailureCount = $measurementFailureCount
        verifiedMembershipTransitionSampleCount =
            $transitionGapSummary.sampleCount
        verifiedMembershipTransitionGapCount =
            $transitionGapSummary.gapCount
        verifiedMembershipTransitionGapTotalMs =
            $transitionGapSummary.totalDurationMs
        maximumAdjacentValidSampleGapMs =
            $transitionGapSummary.maximumAdjacentValidSampleGapMs
        membershipTransitionGaps = @($transitionGapSummary.gaps)
        samplingContinuityClaim =
            if ($transitionGapSummary.sampleCount -gt 0) {
                'BOUNDED_TRANSITION_GAPS_NOT_CONTINUOUS'
            } else {
                'CONTINUOUS_COMPLETE_SAMPLES'
            }
        privateWorkingSetBudgetStatus =
            $privateWorkingSetBudgetStatus
        maximumTreeProcessCount = $maximumTreeProcessCount
        launchToFirstSampleMs = if ($null -eq $launchToFirstSampleMilliseconds) {
            $null
        } else { [Math]::Round([double]$launchToFirstSampleMilliseconds, 3) }
        samplingIntervalMilliseconds = $cadence
        terminalEndpointCadenceMs =
            $terminalEndpointCadenceMilliseconds
        terminalEndpointCadenceStatus = if (
            $terminalEndpointCadenceAccepted
        ) {
            'ACCEPTED'
        } else {
            'INCOMPLETE'
        }
        logicalSampleSpanMilliseconds = $spanDistribution
        processQuerySkewMilliseconds = $skewDistribution
        validCoverageMs = [Math]::Round($coverageMilliseconds, 3)
        samplingStatus = if (-not $samplingComplete) {
            'INCOMPLETE'
        } elseif ($transitionGapSummary.sampleCount -gt 0) {
            'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
        } else {
            'COMPLETE'
        }
        normalExit = $normalExit
        rootExitCodeZero = $rootExitCode -eq 0
        residualProcessVerification = if ($residual.Verified) {
            'JOB_THREE_CONSECUTIVE_ZERO_POLLS'
        } else { 'NOT_VERIFIED' }
        residualZeroPolls = [int]$residual.ConsecutiveZeroPolls
        maximumResidualProcessCount = [int]$residual.MaximumObserved
        residualQueryFailures = [int]$residual.QueryFailures
        finalProcessHistoryStatus = $finalProcessHistoryStatus
        finalKnownProcessIdentityCount =
            $finalKnownProcessIdentityCount
        finalJobTotalProcesses = $finalJobTotalProcesses
        finalJobActiveProcesses = $finalJobActiveProcesses
        finalJobReportedAccountingActiveProcesses =
            $finalJobReportedAccountingActiveProcesses
        jobCleanupStatus = $jobCleanupStatus
        jobProcessQueryRetryCount = $jobProcessQueryRetryCount
        jobProcessQueryFailedAfterRetryCount =
            $jobProcessQueryFailedAfterRetryCount
        pendingTerminalZeroPollCount =
            $pendingTerminalZeroPollCount
        postExitJobQueryFailureCount =
            $postExitJobQueryFailureCount
        forcedKillCount = $forcedKillCount
        outputCapture = [ordered]@{
            mode = 'BOUNDED_CREATE_NEW_FILES_NO_PIPES'
            stdoutBytes = $captureStdoutBytes
            stderrBytes = $captureStderrBytes
            maximumBytesPerStream = $script:MaximumCaptureBytes
            readTimeoutMilliseconds = $script:CaptureReadTimeoutMilliseconds
        }
    }
}

function Assert-ReportPrivacy {
    param(
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    $json = $Report | ConvertTo-Json -Depth 50 -Compress
    $forbiddenKeyPattern = '"(?:pid|processId|path|absolutePath|sourceText|targetText|translatedText|translation|stdout|stderr|commandLine|userName)"\s*:'
    if ($json -match $forbiddenKeyPattern) {
        throw 'BERGAMOT_COLD_PWS_PRIVACY_FORBIDDEN_KEY'
    }
    foreach ($value in @(
        $RepositoryRoot,
        [string]$env:USERPROFILE,
        [string]$env:USERNAME
    )) {
        if (-not [string]::IsNullOrWhiteSpace($value) -and
            $json.IndexOf($value, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'BERGAMOT_COLD_PWS_PRIVACY_LOCAL_IDENTITY_LEAKED'
        }
    }
}

function Invoke-SelfTest {
    param(
        [Parameter(Mandatory = $true)][string]$ArtifactRoot,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot
    )
    $distribution = Get-Distribution -Values @(1.0, 2.0, 3.0, 4.0)
    if ($distribution.n -ne 4 -or $distribution.p50 -ne 2.0 -or
        $distribution.p95 -ne 4.0 -or $distribution.max -ne 4.0) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_DISTRIBUTION_FAILED'
    }
    if ([Phase7BergamotNative]::ClassifyJobProcessListSnapshot(
            6,
            0,
            511
        ) -ne 'INCOMPLETE' -or
        [Phase7BergamotNative]::ClassifyJobProcessListSnapshot(
            6,
            5,
            511
        ) -ne 'INCOMPLETE' -or
        [Phase7BergamotNative]::ClassifyJobProcessListSnapshot(
            6,
            6,
            511
        ) -ne 'COMPLETE' -or
        [Phase7BergamotNative]::ClassifyJobProcessListSnapshot(
            6,
            7,
            511
        ) -ne 'INVALID') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_PARTIAL_JOB_LIST_ACCEPTED'
    }
    if ([Phase7BergamotNative]::ClassifyBoundProcessExitTransition(
            5,
            5,
            5,
            4,
            5,
            5
        ) -ne 'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG' -or
        [Phase7BergamotNative]::ClassifyBoundProcessExitTransition(
            4,
            5,
            5,
            4,
            5,
            5
        ) -ne 'NOT_VERIFIED' -or
        [Phase7BergamotNative]::ClassifyBoundProcessExitTransition(
            5,
            5,
            5,
            4,
            6,
            4
        ) -ne 'NOT_VERIFIED' -or
        [Phase7BergamotNative]::ClassifyBoundProcessExitTransition(
            5,
            5,
            4,
            4,
            5,
            4
        ) -ne 'NOT_VERIFIED') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TRANSITION_CLASSIFIER_FAILED'
    }
    if ([Phase7BergamotNative]::ClassifyExitAccountingLagRecovery(
            5,
            5,
            5,
            [string[]]@('one', 'two', 'three', 'four'),
            5,
            5,
            [string[]]@('four', 'three', 'two', 'one')
        ) -ne 'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES' -or
        [Phase7BergamotNative]::ClassifyExitAccountingLagRecovery(
            4,
            5,
            5,
            [string[]]@('one', 'two', 'three', 'four'),
            5,
            5,
            [string[]]@('one', 'two', 'three', 'four')
        ) -ne 'NOT_VERIFIED' -or
        [Phase7BergamotNative]::ClassifyExitAccountingLagRecovery(
            5,
            5,
            5,
            [string[]]@('one', 'two', 'three', 'four'),
            5,
            5,
            [string[]]@('one', 'two', 'three', 'five')
        ) -ne 'NOT_VERIFIED' -or
        [Phase7BergamotNative]::ClassifyExitAccountingLagRecovery(
            4,
            4,
            4,
            [string[]]@('one', 'two', 'three', 'four'),
            4,
            4,
            [string[]]@('one', 'two', 'three', 'four')
        ) -ne 'NOT_VERIFIED') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_EXIT_ACCOUNTING_LAG_RECOVERY_CLASSIFIER_FAILED'
    }
    if (-not (Test-ExactEmptyJobSnapshot `
            -QueryStatus 'COMPLETE' `
            -MemberCount 0 `
            -ActiveProcesses 0 `
            -ReportedAccountingActiveProcesses 0 `
            -KnownProcessIdentityCount 5 `
            -TotalProcesses 5)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_EXACT_EMPTY_SNAPSHOT_REJECTED'
    }
    $invalidEmptySnapshots = @(
        @{
            QueryStatus = 'FAILED'
            MemberCount = 0
            ActiveProcesses = 0
            ReportedAccountingActiveProcesses = 0
            KnownProcessIdentityCount = 5
            TotalProcesses = 5
        },
        @{
            QueryStatus = 'COMPLETE'
            MemberCount = 1
            ActiveProcesses = 0
            ReportedAccountingActiveProcesses = 0
            KnownProcessIdentityCount = 5
            TotalProcesses = 5
        },
        @{
            QueryStatus = 'COMPLETE'
            MemberCount = 0
            ActiveProcesses = 1
            ReportedAccountingActiveProcesses = 0
            KnownProcessIdentityCount = 5
            TotalProcesses = 5
        },
        @{
            QueryStatus = 'COMPLETE'
            MemberCount = 0
            ActiveProcesses = 0
            ReportedAccountingActiveProcesses = 1
            KnownProcessIdentityCount = 5
            TotalProcesses = 5
        },
        @{
            QueryStatus = 'COMPLETE'
            MemberCount = 0
            ActiveProcesses = 0
            ReportedAccountingActiveProcesses = 0
            KnownProcessIdentityCount = 4
            TotalProcesses = 5
        },
        @{
            QueryStatus = 'COMPLETE'
            MemberCount = 0
            ActiveProcesses = $null
            ReportedAccountingActiveProcesses = 0
            KnownProcessIdentityCount = 5
            TotalProcesses = 5
        }
    )
    foreach ($invalidEmptySnapshot in $invalidEmptySnapshots) {
        if (Test-ExactEmptyJobSnapshot @invalidEmptySnapshot) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_INVALID_EXACT_EMPTY_SNAPSHOT_ACCEPTED'
        }
    }
    if ((Get-ExactEmptySnapshotDisposition `
            -RootState 'EXITED' `
            -CompletionMarkerObserved $true) -ne
            'RECORD_TERMINAL_ZERO' -or
        (Get-ExactEmptySnapshotDisposition `
            -RootState 'TIMEOUT' `
            -CompletionMarkerObserved $true) -ne
            'PENDING_TERMINAL_ZERO' -or
        (Get-ExactEmptySnapshotDisposition `
            -RootState 'EXITED' `
            -CompletionMarkerObserved $false) -ne
            'PENDING_TERMINAL_ZERO') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_EXACT_EMPTY_DISPOSITION_FAILED'
    }
    $queryWrapperLaunch = [pscustomobject]@{
        LastProcessDiscoveryStatus = 'COMPLETE_PROCESS_ID_LIST'
        LastTotalProcesses = 5
        LastActiveProcesses = 0
        LastReportedAccountingActiveProcesses = 0
        KnownProcessIdentities = @{
            one = $true
            two = $true
            three = $true
            four = $true
            five = $true
        }
    }
    $immediateQueryCalls = [Collections.Generic.List[int]]::new()
    $immediateQuery = Invoke-JobProcessQueryWithSingleRetry `
        -Launch $queryWrapperLaunch `
        -QueryOperation {
            param($BoundLaunch)
            $immediateQueryCalls.Add(1) | Out-Null
        }
    if ($immediateQueryCalls.Count -ne 1 -or
        $immediateQuery.Status -ne 'COMPLETE' -or
        $immediateQuery.Attempts -ne 1 -or
        $immediateQuery.RetryCount -ne 0 -or
        $null -ne $immediateQuery.RetryReasonCode -or
        $null -ne $immediateQuery.FailureCode -or
        $immediateQuery.KnownProcessIdentityCount -ne 5) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_IMMEDIATE_JOB_QUERY_FAILED'
    }
    $singleRetryQueryCalls = [Collections.Generic.List[int]]::new()
    $singleRetryQuery = Invoke-JobProcessQueryWithSingleRetry `
        -Launch $queryWrapperLaunch `
        -QueryOperation {
            param($BoundLaunch)
            $singleRetryQueryCalls.Add(1) | Out-Null
            if ($singleRetryQueryCalls.Count -eq 1) {
                throw 'BERGAMOT_SELFTEST_JOB_QUERY_RETRY_ONCE'
            }
        }
    if ($singleRetryQueryCalls.Count -ne 2 -or
        $singleRetryQuery.Status -ne 'COMPLETE' -or
        $singleRetryQuery.Attempts -ne 2 -or
        $singleRetryQuery.RetryCount -ne 1 -or
        $singleRetryQuery.RetryReasonCode -ne
            'BERGAMOT_SELFTEST_JOB_QUERY_RETRY_ONCE' -or
        $null -ne $singleRetryQuery.FailureCode) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_SINGLE_JOB_QUERY_RETRY_FAILED'
    }
    $persistentQueryCalls = [Collections.Generic.List[int]]::new()
    $persistentQuery = Invoke-JobProcessQueryWithSingleRetry `
        -Launch $queryWrapperLaunch `
        -QueryOperation {
            param($BoundLaunch)
            $persistentQueryCalls.Add(1) | Out-Null
            throw 'BERGAMOT_SELFTEST_JOB_QUERY_PERSISTENT_FAILURE'
        }
    if ($persistentQueryCalls.Count -ne 2 -or
        $persistentQuery.Status -ne 'FAILED' -or
        $persistentQuery.Attempts -ne 2 -or
        $persistentQuery.RetryCount -ne 1 -or
        $persistentQuery.RetryReasonCode -ne
            'BERGAMOT_SELFTEST_JOB_QUERY_PERSISTENT_FAILURE' -or
        $persistentQuery.FailureCode -ne
            'BERGAMOT_SELFTEST_JOB_QUERY_PERSISTENT_FAILURE') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_PERSISTENT_JOB_QUERY_FAILURE_ACCEPTED'
    }
    $transitionQueries = @(
        [ordered]@{
            processOrdinal = 1
            status = 'COMPLETE'
        },
        [ordered]@{
            processOrdinal = 2
            status = 'PRE_IDENTITY_OR_ACTIVE_MISMATCH'
        }
    )
    if (-not (Test-ExactTransitionQueryFailuresBound `
            -ProcessQueries $transitionQueries `
            -PreProcessOrdinals @(1, 2) `
            -PostProcessOrdinals @(1)) -or
        (Test-ExactTransitionQueryFailuresBound `
            -ProcessQueries @([ordered]@{
                processOrdinal = 2
                status = 'QUERY_FAILED'
            }) `
            -PreProcessOrdinals @(1, 2) `
            -PostProcessOrdinals @(1)) -or
        (Test-ExactTransitionQueryFailuresBound `
            -ProcessQueries @([ordered]@{
                processOrdinal = 1
                status = 'PRE_IDENTITY_OR_ACTIVE_MISMATCH'
            }) `
            -PreProcessOrdinals @(1, 2) `
            -PostProcessOrdinals @(1))) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TRANSITION_QUERY_BINDING_FAILED'
    }
    $gapFixture = @(
        [ordered]@{
            sample = 1
            status = 'COMPLETE'
            startElapsedMs = 0.0
            endElapsedMs = 1.0
        },
        [ordered]@{
            sample = 2
            status = 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
            startElapsedMs = 100.0
            endElapsedMs = 101.0
            transitionReason = 'EXACT_ACTIVE_SET_CHANGED'
        },
        [ordered]@{
            sample = 3
            status = 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
            startElapsedMs = 200.0
            endElapsedMs = 201.0
            transitionReason = 'BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
        },
        [ordered]@{
            sample = 4
            status = 'COMPLETE'
            startElapsedMs = 300.0
            endElapsedMs = 301.0
        }
    )
    $gapSummary = Get-MembershipTransitionGapSummary `
        -LogicalSamples $gapFixture
    if ($gapSummary.sampleCount -ne 2 -or
        $gapSummary.gapCount -ne 1 -or
        $gapSummary.totalDurationMs -ne 299.0 -or
        $gapSummary.maximumAdjacentValidSampleGapMs -ne 300.0 -or
        -not $gapSummary.boundedByCompleteSamples -or
        $gapSummary.gaps[0].reasonCodes.Count -ne 2) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TRANSITION_GAP_SUMMARY_FAILED'
    }
    if (-not (Test-MembershipTransitionGapCadence -Gaps @(
            [ordered]@{
                adjacentValidStartGapMs = 1200.0
                reasonCodes = @('BOUND_PROCESS_EXIT_ACCOUNTING_LAG')
            }
        )) -or
        (Test-MembershipTransitionGapCadence -Gaps @(
            [ordered]@{
                adjacentValidStartGapMs = 600.0
                reasonCodes = @('EXACT_ACTIVE_SET_CHANGED')
            }
        )) -or
        (Test-MembershipTransitionGapCadence -Gaps @(
            [ordered]@{
                adjacentValidStartGapMs = 1300.0
                reasonCodes = @('BOUND_PROCESS_EXIT_ACCOUNTING_LAG')
            }
        ))) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TRANSITION_GAP_CADENCE_FAILED'
    }
    $unboundedGap = Get-MembershipTransitionGapSummary `
        -LogicalSamples @($gapFixture[1], $gapFixture[3])
    if ($unboundedGap.boundedByCompleteSamples) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_UNBOUNDED_TRANSITION_ACCEPTED'
    }
    $terminalGapFixture = @(
        [ordered]@{
            sample = 1
            status = 'COMPLETE'
            startElapsedMs = 0.0
            endElapsedMs = 10.0
        },
        [ordered]@{
            sample = 2
            status = 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
            startElapsedMs = 100.0
            endElapsedMs = 120.0
            transitionReason = 'EXACT_ACTIVE_SET_CHANGED'
            transitionVerificationStatus =
                'VERIFIED_PRE_POST_COMPLETE_HISTORY_IDENTITY_SET_CHANGE'
            transitionInternalMeasurementFailureCount = 1
            jobTotalProcesses = 2
            jobActiveProcesses = 2
            preKnownProcessIdentityCount = 2
            postJobTotalProcesses = 2
            postJobActiveProcesses = 1
            postKnownProcessIdentityCount = 2
            memberCount = 2
            postMemberCount = 1
            preProcessOrdinals = @(1, 2)
            postProcessOrdinals = @(1)
            processQueries = @(
                [ordered]@{
                    processOrdinal = 1
                    status = 'COMPLETE'
                },
                [ordered]@{
                    processOrdinal = 2
                    status = 'POST_IDENTITY_OR_ACTIVE_MISMATCH'
                }
            )
        }
    )
    $terminalBoundaryFixture = [ordered]@{
        status = 'VERIFIED_TERMINAL_JOB_ZERO'
        elapsedMs = 200.0
        markerObservedElapsedMs = 150.0
        completionMarkerValidated = $true
        childReportValidated = $true
        normalExit = $true
        rootExitCodeZero = $true
        forcedKillCount = 0
        jobMemberCount = 0
        jobActiveProcesses = 0
        jobReportedAccountingActiveProcesses = 0
        knownProcessIdentityCount = 2
        jobTotalProcesses = 2
        residualVerified = $true
        residualConsecutiveZeroPolls = 3
        residualQueryFailures = 0
        finalProcessHistoryStatus =
            'KNOWN_EQUALS_TOTAL_AND_ACTIVE_ZERO'
        jobCleanupStatus = 'EMPTY_AND_HANDLES_CLOSED'
    }
    $terminalBoundSample = [ordered]@{
        sample = 2
        status = 'VERIFIED_MEMBERSHIP_TRANSITION_GAP'
        startElapsedMs = 100.0
        endElapsedMs = 120.0
        transitionReason = 'BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
        transitionVerificationStatus =
            'VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG'
        transitionInternalMeasurementFailureCount = 0
        preJobQueryStatus = 'COMPLETE'
        postJobQueryStatus = 'NOT_RUN'
        memberDiscoveryStatus =
            'EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES'
        membershipRevalidationStatus = 'NOT_RUN'
        memberCount = 0
        postMemberCount = $null
        jobTotalProcesses = 2
        jobActiveProcesses = 0
        jobReportedAccountingActiveProcesses = 1
        preKnownProcessIdentityCount = 2
        postJobTotalProcesses = $null
        postJobActiveProcesses = $null
        postJobReportedAccountingActiveProcesses = $null
        postKnownProcessIdentityCount = $null
        preProcessOrdinals = @()
        postProcessOrdinals = @()
        processQueries = @()
        transitionTotalProcessesBefore = 2
        transitionTotalProcessesAfter = 2
        transitionAccountingActiveProcessesBefore = 1
        transitionAccountingActiveProcessesAfter = 1
        transitionBoundActiveProcesses = 0
        transitionKnownProcessIdentityCount = 2
        transitionBoundActiveProcessEntries = @()
    }
    $boundOnlyFixture = @(
        $terminalGapFixture[0],
        $terminalBoundSample
    )
    $boundOnlySummary = Get-MembershipTransitionGapSummary `
        -LogicalSamples $boundOnlyFixture `
        -TerminalBoundary $terminalBoundaryFixture
    if (-not (Test-VerifiedTerminalExitAccountingLagSample `
            -Sample $terminalBoundSample) -or
        -not (Test-TerminalExitOnlyTransitionEpisode `
            -Samples @($terminalBoundSample)) -or
        -not $boundOnlySummary.boundedByCompleteSamples -or
        -not (Test-MembershipTransitionPolicy `
            -Summary $boundOnlySummary) -or
        -not (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $boundOnlyFixture `
            -TerminalBoundary $terminalBoundaryFixture `
            -MaximumCadenceMilliseconds 250.0)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_BOUND_ONLY_REJECTED'
    }
    $exactThenBoundSample = (
        $terminalBoundSample |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $exactThenBoundSample.sample = 3
    $exactThenBoundSample.startElapsedMs = 150.0
    $exactThenBoundSample.endElapsedMs = 160.0
    $exactThenBoundFixture = @(
        $terminalGapFixture[0],
        $terminalGapFixture[1],
        $exactThenBoundSample
    )
    $exactThenBoundSummary = Get-MembershipTransitionGapSummary `
        -LogicalSamples $exactThenBoundFixture `
        -TerminalBoundary $terminalBoundaryFixture
    if (-not (Test-TerminalExitOnlyTransitionEpisode `
            -Samples @(
                $terminalGapFixture[1],
                $exactThenBoundSample
            )) -or
        -not $exactThenBoundSummary.boundedByCompleteSamples -or
        -not (Test-MembershipTransitionPolicy `
            -Summary $exactThenBoundSummary) -or
        -not (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $exactThenBoundFixture `
            -TerminalBoundary $terminalBoundaryFixture `
            -MaximumCadenceMilliseconds 250.0)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_EXACT_THEN_BOUND_REJECTED'
    }
    $terminalBoundNegativeMutations = @(
        {
            param($Sample)
            $Sample.status = 'COMPLETE'
        },
        {
            param($Sample)
            $Sample.transitionReason = 'EXACT_ACTIVE_SET_CHANGED'
        },
        {
            param($Sample)
            $Sample.transitionVerificationStatus = 'NOT_VERIFIED'
        },
        {
            param($Sample)
            $Sample.preJobQueryStatus = 'FAILED'
        },
        {
            param($Sample)
            $Sample.postJobQueryStatus = 'COMPLETE'
        },
        {
            param($Sample)
            $Sample.memberDiscoveryStatus = 'COMPLETE_PROCESS_ID_LIST'
        },
        {
            param($Sample)
            $Sample.membershipRevalidationStatus = 'COMPLETE_PROCESS_ID_LIST'
        },
        {
            param($Sample)
            $Sample.memberCount = 1
        },
        {
            param($Sample)
            $Sample.postMemberCount = 0
        },
        {
            param($Sample)
            $Sample.preProcessOrdinals = @(1)
        },
        {
            param($Sample)
            $Sample.postProcessOrdinals = @(1)
        },
        {
            param($Sample)
            $Sample.processQueries = @([ordered]@{
                processOrdinal = 1
                status = 'COMPLETE'
            })
        },
        {
            param($Sample)
            $Sample.jobActiveProcesses = 1
        },
        {
            param($Sample)
            $Sample.jobReportedAccountingActiveProcesses = 0
        },
        {
            param($Sample)
            $Sample.transitionBoundActiveProcesses = 1
        },
        {
            param($Sample)
            $Sample.transitionInternalMeasurementFailureCount = 1
        },
        {
            param($Sample)
            $Sample.transitionTotalProcessesAfter = 3
        },
        {
            param($Sample)
            $Sample.transitionKnownProcessIdentityCount = 1
        },
        {
            param($Sample)
            $Sample.preKnownProcessIdentityCount = 1
        },
        {
            param($Sample)
            $Sample.transitionAccountingActiveProcessesBefore = 0
        },
        {
            param($Sample)
            $Sample.transitionAccountingActiveProcessesAfter = 2
        },
        {
            param($Sample)
            $Sample.postJobActiveProcesses = 0
        },
        {
            param($Sample)
            $Sample.transitionBoundActiveProcessEntries = @(
                [ordered]@{ processOrdinal = 1 }
            )
        }
    )
    foreach ($mutateBoundSample in $terminalBoundNegativeMutations) {
        $mutatedBoundFixture = (
            $boundOnlyFixture |
                ConvertTo-Json -Depth 10 |
                ConvertFrom-Json
        )
        & $mutateBoundSample $mutatedBoundFixture[1]
        $mutatedBoundSummary = Get-MembershipTransitionGapSummary `
            -LogicalSamples $mutatedBoundFixture `
            -TerminalBoundary $terminalBoundaryFixture
        if ((Test-VerifiedTerminalExitAccountingLagSample `
                -Sample $mutatedBoundFixture[1]) -or
            (Test-TerminalExitOnlyTransitionEpisode `
                -Samples @($mutatedBoundFixture[1])) -or
            ([string]$mutatedBoundFixture[1].status -eq
                'VERIFIED_MEMBERSHIP_TRANSITION_GAP' -and
                $mutatedBoundSummary.boundedByCompleteSamples)) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_INVALID_TERMINAL_BOUND_ACCEPTED'
        }
    }
    $mismatchedPrefixBoundSample = (
        $exactThenBoundSample |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    foreach ($property in @(
        'jobTotalProcesses',
        'preKnownProcessIdentityCount',
        'transitionTotalProcessesBefore',
        'transitionTotalProcessesAfter',
        'transitionKnownProcessIdentityCount'
    )) {
        $mismatchedPrefixBoundSample.$property = 3
    }
    if (-not (Test-VerifiedTerminalExitAccountingLagSample `
            -Sample $mismatchedPrefixBoundSample) -or
        (Test-TerminalExitOnlyTransitionEpisode `
            -Samples @(
                $terminalGapFixture[1],
                $mismatchedPrefixBoundSample
            ))) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_BOUND_PREFIX_LINK_FAILED'
    }
    $invalidExactPrefix = (
        $terminalGapFixture[1] |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $invalidExactPrefix.postProcessOrdinals = @(1, 3)
    if (Test-TerminalExitOnlyTransitionEpisode `
        -Samples @($invalidExactPrefix, $exactThenBoundSample)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_INVALID_EXACT_PREFIX_ACCEPTED'
    }
    $terminalGapSummary = Get-MembershipTransitionGapSummary `
        -LogicalSamples $terminalGapFixture `
        -TerminalBoundary $terminalBoundaryFixture
    if (-not $terminalGapSummary.boundedByCompleteSamples -or
        $terminalGapSummary.sampleCount -ne 1 -or
        $terminalGapSummary.gapCount -ne 1 -or
        $terminalGapSummary.totalDurationMs -ne 190.0 -or
        $terminalGapSummary.maximumAdjacentValidSampleGapMs -ne 200.0 -or
        $terminalGapSummary.gaps[0].nextValidSample -ne $null -or
        $terminalGapSummary.gaps[0].terminalBoundaryStatus -ne
            'VERIFIED_TERMINAL_JOB_ZERO' -or
        -not (Test-MembershipTransitionPolicy `
            -Summary $terminalGapSummary)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_TRANSITION_CLOSURE_FAILED'
    }
    if (-not (Test-SamplingTerminalBoundaryGate `
            -SamplingMetricsAccepted $true `
            -TerminalBoundary $terminalBoundaryFixture) -or
        (Test-SamplingTerminalBoundaryGate `
            -SamplingMetricsAccepted $true `
            -TerminalBoundary $null) -or
        (Test-SamplingTerminalBoundaryGate `
            -SamplingMetricsAccepted $false `
            -TerminalBoundary $terminalBoundaryFixture)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_BOUNDARY_GATE_FAILED'
    }
    $completeEndpointFixture = @([ordered]@{
        sample = 1
        status = 'COMPLETE'
        startElapsedMs = 0.0
        endElapsedMs = 10.0
    })
    $endpointAtLimit = (
        $terminalBoundaryFixture |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $endpointAtLimit.elapsedMs = 250.0
    $endpointOverLimit = (
        $endpointAtLimit |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $endpointOverLimit.elapsedMs = 250.001
    $endpointSecondsLate = (
        $endpointAtLimit |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $endpointSecondsLate.elapsedMs = 5000.0
    $discardedEndpointFixture = (
        $completeEndpointFixture |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $discardedEndpointFixture[0].status = 'DISCARDED'
    if (-not (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $completeEndpointFixture `
            -TerminalBoundary $endpointAtLimit `
            -MaximumCadenceMilliseconds 250.0) -or
        (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $completeEndpointFixture `
            -TerminalBoundary $endpointOverLimit `
            -MaximumCadenceMilliseconds 250.0) -or
        (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $completeEndpointFixture `
            -TerminalBoundary $endpointSecondsLate `
            -MaximumCadenceMilliseconds 250.0) -or
        (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $discardedEndpointFixture `
            -TerminalBoundary $endpointAtLimit `
            -MaximumCadenceMilliseconds 250.0) -or
        -not (Test-TerminalSamplingEndpointCadence `
            -LogicalSamples $terminalGapFixture `
            -TerminalBoundary $terminalBoundaryFixture `
            -MaximumCadenceMilliseconds 250.0)) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_ENDPOINT_CADENCE_FAILED'
    }
    $terminalBoundaryNegativeMutations = @(
        @{ Property = 'completionMarkerValidated'; Value = $false },
        @{ Property = 'childReportValidated'; Value = $false },
        @{ Property = 'normalExit'; Value = $false },
        @{ Property = 'rootExitCodeZero'; Value = $false },
        @{ Property = 'forcedKillCount'; Value = 1 },
        @{ Property = 'jobMemberCount'; Value = 1 },
        @{ Property = 'jobActiveProcesses'; Value = 1 },
        @{ Property = 'jobReportedAccountingActiveProcesses'; Value = 1 },
        @{ Property = 'knownProcessIdentityCount'; Value = 1 },
        @{ Property = 'residualVerified'; Value = $false },
        @{ Property = 'residualConsecutiveZeroPolls'; Value = 2 },
        @{ Property = 'residualQueryFailures'; Value = 1 },
        @{ Property = 'finalProcessHistoryStatus'; Value = 'NOT_VERIFIED' },
        @{ Property = 'jobCleanupStatus'; Value = 'FORCED_CLOSE' },
        @{ Property = 'markerObservedElapsedMs'; Value = 201.0 }
    )
    foreach ($mutation in $terminalBoundaryNegativeMutations) {
        $mutatedBoundary = (
            $terminalBoundaryFixture |
                ConvertTo-Json -Depth 10 |
                ConvertFrom-Json
        )
        $mutatedBoundary.($mutation.Property) = $mutation.Value
        $mutatedSummary = Get-MembershipTransitionGapSummary `
            -LogicalSamples $terminalGapFixture `
            -TerminalBoundary $mutatedBoundary
        if ($mutatedSummary.boundedByCompleteSamples) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_INVALID_TERMINAL_BOUNDARY_ACCEPTED'
        }
    }
    $terminalEpisodeNegativeMutations = @(
        {
            param($Sample)
            $Sample.postProcessOrdinals = @(1, 2)
            $Sample.postMemberCount = 2
            $Sample.postJobActiveProcesses = 2
        },
        {
            param($Sample)
            $Sample.postProcessOrdinals = @(1, 3)
        },
        {
            param($Sample)
            $Sample.processQueries[1].processOrdinal = 1
        },
        {
            param($Sample)
            $Sample.processQueries[1].status = 'QUERY_FAILED'
        },
        {
            param($Sample)
            $Sample.transitionInternalMeasurementFailureCount = 0
        },
        {
            param($Sample)
            $Sample.processQueries = @($Sample.processQueries[0])
            $Sample.transitionInternalMeasurementFailureCount = 0
        },
        {
            param($Sample)
            $Sample.postJobTotalProcesses = 3
            $Sample.postKnownProcessIdentityCount = 3
        }
    )
    foreach ($mutateEpisode in $terminalEpisodeNegativeMutations) {
        $mutatedEpisode = (
            $terminalGapFixture |
                ConvertTo-Json -Depth 10 |
                ConvertFrom-Json
        )
        & $mutateEpisode $mutatedEpisode[1]
        if (Test-ExactExitOnlyTransitionEpisode `
            -Samples @($mutatedEpisode[1])) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_INVALID_TERMINAL_EPISODE_ACCEPTED'
        }
    }
    $earlyTerminalBoundary = (
        $terminalBoundaryFixture |
            ConvertTo-Json -Depth 10 |
            ConvertFrom-Json
    )
    $earlyTerminalBoundary.elapsedMs = 119.0
    $earlyTerminalBoundary.markerObservedElapsedMs = 118.0
    if ((Get-MembershipTransitionGapSummary `
            -LogicalSamples $terminalGapFixture `
            -TerminalBoundary $earlyTerminalBoundary
        ).boundedByCompleteSamples) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_EARLY_TERMINAL_BOUNDARY_ACCEPTED'
    }
    foreach ($invalidPolicySummary in @(
        [ordered]@{
            boundedByCompleteSamples = $true
            sampleCount = 9
            totalDurationMs = 100.0
            gaps = @()
        },
        [ordered]@{
            boundedByCompleteSamples = $true
            sampleCount = 1
            totalDurationMs = 1000.001
            gaps = @()
        },
        [ordered]@{
            boundedByCompleteSamples = $true
            sampleCount = 1
            totalDurationMs = 100.0
            gaps = @([ordered]@{
                adjacentValidStartGapMs = 500.001
                reasonCodes = @('EXACT_ACTIVE_SET_CHANGED')
            })
        }
    )) {
        if (Test-MembershipTransitionPolicy -Summary $invalidPolicySummary) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_TERMINAL_POLICY_LIMIT_ACCEPTED'
        }
    }
    if ((Get-PrivateWorkingSetBudgetStatus `
            -PeakBytes $script:TransitionReservePassBytes `
            -TransitionSampleCount 1) -ne
            'PASS_WITH_TRANSITION_RESERVE' -or
        (Get-PrivateWorkingSetBudgetStatus `
            -PeakBytes ($script:TransitionReservePassBytes + 1) `
            -TransitionSampleCount 1) -ne
            'INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET' -or
        (Get-PrivateWorkingSetBudgetStatus `
            -PeakBytes ($script:PrivateWorkingSetBudgetBytes + 1) `
            -TransitionSampleCount 0) -ne
            'FAIL_BUDGET_EXCEEDED') {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_TRANSITION_BUDGET_FAILED'
    }
    $current = [Diagnostics.Process]::GetCurrentProcess()
    $creationTicks = [int64]$current.StartTime.ToUniversalTime().Ticks
    $pws = [Phase7BergamotNative]::PrivateWorkingSetBytes($PID, $creationTicks)
    if ($pws.Status -ne 'COMPLETE' -or $pws.PrivateWorkingSetBytes -lt 1) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_BOUND_QWS_FAILED'
    }
    $wrongIdentity = [Phase7BergamotNative]::PrivateWorkingSetBytes(
        $PID,
        $creationTicks + 1
    )
    if ($wrongIdentity.Status -eq 'COMPLETE' -or
        [Phase7BergamotNative]::TerminateBoundProcess(
            $PID,
            $creationTicks + 1,
            (Get-NativeExitCode -Hex 'E0000010')
        )) {
        throw 'BERGAMOT_COLD_PWS_SELFTEST_IDENTITY_FAIL_CLOSED_FAILED'
    }

    $sandbox = Join-Path $ArtifactRoot "runner-selftest-$([Guid]::NewGuid().ToString('N'))"
    [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    $sandbox = Assert-PathWithinRoot -Path $sandbox -Root $ArtifactRoot
    try {
        $uniquePath = Join-Path $sandbox 'unique.json'
        [Phase7BergamotNative]::WriteUniqueFile(
            $uniquePath,
            [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
        )
        try {
            [Phase7BergamotNative]::WriteUniqueFile(
                $uniquePath,
                [Text.Encoding]::UTF8.GetBytes('{}')
            )
            throw 'BERGAMOT_COLD_PWS_SELFTEST_EXISTING_OUTPUT_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq 'BERGAMOT_COLD_PWS_SELFTEST_EXISTING_OUTPUT_ACCEPTED') {
                throw
            }
        }
        $markerBinding = [ordered]@{
            direction = 'en-zh'
            manifestSha256 = (('a' * 64) -join '')
            supplyTreeSha256 = (('b' * 64) -join '')
            materializedRuntimeTreeSha256 = (('c' * 64) -join '')
            servedRuntimeTreeSha256 = (('d' * 64) -join '')
            workloadConfigSha256 = (('e' * 64) -join '')
            sourceSha256 = (('f' * 64) -join '')
            sampleIdentitySha256 = (('1' * 64) -join '')
            targetSha256 = (('2' * 64) -join '')
            warmTargetSha256 = @(
                (('3' * 64) -join ''),
                (('4' * 64) -join ''),
                (('5' * 64) -join ''),
                (('6' * 64) -join ''),
                (('7' * 64) -join '')
            )
            harnessStartToWarmSequenceCompleteMs = 123.456
        }
        $markerBindingSha256 = Get-Sha256Text -Value (
            $markerBinding | ConvertTo-Json -Depth 10 -Compress
        )
        $markerFixture = [ordered]@{
            schemaVersion = 'phase7-bergamot-warm-complete-v1'
            status = 'WARM_SEQUENCE_COMPLETE'
            direction = 'en-zh'
            bindingSha256 = $markerBindingSha256
            binding = $markerBinding
            rawTextEmitted = $false
            rawPathsEmitted = $false
        }
        $markerFixturePath = Join-Path $sandbox 'warm-complete.json'
        $markerFixtureJson = $markerFixture | ConvertTo-Json -Depth 10
        [Phase7BergamotNative]::WriteUniqueFile(
            $markerFixturePath,
            [Text.Encoding]::UTF8.GetBytes($markerFixtureJson)
        )
        $verifiedMarker = Read-WarmCompletionMarker `
            -Path $markerFixturePath `
            -Direction 'en-zh'
        $markerReportFixture = [pscustomobject]@{
            completionMarker = [pscustomobject]@{
                status = 'BOUND_CREATE_NEW_ARTIFACT'
                bindingSha256 = $markerBindingSha256
            }
            manifestSha256 = $markerBinding.manifestSha256
            supplyTreeSha256 = $markerBinding.supplyTreeSha256
            materializedRuntimeTreeSha256 =
                $markerBinding.materializedRuntimeTreeSha256
            servedRuntimeTreeSha256 =
                $markerBinding.servedRuntimeTreeSha256
            workloadConfigSha256 = $markerBinding.workloadConfigSha256
            harnessStartToWarmSequenceCompleteMs =
                $markerBinding.harnessStartToWarmSequenceCompleteMs
            routes = @([pscustomobject]@{
                sourceSha256 = $markerBinding.sourceSha256
                sampleIdentitySha256 =
                    $markerBinding.sampleIdentitySha256
                targetSha256 = $markerBinding.targetSha256
                warm = [pscustomobject]@{
                    observations = @(
                        $markerBinding.warmTargetSha256 |
                            ForEach-Object {
                                [pscustomobject]@{
                                    targetSha256 = [string]$_
                                }
                            }
                    )
                }
            })
        }
        Assert-WarmCompletionMarkerBinding `
            -Marker $verifiedMarker `
            -Report $markerReportFixture `
            -Direction 'en-zh'
        $tamperedMarkerReport = (
            $markerReportFixture |
                ConvertTo-Json -Depth 10 |
                ConvertFrom-Json
        )
        $tamperedMarkerReport.routes[0].targetSha256 =
            (('8' * 64) -join '')
        try {
            Assert-WarmCompletionMarkerBinding `
                -Marker $verifiedMarker `
                -Report $tamperedMarkerReport `
                -Direction 'en-zh'
            throw 'BERGAMOT_COLD_PWS_SELFTEST_MARKER_TAMPER_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq
                'BERGAMOT_COLD_PWS_SELFTEST_MARKER_TAMPER_ACCEPTED') {
                throw
            }
        }
        $pathProbeStream = [IO.FileStream]::new(
            $uniquePath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        try {
            try {
                [Phase7BergamotNative]::ValidateUniqueRegularFileHandle(
                    $pathProbeStream.SafeFileHandle.DangerousGetHandle(),
                    (Join-Path $sandbox 'wrong-final-path.json')
                )
                throw 'BERGAMOT_COLD_PWS_SELFTEST_FINAL_PATH_MISMATCH_ACCEPTED'
            } catch {
                if ($_.Exception.Message -eq
                    'BERGAMOT_COLD_PWS_SELFTEST_FINAL_PATH_MISMATCH_ACCEPTED') {
                    throw
                }
            }
        } finally {
            $pathProbeStream.Dispose()
        }

        $hardlinkSource = Join-Path $sandbox 'hardlink-source.json'
        [IO.File]::WriteAllText($hardlinkSource, '{}')
        $hardlinkTarget = Join-Path $sandbox 'hardlink-target.json'
        New-Item -ItemType HardLink -Path $hardlinkTarget -Target $hardlinkSource |
            Out-Null
        try {
            [Phase7BergamotNative]::ValidateUniqueRegularFile($hardlinkTarget)
            throw 'BERGAMOT_COLD_PWS_SELFTEST_HARDLINK_VALIDATION_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq
                'BERGAMOT_COLD_PWS_SELFTEST_HARDLINK_VALIDATION_ACCEPTED') {
                throw
            }
        }
        try {
            [Phase7BergamotNative]::WriteUniqueFile(
                $hardlinkTarget,
                [Text.Encoding]::UTF8.GetBytes('{}')
            )
            throw 'BERGAMOT_COLD_PWS_SELFTEST_HARDLINK_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq 'BERGAMOT_COLD_PWS_SELFTEST_HARDLINK_ACCEPTED') {
                throw
            }
        }

        $junctionTarget = Join-Path $sandbox 'junction-real'
        [IO.Directory]::CreateDirectory($junctionTarget) | Out-Null
        $junction = Join-Path $sandbox 'junction'
        New-Item -ItemType Junction -Path $junction -Target $junctionTarget |
            Out-Null
        try {
            Assert-NoReparsePointsInParentChain `
                -Path (Join-Path $junction 'result.json') `
                -RepositoryRoot $RepositoryRoot
            throw 'BERGAMOT_COLD_PWS_SELFTEST_REPARSE_PARENT_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq 'BERGAMOT_COLD_PWS_SELFTEST_REPARSE_PARENT_ACCEPTED') {
                throw
            }
        }

        $cmdPath = Join-Path $sandbox 'job-root-selftest.exe'
        Add-Type `
            -TypeDefinition (
                'public static class Phase7BergamotJobRootSelfTest {' +
                '[System.STAThread] public static void Main() {}' +
                '}'
            ) `
            -Language CSharp `
            -OutputAssembly $cmdPath `
            -OutputType WindowsApplication
        $jobStdout = Join-Path $sandbox 'job.stdout'
        $jobStderr = Join-Path $sandbox 'job.stderr'
        $launch = [Phase7BergamotNative]::CreateSuspendedJobProcess(
            $cmdPath,
            '',
            $sandbox,
            $jobStdout,
            $jobStderr
        )
        try {
            $null =
                [Phase7BergamotNative]::RecoverKnownIgnoringHeaderForSelfTest(
                    $launch,
                    0
                )
            throw 'BERGAMOT_COLD_PWS_SELFTEST_EMPTY_KNOWN_SET_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq
                'BERGAMOT_COLD_PWS_SELFTEST_EMPTY_KNOWN_SET_ACCEPTED') {
                throw
            }
        }
        $suspendedMembers = @(
            [Phase7BergamotNative]::QueryJobProcesses($launch)
        )
        if ($suspendedMembers.Count -ne 1) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_SUSPENDED_JOB_EMPTY'
        }
        $recoveredMembers = @(
            [Phase7BergamotNative]::RecoverKnownJobProcessesForSelfTest(
                $launch,
                1
            )
        )
        if ($recoveredMembers.Count -ne 1 -or
            $launch.LastProcessDiscoveryStatus -ne
                'ACCOUNTING_BOUND_KNOWN_IDENTITIES') {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_KNOWN_RECOVERY_FAILED'
        }
        $headerInconsistentMembers = @(
            [Phase7BergamotNative]::RecoverKnownIgnoringHeaderForSelfTest(
                $launch,
                0
            )
        )
        if ($headerInconsistentMembers.Count -ne 1 -or
            $launch.LastProcessDiscoveryStatus -ne
                'HEADER_INCONSISTENT_ACCOUNTING_BOUND') {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_HEADER_FALLBACK_FAILED'
        }
        try {
            $null =
                [Phase7BergamotNative]::RecoverKnownJobProcessesForSelfTest(
                    $launch,
                    2
                )
            throw 'BERGAMOT_COLD_PWS_SELFTEST_WRONG_ASSIGNED_ACCEPTED'
        } catch {
            if ($_.Exception.Message -eq
                'BERGAMOT_COLD_PWS_SELFTEST_WRONG_ASSIGNED_ACCEPTED') {
                throw
            }
        }
        $jobBoundPws = [Phase7BergamotNative]::PrivateWorkingSetBytes(
            $launch,
            [int]$launch.ProcessId,
            [int64]$launch.CreationTicks
        )
        $wrongJobPws = [Phase7BergamotNative]::PrivateWorkingSetBytes(
            $launch,
            $PID,
            $creationTicks
        )
        if ($jobBoundPws.Status -ne 'COMPLETE' -or
            $wrongJobPws.Status -eq 'COMPLETE') {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_JOB_BOUND_QWS_FAILED'
        }
        [Phase7BergamotNative]::ResumeJobRoot($launch)
        if ([Phase7BergamotNative]::WaitForRoot($launch, 5000) -ne 'EXITED' -or
            [Phase7BergamotNative]::GetRootExitCode($launch) -ne 0) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_JOB_ROOT_FAILED'
        }
        $zero = Get-JobZeroEvidence -Launch $launch -TimeoutSeconds 3
        if (-not $zero.Verified -or $zero.QueryFailures -ne 0) {
            throw "BERGAMOT_COLD_PWS_SELFTEST_JOB_ZERO_FAILED_$($zero.LastQueryFailure)"
        }
        $finalHistoryMembers = @(
            [Phase7BergamotNative]::QueryJobProcesses($launch)
        )
        if ($finalHistoryMembers.Count -ne 0 -or
            [int]$launch.LastActiveProcesses -ne 0 -or
            [int]$launch.LastReportedAccountingActiveProcesses -ne 0 -or
            [int]$launch.KnownProcessIdentities.Count -ne
                [int]$launch.LastTotalProcesses) {
            throw 'BERGAMOT_COLD_PWS_SELFTEST_FINAL_HISTORY_FAILED'
        }
        [Phase7BergamotNative]::CloseJobLaunch($launch, $true)

        $powershellPath = Join-Path $PSHOME 'powershell.exe'
        $boundLaunch = $null
        try {
            $boundLaunch = [Phase7BergamotNative]::CreateSuspendedJobProcess(
                $powershellPath,
                '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"',
                $sandbox,
                (Join-Path $sandbox 'bound.stdout'),
                (Join-Path $sandbox 'bound.stderr')
            )
            [Phase7BergamotNative]::ResumeJobRoot($boundLaunch)
            if (-not [Phase7BergamotNative]::TerminateBoundProcess(
                [int]$boundLaunch.ProcessId,
                [int64]$boundLaunch.CreationTicks,
                (Get-NativeExitCode -Hex 'E0000011')
            )) {
                throw 'BERGAMOT_COLD_PWS_SELFTEST_BOUND_TERMINATION_FAILED'
            }
            if ([Phase7BergamotNative]::WaitForRoot(
                $boundLaunch,
                $script:PostTerminateWaitMilliseconds
            ) -ne 'EXITED') {
                throw 'BERGAMOT_COLD_PWS_SELFTEST_BOUND_TERMINATION_WAIT_FAILED'
            }
            $null = [Phase7BergamotNative]::TerminateJob(
                $boundLaunch,
                (Get-NativeExitCode -Hex 'E0000015')
            )
            $boundZero = Get-JobZeroEvidence `
                -Launch $boundLaunch `
                -TimeoutSeconds 3
            if (-not $boundZero.Verified -or
                $boundZero.QueryFailures -ne 0) {
                throw 'BERGAMOT_COLD_PWS_SELFTEST_BOUND_TERMINATION_JOB_ZERO_FAILED'
            }
            [Phase7BergamotNative]::CloseJobLaunch($boundLaunch, $true)
            $boundLaunch = $null
        } finally {
            if ($null -ne $boundLaunch) {
                try {
                    $null = [Phase7BergamotNative]::TerminateJob(
                        $boundLaunch,
                        (Get-NativeExitCode -Hex 'E0000012')
                    )
                } catch {}
                try {
                    [Phase7BergamotNative]::CloseJobLaunch(
                        $boundLaunch,
                        $false
                    )
                } catch {}
            }
        }

        $jobKillLaunch = $null
        try {
            $jobKillLaunch = [Phase7BergamotNative]::CreateSuspendedJobProcess(
                $powershellPath,
                '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"',
                $sandbox,
                (Join-Path $sandbox 'job-kill.stdout'),
                (Join-Path $sandbox 'job-kill.stderr')
            )
            [Phase7BergamotNative]::ResumeJobRoot($jobKillLaunch)
            $jobKillObserved = [Phase7BergamotNative]::TerminateJob(
                $jobKillLaunch,
                (Get-NativeExitCode -Hex 'E0000013')
            )
            if ($jobKillObserved -lt 1 -or
                [Phase7BergamotNative]::WaitForRoot(
                    $jobKillLaunch,
                    $script:PostTerminateWaitMilliseconds
                ) -ne 'EXITED') {
                throw 'BERGAMOT_COLD_PWS_SELFTEST_JOB_TERMINATION_FAILED'
            }
            $jobKillZero = Get-JobZeroEvidence `
                -Launch $jobKillLaunch `
                -TimeoutSeconds 3
            if (-not $jobKillZero.Verified -or
                $jobKillZero.QueryFailures -ne 0) {
                throw 'BERGAMOT_COLD_PWS_SELFTEST_JOB_TERMINATION_ZERO_FAILED'
            }
            [Phase7BergamotNative]::CloseJobLaunch($jobKillLaunch, $true)
            $jobKillLaunch = $null
        } finally {
            if ($null -ne $jobKillLaunch) {
                try {
                    $null = [Phase7BergamotNative]::TerminateJob(
                        $jobKillLaunch,
                        (Get-NativeExitCode -Hex 'E0000014')
                    )
                } catch {}
                try {
                    [Phase7BergamotNative]::CloseJobLaunch(
                        $jobKillLaunch,
                        $false
                    )
                } catch {}
            }
        }
    } finally {
        $resolvedSandbox = Assert-PathWithinRoot -Path $sandbox -Root $ArtifactRoot
        Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
    }

    $privacyProbe = [ordered]@{
        schemaVersion = $script:SchemaVersion
        status = 'SELF_TEST_PASS'
        sameHandleQwsIdentityValidation = 'PASS'
        wrongCreationTerminationRejected = 'PASS'
        sameHandleBoundTermination = 'PASS'
        suspendedJobAssignmentBeforeResume = 'PASS'
        partialJobMemberListRejected = 'PASS'
        accountingBoundKnownIdentityRecovery = 'PASS'
        headerInconsistentAccountingBoundRecovery = 'PASS'
        exitAccountingLagCompleteRecoveryClassification = 'PASS'
        boundedMembershipTransitionClassification = 'PASS'
        markerBoundTerminalJobZeroClassification = 'PASS'
        terminalEndpointCadenceClassification = 'PASS'
        terminalExitAccountingLagClassification = 'PASS'
        exactEmptyPendingZeroClassification = 'PASS'
        singleRetryJobQueryClassification = 'PASS'
        postExitQueryFailFastClassification = 'PASS'
        transitionReserveBudgetClassification = 'PASS'
        finalKnownEqualsTotalHistory = 'PASS'
        jobBoundQwsMembershipValidation = 'PASS'
        completionMarkerCreateNewAndReportBinding = 'PASS'
        jobTerminationAndThreeZeroPollCleanup = 'PASS'
        createNewHardlinkReparseAndFinalPathRejection = 'PASS'
        rawTextEmitted = $false
        rawPathsEmitted = $false
        processIdentifiersEmitted = $false
    }
    Assert-ReportPrivacy -Report $privacyProbe -RepositoryRoot $RepositoryRoot
    return $privacyProbe
}

if ($env:OS -ne 'Windows_NT') {
    throw 'BERGAMOT_COLD_PWS_WINDOWS_REQUIRED'
}

$repositoryRoot = Resolve-NormalizedPath -Path (Join-Path $PSScriptRoot '..\..')
$artifactRoot = Resolve-NormalizedPath -Path (Join-Path $repositoryRoot 'artifacts\phase7\offline-poc')
[IO.Directory]::CreateDirectory($artifactRoot) | Out-Null
Assert-NoReparsePointsInParentChain `
    -Path (Join-Path $artifactRoot 'probe') `
    -RepositoryRoot $repositoryRoot
$nativePath = Resolve-NormalizedPath -Path (Join-Path $PSScriptRoot 'bergamot-cold-pws-native.cs')
$null = Assert-RegularFile -Path $nativePath
Add-Type -Path $nativePath

if ($SelfTest) {
    $selfTestReport = Invoke-SelfTest `
        -ArtifactRoot $artifactRoot `
        -RepositoryRoot $repositoryRoot
    $selfTestReport | ConvertTo-Json -Depth 10
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace([string]$env:ELECTRON_RUN_AS_NODE)) {
    throw 'BERGAMOT_COLD_PWS_ELECTRON_RUN_AS_NODE_MUST_BE_UNSET'
}
if ([string]::IsNullOrWhiteSpace($PocAuthorizationPath)) {
    throw 'BERGAMOT_COLD_PWS_AUTHORIZATION_REQUIRED'
}
if ($Directions.Count -lt 1 -or $Directions.Count -gt 2 -or
    @($Directions | Select-Object -Unique).Count -ne $Directions.Count) {
    throw 'BERGAMOT_COLD_PWS_DIRECTIONS_INVALID'
}

$measurementRoot = Join-Path $artifactRoot 'measurements'
[IO.Directory]::CreateDirectory($measurementRoot) | Out-Null
$resolvedOutputPath = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Join-Path $measurementRoot 'bergamot-cold-pws.json'
} elseif ([IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
} else {
    Join-Path $repositoryRoot $OutputPath
}
$resolvedOutputPath = Assert-PathWithinRoot `
    -Path $resolvedOutputPath `
    -Root $artifactRoot
[IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedOutputPath)) |
    Out-Null
Assert-NoReparsePointsInParentChain `
    -Path $resolvedOutputPath `
    -RepositoryRoot $repositoryRoot
Assert-OutputTargetAbsent -Path $resolvedOutputPath

$authorizationPath = if ([IO.Path]::IsPathRooted($PocAuthorizationPath)) {
    Resolve-NormalizedPath -Path $PocAuthorizationPath
} else {
    Resolve-NormalizedPath -Path (Join-Path $repositoryRoot $PocAuthorizationPath)
}
$authorizationIdentity = Get-FileIdentity -Path $authorizationPath
$electronPath = Resolve-NormalizedPath -Path (
    Join-Path $repositoryRoot 'node_modules\electron\dist\electron.exe'
)
$pocScriptPath = Resolve-NormalizedPath -Path (
    Join-Path $PSScriptRoot 'bergamot-electron-poc.mjs'
)
$electronPackagePath = Resolve-NormalizedPath -Path (
    Join-Path $repositoryRoot 'node_modules\electron\package.json'
)
$electronDistRoot = Resolve-NormalizedPath -Path (
    Join-Path $repositoryRoot 'node_modules\electron\dist'
)
foreach ($required in @($electronPath, $pocScriptPath, $electronPackagePath)) {
    $null = Assert-RegularFile -Path $required
}
$electronPackage = Get-Content -LiteralPath $electronPackagePath -Raw |
    ConvertFrom-Json
$electronFileIdentity = Get-FileIdentity -Path $electronPath
$electronItem = Get-Item -LiteralPath $electronPath -Force
$electronIdentity = [ordered]@{
    version = [string]$electronPackage.version
    sizeBytes = [int64]$electronFileIdentity.sizeBytes
    sha256 = [string]$electronFileIdentity.sha256
    productVersionHash = Get-Sha256Text -Value (
        [string]$electronItem.VersionInfo.ProductVersion
    )
}
if ($electronIdentity.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$' -or
    $electronIdentity.sha256 -notmatch $script:Sha256Pattern) {
    throw 'BERGAMOT_COLD_PWS_ELECTRON_IDENTITY_INVALID'
}

$harnessIdentity = Get-HarnessIdentity -ScriptRoot $PSScriptRoot
$electronDistBinding = Get-TreeIdentity -Root $electronDistRoot
$electronDistIdentity = $electronDistBinding.Report
$maximumCadenceMilliseconds = [int][Math]::Max(
    250,
    [Math]::Ceiling($SampleIntervalMilliseconds * 2.5)
)
$runnerConfiguration = [ordered]@{
    schemaVersion = $script:SchemaVersion
    directions = @($Directions | Sort-Object)
    trialsPerDirection = $TrialsPerDirection
    warmIterationsPerTrial = 5
    sampleIntervalMilliseconds = $SampleIntervalMilliseconds
    maximumLaunchToFirstSampleMilliseconds =
        $script:MaximumLaunchToFirstSampleMilliseconds
    maximumCadenceMilliseconds = $maximumCadenceMilliseconds
    maximumSampleSpanMilliseconds = $script:MaximumSampleSpanMilliseconds
    maximumProcessQuerySkewMilliseconds =
        $script:MaximumProcessQuerySkewMilliseconds
    maximumVerifiedMembershipTransitionSamples =
        $script:MaximumVerifiedMembershipTransitionSamples
    maximumAdjacentValidSampleGapMilliseconds =
        $script:MaximumAdjacentValidSampleGapMilliseconds
    maximumExitOnlyAdjacentValidSampleGapMilliseconds =
        $script:MaximumExitOnlyAdjacentValidSampleGapMilliseconds
    maximumTotalVerifiedTransitionGapMilliseconds =
        $script:MaximumTotalVerifiedTransitionGapMilliseconds
    transitionReservePassBytes =
        $script:TransitionReservePassBytes
    privateWorkingSetBudgetBytes =
        $script:PrivateWorkingSetBudgetBytes
    minimumValidSamples = $script:MinimumValidSamples
    minimumCoverageMilliseconds = $script:MinimumCoverageMilliseconds
    trialTimeoutSeconds = $TrialTimeoutSeconds
    residualTimeoutSeconds = $ResidualTimeoutSeconds
    residualPollMilliseconds = $script:ResidualPollMilliseconds
    postTerminateWaitMilliseconds = $script:PostTerminateWaitMilliseconds
    maximumCaptureBytes = $script:MaximumCaptureBytes
    captureReadTimeoutMilliseconds =
        $script:CaptureReadTimeoutMilliseconds
    maximumFinalReportBytes = $script:MaximumFinalReportBytes
}
$runnerConfigurationSha256 = Get-Sha256Text -Value (
    $runnerConfiguration | ConvertTo-Json -Depth 10 -Compress
)

$runArtifactRoot = Join-Path $measurementRoot (
    ".bergamot-cold-pws-run-$([Guid]::NewGuid().ToString('N'))"
)
[IO.Directory]::CreateDirectory($runArtifactRoot) | Out-Null
$runArtifactRoot = Assert-PathWithinRoot `
    -Path $runArtifactRoot `
    -Root $artifactRoot
Assert-NoReparsePointsInParentChain `
    -Path (Join-Path $runArtifactRoot 'probe') `
    -RepositoryRoot $repositoryRoot

$identityState = @{}
$executableVerificationCache = @{}
$trialResults = [Collections.Generic.List[object]]::new()
foreach ($direction in $Directions) {
    for ($trial = 1; $trial -le $TrialsPerDirection; $trial += 1) {
        [Console]::Error.WriteLine(
            "[bergamot-cold-pws] $direction trial $trial/$TrialsPerDirection"
        )
        $trialResults.Add((Invoke-DirectionTrial `
            -Direction $direction `
            -TrialNumber $trial `
            -ElectronPath $electronPath `
            -PocScriptPath $pocScriptPath `
            -AuthorizationPath $authorizationPath `
            -WorkingDirectory $repositoryRoot `
            -TrialArtifactRoot $runArtifactRoot `
            -ElectronIdentity $electronIdentity `
            -ElectronDistVerificationEntries $electronDistBinding.VerificationEntries `
            -ExecutableVerificationCache $executableVerificationCache `
            -IdentityState $identityState))
    }
}

$postHarnessIdentity = Get-HarnessIdentity -ScriptRoot $PSScriptRoot
if ($postHarnessIdentity.fileSetSha256 -ne $harnessIdentity.fileSetSha256) {
    throw 'BERGAMOT_COLD_PWS_HARNESS_CHANGED_DURING_RUN'
}
$postElectronDistBinding = Get-TreeIdentity -Root $electronDistRoot
if ($postElectronDistBinding.Report.treeSha256 -ne
    $electronDistIdentity.treeSha256) {
    throw 'BERGAMOT_COLD_PWS_ELECTRON_DIST_CHANGED_DURING_RUN'
}
$postAuthorizationIdentity = Get-FileIdentity -Path $authorizationPath
if ($postAuthorizationIdentity.sha256 -ne $authorizationIdentity.sha256) {
    throw 'BERGAMOT_COLD_PWS_AUTHORIZATION_CHANGED_DURING_RUN'
}

$directionReports = [Collections.Generic.List[object]]::new()
foreach ($direction in $Directions) {
    $all = @($trialResults | Where-Object direction -eq $direction)
    $successful = @($all | Where-Object {
        [string]$_.status -in @(
            'COMPLETE',
            'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
        )
    })
    $warmObservations = @($all | Where-Object childReportValidated -eq $true |
        ForEach-Object { @($_.warm.observations) })
    $warmFailures = [int](($all | ForEach-Object {
        [int]$_.warm.failures
    } | Measure-Object -Sum).Sum)
    $directionReports.Add([ordered]@{
        direction = $direction
        requestedTrials = $TrialsPerDirection
        successfulTrials = $successful.Count
        failures = $all.Count - $successful.Count
        coldAndPrivateWorkingSetFailures = $all.Count - $successful.Count
        verifiedMembershipTransitionSamples = [int]((
            $all |
                ForEach-Object {
                    [int]$_.verifiedMembershipTransitionSampleCount
                } |
                Measure-Object -Sum
        ).Sum)
        verifiedMembershipTransitionGaps = [int]((
            $all |
                ForEach-Object {
                    [int]$_.verifiedMembershipTransitionGapCount
                } |
                Measure-Object -Sum
        ).Sum)
        verifiedMembershipTransitionGapTotalMs = [Math]::Round(
            [double]((
                $all |
                    ForEach-Object {
                        [double]$_.verifiedMembershipTransitionGapTotalMs
                    } |
                    Measure-Object -Sum
            ).Sum),
            3
        )
        jobProcessQueryRetryCount = [int]((
            $all |
                ForEach-Object {
                    [int]$_.jobProcessQueryRetryCount
                } |
                Measure-Object -Sum
        ).Sum)
        jobProcessQueryFailedAfterRetryCount = [int]((
            $all |
                ForEach-Object {
                    [int]$_.jobProcessQueryFailedAfterRetryCount
                } |
                Measure-Object -Sum
        ).Sum)
        pendingTerminalZeroPollCount = [int]((
            $all |
                ForEach-Object {
                    [int]$_.pendingTerminalZeroPollCount
                } |
                Measure-Object -Sum
        ).Sum)
        postExitJobQueryFailureCount = [int]((
            $all |
                ForEach-Object {
                    [int]$_.postExitJobQueryFailureCount
                } |
                Measure-Object -Sum
        ).Sum)
        transitionReservePassTrials = @(
            $successful |
                Where-Object {
                    $_.privateWorkingSetBudgetStatus -eq
                        'PASS_WITH_TRANSITION_RESERVE'
                }
        ).Count
        rendererFirstTranslationMs = Get-Distribution -Values @(
            $successful | ForEach-Object rendererFirstTranslationMs
        )
        rendererColdRouteTotalMs = Get-Distribution -Values @(
            $successful | ForEach-Object rendererColdRouteTotalMs
        )
        freshProcessWallClockMs = Get-Distribution -Values @(
            $successful | ForEach-Object freshProcessWallClockMs
        )
        privateWorkingSetPeakBytes = Get-Distribution -Values @(
            $successful | ForEach-Object privateWorkingSetPeakBytes
        )
        warm = [ordered]@{
            requestedObservations = $TrialsPerDirection * 5
            successfulObservations = $warmObservations.Count
            failures = $warmFailures
            translationOnlyMs = Get-Distribution -Values @(
                $warmObservations | ForEach-Object translationOnlyMs
            )
            targetChars = Get-Distribution -Values @(
                $warmObservations | ForEach-Object targetChars
            )
            uniqueTargetHashes = @(
                $warmObservations | ForEach-Object targetSha256 |
                    Select-Object -Unique
            ).Count
        }
    })
}

$failureCount = @($trialResults | Where-Object {
    [string]$_.status -notin @(
        'COMPLETE',
        'COMPLETE_WITH_VERIFIED_MEMBERSHIP_TRANSITIONS'
    )
}).Count
$forcedKillCount = [int](($trialResults | ForEach-Object {
    [int]$_.forcedKillCount
} | Measure-Object -Sum).Sum)
$warmFailureCount = [int](($trialResults | ForEach-Object {
    [int]$_.warm.failures
} | Measure-Object -Sum).Sum)
$hasBothDirections = @($Directions | Select-Object -Unique).Count -eq 2
$coldPwsComplete = $hasBothDirections -and
    $TrialsPerDirection -ge 20 -and
    $failureCount -eq 0 -and
    $forcedKillCount -eq 0
$warmComplete = $hasBothDirections -and
    $TrialsPerDirection -ge 20 -and
    $warmFailureCount -eq 0
$reasonCodes = [Collections.Generic.List[string]]::new()
if (-not $hasBothDirections) { $reasonCodes.Add('BOTH_DIRECTIONS_REQUIRED') }
if ($TrialsPerDirection -lt 20) {
    $reasonCodes.Add('COLD_TRIAL_COUNT_BELOW_20_PER_DIRECTION')
}
if ($failureCount -gt 0) {
    $reasonCodes.Add('COLD_OR_PRIVATE_WORKING_SET_TRIAL_FAILURES_PRESENT')
}
if ($forcedKillCount -gt 0) {
    $reasonCodes.Add('FORCED_JOB_TERMINATION_USED')
}
if (-not $warmComplete) {
    $reasonCodes.Add('WARM_TRANSLATION_EVIDENCE_INCOMPLETE')
}
$reasonCodes.Add('OS_FIREWALL_OR_PACKET_CAPTURE_NOT_PERFORMED')
$reasonCodes.Add('NO_HUMAN_BLIND_EVALUATION')
$reasonCodes.Add('LEGAL_REVIEW_INCOMPLETE')
$reasonCodes.Add('CORE_AND_MODEL_PACK_SIZE_EVIDENCE_INCOMPLETE')

$processorNames = @(Get-CimInstance -ClassName Win32_Processor |
    ForEach-Object { [string]$_.Name })
$computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem |
    Select-Object -First 1
$workloadIdentityByDirection = [ordered]@{}
foreach ($direction in @('en-zh', 'zh-en')) {
    $workloadIdentityByDirection[$direction] = if (
        $identityState.ContainsKey("sourceSha256_$direction")
    ) {
        [ordered]@{
            sourceChars = [int]$identityState["sourceChars_$direction"]
            sourceSha256 = [string]$identityState["sourceSha256_$direction"]
            sampleIdentitySha256 =
                [string]$identityState["sampleIdentitySha256_$direction"]
            workloadConfigSha256 =
                [string]$identityState["workloadConfigSha256_$direction"]
        }
    } else { $null }
}

$report = [ordered]@{
    schemaVersion = $script:SchemaVersion
    status = if ($failureCount -gt 0 -or $forcedKillCount -gt 0) {
        'BLOCKED'
    } elseif ($coldPwsComplete -and $warmComplete) {
        'PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE'
    } else {
        'PARTIAL_M4_COLD_PWS_SMOKE'
    }
    blockerCode = if ($failureCount -gt 0 -or $forcedKillCount -gt 0) {
        'BERGAMOT_COLD_PWS_TRIAL_FAILURES_PRESENT'
    } else { $null }
    authorizationBoundary = [ordered]@{
        scope = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
        evidenceStatus = 'NON_AUTHORIZING_RAW_M4_EVIDENCE'
        integrationOrDistributionAuthorized = $false
        gateDecisionAuthorized = $false
    }
    runnerConfiguration = $runnerConfiguration
    runnerConfigurationSha256 = $runnerConfigurationSha256
    measurementMethod = [ordered]@{
        privateWorkingSet = 'QUERY_WORKING_SET_SHARED_BIT_PRIVATE_PAGES'
        qwsIdentityValidation = 'SAME_HANDLE_PRE_AND_POST_ACTIVE_CREATION_TIME'
        processLaunch = 'CREATE_SUSPENDED_ASSIGN_JOB_THEN_RESUME'
        processContainment = 'JOB_KILL_ON_CLOSE_NO_BREAKAWAY_FLAGS'
        processDiscovery = 'QUERY_INFORMATION_JOB_OBJECT_MEMBERS'
        processListCompleteness =
            'COMPLETE_LIST_OR_ACCOUNTING_BOUND_KNOWN_IDENTITIES'
        processHistoryCompleteness =
            'TOTAL_PROCESSES_EQUALS_ALL_OBSERVED_BOUND_IDENTITIES'
        exitAccountingLagRecovery =
            'STABLE_DOUBLE_ACCOUNTING_AND_BOUND_ACTIVE_IDENTITY_ENUMERATION'
        logicalSampleMembership =
            'PRE_POST_COMPLETE_OR_BOUNDED_VERIFIED_TRANSITION_WITH_TERMINAL_ZERO'
        membershipTransitionPolicy =
            'COMPLETE_BOUND_OR_STRICT_EXIT_ONLY_MARKER_BOUND_TERMINAL_ZERO'
        qwsJobMembershipValidation =
            'SAME_HANDLE_PRE_AND_POST_IS_PROCESS_IN_JOB'
        warmCompletionBoundary =
            'CREATE_NEW_MARKER_BOUND_TO_FINAL_CHILD_REPORT'
        terminalBoundary =
            'MARKER_VALIDATED_EXIT_ZERO_EXACT_HISTORY_THREE_ZERO_POLLS'
        jobProcessQueryRetryPolicy =
            'ONE_IMMEDIATE_RETRY_PRE_AND_POST_FAIL_CLOSED'
        postExitJobQueryFailurePolicy =
            'NO_RETRY_FAIL_FAST_TO_CLEANUP'
        treeAggregation = 'ONE_JOB_MEMBERSHIP_SNAPSHOT_PER_LOGICAL_SAMPLE'
        processQueriesAtomic = $false
        processIdentityBinding = 'PID_AND_CREATION_TIME_INTERNAL_ONLY'
        recursiveDescendantTracking = $true
        termination = 'JOB_LEVEL_TIMEOUT_AND_SAME_HANDLE_BOUND_PROCESS_FALLBACK'
        electronAppMetricsGateAEligible = $false
    }
    harnessIdentity = $harnessIdentity
    authorizationSha256 = $authorizationIdentity.sha256
    electronExecutable = $electronIdentity
    electronDistTree = $electronDistIdentity
    artifactIdentity = [ordered]@{
        manifestSha256 = $identityState['manifestSha256']
        materializedRuntimeTreeSha256 =
            $identityState['materializedRuntimeTreeSha256']
        servedRuntimeTreeSha256 = $identityState['servedRuntimeTreeSha256']
        supplyTreeSha256ByDirection = [ordered]@{
            'en-zh' = $identityState['supplyTreeSha256_en-zh']
            'zh-en' = $identityState['supplyTreeSha256_zh-en']
        }
        workloadIdentityByDirection = $workloadIdentityByDirection
    }
    environment = [ordered]@{
        platform = 'win32'
        architecture =
            [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        osVersionHash = Get-Sha256Text -Value (
            [Environment]::OSVersion.VersionString
        )
        processorModelHash = Get-Sha256Text -Value ($processorNames -join '|')
        logicalProcessorCount = [Environment]::ProcessorCount
        totalPhysicalMemoryBytes = [int64]$computerSystem.TotalPhysicalMemory
        powershellVersion = [string]$PSVersionTable.PSVersion
        runnerSha256 = $harnessIdentity.runnerSha256
    }
    directions = @($directionReports)
    trials = @($trialResults)
    totals = [ordered]@{
        requestedTrials = $TrialsPerDirection * $Directions.Count
        successfulTrials = $trialResults.Count - $failureCount
        failures = $failureCount
        coldAndPrivateWorkingSetFailures = $failureCount
        warmFailures = $warmFailureCount
        forcedKillCount = $forcedKillCount
        jobProcessQueryRetryCount = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.jobProcessQueryRetryCount
                } |
                Measure-Object -Sum
        ).Sum)
        jobProcessQueryFailedAfterRetryCount = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.jobProcessQueryFailedAfterRetryCount
                } |
                Measure-Object -Sum
        ).Sum)
        pendingTerminalZeroPollCount = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.pendingTerminalZeroPollCount
                } |
                Measure-Object -Sum
        ).Sum)
        postExitJobQueryFailureCount = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.postExitJobQueryFailureCount
                } |
                Measure-Object -Sum
        ).Sum)
        verifiedMembershipTransitionSamples = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.verifiedMembershipTransitionSampleCount
                } |
                Measure-Object -Sum
        ).Sum)
        verifiedMembershipTransitionGaps = [int]((
            $trialResults |
                ForEach-Object {
                    [int]$_.verifiedMembershipTransitionGapCount
                } |
                Measure-Object -Sum
        ).Sum)
    }
    externalNetworkVerification =
        'NOT_VERIFIED_BY_OS_FIREWALL_OR_PACKET_CAPTURE'
    rawTextEmitted = $false
    rawPathsEmitted = $false
    processIdentifiersEmitted = $false
    integrationOrDistributionAuthorized = $false
    gateA = [ordered]@{
        status = 'INCOMPLETE'
        eligible = $false
        coldAndPrivateWorkingSetEvidenceStatus = if ($coldPwsComplete) {
            'COMPLETE'
        } else { 'INCOMPLETE' }
        warmEvidenceStatus = if ($warmComplete) {
            'COMPLETE'
        } else { 'INCOMPLETE' }
        reasonCodes = @($reasonCodes)
    }
    outputArtifactStatus = 'CREATE_NEW_UNIQUE_IGNORED_ARTIFACT'
}

Assert-ReportPrivacy -Report $report -RepositoryRoot $repositoryRoot
Assert-NoReparsePointsInParentChain `
    -Path $resolvedOutputPath `
    -RepositoryRoot $repositoryRoot
Assert-OutputTargetAbsent -Path $resolvedOutputPath
$json = $report | ConvertTo-Json -Depth 50
$outputBytes = [Text.UTF8Encoding]::new($false).GetBytes("$json`r`n")
if ($outputBytes.Length -gt $script:MaximumFinalReportBytes) {
    throw 'BERGAMOT_COLD_PWS_FINAL_REPORT_SIZE_LIMIT_EXCEEDED'
}
[Phase7BergamotNative]::WriteUniqueFile($resolvedOutputPath, $outputBytes)
$report | ConvertTo-Json -Depth 50
if ($report.status -eq 'BLOCKED') { exit 1 }
exit 0

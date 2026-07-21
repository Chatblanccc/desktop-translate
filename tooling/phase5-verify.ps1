[CmdletBinding()]
param(
    [Parameter()][ValidateRange(1, 3600)][int]$SoakDurationSeconds = 5,
    [Parameter()][ValidateRange(1, 60000)][int]$SelectionIntervalMs = 250,
    [Parameter()][ValidateRange(1, 3600000)][int]$FaultIntervalMs = 500,
    [Parameter()][ValidateRange(1, 7200000)][int]$LifecycleIntervalMs = 1000,
    [Parameter()][string]$EvidenceRoot,
    [Parameter()][switch]$SkipPhase4,
    [Parameter()][switch]$SkipPackaging,
    [Parameter()][switch]$AllowMissingPhase5Hooks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-package-output-preflight.ps1')

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )
    if ($FilePath -eq 'pnpm') {
        $ArgumentList = @('--config.verify-deps-before-run=false') + $ArgumentList
    }
    Write-Host "[phase5] $Label"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "External command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Invoke-PowerShellHook {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter()][hashtable]$Arguments = @{}
    )
    Write-Host "[phase5] $Label"
    & $Path @Arguments
}

Push-Location $root
try {
    if (-not $SkipPackaging) {
        $null = Assert-Phase5PackageOutputNotInUse `
            -PackageOutput (Join-Path $root 'artifacts\phase5\package\dist')
        $null = Assert-Phase5PackageOutputLeaseAvailable `
            -PackageOutput (Join-Path $root 'artifacts\phase5\package\dist')
    }
    $gitSha = (& git rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[a-f0-9]{40}$') {
        throw 'Unable to bind Phase 5 evidence to the current 40-character git SHA.'
    }
    $runIdentity = if ($env:GITHUB_RUN_ID) {
        $runAttempt = if ($env:GITHUB_RUN_ATTEMPT) { $env:GITHUB_RUN_ATTEMPT } else { '1' }
        "$($env:GITHUB_RUN_ID)-$runAttempt"
    } else {
        "local-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))"
    }
    if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
        $EvidenceRoot = Join-Path $root "artifacts\phase5\$gitSha\verify-$runIdentity"
    }
    $resolvedEvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
    if (Test-Path -LiteralPath $resolvedEvidenceRoot) {
        throw "Phase 5 evidence root already exists; use a new run directory: $resolvedEvidenceRoot"
    }
    [System.IO.Directory]::CreateDirectory($resolvedEvidenceRoot) | Out-Null

    $gate = [ordered]@{
        phase4StrictSuperset = 'PENDING'
        metricsInterface = 'PENDING'
        processPrivacyHardening = 'PENDING'
        laneIdentityHardening = 'PENDING'
        acceptanceDecisionHardening = 'PENDING'
        environmentPreflightHardening = 'PENDING'
        formalPerf03Hardening = 'PENDING'
        providerSmokeHardening = 'PENDING'
        releaseEvidenceHardening = 'PENDING'
        dependencyAudit = 'PENDING'
        unsignedPackaging = 'PENDING'
        laneASmoke = 'PENDING'
        laneB = 'NOT_RUN'
        resourceInterface = 'PENDING'
        residualProcesses = 'PENDING'
        evidencePrivacy = 'PENDING'
    }

    Invoke-CheckedExternal -Label 'Tracked diff whitespace check' -FilePath 'git' -ArgumentList @('diff', '--check', 'HEAD', '--')

    if ($SkipPhase4) {
        $gate.phase4StrictSuperset = 'SKIPPED_DEVELOPMENT_ONLY'
        Write-Warning 'Phase 4 strict-superset regression was explicitly skipped; this run cannot be acceptance evidence.'
    } else {
        Invoke-PowerShellHook -Label 'Complete Phase 4 strict-superset regression' -Path (Join-Path $PSScriptRoot 'phase4-verify.ps1')
        $gate.phase4StrictSuperset = 'PASS'
    }

    $perfSmoke = Join-Path $PSScriptRoot 'phase5-perf-smoke.ps1'
    if (Test-Path -LiteralPath $perfSmoke) {
        Invoke-PowerShellHook -Label 'Phase 5 redacted metrics interface smoke' -Path $perfSmoke -Arguments @{
            OutputDirectory = (Join-Path $resolvedEvidenceRoot 'perf\instrumentation-smoke')
            GitSha = $gitSha
            BuildMode = 'development'
            Samples = 50
        }
        $gate.metricsInterface = 'SMOKE_PASS_NOT_PERFORMANCE_ACCEPTANCE'
    } elseif ($AllowMissingPhase5Hooks) {
        $gate.metricsInterface = 'NOT_IMPLEMENTED'
        Write-Warning 'tooling/phase5-perf-smoke.ps1 is not present.'
    } else {
        throw 'Required Phase 5 metrics hook is missing: tooling/phase5-perf-smoke.ps1'
    }

    Invoke-PowerShellHook -Label 'Process identity, resource, residual and privacy negative selftests' `
        -Path (Join-Path $PSScriptRoot 'phase5-process-privacy-hardening-selftest.ps1')
    $gate.processPrivacyHardening = 'PASS'

    Invoke-PowerShellHook -Label 'Lane A/B artifact identity and acceptance-boundary selftests' `
        -Path (Join-Path $PSScriptRoot 'phase5-lane-identity-selftest.ps1')
    $gate.laneIdentityHardening = 'PASS'

    Invoke-CheckedExternal -Label 'Formal acceptance decision exact-set and merged-role fail-closed selftests' `
        -FilePath 'node' -ArgumentList @('--test', 'tooling/phase5-acceptance-decision.test.mjs')
    $gate.acceptanceDecisionHardening = 'PASS'

    Invoke-PowerShellHook -Label 'Environment capability preflight privacy and fail-closed selftests' `
        -Path (Join-Path $PSScriptRoot 'phase5-environment-preflight.test.ps1')
    $gate.environmentPreflightHardening = 'PASS'

    Invoke-PowerShellHook -Label 'Formal PERF-03 fixed-count, trust-chain and privacy selftests' `
        -Path (Join-Path $PSScriptRoot 'phase5-perf03-host-ready-selftest.ps1')
    $gate.formalPerf03Hardening = 'PASS'

    Invoke-CheckedExternal -Label 'Real Provider formal identity, fault-evidence and privacy selftests' `
        -FilePath 'pnpm' -ArgumentList @('exec', 'tsx', '--test', 'tooling/phase5-provider-smoke.test.mjs')
    $gate.providerSmokeHardening = 'PASS'

    Invoke-PowerShellHook -Label 'Release evidence, safe deletion and signed-release negative selftests' `
        -Path (Join-Path $root 'tooling\packaging\phase5-release-hardening-selftest.ps1')
    $gate.releaseEvidenceHardening = 'PASS'

    $securityRoot = Join-Path $resolvedEvidenceRoot 'security'
    [System.IO.Directory]::CreateDirectory($securityRoot) | Out-Null
    Invoke-CheckedExternal -Label 'Fail-closed official npm advisory audit' -FilePath 'node' -ArgumentList @(
        'tooling/supply-chain/phase5-dependency-audit.mjs',
        '--output', (Join-Path $securityRoot 'dependency-audit.json')
    )
    $gate.dependencyAudit = 'PASS'

    $packageHook = Join-Path $root 'tooling\packaging\phase5-package.ps1'
    if ($SkipPackaging) {
        $gate.unsignedPackaging = 'SKIPPED_DEVELOPMENT_ONLY'
        Write-Warning 'Unsigned packaging was explicitly skipped; this run cannot be the Phase 5 PR gate.'
    } elseif (Test-Path -LiteralPath $packageHook) {
        Invoke-PowerShellHook -Label 'Unsigned packaged directory, supply-chain and package verification' -Path $packageHook -Arguments @{
            Mode = 'Dir'
            EvidenceRoot = (Join-Path $resolvedEvidenceRoot 'package')
        }
        $gate.unsignedPackaging = 'PASS'
    } elseif ($AllowMissingPhase5Hooks) {
        $gate.unsignedPackaging = 'NOT_IMPLEMENTED'
        Write-Warning 'tooling/packaging/phase5-package.ps1 is not present.'
    } else {
        throw 'Required Phase 5 packaging hook is missing: tooling/packaging/phase5-package.ps1'
    }

    $laneARoot = Join-Path $resolvedEvidenceRoot 'soak\lane-a-smoke'
    Invoke-CheckedExternal -Label 'Lane A deterministic orchestration harness smoke (not acceptance)' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-soak-lane-a.mjs',
        '--duration-seconds', "$SoakDurationSeconds",
        '--selection-interval-ms', "$SelectionIntervalMs",
        '--fault-interval-ms', "$FaultIntervalMs",
        '--lifecycle-interval-ms', "$LifecycleIntervalMs",
        '--output-root', $laneARoot,
        '--git-sha', $gitSha
    )
    Invoke-CheckedExternal -Label 'Lane A evidence schema validation' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-soak-validate.mjs', '--output-root', $laneARoot
    )
    $gate.laneASmoke = 'SMOKE_PASS_NOT_ACCEPTANCE'

    Invoke-PowerShellHook -Label 'Lane B explicit NOT RUN evidence' -Path (Join-Path $PSScriptRoot 'phase5-lane-b-entry.ps1') -Arguments @{
        Mode = 'NotRun'
        EvidenceRoot = (Join-Path $resolvedEvidenceRoot 'soak\lane-b')
        GitSha = $gitSha
    }

    Invoke-PowerShellHook -Label 'Resource sampler interface smoke' -Path (Join-Path $PSScriptRoot 'phase5-resource-scan.ps1') -Arguments @{
        RootProcessId = $PID
        OutputRoot = (Join-Path $resolvedEvidenceRoot 'resources\interface-smoke')
        DurationSeconds = [Math]::Min(2, $SoakDurationSeconds)
        SampleIntervalSeconds = 1
        Profile = 'Smoke'
    }
    $gate.resourceInterface = 'SMOKE_PASS_NOT_RESOURCE_ACCEPTANCE'

    Invoke-PowerShellHook -Label 'Workspace residual-process gate' -Path (Join-Path $PSScriptRoot 'phase5-residual-scan.ps1') -Arguments @{
        ScopeRoot = $root
        OutputPath = (Join-Path $resolvedEvidenceRoot 'resources\residual-processes.json')
        WaitSeconds = 3
        FailOnLeak = $true
    }
    $gate.residualProcesses = 'PASS'

    $privacyRoot = $securityRoot
    [System.IO.Directory]::CreateDirectory($privacyRoot) | Out-Null
    Invoke-CheckedExternal -Label 'Phase 5 evidence field and canary privacy scan' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-evidence-privacy-scan.mjs',
        '--root', (Join-Path $resolvedEvidenceRoot 'soak'),
        '--root', (Join-Path $resolvedEvidenceRoot 'resources'),
        '--output', (Join-Path $privacyRoot 'privacy-scan.json'),
        '--mode', 'evidence'
    )
    Invoke-CheckedExternal -Label 'Phase 5 complete evidence binary canary scan' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-evidence-privacy-scan.mjs',
        '--root', $resolvedEvidenceRoot,
        '--output', (Join-Path $privacyRoot 'binary-canary-scan.json'),
        '--mode', 'binary'
    )
    $gate.evidencePrivacy = 'PRELIMINARY_PASS_PENDING_FINAL_SCAN'

    $gitStatus = @(& git status --porcelain=v1 --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to determine whether the Phase 5 worktree is dirty.' }
    $worktreeDirty = -not [string]::IsNullOrWhiteSpace($gitStatus -join "`n")
    $strictSuperset = -not $SkipPhase4 -and -not $SkipPackaging -and
        $gate.metricsInterface -ne 'NOT_IMPLEMENTED' -and
        $gate.processPrivacyHardening -eq 'PASS' -and
        $gate.laneIdentityHardening -eq 'PASS' -and
        $gate.acceptanceDecisionHardening -eq 'PASS' -and
        $gate.environmentPreflightHardening -eq 'PASS' -and
        $gate.formalPerf03Hardening -eq 'PASS' -and
        $gate.providerSmokeHardening -eq 'PASS' -and
        $gate.releaseEvidenceHardening -eq 'PASS' -and
        $gate.dependencyAudit -eq 'PASS' -and
        $gate.unsignedPackaging -eq 'PASS'
    $summaryStatus = if (-not $strictSuperset) {
        'DEVELOPMENT_SMOKE_PASS_NOT_ACCEPTANCE'
    } elseif ($worktreeDirty) {
        'DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE'
    } else {
        'DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE'
    }
    $summary = [ordered]@{
        schemaVersion = '1.0.0'
        phase = 5
        status = 'PENDING_FINAL_PRIVACY_SCAN'
        proposedStatus = $summaryStatus
        strictPhase4Superset = $strictSuperset
        acceptance = $false
        gitSha = $gitSha
        worktreeDirty = $worktreeDirty
        gates = $gate
        limitations = @(
            'Lane A short duration is harness smoke only.',
            'Lane A simulated result consumption is not real UIA, DXGI or OCR acquisition.',
            'Lane B is explicitly NOT RUN and requires a final signed RC in a dedicated interactive session.',
            'Resource interface smoke is not the 15-minute idle or 8-hour resource gate.',
            'Real Provider smoke, signing and release verification are separate protected/manual gates.'
            'A zero exit code from this deterministic gate is not Phase 5 acceptance.'
        )
    }
    # Persist only a PENDING candidate before the final scan. If scanning fails
    # or the process is interrupted, uploaded evidence cannot contain a stale
    # PASS-looking verify-summary.
    $pendingSummaryRoot = Join-Path $securityRoot 'pending-final-scan'
    [System.IO.Directory]::CreateDirectory($pendingSummaryRoot) | Out-Null
    $pendingSummaryPath = Join-Path $pendingSummaryRoot 'verify-summary.pending.json'
    [IO.File]::WriteAllText(
        $pendingSummaryPath,
        (($summary | ConvertTo-Json -Depth 8) + "`n"),
        (New-Object Text.UTF8Encoding($false))
    )

    Invoke-CheckedExternal -Label 'Final evidence privacy rescan' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-evidence-privacy-scan.mjs',
        '--root', $resolvedEvidenceRoot,
        '--output', (Join-Path $privacyRoot 'final-privacy-scan.json'),
        '--mode', 'binary'
    )

    $gate.evidencePrivacy = 'PASS'
    $summary.status = $summaryStatus
    $summary.gates = $gate
    $summary.Remove('proposedStatus')
    [IO.File]::Delete($pendingSummaryPath)
    [IO.Directory]::Delete($pendingSummaryRoot)
    $summaryPath = Join-Path $resolvedEvidenceRoot 'verify-summary.json'
    $summaryJson = ($summary | ConvertTo-Json -Depth 8) + "`n"
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($summaryJson)
    # Scan the exact final summary bytes inside the evidence root before an
    # atomic same-volume rename exposes them as the canonical summary. A
    # failed scan therefore cannot leave a PASS-looking verify-summary.
    $finalSummaryCandidateRoot = Join-Path $securityRoot 'pending-final-summary'
    [IO.Directory]::CreateDirectory($finalSummaryCandidateRoot) | Out-Null
    $finalSummaryCandidatePath = Join-Path $finalSummaryCandidateRoot 'verify-summary.json'
    $stream = [IO.File]::Open($finalSummaryCandidatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    Invoke-CheckedExternal -Label 'Exact final summary binary privacy scan' -FilePath 'node' -ArgumentList @(
        'tooling/phase5-evidence-privacy-scan.mjs',
        '--root', $resolvedEvidenceRoot,
        '--output', (Join-Path $privacyRoot 'final-summary-binary-scan.json'),
        '--mode', 'binary'
    )
    [IO.File]::Move($finalSummaryCandidatePath, $summaryPath)
    [IO.Directory]::Delete($finalSummaryCandidateRoot)

    Write-Host "[phase5] $summaryStatus"
} finally {
    Pop-Location
}

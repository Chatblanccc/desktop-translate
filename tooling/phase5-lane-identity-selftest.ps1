[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-safe-filesystem.ps1')

$temporaryParent = Join-Path ([IO.Path]::GetTempPath()) `
    ('desktop-translate-phase5-lane-identity-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporaryParent) | Out-Null

function Assert-True {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    $gitSha = (& git -C $root rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[a-f0-9]{40}$') {
        throw 'Unable to resolve the selftest Git SHA.'
    }

    & node --test `
        (Join-Path $root 'tooling\phase5-lane-a-identity.test.mjs') `
        (Join-Path $root 'tooling\phase5-lane-a-policy.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Lane A attested identity policy selftests failed.' }

    $laneA = Join-Path $temporaryParent 'lane-a-smoke'
    & node (Join-Path $root 'tooling\phase5-soak-lane-a.mjs') `
        --duration-seconds 1 `
        --selection-interval-ms 100 `
        --fault-interval-ms 250 `
        --lifecycle-interval-ms 400 `
        --git-sha $gitSha `
        --output-root $laneA
    if ($LASTEXITCODE -ne 0) { throw 'Lane A smoke selftest failed.' }
    & node (Join-Path $root 'tooling\phase5-soak-validate.mjs') --output-root $laneA
    if ($LASTEXITCODE -ne 0) { throw 'Lane A schema selftest failed.' }
    $laneASummary = Get-Content -LiteralPath (Join-Path $laneA 'summary.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($laneASummary.status -eq 'SMOKE_PASS_NOT_ACCEPTANCE') 'Lane A smoke claimed an invalid status.'
    Assert-True ($laneASummary.acceptance -eq $false) 'Lane A smoke claimed acceptance.'
    Assert-True ($laneASummary.identity.source -eq 'UNBOUND_DEVELOPMENT_SMOKE') 'Lane A smoke identity boundary is missing.'

    $savedErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & node (Join-Path $root 'tooling\phase5-soak-lane-a.mjs') `
            --duration-seconds 1 `
            --output-root $laneA 2>$null
        $existingOutputExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    Assert-True ($existingOutputExitCode -ne 0) 'Lane A accepted a pre-existing evidence root.'

    try {
        $ErrorActionPreference = 'Continue'
        & node (Join-Path $root 'tooling\phase5-soak-lane-a.mjs') `
            --duration-seconds 1 `
            --test-artifact-sha256 ('a' * 64) `
            --output-root (Join-Path $temporaryParent 'legacy-hash-reject') 2>$null
        $legacyHashExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
    Assert-True ($legacyHashExitCode -ne 0) 'Lane A still accepted a caller-supplied artifact hash.'

    $laneB = Join-Path $temporaryParent 'lane-b-not-run'
    & (Join-Path $root 'tooling\phase5-lane-b-entry.ps1') `
        -Mode NotRun -EvidenceRoot $laneB -GitSha $gitSha
    $laneBReport = Get-Content -LiteralPath (Join-Path $laneB 'not-run.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($laneBReport.status -eq 'NOT_RUN') 'Lane B NotRun evidence is invalid.'
    Assert-True ($laneBReport.acceptance -eq $false) 'Lane B NotRun evidence claimed acceptance.'

    $preflightRejected = $false
    try {
        & (Join-Path $root 'tooling\phase5-lane-b-entry.ps1') `
            -Mode Preflight `
            -EvidenceRoot (Join-Path $temporaryParent 'lane-b-reject') `
            -GitSha $gitSha `
            -SourceRef 'refs/tags/phase5-rc-selftest'
    } catch {
        $preflightRejected = $true
    }
    Assert-True $preflightRejected 'Lane B preflight accepted a candidate without attestation and trust-root inputs.'

    Write-Host '[phase5:lane-identity:selftest] attested manifests, exact subjects, runtime mutation, path boundaries, caller-hash rejection, smoke boundary, and signed-RC preflight fail-closed PASS.'
} finally {
    if (Test-Path -LiteralPath $temporaryParent) {
        Remove-Phase5DirectoryTree -Path $temporaryParent -AllowedParent ([IO.Path]::GetTempPath())
    }
}

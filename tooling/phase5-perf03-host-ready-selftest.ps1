[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runner = Join-Path $PSScriptRoot 'phase5-perf03-host-ready.ps1'

& powershell -NoProfile -ExecutionPolicy Bypass -File $runner -StaticSelfTest
if ($LASTEXITCODE -ne 0) {
    throw 'PERF-03 static policy selftest failed.'
}

$savedPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$developmentOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner -DevelopmentSelfTest 2>&1
$ErrorActionPreference = $savedPreference
if ($LASTEXITCODE -eq 0 -or ($developmentOutput -join "`n") -notmatch 'requires explicit') {
    throw 'PERF-03 development-mode fail-closed selftest failed.'
}

$ErrorActionPreference = 'Continue'
$formalOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner -RoundCount 3 -SamplesPerRound 99 2>&1
$ErrorActionPreference = $savedPreference
if ($LASTEXITCODE -eq 0 -or ($formalOutput -join "`n") -notmatch 'frozen at 3 independent rounds with 100 samples') {
    throw 'PERF-03 formal frozen-count selftest failed.'
}

$ErrorActionPreference = 'Continue'
$formalTrustOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1
$ErrorActionPreference = $savedPreference
if ($LASTEXITCODE -eq 0 -or ($formalTrustOutput -join "`n") -notmatch 'FORMAL_PERF03_TRUST_CONTROLLER_NOT_IMPLEMENTED') {
    throw 'PERF-03 formal trust-controller fail-closed selftest failed.'
}

$source = [IO.File]::ReadAllText($runner)
foreach ($requiredContract in @(
    "'fixed-lab-benchmark'",
    "'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE'",
    "'FORCED_TERMINATION_USED'",
    "'POST_SAMPLE_PACKAGE_RESIDUAL'",
    'phase5-evidence-privacy-scan.mjs',
    'acceptanceEligibleManifestBound',
    'signedReleaseIdentityBound',
    'attestedFinalReleaseBound',
    'independentCleanDownloadBound',
    'Get-ProductExitMenuTarget',
    'Set-ProductBallAutomationFocus',
    'RaiseExistingTopmostWindow',
    'FinalReleaseManifest',
    'CleanDownloadVerification',
    'IndependentTrustedRoot',
    'final-summary-privacy-scan.json',
    'PERF03_FINAL_PUBLISH_SEQUENCE_BEGIN',
    'PERF03_FINAL_PUBLISH_SEQUENCE_END',
    'PERF03_FINAL_RECHECK_BEGIN',
    'PERF03_FINAL_RECHECK_END',
    'Open-ArtifactReadLeases',
    'Assert-ExactRawEvidence',
    'Assert-ExactEvidenceFileSet',
    'FORMAL_PERF03_TRUST_CONTROLLER_NOT_IMPLEMENTED',
    "'owner.lock'"
)) {
    if (-not $source.Contains($requiredContract)) {
        throw "PERF-03 runner is missing a fail-closed contract marker: $requiredContract"
    }
}

$sequenceStartMarker = '# PERF03_FINAL_PUBLISH_SEQUENCE_BEGIN'
$sequenceEndMarker = '# PERF03_FINAL_PUBLISH_SEQUENCE_END'
$sequenceStart = $source.IndexOf($sequenceStartMarker, [StringComparison]::Ordinal)
$sequenceEnd = $source.IndexOf($sequenceEndMarker, [StringComparison]::Ordinal)
if ($sequenceStart -lt 0 -or $sequenceEnd -le $sequenceStart) {
    throw 'PERF-03 final publication sequence markers are missing or out of order.'
}
$publishSequence = $source.Substring($sequenceStart, $sequenceEnd - $sequenceStart)

$finalizingIndex = $publishSequence.IndexOf("`$summary.status = 'FINALIZING'", [StringComparison]::Ordinal)
$canonicalFinalizingWrite = $publishSequence.IndexOf(
    'Write-AtomicJson -Path $summaryPath -Value $summary',
    [StringComparison]::Ordinal
)
$preliminaryRootScan = $publishSequence.IndexOf(
    'Invoke-EvidencePrivacyScan -Root $OutputRoot -Output $privacyPath',
    [StringComparison]::Ordinal
)
$externalCandidateIndex = $publishSequence.IndexOf(
    "Join-Path `$outputParent ('.phase5-perf03-final-summary-'",
    [StringComparison]::Ordinal
)
$candidateFlushIndex = $publishSequence.IndexOf('$candidateStream.Flush($true)', [StringComparison]::Ordinal)
$candidateScanIndex = $publishSequence.IndexOf(
    'Invoke-EvidencePrivacyScan -Root $finalSummaryCandidateRoot -Output $finalSummaryPrivacyPath',
    [StringComparison]::Ordinal
)
$finalRootScan = $publishSequence.IndexOf(
    'Invoke-EvidencePrivacyScan -Root $OutputRoot -Output $privacyPath',
    $preliminaryRootScan + 1,
    [StringComparison]::Ordinal
)
$finalRawFlushIndex = $publishSequence.IndexOf('$rawStream.Flush($true)', [StringComparison]::Ordinal)
$exactRawIndex = $publishSequence.IndexOf('Assert-ExactRawEvidence', [StringComparison]::Ordinal)
$exactFileSetIndex = $publishSequence.IndexOf('Assert-ExactEvidenceFileSet', [StringComparison]::Ordinal)
$finalSourceIndex = $publishSequence.IndexOf('Assert-SourceIdentityStillCurrent -GitSha $gitSha', [StringComparison]::Ordinal)
$finalSignedEvidenceIndex = $publishSequence.IndexOf('Assert-SignedPackageEvidence', [StringComparison]::Ordinal)
$finalArtifactIdentityIndex = $publishSequence.IndexOf('Assert-FullArtifactIdentity -Expected @($artifactIdentities)', [StringComparison]::Ordinal)
$atomicReplaceIndex = $publishSequence.IndexOf(
    '[IO.File]::Replace($finalSummaryCandidatePath, $summaryPath, $finalSummaryBackupPath)',
    [StringComparison]::Ordinal
)
$orderedIndices = @(
    $finalizingIndex,
    $canonicalFinalizingWrite,
    $preliminaryRootScan,
    $externalCandidateIndex,
    $candidateFlushIndex,
    $candidateScanIndex,
    $finalRootScan,
    $finalRawFlushIndex,
    $exactRawIndex,
    $exactFileSetIndex,
    $finalSourceIndex,
    $finalSignedEvidenceIndex,
    $finalArtifactIdentityIndex,
    $atomicReplaceIndex
)
for ($index = 0; $index -lt $orderedIndices.Count; $index += 1) {
    if ($orderedIndices[$index] -lt 0 -or ($index -gt 0 -and $orderedIndices[$index] -le $orderedIndices[$index - 1])) {
        throw 'PERF-03 interruption-safe final publication order is not enforced.'
    }
}

$canonicalWriteCount = [regex]::Matches(
    $publishSequence,
    [regex]::Escape('Write-AtomicJson -Path $summaryPath -Value $summary')
).Count
if ($canonicalWriteCount -ne 1) {
    throw 'PERF-03 may publish only the FINALIZING canonical summary before the atomic replacement.'
}
if (
    $publishSequence.Contains("Join-Path `$OutputRoot ('.phase5-perf03-final-summary-'") -or
    -not $publishSequence.Contains('$finalSummaryCandidateRoot.StartsWith($OutputRoot + ''\''') -or
    -not $publishSequence.Contains('[IO.Path]::GetPathRoot($finalSummaryCandidateRoot).Equals(')
) {
    throw 'PERF-03 final summary candidate is not proven external and same-volume.'
}

if (
    $source.Contains('[IO.File]::AppendAllText') -or
    -not $source.Contains('[IO.Directory]::Move($outputStagingRoot, $OutputRoot)') -or
    -not $source.Contains('[IO.FileMode]::CreateNew') -or
    -not $source.Contains('[IO.FileShare]::Read') -or
    -not $source.Contains('Add-RawSample -Stream $rawStream -Record $sampleRecord') -or
    -not $source.Contains('$artifactLeaseSet = Open-ArtifactReadLeases -Expected @($artifactIdentities)') -or
    -not $source.Contains('foreach ($stream in @($artifactLeaseSet.Streams))')
) {
    throw 'PERF-03 append-never namespace, held-stream, or artifact-lease contract is not enforced.'
}

$createNewCount = [regex]::Matches($source, [regex]::Escape('[IO.FileMode]::CreateNew')).Count
if ($createNewCount -lt 3) {
    throw 'PERF-03 must CreateNew owner.lock, raw.jsonl, and the external final-summary candidate.'
}

$exactFrozenFileSet = @(
    "'owner.lock'",
    "'raw.jsonl'",
    "'summary.json'",
    "'privacy-scan.json'",
    "'final-summary-privacy-scan.json'"
)
foreach ($fileName in $exactFrozenFileSet) {
    if (-not $publishSequence.Contains($fileName)) {
        throw "PERF-03 exact final evidence set omits $fileName"
    }
}

$afterAtomicReplace = $publishSequence.Substring(
    $atomicReplaceIndex + '[IO.File]::Replace($finalSummaryCandidatePath, $summaryPath, $finalSummaryBackupPath)'.Length
)
if ($afterAtomicReplace -match '(?m)\b(?:Write-AtomicJson|Invoke-EvidencePrivacyScan|Add-RawSample)\b|\[IO\.(?:File|Directory)\]::') {
    throw 'PERF-03 mutates evidence after the canonical PASS publication point.'
}

$handleTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('phase5-perf03-handle-selftest-' + [guid]::NewGuid().ToString('N'))
$heldStream = $null
try {
    [IO.Directory]::CreateDirectory($handleTestRoot) | Out-Null
    $staging = Join-Path $handleTestRoot 'staging'
    $target = Join-Path $handleTestRoot 'target'
    [IO.Directory]::CreateDirectory($staging) | Out-Null
    [IO.Directory]::CreateDirectory($target) | Out-Null
    $existingTargetRejected = $false
    try { [IO.Directory]::Move($staging, $target) } catch { $existingTargetRejected = $true }
    if (-not $existingTargetRejected) {
        throw 'Directory.Move did not reject a pre-existing append-never target.'
    }

    $heldPath = Join-Path $target 'raw.jsonl'
    $heldStream = [IO.File]::Open(
        $heldPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::Read
    )
    $competingWriteRejected = $false
    try {
        $competing = [IO.File]::Open($heldPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $competing.Dispose()
    } catch { $competingWriteRejected = $true }
    if (-not $competingWriteRejected) { throw 'Held PERF-03 evidence stream allowed a competing writer.' }

    $deleteRejected = $false
    try { [IO.File]::Delete($heldPath) } catch { $deleteRejected = $true }
    if (-not $deleteRejected) { throw 'Held PERF-03 evidence stream allowed deletion.' }

    $reader = [IO.File]::Open(
        $heldPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    )
    $reader.Dispose()
} finally {
    if ($null -ne $heldStream) { $heldStream.Dispose() }
    if (Test-Path -LiteralPath $handleTestRoot -PathType Container) {
        [IO.Directory]::Delete($handleTestRoot, $true)
    }
}

Write-Host '[phase5:perf03:selftest] invocation, atomic namespace, held handles, exact evidence, artifact leases, and interruption-safe publication checks PASS.'

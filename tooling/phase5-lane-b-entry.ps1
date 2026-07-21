[CmdletBinding()]
param(
    [Parameter()][ValidateSet('NotRun', 'Preflight')][string]$Mode = 'NotRun',
    [Parameter(Mandatory = $true)][string]$EvidenceRoot,
    [Parameter()][string]$DownloadDirectory,
    [Parameter()][string]$Repository,
    [Parameter()][string]$SourceRef,
    [Parameter()][string]$GitSha = 'UNBOUND',
    [Parameter()][string]$SignerWorkflow,
    [Parameter()][string]$ExpectedPublisherSubject,
    [Parameter()][string]$IndependentTrustedRoot,
    [Parameter()][string]$ReasonCode = 'DEDICATED_INTERACTIVE_SESSION_REQUIRED'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$resolvedEvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
[System.IO.Directory]::CreateDirectory($resolvedEvidenceRoot) | Out-Null

if ($Mode -eq 'NotRun') {
    $report = [ordered]@{
        schemaVersion = '1.0.0'
        lane = 'B'
        scope = 'real-native-acquisition-on-final-signed-rc'
        status = 'NOT_RUN'
        acceptance = $false
        reasonCode = $ReasonCode
        gitSha = $GitSha
        candidateSha256 = 'UNBOUND'
        assertions = [ordered]@{
            dedicatedInteractiveWindowsSession = $false
            finalSignedRcInstalled = $false
            fakeTransportInjected = $false
            realSelectionHostUsed = $false
            physicalOrFixtureOwnedInputUsed = $false
            eightHoursCompleted = $false
        }
        counts = [ordered]@{
            uia = 0
            ocr = 0
            rejected = 0
        }
        requiredFollowUp = @(
            'Run tooling/phase5-lane-b-entry.ps1 -Mode Preflight against a separately downloaded, attested release bundle.',
            'Provide the independently acquired GitHub/Sigstore trusted root and frozen Authenticode publisher subject.',
            'Install that exact verified final signed RC and keep Provider disabled for acquisition evidence.',
            'Use real selection-host, Hook, UIA, DXGI and Windows OCR for at least eight hours.',
            'Collect at least 600 UIA and 300 OCR cases plus rejection and recovery cases.',
            'Attach resource, WER, residual-process and privacy reports to the same candidate hash.',
            'Run the representative real-application matrix with a physical mouse.'
        )
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resolvedEvidenceRoot 'not-run.json') -Encoding utf8
    Write-Host '[phase5-lane-b] NOT RUN template written; no real Native acceptance was claimed.'
    return
}

if (-not [Environment]::UserInteractive) {
    throw 'Lane B preflight requires an interactive Windows session.'
}
$sessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
if ($sessionId -le 0) { throw 'Lane B must not run in Session 0.' }
if ($GitSha -notmatch '^[a-f0-9]{40}$') { throw '-GitSha must be 40 lowercase hex characters.' }
if ($SourceRef -notmatch '^refs/tags/phase5-rc-') { throw '-SourceRef must be a Phase 5 RC tag ref.' }
foreach ($required in @{
    DownloadDirectory = $DownloadDirectory
    Repository = $Repository
    SignerWorkflow = $SignerWorkflow
    ExpectedPublisherSubject = $ExpectedPublisherSubject
    IndependentTrustedRoot = $IndependentTrustedRoot
}.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$required.Value)) {
        throw "-$($required.Key) is required for Lane B preflight."
    }
}

$verificationRoot = Join-Path $resolvedEvidenceRoot 'candidate-verification'
& (Join-Path $PSScriptRoot 'supply-chain\phase5-clean-download-verify.ps1') `
    -DownloadDirectory $DownloadDirectory `
    -Repository $Repository `
    -SourceRef $SourceRef `
    -SourceDigest $GitSha `
    -SignerWorkflow $SignerWorkflow `
    -ExpectedSubject $ExpectedPublisherSubject `
    -IndependentTrustedRoot $IndependentTrustedRoot `
    -OutputDirectory $verificationRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Lane B candidate clean-download verification failed.'
}
$verificationPath = Join-Path $verificationRoot 'clean-download-verification.json'
$verification = Get-Content -LiteralPath $verificationPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($verification.status -ne 'PASS' -or
    $verification.releaseStatus -ne 'PASS' -or
    $verification.sourceDigest -ne $GitSha -or
    $verification.sourceRef -ne $SourceRef -or
    $verification.authenticodeSubject -ne $ExpectedPublisherSubject) {
    throw 'Lane B candidate verification report is not an exact signed/attested PASS.'
}
$artifacts = @($verification.exactArtifacts)
$expectedRoles = @('application', 'asar', 'installer', 'nativeHost')
$actualRoles = @($artifacts | ForEach-Object role | Sort-Object)
if (($expectedRoles | ConvertTo-Json -Compress) -ne ($actualRoles | ConvertTo-Json -Compress)) {
    throw 'Lane B candidate verification report does not contain the exact release artifact roles.'
}
$installer = @($artifacts | Where-Object role -eq 'installer')
if ($installer.Count -ne 1 -or $installer[0].sha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'Lane B candidate verification report has no unique installer identity.'
}
$preflight = [ordered]@{
    schemaVersion = '1.0.0'
    lane = 'B'
    scope = 'real-native-acquisition-on-final-signed-rc'
    status = 'READY_FOR_MANUAL_EXECUTION_NOT_ACCEPTED'
    acceptance = $false
    gitSha = $GitSha
    sourceRef = $SourceRef
    candidateSha256 = $installer[0].sha256
    candidate = [ordered]@{
        exactArtifactRoles = $actualRoles
        finalManifestSha256 = $verification.finalManifestSha256
        authenticodeSubject = $ExpectedPublisherSubject
        cleanDownloadVerification = 'candidate-verification/clean-download-verification.json'
    }
    assertions = [ordered]@{
        interactiveNonSessionZero = $true
        dedicatedInteractiveWindowsSession = $false
        registeredDeviceAndUnlockedDesktopVerified = $false
        finalSignedRcAvailable = $true
        exactArtifactSetVerified = $true
        authenticodeAndTimestampVerified = $true
        githubAttestationVerified = $true
        independentTrustedRootVerified = $true
        sourceGitBindingVerified = $true
        fakeTransportInjected = $false
        eightHoursCompleted = $false
    }
    nextStep = 'Independently confirm the registered dedicated device and unlocked desktop, then execute the reviewed workload and complete the Lane B evidence manifest.'
}
$preflight | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resolvedEvidenceRoot 'preflight.json') -Encoding utf8
Write-Host '[phase5-lane-b] READY FOR MANUAL EXECUTION; this preflight is not Lane B acceptance.'

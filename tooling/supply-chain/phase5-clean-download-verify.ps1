[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DownloadDirectory,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$SourceRef,
    [Parameter(Mandatory = $true)][string]$SourceDigest,
    [Parameter(Mandatory = $true)][string]$SignerWorkflow,
    [Parameter(Mandatory = $true)][string]$ExpectedSubject,
    [Parameter(Mandatory = $true)][string]$IndependentTrustedRoot,
    [Parameter()][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'tooling\packaging\phase5-safe-filesystem.ps1')

function Assert-ExactRecords {
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)][string]$Label)
    $expectedRoles = @($Expected | ForEach-Object role | Sort-Object)
    $actualRoles = @($Actual | ForEach-Object role | Sort-Object)
    if (($expectedRoles | ConvertTo-Json -Compress) -ne ($actualRoles | ConvertTo-Json -Compress)) {
        throw "RELEASE BLOCKED: $Label roles are not exact."
    }
    foreach ($record in $Actual) {
        $reference = @($Expected | Where-Object role -eq $record.role)
        if ($reference.Count -ne 1) { throw "RELEASE BLOCKED: $Label contains a duplicate/missing role $($record.role)." }
        foreach ($field in @('path', 'name', 'size', 'sha256')) {
            if ($reference[0].$field -ne $record.$field) { throw "RELEASE BLOCKED: $Label $($record.role).$field mismatch." }
        }
    }
}

function Get-RegularTreeFiles {
    param([Parameter(Mandatory = $true)][string]$Root)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "RELEASE BLOCKED: clean-download root is not a regular directory: $rootFull"
    }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($rootFull)
    $files = @()
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "RELEASE BLOCKED: clean-download bundle contains a reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pending.Enqueue($item.FullName)
            } else {
                $files += $item.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
            }
        }
    }
    return $files
}

function Assert-AttestationBundleSubjects {
    param(
        [Parameter(Mandatory = $true)][string]$Bundle,
        [Parameter(Mandatory = $true)][string[]]$ExpectedSha256
    )
    try {
        $bundleValue = Get-Content -LiteralPath $Bundle -Raw -Encoding UTF8 | ConvertFrom-Json
        $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($bundleValue.dsseEnvelope.payload))
        $statement = $payloadJson | ConvertFrom-Json
    } catch {
        throw 'RELEASE BLOCKED: attestation bundle/DSSE statement is malformed.'
    }
    if ($statement._type -ne 'https://in-toto.io/Statement/v1' -or
        $statement.predicateType -ne 'https://slsa.dev/provenance/v1') {
        throw 'RELEASE BLOCKED: attestation bundle is not SLSA provenance v1.'
    }
    $actual = @($statement.subject | ForEach-Object { $_.digest.sha256 } | Sort-Object)
    $expected = @($ExpectedSha256 | Sort-Object)
    if ((@($actual | Select-Object -Unique).Count -ne $actual.Count) -or
        (($actual | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress))) {
        throw 'RELEASE BLOCKED: attestation subject set is not the exact expected byte set.'
    }
}

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'artifacts\phase5\clean-download-verification' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
Remove-Phase5DirectoryTree -Path $OutputDirectory -AllowedParent (Split-Path -Parent $OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$outputPath = Join-Path $OutputDirectory 'clean-download-verification.json'
$initialBlocked = [ordered]@{
    schemaVersion = 1
    status = 'RELEASE BLOCKED'
    releaseStatus = 'RELEASE BLOCKED'
    repository = $Repository
    sourceRef = $SourceRef
    sourceDigest = $SourceDigest
    blockers = @('Independent manifest/artifact attestation and clean-download verification have not completed.')
}
[IO.File]::WriteAllText($outputPath, (($initialBlocked | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))

$downloadItem = Get-Item -LiteralPath $DownloadDirectory -Force -ErrorAction Stop
if (-not $downloadItem.PSIsContainer -or
    ($downloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'RELEASE BLOCKED: DownloadDirectory must be a regular directory, not a reparse point.'
}
$DownloadDirectory = [IO.Path]::GetFullPath($downloadItem.FullName)
# Reject all reparse points before probing any candidate-controlled evidence path.
Get-RegularTreeFiles -Root $DownloadDirectory | Out-Null
$trustedRootItem = Get-Item -LiteralPath $IndependentTrustedRoot -Force -ErrorAction Stop
if ($trustedRootItem.PSIsContainer -or
    ($trustedRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'RELEASE BLOCKED: independently acquired trusted root must be a regular file.'
}
$IndependentTrustedRoot = [IO.Path]::GetFullPath($trustedRootItem.FullName)

if ($SourceDigest -notmatch '^[a-f0-9]{40}$') { throw 'SourceDigest must be a lowercase full Git SHA.' }
if ($SourceRef -notmatch '^refs/tags/phase5-rc-') { throw 'RELEASE BLOCKED: clean-download verification requires a Phase 5 RC tag ref.' }
$ghVersionLine = (gh --version | Select-Object -First 1)
if ($ghVersionLine -notmatch '^gh version ([0-9]+\.[0-9]+\.[0-9]+)' -or [version]$Matches[1] -lt [version]'2.93.0') {
    throw "RELEASE BLOCKED: GitHub CLI >= 2.93.0 is required for attestation verification; found '$ghVersionLine'."
}

$manifestPath = Join-Path $DownloadDirectory 'evidence\release\final-release-manifest.json'
$artifactBundle = Join-Path $DownloadDirectory 'evidence\security\github-artifacts-attestation.json'
$manifestBundle = Join-Path $DownloadDirectory 'evidence\security\github-manifest-attestation.json'
$trustedRoot = Join-Path $DownloadDirectory 'evidence\security\trusted_root.jsonl'
foreach ($path in @($manifestPath, $artifactBundle, $manifestBundle, $trustedRoot)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "RELEASE BLOCKED: clean-download evidence is missing: $path" }
}
if ((Get-Item -LiteralPath $IndependentTrustedRoot).Length -le 0) { throw 'RELEASE BLOCKED: independently acquired trusted root is empty.' }
if ((Get-FileHash -LiteralPath $IndependentTrustedRoot -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $trustedRoot -Algorithm SHA256).Hash) {
    throw 'RELEASE BLOCKED: independently acquired GitHub/Sigstore trusted root differs from the attested release evidence.'
}

function Invoke-AttestationVerification {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Bundle)
    & gh attestation verify $Path `
        --repo $Repository `
        --bundle $Bundle `
        --custom-trusted-root $IndependentTrustedRoot `
        --signer-workflow $SignerWorkflow `
        --source-ref $SourceRef `
        --source-digest $SourceDigest | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "RELEASE BLOCKED: GitHub artifact attestation failed for $Path" }
}

# Verify the manifest before trusting any paths or hashes contained in it.
Invoke-AttestationVerification -Path $manifestPath -Bundle $manifestBundle
Assert-AttestationBundleSubjects -Bundle $manifestBundle -ExpectedSha256 @(
    (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
)
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or
    $manifest.source.repository -ne $Repository -or
    $manifest.source.ref -ne $SourceRef -or
    $manifest.source.gitSha -ne $SourceDigest -or
    $manifest.source.developmentDirty -ne $false -or
    $null -ne $manifest.source.patchDigest) {
    throw 'RELEASE BLOCKED: attested final manifest source identity is invalid.'
}
if ($manifest.independentTrustRoot.status -ne 'PASS' -or
    $manifest.independentTrustRoot.signerWorkflow -ne $SignerWorkflow) {
    throw 'RELEASE BLOCKED: final manifest does not record the required independent trust root.'
}

$installerFiles = @(Get-ChildItem -LiteralPath (Join-Path $DownloadDirectory 'installer') -File -Filter '*.exe')
if ($installerFiles.Count -ne 1) { throw "RELEASE BLOCKED: expected exactly one downloaded installer, found $($installerFiles.Count)." }
$artifactPaths = [ordered]@{
    application = Join-Path $DownloadDirectory 'package\desktop-translate.exe'
    nativeHost = Join-Path $DownloadDirectory 'package\resources\selection-host\selection-host.exe'
    asar = Join-Path $DownloadDirectory 'package\resources\app.asar'
    installer = $installerFiles[0].FullName
}

$actualArtifacts = @()
foreach ($role in $artifactPaths.Keys) {
    $path = $artifactPaths[$role]
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "RELEASE BLOCKED: downloaded $role is missing: $path" }
    Invoke-AttestationVerification -Path $path -Bundle $artifactBundle
    $logicalPath = switch ($role) {
        'application' { 'package/desktop-translate.exe' }
        'nativeHost' { 'package/resources/selection-host/selection-host.exe' }
        'asar' { 'package/resources/app.asar' }
        'installer' { 'installer/' + [IO.Path]::GetFileName($path) }
    }
    $item = Get-Item -LiteralPath $path
    $actualArtifacts += [ordered]@{
        role = $role
        path = $logicalPath
        name = $item.Name
        size = $item.Length
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
Assert-ExactRecords -Expected @($manifest.artifacts) -Actual $actualArtifacts -Label 'final release manifest artifacts'
Assert-AttestationBundleSubjects -Bundle $artifactBundle -ExpectedSha256 @($actualArtifacts | ForEach-Object sha256)

$evidenceHashInputs = [ordered]@{
    'authenticode.signatureReportSha256' = Join-Path $DownloadDirectory 'evidence\security\signature-report.json'
    'packageSmoke.reportSha256' = Join-Path $DownloadDirectory 'evidence\package\startup-smoke.json'
    'packageEvidence.sizeManifestSha256' = Join-Path $DownloadDirectory 'evidence\package\size-manifest.json'
    'packageEvidence.fileManifestSha256' = Join-Path $DownloadDirectory 'evidence\package\file-manifest.sha256'
    'supplyChain.binaryManifestSha256' = Join-Path $DownloadDirectory 'evidence\binary-manifest.json'
    'supplyChain.workspaceStateSha256' = Join-Path $DownloadDirectory 'evidence\build\workspace-state.json'
    'supplyChain.draftEvidenceSha256' = Join-Path $DownloadDirectory 'evidence\release\evidence-manifest.json'
    'supplyChain.sbomSha256' = Join-Path $DownloadDirectory 'evidence\supply-chain\sbom.cdx.json'
    'supplyChain.provenanceSha256' = Join-Path $DownloadDirectory 'evidence\supply-chain\build-provenance.json'
    'supplyChain.dependencyAuditSha256' = Join-Path $DownloadDirectory 'evidence\supply-chain\dependency-audit.json'
    'supplyChain.noticesSha256' = Join-Path $DownloadDirectory 'evidence\supply-chain\third-party-notices.txt'
    'supplyChain.stagedFileManifestSha256' = Join-Path $DownloadDirectory 'evidence\supply-chain\staged-file-manifest.sha256'
    'independentTrustRoot.artifactBundleSha256' = $artifactBundle
    'independentTrustRoot.trustedRootSha256' = $trustedRoot
}
foreach ($entry in $evidenceHashInputs.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "RELEASE BLOCKED: referenced evidence is missing: $($entry.Value)" }
    $segments = $entry.Key.Split('.')
    $expected = $manifest
    foreach ($segment in $segments) { $expected = $expected.$segment }
    $actual = (Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "RELEASE BLOCKED: evidence hash mismatch for $($entry.Key)" }
}
$dependencyAudit = Get-Content -LiteralPath (Join-Path $DownloadDirectory 'evidence\supply-chain\dependency-audit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($dependencyAudit.status -ne 'PASS' -or
    $dependencyAudit.endpoint.status -ne 'PASS' -or
    $dependencyAudit.registry -ne 'https://registry.npmjs.org/' -or
    $dependencyAudit.gitSha -ne $SourceDigest -or
    $dependencyAudit.vulnerabilities.high -ne 0 -or
    $dependencyAudit.vulnerabilities.critical -ne 0) {
    throw 'RELEASE BLOCKED: downloaded dependency audit evidence does not meet the frozen policy.'
}
$startupSmoke = Get-Content -LiteralPath (Join-Path $DownloadDirectory 'evidence\package\startup-smoke.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($startupSmoke.status -ne 'PASS' -or
    $startupSmoke.packagedNativeHostPathVerified -ne $true -or
    $startupSmoke.packagedClearDataHelperExecuted -ne $true -or
    $startupSmoke.markerBoundTargetDeleted -ne $true -or
    $startupSmoke.siblingPreserved -ne $true) {
    throw 'RELEASE BLOCKED: downloaded packaged startup/clear-data helper proof is incomplete.'
}

$signVerificationDirectory = Join-Path $OutputDirectory 'authenticode-recheck'
& (Join-Path $PSScriptRoot 'phase5-sign-verify.ps1') `
    -PackageDirectory (Join-Path $DownloadDirectory 'package') `
    -InstallerPath $installerFiles[0].FullName `
    -ExpectedSubject $ExpectedSubject `
    -EvidenceDirectory $signVerificationDirectory `
    -RequireSigned
if ($LASTEXITCODE -ne 0) { throw 'RELEASE BLOCKED: clean-download Authenticode recheck failed.' }
$freshSignatureReport = Get-Content -LiteralPath (Join-Path $signVerificationDirectory 'security\signature-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$signedActual = @($actualArtifacts | Where-Object role -ne 'asar')
Assert-ExactRecords -Expected @($freshSignatureReport.artifacts) -Actual $signedActual -Label 'clean-download signature report'
if ($freshSignatureReport.expectedSubject -ne $ExpectedSubject -or $freshSignatureReport.status -ne 'PASS') {
    throw 'RELEASE BLOCKED: clean-download signature identity/state mismatch.'
}

$expectedFiles = @(
    'package/desktop-translate.exe',
    'package/resources/selection-host/selection-host.exe',
    'package/resources/app.asar',
    'installer/' + $installerFiles[0].Name,
    'evidence/binary-manifest.json',
    'evidence/build/workspace-state.json',
    'evidence/package/startup-smoke.json',
    'evidence/package/size-manifest.json',
    'evidence/package/file-manifest.sha256',
    'evidence/release/evidence-manifest.json',
    'evidence/release/final-release-manifest.json',
    'evidence/security/signature-report.json',
    'evidence/security/github-artifacts-attestation.json',
    'evidence/security/github-manifest-attestation.json',
    'evidence/security/trusted_root.jsonl',
    'evidence/supply-chain/sbom.cdx.json',
    'evidence/supply-chain/build-provenance.json'
    'evidence/supply-chain/dependency-audit.json'
    'evidence/supply-chain/third-party-notices.txt'
    'evidence/supply-chain/staged-file-manifest.sha256'
) | Sort-Object
$actualFiles = @(Get-RegularTreeFiles -Root $DownloadDirectory | Sort-Object)
if (($expectedFiles | ConvertTo-Json -Compress) -ne ($actualFiles | ConvertTo-Json -Compress)) {
    throw "RELEASE BLOCKED: clean-download file set is not exact. Expected [$($expectedFiles -join ', ')], got [$($actualFiles -join ', ')]"
}

$verification = [ordered]@{
    schemaVersion = 1
    status = 'PASS'
    releaseStatus = 'PASS'
    repository = $Repository
    sourceRef = $SourceRef
    sourceDigest = $SourceDigest
    signerWorkflow = $SignerWorkflow
    finalManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    manifestAttestationSha256 = (Get-FileHash -LiteralPath $manifestBundle -Algorithm SHA256).Hash.ToLowerInvariant()
    trustedRootSha256 = (Get-FileHash -LiteralPath $trustedRoot -Algorithm SHA256).Hash.ToLowerInvariant()
    independentlyAcquiredTrustedRootSha256 = (Get-FileHash -LiteralPath $IndependentTrustedRoot -Algorithm SHA256).Hash.ToLowerInvariant()
    exactArtifacts = $actualArtifacts
    authenticodeSubject = $ExpectedSubject
    verifiedAt = [DateTime]::UtcNow.ToString('o')
    verificationBoundary = 'PASS applies only to this exact downloaded byte set and its GitHub/Sigstore + Authenticode identities.'
}
[IO.File]::WriteAllText($outputPath, (($verification | ConvertTo-Json -Depth 10) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Host "[phase5:clean-download] PASS: $outputPath"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PackageDirectory,
    [Parameter()][string]$InstallerPath,
    [Parameter()][string]$ExpectedSubject,
    [Parameter()][string]$EvidenceDirectory,
    [Parameter()][switch]$RequireSigned
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'tooling\packaging\phase5-safe-filesystem.ps1')
if (-not $EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $root 'artifacts\phase5\local\signing'
}
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$securityDirectory = Join-Path $EvidenceDirectory 'security'
$releaseDirectory = Join-Path $EvidenceDirectory 'release'
New-Item -ItemType Directory -Force -Path $securityDirectory, $releaseDirectory | Out-Null

if ($RequireSigned -and -not $ExpectedSubject) {
    throw 'RELEASE BLOCKED: -ExpectedSubject is required for signed release verification.'
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($Path, $json + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Test-CertificateChain {
    param([Parameter(Mandatory = $true)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    try {
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::EntireChain
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(20)
        $valid = $chain.Build($Certificate)
        return [ordered]@{
            valid = $valid
            status = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
            subjects = @($chain.ChainElements | ForEach-Object { $_.Certificate.Subject })
        }
    } finally {
        $chain.Dispose()
    }
}

function Test-TamperRejection {
    param([Parameter(Mandatory = $true)][string]$Path)
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-sign-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $copyPath = Join-Path $temporaryRoot ([IO.Path]::GetFileName($Path))
    try {
        Copy-Item -LiteralPath $Path -Destination $copyPath
        $stream = [IO.File]::Open($copyPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            if ($stream.Length -lt 1) { throw 'Cannot tamper-test an empty artifact.' }
            $stream.Position = $stream.Length - 1
            $original = $stream.ReadByte()
            $stream.Position = $stream.Length - 1
            $stream.WriteByte(($original -bxor 0x01))
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        $tampered = Get-AuthenticodeSignature -LiteralPath $copyPath
        return [ordered]@{
            rejected = $tampered.Status -ne [Management.Automation.SignatureStatus]::Valid
            status = $tampered.Status.ToString()
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Phase5DirectoryTree -Path $temporaryRoot -AllowedParent ([IO.Path]::GetTempPath())
        }
    }
}

$reports = @()
$blockers = @()
$packageFull = (Resolve-Path -LiteralPath $PackageDirectory -ErrorAction Stop).Path
$artifactDefinitions = @(
    [ordered]@{
        role = 'application'
        logicalPath = 'package/desktop-translate.exe'
        path = Join-Path $packageFull 'desktop-translate.exe'
    },
    [ordered]@{
        role = 'nativeHost'
        logicalPath = 'package/resources/selection-host/selection-host.exe'
        path = Join-Path $packageFull 'resources\selection-host\selection-host.exe'
    }
)
if ($InstallerPath) {
    $artifactDefinitions += [ordered]@{
        role = 'installer'
        logicalPath = 'installer/' + [IO.Path]::GetFileName($InstallerPath)
        path = $InstallerPath
    }
}
if ($RequireSigned -and -not $InstallerPath) {
    throw 'RELEASE BLOCKED: signed release verification requires the installer as part of the exact artifact set.'
}

foreach ($definition in $artifactDefinitions) {
    $candidate = $definition.path
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    $path = $resolved.Path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Signing artifact is not a file: $path" }
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    $signed = $null -ne $signature.SignerCertificate
    $valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
    $report = [ordered]@{
        role = $definition.role
        path = $definition.logicalPath
        name = [IO.Path]::GetFileName($path)
        size = (Get-Item -LiteralPath $path).Length
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = $signature.Status.ToString()
        signed = $signed
        subject = if ($signed) { $signature.SignerCertificate.Subject } else { $null }
        thumbprint = if ($signed) { $signature.SignerCertificate.Thumbprint } else { $null }
        timestampSubject = if ($null -ne $signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
        signerChain = $null
        timestampChain = $null
        tamperTest = $null
    }
    if (-not $signed -or -not $valid) {
        $blockers += "$($report.name): Authenticode status $($report.signatureStatus)"
    } else {
        if ($ExpectedSubject -and -not [string]::Equals($signature.SignerCertificate.Subject, $ExpectedSubject, [StringComparison]::OrdinalIgnoreCase)) {
            $blockers += "$($report.name): publisher subject does not match the frozen release identity"
        }
        $report.signerChain = Test-CertificateChain -Certificate $signature.SignerCertificate
        if (-not $report.signerChain.valid) { $blockers += "$($report.name): signer chain validation failed" }
        if ($null -eq $signature.TimeStamperCertificate) {
            $blockers += "$($report.name): trusted timestamp is missing"
        } else {
            $report.timestampChain = Test-CertificateChain -Certificate $signature.TimeStamperCertificate
            if (-not $report.timestampChain.valid) { $blockers += "$($report.name): timestamp chain validation failed" }
        }
        $report.tamperTest = Test-TamperRejection -Path $path
        if (-not $report.tamperTest.rejected) { $blockers += "$($report.name): tampered copy was not rejected" }
    }
    $reports += $report
}

$releaseStatus = if ($blockers.Count -eq 0) { 'PASS' } else { 'RELEASE BLOCKED' }
$signatureReport = [ordered]@{
    schemaVersion = 2
    status = $releaseStatus
    requireSigned = [bool]$RequireSigned
    expectedSubject = if ($ExpectedSubject) { $ExpectedSubject } else { $null }
    exactArtifactRoles = @($artifactDefinitions | ForEach-Object { $_.role } | Sort-Object)
    artifacts = $reports
    blockers = $blockers
}
$reportPath = Join-Path $securityDirectory 'signature-report.json'
Write-Utf8Json -Path $reportPath -Value $signatureReport

$evidencePath = Join-Path $releaseDirectory 'evidence-manifest.json'
$evidence = if (Test-Path -LiteralPath $evidencePath -PathType Leaf) {
    Get-Content -LiteralPath $evidencePath -Encoding UTF8 -Raw | ConvertFrom-Json
} else {
    [pscustomobject]@{ schemaVersion = 1 }
}
$evidence | Add-Member -NotePropertyName signatures -NotePropertyValue ([ordered]@{
    status = $releaseStatus
    report = 'security/signature-report.json'
    artifacts = @($reports | ForEach-Object {
        [ordered]@{
            role = $_.role
            path = $_.path
            name = $_.name
            size = $_.size
            sha256 = $_.sha256
            subject = $_.subject
        }
    })
}) -Force
$existingBlockers = @()
if ($evidence.PSObject.Properties.Name -contains 'release' -and $evidence.release.PSObject.Properties.Name -contains 'blockers') {
    $existingBlockers = @($evidence.release.blockers | Where-Object { $_ -notmatch 'Authenticode|signing|timestamp' })
}
$attestationBlocker = 'Independent GitHub artifact attestation and clean-download verification have not completed.'
$combinedBlockers = @($existingBlockers + $blockers + $attestationBlocker | Select-Object -Unique)
$evidence | Add-Member -NotePropertyName release -NotePropertyValue ([ordered]@{
    status = if ($combinedBlockers.Count -eq 0) { 'PASS' } else { 'RELEASE BLOCKED' }
    blockers = $combinedBlockers
}) -Force
Write-Utf8Json -Path $evidencePath -Value $evidence

if ($blockers.Count -ne 0) {
    Write-Host '[phase5:sign] RELEASE BLOCKED'
    foreach ($blocker in $blockers) { Write-Host "  - $blocker" }
    if ($RequireSigned) { throw 'RELEASE BLOCKED: required Authenticode/timestamp verification did not pass.' }
    return
}

Write-Host '[phase5:sign] Authenticode identity, chain, timestamp, and tamper rejection PASS.'

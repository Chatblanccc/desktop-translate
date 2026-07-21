[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')
$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory)
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
Remove-Phase5DirectoryTree -Path $OutputDirectory -AllowedParent (Join-Path $root 'artifacts\phase5')

$copies = [ordered]@{
    'package/desktop-translate.exe' = Join-Path $PackageDirectory 'desktop-translate.exe'
    'package/resources/selection-host/selection-host.exe' = Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'
    'package/resources/app.asar' = Join-Path $PackageDirectory 'resources\app.asar'
    ('installer/' + [IO.Path]::GetFileName($InstallerPath)) = $InstallerPath
    'evidence/binary-manifest.json' = Join-Path $EvidenceDirectory 'binary-manifest.json'
    'evidence/build/workspace-state.json' = Join-Path $EvidenceDirectory 'build\workspace-state.json'
    'evidence/package/startup-smoke.json' = Join-Path $EvidenceDirectory 'package\startup-smoke.json'
    'evidence/package/size-manifest.json' = Join-Path $EvidenceDirectory 'package\size-manifest.json'
    'evidence/package/file-manifest.sha256' = Join-Path $EvidenceDirectory 'package\file-manifest.sha256'
    'evidence/release/evidence-manifest.json' = Join-Path $EvidenceDirectory 'release\evidence-manifest.json'
    'evidence/release/final-release-manifest.json' = Join-Path $EvidenceDirectory 'release\final-release-manifest.json'
    'evidence/security/signature-report.json' = Join-Path $EvidenceDirectory 'security\signature-report.json'
    'evidence/security/github-artifacts-attestation.json' = Join-Path $EvidenceDirectory 'security\github-artifacts-attestation.json'
    'evidence/security/github-manifest-attestation.json' = Join-Path $EvidenceDirectory 'security\github-manifest-attestation.json'
    'evidence/security/trusted_root.jsonl' = Join-Path $EvidenceDirectory 'security\trusted_root.jsonl'
    'evidence/supply-chain/sbom.cdx.json' = Join-Path $EvidenceDirectory 'supply-chain\sbom.cdx.json'
    'evidence/supply-chain/build-provenance.json' = Join-Path $EvidenceDirectory 'supply-chain\build-provenance.json'
    'evidence/supply-chain/dependency-audit.json' = Join-Path $EvidenceDirectory 'supply-chain\dependency-audit.json'
    'evidence/supply-chain/third-party-notices.txt' = Join-Path $EvidenceDirectory 'supply-chain\third-party-notices.txt'
    'evidence/supply-chain/staged-file-manifest.sha256' = Join-Path $EvidenceDirectory 'supply-chain\staged-file-manifest.sha256'
}

foreach ($entry in $copies.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
        throw "Release bundle input is missing: $($entry.Value)"
    }
    $sourceItem = Get-Item -LiteralPath $entry.Value -Force
    if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release bundle input must not be a reparse point: $($sourceItem.FullName)"
    }
    $destination = Join-Path $OutputDirectory ($entry.Key.Replace('/', '\'))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $sourceItem.FullName -Destination $destination
}

Write-Host "[phase5:release-bundle] Prepared exact clean-download bundle: $OutputDirectory"

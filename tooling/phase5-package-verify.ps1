[CmdletBinding()]
param(
    [Parameter()][string]$PackageDirectory,
    [Parameter()][string]$EvidenceDirectory,
    [Parameter()][string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $PackageDirectory) { $PackageDirectory = Join-Path $root 'artifacts\phase5\package\dist\win-unpacked' }
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $root 'artifacts\phase5\local\package-verify' }
$arguments = @(
    (Join-Path $root 'tooling\packaging\phase5-package-verify.mjs'),
    '--package-dir', $PackageDirectory,
    '--evidence-dir', $EvidenceDirectory
)
if ($InstallerPath) { $arguments += @('--installer', $InstallerPath) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Phase 5 package verification failed.' }

$product = Get-Content -LiteralPath (Join-Path $root 'resources\phase5\product-manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$appExecutable = Join-Path $PackageDirectory 'desktop-translate.exe'
$nativeHost = Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'
$appInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($appExecutable)
if ($appInfo.FileVersion -ne $product.windowsFileVersion) {
    throw "Packaged Electron FileVersion mismatch: '$($appInfo.FileVersion)'"
}
$nativeInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($nativeHost)
if ($nativeInfo.FileVersion -ne $product.windowsFileVersion -or $nativeInfo.ProductVersion -ne $product.canonicalVersion) {
    throw "Packaged Native VERSIONINFO mismatch: FileVersion='$($nativeInfo.FileVersion)', ProductVersion='$($nativeInfo.ProductVersion)'"
}
Write-Host '[phase5:package] Packaged Electron and Native VERSIONINFO PASS.'

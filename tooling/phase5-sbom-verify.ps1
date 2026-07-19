[CmdletBinding()]
param(
    [Parameter()][string]$StageDirectory,
    [Parameter()][string]$PackageDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $StageDirectory) { $StageDirectory = Join-Path $root 'apps\desktop\.vite\phase5-resources' }
$arguments = @(
    (Join-Path $root 'tooling\supply-chain\verify-phase5-supply-chain.mjs'),
    '--stage-dir', $StageDirectory
)
if ($PackageDirectory) { $arguments += @('--package-dir', $PackageDirectory) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Phase 5 SBOM/notices/checksum verification failed.' }

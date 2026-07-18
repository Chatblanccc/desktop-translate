[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$cppWinRtVersion = '3.0.260520.1'
$contractsVersion = '10.0.26100.8249'
$cppWinRtHash = 'D22E2E26133D63217AE26E91B1685FB024B03A508A78AF645F8347A3126C8435'
$contractsHash = '0E1C25793ED1265D49ED5846F1F9DD5A5A32FD44D3E9C16E74B7FDA018E5FBD8'

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha256.ComputeHash($stream)
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }

    return [System.BitConverter]::ToString($digest).Replace('-', '')
}

function Get-PinnedPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Hash
    )
    $lowerId = $Id.ToLowerInvariant()
    $package = Join-Path $tools "$lowerId.$Version.nupkg"
    if (-not (Test-Path -LiteralPath $package)) {
        New-Item -ItemType Directory -Path $tools -Force | Out-Null
        $uri = "https://api.nuget.org/v3-flatcontainer/$lowerId/$Version/$lowerId.$Version.nupkg"
        Invoke-WebRequest -Uri $uri -OutFile $package
    }
    $actual = Get-Sha256Hex -Path $package
    if ($actual -ne $Hash) {
        throw "Pinned package hash mismatch: $Id $Version"
    }
    return $package
}

$cppWinRtPackage = Get-PinnedPackage `
    -Id 'Microsoft.Windows.CppWinRT' -Version $cppWinRtVersion -Hash $cppWinRtHash
$contractsPackage = Get-PinnedPackage `
    -Id 'Microsoft.Windows.SDK.Contracts' -Version $contractsVersion -Hash $contractsHash

$cppWinRtRoot = Join-Path $tools "cppwinrt-$cppWinRtVersion"
$cppWinRtExe = Join-Path $cppWinRtRoot 'bin\cppwinrt.exe'
if (-not (Test-Path -LiteralPath $cppWinRtExe)) {
    New-Item -ItemType Directory -Path $cppWinRtRoot -Force | Out-Null
    & tar -xf $cppWinRtPackage -C $cppWinRtRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract Microsoft.Windows.CppWinRT.' }
}

$contractsRoot = Join-Path $tools "windows-sdk-contracts-$contractsVersion"
$contractsInput = Join-Path $contractsRoot 'ref\netstandard2.0'
if (-not (Test-Path -LiteralPath $contractsInput)) {
    New-Item -ItemType Directory -Path $contractsRoot -Force | Out-Null
    & tar -xf $contractsPackage -C $contractsRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract Microsoft.Windows.SDK.Contracts.' }
}

$generated = Join-Path $tools "cppwinrt-generated-$contractsVersion"
$ocrHeader = Join-Path $generated 'winrt\Windows.Media.Ocr.h'
if (-not (Test-Path -LiteralPath $ocrHeader)) {
    New-Item -ItemType Directory -Path $generated -Force | Out-Null
    & $cppWinRtExe -input $contractsInput -output $generated
    if ($LASTEXITCODE -ne 0) { throw 'cppwinrt projection generation failed.' }
}

Write-Output $generated

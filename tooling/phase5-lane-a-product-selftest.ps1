[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-safe-filesystem.ps1')

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) `
    ('desktop-translate-phase5-lane-a-product-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
try {
    & node --test (Join-Path $PSScriptRoot 'phase5-lane-a-product-policy.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Product Lane A policy tests failed.' }

    $outputRoot = Join-Path $temporaryRoot 'not-implemented'
    & (Join-Path $PSScriptRoot 'phase5-lane-a-product.ps1') `
        -DevelopmentSelfTest `
        -OutputRoot $outputRoot
    $summary = Get-Content -LiteralPath (Join-Path $outputRoot 'summary.json') -Raw -Encoding UTF8 |
        ConvertFrom-Json
    if ($summary.status -ne 'NOT_IMPLEMENTED_BLOCKER' -or $summary.acceptance -ne $false) {
        throw 'Product Lane A development preflight claimed acceptance.'
    }
    foreach ($requiredFalse in @(
        'productProcessExercised',
        'resourceGateExecuted',
        'residualProcessGateExecuted',
        'werGateExecuted',
        'privacyGateExecuted'
    )) {
        if ($summary.assertions.$requiredFalse -ne $false) {
            throw "Product Lane A preflight did not preserve false assertion: $requiredFalse"
        }
    }

    $preexistingRejected = $false
    try {
        & node (Join-Path $PSScriptRoot 'phase5-lane-a-product.mjs') `
            --development-selftest `
            --output-root $outputRoot 2>$null
    } catch {
        $preexistingRejected = $true
    }
    if (-not $preexistingRejected -and $LASTEXITCODE -eq 0) {
        throw 'Product Lane A accepted a pre-existing output root.'
    }
    Write-Host '[phase5:lane-a:product:selftest] policy and NOT_IMPLEMENTED fail-closed evidence PASS.'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Phase5DirectoryTree -Path $temporaryRoot -AllowedParent ([IO.Path]::GetTempPath())
    }
}

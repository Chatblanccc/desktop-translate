[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )

    Write-Host "[phase2] $Label"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        throw "External command did not provide an exit code: $FilePath $($ArgumentList -join ' ')"
    }
    if ($exitCode -ne 0) {
        throw "External command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

Push-Location $root
try {
    Invoke-CheckedExternal -Label 'Lint' -FilePath 'pnpm' -ArgumentList @('lint')
    Invoke-CheckedExternal -Label 'TypeScript typecheck' -FilePath 'pnpm' -ArgumentList @('typecheck')
    Invoke-CheckedExternal -Label 'Unit, component, and integration tests' -FilePath 'pnpm' -ArgumentList @('test')
    Invoke-CheckedExternal -Label 'Coverage thresholds' -FilePath 'pnpm' -ArgumentList @('test:coverage')
    Invoke-CheckedExternal -Label 'Production build' -FilePath 'pnpm' -ArgumentList @('build')
    Invoke-CheckedExternal -Label 'Electron end-to-end tests' -FilePath 'pnpm' -ArgumentList @('test:e2e')
    Invoke-CheckedExternal -Label 'Complete Phase 1 regression gate' -FilePath 'pnpm' -ArgumentList @('phase1:verify')
} finally {
    Pop-Location
}

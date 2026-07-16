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

    Write-Host "[phase3] $Label"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "External command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

Push-Location $root
try {
    Invoke-CheckedExternal -Label 'Lint' -FilePath 'pnpm' -ArgumentList @('lint')
    Invoke-CheckedExternal -Label 'TypeScript typecheck' -FilePath 'pnpm' -ArgumentList @('typecheck')
    Invoke-CheckedExternal -Label 'Unit, component, contract, and integration tests' -FilePath 'pnpm' -ArgumentList @('test')
    Invoke-CheckedExternal -Label 'Coverage thresholds' -FilePath 'pnpm' -ArgumentList @('test:coverage')
    Invoke-CheckedExternal -Label 'Production build' -FilePath 'pnpm' -ArgumentList @('build')
    Invoke-CheckedExternal -Label 'Configure Native Host with pinned WinRT tooling' -FilePath 'pnpm' -ArgumentList @('native:configure')
    Invoke-CheckedExternal -Label 'Build Native Host' -FilePath 'pnpm' -ArgumentList @('native:build')
    Invoke-CheckedExternal -Label 'Native core, Windows OCR, and Hook tests' -FilePath 'pnpm' -ArgumentList @('native:test')
    Invoke-CheckedExternal -Label 'Phase 1 Named Pipe regression smoke' -FilePath 'pnpm' -ArgumentList @('phase1:smoke')
    Invoke-CheckedExternal -Label 'Phase 2 Electron shell regression smoke' -FilePath 'pnpm' -ArgumentList @('phase2:smoke')
    Invoke-CheckedExternal -Label 'Phase 3 real Host start/health/stop smoke' -FilePath 'pnpm' -ArgumentList @('phase3:smoke')
    Invoke-CheckedExternal -Label 'Electron end-to-end tests' -FilePath 'pnpm' -ArgumentList @('test:e2e')
} finally {
    Pop-Location
}

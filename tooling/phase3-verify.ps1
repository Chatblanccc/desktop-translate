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

$originalSelectionHostPath = [Environment]::GetEnvironmentVariable(
    'SELECTION_HOST_PATH',
    [EnvironmentVariableTarget]::Process
)

Push-Location $root
try {
    Invoke-CheckedExternal -Label 'Lint' -FilePath 'pnpm' -ArgumentList @('lint')
    Invoke-CheckedExternal -Label 'TypeScript typecheck' -FilePath 'pnpm' -ArgumentList @('typecheck')
    Invoke-CheckedExternal -Label 'Unit, component, contract, and integration tests' -FilePath 'pnpm' -ArgumentList @('test')
    Invoke-CheckedExternal -Label 'Coverage thresholds' -FilePath 'pnpm' -ArgumentList @('test:coverage')
    Invoke-CheckedExternal -Label 'Production build' -FilePath 'pnpm' -ArgumentList @('build')
    Write-Host '[phase3] Configure Native Host with pinned WinRT tooling'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Configure
    Write-Host '[phase3] Build Native Host'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Build -SetSelectionHostPath
    Write-Host '[phase3] Native core, Windows OCR, and Hook tests'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Test
    Invoke-CheckedExternal -Label 'Phase 1 Named Pipe regression smoke' -FilePath 'pnpm' -ArgumentList @('phase1:smoke')
    Invoke-CheckedExternal -Label 'Phase 2 Electron shell regression smoke' -FilePath 'pnpm' -ArgumentList @('phase2:smoke')
    Invoke-CheckedExternal -Label 'Phase 3 real Host start/health/stop smoke' -FilePath 'pnpm' -ArgumentList @('phase3:smoke')
    Invoke-CheckedExternal -Label 'Electron end-to-end tests' -FilePath 'pnpm' -ArgumentList @('test:e2e')
} finally {
    if ($null -eq $originalSelectionHostPath) {
        Remove-Item Env:SELECTION_HOST_PATH -ErrorAction SilentlyContinue
    } else {
        $env:SELECTION_HOST_PATH = $originalSelectionHostPath
    }
    Pop-Location
}

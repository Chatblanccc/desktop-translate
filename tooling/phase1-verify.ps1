[CmdletBinding()]
param(
    [switch]$SkipNative
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "External command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

$originalSelectionHostPath = [Environment]::GetEnvironmentVariable(
    'SELECTION_HOST_PATH',
    [EnvironmentVariableTarget]::Process
)

Push-Location $root
try {
    Write-Host '[phase1] TypeScript typecheck'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('typecheck')

    Write-Host '[phase1] TypeScript and contract tests'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('test')

    Write-Host '[phase1] Electron main and preload production build'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('build')

    if ($SkipNative) {
        Write-Warning '[phase1] Native verification explicitly skipped.'
        exit 0
    }

    Write-Host '[phase1] Configure Native Host'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Configure
    Write-Host '[phase1] Build Native Host'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Build -SetSelectionHostPath
    Write-Host '[phase1] Run Native Host tests'
    & (Join-Path $PSScriptRoot 'native-phase1.ps1') -Action Test
    Write-Host '[phase1] Run live Named Pipe handshake'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('phase1:smoke')
} finally {
    if ($null -eq $originalSelectionHostPath) {
        Remove-Item Env:SELECTION_HOST_PATH -ErrorAction SilentlyContinue
    } else {
        $env:SELECTION_HOST_PATH = $originalSelectionHostPath
    }
    Pop-Location
}

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

    $portableLlvm = Get-ChildItem -LiteralPath (Join-Path $root '.tools') -Directory `
        -Filter 'llvm-mingw-*-ucrt-x86_64' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($portableLlvm) {
        $env:PATH = "$(Join-Path $portableLlvm.FullName 'bin');$env:PATH"
    }

    Write-Host '[phase1] Configure Native Host'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('native:configure')
    Write-Host '[phase1] Build Native Host'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('native:build')
    Write-Host '[phase1] Run Native Host tests'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('native:test')
    Write-Host '[phase1] Run live Named Pipe handshake'
    Invoke-CheckedExternal -FilePath 'pnpm' -ArgumentList @('phase1:smoke')
} finally {
    Pop-Location
}

[CmdletBinding()]
param(
    [switch]$PrepareOnly,
    [switch]$ForceNativeBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )

    Write-Host "[phase4:start] $Label"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "External command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Resolve-NativeHost {
    param(
        [switch]$IgnoreConfigured
    )

    $configured = if ($null -eq $env:SELECTION_HOST_PATH) {
        $null
    } else {
        $env:SELECTION_HOST_PATH.Trim()
    }
    if (-not $IgnoreConfigured -and $configured) {
        if (-not (Test-Path -LiteralPath $configured -PathType Leaf)) {
            throw "SELECTION_HOST_PATH does not point to a file: $configured"
        }
        return (Resolve-Path -LiteralPath $configured).Path
    }

    $candidates = @(
        (Join-Path $root 'native\out\build\windows-x64-llvm-mingw\selection-host\selection-host.exe'),
        (Join-Path $root 'native\out\build\windows-x64-msvc\selection-host\Release\selection-host.exe'),
        (Join-Path $root 'native\out\build\llvm-mingw-release\selection-host\selection-host.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

Push-Location $root
try {
    $nativeHost = Resolve-NativeHost -IgnoreConfigured:$ForceNativeBuild
    if ($ForceNativeBuild -or -not $nativeHost) {
        $nativeScript = Join-Path $PSScriptRoot 'native-phase1.ps1'
        Write-Host '[phase4:start] Configure Native Host'
        & $nativeScript -Action Configure
        Write-Host '[phase4:start] Build Native Host'
        & $nativeScript -Action Build -SetSelectionHostPath
        $nativeHost = Resolve-NativeHost
    }

    if (-not $nativeHost) {
        throw 'Native Host build completed without producing selection-host.exe in a supported output path.'
    }

    $env:SELECTION_HOST_PATH = $nativeHost
    Write-Host "[phase4:start] Native Host: $nativeHost"

    if ($PrepareOnly) {
        Write-Output $nativeHost
    } else {
        Invoke-CheckedExternal -Label 'Build and start Electron' -FilePath 'pnpm' `
            -ArgumentList @('--filter', '@desktop-translate/desktop', 'start:phase4')
    }
} finally {
    Pop-Location
}

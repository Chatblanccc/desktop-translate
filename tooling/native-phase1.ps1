[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Configure', 'Build', 'Test')]
    [string]$Action,
    [switch]$SetSelectionHostPath
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

function Test-CMakeVersion {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    try {
        $output = (& $FilePath --version 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) { return $false }
        $match = [regex]::Match($output, '(?im)^cmake version\s+(\d+(?:\.\d+){1,3})')
        return $match.Success -and [version]$match.Groups[1].Value -ge [version]'3.24.0'
    } catch {
        return $false
    }
}

function Resolve-CMake {
    $candidates = @()
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }

    $candidates += Join-Path $root '.tools\cmake\PFiles64\CMake\bin\cmake.exe'
    $tools = Join-Path $root '.tools'
    if (Test-Path -LiteralPath $tools -PathType Container) {
        $portableRoots = Get-ChildItem -LiteralPath $tools -Directory -Filter 'cmake-portable-*' `
            -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($portableRoot in $portableRoots) {
            foreach ($distribution in Get-ChildItem -LiteralPath $portableRoot.FullName -Directory `
                -ErrorAction SilentlyContinue) {
                $candidates += Join-Path $distribution.FullName 'bin\cmake.exe'
            }
        }
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-CMakeVersion $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'CMake >= 3.24 is required for Phase 1 native verification.'
}

function Find-MsvcInstallation {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
    $installation = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) { return $null }
    return $installation | Select-Object -First 1
}

function Find-PortableLlvmMingw {
    $tools = Join-Path $root '.tools'
    if (-not (Test-Path -LiteralPath $tools)) { return $null }
    return Get-ChildItem -LiteralPath $tools -Directory -Filter 'llvm-mingw-*-ucrt-x86_64' `
        -ErrorAction SilentlyContinue | Where-Object {
            (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\x86_64-w64-mingw32-clang++.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\x86_64-w64-mingw32-windres.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\mingw32-make.exe') -PathType Leaf)
        } | Sort-Object Name -Descending | Select-Object -First 1
}

$cmake = Resolve-CMake
$msvc = Find-MsvcInstallation
$portable = Find-PortableLlvmMingw
$source = Join-Path $root 'native'
$cppWinRtInclude = (& (Join-Path $PSScriptRoot 'prepare-winrt.ps1') | Select-Object -Last 1)
$cppWinRtIncludeCmake = $cppWinRtInclude.Replace('\', '/')

if ($portable) {
    $toolRoot = $portable.FullName
    $toolRootCmake = $toolRoot.Replace('\', '/')
    $env:PATH = "$(Join-Path $toolRoot 'bin');$env:PATH"
    $build = Join-Path $source 'out\build\windows-x64-llvm-mingw'
    $configureArguments = @(
        '--fresh', '-S', $source, '-B', $build,
        '-G', 'MinGW Makefiles', '-DCMAKE_BUILD_TYPE=Release',
        "-DCMAKE_CXX_COMPILER=$toolRootCmake/bin/x86_64-w64-mingw32-clang++.exe",
        "-DCMAKE_RC_COMPILER=$toolRootCmake/bin/x86_64-w64-mingw32-windres.exe",
        "-DCMAKE_MAKE_PROGRAM=$toolRootCmake/bin/mingw32-make.exe",
        '-DDT_NATIVE_BUILD_TESTS=ON', '-DDT_NATIVE_ENABLE_PADDLE_OCR=OFF',
        '-DDT_NATIVE_ENABLE_WINDOWS_OCR=ON', "-DDT_CPPWINRT_INCLUDE_DIR=$cppWinRtIncludeCmake"
    )
    $buildArguments = @('--build', $build, '--parallel')
    $selectionHost = Join-Path $build 'selection-host\selection-host.exe'
    Write-Host "[native] Toolchain: portable llvm-mingw at $toolRoot"
} elseif ($msvc) {
    $build = Join-Path $source 'out\build\windows-x64-msvc'
    $configureArguments = @(
        '--fresh', '-S', $source, '-B', $build,
        '-G', 'Visual Studio 17 2022', '-A', 'x64',
        '-DDT_NATIVE_BUILD_TESTS=ON', '-DDT_NATIVE_ENABLE_PADDLE_OCR=OFF',
        '-DDT_NATIVE_ENABLE_WINDOWS_OCR=ON', "-DDT_CPPWINRT_INCLUDE_DIR=$cppWinRtIncludeCmake"
    )
    $buildArguments = @('--build', $build, '--config', 'Release', '--parallel')
    $selectionHost = Join-Path $build 'selection-host\Release\selection-host.exe'
    Write-Host "[native] Toolchain: MSVC at $msvc"
} else {
    throw 'No supported Windows C++ toolchain found. Install Visual Studio 2022 Build Tools with the x64 C++ workload.'
}

switch ($Action) {
    'Configure' {
        Invoke-CheckedExternal -FilePath $cmake -ArgumentList $configureArguments
    }
    'Build' {
        Invoke-CheckedExternal -FilePath $cmake -ArgumentList $buildArguments
    }
    'Test' {
        $ctest = Join-Path (Split-Path -Parent $cmake) 'ctest.exe'
        if (-not (Test-Path -LiteralPath $ctest)) {
            $ctestCommand = Get-Command ctest -ErrorAction SilentlyContinue
            if (-not $ctestCommand) { throw 'ctest is required for Phase 1 native verification.' }
            $ctest = $ctestCommand.Source
        }
        Invoke-CheckedExternal -FilePath $ctest -ArgumentList @(
            '--test-dir', $build, '-C', 'Release', '--output-on-failure'
        )
    }
}

if ($SetSelectionHostPath) {
    if ($Action -ne 'Build') {
        throw 'SetSelectionHostPath is valid only for the Build action.'
    }
    if (-not (Test-Path -LiteralPath $selectionHost -PathType Leaf)) {
        throw "Native build completed without producing selection-host.exe: $selectionHost"
    }
    $env:SELECTION_HOST_PATH = (Resolve-Path -LiteralPath $selectionHost).Path
    Write-Host "[native] Selected Host: $env:SELECTION_HOST_PATH"
}

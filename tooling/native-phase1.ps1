[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Configure', 'Build', 'Test')]
    [string]$Action
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

function Resolve-CMake {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $portable = Join-Path $root '.tools\cmake\PFiles64\CMake\bin\cmake.exe'
    if (Test-Path -LiteralPath $portable) { return $portable }
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
        -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
}

$cmake = Resolve-CMake
$msvc = Find-MsvcInstallation
$portable = Find-PortableLlvmMingw
$source = Join-Path $root 'native'

if ($msvc) {
    $build = Join-Path $source 'out\build\windows-x64-msvc'
    $configureArguments = @(
        '--fresh', '-S', $source, '-B', $build,
        '-G', 'Visual Studio 17 2022', '-A', 'x64',
        '-DDT_NATIVE_BUILD_TESTS=ON', '-DDT_NATIVE_ENABLE_PADDLE_OCR=OFF'
    )
    $buildArguments = @('--build', $build, '--config', 'Release', '--parallel')
    Write-Host "[native] Toolchain: MSVC at $msvc"
} elseif ($portable) {
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
        '-DDT_NATIVE_BUILD_TESTS=ON', '-DDT_NATIVE_ENABLE_PADDLE_OCR=OFF'
    )
    $buildArguments = @('--build', $build, '--parallel')
    Write-Host "[native] Toolchain: portable llvm-mingw at $toolRoot"
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

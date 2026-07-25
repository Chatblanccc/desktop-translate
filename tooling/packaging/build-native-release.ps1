[CmdletBinding()]
param(
    [Parameter()][string]$BuildDirectory,
    [Parameter()][switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nativeRoot = Join-Path $root 'native'
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')
if (-not $BuildDirectory) {
    $BuildDirectory = Join-Path $nativeRoot 'out\build\phase5-windows-x64-msvc-nmake-release'
}
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
Assert-Phase5NoReparsePoint -Path $BuildDirectory -AllowedParent $nativeRoot

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
    $candidates = @()
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $candidates += Join-Path $root '.tools\cmake\PFiles64\CMake\bin\cmake.exe'
    $tools = Join-Path $root '.tools'
    if (Test-Path -LiteralPath $tools -PathType Container) {
        foreach ($candidateRoot in Get-ChildItem -LiteralPath $tools -Directory -Filter 'cmake-portable-*' -ErrorAction SilentlyContinue) {
            foreach ($distribution in Get-ChildItem -LiteralPath $candidateRoot.FullName -Directory -ErrorAction SilentlyContinue) {
                $candidates += Join-Path $distribution.FullName 'bin\cmake.exe'
            }
        }
    }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'CMake >= 3.24 is required for the Phase 5 release Native build.'
}

function Find-MsvcInstallation {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw 'vswhere.exe was not found; Visual Studio 2022 Build Tools are required for the Phase 5 release Native build.'
    }
    $installation = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) {
        throw 'Visual Studio 2022 with the x64 C++ toolchain was not found.'
    }
    return [string]($installation | Select-Object -First 1)
}

function Find-DumpBin {
    param([Parameter(Mandatory = $true)][string]$Installation)
    $toolsRoot = Join-Path $Installation 'VC\Tools\MSVC'
    $candidates = @(Get-ChildItem -LiteralPath $toolsRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending)
    foreach ($candidate in $candidates) {
        $path = Join-Path $candidate.FullName 'bin\Hostx64\x64\dumpbin.exe'
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    throw 'dumpbin.exe was not found in the selected MSVC toolchain.'
}

function Import-MsvcEnvironment {
    param([Parameter(Mandatory = $true)][string]$Installation)
    $vsDevCmd = Join-Path $Installation 'Common7\Tools\VsDevCmd.bat'
    if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
        throw "VsDevCmd.bat was not found: $vsDevCmd"
    }
    $command = 'call "' + $vsDevCmd + '" -no_logo -arch=x64 -host_arch=x64 && set'
    $lines = & $env:ComSpec /d /s /c $command
    if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize the MSVC x64 build environment.' }
    $msvcPathLine = $lines | Where-Object {
        $_.StartsWith('PATH=', [StringComparison]::OrdinalIgnoreCase) -and
        $_.IndexOf('\VC\Tools\MSVC\', [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | Select-Object -First 1
    if (-not $msvcPathLine) {
        throw 'MSVC environment initialization did not return the developer command PATH.'
    }
    $msvcPath = $msvcPathLine.Substring($msvcPathLine.IndexOf('=') + 1)
    foreach ($line in $lines) {
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $name = $line.Substring(0, $separator)
        if ($name.Equals('PATH', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $value = $line.Substring($separator + 1)
        [Environment]::SetEnvironmentVariable($name, $value, [EnvironmentVariableTarget]::Process)
    }
    # The Codex Windows host can expose both `Path` and `PATH` entries. Child
    # processes may inherit the stale entry even though PowerShell command
    # discovery sees the updated one, so collapse the pair before launching
    # CMake/NMake.
    [Environment]::SetEnvironmentVariable(
        'Path',
        $null,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        'PATH',
        $null,
        [EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        'PATH',
        $msvcPath,
        [EnvironmentVariableTarget]::Process
    )
    foreach ($tool in @('cl.exe', 'nmake.exe', 'rc.exe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "MSVC environment initialization did not expose $tool."
        }
    }
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json + "`n", (New-Object Text.UTF8Encoding($false)))
}

$cmake = Resolve-CMake
$msvcInstallation = Find-MsvcInstallation
$dumpbin = Find-DumpBin -Installation $msvcInstallation
$hostPath = Join-Path $BuildDirectory 'selection-host\selection-host.exe'
Import-MsvcEnvironment -Installation $msvcInstallation

if (-not $SkipBuild) {
    $cppWinRtInclude = (& (Join-Path $root 'tooling\prepare-winrt.ps1') | Select-Object -Last 1)
    if (-not $cppWinRtInclude -or -not (Test-Path -LiteralPath $cppWinRtInclude -PathType Container)) {
        throw 'C++/WinRT projection preparation did not return a usable include directory.'
    }
    $cppWinRtCmake = ([string]$cppWinRtInclude).Replace('\', '/')
    Invoke-CheckedExternal -FilePath $cmake -ArgumentList @(
        '--fresh', '-S', $nativeRoot, '-B', $BuildDirectory,
        '-G', 'NMake Makefiles', '-DCMAKE_BUILD_TYPE=Release',
        '-DDT_NATIVE_BUILD_TESTS=OFF',
        '-DDT_NATIVE_ENABLE_PADDLE_OCR=OFF',
        '-DDT_NATIVE_ENABLE_WINDOWS_OCR=ON',
        "-DDT_CPPWINRT_INCLUDE_DIR=$cppWinRtCmake"
    )
    Invoke-CheckedExternal -FilePath $cmake -ArgumentList @(
        '--build', $BuildDirectory, '--target', 'selection-host'
    )
}

if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
    throw "Phase 5 MSVC build did not produce selection-host.exe: $hostPath"
}

$versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($hostPath)
if ($versionInfo.FileVersion -ne '0.5.0.0' -or $versionInfo.ProductVersion -ne '0.5.0-phase5') {
    throw "Native VERSIONINFO mismatch: FileVersion='$($versionInfo.FileVersion)', ProductVersion='$($versionInfo.ProductVersion)'"
}
$binaryAscii = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($hostPath))
if (-not $binaryAscii.Contains('0.5.0-phase5')) {
    throw 'Native Host binary does not contain the CMake-supplied Phase 5 hello version.'
}

$flagFiles = @(Get-ChildItem -LiteralPath $BuildDirectory -Recurse -Filter 'flags.make' -File -ErrorAction SilentlyContinue)
$releaseFlags = ($flagFiles | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
if ($releaseFlags -notmatch '(?i)(^|\s)[/-]MT(\s|$)') {
    throw 'The generated Release compile flags do not contain the required /MT (-MT) runtime option.'
}

$dependencyOutput = (& $dumpbin /DEPENDENTS $hostPath 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'dumpbin /DEPENDENTS failed for selection-host.exe.' }
$dependencies = @(
    [regex]::Matches($dependencyOutput, '(?im)^\s+([A-Za-z0-9_.-]+\.dll)\s*$') |
        ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() } |
        Sort-Object -Unique
)
$dynamicCrt = @($dependencies | Where-Object { $_ -match '^(VCRUNTIME|MSVCP|CONCRT|UCRTBASE).*\.DLL$' })
if ($dynamicCrt.Count -ne 0) {
    throw "Release Native Host unexpectedly depends on dynamic MSVC/UCRT files: $($dynamicCrt -join ', ')"
}

$compilerVersion = 'unknown'
$compilerFiles = @(Get-ChildItem -LiteralPath (Join-Path $BuildDirectory 'CMakeFiles') -Recurse `
    -Filter 'CMakeCXXCompiler.cmake' -File -ErrorAction SilentlyContinue)
foreach ($compilerFile in $compilerFiles) {
    $match = [regex]::Match([IO.File]::ReadAllText($compilerFile.FullName), 'set\(CMAKE_CXX_COMPILER_VERSION "([^"]+)"\)')
    if ($match.Success) { $compilerVersion = $match.Groups[1].Value; break }
}
if ($compilerVersion -eq 'unknown') { throw 'Unable to determine the configured MSVC compiler version.' }

$hash = (Get-FileHash -LiteralPath $hostPath -Algorithm SHA256).Hash.ToLowerInvariant()
$metadataPath = Join-Path $BuildDirectory 'native-build-metadata.json'
Write-Utf8Json -Path $metadataPath -Value ([ordered]@{
    schemaVersion = 1
    productVersion = $versionInfo.ProductVersion
    fileVersion = $versionInfo.FileVersion
    architecture = 'x64'
    configuration = 'Release'
    toolchain = 'MSVC'
    compilerVersion = $compilerVersion
    runtimeLibrary = '/MT'
    runtimeEvidence = @(
        'CMake MSVC_RUNTIME_LIBRARY=MultiThreaded for Release',
        'generated flags.make contains MSVC /MT semantics (-MT)',
        'dumpbin dependency scan contains no VCRUNTIME/MSVCP/CONCRT/UCRTBASE DLL'
    )
    binarySha256 = $hash
    dependencies = $dependencies
})

Write-Host "[phase5:native] MSVC x64 Release /MT verified: $hostPath"
Write-Host "[phase5:native] Metadata: $metadataPath"
Write-Output $hostPath

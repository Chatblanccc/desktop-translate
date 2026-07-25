#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$gateLabel = '[phase7:installer-atomic-directory:selftest]'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$probeSource = Join-Path $PSScriptRoot 'phase7-nsis-atomic-directory-probe.nsi'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$runRootPrefix = 'desktop-translate-phase7-atomic-directory-gate-'
$probeRootPattern = 'desktop-translate-phase7-ntcreate-probe-*'

function Resolve-Phase7Makensis {
    $candidates = New-Object 'System.Collections.Generic.List[string]'

    if (-not [string]::IsNullOrWhiteSpace($env:MAKENSIS)) {
        [void]$candidates.Add($env:MAKENSIS.Trim().Trim('"'))
    }

    foreach ($relativePath in @(
            '.tools\nsis\makensis.exe',
            '.tools\nsis-3.0.4.1\makensis.exe',
            '.tools\nsis-3.0.4.1\Bin\makensis.exe'
        )) {
        [void]$candidates.Add((Join-Path $repositoryRoot $relativePath))
    }

    $repositoryToolRoot = Join-Path $repositoryRoot '.tools'
    if (Test-Path -LiteralPath $repositoryToolRoot -PathType Container) {
        foreach ($tool in @(Get-ChildItem -LiteralPath $repositoryToolRoot -Filter 'makensis.exe' `
                    -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            [void]$candidates.Add($tool.FullName)
        }
    }

    $pathCommand = Get-Command 'makensis.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $pathCommand) {
        [void]$candidates.Add($pathCommand.Source)
    }

    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis-3.0.4.1'
        [void]$candidates.Add((Join-Path $cacheRoot 'makensis.exe'))
        [void]$candidates.Add((Join-Path $cacheRoot 'Bin\makensis.exe'))
        if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
            foreach ($cacheDirectory in @(Get-ChildItem -LiteralPath $cacheRoot -Directory `
                        -ErrorAction SilentlyContinue | Sort-Object FullName)) {
                [void]$candidates.Add((Join-Path $cacheDirectory.FullName 'makensis.exe'))
                [void]$candidates.Add((Join-Path $cacheDirectory.FullName 'Bin\makensis.exe'))
            }
        }
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' `
        ([StringComparer]::OrdinalIgnoreCase)
    $diagnostics = New-Object 'System.Collections.Generic.List[string]'
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        try {
            $fullPath = [IO.Path]::GetFullPath($candidate)
        } catch {
            [void]$diagnostics.Add("invalid path: $candidate")
            continue
        }
        if (-not $seen.Add($fullPath)) {
            continue
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }

        try {
            $versionOutput = @(& $fullPath /VERSION 2>&1)
            $versionExitCode = $LASTEXITCODE
            $version = (($versionOutput | ForEach-Object { [string]$_ }).Trim() -join ' ').Trim()
            if ($versionExitCode -eq 0 -and $version -eq 'v3.04') {
                return [pscustomobject]@{
                    Found = $true
                    Path = $fullPath
                    Version = $version
                    Diagnostic = ''
                }
            }
            [void]$diagnostics.Add(
                "$fullPath reported '$version' with exit code $versionExitCode"
            )
        } catch {
            [void]$diagnostics.Add("$fullPath could not run: $($_.Exception.Message)")
        }
    }

    $diagnostic = if ($diagnostics.Count -eq 0) {
        'no repository, PATH, or electron-builder cache candidate exists'
    } else {
        $diagnostics -join '; '
    }
    return [pscustomobject]@{
        Found = $false
        Path = ''
        Version = ''
        Diagnostic = $diagnostic
    }
}

function Test-Phase7ElevatedToken {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator
        )
    } finally {
        $identity.Dispose()
    }
}

function Get-Phase7ProbeTempEntries {
    return @(
        Get-ChildItem -LiteralPath $temporaryParent -Force -Filter $probeRootPattern `
            -ErrorAction Stop | ForEach-Object {
                [IO.Path]::GetFullPath($_.FullName)
            }
    )
}

function Assert-Phase7DirectTemporaryChild {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$LeafPrefix
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parent = [IO.Directory]::GetParent($fullPath)
    if ($null -eq $parent -or
        -not $parent.FullName.TrimEnd('\').Equals(
            $temporaryParent,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Temporary cleanup root escaped its exact parent: $fullPath"
    }
    $leaf = [IO.Path]::GetFileName($fullPath)
    if (-not $leaf.StartsWith($LeafPrefix, [StringComparison]::Ordinal) -or
        $leaf.Length -ne ($LeafPrefix.Length + 32)) {
        throw "Temporary cleanup root has an unexpected unique leaf: $fullPath"
    }
    return $fullPath
}

function Remove-Phase7TemporaryTreeNoFollow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$LeafPrefix
    )

    $verifiedRoot = Assert-Phase7DirectTemporaryChild -Path $Root -LeafPrefix $LeafPrefix
    if (-not (Test-Path -LiteralPath $verifiedRoot)) {
        return
    }

    $rootItem = Get-Item -LiteralPath $verifiedRoot -Force
    if (-not $rootItem.PSIsContainer -or
        (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Temporary cleanup refused a non-directory or reparse root: $verifiedRoot"
    }

    $pendingDirectories = New-Object 'System.Collections.Generic.List[string]'
    [void]$pendingDirectories.Add($verifiedRoot)
    for ($index = 0; $index -lt $pendingDirectories.Count; $index++) {
        $directory = $pendingDirectories[$index]
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $entryPath = [IO.Path]::GetFullPath($entry.FullName)
            $boundary = $verifiedRoot + '\'
            if (-not $entryPath.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Temporary cleanup entry escaped its exact root: $entryPath"
            }
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Temporary cleanup refused a reparse entry: $entryPath"
            }
            if ($entry.PSIsContainer) {
                [void]$pendingDirectories.Add($entryPath)
            } else {
                [IO.File]::SetAttributes($entryPath, [IO.FileAttributes]::Normal)
                [IO.File]::Delete($entryPath)
            }
        }
    }

    for ($index = $pendingDirectories.Count - 1; $index -ge 0; $index--) {
        [IO.Directory]::Delete($pendingDirectories[$index], $false)
    }
}

if (-not (Test-Path -LiteralPath $probeSource -PathType Leaf)) {
    Write-Host "$gateLabel FAIL: checked-in probe source is missing: $probeSource"
    exit 1
}

$makensis = Resolve-Phase7Makensis
if (-not $makensis.Found) {
    Write-Host "$gateLabel NOT RUN: cached/repository MakeNSIS v3.04 is unavailable; $($makensis.Diagnostic)"
    exit 2
}

if (Test-Phase7ElevatedToken) {
    Write-Host "$gateLabel NOT RUN: an elevated token cannot provide the required standard-user run."
    exit 2
}

$runLeaf = $runRootPrefix + [guid]::NewGuid().ToString('N')
$runRoot = Join-Path $temporaryParent $runLeaf
$probeExecutable = Join-Path $runRoot 'phase7-nsis-atomic-directory-probe.exe'
$exitCode = 1

try {
    $runRoot = Assert-Phase7DirectTemporaryChild -Path $runRoot -LeafPrefix $runRootPrefix
    [void][IO.Directory]::CreateDirectory($runRoot)
    $runRootItem = Get-Item -LiteralPath $runRoot -Force
    if (($runRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unique temporary compile root is a reparse point: $runRoot"
    }

    $leaksBefore = @(Get-Phase7ProbeTempEntries)
    if ($leaksBefore.Count -ne 0) {
        throw "Probe temp prefix was not clean before execution: $($leaksBefore -join ', ')"
    }

    $compilerOutput = @(
        & $makensis.Path /V3 /WX "/DPHASE7_PROBE_OUTFILE=$probeExecutable" `
            $probeSource 2>&1
    )
    $compilerExitCode = $LASTEXITCODE
    if ($compilerExitCode -ne 0) {
        $compilerDetail = ($compilerOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        throw "MakeNSIS failed with exit code $compilerExitCode.$([Environment]::NewLine)$compilerDetail"
    }
    if (-not (Test-Path -LiteralPath $probeExecutable -PathType Leaf)) {
        throw 'MakeNSIS returned success without the unique probe executable.'
    }

    $probeHash = (Get-FileHash -LiteralPath $probeExecutable -Algorithm SHA256).Hash
    $probeBytes = (Get-Item -LiteralPath $probeExecutable).Length

    $probeProcess = Start-Process -FilePath $probeExecutable -ArgumentList '/S' `
        -WindowStyle Hidden -PassThru
    if (-not $probeProcess.WaitForExit(30000)) {
        try {
            $probeProcess.Kill()
            $probeProcess.WaitForExit()
        } catch {
            Write-Host "$gateLabel cleanup warning: timed-out probe could not be stopped: $($_.Exception.Message)"
        }
        throw 'Compiled probe exceeded the 30-second runtime limit.'
    }
    $probeExitCode = $probeProcess.ExitCode
    $leaksAfter = @(Get-Phase7ProbeTempEntries)

    if ($probeExitCode -ne 0) {
        throw "Compiled standard-user probe failed with exit code $probeExitCode."
    }
    if ($leaksAfter.Count -ne 0) {
        throw "Compiled probe leaked its unique temp root: $($leaksAfter -join ', ')"
    }

    $result = [ordered]@{
        Status = 'PASS'
        Makensis = $makensis.Path
        MakensisVersion = $makensis.Version
        CurrentUserSidMutex = 'bounded-copy-roundtrip-and-global-acquire-release'
        ProbeSha256 = $probeHash
        ProbeBytes = $probeBytes
        ProbeExitCode = $probeExitCode
        ProbeTempLeakCount = $leaksAfter.Count
    }
    Write-Host "$gateLabel PASS"
    Write-Host ($result | ConvertTo-Json -Compress)
    $exitCode = 0
} catch {
    Write-Host "$gateLabel FAIL: $($_.Exception.Message)"
    $exitCode = 1
} finally {
    try {
        Remove-Phase7TemporaryTreeNoFollow -Root $runRoot -LeafPrefix $runRootPrefix
    } catch {
        Write-Host "$gateLabel FAIL: temporary cleanup failed: $($_.Exception.Message)"
        $exitCode = 1
    }
}

exit $exitCode

#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$gateLabel = '[phase7:installer-transaction-path:selftest]'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$installerIncludePath = Join-Path $repositoryRoot 'apps\desktop\build\installer.nsh'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$runLeafPrefix = 'desktop-translate-phase7-transaction-path-gate-'

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
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis-3.0.4.1'
        if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
            foreach ($tool in @(Get-ChildItem -LiteralPath $cacheRoot -Filter 'makensis.exe' `
                        -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)) {
                [void]$candidates.Add($tool.FullName)
            }
        }
    }
    $pathCommand = Get-Command 'makensis.exe' -CommandType Application `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pathCommand) {
        [void]$candidates.Add($pathCommand.Source)
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' `
        ([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        try {
            $fullPath = [IO.Path]::GetFullPath($candidate)
        } catch {
            continue
        }
        if (-not $seen.Add($fullPath) -or
            -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }
        $versionOutput = @(& $fullPath /VERSION 2>&1)
        $version = (($versionOutput | ForEach-Object { [string]$_ }).Trim() -join ' ').Trim()
        if ($LASTEXITCODE -eq 0 -and $version -eq 'v3.04') {
            return [pscustomobject]@{
                Found = $true
                Path = $fullPath
                Version = $version
            }
        }
    }
    return [pscustomobject]@{
        Found = $false
        Path = ''
        Version = ''
    }
}

function Assert-Phase7RunRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parent = [IO.Directory]::GetParent($fullPath)
    if ($null -eq $parent -or
        -not $parent.FullName.TrimEnd('\').Equals(
            $temporaryParent,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Temporary run root escaped its exact parent: $fullPath"
    }
    $leaf = [IO.Path]::GetFileName($fullPath)
    if (-not $leaf.StartsWith($runLeafPrefix, [StringComparison]::Ordinal) -or
        $leaf.Length -ne ($runLeafPrefix.Length + 32)) {
        throw "Temporary run root has an unexpected unique leaf: $fullPath"
    }
    return $fullPath
}

function Remove-Phase7RunRootNoFollow {
    param([Parameter(Mandatory = $true)][string]$Path)

    $verifiedRoot = Assert-Phase7RunRoot -Path $Path
    if (-not (Test-Path -LiteralPath $verifiedRoot)) {
        return
    }
    $rootItem = Get-Item -LiteralPath $verifiedRoot -Force
    if (-not $rootItem.PSIsContainer -or
        (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Temporary cleanup refused a non-directory or reparse root: $verifiedRoot"
    }

    $directories = New-Object 'System.Collections.Generic.List[string]'
    [void]$directories.Add($verifiedRoot)
    for ($index = 0; $index -lt $directories.Count; $index++) {
        $directory = $directories[$index]
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $entryPath = [IO.Path]::GetFullPath($entry.FullName)
            if (-not $entryPath.StartsWith(
                $verifiedRoot + '\',
                [StringComparison]::OrdinalIgnoreCase
            )) {
                throw "Temporary cleanup entry escaped its exact root: $entryPath"
            }
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Temporary cleanup refused a reparse entry: $entryPath"
            }
            if ($entry.PSIsContainer) {
                [void]$directories.Add($entryPath)
            } else {
                [IO.File]::SetAttributes($entryPath, [IO.FileAttributes]::Normal)
                [IO.File]::Delete($entryPath)
            }
        }
    }
    for ($index = $directories.Count - 1; $index -ge 0; $index--) {
        [IO.Directory]::Delete($directories[$index], $false)
    }
}

if (-not (Test-Path -LiteralPath $installerIncludePath -PathType Leaf)) {
    Write-Host "$gateLabel FAIL: installer include is missing: $installerIncludePath"
    exit 1
}

$makensis = Resolve-Phase7Makensis
if (-not $makensis.Found) {
    Write-Host "$gateLabel NOT RUN: MakeNSIS v3.04 is unavailable."
    exit 2
}

$includeContent = [IO.File]::ReadAllText($installerIncludePath)
$validatorPattern = '(?ms)^!macro phase7ValidateUninstallTransactionPaths\r?\n.*?^!macroend[ \t]*$'
$validatorMatches = [regex]::Matches($includeContent, $validatorPattern)
if ($validatorMatches.Count -ne 1) {
    Write-Host "$gateLabel FAIL: expected exactly one transaction-path validator macro."
    exit 1
}
$validatorMacro = $validatorMatches[0].Value

$probeTemplate = @'
Unicode true

!pragma warning error all
!include LogicLib.nsh
!include FileFunc.nsh

!ifndef PHASE7_PROBE_OUTFILE
  !error "PHASE7_PROBE_OUTFILE is required."
!endif

!define APP_FILENAME "desktop-translate"
!define PHASE7_STAGE_PREFIX ".desktop-translate-stage-5baab977-0efe-5c82-9f9c-b3786aa388e3"
!define PHASE7_PROBE_STAGE_LEAF "${PHASE7_STAGE_PREFIX}-123-456"

Name "Desktop Translate Phase 7 Transaction Path Probe"
OutFile "${PHASE7_PROBE_OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow

Var phase7TransactionSource
Var phase7TransactionStage
Var probeResult
Var probeParent
Var otherParent

!macro phase7Fail MESSAGE
  StrCpy $probeResult "invalid"
!macroend

__PHASE7_VALIDATOR_MACRO__

!macro phase7Expect EXPECTED SOURCE STAGE EXIT_CODE
  StrCpy $phase7TransactionSource "${SOURCE}"
  StrCpy $phase7TransactionStage "${STAGE}"
  StrCpy $probeResult "valid"
  !insertmacro phase7ValidateUninstallTransactionPaths
  ${If} $probeResult != "${EXPECTED}"
    SetErrorLevel ${EXIT_CODE}
    Quit
  ${EndIf}
!macroend

Section
  SetErrorLevel 99
  StrCpy $probeParent "$EXEDIR\cases"
  StrCpy $otherParent "$EXEDIR\other"
  CreateDirectory "$probeParent"
  CreateDirectory "$otherParent"
  CreateDirectory "$probeParent\child"
  CreateDirectory "$probeParent\${APP_FILENAME}"

  # prepared: source exists and the random stage does not exist yet.
  !insertmacro phase7Expect "valid" "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 10

  # staged and recovery: source is absent while stage exists.
  ClearErrors
  Rename "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}"
  ${If} ${Errors}
    SetErrorLevel 11
    Quit
  ${EndIf}
  !insertmacro phase7Expect "valid" "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 12

  # committed cleanup: both transaction roots can be absent while the parent remains.
  RMDir "$probeParent\${PHASE7_PROBE_STAGE_LEAF}"
  !insertmacro phase7Expect "valid" "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 13

  !insertmacro phase7Expect "invalid" "" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 20
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "" 21
  !insertmacro phase7Expect "invalid" "$probeParent\wrong-leaf" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 22
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "$probeParent\wrong-stage-123" 23
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_STAGE_PREFIX}-" 24
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "$otherParent\${PHASE7_PROBE_STAGE_LEAF}" 25
  !insertmacro phase7Expect "invalid" "$probeParent\child\..\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 26
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}\" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 27
  !insertmacro phase7Expect "invalid" "$probeParent\\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}" 28
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "$probeParent\${PHASE7_PROBE_STAGE_LEAF}\" 29
  !insertmacro phase7Expect "invalid" "$probeParent\${APP_FILENAME}" "$probeParent\child\..\${PHASE7_PROBE_STAGE_LEAF}" 30

  # FileFunc returns "C:" for a direct child of C:\. The validator must
  # restore exactly one separator before canonicalizing and rebuilding. Put
  # the process on a non-root output path first so a regression to bare "C:"
  # cannot accidentally resolve against the drive root.
  SetOutPath "$EXEDIR"
  ${GetRoot} "$EXEDIR" $R8
  StrCpy $R8 "$R8\"
  StrCpy $R7 "$R8${APP_FILENAME}"
  StrCpy $R6 "$R8${PHASE7_PROBE_STAGE_LEAF}"
  !insertmacro phase7Expect "valid" "$R7" "$R6" 35

  RMDir "$probeParent\child"
  RMDir "$probeParent"
  RMDir "$otherParent"
  SetErrorLevel 0
SectionEnd
'@

$probeSourceContent = $probeTemplate.Replace(
    '__PHASE7_VALIDATOR_MACRO__',
    $validatorMacro
)
$runLeaf = $runLeafPrefix + [guid]::NewGuid().ToString('N')
$runRoot = Assert-Phase7RunRoot -Path (Join-Path $temporaryParent $runLeaf)
$probeSourcePath = Join-Path $runRoot 'phase7-transaction-path-probe.nsi'
$probeExecutablePath = Join-Path $runRoot 'phase7-transaction-path-probe.exe'
$exitCode = 1

try {
    [void][IO.Directory]::CreateDirectory($runRoot)
    $runRootItem = Get-Item -LiteralPath $runRoot -Force
    if (($runRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unique temporary compile root is a reparse point: $runRoot"
    }
    [IO.File]::WriteAllText(
        $probeSourcePath,
        $probeSourceContent,
        (New-Object Text.UTF8Encoding($false))
    )

    $compilerOutput = @(
        & $makensis.Path /V3 /WX "/DPHASE7_PROBE_OUTFILE=$probeExecutablePath" `
            $probeSourcePath 2>&1
    )
    if ($LASTEXITCODE -ne 0) {
        $compilerDetail = ($compilerOutput | ForEach-Object { [string]$_ }) `
            -join [Environment]::NewLine
        throw "MakeNSIS failed.$([Environment]::NewLine)$compilerDetail"
    }

    $probeHash = (Get-FileHash -LiteralPath $probeExecutablePath -Algorithm SHA256).Hash
    $probeBytes = (Get-Item -LiteralPath $probeExecutablePath).Length
    $process = Start-Process -FilePath $probeExecutablePath -ArgumentList '/S' `
        -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(30000)) {
        try {
            $process.Kill()
            $process.WaitForExit()
        } catch {
            Write-Host "$gateLabel cleanup warning: timed-out probe could not be stopped."
        }
        throw 'Compiled transaction-path probe exceeded the 30-second limit.'
    }
    if ($process.ExitCode -ne 0) {
        throw "Compiled transaction-path probe failed with exit code $($process.ExitCode)."
    }

    $result = [ordered]@{
        Status = 'PASS'
        Makensis = $makensis.Path
        MakensisVersion = $makensis.Version
        ValidatorSource = 'exact-macro-extracted-from-installer.nsh'
        ValidStateCount = 4
        RejectedStateCount = 11
        ProbeSha256 = $probeHash
        ProbeBytes = $probeBytes
        ProbeExitCode = $process.ExitCode
    }
    Write-Host "$gateLabel PASS"
    Write-Host ($result | ConvertTo-Json -Compress)
    $exitCode = 0
} catch {
    Write-Host "$gateLabel FAIL: $($_.Exception.Message)"
    $exitCode = 1
} finally {
    try {
        Remove-Phase7RunRootNoFollow -Path $runRoot
    } catch {
        Write-Host "$gateLabel FAIL: temporary cleanup failed: $($_.Exception.Message)"
        $exitCode = 1
    }
}

exit $exitCode

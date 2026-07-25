[CmdletBinding()]
param(
  [string]$ManifestPath,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ManifestPath) {
  $ManifestPath = Join-Path $PSScriptRoot 'candidates.json'
}

function Add-Blocker {
  param(
    [System.Collections.Generic.List[object]]$Target,
    [string]$Code,
    [string]$Detail
  )

  $Target.Add([pscustomobject]@{
    code = $Code
    detail = $Detail
  })
}

function Get-PythonPackageVersion {
  param(
    [string]$Python,
    [string]$Distribution
  )

  $script = @'
import importlib.metadata
import sys
try:
    print(importlib.metadata.version(sys.argv[1]))
except importlib.metadata.PackageNotFoundError:
    print(sys.argv[2])
'@
  $value = & $Python -c $script $Distribution 'PHASE7_PACKAGE_NOT_FOUND'
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  $first = $value | Select-Object -First 1
  if ($null -eq $first -or $first -eq 'PHASE7_PACKAGE_NOT_FOUND' -or [string]::IsNullOrWhiteSpace($first)) {
    return $null
  }
  return $first.Trim()
}

function Assert-SafeOutputPath {
  param(
    [string]$CandidatePath,
    [string]$AllowedRoot
  )

  $fullPath = [System.IO.Path]::GetFullPath($CandidatePath)
  $fullRoot = [System.IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OUTPUT_MUST_BE_CHILD_OF_PHASE7_ARTIFACT_ROOT'
  }
  $current = Split-Path -Parent $fullPath
  while ($current -and $current.StartsWith($fullRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'ARTIFACT_PATH_REPARSE_POINT_REJECTED'
      }
    }
    if ($current.TrimEnd('\') -eq $fullRoot.TrimEnd('\')) {
      break
    }
    $current = Split-Path -Parent $current
  }
  return $fullPath
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$artifactRoot = Join-Path $repoRoot 'artifacts\phase7\offline-poc'
$blockers = [System.Collections.Generic.List[object]]::new()

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
$clCommand = Get-Command cl -ErrorAction SilentlyContinue

$pythonVersion = $null
if ($null -eq $pythonCommand) {
  Add-Blocker -Target $blockers -Code 'PYTHON_NOT_FOUND' -Detail 'Python is required for conversion and benchmarking.'
} else {
  $pythonVersion = (& $pythonCommand.Source -c 'import platform; print(platform.python_version())').Trim()
  if (-not $pythonVersion.StartsWith('3.13.')) {
    Add-Blocker -Target $blockers -Code 'PYTHON_ABI_MISMATCH' -Detail 'The frozen Windows wheel set targets CPython 3.13.'
  }
}

$expectedPackages = @(
  [pscustomobject]@{ id = $manifest.runtime.id; version = $manifest.runtime.version }
)
foreach ($tool in $manifest.toolchain) {
  $expectedPackages += [pscustomobject]@{ id = $tool.id; version = $tool.version }
}

$packageChecks = @()
foreach ($package in $expectedPackages) {
  $installedVersion = $null
  if ($null -ne $pythonCommand) {
    $installedVersion = Get-PythonPackageVersion -Python $pythonCommand.Source -Distribution $package.id
  }
  $matches = $installedVersion -eq $package.version
  $packageChecks += [pscustomobject]@{
    id = $package.id
    expectedVersion = $package.version
    installedVersion = $installedVersion
    matches = $matches
  }
  if ($null -eq $installedVersion) {
    Add-Blocker -Target $blockers -Code ('PYTHON_PACKAGE_MISSING_' + $package.id.ToUpperInvariant().Replace('-', '_')) -Detail ('Missing frozen package: ' + $package.id + '.')
  } elseif (-not $matches) {
    Add-Blocker -Target $blockers -Code ('PYTHON_PACKAGE_VERSION_MISMATCH_' + $package.id.ToUpperInvariant().Replace('-', '_')) -Detail ('Installed version does not match the frozen POC version for ' + $package.id + '.')
  }
}

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$computer = Get-CimInstance Win32_ComputerSystem

if ($null -eq ('Phase7ProcessorFeatures' -as [type])) {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class Phase7ProcessorFeatures {
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsProcessorFeaturePresent(uint feature);
}
'@
}

$avx = [Phase7ProcessorFeatures]::IsProcessorFeaturePresent(39)
$avx2 = [Phase7ProcessorFeatures]::IsProcessorFeaturePresent(40)
if (-not $avx) {
  Add-Blocker -Target $blockers -Code 'CPU_AVX_NOT_AVAILABLE' -Detail 'The CPU does not report AVX support.'
}

$driveRoot = [System.IO.Path]::GetPathRoot($repoRoot)
$drive = [System.IO.DriveInfo]::new($driveRoot)
$largestSourceBytes = [int64]0
foreach ($candidate in $manifest.candidates) {
  $candidateBytes = [int64]0
  foreach ($file in $candidate.sourceFiles) {
    $candidateBytes += [int64]$file.size
  }
  if ($candidateBytes -gt $largestSourceBytes) {
    $largestSourceBytes = $candidateBytes
  }
}
$recommendedFreeBytes = ($largestSourceBytes * 2) + 2GB
if ($drive.AvailableFreeSpace -lt $recommendedFreeBytes) {
  Add-Blocker -Target $blockers -Code 'DISK_HEADROOM_INSUFFICIENT' -Detail 'Free disk space is below the conservative source plus conversion headroom.'
}

$repositoryCommit = $null
$repositoryDirty = $null
if ($null -eq $gitCommand) {
  Add-Blocker -Target $blockers -Code 'GIT_NOT_FOUND' -Detail 'Git is required to bind evidence to a repository revision.'
} else {
  $repositoryCommit = (& $gitCommand.Source -C $repoRoot rev-parse HEAD).Trim()
  $repositoryDirty = [bool]((& $gitCommand.Source -C $repoRoot status --porcelain | Measure-Object).Count -gt 0)
}

$environmentBlockerCount = $blockers.Count
$report = [ordered]@{
  schemaVersion = 'phase7-offline-poc-preflight-v1'
  capturedAt = [DateTime]::UtcNow.ToString('o')
  status = if ($environmentBlockerCount -eq 0) { 'ENVIRONMENT_READY_FOR_AUTHORIZED_POC' } else { 'ENVIRONMENT_BLOCKED' }
  scope = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
  network = [ordered]@{
    externalNetworkAccess = 'NOT_VERIFIED'
    isolationApplied = $false
    modelWeightsDownloaded = $false
  }
  repository = [ordered]@{
    commit = $repositoryCommit
    dirty = $repositoryDirty
  }
  operatingSystem = [ordered]@{
    caption = $os.Caption
    version = $os.Version
    build = $os.BuildNumber
    architecture = $os.OSArchitecture
  }
  processor = [ordered]@{
    name = $cpu.Name.Trim()
    physicalCores = [int]$cpu.NumberOfCores
    logicalCores = [int]$cpu.NumberOfLogicalProcessors
    avx = $avx
    avx2 = $avx2
  }
  memory = [ordered]@{
    physicalBytes = [int64]$computer.TotalPhysicalMemory
  }
  disk = [ordered]@{
    availableBytes = [int64]$drive.AvailableFreeSpace
    conservativeRequiredBytes = [int64]$recommendedFreeBytes
  }
  commands = [ordered]@{
    python = $null -ne $pythonCommand
    git = $null -ne $gitCommand
    cmake = $null -ne $cmakeCommand
    msvcCl = $null -ne $clCommand
  }
  python = [ordered]@{
    version = $pythonVersion
    expectedAbi = $manifest.runtime.windowsWheel.pythonAbi
    packages = $packageChecks
  }
  benchmarkDefaults = [ordered]@{
    device = $manifest.policy.benchmarkDevice
    interThreads = [int]$manifest.policy.benchmarkInterThreads
    intraThreads = [int]$manifest.policy.benchmarkIntraThreads
    beamSize = [int]$manifest.policy.benchmarkBeamSize
    quantization = $manifest.policy.conversionQuantization
  }
  pocAuthorization = [ordered]@{
    basis = 'PHASE7_M0_USER_AUTHORIZATION'
    explicitRecordRequiredForNetworkAndModelExecution = $true
    grantsIntegrationOrDistribution = $false
  }
  gateA = [ordered]@{
    status = 'BLOCKED'
    occursAfterPocMeasurement = $true
    blocksPocResearch = $false
    requiredInput = $manifest.gateA.requiredInput
  }
  blockers = $blockers
  modelExecution = 'NOT_RUN'
}

$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) {
  $safeOutput = Assert-SafeOutputPath -CandidatePath $OutputPath -AllowedRoot $artifactRoot
  $parent = Split-Path -Parent $safeOutput
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if (Test-Path -LiteralPath $safeOutput) {
    throw 'OUTPUT_ALREADY_EXISTS'
  }
  [System.IO.File]::WriteAllText($safeOutput, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

$json

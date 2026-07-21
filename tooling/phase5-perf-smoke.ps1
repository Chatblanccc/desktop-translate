[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [string]$GitSha = '',
  [ValidateSet('development', 'packaged-unsigned', 'release-equivalent', 'signed-rc')]
  [string]$BuildMode = 'development',
  [ValidateRange(1, 100000)]
  [int]$Samples = 30,
  [string]$BinarySha256 = ''
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$harnessPath = Join-Path $repositoryRoot 'tooling/phase5-perf-harness.mjs'

if ([string]::IsNullOrWhiteSpace($GitSha)) {
  $GitSha = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to resolve the git SHA for the Phase 5 instrumentation smoke.'
  }
}

if ($GitSha -notmatch '^[0-9a-f]{40}$') {
  throw 'GitSha must contain exactly 40 lowercase hexadecimal characters.'
}
if (-not [string]::IsNullOrEmpty($BinarySha256) -and $BinarySha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'BinarySha256 must contain exactly 64 lowercase hexadecimal characters.'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $uniqueRun = '{0}-{1}' -f ([DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')), ([guid]::NewGuid().ToString('N'))
  $OutputDirectory = Join-Path $repositoryRoot (Join-Path 'artifacts/phase5/perf-smoke' $uniqueRun)
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$arguments = @(
  'exec',
  'tsx',
  $harnessPath,
  'run-instrumentation',
  '--output-dir', $OutputDirectory,
  '--git-sha', $GitSha,
  '--build-mode', $BuildMode,
  '--samples', ([string]$Samples)
)
if (-not [string]::IsNullOrEmpty($BinarySha256)) {
  $arguments += @('--binary-sha256', $BinarySha256)
}

Push-Location $repositoryRoot
try {
  & pnpm @arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'Phase 5 instrumentation harness returned a non-zero exit code.'
  }
} finally {
  Pop-Location
}

$rawPath = Join-Path $OutputDirectory 'raw.jsonl'
$summaryPath = Join-Path $OutputDirectory 'summary.json'
if (-not (Test-Path -LiteralPath $rawPath -PathType Leaf)) {
  throw 'Phase 5 instrumentation smoke did not produce raw.jsonl.'
}
if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
  throw 'Phase 5 instrumentation smoke did not produce summary.json.'
}

$summary = Get-Content -Raw -Encoding UTF8 -LiteralPath $summaryPath | ConvertFrom-Json
if ($summary.recordType -ne 'metrics-summary' -or
    $summary.statisticsMethod -ne 'nearest-rank' -or
    $summary.evidenceScope -ne 'instrumentation-only' -or
    $summary.groups.Count -ne 1 -or
    $summary.groups[0].metricId -ne 'P5-METRICS-ENCODE-OVERHEAD' -or
    $summary.groups[0].n -ne $Samples -or
    $summary.groups[0].failureCount -ne 0) {
  throw 'Phase 5 instrumentation smoke summary violates the expected evidence boundary.'
}

Write-Host "[phase5-perf-smoke] PASS instrumentation-only ($Samples samples)"

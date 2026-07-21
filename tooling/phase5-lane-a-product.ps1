[CmdletBinding()]
param(
    [Parameter()][string]$OutputRoot,
    [Parameter()][string]$GitSha,
    [Parameter()][string]$TestArtifactPath,
    [Parameter()][string]$ReleaseArtifactPath,
    [Parameter()][string]$TestBuildManifestPath,
    [Parameter()][string]$ReleaseBuildManifestPath,
    [Parameter()][string]$TestAttestationBundlePath,
    [Parameter()][string]$ReleaseAttestationBundlePath,
    [Parameter()][string]$TrustedRootPath,
    [Parameter()][string]$Repository,
    [Parameter()][string]$SourceRef,
    [Parameter()][string]$SignerWorkflow,
    [Parameter()][string]$BuildDifferenceId,
    [Parameter()][switch]$DevelopmentSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $OutputRoot = Join-Path $root "artifacts\phase5\local\lane-a-product-$stamp"
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$arguments = [Collections.Generic.List[string]]::new()
$arguments.Add((Join-Path $PSScriptRoot 'phase5-lane-a-product.mjs'))
$arguments.Add('--output-root')
$arguments.Add($OutputRoot)

if ($DevelopmentSelfTest) {
    $arguments.Add('--development-selftest')
} else {
    $formalInputs = [ordered]@{
        '--git-sha' = $GitSha
        '--test-artifact-path' = $TestArtifactPath
        '--release-artifact-path' = $ReleaseArtifactPath
        '--test-build-manifest-path' = $TestBuildManifestPath
        '--release-build-manifest-path' = $ReleaseBuildManifestPath
        '--test-attestation-bundle-path' = $TestAttestationBundlePath
        '--release-attestation-bundle-path' = $ReleaseAttestationBundlePath
        '--trusted-root-path' = $TrustedRootPath
        '--repository' = $Repository
        '--source-ref' = $SourceRef
        '--signer-workflow' = $SignerWorkflow
        '--build-difference-id' = $BuildDifferenceId
    }
    foreach ($entry in $formalInputs.GetEnumerator()) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            throw "Formal product Lane A requires $($entry.Key)."
        }
        $arguments.Add([string]$entry.Key)
        $arguments.Add([string]$entry.Value)
    }
}

& node @arguments
$exitCode = $LASTEXITCODE
$summaryPath = Join-Path $OutputRoot 'summary.json'
if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
    throw "Product Lane A did not write its fail-closed summary (node exit $exitCode)."
}
& node (Join-Path $PSScriptRoot 'phase5-lane-a-product-validate.mjs') --output-root $OutputRoot
if ($LASTEXITCODE -ne 0) { throw 'Product Lane A summary schema validation failed.' }
$summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($summary.acceptance -ne $false -or $summary.status -ne 'NOT_IMPLEMENTED_BLOCKER') {
    throw 'Current product Lane A preflight wrote an unsafe acceptance state.'
}
if ($DevelopmentSelfTest) {
    if ($exitCode -ne 0) { throw "Product Lane A development selftest exited with code $exitCode." }
    Write-Host '[phase5:lane-a:product] Development preflight emitted the expected NOT_IMPLEMENTED_BLOCKER; no product process was launched.'
    return
}

throw "Product Lane A remains NOT_IMPLEMENTED_BLOCKER. See $summaryPath"

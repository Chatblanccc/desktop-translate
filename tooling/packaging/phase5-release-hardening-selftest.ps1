[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')

$functionOrderFailures = @()
Get-ChildItem (Join-Path $root 'tooling\packaging'), (Join-Path $root 'tooling\supply-chain') -Filter '*.ps1' -File | ForEach-Object {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "PowerShell parser failure in $($_.FullName)." }
    $functions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $true))
    foreach ($function in $functions) {
        $calls = @($ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq $function.Name
        }, $true))
        foreach ($call in $calls) {
            if ($call.Extent.StartOffset -lt $function.Extent.StartOffset) {
                $functionOrderFailures += "$($_.FullName):$($call.Extent.StartLineNumber) calls $($function.Name) before its definition"
            }
        }
    }
}
if ($functionOrderFailures.Count -gt 0) { throw ($functionOrderFailures -join [Environment]::NewLine) }

node (Join-Path $root 'tooling\supply-chain\phase5-release-evidence-selftest.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release evidence exact-set selftest failed.' }

$temporaryParent = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-safe-delete-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryParent | Out-Null
$junction = $null
$parentJunction = $null
try {
    $ordinary = Join-Path $temporaryParent 'ordinary'
    New-Item -ItemType Directory -Path (Join-Path $ordinary 'nested') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $ordinary 'nested\proof.txt') -Value 'proof' -Encoding UTF8
    Remove-Phase5DirectoryTree -Path $ordinary -AllowedParent $temporaryParent
    if (Test-Path -LiteralPath $ordinary) { throw 'Safe ordinary recursive deletion did not complete.' }

    $junctionSource = Join-Path $temporaryParent 'junction-source'
    $guarded = Join-Path $temporaryParent 'guarded'
    New-Item -ItemType Directory -Path $junctionSource, $guarded | Out-Null
    Set-Content -LiteralPath (Join-Path $junctionSource 'must-survive.txt') -Value 'survive' -Encoding UTF8
    $junction = Join-Path $guarded 'escape'
    New-Item -ItemType Junction -Path $junction -Target $junctionSource | Out-Null
    $rejected = $false
    try {
        Remove-Phase5DirectoryTree -Path $guarded -AllowedParent $temporaryParent
    } catch {
        $rejected = $_.Exception.Message -match 'reparse[ -]point'
    }
    if (-not $rejected) { throw 'Recursive deletion did not reject a junction/reparse point.' }
    if (-not (Test-Path -LiteralPath (Join-Path $junctionSource 'must-survive.txt') -PathType Leaf)) {
        throw 'Junction target was modified during the rejection test.'
    }
    [IO.Directory]::Delete($junction)
    Remove-Phase5DirectoryTree -Path $guarded -AllowedParent $temporaryParent
    Remove-Phase5DirectoryTree -Path $junctionSource -AllowedParent $temporaryParent

    $parentJunctionTarget = Join-Path $temporaryParent 'parent-junction-target'
    New-Item -ItemType Directory -Force -Path (Join-Path $parentJunctionTarget 'child') | Out-Null
    $parentJunction = Join-Path $temporaryParent 'parent-junction-link'
    New-Item -ItemType Junction -Path $parentJunction -Target $parentJunctionTarget | Out-Null
    $parentRejected = $false
    try {
        Remove-Phase5DirectoryTree -Path (Join-Path $parentJunction 'child') -AllowedParent $parentJunction
    } catch {
        $parentRejected = $_.Exception.Message -match 'reparse[ -]point'
    }
    if (-not $parentRejected) { throw 'Recursive deletion did not reject a reparse-point parent path.' }
    [IO.Directory]::Delete($parentJunction)
    $parentJunction = $null
    Remove-Phase5DirectoryTree -Path $parentJunctionTarget -AllowedParent $temporaryParent

    $smokeEvidence = Join-Path $temporaryParent 'smoke-pending-evidence'
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $smokeEvidence 'package'), `
        (Join-Path $smokeEvidence 'release') | Out-Null
    Set-Content -LiteralPath (Join-Path $smokeEvidence 'package\startup-smoke.json') `
        -Value '{"schemaVersion":1,"status":"PASS"}' -Encoding UTF8
    [ordered]@{
        schemaVersion = 1
        package = [ordered]@{
            startupSmoke = 'package/startup-smoke.json'
            startupSmokeSha256 = 'stale'
            startupSmokeStatus = 'PASS'
        }
    } | ConvertTo-Json -Depth 4 | Set-Content `
        -LiteralPath (Join-Path $smokeEvidence 'release\evidence-manifest.json') -Encoding UTF8
    $missingInputRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'phase5-clean-package-smoke.ps1') `
            -PackageDirectory (Join-Path $temporaryParent 'missing-package') `
            -EvidenceDirectory $smokeEvidence
    } catch {
        $missingInputRejected = $_.Exception.Message -match 'Packaged smoke input is missing'
    }
    if (-not $missingInputRejected) { throw 'Packaged smoke did not reject missing inputs.' }
    $pendingReportPath = Join-Path $smokeEvidence 'package\startup-smoke.json'
    $pendingReport = Get-Content -LiteralPath $pendingReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $pendingManifest = Get-Content -LiteralPath (Join-Path $smokeEvidence 'release\evidence-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $pendingHash = (Get-FileHash -LiteralPath $pendingReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($pendingReport.status -ne 'PENDING' -or $pendingManifest.package.startupSmokeStatus -ne 'PENDING') {
        throw 'Failed packaged smoke left stale PASS evidence instead of PENDING.'
    }
    if ($pendingManifest.package.startupSmokeSha256 -ne $pendingHash) {
        throw 'Failed packaged smoke did not bind the PENDING report hash.'
    }

    $cleanDownloadOutput = Join-Path $temporaryParent 'clean-download-blocked-evidence'
    $cleanDownloadRejected = $false
    try {
        & (Join-Path $root 'tooling\supply-chain\phase5-clean-download-verify.ps1') `
            -DownloadDirectory (Join-Path $temporaryParent 'missing-clean-download') `
            -Repository 'owner/repository' `
            -SourceRef 'refs/tags/phase5-rc-selftest' `
            -SourceDigest ('a' * 40) `
            -SignerWorkflow 'owner/repository/.github/workflows/phase5-windows.yml' `
            -ExpectedSubject 'CN=selftest' `
            -IndependentTrustedRoot (Join-Path $temporaryParent 'missing-trusted-root.jsonl') `
            -OutputDirectory $cleanDownloadOutput
    } catch {
        $cleanDownloadRejected = $true
    }
    if (-not $cleanDownloadRejected) { throw 'Clean-download verification did not reject missing input.' }
    $blockedCleanDownload = Get-Content `
        -LiteralPath (Join-Path $cleanDownloadOutput 'clean-download-verification.json') `
        -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($blockedCleanDownload.status -ne 'RELEASE BLOCKED' -or $blockedCleanDownload.releaseStatus -ne 'RELEASE BLOCKED') {
        throw 'Failed clean-download verification left stale PASS evidence.'
    }

    $dummyPackage = Join-Path $temporaryParent 'dummy-package'
    $dummyHostDirectory = Join-Path $dummyPackage 'resources\selection-host'
    New-Item -ItemType Directory -Force -Path $dummyHostDirectory | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $dummyPackage 'desktop-translate.exe'), [byte[]](1, 2, 3))
    [IO.File]::WriteAllBytes((Join-Path $dummyHostDirectory 'selection-host.exe'), [byte[]](4, 5, 6))
    $dummyInstaller = Join-Path $temporaryParent 'dummy-setup.exe'
    [IO.File]::WriteAllBytes($dummyInstaller, [byte[]](7, 8, 9))
    $dummyEvidence = Join-Path $temporaryParent 'dummy-sign-evidence'
    & (Join-Path $root 'tooling\supply-chain\phase5-sign-verify.ps1') `
        -PackageDirectory $dummyPackage `
        -InstallerPath $dummyInstaller `
        -EvidenceDirectory $dummyEvidence
    $dummyReport = Get-Content -LiteralPath (Join-Path $dummyEvidence 'security\signature-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $dummyRoles = @($dummyReport.artifacts | ForEach-Object role | Sort-Object)
    if (($dummyRoles | ConvertTo-Json -Compress) -ne ('application', 'installer', 'nativeHost' | ConvertTo-Json -Compress)) {
        throw 'Signature report did not contain the exact expected artifact roles.'
    }
    if ($dummyReport.schemaVersion -ne 2 -or $dummyReport.status -ne 'RELEASE BLOCKED') {
        throw 'Unsigned signature report did not fail closed with schemaVersion 2.'
    }

    $skipBuildRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'phase5-package.ps1') `
            -Mode Installer -SignedRelease -SkipBuild -ExpectedPublisherSubject 'CN=selftest'
    } catch {
        $skipBuildRejected = $_.Exception.Message -match 'forbids -SkipBuild'
    }
    if (-not $skipBuildRejected) { throw 'SignedRelease did not fail closed on -SkipBuild.' }

    $reusedEvidenceRoot = Join-Path $temporaryParent 'reused-evidence-root'
    New-Item -ItemType Directory -Path $reusedEvidenceRoot | Out-Null
    $reuseSentinel = Join-Path $reusedEvidenceRoot 'must-remain.txt'
    Set-Content -LiteralPath $reuseSentinel -Value 'pre-existing evidence' -Encoding UTF8
    $reuseRejected = $false
    try {
        & (Join-Path $PSScriptRoot 'phase5-package.ps1') -Mode Dir -SkipBuild -EvidenceRoot $reusedEvidenceRoot
    } catch {
        $reuseRejected = $_.Exception.Message -match 'evidence root already exists'
    }
    if (-not $reuseRejected) { throw 'Packaging did not reject a pre-existing evidence directory.' }
    if ((Get-Content -LiteralPath $reuseSentinel -Raw -Encoding UTF8).Trim() -ne 'pre-existing evidence') {
        throw 'Packaging modified pre-existing evidence while rejecting root reuse.'
    }

    $savedSelftestCsc = [Environment]::GetEnvironmentVariable('CSC_LINK', [EnvironmentVariableTarget]::Process)
    try {
        [Environment]::SetEnvironmentVariable('CSC_LINK', 'phase5-selftest-sentinel', [EnvironmentVariableTarget]::Process)
        $invalidEvidenceRoot = Join-Path $temporaryParent 'evidence-root-is-a-file'
        Set-Content -LiteralPath $invalidEvidenceRoot -Value 'not-a-directory' -Encoding UTF8
        $failedAsExpected = $false
        try {
            & (Join-Path $PSScriptRoot 'phase5-package.ps1') -Mode Dir -SkipBuild -EvidenceRoot $invalidEvidenceRoot
        } catch {
            $failedAsExpected = $true
        }
        if (-not $failedAsExpected) { throw 'Unsigned environment-restoration setup did not fail as expected.' }
        if ([Environment]::GetEnvironmentVariable('CSC_LINK', [EnvironmentVariableTarget]::Process) -ne 'phase5-selftest-sentinel') {
            throw 'Unsigned packaging did not restore a pre-existing signing environment after early failure.'
        }
    } finally {
        [Environment]::SetEnvironmentVariable('CSC_LINK', $savedSelftestCsc, [EnvironmentVariableTarget]::Process)
    }

    $workspaceState = Join-Path $temporaryParent 'workspace-state.json'
    node (Join-Path $root 'tooling\supply-chain\capture-phase5-workspace-state.mjs') `
        --output $workspaceState --mode unsigned --expected-head ((& git -C $root rev-parse HEAD).Trim())
    if ($LASTEXITCODE -ne 0) { throw 'Workspace-state capture selftest failed.' }
    $state = Get-Content -LiteralPath $workspaceState -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.developmentDirty -and $state.patchDigest -notmatch '^[a-f0-9]{64}$') {
        throw 'Dirty workspace state did not include a valid patchDigest.'
    }
    if ($state.acceptanceEligible -ne $false) { throw 'Unsigned workspace state must never be acceptance eligible.' }
} finally {
    if ($junction -and (Test-Path -LiteralPath $junction)) {
        # Directory.Delete on the junction itself is non-recursive and never
        # traverses into its target.
        [IO.Directory]::Delete($junction)
    }
    if ($parentJunction -and (Test-Path -LiteralPath $parentJunction)) {
        [IO.Directory]::Delete($parentJunction)
    }
    if (Test-Path -LiteralPath $temporaryParent) {
        Remove-Phase5DirectoryTree -Path $temporaryParent -AllowedParent ([IO.Path]::GetTempPath())
    }
}

Write-Host '[phase5:release-hardening:selftest] function order, safe deletion, PENDING/BLOCKED evidence, exclusive evidence roots, SignedRelease, and workspace identity negative gates PASS.'

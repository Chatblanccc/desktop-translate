[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')
. (Join-Path $PSScriptRoot 'phase5-package-output-preflight.ps1')

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
$packagePreflightProcess = $null
$packagePreflightExecutable = $null
$packagePreflightCreationDateUtc = $null
$packagePreflightLockedStream = $null
$packageQuarantineLease = $null
try {
    $ordinary = Join-Path $temporaryParent 'ordinary'
    New-Item -ItemType Directory -Path (Join-Path $ordinary 'nested') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $ordinary 'nested\proof.txt') -Value 'proof' -Encoding UTF8
    Remove-Phase5DirectoryTree -Path $ordinary -AllowedParent $temporaryParent
    if (Test-Path -LiteralPath $ordinary) { throw 'Safe ordinary recursive deletion did not complete.' }

    $nonDirectoryLeaseTarget = Join-Path $temporaryParent 'not-a-directory-lease.txt'
    Set-Content -LiteralPath $nonDirectoryLeaseTarget -Value 'must not be leased as a directory' -Encoding UTF8
    $nonDirectoryLeaseRejected = $false
    try {
        $null = [Phase5.PackageOutputQuarantineNative]::OpenDirectoryIdentityLease($nonDirectoryLeaseTarget)
    } catch {
        $nonDirectoryLeaseRejected = $_.Exception.Message -match 'not a regular non-reparse directory'
    }
    if (-not $nonDirectoryLeaseRejected -or
        -not (Test-Path -LiteralPath $nonDirectoryLeaseTarget -PathType Leaf)) {
        throw 'Directory identity lease accepted or modified an ordinary file.'
    }

    $atomicPublishParent = Join-Path $temporaryParent 'atomic-package-publish'
    $atomicPublishStaging = Join-Path $atomicPublishParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $atomicPublishFinal = Join-Path $atomicPublishParent 'dist'
    $atomicPublishProof = Join-Path $atomicPublishStaging 'win-unpacked\proof.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $atomicPublishProof) | Out-Null
    Set-Content -LiteralPath $atomicPublishProof -Value 'staging must remain complete' -Encoding UTF8
    $atomicPublishProofHash = (Get-FileHash -LiteralPath $atomicPublishProof -Algorithm SHA256).Hash
    New-Item -ItemType Directory -Path $atomicPublishFinal | Out-Null
    $racerProof = Join-Path $atomicPublishFinal 'racer.txt'
    Set-Content -LiteralPath $racerProof -Value 'racer owns final namespace' -Encoding UTF8
    $precreatedFinalRejected = $false
    try {
        Publish-Phase5PackageBuildStaging `
            -StagingPath $atomicPublishStaging `
            -FinalPath $atomicPublishFinal `
            -AllowedParent $atomicPublishParent `
            -Mode Dir
    } catch {
        $precreatedFinalRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_FINAL_NAMESPACE_BUSY' -and
            $_.Exception.Data['StagingRetained'] -eq $true
    }
    if (-not $precreatedFinalRejected -or
        -not (Test-Path -LiteralPath $racerProof -PathType Leaf) -or
        -not (Test-Path -LiteralPath $atomicPublishProof -PathType Leaf) -or
        (Get-FileHash -LiteralPath $atomicPublishProof -Algorithm SHA256).Hash -cne $atomicPublishProofHash) {
        throw 'Atomic package publish did not reject a pre-created final namespace while retaining complete staging.'
    }
    Remove-Phase5DirectoryTree -Path $atomicPublishFinal -AllowedParent $atomicPublishParent
    Invoke-Phase5PackageCandidateGatesAndPublish `
        -GateAction {
            if ((Get-FileHash -LiteralPath $atomicPublishProof -Algorithm SHA256).Hash -cne
                $atomicPublishProofHash) {
                throw 'Successful candidate gate observed a changed staging proof.'
            }
        } `
        -StagingPath $atomicPublishStaging `
        -FinalPath $atomicPublishFinal `
        -AllowedParent $atomicPublishParent `
        -Mode Dir
    if ((Test-Path -LiteralPath $atomicPublishStaging) -or
        -not (Test-Path -LiteralPath (Join-Path $atomicPublishFinal 'win-unpacked\proof.txt') -PathType Leaf)) {
        throw 'Atomic package publish did not move complete staging into the exact final dist namespace.'
    }

    $failedGateParent = Join-Path $temporaryParent 'failed-gate-package-publish'
    $failedGateStaging = Join-Path $failedGateParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $failedGateFinal = Join-Path $failedGateParent 'dist'
    $failedGateProof = Join-Path $failedGateStaging 'win-unpacked\proof.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $failedGateProof) | Out-Null
    Set-Content -LiteralPath $failedGateProof -Value 'failed gate staging survives' -Encoding UTF8
    $failedGateProofHash = (Get-FileHash -LiteralPath $failedGateProof -Algorithm SHA256).Hash
    $candidateGateFailurePropagated = $false
    try {
        Invoke-Phase5PackageCandidateGatesAndPublish `
            -GateAction { throw 'EXPECTED_CANDIDATE_GATE_FAILURE' } `
            -StagingPath $failedGateStaging `
            -FinalPath $failedGateFinal `
            -AllowedParent $failedGateParent `
            -Mode Dir
    } catch {
        $candidateGateFailurePropagated = $_.Exception.Message -eq 'EXPECTED_CANDIDATE_GATE_FAILURE'
    }
    if (-not $candidateGateFailurePropagated -or
        (Test-Path -LiteralPath $failedGateFinal) -or
        -not (Test-Path -LiteralPath $failedGateProof -PathType Leaf) -or
        (Get-FileHash -LiteralPath $failedGateProof -Algorithm SHA256).Hash -cne $failedGateProofHash) {
        throw 'A failed unpublished-candidate gate created canonical dist or modified retained staging.'
    }

    $unexpectedRootParent = Join-Path $temporaryParent 'unexpected-root-package-publish'
    $unexpectedRootStaging = Join-Path $unexpectedRootParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $unexpectedRootFinal = Join-Path $unexpectedRootParent 'dist'
    $unexpectedRootProof = Join-Path $unexpectedRootStaging 'win-unpacked\proof.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $unexpectedRootProof) | Out-Null
    Set-Content -LiteralPath $unexpectedRootProof -Value 'unexpected root staging survives' -Encoding UTF8
    $unexpectedRootExtra = Join-Path $unexpectedRootStaging 'unexpected.txt'
    Set-Content -LiteralPath $unexpectedRootExtra -Value 'must reject' -Encoding UTF8
    $unexpectedTopLevelRejected = $false
    try {
        Publish-Phase5PackageBuildStaging `
            -StagingPath $unexpectedRootStaging `
            -FinalPath $unexpectedRootFinal `
            -AllowedParent $unexpectedRootParent `
            -Mode Dir
    } catch {
        $unexpectedTopLevelRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID'
    }
    if (-not $unexpectedTopLevelRejected -or
        (Test-Path -LiteralPath $unexpectedRootFinal) -or
        -not (Test-Path -LiteralPath $unexpectedRootProof -PathType Leaf) -or
        -not (Test-Path -LiteralPath $unexpectedRootExtra -PathType Leaf)) {
        throw 'Candidate root exact-set gate did not reject and retain an unexpected top-level file.'
    }

    $installerExactParent = Join-Path $temporaryParent 'installer-root-exact-set'
    $installerExactRoot = Join-Path $installerExactParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $installerExactRoot 'win-unpacked') | Out-Null
    $installerExactSetup = Join-Path $installerExactRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($installerExactSetup, [byte[]](1, 2, 3))
    $resolvedExactInstaller = Assert-Phase5PackageOutputRootExactSet `
        -Root $installerExactRoot `
        -AllowedParent $installerExactParent `
        -Mode Installer
    if (-not [string]::Equals(
        $resolvedExactInstaller,
        $installerExactSetup,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Installer root exact-set gate did not return the unique setup executable.'
    }
    Set-Content -LiteralPath (Join-Path $installerExactRoot 'unexpected.yml') -Value 'reject' -Encoding UTF8
    $installerExtraRejected = $false
    try {
        $null = Assert-Phase5PackageOutputRootExactSet `
            -Root $installerExactRoot `
            -AllowedParent $installerExactParent `
            -Mode Installer
    } catch {
        $installerExtraRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID'
    }
    if (-not $installerExtraRejected) {
        throw 'Installer root exact-set gate accepted an unexpected third top-level entry.'
    }

    $blockmapCleanupParent = Join-Path $temporaryParent 'installer-blockmap-cleanup'
    $blockmapCleanupRoot = Join-Path $blockmapCleanupParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapCleanupRoot 'win-unpacked') | Out-Null
    $blockmapCleanupSetup = Join-Path $blockmapCleanupRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($blockmapCleanupSetup, [byte[]](10, 20, 30, 40))
    $blockmapCleanupSetupHash = (Get-FileHash -LiteralPath $blockmapCleanupSetup -Algorithm SHA256).Hash
    $blockmapCleanupExact = $blockmapCleanupSetup + '.blockmap'
    [IO.File]::WriteAllBytes($blockmapCleanupExact, [byte[]](50, 60, 70))
    $blockmapCleanupResolved = Remove-Phase5UnpublishedInstallerBlockmap `
        -Root $blockmapCleanupRoot `
        -AllowedParent $blockmapCleanupParent
    $blockmapCleanupExactInstaller = Assert-Phase5PackageOutputRootExactSet `
        -Root $blockmapCleanupRoot `
        -AllowedParent $blockmapCleanupParent `
        -Mode Installer
    if (-not [string]::Equals(
        $blockmapCleanupResolved,
        $blockmapCleanupSetup,
        [StringComparison]::OrdinalIgnoreCase
    ) -or -not [string]::Equals(
        $blockmapCleanupExactInstaller,
        $blockmapCleanupSetup,
        [StringComparison]::OrdinalIgnoreCase
    ) -or (Test-Path -LiteralPath $blockmapCleanupExact) -or
        (Get-FileHash -LiteralPath $blockmapCleanupSetup -Algorithm SHA256).Hash -cne
            $blockmapCleanupSetupHash) {
        throw 'Exact regular unpublished setup blockmap cleanup did not preserve the setup and exact root.'
    }

    $blockmapLeaseRaceParent = Join-Path $temporaryParent 'installer-blockmap-lease-race'
    $blockmapLeaseRaceRoot = Join-Path $blockmapLeaseRaceParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapLeaseRaceRoot 'win-unpacked') | Out-Null
    $blockmapLeaseRaceSetup = Join-Path $blockmapLeaseRaceRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    $blockmapLeaseRaceExact = $blockmapLeaseRaceSetup + '.blockmap'
    [IO.File]::WriteAllBytes($blockmapLeaseRaceSetup, [byte[]](71, 72, 73))
    [IO.File]::WriteAllBytes($blockmapLeaseRaceExact, [byte[]](74, 75, 76))
    $blockmapLeaseRaceHash = (Get-FileHash -LiteralPath $blockmapLeaseRaceExact -Algorithm SHA256).Hash
    $raceParentLease = $null
    $raceRootLease = $null
    $raceBlockmapLease = $null
    try {
        $raceParentLease = [Phase5.PackageOutputQuarantineNative]::OpenDirectoryIdentityLease($blockmapLeaseRaceParent)
        $raceRootLease = [Phase5.PackageOutputQuarantineNative]::OpenDirectoryIdentityLease($blockmapLeaseRaceRoot)
        $raceBlockmapLease = [Phase5.PackageOutputQuarantineNative]::OpenExactRegularFileLease($blockmapLeaseRaceExact, $true)
        $parentRenameRejected = $false
        $rootRenameRejected = $false
        $blockmapRenameRejected = $false
        $blockmapReplaceRejected = $false
        try {
            [IO.Directory]::Move($blockmapLeaseRaceParent, $blockmapLeaseRaceParent + '-swapped')
        } catch { $parentRenameRejected = $true }
        try {
            [IO.Directory]::Move($blockmapLeaseRaceRoot, $blockmapLeaseRaceRoot + '-swapped')
        } catch { $rootRenameRejected = $true }
        try {
            [IO.File]::Move($blockmapLeaseRaceExact, $blockmapLeaseRaceExact + '.swapped')
        } catch { $blockmapRenameRejected = $true }
        try {
            [IO.File]::WriteAllBytes($blockmapLeaseRaceExact, [byte[]](99))
        } catch { $blockmapReplaceRejected = $true }
        if (-not $parentRenameRejected -or -not $rootRenameRejected -or
            -not $blockmapRenameRejected -or -not $blockmapReplaceRejected -or
            -not (Test-Path -LiteralPath $blockmapLeaseRaceExact -PathType Leaf)) {
            throw 'Directory identity and no-share sidecar leases did not reject concurrent parent/root rename and sidecar rename/replace attempts.'
        }
    } finally {
        if ($null -ne $raceBlockmapLease) { $raceBlockmapLease.Dispose() }
        if ($null -ne $raceRootLease) { $raceRootLease.Dispose() }
        if ($null -ne $raceParentLease) { $raceParentLease.Dispose() }
    }
    if ((Get-FileHash -LiteralPath $blockmapLeaseRaceExact -Algorithm SHA256).Hash -cne
        $blockmapLeaseRaceHash) {
        throw 'A concurrent sidecar replacement attempt changed content while the no-share identity lease was held.'
    }
    $null = Remove-Phase5UnpublishedInstallerBlockmap `
        -Root $blockmapLeaseRaceRoot `
        -AllowedParent $blockmapLeaseRaceParent
    if (Test-Path -LiteralPath $blockmapLeaseRaceExact) {
        throw 'Exact sidecar was not removable by leased-handle disposition after concurrent attacks were rejected.'
    }

    $wrongInstallerParent = Join-Path $temporaryParent 'installer-wrong-canonical-name'
    $wrongInstallerRoot = Join-Path $wrongInstallerParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $wrongInstallerRoot 'win-unpacked') | Out-Null
    $wrongInstallerSetup = Join-Path $wrongInstallerRoot 'Desktop-Translate-0.5.0-x64-setup.exe'
    $wrongInstallerBlockmap = $wrongInstallerSetup + '.blockmap'
    [IO.File]::WriteAllBytes($wrongInstallerSetup, [byte[]](81, 82, 83))
    [IO.File]::WriteAllBytes($wrongInstallerBlockmap, [byte[]](84, 85, 86))
    $wrongInstallerRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $wrongInstallerRoot `
            -AllowedParent $wrongInstallerParent
    } catch {
        $wrongInstallerRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_INSTALLER_SETUP_INVALID'
    }
    if (-not $wrongInstallerRejected -or
        -not (Test-Path -LiteralPath $wrongInstallerSetup -PathType Leaf) -or
        -not (Test-Path -LiteralPath $wrongInstallerBlockmap -PathType Leaf)) {
        throw 'A non-canonical installer name was accepted or modified.'
    }

    $blockmapCanonicalParent = Join-Path $temporaryParent 'installer-blockmap-canonical'
    $blockmapCanonicalRoot = Join-Path $blockmapCanonicalParent 'dist'
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapCanonicalRoot 'win-unpacked') | Out-Null
    $blockmapCanonicalSetup = Join-Path $blockmapCanonicalRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($blockmapCanonicalSetup, [byte[]](21, 22, 23))
    $blockmapCanonicalExact = $blockmapCanonicalSetup + '.blockmap'
    [IO.File]::WriteAllBytes($blockmapCanonicalExact, [byte[]](24, 25, 26))
    $blockmapCanonicalRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $blockmapCanonicalRoot `
            -AllowedParent $blockmapCanonicalParent
    } catch {
        $blockmapCanonicalRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_INSTALLER_STAGING_PATH_INVALID'
    }
    if (-not $blockmapCanonicalRejected -or
        -not (Test-Path -LiteralPath $blockmapCanonicalSetup -PathType Leaf) -or
        -not (Test-Path -LiteralPath $blockmapCanonicalExact -PathType Leaf)) {
        throw 'Installer blockmap cleanup did not reject and preserve canonical dist.'
    }

    $blockmapLookalikeParent = Join-Path $temporaryParent 'installer-blockmap-lookalike'
    $blockmapLookalikeRoot = Join-Path $blockmapLookalikeParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapLookalikeRoot 'win-unpacked') | Out-Null
    $blockmapLookalikeSetup = Join-Path $blockmapLookalikeRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($blockmapLookalikeSetup, [byte[]](1, 3, 5))
    $blockmapLookalike = $blockmapLookalikeSetup + '.blockmap.bak'
    [IO.File]::WriteAllBytes($blockmapLookalike, [byte[]](2, 4, 6))
    $blockmapLookalikeRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $blockmapLookalikeRoot `
            -AllowedParent $blockmapLookalikeParent
    } catch {
        $blockmapLookalikeRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID'
    }
    if (-not $blockmapLookalikeRejected -or
        -not (Test-Path -LiteralPath $blockmapLookalike -PathType Leaf) -or
        -not (Test-Path -LiteralPath $blockmapLookalikeSetup -PathType Leaf)) {
        throw 'A blockmap lookalike was deleted or did not fail closed.'
    }

    $blockmapDirectoryParent = Join-Path $temporaryParent 'installer-blockmap-directory'
    $blockmapDirectoryRoot = Join-Path $blockmapDirectoryParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapDirectoryRoot 'win-unpacked') | Out-Null
    $blockmapDirectorySetup = Join-Path $blockmapDirectoryRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($blockmapDirectorySetup, [byte[]](7, 8, 9))
    $blockmapDirectory = $blockmapDirectorySetup + '.blockmap'
    New-Item -ItemType Directory -Path $blockmapDirectory | Out-Null
    $blockmapDirectoryRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $blockmapDirectoryRoot `
            -AllowedParent $blockmapDirectoryParent
    } catch {
        $blockmapDirectoryRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_INSTALLER_BLOCKMAP_INVALID'
    }
    if (-not $blockmapDirectoryRejected -or
        -not (Test-Path -LiteralPath $blockmapDirectory -PathType Container)) {
        throw 'A setup blockmap directory was deleted or did not fail closed.'
    }

    $blockmapReparseParent = Join-Path $temporaryParent 'installer-blockmap-reparse'
    $blockmapReparseRoot = Join-Path $blockmapReparseParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $blockmapReparseTarget = Join-Path $blockmapReparseParent 'outside-target'
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $blockmapReparseRoot 'win-unpacked'), $blockmapReparseTarget | Out-Null
    $blockmapReparseTargetProof = Join-Path $blockmapReparseTarget 'must-survive.txt'
    Set-Content -LiteralPath $blockmapReparseTargetProof -Value 'reparse target survives' -Encoding UTF8
    $blockmapReparseSetup = Join-Path $blockmapReparseRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    [IO.File]::WriteAllBytes($blockmapReparseSetup, [byte[]](11, 12, 13))
    $blockmapReparse = $blockmapReparseSetup + '.blockmap'
    New-Item -ItemType Junction -Path $blockmapReparse -Target $blockmapReparseTarget | Out-Null
    try {
        $blockmapReparseRejected = $false
        try {
            $null = Remove-Phase5UnpublishedInstallerBlockmap `
                -Root $blockmapReparseRoot `
                -AllowedParent $blockmapReparseParent
        } catch {
            $blockmapReparseRejected = $_.Exception.Message -match 'reparse point'
        }
        if (-not $blockmapReparseRejected -or
            -not (Test-Path -LiteralPath $blockmapReparse -PathType Container) -or
            -not (Test-Path -LiteralPath $blockmapReparseTargetProof -PathType Leaf)) {
            throw 'A setup blockmap reparse point was deleted/traversed or did not fail closed.'
        }
    } finally {
        if (Test-Path -LiteralPath $blockmapReparse) {
            [IO.Directory]::Delete($blockmapReparse)
        }
    }

    $blockmapMultipleParent = Join-Path $temporaryParent 'installer-blockmap-multiple-setup'
    $blockmapMultipleRoot = Join-Path $blockmapMultipleParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $blockmapMultipleRoot 'win-unpacked') | Out-Null
    $blockmapMultipleSetupA = Join-Path $blockmapMultipleRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    $blockmapMultipleSetupB = Join-Path $blockmapMultipleRoot 'Desktop-Translate-extra-setup.exe'
    [IO.File]::WriteAllBytes($blockmapMultipleSetupA, [byte[]](1))
    [IO.File]::WriteAllBytes($blockmapMultipleSetupB, [byte[]](2))
    $blockmapMultipleExact = $blockmapMultipleSetupA + '.blockmap'
    [IO.File]::WriteAllBytes($blockmapMultipleExact, [byte[]](3))
    $blockmapMultipleRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $blockmapMultipleRoot `
            -AllowedParent $blockmapMultipleParent
    } catch {
        $blockmapMultipleRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID'
    }
    if (-not $blockmapMultipleRejected -or
        -not (Test-Path -LiteralPath $blockmapMultipleSetupA -PathType Leaf) -or
        -not (Test-Path -LiteralPath $blockmapMultipleSetupB -PathType Leaf) -or
        -not (Test-Path -LiteralPath $blockmapMultipleExact -PathType Leaf)) {
        throw 'Multiple setup executables did not fail closed before exact blockmap cleanup.'
    }

    $setupDirectoryParent = Join-Path $temporaryParent 'installer-setup-directory'
    $setupDirectoryRoot = Join-Path $setupDirectoryParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path (Join-Path $setupDirectoryRoot 'win-unpacked') | Out-Null
    $setupDirectory = Join-Path $setupDirectoryRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    New-Item -ItemType Directory -Path $setupDirectory | Out-Null
    $setupDirectoryBlockmap = $setupDirectory + '.blockmap'
    [IO.File]::WriteAllBytes($setupDirectoryBlockmap, [byte[]](31, 32, 33))
    $setupDirectoryRejected = $false
    try {
        $null = Remove-Phase5UnpublishedInstallerBlockmap `
            -Root $setupDirectoryRoot `
            -AllowedParent $setupDirectoryParent
    } catch {
        $setupDirectoryRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_INSTALLER_SETUP_INVALID'
    }
    if (-not $setupDirectoryRejected -or
        -not (Test-Path -LiteralPath $setupDirectory -PathType Container) -or
        -not (Test-Path -LiteralPath $setupDirectoryBlockmap -PathType Leaf)) {
        throw 'A setup executable directory was deleted or did not fail closed before blockmap cleanup.'
    }

    $setupReparseParent = Join-Path $temporaryParent 'installer-setup-reparse'
    $setupReparseRoot = Join-Path $setupReparseParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $setupReparseTarget = Join-Path $setupReparseParent 'outside-target'
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $setupReparseRoot 'win-unpacked'), $setupReparseTarget | Out-Null
    $setupReparseTargetProof = Join-Path $setupReparseTarget 'must-survive.txt'
    Set-Content -LiteralPath $setupReparseTargetProof -Value 'setup reparse target survives' -Encoding UTF8
    $setupReparse = Join-Path $setupReparseRoot 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    New-Item -ItemType Junction -Path $setupReparse -Target $setupReparseTarget | Out-Null
    $setupReparseBlockmap = $setupReparse + '.blockmap'
    [IO.File]::WriteAllBytes($setupReparseBlockmap, [byte[]](34, 35, 36))
    try {
        $setupReparseRejected = $false
        try {
            $null = Remove-Phase5UnpublishedInstallerBlockmap `
                -Root $setupReparseRoot `
                -AllowedParent $setupReparseParent
        } catch {
            $setupReparseRejected = $_.Exception.Message -match 'reparse point'
        }
        if (-not $setupReparseRejected -or
            -not (Test-Path -LiteralPath $setupReparse -PathType Container) -or
            -not (Test-Path -LiteralPath $setupReparseBlockmap -PathType Leaf) -or
            -not (Test-Path -LiteralPath $setupReparseTargetProof -PathType Leaf)) {
            throw 'A setup executable reparse point was deleted/traversed or did not fail closed.'
        }
    } finally {
        if (Test-Path -LiteralPath $setupReparse) {
            [IO.Directory]::Delete($setupReparse)
        }
    }

    $postPublishFailureParent = Join-Path $temporaryParent 'post-publish-validation-failure'
    $postPublishFailureStaging = Join-Path $postPublishFailureParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $postPublishFailureFinal = Join-Path $postPublishFailureParent 'dist'
    $postPublishFailureProof = Join-Path $postPublishFailureStaging 'win-unpacked\proof.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $postPublishFailureProof) | Out-Null
    Set-Content -LiteralPath $postPublishFailureProof -Value 'post-publish failure retained' -Encoding UTF8
    $postPublishFailureHash = (Get-FileHash -LiteralPath $postPublishFailureProof -Algorithm SHA256).Hash
    Publish-Phase5PackageBuildStaging `
        -StagingPath $postPublishFailureStaging `
        -FinalPath $postPublishFailureFinal `
        -AllowedParent $postPublishFailureParent `
        -Mode Dir
    $postPublishFailureDetected = $false
    $postPublishFailedPath = $null
    try {
        Invoke-Phase5PublishedPackageLiveValidation `
            -ValidationAction { throw 'EXPECTED_LIVE_VALIDATION_FAILURE' } `
            -FinalPath $postPublishFailureFinal `
            -AllowedParent $postPublishFailureParent `
            -Mode Dir
    } catch {
        $postPublishFailureDetected = $_.Exception.Message -eq 'EXPECTED_LIVE_VALIDATION_FAILURE' -and
            $_.Exception.Data['FailedPackageRetained'] -eq $true
        $postPublishFailedPath = [string]$_.Exception.Data['FailedPackagePath']
    }
    $retainedPostPublishProof = if ($postPublishFailedPath) {
        Join-Path $postPublishFailedPath 'win-unpacked\proof.txt'
    } else {
        $null
    }
    if (-not $postPublishFailureDetected -or
        (Test-Path -LiteralPath $postPublishFailureFinal) -or
        -not $postPublishFailedPath -or
        [IO.Path]::GetFileName($postPublishFailedPath) -notmatch '^\.phase5-failed-[a-f0-9]{32}$' -or
        -not (Test-Path -LiteralPath $retainedPostPublishProof -PathType Leaf) -or
        (Get-FileHash -LiteralPath $retainedPostPublishProof -Algorithm SHA256).Hash -cne
            $postPublishFailureHash) {
        throw 'Post-publish validation failure did not atomically retain the tree and remove canonical dist.'
    }

    $postPublishExtraParent = Join-Path $temporaryParent 'post-publish-extra-root-failure'
    $postPublishExtraStaging = Join-Path $postPublishExtraParent (
        '.phase5-build-' + [guid]::NewGuid().ToString('N')
    )
    $postPublishExtraFinal = Join-Path $postPublishExtraParent 'dist'
    $postPublishExtraProof = Join-Path $postPublishExtraStaging 'win-unpacked\proof.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $postPublishExtraProof) | Out-Null
    Set-Content -LiteralPath $postPublishExtraProof -Value 'post-publish extra retained' -Encoding UTF8
    Publish-Phase5PackageBuildStaging `
        -StagingPath $postPublishExtraStaging `
        -FinalPath $postPublishExtraFinal `
        -AllowedParent $postPublishExtraParent `
        -Mode Dir
    Set-Content -LiteralPath (Join-Path $postPublishExtraFinal 'unexpected.txt') `
        -Value 'post-publish root gate rejects' -Encoding UTF8
    $postPublishExtraRejected = $false
    $postPublishExtraFailedPath = $null
    try {
        Invoke-Phase5PublishedPackageLiveValidation `
            -ValidationAction { throw 'LIVE_ACTION_MUST_NOT_RUN_AFTER_ROOT_FAILURE' } `
            -FinalPath $postPublishExtraFinal `
            -AllowedParent $postPublishExtraParent `
            -Mode Dir
    } catch {
        $postPublishExtraRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID' -and
            $_.Exception.Data['FailedPackageRetained'] -eq $true
        $postPublishExtraFailedPath = [string]$_.Exception.Data['FailedPackagePath']
    }
    if (-not $postPublishExtraRejected -or
        (Test-Path -LiteralPath $postPublishExtraFinal) -or
        -not $postPublishExtraFailedPath -or
        -not (Test-Path -LiteralPath (Join-Path $postPublishExtraFailedPath 'unexpected.txt') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $postPublishExtraFailedPath 'win-unpacked\proof.txt') -PathType Leaf)) {
        throw 'Post-publish root exact-set failure did not retain the failed tree and clear canonical dist.'
    }

    $retentionFailureParent = Join-Path $temporaryParent 'post-publish-retention-failure'
    $retentionFailureFinal = Join-Path $retentionFailureParent 'dist'
    New-Item -ItemType Directory -Force -Path $retentionFailureParent | Out-Null
    [IO.File]::WriteAllText($retentionFailureFinal, 'locked canonical namespace')
    $retentionMoveBlocker = [IO.File]::Open(
        $retentionFailureFinal,
        [IO.FileMode]::Open,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    $dualFailureReported = $false
    try {
        try {
            Invoke-Phase5PublishedPackageLiveValidation `
                -ValidationAction { throw 'LIVE_ACTION_MUST_NOT_RUN_FOR_INVALID_ROOT' } `
                -FinalPath $retentionFailureFinal `
                -AllowedParent $retentionFailureParent `
                -Mode Dir
        } catch {
            $dualFailureReported = $_.Exception.Data['StableErrorCode'] -eq `
                'PACKAGE_OUTPUT_POST_PUBLISH_VALIDATION_AND_RETENTION_FAILED' -and
                -not [string]::IsNullOrWhiteSpace([string]$_.Exception.Data['ValidationError']) -and
                -not [string]::IsNullOrWhiteSpace([string]$_.Exception.Data['RetentionError'])
        }
    } finally {
        $retentionMoveBlocker.Dispose()
    }
    if (-not $dualFailureReported -or
        -not (Test-Path -LiteralPath $retentionFailureFinal -PathType Leaf)) {
        throw 'A failed retention move did not report both validation and retention errors.'
    }

    $packageScriptText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'phase5-package.ps1') -Raw -Encoding UTF8
    if ($packageScriptText -notmatch '--config\.directories\.output=\$packageBuildStaging' -or
        $packageScriptText -notmatch 'Invoke-Phase5PackageCandidateGatesAndPublish') {
        throw 'Package script does not bind electron-builder to unique staging and atomic final publish.'
    }
    $publishBoundaryIndex = $packageScriptText.IndexOf('Invoke-Phase5PackageCandidateGatesAndPublish')
    $publishedReverifyIndex = $packageScriptText.IndexOf('Re-verify atomically published live manifest and hashes')
    $publishedValidationBoundaryIndex = $packageScriptText.IndexOf('Invoke-Phase5PublishedPackageLiveValidation')
    $installerBlockmapCleanupIndex = $packageScriptText.IndexOf('Remove-Phase5UnpublishedInstallerBlockmap')
    $candidateRootExactSetIndex = $packageScriptText.IndexOf('Assert-Phase5PackageOutputRootExactSet')
    $requiredPrePublishMarkers = @(
        'Assert-Phase5PackageOutputRootExactSet',
        'SignedRelease has no protected GitHub Actions OIDC/attestation context',
        'Verify unpublished candidate allowlists, ASAR, checksums, and budgets',
        'Verify staged resources survived in unpublished candidate byte-for-byte',
        'Run isolated unpublished candidate startup/resource smoke',
        'phase5-sign-verify.ps1',
        'Verify unpublished candidate evidence manifest traceability'
    )
    if ($publishBoundaryIndex -lt 0 -or
        $installerBlockmapCleanupIndex -lt 0 -or
        $candidateRootExactSetIndex -le $installerBlockmapCleanupIndex -or
        $candidateRootExactSetIndex -ge $publishBoundaryIndex -or
        $publishedReverifyIndex -le $publishBoundaryIndex -or
        $publishedValidationBoundaryIndex -le $publishedReverifyIndex -or
        @($requiredPrePublishMarkers | Where-Object {
            $markerIndex = $packageScriptText.IndexOf($_)
            $markerIndex -lt 0 -or $markerIndex -ge $publishBoundaryIndex
        }).Count -gt 0) {
        throw 'Canonical dist publish is not ordered after every candidate gate and before live evidence re-verification.'
    }

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

    $packageArtifactsParent = Join-Path $temporaryParent 'artifacts\phase5'
    $packageQuarantineParent = Join-Path $temporaryParent '.phase5-package-quarantine'
    $packagePreflightOutput = Join-Path $packageArtifactsParent 'package-output-in-use'
    # Use an installer-shaped executable outside win-unpacked so the test
    # proves the guard covers every executable under package output, not only
    # the two historically known product paths.
    $packagePreflightExecutable = Join-Path $packagePreflightOutput 'Desktop-Translate-0.5.0-phase5-x64-setup.exe'
    $packagePreflightSentinel = Join-Path $packagePreflightOutput 'must-remain.txt'
    $packagePreflightNestedSentinel = Join-Path $packagePreflightOutput 'nested\complete-tree.txt'
    New-Item -ItemType Directory -Force -Path `
        (Split-Path -Parent $packagePreflightExecutable), `
        (Split-Path -Parent $packagePreflightNestedSentinel) | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\PING.EXE') `
        -Destination $packagePreflightExecutable
    Set-Content -LiteralPath $packagePreflightSentinel -Value 'package output must remain' -Encoding UTF8
    Set-Content -LiteralPath $packagePreflightNestedSentinel -Value 'nested tree must remain' -Encoding UTF8
    $packagePreflightProcess = Start-Process -FilePath $packagePreflightExecutable `
        -ArgumentList @('-n', '120', '127.0.0.1') `
        -WindowStyle Hidden `
        -PassThru
    $packagePreflightDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $packagePreflightIdentity = $null
    do {
        $packagePreflightIdentity = @(Get-Phase5PackageOutputProcessIdentity `
            -PackageOutput $packagePreflightOutput | Where-Object {
                $_.ProcessId -eq $packagePreflightProcess.Id
            } | Select-Object -First 1)
        if ($packagePreflightIdentity.Count -eq 0) { Start-Sleep -Milliseconds 100 }
    } while ($packagePreflightIdentity.Count -eq 0 -and [DateTime]::UtcNow -lt $packagePreflightDeadline)
    if ($packagePreflightIdentity.Count -ne 1) {
        throw 'Package-output preflight selftest process identity was not observable.'
    }
    $packagePreflightCreationDateUtc = $packagePreflightIdentity[0].CreationDateUtc

    $packageOutputInUseRejected = $false
    try {
        $null = Assert-Phase5PackageOutputNotInUse -PackageOutput $packagePreflightOutput
    } catch {
        $packageOutputInUseRejected = $_.Exception.Message -match '^PACKAGE_OUTPUT_IN_USE:' -and
            $_.Exception.Data['StableErrorCode'] -eq 'PACKAGE_OUTPUT_IN_USE' -and
            $_.Exception.Data['ActiveCount'] -eq 1 -and
            $_.Exception.Data['Roles'] -eq 'installer' -and
            $_.Exception.Message -notmatch [regex]::Escape($packagePreflightExecutable) -and
            $_.Exception.Message -notmatch 'PID=|CreationDate=|:\\'
    }
    if (-not $packageOutputInUseRejected) {
        throw 'Package-output preflight did not reject an active exact packaged executable identity.'
    }
    if ($packagePreflightProcess.HasExited) {
        throw 'Package-output preflight terminated the active packaged executable.'
    }
    if (-not (Test-Path -LiteralPath $packagePreflightSentinel -PathType Leaf) -or
        (Get-Content -LiteralPath $packagePreflightSentinel -Raw -Encoding UTF8).Trim() -ne 'package output must remain'
    ) {
        throw 'Package-output preflight modified the shared package directory before rejecting it.'
    }

    $currentPreflightIdentity = Get-CimInstance -Query (
        "SELECT ProcessId, ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId = $($packagePreflightProcess.Id)"
    ) | Select-Object -First 1
    if ($null -eq $currentPreflightIdentity -or
        [string]::IsNullOrWhiteSpace([string]$currentPreflightIdentity.ExecutablePath) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$currentPreflightIdentity.ExecutablePath),
            [IO.Path]::GetFullPath($packagePreflightExecutable),
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [Math]::Abs((([DateTime]$currentPreflightIdentity.CreationDate).ToUniversalTime() - $packagePreflightCreationDateUtc).TotalSeconds) -gt 1
    ) {
        throw 'Refusing to stop package-output preflight selftest process because its exact identity changed.'
    }
    $packagePreflightProcess.Kill()
    if (-not $packagePreflightProcess.WaitForExit(5000)) {
        throw 'Package-output preflight selftest process did not exit before cleanup.'
    }
    $packagePreflightProcess.Dispose()
    $packagePreflightProcess = $null
    $null = Assert-Phase5PackageOutputNotInUse -PackageOutput $packagePreflightOutput

    # A non-process file lock must also block deletion without disclosing its
    # absolute path. This covers mapped data/DLL locks that WMI process-image
    # enumeration cannot identify.
    $packagePreflightLockedStream = [IO.File]::Open(
        $packagePreflightSentinel,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None
    )
    $packageOutputLeaseRejected = $false
    try {
        $null = Assert-Phase5PackageOutputLeaseAvailable -PackageOutput $packagePreflightOutput
    } catch {
        $packageOutputLeaseRejected = $_.Exception.Message -match '^PACKAGE_OUTPUT_LOCKED:' -and
            $_.Exception.Data['StableErrorCode'] -eq 'PACKAGE_OUTPUT_LOCKED' -and
            $_.Exception.Message -notmatch [regex]::Escape($packagePreflightSentinel) -and
            $_.Exception.Message -notmatch 'PID=|:\\'
    }
    if (-not $packageOutputLeaseRejected) {
        throw 'Package-output lease preflight did not reject a locked non-process file safely.'
    }
    $packagePreflightLockedStream.Dispose()
    $packagePreflightLockedStream = $null
    $null = Assert-Phase5PackageOutputLeaseAvailable -PackageOutput $packagePreflightOutput

    $indeterminateIdentityRejected = $false
    try {
        $null = Resolve-Phase5PackageOutputProcessIdentity -Candidate ([pscustomobject]@{
            ProcessId = 42
            Name = [IO.Path]::GetFileName($packagePreflightExecutable)
            ExecutablePath = $null
            CreationDate = $null
        }) -RelatedPackageOutputs @($packagePreflightOutput) `
            -KnownExecutableNames @([IO.Path]::GetFileName($packagePreflightExecutable))
    } catch {
        $indeterminateIdentityRejected = $_.Exception.Data['StableErrorCode'] -eq `
            'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' -and
            $_.Exception.Message -notmatch 'PID=|:\\'
    }
    if (-not $indeterminateIdentityRejected) {
        throw 'Package-output preflight silently skipped a target-name process with missing WMI identity fields.'
    }
    $unrelatedMissingIdentity = Resolve-Phase5PackageOutputProcessIdentity -Candidate ([pscustomobject]@{
        ProcessId = 4
        Name = 'System'
        ExecutablePath = $null
        CreationDate = $null
    }) -RelatedPackageOutputs @($packagePreflightOutput) `
        -KnownExecutableNames @([IO.Path]::GetFileName($packagePreflightExecutable))
    if ($null -ne $unrelatedMissingIdentity) {
        throw 'A determinately unrelated system process was incorrectly classified as package output.'
    }

    $invalidQuarantineParentRejected = $false
    try {
        $null = Enter-Phase5PackageOutputQuarantineLease `
            -PackageOutput $packagePreflightOutput `
            -AllowedParent $packageArtifactsParent `
            -RepositoryRoot $temporaryParent `
            -QuarantineParent (Join-Path $temporaryParent 'wrong-quarantine-parent')
    } catch {
        $invalidQuarantineParentRejected = $_.Exception.Data['StableErrorCode'] -eq 'PACKAGE_OUTPUT_PATH_INVALID'
    }
    if (-not $invalidQuarantineParentRejected -or
        -not (Test-Path -LiteralPath $packagePreflightSentinel -PathType Leaf)) {
        throw 'Quarantine preflight did not reject an inexact repository-root quarantine parent without mutation.'
    }

    $nonChildSourceRejected = $false
    try {
        $null = Enter-Phase5PackageOutputQuarantineLease `
            -PackageOutput $packagePreflightOutput `
            -AllowedParent $packagePreflightOutput `
            -RepositoryRoot $temporaryParent `
            -QuarantineParent $packageQuarantineParent
    } catch {
        $nonChildSourceRejected = $_.Exception.Message -match 'strict child'
    }
    if (-not $nonChildSourceRejected -or
        -not (Test-Path -LiteralPath $packagePreflightSentinel -PathType Leaf)) {
        throw 'Quarantine preflight did not reject a source equal to its allowed parent without mutation.'
    }

    $originalQuarantineProof = @(Get-ChildItem -LiteralPath $packagePreflightOutput -Recurse -Force |
        ForEach-Object {
            $relativePath = $_.FullName.Substring($packagePreflightOutput.Length + 1)
            [pscustomobject][ordered]@{
                Key = ('{0}:{1}' -f $(if ($_.PSIsContainer) { 'D' } else { 'F' }), $relativePath)
                Sha256 = if ($_.PSIsContainer) { $null } else {
                    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
        } | Sort-Object Key)
    $packageQuarantineLease = Enter-Phase5PackageOutputQuarantineLease `
        -PackageOutput $packagePreflightOutput `
        -AllowedParent $packageArtifactsParent `
        -RepositoryRoot $temporaryParent `
        -QuarantineParent $packageQuarantineParent
    if (Test-Path -LiteralPath $packagePreflightOutput) {
        throw 'Quarantine lease did not atomically detach the original package-output namespace.'
    }
    if (-not (Test-Path -LiteralPath $packageQuarantineLease.QuarantinePath -PathType Container)) {
        throw 'Quarantine lease did not preserve a quarantined package-output tree.'
    }
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath((Split-Path -Parent $packageQuarantineLease.QuarantinePath)),
        [IO.Path]::GetFullPath($packageQuarantineParent),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Package output was not quarantined directly under the repository-root quarantine parent.'
    }
    $safeFilesystemScript = (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1').Replace("'", "''")
    $quarantineScript = (Join-Path $PSScriptRoot 'phase5-package-output-preflight.ps1').Replace("'", "''")
    $encodedMutexProbe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(@"
`$ErrorActionPreference = 'Stop'
. '$safeFilesystemScript'
. '$quarantineScript'
try {
    `$unexpectedLease = Enter-Phase5PackageOutputQuarantineLease -PackageOutput '$($packagePreflightOutput.Replace("'", "''"))' -AllowedParent '$($packageArtifactsParent.Replace("'", "''"))' -RepositoryRoot '$($temporaryParent.Replace("'", "''"))' -QuarantineParent '$($packageQuarantineParent.Replace("'", "''"))'
    try { Exit-Phase5PackageOutputQuarantineLease -Lease `$unexpectedLease } catch {}
    exit 91
} catch {
    if (`$_.Exception.Data['StableErrorCode'] -in @('PACKAGE_OUTPUT_REPOSITORY_BUSY', 'PACKAGE_OUTPUT_QUARANTINE_BUSY')) { exit 0 }
    exit 92
}
"@))
    & powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedMutexProbe
    if ($LASTEXITCODE -ne 0) {
        throw "A concurrent package process was not denied by the repository-stable lock; exit=$LASTEXITCODE."
    }
    $secondRepositoryLockRejected = $false
    try {
        $unexpectedRepositoryLock = [IO.File]::Open(
            $packageQuarantineLease.RepositoryLock.Path,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        $unexpectedRepositoryLock.Dispose()
    } catch {
        $secondRepositoryLockRejected = $true
    }
    if (-not $secondRepositoryLockRejected) {
        throw 'A second real lock-file object bypassed the repository-stable package lock.'
    }
    $leasedSentinel = Join-Path $packageQuarantineLease.QuarantinePath 'must-remain.txt'
    $leaseDeniedNewRead = $false
    try {
        $unexpectedRead = [IO.File]::Open(
            $leasedSentinel,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        $unexpectedRead.Dispose()
    } catch {
        $leaseDeniedNewRead = $true
    }
    if (-not $leaseDeniedNewRead) {
        throw 'Quarantine lease did not continuously deny a new read open during the atomic move validation window.'
    }
    $leaseDeniedWrite = $false
    try {
        $unexpectedWrite = [IO.File]::Open(
            $leasedSentinel,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        $unexpectedWrite.Dispose()
    } catch {
        $leaseDeniedWrite = $true
    }
    if (-not $leaseDeniedWrite) {
        throw 'Quarantine lease allowed an existing package file to be opened for writing.'
    }
    $leaseDeniedDelete = $false
    try {
        [IO.File]::Delete($leasedSentinel)
    } catch {
        $leaseDeniedDelete = $true
    }
    if (-not $leaseDeniedDelete -or -not (Test-Path -LiteralPath $leasedSentinel -PathType Leaf)) {
        throw 'Quarantine lease allowed an existing package file to be deleted.'
    }
    $leaseDeniedNewExecution = $false
    try {
        $unexpectedProcess = Start-Process `
            -FilePath (Join-Path $packageQuarantineLease.QuarantinePath 'desktop-translate-setup.exe') `
            -ArgumentList @('-n', '2', '127.0.0.1') -WindowStyle Hidden -PassThru -ErrorAction Stop
        try {
            if (-not $unexpectedProcess.HasExited) { $unexpectedProcess.Kill() }
            $null = $unexpectedProcess.WaitForExit(5000)
        } finally {
            $unexpectedProcess.Dispose()
        }
    } catch {
        $leaseDeniedNewExecution = $true
    }
    if (-not $leaseDeniedNewExecution) {
        throw 'Quarantine lease allowed a package executable to start during the atomic move validation window.'
    }

    $renamedQuarantineParent = $packageQuarantineParent + '-unexpected-rename'
    $parentRenameRejected = $false
    try {
        [IO.Directory]::Move($packageQuarantineParent, $renamedQuarantineParent)
    } catch {
        $parentRenameRejected = $true
    }
    if (-not $parentRenameRejected -or
        -not (Test-Path -LiteralPath $packageQuarantineParent -PathType Container) -or
        (Test-Path -LiteralPath $renamedQuarantineParent)) {
        throw 'Quarantine-parent identity lease did not block parent rename/replacement.'
    }

    $injectedQuarantineFile = Join-Path $packageQuarantineLease.QuarantinePath 'unexpected-injection.txt'
    Set-Content -LiteralPath $injectedQuarantineFile -Value 'must be detected' -Encoding UTF8
    $injectionDetected = $false
    try {
        Confirm-Phase5PackageOutputQuarantineLease -Lease $packageQuarantineLease
    } catch {
        $injectionDetected = $_.Exception.Data['StableErrorCode'] -eq 'PACKAGE_OUTPUT_QUARANTINE_CHANGED'
    }
    if (-not $injectionDetected) {
        throw 'Quarantine exact-set validation did not reject a newly injected entry.'
    }
    [IO.File]::Delete($injectedQuarantineFile)
    Confirm-Phase5PackageOutputQuarantineLease -Lease $packageQuarantineLease
    $preservedQuarantinePath = $packageQuarantineLease.QuarantinePath

    Set-Content -LiteralPath $injectedQuarantineFile -Value 'exit must detect and release' -Encoding UTF8
    $exitIntegrityRejected = $false
    try {
        Exit-Phase5PackageOutputQuarantineLease -Lease $packageQuarantineLease
    } catch {
        $exitIntegrityRejected = $_.Exception.Data['StableErrorCode'] -eq 'PACKAGE_OUTPUT_QUARANTINE_CHANGED'
    }
    if (-not $exitIntegrityRejected -or [bool]$packageQuarantineLease.Active) {
        throw 'Exit did not release every lease while propagating final exact-set integrity failure.'
    }
    [IO.File]::Delete($injectedQuarantineFile)
    $postExitRead = [IO.File]::Open(
        $leasedSentinel,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $postExitRead.Dispose()
    $postExitRepositoryLock = [IO.File]::Open(
        $packageQuarantineLease.RepositoryLock.Path,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    $postExitRepositoryLock.Dispose()
    [IO.Directory]::Move($packageQuarantineParent, $renamedQuarantineParent)
    [IO.Directory]::Move($renamedQuarantineParent, $packageQuarantineParent)
    $packageQuarantineLease = $null
    if (Test-Path -LiteralPath $packagePreflightOutput) {
        throw 'Quarantined package output was unexpectedly restored into the fresh build namespace.'
    }
    if (-not (Test-Path -LiteralPath $preservedQuarantinePath -PathType Container)) {
        throw 'Old package output was deleted instead of being retained for recovery.'
    }
    $preservedQuarantineProof = @(Get-ChildItem -LiteralPath $preservedQuarantinePath -Recurse -Force |
        ForEach-Object {
            $relativePath = $_.FullName.Substring($preservedQuarantinePath.Length + 1)
            [pscustomobject][ordered]@{
                Key = ('{0}:{1}' -f $(if ($_.PSIsContainer) { 'D' } else { 'F' }), $relativePath)
                Sha256 = if ($_.PSIsContainer) { $null } else {
                    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
        } | Sort-Object Key)
    if (($originalQuarantineProof | ConvertTo-Json -Compress) -cne
        ($preservedQuarantineProof | ConvertTo-Json -Compress)) {
        throw 'Atomic quarantine did not retain the complete old package tree byte-for-byte.'
    }
    New-Item -ItemType Directory -Path $packagePreflightOutput | Out-Null
    Set-Content -LiteralPath (Join-Path $packagePreflightOutput 'fresh-build.txt') `
        -Value 'fresh package namespace' -Encoding UTF8
    if (-not (Test-Path -LiteralPath (Join-Path $packagePreflightOutput 'fresh-build.txt') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $preservedQuarantinePath 'must-remain.txt') -PathType Leaf)) {
        throw 'Fresh build namespace creation partially restored or modified the old quarantine.'
    }
    $quarantineDirectories = @(Get-ChildItem -LiteralPath $packageQuarantineParent -Directory -Force)
    if ($quarantineDirectories.Count -ne 1 -or
        -not [string]::Equals(
            $quarantineDirectories[0].FullName,
            $preservedQuarantinePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Quarantine completion created a partial deletion or restoration tree.'
    }

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
    if ($null -ne $packageQuarantineLease) {
        try { Exit-Phase5PackageOutputQuarantineLease -Lease $packageQuarantineLease } catch {}
    }
    if ($null -ne $packagePreflightLockedStream) {
        try { $packagePreflightLockedStream.Dispose() } catch {}
    }
    if ($null -ne $packagePreflightProcess) {
        try {
            if (-not $packagePreflightProcess.HasExited) {
                $currentPreflightIdentity = Get-CimInstance -Query (
                    "SELECT ProcessId, ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId = $($packagePreflightProcess.Id)"
                ) | Select-Object -First 1
                if ($null -ne $currentPreflightIdentity -and
                    -not [string]::IsNullOrWhiteSpace([string]$currentPreflightIdentity.ExecutablePath) -and
                    $null -ne $packagePreflightCreationDateUtc -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath([string]$currentPreflightIdentity.ExecutablePath),
                        [IO.Path]::GetFullPath($packagePreflightExecutable),
                        [StringComparison]::OrdinalIgnoreCase
                    ) -and
                    [Math]::Abs((([DateTime]$currentPreflightIdentity.CreationDate).ToUniversalTime() - $packagePreflightCreationDateUtc).TotalSeconds) -le 1
                ) {
                    $packagePreflightProcess.Kill()
                    $null = $packagePreflightProcess.WaitForExit(5000)
                }
            }
        } finally {
            $packagePreflightProcess.Dispose()
        }
    }
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

Write-Host '[phase5:release-hardening:selftest] function order, safe temporary deletion, fail-closed process identity, complete recoverable package-output quarantine, PENDING/BLOCKED evidence, exclusive evidence roots, SignedRelease, and workspace identity negative gates PASS.'

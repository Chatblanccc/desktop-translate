[CmdletBinding()]
param(
    [Parameter()][ValidateSet('Dir', 'Installer')][string]$Mode = 'Dir',
    [Parameter()][string]$EvidenceRoot,
    [Parameter()][switch]$SkipBuild,
    [Parameter()][switch]$SignedRelease,
    [Parameter()][string]$ExpectedPublisherSubject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$desktopRoot = Join-Path $root 'apps\desktop'
$stageRoot = Join-Path $desktopRoot '.vite\phase5-resources'
$packageOutput = Join-Path $root 'artifacts\phase5\package\dist'
$winUnpacked = Join-Path $packageOutput 'win-unpacked'
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )
    Write-Host "[phase5:package] $Label"
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "External command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
    }
}

if ($SignedRelease) {
    if ($Mode -ne 'Installer') { throw 'RELEASE BLOCKED: signed release mode requires -Mode Installer.' }
    if ($SkipBuild) { throw 'RELEASE BLOCKED: signed release mode forbids -SkipBuild; every protected candidate must be rebuilt from clean HEAD.' }
    if (-not $ExpectedPublisherSubject) { throw 'RELEASE BLOCKED: -ExpectedPublisherSubject is required for signed release mode.' }
    if (-not $env:CSC_LINK -and -not $env:WIN_CSC_LINK) {
        throw 'RELEASE BLOCKED: no protected electron-builder signing identity (CSC_LINK/WIN_CSC_LINK) is available.'
    }
} else {
    # Deterministic PR/local packaging is intentionally unsigned even if a
    # developer shell happens to contain signing variables.
    $savedSigningEnvironment = @{}
    foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD')) {
        $savedSigningEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

$workspaceStateTemporary = $null
try {
$gitSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[0-9a-f]{40}$') { throw 'Unable to resolve a full git SHA.' }
$expectedHead = if ($env:GITHUB_SHA) { $env:GITHUB_SHA.ToLowerInvariant() } else { $gitSha }
if (-not $EvidenceRoot) {
    $runId = if ($env:GITHUB_RUN_ID) {
        $runAttempt = if ($env:GITHUB_RUN_ATTEMPT) { $env:GITHUB_RUN_ATTEMPT } else { '1' }
        "$($env:GITHUB_RUN_ID)-$runAttempt"
    } else {
        'local-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + "-pid$PID-" + [guid]::NewGuid().ToString('N')
    }
    $EvidenceRoot = Join-Path $root "artifacts\phase5\$gitSha\$runId"
}
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$evidenceParent = Split-Path -Parent $EvidenceRoot
if (-not $evidenceParent) { throw "Evidence root must have a parent directory: $EvidenceRoot" }
New-Item -ItemType Directory -Force -Path $evidenceParent | Out-Null
Assert-Phase5NoReparsePoint -Path $EvidenceRoot -AllowedParent $evidenceParent
if (Test-Path -LiteralPath $EvidenceRoot) {
    throw "Phase 5 evidence root already exists; use a unique run directory: $EvidenceRoot"
}
try {
    New-Item -ItemType Directory -Path $EvidenceRoot -ErrorAction Stop | Out-Null
} catch {
    throw "Phase 5 evidence root could not be created atomically and exclusively: $EvidenceRoot. $($_.Exception.Message)"
}
$workspaceStateTemporary = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-workspace-' + [guid]::NewGuid().ToString('N') + '.json')
Invoke-CheckedExternal -Label 'Capture immutable Git/worktree source identity' -FilePath 'node' -ArgumentList @(
    (Join-Path $root 'tooling\supply-chain\capture-phase5-workspace-state.mjs'),
    '--output', $workspaceStateTemporary,
    '--mode', $(if ($SignedRelease) { 'signed' } else { 'unsigned' }),
    '--expected-head', $expectedHead
)
$workspaceStatePath = Join-Path $EvidenceRoot 'build\workspace-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $workspaceStatePath) | Out-Null
Copy-Item -LiteralPath $workspaceStateTemporary -Destination $workspaceStatePath -Force

    $rootPackage = Get-Content -LiteralPath (Join-Path $root 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if (-not ($rootPackage.devDependencies.PSObject.Properties.Name -contains 'electron-builder')) {
        throw 'Phase 5 packaging requires a pinned electron-builder development dependency in the root package.json.'
    }
    if (-not ($rootPackage.devDependencies.PSObject.Properties.Name -contains '@electron/asar')) {
        throw 'Phase 5 package verification requires a pinned @electron/asar development dependency in the root package.json.'
    }
    Invoke-CheckedExternal -Label 'Verify exact electron-builder Host signing policy' -FilePath 'node' -ArgumentList @(
        (Join-Path $PSScriptRoot 'phase5-electron-builder-policy.mjs'),
        '--config', (Join-Path $desktopRoot 'electron-builder.yml')
    )

    if (-not $SkipBuild) {
        $savedBuildFlavor = [Environment]::GetEnvironmentVariable('DESKTOP_TRANSLATE_BUILD_FLAVOR', [EnvironmentVariableTarget]::Process)
        try {
            [Environment]::SetEnvironmentVariable('DESKTOP_TRANSLATE_BUILD_FLAVOR', 'production', [EnvironmentVariableTarget]::Process)
            Invoke-CheckedExternal -Label 'Production Electron build' -FilePath 'pnpm' -ArgumentList @(
                '--config.verify-deps-before-run=false', '--filter', '@desktop-translate/desktop', 'build'
            )
        } finally {
            [Environment]::SetEnvironmentVariable('DESKTOP_TRANSLATE_BUILD_FLAVOR', $savedBuildFlavor, [EnvironmentVariableTarget]::Process)
        }
    }

    $nativeBuildArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-native-release.ps1'))
    if ($SkipBuild) { $nativeBuildArguments += '-SkipBuild' }
    $nativeOutput = & powershell @nativeBuildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Phase 5 Native release build/verification failed.' }
    $nativeHost = [string]($nativeOutput | Select-Object -Last 1)
    if (-not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) { throw "Native Host output is missing: $nativeHost" }
    $nativeBuildRoot = Split-Path -Parent (Split-Path -Parent $nativeHost)
    $nativeMetadata = Join-Path $nativeBuildRoot 'native-build-metadata.json'
    if (-not (Test-Path -LiteralPath $nativeMetadata -PathType Leaf)) { throw 'Native build metadata is missing.' }

    Remove-Phase5DirectoryTree -AllowedParent (Join-Path $desktopRoot '.vite') -Path $stageRoot
    New-Item -ItemType Directory -Force -Path `
        (Join-Path $stageRoot 'selection-host'), `
        (Join-Path $stageRoot 'migrations') | Out-Null
    Copy-Item -LiteralPath $nativeHost -Destination (Join-Path $stageRoot 'selection-host\selection-host.exe')
    $migrationFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'packages\storage\migrations') -File -Filter '*.sql')
    if ($migrationFiles.Count -eq 0) { throw 'No storage migrations were found for packaging.' }
    foreach ($migrationFile in $migrationFiles) {
        Copy-Item -LiteralPath $migrationFile.FullName -Destination (Join-Path $stageRoot 'migrations')
    }

    Invoke-CheckedExternal -Label 'Generate SBOM, notices, staged checksums, and draft evidence manifest' -FilePath 'node' -ArgumentList @(
        (Join-Path $root 'tooling\supply-chain\generate-phase5-supply-chain.mjs'),
        '--stage-dir', $stageRoot,
        '--native-host', (Join-Path $stageRoot 'selection-host\selection-host.exe'),
        '--native-metadata', $nativeMetadata,
        '--evidence-dir', $EvidenceRoot,
        '--workspace-state', $workspaceStatePath
    )
    Invoke-CheckedExternal -Label 'Verify staged supply chain' -FilePath 'node' -ArgumentList @(
        (Join-Path $root 'tooling\supply-chain\verify-phase5-supply-chain.mjs'),
        '--stage-dir', $stageRoot
    )

    Remove-Phase5DirectoryTree -AllowedParent (Join-Path $root 'artifacts\phase5') -Path $packageOutput
    $builderArguments = @(
        '--config.verify-deps-before-run=false',
        'exec', 'electron-builder',
        '--config', 'electron-builder.yml', '--win', '--x64'
    )
    if ($Mode -eq 'Dir') { $builderArguments += '--dir' }
    Push-Location $desktopRoot
    try {
        Invoke-CheckedExternal -Label "electron-builder $Mode" -FilePath 'pnpm' -ArgumentList $builderArguments
    } finally {
        Pop-Location
    }

    # electron-builder writes an implementation-detail builder-debug.yml beside
    # the distributable artifacts.  The file embeds absolute workspace, TEMP,
    # and cache paths and is neither a release artifact nor admissible evidence.
    # Delete only that exact regular file, then fail closed if it remains.
    $builderDebugPath = [IO.Path]::GetFullPath((Join-Path $packageOutput 'builder-debug.yml'))
    if (Test-Path -LiteralPath $builderDebugPath) {
        Assert-Phase5NoReparsePoint -Path $builderDebugPath -AllowedParent $packageOutput
        $builderDebugItem = Get-Item -LiteralPath $builderDebugPath -Force
        if ($builderDebugItem.PSIsContainer) {
            throw "Refusing to remove unexpected builder-debug directory: $builderDebugPath"
        }
        [IO.File]::Delete($builderDebugItem.FullName)
    }
    if (Test-Path -LiteralPath $builderDebugPath) {
        throw "electron-builder debug metadata containing local paths remained in package output: $builderDebugPath"
    }

    if (-not (Test-Path -LiteralPath $winUnpacked -PathType Container)) {
        throw "electron-builder did not produce win-unpacked: $winUnpacked"
    }
    $installer = $null
    if ($Mode -eq 'Installer') {
        $installers = @(Get-ChildItem -LiteralPath $packageOutput -File -Filter '*-setup.exe')
        if ($installers.Count -ne 1) { throw "Expected exactly one NSIS setup executable, found $($installers.Count)." }
        $installer = $installers[0].FullName
    }

    $verifyArguments = @(
        (Join-Path $root 'tooling\packaging\phase5-package-verify.mjs'),
        '--package-dir', $winUnpacked,
        '--evidence-dir', $EvidenceRoot
    )
    if ($installer) { $verifyArguments += @('--installer', $installer) }
    Invoke-CheckedExternal -Label 'Verify packaged allowlists, ASAR, checksums, and budgets' -FilePath 'node' -ArgumentList $verifyArguments
    Invoke-CheckedExternal -Label 'Verify staged resources survived packaging byte-for-byte' -FilePath 'node' -ArgumentList @(
        (Join-Path $root 'tooling\supply-chain\verify-phase5-supply-chain.mjs'),
        '--stage-dir', $stageRoot,
        '--package-dir', $winUnpacked
    )
    Write-Host '[phase5:package] Run isolated unpacked startup/resource smoke'
    & (Join-Path $PSScriptRoot 'phase5-clean-package-smoke.ps1') `
        -PackageDirectory $winUnpacked `
        -EvidenceDirectory $EvidenceRoot

    $signParameters = @{
        PackageDirectory = $winUnpacked
        EvidenceDirectory = $EvidenceRoot
    }
    if ($installer) { $signParameters.InstallerPath = $installer }
    if ($ExpectedPublisherSubject) { $signParameters.ExpectedSubject = $ExpectedPublisherSubject }
    if ($SignedRelease) { $signParameters.RequireSigned = $true }
    & (Join-Path $root 'tooling\supply-chain\phase5-sign-verify.ps1') @signParameters

    $evidenceArguments = @(
        (Join-Path $root 'tooling\supply-chain\verify-phase5-evidence.mjs'),
        '--evidence-dir', $EvidenceRoot,
        '--package-dir', $winUnpacked,
        '--release-mode', $(if ($SignedRelease) { 'signed' } else { 'unsigned' })
    )
    if ($installer) { $evidenceArguments += @('--installer', $installer) }
    Invoke-CheckedExternal -Label 'Verify release evidence manifest traceability' -FilePath 'node' -ArgumentList $evidenceArguments

    Write-Host "[phase5:package] Evidence root: $EvidenceRoot"
    Write-Host "[phase5:package] Package output: $packageOutput"
    if (-not $SignedRelease) {
        Write-Host '[phase5:package] Development/unsigned package gates PASS; final status is RELEASE BLOCKED and is not HEAD acceptance evidence.'
    } else {
        Write-Host '[phase5:package] Authenticode gates PASS; final status remains RELEASE BLOCKED until GitHub provenance and clean-download verification pass.'
        if ($env:GITHUB_ACTIONS -ne 'true' -or
            [string]::IsNullOrWhiteSpace($env:ACTIONS_ID_TOKEN_REQUEST_URL) -or
            [string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY) -or
            [string]::IsNullOrWhiteSpace($env:GITHUB_REF)) {
            throw 'RELEASE BLOCKED: SignedRelease has no protected GitHub Actions OIDC/attestation context.'
        }
    }
} finally {
    if (-not $SignedRelease) {
        foreach ($name in $savedSigningEnvironment.Keys) {
            if ($null -eq $savedSigningEnvironment[$name]) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($name, $savedSigningEnvironment[$name], [EnvironmentVariableTarget]::Process)
            }
        }
    }
    if ($workspaceStateTemporary -and (Test-Path -LiteralPath $workspaceStateTemporary -PathType Leaf)) {
        Remove-Item -LiteralPath $workspaceStateTemporary -Force
    }
}

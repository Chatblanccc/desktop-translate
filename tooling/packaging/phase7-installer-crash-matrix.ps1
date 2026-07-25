[CmdletBinding()]
param(
    [Parameter()]
    [string]$CandidatePath = 'artifacts\phase5\package\dist\Desktop-Translate-0.5.0-phase5-x64-setup.exe',

    [Parameter()]
    [string]$EvidencePath = 'artifacts\phase7\installer-crash-matrix.json',

    [Parameter()]
    [ValidateRange(1, 10)]
    [int]$MaxAttemptsPerCheckpoint = 4,

    [Parameter()]
    [ValidateRange(5, 120)]
    [int]$WatchTimeoutSeconds = 30,

    [Parameter()]
    [switch]$RemoveFinalInstall,

    [Parameter()]
    [switch]$StaticSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appGuid = '5baab977-0efe-5c82-9f9c-b3786aa388e3'
$installRegistrySubKey = "Software\$appGuid"
$uninstallRegistrySubKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$appGuid"
$transactionRegistrySubKey = "$installRegistrySubKey.Phase7UninstallTransaction"
$backupRegistrySubKey = "Software\DesktopTranslatePhase7RegistryBackups\$appGuid"
$stagePrefix = ".desktop-translate-stage-$appGuid-"
$stableMarkerName = '.desktop-translate-install-root-v1'
$stableMarkerValue = "DesktopTranslate.InstallRoot.v1|$appGuid"
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\desktop-translate'
$installParent = Split-Path -Parent $installRoot
$userDataDatabase = Join-Path $env:APPDATA '@desktop-translate\desktop\desktop-translate.sqlite3'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$forwardCheckpoints = @(
    'prepared',
    'staged-uncommitted',
    'registry-backups-ready',
    'registry-delete-started',
    'committed-cleanup',
    'committed-postcleanup'
)

$rollbackCases = @(
    [ordered]@{ checkpoint = 'rollback-pending'; precursor = 'prepared' },
    [ordered]@{ checkpoint = 'rollback-backups-ready'; precursor = 'registry-backups-ready' },
    [ordered]@{ checkpoint = 'rollback-rebuild-ready'; precursor = 'registry-delete-started' },
    [ordered]@{ checkpoint = 'rollback-registry-restored'; precursor = 'registry-delete-started' }
)

$allCheckpoints = @(
    $forwardCheckpoints
    $rollbackCases.checkpoint
)

function Assert-Condition {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function ConvertTo-PortablePath {
    param(
        [AllowNull()]
        [string]$PathValue
    )

    if ($null -eq $PathValue) {
        return $null
    }

    $portable = $PathValue
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $portable = $portable.Replace($env:USERPROFILE, '<USERPROFILE>')
    }
    $portable = $portable.Replace($repositoryRoot, '<REPOSITORY>')
    return $portable
}

function Get-RegistryPath {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey
    )

    return "Registry::HKEY_CURRENT_USER\$SubKey"
}

function Test-RegistryKey {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey
    )

    return Test-Path -LiteralPath (Get-RegistryPath -SubKey $SubKey)
}

function Get-OptionalFileHash {
    param(
        [Parameter(Mandatory)]
        [string]$LiteralPath
    )

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return $null
    }

    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OptionalPropertyString {
    param(
        [Parameter(Mandatory)]
        [psobject]$InputObject,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ''
    }
    return [string]$property.Value
}

function Get-InstalledRegistrySnapshot {
    $installPath = Get-RegistryPath -SubKey $installRegistrySubKey
    $uninstallPath = Get-RegistryPath -SubKey $uninstallRegistrySubKey
    Assert-Condition (Test-Path -LiteralPath $installPath) "Missing product registry key: $installPath"
    Assert-Condition (Test-Path -LiteralPath $uninstallPath) "Missing uninstall registry key: $uninstallPath"

    $install = Get-ItemProperty -LiteralPath $installPath
    $uninstall = Get-ItemProperty -LiteralPath $uninstallPath
    return [ordered]@{
        installLocation = ConvertTo-PortablePath ([string]$install.InstallLocation)
        keepShortcuts = [string]$install.KeepShortcuts
        shortcutName = [string]$install.ShortcutName
        menuDirectory = Get-OptionalPropertyString -InputObject $install -Name 'MenuDirectory'
        uninstallString = ConvertTo-PortablePath ([string]$uninstall.UninstallString)
        quietUninstallString = ConvertTo-PortablePath ([string]$uninstall.QuietUninstallString)
        displayVersion = [string]$uninstall.DisplayVersion
    }
}

function Get-InstalledFileSnapshot {
    $markerPath = Join-Path $installRoot $stableMarkerName
    $applicationPath = Join-Path $installRoot 'desktop-translate.exe'
    $uninstallerPath = Join-Path $installRoot 'Uninstall desktop-translate.exe'
    Assert-Condition (Test-Path -LiteralPath $markerPath -PathType Leaf) "Missing stable marker: $markerPath"
    Assert-Condition (Test-Path -LiteralPath $applicationPath -PathType Leaf) "Missing application: $applicationPath"
    Assert-Condition (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) "Missing uninstaller: $uninstallerPath"
    Assert-Condition ((Get-Content -Raw -LiteralPath $markerPath) -ceq $stableMarkerValue) 'Stable marker content mismatch.'

    return [ordered]@{
        markerSha256 = Get-OptionalFileHash -LiteralPath $markerPath
        applicationSha256 = Get-OptionalFileHash -LiteralPath $applicationPath
        uninstallerSha256 = Get-OptionalFileHash -LiteralPath $uninstallerPath
        userDataDatabaseSha256 = Get-OptionalFileHash -LiteralPath $userDataDatabase
    }
}

function Get-StageDirectories {
    if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
        return @()
    }

    return @(
        Get-ChildItem -LiteralPath $installParent -Force -Directory -ErrorAction Stop |
            Where-Object { $_.Name.StartsWith($stagePrefix, [StringComparison]::Ordinal) }
    )
}

function Get-RelatedProcesses {
    $candidateLeaf = [IO.Path]::GetFileName($script:resolvedCandidatePath)
    return @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)) {
                    return $false
                }

                $path = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
                return $path.StartsWith(
                    "$installRoot\",
                    [StringComparison]::OrdinalIgnoreCase
                ) -or
                [IO.Path]::GetFileName($path).Equals(
                    $candidateLeaf,
                    [StringComparison]::OrdinalIgnoreCase
                ) -or
                [IO.Path]::GetFileName($path).Equals(
                    'phase7-uninstall-crash-probe.exe',
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    )
}

function Get-TransactionSnapshot {
    $transactionPath = Get-RegistryPath -SubKey $transactionRegistrySubKey
    $transaction = $null
    if (Test-Path -LiteralPath $transactionPath) {
        $raw = Get-ItemProperty -LiteralPath $transactionPath
        $transaction = [ordered]@{
            identity = [string]$raw.Identity
            state = [string]$raw.State
            sourceRoot = ConvertTo-PortablePath ([string]$raw.SourceRoot)
            stagePath = ConvertTo-PortablePath ([string]$raw.StagePath)
            ownerPid = [string]$raw.OwnerPid
            ownerCreationLow = [string]$raw.OwnerCreationLow
            ownerCreationHigh = [string]$raw.OwnerCreationHigh
            rootVolumeSerial = [string]$raw.RootVolumeSerial
            rootFileIndexHigh = [string]$raw.RootFileIndexHigh
            rootFileIndexLow = [string]$raw.RootFileIndexLow
            cleanupVersion = [string]$raw.CleanupVersion
            keepShortcuts = [string]$raw.KeepShortcuts
            shortcutName = [string]$raw.ShortcutName
            menuDirectory = [string]$raw.MenuDirectory
            deleteAppData = [string]$raw.DeleteAppData
        }
    }

    $stages = @(Get-StageDirectories)
    return [ordered]@{
        transactionPresent = $null -ne $transaction
        transaction = $transaction
        sourceRootPresent = Test-Path -LiteralPath $installRoot -PathType Container
        productRegistryPresent = Test-RegistryKey -SubKey $installRegistrySubKey
        uninstallRegistryPresent = Test-RegistryKey -SubKey $uninstallRegistrySubKey
        backupRootPresent = Test-RegistryKey -SubKey $backupRegistrySubKey
        backupInstallPresent = Test-RegistryKey -SubKey "$backupRegistrySubKey\Install"
        backupUninstallPresent = Test-RegistryKey -SubKey "$backupRegistrySubKey\Uninstall"
        stageCount = $stages.Count
        stagePaths = @($stages | ForEach-Object { ConvertTo-PortablePath $_.FullName })
        relatedProcessCount = @(Get-RelatedProcesses).Count
    }
}

function Assert-StableInstalledState {
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$ExpectedRegistry,

        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$ExpectedFiles
    )

    Assert-Condition (Test-Path -LiteralPath $installRoot -PathType Container) 'Stable install root is absent.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $transactionRegistrySubKey)) 'Transaction key remains after recovery.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $backupRegistrySubKey)) 'Registry backup remains after recovery.'
    Assert-Condition (@(Get-StageDirectories).Count -eq 0) 'A Phase 7 staging directory remains after recovery.'
    Assert-Condition (@(Get-RelatedProcesses).Count -eq 0) 'A related installer, application, or probe process remains.'

    $actualRegistry = Get-InstalledRegistrySnapshot
    $actualFiles = Get-InstalledFileSnapshot
    Assert-Condition (
        (ConvertTo-Json $actualRegistry -Compress) -ceq (ConvertTo-Json $ExpectedRegistry -Compress)
    ) 'The installed registry snapshot changed after recovery.'
    Assert-Condition (
        (ConvertTo-Json $actualFiles -Compress) -ceq (ConvertTo-Json $ExpectedFiles -Compress)
    ) 'The installed file or retained user-data snapshot changed after recovery.'
}

function Invoke-CandidateInstall {
    $process = Start-Process -FilePath $script:resolvedCandidatePath `
        -ArgumentList @('/S', '/currentuser') `
        -PassThru `
        -Wait
    Assert-Condition ($process.ExitCode -eq 0) "Candidate install/recovery exited $($process.ExitCode)."
}

function Initialize-Watchdog {
    if ('DesktopTranslatePhase7CrashWatchdog' -as [type]) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

public static class DesktopTranslatePhase7CrashWatchdog
{
    public static volatile int TargetPid;
    public static volatile string ObservedState = "";
    public static volatile bool Killed;
    public static volatile bool StopRequested;
    public static volatile string Error = "";

    public static Task Start(string registrySubKey, string desiredState, int timeoutMilliseconds)
    {
        TargetPid = 0;
        ObservedState = "";
        Killed = false;
        StopRequested = false;
        Error = "";

        return Task.Run(() =>
        {
            Thread.CurrentThread.Priority = ThreadPriority.Highest;
            var timer = Stopwatch.StartNew();
            RegistryKey transaction = null;
            try
            {
                using (var hive = RegistryKey.OpenBaseKey(
                    RegistryHive.CurrentUser,
                    RegistryView.Registry64))
                {
                    while (!StopRequested && timer.ElapsedMilliseconds < timeoutMilliseconds)
                    {
                        if (transaction == null)
                        {
                            transaction = hive.OpenSubKey(registrySubKey, false);
                            if (transaction == null)
                            {
                                Thread.SpinWait(128);
                                continue;
                            }
                        }

                        string state;
                        try
                        {
                            state = transaction.GetValue("State") as string;
                        }
                        catch
                        {
                            transaction.Dispose();
                            transaction = null;
                            continue;
                        }

                        if (!String.IsNullOrEmpty(state))
                        {
                            ObservedState = state;
                        }

                        if (state == desiredState && TargetPid > 0)
                        {
                            try
                            {
                                using (var process = Process.GetProcessById(TargetPid))
                                {
                                    process.Kill();
                                    Killed = true;
                                }
                            }
                            catch (Exception error)
                            {
                                Error = error.GetType().Name + ": " + error.Message;
                            }
                            return;
                        }

                        Thread.SpinWait(32);
                    }
                }
            }
            catch (Exception error)
            {
                Error = error.GetType().Name + ": " + error.Message;
            }
            finally
            {
                if (transaction != null)
                {
                    transaction.Dispose();
                }
            }
        });
    }

    public static void Stop()
    {
        StopRequested = true;
    }
}
'@
}

function New-ProbeDirectory {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $path = Join-Path $tempRoot ("desktop-translate-phase7-crash-" + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $path
    return [IO.Path]::GetFullPath($path)
}

function Remove-ProbeDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$LiteralPath
    )

    $resolved = [IO.Path]::GetFullPath($LiteralPath)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    Assert-Condition (
        $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)
    ) "Refusing to remove a probe directory outside TEMP: $resolved"
    Assert-Condition (
        [IO.Path]::GetFileName($resolved).StartsWith(
            'desktop-translate-phase7-crash-',
            [StringComparison]::Ordinal
        )
    ) "Refusing to remove an unexpected TEMP path: $resolved"

    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Invoke-WatchedProcess {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('uninstaller', 'installer-recovery')]
        [string]$LaunchKind,

        [Parameter(Mandatory)]
        [string]$Checkpoint
    )

    $probeDirectory = $null
    $process = $null
    try {
        if ($LaunchKind -eq 'uninstaller') {
            $installedUninstaller = Join-Path $installRoot 'Uninstall desktop-translate.exe'
            Assert-Condition (
                Test-Path -LiteralPath $installedUninstaller -PathType Leaf
            ) "Installed uninstaller is absent: $installedUninstaller"
            $probeDirectory = New-ProbeDirectory
            $executable = Join-Path $probeDirectory 'phase7-uninstall-crash-probe.exe'
            Copy-Item -LiteralPath $installedUninstaller -Destination $executable
            $arguments = @('/S', '/currentuser', "_?=$installRoot")
        } else {
            $executable = $script:resolvedCandidatePath
            $arguments = @('/S', '/currentuser')
        }

        $watch = [DesktopTranslatePhase7CrashWatchdog]::Start(
            $transactionRegistrySubKey,
            $Checkpoint,
            $WatchTimeoutSeconds * 1000
        )
        $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru
        [DesktopTranslatePhase7CrashWatchdog]::TargetPid = $process.Id

        $deadline = [DateTime]::UtcNow.AddSeconds($WatchTimeoutSeconds + 10)
        while (-not $watch.IsCompleted -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 10
        }

        if ($process.HasExited -and -not $watch.IsCompleted) {
            [DesktopTranslatePhase7CrashWatchdog]::Stop()
        }
        if (-not $watch.Wait(10000)) {
            [DesktopTranslatePhase7CrashWatchdog]::Stop()
            $null = $watch.Wait(5000)
        }
        if (-not $process.HasExited) {
            $null = $process.WaitForExit(10000)
        }

        $exitCode = $null
        if ($process.HasExited) {
            $exitCode = $process.ExitCode
        }

        $snapshot = Get-TransactionSnapshot
        return [ordered]@{
            checkpoint = $Checkpoint
            launchKind = $LaunchKind
            processId = $process.Id
            killed = [DesktopTranslatePhase7CrashWatchdog]::Killed
            observedState = [DesktopTranslatePhase7CrashWatchdog]::ObservedState
            watchdogError = [DesktopTranslatePhase7CrashWatchdog]::Error
            processExited = $process.HasExited
            processExitCode = $exitCode
            snapshot = $snapshot
        }
    } finally {
        if ($null -ne $process -and -not $process.HasExited) {
            $process.Kill()
            $null = $process.WaitForExit(10000)
        }
        if ($null -ne $probeDirectory) {
            Remove-ProbeDirectory -LiteralPath $probeDirectory
        }
    }
}

function Invoke-CrashCheckpoint {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('uninstaller', 'installer-recovery')]
        [string]$LaunchKind,

        [Parameter(Mandatory)]
        [string]$Checkpoint
    )

    $attempts = @()
    for ($attempt = 1; $attempt -le $MaxAttemptsPerCheckpoint; $attempt++) {
        $result = Invoke-WatchedProcess -LaunchKind $LaunchKind -Checkpoint $Checkpoint
        $result.attempt = $attempt
        $attempts += $result

        if ($result.killed -and $result.observedState -ceq $Checkpoint) {
            Assert-Condition $result.processExited "Checkpoint $Checkpoint process did not exit after kill."
            Assert-Condition $result.snapshot.transactionPresent "Checkpoint $Checkpoint did not retain a transaction."
            Assert-Condition (
                $result.snapshot.transaction.state -ceq $Checkpoint
            ) "Checkpoint $Checkpoint retained state $($result.snapshot.transaction.state)."
            return [ordered]@{
                checkpoint = $Checkpoint
                launchKind = $LaunchKind
                attempts = $attempt
                caught = $true
                crash = $result
                missedAttempts = @($attempts | Select-Object -SkipLast 1)
            }
        }

        if ($LaunchKind -eq 'uninstaller') {
            Invoke-CandidateInstall
        } else {
            throw "Recovery checkpoint $Checkpoint was missed; its precursor transaction is no longer deterministic."
        }
    }

    throw "Could not catch checkpoint $Checkpoint after $MaxAttemptsPerCheckpoint attempts."
}

function Invoke-NormalFinalUninstall {
    $probeDirectory = New-ProbeDirectory
    try {
        $installedUninstaller = Join-Path $installRoot 'Uninstall desktop-translate.exe'
        $probe = Join-Path $probeDirectory 'phase7-uninstall-crash-probe.exe'
        Copy-Item -LiteralPath $installedUninstaller -Destination $probe
        $process = Start-Process -FilePath $probe `
            -ArgumentList @('/S', '/currentuser', "_?=$installRoot") `
            -PassThru `
            -Wait
        Assert-Condition ($process.ExitCode -eq 0) "Final inner uninstaller exited $($process.ExitCode)."
    } finally {
        Remove-ProbeDirectory -LiteralPath $probeDirectory
    }
}

function Invoke-StaticSelfTest {
    Initialize-Watchdog
    $installerInclude = Get-Content -Raw -LiteralPath (
        Join-Path $repositoryRoot 'apps\desktop\build\installer.nsh'
    )
    foreach ($checkpoint in $allCheckpoints) {
        Assert-Condition (
            $installerInclude.IndexOf(
                "`"$checkpoint`"",
                [StringComparison]::Ordinal
            ) -ge 0
        ) "Installer include does not contain durable checkpoint $checkpoint."
    }
    Assert-Condition (
        $installerInclude.IndexOf(
            'CrashWatchdog',
            [StringComparison]::OrdinalIgnoreCase
        ) -lt 0
    ) 'Production installer include must not contain the external crash watchdog.'
    Assert-Condition (
        ($allCheckpoints | Select-Object -Unique).Count -eq 10
    ) 'Crash matrix must contain ten unique durable checkpoints.'

    [ordered]@{
        schema = 'phase7-installer-crash-matrix-static-selftest-v1'
        status = 'PASS'
        checkpointCount = $allCheckpoints.Count
        checkpoints = $allCheckpoints
        productionFaultHookPresent = $false
        watchdogCompiled = $true
        systemMutationPerformed = $false
    } | ConvertTo-Json -Depth 8
}

if ($StaticSelfTest) {
    Invoke-StaticSelfTest
    exit 0
}

Initialize-Watchdog

$candidateCandidate = if ([IO.Path]::IsPathRooted($CandidatePath)) {
    $CandidatePath
} else {
    Join-Path $repositoryRoot $CandidatePath
}
$script:resolvedCandidatePath = [IO.Path]::GetFullPath($candidateCandidate)
Assert-Condition (
    Test-Path -LiteralPath $script:resolvedCandidatePath -PathType Leaf
) "Candidate installer is absent: $($script:resolvedCandidatePath)"
$candidateItem = Get-Item -LiteralPath $script:resolvedCandidatePath -Force
Assert-Condition (
    -not (($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
) 'Candidate installer must not be a reparse point.'

$candidateHash = (Get-FileHash -LiteralPath $script:resolvedCandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateSignature = Get-AuthenticodeSignature -LiteralPath $script:resolvedCandidatePath
$headSha = (& git -C $repositoryRoot rev-parse HEAD).Trim()
Assert-Condition ($LASTEXITCODE -eq 0) 'Could not resolve repository HEAD.'

$initialState = [ordered]@{
    rootPresent = Test-Path -LiteralPath $installRoot -PathType Container
    productRegistryPresent = Test-RegistryKey -SubKey $installRegistrySubKey
    uninstallRegistryPresent = Test-RegistryKey -SubKey $uninstallRegistrySubKey
    transactionPresent = Test-RegistryKey -SubKey $transactionRegistrySubKey
    backupPresent = Test-RegistryKey -SubKey $backupRegistrySubKey
    stageCount = @(Get-StageDirectories).Count
}

Assert-Condition (-not $initialState.transactionPresent) 'An existing Phase 7 transaction must be recovered before the matrix starts.'
Assert-Condition (-not $initialState.backupPresent) 'An existing Phase 7 registry backup must be recovered before the matrix starts.'
Assert-Condition ($initialState.stageCount -eq 0) 'An existing Phase 7 staging directory must be recovered before the matrix starts.'
Assert-Condition (@(Get-RelatedProcesses).Count -eq 0) 'A related product or installer process is running before the matrix starts.'

Invoke-CandidateInstall
$baselineRegistry = Get-InstalledRegistrySnapshot
$baselineFiles = Get-InstalledFileSnapshot
Assert-StableInstalledState -ExpectedRegistry $baselineRegistry -ExpectedFiles $baselineFiles

$matrix = @()
foreach ($checkpoint in $forwardCheckpoints) {
    $case = Invoke-CrashCheckpoint -LaunchKind uninstaller -Checkpoint $checkpoint
    Invoke-CandidateInstall
    Assert-StableInstalledState -ExpectedRegistry $baselineRegistry -ExpectedFiles $baselineFiles
    $case.recovery = [ordered]@{
        candidateExitCode = 0
        stableRegistryEqual = $true
        stableFilesAndUserDataEqual = $true
        transactionPresent = $false
        backupPresent = $false
        stageCount = 0
        relatedProcessCount = 0
    }
    $matrix += $case
}

foreach ($rollbackCase in $rollbackCases) {
    $precursor = Invoke-CrashCheckpoint `
        -LaunchKind uninstaller `
        -Checkpoint $rollbackCase.precursor
    $case = Invoke-CrashCheckpoint `
        -LaunchKind installer-recovery `
        -Checkpoint $rollbackCase.checkpoint
    Invoke-CandidateInstall
    Assert-StableInstalledState -ExpectedRegistry $baselineRegistry -ExpectedFiles $baselineFiles
    $case.precursor = [ordered]@{
        checkpoint = $rollbackCase.precursor
        attempts = $precursor.attempts
        caught = $precursor.caught
        crash = $precursor.crash
    }
    $case.recovery = [ordered]@{
        candidateExitCode = 0
        stableRegistryEqual = $true
        stableFilesAndUserDataEqual = $true
        transactionPresent = $false
        backupPresent = $false
        stageCount = 0
        relatedProcessCount = 0
    }
    $matrix += $case
}

$finalAction = 'retained-stable-install'
if ($RemoveFinalInstall) {
    Invoke-NormalFinalUninstall
    Assert-Condition (-not (Test-Path -LiteralPath $installRoot)) 'Install root remains after final uninstall.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $installRegistrySubKey)) 'Product registry remains after final uninstall.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $uninstallRegistrySubKey)) 'Uninstall registry remains after final uninstall.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $transactionRegistrySubKey)) 'Transaction remains after final uninstall.'
    Assert-Condition (-not (Test-RegistryKey -SubKey $backupRegistrySubKey)) 'Registry backup remains after final uninstall.'
    Assert-Condition (@(Get-StageDirectories).Count -eq 0) 'Stage remains after final uninstall.'
    Assert-Condition (@(Get-RelatedProcesses).Count -eq 0) 'A related process remains after final uninstall.'
    Assert-Condition (
        (Get-OptionalFileHash -LiteralPath $userDataDatabase) -ceq $baselineFiles.userDataDatabaseSha256
    ) 'Retained user-data database changed during crash matrix or final uninstall.'
    $finalAction = 'normal-inner-uninstall-clean'
}

$evidence = [ordered]@{
    schema = 'phase7-installer-crash-matrix-v1'
    recordedAt = [DateTimeOffset]::Now.ToString('o')
    status = 'DEVELOPMENT PASS; RELEASE REMAINS BLOCKED'
    source = [ordered]@{
        branch = (& git -C $repositoryRoot branch --show-current).Trim()
        headSha = $headSha
        script = 'tooling/packaging/phase7-installer-crash-matrix.ps1'
        productionFaultHookPresent = $false
    }
    candidate = [ordered]@{
        path = ConvertTo-PortablePath $script:resolvedCandidatePath
        sizeBytes = $candidateItem.Length
        sha256 = $candidateHash
        authenticodeStatus = [string]$candidateSignature.Status
        releaseStatus = 'RELEASE BLOCKED'
    }
    method = [ordered]@{
        watchdog = 'external 64-bit HKCU registry state watcher'
        termination = 'exact launched process PID only'
        uninstaller = 'exact installed uninstaller copied to owned TEMP directory and run with _?=<INSTALL_ROOT>'
        recovery = 'same exact installer /S /currentuser'
        productionInstallerInstrumentation = 'none'
        durableCheckpointCount = $allCheckpoints.Count
        maxAttemptsPerCheckpoint = $MaxAttemptsPerCheckpoint
    }
    initialState = $initialState
    baseline = [ordered]@{
        registry = $baselineRegistry
        files = $baselineFiles
    }
    checkpoints = $allCheckpoints
    matrix = $matrix
    finalState = [ordered]@{
        action = $finalAction
        transactionPresent = Test-RegistryKey -SubKey $transactionRegistrySubKey
        backupPresent = Test-RegistryKey -SubKey $backupRegistrySubKey
        stageCount = @(Get-StageDirectories).Count
        relatedProcessCount = @(Get-RelatedProcesses).Count
        userDataDatabaseSha256 = Get-OptionalFileHash -LiteralPath $userDataDatabase
    }
    boundaries = @(
        'unsigned development candidate only',
        'process termination evidence is not power-loss evidence',
        'same-machine CurrentUser default NTFS path only',
        'clean VM, signed candidate, ACL, volume, reparse, physical input, and cross-version upgrade remain separate gates'
    )
}

$resolvedEvidencePath = if ([IO.Path]::IsPathRooted($EvidencePath)) {
    [IO.Path]::GetFullPath($EvidencePath)
} else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
}
$evidenceParent = Split-Path -Parent $resolvedEvidencePath
if (-not (Test-Path -LiteralPath $evidenceParent -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $evidenceParent
}
$evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedEvidencePath -Encoding utf8
Write-Output ($evidence | ConvertTo-Json -Depth 20)

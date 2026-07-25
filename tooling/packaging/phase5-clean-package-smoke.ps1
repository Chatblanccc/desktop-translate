[CmdletBinding()]
param(
    [Parameter()][string]$PackageDirectory,
    [Parameter()][string]$EvidenceDirectory,
    [Parameter()][ValidateRange(5, 120)][int]$StartupTimeoutSeconds = 30,
    [Parameter()][ValidateRange(1, 60)][int]$ObservationSeconds = 5,
    [Parameter()][switch]$ManagedSandboxCompatibility
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'phase5-safe-filesystem.ps1')
if (-not $PackageDirectory) { $PackageDirectory = Join-Path $root 'artifacts\phase5\package\dist\win-unpacked' }
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $root 'artifacts\phase5\local\clean-package-smoke' }
$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory)
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
$appExecutable = Join-Path $PackageDirectory 'desktop-translate.exe'
$expectedHost = [IO.Path]::GetFullPath((Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'))
$script:phase5CimProcessInventoryAvailable = $null

function Initialize-Phase5ToolhelpProcessInventory {
    if ($null -ne ('DesktopTranslate.Phase5ToolhelpProcessInventory' -as [type])) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace DesktopTranslate {
    public sealed class Phase5ToolhelpProcessEntry {
        public int ProcessId { get; set; }
        public int ParentProcessId { get; set; }
        public string Name { get; set; }
    }

    public static class Phase5ToolhelpProcessInventory {
        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32 {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static Phase5ToolhelpProcessEntry[] Snapshot() {
            IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == InvalidHandleValue) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            try {
                var result = new List<Phase5ToolhelpProcessEntry>();
                var entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32FirstW(snapshot, ref entry)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 18) return result.ToArray();
                    throw new Win32Exception(error);
                }
                do {
                    result.Add(new Phase5ToolhelpProcessEntry {
                        ProcessId = checked((int)entry.th32ProcessID),
                        ParentProcessId = checked((int)entry.th32ParentProcessID),
                        Name = entry.szExeFile
                    });
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                } while (Process32NextW(snapshot, ref entry));
                int finalError = Marshal.GetLastWin32Error();
                if (finalError != 18) throw new Win32Exception(finalError);
                return result.ToArray();
            } finally {
                CloseHandle(snapshot);
            }
        }
    }
}
'@
}

function Get-Phase5ProcessInventory {
    if ($script:phase5CimProcessInventoryAvailable -ne $false) {
        try {
            $inventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
            $script:phase5CimProcessInventoryAvailable = $true
            return $inventory
        } catch {
            $script:phase5CimProcessInventoryAvailable = $false
        }
    }

    Initialize-Phase5ToolhelpProcessInventory
    $fallback = @()
    foreach ($entry in [DesktopTranslate.Phase5ToolhelpProcessInventory]::Snapshot()) {
        $managedProcess = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $managedProcess) { continue }
        try {
            if ($managedProcess.HasExited) { continue }
            $path = $null
            $startedAt = $null
            try {
                $path = $managedProcess.Path
                $startedAt = $managedProcess.StartTime
            } catch {
                # Identity-sensitive consumers fail closed when either value is
                # unavailable; hierarchy-only consumers can still use the row.
            }
            $fallback += [pscustomobject][ordered]@{
                ProcessId = [int]$entry.ProcessId
                ParentProcessId = [int]$entry.ParentProcessId
                Name = [string]$entry.Name
                ExecutablePath = $path
                CommandLine = $null
                CreationDate = $startedAt
            }
        } finally {
            $managedProcess.Dispose()
        }
    }
    return $fallback
}

function Get-Phase5ProcessById {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    return @(Get-Phase5ProcessInventory | Where-Object {
        [int]$_.ProcessId -eq $ProcessId
    } | Select-Object -First 1)
}

function Get-DescendantProcesses {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $all = @(Get-Phase5ProcessInventory)
    $descendants = @()
    $known = @($RootProcessId)
    do {
        $added = @($all | Where-Object {
            $known -contains [int]$_.ParentProcessId -and
            $known -notcontains [int]$_.ProcessId
        })
        foreach ($process in $added) {
            if ($known -notcontains [int]$process.ProcessId) {
                $known += [int]$process.ProcessId
                $descendants += $process
            }
        }
    } while ($added.Count -gt 0)
    return $descendants
}

function Get-SmokeUserDataProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath,
        [Parameter(Mandatory = $true)][DateTime]$ExpectedStartTimeUtc
    )
    $userDataArgument = '--user-data-dir="' + $ExpectedUserDataPath + '"'
    return @(Get-Phase5ProcessInventory | Where-Object {
        if (-not $_.ExecutablePath -or -not $_.CreationDate) { return $false }
        $managedProcess = Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
        if ($null -eq $managedProcess) { return $false }
        try {
            if ($managedProcess.HasExited) { return $false }
        } catch {
            return $false
        } finally {
            $managedProcess.Dispose()
        }
        $actualExecutablePath = [IO.Path]::GetFullPath($_.ExecutablePath)
        if (-not [string]::Equals(
            $actualExecutablePath,
            $ExpectedExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
        )) { return $false }
        $actualStartTimeUtc = ([DateTime]$_.CreationDate).ToUniversalTime()
        if ($actualStartTimeUtc -lt $ExpectedStartTimeUtc.AddSeconds(-5)) { return $false }
        if ($_.CommandLine) {
            return $_.CommandLine.IndexOf($userDataArgument, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        # Managed sandboxes can deny WMI/CIM command-line inventory. The
        # unpublished package path plus the per-run start boundary remains an
        # exact executable identity, and package preflight rejects an existing
        # process from this output tree before the smoke starts.
        return $true
    })
}

function Test-ExactProcessIdentityActive {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][DateTime]$ExpectedStartTimeUtc
    )
    $managedProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $managedProcess) { return $false }
    try {
        if ($managedProcess.HasExited) { return $false }
        try {
            $actualExecutablePath = [IO.Path]::GetFullPath($managedProcess.Path)
            $actualStartTimeUtc = $managedProcess.StartTime.ToUniversalTime()
        } catch {
            if ($managedProcess.HasExited) { return $false }
            # A terminating Windows process can temporarily hide Path/StartTime.
            # Conservatively keep treating it as active until a later poll can
            # prove exit or the strict deadline fails.
            return $true
        }
        if (-not [string]::Equals(
            $actualExecutablePath,
            $ExpectedExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
        )) { return $false }
        if ([Math]::Abs(($actualStartTimeUtc - $ExpectedStartTimeUtc).TotalSeconds) -gt 5) {
            return $false
        }
        return $true
    } finally {
        $managedProcess.Dispose()
    }
}

function Wait-ExactProcessIdentityStopped {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][DateTime]$ExpectedStartTimeUtc,
        [Parameter()][ValidateRange(5, 120)][int]$TimeoutSeconds = 45,
        [Parameter()][ValidateRange(250, 5000)][int]$QuietMilliseconds = 1000
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $quietSince = $null
    do {
        $active = Test-ExactProcessIdentityActive `
            -ProcessId $ProcessId `
            -ExpectedExecutablePath $ExpectedExecutablePath `
            -ExpectedStartTimeUtc $ExpectedStartTimeUtc
        if ($active) {
            $quietSince = $null
        } elseif ($null -eq $quietSince) {
            $quietSince = [DateTime]::UtcNow
        }
        if ($null -ne $quietSince -and
            ([DateTime]::UtcNow - $quietSince).TotalMilliseconds -ge $QuietMilliseconds
        ) {
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Exact process identity for PID ${ProcessId} stayed active before the helper exit deadline."
}

function Stop-ExactProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][DateTime]$ExpectedStartTimeUtc
    )
    $managedProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $managedProcess) {
        try {
            if (-not $managedProcess.HasExited) {
                $actualExecutablePath = [IO.Path]::GetFullPath($managedProcess.Path)
                $actualStartTimeUtc = $managedProcess.StartTime.ToUniversalTime()
                if ([string]::Equals(
                    $actualExecutablePath,
                    $ExpectedExecutablePath,
                    [StringComparison]::OrdinalIgnoreCase
                ) -and
                    [Math]::Abs(($actualStartTimeUtc - $ExpectedStartTimeUtc).TotalSeconds) -le 5
                ) {
                    # Kill through the already verified Process handle so PID
                    # reuse between verification and cleanup cannot select a
                    # replacement process.
                    $managedProcess.Kill()
                }
            }
        } catch [InvalidOperationException] {
            # The verified process exited while cleanup was converging.
        } finally {
            $managedProcess.Dispose()
        }
    }
    Wait-ExactProcessIdentityStopped `
        -ProcessId $ProcessId `
        -ExpectedExecutablePath $ExpectedExecutablePath `
        -ExpectedStartTimeUtc $ExpectedStartTimeUtc `
        -TimeoutSeconds 5
}

function Invoke-BoundedTaskkillTree {
    param(
        [Parameter(Mandatory = $true)][string]$TaskkillPath,
        [Parameter(Mandatory = $true)][int]$RootProcessId
    )
    $taskkillProcess = Start-Process -FilePath $TaskkillPath `
        -ArgumentList @('/PID', "$RootProcessId", '/T', '/F') `
        -WindowStyle Hidden -PassThru
    try {
        if (-not $taskkillProcess.WaitForExit(5000)) {
            # taskkill can itself wait indefinitely on a terminating Chromium
            # process. Bound the utility and let the exact identity loop below
            # prove whether any userData owner remains.
            try {
                $taskkillProcess.Kill()
            } catch [InvalidOperationException] {
                # The exact Process handle exited between WaitForExit and Kill.
            }
            if (-not $taskkillProcess.WaitForExit(2000)) {
                throw "taskkill did not stop before the packaged smoke cleanup deadline."
            }
        }
    } finally {
        $taskkillProcess.Dispose()
    }
}

function Stop-SmokeProcessTree {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath,
        [Parameter(Mandatory = $true)][DateTime]$ExpectedStartTimeUtc
    )
    $ExpectedExecutablePath = [IO.Path]::GetFullPath($ExpectedExecutablePath)
    $ExpectedUserDataPath = [IO.Path]::GetFullPath($ExpectedUserDataPath)
    $rootProcess = Get-Phase5ProcessById -ProcessId $RootProcessId
    if ($null -ne $rootProcess) {
        if (-not $rootProcess.ExecutablePath) {
            throw "Refusing to terminate smoke PID $RootProcessId because its executable path is unavailable."
        }
        $actualExecutablePath = [IO.Path]::GetFullPath($rootProcess.ExecutablePath)
        if (-not [string]::Equals($actualExecutablePath, $ExpectedExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to terminate reused smoke PID ${RootProcessId}: executable identity changed."
        }
        $actualStartTimeUtc = ([DateTime]$rootProcess.CreationDate).ToUniversalTime()
        if ([Math]::Abs(($actualStartTimeUtc - $ExpectedStartTimeUtc).TotalSeconds) -gt 5) {
            throw "Refusing to terminate reused smoke PID ${RootProcessId}: creation time changed."
        }
    }
    [array]$descendants = @()
    if ($null -ne $rootProcess) {
        $descendants = @(Get-DescendantProcesses -RootProcessId $RootProcessId)
    }

    # First ask the main window to close so Chromium/LevelDB gets a bounded
    # opportunity to release its files. This is cleanup hygiene only; the smoke
    # report deliberately does not claim graceful-exit acceptance.
    if ($null -ne $rootProcess) {
        $managedRoot = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
        if ($null -ne $managedRoot) {
            try { $null = $managedRoot.CloseMainWindow() } finally { $managedRoot.Dispose() }
        }
        $closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $userDataProcesses = @(Get-SmokeUserDataProcesses `
                -ExpectedExecutablePath $ExpectedExecutablePath `
                -ExpectedUserDataPath $ExpectedUserDataPath `
                -ExpectedStartTimeUtc $ExpectedStartTimeUtc)
            if ($userDataProcesses.Count -gt 0) { Start-Sleep -Milliseconds 100 }
        } while ($userDataProcesses.Count -gt 0 -and [DateTime]::UtcNow -lt $closeDeadline)
    }

    # taskkill /T provides the initial Windows process-tree boundary. Electron
    # children can outlive or be re-parented away from the root during shutdown,
    # so a single pre-kill descendant snapshot is not sufficient for LevelDB
    # cleanup. The loop below also finds the exact packaged executable bound to
    # this smoke's unique --user-data-dir and converges that identity dynamically.
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $rootStillRunning = Get-Phase5ProcessById -ProcessId $RootProcessId
    if ($null -ne $rootStillRunning) {
        if (-not $rootStillRunning.ExecutablePath -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath($rootStillRunning.ExecutablePath),
                $ExpectedExecutablePath,
                [StringComparison]::OrdinalIgnoreCase
            ) -or
            [Math]::Abs((([DateTime]$rootStillRunning.CreationDate).ToUniversalTime() - $ExpectedStartTimeUtc).TotalSeconds) -gt 5
        ) {
            throw "Refusing to terminate reused smoke PID ${RootProcessId}: identity changed during cleanup."
        }
    }
    if ($null -ne $rootStillRunning -and (Test-Path -LiteralPath $taskkill -PathType Leaf)) {
        Invoke-BoundedTaskkillTree -TaskkillPath $taskkill -RootProcessId $RootProcessId
        Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
    }
    [array]::Reverse($descendants)
    foreach ($process in $descendants) {
        $currentProcess = Get-Phase5ProcessById -ProcessId ([int]$process.ProcessId)
        if ($null -eq $currentProcess) { continue }
        $expectedCreationTimeUtc = ([DateTime]$process.CreationDate).ToUniversalTime()
        $currentCreationTimeUtc = ([DateTime]$currentProcess.CreationDate).ToUniversalTime()
        if (-not [string]::Equals([string]$currentProcess.Name, [string]$process.Name, [StringComparison]::OrdinalIgnoreCase) -or
            [Math]::Abs(($currentCreationTimeUtc - $expectedCreationTimeUtc).TotalSeconds) -gt 1
        ) {
            # The observed descendant exited and Windows reused its PID. Never
            # terminate the replacement process.
            continue
        }
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $quietSince = $null
    do {
        $matchingProcesses = @(Get-SmokeUserDataProcesses `
            -ExpectedExecutablePath $ExpectedExecutablePath `
            -ExpectedUserDataPath $ExpectedUserDataPath `
            -ExpectedStartTimeUtc $ExpectedStartTimeUtc)
        foreach ($matchingProcess in $matchingProcesses) {
            $matchingProcessId = [int]$matchingProcess.ProcessId
            # The initial taskkill /T already handled the owned tree. Repeating
            # taskkill synchronously for each stale Chromium PID can consume the
            # whole deadline while Windows retains terminated process objects.
            # Stop-Process is immediate; the next identity scan is the proof that
            # no live userData-bound Electron process remains.
            Stop-Process -Id $matchingProcessId -Force -ErrorAction SilentlyContinue
        }
        if ($matchingProcesses.Count -eq 0) {
            if ($null -eq $quietSince) { $quietSince = [DateTime]::UtcNow }
        } else {
            $quietSince = $null
        }
        if ($null -eq $quietSince -or ([DateTime]::UtcNow - $quietSince).TotalMilliseconds -lt 1000) {
            Start-Sleep -Milliseconds 100
        }
    } while (($null -eq $quietSince -or ([DateTime]::UtcNow - $quietSince).TotalMilliseconds -lt 1000) -and
        [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $quietSince -or ([DateTime]::UtcNow - $quietSince).TotalMilliseconds -lt 1000) {
        $remaining = @($matchingProcesses | ForEach-Object { [int]$_.ProcessId })
        throw "Packaged smoke process tree did not reach a stable stopped state before cleanup: $($remaining -join ', ')"
    }
}

function Remove-SmokeTemporaryRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            Remove-Phase5DirectoryTree -Path $Path -AllowedParent ([IO.Path]::GetTempPath())
            return
        } catch {
            if ($_.Exception.Message -match '(?i)reparse point|outside allowed parent|strict child') { throw }
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while (Test-Path -LiteralPath $Path)
}

function Write-Utf8Json {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    [IO.File]::WriteAllText(
        $Path,
        (($Value | ConvertTo-Json -Depth 8) + "`n"),
        (New-Object Text.UTF8Encoding($false))
    )
}

function Set-SmokeEvidenceState {
    param(
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][string]$EvidenceManifestPath,
        [Parameter(Mandatory = $true)]$Report
    )
    Write-Utf8Json -Path $ReportPath -Value $Report
    if (-not (Test-Path -LiteralPath $EvidenceManifestPath -PathType Leaf)) {
        throw 'Draft evidence manifest must exist before recording the packaged startup smoke.'
    }
    $evidenceManifest = Get-Content -LiteralPath $EvidenceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $evidenceManifest.package) { throw 'Draft evidence manifest is missing package evidence.' }
    $packageEvidence = $evidenceManifest.package
    $packageEvidence | Add-Member -NotePropertyName startupSmoke -NotePropertyValue 'package/startup-smoke.json' -Force
    $packageEvidence | Add-Member -NotePropertyName startupSmokeSha256 -NotePropertyValue `
        ((Get-FileHash -LiteralPath $ReportPath -Algorithm SHA256).Hash.ToLowerInvariant()) -Force
    $packageEvidence | Add-Member -NotePropertyName startupSmokeStatus -NotePropertyValue ([string]$Report.status) -Force
    Write-Utf8Json -Path $EvidenceManifestPath -Value $evidenceManifest
}

$startedAt = [DateTime]::UtcNow
$reportPath = Join-Path $EvidenceDirectory 'package\startup-smoke.json'
$evidenceManifestPath = Join-Path $EvidenceDirectory 'release\evidence-manifest.json'
$acceptanceBoundary = if ($ManagedSandboxCompatibility) {
    'Managed-sandbox startup/resource + packaged clear-data helper proof only; Chromium sandbox, graceful exit, Settings UI two-step confirmation, and clean-VM installer evidence remain unverified.'
} else {
    'Startup/resource + packaged clear-data helper proof only; forced app cleanup is not graceful-exit, Settings UI two-step confirmation, or clean-VM installer evidence.'
}
Set-SmokeEvidenceState -ReportPath $reportPath -EvidenceManifestPath $evidenceManifestPath -Report ([ordered]@{
    schemaVersion = 1
    status = 'PENDING'
    scenario = 'isolated-unpacked-startup'
    nonAsciiUserData = $false
    standardElevationRequested = $false
    chromiumSandboxEnabled = -not $ManagedSandboxCompatibility
    packagedNativeHostPathVerified = $false
    packagedClearDataHelperExecuted = $false
    packagedClearDataHelperExactIdentityStopped = $false
    packagedClearDataHelperExitCodeUsedAsPassCondition = $false
    packagedClearDataHelperSuccessBasis = $null
    markerBoundTargetDeleted = $false
    siblingPreserved = $false
    observationSeconds = $ObservationSeconds
    startedAt = $startedAt.ToString('o')
    completedAt = $null
    gracefulExitVerified = $false
    cleanVmInstallVerified = $false
    acceptanceBoundary = $acceptanceBoundary
})
foreach ($path in @($appExecutable, $expectedHost)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Packaged smoke input is missing: $path" }
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
$nonAsciiSuffix = -join @([char]0x975E, [char]0x0041, [char]0x0053, [char]0x0043, [char]0x0049, [char]0x0049)
$userData = Join-Path $temporaryRoot ('User Data ' + $nonAsciiSuffix)
New-Item -ItemType Directory -Path $userData | Out-Null
$process = $null
$processStartTimeUtc = $null
$smokeProofReady = $false
try {
    $applicationArguments = @("--user-data-dir=`"$userData`"")
    if ($ManagedSandboxCompatibility) {
        $applicationArguments = @('--no-sandbox') + $applicationArguments
    }
    $process = Start-Process -FilePath $appExecutable `
        -ArgumentList $applicationArguments `
        -WorkingDirectory $temporaryRoot -WindowStyle Hidden -PassThru
    $processStartTimeUtc = $process.StartTime.ToUniversalTime()
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $nativeHostProcess = $null
    do {
        if ($process.HasExited) { throw "Packaged application exited during startup with code $($process.ExitCode)." }
        $descendants = @(Get-DescendantProcesses -RootProcessId $process.Id)
        $nativeHostProcess = $descendants | Where-Object {
            $_.Name -eq 'selection-host.exe' -and
            $_.ExecutablePath -and
            [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $expectedHost, [StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1
        if ($null -eq $nativeHostProcess) { Start-Sleep -Milliseconds 250 }
    } while ($null -eq $nativeHostProcess -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $nativeHostProcess) { throw 'Packaged application did not launch the allowlisted Native Host before the startup deadline.' }

    Start-Sleep -Seconds $ObservationSeconds
    if ($process.HasExited) { throw "Packaged application exited during observation with code $($process.ExitCode)." }
    $database = Join-Path $userData 'desktop-translate.sqlite3'
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
        throw 'Packaged application did not initialize its isolated userData database.'
    }

    # Execute the packaged clear-data helper directly from app.asar under
    # Electron's Node mode. This proves the shipped helper/ASAR path and its
    # PID+nonce+target binding without claiming that the Settings UI two-step
    # confirmation has been exercised.
    $clearDataRoot = Join-Path $temporaryRoot 'clear-data-helper-proof'
    $clearDataTarget = Join-Path $clearDataRoot ('target-' + (-join @([char]0x5F85, [char]0x6E05, [char]0x7406)))
    $clearDataSibling = Join-Path $clearDataRoot ('sibling-' + (-join @([char]0x4FDD, [char]0x7559)))
    New-Item -ItemType Directory -Force -Path $clearDataTarget, $clearDataSibling | Out-Null
    Set-Content -LiteralPath (Join-Path $clearDataTarget 'private-state.txt') -Value 'delete-me' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $clearDataSibling 'survival-proof.txt') -Value 'keep-me' -Encoding UTF8
    $parent = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 3') `
        -WindowStyle Hidden -PassThru
    $nonce = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    $marker = [ordered]@{
        version = 1
        target = $clearDataTarget
        parentProcessId = $parent.Id
        nonce = $nonce
    }
    Write-Utf8Json -Path (Join-Path $clearDataTarget '.desktop-translate-clear-data-pending') -Value $marker
    $helperScript = Join-Path $PackageDirectory 'resources\app.asar\.vite\build\local-data-reset-helper.js'
    $savedElectronRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', [EnvironmentVariableTarget]::Process)
    $helper = $null
    $helperProcessId = $null
    $helperStartTimeUtc = $null
    # Bind the identity to the normalized FilePath supplied to Start-Process.
    # A very short-lived helper can finish before Process.Path is readable.
    $helperExecutablePath = $appExecutable
    $helperIdentityStopped = $false
    try {
        [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1', [EnvironmentVariableTarget]::Process)
        $helper = Start-Process -FilePath $appExecutable `
            -ArgumentList @(
                "`"$helperScript`"",
                "`"--target=$clearDataTarget`"",
                "--parent-pid=$($parent.Id)",
                "--nonce=$nonce"
            ) `
            -WorkingDirectory $clearDataRoot -WindowStyle Hidden -PassThru
        $helperProcessId = $helper.Id
        $helperStartTimeUtc = $helper.StartTime.ToUniversalTime()
    } finally {
        [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $savedElectronRunAsNode, [EnvironmentVariableTarget]::Process)
    }
    try {
        if (-not $parent.WaitForExit(15000)) { throw 'Packaged clear-data helper parent did not exit before the deadline.' }
        # Release the Process handle immediately. On Windows a terminated
        # process object can remain addressable while another process holds an
        # open handle, so the helper's exact-PID liveness probe must not be kept
        # artificially true by this smoke harness.
        $parent.Dispose()
        $parent = $null
        # An external taskkill observer can retain a terminated Windows process
        # object. Process.WaitForExit can then report a false timeout even
        # though a fresh Process object reports HasExited.
        # Release the launch handle and prove zero active process identity by
        # executable + PID + creation time for a continuous quiet interval.
        $helper.Dispose()
        $helper = $null
        Wait-ExactProcessIdentityStopped `
            -ProcessId $helperProcessId `
            -ExpectedExecutablePath $helperExecutablePath `
            -ExpectedStartTimeUtc $helperStartTimeUtc
        $helperIdentityStopped = $true
        if (Test-Path -LiteralPath $clearDataTarget) { throw 'Packaged clear-data helper did not remove its exact marker-bound target.' }
        if (-not (Test-Path -LiteralPath (Join-Path $clearDataSibling 'survival-proof.txt') -PathType Leaf)) {
            throw 'Packaged clear-data helper modified a sibling outside its marker-bound target.'
        }
    } finally {
        if ($null -ne $parent) {
            if (-not $parent.HasExited) { Stop-Process -Id $parent.Id -Force -ErrorAction SilentlyContinue }
            $parent.Dispose()
        }
        if ($null -ne $helper) {
            try {
                if (-not $helper.HasExited) { $helper.Kill() }
            } catch [InvalidOperationException] {
                # The helper exited between HasExited and Kill.
            }
            $helper.Dispose()
            $helper = $null
        }
        if ($null -ne $helperProcessId -and
            $null -ne $helperStartTimeUtc -and
            $null -ne $helperExecutablePath -and
            -not $helperIdentityStopped
        ) {
            Stop-ExactProcessIdentity `
                -ProcessId $helperProcessId `
                -ExpectedExecutablePath $helperExecutablePath `
                -ExpectedStartTimeUtc $helperStartTimeUtc
        }
    }

    $smokeProofReady = $true
} finally {
    try {
        if ($null -ne $process) {
            if ($null -eq $processStartTimeUtc) { throw 'Packaged smoke process identity was not captured.' }
            try {
                Stop-SmokeProcessTree `
                    -RootProcessId $process.Id `
                    -ExpectedExecutablePath $appExecutable `
                    -ExpectedUserDataPath $userData `
                    -ExpectedStartTimeUtc $processStartTimeUtc
            } finally {
                $process.Dispose()
                $process = $null
            }
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-SmokeTemporaryRoot -Path $temporaryRoot
        }
    }
}

if (-not $smokeProofReady) { throw 'Packaged smoke proof did not reach the cleanup boundary.' }
Set-SmokeEvidenceState -ReportPath $reportPath -EvidenceManifestPath $evidenceManifestPath -Report ([ordered]@{
    schemaVersion = 1
    status = 'PASS'
    scenario = 'isolated-unpacked-startup'
    nonAsciiUserData = $true
    standardElevationRequested = $false
    chromiumSandboxEnabled = -not $ManagedSandboxCompatibility
    packagedNativeHostPathVerified = $true
    packagedClearDataHelperExecuted = $true
    packagedClearDataHelperExactIdentityStopped = $true
    packagedClearDataHelperExitCodeUsedAsPassCondition = $false
    packagedClearDataHelperSuccessBasis = 'marker-bound target deleted; sibling preserved; exact PID/executable/creation-time identity inactive continuously for 1 second'
    markerBoundTargetDeleted = $true
    siblingPreserved = $true
    observationSeconds = $ObservationSeconds
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTime]::UtcNow.ToString('o')
    gracefulExitVerified = $false
    cleanVmInstallVerified = $false
    acceptanceBoundary = $acceptanceBoundary
})
Write-Host '[phase5:package-smoke] Isolated packaged startup, Native Host resource resolution, D8 helper, and cleanup PASS.'
Write-Host '[phase5:package-smoke] Boundary: this does not claim clean-VM install or graceful-exit acceptance.'

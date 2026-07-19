[CmdletBinding()]
param(
    [Parameter()][string]$PackageDirectory,
    [Parameter()][string]$PackageEvidenceManifest,
    [Parameter()][string]$OutputRoot,
    [Parameter()][ValidateRange(1, 86400)][int]$DurationSeconds = 900,
    [Parameter()][ValidateRange(1, 300)][int]$SampleIntervalSeconds = 5,
    [Parameter()][ValidateRange(10, 300)][int]$StartupTimeoutSeconds = 60,
    [Parameter()][ValidateRange(5, 120)][int]$GracefulExitTimeoutSeconds = 30,
    [Parameter()][switch]$DevelopmentSelfTest,
    [Parameter()][switch]$StaticSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-safe-filesystem.ps1')

if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $PackageDirectory = Join-Path $root 'artifacts\phase5\package\dist\win-unpacked'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $runStamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $OutputRoot = Join-Path $root "artifacts\phase5\local\product-idle-$runStamp"
}

$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$applicationExecutable = Join-Path $PackageDirectory 'desktop-translate.exe'
$hostExecutable = Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'
$packageEvidenceManifestPath = if ([string]::IsNullOrWhiteSpace($PackageEvidenceManifest)) {
    $null
} else {
    [IO.Path]::GetFullPath($PackageEvidenceManifest)
}
$summaryPath = Join-Path $OutputRoot 'summary.json'
$resourceRoot = Join-Path $OutputRoot 'resources\idle'
$securityRoot = Join-Path $OutputRoot 'security'
$startedAt = [DateTimeOffset]::UtcNow
$requestedAcceptance = -not [bool]$DevelopmentSelfTest

function Write-AtomicJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText(
            $temporary,
            (($Value | ConvertTo-Json -Depth 10) + "`n"),
            (New-Object Text.UTF8Encoding($false))
        )
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            if (-not [Phase5ProductIdleNative]::MoveFileEx(
                $temporary,
                $Path,
                [Phase5ProductIdleNative]::MOVEFILE_REPLACE_EXISTING -bor [Phase5ProductIdleNative]::MOVEFILE_WRITE_THROUGH
            )) {
                throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
            }
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            [IO.File]::Delete($temporary)
        }
    }
}

function Invoke-CheckedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $powershell = (Get-Process -Id $PID).Path
    & $powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Child PowerShell gate failed with exit code $LASTEXITCODE."
    }
}

function Invoke-CheckedNode {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Node gate failed with exit code $LASTEXITCODE."
    }
}

function Remove-IsolatedDataRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    if (-not [string]::Equals(
        [IO.Path]::GetDirectoryName($pathFull).TrimEnd('\'),
        $parentFull,
        [StringComparison]::OrdinalIgnoreCase
    ) -or [IO.Path]::GetFileName($pathFull) -notmatch '^desktop-translate-phase5-idle-[a-f0-9]{32}$') {
        throw 'Refusing isolated-data cleanup outside the exact run-owned temporary-root shape.'
    }
    if ((Test-Path -LiteralPath $pathFull) -and
        -not (Test-Path -LiteralPath $pathFull -PathType Container)) {
        throw 'Refusing isolated-data cleanup because the exact run-owned root is not a directory.'
    }

    # Validate the complete path before entering the retry loop. Revalidate
    # after every transient deletion failure so a reparse point is always a
    # fail-fast safety error rather than something retried for 45 seconds.
    Assert-Phase5NoReparsePoint -Path $pathFull -AllowedParent $parentFull
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (Test-Path -LiteralPath $pathFull) {
        try {
            Remove-Phase5DirectoryTree -Path $pathFull -AllowedParent $parentFull
        } catch {
            Assert-Phase5NoReparsePoint -Path $pathFull -AllowedParent $parentFull
            if ([DateTime]::UtcNow -ge $deadline) {
                throw 'The isolated data root did not become removable before the 45-second cleanup deadline.'
            }
            Start-Sleep -Milliseconds 250
            continue
        }

        if (Test-Path -LiteralPath $pathFull) {
            Assert-Phase5NoReparsePoint -Path $pathFull -AllowedParent $parentFull
            if ([DateTime]::UtcNow -ge $deadline) {
                throw 'The isolated data root remained after the 45-second cleanup deadline.'
            }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Get-ProcessRecords {
    $records = [Collections.Generic.List[object]]::new()
    foreach ($process in @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process')) {
        $path = if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
            $null
        } else {
            try { [IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { $null }
        }
        $creationTimeUtc = if ($null -eq $process.CreationDate) {
            $null
        } else {
            try { ([DateTime]$process.CreationDate).ToUniversalTime() } catch { $null }
        }
        $records.Add([pscustomobject]@{
            ProcessId = [int]$process.ProcessId
            ParentProcessId = [int]$process.ParentProcessId
            ExecutablePath = $path
            CommandLine = [string]$process.CommandLine
            CreationTimeUtc = $creationTimeUtc
        })
    }
    return @($records)
}

function Stop-ExactOwnedRunProcessTree {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHostPath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath
    )
    $ExpectedApplicationPath = [IO.Path]::GetFullPath($ExpectedApplicationPath)
    $ExpectedHostPath = [IO.Path]::GetFullPath($ExpectedHostPath)
    $ExpectedUserDataPath = [IO.Path]::GetFullPath($ExpectedUserDataPath)

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($true) {
        $owned = @(Get-ExactOwnedRunProcesses `
            -RootProcessId $RootProcessId `
            -RootCreationTimeUtc $RootCreationTimeUtc `
            -ExpectedApplicationPath $ExpectedApplicationPath `
            -ExpectedHostPath $ExpectedHostPath `
            -ExpectedUserDataPath $ExpectedUserDataPath)
        if ($owned.Count -eq 0) { return }
        foreach ($ownedProcess in @($owned | Sort-Object CreationTimeUtc -Descending)) {
            [Phase5ProductIdleNative]::TerminateVerifiedProcessAndWait(
                [int]$ownedProcess.ProcessId,
                ([DateTime]$ownedProcess.CreationTimeUtc).ToUniversalTime().Ticks,
                [string]$ownedProcess.ExecutablePath,
                5000
            ) | Out-Null
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 100
    }

    $remaining = @(Get-ExactOwnedRunProcesses `
        -RootProcessId $RootProcessId `
        -RootCreationTimeUtc $RootCreationTimeUtc `
        -ExpectedApplicationPath $ExpectedApplicationPath `
        -ExpectedHostPath $ExpectedHostPath `
        -ExpectedUserDataPath $ExpectedUserDataPath)
    if ($remaining.Count -gt 0) {
        throw 'The exact run-owned process set did not stop before the forced-cleanup deadline.'
    }
}

function Get-ExactOwnedRunProcesses {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHostPath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath
    )
    $ExpectedApplicationPath = [IO.Path]::GetFullPath($ExpectedApplicationPath)
    $ExpectedHostPath = [IO.Path]::GetFullPath($ExpectedHostPath)
    $ExpectedUserDataPath = [IO.Path]::GetFullPath($ExpectedUserDataPath)
    $processes = @(Get-ProcessRecords)
    $rootRecord = $processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
    if ($null -ne $rootRecord -and (
        $null -eq $rootRecord.ExecutablePath -or
        -not $rootRecord.ExecutablePath.Equals($ExpectedApplicationPath, [StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $rootRecord.CreationTimeUtc -or
        [Math]::Abs(($rootRecord.CreationTimeUtc - $RootCreationTimeUtc).TotalSeconds) -gt 1 -or
        $rootRecord.CommandLine.IndexOf($ExpectedUserDataPath, [StringComparison]::OrdinalIgnoreCase) -lt 0
    )) {
        throw 'Refusing forced cleanup because the bound root identity changed.'
    }

    # ParentProcessId remains the original creator after that parent exits.
    # Seed the exact root PID and rebuild its current package-owned lineage on
    # every pass so renderer/GPU processes cannot race isolated-root deletion.
    $lineage = [Collections.Generic.HashSet[int]]::new()
    $lineage.Add($RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if ($lineage.Contains([int]$candidate.ProcessId) -or
                -not $lineage.Contains([int]$candidate.ParentProcessId) -or
                $null -eq $candidate.CreationTimeUtc -or
                $candidate.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)) {
                continue
            }
            $lineage.Add([int]$candidate.ProcessId) | Out-Null
            $added = $true
        }
    } while ($added)

    return @($processes | Where-Object {
        if ($null -eq $_.ExecutablePath -or $null -eq $_.CreationTimeUtc -or
            $_.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)) {
            return $false
        }
        $packageOwnedPath = $_.ExecutablePath.Equals($ExpectedApplicationPath, [StringComparison]::OrdinalIgnoreCase) -or
            $_.ExecutablePath.Equals($ExpectedHostPath, [StringComparison]::OrdinalIgnoreCase)
        if (-not $packageOwnedPath) { return $false }
        $lineageMatch = $lineage.Contains([int]$_.ProcessId)
        $applicationMatch = $_.ExecutablePath.Equals($ExpectedApplicationPath, [StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine.IndexOf($ExpectedUserDataPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $hostMatch = $_.ExecutablePath.Equals($ExpectedHostPath, [StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine -match "(?:^|\s)--parent-pid(?:\s+|=)$RootProcessId(?:\s|$)"
        return $lineageMatch -or $applicationMatch -or $hostMatch
    })
}

function Test-ExpectedHostDescendant {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedHostPath
    )
    $processes = @(Get-ProcessRecords)
    $rootRecord = $processes | Where-Object {
        $_.ProcessId -eq $RootProcessId -and
        $null -ne $_.CreationTimeUtc -and
        [Math]::Abs(($_.CreationTimeUtc - $RootCreationTimeUtc).TotalSeconds) -le 1
    } | Select-Object -First 1
    if ($null -eq $rootRecord) { return $false }

    $known = [Collections.Generic.HashSet[int]]::new()
    $known.Add($RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if ($known.Contains([int]$candidate.ProcessId) -or -not $known.Contains([int]$candidate.ParentProcessId)) { continue }
            if ($null -eq $candidate.CreationTimeUtc -or $candidate.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)) { continue }
            $known.Add([int]$candidate.ProcessId) | Out-Null
            $added = $true
        }
    } while ($added)

    return @($processes | Where-Object {
        $known.Contains([int]$_.ProcessId) -and
        $null -ne $_.ExecutablePath -and
        $_.ExecutablePath.Equals($ExpectedHostPath, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
}

if (-not ('Phase5ProductIdleNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class Phase5ProductWindowInfo {
    public IntPtr Handle { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public static class Phase5ProductIdleNative {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint Type;
        public INPUTUNION Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint Low;
        public uint High;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    [DllImport("shcore.dll")]
    private static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string existingPath, string newPath, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
    public const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint STILL_ACTIVE = 259;

    public static void RequirePerMonitorDpiAwareness() {
        const int perMonitorAware = 2;
        SetProcessDpiAwareness(perMonitorAware);
        int actual;
        if (GetProcessDpiAwareness(IntPtr.Zero, out actual) != 0 || actual != perMonitorAware) {
            throw new InvalidOperationException("The product Idle controller must be per-monitor DPI aware.");
        }
    }

    public static bool PointTargetsWindow(int x, int y, IntPtr expectedRoot) {
        var target = WindowFromPoint(new POINT { X = x, Y = y });
        return target != IntPtr.Zero && GetAncestor(target, 2) == expectedRoot;
    }

    public static bool ForegroundIsWindow(IntPtr expectedWindow) {
        return expectedWindow != IntPtr.Zero && GetForegroundWindow() == expectedWindow;
    }

    public static bool SendPrimaryClick() {
        const uint INPUT_MOUSE = 0;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        var inputs = new[] {
            new INPUT {
                Type = INPUT_MOUSE,
                Data = new INPUTUNION { Mouse = new MOUSEINPUT { Flags = MOUSEEVENTF_LEFTDOWN } }
            },
            new INPUT {
                Type = INPUT_MOUSE,
                Data = new INPUTUNION { Mouse = new MOUSEINPUT { Flags = MOUSEEVENTF_LEFTUP } }
            }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    }

    public static int GetInputLayoutSize() {
        return Marshal.SizeOf(typeof(INPUT));
    }

    public static void RequireExactProcessIdentity(IntPtr process, long expectedCreationTimeUtcTicks, string expectedPath) {
        if (process == IntPtr.Zero) throw new ArgumentException("The exact process handle is missing.", "process");
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read the exact root creation time.");
        }
        var fileTime = ((long)creation.High << 32) | creation.Low;
        if (Math.Abs(DateTime.FromFileTimeUtc(fileTime).Ticks - expectedCreationTimeUtcTicks) > TimeSpan.TicksPerMillisecond) {
            throw new InvalidOperationException("The root PID was reused before the product UI command.");
        }
        var path = new StringBuilder(32768);
        var pathLength = path.Capacity;
        if (!QueryFullProcessImageName(process, 0, path, ref pathLength) ||
            !String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)) {
            throw new InvalidOperationException("The exact root image identity changed before the product UI command.");
        }
    }

    public static uint WaitForExactProcessExit(IntPtr process, int timeoutMilliseconds) {
        if (process == IntPtr.Zero) throw new ArgumentException("The exact process handle is missing.", "process");
        if (timeoutMilliseconds < 1) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
        var wait = WaitForSingleObject(process, checked((uint)timeoutMilliseconds));
        if (wait == WAIT_TIMEOUT) throw new TimeoutException("The product did not exit before the graceful-exit deadline.");
        if (wait == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error(), "Waiting for the exact root process failed.");
        if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("The exact root process wait returned an unexpected result.");
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The exact root exit code is unavailable.");
        }
        if (exitCode == STILL_ACTIVE) throw new InvalidOperationException("The exact root remained active after its exit signal.");
        return exitCode;
    }

    public static bool TerminateVerifiedProcessAndWait(int processId, long expectedCreationTimeUtcTicks, string expectedPath, int timeoutMilliseconds) {
        const uint PROCESS_TERMINATE = 0x0001;
        const uint SYNCHRONIZE = 0x00100000;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const int ERROR_INVALID_PARAMETER = 87;
        var process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) {
            var openError = Marshal.GetLastWin32Error();
            if (openError == ERROR_INVALID_PARAMETER) return false;
            throw new Win32Exception(openError, "Unable to open an exact run-owned process for cleanup.");
        }
        try {
            RequireExactProcessIdentity(process, expectedCreationTimeUtcTicks, expectedPath);
            uint initialExitCode;
            if (!GetExitCodeProcess(process, out initialExitCode)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read a run-owned process exit code before cleanup.");
            }
            if (initialExitCode != STILL_ACTIVE) return false;
            if (!TerminateProcess(process, 1)) {
                var terminateError = Marshal.GetLastWin32Error();
                uint racedExitCode;
                if (GetExitCodeProcess(process, out racedExitCode) && racedExitCode != STILL_ACTIVE) return false;
                throw new Win32Exception(terminateError, "Unable to terminate an exact run-owned process.");
            }
            var wait = WaitForSingleObject(process, checked((uint)timeoutMilliseconds));
            if (wait == WAIT_TIMEOUT) throw new TimeoutException("An exact run-owned process did not stop before the cleanup deadline.");
            if (wait == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error(), "Waiting for an exact run-owned process cleanup failed.");
            if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("An exact run-owned process cleanup wait returned an unexpected result.");
            uint finalExitCode;
            if (!GetExitCodeProcess(process, out finalExitCode) || finalExitCode == STILL_ACTIVE) {
                throw new InvalidOperationException("An exact run-owned process remained active after cleanup.");
            }
            return true;
        } finally {
            CloseHandle(process);
        }
    }

    public static Phase5ProductWindowInfo[] GetVisibleWindows(int processId) {
        var result = new List<Phase5ProductWindowInfo>();
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            RECT rectangle;
            if (!GetWindowRect(window, out rectangle)) return true;
            int width = rectangle.Right - rectangle.Left;
            int height = rectangle.Bottom - rectangle.Top;
            if (width <= 0 || height <= 0) return true;
            result.Add(new Phase5ProductWindowInfo {
                Handle = window,
                Left = rectangle.Left,
                Top = rectangle.Top,
                Width = width,
                Height = height
            });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
}

function Get-BallWindow {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $candidates = @(
        [Phase5ProductIdleNative]::GetVisibleWindows($RootProcessId) |
            Where-Object { $_.Width -ge 16 -and $_.Height -ge 16 }
    )
    if ($candidates.Count -ne 1) { return $null }
    return $candidates[0]
}

function Get-ProductContextMenuWindow {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][long[]]$PreClickWindowHandles,
        [Parameter(Mandatory = $true)][int]$TargetX,
        [Parameter(Mandatory = $true)][int]$TargetY
    )
    $candidates = @(
        [Phase5ProductIdleNative]::GetVisibleWindows($RootProcessId) | Where-Object {
            $handle = $_.Handle.ToInt64()
            -not ($PreClickWindowHandles -contains $handle) -and
            $_.Width -ge 80 -and $_.Height -ge 80 -and
            $TargetX -ge $_.Left -and $TargetX -lt ($_.Left + $_.Width) -and
            $TargetY -ge $_.Top -and $TargetY -lt ($_.Top + $_.Height)
        }
    )
    if ($candidates.Count -ne 1) { return $null }
    return $candidates[0]
}

function Request-GracefulExitThroughProductUi {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$RootProcess,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][ref]$CommandIssued
    )
    $CommandIssued.Value = $false
    if ($RootProcess.Id -ne $RootProcessId) {
        throw 'The managed root process no longer matches the bound root PID.'
    }
    $rootHandle = [IntPtr]$RootProcess.Handle
    [Phase5ProductIdleNative]::RequireExactProcessIdentity(
        $rootHandle,
        $RootCreationTimeUtc.ToUniversalTime().Ticks,
        $ExpectedApplicationPath
    )
    $ballWindow = Get-BallWindow -RootProcessId $RootProcessId
    if ($null -eq $ballWindow) {
        throw 'The product ball window was unavailable or ambiguous for the graceful-exit UI path.'
    }

    $originalCursor = New-Object Phase5ProductIdleNative+POINT
    $cursorCaptured = [Phase5ProductIdleNative]::GetCursorPos([ref]$originalCursor)
    $centerX = [int]($ballWindow.Left + [Math]::Floor($ballWindow.Width / 2))
    $centerY = [int]($ballWindow.Top + [Math]::Floor($ballWindow.Height / 2))
    try {
        $visibleBeforeClick = @([Phase5ProductIdleNative]::GetVisibleWindows($RootProcessId))
        $ballHandle = $ballWindow.Handle.ToInt64()
        if (@($visibleBeforeClick | Where-Object { $_.Handle.ToInt64() -eq $ballHandle }).Count -ne 1) {
            throw 'The exact product ball window changed before the context-menu command.'
        }
        $preClickWindowHandles = [long[]]@(
            $visibleBeforeClick | ForEach-Object { $_.Handle.ToInt64() }
        )
        if (-not [Phase5ProductIdleNative]::SetCursorPos($centerX, $centerY)) {
            throw 'Unable to position the pointer on the bound product ball window.'
        }
        [Phase5ProductIdleNative]::SetForegroundWindow($ballWindow.Handle) | Out-Null
        Start-Sleep -Milliseconds 100
        if (-not [Phase5ProductIdleNative]::PointTargetsWindow($centerX, $centerY, $ballWindow.Handle)) {
            throw 'The product ball was occluded before the context-menu command.'
        }
        [Phase5ProductIdleNative]::mouse_event([Phase5ProductIdleNative]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [Phase5ProductIdleNative]::mouse_event([Phase5ProductIdleNative]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
        $menuDeadline = [DateTime]::UtcNow.AddSeconds(2)
        $contextMenuWindow = $null
        do {
            $contextMenuWindow = Get-ProductContextMenuWindow `
                -RootProcessId $RootProcessId `
                -PreClickWindowHandles $preClickWindowHandles `
                -TargetX $centerX `
                -TargetY $centerY
            if ($null -eq $contextMenuWindow) { Start-Sleep -Milliseconds 25 }
        } while ($null -eq $contextMenuWindow -and [DateTime]::UtcNow -lt $menuDeadline)
        if ($null -eq $contextMenuWindow) {
            throw 'The same-PID product context-menu popup was not observed.'
        }
        if (-not (
            [Phase5ProductIdleNative]::ForegroundIsWindow($contextMenuWindow.Handle) -or
            [Phase5ProductIdleNative]::ForegroundIsWindow($ballWindow.Handle)
        )) {
            throw 'The bound product context menu did not own the foreground.'
        }

        # Chromium Views exposes the Electron menu as a same-PID top-level
        # popup rather than an HMENU. Bind that newly-created HWND by geometry
        # and click the centre of its final row with a DPI-proportional inset.
        $exitCommandX = [int]($contextMenuWindow.Left + [Math]::Floor($contextMenuWindow.Width / 2))
        $exitCommandInset = [int][Math]::Max(12, [Math]::Round($contextMenuWindow.Height * 0.215))
        $exitCommandY = [int]($contextMenuWindow.Top + $contextMenuWindow.Height - $exitCommandInset)
        if (-not [Phase5ProductIdleNative]::SetCursorPos($exitCommandX, $exitCommandY)) {
            throw 'Unable to position the pointer on the bound product exit command.'
        }
        Start-Sleep -Milliseconds 50
        $sameMenuVisible = @([Phase5ProductIdleNative]::GetVisibleWindows($RootProcessId) | Where-Object {
            $_.Handle -eq $contextMenuWindow.Handle
        }).Count -eq 1
        if (-not $sameMenuVisible -or
            -not [Phase5ProductIdleNative]::PointTargetsWindow($exitCommandX, $exitCommandY, $contextMenuWindow.Handle) -or
            -not (
                [Phase5ProductIdleNative]::ForegroundIsWindow($contextMenuWindow.Handle) -or
                [Phase5ProductIdleNative]::ForegroundIsWindow($ballWindow.Handle)
            )) {
            throw 'The bound product exit menu target was lost before dispatch.'
        }
        if (-not [Phase5ProductIdleNative]::SendPrimaryClick()) {
            throw 'The verified product exit click could not be dispatched.'
        }
        $CommandIssued.Value = $true

        # The final enabled product menu item is "退出". END + ENTER selects
        # that real product command; no process termination API is used here.
    } finally {
        if ($cursorCaptured) {
            [Phase5ProductIdleNative]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null
        }
    }

    return [uint32][Phase5ProductIdleNative]::WaitForExactProcessExit(
        $rootHandle,
        ($TimeoutSeconds * 1000)
    )
}

function Get-WerEvents {
    param([Parameter(Mandatory = $true)][DateTime]$StartTimeUtc, [Parameter(Mandatory = $true)][DateTime]$EndTimeUtc)
    try {
        return @(Get-WinEvent -FilterHashtable @{
            LogName = 'Application'
            Id = @(1000, 1001)
            StartTime = $StartTimeUtc.ToLocalTime()
            EndTime = $EndTimeUtc.ToLocalTime()
        } -ErrorAction Stop)
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @() }
        throw
    }
}

function Write-WerReport {
    param(
        [Parameter(Mandatory = $true)][DateTime]$StartTimeUtc,
        [Parameter(Mandatory = $true)][DateTime]$EndTimeUtc,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$Acceptance
    )
    $inspectionFailures = [Collections.Generic.List[string]]::new()
    $matchingEvents = @()
    try {
        # Opening the log independently distinguishes a legitimate zero-event
        # result from an unavailable/unauthorized event-log query.
        Get-WinEvent -ListLog Application -ErrorAction Stop | Out-Null
        $matchingEvents = @(Get-WerEvents -StartTimeUtc $StartTimeUtc -EndTimeUtc $EndTimeUtc | Where-Object {
            $_.ProviderName -in @('Application Error', 'Windows Error Reporting') -and
            [string]$_.Message -match '(?i)(?:desktop-translate|selection-host)\.exe'
        })
    } catch {
        $inspectionFailures.Add('APPLICATION_EVENT_LOG_QUERY_FAILED')
    }

    $matchingCrashFiles = [Collections.Generic.List[object]]::new()
    $scanRoots = @(
        (Join-Path $env:LOCALAPPDATA 'CrashDumps'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportQueue'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportArchive'),
        (Join-Path $UserDataDirectory 'Crashpad\reports')
    )
    foreach ($scanRoot in $scanRoots) {
        if (-not (Test-Path -LiteralPath $scanRoot -PathType Container)) { continue }
        try {
            foreach ($file in @(Get-ChildItem -LiteralPath $scanRoot -Recurse -File -ErrorAction Stop | Where-Object {
                $_.LastWriteTimeUtc -ge $StartTimeUtc.AddSeconds(-2) -and
                $_.LastWriteTimeUtc -le $EndTimeUtc.AddSeconds(2) -and
                $_.Extension -in @('.dmp', '.wer')
            })) {
                $matchesProduct = $file.Name -match '(?i)(?:desktop-translate|selection-host)'
                if (-not $matchesProduct -and $file.Extension -eq '.wer') {
                    if ($file.Length -gt 16MB) {
                        $inspectionFailures.Add('WER_REPORT_EXCEEDS_INSPECTION_LIMIT')
                        continue
                    }
                    $matchesProduct = [IO.File]::ReadAllText($file.FullName) -match '(?i)(?:desktop-translate|selection-host)\.exe'
                }
                if ($matchesProduct) {
                    $matchingCrashFiles.Add([pscustomobject]@{ Extension = $file.Extension.ToLowerInvariant() })
                }
            }
        } catch {
            $inspectionFailures.Add('WER_OR_CRASH_DUMP_DIRECTORY_QUERY_FAILED')
        }
    }

    $eventCount = $matchingEvents.Count
    $dumpCount = @($matchingCrashFiles | Where-Object Extension -eq '.dmp').Count
    $werFileCount = @($matchingCrashFiles | Where-Object Extension -eq '.wer').Count
    $status = if ($inspectionFailures.Count -eq 0 -and $eventCount -eq 0 -and $dumpCount -eq 0 -and $werFileCount -eq 0) {
        'PASS'
    } else {
        'FAIL'
    }
    Write-AtomicJson -Path $Path -Value ([ordered]@{
        schemaVersion = '1.0.0'
        status = $status
        acceptance = $Acceptance
        scope = 'bound-run-application-error-wer-and-crash-dumps'
        applicationErrorOrWerEventCount = $eventCount
        crashDumpCount = $dumpCount
        werReportFileCount = $werFileCount
        inspectionFailures = @($inspectionFailures | Sort-Object -Unique)
        absolutePathPersisted = $false
    })
    if ($status -ne 'PASS') { throw 'WER/Application Error/crash-dump gate failed.' }
}

if ($StaticSelfTest) {
    if ($PSBoundParameters.Keys.Count -ne 1) {
        throw '-StaticSelfTest cannot be combined with run parameters.'
    }
    if ([IntPtr]::Size -ne 8 -or [Phase5ProductIdleNative]::GetInputLayoutSize() -ne 40) {
        throw 'The product Idle controller requires the Windows x64 INPUT layout.'
    }
    $selfSource = [IO.File]::ReadAllText($PSCommandPath)
    $forbiddenSourceTokens = @(
        ('WScript' + '.Shell'),
        ('.Send' + 'Keys('),
        ('task' + 'kill'),
        ('Stop' + '-Process'),
        ('if ($null -eq $managed) { return ' + '0 }')
    )
    foreach ($forbiddenSourceToken in $forbiddenSourceTokens) {
        if ($selfSource.IndexOf($forbiddenSourceToken, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'The product UI or failed-run cleanup source contains a forbidden blind/unsafe fallback.'
        }
    }
    $dpiInvocation = '[Phase5ProductIdleNative]::RequirePerMonitorDpiAwareness()'
    $startInvocation = '$process = Start-Process -FilePath $applicationExecutable'
    if ($selfSource.IndexOf($dpiInvocation, [StringComparison]::Ordinal) -lt 0 -or
        $selfSource.IndexOf($dpiInvocation, [StringComparison]::Ordinal) -gt
            $selfSource.IndexOf($startInvocation, [StringComparison]::Ordinal) -or
        ([regex]::Matches($selfSource, 'PointTargetsWindow\(').Count -lt 3) -or
        ([regex]::Matches($selfSource, 'ForegroundIsWindow\(').Count -lt 3) -or
        -not $selfSource.Contains('Get-ProductContextMenuWindow') -or
        -not $selfSource.Contains('[Phase5ProductIdleNative]::SendPrimaryClick()') -or
        -not $selfSource.Contains('[Phase5ProductIdleNative]::WaitForExactProcessExit(') -or
        -not $selfSource.Contains('[Phase5ProductIdleNative]::TerminateVerifiedProcessAndWait(')) {
        throw 'The hardened product UI exit or exact cleanup source contract is incomplete.'
    }
    Write-Host '[phase5-product-idle:selftest] DPI-aware popup binding, SendInput click, exact root wait, and verified cleanup PASS.'
    exit 0
}

[Phase5ProductIdleNative]::RequirePerMonitorDpiAwareness()

if (Test-Path -LiteralPath $OutputRoot) {
    throw "Output root already exists; select a new evidence directory: $OutputRoot"
}
if ($DevelopmentSelfTest) {
    if (-not $PSBoundParameters.ContainsKey('DurationSeconds') -or $DurationSeconds -ge 900) {
        throw 'Development selftest requires an explicit -DurationSeconds shorter than 900.'
    }
} else {
    if ($DurationSeconds -ne 900 -or $SampleIntervalSeconds -ne 5) {
        throw 'Formal Idle acceptance is frozen at exactly 900 seconds with a 5-second sample interval.'
    }
}

[IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
$gitSha = (& git -C $root rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[a-f0-9]{40}$') {
    throw 'Unable to bind the run to a 40-character git SHA.'
}
$gitStatus = @(& git -C $root status --porcelain=v1 --untracked-files=normal)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the source worktree.' }
$worktreeDirty = -not [string]::IsNullOrWhiteSpace($gitStatus -join "`n")

$summary = [ordered]@{
    schemaVersion = '1.0.0'
    phase = 5
    scenario = 'packaged-product-idle-resource'
    status = 'PENDING'
    acceptance = $false
    evidenceClass = if ($DevelopmentSelfTest) { 'DEVELOPMENT_SELFTEST_NOT_ACCEPTANCE' } else { 'FORMAL_ACCEPTANCE_CANDIDATE' }
    configuredDurationSeconds = $DurationSeconds
    sampleIntervalSeconds = $SampleIntervalSeconds
    nonAsciiUserData = $false
    gitSha = $gitSha
    worktreeDirty = $worktreeDirty
    artifact = [ordered]@{
        applicationFileName = 'desktop-translate.exe'
        applicationSha256 = $null
        hostFileName = 'selection-host.exe'
        hostSha256 = $null
        packageEvidenceManifestSha256 = $null
        applicationPathAndHashBound = $false
        hostPathAndHashBound = $false
        packageEvidenceManifestBound = $false
        absolutePathPersisted = $false
    }
    gracefulExit = [ordered]@{
        method = 'ball-context-menu-exit-command'
        productUiCommandIssued = $false
        forcedTerminationUsed = $false
        forcedCleanupStatus = 'NOT_REQUIRED'
        rootExited = $false
        exitCode = $null
    }
    gates = [ordered]@{
        artifactIdentity = 'PENDING'
        packageEvidenceIdentity = 'PENDING'
        preflightResidual = 'PENDING'
        productStartup = 'PENDING'
        idleResources = 'PENDING'
        gracefulExit = 'PENDING'
        postExitResidual = 'PENDING'
        werAndCrashDumps = 'PENDING'
        evidencePrivacy = 'PENDING'
        finalSummaryBinaryPrivacy = 'PENDING'
        isolatedDataCleanup = 'PENDING'
    }
    completedAt = $null
    failures = @()
    limitations = [string[]]$(if ($DevelopmentSelfTest) {
        @('Short development duration; this run can never be Phase 5 acceptance evidence.')
    } else {
        @('This gate covers product Idle resources and graceful exit only; it does not replace 8-hour lanes, signed RC, clean VM, compatibility matrix, Provider smoke, or sign-off.')
    })
}
Write-AtomicJson -Path $summaryPath -Value $summary

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-idle-' + [guid]::NewGuid().ToString('N'))
$nonAsciiSuffix = -join @([char]0x9636, [char]0x6BB5, [char]0x4E94, '-', [char]0x8D44, [char]0x6E90, [char]0x9A8C, [char]0x6536)
$userData = Join-Path $temporaryRoot ('User Data ' + $nonAsciiSuffix)
$process = $null
$rootProcessId = 0
$rootCreationTimeUtc = $null
$packageEvidenceManifestSha256 = $null
$pendingFinalRoot = $null
$finalSummaryCandidateRoot = $null
$failureCode = 'UNHANDLED_FAILURE'

try {
    foreach ($requiredFile in @($applicationExecutable, $hostExecutable)) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            $failureCode = 'PACKAGED_EXECUTABLE_MISSING'
            throw 'A required packaged executable is missing.'
        }
    }
    if (-not [IO.Path]::GetFileName($applicationExecutable).Equals('desktop-translate.exe', [StringComparison]::OrdinalIgnoreCase)) {
        $failureCode = 'APPLICATION_FILE_NAME_MISMATCH'
        throw 'The package application file name is not the frozen product name.'
    }
    $applicationSha256 = (Get-FileHash -LiteralPath $applicationExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $hostSha256 = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $summary.artifact.applicationSha256 = $applicationSha256
    $summary.artifact.hostSha256 = $hostSha256
    $summary.artifact.applicationPathAndHashBound = $true
    $summary.artifact.hostPathAndHashBound = $true
    $summary.gates.artifactIdentity = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    if ($requestedAcceptance) {
        $failureCode = 'FORMAL_SOURCE_OR_PACKAGE_IDENTITY_UNBOUND'
        if ($worktreeDirty) {
            throw 'Formal product Idle acceptance requires a clean Git worktree.'
        }
        if ($null -eq $packageEvidenceManifestPath -or
            -not (Test-Path -LiteralPath $packageEvidenceManifestPath -PathType Leaf)) {
            throw 'Formal product Idle acceptance requires -PackageEvidenceManifest.'
        }
        $packageEvidence = Get-Content -LiteralPath $packageEvidenceManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ([string]$packageEvidence.gitSha -ne $gitSha -or
            [bool]$packageEvidence.build.developmentDirty -ne $false -or
            [bool]$packageEvidence.build.acceptanceEligible -ne $true -or
            [string]$packageEvidence.build.sourceIdentity -ne "HEAD:$gitSha") {
            throw 'Package evidence is not bound to this clean, acceptance-eligible HEAD.'
        }
        if ([string]$packageEvidence.package.status -ne 'PASS' -or
            [string]$packageEvidence.package.startupSmokeStatus -ne 'PASS' -or
            [string]$packageEvidence.supplyChain.status -ne 'PASS' -or
            [string]$packageEvidence.signatures.status -ne 'PASS') {
            throw 'Package evidence is missing a required package, startup, supply-chain, or signature PASS.'
        }
        $manifestApplication = @($packageEvidence.signatures.artifacts | Where-Object role -eq 'application')
        $manifestHost = @($packageEvidence.signatures.artifacts | Where-Object role -eq 'nativeHost')
        if ($manifestApplication.Count -ne 1 -or $manifestHost.Count -ne 1 -or
            [string]$manifestApplication[0].name -ne 'desktop-translate.exe' -or
            [string]$manifestHost[0].name -ne 'selection-host.exe' -or
            [string]$manifestApplication[0].sha256 -ne $applicationSha256 -or
            [string]$manifestHost[0].sha256 -ne $hostSha256) {
            throw 'Package evidence artifact hashes do not match the executable and Host under test.'
        }
        $packageEvidenceManifestSha256 = (Get-FileHash -LiteralPath $packageEvidenceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $summary.artifact.packageEvidenceManifestSha256 = $packageEvidenceManifestSha256
        $summary.artifact.packageEvidenceManifestBound = $true
        $summary.gates.packageEvidenceIdentity = 'PASS'
    } else {
        $summary.gates.packageEvidenceIdentity = 'NOT_REQUIRED_DEVELOPMENT_SELFTEST'
    }
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'PREFLIGHT_RESIDUAL_FAILED'
    $preflightResidualArguments = @(
        '-ScopeRoot', $PackageDirectory,
        '-PackageDirectory', $PackageDirectory,
        '-OutputPath', (Join-Path $OutputRoot 'resources\preflight-residual.json'),
        '-WaitSeconds', '1',
        '-FailOnLeak'
    )
    if ($requestedAcceptance) { $preflightResidualArguments += '-Acceptance' }
    Invoke-CheckedPowerShell `
        -ScriptPath (Join-Path $PSScriptRoot 'phase5-residual-scan.ps1') `
        -Arguments $preflightResidualArguments
    $summary.gates.preflightResidual = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    [IO.Directory]::CreateDirectory($userData) | Out-Null
    $summary.nonAsciiUserData = $userData.ToCharArray() | Where-Object { [int]$_ -gt 127 } | Select-Object -First 1 | ForEach-Object { $true }
    if ($summary.nonAsciiUserData -ne $true) {
        $failureCode = 'NON_ASCII_USER_DATA_NOT_ESTABLISHED'
        throw 'The isolated userData path did not contain a non-ASCII character.'
    }

    $failureCode = 'PRODUCT_STARTUP_FAILED'
    $process = Start-Process -FilePath $applicationExecutable `
        -ArgumentList @("--user-data-dir=`"$userData`"") `
        -WorkingDirectory $temporaryRoot -PassThru
    $rootProcessId = $process.Id
    $rootCreationTimeUtc = $process.StartTime.ToUniversalTime()

    $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $hostReady = $false
    $ballReady = $false
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'The packaged product exited during startup.' }
        $hostReady = Test-ExpectedHostDescendant `
            -RootProcessId $rootProcessId `
            -RootCreationTimeUtc $rootCreationTimeUtc `
            -ExpectedHostPath $hostExecutable
        $ballReady = $null -ne (Get-BallWindow -RootProcessId $rootProcessId)
        if (-not ($hostReady -and $ballReady)) { Start-Sleep -Milliseconds 250 }
    } while (-not ($hostReady -and $ballReady) -and [DateTime]::UtcNow -lt $startupDeadline)
    if (-not $hostReady) { throw 'The bound packaged Host was not ready before the startup deadline.' }
    if (-not $ballReady) { throw 'The product ball window was not ready before the startup deadline.' }
    $summary.gates.productStartup = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'IDLE_RESOURCE_GATE_FAILED'
    $resourceArguments = @(
        '-RootProcessId', "$rootProcessId",
        '-OutputRoot', $resourceRoot,
        '-DurationSeconds', "$DurationSeconds",
        '-SampleIntervalSeconds', "$SampleIntervalSeconds",
        '-Profile', 'Idle',
        '-RootExecutablePath', $applicationExecutable,
        '-RootExecutableSha256', $applicationSha256,
        '-HostExecutablePath', $hostExecutable
    )
    if ($requestedAcceptance) { $resourceArguments += '-Acceptance' }
    Invoke-CheckedPowerShell -ScriptPath (Join-Path $PSScriptRoot 'phase5-resource-scan.ps1') -Arguments $resourceArguments
    $resourceSummary = Get-Content -LiteralPath (Join-Path $resourceRoot 'summary.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $expectedResourceStatus = if ($requestedAcceptance) { 'PASS' } else { 'SMOKE_PASS_NOT_ACCEPTANCE' }
    if ($resourceSummary.status -ne $expectedResourceStatus -or [bool]$resourceSummary.acceptance -ne $requestedAcceptance) {
        throw 'The resource sampler returned an incompatible evidence classification.'
    }
    $summary.gates.idleResources = if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE' }
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'GRACEFUL_EXIT_FAILED'
    $productUiCommandIssued = $false
    Write-AtomicJson -Path $summaryPath -Value $summary
    try {
        $exitCode = Request-GracefulExitThroughProductUi `
            -RootProcess $process `
            -RootProcessId $rootProcessId `
            -RootCreationTimeUtc $rootCreationTimeUtc `
            -ExpectedApplicationPath $applicationExecutable `
            -TimeoutSeconds $GracefulExitTimeoutSeconds `
            -CommandIssued ([ref]$productUiCommandIssued)
    } finally {
        $summary.gracefulExit.productUiCommandIssued = [bool]$productUiCommandIssued
        Write-AtomicJson -Path $summaryPath -Value $summary
    }
    $summary.gracefulExit.rootExited = $true
    $summary.gracefulExit.exitCode = $exitCode
    if ($exitCode -ne 0) { throw 'The product graceful-exit path returned a nonzero process exit code.' }
    $summary.gates.gracefulExit = 'PASS'
    $process.Dispose()
    $process = $null
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'POST_EXIT_RESIDUAL_FAILED'
    $postExitResidualArguments = @(
        '-ScopeRoot', $PackageDirectory,
        '-PackageDirectory', $PackageDirectory,
        '-RootProcessId', "$rootProcessId",
        '-RootCreationTimeUtc', $rootCreationTimeUtc.ToString('o'),
        '-OutputPath', (Join-Path $OutputRoot 'resources\post-exit-residual.json'),
        '-WaitSeconds', '10',
        '-FailOnLeak'
    )
    if ($requestedAcceptance) { $postExitResidualArguments += '-Acceptance' }
    Invoke-CheckedPowerShell `
        -ScriptPath (Join-Path $PSScriptRoot 'phase5-residual-scan.ps1') `
        -Arguments $postExitResidualArguments
    $summary.gates.postExitResidual = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'WER_OR_CRASH_DUMP_GATE_FAILED'
    Start-Sleep -Seconds 2
    Write-WerReport `
        -StartTimeUtc $startedAt.UtcDateTime `
        -EndTimeUtc ([DateTime]::UtcNow) `
        -UserDataDirectory $userData `
        -Path (Join-Path $OutputRoot 'resources\wer-summary.json') `
        -Acceptance $requestedAcceptance
    $summary.gates.werAndCrashDumps = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    $failureCode = 'ARTIFACT_CHANGED_DURING_RUN'
    if (-not (Get-FileHash -LiteralPath $applicationExecutable -Algorithm SHA256).Hash.ToLowerInvariant().Equals($applicationSha256, [StringComparison]::Ordinal) -or
        -not (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash.ToLowerInvariant().Equals($hostSha256, [StringComparison]::Ordinal)) {
        throw 'A bound packaged executable changed during the run.'
    }
    if ($requestedAcceptance -and
        -not (Get-FileHash -LiteralPath $packageEvidenceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant().Equals(
            $packageEvidenceManifestSha256,
            [StringComparison]::Ordinal
        )) {
        throw 'The bound package evidence manifest changed during the run.'
    }

    $failureCode = 'ISOLATED_DATA_CLEANUP_FAILED'
    $remainingOwned = @(Get-ExactOwnedRunProcesses `
        -RootProcessId $rootProcessId `
        -RootCreationTimeUtc $rootCreationTimeUtc `
        -ExpectedApplicationPath $applicationExecutable `
        -ExpectedHostPath $hostExecutable `
        -ExpectedUserDataPath $userData)
    if ($remainingOwned.Count -gt 0) {
        throw 'Run-owned processes remain before isolated-data cleanup.'
    }
    Remove-IsolatedDataRoot -Path $temporaryRoot -AllowedParent ([IO.Path]::GetTempPath())
    $summary.gates.isolatedDataCleanup = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary

    $pendingFinalRoot = Join-Path $securityRoot 'pending-final-scan'
    [IO.Directory]::CreateDirectory($pendingFinalRoot) | Out-Null
    Write-AtomicJson -Path (Join-Path $pendingFinalRoot 'summary.pending.json') -Value ([ordered]@{
        schemaVersion = '1.0.0'
        status = 'PENDING_FINAL_PRIVACY_SCAN'
        proposedStatus = if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE' }
        acceptance = $requestedAcceptance
        applicationSha256 = $applicationSha256
        hostSha256 = $hostSha256
        absolutePathPersisted = $false
    })

    $failureCode = 'EVIDENCE_PRIVACY_GATE_FAILED'
    Invoke-CheckedNode -Arguments @(
        (Join-Path $PSScriptRoot 'phase5-evidence-privacy-scan.mjs'),
        '--root', $OutputRoot,
        '--output', (Join-Path $securityRoot 'privacy-scan.json'),
        '--mode', 'evidence'
    )
    $summary.gates.evidencePrivacy = 'PASS'
    [IO.Directory]::Delete($pendingFinalRoot, $true)
    $pendingFinalRoot = $null
    Write-AtomicJson -Path $summaryPath -Value $summary

    # Keep the canonical summary PENDING while the exact final bytes are
    # scanned in a staging directory. Only a successful binary scan promotes
    # that already-scanned file atomically to summary.json.
    $failureCode = 'FINAL_SUMMARY_BINARY_PRIVACY_GATE_FAILED'
    $summary.status = if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE' }
    $summary.acceptance = $requestedAcceptance
    $summary.gates.finalSummaryBinaryPrivacy = 'PASS'
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $finalSummaryCandidateRoot = Join-Path $securityRoot 'pending-final-summary'
    [IO.Directory]::CreateDirectory($finalSummaryCandidateRoot) | Out-Null
    $finalSummaryCandidatePath = Join-Path $finalSummaryCandidateRoot 'summary.json'
    Write-AtomicJson -Path $finalSummaryCandidatePath -Value $summary
    Invoke-CheckedNode -Arguments @(
        (Join-Path $PSScriptRoot 'phase5-evidence-privacy-scan.mjs'),
        '--root', $OutputRoot,
        '--output', (Join-Path $securityRoot 'final-summary-binary-scan.json'),
        '--mode', 'binary'
    )
    if (-not [Phase5ProductIdleNative]::MoveFileEx(
        $finalSummaryCandidatePath,
        $summaryPath,
        [Phase5ProductIdleNative]::MOVEFILE_REPLACE_EXISTING -bor [Phase5ProductIdleNative]::MOVEFILE_WRITE_THROUGH
    )) {
        throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
    [IO.Directory]::Delete($finalSummaryCandidateRoot)
    $finalSummaryCandidateRoot = $null
    Write-Host "[phase5-product-idle] $($summary.status)"
    Write-Host "[phase5-product-idle] Evidence: $summaryPath"
    exit 0
} catch {
    $originalFailureMessage = $_.Exception.Message
    $summary.status = 'FAIL'
    $summary.acceptance = $false
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $summary.failures = @($failureCode)
    $summary.gates.gracefulExit = if ($failureCode -eq 'GRACEFUL_EXIT_FAILED') { 'FAIL' } else { $summary.gates.gracefulExit }

    if ($null -ne $pendingFinalRoot -and (Test-Path -LiteralPath $pendingFinalRoot -PathType Container)) {
        try { [IO.Directory]::Delete($pendingFinalRoot, $true) } catch {}
    }
    if ($null -ne $finalSummaryCandidateRoot -and (Test-Path -LiteralPath $finalSummaryCandidateRoot -PathType Container)) {
        try { [IO.Directory]::Delete($finalSummaryCandidateRoot, $true) } catch {}
    }

    $ownedProcesses = @()
    if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
        try {
            $ownedProcesses = @(Get-ExactOwnedRunProcesses `
                -RootProcessId $rootProcessId `
                -RootCreationTimeUtc $rootCreationTimeUtc `
                -ExpectedApplicationPath $applicationExecutable `
                -ExpectedHostPath $hostExecutable `
                -ExpectedUserDataPath $userData)
        } catch {}
    }
    if ($ownedProcesses.Count -gt 0) {
        # Persist the failure and forced-cleanup boundary before terminating
        # anything. A forced cleanup can never change the graceful gate to PASS.
        $summary.gracefulExit.forcedTerminationUsed = $true
        $summary.gracefulExit.forcedCleanupStatus = 'PENDING'
        try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
        try {
            Stop-ExactOwnedRunProcessTree `
                -RootProcessId $rootProcessId `
                -RootCreationTimeUtc $rootCreationTimeUtc `
                -ExpectedApplicationPath $applicationExecutable `
                -ExpectedHostPath $hostExecutable `
                -ExpectedUserDataPath $userData
            $summary.gracefulExit.forcedCleanupStatus = 'PASS_NOT_GRACEFUL'
        } catch {
            $summary.gracefulExit.forcedCleanupStatus = 'FAIL'
            $summary.failures = @($summary.failures + 'FAILED_RUN_FORCED_CLEANUP_FAILED' | Select-Object -Unique)
        }
    }

    if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
        try {
            $failedResidualArguments = @(
                '-ScopeRoot', $PackageDirectory,
                '-PackageDirectory', $PackageDirectory,
                '-RootProcessId', "$rootProcessId",
                '-RootCreationTimeUtc', $rootCreationTimeUtc.ToString('o'),
                '-OutputPath', (Join-Path $OutputRoot 'resources\failed-run-residual.json'),
                '-WaitSeconds', '10',
                '-FailOnLeak'
            )
            if ($requestedAcceptance) { $failedResidualArguments += '-Acceptance' }
            Invoke-CheckedPowerShell `
                -ScriptPath (Join-Path $PSScriptRoot 'phase5-residual-scan.ps1') `
                -Arguments $failedResidualArguments
            $summary.gates.postExitResidual = 'PASS_AFTER_FAILED_RUN'
        } catch {
            $summary.gates.postExitResidual = 'FAIL'
            $summary.failures = @($summary.failures + 'FAILED_RUN_RESIDUAL_FAILED' | Select-Object -Unique)
        }
        try {
            Write-WerReport `
                -StartTimeUtc $startedAt.UtcDateTime `
                -EndTimeUtc ([DateTime]::UtcNow) `
                -UserDataDirectory $userData `
                -Path (Join-Path $OutputRoot 'resources\failed-run-wer-summary.json') `
                -Acceptance $false
            $summary.gates.werAndCrashDumps = 'PASS_AFTER_FAILED_RUN'
        } catch {
            $summary.gates.werAndCrashDumps = 'FAIL'
            $summary.failures = @($summary.failures + 'FAILED_RUN_WER_OR_CRASH_DUMP_GATE_FAILED' | Select-Object -Unique)
        }
    }

    if (Test-Path -LiteralPath $temporaryRoot) {
        try {
            $remainingOwned = if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
                @(Get-ExactOwnedRunProcesses `
                    -RootProcessId $rootProcessId `
                    -RootCreationTimeUtc $rootCreationTimeUtc `
                    -ExpectedApplicationPath $applicationExecutable `
                    -ExpectedHostPath $hostExecutable `
                    -ExpectedUserDataPath $userData)
            } else {
                @()
            }
            if ($remainingOwned.Count -gt 0) { throw 'Run-owned processes remain after failed-run cleanup.' }
            Remove-IsolatedDataRoot -Path $temporaryRoot -AllowedParent ([IO.Path]::GetTempPath())
            $summary.gates.isolatedDataCleanup = 'PASS_AFTER_FAILED_RUN'
        } catch {
            $summary.gates.isolatedDataCleanup = 'FAIL'
            $summary.failures = @($summary.failures + 'FAILED_RUN_ISOLATED_DATA_CLEANUP_FAILED' | Select-Object -Unique)
        }
    }

    # Reuse the canonical report path: the scanner excludes its own output
    # while walking OutputRoot, so a prior report cannot contaminate this
    # failed-run scan through its findingCounts.absolutePath field.
    try {
        Invoke-CheckedNode -Arguments @(
            (Join-Path $PSScriptRoot 'phase5-evidence-privacy-scan.mjs'),
            '--root', $OutputRoot,
            '--output', (Join-Path $securityRoot 'privacy-scan.json'),
            '--mode', 'evidence'
        )
        $summary.gates.evidencePrivacy = 'PASS_AFTER_FAILED_RUN'
    } catch {
        $summary.gates.evidencePrivacy = 'FAIL'
        $summary.failures = @($summary.failures + 'FAILED_RUN_PRIVACY_GATE_FAILED' | Select-Object -Unique)
    }

    try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
    Write-Error "[phase5-product-idle] FAIL: $failureCode. $originalFailureMessage"
    exit 1
} finally {
    # Catch covers ordinary failures. This second, identity-bound safeguard is
    # for interruption paths that still execute finally. It records FAIL and
    # the forced boundary before cleanup, and never upgrades graceful exit.
    if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
        try {
            $finallyOwned = @(Get-ExactOwnedRunProcesses `
                -RootProcessId $rootProcessId `
                -RootCreationTimeUtc $rootCreationTimeUtc `
                -ExpectedApplicationPath $applicationExecutable `
                -ExpectedHostPath $hostExecutable `
                -ExpectedUserDataPath $userData)
            if ($finallyOwned.Count -gt 0) {
                $summary.status = 'FAIL'
                $summary.acceptance = $false
                $summary.gates.gracefulExit = 'FAIL'
                $summary.gracefulExit.forcedTerminationUsed = $true
                $summary.gracefulExit.forcedCleanupStatus = 'PENDING'
                $summary.failures = @($summary.failures + 'INTERRUPTED_RUN_FORCED_CLEANUP' | Select-Object -Unique)
                $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
                try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
                try {
                    Stop-ExactOwnedRunProcessTree `
                        -RootProcessId $rootProcessId `
                        -RootCreationTimeUtc $rootCreationTimeUtc `
                        -ExpectedApplicationPath $applicationExecutable `
                        -ExpectedHostPath $hostExecutable `
                        -ExpectedUserDataPath $userData
                    $summary.gracefulExit.forcedCleanupStatus = 'PASS_NOT_GRACEFUL'
                } catch {
                    $summary.gracefulExit.forcedCleanupStatus = 'FAIL'
                    $summary.failures = @($summary.failures + 'INTERRUPTED_RUN_FORCED_CLEANUP_FAILED' | Select-Object -Unique)
                }
                try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
            }
        } catch {
            $summary.status = 'FAIL'
            $summary.acceptance = $false
            $summary.gates.gracefulExit = 'FAIL'
            $summary.gracefulExit.forcedTerminationUsed = $true
            $summary.gracefulExit.forcedCleanupStatus = 'FAIL'
            $summary.failures = @($summary.failures + 'FINAL_RUN_OWNERSHIP_OR_CLEANUP_FAILED' | Select-Object -Unique)
            try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
        }
    }
    if ($null -ne $process) {
        try { $process.Dispose() } catch {
            $summary.status = 'FAIL'
            $summary.acceptance = $false
            $summary.failures = @($summary.failures + 'ROOT_PROCESS_HANDLE_DISPOSE_FAILED' | Select-Object -Unique)
        }
        $process = $null
    }

    # The catch path may have reached isolated-root deletion just before the
    # last package handle closed. Retry once more after exact process cleanup
    # and root-handle disposal; never leave that race hidden behind exit 1.
    if (Test-Path -LiteralPath $temporaryRoot) {
        try {
            $finalOwned = if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
                @(Get-ExactOwnedRunProcesses `
                    -RootProcessId $rootProcessId `
                    -RootCreationTimeUtc $rootCreationTimeUtc `
                    -ExpectedApplicationPath $applicationExecutable `
                    -ExpectedHostPath $hostExecutable `
                    -ExpectedUserDataPath $userData)
            } else {
                @()
            }
            if ($finalOwned.Count -gt 0) {
                throw 'Run-owned processes remain before final isolated-data cleanup.'
            }
            Remove-IsolatedDataRoot -Path $temporaryRoot -AllowedParent ([IO.Path]::GetTempPath())
            if ($summary.gates.isolatedDataCleanup -ne 'PASS') {
                $summary.gates.isolatedDataCleanup = 'PASS_AFTER_FINAL_CLEANUP'
            }
        } catch {
            $summary.status = 'FAIL'
            $summary.acceptance = $false
            $summary.gates.isolatedDataCleanup = 'FAIL'
            $summary.failures = @($summary.failures + 'FINAL_ISOLATED_DATA_CLEANUP_FAILED' | Select-Object -Unique)
        }
        try { Write-AtomicJson -Path $summaryPath -Value $summary } catch {}
    }
}

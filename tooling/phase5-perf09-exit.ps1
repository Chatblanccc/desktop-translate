[CmdletBinding()]
param(
    [Parameter()][string]$PackageDirectory,
    [Parameter()][string]$PackageEvidenceManifest,
    [Parameter()][string]$InstallerPath,
    [Parameter()][string]$FinalReleaseManifest,
    [Parameter()][string]$CleanDownloadVerification,
    [Parameter()][string]$IndependentTrustedRoot,
    [Parameter()][string]$DeviceRegistry,
    [Parameter()][string]$RunMetadata,
    [Parameter()][string]$OutputRoot,
    [Parameter()][ValidateRange(1, 3)][int]$RoundCount = 3,
    [Parameter()][ValidateRange(1, 50)][int]$SamplesPerRound = 50,
    [Parameter()][ValidateRange(10, 300)][int]$StartupTimeoutSeconds = 60,
    [Parameter()][ValidateRange(1, 10)][int]$ExitTimeoutSeconds = 10,
    [Parameter()][switch]$DevelopmentSelfTest,
    [Parameter()][switch]$StaticSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:FormalRoundCount = 3
$script:FormalSamplesPerRound = 50
$script:FormalExitTimeoutSeconds = 10
$script:ForbiddenSampleKeys = @(
    'pid', 'hwnd', 'path', 'absolutePath', 'windowTitle', 'sourceText',
    'translatedText', 'selectedText', 'screenshot', 'pipeName', 'nonce',
    'secret', 'token', 'requestBody', 'responseBody', 'rawException'
)

function Assert-Condition {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($null -eq $Value) { throw "$Label is missing." }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expectedSorted = @($Expected | Sort-Object)
    if (@(Compare-Object -ReferenceObject $expectedSorted -DifferenceObject $actual).Count -ne 0) {
        throw "$Label contains missing or unknown fields."
    }
}

function Assert-SafeMetadataText {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter()][int]$MaximumLength = 256
    )
    if (
        [string]::IsNullOrWhiteSpace($Value) -or
        $Value.Length -gt $MaximumLength -or
        $Value -match '(?i)^replace(?:-|_)' -or
        $Value -match '[\x00-\x1f]' -or
        $Value -match '(?i)(?:^|[^A-Za-z0-9:+.-])[A-Za-z]:[\\/]' -or
        $Value -match '(?:^|[^:])(?:\\\\|//)[^\\/\s]+[\\/]'
    ) {
        throw "$Label is empty, unsafe, or contains a local path."
    }
}

function Assert-JsonBoolean {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][bool]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value -isnot [bool] -or $Value -ne $Expected) {
        throw "$Label must be the JSON boolean $($Expected.ToString().ToLowerInvariant())."
    }
}

function Test-StringArrayEqual {
    param([string[]]$Left, [string[]]$Right)
    $leftSorted = @($Left | Sort-Object)
    $rightSorted = @($Right | Sort-Object)
    if ($leftSorted.Count -ne $rightSorted.Count) { return $false }
    for ($index = 0; $index -lt $leftSorted.Count; $index += 1) {
        if (-not $leftSorted[$index].Equals($rightSorted[$index], [StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Get-NearestRank {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][double]$Percentile
    )
    if ($Values.Count -eq 0) { return $null }
    if ($Percentile -le 0 -or $Percentile -gt 1) { throw 'Percentile must be in (0, 1].' }
    $sorted = @($Values | Sort-Object)
    $rank = [Math]::Ceiling($Percentile * $sorted.Count)
    return [double]$sorted[[Math]::Max(0, $rank - 1)]
}

function Assert-InvocationMode {
    param(
        [bool]$Development,
        [int]$Rounds,
        [int]$Samples,
        [int]$ExitTimeout,
        [bool]$RoundWasExplicit,
        [bool]$SamplesWereExplicit
    )
    if ($Development) {
        if (-not $RoundWasExplicit -or -not $SamplesWereExplicit) {
            throw 'Development selftest requires explicit -RoundCount and -SamplesPerRound.'
        }
        if ($Rounds -gt 2 -or $Samples -gt 5) {
            throw 'Development selftest is restricted to at most 2 rounds and 5 samples per round.'
        }
        return
    }
    if (
        $Rounds -ne $script:FormalRoundCount -or
        $Samples -ne $script:FormalSamplesPerRound -or
        $ExitTimeout -ne $script:FormalExitTimeoutSeconds
    ) {
        throw 'Formal PERF-09 is frozen at 3 rounds, 50 samples per round, and a 10-second exit deadline.'
    }
}

function New-SampleRecord {
    param(
        [int]$Round,
        [int]$Sample,
        [double]$DurationMs,
        [string]$Status,
        [AllowNull()][string]$StableErrorCode,
        [string]$EvidenceLevel,
        [string]$BuildMode
    )
    return [ordered]@{
        schemaVersion = 'phase5-perf09-sample-v1'
        metricId = 'PERF-09'
        scenario = 'normal-product-ui-exit-to-bound-process-tree-empty'
        evidenceLevel = $EvidenceLevel
        buildMode = $BuildMode
        round = $Round
        sample = $Sample
        durationMs = [Math]::Round([Math]::Max([double]0, $DurationMs), 3)
        status = $Status
        stableErrorCode = $StableErrorCode
    }
}

function Test-Perf09RoundPass {
    param(
        [Parameter(Mandatory = $true)]$RoundSummary,
        [Parameter(Mandatory = $true)][int]$ExpectedSampleCount
    )
    return (
        [int]$RoundSummary.failureCount -eq 0 -and
        [int]$RoundSummary.successCount -eq $ExpectedSampleCount -and
        [double]$RoundSummary.p50Ms -le 2000 -and
        [double]$RoundSummary.p95Ms -le 5000 -and
        [double]$RoundSummary.maxMs -le 10000
    )
}

function Invoke-StaticSelfTest {
    Assert-Condition -Condition ((Get-NearestRank -Values @(1.0, 2.0, 3.0, 4.0) -Percentile 0.50) -eq 2.0) -Message 'nearest-rank p50 selftest failed.'
    Assert-Condition -Condition ((Get-NearestRank -Values @(1.0, 2.0, 3.0, 4.0) -Percentile 0.95) -eq 4.0) -Message 'nearest-rank p95 selftest failed.'

    Assert-InvocationMode -Development $false -Rounds 3 -Samples 50 -ExitTimeout 10 -RoundWasExplicit $false -SamplesWereExplicit $false
    $formalRejected = $false
    try {
        Assert-InvocationMode -Development $false -Rounds 3 -Samples 49 -ExitTimeout 10 -RoundWasExplicit $true -SamplesWereExplicit $true
    } catch {
        $formalRejected = $true
    }
    Assert-Condition -Condition $formalRejected -Message 'Formal sample-count negative selftest failed.'

    $developmentRejected = $false
    try {
        Assert-InvocationMode -Development $true -Rounds 1 -Samples 1 -ExitTimeout 10 -RoundWasExplicit $false -SamplesWereExplicit $false
    } catch {
        $developmentRejected = $true
    }
    Assert-Condition -Condition $developmentRejected -Message 'Development explicit-count negative selftest failed.'

    $sample = New-SampleRecord -Round 1 -Sample 1 -DurationMs 12.5 -Status 'FAIL' -StableErrorCode 'EXIT_TREE_TIMEOUT' -EvidenceLevel 'development-selftest' -BuildMode 'packaged-development'
    Assert-ExactProperties -Value ([pscustomobject]$sample) -Expected @(
        'schemaVersion', 'metricId', 'scenario', 'evidenceLevel', 'buildMode',
        'round', 'sample', 'durationMs', 'status', 'stableErrorCode'
    ) -Label 'sample evidence'
    foreach ($key in $script:ForbiddenSampleKeys) {
        Assert-Condition -Condition (-not $sample.Contains($key)) -Message "Forbidden sample field was emitted: $key"
    }
    $staticStatus = [string]$sample['status']
    $staticDuration = [double]$sample['durationMs']
    Assert-Condition -Condition (
        $staticStatus -eq 'FAIL' -and $staticDuration -eq 12.5
    ) -Message "FAIL-before-cleanup evidence selftest failed ($staticStatus/$staticDuration)."

    $passingRound = [pscustomobject]@{
        failureCount = 0
        successCount = 50
        p50Ms = 2000
        p95Ms = 5000
        maxMs = 10000
    }
    Assert-Condition -Condition (
        Test-Perf09RoundPass -RoundSummary $passingRound -ExpectedSampleCount 50
    ) -Message 'Exact PERF-09 threshold boundary should pass.'
    $passingRound.maxMs = 10000.001
    Assert-Condition -Condition (-not (
        Test-Perf09RoundPass -RoundSummary $passingRound -ExpectedSampleCount 50
    )) -Message 'PERF-09 max threshold negative selftest failed.'
    $passingRound.maxMs = 10000
    $passingRound.failureCount = 1
    Assert-Condition -Condition (-not (
        Test-Perf09RoundPass -RoundSummary $passingRound -ExpectedSampleCount 50
    )) -Message 'PERF-09 zero-failure negative selftest failed.'

    $unknownMetadataRejected = $false
    try {
        Assert-ExactProperties -Value ([pscustomobject]@{
            schemaVersion = 'phase5-perf09-run-metadata-v1'
            run = [pscustomobject]@{}
            environment = [pscustomobject]@{}
            unexpected = 'fail-closed'
        }) -Expected @('schemaVersion', 'run', 'environment') -Label 'metadata negative selftest'
    } catch {
        $unknownMetadataRejected = $true
    }
    Assert-Condition -Condition $unknownMetadataRejected -Message 'Unknown metadata field negative selftest failed.'
    $stringBooleanRejected = $false
    try {
        Assert-JsonBoolean -Value 'false' -Expected $false -Label 'boolean negative selftest'
    } catch {
        $stringBooleanRejected = $true
    }
    Assert-Condition -Condition $stringBooleanRejected -Message 'String boolean negative selftest failed.'
    $placeholderRejected = $false
    try {
        Assert-SafeMetadataText -Value 'replace-device-registration-id' -Label 'placeholder negative selftest'
    } catch {
        $placeholderRejected = $true
    }
    Assert-Condition -Condition $placeholderRejected -Message 'replace-* metadata placeholder negative selftest failed.'
    Write-Host '[phase5:perf09:selftest] nearest-rank, thresholds, frozen counts, metadata fail-closed, explicit development mode, and privacy allowlist PASS.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-safe-filesystem.ps1')

$modeArguments = @{
    Development = [bool]$DevelopmentSelfTest
    Rounds = $RoundCount
    Samples = $SamplesPerRound
    ExitTimeout = $ExitTimeoutSeconds
    RoundWasExplicit = $PSBoundParameters.ContainsKey('RoundCount')
    SamplesWereExplicit = $PSBoundParameters.ContainsKey('SamplesPerRound')
}
Assert-InvocationMode @modeArguments

if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $PackageDirectory = Join-Path $repositoryRoot 'artifacts\phase5\package\dist\win-unpacked'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $OutputRoot = Join-Path $repositoryRoot "artifacts\phase5\local\perf09-exit-$stamp"
}

$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$applicationExecutable = Join-Path $PackageDirectory 'desktop-translate.exe'
$hostExecutable = Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'
$consoleHostExecutable = [IO.Path]::GetFullPath((Join-Path ([Environment]::SystemDirectory) 'conhost.exe'))
$appAsar = Join-Path $PackageDirectory 'resources\app.asar'
$packageEvidenceManifestPath = if ([string]::IsNullOrWhiteSpace($PackageEvidenceManifest)) {
    $null
} else {
    [IO.Path]::GetFullPath($PackageEvidenceManifest)
}
$installerPathResolved = if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $null
} else {
    [IO.Path]::GetFullPath($InstallerPath)
}
$finalReleaseManifestPath = if ([string]::IsNullOrWhiteSpace($FinalReleaseManifest)) {
    $null
} else {
    [IO.Path]::GetFullPath($FinalReleaseManifest)
}
$cleanDownloadVerificationPath = if ([string]::IsNullOrWhiteSpace($CleanDownloadVerification)) {
    $null
} else {
    [IO.Path]::GetFullPath($CleanDownloadVerification)
}
$independentTrustedRootPath = if ([string]::IsNullOrWhiteSpace($IndependentTrustedRoot)) {
    $null
} else {
    [IO.Path]::GetFullPath($IndependentTrustedRoot)
}
$deviceRegistryPath = if ([string]::IsNullOrWhiteSpace($DeviceRegistry)) {
    $null
} else {
    [IO.Path]::GetFullPath($DeviceRegistry)
}
$runMetadataPath = if ([string]::IsNullOrWhiteSpace($RunMetadata)) {
    $null
} else {
    [IO.Path]::GetFullPath($RunMetadata)
}
$summaryPath = Join-Path $OutputRoot 'summary.json'
$rawPath = Join-Path $OutputRoot 'raw.jsonl'
$privacyPath = Join-Path $OutputRoot 'privacy-scan.json'
$requestedAcceptance = -not [bool]$DevelopmentSelfTest

if (Test-Path -LiteralPath $OutputRoot) {
    throw 'OutputRoot already exists; PERF-09 evidence is append-never and requires a new directory.'
}
if (
    $OutputRoot.Equals($PackageDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($PackageDirectory + '\', [StringComparison]::OrdinalIgnoreCase)
) {
    throw 'OutputRoot must not be inside the bound package artifact.'
}

if (-not ('Phase5Perf09Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class Phase5Perf09WindowInfo {
    public IntPtr Handle { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public sealed class Phase5Perf09DisplayInfo {
    public int Width { get; set; }
    public int Height { get; set; }
    public int DpiPercent { get; set; }
    public bool Primary { get; set; }
}

public sealed class Phase5Perf09MenuInfo {
    public IntPtr Handle { get; set; }
    public int ItemCount { get; set; }
    public string LastItemText { get; set; }
    public bool LastItemEnabled { get; set; }
    public bool LastItemHighlighted { get; set; }
}

public sealed class Phase5Perf09ProcessInfo {
    public int ProcessId { get; set; }
    public int ParentProcessId { get; set; }
    public string ExecutablePath { get; set; }
    public long CreationTimeUtcTicks { get; set; }
    public bool IdentityAvailable { get; set; }
}

public sealed class Phase5Perf09LaunchFailureException : Exception, IDisposable {
    private IntPtr jobHandle;
    private IntPtr processHandle;
    private IntPtr threadHandle;
    private readonly bool assignedToJob;
    private bool disposed;

    internal Phase5Perf09LaunchFailureException(
        string message,
        Exception innerException,
        IntPtr job,
        IntPtr process,
        IntPtr thread,
        bool assigned,
        int processId,
        long creationTimeUtcTicks,
        string executablePath
    ) : base(message, innerException) {
        jobHandle = job;
        processHandle = process;
        threadHandle = thread;
        assignedToJob = assigned;
        ProcessId = processId;
        CreationTimeUtcTicks = creationTimeUtcTicks;
        ExecutablePath = executablePath;
    }

    public int ProcessId { get; private set; }
    public long CreationTimeUtcTicks { get; private set; }
    public string ExecutablePath { get; private set; }

    public void TerminateAndWait(int timeoutMilliseconds) {
        ThrowIfDisposed();
        Phase5Perf09JobRun.TerminateFailedLaunchHandles(
            jobHandle,
            processHandle,
            assignedToJob,
            timeoutMilliseconds
        );
    }

    private void ThrowIfDisposed() {
        if (disposed || processHandle == IntPtr.Zero) {
            throw new ObjectDisposedException("Phase5Perf09LaunchFailureException");
        }
    }

    public void Dispose() {
        if (disposed) return;
        disposed = true;
        Phase5Perf09JobRun.CloseNativeHandle(ref threadHandle);
        Phase5Perf09JobRun.CloseNativeHandle(ref jobHandle);
        Phase5Perf09JobRun.CloseNativeHandle(ref processHandle);
        GC.SuppressFinalize(this);
    }

    ~Phase5Perf09LaunchFailureException() { Dispose(); }
}

public sealed class Phase5Perf09JobRun : IDisposable {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ERROR_MORE_DATA = 234;
    private const uint STILL_ACTIVE = 259;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO {
        public uint Size;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint informationLength, IntPtr returnLength);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    private static extern bool QueryInformationJobObjectRaw(IntPtr job, int informationClass, IntPtr information, uint informationLength, IntPtr returnLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr jobHandle;
    private IntPtr processHandle;
    private bool disposed;

    private Phase5Perf09JobRun(IntPtr job, IntPtr process, int processId, long creationTimeUtcTicks) {
        jobHandle = job;
        processHandle = process;
        ProcessId = processId;
        CreationTimeUtcTicks = creationTimeUtcTicks;
    }

    public int ProcessId { get; private set; }
    public long CreationTimeUtcTicks { get; private set; }

    public static int[] GetNativeLayoutSizes() {
        return new[] {
            Marshal.SizeOf(typeof(STARTUPINFO)),
            Marshal.SizeOf(typeof(PROCESS_INFORMATION)),
            Marshal.SizeOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION)),
            Marshal.SizeOf(typeof(IO_COUNTERS)),
            Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)),
            Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION))
        };
    }

    public static Phase5Perf09JobRun Launch(string applicationPath, string userDataDirectory, string workingDirectory) {
        if (String.IsNullOrWhiteSpace(applicationPath) || String.IsNullOrWhiteSpace(userDataDirectory) || String.IsNullOrWhiteSpace(workingDirectory)) {
            throw new ArgumentException("The job launch identity is incomplete.");
        }
        applicationPath = Path.GetFullPath(applicationPath);
        workingDirectory = Path.GetFullPath(workingDirectory);
        if (!File.Exists(applicationPath) || !Directory.Exists(workingDirectory) || applicationPath.IndexOf('"') >= 0 || userDataDirectory.IndexOf('"') >= 0) {
            throw new ArgumentException("The job launch identity is invalid.");
        }

        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the sample job object.");
        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
        var created = false;
        var assigned = false;
        var creationTimeUtcTicks = 0L;
        try {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            var limitsPointer = Marshal.AllocHGlobal(limitsSize);
            try {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPointer, (uint)limitsSize)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to configure the sample job object.");
                }
            } finally {
                Marshal.FreeHGlobal(limitsPointer);
            }

            var startup = new STARTUPINFO();
            startup.Size = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            var commandLine = new StringBuilder("\"" + applicationPath + "\" --user-data-dir=\"" + userDataDirectory + "\"");
            if (!CreateProcessW(applicationPath, commandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, workingDirectory, ref startup, out processInformation)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the suspended product process.");
            }
            created = true;
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(processInformation.Process, out creation, out exit, out kernel, out user)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to capture the suspended root identity.");
            }
            var fileTime = ((long)creation.High << 32) | creation.Low;
            creationTimeUtcTicks = DateTime.FromFileTimeUtc(fileTime).Ticks;
            var actualImage = new StringBuilder(32768);
            var actualImageLength = actualImage.Capacity;
            if (!QueryFullProcessImageName(processInformation.Process, 0, actualImage, ref actualImageLength) ||
                !String.Equals(Path.GetFullPath(actualImage.ToString()), applicationPath, StringComparison.OrdinalIgnoreCase)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The suspended product image identity changed before resume.");
            }
            if (!AssignProcessToJobObject(job, processInformation.Process)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to bind the product process to its sample job object.");
            }
            assigned = true;
            bool assignedToExactJob;
            if (!IsProcessInJob(processInformation.Process, job, out assignedToExactJob) || !assignedToExactJob) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The suspended product process did not bind to its exact sample job object.");
            }
            var previousSuspendCount = ResumeThread(processInformation.Thread);
            if (previousSuspendCount == UInt32.MaxValue) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resume the bound product process.");
            }
            if (previousSuspendCount != 1) {
                throw new InvalidOperationException("The bound root suspend count was not exactly one.");
            }
            CloseHandle(processInformation.Thread);
            processInformation.Thread = IntPtr.Zero;
            return new Phase5Perf09JobRun(job, processInformation.Process, checked((int)processInformation.ProcessId), creationTimeUtcTicks);
        } catch (Exception launchError) {
            if (!created || processInformation.Process == IntPtr.Zero) {
                CloseNativeHandle(ref processInformation.Thread);
                CloseNativeHandle(ref processInformation.Process);
                CloseNativeHandle(ref job);
                throw;
            }
            if (creationTimeUtcTicks == 0) {
                FILETIME retryCreation;
                FILETIME retryExit;
                FILETIME retryKernel;
                FILETIME retryUser;
                if (GetProcessTimes(processInformation.Process, out retryCreation, out retryExit, out retryKernel, out retryUser)) {
                    var retryFileTime = ((long)retryCreation.High << 32) | retryCreation.Low;
                    creationTimeUtcTicks = DateTime.FromFileTimeUtc(retryFileTime).Ticks;
                }
            }
            Exception cleanupError = null;
            try {
                TerminateFailedLaunchHandles(job, processInformation.Process, assigned, 15000);
            } catch (Exception error) {
                cleanupError = error;
            }
            if (cleanupError == null) {
                CloseNativeHandle(ref processInformation.Thread);
                CloseNativeHandle(ref processInformation.Process);
                CloseNativeHandle(ref job);
                throw;
            }
            // Ownership of every native handle transfers to the exception.
            // The PowerShell sample catch extracts its exact PID/creation/path,
            // retries handle-backed termination, then runs the ordinary exact
            // identity cleanup before disposing this lease.
            var retained = new Phase5Perf09LaunchFailureException(
                "The failed suspended launch could not be confirmed terminated.",
                new AggregateException(launchError, cleanupError),
                job,
                processInformation.Process,
                processInformation.Thread,
                assigned,
                checked((int)processInformation.ProcessId),
                creationTimeUtcTicks,
                applicationPath
            );
            job = IntPtr.Zero;
            processInformation.Process = IntPtr.Zero;
            processInformation.Thread = IntPtr.Zero;
            throw retained;
        }
    }

    private static int GetActiveProcessCount(IntPtr job) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to query the sample job object.");
        }
        return checked((int)information.ActiveProcesses);
    }

    private static void TerminateJobHandleAndWait(IntPtr job, int timeoutMilliseconds) {
        if (job == IntPtr.Zero || GetActiveProcessCount(job) == 0) return;
        if (!TerminateJobObject(job, 1)) {
            var terminateError = Marshal.GetLastWin32Error();
            if (GetActiveProcessCount(job) != 0) {
                throw new Win32Exception(terminateError, "Unable to terminate the failed-launch job object.");
            }
        }
        var timer = Stopwatch.StartNew();
        while (GetActiveProcessCount(job) != 0 && timer.ElapsedMilliseconds < timeoutMilliseconds) Thread.Sleep(5);
        if (GetActiveProcessCount(job) != 0) {
            throw new TimeoutException("The failed-launch job object did not become empty.");
        }
    }

    private static void TerminateProcessHandleAndWait(IntPtr process, int timeoutMilliseconds) {
        if (process == IntPtr.Zero) throw new ArgumentException("The process handle is missing.", "process");
        uint exitCode;
        var exitCodeReadable = GetExitCodeProcess(process, out exitCode);
        var alreadyExited = exitCodeReadable && exitCode != STILL_ACTIVE;
        var terminateError = 0;
        if (!alreadyExited && !TerminateProcess(process, 1)) terminateError = Marshal.GetLastWin32Error();

        var wait = WaitForSingleObject(process, checked((uint)timeoutMilliseconds));
        var waitError = wait == WAIT_FAILED ? Marshal.GetLastWin32Error() : 0;
        uint finalExitCode;
        var finalExitCodeReadable = GetExitCodeProcess(process, out finalExitCode);
        if (wait == WAIT_OBJECT_0 && finalExitCodeReadable && finalExitCode != STILL_ACTIVE) return;
        if (wait == WAIT_FAILED) {
            throw new Win32Exception(waitError, "Waiting for the failed suspended process failed.");
        }
        if (wait == WAIT_TIMEOUT) {
            throw new TimeoutException("The failed suspended process did not terminate before the cleanup deadline.");
        }
        if (terminateError != 0) {
            throw new Win32Exception(terminateError, "Unable to terminate the failed suspended process.");
        }
        if (!finalExitCodeReadable) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The failed suspended process exit status is unavailable.");
        }
        throw new InvalidOperationException("The failed suspended process remained active after termination.");
    }

    internal static void TerminateFailedLaunchHandles(IntPtr job, IntPtr process, bool assignedToJob, int timeoutMilliseconds) {
        if (timeoutMilliseconds < 1) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
        var failures = new List<Exception>();
        if (assignedToJob) {
            try { TerminateJobHandleAndWait(job, timeoutMilliseconds); }
            catch (Exception error) { failures.Add(error); }
        }
        try { TerminateProcessHandleAndWait(process, timeoutMilliseconds); }
        catch (Exception error) { failures.Add(error); }
        if (failures.Count == 1) throw failures[0];
        if (failures.Count > 1) throw new AggregateException("Failed-launch process cleanup was not confirmed.", failures);
    }

    internal static void CloseNativeHandle(ref IntPtr handle) {
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    public int GetActiveProcessCount() {
        ThrowIfDisposed();
        return GetActiveProcessCount(jobHandle);
    }

    public int[] GetActiveProcessIds() {
        ThrowIfDisposed();
        var capacity = 64;
        while (capacity <= 4096) {
            var bytes = checked(8 + (capacity * IntPtr.Size));
            var buffer = Marshal.AllocHGlobal(bytes);
            try {
                for (var offset = 0; offset < bytes; offset += 4) Marshal.WriteInt32(buffer, offset, 0);
                if (QueryInformationJobObjectRaw(jobHandle, JobObjectBasicProcessIdList, buffer, (uint)bytes, IntPtr.Zero)) {
                    var listed = checked((int)(uint)Marshal.ReadInt32(buffer, 4));
                    if (listed > capacity) throw new InvalidOperationException("The Job process-id list exceeded its successful buffer.");
                    var result = new int[listed];
                    for (var index = 0; index < listed; index++) {
                        var value = IntPtr.Size == 8
                            ? Marshal.ReadInt64(buffer, 8 + (index * IntPtr.Size))
                            : Marshal.ReadInt32(buffer, 8 + (index * IntPtr.Size));
                        result[index] = checked((int)value);
                    }
                    return result;
                }
                var error = Marshal.GetLastWin32Error();
                if (error != ERROR_MORE_DATA) {
                    throw new Win32Exception(error, "Unable to query the active Job process-id list.");
                }
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
            capacity *= 2;
        }
        throw new InvalidOperationException("The Job process-id list exceeded the bounded observer capacity.");
    }

    public int GetRootExitCode() {
        ThrowIfDisposed();
        uint exitCode;
        if (!GetExitCodeProcess(processHandle, out exitCode)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read the root exit code.");
        }
        if (exitCode == STILL_ACTIVE) throw new InvalidOperationException("The root process is still active.");
        return unchecked((int)exitCode);
    }

    public bool ContainsProcess(int processId) {
        ThrowIfDisposed();
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return false;
        try {
            bool result;
            if (!IsProcessInJob(process, jobHandle, out result)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to verify process Job membership.");
            }
            return result;
        } finally {
            CloseHandle(process);
        }
    }

    public void TerminateAndWait(int timeoutMilliseconds) {
        ThrowIfDisposed();
        if (timeoutMilliseconds < 1) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
        TerminateJobHandleAndWait(jobHandle, timeoutMilliseconds);
    }

    private void ThrowIfDisposed() {
        if (disposed || jobHandle == IntPtr.Zero || processHandle == IntPtr.Zero) throw new ObjectDisposedException("Phase5Perf09JobRun");
    }

    public void Dispose() {
        if (disposed) return;
        disposed = true;
        CloseNativeHandle(ref jobHandle);
        CloseNativeHandle(ref processHandle);
        GC.SuppressFinalize(this);
    }

    ~Phase5Perf09JobRun() { Dispose(); }
}

public static class Phase5Perf09Native {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rectangle, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFOEX {
        public int Size;
        public RECT Monitor;
        public RECT Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    }

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
        [FieldOffset(0)] public KEYBDINPUT Keyboard;
        [FieldOffset(0)] public HARDWAREINPUT Hardware;
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
    private struct KEYBDINPUT {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT {
        public uint Message;
        public ushort ParameterLow;
        public ushort ParameterHigh;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SYSTEM_POWER_STATUS {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct APPBARDATA {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public RECT rc;
        public IntPtr lParam;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 {
        public uint Size;
        public uint UsageCount;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint ThreadCount;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExecutableFile;
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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maximum);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int maximum, uint flags);
    [DllImport("user32.dll")]
    private static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    [DllImport("shcore.dll")]
    private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scalePercent);
    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("shcore.dll")]
    private static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);
    [DllImport("kernel32.dll")]
    private static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
    [DllImport("shell32.dll")]
    private static extern UIntPtr SHAppBarMessage(uint message, ref APPBARDATA data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string existingPath, string newPath, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
    public const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    public static uint LastSendInputCount { get; private set; }
    public static int LastSendInputError { get; private set; }

    public static int GetProcessEntryLayoutSize() {
        return Marshal.SizeOf(typeof(PROCESSENTRY32));
    }

    public static Phase5Perf09ProcessInfo[] GetActiveConsoleBrokers() {
        const uint TH32CS_SNAPPROCESS = 0x00000002;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint STILL_ACTIVE = 259;
        const int ERROR_NO_MORE_FILES = 18;
        const int ERROR_INVALID_PARAMETER = 87;
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to snapshot console broker processes.");
        }
        var result = new List<Phase5Perf09ProcessInfo>();
        try {
            var entry = new PROCESSENTRY32();
            entry.Size = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry)) {
                var firstError = Marshal.GetLastWin32Error();
                if (firstError == ERROR_NO_MORE_FILES) return result.ToArray();
                throw new Win32Exception(firstError, "Unable to read the first process snapshot entry.");
            }
            do {
                if (!String.Equals(entry.ExecutableFile, "conhost.exe", StringComparison.OrdinalIgnoreCase)) continue;
                var processId = checked((int)entry.ProcessId);
                var parentProcessId = checked((int)entry.ParentProcessId);
                var record = new Phase5Perf09ProcessInfo {
                    ProcessId = processId,
                    ParentProcessId = parentProcessId,
                    ExecutablePath = String.Empty,
                    CreationTimeUtcTicks = 0,
                    IdentityAvailable = false
                };
                var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
                if (process == IntPtr.Zero) {
                    // ERROR_INVALID_PARAMETER is the normal race when a snapshot
                    // entry exits before OpenProcess. Other failures remain in
                    // the result so a same-run parent makes observation fail closed.
                    if (Marshal.GetLastWin32Error() != ERROR_INVALID_PARAMETER) result.Add(record);
                    continue;
                }
                try {
                    uint exitCode;
                    if (!GetExitCodeProcess(process, out exitCode) || exitCode != STILL_ACTIVE) continue;
                    FILETIME creation;
                    FILETIME exit;
                    FILETIME kernel;
                    FILETIME user;
                    var path = new StringBuilder(32768);
                    var pathLength = path.Capacity;
                    if (
                        GetProcessTimes(process, out creation, out exit, out kernel, out user) &&
                        QueryFullProcessImageName(process, 0, path, ref pathLength)
                    ) {
                        var fileTime = ((long)creation.High << 32) | creation.Low;
                        record.ExecutablePath = Path.GetFullPath(path.ToString());
                        record.CreationTimeUtcTicks = DateTime.FromFileTimeUtc(fileTime).Ticks;
                        record.IdentityAvailable = true;
                        result.Add(record);
                        continue;
                    }
                    uint finalExitCode;
                    if (GetExitCodeProcess(process, out finalExitCode) && finalExitCode == STILL_ACTIVE) {
                        result.Add(record);
                    }
                } finally {
                    CloseHandle(process);
                }
            } while (Process32Next(snapshot, ref entry));
            var finalError = Marshal.GetLastWin32Error();
            if (finalError != ERROR_NO_MORE_FILES) {
                throw new Win32Exception(finalError, "Unable to complete the process snapshot.");
            }
            return result.ToArray();
        } finally {
            CloseHandle(snapshot);
        }
    }

    public static bool TerminateVerifiedProcess(int processId, long expectedCreationTimeUtcTicks, string expectedPath) {
        const uint PROCESS_TERMINATE = 0x0001;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        var handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero) return false;
        try {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
                throw new InvalidOperationException("Unable to revalidate failed-sample process creation time.");
            }
            long fileTime = ((long)creation.High << 32) | creation.Low;
            // Win32_Process/CIM timestamps can differ from the kernel FILETIME
            // by sub-microsecond rounding. PID + exact image path + a one-ms
            // creation-time window still rejects PID reuse without false
            // cleanup failures.
            if (Math.Abs(DateTime.FromFileTimeUtc(fileTime).Ticks - expectedCreationTimeUtcTicks) > TimeSpan.TicksPerMillisecond) {
                throw new InvalidOperationException("Failed-sample process PID was reused before cleanup.");
            }
            var path = new StringBuilder(32768);
            var size = path.Capacity;
            if (!QueryFullProcessImageName(handle, 0, path, ref size) ||
                !String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)) {
                throw new InvalidOperationException("Failed-sample process path changed before cleanup.");
            }
            if (!TerminateProcess(handle, 1)) {
                throw new InvalidOperationException("Verified failed-sample process could not be terminated.");
            }
            return true;
        } finally {
            CloseHandle(handle);
        }
    }

    public static void RequirePerMonitorDpiAwareness() {
        const int perMonitorAware = 2;
        SetProcessDpiAwareness(perMonitorAware);
        int actual;
        if (GetProcessDpiAwareness(IntPtr.Zero, out actual) != 0 || actual != perMonitorAware) {
            throw new InvalidOperationException("PERF-09 controller must be per-monitor DPI aware.");
        }
    }

    public static Phase5Perf09WindowInfo[] GetVisibleWindows(int processId) {
        var result = new List<Phase5Perf09WindowInfo>();
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            RECT rectangle;
            if (!GetWindowRect(window, out rectangle)) return true;
            var width = rectangle.Right - rectangle.Left;
            var height = rectangle.Bottom - rectangle.Top;
            if (width <= 0 || height <= 0) return true;
            result.Add(new Phase5Perf09WindowInfo {
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

    public static bool PointTargetsWindow(int x, int y, IntPtr expectedRoot) {
        var point = new POINT { X = x, Y = y };
        var target = WindowFromPoint(point);
        return target != IntPtr.Zero && GetAncestor(target, 2) == expectedRoot;
    }

    public static bool SendVirtualKey(ushort virtualKey) {
        const uint INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_KEYUP = 0x0002;
        var inputs = new[] {
            new INPUT {
                Type = INPUT_KEYBOARD,
                Data = new INPUTUNION {
                    Keyboard = new KEYBDINPUT { VirtualKey = virtualKey }
                }
            },
            new INPUT {
                Type = INPUT_KEYBOARD,
                Data = new INPUTUNION {
                    Keyboard = new KEYBDINPUT { VirtualKey = virtualKey, Flags = KEYEVENTF_KEYUP }
                }
            }
        };
        LastSendInputCount = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        LastSendInputError = LastSendInputCount == (uint)inputs.Length ? 0 : Marshal.GetLastWin32Error();
        return LastSendInputCount == (uint)inputs.Length;
    }

    public static bool SendPrimaryClick() {
        const uint INPUT_MOUSE = 0;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        var inputs = new[] {
            new INPUT {
                Type = INPUT_MOUSE,
                Data = new INPUTUNION {
                    Mouse = new MOUSEINPUT { Flags = MOUSEEVENTF_LEFTDOWN }
                }
            },
            new INPUT {
                Type = INPUT_MOUSE,
                Data = new INPUTUNION {
                    Mouse = new MOUSEINPUT { Flags = MOUSEEVENTF_LEFTUP }
                }
            }
        };
        LastSendInputCount = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        LastSendInputError = LastSendInputCount == (uint)inputs.Length ? 0 : Marshal.GetLastWin32Error();
        return LastSendInputCount == (uint)inputs.Length;
    }

    public static int GetKeyboardInputSize() {
        return Marshal.SizeOf(typeof(INPUT));
    }

    public static bool ForegroundBelongsTo(int[] processIds) {
        var foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        uint owner;
        GetWindowThreadProcessId(foreground, out owner);
        foreach (var processId in processIds) {
            if (owner == (uint)processId) return true;
        }
        return false;
    }

    public static bool ForegroundIsWindow(IntPtr expectedWindow) {
        return expectedWindow != IntPtr.Zero && GetForegroundWindow() == expectedWindow;
    }

    public static Phase5Perf09MenuInfo[] GetVisiblePopupMenus(int[] processIds) {
        var owners = new HashSet<uint>();
        foreach (var processId in processIds) owners.Add((uint)processId);
        var result = new List<Phase5Perf09MenuInfo>();
        EnumWindows((window, parameter) => {
            if (!IsWindowVisible(window)) return true;
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (!owners.Contains(owner)) return true;
            var className = new StringBuilder(64);
            if (GetClassName(window, className, className.Capacity) <= 0 ||
                className.ToString() != "#32768") return true;
            var menu = SendMessage(window, 0x01E1, IntPtr.Zero, IntPtr.Zero);
            if (menu == IntPtr.Zero) return true;
            var itemCount = GetMenuItemCount(menu);
            if (itemCount <= 0) return true;
            var text = new StringBuilder(256);
            GetMenuString(menu, (uint)(itemCount - 1), text, text.Capacity, 0x00000400);
            var state = GetMenuState(menu, (uint)(itemCount - 1), 0x00000400);
            result.Add(new Phase5Perf09MenuInfo {
                Handle = window,
                ItemCount = itemCount,
                LastItemText = text.ToString(),
                LastItemEnabled = state != 0xFFFFFFFF && (state & 0x00000003) == 0,
                // MFS_HILITE proves END selected the exact exit item before ENTER.
                LastItemHighlighted = state != 0xFFFFFFFF && (state & 0x00000080) != 0
            });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static Phase5Perf09DisplayInfo[] GetDisplays() {
        var result = new List<Phase5Perf09DisplayInfo>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, hdc, rectangle, data) => {
            var info = new MONITORINFOEX();
            info.Size = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfo(monitor, ref info)) return false;
            int scalePercent;
            if (GetScaleFactorForMonitor(monitor, out scalePercent) != 0) return false;
            result.Add(new Phase5Perf09DisplayInfo {
                Width = info.Monitor.Right - info.Monitor.Left,
                Height = info.Monitor.Bottom - info.Monitor.Top,
                DpiPercent = scalePercent,
                Primary = (info.Flags & 1) == 1
            });
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("Unable to enumerate displays.");
        return result.ToArray();
    }

    public static bool IsOnAcPower() {
        SYSTEM_POWER_STATUS status;
        if (!GetSystemPowerStatus(out status) || status.ACLineStatus == 255) {
            throw new InvalidOperationException("AC power state is unavailable.");
        }
        return status.ACLineStatus == 1;
    }

    public static string GetPrimaryTaskbarEdge() {
        var data = new APPBARDATA();
        data.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA));
        if (SHAppBarMessage(5, ref data) == UIntPtr.Zero) {
            throw new InvalidOperationException("Primary taskbar position is unavailable.");
        }
        switch (data.uEdge) {
            case 0: return "left";
            case 1: return "top";
            case 2: return "right";
            case 3: return "bottom";
            default: throw new InvalidOperationException("Primary taskbar edge is invalid.");
        }
    }
}
'@
}

if ($StaticSelfTest) {
    if ($PSBoundParameters.Keys.Count -ne 1) {
        throw '-StaticSelfTest cannot be combined with run parameters.'
    }
    Invoke-StaticSelfTest
    $expectedInputSize = if ([IntPtr]::Size -eq 8) { 40 } else { 28 }
    Assert-Condition -Condition (
        [Phase5Perf09Native]::GetKeyboardInputSize() -eq $expectedInputSize
    ) -Message 'Native INPUT layout selftest failed.'
    if ([IntPtr]::Size -ne 8) {
        throw 'PERF-09 is frozen to the Windows x64 package and runner.'
    }
    $actualJobLayout = [int[]][Phase5Perf09JobRun]::GetNativeLayoutSizes()
    $expectedJobLayout = [int[]]@(104, 24, 64, 48, 144, 48)
    Assert-Condition -Condition (
        @(Compare-Object -ReferenceObject $expectedJobLayout -DifferenceObject $actualJobLayout).Count -eq 0
    ) -Message 'Native Job/process layout selftest failed.'
    Assert-Condition -Condition (
        [Phase5Perf09Native]::GetProcessEntryLayoutSize() -eq 568
    ) -Message 'Native PROCESSENTRY32 layout selftest failed.'
    Assert-Condition -Condition (
        $null -ne [Phase5Perf09JobRun].GetMethod('GetActiveProcessIds') -and
        [IDisposable].IsAssignableFrom([Phase5Perf09LaunchFailureException])
    ) -Message 'Failed-launch lease or dynamic Job PID observer selftest failed.'
    foreach ($broker in @([Phase5Perf09Native]::GetActiveConsoleBrokers())) {
        Assert-Condition -Condition (
            $broker.ProcessId -gt 0 -and $broker.ParentProcessId -ge 0
        ) -Message 'Native console broker enumeration emitted an invalid PID.'
        if ($broker.IdentityAvailable) {
            Assert-Condition -Condition (
                $broker.CreationTimeUtcTicks -gt 0 -and
                [IO.Path]::IsPathRooted([string]$broker.ExecutablePath)
            ) -Message 'Native console broker enumeration emitted an incomplete exact identity.'
        }
    }
    $selfSource = [IO.File]::ReadAllText($PSCommandPath)
    Assert-Condition -Condition (
        $selfSource.Contains('WaitForSingleObject(process, checked((uint)timeoutMilliseconds))') -and
        $selfSource.Contains('$KnownIdentities[$identityKey] = $true') -and
        ([regex]::Matches(
            $selfSource,
            'Update-BoundConsoleBrokerWatches\s+@brokerDiscoveryArguments'
        ).Count -ge 2)
    ) -Message 'Failed-launch wait or dynamic console-broker contract selftest failed.'
    Write-Host '[phase5:perf09:selftest] embedded Win32 INPUT/Job/process layouts, retained failed-launch cleanup, and dynamic console-broker observation PASS.'
    exit 0
}
[Phase5Perf09Native]::RequirePerMonitorDpiAwareness()

function Write-AtomicJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $flags = [Phase5Perf09Native]::MOVEFILE_REPLACE_EXISTING -bor [Phase5Perf09Native]::MOVEFILE_WRITE_THROUGH
            if (-not [Phase5Perf09Native]::MoveFileEx($temporary, $Path, $flags)) {
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

function Add-RawSample {
    param([Parameter(Mandatory = $true)]$Record)
    $line = ($Record | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
    [IO.File]::AppendAllText($rawPath, $line, (New-Object Text.UTF8Encoding($false)))
}

function Convert-CreationTimeUtc {
    param($Value)
    if ($null -eq $Value) { return $null }
    try {
        return ([DateTime]$Value).ToUniversalTime()
    } catch {
        return $null
    }
}

function Get-ProcessRecords {
    $records = [Collections.Generic.List[object]]::new()
    $query = 'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process'
    foreach ($process in @(Get-CimInstance -Query $query)) {
        $liveProcess = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
        if ($null -eq $liveProcess) { continue }
        try {
            # taskkill/TerminateProcess can leave an exited process object
            # observable while the controller still owns a handle. CIM alone
            # therefore is not sufficient proof that the process is active.
            if ($liveProcess.HasExited) { continue }
            $creationTimeUtc = try {
                $liveProcess.StartTime.ToUniversalTime()
            } catch {
                Convert-CreationTimeUtc -Value $process.CreationDate
            }
            $path = if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
                try { [IO.Path]::GetFullPath([string]$liveProcess.Path) } catch { $null }
            } else {
                try { [IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { $null }
            }
            if ($liveProcess.HasExited) { continue }
            $records.Add([pscustomobject]@{
                ProcessId = [int]$process.ProcessId
                ParentProcessId = [int]$process.ParentProcessId
                ExecutablePath = $path
                CommandLine = [string]$process.CommandLine
                CreationTimeUtc = $creationTimeUtc
            })
        } catch [InvalidOperationException] {
            # The process exited while the snapshot was being materialized.
            continue
        } finally {
            $liveProcess.Dispose()
        }
    }
    return @($records)
}

function Get-PackageCandidatePaths {
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @(
        $applicationExecutable,
        $hostExecutable,
        (Join-Path $PackageDirectory 'chrome_crashpad_handler.exe'),
        (Join-Path $PackageDirectory 'crashpad_handler.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $paths.Add([IO.Path]::GetFullPath($candidate)) | Out-Null
        }
    }
    return ,$paths
}

function Get-IdentityKey {
    param([Parameter(Mandatory = $true)]$Process)
    if ($null -eq $Process.CreationTimeUtc) { return $null }
    return "$($Process.ProcessId):$($Process.CreationTimeUtc.Ticks)"
}

function Test-AllowedRunExecutablePath {
    param(
        [AllowNull()][string]$Path,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return $CandidatePaths.Contains($Path) -or
        $Path.Equals($consoleHostExecutable, [StringComparison]::OrdinalIgnoreCase)
}

function Get-BoundRunProcesses {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][hashtable]$KnownIdentities,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths
    )
    $processes = @(Get-ProcessRecords)
    $rootProcess = $processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
    if ($null -ne $rootProcess) {
        if (
            $null -eq $rootProcess.ExecutablePath -or
            $null -eq $rootProcess.CreationTimeUtc -or
            -not $rootProcess.ExecutablePath.Equals($applicationExecutable, [StringComparison]::OrdinalIgnoreCase) -or
            [Math]::Abs(($rootProcess.CreationTimeUtc - $RootCreationTimeUtc).TotalSeconds) -gt 1 -or
            $rootProcess.CommandLine.IndexOf($UserDataDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0
        ) {
            throw 'Bound root process identity changed or became unavailable.'
        }
    }

    $descendantIds = [Collections.Generic.HashSet[int]]::new()
    if ($null -ne $rootProcess) {
        $descendantIds.Add($RootProcessId) | Out-Null
    }
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if (
                $descendantIds.Contains($candidate.ProcessId) -or
                -not $descendantIds.Contains($candidate.ParentProcessId)
            ) {
                continue
            }
            if (
                $null -eq $candidate.CreationTimeUtc -or
                $candidate.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)
            ) {
                continue
            }
            $descendantIds.Add($candidate.ProcessId) | Out-Null
            $added = $true
        }
    } while ($added)

    $active = [Collections.Generic.List[object]]::new()
    foreach ($candidate in $processes) {
        $key = Get-IdentityKey -Process $candidate
        $recent = $null -ne $candidate.CreationTimeUtc -and $candidate.CreationTimeUtc -ge $RootCreationTimeUtc.AddSeconds(-1)
        $isDescendant = $descendantIds.Contains($candidate.ProcessId)
        $directApplication = $recent -and
            $null -ne $candidate.ExecutablePath -and
            $candidate.ExecutablePath.Equals($applicationExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            $candidate.CommandLine.IndexOf($UserDataDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $directHost = $recent -and
            $null -ne $candidate.ExecutablePath -and
            $candidate.ExecutablePath.Equals($hostExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            $candidate.CommandLine -match "(?:^|\s)--parent-pid\s+$RootProcessId(?:\s|$)"
        $directCrashpad = $recent -and
            $null -ne $candidate.ExecutablePath -and
            $CandidatePaths.Contains($candidate.ExecutablePath) -and
            -not $candidate.ExecutablePath.Equals($applicationExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            -not $candidate.ExecutablePath.Equals($hostExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            $candidate.CommandLine.IndexOf($UserDataDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $recognizedDescendant = $false
        if ($isDescendant) {
            if ($null -eq $candidate.ExecutablePath -or $null -eq $candidate.CreationTimeUtc) {
                throw 'A root descendant identity became unavailable.'
            }
            # The exact root identity and ancestry already bind Electron child
            # processes to this run. Renderer/GPU command lines do not
            # necessarily repeat the root --user-data-dir argument, so require
            # the frozen package executable allowlist for descendants instead.
            # The stricter command-line predicates remain required below when
            # discovering a direct/orphaned application or Host process.
            $recognizedDescendant = Test-AllowedRunExecutablePath `
                -Path $candidate.ExecutablePath `
                -CandidatePaths $CandidatePaths
            if (-not $recognizedDescendant) {
                throw 'The product spawned a descendant outside the frozen executable identity allowlist.'
            }
        }
        $isKnown = $null -ne $key -and $KnownIdentities.ContainsKey($key)
        $isBound = ($isDescendant -and $recognizedDescendant) -or
            $directApplication -or $directHost -or $directCrashpad -or $isKnown
        if (-not $isBound) { continue }
        if ($null -eq $candidate.ExecutablePath -or $null -eq $candidate.CreationTimeUtc) {
            throw 'A bound process identity became unavailable.'
        }
        if (($isDescendant -and $recognizedDescendant) -or $directApplication -or $directHost -or $directCrashpad) {
            $KnownIdentities[$key] = $true
        }
        $active.Add($candidate)
    }
    return @($active)
}

function Test-BoundHostPresent {
    param([Parameter(Mandatory = $true)][object[]]$Processes)
    return @($Processes | Where-Object {
        $_.ExecutablePath.Equals($hostExecutable, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
}

function Get-BallWindow {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $candidates = @(
        [Phase5Perf09Native]::GetVisibleWindows($RootProcessId) |
            Where-Object {
                $_.Width -ge 16 -and
                $_.Height -ge 16
            }
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
        [Phase5Perf09Native]::GetVisibleWindows($RootProcessId) | Where-Object {
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

function New-BoundExitWatches {
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][int]$RootProcessId
    )
    $watches = [Collections.Generic.List[object]]::new()
    try {
        foreach ($identity in $Processes) {
            $identityKey = Get-IdentityKey -Process $identity
            if ([string]::IsNullOrWhiteSpace($identityKey)) {
                throw 'A bound process identity is incomplete before the exit watch is armed.'
            }
            $managed = Get-Process -Id ([int]$identity.ProcessId) -ErrorAction SilentlyContinue
            if ($null -eq $managed) { continue }
            try {
                if ($managed.HasExited) { continue }
                $actualCreationTimeUtc = $managed.StartTime.ToUniversalTime()
                $actualPath = [IO.Path]::GetFullPath([string]$managed.Path)
                if (
                    [Math]::Abs(($actualCreationTimeUtc - [DateTime]$identity.CreationTimeUtc).TotalMilliseconds) -gt 1 -or
                    -not $actualPath.Equals([string]$identity.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
                ) {
                    throw 'A bound process identity changed before the exit watch was armed.'
                }
                $watches.Add([pscustomobject]@{
                    Process = $managed
                    ProcessId = [int]$identity.ProcessId
                    IdentityKey = $identityKey
                    Role = if ([int]$identity.ProcessId -eq $RootProcessId) {
                        'root'
                    } elseif ($actualPath.Equals($hostExecutable, [StringComparison]::OrdinalIgnoreCase)) {
                        'host'
                    } elseif ($actualPath.Equals($consoleHostExecutable, [StringComparison]::OrdinalIgnoreCase)) {
                        'console-broker'
                    } elseif ([string]$identity.CommandLine -match '(?:^|\s)--type=([^\s]+)') {
                        'electron-' + $Matches[1]
                    } else {
                        'electron-child'
                    }
                    ExitObservedMs = $null
                })
                $managed = $null
            } finally {
                if ($null -ne $managed) { $managed.Dispose() }
            }
        }
        return @($watches)
    } catch {
        foreach ($watch in $watches) { $watch.Process.Dispose() }
        throw
    }
}

function Add-BoundExitWatches {
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[object]]$Watches,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.HashSet[string]]$WatchIdentityKeys
    )
    $unwatched = @($Processes | Where-Object {
        $key = Get-IdentityKey -Process $_
        -not [string]::IsNullOrWhiteSpace($key) -and -not $WatchIdentityKeys.Contains($key)
    })
    if ($unwatched.Count -eq 0) { return }
    $newWatches = @(New-BoundExitWatches -Processes $unwatched -RootProcessId $RootProcessId)
    foreach ($watch in $newWatches) {
        if ($WatchIdentityKeys.Add([string]$watch.IdentityKey)) {
            $Watches.Add($watch)
        } else {
            $watch.Process.Dispose()
        }
    }
}

function Update-BoundConsoleBrokerWatches {
    param(
        [Parameter(Mandatory = $true)][Phase5Perf09JobRun]$JobRun,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][hashtable]$KnownIdentities,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.HashSet[int]]$RunLineageProcessIds,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[object]]$Watches,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.HashSet[string]]$WatchIdentityKeys
    )
    # Capture every currently active Job PID before inspecting console brokers.
    # The lineage set is append-only, so a broker remains bindable even if its
    # exact parent exits before a later observation pass.
    foreach ($processId in [int[]]$JobRun.GetActiveProcessIds()) {
        $RunLineageProcessIds.Add($processId) | Out-Null
    }

    $newBrokerIdentities = [Collections.Generic.List[object]]::new()
    foreach ($broker in [Phase5Perf09Native]::GetActiveConsoleBrokers()) {
        if (-not $RunLineageProcessIds.Contains([int]$broker.ParentProcessId)) { continue }
        if (-not [bool]$broker.IdentityAvailable) {
            throw 'A same-run console broker identity could not be opened for exact observation.'
        }
        $creationTimeUtc = [DateTime]::new(
            [long]$broker.CreationTimeUtcTicks,
            [DateTimeKind]::Utc
        )
        if ($creationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)) { continue }
        $actualPath = [IO.Path]::GetFullPath([string]$broker.ExecutablePath)
        if (-not $actualPath.Equals($consoleHostExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A same-run console broker executable path left the frozen System32 identity.'
        }
        $identity = [pscustomobject]@{
            ProcessId = [int]$broker.ProcessId
            ParentProcessId = [int]$broker.ParentProcessId
            ExecutablePath = $actualPath
            CommandLine = ''
            CreationTimeUtc = $creationTimeUtc
        }
        $identityKey = Get-IdentityKey -Process $identity
        if ([string]::IsNullOrWhiteSpace($identityKey)) {
            throw 'A same-run console broker exact identity is incomplete.'
        }
        $KnownIdentities[$identityKey] = $true
        $RunLineageProcessIds.Add([int]$broker.ProcessId) | Out-Null
        if (-not $WatchIdentityKeys.Contains($identityKey)) {
            $newBrokerIdentities.Add($identity)
        }
    }
    if ($newBrokerIdentities.Count -gt 0) {
        Add-BoundExitWatches `
            -Processes @($newBrokerIdentities) `
            -RootProcessId $RootProcessId `
            -Watches $Watches `
            -WatchIdentityKeys $WatchIdentityKeys
    }
}

function Close-BoundExitWatches {
    param([object[]]$Watches)
    foreach ($watch in @($Watches)) {
        try { $watch.Process.Dispose() } catch {}
    }
}

function Get-ActiveBoundExitWatchCount {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[object]]$Watches,
        [Parameter(Mandatory = $true)][Diagnostics.Stopwatch]$Stopwatch
    )
    $active = 0
    foreach ($watch in $Watches) {
        $hasExited = $watch.Process.HasExited
        if ($hasExited) {
            if ($null -eq $watch.ExitObservedMs) {
                $watch.ExitObservedMs = $Stopwatch.Elapsed.TotalMilliseconds
            }
        } else {
            $active += 1
        }
    }
    return $active
}

function Invoke-ProductUiExitSample {
    param(
        [Parameter(Mandatory = $true)][Phase5Perf09JobRun]$JobRun,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][hashtable]$KnownIdentities,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths
    )
    $ballWindow = Get-BallWindow -RootProcessId $RootProcessId
    if ($null -eq $ballWindow) {
        return [pscustomobject]@{
            DurationMs = 0.0
            Status = 'FAIL'
            StableErrorCode = 'PRODUCT_UI_SURFACE_UNAVAILABLE'
        }
    }

    $originalCursor = New-Object Phase5Perf09Native+POINT
    $cursorCaptured = [Phase5Perf09Native]::GetCursorPos([ref]$originalCursor)
    $stopwatch = $null
    $exitWatches = [Collections.Generic.List[object]]::new()
    $watchIdentityKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $runLineageProcessIds = [Collections.Generic.HashSet[int]]::new()
    try {
        $boundArguments = @{
            RootProcessId = $RootProcessId
            RootCreationTimeUtc = $RootCreationTimeUtc
            UserDataDirectory = $UserDataDirectory
            KnownIdentities = $KnownIdentities
            CandidatePaths = $CandidatePaths
        }
        $activeBeforeCommand = @(Get-BoundRunProcesses @boundArguments)
        try {
            foreach ($boundProcess in $activeBeforeCommand) {
                if (
                    $CandidatePaths.Contains([string]$boundProcess.ExecutablePath) -and
                    -not $JobRun.ContainsProcess([int]$boundProcess.ProcessId)
                ) {
                    return [pscustomobject]@{
                        DurationMs = 0.0
                        Status = 'FAIL'
                        StableErrorCode = 'BOUND_PROCESS_ESCAPED_JOB'
                    }
                }
            }
        } catch {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'BOUND_JOB_MEMBERSHIP_CHECK_FAILED'
            }
        }
        try {
            foreach ($boundProcess in $activeBeforeCommand) {
                $runLineageProcessIds.Add([int]$boundProcess.ProcessId) | Out-Null
            }
            Add-BoundExitWatches `
                -Processes $activeBeforeCommand `
                -RootProcessId $RootProcessId `
                -Watches $exitWatches `
                -WatchIdentityKeys $watchIdentityKeys
        } catch {
            if ($DevelopmentSelfTest) {
                Write-Host "[phase5:perf09:dev] watch setup failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"
            }
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'BOUND_PROCESS_WATCH_SETUP_FAILED'
            }
        }
        $visibleBeforeClick = @([Phase5Perf09Native]::GetVisibleWindows($RootProcessId))
        $ballHandle = $ballWindow.Handle.ToInt64()
        $baselineBallMatches = @($visibleBeforeClick | Where-Object {
            $_.Handle.ToInt64() -eq $ballHandle
        })
        if ($baselineBallMatches.Count -ne 1) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_SURFACE_AMBIGUOUS'
            }
        }
        $preClickWindowHandles = [long[]]@(
            $visibleBeforeClick | ForEach-Object { $_.Handle.ToInt64() }
        )
        $centerX = [int]($ballWindow.Left + [Math]::Floor($ballWindow.Width / 2))
        $centerY = [int]($ballWindow.Top + [Math]::Floor($ballWindow.Height / 2))
        if (-not [Phase5Perf09Native]::SetCursorPos($centerX, $centerY)) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_POINTER_SETUP_FAILED'
            }
        }
        [Phase5Perf09Native]::SetForegroundWindow($ballWindow.Handle) | Out-Null
        Start-Sleep -Milliseconds 100
        if (-not [Phase5Perf09Native]::PointTargetsWindow($centerX, $centerY, $ballWindow.Handle)) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_BALL_OCCLUDED'
            }
        }
        [Phase5Perf09Native]::mouse_event(
            [Phase5Perf09Native]::MOUSEEVENTF_RIGHTDOWN,
            0,
            0,
            0,
            [UIntPtr]::Zero
        )
        [Phase5Perf09Native]::mouse_event(
            [Phase5Perf09Native]::MOUSEEVENTF_RIGHTUP,
            0,
            0,
            0,
            [UIntPtr]::Zero
        )
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
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_CONTEXT_MENU_UNOBSERVED'
            }
        }
        $verifiedProductForeground =
            [Phase5Perf09Native]::ForegroundIsWindow($contextMenuWindow.Handle) -or
            [Phase5Perf09Native]::ForegroundIsWindow($ballWindow.Handle)
        if (-not $verifiedProductForeground) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_FOREGROUND_UNAVAILABLE'
            }
        }
        # Chromium Views implements Electron's menu rather than a Win32 HMENU.
        # The product contract binds Exit as the final menu item. Target the
        # centre of that final row with a DPI-proportional inset, then prove the
        # point still resolves to the exact newly-created, same-PID popup.
        # A wrong click cannot create a PASS: root exit code 0 and an empty
        # bound process tree remain mandatory.
        $exitCommandX = [int]($contextMenuWindow.Left + [Math]::Floor($contextMenuWindow.Width / 2))
        # Chromium Views' popup HWND includes DPI-scaled outer margins and a
        # drop-shadow below the menu contents. The final row centre is 21.5%
        # of the outer height above its bottom edge (verified at 150% DPI); the
        # ratio scales with the native popup rather than assuming CSS pixels.
        $exitCommandInset = [int][Math]::Max(12, [Math]::Round($contextMenuWindow.Height * 0.215))
        $exitCommandY = [int]($contextMenuWindow.Top + $contextMenuWindow.Height - $exitCommandInset)
        if (-not [Phase5Perf09Native]::SetCursorPos($exitCommandX, $exitCommandY)) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_EXIT_POINTER_SETUP_FAILED'
            }
        }
        Start-Sleep -Milliseconds 50
        $visibleBeforeExitClick = @([Phase5Perf09Native]::GetVisibleWindows($RootProcessId))
        $sameMenuVisible = @($visibleBeforeExitClick | Where-Object {
            $_.Handle -eq $contextMenuWindow.Handle
        }).Count -eq 1
        if (
            -not $sameMenuVisible -or
            -not [Phase5Perf09Native]::PointTargetsWindow(
                $exitCommandX,
                $exitCommandY,
                $contextMenuWindow.Handle
            ) -or
            -not (
                [Phase5Perf09Native]::ForegroundIsWindow($contextMenuWindow.Handle) -or
                [Phase5Perf09Native]::ForegroundIsWindow($ballWindow.Handle)
            )
        ) {
            return [pscustomobject]@{
                DurationMs = 0.0
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_EXIT_MENU_TARGET_LOST'
            }
        }

        # The monotonic clock starts immediately before the primary click
        # dispatches the final enabled product menu command. Startup and menu
        # setup are excluded, and no termination API is used on the measured
        # path. A missing/wrong menu cannot create a false PASS because only
        # the real quit command can produce exit code 0 and empty the bound
        # tree. Kernel-backed Process handles provide a low-overhead end time;
        # the slower complete identity scan runs only after that clock stops.
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        try {
            $exitClickSent = try {
                [Phase5Perf09Native]::SendPrimaryClick()
            } catch {
                $false
            }
            if (-not $exitClickSent) {
                throw 'The verified product exit click could not be dispatched.'
            }
            $invokeReturnedMs = $stopwatch.Elapsed.TotalMilliseconds
        } catch {
            $stopwatch.Stop()
            return [pscustomobject]@{
                DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                Status = 'FAIL'
                StableErrorCode = 'PRODUCT_UI_EXIT_COMMAND_FAILED'
            }
        }

        $brokerDiscoveryArguments = @{
            JobRun = $JobRun
            RootProcessId = $RootProcessId
            RootCreationTimeUtc = $RootCreationTimeUtc
            KnownIdentities = $KnownIdentities
            RunLineageProcessIds = $runLineageProcessIds
            Watches = $exitWatches
            WatchIdentityKeys = $watchIdentityKeys
        }
        while ($true) {
            try {
                Update-BoundConsoleBrokerWatches @brokerDiscoveryArguments
            } catch {
                $stopwatch.Stop()
                return [pscustomobject]@{
                    DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                    Status = 'FAIL'
                    StableErrorCode = 'BOUND_CONSOLE_BROKER_DISCOVERY_FAILED'
                }
            }
            try {
                $activeWatchCount = Get-ActiveBoundExitWatchCount `
                    -Watches $exitWatches `
                    -Stopwatch $stopwatch
            } catch {
                $stopwatch.Stop()
                return [pscustomobject]@{
                    DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                    Status = 'FAIL'
                    StableErrorCode = 'BOUND_PROCESS_WATCH_FAILED'
                }
            }
            try {
                $activeJobProcessCount = $JobRun.GetActiveProcessCount()
            } catch {
                $stopwatch.Stop()
                return [pscustomobject]@{
                    DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                    Status = 'FAIL'
                    StableErrorCode = 'BOUND_JOB_INSPECTION_FAILED'
                }
            }
            # Job membership is inherited by every process created after the
            # suspended root is assigned and before it is resumed. Console
            # brokers are outside that Job, so discover them on every timed
            # observation pass and retain their exact kernel-backed watches.
            # Once the Job first reaches zero, run one final discovery pass:
            # no run-owned producer remains after that point, and any broker
            # already created is now bound even though its parent/root exited.
            if ($activeJobProcessCount -eq 0 -and $activeWatchCount -eq 0) {
                try {
                    Update-BoundConsoleBrokerWatches @brokerDiscoveryArguments
                    $activeWatchCount = Get-ActiveBoundExitWatchCount `
                        -Watches $exitWatches `
                        -Stopwatch $stopwatch
                    $activeJobProcessCount = $JobRun.GetActiveProcessCount()
                } catch {
                    $stopwatch.Stop()
                    return [pscustomobject]@{
                        DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                        Status = 'FAIL'
                        StableErrorCode = 'BOUND_FINAL_ZERO_VERIFICATION_FAILED'
                    }
                }
                if ($activeJobProcessCount -eq 0 -and $activeWatchCount -eq 0) { break }
            }
            if ($stopwatch.Elapsed.TotalMilliseconds -ge ($ExitTimeoutSeconds * 1000)) {
                $stopwatch.Stop()
                if ($DevelopmentSelfTest) {
                    $timeoutRoles = @($exitWatches | ForEach-Object {
                        if ($null -eq $_.ExitObservedMs) {
                            "$($_.Role)=ACTIVE"
                        } else {
                            "$($_.Role)=$([Math]::Round([double]$_.ExitObservedMs, 3))ms"
                        }
                    })
                    Write-Host "[phase5:perf09:dev] timeout roles: $($timeoutRoles -join '; ')"
                }
                return [pscustomobject]@{
                    DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                    Status = 'FAIL'
                    StableErrorCode = 'EXIT_TREE_TIMEOUT'
                }
            }
            Start-Sleep -Milliseconds 5
        }
        $stopwatch.Stop()
        if ($DevelopmentSelfTest) {
            $roleTimings = @($exitWatches | Group-Object Role | ForEach-Object {
                $maximum = ($_.Group | Measure-Object -Property ExitObservedMs -Maximum).Maximum
                "$($_.Name)=$([Math]::Round([double]$maximum, 3))ms"
            })
            Write-Host "[phase5:perf09:dev] invoke-return=$([Math]::Round($invokeReturnedMs, 3))ms; $($roleTimings -join '; ')"
        }
        try {
            $postExit = @(Get-BoundRunProcesses @boundArguments)
        } catch {
            return [pscustomobject]@{
                DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                Status = 'FAIL'
                StableErrorCode = 'BOUND_PROCESS_INSPECTION_FAILED'
            }
        }
        if ($postExit.Count -ne 0) {
            return [pscustomobject]@{
                DurationMs = $stopwatch.Elapsed.TotalMilliseconds
                Status = 'FAIL'
                StableErrorCode = 'BOUND_PROCESS_SET_CHANGED_DURING_EXIT'
            }
        }
        return [pscustomobject]@{
            DurationMs = $stopwatch.Elapsed.TotalMilliseconds
            Status = 'PASS'
            StableErrorCode = $null
        }
    } catch {
        if ($null -ne $stopwatch) { $stopwatch.Stop() }
        return [pscustomobject]@{
            DurationMs = if ($null -eq $stopwatch) { 0.0 } else { $stopwatch.Elapsed.TotalMilliseconds }
            Status = 'FAIL'
            StableErrorCode = if ($null -eq $stopwatch) {
                'PRODUCT_UI_SETUP_FAILED'
            } else {
                'PRODUCT_UI_EXIT_COMMAND_FAILED'
            }
        }
    } finally {
        Close-BoundExitWatches -Watches $exitWatches
        if ($cursorCaptured) {
            [Phase5Perf09Native]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null
        }
    }
}

function Get-ExactFailedSampleProcesses {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][hashtable]$KnownIdentities,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths
    )
    $processes = @(Get-ProcessRecords)
    $rootProcess = $processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
    if ($null -ne $rootProcess) {
        if (
            $null -eq $rootProcess.ExecutablePath -or
            $null -eq $rootProcess.CreationTimeUtc -or
            -not $rootProcess.ExecutablePath.Equals($applicationExecutable, [StringComparison]::OrdinalIgnoreCase) -or
            [Math]::Abs(($rootProcess.CreationTimeUtc - $RootCreationTimeUtc).TotalSeconds) -gt 1 -or
            $rootProcess.CommandLine.IndexOf($UserDataDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0
        ) {
            throw 'Failed-sample cleanup refused a changed root identity.'
        }
    }

    # Preserve the captured root PID even after the root exits. Windows keeps
    # the original ParentProcessId on surviving children, so the exact lineage
    # remains discoverable without trusting a reused Process object.
    $descendantIds = [Collections.Generic.HashSet[int]]::new()
    $descendantIds.Add($RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if (
                $descendantIds.Contains($candidate.ProcessId) -or
                -not $descendantIds.Contains($candidate.ParentProcessId) -or
                $null -eq $candidate.CreationTimeUtc -or
                $candidate.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)
            ) {
                continue
            }
            $descendantIds.Add($candidate.ProcessId) | Out-Null
            $added = $true
        }
    } while ($added)

    $active = [Collections.Generic.List[object]]::new()
    foreach ($candidate in $processes) {
        if ($null -eq $candidate.ExecutablePath -or $null -eq $candidate.CreationTimeUtc) { continue }
        # Forced cleanup is intentionally narrower than observation: only
        # package-owned executables may be terminated. The exact System32
        # console broker is observed during measurement and exits with Host.
        if (-not $CandidatePaths.Contains($candidate.ExecutablePath)) { continue }
        $key = Get-IdentityKey -Process $candidate
        $recent = $candidate.CreationTimeUtc -ge $RootCreationTimeUtc.AddSeconds(-1)
        $directApplication = $recent -and
            $candidate.ExecutablePath.Equals($applicationExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            $candidate.CommandLine.IndexOf($UserDataDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $directHost = $recent -and
            $candidate.ExecutablePath.Equals($hostExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            $candidate.CommandLine -match "(?:^|\s)--parent-pid(?:\s+|=)$RootProcessId(?:\s|$)"
        $isKnown = $null -ne $key -and $KnownIdentities.ContainsKey($key)
        if ($descendantIds.Contains($candidate.ProcessId) -or $directApplication -or $directHost -or $isKnown) {
            $active.Add($candidate)
        }
    }
    return @($active)
}

function Stop-ExactFailedSampleProcesses {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][hashtable]$KnownIdentities,
        [Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths
    )
    $cleanupArguments = @{
        RootProcessId = $RootProcessId
        RootCreationTimeUtc = $RootCreationTimeUtc
        UserDataDirectory = $UserDataDirectory
        KnownIdentities = $KnownIdentities
        CandidatePaths = $CandidatePaths
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $active = @(Get-ExactFailedSampleProcesses @cleanupArguments)
        foreach ($process in @($active | Sort-Object CreationTimeUtc -Descending)) {
            if (
                $null -eq $process.ExecutablePath -or
                -not $CandidatePaths.Contains([string]$process.ExecutablePath)
            ) {
                throw 'Failed-sample cleanup refused a process outside the frozen package executable set.'
            }
            [Phase5Perf09Native]::TerminateVerifiedProcess(
                [int]$process.ProcessId,
                ([DateTime]$process.CreationTimeUtc).ToUniversalTime().Ticks,
                [string]$process.ExecutablePath
            ) | Out-Null
        }
        if ($active.Count -gt 0) { Start-Sleep -Milliseconds 100 }
    } while ($active.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($active.Count -gt 0) {
        throw 'Exact failed-sample process cleanup did not reach zero.'
    }
}

function Remove-IsolatedRunRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        try {
            Remove-Phase5DirectoryTree -Path $Path -AllowedParent ([IO.Path]::GetTempPath())
            return
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Get-PackageRuntimeVersions {
    $sbomPath = Join-Path $PackageDirectory 'resources\supply-chain\sbom.cdx.json'
    if (-not (Test-Path -LiteralPath $sbomPath -PathType Leaf)) {
        throw 'The packaged CycloneDX SBOM is missing.'
    }
    $sbom = Get-Content -LiteralPath $sbomPath -Raw -Encoding utf8 | ConvertFrom-Json
    $electron = @($sbom.components | Where-Object {
        $_.name -eq 'Electron' -and $_.'bom-ref' -eq "pkg:generic/electron@$($_.version)"
    })
    $nodeRuntime = @($sbom.components | Where-Object {
        $_.name -eq 'Node.js' -and $_.'bom-ref' -eq "pkg:generic/node.js@$($_.version)"
    })
    if ($electron.Count -ne 1 -or $nodeRuntime.Count -ne 1) {
        throw 'The packaged SBOM does not contain one exact Electron and Node.js runtime identity.'
    }
    foreach ($version in @([string]$electron[0].version, [string]$nodeRuntime[0].version)) {
        if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
            throw 'A packaged runtime version is invalid.'
        }
    }
    return [pscustomobject]@{
        Electron = [string]$electron[0].version
        Node = [string]$nodeRuntime[0].version
        SbomPath = $sbomPath
        SbomSha256 = (Get-FileHash -LiteralPath $sbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-LiveDeviceFingerprintSha256 {
    $product = Get-CimInstance -ClassName Win32_ComputerSystemProduct
    $bios = Get-CimInstance -ClassName Win32_BIOS
    $baseboard = Get-CimInstance -ClassName Win32_BaseBoard
    $values = @(
        [string]$product.UUID,
        [string]$bios.SerialNumber,
        [string]$baseboard.Manufacturer,
        [string]$baseboard.Product,
        [string]$baseboard.SerialNumber
    ) | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and
        $_ -notmatch '^(?:0+|F+|NONE|DEFAULT|UNKNOWN|TO BE FILLED BY O\.E\.M\.)$'
    }
    if ($values.Count -lt 2) {
        throw 'The fixed-lab device does not expose enough stable firmware identity for registration.'
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($values -join "`n"))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function Assert-RegisteredDevice {
    param(
        [Parameter(Mandatory = $true)][string]$RegistrationId,
        [Parameter(Mandatory = $true)][string]$RegistryPath
    )
    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
        throw 'Formal PERF-09 device registry is missing.'
    }
    $repositoryPrefixForRegistry = $repositoryRoot.TrimEnd('\') + '\'
    if (-not $RegistryPath.StartsWith($repositoryPrefixForRegistry, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The device registry must be a Git-tracked file in this clean source tree.'
    }
    $relativeRegistry = $RegistryPath.Substring($repositoryPrefixForRegistry.Length).Replace('\', '/')
    & git -C $repositoryRoot ls-files --error-unmatch -- $relativeRegistry 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'The device registry is not tracked by the bound Git HEAD.'
    }
    $registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-ExactProperties -Value $registry -Expected @('schemaVersion', 'devices') -Label 'device registry root'
    if ($registry.schemaVersion -ne 'phase5-perf09-device-registry-v1') {
        throw 'Device registry schemaVersion is invalid.'
    }
    $devices = @($registry.devices)
    if ($devices.Count -eq 0) { throw 'Device registry is empty.' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($device in $devices) {
        Assert-ExactProperties -Value $device -Expected @(
            'deviceRegistrationId', 'status', 'deviceFingerprintSha256'
        ) -Label 'device registry entry'
        Assert-SafeMetadataText -Value ([string]$device.deviceRegistrationId) -Label 'device registry ID' -MaximumLength 128
        if (-not $ids.Add([string]$device.deviceRegistrationId)) {
            throw 'Device registry contains a duplicate registration ID.'
        }
        if ([string]$device.status -notin @('active', 'revoked')) {
            throw 'Device registry status is invalid.'
        }
        if ([string]$device.deviceFingerprintSha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Device registry fingerprint is invalid.'
        }
    }
    $matching = @($devices | Where-Object deviceRegistrationId -eq $RegistrationId)
    if ($matching.Count -ne 1 -or [string]$matching[0].status -ne 'active') {
        throw 'RunMetadata deviceRegistrationId is not one active trusted registration.'
    }
    if ([string]$matching[0].deviceFingerprintSha256 -ne (Get-LiveDeviceFingerprintSha256)) {
        throw 'The live fixed-lab device does not match its trusted registration fingerprint.'
    }
    return (Get-FileHash -LiteralPath $RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-LiveEnvironment {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $processors = @(Get-CimInstance -ClassName Win32_Processor)
    $videoControllers = @(Get-CimInstance -ClassName Win32_VideoController)
    $powerOutput = (& powercfg.exe /getactivescheme 2>&1 | Out-String)
    if (
        $LASTEXITCODE -ne 0 -or
        $powerOutput -notmatch '(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    ) {
        throw 'Active power-plan identity is unavailable.'
    }
    $powerPlanGuid = $Matches[1].ToLowerInvariant()
    $powerPlanLabel = if ($powerOutput -match '\(([^\r\n()]*)\)') {
        $Matches[1].Trim()
    } else {
        'localized-label-unavailable'
    }
    $displays = @(
        [Phase5Perf09Native]::GetDisplays() |
            Sort-Object @{ Expression = { -not $_.Primary } }, Width, Height, DpiPercent
    )
    if ($displays.Count -eq 0) { throw 'No active display was detected.' }
    $primaryTaskbarEdge = [Phase5Perf09Native]::GetPrimaryTaskbarEdge()

    $runtimeVersions = Get-PackageRuntimeVersions
    $hostVersion = [string](Get-Item -LiteralPath $hostExecutable).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($hostVersion)) {
        throw 'Native Host ProductVersion is unavailable.'
    }

    return [ordered]@{
        osBuild = [string]$operatingSystem.BuildNumber
        osArchitecture = [string]$operatingSystem.OSArchitecture
        cpuModels = [string[]]@(
            $processors | ForEach-Object { ([string]$_.Name).Trim() } | Sort-Object -Unique
        )
        physicalCoreCount = [int](($processors | Measure-Object -Property NumberOfCores -Sum).Sum)
        logicalProcessorCount = [int]((
            $processors | Measure-Object -Property NumberOfLogicalProcessors -Sum
        ).Sum)
        ramBytes = [int64]$computer.TotalPhysicalMemory
        gpuModels = [string[]]@(
            $videoControllers | ForEach-Object { ([string]$_.Name).Trim() } | Sort-Object -Unique
        )
        displays = @(
            $displays | ForEach-Object {
                [ordered]@{
                    widthPixels = [int]$_.Width
                    heightPixels = [int]$_.Height
                    dpiPercent = [int]$_.DpiPercent
                    primary = [bool]$_.Primary
                    inferredOrientation = if ($_.Width -ge $_.Height) {
                        'landscape'
                    } else {
                        'portrait'
                    }
                    taskbarEdge = if ($_.Primary) { $primaryTaskbarEdge } else { 'none' }
                }
            }
        )
        powerPlanGuid = $powerPlanGuid
        powerPlanLabel = $powerPlanLabel
        acPower = [Phase5Perf09Native]::IsOnAcPower()
        nodeVersion = $runtimeVersions.Node
        electronVersion = $runtimeVersions.Electron
        hostProductVersion = $hostVersion
    }
}

function Read-FormalRunMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$LiveEnvironment,
        [Parameter(Mandatory = $true)][string]$RegistryPath
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Formal PERF-09 RunMetadata file is missing.'
    }
    $metadata = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-ExactProperties -Value $metadata -Expected @(
        'schemaVersion', 'run', 'environment'
    ) -Label 'run metadata root'
    Assert-Condition -Condition (
        $metadata.schemaVersion -eq 'phase5-perf09-run-metadata-v1'
    ) -Message 'RunMetadata schemaVersion is invalid.'
    Assert-ExactProperties -Value $metadata.run -Expected @(
        'runId', 'workflowName', 'workflowRunId', 'operatorRole',
        'deviceRegistrationId', 'buildMode', 'evidenceLevel',
        'dedicatedInteractiveSession', 'foregroundInputExclusive',
        'debuggerClosed', 'unrelatedForegroundTasksClosed'
    ) -Label 'run metadata run'
    foreach ($field in @('runId', 'workflowRunId', 'deviceRegistrationId')) {
        $value = [string]$metadata.run.$field
        Assert-SafeMetadataText -Value $value -Label "run.$field" -MaximumLength 128
        Assert-Condition -Condition (
            $value -match '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'
        ) -Message "run.$field format is invalid."
    }
    Assert-Condition -Condition (
        $metadata.run.workflowName -eq 'phase5-perf09-exit'
    ) -Message 'RunMetadata workflowName is invalid.'
    Assert-Condition -Condition (
        $metadata.run.operatorRole -in @('Engineering', 'Quality', 'Release')
    ) -Message 'RunMetadata operatorRole is invalid.'
    Assert-Condition -Condition (
        $metadata.run.buildMode -eq 'signed-rc'
    ) -Message 'Formal PERF-09 buildMode must be signed-rc.'
    Assert-Condition -Condition (
        $metadata.run.evidenceLevel -eq 'fixed-lab-benchmark'
    ) -Message 'Formal PERF-09 evidenceLevel must be fixed-lab-benchmark.'
    foreach ($field in @(
        'dedicatedInteractiveSession',
        'foregroundInputExclusive',
        'debuggerClosed',
        'unrelatedForegroundTasksClosed'
    )) {
        Assert-JsonBoolean -Value $metadata.run.$field -Expected $true -Label "run.$field"
    }

    Assert-ExactProperties -Value $metadata.environment -Expected @(
        'osBuild', 'osArchitecture', 'cpuModels', 'physicalCoreCount',
        'logicalProcessorCount', 'ramBytes', 'storageType', 'gpuModels',
        'displays', 'powerPlanGuid', 'powerPlanLabel', 'acPower',
        'ocrLanguagePacks', 'nodeVersion', 'electronVersion',
        'hostProductVersion', 'antivirusScanActivityAbsent',
        'osUpdateActivityAbsent'
    ) -Label 'run metadata environment'
    foreach ($field in @(
        'osBuild', 'osArchitecture', 'storageType', 'powerPlanGuid',
        'powerPlanLabel', 'nodeVersion', 'electronVersion',
        'hostProductVersion'
    )) {
        Assert-SafeMetadataText -Value ([string]$metadata.environment.$field) -Label "environment.$field"
    }
    Assert-Condition -Condition (
        $metadata.environment.storageType -in @('SSD', 'NVMe SSD')
    ) -Message 'Formal storageType must identify SSD or NVMe SSD.'
    Assert-JsonBoolean -Value $metadata.environment.antivirusScanActivityAbsent -Expected $true -Label 'environment.antivirusScanActivityAbsent'
    Assert-JsonBoolean -Value $metadata.environment.osUpdateActivityAbsent -Expected $true -Label 'environment.osUpdateActivityAbsent'
    Assert-JsonBoolean -Value $metadata.environment.acPower -Expected $true -Label 'environment.acPower'

    foreach ($arrayField in @('cpuModels', 'gpuModels', 'ocrLanguagePacks')) {
        $values = @($metadata.environment.$arrayField)
        Assert-Condition -Condition ($values.Count -gt 0) -Message "environment.$arrayField must be non-empty."
        foreach ($value in $values) {
            Assert-SafeMetadataText -Value ([string]$value) -Label "environment.$arrayField entry"
        }
    }
    foreach ($languagePack in @($metadata.environment.ocrLanguagePacks)) {
        Assert-Condition -Condition (
            [string]$languagePack -match '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$'
        ) -Message 'An OCR language-pack identifier is invalid.'
    }

    $metadataDisplays = @($metadata.environment.displays)
    Assert-Condition -Condition ($metadataDisplays.Count -gt 0) -Message 'environment.displays must be non-empty.'
    foreach ($display in $metadataDisplays) {
        Assert-ExactProperties -Value $display -Expected @(
            'widthPixels', 'heightPixels', 'dpiPercent', 'primary',
            'physical', 'orientation', 'taskbarEdge'
        ) -Label 'run metadata display'
        Assert-Condition -Condition (
            [int]$display.widthPixels -gt 0 -and [int]$display.heightPixels -gt 0
        ) -Message 'Display dimensions are invalid.'
        Assert-Condition -Condition (
            [int]$display.dpiPercent -in @(100, 125, 150, 175, 200, 225, 250, 300, 350)
        ) -Message 'Display DPI is outside the registered matrix.'
        Assert-JsonBoolean -Value $display.physical -Expected $true -Label 'display.physical'
        if ($display.primary -isnot [bool]) {
            throw 'display.primary must be a JSON boolean.'
        }
        Assert-Condition -Condition (
            [string]$display.orientation -in @('landscape', 'portrait')
        ) -Message 'Display orientation is invalid.'
        Assert-Condition -Condition (
            [string]$display.taskbarEdge -in @('left', 'top', 'right', 'bottom', 'none')
        ) -Message 'Display taskbar edge is invalid.'
    }
    Assert-Condition -Condition (
        @($metadataDisplays | Where-Object { $_.primary -eq $true }).Count -eq 1
    ) -Message 'Exactly one metadata display must be primary.'

    foreach ($field in @(
        'osBuild', 'osArchitecture', 'physicalCoreCount',
        'logicalProcessorCount', 'ramBytes', 'powerPlanGuid', 'powerPlanLabel', 'acPower',
        'nodeVersion', 'electronVersion', 'hostProductVersion'
    )) {
        Assert-Condition -Condition (
            [string]$metadata.environment.$field -eq [string]$LiveEnvironment.$field
        ) -Message "RunMetadata environment.$field does not match the live device."
    }
    Assert-Condition -Condition (
        Test-StringArrayEqual -Left @($metadata.environment.cpuModels) -Right @($LiveEnvironment.cpuModels)
    ) -Message 'RunMetadata CPU models do not match the live device.'
    Assert-Condition -Condition (
        Test-StringArrayEqual -Left @($metadata.environment.gpuModels) -Right @($LiveEnvironment.gpuModels)
    ) -Message 'RunMetadata GPU models do not match the live device.'
    Assert-Condition -Condition (
        $metadataDisplays.Count -eq @($LiveEnvironment.displays).Count
    ) -Message 'RunMetadata display count does not match the live device.'
    for ($index = 0; $index -lt $metadataDisplays.Count; $index += 1) {
        $expectedDisplay = $metadataDisplays[$index]
        $liveDisplay = @($LiveEnvironment.displays)[$index]
        foreach ($field in @(
            'widthPixels', 'heightPixels', 'dpiPercent', 'primary', 'taskbarEdge'
        )) {
            Assert-Condition -Condition (
                [string]$expectedDisplay.$field -eq [string]$liveDisplay.$field
            ) -Message "RunMetadata display $index field $field does not match the live device."
        }
        Assert-Condition -Condition (
            [string]$expectedDisplay.orientation -eq [string]$liveDisplay.inferredOrientation
        ) -Message "RunMetadata display $index orientation does not match the live device."
    }
    Assert-RegisteredDevice -RegistrationId ([string]$metadata.run.deviceRegistrationId) -RegistryPath $RegistryPath | Out-Null
    return $metadata
}

function Read-PackageFileManifest {
    param(
        [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
        [Parameter(Mandatory = $true)]$EvidenceManifest
    )
    $relativePath = [string]$EvidenceManifest.package.fileManifest
    if (
        [string]::IsNullOrWhiteSpace($relativePath) -or
        [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains('\') -or
        $relativePath.Split('/') -contains '..'
    ) {
        throw 'Package file-manifest evidence path is unsafe.'
    }
    $manifestPath = Join-Path $EvidenceDirectory ($relativePath.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Package file-manifest evidence is missing.'
    }
    $records = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    foreach ($line in @(Get-Content -LiteralPath $manifestPath -Encoding utf8)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
            throw 'Package file-manifest contains a malformed record.'
        }
        $logicalPath = [string]$Matches[2]
        if (
            [IO.Path]::IsPathRooted($logicalPath) -or
            $logicalPath.Contains('\') -or
            $logicalPath.Split('/') -contains '..' -or
            $records.ContainsKey($logicalPath)
        ) {
            throw 'Package file-manifest contains an unsafe or duplicate path.'
        }
        $records.Add($logicalPath, [string]$Matches[1])
    }
    if ($records.Count -eq 0) { throw 'Package file-manifest is empty.' }
    return [pscustomobject]@{
        Records = $records
        Sha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        EvidenceFileName = [IO.Path]::GetFileName($manifestPath)
        InternalPath = $manifestPath
    }
}

function Assert-FullPackageFileSet {
    param([Parameter(Mandatory = $true)]$ExpectedFileManifest)
    $packageParent = Split-Path -Parent $PackageDirectory
    Assert-Phase5NoReparsePoint -Path $PackageDirectory -AllowedParent $packageParent
    $actualFiles = @(
        Get-ChildItem -LiteralPath $PackageDirectory -Recurse -File -Force |
            Sort-Object FullName
    )
    if ($actualFiles.Count -ne $ExpectedFileManifest.Records.Count) {
        throw 'The bound package file set no longer matches its exact manifest.'
    }
    $packagePrefix = $PackageDirectory + '\'
    foreach ($file in $actualFiles) {
        if (-not $file.FullName.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Package traversal escaped its bound directory.'
        }
        $relativePath = $file.FullName.Substring($packagePrefix.Length).Replace('\', '/')
        $expectedHash = $null
        if (-not $ExpectedFileManifest.Records.TryGetValue($relativePath, [ref]$expectedHash)) {
            throw 'The bound package contains a file outside its exact manifest.'
        }
        $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw 'A file in the bound package changed after packaging.'
        }
    }
    $currentManifestHash = (Get-FileHash -LiteralPath $ExpectedFileManifest.InternalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentManifestHash -ne $ExpectedFileManifest.Sha256) {
        throw 'The package file-manifest evidence changed during PERF-09.'
    }
}

function Invoke-GitHubAttestationVerification {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Bundle,
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$SignerWorkflow,
        [Parameter(Mandatory = $true)][string]$SourceRef,
        [Parameter(Mandatory = $true)][string]$SourceDigest
    )
    & gh attestation verify $Path `
        --repo $Repository `
        --bundle $Bundle `
        --custom-trusted-root $TrustedRoot `
        --signer-workflow $SignerWorkflow `
        --source-ref $SourceRef `
        --source-digest $SourceDigest | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'GitHub/Sigstore attestation verification failed for one formal PERF-09 input.'
    }
}

function Assert-FinalReleaseTrust {
    param(
        [Parameter(Mandatory = $true)][string]$FinalManifestPath,
        [Parameter(Mandatory = $true)][string]$CleanVerificationPath,
        [Parameter(Mandatory = $true)][string]$IndependentRootPath,
        [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
        [Parameter(Mandatory = $true)]$DraftManifest,
        [Parameter(Mandatory = $true)]$PackageFileManifest
    )
    $canonicalFinalManifest = Join-Path $EvidenceDirectory 'release\final-release-manifest.json'
    if (-not $FinalManifestPath.Equals($canonicalFinalManifest, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Formal PERF-09 requires the canonical release/final-release-manifest.json.'
    }
    foreach ($path in @($FinalManifestPath, $CleanVerificationPath, $IndependentRootPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Formal PERF-09 final release trust input is missing.'
        }
    }
    $evidencePrefix = $EvidenceDirectory.TrimEnd('\') + '\'
    if (
        $IndependentRootPath.StartsWith($evidencePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $CleanVerificationPath.StartsWith($evidencePrefix, [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw 'Independent trusted root and clean-download PASS must come from paths outside the build evidence tree.'
    }
    $artifactBundlePath = Join-Path $EvidenceDirectory 'security\github-artifacts-attestation.json'
    $manifestBundlePath = Join-Path $EvidenceDirectory 'security\github-manifest-attestation.json'
    $evidenceTrustedRootPath = Join-Path $EvidenceDirectory 'security\trusted_root.jsonl'
    foreach ($path in @($artifactBundlePath, $manifestBundlePath, $evidenceTrustedRootPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Formal PERF-09 attestation bundle or evidence trusted root is missing.'
        }
    }

    $ghVersionLine = (& gh --version | Select-Object -First 1)
    if (
        $LASTEXITCODE -ne 0 -or
        $ghVersionLine -notmatch '^gh version ([0-9]+\.[0-9]+\.[0-9]+)' -or
        [version]$Matches[1] -lt [version]'2.93.0'
    ) {
        throw 'Formal PERF-09 requires GitHub CLI 2.93.0 or newer for offline attestation verification.'
    }

    $finalManifest = Get-Content -LiteralPath $FinalManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    $expectedRepository = 'Chatblanccc/desktop-translate'
    $expectedSignerWorkflow = "$expectedRepository/.github/workflows/phase5-windows.yml"
    if (
        [int]$finalManifest.schemaVersion -ne 1 -or
        [string]$finalManifest.source.repository -ne $expectedRepository -or
        [string]$finalManifest.source.ref -notmatch '^refs/tags/phase5-rc-' -or
        [string]$finalManifest.source.gitSha -ne $gitSha -or
        [string]$finalManifest.source.sourceIdentity -ne "HEAD:$gitSha" -or
        $finalManifest.source.developmentDirty -isnot [bool] -or
        $finalManifest.source.developmentDirty -ne $false -or
        $null -ne $finalManifest.source.patchDigest -or
        [string]$finalManifest.independentTrustRoot.status -ne 'PASS' -or
        [string]$finalManifest.independentTrustRoot.repository -ne $expectedRepository -or
        [string]$finalManifest.independentTrustRoot.sourceRef -ne [string]$finalManifest.source.ref -or
        [string]$finalManifest.independentTrustRoot.sourceDigest -ne $gitSha -or
        [string]$finalManifest.independentTrustRoot.signerWorkflow -ne $expectedSignerWorkflow -or
        [string]$finalManifest.authenticode.expectedSubject -ne $subjects[0]
    ) {
        throw 'Final release manifest source or trusted build identity is invalid.'
    }

    $independentRootSha256 = (Get-FileHash -LiteralPath $IndependentRootPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $evidenceRootSha256 = (Get-FileHash -LiteralPath $evidenceTrustedRootPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $artifactBundleSha256 = (Get-FileHash -LiteralPath $artifactBundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $independentRootSha256 -ne $evidenceRootSha256 -or
        [string]$finalManifest.independentTrustRoot.trustedRootSha256 -ne $independentRootSha256 -or
        [string]$finalManifest.independentTrustRoot.artifactBundleSha256 -ne $artifactBundleSha256
    ) {
        throw 'Final release trusted-root or artifact-attestation bytes are not the independent exact set.'
    }

    $attestationArguments = @{
        TrustedRoot = $IndependentRootPath
        Repository = $expectedRepository
        SignerWorkflow = $expectedSignerWorkflow
        SourceRef = [string]$finalManifest.source.ref
        SourceDigest = $gitSha
    }
    Invoke-GitHubAttestationVerification -Path $FinalManifestPath -Bundle $manifestBundlePath @attestationArguments

    $finalManifestSha256 = (Get-FileHash -LiteralPath $FinalManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $packageSbomPath = Join-Path $PackageDirectory 'resources\supply-chain\sbom.cdx.json'
    $packageSbomSha256 = (Get-FileHash -LiteralPath $packageSbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        [string]$finalManifest.productVersion -ne [string]$DraftManifest.productVersion -or
        [string]$finalManifest.authenticode.status -ne 'PASS' -or
        [string]$finalManifest.packageSmoke.status -ne 'PASS' -or
        [string]$finalManifest.packageEvidence.status -ne 'PASS' -or
        [string]$finalManifest.supplyChain.status -ne 'PASS' -or
        [string]$finalManifest.packageEvidence.fileManifestSha256 -ne $PackageFileManifest.Sha256 -or
        [string]$finalManifest.supplyChain.draftEvidenceSha256 -ne $manifestSha256 -or
        [string]$finalManifest.supplyChain.sbomSha256 -ne $packageSbomSha256
    ) {
        throw 'Final release manifest does not bind the exact draft, package file manifest, and packaged SBOM.'
    }

    $expectedArtifacts = [ordered]@{
        application = [pscustomobject]@{
            path = 'package/desktop-translate.exe'; name = 'desktop-translate.exe'
            size = (Get-Item -LiteralPath $applicationExecutable).Length; sha256 = $applicationSha256
            actualPath = $applicationExecutable
        }
        nativeHost = [pscustomobject]@{
            path = 'package/resources/selection-host/selection-host.exe'; name = 'selection-host.exe'
            size = (Get-Item -LiteralPath $hostExecutable).Length; sha256 = $hostSha256
            actualPath = $hostExecutable
        }
        asar = [pscustomobject]@{
            path = 'package/resources/app.asar'; name = 'app.asar'
            size = (Get-Item -LiteralPath $appAsar).Length; sha256 = $appAsarSha256
            actualPath = $appAsar
        }
        installer = [pscustomobject]@{
            path = 'installer/' + [IO.Path]::GetFileName($installerPathResolved); name = [IO.Path]::GetFileName($installerPathResolved)
            size = (Get-Item -LiteralPath $installerPathResolved).Length; sha256 = $installerSha256
            actualPath = $installerPathResolved
        }
    }
    $manifestArtifacts = @($finalManifest.artifacts)
    if ($manifestArtifacts.Count -ne $expectedArtifacts.Count) {
        throw 'Final release manifest artifact set is not exact.'
    }
    foreach ($role in $expectedArtifacts.Keys) {
        $expected = $expectedArtifacts[$role]
        $actual = @($manifestArtifacts | Where-Object role -eq $role)
        if (
            $actual.Count -ne 1 -or
            [string]$actual[0].path -ne $expected.path -or
            [string]$actual[0].name -ne $expected.name -or
            [int64]$actual[0].size -ne [int64]$expected.size -or
            [string]$actual[0].sha256 -ne $expected.sha256
        ) {
            throw 'Final release manifest does not bind one exact application/Host/ASAR/installer set.'
        }
        Invoke-GitHubAttestationVerification -Path $expected.actualPath -Bundle $artifactBundlePath @attestationArguments
    }

    $cleanVerification = Get-Content -LiteralPath $CleanVerificationPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-ExactProperties -Value $cleanVerification -Expected @(
        'schemaVersion', 'status', 'releaseStatus', 'repository', 'sourceRef', 'sourceDigest',
        'signerWorkflow', 'finalManifestSha256', 'manifestAttestationSha256', 'trustedRootSha256',
        'independentlyAcquiredTrustedRootSha256', 'exactArtifacts', 'authenticodeSubject',
        'verifiedAt', 'verificationBoundary'
    ) -Label 'clean-download verification'
    $manifestBundleSha256 = (Get-FileHash -LiteralPath $manifestBundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        [int]$cleanVerification.schemaVersion -ne 1 -or
        [string]$cleanVerification.status -ne 'PASS' -or
        [string]$cleanVerification.releaseStatus -ne 'PASS' -or
        [string]$cleanVerification.repository -ne $expectedRepository -or
        [string]$cleanVerification.sourceRef -ne [string]$finalManifest.source.ref -or
        [string]$cleanVerification.sourceDigest -ne $gitSha -or
        [string]$cleanVerification.signerWorkflow -ne $expectedSignerWorkflow -or
        [string]$cleanVerification.finalManifestSha256 -ne $finalManifestSha256 -or
        [string]$cleanVerification.manifestAttestationSha256 -ne $manifestBundleSha256 -or
        [string]$cleanVerification.trustedRootSha256 -ne $independentRootSha256 -or
        [string]$cleanVerification.independentlyAcquiredTrustedRootSha256 -ne $independentRootSha256 -or
        [string]$cleanVerification.authenticodeSubject -ne $subjects[0]
    ) {
        throw 'Independent clean-download verification is incomplete or bound to another release.'
    }
    $cleanArtifacts = @($cleanVerification.exactArtifacts)
    if ($cleanArtifacts.Count -ne $expectedArtifacts.Count) {
        throw 'Clean-download verification artifact set is not exact.'
    }
    foreach ($role in $expectedArtifacts.Keys) {
        $expected = $expectedArtifacts[$role]
        $actual = @($cleanArtifacts | Where-Object role -eq $role)
        if (
            $actual.Count -ne 1 -or
            [string]$actual[0].path -ne $expected.path -or
            [string]$actual[0].name -ne $expected.name -or
            [int64]$actual[0].size -ne [int64]$expected.size -or
            [string]$actual[0].sha256 -ne $expected.sha256
        ) {
            throw 'Clean-download verification does not bind the exact benchmark artifact set.'
        }
    }
    return [pscustomobject]@{
        FinalManifest = $finalManifest
        FinalManifestSha256 = $finalManifestSha256
        CleanVerificationSha256 = (Get-FileHash -LiteralPath $CleanVerificationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        ArtifactBundleSha256 = $artifactBundleSha256
        ManifestBundleSha256 = $manifestBundleSha256
        IndependentRootSha256 = $independentRootSha256
        PackageSbomSha256 = $packageSbomSha256
        ArtifactBundlePath = $artifactBundlePath
        ManifestBundlePath = $manifestBundlePath
        EvidenceTrustedRootPath = $evidenceTrustedRootPath
    }
}

function Assert-ArtifactIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationSha256,
        [Parameter(Mandatory = $true)][string]$HostSha256,
        [Parameter(Mandatory = $true)][string]$AsarSha256,
        [Parameter()][AllowNull()][string]$ManifestSha256
    )
    $currentApplicationHash = (Get-FileHash -LiteralPath $applicationExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $currentHostHash = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $currentAsarHash = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $currentApplicationHash -ne $ApplicationSha256 -or
        $currentHostHash -ne $HostSha256 -or
        $currentAsarHash -ne $AsarSha256
    ) {
        throw 'The bound application, Host, or ASAR artifact changed during PERF-09.'
    }
    if ($requestedAcceptance) {
        $currentManifestHash = (Get-FileHash -LiteralPath $packageEvidenceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($currentManifestHash -ne $ManifestSha256) {
            throw 'The bound package evidence manifest changed during PERF-09.'
        }
    }
}

function New-ArtifactQuickIdentity {
    $paths = @($applicationExecutable, $hostExecutable, $appAsar)
    if ($requestedAcceptance) {
        $paths += @(
            $installerPathResolved,
            $packageEvidenceManifestPath,
            $finalReleaseManifestPath,
            $cleanDownloadVerificationPath,
            $independentTrustedRootPath
        )
    }
    return @($paths | ForEach-Object {
        $item = Get-Item -LiteralPath $_
        [pscustomobject]@{
            Path = $item.FullName
            Length = [int64]$item.Length
            LastWriteTimeUtcTicks = $item.LastWriteTimeUtc.Ticks
        }
    })
}

function Assert-ArtifactQuickIdentity {
    param([Parameter(Mandatory = $true)][object[]]$Expected)
    foreach ($record in $Expected) {
        $item = Get-Item -LiteralPath $record.Path
        if (
            [int64]$item.Length -ne [int64]$record.Length -or
            $item.LastWriteTimeUtc.Ticks -ne [int64]$record.LastWriteTimeUtcTicks
        ) {
            throw 'A benchmark artifact changed between round-boundary hashes and sample startup.'
        }
    }
}

function Assert-FullArtifactIdentity {
    $identityArguments = @{
        ApplicationSha256 = $applicationSha256
        HostSha256 = $hostSha256
        AsarSha256 = $appAsarSha256
        ManifestSha256 = $manifestSha256
    }
    Assert-ArtifactIdentity @identityArguments
    if ($requestedAcceptance) {
        $currentInstallerHash = (Get-FileHash -LiteralPath $installerPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($currentInstallerHash -ne $installerSha256) {
            throw 'The bound installer changed during PERF-09.'
        }
        Assert-FullPackageFileSet -ExpectedFileManifest $expectedPackageFileManifest
        $trustedInputs = @(
            [pscustomobject]@{ Path = $finalReleaseManifestPath; Sha256 = $finalReleaseTrust.FinalManifestSha256 },
            [pscustomobject]@{ Path = $cleanDownloadVerificationPath; Sha256 = $finalReleaseTrust.CleanVerificationSha256 },
            [pscustomobject]@{ Path = $independentTrustedRootPath; Sha256 = $finalReleaseTrust.IndependentRootSha256 },
            [pscustomobject]@{ Path = $finalReleaseTrust.ArtifactBundlePath; Sha256 = $finalReleaseTrust.ArtifactBundleSha256 },
            [pscustomobject]@{ Path = $finalReleaseTrust.ManifestBundlePath; Sha256 = $finalReleaseTrust.ManifestBundleSha256 },
            [pscustomobject]@{ Path = $finalReleaseTrust.EvidenceTrustedRootPath; Sha256 = $finalReleaseTrust.IndependentRootSha256 },
            [pscustomobject]@{ Path = (Join-Path $PackageDirectory 'resources\supply-chain\sbom.cdx.json'); Sha256 = $finalReleaseTrust.PackageSbomSha256 },
            [pscustomobject]@{ Path = $deviceRegistryPath; Sha256 = $deviceRegistrySha256 }
        )
        foreach ($input in $trustedInputs) {
            $currentHash = (Get-FileHash -LiteralPath $input.Path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($currentHash -ne $input.Sha256) {
                throw 'A final release trust, clean-download, SBOM, or device-registry input changed during PERF-09.'
            }
        }
    }
}

function Invoke-EvidencePrivacyScan {
    & node (Join-Path $PSScriptRoot 'phase5-evidence-privacy-scan.mjs') --root $OutputRoot --output $privacyPath --mode evidence
    if ($LASTEXITCODE -ne 0) {
        throw 'PERF-09 evidence privacy scan failed.'
    }
}

function Assert-SourceIdentityStillCurrent {
    $currentHead = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $currentHead -ne $gitSha) {
        throw 'Git HEAD changed during PERF-09.'
    }
    $currentStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($currentStatus -join [Environment]::NewLine)) {
        throw 'The clean source worktree changed during PERF-09.'
    }
}

function Assert-NoBoundPackageResidual {
    $residual = @(
        Get-ProcessRecords | Where-Object {
            $null -ne $_.ExecutablePath -and $candidatePaths.Contains($_.ExecutablePath)
        }
    )
    if ($residual.Count -ne 0) {
        throw 'A process from the bound package artifact remained at a round boundary.'
    }
}

function Assert-RunBoundary {
    Assert-NoBoundPackageResidual
    Assert-FullArtifactIdentity
    if ($requestedAcceptance) {
        Assert-SourceIdentityStillCurrent
        $currentMetadataHash = (Get-FileHash -LiteralPath $runMetadataPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($currentMetadataHash -ne $runMetadataSha256) {
            throw 'RunMetadata changed during PERF-09.'
        }
        $currentLiveEnvironment = Get-LiveEnvironment
        Read-FormalRunMetadata -Path $runMetadataPath -LiveEnvironment $currentLiveEnvironment -RegistryPath $deviceRegistryPath | Out-Null
    }
}

$gitSha = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[a-f0-9]{40}$') {
    throw 'Unable to bind PERF-09 to a full Git SHA.'
}
$gitStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the source worktree.' }
$worktreeDirty = -not [string]::IsNullOrWhiteSpace($gitStatus -join [Environment]::NewLine)
$repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'
if ($OutputRoot.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputRoot cannot be the repository root.'
}
if ($OutputRoot.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $relativeOutput = $OutputRoot.Substring($repositoryPrefix.Length).Replace('\', '/')
    & git -C $repositoryRoot check-ignore --quiet -- $relativeOutput
    if ($LASTEXITCODE -ne 0) {
        throw 'An in-repository OutputRoot must be covered by the committed Git ignore policy.'
    }
}

foreach ($requiredFile in @($applicationExecutable, $hostExecutable, $appAsar)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw 'A required packaged application/Host executable is missing.'
    }
}
$applicationSha256 = (Get-FileHash -LiteralPath $applicationExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$hostSha256 = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$appAsarSha256 = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSha256 = $null
$manifestSha256 = $null
$runMetadataSha256 = $null
$deviceRegistrySha256 = $null
$finalReleaseTrust = $null
$manifest = $null
$evidenceDirectory = $null
$expectedPackageFileManifest = $null

if ($requestedAcceptance) {
    if ($worktreeDirty) { throw 'Formal PERF-09 requires a clean Git worktree.' }
    if (
        $null -eq $packageEvidenceManifestPath -or
        -not (Test-Path -LiteralPath $packageEvidenceManifestPath -PathType Leaf)
    ) {
        throw 'Formal PERF-09 requires -PackageEvidenceManifest.'
    }
    if ($null -eq $runMetadataPath) {
        throw 'Formal PERF-09 requires -RunMetadata.'
    }
    if ($null -eq $deviceRegistryPath) {
        throw 'Formal PERF-09 requires -DeviceRegistry from the clean, Git-tracked fixed-lab registry.'
    }
    if (
        $null -eq $finalReleaseManifestPath -or
        $null -eq $cleanDownloadVerificationPath -or
        $null -eq $independentTrustedRootPath
    ) {
        throw 'Formal PERF-09 requires -FinalReleaseManifest, -CleanDownloadVerification, and -IndependentTrustedRoot.'
    }
    if ($null -eq $installerPathResolved -or -not (Test-Path -LiteralPath $installerPathResolved -PathType Leaf)) {
        throw 'Formal PERF-09 requires the exact signed -InstallerPath.'
    }
    if (
        -not [IO.Path]::GetFileName($packageEvidenceManifestPath).Equals(
            'evidence-manifest.json',
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [IO.Path]::GetFileName((Split-Path -Parent $packageEvidenceManifestPath)).Equals(
            'release',
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw 'PackageEvidenceManifest must be the canonical release/evidence-manifest.json.'
    }
    $evidenceDirectory = Split-Path -Parent (Split-Path -Parent $packageEvidenceManifestPath)
    $canonicalManifestPath = Join-Path $evidenceDirectory 'release\evidence-manifest.json'
    if (-not $canonicalManifestPath.Equals($packageEvidenceManifestPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'PackageEvidenceManifest canonical path binding failed.'
    }
    $evidenceVerifyArguments = @(
        (Join-Path $PSScriptRoot 'supply-chain\verify-phase5-evidence.mjs'),
        '--evidence-dir',
        $evidenceDirectory,
        '--package-dir',
        $PackageDirectory,
        '--release-mode',
        'signed',
        '--installer',
        $installerPathResolved
    )
    & node @evidenceVerifyArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Exact signed package evidence verification failed.'
    }
    $manifest = Get-Content -LiteralPath $packageEvidenceManifestPath -Raw -Encoding utf8 |
        ConvertFrom-Json
    Assert-JsonBoolean -Value $manifest.build.developmentDirty -Expected $false -Label 'manifest.build.developmentDirty'
    Assert-JsonBoolean -Value $manifest.build.acceptanceEligible -Expected $true -Label 'manifest.build.acceptanceEligible'
    if (
        [string]$manifest.gitSha -ne $gitSha -or
        [string]$manifest.build.sourceIdentity -ne "HEAD:$gitSha"
    ) {
        throw 'Package evidence is not bound to this clean, acceptance-eligible HEAD.'
    }
    if (
        [string]$manifest.package.status -ne 'PASS' -or
        [string]$manifest.package.startupSmokeStatus -ne 'PASS' -or
        [string]$manifest.supplyChain.status -ne 'PASS' -or
        [string]$manifest.signatures.status -ne 'PASS'
    ) {
        throw 'Package evidence is missing package, startup, supply-chain, or signed Authenticode PASS.'
    }

    $signedArtifacts = @($manifest.signatures.artifacts)
    $applicationEvidence = @($signedArtifacts | Where-Object role -eq 'application')
    $hostEvidence = @($signedArtifacts | Where-Object role -eq 'nativeHost')
    $installerEvidence = @($signedArtifacts | Where-Object role -eq 'installer')
    $installerSha256 = (Get-FileHash -LiteralPath $installerPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $signedArtifacts.Count -ne 3 -or
        $applicationEvidence.Count -ne 1 -or
        $hostEvidence.Count -ne 1 -or
        $installerEvidence.Count -ne 1 -or
        [string]$applicationEvidence[0].name -ne 'desktop-translate.exe' -or
        [string]$hostEvidence[0].name -ne 'selection-host.exe' -or
        [string]$applicationEvidence[0].sha256 -ne $applicationSha256 -or
        [string]$hostEvidence[0].sha256 -ne $hostSha256 -or
        [int64]$applicationEvidence[0].size -ne (Get-Item -LiteralPath $applicationExecutable).Length -or
        [int64]$hostEvidence[0].size -ne (Get-Item -LiteralPath $hostExecutable).Length -or
        [string]$installerEvidence[0].name -ne [IO.Path]::GetFileName($installerPathResolved) -or
        [int64]$installerEvidence[0].size -ne (Get-Item -LiteralPath $installerPathResolved).Length -or
        [string]$installerEvidence[0].sha256 -ne $installerSha256 -or
        [string]$manifest.supplyChain.nativeHostSha256 -ne $hostSha256
    ) {
        throw 'Package evidence does not contain the exact signed application, Host, and installer set.'
    }
    $subjects = @(
        $signedArtifacts |
            ForEach-Object { [string]$_.subject } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique
    )
    if ($subjects.Count -ne 1) {
        throw 'Signed package evidence does not bind one release identity across all project artifacts.'
    }
    $applicationSignature = Get-AuthenticodeSignature -LiteralPath $applicationExecutable
    $hostSignature = Get-AuthenticodeSignature -LiteralPath $hostExecutable
    $installerSignature = Get-AuthenticodeSignature -LiteralPath $installerPathResolved
    if (
        [string]$applicationSignature.Status -ne 'Valid' -or
        [string]$hostSignature.Status -ne 'Valid' -or
        [string]$installerSignature.Status -ne 'Valid' -or
        $null -eq $applicationSignature.SignerCertificate -or
        $null -eq $hostSignature.SignerCertificate -or
        $null -eq $installerSignature.SignerCertificate -or
        [string]$applicationSignature.SignerCertificate.Subject -ne $subjects[0] -or
        [string]$hostSignature.SignerCertificate.Subject -ne $subjects[0] -or
        [string]$installerSignature.SignerCertificate.Subject -ne $subjects[0]
    ) {
        throw 'Actual packaged application/Host Authenticode identity is not the manifest-bound signed identity.'
    }
    $manifestSha256 = (Get-FileHash -LiteralPath $packageEvidenceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $runMetadataSha256 = (Get-FileHash -LiteralPath $runMetadataPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedPackageFileManifest = Read-PackageFileManifest -EvidenceDirectory $evidenceDirectory -EvidenceManifest $manifest
    Assert-FullPackageFileSet -ExpectedFileManifest $expectedPackageFileManifest
    $finalTrustArguments = @{
        FinalManifestPath = $finalReleaseManifestPath
        CleanVerificationPath = $cleanDownloadVerificationPath
        IndependentRootPath = $independentTrustedRootPath
        EvidenceDirectory = $evidenceDirectory
        DraftManifest = $manifest
        PackageFileManifest = $expectedPackageFileManifest
    }
    $finalReleaseTrust = Assert-FinalReleaseTrust @finalTrustArguments
    $deviceRegistrySha256 = (Get-FileHash -LiteralPath $deviceRegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

$liveEnvironment = Get-LiveEnvironment
if ($requestedAcceptance) {
    $workspacePackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw -Encoding utf8 |
        ConvertFrom-Json
    $workspaceProductVersion = [string]$workspacePackage.version
    if (
        [string]$manifest.productVersion -ne $workspaceProductVersion -or
        [string]$liveEnvironment.hostProductVersion -ne $workspaceProductVersion
    ) {
        throw 'Package evidence, workspace, and Native Host product versions do not match.'
    }
}
$formalMetadata = if ($requestedAcceptance) {
    Read-FormalRunMetadata -Path $runMetadataPath -LiveEnvironment $liveEnvironment -RegistryPath $deviceRegistryPath
} else {
    $null
}
$artifactQuickIdentity = New-ArtifactQuickIdentity
$evidenceLevel = if ($requestedAcceptance) {
    'fixed-lab-benchmark'
} else {
    'development-selftest'
}
$buildMode = if ($requestedAcceptance) {
    'signed-rc'
} else {
    'packaged-development'
}

$runEvidence = if ($requestedAcceptance) {
    [ordered]@{
        runId = [string]$formalMetadata.run.runId
        workflowName = [string]$formalMetadata.run.workflowName
        workflowRunId = [string]$formalMetadata.run.workflowRunId
        operatorRole = [string]$formalMetadata.run.operatorRole
        deviceRegistrationId = [string]$formalMetadata.run.deviceRegistrationId
        runMetadataSha256 = $runMetadataSha256
        deviceRegistrySha256 = $deviceRegistrySha256
        dedicatedInteractiveSession = $true
        foregroundInputExclusive = $true
        debuggerClosed = $true
        unrelatedForegroundTasksClosed = $true
    }
} else {
    [ordered]@{
        runId = 'development-' + [guid]::NewGuid().ToString('N')
        workflowName = 'phase5-perf09-exit'
        workflowRunId = 'local-development'
        operatorRole = 'Engineering'
        deviceRegistrationId = 'unregistered-development-device'
        runMetadataSha256 = $null
        deviceRegistrySha256 = $null
        dedicatedInteractiveSession = $false
        foregroundInputExclusive = $false
        debuggerClosed = $false
        unrelatedForegroundTasksClosed = $false
    }
}

$environmentEvidence = if ($requestedAcceptance) {
    [ordered]@{
        osBuild = [string]$formalMetadata.environment.osBuild
        osArchitecture = [string]$formalMetadata.environment.osArchitecture
        cpuModels = [string[]]@($formalMetadata.environment.cpuModels)
        physicalCoreCount = [int]$formalMetadata.environment.physicalCoreCount
        logicalProcessorCount = [int]$formalMetadata.environment.logicalProcessorCount
        ramBytes = [int64]$formalMetadata.environment.ramBytes
        storageType = [string]$formalMetadata.environment.storageType
        gpuModels = [string[]]@($formalMetadata.environment.gpuModels)
        displays = @($formalMetadata.environment.displays)
        powerPlanGuid = [string]$formalMetadata.environment.powerPlanGuid
        powerPlanLabel = [string]$formalMetadata.environment.powerPlanLabel
        acPower = [bool]$formalMetadata.environment.acPower
        ocrLanguagePacks = [string[]]@($formalMetadata.environment.ocrLanguagePacks)
        nodeVersion = [string]$formalMetadata.environment.nodeVersion
        electronVersion = [string]$formalMetadata.environment.electronVersion
        hostProductVersion = [string]$formalMetadata.environment.hostProductVersion
        antivirusScanActivityAbsent = $true
        osUpdateActivityAbsent = $true
        liveEnvironmentMatched = $true
    }
} else {
    [ordered]@{
        osBuild = $liveEnvironment.osBuild
        osArchitecture = $liveEnvironment.osArchitecture
        cpuModels = $liveEnvironment.cpuModels
        physicalCoreCount = $liveEnvironment.physicalCoreCount
        logicalProcessorCount = $liveEnvironment.logicalProcessorCount
        ramBytes = $liveEnvironment.ramBytes
        gpuModels = $liveEnvironment.gpuModels
        displays = $liveEnvironment.displays
        powerPlanGuid = $liveEnvironment.powerPlanGuid
        powerPlanLabel = $liveEnvironment.powerPlanLabel
        acPower = $liveEnvironment.acPower
        nodeVersion = $liveEnvironment.nodeVersion
        electronVersion = $liveEnvironment.electronVersion
        hostProductVersion = $liveEnvironment.hostProductVersion
        liveEnvironmentMatched = $true
        formalMetadataComplete = $false
    }
}

[IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
[IO.File]::WriteAllText($rawPath, '', (New-Object Text.UTF8Encoding($false)))
$summary = [ordered]@{
    schemaVersion = 'phase5-perf09-summary-v1'
    phase = 5
    metricId = 'PERF-09'
    scenario = 'normal-product-ui-exit-to-bound-process-tree-empty'
    status = 'PENDING'
    acceptance = $false
    evidenceClass = if ($requestedAcceptance) {
        'FORMAL_ACCEPTANCE_CANDIDATE'
    } else {
        'DEVELOPMENT_SELFTEST_NOT_ACCEPTANCE'
    }
    evidenceLevel = $evidenceLevel
    buildMode = $buildMode
    statisticsMethod = 'nearest-rank'
    configuredRoundCount = $RoundCount
    configuredSamplesPerRound = $SamplesPerRound
    measurement = [ordered]@{
        start = 'dispatch-final-enabled-ball-context-menu-exit-command'
        end = 'job-active-process-zero-and-required-outside-job-brokers-empty'
        clock = 'controller-monotonic-stopwatch'
        processScope = 'unnamed-kill-on-close-job-plus-verified-console-broker'
        zeroAuthority = 'job-basic-accounting-query-and-kernel-process-handles'
        passPathTerminationApi = 'NONE'
        productShutdownBoundary = 'app-quit-complete-plus-post-quit-tail-trim'
    }
    thresholds = [ordered]@{
        p50Ms = 2000
        p95Ms = 5000
        maxMs = 10000
        failureCount = 0
    }
    gitSha = $gitSha
    worktreeDirty = $worktreeDirty
    artifact = [ordered]@{
        productVersion = if ($null -eq $manifest) {
            'development-package'
        } else {
            [string]$manifest.productVersion
        }
        applicationFileName = 'desktop-translate.exe'
        applicationSha256 = $applicationSha256
        hostFileName = 'selection-host.exe'
        hostSha256 = $hostSha256
        asarFileName = 'app.asar'
        asarSha256 = $appAsarSha256
        installerFileName = if ($requestedAcceptance) {
            [IO.Path]::GetFileName($installerPathResolved)
        } else {
            $null
        }
        installerSha256 = $installerSha256
        packageFileManifestSha256 = if ($requestedAcceptance) {
            $expectedPackageFileManifest.Sha256
        } else {
            $null
        }
        packageEvidenceManifestSha256 = $manifestSha256
        finalReleaseManifestSha256 = if ($requestedAcceptance) { $finalReleaseTrust.FinalManifestSha256 } else { $null }
        cleanDownloadVerificationSha256 = if ($requestedAcceptance) { $finalReleaseTrust.CleanVerificationSha256 } else { $null }
        artifactAttestationBundleSha256 = if ($requestedAcceptance) { $finalReleaseTrust.ArtifactBundleSha256 } else { $null }
        manifestAttestationBundleSha256 = if ($requestedAcceptance) { $finalReleaseTrust.ManifestBundleSha256 } else { $null }
        independentTrustedRootSha256 = if ($requestedAcceptance) { $finalReleaseTrust.IndependentRootSha256 } else { $null }
        packagedSbomSha256 = if ($requestedAcceptance) { $finalReleaseTrust.PackageSbomSha256 } else { $null }
        acceptanceEligibleManifestBound = $requestedAcceptance
        signedReleaseIdentityBound = $requestedAcceptance
        attestedFinalReleaseBound = $requestedAcceptance
        independentCleanDownloadBound = $requestedAcceptance
        absolutePathPersisted = $false
    }
    run = $runEvidence
    environment = $environmentEvidence
    rounds = @()
    totalFailureCount = 0
    forcedCleanupCount = 0
    gates = [ordered]@{
        sourceAndArtifactIdentity = if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_ONLY' }
        fixedRunMetadata = if ($requestedAcceptance) { 'PASS' } else { 'NOT_REQUIRED_DEVELOPMENT_SELFTEST' }
        preflightResidual = 'PENDING'
        threeIndependentRounds = 'PENDING'
        evidencePrivacy = 'PENDING'
    }
    stableFailureCodes = @()
    completedAt = $null
    limitations = [string[]]$(if ($requestedAcceptance) {
        @(
            'PERF-09 alone does not replace PERF-01-08, resource/soak lanes, clean-VM coverage, compatibility matrix, or role sign-off.'
        )
    } else {
        @(
            'Explicit reduced development samples; this run can never be Phase 5 acceptance evidence.'
        )
    })
}
Write-AtomicJson -Path $summaryPath -Value $summary

$candidatePaths = Get-PackageCandidatePaths
try {
    Assert-NoBoundPackageResidual
} catch {
    $summary.status = 'FAIL'
    $summary.stableFailureCodes = @('PREFLIGHT_PACKAGE_PROCESS_RESIDUAL')
    Write-AtomicJson -Path $summaryPath -Value $summary
    Invoke-EvidencePrivacyScan
    throw 'PERF-09 preflight found a process from the bound package artifact.'
}
$summary.gates.preflightResidual = 'PASS'
Write-AtomicJson -Path $summaryPath -Value $summary

$fatalFailure = $null
$activeSampleJob = $null
$activeFailedLaunch = $null
try {
    for ($round = 1; $round -le $RoundCount; $round += 1) {
        Assert-RunBoundary
        $roundStartedAt = [DateTimeOffset]::UtcNow
        $roundRunId = [guid]::NewGuid().ToString('N')
        $roundDurations = [Collections.Generic.List[double]]::new()
        $roundFailureCodes = [Collections.Generic.List[string]]::new()
        $roundForcedCleanupCount = 0

        for ($sample = 1; $sample -le $SamplesPerRound; $sample += 1) {
            $temporaryRoot = Join-Path (
                [IO.Path]::GetTempPath()
            ) ('desktop-translate-phase5-perf09-' + [guid]::NewGuid().ToString('N'))
            $nonAsciiSuffix = -join @(
                [char]0x9636,
                [char]0x6BB5,
                [char]0x4E94,
                '-',
                [char]0x9000,
                [char]0x51FA
            )
            $userData = Join-Path $temporaryRoot ('User Data ' + $nonAsciiSuffix)
            $process = $null
            $jobRun = $null
            $failedLaunch = $null
            $rootProcessId = 0
            $rootCreationTimeUtc = $null
            $knownIdentities = @{}
            $sampleResult = $null
            $sampleFailureCode = 'UNHANDLED_SAMPLE_FAILURE'
            try {
                $sampleFailureCode = 'ARTIFACT_IDENTITY_CHANGED'
                Assert-ArtifactQuickIdentity -Expected $artifactQuickIdentity
                [IO.Directory]::CreateDirectory($userData) | Out-Null
                $sampleFailureCode = 'PRODUCT_STARTUP_FAILED'
                # Create the root suspended, bind it to a kill-on-close Job,
                # then resume it. This removes the Start-Process -> Assign race
                # and makes every later descendant part of the dynamic set.
                $jobRun = [Phase5Perf09JobRun]::Launch(
                    $applicationExecutable,
                    $userData,
                    $temporaryRoot
                )
                $activeSampleJob = $jobRun
                $rootProcessId = $jobRun.ProcessId
                $rootCreationTimeUtc = [DateTime]::new(
                    $jobRun.CreationTimeUtcTicks,
                    [DateTimeKind]::Utc
                )
                $process = Get-Process -Id $rootProcessId -ErrorAction Stop
                $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
                $ready = $false
                $boundArguments = @{
                    RootProcessId = $rootProcessId
                    RootCreationTimeUtc = $rootCreationTimeUtc
                    UserDataDirectory = $userData
                    KnownIdentities = $knownIdentities
                    CandidatePaths = $candidatePaths
                }
                do {
                    $process.Refresh()
                    if ($process.HasExited) { break }
                    $bound = @(Get-BoundRunProcesses @boundArguments)
                    $ready = (Test-BoundHostPresent -Processes $bound) -and
                        $null -ne (Get-BallWindow -RootProcessId $rootProcessId)
                    if (-not $ready) { Start-Sleep -Milliseconds 250 }
                } while (-not $ready -and [DateTime]::UtcNow -lt $startupDeadline)
                if (-not $ready) {
                    throw 'Bound product startup did not reach Host+Ball readiness.'
                }

                $sampleFailureCode = 'PRODUCT_UI_EXIT_FAILED'
                $exitArguments = @{
                    JobRun = $jobRun
                    RootProcessId = $rootProcessId
                    RootCreationTimeUtc = $rootCreationTimeUtc
                    UserDataDirectory = $userData
                    KnownIdentities = $knownIdentities
                    CandidatePaths = $candidatePaths
                }
                $sampleResult = Invoke-ProductUiExitSample @exitArguments
                if ($sampleResult.Status -eq 'PASS') {
                    $sampleFailureCode = 'ROOT_EXIT_STATUS_UNAVAILABLE'
                    if ($jobRun.GetActiveProcessCount() -ne 0 -or $jobRun.GetRootExitCode() -ne 0) {
                        $sampleResult = [pscustomobject]@{
                            DurationMs = $sampleResult.DurationMs
                            Status = 'FAIL'
                            StableErrorCode = 'ROOT_EXIT_CODE_NONZERO'
                        }
                    }
                }
            } catch {
                $exceptionCursor = $_.Exception
                while ($null -ne $exceptionCursor) {
                    if ($exceptionCursor -is [Phase5Perf09LaunchFailureException]) {
                        $failedLaunch = $exceptionCursor
                        $activeFailedLaunch = $failedLaunch
                        if (
                            $failedLaunch.ProcessId -gt 0 -and
                            $failedLaunch.CreationTimeUtcTicks -gt 0 -and
                            ([IO.Path]::GetFullPath([string]$failedLaunch.ExecutablePath)).Equals(
                                $applicationExecutable,
                                [StringComparison]::OrdinalIgnoreCase
                            )
                        ) {
                            $rootProcessId = [int]$failedLaunch.ProcessId
                            $rootCreationTimeUtc = [DateTime]::new(
                                [long]$failedLaunch.CreationTimeUtcTicks,
                                [DateTimeKind]::Utc
                            )
                        }
                        break
                    }
                    $exceptionCursor = $exceptionCursor.InnerException
                }
                if ($null -eq $sampleResult) {
                    $sampleResult = [pscustomobject]@{
                        DurationMs = 0.0
                        Status = 'FAIL'
                        StableErrorCode = $sampleFailureCode
                    }
                } elseif ($sampleResult.Status -eq 'PASS') {
                    $sampleResult = [pscustomobject]@{
                        DurationMs = $sampleResult.DurationMs
                        Status = 'FAIL'
                        StableErrorCode = $sampleFailureCode
                    }
                }
            }

            # Persist FAIL before any forced cleanup. Cleanup success can never
            # promote the measured sample back to PASS. If evidence I/O itself
            # fails, exact cleanup still runs and the overall run fails.
            $sampleEvidenceFailed = $false
            try {
                $recordArguments = @{
                    Round = $round
                    Sample = $sample
                    DurationMs = $sampleResult.DurationMs
                    Status = $sampleResult.Status
                    StableErrorCode = $sampleResult.StableErrorCode
                    EvidenceLevel = $evidenceLevel
                    BuildMode = $buildMode
                }
                $sampleRecord = New-SampleRecord @recordArguments
                Add-RawSample -Record $sampleRecord
            } catch {
                $sampleEvidenceFailed = $true
            }
            $sampleCleanupFailed = $false
            try {
                if ($sampleResult.Status -eq 'PASS') {
                    $roundDurations.Add([double]$sampleResult.DurationMs)
                } else {
                    $roundFailureCodes.Add([string]$sampleResult.StableErrorCode)
                    $summary.totalFailureCount = [int]$summary.totalFailureCount + 1
                    if (
                        $null -ne $failedLaunch -or
                        $null -ne $jobRun -or
                        ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc)
                    ) {
                        $roundForcedCleanupCount += 1
                        $summary.forcedCleanupCount = [int]$summary.forcedCleanupCount + 1
                    }
                    if ($null -ne $failedLaunch) {
                        try {
                            $failedLaunch.TerminateAndWait(15000)
                        } catch {
                            $sampleCleanupFailed = $true
                        }
                    }
                    if ($null -ne $jobRun) {
                        try {
                            $jobRun.TerminateAndWait(5000)
                        } catch {
                            $sampleCleanupFailed = $true
                        }
                    }
                    if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
                        $cleanupArguments = @{
                            RootProcessId = $rootProcessId
                            RootCreationTimeUtc = $rootCreationTimeUtc
                            UserDataDirectory = $userData
                            KnownIdentities = $knownIdentities
                            CandidatePaths = $candidatePaths
                        }
                        try {
                            Stop-ExactFailedSampleProcesses @cleanupArguments
                        } catch {
                            $sampleCleanupFailed = $true
                        }
                    }
                }
            } catch {
                $sampleCleanupFailed = $true
            } finally {
                if ($null -ne $jobRun) {
                    try {
                        if ($jobRun.GetActiveProcessCount() -ne 0) {
                            $jobRun.TerminateAndWait(5000)
                            $sampleCleanupFailed = $true
                        }
                    } catch {
                        $sampleCleanupFailed = $true
                    } finally {
                        try { $jobRun.Dispose() } catch { $sampleCleanupFailed = $true }
                    }
                }
                $activeSampleJob = $null
                if ($null -ne $failedLaunch) {
                    try {
                        $failedLaunch.Dispose()
                    } catch {
                        $sampleCleanupFailed = $true
                    }
                }
                $activeFailedLaunch = $null
                if ($null -ne $process) {
                    try {
                        $process.Dispose()
                    } catch {
                        $sampleCleanupFailed = $true
                    }
                }
                try {
                    Remove-IsolatedRunRoot -Path $temporaryRoot
                } catch {
                    $sampleCleanupFailed = $true
                }
            }
            Write-AtomicJson -Path $summaryPath -Value $summary
            if ($sampleEvidenceFailed -or $sampleCleanupFailed) {
                throw 'A sample evidence write or exact cleanup failed.'
            }
        }

        $roundP50Raw = if ($roundDurations.Count -eq 0) {
            $null
        } else {
            Get-NearestRank -Values @($roundDurations) -Percentile 0.50
        }
        $roundP95Raw = if ($roundDurations.Count -eq 0) {
            $null
        } else {
            Get-NearestRank -Values @($roundDurations) -Percentile 0.95
        }
        $roundMaxRaw = if ($roundDurations.Count -eq 0) {
            $null
        } else {
            [double](($roundDurations | Measure-Object -Maximum).Maximum)
        }
        $roundSummary = [ordered]@{
            round = $round
            roundRunId = $roundRunId
            startedAt = $roundStartedAt.ToString('o')
            completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            configuredSampleCount = $SamplesPerRound
            successCount = $roundDurations.Count
            failureCount = $roundFailureCodes.Count
            p50Ms = if ($roundDurations.Count -eq 0) {
                $null
            } else {
                [Math]::Round([double]$roundP50Raw, 3)
            }
            p95Ms = if ($roundDurations.Count -eq 0) {
                $null
            } else {
                [Math]::Round([double]$roundP95Raw, 3)
            }
            maxMs = if ($roundDurations.Count -eq 0) {
                $null
            } else {
                [Math]::Round([double]$roundMaxRaw, 3)
            }
            forcedCleanupCount = $roundForcedCleanupCount
            status = 'FAIL'
            stableFailureCodes = [string[]]@($roundFailureCodes | Sort-Object -Unique)
        }
        $thresholdRound = [pscustomobject]@{
            failureCount = $roundFailureCodes.Count
            successCount = $roundDurations.Count
            p50Ms = $roundP50Raw
            p95Ms = $roundP95Raw
            maxMs = $roundMaxRaw
        }
        if (Test-Perf09RoundPass -RoundSummary $thresholdRound -ExpectedSampleCount $SamplesPerRound) {
            $roundSummary.status = 'PASS'
        } elseif ($roundSummary.failureCount -eq 0) {
            $roundSummary.stableFailureCodes = @('PERF09_THRESHOLD_EXCEEDED')
        }
        $summary.rounds = @($summary.rounds) + @($roundSummary)
        Assert-RunBoundary
        Write-AtomicJson -Path $summaryPath -Value $summary
    }
    Assert-RunBoundary
} catch {
    $fatalFailure = 'PERF09_RUN_ABORTED'
} finally {
    if ($null -ne $activeSampleJob) {
        try {
            $activeSampleJob.TerminateAndWait(15000)
        } catch {
            $fatalFailure = 'PERF09_RUN_ABORTED_CLEANUP_FAILED'
        } finally {
            try { $activeSampleJob.Dispose() } catch {
                $fatalFailure = 'PERF09_RUN_ABORTED_CLEANUP_FAILED'
            }
            $activeSampleJob = $null
        }
    }
    if ($null -ne $activeFailedLaunch) {
        try {
            $activeFailedLaunch.TerminateAndWait(15000)
        } catch {
            $fatalFailure = 'PERF09_RUN_ABORTED_CLEANUP_FAILED'
        } finally {
            try { $activeFailedLaunch.Dispose() } catch {
                $fatalFailure = 'PERF09_RUN_ABORTED_CLEANUP_FAILED'
            }
            $activeFailedLaunch = $null
        }
    }
}

$allRoundPass = $null -eq $fatalFailure -and
    $summary.rounds.Count -eq $RoundCount -and
    @($summary.rounds | Where-Object status -ne 'PASS').Count -eq 0
$summary.gates.threeIndependentRounds = if ($allRoundPass) {
    if ($requestedAcceptance) {
        'PASS'
    } else {
        'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE'
    }
} else {
    'FAIL'
}
$stableFailures = [Collections.Generic.List[string]]::new()
foreach ($roundSummary in @($summary.rounds)) {
    foreach ($code in @($roundSummary.stableFailureCodes)) {
        if (-not [string]::IsNullOrWhiteSpace($code)) {
            $stableFailures.Add($code)
        }
    }
}
if ($null -ne $fatalFailure) { $stableFailures.Add($fatalFailure) }
$summary.stableFailureCodes = [string[]]@($stableFailures | Sort-Object -Unique)
$candidateStatus = if ($allRoundPass) {
    if ($requestedAcceptance) {
        'PASS'
    } else {
        'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE'
    }
} else {
    'FAIL'
}
$candidateAcceptance = $requestedAcceptance -and $allRoundPass
# Never publish an acceptance-looking summary before the privacy artifact has
# been generated and the summary containing that PASS gate has itself been
# rescanned. The last atomic write is the only transition out of FINALIZING.
$summary.status = 'FINALIZING'
$summary.acceptance = $false
$summary.completedAt = $null
Write-AtomicJson -Path $summaryPath -Value $summary

try {
    Invoke-EvidencePrivacyScan
    $summary.gates.evidencePrivacy = 'PASS'
    Write-AtomicJson -Path $summaryPath -Value $summary
    Invoke-EvidencePrivacyScan
    $summary.status = $candidateStatus
    $summary.acceptance = $candidateAcceptance
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
} catch {
    $summary.gates.evidencePrivacy = 'FAIL'
    $summary.status = 'FAIL'
    $summary.acceptance = $false
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $summary.stableFailureCodes = [string[]]@(
        $summary.stableFailureCodes + @('EVIDENCE_PRIVACY_FAILED') |
            Sort-Object -Unique
    )
}
Write-AtomicJson -Path $summaryPath -Value $summary

if ($summary.status -eq 'FAIL') {
    throw 'PERF-09 failed; inspect the stable, redacted evidence codes.'
}
Write-Host "[phase5:perf09] $($summary.status): $RoundCount round(s), $SamplesPerRound sample(s) per round."

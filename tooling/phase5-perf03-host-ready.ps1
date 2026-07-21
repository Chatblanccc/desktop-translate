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
    [Parameter()][ValidateRange(1, 100)][int]$SamplesPerRound = 100,
    [Parameter()][ValidateRange(5, 180)][int]$StartupTimeoutSeconds = 60,
    [Parameter()][ValidateRange(5, 60)][int]$ExitTimeoutSeconds = 15,
    [Parameter()][switch]$DevelopmentSelfTest,
    [Parameter()][switch]$StaticSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:FormalRoundCount = 3
$script:FormalSamplesPerRound = 100
$script:P50ThresholdMs = 700.0
$script:P95ThresholdMs = 1500.0
$script:ForbiddenEvidenceKeys = @(
    'pid', 'hwnd', 'path', 'absolutePath', 'windowTitle', 'sourceText',
    'translatedText', 'selectedText', 'screenshot', 'pipeName', 'nonce',
    'secret', 'token', 'requestBody', 'responseBody', 'rawException'
)

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
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

function Assert-JsonString {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Value -isnot [string]) { throw "$Label must be a JSON string." }
}

function Assert-JsonPositiveInteger {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (
        $Value -isnot [byte] -and $Value -isnot [sbyte] -and
        $Value -isnot [int16] -and $Value -isnot [uint16] -and
        $Value -isnot [int32] -and $Value -isnot [uint32] -and
        $Value -isnot [int64] -and $Value -isnot [uint64]
    ) { throw "$Label must be a JSON integer." }
    if ([decimal]$Value -le 0) { throw "$Label must be positive." }
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
        [Parameter(Mandatory = $true)][bool]$Development,
        [Parameter(Mandatory = $true)][int]$Rounds,
        [Parameter(Mandatory = $true)][int]$Samples,
        [Parameter(Mandatory = $true)][bool]$RoundWasExplicit,
        [Parameter(Mandatory = $true)][bool]$SamplesWereExplicit
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
    if ($Rounds -ne $script:FormalRoundCount -or $Samples -ne $script:FormalSamplesPerRound) {
        throw 'Formal PERF-03 is frozen at 3 independent rounds with 100 samples per round.'
    }
}

function New-SampleRecord {
    param(
        [Parameter(Mandatory = $true)][int]$Round,
        [Parameter(Mandatory = $true)][int]$Sample,
        [Parameter(Mandatory = $true)][double]$DurationMs,
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter()][AllowNull()][string]$StableErrorCode,
        [Parameter(Mandatory = $true)][string]$EvidenceLevel,
        [Parameter(Mandatory = $true)][string]$BuildMode
    )
    return [ordered]@{
        schemaVersion = 'phase5-perf03-sample-v1'
        metricId = 'PERF-03'
        scenario = 'host-ready'
        evidenceLevel = $EvidenceLevel
        buildMode = $BuildMode
        round = $Round
        sample = $Sample
        durationMs = [Math]::Round([Math]::Max(0.0, $DurationMs), 3)
        status = $Status
        stableErrorCode = if ($Status -eq 'PASS') { $null } else { $StableErrorCode }
    }
}

function Test-Perf03RoundPass {
    param(
        [Parameter(Mandatory = $true)]$RoundSummary,
        [Parameter(Mandatory = $true)][int]$ExpectedSampleCount
    )
    return (
        [int]$RoundSummary.failureCount -eq 0 -and
        [int]$RoundSummary.successCount -eq $ExpectedSampleCount -and
        [double]$RoundSummary.p50Ms -le $script:P50ThresholdMs -and
        [double]$RoundSummary.p95Ms -le $script:P95ThresholdMs
    )
}

function Assert-RuntimePerf03Record {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][string]$GitSha,
        [Parameter(Mandatory = $true)][string]$BinarySha256,
        [Parameter(Mandatory = $true)][string]$BuildMode
    )
    $expected = @(
        'schemaVersion', 'recordType', 'metricId', 'measurementMode', 'buildMode',
        'role', 'scenario', 'source', 'measurement', 'unit', 'status', 'value',
        'characterCountBucket', 'gitSha', 'binarySha256'
    )
    if ([string]$Record.status -eq 'failure') { $expected += 'errorCode' }
    Assert-ExactProperties -Value $Record -Expected $expected -Label 'runtime PERF-03 record'
    if ($Record.schemaVersion -isnot [int32] -and $Record.schemaVersion -isnot [int64]) {
        throw 'Runtime PERF-03 schemaVersion must be a JSON integer.'
    }
    foreach ($field in @(
        'recordType', 'metricId', 'measurementMode', 'buildMode', 'role',
        'scenario', 'source', 'measurement', 'unit', 'status',
        'characterCountBucket', 'gitSha', 'binarySha256'
    )) { Assert-JsonString -Value $Record.$field -Label "runtime PERF-03 $field" }
    if (
        $Record.value -is [string] -or $Record.value -is [bool] -or
        $Record.value -isnot [ValueType]
    ) { throw 'Runtime PERF-03 value must be a JSON number.' }
    Assert-Condition -Condition (
        [int]$Record.schemaVersion -eq 1 -and
        [string]$Record.recordType -eq 'metric-sample' -and
        [string]$Record.metricId -eq 'PERF-03' -and
        [string]$Record.measurementMode -eq 'real-acquisition' -and
        [string]$Record.buildMode -eq $BuildMode -and
        [string]$Record.role -eq 'main' -and
        [string]$Record.scenario -eq 'host-ready' -and
        [string]$Record.source -eq 'native-host' -and
        [string]$Record.measurement -eq 'durationMs' -and
        [string]$Record.unit -eq 'milliseconds' -and
        [string]$Record.characterCountBucket -eq 'not-applicable' -and
        [string]$Record.gitSha -eq $GitSha -and
        [string]$Record.binarySha256 -eq $BinarySha256
    ) -Message 'Runtime PERF-03 record identity or measurement contract is invalid.'
    $duration = [double]$Record.value
    Assert-Condition -Condition (
        -not [double]::IsNaN($duration) -and
        -not [double]::IsInfinity($duration) -and
        $duration -ge 0
    ) -Message 'Runtime PERF-03 duration is invalid.'
    if ([string]$Record.status -eq 'success') {
        Assert-Condition -Condition (-not ($Record.PSObject.Properties.Name -contains 'errorCode')) -Message 'Successful PERF-03 record contains an error code.'
    } else {
        Assert-JsonString -Value $Record.errorCode -Label 'runtime PERF-03 errorCode'
        Assert-Condition -Condition ([string]$Record.errorCode -eq 'HOST_NOT_READY') -Message 'Failed PERF-03 record lacks the stable HOST_NOT_READY code.'
    }
}

function Assert-FormalManifestCore {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$GitSha
    )
    Assert-JsonBoolean -Value $Manifest.build.developmentDirty -Expected $false -Label 'manifest.build.developmentDirty'
    Assert-JsonBoolean -Value $Manifest.build.acceptanceEligible -Expected $true -Label 'manifest.build.acceptanceEligible'
    foreach ($field in @(
        [pscustomobject]@{ Value = $Manifest.gitSha; Label = 'manifest.gitSha' },
        [pscustomobject]@{ Value = $Manifest.build.sourceIdentity; Label = 'manifest.build.sourceIdentity' },
        [pscustomobject]@{ Value = $Manifest.package.status; Label = 'manifest.package.status' },
        [pscustomobject]@{ Value = $Manifest.package.startupSmokeStatus; Label = 'manifest.package.startupSmokeStatus' },
        [pscustomobject]@{ Value = $Manifest.supplyChain.status; Label = 'manifest.supplyChain.status' },
        [pscustomobject]@{ Value = $Manifest.signatures.status; Label = 'manifest.signatures.status' }
    )) { Assert-JsonString -Value $field.Value -Label $field.Label }
    Assert-Condition -Condition (
        [string]$Manifest.gitSha -eq $GitSha -and
        [string]$Manifest.build.sourceIdentity -eq "HEAD:$GitSha"
    ) -Message 'Package evidence is not bound to this clean acceptance-eligible HEAD.'
    Assert-Condition -Condition (
        [string]$Manifest.package.status -eq 'PASS' -and
        [string]$Manifest.package.startupSmokeStatus -eq 'PASS' -and
        [string]$Manifest.supplyChain.status -eq 'PASS' -and
        [string]$Manifest.signatures.status -eq 'PASS'
    ) -Message 'Package evidence is missing package, startup, supply-chain, or Authenticode PASS.'
}

function Invoke-StaticSelfTest {
    Assert-Condition -Condition ((Get-NearestRank -Values @(1.0, 2.0, 3.0, 4.0) -Percentile 0.50) -eq 2.0) -Message 'nearest-rank p50 selftest failed.'
    Assert-Condition -Condition ((Get-NearestRank -Values @(1.0, 2.0, 3.0, 4.0) -Percentile 0.95) -eq 4.0) -Message 'nearest-rank p95 selftest failed.'
    Assert-InvocationMode -Development $false -Rounds 3 -Samples 100 -RoundWasExplicit $false -SamplesWereExplicit $false
    $formalCountRejected = $false
    try {
        Assert-InvocationMode -Development $false -Rounds 3 -Samples 99 -RoundWasExplicit $true -SamplesWereExplicit $true
    } catch { $formalCountRejected = $true }
    Assert-Condition -Condition $formalCountRejected -Message 'Formal sample-count negative selftest failed.'
    $developmentCountRejected = $false
    try {
        Assert-InvocationMode -Development $true -Rounds 1 -Samples 1 -RoundWasExplicit $false -SamplesWereExplicit $false
    } catch { $developmentCountRejected = $true }
    Assert-Condition -Condition $developmentCountRejected -Message 'Development explicit-count negative selftest failed.'

    $sample = New-SampleRecord -Round 1 -Sample 1 -DurationMs 699.9996 -Status 'PASS' -StableErrorCode $null -EvidenceLevel 'fixed-lab-benchmark' -BuildMode 'signed-rc'
    Assert-ExactProperties -Value ([pscustomobject]$sample) -Expected @(
        'schemaVersion', 'metricId', 'scenario', 'evidenceLevel', 'buildMode',
        'round', 'sample', 'durationMs', 'status', 'stableErrorCode'
    ) -Label 'sample evidence'
    foreach ($key in $script:ForbiddenEvidenceKeys) {
        Assert-Condition -Condition (-not $sample.Contains($key)) -Message "Forbidden sample field was emitted: $key"
    }
    Assert-Condition -Condition ([double]$sample.durationMs -eq 700.0) -Message 'Sample duration rounding selftest failed.'

    $passingRound = [pscustomobject]@{ failureCount = 0; successCount = 100; p50Ms = 700; p95Ms = 1500 }
    Assert-Condition -Condition (Test-Perf03RoundPass -RoundSummary $passingRound -ExpectedSampleCount 100) -Message 'Exact PERF-03 threshold boundary should pass.'
    $passingRound.p95Ms = 1500.001
    Assert-Condition -Condition (-not (Test-Perf03RoundPass -RoundSummary $passingRound -ExpectedSampleCount 100)) -Message 'PERF-03 p95 negative selftest failed.'
    $passingRound.p95Ms = 1500
    $passingRound.failureCount = 1
    Assert-Condition -Condition (-not (Test-Perf03RoundPass -RoundSummary $passingRound -ExpectedSampleCount 100)) -Message 'PERF-03 zero-failure negative selftest failed.'

    $gitSha = '0123456789abcdef0123456789abcdef01234567'
    $binarySha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    $runtimeRecord = [pscustomobject]@{
        schemaVersion = 1; recordType = 'metric-sample'; metricId = 'PERF-03'
        measurementMode = 'real-acquisition'; buildMode = 'signed-rc'; role = 'main'
        scenario = 'host-ready'; source = 'native-host'; measurement = 'durationMs'
        unit = 'milliseconds'; status = 'success'; value = 42.5
        characterCountBucket = 'not-applicable'; gitSha = $gitSha; binarySha256 = $binarySha
    }
    Assert-RuntimePerf03Record -Record $runtimeRecord -GitSha $gitSha -BinarySha256 $binarySha -BuildMode 'signed-rc'
    $runtimeRecord.value = '42.5'
    $stringNumberRejected = $false
    try {
        Assert-RuntimePerf03Record -Record $runtimeRecord -GitSha $gitSha -BinarySha256 $binarySha -BuildMode 'signed-rc'
    } catch { $stringNumberRejected = $true }
    Assert-Condition -Condition $stringNumberRejected -Message 'String metric number negative selftest failed.'
    $runtimeRecord.value = 42.5
    $runtimeRecord | Add-Member -NotePropertyName path -NotePropertyValue 'forbidden'
    $unknownFieldRejected = $false
    try {
        Assert-RuntimePerf03Record -Record $runtimeRecord -GitSha $gitSha -BinarySha256 $binarySha -BuildMode 'signed-rc'
    } catch { $unknownFieldRejected = $true }
    Assert-Condition -Condition $unknownFieldRejected -Message 'Unknown runtime metric field negative selftest failed.'

    $manifest = [pscustomobject]@{
        gitSha = $gitSha
        build = [pscustomobject]@{ developmentDirty = $false; acceptanceEligible = $true; sourceIdentity = "HEAD:$gitSha" }
        package = [pscustomobject]@{ status = 'PASS'; startupSmokeStatus = 'PASS' }
        supplyChain = [pscustomobject]@{ status = 'PASS' }
        signatures = [pscustomobject]@{ status = 'PASS' }
    }
    Assert-FormalManifestCore -Manifest $manifest -GitSha $gitSha
    $manifest.build.acceptanceEligible = 'true'
    $stringBooleanRejected = $false
    try { Assert-FormalManifestCore -Manifest $manifest -GitSha $gitSha } catch { $stringBooleanRejected = $true }
    Assert-Condition -Condition $stringBooleanRejected -Message 'String acceptanceEligible negative selftest failed.'
    $integerStringRejected = $false
    try { Assert-JsonPositiveInteger -Value '16' -Label 'integer negative selftest' } catch { $integerStringRejected = $true }
    Assert-Condition -Condition $integerStringRejected -Message 'String integer negative selftest failed.'

    Write-Host '[phase5:perf03:selftest] frozen counts, nearest-rank, thresholds, runtime emitter schema, formal manifest binding, and privacy allowlist PASS.'
}

$modeArguments = @{
    Development = [bool]$DevelopmentSelfTest
    Rounds = $RoundCount
    Samples = $SamplesPerRound
    RoundWasExplicit = $PSBoundParameters.ContainsKey('RoundCount')
    SamplesWereExplicit = $PSBoundParameters.ContainsKey('SamplesPerRound')
}
Assert-InvocationMode @modeArguments

if ($StaticSelfTest) {
    $runParameters = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'StaticSelfTest' })
    if ($runParameters.Count -ne 0) { throw '-StaticSelfTest cannot be combined with run parameters.' }
    Invoke-StaticSelfTest
    exit 0
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'packaging\phase5-safe-filesystem.ps1')

if (-not ('Phase5Perf03Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class Phase5Perf03WindowInfo {
    public IntPtr Handle { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public static class Phase5Perf03Native {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint Type; public INPUTUNION Data; }

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
        public byte Reserved1;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

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

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

    public static void RequirePerMonitorDpiAwareness() {
        const int perMonitorAware = 2;
        SetProcessDpiAwareness(perMonitorAware);
        int actual;
        if (GetProcessDpiAwareness(IntPtr.Zero, out actual) != 0 || actual != perMonitorAware) {
            throw new InvalidOperationException("The PERF-03 controller must be per-monitor DPI aware.");
        }
    }

    public static bool IsOnAcPower() {
        SYSTEM_POWER_STATUS status;
        if (!GetSystemPowerStatus(out status) || status.ACLineStatus == 255) {
            throw new InvalidOperationException("AC power state is unavailable.");
        }
        return status.ACLineStatus == 1;
    }

    public static bool PointTargetsWindow(int x, int y, IntPtr expectedRoot) {
        var target = WindowFromPoint(new POINT { X = x, Y = y });
        return target != IntPtr.Zero && GetAncestor(target, 2) == expectedRoot;
    }

    public static bool ForegroundIsWindow(IntPtr expectedWindow) {
        return expectedWindow != IntPtr.Zero && GetForegroundWindow() == expectedWindow;
    }

    public static bool RaiseExistingTopmostWindow(IntPtr window) {
        var topmost = new IntPtr(-1);
        const uint noSize = 0x0001;
        const uint noMove = 0x0002;
        const uint showWindow = 0x0040;
        return SetWindowPos(window, topmost, 0, 0, 0, 0, noSize | noMove | showWindow);
    }

    private static bool SendMouseClick(uint downFlag, uint upFlag) {
        const uint inputMouse = 0;
        var inputs = new[] {
            new INPUT { Type = inputMouse, Data = new INPUTUNION { Mouse = new MOUSEINPUT { Flags = downFlag } } },
            new INPUT { Type = inputMouse, Data = new INPUTUNION { Mouse = new MOUSEINPUT { Flags = upFlag } } }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    }

    public static bool SendRightClick() { return SendMouseClick(0x0008, 0x0010); }
    public static bool SendLeftClick() { return SendMouseClick(0x0002, 0x0004); }

    public static bool SendContextMenuChord() {
        const uint inputKeyboard = 1;
        const uint keyUp = 0x0002;
        const ushort virtualKeyShift = 0x10;
        const ushort virtualKeyF10 = 0x79;
        var inputs = new[] {
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKeyShift } } },
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKeyF10 } } },
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKeyF10, Flags = keyUp } } },
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKeyShift, Flags = keyUp } } }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    }

    public static bool SendVirtualKey(ushort virtualKey) {
        const uint inputKeyboard = 1;
        const uint keyUp = 0x0002;
        var inputs = new[] {
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKey } } },
            new INPUT { Type = inputKeyboard, Data = new INPUTUNION { Keyboard = new KEYBDINPUT { VirtualKey = virtualKey, Flags = keyUp } } }
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)inputs.Length;
    }

    public static Phase5Perf03WindowInfo[] GetVisibleWindows(int processId) {
        var result = new List<Phase5Perf03WindowInfo>();
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)processId || !IsWindowVisible(window)) return true;
            RECT rectangle;
            if (!GetWindowRect(window, out rectangle)) return true;
            int width = rectangle.Right - rectangle.Left;
            int height = rectangle.Bottom - rectangle.Top;
            if (width <= 0 || height <= 0) return true;
            result.Add(new Phase5Perf03WindowInfo {
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

[Phase5Perf03Native]::RequirePerMonitorDpiAwareness()
if (-not ('Windows.Automation.AutomationElement' -as [type])) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
}

function Write-AtomicJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.bak')
    try {
        $json = ($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($temporary, $Path, $backup)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            [IO.File]::Delete($temporary)
        }
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            [IO.File]::Delete($backup)
        }
    }
}

function Add-RawSample {
    param(
        [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
        [Parameter(Mandatory = $true)]$Record
    )
    $line = ($Record | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($line)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Assert-ExactRawEvidence {
    param(
        [Parameter(Mandatory = $true)][IO.FileStream]$Stream,
        [Parameter(Mandatory = $true)][int]$ExpectedRoundCount,
        [Parameter(Mandatory = $true)][int]$ExpectedSamplesPerRound,
        [Parameter(Mandatory = $true)][string]$ExpectedEvidenceLevel,
        [Parameter(Mandatory = $true)][string]$ExpectedBuildMode
    )
    $expectedProperties = @(
        'schemaVersion', 'metricId', 'scenario', 'evidenceLevel', 'buildMode',
        'round', 'sample', 'durationMs', 'status', 'stableErrorCode'
    )
    $originalPosition = $Stream.Position
    $Stream.Flush($true)
    $Stream.Position = 0
    $reader = [IO.StreamReader]::new(
        $Stream,
        (New-Object Text.UTF8Encoding($false, $true)),
        $false,
        4096,
        $true
    )
    try {
        $rawText = $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
        $Stream.Position = $originalPosition
    }
    if (-not $rawText.EndsWith([Environment]::NewLine, [StringComparison]::Ordinal)) {
        throw 'PERF-03 raw evidence must end at a complete record boundary.'
    }
    $body = $rawText.Substring(0, $rawText.Length - [Environment]::NewLine.Length)
    $lines = @($body.Split([string[]]@([Environment]::NewLine), [StringSplitOptions]::None))
    $expectedCount = $ExpectedRoundCount * $ExpectedSamplesPerRound
    if ($lines.Count -ne $expectedCount) {
        throw "PERF-03 raw evidence must contain exactly $expectedCount records."
    }

    $recordIndex = 0
    for ($round = 1; $round -le $ExpectedRoundCount; $round += 1) {
        for ($sample = 1; $sample -le $ExpectedSamplesPerRound; $sample += 1) {
            $line = [string]$lines[$recordIndex]
            $recordIndex += 1
            if ([string]::IsNullOrWhiteSpace($line)) {
                throw 'PERF-03 raw evidence contains an empty record.'
            }
            try {
                $record = $line | ConvertFrom-Json
            } catch {
                throw 'PERF-03 raw evidence contains malformed JSON.'
            }
            Assert-ExactProperties -Value $record -Expected $expectedProperties -Label 'PERF-03 raw record'
            foreach ($field in @('schemaVersion', 'metricId', 'scenario', 'evidenceLevel', 'buildMode', 'status')) {
                Assert-JsonString -Value $record.$field -Label "PERF-03 raw record $field"
            }
            if (
                [string]$record.schemaVersion -ne 'phase5-perf03-sample-v1' -or
                [string]$record.metricId -ne 'PERF-03' -or
                [string]$record.scenario -ne 'host-ready' -or
                [string]$record.evidenceLevel -ne $ExpectedEvidenceLevel -or
                [string]$record.buildMode -ne $ExpectedBuildMode -or
                [int]$record.round -ne $round -or
                [int]$record.sample -ne $sample
            ) { throw 'PERF-03 raw evidence identity or strict round/sample sequence is invalid.' }
            Assert-JsonPositiveInteger -Value $record.round -Label 'PERF-03 raw record round'
            Assert-JsonPositiveInteger -Value $record.sample -Label 'PERF-03 raw record sample'
            if (
                $record.durationMs -is [string] -or
                $record.durationMs -is [bool] -or
                $record.durationMs -isnot [ValueType]
            ) { throw 'PERF-03 raw record durationMs must be a JSON number.' }
            $duration = [double]$record.durationMs
            if ([double]::IsNaN($duration) -or [double]::IsInfinity($duration) -or $duration -lt 0) {
                throw 'PERF-03 raw record durationMs is invalid.'
            }
            if ([string]$record.status -eq 'PASS') {
                if ($null -ne $record.stableErrorCode) {
                    throw 'A passing PERF-03 raw record must have a null stableErrorCode.'
                }
            } elseif ([string]$record.status -eq 'FAIL') {
                Assert-JsonString -Value $record.stableErrorCode -Label 'PERF-03 raw record stableErrorCode'
                Assert-SafeMetadataText -Value ([string]$record.stableErrorCode) -Label 'PERF-03 raw record stableErrorCode'
            } else {
                throw 'PERF-03 raw record status must be PASS or FAIL.'
            }
        }
    }
}

function Assert-ExactEvidenceFileSet {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$ExpectedFileNames
    )
    $directories = @([IO.Directory]::EnumerateDirectories($Root, '*', [IO.SearchOption]::AllDirectories))
    if ($directories.Count -ne 0) {
        throw 'PERF-03 canonical evidence must not contain subdirectories.'
    }
    $actual = @([IO.Directory]::EnumerateFiles($Root, '*', [IO.SearchOption]::TopDirectoryOnly) | ForEach-Object {
        [IO.Path]::GetFileName($_)
    })
    if (-not (Test-StringArrayEqual -Left $actual -Right $ExpectedFileNames)) {
        throw 'PERF-03 canonical evidence does not contain the exact frozen file set.'
    }
}

function Get-ProcessRecords {
    $records = [Collections.Generic.List[object]]::new()
    $query = 'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process'
    foreach ($process in @(Get-CimInstance -Query $query)) {
        $live = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
        if ($null -eq $live) { continue }
        try {
            if ($live.HasExited) { continue }
            $path = if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
                try { [IO.Path]::GetFullPath([string]$live.Path) } catch { $null }
            } else {
                try { [IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { $null }
            }
            $creationTimeUtc = try { $live.StartTime.ToUniversalTime() } catch { $null }
            $records.Add([pscustomobject]@{
                ProcessId = [int]$process.ProcessId
                ParentProcessId = [int]$process.ParentProcessId
                ExecutablePath = $path
                CommandLine = [string]$process.CommandLine
                CreationTimeUtc = $creationTimeUtc
            })
        } finally {
            $live.Dispose()
        }
    }
    return @($records)
}

function Get-PackageResidualProcesses {
    param([Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths)
    return @(Get-ProcessRecords | Where-Object {
        $null -ne $_.ExecutablePath -and $CandidatePaths.Contains([string]$_.ExecutablePath)
    })
}

function Assert-NoPackageResidual {
    param([Parameter(Mandatory = $true)][Collections.Generic.HashSet[string]]$CandidatePaths)
    if (@(Get-PackageResidualProcesses -CandidatePaths $CandidatePaths).Count -ne 0) {
        throw 'A process from the bound package artifact remained at a PERF-03 run boundary.'
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
    $processes = @(Get-ProcessRecords)
    $rootRecord = $processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
    if ($null -ne $rootRecord -and (
        $null -eq $rootRecord.ExecutablePath -or
        -not $rootRecord.ExecutablePath.Equals($ExpectedApplicationPath, [StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $rootRecord.CreationTimeUtc -or
        [Math]::Abs(($rootRecord.CreationTimeUtc - $RootCreationTimeUtc).TotalMilliseconds) -gt 10 -or
        $rootRecord.CommandLine.IndexOf($ExpectedUserDataPath, [StringComparison]::OrdinalIgnoreCase) -lt 0
    )) {
        throw 'Refusing forced cleanup because the bound root identity changed.'
    }

    $lineage = [Collections.Generic.HashSet[int]]::new()
    $lineage.Add($RootProcessId) | Out-Null
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if (
                $lineage.Contains([int]$candidate.ProcessId) -or
                -not $lineage.Contains([int]$candidate.ParentProcessId) -or
                $null -eq $candidate.CreationTimeUtc -or
                $candidate.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)
            ) { continue }
            $lineage.Add([int]$candidate.ProcessId) | Out-Null
            $added = $true
        }
    } while ($added)

    return @($processes | Where-Object {
        if ($null -eq $_.ExecutablePath -or $null -eq $_.CreationTimeUtc) { return $false }
        if ($_.CreationTimeUtc -lt $RootCreationTimeUtc.AddSeconds(-1)) { return $false }
        $applicationPathMatch = $_.ExecutablePath.Equals($ExpectedApplicationPath, [StringComparison]::OrdinalIgnoreCase)
        $hostPathMatch = $_.ExecutablePath.Equals($ExpectedHostPath, [StringComparison]::OrdinalIgnoreCase)
        if (-not $applicationPathMatch -and -not $hostPathMatch) { return $false }
        $applicationIdentity = $applicationPathMatch -and
            $_.CommandLine.IndexOf($ExpectedUserDataPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $hostIdentity = $hostPathMatch -and
            $_.CommandLine -match "(?:^|\s)--parent-pid(?:\s+|=)$RootProcessId(?:\s|$)"
        return $lineage.Contains([int]$_.ProcessId) -or $applicationIdentity -or $hostIdentity
    })
}

function Stop-ExactOwnedRunProcessTree {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHostPath,
        [Parameter(Mandatory = $true)][string]$ExpectedUserDataPath
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $owned = @(Get-ExactOwnedRunProcesses @PSBoundParameters)
        if ($owned.Count -eq 0) { return }
        foreach ($record in @($owned | Sort-Object CreationTimeUtc -Descending)) {
            $process = Get-Process -Id ([int]$record.ProcessId) -ErrorAction SilentlyContinue
            if ($null -eq $process) { continue }
            try {
                if ($process.HasExited) { continue }
                $livePath = [IO.Path]::GetFullPath([string]$process.Path)
                $liveCreated = $process.StartTime.ToUniversalTime()
                if (
                    -not $livePath.Equals([string]$record.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
                    [Math]::Abs(($liveCreated - ([DateTime]$record.CreationTimeUtc)).TotalMilliseconds) -gt 10
                ) {
                    throw 'Refusing forced cleanup because a run-owned process identity changed.'
                }
                $process.Kill()
                if (-not $process.WaitForExit(5000)) {
                    throw 'An exact run-owned process did not stop before the cleanup deadline.'
                }
            } finally {
                $process.Dispose()
            }
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 100
    } while ($true)
    if (@(Get-ExactOwnedRunProcesses @PSBoundParameters).Count -ne 0) {
        throw 'The exact run-owned process set remained after forced cleanup.'
    }
}

function Remove-IsolatedRunRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $resolved.StartsWith($temporaryParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a PERF-03 run root outside the system temporary directory.'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            Remove-Phase5DirectoryTree -Path $resolved -AllowedParent $temporaryParent
            return
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Get-BallWindow {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $candidates = @(
        [Phase5Perf03Native]::GetVisibleWindows($RootProcessId) |
            Where-Object { $_.Width -ge 16 -and $_.Height -ge 16 }
    )
    if ($candidates.Count -ne 1) { return $null }
    return $candidates[0]
}

function Get-ProductContextMenuWindow {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][long[]]$PreCommandWindowHandles
    )
    $candidates = @(
        [Phase5Perf03Native]::GetVisibleWindows($RootProcessId) | Where-Object {
            $handle = $_.Handle.ToInt64()
            -not ($PreCommandWindowHandles -contains $handle) -and
            $_.Width -ge 80 -and $_.Height -ge 80
        }
    )
    if ($candidates.Count -ne 1) { return $null }
    return $candidates[0]
}

function Get-ProductExitMenuTarget {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)]$ContextMenu
    )
    $processCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty,
        [object]$RootProcessId
    )
    $typeCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [object][Windows.Automation.ControlType]::MenuItem
    )
    $conditions = [Windows.Automation.Condition[]]@($processCondition, $typeCondition)
    $condition = [Windows.Automation.AndCondition]::new($conditions)
    $rootElement = [Windows.Automation.AutomationElement]::RootElement
    $elements = $rootElement.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        $condition
    )
    $exitLabel = -join @([char]0x9000, [char]0x51FA)
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($element in $elements) {
        try {
            $current = $element.Current
            if (
                [string]$current.Name -eq $exitLabel -and
                [bool]$current.IsEnabled -and
                -not [bool]$current.IsOffscreen -and
                -not $current.BoundingRectangle.IsEmpty
            ) {
                $rectangle = $current.BoundingRectangle
                if (
                    $rectangle.Left -ge $ContextMenu.Left -and
                    $rectangle.Top -ge $ContextMenu.Top -and
                    $rectangle.Right -le ($ContextMenu.Left + $ContextMenu.Width) -and
                    $rectangle.Bottom -le ($ContextMenu.Top + $ContextMenu.Height)
                ) {
                    $matches.Add([pscustomobject]@{
                        Element = $element
                        Left = [double]$rectangle.Left
                        Top = [double]$rectangle.Top
                        Width = [double]$rectangle.Width
                        Height = [double]$rectangle.Height
                    })
                }
            }
        } catch {
            # A stale UIA peer is not a candidate; exact-one remains mandatory.
        }
    }
    if ($matches.Count -ne 1) { return $null }
    return $matches[0]
}

function Set-ProductBallAutomationFocus {
    param(
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)]$BallWindow
    )
    $processCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ProcessIdProperty,
        [object]$RootProcessId
    )
    $typeCondition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [object][Windows.Automation.ControlType]::Button
    )
    $conditions = [Windows.Automation.Condition[]]@($processCondition, $typeCondition)
    $condition = [Windows.Automation.AndCondition]::new($conditions)
    $rootElement = [Windows.Automation.AutomationElement]::RootElement
    $elements = $rootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($element in $elements) {
        try {
            $current = $element.Current
            $rectangle = $current.BoundingRectangle
            if (
                [bool]$current.IsEnabled -and
                -not [bool]$current.IsOffscreen -and
                -not $rectangle.IsEmpty -and
                $rectangle.Left -ge $BallWindow.Left -and
                $rectangle.Top -ge $BallWindow.Top -and
                $rectangle.Right -le ($BallWindow.Left + $BallWindow.Width) -and
                $rectangle.Bottom -le ($BallWindow.Top + $BallWindow.Height)
            ) { $matches.Add($element) }
        } catch {
            # Stale UIA peers are excluded; exact-one remains mandatory.
        }
    }
    if ($matches.Count -ne 1) { return $false }
    try {
        $matches[0].SetFocus()
        return $true
    } catch {
        return $false
    }
}

function Assert-RootProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath
    )
    $Process.Refresh()
    if ($Process.HasExited -or $Process.Id -ne $RootProcessId) {
        throw 'The bound PERF-03 root process exited or changed identity.'
    }
    if (
        -not ([IO.Path]::GetFullPath([string]$Process.Path)).Equals(
            $ExpectedApplicationPath,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        [Math]::Abs(($Process.StartTime.ToUniversalTime() - $RootCreationTimeUtc).TotalMilliseconds) -gt 10
    ) {
        throw 'The exact root process image or creation time changed.'
    }
}

function Request-GracefulExitThroughProductUi {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$RootProcess,
        [Parameter(Mandatory = $true)][int]$RootProcessId,
        [Parameter(Mandatory = $true)][DateTime]$RootCreationTimeUtc,
        [Parameter(Mandatory = $true)][string]$ExpectedApplicationPath,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    Assert-RootProcessIdentity -Process $RootProcess -RootProcessId $RootProcessId -RootCreationTimeUtc $RootCreationTimeUtc -ExpectedApplicationPath $ExpectedApplicationPath
    $ballDeadline = [DateTime]::UtcNow.AddSeconds(5)
    $ballWindow = $null
    do {
        $ballWindow = Get-BallWindow -RootProcessId $RootProcessId
        if ($null -eq $ballWindow) { Start-Sleep -Milliseconds 25 }
    } while ($null -eq $ballWindow -and [DateTime]::UtcNow -lt $ballDeadline)
    if ($null -eq $ballWindow) {
        throw 'The unique product Ball window was unavailable for the graceful-exit path.'
    }

    $visibleBeforeCommand = @([Phase5Perf03Native]::GetVisibleWindows($RootProcessId))
    $ballHandle = $ballWindow.Handle.ToInt64()
    if (@($visibleBeforeCommand | Where-Object { $_.Handle.ToInt64() -eq $ballHandle }).Count -ne 1) {
        throw 'The exact product Ball window changed before the context-menu command.'
    }
    $preCommandWindowHandles = [long[]]@(
        $visibleBeforeCommand | ForEach-Object { $_.Handle.ToInt64() }
    )
    if (-not [Phase5Perf03Native]::RaiseExistingTopmostWindow($ballWindow.Handle)) {
        throw 'Unable to restore the product Ball topmost z-order.'
    }
    [Phase5Perf03Native]::SetForegroundWindow($ballWindow.Handle) | Out-Null
    if (-not (Set-ProductBallAutomationFocus -RootProcessId $RootProcessId -BallWindow $ballWindow)) {
        throw 'The exact enabled product Ball accessibility target was unavailable or ambiguous.'
    }
    Start-Sleep -Milliseconds 100
    if (-not [Phase5Perf03Native]::SendContextMenuChord()) {
        throw 'The verified Ball context-menu command could not be dispatched.'
    }
    $menuDeadline = [DateTime]::UtcNow.AddSeconds(2)
    $contextMenu = $null
    do {
        $contextMenu = Get-ProductContextMenuWindow `
            -RootProcessId $RootProcessId `
            -PreCommandWindowHandles $preCommandWindowHandles
        if ($null -eq $contextMenu) { Start-Sleep -Milliseconds 25 }
    } while ($null -eq $contextMenu -and [DateTime]::UtcNow -lt $menuDeadline)
    if ($null -eq $contextMenu) { throw 'The same-PID product context-menu popup was not observed.' }

    $targetDeadline = [DateTime]::UtcNow.AddSeconds(2)
    $exitTarget = $null
    do {
        $exitTarget = Get-ProductExitMenuTarget `
            -RootProcessId $RootProcessId `
            -ContextMenu $contextMenu
        if ($null -eq $exitTarget) { Start-Sleep -Milliseconds 25 }
    } while ($null -eq $exitTarget -and [DateTime]::UtcNow -lt $targetDeadline)
    if ($null -eq $exitTarget) {
        throw 'The exact enabled product Exit menu item was unavailable or ambiguous.'
    }
    try {
        $invokePattern = $exitTarget.Element.GetCurrentPattern(
            [Windows.Automation.InvokePattern]::Pattern
        )
        $invokePattern.Invoke()
    } catch {
        throw 'The exact product Exit menu item could not be invoked.'
    }

    if (-not $RootProcess.WaitForExit($TimeoutSeconds * 1000)) {
        throw 'The product did not exit before the graceful-exit deadline.'
    }
    return [int]$RootProcess.ExitCode
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

function Get-LiveEnvironment {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    $processors = @(Get-CimInstance -ClassName Win32_Processor)
    $powerOutput = (& powercfg.exe /getactivescheme 2>&1 | Out-String)
    if (
        $LASTEXITCODE -ne 0 -or
        $powerOutput -notmatch '(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    ) { throw 'Active power-plan identity is unavailable.' }
    return [ordered]@{
        osBuild = [string]$operatingSystem.BuildNumber
        osArchitecture = [string]$operatingSystem.OSArchitecture
        cpuModels = [string[]]@(
            $processors | ForEach-Object { ([string]$_.Name).Trim() } | Sort-Object -Unique
        )
        physicalCoreCount = [int](($processors | Measure-Object -Property NumberOfCores -Sum).Sum)
        logicalProcessorCount = [int](($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
        ramBytes = [int64]$computer.TotalPhysicalMemory
        powerPlanGuid = $Matches[1].ToLowerInvariant()
        acPower = [Phase5Perf03Native]::IsOnAcPower()
    }
}

function Assert-TrackedDeviceRegistry {
    param(
        [Parameter(Mandatory = $true)][string]$RegistrationId,
        [Parameter(Mandatory = $true)][string]$RegistryPath
    )
    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
        throw 'Formal PERF-03 device registry is missing.'
    }
    $repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'
    if (-not $RegistryPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The device registry must be a Git-tracked file in this clean source tree.'
    }
    $relativePath = $RegistryPath.Substring($repositoryPrefix.Length).Replace('\', '/')
    & git -C $repositoryRoot ls-files --error-unmatch -- $relativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The PERF-03 device registry is not tracked by the bound Git HEAD.' }

    $registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-ExactProperties -Value $registry -Expected @('schemaVersion', 'devices') -Label 'device registry root'
    if ([string]$registry.schemaVersion -notin @(
        'phase5-perf03-device-registry-v1',
        'phase5-perf09-device-registry-v1'
    )) { throw 'Device registry schemaVersion is not a supported strict Phase 5 fixed-lab registry.' }
    $devices = @($registry.devices)
    if ($devices.Count -eq 0) { throw 'Device registry is empty.' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($device in $devices) {
        Assert-ExactProperties -Value $device -Expected @(
            'deviceRegistrationId', 'status', 'deviceFingerprintSha256'
        ) -Label 'device registry entry'
        foreach ($field in @('deviceRegistrationId', 'status', 'deviceFingerprintSha256')) {
            Assert-JsonString -Value $device.$field -Label "device registry $field"
        }
        Assert-SafeMetadataText -Value ([string]$device.deviceRegistrationId) -Label 'device registry ID' -MaximumLength 128
        if (-not $ids.Add([string]$device.deviceRegistrationId)) { throw 'Device registry contains a duplicate registration ID.' }
        if ([string]$device.status -notin @('active', 'revoked')) { throw 'Device registry status is invalid.' }
        if ([string]$device.deviceFingerprintSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Device registry fingerprint is invalid.' }
    }
    $matching = @($devices | Where-Object deviceRegistrationId -eq $RegistrationId)
    if ($matching.Count -ne 1 -or [string]$matching[0].status -ne 'active') {
        throw 'RunMetadata deviceRegistrationId is not one active trusted registration.'
    }
    if ([string]$matching[0].deviceFingerprintSha256 -ne (Get-LiveDeviceFingerprintSha256)) {
        throw 'The live fixed-lab device does not match its trusted registration fingerprint.'
    }
    return [pscustomobject]@{
        SchemaVersion = [string]$registry.schemaVersion
        Sha256 = (Get-FileHash -LiteralPath $RegistryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Read-FormalRunMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$LiveEnvironment,
        [Parameter(Mandatory = $true)][string]$RegistryPath
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Formal PERF-03 RunMetadata file is missing.'
    }
    $metadata = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-ExactProperties -Value $metadata -Expected @('schemaVersion', 'run', 'environment') -Label 'run metadata root'
    if ([string]$metadata.schemaVersion -ne 'phase5-perf03-run-metadata-v1') {
        throw 'PERF-03 RunMetadata schemaVersion is invalid.'
    }
    Assert-ExactProperties -Value $metadata.run -Expected @(
        'runId', 'workflowName', 'workflowRunId', 'operatorRole',
        'deviceRegistrationId', 'buildMode', 'evidenceLevel',
        'dedicatedInteractiveSession', 'foregroundInputExclusive',
        'debuggerClosed', 'unrelatedForegroundTasksClosed'
    ) -Label 'run metadata run'
    foreach ($field in @('runId', 'workflowRunId', 'deviceRegistrationId')) {
        Assert-JsonString -Value $metadata.run.$field -Label "run.$field"
        $value = [string]$metadata.run.$field
        Assert-SafeMetadataText -Value $value -Label "run.$field" -MaximumLength 128
        if ($value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$') { throw "run.$field format is invalid." }
    }
    foreach ($field in @('workflowName', 'operatorRole', 'buildMode', 'evidenceLevel')) {
        Assert-JsonString -Value $metadata.run.$field -Label "run.$field"
    }
    if ([string]$metadata.run.workflowName -ne 'phase5-perf03-host-ready') { throw 'RunMetadata workflowName is invalid.' }
    if ([string]$metadata.run.operatorRole -notin @('Engineering', 'Quality', 'Release')) { throw 'RunMetadata operatorRole is invalid.' }
    if ([string]$metadata.run.buildMode -ne 'signed-rc') { throw 'Formal PERF-03 buildMode must be signed-rc.' }
    if ([string]$metadata.run.evidenceLevel -ne 'fixed-lab-benchmark') { throw 'Formal PERF-03 evidenceLevel must be fixed-lab-benchmark.' }
    foreach ($field in @(
        'dedicatedInteractiveSession', 'foregroundInputExclusive',
        'debuggerClosed', 'unrelatedForegroundTasksClosed'
    )) { Assert-JsonBoolean -Value $metadata.run.$field -Expected $true -Label "run.$field" }

    Assert-ExactProperties -Value $metadata.environment -Expected @(
        'osBuild', 'osArchitecture', 'cpuModels', 'physicalCoreCount',
        'logicalProcessorCount', 'ramBytes', 'powerPlanGuid', 'acPower',
        'antivirusScanActivityAbsent', 'osUpdateActivityAbsent'
    ) -Label 'run metadata environment'
    foreach ($field in @('osBuild', 'osArchitecture', 'powerPlanGuid')) {
        Assert-JsonString -Value $metadata.environment.$field -Label "environment.$field"
        Assert-SafeMetadataText -Value ([string]$metadata.environment.$field) -Label "environment.$field"
    }
    foreach ($field in @('physicalCoreCount', 'logicalProcessorCount', 'ramBytes')) {
        Assert-JsonPositiveInteger -Value $metadata.environment.$field -Label "environment.$field"
    }
    $cpuModels = @($metadata.environment.cpuModels)
    if ($cpuModels.Count -eq 0) { throw 'environment.cpuModels must be non-empty.' }
    foreach ($model in $cpuModels) {
        Assert-JsonString -Value $model -Label 'environment.cpuModels entry'
        Assert-SafeMetadataText -Value ([string]$model) -Label 'environment.cpuModels entry'
    }
    foreach ($field in @('acPower', 'antivirusScanActivityAbsent', 'osUpdateActivityAbsent')) {
        Assert-JsonBoolean -Value $metadata.environment.$field -Expected $true -Label "environment.$field"
    }
    foreach ($field in @(
        'osBuild', 'osArchitecture', 'physicalCoreCount', 'logicalProcessorCount',
        'ramBytes', 'powerPlanGuid', 'acPower'
    )) {
        if ([string]$metadata.environment.$field -ne [string]$LiveEnvironment.$field) {
            throw "RunMetadata environment.$field does not match the live device."
        }
    }
    if (-not (Test-StringArrayEqual -Left @($metadata.environment.cpuModels) -Right @($LiveEnvironment.cpuModels))) {
        throw 'RunMetadata CPU models do not match the live device.'
    }
    $registryEvidence = Assert-TrackedDeviceRegistry -RegistrationId ([string]$metadata.run.deviceRegistrationId) -RegistryPath $RegistryPath
    return [pscustomobject]@{
        Metadata = $metadata
        MetadataSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        RegistrySha256 = $registryEvidence.Sha256
        RegistrySchemaVersion = $registryEvidence.SchemaVersion
    }
}

function Assert-SourceIdentityStillCurrent {
    param([Parameter(Mandatory = $true)][string]$GitSha)
    $currentHead = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $currentHead -ne $GitSha) { throw 'Git HEAD changed during PERF-03.' }
    $status = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($status -join [Environment]::NewLine)) {
        throw 'Formal PERF-03 requires and continuously rechecks a clean source worktree.'
    }
}

function Assert-QuickArtifactIdentity {
    param([Parameter(Mandatory = $true)][object[]]$Expected)
    foreach ($record in $Expected) {
        $item = Get-Item -LiteralPath $record.Path
        if (
            [int64]$item.Length -ne [int64]$record.Length -or
            $item.LastWriteTimeUtc.Ticks -ne [int64]$record.LastWriteTimeUtcTicks
        ) { throw 'A bound PERF-03 artifact changed between sample boundaries.' }
    }
}

function Assert-FullArtifactIdentity {
    param([Parameter(Mandatory = $true)][object[]]$Expected)
    foreach ($record in $Expected) {
        $hash = (Get-FileHash -LiteralPath $record.Path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne [string]$record.Sha256) { throw 'A bound PERF-03 artifact hash changed during the run.' }
    }
}

function Open-ArtifactReadLeases {
    param([Parameter(Mandatory = $true)][object[]]$Expected)
    $streams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        foreach ($record in $Expected) {
            $streams.Add([IO.File]::Open(
                [string]$record.Path,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            ))
        }
        # The handles prohibit writes, replacement, and deletion for the rest
        # of the run. Hash only after every lease is held to close the partial-
        # acquisition identity window.
        Assert-FullArtifactIdentity -Expected $Expected
        return [pscustomobject]@{ Streams = $streams }
    } catch {
        foreach ($stream in $streams) {
            try { $stream.Dispose() } catch {}
        }
        throw
    }
}

function Invoke-EvidencePrivacyScan {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Output
    )
    & node (Join-Path $PSScriptRoot 'phase5-evidence-privacy-scan.mjs') --root $Root --output $Output --mode evidence
    if ($LASTEXITCODE -ne 0) { throw 'PERF-03 evidence privacy scan failed.' }
}

function Assert-SignedPackageEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$SignedInstallerPath
    )
    & node (Join-Path $PSScriptRoot 'supply-chain\verify-phase5-evidence.mjs') `
        --evidence-dir $EvidenceDirectory `
        --package-dir $PackagePath `
        --release-mode signed `
        --installer $SignedInstallerPath
    if ($LASTEXITCODE -ne 0) { throw 'Exact signed package evidence verification failed.' }
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
        throw 'GitHub/Sigstore attestation verification failed for one formal PERF-03 input.'
    }
}

function Assert-FinalReleaseTrust {
    param(
        [Parameter(Mandatory = $true)][string]$FinalManifestPath,
        [Parameter(Mandatory = $true)][string]$CleanVerificationPath,
        [Parameter(Mandatory = $true)][string]$IndependentRootPath,
        [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
        [Parameter(Mandatory = $true)]$DraftManifest,
        [Parameter(Mandatory = $true)][string]$DraftManifestSha256,
        [Parameter(Mandatory = $true)][string]$GitSha,
        [Parameter(Mandatory = $true)][string]$SignedSubject,
        [Parameter(Mandatory = $true)][string]$ApplicationPath,
        [Parameter(Mandatory = $true)][string]$HostPath,
        [Parameter(Mandatory = $true)][string]$AsarPath,
        [Parameter(Mandatory = $true)][string]$SignedInstallerPath
    )
    $canonicalFinalManifest = Join-Path $EvidenceDirectory 'release\final-release-manifest.json'
    if (-not $FinalManifestPath.Equals($canonicalFinalManifest, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Formal PERF-03 requires the canonical release/final-release-manifest.json.'
    }
    foreach ($path in @($FinalManifestPath, $CleanVerificationPath, $IndependentRootPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Formal PERF-03 final release trust input is missing.'
        }
    }
    $evidencePrefix = $EvidenceDirectory.TrimEnd('\') + '\'
    if (
        $IndependentRootPath.StartsWith($evidencePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $CleanVerificationPath.StartsWith($evidencePrefix, [StringComparison]::OrdinalIgnoreCase)
    ) { throw 'Independent trusted root and clean-download PASS must come from outside the build evidence tree.' }

    $artifactBundlePath = Join-Path $EvidenceDirectory 'security\github-artifacts-attestation.json'
    $manifestBundlePath = Join-Path $EvidenceDirectory 'security\github-manifest-attestation.json'
    $evidenceTrustedRootPath = Join-Path $EvidenceDirectory 'security\trusted_root.jsonl'
    foreach ($path in @($artifactBundlePath, $manifestBundlePath, $evidenceTrustedRootPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Formal PERF-03 attestation bundle or evidence trusted root is missing.'
        }
    }
    $ghVersionLine = (& gh --version | Select-Object -First 1)
    if (
        $LASTEXITCODE -ne 0 -or
        $ghVersionLine -notmatch '^gh version ([0-9]+\.[0-9]+\.[0-9]+)' -or
        [version]$Matches[1] -lt [version]'2.93.0'
    ) { throw 'Formal PERF-03 requires GitHub CLI 2.93.0 or newer for offline attestation verification.' }

    $finalManifest = Get-Content -LiteralPath $FinalManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    $expectedRepository = 'Chatblanccc/desktop-translate'
    $expectedSignerWorkflow = "$expectedRepository/.github/workflows/phase5-windows.yml"
    if (
        [int]$finalManifest.schemaVersion -ne 1 -or
        [string]$finalManifest.source.repository -ne $expectedRepository -or
        [string]$finalManifest.source.ref -notmatch '^refs/tags/phase5-rc-' -or
        [string]$finalManifest.source.gitSha -ne $GitSha -or
        [string]$finalManifest.source.sourceIdentity -ne "HEAD:$GitSha" -or
        $finalManifest.source.developmentDirty -isnot [bool] -or
        $finalManifest.source.developmentDirty -ne $false -or
        $null -ne $finalManifest.source.patchDigest -or
        [string]$finalManifest.independentTrustRoot.status -ne 'PASS' -or
        [string]$finalManifest.independentTrustRoot.repository -ne $expectedRepository -or
        [string]$finalManifest.independentTrustRoot.sourceRef -ne [string]$finalManifest.source.ref -or
        [string]$finalManifest.independentTrustRoot.sourceDigest -ne $GitSha -or
        [string]$finalManifest.independentTrustRoot.signerWorkflow -ne $expectedSignerWorkflow -or
        [string]$finalManifest.authenticode.expectedSubject -ne $SignedSubject
    ) { throw 'Final release manifest source or trusted build identity is invalid.' }

    $independentRootSha256 = (Get-FileHash -LiteralPath $IndependentRootPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $evidenceRootSha256 = (Get-FileHash -LiteralPath $evidenceTrustedRootPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $artifactBundleSha256 = (Get-FileHash -LiteralPath $artifactBundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $independentRootSha256 -ne $evidenceRootSha256 -or
        [string]$finalManifest.independentTrustRoot.trustedRootSha256 -ne $independentRootSha256 -or
        [string]$finalManifest.independentTrustRoot.artifactBundleSha256 -ne $artifactBundleSha256
    ) { throw 'Final release trusted-root or artifact-attestation bytes are not the independent exact set.' }

    $attestationArguments = @{
        TrustedRoot = $IndependentRootPath
        Repository = $expectedRepository
        SignerWorkflow = $expectedSignerWorkflow
        SourceRef = [string]$finalManifest.source.ref
        SourceDigest = $GitSha
    }
    Invoke-GitHubAttestationVerification -Path $FinalManifestPath -Bundle $manifestBundlePath @attestationArguments
    $finalManifestSha256 = (Get-FileHash -LiteralPath $FinalManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $packageFileManifestRelative = [string]$DraftManifest.package.fileManifest
    if (
        [string]::IsNullOrWhiteSpace($packageFileManifestRelative) -or
        [IO.Path]::IsPathRooted($packageFileManifestRelative) -or
        $packageFileManifestRelative.Contains('\') -or
        $packageFileManifestRelative.Split('/') -contains '..'
    ) { throw 'Draft package file-manifest path is unsafe.' }
    $packageFileManifestPath = Join-Path $EvidenceDirectory ($packageFileManifestRelative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $packageFileManifestPath -PathType Leaf)) {
        throw 'Draft package file-manifest evidence is missing.'
    }
    $packageFileManifestSha256 = (Get-FileHash -LiteralPath $packageFileManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $packageSbomPath = Join-Path (Split-Path -Parent $AsarPath) 'supply-chain\sbom.cdx.json'
    if (-not (Test-Path -LiteralPath $packageSbomPath -PathType Leaf)) { throw 'Packaged SBOM is missing.' }
    $packageSbomSha256 = (Get-FileHash -LiteralPath $packageSbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        [string]$finalManifest.productVersion -ne [string]$DraftManifest.productVersion -or
        [string]$finalManifest.authenticode.status -ne 'PASS' -or
        [string]$finalManifest.packageSmoke.status -ne 'PASS' -or
        [string]$finalManifest.packageEvidence.status -ne 'PASS' -or
        [string]$finalManifest.supplyChain.status -ne 'PASS' -or
        [string]$finalManifest.packageEvidence.fileManifestSha256 -ne $packageFileManifestSha256 -or
        [string]$finalManifest.supplyChain.draftEvidenceSha256 -ne $DraftManifestSha256 -or
        [string]$finalManifest.supplyChain.sbomSha256 -ne $packageSbomSha256
    ) { throw 'Final release manifest does not bind the exact draft, package file manifest, and packaged SBOM.' }

    $expectedArtifacts = [ordered]@{
        application = [pscustomobject]@{ path = 'package/desktop-translate.exe'; name = 'desktop-translate.exe'; actualPath = $ApplicationPath }
        nativeHost = [pscustomobject]@{ path = 'package/resources/selection-host/selection-host.exe'; name = 'selection-host.exe'; actualPath = $HostPath }
        asar = [pscustomobject]@{ path = 'package/resources/app.asar'; name = 'app.asar'; actualPath = $AsarPath }
        installer = [pscustomobject]@{ path = 'installer/' + [IO.Path]::GetFileName($SignedInstallerPath); name = [IO.Path]::GetFileName($SignedInstallerPath); actualPath = $SignedInstallerPath }
    }
    foreach ($role in $expectedArtifacts.Keys) {
        $expected = $expectedArtifacts[$role]
        $item = Get-Item -LiteralPath $expected.actualPath
        $expected | Add-Member -NotePropertyName size -NotePropertyValue ([int64]$item.Length)
        $expected | Add-Member -NotePropertyName sha256 -NotePropertyValue ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant())
    }
    $manifestArtifacts = @($finalManifest.artifacts)
    if ($manifestArtifacts.Count -ne $expectedArtifacts.Count) { throw 'Final release manifest artifact set is not exact.' }
    foreach ($role in $expectedArtifacts.Keys) {
        $expected = $expectedArtifacts[$role]
        $actual = @($manifestArtifacts | Where-Object role -eq $role)
        if (
            $actual.Count -ne 1 -or
            [string]$actual[0].path -ne $expected.path -or
            [string]$actual[0].name -ne $expected.name -or
            [int64]$actual[0].size -ne [int64]$expected.size -or
            [string]$actual[0].sha256 -ne $expected.sha256
        ) { throw 'Final release manifest does not bind one exact application/Host/ASAR/installer set.' }
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
        [string]$cleanVerification.sourceDigest -ne $GitSha -or
        [string]$cleanVerification.signerWorkflow -ne $expectedSignerWorkflow -or
        [string]$cleanVerification.finalManifestSha256 -ne $finalManifestSha256 -or
        [string]$cleanVerification.manifestAttestationSha256 -ne $manifestBundleSha256 -or
        [string]$cleanVerification.trustedRootSha256 -ne $independentRootSha256 -or
        [string]$cleanVerification.independentlyAcquiredTrustedRootSha256 -ne $independentRootSha256 -or
        [string]$cleanVerification.authenticodeSubject -ne $SignedSubject
    ) { throw 'Independent clean-download verification is incomplete or bound to another release.' }
    $cleanArtifacts = @($cleanVerification.exactArtifacts)
    if ($cleanArtifacts.Count -ne $expectedArtifacts.Count) { throw 'Clean-download verification artifact set is not exact.' }
    foreach ($role in $expectedArtifacts.Keys) {
        $expected = $expectedArtifacts[$role]
        $actual = @($cleanArtifacts | Where-Object role -eq $role)
        if (
            $actual.Count -ne 1 -or
            [string]$actual[0].path -ne $expected.path -or
            [string]$actual[0].name -ne $expected.name -or
            [int64]$actual[0].size -ne [int64]$expected.size -or
            [string]$actual[0].sha256 -ne $expected.sha256
        ) { throw 'Clean-download verification does not bind the exact benchmark artifact set.' }
    }
    return [pscustomobject]@{
        FinalManifestSha256 = $finalManifestSha256
        CleanVerificationSha256 = (Get-FileHash -LiteralPath $CleanVerificationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        IndependentRootSha256 = $independentRootSha256
        ArtifactBundleSha256 = $artifactBundleSha256
        ManifestBundleSha256 = $manifestBundleSha256
        ArtifactBundlePath = $artifactBundlePath
        ManifestBundlePath = $manifestBundlePath
        EvidenceTrustedRootPath = $evidenceTrustedRootPath
    }
}

function Start-BoundProductSample {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$UserDataDirectory,
        [Parameter(Mandatory = $true)][string]$RunId,
        [Parameter(Mandatory = $true)][string]$GitSha,
        [Parameter(Mandatory = $true)][string]$BinarySha256,
        [Parameter(Mandatory = $true)][string]$BuildMode
    )
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $ApplicationPath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.Arguments = "--user-data-dir=`"$UserDataDirectory`""
    $benchmarkEnvironment = [ordered]@{
        DESKTOP_TRANSLATE_PHASE5_METRICS = '1'
        DESKTOP_TRANSLATE_PHASE5_USER_DATA_DIR = $UserDataDirectory
        # Packaged identity is derived from the component manifest and ASAR.
        # The controller validates the emitted values against its own hashes;
        # do not let redundant expected-value variables disable the sink.
        DESKTOP_TRANSLATE_PHASE5_GIT_SHA = $null
        DESKTOP_TRANSLATE_PHASE5_BINARY_SHA256 = $null
        DESKTOP_TRANSLATE_PHASE5_BUILD_MODE = $BuildMode
        DESKTOP_TRANSLATE_PHASE5_MEASUREMENT_MODE = 'real-acquisition'
        DESKTOP_TRANSLATE_PHASE5_RUN_ID = $RunId
        DESKTOP_TRANSLATE_PHASE5_METRICS_FILE = $null
    }
    foreach ($name in $benchmarkEnvironment.Keys) {
        $value = $benchmarkEnvironment[$name]
        if ($null -eq $value) {
            $startInfo.EnvironmentVariables.Remove($name)
        } else {
            $startInfo.EnvironmentVariables[$name] = [string]$value
        }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        $process.Dispose()
        throw 'The packaged application process did not start.'
    }
    return $process
}

function Wait-RuntimePerf03Record {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRawPath,
        [Parameter(Mandatory = $true)][Diagnostics.Process]$RootProcess,
        [Parameter(Mandatory = $true)][string]$GitSha,
        [Parameter(Mandatory = $true)][string]$BinarySha256,
        [Parameter(Mandatory = $true)][string]$BuildMode,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastParseFailure = $false
    do {
        if (Test-Path -LiteralPath $RuntimeRawPath -PathType Leaf) {
            try {
                $records = [Collections.Generic.List[object]]::new()
                foreach ($line in @(Get-Content -LiteralPath $RuntimeRawPath -Encoding utf8)) {
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }
                    $records.Add(($line | ConvertFrom-Json))
                }
                $matching = @($records | Where-Object {
                    [string]$_.metricId -eq 'PERF-03' -and [string]$_.scenario -eq 'host-ready'
                })
                if ($matching.Count -gt 1) { throw 'The isolated sample emitted more than one PERF-03 Host-ready record.' }
                if ($matching.Count -eq 1) {
                    Assert-RuntimePerf03Record -Record $matching[0] -GitSha $GitSha -BinarySha256 $BinarySha256 -BuildMode $BuildMode
                    return $matching[0]
                }
                $lastParseFailure = $false
            } catch {
                $lastParseFailure = $true
            }
        }
        $RootProcess.Refresh()
        if ($RootProcess.HasExited) {
            if ($lastParseFailure) { throw 'The runtime metrics file was malformed when the product exited.' }
            throw 'The product exited before emitting exactly one PERF-03 Host-ready record.'
        }
        Start-Sleep -Milliseconds 25
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($lastParseFailure) { throw 'The runtime metrics file remained malformed until the PERF-03 deadline.' }
    throw 'The product did not emit PERF-03 Host-ready evidence before the startup deadline.'
}

function Get-SampleFailureCode {
    param([Parameter(Mandatory = $true)][string]$Stage)
    switch ($Stage) {
        'ARTIFACT_IDENTITY_CHANGED' { return 'ARTIFACT_IDENTITY_CHANGED' }
        'PRODUCT_STARTUP_FAILED' { return 'PRODUCT_STARTUP_FAILED' }
        'PERF03_EVIDENCE_FAILED' { return 'PERF03_EVIDENCE_UNAVAILABLE' }
        'PRODUCT_UI_EXIT_FAILED' { return 'PRODUCT_UI_EXIT_FAILED' }
        'ROOT_EXIT_NONZERO' { return 'ROOT_EXIT_NONZERO' }
        'POST_SAMPLE_RESIDUAL' { return 'POST_SAMPLE_PACKAGE_RESIDUAL' }
        default { return 'UNHANDLED_SAMPLE_FAILURE' }
    }
}

if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $PackageDirectory = Join-Path $repositoryRoot 'artifacts\phase5\package\dist\win-unpacked'
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $OutputRoot = Join-Path $repositoryRoot "artifacts\phase5\local\perf03-host-ready-$stamp"
}

$PackageDirectory = [IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
$applicationExecutable = Join-Path $PackageDirectory 'desktop-translate.exe'
$hostExecutable = Join-Path $PackageDirectory 'resources\selection-host\selection-host.exe'
$appAsar = Join-Path $PackageDirectory 'resources\app.asar'
$manifestPath = if ([string]::IsNullOrWhiteSpace($PackageEvidenceManifest)) { $null } else { [IO.Path]::GetFullPath($PackageEvidenceManifest) }
$installerPathResolved = if ([string]::IsNullOrWhiteSpace($InstallerPath)) { $null } else { [IO.Path]::GetFullPath($InstallerPath) }
$finalManifestPath = if ([string]::IsNullOrWhiteSpace($FinalReleaseManifest)) { $null } else { [IO.Path]::GetFullPath($FinalReleaseManifest) }
$cleanVerificationPath = if ([string]::IsNullOrWhiteSpace($CleanDownloadVerification)) { $null } else { [IO.Path]::GetFullPath($CleanDownloadVerification) }
$independentRootPath = if ([string]::IsNullOrWhiteSpace($IndependentTrustedRoot)) { $null } else { [IO.Path]::GetFullPath($IndependentTrustedRoot) }
$registryPath = if ([string]::IsNullOrWhiteSpace($DeviceRegistry)) { $null } else { [IO.Path]::GetFullPath($DeviceRegistry) }
$metadataPath = if ([string]::IsNullOrWhiteSpace($RunMetadata)) { $null } else { [IO.Path]::GetFullPath($RunMetadata) }
$summaryPath = Join-Path $OutputRoot 'summary.json'
$rawPath = Join-Path $OutputRoot 'raw.jsonl'
$privacyPath = Join-Path $OutputRoot 'privacy-scan.json'
$finalSummaryPrivacyPath = Join-Path $OutputRoot 'final-summary-privacy-scan.json'
$requestedAcceptance = -not [bool]$DevelopmentSelfTest

# A formal PASS is deliberately unreachable until the runner consumes a
# cryptographically verifiable protected-job receipt, authenticates the
# product metrics writer, pins the approved publisher identity independently
# of candidate-controlled manifests, and protects the complete package and
# final evidence namespaces. DevelopmentSelfTest remains available to exercise
# the real product path, but can never set acceptance=true.
if ($requestedAcceptance) {
    throw 'FORMAL_PERF03_TRUST_CONTROLLER_NOT_IMPLEMENTED: protected-run provenance, authenticated metric transport, publisher policy, and complete namespace integrity are not yet independently verifiable.'
}

if (Test-Path -LiteralPath $OutputRoot) {
    throw 'OutputRoot already exists; PERF-03 evidence is append-never and requires a new directory.'
}
if (
    $OutputRoot.Equals($PackageDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($PackageDirectory + '\', [StringComparison]::OrdinalIgnoreCase)
) { throw 'OutputRoot must not be inside the bound package artifact.' }

$gitSha = (& git -C $repositoryRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch '^[a-f0-9]{40}$') {
    throw 'Unable to bind PERF-03 to a full Git SHA.'
}
$repositoryPrefix = $repositoryRoot.TrimEnd('\') + '\'
if ($OutputRoot.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputRoot cannot be the repository root.'
}
if ($OutputRoot.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $relativeOutput = $OutputRoot.Substring($repositoryPrefix.Length).Replace('\', '/')
    & git -C $repositoryRoot check-ignore --quiet -- $relativeOutput
    if ($LASTEXITCODE -ne 0) { throw 'An in-repository OutputRoot must be covered by the committed Git ignore policy.' }
}
foreach ($required in @($applicationExecutable, $hostExecutable, $appAsar)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw 'A required packaged application, Host, or ASAR artifact is missing.'
    }
}

$applicationSha256 = (Get-FileHash -LiteralPath $applicationExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$hostSha256 = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
$appAsarSha256 = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSha256 = $null
$manifestSha256 = $null
$formalMetadataEvidence = $null
$finalReleaseTrust = $null
$manifest = $null
$signedSubject = $null

if ($requestedAcceptance) {
    Assert-SourceIdentityStillCurrent -GitSha $gitSha
    if ($null -eq $manifestPath -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Formal PERF-03 requires -PackageEvidenceManifest.'
    }
    if ($null -eq $installerPathResolved -or -not (Test-Path -LiteralPath $installerPathResolved -PathType Leaf)) {
        throw 'Formal PERF-03 requires the exact signed -InstallerPath.'
    }
    if ($null -eq $registryPath) { throw 'Formal PERF-03 requires -DeviceRegistry.' }
    if ($null -eq $metadataPath) { throw 'Formal PERF-03 requires -RunMetadata.' }
    if ($null -eq $finalManifestPath -or $null -eq $cleanVerificationPath -or $null -eq $independentRootPath) {
        throw 'Formal PERF-03 requires -FinalReleaseManifest, -CleanDownloadVerification, and -IndependentTrustedRoot.'
    }
    if (
        -not [IO.Path]::GetFileName($manifestPath).Equals('evidence-manifest.json', [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName((Split-Path -Parent $manifestPath)).Equals('release', [StringComparison]::OrdinalIgnoreCase)
    ) { throw 'PackageEvidenceManifest must be the canonical release/evidence-manifest.json.' }
    $evidenceDirectory = Split-Path -Parent (Split-Path -Parent $manifestPath)
    $canonicalManifest = Join-Path $evidenceDirectory 'release\evidence-manifest.json'
    if (-not $canonicalManifest.Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'PackageEvidenceManifest canonical path binding failed.'
    }
    Assert-SignedPackageEvidence `
        -EvidenceDirectory $evidenceDirectory `
        -PackagePath $PackageDirectory `
        -SignedInstallerPath $installerPathResolved

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-FormalManifestCore -Manifest $manifest -GitSha $gitSha
    $signedArtifacts = @($manifest.signatures.artifacts)
    $applicationEvidence = @($signedArtifacts | Where-Object role -eq 'application')
    $hostEvidence = @($signedArtifacts | Where-Object role -eq 'nativeHost')
    $installerEvidence = @($signedArtifacts | Where-Object role -eq 'installer')
    $installerSha256 = (Get-FileHash -LiteralPath $installerPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $signedArtifacts.Count -ne 3 -or
        $applicationEvidence.Count -ne 1 -or $hostEvidence.Count -ne 1 -or $installerEvidence.Count -ne 1 -or
        [string]$applicationEvidence[0].name -ne 'desktop-translate.exe' -or
        [string]$hostEvidence[0].name -ne 'selection-host.exe' -or
        [string]$installerEvidence[0].name -ne [IO.Path]::GetFileName($installerPathResolved) -or
        [string]$applicationEvidence[0].sha256 -ne $applicationSha256 -or
        [string]$hostEvidence[0].sha256 -ne $hostSha256 -or
        [string]$installerEvidence[0].sha256 -ne $installerSha256 -or
        [int64]$applicationEvidence[0].size -ne (Get-Item -LiteralPath $applicationExecutable).Length -or
        [int64]$hostEvidence[0].size -ne (Get-Item -LiteralPath $hostExecutable).Length -or
        [int64]$installerEvidence[0].size -ne (Get-Item -LiteralPath $installerPathResolved).Length -or
        [string]$manifest.supplyChain.nativeHostSha256 -ne $hostSha256
    ) { throw 'Package evidence does not bind the exact signed application, Host, and installer set.' }
    $subjects = @($signedArtifacts | ForEach-Object { [string]$_.subject } | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    } | Sort-Object -Unique)
    if ($subjects.Count -ne 1) { throw 'Signed package evidence does not bind one Authenticode subject.' }
    $signedSubject = $subjects[0]
    foreach ($artifact in @($applicationExecutable, $hostExecutable, $installerPathResolved)) {
        $signature = Get-AuthenticodeSignature -LiteralPath $artifact
        if (
            [string]$signature.Status -ne 'Valid' -or
            $null -eq $signature.SignerCertificate -or
            [string]$signature.SignerCertificate.Subject -ne $signedSubject
        ) { throw 'An actual PERF-03 release artifact lacks the manifest-bound valid Authenticode identity.' }
    }
    $manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $finalReleaseTrust = Assert-FinalReleaseTrust `
        -FinalManifestPath $finalManifestPath `
        -CleanVerificationPath $cleanVerificationPath `
        -IndependentRootPath $independentRootPath `
        -EvidenceDirectory $evidenceDirectory `
        -DraftManifest $manifest `
        -DraftManifestSha256 $manifestSha256 `
        -GitSha $gitSha `
        -SignedSubject $signedSubject `
        -ApplicationPath $applicationExecutable `
        -HostPath $hostExecutable `
        -AsarPath $appAsar `
        -SignedInstallerPath $installerPathResolved
    $formalMetadataEvidence = Read-FormalRunMetadata -Path $metadataPath -LiveEnvironment (Get-LiveEnvironment) -RegistryPath $registryPath
}

$artifactIdentities = [Collections.Generic.List[object]]::new()
foreach ($path in @($applicationExecutable, $hostExecutable, $appAsar)) {
    $item = Get-Item -LiteralPath $path
    $artifactIdentities.Add([pscustomobject]@{
        Path = $item.FullName
        Length = [int64]$item.Length
        LastWriteTimeUtcTicks = $item.LastWriteTimeUtc.Ticks
        Sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    })
}
if ($requestedAcceptance) {
    foreach ($path in @(
        $installerPathResolved, $manifestPath, $finalManifestPath,
        $cleanVerificationPath, $independentRootPath,
        $finalReleaseTrust.ArtifactBundlePath, $finalReleaseTrust.ManifestBundlePath,
        $finalReleaseTrust.EvidenceTrustedRootPath,
        $registryPath, $metadataPath
    )) {
        $item = Get-Item -LiteralPath $path
        $artifactIdentities.Add([pscustomobject]@{
            Path = $item.FullName
            Length = [int64]$item.Length
            LastWriteTimeUtcTicks = $item.LastWriteTimeUtc.Ticks
            Sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        })
    }
}

$candidatePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$candidatePaths.Add($applicationExecutable) | Out-Null
$candidatePaths.Add($hostExecutable) | Out-Null
$ownerStream = $null
$rawStream = $null
$artifactLeaseSet = $null
$outputStagingRoot = $null
$outputClaimed = $false
try {
    Assert-NoPackageResidual -CandidatePaths $candidatePaths

    # Claim the append-never evidence namespace atomically. The preliminary
    # Test-Path above is only an early diagnostic; Directory.Move is the
    # authoritative exclusive operation and fails if a racer created target.
    $outputParent = Split-Path -Parent $OutputRoot
    if ([string]::IsNullOrWhiteSpace($outputParent)) {
        throw 'PERF-03 OutputRoot must have a parent directory.'
    }
    [IO.Directory]::CreateDirectory($outputParent) | Out-Null
    $outputStagingRoot = Join-Path $outputParent ('.phase5-perf03-staging-' + [guid]::NewGuid().ToString('N'))
    New-Item -Path $outputStagingRoot -ItemType Directory -ErrorAction Stop | Out-Null
    [IO.Directory]::Move($outputStagingRoot, $OutputRoot)
    $outputClaimed = $true

    # CreateNew makes any unexpected namespace occupant fail closed. These
    # handles remain open until the entire runner exits, allow privacy scanners
    # to read, and deny every competing writer or deleter.
    $ownerStream = [IO.File]::Open(
        (Join-Path $OutputRoot 'owner.lock'),
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::Read
    )
    $rawStream = [IO.File]::Open(
        $rawPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::Read
    )

    # Every package, manifest, attestation, trusted-root, registry, and run-
    # metadata artifact is read-leased for the run. Rehashing happens only
    # after the complete lease set is acquired.
    $artifactLeaseSet = Open-ArtifactReadLeases -Expected @($artifactIdentities)

$evidenceLevel = if ($requestedAcceptance) { 'fixed-lab-benchmark' } else { 'development-selftest' }
$buildMode = if ($requestedAcceptance) { 'signed-rc' } else { 'packaged-unsigned' }
$runEvidence = if ($requestedAcceptance) {
    [ordered]@{
        runId = [string]$formalMetadataEvidence.Metadata.run.runId
        workflowName = 'phase5-perf03-host-ready'
        workflowRunId = [string]$formalMetadataEvidence.Metadata.run.workflowRunId
        operatorRole = [string]$formalMetadataEvidence.Metadata.run.operatorRole
        deviceRegistrationId = [string]$formalMetadataEvidence.Metadata.run.deviceRegistrationId
        runMetadataSha256 = $formalMetadataEvidence.MetadataSha256
        deviceRegistrySha256 = $formalMetadataEvidence.RegistrySha256
        deviceRegistrySchemaVersion = $formalMetadataEvidence.RegistrySchemaVersion
        dedicatedInteractiveSession = $true
        foregroundInputExclusive = $true
        debuggerClosed = $true
        unrelatedForegroundTasksClosed = $true
    }
} else {
    [ordered]@{
        runId = 'development-' + [guid]::NewGuid().ToString('N')
        workflowName = 'phase5-perf03-host-ready'
        workflowRunId = 'local-development'
        operatorRole = 'Engineering'
        deviceRegistrationId = 'unregistered-development-device'
        runMetadataSha256 = $null
        deviceRegistrySha256 = $null
        deviceRegistrySchemaVersion = $null
        dedicatedInteractiveSession = $false
        foregroundInputExclusive = $false
        debuggerClosed = $false
        unrelatedForegroundTasksClosed = $false
    }
}

$summary = [ordered]@{
    schemaVersion = 'phase5-perf03-summary-v1'
    metricId = 'PERF-03'
    scenario = 'main-starts-real-host-to-authenticated-pipe-ready'
    status = 'RUNNING'
    acceptance = $false
    evidenceLevel = $evidenceLevel
    buildMode = $buildMode
    configuredRoundCount = $RoundCount
    configuredSamplesPerRound = $SamplesPerRound
    statisticsMethod = 'nearest-rank'
    thresholds = [ordered]@{
        p50Ms = $script:P50ThresholdMs
        p95Ms = $script:P95ThresholdMs
        failureCount = 0
    }
    gitSha = $gitSha
    artifact = [ordered]@{
        applicationSha256 = $applicationSha256
        hostSha256 = $hostSha256
        asarSha256 = $appAsarSha256
        installerSha256 = $installerSha256
        packageEvidenceManifestSha256 = $manifestSha256
        finalReleaseManifestSha256 = if ($requestedAcceptance) { $finalReleaseTrust.FinalManifestSha256 } else { $null }
        cleanDownloadVerificationSha256 = if ($requestedAcceptance) { $finalReleaseTrust.CleanVerificationSha256 } else { $null }
        independentTrustedRootSha256 = if ($requestedAcceptance) { $finalReleaseTrust.IndependentRootSha256 } else { $null }
        acceptanceEligibleManifestBound = $requestedAcceptance
        signedReleaseIdentityBound = $requestedAcceptance
        attestedFinalReleaseBound = $requestedAcceptance
        independentCleanDownloadBound = $requestedAcceptance
        authenticodeSubjectSha256 = if ($requestedAcceptance) {
            $subjectBytes = [Text.Encoding]::UTF8.GetBytes([string]$signedSubject)
            $subjectHasher = [Security.Cryptography.SHA256]::Create()
            try { ([BitConverter]::ToString($subjectHasher.ComputeHash($subjectBytes))).Replace('-', '').ToLowerInvariant() } finally { $subjectHasher.Dispose() }
        } else { $null }
    }
    run = $runEvidence
    rounds = @()
    totalFailureCount = 0
    forcedTerminationCount = 0
    gates = [ordered]@{
        sourceAndArtifactIdentity = if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_ONLY' }
        fixedDeviceMetadata = if ($requestedAcceptance) { 'PASS' } else { 'NOT_REQUIRED_DEVELOPMENT_SELFTEST' }
        preflightResidual = 'PASS'
        threeIndependentRounds = 'PENDING'
        forcedTerminationZero = 'PENDING'
        postflightResidual = 'PENDING'
        evidencePrivacy = 'PENDING'
    }
    stableFailureCodes = @()
    completedAt = $null
    limitations = [string[]]$(if ($requestedAcceptance) {
        @('This is only PERF-03 fixed-lab evidence; it does not make any claim about PERF-01/02/04-09 or complete Phase 5 acceptance.')
    } else {
        @('Explicit reduced development smoke; this result can never be acceptance evidence.', 'This runner measures PERF-03 only and makes no claim about PERF-01/02/04-09.')
    })
}
Write-AtomicJson -Path $summaryPath -Value $summary

$fatalFailure = $null
try {
    for ($round = 1; $round -le $RoundCount; $round += 1) {
        Assert-FullArtifactIdentity -Expected @($artifactIdentities)
        Assert-NoPackageResidual -CandidatePaths $candidatePaths
        if ($requestedAcceptance) {
            Assert-SourceIdentityStillCurrent -GitSha $gitSha
            Assert-SignedPackageEvidence -EvidenceDirectory $evidenceDirectory -PackagePath $PackageDirectory -SignedInstallerPath $installerPathResolved
            $currentMetadata = Read-FormalRunMetadata -Path $metadataPath -LiveEnvironment (Get-LiveEnvironment) -RegistryPath $registryPath
            if (
                [string]$currentMetadata.MetadataSha256 -ne [string]$formalMetadataEvidence.MetadataSha256 -or
                [string]$currentMetadata.RegistrySha256 -ne [string]$formalMetadataEvidence.RegistrySha256
            ) { throw 'The PERF-03 fixed-device registry or run metadata changed during the run.' }
        }

        $roundStartedAt = [DateTimeOffset]::UtcNow
        $roundRunId = [guid]::NewGuid().ToString('N')
        $roundDurations = [Collections.Generic.List[double]]::new()
        $roundFailureCodes = [Collections.Generic.List[string]]::new()
        $roundForcedTerminationCount = 0

        for ($sample = 1; $sample -le $SamplesPerRound; $sample += 1) {
            $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-perf03-' + [guid]::NewGuid().ToString('N'))
            $nonAsciiSuffix = -join @([char]0x9636, [char]0x6BB5, [char]0x4E94, '-', [char]0x542F, [char]0x52A8)
            $userData = Join-Path $temporaryRoot ('User Data ' + $nonAsciiSuffix)
            $runtimeRunId = [guid]::NewGuid().ToString()
            $runtimeRaw = Join-Path $userData "phase5-evidence\perf\$runtimeRunId\raw.jsonl"
            $rootProcess = $null
            $rootProcessId = 0
            $rootCreationTimeUtc = $null
            $runtimeRecord = $null
            $durationMs = 0.0
            $sampleStatus = 'FAIL'
            $stableErrorCode = 'UNHANDLED_SAMPLE_FAILURE'
            $stage = 'ARTIFACT_IDENTITY_CHANGED'
            $sampleEvidenceWritten = $false
            $cleanupRequired = $false
            $cleanupFailed = $false
            try {
                Assert-QuickArtifactIdentity -Expected @($artifactIdentities)
                [IO.Directory]::CreateDirectory($userData) | Out-Null
                $stage = 'PRODUCT_STARTUP_FAILED'
                $rootProcess = Start-BoundProductSample `
                    -ApplicationPath $applicationExecutable `
                    -WorkingDirectory $PackageDirectory `
                    -UserDataDirectory $userData `
                    -RunId $runtimeRunId `
                    -GitSha $gitSha `
                    -BinarySha256 $appAsarSha256 `
                    -BuildMode $buildMode
                $rootProcessId = $rootProcess.Id
                $rootCreationTimeUtc = $rootProcess.StartTime.ToUniversalTime()

                $stage = 'PERF03_EVIDENCE_FAILED'
                $runtimeRecord = Wait-RuntimePerf03Record `
                    -RuntimeRawPath $runtimeRaw `
                    -RootProcess $rootProcess `
                    -GitSha $gitSha `
                    -BinarySha256 $appAsarSha256 `
                    -BuildMode $buildMode `
                    -TimeoutSeconds $StartupTimeoutSeconds
                $durationMs = [double]$runtimeRecord.value
                if ([string]$runtimeRecord.status -ne 'success') {
                    $stableErrorCode = 'HOST_NOT_READY'
                    throw 'The real Host-ready emitter reported failure.'
                }

                # PERF-03 stops at authenticated Host readiness.  The Ball
                # renderer can become visible before React has attached its
                # custom context-menu handler, so allow that unmeasured UI
                # surface to settle before exercising the product exit path.
                Start-Sleep -Milliseconds 750
                $stage = 'PRODUCT_UI_EXIT_FAILED'
                $exitCode = Request-GracefulExitThroughProductUi `
                    -RootProcess $rootProcess `
                    -RootProcessId $rootProcessId `
                    -RootCreationTimeUtc $rootCreationTimeUtc `
                    -ExpectedApplicationPath $applicationExecutable `
                    -TimeoutSeconds $ExitTimeoutSeconds
                if ($exitCode -ne 0) {
                    $stage = 'ROOT_EXIT_NONZERO'
                    throw 'The product returned a nonzero exit code after its real UI exit command.'
                }
                Start-Sleep -Milliseconds 100
                if (@(Get-PackageResidualProcesses -CandidatePaths $candidatePaths).Count -ne 0) {
                    $stage = 'POST_SAMPLE_RESIDUAL'
                    throw 'A bound package process remained after the normal product exit.'
                }
                $sampleStatus = 'PASS'
                $stableErrorCode = $null
            } catch {
                if ($DevelopmentSelfTest) {
                    Write-Host "[phase5:perf03:dev] sample stage=$stage reason=$($_.Exception.Message)"
                }
                if ($stableErrorCode -eq 'UNHANDLED_SAMPLE_FAILURE') {
                    if ($stage -eq 'PERF03_EVIDENCE_FAILED') {
                        $runtimeDirectory = Split-Path -Parent $runtimeRaw
                        $stableErrorCode = if (-not (Test-Path -LiteralPath $runtimeDirectory -PathType Container)) {
                            'PERF03_RUNTIME_METRICS_NOT_ENABLED'
                        } elseif (-not (Test-Path -LiteralPath $runtimeRaw -PathType Leaf)) {
                            'PERF03_RUNTIME_RECORD_MISSING'
                        } else {
                            'PERF03_RUNTIME_RECORD_INVALID'
                        }
                    } else {
                        $stableErrorCode = Get-SampleFailureCode -Stage $stage
                    }
                }
            }

            # A failed sample is committed before any forced termination. A
            # cleanup API can restore the lab, but can never promote PERF-03.
            $sampleRecord = New-SampleRecord `
                -Round $round `
                -Sample $sample `
                -DurationMs $durationMs `
                -Status $sampleStatus `
                -StableErrorCode $stableErrorCode `
                -EvidenceLevel $evidenceLevel `
                -BuildMode $buildMode
            try {
                Add-RawSample -Stream $rawStream -Record $sampleRecord
                $sampleEvidenceWritten = $true
            } catch {
                $cleanupFailed = $true
            }

            try {
                if ($rootProcessId -gt 0 -and $null -ne $rootCreationTimeUtc) {
                    $owned = @(Get-ExactOwnedRunProcesses `
                        -RootProcessId $rootProcessId `
                        -RootCreationTimeUtc $rootCreationTimeUtc `
                        -ExpectedApplicationPath $applicationExecutable `
                        -ExpectedHostPath $hostExecutable `
                        -ExpectedUserDataPath $userData)
                    $cleanupRequired = $owned.Count -gt 0
                }
                if ($cleanupRequired) {
                    $roundForcedTerminationCount += 1
                    $summary.forcedTerminationCount = [int]$summary.forcedTerminationCount + 1
                    Stop-ExactOwnedRunProcessTree `
                        -RootProcessId $rootProcessId `
                        -RootCreationTimeUtc $rootCreationTimeUtc `
                        -ExpectedApplicationPath $applicationExecutable `
                        -ExpectedHostPath $hostExecutable `
                        -ExpectedUserDataPath $userData
                }
                Assert-NoPackageResidual -CandidatePaths $candidatePaths
            } catch {
                $cleanupFailed = $true
            } finally {
                if ($null -ne $rootProcess) {
                    try { $rootProcess.Dispose() } catch { $cleanupFailed = $true }
                }
                try { Remove-IsolatedRunRoot -Path $temporaryRoot } catch { $cleanupFailed = $true }
            }

            if ($sampleStatus -eq 'PASS') {
                $roundDurations.Add($durationMs)
            } else {
                $roundFailureCodes.Add([string]$stableErrorCode)
                $summary.totalFailureCount = [int]$summary.totalFailureCount + 1
            }
            Write-AtomicJson -Path $summaryPath -Value $summary
            if (-not $sampleEvidenceWritten -or $cleanupFailed) {
                throw 'A PERF-03 sample evidence write or exact cleanup failed.'
            }
        }

        $p50Raw = if ($roundDurations.Count -eq 0) { $null } else { Get-NearestRank -Values @($roundDurations) -Percentile 0.50 }
        $p95Raw = if ($roundDurations.Count -eq 0) { $null } else { Get-NearestRank -Values @($roundDurations) -Percentile 0.95 }
        $maxRaw = if ($roundDurations.Count -eq 0) { $null } else { [double](($roundDurations | Measure-Object -Maximum).Maximum) }
        $roundSummary = [ordered]@{
            round = $round
            roundRunId = $roundRunId
            startedAt = $roundStartedAt.ToString('o')
            completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            configuredSampleCount = $SamplesPerRound
            successCount = $roundDurations.Count
            failureCount = $roundFailureCodes.Count
            p50Ms = if ($null -eq $p50Raw) { $null } else { [Math]::Round([double]$p50Raw, 3) }
            p95Ms = if ($null -eq $p95Raw) { $null } else { [Math]::Round([double]$p95Raw, 3) }
            maxMs = if ($null -eq $maxRaw) { $null } else { [Math]::Round([double]$maxRaw, 3) }
            forcedTerminationCount = $roundForcedTerminationCount
            status = 'FAIL'
            stableFailureCodes = [string[]]@($roundFailureCodes | Sort-Object -Unique)
        }
        $thresholdRound = [pscustomobject]@{
            failureCount = $roundFailureCodes.Count
            successCount = $roundDurations.Count
            p50Ms = $p50Raw
            p95Ms = $p95Raw
        }
        if (Test-Perf03RoundPass -RoundSummary $thresholdRound -ExpectedSampleCount $SamplesPerRound) {
            $roundSummary.status = 'PASS'
        } elseif ($roundSummary.failureCount -eq 0) {
            $roundSummary.stableFailureCodes = @('PERF03_THRESHOLD_EXCEEDED')
        }
        $summary.rounds = @($summary.rounds) + @($roundSummary)
        Assert-FullArtifactIdentity -Expected @($artifactIdentities)
        Assert-NoPackageResidual -CandidatePaths $candidatePaths
        if ($requestedAcceptance) {
            Assert-SignedPackageEvidence -EvidenceDirectory $evidenceDirectory -PackagePath $PackageDirectory -SignedInstallerPath $installerPathResolved
        }
        Write-AtomicJson -Path $summaryPath -Value $summary
    }
} catch {
    $fatalFailure = 'PERF03_RUN_ABORTED'
}

$allRoundsPass = $null -eq $fatalFailure -and
    $summary.rounds.Count -eq $RoundCount -and
    @($summary.rounds | Where-Object status -ne 'PASS').Count -eq 0
$summary.gates.threeIndependentRounds = if ($allRoundsPass) {
    if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE' }
} else { 'FAIL' }
$summary.gates.forcedTerminationZero = if ([int]$summary.forcedTerminationCount -eq 0) { 'PASS' } else { 'FAIL' }
try {
    Assert-NoPackageResidual -CandidatePaths $candidatePaths
    $summary.gates.postflightResidual = 'PASS'
} catch {
    $summary.gates.postflightResidual = 'FAIL'
    if ($null -eq $fatalFailure) { $fatalFailure = 'POSTFLIGHT_PACKAGE_RESIDUAL' }
}

$stableFailures = [Collections.Generic.List[string]]::new()
foreach ($roundSummary in @($summary.rounds)) {
    foreach ($code in @($roundSummary.stableFailureCodes)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$code)) { $stableFailures.Add([string]$code) }
    }
}
if ($null -ne $fatalFailure) { $stableFailures.Add($fatalFailure) }
if ([int]$summary.forcedTerminationCount -ne 0) { $stableFailures.Add('FORCED_TERMINATION_USED') }
$summary.stableFailureCodes = [string[]]@($stableFailures | Sort-Object -Unique)

$candidatePass = $allRoundsPass -and
    [int]$summary.forcedTerminationCount -eq 0 -and
    $summary.gates.postflightResidual -eq 'PASS'
$candidateStatus = if ($candidatePass) {
    if ($requestedAcceptance) { 'PASS' } else { 'DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE' }
} else { 'FAIL' }
$candidateAcceptance = $requestedAcceptance -and $candidatePass

# PERF03_FINAL_PUBLISH_SEQUENCE_BEGIN
# Keep the canonical summary fail-closed at FINALIZING throughout every scan.
# An interruption anywhere before File.Replace therefore cannot expose PASS or
# acceptance=true under the evidence root.
$summary.status = 'FINALIZING'
$summary.acceptance = $false
$summary.completedAt = $null
Write-AtomicJson -Path $summaryPath -Value $summary

$finalSummaryCandidateRoot = $null
try {
    # Scan all evidence generated so far while canonical summary.json is still
    # FINALIZING. The exact final summary is prepared separately below.
    Invoke-EvidencePrivacyScan -Root $OutputRoot -Output $privacyPath

    $summary.gates.evidencePrivacy = 'PASS'
    $summary.status = $candidateStatus
    $summary.acceptance = $candidateAcceptance
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')

    # The candidate must be outside OutputRoot so it can never be collected as
    # canonical evidence after an interrupted run, but it must share the same
    # volume so File.Replace remains an atomic publication boundary.
    $outputParent = Split-Path -Parent $OutputRoot
    if ([string]::IsNullOrWhiteSpace($outputParent)) {
        throw 'PERF-03 cannot create an external same-volume final-summary candidate.'
    }
    $finalSummaryCandidateRoot = [IO.Path]::GetFullPath((
        Join-Path $outputParent ('.phase5-perf03-final-summary-' + [guid]::NewGuid().ToString('N'))
    )).TrimEnd('\')
    if (
        $finalSummaryCandidateRoot.Equals($OutputRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $finalSummaryCandidateRoot.StartsWith($OutputRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    ) { throw 'PERF-03 final-summary candidate must be outside the evidence root.' }
    if (-not [IO.Path]::GetPathRoot($finalSummaryCandidateRoot).Equals(
        [IO.Path]::GetPathRoot($summaryPath),
        [StringComparison]::OrdinalIgnoreCase
    )) { throw 'PERF-03 final-summary candidate must be on the evidence volume.' }
    [IO.Directory]::CreateDirectory($finalSummaryCandidateRoot) | Out-Null
    $finalSummaryCandidatePath = Join-Path $finalSummaryCandidateRoot 'summary.json'
    $finalSummaryBackupPath = Join-Path $finalSummaryCandidateRoot 'summary.finalizing.backup.json'
    $finalSummaryJson = ($summary | ConvertTo-Json -Depth 12) + [Environment]::NewLine
    $finalSummaryBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($finalSummaryJson)
    $candidateStream = [IO.File]::Open(
        $finalSummaryCandidatePath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $candidateStream.Write($finalSummaryBytes, 0, $finalSummaryBytes.Length)
        $candidateStream.Flush($true)
    } finally {
        $candidateStream.Dispose()
    }

    # Scan the exact candidate bytes, then rescan the complete evidence root so
    # the candidate scan report is itself covered before publication.
    Invoke-EvidencePrivacyScan -Root $finalSummaryCandidateRoot -Output $finalSummaryPrivacyPath
    Invoke-EvidencePrivacyScan -Root $OutputRoot -Output $privacyPath

    # PERF03_FINAL_RECHECK_BEGIN
    # This is the last trust decision before publication. No canonical
    # evidence may be mutated between these exact-set/identity checks and the
    # atomic File.Replace below.
    $rawStream.Flush($true)
    Assert-ExactRawEvidence `
        -Stream $rawStream `
        -ExpectedRoundCount $RoundCount `
        -ExpectedSamplesPerRound $SamplesPerRound `
        -ExpectedEvidenceLevel $evidenceLevel `
        -ExpectedBuildMode $buildMode
    Assert-ExactEvidenceFileSet -Root $OutputRoot -ExpectedFileNames @(
        'owner.lock',
        'raw.jsonl',
        'summary.json',
        'privacy-scan.json',
        'final-summary-privacy-scan.json'
    )
    if ($requestedAcceptance) {
        Assert-SourceIdentityStillCurrent -GitSha $gitSha
        Assert-SignedPackageEvidence `
            -EvidenceDirectory $evidenceDirectory `
            -PackagePath $PackageDirectory `
            -SignedInstallerPath $installerPathResolved
    }
    Assert-FullArtifactIdentity -Expected @($artifactIdentities)
    # PERF03_FINAL_RECHECK_END

    # This atomic, same-volume replacement is intentionally the final operation
    # in the successful publication path. Nothing under OutputRoot is mutated
    # after PASS/acceptance=true becomes canonical.
    [IO.File]::Replace($finalSummaryCandidatePath, $summaryPath, $finalSummaryBackupPath)
# PERF03_FINAL_PUBLISH_SEQUENCE_END
} catch {
    if ($DevelopmentSelfTest) {
        Write-Host "[phase5:perf03:dev] finalization reason=$($_.Exception.Message)"
    }
    $summary.gates.evidencePrivacy = 'FAIL'
    $summary.status = 'FAIL'
    $summary.acceptance = $false
    $summary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $summary.stableFailureCodes = [string[]]@(
        $summary.stableFailureCodes + @('EVIDENCE_PRIVACY_FAILED') | Sort-Object -Unique
    )
    Write-AtomicJson -Path $summaryPath -Value $summary
} finally {
    # Cleanup is deliberately limited to the external candidate directory and
    # cannot mutate the already-published evidence root.
    if ($null -ne $finalSummaryCandidateRoot -and (Test-Path -LiteralPath $finalSummaryCandidateRoot -PathType Container)) {
        try { [IO.Directory]::Delete($finalSummaryCandidateRoot, $true) } catch {}
    }
}

if ($summary.status -eq 'FAIL') {
    throw 'PERF-03 failed; inspect the stable, redacted evidence codes.'
}
Write-Host "[phase5:perf03] $($summary.status): $RoundCount round(s), $SamplesPerRound real Host-ready sample(s) per round."
} finally {
    if ($null -ne $artifactLeaseSet) {
        foreach ($stream in @($artifactLeaseSet.Streams)) {
            try { $stream.Dispose() } catch {}
        }
    }
    if ($null -ne $rawStream) {
        try { $rawStream.Dispose() } catch {}
    }
    if ($null -ne $ownerStream) {
        try { $ownerStream.Dispose() } catch {}
    }
    if (
        -not $outputClaimed -and
        $null -ne $outputStagingRoot -and
        (Test-Path -LiteralPath $outputStagingRoot -PathType Container)
    ) {
        try { [IO.Directory]::Delete($outputStagingRoot, $true) } catch {}
    }
}

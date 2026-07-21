[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter()][ValidateRange(1, 86400)][int]$DurationSeconds = 2,
    [Parameter()][ValidateRange(1, 300)][int]$SampleIntervalSeconds = 1,
    [Parameter()][ValidateSet('Smoke', 'Idle', 'Soak')][string]$Profile = 'Smoke',
    [Parameter()][string]$RootExecutablePath,
    [Parameter()][string]$RootExecutableSha256,
    [Parameter()][string]$HostExecutablePath,
    [Parameter()][switch]$Acceptance
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Convert-CreationTimeToTicks {
    param([Parameter()]$Value)
    if ($null -eq $Value) { return $null }
    try {
        $date = if ($Value -is [DateTime]) {
            [DateTime]$Value
        } else {
            [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)
        }
        return [int64]$date.ToUniversalTime().Ticks
    } catch {
        return $null
    }
}

if ($Acceptance) {
    if ($SampleIntervalSeconds -ne 5) {
        throw 'Acceptance resource sampling requires the frozen 5-second interval.'
    }
    if ($Profile -eq 'Idle' -and $DurationSeconds -lt 900) {
        throw 'Idle acceptance requires at least 900 measured seconds; any warmup must finish before this sampling window starts.'
    }
    if ($Profile -eq 'Soak' -and $DurationSeconds -lt 28800) {
        throw 'Soak acceptance requires at least 28800 seconds.'
    }
    if ($Profile -eq 'Smoke') {
        throw 'Smoke resource sampling can never be acceptance evidence.'
    }
    if ([string]::IsNullOrWhiteSpace($RootExecutablePath)) {
        throw 'Acceptance resource sampling requires -RootExecutablePath.'
    }
    if ($RootExecutableSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Acceptance resource sampling requires a 64-character -RootExecutableSha256.'
    }
}

$resolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
[System.IO.Directory]::CreateDirectory($resolvedOutputRoot) | Out-Null
$rawPath = Join-Path $resolvedOutputRoot 'raw.csv'
$summaryPath = Join-Path $resolvedOutputRoot 'summary.json'

$initialRoot = Get-CimInstance -Query "SELECT ProcessId, ExecutablePath, CreationDate FROM Win32_Process WHERE ProcessId = $RootProcessId" |
    Select-Object -First 1
if ($null -eq $initialRoot) {
    throw 'The requested root process does not exist at sampler startup.'
}

$initialRootCreationTicks = Convert-CreationTimeToTicks -Value $initialRoot.CreationDate
if ($null -eq $initialRootCreationTicks) {
    throw 'The requested root process has no verifiable creation time.'
}
if ([string]::IsNullOrWhiteSpace([string]$initialRoot.ExecutablePath)) {
    throw 'The requested root process has no verifiable executable path.'
}
$observedRootExecutablePath = Resolve-NormalizedPath -Path ([string]$initialRoot.ExecutablePath)
$expectedRootExecutablePath = if ([string]::IsNullOrWhiteSpace($RootExecutablePath)) {
    $observedRootExecutablePath
} else {
    Resolve-NormalizedPath -Path $RootExecutablePath
}
if (-not $observedRootExecutablePath.Equals($expectedRootExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The root PID executable path does not match -RootExecutablePath.'
}
if (-not (Test-Path -LiteralPath $expectedRootExecutablePath -PathType Leaf)) {
    throw 'The bound root executable does not exist.'
}

$observedRootSha256 = (Get-FileHash -LiteralPath $expectedRootExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedRootSha256 = if ([string]::IsNullOrWhiteSpace($RootExecutableSha256)) {
    $observedRootSha256
} else {
    $RootExecutableSha256.ToLowerInvariant()
}
if (-not $observedRootSha256.Equals($expectedRootSha256, [System.StringComparison]::Ordinal)) {
    throw 'The root executable SHA-256 does not match -RootExecutableSha256.'
}

$expectedHostExecutablePath = if ([string]::IsNullOrWhiteSpace($HostExecutablePath)) {
    Resolve-NormalizedPath -Path (Join-Path (Split-Path -Parent $expectedRootExecutablePath) 'resources\selection-host\selection-host.exe')
} else {
    Resolve-NormalizedPath -Path $HostExecutablePath
}
if ($Acceptance -and -not (Test-Path -LiteralPath $expectedHostExecutablePath -PathType Leaf)) {
    throw 'Acceptance resource sampling requires the packaged Host at its bound path.'
}

if (-not ('Phase5ResourceNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Phase5ResourceNative {
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern void SetLastError(uint errorCode);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool QueryWorkingSet(IntPtr process, IntPtr buffer, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetGuiResources(IntPtr process, uint flags);

    public static long? PrivateWorkingSetBytes(int processId) {
        IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, processId);
        if (process == IntPtr.Zero) return null;
        try {
            int size = 1024 * 1024;
            while (size <= 256 * 1024 * 1024) {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try {
                    if (!QueryWorkingSet(process, buffer, size)) {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 24 || error == 122) { size *= 2; continue; }
                        return null;
                    }
                    ulong count = IntPtr.Size == 8
                        ? unchecked((ulong)Marshal.ReadInt64(buffer))
                        : unchecked((uint)Marshal.ReadInt32(buffer));
                    long capacity = (size - IntPtr.Size) / IntPtr.Size;
                    if (count > (ulong)capacity) { size *= 2; continue; }
                    long privatePages = 0;
                    for (ulong index = 0; index < count; index++) {
                        int offset = checked(IntPtr.Size + (int)(index * (ulong)IntPtr.Size));
                        ulong flags = IntPtr.Size == 8
                            ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                            : unchecked((uint)Marshal.ReadInt32(buffer, offset));
                        bool shared = ((flags >> 8) & 1UL) != 0;
                        if (!shared) privatePages++;
                    }
                    return checked(privatePages * Environment.SystemPageSize);
                } finally {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            return null;
        } finally {
            CloseHandle(process);
        }
    }

    public static long? GuiResourceCount(int processId, uint flags) {
        IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try {
            SetLastError(0);
            uint value = GetGuiResources(process, flags);
            int error = Marshal.GetLastWin32Error();
            // Zero is a valid count for a non-GUI utility process.  A nonzero
            // last-error value is the fail-closed distinction for API failure.
            if (value == 0 && error != 0) return null;
            return (long)value;
        } finally {
            CloseHandle(process);
        }
    }
}
'@
}

function Get-ProcessSnapshot {
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate FROM Win32_Process')) {
        $creationTicks = Convert-CreationTimeToTicks -Value $candidate.CreationDate
        $path = if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) {
            $null
        } else {
            try { Resolve-NormalizedPath -Path ([string]$candidate.ExecutablePath) } catch { $null }
        }
        $records.Add([pscustomobject]@{
            ProcessId = [int]$candidate.ProcessId
            ParentProcessId = [int]$candidate.ParentProcessId
            Name = [string]$candidate.Name
            ExecutablePath = $path
            CommandLine = [string]$candidate.CommandLine
            CreationTicks = $creationTicks
        })
    }
    return @($records)
}

function Get-ProcessTreeSnapshot {
    param([Parameter(Mandatory = $true)][object[]]$AllProcesses)

    $root = $AllProcesses | Where-Object {
        $_.ProcessId -eq $RootProcessId -and
        $null -ne $_.CreationTicks -and
        [int64]$_.CreationTicks -eq [int64]$initialRootCreationTicks -and
        $null -ne $_.ExecutablePath -and
        $_.ExecutablePath.Equals($expectedRootExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($null -eq $root) {
        return [pscustomobject]@{ RootMatched = $false; Processes = @() }
    }

    $known = @{}
    $known[$RootProcessId] = $root
    do {
        $added = $false
        foreach ($candidate in $AllProcesses) {
            if ($known.ContainsKey([int]$candidate.ProcessId)) { continue }
            $parentId = [int]$candidate.ParentProcessId
            if (-not $known.ContainsKey($parentId)) { continue }
            $parent = $known[$parentId]
            if ($null -eq $candidate.CreationTicks -or $null -eq $parent.CreationTicks) { continue }
            if ([int64]$candidate.CreationTicks -lt [int64]$parent.CreationTicks) { continue }
            $known[[int]$candidate.ProcessId] = $candidate
            $added = $true
        }
    } while ($added)

    return [pscustomobject]@{ RootMatched = $true; Processes = @($known.Values) }
}

function Get-StableRole {
    param([Parameter(Mandatory = $true)]$Entry)

    if ([int]$Entry.ProcessId -eq $RootProcessId) { return 'main' }
    if ($null -ne $Entry.ExecutablePath -and
        $Entry.ExecutablePath.Equals($expectedHostExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return 'host'
    }
    if ($null -ne $Entry.ExecutablePath -and
        $Entry.ExecutablePath.Equals($expectedRootExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        switch -Regex ([string]$Entry.CommandLine) {
            '(?:^|\s)--type=renderer(?:\s|$)' { return 'app' }
            '(?:^|\s)--type=gpu-process(?:\s|$)' { return 'electron-gpu' }
            '(?:^|\s)--type=utility(?:\s|$)' { return 'electron-utility' }
            default { return 'electron-child' }
        }
    }
    switch -Regex ($Entry.Name.ToLowerInvariant()) {
        '^(?:chrome_)?crashpad_handler\.exe$' { return 'crashpad' }
        '^node\.exe$' { return 'node-child' }
        default { return 'other-child' }
    }
}

function Get-NearestRank {
    param(
        [Parameter(Mandatory = $true)][double[]]$Values,
        [Parameter(Mandatory = $true)][ValidateRange(0.01, 1.0)][double]$Percentile
    )
    if ($Values.Count -eq 0) { return 0.0 }
    $sorted = @($Values | Sort-Object)
    $rank = [Math]::Ceiling($Percentile * $sorted.Count)
    return [double]$sorted[[Math]::Max(0, $rank - 1)]
}

$logicalProcessorCount = [Math]::Max(1, [Environment]::ProcessorCount)
$startedAt = [System.Diagnostics.Stopwatch]::StartNew()
$rows = [System.Collections.Generic.List[object]]::new()
$previousCpuSeconds = @{}
$generationByIdentity = @{}
$nextGenerationByRole = @{}
$observedRoles = @{}
$metricObservedRoles = @{}
$metricCollectionFailures = [System.Collections.Generic.List[string]]::new()
$identityCollectionFailures = [System.Collections.Generic.List[string]]::new()
$sampleStartElapsedMilliseconds = [System.Collections.Generic.List[int64]]::new()
$sampleIndex = 0
$rootObserved = $false
$rootMissingAfterObservation = $false
$previousSampleStarted = $null

while ($startedAt.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $sampleStarted = $startedAt.Elapsed.TotalSeconds
    $sampleStartElapsedMilliseconds.Add([int64][Math]::Round($sampleStarted * 1000))
    $snapshot = Get-ProcessTreeSnapshot -AllProcesses @(Get-ProcessSnapshot)
    if ($snapshot.RootMatched) {
        $rootObserved = $true
    } elseif ($rootObserved) {
        $rootMissingAfterObservation = $true
    }

    foreach ($entry in @($snapshot.Processes)) {
        $role = Get-StableRole -Entry $entry
        $observedRoles[$role] = $true
        if ($null -eq $entry.CreationTicks -or $null -eq $entry.ExecutablePath) {
            $identityCollectionFailures.Add('PROCESS_IDENTITY_FIELD_MISSING')
            continue
        }

        $identityKey = "$($entry.ProcessId):$($entry.CreationTicks)"
        if (-not $generationByIdentity.ContainsKey($identityKey)) {
            $next = if ($nextGenerationByRole.ContainsKey($role)) { [int]$nextGenerationByRole[$role] + 1 } else { 1 }
            $nextGenerationByRole[$role] = $next
            $generationByIdentity[$identityKey] = $next
        }

        try {
            $process = Get-Process -Id ([int]$entry.ProcessId) -ErrorAction Stop
            $processCreationTicks = [int64]$process.StartTime.ToUniversalTime().Ticks
            if ([Math]::Abs($processCreationTicks - [int64]$entry.CreationTicks) -gt [TimeSpan]::TicksPerSecond) {
                $identityCollectionFailures.Add('PROCESS_IDENTITY_CHANGED_DURING_SAMPLE')
                continue
            }

            $cpuValue = $process.CPU
            $privateWorkingSet = [Phase5ResourceNative]::PrivateWorkingSetBytes([int]$entry.ProcessId)
            $gdi = [Phase5ResourceNative]::GuiResourceCount([int]$entry.ProcessId, 0)
            $user = [Phase5ResourceNative]::GuiResourceCount([int]$entry.ProcessId, 1)
            if ($null -eq $cpuValue -or $null -eq $privateWorkingSet -or $null -eq $gdi -or $null -eq $user) {
                $metricCollectionFailures.Add("REQUIRED_METRIC_MISSING_$($role.ToUpperInvariant().Replace('-', '_'))")
                continue
            }

            $cpuSeconds = [double]$cpuValue
            $previousCpu = if ($previousCpuSeconds.ContainsKey($identityKey)) {
                [double]$previousCpuSeconds[$identityKey]
            } else {
                $cpuSeconds
            }
            $elapsedForCpu = if ($null -eq $previousSampleStarted) {
                [Math]::Max(0.001, $SampleIntervalSeconds)
            } else {
                [Math]::Max(0.001, $sampleStarted - [double]$previousSampleStarted)
            }
            $cpuPercent = [Math]::Max(
                0.0,
                (($cpuSeconds - $previousCpu) / $elapsedForCpu / $logicalProcessorCount) * 100.0
            )
            $previousCpuSeconds[$identityKey] = $cpuSeconds

            $rows.Add([pscustomobject]@{
                sample = $sampleIndex + 1
                elapsedMs = [int64][Math]::Round($sampleStarted * 1000)
                role = $role
                generation = [int]$generationByIdentity[$identityKey]
                cpuCapacityPercent = [Math]::Round($cpuPercent, 6)
                privateWorkingSetBytes = [int64]$privateWorkingSet
                privateBytes = [int64]$process.PrivateMemorySize64
                workingSetBytes = [int64]$process.WorkingSet64
                handles = [int64]$process.HandleCount
                gdiObjects = [int64]$gdi
                userObjects = [int64]$user
            })
            $metricObservedRoles[$role] = $true
        } catch {
            $metricCollectionFailures.Add("PROCESS_RESOURCE_QUERY_FAILED_$($role.ToUpperInvariant().Replace('-', '_'))")
        }
    }

    $previousSampleStarted = $sampleStarted
    $sampleIndex += 1
    $nextScheduledSampleSeconds = $sampleIndex * [double]$SampleIntervalSeconds
    $remainingSeconds = $DurationSeconds - $startedAt.Elapsed.TotalSeconds
    $secondsUntilNextSample = $nextScheduledSampleSeconds - $startedAt.Elapsed.TotalSeconds
    if ($remainingSeconds -gt 0 -and $secondsUntilNextSample -gt 0) {
        Start-Sleep -Milliseconds ([int][Math]::Min($secondsUntilNextSample * 1000, $remainingSeconds * 1000))
    }
}

if (-not $rootObserved) { throw 'The bound root process identity was not observable during sampling.' }
$rows | Export-Csv -LiteralPath $rawPath -NoTypeInformation -Encoding utf8

$samples = @($rows | Group-Object sample | ForEach-Object {
    $group = @($_.Group)
    [pscustomobject]@{
        sample = [int]$_.Name
        elapsedMs = [int64](($group | Measure-Object elapsedMs -Minimum).Minimum)
        cpuCapacityPercent = [double](($group | Measure-Object cpuCapacityPercent -Sum).Sum)
        privateWorkingSetBytes = [int64](($group | Measure-Object privateWorkingSetBytes -Sum).Sum)
        privateBytes = [int64](($group | Measure-Object privateBytes -Sum).Sum)
        handles = [int64](($group | Measure-Object handles -Sum).Sum)
        gdiObjects = [int64](($group | Measure-Object gdiObjects -Sum).Sum)
        userObjects = [int64](($group | Measure-Object userObjects -Sum).Sum)
    }
})

$analysisSamples = @($samples)
$analysisRows = @($rows)
if ($Acceptance -and $Profile -eq 'Soak') {
    $analysisSamples = @($samples | Where-Object { [int64]$_.elapsedMs -ge 300000 })
    $analysisRows = @($rows | Where-Object { [int64]$_.elapsedMs -ge 300000 })
}
$first = $analysisSamples | Select-Object -First 1
$last = $analysisSamples | Select-Object -Last 1
$cpuValues = @($analysisSamples | ForEach-Object { [double]$_.cpuCapacityPercent })

function Get-Growth {
    param(
        [Parameter()]$First,
        [Parameter()]$Last,
        [Parameter(Mandatory = $true)][string]$Property
    )
    if ($null -eq $First -or $null -eq $Last) {
        return [pscustomobject]@{ Delta = 0L; Ratio = 0.0 }
    }
    $start = [int64]$First.PSObject.Properties[$Property].Value
    $end = [int64]$Last.PSObject.Properties[$Property].Value
    $delta = $end - $start
    $ratio = if ($start -gt 0) { $delta / [double]$start } elseif ($delta -gt 0) { 1.0 } else { 0.0 }
    return [pscustomobject]@{ Delta = $delta; Ratio = $ratio }
}

function Test-SustainedMonotonicGrowth {
    param(
        [Parameter(Mandatory = $true)][object[]]$Values,
        [Parameter(Mandatory = $true)][int]$RequiredSamples
    )
    if ($RequiredSamples -lt 2 -or $Values.Count -lt $RequiredSamples) { return $false }
    $streak = 1
    $grew = $false
    for ($index = 1; $index -lt $Values.Count; $index += 1) {
        if ([double]$Values[$index] -ge [double]$Values[$index - 1]) {
            $streak += 1
            if ([double]$Values[$index] -gt [double]$Values[$index - 1]) { $grew = $true }
            if ($streak -ge $RequiredSamples -and $grew) { return $true }
        } else {
            $streak = 1
            $grew = $false
        }
    }
    return $false
}

$privateWorkingSetGrowth = Get-Growth -First $first -Last $last -Property 'privateWorkingSetBytes'
$privateBytesGrowth = Get-Growth -First $first -Last $last -Property 'privateBytes'
$handlesGrowth = Get-Growth -First $first -Last $last -Property 'handles'
$gdiGrowth = Get-Growth -First $first -Last $last -Property 'gdiObjects'
$userGrowth = Get-Growth -First $first -Last $last -Property 'userObjects'
$monotonicWindowSamples = [Math]::Ceiling(3600 / [double]$SampleIntervalSeconds) + 1
$sustainedMonotonicGrowth = [ordered]@{
    privateWorkingSet = Test-SustainedMonotonicGrowth -Values @($analysisSamples | ForEach-Object privateWorkingSetBytes) -RequiredSamples $monotonicWindowSamples
    privateBytes = Test-SustainedMonotonicGrowth -Values @($analysisSamples | ForEach-Object privateBytes) -RequiredSamples $monotonicWindowSamples
    handles = Test-SustainedMonotonicGrowth -Values @($analysisSamples | ForEach-Object handles) -RequiredSamples $monotonicWindowSamples
    gdiObjects = Test-SustainedMonotonicGrowth -Values @($analysisSamples | ForEach-Object gdiObjects) -RequiredSamples $monotonicWindowSamples
    userObjects = Test-SustainedMonotonicGrowth -Values @($analysisSamples | ForEach-Object userObjects) -RequiredSamples $monotonicWindowSamples
}

$requiredRoleObservations = [ordered]@{
    app = [bool]$observedRoles.ContainsKey('app')
    main = [bool]$observedRoles.ContainsKey('main')
    host = [bool]$observedRoles.ContainsKey('host')
}
$requiredRoleMetricObservations = [ordered]@{
    app = [bool]$metricObservedRoles.ContainsKey('app')
    main = [bool]$metricObservedRoles.ContainsKey('main')
    host = [bool]$metricObservedRoles.ContainsKey('host')
}
$cadenceIntervals = [System.Collections.Generic.List[int64]]::new()
for ($cadenceIndex = 1; $cadenceIndex -lt $sampleStartElapsedMilliseconds.Count; $cadenceIndex += 1) {
    $cadenceIntervals.Add(
        [int64]$sampleStartElapsedMilliseconds[$cadenceIndex] - [int64]$sampleStartElapsedMilliseconds[$cadenceIndex - 1]
    )
}
$minimumExpectedSampleCount = [Math]::Max(1, [Math]::Floor($DurationSeconds / [double]$SampleIntervalSeconds))

$gateFailures = [System.Collections.Generic.List[string]]::new()
if ($Acceptance -and $rootMissingAfterObservation) { $gateFailures.Add('ROOT_PROCESS_IDENTITY_DISAPPEARED') }
if ($Acceptance -and $analysisSamples.Count -eq 0) { $gateFailures.Add('NO_ANALYSIS_SAMPLES') }
if ($Acceptance -and $metricCollectionFailures.Count -gt 0) { $gateFailures.Add('REQUIRED_METRIC_COLLECTION_INCOMPLETE') }
if ($Acceptance -and $identityCollectionFailures.Count -gt 0) { $gateFailures.Add('PROCESS_IDENTITY_COLLECTION_INCOMPLETE') }
if ($Acceptance -and $sampleStartElapsedMilliseconds.Count -lt $minimumExpectedSampleCount) {
    $gateFailures.Add('INSUFFICIENT_SAMPLE_CADENCE_COUNT')
}
if ($Acceptance -and @($cadenceIntervals | Where-Object {
    [Math]::Abs([int64]$_ - ($SampleIntervalSeconds * 1000)) -gt 1000
}).Count -gt 0) {
    $gateFailures.Add('SAMPLE_INTERVAL_TOLERANCE_EXCEEDED')
}
foreach ($requiredRole in @('app', 'main', 'host')) {
    if ($Acceptance -and -not $requiredRoleObservations[$requiredRole]) {
        $gateFailures.Add("REQUIRED_ROLE_NOT_OBSERVED_$($requiredRole.ToUpperInvariant())")
    }
    if ($Acceptance -and -not $requiredRoleMetricObservations[$requiredRole]) {
        $gateFailures.Add("REQUIRED_ROLE_METRICS_NOT_OBSERVED_$($requiredRole.ToUpperInvariant())")
    }
}

if ($Acceptance) {
    try {
        $finalRootSha256 = (Get-FileHash -LiteralPath $expectedRootExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if (-not $finalRootSha256.Equals($expectedRootSha256, [System.StringComparison]::Ordinal)) {
            $gateFailures.Add('ROOT_EXECUTABLE_CHANGED_DURING_SAMPLING')
        }
    } catch {
        $gateFailures.Add('ROOT_EXECUTABLE_REHASH_FAILED')
    }
}

if ($Acceptance -and $Profile -eq 'Idle') {
    $cpuAverage = if ($cpuValues.Count -eq 0) { 0.0 } else { ($cpuValues | Measure-Object -Average).Average }
    if ($cpuAverage -gt 1.0) { $gateFailures.Add('IDLE_CPU_AVERAGE_EXCEEDED') }
    if ((Get-NearestRank -Values $cpuValues -Percentile 0.95) -gt 3.0) { $gateFailures.Add('IDLE_CPU_P95_EXCEEDED') }
    if (($analysisSamples | Measure-Object privateWorkingSetBytes -Maximum).Maximum -gt 350MB) {
        $gateFailures.Add('PRIVATE_WORKING_SET_CAPACITY_EXCEEDED')
    }
    $nativeHostMaximum = @($analysisRows | Where-Object role -eq 'host' | Measure-Object privateWorkingSetBytes -Maximum).Maximum
    if ($null -eq $nativeHostMaximum) {
        $gateFailures.Add('HOST_PRIVATE_WORKING_SET_METRIC_MISSING')
    } elseif ([int64]$nativeHostMaximum -gt 100MB) {
        $gateFailures.Add('HOST_PRIVATE_WORKING_SET_CAPACITY_EXCEEDED')
    }
}
if ($Acceptance -and $Profile -eq 'Soak') {
    if ($privateWorkingSetGrowth.Delta -gt 50MB -or $privateWorkingSetGrowth.Ratio -gt 0.2) {
        $gateFailures.Add('PRIVATE_WORKING_SET_GROWTH_EXCEEDED')
    }
    if ($privateBytesGrowth.Delta -gt 50MB -or $privateBytesGrowth.Ratio -gt 0.2) {
        $gateFailures.Add('PRIVATE_BYTES_GROWTH_EXCEEDED')
    }
    foreach ($growth in @(
        @{ Name = 'HANDLE'; Value = $handlesGrowth },
        @{ Name = 'GDI'; Value = $gdiGrowth },
        @{ Name = 'USER'; Value = $userGrowth }
    )) {
        if ($growth.Value.Delta -gt 100 -or $growth.Value.Ratio -gt 0.1) {
            $gateFailures.Add("$($growth.Name)_GROWTH_EXCEEDED")
        }
    }
    if ($sustainedMonotonicGrowth.Values -contains $true) {
        $gateFailures.Add('SUSTAINED_MONOTONIC_GROWTH_60_MINUTES')
    }
}

$status = if ($gateFailures.Count -gt 0) {
    'FAIL'
} elseif ($Acceptance) {
    'PASS'
} else {
    'SMOKE_PASS_NOT_ACCEPTANCE'
}
$summary = [ordered]@{
    schemaVersion = '1.1.0'
    scope = 'creation-time-bound-root-process-tree'
    profile = $Profile.ToLowerInvariant()
    status = $status
    acceptance = [bool]$Acceptance
    configuredDurationSeconds = $DurationSeconds
    actualDurationMs = [int64][Math]::Round($startedAt.Elapsed.TotalMilliseconds)
    sampleIntervalSeconds = $SampleIntervalSeconds
    logicalProcessorCount = $logicalProcessorCount
    identity = [ordered]@{
        rootExecutableFileName = [System.IO.Path]::GetFileName($expectedRootExecutablePath)
        rootExecutableSha256 = $expectedRootSha256
        rootPathAndHashBound = $true
        rootCreationTimeBound = $true
        pidPersisted = $false
        absolutePathPersisted = $false
    }
    requiredRoleObservations = $requiredRoleObservations
    requiredRoleMetricObservations = $requiredRoleMetricObservations
    sampleCount = $samples.Count
    postWarmupSampleCount = $analysisSamples.Count
    metricCollectionFailureCount = $metricCollectionFailures.Count
    identityCollectionFailureCount = $identityCollectionFailures.Count
    samplingCadence = [ordered]@{
        observedIntervalCount = $cadenceIntervals.Count
        expectedIntervalMs = $SampleIntervalSeconds * 1000
        toleranceMs = 1000
        minimumObservedIntervalMs = if ($cadenceIntervals.Count -eq 0) { 0 } else { [int64](($cadenceIntervals | Measure-Object -Minimum).Minimum) }
        maximumObservedIntervalMs = if ($cadenceIntervals.Count -eq 0) { 0 } else { [int64](($cadenceIntervals | Measure-Object -Maximum).Maximum) }
    }
    metrics = [ordered]@{
        cpuCapacityAveragePercent = if ($cpuValues.Count -eq 0) { 0.0 } else { [Math]::Round(($cpuValues | Measure-Object -Average).Average, 6) }
        cpuCapacityP95Percent = [Math]::Round((Get-NearestRank -Values $cpuValues -Percentile 0.95), 6)
        privateWorkingSetMaximumBytes = if ($analysisSamples.Count -eq 0) { 0 } else { [int64](($analysisSamples | Measure-Object privateWorkingSetBytes -Maximum).Maximum) }
        privateWorkingSetGrowthBytes = [int64]$privateWorkingSetGrowth.Delta
        privateWorkingSetGrowthRatio = [Math]::Round([double]$privateWorkingSetGrowth.Ratio, 6)
        privateBytesMaximum = if ($analysisSamples.Count -eq 0) { 0 } else { [int64](($analysisSamples | Measure-Object privateBytes -Maximum).Maximum) }
        privateBytesGrowthBytes = [int64]$privateBytesGrowth.Delta
        privateBytesGrowthRatio = [Math]::Round([double]$privateBytesGrowth.Ratio, 6)
        handlesMaximum = if ($analysisSamples.Count -eq 0) { 0 } else { [int64](($analysisSamples | Measure-Object handles -Maximum).Maximum) }
        handlesGrowth = [int64]$handlesGrowth.Delta
        handlesGrowthRatio = [Math]::Round([double]$handlesGrowth.Ratio, 6)
        gdiObjectsMaximum = if ($analysisSamples.Count -eq 0) { 0 } else { [int64](($analysisSamples | Measure-Object gdiObjects -Maximum).Maximum) }
        gdiObjectsGrowth = [int64]$gdiGrowth.Delta
        gdiObjectsGrowthRatio = [Math]::Round([double]$gdiGrowth.Ratio, 6)
        userObjectsMaximum = if ($analysisSamples.Count -eq 0) { 0 } else { [int64](($analysisSamples | Measure-Object userObjects -Maximum).Maximum) }
        userObjectsGrowth = [int64]$userGrowth.Delta
        userObjectsGrowthRatio = [Math]::Round([double]$userGrowth.Ratio, 6)
        sustainedMonotonicGrowth60Minutes = $sustainedMonotonicGrowth
    }
    failures = @($gateFailures)
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8

Write-Host "[phase5-resource] $status ($($samples.Count) samples, $($rows.Count) role rows)"
if ($status -eq 'FAIL') { exit 1 }

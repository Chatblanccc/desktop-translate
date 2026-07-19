[CmdletBinding()]
param(
    [Parameter()][string]$ScopeRoot = (Split-Path -Parent $PSScriptRoot),
    [Parameter()][string]$PackageDirectory,
    [Parameter()][string[]]$CandidateExecutablePath = @(),
    [Parameter()][ValidateRange(0, 2147483647)][int]$RootProcessId = 0,
    [Parameter()][string]$RootCreationTimeUtc,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter()][ValidateRange(0, 60)][int]$WaitSeconds = 3,
    [Parameter()][switch]$Acceptance,
    [Parameter()][switch]$FailOnLeak
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

$resolvedScope = Resolve-NormalizedPath -Path $ScopeRoot
$scopePrefix = $resolvedScope + '\'
$resolvedPackageDirectory = if ([string]::IsNullOrWhiteSpace($PackageDirectory)) {
    $null
} else {
    Resolve-NormalizedPath -Path $PackageDirectory
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedOutput)) | Out-Null

$candidatePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($candidate in @($CandidateExecutablePath)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
        $candidatePaths.Add((Resolve-NormalizedPath -Path $candidate)) | Out-Null
    }
}
if ($null -ne $resolvedPackageDirectory) {
    foreach ($relativeCandidate in @(
        'desktop-translate.exe',
        'electron.exe',
        'chrome_crashpad_handler.exe',
        'crashpad_handler.exe',
        'resources\selection-host\selection-host.exe'
    )) {
        $candidatePaths.Add((Resolve-NormalizedPath -Path (Join-Path $resolvedPackageDirectory $relativeCandidate))) | Out-Null
    }
}

$rootCreationTicks = $null
if (-not [string]::IsNullOrWhiteSpace($RootCreationTimeUtc)) {
    try {
        $rootCreationTicks = [int64]([DateTimeOffset]::Parse(
            $RootCreationTimeUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal
        ).UtcDateTime.Ticks)
    } catch {
        throw '-RootCreationTimeUtc must be an ISO-8601 timestamp.'
    }
}

if ($Acceptance) {
    if ($null -eq $resolvedPackageDirectory) {
        throw 'Acceptance residual scanning requires -PackageDirectory so packaged app, Electron, crashpad and Host paths are all covered.'
    }
    if (($RootProcessId -gt 0) -xor ($null -ne $rootCreationTicks)) {
        throw 'Acceptance root ancestry requires both -RootProcessId and -RootCreationTimeUtc.'
    }
}

function Test-PathWithinScope {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Equals($resolvedScope, [System.StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($scopePrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ProcessSnapshot {
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate FROM Win32_Process')) {
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
            CreationTicks = Convert-CreationTimeToTicks -Value $candidate.CreationDate
        })
    }
    return @($records)
}

function Get-AnchoredIdentityKeys {
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter()][System.Collections.Generic.List[string]]$InspectionFailures
    )

    $keys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    if ($RootProcessId -le 0 -or $null -eq $rootCreationTicks) { return ,$keys }

    $rootNow = $Processes | Where-Object ProcessId -eq $RootProcessId | Select-Object -First 1
    if ($null -ne $rootNow) {
        if ($null -eq $rootNow.CreationTicks) {
            $InspectionFailures.Add('BOUND_ROOT_CREATION_TIME_UNAVAILABLE')
            return ,$keys
        }
        if ([Math]::Abs([int64]$rootNow.CreationTicks - [int64]$rootCreationTicks) -gt [TimeSpan]::TicksPerSecond) {
            # The PID was reused.  Never attach the new process or its tree.
            $InspectionFailures.Add('BOUND_ROOT_PID_REUSED')
            return ,$keys
        }
        $keys.Add("$($rootNow.ProcessId):$($rootNow.CreationTicks)") | Out-Null
    }

    # ParentProcessId remains useful after the root exits.  Creation time is
    # required on every hop so a reused parent PID cannot silently acquire an
    # unrelated process tree.
    $knownParentIds = [System.Collections.Generic.HashSet[int]]::new()
    $knownParentIds.Add($RootProcessId) | Out-Null
    $minimumCreationTicks = @{}
    $minimumCreationTicks[$RootProcessId] = [int64]$rootCreationTicks
    do {
        $added = $false
        foreach ($candidate in $Processes) {
            $candidateId = [int]$candidate.ProcessId
            $parentId = [int]$candidate.ParentProcessId
            if ($knownParentIds.Contains($candidateId) -or -not $knownParentIds.Contains($parentId)) { continue }
            if ($null -eq $candidate.CreationTicks) {
                $InspectionFailures.Add('DESCENDANT_CREATION_TIME_UNAVAILABLE')
                continue
            }
            if ([int64]$candidate.CreationTicks -lt [int64]$minimumCreationTicks[$parentId]) { continue }
            $knownParentIds.Add($candidateId) | Out-Null
            $minimumCreationTicks[$candidateId] = [int64]$candidate.CreationTicks
            $keys.Add("$candidateId`:$($candidate.CreationTicks)") | Out-Null
            $added = $true
        }
    } while ($added)
    return ,$keys
}

function Get-RelevantRole {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][bool]$Anchored
    )

    $name = $Process.Name.ToLowerInvariant()
    $path = $Process.ExecutablePath
    $pathCandidate = $null -ne $path -and $candidatePaths.Contains($path)
    $pathScoped = $null -ne $path -and (Test-PathWithinScope -Path $path)
    $recognizedName = $name -in @(
        'desktop-translate.exe',
        'electron.exe',
        'selection-host.exe',
        'chrome_crashpad_handler.exe',
        'crashpad_handler.exe'
    )

    # Exact package candidates and a creation-time-bound launch tree are the
    # primary attribution sources.  Scope + known executable is retained only
    # for developer verification where no packaged launch manifest exists.
    if (-not $pathCandidate -and -not ($Anchored -and $recognizedName) -and -not ($pathScoped -and $recognizedName)) {
        return $null
    }
    switch ($name) {
        'desktop-translate.exe' { return 'app' }
        'electron.exe' { return 'electron' }
        'selection-host.exe' { return 'host' }
        'chrome_crashpad_handler.exe' { return 'crashpad' }
        'crashpad_handler.exe' { return 'crashpad' }
        default { return 'other-product-child' }
    }
}

function Get-ResidualSnapshot {
    $inspectionFailures = [System.Collections.Generic.List[string]]::new()
    $processes = @(Get-ProcessSnapshot)
    $anchoredKeys = Get-AnchoredIdentityKeys -Processes $processes -InspectionFailures $inspectionFailures
    $records = [System.Collections.Generic.List[object]]::new()

    foreach ($process in $processes) {
        if ($Acceptance -and $null -eq $process.ExecutablePath -and
            $process.Name.ToLowerInvariant() -in @(
                'desktop-translate.exe',
                'electron.exe',
                'selection-host.exe',
                'chrome_crashpad_handler.exe',
                'crashpad_handler.exe'
            )) {
            $inspectionFailures.Add('RELEVANT_PROCESS_PATH_UNAVAILABLE')
            continue
        }
        $key = if ($null -eq $process.CreationTicks) { $null } else { "$($process.ProcessId):$($process.CreationTicks)" }
        $anchored = $null -ne $key -and $anchoredKeys.Contains($key)
        $role = Get-RelevantRole -Process $process -Anchored $anchored
        if ($null -eq $role) { continue }

        if ($null -eq $process.ExecutablePath -or $null -eq $process.CreationTicks) {
            $inspectionFailures.Add("ATTRIBUTED_PROCESS_IDENTITY_INCOMPLETE_$($role.ToUpperInvariant())")
            continue
        }
        $records.Add([pscustomobject]@{
            Role = $role
            Attribution = if ($candidatePaths.Contains($process.ExecutablePath)) {
                'candidate-path'
            } elseif ($anchored) {
                'launch-tree'
            } else {
                'scoped-development-path'
            }
        })
    }
    return [pscustomobject]@{
        Records = @($records)
        InspectionFailures = @($inspectionFailures | Sort-Object -Unique)
    }
}

$snapshot = $null
$attempts = [Math]::Max(1, $WaitSeconds * 4 + 1)
for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
    $snapshot = Get-ResidualSnapshot
    if ($snapshot.Records.Count -eq 0 -and $snapshot.InspectionFailures.Count -eq 0) { break }
    if ($attempt + 1 -lt $attempts) { Start-Sleep -Milliseconds 250 }
}

$leaks = @($snapshot.Records)
$inspectionFailures = @($snapshot.InspectionFailures)
$counts = [ordered]@{
    app = @($leaks | Where-Object Role -eq 'app').Count
    electron = @($leaks | Where-Object Role -eq 'electron').Count
    crashpad = @($leaks | Where-Object Role -eq 'crashpad').Count
    host = @($leaks | Where-Object Role -eq 'host').Count
    otherProductChild = @($leaks | Where-Object Role -eq 'other-product-child').Count
}
$attributionCounts = [ordered]@{
    launchTree = @($leaks | Where-Object Attribution -eq 'launch-tree').Count
    candidatePath = @($leaks | Where-Object Attribution -eq 'candidate-path').Count
    scopedDevelopmentPath = @($leaks | Where-Object Attribution -eq 'scoped-development-path').Count
}
$status = if ($leaks.Count -eq 0 -and $inspectionFailures.Count -eq 0) { 'PASS' } else { 'FAIL' }
$report = [ordered]@{
    schemaVersion = '1.1.0'
    scope = 'bound-launch-tree-and-product-executable-paths'
    status = $status
    acceptance = [bool]$Acceptance
    readOnly = $true
    processIdentityPersisted = $false
    absoluteExecutablePathPersisted = $false
    rootCreationTimeBound = [bool]($RootProcessId -gt 0 -and $null -ne $rootCreationTicks)
    candidateExecutablePathCount = $candidatePaths.Count
    counts = $counts
    attributionCounts = $attributionCounts
    total = $leaks.Count
    inspectionFailures = $inspectionFailures
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
Write-Host "[phase5-residual] $status ($($leaks.Count) attributed product process(es))"
if (($FailOnLeak -or $Acceptance) -and $status -eq 'FAIL') { exit 1 }

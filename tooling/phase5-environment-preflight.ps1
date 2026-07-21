[CmdletBinding()]
param(
    [Parameter()][ValidateSet('Development', 'Formal')][string]$Mode = 'Development',
    [Parameter()][ValidateSet('A', 'B', 'C')][string]$HardwareProfile = 'B',
    [Parameter()][ValidateSet('LaneA', 'LaneB', 'Perf', 'Release', 'CleanDownload')][string]$RunnerRole = 'Perf',
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter()][string]$ExpectedPublisherSubject,
    [Parameter()][string]$Repository,
    [Parameter()][string[]]$RunnerLabels = @(),
    [Parameter()][string]$CurrentGitHubEnvironment,
    [Parameter()][switch]$ExclusiveInteractiveSession,
    [Parameter()][switch]$ForegroundInputExclusive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$minimumGhVersion = [version]'2.93.0'
$requiredOfflineVerifyFlags = @(
    '--bundle',
    '--custom-trusted-root',
    '--source-digest',
    '--source-ref',
    '--signer-workflow'
)
$roleRequirements = [ordered]@{
    LaneA = [ordered]@{
        labels = @('self-hosted', 'Windows', 'X64', 'phase5-lab')
        githubEnvironment = $null
        workflowJobId = 'lane-a-harness-schedule'
        workflowJobName = 'Lane A eight-hour harness schedule (not product acceptance)'
        runnerEnvironment = 'self-hosted'
        registeredRunnerRequired = $true
        trustedRunnerIdVariable = 'PHASE5_LAB_RUNNER_ID'
        authenticodeMode = 'None'
        exclusiveSessionRequired = $true
        hardwareEvidenceRequired = $true
        windows11Required = $true
        runtimeVariables = @(
            'CI',
            'PHASE5_LAB_RUNNER_ID',
            'TEST_ARTIFACT_PATH',
            'RELEASE_ARTIFACT_PATH',
            'TEST_BUILD_MANIFEST_PATH',
            'RELEASE_BUILD_MANIFEST_PATH',
            'TEST_ATTESTATION_BUNDLE_PATH',
            'RELEASE_ATTESTATION_BUNDLE_PATH',
            'BUILD_DIFFERENCE_ID'
        )
    }
    LaneB = [ordered]@{
        labels = @('self-hosted', 'Windows', 'X64', 'phase5-lane-b')
        githubEnvironment = 'phase5-lane-b'
        workflowJobId = 'lane-b-preflight'
        workflowJobName = 'Lane B signed-RC interactive preflight only'
        runnerEnvironment = 'self-hosted'
        registeredRunnerRequired = $true
        trustedRunnerIdVariable = 'PHASE5_LANE_B_RUNNER_ID'
        authenticodeMode = 'ExpectedSubject'
        exclusiveSessionRequired = $true
        hardwareEvidenceRequired = $true
        windows11Required = $true
        runtimeVariables = @('CI', 'DOWNLOAD_DIRECTORY', 'PHASE5_EXPECTED_SIGNING_SUBJECT', 'PHASE5_LANE_B_RUNNER_ID')
    }
    Perf = [ordered]@{
        labels = @('self-hosted', 'Windows', 'X64', 'phase5-lab')
        githubEnvironment = $null
        workflowJobId = 'phase5-performance'
        workflowJobName = 'Phase 5 formal performance matrix'
        runnerEnvironment = 'self-hosted'
        registeredRunnerRequired = $true
        trustedRunnerIdVariable = 'PHASE5_LAB_RUNNER_ID'
        authenticodeMode = 'None'
        exclusiveSessionRequired = $true
        hardwareEvidenceRequired = $true
        windows11Required = $true
        runtimeVariables = @(
            'CI',
            'PHASE5_LAB_RUNNER_ID',
            'PERF_PACKAGE_DIRECTORY',
            'PERF_PACKAGE_EVIDENCE_MANIFEST',
            'PERF_INSTALLER_PATH',
            'PERF_FINAL_RELEASE_MANIFEST',
            'PERF_CLEAN_DOWNLOAD_VERIFICATION',
            'PERF_INDEPENDENT_TRUSTED_ROOT',
            'PERF_DEVICE_REGISTRY',
            'PERF_RUN_METADATA'
        )
    }
    Release = [ordered]@{
        labels = @('self-hosted', 'Windows', 'X64', 'phase5-release')
        githubEnvironment = 'phase5-release'
        workflowJobId = 'protected-release'
        workflowJobName = 'Protected signed RC gate'
        runnerEnvironment = 'self-hosted'
        registeredRunnerRequired = $true
        trustedRunnerIdVariable = 'PHASE5_RELEASE_RUNNER_ID'
        authenticodeMode = 'SigningCertificate'
        exclusiveSessionRequired = $true
        hardwareEvidenceRequired = $true
        windows11Required = $true
        runtimeVariables = @(
            'CI',
            'PHASE5_RELEASE_RUNNER_ID',
            'PHASE5_RELEASE_EVIDENCE',
            'PHASE5_RELEASE_AUDIT',
            'PHASE5_EXPECTED_SIGNING_SUBJECT',
            'CSC_LINK',
            'CSC_KEY_PASSWORD',
            'ACTIONS_ID_TOKEN_REQUEST_URL',
            'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
        )
    }
    CleanDownload = [ordered]@{
        labels = @('windows-2022')
        githubEnvironment = 'phase5-release'
        workflowJobId = 'protected-release-clean-download'
        workflowJobName = 'Independent clean-download release verification'
        runnerEnvironment = 'github-hosted'
        registeredRunnerRequired = $false
        trustedRunnerIdVariable = $null
        authenticodeMode = 'ExpectedSubject'
        exclusiveSessionRequired = $false
        hardwareEvidenceRequired = $false
        windows11Required = $false
        runtimeVariables = @('CI', 'PHASE5_EXPECTED_SIGNING_SUBJECT')
    }
}

$selectedRoleRequirement = $roleRequirements[$RunnerRole]

$protectedEnvironmentRequirements = [ordered]@{
    'phase5-lane-b' = [ordered]@{
        minimumRequiredReviewers = 1
        minimumWaitTimerMinutes = 1
        requirePreventSelfReview = $true
        requiredCustomPolicyName = 'phase5-rc-*'
        requiredCustomPolicyType = 'tag'
    }
    'phase5-release' = [ordered]@{
        minimumRequiredReviewers = 1
        minimumWaitTimerMinutes = 1
        requirePreventSelfReview = $true
        requiredCustomPolicyName = 'phase5-rc-*'
        requiredCustomPolicyType = 'tag'
    }
}

$gates = [System.Collections.Generic.List[object]]::new()
$blockerCodes = [System.Collections.Generic.List[string]]::new()

function Add-PreflightGate {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Passed,
        [Parameter(Mandatory = $true)][string]$BlockerCode,
        [Parameter()][object]$Observed
    )

    $gate = [ordered]@{
        id = $Id
        status = if ($Passed) { 'PASS' } else { 'BLOCKED' }
    }
    if ($null -ne $Observed) {
        $gate.observed = $Observed
    }
    $gates.Add($gate)
    if (-not $Passed -and -not $blockerCodes.Contains($BlockerCode)) {
        $blockerCodes.Add($BlockerCode)
    }
}

function Test-EnvironmentVariablePresent {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    return -not [string]::IsNullOrWhiteSpace($value)
}

function Invoke-GhJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    try {
        $raw = @(& gh @Arguments 2>$null)
        if ($LASTEXITCODE -ne 0 -or $raw.Count -eq 0) {
            return $null
        }
        return (($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Get-ObjectPropertyValue {
    param(
        [Parameter()][AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-CurrentWorkflowDeclaration {
    param(
        [Parameter(Mandatory = $true)][string]$JobId,
        [Parameter()][AllowNull()][string]$ExpectedEnvironment,
        [Parameter(Mandatory = $true)][string[]]$ExpectedLabels
    )

    $workflowPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.github\workflows\phase5-windows.yml'
    if (-not (Test-Path -LiteralPath $workflowPath -PathType Leaf)) { return $false }
    try {
        $lines = @(Get-Content -LiteralPath $workflowPath -Encoding utf8 -ErrorAction Stop)
        $startIndex = -1
        for ($index = 0; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match ('^  ' + [regex]::Escape($JobId) + ':\s*$')) {
                $startIndex = $index
                break
            }
        }
        if ($startIndex -lt 0) { return $false }
        $endIndex = $lines.Count
        for ($index = $startIndex + 1; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match '^  [A-Za-z0-9_-]+:\s*$') {
                $endIndex = $index
                break
            }
        }
        $block = ($lines[$startIndex..($endIndex - 1)] -join "`n")
        $runsOnMatch = [regex]::Match($block, '(?im)^\s{4}runs-on:\s*(?:\[([^\]]+)\]|([^\s#]+))\s*(?:#.*)?$')
        if (-not $runsOnMatch.Success) { return $false }
        $declaredLabels = if (-not [string]::IsNullOrWhiteSpace($runsOnMatch.Groups[1].Value)) {
            @($runsOnMatch.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        } else {
            @($runsOnMatch.Groups[2].Value.Trim())
        }
        if (-not (Test-LabelSet -Actual $declaredLabels -Required $ExpectedLabels)) {
            return $false
        }
        $declaredEnvironment = [regex]::Match($block, '(?im)^\s{4}environment:\s*([^\s#]+)\s*(?:#.*)?$')
        if ([string]::IsNullOrWhiteSpace($ExpectedEnvironment)) {
            return -not $declaredEnvironment.Success
        }
        return $declaredEnvironment.Success -and
            [string]::Equals($declaredEnvironment.Groups[1].Value, $ExpectedEnvironment, [StringComparison]::Ordinal)
    } catch {
        return $false
    }
}

function Test-LabelSet {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Actual,
        [Parameter(Mandatory = $true)][string[]]$Required
    )

    $normalized = @($Actual | ForEach-Object { $_.Trim().ToLowerInvariant() } | Select-Object -Unique)
    foreach ($label in $Required) {
        if ($normalized -notcontains $label.ToLowerInvariant()) {
            return $false
        }
    }
    return $true
}

function Get-AuthenticodeCertificateReadiness {
    param(
        [Parameter()][string]$ExpectedSubject,
        [Parameter()][switch]$LoadEphemeralSigningInput
    )

    $result = [ordered]@{
        expectedIdentityProvided = -not [string]::IsNullOrWhiteSpace($ExpectedSubject)
        exactIdentityMatches = 0
        usablePrivateKeyMatches = 0
        trustedCodeSigningMatches = 0
        onlineRevocationChecksAttempted = 0
        onlineRevocationConfirmedMatches = 0
        ephemeralSigningInputRequired = $LoadEphemeralSigningInput.IsPresent
        ephemeralSigningInputLoaded = $false
    }
    if (-not $result.expectedIdentityProvided) {
        return $result
    }

    $certificates = [System.Collections.Generic.List[object]]::new()
    $ephemeralCertificates = [System.Collections.Generic.List[object]]::new()
    if ($LoadEphemeralSigningInput.IsPresent) {
        try {
            $encodedPfx = [Environment]::GetEnvironmentVariable('CSC_LINK', 'Process')
            $pfxPassword = [Environment]::GetEnvironmentVariable('CSC_KEY_PASSWORD', 'Process')
            if (-not [string]::IsNullOrWhiteSpace($encodedPfx) -and
                -not [string]::IsNullOrWhiteSpace($pfxPassword)) {
                $pfxBytes = [Convert]::FromBase64String($encodedPfx)
                $ephemeralCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
                    $pfxBytes,
                    $pfxPassword,
                    [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
                )
                $ephemeralCertificates.Add($ephemeralCertificate)
                $certificates.Add($ephemeralCertificate)
                $result.ephemeralSigningInputLoaded = $true
            }
        } catch {
            # Invalid or unreadable protected signing input remains a privacy-safe BLOCKED result.
        }
    }

    $seenThumbprints = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $now = [DateTime]::UtcNow
    foreach ($certificate in $certificates) {
        if ([string]::IsNullOrWhiteSpace([string]$certificate.Thumbprint) -or
            -not $seenThumbprints.Add([string]$certificate.Thumbprint)) {
            continue
        }
        if (-not [string]::Equals(
            [string]$certificate.Subject,
            $ExpectedSubject,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            continue
        }
        $result.exactIdentityMatches++

        $selfIssued = [string]::Equals(
            [string]$certificate.Subject,
            [string]$certificate.Issuer,
            [StringComparison]::OrdinalIgnoreCase
        )
        $timeValid = $certificate.NotBefore.ToUniversalTime() -le $now -and
            $certificate.NotAfter.ToUniversalTime() -gt $now
        $codeSigningEku = $false
        foreach ($extension in @($certificate.Extensions)) {
            if ($extension -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
                foreach ($oid in @($extension.EnhancedKeyUsages)) {
                    if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') {
                        $codeSigningEku = $true
                    }
                }
            }
        }
        if (-not $certificate.HasPrivateKey -or $selfIssued -or -not $timeValid -or -not $codeSigningEku) {
            continue
        }
        $result.usablePrivateKeyMatches++

        $chain = $null
        try {
            $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
            $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
            $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::EntireChain
            $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
            $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
            $result.onlineRevocationChecksAttempted++
            $chainBuilt = $chain.Build($certificate)
            $revocationUnconfirmed = @($chain.ChainStatus | Where-Object {
                ($_.Status -band [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::RevocationStatusUnknown) -ne 0 -or
                ($_.Status -band [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::OfflineRevocation) -ne 0
            }).Count -gt 0
            if ($chainBuilt -and -not $revocationUnconfirmed) {
                $result.trustedCodeSigningMatches++
                $result.onlineRevocationConfirmedMatches++
            }
        } catch {
            # Chain failures remain a stable BLOCKED result; raw certificate details are never emitted.
        } finally {
            if ($null -ne $chain) { $chain.Dispose() }
        }
    }

    foreach ($ephemeralCertificate in $ephemeralCertificates) {
        $ephemeralCertificate.Dispose()
    }

    return $result
}

if (-not ('Phase5.EnvironmentDisplayProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Phase5 {
    public static class EnvironmentDisplayProbe {
        private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);

        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint x, out uint y);

        public static int[] GetActiveDisplayDpiPercentages() {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            var values = new List<int>();
            MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data) {
                uint x;
                uint y;
                try {
                    if (GetDpiForMonitor(monitor, 0, out x, out y) == 0 && x > 0 && x == y) {
                        values.Add((int)Math.Round((double)x * 100.0 / 96.0));
                    } else {
                        values.Add(0);
                    }
                } catch {
                    values.Add(0);
                }
                return true;
            };
            if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) {
                return new int[0];
            }
            return values.ToArray();
        }
    }
}
'@
}

$osProbeSucceeded = $false
$windowsFamily = 'UNKNOWN'
$osVersion = 'UNKNOWN'
$osBuild = 'UNKNOWN'
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToUpperInvariant()
$logicalProcessorCount = 0
$ramGiBRounded = 0
try {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $osVersion = [string]$operatingSystem.Version
    $osBuild = [string]$operatingSystem.BuildNumber
    if ($osBuild -match '^\d+$') {
        $windowsFamily = if ([int64]$osBuild -ge 22000) { 'WINDOWS_11' } else { 'WINDOWS_LEGACY' }
    }
    $logicalProcessorCount = [int]$computerSystem.NumberOfLogicalProcessors
    $ramGiBRounded = [int][Math]::Round([double]$computerSystem.TotalPhysicalMemory / 1GB)
    $osProbeSucceeded = $true
} catch {
    # Stable UNKNOWN values are safer than serializing CIM error text.
}

$ramTier = switch ($ramGiBRounded) {
    { $_ -ge 7 -and $_ -le 10 } { '8_GIB'; break }
    { $_ -ge 12 -and $_ -le 20 } { '16_GIB'; break }
    { $_ -ge 24 -and $_ -le 40 } { '32_GIB'; break }
    { $_ -gt 40 } { 'ABOVE_32_GIB'; break }
    default { 'BELOW_8_GIB_OR_UNKNOWN' }
}

$physicalMonitorProbeSucceeded = $false
$physicalMonitorCount = 0
$activeConnectionCount = 0
try {
    $connections = @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorConnectionParams -ErrorAction Stop |
        Where-Object { $_.Active })
    $activeConnectionCount = $connections.Count
    foreach ($connection in $connections) {
        $technology = [uint64]$connection.VideoOutputTechnology
        # D3DKMDT_VOT_INTERNAL is the unsigned value 2147483648. In Windows
        # PowerShell the literal 0x80000000 is parsed as a negative Int32, so
        # compare against an explicitly unsigned value.
        if (($technology -le 14) -or $technology -eq [uint64]2147483648) {
            $physicalMonitorCount++
        }
    }
    $physicalMonitorProbeSucceeded = $true
} catch {
    # Virtual/unknown displays are never promoted to physical evidence by fallback guessing.
}

$displayDpiPercentages = @()
$dpiProbeSucceeded = $false
try {
    $displayDpiPercentages = @([Phase5.EnvironmentDisplayProbe]::GetActiveDisplayDpiPercentages())
    $dpiProbeSucceeded = $displayDpiPercentages.Count -gt 0 -and
        @($displayDpiPercentages | Where-Object { $_ -le 0 }).Count -eq 0 -and
        $displayDpiPercentages.Count -eq $activeConnectionCount -and
        $physicalMonitorCount -eq $activeConnectionCount
} catch {
    $displayDpiPercentages = @()
}
$distinctDpiPercentages = @($displayDpiPercentages | Sort-Object -Unique)

$osReady = $osProbeSucceeded -and $architecture -eq 'X64' -and
    (-not [bool]$selectedRoleRequirement.windows11Required -or $windowsFamily -eq 'WINDOWS_11')
Add-PreflightGate -Id 'WINDOWS_11_X64' -Passed $osReady -BlockerCode 'WINDOWS_11_X64_REQUIRED' -Observed ([ordered]@{
    family = $windowsFamily
    version = $osVersion
    build = $osBuild
    architecture = $architecture
    windows11Required = [bool]$selectedRoleRequirement.windows11Required
})

$profileCpuReady = switch ($HardwareProfile) {
    'A' { $logicalProcessorCount -eq 4 }
    'B' { $logicalProcessorCount -ge 8 }
    'C' { $logicalProcessorCount -ge 8 }
}
$cpuGateReady = -not [bool]$selectedRoleRequirement.hardwareEvidenceRequired -or
    ($osProbeSucceeded -and $profileCpuReady)
Add-PreflightGate -Id 'LOGICAL_PROCESSOR_PROFILE' -Passed $cpuGateReady `
    -BlockerCode 'LOGICAL_PROCESSOR_PROFILE_MISMATCH' -Observed ([ordered]@{
        required = [bool]$selectedRoleRequirement.hardwareEvidenceRequired
        profile = $HardwareProfile
        logicalProcessorCount = $logicalProcessorCount
        requirement = if (-not [bool]$selectedRoleRequirement.hardwareEvidenceRequired) {
            'NOT_REQUIRED_FOR_ROLE'
        } else {
            switch ($HardwareProfile) { 'A' { 'EXACTLY_4' } default { 'AT_LEAST_8' } }
        }
    })

$profileRamReady = switch ($HardwareProfile) {
    'A' { $ramTier -eq '8_GIB' }
    'B' { $ramTier -in @('16_GIB', '32_GIB', 'ABOVE_32_GIB') }
    'C' { $ramTier -in @('16_GIB', '32_GIB', 'ABOVE_32_GIB') }
}
$ramGateReady = -not [bool]$selectedRoleRequirement.hardwareEvidenceRequired -or
    ($osProbeSucceeded -and $profileRamReady)
Add-PreflightGate -Id 'RAM_PROFILE' -Passed $ramGateReady `
    -BlockerCode 'RAM_PROFILE_MISMATCH' -Observed ([ordered]@{
        required = [bool]$selectedRoleRequirement.hardwareEvidenceRequired
        profile = $HardwareProfile
        tier = $ramTier
        roundedGiB = $ramGiBRounded
    })

$monitorReady = $physicalMonitorProbeSucceeded -and $physicalMonitorCount -ge 1
if ($HardwareProfile -eq 'C') {
    $monitorReady = $monitorReady -and $physicalMonitorCount -ge 2
}
$monitorGateReady = -not [bool]$selectedRoleRequirement.hardwareEvidenceRequired -or $monitorReady
Add-PreflightGate -Id 'PHYSICAL_MONITOR_PROFILE' -Passed $monitorGateReady `
    -BlockerCode 'PHYSICAL_MONITOR_PROFILE_MISMATCH' -Observed ([ordered]@{
        required = [bool]$selectedRoleRequirement.hardwareEvidenceRequired
        profile = $HardwareProfile
        count = $physicalMonitorCount
        requiredMinimum = if (-not [bool]$selectedRoleRequirement.hardwareEvidenceRequired) {
            0
        } elseif ($HardwareProfile -eq 'C') { 2 } else { 1 }
        measurementComplete = $physicalMonitorProbeSucceeded
    })

$dpiReady = $dpiProbeSucceeded
if ($dpiReady) {
    $dpiReady = switch ($HardwareProfile) {
        'A' { $distinctDpiPercentages -contains 100 }
        'B' { $distinctDpiPercentages -contains 150 }
        'C' {
            $distinctDpiPercentages.Count -ge 2 -and
            @($distinctDpiPercentages | Where-Object { $_ -notin @(100, 125, 150, 200) }).Count -eq 0
        }
    }
}
$dpiGateReady = -not [bool]$selectedRoleRequirement.hardwareEvidenceRequired -or $dpiReady
Add-PreflightGate -Id 'DPI_PROFILE_COVERAGE' -Passed $dpiGateReady -BlockerCode 'DPI_PROFILE_COVERAGE_MISSING' `
    -Observed ([ordered]@{
        required = [bool]$selectedRoleRequirement.hardwareEvidenceRequired
        profile = $HardwareProfile
        percentages = $distinctDpiPercentages
        requirement = if (-not [bool]$selectedRoleRequirement.hardwareEvidenceRequired) {
            'NOT_REQUIRED_FOR_ROLE'
        } else {
            switch ($HardwareProfile) {
                'A' { 'INCLUDES_100' }
                'B' { 'INCLUDES_150' }
                'C' { 'TWO_OR_MORE_DISTINCT_FROM_100_125_150_200' }
            }
        }
        physicalOnlyMeasurement = $dpiProbeSucceeded
    })

$interactiveSessionReady = [Environment]::UserInteractive
try {
    $interactiveSessionReady = $interactiveSessionReady -and
        (Get-Process -Id $PID -ErrorAction Stop).SessionId -gt 0
} catch {
    $interactiveSessionReady = $false
}
$exclusiveSessionReady = $interactiveSessionReady -and
    $ExclusiveInteractiveSession.IsPresent -and
    $ForegroundInputExclusive.IsPresent
$exclusiveSessionGateReady = -not [bool]$selectedRoleRequirement.exclusiveSessionRequired -or
    $exclusiveSessionReady
Add-PreflightGate -Id 'EXCLUSIVE_INTERACTIVE_SESSION_DECLARATION' -Passed $exclusiveSessionGateReady `
    -BlockerCode 'EXCLUSIVE_INTERACTIVE_SESSION_NOT_DECLARED' -Observed ([ordered]@{
        required = [bool]$selectedRoleRequirement.exclusiveSessionRequired
        userInteractive = [bool][Environment]::UserInteractive
        nonSessionZero = $interactiveSessionReady
        exclusiveSessionDeclared = $ExclusiveInteractiveSession.IsPresent
        foregroundInputExclusiveDeclared = $ForegroundInputExclusive.IsPresent
    })

$ghInstalled = $false
$ghVersion = $null
$verifyFlagsPresent = @()
$trustedRootVerifyOnlyPresent = $false
try {
    $versionLine = @(& gh --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $versionLine.Count -eq 1 -and
        $versionLine[0] -match '^gh version ([0-9]+\.[0-9]+\.[0-9]+)') {
        $ghVersion = [version]$Matches[1]
        $ghInstalled = $true
    }
    $verifyHelp = @(& gh attestation verify --help 2>$null) -join "`n"
    foreach ($flag in $requiredOfflineVerifyFlags) {
        if ($verifyHelp.Contains($flag)) {
            $verifyFlagsPresent += $flag
        }
    }
    $trustedRootHelp = @(& gh attestation trusted-root --help 2>$null) -join "`n"
    $trustedRootVerifyOnlyPresent = $trustedRootHelp.Contains('--verify-only')
} catch {
    # Tool discovery failure is represented only by stable booleans.
}
$ghReady = $ghInstalled -and $ghVersion -ge $minimumGhVersion -and
    $verifyFlagsPresent.Count -eq $requiredOfflineVerifyFlags.Count -and
    $trustedRootVerifyOnlyPresent
Add-PreflightGate -Id 'GH_OFFLINE_ATTESTATION_CAPABILITY' -Passed $ghReady `
    -BlockerCode 'GH_OFFLINE_ATTESTATION_CAPABILITY_MISSING' -Observed ([ordered]@{
        installed = $ghInstalled
        version = if ($null -eq $ghVersion) { 'UNAVAILABLE' } else { $ghVersion.ToString() }
        minimumVersion = $minimumGhVersion.ToString()
        verifyFlagsPresent = @($verifyFlagsPresent)
        requiredVerifyFlagCount = $requiredOfflineVerifyFlags.Count
        trustedRootVerifyOnlyPresent = $trustedRootVerifyOnlyPresent
    })

$certificateReadiness = Get-AuthenticodeCertificateReadiness `
    -ExpectedSubject $ExpectedPublisherSubject `
    -LoadEphemeralSigningInput:([string]$selectedRoleRequirement.authenticodeMode -eq 'SigningCertificate')
$certificateReadiness.authenticodeMode = [string]$selectedRoleRequirement.authenticodeMode
$certificateReady = switch ([string]$selectedRoleRequirement.authenticodeMode) {
    'None' { $true }
    'ExpectedSubject' { [bool]$certificateReadiness.expectedIdentityProvided }
    'SigningCertificate' {
        [bool]$certificateReadiness.ephemeralSigningInputLoaded -and
            [int]$certificateReadiness.trustedCodeSigningMatches -gt 0
    }
    default { $false }
}
Add-PreflightGate -Id 'AUTHENTICODE_EXPECTED_IDENTITY' -Passed $certificateReady `
    -BlockerCode 'AUTHENTICODE_EXPECTED_IDENTITY_UNAVAILABLE' -Observed $certificateReadiness

$runnerInventoryAvailable = $false
$environmentInventoryAvailable = $false
$runnerInventoryComplete = $false
$environmentInventoryComplete = $false
$remoteRoleSummaries = [ordered]@{}
$environmentSummaries = [ordered]@{}
$remoteRunners = @()
if ($Repository -match '^[^/\s]+/[^/\s]+$' -and $ghInstalled) {
    $runnerResponse = Invoke-GhJson -Arguments @('api', "repos/$Repository/actions/runners?per_page=100")
    $environmentResponse = Invoke-GhJson -Arguments @('api', "repos/$Repository/environments?per_page=100")
    if ($null -ne $runnerResponse) {
        $runnerInventoryAvailable = $true
        $remoteRunners = @($runnerResponse.runners)
        $runnerInventoryComplete = [int]$runnerResponse.total_count -eq $remoteRunners.Count

        foreach ($roleName in $roleRequirements.Keys) {
            $requirement = $roleRequirements[$roleName]
            if (-not [bool]$requirement.registeredRunnerRequired) {
                continue
            }
            $matchingOnlineCount = 0
            foreach ($runner in $remoteRunners) {
                $labels = @($runner.labels | ForEach-Object { [string]$_.name })
                if ([string]$runner.status -eq 'online' -and
                    (Test-LabelSet -Actual $labels -Required @($requirement.labels))) {
                    $matchingOnlineCount++
                }
            }
            $remoteRoleSummaries[$roleName] = [ordered]@{
                requiredLabels = @($requirement.labels)
                matchingOnlineRunnerCount = $matchingOnlineCount
                ready = $matchingOnlineCount -gt 0
            }
        }
    }

    if ($null -ne $environmentResponse) {
        $environmentInventoryAvailable = $true
        $remoteEnvironments = @($environmentResponse.environments)
        $environmentInventoryComplete = [int]$environmentResponse.total_count -eq $remoteEnvironments.Count
        foreach ($environmentName in @('phase5-lane-b', 'phase5-release')) {
            $exists = @($remoteEnvironments | Where-Object { [string]$_.name -eq $environmentName }).Count -eq 1
            $protectionRequirement = $protectedEnvironmentRequirements[$environmentName]
            $requiredSecrets = @(if ($environmentName -eq 'phase5-release') {
                @(
                    'PHASE5_WINDOWS_CERTIFICATE_BASE64',
                    'PHASE5_WINDOWS_CERTIFICATE_PASSWORD',
                    'PHASE5_WINDOWS_SIGNING_SUBJECT',
                    'PHASE5_RELEASE_RUNNER_ID'
                )
            } else {
                @('PHASE5_WINDOWS_SIGNING_SUBJECT', 'PHASE5_LANE_B_RUNNER_ID')
            })
            $secretNames = @()
            $secretInventoryAvailable = $false
            $protectionInventoryAvailable = $false
            $requiredReviewerCount = 0
            $requiredReviewersReady = $false
            $preventSelfReview = $false
            $waitTimerMinutes = 0
            $waitTimerReady = $false
            $deploymentPolicyExclusive = $false
            $customPolicyInventoryAvailable = $false
            $customPolicyCount = 0
            $requiredCustomPolicyPresent = $false
            $customPolicyExactSet = $false
            if ($exists) {
                $environmentDetail = Invoke-GhJson -Arguments @(
                    'api',
                    "repos/$Repository/environments/$environmentName"
                )
                if ($null -ne $environmentDetail) {
                    $protectionRules = @(Get-ObjectPropertyValue -InputObject $environmentDetail -Name 'protection_rules')
                    $reviewerRules = @($protectionRules | Where-Object {
                        [string](Get-ObjectPropertyValue -InputObject $_ -Name 'type') -eq 'required_reviewers'
                    })
                    $waitTimerRules = @($protectionRules | Where-Object {
                        [string](Get-ObjectPropertyValue -InputObject $_ -Name 'type') -eq 'wait_timer'
                    })
                    if ($reviewerRules.Count -eq 1) {
                        $reviewers = @(Get-ObjectPropertyValue -InputObject $reviewerRules[0] -Name 'reviewers')
                        $requiredReviewerCount = $reviewers.Count
                    }
                    # GitHub returns prevent_self_review on the
                    # required_reviewers protection rule, not at the
                    # environment root.
                    $preventSelfReviewValue = if ($reviewerRules.Count -eq 1) {
                        Get-ObjectPropertyValue -InputObject $reviewerRules[0] -Name 'prevent_self_review'
                    } else {
                        $null
                    }
                    $preventSelfReview = $preventSelfReviewValue -is [bool] -and [bool]$preventSelfReviewValue
                    $requiredReviewersReady = $reviewerRules.Count -eq 1 -and
                        $requiredReviewerCount -ge [int]$protectionRequirement.minimumRequiredReviewers -and
                        (-not [bool]$protectionRequirement.requirePreventSelfReview -or $preventSelfReview)
                    if ($waitTimerRules.Count -eq 1) {
                        $waitTimerValue = Get-ObjectPropertyValue -InputObject $waitTimerRules[0] -Name 'wait_timer'
                        if ($null -ne $waitTimerValue -and [string]$waitTimerValue -match '^\d+$') {
                            $waitTimerMinutes = [int]$waitTimerValue
                        }
                    }
                    $waitTimerReady = $waitTimerRules.Count -eq 1 -and
                        $waitTimerMinutes -ge [int]$protectionRequirement.minimumWaitTimerMinutes

                    $deploymentPolicy = Get-ObjectPropertyValue -InputObject $environmentDetail -Name 'deployment_branch_policy'
                    $protectedBranchesValue = Get-ObjectPropertyValue -InputObject $deploymentPolicy -Name 'protected_branches'
                    $customPoliciesValue = Get-ObjectPropertyValue -InputObject $deploymentPolicy -Name 'custom_branch_policies'
                    $protectedBranches = $protectedBranchesValue -is [bool] -and [bool]$protectedBranchesValue
                    $customPolicies = $customPoliciesValue -is [bool] -and [bool]$customPoliciesValue
                    $deploymentPolicyExclusive = $customPolicies -and -not $protectedBranches
                    $protectionInventoryAvailable = $true

                    if ($customPolicies) {
                        $policyResponse = Invoke-GhJson -Arguments @(
                            'api',
                            "repos/$Repository/environments/$environmentName/deployment-branch-policies?per_page=100"
                        )
                        if ($null -ne $policyResponse) {
                            $policies = @(Get-ObjectPropertyValue -InputObject $policyResponse -Name 'branch_policies')
                            $policyTotalCount = Get-ObjectPropertyValue -InputObject $policyResponse -Name 'total_count'
                            $customPolicyCount = $policies.Count
                            $customPolicyInventoryAvailable = $null -ne $policyTotalCount -and
                                [int]$policyTotalCount -eq $customPolicyCount
                            $requiredCustomPolicyPresent = @($policies | Where-Object {
                                [string]::Equals(
                                    [string](Get-ObjectPropertyValue -InputObject $_ -Name 'name'),
                                    [string]$protectionRequirement.requiredCustomPolicyName,
                                    [StringComparison]::Ordinal
                                ) -and [string]::Equals(
                                    [string](Get-ObjectPropertyValue -InputObject $_ -Name 'type'),
                                    [string]$protectionRequirement.requiredCustomPolicyType,
                                    [StringComparison]::Ordinal
                                )
                            }).Count -eq 1
                            $customPolicyExactSet = $customPolicyInventoryAvailable -and
                                $customPolicyCount -eq 1 -and $requiredCustomPolicyPresent
                        }
                    }
                }
                $secretResponse = Invoke-GhJson -Arguments @(
                    'api',
                    "repos/$Repository/environments/$environmentName/secrets?per_page=100"
                )
                if ($null -ne $secretResponse) {
                    $secretNames = @($secretResponse.secrets | ForEach-Object { [string]$_.name })
                    $secretInventoryAvailable = [int]$secretResponse.total_count -eq $secretNames.Count
                }
            }
            $missingSecretNames = @($requiredSecrets | Where-Object { $secretNames -notcontains $_ })
            $environmentSummaries[$environmentName] = [ordered]@{
                exists = $exists
                secretInventoryAvailable = $secretInventoryAvailable
                requiredSecretCount = $requiredSecrets.Count
                presentRequiredSecretCount = $requiredSecrets.Count - $missingSecretNames.Count
                protectionInventoryAvailable = $protectionInventoryAvailable
                requiredReviewerCount = $requiredReviewerCount
                minimumRequiredReviewerCount = [int]$protectionRequirement.minimumRequiredReviewers
                requiredReviewersReady = $requiredReviewersReady
                preventSelfReview = $preventSelfReview
                waitTimerMinutes = $waitTimerMinutes
                minimumWaitTimerMinutes = [int]$protectionRequirement.minimumWaitTimerMinutes
                waitTimerReady = $waitTimerReady
                deploymentPolicyExclusive = $deploymentPolicyExclusive
                customPolicyInventoryAvailable = $customPolicyInventoryAvailable
                customPolicyCount = $customPolicyCount
                requiredCustomPolicyPresent = $requiredCustomPolicyPresent
                customPolicyExactSet = $customPolicyExactSet
                ready = $exists -and $secretInventoryAvailable -and $missingSecretNames.Count -eq 0 -and
                    $protectionInventoryAvailable -and $requiredReviewersReady -and $waitTimerReady -and
                    $deploymentPolicyExclusive -and $customPolicyExactSet
            }
        }
    }
}

$remoteRunnerReady = if ([bool]$selectedRoleRequirement.registeredRunnerRequired) {
    $runnerInventoryAvailable -and $runnerInventoryComplete -and
        @($remoteRoleSummaries.Keys | Where-Object { -not $remoteRoleSummaries[$_].ready }).Count -eq 0 -and
        $remoteRoleSummaries.Count -eq 4
} else {
    $true
}
Add-PreflightGate -Id 'GITHUB_ACTIONS_RUNNER_LABELS' -Passed $remoteRunnerReady `
    -BlockerCode 'GITHUB_ACTIONS_RUNNER_LABELS_UNREADY' -Observed ([ordered]@{
        registeredRunnerRequired = [bool]$selectedRoleRequirement.registeredRunnerRequired
        inventoryAvailable = $runnerInventoryAvailable
        inventoryComplete = $runnerInventoryComplete
        roles = $remoteRoleSummaries
    })

$remoteEnvironmentReady = $environmentInventoryAvailable -and $environmentInventoryComplete -and
    @($environmentSummaries.Keys | Where-Object { -not $environmentSummaries[$_].ready }).Count -eq 0 -and
    $environmentSummaries.Count -eq 2
Add-PreflightGate -Id 'GITHUB_ACTIONS_PROTECTED_ENVIRONMENTS' -Passed $remoteEnvironmentReady `
    -BlockerCode 'GITHUB_ACTIONS_PROTECTED_ENVIRONMENTS_UNREADY' -Observed ([ordered]@{
        inventoryAvailable = $environmentInventoryAvailable
        inventoryComplete = $environmentInventoryComplete
        environments = $environmentSummaries
    })

$declaredLabelsReady = Test-LabelSet -Actual @($RunnerLabels) -Required @($selectedRoleRequirement.labels)
$declaredEnvironmentReady = if ($null -eq $selectedRoleRequirement.githubEnvironment) {
    [string]::IsNullOrWhiteSpace($CurrentGitHubEnvironment)
} else {
    [string]::Equals(
        $CurrentGitHubEnvironment,
        [string]$selectedRoleRequirement.githubEnvironment,
        [StringComparison]::Ordinal
    )
}
$runtimeEnvironmentName = [Environment]::GetEnvironmentVariable('PHASE5_GITHUB_ENVIRONMENT', 'Process')
$runtimeEnvironmentReady = if ($null -eq $selectedRoleRequirement.githubEnvironment) {
    [string]::IsNullOrWhiteSpace($runtimeEnvironmentName)
} else {
    [string]::Equals(
        $runtimeEnvironmentName,
        [string]$selectedRoleRequirement.githubEnvironment,
        [StringComparison]::Ordinal
    )
}
$runnerEnvironmentReady = (Test-EnvironmentVariablePresent 'RUNNER_ENVIRONMENT') -and
    [string]::Equals(
        $env:RUNNER_ENVIRONMENT,
        [string]$selectedRoleRequirement.runnerEnvironment,
        [StringComparison]::OrdinalIgnoreCase
    )
$trustedRunnerIdValue = if ([bool]$selectedRoleRequirement.registeredRunnerRequired) {
    [Environment]::GetEnvironmentVariable([string]$selectedRoleRequirement.trustedRunnerIdVariable, 'Process')
} else {
    $null
}
$trustedRunnerId = [uint64]0
$trustedRunnerIdProvided = -not [string]::IsNullOrWhiteSpace($trustedRunnerIdValue)
$trustedRunnerIdValid = if ([bool]$selectedRoleRequirement.registeredRunnerRequired) {
    $trustedRunnerIdProvided -and $trustedRunnerIdValue -match '^[1-9][0-9]*$' -and
        [uint64]::TryParse($trustedRunnerIdValue, [ref]$trustedRunnerId)
} else {
    $true
}
$standardRuntimeReady = (Test-EnvironmentVariablePresent 'GITHUB_ACTIONS') -and
    [string]::Equals($env:GITHUB_ACTIONS, 'true', [StringComparison]::OrdinalIgnoreCase) -and
    (Test-EnvironmentVariablePresent 'RUNNER_NAME') -and
    (Test-EnvironmentVariablePresent 'RUNNER_OS') -and
    [string]::Equals($env:RUNNER_OS, 'Windows', [StringComparison]::OrdinalIgnoreCase) -and
    (Test-EnvironmentVariablePresent 'RUNNER_ARCH') -and
    [string]::Equals($env:RUNNER_ARCH, 'X64', [StringComparison]::OrdinalIgnoreCase) -and
    $runnerEnvironmentReady -and
    (Test-EnvironmentVariablePresent 'GITHUB_REPOSITORY') -and
    [string]::Equals($env:GITHUB_REPOSITORY, $Repository, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-EnvironmentVariablePresent 'GITHUB_RUN_ID') -and $env:GITHUB_RUN_ID -match '^\d+$' -and
    (Test-EnvironmentVariablePresent 'GITHUB_RUN_ATTEMPT') -and $env:GITHUB_RUN_ATTEMPT -match '^\d+$' -and
    (Test-EnvironmentVariablePresent 'GITHUB_JOB') -and
    [string]::Equals($env:GITHUB_JOB, [string]$selectedRoleRequirement.workflowJobId, [StringComparison]::Ordinal) -and
    (Test-EnvironmentVariablePresent 'GITHUB_SHA') -and $env:GITHUB_SHA -match '^[0-9a-fA-F]{40}$' -and
    (Test-EnvironmentVariablePresent 'GITHUB_REF') -and
    (Test-EnvironmentVariablePresent 'GITHUB_WORKFLOW_REF') -and
    $env:GITHUB_WORKFLOW_REF.StartsWith(
        "$Repository/.github/workflows/phase5-windows.yml@",
        [StringComparison]::OrdinalIgnoreCase
    ) -and
    (Test-EnvironmentVariablePresent 'GITHUB_WORKFLOW_SHA') -and
    [string]::Equals($env:GITHUB_WORKFLOW_SHA, $env:GITHUB_SHA, [StringComparison]::OrdinalIgnoreCase)

$localHeadMatches = $false
try {
    $localHead = @(& git -C (Split-Path -Parent $PSScriptRoot) rev-parse HEAD 2>$null | Select-Object -First 1)
    $localHeadMatches = $LASTEXITCODE -eq 0 -and $localHead.Count -eq 1 -and
        [string]::Equals($localHead[0].Trim(), $env:GITHUB_SHA, [StringComparison]::OrdinalIgnoreCase)
} catch {
    $localHeadMatches = $false
}
$workflowDeclarationReady = $standardRuntimeReady -and $localHeadMatches -and
    (Test-CurrentWorkflowDeclaration `
        -JobId ([string]$selectedRoleRequirement.workflowJobId) `
        -ExpectedEnvironment ([string]$selectedRoleRequirement.githubEnvironment) `
        -ExpectedLabels @($selectedRoleRequirement.labels))

$currentJobInventoryAvailable = $false
$currentJobInventoryComplete = $false
$matchingCurrentJobCount = 0
$currentJobLabelsReady = $false
$currentJobTrustedRunnerIdReady = -not [bool]$selectedRoleRequirement.registeredRunnerRequired
if ($standardRuntimeReady -and $ghInstalled) {
    $jobResponse = Invoke-GhJson -Arguments @(
        'api',
        "repos/$Repository/actions/runs/$($env:GITHUB_RUN_ID)/attempts/$($env:GITHUB_RUN_ATTEMPT)/jobs?filter=latest&per_page=100"
    )
    if ($null -ne $jobResponse) {
        $jobs = @(Get-ObjectPropertyValue -InputObject $jobResponse -Name 'jobs')
        $jobTotalCount = Get-ObjectPropertyValue -InputObject $jobResponse -Name 'total_count'
        $currentJobInventoryAvailable = $true
        $currentJobInventoryComplete = $null -ne $jobTotalCount -and [int]$jobTotalCount -eq $jobs.Count
        $matchingJobs = @($jobs | Where-Object {
            [string]::Equals(
                [string](Get-ObjectPropertyValue -InputObject $_ -Name 'runner_name'),
                [string]$env:RUNNER_NAME,
                [StringComparison]::Ordinal
            ) -and [string]::Equals(
                [string](Get-ObjectPropertyValue -InputObject $_ -Name 'name'),
                [string]$selectedRoleRequirement.workflowJobName,
                [StringComparison]::Ordinal
            ) -and [string]::Equals(
                [string](Get-ObjectPropertyValue -InputObject $_ -Name 'head_sha'),
                [string]$env:GITHUB_SHA,
                [StringComparison]::OrdinalIgnoreCase
            ) -and [string](Get-ObjectPropertyValue -InputObject $_ -Name 'status') -eq 'in_progress'
        })
        $matchingCurrentJobCount = $matchingJobs.Count
        if ($matchingJobs.Count -eq 1) {
            $currentJobLabels = @((Get-ObjectPropertyValue -InputObject $matchingJobs[0] -Name 'labels') |
                ForEach-Object { [string]$_ })
            $currentJobLabelsReady = Test-LabelSet -Actual $currentJobLabels -Required @($selectedRoleRequirement.labels)
            if ([bool]$selectedRoleRequirement.registeredRunnerRequired -and $trustedRunnerIdValid) {
                $jobRunnerIdValue = Get-ObjectPropertyValue -InputObject $matchingJobs[0] -Name 'runner_id'
                $jobRunnerId = [uint64]0
                $currentJobTrustedRunnerIdReady = $null -ne $jobRunnerIdValue -and
                    [uint64]::TryParse([string]$jobRunnerIdValue, [ref]$jobRunnerId) -and
                    $jobRunnerId -eq $trustedRunnerId
            }
        }
    }
}

$matchingCurrentRunnerCount = 0
$remoteCurrentRunnerReady = -not [bool]$selectedRoleRequirement.registeredRunnerRequired
if ([bool]$selectedRoleRequirement.registeredRunnerRequired -and $trustedRunnerIdValid) {
    $matchingCurrentRunnerCount = @($remoteRunners | Where-Object {
        $runnerLabels = @((Get-ObjectPropertyValue -InputObject $_ -Name 'labels') | ForEach-Object {
            [string](Get-ObjectPropertyValue -InputObject $_ -Name 'name')
        })
        $remoteRunnerIdValue = Get-ObjectPropertyValue -InputObject $_ -Name 'id'
        $remoteRunnerId = [uint64]0
        $remoteRunnerIdMatches = $null -ne $remoteRunnerIdValue -and
            [uint64]::TryParse([string]$remoteRunnerIdValue, [ref]$remoteRunnerId) -and
            $remoteRunnerId -eq $trustedRunnerId
        $remoteRunnerIdMatches -and [string]::Equals(
            [string](Get-ObjectPropertyValue -InputObject $_ -Name 'name'),
            [string]$env:RUNNER_NAME,
            [StringComparison]::Ordinal
        ) -and [string](Get-ObjectPropertyValue -InputObject $_ -Name 'status') -eq 'online' -and
        [bool](Get-ObjectPropertyValue -InputObject $_ -Name 'busy') -and
        (Test-LabelSet -Actual $runnerLabels -Required @($selectedRoleRequirement.labels))
    }).Count
    $remoteCurrentRunnerReady = $runnerInventoryAvailable -and $runnerInventoryComplete -and
        $matchingCurrentRunnerCount -eq 1
}
$remoteCurrentJobReady = $currentJobInventoryAvailable -and $currentJobInventoryComplete -and
    $matchingCurrentJobCount -eq 1 -and $currentJobLabelsReady -and $currentJobTrustedRunnerIdReady

$selectedEnvironmentProtectionReady = if ($null -eq $selectedRoleRequirement.githubEnvironment) {
    $true
} else {
    $environmentSummaries.Contains([string]$selectedRoleRequirement.githubEnvironment) -and
        [bool]$environmentSummaries[[string]$selectedRoleRequirement.githubEnvironment].ready
}
$environmentReady = $declaredEnvironmentReady -and $runtimeEnvironmentReady -and
    $workflowDeclarationReady -and $selectedEnvironmentProtectionReady
$missingRuntimeVariables = @($selectedRoleRequirement.runtimeVariables |
    Where-Object { -not (Test-EnvironmentVariablePresent $_) })
$runtimeVariablesReady = $missingRuntimeVariables.Count -eq 0
$selectedRunnerReady = $declaredLabelsReady -and $environmentReady -and
    $standardRuntimeReady -and $runtimeVariablesReady -and
    $remoteCurrentRunnerReady -and $remoteCurrentJobReady
Add-PreflightGate -Id 'CURRENT_GITHUB_ACTIONS_ROLE_CONTEXT' -Passed $selectedRunnerReady `
    -BlockerCode 'CURRENT_GITHUB_ACTIONS_ROLE_CONTEXT_UNREADY' -Observed ([ordered]@{
        role = $RunnerRole
        requiredLabels = @($selectedRoleRequirement.labels)
        declaredLabelCount = @($RunnerLabels | Select-Object -Unique).Count
        labelSetMatches = $declaredLabelsReady
        requiredEnvironment = if ($null -eq $selectedRoleRequirement.githubEnvironment) { 'NONE' } else { $selectedRoleRequirement.githubEnvironment }
        declaredEnvironmentMatches = $declaredEnvironmentReady
        runtimeEnvironmentMatches = $runtimeEnvironmentReady
        workflowDeclarationMatches = $workflowDeclarationReady
        selectedEnvironmentProtectionReady = $selectedEnvironmentProtectionReady
        environmentMatches = $environmentReady
        standardActionsContextReady = $standardRuntimeReady
        expectedRunnerEnvironmentMatches = $runnerEnvironmentReady
        registeredRunnerRequired = [bool]$selectedRoleRequirement.registeredRunnerRequired
        trustedRunnerIdProvided = $trustedRunnerIdProvided
        trustedRunnerIdValid = $trustedRunnerIdValid
        localHeadMatchesWorkflowSha = $localHeadMatches
        remoteCurrentRunnerMatchCount = $matchingCurrentRunnerCount
        remoteCurrentRunnerReady = $remoteCurrentRunnerReady
        currentJobInventoryAvailable = $currentJobInventoryAvailable
        currentJobInventoryComplete = $currentJobInventoryComplete
        remoteCurrentJobMatchCount = $matchingCurrentJobCount
        remoteCurrentJobLabelsReady = $currentJobLabelsReady
        remoteCurrentJobTrustedRunnerIdReady = $currentJobTrustedRunnerIdReady
        requiredRuntimeVariableCount = $selectedRoleRequirement.runtimeVariables.Count
        presentRuntimeVariableCount = $selectedRoleRequirement.runtimeVariables.Count - $missingRuntimeVariables.Count
    })

$allPassed = @($gates | Where-Object status -ne 'PASS').Count -eq 0
$status = if ($allPassed) { 'PASS' } else { 'BLOCKED' }
$report = [ordered]@{
    schemaVersion = 'phase5-environment-preflight-v1'
    mode = $Mode
    status = $status
    formalEnvironmentReady = $allPassed
    acceptance = $false
    selectedProfile = $HardwareProfile
    selectedRunnerRole = $RunnerRole
    gates = @($gates)
    blockerCodes = @($blockerCodes | Sort-Object)
    privacy = [ordered]@{
        safeOutput = $true
        excludedIdentityFields = @(
            'user-name',
            'machine-name',
            'device-serial',
            'certificate-subject',
            'certificate-thumbprint',
            'filesystem-path',
            'process-id'
        )
        secretValuesEmitted = $false
        rawProbeErrorsEmitted = $false
    }
    boundary = 'Environment readiness only. PASS does not constitute Phase 5 product or release acceptance.'
}

$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}
$outputJson = ($report | ConvertTo-Json -Depth 12) + [Environment]::NewLine
$outputBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($outputJson)
$outputStream = [IO.File]::Open(
    $resolvedOutputPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
)
try {
    $outputStream.Write($outputBytes, 0, $outputBytes.Length)
    $outputStream.Flush($true)
} finally {
    $outputStream.Dispose()
}
Write-Host "[phase5:environment-preflight] $status"

if ($Mode -eq 'Formal' -and -not $allPassed) {
    exit 2
}

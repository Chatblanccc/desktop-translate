[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Capture')]
    [string]$Mode = 'Preflight',

    [string]$CandidateGenerationBindingSetSha256,

    [string]$WorkloadScript,

    [ValidateSet('Node', 'Electron')]
    [string]$WorkloadRuntime = 'Electron',

    [string[]]$WorkloadArgument = @(),

    [string]$OutputDirectory,

    [string]$IsolatedCleanVmAttestation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..\..')
)
$artifactRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'artifacts\phase7\offline-poc')
)
$toolingRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$captureActive = $false

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

function Test-Sha256 {
    param([string]$Value)
    return $Value -match '^[a-f0-9]{64}$'
}

function Test-StrictChildPath {
    param(
        [string]$Parent,
        [string]$Child
    )
    return $null -ne (Get-RelativeChildPath -Parent $Parent -Child $Child)
}

function Get-RelativeChildPath {
    param(
        [string]$Parent,
        [string]$Child
    )
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
    )
    $childFull = [System.IO.Path]::GetFullPath($Child)
    $prefix = "$parentFull$separator"
    if (
        -not $childFull.StartsWith(
            $prefix,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        return $null
    }
    $relative = $childFull.Substring($prefix.Length)
    if ([string]::IsNullOrWhiteSpace($relative)) {
        return $null
    }
    return $relative
}

function Assert-NoReparsePoints {
    param(
        [string]$Root,
        [string]$Target
    )
    if (-not (Test-StrictChildPath -Parent $Root -Child $Target)) {
        throw 'PHASE7_NETWORK_CAPTURE_PATH_OUTSIDE_ALLOWED_ROOT'
    }
    $relative = Get-RelativeChildPath -Parent $Root -Child $Target
    $current = $Root
    foreach ($segment in $relative.Split(
        [System.IO.Path]::DirectorySeparatorChar,
        [StringSplitOptions]::RemoveEmptyEntries
    )) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) {
            break
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'PHASE7_NETWORK_CAPTURE_REPARSE_POINT_REJECTED'
        }
    }
}

function Get-FirewallState {
    return @(Get-NetFirewallProfile | Sort-Object Name | ForEach-Object {
        [ordered]@{
            name = [string]$_.Name
            enabled = [bool]$_.Enabled
            defaultInboundAction = [string]$_.DefaultInboundAction
            defaultOutboundAction = [string]$_.DefaultOutboundAction
            logAllowed = [bool]$_.LogAllowed
            logBlocked = [bool]$_.LogBlocked
        }
    })
}

function Get-Preflight {
    $administrator = Test-IsAdministrator
    $pktmonCommand = Get-Command pktmon.exe -ErrorAction SilentlyContinue
    $firewallProfiles = @()
    $firewallQuerySucceeded = $false
    try {
        $firewallProfiles = @(Get-FirewallState)
        $firewallQuerySucceeded = $true
    } catch {
        $firewallProfiles = @()
    }
    $allFirewallProfilesEnabled = $firewallQuerySucceeded -and
        $firewallProfiles.Count -ge 3 -and
        @($firewallProfiles | Where-Object { -not $_.enabled }).Count -eq 0
    $pktmonDriverAccessible = $false
    $pktmonStatusExitCode = $null
    if ($null -ne $pktmonCommand -and $administrator) {
        & $pktmonCommand.Source status *> $null
        $pktmonStatusExitCode = $LASTEXITCODE
        $pktmonDriverAccessible = $LASTEXITCODE -eq 0
    }
    $blockers = [Collections.Generic.List[string]]::new()
    if (-not $administrator) {
        $blockers.Add('ADMINISTRATOR_SESSION_REQUIRED')
    }
    if ($null -eq $pktmonCommand) {
        $blockers.Add('PKTMON_NOT_AVAILABLE')
    } elseif ($administrator -and -not $pktmonDriverAccessible) {
        $blockers.Add('PKTMON_DRIVER_NOT_ACCESSIBLE')
    }
    if (-not $firewallQuerySucceeded) {
        $blockers.Add('WINDOWS_FIREWALL_PROFILE_QUERY_FAILED')
    } elseif (-not $allFirewallProfilesEnabled) {
        $blockers.Add('WINDOWS_FIREWALL_PROFILE_DISABLED')
    }
    return [ordered]@{
        schemaVersion = 'phase7-os-network-capture-preflight-v1'
        status = if ($blockers.Count -eq 0) {
            'READY_FOR_ISOLATED_ADMINISTRATOR_CAPTURE'
        } else {
            'NOT_READY_FOR_OS_NETWORK_CAPTURE'
        }
        administrator = $administrator
        pktmonAvailable = $null -ne $pktmonCommand
        pktmonDriverAccessible = $pktmonDriverAccessible
        pktmonStatusExitCode = $pktmonStatusExitCode
        firewallProfileQuerySucceeded = $firewallQuerySucceeded
        allFirewallProfilesEnabled = $allFirewallProfilesEnabled
        firewallProfiles = $firewallProfiles
        blockers = @($blockers)
        systemStateChanged = $false
        capturePerformed = $false
        osLevelVerified = $false
        integrationOrDistributionAuthorized = $false
        gateAInputStatus = 'GATE_A_INPUT_INCOMPLETE'
    }
}

function Write-JsonNew {
    param(
        [string]$Path,
        [object]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 12
    $encoding = [Text.UTF8Encoding]::new($false)
    $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $writer = [IO.StreamWriter]::new($stream, $encoding)
        try {
            $writer.Write($json)
            $writer.Write("`n")
        } finally {
            $writer.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Invoke-Capture {
    $preflight = Get-Preflight
    if ($preflight.status -ne 'READY_FOR_ISOLATED_ADMINISTRATOR_CAPTURE') {
        throw "PHASE7_NETWORK_CAPTURE_PREFLIGHT_FAILED:$(
            $preflight.blockers -join ','
        )"
    }
    if (
        $IsolatedCleanVmAttestation -ne
            'I-CONFIRM-ISOLATED-CLEAN-VM-NO-UNRELATED-TRAFFIC'
    ) {
        throw 'PHASE7_NETWORK_CAPTURE_CLEAN_VM_ATTESTATION_REQUIRED'
    }
    if (-not (Test-Sha256 $CandidateGenerationBindingSetSha256)) {
        throw 'PHASE7_NETWORK_CAPTURE_CANDIDATE_BINDING_INVALID'
    }
    if (
        [string]::IsNullOrWhiteSpace($WorkloadScript) -or
        [string]::IsNullOrWhiteSpace($OutputDirectory)
    ) {
        throw 'PHASE7_NETWORK_CAPTURE_REQUIRED_ARGUMENT_MISSING'
    }
    $resolvedWorkload = [IO.Path]::GetFullPath(
        (Join-Path $repositoryRoot $WorkloadScript)
    )
    $workloadOutsideTooling = -not (
        Test-StrictChildPath -Parent $toolingRoot -Child $resolvedWorkload
    )
    $workloadExtensionInvalid =
        [IO.Path]::GetExtension($resolvedWorkload) -ne '.mjs'
    $workloadMissing =
        -not (Test-Path -LiteralPath $resolvedWorkload -PathType Leaf)
    if (
        $workloadOutsideTooling -or
        $workloadExtensionInvalid -or
        $workloadMissing
    ) {
        throw 'PHASE7_NETWORK_CAPTURE_WORKLOAD_OUTSIDE_TOOLING_ROOT'
    }
    Assert-NoReparsePoints -Root $toolingRoot -Target $resolvedWorkload
    $resolvedOutput = [IO.Path]::GetFullPath(
        (Join-Path $repositoryRoot $OutputDirectory)
    )
    Assert-NoReparsePoints -Root $artifactRoot -Target $resolvedOutput
    if (Test-Path -LiteralPath $resolvedOutput) {
        throw 'PHASE7_NETWORK_CAPTURE_OUTPUT_ALREADY_EXISTS'
    }
    New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
    $etlPath = Join-Path $resolvedOutput 'capture.etl'
    $pcapPath = Join-Path $resolvedOutput 'capture.pcapng'
    $stdoutPath = Join-Path $resolvedOutput 'workload.stdout.private.txt'
    $stderrPath = Join-Path $resolvedOutput 'workload.stderr.private.txt'
    $firewallBeforePath = Join-Path $resolvedOutput 'firewall-before.json'
    $firewallAfterPath = Join-Path $resolvedOutput 'firewall-after.json'
    $receiptPath = Join-Path $resolvedOutput 'collection-receipt.json'
    $firewallBefore = Get-FirewallState
    Write-JsonNew -Path $firewallBeforePath -Value $firewallBefore
    $pktmon = (Get-Command pktmon.exe).Source
    if ($WorkloadRuntime -eq 'Electron') {
        $electronPackage = Get-Item -LiteralPath (
            Join-Path $repositoryRoot 'node_modules\electron'
        ) -Force -ErrorAction Stop
        if (
            ($electronPackage.Attributes -band
                [IO.FileAttributes]::ReparsePoint) -ne 0
        ) {
            if (
                @($electronPackage.Target).Count -ne 1 -or
                -not (Test-StrictChildPath -Parent $repositoryRoot `
                    -Child ([string]$electronPackage.Target[0]))
            ) {
                throw 'PHASE7_NETWORK_CAPTURE_ELECTRON_LINK_UNSAFE'
            }
            $electronPackageRoot = [IO.Path]::GetFullPath(
                [string]$electronPackage.Target[0]
            )
        } else {
            $electronPackageRoot = $electronPackage.FullName
        }
        $workloadExecutable = [IO.Path]::GetFullPath(
            (Join-Path $electronPackageRoot 'dist\electron.exe')
        )
        if (-not (Test-Path -LiteralPath $workloadExecutable -PathType Leaf)) {
            throw 'PHASE7_NETWORK_CAPTURE_ELECTRON_RUNTIME_MISSING'
        }
        Assert-NoReparsePoints -Root $repositoryRoot `
            -Target $workloadExecutable
    } else {
        $workloadExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    try {
        & $pktmon start --capture --comp nics --pkt-size 128 `
            --file-name $etlPath *> $null
        if ($LASTEXITCODE -ne 0) {
            throw 'PHASE7_NETWORK_CAPTURE_PKTMON_START_FAILED'
        }
        $captureActive = $true
        Push-Location $repositoryRoot
        try {
            & $workloadExecutable $resolvedWorkload @WorkloadArgument `
                1> $stdoutPath 2> $stderrPath
            $workloadExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($workloadExitCode -ne 0) {
            throw "PHASE7_NETWORK_CAPTURE_WORKLOAD_FAILED:$workloadExitCode"
        }
    } finally {
        if ($captureActive) {
            & $pktmon stop *> $null
            $captureActive = $false
        }
    }
    & $pktmon etl2pcap $etlPath --out $pcapPath *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pcapPath)) {
        throw 'PHASE7_NETWORK_CAPTURE_PCAP_CONVERSION_FAILED'
    }
    $firewallAfter = Get-FirewallState
    Write-JsonNew -Path $firewallAfterPath -Value $firewallAfter
    if (
        ($firewallBefore | ConvertTo-Json -Depth 8 -Compress) -ne
        ($firewallAfter | ConvertTo-Json -Depth 8 -Compress)
    ) {
        throw 'PHASE7_NETWORK_CAPTURE_FIREWALL_STATE_CHANGED'
    }
    $pcapItem = Get-Item -LiteralPath $pcapPath
    $receipt = [ordered]@{
        schemaVersion = 'phase7-os-network-capture-collection-v1'
        status = 'OS_NETWORK_CAPTURE_COLLECTED_PENDING_MANUAL_ANALYSIS'
        scope = 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION'
        candidateGenerationBindingSetSha256 =
            $CandidateGenerationBindingSetSha256
        methodPreparation = 'WINDOWS_FIREWALL_STATE_AND_PKTMON_PACKET_CAPTURE'
        workloadRuntime = $WorkloadRuntime
        cleanVmAttestationRecorded = $true
        packetPrefixBytesCaptured = 128
        pcapSha256 = (
            Get-FileHash -LiteralPath $pcapPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        pcapSizeBytes = [int64]$pcapItem.Length
        firewallStateStable = $true
        workloadExitCode = 0
        observedExternalConnectionCount = $null
        manualAnalysisComplete = $false
        finalGateAOsNetworkVerificationCreated = $false
        osLevelVerified = $false
        rawCaptureContainsPotentialNetworkMetadata = $true
        rawCaptureMustRemainPrivate = $true
        absolutePathsEmitted = $false
        usernamesEmitted = $false
        integrationOrDistributionAuthorized = $false
        gateAInputStatus = 'GATE_A_INPUT_INCOMPLETE'
        startedAt = $startedAt
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-JsonNew -Path $receiptPath -Value $receipt
    return $receipt
}

try {
    if ($Mode -eq 'Preflight') {
        Get-Preflight | ConvertTo-Json -Depth 10
    } else {
        Invoke-Capture | ConvertTo-Json -Depth 10
    }
} catch {
    [ordered]@{
        status = 'FAILED_CLOSED'
        errorCode = [string]$_.Exception.Message
        captureActiveAfterFailure = $captureActive
        osLevelVerified = $false
        integrationOrDistributionAuthorized = $false
        gateAInputStatus = 'GATE_A_INPUT_INCOMPLETE'
    } | ConvertTo-Json -Depth 6 | Write-Error
    exit 1
}

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter()][ValidateRange(5, 120)][int]$DurationSeconds = 20,
    [Parameter()][ValidateRange(50, 1000)][int]$PollMilliseconds = 100,
    [Parameter()][ValidateRange(1, 10)][int]$PostMatchSeconds = 3,
    [Parameter()][string]$ProviderHost = 'fanyi-api.baidu.com'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not [System.IO.Path]::IsPathRooted($OutputPath) -or $fullOutputPath.StartsWith('\\')) {
    throw 'The network observation output must be an absolute local path.'
}
if ($fullOutputPath.Substring(2).Contains(':')) {
    throw 'The network observation output must not use an alternate data stream.'
}

$observationErrors = [System.Collections.Generic.List[string]]::new()
$dnsAddresses = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($recordType in @('A', 'AAAA')) {
    try {
        Resolve-DnsName -Name $ProviderHost -Type $recordType -DnsOnly -ErrorAction Stop |
            Where-Object { $_.Type -eq $recordType -and $_.IPAddress } |
            ForEach-Object { [void]$dnsAddresses.Add([string]$_.IPAddress) }
    } catch {
        [void]$observationErrors.Add("dns-$($recordType.ToLowerInvariant())-failed")
    }
}

$processMap = @{}
$connectionMap = @{}
$providerConnectionSeenAtUtc = $null
$startedUtc = [DateTime]::UtcNow
$deadlineUtc = $startedUtc.AddSeconds($DurationSeconds)

function Get-WorkspaceProcesses {
    $result = @()
    foreach ($candidate in @(Get-Process -Name 'electron', 'selection-host' -ErrorAction SilentlyContinue)) {
        try {
            if (-not $candidate.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
        } catch {
            continue
        }

        $commandLine = $null
        $parentProcessId = 0
        try {
            $processInfo = Get-CimInstance -ClassName Win32_Process `
                -Filter "ProcessId = $($candidate.Id)" -ErrorAction Stop
            $commandLine = [string]$processInfo.CommandLine
            $parentProcessId = [int]$processInfo.ParentProcessId
        } catch {
            [void]$observationErrors.Add('process-metadata-failed')
        }

        $role = if ($candidate.ProcessName -eq 'selection-host') {
            'native-host'
        } elseif ($commandLine -match '(?:^|\s)--type=renderer(?:\s|$)') {
            'renderer'
        } elseif ($commandLine -match '(?:^|\s)--type=utility(?:\s|$)') {
            'utility'
        } elseif ($commandLine -match '(?:^|\s)--type=') {
            'electron-child'
        } else {
            'main'
        }

        $result += [pscustomobject]@{
            processId = [int]$candidate.Id
            parentProcessId = $parentProcessId
            imageName = "$($candidate.ProcessName).exe"
            role = $role
        }
    }
    return @($result)
}

while ([DateTime]::UtcNow -lt $deadlineUtc) {
    $workspaceProcesses = @(Get-WorkspaceProcesses)
    foreach ($workspaceProcess in $workspaceProcesses) {
        $processKey = [string]$workspaceProcess.processId
        if (-not $processMap.ContainsKey($processKey)) {
            $processMap[$processKey] = $workspaceProcess
        }

        try {
            $connections = @(Get-NetTCPConnection -OwningProcess $workspaceProcess.processId `
                -ErrorAction SilentlyContinue)
            foreach ($connection in $connections) {
                $remoteAddress = [string]$connection.RemoteAddress
                if ($remoteAddress.StartsWith('::ffff:', [System.StringComparison]::OrdinalIgnoreCase)) {
                    $remoteAddress = $remoteAddress.Substring(7)
                }
                $connectionKey = '{0}|{1}|{2}' -f `
                    $workspaceProcess.processId, $remoteAddress, $connection.RemotePort
                $nowUtc = [DateTime]::UtcNow.ToString('o')
                if (-not $connectionMap.ContainsKey($connectionKey)) {
                    $dnsMatch = $dnsAddresses.Contains($remoteAddress)
                    $connectionMap[$connectionKey] = [ordered]@{
                        owningProcessId = [int]$workspaceProcess.processId
                        role = [string]$workspaceProcess.role
                        remoteAddress = $remoteAddress
                        remotePort = [int]$connection.RemotePort
                        state = [string]$connection.State
                        dnsMatch = $dnsMatch
                        firstSeenUtc = $nowUtc
                        lastSeenUtc = $nowUtc
                        samples = 1
                    }
                    if (
                        $connection.RemotePort -eq 443 -and
                        $dnsMatch -and
                        $null -eq $providerConnectionSeenAtUtc
                    ) {
                        $providerConnectionSeenAtUtc = [DateTime]::UtcNow
                    }
                } else {
                    $connectionMap[$connectionKey].lastSeenUtc = $nowUtc
                    $connectionMap[$connectionKey].samples += 1
                    $connectionMap[$connectionKey].state = [string]$connection.State
                }
            }
        } catch {
            [void]$observationErrors.Add('tcp-observation-failed')
        }
    }
    if (
        $null -ne $providerConnectionSeenAtUtc -and
        [DateTime]::UtcNow -ge $providerConnectionSeenAtUtc.AddSeconds($PostMatchSeconds)
    ) {
        break
    }
    Start-Sleep -Milliseconds $PollMilliseconds
}

$connectionsObserved = @($connectionMap.Values | ForEach-Object { [pscustomobject]$_ })
$providerConnections = @(
    $connectionsObserved | Where-Object { $_.remotePort -eq 443 -and $_.dnsMatch }
)
$rendererProviderConnections = @(
    $providerConnections | Where-Object { $_.role -eq 'renderer' }
)
$nativeHostConnections = @(
    $connectionsObserved | Where-Object { $_.role -eq 'native-host' }
)
$uniqueErrors = @($observationErrors | Sort-Object -Unique)
$record = [ordered]@{
    schemaVersion = 1
    startedUtc = $startedUtc.ToString('o')
    endedUtc = [DateTime]::UtcNow.ToString('o')
    providerHost = $ProviderHost
    dnsAddresses = @($dnsAddresses | Sort-Object)
    processes = @($processMap.Values | Sort-Object processId)
    connections = @($connectionsObserved | Sort-Object owningProcessId, remoteAddress, remotePort)
    providerConnectionCount = $providerConnections.Count
    rendererProviderConnectionCount = $rendererProviderConnections.Count
    nativeHostConnectionCount = $nativeHostConnections.Count
    errors = $uniqueErrors
}

$outputDirectory = Split-Path -Parent $fullOutputPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $outputDirectory -Force)
}
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
    $fullOutputPath,
    (($record | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    $utf8WithoutBom
)

Write-Host "[phase4:network] Processes: $($processMap.Count)"
Write-Host "[phase4:network] Provider connections: $($providerConnections.Count)"
Write-Host "[phase4:network] Renderer provider connections: $($rendererProviderConnections.Count)"
Write-Host "[phase4:network] Native Host connections: $($nativeHostConnections.Count)"
Write-Host "[phase4:network] Evidence: $fullOutputPath"
if ($processMap.Count -eq 0 -or $providerConnections.Count -eq 0) {
    exit 2
}
if ($rendererProviderConnections.Count -ne 0 -or $nativeHostConnections.Count -ne 0) {
    exit 3
}

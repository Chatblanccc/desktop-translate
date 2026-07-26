[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'phase7-os-network-capture.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw

$requiredPatterns = @(
    "ValidateSet\('Preflight', 'Capture'\)",
    "ValidateSet\('Node', 'Electron'\)",
    'ADMINISTRATOR_SESSION_REQUIRED',
    'I-CONFIRM-ISOLATED-CLEAN-VM-NO-UNRELATED-TRAFFIC',
    'PHASE7_NETWORK_CAPTURE_CANDIDATE_BINDING_INVALID',
    'Assert-NoReparsePoints',
    'PKTMON_DRIVER_NOT_ACCESSIBLE',
    'WINDOWS_FIREWALL_PROFILE_DISABLED',
    'pktmon start --capture --comp nics --pkt-size 128',
    'PHASE7_NETWORK_CAPTURE_ELECTRON_LINK_UNSAFE',
    "dist\\electron.exe",
    'finally \{[\s\S]*?pktmon stop',
    'OS_NETWORK_CAPTURE_COLLECTED_PENDING_MANUAL_ANALYSIS',
    'observedExternalConnectionCount = \$null',
    'manualAnalysisComplete = \$false',
    'finalGateAOsNetworkVerificationCreated = \$false',
    'osLevelVerified = \$false',
    'integrationOrDistributionAuthorized = \$false',
    'rawCaptureMustRemainPrivate = \$true'
)
foreach ($pattern in $requiredPatterns) {
    if ($source -notmatch $pattern) {
        throw "PHASE7_OS_NETWORK_CAPTURE_SELFTEST_PATTERN_MISSING:$pattern"
    }
}
if (
    $source -match
        "status = 'OS_LEVEL_NO_EXTERNAL_TRAFFIC_OBSERVED'" -or
    $source -match 'osLevelVerified = \$true' -or
    $source -match 'observedExternalConnectionCount = 0'
) {
    throw 'PHASE7_OS_NETWORK_CAPTURE_SELFTEST_PREMATURE_PASS_DETECTED'
}

$preflightRaw = & powershell -NoProfile -ExecutionPolicy Bypass `
    -File $scriptPath -Mode Preflight
if ($LASTEXITCODE -ne 0) {
    throw 'PHASE7_OS_NETWORK_CAPTURE_SELFTEST_PREFLIGHT_FAILED'
}
$preflight = $preflightRaw | ConvertFrom-Json
if (
    $preflight.schemaVersion -ne
        'phase7-os-network-capture-preflight-v1' -or
    $preflight.systemStateChanged -ne $false -or
    $preflight.capturePerformed -ne $false -or
    $preflight.osLevelVerified -ne $false -or
    $preflight.integrationOrDistributionAuthorized -ne $false
) {
    throw 'PHASE7_OS_NETWORK_CAPTURE_SELFTEST_PREFLIGHT_CONTRACT_INVALID'
}

[ordered]@{
    status = 'PHASE7_OS_NETWORK_CAPTURE_SELF_TEST_PASS'
    preflightStatus = $preflight.status
    administratorRequired = $true
    isolatedCleanVmAttestationRequired = $true
    captureCleanupInFinally = $true
    rawCaptureRemainsPrivate = $true
    manualAnalysisRequired = $true
    prematureZeroExternalTrafficClaimRejected = $true
    osLevelVerified = $false
    integrationOrDistributionAuthorized = $false
} | ConvertTo-Json -Depth 6

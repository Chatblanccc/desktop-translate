[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

$runner = Join-Path $PSScriptRoot 'phase5-environment-preflight.ps1'
$shell = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) {
    $shell = Join-Path $PSHOME 'powershell.exe'
}
if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) {
    throw 'No isolated PowerShell host is available for the environment preflight negative tests.'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('desktop-translate-phase5-environment-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$canarySubject = 'CN=PHASE5_PREFLIGHT_PRIVATE_CANARY_DO_NOT_EMIT'

try {
    $developmentOutput = Join-Path $testRoot 'development.json'
    & $shell -NoLogo -NoProfile -File $runner `
        -Mode Development `
        -HardwareProfile C `
        -RunnerRole Release `
        -OutputPath $developmentOutput `
        -ExpectedPublisherSubject $canarySubject
    Assert-True ($LASTEXITCODE -eq 0) 'Development mode must emit a BLOCKED report without failing the caller.'
    Assert-True (Test-Path -LiteralPath $developmentOutput -PathType Leaf) 'Development mode did not emit JSON.'
    $developmentBytes = [IO.File]::ReadAllBytes($developmentOutput)
    $hasUtf8Bom = $developmentBytes.Length -ge 3 -and
        $developmentBytes[0] -eq 0xEF -and $developmentBytes[1] -eq 0xBB -and $developmentBytes[2] -eq 0xBF
    Assert-True (-not $hasUtf8Bom) 'Development report must be strict UTF-8 JSON without a BOM.'
    $developmentRaw = Get-Content -LiteralPath $developmentOutput -Raw -Encoding utf8
    $development = $developmentRaw | ConvertFrom-Json
    Assert-True ($development.schemaVersion -eq 'phase5-environment-preflight-v1') 'Development report schema is invalid.'
    Assert-True ($development.status -eq 'BLOCKED') 'An incomplete development environment was not BLOCKED.'
    Assert-True ($development.formalEnvironmentReady -eq $false) 'Development report claimed formal readiness.'
    $releaseAuthenticodeGate = @($development.gates | Where-Object id -eq 'AUTHENTICODE_EXPECTED_IDENTITY')
    Assert-True ($releaseAuthenticodeGate.Count -eq 1 -and $releaseAuthenticodeGate[0].status -eq 'BLOCKED' -and
        $releaseAuthenticodeGate[0].observed.authenticodeMode -eq 'SigningCertificate' -and
        $releaseAuthenticodeGate[0].observed.ephemeralSigningInputRequired -eq $true -and
        $releaseAuthenticodeGate[0].observed.ephemeralSigningInputLoaded -eq $false) `
        'Release did not fail closed on the missing exact ephemeral private-key signing input.'
    Assert-True (-not $developmentRaw.Contains($canarySubject)) 'The report leaked the explicit certificate subject.'
    & node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));" $developmentOutput
    Assert-True ($LASTEXITCODE -eq 0) 'Node strict JSON parsing rejected the environment report.'
    if (-not [string]::IsNullOrWhiteSpace($env:USERNAME)) {
        Assert-True (-not $developmentRaw.Contains($env:USERNAME)) 'The report leaked the current user name.'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) {
        Assert-True (-not $developmentRaw.Contains($env:COMPUTERNAME)) 'The report leaked the machine name.'
    }

    $formalOutput = Join-Path $testRoot 'formal.json'
    & $shell -NoLogo -NoProfile -File $runner `
        -Mode Formal `
        -HardwareProfile B `
        -RunnerRole Perf `
        -OutputPath $formalOutput
    Assert-True ($LASTEXITCODE -ne 0) 'Formal mode did not fail closed when required capabilities were absent.'
    Assert-True (Test-Path -LiteralPath $formalOutput -PathType Leaf) 'Formal failure did not preserve its JSON evidence.'
    $formal = Get-Content -LiteralPath $formalOutput -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($formal.status -eq 'BLOCKED') 'Formal negative report status is not BLOCKED.'
    Assert-True (@($formal.blockerCodes).Count -gt 0) 'Formal negative report has no stable blocker codes.'
    Assert-True (@($formal.gates | Where-Object status -eq 'BLOCKED').Count -gt 0) 'Formal negative report has no blocked gate.'
    $perfAuthenticodeGate = @($formal.gates | Where-Object id -eq 'AUTHENTICODE_EXPECTED_IDENTITY')
    Assert-True ($perfAuthenticodeGate.Count -eq 1 -and $perfAuthenticodeGate[0].status -eq 'PASS' -and
        $perfAuthenticodeGate[0].observed.authenticodeMode -eq 'None') `
        'Perf incorrectly required a local Authenticode identity instead of validating the signed input bundle.'

    $cleanDownloadOutput = Join-Path $testRoot 'clean-download.json'
    & $shell -NoLogo -NoProfile -File $runner `
        -Mode Development `
        -HardwareProfile B `
        -RunnerRole CleanDownload `
        -OutputPath $cleanDownloadOutput `
        -ExpectedPublisherSubject $canarySubject `
        -Repository 'owner/repository' `
        -RunnerLabels windows-2022 `
        -CurrentGitHubEnvironment phase5-release
    Assert-True ($LASTEXITCODE -eq 0) 'Clean-download development modeling failed to preserve reporting.'
    $cleanDownload = Get-Content -LiteralPath $cleanDownloadOutput -Raw -Encoding utf8 | ConvertFrom-Json
    $cleanAuthenticodeGate = @($cleanDownload.gates | Where-Object id -eq 'AUTHENTICODE_EXPECTED_IDENTITY')
    $cleanExclusiveGate = @($cleanDownload.gates | Where-Object id -eq 'EXCLUSIVE_INTERACTIVE_SESSION_DECLARATION')
    $cleanRunnerFleetGate = @($cleanDownload.gates | Where-Object id -eq 'GITHUB_ACTIONS_RUNNER_LABELS')
    Assert-True ($cleanAuthenticodeGate.Count -eq 1 -and $cleanAuthenticodeGate[0].status -eq 'PASS') `
        'Clean-download expected-subject mode incorrectly required a local private-key signing certificate.'
    Assert-True ($cleanAuthenticodeGate[0].observed.authenticodeMode -eq 'ExpectedSubject') `
        'Clean-download did not report ExpectedSubject Authenticode mode.'
    Assert-True ($cleanExclusiveGate.Count -eq 1 -and $cleanExclusiveGate[0].status -eq 'PASS' -and
        $cleanExclusiveGate[0].observed.required -eq $false) `
        'Clean-download incorrectly required an exclusive interactive session.'
    Assert-True ($cleanRunnerFleetGate.Count -eq 1 -and $cleanRunnerFleetGate[0].status -eq 'PASS' -and
        $cleanRunnerFleetGate[0].observed.registeredRunnerRequired -eq $false) `
        'Clean-download incorrectly required a registered self-hosted runner inventory.'

    & $shell -NoLogo -NoProfile -File $runner `
        -Mode Development `
        -HardwareProfile B `
        -RunnerRole Perf `
        -OutputPath $developmentOutput
    Assert-True ($LASTEXITCODE -ne 0) 'Environment evidence output was overwritten instead of remaining append-never.'

    $spoofedOutput = Join-Path $testRoot 'spoofed-runner-context.json'
    $spoofedSha = 'a' * 40
    $spoofScript = @"
`$env:GITHUB_ACTIONS = 'true'
`$env:RUNNER_NAME = 'phase5-untrusted-parameter-only-runner'
`$env:RUNNER_OS = 'Windows'
`$env:RUNNER_ARCH = 'X64'
`$env:RUNNER_ENVIRONMENT = 'self-hosted'
`$env:GITHUB_REPOSITORY = 'owner/repository'
`$env:GITHUB_RUN_ID = '1'
`$env:GITHUB_RUN_ATTEMPT = '1'
`$env:GITHUB_JOB = 'phase5-performance'
`$env:GITHUB_SHA = '$spoofedSha'
`$env:GITHUB_REF = 'refs/tags/phase5-rc-spoof'
`$env:GITHUB_WORKFLOW_REF = 'owner/repository/.github/workflows/phase5-windows.yml@refs/tags/phase5-rc-spoof'
`$env:GITHUB_WORKFLOW_SHA = '$spoofedSha'
`$env:CI = 'true'
`$env:PHASE5_LAB_RUNNER_ID = '918273645546372819'
& '$runner' -Mode Development -HardwareProfile B -RunnerRole Perf -Repository 'owner/repository' -RunnerLabels self-hosted,Windows,X64,phase5-lab -OutputPath '$spoofedOutput'
exit 0
"@
    & $shell -NoLogo -NoProfile -Command $spoofScript
    Assert-True ($LASTEXITCODE -eq 0) 'Spoofed development context did not preserve development-mode reporting.'
    $spoofed = Get-Content -LiteralPath $spoofedOutput -Raw -Encoding utf8 | ConvertFrom-Json
    $spoofedContextGate = @($spoofed.gates | Where-Object id -eq 'CURRENT_GITHUB_ACTIONS_ROLE_CONTEXT')
    Assert-True ($spoofedContextGate.Count -eq 1 -and $spoofedContextGate[0].status -eq 'BLOCKED') `
        'Runner/environment parameters and process variables alone forged the current Actions role gate.'
    Assert-True ($spoofedContextGate[0].observed.remoteCurrentRunnerReady -eq $false) `
        'Spoofed context unexpectedly matched a remote registered runner.'
    Assert-True ($spoofedContextGate[0].observed.trustedRunnerIdProvided -eq $true -and
        $spoofedContextGate[0].observed.trustedRunnerIdValid -eq $true) `
        'The numeric trusted-runner-id negative fixture was not evaluated.'
    Assert-True ($spoofedContextGate[0].observed.remoteCurrentJobMatchCount -eq 0) `
        'Spoofed context unexpectedly matched a remote run-attempt job.'
    Assert-True (-not (Get-Content -LiteralPath $spoofedOutput -Raw -Encoding utf8).Contains('918273645546372819')) `
        'The privacy-safe report leaked the trusted remote runner numeric ID.'

    $source = Get-Content -LiteralPath $runner -Raw -Encoding utf8
    Assert-True (-not $source.Contains('New-SelfSignedCertificate')) 'The preflight must never generate a self-signed certificate.'
    Assert-True (-not $source.Contains('X509RevocationMode]::NoCheck')) 'The preflight must never disable certificate revocation checks.'
    Assert-True ($source.Contains('X509RevocationMode]::Online')) 'The preflight does not require online certificate revocation confirmation.'
    Assert-True ($source.Contains('X509RevocationFlag]::EntireChain')) 'The preflight does not verify revocation across the entire chain.'
    $officialEnvironmentShape = @'
{"protection_rules":[{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":1}}],"prevent_self_review":true},{"type":"wait_timer","wait_timer":5}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
'@ | ConvertFrom-Json
    $shapeReviewerRule = @($officialEnvironmentShape.protection_rules | Where-Object type -eq 'required_reviewers')
    Assert-True ($shapeReviewerRule.Count -eq 1 -and $shapeReviewerRule[0].prevent_self_review -eq $true) `
        'The GitHub environment fixture does not preserve prevent_self_review on the required_reviewers rule.'
    Assert-True ($source.Contains("Get-ObjectPropertyValue -InputObject `$reviewerRules[0] -Name 'prevent_self_review'")) `
        'The preflight reads prevent_self_review from the wrong GitHub environment object level.'
    foreach ($requiredProtectionField in @('required_reviewers', 'wait_timer', 'prevent_self_review', 'deployment_branch_policy', 'custom_branch_policies', 'deployment-branch-policies')) {
        Assert-True ($source.Contains($requiredProtectionField)) `
            "The preflight does not fail closed on protected-environment field $requiredProtectionField."
    }
    Assert-True ($source.Contains('$customPolicyCount -eq 1 -and $requiredCustomPolicyPresent')) `
        'The preflight does not require the exact singleton phase5-rc-* deployment-policy set.'
    Assert-True ($source.Contains('customPolicyExactSet = $customPolicyExactSet')) `
        'The preflight does not expose the privacy-safe exact-policy-set result.'
    foreach ($requiredRunnerIdentityField in @('trustedRunnerIdVariable', 'runner_id', "-Name 'id'")) {
        Assert-True ($source.Contains($requiredRunnerIdentityField)) `
            "The preflight does not bind trusted self-hosted runner identity field $requiredRunnerIdentityField."
    }
    foreach ($requiredRunnerContext in @('RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_SHA')) {
        Assert-True ($source.Contains($requiredRunnerContext)) `
            "The preflight does not bind the actual Actions context field $requiredRunnerContext."
    }
    foreach ($flag in @('--bundle', '--custom-trusted-root', '--source-digest', '--source-ref', '--signer-workflow', '--verify-only')) {
        Assert-True ($source.Contains($flag)) "The preflight does not require offline attestation capability $flag."
    }

    $workflowPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.github\workflows\phase5-windows.yml'
    $workflow = Get-Content -LiteralPath $workflowPath -Raw -Encoding utf8
    foreach ($formalRole in @('LaneA', 'Perf', 'LaneB', 'Release', 'CleanDownload')) {
        Assert-True ($workflow.Contains("-RunnerRole $formalRole")) `
            "The formal workflow does not invoke environment preflight for role $formalRole."
    }
    Assert-True (([regex]::Matches($workflow, '(?m)^\s+-Mode Formal\s+`$')).Count -eq 5) `
        'The workflow must contain exactly five current formal preflight invocations.'
    Assert-True (([regex]::Matches($workflow, '(?m)^\s+actions: read\s*$')).Count -ge 5) `
        'One or more formal workflow jobs lack actions:read permission.'
    Assert-True (([regex]::Matches($workflow, '(?m)^\s+GH_TOKEN: \$\{\{ github\.token \}\}\s*$')).Count -eq 5) `
        'One or more formal preflight steps do not use the current GitHub token.'
    foreach ($runnerBinding in @(
        'PHASE5_LAB_RUNNER_ID: ${{ vars.PHASE5_LAB_RUNNER_ID }}',
        'PHASE5_LANE_B_RUNNER_ID: ${{ secrets.PHASE5_LANE_B_RUNNER_ID }}',
        'PHASE5_RELEASE_RUNNER_ID: ${{ secrets.PHASE5_RELEASE_RUNNER_ID }}'
    )) {
        Assert-True ($workflow.Contains($runnerBinding)) "The workflow lacks trusted runner binding $runnerBinding."
    }
    foreach ($evidenceName in @('environment/lane-a.json', 'environment/performance.json', 'environment/lane-b.json', 'environment/release.json', 'environment/clean-download.json')) {
        Assert-True ($workflow.Contains($evidenceName)) "The workflow lacks independent preflight evidence $evidenceName."
    }
    foreach ($formalPerfInput in @(
        'PERF_PACKAGE_DIRECTORY',
        'PERF_PACKAGE_EVIDENCE_MANIFEST',
        'PERF_INSTALLER_PATH',
        'PERF_FINAL_RELEASE_MANIFEST',
        'PERF_CLEAN_DOWNLOAD_VERIFICATION',
        'PERF_INDEPENDENT_TRUSTED_ROOT',
        'PERF_DEVICE_REGISTRY',
        'PERF_RUN_METADATA'
    )) {
        Assert-True ($workflow.Contains($formalPerfInput)) "The formal performance job lacks input binding $formalPerfInput."
    }
    Assert-True ($workflow.Contains("startsWith(github.ref, 'refs/tags/phase5-rc-')") -and
        $workflow.Contains('-RoundCount 3') -and $workflow.Contains('-SamplesPerRound 100') -and
        $workflow.Contains('-DurationSeconds 900') -and $workflow.Contains('-SampleIntervalSeconds 5')) `
        'The performance job is not frozen to a tag-only 3x100 plus 900-second formal run.'
    Assert-True ($workflow.Contains('runs-on: windows-2022') -and $workflow.Contains('-RunnerRole CleanDownload')) `
        'The clean-download role is not modeled on the GitHub-hosted Windows verifier.'

    Write-Host '[phase5:environment-preflight:selftest] privacy-safe development output and formal fail-closed negatives PASS.'
} finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

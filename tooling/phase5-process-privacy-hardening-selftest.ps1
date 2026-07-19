[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("desktop-translate-phase5-hardening-{0}" -f [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null

function Assert-True {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    $resourceOutput = Join-Path $testRoot 'resource-positive'
    & (Join-Path $root 'tooling\phase5-resource-scan.ps1') `
        -RootProcessId $PID `
        -OutputRoot $resourceOutput `
        -DurationSeconds 1 `
        -SampleIntervalSeconds 1 `
        -Profile Smoke
    $resourceReport = Get-Content -Raw (Join-Path $resourceOutput 'summary.json') | ConvertFrom-Json
    Assert-True ($resourceReport.status -eq 'SMOKE_PASS_NOT_ACCEPTANCE') 'Resource positive smoke did not pass.'
    Assert-True ($resourceReport.metricCollectionFailureCount -eq 0) 'Resource positive smoke missed a required metric.'

    $rootExecutable = (Get-Process -Id $PID).Path
    $resourceNegativeFailed = $false
    try {
        & (Join-Path $root 'tooling\phase5-resource-scan.ps1') `
            -RootProcessId $PID `
            -OutputRoot (Join-Path $testRoot 'resource-negative') `
            -DurationSeconds 900 `
            -SampleIntervalSeconds 5 `
            -Profile Idle `
            -RootExecutablePath $rootExecutable `
            -RootExecutableSha256 ('0' * 64) `
            -Acceptance
    } catch {
        $resourceNegativeFailed = $_.Exception.Message -match 'SHA-256'
    }
    Assert-True $resourceNegativeFailed 'Resource negative identity test unexpectedly passed.'

    $residualPositive = Join-Path $testRoot 'residual-positive.json'
    & (Join-Path $root 'tooling\phase5-residual-scan.ps1') `
        -ScopeRoot $testRoot `
        -OutputPath $residualPositive `
        -WaitSeconds 0 `
        -FailOnLeak
    Assert-True ((Get-Content -Raw $residualPositive | ConvertFrom-Json).status -eq 'PASS') 'Residual positive scan did not pass.'

    $residualNegative = Join-Path $testRoot 'residual-negative.json'
    $powershell = (Get-Process -Id $PID).Path
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tooling\phase5-residual-scan.ps1') `
        -ScopeRoot $testRoot `
        -CandidateExecutablePath $powershell `
        -OutputPath $residualNegative `
        -WaitSeconds 0 `
        -FailOnLeak
    Assert-True ($LASTEXITCODE -ne 0) 'Residual negative candidate-path test unexpectedly passed.'
    $residualNegativeReport = Get-Content -Raw $residualNegative | ConvertFrom-Json
    Assert-True ($residualNegativeReport.total -gt 0) 'Residual negative report did not contain the observed process.'
    Assert-True ($residualNegativeReport.readOnly -eq $true) 'Residual scanner did not report read-only behavior.'

    $privacyPositiveRoot = Join-Path $testRoot 'privacy-positive'
    [IO.Directory]::CreateDirectory($privacyPositiveRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $privacyPositiveRoot 'safe.json'),
        '{"schemaVersion":"1.0.0","nested":{"values":["safe-relative/path","sample-000001"]}}',
        [Text.UTF8Encoding]::new($false)
    )
    $privacyPositiveReport = Join-Path $testRoot 'privacy-positive-report.json'
    & node (Join-Path $root 'tooling\phase5-evidence-privacy-scan.mjs') `
        --root $privacyPositiveRoot `
        --output $privacyPositiveReport `
        --mode evidence
    Assert-True ($LASTEXITCODE -eq 0) 'Privacy positive scan did not pass.'
    Assert-True ((Get-Content -Raw $privacyPositiveReport | ConvertFrom-Json).findingCounts.total -eq 0) 'Privacy positive report contained findings.'

    $privacyCanonicalRoot = Join-Path $testRoot 'privacy-canonical-self-scan'
    [IO.Directory]::CreateDirectory($privacyCanonicalRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $privacyCanonicalRoot 'safe.json'),
        '{"schemaVersion":"1.0.0","value":"safe-relative/value"}',
        [Text.UTF8Encoding]::new($false)
    )
    $privacyCanonicalReportA = Join-Path $privacyCanonicalRoot 'privacy-report-a.json'
    & node (Join-Path $root 'tooling\phase5-evidence-privacy-scan.mjs') `
        --root $privacyCanonicalRoot `
        --output $privacyCanonicalReportA `
        --mode evidence
    Assert-True ($LASTEXITCODE -eq 0) 'Canonical privacy report A generation did not pass.'

    $privacyCanonicalReportB = Join-Path $testRoot 'privacy-canonical-report-b.json'
    & node (Join-Path $root 'tooling\phase5-evidence-privacy-scan.mjs') `
        --root $privacyCanonicalRoot `
        --output $privacyCanonicalReportB `
        --mode evidence
    Assert-True ($LASTEXITCODE -eq 0) 'Canonical privacy report A contaminated evidence rescan B.'
    $privacyCanonicalReportBValue = Get-Content -Raw $privacyCanonicalReportB | ConvertFrom-Json
    Assert-True ($privacyCanonicalReportBValue.status -eq 'PASS') 'Canonical privacy report rescan did not report PASS.'
    Assert-True ($privacyCanonicalReportBValue.findingCounts.total -eq 0) 'Canonical privacy report rescan contained findings.'

    $privacyForbiddenKeyRoot = Join-Path $testRoot 'privacy-forbidden-key-negative'
    [IO.Directory]::CreateDirectory($privacyForbiddenKeyRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $privacyForbiddenKeyRoot 'ordinary.json'),
        '{"absolutePath":0}',
        [Text.UTF8Encoding]::new($false)
    )
    $fakeEnvelope = [ordered]@{
        schemaVersion = '1.1.0'
        scope = 'phase5-evidence'
        status = 'PASS'
        rootsRequested = 1
        rootsScanned = 1
        filesScanned = 1
        bytesScanned = 1
        localAbsoluteRootsPersisted = $false
        forbiddenKeyPolicyApplied = $true
        scanEncodings = @('utf8', 'utf16le')
        findingCounts = [ordered]@{
            forbiddenValue = 0
            forbiddenField = 0
            absolutePath = 0
            invalidStructuredEvidence = 0
            io = 0
            total = 0
        }
        failures = @()
        unexpected = 'not-a-canonical-report'
    }
    [IO.File]::WriteAllText(
        (Join-Path $privacyForbiddenKeyRoot 'fake-envelope.json'),
        (($fakeEnvelope | ConvertTo-Json -Depth 6 -Compress) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $fakeStringPathEnvelope = [ordered]@{
        schemaVersion = '1.1.0'
        scope = 'phase5-evidence'
        status = 'PASS'
        rootsRequested = 1
        rootsScanned = 1
        filesScanned = 1
        bytesScanned = 1
        localAbsoluteRootsPersisted = $false
        forbiddenKeyPolicyApplied = $true
        scanEncodings = @('utf8', 'utf16le')
        findingCounts = [ordered]@{
            forbiddenValue = 0
            forbiddenField = 0
            absolutePath = 'C:\private\fake-report.txt'
            invalidStructuredEvidence = 0
            io = 0
            total = 0
        }
        failures = @()
    }
    [IO.File]::WriteAllText(
        (Join-Path $privacyForbiddenKeyRoot 'fake-string-path.json'),
        (($fakeStringPathEnvelope | ConvertTo-Json -Depth 6 -Compress) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $privacyForbiddenKeyReport = Join-Path $testRoot 'privacy-forbidden-key-negative-report.json'
    & node (Join-Path $root 'tooling\phase5-evidence-privacy-scan.mjs') `
        --root $privacyForbiddenKeyRoot `
        --output $privacyForbiddenKeyReport `
        --mode evidence
    Assert-True ($LASTEXITCODE -ne 0) 'Forbidden absolutePath field negative cases unexpectedly passed.'
    $privacyForbiddenKeyReportValue = Get-Content -Raw $privacyForbiddenKeyReport | ConvertFrom-Json
    foreach ($file in @('ordinary.json', 'fake-envelope.json', 'fake-string-path.json')) {
        $fieldFailures = @($privacyForbiddenKeyReportValue.failures | Where-Object {
            $_.file -eq $file -and $_.code -eq 'FORBIDDEN_FIELD_ABSOLUTEPATH'
        })
        Assert-True ($fieldFailures.Count -eq 1) "Privacy scan did not fail closed for absolutePath in $file."
    }
    $fakeStringPathFailures = @($privacyForbiddenKeyReportValue.failures | Where-Object {
        $_.file -eq 'fake-string-path.json' -and $_.code -eq 'DRIVE_ABSOLUTE_PATH'
    })
    Assert-True ($fakeStringPathFailures.Count -eq 1) 'Privacy scan missed the fake canonical report string path.'

    $privacyNegativeRoot = Join-Path $testRoot 'privacy-negative'
    [IO.Directory]::CreateDirectory($privacyNegativeRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $privacyNegativeRoot 'nested.json'),
        '{"outer":[{"value":"C:\\private\\evidence.txt"},{"value":"\\\\server\\share\\secret"},{"value":"file:///C:/private/item"},{"sourceText":"redacted"}]}',
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $privacyNegativeRoot 'utf16.txt'),
        'phase5-secret-sentinel D:\private\utf16.txt',
        [Text.UnicodeEncoding]::new($false, $true)
    )
    $oddAlignedText = [Text.Encoding]::Unicode.GetBytes('E:\private\odd-aligned.txt')
    $oddAlignedBytes = [byte[]]::new($oddAlignedText.Length + 1)
    $oddAlignedBytes[0] = 0x7f
    [Array]::Copy($oddAlignedText, 0, $oddAlignedBytes, 1, $oddAlignedText.Length)
    [IO.File]::WriteAllBytes((Join-Path $privacyNegativeRoot 'utf16-odd-offset.bin'), $oddAlignedBytes)
    [IO.File]::WriteAllText(
        (Join-Path $privacyNegativeRoot 'invalid.json'),
        '{',
        [Text.UTF8Encoding]::new($false)
    )
    $privacyNegativeReport = Join-Path $testRoot 'privacy-negative-report.json'
    & node (Join-Path $root 'tooling\phase5-evidence-privacy-scan.mjs') `
        --root $privacyNegativeRoot `
        --output $privacyNegativeReport `
        --mode evidence
    Assert-True ($LASTEXITCODE -ne 0) 'Privacy negative scan unexpectedly passed.'
    $privacyReport = Get-Content -Raw $privacyNegativeReport | ConvertFrom-Json
    Assert-True ($privacyReport.localAbsoluteRootsPersisted -eq $true) 'Privacy path result was not derived from findings.'
    Assert-True ($privacyReport.findingCounts.absolutePath -ge 4) 'Privacy scan missed drive, UNC, file URI, or aligned/odd-offset UTF-16LE path evidence.'
    Assert-True ($privacyReport.findingCounts.forbiddenValue -ge 1) 'Privacy scan missed the UTF-16LE canary.'
    Assert-True ($privacyReport.findingCounts.forbiddenField -ge 1) 'Privacy scan missed a recursively nested forbidden field.'
    Assert-True ($privacyReport.findingCounts.invalidStructuredEvidence -ge 1) 'Privacy scan did not fail closed on invalid structured evidence.'

    & node (Join-Path $root 'tooling\phase5-process-privacy-validate.mjs') `
        --resource (Join-Path $resourceOutput 'summary.json') `
        --residual $residualPositive `
        --residual $residualNegative `
        --privacy $privacyPositiveReport `
        --privacy $privacyCanonicalReportA `
        --privacy $privacyCanonicalReportB `
        --privacy $privacyForbiddenKeyReport `
        --privacy $privacyNegativeReport
    Assert-True ($LASTEXITCODE -eq 0) 'Hardening report schema validation failed.'

    Write-Host '[phase5-hardening-selftest] PASS (positive and expected-negative cases)'
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTestRoot).StartsWith('desktop-translate-phase5-hardening-', [StringComparison]::Ordinal)) {
        [IO.Directory]::Delete($resolvedTestRoot, $true)
    }
}

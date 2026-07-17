[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter()][string[]]$ArgumentList = @()
    )

    # pnpm 10 can otherwise try to re-verify or purge node_modules before every
    # recursive child invocation. The top-level locked install is the dependency
    # gate; child commands must execute against that exact installation.
    if ($FilePath -eq 'pnpm') {
        $ArgumentList = @('--config.verify-deps-before-run=false') + $ArgumentList
    }

    Write-Host "[phase4] $Label"
    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode -or $exitCode -ne 0) {
        throw "External command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

function Get-Phase4WorkspaceProcesses {
    try {
        return @(
            # Scope Electron by executable path so an unrelated application or
            # developer task that starts during this gate cannot create a false
            # leak. selection-host is workspace-specific by process name.
            Get-Process -Name 'electron', 'selection-host' -ErrorAction SilentlyContinue |
                Where-Object {
                    if ($_.ProcessName -eq 'selection-host') { return $true }
                    try {
                        return $null -ne $_.Path -and $_.Path.StartsWith(
                            $root,
                            [System.StringComparison]::OrdinalIgnoreCase
                        )
                    } catch {
                        return $false
                    }
                } |
                Select-Object `
                    @{ Name = 'ProcessId'; Expression = { $_.Id } },
                    @{ Name = 'Name'; Expression = { "$($_.ProcessName).exe" } }
        )
    } catch {
        throw 'Unable to inspect Phase 4 workspace processes after verification.'
    }
}

function Assert-NoPhase4WorkspaceProcessLeak {
    param(
        [Parameter()][AllowEmptyCollection()][int[]]$BaselineProcessIds = @()
    )

    $leaks = @()
    for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
        $leaks = @(
            Get-Phase4WorkspaceProcesses |
                Where-Object { $BaselineProcessIds -notcontains [int]$_.ProcessId }
        )
        if ($leaks.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    }

    $summary = ($leaks | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '
    throw "Phase 4 verification leaked workspace processes: $summary"
}

$baselineProcessIds = @(
    Get-Phase4WorkspaceProcesses | ForEach-Object { [int]$_.ProcessId }
)

Push-Location $root
try {
    Invoke-CheckedExternal -Label 'Tracked diff whitespace check' -FilePath 'git' -ArgumentList @('diff', '--check', 'HEAD', '--')

    # Keep every Phase 3 gate in the same order; Phase 4 is a strict superset.
    Invoke-CheckedExternal -Label 'Lint' -FilePath 'pnpm' -ArgumentList @('lint')
    Invoke-CheckedExternal -Label 'TypeScript typecheck' -FilePath 'pnpm' -ArgumentList @('typecheck')
    Invoke-CheckedExternal -Label 'Unit, component, contract, and integration tests' -FilePath 'pnpm' -ArgumentList @('test')
    Invoke-CheckedExternal -Label 'Coverage thresholds' -FilePath 'pnpm' -ArgumentList @('test:coverage')
    Invoke-CheckedExternal -Label 'Production build' -FilePath 'pnpm' -ArgumentList @('build')
    Invoke-CheckedExternal -Label 'Configure Native Host with pinned WinRT tooling' -FilePath 'pnpm' -ArgumentList @('native:configure')
    Invoke-CheckedExternal -Label 'Build Native Host' -FilePath 'pnpm' -ArgumentList @('native:build')
    Invoke-CheckedExternal -Label 'Native core, Windows OCR, and Hook tests' -FilePath 'pnpm' -ArgumentList @('native:test')
    Invoke-CheckedExternal -Label 'Phase 1 Named Pipe regression smoke' -FilePath 'pnpm' -ArgumentList @('phase1:smoke')
    Invoke-CheckedExternal -Label 'Phase 2 Electron shell regression smoke' -FilePath 'pnpm' -ArgumentList @('phase2:smoke')
    Invoke-CheckedExternal -Label 'Phase 3 real Host start/health/stop regression smoke' -FilePath 'pnpm' -ArgumentList @('phase3:smoke')

    # Phase 4 additions remain deterministic in CI: fake Provider, full E2E, then privacy scan.
    Invoke-CheckedExternal -Label 'Phase 4 fake Provider and translation orchestration smoke' -FilePath 'pnpm' -ArgumentList @('phase4:smoke')
    Invoke-CheckedExternal -Label 'Electron end-to-end tests including Phase 4' -FilePath 'pnpm' -ArgumentList @('test:e2e')
    Invoke-CheckedExternal -Label 'Phase 4 credential, payload, bundle, and artifact privacy scan' -FilePath 'pnpm' -ArgumentList @('privacy:scan')
    Write-Host '[phase4] Workspace process residual scan'
    Assert-NoPhase4WorkspaceProcessLeak -BaselineProcessIds $baselineProcessIds
} finally {
    Pop-Location
}

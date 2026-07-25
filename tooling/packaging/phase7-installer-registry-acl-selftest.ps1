[CmdletBinding()]
param(
    [Parameter()]
    [string]$CandidatePath = 'artifacts\phase5\package\dist\Desktop-Translate-0.5.0-phase5-x64-setup.exe',

    [Parameter()]
    [string]$EvidencePath = 'artifacts\phase7\installer-registry-acl-selftest.json',

    [Parameter()]
    [switch]$StaticSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appGuid = '5baab977-0efe-5c82-9f9c-b3786aa388e3'
$installSubKey = "Software\$appGuid"
$uninstallSubKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$appGuid"
$transactionSubKey = "$installSubKey.Phase7UninstallTransaction"
$backupSubKey = "Software\DesktopTranslatePhase7RegistryBackups\$appGuid"
$backupInstallSubKey = "$backupSubKey\Install"
$stagePrefix = ".desktop-translate-stage-$appGuid-"
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\desktop-translate'
$installParent = Split-Path -Parent $installRoot
$userDataDatabase = Join-Path $env:APPDATA '@desktop-translate\desktop\desktop-translate.sqlite3'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-Condition {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-RegistryPath {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey
    )

    return "Registry::HKEY_CURRENT_USER\$SubKey"
}

function Test-RegistryKey {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey
    )

    return Test-Path -LiteralPath (Get-RegistryPath -SubKey $SubKey)
}

function Get-StageCount {
    if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
        return 0
    }

    return @(
        Get-ChildItem -LiteralPath $installParent -Directory -Force -ErrorAction Stop |
            Where-Object { $_.Name.StartsWith($stagePrefix, [StringComparison]::Ordinal) }
    ).Count
}

function Get-RelatedProcessCount {
    return @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)) {
                    return $false
                }

                $path = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
                return $path.StartsWith(
                    "$installRoot\",
                    [StringComparison]::OrdinalIgnoreCase
                ) -or [IO.Path]::GetFileName($path).Equals(
                    'phase7-registry-acl-uninstall-probe.exe',
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    ).Count
}

function Get-OptionalFileHash {
    param(
        [Parameter(Mandatory)]
        [string]$LiteralPath
    )

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return $null
    }

    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-PortablePath {
    param(
        [AllowNull()]
        [string]$PathValue
    )

    if ($null -eq $PathValue) {
        return $null
    }

    $portable = $PathValue.Replace($repositoryRoot, '<REPOSITORY>')
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $portable = $portable.Replace($env:USERPROFILE, '<USERPROFILE>')
    }
    return $portable
}

function Get-RegistrySnapshot {
    $install = Get-ItemProperty -LiteralPath (Get-RegistryPath -SubKey $installSubKey)
    $uninstall = Get-ItemProperty -LiteralPath (Get-RegistryPath -SubKey $uninstallSubKey)
    return [ordered]@{
        installLocation = ConvertTo-PortablePath ([string]$install.InstallLocation)
        keepShortcuts = [string]$install.KeepShortcuts
        shortcutName = [string]$install.ShortcutName
        uninstallString = ConvertTo-PortablePath ([string]$uninstall.UninstallString)
        quietUninstallString = ConvertTo-PortablePath ([string]$uninstall.QuietUninstallString)
        displayVersion = [string]$uninstall.DisplayVersion
    }
}

function Get-FileSnapshot {
    return [ordered]@{
        stableMarkerSha256 = Get-OptionalFileHash -LiteralPath (
            Join-Path $installRoot '.desktop-translate-install-root-v1'
        )
        applicationSha256 = Get-OptionalFileHash -LiteralPath (
            Join-Path $installRoot 'desktop-translate.exe'
        )
        uninstallerSha256 = Get-OptionalFileHash -LiteralPath (
            Join-Path $installRoot 'Uninstall desktop-translate.exe'
        )
        rootEntryCount = @(Get-ChildItem -LiteralPath $installRoot -Force -ErrorAction Stop).Count
        userDataDatabaseSha256 = Get-OptionalFileHash -LiteralPath $userDataDatabase
    }
}

function Open-RegistryAclKey {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey
    )

    $rights = [Security.AccessControl.RegistryRights]::ReadPermissions -bor
        [Security.AccessControl.RegistryRights]::ChangePermissions
    return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
        $SubKey,
        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
        $rights
    )
}

function Set-RegistryAccessSddl {
    param(
        [Parameter(Mandatory)]
        [string]$SubKey,

        [Parameter(Mandatory)]
        [string]$Sddl
    )

    if (-not (Test-RegistryKey -SubKey $SubKey)) {
        return
    }

    $key = Open-RegistryAclKey -SubKey $SubKey
    Assert-Condition ($null -ne $key) "Could not open registry ACL for restore: $SubKey"
    try {
        $security = New-Object Security.AccessControl.RegistrySecurity
        $security.SetSecurityDescriptorSddlForm(
            $Sddl,
            [Security.AccessControl.AccessControlSections]::Access
        )
        $key.SetAccessControl($security)
    } finally {
        $key.Dispose()
    }
}

function Add-CurrentUserDeleteDeny {
    $key = Open-RegistryAclKey -SubKey $installSubKey
    Assert-Condition ($null -ne $key) 'Could not open the product registry ACL for fault injection.'
    try {
        $security = $key.GetAccessControl(
            [Security.AccessControl.AccessControlSections]::Access
        )
        $original = $security.GetSecurityDescriptorSddlForm(
            [Security.AccessControl.AccessControlSections]::Access
        )
        $rule = New-Object Security.AccessControl.RegistryAccessRule(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.AccessControl.RegistryRights]::Delete,
            [Security.AccessControl.AccessControlType]::Deny
        )
        $null = $security.AddAccessRule($rule)
        $key.SetAccessControl($security)
        return $original
    } finally {
        $key.Dispose()
    }
}

function New-ProbeDirectory {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $path = Join-Path $tempRoot (
        'desktop-translate-phase7-registry-acl-' + [guid]::NewGuid().ToString('N')
    )
    $null = New-Item -ItemType Directory -Path $path
    return [IO.Path]::GetFullPath($path)
}

function Remove-ProbeDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$LiteralPath
    )

    $resolved = [IO.Path]::GetFullPath($LiteralPath)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    Assert-Condition (
        $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)
    ) "Refusing to clean a probe outside TEMP: $resolved"
    Assert-Condition (
        [IO.Path]::GetFileName($resolved).StartsWith(
            'desktop-translate-phase7-registry-acl-',
            [StringComparison]::Ordinal
        )
    ) "Refusing to clean an unexpected TEMP path: $resolved"

    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Invoke-CandidateInstall {
    $process = Start-Process -FilePath $script:resolvedCandidatePath `
        -ArgumentList @('/S', '/currentuser') `
        -PassThru `
        -Wait
    Assert-Condition ($process.ExitCode -eq 0) "Candidate install/recovery exited $($process.ExitCode)."
}

function Invoke-InnerUninstall {
    param(
        [Parameter(Mandatory)]
        [string]$ProbePath
    )

    return Start-Process -FilePath $ProbePath `
        -ArgumentList @('/S', '/currentuser', "_?=$installRoot") `
        -PassThru `
        -Wait
}

function Invoke-StaticSelfTest {
    $include = Get-Content -Raw -LiteralPath (
        Join-Path $repositoryRoot 'apps\desktop\build\installer.nsh'
    )
    foreach ($required in @(
        '!macro phase7ProbeExistingRegistryKeyLifecycleAccess REGISTRY_KEY',
        'ADVAPI32::RegOpenKeyExW(p 0x80000001, w "${REGISTRY_KEY}", i 0, i R4, *p .R5) i.R6',
        'The CurrentUser product registry ACL does not permit the complete Phase 7 lifecycle.',
        '!macro customUnInit'
    )) {
        Assert-Condition (
            $include.IndexOf($required, [StringComparison]::Ordinal) -ge 0
        ) "Installer include lacks registry ACL invariant: $required"
    }

    $customStart = $include.IndexOf('!macro customUnInit', [StringComparison]::Ordinal)
    $customEnd = $include.IndexOf('!macroend', $customStart, [StringComparison]::Ordinal)
    $custom = $include.Substring($customStart, $customEnd - $customStart)
    Assert-Condition (
        $custom.IndexOf(
            '!insertmacro phase7ProbeExistingRegistryKeyLifecycleAccess "${INSTALL_REGISTRY_KEY}"',
            [StringComparison]::Ordinal
        ) -ge 0
    ) 'customUnInit lacks install-key lifecycle ACL validation.'
    Assert-Condition (
        $custom.IndexOf(
            '!insertmacro phase7ProbeExistingRegistryKeyLifecycleAccess "${UNINSTALL_REGISTRY_KEY}"',
            [StringComparison]::Ordinal
        ) -ge 0
    ) 'customUnInit lacks uninstall-key lifecycle ACL validation.'

    [ordered]@{
        schema = 'phase7-installer-registry-acl-static-selftest-v1'
        status = 'PASS'
        productionFaultHookPresent = $false
        canonicalLifecycleAccess = '0xF023F/0xF013F'
        preCheckAppRunningValidation = $true
        systemMutationPerformed = $false
    } | ConvertTo-Json -Depth 6
}

if ($StaticSelfTest) {
    Invoke-StaticSelfTest
    exit 0
}

$candidateCandidate = if ([IO.Path]::IsPathRooted($CandidatePath)) {
    $CandidatePath
} else {
    Join-Path $repositoryRoot $CandidatePath
}
$script:resolvedCandidatePath = [IO.Path]::GetFullPath($candidateCandidate)
Assert-Condition (
    Test-Path -LiteralPath $script:resolvedCandidatePath -PathType Leaf
) "Candidate installer is absent: $($script:resolvedCandidatePath)"
$candidateItem = Get-Item -LiteralPath $script:resolvedCandidatePath -Force
Assert-Condition (
    ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
) 'Candidate installer must not be a reparse point.'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
Assert-Condition (
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
) 'The registry ACL runtime selftest must run as a standard user.'

Assert-Condition (-not (Test-Path -LiteralPath $installRoot)) 'Product root must be absent before the ACL selftest.'
Assert-Condition (-not (Test-RegistryKey -SubKey $installSubKey)) 'Product registry must be absent before the ACL selftest.'
Assert-Condition (-not (Test-RegistryKey -SubKey $uninstallSubKey)) 'Uninstall registry must be absent before the ACL selftest.'
Assert-Condition (-not (Test-RegistryKey -SubKey $transactionSubKey)) 'Transaction must be absent before the ACL selftest.'
Assert-Condition (-not (Test-RegistryKey -SubKey $backupSubKey)) 'Backup must be absent before the ACL selftest.'
Assert-Condition ((Get-StageCount) -eq 0) 'Stage must be absent before the ACL selftest.'
Assert-Condition ((Get-RelatedProcessCount) -eq 0) 'A related process is running before the ACL selftest.'

Invoke-CandidateInstall
$registryBefore = Get-RegistrySnapshot
$filesBefore = Get-FileSnapshot
$originalSddl = Add-CurrentUserDeleteDeny
$probeDirectory = New-ProbeDirectory
$probe = Join-Path $probeDirectory 'phase7-registry-acl-uninstall-probe.exe'
Copy-Item -LiteralPath (
    Join-Path $installRoot 'Uninstall desktop-translate.exe'
) -Destination $probe

$faultProcess = $null
$faultSnapshot = $null
$faultInvariantPassed = $false
try {
    $faultProcess = Invoke-InnerUninstall -ProbePath $probe
    $registryAfter = Get-RegistrySnapshot
    $filesAfter = Get-FileSnapshot
    $faultSnapshot = [ordered]@{
        innerExitCode = $faultProcess.ExitCode
        registrySnapshotEqual = (
            (ConvertTo-Json $registryBefore -Compress) -ceq
            (ConvertTo-Json $registryAfter -Compress)
        )
        fileAndUserDataSnapshotEqual = (
            (ConvertTo-Json $filesBefore -Compress) -ceq
            (ConvertTo-Json $filesAfter -Compress)
        )
        installRootPresent = Test-Path -LiteralPath $installRoot -PathType Container
        productRegistryPresent = Test-RegistryKey -SubKey $installSubKey
        uninstallRegistryPresent = Test-RegistryKey -SubKey $uninstallSubKey
        transactionPresent = Test-RegistryKey -SubKey $transactionSubKey
        backupPresent = Test-RegistryKey -SubKey $backupSubKey
        stageCount = Get-StageCount
        relatedProcessCount = Get-RelatedProcessCount
    }
    $faultInvariantPassed = (
        $faultSnapshot.innerExitCode -ne 0 -and
        $faultSnapshot.registrySnapshotEqual -and
        $faultSnapshot.fileAndUserDataSnapshotEqual -and
        $faultSnapshot.installRootPresent -and
        $faultSnapshot.productRegistryPresent -and
        $faultSnapshot.uninstallRegistryPresent -and
        -not $faultSnapshot.transactionPresent -and
        -not $faultSnapshot.backupPresent -and
        $faultSnapshot.stageCount -eq 0 -and
        $faultSnapshot.relatedProcessCount -eq 0
    )
} finally {
    Set-RegistryAccessSddl -SubKey $installSubKey -Sddl $originalSddl
    # Older candidates copied a hostile ACL into this backup. Restoring it here
    # keeps this regression harness recoverable if it is intentionally run
    # against an unfixed binary.
    Set-RegistryAccessSddl -SubKey $backupInstallSubKey -Sddl $originalSddl
}

if (-not $faultInvariantPassed) {
    if (Test-RegistryKey -SubKey $transactionSubKey) {
        Invoke-CandidateInstall
    }
    throw 'Registry ACL refusal did not occur before every product mutation.'
}

$normalProcess = Invoke-InnerUninstall -ProbePath $probe
Assert-Condition ($normalProcess.ExitCode -eq 0) "Normal inner uninstall exited $($normalProcess.ExitCode)."
Remove-ProbeDirectory -LiteralPath $probeDirectory

$final = [ordered]@{
    normalInnerUninstallExitCode = $normalProcess.ExitCode
    installRootPresent = Test-Path -LiteralPath $installRoot
    productRegistryPresent = Test-RegistryKey -SubKey $installSubKey
    uninstallRegistryPresent = Test-RegistryKey -SubKey $uninstallSubKey
    transactionPresent = Test-RegistryKey -SubKey $transactionSubKey
    backupPresent = Test-RegistryKey -SubKey $backupSubKey
    stageCount = Get-StageCount
    relatedProcessCount = Get-RelatedProcessCount
    userDataDatabaseSha256 = Get-OptionalFileHash -LiteralPath $userDataDatabase
}
Assert-Condition (-not $final.installRootPresent) 'Install root remains after normal cleanup.'
Assert-Condition (-not $final.productRegistryPresent) 'Product registry remains after normal cleanup.'
Assert-Condition (-not $final.uninstallRegistryPresent) 'Uninstall registry remains after normal cleanup.'
Assert-Condition (-not $final.transactionPresent) 'Transaction remains after normal cleanup.'
Assert-Condition (-not $final.backupPresent) 'Backup remains after normal cleanup.'
Assert-Condition ($final.stageCount -eq 0) 'Stage remains after normal cleanup.'
Assert-Condition ($final.relatedProcessCount -eq 0) 'A related process remains after normal cleanup.'
Assert-Condition (
    $final.userDataDatabaseSha256 -ceq $filesBefore.userDataDatabaseSha256
) 'Retained user-data hash changed during the ACL selftest.'

$candidateSignature = Get-AuthenticodeSignature -LiteralPath $script:resolvedCandidatePath
$evidence = [ordered]@{
    schema = 'phase7-installer-registry-acl-selftest-v1'
    recordedAt = [DateTimeOffset]::Now.ToString('o')
    status = 'DEVELOPMENT PASS; M3 AND RELEASE REMAIN BLOCKED'
    source = [ordered]@{
        branch = (& git -C $repositoryRoot branch --show-current).Trim()
        headSha = (& git -C $repositoryRoot rev-parse HEAD).Trim()
        harness = 'tooling/packaging/phase7-installer-registry-acl-selftest.ps1'
    }
    candidate = [ordered]@{
        path = ConvertTo-PortablePath $script:resolvedCandidatePath
        sizeBytes = $candidateItem.Length
        sha256 = (Get-FileHash -LiteralPath $script:resolvedCandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
        authenticodeStatus = [string]$candidateSignature.Status
        releaseStatus = 'RELEASE BLOCKED'
    }
    fault = [ordered]@{
        target = 'canonical HKCU product key'
        injectedAccessControlType = 'Deny'
        injectedRight = 'Delete'
        currentUserSid = '<CURRENT_USER_SID>'
        preCheckAppRunningLifecycleAccess = '0xF023F/0xF013F'
        snapshot = $faultSnapshot
    }
    finalState = $final
    boundaries = @(
        'standard-user CurrentUser fixed-NTFS development host only',
        'unsigned candidate only',
        'this proves canonical registry DELETE-deny refusal before mutation, not every ACL permutation',
        'clean VM and signed-candidate ACL tests remain open'
    )
}

$resolvedEvidencePath = if ([IO.Path]::IsPathRooted($EvidencePath)) {
    [IO.Path]::GetFullPath($EvidencePath)
} else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
}
$evidenceParent = Split-Path -Parent $resolvedEvidencePath
if (-not (Test-Path -LiteralPath $evidenceParent -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $evidenceParent
}
$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resolvedEvidencePath -Encoding utf8
Write-Output ($evidence | ConvertTo-Json -Depth 12)

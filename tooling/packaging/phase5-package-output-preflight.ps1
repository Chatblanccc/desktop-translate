Set-StrictMode -Version Latest

if (-not ('Phase5.PackageOutputQuarantineNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Phase5 {
    public static class PackageOutputQuarantineNative {
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileTime {
            public uint LowDateTime;
            public uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation {
            public uint FileAttributes;
            public NativeFileTime CreationTime;
            public NativeFileTime LastAccessTime;
            public NativeFileTime LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        public sealed class DirectoryIdentityLease : IDisposable {
            internal SafeFileHandle Handle { get; private set; }
            public uint VolumeSerialNumber { get; private set; }
            public ulong FileId { get; private set; }

            internal DirectoryIdentityLease(
                SafeFileHandle handle,
                uint volumeSerialNumber,
                ulong fileId
            ) {
                Handle = handle;
                VolumeSerialNumber = volumeSerialNumber;
                FileId = fileId;
            }

            public void Dispose() {
                if (Handle != null) {
                    Handle.Dispose();
                    Handle = null;
                }
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out ByHandleFileInformation information
        );

        private static ByHandleFileInformation ReadIdentity(SafeFileHandle handle) {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Directory identity could not be read."
                );
            }
            return information;
        }

        private static SafeFileHandle OpenDirectoryHandle(string path) {
            return CreateFileW(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero
            );
        }

        public static FileStream OpenFileQuarantineLease(string path) {
            var handle = CreateFileW(
                path,
                GENERIC_READ,
                0,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero
            );
            if (handle.IsInvalid) {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Package output file could not be leased for atomic quarantine.");
            }
            return new FileStream(handle, FileAccess.Read, 4096, false);
        }

        public static DirectoryIdentityLease OpenDirectoryIdentityLease(string path) {
            var handle = OpenDirectoryHandle(path);
            if (handle.IsInvalid) {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Quarantine parent could not be leased by identity.");
            }
            try {
                var information = ReadIdentity(handle);
                if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                    throw new InvalidOperationException("Quarantine parent is a reparse point.");
                }
                var fileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
                return new DirectoryIdentityLease(
                    handle,
                    information.VolumeSerialNumber,
                    fileId
                );
            } catch {
                handle.Dispose();
                throw;
            }
        }

        public static bool DirectoryLeaseMatchesPath(
            DirectoryIdentityLease lease,
            string path
        ) {
            if (lease == null || lease.Handle == null || lease.Handle.IsInvalid || lease.Handle.IsClosed) {
                return false;
            }
            using (var current = OpenDirectoryHandle(path)) {
                if (current.IsInvalid) {
                    return false;
                }
                var information = ReadIdentity(current);
                if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                    return false;
                }
                var fileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
                return information.VolumeSerialNumber == lease.VolumeSerialNumber &&
                    fileId == lease.FileId;
            }
        }
    }
}
'@
}

function New-Phase5PackageOutputException {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $exception = [InvalidOperationException]::new("${Code}: $Message")
    $exception.Data['StableErrorCode'] = $Code
    return $exception
}

function Get-Phase5PackageOutputStreamSha256 {
    param([Parameter(Mandatory = $true)][IO.FileStream]$Stream)

    $Stream.Position = 0
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $Stream.Position = 0
    }
}

function Get-Phase5PackageOutputExecutableNames {
    param([Parameter(Mandatory = $true)][string]$PackageOutput)

    $packageOutputFull = [IO.Path]::GetFullPath($PackageOutput)
    if (-not (Test-Path -LiteralPath $packageOutputFull -PathType Container)) { return @() }
    try {
        return @(Get-ChildItem -LiteralPath $packageOutputFull -Recurse -Force -File -Filter '*.exe' -ErrorAction Stop |
            ForEach-Object { $_.Name } | Sort-Object -Unique)
    } catch {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
            -Message 'package executable inventory could not be read; no output was removed.')
    }
}

function Resolve-Phase5PackageOutputProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Candidate,
        [Parameter(Mandatory = $true)][string[]]$RelatedPackageOutputs,
        [Parameter()][AllowEmptyCollection()][string[]]$KnownExecutableNames = @()
    )

    $candidateName = [string]$Candidate.Name
    $rawPath = [string]$Candidate.ExecutablePath
    $knownNameMatch = -not [string]::IsNullOrWhiteSpace($candidateName) -and
        @($KnownExecutableNames | Where-Object {
            [string]::Equals($_, $candidateName, [StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
    if ([string]::IsNullOrWhiteSpace($rawPath)) {
        if ($knownNameMatch) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
                -Message 'a process matching a package executable name has no verifiable image path; no output was removed.')
        }
        return $null
    }

    try {
        $candidatePath = [IO.Path]::GetFullPath($rawPath)
    } catch {
        if ($knownNameMatch) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
                -Message 'a process matching a package executable name has an invalid image path; no output was removed.')
        }
        return $null
    }

    $related = $false
    foreach ($packageOutput in $RelatedPackageOutputs) {
        $packageOutputFull = [IO.Path]::GetFullPath($packageOutput).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        $packageOutputPrefix = $packageOutputFull + [IO.Path]::DirectorySeparatorChar
        if ($candidatePath.StartsWith($packageOutputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $related = $true
            break
        }
    }
    if (-not $related) { return $null }

    if ($null -eq $Candidate.CreationDate) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
            -Message 'a package process has no verifiable creation time; no output was removed.')
    }
    try {
        $creationDateUtc = ([DateTime]$Candidate.CreationDate).ToUniversalTime()
    } catch {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
            -Message 'a package process has an invalid creation time; no output was removed.')
    }

    $role = if ($candidatePath.EndsWith(
        'win-unpacked\desktop-translate.exe',
        [StringComparison]::OrdinalIgnoreCase
    )) {
        'application'
    } elseif ($candidatePath.EndsWith(
        'win-unpacked\resources\selection-host\selection-host.exe',
        [StringComparison]::OrdinalIgnoreCase
    )) {
        'nativeHost'
    } elseif ([IO.Path]::GetFileName($candidatePath) -like '*-setup.exe') {
        'installer'
    } else {
        'packageExecutable'
    }
    return [pscustomobject][ordered]@{
        ProcessId = [int]$Candidate.ProcessId
        CreationDateUtc = $creationDateUtc
        Path = $candidatePath
        Role = $role
    }
}

function Get-Phase5PackageOutputProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PackageOutput,
        [Parameter()][AllowEmptyCollection()][string[]]$AdditionalPackageOutputs = @(),
        [Parameter()][AllowEmptyCollection()][string[]]$KnownExecutableNames = @()
    )

    $packageOutputs = @([IO.Path]::GetFullPath($PackageOutput)) + @($AdditionalPackageOutputs |
        ForEach-Object { [IO.Path]::GetFullPath($_) })
    if ($KnownExecutableNames.Count -eq 0) {
        $KnownExecutableNames = @(Get-Phase5PackageOutputExecutableNames -PackageOutput $PackageOutput)
    }
    try {
        $candidates = @(Get-CimInstance -Query 'SELECT ProcessId, Name, ExecutablePath, CreationDate FROM Win32_Process' -ErrorAction Stop)
    } catch {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PROCESS_IDENTITY_INDETERMINATE' `
            -Message 'the process inventory could not be queried; no output was removed.')
    }

    $matches = @()
    foreach ($candidate in $candidates) {
        $identity = Resolve-Phase5PackageOutputProcessIdentity -Candidate $candidate `
            -RelatedPackageOutputs $packageOutputs -KnownExecutableNames $KnownExecutableNames
        if ($null -ne $identity) { $matches += $identity }
    }
    return @($matches)
}

function Assert-Phase5PackageOutputNotInUse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PackageOutput,
        [Parameter()][AllowEmptyCollection()][string[]]$AdditionalPackageOutputs = @(),
        [Parameter()][AllowEmptyCollection()][string[]]$KnownExecutableNames = @()
    )

    $activeIdentities = @(Get-Phase5PackageOutputProcessIdentity -PackageOutput $PackageOutput `
        -AdditionalPackageOutputs $AdditionalPackageOutputs -KnownExecutableNames $KnownExecutableNames)
    if ($activeIdentities.Count -eq 0) { return }

    $roles = @($activeIdentities | ForEach-Object Role | Sort-Object -Unique)
    $exception = New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_IN_USE' `
        -Message "package executable role(s) are active; no process was terminated; count=$($activeIdentities.Count); roles=$($roles -join ',')."
    $exception.Data['ActiveCount'] = $activeIdentities.Count
    $exception.Data['Roles'] = $roles -join ','
    throw $exception
}

function Assert-Phase5PackageOutputLeaseAvailable {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$PackageOutput)

    $packageOutputFull = [IO.Path]::GetFullPath($PackageOutput)
    if (-not (Test-Path -LiteralPath $packageOutputFull)) { return }
    if (-not (Test-Path -LiteralPath $packageOutputFull -PathType Container)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_LOCKED' `
            -Message 'package output is not an accessible directory.')
    }

    try {
        $files = @(Get-ChildItem -LiteralPath $packageOutputFull -Recurse -Force -File -ErrorAction Stop)
        foreach ($file in $files) {
            $stream = $null
            try {
                $stream = [IO.File]::Open(
                    $file.FullName,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::None
                )
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        }
    } catch {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_LOCKED' `
            -Message 'at least one package output file is not exclusively readable; no output was removed.')
    }
}

function Get-Phase5PackageOutputMutexName {
    param([Parameter(Mandatory = $true)][string]$PackageOutput)

    $normalized = [IO.Path]::GetFullPath($PackageOutput).TrimEnd('\').ToUpperInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))
    } finally {
        $sha.Dispose()
    }
    return 'Global\DesktopTranslate.Phase5.PackageOutput.' +
        ([BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
}

function Get-Phase5PackageOutputRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $pathFull = [IO.Path]::GetFullPath($Path)
    if (-not $pathFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
            -Message 'a quarantine-lease entry escaped the quarantined package output.')
    }
    return $pathFull.Substring($rootPrefix.Length)
}

function Enter-Phase5PackageRepositoryLock {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $repositoryRootFull = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
    $lockPath = [IO.Path]::GetFullPath(
        (Join-Path $repositoryRootFull '.phase5-package-output.lock')
    )
    Assert-Phase5NoReparsePoint -Path $lockPath -AllowedParent $repositoryRootFull
    if (Test-Path -LiteralPath $lockPath -PathType Container) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_REPOSITORY_LOCK_INVALID' `
            -Message 'the stable package repository lock path is a directory.')
    }

    $stream = $null
    try {
        $stream = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        Assert-Phase5NoReparsePoint -Path $lockPath -AllowedParent $repositoryRootFull
        $item = Get-Item -LiteralPath $lockPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_REPOSITORY_LOCK_INVALID' `
                -Message 'the stable package repository lock is not an exact regular file.')
        }
        return [pscustomobject][ordered]@{
            Path = $lockPath
            Stream = $stream
            Active = $true
        }
    } catch {
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
        if ($_.Exception.Data['StableErrorCode']) { throw }
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_REPOSITORY_BUSY' `
            -Message 'another package operation owns the repository-stable lock file.')
    }
}

function Exit-Phase5PackageRepositoryLock {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lock)

    if (-not [bool]$Lock.Active) { return }
    try { $Lock.Stream.Dispose() } finally { $Lock.Active = $false }
}

function Assert-Phase5PackageQuarantineParentIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$DirectoryLease,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $matches = $false
    try {
        $matches = [Phase5.PackageOutputQuarantineNative]::DirectoryLeaseMatchesPath(
            $DirectoryLease,
            [IO.Path]::GetFullPath($Path)
        )
    } catch {
        $matches = $false
    }
    if (-not $matches) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_PARENT_CHANGED' `
            -Message 'the quarantine parent no longer matches its leased volume serial and file identity.')
    }
}

function Get-Phase5PackageOutputEntryKeys {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root)

    return @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop |
        ForEach-Object {
            ('{0}:{1}' -f $(if ($_.PSIsContainer) { 'D' } else { 'F' }),
                (Get-Phase5PackageOutputRelativePath -Root $Root -Path $_.FullName))
        } | Sort-Object)
}

function Assert-Phase5PackageOutputQuarantineIntegrity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lease)

    if ([string]::IsNullOrWhiteSpace([string]$Lease.QuarantinePath)) { return }
    Assert-Phase5PackageQuarantineParentIdentity `
        -DirectoryLease $Lease.QuarantineParentDirectoryLease `
        -Path $Lease.QuarantineParent
    Assert-Phase5NoReparsePoint -Path $Lease.QuarantinePath -AllowedParent $Lease.QuarantineParent
    if (-not (Test-Path -LiteralPath $Lease.QuarantinePath -PathType Container)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
            -Message 'the quarantined package output directory is unavailable.')
    }
    $currentEntryKeys = @(Get-Phase5PackageOutputEntryKeys -Root $Lease.QuarantinePath)
    if ([string]::Join("`n", @($Lease.InitialEntryKeys)) -cne
        [string]::Join("`n", $currentEntryKeys)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
            -Message 'the quarantined package output exact entry set changed while leased.')
    }
    foreach ($entry in @($Lease.FileEntries)) {
        if ($null -eq $entry.Stream -or -not $entry.Stream.CanRead -or
            (Get-Phase5PackageOutputStreamSha256 -Stream $entry.Stream) -cne $entry.InitialSha256) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
                -Message 'the quarantined package output content hash changed while leased.')
        }
    }
}

function Assert-Phase5PackageOutputRootExactSet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][ValidateSet('Dir', 'Installer')][string]$Mode
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $allowedParentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    Assert-Phase5NoReparsePoint -Path $rootFull -AllowedParent $allowedParentFull
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID' `
            -Message 'package output root is not an exact regular directory.')
    }
    $entries = @(Get-ChildItem -LiteralPath $rootFull -Force -ErrorAction Stop)
    $winUnpackedEntries = @($entries | Where-Object {
        [string]::Equals($_.Name, 'win-unpacked', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($winUnpackedEntries.Count -ne 1 -or -not $winUnpackedEntries[0].PSIsContainer -or
        ($winUnpackedEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID' `
            -Message 'package output root must contain one regular win-unpacked directory.')
    }

    if ($Mode -eq 'Dir') {
        if ($entries.Count -ne 1) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID' `
                -Message 'Dir package root contains an unexpected top-level entry.')
        }
        return
    }

    $installerEntries = @($entries | Where-Object {
        -not $_.PSIsContainer -and $_.Name -like '*-setup.exe'
    })
    if ($entries.Count -ne 2 -or $installerEntries.Count -ne 1 -or
        ($installerEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_ROOT_EXACT_SET_INVALID' `
            -Message 'Installer package root must contain only win-unpacked and one regular setup executable.')
    }
    return $installerEntries[0].FullName
}

function Move-Phase5FailedPublishedPackageToRetention {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FinalPath,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $allowedParentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    $finalFull = [IO.Path]::GetFullPath($FinalPath).TrimEnd('\')
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath((Split-Path -Parent $finalFull)).TrimEnd('\'),
        $allowedParentFull,
        [StringComparison]::OrdinalIgnoreCase
    ) -or -not [string]::Equals(
        [IO.Path]::GetFileName($finalFull),
        'dist',
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_FAILED_RETENTION_PATH_INVALID' `
            -Message 'only the exact sibling canonical dist path can enter failed retention.')
    }
    $parentProbe = Join-Path $allowedParentFull (
        '.phase5-failed-parent-probe-' + [guid]::NewGuid().ToString('N')
    )
    Assert-Phase5NoReparsePoint -Path $parentProbe -AllowedParent $allowedParentFull
    if (-not (Test-Path -LiteralPath $finalFull)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_FAILED_RETENTION_SOURCE_MISSING' `
            -Message 'canonical dist disappeared before failed retention could atomically preserve it.')
    }

    $failedPath = Join-Path $allowedParentFull (
        '.phase5-failed-' + [guid]::NewGuid().ToString('N')
    )
    Assert-Phase5NoReparsePoint -Path $failedPath -AllowedParent $allowedParentFull
    $finalItem = Get-Item -LiteralPath $finalFull -Force -ErrorAction Stop
    if ($finalItem.PSIsContainer) {
        [IO.Directory]::Move($finalFull, $failedPath)
    } else {
        [IO.File]::Move($finalFull, $failedPath)
    }
    if ((Test-Path -LiteralPath $finalFull) -or -not (Test-Path -LiteralPath $failedPath)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_FAILED_RETENTION_INCOMPLETE' `
            -Message 'failed retention did not remove the canonical dist namespace atomically.')
    }
    return $failedPath
}

function Publish-Phase5PackageBuildStaging {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$StagingPath,
        [Parameter(Mandatory = $true)][string]$FinalPath,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][ValidateSet('Dir', 'Installer')][string]$Mode
    )

    $allowedParentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    $stagingFull = [IO.Path]::GetFullPath($StagingPath).TrimEnd('\')
    $finalFull = [IO.Path]::GetFullPath($FinalPath).TrimEnd('\')
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath((Split-Path -Parent $stagingFull)).TrimEnd('\'),
        $allowedParentFull,
        [StringComparison]::OrdinalIgnoreCase
    ) -or -not [string]::Equals(
        [IO.Path]::GetFullPath((Split-Path -Parent $finalFull)).TrimEnd('\'),
        $allowedParentFull,
        [StringComparison]::OrdinalIgnoreCase
    ) -or [IO.Path]::GetFileName($stagingFull) -notmatch '^\.phase5-build-[a-f0-9]{32}$' -or
        -not [string]::Equals([IO.Path]::GetFileName($finalFull), 'dist', [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PUBLISH_PATH_INVALID' `
            -Message 'staging and final output must be exact sibling namespaces under the package parent.')
    }
    $null = Assert-Phase5PackageOutputRootExactSet `
        -Root $stagingFull `
        -AllowedParent $allowedParentFull `
        -Mode $Mode
    Assert-Phase5NoReparsePoint -Path $finalFull -AllowedParent $allowedParentFull
    if (Test-Path -LiteralPath $finalFull) {
        $exception = New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_FINAL_NAMESPACE_BUSY' `
            -Message 'the final dist namespace was created by another actor; staging was retained intact.'
        $exception.Data['StagingRetained'] = $true
        $exception.Data['StagingPath'] = $stagingFull
        throw $exception
    }

    try {
        [IO.Directory]::Move($stagingFull, $finalFull)
    } catch {
        $exception = New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_ATOMIC_PUBLISH_FAILED' `
            -Message 'atomic staging publish failed; any remaining staging tree was retained intact.'
        $exception.Data['StagingRetained'] = (Test-Path -LiteralPath $stagingFull -PathType Container)
        $exception.Data['StagingPath'] = $stagingFull
        throw $exception
    }
}

function Invoke-Phase5PackageCandidateGatesAndPublish {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$GateAction,
        [Parameter(Mandatory = $true)][string]$StagingPath,
        [Parameter(Mandatory = $true)][string]$FinalPath,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][ValidateSet('Dir', 'Installer')][string]$Mode
    )

    # Publish is deliberately unreachable unless every caller-supplied gate
    # returns successfully. A terminating gate failure leaves staging intact
    # and never creates the canonical final namespace.
    & $GateAction
    Publish-Phase5PackageBuildStaging `
        -StagingPath $StagingPath `
        -FinalPath $FinalPath `
        -AllowedParent $AllowedParent `
        -Mode $Mode
}

function Invoke-Phase5PublishedPackageLiveValidation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ValidationAction,
        [Parameter(Mandatory = $true)][string]$FinalPath,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][ValidateSet('Dir', 'Installer')][string]$Mode
    )

    try {
        $null = Assert-Phase5PackageOutputRootExactSet `
            -Root $FinalPath `
            -AllowedParent $AllowedParent `
            -Mode $Mode
        & $ValidationAction
    } catch {
        $validationException = $_.Exception
        try {
            $failedPath = Move-Phase5FailedPublishedPackageToRetention `
                -FinalPath $FinalPath `
                -AllowedParent $AllowedParent
        } catch {
            $retentionException = $_.Exception
            $combined = [InvalidOperationException]::new(
                ('PACKAGE_OUTPUT_POST_PUBLISH_VALIDATION_AND_RETENTION_FAILED: ' +
                    "validation=[$($validationException.Message)]; " +
                    "retention=[$($retentionException.Message)]"),
                $retentionException
            )
            $combined.Data['StableErrorCode'] = `
                'PACKAGE_OUTPUT_POST_PUBLISH_VALIDATION_AND_RETENTION_FAILED'
            $combined.Data['ValidationError'] = $validationException.Message
            $combined.Data['RetentionError'] = $retentionException.Message
            throw $combined
        }
        $validationException.Data['FailedPackageRetained'] = $true
        $validationException.Data['FailedPackagePath'] = $failedPath
        throw $validationException
    }
}

function Enter-Phase5PackageOutputQuarantineLease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PackageOutput,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$QuarantineParent
    )

    $packageOutputFull = [IO.Path]::GetFullPath($PackageOutput).TrimEnd('\')
    $allowedParentFull = [IO.Path]::GetFullPath($AllowedParent).TrimEnd('\')
    $repositoryRootFull = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\')
    $quarantineParentFull = [IO.Path]::GetFullPath($QuarantineParent).TrimEnd('\')
    $expectedQuarantineParent = [IO.Path]::GetFullPath(
        (Join-Path $repositoryRootFull '.phase5-package-quarantine')
    ).TrimEnd('\')

    if (-not (Test-Path -LiteralPath $repositoryRootFull -PathType Container)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PATH_INVALID' `
            -Message 'the repository root is not an existing directory.')
    }
    if (-not [string]::Equals(
        $quarantineParentFull,
        $expectedQuarantineParent,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PATH_INVALID' `
            -Message 'the quarantine parent must be the repository-root .phase5-package-quarantine directory.')
    }
    Assert-Phase5NoReparsePoint -Path $allowedParentFull -AllowedParent $repositoryRootFull
    Assert-Phase5NoReparsePoint -Path $packageOutputFull -AllowedParent $allowedParentFull
    Assert-Phase5NoReparsePoint -Path $quarantineParentFull -AllowedParent $repositoryRootFull
    if ($allowedParentFull.StartsWith($quarantineParentFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $quarantineParentFull.StartsWith($allowedParentFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($allowedParentFull, $quarantineParentFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PATH_INVALID' `
            -Message 'the package-output and quarantine parent trees must be disjoint.')
    }
    $packageVolume = [IO.Path]::GetPathRoot($packageOutputFull)
    $quarantineVolume = [IO.Path]::GetPathRoot($quarantineParentFull)
    if ([string]::IsNullOrWhiteSpace($packageVolume) -or
        [string]::IsNullOrWhiteSpace($quarantineVolume) -or
        -not [string]::Equals($packageVolume, $quarantineVolume, [StringComparison]::OrdinalIgnoreCase)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_CROSS_VOLUME_QUARANTINE' `
            -Message 'package output and quarantine parent must share a volume for an atomic directory move.')
    }

    $mutex = $null
    $mutexOwned = $false
    $quarantinePath = $null
    $handles = [Collections.Generic.List[IDisposable]]::new()
    $repositoryLock = $null
    $quarantineParentDirectoryLease = $null
    try {
        $repositoryLock = Enter-Phase5PackageRepositoryLock -RepositoryRoot $repositoryRootFull
        $mutex = [Threading.Mutex]::new($false, (Get-Phase5PackageOutputMutexName -PackageOutput $packageOutputFull))
        try {
            $mutexOwned = $mutex.WaitOne(0)
        } catch [Threading.AbandonedMutexException] {
            $mutexOwned = $true
        }
        if (-not $mutexOwned) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_BUSY' `
                -Message 'another quarantine lease owns this exact package output; no output was moved.')
        }

        if (-not (Test-Path -LiteralPath $packageOutputFull)) {
            return [pscustomobject][ordered]@{
                OriginalPath = $packageOutputFull
                QuarantinePath = $null
                AllowedParent = $allowedParentFull
                QuarantineParent = $quarantineParentFull
                KnownExecutableNames = @()
                Handles = $handles
                FileEntries = @()
                InitialEntryKeys = @()
                RepositoryLock = $repositoryLock
                QuarantineParentDirectoryLease = $null
                Mutex = $mutex
                MutexOwned = $true
                Preserved = $true
                Active = $true
            }
        }
        if (-not (Test-Path -LiteralPath $packageOutputFull -PathType Container)) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_LOCKED' `
                -Message 'package output is not an accessible directory; no output was moved.')
        }

        $knownExecutableNames = @(Get-Phase5PackageOutputExecutableNames -PackageOutput $packageOutputFull)
        Assert-Phase5PackageOutputNotInUse -PackageOutput $packageOutputFull `
            -KnownExecutableNames $knownExecutableNames
        Assert-Phase5PackageOutputLeaseAvailable -PackageOutput $packageOutputFull

        if (Test-Path -LiteralPath $quarantineParentFull) {
            if (-not (Test-Path -LiteralPath $quarantineParentFull -PathType Container)) {
                throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PATH_INVALID' `
                    -Message 'the quarantine parent exists but is not a directory.')
            }
        } else {
            try {
                New-Item -ItemType Directory -Path $quarantineParentFull -ErrorAction Stop | Out-Null
            } catch {
                throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_PATH_INVALID' `
                    -Message 'the quarantine parent could not be created exclusively.')
            }
        }
        Assert-Phase5NoReparsePoint -Path $quarantineParentFull -AllowedParent $repositoryRootFull
        try {
            $quarantineParentDirectoryLease = `
                [Phase5.PackageOutputQuarantineNative]::OpenDirectoryIdentityLease($quarantineParentFull)
        } catch {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_PARENT_LOCKED' `
                -Message 'the quarantine parent could not be pinned to a stable directory identity.')
        }
        Assert-Phase5PackageQuarantineParentIdentity `
            -DirectoryLease $quarantineParentDirectoryLease `
            -Path $quarantineParentFull
        $quarantineName = [IO.Path]::GetFileName($packageOutputFull) + '-' +
            [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + '-' +
            [guid]::NewGuid().ToString('N')
        $quarantinePath = Join-Path $quarantineParentFull $quarantineName
        Assert-Phase5NoReparsePoint -Path $quarantinePath -AllowedParent $quarantineParentFull

        $initialEntries = @(Get-ChildItem -LiteralPath $packageOutputFull -Recurse -Force -ErrorAction Stop |
            ForEach-Object {
                [pscustomobject]@{
                    RelativePath = Get-Phase5PackageOutputRelativePath -Root $packageOutputFull -Path $_.FullName
                    IsDirectory = [bool]$_.PSIsContainer
                    FullName = $_.FullName
                    Stream = $null
                    InitialSha256 = $null
                }
            })
        foreach ($entry in @($initialEntries | Where-Object { -not $_.IsDirectory } | Sort-Object RelativePath)) {
            $initialStream = $null
            try {
                $initialStream = [IO.File]::Open(
                    $entry.FullName,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read
                )
                $entry.InitialSha256 = Get-Phase5PackageOutputStreamSha256 -Stream $initialStream
            } catch {
                throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_LOCKED' `
                    -Message 'at least one package output file could not be hashed without concurrent writes; no output was moved.')
            } finally {
                if ($null -ne $initialStream) { $initialStream.Dispose() }
            }
        }
        $initialEntryKeys = @($initialEntries | ForEach-Object {
            ('{0}:{1}' -f $(if ($_.IsDirectory) { 'D' } else { 'F' }), $_.RelativePath)
        } | Sort-Object)
        $leasedSourceEntries = @(Get-Phase5PackageOutputEntryKeys -Root $packageOutputFull)
        if ([string]::Join("`n", $initialEntryKeys) -cne [string]::Join("`n", $leasedSourceEntries)) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
                -Message 'package output changed while file quarantine leases were acquired; no output was moved.')
        }

        Assert-Phase5PackageQuarantineParentIdentity `
            -DirectoryLease $quarantineParentDirectoryLease `
            -Path $quarantineParentFull
        [IO.Directory]::Move($packageOutputFull, $quarantinePath)
        Assert-Phase5PackageQuarantineParentIdentity `
            -DirectoryLease $quarantineParentDirectoryLease `
            -Path $quarantineParentFull

        foreach ($entry in @($initialEntries | Where-Object { -not $_.IsDirectory } | Sort-Object RelativePath)) {
            $quarantinedFile = Join-Path $quarantinePath $entry.RelativePath
            try {
                $entry.Stream = [Phase5.PackageOutputQuarantineNative]::OpenFileQuarantineLease($quarantinedFile)
            } catch {
                throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_LOCKED' `
                    -Message 'at least one quarantined file could not be held against concurrent read/write access; the complete quarantine tree was retained.')
            }
            $handles.Add($entry.Stream)
            if ((Get-Phase5PackageOutputStreamSha256 -Stream $entry.Stream) -cne $entry.InitialSha256) {
                throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
                    -Message 'package output content changed during atomic quarantine; the quarantined tree was retained.')
            }
        }

        Assert-Phase5PackageOutputNotInUse -PackageOutput $packageOutputFull `
            -AdditionalPackageOutputs @($quarantinePath) -KnownExecutableNames $knownExecutableNames
        Assert-Phase5NoReparsePoint -Path $quarantinePath -AllowedParent $quarantineParentFull
        $finalEntries = @(Get-Phase5PackageOutputEntryKeys -Root $quarantinePath)
        if ([string]::Join("`n", $initialEntryKeys) -cne [string]::Join("`n", $finalEntries)) {
            throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
                -Message 'package output changed while the quarantine lease was acquired; the quarantined tree was retained.')
        }
        return [pscustomobject][ordered]@{
            OriginalPath = $packageOutputFull
            QuarantinePath = $quarantinePath
            AllowedParent = $allowedParentFull
            QuarantineParent = $quarantineParentFull
            KnownExecutableNames = $knownExecutableNames
            Handles = $handles
            FileEntries = @($initialEntries | Where-Object { -not $_.IsDirectory })
            InitialEntryKeys = $initialEntryKeys
            RepositoryLock = $repositoryLock
            QuarantineParentDirectoryLease = $quarantineParentDirectoryLease
            Mutex = $mutex
            MutexOwned = $true
            Preserved = $false
            Active = $true
        }
    } catch {
        foreach ($handle in $handles) { try { $handle.Dispose() } catch {} }
        if ($null -ne $quarantineParentDirectoryLease) {
            try { $quarantineParentDirectoryLease.Dispose() } catch {}
        }
        if ($quarantinePath -and (Test-Path -LiteralPath $quarantinePath) -and
            -not (Test-Path -LiteralPath $packageOutputFull)) {
            $_.Exception.Data['QuarantineRetained'] = $true
            $_.Exception.Data['QuarantinePath'] = $quarantinePath
        }
        if ($mutexOwned -and $null -ne $mutex) { try { $mutex.ReleaseMutex() } catch {} }
        if ($null -ne $mutex) { $mutex.Dispose() }
        if ($null -ne $repositoryLock) {
            try { Exit-Phase5PackageRepositoryLock -Lock $repositoryLock } catch {}
        }
        throw
    }
}

function Confirm-Phase5PackageOutputQuarantineLease {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lease)

    if (-not [bool]$Lease.Active) { return }
    if ([string]::IsNullOrWhiteSpace([string]$Lease.QuarantinePath)) {
        $Lease.Preserved = $true
        return
    }
    if ([string]::IsNullOrWhiteSpace([string]$Lease.QuarantinePath) -or
        -not (Test-Path -LiteralPath $Lease.QuarantinePath -PathType Container)) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_INVALID' `
            -Message 'the leased quarantine directory is unavailable.')
    }
    if (Test-Path -LiteralPath $Lease.OriginalPath) {
        throw (New-Phase5PackageOutputException -Code 'PACKAGE_OUTPUT_QUARANTINE_CHANGED' `
            -Message 'the original package output namespace was recreated during quarantine; the old tree remains quarantined.')
    }
    Assert-Phase5PackageOutputNotInUse -PackageOutput $Lease.OriginalPath `
        -AdditionalPackageOutputs @($Lease.QuarantinePath) -KnownExecutableNames @($Lease.KnownExecutableNames)
    Assert-Phase5PackageOutputQuarantineIntegrity -Lease $Lease
    $Lease.Preserved = $true
}

function Exit-Phase5PackageOutputQuarantineLease {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lease)

    if (-not [bool]$Lease.Active) { return }
    try {
        Assert-Phase5PackageOutputQuarantineIntegrity -Lease $Lease
    } finally {
        foreach ($handle in $Lease.Handles) { try { $handle.Dispose() } catch {} }
        if ($null -ne $Lease.QuarantineParentDirectoryLease) {
            try { $Lease.QuarantineParentDirectoryLease.Dispose() } catch {}
        }
        if ([bool]$Lease.MutexOwned) {
            try { $Lease.Mutex.ReleaseMutex() } catch {}
            $Lease.MutexOwned = $false
        }
        try { $Lease.Mutex.Dispose() } catch {}
        if ($null -ne $Lease.RepositoryLock) {
            try { Exit-Phase5PackageRepositoryLock -Lock $Lease.RepositoryLock } catch {}
        }
        $Lease.Active = $false
    }
}

function Move-Phase5PackageOutputToQuarantine {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PackageOutput,
        [Parameter(Mandatory = $true)][string]$AllowedParent,
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$QuarantineParent
    )

    $lease = Enter-Phase5PackageOutputQuarantineLease `
        -PackageOutput $PackageOutput `
        -AllowedParent $AllowedParent `
        -RepositoryRoot $RepositoryRoot `
        -QuarantineParent $QuarantineParent
    try {
        Confirm-Phase5PackageOutputQuarantineLease -Lease $lease
        return $lease
    } finally {
        Exit-Phase5PackageOutputQuarantineLease -Lease $lease
    }
}

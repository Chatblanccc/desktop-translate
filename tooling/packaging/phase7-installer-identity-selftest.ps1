[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'phase7-installer-identity-selftest.ps1 requires Windows.'
}

if (-not ('Phase7.InstallerIdentitySelfTestNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Phase7 {
    public sealed class NativeOperationResult {
        public bool Success { get; private set; }
        public int ErrorCode { get; private set; }

        internal NativeOperationResult(bool success, int errorCode) {
            Success = success;
            ErrorCode = errorCode;
        }
    }

    public sealed class NativeFileIdentity {
        public uint Attributes { get; private set; }
        public uint VolumeSerialNumber { get; private set; }
        public ulong FileId { get; private set; }
        public uint NumberOfLinks { get; private set; }

        internal NativeFileIdentity(
            uint attributes,
            uint volumeSerialNumber,
            ulong fileId,
            uint numberOfLinks
        ) {
            Attributes = attributes;
            VolumeSerialNumber = volumeSerialNumber;
            FileId = fileId;
            NumberOfLinks = numberOfLinks;
        }
    }

    public sealed class NotRunException : Exception {
        public NotRunException(string message) : base(message) {
        }
    }

    public static class InstallerIdentitySelfTestNative {
        private const uint DELETE = 0x00010000;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint SYNCHRONIZE = 0x00100000;

        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;

        private const uint CREATE_NEW = 1;
        private const uint OPEN_EXISTING = 3;

        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;

        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        private const uint FILE_OPEN = 1;
        private const uint FILE_DIRECTORY_FILE = 0x00000001;
        private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
        private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;

        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint SYMBOLIC_LINK_FLAG_FILE = 0x00000000;
        private const uint SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE = 0x00000002;

        private const int FILE_DISPOSITION_INFO_CLASS = 4;
        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;
        private const int ERROR_ALREADY_EXISTS = 183;
        private const int ERROR_FILE_EXISTS = 80;
        private const int ERROR_INVALID_PARAMETER = 87;

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

        [StructLayout(LayoutKind.Sequential)]
        private struct FileDispositionInformation {
            [MarshalAs(UnmanagedType.U1)]
            public bool DeleteFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ObjectAttributes {
            public uint Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoStatusBlock {
            public IntPtr Status;
            public UIntPtr Information;
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

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            SafeFileHandle file,
            int fileInformationClass,
            ref FileDispositionInformation fileInformation,
            uint bufferSize
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(
            string existingFileName,
            string newFileName,
            uint flags
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateHardLinkW(
            string fileName,
            string existingFileName,
            IntPtr securityAttributes
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool CreateSymbolicLinkW(
            string symlinkFileName,
            string targetFileName,
            uint flags
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(
            string path,
            IntPtr securityAttributes
        );

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteFileW(string path);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RemoveDirectoryW(string path);

        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(
            out SafeFileHandle fileHandle,
            uint desiredAccess,
            ref ObjectAttributes objectAttributes,
            out IoStatusBlock ioStatusBlock,
            IntPtr allocationSize,
            uint fileAttributes,
            uint shareAccess,
            uint createDisposition,
            uint createOptions,
            IntPtr eaBuffer,
            uint eaLength
        );

        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        private static string ToExtendedLengthPath(string path) {
            if (String.IsNullOrWhiteSpace(path)) {
                throw new ArgumentException("Native path must not be empty.", "path");
            }

            var normalized = Path.GetFullPath(path).Replace('/', '\\');
            if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal)) {
                return normalized;
            }
            if (normalized.StartsWith(@"\\", StringComparison.Ordinal)) {
                return @"\\?\UNC\" + normalized.Substring(2);
            }
            return @"\\?\" + normalized;
        }

        private static SafeFileHandle OpenHandle(
            string path,
            uint desiredAccess,
            uint shareMode,
            uint flagsAndAttributes,
            string failureMessage
        ) {
            var handle = CreateFileW(
                ToExtendedLengthPath(path),
                desiredAccess,
                shareMode,
                IntPtr.Zero,
                OPEN_EXISTING,
                flagsAndAttributes,
                IntPtr.Zero
            );
            if (handle.IsInvalid) {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, failureMessage);
            }
            return handle;
        }

        private static NativeFileIdentity ReadIdentityCore(SafeFileHandle handle) {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information)) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Exact handle identity could not be read."
                );
            }

            var fileId = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            return new NativeFileIdentity(
                information.FileAttributes,
                information.VolumeSerialNumber,
                fileId,
                information.NumberOfLinks
            );
        }

        public static string CreateUniqueTestRoot(string temporaryParent) {
            var parent = Path.GetFullPath(temporaryParent)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!Directory.Exists(parent)) {
                throw new DirectoryNotFoundException("The system temporary directory does not exist.");
            }

            for (var attempt = 0; attempt < 32; ++attempt) {
                var candidate = Path.Combine(
                    parent,
                    "desktop-translate-phase7-installer-identity-" +
                        Guid.NewGuid().ToString("N")
                );
                if (CreateDirectoryW(ToExtendedLengthPath(candidate), IntPtr.Zero)) {
                    return candidate;
                }

                var error = Marshal.GetLastWin32Error();
                if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) {
                    throw new Win32Exception(error, "The unique Phase 7 test root could not be created.");
                }
            }

            throw new IOException("A unique Phase 7 test root could not be allocated.");
        }

        public static SafeFileHandle OpenDirectoryIdentityLease(string path) {
            var handle = OpenHandle(
                path,
                DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                "The exact directory identity lease could not be opened."
            );

            try {
                var identity = ReadIdentityCore(handle);
                if ((identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                    (identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                    throw new InvalidOperationException(
                        "The directory identity lease target is not a regular non-reparse directory."
                    );
                }
                return handle;
            } catch {
                handle.Dispose();
                throw;
            }
        }

        public static SafeFileHandle OpenExclusiveMarker(string path) {
            return OpenHandle(
                path,
                DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                0,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                "The exact marker handle could not be opened without sharing."
            );
        }

        public static SafeFileHandle OpenRelativeEntry(
            SafeFileHandle parent,
            string leafName,
            bool directory,
            uint shareMode
        ) {
            if (parent == null || parent.IsInvalid || parent.IsClosed) {
                throw new ObjectDisposedException("parent");
            }
            if (String.IsNullOrWhiteSpace(leafName) ||
                leafName == "." ||
                leafName == ".." ||
                leafName.IndexOf('\\') >= 0 ||
                leafName.IndexOf('/') >= 0) {
                throw new ArgumentException(
                    "Relative entry must be exactly one non-special path segment.",
                    "leafName"
                );
            }
            if ((shareMode & ~(
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
            )) != 0) {
                throw new ArgumentOutOfRangeException("shareMode");
            }

            var leafBuffer = Marshal.StringToHGlobalUni(leafName);
            var unicodeStringPointer = IntPtr.Zero;
            var addedReference = false;
            SafeFileHandle opened = null;
            try {
                var unicodeString = new UnicodeString {
                    Length = checked((ushort)(leafName.Length * 2)),
                    MaximumLength = checked((ushort)((leafName.Length + 1) * 2)),
                    Buffer = leafBuffer
                };
                unicodeStringPointer = Marshal.AllocHGlobal(
                    Marshal.SizeOf(typeof(UnicodeString))
                );
                Marshal.StructureToPtr(unicodeString, unicodeStringPointer, false);

                parent.DangerousAddRef(ref addedReference);
                var objectAttributes = new ObjectAttributes {
                    Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
                    RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = unicodeStringPointer,
                    Attributes = OBJ_CASE_INSENSITIVE,
                    SecurityDescriptor = IntPtr.Zero,
                    SecurityQualityOfService = IntPtr.Zero
                };
                IoStatusBlock ioStatusBlock;
                var options = FILE_SYNCHRONOUS_IO_NONALERT |
                    FILE_OPEN_REPARSE_POINT |
                    (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
                var status = NtCreateFile(
                    out opened,
                    DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE | 0x00000001,
                    ref objectAttributes,
                    out ioStatusBlock,
                    IntPtr.Zero,
                    0,
                    shareMode,
                    FILE_OPEN,
                    options,
                    IntPtr.Zero,
                    0
                );
                if (status != 0 || opened == null || opened.IsInvalid) {
                    var error = unchecked((int)RtlNtStatusToDosError(status));
                    if (opened != null) {
                        opened.Dispose();
                    }
                    throw new Win32Exception(
                        error,
                        "NtCreateFile could not open the immediate child relative to its pinned parent."
                    );
                }

                var identity = ReadIdentityCore(opened);
                var isDirectory = (identity.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                if ((identity.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                    isDirectory != directory) {
                    opened.Dispose();
                    throw new InvalidOperationException(
                        "The relative child has an unsafe reparse/type identity."
                    );
                }
                return opened;
            } finally {
                if (addedReference) {
                    parent.DangerousRelease();
                }
                if (unicodeStringPointer != IntPtr.Zero) {
                    Marshal.FreeHGlobal(unicodeStringPointer);
                }
                Marshal.FreeHGlobal(leafBuffer);
            }
        }

        public static NativeFileIdentity ReadIdentity(SafeFileHandle handle) {
            if (handle == null || handle.IsInvalid || handle.IsClosed) {
                throw new ObjectDisposedException("handle");
            }
            return ReadIdentityCore(handle);
        }

        public static NativeFileIdentity ReadPathIdentity(
            string path,
            bool directory,
            bool openReparsePoint
        ) {
            var flags = directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL;
            if (openReparsePoint) {
                flags |= FILE_FLAG_OPEN_REPARSE_POINT;
            }

            using (var handle = OpenHandle(
                path,
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                flags,
                "The path identity could not be opened."
            )) {
                return ReadIdentityCore(handle);
            }
        }

        public static NativeOperationResult SetDeleteDisposition(
            SafeFileHandle handle,
            bool deleteFile
        ) {
            if (handle == null || handle.IsInvalid || handle.IsClosed) {
                throw new ObjectDisposedException("handle");
            }

            var information = new FileDispositionInformation { DeleteFile = deleteFile };
            var succeeded = SetFileInformationByHandle(
                handle,
                FILE_DISPOSITION_INFO_CLASS,
                ref information,
                (uint)Marshal.SizeOf(typeof(FileDispositionInformation))
            );
            var error = succeeded ? 0 : Marshal.GetLastWin32Error();
            return new NativeOperationResult(succeeded, error);
        }

        public static NativeOperationResult TryMove(
            string source,
            string destination,
            bool replaceExisting
        ) {
            var flags = replaceExisting ? MOVEFILE_REPLACE_EXISTING : 0;
            var succeeded = MoveFileExW(
                ToExtendedLengthPath(source),
                ToExtendedLengthPath(destination),
                flags
            );
            var error = succeeded ? 0 : Marshal.GetLastWin32Error();
            return new NativeOperationResult(succeeded, error);
        }

        public static NativeOperationResult TryCreateHardLink(
            string linkPath,
            string existingPath
        ) {
            var succeeded = CreateHardLinkW(
                ToExtendedLengthPath(linkPath),
                ToExtendedLengthPath(existingPath),
                IntPtr.Zero
            );
            var error = succeeded ? 0 : Marshal.GetLastWin32Error();
            return new NativeOperationResult(succeeded, error);
        }

        public static NativeOperationResult TryCreateFileSymbolicLink(
            string linkPath,
            string targetPath
        ) {
            var succeeded = CreateSymbolicLinkW(
                ToExtendedLengthPath(linkPath),
                ToExtendedLengthPath(targetPath),
                SYMBOLIC_LINK_FLAG_FILE | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
            );
            var error = succeeded ? 0 : Marshal.GetLastWin32Error();
            if (!succeeded && error == ERROR_INVALID_PARAMETER) {
                succeeded = CreateSymbolicLinkW(
                    ToExtendedLengthPath(linkPath),
                    ToExtendedLengthPath(targetPath),
                    SYMBOLIC_LINK_FLAG_FILE
                );
                error = succeeded ? 0 : Marshal.GetLastWin32Error();
            }
            return new NativeOperationResult(succeeded, error);
        }

        private static bool IsStrictChild(string candidate, string parent) {
            var candidateFull = Path.GetFullPath(candidate)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var parentFull = Path.GetFullPath(parent)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return candidateFull.StartsWith(
                parentFull + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase
            );
        }

        private static void DeleteEntryNoFollow(string path, string root) {
            if (!IsStrictChild(path, root)) {
                throw new InvalidOperationException("Cleanup entry escaped the unique test root.");
            }

            var nativePath = ToExtendedLengthPath(path);
            var attributes = GetFileAttributesW(nativePath);
            if (attributes == INVALID_FILE_ATTRIBUTES) {
                var error = Marshal.GetLastWin32Error();
                if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
                    return;
                }
                throw new Win32Exception(error, "A test cleanup entry could not be inspected.");
            }

            var isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            var isReparsePoint = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
            if (isReparsePoint) {
                var removed = isDirectory
                    ? RemoveDirectoryW(nativePath)
                    : DeleteFileW(nativePath);
                if (!removed) {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "A test reparse point could not be removed without following it."
                    );
                }
                return;
            }

            if (isDirectory) {
                foreach (var child in Directory.EnumerateFileSystemEntries(path)) {
                    DeleteEntryNoFollow(child, root);
                }
                if (!RemoveDirectoryW(nativePath)) {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "A test directory could not be removed non-recursively."
                    );
                }
                return;
            }

            if (!DeleteFileW(nativePath)) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "A test file could not be removed."
                );
            }
        }

        public static void RemoveUniqueTestRoot(string testRoot, string temporaryParent) {
            var root = Path.GetFullPath(testRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var parent = Path.GetFullPath(temporaryParent)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!IsStrictChild(root, parent) ||
                !Path.GetFileName(root).StartsWith(
                    "desktop-translate-phase7-installer-identity-",
                    StringComparison.Ordinal
                )) {
                throw new InvalidOperationException(
                    "Cleanup refused a path outside the unique Phase 7 test-root boundary."
                );
            }

            var attributes = GetFileAttributesW(ToExtendedLengthPath(root));
            if (attributes == INVALID_FILE_ATTRIBUTES) {
                var error = Marshal.GetLastWin32Error();
                if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
                    return;
                }
                throw new Win32Exception(error, "The unique test root could not be inspected.");
            }
            if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
                throw new InvalidOperationException(
                    "Cleanup refused a non-directory or reparse test root."
                );
            }

            foreach (var child in Directory.EnumerateFileSystemEntries(root)) {
                DeleteEntryNoFollow(child, root);
            }
            if (!RemoveDirectoryW(ToExtendedLengthPath(root))) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "The empty unique test root could not be removed non-recursively."
                );
            }
        }
    }
}
'@
}

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Results = New-Object 'System.Collections.Generic.List[object]'
$script:TestRoot = $null
$script:TemporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())

function Assert-Phase7True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Phase7IdentityEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($Expected.VolumeSerialNumber -ne $Actual.VolumeSerialNumber -or
        $Expected.FileId -ne $Actual.FileId) {
        throw $Message
    }
}

function Assert-Phase7SharingBlock {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][string]$Message
    )

    Assert-Phase7True (-not $Operation.Success) $Message
    Assert-Phase7True ($Operation.ErrorCode -in @(5, 32)) `
        "$Message Win32 returned unexpected error $($Operation.ErrorCode), not access/sharing denial."
}

function Write-Phase7TestFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function New-Phase7CaseDirectory {
    param([Parameter(Mandatory = $true)][string]$Name)

    $path = Join-Path $script:TestRoot $Name
    [void][IO.Directory]::CreateDirectory($path)
    return $path
}

function Invoke-Phase7TestCase {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    try {
        $detail = & $Body
        $result = [pscustomobject]@{
            Name = $Name
            Status = 'PASS'
            Detail = [string]$detail
        }
        [void]$script:Results.Add($result)
        Write-Host "[phase7:installer-identity:selftest] PASS ${Name}: $detail"
    } catch [Phase7.NotRunException] {
        $result = [pscustomobject]@{
            Name = $Name
            Status = 'NOT RUN'
            Detail = $_.Exception.Message
        }
        [void]$script:Results.Add($result)
        Write-Host "[phase7:installer-identity:selftest] NOT RUN ${Name}: $($_.Exception.Message)"
    } catch {
        $result = [pscustomobject]@{
            Name = $Name
            Status = 'FAIL'
            Detail = $_.Exception.Message
        }
        [void]$script:Results.Add($result)
        Write-Host "[phase7:installer-identity:selftest] FAIL ${Name}: $($_.Exception.Message)"
    }
}

try {
    $script:TestRoot = [Phase7.InstallerIdentitySelfTestNative]::CreateUniqueTestRoot(
        $script:TemporaryParent
    )

    Invoke-Phase7TestCase -Name 'directory-lease-blocks-rename-replacement' -Body {
        $caseRoot = New-Phase7CaseDirectory 'directory-lease'
        $owned = Join-Path $caseRoot 'owned'
        $displaced = Join-Path $caseRoot 'displaced'
        $replacement = Join-Path $caseRoot 'replacement'
        [void][IO.Directory]::CreateDirectory($owned)
        [void][IO.Directory]::CreateDirectory($replacement)
        Write-Phase7TestFile (Join-Path $owned 'owned.txt') 'owned-directory'
        Write-Phase7TestFile (Join-Path $replacement 'replacement.txt') 'replacement-directory'

        $ownedBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $owned,
            $true,
            $true
        )
        $replacementBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacement,
            $true,
            $true
        )

        $lease = $null
        try {
            $lease = [Phase7.InstallerIdentitySelfTestNative]::OpenDirectoryIdentityLease($owned)
            $leasedIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity($lease)
            Assert-Phase7IdentityEqual $ownedBefore $leasedIdentity `
                'The directory lease did not bind the expected directory identity.'

            $renameWhileLeased = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $owned,
                $displaced,
                $false
            )
            Assert-Phase7SharingBlock $renameWhileLeased `
                'A DELETE|READ_ATTRIBUTES|SYNCHRONIZE directory lease without SHARE_DELETE allowed rename-away.'

            $replaceWhileLeased = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $replacement,
                $owned,
                $true
            )
            Assert-Phase7True (-not $replaceWhileLeased.Success) `
                'A replacement directory moved over the leased directory path.'

            $ownedDuring = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
                $owned,
                $true,
                $true
            )
            $replacementDuring = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
                $replacement,
                $true,
                $true
            )
            Assert-Phase7IdentityEqual $ownedBefore $ownedDuring `
                'The leased pathname stopped naming the exact owned directory.'
            Assert-Phase7IdentityEqual $replacementBefore $replacementDuring `
                'The blocked replacement directory identity changed.'
        } finally {
            if ($null -ne $lease) {
                $lease.Dispose()
            }
        }

        $renameAfterClose = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
            $owned,
            $displaced,
            $false
        )
        Assert-Phase7True $renameAfterClose.Success `
            "The rename control failed after the lease closed (Win32 $($renameAfterClose.ErrorCode))."
        $replaceAfterClose = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
            $replacement,
            $owned,
            $false
        )
        Assert-Phase7True $replaceAfterClose.Success `
            "The replacement-chain control failed after the lease closed (Win32 $($replaceAfterClose.ErrorCode))."

        $displacedAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $displaced,
            $true,
            $true
        )
        $ownedAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $owned,
            $true,
            $true
        )
        Assert-Phase7IdentityEqual $ownedBefore $displacedAfter `
            'The post-close rename control did not move the originally leased identity.'
        Assert-Phase7IdentityEqual $replacementBefore $ownedAfter `
            'The post-close replacement control did not install the replacement identity.'

        "rename denied with Win32 $($renameWhileLeased.ErrorCode); the same rename/replacement chain succeeded only after handle close"
    }

    Invoke-Phase7TestCase -Name 'child-recovery-marker-blocks-root-rename-replacement' -Body {
        $caseRoot = New-Phase7CaseDirectory 'child-recovery-marker-root-lease'
        $ownedRoot = Join-Path $caseRoot 'owned-root'
        $renamedRoot = Join-Path $caseRoot 'renamed-root'
        $replacementRoot = Join-Path $caseRoot 'replacement-root'
        $recoveryMarker = Join-Path $ownedRoot '.desktop-translate-install.recovering.json'
        $ownedSentinel = Join-Path $ownedRoot 'owned.txt'
        $replacementSentinel = Join-Path $replacementRoot 'replacement.txt'
        [void][IO.Directory]::CreateDirectory($ownedRoot)
        [void][IO.Directory]::CreateDirectory($replacementRoot)
        Write-Phase7TestFile $recoveryMarker '{"state":"recovering"}'
        Write-Phase7TestFile $ownedSentinel 'owned-root'
        Write-Phase7TestFile $replacementSentinel 'replacement-root'

        $ownedBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $ownedRoot,
            $true,
            $true
        )
        $replacementBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacementRoot,
            $true,
            $true
        )
        $markerBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $recoveryMarker,
            $false,
            $true
        )

        $markerHandle = $null
        try {
            $markerHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenExclusiveMarker(
                $recoveryMarker
            )
            $heldMarker = [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity(
                $markerHandle
            )
            Assert-Phase7IdentityEqual $markerBefore $heldMarker `
                'The share=0 handle did not bind the expected child recovery-marker identity.'

            $renameWhileMarkerHeld = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $ownedRoot,
                $renamedRoot,
                $false
            )
            Assert-Phase7SharingBlock $renameWhileMarkerHeld `
                'A share=0 child recovery-marker handle allowed root rename-away.'

            $replaceWhileMarkerHeld = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $replacementRoot,
                $ownedRoot,
                $true
            )
            Assert-Phase7SharingBlock $replaceWhileMarkerHeld `
                'A share=0 child recovery-marker handle allowed replacement over its root.'

            $ownedDuring = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
                $ownedRoot,
                $true,
                $true
            )
            $replacementDuring = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
                $replacementRoot,
                $true,
                $true
            )
            Assert-Phase7IdentityEqual $ownedBefore $ownedDuring `
                'The held child marker did not preserve the exact owned-root pathname identity.'
            Assert-Phase7IdentityEqual $replacementBefore $replacementDuring `
                'The blocked replacement-root identity changed.'
        } finally {
            if ($null -ne $markerHandle) {
                $markerHandle.Dispose()
            }
        }

        $renameAfterMarkerClose = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
            $ownedRoot,
            $renamedRoot,
            $false
        )
        Assert-Phase7True $renameAfterMarkerClose.Success `
            "The root rename control failed after the child marker closed (Win32 $($renameAfterMarkerClose.ErrorCode))."

        $renamedAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $renamedRoot,
            $true,
            $true
        )
        Assert-Phase7IdentityEqual $ownedBefore $renamedAfter `
            'The post-close rename control did not move the original owned-root identity.'
        Assert-Phase7True (-not [IO.Directory]::Exists($ownedRoot)) `
            'The old owned-root pathname remained after the successful control rename.'
        Assert-Phase7True (
            [IO.File]::ReadAllText(
                (Join-Path $renamedRoot '.desktop-translate-install.recovering.json'),
                $script:Utf8NoBom
            ) -eq '{"state":"recovering"}'
        ) 'The successful control rename did not preserve the exact recovery marker.'
        Assert-Phase7True (
            [IO.File]::ReadAllText($replacementSentinel, $script:Utf8NoBom) -eq
                'replacement-root'
        ) 'The blocked replacement root was changed by the control sequence.'

        "root rename-away/replacement denied with exact Win32 $($renameWhileMarkerHeld.ErrorCode)/$($replaceWhileMarkerHeld.ErrorCode); rename succeeded after the share=0 child marker closed"
    }

    Invoke-Phase7TestCase -Name 'empty-directory-handle-disposition' -Body {
        $caseRoot = New-Phase7CaseDirectory 'empty-directory-disposition'
        $owned = Join-Path $caseRoot 'owned-empty'
        $sibling = Join-Path $caseRoot 'sibling.txt'
        [void][IO.Directory]::CreateDirectory($owned)
        Write-Phase7TestFile $sibling 'preserve-empty-sibling'

        $handle = $null
        try {
            $handle = [Phase7.InstallerIdentitySelfTestNative]::OpenDirectoryIdentityLease($owned)
            $deleteResult = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $handle,
                $true
            )
            Assert-Phase7True $deleteResult.Success `
                "FileDispositionInfo rejected the exact empty directory handle (Win32 $($deleteResult.ErrorCode))."
        } finally {
            if ($null -ne $handle) {
                $handle.Dispose()
            }
        }

        Assert-Phase7True (-not [IO.Directory]::Exists($owned)) `
            'The exact empty directory remained after its delete-disposition handle closed.'
        Assert-Phase7True ([IO.File]::ReadAllText($sibling, $script:Utf8NoBom) -eq 'preserve-empty-sibling') `
            'Empty-directory handle disposition modified a sibling.'
        'FileDispositionInfo removed the exact empty directory on handle close and preserved its sibling'
    }

    Invoke-Phase7TestCase -Name 'nonempty-directory-disposition-fails-closed' -Body {
        $caseRoot = New-Phase7CaseDirectory 'nonempty-directory-disposition'
        $owned = Join-Path $caseRoot 'owned-nonempty'
        $child = Join-Path $owned 'child.txt'
        [void][IO.Directory]::CreateDirectory($owned)
        Write-Phase7TestFile $child 'must-survive'

        $handle = $null
        $deleteResult = $null
        try {
            $handle = [Phase7.InstallerIdentitySelfTestNative]::OpenDirectoryIdentityLease($owned)
            $deleteResult = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $handle,
                $true
            )
            if ($deleteResult.Success) {
                [void][Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                    $handle,
                    $false
                )
                throw 'FileDispositionInfo unexpectedly accepted a nonempty directory.'
            }
            Assert-Phase7True ($deleteResult.ErrorCode -eq 145) `
                "Nonempty directory disposition returned Win32 $($deleteResult.ErrorCode), not ERROR_DIR_NOT_EMPTY (145)."
        } finally {
            if ($null -ne $handle) {
                $handle.Dispose()
            }
        }

        Assert-Phase7True ([IO.Directory]::Exists($owned)) `
            'The rejected nonempty directory disposition removed the directory.'
        Assert-Phase7True ([IO.File]::Exists($child)) `
            'The rejected nonempty directory disposition removed its child.'
        Assert-Phase7True ([IO.File]::ReadAllText($child, $script:Utf8NoBom) -eq 'must-survive') `
            'The rejected nonempty directory disposition changed child content.'
        'FileDispositionInfo failed with ERROR_DIR_NOT_EMPTY and retained the directory plus exact child content'
    }

    Invoke-Phase7TestCase -Name 'exclusive-marker-handle-blocks-replace-and-deletes-owned-name' -Body {
        $caseRoot = New-Phase7CaseDirectory 'exclusive-marker'
        $marker = Join-Path $caseRoot 'owned.marker'
        $renamed = Join-Path $caseRoot 'renamed.marker'
        $replacement = Join-Path $caseRoot 'replacement.marker'
        $sibling = Join-Path $caseRoot 'sibling.txt'
        Write-Phase7TestFile $marker 'owned-marker'
        Write-Phase7TestFile $replacement 'replacement-marker'
        Write-Phase7TestFile $sibling 'preserve-marker-sibling'

        $replacementBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacement,
            $false,
            $true
        )
        $handle = $null
        try {
            $handle = [Phase7.InstallerIdentitySelfTestNative]::OpenExclusiveMarker($marker)

            $renameWhileOwned = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $marker,
                $renamed,
                $false
            )
            Assert-Phase7SharingBlock $renameWhileOwned `
                'The share=0 marker handle allowed its owned pathname to be renamed.'

            $replaceWhileOwned = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $replacement,
                $marker,
                $true
            )
            Assert-Phase7SharingBlock $replaceWhileOwned `
                'The share=0 marker handle allowed a replacement over its pathname.'

            $deleteResult = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $handle,
                $true
            )
            Assert-Phase7True $deleteResult.Success `
                "The exact owned marker handle could not request deletion (Win32 $($deleteResult.ErrorCode))."
        } finally {
            if ($null -ne $handle) {
                $handle.Dispose()
            }
        }

        Assert-Phase7True (-not [IO.File]::Exists($marker)) `
            'The exact owned marker name remained after handle disposition and close.'
        Assert-Phase7True (-not [IO.File]::Exists($renamed)) `
            'A blocked marker rename unexpectedly created its destination.'
        Assert-Phase7True ([IO.File]::ReadAllText($replacement, $script:Utf8NoBom) -eq 'replacement-marker') `
            'Handle disposition deleted or changed the blocked replacement file.'
        Assert-Phase7True ([IO.File]::ReadAllText($sibling, $script:Utf8NoBom) -eq 'preserve-marker-sibling') `
            'Handle disposition deleted or changed a marker sibling.'
        $replacementAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacement,
            $false,
            $true
        )
        Assert-Phase7IdentityEqual $replacementBefore $replacementAfter `
            'The exact replacement identity changed during owned-marker deletion.'

        "rename/replace denied with Win32 $($renameWhileOwned.ErrorCode)/$($replaceWhileOwned.ErrorCode); disposition removed only the owned marker name"
    }

    Invoke-Phase7TestCase -Name 'durable-stage-identity-rejects-path-replacement' -Body {
        $caseRoot = New-Phase7CaseDirectory 'durable-stage-identity'
        $stage = Join-Path $caseRoot 'stage'
        $displaced = Join-Path $caseRoot 'displaced'
        $replacement = Join-Path $caseRoot 'replacement'
        [void][IO.Directory]::CreateDirectory($stage)
        [void][IO.Directory]::CreateDirectory($replacement)
        Write-Phase7TestFile (Join-Path $stage 'owned.txt') 'durable-owned-stage'
        Write-Phase7TestFile (Join-Path $replacement 'replacement.txt') 'durable-replacement'

        $durableIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $stage,
            $true,
            $true
        )
        $rename = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
            $stage,
            $displaced,
            $false
        )
        Assert-Phase7True $rename.Success `
            "The durable-identity replacement setup could not displace staging (Win32 $($rename.ErrorCode))."
        $replace = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
            $replacement,
            $stage,
            $false
        )
        Assert-Phase7True $replace.Success `
            "The durable-identity replacement setup could not install a replacement (Win32 $($replace.ErrorCode))."

        $replacementIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $stage,
            $true,
            $true
        )
        Assert-Phase7True (
            $durableIdentity.VolumeSerialNumber -ne $replacementIdentity.VolumeSerialNumber -or
            $durableIdentity.FileId -ne $replacementIdentity.FileId
        ) 'A replacement stage pathname incorrectly matched the durable transaction directory identity.'
        $displacedIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $displaced,
            $true,
            $true
        )
        Assert-Phase7IdentityEqual $durableIdentity $displacedIdentity `
            'The durable transaction identity did not follow the exact displaced directory object.'
        Assert-Phase7True (
            [IO.File]::ReadAllText(
                (Join-Path $displaced 'owned.txt'),
                $script:Utf8NoBom
            ) -eq 'durable-owned-stage'
        ) 'The displaced durable stage content changed during pathname replacement.'
        Assert-Phase7True (
            [IO.File]::ReadAllText(
                (Join-Path $stage 'replacement.txt'),
                $script:Utf8NoBom
            ) -eq 'durable-replacement'
        ) 'The replacement stage control content was not preserved.'

        "durable volume/file-id rejected a replaced stage pathname; original identity followed the displaced object"
    }

    Invoke-Phase7TestCase -Name 'committed-relative-allowlist-preserves-unknown-entry' -Body {
        $caseRoot = New-Phase7CaseDirectory 'committed-relative-allowlist'
        $stage = Join-Path $caseRoot 'stage'
        $renamed = Join-Path $caseRoot 'renamed'
        $replacement = Join-Path $caseRoot 'replacement'
        $resources = Join-Path $stage 'resources'
        $manifest = Join-Path $resources 'manifest'
        $known = Join-Path $manifest 'product-manifest.json'
        $marker = Join-Path $stage '.desktop-translate-install.json'
        $unknown = Join-Path $stage 'user-unknown.txt'
        [void][IO.Directory]::CreateDirectory($manifest)
        [void][IO.Directory]::CreateDirectory($replacement)
        Write-Phase7TestFile $known '{"owned":true}'
        Write-Phase7TestFile $marker '{"schema":1,"product":"desktop-translate"}'
        Write-Phase7TestFile $unknown 'must-survive-unknown'
        Write-Phase7TestFile (Join-Path $replacement 'replacement.txt') 'must-survive-replacement'

        $stageIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $stage,
            $true,
            $true
        )
        $knownIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $known,
            $false,
            $true
        )
        $rootHandle = $null
        $markerHandle = $null
        $resourcesHandle = $null
        $manifestHandle = $null
        $knownHandle = $null
        try {
            $rootHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenDirectoryIdentityLease(
                $stage
            )
            Assert-Phase7IdentityEqual $stageIdentity (
                [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity($rootHandle)
            ) 'The committed cleanup root lease did not bind the durable stage identity.'

            $renameWhileLeased = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $stage,
                $renamed,
                $false
            )
            Assert-Phase7SharingBlock $renameWhileLeased `
                'The committed cleanup root lease allowed staging rename-away.'
            $replaceWhileLeased = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $replacement,
                $stage,
                $true
            )
            Assert-Phase7SharingBlock $replaceWhileLeased `
                'The committed cleanup root lease allowed staging replacement.'

            $markerHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenRelativeEntry(
                $rootHandle,
                '.desktop-translate-install.json',
                $false,
                0
            )
            $markerIdentity = [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity(
                $markerHandle
            )
            Assert-Phase7True ($markerIdentity.NumberOfLinks -eq 1) `
                'The committed stable marker was not a single-link exact identity.'

            $resourcesHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenRelativeEntry(
                $rootHandle,
                'resources',
                $true,
                3
            )
            $manifestHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenRelativeEntry(
                $resourcesHandle,
                'manifest',
                $true,
                3
            )
            $knownHandle = [Phase7.InstallerIdentitySelfTestNative]::OpenRelativeEntry(
                $manifestHandle,
                'product-manifest.json',
                $false,
                3
            )
            Assert-Phase7IdentityEqual $knownIdentity (
                [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity($knownHandle)
            ) 'Parent-relative NtCreateFile did not bind the expected allowlisted leaf identity.'

            $deleteKnown = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $knownHandle,
                $true
            )
            Assert-Phase7True $deleteKnown.Success `
                "The relative allowlisted file could not be disposed (Win32 $($deleteKnown.ErrorCode))."
            $knownHandle.Dispose()
            $knownHandle = $null
            Assert-Phase7True (-not [IO.File]::Exists($known)) `
                'The parent-relative allowlisted file remained after exact-handle disposition.'

            $deleteManifest = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $manifestHandle,
                $true
            )
            Assert-Phase7True $deleteManifest.Success `
                "The emptied manifest directory could not be disposed (Win32 $($deleteManifest.ErrorCode))."
            $manifestHandle.Dispose()
            $manifestHandle = $null
            $deleteResources = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $resourcesHandle,
                $true
            )
            Assert-Phase7True $deleteResources.Success `
                "The emptied resources directory could not be disposed (Win32 $($deleteResources.ErrorCode))."
            $resourcesHandle.Dispose()
            $resourcesHandle = $null
            Assert-Phase7True (-not [IO.Directory]::Exists($resources)) `
                'The exact nested allowlist directories remained after handle disposition.'

            $rootWithMarkerAndUnknown = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $rootHandle,
                $true
            )
            Assert-Phase7True (
                -not $rootWithMarkerAndUnknown.Success -and
                $rootWithMarkerAndUnknown.ErrorCode -eq 145
            ) "The nonempty committed root did not fail with ERROR_DIR_NOT_EMPTY (Win32 $($rootWithMarkerAndUnknown.ErrorCode))."

            $deleteMarker = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $markerHandle,
                $true
            )
            Assert-Phase7True $deleteMarker.Success `
                "The pinned stable marker could not be disposed last (Win32 $($deleteMarker.ErrorCode))."
            $markerHandle.Dispose()
            $markerHandle = $null
            Assert-Phase7True (-not [IO.File]::Exists($marker)) `
                'The pinned stable marker remained after exact-handle disposition.'

            $rootWithUnknown = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $rootHandle,
                $true
            )
            Assert-Phase7True (
                -not $rootWithUnknown.Success -and
                $rootWithUnknown.ErrorCode -eq 145
            ) "An unknown entry did not keep committed root deletion fail-closed (Win32 $($rootWithUnknown.ErrorCode))."
            Assert-Phase7True (
                [IO.File]::ReadAllText($unknown, $script:Utf8NoBom) -eq
                    'must-survive-unknown'
            ) 'Committed allowlist cleanup deleted or changed an unknown entry.'
            Assert-Phase7True (
                [IO.File]::ReadAllText(
                    (Join-Path $replacement 'replacement.txt'),
                    $script:Utf8NoBom
                ) -eq 'must-survive-replacement'
            ) 'Committed cleanup changed the blocked replacement root.'
        } finally {
            foreach ($handle in @(
                $knownHandle,
                $manifestHandle,
                $resourcesHandle,
                $markerHandle,
                $rootHandle
            )) {
                if ($null -ne $handle) {
                    $handle.Dispose()
                }
            }
        }

        "nested NtCreateFile allowlist deleted only exact owned handles; marker stayed pinned until last and unknown residue blocked root deletion"
    }

    Invoke-Phase7TestCase -Name 'hardlink-exact-name-disposition' -Body {
        $caseRoot = New-Phase7CaseDirectory 'hardlink'
        $owned = Join-Path $caseRoot 'owned.marker'
        $alias = Join-Path $caseRoot 'alias.marker'
        Write-Phase7TestFile $owned 'hardlink-marker'

        $createResult = [Phase7.InstallerIdentitySelfTestNative]::TryCreateHardLink(
            $alias,
            $owned
        )
        if (-not $createResult.Success) {
            if ($createResult.ErrorCode -in @(1, 5, 50, 87, 1314)) {
                throw [Phase7.NotRunException]::new(
                    "standard-user hardlink creation is unavailable (Win32 $($createResult.ErrorCode))"
                )
            }
            throw "Hardlink creation failed unexpectedly with Win32 $($createResult.ErrorCode)."
        }

        $ownedBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $owned,
            $false,
            $true
        )
        $aliasBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $alias,
            $false,
            $true
        )
        Assert-Phase7IdentityEqual $ownedBefore $aliasBefore `
            'CreateHardLinkW did not expose one shared file identity.'
        Assert-Phase7True ($ownedBefore.NumberOfLinks -eq 2) `
            "The hardlinked marker reported $($ownedBefore.NumberOfLinks) links, not exactly two."

        $handle = $null
        try {
            $handle = [Phase7.InstallerIdentitySelfTestNative]::OpenExclusiveMarker($owned)
            $deleteResult = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $handle,
                $true
            )
            Assert-Phase7True $deleteResult.Success `
                "Hardlinked exact-name disposition failed with Win32 $($deleteResult.ErrorCode)."
        } finally {
            if ($null -ne $handle) {
                $handle.Dispose()
            }
        }

        Assert-Phase7True (-not [IO.File]::Exists($owned)) `
            'Handle disposition did not remove the exact opened hardlink name.'
        Assert-Phase7True ([IO.File]::Exists($alias)) `
            'Handle disposition removed the independent hardlink name.'
        Assert-Phase7True ([IO.File]::ReadAllText($alias, $script:Utf8NoBom) -eq 'hardlink-marker') `
            'Handle disposition changed content reachable through the retained hardlink.'
        $aliasAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $alias,
            $false,
            $true
        )
        Assert-Phase7IdentityEqual $aliasBefore $aliasAfter `
            'The retained hardlink stopped naming the original file identity.'
        Assert-Phase7True ($aliasAfter.NumberOfLinks -eq 1) `
            "The retained hardlink reported $($aliasAfter.NumberOfLinks) names after exact-name deletion."

        'CreateHardLinkW succeeded as standard user; link count exposed aliasing and disposition removed only the opened name'
    }

    Invoke-Phase7TestCase -Name 'reparse-open-point-exact-disposition' -Body {
        $caseRoot = New-Phase7CaseDirectory 'reparse'
        $target = Join-Path $caseRoot 'target.txt'
        $link = Join-Path $caseRoot 'link.txt'
        $replacement = Join-Path $caseRoot 'replacement.txt'
        Write-Phase7TestFile $target 'reparse-target'
        Write-Phase7TestFile $replacement 'reparse-replacement'

        $createResult = [Phase7.InstallerIdentitySelfTestNative]::TryCreateFileSymbolicLink(
            $link,
            $target
        )
        if (-not $createResult.Success) {
            if ($createResult.ErrorCode -in @(1, 5, 50, 87, 1314)) {
                throw [Phase7.NotRunException]::new(
                    "standard-user symbolic-link/reparse creation is unavailable (Win32 $($createResult.ErrorCode))"
                )
            }
            throw "Symbolic-link/reparse creation failed unexpectedly with Win32 $($createResult.ErrorCode)."
        }

        $targetBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $target,
            $false,
            $true
        )
        $linkBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $link,
            $false,
            $true
        )
        Assert-Phase7True (($linkBefore.Attributes -band 0x00000400) -ne 0) `
            'OPEN_REPARSE_POINT did not bind the reparse object itself.'
        Assert-Phase7True (
            $linkBefore.VolumeSerialNumber -ne $targetBefore.VolumeSerialNumber -or
            $linkBefore.FileId -ne $targetBefore.FileId
        ) 'The reparse-object identity unexpectedly matched its target identity.'

        $replacementBefore = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacement,
            $false,
            $true
        )
        $handle = $null
        try {
            $handle = [Phase7.InstallerIdentitySelfTestNative]::OpenExclusiveMarker($link)
            $leasedLink = [Phase7.InstallerIdentitySelfTestNative]::ReadIdentity($handle)
            Assert-Phase7IdentityEqual $linkBefore $leasedLink `
                'The exclusive OPEN_REPARSE_POINT handle followed the reparse target.'

            $replaceWhileOwned = [Phase7.InstallerIdentitySelfTestNative]::TryMove(
                $replacement,
                $link,
                $true
            )
            Assert-Phase7SharingBlock $replaceWhileOwned `
                'The share=0 reparse-object handle allowed pathname replacement.'

            $deleteResult = [Phase7.InstallerIdentitySelfTestNative]::SetDeleteDisposition(
                $handle,
                $true
            )
            Assert-Phase7True $deleteResult.Success `
                "Reparse-object handle disposition failed with Win32 $($deleteResult.ErrorCode)."
        } finally {
            if ($null -ne $handle) {
                $handle.Dispose()
            }
        }

        Assert-Phase7True (-not [IO.File]::Exists($link)) `
            'Handle disposition did not remove the exact reparse name.'
        Assert-Phase7True ([IO.File]::ReadAllText($target, $script:Utf8NoBom) -eq 'reparse-target') `
            'Reparse-object handle disposition deleted or changed its target.'
        Assert-Phase7True ([IO.File]::ReadAllText($replacement, $script:Utf8NoBom) -eq 'reparse-replacement') `
            'Reparse-object handle disposition deleted or changed the blocked replacement.'

        $targetAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $target,
            $false,
            $true
        )
        $replacementAfter = [Phase7.InstallerIdentitySelfTestNative]::ReadPathIdentity(
            $replacement,
            $false,
            $true
        )
        Assert-Phase7IdentityEqual $targetBefore $targetAfter `
            'The reparse target identity changed during exact-link deletion.'
        Assert-Phase7IdentityEqual $replacementBefore $replacementAfter `
            'The blocked reparse replacement identity changed.'

        'standard-user reparse creation succeeded; OPEN_REPARSE_POINT disposition removed only the link and preserved target/replacement'
    }
} catch {
    [void]$script:Results.Add([pscustomobject]@{
        Name = 'selftest-runtime'
        Status = 'FAIL'
        Detail = $_.Exception.Message
    })
    Write-Host "[phase7:installer-identity:selftest] FAIL selftest-runtime: $($_.Exception.Message)"
} finally {
    if ($null -ne $script:TestRoot) {
        try {
            [Phase7.InstallerIdentitySelfTestNative]::RemoveUniqueTestRoot(
                $script:TestRoot,
                $script:TemporaryParent
            )
        } catch {
            [void]$script:Results.Add([pscustomobject]@{
                Name = 'unique-temp-root-cleanup'
                Status = 'FAIL'
                Detail = $_.Exception.Message
            })
            Write-Host "[phase7:installer-identity:selftest] FAIL unique-temp-root-cleanup: $($_.Exception.Message)"
        }
    }
}

$failures = @($script:Results | Where-Object { $_.Status -eq 'FAIL' })
$notRun = @($script:Results | Where-Object { $_.Status -eq 'NOT RUN' })
$passed = @($script:Results | Where-Object { $_.Status -eq 'PASS' })

if ($failures.Count -gt 0) {
    Write-Host "[phase7:installer-identity:selftest] RESULT=FAIL pass=$($passed.Count) fail=$($failures.Count) notRun=$($notRun.Count)"
    throw "Phase 7 installer identity runtime selftest failed: $(
        ($failures | ForEach-Object { "$($_.Name): $($_.Detail)" }) -join '; '
    )"
}

if ($notRun.Count -gt 0) {
    Write-Host "[phase7:installer-identity:selftest] RESULT=NOT_RUN pass=$($passed.Count) fail=0 notRun=$($notRun.Count); optional identity coverage is incomplete and must not be treated as green."
    exit 2
}

Write-Host "[phase7:installer-identity:selftest] RESULT=PASS pass=$($passed.Count) fail=0 notRun=0; exact handle, rename/replacement, disposition, hardlink, reparse, and safe-cleanup semantics verified."

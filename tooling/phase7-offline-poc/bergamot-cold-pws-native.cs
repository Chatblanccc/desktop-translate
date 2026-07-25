using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class Phase7BergamotProcessRecord {
    public int ProcessId { get; set; }
    public long CreationTicks { get; set; }
    public string ExecutablePath { get; set; }
}

public sealed class Phase7BergamotPwsResult {
    public string Status { get; set; }
    public long PrivateWorkingSetBytes { get; set; }
    public int NativeErrorCode { get; set; }
}

public sealed class Phase7BergamotTransitionProbe {
    public string Status { get; set; }
    public uint TotalProcessesBefore { get; set; }
    public uint TotalProcessesAfter { get; set; }
    public uint AccountingActiveProcessesBefore { get; set; }
    public uint AccountingActiveProcessesAfter { get; set; }
    public uint BoundActiveProcesses { get; set; }
    public uint KnownProcessIdentities { get; set; }
    public Phase7BergamotProcessRecord[] BoundActiveRecords { get; set; }
}

public sealed class Phase7BergamotJobLaunch {
    public Phase7BergamotJobLaunch() {
        KnownProcessIdentities =
            new Dictionary<string, Phase7BergamotProcessRecord>();
        LastProcessDiscoveryStatus = "NOT_QUERIED";
    }

    public IntPtr JobHandle { get; set; }
    public IntPtr ProcessHandle { get; set; }
    public IntPtr ThreadHandle { get; set; }
    public int ProcessId { get; set; }
    public long CreationTicks { get; set; }
    public bool Resumed { get; set; }
    public bool Closed { get; set; }
    public Dictionary<string, Phase7BergamotProcessRecord>
        KnownProcessIdentities { get; private set; }
    public string LastProcessDiscoveryStatus { get; set; }
    public uint LastTotalProcesses { get; set; }
    public uint LastActiveProcesses { get; set; }
    public uint LastReportedAccountingActiveProcesses { get; set; }
}

public static class Phase7BergamotNative {
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint CREATE_NEW = 1;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint STILL_ACTIVE = 259;
    private const int ERROR_BAD_LENGTH = 24;
    private const int ERROR_INVALID_PARAMETER = 87;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int ERROR_MORE_DATA = 234;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int MaximumJobProcessListBytes = 4 * 1024 * 1024;
    private const int MaximumJobProcessListAttempts = 12;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        CharSet = CharSet.Unicode,
        ExactSpelling = true,
        SetLastError = true
    )]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(
        IntPtr process,
        IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder executablePath,
        ref int size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        IntPtr file,
        out BY_HANDLE_FILE_INFORMATION information
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        IntPtr file,
        StringBuilder filePath,
        uint filePathLength,
        uint flags
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(IntPtr file);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteFile(string fileName);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool QueryWorkingSet(IntPtr process, IntPtr buffer, int size);

    public static Phase7BergamotJobLaunch CreateSuspendedJobProcess(
        string executablePath,
        string arguments,
        string currentDirectory,
        string stdoutPath,
        string stderrPath
    ) {
        IntPtr job = IntPtr.Zero;
        IntPtr stdout = INVALID_HANDLE_VALUE;
        IntPtr stderr = INVALID_HANDLE_VALUE;
        IntPtr stdin = INVALID_HANDLE_VALUE;
        PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
        bool processCreated = false;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            ThrowIfInvalidHandle(job, "BERGAMOT_JOB_CREATE_FAILED");
            ConfigureJob(job);

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES {
                nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = true
            };
            stdout = CreateFile(
                stdoutPath,
                GENERIC_WRITE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                ref inheritable,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero
            );
            ThrowIfInvalidHandle(stdout, "BERGAMOT_STDOUT_CREATE_NEW_FAILED");
            AssertUniqueRegularFileHandle(stdout, stdoutPath);
            stderr = CreateFile(
                stderrPath,
                GENERIC_WRITE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                ref inheritable,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero
            );
            ThrowIfInvalidHandle(stderr, "BERGAMOT_STDERR_CREATE_NEW_FAILED");
            AssertUniqueRegularFileHandle(stderr, stderrPath);
            stdin = CreateFile(
                "NUL",
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref inheritable,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero
            );
            ThrowIfInvalidHandle(stdin, "BERGAMOT_STDIN_OPEN_FAILED");

            STARTUPINFO startup = new STARTUPINFO {
                cb = Marshal.SizeOf(typeof(STARTUPINFO)),
                dwFlags = STARTF_USESTDHANDLES,
                hStdInput = stdin,
                hStdOutput = stdout,
                hStdError = stderr
            };
            string command = QuoteWindowsArgument(executablePath);
            if (!String.IsNullOrWhiteSpace(arguments)) command += " " + arguments;
            StringBuilder commandLine = new StringBuilder(command);
            if (!CreateProcessW(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero,
                currentDirectory,
                ref startup,
                out processInformation
            )) {
                throw NativeFailure("BERGAMOT_CREATE_PROCESS_SUSPENDED_FAILED");
            }
            processCreated = true;
            if (!AssignProcessToJobObject(job, processInformation.hProcess)) {
                throw NativeFailure("BERGAMOT_ASSIGN_PROCESS_TO_JOB_FAILED");
            }
            AssertUniqueRegularFileHandle(stdout, stdoutPath);
            AssertUniqueRegularFileHandle(stderr, stderrPath);
            long creationTicks;
            if (!TryGetActiveCreationTicks(processInformation.hProcess, out creationTicks)) {
                throw NativeFailure("BERGAMOT_SUSPENDED_ROOT_IDENTITY_FAILED");
            }
            return new Phase7BergamotJobLaunch {
                JobHandle = job,
                ProcessHandle = processInformation.hProcess,
                ThreadHandle = processInformation.hThread,
                ProcessId = unchecked((int)processInformation.dwProcessId),
                CreationTicks = creationTicks,
                Resumed = false,
                Closed = false
            };
        } catch {
            if (processCreated && processInformation.hProcess != IntPtr.Zero) {
                TerminateProcess(processInformation.hProcess, 0xE0000001);
            }
            if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
            if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            throw;
        } finally {
            if (stdout != INVALID_HANDLE_VALUE) CloseHandle(stdout);
            if (stderr != INVALID_HANDLE_VALUE) CloseHandle(stderr);
            if (stdin != INVALID_HANDLE_VALUE) CloseHandle(stdin);
        }
    }

    public static void ResumeJobRoot(Phase7BergamotJobLaunch launch) {
        AssertOpenLaunch(launch);
        if (launch.Resumed || launch.ThreadHandle == IntPtr.Zero) {
            throw new InvalidOperationException("BERGAMOT_JOB_ROOT_RESUME_STATE_INVALID");
        }
        uint previousSuspendCount = ResumeThread(launch.ThreadHandle);
        if (previousSuspendCount == UInt32.MaxValue) {
            throw NativeFailure("BERGAMOT_JOB_ROOT_RESUME_FAILED");
        }
        CloseHandle(launch.ThreadHandle);
        launch.ThreadHandle = IntPtr.Zero;
        launch.Resumed = true;
    }

    public static string WaitForRoot(
        Phase7BergamotJobLaunch launch,
        int timeoutMilliseconds
    ) {
        AssertOpenLaunch(launch);
        uint wait = WaitForSingleObject(
            launch.ProcessHandle,
            unchecked((uint)Math.Max(0, timeoutMilliseconds))
        );
        if (wait == WAIT_OBJECT_0) return "EXITED";
        if (wait == WAIT_TIMEOUT) return "TIMEOUT";
        throw NativeFailure("BERGAMOT_JOB_ROOT_WAIT_FAILED");
    }

    public static int GetRootExitCode(Phase7BergamotJobLaunch launch) {
        AssertOpenLaunch(launch);
        uint exitCode;
        if (!GetExitCodeProcess(launch.ProcessHandle, out exitCode)) {
            throw NativeFailure("BERGAMOT_JOB_ROOT_EXIT_CODE_FAILED");
        }
        return unchecked((int)exitCode);
    }

    public static bool IsRootActive(Phase7BergamotJobLaunch launch) {
        AssertOpenLaunch(launch);
        return IsHandleActiveIdentity(
            launch.ProcessHandle,
            launch.CreationTicks
        );
    }

    public static Phase7BergamotProcessRecord[] QueryJobProcesses(
        Phase7BergamotJobLaunch launch
    ) {
        return QueryJobProcessesCore(launch, true);
    }

    public static Phase7BergamotProcessRecord[] QueryJobProcessesForCleanup(
        Phase7BergamotJobLaunch launch
    ) {
        return QueryJobProcessesCore(launch, false);
    }

    private static Phase7BergamotProcessRecord[] QueryJobProcessesCore(
        Phase7BergamotJobLaunch launch,
        bool enforceCompleteHistory
    ) {
        AssertOpenLaunch(launch);
        int size = 4096;
        int attempts = 0;
        uint lastAssigned = 0;
        bool hasAssigned = false;
        while (size <= MaximumJobProcessListBytes
            && attempts < MaximumJobProcessListAttempts) {
            attempts++;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                uint returned;
                if (!QueryInformationJobObject(
                    launch.JobHandle,
                    JobObjectBasicProcessIdList,
                    buffer,
                    unchecked((uint)size),
                    out returned
                )) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ERROR_MORE_DATA || error == ERROR_BAD_LENGTH
                        || error == ERROR_INSUFFICIENT_BUFFER) {
                        int grownSize;
                        if (!TryGrowJobProcessListBuffer(
                            size,
                            0,
                            out grownSize
                        )) {
                            break;
                        }
                        size = grownSize;
                        continue;
                    }
                    throw NativeFailure("BERGAMOT_JOB_PROCESS_LIST_QUERY_FAILED");
                }
                uint assigned = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                lastAssigned = assigned;
                hasAssigned = true;
                uint count = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                long capacity = (size - 8) / IntPtr.Size;
                string snapshotStatus = ClassifyJobProcessListSnapshot(
                    assigned,
                    count,
                    capacity
                );
                if (snapshotStatus == "INCOMPLETE") {
                    int grownSize;
                    if (!TryGrowJobProcessListBuffer(
                        size,
                        assigned,
                        out grownSize
                    )) {
                        break;
                    }
                    size = grownSize;
                    continue;
                }
                if (snapshotStatus != "COMPLETE") {
                    throw new InvalidOperationException(
                        "BERGAMOT_JOB_PROCESS_LIST_SNAPSHOT_INVALID"
                    );
                }
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingBefore =
                    QueryJobAccounting(launch);
                if (accountingBefore.ActiveProcesses != assigned) {
                    return RecoverKnownJobProcesses(
                        launch,
                        assigned,
                        false
                    );
                }
                try {
                    var records = new List<Phase7BergamotProcessRecord>();
                    for (uint index = 0; index < count; index++) {
                        int offset = checked(
                            8 + (int)(index * (uint)IntPtr.Size)
                        );
                        long rawPid = IntPtr.Size == 8
                            ? Marshal.ReadInt64(buffer, offset)
                            : Marshal.ReadInt32(buffer, offset);
                        int pid = unchecked((int)rawPid);
                        IntPtr process = OpenProcess(
                            PROCESS_QUERY_LIMITED_INFORMATION,
                            false,
                            pid
                        );
                        if (process == IntPtr.Zero) {
                            throw NativeFailure(
                                "BERGAMOT_JOB_MEMBER_OPEN_FAILED"
                            );
                        }
                        try {
                            long creationTicks;
                            if (!TryGetActiveCreationTicks(
                                process,
                                out creationTicks
                            )) {
                                throw new InvalidOperationException(
                                    "BERGAMOT_JOB_MEMBER_IDENTITY_UNAVAILABLE"
                                );
                            }
                            int pathCapacity = 32768;
                            var path = new StringBuilder(pathCapacity);
                            if (!QueryFullProcessImageName(
                                process,
                                0,
                                path,
                                ref pathCapacity
                            )) {
                                throw NativeFailure(
                                    "BERGAMOT_JOB_MEMBER_PATH_QUERY_FAILED"
                                );
                            }
                            bool inJob;
                            if (!IsProcessInJob(
                                process,
                                launch.JobHandle,
                                out inJob
                            ) || !inJob) {
                                throw NativeFailure(
                                    "BERGAMOT_JOB_MEMBER_BINDING_FAILED"
                                );
                            }
                            records.Add(new Phase7BergamotProcessRecord {
                                ProcessId = pid,
                                CreationTicks = creationTicks,
                                ExecutablePath = path.ToString()
                            });
                        } finally {
                            CloseHandle(process);
                        }
                    }
                    return ValidateAndRecordJobSnapshot(
                        launch,
                        records,
                        assigned,
                        accountingBefore,
                        "COMPLETE_PROCESS_ID_LIST",
                        enforceCompleteHistory
                    );
                } catch {
                    return RecoverKnownJobProcesses(
                        launch,
                        assigned,
                        false
                    );
                }
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        }
        if (!hasAssigned) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_PROCESS_LIST_INCOMPLETE_OR_UNSTABLE"
            );
        }
        if (!enforceCompleteHistory) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_CLEANUP_PROCESS_LIST_INCOMPLETE"
            );
        }
        return RecoverKnownJobProcesses(launch, lastAssigned, false);
    }

    public static string ClassifyJobProcessListSnapshot(
        uint numberOfAssignedProcesses,
        uint numberOfProcessIdsInList,
        long bufferProcessCapacity
    ) {
        if (bufferProcessCapacity < 0
            || numberOfProcessIdsInList > numberOfAssignedProcesses) {
            return "INVALID";
        }
        if ((ulong)numberOfProcessIdsInList > (ulong)bufferProcessCapacity
            || numberOfProcessIdsInList < numberOfAssignedProcesses) {
            return "INCOMPLETE";
        }
        return "COMPLETE";
    }

    private static bool TryGrowJobProcessListBuffer(
        int currentSize,
        uint numberOfAssignedProcesses,
        out int grownSize
    ) {
        grownSize = currentSize;
        long required = checked(
            8L + ((long)numberOfAssignedProcesses * IntPtr.Size)
        );
        long grown = Math.Max((long)currentSize * 2L, required);
        if (grown > MaximumJobProcessListBytes) {
            return false;
        }
        grownSize = checked((int)grown);
        return true;
    }

    private static Phase7BergamotProcessRecord[] ValidateAndRecordJobSnapshot(
        Phase7BergamotJobLaunch launch,
        List<Phase7BergamotProcessRecord> records,
        uint assigned,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingBefore,
        string discoveryStatus,
        bool enforceCompleteHistory
    ) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingAfter =
            QueryJobAccounting(launch);
        if (accountingBefore.TotalProcesses != accountingAfter.TotalProcesses
            || accountingBefore.ActiveProcesses
                != accountingAfter.ActiveProcesses
            || accountingBefore.ActiveProcesses != assigned
            || records.Count != assigned) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_MEMBERSHIP_CHANGED_DURING_DISCOVERY"
            );
        }
        var observed = new HashSet<string>();
        foreach (Phase7BergamotProcessRecord record in records) {
            string key = ProcessIdentityKey(record);
            if (!observed.Add(key)) {
                throw new InvalidOperationException(
                    "BERGAMOT_JOB_MEMBER_IDENTITY_DUPLICATED"
                );
            }
        }
        foreach (Phase7BergamotProcessRecord record in records) {
            launch.KnownProcessIdentities[ProcessIdentityKey(record)] = record;
        }
        if (enforceCompleteHistory
            && (uint)launch.KnownProcessIdentities.Count
                < accountingAfter.TotalProcesses) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_PROCESS_HISTORY_HAS_UNKNOWN_IDENTITY"
            );
        }
        if (enforceCompleteHistory
            && (uint)launch.KnownProcessIdentities.Count
                > accountingAfter.TotalProcesses) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_PROCESS_ACCOUNTING_REGRESSED"
            );
        }
        launch.LastProcessDiscoveryStatus = discoveryStatus;
        launch.LastTotalProcesses = accountingAfter.TotalProcesses;
        launch.LastActiveProcesses = accountingAfter.ActiveProcesses;
        launch.LastReportedAccountingActiveProcesses =
            accountingAfter.ActiveProcesses;
        return records.ToArray();
    }

    private static Phase7BergamotProcessRecord[] RecoverKnownJobProcesses(
        Phase7BergamotJobLaunch launch,
        uint headerAssigned,
        bool requireHeaderConsistency
    ) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingBefore =
            QueryJobAccounting(launch);
        bool headerConsistent =
            accountingBefore.ActiveProcesses == headerAssigned;
        if ((requireHeaderConsistency && !headerConsistent)
            || (uint)launch.KnownProcessIdentities.Count
                != accountingBefore.TotalProcesses) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_KNOWN_IDENTITY_RECOVERY_PRECONDITION_FAILED"
            );
        }
        List<Phase7BergamotProcessRecord> activeRecordsBefore =
            CollectBoundActiveKnownRecords(launch);
        List<Phase7BergamotProcessRecord> activeRecordsAfter =
            CollectBoundActiveKnownRecords(launch);
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingAfter =
            QueryJobAccounting(launch);
        string exitAccountingLagStatus =
            ClassifyExitAccountingLagRecovery(
                unchecked((uint)launch.KnownProcessIdentities.Count),
                accountingBefore.TotalProcesses,
                accountingBefore.ActiveProcesses,
                ProcessIdentityKeys(activeRecordsBefore),
                accountingAfter.TotalProcesses,
                accountingAfter.ActiveProcesses,
                ProcessIdentityKeys(activeRecordsAfter)
            );
        if (exitAccountingLagStatus
            == "EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES") {
            launch.LastProcessDiscoveryStatus = exitAccountingLagStatus;
            launch.LastTotalProcesses = accountingAfter.TotalProcesses;
            launch.LastActiveProcesses =
                unchecked((uint)activeRecordsAfter.Count);
            launch.LastReportedAccountingActiveProcesses =
                accountingAfter.ActiveProcesses;
            return activeRecordsAfter.ToArray();
        }
        if (accountingBefore.TotalProcesses != accountingAfter.TotalProcesses
            || accountingBefore.ActiveProcesses
                != accountingAfter.ActiveProcesses
            || !ExactIdentitySetsMatch(
                ProcessIdentityKeys(activeRecordsBefore),
                ProcessIdentityKeys(activeRecordsAfter)
            )
            || activeRecordsAfter.Count
                != accountingAfter.ActiveProcesses) {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_MEMBERSHIP_CHANGED_DURING_RECOVERY"
            );
        }
        return ValidateAndRecordJobSnapshot(
            launch,
            activeRecordsAfter,
            accountingBefore.ActiveProcesses,
            accountingBefore,
            headerConsistent
                ? "ACCOUNTING_BOUND_KNOWN_IDENTITIES"
                : "HEADER_INCONSISTENT_ACCOUNTING_BOUND",
            true
        );
    }

    public static string ClassifyExitAccountingLagRecovery(
        uint knownProcessIdentities,
        uint totalProcessesBefore,
        uint accountingActiveProcessesBefore,
        string[] activeIdentityKeysBefore,
        uint totalProcessesAfter,
        uint accountingActiveProcessesAfter,
        string[] activeIdentityKeysAfter
    ) {
        if (activeIdentityKeysBefore == null
            || activeIdentityKeysAfter == null
            || knownProcessIdentities != totalProcessesBefore
            || totalProcessesBefore != totalProcessesAfter
            || accountingActiveProcessesBefore
                != accountingActiveProcessesAfter
            || accountingActiveProcessesAfter > knownProcessIdentities
            || activeIdentityKeysAfter.Length
                >= accountingActiveProcessesAfter
            || (uint)activeIdentityKeysAfter.Length
                > knownProcessIdentities
            || !ExactIdentitySetsMatch(
                activeIdentityKeysBefore,
                activeIdentityKeysAfter
            )) {
            return "NOT_VERIFIED";
        }
        return "EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES";
    }

    private static string[] ProcessIdentityKeys(
        List<Phase7BergamotProcessRecord> records
    ) {
        var keys = new string[records.Count];
        for (int index = 0; index < records.Count; index++) {
            keys[index] = ProcessIdentityKey(records[index]);
        }
        return keys;
    }

    private static bool ExactIdentitySetsMatch(
        string[] before,
        string[] after
    ) {
        if (before == null || after == null
            || before.Length != after.Length) {
            return false;
        }
        var beforeSet = new HashSet<string>();
        foreach (string key in before) {
            if (String.IsNullOrEmpty(key) || !beforeSet.Add(key)) {
                return false;
            }
        }
        var afterSet = new HashSet<string>();
        foreach (string key in after) {
            if (String.IsNullOrEmpty(key) || !afterSet.Add(key)) {
                return false;
            }
        }
        return beforeSet.SetEquals(afterSet);
    }

    private static List<Phase7BergamotProcessRecord>
        CollectBoundActiveKnownRecords(
            Phase7BergamotJobLaunch launch
        ) {
        var activeRecords = new List<Phase7BergamotProcessRecord>();
        foreach (Phase7BergamotProcessRecord known
            in launch.KnownProcessIdentities.Values) {
            IntPtr process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                known.ProcessId
            );
            if (process == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_INVALID_PARAMETER) {
                    continue;
                }
                throw NativeFailure(
                    "BERGAMOT_JOB_KNOWN_MEMBER_OPEN_FAILED"
                );
            }
            try {
                if (!IsHandleActiveIdentity(process, known.CreationTicks)) {
                    continue;
                }
                bool inJobBefore;
                if (!IsProcessInJob(
                    process,
                    launch.JobHandle,
                    out inJobBefore
                )) {
                    throw NativeFailure(
                        "BERGAMOT_JOB_KNOWN_MEMBER_BINDING_QUERY_FAILED"
                    );
                }
                if (!inJobBefore) {
                    throw new InvalidOperationException(
                        "BERGAMOT_JOB_KNOWN_MEMBER_LEFT_JOB"
                    );
                }
                int pathCapacity = 32768;
                var path = new StringBuilder(pathCapacity);
                if (!QueryFullProcessImageName(
                    process,
                    0,
                    path,
                    ref pathCapacity
                )) {
                    throw NativeFailure(
                        "BERGAMOT_JOB_KNOWN_MEMBER_PATH_QUERY_FAILED"
                    );
                }
                bool inJobAfter;
                if (!IsHandleActiveIdentity(
                    process,
                    known.CreationTicks
                ) || !IsProcessInJob(
                    process,
                    launch.JobHandle,
                    out inJobAfter
                ) || !inJobAfter) {
                    throw new InvalidOperationException(
                        "BERGAMOT_JOB_KNOWN_MEMBER_CHANGED_DURING_RECOVERY"
                    );
                }
                activeRecords.Add(new Phase7BergamotProcessRecord {
                    ProcessId = known.ProcessId,
                    CreationTicks = known.CreationTicks,
                    ExecutablePath = path.ToString()
                });
            } finally {
                CloseHandle(process);
            }
        }
        return activeRecords;
    }

    public static Phase7BergamotProcessRecord[]
        RecoverKnownJobProcessesForSelfTest(
            Phase7BergamotJobLaunch launch,
            uint assigned
        ) {
        AssertOpenLaunch(launch);
        return RecoverKnownJobProcesses(launch, assigned, true);
    }

    public static Phase7BergamotProcessRecord[]
        RecoverKnownIgnoringHeaderForSelfTest(
            Phase7BergamotJobLaunch launch,
            uint headerAssigned
        ) {
        AssertOpenLaunch(launch);
        return RecoverKnownJobProcesses(
            launch,
            headerAssigned,
            false
        );
    }

    public static Phase7BergamotTransitionProbe
        ProbeKnownProcessExitTransition(
            Phase7BergamotJobLaunch launch
        ) {
        AssertOpenLaunch(launch);
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingBefore =
            QueryJobAccounting(launch);
        List<Phase7BergamotProcessRecord> activeRecords =
            CollectBoundActiveKnownRecords(launch);
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingAfter =
            QueryJobAccounting(launch);
        string status = ClassifyBoundProcessExitTransition(
            unchecked((uint)launch.KnownProcessIdentities.Count),
            accountingBefore.TotalProcesses,
            accountingBefore.ActiveProcesses,
            unchecked((uint)activeRecords.Count),
            accountingAfter.TotalProcesses,
            accountingAfter.ActiveProcesses
        );
        if (status != "VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG") {
            throw new InvalidOperationException(
                "BERGAMOT_JOB_BOUND_PROCESS_EXIT_TRANSITION_NOT_VERIFIED"
            );
        }
        return new Phase7BergamotTransitionProbe {
            Status = status,
            TotalProcessesBefore = accountingBefore.TotalProcesses,
            TotalProcessesAfter = accountingAfter.TotalProcesses,
            AccountingActiveProcessesBefore =
                accountingBefore.ActiveProcesses,
            AccountingActiveProcessesAfter =
                accountingAfter.ActiveProcesses,
            BoundActiveProcesses = unchecked((uint)activeRecords.Count),
            KnownProcessIdentities =
                unchecked((uint)launch.KnownProcessIdentities.Count),
            BoundActiveRecords = activeRecords.ToArray()
        };
    }

    public static string ClassifyBoundProcessExitTransition(
        uint knownProcessIdentities,
        uint totalProcessesBefore,
        uint activeProcessesBefore,
        uint boundActiveProcesses,
        uint totalProcessesAfter,
        uint activeProcessesAfter
    ) {
        if (knownProcessIdentities != totalProcessesBefore
            || totalProcessesBefore != totalProcessesAfter
            || activeProcessesBefore != activeProcessesAfter
            || boundActiveProcesses >= activeProcessesAfter
            || boundActiveProcesses > knownProcessIdentities) {
            return "NOT_VERIFIED";
        }
        return "VERIFIED_BOUND_PROCESS_EXIT_ACCOUNTING_LAG";
    }

    private static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION QueryJobAccounting(
        Phase7BergamotJobLaunch launch
    ) {
        int size = Marshal.SizeOf(
            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
        );
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if (!QueryInformationJobObject(
                launch.JobHandle,
                JobObjectBasicAccountingInformation,
                buffer,
                unchecked((uint)size),
                out returned
            )) {
                throw NativeFailure(
                    "BERGAMOT_JOB_ACCOUNTING_QUERY_FAILED"
                );
            }
            return (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                Marshal.PtrToStructure(
                    buffer,
                    typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                );
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ProcessIdentityKey(
        Phase7BergamotProcessRecord record
    ) {
        return record.ProcessId + ":" + record.CreationTicks;
    }

    public static Phase7BergamotPwsResult PrivateWorkingSetBytes(
        int processId,
        long expectedCreationTicks
    ) {
        return PrivateWorkingSetBytesCore(
            IntPtr.Zero,
            processId,
            expectedCreationTicks
        );
    }

    public static Phase7BergamotPwsResult PrivateWorkingSetBytes(
        Phase7BergamotJobLaunch launch,
        int processId,
        long expectedCreationTicks
    ) {
        AssertOpenLaunch(launch);
        return PrivateWorkingSetBytesCore(
            launch.JobHandle,
            processId,
            expectedCreationTicks
        );
    }

    private static Phase7BergamotPwsResult PrivateWorkingSetBytesCore(
        IntPtr expectedJob,
        int processId,
        long expectedCreationTicks
    ) {
        IntPtr process = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            processId
        );
        if (process == IntPtr.Zero) {
            return PwsFailure("OPEN_FAILED", Marshal.GetLastWin32Error());
        }
        try {
            if (!IsHandleActiveIdentity(process, expectedCreationTicks)) {
                return PwsFailure("PRE_IDENTITY_OR_ACTIVE_MISMATCH", 0);
            }
            if (expectedJob != IntPtr.Zero) {
                bool inJob;
                if (!IsProcessInJob(process, expectedJob, out inJob)) {
                    return PwsFailure(
                        "PRE_JOB_BINDING_QUERY_FAILED",
                        Marshal.GetLastWin32Error()
                    );
                }
                if (!inJob) {
                    return PwsFailure("PRE_JOB_BINDING_MISMATCH", 0);
                }
            }
            int size = 1024 * 1024;
            while (size <= 256 * 1024 * 1024) {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try {
                    if (!QueryWorkingSet(process, buffer, size)) {
                        int error = Marshal.GetLastWin32Error();
                        if (error == ERROR_BAD_LENGTH
                            || error == ERROR_INSUFFICIENT_BUFFER) {
                            size *= 2;
                            continue;
                        }
                        return PwsFailure("QUERY_FAILED", error);
                    }
                    ulong count = IntPtr.Size == 8
                        ? unchecked((ulong)Marshal.ReadInt64(buffer))
                        : unchecked((uint)Marshal.ReadInt32(buffer));
                    long capacity = (size - IntPtr.Size) / IntPtr.Size;
                    if (count > unchecked((ulong)capacity)) {
                        size *= 2;
                        continue;
                    }
                    long privatePages = 0;
                    for (ulong index = 0; index < count; index++) {
                        int offset = checked(
                            IntPtr.Size + (int)(index * unchecked((ulong)IntPtr.Size))
                        );
                        ulong flags = IntPtr.Size == 8
                            ? unchecked((ulong)Marshal.ReadInt64(buffer, offset))
                            : unchecked((uint)Marshal.ReadInt32(buffer, offset));
                        bool shared = ((flags >> 8) & 1UL) != 0;
                        if (!shared) privatePages++;
                    }
                    if (!IsHandleActiveIdentity(process, expectedCreationTicks)) {
                        return PwsFailure("POST_IDENTITY_OR_ACTIVE_MISMATCH", 0);
                    }
                    if (expectedJob != IntPtr.Zero) {
                        bool inJob;
                        if (!IsProcessInJob(process, expectedJob, out inJob)) {
                            return PwsFailure(
                                "POST_JOB_BINDING_QUERY_FAILED",
                                Marshal.GetLastWin32Error()
                            );
                        }
                        if (!inJob) {
                            return PwsFailure(
                                "POST_JOB_BINDING_MISMATCH",
                                0
                            );
                        }
                    }
                    return new Phase7BergamotPwsResult {
                        Status = "COMPLETE",
                        PrivateWorkingSetBytes = checked(
                            privatePages * Environment.SystemPageSize
                        ),
                        NativeErrorCode = 0
                    };
                } finally {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            return PwsFailure("BUFFER_LIMIT_EXCEEDED", 0);
        } finally {
            CloseHandle(process);
        }
    }

    public static bool TerminateBoundProcess(
        int processId,
        long expectedCreationTicks,
        uint exitCode
    ) {
        IntPtr process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            false,
            processId
        );
        if (process == IntPtr.Zero) return false;
        try {
            if (!IsHandleActiveIdentity(process, expectedCreationTicks)) return false;
            return TerminateProcess(process, exitCode);
        } finally {
            CloseHandle(process);
        }
    }

    public static int TerminateJob(
        Phase7BergamotJobLaunch launch,
        uint exitCode
    ) {
        AssertOpenLaunch(launch);
        int observed;
        try {
            observed = QueryJobProcessesForCleanup(launch).Length;
        } catch {
            observed = -1;
        }
        if (!TerminateJobObject(launch.JobHandle, exitCode)) {
            throw NativeFailure("BERGAMOT_TERMINATE_JOB_FAILED");
        }
        return observed < 0 ? 1 : observed;
    }

    public static void CloseJobLaunch(
        Phase7BergamotJobLaunch launch,
        bool requireEmpty
    ) {
        if (launch == null || launch.Closed) return;
        if (requireEmpty
            && QueryJobProcessesForCleanup(launch).Length != 0) {
            throw new InvalidOperationException("BERGAMOT_JOB_NOT_EMPTY_AT_CLOSE");
        }
        if (launch.ThreadHandle != IntPtr.Zero) {
            CloseHandle(launch.ThreadHandle);
            launch.ThreadHandle = IntPtr.Zero;
        }
        if (launch.ProcessHandle != IntPtr.Zero) {
            CloseHandle(launch.ProcessHandle);
            launch.ProcessHandle = IntPtr.Zero;
        }
        if (launch.JobHandle != IntPtr.Zero) {
            CloseHandle(launch.JobHandle);
            launch.JobHandle = IntPtr.Zero;
        }
        launch.Closed = true;
    }

    public static void WriteUniqueFile(string path, byte[] bytes) {
        IntPtr file = CreateFile(
            path,
            GENERIC_WRITE | FILE_READ_ATTRIBUTES,
            0,
            IntPtr.Zero,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero
        );
        ThrowIfInvalidHandle(file, "BERGAMOT_OUTPUT_CREATE_NEW_FAILED");
        bool complete = false;
        try {
            AssertUniqueRegularFileHandle(file, path);
            int offset = 0;
            while (offset < bytes.Length) {
                int count = Math.Min(1024 * 1024, bytes.Length - offset);
                byte[] chunk = new byte[count];
                Buffer.BlockCopy(bytes, offset, chunk, 0, count);
                uint written;
                if (!WriteFile(
                    file,
                    chunk,
                    unchecked((uint)chunk.Length),
                    out written,
                    IntPtr.Zero
                ) || written != chunk.Length) {
                    throw NativeFailure("BERGAMOT_OUTPUT_WRITE_FAILED");
                }
                offset += count;
            }
            if (!FlushFileBuffers(file)) {
                throw NativeFailure("BERGAMOT_OUTPUT_FLUSH_FAILED");
            }
            AssertUniqueRegularFileHandle(file, path);
            complete = true;
        } finally {
            CloseHandle(file);
            if (!complete) DeleteFile(path);
        }
    }

    public static void ValidateUniqueRegularFile(string path) {
        IntPtr file = CreateFile(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero
        );
        ThrowIfInvalidHandle(
            file,
            "BERGAMOT_UNIQUE_FILE_VALIDATION_OPEN_FAILED"
        );
        try {
            ValidateUniqueRegularFileHandle(file, path);
        } finally {
            CloseHandle(file);
        }
    }

    public static void ValidateUniqueRegularFileHandle(
        IntPtr file,
        string expectedPath
    ) {
        AssertUniqueRegularFileHandle(file, expectedPath);
    }

    public static bool SameFile(string leftPath, string rightPath) {
        const uint share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        IntPtr left = CreateFile(
            leftPath, FILE_READ_ATTRIBUTES, share, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero
        );
        if (left == INVALID_HANDLE_VALUE) return false;
        try {
            IntPtr right = CreateFile(
                rightPath, FILE_READ_ATTRIBUTES, share, IntPtr.Zero,
                OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero
            );
            if (right == INVALID_HANDLE_VALUE) return false;
            try {
                BY_HANDLE_FILE_INFORMATION leftInfo;
                BY_HANDLE_FILE_INFORMATION rightInfo;
                return GetFileInformationByHandle(left, out leftInfo)
                    && GetFileInformationByHandle(right, out rightInfo)
                    && leftInfo.VolumeSerialNumber == rightInfo.VolumeSerialNumber
                    && leftInfo.FileIndexHigh == rightInfo.FileIndexHigh
                    && leftInfo.FileIndexLow == rightInfo.FileIndexLow;
            } finally {
                CloseHandle(right);
            }
        } finally {
            CloseHandle(left);
        }
    }

    private static void ConfigureJob(IntPtr job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                buffer,
                unchecked((uint)size)
            )) {
                throw NativeFailure("BERGAMOT_JOB_LIMIT_CONFIGURATION_FAILED");
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Phase7BergamotPwsResult PwsFailure(
        string status,
        int error
    ) {
        return new Phase7BergamotPwsResult {
            Status = status,
            PrivateWorkingSetBytes = 0,
            NativeErrorCode = error
        };
    }

    private static bool TryGetActiveCreationTicks(
        IntPtr process,
        out long creationTicks
    ) {
        creationTicks = 0;
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        uint exitCode;
        if (!GetProcessTimes(
            process,
            out creation,
            out exit,
            out kernel,
            out user
        ) || !GetExitCodeProcess(process, out exitCode)
            || exitCode != STILL_ACTIVE) {
            return false;
        }
        long fileTime = (unchecked((long)creation.dwHighDateTime) << 32)
            | creation.dwLowDateTime;
        creationTicks = DateTime.FromFileTimeUtc(fileTime).Ticks;
        return true;
    }

    private static bool IsHandleActiveIdentity(
        IntPtr process,
        long expectedCreationTicks
    ) {
        long observedCreationTicks;
        return TryGetActiveCreationTicks(process, out observedCreationTicks)
            && observedCreationTicks == expectedCreationTicks;
    }

    private static void AssertUniqueRegularFileHandle(
        IntPtr file,
        string expectedPath
    ) {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(file, out information)) {
            throw NativeFailure("BERGAMOT_OUTPUT_IDENTITY_QUERY_FAILED");
        }
        if (information.NumberOfLinks != 1
            || (information.FileAttributes & 0x00000400) != 0) {
            throw new InvalidOperationException(
                "BERGAMOT_OUTPUT_LINK_OR_REPARSE_REJECTED"
            );
        }
        var finalPath = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(
            file,
            finalPath,
            unchecked((uint)finalPath.Capacity),
            0
        );
        if (length == 0 || length >= finalPath.Capacity) {
            throw NativeFailure("BERGAMOT_OUTPUT_FINAL_PATH_QUERY_FAILED");
        }
        string observed = NormalizeFinalPath(finalPath.ToString());
        string expected = Path.GetFullPath(expectedPath).TrimEnd('\\');
        if (!String.Equals(
            observed,
            expected,
            StringComparison.OrdinalIgnoreCase
        )) {
            throw new InvalidOperationException(
                "BERGAMOT_OUTPUT_FINAL_PATH_MISMATCH"
            );
        }
    }

    private static string NormalizeFinalPath(string path) {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) {
            return path.Substring(4).TrimEnd('\\');
        }
        return path.TrimEnd('\\');
    }

    private static string QuoteWindowsArgument(string value) {
        if (value.IndexOf('"') >= 0
            || value.IndexOf('\r') >= 0
            || value.IndexOf('\n') >= 0
            || value.IndexOf('\0') >= 0) {
            throw new InvalidOperationException(
                "BERGAMOT_PROCESS_ARGUMENT_INVALID"
            );
        }
        return "\"" + value + "\"";
    }

    private static void AssertOpenLaunch(Phase7BergamotJobLaunch launch) {
        if (launch == null || launch.Closed
            || launch.JobHandle == IntPtr.Zero
            || launch.ProcessHandle == IntPtr.Zero) {
            throw new InvalidOperationException("BERGAMOT_JOB_HANDLE_INVALID");
        }
    }

    private static void ThrowIfInvalidHandle(IntPtr handle, string code) {
        if (handle == IntPtr.Zero || handle == INVALID_HANDLE_VALUE) {
            throw NativeFailure(code);
        }
    }

    private static Exception NativeFailure(string code) {
        return new InvalidOperationException(
            code + ":" + new Win32Exception(
                Marshal.GetLastWin32Error()
            ).NativeErrorCode
        );
    }
}

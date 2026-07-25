Unicode true

!pragma warning error all
!include LogicLib.nsh

!ifndef PHASE7_PROBE_OUTFILE
  !define PHASE7_PROBE_OUTFILE "phase7-nsis-atomic-directory-probe.exe"
!endif

Name "Desktop Translate Phase 7 Identity and NtCreateFile Probe"
OutFile "${PHASE7_PROBE_OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow

Var tokenState
Var tempParentHandle
Var rootHandle
Var childHandle
Var duplicateHandle
Var rootLeaf
Var rootPath
Var childLeaf
Var movedLeaf
Var createParent
Var createLeaf
Var createHandle
Var createRawHandle
Var createStatus
Var deleteHandle
Var deleteResult
Var probeExitCode
Var mutexProbeState
Var mutexTokenHandle
Var mutexTokenInfo
Var mutexSidString
Var mutexRoundTripSid
Var mutexHandle

Function phase7ProbeReadTokenElevation
  StrCpy $tokenState "error"
  StrCpy $R1 "-1"
  System::Call 'KERNEL32::GetCurrentProcess() p.R0'
  System::Call 'ADVAPI32::OpenProcessToken(p R0, i 0x0008, *p .R1) i.R2'
  ${If} $R2 == 0
    Return
  ${EndIf}

  System::Alloc 4
  Pop $R3
  ${If} $R3 == 0
    System::Call 'KERNEL32::CloseHandle(p R1)'
    Return
  ${EndIf}

  System::Call '*$R3(i 0)'
  System::Call 'ADVAPI32::GetTokenInformation(p R1, i 20, p R3, i 4, *i .R4) i.R2'
  ${If} $R2 != 0
    System::Call '*$R3(i .R5)'
    ${If} $R5 == 0
      StrCpy $tokenState "standard"
    ${Else}
      StrCpy $tokenState "elevated"
    ${EndIf}
  ${EndIf}
  System::Free $R3
  System::Call 'KERNEL32::CloseHandle(p R1)'
FunctionEnd

Function phase7ProbeCurrentUserMutex
  StrCpy $mutexProbeState "error"
  StrCpy $mutexTokenHandle "-1"
  StrCpy $mutexTokenInfo "0"
  StrCpy $mutexSidString "0"
  StrCpy $mutexRoundTripSid "0"
  StrCpy $mutexHandle "-1"

  System::Call 'KERNEL32::GetCurrentProcess() p.R0'
  System::Call 'ADVAPI32::OpenProcessToken(p R0, i 0x0008, *p .R1) i.R2'
  ${If} $R2 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexTokenHandle "$R1"

  StrCpy $R2 0
  System::Call 'ADVAPI32::GetTokenInformation(p $mutexTokenHandle, i 1, p 0, i 0, *i .R2) i.R3'
  ${If} $R2 <= 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  System::Alloc $R2
  Pop $R3
  ${If} $R3 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexTokenInfo "$R3"

  System::Call 'ADVAPI32::GetTokenInformation(p $mutexTokenHandle, i 1, p $mutexTokenInfo, i R2, *i .R2) i.R3'
  ${If} $R3 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  System::Call '*$mutexTokenInfo(p .R4)'
  System::Call 'ADVAPI32::ConvertSidToStringSidW(p R4, *p .R5) i.R3'
  ${If} $R3 == 0
  ${OrIf} $R5 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexSidString "$R5"

  # This is the exact safe conversion used by the installer include. The
  # returned LocalAlloc string is variable-length, so it remains only a pointer
  # input. System.dll owns the full output buffer supplied by `w .R6`.
  System::Call 'KERNEL32::lstrlenW(p $mutexSidString) i.R6'
  ${If} $R6 <= 0
  ${OrIf} $R6 >= ${NSIS_MAX_STRLEN}
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::lstrcpynW(w .R6, p $mutexSidString, i ${NSIS_MAX_STRLEN}) p.R7'
  ${If} $R7 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}

  System::Call 'ADVAPI32::ConvertStringSidToSidW(w R6, *p .R5) i.R3'
  ${If} $R3 == 0
  ${OrIf} $R5 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexRoundTripSid "$R5"
  System::Call 'ADVAPI32::EqualSid(p R4, p $mutexRoundTripSid) i.R3'
  ${If} $R3 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}

  System::Call 'KERNEL32::LocalFree(p $mutexSidString) p.R0'
  ${If} $R0 != 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexSidString "0"
  System::Call 'KERNEL32::LocalFree(p $mutexRoundTripSid) p.R0'
  ${If} $R0 != 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexRoundTripSid "0"
  System::Free $mutexTokenInfo
  StrCpy $mutexTokenInfo "0"
  System::Call 'KERNEL32::CloseHandle(p $mutexTokenHandle) i.R0'
  StrCpy $mutexTokenHandle "-1"
  ${If} $R0 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}

  System::Call 'KERNEL32::GetCurrentProcessId() i.R0'
  System::Call 'KERNEL32::GetTickCount() i.R1'
  StrCpy $R2 "Global\DesktopTranslate.Phase7.MutexProbe-$R6-$R0-$R1"
  System::Call 'KERNEL32::CreateMutexW(p 0, i 0, w R2) p.R3'
  ${If} $R3 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  StrCpy $mutexHandle "$R3"
  System::Call 'KERNEL32::WaitForSingleObject(p $mutexHandle, i 0) i.R4'
  ${If} $R4 != 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::ReleaseMutex(p $mutexHandle) i.R4'
  ${If} $R4 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::CloseHandle(p $mutexHandle) i.R4'
  StrCpy $mutexHandle "-1"
  ${If} $R4 == 0
    Goto phase7_mutex_probe_cleanup
  ${EndIf}

  StrCpy $mutexProbeState "valid"

  phase7_mutex_probe_cleanup:
    ${If} $mutexHandle != -1
      System::Call 'KERNEL32::ReleaseMutex(p $mutexHandle)'
      System::Call 'KERNEL32::CloseHandle(p $mutexHandle)'
      StrCpy $mutexHandle "-1"
    ${EndIf}
    ${If} $mutexSidString != 0
      System::Call 'KERNEL32::LocalFree(p $mutexSidString)'
      StrCpy $mutexSidString "0"
    ${EndIf}
    ${If} $mutexRoundTripSid != 0
      System::Call 'KERNEL32::LocalFree(p $mutexRoundTripSid)'
      StrCpy $mutexRoundTripSid "0"
    ${EndIf}
    ${If} $mutexTokenInfo != 0
      System::Free $mutexTokenInfo
      StrCpy $mutexTokenInfo "0"
    ${EndIf}
    ${If} $mutexTokenHandle != -1
      System::Call 'KERNEL32::CloseHandle(p $mutexTokenHandle)'
      StrCpy $mutexTokenHandle "-1"
    ${EndIf}
FunctionEnd

Function phase7ProbeCreateRelativeDirectory
  StrCpy $createHandle "-1"
  StrCpy $createRawHandle "-1"
  StrCpy $createStatus "0xC0000017"

  StrLen $R3 "$createLeaf"
  ${If} $R3 == 0
    StrCpy $createStatus "0xC000000D"
    Return
  ${EndIf}
  IntOp $R5 $R3 * 2
  IntOp $R6 $R5 + 2

  # The compiled Unicode NSIS executable is 32-bit. UNICODE_STRING is thus
  # USHORT Length, USHORT MaximumLength, PWSTR Buffer: 8 bytes total.
  System::Call '*(&w${NSIS_MAX_STRLEN} "$createLeaf") p.R4'
  ${If} $R4 == 0
    Return
  ${EndIf}
  System::Call '*(h R5, h R6, p R4) p.R7'
  ${If} $R7 == 0
    System::Free $R4
    Return
  ${EndIf}

  # OBJECT_ATTRIBUTES is 24 bytes in this 32-bit process:
  # ULONG, HANDLE, PUNICODE_STRING, ULONG, PVOID, PVOID.
  System::Call '*(i 24, p $createParent, p R7, i 0x40, p 0, p 0) p.R8'
  ${If} $R8 == 0
    System::Free $R7
    System::Free $R4
    Return
  ${EndIf}

  # IO_STATUS_BLOCK is two pointer-sized fields: 8 bytes in this process.
  System::Call '*(p 0, p 0) p.R9'
  ${If} $R9 == 0
    System::Free $R8
    System::Free $R7
    System::Free $R4
    Return
  ${EndIf}

  # Keep an explicit sentinel in the PHANDLE storage. A failed FILE_CREATE
  # must not manufacture a handle that the caller could mistake for ownership.
  System::Alloc 4
  Pop $R2
  ${If} $R2 == 0
    System::Free $R9
    System::Free $R8
    System::Free $R7
    System::Free $R4
    Return
  ${EndIf}
  System::Call '*$R2(p -1)'

  # DesiredAccess:
  #   SYNCHRONIZE | DELETE | FILE_READ_ATTRIBUTES |
  #   FILE_TRAVERSE | FILE_ADD_SUBDIRECTORY
  # ShareAccess:
  #   FILE_SHARE_READ | FILE_SHARE_WRITE (intentionally no SHARE_DELETE)
  # CreateDisposition:
  #   FILE_CREATE
  # CreateOptions:
  #   FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT |
  #   FILE_OPEN_REPARSE_POINT
  System::Call 'ntdll::NtCreateFile(p R2, i 0x001100A4, p R8, p R9, p 0, i 0x10, i 3, i 2, i 0x00200021, p 0, i 0) i.R1'
  System::Call '*$R2(p .R0)'
  StrCpy $createRawHandle "$R0"
  StrCpy $createStatus "$R1"
  ${If} $R1 == 0
    StrCpy $createHandle "$R0"
  ${EndIf}

  System::Free $R2
  System::Free $R9
  System::Free $R8
  System::Free $R7
  System::Free $R4
FunctionEnd

Function phase7ProbeDeleteByHandle
  StrCpy $deleteResult "unsafe"
  ${If} $deleteHandle == -1
    Return
  ${EndIf}

  System::Alloc 4
  Pop $R3
  ${If} $R3 == 0
    System::Call 'KERNEL32::CloseHandle(p $deleteHandle)'
    StrCpy $deleteHandle "-1"
    Return
  ${EndIf}

  # FILE_DISPOSITION_INFO contains a one-byte BOOLEAN. Passing size 1 keeps
  # cleanup bound to the exact DELETE-capable handle returned by NtCreateFile.
  System::Call '*$R3(i 1)'
  System::Call 'KERNEL32::SetFileInformationByHandle(p $deleteHandle, i 4, p R3, i 1) i.R4'
  System::Free $R3
  ${If} $R4 == 0
    System::Call 'KERNEL32::CloseHandle(p $deleteHandle)'
    StrCpy $deleteHandle "-1"
    Return
  ${EndIf}

  System::Call 'KERNEL32::CloseHandle(p $deleteHandle) i.R4'
  StrCpy $deleteHandle "-1"
  ${If} $R4 != 0
    StrCpy $deleteResult "deleted"
  ${EndIf}
FunctionEnd

Function phase7ProbeBestEffortHandleCleanup
  # A duplicate success is unexpected. Close that alias before attempting to
  # mark the original identity for deletion.
  ${If} $duplicateHandle != -1
    System::Call 'KERNEL32::CloseHandle(p $duplicateHandle)'
    StrCpy $duplicateHandle "-1"
  ${EndIf}
  ${If} $childHandle != -1
    StrCpy $deleteHandle "$childHandle"
    Call phase7ProbeDeleteByHandle
    StrCpy $childHandle "-1"
  ${EndIf}
  ${If} $rootHandle != -1
    StrCpy $deleteHandle "$rootHandle"
    Call phase7ProbeDeleteByHandle
    StrCpy $rootHandle "-1"
  ${EndIf}
  ${If} $tempParentHandle != -1
    System::Call 'KERNEL32::CloseHandle(p $tempParentHandle)'
    StrCpy $tempParentHandle "-1"
  ${EndIf}
FunctionEnd

Section
  SetErrorLevel 99
  StrCpy $probeExitCode 99
  StrCpy $tempParentHandle "-1"
  StrCpy $rootHandle "-1"
  StrCpy $childHandle "-1"
  StrCpy $duplicateHandle "-1"

  Call phase7ProbeReadTokenElevation
  ${If} $tokenState != "standard"
    StrCpy $probeExitCode 10
    Goto phase7_probe_cleanup
  ${EndIf}

  Call phase7ProbeCurrentUserMutex
  ${If} $mutexProbeState != "valid"
    StrCpy $probeExitCode 15
    Goto phase7_probe_cleanup
  ${EndIf}

  # Pin the existing temp directory object itself without FILE_SHARE_DELETE.
  # FILE_FLAG_OPEN_REPARSE_POINT plus the handle attributes check below refuse
  # a temp root that is a reparse point.
  System::Call 'KERNEL32::CreateFileW(w "$TEMP", i 0x001000A4, i 3, p 0, i 3, i 0x02200000, p 0) p.R0'
  ${If} $R0 == -1
    StrCpy $probeExitCode 20
    Goto phase7_probe_cleanup
  ${EndIf}
  StrCpy $tempParentHandle "$R0"

  System::Alloc 52
  Pop $R3
  ${If} $R3 == 0
    StrCpy $probeExitCode 21
    Goto phase7_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::GetFileInformationByHandle(p $tempParentHandle, p R3) i.R4'
  ${If} $R4 == 0
    System::Free $R3
    StrCpy $probeExitCode 22
    Goto phase7_probe_cleanup
  ${EndIf}
  System::Call '*$R3(i .R4)'
  System::Free $R3
  IntOp $R4 $R4 & 0x410
  ${If} $R4 != 16
    StrCpy $probeExitCode 23
    Goto phase7_probe_cleanup
  ${EndIf}

  System::Call 'KERNEL32::GetCurrentProcessId() i.R0'
  System::Call 'KERNEL32::GetTickCount() i.R1'
  StrCpy $rootLeaf "desktop-translate-phase7-ntcreate-probe-$R0-$R1"
  StrCpy $rootPath "$TEMP\$rootLeaf"
  StrCpy $childLeaf "owned-child"
  StrCpy $movedLeaf "moved-child"

  # Create the unique test root relative to the pinned system temp handle.
  StrCpy $createParent "$tempParentHandle"
  StrCpy $createLeaf "$rootLeaf"
  Call phase7ProbeCreateRelativeDirectory
  ${If} $createStatus != 0
  ${OrIf} $createHandle == -1
  ${OrIf} $createHandle == 0
    StrCpy $probeExitCode 30
    Goto phase7_probe_cleanup
  ${EndIf}
  StrCpy $rootHandle "$createHandle"

  # Exercise the reusable primitive again with the newly created root as the
  # held parent, then retain the exact returned child handle for deletion.
  StrCpy $createParent "$rootHandle"
  StrCpy $createLeaf "$childLeaf"
  Call phase7ProbeCreateRelativeDirectory
  ${If} $createStatus != 0
  ${OrIf} $createHandle == -1
  ${OrIf} $createHandle == 0
    StrCpy $probeExitCode 40
    Goto phase7_probe_cleanup
  ${EndIf}
  StrCpy $childHandle "$createHandle"

  # Prove the returned handle really omitted FILE_SHARE_DELETE: an attempted
  # pathname rename of that exact directory must be rejected while it is held.
  System::Call 'KERNEL32::MoveFileExW(w "$rootPath\$childLeaf", w "$rootPath\$movedLeaf", i 0) i.R0 ?e'
  Pop $R1
  ${If} $R0 != 0
    StrCpy $probeExitCode 45
    Goto phase7_probe_cleanup
  ${EndIf}
  ${If} $R1 != 32
    StrCpy $probeExitCode 46
    Goto phase7_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::GetFileAttributesW(w "$rootPath\$movedLeaf") i.R0 ?e'
  Pop $R1
  ${If} $R0 != -1
    StrCpy $probeExitCode 47
    Goto phase7_probe_cleanup
  ${EndIf}
  ${If} $R1 != 2
  ${AndIf} $R1 != 3
    StrCpy $probeExitCode 48
    Goto phase7_probe_cleanup
  ${EndIf}

  # FILE_CREATE must fail closed for an already-existing relative leaf. The
  # output PHANDLE must remain the invalid sentinel (or be zeroed), never valid.
  StrCpy $createParent "$rootHandle"
  StrCpy $createLeaf "$childLeaf"
  Call phase7ProbeCreateRelativeDirectory
  StrCpy $duplicateHandle "$createHandle"
  ${If} $createStatus == 0
    StrCpy $probeExitCode 50
    Goto phase7_probe_cleanup
  ${EndIf}
  ${If} $createRawHandle != -1
  ${AndIf} $createRawHandle != 0
    StrCpy $probeExitCode 51
    Goto phase7_probe_cleanup
  ${EndIf}
  IntFmt $R0 "%08X" $createStatus
  ${If} $R0 != "C0000035"
    # For FILE_CREATE the expected fail-closed reason is
    # STATUS_OBJECT_NAME_COLLISION, not a permissive open of the old object.
    StrCpy $probeExitCode 52
    Goto phase7_probe_cleanup
  ${EndIf}

  # Delete the exact child identity through its original handle.
  StrCpy $deleteHandle "$childHandle"
  Call phase7ProbeDeleteByHandle
  StrCpy $childHandle "-1"
  ${If} $deleteResult != "deleted"
    StrCpy $probeExitCode 60
    Goto phase7_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::GetFileAttributesW(w "$rootPath\$childLeaf") i.R0 ?e'
  Pop $R1
  ${If} $R0 != -1
    StrCpy $probeExitCode 61
    Goto phase7_probe_cleanup
  ${EndIf}
  ${If} $R1 != 2
  ${AndIf} $R1 != 3
    StrCpy $probeExitCode 62
    Goto phase7_probe_cleanup
  ${EndIf}

  # The unique temp root is now empty; remove that exact identity through the
  # NtCreateFile handle as well. No pathname delete or recursive cleanup occurs.
  StrCpy $deleteHandle "$rootHandle"
  Call phase7ProbeDeleteByHandle
  StrCpy $rootHandle "-1"
  ${If} $deleteResult != "deleted"
    StrCpy $probeExitCode 70
    Goto phase7_probe_cleanup
  ${EndIf}
  System::Call 'KERNEL32::GetFileAttributesW(w "$rootPath") i.R0 ?e'
  Pop $R1
  ${If} $R0 != -1
    StrCpy $probeExitCode 71
    Goto phase7_probe_cleanup
  ${EndIf}
  ${If} $R1 != 2
  ${AndIf} $R1 != 3
    StrCpy $probeExitCode 72
    Goto phase7_probe_cleanup
  ${EndIf}

  System::Call 'KERNEL32::CloseHandle(p $tempParentHandle) i.R0'
  StrCpy $tempParentHandle "-1"
  ${If} $R0 == 0
    StrCpy $probeExitCode 80
    Goto phase7_probe_cleanup
  ${EndIf}
  StrCpy $probeExitCode 0

  phase7_probe_cleanup:
    Call phase7ProbeBestEffortHandleCleanup
    SetErrorLevel $probeExitCode
    Quit
SectionEnd

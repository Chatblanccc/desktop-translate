!include LogicLib.nsh
!include FileFunc.nsh

# electron-builder compiles this include once as a minimal intermediate
# uninstaller before it compiles the final installer. Its generated script
# declares installer-only shortcut variables in both passes, so NSIS 6001 is
# unavoidable in that intermediate pass. Keep every other warning fatal.
!ifdef BUILD_UNINSTALLER
  !pragma warning disable 6001
!endif

!define PHASE7_INSTALL_MARKER_NAME ".desktop-translate-install-root-v1"
!define PHASE7_INSTALL_MARKER_VALUE "DesktopTranslate.InstallRoot.v1|${APP_GUID}"
!define PHASE7_RECOVERY_MARKER_NAME ".desktop-translate-installing-v1"
!define PHASE7_RECOVERY_MARKER_VALUE "DesktopTranslate.Installing.v1|${APP_GUID}"
!define PHASE7_STAGE_PREFIX ".desktop-translate-stage-${APP_GUID}"
!define PHASE7_WRITE_PROBE_NAME ".desktop-translate-phase7-write-probe.tmp"
!define PHASE7_REGISTRY_PROBE_PREFIX "DesktopTranslate.Phase7.WriteProbe"
!define PHASE7_INSTALL_REGISTRY_PROBE_KEY "${INSTALL_REGISTRY_KEY}.Phase7WriteProbe"
!define PHASE7_UNINSTALL_REGISTRY_PROBE_KEY "${UNINSTALL_REGISTRY_KEY}.Phase7WriteProbe"
!define PHASE7_UNINSTALL_TRANSACTION_KEY "${INSTALL_REGISTRY_KEY}.Phase7UninstallTransaction"
!define PHASE7_UNINSTALL_TRANSACTION_VALUE "DesktopTranslate.UninstallTransaction.v1|${APP_GUID}"
!define PHASE7_REGISTRY_BACKUP_CONTAINER "Software\DesktopTranslatePhase7RegistryBackups"
!define PHASE7_REGISTRY_BACKUP_ROOT "${PHASE7_REGISTRY_BACKUP_CONTAINER}\${APP_GUID}"
!define PHASE7_INSTALL_REGISTRY_BACKUP_KEY "${PHASE7_REGISTRY_BACKUP_ROOT}\Install"
!define PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY "${PHASE7_REGISTRY_BACKUP_ROOT}\Uninstall"
!define PHASE7_UNINSTALL_MUTEX_PREFIX "Global\DesktopTranslate.Phase7.Uninstall.${APP_GUID}"
!define PHASE7_POST_CLEANUP_VERSION "DesktopTranslate.PostCleanup.v1"
!ifdef UNINSTALL_REGISTRY_KEY_2
  !error "Phase 7 does not support a secondary uninstall registry identity."
!endif

Var phase7InstallState
Var phase7RegisteredPath
Var phase7RegisteredUninstallString
Var phase7RegisteredQuietUninstallString
Var phase7RegisteredKeepShortcuts
Var phase7RegisteredShortcutName
Var phase7RegisteredMenuDirectory
Var phase7RegisteredKind
Var phase7UninstallVerified
Var phase7ReparseScanFailed
Var phase7StageCleanupPending
Var phase7FreshRootCreated
Var phase7FreshRootHandle
Var phase7FreshRootVolumeSerial
Var phase7FreshRootFileIndexHigh
Var phase7FreshRootFileIndexLow
Var phase7FreshParentPlan
Var phase7FreshParentBasePath
Var phase7FreshParentPath
Var phase7FreshParentCreated
Var phase7FreshParentHandle
Var phase7FreshParentVolumeSerial
Var phase7FreshParentFileIndexHigh
Var phase7FreshParentFileIndexLow
Var phase7ExistingParentHandle
Var phase7RecoveryMarkerOwned
Var phase7RecoveryMarkerHandle
Var phase7StableMarkerCreated
Var phase7StableMarkerHandle
Var phase7AllowlistRoot
Var phase7TransactionState
Var phase7TransactionSource
Var phase7TransactionStage
Var phase7TransactionPresent
Var phase7CleanupRootState
Var phase7TransactionOwnerPid
Var phase7TransactionOwnerCreationLow
Var phase7TransactionOwnerCreationHigh
!ifdef BUILD_UNINSTALLER
  Var phase7TransactionClaimKey
  Var phase7OwnerIdentityState
  Var phase7TransactionClaimResult
  Var phase7CommitResult
!endif
Var phase7UninstallMutexHandle
Var phase7UninstallMutexName
Var phase7TransactionCleanupVersion
Var phase7TransactionKeepShortcuts
Var phase7TransactionShortcutName
Var phase7TransactionMenuDirectory
Var phase7TransactionDeleteAppData
Var phase7ExpectedAppProcessPath
Var phase7AppProcessMode
Var phase7AppProcessState
Var phase7RegistryLayoutResult
Var phase7RegistryOperationResult
Var phase7TransactionWriteResult
Var phase7TransactionClearResult
Var phase7RollbackResult
Var phase7CommittedCleanupResult
Var phase7PostCleanupOperationResult
Var phase7PostCleanupResult

!macro customCheckAppRunning
  !define PHASE7_APP_CHECK_ID ${__LINE__}
  # The fresh-install executable does not exist until extraction. $INSTDIR was
  # already normalized and its ancestor chain verified before CHECK_APP_RUNNING,
  # so construct the expected executable path without requiring the file.
  StrCpy $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  System::Call 'KERNEL32::GetFileAttributesW(w R8) i.R9'
  ${If} $R9 != -1
    System::Call 'KERNEL32::GetLongPathNameW(w R8, w .R7, i ${NSIS_MAX_STRLEN}) i.R9'
    ${If} $R9 == 0
    ${OrIf} $R9 >= ${NSIS_MAX_STRLEN}
      !insertmacro phase7Fail "The application process path could not be resolved safely."
    ${EndIf}
    StrCpy $R8 "$R7"
  ${EndIf}
  StrCpy $phase7ExpectedAppProcessPath "$R8"

  ${If} ${isUpdated}
    Sleep 300
  ${EndIf}
  StrCpy $phase7AppProcessMode "find"
  Call ${PHASE7_APP_PROCESS_FUNCTION}
  ${If} $phase7AppProcessState == "not-running"
    Goto phase7_app_check_done_${PHASE7_APP_CHECK_ID}
  ${ElseIf} $phase7AppProcessState != "running"
    !insertmacro phase7Fail "The application process state could not be inspected safely."
  ${EndIf}

  ${If} ${isUpdated}
    Sleep 1000
  ${Else}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK phase7_app_stop_${PHASE7_APP_CHECK_ID}
    Quit
  ${EndIf}

  phase7_app_stop_${PHASE7_APP_CHECK_ID}:
    DetailPrint "$(appClosing)"
    StrCpy $R1 0

  phase7_app_stop_loop_${PHASE7_APP_CHECK_ID}:
    IntOp $R1 $R1 + 1
    StrCpy $phase7AppProcessMode "terminate"
    Call ${PHASE7_APP_PROCESS_FUNCTION}
    ${If} $phase7AppProcessState != "terminated"
      !insertmacro phase7Fail "The exact application process could not be stopped safely."
    ${EndIf}
    Sleep 300
    StrCpy $phase7AppProcessMode "find"
    Call ${PHASE7_APP_PROCESS_FUNCTION}
    ${If} $phase7AppProcessState == "not-running"
      Goto phase7_app_check_done_${PHASE7_APP_CHECK_ID}
    ${ElseIf} $phase7AppProcessState != "running"
      !insertmacro phase7Fail "The application process state could not be rechecked safely."
    ${EndIf}
    ${If} $R1 < 2
      Sleep 1000
      Goto phase7_app_stop_loop_${PHASE7_APP_CHECK_ID}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY phase7_app_stop_loop_${PHASE7_APP_CHECK_ID}
    Quit

  phase7_app_check_done_${PHASE7_APP_CHECK_ID}:
    ClearErrors
  !undef PHASE7_APP_CHECK_ID
!macroend

!macro phase7FindExactAppProcessAtRoot ROOT_PATH OUTPUT
  !define PHASE7_APP_ROOT_CHECK_ID ${__LINE__}
  StrCpy $${OUTPUT} "error"
  # Transaction roots are canonicalized before this race check, but either
  # source or stage may no longer exist after the atomic rename.
  StrCpy $R8 "${ROOT_PATH}\${APP_EXECUTABLE_FILENAME}"
  System::Call 'KERNEL32::GetFileAttributesW(w R8) i.R9'
  ${If} $R9 != -1
    System::Call 'KERNEL32::GetLongPathNameW(w R8, w .R7, i ${NSIS_MAX_STRLEN}) i.R9'
    ${If} $R9 == 0
    ${OrIf} $R9 >= ${NSIS_MAX_STRLEN}
      Goto phase7_app_root_check_done_${PHASE7_APP_ROOT_CHECK_ID}
    ${EndIf}
    StrCpy $R8 "$R7"
  ${EndIf}
  StrCpy $phase7ExpectedAppProcessPath "$R8"
  StrCpy $phase7AppProcessMode "find"
  Call ${PHASE7_APP_PROCESS_FUNCTION}
  StrCpy $${OUTPUT} "$phase7AppProcessState"
  phase7_app_root_check_done_${PHASE7_APP_ROOT_CHECK_ID}:
  ClearErrors
  !undef PHASE7_APP_ROOT_CHECK_ID
!macroend

!macro phase7FindFirst GLOB HANDLE BUFFER ATTR NAME ERROR
  StrCpy $${HANDLE} -1
  StrCpy $${BUFFER} 0
  StrCpy $${ATTR} 0
  StrCpy $${NAME} ""
  StrCpy $${ERROR} 8
  System::Alloc 592
  Pop $${BUFFER}
  ${If} $${BUFFER} != 0
    # WIN32_FIND_DATAW is 592 bytes. Capture GetLastError in the same System
    # call; a later NSIS instruction is allowed to overwrite the thread value.
    System::Call 'KERNEL32::FindFirstFileW(w "${GLOB}", p $${BUFFER}) p.${HANDLE} ?e'
    Pop $${ERROR}
    ${If} $${HANDLE} != -1
      System::Call '*$${BUFFER}(i .${ATTR}, &v40, &w260 .${NAME})'
    ${EndIf}
  ${EndIf}
!macroend

!macro phase7FindNext HANDLE BUFFER RESULT ATTR NAME ERROR
  StrCpy $${RESULT} 0
  StrCpy $${ERROR} 87
  System::Call 'KERNEL32::FindNextFileW(p $${HANDLE}, p $${BUFFER}) i.${RESULT} ?e'
  Pop $${ERROR}
  ${If} $${RESULT} != 0
    System::Call '*$${BUFFER}(i .${ATTR}, &v40, &w260 .${NAME})'
  ${EndIf}
!macroend

!macro phase7FindClose HANDLE BUFFER
  ${If} $${HANDLE} != -1
  ${AndIf} $${HANDLE} != ""
    System::Call 'KERNEL32::FindClose(p $${HANDLE})'
  ${EndIf}
  ${If} $${BUFFER} != 0
  ${AndIf} $${BUFFER} != ""
    System::Free $${BUFFER}
  ${EndIf}
  StrCpy $${HANDLE} -1
  StrCpy $${BUFFER} 0
!macroend

!macro phase7ReadPathState PATH_VALUE OUTPUT ATTR ERROR
  StrCpy $${OUTPUT} "error"
  System::Call 'KERNEL32::GetFileAttributesW(w "${PATH_VALUE}") i.${ATTR} ?e'
  Pop $${ERROR}
  ${If} $${ATTR} != -1
    StrCpy $${OUTPUT} "present"
  ${ElseIf} $${ERROR} == 2
    StrCpy $${OUTPUT} "absent"
  ${ElseIf} $${ERROR} == 3
    StrCpy $${OUTPUT} "absent"
  ${EndIf}
!macroend

!macro phase7InspectCleanupRoot ROOT_PATH
  !define PHASE7_CLEANUP_ROOT_INSPECT_ID ${__LINE__}
  StrCpy $phase7CleanupRootState "error"
  !insertmacro phase7FindFirst "${ROOT_PATH}\*" R0 R1 R2 R3 R4
  ${If} $R0 != -1
    StrCpy $phase7CleanupRootState "empty"
    phase7_cleanup_root_inspect_loop_${PHASE7_CLEANUP_ROOT_INSPECT_ID}:
      StrCmp $R3 "" phase7_cleanup_root_inspect_close_${PHASE7_CLEANUP_ROOT_INSPECT_ID}
      StrCmp $R3 "." phase7_cleanup_root_inspect_next_${PHASE7_CLEANUP_ROOT_INSPECT_ID}
      StrCmp $R3 ".." phase7_cleanup_root_inspect_next_${PHASE7_CLEANUP_ROOT_INSPECT_ID}
      ${If} $R3 == "${PHASE7_INSTALL_MARKER_NAME}"
      ${AndIf} $phase7CleanupRootState == "empty"
        StrCpy $phase7CleanupRootState "marker-only"
      ${Else}
        StrCpy $phase7CleanupRootState "nonempty"
        Goto phase7_cleanup_root_inspect_close_${PHASE7_CLEANUP_ROOT_INSPECT_ID}
      ${EndIf}
      phase7_cleanup_root_inspect_next_${PHASE7_CLEANUP_ROOT_INSPECT_ID}:
        !insertmacro phase7FindNext R0 R1 R5 R2 R3 R4
        ${If} $R5 == 0
          ${If} $R4 != 18
            StrCpy $phase7CleanupRootState "error"
          ${EndIf}
          StrCpy $R3 ""
        ${EndIf}
        Goto phase7_cleanup_root_inspect_loop_${PHASE7_CLEANUP_ROOT_INSPECT_ID}
    phase7_cleanup_root_inspect_close_${PHASE7_CLEANUP_ROOT_INSPECT_ID}:
      !insertmacro phase7FindClose R0 R1
  ${Else}
    !insertmacro phase7FindClose R0 R1
  ${EndIf}
  ClearErrors
  !undef PHASE7_CLEANUP_ROOT_INSPECT_ID
!macroend

!macro phase7Fail MESSAGE
  SetErrorLevel 1
  MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "${MESSAGE}" /SD IDOK
  Quit
!macroend

!macro phase7RejectAllUsers
  ${GetParameters} $R0
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    !insertmacro phase7Fail "Desktop Translate Phase 7 only supports CurrentUser installation."
  ${EndIf}

  ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R3 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R2 != ""
  ${OrIf} $R3 != ""
    !insertmacro phase7Fail "A machine-wide installation was detected. Uninstall it explicitly before using the CurrentUser installer."
  ${EndIf}
!macroend

!macro phase7ReadCurrentUserRegistryIdentity
  ReadRegStr $phase7RegisteredPath HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $phase7RegisteredKeepShortcuts HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts
  ReadRegStr $phase7RegisteredShortcutName HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
  ReadRegStr $phase7RegisteredMenuDirectory HKCU "${INSTALL_REGISTRY_KEY}" MenuDirectory
  ReadRegStr $phase7RegisteredUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $phase7RegisteredQuietUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
!macroend

!macro phase7AssertFreshShortcutRegistry
  ${If} $phase7RegisteredKeepShortcuts != ""
  ${OrIf} $phase7RegisteredShortcutName != ""
  ${OrIf} $phase7RegisteredMenuDirectory != ""
    !insertmacro phase7Fail "The CurrentUser shortcut registry is incomplete or unexpected. No files were changed."
  ${EndIf}
!macroend

!macro phase7AssertRegisteredShortcutRegistry
  System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredKeepShortcuts", w "true") i.R3'
  ${If} $R3 != 0
    !insertmacro phase7Fail "HKCU KeepShortcuts does not match the registered installation."
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredShortcutName", w "${SHORTCUT_NAME}") i.R3'
  ${If} $R3 != 0
    !insertmacro phase7Fail "HKCU ShortcutName does not match the registered installation."
  ${EndIf}
  !ifdef MENU_FILENAME
    System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredMenuDirectory", w "${MENU_FILENAME}") i.R3'
    ${If} $R3 != 0
      !insertmacro phase7Fail "HKCU MenuDirectory does not match the registered installation."
    ${EndIf}
  !else
    ${If} $phase7RegisteredMenuDirectory != ""
      !insertmacro phase7Fail "HKCU MenuDirectory is unexpected for this installation."
    ${EndIf}
  !endif
!macroend

!macro phase7AssertRecoveringShortcutRegistry
  ${If} $phase7RegisteredKeepShortcuts != ""
    System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredKeepShortcuts", w "true") i.R3'
    ${If} $R3 != 0
      !insertmacro phase7Fail "The interrupted HKCU KeepShortcuts value is invalid."
    ${EndIf}
  ${EndIf}
  ${If} $phase7RegisteredShortcutName != ""
    System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredShortcutName", w "${SHORTCUT_NAME}") i.R3'
    ${If} $R3 != 0
      !insertmacro phase7Fail "The interrupted HKCU ShortcutName value is invalid."
    ${EndIf}
  ${EndIf}
  !ifdef MENU_FILENAME
    ${If} $phase7RegisteredMenuDirectory != ""
      System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredMenuDirectory", w "${MENU_FILENAME}") i.R3'
      ${If} $R3 != 0
        !insertmacro phase7Fail "The interrupted HKCU MenuDirectory value is invalid."
      ${EndIf}
    ${EndIf}
  !else
    ${If} $phase7RegisteredMenuDirectory != ""
      !insertmacro phase7Fail "The interrupted HKCU MenuDirectory value is invalid."
    ${EndIf}
  !endif
!macroend

!macro phase7AssertRecoveringUninstallRegistry
  ${If} $phase7RegisteredUninstallString != ""
    StrCpy $R3 '"$phase7RegisteredPath\${UNINSTALL_FILENAME}" /currentuser'
    System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredUninstallString", w R3) i.R4'
    ${If} $R4 != 0
      !insertmacro phase7Fail "The interrupted HKCU UninstallString value is invalid."
    ${EndIf}
  ${EndIf}
  ${If} $phase7RegisteredQuietUninstallString != ""
    StrCpy $R3 '"$phase7RegisteredPath\${UNINSTALL_FILENAME}" /currentuser /S'
    System::Call 'KERNEL32::lstrcmpW(w "$phase7RegisteredQuietUninstallString", w R3) i.R4'
    ${If} $R4 != 0
      !insertmacro phase7Fail "The interrupted HKCU QuietUninstallString value is invalid."
    ${EndIf}
  ${EndIf}
!macroend

!macro phase7SetVerifiedLinkVars
  # Never re-read mutable shortcut metadata after the Phase 7 registry
  # preflight. All delete/rename destinations are derived from the exact
  # snapshot that phase7ReadCurrentUserRegistryIdentity already validated.
  StrCpy $oldShortcutName "$phase7RegisteredShortcutName"
  ${If} $oldShortcutName == ""
    StrCpy $oldShortcutName "${PRODUCT_FILENAME}"
  ${EndIf}
  StrCpy $oldDesktopLink "$DESKTOP\$oldShortcutName.lnk"
  StrCpy $newDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"

  StrCpy $oldMenuDirectory "$phase7RegisteredMenuDirectory"
  ${If} $oldMenuDirectory == ""
    StrCpy $oldStartMenuLink "$SMPROGRAMS\$oldShortcutName.lnk"
  ${Else}
    StrCpy $oldStartMenuLink "$SMPROGRAMS\$oldMenuDirectory\$oldShortcutName.lnk"
  ${EndIf}

  !ifdef MENU_FILENAME
    StrCpy $newStartMenuLink "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
  !else
    StrCpy $newStartMenuLink "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  !endif
!macroend

!macro phase7InitCurrentUser
  !insertmacro phase7RejectAllUsers
  !insertmacro phase7RecoverPendingUninstallTransaction

  StrCpy $phase7UninstallVerified "0"
  StrCpy $phase7RegisteredKind ""
  !insertmacro phase7ReadCurrentUserRegistryIdentity

  ${If} $phase7RegisteredPath == ""
    ${If} $phase7RegisteredUninstallString != ""
    ${OrIf} $phase7RegisteredQuietUninstallString != ""
      !insertmacro phase7Fail "The CurrentUser installation registry is incomplete. No files were changed."
    ${EndIf}
    StrCpy $phase7InstallState "fresh"
    !insertmacro phase7AssertFreshShortcutRegistry
  ${Else}
    ${If} $phase7RegisteredUninstallString == ""
    ${OrIf} $phase7RegisteredQuietUninstallString == ""
      # A failed Phase 7 registry commit can leave InstallLocation first. It is
      # accepted only after the recovery marker/tree is validated before any
      # app check, uninstall, or product write.
      StrCpy $phase7InstallState "recovering"
      !insertmacro phase7AssertRecoveringShortcutRegistry
      !insertmacro phase7AssertRecoveringUninstallRegistry
    ${Else}
      StrCpy $phase7InstallState "registered"
      !insertmacro phase7AssertRegisteredShortcutRegistry
    ${EndIf}
  ${EndIf}

  !insertmacro GetDParameter $R3
  !ifdef BUILD_UNINSTALLER
    ${If} $phase7InstallState != "registered"
      !insertmacro phase7Fail "The CurrentUser installation registry is missing. Uninstall was refused."
    ${EndIf}
    ${If} $R3 != ""
      !insertmacro phase7Fail "The uninstaller does not accept a /D target override."
    ${EndIf}
  !else
    ${If} $phase7InstallState != "fresh"
    ${AndIf} $R3 != ""
      !insertmacro phase7Fail "A registered or recovering installation cannot be moved with /D."
    ${EndIf}
    ${If} ${Silent}
    ${AndIf} $R3 != ""
      !insertmacro phase7Fail "Silent installation cannot select or move the installation directory with /D."
    ${EndIf}
  !endif

  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser

  # setInstallModePerUser honors /D. A registered install is always reset to
  # the exact HKCU InstallLocation so a rerun cannot silently relocate it.
  ${If} $phase7InstallState != "fresh"
    StrCpy $INSTDIR "$phase7RegisteredPath"
  ${EndIf}
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    # The audited app-builder-lib patch replaces the template's former
    # GetFileParent-based registry fallback with the already verified Phase 7
    # registry path. Keep the upstream installer helper referenced so strict
    # NSIS warning 6010 remains enabled without changing the selected path.
    Push "$INSTDIR"
    Call GetFileParent
    Pop $R9
  !endif

  ${If} ${isForAllUsers}
    !insertmacro phase7Fail "Desktop Translate Phase 7 only supports CurrentUser installation."
  ${EndIf}
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro phase7DirectoryPagePre
  Function phase7DirectoryPagePre
    ${If} $phase7InstallState != "fresh"
      Abort
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE phase7DirectoryPagePre
!macroend

!macro phase7PrepareFreshTarget
  !define PHASE7_TARGET_LEAF_ID ${__LINE__}
  ${If} $phase7InstallState == "fresh"
    StrCpy $phase7FreshParentPlan "none"
    StrCpy $phase7FreshParentBasePath ""
    StrCpy $phase7FreshParentPath ""
    StrCpy $phase7FreshParentCreated "0"
    # electron-builder's CurrentUser default is
    # "$LOCALAPPDATA\Programs\${APP_FILENAME}". A clean profile is allowed to
    # lack only that conventional direct parent. Record a narrowly scoped plan
    # now, but do not create Programs until the install transaction starts.
    GetFullPathName $R5 "$LOCALAPPDATA"
    ${If} $R5 == ""
      !insertmacro phase7Fail "The CurrentUser LocalAppData directory is invalid."
    ${EndIf}
    StrCpy $R6 "$R5\Programs"
    StrCpy $R7 "$R6\${APP_FILENAME}"
    StrCmp "$INSTDIR" "$R7" 0 phase7_target_not_missing_default_parent_${PHASE7_TARGET_LEAF_ID}
    System::Call 'KERNEL32::GetFileAttributesW(w R6) i.R8 ?e'
    Pop $R9
    ${If} $R8 == -1
      ${If} $R9 != 2
      ${AndIf} $R9 != 3
        !insertmacro phase7Fail "The default installation parent could not be inspected safely."
      ${EndIf}
      StrCpy $phase7FreshParentPlan "create-default-programs"
      StrCpy $phase7FreshParentBasePath "$R5"
      StrCpy $phase7FreshParentPath "$R6"
      StrCpy $INSTDIR "$R7"
      Goto phase7_target_prepared_${PHASE7_TARGET_LEAF_ID}
    ${EndIf}

    phase7_target_not_missing_default_parent_${PHASE7_TARGET_LEAF_ID}:
    ${GetFileName} "$INSTDIR" $R1
    # StrCmp is intentionally case-insensitive on Windows, but it compares the
    # complete final segment. Substrings such as desktop-translate-backup never
    # count as the application directory.
    StrCmp "$R1" "${APP_FILENAME}" phase7_target_has_exact_leaf_${PHASE7_TARGET_LEAF_ID}

    # The directory page returns an existing directory when the user browses
    # for a parent. Normalize that existing directory before appending the
    # product leaf. GetFullPathName intentionally returns an empty result when
    # the path does not exist, so it must never be called on the not-yet-created
    # application directory.
    GetFullPathName $R0 "$INSTDIR"
    ${If} $R0 == ""
      !insertmacro phase7Fail "The selected installation directory is invalid."
    ${EndIf}
    StrCpy $INSTDIR "$R0\${APP_FILENAME}"
    Goto phase7_target_prepared_${PHASE7_TARGET_LEAF_ID}

    phase7_target_has_exact_leaf_${PHASE7_TARGET_LEAF_ID}:
      # electron-builder's default already ends in APP_FILENAME, but that leaf
      # does not exist on a fresh install. Canonicalize its existing parent and
      # then reconstruct the exact product leaf.
      ${GetParent} "$INSTDIR" $R2
      GetFullPathName $R0 "$R2"
      ${If} $R0 == ""
        !insertmacro phase7Fail "The selected installation parent directory is invalid."
      ${EndIf}
      StrCpy $INSTDIR "$R0\${APP_FILENAME}"

    phase7_target_prepared_${PHASE7_TARGET_LEAF_ID}:
  ${EndIf}
  !undef PHASE7_TARGET_LEAF_ID
!macroend

!macro phase7AssertDirectoryIsNotReparse PATH_VALUE
  System::Call 'KERNEL32::GetFileAttributesW(w "${PATH_VALUE}") i.R0'
  ${If} $R0 == -1
    !insertmacro phase7Fail "The installation directory disappeared during validation."
  ${EndIf}
  IntOp $R1 $R0 & 0x10
  ${If} $R1 == 0
    !insertmacro phase7Fail "The installation target is not a directory."
  ${EndIf}
  IntOp $R1 $R0 & 0x400
  ${If} $R1 != 0
    !insertmacro phase7Fail "Reparse points are not accepted as an installation root."
  ${EndIf}
!macroend

!macro phase7AssertRequiredDirectory RELATIVE_PATH
  System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR\${RELATIVE_PATH}") i.R0'
  ${If} $R0 == -1
    !insertmacro phase7Fail "A required application directory is missing: ${RELATIVE_PATH}"
  ${EndIf}
  IntOp $R1 $R0 & 0x410
  ${If} $R1 != 16
    !insertmacro phase7Fail "A required application directory has an unsafe type: ${RELATIVE_PATH}"
  ${EndIf}
!macroend

!macro phase7AssertRequiredNonEmptyFile RELATIVE_PATH
  System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR\${RELATIVE_PATH}") i.R0'
  ${If} $R0 == -1
    !insertmacro phase7Fail "A required application file is missing: ${RELATIVE_PATH}"
  ${EndIf}
  IntOp $R1 $R0 & 0x410
  ${If} $R1 != 0
    !insertmacro phase7Fail "A required application file has an unsafe type: ${RELATIVE_PATH}"
  ${EndIf}
  ClearErrors
  FileOpen $R0 "$INSTDIR\${RELATIVE_PATH}" r
  ${If} ${Errors}
    !insertmacro phase7Fail "A required application file could not be read: ${RELATIVE_PATH}"
  ${EndIf}
  FileSeek $R0 0 END $R2
  ${If} ${Errors}
    FileClose $R0
    !insertmacro phase7Fail "A required application file size could not be read: ${RELATIVE_PATH}"
  ${EndIf}
  FileClose $R0
  ${If} ${Errors}
    !insertmacro phase7Fail "A required application file could not be closed: ${RELATIVE_PATH}"
  ${EndIf}
  ${If} $R2 <= 0
    !insertmacro phase7Fail "A required application file is empty or unreadable: ${RELATIVE_PATH}"
  ${EndIf}
  ClearErrors
!macroend

!macro phase7AssertExistingParentBeforeCreate PATH_VALUE
  ${GetParent} "${PATH_VALUE}" $R0
  ${If} $R0 == ""
    !insertmacro phase7Fail "The selected installation parent directory is invalid."
  ${EndIf}
  System::Call 'KERNEL32::GetFileAttributesW(w R0) i.R1'
  ${If} $R1 == -1
    !insertmacro phase7Fail "The selected installation parent directory must already exist."
  ${EndIf}
  IntOp $R2 $R1 & 0x10
  ${If} $R2 == 0
    !insertmacro phase7Fail "The selected installation parent is not a directory."
  ${EndIf}
  IntOp $R2 $R1 & 0x400
  ${If} $R2 != 0
    !insertmacro phase7Fail "Reparse points are not accepted in the installation path."
  ${EndIf}
  Push "$R0"
  Call ${PHASE7_ANCESTOR_FUNCTION}
!macroend

!macro phase7AssertDefaultProgramsParentPlan
  !define PHASE7_DEFAULT_PARENT_ID ${__LINE__}
  GetFullPathName $R0 "$LOCALAPPDATA"
  ${If} $R0 == ""
    !insertmacro phase7Fail "The CurrentUser LocalAppData directory is invalid."
  ${EndIf}
  StrCmp "$phase7FreshParentBasePath" "$R0" phase7_default_parent_base_equal_${PHASE7_DEFAULT_PARENT_ID}
  !insertmacro phase7Fail "The planned default installation base changed unexpectedly."
  phase7_default_parent_base_equal_${PHASE7_DEFAULT_PARENT_ID}:
  StrCpy $R1 "$R0\Programs"
  StrCmp "$phase7FreshParentPath" "$R1" phase7_default_parent_equal_${PHASE7_DEFAULT_PARENT_ID}
  !insertmacro phase7Fail "The planned default installation parent changed unexpectedly."
  phase7_default_parent_equal_${PHASE7_DEFAULT_PARENT_ID}:
  StrCpy $R2 "$R1\${APP_FILENAME}"
  StrCmp "$INSTDIR" "$R2" phase7_default_root_equal_${PHASE7_DEFAULT_PARENT_ID}
  !insertmacro phase7Fail "The planned default installation root changed unexpectedly."
  phase7_default_root_equal_${PHASE7_DEFAULT_PARENT_ID}:

  System::Call 'KERNEL32::GetFileAttributesW(w R0) i.R3'
  ${If} $R3 == -1
    !insertmacro phase7Fail "The CurrentUser LocalAppData directory disappeared during validation."
  ${EndIf}
  IntOp $R4 $R3 & 0x410
  ${If} $R4 != 16
    !insertmacro phase7Fail "The CurrentUser LocalAppData directory has an unsafe type."
  ${EndIf}
  Push "$R0"
  Call ${PHASE7_ANCESTOR_FUNCTION}

  System::Call 'KERNEL32::GetFileAttributesW(w R1) i.R3 ?e'
  Pop $R4
  ${If} $R3 != -1
    !insertmacro phase7Fail "The planned default installation parent appeared during validation. Run the installer again."
  ${EndIf}
  ${If} $R4 != 2
  ${AndIf} $R4 != 3
    !insertmacro phase7Fail "The planned default installation parent could not be inspected safely."
  ${EndIf}
  !undef PHASE7_DEFAULT_PARENT_ID
!macroend

!macro phase7DisposeOwnedWriteProbe
  # Delete only the probe represented by the still-exclusive handle. Never
  # fall back to a pathname Delete: another same-user process may recreate the
  # unique name as soon as this handle closes.
  System::Alloc 4
  Pop $R3
  ${If} $R3 == 0
    System::Call 'KERNEL32::CloseHandle(p R0)'
    !insertmacro phase7Fail "The installation-directory write probe cleanup buffer could not be allocated."
  ${EndIf}
  System::Call '*$R3(i 1)'
  System::Call 'KERNEL32::SetFileInformationByHandle(p R0, i 4, p R3, i 1) i.R5 ?e'
  Pop $R9
  System::Free $R3
  ${If} $R5 == 0
    System::Call 'KERNEL32::CloseHandle(p R0)'
    !insertmacro phase7Fail "The owned installation-directory write probe could not be marked for handle-based cleanup."
  ${EndIf}
  System::Call 'KERNEL32::CloseHandle(p R0) i.R5'
  ${If} $R5 == 0
    !insertmacro phase7Fail "The owned installation-directory write probe handle could not be closed safely."
  ${EndIf}

  System::Call 'KERNEL32::GetFileAttributesW(w R2) i.R5 ?e'
  Pop $R9
  ${If} $R5 != -1
    !insertmacro phase7Fail "The installation-directory write probe path was recreated during cleanup."
  ${EndIf}
  ${If} $R9 != 2
  ${AndIf} $R9 != 3
    !insertmacro phase7Fail "The installation-directory write probe cleanup could not be verified safely."
  ${EndIf}
  ClearErrors
!macroend

!macro phase7ProbeWritableDirectory DIRECTORY_VALUE
  # Capture the caller's directory before using the R registers. Some call
  # sites intentionally pass $R0, so writing the process id to $R0 first would
  # otherwise turn the probe into a relative "<pid>\..." path.
  Push $R4
  Push "${DIRECTORY_VALUE}"
  Pop $R4
  System::Call 'KERNEL32::GetCurrentProcessId() i.R0'
  System::Call 'KERNEL32::GetTickCount() i.R1'
  StrCpy $R2 "$R4\${PHASE7_WRITE_PROBE_NAME}-$R0-$R1"

  # CREATE_NEW plus shareMode=0 establishes ownership atomically. DELETE
  # access allows cleanup to remain bound to this handle.
  ClearErrors
  System::Call 'KERNEL32::CreateFileW(w R2, i 0x40010000, i 0, p 0, i 1, i 0x80, p 0) p.R0 ?e'
  Pop $R9
  ${If} $R0 == -1
    !insertmacro phase7Fail "The selected installation directory is not writable."
  ${EndIf}

  StrLen $R3 "phase7-write-probe"
  System::Call 'KERNEL32::WriteFile(p R0, m "phase7-write-probe", i R3, *i .R1, p 0) i.R5 ?e'
  Pop $R9
  ${If} $R5 == 0
    !insertmacro phase7DisposeOwnedWriteProbe
    !insertmacro phase7Fail "The selected installation directory is not writable."
  ${EndIf}
  ${If} $R1 != $R3
    !insertmacro phase7DisposeOwnedWriteProbe
    !insertmacro phase7Fail "The installation-directory write probe was only partially written."
  ${EndIf}
  System::Call 'KERNEL32::FlushFileBuffers(p R0) i.R5 ?e'
  Pop $R9
  ${If} $R5 == 0
    !insertmacro phase7DisposeOwnedWriteProbe
    !insertmacro phase7Fail "The installation-directory write probe could not be flushed."
  ${EndIf}

  !insertmacro phase7DisposeOwnedWriteProbe
  Pop $R4
!macroend

!macro phase7ProbeRegistryKeyWritable REGISTRY_KEY
  # REGISTRY_KEY is always a dedicated sibling scratch key. Never create,
  # delete, or empty either canonical product-identity key merely to prove
  # registry writability.
  ClearErrors
  ReadRegStr $R3 HKCU "${REGISTRY_KEY}" "$R2"
  ${IfNot} ${Errors}
    !insertmacro phase7Fail "The CurrentUser registry write-probe value already exists."
  ${EndIf}

  ClearErrors
  WriteRegStr HKCU "${REGISTRY_KEY}" "$R2" "phase7-registry-write-probe"
  ${If} ${Errors}
    DeleteRegValue HKCU "${REGISTRY_KEY}" "$R2"
    DeleteRegKey /ifempty HKCU "${REGISTRY_KEY}"
    !insertmacro phase7Fail "The CurrentUser installation registry is not writable."
  ${EndIf}
  ReadRegStr $R3 HKCU "${REGISTRY_KEY}" "$R2"
  System::Call 'KERNEL32::lstrcmpW(w R3, w "phase7-registry-write-probe") i.R4'
  ${If} $R4 != 0
    DeleteRegValue HKCU "${REGISTRY_KEY}" "$R2"
    DeleteRegKey /ifempty HKCU "${REGISTRY_KEY}"
    !insertmacro phase7Fail "The CurrentUser registry write probe could not be read back."
  ${EndIf}

  ClearErrors
  DeleteRegValue HKCU "${REGISTRY_KEY}" "$R2"
  ${If} ${Errors}
    !insertmacro phase7Fail "The CurrentUser registry write probe could not be removed."
  ${EndIf}
  DeleteRegKey /ifempty HKCU "${REGISTRY_KEY}"
  ClearErrors
!macroend

!macro phase7ProbeRegistryWritable
  System::Call 'KERNEL32::GetCurrentProcessId() i.R0'
  System::Call 'KERNEL32::GetTickCount() i.R1'
  StrCpy $R2 "${PHASE7_REGISTRY_PROBE_PREFIX}-$R0-$R1"
  !insertmacro phase7ProbeRegistryKeyWritable "${PHASE7_INSTALL_REGISTRY_PROBE_KEY}"
  !insertmacro phase7ProbeRegistryKeyWritable "${PHASE7_UNINSTALL_REGISTRY_PROBE_KEY}"
!macroend

!ifdef BUILD_UNINSTALLER
  !define PHASE7_SCAN_FUNCTION "un.phase7ScanNoReparse"
  !define PHASE7_ANCESTOR_FUNCTION "un.phase7AssertNoReparseAncestors"
  !define PHASE7_CLASSIFY_FUNCTION "un.phase7ClassifyRootEntry"
  !define PHASE7_ALLOWLIST_FUNCTION "un.phase7AssertKnownRootEntries"
  !define PHASE7_REGISTERED_PATH_FUNCTION "un.phase7NormalizeAndMatchRegisteredPath"
  !define PHASE7_COMMITTED_DELETE_FUNCTION "un.phase7DeleteCommittedTree"
  !define PHASE7_APP_PROCESS_FUNCTION "un.phase7ExactAppProcess"
!else
  !define PHASE7_SCAN_FUNCTION "phase7ScanNoReparse"
  !define PHASE7_ANCESTOR_FUNCTION "phase7AssertNoReparseAncestors"
  !define PHASE7_CLASSIFY_FUNCTION "phase7ClassifyRootEntry"
  !define PHASE7_ALLOWLIST_FUNCTION "phase7AssertKnownRootEntries"
  !define PHASE7_REGISTERED_PATH_FUNCTION "phase7NormalizeAndMatchRegisteredPath"
  !define PHASE7_RECOVERY_PATH_FUNCTION "phase7NormalizeAndMatchRecoveryPath"
  !define PHASE7_COMMITTED_DELETE_FUNCTION "phase7DeleteCommittedTree"
  !define PHASE7_APP_PROCESS_FUNCTION "phase7ExactAppProcess"
!endif

Function ${PHASE7_APP_PROCESS_FUNCTION}
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $phase7AppProcessState "error"
  ${If} $phase7ExpectedAppProcessPath == ""
    Goto phase7_app_process_done
  ${EndIf}
  ${If} $phase7AppProcessMode != "find"
  ${AndIf} $phase7AppProcessMode != "terminate"
    Goto phase7_app_process_done
  ${EndIf}

  # Native Toolhelp enumeration avoids shell/code interpolation and makes an
  # apostrophe in a selected path ordinary data. PROCESSENTRY32W is 556 bytes
  # in the 32-bit NSIS process; a slightly larger allocation is harmless.
  System::Call 'KERNEL32::CreateToolhelp32Snapshot(i 0x2, i 0) p.R0 ?e'
  Pop $R9
  ${If} $R0 == -1
  ${OrIf} $R0 == 0
    Goto phase7_app_process_done
  ${EndIf}
  System::Alloc 568
  Pop $R1
  ${If} $R1 == 0
    System::Call 'KERNEL32::CloseHandle(p R0)'
    Goto phase7_app_process_done
  ${EndIf}
  System::Call '*$R1(i 556)'
  System::Call 'KERNEL32::Process32FirstW(p R0, p R1) i.R4 ?e'
  Pop $R9
  ${If} $R4 == 0
    ${If} $R9 == 18
      ${If} $phase7AppProcessMode == "find"
        StrCpy $phase7AppProcessState "not-running"
      ${Else}
        StrCpy $phase7AppProcessState "terminated"
      ${EndIf}
    ${EndIf}
    Goto phase7_app_process_close
  ${EndIf}

  phase7_app_process_loop:
    # th32ProcessID is the third DWORD; szExeFile starts at byte offset 36.
    System::Call '*$R1(i .R4, i .R5, i .R2)'
    IntOp $R3 $R1 + 36
    System::Call '*$R3(&w260 .R4)'
    # common.nsh defines APP_EXECUTABLE_FILENAME only after this include.
    System::Call 'KERNEL32::lstrcmpiW(w R4, w "${PRODUCT_FILENAME}.exe") i.R5'
    ${If} $R5 != 0
      Goto phase7_app_process_next
    ${EndIf}

    # Every opened process handle is also waited on when a query/termination
    # race occurs, so request SYNCHRONIZE with QUERY_LIMITED_INFORMATION.
    StrCpy $R5 0x101000
    ${If} $phase7AppProcessMode == "terminate"
      IntOp $R5 $R5 | 0x1
    ${EndIf}
    System::Call 'KERNEL32::OpenProcess(i R5, i 0, i R2) p.R3 ?e'
    Pop $R9
    ${If} $R3 == 0
      ${If} $R9 == 87
        Goto phase7_app_process_next
      ${EndIf}
      Goto phase7_app_process_close
    ${EndIf}
    System::Alloc 4
    Pop $R6
    ${If} $R6 == 0
      System::Call 'KERNEL32::CloseHandle(p R3)'
      Goto phase7_app_process_close
    ${EndIf}
    System::Call '*$R6(i ${NSIS_MAX_STRLEN})'
    System::Call 'KERNEL32::QueryFullProcessImageNameW(p R3, i 0, w .R7, p R6) i.R4 ?e'
    Pop $R9
    System::Free $R6
    ${If} $R4 == 0
      System::Call 'KERNEL32::WaitForSingleObject(p R3, i 0) i.R5'
      System::Call 'KERNEL32::CloseHandle(p R3)'
      ${If} $R5 == 0
        Goto phase7_app_process_next
      ${EndIf}
      Goto phase7_app_process_close
    ${EndIf}
    System::Call 'KERNEL32::GetLongPathNameW(w R7, w .R8, i ${NSIS_MAX_STRLEN}) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
    ${OrIf} $R4 >= ${NSIS_MAX_STRLEN}
      System::Call 'KERNEL32::WaitForSingleObject(p R3, i 0) i.R5'
      System::Call 'KERNEL32::CloseHandle(p R3)'
      ${If} $R5 == 0
        Goto phase7_app_process_next
      ${EndIf}
      Goto phase7_app_process_close
    ${EndIf}
    System::Call 'KERNEL32::lstrcmpiW(w R8, w "$phase7ExpectedAppProcessPath") i.R4'
    ${If} $R4 != 0
      System::Call 'KERNEL32::CloseHandle(p R3)'
      Goto phase7_app_process_next
    ${EndIf}

    ${If} $phase7AppProcessMode == "find"
      StrCpy $phase7AppProcessState "running"
      System::Call 'KERNEL32::CloseHandle(p R3)'
      Goto phase7_app_process_close
    ${EndIf}
    System::Call 'KERNEL32::TerminateProcess(p R3, i 0) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
      # ERROR_ACCESS_DENIED can mean this exact handle is already terminated.
      # Accept failure only when the process object itself is signaled.
      System::Call 'KERNEL32::WaitForSingleObject(p R3, i 0) i.R5'
    ${Else}
      # TerminateProcess is asynchronous for another process. Do not mutate the
      # install tree until the exact process object has actually terminated.
      System::Call 'KERNEL32::WaitForSingleObject(p R3, i 30000) i.R5'
    ${EndIf}
    System::Call 'KERNEL32::CloseHandle(p R3)'
    ${If} $R5 != 0
      Goto phase7_app_process_close
    ${EndIf}

  phase7_app_process_next:
    System::Call '*$R1(i 556)'
    System::Call 'KERNEL32::Process32NextW(p R0, p R1) i.R4 ?e'
    Pop $R9
    ${If} $R4 != 0
      Goto phase7_app_process_loop
    ${EndIf}
    ${If} $R9 == 18
      ${If} $phase7AppProcessMode == "find"
        StrCpy $phase7AppProcessState "not-running"
      ${Else}
        StrCpy $phase7AppProcessState "terminated"
      ${EndIf}
    ${EndIf}

  phase7_app_process_close:
    System::Free $R1
    System::Call 'KERNEL32::CloseHandle(p R0)'
  phase7_app_process_done:
    ClearErrors
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

Function ${PHASE7_SCAN_FUNCTION}
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  System::Call 'KERNEL32::GetFileAttributesW(w R0) i.R1'
  ${If} $R1 == -1
    StrCpy $phase7ReparseScanFailed "1"
    Goto phase7_scan_done
  ${EndIf}
  IntOp $R2 $R1 & 0x400
  ${If} $R2 != 0
    StrCpy $phase7ReparseScanFailed "1"
    Goto phase7_scan_done
  ${EndIf}
  IntOp $R2 $R1 & 0x10
  ${If} $R2 == 0
    Goto phase7_scan_done
  ${EndIf}

  !insertmacro phase7FindFirst "$R0\*" R1 R6 R4 R2 R5
  ${If} $R1 == -1
    StrCpy $phase7ReparseScanFailed "1"
    Goto phase7_scan_close
  ${EndIf}

  phase7_scan_loop:
    StrCmp $R2 "" phase7_scan_close
    StrCmp $R2 "." phase7_scan_next
    StrCmp $R2 ".." phase7_scan_next
    StrCpy $R3 "$R0\$R2"
    System::Call 'KERNEL32::GetFileAttributesW(w R3) i.R4'
    ${If} $R4 == -1
      StrCpy $phase7ReparseScanFailed "1"
      Goto phase7_scan_close
    ${EndIf}
    StrCpy $R5 $R4
    IntOp $R4 $R4 & 0x400
    ${If} $R4 != 0
      StrCpy $phase7ReparseScanFailed "1"
      Goto phase7_scan_close
    ${EndIf}
    IntOp $R4 $R5 & 0x10
    ${If} $R4 != 0
      Push "$R3"
      Call ${PHASE7_SCAN_FUNCTION}
      ${If} $phase7ReparseScanFailed != "0"
        Goto phase7_scan_close
      ${EndIf}
    ${EndIf}

    phase7_scan_next:
      !insertmacro phase7FindNext R1 R6 R7 R4 R2 R5
      ${If} $R7 == 0
        ${If} $R5 != 18
          StrCpy $phase7ReparseScanFailed "1"
        ${EndIf}
        StrCpy $R2 ""
      ${EndIf}
      Goto phase7_scan_loop

  phase7_scan_close:
    !insertmacro phase7FindClose R1 R6
    ClearErrors

  phase7_scan_done:
    ClearErrors
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

Function ${PHASE7_ANCESTOR_FUNCTION}
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  GetFullPathName $R0 "$R0"
  ${GetRoot} "$R0" $R3
  ${If} $R0 == ""
  ${OrIf} $R3 == ""
    !insertmacro phase7Fail "The installation path could not be normalized to a local root."
  ${EndIf}
  # Phase 7's atomic same-parent rename, synchronous cleanup, ACL, and reparse
  # guarantees are intentionally limited to a fixed local NTFS volume. Network,
  # removable, optical, RAM, ReFS, and other filesystems are rejected before a
  # product mutation rather than being represented by untested guarantees.
  System::Call 'KERNEL32::GetVolumePathNameW(w R0, w .R1, i ${NSIS_MAX_STRLEN}) i.R2'
  ${If} $R2 == 0
  ${OrIf} $R1 == ""
    !insertmacro phase7Fail "The installation volume could not be resolved."
  ${EndIf}
  System::Call 'KERNEL32::GetDriveTypeW(w R1) i.R2'
  ${If} $R2 != 3
    !insertmacro phase7Fail "Desktop Translate Phase 7 only supports fixed local volumes."
  ${EndIf}
  System::Call 'KERNEL32::GetVolumeInformationW(w R1, p 0, i 0, p 0, p 0, p 0, w .R3, i ${NSIS_MAX_STRLEN}) i.R2'
  ${If} $R2 == 0
    !insertmacro phase7Fail "The installation filesystem could not be identified."
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpiW(w R3, w "NTFS") i.R2'
  ${If} $R2 != 0
    !insertmacro phase7Fail "Desktop Translate Phase 7 only supports NTFS installation volumes."
  ${EndIf}
  ${GetRoot} "$R0" $R3

  phase7_ancestor_loop:
    System::Call 'KERNEL32::GetFileAttributesW(w R0) i.R1'
    ${If} $R1 == -1
      !insertmacro phase7Fail "An installation path ancestor disappeared during validation."
    ${EndIf}
    IntOp $R2 $R1 & 0x10
    ${If} $R2 == 0
      !insertmacro phase7Fail "An installation path ancestor is not a directory."
    ${EndIf}
    IntOp $R2 $R1 & 0x400
    ${If} $R2 != 0
      !insertmacro phase7Fail "Reparse points are not accepted in the installation path."
    ${EndIf}

    ${GetParent} "$R0" $R1
    StrCmp "$R1" "$R3" phase7_ancestor_done
    ${If} $R1 == ""
    ${OrIf} $R1 == $R0
      !insertmacro phase7Fail "The installation path ancestor chain is invalid."
    ${EndIf}
    StrCpy $R0 "$R1"
    Goto phase7_ancestor_loop

  phase7_ancestor_done:
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

Function ${PHASE7_CLASSIFY_FUNCTION}
  Exch $R0
  Push $R1
  StrCpy $R1 ""

  StrCmp "$R0" "locales" phase7_classify_directory
  StrCmp "$R0" "resources" phase7_classify_directory
  StrCmp "$R0" "resources\selection-host" phase7_classify_directory
  StrCmp "$R0" "resources\migrations" phase7_classify_directory
  StrCmp "$R0" "resources\licenses" phase7_classify_directory
  StrCmp "$R0" "resources\supply-chain" phase7_classify_directory
  StrCmp "$R0" "resources\manifest" phase7_classify_directory
  # These functions are emitted while the intermediate uninstaller is being
  # compiled, before common.nsh defines its convenience filename constants.
  StrCmp "$R0" "${PRODUCT_FILENAME}.exe" phase7_classify_file
  StrCmp "$R0" "Uninstall ${PRODUCT_FILENAME}.exe" phase7_classify_file
  StrCmp "$R0" "${PHASE7_INSTALL_MARKER_NAME}" phase7_classify_file
  StrCmp "$R0" "${PHASE7_RECOVERY_MARKER_NAME}" phase7_classify_file
  StrCmp "$R0" "chrome_100_percent.pak" phase7_classify_file
  StrCmp "$R0" "chrome_200_percent.pak" phase7_classify_file
  StrCmp "$R0" "d3dcompiler_47.dll" phase7_classify_file
  StrCmp "$R0" "dxcompiler.dll" phase7_classify_file
  StrCmp "$R0" "dxil.dll" phase7_classify_file
  StrCmp "$R0" "ffmpeg.dll" phase7_classify_file
  StrCmp "$R0" "icudtl.dat" phase7_classify_file
  StrCmp "$R0" "libEGL.dll" phase7_classify_file
  StrCmp "$R0" "libGLESv2.dll" phase7_classify_file
  StrCmp "$R0" "LICENSE" phase7_classify_file
  StrCmp "$R0" "LICENSE.electron.txt" phase7_classify_file
  StrCmp "$R0" "LICENSES.chromium.html" phase7_classify_file
  StrCmp "$R0" "resources.pak" phase7_classify_file
  StrCmp "$R0" "snapshot_blob.bin" phase7_classify_file
  StrCmp "$R0" "v8_context_snapshot.bin" phase7_classify_file
  StrCmp "$R0" "version" phase7_classify_file
  StrCmp "$R0" "vk_swiftshader.dll" phase7_classify_file
  StrCmp "$R0" "vk_swiftshader_icd.json" phase7_classify_file
  StrCmp "$R0" "vulkan-1.dll" phase7_classify_file
  StrCmp "$R0" "uninstallerIcon.ico" phase7_classify_file
  StrCmp "$R0" "locales\en-US.pak" phase7_classify_file
  StrCmp "$R0" "locales\zh-CN.pak" phase7_classify_file
  StrCmp "$R0" "resources\app.asar" phase7_classify_file
  StrCmp "$R0" "resources\selection-host\selection-host.exe" phase7_classify_file
  StrCmp "$R0" "resources\migrations\0001_initial.sql" phase7_classify_file
  StrCmp "$R0" "resources\licenses\THIRD_PARTY_NOTICES.txt" phase7_classify_file
  StrCmp "$R0" "resources\licenses\ELECTRON_LICENSE.txt" phase7_classify_file
  StrCmp "$R0" "resources\licenses\LICENSES.chromium.html" phase7_classify_file
  StrCmp "$R0" "resources\supply-chain\sbom.cdx.json" phase7_classify_file
  StrCmp "$R0" "resources\manifest\product-manifest.json" phase7_classify_file
  StrCmp "$R0" "resources\manifest\component-manifest.json" phase7_classify_file
  StrCmp "$R0" "resources\manifest\file-manifest.sha256" phase7_classify_file
  Goto phase7_classify_done

  phase7_classify_directory:
    StrCpy $R1 "directory"
    Goto phase7_classify_done
  phase7_classify_file:
    StrCpy $R1 "file"
  phase7_classify_done:
    StrCpy $R0 "$R1"
    Pop $R1
    Exch $R0
FunctionEnd

Function ${PHASE7_ALLOWLIST_FUNCTION}
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  StrCpy $R1 "$phase7AllowlistRoot"
  ${If} $R0 != ""
    StrCpy $R1 "$phase7AllowlistRoot\$R0"
  ${EndIf}
  System::Call 'KERNEL32::GetFileAttributesW(w R1) i.R6'
  ${If} $R6 == -1
    !insertmacro phase7Fail "An installation directory disappeared during exact-tree validation."
  ${EndIf}
  IntOp $R7 $R6 & 0x410
  ${If} $R7 != 16
    !insertmacro phase7Fail "An installation directory has the wrong type or is a reparse point: $R1"
  ${EndIf}

  !insertmacro phase7FindFirst "$R1\*" R2 R8 R6 R3 R7
  ${If} $R2 == -1
    !insertmacro phase7FindClose R2 R8
    !insertmacro phase7Fail "The installation tree could not be inspected."
  ${EndIf}

  phase7_allowlist_loop:
    StrCmp $R3 "" phase7_allowlist_done
    StrCmp $R3 "." phase7_allowlist_next
    StrCmp $R3 ".." phase7_allowlist_next

    StrCpy $R4 "$R3"
    ${If} $R0 != ""
      StrCpy $R4 "$R0\$R3"
    ${EndIf}
    StrCpy $R5 "$phase7AllowlistRoot\$R4"
    System::Call 'KERNEL32::GetFileAttributesW(w R5) i.R6'
    ${If} $R6 == -1
      !insertmacro phase7FindClose R2 R8
      !insertmacro phase7Fail "An installation-tree entry disappeared during validation."
    ${EndIf}
    IntOp $R7 $R6 & 0x400
    ${If} $R7 != 0
      !insertmacro phase7FindClose R2 R8
      !insertmacro phase7Fail "Reparse points are not accepted in the installation tree."
    ${EndIf}

    Push "$R4"
    Call ${PHASE7_CLASSIFY_FUNCTION}
    Pop $R7
    ${If} $R7 == ""
      !insertmacro phase7FindClose R2 R8
      !insertmacro phase7Fail "The installation tree contains an unknown entry. Update or uninstall was refused."
    ${EndIf}

    IntOp $R5 $R6 & 0x10
    ${If} $R5 == 0
      ${If} $R7 != "file"
        !insertmacro phase7FindClose R2 R8
        !insertmacro phase7Fail "A product-owned installation entry has the wrong type."
      ${EndIf}
    ${Else}
      ${If} $R7 != "directory"
        !insertmacro phase7FindClose R2 R8
        !insertmacro phase7Fail "A product-owned installation entry has the wrong type."
      ${EndIf}
      Push "$R4"
      Call ${PHASE7_ALLOWLIST_FUNCTION}
    ${EndIf}
    Goto phase7_allowlist_next

  phase7_allowlist_next:
    !insertmacro phase7FindNext R2 R8 R9 R6 R3 R7
    ${If} $R9 == 0
      ${If} $R7 != 18
        !insertmacro phase7FindClose R2 R8
        !insertmacro phase7Fail "The installation tree enumeration failed before reaching normal EOF."
      ${EndIf}
      StrCpy $R3 ""
    ${EndIf}
    Goto phase7_allowlist_loop

  phase7_allowlist_done:
    !insertmacro phase7FindClose R2 R8
    ClearErrors
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

!macro phase7AssertKnownRootEntries ROOT_PATH
  StrCpy $phase7AllowlistRoot "${ROOT_PATH}"
  Push ""
  Call ${PHASE7_ALLOWLIST_FUNCTION}
!macroend

!macro phase7RejectReparseTree ROOT_PATH
  StrCpy $phase7ReparseScanFailed "0"
  Push "${ROOT_PATH}"
  Call ${PHASE7_SCAN_FUNCTION}
  ${If} $phase7ReparseScanFailed != "0"
    !insertmacro phase7Fail "The installation tree contains a reparse point or could not be inspected."
  ${EndIf}
!macroend

!macro phase7ReadRegistryKeyState REGISTRY_KEY OUTPUT
  # This macro uses R0-R2 internally. OUTPUT must be R3-R9.
  StrCpy $${OUTPUT} "error"
  StrCpy $R2 0x20219
  !ifdef APP_64
    StrCpy $R2 0x20119
  !endif
  !ifdef APP_ARM64
    StrCpy $R2 0x20119
  !endif
  System::Call 'ADVAPI32::RegOpenKeyExW(p 0x80000001, w "${REGISTRY_KEY}", i 0, i R2, *p .R0) i.R1'
  ${If} $R1 == 0
    System::Call 'ADVAPI32::RegCloseKey(p R0)'
    StrCpy $${OUTPUT} "present"
  ${ElseIf} $R1 == 2
    StrCpy $${OUTPUT} "absent"
  ${EndIf}
!macroend

!macro phase7CaptureCurrentProcessIdentity
  StrCpy $phase7OwnerIdentityState "error"
  StrCpy $phase7TransactionOwnerPid ""
  StrCpy $phase7TransactionOwnerCreationLow ""
  StrCpy $phase7TransactionOwnerCreationHigh ""
  System::Call 'KERNEL32::GetCurrentProcessId() i.R0'
  System::Alloc 32
  Pop $R1
  ${If} $R1 != 0
    IntOp $R2 $R1 + 8
    IntOp $R3 $R1 + 16
    IntOp $R4 $R1 + 24
    System::Call 'KERNEL32::GetProcessTimes(p -1, p R1, p R2, p R3, p R4) i.R5'
    ${If} $R5 != 0
      System::Call '*$R1(i .R6, i .R7)'
      StrCpy $phase7TransactionOwnerPid "$R0"
      StrCpy $phase7TransactionOwnerCreationLow "$R6"
      StrCpy $phase7TransactionOwnerCreationHigh "$R7"
      StrCpy $phase7OwnerIdentityState "valid"
    ${EndIf}
    System::Free $R1
  ${EndIf}
!macroend

!macro phase7AcquireUninstallMutex
  ${If} $phase7UninstallMutexHandle == ""
  ${OrIf} $phase7UninstallMutexHandle == "0"
    # Scope the Global mutex to the current user SID. HKCU transactions are
    # shared across that user's local/RDP sessions, while unrelated users must
    # not block each other.
    System::Call 'ADVAPI32::OpenProcessToken(p -1, i 0x8, *p .R0) i.R1'
    ${If} $R1 == 0
      !insertmacro phase7Fail "The current-user uninstall mutex identity could not be opened."
    ${EndIf}
    System::Call 'ADVAPI32::GetTokenInformation(p R0, i 1, p 0, i 0, *i .R2) i.R1'
    ${If} $R2 <= 0
      System::Call 'KERNEL32::CloseHandle(p R0)'
      !insertmacro phase7Fail "The current-user uninstall mutex identity size is invalid."
    ${EndIf}
    System::Alloc $R2
    Pop $R3
    ${If} $R3 == 0
      System::Call 'KERNEL32::CloseHandle(p R0)'
      !insertmacro phase7Fail "The current-user uninstall mutex identity could not be allocated."
    ${EndIf}
    System::Call 'ADVAPI32::GetTokenInformation(p R0, i 1, p R3, i R2, *i .R2) i.R1'
    System::Call 'KERNEL32::CloseHandle(p R0)'
    ${If} $R1 == 0
      System::Free $R3
      !insertmacro phase7Fail "The current-user uninstall mutex identity could not be read."
    ${EndIf}
    System::Call '*$R3(p .R4)'
    System::Call 'ADVAPI32::ConvertSidToStringSidW(p R4, *p .R5) i.R1'
    System::Free $R3
    ${If} $R1 == 0
      !insertmacro phase7Fail "The current-user uninstall mutex SID could not be converted."
    ${EndIf}
    # ConvertSidToStringSidW returns an exact-size LocalAlloc string. Never
    # dereference it as a fixed NSIS_MAX_STRLEN array: System.dll would copy
    # past that borrowed allocation and can fault before uninstall preflight.
    System::Call 'KERNEL32::lstrlenW(p R5) i.R6'
    ${If} $R6 <= 0
    ${OrIf} $R6 >= ${NSIS_MAX_STRLEN}
      System::Call 'KERNEL32::LocalFree(p R5)'
      !insertmacro phase7Fail "The current-user uninstall mutex SID length is invalid."
    ${EndIf}
    System::Call 'KERNEL32::lstrcpynW(w .R6, p R5, i ${NSIS_MAX_STRLEN}) p.R7'
    System::Call 'KERNEL32::LocalFree(p R5) p.R8'
    ${If} $R7 == 0
      !insertmacro phase7Fail "The current-user uninstall mutex SID could not be copied safely."
    ${EndIf}
    ${If} $R8 != 0
      !insertmacro phase7Fail "The current-user uninstall mutex SID allocation could not be released safely."
    ${EndIf}
    ${If} $R6 == ""
      !insertmacro phase7Fail "The current-user uninstall mutex SID is empty."
    ${EndIf}
    StrCpy $phase7UninstallMutexName "${PHASE7_UNINSTALL_MUTEX_PREFIX}-$R6"

    System::Call 'KERNEL32::CreateMutexW(p 0, i 0, w "$phase7UninstallMutexName") p.R0'
    ${If} $R0 == 0
      !insertmacro phase7Fail "The Phase 7 uninstall mutex could not be created."
    ${EndIf}
    System::Call 'KERNEL32::WaitForSingleObject(p R0, i 0) i.R1'
    ${If} $R1 == 0
      StrCpy $phase7UninstallMutexHandle "$R0"
    ${ElseIf} $R1 == 128
      StrCpy $phase7UninstallMutexHandle "$R0"
    ${Else}
      System::Call 'KERNEL32::CloseHandle(p R0)'
      !insertmacro phase7Fail "Another installer or uninstaller owns the Phase 7 uninstall boundary."
    ${EndIf}
  ${EndIf}
!macroend

!macro phase7ReleaseUninstallMutex
  ${If} $phase7UninstallMutexHandle != ""
  ${AndIf} $phase7UninstallMutexHandle != "0"
    Push $R0
    StrCpy $R0 "$phase7UninstallMutexHandle"
    System::Call 'KERNEL32::ReleaseMutex(p R0)'
    System::Call 'KERNEL32::CloseHandle(p R0)'
    StrCpy $phase7UninstallMutexHandle "0"
    Pop $R0
  ${EndIf}
!macroend

!macro phase7AssertTransactionOwnerNotLive
  ${If} $phase7TransactionOwnerPid == ""
  ${OrIf} $phase7TransactionOwnerCreationLow == ""
  ${OrIf} $phase7TransactionOwnerCreationHigh == ""
    !insertmacro phase7Fail "The uninstall transaction owner identity is incomplete."
  ${EndIf}

  System::Call 'KERNEL32::OpenProcess(i 0x101000, i 0, i $phase7TransactionOwnerPid) p.R0 ?e'
  Pop $R1
  ${If} $R0 == 0
    ${If} $R1 != 87
      !insertmacro phase7Fail "The uninstall transaction owner could not be inspected safely."
    ${EndIf}
  ${Else}
    System::Alloc 32
    Pop $R2
    ${If} $R2 == 0
      System::Call 'KERNEL32::CloseHandle(p R0)'
      !insertmacro phase7Fail "The uninstall transaction owner identity could not be allocated."
    ${EndIf}
    IntOp $R3 $R2 + 8
    IntOp $R4 $R2 + 16
    IntOp $R5 $R2 + 24
    System::Call 'KERNEL32::GetProcessTimes(p R0, p R2, p R3, p R4, p R5) i.R6'
    ${If} $R6 == 0
      System::Free $R2
      System::Call 'KERNEL32::CloseHandle(p R0)'
      !insertmacro phase7Fail "The uninstall transaction owner creation time could not be read."
    ${EndIf}
    System::Call '*$R2(i .R6, i .R7)'
    System::Free $R2
    System::Call 'KERNEL32::WaitForSingleObject(p R0, i 0) i.R8'
    System::Call 'KERNEL32::CloseHandle(p R0)'
    ${If} $R6 == $phase7TransactionOwnerCreationLow
    ${AndIf} $R7 == $phase7TransactionOwnerCreationHigh
    ${AndIf} $R8 == 258
      !insertmacro phase7Fail "Another live process owns the Phase 7 uninstall transaction."
    ${ElseIf} $R8 != 0
    ${AndIf} $R8 != 258
      !insertmacro phase7Fail "The uninstall transaction owner wait state is invalid."
    ${EndIf}
  ${EndIf}
!macroend

!macro phase7RenameRegistryKey OLD_KEY NEW_KEY OUTPUT
  !define PHASE7_REG_RENAME_ID ${__LINE__}
  StrCpy $${OUTPUT} "failed"
  !insertmacro phase7ReadRegistryKeyState "${OLD_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${NEW_KEY}" R4
  ${If} $R3 != "present"
  ${OrIf} $R4 != "absent"
    Goto phase7_registry_rename_done_${PHASE7_REG_RENAME_ID}
  ${EndIf}

  StrCpy $R2 0x3021F
  !ifdef APP_64
    StrCpy $R2 0x3011F
  !endif
  !ifdef APP_ARM64
    StrCpy $R2 0x3011F
  !endif
  System::Call 'ADVAPI32::RegOpenKeyExW(p 0x80000001, w "${OLD_KEY}", i 0, i R2, *p .R0) i.R1'
  ${If} $R1 != 0
    Goto phase7_registry_rename_done_${PHASE7_REG_RENAME_ID}
  ${EndIf}
  ${GetFileName} "${NEW_KEY}" $R5
  ClearErrors
  System::Call 'ADVAPI32::RegRenameKey(p R0, p 0, w R5) i.R1'
  System::Call 'ADVAPI32::RegCloseKey(p R0)'
  ${If} ${Errors}
    ClearErrors
    Goto phase7_registry_rename_done_${PHASE7_REG_RENAME_ID}
  ${EndIf}
  ${If} $R1 != 0
    Goto phase7_registry_rename_done_${PHASE7_REG_RENAME_ID}
  ${EndIf}
  !insertmacro phase7ReadRegistryKeyState "${OLD_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${NEW_KEY}" R4
  ${If} $R3 == "absent"
  ${AndIf} $R4 == "present"
    StrCpy $${OUTPUT} "renamed"
  ${EndIf}

  phase7_registry_rename_done_${PHASE7_REG_RENAME_ID}:
  ClearErrors
  !undef PHASE7_REG_RENAME_ID
!macroend

!macro phase7CopyRegistryTree SOURCE_KEY DESTINATION_KEY OUTPUT
  !define PHASE7_REG_COPY_ID ${__LINE__}
  # OUTPUT must be R8 or R9. RegCopyTreeW copies the complete value/subkey tree
  # and key security descriptor. Originals are never deleted in this macro.
  StrCpy $${OUTPUT} "failed"
  !insertmacro phase7ReadRegistryKeyState "${SOURCE_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${DESTINATION_KEY}" R4
  ${If} $R3 != "present"
  ${OrIf} $R4 != "absent"
    Goto phase7_registry_copy_done_${PHASE7_REG_COPY_ID}
  ${EndIf}

  StrCpy $R5 0x20219
  StrCpy $R6 0xF023F
  !ifdef APP_64
    StrCpy $R5 0x20119
    StrCpy $R6 0xF013F
  !endif
  !ifdef APP_ARM64
    StrCpy $R5 0x20119
    StrCpy $R6 0xF013F
  !endif
  System::Call 'ADVAPI32::RegOpenKeyExW(p 0x80000001, w "${SOURCE_KEY}", i 0, i R5, *p .R0) i.R1'
  ${If} $R1 != 0
    Goto phase7_registry_copy_done_${PHASE7_REG_COPY_ID}
  ${EndIf}
  System::Call 'ADVAPI32::RegCreateKeyExW(p 0x80000001, w "${DESTINATION_KEY}", i 0, p 0, i 0, i R6, p 0, *p .R2, *i .R7) i.R1'
  ${If} $R1 != 0
    System::Call 'ADVAPI32::RegCloseKey(p R0)'
    Goto phase7_registry_copy_done_${PHASE7_REG_COPY_ID}
  ${EndIf}
  ${If} $R7 != 1
    System::Call 'ADVAPI32::RegCloseKey(p R2)'
    System::Call 'ADVAPI32::RegCloseKey(p R0)'
    Goto phase7_registry_copy_done_${PHASE7_REG_COPY_ID}
  ${EndIf}
  System::Call 'ADVAPI32::RegCopyTreeW(p R0, p 0, p R2) i.R1'
  System::Call 'ADVAPI32::RegCloseKey(p R2)'
  System::Call 'ADVAPI32::RegCloseKey(p R0)'
  ${If} $R1 != 0
    Goto phase7_registry_copy_done_${PHASE7_REG_COPY_ID}
  ${EndIf}
  !insertmacro phase7ReadRegistryKeyState "${SOURCE_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${DESTINATION_KEY}" R4
  ${If} $R3 == "present"
  ${AndIf} $R4 == "present"
    StrCpy $${OUTPUT} "copied"
  ${EndIf}
  phase7_registry_copy_done_${PHASE7_REG_COPY_ID}:
  ClearErrors
  !undef PHASE7_REG_COPY_ID
!macroend

!macro phase7DeleteRegistryTree REGISTRY_KEY OUTPUT
  StrCpy $${OUTPUT} "failed"
  !insertmacro phase7ReadRegistryKeyState "${REGISTRY_KEY}" R3
  ${If} $R3 == "absent"
    StrCpy $${OUTPUT} "deleted"
  ${ElseIf} $R3 == "present"
    ClearErrors
    DeleteRegKey HKCU "${REGISTRY_KEY}"
    !insertmacro phase7ReadRegistryKeyState "${REGISTRY_KEY}" R3
    ${If} $R3 == "absent"
      StrCpy $${OUTPUT} "deleted"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro phase7RestoreRegistryTree BACKUP_KEY DESTINATION_KEY OUTPUT
  StrCpy $${OUTPUT} "failed"
  !insertmacro phase7ReadRegistryKeyState "${BACKUP_KEY}" R3
  ${If} $R3 == "present"
    !insertmacro phase7DeleteRegistryTree "${DESTINATION_KEY}" R9
    ${If} $R9 == "deleted"
      !insertmacro phase7CopyRegistryTree "${BACKUP_KEY}" "${DESTINATION_KEY}" R9
      ${If} $R9 == "copied"
        StrCpy $${OUTPUT} "restored"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro phase7ReadRegistryBackupLayout OUTPUT
  StrCpy $phase7RegistryLayoutResult "error"
  !insertmacro phase7ReadRegistryKeyState "${INSTALL_REGISTRY_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY}" R4
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_INSTALL_REGISTRY_BACKUP_KEY}" R5
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY}" R6
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_REGISTRY_BACKUP_ROOT}" R7
  ${If} $R3 != "error"
  ${AndIf} $R4 != "error"
  ${AndIf} $R5 != "error"
  ${AndIf} $R6 != "error"
  ${AndIf} $R7 != "error"
    ${If} $R3 == "present"
    ${AndIf} $R4 == "present"
    ${AndIf} $R5 == "absent"
    ${AndIf} $R6 == "absent"
    ${AndIf} $R7 == "absent"
      StrCpy $phase7RegistryLayoutResult "stable"
    ${ElseIf} $R3 == "present"
    ${AndIf} $R4 == "present"
    ${AndIf} $R5 == "present"
    ${AndIf} $R6 == "present"
    ${AndIf} $R7 == "present"
      StrCpy $phase7RegistryLayoutResult "copied"
    ${ElseIf} $R3 == "absent"
    ${AndIf} $R4 == "absent"
    ${AndIf} $R5 == "present"
    ${AndIf} $R6 == "present"
    ${AndIf} $R7 == "present"
      StrCpy $phase7RegistryLayoutResult "backed-up"
    ${Else}
      StrCpy $phase7RegistryLayoutResult "mixed"
    ${EndIf}
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7RegistryLayoutResult"
!macroend

!macro phase7AssertNoConcurrentUninstallBoundary
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_REGISTRY_BACKUP_ROOT}" R4
  ${If} $R3 != "absent"
  ${OrIf} $R4 != "absent"
    !insertmacro phase7Fail "A concurrent or incomplete uninstall boundary appeared before installation mutation."
  ${EndIf}
!macroend

!macro phase7BackupProductRegistry OUTPUT
  StrCpy $phase7RegistryOperationResult "failed"
  !insertmacro phase7ReadRegistryBackupLayout R7
  ${If} $R7 == "stable"
    !insertmacro phase7CopyRegistryTree "${INSTALL_REGISTRY_KEY}" "${PHASE7_INSTALL_REGISTRY_BACKUP_KEY}" R8
    ${If} $R8 == "copied"
      !insertmacro phase7CopyRegistryTree "${UNINSTALL_REGISTRY_KEY}" "${PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY}" R8
      ${If} $R8 == "copied"
        !insertmacro phase7ReadRegistryBackupLayout R7
        ${If} $R7 == "copied"
          # Both synchronous copies completed and both originals are still
          # present. The caller must durably persist registry-backups-ready
          # before deleting either original.
          StrCpy $phase7RegistryOperationResult "copied"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7RegistryOperationResult"
!macroend

!macro phase7DeleteProductRegistryOriginals OUTPUT
  StrCpy $phase7RegistryOperationResult "failed"
  ${If} $phase7TransactionState != "registry-delete-started"
    !insertmacro phase7Fail "Product registry deletion was requested without complete durable backups."
  ${EndIf}
  !insertmacro phase7DeleteRegistryTree "${INSTALL_REGISTRY_KEY}" R8
  ${If} $R8 == "deleted"
    !insertmacro phase7DeleteRegistryTree "${UNINSTALL_REGISTRY_KEY}" R8
    ${If} $R8 == "deleted"
      !insertmacro phase7ReadRegistryBackupLayout R7
      ${If} $R7 == "backed-up"
        StrCpy $phase7RegistryOperationResult "deleted"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7RegistryOperationResult"
!macroend

!macro phase7RestoreProductRegistryBackup OUTPUT
  StrCpy $phase7RegistryOperationResult "failed"
  ${If} $phase7TransactionState != "rollback-rebuild-ready"
    !insertmacro phase7Fail "Complete registry backup restore was requested without durable readiness."
  ${EndIf}
  !insertmacro phase7RestoreRegistryTree "${PHASE7_INSTALL_REGISTRY_BACKUP_KEY}" "${INSTALL_REGISTRY_KEY}" R8
  ${If} $R8 == "restored"
    !insertmacro phase7RestoreRegistryTree "${PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY}" "${UNINSTALL_REGISTRY_KEY}" R8
    ${If} $R8 == "restored"
      !insertmacro phase7ReadRegistryKeyState "${INSTALL_REGISTRY_KEY}" R3
      !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY}" R4
      ${If} $R3 == "present"
      ${AndIf} $R4 == "present"
        StrCpy $phase7RegistryOperationResult "restored-with-backups"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7RegistryOperationResult"
  ClearErrors
!macroend

!macro phase7DeleteRollbackRegistryBackups OUTPUT
  !define PHASE7_ROLLBACK_BACKUP_CLEANUP_ID ${__LINE__}
  StrCpy $phase7RegistryOperationResult "cleanup-failed"
  !insertmacro phase7ReadRegistryKeyState "${INSTALL_REGISTRY_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY}" R4
  ${If} $R3 != "present"
  ${OrIf} $R4 != "present"
    Goto phase7_rollback_backup_cleanup_done_${PHASE7_ROLLBACK_BACKUP_CLEANUP_ID}
  ${EndIf}
  !insertmacro phase7DeleteRegistryTree "${PHASE7_INSTALL_REGISTRY_BACKUP_KEY}" R8
  ${If} $R8 != "deleted"
    Goto phase7_rollback_backup_cleanup_done_${PHASE7_ROLLBACK_BACKUP_CLEANUP_ID}
  ${EndIf}
  !insertmacro phase7DeleteRegistryTree "${PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY}" R8
  ${If} $R8 != "deleted"
    Goto phase7_rollback_backup_cleanup_done_${PHASE7_ROLLBACK_BACKUP_CLEANUP_ID}
  ${EndIf}
  ClearErrors
  DeleteRegKey /ifempty HKCU "${PHASE7_REGISTRY_BACKUP_ROOT}"
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_REGISTRY_BACKUP_ROOT}" R5
  ${If} $R5 != "absent"
    Goto phase7_rollback_backup_cleanup_done_${PHASE7_ROLLBACK_BACKUP_CLEANUP_ID}
  ${EndIf}
  DeleteRegKey /ifempty HKCU "${PHASE7_REGISTRY_BACKUP_CONTAINER}"
  !insertmacro phase7ReadRegistryBackupLayout R7
  ${If} $R7 == "stable"
    StrCpy $phase7RegistryOperationResult "clean"
  ${EndIf}
  phase7_rollback_backup_cleanup_done_${PHASE7_ROLLBACK_BACKUP_CLEANUP_ID}:
  StrCpy $${OUTPUT} "$phase7RegistryOperationResult"
  ClearErrors
  !undef PHASE7_ROLLBACK_BACKUP_CLEANUP_ID
!macroend

!macro phase7DeleteCommittedRegistryBackups OUTPUT
  !define PHASE7_REG_BACKUP_CLEANUP_ID ${__LINE__}
  StrCpy $phase7RegistryOperationResult "cleanup-failed"
  !insertmacro phase7ReadRegistryKeyState "${INSTALL_REGISTRY_KEY}" R3
  !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY}" R4
  ${If} $R3 == "absent"
  ${AndIf} $R4 == "absent"
    !insertmacro phase7DeleteRegistryTree "${PHASE7_INSTALL_REGISTRY_BACKUP_KEY}" R8
    ${If} $R8 != "deleted"
      Goto phase7_registry_backup_cleanup_done_${PHASE7_REG_BACKUP_CLEANUP_ID}
    ${EndIf}
    !insertmacro phase7DeleteRegistryTree "${PHASE7_UNINSTALL_REGISTRY_BACKUP_KEY}" R8
    ${If} $R8 != "deleted"
      Goto phase7_registry_backup_cleanup_done_${PHASE7_REG_BACKUP_CLEANUP_ID}
    ${EndIf}
    ClearErrors
    DeleteRegKey /ifempty HKCU "${PHASE7_REGISTRY_BACKUP_ROOT}"
    !insertmacro phase7ReadRegistryKeyState "${PHASE7_REGISTRY_BACKUP_ROOT}" R5
    ${If} $R5 == "absent"
      DeleteRegKey /ifempty HKCU "${PHASE7_REGISTRY_BACKUP_CONTAINER}"
      StrCpy $phase7RegistryOperationResult "clean"
    ${EndIf}
  ${EndIf}
  phase7_registry_backup_cleanup_done_${PHASE7_REG_BACKUP_CLEANUP_ID}:
  StrCpy $${OUTPUT} "$phase7RegistryOperationResult"
  ClearErrors
  !undef PHASE7_REG_BACKUP_CLEANUP_ID
!macroend

!macro phase7CheckProductRegistryAbsent OUTPUT
  StrCpy $${OUTPUT} "absent"
  !insertmacro phase7ReadRegistryKeyState "${INSTALL_REGISTRY_KEY}" R3
  ${If} $R3 != "absent"
    StrCpy $${OUTPUT} "$R3"
  ${EndIf}
  !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY}" R3
  ${If} $R3 != "absent"
    StrCpy $${OUTPUT} "$R3"
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro phase7ReadRegistryKeyState "${UNINSTALL_REGISTRY_KEY_2}" R3
    ${If} $R3 != "absent"
      StrCpy $${OUTPUT} "$R3"
    ${EndIf}
  !endif
!macroend

!macro phase7ClaimUninstallTransaction OUTPUT
  !define PHASE7_TX_CLAIM_ID ${__LINE__}
  StrCpy $phase7TransactionClaimResult "failed"
  StrCpy $phase7TransactionCleanupVersion "${PHASE7_POST_CLEANUP_VERSION}"
  StrCpy $phase7TransactionKeepShortcuts "0"
  ${If} ${isKeepShortcuts}
    StrCpy $phase7TransactionKeepShortcuts "1"
  ${EndIf}
  StrCpy $phase7TransactionShortcutName "$phase7RegisteredShortcutName"
  StrCpy $phase7TransactionMenuDirectory "$phase7RegisteredMenuDirectory"
  StrCpy $phase7TransactionDeleteAppData "0"
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $phase7TransactionDeleteAppData "1"
  ${Else}
    !ifdef DELETE_APP_DATA_ON_UNINSTALL
      ${IfNot} ${isUpdated}
        StrCpy $phase7TransactionDeleteAppData "1"
      ${EndIf}
    !endif
  ${EndIf}
  ClearErrors
  !insertmacro phase7CaptureCurrentProcessIdentity
  ${If} $phase7OwnerIdentityState != "valid"
    Goto phase7_tx_claim_done_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::GetTickCount() i.R0'
  StrCpy $phase7TransactionClaimKey "${PHASE7_UNINSTALL_TRANSACTION_KEY}.Claim-$phase7TransactionOwnerPid-$R0"
  !insertmacro phase7ReadRegistryKeyState "$phase7TransactionClaimKey" R3
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R4
  ${If} $R3 != "absent"
  ${OrIf} $R4 != "absent"
    Goto phase7_tx_claim_done_${PHASE7_TX_CLAIM_ID}
  ${EndIf}

  StrCpy $R2 0xF023F
  !ifdef APP_64
    StrCpy $R2 0xF013F
  !endif
  !ifdef APP_ARM64
    StrCpy $R2 0xF013F
  !endif
  System::Call 'ADVAPI32::RegCreateKeyExW(p 0x80000001, w "$phase7TransactionClaimKey", i 0, p 0, i 0, i R2, p 0, *p .R0, *i .R1) i.R3'
  ${If} $R3 != 0
    Goto phase7_tx_claim_done_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'ADVAPI32::RegCloseKey(p R0)'
  ${If} $R1 != 1
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}

  ClearErrors
  WriteRegStr HKCU "$phase7TransactionClaimKey" Identity "${PHASE7_UNINSTALL_TRANSACTION_VALUE}"
  WriteRegStr HKCU "$phase7TransactionClaimKey" SourceRoot "$phase7TransactionSource"
  WriteRegStr HKCU "$phase7TransactionClaimKey" StagePath "$phase7TransactionStage"
  WriteRegStr HKCU "$phase7TransactionClaimKey" State "prepared"
  WriteRegStr HKCU "$phase7TransactionClaimKey" OwnerPid "$phase7TransactionOwnerPid"
  WriteRegStr HKCU "$phase7TransactionClaimKey" OwnerCreationLow "$phase7TransactionOwnerCreationLow"
  WriteRegStr HKCU "$phase7TransactionClaimKey" OwnerCreationHigh "$phase7TransactionOwnerCreationHigh"
  WriteRegStr HKCU "$phase7TransactionClaimKey" CleanupVersion "$phase7TransactionCleanupVersion"
  WriteRegStr HKCU "$phase7TransactionClaimKey" KeepShortcuts "$phase7TransactionKeepShortcuts"
  WriteRegStr HKCU "$phase7TransactionClaimKey" ShortcutName "$phase7TransactionShortcutName"
  WriteRegStr HKCU "$phase7TransactionClaimKey" MenuDirectory "$phase7TransactionMenuDirectory"
  WriteRegStr HKCU "$phase7TransactionClaimKey" DeleteAppData "$phase7TransactionDeleteAppData"
  ${If} ${Errors}
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" Identity
  ReadRegStr $R1 HKCU "$phase7TransactionClaimKey" SourceRoot
  ReadRegStr $R2 HKCU "$phase7TransactionClaimKey" StagePath
  ReadRegStr $R3 HKCU "$phase7TransactionClaimKey" State
  ReadRegStr $R4 HKCU "$phase7TransactionClaimKey" OwnerPid
  ReadRegStr $R5 HKCU "$phase7TransactionClaimKey" OwnerCreationLow
  ReadRegStr $R6 HKCU "$phase7TransactionClaimKey" OwnerCreationHigh
  System::Call 'KERNEL32::lstrcmpW(w R0, w "${PHASE7_UNINSTALL_TRANSACTION_VALUE}") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R1, w "$phase7TransactionSource") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R2, w "$phase7TransactionStage") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R3, w "prepared") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R4, w "$phase7TransactionOwnerPid") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R5, w "$phase7TransactionOwnerCreationLow") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R6, w "$phase7TransactionOwnerCreationHigh") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" CleanupVersion
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionCleanupVersion") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" KeepShortcuts
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionKeepShortcuts") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" ShortcutName
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionShortcutName") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" MenuDirectory
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionMenuDirectory") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "$phase7TransactionClaimKey" DeleteAppData
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionDeleteAppData") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}
  ${EndIf}

  !insertmacro phase7RenameRegistryKey "$phase7TransactionClaimKey" "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R8
  ${If} $R8 == "renamed"
    StrCpy $phase7TransactionPresent "1"
    StrCpy $phase7TransactionState "prepared"
    StrCpy $phase7TransactionClaimResult "claimed"
    Goto phase7_tx_claim_done_${PHASE7_TX_CLAIM_ID}
  ${EndIf}

  phase7_tx_claim_cleanup_${PHASE7_TX_CLAIM_ID}:
    ClearErrors
    DeleteRegKey HKCU "$phase7TransactionClaimKey"
    ClearErrors

  phase7_tx_claim_done_${PHASE7_TX_CLAIM_ID}:
  StrCpy $${OUTPUT} "$phase7TransactionClaimResult"
  ClearErrors
  !undef PHASE7_TX_CLAIM_ID
!macroend

!macro phase7PersistUninstallTransaction TRANSACTION_STATE OUTPUT
  !define PHASE7_TX_WRITE_ID ${__LINE__}
  StrCpy $phase7TransactionWriteResult "failed"
  ClearErrors
  WriteRegStr HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" State "${TRANSACTION_STATE}"
  ${If} ${Errors}
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}

  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" Identity
  ReadRegStr $R1 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" SourceRoot
  ReadRegStr $R2 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" StagePath
  ReadRegStr $R3 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" State
  ReadRegStr $R4 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerPid
  ReadRegStr $R5 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerCreationLow
  ReadRegStr $R6 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerCreationHigh
  System::Call 'KERNEL32::lstrcmpW(w R0, w "${PHASE7_UNINSTALL_TRANSACTION_VALUE}") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R1, w "$phase7TransactionSource") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R2, w "$phase7TransactionStage") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R3, w "${TRANSACTION_STATE}") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R4, w "$phase7TransactionOwnerPid") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R5, w "$phase7TransactionOwnerCreationLow") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R6, w "$phase7TransactionOwnerCreationHigh") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" CleanupVersion
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionCleanupVersion") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" KeepShortcuts
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionKeepShortcuts") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" ShortcutName
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionShortcutName") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" MenuDirectory
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionMenuDirectory") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" DeleteAppData
  System::Call 'KERNEL32::lstrcmpW(w R0, w "$phase7TransactionDeleteAppData") i.R7'
  ${If} $R7 != 0
    Goto phase7_tx_write_done_${PHASE7_TX_WRITE_ID}
  ${EndIf}
  StrCpy $phase7TransactionState "${TRANSACTION_STATE}"
  StrCpy $phase7TransactionWriteResult "written"

  phase7_tx_write_done_${PHASE7_TX_WRITE_ID}:
  StrCpy $${OUTPUT} "$phase7TransactionWriteResult"
  ClearErrors
  !undef PHASE7_TX_WRITE_ID
!macroend

!macro phase7ClearUninstallTransaction OUTPUT
  StrCpy $phase7TransactionClearResult "failed"
  ClearErrors
  DeleteRegKey HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}"
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R3
  ${If} $R3 == "absent"
    StrCpy $phase7TransactionPresent "0"
    StrCpy $phase7TransactionClearResult "cleared"
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7TransactionClearResult"
  ClearErrors
!macroend

!macro phase7ReadUninstallTransaction
  !define PHASE7_TX_READ_ID ${__LINE__}
  StrCpy $phase7TransactionPresent "0"
  StrCpy $phase7TransactionState ""
  StrCpy $phase7TransactionSource ""
  StrCpy $phase7TransactionStage ""
  StrCpy $phase7TransactionOwnerPid ""
  StrCpy $phase7TransactionOwnerCreationLow ""
  StrCpy $phase7TransactionOwnerCreationHigh ""
  StrCpy $phase7TransactionCleanupVersion ""
  StrCpy $phase7TransactionKeepShortcuts ""
  StrCpy $phase7TransactionShortcutName ""
  StrCpy $phase7TransactionMenuDirectory ""
  StrCpy $phase7TransactionDeleteAppData ""
  !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R3
  ${If} $R3 == "error"
    !insertmacro phase7Fail "The Phase 7 uninstall transaction registry could not be inspected."
  ${ElseIf} $R3 == "present"
    !insertmacro phase7AcquireUninstallMutex
    !insertmacro phase7ReadRegistryKeyState "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R3
    ${If} $R3 == "absent"
      !insertmacro phase7ReleaseUninstallMutex
      Goto phase7_tx_read_done_${PHASE7_TX_READ_ID}
    ${ElseIf} $R3 != "present"
      !insertmacro phase7Fail "The Phase 7 uninstall transaction changed while acquiring recovery ownership."
    ${EndIf}
    ReadRegStr $R0 HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" Identity
    System::Call 'KERNEL32::lstrcmpW(w R0, w "${PHASE7_UNINSTALL_TRANSACTION_VALUE}") i.R1'
    ${If} $R1 != 0
      !insertmacro phase7Fail "The Phase 7 uninstall transaction identity is invalid."
    ${EndIf}
    ReadRegStr $phase7TransactionSource HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" SourceRoot
    ReadRegStr $phase7TransactionStage HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" StagePath
    ReadRegStr $phase7TransactionState HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" State
    ReadRegStr $phase7TransactionOwnerPid HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerPid
    ReadRegStr $phase7TransactionOwnerCreationLow HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerCreationLow
    ReadRegStr $phase7TransactionOwnerCreationHigh HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" OwnerCreationHigh
    ReadRegStr $phase7TransactionCleanupVersion HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" CleanupVersion
    ReadRegStr $phase7TransactionKeepShortcuts HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" KeepShortcuts
    ReadRegStr $phase7TransactionShortcutName HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" ShortcutName
    ReadRegStr $phase7TransactionMenuDirectory HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" MenuDirectory
    ReadRegStr $phase7TransactionDeleteAppData HKCU "${PHASE7_UNINSTALL_TRANSACTION_KEY}" DeleteAppData
    ${If} $phase7TransactionSource == ""
    ${OrIf} $phase7TransactionStage == ""
    ${OrIf} $phase7TransactionState == ""
    ${OrIf} $phase7TransactionOwnerPid == ""
    ${OrIf} $phase7TransactionOwnerCreationLow == ""
    ${OrIf} $phase7TransactionOwnerCreationHigh == ""
    ${OrIf} $phase7TransactionCleanupVersion == ""
    ${OrIf} $phase7TransactionKeepShortcuts == ""
    ${OrIf} $phase7TransactionShortcutName == ""
    ${OrIf} $phase7TransactionDeleteAppData == ""
      !insertmacro phase7Fail "The Phase 7 uninstall transaction is incomplete."
    ${EndIf}
    System::Call 'KERNEL32::lstrcmpW(w "$phase7TransactionCleanupVersion", w "${PHASE7_POST_CLEANUP_VERSION}") i.R0'
    ${If} $R0 != 0
      !insertmacro phase7Fail "The Phase 7 post-cleanup transaction version is invalid."
    ${EndIf}
    ${If} $phase7TransactionKeepShortcuts != "0"
    ${AndIf} $phase7TransactionKeepShortcuts != "1"
      !insertmacro phase7Fail "The Phase 7 shortcut cleanup intent is invalid."
    ${EndIf}
    System::Call 'KERNEL32::lstrcmpW(w "$phase7TransactionShortcutName", w "${SHORTCUT_NAME}") i.R0'
    ${If} $R0 != 0
      !insertmacro phase7Fail "The Phase 7 shortcut cleanup name is invalid."
    ${EndIf}
    !ifdef MENU_FILENAME
      System::Call 'KERNEL32::lstrcmpW(w "$phase7TransactionMenuDirectory", w "${MENU_FILENAME}") i.R0'
      ${If} $R0 != 0
        !insertmacro phase7Fail "The Phase 7 Start Menu cleanup directory is invalid."
      ${EndIf}
    !else
      ${If} $phase7TransactionMenuDirectory != ""
        !insertmacro phase7Fail "The Phase 7 Start Menu cleanup directory is unexpected."
      ${EndIf}
    !endif
    ${If} $phase7TransactionDeleteAppData != "0"
    ${AndIf} $phase7TransactionDeleteAppData != "1"
      !insertmacro phase7Fail "The Phase 7 application-data cleanup intent is invalid."
    ${EndIf}
    ${If} $phase7TransactionState != "prepared"
    ${AndIf} $phase7TransactionState != "staged-uncommitted"
    ${AndIf} $phase7TransactionState != "rollback-pending"
    ${AndIf} $phase7TransactionState != "registry-backups-ready"
    ${AndIf} $phase7TransactionState != "registry-delete-started"
    ${AndIf} $phase7TransactionState != "rollback-backups-ready"
    ${AndIf} $phase7TransactionState != "rollback-rebuild-ready"
    ${AndIf} $phase7TransactionState != "rollback-registry-restored"
    ${AndIf} $phase7TransactionState != "committed-cleanup"
    ${AndIf} $phase7TransactionState != "committed-postcleanup"
      !insertmacro phase7Fail "The Phase 7 uninstall transaction state is invalid."
    ${EndIf}
    !insertmacro phase7AssertTransactionOwnerNotLive
    StrCpy $phase7TransactionPresent "1"
  ${EndIf}
  phase7_tx_read_done_${PHASE7_TX_READ_ID}:
  !undef PHASE7_TX_READ_ID
!macroend

!macro phase7ValidateUninstallTransactionPaths
  # During a valid transaction either root can be absent: staging has not been
  # created in "prepared", source is absent after the atomic rename, and both
  # are absent during committed cleanup. Only their shared parent is guaranteed
  # to exist, so canonicalize that parent and reconstruct both exact leaves.
  ${If} $phase7TransactionSource == ""
  ${OrIf} $phase7TransactionStage == ""
    !insertmacro phase7Fail "The Phase 7 uninstall transaction paths are invalid."
  ${EndIf}

  ${GetFileName} "$phase7TransactionSource" $R2
  System::Call 'KERNEL32::lstrcmpiW(w R2, w "${APP_FILENAME}") i.R3'
  ${If} $R3 != 0
    !insertmacro phase7Fail "The Phase 7 uninstall source leaf is invalid."
  ${EndIf}

  ${GetFileName} "$phase7TransactionStage" $R3
  StrLen $R4 "${PHASE7_STAGE_PREFIX}-"
  StrCpy $R5 "$R3" $R4
  System::Call 'KERNEL32::lstrcmpiW(w R5, w "${PHASE7_STAGE_PREFIX}-") i.R2'
  ${If} $R2 != 0
    !insertmacro phase7Fail "The Phase 7 uninstall staging leaf is invalid."
  ${EndIf}
  StrLen $R5 "$R3"
  ${If} $R5 <= $R4
    !insertmacro phase7Fail "The Phase 7 uninstall staging identity is incomplete."
  ${EndIf}

  ${GetParent} "$phase7TransactionSource" $R0
  ${GetParent} "$phase7TransactionStage" $R1
  ${If} $R0 == ""
  ${OrIf} $R1 == ""
    !insertmacro phase7Fail "The Phase 7 uninstall transaction parents are invalid."
  ${EndIf}

  # FileFunc's GetParent returns "C:" for a direct child of a drive root.
  # Canonicalizing that spelling would resolve the drive's current directory,
  # so restore the root separator before calling GetFullPathName.
  StrLen $R4 "$R0"
  ${If} $R4 == 2
    StrCpy $R5 "$R0" 1 1
    ${If} $R5 == ":"
      StrCpy $R0 "$R0\"
    ${EndIf}
  ${EndIf}
  StrLen $R4 "$R1"
  ${If} $R4 == 2
    StrCpy $R5 "$R1" 1 1
    ${If} $R5 == ":"
      StrCpy $R1 "$R1\"
    ${EndIf}
  ${EndIf}

  GetFullPathName $R4 "$R0"
  GetFullPathName $R5 "$R1"
  ${If} $R4 == ""
  ${OrIf} $R5 == ""
    !insertmacro phase7Fail "The Phase 7 uninstall transaction parents could not be normalized."
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpiW(w R4, w R5) i.R2'
  ${If} $R2 != 0
    !insertmacro phase7Fail "The Phase 7 uninstall staging path is not a same-parent sibling."
  ${EndIf}

  StrCpy $R0 "$R4" 1 -1
  ${If} $R0 == "\"
    StrCpy $R0 "$R4${APP_FILENAME}"
  ${Else}
    StrCpy $R0 "$R4\${APP_FILENAME}"
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpiW(w R0, w "$phase7TransactionSource") i.R2'
  ${If} $R2 != 0
    !insertmacro phase7Fail "The Phase 7 uninstall source path is not normalized."
  ${EndIf}

  StrCpy $R1 "$R4" 1 -1
  ${If} $R1 == "\"
    StrCpy $R1 "$R4$R3"
  ${Else}
    StrCpy $R1 "$R4\$R3"
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpiW(w R1, w "$phase7TransactionStage") i.R2'
  ${If} $R2 != 0
    !insertmacro phase7Fail "The Phase 7 uninstall staging path is not normalized."
  ${EndIf}
!macroend

!macro phase7ValidateStableRoot ROOT_PATH
  StrCpy $INSTDIR "${ROOT_PATH}"
  !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
  Push "$INSTDIR"
  Call ${PHASE7_ANCESTOR_FUNCTION}
  !insertmacro phase7RejectReparseTree "$INSTDIR"
  !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
  !insertmacro phase7ReadAndVerifyMarker
  ${If} $R0 != "valid"
    !insertmacro phase7Fail "The stable Phase 7 installation marker is missing."
  ${EndIf}
!macroend

!macro phase7AssertRestoredStableRegistryIdentity
  StrCpy $INSTDIR "$phase7TransactionSource"
  !insertmacro phase7ReadCurrentUserRegistryIdentity
  ${If} $phase7RegisteredPath == ""
  ${OrIf} $phase7RegisteredUninstallString == ""
  ${OrIf} $phase7RegisteredQuietUninstallString == ""
    !insertmacro phase7Fail "The restored product registry identity is incomplete."
  ${EndIf}
  !insertmacro phase7AssertRegisteredShortcutRegistry
  !insertmacro phase7NormalizeAndMatchRegisteredPath
!macroend

!macro phase7CleanupCommittedStage OUTPUT
  !define PHASE7_COMMITTED_CLEANUP_ID ${__LINE__}
  StrCpy $phase7StageCleanupPending "clean"
  !insertmacro phase7ReadPathState "$phase7TransactionStage" R2 R0 R1
  ${If} $R2 == "error"
    !insertmacro phase7Fail "The committed Phase 7 staging path could not be inspected."
  ${ElseIf} $R2 == "present"
    IntOp $R1 $R0 & 0x410
    ${If} $R1 != 16
      !insertmacro phase7Fail "The committed Phase 7 staging path has an unsafe type."
    ${EndIf}
    !insertmacro phase7AssertDirectoryIsNotReparse "$phase7TransactionStage"
    Push "$phase7TransactionStage"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    !insertmacro phase7RejectReparseTree "$phase7TransactionStage"

    !insertmacro phase7ReadPathState "$phase7TransactionStage\${PHASE7_INSTALL_MARKER_NAME}" R5 R3 R4
    ${If} $R5 == "error"
      !insertmacro phase7Fail "The committed staging marker could not be inspected."
    ${ElseIf} $R5 == "present"
      StrCpy $INSTDIR "$phase7TransactionStage"
      !insertmacro phase7ReadAndVerifyMarker
      ${If} $R0 != "valid"
        !insertmacro phase7Fail "The committed staging marker is invalid."
      ${EndIf}
      !insertmacro phase7AssertKnownRootEntries "$phase7TransactionStage"
      Push ""
      Call ${PHASE7_COMMITTED_DELETE_FUNCTION}
      ${If} $phase7StageCleanupPending != "clean"
        Goto phase7_committed_cleanup_done_${PHASE7_COMMITTED_CLEANUP_ID}
      ${EndIf}

      # Re-enumerate after deletion. The stable marker must be the only entry
      # before it is removed, so a crash never leaves a markerless nonempty
      # directory eligible for recursive cleanup.
      !insertmacro phase7RejectReparseTree "$phase7TransactionStage"
      !insertmacro phase7AssertKnownRootEntries "$phase7TransactionStage"
      !insertmacro phase7ReadAndVerifyMarker
      ${If} $R0 != "valid"
        !insertmacro phase7Fail "The stable marker changed during committed cleanup."
      ${EndIf}
      !insertmacro phase7InspectCleanupRoot "$phase7TransactionStage"
      ${If} $phase7CleanupRootState != "marker-only"
        !insertmacro phase7Fail "Committed cleanup did not reduce staging to the stable marker."
      ${EndIf}
      ClearErrors
      Delete "$phase7TransactionStage\${PHASE7_INSTALL_MARKER_NAME}"
      ${If} ${Errors}
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_cleanup_done_${PHASE7_COMMITTED_CLEANUP_ID}
      ${EndIf}
      !insertmacro phase7ReadPathState "$phase7TransactionStage\${PHASE7_INSTALL_MARKER_NAME}" R5 R3 R4
      ${If} $R5 != "absent"
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_cleanup_done_${PHASE7_COMMITTED_CLEANUP_ID}
      ${EndIf}
    ${EndIf}

    # Markerless recovery is accepted only for the exact empty-root crash
    # window between marker deletion and the final non-recursive RMDir.
    !insertmacro phase7InspectCleanupRoot "$phase7TransactionStage"
    ${If} $phase7CleanupRootState != "empty"
      !insertmacro phase7Fail "Markerless committed staging is not empty; cleanup was refused."
    ${EndIf}
    ClearErrors
    RMDir "$phase7TransactionStage"
    ${If} ${Errors}
      StrCpy $phase7StageCleanupPending "cleanup-failed"
    ${Else}
      !insertmacro phase7ReadPathState "$phase7TransactionStage" R2 R0 R1
      ${If} $R2 != "absent"
        StrCpy $phase7StageCleanupPending "cleanup-failed"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  phase7_committed_cleanup_done_${PHASE7_COMMITTED_CLEANUP_ID}:
  StrCpy $INSTDIR "$phase7TransactionSource"
  StrCpy $${OUTPUT} "$phase7StageCleanupPending"
  ClearErrors
  !undef PHASE7_COMMITTED_CLEANUP_ID
!macroend

!macro phase7AdvanceCommittedRootCleanup OUTPUT
  !define PHASE7_ADVANCE_COMMITTED_ID ${__LINE__}
  StrCpy $phase7CommittedCleanupResult "pending"
  ${If} $phase7TransactionState != "committed-cleanup"
    !insertmacro phase7Fail "The uninstall root cleanup was requested before registry commit."
  ${EndIf}
  !insertmacro phase7CheckProductRegistryAbsent R6
  ${If} $R6 != "absent"
    !insertmacro phase7Fail "Committed uninstall cleanup found a normal product registry key."
  ${EndIf}
  !insertmacro phase7ReadPathState "$phase7TransactionSource" R4 R0 R1
  ${If} $R4 == "error"
    !insertmacro phase7Fail "The source root could not be inspected after uninstall commit."
  ${ElseIf} $R4 == "present"
    !insertmacro phase7Fail "The source root reappeared after uninstall commit."
  ${EndIf}
  !insertmacro phase7CleanupCommittedStage R4
  ${If} $R4 != "clean"
    Goto phase7_committed_root_cleanup_done_${PHASE7_ADVANCE_COMMITTED_ID}
  ${EndIf}
  # Backup keys are independently idempotent: a prior process may have deleted
  # either one before crashing. Both live outside the Apps & Features
  # enumeration root, so an interrupted cleanup cannot expose a broken entry.
  !insertmacro phase7DeleteCommittedRegistryBackups R4
  ${If} $R4 != "clean"
    Goto phase7_committed_root_cleanup_done_${PHASE7_ADVANCE_COMMITTED_ID}
  ${EndIf}
  !insertmacro phase7PersistUninstallTransaction "committed-postcleanup" R4
  ${If} $R4 == "written"
    StrCpy $phase7CommittedCleanupResult "postcleanup-ready"
  ${EndIf}
  phase7_committed_root_cleanup_done_${PHASE7_ADVANCE_COMMITTED_ID}:
  StrCpy $${OUTPUT} "$phase7CommittedCleanupResult"
  ClearErrors
  !undef PHASE7_ADVANCE_COMMITTED_ID
!macroend

!macro phase7DeleteExactAppDataTree LEAF_NAME OUTPUT
  !define PHASE7_APP_DATA_CLEANUP_ID ${__LINE__}
  StrCpy $${OUTPUT} "cleanup-failed"
  GetFullPathName $R0 "$APPDATA\${LEAF_NAME}"
  GetFullPathName $R1 "$APPDATA"
  ${GetParent} "$R0" $R2
  ${GetFileName} "$R0" $R3
  System::Call 'KERNEL32::lstrcmpiW(w R2, w R1) i.R4'
  ${If} $R0 == ""
  ${OrIf} $R1 == ""
  ${OrIf} $R4 != 0
    Goto phase7_app_data_cleanup_done_${PHASE7_APP_DATA_CLEANUP_ID}
  ${EndIf}
  System::Call 'KERNEL32::lstrcmpW(w R3, w "${LEAF_NAME}") i.R4'
  ${If} $R4 != 0
  ${OrIf} $R3 == "."
  ${OrIf} $R3 == ".."
    Goto phase7_app_data_cleanup_done_${PHASE7_APP_DATA_CLEANUP_ID}
  ${EndIf}

  !insertmacro phase7ReadPathState "$R0" R5 R1 R2
  ${If} $R5 == "absent"
    StrCpy $${OUTPUT} "clean"
  ${ElseIf} $R5 == "present"
    IntOp $R4 $R1 & 0x410
    ${If} $R4 == 16
      !insertmacro phase7RejectReparseTree "$R0"
      ClearErrors
      RMDir /r "$R0"
      !insertmacro phase7ReadPathState "$R0" R5 R1 R2
      ${If} $R5 == "absent"
        StrCpy $${OUTPUT} "clean"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  phase7_app_data_cleanup_done_${PHASE7_APP_DATA_CLEANUP_ID}:
  ClearErrors
  !undef PHASE7_APP_DATA_CLEANUP_ID
!macroend

!macro phase7RunPostCommitCleanup OUTPUT
  !define PHASE7_POST_CLEANUP_ID ${__LINE__}
  StrCpy $phase7PostCleanupOperationResult "cleanup-failed"
  ${If} $phase7TransactionState != "committed-postcleanup"
    !insertmacro phase7Fail "External uninstall cleanup was requested before root cleanup committed."
  ${EndIf}

  StrCpy $oldShortcutName "$phase7TransactionShortcutName"
  StrCpy $oldDesktopLink "$DESKTOP\$oldShortcutName.lnk"
  ${If} $phase7TransactionMenuDirectory == ""
    StrCpy $oldStartMenuLink "$SMPROGRAMS\$oldShortcutName.lnk"
  ${Else}
    StrCpy $oldStartMenuLink "$SMPROGRAMS\$phase7TransactionMenuDirectory\$oldShortcutName.lnk"
  ${EndIf}

  ${If} $phase7TransactionKeepShortcuts == "0"
    WinShell::UninstAppUserModelId "${APP_ID}"
    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      WinShell::UninstShortcut "$oldDesktopLink"
      ClearErrors
      Delete "$oldDesktopLink"
      !insertmacro phase7ReadPathState "$oldDesktopLink" R5 R0 R1
      ${If} $R5 != "absent"
        Goto phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}
      ${EndIf}
    !endif
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      WinShell::UninstShortcut "$oldStartMenuLink"
      ClearErrors
      Delete "$oldStartMenuLink"
      !insertmacro phase7ReadPathState "$oldStartMenuLink" R5 R0 R1
      ${If} $R5 != "absent"
        Goto phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}
      ${EndIf}
      ${If} $phase7TransactionMenuDirectory != ""
        ClearErrors
        RMDir "$SMPROGRAMS\$phase7TransactionMenuDirectory"
        ClearErrors
      ${EndIf}
    !endif
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
  ${If} $phase7TransactionDeleteAppData == "1"
    !insertmacro phase7DeleteExactAppDataTree "${APP_FILENAME}" R4
    ${If} $R4 != "clean"
      Goto phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}
    ${EndIf}
    !ifdef APP_PRODUCT_FILENAME
      !insertmacro phase7DeleteExactAppDataTree "${APP_PRODUCT_FILENAME}" R4
      ${If} $R4 != "clean"
        Goto phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}
      ${EndIf}
    !endif
    !ifdef APP_PACKAGE_NAME
      !insertmacro phase7DeleteExactAppDataTree "${APP_PACKAGE_NAME}" R4
      ${If} $R4 != "clean"
        Goto phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}
      ${EndIf}
    !endif
  ${EndIf}
  StrCpy $phase7PostCleanupOperationResult "clean"
  phase7_post_cleanup_done_${PHASE7_POST_CLEANUP_ID}:
  StrCpy $${OUTPUT} "$phase7PostCleanupOperationResult"
  ClearErrors
  !undef PHASE7_POST_CLEANUP_ID
!macroend

!macro phase7CompleteCommittedPostCleanup OUTPUT
  StrCpy $phase7PostCleanupResult "pending"
  !insertmacro phase7RunPostCommitCleanup R4
  ${If} $R4 == "clean"
    !insertmacro phase7ClearUninstallTransaction R4
    ${If} $R4 == "cleared"
      StrCpy $phase7PostCleanupResult "clean"
    ${EndIf}
  ${EndIf}
  StrCpy $${OUTPUT} "$phase7PostCleanupResult"
!macroend

!macro phase7RollbackUninstallTransaction OUTPUT
  !define PHASE7_SHARED_ROLLBACK_ID ${__LINE__}
  StrCpy $phase7RollbackResult "failed"
  ${If} $phase7TransactionState == "registry-backups-ready"
    !insertmacro phase7PersistUninstallTransaction "rollback-backups-ready" R6
    ${If} $R6 != "written"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
  ${ElseIf} $phase7TransactionState == "registry-delete-started"
  ${OrIf} $phase7TransactionState == "committed-cleanup"
    !insertmacro phase7PersistUninstallTransaction "rollback-rebuild-ready" R6
    ${If} $R6 != "written"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
  ${ElseIf} $phase7TransactionState != "rollback-backups-ready"
  ${AndIf} $phase7TransactionState != "rollback-rebuild-ready"
  ${AndIf} $phase7TransactionState != "rollback-registry-restored"
  ${AndIf} $phase7TransactionState != "rollback-pending"
    !insertmacro phase7PersistUninstallTransaction "rollback-pending" R6
    ${If} $R6 != "written"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
  ${EndIf}

  !insertmacro phase7ReadPathState "$phase7TransactionSource" R2 R0 R1
  !insertmacro phase7ReadPathState "$phase7TransactionStage" R5 R3 R4
  ${If} $R2 == "error"
  ${OrIf} $R5 == "error"
    Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
  ${EndIf}
  ${If} $R2 == "absent"
    ${If} $R5 != "present"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
    !insertmacro phase7ValidateStableRoot "$phase7TransactionStage"
    StrCpy $INSTDIR "$phase7TransactionSource"
    ClearErrors
    Rename "$phase7TransactionStage" "$phase7TransactionSource"
    ${If} ${Errors}
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
  ${ElseIf} $R5 == "present"
    Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
  ${EndIf}

  !insertmacro phase7ValidateStableRoot "$phase7TransactionSource"
  ${If} $phase7TransactionState == "rollback-rebuild-ready"
    !insertmacro phase7RestoreProductRegistryBackup R4
    ${If} $R4 != "restored-with-backups"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
    !insertmacro phase7AssertRestoredStableRegistryIdentity
    # Do not delete either complete backup until both rebuilt originals and
    # their stable identity are durably checkpointed as authoritative.
    !insertmacro phase7PersistUninstallTransaction "rollback-registry-restored" R4
    ${If} $R4 != "written"
      Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
    ${EndIf}
  ${EndIf}
  !insertmacro phase7AssertRestoredStableRegistryIdentity
  !insertmacro phase7DeleteRollbackRegistryBackups R4
  ${If} $R4 != "clean"
    Goto phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}
  ${EndIf}
  !insertmacro phase7ClearUninstallTransaction R4
  ${If} $R4 == "cleared"
    StrCpy $phase7RollbackResult "restored"
    !insertmacro phase7ReleaseUninstallMutex
  ${EndIf}

  phase7_shared_rollback_done_${PHASE7_SHARED_ROLLBACK_ID}:
  StrCpy $${OUTPUT} "$phase7RollbackResult"
  StrCpy $INSTDIR "$phase7TransactionSource"
  ClearErrors
  !undef PHASE7_SHARED_ROLLBACK_ID
!macroend

!macro phase7RecoverPendingUninstallTransaction
  !define PHASE7_TX_RECOVERY_ID ${__LINE__}
  !insertmacro phase7ReadUninstallTransaction
  ${If} $phase7TransactionPresent == "1"
    !insertmacro phase7ValidateUninstallTransactionPaths
    !insertmacro phase7ReadPathState "$phase7TransactionSource" R2 R0 R1
    !insertmacro phase7ReadPathState "$phase7TransactionStage" R5 R3 R4
    ${If} $R2 == "error"
    ${OrIf} $R5 == "error"
      !insertmacro phase7Fail "Uninstall recovery could not inspect source and staging."
    ${EndIf}

    ${If} $phase7TransactionState == "committed-cleanup"
      ${If} $R2 == "present"
        # A committed state can be visible even when its final readback failed
        # and rollback already renamed staging back to source. Infer only the
        # safe source-present/stage-absent combination and finish rollback.
        ${If} $R5 != "absent"
          !insertmacro phase7Fail "Committed recovery found both source and staging."
        ${EndIf}
        !insertmacro phase7RollbackUninstallTransaction R6
        ${If} $R6 != "restored"
          !insertmacro phase7Fail "Committed rollback recovery could not restore the complete transaction."
        ${EndIf}
      ${Else}
        # Root and registry cleanup advances to a durable post-cleanup state.
        # Shortcut/AppUserModelId/AppData removal is then replayable after a
        # crash and the transaction record is the final committed artifact.
        !insertmacro phase7AdvanceCommittedRootCleanup R6
        ${If} $R6 != "postcleanup-ready"
          !insertmacro phase7Fail "Committed uninstall root cleanup remains pending."
        ${EndIf}
        !insertmacro phase7CompleteCommittedPostCleanup R6
        ${If} $R6 != "clean"
          !insertmacro phase7Fail "Committed uninstall external cleanup remains pending."
        ${EndIf}
        !ifdef BUILD_UNINSTALLER
          SetErrorLevel 0
          Quit
        !else
          !insertmacro phase7ReleaseUninstallMutex
        !endif
      ${EndIf}
    ${ElseIf} $phase7TransactionState == "registry-backups-ready"
    ${OrIf} $phase7TransactionState == "registry-delete-started"
    ${OrIf} $phase7TransactionState == "rollback-backups-ready"
    ${OrIf} $phase7TransactionState == "rollback-rebuild-ready"
    ${OrIf} $phase7TransactionState == "rollback-registry-restored"
      !insertmacro phase7RollbackUninstallTransaction R6
      ${If} $R6 != "restored"
        !insertmacro phase7Fail "Complete registry-backup recovery could not restore the transaction."
      ${EndIf}
    ${ElseIf} $phase7TransactionState == "committed-postcleanup"
      ${If} $R2 != "absent"
        !insertmacro phase7Fail "Post-cleanup recovery found a source root after commit."
      ${EndIf}
      !insertmacro phase7CheckProductRegistryAbsent R6
      ${If} $R6 != "absent"
        !insertmacro phase7Fail "Post-cleanup recovery found a normal product registry key."
      ${EndIf}
      !insertmacro phase7CleanupCommittedStage R6
      ${If} $R6 != "clean"
        !insertmacro phase7Fail "Post-cleanup recovery found unsafe staging residue."
      ${EndIf}
      !insertmacro phase7DeleteCommittedRegistryBackups R6
      ${If} $R6 != "clean"
        !insertmacro phase7Fail "Post-cleanup recovery found registry backup residue."
      ${EndIf}
      !insertmacro phase7CompleteCommittedPostCleanup R6
      ${If} $R6 != "clean"
        !insertmacro phase7Fail "Post-cleanup recovery could not finish external cleanup."
      ${EndIf}
      !ifdef BUILD_UNINSTALLER
        SetErrorLevel 0
        Quit
      !else
        !insertmacro phase7ReleaseUninstallMutex
      !endif
    ${Else}
      !insertmacro phase7RollbackUninstallTransaction R6
      ${If} $R6 != "restored"
        !insertmacro phase7Fail "Uncommitted uninstall recovery could not restore the transaction."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !undef PHASE7_TX_RECOVERY_ID
!macroend

!macro phase7ReadAndVerifyFileMarker MARKER_NAME MARKER_VALUE
  !define PHASE7_MARKER_COMPARE_ID ${__LINE__}
  System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR\${MARKER_NAME}") i.R0'
  ${If} $R0 == -1
    StrCpy $R0 "missing"
  ${Else}
    IntOp $R1 $R0 & 0x410
    ${If} $R1 != 0
      !insertmacro phase7Fail "The installation marker is not a regular file."
    ${EndIf}
    ClearErrors
    FileOpen $R0 "$INSTDIR\${MARKER_NAME}" r
    ${If} ${Errors}
      !insertmacro phase7Fail "The installation marker could not be read."
    ${EndIf}
    FileSeek $R0 0 END $R3
    StrLen $R4 "${MARKER_VALUE}"
    StrCmp $R3 $R4 phase7_marker_size_equal_${PHASE7_MARKER_COMPARE_ID}
    FileClose $R0
    !insertmacro phase7Fail "The installation marker byte length is invalid."
    phase7_marker_size_equal_${PHASE7_MARKER_COMPARE_ID}:
    FileSeek $R0 0 SET
    FileRead $R0 $R1
    FileRead $R0 $R2
    FileClose $R0
    StrCmpS "$R1" "${MARKER_VALUE}" phase7_marker_content_equal_${PHASE7_MARKER_COMPARE_ID}
    !insertmacro phase7Fail "The installation marker identity is invalid."
    phase7_marker_content_equal_${PHASE7_MARKER_COMPARE_ID}:
    StrCmpS "$R2" "" phase7_marker_tail_empty_${PHASE7_MARKER_COMPARE_ID}
    !insertmacro phase7Fail "The installation marker contains unexpected data."
    phase7_marker_tail_empty_${PHASE7_MARKER_COMPARE_ID}:
    # The second FileRead intentionally reaches EOF after the exact-length
    # marker. Do not leak that expected error flag into the next operation.
    ClearErrors
    StrCpy $R0 "valid"
  ${EndIf}
  !undef PHASE7_MARKER_COMPARE_ID
!macroend

!macro phase7ReadAndVerifyMarker
  !insertmacro phase7ReadAndVerifyFileMarker "${PHASE7_INSTALL_MARKER_NAME}" "${PHASE7_INSTALL_MARKER_VALUE}"
!macroend

!macro phase7ReadAndVerifyRecoveryMarker
  !insertmacro phase7ReadAndVerifyFileMarker "${PHASE7_RECOVERY_MARKER_NAME}" "${PHASE7_RECOVERY_MARKER_VALUE}"
!macroend

Function ${PHASE7_COMMITTED_DELETE_FUNCTION}
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  ${If} $phase7StageCleanupPending != "clean"
    Goto phase7_committed_delete_done
  ${EndIf}
  StrCpy $R1 "$phase7TransactionStage"
  ${If} $R0 != ""
    StrCpy $R1 "$phase7TransactionStage\$R0"
  ${EndIf}
  !insertmacro phase7ReadPathState "$R1" R5 R8 R9
  ${If} $R5 != "present"
    StrCpy $phase7StageCleanupPending "cleanup-failed"
    Goto phase7_committed_delete_done
  ${EndIf}
  IntOp $R8 $R8 & 0x410
  ${If} $R8 != 16
    StrCpy $phase7StageCleanupPending "cleanup-failed"
    Goto phase7_committed_delete_done
  ${EndIf}

  !insertmacro phase7FindFirst "$R1\*" R2 R7 R8 R3 R9
  ${If} $R2 == -1
    StrCpy $phase7StageCleanupPending "cleanup-failed"
    Goto phase7_committed_delete_close
  ${EndIf}

  phase7_committed_delete_loop:
    StrCmp $R3 "" phase7_committed_delete_close
    StrCmp $R3 "." phase7_committed_delete_next
    StrCmp $R3 ".." phase7_committed_delete_next
    ${If} $R0 == ""
    ${AndIf} $R3 == "${PHASE7_INSTALL_MARKER_NAME}"
      Goto phase7_committed_delete_next
    ${EndIf}

    StrCpy $R4 "$R3"
    ${If} $R0 != ""
      StrCpy $R4 "$R0\$R3"
    ${EndIf}
    Push "$R4"
    Call ${PHASE7_CLASSIFY_FUNCTION}
    Pop $R5
    ${If} $R5 == ""
      StrCpy $phase7StageCleanupPending "cleanup-failed"
      Goto phase7_committed_delete_close
    ${EndIf}

    StrCpy $R6 "$phase7TransactionStage\$R4"
    System::Call 'KERNEL32::GetFileAttributesW(w R6) i.R8 ?e'
    Pop $R9
    ${If} $R8 == -1
      StrCpy $phase7StageCleanupPending "cleanup-failed"
      Goto phase7_committed_delete_close
    ${EndIf}
    StrCpy $R9 $R8
    IntOp $R8 $R8 & 0x400
    ${If} $R8 != 0
      StrCpy $phase7StageCleanupPending "cleanup-failed"
      Goto phase7_committed_delete_close
    ${EndIf}
    IntOp $R8 $R9 & 0x10
    ${If} $R8 != 0
      ${If} $R5 != "directory"
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_delete_close
      ${EndIf}
      Push "$R4"
      Call ${PHASE7_COMMITTED_DELETE_FUNCTION}
      ${If} $phase7StageCleanupPending != "clean"
        Goto phase7_committed_delete_close
      ${EndIf}
    ${Else}
      ${If} $R5 != "file"
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_delete_close
      ${EndIf}
      ClearErrors
      Delete "$R6"
      ${If} ${Errors}
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_delete_close
      ${EndIf}
      !insertmacro phase7ReadPathState "$R6" R9 R8 R4
      ${If} $R9 != "absent"
        StrCpy $phase7StageCleanupPending "cleanup-failed"
        Goto phase7_committed_delete_close
      ${EndIf}
    ${EndIf}

  phase7_committed_delete_next:
    !insertmacro phase7FindNext R2 R7 R4 R8 R3 R9
    ${If} $R4 == 0
      ${If} $R9 != 18
        StrCpy $phase7StageCleanupPending "cleanup-failed"
      ${EndIf}
      StrCpy $R3 ""
    ${EndIf}
    Goto phase7_committed_delete_loop

  phase7_committed_delete_close:
    !insertmacro phase7FindClose R2 R7
    ClearErrors
    ${If} $phase7StageCleanupPending == "clean"
    ${AndIf} $R0 != ""
      ClearErrors
      RMDir "$R1"
      ${If} ${Errors}
        StrCpy $phase7StageCleanupPending "cleanup-failed"
      ${Else}
        !insertmacro phase7ReadPathState "$R1" R5 R8 R9
        ${If} $R5 != "absent"
          StrCpy $phase7StageCleanupPending "cleanup-failed"
        ${EndIf}
      ${EndIf}
    ${EndIf}

  phase7_committed_delete_done:
    ClearErrors
    Pop $R9
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

Function ${PHASE7_REGISTERED_PATH_FUNCTION}
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  GetFullPathName $R0 "$phase7RegisteredPath"
  GetFullPathName $R1 "$INSTDIR"
  ${If} $R0 == ""
  ${OrIf} $R1 == ""
    !insertmacro phase7Fail "The registered installation path is invalid."
  ${EndIf}
  StrCmp "$R0" "$R1" phase7_registered_path_equal
  !insertmacro phase7Fail "The requested path does not match HKCU InstallLocation."
  phase7_registered_path_equal:
  StrCpy $INSTDIR "$R0"
  StrCpy $phase7RegisteredPath "$R0"
  ${GetFileName} "$INSTDIR" $R2
  StrCmp "$R2" "${APP_FILENAME}" phase7_registered_leaf_equal
  !insertmacro phase7Fail "The registered installation root does not have the exact application directory name."
  phase7_registered_leaf_equal:
  StrCpy $R3 '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /currentuser'
  StrCmp "$phase7RegisteredUninstallString" "$R3" phase7_registered_uninstall_equal
  !insertmacro phase7Fail "HKCU UninstallString does not match the registered installation root."
  phase7_registered_uninstall_equal:
  StrCpy $R3 '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /currentuser /S'
  StrCmp "$phase7RegisteredQuietUninstallString" "$R3" phase7_registered_quiet_uninstall_equal
  !insertmacro phase7Fail "HKCU QuietUninstallString does not match the registered installation root."
  phase7_registered_quiet_uninstall_equal:

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

!macro phase7NormalizeAndMatchRegisteredPath
  Call ${PHASE7_REGISTERED_PATH_FUNCTION}
!macroend

!ifndef BUILD_UNINSTALLER
  Function ${PHASE7_RECOVERY_PATH_FUNCTION}
    Push $R0
    Push $R1
    Push $R2

    GetFullPathName $R0 "$phase7RegisteredPath"
    GetFullPathName $R1 "$INSTDIR"
    ${If} $R0 == ""
    ${OrIf} $R1 == ""
      !insertmacro phase7Fail "The interrupted installation path is invalid."
    ${EndIf}
    StrCmp "$R0" "$R1" phase7_recovery_path_equal
    !insertmacro phase7Fail "The interrupted installation path does not match HKCU InstallLocation."
    phase7_recovery_path_equal:
    StrCpy $INSTDIR "$R0"
    StrCpy $phase7RegisteredPath "$R0"
    ${GetFileName} "$INSTDIR" $R2
    StrCmp "$R2" "${APP_FILENAME}" phase7_recovery_leaf_equal
    !insertmacro phase7Fail "The interrupted installation root does not have the exact application directory name."
    phase7_recovery_leaf_equal:

    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  !macro phase7VerifyRegisteredTarget
    !insertmacro phase7ReadCurrentUserRegistryIdentity
    ${If} $phase7RegisteredPath == ""
    ${OrIf} $phase7RegisteredUninstallString == ""
    ${OrIf} $phase7RegisteredQuietUninstallString == ""
      !insertmacro phase7Fail "The registered CurrentUser installation identity is incomplete."
    ${EndIf}
    !insertmacro phase7AssertRegisteredShortcutRegistry
    !insertmacro phase7NormalizeAndMatchRegisteredPath
    !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
    Push "$INSTDIR"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    !insertmacro phase7RejectReparseTree "$INSTDIR"
    !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
    !insertmacro phase7ReadAndVerifyMarker
    ${If} $R0 == "valid"
      StrCpy $phase7RegisteredKind "phase7-marker"
    ${Else}
      !insertmacro phase7ReadAndVerifyRecoveryMarker
      ${If} $R0 != "valid"
        !insertmacro phase7Fail "The registered installation is not a marked Phase 7 root. Uninstall the pre-Phase 7 build explicitly before installing Phase 7."
      ${EndIf}
      StrCpy $phase7InstallState "recovering"
      StrCpy $phase7RegisteredKind "phase7-recovery"
    ${EndIf}
    !insertmacro phase7ProbeWritableDirectory "$INSTDIR"
  !macroend

  !macro phase7VerifyRecoveringTarget
    !insertmacro phase7ReadCurrentUserRegistryIdentity
    ${If} $phase7RegisteredPath == ""
      !insertmacro phase7Fail "The interrupted CurrentUser InstallLocation is missing."
    ${EndIf}
    !insertmacro phase7AssertRecoveringShortcutRegistry
    !insertmacro phase7AssertRecoveringUninstallRegistry
    Call ${PHASE7_RECOVERY_PATH_FUNCTION}
    !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
    Push "$INSTDIR"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    !insertmacro phase7RejectReparseTree "$INSTDIR"
    !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
    !insertmacro phase7ReadAndVerifyRecoveryMarker
    ${If} $R0 != "valid"
      !insertmacro phase7Fail "The incomplete registry is not bound to a recoverable Phase 7 installation transaction."
    ${EndIf}
    StrCpy $phase7RegisteredKind "phase7-recovery"
    !insertmacro phase7ProbeWritableDirectory "$INSTDIR"
  !macroend

  !macro phase7ValidateFreshTarget
    # This macro is invoked once before and once after the registry-write
    # probe.  Its branch labels therefore must be unique per expansion.
    !define PHASE7_FRESH_TARGET_ID ${__LINE__}
    StrCpy $phase7FreshParentPlan "none"
    StrCpy $phase7FreshParentBasePath ""
    StrCpy $phase7FreshParentPath ""
    StrCpy $phase7FreshParentCreated "0"
    !insertmacro phase7ReadCurrentUserRegistryIdentity
    ${If} $phase7RegisteredPath != ""
    ${OrIf} $phase7RegisteredUninstallString != ""
    ${OrIf} $phase7RegisteredQuietUninstallString != ""
      !insertmacro phase7Fail "The CurrentUser installation registry changed during fresh-install validation."
    ${EndIf}
    !insertmacro phase7AssertFreshShortcutRegistry
    !insertmacro phase7PrepareFreshTarget
    System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR") i.R0'
    ${If} $R0 == -1
      # Validate the existing parent chain now, but do not create the product
      # root until after CHECK_APP_RUNNING and old-version handling.
      ${If} $phase7FreshParentPlan == "create-default-programs"
        !insertmacro phase7AssertDefaultProgramsParentPlan
      ${Else}
        !insertmacro phase7AssertExistingParentBeforeCreate "$INSTDIR"
      ${EndIf}
    ${Else}
      IntOp $R1 $R0 & 0x10
      ${If} $R1 == 0
        !insertmacro phase7Fail "The installation target already exists as a file."
      ${EndIf}
      IntOp $R1 $R0 & 0x400
      ${If} $R1 != 0
        !insertmacro phase7Fail "Reparse points are not accepted as an installation root."
      ${EndIf}
      StrCpy $R3 "empty"
      !insertmacro phase7FindFirst "$INSTDIR\*" R1 R4 R5 R2 R6
      ${If} $R1 == -1
        !insertmacro phase7FindClose R1 R4
        !insertmacro phase7Fail "The installation target could not be inspected."
      ${EndIf}
      phase7_fresh_empty_loop_${PHASE7_FRESH_TARGET_ID}:
        StrCmp $R2 "" phase7_fresh_empty_done_${PHASE7_FRESH_TARGET_ID}
        StrCmp $R2 "." phase7_fresh_empty_next_${PHASE7_FRESH_TARGET_ID}
        StrCmp $R2 ".." phase7_fresh_empty_next_${PHASE7_FRESH_TARGET_ID}
        StrCpy $R3 "nonempty"
        Goto phase7_fresh_empty_done_${PHASE7_FRESH_TARGET_ID}
        phase7_fresh_empty_next_${PHASE7_FRESH_TARGET_ID}:
          !insertmacro phase7FindNext R1 R4 R7 R5 R2 R6
          ${If} $R7 == 0
            ${If} $R6 != 18
              !insertmacro phase7FindClose R1 R4
              !insertmacro phase7Fail "The installation target enumeration failed before reaching normal EOF."
            ${EndIf}
            StrCpy $R2 ""
          ${EndIf}
          Goto phase7_fresh_empty_loop_${PHASE7_FRESH_TARGET_ID}
      phase7_fresh_empty_done_${PHASE7_FRESH_TARGET_ID}:
        !insertmacro phase7FindClose R1 R4
        ClearErrors
        ${If} $R3 == "nonempty"
          # The only non-empty no-registry root that can be resumed is one
          # created by a prior Phase 7 transaction and containing no unknown
          # root entries or reparse points.
          Push "$INSTDIR"
          Call ${PHASE7_ANCESTOR_FUNCTION}
          !insertmacro phase7RejectReparseTree "$INSTDIR"
          !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
          !insertmacro phase7ReadAndVerifyRecoveryMarker
          ${If} $R0 != "valid"
            !insertmacro phase7Fail "Fresh installation requires a nonexistent or empty application directory."
          ${EndIf}
          StrCpy $phase7InstallState "recovering"
          StrCpy $phase7RegisteredKind "phase7-recovery"
        ${EndIf}
    ${EndIf}

    System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR") i.R0'
    ${If} $R0 != -1
      !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
      Push "$INSTDIR"
      Call ${PHASE7_ANCESTOR_FUNCTION}
      !insertmacro phase7ProbeWritableDirectory "$INSTDIR"
    ${Else}
      ${If} $phase7FreshParentPlan == "create-default-programs"
        !insertmacro phase7ProbeWritableDirectory "$phase7FreshParentBasePath"
      ${Else}
        ${GetParent} "$INSTDIR" $R0
        !insertmacro phase7ProbeWritableDirectory "$R0"
      ${EndIf}
    ${EndIf}
    !undef PHASE7_FRESH_TARGET_ID
  !macroend

  !macro phase7ValidateInstallTargetBeforeMutation
    ${If} $phase7InstallState == "fresh"
      !insertmacro phase7ValidateFreshTarget
    ${ElseIf} $phase7InstallState == "registered"
      !insertmacro phase7VerifyRegisteredTarget
    ${ElseIf} $phase7InstallState == "recovering"
      !insertmacro phase7VerifyRecoveringTarget
    ${Else}
      !insertmacro phase7Fail "The installer state is invalid."
    ${EndIf}
  !macroend

  !macro phase7ReadDirectoryHandleIdentity HANDLE OUTPUT_VOLUME OUTPUT_HIGH OUTPUT_LOW OUTPUT
    !define PHASE7_DIRECTORY_IDENTITY_ID ${__LINE__}
    StrCpy $${OUTPUT} "invalid"
    System::Alloc 52
    Pop $R3
    ${If} $R3 == 0
      Goto phase7_directory_identity_done_${PHASE7_DIRECTORY_IDENTITY_ID}
    ${EndIf}
    System::Call 'KERNEL32::GetFileInformationByHandle(p ${HANDLE}, p R3) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
      System::Free $R3
      Goto phase7_directory_identity_done_${PHASE7_DIRECTORY_IDENTITY_ID}
    ${EndIf}
    System::Call '*$R3(i .R4, &v24, i .R5, &v12, i .R6, i .R7)'
    System::Free $R3
    IntOp $R4 $R4 & 0x410
    ${If} $R4 != 16
      Goto phase7_directory_identity_done_${PHASE7_DIRECTORY_IDENTITY_ID}
    ${EndIf}
    StrCpy $${OUTPUT_VOLUME} "$R5"
    StrCpy $${OUTPUT_HIGH} "$R6"
    StrCpy $${OUTPUT_LOW} "$R7"
    StrCpy $${OUTPUT} "valid"
    phase7_directory_identity_done_${PHASE7_DIRECTORY_IDENTITY_ID}:
    ClearErrors
    !undef PHASE7_DIRECTORY_IDENTITY_ID
  !macroend

  !macro phase7SetHandleDeleteDispositionAndClose HANDLE OUTPUT
    !define PHASE7_HANDLE_DELETE_ID ${__LINE__}
    StrCpy $${OUTPUT} "unsafe"
    System::Alloc 4
    Pop $R3
    ${If} $R3 == 0
      System::Call 'KERNEL32::CloseHandle(p ${HANDLE})'
      Goto phase7_handle_delete_done_${PHASE7_HANDLE_DELETE_ID}
    ${EndIf}
    System::Call '*$R3(i 1)'
    System::Call 'KERNEL32::SetFileInformationByHandle(p ${HANDLE}, i 4, p R3, i 1) i.R4 ?e'
    Pop $R9
    System::Free $R3
    ${If} $R4 == 0
      System::Call 'KERNEL32::CloseHandle(p ${HANDLE})'
      Goto phase7_handle_delete_done_${PHASE7_HANDLE_DELETE_ID}
    ${EndIf}
    System::Call 'KERNEL32::CloseHandle(p ${HANDLE}) i.R4'
    ${If} $R4 != 0
      StrCpy $${OUTPUT} "deleted"
    ${EndIf}
    phase7_handle_delete_done_${PHASE7_HANDLE_DELETE_ID}:
    ClearErrors
    !undef PHASE7_HANDLE_DELETE_ID
  !macroend

  !macro phase7CloseHandleVariable HANDLE_VARIABLE OUTPUT
    StrCpy $${OUTPUT} "closed"
    ${If} $${HANDLE_VARIABLE} != -1
      System::Call 'KERNEL32::CloseHandle(p $${HANDLE_VARIABLE}) i.R3'
      ${If} $R3 == 0
        StrCpy $${OUTPUT} "unsafe"
      ${EndIf}
      StrCpy $${HANDLE_VARIABLE} "-1"
    ${EndIf}
    ClearErrors
  !macroend

  !macro phase7OpenExistingDirectoryParent PATH_VALUE OUTPUT
    !define PHASE7_OPEN_PARENT_ID ${__LINE__}
    StrCpy $${OUTPUT} "invalid"
    StrCpy $phase7ExistingParentHandle "-1"
    # Hold the exact existing parent without FILE_SHARE_DELETE. NtCreateFile
    # below resolves its relative child against this pinned directory object.
    System::Call 'KERNEL32::CreateFileW(w "${PATH_VALUE}", i 0x001000A4, i 3, p 0, i 3, i 0x02200000, p 0) p.R0 ?e'
    Pop $R9
    ${If} $R0 == -1
      Goto phase7_open_parent_done_${PHASE7_OPEN_PARENT_ID}
    ${EndIf}
    StrCpy $phase7ExistingParentHandle "$R0"
    System::Alloc 52
    Pop $R3
    ${If} $R3 == 0
      !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R8
      Goto phase7_open_parent_done_${PHASE7_OPEN_PARENT_ID}
    ${EndIf}
    System::Call 'KERNEL32::GetFileInformationByHandle(p $phase7ExistingParentHandle, p R3) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
      System::Free $R3
      !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R8
      Goto phase7_open_parent_done_${PHASE7_OPEN_PARENT_ID}
    ${EndIf}
    System::Call '*$R3(i .R4)'
    System::Free $R3
    IntOp $R4 $R4 & 0x410
    ${If} $R4 != 16
      !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R8
      Goto phase7_open_parent_done_${PHASE7_OPEN_PARENT_ID}
    ${EndIf}
    StrCpy $${OUTPUT} "valid"
    phase7_open_parent_done_${PHASE7_OPEN_PARENT_ID}:
    ClearErrors
    !undef PHASE7_OPEN_PARENT_ID
  !macroend

  !macro phase7CreateOwnedDirectoryAtParent PARENT_HANDLE LEAF_NAME HANDLE_VARIABLE OUTPUT_VOLUME OUTPUT_HIGH OUTPUT_LOW OUTPUT
    !define PHASE7_ATOMIC_DIRECTORY_CREATE_ID ${__LINE__}
    StrCpy $${OUTPUT} "failed"
    StrCpy $${HANDLE_VARIABLE} "-1"
    StrLen $R3 "${LEAF_NAME}"
    ${If} $R3 == 0
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    IntOp $R5 $R3 * 2
    IntOp $R6 $R5 + 2
    System::Call '*(&w${NSIS_MAX_STRLEN} "${LEAF_NAME}") p.R4'
    ${If} $R4 == 0
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    System::Call '*(h R5, h R6, p R4) p.R7'
    ${If} $R7 == 0
      System::Free $R4
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    # electron-builder's Unicode NSIS executable is 32-bit. OBJECT_ATTRIBUTES
    # is therefore the documented 24-byte layout.
    System::Call '*(i 24, p ${PARENT_HANDLE}, p R7, i 0x40, p 0, p 0) p.R8'
    ${If} $R8 == 0
      System::Free $R7
      System::Free $R4
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    System::Call '*(p 0, p 0) p.R9'
    ${If} $R9 == 0
      System::Free $R8
      System::Free $R7
      System::Free $R4
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    System::Alloc 4
    Pop $R2
    ${If} $R2 == 0
      System::Free $R9
      System::Free $R8
      System::Free $R7
      System::Free $R4
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    System::Call '*$R2(p -1)'
    # FILE_CREATE + FILE_DIRECTORY_FILE atomically creates the relative leaf
    # and returns its DELETE-capable, no-delete-share identity handle.
    System::Call 'ntdll::NtCreateFile(p R2, i 0x001100A4, p R8, p R9, p 0, i 0x10, i 3, i 2, i 0x00200021, p 0, i 0) i.R1'
    System::Call '*$R2(p .R0)'
    System::Free $R2
    System::Free $R9
    System::Free $R8
    System::Free $R7
    System::Free $R4
    ${If} $R1 != 0
    ${OrIf} $R0 == -1
    ${OrIf} $R0 == 0
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    StrCpy $${HANDLE_VARIABLE} "$R0"
    !insertmacro phase7ReadDirectoryHandleIdentity $R0 ${OUTPUT_VOLUME} ${OUTPUT_HIGH} ${OUTPUT_LOW} R8
    ${If} $R8 != "valid"
      !insertmacro phase7SetHandleDeleteDispositionAndClose $R0 R8
      StrCpy $${HANDLE_VARIABLE} "-1"
      Goto phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}
    ${EndIf}
    StrCpy $${OUTPUT} "created"
    phase7_atomic_directory_create_done_${PHASE7_ATOMIC_DIRECTORY_CREATE_ID}:
    ClearErrors
    !undef PHASE7_ATOMIC_DIRECTORY_CREATE_ID
  !macroend

  !macro phase7DeleteIdentityBoundCreatedDirectory HANDLE_VARIABLE EXPECTED_VOLUME EXPECTED_HIGH EXPECTED_LOW OUTPUT
    !define PHASE7_IDENTITY_DELETE_ID ${__LINE__}
    StrCpy $${OUTPUT} "unsafe"
    ${If} $${HANDLE_VARIABLE} == -1
      Goto phase7_identity_delete_done_${PHASE7_IDENTITY_DELETE_ID}
    ${EndIf}
    System::Alloc 52
    Pop $R3
    ${If} $R3 == 0
      !insertmacro phase7CloseHandleVariable ${HANDLE_VARIABLE} R8
      Goto phase7_identity_delete_done_${PHASE7_IDENTITY_DELETE_ID}
    ${EndIf}
    System::Call 'KERNEL32::GetFileInformationByHandle(p $${HANDLE_VARIABLE}, p R3) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
      System::Free $R3
      !insertmacro phase7CloseHandleVariable ${HANDLE_VARIABLE} R8
      Goto phase7_identity_delete_done_${PHASE7_IDENTITY_DELETE_ID}
    ${EndIf}
    System::Call '*$R3(i .R4, &v24, i .R5, &v12, i .R6, i .R7)'
    System::Free $R3
    IntOp $R4 $R4 & 0x410
    ${If} $R4 != 16
    ${OrIf} $R5 != $${EXPECTED_VOLUME}
    ${OrIf} $R6 != $${EXPECTED_HIGH}
    ${OrIf} $R7 != $${EXPECTED_LOW}
      !insertmacro phase7CloseHandleVariable ${HANDLE_VARIABLE} R8
      Goto phase7_identity_delete_done_${PHASE7_IDENTITY_DELETE_ID}
    ${EndIf}
    !insertmacro phase7SetHandleDeleteDispositionAndClose $${HANDLE_VARIABLE} R8
    StrCpy $${HANDLE_VARIABLE} "-1"
    StrCpy $${OUTPUT} "$R8"
    phase7_identity_delete_done_${PHASE7_IDENTITY_DELETE_ID}:
    ClearErrors
    !undef PHASE7_IDENTITY_DELETE_ID
  !macroend

  !macro phase7VerifyMarkerHandle HANDLE MARKER_VALUE OUTPUT
    !define PHASE7_MARKER_HANDLE_VERIFY_ID ${__LINE__}
    StrCpy $${OUTPUT} "invalid"
    ${If} ${HANDLE} == -1
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Alloc 52
    Pop $R3
    ${If} $R3 == 0
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Call 'KERNEL32::GetFileInformationByHandle(p ${HANDLE}, p R3) i.R4 ?e'
    Pop $R9
    ${If} $R4 == 0
      System::Free $R3
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Call '*$R3(i .R4, &v24, i .R5, &v8, i .R6, i .R7, i .R8)'
    System::Free $R3
    IntOp $R4 $R4 & 0x410
    ${If} $R4 != 0
    ${OrIf} $R6 != 1
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    StrLen $R4 "${MARKER_VALUE}"
    System::Call 'KERNEL32::GetFileSize(p ${HANDLE}, *i .R6) i.R5 ?e'
    Pop $R9
    ${If} $R5 == -1
    ${AndIf} $R9 != 0
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    ${If} $R6 != 0
    ${OrIf} $R5 != $R4
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Call 'KERNEL32::SetFilePointer(p ${HANDLE}, i 0, p 0, i 0) i.R5 ?e'
    Pop $R9
    ${If} $R5 != 0
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Alloc ${NSIS_MAX_STRLEN}
    Pop $R3
    ${If} $R3 == 0
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    IntOp $R5 $R3 + $R4
    System::Call '*$R5(b 0)'
    System::Call 'KERNEL32::ReadFile(p ${HANDLE}, p R3, i R4, *i .R5, p 0) i.R6 ?e'
    Pop $R9
    ${If} $R6 == 0
    ${OrIf} $R5 != $R4
      System::Free $R3
      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    ${EndIf}
    System::Call '*$R3(&m${NSIS_MAX_STRLEN} .R6)'
    System::Free $R3
    StrCmpS "$R6" "${MARKER_VALUE}" 0 phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}
    StrCpy $${OUTPUT} "valid"
    phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}:
    ClearErrors
    !undef PHASE7_MARKER_HANDLE_VERIFY_ID
  !macroend

  !macro phase7AbortStableMarker MESSAGE
    ${If} $phase7StableMarkerHandle == -1
      !insertmacro phase7Fail "${MESSAGE}"
    ${EndIf}
    ${If} $phase7StableMarkerCreated == "1"
      # This exact handle came from OPEN_ALWAYS with last-error zero. Delete
      # only that newly-created marker; never reopen or delete its pathname.
      !insertmacro phase7SetHandleDeleteDispositionAndClose $phase7StableMarkerHandle R8
      StrCpy $phase7StableMarkerHandle "-1"
      StrCpy $phase7StableMarkerCreated "0"
      ${If} $R8 != "deleted"
        !insertmacro phase7Fail "The owned stable installation marker could not be cleaned by handle."
      ${EndIf}
    ${Else}
      !insertmacro phase7CloseHandleVariable phase7StableMarkerHandle R8
      ${If} $R8 != "closed"
        !insertmacro phase7Fail "The existing stable installation marker handle could not be closed."
      ${EndIf}
    ${EndIf}
    !insertmacro phase7Fail "${MESSAGE}"
  !macroend

  !macro phase7WriteFileMarker MARKER_NAME MARKER_VALUE
    StrCpy $phase7StableMarkerCreated "0"
    StrCpy $phase7StableMarkerHandle "-1"
    ClearErrors
    # OPEN_ALWAYS returns one exclusive identity handle for either the already
    # verified registered marker or a newly-created marker. Existing bytes are
    # never truncated; new-marker failures use only this handle for rollback.
    System::Call 'KERNEL32::CreateFileW(w "$INSTDIR\${MARKER_NAME}", i 0xC0010000, i 0, p 0, i 4, i 0x00200080, p 0) p.R0 ?e'
    Pop $R9
    ${If} $R0 == -1
      !insertmacro phase7Fail "The stable installation marker could not be opened exclusively."
    ${EndIf}
    StrCpy $phase7StableMarkerHandle "$R0"
    ${If} $R9 == 0
      StrCpy $phase7StableMarkerCreated "1"
      StrLen $R4 "${MARKER_VALUE}"
      System::Call 'KERNEL32::WriteFile(p $phase7StableMarkerHandle, m "${MARKER_VALUE}", i R4, *i .R1, p 0) i.R2 ?e'
      Pop $R9
      ${If} $R2 == 0
        !insertmacro phase7AbortStableMarker "The stable installation marker could not be written."
      ${EndIf}
      ${If} $R1 != $R4
        !insertmacro phase7AbortStableMarker "The stable installation marker write was incomplete."
      ${EndIf}
      System::Call 'KERNEL32::FlushFileBuffers(p $phase7StableMarkerHandle) i.R2 ?e'
      Pop $R9
      ${If} $R2 == 0
        !insertmacro phase7AbortStableMarker "The stable installation marker could not be flushed."
      ${EndIf}
    ${ElseIf} $R9 != 183
      !insertmacro phase7AbortStableMarker "The stable installation marker open result was ambiguous."
    ${EndIf}
    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle "${MARKER_VALUE}" R2
    ${If} $R2 != "valid"
      !insertmacro phase7AbortStableMarker "The stable installation marker handle identity is invalid."
    ${EndIf}
    ClearErrors
  !macroend

  !macro phase7CleanupCreatedFreshDirectories
    # Any existing-parent lease is non-owned. Release it before rolling back
    # only the exact directories returned by NtCreateFile.
    !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R9
    ${If} $phase7FreshRootCreated == "1"
      !insertmacro phase7DeleteIdentityBoundCreatedDirectory phase7FreshRootHandle phase7FreshRootVolumeSerial phase7FreshRootFileIndexHigh phase7FreshRootFileIndexLow R9
      ${If} $R9 == "deleted"
        StrCpy $phase7FreshRootCreated "0"
      ${EndIf}
    ${EndIf}

    ${If} $phase7FreshParentCreated == "1"
    ${AndIf} $phase7FreshRootCreated == "0"
    ${AndIf} $phase7FreshParentPlan == "create-default-programs"
      !insertmacro phase7DeleteIdentityBoundCreatedDirectory phase7FreshParentHandle phase7FreshParentVolumeSerial phase7FreshParentFileIndexHigh phase7FreshParentFileIndexLow R9
      ${If} $R9 == "deleted"
        StrCpy $phase7FreshParentCreated "0"
      ${EndIf}
    ${EndIf}
    ClearErrors
  !macroend

  !macro phase7ReleaseCreatedFreshDirectoryHandles
    !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R9
    ${If} $R9 != "closed"
      !insertmacro phase7Fail "The existing installation parent lease could not be released safely."
    ${EndIf}
    !insertmacro phase7CloseHandleVariable phase7FreshRootHandle R9
    ${If} $R9 != "closed"
      !insertmacro phase7Fail "The created installation root identity handle could not be released safely."
    ${EndIf}
    !insertmacro phase7CloseHandleVariable phase7FreshParentHandle R9
    ${If} $R9 != "closed"
      !insertmacro phase7Fail "The created installation parent identity handle could not be released safely."
    ${EndIf}
    # The durable, still-open recovery marker now owns interruption recovery.
    StrCpy $phase7FreshRootCreated "0"
    StrCpy $phase7FreshParentCreated "0"
    ClearErrors
  !macroend

  !macro phase7FailTransactionPreparation MESSAGE
    !insertmacro phase7CleanupCreatedFreshDirectories
    !insertmacro phase7Fail "${MESSAGE}"
  !macroend

  !macro phase7FailRecoveryMarkerPreparation MESSAGE
    ${If} $phase7RecoveryMarkerOwned != "0"
      !insertmacro phase7Fail "The owned installation recovery marker handle was not released safely."
    ${EndIf}
    !insertmacro phase7CleanupCreatedFreshDirectories
    !insertmacro phase7Fail "${MESSAGE}"
  !macroend

  !macro phase7AbortOwnedRecoveryMarker MESSAGE
    # The marker was returned by CREATE_NEW and is still held exclusively.
    # Failure cleanup acts only on that exact handle.
    !insertmacro phase7SetHandleDeleteDispositionAndClose $phase7RecoveryMarkerHandle R8
    StrCpy $phase7RecoveryMarkerHandle "-1"
    StrCpy $phase7RecoveryMarkerOwned "0"
    ${If} $R8 != "deleted"
      !insertmacro phase7Fail "The owned installation recovery marker could not be cleaned by handle."
    ${EndIf}
    !insertmacro phase7FailRecoveryMarkerPreparation "${MESSAGE}"
  !macroend

  !macro phase7WriteRecoveryMarkerForPreparation
    StrCpy $phase7RecoveryMarkerOwned "0"
    StrCpy $phase7RecoveryMarkerHandle "-1"
    ClearErrors
    # CREATE_NEW plus shareMode=0 proves this process created the exact marker.
    # Failures set FileDispositionInfo on this still-exclusive handle; no
    # failure path deletes a marker by pathname.
    System::Call 'KERNEL32::CreateFileW(w "$INSTDIR\${PHASE7_RECOVERY_MARKER_NAME}", i 0xC0010000, i 0, p 0, i 1, i 0x00200080, p 0) p.R0 ?e'
    Pop $R9
    ${If} $R0 == -1
      !insertmacro phase7FailRecoveryMarkerPreparation "The installation recovery marker could not be created exclusively."
    ${EndIf}
    StrCpy $phase7RecoveryMarkerHandle "$R0"
    StrCpy $phase7RecoveryMarkerOwned "1"

    StrLen $R4 "${PHASE7_RECOVERY_MARKER_VALUE}"
    System::Call 'KERNEL32::WriteFile(p $phase7RecoveryMarkerHandle, m "${PHASE7_RECOVERY_MARKER_VALUE}", i R4, *i .R1, p 0) i.R2 ?e'
    Pop $R9
    ${If} $R2 == 0
      !insertmacro phase7AbortOwnedRecoveryMarker "The installation recovery marker could not be written."
    ${EndIf}
    ${If} $R1 != $R4
      !insertmacro phase7AbortOwnedRecoveryMarker "The installation recovery marker write was incomplete."
    ${EndIf}
    System::Call 'KERNEL32::FlushFileBuffers(p $phase7RecoveryMarkerHandle) i.R2 ?e'
    Pop $R9
    ${If} $R2 == 0
      !insertmacro phase7AbortOwnedRecoveryMarker "The installation recovery marker could not be flushed."
    ${EndIf}

    !insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle "${PHASE7_RECOVERY_MARKER_VALUE}" R2
    ${If} $R2 != "valid"
      # The marker is still exclusively owned, so cleanup remains identity
      # bound even when durable readback fails.
      !insertmacro phase7AbortOwnedRecoveryMarker "The committed installation recovery marker verification failed."
    ${EndIf}
    ClearErrors
  !macroend

  !macro phase7OpenRecoveryMarkerForTransaction
    StrCpy $phase7RecoveryMarkerOwned "0"
    StrCpy $phase7RecoveryMarkerHandle "-1"
    # Recovery starts by pinning the already-verified marker. DELETE access is
    # retained so final commit can remove this same object without reopening it.
    System::Call 'KERNEL32::CreateFileW(w "$INSTDIR\${PHASE7_RECOVERY_MARKER_NAME}", i 0x80010000, i 0, p 0, i 3, i 0x00200080, p 0) p.R0 ?e'
    Pop $R9
    ${If} $R0 == -1
      !insertmacro phase7Fail "The existing installation recovery marker could not be leased exclusively."
    ${EndIf}
    StrCpy $phase7RecoveryMarkerHandle "$R0"
    !insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle "${PHASE7_RECOVERY_MARKER_VALUE}" R2
    ${If} $R2 != "valid"
      !insertmacro phase7CloseHandleVariable phase7RecoveryMarkerHandle R8
      !insertmacro phase7Fail "The committed installation recovery marker verification failed."
    ${EndIf}
    ClearErrors
  !macroend

  !macro phase7EnsureTransactionRoot
    StrCpy $phase7FreshRootCreated "0"
    StrCpy $phase7FreshParentCreated "0"
    StrCpy $phase7FreshRootHandle "-1"
    StrCpy $phase7FreshRootVolumeSerial ""
    StrCpy $phase7FreshRootFileIndexHigh ""
    StrCpy $phase7FreshRootFileIndexLow ""
    StrCpy $phase7FreshParentHandle "-1"
    StrCpy $phase7FreshParentVolumeSerial ""
    StrCpy $phase7FreshParentFileIndexHigh ""
    StrCpy $phase7FreshParentFileIndexLow ""
    StrCpy $phase7ExistingParentHandle "-1"
    System::Call 'KERNEL32::GetFileAttributesW(w "$INSTDIR") i.R0'
    ${If} $R0 == -1
      ${If} $phase7FreshParentPlan == "create-default-programs"
        # Pin LocalAppData, then atomically create its exact relative Programs
        # child and retain the returned identity handle.
        !insertmacro phase7AssertDefaultProgramsParentPlan
        !insertmacro phase7OpenExistingDirectoryParent "$phase7FreshParentBasePath" R8
        ${If} $R8 != "valid"
          !insertmacro phase7FailTransactionPreparation "The default installation base could not be leased safely."
        ${EndIf}
        !insertmacro phase7CreateOwnedDirectoryAtParent $phase7ExistingParentHandle "Programs" phase7FreshParentHandle phase7FreshParentVolumeSerial phase7FreshParentFileIndexHigh phase7FreshParentFileIndexLow R8
        !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R9
        ${If} $R8 != "created"
          !insertmacro phase7FailTransactionPreparation "The default installation parent could not be created atomically."
        ${EndIf}
        StrCpy $phase7FreshParentCreated "1"
        ${If} $R9 != "closed"
          !insertmacro phase7FailTransactionPreparation "The default installation base lease could not be released safely."
        ${EndIf}
      ${Else}
        !insertmacro phase7AssertExistingParentBeforeCreate "$INSTDIR"
        ${GetParent} "$INSTDIR" $R2
        !insertmacro phase7OpenExistingDirectoryParent "$R2" R8
        ${If} $R8 != "valid"
          !insertmacro phase7FailTransactionPreparation "The selected installation parent could not be leased safely."
        ${EndIf}
      ${EndIf}
      ${If} $phase7FreshParentCreated == "1"
        !insertmacro phase7CreateOwnedDirectoryAtParent $phase7FreshParentHandle "${APP_FILENAME}" phase7FreshRootHandle phase7FreshRootVolumeSerial phase7FreshRootFileIndexHigh phase7FreshRootFileIndexLow R8
      ${Else}
        !insertmacro phase7CreateOwnedDirectoryAtParent $phase7ExistingParentHandle "${APP_FILENAME}" phase7FreshRootHandle phase7FreshRootVolumeSerial phase7FreshRootFileIndexHigh phase7FreshRootFileIndexLow R8
        ${If} $R8 == "created"
          StrCpy $phase7FreshRootCreated "1"
        ${EndIf}
        !insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R9
        ${If} $R9 != "closed"
          !insertmacro phase7FailTransactionPreparation "The selected installation parent lease could not be released safely."
        ${EndIf}
      ${EndIf}
      ${If} $R8 != "created"
        !insertmacro phase7FailTransactionPreparation "The selected installation directory could not be created atomically."
      ${EndIf}
      StrCpy $phase7FreshRootCreated "1"
    ${Else}
      !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
      ${If} $phase7InstallState == "recovering"
        !insertmacro phase7RejectReparseTree "$INSTDIR"
        !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
        !insertmacro phase7ReadAndVerifyRecoveryMarker
        ${If} $R0 != "valid"
          !insertmacro phase7Fail "The interrupted installation transaction changed before recovery."
        ${EndIf}
      ${Else}
        !insertmacro phase7FindFirst "$INSTDIR\*" R1 R3 R4 R2 R5
        ${If} $R1 == -1
          !insertmacro phase7FindClose R1 R3
          !insertmacro phase7Fail "The installation target could not be re-inspected."
        ${EndIf}
        phase7_transaction_empty_loop:
          StrCmp $R2 "" phase7_transaction_empty_done
          StrCmp $R2 "." phase7_transaction_empty_next
          StrCmp $R2 ".." phase7_transaction_empty_next
          !insertmacro phase7FindClose R1 R3
          !insertmacro phase7Fail "The installation target changed before the transaction began."
        phase7_transaction_empty_next:
          !insertmacro phase7FindNext R1 R3 R6 R4 R2 R5
          ${If} $R6 == 0
            ${If} $R5 != 18
              !insertmacro phase7FindClose R1 R3
              !insertmacro phase7Fail "The installation target re-enumeration failed before reaching normal EOF."
            ${EndIf}
            StrCpy $R2 ""
          ${EndIf}
          Goto phase7_transaction_empty_loop
        phase7_transaction_empty_done:
          !insertmacro phase7FindClose R1 R3
          ClearErrors
      ${EndIf}
    ${EndIf}

    !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
    Push "$INSTDIR"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    ClearErrors
  !macroend

  !macro phase7BeginInstallTransaction
    !insertmacro phase7EnsureTransactionRoot
    ${If} $phase7InstallState == "recovering"
      # A recovery root already carried and passed the stable recovery identity
      # before CHECK_APP_RUNNING. Pin that exact marker through final commit.
      !insertmacro phase7OpenRecoveryMarkerForTransaction
    ${Else}
      !insertmacro phase7WriteRecoveryMarkerForPreparation
    ${EndIf}
    !insertmacro phase7ReleaseCreatedFreshDirectoryHandles
    # Persist the custom-volume recovery pointer before application extraction.
    # A later interruption is therefore bound back to this exact Phase 7 root.
    ClearErrors
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
    ${If} ${Errors}
      # The committed marker is now the only durable recovery identity. Keep
      # the root intact; a later fresh rerun can validate the marker and resume.
      !insertmacro phase7Fail "The Phase 7 installation recovery path could not be written."
    ${EndIf}
    ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    System::Call 'KERNEL32::lstrcmpW(w R1, w "$INSTDIR") i.R2'
    ${If} $R2 != 0
      !insertmacro phase7Fail "The Phase 7 installation recovery path could not be verified."
    ${EndIf}
  !macroend

  !macro phase7WriteInstallMarker
    !insertmacro phase7WriteFileMarker "${PHASE7_INSTALL_MARKER_NAME}" "${PHASE7_INSTALL_MARKER_VALUE}"
    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle "${PHASE7_INSTALL_MARKER_VALUE}" R0
    ${If} $R0 != "valid"
      !insertmacro phase7AbortStableMarker "The installation marker verification failed."
    ${EndIf}
  !macroend

  !macro phase7VerifyInstalledIdentity
    !insertmacro phase7ReadCurrentUserRegistryIdentity
    ${If} $phase7RegisteredPath == ""
    ${OrIf} $phase7RegisteredUninstallString == ""
    ${OrIf} $phase7RegisteredQuietUninstallString == ""
      !insertmacro phase7Fail "The CurrentUser installation registry was not committed."
    ${EndIf}
    !insertmacro phase7AssertRegisteredShortcutRegistry
    !insertmacro phase7NormalizeAndMatchRegisteredPath
    !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
    Push "$INSTDIR"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    !insertmacro phase7RejectReparseTree "$INSTDIR"
    !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
    !insertmacro phase7AssertRequiredDirectory "locales"
    !insertmacro phase7AssertRequiredDirectory "resources"
    !insertmacro phase7AssertRequiredDirectory "resources\selection-host"
    !insertmacro phase7AssertRequiredDirectory "resources\migrations"
    !insertmacro phase7AssertRequiredDirectory "resources\licenses"
    !insertmacro phase7AssertRequiredDirectory "resources\supply-chain"
    !insertmacro phase7AssertRequiredDirectory "resources\manifest"
    !insertmacro phase7AssertRequiredNonEmptyFile "${APP_EXECUTABLE_FILENAME}"
    !insertmacro phase7AssertRequiredNonEmptyFile "${UNINSTALL_FILENAME}"
    !insertmacro phase7AssertRequiredNonEmptyFile "chrome_100_percent.pak"
    !insertmacro phase7AssertRequiredNonEmptyFile "chrome_200_percent.pak"
    !insertmacro phase7AssertRequiredNonEmptyFile "d3dcompiler_47.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "dxcompiler.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "dxil.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "ffmpeg.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "icudtl.dat"
    !insertmacro phase7AssertRequiredNonEmptyFile "libEGL.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "libGLESv2.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "LICENSE.electron.txt"
    !insertmacro phase7AssertRequiredNonEmptyFile "LICENSES.chromium.html"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources.pak"
    !insertmacro phase7AssertRequiredNonEmptyFile "snapshot_blob.bin"
    !insertmacro phase7AssertRequiredNonEmptyFile "v8_context_snapshot.bin"
    !insertmacro phase7AssertRequiredNonEmptyFile "version"
    !insertmacro phase7AssertRequiredNonEmptyFile "vk_swiftshader.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "vk_swiftshader_icd.json"
    !insertmacro phase7AssertRequiredNonEmptyFile "vulkan-1.dll"
    !insertmacro phase7AssertRequiredNonEmptyFile "locales\en-US.pak"
    !insertmacro phase7AssertRequiredNonEmptyFile "locales\zh-CN.pak"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\app.asar"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\selection-host\selection-host.exe"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\migrations\0001_initial.sql"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\licenses\THIRD_PARTY_NOTICES.txt"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\licenses\ELECTRON_LICENSE.txt"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\licenses\LICENSES.chromium.html"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\supply-chain\sbom.cdx.json"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\manifest\product-manifest.json"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\manifest\component-manifest.json"
    !insertmacro phase7AssertRequiredNonEmptyFile "resources\manifest\file-manifest.sha256"
    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle "${PHASE7_INSTALL_MARKER_VALUE}" R0
    ${If} $R0 != "valid"
      !insertmacro phase7Fail "The committed installation marker is invalid."
    ${EndIf}
    !insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle "${PHASE7_RECOVERY_MARKER_VALUE}" R0
    ${If} $R0 != "valid"
      !insertmacro phase7Fail "The committed installation recovery marker is invalid."
    ${EndIf}
  !macroend

  !macro phase7CommitInstallTransaction
    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle "${PHASE7_INSTALL_MARKER_VALUE}" R2
    ${If} $R2 != "valid"
      !insertmacro phase7Fail "The stable installation marker changed before transaction commit."
    ${EndIf}
    !insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle "${PHASE7_RECOVERY_MARKER_VALUE}" R2
    ${If} $R2 != "valid"
      !insertmacro phase7Fail "The recovery installation marker changed before transaction commit."
    ${EndIf}
    # Delete the exact recovery marker pinned at transaction start. There is no
    # FileExists/open/Delete pathname interval.
    !insertmacro phase7SetHandleDeleteDispositionAndClose $phase7RecoveryMarkerHandle R8
    StrCpy $phase7RecoveryMarkerHandle "-1"
    StrCpy $phase7RecoveryMarkerOwned "0"
    ${If} $R8 != "deleted"
      !insertmacro phase7Fail "The installation transaction recovery marker could not be committed by handle."
    ${EndIf}
    !insertmacro phase7CloseHandleVariable phase7StableMarkerHandle R8
    StrCpy $phase7StableMarkerCreated "0"
    ${If} $R8 != "closed"
      !insertmacro phase7Fail "The stable installation marker commit handle could not be closed safely."
    ${EndIf}
    ClearErrors
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro phase7VerifyUninstallRoot
    !insertmacro phase7ReadCurrentUserRegistryIdentity
    ${If} $phase7RegisteredPath == ""
      !insertmacro phase7Fail "HKCU InstallLocation is missing. Uninstall was refused."
    ${EndIf}
    ${If} $phase7RegisteredUninstallString == ""
      !insertmacro phase7Fail "HKCU UninstallString is missing. Uninstall was refused."
    ${EndIf}
    ${If} $phase7RegisteredQuietUninstallString == ""
      !insertmacro phase7Fail "HKCU QuietUninstallString is missing. Uninstall was refused."
    ${EndIf}
    !insertmacro phase7AssertRegisteredShortcutRegistry
    !insertmacro phase7NormalizeAndMatchRegisteredPath
    !insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"
    Push "$INSTDIR"
    Call ${PHASE7_ANCESTOR_FUNCTION}
    !insertmacro phase7RejectReparseTree "$INSTDIR"
    !insertmacro phase7AssertKnownRootEntries "$INSTDIR"
    !insertmacro phase7ReadAndVerifyMarker
    ${If} $R0 != "valid"
      !insertmacro phase7Fail "The stable installation marker is missing. Uninstall was refused."
    ${EndIf}
    StrCpy $phase7UninstallVerified "1"
  !macroend

  !macro customUnInit
    !insertmacro phase7VerifyUninstallRoot
  !macroend

  !macro phase7AssertUninstallerOutsideRoot
    System::Call 'KERNEL32::GetModuleFileNameW(p 0, w .R0, i ${NSIS_MAX_STRLEN}) i.R1'
    ${If} $R1 == 0
      !insertmacro phase7Fail "The running uninstaller image path could not be inspected."
    ${ElseIf} $R1 >= ${NSIS_MAX_STRLEN}
      !insertmacro phase7Fail "The running uninstaller image path was truncated."
    ${EndIf}
    GetFullPathName $R0 "$R0"
    ${If} $R0 == ""
      !insertmacro phase7Fail "The running uninstaller image path is invalid."
    ${EndIf}
    GetFullPathName $R1 "$INSTDIR"
    ${If} $R1 == ""
      !insertmacro phase7Fail "The uninstall root path is invalid."
    ${EndIf}
    System::Call 'KERNEL32::GetLongPathNameW(w R0, w .R2, i ${NSIS_MAX_STRLEN}) i.R3'
    ${If} $R3 == 0
    ${OrIf} $R3 >= ${NSIS_MAX_STRLEN}
      !insertmacro phase7Fail "The running uninstaller long path could not be resolved safely."
    ${EndIf}
    System::Call 'KERNEL32::GetLongPathNameW(w R1, w .R4, i ${NSIS_MAX_STRLEN}) i.R3'
    ${If} $R3 == 0
    ${OrIf} $R3 >= ${NSIS_MAX_STRLEN}
      !insertmacro phase7Fail "The uninstall root long path could not be resolved safely."
    ${EndIf}
    StrLen $R1 "$R4"
    StrCpy $R0 "$R2" $R1
    System::Call 'KERNEL32::lstrcmpiW(w R0, w R4) i.R3'
    ${If} $R3 == 0
      StrCpy $R0 "$R2" 1 $R1
      ${If} $R0 == "\"
      ${OrIf} $R0 == ""
        !insertmacro phase7Fail "The uninstaller must run from its verified temporary copy before the application root can be staged."
      ${EndIf}
    ${EndIf}
  !macroend

  !macro phase7PrepareAtomicRootStage
    ${If} $phase7UninstallVerified != "1"
      !insertmacro phase7Fail "The installation root was not verified. Atomic staging was refused."
    ${EndIf}
    !insertmacro phase7AssertUninstallerOutsideRoot
    !insertmacro phase7AcquireUninstallMutex
    !insertmacro phase7ProbeRegistryWritable
    # The probe touched only owned sibling scratch keys. Re-read the complete
    # identity while the lifecycle mutex is held so a concurrent change cannot
    # turn the earlier customUnInit snapshot into a destructive action.
    !insertmacro phase7VerifyUninstallRoot

    # customUnInit pinned and normalized this exact registered identity. Keep
    # the transaction source bound to that dedicated value rather than to any
    # later mutable use of INSTDIR.
    GetFullPathName $phase7TransactionSource "$phase7RegisteredPath"
    ${GetParent} "$phase7TransactionSource" $R0
    ${If} $R0 == ""
      !insertmacro phase7Fail "The installation parent directory is invalid."
    ${EndIf}
    StrLen $R3 "$R0"
    ${If} $R3 == 2
      StrCpy $R4 "$R0" 1 1
      ${If} $R4 == ":"
        StrCpy $R0 "$R0\"
      ${EndIf}
    ${EndIf}
    GetFullPathName $R3 "$R0"
    ${If} $R3 == ""
      !insertmacro phase7Fail "The installation parent directory could not be normalized."
    ${EndIf}
    System::Call 'KERNEL32::GetCurrentProcessId() i.R1'
    System::Call 'KERNEL32::GetTickCount() i.R2'
    StrCpy $R0 "$R3" 1 -1
    ${If} $R0 == "\"
      StrCpy $phase7TransactionStage "$R3${PHASE7_STAGE_PREFIX}-$R1-$R2"
    ${Else}
      StrCpy $phase7TransactionStage "$R3\${PHASE7_STAGE_PREFIX}-$R1-$R2"
    ${EndIf}
    !insertmacro phase7ValidateUninstallTransactionPaths

    !insertmacro phase7ReadPathState "$phase7TransactionStage" R5 R3 R4
    ${If} $R5 == "error"
      !insertmacro phase7Fail "The atomic uninstall staging path could not be inspected."
    ${ElseIf} $R5 == "present"
      !insertmacro phase7Fail "The atomic uninstall staging path already exists."
    ${EndIf}
    !insertmacro phase7ReadRegistryBackupLayout R7
    ${If} $R7 != "stable"
      !insertmacro phase7Fail "The product registry backup layout is not clean before uninstall."
    ${EndIf}
  !macroend

  !macro phase7RollbackAtomicRootStage OUTPUT
    !insertmacro phase7RollbackUninstallTransaction ${OUTPUT}
  !macroend

  !macro phase7StageVerifiedInstallRoot
    !insertmacro phase7PrepareAtomicRootStage
    !insertmacro phase7ClaimUninstallTransaction R4
    ${If} $R4 != "claimed"
      !insertmacro phase7Fail "The atomic uninstall transaction could not be claimed."
    ${EndIf}

    SetOutPath $TEMP
    ClearErrors
    Rename "$phase7TransactionSource" "$phase7TransactionStage"
    ${If} ${Errors}
      !insertmacro phase7ClearUninstallTransaction R4
      !insertmacro phase7Fail "The verified installation root could not be atomically staged."
    ${EndIf}
    !insertmacro phase7ReadPathState "$phase7TransactionSource" R4 R0 R1
    ${If} $R4 == "error"
      !insertmacro phase7Fail "The source root could not be inspected after atomic staging."
    ${ElseIf} $R4 == "present"
      !insertmacro phase7Fail "The source root still exists after atomic staging."
    ${EndIf}
    !insertmacro phase7ValidateStableRoot "$phase7TransactionStage"
    StrCpy $INSTDIR "$phase7TransactionSource"

    !insertmacro phase7PersistUninstallTransaction "staged-uncommitted" R4
    ${If} $R4 != "written"
      !insertmacro phase7RollbackAtomicRootStage R5
      !insertmacro phase7Fail "The staged uninstall transaction could not be persisted; the installation was rolled back."
    ${EndIf}

    # CHECK_APP_RUNNING happened before the root rename. Close the normal
    # shortcut race by checking both path identities after staging: Windows can
    # report either the pre-rename or current image path for a process that
    # started in that interval. The normal source path is now absent, so no
    # ordinary shortcut can create a new process after these checks.
    !insertmacro phase7FindExactAppProcessAtRoot "$phase7TransactionSource" R4
    ${If} $R4 == "not-running"
      !insertmacro phase7FindExactAppProcessAtRoot "$phase7TransactionStage" R4
    ${EndIf}
    ${If} $R4 != "not-running"
      !insertmacro phase7RollbackAtomicRootStage R5
      ${If} $R5 == "restored"
        !insertmacro phase7Fail "The application restarted during uninstall staging; the installation was restored."
      ${Else}
        !insertmacro phase7Fail "The application process race could not be resolved safely; recovery remains pending."
      ${EndIf}
    ${EndIf}
  !macroend

  !macro phase7CommitAtomicUninstallRegistry OUTPUT
    StrCpy $phase7CommitResult "pending"
    ${If} $phase7TransactionState != "staged-uncommitted"
      !insertmacro phase7Fail "The uninstall transaction is not ready for registry commit."
    ${EndIf}
    !insertmacro phase7ValidateStableRoot "$phase7TransactionStage"
    StrCpy $INSTDIR "$phase7TransactionSource"

    !insertmacro phase7BackupProductRegistry R4
    ${If} $R4 == "copied"
      !insertmacro phase7PersistUninstallTransaction "registry-backups-ready" R4
      ${If} $R4 == "written"
        # Separate the safe copied state from any path that may have begun
        # deleting originals. Recovery can discard backups directly in the
        # former and rebuild from them in the latter.
        !insertmacro phase7PersistUninstallTransaction "registry-delete-started" R4
        ${If} $R4 == "written"
          !insertmacro phase7DeleteProductRegistryOriginals R4
          ${If} $R4 == "deleted"
            # A failed readback here is intentionally left untouched. The
            # actual durable state is either delete-started (rollback rebuild)
            # or committed (finish cleanup).
            !insertmacro phase7PersistUninstallTransaction "committed-cleanup" R4
            ${If} $R4 == "written"
              StrCpy $phase7CommitResult "committed"
            ${EndIf}
          ${Else}
            !insertmacro phase7RollbackAtomicRootStage R5
            StrCpy $phase7CommitResult "$R5"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${Else}
      # Copies are partial or absent and originals have not been touched.
      ${If} $phase7TransactionState == "staged-uncommitted"
        !insertmacro phase7RollbackAtomicRootStage R5
        StrCpy $phase7CommitResult "$R5"
      ${EndIf}
    ${EndIf}
    StrCpy $${OUTPUT} "$phase7CommitResult"
  !macroend

  !macro phase7FinishCommittedAtomicUninstall OUTPUT
    !insertmacro phase7AdvanceCommittedRootCleanup ${OUTPUT}
  !macroend
!endif

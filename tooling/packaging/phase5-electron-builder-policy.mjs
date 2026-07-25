import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

export const auditedInstallerIncludePath = 'installer.nsh';
export const auditedAfterExtractHookPath =
  'tooling/phase5-after-extract.mjs';
export const auditedAfterExtractHookSha256 =
  '2e25f6b8b538a7799c45e8153497262505102d42bb60c63b32846a7a421d920e';
export const auditedAppBuilderPatchPath = 'patches/app-builder-lib@26.15.3.patch';
export const auditedGitAttributesSha256 =
  '37814623bde35041399e8eda92d95d017ddba33084bfac21c6b182cda4c84a84';
export const auditedFluentIconsPatchPath =
  'patches/@fluentui__react-icons@2.0.316.patch';
export const auditedAppBuilderPatchSha256 =
  'e506aad9c1ae833d706cd54dd20da67ec94176bdcdf30f01a300092a0043e357';
export const auditedFluentIconsPatchSha256 =
  '41993040530e9924f2a1021693bc29f0f3212468a2dd49c7d2d24f91bab1c10f';
export const auditedFluentIconsPnpmPatchHash =
  '8d7df040fe72d3d557bd823b5f87ee8080e23bdc97d645cad856df2c744d259a';
export const auditedInstallerIncludeSha256 =
  '313c6e1231b35c986ff168d4985c77145e3c90bb8a2bdbf5d66750baf9b711e4';
export const auditedPatchedAssistedInstallerTemplateSha256 =
  '253c35920ee98cb18cff1241d4feba7abc806324ed7699e82bccc7bf6c380467';
export const auditedPatchedInstallerTemplateSha256 =
  'a6ed203cf931237b1528c232914c5ea887ed665516f933ed473b234eb67c0a01';
export const auditedPatchedInstallSectionTemplateSha256 =
  '8fdbc094fac76a2738fab23cc496813208675c06639d33868dab41e3f6ac69e4';
export const auditedPatchedUninstallerTemplateSha256 =
  'bbb32fe816310fddb623c92df83b4d0bcddef8a67f92c94891686e12d500bae2';
export const auditedPatchedExtractAppPackageTemplateSha256 =
  'b84735223e33cd632d03312b8154195cd3a005bf9c27e58b3d8746243a510a3e';
export const auditedPatchedInstallUtilTemplateSha256 =
  '01b643c1c82a53cb258f6f651daecfb45b679076e3d6cee9f0ec18020684afcb';
export const auditedElectronBuilderIntegrity =
  'sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==';
export const auditedAppBuilderIntegrity =
  'sha512-2VnyWkqsP5v5XbBhL3tD5Syx8iNPBYsoU7kY4S2fz7wg8Rj/nztWKCUzGKaFRTv0Xwf3/H058CR1Kvtd/3lRow==';
export const auditedFluentIconsIntegrity =
  'sha512-tZPOtsUmoOrgLeM/rLjkzLlWOEmIghXNh/DYQzm5RD/Q4epklOzjnsFvc/Mn2tuXiVxi+vvXxsQp21E1aLpmWg==';
export const auditedFluentIconsLicenseSha256 =
  '02f1fa1f007abde79c6ca74520d3605929c19c35f25338310487e5e4c1de3bb6';
export const auditedNoticeGeneratorSha256 =
  'b8e25fdfaef09f88574170b4f5b868d737d252232fe8998f8e1f7053e2012cb7';
export const auditedElectronBuilderCliSha256 =
  'b61356c9f3a890e6d1e523b15c431802d3edf4833bb625c5cedf1c8405ec1886';
export const auditedElectronBuilderTree = Object.freeze({
  fileCount: 31,
  sha256: '02153023c2b9a121fc0a34f4003323ce95d44090feb3651da5d1aa3c7189e802'
});
export const auditedPatchedAppBuilderTree = Object.freeze({
  fileCount: 520,
  sha256: '668970e134497bcb8b68719e29978668b9dc65de5e74905a71e0fb51247cb56f'
});

const canonicalInstallerName = 'Desktop-Translate-0.5.0-phase5-x64-setup.exe';
const exactTopLevelKeys = Object.freeze([
  'afterExtract',
  'appId',
  'asar',
  'buildVersion',
  'compression',
  'copyright',
  'directories',
  'electronLanguages',
  'electronVersion',
  'extends',
  'extraResources',
  'files',
  'nodeGypRebuild',
  'npmRebuild',
  'nsis',
  'productName',
  'publish',
  'win'
]);
const exactWinKeys = Object.freeze([
  'artifactName',
  'executableName',
  'requestedExecutionLevel',
  'signExts',
  'target'
]);
const exactDirectoryKeys = Object.freeze(['buildResources', 'output']);
const exactNsisValues = Object.freeze({
  oneClick: false,
  perMachine: false,
  allowElevation: false,
  allowToChangeInstallationDirectory: true,
  createDesktopShortcut: false,
  createStartMenuShortcut: true,
  shortcutName: 'Desktop Translate',
  uninstallDisplayName: 'Desktop Translate',
  deleteAppDataOnUninstall: false,
  runAfterFinish: false,
  differentialPackage: false,
  useZip: true,
  packElevateHelper: false,
  include: auditedInstallerIncludePath
});

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNewlines(value) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function countExactOccurrences(value, token) {
  if (token.length === 0) throw new TypeError('exact occurrence token must not be empty');
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = value.indexOf(token, cursor);
    if (index === -1) return count;
    count += 1;
    cursor = index + token.length;
  }
}

function assertOrderedTokens(value, tokens, label) {
  let cursor = 0;
  for (const token of tokens) {
    const index = value.indexOf(token, cursor);
    if (index === -1) {
      throw new Error(`${label} ordering lacks ${token}`);
    }
    cursor = index + token.length;
  }
}

function extractNsisMacro(value, declaration, label) {
  const startToken = `!macro ${declaration}`;
  const start = value.indexOf(startToken);
  if (start === -1) throw new Error(`${label} lacks ${startToken}`);
  const end = value.indexOf('!macroend', start + startToken.length);
  if (end === -1) throw new Error(`${label} has an unterminated ${startToken}`);
  return value.slice(start, end + '!macroend'.length);
}

export function normalizePhase7FreshTargetForPolicy(selectedPath, appFilename) {
  if (typeof selectedPath !== 'string' || selectedPath.length === 0) {
    throw new TypeError('selectedPath must be a non-empty string');
  }
  if (typeof appFilename !== 'string'
      || appFilename.length === 0
      || appFilename.includes('\\')
      || appFilename.includes('/')) {
    throw new TypeError('appFilename must be one Windows path segment');
  }
  const normalized = win32.normalize(selectedPath);
  return win32.basename(normalized).toLowerCase() === appFilename.toLowerCase()
    ? normalized
    : win32.join(normalized, appFilename);
}

export function evaluatePhase7InstallerPolicyScenario({
  state,
  silent = false,
  hasDParameter = false,
  registryMatches = false,
  targetKind,
  markerState = 'missing',
  containsReparse = false,
  rootAllowlisted = true,
  shortcutRegistryState = state === 'fresh'
    ? 'empty'
    : state === 'recovering'
      ? 'partial-exact'
      : 'exact'
}) {
  if (state !== 'fresh' && state !== 'registered' && state !== 'recovering') {
    return Object.freeze({ allowed: false, reason: 'INVALID_STATE' });
  }
  if (containsReparse) {
    return Object.freeze({ allowed: false, reason: 'REPARSE_POINT' });
  }
  if (state === 'fresh') {
    if (shortcutRegistryState !== 'empty') {
      return Object.freeze({ allowed: false, reason: 'SHORTCUT_REGISTRY_INVALID' });
    }
    if (silent && hasDParameter) {
      return Object.freeze({ allowed: false, reason: 'SILENT_D_OVERRIDE' });
    }
    if (targetKind === 'missing' || targetKind === 'empty-directory') {
      return Object.freeze({ allowed: true, reason: 'FRESH_EMPTY_TARGET' });
    }
    return targetKind === 'nonempty-directory'
      && markerState === 'recovery'
      && rootAllowlisted
      ? Object.freeze({ allowed: true, reason: 'INTERRUPTED_PHASE7_RECOVERY' })
      : Object.freeze({ allowed: false, reason: 'FRESH_NONEMPTY_TARGET' });
  }
  if (hasDParameter) {
    return Object.freeze({ allowed: false, reason: 'REGISTERED_D_OVERRIDE' });
  }
  if (!registryMatches) {
    return Object.freeze({ allowed: false, reason: 'REGISTRY_PATH_MISMATCH' });
  }
  if (state === 'recovering') {
    if (!['empty', 'partial-exact', 'exact'].includes(shortcutRegistryState)) {
      return Object.freeze({ allowed: false, reason: 'SHORTCUT_REGISTRY_INVALID' });
    }
    return markerState === 'recovery' && rootAllowlisted
      ? Object.freeze({ allowed: true, reason: 'INTERRUPTED_PHASE7_RECOVERY' })
      : Object.freeze({ allowed: false, reason: 'RECOVERY_IDENTITY_INVALID' });
  }
  if (shortcutRegistryState !== 'exact') {
    return Object.freeze({ allowed: false, reason: 'SHORTCUT_REGISTRY_INVALID' });
  }
  if (markerState === 'stable' && rootAllowlisted) {
    return Object.freeze({ allowed: true, reason: 'REGISTERED_MARKER' });
  }
  if (markerState === 'stable') {
    return Object.freeze({ allowed: false, reason: 'ROOT_ALLOWLIST_INVALID' });
  }
  if (markerState === 'recovery' && rootAllowlisted) {
    return Object.freeze({ allowed: true, reason: 'INTERRUPTED_PHASE7_RECOVERY' });
  }
  return Object.freeze({ allowed: false, reason: 'PRE_PHASE7_OR_MARKER_IDENTITY_INVALID' });
}

function parseConfiguration(configuration) {
  let parsed;
  try {
    parsed = load(configuration);
  } catch (error) {
    throw new Error(`electron-builder YAML could not be parsed: ${error.message}`, { cause: error });
  }
  if (!isMapping(parsed)) throw new Error('electron-builder config root must be a mapping');
  return parsed;
}

function assertExactArray(actual, expected, message) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}, got ${JSON.stringify(actual)}`);
  }
}

function assertExactKeys(actual, expected, message) {
  if (!isMapping(actual)) throw new Error(`${message} must be a mapping`);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${message} keys must be exactly [${expectedKeys.join(', ')}], got [${actualKeys.join(', ')}]`
    );
  }
}

function assertExactNsisConfiguration(nsis) {
  if (!isMapping(nsis)) throw new Error('electron-builder config must contain one top-level nsis mapping');

  for (const forbiddenKey of ['script', 'selectPerMachineByDefault', 'customNsisBinary']) {
    if (own(nsis, forbiddenKey)) {
      throw new Error(`electron-builder nsis.${forbiddenKey} override is forbidden`);
    }
  }

  const actualKeys = Object.keys(nsis).sort();
  const expectedKeys = Object.keys(exactNsisValues).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `electron-builder nsis keys must be exactly [${expectedKeys.join(', ')}], got [${actualKeys.join(', ')}]`
    );
  }
  for (const [key, expected] of Object.entries(exactNsisValues)) {
    if (nsis[key] !== expected) {
      throw new Error(
        `electron-builder nsis.${key} must be exactly ${JSON.stringify(expected)}, got ${JSON.stringify(nsis[key])}`
      );
    }
  }
}

function assertParsedConfiguration(parsed) {
  assertExactKeys(parsed, exactTopLevelKeys, 'electron-builder top-level configuration');
  if (parsed.afterExtract !== auditedAfterExtractHookPath) {
    throw new Error(
      `electron-builder afterExtract must be exactly ${auditedAfterExtractHookPath}`
    );
  }
  if (parsed.extends !== null) {
    throw new Error(
      'electron-builder extends must be explicitly null to disable implicit package-based inheritance'
    );
  }
  assertExactKeys(parsed.directories, exactDirectoryKeys, 'electron-builder directories');
  if (parsed.directories.buildResources !== 'build') {
    throw new Error('electron-builder directories.buildResources must be exactly build');
  }
  if (parsed.directories.output !== '../../artifacts/phase5/package/dist') {
    throw new Error(
      'electron-builder directories.output must be exactly ../../artifacts/phase5/package/dist'
    );
  }
  const win = parsed.win;
  assertExactKeys(win, exactWinKeys, 'electron-builder win configuration');
  if (win.requestedExecutionLevel !== 'asInvoker') {
    throw new Error('electron-builder win.requestedExecutionLevel must be exactly asInvoker');
  }
  assertExactArray(
    win.signExts,
    ['selection-host.exe'],
    'electron-builder win.signExts must contain exactly selection-host.exe'
  );

  if (!Array.isArray(win.target) || win.target.length !== 1 || !isMapping(win.target[0])) {
    throw new Error('electron-builder win.target must contain exactly one nsis x64 target mapping');
  }
  const target = win.target[0];
  const targetKeys = Object.keys(target).sort();
  if (JSON.stringify(targetKeys) !== JSON.stringify(['arch', 'target'])) {
    throw new Error('electron-builder win.target entry keys must be exactly [arch, target]');
  }
  if (target.target !== 'nsis') {
    throw new Error('electron-builder win.target must contain exactly one nsis target');
  }
  assertExactArray(
    target.arch,
    ['x64'],
    'electron-builder win.target nsis architecture must be exactly x64'
  );

  if (win.artifactName !== canonicalInstallerName || own(parsed.nsis, 'artifactName')) {
    throw new Error(
      `electron-builder win.artifactName must be exactly ${canonicalInstallerName} with no target override`
    );
  }
  if (own(win, 'publish') || parsed.publish !== null) {
    throw new Error('electron-builder publish policy must be exactly top-level publish: null with no win override');
  }

  assertExactNsisConfiguration(parsed.nsis);
}

export function assertPhase7InstallerIncludeSemantics(installerIncludeContent) {
  if (typeof installerIncludeContent !== 'string') {
    throw new TypeError('electron-builder audited installer include content must be a string');
  }
  const normalized = normalizeNewlines(installerIncludeContent);
  for (const required of [
    '!macro customCheckAppRunning',
    '!macro phase7FindExactAppProcessAtRoot ROOT_PATH OUTPUT',
    '!macro phase7DirectoryPagePre',
    '!macro phase7ValidateInstallTargetBeforeMutation',
    '!macro phase7BeginInstallTransaction',
    '!macro phase7CommitInstallTransaction',
    '!macro phase7WriteInstallMarker',
    '!macro phase7VerifyUninstallRoot',
    '!macro phase7AssertKnownRootEntries ROOT_PATH',
    '!macro phase7SetVerifiedLinkVars',
    '!macro phase7AssertRequiredNonEmptyFile RELATIVE_PATH',
    '!macro phase7ProbeRegistryWritable',
    '!macro phase7AcquireUninstallMutex',
    '!macro phase7AssertNoConcurrentUninstallBoundary',
    '!macro phase7CopyRegistryTree SOURCE_KEY DESTINATION_KEY OUTPUT',
    '!macro phase7RollbackUninstallTransaction OUTPUT',
    '!macro phase7CompleteCommittedPostCleanup OUTPUT',
    'Function ${PHASE7_APP_PROCESS_FUNCTION}',
    'StrCpy $phase7AppProcessState "error"',
    'KERNEL32::CreateToolhelp32Snapshot(i 0x2, i 0)',
    'KERNEL32::Process32FirstW(p R0, p R1)',
    'KERNEL32::Process32NextW(p R0, p R1)',
    'KERNEL32::QueryFullProcessImageNameW(p R3, i 0',
    'KERNEL32::GetLongPathNameW(w R7, w .R8',
    'KERNEL32::lstrcmpiW(w R8, w "$phase7ExpectedAppProcessPath")',
    'StrCpy $R8 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    'StrCpy $R8 "${ROOT_PATH}\\${APP_EXECUTABLE_FILENAME}"',
    'StrCpy $R5 0x101000',
    'IntOp $R5 $R5 | 0x1',
    'KERNEL32::TerminateProcess(p R3, i 0)',
    'KERNEL32::WaitForSingleObject(p R3, i 0)',
    'KERNEL32::WaitForSingleObject(p R3, i 30000)',
    'StrCpy $phase7AppProcessState "not-running"',
    'StrCpy $phase7AppProcessState "running"',
    'StrCpy $phase7AppProcessState "terminated"',
    'ADVAPI32::ConvertSidToStringSidW',
    'KERNEL32::lstrlenW(p R5) i.R6',
    'KERNEL32::lstrcpynW(w .R6, p R5, i ${NSIS_MAX_STRLEN}) p.R7',
    'KERNEL32::LocalFree(p R5) p.R8',
    '!define PHASE7_UNINSTALL_MUTEX_PREFIX "Global\\DesktopTranslate.Phase7.Uninstall.${APP_GUID}"',
    '${PHASE7_UNINSTALL_MUTEX_PREFIX}-$R6',
    'KERNEL32::GetVolumePathNameW',
    'KERNEL32::GetDriveTypeW',
    '${If} $R2 != 3',
    'KERNEL32::GetVolumeInformationW',
    'w "NTFS"',
    'KERNEL32::FindFirstFileW(w "${GLOB}", p $${BUFFER}) p.${HANDLE} ?e',
    'KERNEL32::FindNextFileW(p $${HANDLE}, p $${BUFFER}) i.${RESULT} ?e',
    'ADVAPI32::RegCopyTreeW',
    'PHASE7_REGISTRY_BACKUP_CONTAINER "Software\\DesktopTranslatePhase7RegistryBackups"',
    'Rename "$phase7TransactionSource" "$phase7TransactionStage"',
    'registry-backups-ready',
    'registry-delete-started',
    'rollback-registry-restored',
    'committed-cleanup',
    'committed-postcleanup',
    'Delete "$phase7TransactionStage\\${PHASE7_INSTALL_MARKER_NAME}"',
    'RMDir "$phase7TransactionStage"',
    'QuietUninstallString',
    'HKCU KeepShortcuts does not match the registered installation.',
    'HKCU ShortcutName does not match the registered installation.',
    'HKCU MenuDirectory is unexpected for this installation.',
    'resources\\manifest\\file-manifest.sha256',
    'StrCmp "$R0" "resources\\selection-host\\selection-host.exe" phase7_classify_file',
    'Call ${PHASE7_ALLOWLIST_FUNCTION}',
    'The installation tree contains an unknown entry.',
    'enumeration failed before reaching normal EOF.',
    'cleanup-failed',
    'Fresh installation requires a nonexistent or empty application directory.',
    'GetFullPathName $R0 "$R2"',
    'The selected installation parent directory is invalid.',
    'StrCpy $phase7FreshParentPlan "create-default-programs"',
    '!macro phase7CreateOwnedDirectoryAtParent PARENT_HANDLE LEAF_NAME',
    'ntdll::NtCreateFile(p R2',
    'i 0x00200021',
    '!macro phase7DeleteIdentityBoundCreatedDirectory HANDLE_VARIABLE',
    'KERNEL32::GetFileInformationByHandle',
    '!macro phase7CleanupCreatedFreshDirectories',
    'Push "${DIRECTORY_VALUE}"',
    'StrCpy $R2 "$R4\\${PHASE7_WRITE_PROBE_NAME}-$R0-$R1"',
    '!macro phase7DisposeOwnedWriteProbe',
    'Silent installation cannot select or move the installation directory with /D.',
    'The stable installation marker is missing. Uninstall was refused.',
    'Uninstall the pre-Phase 7 build explicitly before installing Phase 7.'
  ]) {
    if (!normalized.includes(required)) {
      throw new Error(`electron-builder audited Phase 7 installer include lacks ${required}`);
    }
  }
  for (const resultVariable of [
    'phase7RegistryLayoutResult',
    'phase7RegistryOperationResult',
    'phase7TransactionClaimResult',
    'phase7TransactionWriteResult',
    'phase7TransactionClearResult',
    'phase7RollbackResult',
    'phase7CommitResult',
    'phase7CommittedCleanupResult',
    'phase7PostCleanupOperationResult',
    'phase7PostCleanupResult'
  ]) {
    const declaration = `Var ${resultVariable}`;
    if (countExactOccurrences(normalized, declaration) !== 1) {
      throw new Error(
        `Phase 7 installer include must declare exactly one dedicated ${resultVariable}`
      );
    }
  }
  if (!normalized.includes([
    '!ifdef BUILD_UNINSTALLER',
    '  Var phase7TransactionClaimKey',
    '  Var phase7OwnerIdentityState',
    '  Var phase7TransactionClaimResult',
    '  Var phase7CommitResult',
    '!endif'
  ].join('\n'))) {
    throw new Error(
      'Phase 7 uninstaller-only result variables must stay inside BUILD_UNINSTALLER'
    );
  }
  if (normalized.includes(
    "System::Call '*$R5(&w${NSIS_MAX_STRLEN} .R6)'"
  )) {
    throw new Error(
      'Phase 7 must not fixed-length dereference the borrowed LocalAlloc SID pointer'
    );
  }
  const uninstallMutex = extractNsisMacro(
    normalized,
    'phase7AcquireUninstallMutex',
    'Phase 7 installer include'
  );
  assertOrderedTokens(uninstallMutex, [
    'ADVAPI32::ConvertSidToStringSidW(p R4, *p .R5) i.R1',
    'KERNEL32::lstrlenW(p R5) i.R6',
    '${If} $R6 <= 0',
    '${OrIf} $R6 >= ${NSIS_MAX_STRLEN}',
    'KERNEL32::lstrcpynW(w .R6, p R5, i ${NSIS_MAX_STRLEN}) p.R7',
    'KERNEL32::LocalFree(p R5) p.R8',
    '${If} $R7 == 0',
    '${If} $R8 != 0',
    'KERNEL32::CreateMutexW(p 0, i 0, w "$phase7UninstallMutexName") p.R0',
    'KERNEL32::WaitForSingleObject(p R0, i 0) i.R1'
  ], 'Phase 7 current-user SID mutex acquisition');
  if (normalized.includes('RMDir /r "$INSTDIR"\n')
      || normalized.includes('RMDir /r $INSTDIR\n')
      || normalized.includes(
        'GetFullPathName $R8 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"'
      )
      || normalized.includes(
        'GetFullPathName $R8 "${ROOT_PATH}\\${APP_EXECUTABLE_FILENAME}"'
      )
      || normalized.includes(
        'GetFullPathName $R0 "$INSTDIR"\n'
        + '    ${If} $R0 == ""\n'
        + '      !insertmacro phase7Fail "The selected installation directory is invalid."\n'
        + '    ${EndIf}\n'
        + '    StrCpy $INSTDIR "$R0"\n'
      )
      || normalized.includes('CreateDirectory "$INSTDIR"')
      || normalized.includes('RMDir /r "$phase7TransactionSource"\n')
      || normalized.includes('RMDir /r "$phase7TransactionStage"\n')
      || normalized.includes('phase7VerifyPhase5N1Path')
      || normalized.includes('PHASE7_PHASE5_PRODUCT_MANIFEST_SHA256')) {
    throw new Error('Phase 7 installer include must not recursively delete the complete install root');
  }
  if (/(^|[\r\n])[ \t]*(?:FindFirst|FindNext)[ \t]/u.test(normalized)) {
    throw new Error('Phase 7 installer include must use direct Win32 enumeration only');
  }
  if (/(?:powershell(?:\.exe)?|pwsh|Get-CimInstance|Get-WmiObject|Win32_Process|Start-Process|Stop-Process|\.StartsWith\(|taskkill(?:\.exe)?|wmic)/iu.test(normalized)) {
    throw new Error('Phase 7 installer include must not use shell or WMI process matching');
  }
  if (/System::Call[^\n]*\b[pwi](?:\.|[ \t]+\.?)r[0-9]\b/u.test(normalized)) {
    throw new Error(
      'Phase 7 installer include must bind System plug-in values to uppercase $R registers'
    );
  }
  const recursiveDeletes = normalized.match(/^[ \t]*RMDir \/r .+$/gmu) ?? [];
  if (JSON.stringify(recursiveDeletes.map((line) => line.trim())) !== JSON.stringify([
    'RMDir /r "$R0"'
  ])) {
    throw new Error(
      'Phase 7 installer include recursive deletion must target only the verified exact AppData leaf'
    );
  }
  if (/SystemComponent/iu.test(normalized)
      || normalized.includes(
        'PHASE7_REGISTRY_BACKUP_ROOT "${INSTALL_REGISTRY_KEY}'
      )
      || normalized.includes(
        'PHASE7_REGISTRY_BACKUP_ROOT "${UNINSTALL_REGISTRY_KEY}'
      )
      || normalized.includes('DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"')
      || normalized.includes('DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"')) {
    throw new Error(
      'Phase 7 product registry backups and deletion must stay inside the external durable transaction'
    );
  }
  for (const [token, expectedCount] of [
    ['KERNEL32::FindFirstFileW', 1],
    ['KERNEL32::FindNextFileW', 1],
    ['Rename "$phase7TransactionSource" "$phase7TransactionStage"', 1],
    ['Rename "$phase7TransactionStage" "$phase7TransactionSource"', 1],
    ['!insertmacro phase7RenameRegistryKey', 1]
  ]) {
    if (countExactOccurrences(normalized, token) !== expectedCount) {
      throw new Error(`Phase 7 installer include must contain exactly ${expectedCount} ${token}`);
    }
  }
  if (!normalized.includes(
    '!insertmacro phase7RenameRegistryKey "$phase7TransactionClaimKey"'
      + ' "${PHASE7_UNINSTALL_TRANSACTION_KEY}" R8'
  )) {
    throw new Error('Phase 7 registry rename may claim only the canonical transaction key');
  }

  const writableProbe = extractNsisMacro(
    normalized,
    'phase7ProbeWritableDirectory DIRECTORY_VALUE',
    'Phase 7 installer include'
  );
  const writableProbeCleanup = extractNsisMacro(
    normalized,
    'phase7DisposeOwnedWriteProbe',
    'Phase 7 installer include'
  );
  assertOrderedTokens(writableProbeCleanup, [
    'System::Alloc 4',
    'SetFileInformationByHandle(p R0, i 4, p R3, i 1)',
    'KERNEL32::CloseHandle(p R0) i.R5',
    'KERNEL32::GetFileAttributesW(w R2) i.R5 ?e',
    '${If} $R5 != -1',
    '${If} $R9 != 2',
    '${AndIf} $R9 != 3'
  ], 'Phase 7 handle-owned writable-probe cleanup');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(writableProbeCleanup)) {
    throw new Error(
      'Phase 7 writable-probe cleanup must never delete or reopen the probe by pathname'
    );
  }
  const writableProbeInstructions = writableProbe
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0
      && !line.startsWith('#')
      && !line.startsWith('!macro ')
      && line !== '!macroend');
  const expectedWritableCapture = [
    'Push $R4',
    'Push "${DIRECTORY_VALUE}"',
    'Pop $R4'
  ];
  if (!expectedWritableCapture.every(
    (instruction, index) => writableProbeInstructions[index] === instruction
  )) {
    throw new Error(
      'Phase 7 writable probe must capture its caller directory before scratch register writes'
    );
  }
  if (countExactOccurrences(writableProbe, '\n  Push $R4\n') !== 1
      || countExactOccurrences(writableProbe, '\n  Pop $R4\n') !== 2
      || writableProbeInstructions.at(-1) !== 'Pop $R4') {
    throw new Error('Phase 7 writable probe must preserve and restore $R4 exactly once');
  }
  assertOrderedTokens(writableProbe, [
    'Push $R4',
    'Push "${DIRECTORY_VALUE}"',
    'Pop $R4',
    'KERNEL32::GetCurrentProcessId() i.R0',
    'KERNEL32::GetTickCount() i.R1',
    'StrCpy $R2 "$R4\\${PHASE7_WRITE_PROBE_NAME}-$R0-$R1"',
    'KERNEL32::CreateFileW(w R2, i 0x40010000, i 0, p 0, i 1, i 0x80, p 0) p.R0 ?e',
    'KERNEL32::WriteFile(p R0, m "phase7-write-probe", i R3, *i .R1, p 0) i.R5 ?e',
    'KERNEL32::FlushFileBuffers(p R0) i.R5 ?e',
    '!insertmacro phase7DisposeOwnedWriteProbe',
    'Pop $R4'
  ], 'Phase 7 writable-directory probe');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(writableProbe)) {
    throw new Error(
      'Phase 7 writable probe must use exclusive handle ownership without pathname cleanup'
    );
  }

  const freshTargetPreparation = extractNsisMacro(
    normalized,
    'phase7PrepareFreshTarget',
    'Phase 7 installer include'
  );
  assertOrderedTokens(freshTargetPreparation, [
    'StrCpy $phase7FreshParentPlan "none"',
    'StrCpy $phase7FreshParentBasePath ""',
    'StrCpy $phase7FreshParentPath ""',
    'StrCpy $phase7FreshParentCreated "0"',
    'GetFullPathName $R5 "$LOCALAPPDATA"',
    'StrCpy $R6 "$R5\\Programs"',
    'StrCpy $R7 "$R6\\${APP_FILENAME}"',
    'StrCmp "$INSTDIR" "$R7" 0'
      + ' phase7_target_not_missing_default_parent_${PHASE7_TARGET_LEAF_ID}',
    'KERNEL32::GetFileAttributesW(w R6) i.R8 ?e',
    '${If} $R9 != 2',
    '${AndIf} $R9 != 3',
    'StrCpy $phase7FreshParentPlan "create-default-programs"',
    'StrCpy $phase7FreshParentBasePath "$R5"',
    'StrCpy $phase7FreshParentPath "$R6"',
    'StrCpy $INSTDIR "$R7"'
  ], 'Phase 7 missing default Programs parent plan');

  const defaultParentPlan = extractNsisMacro(
    normalized,
    'phase7AssertDefaultProgramsParentPlan',
    'Phase 7 installer include'
  );
  assertOrderedTokens(defaultParentPlan, [
    'GetFullPathName $R0 "$LOCALAPPDATA"',
    'StrCmp "$phase7FreshParentBasePath" "$R0"',
    'StrCpy $R1 "$R0\\Programs"',
    'StrCmp "$phase7FreshParentPath" "$R1"',
    'StrCpy $R2 "$R1\\${APP_FILENAME}"',
    'StrCmp "$INSTDIR" "$R2"',
    'Call ${PHASE7_ANCESTOR_FUNCTION}',
    'KERNEL32::GetFileAttributesW(w R1) i.R3 ?e',
    'The planned default installation parent appeared during validation. Run the installer again.',
    '${If} $R4 != 2',
    '${AndIf} $R4 != 3'
  ], 'Phase 7 default Programs parent preflight');

  const existingParentLease = extractNsisMacro(
    normalized,
    'phase7OpenExistingDirectoryParent PATH_VALUE OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(existingParentLease, [
    'StrCpy $phase7ExistingParentHandle "-1"',
    'KERNEL32::CreateFileW(w "${PATH_VALUE}", i 0x001000A4, i 3,'
      + ' p 0, i 3, i 0x02200000, p 0) p.R0 ?e',
    'StrCpy $phase7ExistingParentHandle "$R0"',
    'KERNEL32::GetFileInformationByHandle(p $phase7ExistingParentHandle',
    'IntOp $R4 $R4 & 0x410',
    '${If} $R4 != 16',
    'StrCpy $${OUTPUT} "valid"'
  ], 'Phase 7 existing-parent no-delete-share identity lease');
  if (existingParentLease.includes(' i 7, p 0, i 3,')) {
    throw new Error('Phase 7 existing-parent lease must never allow FILE_SHARE_DELETE');
  }

  const atomicDirectoryCreate = extractNsisMacro(
    normalized,
    'phase7CreateOwnedDirectoryAtParent PARENT_HANDLE LEAF_NAME'
      + ' HANDLE_VARIABLE OUTPUT_VOLUME OUTPUT_HIGH OUTPUT_LOW OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(atomicDirectoryCreate, [
    'StrLen $R3 "${LEAF_NAME}"',
    '*(&w${NSIS_MAX_STRLEN} "${LEAF_NAME}") p.R4',
    '*(h R5, h R6, p R4) p.R7',
    '*(i 24, p ${PARENT_HANDLE}, p R7, i 0x40, p 0, p 0) p.R8',
    '*(p 0, p 0) p.R9',
    'System::Call \'*$R2(p -1)\'',
    'ntdll::NtCreateFile(p R2, i 0x001100A4, p R8, p R9, p 0,'
      + ' i 0x10, i 3, i 2, i 0x00200021, p 0, i 0) i.R1',
    'System::Call \'*$R2(p .R0)\'',
    'StrCpy $${HANDLE_VARIABLE} "$R0"',
    '!insertmacro phase7ReadDirectoryHandleIdentity $R0',
    '!insertmacro phase7SetHandleDeleteDispositionAndClose $R0 R8',
    'StrCpy $${OUTPUT} "created"'
  ], 'Phase 7 atomic relative-directory creation');
  if (/(?:^|\n)[ \t]*(?:CreateDirectory|RMDir|Delete|FileOpen)[ \t]/u.test(
    atomicDirectoryCreate
  )) {
    throw new Error(
      'Phase 7 atomic directory creation must not fall back to pathname create or cleanup'
    );
  }

  const identityBoundDirectoryDelete = extractNsisMacro(
    normalized,
    'phase7DeleteIdentityBoundCreatedDirectory HANDLE_VARIABLE'
      + ' EXPECTED_VOLUME EXPECTED_HIGH EXPECTED_LOW OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(identityBoundDirectoryDelete, [
    'KERNEL32::GetFileInformationByHandle(p $${HANDLE_VARIABLE}',
    'IntOp $R4 $R4 & 0x410',
    '${OrIf} $R5 != $${EXPECTED_VOLUME}',
    '${OrIf} $R6 != $${EXPECTED_HIGH}',
    '${OrIf} $R7 != $${EXPECTED_LOW}',
    '!insertmacro phase7SetHandleDeleteDispositionAndClose $${HANDLE_VARIABLE} R8',
    'StrCpy $${HANDLE_VARIABLE} "-1"'
  ], 'Phase 7 created-directory file-identity deletion');
  if (/(?:^|\n)[ \t]*(?:CreateDirectory|RMDir|Delete|FileOpen)[ \t]/u.test(
    identityBoundDirectoryDelete
  )) {
    throw new Error(
      'Phase 7 created-directory cleanup must use only its file-identity handle'
    );
  }

  const handleDisposition = extractNsisMacro(
    normalized,
    'phase7SetHandleDeleteDispositionAndClose HANDLE OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(handleDisposition, [
    'System::Alloc 4',
    'SetFileInformationByHandle(p ${HANDLE}, i 4, p R3, i 1)',
    'KERNEL32::CloseHandle(p ${HANDLE}) i.R4',
    'StrCpy $${OUTPUT} "deleted"'
  ], 'Phase 7 exact-handle nonrecursive delete disposition');
  if (/(?:^|\n)[ \t]*(?:CreateDirectory|RMDir|Delete|FileOpen)[ \t]/u.test(
    handleDisposition
  )) {
    throw new Error('Phase 7 exact-handle delete disposition must not use a pathname');
  }

  const ensureTransactionRoot = extractNsisMacro(
    normalized,
    'phase7EnsureTransactionRoot',
    'Phase 7 installer include'
  );
  assertOrderedTokens(ensureTransactionRoot, [
    'StrCpy $phase7FreshRootCreated "0"',
    'StrCpy $phase7FreshParentCreated "0"',
    'StrCpy $phase7FreshRootHandle "-1"',
    'StrCpy $phase7FreshParentHandle "-1"',
    'StrCpy $phase7ExistingParentHandle "-1"',
    '${If} $phase7FreshParentPlan == "create-default-programs"',
    '!insertmacro phase7AssertDefaultProgramsParentPlan',
    '!insertmacro phase7OpenExistingDirectoryParent "$phase7FreshParentBasePath" R8',
    '!insertmacro phase7CreateOwnedDirectoryAtParent $phase7ExistingParentHandle "Programs"',
    'StrCpy $phase7FreshParentCreated "1"',
    '!insertmacro phase7AssertExistingParentBeforeCreate "$INSTDIR"',
    '!insertmacro phase7OpenExistingDirectoryParent "$R2" R8',
    '${If} $phase7FreshParentCreated == "1"',
    '!insertmacro phase7CreateOwnedDirectoryAtParent $phase7FreshParentHandle'
      + ' "${APP_FILENAME}" phase7FreshRootHandle',
    '!insertmacro phase7CreateOwnedDirectoryAtParent $phase7ExistingParentHandle'
      + ' "${APP_FILENAME}" phase7FreshRootHandle',
    'StrCpy $phase7FreshRootCreated "1"',
    '!insertmacro phase7AssertDirectoryIsNotReparse "$INSTDIR"',
    'Call ${PHASE7_ANCESTOR_FUNCTION}'
  ], 'Phase 7 atomic fresh-directory creation');
  if (ensureTransactionRoot.includes('PHASE7_WRITE_PROBE_NAME')
      || /(?:^|\n)[ \t]*(?:CreateDirectory|RMDir|Delete|FileOpen)[ \t]/u.test(
        ensureTransactionRoot
      )) {
    throw new Error(
      'Phase 7 transaction-root preparation must use parent-relative atomic directory handles'
    );
  }

  const freshDirectoryCleanup = extractNsisMacro(
    normalized,
    'phase7CleanupCreatedFreshDirectories',
    'Phase 7 installer include'
  );
  assertOrderedTokens(freshDirectoryCleanup, [
    '!insertmacro phase7CloseHandleVariable phase7ExistingParentHandle R9',
    '${If} $phase7FreshRootCreated == "1"',
    '!insertmacro phase7DeleteIdentityBoundCreatedDirectory phase7FreshRootHandle'
      + ' phase7FreshRootVolumeSerial phase7FreshRootFileIndexHigh'
      + ' phase7FreshRootFileIndexLow R9',
    'StrCpy $phase7FreshRootCreated "0"',
    '${If} $phase7FreshParentCreated == "1"',
    '${AndIf} $phase7FreshRootCreated == "0"',
    '${AndIf} $phase7FreshParentPlan == "create-default-programs"',
    '!insertmacro phase7DeleteIdentityBoundCreatedDirectory phase7FreshParentHandle'
      + ' phase7FreshParentVolumeSerial phase7FreshParentFileIndexHigh'
      + ' phase7FreshParentFileIndexLow R9',
    'StrCpy $phase7FreshParentCreated "0"'
  ], 'Phase 7 identity-bound nonrecursive fresh-directory rollback');
  if (/(?:^|\n)[ \t]*(?:CreateDirectory|RMDir|Delete|FileOpen)[ \t]/u.test(
    freshDirectoryCleanup
  )) {
    throw new Error(
      'Phase 7 fresh-directory rollback must not reopen or delete a pathname'
    );
  }
  const recoveryPreparationFailure = extractNsisMacro(
    normalized,
    'phase7FailRecoveryMarkerPreparation MESSAGE',
    'Phase 7 installer include'
  );
  assertOrderedTokens(recoveryPreparationFailure, [
    '${If} $phase7RecoveryMarkerOwned != "0"',
    '!insertmacro phase7CleanupCreatedFreshDirectories',
    '!insertmacro phase7Fail "${MESSAGE}"'
  ], 'Phase 7 pre-registry recovery-marker rollback');
  if (/(?:^|\n)[ \t]*(?:Delete|RMDir|FileOpen|CreateDirectory)[ \t]/u.test(
    recoveryPreparationFailure
  )) {
    throw new Error(
      'Phase 7 pre-registry recovery-marker rollback must not delete or remove a pathname'
    );
  }
  const transactionPreparationFailure = extractNsisMacro(
    normalized,
    'phase7FailTransactionPreparation MESSAGE',
    'Phase 7 installer include'
  );
  if (transactionPreparationFailure.includes('PHASE7_WRITE_PROBE_NAME')
      || /(?:^|\n)[ \t]*(?:Delete|RMDir|FileOpen|CreateDirectory)[ \t]/u.test(
        transactionPreparationFailure
      )) {
    throw new Error(
      'Phase 7 transaction-preparation failure must not remove a pathname'
    );
  }
  const abortOwnedRecoveryMarker = extractNsisMacro(
    normalized,
    'phase7AbortOwnedRecoveryMarker MESSAGE',
    'Phase 7 installer include'
  );
  assertOrderedTokens(abortOwnedRecoveryMarker, [
    '!insertmacro phase7SetHandleDeleteDispositionAndClose'
      + ' $phase7RecoveryMarkerHandle R8',
    'StrCpy $phase7RecoveryMarkerHandle "-1"',
    'StrCpy $phase7RecoveryMarkerOwned "0"',
    '!insertmacro phase7FailRecoveryMarkerPreparation "${MESSAGE}"'
  ], 'Phase 7 handle-owned recovery-marker cleanup');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(abortOwnedRecoveryMarker)) {
    throw new Error(
      'Phase 7 owned recovery-marker cleanup must not delete or reopen the marker by pathname'
    );
  }
  const recoveryMarkerPreparation = extractNsisMacro(
    normalized,
    'phase7WriteRecoveryMarkerForPreparation',
    'Phase 7 installer include'
  );
  assertOrderedTokens(recoveryMarkerPreparation, [
    'StrCpy $phase7RecoveryMarkerOwned "0"',
    'StrCpy $phase7RecoveryMarkerHandle "-1"',
    'KERNEL32::CreateFileW(w "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}",'
      + ' i 0xC0010000, i 0, p 0, i 1, i 0x00200080, p 0) p.R0 ?e',
    'StrCpy $phase7RecoveryMarkerHandle "$R0"',
    'StrCpy $phase7RecoveryMarkerOwned "1"',
    'StrLen $R4 "${PHASE7_RECOVERY_MARKER_VALUE}"',
    'KERNEL32::WriteFile(p $phase7RecoveryMarkerHandle,'
      + ' m "${PHASE7_RECOVERY_MARKER_VALUE}",'
      + ' i R4, *i .R1, p 0) i.R2 ?e',
    'KERNEL32::FlushFileBuffers(p $phase7RecoveryMarkerHandle) i.R2 ?e',
    '!insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle',
    'The committed installation recovery marker verification failed.'
  ], 'Phase 7 pinned recovery-marker write and handle readback');
  if (recoveryMarkerPreparation.includes(
    'Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"'
  ) || recoveryMarkerPreparation.includes(
    'FileOpen $R0 "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}" w'
  ) || recoveryMarkerPreparation.includes('0x04000000')) {
    throw new Error(
      'Phase 7 recovery-marker preparation must not overwrite or path-delete an unowned marker'
    );
  }

  const markerHandleVerification = extractNsisMacro(
    normalized,
    'phase7VerifyMarkerHandle HANDLE MARKER_VALUE OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(markerHandleVerification, [
    'KERNEL32::GetFileInformationByHandle(p ${HANDLE}',
    'IntOp $R4 $R4 & 0x410',
    '${OrIf} $R6 != 1',
    'KERNEL32::GetFileSize(p ${HANDLE}, *i .R6) i.R5 ?e',
    'KERNEL32::SetFilePointer(p ${HANDLE}, i 0, p 0, i 0) i.R5 ?e',
    'KERNEL32::ReadFile(p ${HANDLE}, p R3, i R4, *i .R5, p 0) i.R6 ?e',
    '*$R3(&m${NSIS_MAX_STRLEN} .R6)',
    'StrCmpS "$R6" "${MARKER_VALUE}"',
    'StrCpy $${OUTPUT} "valid"'
  ], 'Phase 7 exact marker handle verification');

  const abortStableMarker = extractNsisMacro(
    normalized,
    'phase7AbortStableMarker MESSAGE',
    'Phase 7 installer include'
  );
  assertOrderedTokens(abortStableMarker, [
    '${If} $phase7StableMarkerCreated == "1"',
    '!insertmacro phase7SetHandleDeleteDispositionAndClose'
      + ' $phase7StableMarkerHandle R8',
    'StrCpy $phase7StableMarkerHandle "-1"',
    '${Else}',
    '!insertmacro phase7CloseHandleVariable phase7StableMarkerHandle R8',
    '!insertmacro phase7Fail "${MESSAGE}"'
  ], 'Phase 7 owned stable-marker failure cleanup');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(abortStableMarker)) {
    throw new Error(
      'Phase 7 stable-marker failure cleanup must not delete or reopen a pathname'
    );
  }

  const stableMarkerWrite = extractNsisMacro(
    normalized,
    'phase7WriteFileMarker MARKER_NAME MARKER_VALUE',
    'Phase 7 installer include'
  );
  assertOrderedTokens(stableMarkerWrite, [
    'StrCpy $phase7StableMarkerCreated "0"',
    'StrCpy $phase7StableMarkerHandle "-1"',
    'KERNEL32::CreateFileW(w "$INSTDIR\\${MARKER_NAME}", i 0xC0010000,'
      + ' i 0, p 0, i 4, i 0x00200080, p 0) p.R0 ?e',
    'StrCpy $phase7StableMarkerHandle "$R0"',
    '${If} $R9 == 0',
    'StrCpy $phase7StableMarkerCreated "1"',
    'KERNEL32::WriteFile(p $phase7StableMarkerHandle, m "${MARKER_VALUE}"',
    'KERNEL32::FlushFileBuffers(p $phase7StableMarkerHandle)',
    '${ElseIf} $R9 != 183',
    '!insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle',
    'The stable installation marker handle identity is invalid.'
  ], 'Phase 7 stable-marker create-or-verify handle lifecycle');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen|FileWrite|FileClose)[ \t]/u.test(
    stableMarkerWrite
  )) {
    throw new Error(
      'Phase 7 stable-marker creation must stay on one exact Win32 handle'
    );
  }

  const recoveryMarkerLease = extractNsisMacro(
    normalized,
    'phase7OpenRecoveryMarkerForTransaction',
    'Phase 7 installer include'
  );
  assertOrderedTokens(recoveryMarkerLease, [
    'StrCpy $phase7RecoveryMarkerHandle "-1"',
    'KERNEL32::CreateFileW(w "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}",'
      + ' i 0x80010000, i 0, p 0, i 3, i 0x00200080, p 0) p.R0 ?e',
    'StrCpy $phase7RecoveryMarkerHandle "$R0"',
    '!insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle',
    '!insertmacro phase7CloseHandleVariable phase7RecoveryMarkerHandle R8'
  ], 'Phase 7 recovery-marker existing-transaction lease');
  if (/(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(recoveryMarkerLease)) {
    throw new Error(
      'Phase 7 recovery-marker lease must not use a pathname after its exact open'
    );
  }

  const beginInstallTransaction = extractNsisMacro(
    normalized,
    'phase7BeginInstallTransaction',
    'Phase 7 installer include'
  );
  assertOrderedTokens(beginInstallTransaction, [
    '!insertmacro phase7EnsureTransactionRoot',
    '${If} $phase7InstallState == "recovering"',
    '!insertmacro phase7OpenRecoveryMarkerForTransaction',
    '${Else}',
    '!insertmacro phase7WriteRecoveryMarkerForPreparation',
    '!insertmacro phase7ReleaseCreatedFreshDirectoryHandles',
    'WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"'
  ], 'Phase 7 recovery identity before registry commit');
  if (beginInstallTransaction.includes(
    'Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"'
  ) || beginInstallTransaction.includes('!insertmacro phase7CleanupCreatedFreshDirectories')) {
    throw new Error(
      'Phase 7 must preserve a committed recovery marker when registry commit fails'
    );
  }
  if (beginInstallTransaction.includes(
    'KERNEL32::CloseHandle(p $phase7RecoveryMarkerHandle)'
  ) || beginInstallTransaction.includes(
    '!insertmacro phase7CloseHandleVariable phase7RecoveryMarkerHandle'
  )) {
    throw new Error(
      'Phase 7 recovery marker handle must remain pinned through registry and extraction'
    );
  }

  const stableMarkerInstallWrite = extractNsisMacro(
    normalized,
    'phase7WriteInstallMarker',
    'Phase 7 installer include'
  );
  assertOrderedTokens(stableMarkerInstallWrite, [
    '!insertmacro phase7WriteFileMarker'
      + ' "${PHASE7_INSTALL_MARKER_NAME}" "${PHASE7_INSTALL_MARKER_VALUE}"',
    '!insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle'
      + ' "${PHASE7_INSTALL_MARKER_VALUE}" R0'
  ], 'Phase 7 stable marker pinned install write');
  if (stableMarkerInstallWrite.includes(
    'KERNEL32::CloseHandle(p $phase7StableMarkerHandle)'
  ) || stableMarkerInstallWrite.includes(
    '!insertmacro phase7CloseHandleVariable phase7StableMarkerHandle'
  )) {
    throw new Error(
      'Phase 7 stable marker handle must remain pinned through installed-identity verification'
    );
  }

  const installedIdentityVerification = extractNsisMacro(
    normalized,
    'phase7VerifyInstalledIdentity',
    'Phase 7 installer include'
  );
  assertOrderedTokens(installedIdentityVerification, [
    '!insertmacro phase7RejectReparseTree "$INSTDIR"',
    '!insertmacro phase7AssertKnownRootEntries "$INSTDIR"',
    '!insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle',
    '!insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle'
  ], 'Phase 7 installed marker handle verification');
  if (installedIdentityVerification.includes(
    '!insertmacro phase7AssertRequiredNonEmptyFile "${PHASE7_INSTALL_MARKER_NAME}"'
  ) || installedIdentityVerification.includes(
    '!insertmacro phase7AssertRequiredNonEmptyFile "${PHASE7_RECOVERY_MARKER_NAME}"'
  ) || installedIdentityVerification.includes('!insertmacro phase7ReadAndVerifyMarker')) {
    throw new Error(
      'Phase 7 installed identity must verify pinned marker handles without pathname reopen'
    );
  }

  const installTransactionCommit = extractNsisMacro(
    normalized,
    'phase7CommitInstallTransaction',
    'Phase 7 installer include'
  );
  assertOrderedTokens(installTransactionCommit, [
    '!insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle',
    '!insertmacro phase7VerifyMarkerHandle $phase7RecoveryMarkerHandle',
    '!insertmacro phase7SetHandleDeleteDispositionAndClose'
      + ' $phase7RecoveryMarkerHandle R8',
    'StrCpy $phase7RecoveryMarkerHandle "-1"',
    'StrCpy $phase7RecoveryMarkerOwned "0"',
    '!insertmacro phase7CloseHandleVariable phase7StableMarkerHandle R8'
  ], 'Phase 7 recovery-marker handle commit');
  if (installTransactionCommit.includes('${FileExists}')
      || /(?:^|\n)[ \t]*(?:Delete|FileOpen)[ \t]/u.test(installTransactionCommit)) {
    throw new Error(
      'Phase 7 recovery-marker commit must delete only the transaction-pinned handle'
    );
  }

  if (countExactOccurrences(normalized, 'KERNEL32::CreateFileW') !== 5
      || countExactOccurrences(normalized, 'KERNEL32::SetFileInformationByHandle') !== 2) {
    throw new Error(
      'Phase 7 must bind exactly the audited parent, probe, stable, and recovery handles'
    );
  }
  if (countExactOccurrences(normalized, 'ntdll::NtCreateFile') !== 1
      || countExactOccurrences(normalized, 'KERNEL32::CreateDirectoryW') !== 0
      || /(?:^|\n)[ \t]*CreateDirectory[ \t]/u.test(normalized)) {
    throw new Error(
      'Phase 7 fresh directories must be created only by the one audited parent-relative NtCreateFile macro'
    );
  }

  const appDataCleanup = extractNsisMacro(
    normalized,
    'phase7DeleteExactAppDataTree LEAF_NAME OUTPUT',
    'Phase 7 installer include'
  );
  if (countExactOccurrences(appDataCleanup, 'RMDir /r "$R0"') !== 1) {
    throw new Error('Phase 7 recursive deletion must be confined to exact AppData cleanup');
  }
  const customUnInit = extractNsisMacro(
    normalized,
    'customUnInit',
    'Phase 7 installer include'
  );
  if (customUnInit !== [
    '!macro customUnInit',
    '    !insertmacro phase7VerifyUninstallRoot',
    '  !macroend'
  ].join('\n')) {
    throw new Error('Phase 7 customUnInit must perform only the exact uninstall-root verification');
  }
  const stagedRoot = extractNsisMacro(
    normalized,
    'phase7StageVerifiedInstallRoot',
    'Phase 7 installer include'
  );
  assertOrderedTokens(stagedRoot, [
    'Rename "$phase7TransactionSource" "$phase7TransactionStage"',
    '!insertmacro phase7PersistUninstallTransaction "staged-uncommitted" R4',
    '!insertmacro phase7FindExactAppProcessAtRoot "$phase7TransactionSource" R4',
    '!insertmacro phase7FindExactAppProcessAtRoot "$phase7TransactionStage" R4',
    '${If} $R4 != "not-running"',
    '!insertmacro phase7RollbackAtomicRootStage R5'
  ], 'Phase 7 post-stage process-race closure');

  const transactionPathValidation = extractNsisMacro(
    normalized,
    'phase7ValidateUninstallTransactionPaths',
    'Phase 7 installer include'
  );
  if (/GetFullPathName[^\n]*\$phase7Transaction(?:Source|Stage)/u.test(
    transactionPathValidation
  )) {
    throw new Error(
      'Phase 7 transaction path validation must not canonicalize a transaction root that can legitimately be absent'
    );
  }
  assertOrderedTokens(transactionPathValidation, [
    '${GetFileName} "$phase7TransactionSource" $R2',
    '${GetFileName} "$phase7TransactionStage" $R3',
    '${GetParent} "$phase7TransactionSource" $R0',
    '${GetParent} "$phase7TransactionStage" $R1',
    'StrCpy $R0 "$R0\\"',
    'StrCpy $R1 "$R1\\"',
    'GetFullPathName $R4 "$R0"',
    'GetFullPathName $R5 "$R1"',
    'KERNEL32::lstrcmpiW(w R4, w R5)',
    'StrCpy $R0 "$R4${APP_FILENAME}"',
    'StrCpy $R0 "$R4\\${APP_FILENAME}"',
    'KERNEL32::lstrcmpiW(w R0, w "$phase7TransactionSource")',
    'StrCpy $R1 "$R4$R3"',
    'StrCpy $R1 "$R4\\$R3"',
    'KERNEL32::lstrcmpiW(w R1, w "$phase7TransactionStage")'
  ], 'Phase 7 absent-root-safe transaction path validation');

  const registryWritableProbe = extractNsisMacro(
    normalized,
    'phase7ProbeRegistryWritable',
    'Phase 7 installer include'
  );
  if (registryWritableProbe.includes(
    '!insertmacro phase7ProbeRegistryKeyWritable "${INSTALL_REGISTRY_KEY}"'
  ) || registryWritableProbe.includes(
    '!insertmacro phase7ProbeRegistryKeyWritable "${UNINSTALL_REGISTRY_KEY}"'
  )) {
    throw new Error('Phase 7 registry writability probe must not mutate canonical identity keys');
  }
  for (const required of [
    '!define PHASE7_INSTALL_REGISTRY_PROBE_KEY "${INSTALL_REGISTRY_KEY}.Phase7WriteProbe"',
    '!define PHASE7_UNINSTALL_REGISTRY_PROBE_KEY "${UNINSTALL_REGISTRY_KEY}.Phase7WriteProbe"',
    '!insertmacro phase7ProbeRegistryKeyWritable "${PHASE7_INSTALL_REGISTRY_PROBE_KEY}"',
    '!insertmacro phase7ProbeRegistryKeyWritable "${PHASE7_UNINSTALL_REGISTRY_PROBE_KEY}"'
  ]) {
    if (!normalized.includes(required)) {
      throw new Error(`Phase 7 registry writability probe lacks owned sibling scratch binding: ${required}`);
    }
  }

  const freshTargetValidation = extractNsisMacro(
    normalized,
    'phase7ValidateFreshTarget',
    'Phase 7 installer include'
  );
  for (const required of [
    '!define PHASE7_FRESH_TARGET_ID ${__LINE__}',
    'phase7_fresh_empty_loop_${PHASE7_FRESH_TARGET_ID}:',
    'phase7_fresh_empty_next_${PHASE7_FRESH_TARGET_ID}:',
    'phase7_fresh_empty_done_${PHASE7_FRESH_TARGET_ID}:',
    '!undef PHASE7_FRESH_TARGET_ID'
  ]) {
    if (!freshTargetValidation.includes(required)) {
      throw new Error(
        `Phase 7 repeated fresh-target validation must use expansion-unique labels: ${required}`
      );
    }
  }

  const atomicStagePreparation = extractNsisMacro(
    normalized,
    'phase7PrepareAtomicRootStage',
    'Phase 7 installer include'
  );
  if (/GetFullPathName[ \t]+\$phase7TransactionStage\b/u.test(
    atomicStagePreparation
  )) {
    throw new Error(
      'Phase 7 atomic staging must not canonicalize the not-yet-created staging root'
    );
  }
  assertOrderedTokens(atomicStagePreparation, [
    '!insertmacro phase7AcquireUninstallMutex',
    '!insertmacro phase7ProbeRegistryWritable',
    '!insertmacro phase7VerifyUninstallRoot',
    'GetFullPathName $phase7TransactionSource "$phase7RegisteredPath"',
    '${GetParent} "$phase7TransactionSource" $R0',
    'StrCpy $R0 "$R0\\"',
    'GetFullPathName $R3 "$R0"',
    'StrCpy $phase7TransactionStage "$R3${PHASE7_STAGE_PREFIX}-$R1-$R2"',
    'StrCpy $phase7TransactionStage "$R3\\${PHASE7_STAGE_PREFIX}-$R1-$R2"',
    '!insertmacro phase7ValidateUninstallTransactionPaths',
    '!insertmacro phase7ReadPathState "$phase7TransactionStage"'
  ], 'Phase 7 absent-stage-safe atomic staging preparation');

  const committedCleanup = extractNsisMacro(
    normalized,
    'phase7CleanupCommittedStage OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(committedCleanup, [
    'Call ${PHASE7_COMMITTED_DELETE_FUNCTION}',
    '!insertmacro phase7InspectCleanupRoot "$phase7TransactionStage"',
    '$phase7CleanupRootState != "marker-only"',
    'Delete "$phase7TransactionStage\\${PHASE7_INSTALL_MARKER_NAME}"',
    '!insertmacro phase7ReadPathState'
      + ' "$phase7TransactionStage\\${PHASE7_INSTALL_MARKER_NAME}"',
    '!insertmacro phase7InspectCleanupRoot "$phase7TransactionStage"',
    '$phase7CleanupRootState != "empty"',
    'RMDir "$phase7TransactionStage"'
  ], 'Phase 7 marker-last committed cleanup');

  for (const [declaration, resultVariable, initialResult] of [
    ['phase7ReadRegistryBackupLayout OUTPUT', 'phase7RegistryLayoutResult', 'error'],
    ['phase7BackupProductRegistry OUTPUT', 'phase7RegistryOperationResult', 'failed'],
    ['phase7DeleteProductRegistryOriginals OUTPUT', 'phase7RegistryOperationResult', 'failed'],
    ['phase7RestoreProductRegistryBackup OUTPUT', 'phase7RegistryOperationResult', 'failed'],
    [
      'phase7DeleteRollbackRegistryBackups OUTPUT',
      'phase7RegistryOperationResult',
      'cleanup-failed'
    ],
    [
      'phase7DeleteCommittedRegistryBackups OUTPUT',
      'phase7RegistryOperationResult',
      'cleanup-failed'
    ],
    ['phase7ClaimUninstallTransaction OUTPUT', 'phase7TransactionClaimResult', 'failed'],
    [
      'phase7PersistUninstallTransaction TRANSACTION_STATE OUTPUT',
      'phase7TransactionWriteResult',
      'failed'
    ],
    ['phase7ClearUninstallTransaction OUTPUT', 'phase7TransactionClearResult', 'failed'],
    [
      'phase7AdvanceCommittedRootCleanup OUTPUT',
      'phase7CommittedCleanupResult',
      'pending'
    ],
    [
      'phase7RunPostCommitCleanup OUTPUT',
      'phase7PostCleanupOperationResult',
      'cleanup-failed'
    ],
    [
      'phase7CompleteCommittedPostCleanup OUTPUT',
      'phase7PostCleanupResult',
      'pending'
    ],
    ['phase7RollbackUninstallTransaction OUTPUT', 'phase7RollbackResult', 'failed'],
    ['phase7CommitAtomicUninstallRegistry OUTPUT', 'phase7CommitResult', 'pending']
  ]) {
    const macro = extractNsisMacro(normalized, declaration, 'Phase 7 installer include');
    const outputCopy = 'StrCpy $${OUTPUT} "$' + resultVariable + '"';
    assertOrderedTokens(macro, [
      `StrCpy $${resultVariable} "${initialResult}"`,
      outputCopy
    ], `Phase 7 ${declaration} dedicated result`);
    if (countExactOccurrences(macro, 'StrCpy $${OUTPUT}') !== 1
        || countExactOccurrences(macro, outputCopy) !== 1) {
      throw new Error(
        `Phase 7 ${declaration} must publish only its dedicated fixed-enum result`
      );
    }
  }

  const registryCommit = extractNsisMacro(
    normalized,
    'phase7CommitAtomicUninstallRegistry OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(registryCommit, [
    '!insertmacro phase7BackupProductRegistry R4',
    '!insertmacro phase7PersistUninstallTransaction "registry-backups-ready" R4',
    '!insertmacro phase7PersistUninstallTransaction "registry-delete-started" R4',
    '!insertmacro phase7DeleteProductRegistryOriginals R4',
    '!insertmacro phase7PersistUninstallTransaction "committed-cleanup" R4',
    'StrCpy $${OUTPUT} "$phase7CommitResult"'
  ], 'Phase 7 product registry commit');

  const rollback = extractNsisMacro(
    normalized,
    'phase7RollbackUninstallTransaction OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(rollback, [
    '!insertmacro phase7PersistUninstallTransaction "rollback-rebuild-ready" R6',
    '!insertmacro phase7RestoreProductRegistryBackup R4',
    '!insertmacro phase7AssertRestoredStableRegistryIdentity',
    '!insertmacro phase7PersistUninstallTransaction "rollback-registry-restored" R4',
    '!insertmacro phase7AssertRestoredStableRegistryIdentity',
    '!insertmacro phase7DeleteRollbackRegistryBackups R4',
    '!insertmacro phase7ClearUninstallTransaction R4',
    'StrCpy $${OUTPUT} "$phase7RollbackResult"'
  ], 'Phase 7 registry rollback');

  const committedAdvance = extractNsisMacro(
    normalized,
    'phase7AdvanceCommittedRootCleanup OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(committedAdvance, [
    '!insertmacro phase7CleanupCommittedStage R4',
    '!insertmacro phase7DeleteCommittedRegistryBackups R4',
    '!insertmacro phase7PersistUninstallTransaction "committed-postcleanup" R4'
  ], 'Phase 7 committed root cleanup');
  const postCleanup = extractNsisMacro(
    normalized,
    'phase7CompleteCommittedPostCleanup OUTPUT',
    'Phase 7 installer include'
  );
  assertOrderedTokens(postCleanup, [
    '!insertmacro phase7RunPostCommitCleanup R4',
    '!insertmacro phase7ClearUninstallTransaction R4'
  ], 'Phase 7 committed external cleanup');
  const recovery = extractNsisMacro(
    normalized,
    'phase7RecoverPendingUninstallTransaction',
    'Phase 7 installer include'
  );
  if (!recovery.includes('$phase7TransactionState == "committed-postcleanup"')
      || !recovery.includes('!insertmacro phase7CompleteCommittedPostCleanup R6')) {
    throw new Error('Phase 7 recovery must replay committed post-cleanup');
  }
}

function assertInstallerIncludeContent(installerIncludeContent) {
  if (typeof installerIncludeContent !== 'string') {
    throw new TypeError('electron-builder audited installer include content must be a string');
  }
  const normalized = normalizeNewlines(installerIncludeContent);
  if (sha256(normalized) !== auditedInstallerIncludeSha256) {
    throw new Error(
      'electron-builder audited Phase 7 installer include SHA-256 is not exact'
    );
  }
  assertPhase7InstallerIncludeSemantics(normalized);
}

export function assertElectronBuilderSigningPolicy(configuration, installerIncludeContent) {
  if (typeof configuration !== 'string') {
    throw new TypeError('electron-builder configuration must be a string');
  }
  const parsed = parseConfiguration(configuration);
  assertParsedConfiguration(parsed);
  assertInstallerIncludeContent(installerIncludeContent);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function computePackageTreeIdentity(rootPath) {
  const root = await realpath(resolve(rootPath));
  const rows = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (info.isSymbolicLink()) {
        throw new Error(`audited package tree contains a symlink or junction: ${relativePath}`);
      }
      if (directory === root && entry.name === 'node_modules') {
        if (!info.isDirectory()) {
          throw new Error('audited package root node_modules must be a regular directory');
        }
        const dependencyEntries = await readdir(path, { withFileTypes: true });
        if (dependencyEntries.length !== 1
            || dependencyEntries[0].name !== '.bin'
            || !dependencyEntries[0].isDirectory()) {
          throw new Error(
            'audited package root node_modules may contain only pnpm generated .bin wrappers'
          );
        }
        const binPath = resolve(path, '.bin');
        const binInfo = await lstat(binPath);
        if (binInfo.isSymbolicLink() || !binInfo.isDirectory()) {
          throw new Error('audited package node_modules/.bin must be a regular directory');
        }
        const wrappers = await readdir(binPath, { withFileTypes: true });
        wrappers.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        );
        for (const wrapper of wrappers) {
          const wrapperPath = resolve(binPath, wrapper.name);
          const wrapperInfo = await lstat(wrapperPath);
          if (wrapperInfo.isSymbolicLink() || !wrapperInfo.isFile()) {
            throw new Error(
              `audited package generated wrapper must be a regular file: ${wrapper.name}`
            );
          }
          // pnpm embeds the absolute checkout path in these generated wrappers.
          // They are never executed by the release path, which invokes the
          // audited root electron-builder CLI directly. Bind their exact names
          // while excluding only their machine-specific generated bytes.
          rows.push(`node_modules/.bin/${wrapper.name}\0PNPM_GENERATED_WRAPPER\n`);
        }
        continue;
      }
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(`audited package tree contains a non-regular entry: ${relativePath}`);
      }
      const bytes = await readFile(path);
      if (bytes.length !== info.size) {
        throw new Error(`audited package tree file changed while hashing: ${relativePath}`);
      }
      rows.push(`${relativePath}\0${bytes.length}\0${sha256(bytes)}\n`);
    }
  }

  await visit(root);
  return {
    fileCount: rows.length,
    sha256: sha256(rows.join(''))
  };
}

function assertPackageTreeIdentity(actual, expected, label) {
  if (!isMapping(actual)
      || actual.fileCount !== expected.fileCount
      || actual.sha256 !== expected.sha256) {
    throw new Error(
      `${label} package tree identity is not exact: `
      + `expected ${expected.fileCount}/${expected.sha256}, `
      + `got ${actual?.fileCount}/${actual?.sha256}`
    );
  }
}

export function assertPhase7InstallUtilSemantics(installUtilContent) {
  if (!(typeof installUtilContent === 'string' || Buffer.isBuffer(installUtilContent))) {
    throw new TypeError('app-builder-lib installUtil.nsh content must be a string or Buffer');
  }
  const installUtil = normalizeNewlines(installUtilContent.toString('utf8'));
  for (const forbidden of [
    '!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"',
    '$PLUGINSDIR\\old-uninstaller.exe',
    'TryInPlace:',
    'ExecWait \'"$uninstallerFileName"',
    'UninstallLoop:',
    'OneMoreAttempt:',
    'CheckResult:',
    'Goto UninstallLoop',
    'Goto OneMoreAttempt',
    'MB_RETRYCANCEL',
    'Sleep 1000'
  ]) {
    if (installUtil.includes(forbidden)) {
      throw new Error(
        `Phase 7 current-version upgrade uninstaller must not contain ${forbidden}`
      );
    }
  }
  assertOrderedTokens(installUtil, [
    'StrCpy $uninstallString "$phase7RegisteredUninstallString"',
    'StrCpy $installationDir "$phase7RegisteredPath"',
    'InitPluginsDir',
    'StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\phase7-current-uninstaller.exe"',
    'ClearErrors',
    'SetOutPath "$PLUGINSDIR"',
    'File "/oname=phase7-current-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"',
    '${if} ${errors}',
    'SetErrors',
    'Return',
    '${endif}',
    'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
    'ifErrors DoesNotExist',
    'Return',
    'DoesNotExist:',
    'SetErrors'
  ], 'Phase 7 current-version upgrade uninstaller launch');
  const execWaitLines = installUtil.match(/^[ \t]*ExecWait\b.*$/gmu) ?? [];
  if (execWaitLines.length !== 1) {
    throw new Error(
      `Phase 7 current-version upgrade uninstaller must contain exactly one ExecWait, got ${execWaitLines.length}`
    );
  }
  const expectedExecWait =
    'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0';
  if (execWaitLines[0].trim() !== expectedExecWait) {
    throw new Error(
      'Phase 7 current-version upgrade uninstaller ExecWait must target only the embedded current helper'
    );
  }
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} could not be parsed: ${error.message}`, { cause: error });
  }
  if (!isMapping(parsed)) throw new Error(`${label} must be a mapping`);
  return parsed;
}

function assertPatchedTemplate(templateBytes, expectedSha256, label, required, forbidden = []) {
  if (sha256(templateBytes) !== expectedSha256) {
    throw new Error(`patched app-builder-lib ${label} template SHA-256 is not exact`);
  }
  const normalized = normalizeNewlines(templateBytes.toString('utf8'));
  for (const value of required) {
    if (!normalized.includes(value)) {
      throw new Error(`patched app-builder-lib ${label} must contain ${value}`);
    }
  }
  for (const value of forbidden) {
    if (normalized.includes(value)) {
      throw new Error(`patched app-builder-lib ${label} must not contain ${value}`);
    }
  }
  if (/(^|[\r\n])[ \t]*(?:FindFirst|FindNext)[ \t]/u.test(normalized)
      || /(?:powershell(?:\.exe)?|pwsh|Get-CimInstance|Get-WmiObject|Win32_Process|Start-Process|Stop-Process|\.StartsWith\(|taskkill(?:\.exe)?|wmic|SystemComponent)/iu.test(normalized)
      || /System::Call[^\n]*\b[pwi](?:\.|[ \t]+\.?)r[0-9]\b/u.test(normalized)) {
    throw new Error(`patched app-builder-lib ${label} contains forbidden Phase 7 process or register semantics`);
  }
}

export function assertPhase7AppBuilderPatchHeaders(patchBytes) {
  if (!(typeof patchBytes === 'string' || Buffer.isBuffer(patchBytes))) {
    throw new TypeError('app-builder-lib Phase 7 patch bytes must be a string or Buffer');
  }
  const patchHeaders = [
    ...normalizeNewlines(patchBytes.toString('utf8'))
      .matchAll(/^diff --git a\/([^\n]+) b\/([^\n]+)$/gmu)
  ].map((match) => {
    if (match[1] !== match[2]) {
      throw new Error('app-builder-lib Phase 7 patch must not rename template paths');
    }
    return match[1];
  });
  const exactPatchedTemplatePaths = [
    'templates/nsis/assistedInstaller.nsh',
    'templates/nsis/include/extractAppPackage.nsh',
    'templates/nsis/include/installUtil.nsh',
    'templates/nsis/installSection.nsh',
    'templates/nsis/installer.nsi',
    'templates/nsis/uninstaller.nsh'
  ];
  if (JSON.stringify(patchHeaders) !== JSON.stringify(exactPatchedTemplatePaths)) {
    throw new Error(
      'app-builder-lib Phase 7 patch must change exactly the six audited NSIS templates'
    );
  }
}

export function assertAppBuilderPatchPolicy({
  rootPackageBytes,
  gitAttributesBytes,
  workspaceBytes,
  lockfileBytes,
  patchBytes,
  fluentPatchBytes,
  electronBuilderPackageBytes,
  electronBuilderCliBytes,
  electronBuilderTree,
  appBuilderPackageBytes,
  assistedInstallerTemplateBytes,
  installerTemplateBytes,
  installSectionTemplateBytes,
  uninstallerTemplateBytes,
  extractAppPackageTemplateBytes,
  installUtilTemplateBytes,
  appBuilderTree,
  fluentPackageBytes,
  fluentLicenseBytes,
  noticeGeneratorBytes
}) {
  const rootPackage = parseJsonObject(rootPackageBytes, 'root package.json');
  if (sha256(gitAttributesBytes) !== auditedGitAttributesSha256
      || gitAttributesBytes.toString('utf8')
        !== 'patches/app-builder-lib@26.15.3.patch text eol=lf\n') {
    throw new Error(
      'repository .gitattributes must pin the app-builder-lib patch to exact LF bytes'
    );
  }
  const electronBuilderPackage = parseJsonObject(
    electronBuilderPackageBytes,
    'installed electron-builder package.json'
  );
  const appBuilderPackage = parseJsonObject(
    appBuilderPackageBytes,
    'installed app-builder-lib package.json'
  );
  const fluentPackage = parseJsonObject(
    fluentPackageBytes,
    'installed @fluentui/react-icons package.json'
  );
  let workspace;
  try {
    workspace = load(workspaceBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`pnpm workspace could not be parsed: ${error.message}`, { cause: error });
  }
  if (!isMapping(workspace)) throw new Error('pnpm workspace must be a mapping');
  let lockfile;
  try {
    lockfile = load(lockfileBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`pnpm lockfile could not be parsed: ${error.message}`, { cause: error });
  }
  if (!isMapping(lockfile)) throw new Error('pnpm lockfile must be a mapping');

  const patchKey = 'app-builder-lib@26.15.3';
  const fluentPackageName = '@fluentui/react-icons';
  const fluentPatchKey = '@fluentui/react-icons@2.0.316';
  const electronBuilderKey = 'electron-builder@26.15.3';
  const lockedElectronBuilderVersion =
    '26.15.3(electron-builder-squirrel-windows@26.15.3)';
  const lockedPatchedAppBuilderVersion =
    `26.15.3(patch_hash=${auditedAppBuilderPatchSha256})(dmg-builder@26.15.3)`
    + '(electron-builder-squirrel-windows@26.15.3)';
  if (rootPackage.packageManager !== 'pnpm@10.32.1') {
    throw new Error('root package.json must pin packageManager exactly to pnpm@10.32.1');
  }
  if (rootPackage.devDependencies?.['electron-builder'] !== '26.15.3') {
    throw new Error('root package.json must pin electron-builder exactly to 26.15.3');
  }
  if (own(rootPackage, 'pnpm')) {
    throw new Error('root package.json must not shadow pnpm workspace patch policy');
  }
  assertExactKeys(
    workspace,
    ['onlyBuiltDependencies', 'packages', 'patchedDependencies'],
    'pnpm workspace'
  );
  assertExactArray(
    workspace.packages,
    ['apps/*', 'packages/*'],
    'pnpm workspace packages must be exact'
  );
  assertExactArray(
    workspace.onlyBuiltDependencies,
    ['electron', 'esbuild'],
    'pnpm workspace onlyBuiltDependencies must be exact'
  );
  assertExactKeys(
    workspace.patchedDependencies,
    [fluentPatchKey, patchKey],
    'pnpm workspace patchedDependencies'
  );
  if (workspace.patchedDependencies?.[patchKey] !== auditedAppBuilderPatchPath
      || workspace.patchedDependencies?.[fluentPatchKey] !== auditedFluentIconsPatchPath) {
    throw new Error('pnpm workspace must pin both exact reviewed patch paths');
  }
  assertExactKeys(
    lockfile.patchedDependencies,
    [fluentPatchKey, patchKey],
    'pnpm lockfile patchedDependencies'
  );
  const importerElectronBuilder = lockfile.importers?.['.']?.devDependencies?.['electron-builder'];
  if (!isMapping(importerElectronBuilder)
      || importerElectronBuilder.specifier !== '26.15.3'
      || importerElectronBuilder.version !== lockedElectronBuilderVersion) {
    throw new Error('pnpm lockfile root importer must pin the exact electron-builder 26.15.3 snapshot');
  }
  if (lockfile.packages?.[electronBuilderKey]?.resolution?.integrity
      !== auditedElectronBuilderIntegrity) {
    throw new Error('pnpm lockfile must bind the exact electron-builder 26.15.3 integrity');
  }
  if (lockfile.packages?.[patchKey]?.resolution?.integrity !== auditedAppBuilderIntegrity) {
    throw new Error('pnpm lockfile must bind the exact app-builder-lib 26.15.3 integrity');
  }
  if (lockfile.packages?.[fluentPatchKey]?.resolution?.integrity
      !== auditedFluentIconsIntegrity) {
    throw new Error('pnpm lockfile must bind the exact @fluentui/react-icons 2.0.316 integrity');
  }
  const lockPatch = lockfile.patchedDependencies?.[patchKey];
  if (!isMapping(lockPatch)
      || lockPatch.path !== auditedAppBuilderPatchPath
      || lockPatch.hash !== auditedAppBuilderPatchSha256) {
    throw new Error('pnpm lockfile must bind the exact app-builder-lib Phase 7 patch hash and path');
  }
  if (sha256(patchBytes) !== auditedAppBuilderPatchSha256) {
    throw new Error('app-builder-lib Phase 7 patch SHA-256 is not exact');
  }
  if (sha256(normalizeNewlines(patchBytes.toString('utf8')))
      !== auditedAppBuilderPatchSha256) {
    throw new Error('app-builder-lib Phase 7 patch pnpm-normalized hash is not exact');
  }
  assertPhase7AppBuilderPatchHeaders(patchBytes);
  const fluentLockPatch = lockfile.patchedDependencies?.[fluentPatchKey];
  if (!isMapping(fluentLockPatch)
      || fluentLockPatch.path !== auditedFluentIconsPatchPath
      || fluentLockPatch.hash !== auditedFluentIconsPnpmPatchHash) {
    throw new Error(
      'pnpm lockfile must bind the exact @fluentui/react-icons LICENSE patch hash and path'
    );
  }
  if (sha256(fluentPatchBytes) !== auditedFluentIconsPatchSha256) {
    throw new Error('@fluentui/react-icons LICENSE patch SHA-256 is not exact');
  }
  if (sha256(normalizeNewlines(fluentPatchBytes.toString('utf8')))
      !== auditedFluentIconsPnpmPatchHash) {
    throw new Error('@fluentui/react-icons LICENSE patch pnpm-normalized hash is not exact');
  }
  const desktopFluent = lockfile.importers?.['apps/desktop']?.dependencies?.[fluentPackageName];
  const lockedFluentVersion =
    `2.0.316(patch_hash=${auditedFluentIconsPnpmPatchHash})(react@19.2.7)`;
  if (!isMapping(desktopFluent)
      || desktopFluent.specifier !== '^2.0.316'
      || desktopFluent.version !== lockedFluentVersion) {
    throw new Error(
      'pnpm lockfile desktop importer must resolve the exact patched @fluentui/react-icons snapshot'
    );
  }
  const matchingElectronBuilderSnapshots = Object.entries(lockfile.snapshots ?? {})
    .filter(([key]) => key.startsWith(`${electronBuilderKey}(`));
  if (matchingElectronBuilderSnapshots.length !== 1
      || matchingElectronBuilderSnapshots[0][0] !== electronBuilderKey
        + '(electron-builder-squirrel-windows@26.15.3)'
      || matchingElectronBuilderSnapshots[0][1]?.dependencies?.['app-builder-lib']
        !== lockedPatchedAppBuilderVersion) {
    throw new Error(
      'pnpm lockfile electron-builder snapshot must resolve the exact patched app-builder-lib instance'
    );
  }
  if (electronBuilderPackage.name !== 'electron-builder'
      || electronBuilderPackage.version !== '26.15.3'
      || electronBuilderPackage.dependencies?.['app-builder-lib'] !== '26.15.3'
      || electronBuilderPackage.bin?.['electron-builder'] !== './cli.js') {
    throw new Error(
      'installed electron-builder identity, CLI, and app-builder-lib dependency must be exact'
    );
  }
  if (sha256(electronBuilderCliBytes) !== auditedElectronBuilderCliSha256) {
    throw new Error('installed electron-builder CLI SHA-256 is not exact');
  }
  assertPackageTreeIdentity(
    electronBuilderTree,
    auditedElectronBuilderTree,
    'installed electron-builder'
  );
  if (appBuilderPackage.name !== 'app-builder-lib'
      || appBuilderPackage.version !== '26.15.3') {
    throw new Error('installed app-builder-lib identity must be exactly 26.15.3');
  }
  assertPatchedTemplate(
    assistedInstallerTemplateBytes,
    auditedPatchedAssistedInstallerTemplateSha256,
    'assisted installer',
    ['!insertmacro phase7DirectoryPagePre', '!insertmacro phase7PrepareFreshTarget'],
    ['${StrContains} $0 "${APP_FILENAME}" $INSTDIR']
  );
  assertPatchedTemplate(
    installerTemplateBytes,
    auditedPatchedInstallerTemplateSha256,
    'installer',
    ['SetOutPath $TEMP', '!insertmacro phase7InitCurrentUser'],
    ['SetOutPath $INSTDIR\n  ${LogSet} on', '!insertmacro initMultiUser']
  );
  assertPatchedTemplate(
    installSectionTemplateBytes,
    auditedPatchedInstallSectionTemplateSha256,
    'install section',
    [
      '!insertmacro phase7ValidateInstallTargetBeforeMutation',
      '!insertmacro phase7ProbeRegistryWritable',
      '!insertmacro phase7SetVerifiedLinkVars',
      '!insertmacro phase7AcquireUninstallMutex',
      '!insertmacro phase7AssertNoConcurrentUninstallBoundary',
      'StrCpy $R1 "$phase7RegisteredKeepShortcuts"',
      '!insertmacro phase7ReleaseUninstallMutex',
      '!insertmacro uninstallOldVersion HKEY_CURRENT_USER',
      '!insertmacro phase7ReleaseUninstallMutex\n  !insertmacro uninstallOldVersion HKEY_CURRENT_USER',
      '!insertmacro handleUninstallResult HKEY_CURRENT_USER\n  !insertmacro phase7AcquireUninstallMutex\n  !insertmacro phase7AssertNoConcurrentUninstallBoundary',
      '!insertmacro phase7BeginInstallTransaction',
      '!insertmacro phase7BeginInstallTransaction\nClearErrors\nSetOutPath $INSTDIR',
      'One or more application files could not be installed.',
      '!insertmacro phase7WriteInstallMarker',
      '!insertmacro phase7VerifyInstalledIdentity',
      '!insertmacro phase7CommitInstallTransaction'
    ],
    [
      'phase7VerifyPhase5N1Path',
      '!insertmacro setLinkVars',
      'ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts',
      '!insertmacro uninstallOldVersion SHELL_CONTEXT',
      'phase7PrepareSameVolumeStage',
      'phase7VerifyRollbackDestination',
      'phase7DiscardRestoredStageShells',
      'phase7RemoveVerifiedInstallRoot',
      'phase7DiscardSameVolumeStage',
      'Call un.atomicRMDir',
      '$phase7StageDir'
    ]
  );
  assertPatchedTemplate(
    uninstallerTemplateBytes,
    auditedPatchedUninstallerTemplateSha256,
    'uninstaller',
    [
      '!insertmacro phase7AcquireUninstallMutex\n  !insertmacro phase7InitCurrentUser\n  !insertmacro phase7AcquireUninstallMutex',
      '!insertmacro phase7InitCurrentUser',
      '!insertmacro phase7VerifyUninstallRoot',
      '!insertmacro phase7StageVerifiedInstallRoot',
      '!insertmacro phase7CommitAtomicUninstallRegistry R0',
      '!insertmacro phase7FinishCommittedAtomicUninstall R0',
      '!insertmacro phase7CompleteCommittedPostCleanup R0',
      'does not support customRemoveFiles outside its audited atomic transaction.',
      'must add file-association cleanup to its durable transaction before enabling associations.'
    ],
    [
      '!insertmacro initMultiUser',
      '!insertmacro setLinkVars',
      '!insertmacro phase7ReleaseUninstallMutex',
      'RMDir /r $INSTDIR',
      '$PLUGINSDIR\\old-install',
      'GetLastError() i.r5',
      'GetFileAttributesW(w r3) i.r3',
      'phase7PrepareSameVolumeStage',
      'phase7VerifyRollbackDestination',
      'phase7DiscardRestoredStageShells',
      'phase7RemoveVerifiedInstallRoot',
      'phase7DiscardSameVolumeStage',
      'Call un.atomicRMDir',
      '$phase7StageDir'
    ]
  );
  assertPatchedTemplate(
    extractAppPackageTemplateBytes,
    auditedPatchedExtractAppPackageTemplateSha256,
    'extract application package',
    [
      'nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
      '${If} $R0 != "success"',
      '/SD IDCANCEL IDRETRY RetryExtract7za IDCANCEL AbortExtract7za',
      'SetErrorLevel 1'
    ],
    [
      'As an absolutely last resort',
      'even though it is not atomic and will ignore errors.'
    ]
  );
  const extractAppPackage = normalizeNewlines(
    extractAppPackageTemplateBytes.toString('utf8')
  );
  const zipBranchStart = extractAppPackage.indexOf('!ifdef ZIP_COMPRESSION');
  const zipBranchEnd = extractAppPackage.indexOf('!else', zipBranchStart);
  if (zipBranchStart === -1 || zipBranchEnd === -1) {
    throw new Error('Phase 7 ZIP extraction branch is missing');
  }
  const zipBranch = extractAppPackage.slice(zipBranchStart, zipBranchEnd);
  assertOrderedTokens(zipBranch, [
    'nsisunz::Unzip "$PLUGINSDIR\\app-$packageArch.zip" "$INSTDIR"',
    'Pop $R0',
    '${If} $R0 != "success"',
    'MessageBox MB_OK|MB_ICONEXCLAMATION',
    'SetErrorLevel 1',
    'Quit'
  ], 'Phase 7 ZIP extraction failure handling');
  if (/(?:Nsis7z::Extract|extractUsing7za|CopyFiles)/u.test(zipBranch)) {
    throw new Error('Phase 7 ZIP extraction branch must not fall back to 7z or CopyFiles');
  }
  assertPatchedTemplate(
    installUtilTemplateBytes,
    auditedPatchedInstallUtilTemplateSha256,
    'current-version upgrade uninstall utility',
    [
      'StrCpy $uninstallString "$phase7RegisteredUninstallString"',
      'StrCpy $installationDir "$phase7RegisteredPath"',
      'StrCpy $R5 "$phase7RegisteredKeepShortcuts"',
      'StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\phase7-current-uninstaller.exe"',
      'File "/oname=phase7-current-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"',
      'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
      'ifErrors DoesNotExist',
      'Return',
      'MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK'
    ],
    [
      '!insertmacro readReg $uninstallString',
      '!insertmacro readReg $installationDir',
      '!insertmacro readReg $R5',
      '!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"',
      '$PLUGINSDIR\\old-uninstaller.exe',
      'TryInPlace:',
      'ExecWait \'"$uninstallerFileName"',
      'UninstallLoop:',
      'OneMoreAttempt:',
      'CheckResult:',
      'Goto UninstallLoop',
      'Goto OneMoreAttempt',
      'MB_RETRYCANCEL',
      'Sleep 1000'
    ]
  );
  assertPhase7InstallUtilSemantics(installUtilTemplateBytes);
  const installSection = normalizeNewlines(installSectionTemplateBytes.toString('utf8'));
  const firstInstallAcquire = installSection.indexOf('!insertmacro phase7AcquireUninstallMutex');
  const firstInstallBoundary = installSection.indexOf(
    '!insertmacro phase7AssertNoConcurrentUninstallBoundary'
  );
  const targetValidation = installSection.indexOf(
    '!insertmacro phase7ValidateInstallTargetBeforeMutation'
  );
  const registryProbe = installSection.indexOf('!insertmacro phase7ProbeRegistryWritable');
  const identityRevalidationAfterProbe = installSection.indexOf(
    '!insertmacro phase7ValidateInstallTargetBeforeMutation',
    registryProbe + 1
  );
  const firstAppCheck = installSection.indexOf('!insertmacro CHECK_APP_RUNNING');
  const releaseBeforeOldUninstall = installSection.indexOf(
    '!insertmacro phase7ReleaseUninstallMutex'
  );
  const oldUninstall = installSection.indexOf(
    '!insertmacro uninstallOldVersion HKEY_CURRENT_USER'
  );
  const reacquireAfterOldUninstall = installSection.indexOf(
    '!insertmacro phase7AcquireUninstallMutex',
    oldUninstall + 1
  );
  const recheckAfterOldUninstall = installSection.indexOf(
    '!insertmacro phase7AssertNoConcurrentUninstallBoundary',
    oldUninstall + 1
  );
  if (!(firstInstallAcquire < firstInstallBoundary
        && firstInstallBoundary < targetValidation
        && targetValidation < registryProbe
        && registryProbe < identityRevalidationAfterProbe
        && identityRevalidationAfterProbe < firstAppCheck)
      || !(releaseBeforeOldUninstall < oldUninstall
        && oldUninstall < reacquireAfterOldUninstall
        && reacquireAfterOldUninstall < recheckAfterOldUninstall)
      || installSection.indexOf('!insertmacro phase7BeginInstallTransaction')
        >= installSection.indexOf('SetOutPath $INSTDIR')
      || installSection.indexOf('One or more application files could not be installed.')
        >= installSection.indexOf('!insertmacro phase7WriteInstallMarker')
      || installSection.lastIndexOf('!insertmacro phase7ReleaseUninstallMutex')
        <= installSection.indexOf('!insertmacro phase7CommitInstallTransaction')) {
    throw new Error('Phase 7 install validation/transaction ordering is not exact');
  }
  const uninstaller = normalizeNewlines(uninstallerTemplateBytes.toString('utf8'));
  if (uninstaller.indexOf('!insertmacro phase7AcquireUninstallMutex')
        >= uninstaller.indexOf('!insertmacro phase7InitCurrentUser')
      || uninstaller.indexOf('!insertmacro phase7InitCurrentUser')
        >= uninstaller.indexOf(
          '!insertmacro phase7AcquireUninstallMutex',
          uninstaller.indexOf('!insertmacro phase7InitCurrentUser') + 1
        )
      || uninstaller.lastIndexOf('!insertmacro phase7VerifyUninstallRoot')
        >= uninstaller.indexOf('!insertmacro phase7StageVerifiedInstallRoot')
      || uninstaller.indexOf('!insertmacro phase7StageVerifiedInstallRoot')
        >= uninstaller.indexOf('!insertmacro phase7CommitAtomicUninstallRegistry R0')
      || uninstaller.indexOf('!insertmacro phase7CommitAtomicUninstallRegistry R0')
        >= uninstaller.indexOf('!insertmacro phase7FinishCommittedAtomicUninstall R0')
      || uninstaller.indexOf('!insertmacro phase7FinishCommittedAtomicUninstall R0')
        >= uninstaller.indexOf('!insertmacro phase7CompleteCommittedPostCleanup R0')) {
    throw new Error('Phase 7 uninstall staging/rollback ordering is not exact');
  }
  assertPackageTreeIdentity(
    appBuilderTree,
    auditedPatchedAppBuilderTree,
    'installed patched app-builder-lib'
  );
  if (fluentPackage.name !== '@fluentui/react-icons'
      || fluentPackage.version !== '2.0.316'
      || fluentPackage.license !== 'MIT') {
    throw new Error('installed @fluentui/react-icons identity and MIT declaration must be exact');
  }
  if (sha256(fluentLicenseBytes) !== auditedFluentIconsLicenseSha256) {
    throw new Error('installed @fluentui/react-icons LICENSE is missing or not exact');
  }
  if (sha256(noticeGeneratorBytes) !== auditedNoticeGeneratorSha256) {
    throw new Error('Phase 5 notice generator SHA-256 is not exact');
  }
  const noticeGenerator = normalizeNewlines(noticeGeneratorBytes.toString('utf8'));
  for (const required of [
    'for (const item of packages) {',
    'const licensePath = await findLicenseFile(item.path);',
    'if (!licensePath) throw new Error(`Runtime component ${item.name}@${item.version} has no local license text`);',
    "component.properties.push(property('desktop-translate:notice-file', 'licenses/THIRD_PARTY_NOTICES.txt'))"
  ]) {
    if (!noticeGenerator.includes(required)) {
      throw new Error('Phase 5 runtime license-to-notice gate is incomplete');
    }
  }
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertRegularNonSymlinkFile(path, label) {
  const info = await pathInfo(path);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

async function resolveElectronBuilderCustomResource(projectDir, buildResourcesDir, custom) {
  let resourceList = [];
  try {
    resourceList = await readdir(buildResourcesDir);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  if (resourceList.includes(custom)) {
    return resolve(buildResourcesDir, basename(custom));
  }

  const fromBuildResources = resolve(buildResourcesDir, custom);
  if (await pathInfo(fromBuildResources)) return fromBuildResources;
  const fromProject = resolve(projectDir, custom);
  return await pathInfo(fromProject) ? fromProject : undefined;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPathWithin(parent, candidate) {
  const child = relative(parent, candidate);
  return child !== ''
    && child !== '..'
    && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(child);
}

export async function assertAppBuilderPatchPolicyFiles(repositoryRoot) {
  const root = await realpath(resolve(repositoryRoot));
  const nodeModulesPath = resolve(root, 'node_modules');
  const nodeModulesInfo = await pathInfo(nodeModulesPath);
  if (nodeModulesInfo === undefined
      || !nodeModulesInfo.isDirectory()
      || nodeModulesInfo.isSymbolicLink()) {
    throw new Error('root node_modules must be a regular non-symlink directory');
  }
  const nodeModulesRoot = await realpath(nodeModulesPath);
  const rootPackagePath = resolve(root, 'package.json');
  const gitAttributesPath = resolve(root, '.gitattributes');
  const workspacePath = resolve(root, 'pnpm-workspace.yaml');
  const lockfilePath = resolve(root, 'pnpm-lock.yaml');
  const patchPath = resolve(root, auditedAppBuilderPatchPath);
  const fluentPatchPath = resolve(root, auditedFluentIconsPatchPath);
  const noticeGeneratorPath = resolve(
    root,
    'tooling',
    'supply-chain',
    'generate-phase5-supply-chain.mjs'
  );
  const fluentPackagePath = resolve(
    root,
    'apps',
    'desktop',
    'node_modules',
    '@fluentui',
    'react-icons',
    'package.json'
  );

  await assertRegularNonSymlinkFile(rootPackagePath, 'root package.json');
  await assertRegularNonSymlinkFile(gitAttributesPath, 'repository .gitattributes');
  await assertRegularNonSymlinkFile(workspacePath, 'pnpm workspace');
  await assertRegularNonSymlinkFile(lockfilePath, 'pnpm lockfile');
  await assertRegularNonSymlinkFile(patchPath, 'app-builder-lib Phase 7 patch');
  await assertRegularNonSymlinkFile(
    fluentPatchPath,
    '@fluentui/react-icons LICENSE patch'
  );
  await assertRegularNonSymlinkFile(noticeGeneratorPath, 'Phase 5 notice generator');
  await assertRegularNonSymlinkFile(
    fluentPackagePath,
    'installed @fluentui/react-icons package.json'
  );

  const repositoryRequire = createRequire(rootPackagePath);
  let resolvedElectronBuilderPackagePath;
  let resolvedAppBuilderPackagePath;
  try {
    resolvedElectronBuilderPackagePath = repositoryRequire.resolve('electron-builder/package.json');
    const electronBuilderRequire = createRequire(resolvedElectronBuilderPackagePath);
    resolvedAppBuilderPackagePath = electronBuilderRequire.resolve('app-builder-lib/package.json');
  } catch (error) {
    throw new Error(
      `the locked electron-builder/app-builder-lib dependency chain could not be resolved: ${error.message}`,
      { cause: error }
    );
  }

  const electronBuilderRoot = await realpath(dirname(resolvedElectronBuilderPackagePath));
  const appBuilderRoot = await realpath(dirname(resolvedAppBuilderPackagePath));
  const fluentRoot = await realpath(dirname(fluentPackagePath));
  if (!isPathWithin(nodeModulesRoot, electronBuilderRoot)
      || !isPathWithin(nodeModulesRoot, appBuilderRoot)
      || !isPathWithin(nodeModulesRoot, fluentRoot)) {
    throw new Error(
      'electron-builder, app-builder-lib, and Fluent Icons must resolve inside the audited dependency tree'
    );
  }
  const directElectronBuilderRoot = await realpath(
    resolve(root, 'node_modules', 'electron-builder')
  );
  if (!samePath(directElectronBuilderRoot, electronBuilderRoot)) {
    throw new Error(
      'root node_modules/electron-builder must resolve to the exact audited electron-builder package'
    );
  }
  const electronBuilderPackagePath = resolve(electronBuilderRoot, 'package.json');
  const electronBuilderCliPath = resolve(electronBuilderRoot, 'cli.js');
  const appBuilderPackagePath = resolve(appBuilderRoot, 'package.json');
  const assistedInstallerTemplatePath = resolve(
    appBuilderRoot,
    'templates',
    'nsis',
    'assistedInstaller.nsh'
  );
  const installerTemplatePath = resolve(appBuilderRoot, 'templates', 'nsis', 'installer.nsi');
  const installSectionTemplatePath = resolve(
    appBuilderRoot,
    'templates',
    'nsis',
    'installSection.nsh'
  );
  const uninstallerTemplatePath = resolve(
    appBuilderRoot,
    'templates',
    'nsis',
    'uninstaller.nsh'
  );
  const extractAppPackageTemplatePath = resolve(
    appBuilderRoot,
    'templates',
    'nsis',
    'include',
    'extractAppPackage.nsh'
  );
  const installUtilTemplatePath = resolve(
    appBuilderRoot,
    'templates',
    'nsis',
    'include',
    'installUtil.nsh'
  );
  const fluentLicensePath = resolve(fluentRoot, 'LICENSE');
  await assertRegularNonSymlinkFile(
    electronBuilderPackagePath,
    'installed electron-builder package.json'
  );
  await assertRegularNonSymlinkFile(
    electronBuilderCliPath,
    'installed electron-builder CLI'
  );
  await assertRegularNonSymlinkFile(
    appBuilderPackagePath,
    'installed app-builder-lib package.json'
  );
  await assertRegularNonSymlinkFile(
    assistedInstallerTemplatePath,
    'installed app-builder-lib assisted installer template'
  );
  await assertRegularNonSymlinkFile(
    installerTemplatePath,
    'installed app-builder-lib installer template'
  );
  await assertRegularNonSymlinkFile(
    installSectionTemplatePath,
    'installed app-builder-lib install section template'
  );
  await assertRegularNonSymlinkFile(
    uninstallerTemplatePath,
    'installed app-builder-lib uninstaller template'
  );
  await assertRegularNonSymlinkFile(
    extractAppPackageTemplatePath,
    'installed app-builder-lib extract application package template'
  );
  await assertRegularNonSymlinkFile(
    installUtilTemplatePath,
    'installed app-builder-lib old-version uninstall utility template'
  );
  await assertRegularNonSymlinkFile(
    fluentLicensePath,
    'installed @fluentui/react-icons LICENSE'
  );
  const electronBuilderTree = await computePackageTreeIdentity(electronBuilderRoot);
  const appBuilderTree = await computePackageTreeIdentity(appBuilderRoot);
  assertPackageTreeIdentity(
    electronBuilderTree,
    auditedElectronBuilderTree,
    'installed electron-builder'
  );
  assertPackageTreeIdentity(
    appBuilderTree,
    auditedPatchedAppBuilderTree,
    'installed patched app-builder-lib'
  );

  assertAppBuilderPatchPolicy({
    rootPackageBytes: await readFile(rootPackagePath),
    gitAttributesBytes: await readFile(gitAttributesPath),
    workspaceBytes: await readFile(workspacePath),
    lockfileBytes: await readFile(lockfilePath),
    patchBytes: await readFile(patchPath),
    fluentPatchBytes: await readFile(fluentPatchPath),
    electronBuilderPackageBytes: await readFile(electronBuilderPackagePath),
    electronBuilderCliBytes: await readFile(electronBuilderCliPath),
    electronBuilderTree,
    appBuilderPackageBytes: await readFile(appBuilderPackagePath),
    assistedInstallerTemplateBytes: await readFile(assistedInstallerTemplatePath),
    installerTemplateBytes: await readFile(installerTemplatePath),
    installSectionTemplateBytes: await readFile(installSectionTemplatePath),
    uninstallerTemplateBytes: await readFile(uninstallerTemplatePath),
    extractAppPackageTemplateBytes: await readFile(extractAppPackageTemplatePath),
    installUtilTemplateBytes: await readFile(installUtilTemplatePath),
    appBuilderTree,
    fluentPackageBytes: await readFile(fluentPackagePath),
    fluentLicenseBytes: await readFile(fluentLicensePath),
    noticeGeneratorBytes: await readFile(noticeGeneratorPath)
  });

  return {
    repositoryRoot: root,
    nodeModulesRoot,
    rootPackagePath,
    gitAttributesPath,
    workspacePath,
    lockfilePath,
    patchPath,
    fluentPatchPath,
    noticeGeneratorPath,
    electronBuilderRoot,
    electronBuilderPackagePath,
    electronBuilderCliPath,
    electronBuilderTree,
    appBuilderRoot,
    appBuilderPackagePath,
    assistedInstallerTemplatePath,
    installerTemplatePath,
    installSectionTemplatePath,
    uninstallerTemplatePath,
    extractAppPackageTemplatePath,
    installUtilTemplatePath,
    appBuilderTree,
    fluentRoot,
    fluentPackagePath,
    fluentLicensePath
  };
}

export async function assertElectronBuilderSigningPolicyFile(configurationPath, options = {}) {
  const path = resolve(configurationPath);
  await assertRegularNonSymlinkFile(path, 'electron-builder configuration');
  const configuration = await readFile(path, 'utf8');
  const parsed = parseConfiguration(configuration);
  assertParsedConfiguration(parsed);

  const projectDir = dirname(path);
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(projectDir, '..', '..'));
  const projectPackagePath = resolve(projectDir, 'package.json');
  await assertRegularNonSymlinkFile(projectPackagePath, 'desktop package.json');
  const projectPackage = parseJsonObject(
    await readFile(projectPackagePath),
    'desktop package.json'
  );
  if (projectPackage.packageManager !== 'pnpm@10.32.1') {
    throw new Error(
      'desktop package.json must pin packageManager exactly to pnpm@10.32.1 for builder detection'
    );
  }
  const expectedAfterExtractHookPath = resolve(
    projectDir,
    'tooling',
    'phase5-after-extract.mjs'
  );
  const resolvedAfterExtractHookPath = resolve(projectDir, parsed.afterExtract);
  if (!samePath(resolvedAfterExtractHookPath, expectedAfterExtractHookPath)) {
    throw new Error(
      'electron-builder afterExtract must resolve to the exact audited packaging hook'
    );
  }
  await assertRegularNonSymlinkFile(
    resolvedAfterExtractHookPath,
    'electron-builder audited afterExtract hook'
  );
  if (sha256(await readFile(resolvedAfterExtractHookPath)) !== auditedAfterExtractHookSha256) {
    throw new Error('electron-builder audited afterExtract hook SHA-256 is not exact');
  }
  const buildResourcesDir = resolve(projectDir, parsed.directories.buildResources);
  const buildResourcesInfo = await pathInfo(buildResourcesDir);
  if (buildResourcesInfo === undefined
      || !buildResourcesInfo.isDirectory()
      || buildResourcesInfo.isSymbolicLink()) {
    throw new Error('electron-builder buildResources must be a regular non-symlink directory');
  }
  const expectedIncludePath = resolve(buildResourcesDir, auditedInstallerIncludePath);
  const resolvedIncludePath = await resolveElectronBuilderCustomResource(
    projectDir,
    buildResourcesDir,
    parsed.nsis.include
  );
  if (resolvedIncludePath === undefined || !samePath(resolvedIncludePath, expectedIncludePath)) {
    throw new Error(
      'electron-builder installer include must resolve to the exact buildResources/installer.nsh; project fallback or shadow resolution is forbidden'
    );
  }

  const includeInfo = await pathInfo(resolvedIncludePath);
  if (includeInfo === undefined || !includeInfo.isFile() || includeInfo.isSymbolicLink()) {
    throw new Error('electron-builder audited installer include must be a regular non-symlink file');
  }
  for (const shadowPath of [
    resolve(buildResourcesDir, 'build', auditedInstallerIncludePath),
    resolve(projectDir, auditedInstallerIncludePath)
  ]) {
    if (!samePath(shadowPath, expectedIncludePath)
        && await pathInfo(shadowPath)) {
      throw new Error(`electron-builder shadow installer include is forbidden: ${shadowPath}`);
    }
  }

  const implicitScriptPath = resolve(buildResourcesDir, 'installer.nsi');
  if (await pathInfo(implicitScriptPath)) {
    throw new Error(
      `electron-builder implicit default installer.nsi is forbidden: ${implicitScriptPath}`
    );
  }
  for (const shadowCliPath of [
    resolve(projectDir, 'node_modules', 'electron-builder'),
    resolve(projectDir, 'node_modules', '.bin', 'electron-builder'),
    resolve(projectDir, 'node_modules', '.bin', 'electron-builder.CMD'),
    resolve(projectDir, 'node_modules', '.bin', 'electron-builder.ps1')
  ]) {
    if (await pathInfo(shadowCliPath)) {
      throw new Error(`app-local electron-builder shadow is forbidden: ${shadowCliPath}`);
    }
  }
  const buildResourceEntries = await readdir(buildResourcesDir);
  if (buildResourceEntries.length !== 1
      || buildResourceEntries[0] !== auditedInstallerIncludePath) {
    throw new Error(
      'electron-builder buildResources exact set must contain only audited installer.nsh; '
      + `got [${buildResourceEntries.sort().join(', ')}]`
    );
  }

  assertInstallerIncludeContent(await readFile(resolvedIncludePath, 'utf8'));
  const patchPolicy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  return {
    configurationPath: path,
    projectPackagePath,
    afterExtractHookPath: resolvedAfterExtractHookPath,
    includePath: resolvedIncludePath,
    ...patchPolicy
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1] || process.argv.length !== 4) {
    throw new Error('Usage: node phase5-electron-builder-policy.mjs --config <electron-builder.yml>');
  }
  const result = await assertElectronBuilderSigningPolicyFile(process.argv[index + 1]);
  console.log(
    `[phase5:package] electron-builder exact Host signing, strict CurrentUser assisted NSIS installer/uninstaller via audited app-builder-lib patch ${result.patchPath}, audited include ${result.includePath}, canonical installer name, and publish:null policy PASS: ${result.configurationPath}`
  );
}

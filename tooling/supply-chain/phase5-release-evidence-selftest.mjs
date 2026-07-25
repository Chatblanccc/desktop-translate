import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExactArtifactSet,
  assertExactAttestationBundle,
  expectedArtifactRoles,
  expectedSignedRoles
} from './phase5-release-evidence-lib.mjs';
import { assertNoProductionTestMarkers } from '../packaging/phase5-package-policy.mjs';
import {
  assertAppBuilderPatchPolicy,
  assertElectronBuilderSigningPolicy,
  assertElectronBuilderSigningPolicyFile,
  assertPhase7AppBuilderPatchHeaders,
  assertPhase7InstallUtilSemantics,
  assertPhase7InstallerIncludeSemantics,
  auditedAppBuilderPatchSha256,
  computePackageTreeIdentity,
  evaluatePhase7InstallerPolicyScenario,
  normalizePhase7FreshTargetForPolicy
} from '../packaging/phase5-electron-builder-policy.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const auditedInstallerIncludeContent = (
  await readFile(resolve(repositoryRoot, 'apps', 'desktop', 'build', 'installer.nsh'), 'utf8')
).replaceAll('\r\n', '\n');
const auditedAfterExtractHookContent = await readFile(
  resolve(repositoryRoot, 'apps', 'desktop', 'tooling', 'phase5-after-extract.mjs'),
  'utf8'
);
const auditedAppBuilderPatchBytes = await readFile(
  resolve(repositoryRoot, 'patches', 'app-builder-lib@26.15.3.patch')
);

function mutateExact(value, anchor, replacement, label) {
  assert.ok(value.includes(anchor), `${label} mutation anchor must exist`);
  const mutated = value.replace(anchor, replacement);
  assert.notEqual(mutated, value, `${label} mutation must change its input`);
  return mutated;
}

assert.equal(
  normalizePhase7FreshTargetForPolicy(
    'D:\\Apps\\desktop-translate-backup',
    'desktop-translate'
  ),
  'D:\\Apps\\desktop-translate-backup\\desktop-translate'
);
assert.equal(
  normalizePhase7FreshTargetForPolicy('D:\\Apps\\Desktop-Translate', 'desktop-translate'),
  'D:\\Apps\\Desktop-Translate'
);
for (const [scenario, expected] of [
  [
    { state: 'fresh', targetKind: 'nonempty-directory' },
    { allowed: false, reason: 'FRESH_NONEMPTY_TARGET' }
  ],
  [
    { state: 'fresh', silent: true, hasDParameter: true, targetKind: 'missing' },
    { allowed: false, reason: 'SILENT_D_OVERRIDE' }
  ],
  [
    {
      state: 'registered',
      hasDParameter: true,
      registryMatches: true,
      markerState: 'stable'
    },
    { allowed: false, reason: 'REGISTERED_D_OVERRIDE' }
  ],
  [
    { state: 'registered', registryMatches: false, markerState: 'stable' },
    { allowed: false, reason: 'REGISTRY_PATH_MISMATCH' }
  ],
  [
    {
      state: 'registered',
      registryMatches: true,
      markerState: 'stable',
      shortcutRegistryState: 'invalid-traversal'
    },
    { allowed: false, reason: 'SHORTCUT_REGISTRY_INVALID' }
  ],
  [
    {
      state: 'fresh',
      targetKind: 'missing',
      shortcutRegistryState: 'partial-exact'
    },
    { allowed: false, reason: 'SHORTCUT_REGISTRY_INVALID' }
  ],
  [
    {
      state: 'registered',
      registryMatches: true,
      markerState: 'stable',
      rootAllowlisted: false
    },
    { allowed: false, reason: 'ROOT_ALLOWLIST_INVALID' }
  ],
  [
    {
      state: 'registered',
      registryMatches: true,
      markerState: 'invalid'
    },
    { allowed: false, reason: 'PRE_PHASE7_OR_MARKER_IDENTITY_INVALID' }
  ],
  [
    {
      state: 'registered',
      registryMatches: true,
      markerState: 'missing'
    },
    { allowed: false, reason: 'PRE_PHASE7_OR_MARKER_IDENTITY_INVALID' }
  ],
  [
    {
      state: 'recovering',
      registryMatches: true,
      markerState: 'recovery',
      rootAllowlisted: true
    },
    { allowed: true, reason: 'INTERRUPTED_PHASE7_RECOVERY' }
  ],
  [
    {
      state: 'fresh',
      targetKind: 'nonempty-directory',
      markerState: 'recovery',
      rootAllowlisted: true
    },
    { allowed: true, reason: 'INTERRUPTED_PHASE7_RECOVERY' }
  ],
  [
    {
      state: 'registered',
      registryMatches: true,
      markerState: 'stable',
      containsReparse: true
    },
    { allowed: false, reason: 'REPARSE_POINT' }
  ]
]) {
  assert.deepEqual(evaluatePhase7InstallerPolicyScenario(scenario), expected);
}

const records = [
  record('application', 'package/desktop-translate.exe', 'desktop-translate.exe', 'a'),
  record('nativeHost', 'package/resources/selection-host/selection-host.exe', 'selection-host.exe', 'b'),
  record('asar', 'package/resources/app.asar', 'app.asar', 'c'),
  record('installer', 'installer/Desktop-Translate-0.5.0-phase5-x64-setup.exe', 'Desktop-Translate-0.5.0-phase5-x64-setup.exe', 'd')
];

assert.doesNotThrow(() => assertExactArtifactSet(records, records, 'selftest', expectedArtifactRoles(true)));
assert.deepEqual(expectedSignedRoles(true), ['application', 'installer', 'nativeHost']);
assert.throws(
  () => assertExactArtifactSet(records.filter((item) => item.role !== 'installer'), records, 'missing installer', expectedArtifactRoles(true)),
  /roles must be exactly/u
);

assert.doesNotThrow(() => assertNoProductionTestMarkers([{
  path: '.vite/build/metrics-schema.js',
  content: 'const allowed = ["fake-native", "fake-provider"];'
}]));
for (const marker of [
  'DESKTOP_TRANSLATE_E2E',
  '__desktopTranslateTestApi',
  'e2e-baidu-transport',
  '--fake-mode',
  'DESKTOP_TRANSLATE_E2E_NATIVE_FIXTURE'
]) {
  assert.throws(
    () => assertNoProductionTestMarkers([{ path: '.vite/build/main.js', content: `unsafe:${marker}` }]),
    /forbidden test injection marker/u
  );
}

const attestation = bundleFor(records.map((item) => item.sha256));
assert.doesNotThrow(() => assertExactAttestationBundle(attestation, records.map((item) => item.sha256)));
assert.throws(
  () => assertExactAttestationBundle(bundleFor(records.slice(0, 3).map((item) => item.sha256)), records.map((item) => item.sha256)),
  /subject set is not exact/u
);

const signingConfig = (
  await readFile(resolve(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
).replaceAll('\r\n', '\n');
assert.doesNotThrow(() => assertElectronBuilderSigningPolicy(
  signingConfig,
  auditedInstallerIncludeContent
));
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace('  signExts:\n    - selection-host.exe\n', ''),
    auditedInstallerIncludeContent
  ),
  /win configuration keys must be exactly/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace(
      '  signExts:\n    - selection-host.exe',
      '  signExts:\n    - .exe'
    ),
    auditedInstallerIncludeContent
  ),
  /signExts must contain exactly selection-host.exe/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    `${signingConfig}${signingConfig}`,
    auditedInstallerIncludeContent
  ),
  /YAML could not be parsed/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace('  target:', '  signExts:\n    - selection-host.exe\n  target:'),
    auditedInstallerIncludeContent
  ),
  /YAML could not be parsed/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace(
      'Desktop-Translate-0.5.0-phase5-x64-setup.exe',
      'Desktop-Translate-${version}-${arch}-setup.${ext}'
    ),
    auditedInstallerIncludeContent
  ),
  /artifactName must be exactly/u
);
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace('publish: null', 'publish: always'),
    auditedInstallerIncludeContent
  ),
  /publish policy must be exactly/u
);
for (const [setting, requiredValue, rejectedValue] of [
  ['oneClick', 'false', 'true'],
  ['perMachine', 'false', 'true'],
  ['allowElevation', 'false', 'true'],
  ['packElevateHelper', 'false', 'true'],
  ['allowToChangeInstallationDirectory', 'true', 'false'],
  ['deleteAppDataOnUninstall', 'false', 'true'],
  ['runAfterFinish', 'false', 'true'],
  ['differentialPackage', 'false', 'true'],
  ['useZip', 'true', 'false']
]) {
  assert.throws(
    () => assertElectronBuilderSigningPolicy(
      signingConfig.replace(
        `  ${setting}: ${requiredValue}`,
        `  ${setting}: ${rejectedValue}`
      ),
      auditedInstallerIncludeContent
    ),
    new RegExp(`nsis\\.${setting} must be exactly ${requiredValue}`, 'u')
  );
}
assert.throws(
  () => assertElectronBuilderSigningPolicy(
    signingConfig.replace(
      'publish: null',
      'nsis:\n  oneClick: false\npublish: null'
    ),
    auditedInstallerIncludeContent
  ),
  /YAML could not be parsed/u
);
for (const [name, mutatedConfig, expectedError] of [
  [
    'missing requested execution level',
    signingConfig.replace('  requestedExecutionLevel: asInvoker\n', ''),
    /win configuration keys must be exactly/u
  ],
  [
    'administrator execution level',
    signingConfig.replace('requestedExecutionLevel: asInvoker', 'requestedExecutionLevel: requireAdministrator'),
    /requestedExecutionLevel must be exactly asInvoker/u
  ],
  [
    'portable target',
    signingConfig.replace('    - target: nsis', '    - target: portable'),
    /must contain exactly one nsis target/u
  ],
  [
    'extra target',
    signingConfig.replace(
      '        - x64\n  artifactName:',
      '        - x64\n    - target: portable\n      arch:\n        - x64\n  artifactName:'
    ),
    /exactly one nsis x64 target mapping/u
  ],
  [
    'non-x64 target',
    signingConfig.replace('        - x64\n  artifactName:', '        - ia32\n  artifactName:'),
    /architecture must be exactly x64/u
  ],
  [
    'custom script',
    signingConfig.replace('  include: installer.nsh', '  include: installer.nsh\n  script: build/unsafe-installer.nsi'),
    /nsis\.script override is forbidden/u
  ],
  [
    'per-machine default override',
    signingConfig.replace('  perMachine: false', '  perMachine: false\n  selectPerMachineByDefault: true'),
    /nsis\.selectPerMachineByDefault override is forbidden/u
  ],
  [
    'custom NSIS binary',
    signingConfig.replace('  include: installer.nsh', '  include: installer.nsh\n  customNsisBinary: unsafe'),
    /nsis\.customNsisBinary override is forbidden/u
  ],
  [
    'custom include path',
    signingConfig.replace('include: installer.nsh', 'include: build/unsafe-installer.nsh'),
    /nsis\.include must be exactly/u
  ],
  [
    'custom build resources directory',
    signingConfig.replace('buildResources: build', 'buildResources: unsafe-build'),
    /directories\.buildResources must be exactly build/u
  ],
  [
    'inherited installer overrides',
    signingConfig.replace('extends: null', 'extends: ./unsafe-builder-base.yml'),
    /extends must be explicitly null/u
  ],
  [
    'top-level lifecycle hook',
    `${signingConfig}\nbeforePack: ./tooling/unsafe-hook.mjs\n`,
    /top-level configuration keys must be exactly/u
  ],
  [
    'custom signing hook',
    signingConfig.replace(
      '  executableName: desktop-translate',
      '  executableName: desktop-translate\n  sign: ./tooling/unsafe-sign.mjs'
    ),
    /win configuration keys must be exactly/u
  ]
]) {
  assert.notEqual(
    mutatedConfig,
    signingConfig,
    `${name} mutation must change the audited config`
  );
  assert.throws(
    () => assertElectronBuilderSigningPolicy(mutatedConfig, auditedInstallerIncludeContent),
    expectedError,
    name
  );
}
for (const [name, mutatedInclude] of [
  [
    'missing all-users rejection',
    auditedInstallerIncludeContent.replace(
      '${GetOptions} $R0 "/allusers" $R1',
      '${GetOptions} $R0 "/unsafe-allusers" $R1'
    )
  ],
  [
    'machine state retained for silent install',
    auditedInstallerIncludeContent.replace(
      'StrCpy $hasPerMachineInstallation "0"',
      'StrCpy $hasPerMachineInstallation "1"'
    )
  ],
  [
    'per-user mode initialization removed',
    auditedInstallerIncludeContent.replace('  !insertmacro setInstallModePerUser\n', '')
  ],
  [
    'elevation macro injected',
    auditedInstallerIncludeContent.replace(
      '  !insertmacro setInstallModePerUser\n',
      '  !insertmacro setInstallModePerUser\n  !insertmacro UAC_RunElevated\n'
    )
  ],
  [
    'fresh nonempty rejection removed',
    auditedInstallerIncludeContent.replace(
      'Fresh installation requires a nonexistent or empty application directory.',
      'Fresh installation may overwrite any directory.'
    )
  ],
  [
    'shortcut registry identity check removed',
    auditedInstallerIncludeContent.replace(
      '!insertmacro phase7AssertRegisteredShortcutRegistry',
      '!insertmacro phase7AssertFreshShortcutRegistry'
    )
  ],
  [
    'broad recursive root deletion injected',
    auditedInstallerIncludeContent.replace(
      '!insertmacro phase7CleanupCreatedFreshDirectories',
      'RMDir /r "$INSTDIR"'
    )
  ]
]) {
  assert.throws(
    () => assertElectronBuilderSigningPolicy(signingConfig, mutatedInclude),
    /audited Phase 7 installer include SHA-256 is not exact/u,
    name
  );
}
assert.doesNotThrow(
  () => assertPhase7InstallerIncludeSemantics(auditedInstallerIncludeContent)
);
for (const [name, mutatedInclude, expectedError] of [
  [
    'native process default changed to fail-open',
    mutateExact(
      auditedInstallerIncludeContent,
      'StrCpy $phase7AppProcessState "error"',
      'StrCpy $phase7AppProcessState "not-running"',
      'native process default changed to fail-open'
    ),
    /lacks StrCpy \$phase7AppProcessState "error"/u
  ],
  [
    'native process terminate permission removed',
    mutateExact(
      auditedInstallerIncludeContent,
      'IntOp $R5 $R5 | 0x1',
      'IntOp $R5 $R5 | 0x0',
      'native process terminate permission removed'
    ),
    /lacks IntOp \$R5 \$R5 \| 0x1/u
  ],
  [
    'native exact process path query removed',
    mutateExact(
      auditedInstallerIncludeContent,
      'KERNEL32::QueryFullProcessImageNameW',
      'KERNEL32::UnsafeProcessFilenameOnlyW',
      'native exact process path query removed'
    ),
    /lacks KERNEL32::QueryFullProcessImageNameW/u
  ],
  [
    'PowerShell process matching injected',
    `${auditedInstallerIncludeContent}\n# PowerShell Get-CimInstance Win32_Process\n`,
    /must not use shell or WMI process matching/u
  ],
  [
    'native NSIS enumeration injected',
    `${auditedInstallerIncludeContent}\nFindFirst $0 $1 "unsafe-*"\n`,
    /must use direct Win32 enumeration only/u
  ],
  [
    'global mutex downgraded to session local',
    mutateExact(
      auditedInstallerIncludeContent,
      '"Global\\DesktopTranslate.Phase7.Uninstall.${APP_GUID}"',
      '"Local\\DesktopTranslate.Phase7.Uninstall.${APP_GUID}"',
      'global mutex downgraded to session local'
    ),
    /lacks !define PHASE7_UNINSTALL_MUTEX_PREFIX/u
  ],
  [
    'borrowed SID pointer fixed-length dereference restored',
    `${auditedInstallerIncludeContent}\n`
      + "System::Call '*$R5(&w${NSIS_MAX_STRLEN} .R6)'\n",
    /must not fixed-length dereference the borrowed LocalAlloc SID pointer/u
  ],
  [
    'borrowed SID allocation freed before bounded copy',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        "    System::Call 'KERNEL32::lstrcpynW(w .R6, p R5, i ${NSIS_MAX_STRLEN}) p.R7'",
        "    System::Call 'KERNEL32::LocalFree(p R5) p.R8'"
      ].join('\n'),
      [
        "    System::Call 'KERNEL32::LocalFree(p R5) p.R8'",
        "    System::Call 'KERNEL32::lstrcpynW(w .R6, p R5, i ${NSIS_MAX_STRLEN}) p.R7'"
      ].join('\n'),
      'borrowed SID allocation freed before bounded copy'
    ),
    /current-user SID mutex acquisition ordering lacks/u
  ],
  [
    'fixed-drive requirement removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '${If} $R2 != 3',
      '${If} $R2 != 4',
      'fixed-drive requirement removed'
    ),
    /lacks \$\{If\} \$R2 != 3/u
  ],
  [
    'direct enumeration error capture removed',
    mutateExact(
      auditedInstallerIncludeContent,
      'KERNEL32::FindNextFileW(p $${HANDLE}, p $${BUFFER}) i.${RESULT} ?e',
      'KERNEL32::FindNextFileW(p $${HANDLE}, p $${BUFFER}) i.${RESULT}',
      'direct enumeration error capture removed'
    ),
    /lacks KERNEL32::FindNextFileW/u
  ],
  [
    'whole-root forward rename replaced',
    mutateExact(
      auditedInstallerIncludeContent,
      'Rename "$phase7TransactionSource" "$phase7TransactionStage"',
      'CopyFiles "$phase7TransactionSource" "$phase7TransactionStage"',
      'whole-root forward rename replaced'
    ),
    /lacks Rename "\$phase7TransactionSource"/u
  ],
  [
    'whole-root rollback rename replaced',
    mutateExact(
      auditedInstallerIncludeContent,
      'Rename "$phase7TransactionStage" "$phase7TransactionSource"',
      'CopyFiles "$phase7TransactionStage" "$phase7TransactionSource"',
      'whole-root rollback rename replaced'
    ),
    /must contain exactly 1 Rename "\$phase7TransactionStage"/u
  ],
  [
    'absent staging root canonicalized directly',
    mutateExact(
      auditedInstallerIncludeContent,
      '  ${GetFileName} "$phase7TransactionSource" $R2',
      [
        '  GetFullPathName $R9 "$phase7TransactionStage"',
        '  ${GetFileName} "$phase7TransactionSource" $R2'
      ].join('\n'),
      'absent staging root canonicalized directly'
    ),
    /must not canonicalize a transaction root that can legitimately be absent/u
  ],
  [
    'not-yet-created stage canonicalized during preparation',
    mutateExact(
      auditedInstallerIncludeContent,
      '      StrCpy $phase7TransactionStage "$R3\\${PHASE7_STAGE_PREFIX}-$R1-$R2"',
      [
        '      StrCpy $phase7TransactionStage "$R3\\${PHASE7_STAGE_PREFIX}-$R1-$R2"',
        '    GetFullPathName $phase7TransactionStage "$phase7TransactionStage"',
      ].join('\n'),
      'not-yet-created stage canonicalized during preparation'
    ),
    /must not canonicalize the not-yet-created staging root/u
  ],
  [
    'atomic source rebound to mutable INSTDIR',
    mutateExact(
      auditedInstallerIncludeContent,
      'GetFullPathName $phase7TransactionSource "$phase7RegisteredPath"',
      'GetFullPathName $phase7TransactionSource "$INSTDIR"',
      'atomic source rebound to mutable INSTDIR'
    ),
    /absent-stage-safe atomic staging preparation ordering lacks/u
  ],
  [
    'drive-root source reconstruction removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '    StrCpy $R0 "$R4${APP_FILENAME}"',
      '    StrCpy $R0 "$R4\\${APP_FILENAME}"',
      'drive-root source reconstruction removed'
    ),
    /absent-root-safe transaction path validation ordering lacks/u
  ],
  [
    'drive-root stage preparation removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '      StrCpy $phase7TransactionStage "$R3${PHASE7_STAGE_PREFIX}-$R1-$R2"',
      '      StrCpy $phase7TransactionStage "$R3\\${PHASE7_STAGE_PREFIX}-$R1-$R2"',
      'drive-root stage preparation removed'
    ),
    /absent-stage-safe atomic staging preparation ordering lacks/u
  ],
  [
    'registry probe mutates canonical product identity',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7ProbeRegistryKeyWritable "${PHASE7_INSTALL_REGISTRY_PROBE_KEY}"',
      '!insertmacro phase7ProbeRegistryKeyWritable "${INSTALL_REGISTRY_KEY}"',
      'registry probe mutates canonical product identity'
    ),
    /registry writability probe must not mutate canonical identity keys/u
  ],
  [
    'fresh-target validation uses fixed NSIS labels',
    mutateExact(
      auditedInstallerIncludeContent,
      '!define PHASE7_FRESH_TARGET_ID ${__LINE__}',
      '# fixed labels without an expansion identifier',
      'fresh-target validation uses fixed NSIS labels'
    ),
    /repeated fresh-target validation must use expansion-unique labels/u
  ],
  [
    'post-stage process-race check removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7FindExactAppProcessAtRoot "$phase7TransactionSource" R4',
      '# removed source process-race check',
      'post-stage process-race check removed'
    ),
    /post-stage process-race closure ordering lacks/u
  ],
  [
    'marker-last proof weakened',
    mutateExact(
      auditedInstallerIncludeContent,
      '$phase7CleanupRootState != "marker-only"',
      '$phase7CleanupRootState != "empty"',
      'marker-last proof weakened'
    ),
    /marker-last committed cleanup ordering lacks/u
  ],
  [
    'uninstall transaction durable identity version downgraded',
    mutateExact(
      auditedInstallerIncludeContent,
      'DesktopTranslate.UninstallTransaction.v2|${APP_GUID}',
      'DesktopTranslate.UninstallTransaction.v1|${APP_GUID}',
      'uninstall transaction durable identity version downgraded'
    ),
    /lacks !define PHASE7_UNINSTALL_TRANSACTION_VALUE .*v2/u
  ],
  [
    'transaction claim omits durable root file id',
    mutateExact(
      auditedInstallerIncludeContent,
      'WriteRegStr HKCU "$phase7TransactionClaimKey" RootFileIndexLow'
        + ' "$phase7TransactionRootFileIndexLow"',
      'WriteRegStr HKCU "$phase7TransactionClaimKey" UnsafeRootFileIndexLow'
        + ' "$phase7TransactionRootFileIndexLow"',
      'transaction claim omits durable root file id'
    ),
    /durable uninstall-root transaction claim ordering lacks/u
  ],
  [
    'transaction source identity capture removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7CaptureTransactionSourceIdentity',
      '# durable source identity capture removed',
      'transaction source identity capture removed'
    ),
    /atomic staging preparation ordering lacks/u
  ],
  [
    'committed root lease permits rename delete sharing',
    mutateExact(
      auditedInstallerIncludeContent,
      'CreateFileW(w "$phase7TransactionStage", i 0x00110081, i 3,'
        + ' p 0, i 3, i 0x02200000, p 0)',
      'CreateFileW(w "$phase7TransactionStage", i 0x00110081, i 7,'
        + ' p 0, i 3, i 0x02200000, p 0)',
      'committed root lease permits rename delete sharing'
    ),
    /committed root identity lease ordering lacks|must never allow FILE_SHARE_DELETE/u
  ],
  [
    'committed stable marker permits sharing',
    mutateExact(
      auditedInstallerIncludeContent,
      '"${PHASE7_INSTALL_MARKER_NAME}" "file" 0 phase7CommittedMarkerHandle R5',
      '"${PHASE7_INSTALL_MARKER_NAME}" "file" 3 phase7CommittedMarkerHandle R5',
      'committed stable marker permits sharing'
    ),
    /identity-bound marker-last committed cleanup ordering lacks/u
  ],
  [
    'committed disposition falls back to pathname delete',
    mutateExact(
      auditedInstallerIncludeContent,
      'System::Call \'KERNEL32::SetFileInformationByHandle('
        + 'p $${HANDLE_VARIABLE}, i 4, p R3, i 1) i.R4 ?e\'',
      'Delete "$phase7TransactionStage\\unsafe-pathname-delete"',
      'committed disposition falls back to pathname delete'
    ),
    /must bind exactly the audited install and committed-uninstall handles/u
  ],
  [
    'committed allowlist deletes a root file by pathname',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7DeleteCommittedAllowlistedFile'
        + ' $phase7CommittedRootHandle "${PRODUCT_FILENAME}.exe"',
      'Delete "$phase7TransactionStage\\${PRODUCT_FILENAME}.exe"',
      'committed allowlist deletes a root file by pathname'
    ),
    /committed handle-relative allowlist lacks|must never mutate or reopen by staging pathname/u
  ],
  [
    'committed root lease closes before allowlist cleanup',
    mutateExact(
      auditedInstallerIncludeContent,
      '      Push ""\n      Call ${PHASE7_COMMITTED_DELETE_FUNCTION}',
      '      Push ""\n'
        + '      System::Call \'KERNEL32::CloseHandle('
        + 'p $phase7CommittedRootHandle)\'\n'
        + '      Call ${PHASE7_COMMITTED_DELETE_FUNCTION}',
      'committed root lease closes before allowlist cleanup'
    ),
    /root and marker leases must remain pinned/u
  ],
  [
    'rollback skips durable stage identity match',
    mutateExact(
      auditedInstallerIncludeContent,
      '    !insertmacro phase7AssertTransactionRootPathIdentity'
        + ' "$phase7TransactionStage"',
      '# durable rollback stage identity match removed',
      'rollback skips durable stage identity match'
    ),
    /rollback durable uninstall-root identity ordering lacks/u
  ],
  [
    'registry copy replaced by rename',
    mutateExact(
      auditedInstallerIncludeContent,
      'ADVAPI32::RegCopyTreeW',
      'ADVAPI32::RegRenameKey',
      'registry copy replaced by rename'
    ),
    /lacks ADVAPI32::RegCopyTreeW/u
  ],
  [
    'registry delete readiness removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7PersistUninstallTransaction "registry-delete-started" R4',
      '# removed registry-delete-started checkpoint',
      'registry delete readiness removed'
    ),
    /product registry commit ordering lacks/u
  ],
  [
    'registry restore checkpoint removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7PersistUninstallTransaction "rollback-registry-restored" R4',
      '# removed rollback-registry-restored checkpoint',
      'registry restore checkpoint removed'
    ),
    /registry rollback ordering lacks/u
  ],
  [
    'dedicated commit result variable removed',
    mutateExact(
      auditedInstallerIncludeContent,
      'Var phase7CommitResult',
      '# removed dedicated Phase 7 commit result',
      'dedicated commit result variable removed'
    ),
    /declare exactly one dedicated phase7CommitResult/u
  ],
  [
    'uninstaller-only result variable escapes its build guard',
    mutateExact(
      auditedInstallerIncludeContent,
      '  Var phase7TransactionClaimResult',
      'Var phase7TransactionClaimResult',
      'uninstaller-only result variable escapes its build guard'
    ),
    /uninstaller-only result variables must stay inside BUILD_UNINSTALLER/u
  ],
  [
    'commit result leaks a scratch register',
    mutateExact(
      auditedInstallerIncludeContent,
      'StrCpy $${OUTPUT} "$phase7CommitResult"',
      'StrCpy $${OUTPUT} "$R0"',
      'commit result leaks a scratch register'
    ),
    /dedicated result ordering lacks|publish only its dedicated fixed-enum result/u
  ],
  [
    'committed post-cleanup replay removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '${ElseIf} $phase7TransactionState == "committed-postcleanup"',
      '${ElseIf} $phase7TransactionState == "unsafe-postcleanup"',
      'committed post-cleanup replay removed'
    ),
    /recovery must replay committed post-cleanup/u
  ],
  [
    'lowercase System result register injected',
    mutateExact(
      auditedInstallerIncludeContent,
      'KERNEL32::GetFileAttributesW(w R8) i.R9',
      'KERNEL32::GetFileAttributesW(w R8) i.r9',
      'lowercase System result register injected'
    ),
    /must bind System plug-in values to uppercase \$R registers/u
  ],
  [
    'lowercase spaced System output register injected',
    mutateExact(
      auditedInstallerIncludeContent,
      'KERNEL32::CreateToolhelp32Snapshot(i 0x2, i 0) p.R0 ?e',
      'KERNEL32::CreateToolhelp32Snapshot(i 0x2, i 0) p .r0 ?e',
      'lowercase spaced System output register injected'
    ),
    /must bind System plug-in values to uppercase \$R registers/u
  ],
  [
    'writable probe caller path captured after scratch register write',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '  Push $R4',
        '  Push "${DIRECTORY_VALUE}"',
        '  Pop $R4',
        '  System::Call \'KERNEL32::GetCurrentProcessId() i.R0\''
      ].join('\n'),
      [
        '  Push $R4',
        '  System::Call \'KERNEL32::GetCurrentProcessId() i.R0\'',
        '  Push "${DIRECTORY_VALUE}"',
        '  Pop $R4'
      ].join('\n'),
      'writable probe caller path captured after scratch register write'
    ),
    /must capture its caller directory before scratch register writes/u
  ],
  [
    'writable probe reverts to overwrite-mode FileOpen',
    mutateExact(
      auditedInstallerIncludeContent,
      'System::Call \'KERNEL32::CreateFileW(w R2, i 0x40010000, i 0, p 0, i 1, i 0x80, p 0) p.R0 ?e\'',
      'FileOpen $R0 "$R2" w',
      'writable probe reverts to overwrite-mode FileOpen'
    ),
    /writable-directory probe ordering lacks|must use exclusive handle ownership/u
  ],
  [
    'owned writable probe cleanup reverts to pathname delete',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '!macro phase7DisposeOwnedWriteProbe',
        '  # Delete only the probe represented by the still-exclusive handle. Never',
        '  # fall back to a pathname Delete: another same-user process may recreate the'
      ].join('\n'),
      [
        '!macro phase7DisposeOwnedWriteProbe',
        '  Delete "$R2"',
        '  # unsafe pathname cleanup'
      ].join('\n'),
      'owned writable probe cleanup reverts to pathname delete'
    ),
    /handle-owned writable-probe cleanup ordering lacks|must never delete or reopen/u
  ],
  [
    'transaction root recreates a fixed pathname write probe',
    mutateExact(
      auditedInstallerIncludeContent,
      '  !macro phase7EnsureTransactionRoot\n'
        + '    StrCpy $phase7FreshRootCreated "0"',
      '  !macro phase7EnsureTransactionRoot\n'
        + '    FileOpen $R0 "$INSTDIR\\${PHASE7_WRITE_PROBE_NAME}" w\n'
        + '    StrCpy $phase7FreshRootCreated "0"',
      'transaction root recreates a fixed pathname write probe'
    ),
    /must use parent-relative atomic directory handles/u
  ],
  [
    'transaction preparation failure path-deletes a probe',
    mutateExact(
      auditedInstallerIncludeContent,
      '  !macro phase7FailTransactionPreparation MESSAGE\n'
        + '    !insertmacro phase7CleanupCreatedFreshDirectories',
      '  !macro phase7FailTransactionPreparation MESSAGE\n'
        + '    Delete "$INSTDIR\\${PHASE7_WRITE_PROBE_NAME}"\n'
        + '    !insertmacro phase7CleanupCreatedFreshDirectories',
      'transaction preparation failure path-deletes a probe'
    ),
    /transaction-preparation failure must not remove a pathname/u
  ],
  [
    'transaction preparation failure removes the root by pathname',
    mutateExact(
      auditedInstallerIncludeContent,
      '  !macro phase7FailTransactionPreparation MESSAGE\n'
        + '    !insertmacro phase7CleanupCreatedFreshDirectories',
      '  !macro phase7FailTransactionPreparation MESSAGE\n'
        + '    RMDir "$INSTDIR"\n'
        + '    !insertmacro phase7CleanupCreatedFreshDirectories',
      'transaction preparation failure removes the root by pathname'
    ),
    /transaction-preparation failure must not remove a pathname/u
  ],
  [
    'recovery preparation failure deletes the marker by pathname',
    mutateExact(
      auditedInstallerIncludeContent,
      '  !macro phase7FailRecoveryMarkerPreparation MESSAGE\n'
        + '    ${If} $phase7RecoveryMarkerOwned != "0"',
      '  !macro phase7FailRecoveryMarkerPreparation MESSAGE\n'
        + '    Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"\n'
        + '    ${If} $phase7RecoveryMarkerOwned != "0"',
      'recovery preparation failure deletes the marker by pathname'
    ),
    /pre-registry recovery-marker rollback must not delete or remove a pathname/u
  ],
  [
    'begin transaction closes the pinned recovery marker early',
    mutateExact(
      auditedInstallerIncludeContent,
      '    !insertmacro phase7ReleaseCreatedFreshDirectoryHandles\n'
        + '    # Persist the custom-volume recovery pointer',
      '    !insertmacro phase7ReleaseCreatedFreshDirectoryHandles\n'
        + '    System::Call \'KERNEL32::CloseHandle(p $phase7RecoveryMarkerHandle)\'\n'
        + '    # Persist the custom-volume recovery pointer',
      'begin transaction closes the pinned recovery marker early'
    ),
    /recovery marker handle must remain pinned through registry and extraction/u
  ],
  [
    'stable marker install write closes its identity handle early',
    mutateExact(
      auditedInstallerIncludeContent,
      '  !macro phase7WriteInstallMarker\n'
        + '    !insertmacro phase7WriteFileMarker'
        + ' "${PHASE7_INSTALL_MARKER_NAME}" "${PHASE7_INSTALL_MARKER_VALUE}"\n'
        + '    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle',
      '  !macro phase7WriteInstallMarker\n'
        + '    !insertmacro phase7WriteFileMarker'
        + ' "${PHASE7_INSTALL_MARKER_NAME}" "${PHASE7_INSTALL_MARKER_VALUE}"\n'
        + '    System::Call \'KERNEL32::CloseHandle(p $phase7StableMarkerHandle)\'\n'
        + '    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle',
      'stable marker install write closes its identity handle early'
    ),
    /stable marker handle must remain pinned through installed-identity verification/u
  ],
  [
    'missing default Programs plan broadened beyond the exact default root',
    mutateExact(
      auditedInstallerIncludeContent,
      'StrCmp "$INSTDIR" "$R7" 0'
        + ' phase7_target_not_missing_default_parent_${PHASE7_TARGET_LEAF_ID}',
      'StrCmp "$INSTDIR" "$INSTDIR" 0'
        + ' phase7_target_not_missing_default_parent_${PHASE7_TARGET_LEAF_ID}',
      'missing default Programs plan broadened beyond the exact default root'
    ),
    /missing default Programs parent plan ordering lacks/u
  ],
  [
    'missing default Programs inspection accepts access denied',
    mutateExact(
      auditedInstallerIncludeContent,
      '${AndIf} $R9 != 3',
      '${AndIf} $R9 != 5',
      'missing default Programs inspection accepts access denied'
    ),
    /missing default Programs parent plan ordering lacks/u
  ],
  [
    'existing parent lease permits rename/delete sharing',
    mutateExact(
      auditedInstallerIncludeContent,
      'KERNEL32::CreateFileW(w "${PATH_VALUE}", i 0x001000A4, i 3,'
        + ' p 0, i 3, i 0x02200000, p 0)',
      'KERNEL32::CreateFileW(w "${PATH_VALUE}", i 0x001000A4, i 7,'
        + ' p 0, i 3, i 0x02200000, p 0)',
      'existing parent lease permits rename/delete sharing'
    ),
    /existing-parent no-delete-share identity lease ordering lacks|must never allow FILE_SHARE_DELETE/u
  ],
  [
    'atomic directory creation falls back to pathname CreateDirectory',
    mutateExact(
      auditedInstallerIncludeContent,
      'System::Call \'ntdll::NtCreateFile(p R2, i 0x001100A4, p R8, p R9, p 0,'
        + ' i 0x10, i 3, i 2, i 0x00200021, p 0, i 0) i.R1\'',
      'CreateDirectory "$INSTDIR"',
      'atomic directory creation falls back to pathname CreateDirectory'
    ),
    /lacks (?:ntdll::NtCreateFile|i 0x00200021)|atomic relative-directory creation ordering lacks|must not fall back to pathname/u
  ],
  [
    'atomic directory creation opens an existing leaf',
    mutateExact(
      auditedInstallerIncludeContent,
      'i 0x10, i 3, i 2, i 0x00200021, p 0, i 0) i.R1',
      'i 0x10, i 3, i 1, i 0x00200021, p 0, i 0) i.R1',
      'atomic directory creation opens an existing leaf'
    ),
    /atomic relative-directory creation ordering lacks/u
  ],
  [
    'created directory file identity comparison removed',
    mutateExact(
      auditedInstallerIncludeContent,
      '${OrIf} $R7 != $${EXPECTED_LOW}',
      '${OrIf} $R7 == $${EXPECTED_LOW}',
      'created directory file identity comparison removed'
    ),
    /created-directory file-identity deletion ordering lacks/u
  ],
  [
    'fresh root cleanup reverts to pathname RMDir',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7DeleteIdentityBoundCreatedDirectory phase7FreshRootHandle'
        + ' phase7FreshRootVolumeSerial phase7FreshRootFileIndexHigh'
        + ' phase7FreshRootFileIndexLow R9',
      'RMDir "$INSTDIR"',
      'fresh root cleanup reverts to pathname RMDir'
    ),
    /identity-bound nonrecursive fresh-directory rollback ordering lacks|must not reopen or delete/u
  ],
  [
    'stable marker creation reverts to overwrite-mode FileOpen',
    mutateExact(
      auditedInstallerIncludeContent,
      'System::Call \'KERNEL32::CreateFileW(w "$INSTDIR\\${MARKER_NAME}",'
        + ' i 0xC0010000, i 0, p 0, i 4, i 0x00200080, p 0) p.R0 ?e\'',
      'FileOpen $R0 "$INSTDIR\\${MARKER_NAME}" w',
      'stable marker creation reverts to overwrite-mode FileOpen'
    ),
    /stable-marker create-or-verify handle lifecycle ordering lacks|must stay on one exact/u
  ],
  [
    'stable marker failure cleanup reverts to pathname delete',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7SetHandleDeleteDispositionAndClose'
        + ' $phase7StableMarkerHandle R8',
      'Delete "$INSTDIR\\${PHASE7_INSTALL_MARKER_NAME}"',
      'stable marker failure cleanup reverts to pathname delete'
    ),
    /owned stable-marker failure cleanup ordering lacks|must not delete or reopen/u
  ],
  [
    'marker handle verification accepts hard links',
    mutateExact(
      auditedInstallerIncludeContent,
      '    ${OrIf} $R6 != 1\n'
        + '      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}',
      '    ${OrIf} $R6 != 99\n'
        + '      Goto phase7_marker_handle_verify_done_${PHASE7_MARKER_HANDLE_VERIFY_ID}',
      'marker handle verification accepts hard links'
    ),
    /exact marker handle verification ordering lacks/u
  ],
  [
    'installed identity reopens stable marker by pathname',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '    !insertmacro phase7VerifyMarkerHandle $phase7StableMarkerHandle'
          + ' "${PHASE7_INSTALL_MARKER_VALUE}" R0',
        '    ${If} $R0 != "valid"',
        '      !insertmacro phase7Fail "The committed installation marker is invalid."'
      ].join('\n'),
      [
        '    !insertmacro phase7AssertRequiredNonEmptyFile'
          + ' "${PHASE7_INSTALL_MARKER_NAME}"',
        '    ${If} $R0 != "valid"',
        '      !insertmacro phase7Fail "The committed installation marker is invalid."'
      ].join('\n'),
      'installed identity reopens stable marker by pathname'
    ),
    /installed marker handle verification ordering lacks|without pathname reopen/u
  ],
  [
    'recovery marker failure accepts an unowned marker',
    mutateExact(
      auditedInstallerIncludeContent,
      '${If} $phase7RecoveryMarkerOwned != "0"',
      '${If} $phase7RecoveryMarkerOwned == "0"',
      'recovery marker failure accepts an unowned marker'
    ),
    /pre-registry recovery-marker rollback ordering lacks/u
  ],
  [
    'recovery marker reverts to overwrite-mode FileOpen',
    mutateExact(
      auditedInstallerIncludeContent,
      'System::Call \'KERNEL32::CreateFileW(w "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}",'
        + ' i 0xC0010000, i 0, p 0, i 1, i 0x00200080, p 0) p.R0 ?e\'',
      'FileOpen $R0 "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}" w',
      'recovery marker reverts to overwrite-mode FileOpen'
    ),
    /pinned recovery-marker write and handle readback ordering lacks/u
  ],
  [
    'owned recovery marker cleanup reverts to pathname delete',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '  !macro phase7AbortOwnedRecoveryMarker MESSAGE',
        '    # The marker was returned by CREATE_NEW and is still held exclusively.',
        '    # Failure cleanup acts only on that exact handle.',
        '    !insertmacro phase7SetHandleDeleteDispositionAndClose $phase7RecoveryMarkerHandle R8'
      ].join('\n'),
      [
        '  !macro phase7AbortOwnedRecoveryMarker MESSAGE',
        '    Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"'
      ].join('\n'),
      'owned recovery marker cleanup reverts to pathname delete'
    ),
    /handle-owned recovery-marker cleanup ordering lacks|must not delete or reopen/u
  ],
  [
    'recovery transaction lease permits pathname replacement',
    mutateExact(
      auditedInstallerIncludeContent,
      'i 0x80010000, i 0, p 0, i 3, i 0x00200080, p 0) p.R0 ?e',
      'i 0x80010000, i 7, p 0, i 3, i 0x00200080, p 0) p.R0 ?e',
      'recovery transaction lease permits pathname replacement'
    ),
    /recovery-marker existing-transaction lease ordering lacks/u
  ],
  [
    'recovery marker commit reverts to pathname delete',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '    # Delete the exact recovery marker pinned at transaction start. There is no',
        '    # FileExists/open/Delete pathname interval.',
        '    !insertmacro phase7SetHandleDeleteDispositionAndClose'
          + ' $phase7RecoveryMarkerHandle R8'
      ].join('\n'),
      [
        '    # unsafe pathname commit',
        '    Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"'
      ].join('\n'),
      'recovery marker commit reverts to pathname delete'
    ),
    /recovery-marker handle commit ordering lacks|must delete only/u
  ],
  [
    'registry commit failure deletes the durable recovery marker',
    mutateExact(
      auditedInstallerIncludeContent,
      [
        '      # The committed marker is now the only durable recovery identity. Keep',
        '      # the root intact; a later fresh rerun can validate the marker and resume.',
        '      !insertmacro phase7Fail "The Phase 7 installation recovery path could not be written."'
      ].join('\n'),
      [
        '      # unsafe path-based rollback',
        '      Delete "$INSTDIR\\${PHASE7_RECOVERY_MARKER_NAME}"',
        '      !insertmacro phase7Fail "The Phase 7 installation recovery path could not be written."'
      ].join('\n'),
      'registry commit failure deletes the durable recovery marker'
    ),
    /must preserve a committed recovery marker/u
  ],
  [
    'new transaction uses generic recovery marker writer',
    mutateExact(
      auditedInstallerIncludeContent,
      '!insertmacro phase7WriteRecoveryMarkerForPreparation',
      '!insertmacro phase7WriteFileMarker'
        + ' "${PHASE7_RECOVERY_MARKER_NAME}" "${PHASE7_RECOVERY_MARKER_VALUE}"',
      'new transaction uses generic recovery marker writer'
    ),
    /recovery identity before registry commit ordering lacks/u
  ]
]) {
  assert.throws(
    () => assertPhase7InstallerIncludeSemantics(mutatedInclude),
    expectedError,
    name
  );
}
assert.doesNotThrow(() => assertPhase7AppBuilderPatchHeaders(auditedAppBuilderPatchBytes));
const auditedAppBuilderPatchText = auditedAppBuilderPatchBytes.toString('utf8');
for (const [name, mutatedPatch, expectedError] of [
  [
    'missing audited patch header',
    mutateExact(
      auditedAppBuilderPatchText,
      'diff --git a/templates/nsis/assistedInstaller.nsh'
        + ' b/templates/nsis/assistedInstaller.nsh\n',
      '',
      'missing audited patch header'
    ),
    /must change exactly the six audited NSIS templates/u
  ],
  [
    'seventh patch header injected',
    `${auditedAppBuilderPatchText}\n`
      + 'diff --git a/templates/nsis/unsafe.nsh b/templates/nsis/unsafe.nsh\n',
    /must change exactly the six audited NSIS templates/u
  ],
  [
    'duplicate patch header injected',
    `${auditedAppBuilderPatchText}\n`
      + 'diff --git a/templates/nsis/uninstaller.nsh'
      + ' b/templates/nsis/uninstaller.nsh\n',
    /must change exactly the six audited NSIS templates/u
  ],
  [
    'patch path rename injected',
    mutateExact(
      auditedAppBuilderPatchText,
      'diff --git a/templates/nsis/installer.nsi b/templates/nsis/installer.nsi',
      'diff --git a/templates/nsis/installer.nsi b/templates/nsis/unsafe-installer.nsi',
      'patch path rename injected'
    ),
    /must not rename template paths/u
  ]
]) {
  assert.throws(
    () => assertPhase7AppBuilderPatchHeaders(mutatedPatch),
    expectedError,
    name
  );
}
const installerPolicyFixtureRoot = await mkdtemp(join(tmpdir(), 'desktop-translate-nsis-policy-'));
try {
  const portableTreeA = await writePortablePackageTreeFixture(
    'portable-tree-a',
    'C:\\checkout-a\\node_modules\\.pnpm'
  );
  const portableTreeB = await writePortablePackageTreeFixture(
    'portable-tree-b',
    'D:\\different checkout\\node_modules\\.pnpm'
  );
  assert.deepEqual(
    await computePackageTreeIdentity(portableTreeA),
    await computePackageTreeIdentity(portableTreeB)
  );
  await mkdir(join(portableTreeB, 'node_modules', 'shadow-package'), { recursive: true });
  await assert.rejects(
    computePackageTreeIdentity(portableTreeB),
    /may contain only pnpm generated \.bin wrappers/u
  );

  const validFixture = await writeInstallerPolicyFixture('valid');
  let patchPolicyEvidence;
  await assert.doesNotReject(
    async () => {
      patchPolicyEvidence = await assertInstallerPolicyFixture(validFixture.configurationPath);
    }
  );
  const exactPatchInputs = {
    rootPackageBytes: await readFile(patchPolicyEvidence.rootPackagePath),
    gitAttributesBytes: await readFile(patchPolicyEvidence.gitAttributesPath),
    workspaceBytes: await readFile(patchPolicyEvidence.workspacePath),
    lockfileBytes: await readFile(patchPolicyEvidence.lockfilePath),
    patchBytes: await readFile(patchPolicyEvidence.patchPath),
    fluentPatchBytes: await readFile(patchPolicyEvidence.fluentPatchPath),
    electronBuilderPackageBytes: await readFile(
      patchPolicyEvidence.electronBuilderPackagePath
    ),
    electronBuilderCliBytes: await readFile(patchPolicyEvidence.electronBuilderCliPath),
    electronBuilderTree: patchPolicyEvidence.electronBuilderTree,
    appBuilderPackageBytes: await readFile(patchPolicyEvidence.appBuilderPackagePath),
    assistedInstallerTemplateBytes: await readFile(
      patchPolicyEvidence.assistedInstallerTemplatePath
    ),
    installerTemplateBytes: await readFile(patchPolicyEvidence.installerTemplatePath),
    installSectionTemplateBytes: await readFile(
      patchPolicyEvidence.installSectionTemplatePath
    ),
    uninstallerTemplateBytes: await readFile(patchPolicyEvidence.uninstallerTemplatePath),
    extractAppPackageTemplateBytes: await readFile(
      patchPolicyEvidence.extractAppPackageTemplatePath
    ),
    installUtilTemplateBytes: await readFile(patchPolicyEvidence.installUtilTemplatePath),
    appBuilderTree: patchPolicyEvidence.appBuilderTree,
    fluentPackageBytes: await readFile(patchPolicyEvidence.fluentPackagePath),
    fluentLicenseBytes: await readFile(patchPolicyEvidence.fluentLicensePath),
    noticeGeneratorBytes: await readFile(patchPolicyEvidence.noticeGeneratorPath)
  };
  const assistedInstallerTemplate = exactPatchInputs.assistedInstallerTemplateBytes.toString('utf8');
  const installSectionTemplate = exactPatchInputs.installSectionTemplateBytes.toString('utf8');
  const uninstallerTemplate = exactPatchInputs.uninstallerTemplateBytes.toString('utf8');
  const installUtilTemplate = exactPatchInputs.installUtilTemplateBytes.toString('utf8');
  assert.ok(
    assistedInstallerTemplate.indexOf('!insertmacro phase7DirectoryPagePre')
      < assistedInstallerTemplate.indexOf('!insertmacro MUI_PAGE_DIRECTORY'),
    'registered reruns must be skipped before the directory page is declared'
  );
  const initialTargetValidation = installSectionTemplate.indexOf(
    '!insertmacro phase7ValidateInstallTargetBeforeMutation'
  );
  const registryWritableProbe = installSectionTemplate.indexOf(
    '!insertmacro phase7ProbeRegistryWritable'
  );
  const targetRevalidation = installSectionTemplate.indexOf(
    '!insertmacro phase7ValidateInstallTargetBeforeMutation',
    registryWritableProbe + 1
  );
  assert.ok(
    initialTargetValidation < registryWritableProbe
      && registryWritableProbe < targetRevalidation
      && targetRevalidation < installSectionTemplate.indexOf('!insertmacro CHECK_APP_RUNNING'),
    'target identity must be rechecked after the scratch registry probe before CHECK_APP_RUNNING'
  );
  assert.ok(
    installSectionTemplate.indexOf('One or more application files could not be installed.')
      < installSectionTemplate.indexOf('!insertmacro phase7WriteInstallMarker'),
    'application extraction errors must be rejected before the stable marker'
  );
  assert.ok(
    uninstallerTemplate.indexOf('!insertmacro customUnInit')
      < uninstallerTemplate.indexOf('call un.checkAppRunning'),
    'uninstall identity must be checked before CHECK_APP_RUNNING'
  );
  assert.doesNotThrow(() => assertPhase7InstallUtilSemantics(installUtilTemplate));
  for (const [name, mutation, expectedError] of [
    [
      'installed old uninstaller copy restored',
      `${installUtilTemplate}\n`
        + '!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"\n',
      /must not contain !insertmacro copyFile/u
    ],
    [
      'installed old uninstaller fallback restored',
      `${installUtilTemplate}\nTryInPlace:\n`
        + '  ExecWait \'"$uninstallerFileName" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0\n',
      /must not contain TryInPlace:/u
    ],
    [
      'embedded current helper file error branch removed',
      mutateExact(
        installUtilTemplate,
        [
          '  ${if} ${errors}',
          '    SetErrors',
          '    Return',
          '  ${endif}'
        ].join('\n'),
        '',
        'embedded current helper file error branch removed'
      ),
      /current-version upgrade uninstaller launch ordering lacks \$\{if\} \$\{errors\}/u
    ],
    [
      'second upgrade ExecWait injected',
      `${installUtilTemplate}\n`
        + 'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0\n',
      /must contain exactly one ExecWait, got 2/u
    ],
    [
      'whole uninstall transaction retry restored',
      `${installUtilTemplate}\nOneMoreAttempt:\n  Goto OneMoreAttempt\n`,
      /must not contain OneMoreAttempt:/u
    ]
  ]) {
    assert.throws(
      () => assertPhase7InstallUtilSemantics(mutation),
      expectedError,
      name
    );
  }
  assert.doesNotThrow(() => assertAppBuilderPatchPolicy(exactPatchInputs));
  for (const [name, mutation, expectedError] of [
    [
      'tampered patch bytes',
      {
        patchBytes: Buffer.concat([
          exactPatchInputs.patchBytes,
          Buffer.from('\n# unsafe mutation\n', 'utf8')
        ])
      },
      /patch SHA-256 is not exact/u
    ],
    [
      'tampered root package manager',
      {
        rootPackageBytes: Buffer.from(
          exactPatchInputs.rootPackageBytes
            .toString('utf8')
            .replace('"packageManager": "pnpm@10.32.1"', '"packageManager": "npm@99.0.0"'),
          'utf8'
        )
      },
      /must pin packageManager exactly to pnpm@10\.32\.1/u
    ],
    [
      'tampered patch EOL attribute',
      {
        gitAttributesBytes: Buffer.from(
          'patches/app-builder-lib@26.15.3.patch text eol=crlf\n',
          'utf8'
        )
      },
      /must pin the app-builder-lib patch to exact LF bytes/u
    ],
    [
      'tampered root electron-builder version',
      {
        rootPackageBytes: Buffer.from(
          exactPatchInputs.rootPackageBytes
            .toString('utf8')
            .replace('"electron-builder": "26.15.3"', '"electron-builder": "99.0.0"'),
          'utf8'
        )
      },
      /must pin electron-builder exactly to 26\.15\.3/u
    ],
    [
      'tampered workspace patch path',
      {
        workspaceBytes: Buffer.from(
          exactPatchInputs.workspaceBytes
            .toString('utf8')
            .replace(
              'patches/app-builder-lib@26.15.3.patch',
              'patches/unsafe-app-builder-lib.patch'
            ),
          'utf8'
        )
      },
      /workspace must pin both exact reviewed patch paths/u
    ],
    [
      'root package patch shadow',
      {
        rootPackageBytes: Buffer.from(
          exactPatchInputs.rootPackageBytes
            .toString('utf8')
            .replace(
              '"devDependencies": {',
              '"pnpm": {"patchedDependencies": {}},\n  "devDependencies": {'
            ),
          'utf8'
        )
      },
      /must not shadow pnpm workspace patch policy/u
    ],
    [
      'extra workspace patch target',
      {
        workspaceBytes: Buffer.from(
          exactPatchInputs.workspaceBytes
            .toString('utf8')
            .replace(
              '  app-builder-lib@26.15.3: patches/app-builder-lib@26.15.3.patch',
              '  app-builder-lib@26.15.3: patches/app-builder-lib@26.15.3.patch'
                + '\n  electron-builder@26.15.3: patches/unsafe.patch'
            ),
          'utf8'
        )
      },
      /workspace patchedDependencies keys must be exactly/u
    ],
    [
      'tampered lock importer version',
      {
        lockfileBytes: Buffer.from(
          exactPatchInputs.lockfileBytes
            .toString('utf8')
            .replace(
              'electron-builder:\n        specifier: 26.15.3',
              'electron-builder:\n        specifier: 99.0.0'
            ),
          'utf8'
        )
      },
      /root importer must pin the exact electron-builder/u
    ],
    [
      'tampered lock patch hash',
      {
        lockfileBytes: Buffer.from(
          exactPatchInputs.lockfileBytes
            .toString('utf8')
            .replace(
              auditedAppBuilderPatchSha256,
              '0'.repeat(64)
            ),
          'utf8'
        )
      },
      /pnpm lockfile must bind the exact/u
    ],
    [
      'extra lock patch target',
      {
        lockfileBytes: Buffer.from(
          exactPatchInputs.lockfileBytes
            .toString('utf8')
            .replace(
              '    path: patches/app-builder-lib@26.15.3.patch',
              '    path: patches/app-builder-lib@26.15.3.patch'
                + '\n  electron-builder@26.15.3:'
                + '\n    hash: ' + '1'.repeat(64)
                + '\n    path: patches/unsafe.patch'
            ),
          'utf8'
        )
      },
      /lockfile patchedDependencies keys must be exactly/u
    ],
    [
      'tampered Fluent LICENSE patch bytes',
      {
        fluentPatchBytes: Buffer.concat([
          exactPatchInputs.fluentPatchBytes,
          Buffer.from('\n# unsafe mutation\n', 'utf8')
        ])
      },
      /LICENSE patch SHA-256 is not exact/u
    ],
    [
      'tampered electron-builder dependency edge',
      {
        electronBuilderPackageBytes: Buffer.from(
          exactPatchInputs.electronBuilderPackageBytes
            .toString('utf8')
            .replace('"app-builder-lib": "26.15.3"', '"app-builder-lib": "99.0.0"'),
          'utf8'
        )
      },
      /identity, CLI, and app-builder-lib dependency must be exact/u
    ],
    [
      'tampered electron-builder CLI',
      {
        electronBuilderCliBytes: Buffer.concat([
          exactPatchInputs.electronBuilderCliBytes,
          Buffer.from('\n// unsafe mutation\n', 'utf8')
        ])
      },
      /electron-builder CLI SHA-256 is not exact/u
    ],
    [
      'tampered electron-builder package tree',
      {
        electronBuilderTree: {
          ...exactPatchInputs.electronBuilderTree,
          fileCount: exactPatchInputs.electronBuilderTree.fileCount + 1
        }
      },
      /electron-builder package tree identity is not exact/u
    ],
    [
      'tampered installed app-builder identity',
      {
        appBuilderPackageBytes: Buffer.from(
          exactPatchInputs.appBuilderPackageBytes
            .toString('utf8')
            .replace('"version": "26.15.3"', '"version": "26.15.4"'),
          'utf8'
        )
      },
      /identity must be exactly 26\.15\.3/u
    ],
    [
      'tampered assisted installer template',
      {
        assistedInstallerTemplateBytes: Buffer.from(
          exactPatchInputs.assistedInstallerTemplateBytes
            .toString('utf8')
            .replace(
              '!insertmacro phase7DirectoryPagePre',
              '!insertmacro skipPageIfUpdated'
            ),
          'utf8'
        )
      },
      /assisted installer template SHA-256 is not exact/u
    ],
    [
      'tampered installer template',
      {
        installerTemplateBytes: Buffer.from(
          exactPatchInputs.installerTemplateBytes
            .toString('utf8')
            .replace('!insertmacro phase7InitCurrentUser', '!insertmacro initMultiUser'),
          'utf8'
        )
      },
      /installer template SHA-256 is not exact/u
    ],
    [
      'tampered install section template',
      {
        installSectionTemplateBytes: Buffer.from(
          exactPatchInputs.installSectionTemplateBytes
            .toString('utf8')
            .replace('!insertmacro phase7WriteInstallMarker', ''),
          'utf8'
        )
      },
      /install section template SHA-256 is not exact/u
    ],
    [
      'tampered uninstaller template',
      {
        uninstallerTemplateBytes: Buffer.from(
          exactPatchInputs.uninstallerTemplateBytes
            .toString('utf8')
            .replace('!insertmacro phase7InitCurrentUser', '!insertmacro initMultiUser'),
          'utf8'
        )
      },
      /uninstaller template SHA-256 is not exact/u
    ],
    [
      'tampered extract application package template',
      {
        extractAppPackageTemplateBytes: Buffer.from(
          exactPatchInputs.extractAppPackageTemplateBytes
            .toString('utf8')
            .replace('/SD IDCANCEL', '/SD IDRETRY'),
          'utf8'
        )
      },
      /extract application package template SHA-256 is not exact/u
    ],
    [
      'tampered old-version uninstall utility template',
      {
        installUtilTemplateBytes: Buffer.from(
          exactPatchInputs.installUtilTemplateBytes
            .toString('utf8')
            .replace(
              'StrCpy $installationDir "$phase7RegisteredPath"',
              '!insertmacro readReg $installationDir "$rootKey"'
                + ' "${INSTALL_REGISTRY_KEY}" InstallLocation'
            ),
          'utf8'
        )
      },
      /current-version upgrade uninstall utility template SHA-256 is not exact/u
    ],
    [
      'tampered app-builder-lib package tree',
      {
        appBuilderTree: {
          ...exactPatchInputs.appBuilderTree,
          sha256: '0'.repeat(64)
        }
      },
      /patched app-builder-lib package tree identity is not exact/u
    ],
    [
      'missing installed Fluent LICENSE',
      {
        fluentLicenseBytes: Buffer.alloc(0)
      },
      /installed @fluentui\/react-icons LICENSE is missing or not exact/u
    ],
    [
      'tampered runtime notice gate',
      {
        noticeGeneratorBytes: Buffer.concat([
          exactPatchInputs.noticeGeneratorBytes,
          Buffer.from('\n// unsafe mutation\n', 'utf8')
        ])
      },
      /notice generator SHA-256 is not exact/u
    ]
  ]) {
    assert.ok(
      Object.entries(mutation).some(([key, value]) => {
        const original = exactPatchInputs[key];
        if (Buffer.isBuffer(value) && Buffer.isBuffer(original)) {
          return !value.equals(original);
        }
        return JSON.stringify(value) !== JSON.stringify(original);
      }),
      `${name} mutation must change at least one audited input`
    );
    assert.throws(
      () => assertAppBuilderPatchPolicy({ ...exactPatchInputs, ...mutation }),
      expectedError,
      name
    );
  }

  const implicitScriptFixture = await writeInstallerPolicyFixture('implicit-script', {
    implicitScript: '!include unsafe.nsh\n'
  });
  await assert.rejects(
    assertInstallerPolicyFixture(implicitScriptFixture.configurationPath),
    /implicit default installer\.nsi is forbidden/u
  );

  const shadowFixture = await writeInstallerPolicyFixture('shadow', {
    nestedShadowInclude: '!macro customInstallMode\n!macroend\n'
  });
  await assert.rejects(
    assertInstallerPolicyFixture(shadowFixture.configurationPath),
    /shadow installer include is forbidden/u
  );

  const projectFallbackFixture = await writeInstallerPolicyFixture('project-fallback', {
    includeContent: undefined,
    projectFallbackInclude: auditedInstallerIncludeContent
  });
  await assert.rejects(
    assertInstallerPolicyFixture(projectFallbackFixture.configurationPath),
    /project fallback or shadow resolution is forbidden/u
  );

  const tamperedFixture = await writeInstallerPolicyFixture('tampered', {
    includeContent: auditedInstallerIncludeContent.replace(
      'StrCpy $hasPerMachineInstallation "0"',
      'StrCpy $hasPerMachineInstallation "1"'
    )
  });
  await assert.rejects(
    assertInstallerPolicyFixture(tamperedFixture.configurationPath),
    /audited Phase 7 installer include SHA-256 is not exact/u
  );

  const shadowCliFixture = await writeInstallerPolicyFixture('shadow-cli', {
    appLocalBuilderShadow: '@echo unsafe\r\n'
  });
  await assert.rejects(
    assertInstallerPolicyFixture(shadowCliFixture.configurationPath),
    /app-local electron-builder shadow is forbidden/u
  );

  const packageManagerFixture = await writeInstallerPolicyFixture('wrong-package-manager', {
    packageManager: 'npm@99.0.0'
  });
  await assert.rejects(
    assertInstallerPolicyFixture(packageManagerFixture.configurationPath),
    /desktop package\.json must pin packageManager exactly to pnpm@10\.32\.1/u
  );

  const messagesFixture = await writeInstallerPolicyFixture('messages-resource', {
    extraBuildResource: {
      path: ['messages.yml'],
      content: 'unsafe: message override\n'
    }
  });
  await assert.rejects(
    assertInstallerPolicyFixture(messagesFixture.configurationPath),
    /buildResources exact set must contain only audited installer\.nsh/u
  );

  const pluginFixture = await writeInstallerPolicyFixture('plugin-resource', {
    extraBuildResource: {
      path: ['x86-unicode', 'UAC.dll'],
      content: 'unsafe plugin bytes'
    }
  });
  await assert.rejects(
    assertInstallerPolicyFixture(pluginFixture.configurationPath),
    /buildResources exact set must contain only audited installer\.nsh/u
  );
} finally {
  await rm(installerPolicyFixtureRoot, { recursive: true, force: true });
}
assert.throws(
  () => assertExactAttestationBundle(bundleFor([...records, records[0]].map((item) => item.sha256)), records.map((item) => item.sha256)),
  /duplicate subjects/u
);
assert.throws(
  () => assertExactArtifactSet([...records, record('extra', 'extra.exe', 'extra.exe', 'e')], records, 'extra artifact', expectedArtifactRoles(true)),
  /roles must be exactly/u
);
assert.throws(
  () => assertExactArtifactSet(records.map((item) => item.role === 'application' ? { ...item, sha256: 'f'.repeat(64) } : item), records, 'stale hash'),
  /does not match the current file/u
);
assert.throws(
  () => assertExactArtifactSet([...records, records[0]], records, 'duplicate role'),
  /duplicate artifact roles/u
);

console.log('[phase5:release-evidence:selftest] exact-set, stale-hash, and strict CurrentUser assisted NSIS negative cases PASS.');

function record(role, path, name, seed) {
  return { role, path, name, size: 100, sha256: seed.repeat(64) };
}

function bundleFor(digests) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: digests.map((sha256, index) => ({ name: `artifact-${index}`, digest: { sha256 } }))
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } };
}

function assertInstallerPolicyFixture(configurationPath) {
  return assertElectronBuilderSigningPolicyFile(configurationPath, { repositoryRoot });
}

async function writePortablePackageTreeFixture(name, generatedAbsolutePath) {
  const root = join(installerPolicyFixtureRoot, name);
  const bin = join(root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"portable-fixture"}\n', 'utf8');
  await writeFile(
    join(bin, 'tool.CMD'),
    `@SET "NODE_PATH=${generatedAbsolutePath}"\r\n`,
    'utf8'
  );
  return root;
}

async function writeInstallerPolicyFixture(name, options = {}) {
  const projectDirectory = join(installerPolicyFixtureRoot, name);
  const buildResourcesDirectory = join(projectDirectory, 'build');
  await mkdir(buildResourcesDirectory, { recursive: true });
  const configurationPath = join(projectDirectory, 'electron-builder.yml');
  await writeFile(
    join(projectDirectory, 'package.json'),
    JSON.stringify({
      name: '@desktop-translate/policy-fixture',
      version: '0.0.0',
      packageManager: options.packageManager ?? 'pnpm@10.32.1'
    }),
    'utf8'
  );
  await writeFile(configurationPath, signingConfig, 'utf8');
  const toolingDirectory = join(projectDirectory, 'tooling');
  await mkdir(toolingDirectory, { recursive: true });
  await writeFile(
    join(toolingDirectory, 'phase5-after-extract.mjs'),
    auditedAfterExtractHookContent,
    'utf8'
  );
  if (options.includeContent !== undefined || !Object.hasOwn(options, 'includeContent')) {
    await writeFile(
      join(buildResourcesDirectory, 'installer.nsh'),
      options.includeContent ?? auditedInstallerIncludeContent,
      'utf8'
    );
  }
  if (options.implicitScript !== undefined) {
    await writeFile(
      join(buildResourcesDirectory, 'installer.nsi'),
      options.implicitScript,
      'utf8'
    );
  }
  if (options.nestedShadowInclude !== undefined) {
    const shadowDirectory = join(buildResourcesDirectory, 'build');
    await mkdir(shadowDirectory, { recursive: true });
    await writeFile(
      join(shadowDirectory, 'installer.nsh'),
      options.nestedShadowInclude,
      'utf8'
    );
  }
  if (options.projectFallbackInclude !== undefined) {
    await writeFile(
      join(projectDirectory, 'installer.nsh'),
      options.projectFallbackInclude,
      'utf8'
    );
  }
  if (options.appLocalBuilderShadow !== undefined) {
    const appLocalBin = join(projectDirectory, 'node_modules', '.bin');
    await mkdir(appLocalBin, { recursive: true });
    await writeFile(
      join(appLocalBin, 'electron-builder.CMD'),
      options.appLocalBuilderShadow,
      'utf8'
    );
  }
  if (options.extraBuildResource !== undefined) {
    const extraPath = join(buildResourcesDirectory, ...options.extraBuildResource.path);
    await mkdir(dirname(extraPath), { recursive: true });
    await writeFile(extraPath, options.extraBuildResource.content, 'utf8');
  }
  return { configurationPath };
}

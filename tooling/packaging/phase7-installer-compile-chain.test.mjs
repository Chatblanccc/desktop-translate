import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dump } from 'js-yaml';
import { assertAppBuilderPatchPolicyFiles } from './phase5-electron-builder-policy.mjs';
import {
  assertPhase7BuilderDebugInstallUtilBinding,
  assertPhase7InstallerCompileChain,
  assertPhase7InstallUtilUpgradeEmbedding
} from './phase7-installer-compile-chain.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const canonicalInstallerName = 'Desktop-Translate-0.5.0-phase5-x64-setup.exe';

function builderDebug(includeDirectories) {
  const script = [
    ...includeDirectories.map((directory) => `!addincludedir "${directory}"`),
    '!include "installUtil.nsh"'
  ].join('\n');
  return dump({ nsis: { script } }, { lineWidth: 8000 });
}

test('production compile-chain binds the candidate to the real patched installUtil', async () => {
  const policy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  const runRoot = await mkdtemp(join(tmpdir(), 'phase7-compile-chain-selftest-'));
  try {
    const debugPath = join(runRoot, 'builder-debug.yml');
    const installerPath = join(runRoot, canonicalInstallerName);
    await writeFile(
      debugPath,
      builderDebug([dirname(policy.installUtilTemplatePath)]),
      'utf8'
    );
    await writeFile(installerPath, Buffer.from('MZ phase7 compile-chain candidate', 'utf8'));

    const result = await assertPhase7InstallerCompileChain({
      repositoryRoot,
      builderDebugPath: debugPath,
      candidateInstallerPath: installerPath
    });
    assert.equal(result.status, 'PASS');
    assert.equal(
      result.installUtilSha256,
      '01b643c1c82a53cb258f6f651daecfb45b679076e3d6cee9f0ec18020684afcb'
    );
    assert.equal(result.embeddedCurrentHelperCount, 1);
    assert.equal(result.installedOldFallbackCount, 0);
    assert.equal(result.helperLaunchCount, 1);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('installUtil semantic gate rejects an installed-old in-place fallback', async () => {
  const policy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  const exact = await readFile(policy.installUtilTemplatePath, 'utf8');
  const mutated = exact.replace(
    '  ifErrors DoesNotExist',
    [
      '  ifErrors TryInPlace',
      '  TryInPlace:',
      '  ExecWait \'"$uninstallerFileName" /S _?=$installationDir\' $R0',
      '  ifErrors DoesNotExist'
    ].join('\n')
  );
  assert.throws(
    () => assertPhase7InstallUtilUpgradeEmbedding(mutated),
    /forbidden (?:the )?in-place fallback/u
  );
});

test('installUtil semantic gate rejects copying the installed old uninstaller', async () => {
  const policy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  const exact = await readFile(policy.installUtilTemplatePath, 'utf8');
  const mutated = exact.replace(
    'File "/oname=phase7-current-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"',
    '!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"'
  );
  assert.throws(
    () => assertPhase7InstallUtilUpgradeEmbedding(mutated),
    /forbidden copying the registered installed uninstaller/u
  );
});

test('installUtil semantic gate rejects retrying the complete uninstall transaction', async () => {
  const policy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  const exact = await readFile(policy.installUtilTemplatePath, 'utf8');
  const mutated = exact.replace(
    '  ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
    [
      '  OneMoreAttempt:',
      '  ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
      '  Goto OneMoreAttempt'
    ].join('\n')
  );
  assert.throws(
    () => assertPhase7InstallUtilUpgradeEmbedding(mutated),
    /forbidden a whole-transaction retry/u
  );
});

test('builder-debug binding rejects a later include-directory shadow', async () => {
  const policy = await assertAppBuilderPatchPolicyFiles(repositoryRoot);
  const runRoot = await mkdtemp(join(tmpdir(), 'phase7-compile-chain-shadow-'));
  try {
    const shadowRoot = join(runRoot, 'shadow');
    await mkdir(shadowRoot);
    await writeFile(join(shadowRoot, 'installUtil.nsh'), 'unsafe shadow', 'utf8');
    await assert.rejects(
      assertPhase7BuilderDebugInstallUtilBinding({
        builderDebugContent: builderDebug([
          dirname(policy.installUtilTemplatePath),
          shadowRoot
        ]),
        expectedIncludeDirectory: dirname(policy.installUtilTemplatePath)
      }),
      /installUtil\.nsh shadow/u
    );
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('phase5 installer packaging runs the compile-chain gate before deleting debug metadata', async () => {
  const packageScript = await readFile(
    join(repositoryRoot, 'tooling', 'packaging', 'phase5-package.ps1'),
    'utf8'
  );
  const builderIndex = packageScript.indexOf(
    'Invoke-CheckedExternal -Label "electron-builder $Mode"'
  );
  const compileChainIndex = packageScript.indexOf(
    "Verify Phase 7 embedded current-uninstaller compile chain"
  );
  const debugDeleteIndex = packageScript.indexOf(
    '[IO.File]::Delete($builderDebugItem.FullName)'
  );
  assert.ok(builderIndex >= 0, 'electron-builder launch is missing');
  assert.ok(
    compileChainIndex > builderIndex,
    'compile-chain gate must run after electron-builder succeeds'
  );
  assert.ok(
    debugDeleteIndex > compileChainIndex,
    'compile-chain gate must run before builder-debug.yml deletion'
  );
  assert.match(packageScript, /\$env:DEBUG = 'electron-builder'/u);
});

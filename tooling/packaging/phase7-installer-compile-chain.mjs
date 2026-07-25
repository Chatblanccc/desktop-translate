import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import {
  assertAppBuilderPatchPolicyFiles,
  auditedPatchedInstallUtilTemplateSha256
} from './phase5-electron-builder-policy.mjs';

const gateLabel = '[phase7:installer-compile-chain]';
const canonicalInstallerName = 'Desktop-Translate-0.5.0-phase5-x64-setup.exe';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/gu, '\n');
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function countMatches(value, expression) {
  return [...value.matchAll(expression)].length;
}

async function assertRegularNonSymlinkFile(filePath, label) {
  const path = resolve(filePath);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`${label} is missing: ${path}`, { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return { path, info };
}

function extractUninstallOldVersion(template) {
  const functionStart = template.indexOf('Function uninstallOldVersion');
  if (functionStart === -1) {
    throw new Error('installed installUtil.nsh lacks Function uninstallOldVersion');
  }
  const functionEnd = template.indexOf('\nFunctionEnd', functionStart);
  if (functionEnd === -1) {
    throw new Error('installed installUtil.nsh has an unterminated uninstallOldVersion function');
  }
  return template.slice(functionStart, functionEnd + '\nFunctionEnd'.length);
}

export function assertPhase7InstallUtilUpgradeEmbedding(templateContent) {
  if (typeof templateContent !== 'string') {
    throw new TypeError('installed installUtil.nsh content must be a string');
  }
  const block = extractUninstallOldVersion(normalizeNewlines(templateContent));
  const forbidden = [
    [/\$PLUGINSDIR\\old-uninstaller\.exe/iu, 'the installed old-uninstaller staging path'],
    [/^[ \t]*TryInPlace[ \t]*:/imu, 'the in-place fallback label'],
    [
      /^[ \t]*!insertmacro[ \t]+copyFile\b[^\n]*\$uninstallerFileName/imu,
      'copying the registered installed uninstaller'
    ],
    [
      /^[ \t]*CopyFiles\b[^\n]*\$uninstallerFileName/imu,
      'copying the registered installed uninstaller directly'
    ],
    [
      /^[ \t]*ExecWait\b[^\n]*\$uninstallerFileName(?!Temp)/imu,
      'executing the registered installed uninstaller'
    ],
    [
      /^[ \t]*(?:UninstallLoop|OneMoreAttempt|CheckResult)[ \t]*:/imu,
      'a whole-transaction retry label'
    ],
    [
      /^[ \t]*Goto[ \t]+(?:UninstallLoop|OneMoreAttempt)\b/imu,
      'a whole-transaction retry jump'
    ],
    [
      /^[ \t]*MessageBox\b[^\n]*MB_RETRYCANCEL/imu,
      'an interactive whole-transaction retry prompt'
    ],
    [/^[ \t]*Sleep[ \t]+1000\b/imu, 'a delayed whole-transaction retry'],
    [/^[ \t]*(?:ReadRegStr|ReadRegDWORD)\b/imu, 're-reading mutable registry state']
  ];
  for (const [expression, description] of forbidden) {
    if (expression.test(block)) {
      throw new Error(`installed installUtil.nsh upgrade path contains forbidden ${description}`);
    }
  }

  const orderedTokens = [
    'StrCpy $uninstallString "$phase7RegisteredUninstallString"',
    'StrCpy $installationDir "$phase7RegisteredPath"',
    'StrCpy $R5 "$phase7RegisteredKeepShortcuts"',
    'InitPluginsDir',
    'StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\phase7-current-uninstaller.exe"',
    'ClearErrors',
    'SetOutPath "$PLUGINSDIR"',
    'File "/oname=phase7-current-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"',
    'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0',
    'ifErrors DoesNotExist',
    'Return',
    'DoesNotExist:',
    'SetErrors'
  ];
  let previous = -1;
  for (const token of orderedTokens) {
    const position = block.indexOf(token, previous + 1);
    if (position === -1) {
      throw new Error(`installed installUtil.nsh upgrade path lacks ordered token: ${token}`);
    }
    previous = position;
  }

  const fileInstructionCount = countMatches(block, /^[ \t]*File(?:[ \t]|$)/gmu);
  if (fileInstructionCount !== 1) {
    throw new Error(
      `installed installUtil.nsh upgrade path must contain exactly one File instruction, got ${fileInstructionCount}`
    );
  }
  const embeddedHelperCount = countMatches(
    block,
    /^[ \t]*File[ \t]+"\/oname=phase7-current-uninstaller\.exe"[ \t]+"\$\{UNINSTALLER_OUT_FILE\}"[ \t]*$/gmu
  );
  if (embeddedHelperCount !== 1) {
    throw new Error(
      'installed installUtil.nsh must embed ${UNINSTALLER_OUT_FILE} exactly once as phase7-current-uninstaller.exe'
    );
  }
  const execWaitLines = block.match(/^[ \t]*ExecWait\b.*$/gmu) ?? [];
  const expectedExecWait =
    'ExecWait \'"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0';
  if (execWaitLines.length !== 1 || execWaitLines[0].trim() !== expectedExecWait) {
    throw new Error(
      'installed installUtil.nsh must launch the embedded current helper exactly once'
    );
  }

  return {
    embeddedCurrentHelperCount: embeddedHelperCount,
    installedOldFallbackCount: 0,
    helperLaunchCount: execWaitLines.length
  };
}

function parseBuilderDebug(builderDebugContent) {
  let parsed;
  try {
    parsed = load(builderDebugContent);
  } catch (error) {
    throw new Error(`builder-debug.yml could not be parsed: ${error.message}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('builder-debug.yml root must be a mapping');
  }
  if (parsed.nsis === null
      || typeof parsed.nsis !== 'object'
      || Array.isArray(parsed.nsis)
      || typeof parsed.nsis.script !== 'string') {
    throw new Error('builder-debug.yml must contain one scalar nsis.script');
  }
  return normalizeNewlines(parsed.nsis.script);
}

export async function assertPhase7BuilderDebugInstallUtilBinding({
  builderDebugContent,
  expectedIncludeDirectory
}) {
  if (typeof builderDebugContent !== 'string') {
    throw new TypeError('builder-debug.yml content must be a string');
  }
  const script = parseBuilderDebug(builderDebugContent);
  const expectedIncludeRoot = await realpath(resolve(expectedIncludeDirectory));
  const includeDirectoryMatches = [
    ...script.matchAll(
      /^[ \t]*!addincludedir(?:[ \t]+\/[^\s"]+)*[ \t]+"([^"\r\n]+)"[ \t]*$/gmu
    )
  ];
  if (includeDirectoryMatches.length === 0) {
    throw new Error('builder-debug.yml nsis.script contains no literal !addincludedir directives');
  }

  let exactIncludeRootCount = 0;
  for (const match of includeDirectoryMatches) {
    if (!isAbsolute(match[1])) {
      throw new Error(`builder-debug.yml contains a non-absolute NSIS include directory: ${match[1]}`);
    }
    let includeRoot;
    try {
      includeRoot = await realpath(resolve(match[1]));
    } catch (error) {
      throw new Error(
        `builder-debug.yml NSIS include directory cannot be resolved: ${match[1]}`,
        { cause: error }
      );
    }
    if (samePath(includeRoot, expectedIncludeRoot)) {
      exactIncludeRootCount += 1;
      continue;
    }

    try {
      await lstat(resolve(includeRoot, 'installUtil.nsh'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `builder-debug.yml adds an installUtil.nsh shadow outside the audited app-builder-lib include directory: ${includeRoot}`
    );
  }
  if (exactIncludeRootCount !== 1) {
    throw new Error(
      `builder-debug.yml must add the audited app-builder-lib NSIS include directory exactly once, got ${exactIncludeRootCount}`
    );
  }

  const allInstallUtilIncludes = [
    ...script.matchAll(
      /^[ \t]*!include[ \t]+(?:"([^"\r\n]*installUtil\.nsh)"|([^\s;\r\n]*installUtil\.nsh))[ \t]*$/gimu
    )
  ];
  if (allInstallUtilIncludes.length !== 1
      || (allInstallUtilIncludes[0][1] ?? allInstallUtilIncludes[0][2]) !== 'installUtil.nsh') {
    throw new Error(
      'builder-debug.yml nsis.script must include the literal audited installUtil.nsh exactly once'
    );
  }

  return {
    auditedIncludeDirectoryCount: exactIncludeRootCount,
    installUtilIncludeCount: allInstallUtilIncludes.length
  };
}

export async function assertPhase7InstallerCompileChain({
  repositoryRoot,
  builderDebugPath,
  candidateInstallerPath
}) {
  const root = await realpath(resolve(repositoryRoot));
  const builderDebug = await assertRegularNonSymlinkFile(
    builderDebugPath,
    'electron-builder debug metadata'
  );
  const candidateInstaller = await assertRegularNonSymlinkFile(
    candidateInstallerPath,
    'candidate installer'
  );
  if (basename(candidateInstaller.path) !== canonicalInstallerName) {
    throw new Error(
      `candidate installer name must be exactly ${canonicalInstallerName}, got ${basename(candidateInstaller.path)}`
    );
  }
  const builderDebugRoot = await realpath(dirname(builderDebug.path));
  const candidateInstallerRoot = await realpath(dirname(candidateInstaller.path));
  if (!samePath(builderDebugRoot, candidateInstallerRoot)) {
    throw new Error('candidate installer and builder-debug.yml must share the exact staging root');
  }
  if (candidateInstaller.info.size <= 0) {
    throw new Error('candidate installer must be non-empty');
  }

  const patchPolicy = await assertAppBuilderPatchPolicyFiles(root);
  const installUtilPath = await realpath(patchPolicy.installUtilTemplatePath);
  const installUtilBytes = await readFile(installUtilPath);
  const installUtilSha256 = sha256(installUtilBytes);
  if (installUtilSha256 !== auditedPatchedInstallUtilTemplateSha256) {
    throw new Error(
      `installed installUtil.nsh SHA-256 must be ${auditedPatchedInstallUtilTemplateSha256}, got ${installUtilSha256}`
    );
  }
  const embedding = assertPhase7InstallUtilUpgradeEmbedding(
    installUtilBytes.toString('utf8')
  );
  const binding = await assertPhase7BuilderDebugInstallUtilBinding({
    builderDebugContent: await readFile(builderDebug.path, 'utf8'),
    expectedIncludeDirectory: dirname(installUtilPath)
  });

  return {
    status: 'PASS',
    installUtilSha256,
    appBuilderTreeSha256: patchPolicy.appBuilderTree.sha256,
    candidateInstallerBytes: candidateInstaller.info.size,
    ...binding,
    ...embedding
  };
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set([
    '--repository-root',
    '--builder-debug',
    '--candidate-installer'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(
        'Usage: node phase7-installer-compile-chain.mjs'
          + ' --repository-root <root> --builder-debug <builder-debug.yml>'
          + ' --candidate-installer <setup.exe>'
      );
    }
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`missing required argument: ${name}`);
  }
  return {
    repositoryRoot: values.get('--repository-root'),
    builderDebugPath: values.get('--builder-debug'),
    candidateInstallerPath: values.get('--candidate-installer')
  };
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await assertPhase7InstallerCompileChain(parseArguments(process.argv.slice(2)));
    console.log(`${gateLabel} PASS`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`${gateLabel} FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

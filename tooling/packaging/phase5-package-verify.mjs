import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFileManifest,
  parseArguments,
  readJson,
  renderChecksumManifest,
  requiredArgument,
  sha256File,
  toPosix,
  walkFiles,
  writeJson
} from '../supply-chain/phase5-supply-chain-lib.mjs';
import {
  collectReleaseArtifacts,
  publicArtifactRecords
} from '../supply-chain/phase5-release-evidence-lib.mjs';
import { assertNoProductionTestMarkers } from './phase5-package-policy.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const packageDirectory = requiredArgument(args, '--package-dir');
const evidenceDirectory = requiredArgument(args, '--evidence-dir');
const installerPath = args.has('--installer') ? requiredArgument(args, '--installer') : undefined;

const product = await readJson(join(workspaceRoot, 'resources', 'phase5', 'product-manifest.json'));
const appExecutable = join(packageDirectory, 'desktop-translate.exe');
const resourcesDirectory = join(packageDirectory, 'resources');
const appAsar = join(resourcesDirectory, 'app.asar');
const nativeHost = join(resourcesDirectory, 'selection-host', 'selection-host.exe');
await Promise.all([
  assertRegularFile(appExecutable, 'packaged application executable'),
  assertRegularFile(appAsar, 'Electron app.asar'),
  assertRegularFile(nativeHost, 'packaged Native Host')
]);

await verifyTopLevelAllowlist(packageDirectory);
await verifyResourcesAllowlist(resourcesDirectory);
await verifyLocales(join(packageDirectory, 'locales'));
const asarFiles = await verifyAsar(appAsar, product.canonicalVersion);

const packageFiles = await walkFiles(packageDirectory);
for (const path of packageFiles) assertReleasePath(toPosix(relative(packageDirectory, path)));

const fileEntries = await buildFileManifest(packageDirectory);
const installedBytes = fileEntries.reduce((total, entry) => total + entry.size, 0);
const runtimeResourceBytes = fileEntries
  .filter((entry) => /^(resources\/(selection-host|migrations|manifest|supply-chain)\/)/u.test(entry.path))
  .reduce((total, entry) => total + entry.size, 0);
assert(installedBytes <= 350 * 1024 * 1024, `installed package exceeds 350 MiB (${formatMiB(installedBytes)})`);
assert(runtimeResourceBytes <= 25 * 1024 * 1024, `Native/non-Electron runtime resources exceed 25 MiB (${formatMiB(runtimeResourceBytes)})`);

let installer;
if (installerPath) {
  await assertRegularFile(installerPath, 'NSIS installer');
  const installerSize = (await stat(installerPath)).size;
  assert(installerSize <= 150 * 1024 * 1024, `installer exceeds 150 MiB (${formatMiB(installerSize)})`);
  installer = {
    name: join(installerPath).split(/[\\/]/u).at(-1),
    size: installerSize,
    sha256: await sha256File(installerPath)
  };
}

const currentArtifacts = await collectReleaseArtifacts(packageDirectory, installerPath);

const packageEvidence = join(evidenceDirectory, 'package');
await mkdir(packageEvidence, { recursive: true });
const top30 = [...fileEntries]
  .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path, 'en'))
  .slice(0, 30);
await writeJson(join(packageEvidence, 'size-manifest.json'), {
  schemaVersion: 1,
  productVersion: product.canonicalVersion,
  installed: { bytes: installedBytes, mebibytes: Number((installedBytes / 1024 / 1024).toFixed(3)), limitMebibytes: 350 },
  nativeAndNonElectronRuntimeResources: {
    bytes: runtimeResourceBytes,
    mebibytes: Number((runtimeResourceBytes / 1024 / 1024).toFixed(3)),
    limitMebibytes: 25
  },
  asar: { bytes: (await stat(appAsar)).size, files: asarFiles.length },
  installer: installer ? { bytes: installer.size, mebibytes: Number((installer.size / 1024 / 1024).toFixed(3)), limitMebibytes: 150 } : null,
  top30
});
await writeFile(join(packageEvidence, 'file-manifest.sha256'), renderChecksumManifest(fileEntries), 'utf8');

const binaryManifest = {
  schemaVersion: 2,
  productVersion: product.canonicalVersion,
  artifacts: publicArtifactRecords(currentArtifacts),
  binaries: {
    application: { path: 'desktop-translate.exe', sha256: await sha256File(appExecutable) },
    nativeHost: { path: 'resources/selection-host/selection-host.exe', sha256: await sha256File(nativeHost) },
    asar: { path: 'resources/app.asar', sha256: await sha256File(appAsar) },
    ...(installer ? { installer } : {})
  }
};
await writeJson(join(evidenceDirectory, 'binary-manifest.json'), binaryManifest);

const evidencePath = join(evidenceDirectory, 'release', 'evidence-manifest.json');
const existing = await readOptionalJson(evidencePath);
await writeJson(evidencePath, {
  ...existing,
  schemaVersion: 1,
  productVersion: product.canonicalVersion,
  package: {
    status: 'PASS',
    binaryManifest: 'binary-manifest.json',
    sizeManifest: 'package/size-manifest.json',
    fileManifest: 'package/file-manifest.sha256',
    installedBytes,
    installer: installer ?? null
  },
  release: existing.release ?? {
    status: 'RELEASE BLOCKED',
    blockers: [
      'Authenticode signing and trusted timestamp verification have not completed.',
      'Independent GitHub artifact attestation and clean-download verification have not completed.'
    ]
  }
});

console.log(`[phase5:package] Package allowlist, ASAR, resources, hashes, and size budgets PASS (${formatMiB(installedBytes)} installed).`);
if (!installer) console.log('[phase5:package] Installer was not supplied; installer size/hash evidence remains pending.');
console.log('[phase5:package] Release remains RELEASE BLOCKED until Authenticode, independent attestation, and clean-download verification pass.');

async function verifyTopLevelAllowlist(directory) {
  const allowedDirectories = new Set(['locales', 'resources']);
  const allowedFiles = new Set([
    'desktop-translate.exe',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'ffmpeg.dll',
    'icudtl.dat',
    'libEGL.dll',
    'libGLESv2.dll',
    'LICENSE',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'version',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll'
  ]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) assert(allowedDirectories.has(entry.name), `unexpected packaged directory: ${entry.name}`);
    else if (entry.isFile()) assert(allowedFiles.has(entry.name), `unexpected packaged file: ${entry.name}`);
    else throw new Error(`packaged root contains a non-regular entry: ${entry.name}`);
  }
}

async function verifyResourcesAllowlist(directory) {
  const allowedDirectories = new Set(['selection-host', 'migrations', 'licenses', 'supply-chain', 'manifest']);
  const allowedFiles = new Set(['app.asar', 'elevate.exe']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) assert(allowedDirectories.has(entry.name), `unexpected resources directory: ${entry.name}`);
    else if (entry.isFile()) assert(allowedFiles.has(entry.name), `unexpected resources file: ${entry.name}`);
    else throw new Error(`resources contains a non-regular entry: ${entry.name}`);
  }
  const exactFiles = [
    'selection-host/selection-host.exe',
    'licenses/THIRD_PARTY_NOTICES.txt',
    'licenses/ELECTRON_LICENSE.txt',
    'licenses/LICENSES.chromium.html',
    'supply-chain/sbom.cdx.json',
    'manifest/product-manifest.json',
    'manifest/component-manifest.json',
    'manifest/file-manifest.sha256'
  ];
  for (const path of exactFiles) await assertRegularFile(join(directory, ...path.split('/')), `packaged resource ${path}`);
  const migrationFiles = await readdir(join(directory, 'migrations'), { withFileTypes: true });
  assert(migrationFiles.length > 0, 'packaged migrations directory is empty');
  for (const entry of migrationFiles) assert(entry.isFile() && /^\d+_[a-z0-9_-]+\.sql$/iu.test(entry.name), `invalid packaged migration: ${entry.name}`);
}

async function verifyLocales(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  assert(entries.every((entry) => entry.isFile() && /^(en-US|zh-CN)\.pak$/u.test(entry.name)), `unexpected Electron locale(s): ${names.join(', ')}`);
  assert(names.includes('en-US.pak') && names.includes('zh-CN.pak'), 'required en-US and zh-CN locales are missing');
}

async function verifyAsar(path, expectedVersion) {
  let asar;
  try { asar = await import('@electron/asar'); }
  catch {
    throw new Error('Package verification requires the pinned @electron/asar development dependency');
  }
  const files = asar.listPackage(path).map((item) => item.replace(/^[/\\]+/u, '').replaceAll('\\', '/')).filter(Boolean).sort();
  assert(files.length > 0, 'app.asar is empty');
  const allowedDirectories = new Set([
    '.vite',
    '.vite/build',
    '.vite/renderer',
    '.vite/renderer/assets',
    '.vite/renderer/ball',
    '.vite/renderer/card',
    '.vite/renderer/settings'
  ]);
  for (const logicalPath of files) {
    assert(
      logicalPath === 'package.json' ||
        allowedDirectories.has(logicalPath) ||
        logicalPath.startsWith('.vite/build/') ||
        logicalPath.startsWith('.vite/renderer/'),
      `app.asar contains a path outside the production allowlist: ${logicalPath}`
    );
    assertReleasePath(logicalPath);
  }
  for (const required of [
    'package.json',
    '.vite/build/main.js',
    '.vite/build/local-data-reset-helper.js',
    '.vite/build/ball-preload.cjs',
    '.vite/build/settings-preload.cjs',
    '.vite/build/card-preload.cjs'
  ]) {
    assert(files.includes(required), `app.asar is missing ${required}`);
  }
  const productionMainFiles = files.filter((logicalPath) =>
    logicalPath === '.vite/build/main.js' || /^\.vite\/build\/(?!.*preload).*\.(?:js|cjs)$/u.test(logicalPath)
  );
  assertNoProductionTestMarkers(productionMainFiles.map((logicalPath) => ({
    path: logicalPath,
    content: asar.extractFile(path, logicalPath.replaceAll('/', sep)).toString('utf8')
  })));
  const packageJson = JSON.parse(asar.extractFile(path, 'package.json').toString('utf8'));
  assert(packageJson.version === expectedVersion, `app.asar package version '${packageJson.version}' does not match '${expectedVersion}'`);
  assert(packageJson.main === '.vite/build/main.js', 'app.asar main entrypoint is invalid');
  return files;
}

function assertReleasePath(logicalPath) {
  const lower = logicalPath.toLowerCase();
  assert(!lower.endsWith('.map'), `source map is forbidden: ${logicalPath}`);
  assert(!/(^|\/)(test|tests|e2e|coverage|playwright-report|src|tooling)(\/|$)/u.test(lower), `source/test/development path is forbidden: ${logicalPath}`);
  assert(!/\.(pdb|ilk|exp|lib|obj|ts|tsx)$/u.test(lower), `source/debug/build artifact is forbidden: ${logicalPath}`);
  assert(!/\.(pdmodel|pdiparams|onnx)$/u.test(lower), `packaged OCR model is forbidden: ${logicalPath}`);
  assert(!/(^|\/)(\.env(?:\.|$)|id_rsa|id_ed25519|credentials?\.json|secrets?\.json)$/u.test(lower), `credential-like file is forbidden: ${logicalPath}`);
}

async function assertRegularFile(path, label) {
  const details = await stat(path).catch(() => undefined);
  assert(details?.isFile(), `${label} is missing: ${path}`);
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

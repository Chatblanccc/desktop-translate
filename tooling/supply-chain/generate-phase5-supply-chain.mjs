import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFileManifest,
  deterministicUuid,
  parseArguments,
  readJson,
  renderChecksumManifest,
  requiredArgument,
  sha256File,
  sha256Tree,
  toPosix,
  writeJson
} from './phase5-supply-chain-lib.mjs';
import {
  collectWinRtProvenance,
  loadWinRtPins
} from './phase5-winrt-provenance.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const stageDirectory = requiredArgument(args, '--stage-dir');
const nativeHost = requiredArgument(args, '--native-host');
const nativeMetadataPath = requiredArgument(args, '--native-metadata');
const evidenceDirectory = requiredArgument(args, '--evidence-dir');
const workspaceStatePath = requiredArgument(args, '--workspace-state');

const productSource = join(workspaceRoot, 'resources', 'phase5', 'product-manifest.json');
const rootPackagePath = join(workspaceRoot, 'package.json');
const desktopPackagePath = join(workspaceRoot, 'apps', 'desktop', 'package.json');
const product = await readJson(productSource);
const rootPackage = await readJson(rootPackagePath);
const desktopPackage = await readJson(desktopPackagePath);
const nativeMetadata = await readJson(nativeMetadataPath);
const workspaceState = await readJson(workspaceStatePath);

validateProductVersions(product, rootPackage, desktopPackage, nativeMetadata);
await assertRegularFile(nativeHost, 'Native Host');
const nativeHash = await sha256File(nativeHost);
if (nativeMetadata.binarySha256 !== nativeHash) {
  throw new Error('Native build metadata hash does not match selection-host.exe');
}
if (nativeMetadata.runtimeLibrary !== '/MT') {
  throw new Error('Phase 5 release requires the Native Host MSVC /MT runtime strategy');
}

const stageLicenses = join(stageDirectory, 'licenses');
const stageSupplyChain = join(stageDirectory, 'supply-chain');
const stageManifest = join(stageDirectory, 'manifest');
await Promise.all([
  mkdir(stageLicenses, { recursive: true }),
  mkdir(stageSupplyChain, { recursive: true }),
  mkdir(stageManifest, { recursive: true }),
  mkdir(join(evidenceDirectory, 'supply-chain'), { recursive: true }),
  mkdir(join(evidenceDirectory, 'release'), { recursive: true })
]);

const productionTree = listPnpm('--prod', '@desktop-translate/desktop');
const developmentTree = listPnpm('--dev');
const runtimePackages = flattenPnpmTree(productionTree, 'runtime');
const buildPackages = flattenPnpmTree(developmentTree, 'build-only');

const electronPackagePath = resolve(workspaceRoot, 'node_modules', 'electron');
const electronPackage = await readJson(join(electronPackagePath, 'package.json'));
const electronVersions = inspectElectronRuntime(electronPackagePath);
if (electronVersions.electron !== electronPackage.version) {
  throw new Error('Electron package version and embedded runtime version do not match');
}

const externalRuntime = deduplicatePackages(runtimePackages.filter((item) => !item.private));
const projectRuntime = deduplicatePackages(runtimePackages.filter((item) => item.private));
for (const item of projectRuntime) {
  if (item.version !== product.canonicalVersion) {
    throw new Error(`Runtime workspace ${item.name} version '${item.version}' does not match '${product.canonicalVersion}'`);
  }
}
const runtimeNames = new Set(externalRuntime.map((item) => `${item.name}@${item.version}`));
const externalBuild = deduplicatePackages(buildPackages.filter((item) =>
  !item.private && item.name !== 'electron' && !runtimeNames.has(`${item.name}@${item.version}`)
));

for (const component of [...externalRuntime, ...externalBuild, { ...electronPackage, path: electronPackagePath }]) {
  validateExternalLicense(component);
}

const electronLicense = join(electronPackagePath, 'dist', 'LICENSE');
const chromiumLicenses = join(electronPackagePath, 'dist', 'LICENSES.chromium.html');
await assertRegularFile(electronLicense, 'Electron runtime license');
await assertRegularFile(chromiumLicenses, 'Chromium third-party license bundle');
await copyFile(electronLicense, join(stageLicenses, 'ELECTRON_LICENSE.txt'));
await copyFile(chromiumLicenses, join(stageLicenses, 'LICENSES.chromium.html'));

const notice = await buildNotices(externalRuntime, {
  electronVersion: electronVersions.electron,
  nodeVersion: electronVersions.node,
  sqliteVersion: electronVersions.sqlite,
  compilerVersion: nativeMetadata.compilerVersion
});
const noticesPath = join(stageLicenses, 'THIRD_PARTY_NOTICES.txt');
await writeFile(noticesPath, notice, 'utf8');

const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  windowsHide: true
}).trim();
if (!/^[0-9a-f]{40}$/u.test(gitSha)) throw new Error('Unable to resolve a full git SHA');
if (workspaceState.headSha !== gitSha) throw new Error('Workspace-state HEAD does not match the supply-chain source SHA');
if (workspaceState.developmentDirty && !/^[a-f0-9]{64}$/u.test(workspaceState.patchDigest)) {
  throw new Error('Dirty workspace state is missing its patchDigest');
}
const winRtPins = await loadWinRtPins(workspaceRoot);
const winRtProvenance = await collectWinRtProvenance(workspaceRoot, winRtPins);

const components = [];
components.push(projectComponent(desktopPackage.name, desktopPackage.version, 'application'));
for (const item of projectRuntime) {
  if (item.name !== desktopPackage.name) components.push(projectComponent(item.name, item.version, 'library'));
}
for (const item of externalRuntime) components.push(await npmComponent(item, 'required', 'runtime'));

const electronExe = join(electronPackagePath, 'dist', 'electron.exe');
await assertRegularFile(electronExe, 'Electron runtime executable');
components.push({
  type: 'framework',
  name: 'Electron',
  version: electronVersions.electron,
  'bom-ref': `pkg:generic/electron@${electronVersions.electron}`,
  scope: 'required',
  hashes: [{ alg: 'SHA-256', content: await sha256File(electronExe) }],
  licenses: [{ expression: electronPackage.license }],
  externalReferences: [{ type: 'website', url: 'https://www.electronjs.org/' }],
  properties: [
    property('desktop-translate:distribution', 'runtime'),
    property('desktop-translate:notice-file', 'licenses/ELECTRON_LICENSE.txt'),
    property('desktop-translate:chromium-notice-file', 'licenses/LICENSES.chromium.html')
  ]
});
components.push(embeddedComponent('Node.js', electronVersions.node, 'MIT', 'https://nodejs.org/', 'licenses/LICENSES.chromium.html'));
components.push(embeddedComponent('SQLite', electronVersions.sqlite, 'blessing', 'https://sqlite.org/', 'licenses/LICENSES.chromium.html'));
components.push({
  type: 'application',
  name: 'selection-host.exe',
  version: product.canonicalVersion,
  'bom-ref': `pkg:generic/desktop-translate-selection-host@${product.canonicalVersion}`,
  scope: 'required',
  hashes: [{ alg: 'SHA-256', content: nativeHash }],
  properties: [
    property('desktop-translate:distribution', 'runtime'),
    property('desktop-translate:ownership', 'project-owned'),
    property('desktop-translate:toolchain', `MSVC ${nativeMetadata.compilerVersion}`),
    property('desktop-translate:runtime-library', '/MT')
  ]
});
components.push({
  type: 'library',
  name: 'Microsoft Visual C++ Runtime (static)',
  version: nativeMetadata.compilerVersion,
  'bom-ref': `pkg:generic/msvc-static-runtime@${encodeURIComponent(nativeMetadata.compilerVersion)}`,
  scope: 'required',
  licenses: [{ expression: 'LicenseRef-Microsoft-Visual-Studio-Redistributables' }],
  properties: [
    property('desktop-translate:distribution', 'statically-linked-runtime'),
    property('desktop-translate:notice-file', 'licenses/THIRD_PARTY_NOTICES.txt')
  ]
});
components.push(osDependency('Windows.Media.Ocr', 'Windows 11', 'OCR runtime'));
components.push(osDependency('Windows OCR language pack', 'user-installed', 'OCR language data'));
for (const item of externalBuild) components.push(await npmComponent(item, 'excluded', 'build-only'));
for (const pin of winRtPins.packages) components.push(winRtNugetComponent(pin, winRtProvenance));

components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'], 'en'));
ensureUniqueBomRefs(components);
const applicationRef = `pkg:generic/${encodeURIComponent(desktopPackage.name)}@${encodeURIComponent(desktopPackage.version)}`;
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${deterministicUuid(`${gitSha}:${product.canonicalVersion}`)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: {
      components: [{
        type: 'application',
        name: 'desktop-translate-phase5-supply-chain-generator',
        version: '1'
      }]
    },
    component: components.find((component) => component['bom-ref'] === applicationRef)
  },
  components: components.filter((component) => component['bom-ref'] !== applicationRef),
  dependencies: [{
    ref: applicationRef,
    dependsOn: components
      .filter((component) => component.scope === 'required' && component['bom-ref'] !== applicationRef)
      .map((component) => component['bom-ref'])
      .sort()
  }]
};
const sbomPath = join(stageSupplyChain, 'sbom.cdx.json');
await writeJson(sbomPath, bom);

const provenancePath = join(evidenceDirectory, 'supply-chain', 'build-provenance.json');
await writeJson(provenancePath, {
  schemaVersion: 1,
  status: 'PASS',
  productVersion: product.canonicalVersion,
  gitSha,
  sourceIdentity: workspaceState.sourceIdentity,
  developmentDirty: workspaceState.developmentDirty,
  patchDigest: workspaceState.patchDigest,
  generatedAt: bom.metadata.timestamp,
  nativeBuild: {
    metadataSha256: await sha256File(nativeMetadataPath),
    compilerVersion: nativeMetadata.compilerVersion,
    runtimeLibrary: nativeMetadata.runtimeLibrary,
    output: {
      name: 'selection-host.exe',
      sha256: nativeHash
    }
  },
  winRtProjection: winRtProvenance
});

await copyFile(productSource, join(stageManifest, 'product-manifest.json'));
const componentManifestPath = join(stageManifest, 'component-manifest.json');
const checksumPath = join(stageManifest, 'file-manifest.sha256');
const manifestEntries = await buildFileManifest(stageDirectory, (logical) =>
  logical === 'manifest/component-manifest.json' || logical === 'manifest/file-manifest.sha256'
);
const componentManifest = {
  schemaVersion: 1,
  productVersion: product.canonicalVersion,
  gitSha,
  build: {
    sourceIdentity: workspaceState.sourceIdentity,
    developmentDirty: workspaceState.developmentDirty,
    patchDigest: workspaceState.patchDigest,
    acceptanceEligible: workspaceState.acceptanceEligible
  },
  generatedAt: new Date().toISOString(),
  nativeRuntime: {
    fileVersion: nativeMetadata.fileVersion,
    productVersion: nativeMetadata.productVersion,
    runtimeLibrary: nativeMetadata.runtimeLibrary,
    compilerVersion: nativeMetadata.compilerVersion,
    dependencies: nativeMetadata.dependencies
  },
  files: manifestEntries
};
await writeJson(componentManifestPath, componentManifest);
await writeFile(checksumPath, renderChecksumManifest(manifestEntries), 'utf8');

await Promise.all([
  copyFile(sbomPath, join(evidenceDirectory, 'supply-chain', 'sbom.cdx.json')),
  copyFile(noticesPath, join(evidenceDirectory, 'supply-chain', 'third-party-notices.txt')),
  copyFile(checksumPath, join(evidenceDirectory, 'supply-chain', 'staged-file-manifest.sha256'))
]);

const evidenceManifestPath = join(evidenceDirectory, 'release', 'evidence-manifest.json');
const existingEvidence = await readOptionalJson(evidenceManifestPath);
await writeJson(evidenceManifestPath, {
  ...existingEvidence,
  schemaVersion: 1,
  productVersion: product.canonicalVersion,
  gitSha,
  build: {
    sourceIdentity: workspaceState.sourceIdentity,
    developmentDirty: workspaceState.developmentDirty,
    patchDigest: workspaceState.patchDigest,
    acceptanceEligible: workspaceState.acceptanceEligible,
    workspaceState: 'build/workspace-state.json'
  },
  supplyChain: {
    status: 'PASS',
    sbom: 'supply-chain/sbom.cdx.json',
    sbomSha256: await sha256File(sbomPath),
    notices: 'supply-chain/third-party-notices.txt',
    noticesSha256: await sha256File(noticesPath),
    nativeHostSha256: nativeHash,
    stagedFileManifest: 'supply-chain/staged-file-manifest.sha256',
    provenance: 'supply-chain/build-provenance.json',
    provenanceSha256: await sha256File(provenancePath)
  },
  release: {
    status: 'RELEASE BLOCKED',
    blockers: [
      ...(workspaceState.developmentDirty ? ['Development package includes uncommitted/untracked inputs and cannot represent HEAD acceptance.'] : []),
      'Authenticode signing and trusted timestamp verification have not completed.',
      'Independent GitHub artifact attestation and clean-download verification have not completed.'
    ]
  }
});

console.log(`[phase5:supply-chain] Generated ${toPosix(relative(workspaceRoot, sbomPath))}`);
console.log('[phase5:supply-chain] Supply-chain generation PASS; release remains blocked until source, signing, attestation, and clean-download gates pass.');

function listPnpm(mode, filter) {
  const commandArguments = [
    '--config.verify-deps-before-run=false',
    ...(filter ? ['--filter', filter] : []),
    'list', mode, '--json', '--depth', 'Infinity'
  ];
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const executableArguments = process.platform === 'win32'
    ? ['/d', '/s', '/c', `pnpm ${commandArguments.join(' ')}`]
    : commandArguments;
  const output = execFileSync(executable, executableArguments, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  return JSON.parse(output);
}

function flattenPnpmTree(trees, classification) {
  const packages = [];
  const visited = new Set();
  function visit(name, item) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string') return;
    const packagePath = resolve(item.path);
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    } catch (error) {
      throw new Error(`Unable to read installed package metadata for ${name}: ${error.message}`);
    }
    const key = `${metadata.name}@${metadata.version}:${classification}`;
    if (!visited.has(key)) {
      visited.add(key);
      packages.push({
        name: metadata.name,
        version: metadata.version,
        private: metadata.private === true,
        license: metadata.license,
        repository: metadata.repository,
        homepage: metadata.homepage,
        path: packagePath,
        resolved: item.resolved,
        classification
      });
    }
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [childName, child] of Object.entries(item[field] ?? {})) visit(childName, child);
    }
  }
  for (const tree of trees) {
    const rootItem = { path: tree.path, ...tree };
    visit(tree.name, rootItem);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, item] of Object.entries(tree[field] ?? {})) visit(name, item);
    }
  }
  return packages;
}

function deduplicatePackages(packages) {
  const values = new Map();
  for (const item of packages) values.set(`${item.name}@${item.version}`, item);
  return [...values.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en')
  );
}

function inspectElectronRuntime(electronPackagePath) {
  const executable = join(electronPackagePath, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const result = spawnSync(executable, ['-p', 'JSON.stringify(process.versions)'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  if (result.status !== 0) throw new Error(`Unable to inspect Electron runtime versions: ${result.stderr}`);
  const versions = JSON.parse(result.stdout.trim());
  for (const field of ['electron', 'node', 'sqlite', 'chrome']) {
    if (typeof versions[field] !== 'string' || versions[field].length === 0) {
      throw new Error(`Electron runtime did not report process.versions.${field}`);
    }
  }
  return versions;
}

function validateProductVersions(manifest, root, desktop, nativeMetadata) {
  if (manifest.schemaVersion !== 1 || manifest.canonicalVersion !== '0.5.0-phase5' || manifest.windowsFileVersion !== '0.5.0.0') {
    throw new Error('Phase 5 product manifest is invalid or has drifted');
  }
  for (const [label, value] of [['workspace', root.version], ['desktop', desktop.version]]) {
    if (value !== manifest.canonicalVersion) {
      throw new Error(`${label} package version '${value}' does not match '${manifest.canonicalVersion}'`);
    }
  }
  if (nativeMetadata.productVersion !== manifest.canonicalVersion || nativeMetadata.fileVersion !== manifest.windowsFileVersion) {
    throw new Error('Native build metadata version does not match the Phase 5 product manifest');
  }
}

function validateExternalLicense(component) {
  if (typeof component.license !== 'string' || component.license.trim().length === 0 || /^(UNKNOWN|UNLICENSED)$/iu.test(component.license.trim())) {
    throw new Error(`External component ${component.name}@${component.version} has no auditable license declaration`);
  }
}

async function findLicenseFile(packagePath) {
  const entries = await readdir(packagePath, { withFileTypes: true });
  const candidate = entries
    .filter((entry) => entry.isFile() && /^(LICEN[CS]E|COPYING|NOTICE)(?:\..*)?$/iu.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))[0];
  return candidate ? join(packagePath, candidate.name) : undefined;
}

async function buildNotices(packages, versions) {
  const chunks = [
    'THIRD-PARTY NOTICES — Desktop Translate 0.5.0-phase5',
    '',
    'This file covers third-party components redistributed by the packaged application.',
    'Build-only dependencies are recorded in supply-chain/sbom.cdx.json with scope=excluded.',
    '',
    `Electron ${versions.electron}: see licenses/ELECTRON_LICENSE.txt.`,
    `Chromium and embedded runtime notices (including Node.js ${versions.node} and SQLite ${versions.sqlite}): see licenses/LICENSES.chromium.html.`,
    `Microsoft Visual C++ Runtime from MSVC ${versions.compilerVersion} is statically linked (/MT) under the applicable Visual Studio redistributables terms.`,
    'Windows.Media.Ocr and OCR language packs are operating-system dependencies and are not redistributed.',
    ''
  ];
  for (const item of packages) {
    const licensePath = await findLicenseFile(item.path);
    if (!licensePath) throw new Error(`Runtime component ${item.name}@${item.version} has no local license text`);
    const text = (await readFile(licensePath, 'utf8')).trim();
    if (text.length === 0) throw new Error(`Runtime component ${item.name}@${item.version} has an empty license text`);
    chunks.push('='.repeat(78), `${item.name} ${item.version} — ${item.license}`, `Source: ${sourceUrl(item)}`, '', text, '');
  }
  return `${chunks.join('\n')}\n`;
}

async function npmComponent(item, scope, distribution) {
  const ref = npmPurl(item.name, item.version);
  const contentHash = distribution === 'runtime'
    ? await sha256Tree(item.path, {
      excluded: (logical, entry) => entry.isDirectory() && logical.split('/').includes('node_modules')
    })
    : await sha256File(join(item.path, 'package.json'));
  const component = {
    type: 'library',
    name: item.name,
    version: item.version,
    'bom-ref': ref,
    purl: ref,
    scope,
    hashes: [{ alg: 'SHA-256', content: contentHash }],
    licenses: [{ expression: item.license }],
    externalReferences: [{ type: 'distribution', url: item.resolved ?? sourceUrl(item) }],
    properties: [property('desktop-translate:distribution', distribution)]
  };
  component.properties.push(property(
    'desktop-translate:hash-kind',
    distribution === 'runtime' ? 'installed-package-tree' : 'installed-package-metadata'
  ));
  if (distribution === 'runtime') component.properties.push(property('desktop-translate:notice-file', 'licenses/THIRD_PARTY_NOTICES.txt'));
  return component;
}

function winRtNugetComponent(pin, provenance) {
  const packageRecord = provenance.packages.find((item) => item.id === pin.id);
  if (!packageRecord) throw new Error(`WinRT provenance is missing ${pin.id}`);
  const licenses = pin.license.expression
    ? [{ expression: pin.license.expression }]
    : [{ license: { name: pin.license.name, url: pin.license.url } }];
  const properties = [
    property('desktop-translate:distribution', 'build-only'),
    property('desktop-translate:hash-kind', 'nuget-package'),
    property('desktop-translate:winrt-role', pin.role),
    property('desktop-translate:package-source', pin.source),
    property('desktop-translate:license-source', pin.license.source),
    property('desktop-translate:license-requires-acceptance', pin.license.requiresAcceptance),
    property('desktop-translate:provenance-pin-manifest-sha256', provenance.pinManifest.sha256),
    property('desktop-translate:projection-tree-hash-algorithm', provenance.projection.treeHashAlgorithm),
    property('desktop-translate:projection-tree-hash-definition', provenance.projection.treeHashDefinition),
    property('desktop-translate:projection-tree-sha256', provenance.projection.sha256)
  ];
  if (pin.id === provenance.generator.packageId) {
    properties.push(property('desktop-translate:tool-executable-sha256', provenance.generator.executableSha256));
  }
  return {
    type: 'library',
    name: pin.id,
    version: pin.version,
    'bom-ref': pin.purl,
    purl: pin.purl,
    scope: 'excluded',
    hashes: [{ alg: 'SHA-256', content: packageRecord.sha256 }],
    licenses,
    externalReferences: [{ type: 'distribution', url: pin.source }],
    properties
  };
}

function projectComponent(name, version, type) {
  return {
    type,
    name,
    version,
    'bom-ref': `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    scope: 'required',
    properties: [
      property('desktop-translate:distribution', 'runtime'),
      property('desktop-translate:ownership', 'project-owned')
    ]
  };
}

function embeddedComponent(name, version, license, website, notice) {
  return {
    type: 'framework',
    name,
    version,
    'bom-ref': `pkg:generic/${encodeURIComponent(name.toLowerCase())}@${encodeURIComponent(version)}`,
    scope: 'required',
    licenses: [{ expression: license }],
    externalReferences: [{ type: 'website', url: website }],
    properties: [
      property('desktop-translate:distribution', 'embedded-in-electron'),
      property('desktop-translate:notice-file', notice)
    ]
  };
}

function osDependency(name, version, purpose) {
  return {
    type: 'operating-system',
    name,
    version,
    'bom-ref': `pkg:generic/${encodeURIComponent(name.toLowerCase())}@${encodeURIComponent(version)}`,
    scope: 'excluded',
    properties: [
      property('desktop-translate:distribution', 'os-dependency-not-redistributed'),
      property('desktop-translate:purpose', purpose)
    ]
  };
}

function property(name, value) {
  return { name, value: String(value) };
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.split('/');
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function sourceUrl(item) {
  if (typeof item.homepage === 'string' && item.homepage.startsWith('https://')) return item.homepage;
  const repository = typeof item.repository === 'string' ? item.repository : item.repository?.url;
  if (typeof repository === 'string') return repository.replace(/^git\+/u, '').replace(/\.git$/u, '');
  if (typeof item.resolved === 'string') return item.resolved;
  return `https://www.npmjs.com/package/${encodeURIComponent(item.name)}/v/${encodeURIComponent(item.version)}`;
}

function ensureUniqueBomRefs(components) {
  const seen = new Set();
  for (const component of components) {
    if (seen.has(component['bom-ref'])) throw new Error(`Duplicate SBOM bom-ref: ${component['bom-ref']}`);
    seen.add(component['bom-ref']);
  }
}

async function assertRegularFile(path, label) {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile()) throw new Error(`${label} was not found: ${path}`);
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

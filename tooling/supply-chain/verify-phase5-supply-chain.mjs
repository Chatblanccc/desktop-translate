import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFileManifest,
  parseArguments,
  readJson,
  renderChecksumManifest,
  requiredArgument,
  sha256File,
  toPosix,
  walkFiles
} from './phase5-supply-chain-lib.mjs';
import {
  collectWinRtProvenance,
  loadWinRtPins
} from './phase5-winrt-provenance.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const stageDirectory = requiredArgument(args, '--stage-dir');
const packageDirectory = args.has('--package-dir') ? requiredArgument(args, '--package-dir') : undefined;

const product = await readJson(join(stageDirectory, 'manifest', 'product-manifest.json'));
const componentManifest = await readJson(join(stageDirectory, 'manifest', 'component-manifest.json'));
const sbomPath = join(stageDirectory, 'supply-chain', 'sbom.cdx.json');
const sbom = await readJson(sbomPath);
const noticesPath = join(stageDirectory, 'licenses', 'THIRD_PARTY_NOTICES.txt');
const notices = await readFile(noticesPath, 'utf8');
const checksumsPath = join(stageDirectory, 'manifest', 'file-manifest.sha256');
const checksums = await readFile(checksumsPath, 'utf8');

assert(product.schemaVersion === 1, 'product manifest schemaVersion must be 1');
assert(product.canonicalVersion === '0.5.0-phase5', 'canonical product version must be 0.5.0-phase5');
assert(product.windowsFileVersion === '0.5.0.0', 'Windows file version must be 0.5.0.0');
assert(product.installer?.scope === 'per-user', 'installer scope must be per-user');
assert(product.installer?.requiresElevation === false, 'per-user installer must not require elevation');
assert(product.nativeRuntime?.runtimeLibrary === '/MT', 'Native runtime policy must be /MT');
assert(product.nativeRuntime?.packagedModels === false, 'Phase 5 must not package OCR models');
assert(product.updates?.automaticUpdateEnabled === false, 'unreviewed automatic updates must remain disabled');

for (const packagePath of [join(workspaceRoot, 'package.json'), join(workspaceRoot, 'apps', 'desktop', 'package.json')]) {
  const packageJson = await readJson(packagePath);
  assert(packageJson.version === product.canonicalVersion, `${toPosix(relative(workspaceRoot, packagePath))} version mismatch`);
}
const winRtPins = await loadWinRtPins(workspaceRoot);
const winRtProvenance = await collectWinRtProvenance(workspaceRoot, winRtPins);

const actualEntries = await buildFileManifest(stageDirectory, (logical) =>
  logical === 'manifest/component-manifest.json' || logical === 'manifest/file-manifest.sha256'
);
assert(componentManifest.schemaVersion === 1, 'component manifest schemaVersion must be 1');
assert(componentManifest.productVersion === product.canonicalVersion, 'component manifest version mismatch');
assert(componentManifest.nativeRuntime?.runtimeLibrary === '/MT', 'component manifest must record /MT');
assert(JSON.stringify(componentManifest.files) === JSON.stringify(actualEntries), 'staged component manifest does not match files on disk');
assert(checksums === renderChecksumManifest(actualEntries), 'staged checksum manifest does not match component manifest');

assert(sbom.bomFormat === 'CycloneDX', 'SBOM bomFormat must be CycloneDX');
assert(sbom.specVersion === '1.6', 'SBOM specVersion must be 1.6');
assert(/^urn:uuid:[0-9a-f-]{36}$/u.test(sbom.serialNumber), 'SBOM serialNumber must be a UUID URN');
const components = [sbom.metadata?.component, ...(sbom.components ?? [])].filter(Boolean);
assert(components.length >= 8, 'SBOM is unexpectedly incomplete');
const refs = new Set();
for (const component of components) {
  assert(typeof component['bom-ref'] === 'string' && component['bom-ref'].length > 0, `SBOM component ${component.name} lacks bom-ref`);
  assert(!refs.has(component['bom-ref']), `duplicate SBOM bom-ref ${component['bom-ref']}`);
  refs.add(component['bom-ref']);
  const distribution = getProperty(component, 'desktop-translate:distribution');
  assert(distribution, `SBOM component ${component.name} lacks distribution classification`);
  if (component.scope === 'required' && getProperty(component, 'desktop-translate:ownership') !== 'project-owned') {
    assert(Array.isArray(component.licenses) && component.licenses.length > 0, `runtime component ${component.name} lacks a license`);
    const noticeFile = getProperty(component, 'desktop-translate:notice-file');
    if (noticeFile) await access(join(stageDirectory, noticeFile));
  }
  if (component.scope === 'excluded') {
    assert(distribution === 'build-only' || distribution === 'os-dependency-not-redistributed', `excluded component ${component.name} has invalid classification`);
  }
}
assert(components.some((component) => component.name === 'Electron' && component.scope === 'required'), 'Electron runtime missing from SBOM');
assert(components.some((component) => component.name === 'Node.js' && component.scope === 'required'), 'embedded Node.js missing from SBOM');
assert(components.some((component) => component.name === 'SQLite' && component.scope === 'required'), 'embedded SQLite missing from SBOM');
assert(components.some((component) => component.name === 'Microsoft Visual C++ Runtime (static)' && component.scope === 'required'), 'static MSVC runtime missing from SBOM');
assert(components.some((component) => component.name === 'Windows.Media.Ocr' && component.scope === 'excluded'), 'Windows.Media.Ocr OS dependency missing from SBOM');
assert(!components.some((component) => /paddle|opencv/iu.test(component.name)), 'SBOM must not claim Paddle/OpenCV redistribution');
for (const pin of winRtPins.packages) {
  const packageRecord = winRtProvenance.packages.find((item) => item.id === pin.id);
  const component = components.find((item) => item.purl === pin.purl);
  assert(component?.name === pin.id && component.version === pin.version, `${pin.id} reviewed version missing from SBOM`);
  assert(component.scope === 'excluded', `${pin.id} must be classified as build-only`);
  assert(getProperty(component, 'desktop-translate:distribution') === 'build-only', `${pin.id} distribution classification mismatch`);
  assert(getProperty(component, 'desktop-translate:hash-kind') === 'nuget-package', `${pin.id} hash kind mismatch`);
  assert(getProperty(component, 'desktop-translate:winrt-role') === pin.role, `${pin.id} WinRT role mismatch`);
  assert(getProperty(component, 'desktop-translate:package-source') === pin.source, `${pin.id} package source mismatch`);
  assert(component.externalReferences?.some((item) => item.type === 'distribution' && item.url === pin.source), `${pin.id} official NuGet source missing`);
  assert(component.hashes?.some((item) => item.alg === 'SHA-256' && item.content === packageRecord.sha256), `${pin.id} NuGet package SHA-256 mismatch`);
  assert(getProperty(component, 'desktop-translate:projection-tree-hash-algorithm') === winRtProvenance.projection.treeHashAlgorithm, `${pin.id} projection hash algorithm mismatch`);
  assert(getProperty(component, 'desktop-translate:projection-tree-hash-definition') === winRtProvenance.projection.treeHashDefinition, `${pin.id} projection hash definition mismatch`);
  assert(getProperty(component, 'desktop-translate:projection-tree-sha256') === winRtProvenance.projection.sha256, `${pin.id} projection tree SHA-256 mismatch`);
  assert(getProperty(component, 'desktop-translate:license-source') === pin.license.source, `${pin.id} license source mismatch`);
  assert(getProperty(component, 'desktop-translate:license-requires-acceptance') === String(pin.license.requiresAcceptance), `${pin.id} license acceptance policy mismatch`);
  assert(getProperty(component, 'desktop-translate:provenance-pin-manifest-sha256') === winRtProvenance.pinManifest.sha256, `${pin.id} provenance pin manifest mismatch`);
  if (pin.license.expression) {
    assert(component.licenses?.some((item) => item.expression === pin.license.expression), `${pin.id} license expression mismatch`);
  } else {
    assert(component.licenses?.some((item) => item.license?.name === pin.license.name && item.license.url === pin.license.url), `${pin.id} license record mismatch`);
  }
}
const cppWinRtComponent = components.find((item) => item.purl === `pkg:nuget/${winRtProvenance.generator.packageId}@${winRtPins.packages.find((pin) => pin.id === winRtProvenance.generator.packageId)?.version}`);
assert(getProperty(cppWinRtComponent, 'desktop-translate:tool-executable-sha256') === winRtProvenance.generator.executableSha256, 'cppwinrt.exe SHA-256 provenance mismatch');

assert(notices.includes('THIRD-PARTY NOTICES — Desktop Translate 0.5.0-phase5'), 'third-party notice header missing');
assert(notices.includes('Windows.Media.Ocr and OCR language packs are operating-system dependencies'), 'Windows OCR boundary missing from notices');
for (const component of components) {
  if (component.scope !== 'required' || !component.purl?.startsWith('pkg:npm/')) continue;
  assert(notices.includes(`${component.name} ${component.version}`), `notices do not cover ${component.name}@${component.version}`);
}

const stagedFiles = await walkFiles(stageDirectory);
for (const path of stagedFiles) assertReleasePath(toPosix(relative(stageDirectory, path)));
const nativePath = join(stageDirectory, 'selection-host', 'selection-host.exe');
const nativeHash = await sha256File(nativePath);
const nativeComponent = components.find((component) => component.name === 'selection-host.exe');
assert(nativeComponent?.hashes?.some((hash) => hash.alg === 'SHA-256' && hash.content === nativeHash), 'SBOM Native Host hash mismatch');

if (packageDirectory) {
  const packageResources = join(packageDirectory, 'resources');
  for (const entry of actualEntries) {
    const packagePath = join(packageResources, ...entry.path.split('/'));
    const details = await stat(packagePath).catch(() => undefined);
    assert(details?.isFile(), `packaged resource missing: resources/${entry.path}`);
    assert((await sha256File(packagePath)) === entry.sha256, `packaged resource hash mismatch: resources/${entry.path}`);
  }
  const packageFiles = await walkFiles(packageDirectory);
  for (const path of packageFiles) assertReleasePath(toPosix(relative(packageDirectory, path)));
}

console.log('[phase5:sbom] SBOM, WinRT package/projection provenance, notices, checksums, runtime classification, and packaged resources PASS.');

function getProperty(component, name) {
  return component.properties?.find((item) => item.name === name)?.value;
}

function assertReleasePath(logicalPath) {
  const lower = logicalPath.toLowerCase();
  assert(!lower.endsWith('.map'), `source map is forbidden in release resources: ${logicalPath}`);
  assert(!/(^|\/)(test|tests|coverage|playwright-report)(\/|$)/u.test(lower), `test/development path is forbidden: ${logicalPath}`);
  assert(!/\.(pdb|ilk|exp|lib|obj)$/u.test(lower), `debug/build artifact is forbidden: ${logicalPath}`);
  assert(!/\.(pdmodel|pdiparams|onnx)$/u.test(lower), `packaged OCR model is forbidden: ${logicalPath}`);
  assert(!/(^|\/)(\.env(?:\.|$)|id_rsa|id_ed25519|credentials?\.json|secrets?\.json)$/u.test(lower), `credential-like file is forbidden: ${logicalPath}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const rendererHtml = [
  'apps/desktop/src/renderer/ball/index.html',
  'apps/desktop/src/renderer/settings/index.html',
  'apps/desktop/src/renderer/card/index.html'
];

// Production sources are scanned separately from artifacts. Test-only files may
// intentionally contain canary values, so exclude only conventional test/spec
// filenames rather than skipping entire source directories.
const productionSourceRoots = [
  'apps/desktop/src',
  'packages/application/src',
  'packages/contracts/src',
  'packages/storage/src',
  'packages/translation/src',
  'native/selection-host/src',
  'native/selection-host/include'
];
const artifactRoots = [
  'artifacts',
  'apps/desktop/.vite',
  'apps/desktop/artifacts',
  'apps/desktop/coverage',
  'apps/desktop/test-results',
  'apps/desktop/playwright-report',
  ...splitAdditionalRoots(process.env.PHASE4_SCAN_ROOTS)
];

const sensitiveValues = uniqueNonEmpty([
  'phase4-secret-sentinel',
  'phase4-source-sentinel',
  'phase4-translation-sentinel',
  process.env.PHASE4_SCAN_SECRET,
  process.env.PHASE4_SCAN_SOURCE,
  process.env.PHASE4_SCAN_TRANSLATION
]);
const localPathValues = uniqueNonEmpty([
  process.env.USERPROFILE,
  process.env.HOME,
  process.env.USERPROFILE?.replaceAll('\\', '/'),
  process.env.HOME?.replaceAll('\\', '/')
]);
const forbiddenValues = [
  ...sensitiveValues.map((value) => ({ value, kind: 'sensitive canary' })),
  ...localPathValues.map((value) => ({ value, kind: 'local user path' }))
];

const failures = [];
for (const relativePath of rendererHtml) {
  const text = await readFile(join(root, relativePath), 'utf8');
  if (!text.includes("connect-src 'none'")) {
    failures.push(`${relativePath}: renderer network CSP is not locked`);
  }
  if (!text.includes("object-src 'none'")) {
    failures.push(`${relativePath}: object CSP is not locked`);
  }
}

const providerSource = await readFile(join(root, 'packages/translation/src/baidu.ts'), 'utf8');
if (!providerSource.includes('https://fanyi-api.baidu.com/api/trans/vip/translate')) {
  failures.push('Baidu provider endpoint is not the approved HTTPS endpoint');
}
if (/http:\/\/fanyi-api\.baidu\.com/iu.test(providerSource)) {
  failures.push('Baidu provider contains a plaintext HTTP endpoint');
}

let productionFilesScanned = 0;
for (const relativeRoot of productionSourceRoots) {
  const absoluteRoot = join(root, relativeRoot);
  if (!existsSync(absoluteRoot)) continue;
  for (const file of await walk(absoluteRoot)) {
    if (isTestSource(file)) continue;
    productionFilesScanned += 1;
    await scanFile(file, 'production source');
  }
}

let artifactFilesScanned = 0;
const scannedArtifactPaths = new Set();
for (const configuredRoot of artifactRoots) {
  const absoluteRoot = resolve(root, configuredRoot);
  if (!existsSync(absoluteRoot)) continue;
  for (const file of await walk(absoluteRoot)) {
    const canonicalPath = file.toLowerCase();
    if (scannedArtifactPaths.has(canonicalPath)) continue;
    scannedArtifactPaths.add(canonicalPath);
    artifactFilesScanned += 1;
    // Deliberately inspect every artifact as bytes. SQLite databases, compressed
    // traces, images and other binary outputs must not bypass the privacy gate
    // merely because their extension is not textual.
    await scanFile(file, 'artifact');
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[privacy] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `[privacy] PASS (${productionFilesScanned} production files, `
      + `${artifactFilesScanned} artifact files scanned as bytes)`
  );
}

async function scanFile(file, scope) {
  const bytes = await readFile(file);
  for (const forbidden of forbiddenValues) {
    if (containsEncoded(bytes, forbidden.value)) {
      failures.push(
        `${relative(root, file)}: ${scope} contains forbidden ${forbidden.kind}`
      );
    }
  }
}

function containsEncoded(bytes, value) {
  return bytes.includes(Buffer.from(value, 'utf8'))
    || bytes.includes(Buffer.from(value, 'utf16le'));
}

function isTestSource(file) {
  const name = basename(file).toLowerCase();
  return name.includes('.test.') || name.includes('.spec.');
}

function splitAdditionalRoots(value) {
  if (value === undefined) return [];
  return value.split(';').map((entry) => entry.trim()).filter(Boolean);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

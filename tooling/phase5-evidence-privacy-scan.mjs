import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';

const privacyReportSchema = JSON.parse((await readFile(
  resolve(import.meta.dirname, '..', 'schemas', 'phase5', 'privacy-scan.schema.json'),
  'utf8'
)).replace(/^\uFEFF/u, ''));
const validateCanonicalPrivacyReport = new Ajv2020({ allErrors: true, strict: true })
  .compile(privacyReportSchema);

const options = parseArguments(process.argv.slice(2));
if (options.roots.length === 0) throw new Error('At least one --root is required.');

const outputPath = resolve(options.output);
await mkdir(dirname(outputPath), { recursive: true });

const forbiddenValues = uniqueNonEmpty([
  'phase5-secret-sentinel',
  'phase5-source-sentinel',
  'phase5-translation-sentinel',
  process.env.PHASE5_SCAN_SECRET,
  process.env.PHASE5_SCAN_SOURCE,
  process.env.PHASE5_SCAN_TRANSLATION,
  process.env.USERPROFILE,
  process.env.HOME,
  process.env.USERPROFILE?.replaceAll('\\', '/'),
  process.env.HOME?.replaceAll('\\', '/')
]);

const forbiddenEvidenceKeys = new Set([
  'sourceText',
  'translatedText',
  'selectedText',
  'windowTitle',
  'screenshot',
  'credential',
  'credentials',
  'secret',
  'secretKey',
  'token',
  'salt',
  'signatureValue',
  'signatureBytes',
  'privateKey',
  'requestBody',
  'responseBody',
  'pid',
  'hwnd',
  'pipeName',
  'nonce',
  'absolutePath'
].map((value) => value.toLowerCase()));

const pathDetectors = [
  {
    code: 'DRIVE_ABSOLUTE_PATH',
    // The boundary prevents a protocol suffix such as "scheme:C:/" from being
    // interpreted as a local drive path while still catching values embedded
    // in prose, CSV and command-line-like strings.
    pattern: /(?<![A-Za-z0-9:+.-])[A-Za-z]:[\\/](?:[^\u0000\r\n<>|"']*)/giu
  },
  {
    code: 'UNC_ABSOLUTE_PATH',
    pattern: /(?<![:A-Za-z0-9])(?:\\\\|\/\/)[^\\/\s<>:"|?*]+[\\/][^\\/\s<>:"|?*]+/giu
  },
  {
    code: 'FILE_URI',
    pattern: /\bfile:(?:\/{2,3}|\\\\)[^\u0000\r\n\s<>"']+/giu
  }
];

const failures = [];
const failureKeys = new Set();
const counters = {
  forbiddenValue: 0,
  forbiddenField: 0,
  absolutePath: 0,
  invalidStructuredEvidence: 0,
  io: 0
};
let filesScanned = 0;
let bytesScanned = 0;

for (let rootIndex = 0; rootIndex < options.roots.length; rootIndex += 1) {
  const root = resolve(options.roots[rootIndex]);
  const rootNumber = rootIndex + 1;
  if (!existsSync(root)) {
    recordFailure({ root: rootNumber, file: '.', code: 'ROOT_NOT_FOUND' }, 'io');
    continue;
  }

  const files = await walkFailClosed(rootNumber, root, root);
  for (const file of files) {
    if (resolve(file) === outputPath) continue;

    let metadata;
    try {
      metadata = await stat(file);
    } catch {
      recordFailure({
        root: rootNumber,
        file: safeRelative(root, file),
        code: 'FILE_STAT_ERROR'
      }, 'io');
      continue;
    }

    if (metadata.size > options.maxFileBytes) {
      recordFailure({
        root: rootNumber,
        file: safeRelative(root, file),
        code: 'FILE_EXCEEDS_SCAN_LIMIT'
      }, 'io');
      continue;
    }

    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      recordFailure({
        root: rootNumber,
        file: safeRelative(root, file),
        code: 'FILE_READ_ERROR'
      }, 'io');
      continue;
    }

    filesScanned += 1;
    bytesScanned += bytes.length;
    const relativeFile = safeRelative(root, file);

    const decodedCandidates = decodeCandidates(bytes);
    const matchedCanaries = new Set();
    for (const candidate of decodedCandidates) {
      for (const forbiddenValue of forbiddenValues) {
        if (candidate.text.includes(forbiddenValue)) matchedCanaries.add(forbiddenValue);
      }
    }
    if (matchedCanaries.size > 0) {
      recordFailure({ root: rootNumber, file: relativeFile, code: 'FORBIDDEN_VALUE' }, 'forbiddenValue');
    }

    const pathCodes = new Set();
    for (const candidate of decodedCandidates) {
      for (const detector of pathDetectors) {
        detector.pattern.lastIndex = 0;
        if (detector.pattern.test(candidate.text)) pathCodes.add(detector.code);
      }
    }
    for (const code of pathCodes) {
      recordFailure({ root: rootNumber, file: relativeFile, code }, 'absolutePath');
    }

    if (options.mode === 'evidence' && /\.(?:json|jsonl)$/iu.test(file)) {
      await scanStructuredEvidence(rootNumber, root, file, bytes);
    }
  }
}

const report = {
  schemaVersion: '1.1.0',
  scope: options.mode === 'evidence' ? 'phase5-evidence' : 'binary-value-and-path-scan',
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  rootsRequested: options.roots.length,
  rootsScanned: options.roots.length - failures.filter((failure) => failure.code === 'ROOT_NOT_FOUND').length,
  filesScanned,
  bytesScanned,
  localAbsoluteRootsPersisted: counters.absolutePath > 0,
  forbiddenKeyPolicyApplied: options.mode === 'evidence',
  scanEncodings: ['utf8', 'utf16le'],
  findingCounts: {
    forbiddenValue: counters.forbiddenValue,
    forbiddenField: counters.forbiddenField,
    absolutePath: counters.absolutePath,
    invalidStructuredEvidence: counters.invalidStructuredEvidence,
    io: counters.io,
    total: failures.length
  },
  failures
};

try {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
} catch (error) {
  console.error(`[phase5-privacy] REPORT_WRITE_ERROR: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
  throw error;
}

if (failures.length === 0) {
  console.log(`[phase5-privacy] PASS (${filesScanned} files, ${bytesScanned} bytes)`);
} else {
  for (const failure of failures) {
    console.error(`[phase5-privacy] ${failure.code} root-${failure.root}:${failure.file}`);
  }
  process.exitCode = 1;
}

async function scanStructuredEvidence(rootNumber, root, file, bytes) {
  let documents;
  try {
    const text = decodeStructuredText(bytes);
    documents = file.toLowerCase().endsWith('.jsonl')
      ? text.split(/\r?\n/u).filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
      : [JSON.parse(text)];
  } catch {
    recordFailure({
      root: rootNumber,
      file: safeRelative(root, file),
      code: 'INVALID_STRUCTURED_EVIDENCE'
    }, 'invalidStructuredEvidence');
    return;
  }

  const findingCodes = new Set();
  for (const document of documents) {
    recursivelyInspectJson(document, findingCodes, [], isCanonicalPrivacyReport(document));
  }
  for (const code of findingCodes) {
    const counter = code.startsWith('FORBIDDEN_FIELD_') ? 'forbiddenField' : 'absolutePath';
    recordFailure({ root: rootNumber, file: safeRelative(root, file), code }, counter);
  }
}

function recursivelyInspectJson(value, findings, jsonPath, canonicalPrivacyReport) {
  if (typeof value === 'string') {
    inspectString(value, findings);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      recursivelyInspectJson(entry, findings, [...jsonPath, index], canonicalPrivacyReport);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value)) {
    inspectString(key, findings);
    const isCanonicalAbsolutePathCounter = canonicalPrivacyReport &&
      jsonPath.length === 1 &&
      jsonPath[0] === 'findingCounts' &&
      key === 'absolutePath' &&
      Number.isInteger(nested) &&
      nested >= 0;
    if (forbiddenEvidenceKeys.has(key.toLowerCase()) && !isCanonicalAbsolutePathCounter) {
      findings.add(`FORBIDDEN_FIELD_${sanitizeCodeFragment(key)}`);
    }
    recursivelyInspectJson(nested, findings, [...jsonPath, key], canonicalPrivacyReport);
  }
}

function isCanonicalPrivacyReport(document) {
  if (!validateCanonicalPrivacyReport(document)) return false;

  const expectedCounts = {
    forbiddenValue: 0,
    forbiddenField: 0,
    absolutePath: 0,
    invalidStructuredEvidence: 0,
    io: 0
  };
  const failureKeysInReport = new Set();
  for (const failure of document.failures) {
    if (failure.root > document.rootsRequested) return false;
    const failureKey = `${failure.root}\u0000${failure.file}\u0000${failure.code}`;
    if (failureKeysInReport.has(failureKey)) return false;
    failureKeysInReport.add(failureKey);

    const counter = counterForCanonicalFailureCode(failure.code);
    if (counter === undefined) return false;
    expectedCounts[counter] += 1;
  }

  const rootNotFoundCount = document.failures
    .filter((failure) => failure.code === 'ROOT_NOT_FOUND').length;
  return document.rootsScanned === document.rootsRequested - rootNotFoundCount &&
    document.rootsScanned <= document.rootsRequested &&
    document.findingCounts.total === document.failures.length &&
    document.status === (document.failures.length === 0 ? 'PASS' : 'FAIL') &&
    document.localAbsoluteRootsPersisted === (document.findingCounts.absolutePath > 0) &&
    document.forbiddenKeyPolicyApplied === (document.scope === 'phase5-evidence') &&
    Object.entries(expectedCounts).every(
      ([counter, count]) => document.findingCounts[counter] === count
    );
}

function counterForCanonicalFailureCode(code) {
  if (code === 'FORBIDDEN_VALUE') return 'forbiddenValue';
  if (code.startsWith('FORBIDDEN_FIELD_')) return 'forbiddenField';
  if (pathDetectors.some((detector) => detector.code === code)) return 'absolutePath';
  if (code === 'INVALID_STRUCTURED_EVIDENCE') return 'invalidStructuredEvidence';
  if ([
    'ROOT_NOT_FOUND',
    'FILE_STAT_ERROR',
    'FILE_EXCEEDS_SCAN_LIMIT',
    'FILE_READ_ERROR',
    'DIRECTORY_READ_ERROR',
    'UNSUPPORTED_FILE_TYPE'
  ].includes(code)) return 'io';
  return undefined;
}

function inspectString(value, findings) {
  for (const detector of pathDetectors) {
    detector.pattern.lastIndex = 0;
    if (detector.pattern.test(value)) findings.add(detector.code);
  }
}

function decodeCandidates(bytes) {
  const candidates = [{ encoding: 'utf8', text: bytes.toString('utf8').replace(/^\uFEFF/u, '') }];
  if (bytes.length >= 2) {
    const evenLength = bytes.length - (bytes.length % 2);
    candidates.push({
      encoding: 'utf16le',
      text: bytes.subarray(0, evenLength).toString('utf16le').replace(/^\uFEFF/u, '')
    });
  }
  // PE/resources and concatenated binary evidence can place an otherwise
  // valid UTF-16LE string at an odd byte offset.  Scan both alignments.
  if (bytes.length >= 3) {
    const oddAlignedLength = bytes.length - 1 - ((bytes.length - 1) % 2);
    candidates.push({
      encoding: 'utf16le-offset-1',
      text: bytes.subarray(1, 1 + oddAlignedLength).toString('utf16le').replace(/^\uFEFF/u, '')
    });
  }
  return candidates;
}

function decodeStructuredText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le').replace(/^\uFEFF/u, '');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/u, '');
}

function recordFailure(failure, counter) {
  // Reports intentionally contain only a stable code and root-relative file;
  // never echo the sensitive value, absolute root or local exception text.
  const key = `${failure.root}\u0000${failure.file}\u0000${failure.code}`;
  if (failureKeys.has(key)) return;
  failureKeys.add(key);
  failures.push(failure);
  counters[counter] += 1;
}

function sanitizeCodeFragment(value) {
  return value.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toUpperCase() || 'UNKNOWN';
}

function parseArguments(args) {
  const roots = [];
  let output = 'artifacts/phase5/local/security/privacy-scan.json';
  let mode = 'evidence';
  let maxFileBytes = 512 * 1024 * 1024;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (name === '--root') roots.push(value);
    else if (name === '--output') output = value;
    else if (name === '--mode') mode = value;
    else if (name === '--max-file-bytes') maxFileBytes = Number(value);
    else throw new Error(`Unknown argument: ${name}`);
    index += 1;
  }
  if (!['evidence', 'binary'].includes(mode)) throw new Error('--mode must be evidence or binary.');
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('--max-file-bytes must be a positive integer.');
  }
  return { roots, output, mode, maxFileBytes };
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function safeRelative(root, file) {
  const value = relative(root, file).replaceAll('\\', '/');
  return value === '' ? '.' : value;
}

async function walkFailClosed(rootNumber, root, directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    recordFailure({
      root: rootNumber,
      file: safeRelative(root, directory),
      code: 'DIRECTORY_READ_ERROR'
    }, 'io');
    return files;
  }

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFailClosed(rootNumber, root, path));
    else if (entry.isFile()) files.push(path);
    else {
      recordFailure({
        root: rootNumber,
        file: safeRelative(root, path),
        code: 'UNSUPPORTED_FILE_TYPE'
      }, 'io');
    }
  }
  return files;
}

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`Invalid argument near '${key}'`);
    }
    if (result.has(key)) throw new Error(`Duplicate argument '${key}'`);
    result.set(key, argv[index + 1]);
    index += 1;
  }
  return result;
}

export function requiredArgument(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return resolve(value);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

export async function sha256Tree(root, options = {}) {
  const paths = await walkFiles(root, options);
  const hash = createHash('sha256');
  for (const path of paths) {
    const logical = toPosix(relative(root, path));
    hash.update(logical, 'utf8');
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function walkFiles(root, options = {}) {
  const excluded = options.excluded ?? (() => false);
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const logical = toPosix(relative(root, path));
      if (excluded(logical, entry)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Supply-chain input contains a non-regular file: ${logical}`);
    }
  }
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Expected directory: ${root}`);
  await visit(root);
  return files;
}

export function toPosix(path) {
  return path.split(sep).join('/');
}

export function isInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith(sep));
}

export function assertSafeLogicalPath(path) {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    /[\r\n\0]/u.test(path)
  ) {
    throw new Error(`Unsafe logical path in manifest: ${JSON.stringify(path)}`);
  }
}

export function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function buildFileManifest(root, excluded = () => false) {
  const files = await walkFiles(root, { excluded });
  const entries = [];
  for (const path of files) {
    const logicalPath = toPosix(relative(root, path));
    assertSafeLogicalPath(logicalPath);
    entries.push({
      path: logicalPath,
      size: (await stat(path)).size,
      sha256: await sha256File(path)
    });
  }
  return entries;
}

export function renderChecksumManifest(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`;
}

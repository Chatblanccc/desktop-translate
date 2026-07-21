import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, requiredArgument, toPosix, writeJson } from './phase5-supply-chain-lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const outputPath = requiredArgument(args, '--output');
const mode = args.get('--mode');
const expectedHead = args.get('--expected-head');
if (mode !== 'signed' && mode !== 'unsigned') throw new Error("--mode must be 'signed' or 'unsigned'");

const headSha = gitText(['rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('Unable to resolve a full git SHA');
if (expectedHead && headSha !== expectedHead.toLowerCase()) {
  throw new Error(`RELEASE BLOCKED: checked-out HEAD ${headSha} does not match expected build SHA ${expectedHead}`);
}

const status = gitBuffer(['status', '--porcelain=v1', '--untracked-files=all', '-z']);
const trackedPatch = gitBuffer(['-c', 'core.safecrlf=false', 'diff', '--binary', '--full-index', 'HEAD', '--']);
const untrackedOutput = gitBuffer(['ls-files', '--others', '--exclude-standard', '-z']);
const untrackedPaths = untrackedOutput.toString('utf8').split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'));
const developmentDirty = status.length !== 0;

if (mode === 'signed' && developmentDirty) {
  throw new Error('RELEASE BLOCKED: SignedRelease requires a clean Git worktree, including tracked, staged, and untracked files.');
}

const digest = createHash('sha256');
digest.update('desktop-translate-phase5-workspace-state-v1\0', 'utf8');
digest.update(headSha, 'ascii');
digest.update('\0status\0', 'utf8');
digest.update(status);
digest.update('\0tracked-patch\0', 'utf8');
digest.update(trackedPatch);

let untrackedBytes = 0;
for (const logicalPath of untrackedPaths) {
  const absolutePath = resolve(workspaceRoot, ...logicalPath.split('/'));
  const normalized = toPosix(relative(workspaceRoot, absolutePath));
  if (normalized !== logicalPath || normalized.startsWith('../')) {
    throw new Error(`Unsafe untracked path returned by Git: ${JSON.stringify(logicalPath)}`);
  }
  await assertNoSymlinkOrJunction(logicalPath);
  const details = await lstat(absolutePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Release workspace state contains a non-regular untracked entry: ${logicalPath}`);
  }
  const bytes = await readFile(absolutePath);
  untrackedBytes += bytes.length;
  digest.update('\0untracked\0', 'utf8');
  digest.update(logicalPath, 'utf8');
  digest.update('\0', 'utf8');
  digest.update(bytes);
}

async function assertNoSymlinkOrJunction(logicalPath) {
  let cursor = workspaceRoot;
  for (const segment of logicalPath.split('/')) {
    cursor = join(cursor, segment);
    const details = await lstat(cursor);
    if (details.isSymbolicLink()) {
      throw new Error(`Workspace state refuses an untracked symlink/junction path: ${logicalPath}`);
    }
  }
}

const state = {
  schemaVersion: 1,
  headSha,
  sourceIdentity: developmentDirty ? `HEAD+WORKTREE:${digest.copy().digest('hex')}` : `HEAD:${headSha}`,
  developmentDirty,
  acceptanceEligible: mode === 'signed' && !developmentDirty,
  patchDigest: developmentDirty ? digest.digest('hex') : null,
  statusDigest: createHash('sha256').update(status).digest('hex'),
  trackedPatchSha256: createHash('sha256').update(trackedPatch).digest('hex'),
  untrackedFileCount: untrackedPaths.length,
  untrackedBytes,
  captureMode: mode
};
await writeJson(outputPath, state);
console.log(`[phase5:workspace] ${state.sourceIdentity}; acceptanceEligible=${state.acceptanceEligible}`);

function gitBuffer(commandArgs) {
  return execFileSync('git', commandArgs, { cwd: workspaceRoot, windowsHide: true, encoding: 'buffer' });
}

function gitText(commandArgs) {
  return execFileSync('git', commandArgs, { cwd: workspaceRoot, windowsHide: true, encoding: 'utf8' });
}

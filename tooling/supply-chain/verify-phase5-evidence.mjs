import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, readJson, requiredArgument, sha256File } from './phase5-supply-chain-lib.mjs';
import {
  assertExactArtifactSet,
  collectReleaseArtifacts,
  expectedArtifactRoles,
  expectedSignedRoles
} from './phase5-release-evidence-lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const evidenceDirectory = requiredArgument(args, '--evidence-dir');
const packageDirectory = requiredArgument(args, '--package-dir');
const releaseMode = args.get('--release-mode');
const installerPath = args.has('--installer') ? requiredArgument(args, '--installer') : undefined;
if (releaseMode !== 'unsigned' && releaseMode !== 'signed') {
  throw new Error("--release-mode must be 'unsigned' or 'signed'");
}

const manifest = await readJson(join(evidenceDirectory, 'release', 'evidence-manifest.json'));
const binaryManifest = await readJson(join(evidenceDirectory, 'binary-manifest.json'));
const signatureReport = await readJson(join(evidenceDirectory, 'security', 'signature-report.json'));
const workspaceState = await readJson(join(evidenceDirectory, 'build', 'workspace-state.json'));
const product = await readJson(join(workspaceRoot, 'resources', 'phase5', 'product-manifest.json'));
const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', windowsHide: true }).trim();

assert(manifest.schemaVersion === 1, 'draft evidence manifest schemaVersion must be 1');
assert(manifest.productVersion === product.canonicalVersion, 'draft evidence manifest product version mismatch');
assert(manifest.gitSha === gitSha, 'draft evidence manifest git SHA does not match the current build');
assert(manifest.supplyChain?.status === 'PASS', 'supply-chain evidence gate is not PASS');
assert(manifest.package?.status === 'PASS', 'package evidence gate is not PASS');
assert(binaryManifest.schemaVersion === 2, 'binary manifest schemaVersion must be 2');
assert(binaryManifest.productVersion === product.canonicalVersion, 'binary manifest version mismatch');

assert(manifest.build?.sourceIdentity === workspaceState.sourceIdentity, 'workspace source identity mismatch');
assert(manifest.build?.developmentDirty === workspaceState.developmentDirty, 'workspace dirty state mismatch');
assert(manifest.build?.patchDigest === workspaceState.patchDigest, 'workspace patch digest mismatch');
assert(workspaceState.headSha === gitSha, 'workspace state HEAD mismatch');
if (workspaceState.developmentDirty) {
  assert(/^[a-f0-9]{64}$/u.test(workspaceState.patchDigest), 'dirty development build lacks a valid patchDigest');
  assert(manifest.build?.acceptanceEligible === false, 'dirty development build must not be acceptance eligible');
}
await assertWorkspaceStateStillCurrent(workspaceState, releaseMode);

for (const field of ['sbom', 'notices', 'stagedFileManifest', 'provenance']) {
  const value = manifest.supplyChain[field];
  assertSafeEvidencePath(value, `supplyChain.${field}`);
  await assertRegularFile(join(evidenceDirectory, ...value.split('/')), `evidence ${field}`);
}
assert(await sha256File(join(evidenceDirectory, ...manifest.supplyChain.sbom.split('/'))) === manifest.supplyChain.sbomSha256, 'evidence SBOM hash mismatch');
assert(await sha256File(join(evidenceDirectory, ...manifest.supplyChain.notices.split('/'))) === manifest.supplyChain.noticesSha256, 'evidence notices hash mismatch');
assert(await sha256File(join(evidenceDirectory, ...manifest.supplyChain.provenance.split('/'))) === manifest.supplyChain.provenanceSha256, 'build provenance hash mismatch');

for (const field of ['binaryManifest', 'sizeManifest', 'fileManifest']) {
  const value = manifest.package[field];
  assertSafeEvidencePath(value, `package.${field}`);
  await assertRegularFile(join(evidenceDirectory, ...value.split('/')), `evidence ${field}`);
}
assertSafeEvidencePath(manifest.package.startupSmoke, 'package.startupSmoke');
const startupSmokePath = join(evidenceDirectory, ...manifest.package.startupSmoke.split('/'));
await assertRegularFile(startupSmokePath, 'packaged startup smoke evidence');
assert(await sha256File(startupSmokePath) === manifest.package.startupSmokeSha256, 'packaged startup smoke evidence hash mismatch');
const startupSmoke = await readJson(startupSmokePath);
assert(manifest.package.startupSmokeStatus === 'PASS' && startupSmoke.status === 'PASS', 'packaged startup smoke is not PASS');
assert(startupSmoke.packagedNativeHostPathVerified === true, 'packaged startup smoke did not verify the fixed Native Host path');
assert(startupSmoke.packagedClearDataHelperExecuted === true && startupSmoke.markerBoundTargetDeleted === true && startupSmoke.siblingPreserved === true, 'packaged clear-data helper proof is incomplete');

const currentArtifacts = await collectReleaseArtifacts(packageDirectory, installerPath);
assertExactArtifactSet(
  binaryManifest.artifacts,
  currentArtifacts,
  'binary manifest',
  expectedArtifactRoles(Boolean(installerPath))
);

assert(signatureReport.schemaVersion === 2, 'signature report schemaVersion must be 2');
const signedCurrentArtifacts = currentArtifacts.filter((item) => item.role !== 'asar');
assertExactArtifactSet(
  signatureReport.artifacts,
  signedCurrentArtifacts,
  'signature report',
  expectedSignedRoles(Boolean(installerPath))
);
assert(JSON.stringify([...signatureReport.exactArtifactRoles].sort()) === JSON.stringify(expectedSignedRoles(Boolean(installerPath))), 'signature report exactArtifactRoles mismatch');
assertExactArtifactSet(
  manifest.signatures?.artifacts,
  signedCurrentArtifacts,
  'draft evidence signature artifacts',
  expectedSignedRoles(Boolean(installerPath))
);

if (releaseMode === 'signed') {
  assert(installerPath, 'signed release verification requires --installer');
  assert(workspaceState.developmentDirty === false, 'signed release workspace must be clean');
  assert(workspaceState.acceptanceEligible === true, 'signed release workspace was not captured as acceptance eligible');
  assert(signatureReport.requireSigned === true, 'signed release evidence was not produced with RequireSigned');
  assert(signatureReport.status === 'PASS', 'signature report is not PASS');
  assert(manifest.signatures?.status === 'PASS', 'draft evidence signature gate is not PASS');
  assert(manifest.release?.status === 'RELEASE BLOCKED', 'pre-attestation signed evidence must remain RELEASE BLOCKED');
  assert((manifest.release.blockers ?? []).some((item) => /attestation|clean-download/iu.test(item)), 'signed evidence is missing the independent-attestation blocker');
} else {
  assert(signatureReport.requireSigned === false, 'unsigned evidence unexpectedly claims RequireSigned');
  assert(manifest.release?.status === 'RELEASE BLOCKED', 'unsigned package must remain RELEASE BLOCKED');
  assert((manifest.release.blockers ?? []).length > 0, 'unsigned package must record a release blocker');
}

console.log(`[phase5:evidence] Exact artifact sets, live hashes, source identity, supply chain, and ${releaseMode} pre-attestation state PASS.`);
console.log('[phase5:evidence] Overall release remains RELEASE BLOCKED until independent attestation and clean-download verification complete.');

async function assertWorkspaceStateStillCurrent(expected, mode) {
  const temporaryPath = join(tmpdir(), `desktop-translate-phase5-workspace-recheck-${randomUUID()}.json`);
  try {
    execFileSync(process.execPath, [
      join(scriptDirectory, 'capture-phase5-workspace-state.mjs'),
      '--output', temporaryPath,
      '--mode', mode,
      '--expected-head', gitSha
    ], { cwd: workspaceRoot, windowsHide: true, stdio: 'pipe' });
    const current = JSON.parse(await readFile(temporaryPath, 'utf8'));
    assert(current.sourceIdentity === expected.sourceIdentity, 'workspace changed after its source identity was captured');
    assert(current.patchDigest === expected.patchDigest, 'workspace patchDigest changed during packaging');
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function assertSafeEvidencePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing`);
  assert(!isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..'), `${label} must be a safe relative POSIX path`);
}

async function assertRegularFile(path, label) {
  const details = await stat(path).catch(() => undefined);
  assert(details?.isFile(), `${label} is missing: ${path}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

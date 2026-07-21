import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, readJson, requiredArgument, sha256File, writeJson } from './phase5-supply-chain-lib.mjs';
import {
  assertExactAttestationBundle,
  assertExactArtifactSet,
  collectReleaseArtifacts,
  expectedArtifactRoles,
  expectedSignedRoles,
  publicArtifactRecords
} from './phase5-release-evidence-lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, '..', '..');
const args = parseArguments(process.argv.slice(2));
const evidenceDirectory = requiredArgument(args, '--evidence-dir');
const packageDirectory = requiredArgument(args, '--package-dir');
const installerPath = requiredArgument(args, '--installer');
const artifactBundlePath = requiredArgument(args, '--artifact-bundle');
const trustedRootPath = requiredArgument(args, '--trusted-root');
const repository = requiredText('--repository');
const sourceRef = requiredText('--source-ref');
const sourceDigest = requiredText('--source-digest').toLowerCase();
const signerWorkflow = requiredText('--signer-workflow');
const attestationUrl = args.get('--attestation-url') || null;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== sourceRef || process.env.GITHUB_SHA?.toLowerCase() !== sourceDigest) {
  throw new Error('RELEASE BLOCKED: finalization is restricted to the matching protected GitHub Actions source context');
}
if (!process.env.GITHUB_RUN_ID || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
  throw new Error('RELEASE BLOCKED: GitHub Actions run/OIDC context is unavailable');
}
const githubServerUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
if (!attestationUrl?.startsWith(`${githubServerUrl}/${repository}/attestations/`)) {
  throw new Error('RELEASE BLOCKED: the GitHub artifact attestation URL is missing or belongs to another repository');
}
if (!/^[0-9a-f]{40}$/u.test(sourceDigest)) throw new Error('--source-digest must be a full Git commit SHA');
if (!sourceRef.startsWith('refs/tags/phase5-rc-')) throw new Error('RELEASE BLOCKED: finalization requires a Phase 5 RC tag ref');

for (const [path, label] of [[artifactBundlePath, 'artifact attestation bundle'], [trustedRootPath, 'GitHub/Sigstore trusted root']]) {
  const details = await stat(path).catch(() => undefined);
  assert(details?.isFile() && details.size > 0, `${label} is missing or empty: ${path}`);
}

const draftPath = join(evidenceDirectory, 'release', 'evidence-manifest.json');
const binaryManifestPath = join(evidenceDirectory, 'binary-manifest.json');
const signatureReportPath = join(evidenceDirectory, 'security', 'signature-report.json');
const workspaceStatePath = join(evidenceDirectory, 'build', 'workspace-state.json');
const dependencyAuditPath = join(evidenceDirectory, 'supply-chain', 'dependency-audit.json');
const startupSmokePath = join(evidenceDirectory, 'package', 'startup-smoke.json');
const packageSizeManifestPath = join(evidenceDirectory, 'package', 'size-manifest.json');
const packageFileManifestPath = join(evidenceDirectory, 'package', 'file-manifest.sha256');
const noticesPath = join(evidenceDirectory, 'supply-chain', 'third-party-notices.txt');
const stagedFileManifestPath = join(evidenceDirectory, 'supply-chain', 'staged-file-manifest.sha256');
const draft = await readJson(draftPath);
const binaryManifest = await readJson(binaryManifestPath);
const signatureReport = await readJson(signatureReportPath);
const workspaceState = await readJson(workspaceStatePath);
const dependencyAudit = await readJson(dependencyAuditPath);
const startupSmoke = await readJson(startupSmokePath);
const currentArtifacts = await collectReleaseArtifacts(packageDirectory, installerPath);
const signedArtifacts = currentArtifacts.filter((item) => item.role !== 'asar');

assert(draft.gitSha === sourceDigest, 'draft evidence SHA does not match the attested source digest');
assert(workspaceState.headSha === sourceDigest, 'workspace-state SHA does not match the attested source digest');
assert(workspaceState.developmentDirty === false, 'RELEASE BLOCKED: finalization rejects a developmentDirty build');
assert(workspaceState.acceptanceEligible === true, 'RELEASE BLOCKED: workspace was not captured in SignedRelease mode');
assert(dependencyAudit.status === 'PASS', 'RELEASE BLOCKED: dependency advisory audit is not PASS');
assert(dependencyAudit.gitSha === sourceDigest, 'RELEASE BLOCKED: dependency audit source SHA mismatch');
assert(dependencyAudit.registry === 'https://registry.npmjs.org/', 'RELEASE BLOCKED: dependency audit did not use the frozen official registry');
assert(dependencyAudit.endpoint?.status === 'PASS', 'RELEASE BLOCKED: dependency advisory endpoint did not pass');
assert(dependencyAudit.vulnerabilities?.high === 0 && dependencyAudit.vulnerabilities?.critical === 0, 'RELEASE BLOCKED: dependency audit contains a High/Critical finding');
assert(dependencyAudit.lockfile?.path === 'pnpm-lock.yaml', 'RELEASE BLOCKED: dependency audit lockfile identity is invalid');
assert(dependencyAudit.lockfile.sha256 === await sha256File(join(workspaceRoot, 'pnpm-lock.yaml')), 'RELEASE BLOCKED: audited lockfile hash does not match the release workspace');
assert(draft.package?.startupSmokeStatus === 'PASS' && startupSmoke.status === 'PASS', 'RELEASE BLOCKED: packaged startup smoke is not PASS');
assert(startupSmoke.packagedNativeHostPathVerified === true, 'RELEASE BLOCKED: packaged Native Host path proof is missing');
assert(startupSmoke.packagedClearDataHelperExecuted === true && startupSmoke.markerBoundTargetDeleted === true && startupSmoke.siblingPreserved === true, 'RELEASE BLOCKED: packaged clear-data helper proof is incomplete');
assert(draft.package.startupSmokeSha256 === await sha256File(startupSmokePath), 'RELEASE BLOCKED: packaged startup smoke hash mismatch');
assert(draft.supplyChain?.status === 'PASS', 'RELEASE BLOCKED: draft supply-chain gate is not PASS');
assert(draft.supplyChain.sbom === 'supply-chain/sbom.cdx.json', 'RELEASE BLOCKED: draft SBOM path is invalid');
assert(draft.supplyChain.sbomSha256 === await sha256File(join(evidenceDirectory, 'supply-chain', 'sbom.cdx.json')), 'RELEASE BLOCKED: draft SBOM hash mismatch');
assert(draft.supplyChain.notices === 'supply-chain/third-party-notices.txt', 'RELEASE BLOCKED: draft notices path is invalid');
assert(draft.supplyChain.noticesSha256 === await sha256File(noticesPath), 'RELEASE BLOCKED: draft notices hash mismatch');
assert(draft.supplyChain.stagedFileManifest === 'supply-chain/staged-file-manifest.sha256', 'RELEASE BLOCKED: staged file manifest path is invalid');
assert(draft.package?.sizeManifest === 'package/size-manifest.json' && draft.package?.fileManifest === 'package/file-manifest.sha256', 'RELEASE BLOCKED: draft package evidence paths are invalid');
assert(draft.supplyChain.provenance === 'supply-chain/build-provenance.json', 'RELEASE BLOCKED: draft provenance path is invalid');
assert(draft.supplyChain.provenanceSha256 === await sha256File(join(evidenceDirectory, 'supply-chain', 'build-provenance.json')), 'RELEASE BLOCKED: draft build provenance hash mismatch');
assert(binaryManifest.schemaVersion === 2, 'binary manifest schemaVersion must be 2');
assertExactArtifactSet(binaryManifest.artifacts, currentArtifacts, 'binary manifest', expectedArtifactRoles(true));
assert(signatureReport.schemaVersion === 2 && signatureReport.requireSigned === true && signatureReport.status === 'PASS', 'RELEASE BLOCKED: Authenticode report is not a signed PASS');
assertExactArtifactSet(signatureReport.artifacts, signedArtifacts, 'signature report', expectedSignedRoles(true));
assertExactArtifactSet(draft.signatures?.artifacts, signedArtifacts, 'draft signature evidence', expectedSignedRoles(true));
await assertExactBundleSubjects(artifactBundlePath, currentArtifacts);

for (const artifact of currentArtifacts) {
  verifyGitHubAttestation(artifact.absolutePath);
}

const finalManifestPath = join(evidenceDirectory, 'release', 'final-release-manifest.json');
const finalManifest = {
  schemaVersion: 1,
  productVersion: draft.productVersion,
  source: {
    repository,
    ref: sourceRef,
    gitSha: sourceDigest,
    sourceIdentity: workspaceState.sourceIdentity,
    developmentDirty: false,
    patchDigest: null
  },
  artifacts: publicArtifactRecords(currentArtifacts),
  authenticode: {
    status: 'PASS',
    expectedSubject: signatureReport.expectedSubject,
    exactArtifactRoles: expectedSignedRoles(true),
    signatureReport: 'security/signature-report.json',
    signatureReportSha256: await sha256File(signatureReportPath)
  },
  packageSmoke: {
    status: 'PASS',
    report: 'package/startup-smoke.json',
    reportSha256: await sha256File(startupSmokePath),
    boundary: startupSmoke.acceptanceBoundary
  },
  packageEvidence: {
    status: 'PASS',
    sizeManifest: 'package/size-manifest.json',
    sizeManifestSha256: await sha256File(packageSizeManifestPath),
    fileManifest: 'package/file-manifest.sha256',
    fileManifestSha256: await sha256File(packageFileManifestPath)
  },
  supplyChain: {
    status: 'PASS',
    sbom: draft.supplyChain.sbom,
    sbomSha256: draft.supplyChain.sbomSha256,
    notices: draft.supplyChain.notices,
    noticesSha256: await sha256File(noticesPath),
    stagedFileManifest: draft.supplyChain.stagedFileManifest,
    stagedFileManifestSha256: await sha256File(stagedFileManifestPath),
    provenance: draft.supplyChain.provenance,
    provenanceSha256: draft.supplyChain.provenanceSha256,
    binaryManifest: 'binary-manifest.json',
    binaryManifestSha256: await sha256File(binaryManifestPath),
    workspaceState: 'build/workspace-state.json',
    workspaceStateSha256: await sha256File(workspaceStatePath),
    draftEvidence: 'release/evidence-manifest.json',
    draftEvidenceSha256: await sha256File(draftPath),
    dependencyAudit: 'supply-chain/dependency-audit.json',
    dependencyAuditSha256: await sha256File(dependencyAuditPath)
  },
  independentTrustRoot: {
    type: 'github-artifact-attestation-sigstore',
    status: 'PASS',
    repository,
    sourceRef,
    sourceDigest,
    signerWorkflow,
    attestationUrl,
    artifactBundle: 'security/github-artifacts-attestation.json',
    artifactBundleSha256: await sha256File(artifactBundlePath),
    trustedRoot: 'security/trusted_root.jsonl',
    trustedRootSha256: await sha256File(trustedRootPath),
    verification: 'All current app, Native Host, ASAR, and installer bytes verified offline with gh attestation verify.'
  },
  release: {
    status: 'RELEASE BLOCKED',
    blockers: [
      'The final release manifest still requires its own GitHub artifact attestation.',
      'A separately downloaded bundle still requires independent clean-download verification.'
    ],
    acceptanceBoundary: 'Only a PASS clean-download-verification.json produced from the separately downloaded GitHub artifact closes these blockers.'
  }
};
await writeJson(finalManifestPath, finalManifest);
console.log(`[phase5:release] Final artifact hashes recorded after GitHub provenance verification: ${finalManifestPath}`);
console.log('[phase5:release] RELEASE BLOCKED until the manifest attestation and independent clean-download job pass.');

function verifyGitHubAttestation(path) {
  execFileSync('gh', [
    'attestation', 'verify', path,
    '--repo', repository,
    '--bundle', artifactBundlePath,
    '--custom-trusted-root', trustedRootPath,
    '--signer-workflow', signerWorkflow,
    '--source-ref', sourceRef,
    '--source-digest', sourceDigest
  ], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

async function assertExactBundleSubjects(path, artifacts) {
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('RELEASE BLOCKED: GitHub artifact attestation bundle is malformed');
  }
  assertExactAttestationBundle(bundle, artifacts.map((artifact) => artifact.sha256), 'RELEASE BLOCKED: artifact attestation');
}

function requiredText(name) {
  const value = args.get(name);
  if (!value || !value.trim()) throw new Error(`Missing required argument ${name}`);
  return value.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

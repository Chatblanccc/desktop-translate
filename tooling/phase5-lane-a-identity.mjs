import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export async function resolveAttestedArtifactIdentity(configuration, workspaceRoot) {
  const workspace = await describeWorkspace(workspaceRoot);
  if (workspace.gitSha !== configuration.gitSha) {
    throw new Error('--git-sha does not match the checked-out commit.');
  }
  if (workspace.dirty) {
    throw new Error('Lane A full schedule requires a clean checked-out worktree.');
  }

  const paths = resolveIdentityPaths(configuration);
  assertOutputDisjoint(configuration.outputRoot, Object.values(paths));
  assertInputsOutsideWorkspace(workspaceRoot, Object.values(paths));
  const descriptions = await describeIdentityInputs(paths);
  if (descriptions.testArtifact.sha256 === descriptions.releaseArtifact.sha256) {
    throw new Error('Lane A test and release artifact bytes must remain distinct.');
  }

  const testManifest = await readJsonFile(paths.testManifest, 'Lane A test build manifest');
  const releaseManifest = await readJsonFile(paths.releaseManifest, 'Lane A release build manifest');
  validateAttestedBuildManifests({
    configuration,
    workspace,
    descriptions,
    testManifest,
    releaseManifest
  });

  assertExactBundleSubjects(
    await readJsonFile(paths.testBundle, 'Lane A test attestation bundle'),
    [descriptions.testArtifact.sha256, descriptions.testManifest.sha256]
  );
  assertExactBundleSubjects(
    await readJsonFile(paths.releaseBundle, 'Lane A release attestation bundle'),
    [descriptions.releaseArtifact.sha256, descriptions.releaseManifest.sha256]
  );

  for (const [path, bundle] of [
    [paths.testArtifact, paths.testBundle],
    [paths.testManifest, paths.testBundle],
    [paths.releaseArtifact, paths.releaseBundle],
    [paths.releaseManifest, paths.releaseBundle]
  ]) {
    verifyGitHubAttestation(path, bundle, paths.trustedRoot, configuration);
  }

  return {
    verified: true,
    source: 'GITHUB_ATTESTED_BUILD_MANIFESTS',
    repository: configuration.repository,
    sourceRef: configuration.sourceRef,
    signerWorkflow: configuration.signerWorkflow,
    lockfileSha256: workspace.lockfileSha256,
    testArtifact: descriptions.testArtifact,
    releaseArtifact: descriptions.releaseArtifact,
    testBuildManifestSha256: descriptions.testManifest.sha256,
    releaseBuildManifestSha256: descriptions.releaseManifest.sha256,
    trustedRootSha256: descriptions.trustedRoot.sha256,
    inputDescriptions: descriptions,
    workspace
  };
}

export async function assertAttestedIdentityUnchanged(configuration, expected, workspaceRoot) {
  const workspace = await describeWorkspace(workspaceRoot);
  if (JSON.stringify(workspace) !== JSON.stringify(expected.workspace)) {
    throw new Error('Lane A checked-out source or lockfile changed while the schedule was running.');
  }
  const actual = await describeIdentityInputs(resolveIdentityPaths(configuration));
  assertIdentityDescriptionsUnchanged(actual, expected.inputDescriptions);
}

export function assertIdentityDescriptionsUnchanged(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Lane A artifact, build manifest, attestation, or trust-root bytes changed during the schedule.');
  }
}

export function validateAttestedBuildManifests({
  configuration,
  workspace,
  descriptions,
  testManifest,
  releaseManifest
}) {
  validateBuildManifest(testManifest, 'release-equivalent-test', descriptions.testArtifact, configuration, workspace);
  validateBuildManifest(releaseManifest, 'public-release', descriptions.releaseArtifact, configuration, workspace);

  if (stableJson(testManifest.toolchain) !== stableJson(releaseManifest.toolchain)) {
    throw new Error('Lane A artifacts were not built with the same declared toolchain.');
  }
  if (testManifest.build.fakeInjectionEnabled !== true || testManifest.build.testHooksEnabled !== true) {
    throw new Error('Lane A test artifact manifest does not declare the required fake-only injection surface.');
  }
  if (releaseManifest.build.fakeInjectionEnabled !== false || releaseManifest.build.testHooksEnabled !== false) {
    throw new Error('Lane A public artifact manifest must exclude fake injection and test hooks.');
  }
  if (testManifest.build.productionFlavor !== true || releaseManifest.build.productionFlavor !== true) {
    throw new Error('Lane A artifacts must both declare the production build flavor.');
  }
  if (testManifest.build.buildDifferenceId !== releaseManifest.build.buildDifferenceId
      || testManifest.build.buildDifferenceId !== configuration.buildDifferenceId) {
    throw new Error('Lane A build difference identifier is not bound by both attested manifests.');
  }
}

export function assertOutputDisjoint(outputRoot, inputPaths) {
  const output = normalized(resolve(outputRoot));
  for (const inputPath of inputPaths) {
    const input = normalized(resolve(inputPath));
    if (input === output || input.startsWith(`${output}/`)) {
      throw new Error('Lane A identity input cannot be inside the output root.');
    }
  }
}

export function assertInputsOutsideWorkspace(workspaceRoot, inputPaths) {
  const workspace = normalized(resolve(workspaceRoot));
  for (const inputPath of inputPaths) {
    const input = normalized(resolve(inputPath));
    if (input === workspace || input.startsWith(`${workspace}/`)) {
      throw new Error('Lane A attested identity inputs must be independently acquired outside the checkout.');
    }
  }
}

export async function describeRegularFile(path) {
  const resolvedPath = resolve(path);
  const details = await lstat(resolvedPath).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) {
    throw new Error(`Lane A identity input is missing, linked, or not a regular file: ${resolvedPath}`);
  }
  return {
    name: basename(resolvedPath),
    size: details.size,
    sha256: await sha256File(resolvedPath)
  };
}

export function assertExactBundleSubjects(bundleValue, expectedSha256) {
  let statement;
  try {
    const payload = bundleValue.dsseEnvelope?.payload;
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('Lane A attestation bundle/DSSE statement is malformed.');
  }
  if (statement?._type !== 'https://in-toto.io/Statement/v1'
      || statement?.predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error('Lane A attestation bundle is not SLSA provenance v1.');
  }
  const actual = (statement.subject ?? []).map((subject) => subject?.digest?.sha256).sort();
  const expected = [...expectedSha256].sort();
  if (actual.some((value) => !SHA256_PATTERN.test(value ?? ''))
      || new Set(actual).size !== actual.length
      || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Lane A attestation subject set is not the exact artifact/manifest byte set.');
  }
}

async function describeWorkspace(workspaceRoot) {
  const gitSha = git(workspaceRoot, ['rev-parse', 'HEAD']).toLowerCase();
  if (!GIT_SHA_PATTERN.test(gitSha)) throw new Error('Unable to resolve a full checked-out Git SHA.');
  const status = git(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  return {
    gitSha,
    lockfileSha256: await sha256File(resolve(workspaceRoot, 'pnpm-lock.yaml')),
    dirty: status.trim() !== ''
  };
}

function git(workspaceRoot, args) {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function resolveIdentityPaths(configuration) {
  return {
    testArtifact: resolve(configuration.testArtifactPath),
    releaseArtifact: resolve(configuration.releaseArtifactPath),
    testManifest: resolve(configuration.testBuildManifestPath),
    releaseManifest: resolve(configuration.releaseBuildManifestPath),
    testBundle: resolve(configuration.testAttestationBundlePath),
    releaseBundle: resolve(configuration.releaseAttestationBundlePath),
    trustedRoot: resolve(configuration.trustedRootPath)
  };
}

async function describeIdentityInputs(paths) {
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await describeRegularFile(path)]));
  return Object.fromEntries(entries);
}

function validateBuildManifest(manifest, role, artifact, configuration, workspace) {
  if (manifest?.schemaVersion !== 1 || manifest?.artifactRole !== role) {
    throw new Error(`Lane A ${role} build manifest identity is invalid.`);
  }
  const source = manifest.source;
  if (source?.repository !== configuration.repository
      || source?.ref !== configuration.sourceRef
      || source?.gitSha !== configuration.gitSha
      || source?.lockfileSha256 !== workspace.lockfileSha256
      || source?.developmentDirty !== false) {
    throw new Error(`Lane A ${role} build manifest source binding is invalid.`);
  }
  if (manifest.artifact?.name !== artifact.name
      || manifest.artifact?.size !== artifact.size
      || manifest.artifact?.sha256 !== artifact.sha256) {
    throw new Error(`Lane A ${role} build manifest does not bind the exact artifact bytes.`);
  }
  if (!isStringRecord(manifest.toolchain) || Object.keys(manifest.toolchain).length < 5) {
    throw new Error(`Lane A ${role} build manifest lacks a complete toolchain declaration.`);
  }
  const build = manifest.build;
  if (build === null || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error(`Lane A ${role} build declaration is invalid.`);
  }
}

function verifyGitHubAttestation(path, bundle, trustedRoot, configuration) {
  execFileSync('gh', [
    'attestation', 'verify', path,
    '--repo', configuration.repository,
    '--bundle', bundle,
    '--custom-trusted-root', trustedRoot,
    '--signer-workflow', configuration.signerWorkflow,
    '--source-ref', configuration.sourceRef,
    '--source-digest', configuration.gitSha
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function readJsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or malformed.`);
  }
}

function isStringRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string' && entry.trim() !== '');
}

function stableJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function normalized(path) {
  return path.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase();
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', resolveHash);
  });
  return hash.digest('hex');
}

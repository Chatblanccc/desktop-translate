import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertExactBundleSubjects,
  assertIdentityDescriptionsUnchanged,
  assertInputsOutsideWorkspace,
  assertOutputDisjoint,
  describeRegularFile,
  validateAttestedBuildManifests
} from './phase5-lane-a-identity.mjs';

const GIT_SHA = 'a'.repeat(40);
const LOCK_SHA = 'b'.repeat(64);
const TEST_SHA = 'c'.repeat(64);
const RELEASE_SHA = 'd'.repeat(64);
const configuration = Object.freeze({
  gitSha: GIT_SHA,
  repository: 'owner/repository',
  sourceRef: 'refs/heads/main',
  buildDifferenceId: 'FAKE-INJECTION-EXCLUDED-V1'
});
const workspace = Object.freeze({ gitSha: GIT_SHA, lockfileSha256: LOCK_SHA, dirty: false });
const descriptions = Object.freeze({
  testArtifact: { name: 'test.exe', size: 10, sha256: TEST_SHA },
  releaseArtifact: { name: 'release.exe', size: 20, sha256: RELEASE_SHA }
});
const toolchain = Object.freeze({
  osImage: 'windows-2022',
  architecture: 'x64',
  node: '22.23.1',
  pnpm: '10.32.1',
  electron: '43.1.1'
});

function manifest(role, artifact, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactRole: role,
    source: {
      repository: configuration.repository,
      ref: configuration.sourceRef,
      gitSha: GIT_SHA,
      lockfileSha256: LOCK_SHA,
      developmentDirty: false,
      ...overrides.source
    },
    artifact: { ...artifact, ...overrides.artifact },
    toolchain: { ...toolchain, ...overrides.toolchain },
    build: {
      productionFlavor: true,
      testHooksEnabled: role === 'release-equivalent-test',
      fakeInjectionEnabled: role === 'release-equivalent-test',
      buildDifferenceId: configuration.buildDifferenceId,
      ...overrides.build
    }
  };
}

function validate(testManifest, releaseManifest) {
  validateAttestedBuildManifests({
    configuration,
    workspace,
    descriptions,
    testManifest,
    releaseManifest
  });
}

test('attested build manifests bind source, exact bytes, toolchain, and the reviewed delta', () => {
  assert.doesNotThrow(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact),
    manifest('public-release', descriptions.releaseArtifact)
  ));
  assert.throws(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact, { source: { gitSha: 'e'.repeat(40) } }),
    manifest('public-release', descriptions.releaseArtifact)
  ), /source binding/u);
  assert.throws(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact, { artifact: { sha256: 'f'.repeat(64) } }),
    manifest('public-release', descriptions.releaseArtifact)
  ), /exact artifact bytes/u);
  assert.throws(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact),
    manifest('public-release', descriptions.releaseArtifact, { toolchain: { electron: 'different' } })
  ), /same declared toolchain/u);
  assert.throws(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact),
    manifest('public-release', descriptions.releaseArtifact, { build: { buildDifferenceId: 'OTHER-DIFFERENCE' } })
  ), /difference identifier/u);
  assert.throws(() => validate(
    manifest('release-equivalent-test', descriptions.testArtifact),
    manifest('public-release', descriptions.releaseArtifact, { build: { testHooksEnabled: true } })
  ), /exclude fake injection and test hooks/u);
});

test('attestation subject sets are exact, unique, and SLSA provenance v1', () => {
  const expected = [TEST_SHA, RELEASE_SHA];
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: expected.map((sha256, index) => ({ name: `artifact-${index}`, digest: { sha256 } }))
  };
  const bundle = { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } };
  assert.doesNotThrow(() => assertExactBundleSubjects(bundle, expected));
  assert.throws(() => assertExactBundleSubjects(bundle, [TEST_SHA]), /exact artifact\/manifest byte set/u);
  statement.subject = [statement.subject[0], statement.subject[0]];
  const duplicate = { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } };
  assert.throws(() => assertExactBundleSubjects(duplicate, [TEST_SHA, TEST_SHA]), /exact artifact\/manifest byte set/u);
});

test('output and independently acquired input path boundaries fail closed', () => {
  assert.throws(
    () => assertOutputDisjoint('D:/evidence', ['D:/evidence/events.jsonl']),
    /cannot be inside/u
  );
  assert.throws(
    () => assertInputsOutsideWorkspace('D:/checkout', ['D:/checkout/download/artifact.exe']),
    /outside the checkout/u
  );
  assert.doesNotThrow(() => assertOutputDisjoint('D:/evidence', ['D:/downloads/artifact.exe']));
});

test('regular-file and runtime mutation checks reject links, directories, and changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase5-lane-a-identity-test-'));
  try {
    const artifact = join(root, 'artifact.bin');
    await writeFile(artifact, 'first', 'utf8');
    const before = { artifact: await describeRegularFile(artifact) };
    await writeFile(artifact, 'second', 'utf8');
    const after = { artifact: await describeRegularFile(artifact) };
    assert.throws(() => assertIdentityDescriptionsUnchanged(after, before), /changed during the schedule/u);

    const directory = join(root, 'directory');
    await mkdir(directory);
    await assert.rejects(() => describeRegularFile(directory), /not a regular file/u);
    const junction = join(root, 'junction');
    await symlink(directory, junction, 'junction');
    await assert.rejects(() => describeRegularFile(junction), /linked, or not a regular file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

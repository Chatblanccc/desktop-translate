import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  CORE_PACK_MANIFEST_SCHEMA_VERSION,
  CORE_PACK_PREPARATION_SCHEMA_VERSION,
  createBergamotCorePackPlan,
  createCorePackSizingPreparation,
  loadCandidateGenerationSet,
  parseTarArchive,
  verifyBaseInstallerPackage,
  writeDeterministicTarGzip
} from './bergamot-core-pack-lib.mjs';
import {
  DEFAULT_ARTIFACT_ROOT,
  POC_RESEARCH_SCOPE,
  canonicalJson,
  sha256Text
} from './lib.mjs';

const sandbox = await mkdtemp(resolve(
  DEFAULT_ARTIFACT_ROOT,
  'core-pack-selftest-'
));
try {
  const supplyRoot = resolve(sandbox, 'supply');
  await mkdir(resolve(supplyRoot, 'models', 'en-zh'), {
    recursive: true
  });
  await mkdir(resolve(supplyRoot, 'models', 'zh-en'), {
    recursive: true
  });
  await mkdir(resolve(supplyRoot, 'licenses'), { recursive: true });
  const payloads = {
    en: Buffer.from('synthetic-en-zh-model-payload\n'.repeat(200), 'utf8'),
    zh: Buffer.from('synthetic-zh-en-model-payload\n'.repeat(200), 'utf8'),
    license: Buffer.from('synthetic license evidence\n'.repeat(20), 'utf8')
  };
  await writeFile(
    resolve(supplyRoot, 'models', 'en-zh', 'model.en-zh.bin.gz'),
    payloads.en
  );
  await writeFile(
    resolve(supplyRoot, 'models', 'zh-en', 'model.zh-en.bin.gz'),
    payloads.zh
  );
  await writeFile(
    resolve(supplyRoot, 'licenses', 'model-license.txt'),
    payloads.license
  );
  const candidates = [
    createCandidate({
      id: 'synthetic-bergamot-en-zh',
      direction: 'en-zh',
      localPath: 'models/en-zh/model.en-zh.bin.gz',
      payload: payloads.en
    }),
    createCandidate({
      id: 'synthetic-bergamot-zh-en',
      direction: 'zh-en',
      localPath: 'models/zh-en/model.zh-en.bin.gz',
      payload: payloads.zh
    })
  ];
  const manifest = {
    schemaVersion: 'phase7-bergamot-poc-candidates-v1',
    runtime: {
      id: 'synthetic-bergamot-runtime',
      version: '0.0.0-selftest'
    },
    licenseEvidence: [{
      id: 'synthetic-model-license',
      localPath: 'licenses/model-license.txt',
      size: payloads.license.length,
      sha256: sha(payloads.license)
    }],
    candidates
  };
  const authorizationRaw = Buffer.from(
    '{"authorizationRecordId":"synthetic-core-pack-selftest"}\n',
    'utf8'
  );
  const modelTreeByCandidate = new Map([
    [candidates[0].id, '1'.repeat(64)],
    [candidates[1].id, '2'.repeat(64)]
  ]);
  const generationPaths = [];
  for (const candidate of candidates) {
    const direction =
      `${candidate.route.source}-${candidate.route.target}`;
    const generation = createGeneration({
      candidate,
      direction,
      manifestSha256: sha256Text(canonicalJson(manifest)),
      authorizationSha256: sha(authorizationRaw),
      modelTreeSha256: modelTreeByCandidate.get(candidate.id)
    });
    const path = resolve(sandbox, `generation-${direction}.json`);
    await writeFile(path, `${JSON.stringify(generation, null, 2)}\n`);
    generationPaths.push(path);
  }

  const generationSet = await loadCandidateGenerationSet({
    paths: generationPaths,
    manifest,
    candidates,
    authorizationRaw,
    authorizationRecordId: 'synthetic-core-pack-selftest',
    modelTreeByCandidate
  });
  assert.match(generationSet.bindingSetSha256, /^[a-f0-9]{64}$/u);
  const plan = await createBergamotCorePackPlan({
    manifest,
    candidates,
    generationSet,
    supplyRoot
  });
  assert.equal(
    plan.packManifest.schemaVersion,
    CORE_PACK_MANIFEST_SCHEMA_VERSION
  );
  assert.equal(plan.packManifest.containsExecutableCode, false);
  assert.equal(plan.packManifest.runtime.included, false);

  const first = await writeDeterministicTarGzip({
    entries: plan.entries,
    outputPath: resolve(sandbox, 'core-pack-first.tar.gz')
  });
  const second = await writeDeterministicTarGzip({
    entries: plan.entries,
    outputPath: resolve(sandbox, 'core-pack-second.tar.gz')
  });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sizeBytes, second.sizeBytes);
  const archiveEntries = parseTarArchive(gunzipSync(
    await readFile(first.path)
  ));
  assert.deepEqual(
    archiveEntries.map((entry) => entry.path),
    plan.entries.map((entry) => entry.archivePath)
  );
  assert.equal(
    archiveEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    plan.installedSizeBytes
  );
  assert.ok(first.sizeBytes < plan.installedSizeBytes);

  const baseFixture = await createBasePackageFixture(sandbox);
  const verifiedBase = await verifyBaseInstallerPackage({
    installerPath: baseFixture.installerPath,
    unpackedPath: baseFixture.unpackedPath,
    evidenceRoot: baseFixture.evidenceRoot,
    modelPins: [{
      localPath: 'models/synthetic-model.bin.gz',
      sha256: '0'.repeat(64)
    }]
  });
  assert.equal(verifiedBase.containsModel, false);
  const modelPath = resolve(
    baseFixture.unpackedPath,
    'models',
    'synthetic-model.bin.gz'
  );
  await mkdir(resolve(modelPath, '..'), { recursive: true });
  const disguisedModel = Buffer.from('disguised model payload', 'utf8');
  await writeFile(modelPath, disguisedModel);
  await writeFile(
    resolve(
      baseFixture.evidenceRoot,
      'package',
      'file-manifest.sha256'
    ),
    [
      `${sha(baseFixture.appBytes)}  app.exe`,
      `${sha(disguisedModel)}  models/synthetic-model.bin.gz`,
      ''
    ].join('\n')
  );
  await assert.rejects(
    verifyBaseInstallerPackage({
      installerPath: baseFixture.installerPath,
      unpackedPath: baseFixture.unpackedPath,
      evidenceRoot: baseFixture.evidenceRoot,
      modelPins: [{
        localPath: 'models/synthetic-model.bin.gz',
        sha256: '0'.repeat(64)
      }]
    }),
    /CORE_PACK_BASE_CONTAINS_MODEL_OR_HASH_MISMATCH/u
  );

  const receipt = createCorePackSizingPreparation({
    baseInstaller: {
      sha256: '3'.repeat(64),
      sizeBytes: 100_000_000,
      containsModel: false,
      installedSizeBytes: 200_000_000,
      evidence: {
        binaryManifestSha256: '4'.repeat(64),
        sizeManifestSha256: '5'.repeat(64),
        releaseEvidenceManifestSha256: '6'.repeat(64),
        fileManifestSha256: '7'.repeat(64),
        unpackedFileCount: 10
      }
    },
    archive: first,
    plan,
    generationSet,
    measuredAt: '2026-07-25T00:00:00.000Z'
  });
  assert.equal(
    receipt.schemaVersion,
    CORE_PACK_PREPARATION_SCHEMA_VERSION
  );
  assert.equal(
    receipt.status,
    'PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET'
  );
  assert.equal(
    receipt.finalization.finalGateAPackageSizingStatus,
    'NOT_CREATED'
  );
  assert.equal(receipt.integrationOrDistributionAuthorized, false);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /[A-Z]:\\|\\\\Users\\\\|"source":|"translation":/u
  );

  await assert.rejects(
    writeDeterministicTarGzip({
      entries: [{
        archivePath: 'bin/host.exe',
        data: Buffer.from('not executable', 'utf8'),
        sizeBytes: 14,
        sha256: sha(Buffer.from('not executable', 'utf8'))
      }],
      outputPath: resolve(sandbox, 'rejected-executable.tar.gz')
    }),
    /CORE_PACK_NON_DATA_ARCHIVE_PATH_REJECTED/u
  );
  await assert.rejects(
    writeDeterministicTarGzip({
      entries: [
        plan.entries[0],
        { ...plan.entries[0] }
      ],
      outputPath: resolve(sandbox, 'rejected-duplicate.tar.gz')
    }),
    /CORE_PACK_DUPLICATE_ARCHIVE_PATH/u
  );
  const tampered = JSON.parse(
    await readFile(generationPaths[0], 'utf8')
  );
  tampered.identity.model.treeSha256 = 'f'.repeat(64);
  const tamperedPath = resolve(sandbox, 'generation-tampered.json');
  await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    loadCandidateGenerationSet({
      paths: [tamperedPath, generationPaths[1]],
      manifest,
      candidates,
      authorizationRaw,
      authorizationRecordId: 'synthetic-core-pack-selftest',
      modelTreeByCandidate
    }),
    /CORE_PACK_GENERATION_IDENTITY_INVALID/u
  );

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'phase7-bergamot-core-pack-selftest-v1',
    status: 'SELF_TEST_PASS',
    deterministicArchive: true,
    postWriteEntryHashVerification: true,
    dataOnlyArchive: true,
    executablePathRejected: true,
    duplicatePathRejected: true,
    generationTamperRejected: true,
    basePackageModelPayloadRejected: true,
    primaryEvidenceSetFabricated: false,
    integrationOrDistributionAuthorized: false
  }, null, 2)}\n`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

function createCandidate({ id, direction, localPath, payload }) {
  const [source, target] = direction.split('-');
  return {
    id,
    repository: 'synthetic/selftest',
    revision: 'a'.repeat(40),
    route: { source, target },
    license: {
      expression: 'NOASSERTION',
      status: 'LEGAL_REVIEW_REQUIRED',
      observedRepositoryExpression: 'MPL-2.0',
      commercialUseConclusion: 'NOT_ESTABLISHED',
      evidenceId: 'synthetic-model-license'
    },
    sourceFiles: [{
      localPath,
      size: payload.length,
      sha256: sha(payload),
      runtimePart: 'model',
      compression: 'gzip'
    }]
  };
}

async function createBasePackageFixture(root) {
  const installerPath = resolve(root, 'base', 'setup.exe');
  const unpackedPath = resolve(root, 'base', 'win-unpacked');
  const evidenceRoot = resolve(root, 'base', 'evidence');
  await mkdir(unpackedPath, { recursive: true });
  await mkdir(resolve(evidenceRoot, 'package'), { recursive: true });
  await mkdir(resolve(evidenceRoot, 'release'), { recursive: true });
  const installerBytes = Buffer.from(
    'synthetic base installer without model',
    'utf8'
  );
  const appBytes = Buffer.from('synthetic application', 'utf8');
  await mkdir(resolve(installerPath, '..'), { recursive: true });
  await writeFile(installerPath, installerBytes);
  await writeFile(resolve(unpackedPath, 'app.exe'), appBytes);
  const installerIdentity = {
    size: installerBytes.length,
    sha256: sha(installerBytes)
  };
  await writeFile(
    resolve(evidenceRoot, 'binary-manifest.json'),
    `${JSON.stringify({
      artifacts: [{
        role: 'installer',
        ...installerIdentity
      }],
      binaries: {
        installer: { ...installerIdentity }
      }
    }, null, 2)}\n`
  );
  await writeFile(
    resolve(evidenceRoot, 'package', 'size-manifest.json'),
    `${JSON.stringify({
      installed: { bytes: appBytes.length },
      installer: {
        bytes: installerBytes.length,
        mebibytes: 0.001,
        limitMebibytes: 150
      }
    }, null, 2)}\n`
  );
  await writeFile(
    resolve(evidenceRoot, 'release', 'evidence-manifest.json'),
    `${JSON.stringify({
      package: {
        status: 'PASS',
        installer: { ...installerIdentity }
      }
    }, null, 2)}\n`
  );
  await writeFile(
    resolve(evidenceRoot, 'package', 'file-manifest.sha256'),
    `${sha(appBytes)}  app.exe\n`
  );
  return {
    installerPath,
    unpackedPath,
    evidenceRoot,
    appBytes
  };
}

function createGeneration({
  candidate,
  direction,
  manifestSha256,
  authorizationSha256,
  modelTreeSha256
}) {
  const identity = {
    schemaVersion:
      'phase7-gate-a-candidate-generation-identity-v1',
    direction,
    candidateId: candidate.id,
    generationRunId: `generation-${direction}-selftest`,
    manifestSha256,
    authorizationSha256,
    authorizationRecordId: 'synthetic-core-pack-selftest',
    model: { treeSha256: modelTreeSha256 },
    runtime: {
      materializedTreeSha256: '8'.repeat(64),
      servedTreeSha256: '9'.repeat(64)
    },
    sourceSet: {
      schemaVersion: 'phase7-gate-a-source-set-v1',
      recordCount: 200,
      identitySha256: 'b'.repeat(64)
    },
    workloadIdentitySha256: 'c'.repeat(64)
  };
  return {
    schemaVersion: 'phase7-gate-a-candidate-generation-v1',
    status: 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE',
    scope: POC_RESEARCH_SCOPE,
    identity,
    identitySha256: sha256Text(canonicalJson(identity)),
    candidateOutput: {
      artifactSha256: 'd'.repeat(64),
      recordCount: 200,
      itemIdentitySetSha256: 'e'.repeat(64),
      rawTextEmittedInEvidence: false
    },
    privacy: {
      sourceTextInEvidence: false,
      translationTextInEvidence: false,
      absolutePathsInEvidence: false,
      usernamesInEvidence: false
    },
    gateA: {
      ready: false,
      integrationOrDistributionAuthorized: false
    }
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  DEFAULT_ARGOS_MANIFEST_PATH,
  DEFAULT_ARGOS_MATERIALIZED_ROOT,
  argosManifestSha256,
  createPendingArgosAuthorization,
  deriveArgosArchiveTreePin,
  inspectArgosZip,
  isAllowedArgosDownloadUrl,
  loadAndVerifyArgosMaterialization,
  loadExactArgosAuthorization,
  loadArgosManifest,
  materializeArgosArchive,
  selectArgosCandidates,
  validateArgosManifest,
  verifyArgosAuthorization
} from './argos-lib.mjs';
import {
  buildArgosPreparationPlan,
  parseArgosPrepareArguments
} from './argos-prepare.mjs';
import {
  DEFAULT_ARTIFACT_ROOT,
  PocError,
  canonicalJson
} from './lib.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = resolve(import.meta.dirname);
const schemaRoot = resolve(scriptRoot, 'schemas');
const CRC_TABLE = buildCrcTable();
const manifest = await loadArgosManifest();
const candidates = selectArgosCandidates(manifest);

assert.equal(manifest.policy.defaultNetworkAccess, false);
assert.equal(manifest.policy.globalPackageInstallationAllowed, false);
assert.equal(manifest.policy.automaticPackageInstallationAllowed, false);
assert.equal(manifest.policy.productIntegrationAllowed, false);
assert.equal(manifest.policy.modelDistributionAllowed, false);
assert.equal(
  manifest.policy.rawSourceOrTranslationTextInReportsAllowed,
  false
);
assert.equal(
  manifest.policy.privateBlindEvaluationCandidateOutputAllowed,
  true
);
assert.equal(manifest.gateA.status, 'BLOCKED');
assert.ok(
  manifest.candidates.every(
    (candidate) => candidate.license.expression === 'NOASSERTION'
      && candidate.license.status === 'LEGAL_REVIEW_REQUIRED'
      && candidate.license.commercialUseConclusion
        === 'LEGAL_REVIEW_REQUIRED'
      && candidate.license.packageReadmeObservation.observedExpression
        === 'CC-BY-4.0'
      && candidate.license.packageReadmeObservation.coverageStatus
        === 'LEGAL_REVIEW_REQUIRED'
  )
);

const plan = buildArgosPreparationPlan(manifest, candidates);
assert.equal(plan.totalBytes, 190_391_335);
assert.equal(plan.fileCount, 8);
assert.equal(plan.archiveUnpackedBytes, 171_778_261);
assert.equal(plan.network.activity, 'NOT_REQUESTED');
assert.equal(plan.modelExecution, 'NOT_RUN');
assert.equal(plan.gateAStatus, 'BLOCKED');

const pending = createPendingArgosAuthorization(
  manifest,
  candidates.map((candidate) => candidate.id)
);
assert.equal(pending.authorization, 'PENDING');
assert.equal(pending.manifestSha256, argosManifestSha256(manifest));
const authorized = {
  ...pending,
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  authorizationRecordId: 'argos-static-selftest',
  authorizedAt: '2026-07-23T00:00:00.000Z'
};
assert.doesNotThrow(() => verifyArgosAuthorization(
  authorized,
  manifest,
  candidates.map((candidate) => candidate.id)
));
assert.throws(
  () => verifyArgosAuthorization(
    { ...authorized, manifestSha256: '0'.repeat(64) },
    manifest,
    candidates.map((candidate) => candidate.id)
  ),
  (error) => error instanceof PocError
    && error.code === 'ARGOS_POC_AUTHORIZATION_INVALID_OR_STALE'
);
for (const unsafeRecordId of [
  'aa',
  'a'.repeat(129),
  ' leading-space',
  'C:\\Users\\name',
  '../authorization',
  'x@y.example',
  '授权-selftest'
]) {
  assert.throws(
    () => verifyArgosAuthorization(
      { ...authorized, authorizationRecordId: unsafeRecordId },
      manifest,
      candidates.map((candidate) => candidate.id)
    ),
    (error) => error instanceof PocError
      && error.code === 'ARGOS_POC_AUTHORIZATION_INVALID_OR_STALE'
  );
}

assert.equal(parseArgosPrepareArguments([]).allowNetwork, false);
assert.equal(parseArgosPrepareArguments([]).download, false);
assert.throws(
  () => parseArgosPrepareArguments(['--allow-network']),
  (error) => error instanceof PocError
    && error.code === 'ARGOS_ALLOW_NETWORK_REQUIRES_DOWNLOAD_ACTION'
);
assert.throws(
  () => parseArgosPrepareArguments(['--download', '--materialize']),
  (error) => error instanceof PocError
    && error.code === 'ARGOS_PREPARE_ACTIONS_MUTUALLY_EXCLUSIVE'
);
assert.throws(
  () => parseArgosPrepareArguments(['--materialize']),
  (error) => error instanceof PocError
    && error.code
      === 'ARGOS_MATERIALIZATION_REQUIRES_EXACTLY_ONE_CANDIDATE'
);
assert.equal(
  isAllowedArgosDownloadUrl(
    'https://argos-net.com/v1/translate-en_zh-1_9.argosmodel'
  ),
  true
);
assert.equal(
  isAllowedArgosDownloadUrl(
    'https://files.pythonhosted.org/packages/a/model.whl'
  ),
  true
);
assert.equal(
  isAllowedArgosDownloadUrl(
    'https://www.python.org/ftp/python/3.13.10/'
      + 'python-3.13.10-embed-amd64.zip'
  ),
  true
);
for (const rejected of [
  'http://argos-net.com/v1/model.argosmodel',
  'https://user:secret@argos-net.com/v1/model.argosmodel',
  'https://argos-net.com.example.invalid/v1/model.argosmodel',
  'https://example.invalid/model.argosmodel'
]) {
  assert.equal(isAllowedArgosDownloadUrl(rejected), false);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemaNames = [
  'argos-candidate-manifest.schema.json',
  'argos-generation-input.schema.json',
  'argos-generation-output.schema.json',
  'argos-direct-poc-report.schema.json',
  'poc-authorization.schema.json'
];
const schemas = new Map();
for (const name of schemaNames) {
  const schema = JSON.parse(await readFile(resolve(schemaRoot, name), 'utf8'));
  schemas.set(name, schema);
  ajv.compile(schema);
}
const validateManifestSchema = ajv.compile(
  schemas.get('argos-candidate-manifest.schema.json')
);
assert.equal(
  validateManifestSchema(manifest),
  true,
  JSON.stringify(validateManifestSchema.errors)
);
const validateAuthorization = ajv.compile(
  schemas.get('poc-authorization.schema.json')
);
assert.equal(
  validateAuthorization(authorized),
  true,
  JSON.stringify(validateAuthorization.errors)
);
const generationInputFixture = {
  schemaVersion: 'phase7-argos-generation-input-item-v1',
  itemId: 'schema-selftest-en-001',
  direction: 'en-zh',
  source: 'A public synthetic schema test.',
  contentDeclaration: 'NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS',
  containsPersonalData: false,
  usageAuthorization: 'AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION'
};
const generationOutputFixture = {
  schemaVersion: 'phase7-argos-blind-eval-candidate-output-v1',
  itemId: generationInputFixture.itemId,
  direction: generationInputFixture.direction,
  candidateId: 'argos-opus-en-zh-1.9',
  generationRunId: 'schema-selftest-generation',
  sourceSha256: sha256(Buffer.from(generationInputFixture.source, 'utf8')),
  translation: 'Synthetic candidate output.'
};
const sanitizedReportFixture = {
  schemaVersion: 'phase7-argos-direct-poc-report-v1',
  status: 'ARGOS_BLIND_EVAL_CANDIDATE_GENERATION_COMPLETE',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  manifestSha256: argosManifestSha256(manifest),
  candidateId: generationOutputFixture.candidateId,
  generationRunId: generationOutputFixture.generationRunId,
  authorizationRecordId: 'schema-selftest-authorization',
  authorizationSha256: '4'.repeat(64),
  materializedTreeSha256: '1'.repeat(64),
  runtime: {
    python: '3.13.10',
    ctranslate2: '4.8.1',
    sentencepiece: '0.2.1',
    isolatedEnvironment: true,
    runtimeIdentityVerified: true,
    runtimeSupplySetSha256: '5'.repeat(64),
    executionTreeSha256: '6'.repeat(64),
    builderScriptSha256: '7'.repeat(64),
    globalSitePackagesUsed: false
  },
  translationOptions: {
    beamSize: 4,
    replaceUnknowns: true,
    lengthPenalty: 0.2,
    device: 'cpu'
  },
  input: {
    mode: 'CONTROLLED_BLIND_EVAL_BATCH',
    recordCount: 1,
    sha256: '2'.repeat(64),
    rawTextEmitted: false
  },
  output: {
    recordCount: 1,
    aggregateCharacterCount: generationOutputFixture.translation.length,
    aggregateSha256: '3'.repeat(64),
    candidateOutputArtifactCreated: true,
    candidateOutputArtifactContainsTranslationText: true,
    stdoutContainsTranslationText: false
  },
  privacy: {
    sourceTextInReport: false,
    translationTextInReport: false,
    absolutePathsInReport: false,
    usernamesInReport: false,
    logsContainRawText: false,
    runtimeStdoutCaptured: true,
    runtimeStderrCaptured: true,
    runtimeStdoutBytes: 0,
    runtimeStderrBytes: 0,
    runtimeDiagnosticBytesPublished: 0,
    runtimeDiagnosticRawTextPublished: false,
    captureScope: 'PROCESS_STANDARD_HANDLES_ONLY'
  },
  networkIsolation: {
    processSocketGuardInstalled: true,
    externalNetworkAccess: 'NOT_OS_LEVEL_VERIFIED'
  },
  gateA: {
    ready: false,
    status: 'BLOCKED_INCOMPLETE_M4_EVIDENCE',
    productIntegrationAuthorized: false,
    distributionAuthorized: false
  }
};
for (const [schemaName, fixture] of [
  ['argos-generation-input.schema.json', generationInputFixture],
  ['argos-generation-output.schema.json', generationOutputFixture],
  ['argos-direct-poc-report.schema.json', sanitizedReportFixture]
]) {
  const validate = ajv.compile(schemas.get(schemaName));
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
}
assert.ok(
  !JSON.stringify(sanitizedReportFixture).includes(
    generationInputFixture.source
  )
);
assert.ok(
  !JSON.stringify(sanitizedReportFixture).includes(
    generationOutputFixture.translation
  )
);

const mutatedLicense = structuredClone(manifest);
mutatedLicense.candidates[0].license.expression = 'CC-BY-4.0';
assert.ok(
  validateArgosManifest(mutatedLicense).some(
    (error) => error.startsWith(
      'ARGOS_MODEL_LICENSE_MUST_REMAIN_UNRESOLVED'
    )
  )
);
const mutatedDigest = structuredClone(manifest);
mutatedDigest.candidates[0].archive.sha256 = '0'.repeat(64);
assert.ok(
  validateArgosManifest(mutatedDigest).some(
    (error) => error.startsWith('ARGOS_ARCHIVE_PIN_INVALID')
  )
);

const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'phase7-argos-selftest-'));
const argosArtifactRoot = resolve(DEFAULT_ARTIFACT_ROOT, 'argos');
const argosArtifactRootExisted = await pathExists(argosArtifactRoot);
const materializedRootExisted = await pathExists(
  DEFAULT_ARGOS_MATERIALIZED_ROOT
);
const syntheticCandidateId = `selftest-argos-safe-zip-${randomUUID()}`;
const authorizationTestPath = resolve(
  DEFAULT_ARTIFACT_ROOT,
  `.argos-selftest-authorization-${randomUUID()}.json`
);
const duplicateAuthorizationTestPath = resolve(
  DEFAULT_ARTIFACT_ROOT,
  `.argos-selftest-duplicate-authorization-${randomUUID()}.json`
);
const materializedTestPath = resolve(
  DEFAULT_ARGOS_MATERIALIZED_ROOT,
  syntheticCandidateId
);
try {
  const validFixture = buildSyntheticArgosZip({
    root: 'translate-en_zh-1_9/',
    dataDescriptor: true
  });
  const validArchive = resolve(temporaryRoot, 'valid.argosmodel');
  await writeFile(validArchive, validFixture.bytes, { flag: 'wx' });
  const syntheticManifest = structuredClone(manifest);
  const syntheticCandidate = syntheticArgosCandidate(
    validFixture,
    syntheticCandidateId
  );
  syntheticManifest.candidates = [syntheticCandidate];
  const syntheticAuthorizationContext = {
    scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    authorizationRecordId: 'argos-materialization-selftest',
    authorizationSha256: '3'.repeat(64),
    candidateIds: [syntheticCandidateId],
    manifestSha256: argosManifestSha256(syntheticManifest)
  };
  const inspection = await inspectArgosZip(
    validArchive,
    syntheticCandidate
  );
  assert.equal(inspection.centralDirectoryEntryCount, 13);
  assert.ok(inspection.dataDescriptorEntryCount > 0);
  assert.equal(
    inspection.unpackedBytes,
    validFixture.unpackedSize
  );
  const derivedTreePin = await deriveArgosArchiveTreePin(
    validArchive,
    syntheticCandidate,
    syntheticManifest
  );

  const materialized = await materializeArgosArchive({
    archivePath: validArchive,
    candidate: syntheticCandidate,
    manifest: syntheticManifest,
    authorizationContext: syntheticAuthorizationContext,
    targetRoot: DEFAULT_ARGOS_MATERIALIZED_ROOT
  });
  assert.equal(materialized.status, 'ARGOS_RESEARCH_PACKAGE_MATERIALIZED');
  assert.equal(materialized.rawTextEmitted, false);
  assert.equal(materialized.treeSha256, derivedTreePin.treeSha256);
  const verifiedTree = await loadAndVerifyArgosMaterialization(
    materializedTestPath,
    syntheticManifest,
    syntheticCandidate,
    syntheticAuthorizationContext
  );
  assert.equal(verifiedTree.treeSha256, materialized.treeSha256);
  const pythonTreeVerification = await execFileAsync(
    'python',
    [
      '-B',
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'spec = importlib.util.spec_from_file_location("argos_direct_poc", sys.argv[1])',
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'candidate = json.loads(sys.argv[4])',
        'print(module.verify_materialized_tree(pathlib.Path(sys.argv[2]), sys.argv[3], candidate, sys.argv[5], sys.argv[6]))'
      ].join('; '),
      resolve(scriptRoot, 'argos-direct-poc.py'),
      materializedTestPath,
      argosManifestSha256(syntheticManifest),
      JSON.stringify(syntheticCandidate),
      syntheticAuthorizationContext.authorizationRecordId,
      syntheticAuthorizationContext.authorizationSha256
    ],
    { maxBuffer: 1024 * 1024 }
  );
  assert.equal(
    pythonTreeVerification.stdout.trim(),
    materialized.treeSha256
  );
  const receiptPath = resolve(
    materializedTestPath,
    '.argos-materialization-receipt.json'
  );
  const rewrittenReceipt = JSON.parse(
    await readFile(receiptPath, 'utf8')
  );
  const rewrittenRecord = rewrittenReceipt.extraction.files.find(
    (record) => record.path === 'metadata.json'
  ) ?? rewrittenReceipt.extraction.files[0];
  const tamperedModelPath = resolve(
    materializedTestPath,
    ...rewrittenRecord.path.split('/')
  );
  const tamperedModelBytes = Buffer.concat([
    await readFile(tamperedModelPath),
    Buffer.from([0x20])
  ]);
  await writeFile(tamperedModelPath, tamperedModelBytes);
  rewrittenReceipt.extraction.totalBytes += 1;
  rewrittenRecord.size = tamperedModelBytes.length;
  rewrittenRecord.sha256 = sha256(tamperedModelBytes);
  rewrittenReceipt.extraction.treeSha256 = sha256(
    canonicalJson(rewrittenReceipt.extraction.files)
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(rewrittenReceipt, null, 2)}\n`
  );
  await assert.rejects(
    () => loadAndVerifyArgosMaterialization(
      materializedTestPath,
      syntheticManifest,
      syntheticCandidate,
      syntheticAuthorizationContext
    ),
    (error) => error instanceof PocError
      && error.code === 'ARGOS_MATERIALIZATION_RECEIPT_INVALID_OR_STALE'
  );
  const pythonRewrittenReceiptVerification = await execFileAsync(
    'python',
    [
      '-B',
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'spec = importlib.util.spec_from_file_location("argos_direct_poc", sys.argv[1])',
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'candidate = json.loads(sys.argv[4])',
        'try:',
        '    module.verify_materialized_tree(pathlib.Path(sys.argv[2]), sys.argv[3], candidate, sys.argv[5], sys.argv[6])',
        'except module.ArgosPocFailure as error:',
        '    print(error.code)',
        'else:',
        '    print("UNEXPECTED_PASS")'
      ].join('\n'),
      resolve(scriptRoot, 'argos-direct-poc.py'),
      materializedTestPath,
      argosManifestSha256(syntheticManifest),
      JSON.stringify(syntheticCandidate),
      syntheticAuthorizationContext.authorizationRecordId,
      syntheticAuthorizationContext.authorizationSha256
    ],
    { maxBuffer: 1024 * 1024 }
  );
  assert.equal(
    pythonRewrittenReceiptVerification.stdout.trim(),
    'ARGOS_MATERIALIZATION_RECEIPT_INVALID_OR_STALE'
  );
  const pendingSingleAuthorization = createPendingArgosAuthorization(
    manifest,
    ['argos-opus-en-zh-1.9']
  );
  const authorizedSingle = {
    ...pendingSingleAuthorization,
    authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
    authorizationRecordId: 'argos-cross-runtime-selftest',
    authorizedAt: '2026-07-23T00:00:00.000Z'
  };
  const authorizationContent = `${JSON.stringify(
    authorizedSingle,
    null,
    2
  )}\n`;
  await writeFile(
    authorizationTestPath,
    authorizationContent,
    { encoding: 'utf8', flag: 'wx' }
  );
  const exactAuthorization = await loadExactArgosAuthorization(
    authorizationTestPath,
    manifest,
    ['argos-opus-en-zh-1.9']
  );
  assert.equal(
    exactAuthorization.authorizationSha256,
    sha256(Buffer.from(authorizationContent, 'utf8'))
  );
  const duplicateAuthorizationContent = authorizationContent.replace(
    '"authorization":',
    '"authorization":"REVOKED","authorization":'
  );
  await writeFile(
    duplicateAuthorizationTestPath,
    duplicateAuthorizationContent,
    { encoding: 'utf8', flag: 'wx' }
  );
  await assert.rejects(
    () => loadExactArgosAuthorization(
      duplicateAuthorizationTestPath,
      manifest,
      ['argos-opus-en-zh-1.9']
    ),
    (error) => error instanceof PocError
      && error.code === 'ARGOS_POC_AUTHORIZATION_DUPLICATE_JSON_KEY'
  );
  const pythonAuthorizationVerification = await execFileAsync(
    'python',
    [
      '-B',
      '-c',
      [
        'import importlib.util, pathlib, sys',
        'spec = importlib.util.spec_from_file_location("argos_direct_poc", sys.argv[1])',
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'manifest, manifest_sha = module.load_manifest()',
        'result = module.verify_authorization(pathlib.Path(sys.argv[2]), manifest, manifest_sha, sys.argv[3])',
        'print(result[1])'
      ].join('; '),
      resolve(scriptRoot, 'argos-direct-poc.py'),
      authorizationTestPath,
      'argos-opus-en-zh-1.9'
    ],
    { maxBuffer: 1024 * 1024 }
  );
  assert.equal(
    pythonAuthorizationVerification.stdout.trim(),
    sha256(Buffer.from(authorizationContent, 'utf8'))
  );

  await expectZipFailure({
    temporaryRoot,
    name: 'traversal',
    fixture: buildSyntheticArgosZip({
      root: 'translate-en_zh-1_9/',
      dataDescriptor: false,
      mutateEntries(entries) {
        entries[9].name = 'translate-en_zh-1_9/stanza/../escape.bin';
      }
    }),
    expectedCode: 'ARGOS_ZIP_WINDOWS_PATH_REJECTED'
  });
  await expectZipFailure({
    temporaryRoot,
    name: 'encrypted',
    fixture: buildSyntheticArgosZip({
      root: 'translate-en_zh-1_9/',
      dataDescriptor: false,
      mutateEntries(entries) {
        entries[3].flags = 1;
      },
      additionalAllowedFlags: [1]
    }),
    expectedCode: 'ARGOS_ZIP_GENERAL_PURPOSE_FLAGS_REJECTED'
  });
  await expectZipFailure({
    temporaryRoot,
    name: 'symlink',
    fixture: buildSyntheticArgosZip({
      root: 'translate-en_zh-1_9/',
      dataDescriptor: false,
      mutateEntries(entries) {
        entries[3].unixMode = 0o120777;
      }
    }),
    expectedCode: 'ARGOS_ZIP_LINK_OR_SPECIAL_FILE_REJECTED'
  });
  await expectZipFailure({
    temporaryRoot,
    name: 'case-collision',
    fixture: buildSyntheticArgosZip({
      root: 'translate-en_zh-1_9/',
      dataDescriptor: false,
      mutateEntries(entries) {
        entries[4].name = 'translate-en_zh-1_9/METADATA.JSON';
      }
    }),
    expectedCode: 'ARGOS_ZIP_CASE_INSENSITIVE_PATH_COLLISION'
  });
  await expectZipFailure({
    temporaryRoot,
    name: 'compression-ratio',
    fixture: buildSyntheticArgosZip({
      root: 'translate-en_zh-1_9/',
      dataDescriptor: false,
      highlyCompressibleModel: true,
      maximumCompressionRatio: 2
    }),
    expectedCode: 'ARGOS_ZIP_COMPRESSION_RATIO_LIMIT_EXCEEDED'
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(authorizationTestPath, { force: true });
  await rm(duplicateAuthorizationTestPath, { force: true });
  await rm(materializedTestPath, { recursive: true, force: true });
  if (!materializedRootExisted) {
    await removeEmptySelfTestRoot(DEFAULT_ARGOS_MATERIALIZED_ROOT);
  }
  if (!argosArtifactRootExisted) {
    await removeEmptySelfTestRoot(argosArtifactRoot);
  }
}

const pythonSelfTest = await execFileAsync(
  'python',
  ['-B', resolve(scriptRoot, 'argos-direct-poc.py'), '--self-test'],
  { maxBuffer: 1024 * 1024 }
);
const pythonReport = JSON.parse(pythonSelfTest.stdout);
assert.equal(
  pythonReport.status,
  'ARGOS_DIRECT_POC_STATIC_SELF_TEST_PASS'
);
assert.equal(pythonReport.modelArchivesDownloaded, false);
assert.equal(pythonReport.runtimeImported, false);
assert.equal(pythonReport.modelExecuted, false);
assert.equal(pythonReport.candidateOutputArtifactCreated, false);
const sanitizedPythonArguments = await expectCliFailure(
  'python',
  [
    '-B',
    resolve(scriptRoot, 'argos-direct-poc.py'),
    '--batch-size',
    'PRIVATE_ARGUMENT_MUST_NOT_BE_ECHOED'
  ]
);
const sanitizedPythonFailure = JSON.parse(sanitizedPythonArguments.stderr);
assert.equal(sanitizedPythonFailure.errorCode, 'ARGOS_ARGUMENTS_INVALID');
assert.equal(
  sanitizedPythonArguments.stderr.includes(
    'PRIVATE_ARGUMENT_MUST_NOT_BE_ECHOED'
  ),
  false
);

const defaultCli = await execFileAsync(
  process.execPath,
  [resolve(scriptRoot, 'argos-prepare.mjs')],
  { maxBuffer: 1024 * 1024 }
);
const defaultPlan = JSON.parse(defaultCli.stdout);
assert.equal(defaultPlan.network.activity, 'NOT_REQUESTED');
assert.equal(defaultPlan.modelExecution, 'NOT_RUN');
const blockedDownload = await expectCliFailure(
  process.execPath,
  [resolve(scriptRoot, 'argos-prepare.mjs'), '--download']
);
assert.equal(
  JSON.parse(blockedDownload.stderr).errorCode,
  'NETWORK_OPERATION_REQUIRES_ALLOW_NETWORK'
);
const blockedAuthorizedNetwork = await expectCliFailure(
  process.execPath,
  [
    resolve(scriptRoot, 'argos-prepare.mjs'),
    '--download',
    '--allow-network'
  ]
);
assert.equal(
  JSON.parse(blockedAuthorizedNetwork.stderr).errorCode,
  'ARGOS_POC_AUTHORIZATION_REQUIRED_FOR_DOWNLOAD'
);
const blockedMaterialization = await expectCliFailure(
  process.execPath,
  [
    resolve(scriptRoot, 'argos-prepare.mjs'),
    '--materialize',
    '--candidate',
    'argos-opus-en-zh-1.9'
  ]
);
assert.equal(
  JSON.parse(blockedMaterialization.stderr).errorCode,
  'ARGOS_POC_AUTHORIZATION_REQUIRED_FOR_MATERIALIZATION'
);

process.stdout.write(`${JSON.stringify({
  status: 'ARGOS_STATIC_SCHEMA_AND_SAFETY_SELF_TEST_PASS',
  manifestSha256: argosManifestSha256(manifest),
  checks: [
    'canonical-manifest-and-schema',
    'license-conclusion-fails-closed',
    'research-authorization-binding',
    'default-zero-network-plan',
    'explicit-network-double-gate',
    'stream-download-host-allowlist',
    'zip-central-and-local-header-binding',
    'zip-data-descriptor-support',
    'zip-slip-and-windows-collision-rejection',
    'zip-link-and-compression-bomb-rejection',
    'crc-bound-atomic-materialization',
    'materialized-tree-verification',
    'node-to-python-materialized-tree-binding',
    'manifest-authoritative-after-model-and-receipt-rewrite',
    'node-to-python-authorization-and-manifest-binding',
    'direct-python-static-privacy',
    'blind-eval-candidate-generation-contract'
  ],
  networkActivity: 'NOT_PERFORMED',
  modelArchivesDownloaded: false,
  runtimeWheelsDownloaded: false,
  runtimeImported: false,
  modelExecuted: false,
  candidateOutputArtifactCreated: false
}, null, 2)}\n`);

function syntheticArgosCandidate(fixture, id) {
  return {
    id,
    archive: {
      filename: 'synthetic.argosmodel',
      localPath: 'packages/synthetic.argosmodel',
      size: fixture.bytes.length,
      sha256: sha256(fixture.bytes),
      unpackedSize: fixture.unpackedSize,
      extractedFileCount: fixture.extractedFileCount,
      extractedTreeSha256: fixture.extractedTreeSha256,
      centralDirectoryEntryCount: 13,
      packageRoot: 'translate-en_zh-1_9/',
      allowedGeneralPurposeFlags: fixture.allowedFlags,
      allowedCompressionMethods: [0, 8],
      maximumArchiveCompressionRatio: fixture.maximumCompressionRatio,
      maximumSingleExtractedFileBytes: 10_000_000,
      requiredFiles: [
        'metadata.json',
        'README.md',
        'sentencepiece.model',
        'model/config.json',
        'model/model.bin',
        'model/shared_vocabulary.json'
      ],
      requiredDirectoryPrefixes: ['model/', 'stanza/'],
      embeddedFilePins: fixture.embeddedFilePins
    }
  };
}

function buildSyntheticArgosZip({
  root,
  dataDescriptor,
  mutateEntries = () => {},
  additionalAllowedFlags = [],
  highlyCompressibleModel = false,
  maximumCompressionRatio = 200
}) {
  const entries = [
    directoryEntry(root),
    directoryEntry(`${root}model/`),
    directoryEntry(`${root}stanza/`),
    fileEntry(`${root}metadata.json`, '{"synthetic":true}\n'),
    fileEntry(`${root}README.md`, 'synthetic readme\n'),
    fileEntry(`${root}sentencepiece.model`, 'synthetic sentencepiece\n'),
    fileEntry(`${root}model/config.json`, '{"model":"synthetic"}\n'),
    fileEntry(
      `${root}model/model.bin`,
      highlyCompressibleModel
        ? 'A'.repeat(16_384)
        : pseudoRandomFixtureBytes(16_384)
    ),
    fileEntry(
      `${root}model/shared_vocabulary.json`,
      '{"tokens":["a","b"]}\n'
    ),
    fileEntry(`${root}stanza/resources.json`, '{"lang":"en"}\n'),
    directoryEntry(`${root}stanza/en/`),
    directoryEntry(`${root}stanza/en/tokenize/`),
    fileEntry(`${root}stanza/en/tokenize/model.pt`, 'synthetic stanza\n')
  ];
  for (const entry of entries) {
    if (!entry.directory && dataDescriptor) {
      entry.flags = 8;
    }
  }
  const embeddedFilePins = [
    pinEmbedded(entries, `${root}metadata.json`, 'metadata.json'),
    pinEmbedded(entries, `${root}README.md`, 'README.md')
  ];
  const extractedFiles = entries
    .filter((entry) => !entry.directory)
    .map((entry) => ({
      path: entry.name.slice(root.length),
      size: entry.data.length,
      sha256: sha256(entry.data)
    }))
    .sort(compareFixtureFilePaths);
  const extractedTreeSha256 = sha256(
    Buffer.from(canonicalJson(extractedFiles), 'utf8')
  );
  mutateEntries(entries);
  const built = buildZip(entries);
  return {
    ...built,
    unpackedSize: entries.reduce(
      (sum, entry) => sum + entry.data.length,
      0
    ),
    allowedFlags: [...new Set([
      0,
      ...(dataDescriptor ? [8] : []),
      ...additionalAllowedFlags
    ])].sort((left, right) => left - right),
    maximumCompressionRatio,
    embeddedFilePins,
    extractedFileCount: extractedFiles.length,
    extractedTreeSha256
  };
}

function compareFixtureFilePaths(left, right) {
  if (left.path < right.path) {
    return -1;
  }
  return left.path > right.path ? 1 : 0;
}

function directoryEntry(name) {
  return {
    name,
    directory: true,
    data: Buffer.alloc(0),
    flags: 0,
    method: 0,
    unixMode: 0o040755
  };
}

function fileEntry(name, content) {
  return {
    name,
    directory: false,
    data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    flags: 0,
    method: 8,
    unixMode: 0o100644
  };
}

function pinEmbedded(entries, fullPath, relativePath) {
  const entry = entries.find((item) => item.name === fullPath);
  return {
    path: relativePath,
    size: entry.data.length,
    sha256: sha256(entry.data)
  };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.method === 8
      ? deflateRawSync(entry.data)
      : entry.data;
    const crc = crc32(entry.data);
    const descriptor = (entry.flags & 8) !== 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const descriptorBytes = descriptor
      ? zipDataDescriptor(crc, compressed.length, entry.data.length)
      : Buffer.alloc(0);
    localParts.push(local, name, compressed, descriptorBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length
      + name.length
      + compressed.length
      + descriptorBytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return {
    bytes: Buffer.concat([...localParts, centralDirectory, eocd])
  };
}

function zipDataDescriptor(crc, compressedSize, uncompressedSize) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

function pseudoRandomFixtureBytes(size) {
  const chunks = [];
  let index = 0;
  while (Buffer.concat(chunks).length < size) {
    chunks.push(
      createHash('sha256').update(`argos-selftest-${index}`).digest()
    );
    index += 1;
  }
  return Buffer.concat(chunks).subarray(0, size);
}

async function expectZipFailure({
  temporaryRoot: root,
  name,
  fixture,
  expectedCode
}) {
  const path = resolve(root, `${name}.argosmodel`);
  await writeFile(path, fixture.bytes, { flag: 'wx' });
  const candidate = syntheticArgosCandidate(fixture, `selftest-${name}`);
  await assert.rejects(
    () => inspectArgosZip(path, candidate),
    (error) => error instanceof PocError && error.code === expectedCode
  );
}

async function expectCliFailure(command, args) {
  try {
    await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
  assert.fail('Expected command to fail.');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function removeEmptySelfTestRoot(path) {
  try {
    await rmdir(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) {
      throw error;
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? (value >>> 1) ^ 0xedb88320
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

void DEFAULT_ARGOS_MANIFEST_PATH;

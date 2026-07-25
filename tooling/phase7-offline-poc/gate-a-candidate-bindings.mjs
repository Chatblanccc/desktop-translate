import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  POC_RESEARCH_SCOPE,
  canonicalJson,
  sha256Text
} from './lib.mjs';

const DIRECTIONS = Object.freeze(['en-zh', 'zh-en']);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const MIN_SOURCE_RECORDS = 200;

export async function deriveGateACandidateBindings(options) {
  const authorizationRaw = await readFile(options.authorizationPath);
  const authorizationSha256 = sha256Bytes(authorizationRaw);
  const authorization = parseJson(authorizationRaw, 'AUTHORIZATION_JSON_INVALID');
  assert(
    authorization?.schemaVersion === 'phase7-offline-poc-authorization-v1'
      && authorization?.authorization === 'AUTHORIZED_FOR_POC_RESEARCH_ONLY'
      && authorization?.scope === POC_RESEARCH_SCOPE
      && authorization?.basis === 'PHASE7_M0_USER_AUTHORIZATION'
      && SAFE_ID.test(authorization?.authorizationRecordId ?? '')
      && validSha(authorization?.manifestSha256)
      && Array.isArray(authorization?.candidateIds)
      && authorization.candidateIds.length === DIRECTIONS.length
      && authorization.candidateIds.every((value) => SAFE_ID.test(value))
      && new Set(authorization.candidateIds).size
        === authorization.candidateIds.length,
    'AUTHORIZATION_SCOPE_OR_IDENTITY_INVALID'
  );

  const documents = [];
  for (const direction of DIRECTIONS) {
    const path = options.generationPaths?.[direction];
    assert(typeof path === 'string' && path.length > 0,
      `GENERATION_PATH_MISSING:${direction}`);
    const raw = await readFile(path);
    const document = parseJson(raw, `GENERATION_JSON_INVALID:${direction}`);
    const artifactSha256 = sha256Bytes(raw);
    validateGenerationDocument(document, direction, artifactSha256);
    documents.push({ direction, document, artifactSha256 });
  }

  assert(
    new Set(documents.map(({ document }) => document.identity.candidateId))
      .size === DIRECTIONS.length,
    'GENERATION_CANDIDATE_IDS_NOT_UNIQUE'
  );
  assert(
    new Set(documents.map(({ document }) => document.identity.generationRunId))
      .size === DIRECTIONS.length,
    'GENERATION_RUN_IDS_NOT_UNIQUE'
  );
  assert(
    new Set(documents.map(({ document }) => document.identitySha256))
      .size === DIRECTIONS.length,
    'GENERATION_IDENTITIES_NOT_UNIQUE'
  );
  assert(
    new Set(documents.map(({ artifactSha256 }) => artifactSha256))
      .size === DIRECTIONS.length,
    'GENERATION_ARTIFACTS_NOT_UNIQUE'
  );
  assert(
    documents.every(({ document }) => (
      document.identity.manifestSha256 === authorization.manifestSha256
    )),
    'GENERATION_AUTHORIZATION_MANIFEST_MISMATCH'
  );
  assert(
    equalStringSets(
      documents.map(({ document }) => document.identity.candidateId),
      authorization.candidateIds
    ),
    'GENERATION_AUTHORIZATION_CANDIDATE_SET_MISMATCH'
  );

  for (const { direction, document } of documents) {
    const identity = document.identity;
    assert(
      identity.authorizationSha256 === authorizationSha256
        && identity.authorizationRecordId
          === authorization.authorizationRecordId,
      `GENERATION_AUTHORIZATION_MISMATCH:${direction}`
    );
    if (options.expected) {
      validateExpectedIdentity(
        identity,
        direction,
        options.expected,
        authorizationSha256
      );
    }
  }

  const bindings = documents.map(({ document, artifactSha256 }) => ({
    direction: document.identity.direction,
    candidateId: document.identity.candidateId,
    generationRunId: document.identity.generationRunId,
    generationArtifactSha256: artifactSha256,
    generationIdentitySha256: document.identitySha256,
    sourceSetIdentitySha256: document.identity.sourceSet.identitySha256,
    sourceSetRecordCount: document.identity.sourceSet.recordCount,
    candidateOutputArtifactSha256:
      document.candidateOutput.artifactSha256,
    candidateOutputItemIdentitySetSha256:
      document.candidateOutput.itemIdentitySetSha256
  })).sort(compareBinding);
  const bindingSetSha256 = sha256Text(canonicalJson(bindings));

  return {
    schemaVersion: 'phase7-gate-a-candidate-binding-set-v1',
    authorizationSha256,
    authorizationRecordId: authorization.authorizationRecordId,
    manifestSha256: documents[0].document.identity.manifestSha256,
    bindingSetSha256,
    bindings,
    rawTextEmitted: false,
    absolutePathsEmitted: false,
    integrationOrDistributionAuthorized: false
  };
}

function validateGenerationDocument(document, direction, artifactSha256) {
  assert(exactKeys(document, [
    'schemaVersion',
    'status',
    'scope',
    'identity',
    'identitySha256',
    'candidateOutput',
    'privacy',
    'gateA'
  ]), `GENERATION_SHAPE_INVALID:${direction}`);
  assert(
    document.schemaVersion === 'phase7-gate-a-candidate-generation-v1'
      && document.status === 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE'
      && document.scope === POC_RESEARCH_SCOPE,
    `GENERATION_STATUS_OR_SCOPE_INVALID:${direction}`
  );

  const identity = document.identity;
  assert(exactKeys(identity, [
    'schemaVersion',
    'direction',
    'candidateId',
    'generationRunId',
    'manifestSha256',
    'authorizationSha256',
    'authorizationRecordId',
    'model',
    'runtime',
    'sourceSet',
    'workloadIdentitySha256'
  ]), `GENERATION_IDENTITY_SHAPE_INVALID:${direction}`);
  assert(
    identity.schemaVersion
      === 'phase7-gate-a-candidate-generation-identity-v1'
      && identity.direction === direction
      && SAFE_ID.test(identity.candidateId ?? '')
      && SAFE_ID.test(identity.generationRunId ?? '')
      && validSha(identity.manifestSha256)
      && validSha(identity.authorizationSha256)
      && SAFE_ID.test(identity.authorizationRecordId ?? '')
      && validSha(identity.workloadIdentitySha256),
    `GENERATION_IDENTITY_INVALID:${direction}`
  );
  assert(
    exactKeys(identity.model, ['treeSha256'])
      && validSha(identity.model.treeSha256),
    `GENERATION_MODEL_IDENTITY_INVALID:${direction}`
  );
  assert(
    exactKeys(identity.runtime, [
      'materializedTreeSha256',
      'servedTreeSha256'
    ])
      && validSha(identity.runtime.materializedTreeSha256)
      && validSha(identity.runtime.servedTreeSha256),
    `GENERATION_RUNTIME_IDENTITY_INVALID:${direction}`
  );
  assert(
    exactKeys(identity.sourceSet, [
      'schemaVersion',
      'recordCount',
      'identitySha256'
    ])
      && identity.sourceSet.schemaVersion === 'phase7-gate-a-source-set-v1'
      && Number.isSafeInteger(identity.sourceSet.recordCount)
      && identity.sourceSet.recordCount >= MIN_SOURCE_RECORDS
      && validSha(identity.sourceSet.identitySha256),
    `GENERATION_SOURCE_SET_INVALID:${direction}`
  );
  assert(
    document.identitySha256 === sha256Text(canonicalJson(identity)),
    `GENERATION_IDENTITY_SHA256_MISMATCH:${direction}`
  );
  assert(
    exactKeys(document.candidateOutput, [
      'artifactSha256',
      'recordCount',
      'itemIdentitySetSha256',
      'rawTextEmittedInEvidence'
    ])
      && validSha(document.candidateOutput.artifactSha256)
      && document.candidateOutput.recordCount
        === identity.sourceSet.recordCount
      && validSha(document.candidateOutput.itemIdentitySetSha256)
      && document.candidateOutput.rawTextEmittedInEvidence === false,
    `GENERATION_OUTPUT_IDENTITY_INVALID:${direction}`
  );
  assert(
    exactKeys(document.privacy, [
      'sourceTextInEvidence',
      'translationTextInEvidence',
      'absolutePathsInEvidence',
      'usernamesInEvidence'
    ])
      && Object.values(document.privacy).every((value) => value === false),
    `GENERATION_PRIVACY_INVALID:${direction}`
  );
  assert(
    exactKeys(document.gateA, [
      'ready',
      'integrationOrDistributionAuthorized'
    ])
      && document.gateA.ready === false
      && document.gateA.integrationOrDistributionAuthorized === false,
    `GENERATION_NON_AUTHORIZING_STATUS_INVALID:${direction}`
  );
  assert(validSha(artifactSha256),
    `GENERATION_ARTIFACT_SHA256_INVALID:${direction}`);
}

function validateExpectedIdentity(
  identity,
  direction,
  expected,
  authorizationSha256
) {
  const workload = expected.workloads?.[direction];
  assert(workload !== undefined,
    `EXPECTED_WORKLOAD_MISSING:${direction}`);
  const expectedWorkloadSha256 = sha256Text(canonicalJson(workload));
  assert(
    identity.manifestSha256 === expected.manifestSha256,
    `GENERATION_MANIFEST_MISMATCH:${direction}`
  );
  assert(
    identity.authorizationSha256 === authorizationSha256,
    `GENERATION_AUTHORIZATION_SHA256_MISMATCH:${direction}`
  );
  assert(
    identity.model.treeSha256 === expected.modelTreeSha256ByDirection?.[direction],
    `GENERATION_MODEL_TREE_MISMATCH:${direction}`
  );
  assert(
    identity.runtime.materializedTreeSha256
      === expected.materializedRuntimeTreeSha256
      && identity.runtime.servedTreeSha256
        === expected.servedRuntimeTreeSha256,
    `GENERATION_RUNTIME_TREE_MISMATCH:${direction}`
  );
  assert(
    identity.workloadIdentitySha256 === expectedWorkloadSha256,
    `GENERATION_WORKLOAD_IDENTITY_MISMATCH:${direction}`
  );
}

function parseJson(raw, code) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(code);
  }
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0')
      === [...keys].sort().join('\0');
}

function validSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareBinding(left, right) {
  return left.direction.localeCompare(right.direction)
    || left.candidateId.localeCompare(right.candidateId)
    || left.generationRunId.localeCompare(right.generationRunId);
}

function equalStringSets(left, right) {
  const sortedRight = [...right].sort();
  return left.length === right.length
    && [...left].sort().every((value, index) => (
      value === sortedRight[index]
    ));
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function parseCli(argv) {
  const values = new Map();
  const allowed = new Set([
    '--authorization',
    '--generation-en-zh',
    '--generation-zh-en',
    '--manifest-sha256',
    '--materialized-runtime-tree-sha256',
    '--served-runtime-tree-sha256',
    '--model-tree-sha256-en-zh',
    '--model-tree-sha256-zh-en',
    '--source-chars-en-zh',
    '--source-sha256-en-zh',
    '--sample-identity-sha256-en-zh',
    '--workload-config-sha256-en-zh',
    '--source-chars-zh-en',
    '--source-sha256-zh-en',
    '--sample-identity-sha256-zh-en',
    '--workload-config-sha256-zh-en'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith('--') && value !== undefined,
      'CANDIDATE_BINDING_ARGUMENTS_INVALID');
    assert(allowed.has(key), `CANDIDATE_BINDING_ARGUMENT_UNKNOWN:${key}`);
    assert(!values.has(key), `CANDIDATE_BINDING_ARGUMENT_DUPLICATE:${key}`);
    values.set(key, value);
  }
  const required = (key) => {
    const value = values.get(key);
    assert(typeof value === 'string' && value.length > 0,
      `CANDIDATE_BINDING_ARGUMENT_REQUIRED:${key}`);
    return value;
  };
  const workload = (direction) => {
    const result = {
      sourceChars: Number(required(`--source-chars-${direction}`)),
      sourceSha256: required(`--source-sha256-${direction}`),
      sampleIdentitySha256: required(`--sample-identity-sha256-${direction}`),
      workloadConfigSha256: required(`--workload-config-sha256-${direction}`)
    };
    assert(
      Number.isSafeInteger(result.sourceChars)
        && result.sourceChars > 0
        && validSha(result.sourceSha256)
        && validSha(result.sampleIdentitySha256)
        && validSha(result.workloadConfigSha256),
      `CANDIDATE_BINDING_WORKLOAD_ARGUMENT_INVALID:${direction}`
    );
    return result;
  };
  return {
    authorizationPath: required('--authorization'),
    generationPaths: {
      'en-zh': required('--generation-en-zh'),
      'zh-en': required('--generation-zh-en')
    },
    expected: {
      manifestSha256: required('--manifest-sha256'),
      materializedRuntimeTreeSha256:
        required('--materialized-runtime-tree-sha256'),
      servedRuntimeTreeSha256: required('--served-runtime-tree-sha256'),
      modelTreeSha256ByDirection: {
        'en-zh': required('--model-tree-sha256-en-zh'),
        'zh-en': required('--model-tree-sha256-zh-en')
      },
      workloads: {
        'en-zh': workload('en-zh'),
        'zh-en': workload('zh-en')
      }
    }
  };
}

async function main() {
  const result = await deriveGateACandidateBindings(
    parseCli(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

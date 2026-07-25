import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildBergamotGenerationArtifacts,
  loadBergamotGenerationDataset,
  serializeJsonArtifact
} from './bergamot-generation-lib.mjs';
import { buildSelfAuthoredGateADataset } from './create-gate-a-dataset.mjs';
import { canonicalJson, sha256Text } from './lib.mjs';

const hex = (character) => character.repeat(64);
const snapshotId = 'snapshot-2026-07-25-selftest';
const documents = {
  'en-zh': buildSelfAuthoredGateADataset('en-zh', snapshotId),
  'zh-en': buildSelfAuthoredGateADataset('zh-en', snapshotId)
};
for (const [direction, document] of Object.entries(documents)) {
  assert.equal(document.records.length, 200);
  assert.equal(new Set(document.records.map(({ itemId }) => itemId)).size, 200);
  assert.equal(new Set(document.records.map(({ source }) => source)).size, 200);
  assert.ok(document.records.every((record) => record.direction === direction));
  assert.ok(document.records.some((record) =>
    record.tags.includes('proper-noun')));
  assert.ok(document.records.some((record) =>
    record.tags.includes('long-sentence')));
}

const scratch = resolve(
  'artifacts',
  'phase7',
  'offline-poc',
  `generation-selftest-${randomBytes(12).toString('hex')}`
);
await mkdir(scratch, { recursive: true });
try {
  const path = resolve(scratch, 'source-en-zh.json');
  await writeFile(path, serializeJsonArtifact(documents['en-zh']), {
    encoding: 'utf8',
    flag: 'wx'
  });
  const loaded = await loadBergamotGenerationDataset(path, 'en-zh');
  assert.equal(loaded.sourceSet.recordCount, 200);
  assert.match(loaded.sourceSet.identitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(loaded.rendererRecords.length, 200);

  const authorization = {
    schemaVersion: 'phase7-offline-poc-authorization-v1',
    authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
    scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
    basis: 'PHASE7_M0_USER_AUTHORIZATION',
    manifestSha256: hex('a'),
    candidateIds: ['candidate-en-zh', 'candidate-zh-en'],
    observedLicenseMetadataExpressions: ['MPL-2.0'],
    acknowledgedRiskCodes: ['SELFTEST'],
    authorizationRecordId: 'phase7-generation-selftest-auth',
    authorizedAt: '2026-07-25T00:00:00.000Z'
  };
  const authorizationRaw = Buffer.from(
    `${JSON.stringify(authorization, null, 2)}\n`,
    'utf8'
  );
  const rendererGeneration = {
    schemaVersion: 'phase7-bergamot-renderer-generation-v1',
    generationRunId: 'generation-en-zh-selftest',
    records: loaded.document.records.map((record) => ({
      itemId: record.itemId,
      direction: record.direction,
      sourceSha256: sha256Text(record.source),
      translation: record.reference
    }))
  };
  const workloadIdentity = {
    sourceChars: 10,
    sourceSha256: hex('1'),
    sampleIdentitySha256: hex('2'),
    workloadConfigSha256: hex('3')
  };
  const artifacts = buildBergamotGenerationArtifacts({
    authorization,
    authorizationRaw,
    candidateId: 'candidate-en-zh',
    direction: 'en-zh',
    generationRunId: 'generation-en-zh-selftest',
    manifestSha256: hex('a'),
    materializedRuntimeTreeSha256: hex('b'),
    modelTreeSha256: hex('c'),
    rendererGeneration,
    servedRuntimeTreeSha256: hex('d'),
    sourceSet: loaded.sourceSet,
    workloadIdentity
  });
  assert.equal(
    artifacts.evidence.schemaVersion,
    'phase7-gate-a-candidate-generation-v1'
  );
  assert.equal(artifacts.evidence.candidateOutput.recordCount, 200);
  assert.equal(
    artifacts.evidence.candidateOutput.artifactSha256,
    sha256Text(serializeJsonArtifact(artifacts.candidateOutput))
  );
  assert.equal(
    artifacts.evidence.identity.workloadIdentitySha256,
    sha256Text(canonicalJson(workloadIdentity))
  );
  assert.doesNotMatch(JSON.stringify(artifacts.evidence), /"translation"/u);
  assert.match(JSON.stringify(artifacts.candidateOutput), /"translation"/u);

  assert.throws(
    () => buildBergamotGenerationArtifacts({
      authorization,
      authorizationRaw,
      candidateId: 'candidate-en-zh',
      direction: 'en-zh',
      generationRunId: 'generation-en-zh-selftest',
      manifestSha256: hex('a'),
      materializedRuntimeTreeSha256: hex('b'),
      modelTreeSha256: hex('c'),
      rendererGeneration: {
        ...rendererGeneration,
        records: rendererGeneration.records.slice(0, 199)
      },
      servedRuntimeTreeSha256: hex('d'),
      sourceSet: loaded.sourceSet,
      workloadIdentity
    }),
    /BERGAMOT_GENERATION_RENDERER_RESULT_INVALID/u
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'phase7-bergamot-generation-selftest-v1',
  status: 'SELF_TEST_PASS',
  recordsPerDirection: 200,
  datasetContent: 'SELF_AUTHORED_SYNTHETIC',
  privateCandidateTextInEvidence: false,
  modelExecution: 'NOT_RUN',
  integrationOrDistributionAuthorized: false
}, null, 2)}\n`);

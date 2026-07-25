import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assembleBlindEvaluationInput
} from './assemble-blind-eval-input.mjs';
import {
  buildBergamotGenerationArtifacts,
  loadBergamotGenerationDataset,
  serializeJsonArtifact
} from './bergamot-generation-lib.mjs';
import {
  buildSelfAuthoredGateADataset
} from './create-gate-a-dataset.mjs';
import { sha256Text } from './lib.mjs';

const hex = (character) => character.repeat(64);
const scratch = resolve(
  'artifacts',
  'phase7',
  'offline-poc',
  `blind-assembly-selftest-${randomBytes(12).toString('hex')}`
);
const authorization = {
  authorizationRecordId: 'phase7-blind-assembly-selftest-auth'
};
const authorizationRaw = Buffer.from(
  `${JSON.stringify(authorization, null, 2)}\n`,
  'utf8'
);
const paths = {
  datasets: {},
  outputs: {},
  generations: {}
};

await mkdir(scratch, { recursive: true });
try {
  for (const [index, direction] of ['en-zh', 'zh-en'].entries()) {
    const dataset = buildSelfAuthoredGateADataset(
      direction,
      'snapshot-2026-07-25-blind-assembly-selftest'
    );
    const datasetPath = resolve(scratch, `dataset-${direction}.json`);
    await writeFile(datasetPath, serializeJsonArtifact(dataset), {
      encoding: 'utf8',
      flag: 'wx'
    });
    const loaded = await loadBergamotGenerationDataset(
      datasetPath,
      direction
    );
    const candidateId = `candidate-${direction}`;
    const generationRunId = `generation-${direction}-selftest`;
    const rendererGeneration = {
      schemaVersion: 'phase7-bergamot-renderer-generation-v1',
      generationRunId,
      records: dataset.records.map((record) => ({
        itemId: record.itemId,
        direction,
        sourceSha256: sha256Text(record.source),
        translation: record.reference
      }))
    };
    const generated = buildBergamotGenerationArtifacts({
      authorization,
      authorizationRaw,
      candidateId,
      direction,
      generationRunId,
      manifestSha256: hex('a'),
      materializedRuntimeTreeSha256: hex('b'),
      modelTreeSha256: index === 0 ? hex('c') : hex('d'),
      rendererGeneration,
      servedRuntimeTreeSha256: hex('e'),
      sourceSet: loaded.sourceSet,
      workloadIdentity: {
        sourceChars: index + 1,
        sourceSha256: hex('1'),
        sampleIdentitySha256: hex('2'),
        workloadConfigSha256: hex('3')
      }
    });
    const outputPath = resolve(scratch, `output-${direction}.json`);
    const generationPath = resolve(scratch, `generation-${direction}.json`);
    await writeFile(outputPath, generated.candidateOutputSerialized, {
      encoding: 'utf8',
      flag: 'wx'
    });
    await writeFile(
      generationPath,
      serializeJsonArtifact(generated.evidence),
      { encoding: 'utf8', flag: 'wx' }
    );
    paths.datasets[direction] = datasetPath;
    paths.outputs[direction] = outputPath;
    paths.generations[direction] = generationPath;
  }

  const assembled = await assembleBlindEvaluationInput({
    datasetPaths: paths.datasets,
    candidateOutputPaths: paths.outputs,
    generationEvidencePaths: paths.generations
  });
  assert.equal(assembled.records.length, 400);
  assert.deepEqual(assembled.validation.itemCountByDirection, {
    'en-zh': 200,
    'zh-en': 200
  });
  assert.equal(assembled.bindings.length, 2);
  assert.ok(assembled.records.some((record) =>
    record.tags.includes('proper-noun')));
  assert.ok(assembled.records.some((record) =>
    record.tags.includes('long-sentence')));

  const tampered = JSON.parse(
    await readFile(paths.outputs['en-zh'], 'utf8')
  );
  tampered.records[0].translation = `${tampered.records[0].translation}!`;
  const tamperedPath = resolve(scratch, 'output-en-zh-tampered.json');
  await writeFile(tamperedPath, serializeJsonArtifact(tampered), {
    encoding: 'utf8',
    flag: 'wx'
  });
  await assert.rejects(
    assembleBlindEvaluationInput({
      datasetPaths: paths.datasets,
      candidateOutputPaths: {
        ...paths.outputs,
        'en-zh': tamperedPath
      },
      generationEvidencePaths: paths.generations
    }),
    /BLIND_ASSEMBLY_CROSS_BINDING_MISMATCH/u
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'phase7-blind-eval-input-assembly-selftest-v1',
  status: 'SELF_TEST_PASS',
  recordsPerDirection: 200,
  tamperRejected: true,
  humanReview: 'NOT_RUN',
  integrationOrDistributionAuthorized: false
}, null, 2)}\n`);

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POC_RESEARCH_SCOPE,
  canonicalJson,
  sha256Text
} from './lib.mjs';
import { deriveGateACandidateBindings } from './gate-a-candidate-bindings.mjs';

const hex = (character) => character.repeat(64);
const authorization = {
  schemaVersion: 'phase7-offline-poc-authorization-v1',
  authorization: 'AUTHORIZED_FOR_POC_RESEARCH_ONLY',
  scope: POC_RESEARCH_SCOPE,
  basis: 'PHASE7_M0_USER_AUTHORIZATION',
  manifestSha256: hex('a'),
  candidateIds: ['candidate-en-zh', 'candidate-zh-en'],
  observedLicenseMetadataExpressions: ['SELFTEST_ONLY'],
  acknowledgedRiskCodes: ['SELFTEST_ONLY'],
  authorizationRecordId: 'candidate-binding-selftest',
  authorizedAt: '2026-07-25T00:00:00.000Z'
};
const authorizationContent = JSON.stringify(authorization);
const authorizationSha256 = sha256Text(authorizationContent);
const workloads = {
  'en-zh': {
    sourceChars: 57,
    sourceSha256: hex('1'),
    sampleIdentitySha256: hex('2'),
    workloadConfigSha256: hex('3')
  },
  'zh-en': {
    sourceChars: 21,
    sourceSha256: hex('4'),
    sampleIdentitySha256: hex('5'),
    workloadConfigSha256: hex('6')
  }
};
const expected = {
  manifestSha256: hex('a'),
  materializedRuntimeTreeSha256: hex('b'),
  servedRuntimeTreeSha256: hex('c'),
  modelTreeSha256ByDirection: {
    'en-zh': hex('d'),
    'zh-en': hex('e')
  },
  workloads
};

const generation = (direction) => {
  const identity = {
    schemaVersion: 'phase7-gate-a-candidate-generation-identity-v1',
    direction,
    candidateId: `candidate-${direction}`,
    generationRunId: `generation-${direction}`,
    manifestSha256: expected.manifestSha256,
    authorizationSha256,
    authorizationRecordId: authorization.authorizationRecordId,
    model: {
      treeSha256: expected.modelTreeSha256ByDirection[direction]
    },
    runtime: {
      materializedTreeSha256: expected.materializedRuntimeTreeSha256,
      servedTreeSha256: expected.servedRuntimeTreeSha256
    },
    sourceSet: {
      schemaVersion: 'phase7-gate-a-source-set-v1',
      recordCount: 200,
      identitySha256: direction === 'en-zh' ? hex('f') : hex('0')
    },
    workloadIdentitySha256: sha256Text(canonicalJson(workloads[direction]))
  };
  return {
    schemaVersion: 'phase7-gate-a-candidate-generation-v1',
    status: 'FORMAL_BLIND_CANDIDATE_GENERATION_COMPLETE',
    scope: POC_RESEARCH_SCOPE,
    identity,
    identitySha256: sha256Text(canonicalJson(identity)),
    candidateOutput: {
      artifactSha256: direction === 'en-zh' ? hex('7') : hex('8'),
      recordCount: 200,
      itemIdentitySetSha256: direction === 'en-zh' ? hex('9') : hex('a'),
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
};

const root = await mkdtemp(join(tmpdir(), 'phase7-candidate-bindings-'));
try {
  const authorizationPath = join(root, 'authorization.json');
  const generationPaths = {
    'en-zh': join(root, 'generation-en-zh.json'),
    'zh-en': join(root, 'generation-zh-en.json')
  };
  await writeFile(authorizationPath, authorizationContent, 'utf8');
  await writeFile(
    generationPaths['en-zh'],
    JSON.stringify(generation('en-zh')),
    'utf8'
  );
  await writeFile(
    generationPaths['zh-en'],
    JSON.stringify(generation('zh-en')),
    'utf8'
  );
  const result = await deriveGateACandidateBindings({
    authorizationPath,
    generationPaths,
    expected
  });
  assert.equal(result.schemaVersion,
    'phase7-gate-a-candidate-binding-set-v1');
  assert.equal(result.bindings.length, 2);
  assert.ok(result.bindings.every((binding) => (
    binding.sourceSetRecordCount === 200
      && /^[a-f0-9]{64}$/u.test(binding.sourceSetIdentitySha256)
      && /^[a-f0-9]{64}$/u.test(
        binding.candidateOutputArtifactSha256
      )
      && /^[a-f0-9]{64}$/u.test(
        binding.candidateOutputItemIdentitySetSha256
      )
  )));
  assert.match(result.bindingSetSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.rawTextEmitted, false);
  assert.equal(result.absolutePathsEmitted, false);
  assert.equal(result.integrationOrDistributionAuthorized, false);

  const workloadMismatch = structuredClone(expected);
  workloadMismatch.workloads['zh-en'].sourceChars += 1;
  await assert.rejects(
    deriveGateACandidateBindings({
      authorizationPath,
      generationPaths,
      expected: workloadMismatch
    }),
    /GENERATION_WORKLOAD_IDENTITY_MISMATCH:zh-en/u
  );

  const malformed = generation('en-zh');
  malformed.unexpected = true;
  await writeFile(generationPaths['en-zh'], JSON.stringify(malformed), 'utf8');
  await assert.rejects(
    deriveGateACandidateBindings({
      authorizationPath,
      generationPaths,
      expected
    }),
    /GENERATION_SHAPE_INVALID:en-zh/u
  );

  await writeFile(
    generationPaths['en-zh'],
    JSON.stringify(generation('en-zh')),
    'utf8'
  );
  await writeFile(
    authorizationPath,
    JSON.stringify({
      ...authorization,
      candidateIds: ['candidate-en-zh', 'other-zh-en']
    }),
    'utf8'
  );
  await assert.rejects(
    deriveGateACandidateBindings({
      authorizationPath,
      generationPaths,
      expected
    }),
    /GENERATION_AUTHORIZATION_CANDIDATE_SET_MISMATCH/u
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: 'CANDIDATE_BINDING_SELF_TEST_PASS',
  candidateGenerationSchema: 'phase7-gate-a-candidate-generation-v1',
  formalColdSchema: 'phase7-offline-cold-pws-v3',
  rawTextEmitted: false,
  absolutePathsEmitted: false,
  integrationOrDistributionAuthorized: false
}, null, 2));

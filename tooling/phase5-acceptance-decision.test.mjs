import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  acceptancePayload,
  canonicalJson,
  computeAcceptancePayloadDigest,
  computeArtifactSetDigest,
  evaluateAcceptanceDecision,
  FROZEN_GATES,
  GATE_SOURCE_VALIDATORS,
  GATE_VALIDATION_POLICIES,
  REQUIRED_APPROVAL_ROLES
} from './phase5-acceptance-decision.mjs';

const PRODUCT_VERSION = '0.5.0-phase5';
const ROLE_DECISION_STATEMENT = 'This role decision is bound to the exact Phase 5 acceptance payload.';
const NOW = '2026-07-19T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const REPOSITORY = 'Chatblanccc/desktop-translate';
const SOURCE_REF = 'refs/tags/phase5-rc-test';
const SIGNER_WORKFLOW = 'Chatblanccc/desktop-translate/.github/workflows/phase5-windows.yml';
const EXPECTED_SUBJECT = 'CN=Desktop Translate Test';

test('canonical JSON and artifact-set digest are stable across object and artifact order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  const artifacts = artifactRecords();
  assert.equal(computeArtifactSetDigest(artifacts), computeArtifactSetDigest([...artifacts].reverse()));
  assert.throws(() => computeArtifactSetDigest(artifacts.slice(1)), /exactly/u);
});

test('all 43 frozen gates have one explicit, unique, non-empty fail-closed policy', () => {
  assert.equal(FROZEN_GATES.length, 43);
  assert.deepEqual(Object.keys(GATE_VALIDATION_POLICIES).sort(), FROZEN_GATES.map(({ id }) => id).sort());
  assert.equal(new Set(Object.values(GATE_VALIDATION_POLICIES).map(({ validatorId }) => validatorId)).size, 43);
  for (const policy of Object.values(GATE_VALIDATION_POLICIES)) {
    assert(policy.sources.length > 0);
    assert(Object.keys(policy.claims).length > 0);
    assert(Object.isFrozen(policy));
  }
  assert.deepEqual(Object.keys(GATE_SOURCE_VALIDATORS).sort(), FROZEN_GATES.map(({ id }) => id).sort());
  assert.equal(Object.values(GATE_SOURCE_VALIDATORS).filter(({ kind }) => kind === 'IMPLEMENTED').length, 1);
  assert.equal(Object.values(GATE_SOURCE_VALIDATORS).filter(({ kind }) => kind === 'NOT_IMPLEMENTED').length, 42);
  assert.deepEqual(GATE_SOURCE_VALIDATORS['G2-CLEAN-SOURCE'], {
    kind: 'IMPLEMENTED',
    implementation: 'CLEAN_WORKSPACE_STATE_V1'
  });
  assert.equal(GATE_SOURCE_VALIDATORS['WP6-DETERMINISTIC-VERIFY'].kind, 'NOT_IMPLEMENTED');
});

test('the public evaluator cannot upgrade coordinated synthetic sources to acceptance', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    sign(draft, { signer: 'project-owner', authorityMode: 'MERGED_PROJECT_OWNER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    assert.deepEqual(decision.pending, []);
    assert.equal(decision.blockers.filter(({ code }) => code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED').length, 42);
    assert.deepEqual(decision.repositoryState, {
      before: { gitSha: draft.candidate.gitSha, clean: true, verified: true },
      after: { gitSha: draft.candidate.gitSha, clean: true, verified: true }
    });
  });
});

test('synthetic sources cannot produce a 43-gate PASS and missing schemas are explicit blockers', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { signer: 'project-owner', authorityMode: 'MERGED_PROJECT_OWNER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    const notImplemented = decision.blockers.filter(({ code }) => code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED');
    assert.equal(notImplemented.length, 42);
    for (const gateId of ['WP3-PERF-03', 'WP3-PERF-08', 'WP5-AUTHENTICODE', 'WP7-CLEAN-VM', 'WP7-DISPLAY-HARDWARE']) {
      assert(notImplemented.some(({ subject }) => subject === gateId), `${gateId} arbitrary source must be blocked`);
    }
  });
});

test('four distinct role records remain blocked until approval receipts are verifiable', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    assert.equal(decision.blockers.filter(({ code }) => code === 'APPROVAL_RECEIPT_VERIFIER_NOT_IMPLEMENTED').length, 4);
    assert.equal(decision.blockers.filter(({ code }) => (
      (code.startsWith('APPROVAL_') && code !== 'APPROVAL_RECEIPT_VERIFIER_NOT_IMPLEMENTED')
      || code === 'MERGED_AUTHORITY_REQUIRED'
    )).length, 0);
  });
});

test('a merged signer cannot claim multiple roles without merged-project-owner authority', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    sign(draft, { signer: 'same-person', authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    assert.equal(decision.blockers.filter(({ code }) => code === 'MERGED_AUTHORITY_REQUIRED').length, 4);
  });
});

test('an approval of another payload cannot pass', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    draft.approvals[2].signedPayloadSha256 = 'f'.repeat(64);
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject }) => code === 'APPROVAL_PAYLOAD_MISMATCH' && subject === 'SecurityPrivacy'));
  });
});

test('signatures cannot turn a pending provider gate into acceptance', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const provider = gateById(draft, 'WP3-PERF-08');
    provider.status = 'PENDING';
    provider.evidence.sha256 = null;
    sign(draft, { signer: 'project-owner', authorityMode: 'MERGED_PROJECT_OWNER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    assert(decision.pending.includes('gate:WP3-PERF-08'));
  });
});

test('an arbitrary hash-matched file cannot forge PASS', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    gateById(draft, 'WP7-DISPLAY-HARDWARE').evidence = await writeEvidenceText(root, 'evidence/forged/arbitrary.txt', 'PASS\n');
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject }) => code === 'GATE_EVIDENCE_NOT_JSON' && subject === 'WP7-DISPLAY-HARDWARE'));
  });
});

test('a generic JSON status PASS file cannot forge the strict envelope', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    gateById(draft, 'WP6-FRESH-RUNNER-CI').evidence = await writeEvidence(root, 'evidence/forged/generic-pass.json', { status: 'PASS', acceptance: true });
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject }) => code === 'GATE_EVIDENCE_SEMANTIC_INVALID' && subject === 'WP6-FRESH-RUNNER-CI'));
  });
});

test('an envelope for another gate cannot be relabeled by the decision', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    await mutateGateEnvelope(root, draft, 'WP7-DISPLAY-HARDWARE', (envelope) => {
      envelope.gateId = 'WP7-APPLICATION-COMPATIBILITY';
    });
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject, detail }) => code === 'GATE_EVIDENCE_SEMANTIC_INVALID' && subject === 'WP7-DISPLAY-HARDWARE' && /gateId/u.test(detail)));
  });
});

test('a valid envelope cannot promote a source whose bytes do not match its hash', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const envelope = await readGateEnvelope(root, draft, 'WP4-LANE-A-8H');
    const source = envelope.sources[0];
    await writeFile(join(root, ...source.path.split('/')), '{"tampered":true}\n', 'utf8');
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject }) => code === 'GATE_SOURCE_INVALID' && subject === 'WP4-LANE-A-8H'));
  });
});

test('the exact signed clean workspace state is bound to the independently observed repository state', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.acceptance, false);
    assert.equal(decision.blockers.some(({ subject, code }) => (
      subject === 'G2-CLEAN-SOURCE'
      && ['GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED', 'GATE_SOURCE_SEMANTIC_INVALID'].includes(code)
    )), false);
  });
});

test('the real signed workspace-state producer remains compatible with the clean-source evaluator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase5-workspace-state-integration-'));
  try {
    const supplyChainDirectory = join(root, 'tooling', 'supply-chain');
    await mkdir(supplyChainDirectory, { recursive: true });
    for (const name of ['capture-phase5-workspace-state.mjs', 'phase5-supply-chain-lib.mjs']) {
      await copyFile(join(import.meta.dirname, 'supply-chain', name), join(supplyChainDirectory, name));
    }
    const gitSha = await initializeTemporaryGitRepository(root, [
      'tooling/supply-chain/capture-phase5-workspace-state.mjs',
      'tooling/supply-chain/phase5-supply-chain-lib.mjs'
    ]);
    const logicalPath = 'evidence/build/workspace-state.json';
    const absolutePath = join(root, ...logicalPath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    const producer = spawnSync(process.execPath, [
      join(supplyChainDirectory, 'capture-phase5-workspace-state.mjs'),
      '--output', absolutePath,
      '--mode', 'signed',
      '--expected-head', gitSha
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(producer.status, 0, producer.stderr);
    const bytes = await readFile(absolutePath);
    const workspaceStateBinding = {
      path: logicalPath,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
    const { draft } = await buildCandidate(root, gitSha, { workspaceStateBinding });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    assert.equal(decision.blockers.some(({ subject, code }) => (
      subject === 'G2-CLEAN-SOURCE'
      && ['GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED', 'GATE_SOURCE_SEMANTIC_INVALID'].includes(code)
    )), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact-looking deterministic verify summary remains blocked without trusted execution provenance', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject }) => (
      code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED'
      && subject === 'WP6-DETERMINISTIC-VERIFY'
    )));
  });
});

for (const [label, mutate, expectedDetail] of [
  ['another candidate SHA', (state) => { state.headSha = 'f'.repeat(40); }, /candidate\.gitSha/u],
  ['unsigned capture mode', (state) => { state.captureMode = 'unsigned'; }, /captureMode/u],
  ['ineligible capture', (state) => { state.acceptanceEligible = false; }, /acceptanceEligible/u],
  ['dirty capture', (state) => { state.developmentDirty = true; }, /developmentDirty/u],
  ['an unexpected field', (state) => { state.forgedPass = true; }, /unexpected fields/u]
]) {
  test(`clean-source validation rejects ${label} even when the source and envelope hashes are updated`, async () => {
    await withCandidate(async ({ root, draft, evaluationOptions }) => {
      await mutateGateSource(root, draft, 'G2-CLEAN-SOURCE', 'workspaceState', mutate);
      const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
      assert.equal(decision.status, 'BLOCKED');
      assert(decision.blockers.some(({ code, subject, detail }) => (
        code === 'GATE_SOURCE_SEMANTIC_INVALID'
        && subject === 'G2-CLEAN-SOURCE'
        && expectedDetail.test(detail)
      )));
      assert.equal(decision.blockers.some(({ code, subject }) => (
        code === 'GATE_SOURCE_INVALID' && subject === 'G2-CLEAN-SOURCE'
      )), false);
    });
  });
}

test('a gate-specific threshold failure is blocked even inside a strict envelope', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    await mutateGateEnvelope(root, draft, 'WP3-PERF-09', (envelope) => {
      envelope.claims.failures = 1;
    });
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code, subject, detail }) => code === 'GATE_EVIDENCE_SEMANTIC_INVALID' && subject === 'WP3-PERF-09' && /failures/u.test(detail)));
  });
});

test('self-reported PERF-03 and PERF-08 reports cannot confer production trust', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    for (const gateId of ['WP3-PERF-03', 'WP3-PERF-08']) {
      assert(decision.blockers.some(({ code, subject }) => code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED' && subject === gateId));
    }
  });
});

test('coordinated self-reported crypto JSON cannot confer production trust', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    for (const gateId of [
      'WP5-FINAL-RELEASE-MANIFEST',
      'WP5-AUTHENTICODE',
      'WP5-ARTIFACT-ATTESTATION',
      'WP5-FINAL-MANIFEST-ATTESTATION',
      'WP5-CLEAN-DOWNLOAD'
    ]) {
      assert(decision.blockers.some(({ code, subject }) => code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED' && subject === gateId));
    }
  });
});

test('candidate identity and artifact-set binding fail closed', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    draft.candidate.artifactSetDigest = 'd'.repeat(64);
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code }) => code === 'ARTIFACT_SET_DIGEST_MISMATCH'));
    assert(decision.blockers.some(({ code }) => code === 'CLEAN_DOWNLOAD_ARTIFACT_SET_MISMATCH'));
    assert(decision.blockers.some(({ code }) => code === 'GATE_EVIDENCE_SEMANTIC_INVALID'));
  });
});

test('official repository and signer-workflow identities are frozen independently of coordinated evidence', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const spoofedRepository = 'attacker/desktop-translate';
    const spoofedWorkflow = `${spoofedRepository}/.github/workflows/phase5-windows.yml`;
    const finalManifestPath = join(root, ...draft.candidate.finalReleaseManifest.path.split('/'));
    const finalManifest = JSON.parse(await readFile(finalManifestPath, 'utf8'));
    finalManifest.source.repository = spoofedRepository;
    finalManifest.independentTrustRoot.repository = spoofedRepository;
    finalManifest.independentTrustRoot.signerWorkflow = spoofedWorkflow;
    await writeFile(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8');
    await replaceCandidateBinding(root, draft, 'finalReleaseManifest', finalManifestPath);

    const cleanDownloadPath = join(root, ...draft.candidate.cleanDownloadVerification.path.split('/'));
    const cleanDownload = JSON.parse(await readFile(cleanDownloadPath, 'utf8'));
    cleanDownload.repository = spoofedRepository;
    cleanDownload.signerWorkflow = spoofedWorkflow;
    cleanDownload.finalManifestSha256 = draft.candidate.finalReleaseManifest.sha256;
    await writeFile(cleanDownloadPath, `${JSON.stringify(cleanDownload, null, 2)}\n`, 'utf8');
    await replaceCandidateBinding(root, draft, 'cleanDownloadVerification', cleanDownloadPath);

    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code }) => code === 'FINAL_MANIFEST_SOURCE_MISMATCH'));
    assert(decision.blockers.some(({ code }) => code === 'ARTIFACT_ATTESTATION_NOT_PASS'));
    assert(decision.blockers.some(({ code }) => code === 'CLEAN_DOWNLOAD_SOURCE_MISMATCH'));
  });
});

test('a historical candidate SHA cannot pass against the current repository HEAD', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    await writeFile(join(root, 'head-change.txt'), 'new head\n', 'utf8');
    runGit(root, ['add', 'head-change.txt']);
    runGit(root, ['commit', '--quiet', '-m', 'new head']);
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code }) => code === 'REPOSITORY_HEAD_BEFORE_MISMATCH'));
    assert(decision.blockers.some(({ code }) => code === 'REPOSITORY_HEAD_AFTER_MISMATCH'));
    assert(decision.blockers.some(({ code, subject, detail }) => (
      code === 'GATE_SOURCE_SEMANTIC_INVALID'
      && subject === 'G2-CLEAN-SOURCE'
      && /independently captured/u.test(detail)
    )));
  });
});

test('a dirty repository before evidence evaluation is blocked', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { distinctSigners: true, authorityMode: 'ROLE_HOLDER' });
    await writeFile(join(root, 'dirty-untracked.txt'), 'dirty\n', 'utf8');
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW });
    assert.equal(decision.status, 'BLOCKED');
    assert(decision.blockers.some(({ code }) => code === 'REPOSITORY_DIRTY_BEFORE'));
    assert(decision.blockers.some(({ code, subject, detail }) => (
      code === 'GATE_SOURCE_SEMANTIC_INVALID'
      && subject === 'G2-CLEAN-SOURCE'
      && /independently captured/u.test(detail)
    )));
  });
});

test('the public evaluator exposes no repository-state or source-validator bypass option', async () => {
  const source = await readFile(join(import.meta.dirname, 'phase5-acceptance-decision.mjs'), 'utf8');
  assert.doesNotMatch(source, /repositoryStateProvider|testOnlySourceValidatorOverrides/u);
});

test('the frozen gate and role sets reject omission, reordering, and aliases', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const omitted = structuredClone(draft);
    omitted.gates.pop();
    await assert.rejects(() => evaluateAcceptanceDecision(omitted, { workspaceRoot: root, ...evaluationOptions }), /exactly 43/u);

    const reordered = structuredClone(draft);
    [reordered.gates[0], reordered.gates[1]] = [reordered.gates[1], reordered.gates[0]];
    await assert.rejects(() => evaluateAcceptanceDecision(reordered, { workspaceRoot: root, ...evaluationOptions }), /must be G0-SCOPE-FREEZE/u);

    const aliasedRole = structuredClone(draft);
    aliasedRole.approvals[2].role = 'Security/Privacy';
    await assert.rejects(() => evaluateAcceptanceDecision(aliasedRole, { workspaceRoot: root, ...evaluationOptions }), /must be SecurityPrivacy/u);
  });
});

test('the JSON schema independently rejects a forged PASS with a pending gate', async () => {
  await withCandidate(async ({ root, draft, evaluationOptions }) => {
    const decision = await evaluateAcceptanceDecision(draft, { workspaceRoot: root, now: NOW, ...evaluationOptions });
    decision.status = 'PASS';
    decision.acceptance = true;
    decision.pending = [];
    const schema = JSON.parse(await readFile(join(import.meta.dirname, '..', 'schemas', 'phase5', 'acceptance-decision.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.equal(validate(decision), false);
  });
});

test('CLI uses real Git state, writes one immutable BLOCKED decision, and has no source-validator bypass', async () => {
  await withCandidate(async ({ root, draft }) => {
    sign(draft, { signer: 'project-owner', authorityMode: 'MERGED_PROJECT_OWNER' });
    const inputPath = join(root, 'decision-input.json');
    const outputPath = join(root, 'decision-output.json');
    await writeFile(inputPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    const arguments_ = [
      join(import.meta.dirname, 'phase5-acceptance-decision.mjs'),
      '--input', inputPath,
      '--output', outputPath,
      '--workspace-root', root
    ];
    const first = spawnSync(process.execPath, arguments_, { encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 1, first.stderr);
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(output.status, 'BLOCKED');
    assert(output.blockers.some(({ code }) => code === 'GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED'));

    const second = spawnSync(process.execPath, arguments_, { encoding: 'utf8', windowsHide: true });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /EEXIST/u);
  });
});

test('CLI exposes no repository-state bypass argument', () => {
  const result = spawnSync(process.execPath, [
    join(import.meta.dirname, 'phase5-acceptance-decision.mjs'),
    '--input', 'input.json',
    '--output', 'output.json',
    '--repository-state', 'clean'
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument|Invalid or duplicate argument/u);
});

async function withCandidate(callback) {
  const root = await mkdtemp(join(tmpdir(), 'phase5-acceptance-decision-'));
  try {
    const gitSha = await initializeTemporaryGitRepository(root);
    const fixture = await buildCandidate(root, gitSha);
    const evaluationOptions = {};
    await callback({ root, ...fixture, evaluationOptions });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildCandidate(root, gitSha, options = {}) {
  const artifacts = artifactRecords();
  const artifactSetDigest = computeArtifactSetDigest(artifacts);
  const sourceBindings = new Map();

  const signatureReport = {
    schemaVersion: 2,
    status: 'PASS',
    requireSigned: true,
    expectedSubject: EXPECTED_SUBJECT,
    exactArtifactRoles: ['application', 'installer', 'nativeHost'],
    artifacts: artifacts.filter(({ role }) => role !== 'asar').map((artifact) => ({
      ...artifact,
      signatureStatus: 'Valid',
      signed: true,
      subject: EXPECTED_SUBJECT,
      thumbprint: 'A'.repeat(40),
      timestampSubject: 'CN=Timestamp Test',
      signerChain: { valid: true },
      timestampChain: { valid: true },
      tamperTest: { rejected: true }
    })),
    blockers: []
  };
  const signatureBinding = await writeEvidence(root, 'evidence/security/signature-report.json', signatureReport);
  const artifactAttestationBinding = await writeEvidence(root, 'evidence/security/github-artifacts-attestation.json', { dsseEnvelope: { payload: 'dGVzdA==' } });
  const manifestAttestationBinding = await writeEvidence(root, 'evidence/security/github-manifest-attestation.json', { bundle: { dsseEnvelope: { payload: 'bWFuaWZlc3Q=' } } });
  const trustedRootBinding = await writeEvidenceText(root, 'evidence/security/trusted_root.jsonl', '{"trustedRoot":{"test":true}}\n');
  const finalManifest = {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    source: {
      repository: REPOSITORY,
      ref: SOURCE_REF,
      gitSha,
      sourceIdentity: 'HEAD',
      developmentDirty: false,
      patchDigest: null
    },
    artifacts,
    authenticode: {
      status: 'PASS',
      expectedSubject: EXPECTED_SUBJECT,
      exactArtifactRoles: ['application', 'installer', 'nativeHost'],
      signatureReport: 'security/signature-report.json',
      signatureReportSha256: signatureBinding.sha256
    },
    packageSmoke: { status: 'PASS' },
    packageEvidence: { status: 'PASS' },
    supplyChain: { status: 'PASS' },
    independentTrustRoot: {
      type: 'github-artifact-attestation-sigstore',
      status: 'PASS',
      repository: REPOSITORY,
      sourceRef: SOURCE_REF,
      sourceDigest: gitSha,
      signerWorkflow: SIGNER_WORKFLOW,
      artifactBundleSha256: artifactAttestationBinding.sha256,
      trustedRootSha256: trustedRootBinding.sha256
    }
  };
  const finalManifestBinding = await writeEvidence(root, 'evidence/release/final-release-manifest.json', finalManifest);
  const cleanDownload = {
    schemaVersion: 1,
    status: 'PASS',
    releaseStatus: 'PASS',
    repository: REPOSITORY,
    sourceRef: SOURCE_REF,
    sourceDigest: gitSha,
    signerWorkflow: SIGNER_WORKFLOW,
    finalManifestSha256: finalManifestBinding.sha256,
    manifestAttestationSha256: manifestAttestationBinding.sha256,
    trustedRootSha256: trustedRootBinding.sha256,
    independentlyAcquiredTrustedRootSha256: trustedRootBinding.sha256,
    exactArtifacts: [...artifacts].reverse(),
    authenticodeSubject: EXPECTED_SUBJECT
  };
  const cleanDownloadBinding = await writeEvidence(root, 'evidence/clean-download/clean-download-verification.json', cleanDownload);

  sourceBindings.set('WP5-FINAL-RELEASE-MANIFEST:finalReleaseManifest', finalManifestBinding);
  sourceBindings.set('WP5-AUTHENTICODE:signatureReport', signatureBinding);
  sourceBindings.set('WP5-ARTIFACT-ATTESTATION:artifactAttestation', artifactAttestationBinding);
  sourceBindings.set('WP5-ARTIFACT-ATTESTATION:trustedRoot', trustedRootBinding);
  sourceBindings.set('WP5-FINAL-MANIFEST-ATTESTATION:manifestAttestation', manifestAttestationBinding);
  sourceBindings.set('WP5-FINAL-MANIFEST-ATTESTATION:trustedRoot', trustedRootBinding);
  sourceBindings.set('WP5-CLEAN-DOWNLOAD:cleanDownloadVerification', cleanDownloadBinding);
  sourceBindings.set('WP5-CLEAN-DOWNLOAD:independentTrustedRoot', trustedRootBinding);
  sourceBindings.set('WP3-PERF-03:summary', await writeEvidence(root, 'evidence/perf03/summary.json', perf03Summary(gitSha, finalManifestBinding, cleanDownloadBinding)));
  sourceBindings.set(
    'G2-CLEAN-SOURCE:workspaceState',
    options.workspaceStateBinding ?? await writeEvidence(root, 'evidence/build/workspace-state.json', cleanWorkspaceState(gitSha))
  );
  sourceBindings.set('WP6-DETERMINISTIC-VERIFY:verifySummary', await writeEvidence(root, 'evidence/verify/verify-summary.json', deterministicVerifySummary(gitSha)));

  const providerBindings = await buildProviderSmokeEvidence(root, gitSha, artifactSetDigest);
  for (const [role, binding] of providerBindings) sourceBindings.set(`WP3-PERF-08:${role}`, binding);

  const candidate = {
    gitSha,
    productVersion: PRODUCT_VERSION,
    finalReleaseManifest: finalManifestBinding,
    cleanDownloadVerification: cleanDownloadBinding,
    artifactSetDigest
  };
  const gates = [];
  for (const frozen of FROZEN_GATES) {
    const policy = GATE_VALIDATION_POLICIES[frozen.id];
    const sources = [];
    for (const sourceSpec of policy.sources) {
      let binding = sourceBindings.get(`${frozen.id}:${sourceSpec.role}`);
      if (!binding) {
        const path = `evidence/sources/${frozen.id}/${sourceSpec.role}.${sourceSpec.mediaType === 'text/plain' ? 'txt' : sourceSpec.mediaType === 'application/jsonl' ? 'jsonl' : 'json'}`;
        if (sourceSpec.mediaType === 'application/json') {
          binding = await writeEvidence(root, path, { schemaVersion: 1, gateId: frozen.id, sourceRole: sourceSpec.role, status: 'PASS' });
        } else if (sourceSpec.mediaType === 'application/jsonl') {
          binding = await writeEvidenceText(root, path, '{"status":"PASS"}\n');
        } else {
          binding = await writeEvidenceText(root, path, `Phase 5 ${frozen.id} ${sourceSpec.role} evidence\n`);
        }
      }
      sources.push({ role: sourceSpec.role, mediaType: sourceSpec.mediaType, ...binding });
    }
    const envelope = {
      schemaVersion: 1,
      phase: 5,
      gateId: frozen.id,
      evidenceClass: frozen.evidenceClass,
      externalEvidence: frozen.externalEvidence,
      status: 'PASS',
      acceptance: true,
      candidate: { gitSha, artifactSetDigest },
      validator: { id: policy.validatorId, version: 1 },
      claims: claimsForPolicy(policy, candidate),
      sources
    };
    const evidence = await writeEvidence(root, `evidence/gates/${frozen.id}.json`, envelope);
    gates.push({ ...frozen, status: 'PASS', evidence, note: null });
  }

  return {
    draft: {
      schemaVersion: 1,
      phase: 5,
      candidate,
      gates,
      approvals: pendingApprovals()
    }
  };
}

function cleanWorkspaceState(gitSha) {
  const emptySha256 = createHash('sha256').digest('hex');
  return {
    schemaVersion: 1,
    headSha: gitSha,
    sourceIdentity: `HEAD:${gitSha}`,
    developmentDirty: false,
    acceptanceEligible: true,
    patchDigest: null,
    statusDigest: emptySha256,
    trackedPatchSha256: emptySha256,
    untrackedFileCount: 0,
    untrackedBytes: 0,
    captureMode: 'signed'
  };
}

function deterministicVerifySummary(gitSha) {
  return {
    schemaVersion: '1.0.0',
    phase: 5,
    status: 'DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE',
    strictPhase4Superset: true,
    acceptance: false,
    gitSha,
    worktreeDirty: false,
    gates: {
      phase4StrictSuperset: 'PASS',
      metricsInterface: 'SMOKE_PASS_NOT_PERFORMANCE_ACCEPTANCE',
      processPrivacyHardening: 'PASS',
      laneIdentityHardening: 'PASS',
      acceptanceDecisionHardening: 'PASS',
      environmentPreflightHardening: 'PASS',
      formalPerf03Hardening: 'PASS',
      providerSmokeHardening: 'PASS',
      releaseEvidenceHardening: 'PASS',
      dependencyAudit: 'PASS',
      unsignedPackaging: 'PASS',
      laneASmoke: 'SMOKE_PASS_NOT_ACCEPTANCE',
      laneB: 'NOT_RUN',
      resourceInterface: 'SMOKE_PASS_NOT_RESOURCE_ACCEPTANCE',
      residualProcesses: 'PASS',
      evidencePrivacy: 'PASS'
    },
    limitations: [
      'Lane A short duration is harness smoke only.',
      'Lane A simulated result consumption is not real UIA, DXGI or OCR acquisition.',
      'Lane B is explicitly NOT RUN and requires a final signed RC in a dedicated interactive session.',
      'Resource interface smoke is not the 15-minute idle or 8-hour resource gate.',
      'Real Provider smoke, signing and release verification are separate protected/manual gates.',
      'A zero exit code from this deterministic gate is not Phase 5 acceptance.'
    ]
  };
}

function perf03Summary(gitSha, finalManifestBinding, cleanDownloadBinding) {
  const rounds = [1, 2, 3].map((round) => ({
    round,
    configuredSampleCount: 100,
    successCount: 100,
    failureCount: 0,
    p50Ms: 500,
    p95Ms: 1000,
    maxMs: 1200,
    forcedTerminationCount: 0,
    status: 'PASS',
    stableFailureCodes: []
  }));
  return {
    schemaVersion: 'phase5-perf03-summary-v1',
    metricId: 'PERF-03',
    scenario: 'main-starts-real-host-to-authenticated-pipe-ready',
    status: 'PASS',
    acceptance: true,
    evidenceLevel: 'fixed-lab-benchmark',
    buildMode: 'signed-rc',
    configuredRoundCount: 3,
    configuredSamplesPerRound: 100,
    statisticsMethod: 'nearest-rank',
    thresholds: { p50Ms: 700, p95Ms: 1500, failureCount: 0 },
    gitSha,
    artifact: {
      applicationSha256: '1'.repeat(64),
      hostSha256: '4'.repeat(64),
      asarSha256: '2'.repeat(64),
      installerSha256: '3'.repeat(64),
      packageEvidenceManifestSha256: '5'.repeat(64),
      finalReleaseManifestSha256: finalManifestBinding.sha256,
      cleanDownloadVerificationSha256: cleanDownloadBinding.sha256,
      independentTrustedRootSha256: SHA_A,
      acceptanceEligibleManifestBound: true,
      signedReleaseIdentityBound: true,
      attestedFinalReleaseBound: true,
      independentCleanDownloadBound: true,
      authenticodeSubjectSha256: SHA_A
    },
    run: {
      workflowName: 'phase5-perf03-host-ready',
      dedicatedInteractiveSession: true,
      foregroundInputExclusive: true,
      runMetadataSha256: SHA_A
    },
    rounds,
    totalFailureCount: 0,
    forcedTerminationCount: 0,
    gates: {
      sourceAndArtifactIdentity: 'PASS',
      fixedDeviceMetadata: 'PASS',
      preflightResidual: 'PASS',
      threeIndependentRounds: 'PASS',
      forcedTerminationZero: 'PASS',
      postflightResidual: 'PASS',
      evidencePrivacy: 'PASS'
    },
    stableFailureCodes: [],
    completedAt: NOW,
    limitations: ['PERF-03 only.']
  };
}

async function buildProviderSmokeEvidence(root, gitSha, artifactSetDigest) {
  const metadata = {
    schemaVersion: 'phase5-provider-smoke-run-metadata-v1',
    run: {
      runId: 'provider-run-1',
      workflowName: 'phase5-provider-smoke',
      workflowRunId: 'workflow-1',
      operatorRole: 'QualityRelease',
      deviceRegistrationId: 'fixed-lab-1',
      evidenceLevel: 'provider-smoke',
      dedicatedInteractiveSession: true,
      foregroundInputExclusive: true,
      debuggerClosed: true,
      unrelatedForegroundTasksClosed: true
    },
    environment: { osBuild: 'test' }
  };
  const metadataBinding = await writeEvidence(root, 'evidence/provider/run-metadata.json', metadata);
  const identity = {
    gitSha,
    artifactSetDigest,
    runMetadataSha256: metadataBinding.sha256,
    deviceRegistrationId: 'fixed-lab-1',
    workflowName: 'phase5-provider-smoke',
    workflowRunId: 'workflow-1',
    runId: 'provider-run-1'
  };
  const health = {
    schemaVersion: 'phase5-provider-smoke-v2',
    evidenceKind: 'health',
    formal: true,
    providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
    identity,
    acceptance: false,
    perf08Status: 'BLOCKED_FAULT_RECOVERY_EVIDENCE_REQUIRED',
    sourceTextId: 'PERF08_PUBLIC_ZH_SHORT_V1',
    statisticsMethod: 'nearest-rank',
    p95Interpretation: 'N10_NEAREST_RANK_P95_EQUALS_MAX',
    targetCount: 3,
    samplesPerTarget: 10,
    healthTargets: ['en', 'ja', 'ko'].map((targetLanguage) => ({
      targetLanguage,
      attemptCount: 10,
      successCount: 10,
      failureCount: 0,
      durationMs: { p50: 1000, p95: 2000, max: 2000 }
    })),
    stableCode: 'HEALTH_PASS'
  };
  const healthBinding = await writeEvidence(root, 'evidence/provider/health.json', health);
  const scenarios = ['timeout', 'network-unavailable', 'malformed-response', 'recovery'];
  const controlIds = new Map(scenarios.map((scenario) => [scenario, `control-${scenario}`]));
  const faultBindings = new Map();
  for (const scenario of scenarios) {
    const observedStableCode = scenario === 'recovery' ? 'success' : scenario === 'malformed-response' ? 'malformed-response' : 'network-unavailable';
    const fault = {
      schemaVersion: 'phase5-provider-smoke-v2',
      evidenceKind: 'fault',
      formal: true,
      providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
      identity,
      acceptance: false,
      perf08Status: 'BLOCKED_AGGREGATION_REQUIRED',
      sourceTextId: 'PERF08_PUBLIC_ZH_SHORT_V1',
      scenario,
      faultControlId: controlIds.get(scenario),
      recoveryOfControlIds: scenario === 'recovery' ? scenarios.slice(0, 3).map((item) => controlIds.get(item)) : [],
      attemptCount: 1,
      observedStableCode,
      scenarioStatus: 'PASS',
      stableCode: 'SCENARIO_PASS'
    };
    faultBindings.set(scenario, await writeEvidence(root, `evidence/provider/fault-${scenario}.json`, fault));
  }
  const aggregate = {
    schemaVersion: 'phase5-provider-smoke-v2',
    evidenceKind: 'aggregate',
    formal: true,
    providerBoundary: 'REAL_BAIDU_PRODUCT_PROVIDER',
    identity,
    acceptance: false,
    perf08Status: 'PASS',
    sourceTextId: 'PERF08_PUBLIC_ZH_SHORT_V1',
    healthEvidenceSha256: healthBinding.sha256,
    faultEvidenceDigests: scenarios.map((scenario) => ({ scenario, sha256: faultBindings.get(scenario).sha256 })),
    stableCode: 'PASS'
  };
  return new Map([
    ['aggregate', await writeEvidence(root, 'evidence/provider/aggregate.json', aggregate)],
    ['health', healthBinding],
    ['faultTimeout', faultBindings.get('timeout')],
    ['faultNetworkUnavailable', faultBindings.get('network-unavailable')],
    ['faultMalformedResponse', faultBindings.get('malformed-response')],
    ['faultRecovery', faultBindings.get('recovery')],
    ['runMetadata', metadataBinding]
  ]);
}

function claimsForPolicy(policy, candidate) {
  return Object.fromEntries(Object.entries(policy.claims).map(([name, rule]) => {
    if (rule.kind === 'candidateGitSha') return [name, candidate.gitSha];
    if (rule.kind === 'candidateArtifactSetDigest') return [name, candidate.artifactSetDigest];
    return [name, structuredClone(rule.example)];
  }));
}

function artifactRecords() {
  return [
    artifact('application', 'package/desktop-translate.exe', 'desktop-translate.exe', 101, '1'),
    artifact('asar', 'package/resources/app.asar', 'app.asar', 102, '2'),
    artifact('installer', 'installer/desktop-translate-setup.exe', 'desktop-translate-setup.exe', 103, '3'),
    artifact('nativeHost', 'package/resources/selection-host/selection-host.exe', 'selection-host.exe', 104, '4')
  ];
}

function artifact(role, path, name, size, nibble) {
  return { role, path, name, size, sha256: nibble.repeat(64) };
}

function pendingApprovals() {
  return REQUIRED_APPROVAL_ROLES.map((role) => ({
    role,
    decision: 'PENDING',
    signerId: null,
    displayName: null,
    authorityMode: null,
    signedPayloadSha256: null,
    signedAt: null,
    statement: null
  }));
}

function sign(draft, options) {
  const payloadSha256 = computeAcceptancePayloadDigest(acceptancePayload(draft));
  draft.approvals = REQUIRED_APPROVAL_ROLES.map((role, index) => ({
    role,
    decision: 'APPROVE',
    signerId: options.distinctSigners ? `role-holder-${index}` : options.signer,
    displayName: options.distinctSigners ? `Role Holder ${index}` : 'Project Owner',
    authorityMode: options.authorityMode,
    signedPayloadSha256: payloadSha256,
    signedAt: NOW,
    statement: ROLE_DECISION_STATEMENT
  }));
}

async function writeEvidence(root, logicalPath, value) {
  return writeEvidenceText(root, logicalPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeEvidenceText(root, logicalPath, bytes) {
  const absolutePath = join(root, ...logicalPath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes, 'utf8');
  return { path: logicalPath, sha256: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

async function replaceCandidateBinding(_root, draft, key, absolutePath) {
  const bytes = await readFile(absolutePath);
  draft.candidate[key] = {
    ...draft.candidate[key],
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function gateById(draft, id) {
  return draft.gates.find((item) => item.id === id);
}

async function readGateEnvelope(root, draft, id) {
  const gate = gateById(draft, id);
  return JSON.parse(await readFile(join(root, ...gate.evidence.path.split('/')), 'utf8'));
}

async function mutateGateEnvelope(root, draft, id, mutate) {
  const envelope = await readGateEnvelope(root, draft, id);
  mutate(envelope);
  await replaceGateEnvelope(root, draft, id, envelope);
}

async function mutateGateSource(root, draft, gateId, sourceRole, mutate) {
  const envelope = await readGateEnvelope(root, draft, gateId);
  const source = envelope.sources.find(({ role }) => role === sourceRole);
  assert(source, `Missing ${gateId}:${sourceRole} fixture source.`);
  const absolutePath = join(root, ...source.path.split('/'));
  const value = JSON.parse(await readFile(absolutePath, 'utf8'));
  mutate(value);
  const binding = await writeEvidence(root, source.path, value);
  source.sha256 = binding.sha256;
  await replaceGateEnvelope(root, draft, gateId, envelope);
}

async function replaceGateEnvelope(root, draft, id, envelope) {
  const gate = gateById(draft, id);
  gate.evidence = await writeEvidence(root, gate.evidence.path, envelope);
}

async function initializeTemporaryGitRepository(root, extraTrackedPaths = []) {
  await writeFile(join(root, '.gitignore'), 'evidence/\ndecision-*.json\n', 'utf8');
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.name', 'Phase5 Test']);
  runGit(root, ['config', 'user.email', 'phase5-test@example.invalid']);
  runGit(root, ['add', '.gitignore', ...extraTrackedPaths]);
  runGit(root, ['commit', '--quiet', '-m', 'fixture']);
  return runGit(root, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
}

function runGit(root, arguments_) {
  const result = spawnSync('git', ['-C', root, ...arguments_], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

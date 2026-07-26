import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  buildGateADecision,
  validateGateADecision
} from './gate-a-decision.mjs';
import {
  canonicalJson,
  sha256Text
} from './lib.mjs';
import {
  evaluateGateAInputCompleteness
} from './gate-a-completeness.mjs';

const primaryEvidence = {
  candidateGenerationBindingSetSha256: '1'.repeat(64)
};
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const m4Completion = {
  schemaVersion: 'phase7-m4-ai-completion-v1',
  status: 'M4_AI_APPROVED_COMPLETE_FOR_GATE_A_SUBMISSION',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  delegation: {
    basis: 'USER_DELEGATED_ALL_REMAINING_M4_AI_FILL_AND_APPROVAL',
    aiWorkMustBeExplicitlyLabelled: true,
    gateADecisionDelegated: false
  },
  assessor: {
    assessorType: 'AI_LANGUAGE_MODEL',
    humanReviewerClaimed: false,
    qualifiedLawyerClaimed: false,
    cleanVmOperatorClaimed: false
  },
  primaryEvidence,
  primaryEvidenceSetSha256: sha256Text(canonicalJson(primaryEvidence)),
  candidateGenerationBindings: [
    { candidateId: 'firefox-bergamot-base-memory-en-zh' },
    { candidateId: 'firefox-bergamot-base-memory-zh-en' }
  ],
  qualityApproval: {
    status: 'AI_APPROVED',
    reviewedItemCount: 400,
    pendingItemCount: 0,
    humanReviewClaimed: false
  },
  legalApproval: {
    approvalType: 'AI_PROJECT_RISK_APPROVAL_NOT_LEGAL_ADVICE',
    qualifiedLegalOpinionClaimed: false,
    commercialRedistributionPermissionEstablished: false
  },
  networkApproval: {
    approvalType: 'AI_PROJECT_RISK_ACCEPTANCE',
    osFirewallOrPacketCapturePerformed: false,
    zeroExternalTrafficClaimed: false,
    observedExternalConnectionCount: null
  },
  packageSizingApproval: {
    status: 'AI_APPROVED_MEASURED_SIZING',
    coreModelPack: {
      archiveSizeBytes: 75_969_829
    },
    limits: {
      corePackTargetBytes: 314_572_800
    }
  },
  decision: {
    m4Complete: true,
    gateAInputReady: true,
    gateADecisionStatus: 'AWAITING_EXPLICIT_USER_DECISION',
    integrationOrDistributionAuthorized: false,
    m5Authorized: false
  }
};
const m4Content = `${JSON.stringify(m4Completion, null, 2)}\n`;
const m4Sha256 = sha256Text(m4Content);
const decision = buildGateADecision({
  m4Completion,
  m4CompletionSha256: m4Sha256,
  decisionId: 'gate-a-decision-0123456789abcdef',
  decidedAt: '2026-07-26T16:30:00.000Z'
});

assert.equal(validateGateADecision(decision, {
  m4Completion,
  m4CompletionSha256: m4Sha256
}), true);
assert.equal(decision.status, 'GATE_A_CONFIRMED');
assert.equal(decision.authorization.m5Authorized, true);
assert.equal(
  decision.authorization.packagingOrDistributionAuthorized,
  false
);
const decisionContent = `${JSON.stringify(decision, null, 2)}\n`;
const [decisionSchema, crossBoundSchema] = await Promise.all([
  readFile(resolve(
    scriptRoot,
    'schemas',
    'gate-a-decision.schema.json'
  ), 'utf8').then(JSON.parse),
  readFile(resolve(
    scriptRoot,
    'schemas',
    'gate-a-cross-bound-evidence.schema.json'
  ), 'utf8').then(JSON.parse)
]);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
assert.equal(ajv.compile(decisionSchema)(decision), true);
assert.equal(ajv.compile(crossBoundSchema)(decision), true);
const gateResult = evaluateGateAInputCompleteness({
  artifacts: {
    m4AiCompletion: {
      content: m4Content,
      sha256: m4Sha256
    },
    gateADecision: {
      content: decisionContent,
      sha256: sha256Text(decisionContent)
    }
  }
});
assert.equal(gateResult.gateAStatus, 'GATE_A_CONFIRMED');
assert.equal(gateResult.decisionAuthority, 'USER');
assert.equal(gateResult.m5Authorized, true);
assert.equal(gateResult.integrationOrDistributionAuthorized, false);

for (const mutate of [
  (value) => {
    value.selection.directions = ['en-zh'];
  },
  (value) => {
    value.selection.storageRoute.customModelPath = 'CUSTOM';
  },
  (value) => {
    value.authorization.packagingOrDistributionAuthorized = true;
  },
  (value) => {
    value.m4Completion.artifactSha256 = '2'.repeat(64);
  }
]) {
  const tampered = structuredClone(decision);
  mutate(tampered);
  assert.throws(
    () => validateGateADecision(tampered, {
      m4Completion,
      m4CompletionSha256: m4Sha256
    }),
    /GATE_A_DECISION/u
  );
}

process.stdout.write(`${JSON.stringify({
  status: 'GATE_A_DECISION_SELF_TEST_PASS',
  userAuthorityRequired: true,
  bidirectionalRouteFrozen: true,
  defaultLocalAppDataFrozen: true,
  m5Authorized: true,
  packagingOrDistributionAuthorized: false,
  tamperCasesRejected: 4
}, null, 2)}\n`);

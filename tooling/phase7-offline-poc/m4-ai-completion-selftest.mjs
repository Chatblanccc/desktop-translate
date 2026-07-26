import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  validateM4AiCompletion
} from './m4-ai-completion.mjs';
import {
  canonicalJson,
  sha256Text
} from './lib.mjs';
import {
  evaluateGateAInputCompleteness
} from './gate-a-completeness.mjs';

const hex = (character) => character.repeat(64);
const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const primaryEvidence = {
  schemaVersion: 'phase7-m4-ai-primary-evidence-set-v1',
  coldPwsSha256: hex('1'),
  aiBlindReviewSha256: hex('2'),
  pocAuthorizationSha256: hex('3'),
  candidateGenerationSha256s: [hex('4'), hex('5')],
  candidateGenerationBindingSetSha256: hex('6'),
  legalPreparationSha256: hex('7'),
  packageSizingPreparationSha256: hex('8'),
  networkCollectorSha256: hex('9'),
  networkCollectorSelftestSha256: hex('a')
};
const fixture = {
  schemaVersion: 'phase7-m4-ai-completion-v1',
  status: 'M4_AI_APPROVED_COMPLETE_FOR_GATE_A_SUBMISSION',
  approvalId: 'm4-ai-approval-0123456789abcdef',
  approvedAt: '2026-07-26T16:00:00.000Z',
  scope: 'POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION',
  delegation: {
    basis: 'USER_DELEGATED_ALL_REMAINING_M4_AI_FILL_AND_APPROVAL',
    delegatedOn: '2026-07-26',
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
  candidateGenerationBindings: [{}, {}],
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
    status: 'AI_APPROVED_MEASURED_SIZING'
  },
  decision: {
    m4Complete: true,
    gateAInputReady: true,
    gateADecisionStatus: 'AWAITING_EXPLICIT_USER_DECISION',
    integrationOrDistributionAuthorized: false,
    m5Authorized: false
  },
  privacy: {}
};

assert.equal(validateM4AiCompletion(fixture), true);
const [schema, crossBoundSchema] = await Promise.all([
  readFile(resolve(
    scriptRoot,
    'schemas',
    'm4-ai-completion.schema.json'
  ), 'utf8').then(JSON.parse),
  readFile(resolve(
    scriptRoot,
    'schemas',
    'gate-a-cross-bound-evidence.schema.json'
  ), 'utf8').then(JSON.parse)
]);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
assert.equal(ajv.compile(schema)(fixture), true);
assert.equal(ajv.compile(crossBoundSchema)(fixture), true);
const fixtureContent = `${JSON.stringify(fixture, null, 2)}\n`;
const gateResult = evaluateGateAInputCompleteness({
  artifacts: {
    m4AiCompletion: {
      content: fixtureContent,
      sha256: sha256Text(fixtureContent)
    }
  }
});
assert.equal(gateResult.inputStatus, 'GATE_A_INPUT_READY');
assert.equal(gateResult.ready, true);
assert.equal(
  gateResult.gateDecisionStatus,
  'AWAITING_EXPLICIT_USER_DECISION'
);
assert.equal(gateResult.integrationOrDistributionAuthorized, false);

for (const mutate of [
  (value) => {
    value.assessor.qualifiedLawyerClaimed = true;
  },
  (value) => {
    value.networkApproval.zeroExternalTrafficClaimed = true;
  },
  (value) => {
    value.decision.m5Authorized = true;
  },
  (value) => {
    value.primaryEvidence.coldPwsSha256 = hex('b');
  }
]) {
  const tampered = structuredClone(fixture);
  mutate(tampered);
  assert.throws(
    () => validateM4AiCompletion(tampered),
    /M4_AI_/u
  );
}

process.stdout.write(`${JSON.stringify({
  status: 'M4_AI_COMPLETION_SELF_TEST_PASS',
  aiApprovalExplicit: true,
  qualifiedLegalOpinionClaimed: false,
  osCapturePerformed: false,
  zeroExternalTrafficClaimed: false,
  gateAUserDecisionRecorded: false,
  tamperCasesRejected: 4
}, null, 2)}\n`);

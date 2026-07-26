import {
  createHash,
  randomBytes
} from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';
import {
  basename,
  resolve
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deriveGateACandidateBindings
} from './gate-a-candidate-bindings.mjs';
import {
  POC_RESEARCH_SCOPE,
  canonicalJson,
  sha256Text
} from './lib.mjs';

export const M4_AI_COMPLETION_SCHEMA_VERSION =
  'phase7-m4-ai-completion-v1';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptRoot, '..', '..');
const gateArtifactRoot = resolve(
  repositoryRoot,
  'artifacts',
  'phase7',
  'offline-poc',
  'gate-a'
);
const shaPattern = /^[a-f0-9]{64}$/u;
const directions = Object.freeze(['en-zh', 'zh-en']);

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, code, details = {}) {
  if (!condition) {
    const error = new Error(code);
    error.code = code;
    error.details = details;
    throw error;
  }
}

async function readJsonArtifact(path, code) {
  const raw = await readFile(path);
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(code), { code });
  }
  return {
    document,
    sha256: sha256Bytes(raw),
    sizeBytes: raw.length
  };
}

export async function buildM4AiCompletion({
  coldPws,
  aiBlindReview,
  legalPreparation,
  packageSizingPreparation,
  authorizationPath,
  generationPaths,
  networkCollector,
  networkCollectorSelftest,
  approvalId,
  approvedAt
}) {
  assert(
    /^m4-ai-approval-[a-f0-9]{16}$/u.test(approvalId),
    'M4_AI_APPROVAL_ID_INVALID'
  );
  assert(!Number.isNaN(Date.parse(approvedAt)), 'M4_AI_APPROVED_AT_INVALID');
  const candidateBindings = await deriveGateACandidateBindings({
    authorizationPath,
    generationPaths
  });
  const authorization = await readJsonArtifact(
    authorizationPath,
    'M4_AI_AUTHORIZATION_INVALID'
  );
  const generationArtifacts = await Promise.all(directions.map(
    (direction) => readJsonArtifact(
      generationPaths[direction],
      `M4_AI_GENERATION_INVALID:${direction}`
    )
  ));
  assert(
    coldPws.document?.schemaVersion === 'phase7-offline-cold-pws-v3'
      && coldPws.document?.status
        === 'PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE'
      && coldPws.document?.totals?.requestedTrials === 40
      && coldPws.document?.totals?.successfulTrials === 40
      && coldPws.document?.totals?.failures === 0
      && coldPws.document?.totals?.forcedKillCount === 0
      && coldPws.document?.artifactIdentity
        ?.candidateGenerationBindingSetSha256
        === candidateBindings.bindingSetSha256,
    'M4_AI_COLD_PWS_EVIDENCE_INVALID'
  );
  assert(
    aiBlindReview.document?.schemaVersion
      === 'phase7-ai-blind-eval-report-v1'
      && aiBlindReview.document?.status
        === 'AI_BLIND_QUALITY_EVALUATION_COMPONENT_COMPLETE'
      && aiBlindReview.document?.aiOnly === true
      && aiBlindReview.document?.method?.humanReviewClaimed === false
      && aiBlindReview.document?.counts?.validAiReviewCount === 400
      && aiBlindReview.document?.counts?.pendingAiReviewCount === 0
      && aiBlindReview.document?.audit
        ?.candidateGenerationBindingSetSha256
        === candidateBindings.bindingSetSha256,
    'M4_AI_QUALITY_EVIDENCE_INVALID'
  );
  assert(
    legalPreparation.document?.schemaVersion
      === 'phase7-bergamot-legal-review-preparation-v1'
      && legalPreparation.document?.status
        === 'LEGAL_REVIEW_PREPARED_NOT_APPROVED'
      && legalPreparation.document?.candidateGenerationBindingSetSha256
        === candidateBindings.bindingSetSha256
      && legalPreparation.document?.integrationOrDistributionAuthorized
        === false,
    'M4_AI_LEGAL_PREPARATION_INVALID'
  );
  const sizing = packageSizingPreparation.document;
  assert(
    sizing?.schemaVersion
      === 'phase7-bergamot-core-pack-sizing-preparation-v1'
      && sizing?.status
        === 'PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET'
      && sizing?.candidateGenerationBindingSetSha256
        === candidateBindings.bindingSetSha256
      && sizing?.baseInstaller?.containsModel === false
      && sizing?.baseInstaller?.sizeBytes > 0
      && sizing.baseInstaller.sizeBytes
        <= sizing?.limits?.baseInstallerMaximumBytes
      && sizing?.coreModelPack?.archiveSizeBytes > 0
      && sizing.coreModelPack.archiveSizeBytes
        <= sizing?.limits?.corePackHardMaximumBytes
      && sizing?.coreModelPack?.installedSizeBytes
        >= sizing.coreModelPack.archiveSizeBytes
      && sizing?.integrationOrDistributionAuthorized === false,
    'M4_AI_PACKAGE_SIZING_INVALID'
  );
  assert(
    networkCollector.sizeBytes > 0
      && networkCollectorSelftest.sizeBytes > 0
      && coldPws.document?.externalNetworkVerification
        === 'NOT_VERIFIED_BY_OS_FIREWALL_OR_PACKET_CAPTURE',
    'M4_AI_NETWORK_BASIS_INVALID'
  );

  const primaryEvidence = {
    schemaVersion: 'phase7-m4-ai-primary-evidence-set-v1',
    coldPwsSha256: coldPws.sha256,
    aiBlindReviewSha256: aiBlindReview.sha256,
    pocAuthorizationSha256: authorization.sha256,
    candidateGenerationSha256s:
      generationArtifacts.map((artifact) => artifact.sha256).sort(),
    candidateGenerationBindingSetSha256:
      candidateBindings.bindingSetSha256,
    legalPreparationSha256: legalPreparation.sha256,
    packageSizingPreparationSha256: packageSizingPreparation.sha256,
    networkCollectorSha256: networkCollector.sha256,
    networkCollectorSelftestSha256: networkCollectorSelftest.sha256
  };
  const primaryEvidenceSetSha256 =
    sha256Text(canonicalJson(primaryEvidence));
  const report = {
    schemaVersion: M4_AI_COMPLETION_SCHEMA_VERSION,
    status: 'M4_AI_APPROVED_COMPLETE_FOR_GATE_A_SUBMISSION',
    approvalId,
    approvedAt,
    scope: POC_RESEARCH_SCOPE,
    delegation: {
      basis:
        'USER_DELEGATED_ALL_REMAINING_M4_AI_FILL_AND_APPROVAL',
      delegatedOn: '2026-07-26',
      aiWorkMustBeExplicitlyLabelled: true,
      gateADecisionDelegated: false
    },
    assessor: {
      assessorType: 'AI_LANGUAGE_MODEL',
      provider: 'OPENAI',
      surface: 'CODEX',
      modelIdentifier: 'OPENAI_CODEX_GPT-5_SESSION_MODEL',
      humanReviewerClaimed: false,
      qualifiedLawyerClaimed: false,
      cleanVmOperatorClaimed: false
    },
    primaryEvidence,
    primaryEvidenceSetSha256,
    candidateGenerationBindings:
      structuredClone(candidateBindings.bindings),
    qualityApproval: {
      status: 'AI_APPROVED',
      method: 'AI_MODEL_BLIND_REVIEW',
      reviewedItemCount: 400,
      pendingItemCount: 0,
      humanReviewClaimed: false,
      evidenceSha256: aiBlindReview.sha256
    },
    legalApproval: {
      status:
        'AI_APPROVED_FOR_GATE_A_ROUTE_SELECTION_WITH_DISCLOSED_RISKS',
      approvalType: 'AI_PROJECT_RISK_APPROVAL_NOT_LEGAL_ADVICE',
      qualifiedLegalOpinionClaimed: false,
      commercialRedistributionPermissionEstablished: false,
      integrationOrDistributionAuthorized: false,
      acceptedOpenRisks: [
        'MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED',
        'MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED',
        'NPM_TARBALL_LICENSE_FILE_MISSING',
        'ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK'
      ],
      evidenceSha256: legalPreparation.sha256
    },
    networkApproval: {
      status:
        'AI_APPROVED_WITH_OS_CAPTURE_REQUIREMENT_WAIVED_FOR_M4',
      approvalType: 'AI_PROJECT_RISK_ACCEPTANCE',
      processAndArchitectureEvidenceAccepted: true,
      osFirewallOrPacketCapturePerformed: false,
      zeroExternalTrafficClaimed: false,
      observedExternalConnectionCount: null,
      limitation:
        'No administrator clean-VM OS capture was performed. AI accepts this evidence gap for M4/Gate A route selection only.',
      collectorSha256: networkCollector.sha256,
      collectorSelftestSha256: networkCollectorSelftest.sha256
    },
    packageSizingApproval: {
      status: 'AI_APPROVED_MEASURED_SIZING',
      baseInstaller: {
        sha256: sizing.baseInstaller.sha256,
        sizeBytes: sizing.baseInstaller.sizeBytes,
        containsModel: false
      },
      coreModelPack: {
        sha256: sizing.coreModelPack.sha256,
        archiveSizeBytes: sizing.coreModelPack.archiveSizeBytes,
        installedSizeBytes: sizing.coreModelPack.installedSizeBytes
      },
      limits: structuredClone(sizing.limits),
      evidenceSha256: packageSizingPreparation.sha256
    },
    decision: {
      m4Complete: true,
      gateAInputReady: true,
      gateADecisionStatus: 'AWAITING_EXPLICIT_USER_DECISION',
      integrationOrDistributionAuthorized: false,
      m5Authorized: false
    },
    privacy: {
      sourceTextIncluded: false,
      translationTextIncluded: false,
      absolutePathsIncluded: false,
      usernamesIncluded: false
    }
  };
  validateM4AiCompletion(report);
  return {
    report,
    reportContent: `${JSON.stringify(report, null, 2)}\n`
  };
}

export function validateM4AiCompletion(report) {
  assert(
    report?.schemaVersion === M4_AI_COMPLETION_SCHEMA_VERSION
      && report?.status
        === 'M4_AI_APPROVED_COMPLETE_FOR_GATE_A_SUBMISSION'
      && report?.scope === POC_RESEARCH_SCOPE
      && report?.delegation?.basis
        === 'USER_DELEGATED_ALL_REMAINING_M4_AI_FILL_AND_APPROVAL'
      && report?.delegation?.aiWorkMustBeExplicitlyLabelled === true
      && report?.delegation?.gateADecisionDelegated === false
      && report?.assessor?.assessorType === 'AI_LANGUAGE_MODEL'
      && report?.assessor?.humanReviewerClaimed === false
      && report?.assessor?.qualifiedLawyerClaimed === false
      && report?.assessor?.cleanVmOperatorClaimed === false
      && shaPattern.test(report?.primaryEvidenceSetSha256 ?? '')
      && report?.qualityApproval?.status === 'AI_APPROVED'
      && report?.qualityApproval?.reviewedItemCount === 400
      && report?.qualityApproval?.pendingItemCount === 0
      && report?.qualityApproval?.humanReviewClaimed === false
      && report?.legalApproval?.approvalType
        === 'AI_PROJECT_RISK_APPROVAL_NOT_LEGAL_ADVICE'
      && report?.legalApproval?.qualifiedLegalOpinionClaimed === false
      && report?.legalApproval
        ?.commercialRedistributionPermissionEstablished === false
      && report?.networkApproval?.approvalType
        === 'AI_PROJECT_RISK_ACCEPTANCE'
      && report?.networkApproval?.osFirewallOrPacketCapturePerformed
        === false
      && report?.networkApproval?.zeroExternalTrafficClaimed === false
      && report?.networkApproval?.observedExternalConnectionCount === null
      && report?.packageSizingApproval?.status
        === 'AI_APPROVED_MEASURED_SIZING'
      && report?.decision?.m4Complete === true
      && report?.decision?.gateAInputReady === true
      && report?.decision?.gateADecisionStatus
        === 'AWAITING_EXPLICIT_USER_DECISION'
      && report?.decision?.integrationOrDistributionAuthorized === false
      && report?.decision?.m5Authorized === false,
    'M4_AI_COMPLETION_INVALID'
  );
  assert(
    report.primaryEvidenceSetSha256
      === sha256Text(canonicalJson(report.primaryEvidence)),
    'M4_AI_PRIMARY_EVIDENCE_SET_HASH_MISMATCH'
  );
  return true;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [
    coldPws,
    aiBlindReview,
    legalPreparation,
    packageSizingPreparation,
    networkCollectorRaw,
    networkCollectorSelftestRaw
  ] = await Promise.all([
    readJsonArtifact(resolve(required(options, 'cold-pws')),
      'M4_AI_COLD_PWS_JSON_INVALID'),
    readJsonArtifact(resolve(required(options, 'ai-blind-review')),
      'M4_AI_REVIEW_JSON_INVALID'),
    readJsonArtifact(resolve(required(options, 'legal-preparation')),
      'M4_AI_LEGAL_JSON_INVALID'),
    readJsonArtifact(resolve(required(options, 'package-sizing-preparation')),
      'M4_AI_SIZING_JSON_INVALID'),
    readFile(resolve(required(options, 'network-collector'))),
    readFile(resolve(required(options, 'network-collector-selftest')))
  ]);
  const networkCollector = {
    sha256: sha256Bytes(networkCollectorRaw),
    sizeBytes: networkCollectorRaw.length
  };
  const networkCollectorSelftest = {
    sha256: sha256Bytes(networkCollectorSelftestRaw),
    sizeBytes: networkCollectorSelftestRaw.length
  };
  const authorizationPath = resolve(required(options, 'authorization'));
  const generationPaths = {
    'en-zh': resolve(required(options, 'generation-en-zh')),
    'zh-en': resolve(required(options, 'generation-zh-en'))
  };
  const approvalId = `m4-ai-approval-${randomBytes(8).toString('hex')}`;
  const { report, reportContent } = await buildM4AiCompletion({
    coldPws,
    aiBlindReview,
    legalPreparation,
    packageSizingPreparation,
    authorizationPath,
    generationPaths,
    networkCollector,
    networkCollectorSelftest,
    approvalId,
    approvedAt: new Date().toISOString()
  });
  await mkdir(gateArtifactRoot, { recursive: true });
  const outputPath = resolve(
    gateArtifactRoot,
    `${approvalId}.json`
  );
  await writeFile(outputPath, reportContent, {
    encoding: 'utf8',
    flag: 'wx'
  });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    approvalType: 'AI_M4_COMPLETION',
    m4Complete: report.decision.m4Complete,
    gateAInputReady: report.decision.gateAInputReady,
    gateADecisionStatus: report.decision.gateADecisionStatus,
    osCapturePerformed:
      report.networkApproval.osFirewallOrPacketCapturePerformed,
    zeroExternalTrafficClaimed:
      report.networkApproval.zeroExternalTrafficClaimed,
    integrationOrDistributionAuthorized:
      report.decision.integrationOrDistributionAuthorized,
    primaryEvidenceSetSha256: report.primaryEvidenceSetSha256,
    reportSha256: sha256Text(reportContent),
    logicalName: basename(outputPath)
  }, null, 2)}\n`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index]?.startsWith('--'), 'M4_AI_CLI_OPTION_INVALID');
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function required(options, key) {
  assert(
    typeof options[key] === 'string' && options[key].length > 0,
    `M4_AI_CLI_OPTION_REQUIRED:${key}`
  );
  return options[key];
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'FAILED',
      code: error?.code ?? error?.message ?? 'M4_AI_COMPLETION_FAILED',
      details: error?.details ?? {}
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
